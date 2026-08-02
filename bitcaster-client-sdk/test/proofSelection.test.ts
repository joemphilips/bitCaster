import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  computeInputFeeSatsForProofs,
  computeInputFeeSubunitsFromPpk,
  sumProofs,
  takeProofsForLock,
  keysetToOutcomeCollection,
} from '../src/proofSelection.ts'

test('computeInputFeeSubunitsFromPpk returns NUT-02 proof-count fee in keyset subunits', () => {
  assert.equal(computeInputFeeSubunitsFromPpk(10 * 1), 1)
})

test('sumProofs rejects an unsafe amount sum', () => {
  assert.throws(
    () => sumProofs([{ amount: Number.MAX_SAFE_INTEGER }, { amount: 1 }]),
    /safe integer range/i,
  )
})

test('computeInputFeeSatsForProofs rejects an unsafe fee sum', () => {
  const proof = (secret: string) => ({ amount: 1, id: 'keyset', secret, C: secret })
  assert.throws(
    () =>
      computeInputFeeSatsForProofs([proof('a'), proof('b')], {
        keyset: Number.MAX_SAFE_INTEGER,
      }),
    /safe integer range/i,
  )
})

test('takeProofsForLock treats input fees as subunits when computing spendable proof amount', () => {
  const proofs = Array.from({ length: 10 }, (_, index) => ({
    amount: 1_000,
    id: 'msat-keyset',
    secret: `s-${index}`,
    C: `C-${index}`,
  }))

  assert.equal(takeProofsForLock(proofs, 9_999, { 'msat-keyset': 1 })?.length, 10)
  assert.equal(takeProofsForLock(proofs, 10_000, { 'msat-keyset': 1 }), null)
})

test('takeProofsForLock accounts for fragmented-wallet fees in one pass', () => {
  const proofs = Array.from({ length: 10_000 }, (_, index) => ({
    amount: 1,
    id: 'msat-keyset',
    secret: `s-${index}`,
    C: `C-${index}`,
  }))
  let feeReads = 0
  const fees = new Proxy(
    { 'msat-keyset': 1 },
    {
      get(target, property, receiver) {
        feeReads += 1
        return Reflect.get(target, property, receiver)
      },
    },
  )

  assert.equal(takeProofsForLock(proofs, 9_990, fees)?.length, 10_000)
  assert.ok(feeReads <= proofs.length * 2)
})

test('keysetToOutcomeCollection maps each keyset to exactly one outcome collection', () => {
  assert.deepEqual(
    [
      ...keysetToOutcomeCollection(
        [
          { keysetId: 'keyset-a', outcomeCollection: 'A' },
          { keysetId: 'keyset-b', outcomeCollection: 'B|C' },
        ],
        (row) => row,
      ),
    ],
    [
      ['keyset-a', 'A'],
      ['keyset-b', 'B|C'],
    ],
  )
})

test('keysetToOutcomeCollection rejects ambiguous keyset mappings', () => {
  assert.throws(
    () =>
      keysetToOutcomeCollection(
        [
          { keysetId: 'keyset-a', outcomeCollection: 'A' },
          { keysetId: 'keyset-a', outcomeCollection: 'B' },
        ],
        (row) => row,
      ),
    /maps to both A and B/,
  )
})
