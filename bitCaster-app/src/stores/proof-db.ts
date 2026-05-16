import Dexie, { type Table } from 'dexie'
import type { Proof, SerializedBlindedMessage } from '@cashu/cashu-ts'
import { normalizeUrl } from '../lib/url'

export interface StoredProof extends Proof {
  mintUrl: string
  /** NUT-CTF condition id when this proof is bound to a conditional keyset. */
  conditionId?: string
  /** NUT-CTF outcome collection label, e.g. "YES" or "Alice|Bob". */
  outcomeCollection?: string
  /** Convenience mirror for the app's per-outcome market id. */
  marketId?: string
  /** Timestamp (ms since epoch) when this proof was added to the wallet */
  receivedAt?: number
}

export interface StoredOutputData {
  blindedMessage: SerializedBlindedMessage
  blindingFactor: string
  secret: string
}

export type ProofOperationKind = 'swap-lock' | 'swap-claim' | 'ctf-split'
export type ProofOperationState = 'prepared' | 'completed' | 'failed'

export interface ProofOperationRecord {
  operationId: string
  kind: ProofOperationKind
  state: ProofOperationState
  mintUrl: string
  inputs: Proof[]
  outputs: Record<string, StoredOutputData[]>
  metadata: Record<string, unknown>
  resultProofs?: Record<string, Proof[]>
  lastError?: string | null
  createdAt: number
  updatedAt: number
}

export interface PrepareProofOperationInput {
  operationId: string
  kind: ProofOperationKind
  mintUrl: string
  inputs: Proof[]
  outputs: Record<string, StoredOutputData[]>
  metadata?: Record<string, unknown>
}

export function isCtfProof(proof: StoredProof | Proof): boolean {
  const candidate = proof as Proof & {
    conditionId?: unknown
    condition_id?: unknown
    outcomeCollection?: unknown
    outcome_collection?: unknown
  }
  return (
    typeof candidate.conditionId === 'string' ||
    typeof candidate.condition_id === 'string' ||
    typeof candidate.outcomeCollection === 'string' ||
    typeof candidate.outcome_collection === 'string'
  )
}

class BitcasterDB extends Dexie {
  proofs!: Table<StoredProof>
  proofOperations!: Table<ProofOperationRecord>

  constructor() {
    super('bitcaster')
    this.version(1).stores({
      proofs: 'secret, id, C, amount, mintUrl',
    })
    this.version(2).stores({
      proofs: 'secret, id, C, amount, mintUrl, receivedAt',
    })
    this.version(3).stores({
      proofs: 'secret, id, C, amount, mintUrl, receivedAt',
      proofOperations: 'operationId, state, kind, mintUrl, updatedAt',
    })
  }
}

export const db = new BitcasterDB()

export async function getProofs(mintUrl?: string): Promise<StoredProof[]> {
  if (mintUrl) {
    return db.proofs.where('mintUrl').equals(normalizeUrl(mintUrl)).toArray()
  }
  return db.proofs.toArray()
}

export async function getBaseProofs(mintUrl?: string): Promise<StoredProof[]> {
  const proofs = await getProofs(mintUrl)
  return proofs.filter((p) => !isCtfProof(p))
}

export async function getOutcomeProofs(
  mintUrl: string,
  conditionId: string,
  outcomeCollection: string,
): Promise<StoredProof[]> {
  const proofs = await getProofs(mintUrl)
  return proofs.filter((p) => {
    const candidate = p as StoredProof & {
      condition_id?: string
      outcome_collection?: string
    }
    const proofConditionId = candidate.conditionId ?? candidate.condition_id
    const proofOutcome =
      candidate.outcomeCollection ?? candidate.outcome_collection
    return (
      proofConditionId === conditionId && proofOutcome === outcomeCollection
    )
  })
}

// Central normalization point — proofs arrive from many receive paths
// (deposit, atomic-swap change, NIP-17 payload) where `mintUrl` may come
// from a decoded token or a raw wallet config. Normalizing on write means
// the balance query (`getProofs(activeMintUrl)`) never has to worry about
// trailing-slash / protocol-case drift.
export async function addProofs(proofs: StoredProof[]): Promise<void> {
  const now = Date.now()
  const stamped = proofs.map((p) => ({
    ...p,
    mintUrl: normalizeUrl(p.mintUrl),
    receivedAt: p.receivedAt ?? now,
  }))
  await db.proofs.bulkPut(stamped)
}

export async function removeProofs(secrets: string[]): Promise<void> {
  await db.proofs.bulkDelete(secrets)
}

// One-shot migration: existing rows may have un-normalized mintUrl values
// stored before addProofs normalized on write. Callers should gate this on
// a persisted flag so it runs once per device.
export async function normalizeStoredMintUrls(): Promise<number> {
  const rows = await db.proofs.toArray()
  let changed = 0
  await db.transaction('rw', db.proofs, async () => {
    for (const row of rows) {
      const normalized = normalizeUrl(row.mintUrl)
      if (normalized !== row.mintUrl) {
        await db.proofs.put({ ...row, mintUrl: normalized })
        changed++
      }
    }
  })
  return changed
}

export async function getProofOperation(
  operationId: string,
): Promise<ProofOperationRecord | null> {
  return (await db.proofOperations.get(operationId)) ?? null
}

export async function prepareProofOperation(
  input: PrepareProofOperationInput,
): Promise<ProofOperationRecord> {
  const existing = await getProofOperation(input.operationId)
  if (existing) {
    assertCompatibleProofOperation(existing, input)
    return existing
  }

  const now = Date.now()
  const record: ProofOperationRecord = {
    operationId: input.operationId,
    kind: input.kind,
    state: 'prepared',
    mintUrl: normalizeUrl(input.mintUrl),
    inputs: structuredClone(input.inputs),
    outputs: structuredClone(input.outputs),
    metadata: structuredClone(input.metadata ?? {}),
    resultProofs: undefined,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  }
  await db.proofOperations.put(record)
  return record
}

export async function markProofOperationCompleted(
  operationId: string,
  resultProofs: Record<string, Proof[]>,
): Promise<ProofOperationRecord> {
  const existing = await getRequiredProofOperation(operationId)
  const updated: ProofOperationRecord = {
    ...existing,
    state: 'completed',
    resultProofs: structuredClone(resultProofs),
    lastError: null,
    updatedAt: Date.now(),
  }
  await db.proofOperations.put(updated)
  return updated
}

export async function markProofOperationFailed(
  operationId: string,
  error: unknown,
): Promise<ProofOperationRecord> {
  const existing = await getRequiredProofOperation(operationId)
  const updated: ProofOperationRecord = {
    ...existing,
    state: 'failed',
    lastError: error instanceof Error ? error.message : String(error),
    updatedAt: Date.now(),
  }
  await db.proofOperations.put(updated)
  return updated
}

async function getRequiredProofOperation(
  operationId: string,
): Promise<ProofOperationRecord> {
  const existing = await getProofOperation(operationId)
  if (!existing) throw new Error(`Missing proof operation ${operationId}`)
  return existing
}

function assertCompatibleProofOperation(
  existing: ProofOperationRecord,
  input: PrepareProofOperationInput,
): void {
  if (
    existing.kind !== input.kind ||
    existing.mintUrl !== normalizeUrl(input.mintUrl) ||
    JSON.stringify(existing.inputs) !== JSON.stringify(input.inputs)
  ) {
    throw new Error(`Proof operation ${input.operationId} already exists with different inputs`)
  }
}
