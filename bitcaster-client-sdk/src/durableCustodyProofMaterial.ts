import { Amount, type AmountLike, type Proof } from '@cashu/cashu-ts'
import {
  deriveDurableCustodyArtifactFingerprint,
  deriveDurableCustodyProofId,
  encodeBoundedDurableArtifact,
} from './durableCustody.ts'
import { assertCanonicalNut02V2KeysetId } from './durableSeedDerivedPolicy.ts'

export const DURABLE_CUSTODY_PROOF_BODY_BYTES_MAX = 64 * 1_024

export interface DurableCustodyProofMaterial {
  readonly id: string
  readonly amount: AmountLike
  readonly secret: string
  readonly C: string
  readonly dleq: unknown | null
  readonly p2pkE: string | null
  readonly witness: unknown | null
}

export interface DurableCustodyProofMaterialRecord {
  readonly proofId: string
  readonly keysetId: string
  readonly amount: number
  readonly proofBody: Uint8Array
  readonly proofFingerprint: string
  readonly curve: 'secp256k1' | 'bls12-381'
  readonly dleqPresence: 'not-present' | 'present'
}

export interface DurableCustodyProofArtifact {
  readonly schemaVersion: 1
  readonly id: string
  readonly amount: string
  readonly secret: string
  readonly C: string
  readonly dleq: unknown | null
  readonly p2pkE: string | null
  readonly witness: unknown | null
}

export function serializeDurableCustodyProofArtifact(proof: Proof): DurableCustodyProofArtifact {
  return normalizeProof({
    id: proof.id,
    amount: proof.amount,
    secret: proof.secret,
    C: proof.C,
    dleq: proof.dleq ?? null,
    p2pkE: proof.p2pk_e ?? null,
    witness: proof.witness ?? null,
  })
}

export function deserializeDurableCustodyProofArtifact(value: unknown): Proof {
  const proof = decodeProofArtifact(value)
  return {
    id: proof.id,
    amount: Amount.from(proof.amount),
    secret: proof.secret,
    C: proof.C,
    ...(proof.dleq === null ? {} : { dleq: structuredClone(proof.dleq) as Proof['dleq'] }),
    ...(proof.p2pkE === null ? {} : { p2pk_e: proof.p2pkE }),
    ...(proof.witness === null
      ? {}
      : { witness: structuredClone(proof.witness) as Proof['witness'] }),
  }
}

export function createDurableCustodyProofMaterialRecord(input: {
  readonly scopeId: string
  readonly normalizedMint: string
  readonly unit: 'sat' | 'msat'
  readonly proof: DurableCustodyProofMaterial
}): DurableCustodyProofMaterialRecord {
  const proof = normalizeProof(input.proof)
  return {
    proofId: deriveDurableCustodyProofId({
      scopeId: input.scopeId,
      normalizedMint: input.normalizedMint,
      unit: input.unit,
      keysetId: proof.id,
      secret: proof.secret,
    }),
    keysetId: proof.id,
    amount: Number(proof.amount),
    proofBody: encodeBoundedDurableArtifact(proof, DURABLE_CUSTODY_PROOF_BODY_BYTES_MAX),
    proofFingerprint: deriveDurableCustodyArtifactFingerprint(proof),
    curve: 'secp256k1',
    dleqPresence: proof.dleq === null ? 'not-present' : 'present',
  }
}

export function decodeDurableCustodyProofMaterialRecord(
  input: {
    readonly scopeId: string
    readonly normalizedMint: string
    readonly unit: 'sat' | 'msat'
  } & DurableCustodyProofMaterialRecord,
): {
  readonly record: DurableCustodyProofMaterialRecord
  readonly proof: Omit<DurableCustodyProofMaterial, 'amount'> & { readonly amount: string }
} {
  const proof = decodeProofBody(input.proofBody)
  const expected = createDurableCustodyProofMaterialRecord({
    scopeId: input.scopeId,
    normalizedMint: input.normalizedMint,
    unit: input.unit,
    proof,
  })
  if (
    input.proofId !== expected.proofId ||
    input.keysetId !== expected.keysetId ||
    input.amount !== expected.amount ||
    input.proofFingerprint !== expected.proofFingerprint
  ) {
    throw new Error('custody proof material authority is foreign')
  }
  if (input.curve !== expected.curve) {
    throw new Error('custody proof material curve is foreign')
  }
  if (input.dleqPresence !== expected.dleqPresence) {
    throw new Error('custody proof material DLEQ presence is foreign')
  }
  return { record: structuredClone(expected), proof }
}

function normalizeProof(value: DurableCustodyProofMaterial): DurableCustodyProofArtifact {
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
  assertCanonicalNut02V2KeysetId(value.id, 'custody proof keyset id')
  const amount = Amount.from(value.amount).toBigInt()
  if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('custody proof amount is invalid')
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
  }
}

function decodeProofBody(body: Uint8Array): Omit<DurableCustodyProofMaterial, 'amount'> & {
  readonly schemaVersion: 1
  readonly amount: string
} {
  if (body.byteLength === 0 || body.byteLength > DURABLE_CUSTODY_PROOF_BODY_BYTES_MAX) {
    throw new Error('custody proof body exceeds its byte limit')
  }
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
  } catch {
    throw new Error('custody proof body encoding is invalid')
  }
  let proof: DurableCustodyProofArtifact
  try {
    proof = decodeProofArtifact(value)
  } catch (error) {
    throw new Error('custody proof body authority is invalid', { cause: error })
  }
  const canonical = encodeBoundedDurableArtifact(proof, DURABLE_CUSTODY_PROOF_BODY_BYTES_MAX)
  if (!equalBytes(canonical, body)) {
    throw new Error('custody proof body is not canonical')
  }
  return proof
}

function decodeProofArtifact(value: unknown): DurableCustodyProofArtifact {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('custody proof artifact schema is invalid')
  }
  if (
    Object.keys(value).sort().join(',') !== 'C,amount,dleq,id,p2pkE,schemaVersion,secret,witness'
  ) {
    throw new Error('custody proof artifact fields are invalid')
  }
  return normalizeProof(value as unknown as DurableCustodyProofMaterial)
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  return left.every((value, index) => value === right[index])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
