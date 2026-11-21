import assert from 'node:assert/strict'
import test from 'node:test'
import { OutputData, type SerializedBlindedMessage } from '@cashu/cashu-ts'
import {
  SEED_COUNTER_GAP_LIMIT,
  SEED_COUNTER_PROBE_BATCH_MAX,
  SEED_COUNTER_SKIP_AFTER_LAST_SIGNED,
  findLastSignedSeedCounter,
  findSignedSeedOutputs,
  nextSeedCounterAfterLastSigned,
  skipPastSignedSeedOutputs,
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

/** The planned plain outputs of counters [start, start + count) in one keyset. */
function plannedOutputs(keysetId: string, start: number, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    keysetId,
    counter: start + index,
    B_: OutputData.createSingleDeterministicData(1, SEED, start + index, keysetId).blindedMessage
      .B_,
  }))
}

test('a check of more than 100 outputs splits them into requests of at most 100', async () => {
  const planned = [...plannedOutputs(KEYSET_ID, 10, 170), ...plannedOutputs(OTHER_KEYSET_ID, 0, 80)]
  const { mint, requests } = signingMint([12, 175])

  const signed = await findSignedSeedOutputs(mint, planned)

  assert.deepEqual(
    requests.map((request) => request.length),
    [SEED_COUNTER_PROBE_BATCH_MAX, SEED_COUNTER_PROBE_BATCH_MAX, 50],
  )
  assert.deepEqual(
    new Set(requests.flat().map(({ B_ }) => B_)),
    new Set(planned.map(({ B_ }) => B_)),
  )
  // Counter 175 is in the second request.
  assert.deepEqual(
    signed.map(({ keysetId, counter }) => [keysetId, counter]),
    [
      [KEYSET_ID, 12],
      [KEYSET_ID, 175],
    ],
  )
  // Each request output carries amount 1 and its own keyset.
  assert.ok(requests.flat().every(({ amount }) => amount.toBigInt() === 1n))
  assert.ok(requests[2]!.every(({ id }) => id === OTHER_KEYSET_ID))
})

test('a check sends no request for an empty plan and refuses a duplicate output', async () => {
  const { mint, requests } = signingMint([])

  assert.deepEqual(await findSignedSeedOutputs(mint, []), [])
  assert.equal(requests.length, 0)
  const [output] = plannedOutputs(KEYSET_ID, 0, 1)
  await assert.rejects(findSignedSeedOutputs(mint, [output!, output!]), /planned seed outputs/)
})

test('a check refuses an output that the request did not contain', async () => {
  const foreign = OutputData.createSingleDeterministicData(1, SEED, 0, OTHER_KEYSET_ID)
  const mint: SeedCounterRestoreClient = {
    restore: async () => ({ outputs: [foreign.blindedMessage] }),
  }

  await assert.rejects(
    findSignedSeedOutputs(mint, plannedOutputs(KEYSET_ID, 0, 2)),
    /foreign output/,
  )
})

test('a skip passes the last signed output and the 150 counters after it', async () => {
  // Counter 360 lies more than the gap limit after counter 40, so the scan
  // does not see it.
  const { mint } = signingMint([12, 40, 360])

  const skip = await skipPastSignedSeedOutputs({
    mint,
    seed: SEED,
    keysetId: KEYSET_ID,
    fromCounter: 10,
    signedCounters: [12],
  })

  assert.deepEqual(skip, {
    keysetId: KEYSET_ID,
    fromCounter: 10,
    lastSignedCounter: 40,
    nextCounter: 40 + 1 + SEED_COUNTER_SKIP_AFTER_LAST_SIGNED,
  })
  // Counters 41 to 190 stay unused.
  assert.equal(skip.nextCounter, 191)
})

test('a skip passes a signed output that no gap scan sees', async () => {
  // An authorization output is not a plain output, so the scan finds nothing.
  const { mint } = signingMint([])

  const skip = await skipPastSignedSeedOutputs({
    mint,
    seed: SEED,
    keysetId: KEYSET_ID,
    fromCounter: 10,
    signedCounters: [11],
  })

  assert.equal(skip.lastSignedCounter, 11)
  assert.equal(skip.nextCounter, 11 + 1 + SEED_COUNTER_SKIP_AFTER_LAST_SIGNED)
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

test('the ADR-051 cursor rule continues 151 counters after the last signed counter, or at 150', () => {
  // The cursor is the last counter treated as used; the next output uses the cursor plus 1.
  assert.equal(nextSeedCounterAfterLastSigned(null), SEED_COUNTER_SKIP_AFTER_LAST_SIGNED)
  assert.equal(nextSeedCounterAfterLastSigned(0), 151)
  assert.equal(nextSeedCounterAfterLastSigned(169), 320)
  assert.throws(() => nextSeedCounterAfterLastSigned(-1), /counter/)
})
