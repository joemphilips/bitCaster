import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  BitcasterEngineClient,
  decodeMatchedDelta,
  decodeOrderLifecycleChangedDelta,
  decodeSettlementGroupStateChangedDelta,
  decodeSubmitOrderResponse,
  EngineClientError,
  DURABLE_RECIPIENT_DELIVERY_RESPONSE_BYTES_MAX,
  isDefinitiveOrderSubmissionError,
  SETTLEMENT_CAPABILITY_RESULT_ERROR_RESPONSE_BYTES_MAX,
  SETTLEMENT_CAPABILITY_RESULT_RESPONSE_BYTES_MAX,
  SUBMIT_ORDER_RESPONSE_BYTES_MAX,
  type EngineAuthorizationRequest,
} from '../src/engineClient.ts'
import { decodeDurableCustodyWalletId } from '../src/durableCustody.ts'
import {
  deriveDurableRecipientTupleFingerprint,
  type DurableRecipientDeliverySubmission,
} from '../src/durableRecipientDelivery.ts'
import { isKind89NostrEvent } from '../src/marketLifecycle.ts'

const DISPLAY_WALLET_ID = decodeDurableCustodyWalletId('c'.repeat(64))

function durableRecipientSubmission(deliveryId: string): DurableRecipientDeliverySubmission {
  const token = 'cashuBabc123'
  return {
    schemaVersion: 1,
    deliveryId,
    accountSubject: 'subject-1',
    recipientKind: 'matching-engine',
    purpose: 'participation-score',
    destinationId: deliveryId,
    productBindingSha256: 'a'.repeat(64),
    mintUrl: 'https://mint.example',
    unit: 'sat',
    requestedAmount: '5',
    creditPolicy: 'exact-amount',
    tokenSha256: bytesToHex(sha256(new TextEncoder().encode(token))),
    tokenEncodedLength: token.length,
    token,
  }
}

function durableRecipientStatus(
  submission: DurableRecipientDeliverySubmission,
  state: 'pending' | 'credited',
) {
  const delivery = {
    ...submission,
  }
  delete (delivery as Partial<DurableRecipientDeliverySubmission>).token
  return {
    delivery,
    tupleFingerprint: deriveDurableRecipientTupleFingerprint(submission),
    state,
    result:
      state === 'pending'
        ? null
        : {
            creditedAmount: submission.requestedAmount,
            receiveFee: '0',
            creditVerification: submission.creditPolicy,
            receiveOperationId: 'receive-1',
            receivedAt: '2026-08-11T00:00:00.000Z',
            businessEventId: 'event-1',
            businessEventAt: '2026-08-11T00:00:00.000Z',
          },
  }
}

test('BitcasterEngineClient.getMarket reads one catalogue row through query ids', async () => {
  const requests: string[] = []
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async (input) => {
      requests.push(String(input))
      return new Response(
        JSON.stringify({
          markets: [{ conditionId: 'condition-1', title: 'Weather' }],
          nextCursor: null,
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )
    },
  })

  assert.deepEqual(await client.getMarket('condition-1'), {
    conditionId: 'condition-1',
    title: 'Weather',
  })
  assert.deepEqual(requests, [
    'https://engine.example/api/v1/markets/query?state=All&ids=condition-1&page_size=1',
  ])
})

test('BitcasterEngineClient reads one bounded condition attestation', async () => {
  const conditionId = 'ab'.repeat(32)
  const body = {
    conditionId,
    attestedOutcome: 'YES',
    oracleWitness: { oracle_sigs: [] },
    registeredAuthority: { eventId: 'event-1' },
  }
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  })
  assert.deepEqual(await client.getConditionAttestation(conditionId), body)
})

