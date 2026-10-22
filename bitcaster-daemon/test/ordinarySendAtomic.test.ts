import { awaitAbortable } from '@bitcaster-market/client-sdk/engineClient'
import { CheckStateEnum } from '@cashu/cashu-ts'
import {
  decodeDurableRecipientDeliveryStatus,
  deriveDurableRecipientTupleFingerprint,
  type DurableRecipientDeliverySubmission,
} from '@bitcaster-market/client-sdk/durableRecipientDelivery'
import { createWallet } from '../src/walletOps.ts'
import { reserveDaemonKeysetCounter } from '../src/state.ts'
import { DaemonDurableOutgoingCashuCoordinator } from '../src/durableOutgoingCashuCoordinator.ts'
import { deliverMarketFundingCashu, deliverParticipationScoreCashu } from '../src/walletOps.ts'
import { prepareRegularWalletReceive } from '../src/walletOps.ts'
import { DaemonDurableWalletReceiveCoordinator } from '../src/durableWalletReceiveCoordinator.ts'
import { getEncodedToken } from '@cashu/cashu-ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { sendWalletToken } from '../src/walletOps.ts'
import { serviceFixture, SEED, MINT } from './nativePaymentRequestServiceFixture.ts'
import { withDaemonStateSqliteTransaction } from '../src/stateSqlite.ts'

async function funded(amount = 2) {
  const f = await serviceFixture({ defaultWallet: true, largeDenominations: true })
  try {
    await f.ops.create({ requestId: 'request', nprofile: f.nprofile })
    const prepared = await prepareRegularWalletReceive({
      encodedToken: getEncodedToken({
        mint: MINT,
        unit: 'msat',
        proofs: [f.mintProof(amount, 'send-funding')],
      }),
      mintUrl: MINT,
      unit: 'msat',
      secrets: { walletSeedHex: SEED },
      deps: f.deps,
    })
    await new DaemonDurableWalletReceiveCoordinator(
      f.directory,
      () => f.fence,
      f.deps.restoreOutputGroups!,
    ).execute(prepared)
    return {
      ...f,
      send: (id = 'send-atomic') =>
        sendWalletToken(
          1,
          {
            mintUrl: MINT,
            engineBaseUrl: 'https://engine.example',
            initializedAt: new Date().toISOString(),
          },
          { walletSeedHex: SEED },
          f.deps,
          MINT,
          id,
        ),
    }
  } catch (error) {
    await f.close()
    throw error
  }
}
async function rows(directory: string) {
  return withDaemonStateSqliteTransaction(directory, (db) => ({
    fundRows: Object.fromEntries(
      [
        'target_wallet_proofs',
        'target_keyset_counters',
        'target_proof_operations',
        'custody_proofs',
        'custody_keyset_counters',
        'custody_artifacts',
        'custody_operations',
        'custody_operation_inputs',
        'custody_proof_reservations',
        'custody_operation_artifact_links',
        'custody_verification_bindings',
        'custody_verification_keyset_uses',
        'custody_operation_pins',
        'custody_proof_lineage',
        'custody_selected_successors',
        'custody_successor_admissions',
        'custody_successor_admission_proofs',
        'custody_deliveries',
        'custody_active_work',
        'daemon_outgoing_cashu_transfers',
      ].map((table) => [
        table,
        db
          .prepare(`SELECT * FROM ${table}`)
          .all()
          .map((row) => JSON.stringify(row))
          .sort(),
      ]),
    ),
    counters: db
      .prepare('SELECT next_counter FROM target_keyset_counters')
      .all()
      .map((row) => Number(row.next_counter)),
    operations: Number(db.prepare('SELECT count(*) n FROM custody_operations').get()!.n),
    transfers: Number(
      db.prepare('SELECT count(*) n FROM daemon_outgoing_cashu_transfers').get()!.n,
    ),
    pointers: db.prepare('SELECT * FROM daemon_participation_score_delivery_pointers').all(),
  }))
}

