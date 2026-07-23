import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { getOrCreateOrderEphemeralKeypair, readSecrets } from '../src/secrets.ts'
import {
  emptyDaemonState,
  ensureState,
  readState,
  updateState,
  writeState,
} from '../src/state.ts'

const walletSeedHex = '11'.repeat(32)
const nostrSecretKeyHex = '22'.repeat(32)

test('target-v1 state round-trips through typed SQLite rows and artifacts', async () => {
  await withProfile(async () => {
    const state = emptyDaemonState()
    state.wallet.proofs.push({
      proof: { amount: 7, secret: 'proof-secret', C: 'proof-signature' },
      mintUrl: 'http://localhost:8086',
      state: 'reserved',
      reservedBy: 'send-1',
      asset: {
        kind: 'outcome',
        conditionId: 'condition-1',
        outcomeSetId: 'YES',
        baseAsset: 'sat',
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
    })
    state.wallet.keysetCounters['keyset-1'] = 9
    state.proofOperations['operation-1'] = {
      operationId: 'operation-1',
      kind: 'ctf-consolidation',
      state: 'completed',
      mintUrl: 'http://localhost:8086',
      inputs: [{ amount: 7, secret: 'proof-secret', C: 'proof-signature' }],
      outputs: {
        send: [{
          blindedMessage: { amount: 7, id: 'keyset-1', B_: 'blind' },
          blindingFactor: 'factor',
          secret: 'output-secret',
        }],
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
      priceSubunits: 42,
      amountSubunits: 100,
      status: 'resting',
      ephemeralPubkey: `02${'44'.repeat(32)}`,
      clientOrderId: 'client-order-1',
      preflightSplit: {
        reservationId: 'reservation-1',
        conditionId: 'condition-1',
        keepOutcomeSetId: 'NO',
        lockOutcomeSetId: 'YES',
        amountSats: 100,
      },
      baseAsset: 'sat',
      divisibility: 100,
      tradeIds: ['trade-placeholder', 'trade-full'],
      engineStatus: { status: 'resting', fills: [{ tradeId: 'trade-full' }] },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
    }
    state.swaps['trade-placeholder'] = {
      tradeId: 'trade-placeholder',
      marketId: 'condition-1-YES',
      orderId: 'order-1',
      messages: {},
      step: 'awaiting-trade-created',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
    }
    state.swaps['trade-recovery'] = {
      tradeId: 'trade-recovery',
      marketId: 'condition-2-NO',
      orderId: 'engine-order-without-local-row',
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
      divisibility: 100,
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
    assert.equal(restored?.wallet.proofs[0].proof.id, undefined)
    assert.equal(restored?.wallet.keysetCounters['keyset-1'], 9)
    assert.equal(restored?.proofOperations['operation-1'].kind, 'ctf-consolidation')
    assert.equal(restored?.orders['order-1'].preflightSplit?.lockOutcomeSetId, 'YES')
    assert.equal(restored?.orders['order-1'].ephemeralPubkey, `02${'44'.repeat(32)}`)
    assert.equal(restored?.swaps['trade-placeholder'].role, undefined)
    assert.equal(
      restored?.swaps['trade-recovery'].orderId,
      'engine-order-without-local-row',
    )
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

test('order upsert preserves its immutable ephemeral key binding', async () => {
  await withProfile(async () => {
    const state = emptyDaemonState()
    state.orders['order-1'] = {
      orderId: 'order-1',
      marketId: 'condition-1-YES',
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

async function withProfile(run: () => Promise<void>): Promise<void> {
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
    await run()
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
}