test('BitcasterEngineClient.queryMarkets uses OpenAPI query parameter names', async () => {
  const requests: string[] = []
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async (input) => {
      requests.push(String(input))
      return new Response(JSON.stringify({ markets: [], nextCursor: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  await client.queryMarkets({
    search: 'weather',
    pageSize: 5,
    state: 'All',
    sort: 'Trending',
    tag: 'sports',
    creatorPubkey: 'npub1creator',
    cursor: 'next-page',
  })

  assert.deepEqual(requests, [
    'https://engine.example/api/v1/markets/query?state=All&sort=Trending&tag=sports&creator_pubkey=npub1creator&search=weather&page_size=5&cursor=next-page',
  ])
})

test('isKind89NostrEvent validates oracle attestation event shape from SDK', () => {
  const event = {
    id: 'e'.repeat(64),
    pubkey: 'p'.repeat(64),
    createdAt: 1_718_000_000,
    kind: 89,
    tags: [['d', 'condition-1']],
    content: '{}',
    sig: 's'.repeat(128),
  }

  assert.equal(isKind89NostrEvent(event), true)
  assert.equal(isKind89NostrEvent({ ...event, kind: 1 }), false)
  assert.equal(isKind89NostrEvent({ ...event, tags: ['d', 'condition-1'] }), false)
})

test('decodeSettlementGroupStateChangedDelta enforces the exact owner notification contract', () => {
  const value = {
    orderId: '44444444-4444-4444-8444-444444444444',
    marketId: 'condition-yes',
    settlementGroup: {
      groupId: '55555555-5555-4555-8555-555555555555',
      status: 'Confirmed',
      revision: 1,
      coalescingDeadline: '2026-08-01T00:00:00.000Z',
      frozenAt: '2026-08-01T00:00:01.000Z',
    },
  }

  assert.deepEqual(decodeSettlementGroupStateChangedDelta(value), value)
  assert.throws(
    () => decodeSettlementGroupStateChangedDelta({ ...value, foreign: true }),
    /fields are invalid/,
  )
  assert.throws(
    () =>
      decodeSettlementGroupStateChangedDelta({
        ...value,
        settlementGroup: { ...value.settlementGroup, status: 'Bogus' },
      }),
    /status is invalid/,
  )
})

test('decodeMatchedDelta enforces the exact public match contract', () => {
  const value = {
    marketId: 'condition-yes',
    fillId: '11111111-1111-4111-8111-111111111111',
    makerOrderId: '22222222-2222-4222-8222-222222222222',
    takerOrderId: '33333333-3333-4333-8333-333333333333',
    executionPrice: 4_000,
    amountSubunits: 10_000,
    path: 'Complementary',
    matchedAt: '2026-08-01T00:00:00.000Z',
    baseAsset: 'sat',
    collateralUnit: 'msat',
    divisibility: 10_000,
    quotePaymentSubunits: 4_000,
    outcomeFaceAmountSubunits: 10_000,
    tokenSide: 'Outcome',
  } as const

  assert.deepEqual(decodeMatchedDelta(value), value)
  assert.throws(() => decodeMatchedDelta({ ...value, FillId: value.fillId }), /fields are invalid/)
  assert.throws(() => decodeMatchedDelta({ ...value, fillId: 'not-a-uuid' }), /fill id is invalid/)
})

test('decodeOrderLifecycleChangedDelta enforces the retained owner notification contract', () => {
  const value = {
    orderId: '44444444-4444-4444-8444-444444444444',
    marketId: 'condition-yes',
    status: 'partially_filled',
    remainingAmountSubunits: 10_000,
    baseAsset: 'sat',
    collateralUnit: 'msat',
    divisibility: 10_000,
    activeSettlementGroup: null,
  }

  assert.deepEqual(decodeOrderLifecycleChangedDelta(value), value)
  assert.throws(
    () => decodeOrderLifecycleChangedDelta({ ...value, tradeId: 'obsolete' }),
    /fields are invalid/,
  )
})

test('BitcasterEngineClient.getMarket returns null for an empty catalogue result', async () => {
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async () =>
      new Response(JSON.stringify({ markets: [], nextCursor: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  })

  assert.equal(await client.getMarket('missing-condition'), null)
})

test('BitcasterEngineClient.getMarketPriceHistory reads primitive series', async () => {
  const requests: string[] = []
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async (input) => {
      requests.push(String(input))
      return new Response(
        JSON.stringify({
          conditionId: 'condition-1',
          timeframe: '24h',
          outcomes: [
            {
              outcomeId: 'YES',
              data: [
                {
                  timestamp: '2026-05-25T10:00:00Z',
                  price: 42,
                  volumeSubunits: 100,
                },
              ],
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )
    },
  })

  const history = await client.getMarketPriceHistory('condition-1', '24h')

  assert.equal(history.outcomes[0].outcomeId, 'YES')
  assert.equal(history.outcomes[0].data[0].price, 42)
  assert.deepEqual(requests, [
    'https://engine.example/api/v1/markets/condition-1/price-history?timeframe=24h',
  ])
})

test('BitcasterEngineClient.getMarketComments reads condition-keyed comments', async () => {
  const requests: string[] = []
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async (input) => {
      requests.push(String(input))
      return new Response(
        JSON.stringify({
          conditionId: 'condition-1',
          comments: [
            {
              commentId: '8f7a9a9e-8f8f-43d7-9d25-7d79c09bd6a2',
              content: 'hello',
              createdAt: '2026-05-25T10:00:00Z',
              authorPubkey: 'a'.repeat(64),
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )
    },
  })

  const response = await client.getMarketComments('condition-1')

  assert.equal(response.comments[0].content, 'hello')
  assert.equal(response.comments[0].createdAt, '2026-05-25T10:00:00Z')
  assert.equal(response.comments[0].authorPubkey, 'a'.repeat(64))
  assert.deepEqual(requests, ['https://engine.example/api/v1/markets/condition-1/comments'])
})

test('BitcasterEngineClient.getParticipationScore reads authenticated Score state', async () => {
  const requests: Array<{ url: string; auth?: string }> = []
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    authorization: async ({ url, method }) => {
      assert.equal(method, 'GET')
      assert.equal(url, 'https://engine.example/api/v1/participation-score')
      return 'Nostr auth'
    },
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        auth: new Headers(init?.headers).get('authorization') ?? undefined,
      })
      return new Response(
        JSON.stringify({
          pubkey: 'a'.repeat(64),
          balance: -1,
          purchasedTotal: 3,
          consumedTotal: 4,
          enabled: true,
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )
    },
  })

  const score = await client.getParticipationScore()

  assert.equal(score.balance, -1)
  assert.equal(score.enabled, true)
  assert.deepEqual(requests, [
    {
      url: 'https://engine.example/api/v1/participation-score',
      auth: 'Nostr auth',
    },
  ])
})

test('BitcasterEngineClient.payParticipationScoreEcash posts exact ecash fee body', async () => {
  const requests: Array<{ url: string; method?: string; body?: string; auth?: string }> = []
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    authorization: async ({ url, method, bodyText }) => {
      assert.equal(url, 'https://engine.example/api/v1/participation-score/ecash')
      assert.equal(method, 'POST')
      assert.equal(
        bodyText,
        JSON.stringify({
          amountSats: 2,
          proofsToken: 'cashuB-token',
          paymentId: 'client-payment-id',
        }),
      )
      return 'Nostr auth'
    },
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method,
        body: String(init?.body),
        auth: new Headers(init?.headers).get('authorization') ?? undefined,
      })
      return new Response(
        JSON.stringify({
          paymentId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
          status: 'credited',
          amountSats: 2,
          creditedScore: 2,
          creditedAt: '2026-06-09T00:00:00Z',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )
    },
  })

  const result = await client.payParticipationScoreEcash(2, 'cashuB-token', 'client-payment-id')

  assert.equal(result.status, 'credited')
  assert.deepEqual(requests, [
    {
      url: 'https://engine.example/api/v1/participation-score/ecash',
      method: 'POST',
      body: JSON.stringify({
        amountSats: 2,
        proofsToken: 'cashuB-token',
        paymentId: 'client-payment-id',
      }),
      auth: 'Nostr auth',
    },
  ])
})

test('BitcasterEngineClient reads one authenticated durable Cashu delivery status and maps 404 to null', async () => {
  const deliveryId = '11111111-1111-4111-8111-111111111111'
  const submission = durableRecipientSubmission(deliveryId)
  const requests: Array<{ url: string; method: string; authorization: string | null }> = []
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    authorization: ({ url, method }) => {
      assert.equal(url, `https://engine.example/api/v1/cashu-deliveries/${deliveryId}`)
      assert.equal(method, 'GET')
      return 'Nostr auth'
    },
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? 'GET',
        authorization: new Headers(init?.headers).get('authorization'),
      })
      return new Response(JSON.stringify(durableRecipientStatus(submission, 'credited')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  const status = await client.getDurableRecipientDeliveryStatus(deliveryId)

  assert.equal(status?.state, 'credited')
  assert.deepEqual(requests, [
    {
      url: `https://engine.example/api/v1/cashu-deliveries/${deliveryId}`,
      method: 'GET',
      authorization: 'Nostr auth',
    },
  ])

  const missing = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async () => new Response(null, { status: 404 }),
  })
  assert.equal(await missing.getDurableRecipientDeliveryStatus(deliveryId), null)
})

test('BitcasterEngineClient cancels an endless 404 durable Cashu delivery status body', async () => {
  let cancelled = false
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true
          },
        }),
        { status: 404 },
      ),
  })

  assert.equal(
    await client.getDurableRecipientDeliveryStatus('99999999-9999-4999-8999-999999999999'),
    null,
  )
  assert.equal(cancelled, true)
})

