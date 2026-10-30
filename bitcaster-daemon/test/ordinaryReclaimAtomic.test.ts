import assert from 'node:assert/strict'
import test from 'node:test'
import { createWallet, reclaimDurableOutgoingCashuTransfer } from '../src/walletOps.ts'
import { DaemonDurableOutgoingCashuCoordinator } from '../src/durableOutgoingCashuCoordinator.ts'
import { withDaemonStateSqliteTransaction } from '../src/stateSqlite.ts'
import { serviceFixture, message, SEED, MINT } from './nativePaymentRequestServiceFixture.ts'

async function fixture() {
  const f = await serviceFixture({ defaultWallet: true })
  try {
    await f.ops.create({ requestId: 'request', nprofile: f.nprofile })
    await f.ops.receive(message())
    const wallet = createWallet(MINT, { walletSeedHex: SEED }, f.deps, 'sat', 'msat')
    await wallet.loadMint()
    const coordinator = new DaemonDurableOutgoingCashuCoordinator(
      f.directory,
      () => f.fence,
      f.deps,
    )
    const transfer = await coordinator.execute({
      transferId: 'reclaim-transfer',
      amountMsat: 2,
      mintUrl: MINT,
      seed: Buffer.from(SEED, 'hex'),
      createWallet: (source) =>
        createWallet(MINT, { walletSeedHex: SEED }, f.deps, 'sat', 'msat', undefined, source),
      wallet,
    })
    assert.equal(transfer.deliveryState, 'delivery-pending')
    return {
      ...f,
      coordinator,
      transfer,
      reclaim: () =>
        reclaimDurableOutgoingCashuTransfer(transfer.transferId, { walletSeedHex: SEED }, f.deps),
    }
  } catch (error) {
    await f.close()
    throw error
  }
}
async function rows(directory: string) {
  return withDaemonStateSqliteTransaction(directory, (db) => ({
    counters: db
      .prepare('SELECT keyset_id, next_counter FROM target_keyset_counters ORDER BY keyset_id')
      .all(),
    operations: Number(db.prepare('SELECT count(*) n FROM custody_operations').get()!.n),
  }))
}

test('default wallet public reclaim commits counters journal and exact transfer before mint', async () => {
  const f = await fixture()
  try {
    const before = await rows(f.directory)
    let observed = false
    f.control.beforeSwap = async () => {
      const transfer = await f.coordinator.loadTransfer(f.transfer.transferId)
      assert.equal(transfer?.deliveryState, 'reclaim-prepared')
      const committed = await rows(f.directory)
      assert.equal(committed.operations, before.operations + 1)
      assert.notDeepEqual(committed.counters, before.counters)
      observed = true
    }
    await f.reclaim()
    assert.equal(observed, true)
    assert.equal(
      (await f.coordinator.loadTransfer(f.transfer.transferId))?.deliveryState,
      'reclaimed',
    )
    const after = await rows(f.directory)
    const swaps = f.counts.swaps
    const checks = f.proofStateRequests.length
    await f.reclaim()
    assert.equal(f.proofStateRequests.length, checks)
    assert.deepEqual(await rows(f.directory), after)
    assert.equal(f.counts.swaps, swaps)
  } finally {
    await f.close()
  }
})

for (const phase of ['counter-written', 'journal-bound'] as const)
  test(`default reclaim ${phase} fault rolls counter journal and transfer back`, async () => {
    const f = await fixture()
    try {
      const before = await rows(f.directory)
      const swaps = f.counts.swaps
      f.deps.injectReclaimFault = (observed) => {
        if (observed === phase) throw new Error('controlled reclaim boundary failure')
      }
      await assert.rejects(f.reclaim(), /controlled reclaim boundary failure/)
      assert.deepEqual(await rows(f.directory), before)
      assert.equal((await f.coordinator.loadTransfer(f.transfer.transferId))?.reclaim, null)
      assert.equal(f.counts.swaps, swaps)
      delete f.deps.injectReclaimFault
      await f.reclaim()
      assert.equal(
        (await f.coordinator.loadTransfer(f.transfer.transferId))?.deliveryState,
        'reclaimed',
      )
    } finally {
      await f.close()
    }
  })

test('default reclaim lost bind COMMIT reply reuses the saved operation', async () => {
  const f = await fixture()
  try {
    let fired = false
    f.deps.injectCustodyFault = (phase) => {
      if (!fired && phase === 'after-commit') {
        fired = true
        throw new Error('controlled lost reclaim reply')
      }
    }
    await f.reclaim()
    assert.equal(fired, true)
    const saved = await f.coordinator.loadTransfer(f.transfer.transferId)
    assert.equal(saved?.deliveryState, 'reclaimed')
    const after = await rows(f.directory)
    await f.reclaim()
    assert.deepEqual(await rows(f.directory), after)
    assert.equal(
      (await f.coordinator.loadTransfer(f.transfer.transferId))?.reclaim?.reclaimId,
      saved?.reclaim?.reclaimId,
    )
  } finally {
    await f.close()
  }
})