test('actual default send commits counter inputs journal and transfer before mint and exact retry', async () => {
  const f = await funded()
  try {
    const before = await rows(f.directory)
    f.control.beforeSwap = async () => {
      const committed = await rows(f.directory)
      assert.equal(committed.operations, before.operations + 1)
      assert.equal(committed.transfers, 1)
      assert.equal(committed.counters[0], before.counters[0]! + 2)
    }
    const sent = await f.send()
    const committed = await rows(f.directory)
    const swaps = f.counts.swaps
    assert.deepEqual(await f.send(), sent)
    assert.deepEqual(await rows(f.directory), committed)
    assert.equal(f.counts.swaps, swaps)
  } finally {
    await f.close()
  }
})

for (const phase of [
  'counter-written',
  'inputs-reserved',
  'journal-bound',
  'transfer-bound',
] as const)
  test(`actual default send ${phase} failure rolls every fund fact back`, async () => {
    const f = await funded()
    try {
      const before = await rows(f.directory)
      const swaps = f.counts.swaps
      f.deps.injectSendFault = (observed) => {
        if (observed === phase) throw new Error('controlled send fault')
      }
      await assert.rejects(f.send(), /controlled send fault/)
      assert.deepEqual(await rows(f.directory), before)
      assert.equal(f.counts.swaps, swaps)
      delete f.deps.injectSendFault
      await f.send()
    } finally {
      await f.close()
    }
  })

// These cases use the public Score wrapper and the actual default wallet.
for (const epoch of [2, 3, 4])
  test(`Score pointer-only epoch ${epoch} read selection and failed atomic replacement preserve the old pointer`, async () => {
    const f = await funded(8192)
    try {
      const coordinator = new DaemonDurableOutgoingCashuCoordinator(
        f.directory,
        () => f.fence,
        f.deps,
      )
      const old = {
        transferId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        amountMsat: 1000,
        purchasedTotal: 3,
        accountSubject: 'subject-1',
        mintUrl: MINT,
      }
      await coordinator.preflightParticipationScoreDelivery(old)
      const before = await rows(f.directory)
      const request = {
        ...old,
        transferId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        purchasedTotal: epoch,
      }
      const selected = await coordinator.resolveParticipationScoreDelivery(request)
      assert.equal(selected.transferId, epoch > 3 ? request.transferId : old.transferId)
      assert.deepEqual(await rows(f.directory), before)
      f.deps.injectSendFault = (phase) => {
        if (phase === 'inputs-reserved') throw new Error('controlled Score rollback')
      }
      const swaps = f.counts.swaps
      await assert.rejects(
        deliverParticipationScoreCashu({
          deliveryId: request.transferId,
          accountSubject: old.accountSubject,
          amountMsat: 1000,
          purchasedTotalEpoch: epoch,
          profile: {
            mintUrl: MINT,
            engineBaseUrl: 'https://engine.example',
            initializedAt: new Date().toISOString(),
          },
          secrets: { walletSeedHex: SEED },
          deps: f.deps,
          client: {
            getDurableRecipientDeliveryStatus: async () => {
              throw new Error('recipient must not run')
            },
            submitDurableRecipientDelivery: async () => {
              throw new Error('recipient must not run')
            },
          },
        }),
        /controlled Score rollback/,
      )
      assert.deepEqual(await rows(f.directory), before)
      assert.equal(f.counts.swaps, swaps)
    } finally {
      await f.close()
    }
  })

