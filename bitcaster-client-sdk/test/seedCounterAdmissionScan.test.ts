import assert from 'node:assert/strict'
import test from 'node:test'
import {
  OutputData,
  createBlindSignature,
  createDLEQProof,
  deriveKeysetId,
  pointFromHex,
  type SerializedBlindedMessage,
} from '@cashu/cashu-ts'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  SEED_ADMISSION_SCAN_COUNTERS_MAX,
  SeedAdmissionScanImplausibleError,
  scanSeedCountersForAdmission,
} from '../src/seedCounterAdmissionScan.ts'
import { SEED_COUNTER_GAP_LIMIT, SEED_COUNTER_PROBE_BATCH_MAX } from '../src/seedCounterGapScan.ts'

const SEED = new Uint8Array(64).fill(7)
const PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 9])
const PUBLIC_KEY = bytesToHex(secp256k1.getPublicKey(PRIVATE_KEY, true))
const LARGE_AMOUNT = 2 ** 52
const KEYS = { '1': PUBLIC_KEY, '2': PUBLIC_KEY, [String(LARGE_AMOUNT)]: PUBLIC_KEY }
const KEYSET_ID = deriveKeysetId(KEYS, { unit: 'msat', versionByte: 1 })
const KEYSET = { id: KEYSET_ID, keys: KEYS }

function outputOf(counter: number): string {
  return OutputData.createSingleDeterministicData(0, SEED, counter, KEYSET_ID).blindedMessage.B_
}

/**
 * A NUT-09 mint that signs the outputs that `amountOf` names. The scan does
 * not check a DLEQ (the caller does), so a large scan can omit it.
 */
function signingMint(
  amountOf: (output: SerializedBlindedMessage) => number | null,
  options: { readonly dleq?: boolean } = {},
) {
  const requests: SerializedBlindedMessage[][] = []
  const restore = async (outputs: SerializedBlindedMessage[]) => {
    requests.push(outputs)
    const signed = outputs.flatMap((output) => {
      const amount = amountOf(output)
      return amount === null ? [] : [{ output, amount }]
    })
    return {
      outputs: signed.map(({ output }) => output),
      signatures: signed.map(({ output, amount }) => {
        const blinded = pointFromHex(output.B_)
        const C_ = createBlindSignature(blinded, PRIVATE_KEY, KEYSET_ID).C_.toHex(true)
        if (options.dleq === false) return { id: KEYSET_ID, amount, C_ }
        const dleq = createDLEQProof(blinded, PRIVATE_KEY)
        return { id: KEYSET_ID, amount, C_, dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) } }
      }),
    }
  }
  return { restore, requests }
}

/** A mint that signed the outputs of these counters, each for amount 1. */
function mintThatSigned(counters: readonly number[]) {
  const signed = new Set(counters.map(outputOf))
  return signingMint((output) => (signed.has(output.B_) ? 1 : null))
}

test('a mint that signs every queried output stops at the counter budget and resumes there', async () => {
  // A mint that answers every NUT-09 output with a signature never shows a
  // gap. The pass ends at its counter budget, and the next pass resumes at
  // the counter that the first pass returned.
  const { restore, requests } = signingMint(() => 1, { dleq: false })

  const first = await scanSeedCountersForAdmission({
    restore,
    seed: SEED,
    keyset: KEYSET,
    startCounter: 0,
  })

  assert.equal(first.stop, 'counter-budget')
  assert.equal(first.nextCounter, SEED_ADMISSION_SCAN_COUNTERS_MAX)
  assert.equal(first.lastCounterWithSignature, SEED_ADMISSION_SCAN_COUNTERS_MAX - 1)
  assert.equal(first.proofs.length, SEED_ADMISSION_SCAN_COUNTERS_MAX)
  assert.equal(requests.flat().length, SEED_ADMISSION_SCAN_COUNTERS_MAX)
  assert.ok(requests.every((batch) => batch.length <= SEED_COUNTER_PROBE_BATCH_MAX))

  requests.length = 0
  // A small budget keeps the second pass cheap; it checks the resume position.
  const second = await scanSeedCountersForAdmission({
    restore,
    seed: SEED,
    keyset: KEYSET,
    startCounter: first.nextCounter,
    maxScannedCounters: 10,
  })

  assert.equal(requests[0]![0]!.B_, outputOf(SEED_ADMISSION_SCAN_COUNTERS_MAX))
  assert.equal(second.stop, 'counter-budget')
  assert.equal(second.nextCounter, SEED_ADMISSION_SCAN_COUNTERS_MAX + 10)
  assert.equal(second.proofs.length, 10)
})

