import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from '@bitcaster-market/client-sdk'
import { createCtfProofOperationCompletion } from '@bitcaster-market/client-sdk/ctfSplit'
import {
  encodeCanonicalRangePreparation,
  insertRangePreparation,
  linkRangePreparationSource,
} from '../src/ctfRangeOrderJournalSqlite.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease, renewCustodyScopeLease } from '../src/profileFencing.ts'
import {
  openDaemonStateSqlite,
  subscribeToDaemonWalletHoldingsCommits,
  withDaemonStateSqliteTransaction,
} from '../src/stateSqlite.ts'
import {
  advanceDaemonKeysetCounter,
  AVAILABLE_WALLET_PROOF_AMOUNT_SAMPLES_FOR_RECEIVE_SQL,
  assertPreparedProofOperationDispatchFenced,
  completeCompleteSetCtfProofOperationFenced,
  completeRegularSplitWithCompleteSetHandoffFenced,
  COMPLETE_SET_RECOVERY_ROOT_PAGE_SQL,
  emptyDaemonState,
  ensureState,
  markProofOperationCompletedFenced,
  prepareCompleteSetCtfProofOperationFenced,
  prepareCompleteSetRegularProofOperationFenced,
  prepareProofOperationWithExactReservation,
  readAvailableWalletProofsFenced,
  readAvailableWalletProofAmountSamplesForReceive,
  readRecoverableCompleteSetProofOperationPage,
  readAvailableWalletProofGroupPage,
  readAvailableWalletProofPage,
  readDaemonKeysetCounters,
  readState,
  recordDiscoveredOrder,
  recordOrderStatus,
  recordSubmittedOrder,
  reserveDaemonKeysetCounter,
  updateState,
  writeState,
  type FencedStateMutation,
  type ExactProofOperationAuthority,
  type ProofOperationRecord,
} from '../src/state.ts'

const walletSeedHex = '11'.repeat(64)
const nostrSecretKeyHex = '22'.repeat(32)
const COUNTER_BINDING = { normalizedMint: 'http://localhost:8086', unit: 'msat' as const }
const KEYSET_ID = `01${'33'.repeat(32)}`
const UNTOUCHED_KEYSET_ID = `01${'44'.repeat(32)}`
const COUNTER_KEYSET_ID = `01${'55'.repeat(32)}`
const MAXIMUM_BATCH_KEYSET_ID = `01${'66'.repeat(32)}`
const CONCURRENT_KEYSET_ID = `01${'77'.repeat(32)}`
const SHARED_KEYSET_ID = `01${'88'.repeat(32)}`
const LAST_USABLE_KEYSET_ID = `01${'99'.repeat(32)}`
const PAGE_KEYSET_ID = `01${'aa'.repeat(32)}`
const REGULAR_KEYSET_ID = `01${'bb'.repeat(32)}`
const CONDITIONAL_KEYSET_ID = `01${'cc'.repeat(32)}`

