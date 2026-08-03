import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from '@bitcaster-market/client-sdk'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'
import { openDaemonStateSqlite } from '../src/stateSqlite.ts'
import { getOrCreateOrderEphemeralKeypair, readSecrets } from '../src/secrets.ts'
import {
  advanceDaemonKeysetCounter,
  emptyDaemonState,
  ensureState,
  markProofOperationCompletedFenced,
  prepareProofOperationWithExactReservation,
  readAvailableWalletProofGroupPage,
  readAvailableWalletProofPage,
  readDaemonKeysetCounters,
  readState,
  reserveDaemonKeysetCounter,
  updateState,
  writeState,
  type FencedStateMutation,
  type ProofOperationRecord,
} from '../src/state.ts'

const walletSeedHex = '11'.repeat(64)
const nostrSecretKeyHex = '22'.repeat(32)

test('target-v1 state round-trips through typed SQLite rows and artifacts', async () => {
  await withProfile(async () => {
    const state = emptyDaemonState()
    state.wallet.proofs.push({
      proof: { id: 'keyset-1', amount: 7, secret: 'proof-secret', C: 'proof-signature' },
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
            blindedMessage: { amount: 7, id: 'keyset-1', B_: 'blind' },
            blindingFactor: 'factor',
            secret: 'output-secret',
          },
        ],
      },
      metadata: { conditionId: 'condition-1', attempt: 2 },
      resultProofs: {
        send: [{ id: 'keyset-1', amount: 7, secret: 'result-secret', C: 'result-signature' }],
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
      ephemeralPubkey: `02${'44'.repeat(32)}`,
      clientOrderId: 'client-order-1',
      preflightSplit: {
        reservationId: 'reservation-1',
        conditionId: 'condition-1',
        keepOutcomeSetId: 'NO',
        lockOutcomeSetId: 'YES',
        amountSubunits: 100,
      },
      baseAsset: 'sat',
      divisibility: 10_000,
      tradeIds: ['trade-placeholder', 'trade-full'],
      engineStatus: { status: 'resting', fills: [{ tradeId: 'trade-full' }] },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
    }
    state.swaps['trade-placeholder'] = {
      tradeId: 'trade-placeholder',
      marketId: 'condition-1-YES',
      orderId: 'order-1',
      baseAsset: 'sat',
      divisibility: 10_000,
      messages: {},
      step: 'awaiting-trade-created',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
    }
    state.swaps['trade-recovery'] = {
      tradeId: 'trade-recovery',
      marketId: 'condition-2-NO',
      orderId: 'engine-order-without-local-row',
      baseAsset: 'sat',
      divisibility: 10_000,
      messages: {},
      step: 'awaiting-trade-created',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
    }
    state.swaps['trade-full'] = {
      tradeId: 'trade-full',
      marketId: 'condition-1-YES',
      orderId: 'order-1',
      role: 'seller',
      counterpartyPubkey: `03${'33'.repeat(32)}`,
      sellerLocktime: 120,
      buyerLocktime: 60,
      fillAmountSats: 1,
      fillAmountSubunits: 100,
      outcomeFaceAmountSats: 2,
      outcomeFaceAmountSubunits: 200,
      quotePaymentSats: 1,
      quotePaymentSubunits: 42,
      baseAsset: 'sat',
      divisibility: 10_000,
      settlementKind: 'DirectSwap',
      messages: {
        adaptorPoint: 'cipher-a',
        lockedProofsSeller: 'cipher-b',
        lockedProofsBuyer: 'cipher-c',
      },
      sellerAdaptorSecretHex: 'aa',
      sellerAdaptorPointHex: 'bb',
      buyerPreSigsHex: ['cc'],
      buyerLockedProofs: [{ amount: 2, secret: 'locked', C: 'locked-signature' }],
      sellerPreSigsHex: ['dd'],
      engineState: 'Settling',
      step: 'settling',
      error: 'retrying',
      failure: { kind: 'partial-lock-held', reason: 'test' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
    }

    await writeState(state)
    const restored = await readState()
    assert.equal(restored?.wallet.proofs[0].proof.id, 'keyset-1')
    assert.deepEqual(restored?.wallet.keysetCounters, {})
    assert.equal(restored?.proofOperations['operation-1'].kind, 'ctf-consolidation')
    assert.equal(restored?.orders['order-1'].preflightSplit?.lockOutcomeSetId, 'YES')
    assert.equal(restored?.orders['order-1'].ephemeralPubkey, `02${'44'.repeat(32)}`)
    assert.equal(restored?.swaps['trade-placeholder'].role, undefined)
    assert.equal(restored?.swaps['trade-recovery'].orderId, 'engine-order-without-local-row')
    assert.equal(restored?.swaps['trade-full'].fillAmountSats, 1)
    assert.equal(restored?.swaps['trade-full'].fillAmountSubunits, 100)
    assert.equal(restored?.swaps['trade-full'].messages.lockedProofsBuyer, 'cipher-c')
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

test('keyset counter rows reserve adjacent ranges and advance monotonically', async () => {
  await withProfile(async (home) => {
    const mutation = await claimMutation(home, 'counter-ranges')
    assert.deepEqual(await reserveDaemonKeysetCounter('untouched-keyset', 0, mutation), {
      start: 0,
      count: 0,
    })
    assert.deepEqual(await readDaemonKeysetCounters(), {})
    assert.deepEqual(await reserveDaemonKeysetCounter('legacy-keyset', 2, mutation), {
      start: 0,
      count: 2,
    })
    assert.deepEqual(await reserveDaemonKeysetCounter('legacy-keyset', 3, mutation), {
      start: 2,
      count: 3,
    })
    assert.deepEqual(await reserveDaemonKeysetCounter('legacy-keyset', 0, mutation), {
      start: 5,
      count: 0,
    })
    await advanceDaemonKeysetCounter('legacy-keyset', 8, mutation)
    await advanceDaemonKeysetCounter('legacy-keyset', 6, mutation)
    assert.deepEqual(await reserveDaemonKeysetCounter('legacy-keyset', 1, mutation), {
      start: 8,
      count: 1,
    })
    assert.deepEqual(await reserveDaemonKeysetCounter('maximum-batch', 256, mutation), {
      start: 0,
      count: 256,
    })
    const concurrent = await Promise.all([
      reserveDaemonKeysetCounter('concurrent-keyset', 1, mutation),
      reserveDaemonKeysetCounter('concurrent-keyset', 1, mutation),
      reserveDaemonKeysetCounter('concurrent-keyset', 1, mutation),
    ])
    assert.deepEqual(
      concurrent.map(({ start }) => start).sort((left, right) => left - right),
      [0, 1, 2],
    )
    assert.deepEqual(await readDaemonKeysetCounters(), {
      'concurrent-keyset': 3,
      'legacy-keyset': 9,
      'maximum-batch': 256,
    })
  })
})

test('keyset counter rows reject invalid ranges and immutable-row mutation', async () => {
  await withProfile(async (home) => {
    const mutation = await claimMutation(home, 'counter-bounds')
    for (const count of [-1, 1.5, 257, Number.MAX_SAFE_INTEGER]) {
      await assert.rejects(
        () => reserveDaemonKeysetCounter('legacy-keyset', count, mutation),
        /input is invalid/,
      )
    }
    for (const keysetId of ['', 'x'.repeat(1_025)]) {
      await assert.rejects(
        () => reserveDaemonKeysetCounter(keysetId, 1, mutation),
        /input is invalid/,
      )
      await assert.rejects(
        () => advanceDaemonKeysetCounter(keysetId, 1, mutation),
        /input is invalid/,
      )
    }
    await advanceDaemonKeysetCounter('last-usable-keyset', 2_147_483_647, mutation)
    assert.deepEqual(await reserveDaemonKeysetCounter('last-usable-keyset', 1, mutation), {
      start: 2_147_483_647,
      count: 1,
    })
    await advanceDaemonKeysetCounter('legacy-keyset', 2_147_483_648, mutation)
    await assert.rejects(
      () => reserveDaemonKeysetCounter('legacy-keyset', 1, mutation),
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
    await reserveDaemonKeysetCounter('legacy-keyset', 2, stale)
    const successorFence = await claimCustodyScopeLease(home, {
      scopeId: stale.fence.scopeId,
      incarnationId: 'counter-successor-owner',
      observedAtMs: stale.fence.leaseExpiresAtMs,
    })
    await assert.rejects(
      () => reserveDaemonKeysetCounter('legacy-keyset', 1, stale),
      /stale or expired authority/,
    )
    await assert.rejects(
      () => advanceDaemonKeysetCounter('legacy-keyset', 8, stale),
      /stale or expired authority/,
    )
    const current: FencedStateMutation = {
      fence: successorFence,
      observedAtMs: successorFence.leaseExpiresAtMs,
    }
    assert.deepEqual(await reserveDaemonKeysetCounter('legacy-keyset', 1, current), {
      start: 2,
      count: 1,
    })
    await advanceDaemonKeysetCounter('legacy-keyset', 8, current)
    assert.equal((await readDaemonKeysetCounters())['legacy-keyset'], 8)
  })
})

test('whole-state rewrites preserve monotonic counter rows and unrelated proof rows', async () => {
  await withProfile(async (home) => {
    const mutation = await claimMutation(home, 'counter-state-rewrite')
    const state = emptyDaemonState()
    state.wallet.proofs.push({
      proof: { id: 'legacy-keyset', amount: 1, secret: 'preserved-secret', C: 'preserved-C' },
      mintUrl: 'http://localhost:8086',
      state: 'available',
      asset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    state.proofOperations['preserved-operation'] = preservedProofOperation()
    await writeState(state)
    await reserveDaemonKeysetCounter('legacy-keyset', 9, mutation)
    assert.equal((await readState())?.proofOperations['preserved-operation']?.state, 'completed')
    const rewrite = emptyDaemonState()
    rewrite.wallet.keysetCounters['legacy-keyset'] = 4
    rewrite.wallet.proofs = state.wallet.proofs
    await writeState(rewrite)
    assert.equal((await readState())?.wallet.proofs[0]?.proof.secret, 'preserved-secret')
    assert.equal((await readDaemonKeysetCounters())['legacy-keyset'], 9)
  })
})

test('wallet proof selection pages and exact reservation stay row-scoped', async () => {
  await withProfile(async (home) => {
    const state = emptyDaemonState()
    for (let index = 0; index < 300; index += 1) {
      state.wallet.proofs.push({
        proof: {
          id: 'keyset-page',
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
      keysetId: 'keyset-page',
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

    const second = await readAvailableWalletProofPage({
      mintUrl: 'http://localhost:8086',
      keysetId: 'keyset-page',
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

test('available proof groups page without loading proof bodies', async () => {
  await withProfile(async () => {
    const state = emptyDaemonState()
    for (let index = 0; index < 10_000; index += 1) {
      state.wallet.proofs.push({
        proof: {
          id: 'regular-keyset',
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
        id: 'conditional-keyset',
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
      proof: { id: 'keyset-1', amount: 1, secret: 'proof-secret', C: 'proof-signature' },
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
      divisibility: 10_000,
      status: 'resting',
      tradeIds: [],
      createdAt: '2026-01-01T00:00:01.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    state.swaps['trade-1'] = {
      tradeId: 'trade-1',
      baseAsset: 'sat',
      divisibility: 10_000,
      messages: {},
      step: 'awaiting-trade-created',
      createdAt: '2026-01-01T00:00:01.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }

    await writeState(state)
    state.orders['order-1'].createdAt = '2025-01-01T00:00:01.000Z'
    state.orders['order-1'].updatedAt = '2025-01-01T00:00:01.000Z'
    state.swaps['trade-1'].createdAt = '2025-01-01T00:00:01.000Z'
    state.swaps['trade-1'].updatedAt = '2025-01-01T00:00:01.000Z'
    await writeState(state)
    const restored = await readState()

    assert.equal(restored?.wallet.proofs[0].updatedAt, restored?.wallet.proofs[0].createdAt)
    assert.equal(
      restored?.proofOperations['operation-1'].updatedAt,
      restored?.proofOperations['operation-1'].createdAt,
    )
    assert.equal(restored?.orders['order-1'].updatedAt, restored?.orders['order-1'].createdAt)
    assert.equal(restored?.swaps['trade-1'].updatedAt, restored?.swaps['trade-1'].createdAt)
  })
})

test('order upsert preserves its immutable ephemeral key binding', async () => {
  await withProfile(async () => {
    const state = emptyDaemonState()
    state.orders['order-1'] = {
      orderId: 'order-1',
      marketId: 'condition-1-YES',
      baseAsset: 'sat',
      divisibility: 10_000,
      status: 'resting',
      tradeIds: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    await writeState(state)
    await getOrCreateOrderEphemeralKeypair({
      keyId: 'trade-1',
      orderId: 'order-1',
      tradeId: 'trade-1',
      marketId: 'condition-1-YES',
    })
    await updateState((current, now) => {
      current.orders['order-1'].status = 'partially-filled'
      current.orders['order-1'].updatedAt = now
    })
    await writeState((await readState())!)

    assert.equal((await readState())?.orders['order-1'].status, 'partially-filled')
    assert.ok((await readSecrets())?.orderEphemeralKeys['trade-1'])
  })
})

test('recovery key retains its exact order binding without a local order row', async () => {
  await withProfile(async () => {
    await getOrCreateOrderEphemeralKeypair({
      keyId: 'trade-orphan-key',
      orderId: 'engine-order-without-local-row',
      tradeId: 'trade-orphan-key',
      marketId: 'condition-2-NO',
    })

    const key = (await readSecrets())?.orderEphemeralKeys['trade-orphan-key']
    assert.equal(key?.orderId, 'engine-order-without-local-row')
    assert.equal(key?.tradeId, 'trade-orphan-key')
  })
})

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
          blindedMessage: { amount: 1, id: 'legacy-keyset', B_: 'preserved-blind' },
          blindingFactor: 'preserved-factor',
          secret: 'preserved-output-secret',
        },
      ],
    },
    metadata: { conditionId: 'condition-1', attempt: 1 },
    resultProofs: {
      send: [
        {
          id: 'legacy-keyset',
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
