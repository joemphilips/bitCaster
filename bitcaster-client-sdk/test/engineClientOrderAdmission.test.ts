import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BitcasterEngineClient,
  classifyOrderSubmissionFailure,
  decodeOrderLookupResponse,
  decodeSubmitOrderResponse,
  EngineClientError,
  isOrderAdmissionResendableError,
  OrderQuoteRefreshWaitStopped,
  type CreateSettlementCapabilityRequest,
} from '../src/engineClient.ts'

const CONDITION_ID = 'a'.repeat(64)
const MARKET_ID = `${CONDITION_ID}-Alpha`

const ADMISSION: CreateSettlementCapabilityRequest = {
  stageIdempotencyKey: 'authorization-1',
  clientOrderId: 'client-1',
  marketId: MARKET_ID,
  orderIntent: {
    outcomeId: 'Alpha',
    tokenSide: 'Outcome',
    side: 'Buy',
    price: 400,
    maxQuotePaymentSubunits: 400,
    minQuotePaymentSubunits: null,
    amountSubunits: 1_000,
    minimumFillAmountSubunits: 1_000,
    baseAsset: 'sat',
    collateralUnit: 'msat',
    timeInForce: 'FOK',
    expiresAt: null,
  },
  artifact: 'Y2Fub25pY2FsLWFydGlmYWN0',
}

const ORDER = {
  orderId: '22222222-2222-4222-8222-222222222222',
  status: 'filled',
  remainingAmountSubunits: 0,
  fills: [],
  baseAsset: 'sat',
  divisibility: 1_000,
  activeSettlementGroup: null,
} as const

const CAPABILITY = {
  reference: {
    artifactId: '11111111-1111-4111-8111-111111111111',
    bindingDigest: 'b'.repeat(64),
  },
  orderId: ORDER.orderId,
  clientOrderId: 'client-1',
  marketId: MARKET_ID,
  artifactDigest: 'c'.repeat(64),
  state: 'bound',
  version: 1,
  authorizationExpiresAt: '2030-01-01T00:00:00.000Z',
  stageExpiresAt: '2030-01-01T00:01:00.000Z',
  settlementGroup: null,
} as const

function problem(status: number, code: string): Response {
  return new Response(
    JSON.stringify({ type: `/errors/${code}`, title: 'refused', status, code, detail: code }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  )
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('submitOrder sends one admission-form body that carries the capability request', async () => {
  const bodies: string[] = []
  const urls: string[] = []
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async (input, init) => {
      urls.push(String(input))
      bodies.push(String(init?.body))
      return ok({ ...ORDER, settlementCapability: CAPABILITY })
    },
  })
  const response = await client.submitOrder(MARKET_ID, {
    settlementCapabilityAdmission: ADMISSION,
    comment: null,
  })
  assert.deepEqual(urls, [`https://engine.example/api/v1/${encodeURIComponent(MARKET_ID)}/orders`])
  assert.equal(
    bodies[0],
    JSON.stringify({ settlementCapabilityAdmission: ADMISSION, comment: null }),
  )
  assert.equal(response.settlementCapability?.reference.artifactId, CAPABILITY.reference.artifactId)
  assert.equal(response.settlementCapability?.artifactDigest, CAPABILITY.artifactDigest)
})

test('the submit response accepts the optional capability and rejects a malformed one', () => {
  assert.equal(decodeSubmitOrderResponse(ORDER).settlementCapability, undefined)
  assert.equal(
    decodeSubmitOrderResponse({ ...ORDER, settlementCapability: CAPABILITY }).settlementCapability
      ?.state,
    'bound',
  )
  for (const settlementCapability of [
    null,
    { ...CAPABILITY, artifactDigest: 'not-a-digest' },
    { ...CAPABILITY, reference: { artifactId: 'not-a-uuid', bindingDigest: 'b'.repeat(64) } },
    { ...CAPABILITY, state: 'unknown' },
    { ...CAPABILITY, foreign: true },
  ]) {
    assert.throws(() => decodeSubmitOrderResponse({ ...ORDER, settlementCapability }))
  }
})