test('a scan admits the signed outputs and stops after the gap limit', async () => {
  // Counter 400 lies more than the gap limit after counter 5, so the scan
  // ends before it, as an ordinary NUT-13 restore does.
  const { restore, requests } = mintThatSigned([2, 5, 400])

  const result = await scanSeedCountersForAdmission({
    restore,
    seed: SEED,
    keyset: KEYSET,
    startCounter: 0,
  })

  assert.equal(result.stop, 'gap-limit')
  assert.equal(result.lastCounterWithSignature, 5)
  assert.equal(result.nextCounter, 5 + SEED_COUNTER_GAP_LIMIT + 1)
  assert.equal(requests.flat().length, 5 + SEED_COUNTER_GAP_LIMIT + 1)
  const expectedSecrets = [2, 5].map((counter) =>
    new TextDecoder().decode(
      OutputData.createSingleDeterministicData(0, SEED, counter, KEYSET_ID).secret,
    ),
  )
  assert.deepEqual(
    result.proofs.map(({ secret }) => secret),
    expectedSecrets,
  )
  assert.ok(result.proofs.every(({ id, amount }) => id === KEYSET_ID && amount.toBigInt() === 1n))
})

test('an empty scan from a counter stops after the gap limit with no signature', async () => {
  const { restore, requests } = mintThatSigned([])

  const result = await scanSeedCountersForAdmission({
    restore,
    seed: SEED,
    keyset: KEYSET,
    startCounter: 40,
  })

  assert.deepEqual(result, {
    proofs: [],
    lastCounterWithSignature: null,
    nextCounter: 40 + SEED_COUNTER_GAP_LIMIT,
    stop: 'gap-limit',
  })
  assert.equal(requests[0]![0]!.B_, outputOf(40))
})

test('a signature for an amount that the keyset does not sign stops the scan', async () => {
  const { restore } = signingMint((output) => (output.B_ === outputOf(3) ? 4 : null))

  await assert.rejects(
    scanSeedCountersForAdmission({ restore, seed: SEED, keyset: KEYSET, startCounter: 0 }),
    SeedAdmissionScanImplausibleError,
  )
})

test('restored amounts above the safe total stop the scan', async () => {
  const large = new Set([outputOf(0), outputOf(1)])
  const { restore, requests } = signingMint((output) =>
    large.has(output.B_) ? LARGE_AMOUNT : null,
  )

  await assert.rejects(
    scanSeedCountersForAdmission({ restore, seed: SEED, keyset: KEYSET, startCounter: 0 }),
    SeedAdmissionScanImplausibleError,
  )
  // The scan stops in the batch that crossed the bound.
  assert.equal(requests.length, 1)
})

test('a zero-amount signature stops the scan', async () => {
  const { restore } = signingMint(() => 0)

  await assert.rejects(
    scanSeedCountersForAdmission({ restore, seed: SEED, keyset: KEYSET, startCounter: 0 }),
    /signature does not match its output/,
  )
})

test('a scan refuses a counter budget above the bound', async () => {
  const { restore, requests } = mintThatSigned([])

  await assert.rejects(
    scanSeedCountersForAdmission({
      restore,
      seed: SEED,
      keyset: KEYSET,
      startCounter: 0,
      maxScannedCounters: SEED_ADMISSION_SCAN_COUNTERS_MAX + 1,
    }),
    /counter budget is invalid/,
  )
  assert.equal(requests.length, 0)
})
