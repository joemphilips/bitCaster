import assert from 'node:assert/strict'
import test from 'node:test'
import { reserveAndConstructDurableSeedDerivedOutputs } from '../src/durableSeedDerivedOutputs.ts'
import { createSpeculativeCounterTranscript } from '../src/speculativeCounterTranscript.ts'

const KEYSET_A = `01${'a'.repeat(64)}`
const KEYSET_B = `01${'b'.repeat(64)}`
const KEYSET = {
  id: KEYSET_A,
  keys: { '1': '02', '2': '02', '3': '02', '5': '02', '8': '02' },
}
const SEED = Uint8Array.from({ length: 64 }, (_, index) => index + 1)
const EXPECTED_OUTPUTS = [
  {
    blindedMessage: {
      amount: '2',
      B_: '033fe0297ba383d159d43eefac3acacc55d215e6f2ef42d7effb2c7c22704b8a30',
      id: KEYSET_A,
    },
    blindingFactor: '54515584811661841423827861900725653246175490062131016816624642192549811714631',
    secret:
      '63613839353466646130333237643739663134343666313134666135323464623461376638613334363035643139313734333062323062656535633232653130',
  },
  {
    blindedMessage: {
      amount: '3',
      B_: '03cf187302c91cc12435c9018b8809b719cafa082d636cf350b2a739e336969035',
      id: KEYSET_A,
    },
    blindingFactor: '62468515496866187220814793985816019543408840396334309021920478142270373086942',
    secret:
      '31663166306432383736666137366638643962646135353932363763316439326665353631623964393563363564643930303339343763316531373564396631',
  },
]

test('composes with the existing deterministic output builder', async () => {
  const transcript = createSpeculativeCounterTranscript([{ keysetId: KEYSET_A, nextCounter: 7 }])
  const actual = await reserveAndConstructDurableSeedDerivedOutputs({
    seed: SEED,
    counterSource: transcript.counterSource,
    keyset: KEYSET,
    amounts: [2, 3],
  })
  assert.equal(actual.plan.counterStart, 7)
  assert.equal(actual.plan.counterCount, 2)
  assert.deepEqual(actual.plan.outputs, EXPECTED_OUTPUTS)
  assert.deepEqual(transcript.allocations(), [
    { ordinal: 0, keysetId: KEYSET_A, start: 7, count: 2 },
  ])
  assert.deepEqual(transcript.changes(), [
    { keysetId: KEYSET_A, expectedNextCounter: 7, nextCounter: 9 },
  ])
})

test('allocates ordered disjoint ranges for repeated keysets and preserves missing rows', async () => {
  const transcript = createSpeculativeCounterTranscript([
    { keysetId: KEYSET_A, nextCounter: 7 },
    { keysetId: KEYSET_B, nextCounter: null },
  ])

  assert.deepEqual(await transcript.counterSource.reserve(KEYSET_A, 2), { start: 7, count: 2 })
  assert.deepEqual(await transcript.counterSource.reserve(KEYSET_B, 1), { start: 0, count: 1 })
  assert.deepEqual(await transcript.counterSource.reserve(KEYSET_A, 3), { start: 9, count: 3 })
  assert.deepEqual(await transcript.counterSource.reserve(KEYSET_B, 0), { start: 1, count: 0 })

  assert.deepEqual(transcript.allocations(), [
    { ordinal: 0, keysetId: KEYSET_A, start: 7, count: 2 },
    { ordinal: 1, keysetId: KEYSET_B, start: 0, count: 1 },
    { ordinal: 2, keysetId: KEYSET_A, start: 9, count: 3 },
  ])
  assert.deepEqual(transcript.snapshots(), [
    { keysetId: KEYSET_A, nextCounter: 7 },
    { keysetId: KEYSET_B, nextCounter: null },
  ])
  assert.deepEqual(transcript.changes(), [
    { keysetId: KEYSET_A, expectedNextCounter: 7, nextCounter: 12 },
    { keysetId: KEYSET_B, expectedNextCounter: null, nextCounter: 1 },
  ])
  assert.equal(transcript.kind, 'private-speculative-counter-transcript')
})