test('the in-flow resend sends the identical bytes after each refusal that commits nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const bodies: string[] = []
  const responses = [problem(409, 'order-book-conflict'), problem(503, 'order-quotes-refreshing')]
  const waited: number[] = []
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async (_input, init) => {
      bodies.push(String(init?.body))
      return responses.shift() ?? ok({ ...ORDER, settlementCapability: CAPABILITY })
    },
  })
  const submitted = client.submitOrder(
    MARKET_ID,
    { settlementCapabilityAdmission: ADMISSION, comment: null },
    {
      quoteRefreshRetry: {
        authorizationExpiresAtUnixSeconds: Math.floor(Date.now() / 1_000) + 300,
        onWaiting: ({ attempt }) => {
          waited.push(attempt)
          queueMicrotask(() => t.mock.timers.tick(attempt === 1 ? 1_000 : 2_000))
        },
      },
    },
  )
  const response = await submitted
  assert.equal(response.orderId, ORDER.orderId)
  assert.deepEqual(waited, [1, 2])
  assert.equal(bodies.length, 3)
  assert.equal(new Set(bodies).size, 1)
})

test('the in-flow resend stops at 30 attempts and sends nothing more', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async () => {
      calls += 1
      return problem(409, 'order-book-conflict')
    },
  })
  const submitted = client.submitOrder(
    MARKET_ID,
    { settlementCapabilityAdmission: ADMISSION, comment: null },
    {
      quoteRefreshRetry: {
        authorizationExpiresAtUnixSeconds: Math.floor(Date.now() / 1_000) + 300,
        // The fake timers do not move the 60-second budget clock, so only the
        // attempt count ends the loop.
        onWaiting: ({ attempt }) =>
          queueMicrotask(() => t.mock.timers.tick(attempt === 1 ? 1_000 : 2_000)),
      },
    },
  )
  await assert.rejects(submitted, (error: unknown) => {
    assert.ok(error instanceof OrderQuoteRefreshWaitStopped)
    return true
  })
  assert.equal(calls, 30)
})

test('a stopped resend after only non-committing refusals is a definitive refusal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async () => {
      calls += 1
      return calls % 2 === 1
        ? problem(409, 'order-book-conflict')
        : new Response(
            JSON.stringify({
              type: '/errors/order-quotes-refreshing',
              status: 503,
              code: 'order-quotes-refreshing',
            }),
            { status: 503, headers: { 'content-type': 'application/problem+json' } },
          )
    },
  })
  const error = await client
    .submitOrder(
      MARKET_ID,
      { settlementCapabilityAdmission: ADMISSION, comment: null },
      {
        quoteRefreshRetry: {
          authorizationExpiresAtUnixSeconds: Math.floor(Date.now() / 1_000) + 300,
          onWaiting: ({ attempt }) =>
            queueMicrotask(() => t.mock.timers.tick(attempt === 1 ? 1_000 : 2_000)),
        },
      },
    )
    .catch((caught: unknown) => caught)
  assert.ok(error instanceof OrderQuoteRefreshWaitStopped)
  assert.equal(error.reason, 'budget')
  assert.equal(error.allAttemptsRefused, true)
  assert.equal(calls, 30)
  assert.deepEqual(classifyOrderSubmissionFailure(error), {
    kind: 'rejected',
    code: 'order-quotes-refreshing',
  })
})

test('a user cancel during the wait after a refusal is a definitive refusal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const controller = new AbortController()
  let calls = 0
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async () => {
      calls += 1
      return problem(409, 'order-book-conflict')
    },
  })
  const error = await client
    .submitOrder(
      MARKET_ID,
      { settlementCapabilityAdmission: ADMISSION, comment: null },
      {
        signal: controller.signal,
        quoteRefreshRetry: {
          authorizationExpiresAtUnixSeconds: Math.floor(Date.now() / 1_000) + 300,
          onWaiting: () => queueMicrotask(() => controller.abort()),
        },
      },
    )
    .catch((caught: unknown) => caught)
  assert.ok(error instanceof OrderQuoteRefreshWaitStopped)
  assert.equal(error.reason, 'cancelled')
  assert.equal(calls, 1)
  assert.deepEqual(classifyOrderSubmissionFailure(error), {
    kind: 'rejected',
    code: 'order-book-conflict',
  })
})

