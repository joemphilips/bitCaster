import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createDurableCustodyProofMaterialRecord,
  decodeDurableCustodyProofMaterialRecord,
} from '../src/durableCustodyProofMaterial.ts'
import { deriveDurableCustodyScopeId } from '../src/durableCustody.ts'

const SCOPE_ID = deriveDurableCustodyScopeId({
  scopeKind: 'wallet',
  walletId: '11'.repeat(32),
})

test('proof material codec derives exact secp256k1 and BLS custody authority', () => {
  const bls = createRecord(`02${'11'.repeat(32)}`, 'bls-secret', null)
  assert.equal(bls.curve, 'bls12-381')
  assert.equal(bls.dleqPresence, 'not-present')
  assert.equal(decode(bls).proof.secret, 'bls-secret')

  const secp = createRecord('AbCdEfGhIjKl', 'secp-secret', { e: '11', s: '22' })
  assert.equal(secp.curve, 'secp256k1')
  assert.equal(secp.dleqPresence, 'present')
  assert.equal(decode(secp).proof.secret, 'secp-secret')
})

test('proof material codec rejects identity, curve, and canonical-body substitution', () => {
  const record = createRecord('01'.padEnd(66, '1'), 'secp-secret', { e: '11', s: '22' })
  assert.throws(() => decode({ ...record, proofId: '00'.repeat(32) }), /authority/)
  assert.throws(() => decode({ ...record, curve: 'bls12-381' }), /curve/)
  assert.throws(
    () => decode({ ...record, proofBody: new TextEncoder().encode('{"schemaVersion":1}') }),
    /proof body/,
  )
})

function createRecord(keysetId: string, secret: string, dleq: unknown) {
  return createDurableCustodyProofMaterialRecord({
    scopeId: SCOPE_ID,
    normalizedMint: 'https://mint.example',
    unit: 'msat',
    proof: {
      id: keysetId,
      amount: '1',
      secret,
      C: 'proof-signature',
      dleq,
      p2pkE: null,
      witness: null,
    },
  })
}

function decode(record: ReturnType<typeof createRecord>) {
  return decodeDurableCustodyProofMaterialRecord({
    scopeId: SCOPE_ID,
    normalizedMint: 'https://mint.example',
    unit: 'msat',
    ...record,
  })
}