test('target-v1 state round-trips through retained typed SQLite rows and artifacts', async () => {
  await withProfile(async (home) => {
    const state = emptyDaemonState()
    state.wallet.proofs.push({
      proof: { id: KEYSET_ID, amount: 7, secret: 'proof-secret', C: 'proof-signature' },
      mintUrl: 'http://localhost:8086',
      state: 'reserved',
      reservedBy: 'send-1',
      asset: {
        kind: 'Outcome',
        conditionId: 'condition-1',
        outcomeSetId: 'YES',
        baseAsset: 'sat',
        unit: 'msat',
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
    })
    state.proofOperations['operation-1'] = {
      operationId: 'operation-1',
      kind: 'ctf-consolidation',
      state: 'completed',
      mintUrl: 'http://localhost:8086',
      inputs: [{ amount: 7, secret: 'proof-secret', C: 'proof-signature' }],
      outputs: {
        send: [
          {
            blindedMessage: { amount: 7, id: KEYSET_ID, B_: 'blind' },
            blindingFactor: 'factor',
            secret: 'output-secret',
          },
        ],
      },
      metadata: { conditionId: 'condition-1', attempt: 2 },
      resultProofs: {
        send: [{ id: KEYSET_ID, amount: 7, secret: 'result-secret', C: 'result-signature' }],
      },
      lastError: null,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_001_000,
    }
    state.orders['order-1'] = {
      orderId: 'order-1',
      marketId: 'condition-1-YES',
      tokenSide: 'Outcome',
      side: 'Sell',
      priceSubunits: 4_200,
      amountSubunits: 100,
      status: 'resting',
      clientOrderId: 'client-order-1',
      preflightSplit: {
        reservationId: 'reservation-1',
        conditionId: 'condition-1',
        keepOutcomeSetId: 'NO',
        lockOutcomeSetId: 'YES',
        amountSubunits: 100,
      },
      baseAsset: 'sat',
      divisibility: 1_000,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
    }

    await writeState(state)
    const restored = await readState()
    assert.equal(restored?.wallet.proofs[0].proof.id, KEYSET_ID)
    assert.deepEqual(restored?.wallet.keysetCounters, {})
    assert.equal(restored?.proofOperations['operation-1'].kind, 'ctf-consolidation')
    assert.equal(restored?.orders['order-1'].preflightSplit?.lockOutcomeSetId, 'YES')

    const database = await openDaemonStateSqlite(home)
    try {
      const row = database
        .prepare(
          `SELECT COUNT(*) AS forbiddenCount FROM sqlite_master
           WHERE name IN ('daemon_order_trades', 'daemon_swaps', 'swap_operation_links',
                          'target_ephemeral_keys')`,
        )
        .get() as { forbiddenCount: number }
      assert.equal(row.forbiddenCount, 0)
    } finally {
      database.close()
    }
  })
})

test('receive denomination samples are bounded, scoped, and index-backed', async () => {
  await withProfile(async (home) => {
    const state = emptyDaemonState()
    for (let exponent = 0; exponent <= 52; exponent += 1) {
      for (let sample = 0; sample < 4; sample += 1) {
        state.wallet.proofs.push({
          proof: proof(`receive-${exponent}-${sample}`, 2 ** exponent),
          mintUrl: 'http://localhost:8086',
          state: 'available',
          asset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        })
      }
    }
    state.wallet.proofs.push(
      {
        proof: proof('receive-reserved', 1),
        mintUrl: 'http://localhost:8086',
        state: 'reserved',
        reservedBy: 'other',
        asset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        proof: proof('receive-other-mint', 1),
        mintUrl: 'https://other.example',
        state: 'available',
        asset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        proof: proof('receive-other-unit', 1),
        mintUrl: 'http://localhost:8086',
        state: 'available',
        asset: { kind: 'sats', baseAsset: 'sat', unit: 'sat' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    )
    await writeState(state)
    const mutation = await claimMutation(home, 'receive-amount-samples')
    const samples = await readAvailableWalletProofAmountSamplesForReceive({
      mintUrl: 'http://localhost:8086',
      unit: 'msat',
      mutation,
    })
    assert.equal(samples.length, 159)
    assert.ok(samples.length <= 192)
    for (const amount of new Set(samples.map(({ amount }) => amount))) {
      assert.equal(samples.filter((sample) => sample.amount === amount).length, 3)
    }
    const database = await openDaemonStateSqlite(home)
    try {
      const plan = database
        .prepare(`EXPLAIN QUERY PLAN ${AVAILABLE_WALLET_PROOF_AMOUNT_SAMPLES_FOR_RECEIVE_SQL}`)
        .all(
          mutation.fence.scopeId,
          'http://localhost:8086',
          'msat',
          mutation.fence.scopeId,
          'http://localhost:8086',
          'msat',
        ) as Array<{ detail: string }>
      assert.ok(
        plan.some(({ detail }) => detail.includes('target_wallet_proofs_receive_amount_idx')),
      )
    } finally {
      database.close()
    }
  })
})

test('ensureState initializes once without queue deadlock and survives restart', async () => {
  await withProfile(async () => {
    const initialized = await Promise.race([
      ensureState(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('ensureState timed out')), 2_000),
      ),
    ])
    assert.equal(initialized.version, 1)
    assert.equal((await ensureState()).version, 1)
    assert.equal((await readState())?.version, 1)
  })
})

test('monitoring observers ignore lease commits and receive holdings commits', async () => {
  await withProfile(async (home) => {
    const mutation = await claimMutation(home, 'monitoring-observer')
    let notifications = 0
    const unsubscribe = subscribeToDaemonWalletHoldingsCommits(home, () => {
      notifications += 1
    })
    try {
      await renewCustodyScopeLease(home, mutation.fence, mutation.observedAtMs + 1)
      assert.equal(notifications, 0)
      await assert.rejects(
        () =>
          withDaemonStateSqliteTransaction(
            home,
            () => {
              throw new Error('rollback')
            },
            { notifyWalletHoldingsCommit: true },
          ),
        /rollback/,
      )
      assert.equal(notifications, 0)
      await writeState(walletStateWithProofs([proof('monitoring-proof', 1)]))
      assert.equal(notifications, 1)
    } finally {
      unsubscribe()
    }
  })
})

test('order writes preserve range custody rows and do not notify wallet holdings', async () => {
  await withProfile(async (home) => {
    let notifications = 0
    const unsubscribe = subscribeToDaemonWalletHoldingsCommits(home, () => {
      notifications += 1
    })
    try {
      const fresh = await recordSubmittedOrder(
        'condition-1-YES',
        'fresh-client-order',
        { orderId: 'fresh-engine-order', status: 'submitted', baseAsset: 'sat', divisibility: 1_000 },
        null,
        'Outcome',
        'Buy',
        500,
        1_000,
        'sat',
        1_000,
      )
      assert.equal(fresh.orderId, 'fresh-engine-order')
      assert.equal((await readState())?.orders['fresh-engine-order']?.status, 'submitted')
      assert.equal(notifications, 0)

      const sourceProof = proof('range-source-proof', 1)
      const state = walletStateWithProofs([sourceProof])
      state.orders[fresh.orderId] = fresh
      state.proofOperations['range-source-operation'] = rangeSourceOperation(sourceProof)
      await writeState(state)
      const mutation = await claimMutation(home, 'order-write-preservation')
      await reserveDaemonKeysetCounter(COUNTER_KEYSET_ID, 4, mutation, COUNTER_BINDING)

      const database = await openDaemonStateSqlite(home)
      try {
        insertRangePreparation(database, {
          scopeId: mutation.fence.scopeId,
          rangeOperationId: 'range-operation-source',
          sourceOperationId: 'range-source-operation',
          authorizationId: 'range-authorization-source',
          clientOrderId: 'range-client-source',
          orderRouteId: 'condition-1-YES',
          normalizedMint: 'http://localhost:8086',
          conditionId: 'condition-1',
          unit: 'msat',
          tokenSide: 'Outcome',
          side: 'Buy',
          priceSubunits: 500,
          amountSubunits: 1_000,
          minimumFillAmountSubunits: 1_000,
          consolidateProofs: false,
          divisibility: 1_000,
          authorizationExpiresAtUnixSeconds: 2_000_000_000,
          preparationBytes: encodeCanonicalRangePreparation({
            rangeOperationId: 'range-operation-source',
            authorizationId: 'range-authorization-source',
          }),
          createdAtMs: 1,
        })
        linkRangePreparationSource(database, {
          scopeId: mutation.fence.scopeId,
          rangeOperationId: 'range-operation-source',
          sourceOperationId: 'range-source-operation',
          reservationId: 'range-source-reservation',
        })
        const removedMetadata = database
          .prepare('DELETE FROM target_state_metadata WHERE scope_id = ?')
          .run(mutation.fence.scopeId)
        assert.equal(removedMetadata.changes, 1)
        assert.equal(
          database
            .prepare('SELECT 1 FROM target_state_metadata WHERE scope_id = ?')
            .get(mutation.fence.scopeId),
          undefined,
        )
      } finally {
        database.close()
      }

      const before = await readOrderWriteAuthoritySnapshot(home, mutation.fence.scopeId)
      const notificationsBeforeOrders = notifications
      const submitted = await recordSubmittedOrder(
        'condition-1-YES',
        'source-client-order',
        {
          orderId: 'source-engine-order',
          status: 'submitted',
          baseAsset: 'sat',
          divisibility: 1_000,
        },
        null,
        'Outcome',
        'Buy',
        500,
        1_000,
        'sat',
        1_000,
      )
      assert.equal(submitted.orderId, 'source-engine-order')
      const submittedRow = await readOrderRowMetadata(home, mutation.fence.scopeId, submitted.orderId)
      assert.equal(submittedRow.scopeId, mutation.fence.scopeId)
      assert.equal(submittedRow.revision, 0)
      assert.equal(submittedRow.createdAtMs, Date.parse(submitted.createdAt))
      assert.equal(submittedRow.updatedAtMs, Date.parse(submitted.updatedAt))
      const metadataAfterSubmitted = await openDaemonStateSqlite(home)
      try {
        assert.equal(
          (metadataAfterSubmitted
            .prepare('SELECT schema_version FROM target_state_metadata WHERE scope_id = ?')
            .get(mutation.fence.scopeId) as { schema_version: number }).schema_version,
          1,
        )
      } finally {
        metadataAfterSubmitted.close()
      }
      assert.deepEqual(await readOrderWriteAuthoritySnapshot(home, mutation.fence.scopeId), before)

      const discovered = await recordDiscoveredOrder(
        'condition-1-YES',
        'source-client-order',
        { orderId: 'source-engine-order', status: 'filled' },
        'Outcome',
        'Buy',
        500,
        1_000,
        'sat',
        1_000,
      )
      assert.equal(discovered.status, 'Filled')
      const discoveredRow = await readOrderRowMetadata(home, mutation.fence.scopeId, discovered.orderId)
      assert.equal(discoveredRow.scopeId, mutation.fence.scopeId)
      assert.equal(discoveredRow.revision, submittedRow.revision + 1)
      assert.equal(discoveredRow.createdAtMs, submittedRow.createdAtMs)
      assert.ok(discoveredRow.updatedAtMs >= discoveredRow.createdAtMs)
      assert.deepEqual(await readOrderWriteAuthoritySnapshot(home, mutation.fence.scopeId), before)

      const cancelled = await recordOrderStatus('condition-1-YES', 'source-engine-order', {
        orderId: 'source-engine-order',
        status: 'cancelled',
      })
      assert.equal(cancelled.status, 'cancelled')
      const cancelledRow = await readOrderRowMetadata(home, mutation.fence.scopeId, cancelled.orderId)
      assert.equal(cancelledRow.scopeId, mutation.fence.scopeId)
      assert.equal(cancelledRow.revision, discoveredRow.revision + 1)
      assert.equal(cancelledRow.createdAtMs, submittedRow.createdAtMs)
      assert.ok(cancelledRow.updatedAtMs >= discoveredRow.updatedAtMs)
      assert.deepEqual(await readOrderWriteAuthoritySnapshot(home, mutation.fence.scopeId), before)

      const concurrent = await Promise.all([
        recordOrderStatus('condition-1-YES', 'concurrent-engine-a', {
          orderId: 'concurrent-engine-a',
          status: 'submitted',
          baseAsset: 'sat',
          divisibility: 1_000,
        }),
        recordOrderStatus('condition-1-YES', 'concurrent-engine-b', {
          orderId: 'concurrent-engine-b',
          status: 'submitted',
          baseAsset: 'sat',
          divisibility: 1_000,
        }),
      ])
      assert.deepEqual(
        concurrent.map(({ orderId }) => orderId).sort(),
        ['concurrent-engine-a', 'concurrent-engine-b'],
      )
      assert.deepEqual(await readOrderWriteAuthoritySnapshot(home, mutation.fence.scopeId), before)

      const rollbackBefore = await readOrderWriteAuthoritySnapshot(home, mutation.fence.scopeId)
      await assert.rejects(
        () =>
          withDaemonStateSqliteTransaction(home, (rollbackDatabase) => {
            rollbackDatabase
              .prepare(
                `UPDATE daemon_orders SET status = 'rollback-status'
                 WHERE scope_id = ? AND order_id = ?`,
              )
              .run(mutation.fence.scopeId, 'source-engine-order')
            throw new Error('order write rollback')
          }),
        /order write rollback/,
      )
      assert.deepEqual(
        await readOrderWriteAuthoritySnapshot(home, mutation.fence.scopeId),
        rollbackBefore,
      )
      assert.equal((await readState())?.orders['source-engine-order']?.status, 'cancelled')
      assert.equal(notifications, notificationsBeforeOrders)

      const finalDatabase = await openDaemonStateSqlite(home)
      try {
        const foreignKeys = finalDatabase.prepare('PRAGMA foreign_key_check').all() as unknown[]
        assert.deepEqual(foreignKeys, [])
      } finally {
        finalDatabase.close()
      }
    } finally {
      unsubscribe()
    }
  })
})

test('keyset counter rows reserve adjacent ranges and advance monotonically', async () => {
  await withProfile(async (home) => {
    const mutation = await claimMutation(home, 'counter-ranges')
    assert.deepEqual(
      await reserveDaemonKeysetCounter(UNTOUCHED_KEYSET_ID, 0, mutation, COUNTER_BINDING),
      {
        start: 0,
        count: 0,
      },
    )
    assert.deepEqual(await readDaemonKeysetCounters(COUNTER_BINDING), {})
    assert.deepEqual(
      await reserveDaemonKeysetCounter(COUNTER_KEYSET_ID, 2, mutation, COUNTER_BINDING),
      {
        start: 0,
        count: 2,
      },
    )
    assert.deepEqual(
      await reserveDaemonKeysetCounter(COUNTER_KEYSET_ID, 3, mutation, COUNTER_BINDING),
      {
        start: 2,
        count: 3,
      },
    )
    assert.deepEqual(
      await reserveDaemonKeysetCounter(COUNTER_KEYSET_ID, 0, mutation, COUNTER_BINDING),
      {
        start: 5,
        count: 0,
      },
    )
    await advanceDaemonKeysetCounter(COUNTER_KEYSET_ID, 8, mutation, COUNTER_BINDING)
    await advanceDaemonKeysetCounter(COUNTER_KEYSET_ID, 6, mutation, COUNTER_BINDING)
    assert.deepEqual(
      await reserveDaemonKeysetCounter(COUNTER_KEYSET_ID, 1, mutation, COUNTER_BINDING),
      {
        start: 8,
        count: 1,
      },
    )
    assert.deepEqual(
      await reserveDaemonKeysetCounter(MAXIMUM_BATCH_KEYSET_ID, 256, mutation, COUNTER_BINDING),
      {
        start: 0,
        count: 256,
      },
    )
    const concurrent = await Promise.all([
      reserveDaemonKeysetCounter(CONCURRENT_KEYSET_ID, 1, mutation, COUNTER_BINDING),
      reserveDaemonKeysetCounter(CONCURRENT_KEYSET_ID, 1, mutation, COUNTER_BINDING),
      reserveDaemonKeysetCounter(CONCURRENT_KEYSET_ID, 1, mutation, COUNTER_BINDING),
    ])
    assert.deepEqual(
      concurrent.map(({ start }) => start).sort((left, right) => left - right),
      [0, 1, 2],
    )
    assert.deepEqual(await readDaemonKeysetCounters(COUNTER_BINDING), {
      [CONCURRENT_KEYSET_ID]: 3,
      [COUNTER_KEYSET_ID]: 9,
      [MAXIMUM_BATCH_KEYSET_ID]: 256,
    })
  })
})

test('keyset counters bind the mint and unit and fail closed on a split authority', async () => {
  await withProfile(async (home) => {
    const mutation = await claimMutation(home, 'counter-binding')
    const sat = { normalizedMint: 'https://mint.example', unit: 'sat' as const }
    const msat = { normalizedMint: 'https://mint.example', unit: 'msat' as const }
    assert.deepEqual(await reserveDaemonKeysetCounter(SHARED_KEYSET_ID, 2, mutation, sat), {
      start: 0,
      count: 2,
    })
    assert.deepEqual(await reserveDaemonKeysetCounter(SHARED_KEYSET_ID, 3, mutation, msat), {
      start: 0,
      count: 3,
    })
    assert.deepEqual(await readDaemonKeysetCounters(sat), { [SHARED_KEYSET_ID]: 2 })
    assert.deepEqual(await readDaemonKeysetCounters(msat), { [SHARED_KEYSET_ID]: 3 })

    const database = await openDaemonStateSqlite(home)
    try {
      database
        .prepare(
          `DELETE FROM custody_keyset_counters
           WHERE scope_id = ? AND normalized_mint = ? AND unit = ? AND keyset_id = ?`,
        )
        .run(mutation.fence.scopeId, sat.normalizedMint, sat.unit, SHARED_KEYSET_ID)
    } finally {
      database.close()
    }
    await assert.rejects(
      () => reserveDaemonKeysetCounter(SHARED_KEYSET_ID, 1, mutation, sat),
      /one-sided or mismatched/,
    )
  })
})

test('keyset counter rows reject invalid ranges and immutable-row mutation', async () => {
  await withProfile(async (home) => {
    const mutation = await claimMutation(home, 'counter-bounds')
    for (const count of [-1, 1.5, 257, Number.MAX_SAFE_INTEGER]) {
      await assert.rejects(
        () => reserveDaemonKeysetCounter(COUNTER_KEYSET_ID, count, mutation, COUNTER_BINDING),
        /input is invalid/,
      )
    }
    for (const keysetId of ['', 'x'.repeat(1_025)]) {
      await assert.rejects(
        () => reserveDaemonKeysetCounter(keysetId, 1, mutation, COUNTER_BINDING),
        /canonical NUT-02 V2/,
      )
      await assert.rejects(
        () => advanceDaemonKeysetCounter(keysetId, 1, mutation, COUNTER_BINDING),
        /canonical NUT-02 V2/,
      )
    }
    await advanceDaemonKeysetCounter(
      LAST_USABLE_KEYSET_ID,
      2_147_483_647,
      mutation,
      COUNTER_BINDING,
    )
    assert.deepEqual(
      await reserveDaemonKeysetCounter(LAST_USABLE_KEYSET_ID, 1, mutation, COUNTER_BINDING),
      {
        start: 2_147_483_647,
        count: 1,
      },
    )
    await advanceDaemonKeysetCounter(COUNTER_KEYSET_ID, 2_147_483_648, mutation, COUNTER_BINDING)
    await assert.rejects(
      () => reserveDaemonKeysetCounter(COUNTER_KEYSET_ID, 1, mutation, COUNTER_BINDING),
      /exceeds its range/,
    )
    const database = await openDaemonStateSqlite(process.env.BITCASTER_DAEMON_HOME!)
    try {
      const scopeId = deriveDurableCustodyScopeId({
        scopeKind: 'wallet',
        walletId: deriveDurableCustodyWalletId(Buffer.from(walletSeedHex, 'hex')),
      })
      assert.throws(
        () => database.prepare('UPDATE target_keyset_counters SET next_counter = 1').run(),
        /cannot decrease/,
      )
      assert.throws(
        () => database.prepare("UPDATE target_keyset_counters SET keyset_id = 'other'").run(),
        /identity is immutable/,
      )
      assert.throws(
        () =>
          database.prepare('DELETE FROM target_keyset_counters WHERE scope_id = ?').run(scopeId),
        /cannot be deleted/,
      )
    } finally {
      database.close()
    }
  })
})

test('keyset counter rows reject a fence after custody takeover', async () => {
  await withProfile(async (home) => {
    const stale = await claimMutation(home, 'counter-stale-owner')
    await reserveDaemonKeysetCounter(COUNTER_KEYSET_ID, 2, stale, COUNTER_BINDING)
    const successorFence = await claimCustodyScopeLease(home, {
      scopeId: stale.fence.scopeId,
      incarnationId: 'counter-successor-owner',
      observedAtMs: stale.fence.leaseExpiresAtMs,
    })
    await assert.rejects(
      () => reserveDaemonKeysetCounter(COUNTER_KEYSET_ID, 1, stale, COUNTER_BINDING),
      /stale or expired authority/,
    )
    await assert.rejects(
      () => advanceDaemonKeysetCounter(COUNTER_KEYSET_ID, 8, stale, COUNTER_BINDING),
      /stale or expired authority/,
    )
    const current: FencedStateMutation = {
      fence: successorFence,
      observedAtMs: successorFence.leaseExpiresAtMs,
    }
    assert.deepEqual(
      await reserveDaemonKeysetCounter(COUNTER_KEYSET_ID, 1, current, COUNTER_BINDING),
      {
        start: 2,
        count: 1,
      },
    )
    await advanceDaemonKeysetCounter(COUNTER_KEYSET_ID, 8, current, COUNTER_BINDING)
    assert.equal((await readDaemonKeysetCounters(COUNTER_BINDING))[COUNTER_KEYSET_ID], 8)
  })
})

test('whole-state rewrites preserve monotonic counter rows and unrelated proof rows', async () => {
  await withProfile(async (home) => {
    const mutation = await claimMutation(home, 'counter-state-rewrite')
    const state = emptyDaemonState()
    state.wallet.proofs.push({
      proof: { id: COUNTER_KEYSET_ID, amount: 1, secret: 'preserved-secret', C: 'preserved-C' },
      mintUrl: 'http://localhost:8086',
      state: 'available',
      asset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    state.proofOperations['preserved-operation'] = preservedProofOperation()
    await writeState(state)
    await reserveDaemonKeysetCounter(COUNTER_KEYSET_ID, 9, mutation, COUNTER_BINDING)
    assert.equal((await readState())?.proofOperations['preserved-operation']?.state, 'completed')
    const rewrite = emptyDaemonState()
    rewrite.wallet.keysetCounters[COUNTER_KEYSET_ID] = 4
    rewrite.wallet.proofs = state.wallet.proofs
    await writeState(rewrite)
    assert.equal((await readState())?.wallet.proofs[0]?.proof.secret, 'preserved-secret')
    assert.equal((await readDaemonKeysetCounters(COUNTER_BINDING))[COUNTER_KEYSET_ID], 9)
  })
})

test('wallet proof selection pages and exact reservation stay row-scoped', async () => {
  await withProfile(async (home) => {
    const state = emptyDaemonState()
    for (let index = 0; index < 300; index += 1) {
      state.wallet.proofs.push({
        proof: {
          id: PAGE_KEYSET_ID,
          amount: 300 - index,
          secret: `page-secret-${index}`,
          C: `page-signature-${index}`,
        },
        mintUrl: 'http://localhost:8086',
        state: 'available',
        asset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      })
    }
    await writeState(state)

    const first = await readAvailableWalletProofPage({
      mintUrl: 'http://localhost:8086',
      keysetId: PAGE_KEYSET_ID,
      asset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
      limit: 64,
    })
    assert.equal(first.proofs.length, 64)
    assert.ok(first.nextCursor)
    assert.deepEqual(
      first.proofs.map(({ proof }) => Number(proof.amount)),
      Array.from({ length: 64 }, (_, index) => 300 - index),
    )

    const observedAtMs = Date.now()
    const fence = await claimCustodyScopeLease(home, {
      scopeId: deriveDurableCustodyScopeId({
        scopeKind: 'wallet',
        walletId: deriveDurableCustodyWalletId(Buffer.from(walletSeedHex, 'hex')),
      }),
      incarnationId: 'state-row-scoped-test',
      observedAtMs,
    })
    await prepareProofOperationWithExactReservation(
      {
        operationId: 'page-reservation',
        kind: 'wallet-send',
        mintUrl: 'http://localhost:8086',
        inputs: first.proofs.slice(0, 2).map(({ proof }) => proof),
        outputs: { send: [] },
        metadata: { purpose: 'page-test' },
        reservationId: 'page-reservation-id',
        asset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
      },
      { fence, observedAtMs },
    )
    const database = await openDaemonStateSqlite(home)
    try {
      const plan = database
        .prepare(
          `EXPLAIN QUERY PLAN SELECT * FROM target_wallet_proofs
           WHERE scope_id = ? AND normalized_mint = ?
             AND reserved_by = ? AND state = 'reserved'
           ORDER BY proof_id`,
        )
        .all(fence.scopeId, 'http://localhost:8086', 'page-reservation-id') as Array<{
        detail: string
      }>
      assert.ok(plan.some(({ detail }) => detail.includes('target_wallet_proofs_reservation_idx')))
    } finally {
      database.close()
    }

    const second = await readAvailableWalletProofPage({
      mintUrl: 'http://localhost:8086',
      keysetId: PAGE_KEYSET_ID,
      asset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
      limit: 64,
    })
    assert.equal(second.proofs.length, 64)
    assert.deepEqual(
      second.proofs.slice(0, 2).map(({ proof }) => Number(proof.amount)),
      [298, 297],
    )
    const persisted = await readState()
    assert.equal(persisted?.wallet.proofs.length, 300)
    assert.equal(
      persisted?.wallet.proofs.filter(({ state: proofState }) => proofState === 'reserved').length,
      2,
    )
    await claimCustodyScopeLease(home, {
      scopeId: fence.scopeId,
      incarnationId: 'state-row-scoped-successor',
      observedAtMs: fence.leaseExpiresAtMs,
    })
    await assert.rejects(
      markProofOperationCompletedFenced(
        'page-reservation',
        { send: [] },
        { fence, observedAtMs: observedAtMs + 1 },
      ),
      /stale or expired authority/,
    )
    assert.equal((await readState())?.proofOperations['page-reservation']?.state, 'prepared')
  })
})

test('regular split hands off its exact send successor without an available window', async () => {
  await withProfile(async (home) => {
    const input = proof('regular-predecessor', 100)
    const send = proof('regular-send', 30)
    const keep = proof('regular-keep', 70)
    await writeState(walletStateWithProofs([input]))
    const mutation = await claimMutation(home, 'regular-before-ctf')
    const regularAuthority = regularSplitAuthority()
    const ctfAuthority = completeSetAuthority()
    const root = completeSetRoot('complete-set-root:regular-split', null)
    await prepareCompleteSetRegularProofOperationFenced(
      {
        ...exactPreparation(
          'complete-set-root:regular-split',
          'regular-split',
          [input],
          regularAuthority,
        ),
        metadata: completeSetMetadata(regularAuthority, root),
        root,
      },
      mutation,
    )
    const schemaDatabase = await openDaemonStateSqlite(home)
    try {
      assert.throws(
        () =>
          schemaDatabase
            .prepare(
              `INSERT INTO daemon_complete_set_recovery_roots (
                 scope_id, root_operation_id, normalized_mint, condition_id, amount_sats,
                 regular_operation_id, ctf_operation_id, state, created_at_ms, updated_at_ms
               ) VALUES (?, ?, ?, ?, ?, NULL, ?, 'ctf-handoff', ?, ?)`,
            )
            .run(
              mutation.fence.scopeId,
              'invalid-handoff-root',
              'http://localhost:8086',
              'condition-1',
              30,
              'invalid-handoff-ctf',
              mutation.observedAtMs,
              mutation.observedAtMs,
            ),
        /CHECK constraint failed/,
      )
      assert.throws(
        () =>
          schemaDatabase
            .prepare(
              `INSERT INTO daemon_complete_set_recovery_roots (
                 scope_id, root_operation_id, normalized_mint, condition_id, amount_sats,
                 regular_operation_id, regular_reservation_id, regular_purpose,
                 ctf_operation_id, ctf_reservation_id, ctf_purpose,
                 state, created_at_ms, updated_at_ms
               ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, 'ctf-prepared', ?, ?)`,
            )
            .run(
              mutation.fence.scopeId,
              'tuple-root',
              'http://localhost:8086',
              'condition-1',
              30,
              'tuple-root:regular-split',
              'tuple-root:ctf-split',
              'tuple-root:ctf-split:reservation',
              'daemon-complete-set-ctf-split',
              mutation.observedAtMs,
              mutation.observedAtMs,
            ),
        /CHECK constraint failed/,
      )
    } finally {
      schemaDatabase.close()
    }
    const completion = createCtfProofOperationCompletion('regular-split', {
      send: [send],
      keep: [keep],
    })
    await assert.rejects(
      () =>
        completeRegularSplitWithCompleteSetHandoffFenced(
          {
            operationId: 'complete-set-root:regular-split',
            completion: createCtfProofOperationCompletion('regular-split', { send: [send] }),
            regularAuthority,
            ctfAuthority,
            root,
          },
          mutation,
        ),
      /successor groups differ/,
    )
    const rolledBack = await readState()
    assert.equal(rolledBack?.proofOperations['complete-set-root:regular-split']?.state, 'prepared')
    assert.equal(
      rolledBack?.wallet.proofs.find(({ proof: value }) => value.secret === input.secret)?.state,
      'reserved',
    )
    await completeRegularSplitWithCompleteSetHandoffFenced(
      {
        operationId: 'complete-set-root:regular-split',
        completion,
        regularAuthority,
        ctfAuthority,
        root,
      },
      mutation,
    )
    await updateState((state) => state.wallet.proofs.length)
    const handoffPage = await readRecoverableCompleteSetProofOperationPage({
      regularPurpose: 'daemon-complete-set-regular-split',
      ctfPurpose: 'daemon-complete-set-ctf-split',
      limit: 64,
    })
    assert.deepEqual(
      handoffPage.roots.map(({ operationId }) => operationId),
      ['complete-set-root:regular-split'],
    )
    assert.equal(
      (await readState())?.wallet.proofs.find(({ proof: value }) => value.secret === send.secret)
        ?.state,
      'reserved',
    )
    await assert.rejects(
      () =>
        prepareProofOperationWithExactReservation(
          exactPreparation('concurrent-operation', 'ctf-split', [send], {
            ...ctfAuthority,
            reservationId: 'concurrent-reservation',
          }),
          mutation,
        ),
      /exact input is unavailable/,
    )
    await prepareCompleteSetCtfProofOperationFenced(
      {
        ...exactPreparation('complete-set-root:ctf-split', 'ctf-split', [send], ctfAuthority),
        metadata: completeSetMetadata(ctfAuthority, root),
        root,
      },
      mutation,
    )
    await assertPreparedProofOperationDispatchFenced(
      'complete-set-root:ctf-split',
      ctfAuthority,
      mutation,
    )
    await completeRegularSplitWithCompleteSetHandoffFenced(
      {
        operationId: 'complete-set-root:regular-split',
        completion,
        regularAuthority,
        ctfAuthority,
        root,
      },
      mutation,
    )
    const state = await readState()
    assert.equal(
      state?.wallet.proofs.find(({ proof: value }) => value.secret === keep.secret)?.state,
      'available',
    )
    assert.equal(
      state?.wallet.proofs.find(({ proof: value }) => value.secret === send.secret)?.state,
      'reserved',
    )
    await updateState((current, now) => {
      current.wallet.proofs.push({
        proof: proof('outcome-a', 30),
        mintUrl: 'http://localhost:8086',
        state: 'available',
        asset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
        createdAt: now,
        updatedAt: now,
      })
    })
    await assert.rejects(
      () =>
        completeCompleteSetCtfProofOperationFenced(
          {
            operationId: 'complete-set-root:ctf-split',
            completion: completeSetCompletion(),
            authority: ctfAuthority,
            root,
          },
          mutation,
        ),
      /conflicts with local wallet authority/,
    )
    const ctfRolledBack = await readState()
    assert.equal(ctfRolledBack?.proofOperations['complete-set-root:ctf-split']?.state, 'prepared')
    assert.equal(
      ctfRolledBack?.wallet.proofs.find(({ proof: value }) => value.secret === send.secret)?.state,
      'reserved',
    )
    await updateState((current) => {
      current.wallet.proofs = current.wallet.proofs.filter(
        ({ proof: value }) => value.secret !== 'outcome-a',
      )
    })
    await completeCompleteSetCtfProofOperationFenced(
      {
        operationId: 'complete-set-root:ctf-split',
        completion: completeSetCompletion(),
        authority: ctfAuthority,
        root,
      },
      mutation,
    )
    await completeCompleteSetCtfProofOperationFenced(
      {
        operationId: 'complete-set-root:ctf-split',
        completion: completeSetCompletion(),
        authority: ctfAuthority,
        root,
      },
      mutation,
    )
    const page = await readRecoverableCompleteSetProofOperationPage({
      regularPurpose: 'daemon-complete-set-regular-split',
      ctfPurpose: 'daemon-complete-set-ctf-split',
      limit: 64,
    })
    assert.equal(page.roots.length, 0)
  })
})

test('stale custody authority cannot complete a regular-to-CTF handoff', async () => {
  await withProfile(async (home) => {
    const input = proof('stale-regular-predecessor', 100)
    await writeState(walletStateWithProofs([input]))
    const mutation = await claimMutation(home, 'stale-regular-handoff')
    const regularAuthority = regularSplitAuthority()
    const ctfAuthority = completeSetAuthority()
    const root = completeSetRoot('complete-set-root:regular-split', null)
    await prepareCompleteSetRegularProofOperationFenced(
      {
        ...exactPreparation(
          'complete-set-root:regular-split',
          'regular-split',
          [input],
          regularAuthority,
        ),
        metadata: completeSetMetadata(regularAuthority, root),
        root,
      },
      mutation,
    )
    await claimCustodyScopeLease(home, {
      scopeId: mutation.fence.scopeId,
      incarnationId: 'complete-set-takeover',
      observedAtMs: mutation.fence.leaseExpiresAtMs,
    })

    await assert.rejects(
      () =>
        completeRegularSplitWithCompleteSetHandoffFenced(
          {
            operationId: 'complete-set-root:regular-split',
            completion: createCtfProofOperationCompletion('regular-split', {
              send: [proof('stale-send', 30)],
              keep: [proof('stale-keep', 70)],
            }),
            regularAuthority,
            ctfAuthority,
            root,
          },
          mutation,
        ),
      /stale or expired authority/,
    )
    assert.equal(
      (await readState())?.proofOperations['complete-set-root:regular-split']?.state,
      'prepared',
    )
  })
})

test('bounded complete-set recovery selection excludes completed CTF history', async () => {
  await withProfile(async (home) => {
    const state = emptyDaemonState()
    for (let index = 0; index < 65; index += 1) {
      state.proofOperations[`historic-${index}:ctf-split`] = completeSetOperationRecord(
        `historic-${index}:ctf-split`,
        'daemon-complete-set-ctf-split',
        'completed',
      )
    }
    state.proofOperations['paired:regular-split'] = completeSetOperationRecord(
      'paired:regular-split',
      'daemon-complete-set-regular-split',
      'completed',
    )
    state.proofOperations['paired:ctf-split'] = completeSetOperationRecord(
      'paired:ctf-split',
      'daemon-complete-set-ctf-split',
      'completed',
    )
    state.proofOperations['orphan:regular-split'] = completeSetOperationRecord(
      'orphan:regular-split',
      'daemon-complete-set-regular-split',
      'completed',
    )
    state.proofOperations['active:ctf-split'] = completeSetOperationRecord(
      'active:ctf-split',
      'daemon-complete-set-ctf-split',
      'prepared',
    )
    await writeState(state)

    const page = await readRecoverableCompleteSetProofOperationPage({
      regularPurpose: 'daemon-complete-set-regular-split',
      ctfPurpose: 'daemon-complete-set-ctf-split',
      limit: 64,
    })

    assert.deepEqual(
      page.roots.map(({ operationId }) => operationId),
      ['active:ctf-split', 'orphan:regular-split'],
    )
    assert.equal(page.hasMore, false)
    const scopeId = deriveDurableCustodyScopeId({
      scopeKind: 'wallet',
      walletId: deriveDurableCustodyWalletId(Buffer.from(walletSeedHex, 'hex')),
    })
    const database = await openDaemonStateSqlite(home)
    try {
      const plan = database
        .prepare(`EXPLAIN QUERY PLAN ${COMPLETE_SET_RECOVERY_ROOT_PAGE_SQL}`)
        .all(scopeId, 65) as Array<{ detail: string }>
      const details = plan.map(({ detail }) => detail).join('\n')
      assert.match(details, /daemon_complete_set_recovery_roots_active_idx/)
      assert.doesNotMatch(details, /SCAN target_proof_operations|USE TEMP B-TREE/)
    } finally {
      database.close()
    }
  })
})

test('complete-set recovery permits more than one bounded page of active roots', async () => {
  await withProfile(async () => {
    const state = emptyDaemonState()
    for (let index = 0; index < 65; index += 1) {
      state.proofOperations[`active-${index}:ctf-split`] = completeSetOperationRecord(
        `active-${index}:ctf-split`,
        'daemon-complete-set-ctf-split',
        'prepared',
      )
    }
    await writeState(state)

    const page = await readRecoverableCompleteSetProofOperationPage({
      regularPurpose: 'daemon-complete-set-regular-split',
      ctfPurpose: 'daemon-complete-set-ctf-split',
      limit: 64,
    })

    assert.equal(page.roots.length, 64)
    assert.equal(page.hasMore, true)
  })
})

test('available wallet proof reads require the exact base asset', async () => {
  await withProfile(async (home) => {
    const state = emptyDaemonState()
    state.wallet.proofs.push({
      proof: { id: KEYSET_ID, amount: 1, secret: 'wrong-base-asset', C: 'signature' },
      mintUrl: 'http://localhost:8086',
      state: 'available',
      asset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    await writeState(state)

    const database = await openDaemonStateSqlite(home)
    try {
      database.exec('PRAGMA ignore_check_constraints = ON')
      database
        .prepare("UPDATE target_wallet_proofs SET base_asset = 'other' WHERE secret = ?")
        .run('wrong-base-asset')
      database.exec('PRAGMA ignore_check_constraints = OFF')
    } finally {
      database.close()
    }

    const proofs = await readAvailableWalletProofsFenced({
      mintUrl: 'http://localhost:8086',
      asset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
      mutation: await claimMutation(home, 'exact-proof-asset'),
    })

    assert.equal(proofs.length, 0)
  })
})

test('whole-state complete-set serialization rejects malformed and duplicate authorities', async () => {
  await withProfile(async () => {
    const malformed = emptyDaemonState()
    malformed.proofOperations['malformed:regular-split'] = completeSetOperationRecord(
      'malformed:regular-split',
      'daemon-complete-set-regular-split',
      'prepared',
    )
    delete malformed.proofOperations['malformed:regular-split']!.metadata.conditionId
    await assert.rejects(() => writeState(malformed), /complete-set operation metadata is invalid/)

    const duplicate = emptyDaemonState()
    duplicate.proofOperations['duplicate-a:regular-split'] = completeSetOperationRecord(
      'duplicate-a:regular-split',
      'daemon-complete-set-regular-split',
      'prepared',
    )
    duplicate.proofOperations['duplicate-b:regular-split'] = completeSetOperationRecord(
      'duplicate-b:regular-split',
      'daemon-complete-set-regular-split',
      'prepared',
    )
    duplicate.proofOperations['duplicate-a:regular-split']!.metadata.rootOperationId =
      'duplicate-root'
    duplicate.proofOperations['duplicate-b:regular-split']!.metadata.rootOperationId =
      'duplicate-root'
    await assert.rejects(() => writeState(duplicate), /duplicate regular authority/)
  })
})

test('available proof groups page without loading proof bodies', async () => {
  await withProfile(async () => {
    const state = emptyDaemonState()
    for (let index = 0; index < 10_000; index += 1) {
      state.wallet.proofs.push({
        proof: {
          id: REGULAR_KEYSET_ID,
          amount: 1,
          secret: `regular-secret-${index}`,
          C: `regular-signature-${index}`,
        },
        mintUrl: 'http://localhost:8086',
        state: 'available',
        asset: { kind: 'sats', baseAsset: 'sat', unit: 'sat' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      })
    }
    state.wallet.proofs.push({
      proof: {
        id: CONDITIONAL_KEYSET_ID,
        amount: 4,
        secret: 'conditional-secret',
        C: 'conditional-signature',
      },
      mintUrl: 'http://localhost:8086',
      state: 'available',
      asset: {
        kind: 'Outcome',
        conditionId: 'condition-1',
        outcomeSetId: 'YES',
        baseAsset: 'sat',
        unit: 'msat',
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    await writeState(state)

    const first = await readAvailableWalletProofGroupPage({ limit: 1 })
    assert.equal(first.groups.length, 1)
    assert.ok(first.nextCursor)
    const second = await readAvailableWalletProofGroupPage({
      limit: 1,
      after: first.nextCursor ?? undefined,
    })
    assert.equal(second.groups.length, 1)
    assert.equal(second.nextCursor, null)
    assert.deepEqual(
      [...first.groups, ...second.groups].map(({ proofCount }) => proofCount).sort((a, b) => a - b),
      [1, 10_000],
    )
  })
})

test('state persistence clamps wall-clock regressions at creation time', async () => {
  await withProfile(async () => {
    const state = emptyDaemonState()
    state.wallet.proofs.push({
      proof: { id: KEYSET_ID, amount: 1, secret: 'proof-secret', C: 'proof-signature' },
      mintUrl: 'http://localhost:8086',
      state: 'available',
      asset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
      createdAt: '2026-01-01T00:00:01.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    state.proofOperations['operation-1'] = {
      operationId: 'operation-1',
      kind: 'wallet-send',
      state: 'prepared',
      mintUrl: 'http://localhost:8086',
      inputs: [],
      outputs: {},
      metadata: {},
      lastError: null,
      createdAt: 1_700_000_001_000,
      updatedAt: 1_700_000_000_000,
    }
    state.orders['order-1'] = {
      orderId: 'order-1',
      marketId: 'condition-1-YES',
      baseAsset: 'sat',
      divisibility: 1_000,
      status: 'resting',
      createdAt: '2026-01-01T00:00:01.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }

    await writeState(state)
    state.orders['order-1'].createdAt = '2025-01-01T00:00:01.000Z'
    state.orders['order-1'].updatedAt = '2025-01-01T00:00:01.000Z'
    await writeState(state)
    const restored = await readState()

    assert.equal(restored?.wallet.proofs[0].updatedAt, restored?.wallet.proofs[0].createdAt)
    assert.equal(
      restored?.proofOperations['operation-1'].updatedAt,
      restored?.proofOperations['operation-1'].createdAt,
    )
    assert.equal(restored?.orders['order-1'].updatedAt, restored?.orders['order-1'].createdAt)
  })
})

type OrderWriteAuthoritySnapshot = Record<
  'proofs' | 'counters' | 'operations' | 'sources' | 'artifacts',
  { count: number; digest: string }
>

async function readOrderWriteAuthoritySnapshot(
  home: string,
  scopeId: string,
): Promise<OrderWriteAuthoritySnapshot> {
  const database = await openDaemonStateSqlite(home)
  try {
    return {
      proofs: snapshotSqlRows(
        database,
        `SELECT proof_id, normalized_mint, unit, keyset_id, amount, secret, signature,
                proof_body, state, reserved_by, asset_kind, condition_id, outcome_set_id,
                base_asset, created_at_ms, updated_at_ms
         FROM target_wallet_proofs WHERE scope_id = ? ORDER BY proof_id`,
        scopeId,
      ),
      counters: snapshotSqlRows(
        database,
        `SELECT normalized_mint, unit, keyset_id, next_counter, updated_at_ms
         FROM target_keyset_counters WHERE scope_id = ?
         ORDER BY normalized_mint, unit, keyset_id`,
        scopeId,
      ),
      operations: snapshotSqlRows(
        database,
        `SELECT operation_id, kind, purpose, state, normalized_mint,
                request_artifact_id, output_artifact_id, result_artifact_id,
                result_proofs_digest, input_count, input_amount, last_error,
                reservation_id, created_at_ms, updated_at_ms
         FROM target_proof_operations WHERE scope_id = ? ORDER BY operation_id`,
        scopeId,
      ),
      sources: snapshotSqlRows(
        database,
        `SELECT range_operation_id, source_operation_id, reservation_id, operation_purpose
         FROM daemon_ctf_range_sources WHERE scope_id = ? ORDER BY range_operation_id`,
        scopeId,
      ),
      artifacts: snapshotSqlRows(
        database,
        `SELECT artifact_id, artifact_kind, encoding, body, fingerprint, revision,
                private_material, created_at_ms
         FROM custody_artifacts WHERE scope_id = ? ORDER BY artifact_id`,
        scopeId,
      ),
    }
  } finally {
    database.close()
  }
}

async function readOrderRowMetadata(
  home: string,
  scopeId: string,
  orderId: string,
): Promise<{ scopeId: string; revision: number; createdAtMs: number; updatedAtMs: number }> {
  const database = await openDaemonStateSqlite(home)
  try {
    const row = database
      .prepare(
        `SELECT scope_id, revision, created_at_ms, updated_at_ms
         FROM daemon_orders WHERE scope_id = ? AND order_id = ?`,
      )
      .get(scopeId, orderId) as
      | { scope_id: string; revision: number; created_at_ms: number; updated_at_ms: number }
      | undefined
    assert.ok(row)
    return {
      scopeId: row.scope_id,
      revision: row.revision,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
    }
  } finally {
    database.close()
  }
}

function snapshotSqlRows(
  database: Awaited<ReturnType<typeof openDaemonStateSqlite>>,
  query: string,
  ...bindings: string[]
): { count: number; digest: string } {
  const rows = database.prepare(query).all(...bindings) as Array<Record<string, unknown>>
  const normalizedRows = rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, normalizeSqlSnapshotValue(value)]),
    ),
  )
  return {
    count: rows.length,
    digest: createHash('sha256').update(JSON.stringify(normalizedRows)).digest('hex'),
  }
}

function normalizeSqlSnapshotValue(value: unknown): unknown {
  if (typeof value === 'bigint') return `bigint:${value.toString()}`
  if (value instanceof Uint8Array) return `blob:${Buffer.from(value).toString('hex')}`
  return value
}

async function withProfile(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-state-sqlite-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    await bootstrapFreshDaemonProfile({
      directory: home,
      engineBaseUrl: 'http://localhost:5001',
      mintUrl: 'http://localhost:8086',
      walletSeedHex,
      nostrSecretKeyHex,
    })
    await run(home)
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
}

async function claimMutation(home: string, incarnationId: string): Promise<FencedStateMutation> {
  const fence = await claimCustodyScopeLease(home, {
    scopeId: deriveDurableCustodyScopeId({
      scopeKind: 'wallet',
      walletId: deriveDurableCustodyWalletId(Buffer.from(walletSeedHex, 'hex')),
    }),
    incarnationId: `${incarnationId}-incarnation`,
    observedAtMs: Date.now(),
  })
  return { fence, observedAtMs: Date.now() }
}

function preservedProofOperation(): ProofOperationRecord {
  return {
    operationId: 'preserved-operation',
    kind: 'ctf-consolidation',
    state: 'completed',
    mintUrl: 'http://localhost:8086',
    inputs: [{ amount: 1, secret: 'preserved-secret', C: 'preserved-C' }],
    outputs: {
      send: [
        {
          blindedMessage: { amount: 1, id: COUNTER_KEYSET_ID, B_: 'preserved-blind' },
          blindingFactor: 'preserved-factor',
          secret: 'preserved-output-secret',
        },
      ],
    },
    metadata: { conditionId: 'condition-1', attempt: 1 },
    resultProofs: {
      send: [
        {
          id: COUNTER_KEYSET_ID,
          amount: 1,
          secret: 'preserved-result-secret',
          C: 'preserved-result-C',
        },
      ],
    },
    lastError: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  }
}

function rangeSourceOperation(sourceProof: { id: string; amount: number; secret: string; C: string }) {
  return {
    operationId: 'range-source-operation',
    kind: 'wallet-send' as const,
    state: 'prepared' as const,
    mintUrl: 'http://localhost:8086',
    inputs: [sourceProof],
    outputs: { source: [] },
    metadata: {
      purpose: 'ctf-range-authorization-source',
      reservationId: 'range-source-reservation',
    },
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
  }
}

function completeSetAuthority(): ExactProofOperationAuthority {
  return {
    purpose: 'daemon-complete-set-ctf-split',
    reservationId: 'complete-set-root:ctf-split:reservation',
    inputAsset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
    successorAssets: {
      A: {
        kind: 'Outcome',
        conditionId: 'condition-1',
        outcomeSetId: 'A',
        baseAsset: 'sat',
        unit: 'msat',
      },
      B: {
        kind: 'Outcome',
        conditionId: 'condition-1',
        outcomeSetId: 'B',
        baseAsset: 'sat',
        unit: 'msat',
      },
      C: {
        kind: 'Outcome',
        conditionId: 'condition-1',
        outcomeSetId: 'C',
        baseAsset: 'sat',
        unit: 'msat',
      },
    },
  }
}

function completeSetRoot(
  regularOperationId: string,
  ctfOperationId: string | null,
): {
  rootOperationId: string
  mintUrl: string
  conditionId: string
  amountSats: number
  regularOperationId: string
  ctfOperationId: string | null
} {
  return {
    rootOperationId: 'complete-set-root',
    mintUrl: 'http://localhost:8086',
    conditionId: 'condition-1',
    amountSats: 30,
    regularOperationId,
    ctfOperationId,
  }
}

function completeSetMetadata(
  authority: ExactProofOperationAuthority,
  root: ReturnType<typeof completeSetRoot>,
) {
  return {
    purpose: authority.purpose,
    reservationId: authority.reservationId,
    inputAsset: authority.inputAsset,
    successorAssets: authority.successorAssets,
    rootOperationId: root.rootOperationId,
    conditionId: root.conditionId,
    amountSats: root.amountSats,
  }
}

function regularSplitAuthority(): ExactProofOperationAuthority {
  const asset = { kind: 'sats', baseAsset: 'sat', unit: 'msat' } as const
  return {
    purpose: 'daemon-complete-set-regular-split',
    reservationId: 'complete-set-root:regular-split:reservation',
    inputAsset: asset,
    successorAssets: { send: asset, keep: asset },
  }
}

function exactPreparation(
  operationId: string,
  kind: 'ctf-split' | 'regular-split',
  inputs: Array<{ id: string; amount: number; secret: string; C: string }>,
  authority: ExactProofOperationAuthority,
) {
  return {
    operationId,
    kind,
    mintUrl: 'http://localhost:8086',
    inputs,
    outputs: Object.fromEntries(
      Object.keys(authority.successorAssets).map((group) => [
        group,
        [
          {
            blindedMessage: { amount: 30, id: KEYSET_ID, B_: `blind-${group}` },
            blindingFactor: `factor-${group}`,
            secret: `output-${group}`,
          },
        ],
      ]),
    ),
    metadata: {
      purpose: authority.purpose,
      reservationId: authority.reservationId,
      inputAsset: authority.inputAsset,
      successorAssets: authority.successorAssets,
    },
    reservationId: authority.reservationId,
    asset: authority.inputAsset,
  }
}

function completeSetCompletion() {
  return createCtfProofOperationCompletion('ctf-split', {
    A: [proof('outcome-a', 30)],
    B: [proof('outcome-b', 30)],
    C: [proof('outcome-c', 30)],
  })
}

function completeSetOperationRecord(
  operationId: string,
  purpose: 'daemon-complete-set-regular-split' | 'daemon-complete-set-ctf-split',
  state: 'prepared' | 'completed',
): ProofOperationRecord {
  const completion = completeSetCompletion()
  const rootOperationId = operationId.replace(/:(regular|ctf)-split$/, '')
  const kind = purpose.endsWith('regular-split') ? 'regular-split' : 'ctf-split'
  const inputAsset = { kind: 'sats', baseAsset: 'sat', unit: 'msat' } as const
  const successorAssets =
    kind === 'regular-split'
      ? { send: inputAsset, keep: inputAsset }
      : {
          A: {
            kind: 'Outcome',
            conditionId: 'condition-1',
            outcomeSetId: 'A',
            baseAsset: 'sat',
            unit: 'msat',
          },
        }
  return {
    operationId,
    kind,
    state,
    mintUrl: 'http://localhost:8086',
    inputs: [{ id: KEYSET_ID, amount: 30, secret: `${operationId}:input`, C: 'C-input' }],
    outputs: {},
    metadata: {
      purpose,
      rootOperationId,
      conditionId: 'condition-1',
      amountSats: 30,
      amountSubunits: 30,
      reservationId: `${operationId}:reservation`,
      inputAsset,
      successorAssets,
    },
    ...(state === 'completed'
      ? {
          resultProofs: completion.resultProofs,
          ...(kind === 'ctf-split' ? { resultProofsDigest: completion.resultProofsDigest } : {}),
        }
      : {}),
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
  }
}

function walletStateWithProofs(
  proofs: Array<{ id: string; amount: number; secret: string; C: string }>,
) {
  const state = emptyDaemonState()
  state.wallet.proofs.push(
    ...proofs.map((value) => ({
      proof: value,
      mintUrl: 'http://localhost:8086',
      state: 'available' as const,
      asset: { kind: 'sats' as const, baseAsset: 'sat' as const, unit: 'msat' as const },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })),
  )
  return state
}

function proof(secret: string, amount: number) {
  return { id: KEYSET_ID, amount, secret, C: `C-${secret}` }
}
