import { awaitAbortable } from '@bitcaster-market/client-sdk/engineClient'
import { serializeDurableWalletReceiveOperation } from '@bitcaster-market/client-sdk/durableWalletOperation'
import assert from 'node:assert/strict'
import test from 'node:test'
import { hashToCurve, getEncodedToken } from '@cashu/cashu-ts'
import { createWallet, prepareRegularWalletReceive } from '../src/walletOps.ts'
import { DaemonDurableWalletReceiveCoordinator } from '../src/durableWalletReceiveCoordinator.ts'
import { reserveDaemonKeysetCounter } from '../src/state.ts'
import { withDaemonStateSqliteTransaction } from '../src/stateSqlite.ts'
import {
  serviceFixture,
  PROOFS,
  MINT,
  SEED,
  message,
} from './nativePaymentRequestServiceFixture.ts'

async function rows(directory: string) {
  return withDaemonStateSqliteTransaction(directory, (db) => ({
    counters: db
      .prepare('SELECT next_counter FROM target_keyset_counters')
      .all()
      .map((row) => Number(row.next_counter)),
    operations: Number(db.prepare('SELECT count(*) n FROM custody_operations').get()!.n),
    receipts: Number(db.prepare('SELECT count(*) n FROM native_payment_request_receipts').get()!.n),
  }))
}

async function draft(f: Awaited<ReturnType<typeof serviceFixture>>) {
  return prepareRegularWalletReceive({
    encodedToken: getEncodedToken({ mint: MINT, unit: 'msat', proofs: PROOFS }),
    mintUrl: MINT,
    unit: 'msat',
    secrets: { walletSeedHex: SEED },
    deps: f.deps,
  })
}

for (const initial of [0, 7])
  test(`default wallet drafts auto-counter range ${initial} without durable writes`, async () => {
    const f = await serviceFixture({ defaultWallet: true })
    try {
      if (initial)
        await reserveDaemonKeysetCounter(
          PROOFS[0]!.id,
          initial,
          { fence: f.fence, observedAtMs: Date.now() },
          { normalizedMint: MINT, unit: 'msat' },
        )
      const before = await rows(f.directory)
      const prepared = await draft(f)
      assert.equal(prepared.prepared.operation.derivationRange!.counterStart, initial)
      assert.deepEqual(await rows(f.directory), before)
      assert.equal(f.counts.swaps, 0)
      const complete = prepared.wallet.completeSwap!.bind(prepared.wallet)
      prepared.wallet.completeSwap = async (preview) => {
        const committed = await rows(f.directory)
        assert.equal(committed.operations, 1)
        assert.equal(
          committed.counters[0],
          initial + prepared.prepared.operation.derivationRange!.counterCount,
        )
        return complete(preview)
      }
      await new DaemonDurableWalletReceiveCoordinator(
        f.directory,
        () => f.fence,
        f.deps.restoreOutputGroups!,
      ).execute(prepared)
      assert.equal(f.counts.swaps, 1)
    } finally {
      await f.close()
    }
  })

test('default receive rolls counter and journal back before COMMIT, but reconciles a lost COMMIT reply', async () => {
  for (const fault of ['before-commit', 'after-commit'] as const) {
    const f = await serviceFixture({ defaultWallet: true })
    try {
      const prepared = await draft(f)
      let injected = false
      const coordinator = new DaemonDurableWalletReceiveCoordinator(
        f.directory,
        () => f.fence,
        f.deps.restoreOutputGroups!,
        Date.now,
        (phase) => {
          if (!injected && phase === fault) {
            injected = true
            throw new Error('controlled commit reply failure')
          }
        },
      )
      if (fault === 'before-commit') {
        await assert.rejects(coordinator.execute(prepared), /controlled commit reply failure/)
        assert.deepEqual(await rows(f.directory), { counters: [], operations: 0, receipts: 0 })
        assert.equal(f.counts.swaps, 0)
      } else {
        await coordinator.execute(prepared)
        assert.equal((await rows(f.directory)).operations, 1)
        assert.equal(f.counts.swaps, 1)
      }
    } finally {
      await f.close()
    }
  }
})

