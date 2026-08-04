import {
  prepareBoundedEncryptedWalletBackupManifestTarget,
  type AuthenticatedEncryptedWalletBackupHeadEvidence,
  type EncryptedWalletBackupKeyHandle,
  type PreparedEncryptedWalletBackupManifestTarget,
} from '../../src/encryptedWalletBackup.ts'
import { issueBoundedManifestTargetCapabilityForTest } from '../../src/encryptedWalletBackupManifestTargetAuthority.ts'
import type { EncryptedWalletBackupFrozenSnapshotControl } from '../../src/encryptedWalletBackupSnapshotAuthority.ts'

/**
 * Issue a bounded target from the exact pages and chunk references named by a
 * test. This test-only seam is not part of the package surface.
 */
export function prepareBoundedEncryptedWalletBackupTargetForTest(input: {
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly control: EncryptedWalletBackupFrozenSnapshotControl
  readonly parentEvidence: AuthenticatedEncryptedWalletBackupHeadEvidence
  readonly pages: readonly Readonly<{
    readonly formatVersion: 1
    readonly kindCode: 1 | 2
    readonly realm: string
    readonly vaultId: string
    readonly objectId: string
    readonly generation: number
    readonly paddedLength: 65_536 | 262_144
    readonly digest: string
  }>[]
  readonly chunkReferences: readonly Readonly<{ objectId: string; digest: string }>[]
  readonly proofCount: number
}): PreparedEncryptedWalletBackupManifestTarget {
  return prepareBoundedEncryptedWalletBackupManifestTarget({
    keyHandle: input.keyHandle,
    capability: issueBoundedManifestTargetCapabilityForTest(input),
  })
}
