import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BitcasterEngineClient,
  type MarketPriceHistoryReadOptions,
  type MarketPriceHistoryResponse,
} from '../src/engineClient.ts'

function snapshot(): MarketPriceHistoryResponse {
  return {
    conditionId: 'condition',
    timeframe: '1h',
    snapshotEventOrder: 'opaque-server-position',
    asOf: '2026-10-08T12:00:00Z',
    outcomes: [
      {
        outcomeId: 'YES',
        data: [
          {
            timestamp: '2026-10-08T11:30:00Z',
            source: 'fill',
            eventOrder: 'opaque-fill-position',
            price: 420,
            volumeSubunits: 1000,
          },
        ],
      },
    ],
  }
}

async function read(body: unknown, options: MarketPriceHistoryReadOptions = {}) {
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async () => Response.json(body),
  })
  return client.getMarketPriceHistory('condition', '1h', {
    outcomeIds: ['YES', 'NO'],
    divisibility: 1000,
    ...options,
  })
}

const invalidBodies: [string, (body: any) => unknown][] = [
  ['null body', () => null],
  ['wrong condition', (body) => ({ ...body, conditionId: 'other' })],
  ['wrong range', (body) => ({ ...body, timeframe: '7d' })],
  [
    'missing authority',
    (body) => {
      delete body.snapshotEventOrder
      return body
    },
  ],
  ['blank authority', (body) => ({ ...body, snapshotEventOrder: '' })],
  ['null authority with fills', (body) => ({ ...body, snapshotEventOrder: null })],
  ['invalid evaluation date', (body) => ({ ...body, asOf: 'yesterday' })],
  [
    'missing outcomes',
    (body) => {
      delete body.outcomes
      return body
    },
  ],
  ['duplicate outcomes', (body) => ({ ...body, outcomes: [...body.outcomes, ...body.outcomes] })],
  [
    'foreign outcome',
    (body) => {
      body.outcomes[0].outcomeId = 'OTHER'
      return body
    },
  ],
  [
    'missing points',
    (body) => {
      delete body.outcomes[0].data
      return body
    },
  ],
]
for (const [label, pointPatch] of [
  ['quote authority', { source: 'quote' }],
  ['missing fill authority', { source: undefined }],
  ['missing fill position', { eventOrder: undefined }],
  ['invalid fill date', { timestamp: '2026-10-08' }],
  ['expired fill', { timestamp: '2026-10-08T10:59:59Z' }],
  ['zero price', { price: 0 }],
  ['fractional price', { price: 42.5 }],
  ['price at denominator', { price: 1000 }],
  ['negative volume', { volumeSubunits: -1 }],
  ['string volume', { volumeSubunits: '1000' }],
] as const) {
  invalidBodies.push([
    label,
    (body) => {
      Object.assign(body.outcomes[0].data[0], pointPatch)
      return body
    },
  ])
}
for (const [label, mutate] of invalidBodies) {
  test(`history HTTP 200 rejects ${label}`, async () => {
    await assert.rejects(read(mutate(snapshot())), /Invalid market price history/)
  })
}

test('history validates a complete response and preserves omitted untraded outcomes', async () => {
  assert.deepEqual(await read(snapshot()), snapshot())
})

test('history accepts authoritative empty ranges and an empty source', async () => {
  for (const snapshotEventOrder of ['opaque-position', null]) {
    const body = { ...snapshot(), snapshotEventOrder, outcomes: [] }
    assert.deepEqual(await read(body), body)
  }
})

test('minimum source position requires authority without comparing opaque values', async () => {
  await assert.rejects(
    read(
      { ...snapshot(), snapshotEventOrder: null, outcomes: [] },
      {
        minimumEventOrder: 'opaque-minimum',
      },
    ),
    /snapshotEventOrder/,
  )
  assert.deepEqual(await read(snapshot(), { minimumEventOrder: 'zzzz' }), snapshot())
})

test('older HTTP 200 evaluations cannot replace an accepted snapshot, including empty results', async () => {
  for (const outcomes of [snapshot().outcomes, []]) {
    await assert.rejects(
      read(
        { ...snapshot(), outcomes },
        {
          minimumAsOf: '2026-10-08T12:00:01Z',
        },
      ),
      /stale asOf/,
    )
  }
  const empty = { ...snapshot(), outcomes: [] }
  assert.deepEqual(await read(empty, { minimumAsOf: empty.asOf }), empty)
})

test('a fill confirmed during server catch-up can follow the evaluation timestamp', async () => {
  const body = snapshot()
  body.outcomes[0].data[0].timestamp = '2026-10-08T12:00:01Z'
  assert.deepEqual(await read(body), body)
})

test('range boundary is inclusive and offset timestamps use absolute time', async () => {
  const body = snapshot()
  body.outcomes[0].data[0].timestamp = '2026-10-08T20:00:00+09:00'
  assert.deepEqual(await read(body), body)
})
