import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deriveDurableCustodyProofId,
  deriveDurableCustodyScopeId,
} from '@bitcaster-market/client-sdk/durableCustody'
import {
  createCustodyProofSqliteRow,
  decodeCustodyProofSqliteRow,
} from '../src/custodyProofSqliteRow.ts'

const SCOPE_ID = deriveDurableCustodyScopeId({
  scopeKind: 'wallet',
  walletId: '11'.repeat(32),
})

test('proof row codec admits BLS and legacy base64 keysets with exact identities', () => {
  const bls = createRow(`02${'11'.repeat(32)}`, 'bls-secret', null)
  assert.equal(bls.curve, 'bls12-381')
  assert.equal(bls.dleqState, 'not-present')
  assert.equal(decodeCustodyProofSqliteRow(bls).proof.secret, 'bls-secret')

  const legacyKeysetId = 'AbCdEfGhIjKl'
  const legacy = createRow(legacyKeysetId, 'legacy-secret', { e: '11', s: '22' })
  assert.equal(legacy.curve, 'secp256k1')
  assert.equal(legacy.dleqState, 'verified')
  assert.equal(
    legacy.proofId,
    deriveDurableCustodyProofId({
      scopeId: SCOPE_ID,
      normalizedMint: 'https://mint.example',
      unit: 'msat',
      keysetId: legacyKeysetId,
      secret: 'legacy-secret',
    }),
  )
})

test('proof row codec rejects curve and canonical-body substitution', () => {
  const row = createRow('01'.padEnd(66, '1'), 'secp-secret', { e: '11', s: '22' })
  assert.throws(() => decodeCustodyProofSqliteRow({ ...row, curve: 'bls12-381' }), /curve/)
  assert.throws(
    () =>
      decodeCustodyProofSqliteRow({
        ...row,
        proofBody: new TextEncoder().encode('{"schemaVersion":1}'),
      }),
    /proof body/,
  )
})

function createRow(keysetId: string, secret: string, dleq: unknown) {
  return createCustodyProofSqliteRow({
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
    baseAsset: 'sat',
    conditionId: null,
    outcomeSetId: null,
    productBinding: null,
    signatureVerified: true,
    nut07State: 'UNSPENT',
    selectability: 'selectable',
    storageClass: 'pinned-operation-bound-deterministic',
    reservationOperationId: null,
    revision: 0,
    nowMs: 3,
  })
}
