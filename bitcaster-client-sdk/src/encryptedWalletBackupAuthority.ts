import type {
  DurableWalletAcknowledgedBackupSnapshot,
  DurableWalletAcknowledgedBackupSnapshotEvidence,
  DurableWalletAuthenticatedBackupReceiptEvidence,
  DurableWalletEncryptedBackupReceipt,
} from './recoverableWalletStorage.ts'

const AUTHENTICATED_BACKUP_RECEIPTS = new WeakMap<object, DurableWalletEncryptedBackupReceipt>()
const ACKNOWLEDGED_BACKUP_SNAPSHOTS = new WeakMap<object, DurableWalletAcknowledgedBackupSnapshot>()

/** Internal protocol authority. This module is deliberately absent from package exports. */
export function issueDurableWalletAuthenticatedBackupReceipt(
  receipt: DurableWalletEncryptedBackupReceipt,
): DurableWalletAuthenticatedBackupReceiptEvidence {
  const evidence = Object.freeze({ state: 'authenticated' as const, receipt })
  AUTHENTICATED_BACKUP_RECEIPTS.set(evidence, receipt)
  return evidence
}

export function requireDurableWalletAuthenticatedBackupReceipt(
  evidence: unknown,
): DurableWalletAuthenticatedBackupReceiptEvidence {
  const receipt =
    typeof evidence === 'object' && evidence !== null
      ? AUTHENTICATED_BACKUP_RECEIPTS.get(evidence)
      : undefined
  if (receipt === undefined) throw new Error('backup receipt evidence is not authenticated')
  return evidence as DurableWalletAuthenticatedBackupReceiptEvidence
}

/** Internal protocol authority. This module is deliberately absent from package exports. */
export function issueDurableWalletAcknowledgedBackupSnapshot(
  snapshot: DurableWalletAcknowledgedBackupSnapshot,
): DurableWalletAcknowledgedBackupSnapshotEvidence {
  const evidence = Object.freeze({ state: 'acknowledged' as const, snapshot })
  ACKNOWLEDGED_BACKUP_SNAPSHOTS.set(evidence, snapshot)
  return evidence
}

export function requireDurableWalletAcknowledgedBackupSnapshot(
  evidence: unknown,
): DurableWalletAcknowledgedBackupSnapshotEvidence {
  const snapshot =
    typeof evidence === 'object' && evidence !== null
      ? ACKNOWLEDGED_BACKUP_SNAPSHOTS.get(evidence)
      : undefined
  if (snapshot === undefined) throw new Error('backup snapshot evidence is not acknowledged')
  return evidence as DurableWalletAcknowledgedBackupSnapshotEvidence
}
