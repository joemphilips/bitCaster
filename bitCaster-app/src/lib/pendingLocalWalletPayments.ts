import type { Proof } from '@cashu/cashu-ts'
import type { CashuProofUnit } from '@bitcaster/client-sdk/marketUnits'
import { replaceProofs, type StoredProof } from '@/stores/proof-db'

export type PendingLocalWalletPaymentStatus =
  | 'pending'
  | 'accepted'
  | 'accepted-but-not-completed'
  | 'completed'

export interface PendingLocalWalletPaymentTarget {
  mintUrl: string
  amountSubunits: number
  baseAsset: string
  unit: CashuProofUnit
  reservationPurpose: string
}

export interface PendingLocalWalletPaymentRecord {
  id: string
  status: PendingLocalWalletPaymentStatus
  sendProofs: Proof[]
  keepProofs: Proof[]
  spentSecrets: string[]
  target: PendingLocalWalletPaymentTarget
  createdAt: number
  updatedAt: number
  lastError?: string | null
}

const STORAGE_KEY = 'bitcaster.pendingLocalWalletPayments.v1'

function now() {
  return Date.now()
}

function readRecords(): PendingLocalWalletPaymentRecord[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as PendingLocalWalletPaymentRecord[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeRecords(records: PendingLocalWalletPaymentRecord[]) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
}

function updateRecord(
  id: string,
  update: (record: PendingLocalWalletPaymentRecord) => PendingLocalWalletPaymentRecord,
) {
  const records = readRecords()
  writeRecords(records.map((record) => (record.id === id ? update(record) : record)))
}

export async function upsertPendingLocalWalletPayment(
  record: PendingLocalWalletPaymentRecord,
): Promise<void> {
  const records = readRecords().filter((existing) => existing.id !== record.id)
  const timestamp = record.updatedAt || now()
  records.push({ ...record, createdAt: record.createdAt || timestamp, updatedAt: timestamp })
  writeRecords(records)
}

export async function markPendingLocalWalletPaymentAccepted(id: string): Promise<void> {
  updateRecord(id, (record) => ({ ...record, status: 'accepted', updatedAt: now(), lastError: null }))
}

export async function markPendingLocalWalletPaymentAcceptedButNotCompleted(
  id: string,
  error: unknown,
): Promise<void> {
  updateRecord(id, (record) => ({
    ...record,
    status: 'accepted-but-not-completed',
    updatedAt: now(),
    lastError: error instanceof Error ? error.message : String(error),
  }))
}

export async function completePendingLocalWalletPayment(id: string): Promise<void> {
  writeRecords(readRecords().filter((record) => record.id !== id))
}

export function getAcceptedButIncompleteLocalWalletPayments(): PendingLocalWalletPaymentRecord[] {
  return readRecords().filter((record) => record.status === 'accepted-but-not-completed')
}

export async function reconcileAcceptedLocalWalletPayments(): Promise<PendingLocalWalletPaymentRecord[]> {
  const incomplete = getAcceptedButIncompleteLocalWalletPayments()
  for (const record of incomplete) {
    try {
      await replaceProofs(
        record.spentSecrets,
        record.keepProofs.map((proof) => ({
          ...proof,
          mintUrl: record.target.mintUrl,
          baseAsset: record.target.baseAsset,
          unit: record.target.unit,
        }) satisfies StoredProof),
      )
      await completePendingLocalWalletPayment(record.id)
    } catch (error) {
      console.warn('[wallet] accepted local-wallet payment still needs reconciliation', {
        id: record.id,
        target: record.target,
        error,
      })
      await markPendingLocalWalletPaymentAcceptedButNotCompleted(record.id, error)
    }
  }
  return getAcceptedButIncompleteLocalWalletPayments()
}