for (const phase of [
  'counter-written',
  'inputs-reserved',
  'journal-bound',
  'transfer-bound',
] as const)
  test(`actual default funding ${phase} failure rolls back the head and all fund facts`, async () => {
    const f = await funded(8192)
    try {
      const before = await rows(f.directory)
      const heads = () =>
        withDaemonStateSqliteTransaction(f.directory, (db) =>
          db.prepare('SELECT * FROM daemon_market_funding_heads').all(),
        )
      const beforeHeads = await heads()
      const swaps = f.counts.swaps
      f.deps.injectSendFault = (observed) => {
        if (observed === phase) throw new Error('controlled funding rollback')
      }
      await assert.rejects(
        deliverMarketFundingCashu({
          attempt: {
            kind: 'begin',
            expectedPreviousTransferId: null,
            newAttemptId: '33333333-3333-4333-8333-333333333333',
            requestedAmount: '8000',
          },
          accountSubject: 'subject-1',
          conditionId: 'b'.repeat(64),
          divisibility: 1000,
          outcomeCount: 8,
          maxWalletDebitMsat: 8000,
          profile: {
            mintUrl: MINT,
            engineBaseUrl: 'https://engine.example',
            initializedAt: new Date().toISOString(),
          },
          secrets: { walletSeedHex: SEED },
          deps: f.deps,
          client: {
            getDurableRecipientDeliveryStatus: async () => null,
            submitDurableRecipientDelivery: async () => {
              throw new Error('recipient must not run')
            },
          },
        }),
        /controlled funding rollback/,
      )
      assert.deepEqual(await rows(f.directory), before)
      assert.deepEqual(await heads(), beforeHeads)
      assert.equal(f.counts.swaps, swaps)
    } finally {
      await f.close()
    }
  })

test('counter and Score selection conflicts consume one three-attempt budget with actual default drafts', async () => {
  const f = await funded(8192)
  try {
    const before = await rows(f.directory)
    const swaps = f.counts.swaps
    let drafts = 0
    const coordinator = new DaemonDurableOutgoingCashuCoordinator(
      f.directory,
      () => f.fence,
      f.deps,
    )
    f.deps.createCashuWallet = (_mint, _unit, source) => {
      const wallet = createWallet(
        MINT,
        { walletSeedHex: SEED },
        { ...f.deps, createCashuWallet: undefined },
        'sat',
        'msat',
        undefined,
        source,
      )
      const prepare = wallet.prepareSwapToSend!.bind(wallet)
      wallet.prepareSwapToSend = async (...args) => {
        const result = await prepare(...args)
        drafts++
        if (drafts === 2)
          await coordinator.preflightParticipationScoreDelivery({
            transferId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            amountMsat: 1000,
            purchasedTotal: 3,
            accountSubject: 'subject-1',
            mintUrl: MINT,
          })
        else
          await reserveDaemonKeysetCounter(
            wallet.getKeyset!().id,
            1,
            { fence: f.fence, observedAtMs: Date.now() },
            { normalizedMint: MINT, unit: 'msat' },
          )
        return result
      }
      return wallet
    }
    await assert.rejects(
      deliverParticipationScoreCashu({
        deliveryId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        accountSubject: 'subject-1',
        amountMsat: 1000,
        purchasedTotalEpoch: 3,
        profile: {
          mintUrl: MINT,
          engineBaseUrl: 'https://engine.example',
          initializedAt: new Date().toISOString(),
        },
        secrets: { walletSeedHex: SEED },
        deps: f.deps,
        client: {
          getDurableRecipientDeliveryStatus: async () => null,
          submitDurableRecipientDelivery: async () => {
            throw new Error('recipient must not run')
          },
        },
      }),
      /outgoing preparation must be selected again/,
    )
    assert.equal(drafts, 3)
    const after = await rows(f.directory)
    assert.equal(after.operations, before.operations)
    assert.equal(after.transfers, 0)
    assert.equal(after.counters[0], before.counters[0]! + 2)
    assert.equal(after.pointers.length, 1)
    assert.equal(f.counts.swaps, swaps)
  } finally {
    await f.close()
  }
})