test('a user cancel during an attempt in flight stays uncertain', async () => {
  const controller = new AbortController()
  let calls = 0
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async (_input, init) => {
      calls += 1
      if (calls === 1) return problem(409, 'order-book-conflict')
      // The second attempt is in flight when the user cancels.
      controller.abort()
      init?.signal?.throwIfAborted()
      return problem(409, 'order-book-conflict')
    },
  })
  const error = await client
    .submitOrder(
      MARKET_ID,
      { settlementCapabilityAdmission: ADMISSION, comment: null },
      {
        signal: controller.signal,
        quoteRefreshRetry: {
          authorizationExpiresAtUnixSeconds: Math.floor(Date.now() / 1_000) + 300,
          onWaiting: () => undefined,
        },
        requestTimeoutMs: 30_000,
      },
    )
    .catch((caught: unknown) => caught)
  assert.ok(error instanceof OrderQuoteRefreshWaitStopped)
  assert.equal(error.reason, 'cancelled')
  assert.equal(error.allAttemptsRefused, false)
  assert.equal(calls, 2)
  assert.deepEqual(classifyOrderSubmissionFailure(error), { kind: 'uncertain' })
})

test('a timeout stops the resend and stays uncertain', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async (_input, init) => {
      calls += 1
      if (calls === 1) return problem(409, 'order-book-conflict')
      queueMicrotask(() => t.mock.timers.tick(30_000))
      return await new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }),
      )
    },
  })
  const error = await client
    .submitOrder(
      MARKET_ID,
      { settlementCapabilityAdmission: ADMISSION, comment: null },
      {
        quoteRefreshRetry: {
          authorizationExpiresAtUnixSeconds: Math.floor(Date.now() / 1_000) + 300,
          onWaiting: () => queueMicrotask(() => t.mock.timers.tick(1_000)),
        },
      },
    )
    .catch((caught: unknown) => caught)
  assert.ok(!(error instanceof OrderQuoteRefreshWaitStopped))
  assert.equal(calls, 2)
  assert.deepEqual(classifyOrderSubmissionFailure(error), { kind: 'uncertain' })
})

test('only order-quotes-refreshing and order-book-conflict permit the in-flow resend', () => {
  assert.equal(
    isOrderAdmissionResendableError(
      new EngineClientError(
        503,
        JSON.stringify({
          type: '/errors/order-quotes-refreshing',
          status: 503,
          code: 'order-quotes-refreshing',
        }),
        'order-quotes-refreshing',
      ),
    ),
    true,
  )
  assert.equal(
    isOrderAdmissionResendableError(
      new EngineClientError(409, '{}', 'order-book-conflict', 'The order book changed.'),
    ),
    true,
  )
  for (const error of [
    new EngineClientError(409, '{}', 'order-processing-conflict'),
    new EngineClientError(409, 'Order book changed while submitting order; retry the request.'),
    new EngineClientError(503, '{}', 'order-processing-unavailable'),
    new EngineClientError(503, '{"code":"order-quotes-refreshing"}', 'order-quotes-refreshing'),
    new Error('order-book-conflict'),
  ])
    assert.equal(isOrderAdmissionResendableError(error), false, error.message)
})

