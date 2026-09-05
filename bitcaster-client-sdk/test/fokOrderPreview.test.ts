import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BitcasterEngineClient,
  EngineClientError,
} from '../src/engineClient.ts'
import {
  decodePreviewFokOrderResponse,
  FOK_PREVIEW_RESPONSE_BYTES_MAX,
  type PreviewFokOrderRequest,
} from '../src/fokOrderPreview.ts'

const request: PreviewFokOrderRequest = {
  marketId: 'condition-YES',
  side: 'Buy',
  tokenSide: 'Outcome',
  price: 500,
  faceAmountSubunits: 1_000,
}

function fillableResponse() {
  return {
    fullFillAvailable: true,
    reason: 'fillable',
    previewRevision: 'revision-1',
    quotePaymentSubunits: 450,
    averagePrice: 450,
    worstPrice: 500,
    currentLatestTradePrice: 490,
    projectedFinalPrice: 480,
    priceDenominator: 1_000,
    subsidyMayHelp: false,
  } as const
}

function nonfillableResponse(reason: string) {
  return {
    fullFillAvailable: false,
    reason,
    previewRevision: null,
    quotePaymentSubunits: null,
    averagePrice: null,
    worstPrice: null,
    currentLatestTradePrice: null,
    projectedFinalPrice: null,
    priceDenominator: null,
    subsidyMayHelp: reason === 'insufficient_liquidity',
  }
}

test('previewFokOrder sends only the generated public request and signs that body', async () => {
  let capturedUrl = ''
  let capturedInit: RequestInit | undefined
  let authorizationRequest: { url: string; method: string; bodyText?: string } | undefined
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example/',
    authorization: async (value) => {
      authorizationRequest = value
      return 'NIP98 signed'
    },
    fetchImpl: async (input, init) => {
      capturedUrl = String(input)
      capturedInit = init
      return new Response(JSON.stringify(fillableResponse()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  await client.previewFokOrder({
    ...request,
    owner: 'must-not-cross-boundary',
    proofs: ['must-not-cross-boundary'],
    timeInForce: 'GTC',
  } as PreviewFokOrderRequest & Record<string, unknown>)

  assert.equal(capturedUrl, 'https://engine.example/api/v1/orders/preview')
  assert.equal(capturedInit?.method, 'POST')
  assert.equal(capturedInit?.headers instanceof Object, true)
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), request)
  assert.equal((capturedInit?.headers as Record<string, string>).Authorization, 'NIP98 signed')
  assert.deepEqual(authorizationRequest, {
    url: 'https://engine.example/api/v1/orders/preview',
    method: 'POST',
    bodyText: String(capturedInit?.body),
  })
})

test('previewFokOrder supports anonymous calls and forwards AbortSignal', async () => {
  let capturedInit: RequestInit | undefined
  const controller = new AbortController()
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async (_input, init) => {
      capturedInit = init
      return new Response(JSON.stringify(fillableResponse()), { status: 200 })
    },
  })

  await client.previewFokOrder(request, controller.signal)
  assert.equal(capturedInit?.signal, controller.signal)
  assert.equal((capturedInit?.headers as Record<string, string>).Authorization, undefined)
})

test('previewFokOrder decodes fillable and every nonfillable reason', async () => {
  const reasons = [
    'insufficient_liquidity',
    'price_limit',
    'request_too_large',
    'market_unavailable',
    'temporarily_unavailable',
  ]
  const responses = [fillableResponse(), ...reasons.map(nonfillableResponse)]
  let responseIndex = 0
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async () => new Response(JSON.stringify(responses[responseIndex++])),
  })

  const fillable = await client.previewFokOrder(request)
  assert.equal(fillable.reason, 'fillable')
  assert.equal(fillable.quotePaymentSubunits, 450)
  for (const reason of reasons) {
    const value = await client.previewFokOrder(request)
    assert.equal(value.reason, reason)
    assert.equal(value.fullFillAvailable, false)
    assert.equal(value.quotePaymentSubunits, null)
    assert.equal(value.currentLatestTradePrice, null)
    assert.equal(value.priceDenominator, null)
    assert.equal(value.subsidyMayHelp, reason === 'insufficient_liquidity')
  }
})

test('previewFokOrder rejects malformed enum, numeric, nullability, and private fields', async () => {
  const malformed = [
    { ...fillableResponse(), reason: 'unknown' },
    { ...fillableResponse(), quotePaymentSubunits: 100_000_000_000_001 },
    { ...fillableResponse(), averagePrice: '450' },
    { ...fillableResponse(), projectedFinalPrice: null },
    { ...fillableResponse(), privateField: 'leak' },
  ]
  let responseIndex = 0
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async () => new Response(JSON.stringify(malformed[responseIndex++])),
  })
  for (const _value of malformed) {
    await assert.rejects(client.previewFokOrder(request), /preview/)
  }
})

