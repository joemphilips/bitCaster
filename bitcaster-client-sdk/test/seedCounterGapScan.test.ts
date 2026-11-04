import assert from 'node:assert/strict'
import test from 'node:test'
import { OutputData, type SerializedBlindedMessage } from '@cashu/cashu-ts'
import {
  SEED_COUNTER_GAP_LIMIT,
  SEED_COUNTER_PROBE_BATCH_MAX,
  findLastSignedSeedCounter,
  probeSeedCounterRangeBeforeReservation,
  probeSignedSeedCounters,
  type SeedCounterRestoreClient,
} from '../src/seedCounterGapScan.ts'

const SEED = new Uint8Array(64).fill(7)
const KEYSET_ID = '01'.padEnd(66, 'a')
const OTHER_KEYSET_ID = '01'.padEnd(66, 'b')

/** A mint that signed the NUT-13 outputs of these counters for one keyset. */
function signingMint(signedCounters: Iterable<number>, keysetId = KEYSET_ID) {
  const signed = new Set(
    [...signedCounters].map(
      (counter) =>
        OutputData.createSingleDeterministicData(1, SEED, counter, keysetId).blindedMessage.B_,
    ),
  )
  const requests: SerializedBlindedMessage[][] = []
  const mint: SeedCounterRestoreClient = {
    restore: async ({ outputs }) => {
      requests.push(outputs)
      return { outputs: outputs.filter(({ B_ }) => signed.has(B_)) }
    },
  }
  return { mint, requests }
}

test('a probe names only the counters whose outputs the mint signed', async () => {
  const { mint, requests } = signingMint([3, 5, 250])

  const signed = await probeSignedSeedCounters({
    mint,
    seed: SEED,
    keysetId: KEYSET_ID,
    startCounter: 2,
    count: 4,
  })

  assert.deepEqual(signed, [3, 5])
  assert.equal(requests.length, 1)
  assert.equal(requests[0]!.length, 4)
  assert.ok(requests[0]!.every(({ id }) => id === KEYSET_ID))
})

test('a probe refuses an output that the request did not contain', async () => {
  const foreign = OutputData.createSingleDeterministicData(1, SEED, 0, OTHER_KEYSET_ID)
  const mint: SeedCounterRestoreClient = {
    restore: async () => ({ outputs: [foreign.blindedMessage] }),
  }

  await assert.rejects(
    probeSignedSeedCounters({ mint, seed: SEED, keysetId: KEYSET_ID, startCounter: 0, count: 2 }),
    /foreign output/,
  )
})

test('a gap scan finds the last signed counter and stops after the gap limit', async () => {
  // Counter 360 lies more than the gap limit after counter 40, so the scan
  // ends before it, as an ordinary NUT-13 restore does.
  const { mint, requests } = signingMint([12, 40, 360])

  const last = await findLastSignedSeedCounter({
    mint,
    seed: SEED,
    keysetId: KEYSET_ID,
    startCounter: 10,
  })

  assert.equal(last, 40)
  const scanned = requests.flat().length
  assert.equal(scanned, 40 - 10 + 1 + SEED_COUNTER_GAP_LIMIT)
  assert.ok(requests.every((batch) => batch.length <= SEED_COUNTER_PROBE_BATCH_MAX))
})

test('a gap scan bounds its work when the mint reports every output as signed', async () => {
  const mint: SeedCounterRestoreClient = {
    restore: async ({ outputs }) => ({ outputs }),
  }
  let requests = 0
  const counted: SeedCounterRestoreClient = {
    restore: async (payload) => {
      requests += 1
      return mint.restore(payload)
    },
  }

  const last = await findLastSignedSeedCounter({
    mint: counted,
    seed: SEED,
    keysetId: KEYSET_ID,
    startCounter: 7,
    maxScannedCounters: 250,
  })

  // The scan stops at its bound; a later scan continues from the new cursor.
  assert.equal(last, 7 + 250 - 1)
  assert.equal(requests, 3)
})

test('a gap scan returns null when the mint signed nothing after the start', async () => {
  const { mint } = signingMint([4])

  assert.equal(
    await findLastSignedSeedCounter({ mint, seed: SEED, keysetId: KEYSET_ID, startCounter: 5 }),
    null,
  )
})

test('a clean receive range sends one probe and keeps the counter', async () => {
  const { mint, requests } = signingMint([])
  const advances: number[] = []

  await probeSeedCounterRangeBeforeReservation({
    mint,
    seed: SEED,
    keysetId: KEYSET_ID,
    count: 6,
    readNextCounter: async () => 20,
    advanceCounterTo: async (next) => {
      advances.push(next)
    },
  })

  assert.equal(requests.length, 1)
  assert.equal(requests[0]!.length, 6)
  assert.deepEqual(advances, [])
})

test('a signed receive range advances the counter past the signed outputs and probes again', async () => {
  const { mint, requests } = signingMint([21, 30])
  let next = 20

  await probeSeedCounterRangeBeforeReservation({
    mint,
    seed: SEED,
    keysetId: KEYSET_ID,
    count: 4,
    readNextCounter: async () => next,
    advanceCounterTo: async (value) => {
      next = value
    },
  })

  assert.equal(next, 31)
  // The last request probes the new range [31, 35) and finds it clean.
  const lastProbe = requests.at(-1)!
  assert.equal(lastProbe.length, 4)
  assert.equal(
    lastProbe[0]!.B_,
    OutputData.createSingleDeterministicData(1, SEED, 31, KEYSET_ID).blindedMessage.B_,
  )
})

test('a receive range that stays signed stops after bounded attempts', async () => {
  const { mint } = signingMint([20])

  await assert.rejects(
    probeSeedCounterRangeBeforeReservation({
      mint,
      seed: SEED,
      keysetId: KEYSET_ID,
      count: 1,
      // A counter store that never moves keeps the signed range.
      readNextCounter: async () => 20,
      advanceCounterTo: async () => {},
    }),
    /stay signed/,
  )
})
