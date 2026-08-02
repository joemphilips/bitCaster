import assert from 'node:assert/strict'
import test from 'node:test'
import type { Proof } from '@cashu/cashu-ts'
import { prepareMintInputProof } from '../src/mintInputProof.ts'

const BASE_PROOF: Proof = {
  amount: 1,
  id: '00aabbccddeeff00',
  secret: 'plain-secret',
  C: `02${'11'.repeat(32)}`,
}

test('strips private mint input fields without mutating the source proof', () => {
  const source = {
    ...BASE_PROOF,
    witness: { signatures: ['signature'] },
    dleq: { e: '01', s: '02', r: '03' },
    p2pk_e: '04',
  } as Proof
  const before = structuredClone(source)

  const prepared = prepareMintInputProof(source)

  assert.equal(prepared.witness, undefined)
  assert.equal(prepared.dleq, undefined)
  assert.equal(prepared.p2pk_e, undefined)
  assert.deepEqual(source, before)
})

test('serializes a conditional witness for the mint request', () => {
  const source = {
    ...BASE_PROOF,
    secret: JSON.stringify([
      'P2PK',
      { nonce: 'nonce', data: '02'.padEnd(66, '1'), tags: [['sigflag', 'SIG_INPUTS']] },
    ]),
    witness: { signatures: ['signature'] },
  } as Proof

  const prepared = prepareMintInputProof(source)

  assert.equal(prepared.witness, JSON.stringify({ signatures: ['signature'] }))
})
