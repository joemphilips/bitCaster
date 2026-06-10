import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildTradeTicket, TradeTicketError } from '../src/tradeTicket.ts'
import type { SdkMarketForTrading, SdkOrderBook } from '../src/types.ts'

const yesNoMarket: SdkMarketForTrading = {
  id: 'condition-yesno',
  type: 'yesno',
  outcomes: [
    { id: 'yes', label: 'Yes' },
    { id: 'no', label: 'No' },
  ],
}

const categoricalMarket: SdkMarketForTrading = {
  id: 'condition-category',
  type: 'categorical',
  outcomes: [
    { id: 'alice', label: 'Alice' },
    { id: 'bob', label: 'Bob' },
    { id: 'carol', label: 'Carol' },
  ],
}

const liquidBook: SdkOrderBook = {
  bids: [{ price: 47, amount: 100, total: 100 }],
  asks: [{ price: 53, amount: 100, total: 100 }],
  spread: 6,
}

test('buildTradeTicket builds limit orders with oracle-verbatim YES outcome names', () => {
  const ticket = buildTradeTicket({
    market: yesNoMarket,
    selection: { side: 'yes' },
    amountSats: 100,
    side: 'buy',
    orderType: 'limit',
    limitPrice: 50,
    orderBook: liquidBook,
  })

  assert.equal(ticket.marketId, 'condition-yesno-Yes')
  assert.deepEqual(ticket.request, {
    outcomeId: 'Yes',
    tokenSide: 'Outcome',
    side: 'Buy',
    price: 50,
    amountSats: 100,
    timeInForce: 'GTC',
  })
})

test('buildTradeTicket builds categorical NO tickets on primitive route with complement token side', () => {
  const ticket = buildTradeTicket({
    market: categoricalMarket,
    selection: { side: 'no', outcomeId: 'alice' },
    amountSats: 100,
    side: 'buy',
    orderType: 'limit',
    limitPrice: 45,
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
    amountSats: 100,
    side: 'buy',
    orderType: 'limit',
    limitPrice: 45,
    orderBook: liquidBook,
  })

  assert.equal(ticket.marketId, 'condition-category-Alice')
  assert.equal(ticket.request.outcomeId, 'Alice')
  assert.equal(ticket.request.tokenSide, 'Complement')
})

test('buildTradeTicket prices executable market buys as aggressive FAK orders', () => {
  const directTicket = buildTradeTicket({
    market: yesNoMarket,
    selection: { side: 'no' },
    amountSats: 100,
    side: 'buy',
    orderType: 'market',
    limitPrice: 50,
    orderBook: liquidBook,
    complementaryOrderBook: { bids: [{ price: 49, amount: 100 }], asks: [], spread: 0 },
  })
  assert.equal(directTicket.request.price, 99)
  assert.equal(directTicket.request.timeInForce, 'FAK')

  const complementaryTicket = buildTradeTicket({
    market: yesNoMarket,
    selection: { side: 'no' },
    amountSats: 100,
    side: 'buy',
    orderType: 'market',
    limitPrice: 50,
    orderBook: { bids: [], asks: [], spread: 0 },
    complementaryOrderBook: { bids: [{ price: 49, amount: 100 }], asks: [], spread: 0 },
  })
  assert.equal(complementaryTicket.request.price, 99)
  assert.equal(complementaryTicket.request.timeInForce, 'FAK')
})

test('buildTradeTicket applies market divisibility to price and amount validation', () => {
  const ticket = buildTradeTicket({
    market: { ...yesNoMarket, divisibility: 1_000 },
    selection: { side: 'yes' },
    amountSats: 2_000,
    side: 'buy',
    orderType: 'market',
    limitPrice: 50,
    orderBook: liquidBook,
  })
  assert.equal(ticket.request.price, 999)

  assert.throws(
    () =>
      buildTradeTicket({
        market: { ...yesNoMarket, divisibility: 1_000 },
        selection: { side: 'yes' },
        amountSats: 1_500,
        side: 'buy',
        orderType: 'limit',
        limitPrice: 50,
        orderBook: liquidBook,
      }),
    /1000 sub-unit increments/,
  )
})

test('buildTradeTicket rejects market orders with no liquidity instead of price zero', () => {
  assert.throws(
    () =>
      buildTradeTicket({
        market: yesNoMarket,
        selection: { side: 'yes' },
        amountSats: 100,
        side: 'buy',
        orderType: 'market',
        limitPrice: 50,
        orderBook: { bids: [], asks: [], spread: 0 },
      }),
    (error) =>
      error instanceof TradeTicketError &&
      error.code === 'no-market-liquidity',
  )
})

test('buildTradeTicket builds direct sell orders after same-outcome CTF swaps are supported', () => {
  const ticket = buildTradeTicket({
    market: yesNoMarket,
    selection: { side: 'yes' },
    amountSats: 100,
    side: 'sell',
    orderType: 'limit',
    limitPrice: 50,
    orderBook: liquidBook,
  })

  assert.equal(ticket.marketId, 'condition-yesno-Yes')
  assert.deepEqual(ticket.request, {
    outcomeId: 'Yes',
    tokenSide: 'Outcome',
    side: 'Sell',
    price: 50,
    amountSats: 100,
    timeInForce: 'GTC',
  })
})
