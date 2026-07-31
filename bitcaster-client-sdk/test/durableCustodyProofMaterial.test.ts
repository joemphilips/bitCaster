import assert from 'node:assert/strict'
import test from 'node:test'
import { Amount } from '@cashu/cashu-ts'
import {
  createDurableCustodyProofMaterialRecord,
  decodeDurableCustodyProofMaterialRecord,
  deserializeDurableCustodyProofArtifact,
  serializeDurableCustodyProofArtifact,
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

test('proof artifact codec preserves the Cashu P2PK ephemeral key across restart', () => {
  const proof = {
    id: '01'.padEnd(66, '1'),
    amount: Amount.from(2),
    secret: 'p2pk-secret',
    C: 'proof-signature',
    p2pk_e: `02${'22'.repeat(32)}`,
  }
  const artifact = serializeDurableCustodyProofArtifact(proof)
  assert.equal(artifact.p2pkE, proof.p2pk_e)
  assert.deepEqual(deserializeDurableCustodyProofArtifact(artifact), proof)
  assert.throws(
    () => deserializeDurableCustodyProofArtifact({ ...artifact, p2pk_e: proof.p2pk_e }),
    /fields/,
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