test('BitcasterEngineClient posts one exact authenticated durable Cashu delivery body', async () => {
  const submission = durableRecipientSubmission('22222222-2222-4222-8222-222222222222')
  let request: {
    url: string
    method?: string
    body?: string
    authorization: string | null
  } | null = null
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    authorization: ({ url, method, bodyText }) => {
      assert.equal(url, `https://engine.example/api/v1/cashu-deliveries/${submission.deliveryId}`)
      assert.equal(method, 'POST')
      assert.equal(bodyText, JSON.stringify(submission))
      return 'Nostr auth'
    },
    fetchImpl: async (input, init) => {
      request = {
        url: String(input),
        method: init?.method,
        body: String(init?.body),
        authorization: new Headers(init?.headers).get('authorization'),
      }
      return new Response(JSON.stringify(durableRecipientStatus(submission, 'pending')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  const result = await client.submitDurableRecipientDelivery(submission)

  assert.equal(result.state, 'pending')
  assert.deepEqual(request, {
    url: `https://engine.example/api/v1/cashu-deliveries/${submission.deliveryId}`,
    method: 'POST',
    body: JSON.stringify(submission),
    authorization: 'Nostr auth',
  })
})

test('BitcasterEngineClient bounds invalid durable Cashu delivery responses', async () => {
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async () =>
      new Response('x'.repeat(DURABLE_RECIPIENT_DELIVERY_RESPONSE_BYTES_MAX + 1), {
        status: 200,
      }),
  })

  await assert.rejects(
    () => client.getDurableRecipientDeliveryStatus('33333333-3333-4333-8333-333333333333'),
    /byte limit exceeded/i,
  )
})

test('BitcasterEngineClient durable delivery rejects redirects and redacts token echo errors', async () => {
  const submission = durableRecipientSubmission('44444444-4444-4444-8444-444444444444')
  let redirectMode: RequestRedirect | undefined
  const redirected = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async (_input, init) => {
      redirectMode = init?.redirect
      throw new TypeError('redirected request')
    },
  })

  await assert.rejects(
    () => redirected.submitDurableRecipientDelivery(submission),
    /durable recipient delivery request failed/,
  )
  assert.equal(redirectMode, 'error')

  const echoed = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async () => new Response(submission.token, { status: 503 }),
  })
  await assert.rejects(
    () => echoed.submitDurableRecipientDelivery(submission),
    (error: unknown) => {
      assert.match(String(error), /durable recipient delivery request failed: HTTP 503/)
      assert.doesNotMatch(String(error), new RegExp(submission.token))
      return true
    },
  )
})