test('default receive CAS conflict rebuilds without committing the discarded range', async () => {
  const f = await serviceFixture({ defaultWallet: true })
  try {
    const prepared = await draft(f)
    await reserveDaemonKeysetCounter(
      PROOFS[0]!.id,
      1,
      { fence: f.fence, observedAtMs: Date.now() },
      { normalizedMint: MINT, unit: 'msat' },
    )
    const rebuilt = prepared.prepared.rebuild!
    let attempts = 0
    const rebuild = async () => {
      attempts++
      const next = await rebuilt()
      assert.equal(next.prepared.operation.operationId, prepared.prepared.operation.operationId)
      assert.equal(next.prepared.operation.derivationRange!.counterStart, 1)
      return next
    }
    await new DaemonDurableWalletReceiveCoordinator(
      f.directory,
      () => f.fence,
      f.deps.restoreOutputGroups!,
    ).execute({ ...prepared, prepared: { ...prepared.prepared, rebuild } })
    assert.equal(attempts, 1)
    assert.equal((await rows(f.directory)).operations, 1)
    assert.equal(f.counts.swaps, 1)
  } finally {
    await f.close()
  }
})

test('default wallet native receipt retry uses saved operation without another counter allocation', async () => {
  const f = await serviceFixture({ defaultWallet: true })
  try {
    await f.ops.create({ requestId: 'request', nprofile: f.nprofile })
    await f.ops.receive(message())
    const before = await rows(f.directory)
    assert.equal(before.receipts, 1)
    await f.createOps().receive(message(true))
    assert.deepEqual(await rows(f.directory), before)
    assert.equal(f.counts.swaps, 1)
  } finally {
    await f.close()
  }
})

test('duplicate receipt chooses saved bytes before stale CAS and prepares saved historical keysets', async () => {
  const f = await serviceFixture({ defaultWallet: true })
  try {
    await f.ops.create({ requestId: 'request', nprofile: f.nprofile })
    const first = await draft(f)
    f.control.alternateKeyset = true
    const loser = await draft(f)
    assert.notEqual(
      first.prepared.operation.derivationRange!.keysetId,
      loser.prepared.operation.derivationRange!.keysetId,
    )
    const { paymentRequestReceiptBinding } =
      await import('../src/nativePaymentRequestReceiptSqlite.ts')
    const receipt = paymentRequestReceiptBinding({
      scopeId: f.fence.scopeId,
      requestId: 'request',
      mintUrl: MINT,
      proofs: PROOFS,
    })
    const coordinator = new DaemonDurableWalletReceiveCoordinator(
      f.directory,
      () => f.fence,
      f.deps.restoreOutputGroups!,
    )
    await coordinator.execute({ ...first, receipt })
    const before = await rows(f.directory)
    let checked = false
    const ensure = loser.wallet.ensureOperableKeysets!.bind(loser.wallet)
    loser.wallet.ensureOperableKeysets = async (ids) => {
      checked = true
      assert.ok(ids.includes(first.prepared.operation.derivationRange!.keysetId))
      await ensure(ids)
    }
    loser.wallet.completeSwap = async () => {
      throw new Error('discarded draft must never execute')
    }
    const result = await coordinator.execute({ ...loser, receipt })
    assert.equal(result.operationId, first.prepared.operation.operationId)
    assert.equal(checked, true)
    assert.deepEqual(await rows(f.directory), before)
    assert.equal(f.counts.swaps, 1)
  } finally {
    await f.close()
  }
})

test('conflicting receipt identity refuses without committing its speculative counter', async () => {
  const f = await serviceFixture({ defaultWallet: true })
  try {
    await f.ops.create({ requestId: 'request', nprofile: f.nprofile })
    await f.ops.receive(message())
    const prepared = await draft(f)
    const before = await rows(f.directory)
    const { paymentRequestReceiptBinding } =
      await import('../src/nativePaymentRequestReceiptSqlite.ts')
    const receipt = paymentRequestReceiptBinding({
      scopeId: f.fence.scopeId,
      requestId: 'request',
      mintUrl: MINT,
      proofs: [PROOFS[0]!],
    })
    await assert.rejects(
      new DaemonDurableWalletReceiveCoordinator(
        f.directory,
        () => f.fence,
        f.deps.restoreOutputGroups!,
      ).execute({ ...prepared, receipt }),
    )
    assert.deepEqual(await rows(f.directory), before)
    assert.equal(f.counts.swaps, 1)
  } finally {
    await f.close()
  }
})

