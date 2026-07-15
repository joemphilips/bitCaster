import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  computeInputFeeSubunitsFromPpk,
  keysetToOutcomeCollection,
  sameCashuProofArtifact,
  takeProofsForLock,
} from '../src/proofSelection.ts'

test('sameCashuProofArtifact compares exact Cashu authority while ignoring client metadata', () => {
  const artifact = {
    id: 'keyset',
    amount: 2,
    secret: 'secret',
    C: 'C',
    dleq: { e: '11', s: '22', r: '33' },
    p2pk_e: `02${'44'.repeat(32)}`,
    witness: { preimage: 'preimage', signatures: ['a', 'b'] },
    reservedBy: 'operation-a',
    receivedAt: 1,
  }

  assert.equal(
    sameCashuProofArtifact(artifact, {
      ...artifact,
      amount: { value: 2n },
      dleq: { r: '33', e: '11', s: '22' },
      witness: { signatures: ['a', 'b'], preimage: 'preimage' },
      reservedBy: 'operation-b',
      receivedAt: 2,
    }),
    true,
  )
})

test('sameCashuProofArtifact rejects every changed Cashu authority field', () => {
  const artifact = {
    id: 'keyset',
    amount: 2,
    secret: 'secret',
    C: 'C',
    dleq: { e: '11', s: '22', r: '33' },
    p2pk_e: `02${'44'.repeat(32)}`,
    witness: { preimage: 'preimage', signatures: ['a', 'b'] },
  }
  const conflicts = [
    { ...artifact, id: 'other-keyset' },
    { ...artifact, amount: 4 },
    { ...artifact, secret: 'other-secret' },
    { ...artifact, C: 'other-C' },
    { ...artifact, dleq: { ...artifact.dleq, e: '44' } },
    { ...artifact, dleq: undefined },
    { ...artifact, p2pk_e: `03${'44'.repeat(32)}` },
    { ...artifact, p2pk_e: undefined },
    { ...artifact, witness: { ...artifact.witness, preimage: 'other' } },
    { ...artifact, witness: { ...artifact.witness, signatures: ['b', 'a'] } },
    { ...artifact, witness: undefined },
  ]

  for (const conflict of conflicts) {
    assert.equal(sameCashuProofArtifact(artifact, conflict), false)
  }
  assert.equal(sameCashuProofArtifact(artifact, undefined), false)
})

test('computeInputFeeSubunitsFromPpk returns NUT-02 proof-count fee in keyset subunits', () => {
  assert.equal(computeInputFeeSubunitsFromPpk(10 * 1), 1)
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

test('keysetToOutcomeCollection maps each keyset to exactly one outcome collection', () => {
  assert.deepEqual(
    [...keysetToOutcomeCollection(
      [
        { keysetId: 'keyset-a', outcomeCollection: 'A' },
        { keysetId: 'keyset-b', outcomeCollection: 'B|C' },
      ],
      (row) => row,
    )],
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
