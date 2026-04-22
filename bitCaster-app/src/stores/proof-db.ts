import Dexie, { type Table } from 'dexie'
import type { Proof } from '@cashu/cashu-ts'
import { normalizeUrl } from '@/lib/url'

export interface StoredProof extends Proof {
  mintUrl: string
  /** Timestamp (ms since epoch) when this proof was added to the wallet */
  receivedAt?: number
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