test('three competing counter commits exhaust bounded preparation retries without a receive journal', async () => {
  const f = await serviceFixture({ defaultWallet: true })
  try {
    let attempts = 0
    const conflictingDraft = async (): ReturnType<typeof draft> => {
      const prepared = await draft(f)
      attempts++
      await reserveDaemonKeysetCounter(
        PROOFS[0]!.id,
        1,
        { fence: f.fence, observedAtMs: Date.now() },
        { normalizedMint: MINT, unit: 'msat' },
      )
      return { ...prepared, prepared: { ...prepared.prepared, rebuild: conflictingDraft } }
    }
    await assert.rejects(
      new DaemonDurableWalletReceiveCoordinator(
        f.directory,
        () => f.fence,
        f.deps.restoreOutputGroups!,
      ).execute(await conflictingDraft()),
      /counter snapshot changed/,
    )
    assert.equal(attempts, 3)
    assert.deepEqual(await rows(f.directory), { counters: [3], operations: 0, receipts: 0 })
    assert.equal(f.counts.swaps, 0)
  } finally {
    await f.close()
  }
})

test('failure before first mint execution retains the exact journal for recovery without allocation', async () => {
  const f = await serviceFixture({ defaultWallet: true })
  try {
    const prepared = await draft(f)
    const complete = prepared.wallet.completeSwap!.bind(prepared.wallet)
    prepared.wallet.completeSwap = async () => {
      throw new Error('controlled before mint')
    }
    const coordinator = new DaemonDurableWalletReceiveCoordinator(
      f.directory,
      () => f.fence,
      f.deps.restoreOutputGroups!,
    )
    await assert.rejects(coordinator.execute(prepared), /controlled before mint/)
    const committed = await rows(f.directory)
    assert.equal(committed.operations, 1)
    assert.equal(f.counts.swaps, 0)
    prepared.wallet.completeSwap = complete
    const recovered = await coordinator.recover({ walletFor: async () => prepared.wallet })
    assert.equal(recovered.recoveredCount, 1)
    assert.deepEqual(await rows(f.directory), committed)
    assert.equal(f.counts.swaps, 1)
  } finally {
    await f.close()
  }
})

for (const state of ['PENDING', 'UNSPENT'] as const)
  test(
    `overlapping ${state} receipt callers use one saved journal while the winner awaits its mint reply`,
    { timeout: 15000 },
    async () => {
      const f = await serviceFixture({ defaultWallet: true })
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let first: Promise<unknown> | undefined
      try {
        await f.ops.create({ requestId: 'request', nprofile: f.nprofile })
        const winner = await draft(f)
        f.control.alternateKeyset = true
        const loser = await draft(f)
        const { paymentRequestReceiptBinding } =
          await import('../src/nativePaymentRequestReceiptSqlite.ts')
        const receipt = paymentRequestReceiptBinding({
          scopeId: f.fence.scopeId,
          requestId: 'request',
          mintUrl: MINT,
          proofs: PROOFS,
        })
        const complete = winner.wallet.completeSwap!.bind(winner.wallet)
        winner.wallet.completeSwap = async (preview) => {
          started.resolve()
          await release.promise
          return complete(preview)
        }
        const coordinator = () =>
          new DaemonDurableWalletReceiveCoordinator(
            f.directory,
            () => f.fence,
            f.deps.restoreOutputGroups!,
          )
        first = coordinator().execute({ ...winner, receipt })
        await awaitAbortable(
          Promise.race([
            started.promise,
            first.then(() => {
              throw new Error('winner ended before barrier')
            }),
          ]),
          AbortSignal.timeout(5000),
        )
        const committed = await rows(f.directory)
        assert.equal(committed.operations, 1)
        assert.equal(committed.receipts, 1)
        assert.equal(committed.counters[0], winner.prepared.operation.derivationRange!.counterCount)
        let checked = 0
        loser.wallet.checkProofsStates = async (proofs) => {
          checked++
          assert.deepEqual(
            proofs.map((proof) => proof.secret),
            winner.prepared.operation.preview.inputs.map((proof) => proof.secret),
          )
          return proofs.map((proof) => ({
            Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
            state: state as import('@cashu/cashu-ts').CheckStateEnum,
          }))
        }
        const loserComplete = loser.wallet.completeSwap!.bind(loser.wallet)
        let savedSubmissions = 0
        loser.wallet.completeSwap = async (preview) => {
          assert.equal(state, 'UNSPENT')
          const operation = serializeDurableWalletReceiveOperation({
            operationId: winner.prepared.operation.operationId,
            mintUrl: MINT,
            unit: 'msat',
            preview,
            derivationRange: winner.prepared.operation.derivationRange!,
          })
          assert.deepEqual(operation, winner.prepared.operation)
          savedSubmissions++
          return loserComplete(preview)
        }
        if (state === 'PENDING')
          await assert.rejects(
            coordinator().execute({ ...loser, receipt }),
            /did not reach a terminal state/,
          )
        else
          assert.equal(
            (await coordinator().execute({ ...loser, receipt })).operationId,
            winner.prepared.operation.operationId,
          )
        assert.equal(savedSubmissions, state === 'PENDING' ? 0 : 1)
        assert.equal(checked, 1)
        assert.deepEqual(await rows(f.directory), committed)
        assert.equal(f.counts.swaps, state === 'PENDING' ? 0 : 1)
        release.resolve()
        await first
        assert.equal(f.counts.swaps, state === 'PENDING' ? 1 : 2)
        if (state === 'UNSPENT') assert.equal(f.swapRequests[0], f.swapRequests[1])
      } finally {
        release.resolve()
        if (first) await first.catch(() => undefined)
        await f.close()
      }
    },
  )