async function preparation(
  f: Awaited<ReturnType<typeof fixture>>,
  token: string,
  operationId: string,
) {
  const { prepareSpeculativeWalletReceive } =
    await import('../src/speculativeWalletReceivePreparation.ts')
  return prepareSpeculativeWalletReceive({
    encodedToken: token,
    operationId,
    mintUrl: MINT,
    unit: 'msat',
    directory: f.directory,
    getFence: () => f.fence,
    createWallet: (source) =>
      createWallet(MINT, { walletSeedHex: SEED }, f.deps, 'sat', 'msat', undefined, source),
  })
}
async function classificationWallet(f: Awaited<ReturnType<typeof fixture>>) {
  const wallet = createWallet(MINT, { walletSeedHex: SEED }, f.deps, 'sat', 'msat')
  await wallet.loadMint()
  return wallet
}

test('default reclaim counter CAS conflict reclassifies and retains one reclaim ID', async () => {
  const f = await fixture()
  try {
    const wallet = await classificationWallet(f)
    const { reserveDaemonKeysetCounter } = await import('../src/state.ts')
    let attempts = 0
    let id: string | undefined
    const checks = f.proofStateRequests.length
    await f.coordinator.reclaim({
      transferId: f.transfer.transferId,
      wallet,
      prepareReceive: async (token, operationId) => {
        id ??= operationId
        assert.equal(operationId, id)
        const beforeDraft = await rows(f.directory)
        const result = await preparation(f, token, operationId)
        assert.deepEqual(await rows(f.directory), beforeDraft)
        if (attempts++ === 0)
          await reserveDaemonKeysetCounter(
            result.prepared.operation.derivationRange!.keysetId,
            1,
            { fence: f.fence, observedAtMs: Date.now() },
            { normalizedMint: MINT, unit: 'msat' },
          )
        return result
      },
    })
    assert.equal(attempts, 2)
    assert.equal((await f.coordinator.loadTransfer(f.transfer.transferId))?.reclaim?.reclaimId, id)
    assert.ok(f.proofStateRequests.length >= checks + 3)
  } finally {
    await f.close()
  }
})

test('a changed classified snapshot refuses its draft before counters or journal move', async () => {
  const f = await fixture()
  try {
    const before = await rows(f.directory)
    const wallet = await classificationWallet(f)
    await assert.rejects(
      f.coordinator.reclaim({
        transferId: f.transfer.transferId,
        wallet,
        prepareReceive: async (token, id) => {
          const result = await preparation(f, token, id)
          await f.coordinator.classifyBearerTransfer({ transferId: f.transfer.transferId, wallet })
          return result
        },
      }),
      /transfer authority conflicts/,
    )
    assert.deepEqual(await rows(f.directory), before)
    assert.equal((await f.coordinator.loadTransfer(f.transfer.transferId))?.reclaim, null)
  } finally {
    await f.close()
  }
})

test('original send journal linkage corruption refuses before classification or counters', async () => {
  const f = await fixture()
  try {
    const before = await rows(f.directory)
    const checks = f.proofStateRequests.length
    await withDaemonStateSqliteTransaction(f.directory, (db) => {
      const foreign = db
        .prepare(
          "SELECT operation_id FROM custody_operations WHERE wallet_stage = 'receive' LIMIT 1",
        )
        .get()!.operation_id
      db.prepare(
        'UPDATE daemon_outgoing_cashu_transfers SET custody_operation_id = ? WHERE transfer_id = ?',
      ).run(foreign, f.transfer.transferId)
    })
    await assert.rejects(f.reclaim(), /original send journal conflicts/)
    assert.deepEqual(await rows(f.directory), before)
    assert.equal(f.proofStateRequests.length, checks)
  } finally {
    await f.close()
  }
})

