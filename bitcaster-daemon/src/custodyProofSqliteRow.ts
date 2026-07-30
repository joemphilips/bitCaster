import { Amount, isBlsKeyset, type AmountLike } from '@cashu/cashu-ts'
import {
  deriveDurableCustodyArtifactFingerprint,
  deriveDurableCustodyProofId,
  encodeBoundedDurableArtifact,
} from '@bitcaster-market/client-sdk/durableCustody'
import type { CustodyProofSqliteRow } from './durableCustodySqliteStore.ts'

export const CUSTODY_PROOF_BODY_BYTES_MAX = 64 * 1_024

export interface CustodyProofMaterial {
  readonly id: string
  readonly amount: AmountLike
  readonly secret: string
  readonly C: string
  readonly dleq: unknown | null
  readonly p2pkE: string | null
  readonly witness: unknown | null
}

type CustodyProofRowMetadata = Omit<
  CustodyProofSqliteRow,
  | 'proofId'
  | 'keysetId'
  | 'amount'
  | 'proofBody'
  | 'proofFingerprint'
  | 'curve'
  | 'dleqState'
  | 'createdAtMs'
  | 'updatedAtMs'
>

export function createCustodyProofSqliteRow(
  input: CustodyProofRowMetadata & {
    readonly proof: CustodyProofMaterial
    readonly nowMs: number
  },
): CustodyProofSqliteRow {
  const proof = normalizeProof(input.proof)
  const body = encodeBoundedDurableArtifact(proof, CUSTODY_PROOF_BODY_BYTES_MAX)
  const { proof: _, nowMs: __, ...metadata } = input
  const row: CustodyProofSqliteRow = {
    ...metadata,
    proofId: deriveDurableCustodyProofId({
      scopeId: input.scopeId,
      normalizedMint: input.normalizedMint,
      unit: input.unit,
      keysetId: proof.id,
      secret: proof.secret,
    }),
    keysetId: proof.id,
    amount: Number(proof.amount),
    proofBody: body,
    proofFingerprint: deriveDurableCustodyArtifactFingerprint(proof),
    curve: isBlsKeyset(proof.id) ? 'bls12-381' : 'secp256k1',
    dleqState: proof.dleq === null ? 'not-present' : 'verified',
    createdAtMs: input.nowMs,
    updatedAtMs: input.nowMs,
  }
  return decodeCustodyProofSqliteRow(row).row
}

export function decodeCustodyProofSqliteRow(row: CustodyProofSqliteRow): {
  readonly row: CustodyProofSqliteRow
  readonly proof: Omit<CustodyProofMaterial, 'amount'> & { readonly amount: string }
} {
  const proof = decodeProofBody(row.proofBody)
  const curve = isBlsKeyset(proof.id) ? 'bls12-381' : 'secp256k1'
  const dleqState = proof.dleq === null ? 'not-present' : 'verified'
  const proofId = deriveDurableCustodyProofId({
    scopeId: row.scopeId,
    normalizedMint: row.normalizedMint,
    unit: row.unit,
    keysetId: proof.id,
    secret: proof.secret,
  })
  if (
    row.proofId !== proofId ||
    row.keysetId !== proof.id ||
    row.amount !== Number(proof.amount) ||
    row.proofFingerprint !== deriveDurableCustodyArtifactFingerprint(proof)
  ) {
    throw new Error('custody proof row authority is foreign')
  }
  if (row.curve !== curve) throw new Error('custody proof row curve is foreign')
  if (row.dleqState !== dleqState || (curve === 'bls12-381' && row.dleqState !== 'not-present')) {
    throw new Error('custody proof row DLEQ authority is foreign')
  }
  return { row: structuredClone(row), proof }
}

function normalizeProof(
  value: CustodyProofMaterial,
): Omit<CustodyProofMaterial, 'amount'> & { readonly amount: string } {
  if (
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    typeof value.secret !== 'string' ||
    value.secret.length === 0 ||
    typeof value.C !== 'string' ||
    value.C.length === 0 ||
    (value.p2pkE !== null && typeof value.p2pkE !== 'string')
  ) {
    throw new Error('custody proof material is invalid')
  }
  const amount = Amount.from(value.amount).toBigInt()
  if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('custody proof amount is invalid')
  }
  if (isBlsKeyset(value.id) && value.dleq !== null) {
    throw new Error('custody BLS proof must not carry secp256k1 DLEQ authority')
  }
  return {
    schemaVersion: 1,
    id: value.id,
    amount: amount.toString(),
    secret: value.secret,
    C: value.C,
    dleq: structuredClone(value.dleq),
    p2pkE: value.p2pkE,
    witness: structuredClone(value.witness),
  } as Omit<CustodyProofMaterial, 'amount'> & {
    readonly schemaVersion: 1
    readonly amount: string
  }
}

function decodeProofBody(
  body: Uint8Array,
): Omit<CustodyProofMaterial, 'amount'> & { readonly amount: string } {
  if (body.byteLength === 0 || body.byteLength > CUSTODY_PROOF_BODY_BYTES_MAX) {
    throw new Error('custody proof body exceeds its byte limit')
  }
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
  } catch {
    throw new Error('custody proof body encoding is invalid')
  }
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('custody proof body schema is invalid')
  }
  const keys = Object.keys(value).sort().join(',')
  if (keys !== 'C,amount,dleq,id,p2pkE,schemaVersion,secret,witness') {
    throw new Error('custody proof body fields are invalid')
  }
  const proof = normalizeProof(value as unknown as CustodyProofMaterial)
  const canonical = encodeBoundedDurableArtifact(proof, CUSTODY_PROOF_BODY_BYTES_MAX)
  if (!Buffer.from(canonical).equals(Buffer.from(body))) {
    throw new Error('custody proof body is not canonical')
  }
  return proof
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