test('receipt exact-input failure after journal insertion rolls back journal and counter together', async () => {
  const f = await serviceFixture({ defaultWallet: true })
  try {
    await f.ops.create({ requestId: 'request', nprofile: f.nprofile })
    const prepared = await draft(f)
    const { paymentRequestReceiptBinding } =
      await import('../src/nativePaymentRequestReceiptSqlite.ts')
    const receipt = paymentRequestReceiptBinding({
      scopeId: f.fence.scopeId,
      requestId: 'request',
      mintUrl: MINT,
      proofs: [PROOFS[0]!],
    })
    await assert.rejects(
      new DaemonDurableWalletReceiveCoordinator(
        f.directory,
        () => f.fence,
        f.deps.restoreOutputGroups!,
      ).execute({ ...prepared, receipt }),
      /receive input is foreign/,
    )
    assert.deepEqual(await rows(f.directory), { counters: [], operations: 0, receipts: 0 })
    assert.equal(f.counts.swaps, 0)
  } finally {
    await f.close()
  }
})

for (const fault of ['duplicate-callback', 'wrong-range', 'extra-allocation'] as const)
  test(`receive draft refuses ${fault} without durable counter writes`, async () => {
    const f = await serviceFixture({ defaultWallet: true })
    try {
      const original = { ...f.deps }
      f.deps.createCashuWallet = (mint, unit, source) => {
        const wallet = createWallet(
          mint,
          { walletSeedHex: SEED },
          original,
          'sat',
          unit,
          undefined,
          source,
        )
        const prepare = wallet.prepareSwapToReceive!.bind(wallet)
        wallet.prepareSwapToReceive = async (token, config, output) => {
          let used: import('@cashu/cashu-ts').OperationCounters | undefined
          const preview = await prepare(
            token,
            {
              ...config,
              onCountersReserved: (range) => {
                used = range
                config?.onCountersReserved?.(
                  fault === 'wrong-range' ? { ...range, start: range.start + 1 } : range,
                )
              },
            },
            output,
          )
          assert.ok(used)
          if (fault === 'duplicate-callback') config?.onCountersReserved?.(used)
          if (fault === 'extra-allocation') await source!.reserve(used.keysetId, 1)
          return preview
        }
        return wallet
      }
      await assert.rejects(draft(f), /did not reserve a deterministic output range/)
      assert.deepEqual(await rows(f.directory), { counters: [], operations: 0, receipts: 0 })
      assert.equal(f.counts.swaps, 0)
    } finally {
      await f.close()
    }
  })

test('default native receipt lost COMMIT reply retains one operation and exact retry identity', async () => {
  const f = await serviceFixture({ defaultWallet: true })
  try {
    await f.ops.create({ requestId: 'request', nprofile: f.nprofile })
    let fired = false
    f.deps.injectCustodyFault = (phase) => {
      if (!fired && phase === 'after-commit') {
        fired = true
        throw new Error('controlled lost receipt COMMIT reply')
      }
    }
    await f.createOps().receive(message())
    assert.equal(fired, true)
    const before = await rows(f.directory)
    const saved = await withDaemonStateSqliteTransaction(f.directory, (db) =>
      db
        .prepare(
          'SELECT regular_operation_id, source_fingerprint FROM native_payment_request_receipts',
        )
        .get(),
    )
    assert.equal(before.operations, 1)
    assert.equal(before.receipts, 1)
    await f.createOps().receive(message(true))
    assert.deepEqual(await rows(f.directory), before)
    assert.deepEqual(
      await withDaemonStateSqliteTransaction(f.directory, (db) =>
        db
          .prepare(
            'SELECT regular_operation_id, source_fingerprint FROM native_payment_request_receipts',
          )
          .get(),
      ),
      saved,
    )
    assert.equal(f.counts.swaps, 1)
  } finally {
    await f.close()
  }
})