test('BitcasterEngineClient durable delivery timeout covers response-body consumption', async () => {
  const submission = durableRecipientSubmission('55555555-5555-4555-8555-555555555555')
  let bodySignalAborted = false
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    durableRecipientDeliveryRequestTimeoutMs: 5,
    fetchImpl: async (_input, init) => {
      const signal = init?.signal
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener(
              'abort',
              () => {
                bodySignalAborted = true
                controller.error(new DOMException('aborted', 'AbortError'))
              },
              { once: true },
            )
          },
        }),
        { status: 200 },
      )
    },
  })

  await assert.rejects(
    () => client.submitDurableRecipientDelivery(submission),
    /durable recipient delivery request failed/,
  )
  assert.equal(bodySignalAborted, true)
})

test('BitcasterEngineClient default fetch keeps the browser fetch receiver', async () => {
  const originalFetch = globalThis.fetch
  let observedThis: unknown
  globalThis.fetch = function (this: unknown, input: RequestInfo | URL) {
    observedThis = this
    assert.equal(String(input), 'https://engine.example/api/v1/condition-1-YES/orderbook')
    return Promise.resolve(
      new Response(
        JSON.stringify({
          marketId: 'condition-1-YES',
          bids: [],
          asks: [],
          spread: null,
          depthLimit: 5,
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )
  } as typeof fetch

  try {
    const client = new BitcasterEngineClient({
      baseUrl: 'https://engine.example',
    })
    const snapshot = await client.getOrderBook('condition-1-YES')
    assert.equal(observedThis, globalThis)
    assert.equal(snapshot.depthLimit, 5)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('BitcasterEngineClient.submitOrder sends display-only wallet attribution with the capability reference', async () => {
  const comment = {
    id: '1'.repeat(64),
    pubkey: '2'.repeat(64),
    createdAt: 1_718_000_000,
    kind: 1 as const,
    tags: [['r', 'https://bitcaster.example/markets/condition-1-YES']],
    content: 'trade comment',
    sig: '3'.repeat(128),
  }
  const expectedBody = JSON.stringify({
    settlementCapability: {
      artifactId: '11111111-1111-4111-8111-111111111111',
      bindingDigest: 'a'.repeat(64),
    },
    comment,
    walletId: DISPLAY_WALLET_ID,
  })
  const requests: Array<{ url: string; body?: string; authorization?: string }> = []
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    authorization: ({ bodyText }) => {
      assert.equal(bodyText, expectedBody)
      return 'Nostr auth'
    },
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        body: String(init?.body),
        authorization: new Headers(init?.headers).get('authorization') ?? undefined,
      })
      return new Response(
        JSON.stringify({
          orderId: '22222222-2222-4222-8222-222222222222',
          status: 'resting',
          remainingAmountSubunits: 10_000,
          fills: [],
          baseAsset: 'sat',
          divisibility: 10_000,
          activeSettlementGroup: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  })

  const response = await client.submitOrder('condition-1-YES', {
    settlementCapability: {
      artifactId: '11111111-1111-4111-8111-111111111111',
      bindingDigest: 'a'.repeat(64),
    },
    comment,
    walletId: DISPLAY_WALLET_ID,
  })

  assert.equal(response.status, 'resting')
  assert.deepEqual(requests, [
    {
      url: 'https://engine.example/api/v1/condition-1-YES/orders',
      body: expectedBody,
      authorization: 'Nostr auth',
    },
  ])
})

test('decodeSubmitOrderResponse rejects foreign fields and malformed nested authority', () => {
  const response = {
    orderId: '22222222-2222-4222-8222-222222222222',
    status: 'filled',
    remainingAmountSubunits: 0,
    fills: [],
    baseAsset: 'sat',
    divisibility: 10_000,
    activeSettlementGroup: null,
  }
  assert.deepEqual(decodeSubmitOrderResponse(response), response)
  assert.throws(
    () => decodeSubmitOrderResponse({ ...response, foreign: true }),
    /response fields are invalid/,
  )
  assert.throws(
    () => decodeSubmitOrderResponse({ ...response, pendingPubkeySubmissions: [] }),
    /response fields are invalid/,
  )
})

test('decodeSubmitOrderResponse rejects removed fill trade identity', () => {
  const settlementGroup = {
    groupId: '44444444-4444-4444-8444-444444444444',
    status: 'Prepared',
    revision: 1,
    coalescingDeadline: '2026-07-29T00:00:10Z',
    frozenAt: null,
  }
  const fill = {
    id: '55555555-5555-4555-8555-555555555555',
    makerOrderId: '66666666-6666-4666-8666-666666666666',
    takerOrderId: '77777777-7777-4777-8777-777777777777',
    amountSubunits: 10_000,
    executionPrice: 100,
    path: 'Mint',
    status: 'Matched',
    filledAt: '2026-07-29T00:00:00Z',
    settlementGroup,
    baseAsset: 'sat',
    divisibility: 10_000,
    tokenSide: 'Outcome',
    quotePaymentSubunits: 100,
    outcomeFaceAmountSubunits: 10_000,
  }
  const response = {
    orderId: '22222222-2222-4222-8222-222222222222',
    status: 'filled',
    remainingAmountSubunits: 0,
    fills: [fill],
    baseAsset: 'sat',
    divisibility: 10_000,
    activeSettlementGroup: settlementGroup,
  }

  const decoded = decodeSubmitOrderResponse(response)

  assert.deepEqual(decoded.fills[0], fill)
  assert.throws(
    () =>
      decodeSubmitOrderResponse({
        ...response,
        fills: [{ ...fill, tradeId: 'not-a-uuid' }],
      }),
    /fields are invalid/,
  )
})

test('BitcasterEngineClient.submitOrder rejects an oversized response before decoding', async () => {
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async () =>
      new Response(JSON.stringify({ padding: 'x'.repeat(SUBMIT_ORDER_RESPONSE_BYTES_MAX) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  })

  await assert.rejects(
    () =>
      client.submitOrder('condition-1-YES', {
        settlementCapability: {
          artifactId: '11111111-1111-4111-8111-111111111111',
          bindingDigest: 'a'.repeat(64),
        },
        comment: null,
      }),
    /byte limit/,
  )
})

test('BitcasterEngineClient.listMyOrders preserves strict unit and lifecycle fields', async () => {
  const settlementGroup = {
    groupId: '44444444-4444-4444-8444-444444444444',
    status: 'Prepared',
    revision: 1,
    coalescingDeadline: '2026-07-29T00:00:10Z',
    frozenAt: null,
  }
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async (input) => {
      assert.equal(
        String(input),
        'https://engine.example/api/v1/orders/mine?conditionId=condition-1&cursor=next-page',
      )
      return new Response(
        JSON.stringify({
          orders: [
            {
              orderId: '22222222-2222-4222-8222-222222222222',
              marketId: 'condition-1-YES',
              conditionId: 'condition-1',
              baseAsset: 'sat',
              divisibility: 10_000,
              side: 'Buy',
              price: 4_000,
              amountSubunits: 20_000,
              remainingAmountSubunits: 10_000,
              tokenSide: 'Outcome',
              status: 'partially_filled',
              placedAt: '2026-07-29T00:00:00Z',
              filledAt: null,
              clientOrderId: 'client-order-1',
              activeSettlementGroup: settlementGroup,
            },
          ],
          nextCursor: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  })

  const response = await client.listMyOrders('condition-1', 'next-page')

  assert.equal(response.orders[0]?.baseAsset, 'sat')
  assert.equal(response.orders[0]?.divisibility, 10_000)
  assert.deepEqual(response.orders[0]?.activeSettlementGroup, settlementGroup)
})

test('BitcasterEngineClient.batchSubmitOrders preserves accepted and rejected results', async () => {
  const expectedBody = JSON.stringify({
    orders: [
      {
        settlementCapability: {
          artifactId: '11111111-1111-4111-8111-111111111111',
          bindingDigest: 'a'.repeat(64),
        },
        walletId: DISPLAY_WALLET_ID,
      },
      {
        settlementCapability: {
          artifactId: '22222222-2222-4222-8222-222222222222',
          bindingDigest: 'b'.repeat(64),
        },
      },
    ],
  })
  let observedBody = ''
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async (_input, init) => {
      observedBody = String(init?.body)
      return new Response(
        JSON.stringify({
          accepted: [
            {
              requestIndex: 0,
              clientOrderId: 'client-order-1',
              marketId: 'condition-1-YES',
              orderId: '33333333-3333-4333-8333-333333333333',
              status: 'resting',
              remainingAmountSubunits: 10_000,
              fills: [],
              baseAsset: 'sat',
              divisibility: 10_000,
              activeSettlementGroup: null,
            },
          ],
          rejected: [{ requestIndex: 1, errorCode: 'capabilityNotCurrent' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  })

  const response = await client.batchSubmitOrders('condition-1', {
    orders: [
      {
        settlementCapability: {
          artifactId: '11111111-1111-4111-8111-111111111111',
          bindingDigest: 'a'.repeat(64),
        },
        walletId: DISPLAY_WALLET_ID,
      },
      {
        settlementCapability: {
          artifactId: '22222222-2222-4222-8222-222222222222',
          bindingDigest: 'b'.repeat(64),
        },
      },
    ],
  })

  assert.equal(observedBody, expectedBody)
  assert.equal(response.accepted[0]?.clientOrderId, 'client-order-1')
  assert.equal(response.rejected[0]?.errorCode, 'capabilityNotCurrent')
})

test('BitcasterEngineClient mirrors settlement-capability lifecycle routes', async () => {
  const reference = {
    artifactId: '11111111-1111-4111-8111-111111111111',
    bindingDigest: 'a'.repeat(64),
  }
  const capability = {
    reference,
    orderId: '22222222-2222-4222-8222-222222222222',
    clientOrderId: 'client-order-1',
    marketId: `${'b'.repeat(64)}-YES`,
    artifactDigest: 'c'.repeat(64),
    state: 'bound',
    version: 3,
    authorizationExpiresAt: '2026-08-01T00:00:00Z',
    stageExpiresAt: '2026-07-30T00:00:00Z',
    settlementGroup: null,
  }
  const settlementGroup = {
    groupId: '44444444-4444-4444-8444-444444444444',
    status: 'Confirmed',
    revision: 2,
    coalescingDeadline: '2026-07-29T00:00:10Z',
    frozenAt: '2026-07-29T00:00:05Z',
  }
  const result = {
    resultId: '33333333-3333-4333-8333-333333333333',
    reference,
    operationId: 'operation+1',
    requestDigest: 'd'.repeat(64),
    envelopeDigest: 'e'.repeat(64),
    envelope: 'Y2Fub25pY2FsLWVudmVsb3Bl',
    createdAt: '2026-07-29T00:00:00Z',
    acknowledgedAt: null,
    version: 4,
    settlementGroup,
  }
  const policy = {
    coordinatorPubkey: '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  }
  const createRequest = {
    stageIdempotencyKey: 'stage-1',
    clientOrderId: 'client-order-1',
    marketId: capability.marketId,
    orderIntent: {
      outcomeId: 'YES',
      tokenSide: 'Outcome' as const,
      side: 'Buy' as const,
      price: 4_000,
      amountSubunits: 10_000,
      minimumFillAmountSubunits: 10_000,
      baseAsset: 'sat' as const,
      collateralUnit: 'msat' as const,
      timeInForce: 'FAK' as const,
      expiresAt: null,
    },
    artifact: 'Y2Fub25pY2FsLWFydGlmYWN0',
  }
  const requests: Array<{ url: string; method: string; body?: string }> = []
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async (input, init) => {
      const url = String(input)
      requests.push({
        url,
        method: init?.method ?? 'GET',
        ...(init?.body === undefined ? {} : { body: String(init.body) }),
      })
      const responseBody = url.endsWith('/acknowledgement')
        ? { ...result, acknowledgedAt: '2026-07-29T00:01:00Z', version: 5 }
        : url.endsWith('/settlement-capabilities/policy')
          ? policy
          : url.includes('settlement-capability-results')
            ? result
            : capability
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  assert.deepEqual(await client.getSettlementCapabilityAdmissionPolicy(), policy)
  assert.deepEqual(await client.createSettlementCapability(createRequest), capability)
  assert.deepEqual(await client.getSettlementCapability(reference), capability)
  assert.deepEqual(await client.getSettlementCapabilityResult(result.resultId), result)
  assert.deepEqual(await client.getSettlementCapabilityResultByOperation('operation+1'), result)
  assert.equal(
    (
      await client.acknowledgeSettlementCapabilityResult(result.resultId, {
        expectedVersion: 4,
      })
    )?.version,
    5,
  )

  assert.deepEqual(requests, [
    {
      url: 'https://engine.example/api/v1/settlement-capabilities/policy',
      method: 'GET',
    },
    {
      url: 'https://engine.example/api/v1/settlement-capabilities',
      method: 'POST',
      body: JSON.stringify(createRequest),
    },
    {
      url: `https://engine.example/api/v1/settlement-capabilities/${reference.artifactId}?bindingDigest=${reference.bindingDigest}`,
      method: 'GET',
    },
    {
      url: `https://engine.example/api/v1/settlement-capability-results/${result.resultId}`,
      method: 'GET',
    },
    {
      url: 'https://engine.example/api/v1/settlement-capability-results/by-operation?operationId=operation%2B1',
      method: 'GET',
    },
    {
      url: `https://engine.example/api/v1/settlement-capability-results/${result.resultId}/acknowledgement`,
      method: 'POST',
      body: JSON.stringify({ expectedVersion: 4 }),
    },
  ])
})

test('BitcasterEngineClient reads an order status without continuation state', async () => {
  const orderId = '11111111-1111-4111-8111-111111111111'
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async (input, init) => {
      return new Response(
        JSON.stringify({
          orderId,
          marketId: 'condition-1-YES',
          status: 'partially_filled',
          remainingAmountSubunits: 10_000,
          filledAmountSubunits: 10_000,
          fills: [],
          amountSubunits: 20_000,
          outcomeId: 'YES',
          side: 'Buy',
          price: 5_000,
          placedAt: '2026-07-29T00:00:00.000Z',
          timeInForce: 'GTC',
          expiresAt: null,
          tokenSide: 'Outcome',
          baseAsset: 'sat',
          divisibility: 10_000,
          activeSettlementGroup: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  })

  const status = await client.getOrderStatus('condition-1-YES', orderId)
  assert.deepEqual(status, {
    orderId,
    marketId: 'condition-1-YES',
    status: 'partially_filled',
    remainingAmountSubunits: 10_000,
    filledAmountSubunits: 10_000,
    fills: [],
    amountSubunits: 20_000,
    outcomeId: 'YES',
    side: 'Buy',
    price: 5_000,
    placedAt: '2026-07-29T00:00:00.000Z',
    timeInForce: 'GTC',
    expiresAt: null,
    tokenSide: 'Outcome',
    baseAsset: 'sat',
    divisibility: 10_000,
    activeSettlementGroup: null,
  })
})

test('BitcasterEngineClient bounds result streams before Response.json allocation', async () => {
  let jsonCalls = 0
  let cancelled = false
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async () => {
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(SETTLEMENT_CAPABILITY_RESULT_RESPONSE_BYTES_MAX))
            controller.enqueue(Uint8Array.of(1))
          },
          cancel() {
            cancelled = true
          },
        }),
        { status: 200 },
      )
      Object.defineProperty(response, 'json', {
        value: async () => {
          jsonCalls += 1
          return {}
        },
      })
      return response
    },
  })

  await assert.rejects(
    () => client.getSettlementCapabilityResultByOperation('operation-1'),
    /response byte limit exceeded/,
  )
  assert.equal(jsonCalls, 0)
  assert.equal(cancelled, true)
})

test('BitcasterEngineClient cancels an endless 404 settlement-result body', async () => {
  let cancelled = false
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true
          },
        }),
        { status: 404 },
      ),
  })

  assert.equal(await client.getSettlementCapabilityResult('missing-result'), null)
  assert.equal(cancelled, true)
})

test('BitcasterEngineClient bounds and cancels oversized settlement-result errors', async () => {
  let cancelled = false
  let textCalls = 0
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async () => {
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new Uint8Array(SETTLEMENT_CAPABILITY_RESULT_ERROR_RESPONSE_BYTES_MAX),
            )
            controller.enqueue(Uint8Array.of(1))
          },
          cancel() {
            cancelled = true
          },
        }),
        { status: 503 },
      )
      Object.defineProperty(response, 'text', {
        value: async () => {
          textCalls += 1
          return 'unbounded'
        },
      })
      return response
    },
  })

  await assert.rejects(
    () => client.getSettlementCapabilityResultByOperation('operation-1'),
    /Engine request failed: 503/,
  )
  assert.equal(cancelled, true)
  assert.equal(textCalls, 0)
})