test('saved send linkage corruption refuses the public retry before metadata or mint work', async () => {
  const f = await funded()
  try {
    f.control.beforeSwap = async () => {
      throw new Error('controlled before-mint failure')
    }
    await assert.rejects(f.send(), /controlled before-mint failure/)
    await withDaemonStateSqliteTransaction(f.directory, (db) => {
      const foreign = db
        .prepare(
          "SELECT operation_id FROM custody_operations WHERE wallet_stage = 'receive' LIMIT 1",
        )
        .get()!.operation_id
      db.prepare(
        'UPDATE daemon_outgoing_cashu_transfers SET custody_operation_id = ? WHERE transfer_id = ?',
      ).run(foreign, 'send-atomic')
    })
    const before = await rows(f.directory)
    let wallets = 0
    f.deps.createCashuWallet = () => {
      wallets++
      throw new Error('metadata must not run')
    }
    await assert.rejects(f.send(), /custody operation is foreign|original send journal conflicts/)
    assert.equal(wallets, 0)
    assert.deepEqual(await rows(f.directory), before)
  } finally {
    await f.close()
  }
})

for (const phase of ['before-commit', 'after-commit'] as const)
  test(`actual default send ${phase} fault preserves exact durable selection`, async () => {
    const f = await funded()
    try {
      const before = await rows(f.directory)
      let injected = false
      f.deps.injectCustodyFault = (observed) => {
        if (!injected && observed === phase) {
          injected = true
          throw new Error('controlled COMMIT reply')
        }
      }
      if (phase === 'before-commit') {
        await assert.rejects(f.send(), /controlled COMMIT reply/)
        assert.deepEqual(await rows(f.directory), before)
      } else {
        const sent = await f.send()
        const after = await rows(f.directory)
        assert.equal(after.operations, before.operations + 1)
        assert.equal(after.transfers, 1)
        assert.deepEqual(await f.send(), sent)
        assert.deepEqual(await rows(f.directory), after)
      }
      assert.equal(injected, true)
    } finally {
      await f.close()
    }
  })

function credited(submission: DurableRecipientDeliverySubmission) {
  const { token: _token, ...delivery } = submission
  return decodeDurableRecipientDeliveryStatus({
    delivery,
    tupleFingerprint: deriveDurableRecipientTupleFingerprint(submission),
    state: 'credited',
    result: {
      creditedAmount: submission.requestedAmount,
      receiveFee: '0',
      creditVerification: submission.creditPolicy,
      receiveOperationId: 'receive-1',
      receivedAt: '2026-08-11T00:00:00.000Z',
      businessEventId: 'event-1',
      businessEventAt: '2026-08-11T00:00:00.000Z',
    },
  })
}
for (const kind of ['score', 'funding'] as const)
  test(`actual default ${kind} completes and exact retry makes no second allocation or mint request`, async () => {
    const f = await funded(8192)
    try {
      let saved: DurableRecipientDeliverySubmission | undefined
      let posts = 0
      const common = {
        accountSubject: 'subject-1',
        profile: {
          mintUrl: MINT,
          engineBaseUrl: 'https://engine.example',
          initializedAt: new Date().toISOString(),
        },
        secrets: { walletSeedHex: SEED },
        deps: f.deps,
        client: {
          getDurableRecipientDeliveryStatus: async () => (saved ? credited(saved) : null),
          submitDurableRecipientDelivery: async (
            submission: DurableRecipientDeliverySubmission,
          ) => {
            saved = submission
            posts++
            return credited(submission)
          },
        },
      }
      const deliver = () =>
        kind === 'score'
          ? deliverParticipationScoreCashu({
              ...common,
              deliveryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              amountMsat: 1000,
              purchasedTotalEpoch: 3,
              requireExactRequest: true,
              maxWalletDebitMsat: 1000,
            })
          : deliverMarketFundingCashu({
              ...common,
              conditionId: 'b'.repeat(64),
              divisibility: 1000,
              outcomeCount: 8,
              maxWalletDebitMsat: 8000,
              attempt: {
                kind: 'begin',
                expectedPreviousTransferId: null,
                newAttemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                requestedAmount: '8000',
              },
            })
      const result = await deliver()
      assert.equal(result.state, 'credited')
      const committed = await rows(f.directory)
      const swaps = f.counts.swaps
      assert.deepEqual(await deliver(), result)
      assert.deepEqual(await rows(f.directory), committed)
      assert.equal(f.counts.swaps, swaps)
      assert.equal(posts, 1)
    } finally {
      await f.close()
    }
  })