test('previewFokOrder rejects partial execution estimates and incoherent snapshots', async () => {
  const malformed = [
    { ...nonfillableResponse('insufficient_liquidity'), quotePaymentSubunits: 1 },
    { ...fillableResponse(), previewRevision: null },
    { ...fillableResponse(), priceDenominator: null },
    { ...nonfillableResponse('market_unavailable'), previewRevision: 'revision-1', priceDenominator: null },
    { ...nonfillableResponse('market_unavailable'), currentLatestTradePrice: 10 },
    { ...fillableResponse(), averagePrice: 1_000 },
  ]
  let responseIndex = 0
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async () => new Response(JSON.stringify(malformed[responseIndex++])),
  })
  for (const _value of malformed) {
    await assert.rejects(client.previewFokOrder(request), /preview/)
  }
})

test('previewFokOrder enforces side-aware limits and whole-share face amounts', async () => {
  const cases = [
    { request, response: { ...fillableResponse(), worstPrice: 501 } },
    { request: { ...request, side: 'Sell' as const }, response: { ...fillableResponse(), worstPrice: 499 } },
    { request, response: { ...fillableResponse(), averagePrice: 501 } },
    { request: { ...request, side: 'Sell' as const }, response: { ...fillableResponse(), averagePrice: 499 } },
    { request: { ...request, faceAmountSubunits: 1_001 }, response: fillableResponse() },
  ]
  let responseIndex = 0
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async () => new Response(JSON.stringify(cases[responseIndex++].response)),
  })
  for (const testCase of cases) {
    await assert.rejects(client.previewFokOrder(testCase.request), /preview/)
  }
})

test('preview decoder enforces final price limits after token-side mapping', () => {
  const cases = [
    { side: 'Buy' as const, tokenSide: 'Outcome' as const, failingFinal: 900 },
    { side: 'Buy' as const, tokenSide: 'Complement' as const, failingFinal: 100 },
    { side: 'Sell' as const, tokenSide: 'Outcome' as const, failingFinal: 100 },
    { side: 'Sell' as const, tokenSide: 'Complement' as const, failingFinal: 900 },
  ]

  for (const testCase of cases) {
    const testRequest = { ...request, ...testCase }
    const averagePrice = testCase.side === 'Buy' ? 450 : 550
    const validWorstPrice = 500
    const failing = {
      ...fillableResponse(),
      averagePrice,
      worstPrice: validWorstPrice,
      projectedFinalPrice: testCase.failingFinal,
    }
    const boundary = { ...failing, projectedFinalPrice: 500 }

    assert.throws(
      () => decodePreviewFokOrderResponse(failing, testRequest),
      /preview final price limit is invalid/,
    )
    assert.doesNotThrow(() => decodePreviewFokOrderResponse(boundary, testRequest))
  }
})

test('previewFokOrder validates static request bounds before network I/O', async () => {
  let calls = 0
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async () => {
      calls += 1
      return new Response(JSON.stringify(fillableResponse()))
    },
  })

  await assert.rejects(
    client.previewFokOrder({ ...request, marketId: 'condition_bad-YES' }),
    /preview market id is invalid/,
  )
  await assert.rejects(
    client.previewFokOrder({ ...request, faceAmountSubunits: 100_000_000_000_001 }),
    /preview face amount is invalid/,
  )
  assert.equal(calls, 0)
})

test('previewFokOrder rejects a response over the 16 KiB bound', async () => {
  const body = JSON.stringify({ ...nonfillableResponse('market_unavailable'), padding: 'x'.repeat(17_000) })
  assert.ok(new TextEncoder().encode(body).byteLength > FOK_PREVIEW_RESPONSE_BYTES_MAX)
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async () => new Response(body, { status: 200 }),
  })
  await assert.rejects(client.previewFokOrder(request), /byte limit exceeded/)
})

test('previewFokOrder preserves bounded 429 Retry-After metadata', async () => {
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async () =>
      new Response(JSON.stringify({ code: 'preview_rate_limited', detail: 'retry later' }), {
        status: 429,
        headers: { 'Retry-After': '3' },
      }),
  })
  await assert.rejects(
    client.previewFokOrder(request),
    (error: unknown) =>
      error instanceof EngineClientError &&
      error.status === 429 &&
      error.code === 'preview_rate_limited' &&
      error.retryAfterSeconds === 3,
  )
})