for (const state of ['PENDING', 'UNSPENT'] as const)
  test(
    `overlapping default reclaim ${state} uses the saved winner after classified evolution`,
    { timeout: 20000 },
    async () => {
      const f = await fixture()
      const drafted = Promise.withResolvers<void>()
      const bindLoser = Promise.withResolvers<void>()
      const submitted = Promise.withResolvers<void>()
      const completeWinner = Promise.withResolvers<void>()
      let first: Promise<unknown> | undefined
      let second: Promise<unknown> | undefined
      try {
        const { awaitAbortable } = await import('@bitcaster-market/client-sdk/engineClient')
        let losingId: string | undefined
        first = f.coordinator.reclaim({
          transferId: f.transfer.transferId,
          wallet: await classificationWallet(f),
          prepareReceive: async (token, id) => {
            losingId = id
            const result = await preparation(f, token, id)
            drafted.resolve()
            await bindLoser.promise
            return result
          },
        })
        await awaitAbortable(
          Promise.race([
            drafted.promise,
            first.then(() => {
              throw new Error('loser ended before draft barrier')
            }),
          ]),
          AbortSignal.timeout(5000),
        )
        f.control.alternateKeyset = true
        let transports = 0
        f.control.beforeSwap = async () => {
          if (++transports === 1) {
            submitted.resolve()
            await completeWinner.promise
          }
        }
        const winner = new DaemonDurableOutgoingCashuCoordinator(f.directory, () => f.fence, f.deps)
        second = winner.reclaim({
          transferId: f.transfer.transferId,
          wallet: await classificationWallet(f),
          prepareReceive: (token, id) => preparation(f, token, id),
        })
        await awaitAbortable(
          Promise.race([
            submitted.promise,
            second.then(() => {
              throw new Error('winner ended before mint barrier')
            }),
          ]),
          AbortSignal.timeout(5000),
        )
        const saved = await winner.loadTransfer(f.transfer.transferId)
        assert.equal(saved?.deliveryState, 'reclaim-prepared')
        assert.notEqual(saved?.reclaim?.reclaimId, losingId)
        const bound = await rows(f.directory)
        const requests = f.swapRequests.length
        f.control.state = state as import('@cashu/cashu-ts').CheckStateEnum
        bindLoser.resolve()
        await first
        assert.deepEqual(await rows(f.directory), bound)
        assert.equal(f.swapRequests.length, requests + (state === 'UNSPENT' ? 1 : 0))
        completeWinner.resolve()
        await second
        assert.equal(
          (await winner.loadTransfer(f.transfer.transferId))?.reclaim?.reclaimId,
          saved?.reclaim?.reclaimId,
        )
        if (state === 'UNSPENT') assert.equal(f.swapRequests.at(-1), f.swapRequests.at(-2))
      } finally {
        bindLoser.resolve()
        completeWinner.resolve()
        await Promise.allSettled(
          [first, second].filter((task): task is Promise<unknown> => task !== undefined),
        )
        await f.close()
      }
    },
  )

test('fresh mint PENDING recheck retains one saved reclaim and retries without preparation', async () => {
  const f = await fixture()
  try {
    const wallet = await classificationWallet(f)
    const swaps = f.counts.swaps
    const pending = await f.coordinator.reclaim({
      transferId: f.transfer.transferId,
      wallet,
      prepareReceive: async (token, id) => {
        const result = await preparation(f, token, id)
        f.control.state = 'PENDING' as import('@cashu/cashu-ts').CheckStateEnum
        return result
      },
    })
    assert.equal(pending.deliveryState, 'reclaim-prepared')
    assert.equal(f.counts.swaps, swaps)
    const bound = await rows(f.directory)
    f.control.state = 'UNSPENT' as import('@cashu/cashu-ts').CheckStateEnum
    const complete = await f.coordinator.reclaim({
      transferId: f.transfer.transferId,
      wallet,
      prepareReceive: async () => {
        throw new Error('saved reclaim must not prepare')
      },
    })
    assert.equal(complete.deliveryState, 'reclaimed')
    assert.equal(complete.reclaim?.reclaimId, pending.reclaim?.reclaimId)
    assert.deepEqual(await rows(f.directory), bound)
    assert.equal(f.counts.swaps, swaps + 1)
  } finally {
    await f.close()
  }
})

test('all-spent default bearer reclaim and its terminal retry allocate no counters', async () => {
  const f = await fixture()
  try {
    const before = await rows(f.directory)
    const swaps = f.counts.swaps
    f.control.state = 'SPENT' as import('@cashu/cashu-ts').CheckStateEnum
    await f.reclaim()
    assert.equal(
      (await f.coordinator.loadTransfer(f.transfer.transferId))?.deliveryState,
      'bearer-spent',
    )
    const checks = f.proofStateRequests.length
    await f.reclaim()
    assert.equal(f.proofStateRequests.length, checks)
    assert.deepEqual(await rows(f.directory), before)
    assert.equal(f.counts.swaps, swaps)
  } finally {
    await f.close()
  }
})

test('automatic saved reclaim rejects corrupt original linkage before requesting a metadata wallet', async () => {
  const f = await fixture()
  try {
    const pending = await f.coordinator.reclaim({
      transferId: f.transfer.transferId,
      wallet: await classificationWallet(f),
      prepareReceive: async (token, id) => {
        const result = await preparation(f, token, id)
        f.control.state = 'PENDING' as import('@cashu/cashu-ts').CheckStateEnum
        return result
      },
    })
    assert.equal(pending.deliveryState, 'reclaim-prepared')
    await withDaemonStateSqliteTransaction(f.directory, (db) => {
      const foreign = db
        .prepare(
          "SELECT operation_id FROM custody_operations WHERE wallet_stage = 'receive' LIMIT 1",
        )
        .get()!.operation_id
      db.prepare(
        'UPDATE daemon_outgoing_cashu_transfers SET custody_operation_id = ? WHERE transfer_id = ?',
      ).run(foreign, f.transfer.transferId)
    })
    const counters = await rows(f.directory)
    const checks = f.proofStateRequests.length
    let wallets = 0
    await assert.rejects(
      f.coordinator.recoverDue({
        walletFor: async () => {
          wallets++
          throw new Error('metadata wallet must not be requested')
        },
      }),
      /custody operation is foreign|original send journal conflicts/,
    )
    assert.equal(wallets, 0)
    assert.equal(f.proofStateRequests.length, checks)
    assert.deepEqual(await rows(f.directory), counters)
  } finally {
    await f.close()
  }
})
