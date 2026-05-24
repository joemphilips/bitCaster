import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  emptyDaemonState,
  readState,
  recordSwapMessage,
  recordTradeCreated,
  recordTradeStateChanged,
  writeState,
} from '../src/state.ts'

test('TradeHub event records are durable swap state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-events-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const state = emptyDaemonState()
    state.orders['order-1'] = {
      orderId: 'order-1',
      marketId: 'cond-YES',
      status: 'resting',
      ephemeralPubkey: `02${'11'.repeat(32)}`,
      tradeIds: ['trade-1'],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.swaps['trade-1'] = {
      tradeId: 'trade-1',
      marketId: 'cond-YES',
      orderId: 'order-1',
      messages: {},
      step: 'awaiting-trade-created',
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    await writeState(state)

    const created = await recordTradeCreated({
      tradeId: 'trade-1',
      sellerPubkey: `02${'11'.repeat(32)}`,
      buyerPubkey: `03${'22'.repeat(32)}`,
      sellerLocktime: '2026-05-21T00:02:00.000Z',
      buyerLocktime: '2026-05-21T00:01:00.000Z',
      marketId: 'cond-YES',
      outcomeFaceAmountSats: 100,
      quotePaymentSats: 42,
      settlementKind: 'DirectSwap',
    })

    assert.equal(created?.role, 'seller')
    assert.equal(created?.counterpartyPubkey, `03${'22'.repeat(32)}`)
    assert.equal(created?.step, 'opened')

    await recordSwapMessage('trade-1', 'adaptor-point', 'cipher-a')
    await recordSwapMessage('trade-1', 'locked-proofs-seller', 'cipher-b')
    await recordTradeStateChanged('trade-1', 'Settling')

    const persisted = await readState()
    assert.equal(persisted?.orders['order-1'].tradeIds[0], 'trade-1')
    assert.deepEqual(persisted?.swaps['trade-1'].messages, {
      adaptorPoint: 'cipher-a',
      lockedProofsSeller: 'cipher-b',
    })
    assert.equal(persisted?.swaps['trade-1'].engineState, 'Settling')
    assert.equal(persisted?.swaps['trade-1'].step, 'settling')
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('TradeCreated direct match must use the same local order market path', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-events-path-direct-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const state = emptyDaemonState()
    state.orders['order-1'] = {
      orderId: 'order-1',
      marketId: 'cond-YES',
      status: 'resting',
      ephemeralPubkey: `02${'11'.repeat(32)}`,
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    await writeState(state)

    const created = await recordTradeCreated({
      tradeId: 'trade-wrong-market',
      sellerPubkey: `02${'11'.repeat(32)}`,
      buyerPubkey: `03${'22'.repeat(32)}`,
      sellerLocktime: '2026-05-21T00:02:00.000Z',
      buyerLocktime: '2026-05-21T00:01:00.000Z',
      marketId: 'cond-NO',
      outcomeFaceAmountSats: 100,
      quotePaymentSats: 42,
      settlementKind: 'DirectSwap',
    })

    assert.equal(created, null)
    const persisted = await readState()
    assert.equal(persisted?.orders['order-1'].tradeIds.length, 0)
    assert.equal(persisted?.swaps['trade-wrong-market'], undefined)
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('TradeCreated complementary seller matches keep path and buyer matches lock path', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-events-path-complement-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const state = emptyDaemonState()
    state.orders['seller-order'] = {
      orderId: 'seller-order',
      marketId: 'cond-YES',
      status: 'resting',
      ephemeralPubkey: `02${'11'.repeat(32)}`,
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.orders['buyer-order'] = {
      orderId: 'buyer-order',
      marketId: 'cond-NO',
      status: 'matched',
      ephemeralPubkey: `03${'22'.repeat(32)}`,
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    await writeState(state)

    const sellerCreated = await recordTradeCreated({
      tradeId: 'trade-seller',
      sellerPubkey: `02${'11'.repeat(32)}`,
      buyerPubkey: `03${'33'.repeat(32)}`,
      sellerLocktime: '2026-05-21T00:02:00.000Z',
      buyerLocktime: '2026-05-21T00:01:00.000Z',
      marketId: 'cond-NO',
      outcomeFaceAmountSats: 100,
      quotePaymentSats: 42,
      settlementKind: 'ComplementarySplit',
      sellerKeepOutcomeSetId: 'YES',
      sellerLockOutcomeSetId: 'NO',
    })
    const buyerCreated = await recordTradeCreated({
      tradeId: 'trade-buyer',
      sellerPubkey: `02${'33'.repeat(32)}`,
      buyerPubkey: `03${'22'.repeat(32)}`,
      sellerLocktime: '2026-05-21T00:02:00.000Z',
      buyerLocktime: '2026-05-21T00:01:00.000Z',
      marketId: 'cond-NO',
      outcomeFaceAmountSats: 100,
      quotePaymentSats: 42,
      settlementKind: 'ComplementarySplit',
      sellerKeepOutcomeSetId: 'YES',
      sellerLockOutcomeSetId: 'NO',
    })

    assert.equal(sellerCreated?.orderId, 'seller-order')
    assert.equal(sellerCreated?.role, 'seller')
    assert.equal(buyerCreated?.orderId, 'buyer-order')
    assert.equal(buyerCreated?.role, 'buyer')
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('TradeCreated complementary match rejects mismatched keep or lock paths', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-events-path-mismatch-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const state = emptyDaemonState()
    state.orders['seller-order'] = {
      orderId: 'seller-order',
      marketId: 'cond-NO',
      status: 'resting',
      ephemeralPubkey: `02${'11'.repeat(32)}`,
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.orders['buyer-order'] = {
      orderId: 'buyer-order',
      marketId: 'cond-YES',
      status: 'matched',
      ephemeralPubkey: `03${'22'.repeat(32)}`,
      tradeIds: [],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    await writeState(state)

    const sellerCreated = await recordTradeCreated({
      tradeId: 'trade-seller-wrong-path',
      sellerPubkey: `02${'11'.repeat(32)}`,
      buyerPubkey: `03${'33'.repeat(32)}`,
      sellerLocktime: '2026-05-21T00:02:00.000Z',
      buyerLocktime: '2026-05-21T00:01:00.000Z',
      marketId: 'cond-NO',
      outcomeFaceAmountSats: 100,
      quotePaymentSats: 42,
      settlementKind: 'ComplementarySplit',
      sellerKeepOutcomeSetId: 'YES',
      sellerLockOutcomeSetId: 'NO',
    })
    const buyerCreated = await recordTradeCreated({
      tradeId: 'trade-buyer-wrong-path',
      sellerPubkey: `02${'33'.repeat(32)}`,
      buyerPubkey: `03${'22'.repeat(32)}`,
      sellerLocktime: '2026-05-21T00:02:00.000Z',
      buyerLocktime: '2026-05-21T00:01:00.000Z',
      marketId: 'cond-NO',
      outcomeFaceAmountSats: 100,
      quotePaymentSats: 42,
      settlementKind: 'ComplementarySplit',
      sellerKeepOutcomeSetId: 'YES',
      sellerLockOutcomeSetId: 'NO',
    })

    assert.equal(sellerCreated, null)
    assert.equal(buyerCreated, null)
    const persisted = await readState()
    assert.equal(persisted?.orders['seller-order'].tradeIds.length, 0)
    assert.equal(persisted?.orders['buyer-order'].tradeIds.length, 0)
    assert.equal(persisted?.swaps['trade-seller-wrong-path'], undefined)
    assert.equal(persisted?.swaps['trade-buyer-wrong-path'], undefined)
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('concurrent TradeHub events serialize daemon state writes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-events-concurrent-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const state = emptyDaemonState()
    state.orders['order-1'] = {
      orderId: 'order-1',
      marketId: 'cond-YES',
      status: 'resting',
      ephemeralPubkey: `02${'11'.repeat(32)}`,
      tradeIds: ['trade-1'],
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    state.swaps['trade-1'] = {
      tradeId: 'trade-1',
      marketId: 'cond-YES',
      orderId: 'order-1',
      role: 'seller',
      counterpartyPubkey: `03${'22'.repeat(32)}`,
      sellerLocktime: 1_779_389_200,
      buyerLocktime: 1_779_385_600,
      messages: {},
      step: 'opened',
      createdAt: '2026-05-21T00:00:00.000Z',
      updatedAt: '2026-05-21T00:00:00.000Z',
    }
    await writeState(state)

    await Promise.all([
      recordSwapMessage('trade-1', 'adaptor-point', 'cipher-a'),
      recordSwapMessage('trade-1', 'locked-proofs-seller', 'cipher-b'),
      recordSwapMessage('trade-1', 'locked-proofs-buyer', 'cipher-c'),
      recordTradeStateChanged('trade-1', 'Settling'),
    ])

    const persisted = await readState()
    assert.deepEqual(persisted?.swaps['trade-1'].messages, {
      adaptorPoint: 'cipher-a',
      lockedProofsSeller: 'cipher-b',
      lockedProofsBuyer: 'cipher-c',
    })
    assert.equal(persisted?.swaps['trade-1'].engineState, 'Settling')
    assert.equal(persisted?.swaps['trade-1'].step, 'settling')
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})
