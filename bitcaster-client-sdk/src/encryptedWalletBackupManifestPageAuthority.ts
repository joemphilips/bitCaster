import { decode } from 'cborg'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  encodeCanonicalBackupCbor as encodeCanonical,
  preflightEncryptedManifestPageCbor,
} from './encryptedWalletBackupCbor.ts'

declare const encryptedWalletBackupManifestPageBoundaryBrand: unique symbol

/** Opaque authority for one exact persisted Pass-A page boundary. */
export interface EncryptedWalletBackupManifestPageBoundary {
  readonly [encryptedWalletBackupManifestPageBoundaryBrand]: true
}

interface BoundaryAuthority {
  readonly realm: string
  readonly vaultId: string
  readonly snapshotId: string
  readonly snapshotRevision: number
  readonly sealedControlVersion: number
  readonly sealRunRevision: number
  readonly sealedControlDigest: string
  readonly resultDigest: string
  readonly generation: number
  readonly snapshotNonce: string
  readonly pageIndex: number
  readonly pageCount: number
  readonly entryCount: number
  readonly canonicalEntryBytes: number
  readonly plannedCanonicalPageBytes: number
}

interface ManifestPageProvenance {
  readonly boundary: EncryptedWalletBackupManifestPageBoundary
  readonly canonicalPageBytes: number
  readonly canonicalPageDigest: string
}

const RESULT_BOUNDARIES = new WeakMap<
  object,
  readonly EncryptedWalletBackupManifestPageBoundary[]
>()
const BOUNDARY_AUTHORITIES = new WeakMap<object, BoundaryAuthority>()
const PAGE_PROVENANCE = new WeakMap<object, ManifestPageProvenance>()

export function measureFinalManifestEntryBytes(canonicalPreparedEntry: Uint8Array): number {
  return finalManifestEntryBytes(canonicalPreparedEntry, new Uint8Array(16), new Uint8Array(32))
    .byteLength
}

export function finalManifestEntryBytes(
  canonicalPreparedEntry: Uint8Array,
  chunkObjectId: Uint8Array,
  chunkDigest: Uint8Array,
): Uint8Array {
  const entry = requirePreparedEntry(canonicalPreparedEntry)
  requireReference(chunkObjectId, 16, 'object id')
  requireReference(chunkDigest, 32, 'digest')
  const result = encodeCanonical([
    entry[1],
    entry[2],
    chunkObjectId.slice(),
    chunkDigest.slice(),
    entry[3],
    entry[4],
    entry[5],
    entry[6],
    entry[7],
    entry[8],
    entry[9],
  ])
  preflightEncryptedManifestPageCbor(
    encodeCanonical([1, 2, 1, new Uint8Array(16), 0, 1, [decode(result)]]),
  )
  return result
}

export function registerEncryptedWalletBackupManifestPassABoundaries(input: {
  readonly result: object
  readonly resultDigest: string
  readonly realm: string
  readonly vaultId: string
  readonly snapshotId: string
  readonly snapshotRevision: number
  readonly sealedControlVersion: number
  readonly sealRunRevision: number
  readonly sealedControlDigest: string
  readonly generation: number
  readonly snapshotNonce: string
  readonly boundaries: readonly Readonly<{
    readonly entryCount: number
    readonly canonicalEntryBytes: number
    readonly plannedCanonicalPageBytes: number
  }>[]
}): void {
  if (RESULT_BOUNDARIES.has(input.result)) return
  const boundaries = input.boundaries.map((boundary, pageIndex) =>
    issueBoundary(input, boundary, pageIndex),
  )
  RESULT_BOUNDARIES.set(input.result, Object.freeze(boundaries))
}

export function readEncryptedWalletBackupManifestPassABoundary(
  result: object,
  pageIndex: number,
): EncryptedWalletBackupManifestPageBoundary {
  const boundaries = RESULT_BOUNDARIES.get(result)
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || boundaries === undefined)
    throw new Error('backup manifest Pass-A boundary is invalid')
  const boundary = boundaries[pageIndex]
  if (boundary === undefined) throw new Error('backup manifest Pass-A boundary is invalid')
  return boundary
}

export function requireEncryptedWalletBackupManifestPageBoundary(
  value: unknown,
): Readonly<BoundaryAuthority> {
  const authority =
    typeof value === 'object' && value !== null ? BOUNDARY_AUTHORITIES.get(value) : undefined
  if (authority === undefined) throw new Error('backup manifest page boundary is invalid')
  return authority
}

export function issueEncryptedWalletBackupManifestPageProvenance(input: {
  readonly page: object
  readonly boundary: EncryptedWalletBackupManifestPageBoundary
  readonly canonicalPage: Uint8Array
}): void {
  const authority = requireEncryptedWalletBackupManifestPageBoundary(input.boundary)
  if (input.canonicalPage.byteLength > authority.plannedCanonicalPageBytes)
    throw new Error('backup manifest page exceeds its planned size')
  PAGE_PROVENANCE.set(
    input.page,
    Object.freeze({
      boundary: input.boundary,
      canonicalPageBytes: input.canonicalPage.byteLength,
      canonicalPageDigest: bytesToHex(sha256(input.canonicalPage)),
    }),
  )
}

/** Internal rehydration seam. It never exposes the boundary tuple. */
export function readEncryptedWalletBackupManifestPageProvenance(
  value: object,
): ManifestPageProvenance {
  const provenance = PAGE_PROVENANCE.get(value)
  if (provenance === undefined) throw new Error('prepared manifest page provenance is invalid')
  return provenance
}

function issueBoundary(
  input: Parameters<typeof registerEncryptedWalletBackupManifestPassABoundaries>[0],
  boundary: {
    readonly entryCount: number
    readonly canonicalEntryBytes: number
    readonly plannedCanonicalPageBytes: number
  },
  pageIndex: number,
): EncryptedWalletBackupManifestPageBoundary {
  const handle = Object.freeze({})
  BOUNDARY_AUTHORITIES.set(
    handle,
    Object.freeze({
      realm: input.realm,
      vaultId: input.vaultId,
      snapshotId: input.snapshotId,
      snapshotRevision: input.snapshotRevision,
      sealedControlVersion: input.sealedControlVersion,
      sealRunRevision: input.sealRunRevision,
      sealedControlDigest: input.sealedControlDigest,
      resultDigest: input.resultDigest,
      generation: input.generation,
      snapshotNonce: input.snapshotNonce,
      pageIndex,
      pageCount: input.boundaries.length,
      entryCount: boundary.entryCount,
      canonicalEntryBytes: boundary.canonicalEntryBytes,
      plannedCanonicalPageBytes: boundary.plannedCanonicalPageBytes,
    }),
  )
  return handle as EncryptedWalletBackupManifestPageBoundary
}

function requirePreparedEntry(value: Uint8Array): readonly unknown[] {
  if (!(value instanceof Uint8Array) || value.byteLength < 1)
    throw new Error('prepared manifest entry is invalid')
  const decoded = decode(value)
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 10 ||
    !equalBytes(value, encodeCanonical(decoded))
  )
    throw new Error('prepared manifest entry is invalid')
  if (decoded[0] !== 0) throw new Error('prepared manifest entry is invalid')
  return decoded
}

function requireReference(
  value: unknown,
  length: number,
  name: string,
): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== length)
    throw new Error(`prepared manifest ${name} is invalid`)
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  )
}
