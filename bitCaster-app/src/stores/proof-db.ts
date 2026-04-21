import Dexie, { type Table } from 'dexie'
import type { Proof } from '@cashu/cashu-ts'

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
    return db.proofs.where('mintUrl').equals(mintUrl).toArray()
  }
  return db.proofs.toArray()
}

export async function addProofs(proofs: StoredProof[]): Promise<void> {
  const now = Date.now()
  const stamped = proofs.map((p) => ({ ...p, receivedAt: p.receivedAt ?? now }))
  await db.proofs.bulkPut(stamped)
}

export async function removeProofs(secrets: string[]): Promise<void> {
  await db.proofs.bulkDelete(secrets)
}
