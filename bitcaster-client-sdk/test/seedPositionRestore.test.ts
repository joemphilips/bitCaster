import assert from 'node:assert/strict'
import test from 'node:test'
import { OutputData, type SerializedBlindedMessage } from '@cashu/cashu-ts'
import { deriveRootCtfOutcomeCollectionId } from '../src/durableCtfRangeOperation.ts'
import {
  SEED_POSITION_PROBE_COUNTERS,
  listSeedRestoreConditionKeysets,
  probeSeedRestoreKeysets,
  readSeedRestoreCataloguePage,
  readSeedRestoreMintConditionPage,
  seedRestoreMarketFromCatalogueEntry,
} from '../src/seedPositionRestore.ts'

const SEED = Uint8Array.from({ length: 64 }, (_, index) => index + 1)
const CONDITION = 'ab'.repeat(32)
const OTHER_CONDITION = 'cd'.repeat(32)

function descriptor(input: {
  id: string
  conditionId?: string
  outcomeCollection: string
  unit?: string
  outcomeCollectionId?: string
}) {
  const conditionId = input.conditionId ?? CONDITION
  return {
    id: input.id,
    unit: input.unit ?? 'msat',
    active: false,
    input_fee_ppk: 100,
    condition_id: conditionId,
    outcome_collection: input.outcomeCollection,
    outcome_collection_id:
      input.outcomeCollectionId ??
      deriveRootCtfOutcomeCollectionId({
        conditionId,
        outcomeCollection: input.outcomeCollection,
      }),
    registered_at: 1_700_000_000,
  }
}

function keysetId(byte: string): string {
  return `01${byte.repeat(32)}`
}

