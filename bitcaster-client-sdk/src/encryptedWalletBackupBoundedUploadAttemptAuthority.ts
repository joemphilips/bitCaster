import type {
  EncryptedWalletBackupKeyHandle,
  PreparedEncryptedWalletBackupManifestTarget,
} from './encryptedWalletBackup.ts'

type BoundedUploadAttemptTargetAuthority = Readonly<{
  keyHandle: EncryptedWalletBackupKeyHandle
  target: PreparedEncryptedWalletBackupManifestTarget
}>

const authorities = new WeakMap<object, BoundedUploadAttemptTargetAuthority>()

/** Registers the target that the bounded finalizer issued for upload setup. */
export function registerBoundedEncryptedWalletBackupUploadAttemptTarget(input: {
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly target: PreparedEncryptedWalletBackupManifestTarget
}): void {
  authorities.set(
    input.target,
    Object.freeze({ keyHandle: input.keyHandle, target: cloneTarget(input.target) }),
  )
}

export function requireBoundedEncryptedWalletBackupUploadAttemptTarget(input: {
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly target: unknown
}): PreparedEncryptedWalletBackupManifestTarget {
  const authority =
    typeof input.target === 'object' && input.target !== null
      ? authorities.get(input.target)
      : undefined
  if (authority === undefined || authority.keyHandle !== input.keyHandle)
    throw new Error('bounded upload attempt target is invalid')
  return authority.target
}

function cloneTarget(
  value: PreparedEncryptedWalletBackupManifestTarget,
): PreparedEncryptedWalletBackupManifestTarget {
  return Object.freeze({
    head: Object.freeze({
      ...value.head,
      parent: value.head.parent === null ? null : Object.freeze({ ...value.head.parent }),
    }),
    wire: Object.freeze({
      canonicalHead: value.wire.canonicalHead.slice(),
      canonicalReferenceSet: value.wire.canonicalReferenceSet.slice(),
    }),
    localSnapshotId: value.localSnapshotId,
    localSnapshotRevision: value.localSnapshotRevision,
    canonicalParentHead: value.canonicalParentHead?.slice() ?? null,
    canonicalInheritedReferenceSet: value.canonicalInheritedReferenceSet.slice(),
  })
}