test(
  'overlapping public sends select one saved allocation and replay the winner exact outputs',
  { timeout: 15000 },
  async () => {
    const f = await funded()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let first: Promise<unknown> | undefined
    try {
      const priorRequests = f.swapRequests.length
      let calls = 0
      f.control.beforeSwap = async () => {
        if (++calls === 1) {
          started.resolve()
          await release.promise
        }
      }
      first = f.send()
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
      f.control.state = CheckStateEnum.UNSPENT
      const second = await f.send()
      const secondRows = await rows(f.directory)
      assert.equal(secondRows.operations, committed.operations)
      assert.deepEqual(secondRows.counters, committed.counters)
      assert.equal(secondRows.transfers, 1)
      release.resolve()
      assert.deepEqual(await first, second)
      assert.equal(f.swapRequests.length, priorRequests + 2)
      assert.equal(f.swapRequests[priorRequests], f.swapRequests[priorRequests + 1])
      assert.deepEqual(await rows(f.directory), secondRows)
    } finally {
      release.resolve()
      await first?.catch(() => {})
      await f.close()
    }
  },
)

test(
  'a losing default draft on another keyset recovers only the saved winner bytes',
  { timeout: 15000 },
  async () => {
    const f = await funded()
    const drafted = Promise.withResolvers<void>()
    const releaseDraft = Promise.withResolvers<void>()
    const mintEntered = Promise.withResolvers<void>()
    const releaseMint = Promise.withResolvers<void>()
    let loser: Promise<unknown> | undefined
    let winner: Promise<unknown> | undefined
    try {
      let drafts = 0
      let firstKeyset: string | undefined
      let secondKeyset: string | undefined
      f.deps.createCashuWallet = (_mint, _unit, source) => {
        const wallet = createWallet(
          MINT,
          { walletSeedHex: SEED },
          { ...f.deps, createCashuWallet: undefined },
          'sat',
          'msat',
          undefined,
          source,
        )
        const prepare = wallet.prepareSwapToSend!.bind(wallet)
        wallet.prepareSwapToSend = async (...args) => {
          const preview = await prepare(...args)
          if (++drafts === 1) {
            firstKeyset = preview.keysetId
            drafted.resolve()
            await releaseDraft.promise
          } else secondKeyset = preview.keysetId
          return preview
        }
        return wallet
      }
      const prior = f.swapRequests.length
      let calls = 0
      f.control.beforeSwap = async () => {
        if (++calls === 1) {
          mintEntered.resolve()
          await releaseMint.promise
        }
      }
      loser = f.send()
      await awaitAbortable(
        Promise.race([
          drafted.promise,
          loser.then(() => {
            throw new Error('draft ended before barrier')
          }),
        ]),
        AbortSignal.timeout(5000),
      )
      f.control.alternateKeyset = true
      winner = f.send()
      await awaitAbortable(
        Promise.race([
          mintEntered.promise,
          winner.then(() => {
            throw new Error('winner ended before barrier')
          }),
        ]),
        AbortSignal.timeout(5000),
      )
      assert.notEqual(firstKeyset, secondKeyset)
      const committed = await rows(f.directory)
      releaseDraft.resolve()
      const recovered = await loser
      releaseMint.resolve()
      assert.deepEqual(await winner, recovered)
      assert.deepEqual((await rows(f.directory)).counters, committed.counters)
      assert.equal((await rows(f.directory)).transfers, 1)
      assert.equal(f.swapRequests.length, prior + 2)
      assert.equal(f.swapRequests[prior], f.swapRequests[prior + 1])
    } finally {
      releaseDraft.resolve()
      releaseMint.resolve()
      await Promise.allSettled([loser, winner])
      await f.close()
    }
  },
)