test('BitcasterEngineClient result lifetime rejects redirects and covers body consumption', async () => {
  let redirectMode: RequestRedirect | undefined
  let bodySignalAborted = false
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    settlementResultRequestTimeoutMs: 5,
    fetchImpl: async (_input, init) => {
      redirectMode = init?.redirect
      const signal = init?.signal
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener(
              'abort',
              () => {
                bodySignalAborted = true
                controller.error(new DOMException('aborted', 'AbortError'))
              },
              { once: true },
            )
          },
        }),
        { status: 200 },
      )
    },
  })

  await assert.rejects(
    () => client.getSettlementCapabilityResultByOperation('operation-1'),
    /settlement capability result request failed/,
  )
  assert.equal(redirectMode, 'error')
  assert.equal(bodySignalAborted, true)
})

test('BitcasterEngineClient result request accepts caller cancellation without changing auth input', async () => {
  const controller = new AbortController()
  const authorizationRequests: EngineAuthorizationRequest[] = []
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    authorization: async (request) => {
      authorizationRequests.push(request)
      return 'Nostr signed-result-request'
    },
    fetchImpl: async (_input, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Nostr signed-result-request')
      controller.abort()
      return new Response('{}')
    },
  })

  await assert.rejects(
    () => client.getSettlementCapabilityResult('result-1', controller.signal),
    /settlement capability result request failed/,
  )
  assert.deepEqual(authorizationRequests, [
    {
      url: 'https://engine.example/api/v1/settlement-capability-results/result-1',
      method: 'GET',
      bodyText: undefined,
    },
  ])
})

