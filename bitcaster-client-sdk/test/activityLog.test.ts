import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { components } from '../src/generated/api.ts'
import {
  ACTIVITY_LOG_D_TAG,
  activityItemIdentityKey,
  activityLogsEqual,
  decodeActivityItem,
  decodeActivityItems,
  decodeActivityLogPayload,
  encodeActivityLogPayload,
  mapConfirmedTradeActivities,
  mergeActivityLogs,
  type ActivityItem,
} from '../src/activityLog.ts'

const WALLET_A = 'a'.repeat(64)
const WALLET_B = 'b'.repeat(64)
const context = { walletId: WALLET_A, orderId: 'order-one', marketId: 'condition-YES' }
type OrderStatus = components['schemas']['OrderStatusResponse']

test('built package exposes the shared Activity codec through its public subpath', async () => {
  const sdk = await import('@bitcaster-market/client-sdk/activityLog')
  assert.equal(sdk.ACTIVITY_LOG_D_TAG, 'bitcaster:activity-log')
  assert.deepEqual(sdk.decodeActivityLogPayload(sdk.encodeActivityLogPayload([item()])), [item()])
})

function item(overrides: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id: 'row-one',
    walletId: WALLET_A,
    type: 'deposit',
    amountSubunits: 1_001,
    baseAsset: 'sat',
    date: '2026-10-04T00:00:00.000Z',
    status: 'completed',
    txId: null,
    lightningInvoice: null,
    ...overrides,
  }
}

function fill(overrides: Partial<OrderStatus['fills'][number]> = {}): OrderStatus['fills'][number] {
  return {
    id: 'fill-one',
    takerOrderId: context.orderId,
    makerOrderId: 'maker-one',
    amountSubunits: 2_500,
    executionPrice: 400,
    path: 'Complementary',
    status: 'Filled',
    baseAsset: 'sat',
    divisibility: 1_000,
    quotePaymentSubunits: 1_001,
    outcomeFaceAmountSubunits: 2_500,
    tokenSide: 'Complement',
    filledAt: '2026-10-04T00:00:00.000Z',
    settlementGroup: {
      groupId: 'group-one',
      status: 'Confirmed',
      revision: 2,
      coalescingDeadline: '2026-10-03T23:58:00.000Z',
      frozenAt: '2026-10-03T23:59:00.000Z',
    },
    ...overrides,
  }
}

function order(overrides: Partial<OrderStatus> = {}): OrderStatus {
  return {
    orderId: context.orderId,
    marketId: context.marketId,
    status: 'partially_filled',
    remainingAmountSubunits: 2_500,
    filledAmountSubunits: 2_500,
    fills: [fill()],
    amountSubunits: 5_000,
    outcomeId: 'YES',
    side: 'Buy',
    price: 400,
    placedAt: '2026-10-03T23:57:00.000Z',
    timeInForce: 'FOK',
    expiresAt: null,
    tokenSide: 'Complement',
    baseAsset: 'sat',
    divisibility: 1_000,
    activeSettlementGroup: null,
    ...overrides,
  }
}

test('NIP-78 codec preserves browser envelope, exact msats, and unknown legacy wallet', () => {
  assert.equal(ACTIVITY_LOG_D_TAG, 'bitcaster:activity-log')
  const legacy = {
    id: 'legacy-random-id',
    type: 'withdrawal',
    amountSats: 997,
    baseAsset: 'sat',
    date: '2026-10-03T00:00:00.000Z',
    status: 'completed',
    txId: 'invoice-id',
    lightningInvoice: null,
  }
  const rows = decodeActivityLogPayload(JSON.stringify({ items: [item(), legacy] }))!
  assert.equal(rows[0].amountSubunits, 1_001)
  assert.equal(rows[1].amountSubunits, 997)
  assert.equal(Object.hasOwn(rows[1], 'walletId'), false)
  assert.equal(encodeActivityLogPayload(rows), JSON.stringify({ items: rows }))
  assert.deepEqual(decodeActivityLogPayload(encodeActivityLogPayload(rows)), rows)
})

test('codec drops invalid incoming rows and refuses invalid outgoing rows', () => {
  for (const invalid of [
    { ...item(), type: 'unknown' },
    { ...item(), walletId: 'unknown' },
    { ...item(), amountSubunits: 1.001 },
    { ...item(), amountSubunits: Number.MAX_SAFE_INTEGER + 1 },
    { ...item(), baseAsset: 'usd' },
    { ...item(), status: 'unknown' },
  ]) {
    assert.equal(decodeActivityItem(invalid), null)
    assert.deepEqual(decodeActivityLogPayload(JSON.stringify({ items: [item(), invalid] })), [
      item(),
    ])
    assert.throws(() => encodeActivityLogPayload([invalid as ActivityItem]), /invalid item/)
  }
  for (const malformed of ['null', '[]', '{}', '{"items":null}', '{']) {
    assert.equal(decodeActivityLogPayload(malformed), null)
  }
  assert.deepEqual(decodeActivityItems(null), [])
})