test('every documented admission-form problem has one client outcome', () => {
  const rejected: Array<[number, string]> = [
    [400, 'order-invalid-request'],
    [400, 'order-invalid-comment'],
    [400, 'settlement-capability-policy-rejected'],
    [400, 'settlement-capability-invalid-artifact'],
    [400, 'settlement-capability-invalid-request'],
    [402, 'settlement-capability-score-required'],
    [404, 'order-market-not-found'],
    [404, 'settlement-capability-not-found'],
    [409, 'order-processing-conflict'],
    [409, 'order-market-closed'],
    [409, 'settlement-capability-conflict'],
    [409, 'settlement-capability-market-unavailable'],
    [413, 'settlement-capability-request-too-large'],
    [429, 'settlement-capability-capacity-exhausted'],
    [429, 'settlement-capability-admission-limited'],
  ]
  for (const [status, code] of rejected) {
    assert.deepEqual(
      classifyOrderSubmissionFailure(new EngineClientError(status, '{}', code)),
      { kind: 'rejected', code },
      code,
    )
  }
  // A framework 400, the 413 body limit and the order-submit rate limit carry no code.
  for (const status of [400, 413, 429]) {
    assert.deepEqual(classifyOrderSubmissionFailure(new EngineClientError(status, '')), {
      kind: 'rejected',
      code: null,
    })
  }
  const uncertain: unknown[] = [
    // A replay of this request's committed order can answer these four.
    new EngineClientError(403, '{}', 'market-closed'),
    new EngineClientError(404, '{}', 'order-capability-not-found'),
    new EngineClientError(409, '{}', 'order-capability-route-mismatch'),
    new EngineClientError(409, '{}', 'order-capability-not-current'),
    new EngineClientError(503, '{}', 'order-admission-unavailable'),
    new EngineClientError(503, '{}', 'order-processing-unavailable'),
    new EngineClientError(503, '{}', 'settlement-capability-admission-unavailable'),
    new EngineClientError(503, ''),
    new EngineClientError(500, ''),
    new EngineClientError(502, ''),
    new EngineClientError(401, ''),
    new EngineClientError(403, ''),
    new EngineClientError(404, ''),
    new EngineClientError(408, ''),
    new EngineClientError(409, ''),
    new EngineClientError(409, '{}', 'unknown-conflict'),
    // The resend loop consumes these; outside it they prove nothing.
    new EngineClientError(409, '{}', 'order-book-conflict'),
    new EngineClientError(503, '{}', 'order-quotes-refreshing'),
    // A stop that interrupted an attempt in flight.
    new OrderQuoteRefreshWaitStopped('cancelled', false),
    new OrderQuoteRefreshWaitStopped('budget', false),
    new TypeError('fetch failed'),
    new Error('order response fields are invalid'),
  ]
  for (const error of uncertain)
    assert.deepEqual(classifyOrderSubmissionFailure(error), { kind: 'uncertain' }, String(error))
})

test('the order lookup reads one accepted order and maps only order-not-found to absent', async () => {
  const urls: string[] = []
  const found = {
    orderId: ORDER.orderId,
    marketId: MARKET_ID,
    status: 'accepted',
    settlementCapability: CAPABILITY.reference,
    artifactDigest: CAPABILITY.artifactDigest,
  }
  const responses = [ok(found), problem(404, 'order-not-found'), problem(404, 'route-not-found')]
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async (input, init) => {
      assert.equal(init?.method ?? 'GET', 'GET')
      urls.push(String(input))
      return responses.shift()!
    },
  })
  assert.deepEqual(await client.lookupOrderByClientOrderId(CONDITION_ID, 'client 1'), found)
  assert.equal(await client.lookupOrderByClientOrderId(CONDITION_ID, 'client 1'), null)
  await assert.rejects(client.lookupOrderByClientOrderId(CONDITION_ID, 'client 1'), (error) => {
    assert.ok(error instanceof EngineClientError)
    assert.equal(error.status, 404)
    return true
  })
  assert.equal(
    urls[0],
    `https://engine.example/api/v1/conditions/${CONDITION_ID}/orders/by-client-order-id?clientOrderId=client+1`,
  )
})

test('the order lookup decoder is strict', () => {
  const found = {
    orderId: ORDER.orderId,
    marketId: MARKET_ID,
    status: 'processed',
    settlementCapability: CAPABILITY.reference,
    artifactDigest: CAPABILITY.artifactDigest,
  }
  assert.deepEqual(decodeOrderLookupResponse(found), found)
  for (const value of [
    { ...found, status: 'resting' },
    { ...found, orderId: 'order' },
    { ...found, marketId: '' },
    { ...found, artifactDigest: 'C'.repeat(64) },
    { ...found, settlementCapability: { artifactId: CAPABILITY.reference.artifactId } },
    { ...found, foreign: true },
  ])
    assert.throws(() => decodeOrderLookupResponse(value), /order lookup/)
})