test('keeps only bitCaster markets from a catalogue page and reads every state', async () => {
  const requests: { url: string; init: RequestInit | undefined }[] = []
  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    requests.push({ url: String(url), init })
    return new Response(
      JSON.stringify({
        markets: [
          { conditionId: CONDITION, outcomes: ['YES', 'NO'], state: 'Closed' },
          { conditionId: OTHER_CONDITION, outcomes: ['A', 'B', 'C'], state: 'Open' },
          { conditionId: 'not-hex', outcomes: ['YES', 'NO'] },
          { conditionId: 'ef'.repeat(32), outcomes: ['ONLY'] },
          { conditionId: '12'.repeat(32), outcomes: Array.from({ length: 9 }, (_, i) => `O${i}`) },
          { conditionId: '34'.repeat(32), outcomes: ['YES', 'YES'] },
          { conditionId: '56'.repeat(32), outcomes: ['A|B', 'C'] },
          { conditionId: CONDITION, outcomes: ['YES', 'NO'] },
        ],
        nextCursor: 'next-page',
        lastSuccessfulRefreshAt: '2026-11-04T00:00:00Z',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch

  const page = await readSeedRestoreCataloguePage({
    engineBaseUrl: 'https://engine.example',
    fetchImpl,
    cursor: 'first',
  })

  assert.deepEqual(page.markets, [
    { conditionId: CONDITION, outcomes: ['YES', 'NO'] },
    { conditionId: OTHER_CONDITION, outcomes: ['A', 'B', 'C'] },
  ])
  assert.equal(page.foreign, 6)
  assert.equal(page.nextCursor, 'next-page')
  const url = new URL(requests[0]!.url)
  assert.equal(url.pathname, '/api/v1/markets/query')
  assert.equal(url.searchParams.get('state'), 'All')
  assert.equal(url.searchParams.get('sort'), 'New')
  assert.equal(url.searchParams.get('page_size'), '50')
  assert.equal(url.searchParams.get('cursor'), 'first')
  // The catalogue read is anonymous: no NIP-98 or other identity header.
  assert.deepEqual(requests[0]!.init?.headers, { Accept: 'application/json' })
})

test('rejects a catalogue entry that is not a bitCaster market', () => {
  assert.equal(seedRestoreMarketFromCatalogueEntry(null), null)
  assert.equal(seedRestoreMarketFromCatalogueEntry({ conditionId: CONDITION }), null)
  assert.equal(
    seedRestoreMarketFromCatalogueEntry({ conditionId: CONDITION, outcomes: [' YES', 'NO'] }),
    null,
  )
})

test('skips a foreign descriptor and keeps the bitCaster keysets of one condition', async () => {
  const queries: unknown[] = []
  const listing = await listSeedRestoreConditionKeysets({
    conditionId: CONDITION,
    outcomes: ['YES', 'NO'],
    mint: {
      async getConditionalKeysets(query) {
        queries.push(query)
        return {
          keysets: [
            descriptor({ id: keysetId('11'), outcomeCollection: 'YES' }),
            descriptor({ id: keysetId('22'), outcomeCollection: 'NO' }),
            // A collection outside the catalogue outcomes.
            descriptor({ id: keysetId('33'), outcomeCollection: 'MAYBE' }),
            // The full set is not a position keyset.
            descriptor({ id: keysetId('44'), outcomeCollection: 'NO|YES' }),
            // A wrong unit.
            descriptor({ id: keysetId('55'), outcomeCollection: 'YES', unit: 'sat' }),
            // An identity that does not match the condition.
            descriptor({
              id: keysetId('66'),
              outcomeCollection: 'YES',
              outcomeCollectionId: 'ff'.repeat(32),
            }),
            // Another condition.
            descriptor({
              id: keysetId('77'),
              outcomeCollection: 'YES',
              conditionId: OTHER_CONDITION,
            }),
            { id: 'malformed' },
          ],
          next_cursor: null,
        }
      },
    },
  })

  assert.deepEqual(
    listing.keysets.map(({ id, outcomeCollection, active }) => ({ id, outcomeCollection, active })),
    [
      { id: keysetId('11'), outcomeCollection: 'YES', active: false },
      { id: keysetId('22'), outcomeCollection: 'NO', active: false },
    ],
  )
  assert.equal(listing.foreign, 6)
  assert.deepEqual(queries, [{ condition_id: CONDITION, limit: 100 }])
})

test('without a catalogue it keeps only a one-vs-rest set of 2 to 8 outcomes', async () => {
  const mint = (keysets: unknown[]) => ({
    async getConditionalKeysets() {
      return { keysets, next_cursor: null }
    },
  })
  const threeOutcomes = await listSeedRestoreConditionKeysets({
    conditionId: CONDITION,
    outcomes: null,
    mint: mint([
      descriptor({ id: keysetId('11'), outcomeCollection: 'A' }),
      descriptor({ id: keysetId('12'), outcomeCollection: 'B|C' }),
      descriptor({ id: keysetId('13'), outcomeCollection: 'B' }),
      descriptor({ id: keysetId('14'), outcomeCollection: 'A|C' }),
      descriptor({ id: keysetId('15'), outcomeCollection: 'C' }),
      descriptor({ id: keysetId('16'), outcomeCollection: 'A|B' }),
    ]),
  })
  assert.equal(threeOutcomes.keysets.length, 6)
  assert.equal(threeOutcomes.foreign, 0)

  const notOneVsRest = await listSeedRestoreConditionKeysets({
    conditionId: CONDITION,
    outcomes: null,
    mint: mint([
      descriptor({ id: keysetId('21'), outcomeCollection: 'A' }),
      descriptor({ id: keysetId('22'), outcomeCollection: 'B' }),
      descriptor({ id: keysetId('23'), outcomeCollection: 'C' }),
      descriptor({ id: keysetId('24'), outcomeCollection: 'D' }),
      // A two-member range of four outcomes is not one-vs-rest.
      descriptor({ id: keysetId('25'), outcomeCollection: 'A|B' }),
    ]),
  })
  assert.deepEqual(notOneVsRest.keysets, [])
  assert.equal(notOneVsRest.foreign, 5)

  const nineOutcomes = await listSeedRestoreConditionKeysets({
    conditionId: CONDITION,
    outcomes: null,
    mint: mint(
      Array.from({ length: 9 }, (_, index) =>
        descriptor({ id: keysetId(`3${index}`), outcomeCollection: `O${index}` }),
      ),
    ),
  })
  assert.deepEqual(nineOutcomes.keysets, [])
})

test('reads condition ids from the unfiltered mint listing', async () => {
  const page = await readSeedRestoreMintConditionPage({
    cursor: null,
    mint: {
      async getConditionalKeysets() {
        return {
          keysets: [
            descriptor({ id: keysetId('11'), outcomeCollection: 'YES' }),
            descriptor({ id: keysetId('12'), outcomeCollection: 'NO' }),
            descriptor({
              id: keysetId('13'),
              outcomeCollection: 'YES',
              conditionId: OTHER_CONDITION,
            }),
            descriptor({ id: keysetId('14'), outcomeCollection: 'YES', unit: 'sat' }),
          ],
          next_cursor: 'later',
        }
      },
    },
  })
  assert.deepEqual(page, {
    conditionIds: [CONDITION, OTHER_CONDITION],
    foreign: 1,
    nextCursor: 'later',
  })
})

function fakeRestore(signed: ReadonlySet<string>, requests: SerializedBlindedMessage[][]) {
  return async (outputs: SerializedBlindedMessage[]) => {
    requests.push(outputs)
    const matched = outputs.filter(({ B_ }) => signed.has(B_))
    return {
      outputs: matched,
      signatures: matched.map((output) => ({
        id: output.id,
        amount: 4,
        C_: `02${'aa'.repeat(32)}`,
      })),
    }
  }
}

function blindedSecret(keyset: string, counter: number): string {
  return OutputData.createSingleDeterministicData(0, SEED, counter, keyset).blindedMessage.B_
}

test('finds the highest signed counter in each probe window', async () => {
  const held = keysetId('11')
  const empty = keysetId('22')
  const late = keysetId('33')
  const signed = new Set([
    blindedSecret(held, 0),
    blindedSecret(held, 5),
    // The first signature lies after the probe window, so the probe misses it.
    blindedSecret(late, SEED_POSITION_PROBE_COUNTERS + 2),
  ])
  const requests: SerializedBlindedMessage[][] = []
  let yields = 0

  const highest = await probeSeedRestoreKeysets({
    seed: SEED,
    targets: [held, empty, late].map((id) => ({
      keysetId: id,
      start: 0,
      count: SEED_POSITION_PROBE_COUNTERS,
    })),
    restore: fakeRestore(signed, requests),
    maxOutputsPerRequest: 200,
    yieldControl: async () => {
      yields += 1
    },
  })

  assert.deepEqual(Object.fromEntries(highest), { [held]: 5, [empty]: null, [late]: null })
  assert.deepEqual(
    requests.map((request) => request.length),
    [200, 184],
  )
  assert.ok(yields >= 6)
  // A probe output carries only a keyset id, an amount, and a blinded secret.
  for (const output of requests.flat()) {
    assert.deepEqual(Object.keys(output).sort(), ['B_', 'amount', 'id'])
  }
})

test('probes a window above a local cursor', async () => {
  const used = keysetId('44')
  const requests: SerializedBlindedMessage[][] = []
  const highest = await probeSeedRestoreKeysets({
    seed: SEED,
    targets: [{ keysetId: used, start: 40, count: 100 }],
    restore: fakeRestore(new Set([blindedSecret(used, 39), blindedSecret(used, 77)]), requests),
  })
  assert.equal(highest.get(used), 77)
  assert.equal(requests.flat().length, 100)
})

test('refuses a foreign NUT-09 response', async () => {
  await assert.rejects(
    probeSeedRestoreKeysets({
      seed: SEED,
      targets: [{ keysetId: keysetId('55'), start: 0, count: 2 }],
      restore: async () => ({
        outputs: [{ id: keysetId('55'), amount: 0, B_: `02${'bb'.repeat(32)}` }],
        signatures: [{ id: keysetId('55'), amount: 4, C_: `02${'aa'.repeat(32)}` }],
      }),
    }),
    /foreign/,
  )
})
