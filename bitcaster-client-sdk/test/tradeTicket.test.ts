import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildProtectedTradeTicket, buildTradeTicket } from '../src/tradeTicket.ts'
import type { PreviewFokOrderRequest } from '../src/fokOrderPreview.ts'
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

function previewRequest(ticket: ReturnType<typeof buildTradeTicket>): PreviewFokOrderRequest {
  return {
    marketId: ticket.marketId,
    side: ticket.request.side,
    tokenSide: ticket.request.tokenSide,
    price: ticket.request.price,
    faceAmountSubunits: ticket.request.amountSubunits,
  }
}

function fillablePreview(overrides: Record<string, unknown> = {}) {
  return {
    fullFillAvailable: true,
    reason: 'fillable',
    previewRevision: 'revision-1',
    quotePaymentSubunits: 500_000,
    averagePrice: 500,
    worstPrice: 600,
    currentLatestTradePrice: 500,
    projectedFinalPrice: 500,
    priceDenominator: 1_000,
    subsidyMayHelp: false,
    ...overrides,
  }
}

test('buildProtectedTradeTicket uses the selected-token worst price for Buy and Sell', () => {
  const buy = buildTradeTicket({
    market: yesNoMarket,
    selection: { side: 'yes' },
    amountSubunits: 1_000,
    side: 'Buy',
    orderType: 'market',
    limitPrice: 500,
  })
  const protectedBuy = buildProtectedTradeTicket({
    ticket: buy,
    previewRequest: previewRequest(buy),
    previewResponse: fillablePreview({
      averagePrice: 550,
      worstPrice: 600,
      projectedFinalPrice: 550,
    }),
  })
  assert.equal(protectedBuy.request.price, 600)

  const sell = buildTradeTicket({
    market: yesNoMarket,
    selection: { side: 'yes' },
    amountSubunits: 1_000,
    side: 'Sell',
    orderType: 'market',
    limitPrice: 500,
  })
  const protectedSell = buildProtectedTradeTicket({
    ticket: sell,
    previewRequest: previewRequest(sell),
    previewResponse: fillablePreview({
      averagePrice: 700,
      worstPrice: 650,
      projectedFinalPrice: 700,
    }),
  })
  assert.equal(protectedSell.request.price, 650)
})

test('buildProtectedTradeTicket does not complement a Complement preview price', () => {
  const ticket = buildTradeTicket({
    market: yesNoMarket,
    selection: { side: 'no' },
    amountSubunits: 1_000,
    side: 'Buy',
    orderType: 'market',
    limitPrice: 500,
  })
  const protectedTicket = buildProtectedTradeTicket({
    ticket,
    previewRequest: previewRequest(ticket),
    previewResponse: fillablePreview({
      averagePrice: 420,
      worstPrice: 430,
      currentLatestTradePrice: 580,
      projectedFinalPrice: 570,
    }),
  })

  assert.equal(protectedTicket.request.tokenSide, 'Complement')
  assert.equal(protectedTicket.request.price, 430)
})

test('buildProtectedTradeTicket preserves an explicit previewed price bound', () => {
  const ticket = buildTradeTicket({
    market: yesNoMarket,
    selection: { side: 'yes' },
    amountSubunits: 1_000,
    side: 'Buy',
    orderType: 'limit',
    limitPrice: 700,
  })
  const original = structuredClone(ticket)
  const protectedTicket = buildProtectedTradeTicket({
    ticket,
    previewRequest: previewRequest(ticket),
    previewResponse: fillablePreview({
      averagePrice: 550,
      worstPrice: 600,
      projectedFinalPrice: 550,
    }),
    priceOverride: 700,
  })

  assert.equal(protectedTicket.request.price, 700)
  assert.deepEqual(ticket, original)
  assert.notStrictEqual(protectedTicket, ticket)
  assert.notStrictEqual(protectedTicket.request, ticket.request)
})

test('buildProtectedTradeTicket rejects a nonfillable or incomplete preview', () => {
  const ticket = buildTradeTicket({
    market: yesNoMarket,
    selection: { side: 'yes' },
    amountSubunits: 1_000,
    side: 'Buy',
    orderType: 'market',
    limitPrice: 500,
  })
  const request = previewRequest(ticket)

  assert.throws(
    () =>
      buildProtectedTradeTicket({
        ticket,
        previewRequest: request,
        previewResponse: {
          fullFillAvailable: false,
          reason: 'insufficient_liquidity',
          previewRevision: null,
          quotePaymentSubunits: null,
          averagePrice: null,
          worstPrice: null,
          currentLatestTradePrice: null,
          projectedFinalPrice: null,
          priceDenominator: null,
          subsidyMayHelp: true,
        },
      }),
    (error: unknown) => error instanceof Error && error.message.includes('fillable'),
  )

  assert.throws(
    () =>
      buildProtectedTradeTicket({
        ticket,
        previewRequest: request,
        previewResponse: fillablePreview({ worstPrice: null }),
      }),
    /preview execution estimate nullability is invalid/,
  )
})

test('buildProtectedTradeTicket rejects mismatched preview facts and bounds', () => {
  const ticket = buildTradeTicket({
    market: yesNoMarket,
    selection: { side: 'yes' },
    amountSubunits: 1_000,
    side: 'Buy',
    orderType: 'market',
    limitPrice: 500,
  })
  const request = previewRequest(ticket)
  const mismatchCases = [
    { previewRequest: { ...request, marketId: 'other-market-Yes' } },
    { previewRequest: { ...request, side: 'Sell' as const } },
    { previewRequest: { ...request, tokenSide: 'Complement' as const } },
    { previewRequest: { ...request, faceAmountSubunits: 2_000 } },
    { previewRequest: { ...request, price: 998 } },
  ]

  for (const { previewRequest: mismatchedRequest } of mismatchCases) {
    const mismatchedResponse =
      mismatchedRequest.side === 'Sell'
        ? fillablePreview({ averagePrice: 999, worstPrice: 999, projectedFinalPrice: 999 })
        : fillablePreview()
    assert.throws(
      () =>
        buildProtectedTradeTicket({
          ticket,
          previewRequest: mismatchedRequest,
          previewResponse: mismatchedResponse,
        }),
      /does not match the trade ticket/,
    )
  }

  assert.throws(
    () =>
      buildProtectedTradeTicket({
        ticket,
        previewRequest: request,
        previewResponse: fillablePreview(),
        priceOverride: 700,
      }),
    /explicit price bound does not match/,
  )
})

test('buildProtectedTradeTicket rejects invalid preview prices and denominators', () => {
  const ticket = buildTradeTicket({
    market: yesNoMarket,
    selection: { side: 'yes' },
    amountSubunits: 1_000,
    side: 'Buy',
    orderType: 'market',
    limitPrice: 500,
  })
  const request = previewRequest(ticket)

  assert.throws(
    () =>
      buildProtectedTradeTicket({
        ticket,
        previewRequest: request,
        previewResponse: fillablePreview({ worstPrice: 1_000 }),
      }),
    /preview worst price is invalid/,
  )
  assert.throws(
    () =>
      buildProtectedTradeTicket({
        ticket,
        previewRequest: request,
        previewResponse: fillablePreview({ priceDenominator: 500 }),
      }),
    /preview request price is invalid/,
  )
})