test('empty allocations do not create a provider change or transcript row', async () => {
  const transcript = createSpeculativeCounterTranscript([{ keysetId: KEYSET_A, nextCounter: 0 }])
  assert.deepEqual(await transcript.counterSource.reserve(KEYSET_A, 0), { start: 0, count: 0 })
  assert.deepEqual(transcript.allocations(), [])
  assert.deepEqual(transcript.changes(), [])
})

test('refuses undeclared keysets, invalid counts, and gaps', async () => {
  const transcript = createSpeculativeCounterTranscript([{ keysetId: KEYSET_A, nextCounter: 4 }])
  await assert.rejects(transcript.counterSource.reserve(KEYSET_B, 1), /not declared/)
  await assert.rejects(transcript.counterSource.reserve(KEYSET_A, -1), /allocation is invalid/)
  await transcript.counterSource.advanceToAtLeast(KEYSET_A, 3)
  await assert.rejects(transcript.counterSource.advanceToAtLeast(KEYSET_A, 5), /unallocated gap/)
  assert.deepEqual(transcript.allocations(), [])
})

test('refuses malformed or duplicate snapshots', () => {
  assert.throws(() => createSpeculativeCounterTranscript([]), /snapshot is invalid/)
  assert.throws(
    () =>
      createSpeculativeCounterTranscript([
        { keysetId: KEYSET_A, nextCounter: null },
        { keysetId: KEYSET_A, nextCounter: 0 },
      ]),
    /snapshot is invalid/,
  )
  assert.throws(
    () => createSpeculativeCounterTranscript([{ keysetId: KEYSET_A, nextCounter: -1 }]),
    /snapshot is invalid/,
  )
})

test('reads each snapshot property once before validating or retaining it', () => {
  let keysetReads = 0
  let nextCounterReads = 0
  const snapshot = {
    get keysetId() {
      keysetReads += 1
      return keysetReads === 1 ? KEYSET_A : KEYSET_B
    },
    get nextCounter() {
      nextCounterReads += 1
      return nextCounterReads === 1 ? 3 : 99
    },
  }
  const transcript = createSpeculativeCounterTranscript([snapshot])
  assert.equal(keysetReads, 1)
  assert.equal(nextCounterReads, 1)
  assert.deepEqual(transcript.snapshots(), [{ keysetId: KEYSET_A, nextCounter: 3 }])
})

test('enforces the allocation-record bound without counting empty ranges', async () => {
  const transcript = createSpeculativeCounterTranscript([{ keysetId: KEYSET_A, nextCounter: 0 }])
  for (let index = 0; index < 256; index += 1) {
    await transcript.counterSource.reserve(KEYSET_A, 1)
  }
  await transcript.counterSource.reserve(KEYSET_A, 0)
  assert.equal(transcript.allocations().length, 256)
  assert.equal(
    transcript.allocations().reduce((sum, range) => sum + range.count, 0),
    256,
  )
  await assert.rejects(transcript.counterSource.reserve(KEYSET_A, 1), /range is exhausted/)
  assert.equal(transcript.allocations().length, 256)
})

test('permits the final NUT-13 counter and refuses overflow', async () => {
  const transcript = createSpeculativeCounterTranscript([
    { keysetId: KEYSET_A, nextCounter: 2_147_483_647 },
  ])
  assert.deepEqual(await transcript.counterSource.reserve(KEYSET_A, 1), {
    start: 2_147_483_647,
    count: 1,
  })
  assert.deepEqual(transcript.changes(), [
    { keysetId: KEYSET_A, expectedNextCounter: 2_147_483_647, nextCounter: 2_147_483_648 },
  ])
  await assert.rejects(transcript.counterSource.reserve(KEYSET_A, 1), /range is exhausted/)
})

test('returned transcript views cannot mutate internal snapshot or allocation state', async () => {
  const transcript = createSpeculativeCounterTranscript([{ keysetId: KEYSET_A, nextCounter: 2 }])
  await transcript.counterSource.reserve(KEYSET_A, 1)
  const snapshot = transcript.snapshots()
  const allocations = transcript.allocations()
  assert.equal(Reflect.set(snapshot[0]!, 'nextCounter', 99), false)
  assert.equal(Reflect.set(allocations[0]!, 'start', 99), false)
  assert.deepEqual(transcript.changes(), [
    { keysetId: KEYSET_A, expectedNextCounter: 2, nextCounter: 3 },
  ])
})