test('merge uses exact row and wallet identities and local precedence without a native history cap', () => {
  const local = item({ marketTitle: 'local title' })
  const remote = item({ marketTitle: 'remote title' })
  const otherWallet = item({ walletId: WALLET_B })
  const otherId = item({ id: 'same-value-other-id' })
  const legacy = item()
  delete legacy.walletId
  const merged = mergeActivityLogs([local], [remote, otherWallet, otherId, legacy])
  assert.deepEqual(merged, [local, otherWallet, otherId, legacy])
  assert.notEqual(activityItemIdentityKey(local), activityItemIdentityKey(otherWallet))
  assert.notEqual(activityItemIdentityKey(local), activityItemIdentityKey(legacy))
  assert.equal(activityLogsEqual(merged, [...merged].reverse()), true)
  assert.equal(activityLogsEqual([local], [remote]), false)
  assert.equal(
    mergeActivityLogs(
      [],
      Array.from({ length: 501 }, (_, i) => item({ id: String(i) })),
    ).length,
    501,
  )
})

test('confirmed fill mapping keeps exact complement payments, face values, order, and stable IDs', () => {
  const second = fill({
    id: 'fill-two',
    takerOrderId: 'another-order',
    makerOrderId: context.orderId,
    quotePaymentSubunits: 997,
    outcomeFaceAmountSubunits: 2_000,
    filledAt: '2026-10-04T00:01:00.000Z',
  })
  const rows = mapConfirmedTradeActivities(
    order({ side: 'Sell', fills: [fill(), second] }),
    context,
  )
  assert.deepEqual(rows, [
    item({
      id: `trade:${WALLET_A}:fill-one`,
      type: 'Sell',
      marketId: context.marketId,
      tradeDetails: {
        orderId: context.orderId,
        fillId: 'fill-one',
        outcomeId: 'YES',
        tokenSide: 'Complement',
        faceAmountSubunits: 2_500,
        divisibility: 1_000,
      },
    }),
    item({
      id: `trade:${WALLET_A}:fill-two`,
      type: 'Sell',
      amountSubunits: 997,
      date: second.filledAt,
      marketId: context.marketId,
      tradeDetails: {
        orderId: context.orderId,
        fillId: 'fill-two',
        outcomeId: 'YES',
        tokenSide: 'Complement',
        faceAmountSubunits: 2_000,
        divisibility: 1_000,
      },
    }),
  ])
  assert.deepEqual(decodeActivityLogPayload(encodeActivityLogPayload(rows)), rows)
  assert.equal(mergeActivityLogs(rows, rows).length, 2)
  const anotherWallet = mapConfirmedTradeActivities(order(), { ...context, walletId: WALLET_B })
  assert.equal(mergeActivityLogs(rows, anotherWallet).length, 3)
})

test('mapper rejects unconfirmed, foreign, mismatched, and invalid exact fill facts', () => {
  const invalidFills: Partial<OrderStatus['fills'][number]>[] = [
    { status: 'Matched' },
    { status: 'Failed' },
    { takerOrderId: 'foreign-one', makerOrderId: 'foreign-two' },
    { divisibility: 1_000_000 },
    { tokenSide: 'Outcome' },
    { quotePaymentSubunits: -1 },
    { quotePaymentSubunits: 1.001 },
    { outcomeFaceAmountSubunits: 0 },
    { outcomeFaceAmountSubunits: Number.MAX_SAFE_INTEGER + 1 },
    { filledAt: 'unknown' },
  ]
  for (const invalid of invalidFills) {
    assert.deepEqual(mapConfirmedTradeActivities(order({ fills: [fill(invalid)] }), context), [])
  }
  assert.deepEqual(mapConfirmedTradeActivities(order({ orderId: 'foreign' }), context), [])
  assert.deepEqual(mapConfirmedTradeActivities(order({ marketId: 'condition-NO' }), context), [])
  assert.deepEqual(mapConfirmedTradeActivities(order(), { ...context, walletId: 'unknown' }), [])
  assert.deepEqual(mapConfirmedTradeActivities(order(), { ...context, orderId: ' order-one' }), [])
})

test('confirmed-fill decoder rejects false identity and invalid exact trade details', () => {
  const trade = mapConfirmedTradeActivities(order(), context)[0]
  for (const invalid of [
    { ...trade, id: 'random-id' },
    { ...trade, walletId: WALLET_B },
    { ...trade, status: 'pending' },
    { ...trade, type: 'deposit' },
    { ...trade, tradeDetails: { ...trade.tradeDetails!, orderId: ' order-one' } },
    { ...trade, tradeDetails: { ...trade.tradeDetails!, tokenSide: 'unknown' } },
    { ...trade, tradeDetails: { ...trade.tradeDetails!, divisibility: 100 } },
  ]) {
    assert.equal(decodeActivityItem(invalid), null)
  }
})
