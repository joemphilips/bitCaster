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
  bids: [{ price: 4_700, amount: 1_000_000, total: 1_000_000 }],
  asks: [{ price: 5_300, amount: 1_000_000, total: 1_000_000 }],
  spread: 600,
}

test('buildTradeTicket builds limit orders with oracle-verbatim YES outcome names', () => {
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
    timeInForce: 'GTC',
  })
})

test('buildTradeTicket builds categorical NO tickets on primitive route with complement token side', () => {
  const ticket = buildTradeTicket({
    market: categoricalMarket,
    selection: { side: 'no', outcomeId: 'alice' },
    amountSubunits: 1_000_000,
    side: 'Buy',
    orderType: 'limit',
    limitPrice: 4_500,
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
    limitPrice: 4_500,
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
    amountSubunits: 1_000_000,
    side: 'Buy',
    orderType: 'market',
    limitPrice: 500,
    orderBook: liquidBook,
    complementaryOrderBook: { bids: [{ price: 4_900, amount: 1_000_000 }], asks: [], spread: 0 },
  })
  assert.equal(directTicket.marketId, 'condition-yesno-Yes')
  assert.equal(directTicket.request.outcomeId, 'Yes')
  assert.equal(directTicket.request.tokenSide, 'Complement')
  assert.equal(directTicket.request.price, 9999)
  assert.equal(directTicket.request.timeInForce, 'FAK')

  const complementaryTicket = buildTradeTicket({
    market: yesNoMarket,
    selection: { side: 'no' },
    amountSubunits: 1_000_000,
    side: 'Buy',
    orderType: 'market',
    limitPrice: 500,
    orderBook: { bids: [], asks: [], spread: 0 },
    complementaryOrderBook: { bids: [{ price: 4_900, amount: 1_000_000 }], asks: [], spread: 0 },
  })
  assert.equal(complementaryTicket.marketId, 'condition-yesno-Yes')
  assert.equal(complementaryTicket.request.outcomeId, 'Yes')
  assert.equal(complementaryTicket.request.tokenSide, 'Complement')
  assert.equal(complementaryTicket.request.price, 9999)
  assert.equal(complementaryTicket.request.timeInForce, 'FAK')
})

test('buildTradeTicket applies market divisibility to price and amount validation', () => {
  const ticket = buildTradeTicket({
    market: { ...yesNoMarket, divisibility: 1_000 },
    selection: { side: 'yes' },
    amountSubunits: 2_000,
    side: 'Buy',
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
        amountSubunits: 1_501,
        side: 'Buy',
        orderType: 'limit',
        limitPrice: 50,
        orderBook: liquidBook,
      }),
    /1000 sub-unit increments/,
  )
})

test('buildTradeTicket validates amount by market divisibility share face', () => {
  const ticket = buildTradeTicket({
    market: { ...yesNoMarket, baseAsset: 'usd', divisibility: 1_000 },
    selection: { side: 'yes' },
    amountSubunits: 1_000,
    side: 'Buy',
    orderType: 'limit',
    limitPrice: 500,
    orderBook: liquidBook,
  })
  assert.equal(ticket.request.amountSubunits, 1_000)

  assert.throws(
    () =>
      buildTradeTicket({
        market: { ...yesNoMarket, baseAsset: 'usd', divisibility: 1_000 },
        selection: { side: 'yes' },
        amountSubunits: 1_001,
        side: 'Buy',
        orderType: 'limit',
        limitPrice: 500,
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
        amountSubunits: 1_000_000,
        side: 'Buy',
        orderType: 'market',
        limitPrice: 500,
        orderBook: { bids: [], asks: [], spread: 0 },
      }),
    (error) => error instanceof TradeTicketError && error.code === 'no-market-liquidity',
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
    timeInForce: 'GTC',
  })
})
