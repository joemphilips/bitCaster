import Dexie, { type Table } from 'dexie'
import type { Proof } from '@cashu/cashu-ts'
import { normalizeUrl } from '@/lib/url'

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

  constructor() {
    super('bitcaster')
    this.version(1).stores({
      proofs: 'secret, id, C, amount, mintUrl',
    })
    this.version(2).stores({
      proofs: 'secret, id, C, amount, mintUrl, receivedAt',
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
