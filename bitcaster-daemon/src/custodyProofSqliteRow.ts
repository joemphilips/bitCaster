import {
  DURABLE_CUSTODY_PROOF_BODY_BYTES_MAX,
  createDurableCustodyProofMaterialRecord,
  decodeDurableCustodyProofMaterialRecord,
  type DurableCustodyProofMaterial,
  type DurableCustodyProofMaterialRecord,
} from '@bitcaster-market/client-sdk/durableCustodyProofMaterial'
import type { CustodyProofSqliteRow } from './durableCustodySqliteStore.ts'

export const CUSTODY_PROOF_BODY_BYTES_MAX = DURABLE_CUSTODY_PROOF_BODY_BYTES_MAX
export type CustodyProofMaterial = DurableCustodyProofMaterial

type CustodyProofRowMetadata = Omit<
  CustodyProofSqliteRow,
  | 'proofId'
  | 'keysetId'
  | 'amount'
  | 'proofBody'
  | 'proofFingerprint'
  | 'curve'
  | 'createdAtMs'
  | 'updatedAtMs'
>

export function createCustodyProofSqliteRow(
  input: CustodyProofRowMetadata & {
    readonly proof: CustodyProofMaterial
    readonly nowMs: number
  },
): CustodyProofSqliteRow {
  const material = createDurableCustodyProofMaterialRecord(input)
  const { proof: _, ...withoutProof } = input
  const row = createCustodyProofSqliteRowFromMaterial({
    ...withoutProof,
    material,
  })
  return decodeCustodyProofSqliteRow(row).row
}

export function createCustodyProofSqliteRowFromMaterial(
  input: CustodyProofRowMetadata & {
    readonly material: DurableCustodyProofMaterialRecord
    readonly nowMs: number
  },
): CustodyProofSqliteRow {
  const { material, nowMs, ...metadata } = input
  const { dleqPresence, ...persistedMaterial } = material
  if (
    (metadata.dleqState === 'verified' && dleqPresence !== 'present') ||
    (metadata.dleqState === 'not-present' && dleqPresence !== 'not-present')
  ) {
    throw new Error('custody proof DLEQ verification state lacks matching material')
  }
  const row: CustodyProofSqliteRow = {
    ...metadata,
    ...persistedMaterial,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  }
  return row
}

export function decodeCustodyProofSqliteRow(row: CustodyProofSqliteRow): {
  readonly row: CustodyProofSqliteRow
  readonly proof: Omit<CustodyProofMaterial, 'amount'> & { readonly amount: string }
} {
  const decoded = decodeDurableCustodyProofMaterialRecord({
    scopeId: row.scopeId,
    normalizedMint: row.normalizedMint,
    unit: row.unit,
    proofId: row.proofId,
    keysetId: row.keysetId,
    amount: row.amount,
    proofBody: row.proofBody,
    proofFingerprint: row.proofFingerprint,
    curve: row.curve,
    dleqPresence: row.dleqState === 'verified' ? 'present' : 'not-present',
  })
  return { row: structuredClone(row), proof: decoded.proof }
}
