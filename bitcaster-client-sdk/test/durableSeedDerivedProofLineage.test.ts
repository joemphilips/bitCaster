import assert from 'node:assert/strict'
import test from 'node:test'
import { OutputData } from '@cashu/cashu-ts'
import {
  locateSeedDerivedProofLineage,
  type LocateSeedDerivedProofLineageInput,
} from '../src/durableSeedDerivedProofLineage.ts'

const KEYSET_ID = `01${'a'.repeat(64)}`
const FOREIGN_KEYSET_ID = `02${'b'.repeat(64)}`
const SEED = Uint8Array.from({ length: 64 }, (_, index) => index + 1)

test('maps exact counter range proofs without proof-order assumptions', () => {
  const ordered = inputForCounters(7, [7, 8, 9])
  const reordered = inputForCounters(7, [9, 7, 8])

  const expected = [
    { schemaVersion: 1, kind: 'nut13', keysetId: KEYSET_ID, counter: 7, secret: secretAt(7) },
    { schemaVersion: 1, kind: 'nut13', keysetId: KEYSET_ID, counter: 8, secret: secretAt(8) },
    { schemaVersion: 1, kind: 'nut13', keysetId: KEYSET_ID, counter: 9, secret: secretAt(9) },
  ]
  assert.deepEqual(locateSeedDerivedProofLineage(ordered), expected)
  assert.deepEqual(locateSeedDerivedProofLineage(reordered), expected)
})

test('returns frozen clone-safe locator records', () => {
  const locators = locateSeedDerivedProofLineage(inputForCounters(3, [3, 4]))
  assert.equal(Object.isFrozen(locators), true)
  assert.equal(Object.isFrozen(locators[0]), true)
  assert.equal(locators[0]!.counter, 3)
  assert.equal(locators[1]!.counter, 4)
})

test('rejects proof sets that are missing, extra, duplicated, foreign, or outside the exact range', () => {
  assertInvalid({ ...inputForCounters(4, [4, 5]), proofs: [proofAt(4)] })
  assertInvalid({ ...inputForCounters(4, [4, 5]), proofs: [proofAt(4), proofAt(5), proofAt(6)] })
  assertInvalid({ ...inputForCounters(4, [4, 5]), proofs: [proofAt(4), proofAt(4)] })
  assertInvalid({
    ...inputForCounters(4, [4, 5]),
    proofs: [proofAt(4), proofAt(5, FOREIGN_KEYSET_ID)],
  })
  assert.throws(
    () => locateSeedDerivedProofLineage(inputForCounters(4, [4, 6])),
    /exact deterministic counter range/,
  )
})

test('rejects malformed counter ranges and excessive counts before derivation', () => {
  for (const input of [
    { ...inputForCounters(0, [0]), counterStart: -1 },
    { ...inputForCounters(0, [0]), counterStart: 0.5 },
    { ...inputForCounters(0, [0]), counterCount: 0 },
    { ...inputForCounters(0, [0]), counterCount: 0.5 },
    { ...inputForCounters(0, [0]), counterCount: 257 },
    { ...inputForCounters(2_147_483_647, [2_147_483_647]), counterCount: 2 },
  ]) {
    assertInvalid(input)
  }
})

test('rejects uppercase, base64, legacy, and malformed keyset IDs before derivation', () => {
  for (const keysetId of [
    KEYSET_ID.toUpperCase(),
    '9mlfd5vCzgGl',
    '0000000000000001',
    `01${'a'.repeat(63)}`,
  ]) {
    assertInvalid({ ...inputForCounters(0, [0]), keysetId })
  }
})

test('rejects non-canonical proof secrets before secret matching', () => {
  for (const secret of [
    `${secretAt(0)}00`,
    `${secretAt(0).slice(0, 63)}é`,
    secretAt(0).toUpperCase(),
    `${secretAt(0).slice(0, 63)}g`,
    secretAt(0).slice(0, 63),
  ]) {
    assertInvalid({
      ...inputForCounters(0, [0]),
      proofs: [{ id: KEYSET_ID, secret }],
    })
  }
})

function inputForCounters(
  counterStart: number,
  proofCounters: readonly number[],
): LocateSeedDerivedProofLineageInput {
  return {
    seed: SEED,
    keysetId: KEYSET_ID,
    counterStart,
    counterCount: proofCounters.length,
    proofs: proofCounters.map((counter) => proofAt(counter)),
  }
}

function proofAt(
  counter: number,
  id = KEYSET_ID,
): { readonly id: string; readonly secret: string } {
  return { id, secret: secretAt(counter) }
}

function secretAt(counter: number): string {
  return new TextDecoder().decode(
    OutputData.createSingleDeterministicData(1, SEED, counter, KEYSET_ID).secret,
  )
}

function assertInvalid(input: unknown): void {
  assert.throws(
    () => locateSeedDerivedProofLineage(input as LocateSeedDerivedProofLineageInput),
    /invalid/,
  )
}
