import type {
  AuthenticatedEncryptedWalletBackupHeadEvidence,
  EncryptedWalletBackupKeyHandle,
} from './encryptedWalletBackup.ts'
import type { EncryptedWalletBackupFrozenSnapshotControl } from './encryptedWalletBackupSnapshotAuthority.ts'
declare const brand: unique symbol
export interface BoundedManifestTargetCapability {
  readonly [brand]: true
}
export interface BoundedManifestTargetAuthority {
  readonly control: EncryptedWalletBackupFrozenSnapshotControl
  readonly parentEvidence: AuthenticatedEncryptedWalletBackupHeadEvidence
  readonly pages: readonly Readonly<{
    formatVersion: 1
    kindCode: 1 | 2
    realm: string
    vaultId: string
    objectId: string
    generation: number
    paddedLength: 65_536 | 262_144
    digest: string
  }>[]
  readonly chunkReferences: readonly Readonly<{ objectId: string; digest: string }>[]
  readonly proofCount: number
  readonly keyHandle: EncryptedWalletBackupKeyHandle
}
const values = new WeakMap<object, BoundedManifestTargetAuthority>()
export function issueBoundedManifestTargetCapability(
  input: BoundedManifestTargetAuthority,
): BoundedManifestTargetCapability {
  const cap = Object.freeze({})
  values.set(
    cap,
    Object.freeze({
      ...input,
      pages: Object.freeze(input.pages.map(compactPageReference)),
      chunkReferences: Object.freeze(input.chunkReferences.map(compactChunkReference)),
    }),
  )
  return cap as BoundedManifestTargetCapability
}

function compactPageReference(
  page: BoundedManifestTargetAuthority['pages'][number],
): BoundedManifestTargetAuthority['pages'][number] {
  return Object.freeze({
    formatVersion: page.formatVersion,
    kindCode: page.kindCode,
    realm: page.realm,
    vaultId: page.vaultId,
    objectId: page.objectId,
    generation: page.generation,
    paddedLength: page.paddedLength,
    digest: page.digest,
  })
}

function compactChunkReference(
  reference: BoundedManifestTargetAuthority['chunkReferences'][number],
): BoundedManifestTargetAuthority['chunkReferences'][number] {
  return Object.freeze({ objectId: reference.objectId, digest: reference.digest })
}
export function requireBoundedManifestTargetCapability(
  value: unknown,
): BoundedManifestTargetAuthority {
  const found = typeof value === 'object' && value !== null ? values.get(value) : undefined
  if (found === undefined) throw new Error('bounded manifest target capability is invalid')
  return found
}
/** Test-only source-path fixture. It is omitted from package exports. */
export const issueBoundedManifestTargetCapabilityForTest = issueBoundedManifestTargetCapability
