import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveDurableCustodyScopeId } from '@bitcaster-market/client-sdk/durableCustody'
import {
  createCustodyProofSqliteRow,
  decodeCustodyProofSqliteRow,
} from '../src/custodyProofSqliteRow.ts'

const SCOPE_ID = deriveDurableCustodyScopeId({
  scopeKind: 'wallet',
  walletId: '11'.repeat(32),
})

test('proof row codec rejects V3 and legacy keysets before SQLite row construction', () => {
  for (const keysetId of [`02${'11'.repeat(32)}`, 'AbCdEfGhIjKl', '0011223344556677']) {
    assert.throws(() => createRow(keysetId, 'rejected-secret', null), /canonical NUT-02 V2/)
  }
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
    dleqState: dleq === null ? 'not-present' : 'verified',
    nut07State: 'UNSPENT',
    selectability: 'selectable',
    storageClass: 'pinned-operation-bound-deterministic',
    reservationOperationId: null,
    revision: 0,
    nowMs: 3,
  })
}