test('BitcasterEngineClient acknowledgement preserves the exact NIP-98 body input', async () => {
  const authorizationRequests: EngineAuthorizationRequest[] = []
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    authorization: async (request) => {
      authorizationRequests.push(request)
      return 'Nostr signed-acknowledgement'
    },
    fetchImpl: async (_input, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Nostr signed-acknowledgement')
      assert.equal(init?.redirect, 'error')
      return Response.json({})
    },
  })

  await client.acknowledgeSettlementCapabilityResult('result-1', { expectedVersion: 7 })
  assert.deepEqual(authorizationRequests, [
    {
      url: 'https://engine.example/api/v1/settlement-capability-results/result-1/acknowledgement',
      method: 'POST',
      bodyText: '{"expectedVersion":7}',
    },
  ])
})

test('BitcasterEngineClient authenticates and strictly validates settlement policy', async () => {
  const authorizationRequests: EngineAuthorizationRequest[] = []
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    authorization: async (request) => {
      authorizationRequests.push(request)
      return 'Nostr signed-policy-request'
    },
    fetchImpl: async (_input, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Nostr signed-policy-request')
      return Response.json({ coordinatorPubkey: 'f'.repeat(64) })
    },
  })

  await assert.rejects(
    () => client.getSettlementCapabilityAdmissionPolicy(),
    /coordinator public key is invalid/,
  )
  assert.deepEqual(authorizationRequests, [
    {
      url: 'https://engine.example/api/v1/settlement-capabilities/policy',
      method: 'GET',
      bodyText: undefined,
    },
  ])
})

