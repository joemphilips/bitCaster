import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BitcasterEngineClient,
  EngineClientError,
  scorePaymentStatusToDeliveryEvidence,
  submitEphemeralPubkey,
} from '../src/engineClient.ts'
import { isKind89NostrEvent } from '../src/marketLifecycle.ts'

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

test('submitEphemeralPubkey includes conditionId in the request URL and auth input', async () => {
  const requests: string[] = []
  const authUrls: string[] = []

  await submitEphemeralPubkey(
    'https://engine.example/',
    '11111111-1111-4111-8111-111111111111',
    '02'.padEnd(66, '1'),
    null,
    async (input) => {
      requests.push(String(input))
      return new Response(
        JSON.stringify({
          tradeId: '11111111-1111-4111-8111-111111111111',
          role: 'maker',
          bothReceived: true,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
    async ({ url }) => {
      authUrls.push(url)
      return 'Nostr token'
    },
    'abcdef',
  )

  assert.deepEqual(requests, [
    'https://engine.example/api/v1/trades/11111111-1111-4111-8111-111111111111/ephemeral-pubkey?conditionId=abcdef',
  ])
  assert.deepEqual(authUrls, requests)
})

test('BitcasterEngineClient.submitEphemeralPubkey passes conditionId to the helper request', async () => {
  const requests: string[] = []
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example/',
    fetchImpl: async (input) => {
      requests.push(String(input))
      return new Response(
        JSON.stringify({
          tradeId: '22222222-2222-4222-8222-222222222222',
          role: 'maker',
          bothReceived: true,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  })

  await client.submitEphemeralPubkey(
    '22222222-2222-4222-8222-222222222222',
    '02'.padEnd(66, '2'),
    'cond-1',
  )

  assert.deepEqual(requests, [
    'https://engine.example/api/v1/trades/22222222-2222-4222-8222-222222222222/ephemeral-pubkey?conditionId=cond-1',
  ])
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
          accountSubject: 'account_primary',
          balance: -1,
          purchasedTotal: 3,
          consumedTotal: 4,
          penaltyTotal: 0,
          matchDebitScore: 1,
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
  assert.equal(score.accountSubject, 'account_primary')
  assert.equal(score.enabled, true)
  assert.deepEqual(requests, [
    {
      url: 'https://engine.example/api/v1/participation-score',
      auth: 'Nostr auth',
    },
  ])
})

test('BitcasterEngineClient.getParticipationScorePayment reads owner-scoped status', async () => {
  const paymentId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    authorization: async () => 'Nostr auth',
    fetchImpl: async (input) => {
      assert.equal(
        String(input),
        `https://engine.example/api/v1/participation-score/payments/${paymentId}`,
      )
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          paymentId,
          status: 'credited',
          accountSubject: 'account_primary',
          recipientKind: 'matching-engine',
          purpose: 'participation-score',
          destinationId: 'participation-score',
          mintUrl: 'https://mint.example',
          unit: 'sat',
          amountSats: 2,
          tokenDigest: 'ab'.repeat(32),
          encodedTokenBytes: 123,
          receiptOperationId: `score-receipt/${paymentId}`,
          receivedAt: '2026-07-16T00:00:00Z',
          creditedScore: 2,
          businessEventId: paymentId,
          creditedAt: '2026-07-16T00:00:00Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  })

  const status = await client.getParticipationScorePayment(paymentId)

  assert.equal(status?.status, 'credited')
  assert.equal(status?.accountSubject, 'account_primary')
  assert.equal(scorePaymentStatusToDeliveryEvidence(status!).request.tokenDigest, 'ab'.repeat(32))
})

test('BitcasterEngineClient rejects malformed or misbound Score payment status', async () => {
  const paymentId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
  const valid = {
    schemaVersion: 1,
    paymentId,
    status: 'credited',
    accountSubject: 'account_primary',
    recipientKind: 'matching-engine',
    purpose: 'participation-score',
    destinationId: 'participation-score',
    mintUrl: 'https://mint.example',
    unit: 'sat',
    amountSats: 2,
    tokenDigest: 'ab'.repeat(32),
    encodedTokenBytes: 123,
    receiptOperationId: `score-receipt/${paymentId}`,
    receivedAt: '2026-07-16T00:00:00Z',
    creditedScore: 2,
    businessEventId: paymentId,
    creditedAt: '2026-07-16T00:00:00Z',
  }
  for (const body of [
    { ...valid, schemaVersion: 2 },
    { ...valid, recipientKind: 'other' },
    { ...valid, creditedScore: 3 },
    { ...valid, receiptOperationId: 'score-receipt/other' },
    { ...valid, businessEventId: '00000000-0000-4000-8000-000000000001' },
    { ...valid, creditedAt: '2026-07-15T23:59:59Z' },
    { ...valid, unexpected: true },
  ]) {
    const client = new BitcasterEngineClient({
      baseUrl: 'https://engine.example',
      fetchImpl: async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    })

    await assert.rejects(() => client.getParticipationScorePayment(paymentId))
  }
})

test('BitcasterEngineClient binds Score status to the requested payment id', async () => {
  const requestedId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
  const returnedId = '00000000-0000-4000-8000-000000000001'
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 1,
          paymentId: returnedId,
          status: 'credited',
          accountSubject: 'account_primary',
          recipientKind: 'matching-engine',
          purpose: 'participation-score',
          destinationId: 'participation-score',
          mintUrl: 'https://mint.example',
          unit: 'sat',
          amountSats: 2,
          tokenDigest: 'ab'.repeat(32),
          encodedTokenBytes: 123,
          receiptOperationId: `score-receipt/${returnedId}`,
          receivedAt: '2026-07-16T00:00:00Z',
          creditedScore: 2,
          businessEventId: returnedId,
          creditedAt: '2026-07-16T00:00:00Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  })

  await assert.rejects(
    () => client.getParticipationScorePayment(requestedId),
    /does not match its request/,
  )
})

test('BitcasterEngineClient.payParticipationScoreEcash posts exact ecash fee body', async () => {
  const paymentId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
  const requests: Array<{
    url: string
    method?: string
    body?: string
    auth?: string
  }> = []
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
          paymentId,
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
          paymentId,
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

  const result = await client.payParticipationScoreEcash(2, 'cashuB-token', paymentId)

  assert.equal(result.status, 'credited')
  assert.deepEqual(requests, [
    {
      url: 'https://engine.example/api/v1/participation-score/ecash',
      method: 'POST',
      body: JSON.stringify({
        amountSats: 2,
        proofsToken: 'cashuB-token',
        paymentId,
      }),
      auth: 'Nostr auth',
    },
  ])
})

test('BitcasterEngineClient rejects an unknown or inconsistent Score payment response', async () => {
  for (const body of [
    {
      paymentId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      status: 'unknown',
      amountSats: 2,
    },
    {
      paymentId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      status: 'credited',
      amountSats: 2,
      creditedScore: 3,
      creditedAt: '2026-07-16T00:00:00Z',
    },
  ]) {
    const client = new BitcasterEngineClient({
      baseUrl: 'https://engine.example',
      fetchImpl: async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    })

    await assert.rejects(() => client.payParticipationScoreEcash(2, 'cashuB-token'))
  }
})

test('BitcasterEngineClient binds immediate Score responses to the request tuple', async () => {
  const paymentId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
  for (const body of [
    {
      paymentId: '00000000-0000-4000-8000-000000000001',
      status: 'pending',
      amountSats: 2,
    },
    {
      paymentId,
      status: 'pending',
      amountSats: 3,
    },
  ]) {
    const client = new BitcasterEngineClient({
      baseUrl: 'https://engine.example',
      fetchImpl: async () =>
        new Response(JSON.stringify(body), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        }),
    })

    await assert.rejects(() => client.payParticipationScoreEcash(2, 'cashuB-token', paymentId))
  }
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
        outcomeId: 'Alice',
        tokenSide: 'Outcome',
        side: 'Buy',
        price: 42,
        amountSubunits: 100,
        timeInForce: 'GTC',
        ephemeralPubkey: `02${'22'.repeat(32)}`,
      }),
    (err) =>
      err instanceof EngineClientError &&
      err.status === 400 &&
      err.detail === 'OutcomeId must match the primitive outcome segment of marketId.',
  )
})
