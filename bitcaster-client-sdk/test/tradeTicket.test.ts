import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildTradeTicket } from '../src/tradeTicket.ts'
import type { SdkMarketForTrading, SdkOrderBook } from '../src/types.ts'

const yesNoMarket: SdkMarketForTrading = {
  id: 'condition-yesno',
  type: 'yesno',
  baseAsset: 'sat',
  divisibility: 1_000,
  outcomes: [
    { id: 'yes', label: 'Yes' },
    { id: 'no', label: 'No' },
  ],
}

const categoricalMarket: SdkMarketForTrading = {
  id: 'condition-category',
  type: 'categorical',
  baseAsset: 'sat',
  divisibility: 1_000,
  outcomes: [
    { id: 'alice', label: 'Alice' },
    { id: 'bob', label: 'Bob' },
    { id: 'carol', label: 'Carol' },
  ],
}

const liquidBook: SdkOrderBook = {
  bids: [{ price: 470, amount: 1_000_000, total: 1_000_000 }],
  asks: [{ price: 530, amount: 1_000_000, total: 1_000_000 }],
  spread: 60,
}

test('buildTradeTicket builds limit orders with oracle-verbatim YES outcome names as FOK', () => {
  const ticket = buildTradeTicket({
    market: yesNoMarket,
    selection: { side: 'yes' },
    amountSubunits: 1_000_000,
    side: 'Buy',
    orderType: 'limit',
    limitPrice: 500,
    orderBook: liquidBook,
  })

  assert.equal(ticket.marketId, 'condition-yesno-Yes')
  assert.deepEqual(ticket.request, {
    outcomeId: 'Yes',
    tokenSide: 'Outcome',
    side: 'Buy',
    price: 500,
    amountSubunits: 1_000_000,
    timeInForce: 'FOK',
  })
})

test('buildTradeTicket builds categorical NO tickets on primitive route with complement token side', () => {
  const ticket = buildTradeTicket({
    market: categoricalMarket,
    selection: { side: 'no', outcomeId: 'alice' },
    amountSubunits: 1_000_000,
    side: 'Buy',
    orderType: 'limit',
    limitPrice: 450,
    orderBook: liquidBook,
  })

  assert.equal(ticket.marketId, `${categoricalMarket.id}-Alice`)
  assert.equal(ticket.request.outcomeId, 'Alice')
  assert.equal(ticket.request.tokenSide, 'Complement')
})

test('buildTradeTicket builds two-outcome categorical NO tickets against a primitive complement', () => {
  const ticket = buildTradeTicket({
    market: {
      ...categoricalMarket,
      outcomes: [
        { id: 'alice', label: 'Alice' },
        { id: 'bob', label: 'Bob' },
      ],
    },
    selection: { side: 'no', outcomeId: 'alice' },
    amountSubunits: 1_000_000,
    side: 'Buy',
    orderType: 'limit',
    limitPrice: 450,
    orderBook: liquidBook,
  })

  assert.equal(ticket.marketId, 'condition-category-Alice')
  assert.equal(ticket.request.outcomeId, 'Alice')
  assert.equal(ticket.request.tokenSide, 'Complement')
})

test('buildTradeTicket prices market FOK orders without local book liquidity', () => {
  const scenarios = [
    { side: 'Buy', expectedPrice: 999 },
    { side: 'Buy', expectedPrice: 999, orderBook: { bids: [], asks: [], spread: 0 } },
    { side: 'Buy', expectedPrice: 999, orderBook: liquidBook },
    {
      side: 'Buy',
      expectedPrice: 999,
      orderBook: { bids: [], asks: [], spread: 0 },
      complementaryOrderBook: { bids: [{ price: 490, amount: 1_000_000 }], asks: [], spread: 0 },
    },
    { side: 'Sell', expectedPrice: 1 },
    { side: 'Sell', expectedPrice: 1, orderBook: { bids: [], asks: [], spread: 0 } },
    { side: 'Sell', expectedPrice: 1, orderBook: liquidBook },
    {
      side: 'Sell',
      expectedPrice: 1,
      orderBook: { bids: [], asks: [], spread: 0 },
      complementaryOrderBook: { bids: [{ price: 490, amount: 1_000_000 }], asks: [], spread: 0 },
    },
  ] as const

  for (const { expectedPrice, ...scenario } of scenarios) {
    const ticket = buildTradeTicket({
      market: yesNoMarket,
      selection: { side: 'no' },
      amountSubunits: 1_000_000,
      orderType: 'market',
      limitPrice: 500,
      ...scenario,
    })
    assert.equal(ticket.marketId, 'condition-yesno-Yes')
    assert.equal(ticket.request.outcomeId, 'Yes')
    assert.equal(ticket.request.tokenSide, 'Complement')
    assert.equal(ticket.request.price, expectedPrice)
    assert.equal(ticket.request.timeInForce, 'FOK')
  }
})

test('buildTradeTicket applies market divisibility to price and amount validation', () => {
  const ticket = buildTradeTicket({
    market: { ...yesNoMarket, divisibility: 1_000_000 },
    selection: { side: 'yes' },
    amountSubunits: 2_000_000,
    side: 'Buy',
    orderType: 'market',
    limitPrice: 50,
    orderBook: liquidBook,
  })
  assert.equal(ticket.request.price, 999_999)

  assert.throws(
    () =>
      buildTradeTicket({
        market: { ...yesNoMarket, divisibility: 1_000_000 },
        selection: { side: 'yes' },
        amountSubunits: 1_000_001,
        side: 'Buy',
        orderType: 'limit',
        limitPrice: 50,
        orderBook: liquidBook,
      }),
    /1000000 sub-unit increments/,
  )
})

test('buildTradeTicket rejects unsupported product units', () => {
  assert.throws(
    () =>
      buildTradeTicket({
        market: {
          ...yesNoMarket,
          baseAsset: 'usd',
          divisibility: 1_000,
        } as unknown as SdkMarketForTrading,
        selection: { side: 'yes' },
        amountSubunits: 1_000,
        side: 'Buy',
        orderType: 'limit',
        limitPrice: 500,
        orderBook: liquidBook,
      }),
    /unsupported base asset/,
  )
})

test('buildTradeTicket rejects invalid amount and missing selection independently of book state', () => {
  assert.throws(
    () =>
      buildTradeTicket({
        market: yesNoMarket,
        selection: null,
        amountSubunits: 1_000,
        side: 'Buy',
        orderType: 'limit',
        limitPrice: 500,
        orderBook: undefined,
      }),
    /Choose an outcome/,
  )
  assert.throws(
    () =>
      buildTradeTicket({
        market: yesNoMarket,
        selection: { side: 'yes' },
        amountSubunits: 500,
        side: 'Buy',
        orderType: 'market',
        limitPrice: 500,
        orderBook: undefined,
      }),
    /1000 sub-unit increments/,
  )
})

test('buildTradeTicket builds direct sell orders after same-outcome CTF swaps are supported', () => {
  const ticket = buildTradeTicket({
    market: yesNoMarket,
    selection: { side: 'yes' },
    amountSubunits: 1_000_000,
    side: 'Sell',
    orderType: 'limit',
    limitPrice: 500,
    orderBook: liquidBook,
  })

  assert.equal(ticket.marketId, 'condition-yesno-Yes')
  assert.deepEqual(ticket.request, {
    outcomeId: 'Yes',
    tokenSide: 'Outcome',
    side: 'Sell',
    price: 500,
    amountSubunits: 1_000_000,
    timeInForce: 'FOK',
  })
})