test('BitcasterEngineClient exposes plain submit-order validation errors', async () => {
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async () =>
      new Response('OutcomeId must match the primitive outcome segment of marketId.', {
        status: 400,
        headers: { 'content-type': 'text/plain' },
      }),
  })

  await assert.rejects(
    () =>
      client.submitOrder('condition-Bob%7CCarol', {
        settlementCapability: {
          artifactId: '11111111-1111-4111-8111-111111111111',
          bindingDigest: 'a'.repeat(64),
        },
        comment: null,
      }),
    (err) =>
      err instanceof EngineClientError &&
      err.status === 400 &&
      err.detail === 'OutcomeId must match the primitive outcome segment of marketId.',
  )
})

test('order submission error classification recognizes only the transient book conflict', () => {
  for (const detail of [
    'Order book changed while submitting order; retry the request.',
    JSON.stringify('Order book changed while submitting order; retry the request.'),
  ]) {
    assert.equal(isDefinitiveOrderSubmissionError(new EngineClientError(409, detail)), false)
  }
  assert.equal(
    isDefinitiveOrderSubmissionError(
      new EngineClientError(409, 'Settlement capability is not current.'),
    ),
    true,
  )
  assert.equal(
    isDefinitiveOrderSubmissionError(
      new EngineClientError(409, '{"detail":"Market is closed."}', undefined, 'Market is closed.'),
    ),
    true,
  )
  assert.equal(isDefinitiveOrderSubmissionError(new EngineClientError(429, 'retry')), false)
  assert.equal(isDefinitiveOrderSubmissionError(new EngineClientError(400, 'invalid')), true)
})
