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

declare const encryptedWalletBackupManifestEntryBrand: unique symbol

/** Opaque authority for one validated final manifest entry. */
export interface EncryptedWalletBackupManifestEntryCapability {
  readonly [encryptedWalletBackupManifestEntryBrand]: true
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

export interface EncryptedWalletBackupManifestPageProvenance {
  readonly boundary: EncryptedWalletBackupManifestPageBoundary
  readonly canonicalPageBytes: number
  readonly canonicalPageDigest: string
  readonly firstPinKey: Uint8Array
  readonly lastPinKey: Uint8Array
}

const RESULT_BOUNDARIES = new WeakMap<
  object,
  readonly EncryptedWalletBackupManifestPageBoundary[]
>()
const BOUNDARY_AUTHORITIES = new WeakMap<object, BoundaryAuthority>()
const PAGE_PROVENANCE = new WeakMap<object, EncryptedWalletBackupManifestPageProvenance>()
interface EntryCapabilityAuthority {
  readonly finalEntry: Uint8Array
  readonly boundary: EncryptedWalletBackupManifestPageBoundary
  readonly ordinal: number
  readonly pinKey: Uint8Array
  readonly commitment: string
  readonly chunkGeneration: number
}

const ENTRY_CAPABILITIES = new WeakMap<object, EntryCapabilityAuthority>()

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

/**
 * Issue an entry only after the caller has authenticated its source rows.
 * This module keeps the final bytes opaque to page callers.
 */
export function issueEncryptedWalletBackupManifestEntryCapability(input: {
  readonly canonicalPreparedEntry: Uint8Array
  readonly chunkObjectId: Uint8Array
  readonly chunkDigest: Uint8Array
  readonly boundary: EncryptedWalletBackupManifestPageBoundary
  readonly ordinal: number
  readonly pinKey: Uint8Array
  readonly commitment: string
  readonly chunkGeneration: number
}): EncryptedWalletBackupManifestEntryCapability {
  const boundary = requireEncryptedWalletBackupManifestPageBoundary(input.boundary)
  if (
    !Number.isSafeInteger(input.ordinal) ||
    input.ordinal < 0 ||
    input.ordinal >= boundary.entryCount ||
    !(input.pinKey instanceof Uint8Array) ||
    input.pinKey.byteLength < 1 ||
    input.pinKey.byteLength > 1_024
  )
    throw new Error('backup manifest entry provenance is invalid')
  if (
    !/^[0-9a-f]{64}$/.test(input.commitment) ||
    !Number.isSafeInteger(input.chunkGeneration) ||
    input.chunkGeneration < 1 ||
    input.chunkGeneration > boundary.generation
  )
    throw new Error('backup manifest entry provenance is invalid')
  const finalEntry = finalManifestEntryBytes(
    input.canonicalPreparedEntry,
    input.chunkObjectId,
    input.chunkDigest,
  )
  const capability = Object.freeze({})
  ENTRY_CAPABILITIES.set(
    capability,
    Object.freeze({
      finalEntry,
      boundary: input.boundary,
      ordinal: input.ordinal,
      pinKey: input.pinKey.slice(),
      commitment: input.commitment,
      chunkGeneration: input.chunkGeneration,
    }),
  )
  return capability as EncryptedWalletBackupManifestEntryCapability
}

/** Internal page-construction seam. It returns a detached canonical entry. */
export function readEncryptedWalletBackupManifestEntryCapability(
  value: EncryptedWalletBackupManifestEntryCapability,
): Uint8Array {
  const entry =
    typeof value === 'object' && value !== null ? ENTRY_CAPABILITIES.get(value) : undefined
  if (entry === undefined) throw new Error('backup manifest entry capability is invalid')
  return entry.finalEntry.slice()
}

export function readEncryptedWalletBackupManifestEntryForPage(input: {
  readonly value: EncryptedWalletBackupManifestEntryCapability
  readonly boundary: EncryptedWalletBackupManifestPageBoundary
  readonly ordinal: number
}): Readonly<{ finalEntry: Uint8Array; pinKey: Uint8Array; commitment: string }> {
  const entry =
    typeof input.value === 'object' && input.value !== null
      ? ENTRY_CAPABILITIES.get(input.value)
      : undefined
  const boundary = requireEncryptedWalletBackupManifestPageBoundary(input.boundary)
  if (
    entry === undefined ||
    entry.boundary !== input.boundary ||
    entry.ordinal !== input.ordinal ||
    entry.chunkGeneration > boundary.generation
  )
    throw new Error('backup manifest entry capability is invalid')
  return Object.freeze({
    finalEntry: entry.finalEntry.slice(),
    pinKey: entry.pinKey.slice(),
    commitment: entry.commitment,
  })
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

/** Internal source-join seam. It exposes the exact sealed-page scope and limits. */
export function readEncryptedWalletBackupManifestPassABoundaryLimits(
  value: EncryptedWalletBackupManifestPageBoundary,
): Readonly<{
  realm: string
  vaultId: string
  snapshotId: string
  snapshotRevision: number
  entryCount: number
  canonicalEntryBytes: number
}> {
  const authority = requireEncryptedWalletBackupManifestPageBoundary(value)
  return Object.freeze({
    realm: authority.realm,
    vaultId: authority.vaultId,
    snapshotId: authority.snapshotId,
    snapshotRevision: authority.snapshotRevision,
    entryCount: authority.entryCount,
    canonicalEntryBytes: authority.canonicalEntryBytes,
  })
}

export function issueEncryptedWalletBackupManifestPageProvenance(input: {
  readonly page: object
  readonly boundary: EncryptedWalletBackupManifestPageBoundary
  readonly canonicalPage: Uint8Array
  readonly firstPinKey: Uint8Array
  readonly lastPinKey: Uint8Array
}): void {
  const authority = requireEncryptedWalletBackupManifestPageBoundary(input.boundary)
  if (
    input.canonicalPage.byteLength > authority.plannedCanonicalPageBytes ||
    !validPinEndpoints(input.firstPinKey, input.lastPinKey)
  )
    throw new Error('backup manifest page exceeds its planned size')
  PAGE_PROVENANCE.set(
    input.page,
    Object.freeze({
      boundary: input.boundary,
      canonicalPageBytes: input.canonicalPage.byteLength,
      canonicalPageDigest: bytesToHex(sha256(input.canonicalPage)),
      firstPinKey: input.firstPinKey.slice(),
      lastPinKey: input.lastPinKey.slice(),
    }),
  )
}

/** Read authenticated page provenance with detached source-pin endpoints. */
export function readEncryptedWalletBackupManifestPageProvenance(
  value: object,
): EncryptedWalletBackupManifestPageProvenance {
  const provenance = PAGE_PROVENANCE.get(value)
  if (provenance === undefined) throw new Error('prepared manifest page provenance is invalid')
  return Object.freeze({
    ...provenance,
    firstPinKey: provenance.firstPinKey.slice(),
    lastPinKey: provenance.lastPinKey.slice(),
  })
}

function validPinEndpoints(first: unknown, last: unknown): first is Uint8Array {
  return (
    first instanceof Uint8Array &&
    last instanceof Uint8Array &&
    first.byteLength >= 1 &&
    last.byteLength >= 1 &&
    first.byteLength <= 1_024 &&
    last.byteLength <= 1_024 &&
    compareBytes(first, last) <= 0
  )
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

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < Math.min(left.byteLength, right.byteLength); index += 1) {
    const difference = left[index]! - right[index]!
    if (difference !== 0) return difference
  }
  return left.byteLength - right.byteLength
}
