import type {
  EncryptedWalletBackupKeyHandle,
  FinalizedEncryptedWalletBackupUploadSet,
} from './encryptedWalletBackup.ts'

interface FinalizedUploadAuthority {
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly targetManifestDigest: string
  readonly uploadAttemptId: string
  readonly localSnapshotId: string
  readonly localSnapshotRevision: number
  readonly canonicalTargetHead: Uint8Array
  readonly canonicalTargetReferenceSet: Uint8Array
}

export interface FinalizedEncryptedWalletBackupUploadAuthority {
  readonly targetManifestDigest: string
  readonly uploadAttemptId: string
  readonly localSnapshotId: string
  readonly localSnapshotRevision: number
  readonly canonicalTargetHead: Uint8Array
  readonly canonicalTargetReferenceSet: Uint8Array
}

const FINALIZED_UPLOAD_SETS = new WeakMap<object, FinalizedUploadAuthority>()

/** Internal capability issuer; deliberately absent from package exports. */
export function issueFinalizedEncryptedWalletBackupUploadSet(
  evidence: FinalizedEncryptedWalletBackupUploadSet,
  keyHandle: EncryptedWalletBackupKeyHandle,
  target: Readonly<{
    canonicalTargetHead: Uint8Array
    canonicalTargetReferenceSet: Uint8Array
  }>,
): FinalizedEncryptedWalletBackupUploadSet {
  FINALIZED_UPLOAD_SETS.set(evidence, {
    keyHandle,
    targetManifestDigest: evidence.targetManifestDigest,
    uploadAttemptId: evidence.uploadAttemptId,
    localSnapshotId: evidence.localSnapshotId,
    localSnapshotRevision: evidence.localSnapshotRevision,
    canonicalTargetHead: target.canonicalTargetHead.slice(),
    canonicalTargetReferenceSet: target.canonicalTargetReferenceSet.slice(),
  })
  return evidence
}

export function readFinalizedEncryptedWalletBackupUploadAuthority(
  value: unknown,
  keyHandle: EncryptedWalletBackupKeyHandle,
): FinalizedEncryptedWalletBackupUploadAuthority {
  const authority =
    typeof value === 'object' && value !== null ? FINALIZED_UPLOAD_SETS.get(value) : undefined
  if (authority === undefined || authority.keyHandle !== keyHandle) {
    throw new Error('finalized backup upload set is invalid')
  }
  return Object.freeze({
    targetManifestDigest: authority.targetManifestDigest,
    uploadAttemptId: authority.uploadAttemptId,
    localSnapshotId: authority.localSnapshotId,
    localSnapshotRevision: authority.localSnapshotRevision,
    canonicalTargetHead: authority.canonicalTargetHead.slice(),
    canonicalTargetReferenceSet: authority.canonicalTargetReferenceSet.slice(),
  })
}

export function requireFinalizedEncryptedWalletBackupUploadSet(
  value: unknown,
  keyHandle: EncryptedWalletBackupKeyHandle,
  targetManifestDigest: string,
  uploadAttemptId: string,
  localSnapshotId: string | null,
  localSnapshotRevision: number | null,
): FinalizedEncryptedWalletBackupUploadSet {
  const authority =
    typeof value === 'object' && value !== null ? FINALIZED_UPLOAD_SETS.get(value) : undefined
  if (
    authority === undefined ||
    authority.keyHandle !== keyHandle ||
    authority.targetManifestDigest !== targetManifestDigest ||
    authority.uploadAttemptId !== uploadAttemptId ||
    authority.localSnapshotId !== localSnapshotId ||
    authority.localSnapshotRevision !== localSnapshotRevision
  ) {
    throw new Error('finalized backup upload set is invalid')
  }
  return value as FinalizedEncryptedWalletBackupUploadSet
}
