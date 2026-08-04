import { hexToBytes } from '@noble/hashes/utils.js'
import { encodeCanonicalBackupCbor as encodeCanonical } from './encryptedWalletBackupCbor.ts'
import {
  issueEncryptedWalletBackupManifestEntryCapability,
  measureFinalManifestEntryBytes,
  readEncryptedWalletBackupManifestPassABoundaryLimits,
  type EncryptedWalletBackupManifestEntryCapability,
  type EncryptedWalletBackupManifestPageBoundary,
} from './encryptedWalletBackupManifestPageAuthority.ts'
import {
  readPreparedEncryptedWalletBackupPackManifestEntries,
  readPreparedEncryptedWalletBackupPackObjectIdentity,
  type PreparedEncryptedWalletBackupPackObject,
} from './encryptedWalletBackupPackPersistence.ts'
import {
  authenticatePreparedEncryptedWalletBackupSources,
  readAuthenticatedPreparedEncryptedWalletBackupSource,
  type EncryptedWalletBackupPreparedRecordSnapshotBatchStore,
  type PersistedPreparedEncryptedWalletBackupRecord,
} from './encryptedWalletBackupPreparedRecordPersistence.ts'
import {
  decodeEncryptedWalletBackupSnapshotPin,
  encodeEncryptedWalletBackupSnapshotPinOrderKey,
  validateEncryptedWalletBackupSnapshotSourcePinBinding,
} from './encryptedWalletBackupSnapshotPersistence.ts'
import type { EncryptedWalletBackupKeyHandle } from './encryptedWalletBackup.ts'

/** Each logical join reads one pin, source, pack binding, and prepared record. */
export const ENCRYPTED_WALLET_BACKUP_MANIFEST_SOURCE_JOIN_PHYSICAL_ROW_MAX = 256 as const
export const ENCRYPTED_WALLET_BACKUP_MANIFEST_SOURCE_JOIN_PHYSICAL_MAX_BYTES = 1_048_576 as const
export const ENCRYPTED_WALLET_BACKUP_MANIFEST_SOURCE_JOIN_LOGICAL_ROW_MAX = 64 as const

export interface EncryptedWalletBackupManifestSourceJoinRow {
  readonly pin: Uint8Array
  readonly prepared: PersistedPreparedEncryptedWalletBackupRecord
  readonly buildId: string
  readonly packId: string
}

export interface EncryptedWalletBackupManifestSourceJoinPhysicalPage {
  readonly rows: readonly EncryptedWalletBackupManifestSourceJoinRow[]
  readonly serializedBytes: number
}

/** Storage-neutral keyset source. It must not return authority outside its rows. */
export interface EncryptedWalletBackupManifestSourceJoinStore {
  /** Run one physical transaction. Join exact pin/prepared/build/pack rows in pin-key order. */
  /** Stop before a row exceeds `maxBytes`. Report the exact SDK application-byte sum. */
  readSourcePage(
    exclusiveAfter: Uint8Array | null,
    limit: number,
    maxBytes: number,
  ): Promise<EncryptedWalletBackupManifestSourceJoinPhysicalPage>
}

export function measureEncryptedWalletBackupManifestSourceJoinRow(
  value: EncryptedWalletBackupManifestSourceJoinRow,
): number {
  const row = requireSourceRow(value)
  return encodeCanonical([
    row.pin,
    row.prepared.schemaVersion,
    row.prepared.realm,
    row.prepared.vaultId,
    row.prepared.snapshotId,
    row.prepared.snapshotRevision,
    row.prepared.recordId,
    row.prepared.commitment,
    row.prepared.recordKindCode,
    row.prepared.canonicalRecord,
    row.prepared.canonicalManifestEntry,
    row.prepared.authenticationTag,
    row.buildId,
    row.packId,
  ]).byteLength
}

/** The provider must return an SDK-issued object from the staged-pack rehydration path. */
export interface EncryptedWalletBackupManifestStagedPackProvider {
  rehydrateStagedPack(
    input: Readonly<{
      buildId: string
      packId: string
    }>,
  ): Promise<PreparedEncryptedWalletBackupPackObject>
}

export interface EncryptedWalletBackupManifestSourceJoinEvidence {
  readonly entryCount: number
  readonly canonicalEntryBytes: number
  readonly firstPinKey: Uint8Array | null
  readonly lastPinKey: Uint8Array | null
}

export interface EncryptedWalletBackupManifestSourceJoinResult {
  readonly entries: readonly EncryptedWalletBackupManifestEntryCapability[]
  readonly evidence: EncryptedWalletBackupManifestSourceJoinEvidence
}

/**
 * Join one Pass-A logical page to SDK-authenticated staged-pack membership.
 * This function does not encrypt, persist, upload, or delete any object.
 */
export async function joinEncryptedWalletBackupManifestSourcePage(input: {
  readonly store: EncryptedWalletBackupManifestSourceJoinStore
  readonly stagedPackProvider: EncryptedWalletBackupManifestStagedPackProvider
  readonly boundary: EncryptedWalletBackupManifestPageBoundary
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly seed: Uint8Array
  readonly snapshotStore: EncryptedWalletBackupPreparedRecordSnapshotBatchStore
  readonly exclusiveAfter: Uint8Array | null
}): Promise<EncryptedWalletBackupManifestSourceJoinResult> {
  const limits = readEncryptedWalletBackupManifestPassABoundaryLimits(input.boundary)
  if (limits.entryCount > ENCRYPTED_WALLET_BACKUP_MANIFEST_SOURCE_JOIN_LOGICAL_ROW_MAX)
    throw new Error('backup manifest source join boundary exceeds its row limit')
  const compact = await readCompactSourceRows(input, limits)
  requireCompactEntryBytes(compact, limits.canonicalEntryBytes)
  const entries = await joinCompactSourceRows(compact, input.stagedPackProvider, input.boundary)
  return Object.freeze({ entries, evidence: issueEvidence(compact, limits) })
}

interface CompactSourceRow {
  readonly pinKey: Uint8Array
  readonly realm: string
  readonly vaultId: string
  readonly recordId: string
  readonly commitment: string
  readonly canonicalManifestEntry: Uint8Array
  readonly buildId: string
  readonly packId: string
  readonly snapshotId: string
  readonly snapshotRevision: number
  readonly position: number
}

async function readCompactSourceRows(
  input: Parameters<typeof joinEncryptedWalletBackupManifestSourcePage>[0],
  limits: ReturnType<typeof readEncryptedWalletBackupManifestPassABoundaryLimits>,
): Promise<readonly CompactSourceRow[]> {
  const rows: CompactSourceRow[] = []
  let cursor = cloneKey(input.exclusiveAfter)
  while (rows.length < limits.entryCount) {
    const requested = Math.min(
      ENCRYPTED_WALLET_BACKUP_MANIFEST_SOURCE_JOIN_LOGICAL_ROW_MAX,
      limits.entryCount - rows.length,
    )
    const page = await input.store.readSourcePage(
      cursor,
      requested,
      ENCRYPTED_WALLET_BACKUP_MANIFEST_SOURCE_JOIN_PHYSICAL_MAX_BYTES,
    )
    const physical = requirePhysicalPage(page, requested)
    if (physical.length === 0) throw new Error('backup manifest source page ends early')
    const compact = await authenticatePhysicalRows(input, physical, cursor, rows.length, limits)
    rows.push(...compact)
    cursor = compact.at(-1)!.pinKey.slice()
  }
  return Object.freeze(rows)
}

function requirePhysicalPage(
  value: EncryptedWalletBackupManifestSourceJoinPhysicalPage,
  requested: number,
): readonly EncryptedWalletBackupManifestSourceJoinRow[] {
  if (typeof value !== 'object' || value === null || !Array.isArray(value.rows))
    throw new Error('backup manifest source page is invalid')
  if (
    Object.keys(value).length !== 2 ||
    !('rows' in value) ||
    !('serializedBytes' in value) ||
    !Number.isSafeInteger(value.serializedBytes) ||
    value.serializedBytes < (value.rows.length === 0 ? 0 : 1) ||
    value.serializedBytes > ENCRYPTED_WALLET_BACKUP_MANIFEST_SOURCE_JOIN_PHYSICAL_MAX_BYTES ||
    value.rows.length > requested ||
    value.rows.length > ENCRYPTED_WALLET_BACKUP_MANIFEST_SOURCE_JOIN_LOGICAL_ROW_MAX
  )
    throw new Error('backup manifest source page is invalid')
  const measured = value.rows.reduce(
    (total, row) => add(total, measureEncryptedWalletBackupManifestSourceJoinRow(row)),
    0,
  )
  if (value.serializedBytes !== measured) throw new Error('backup manifest source page is invalid')
  return value.rows
}

async function authenticatePhysicalRows(
  input: Parameters<typeof joinEncryptedWalletBackupManifestSourcePage>[0],
  rows: readonly EncryptedWalletBackupManifestSourceJoinRow[],
  exclusiveAfter: Uint8Array | null,
  position: number,
  scope: ReturnType<typeof readEncryptedWalletBackupManifestPassABoundaryLimits>,
): Promise<readonly CompactSourceRow[]> {
  const exactRows = rows.map(requireSourceRow)
  const authenticated = await authenticatePreparedEncryptedWalletBackupSources({
    keyHandle: input.keyHandle,
    seed: input.seed,
    persisted: exactRows.map((row) => row.prepared),
    snapshotStore: input.snapshotStore,
  })
  let prior = exclusiveAfter
  return Object.freeze(
    exactRows.map((row, index) => {
      const pin = row.pin.slice()
      const sourceDescriptor = readAuthenticatedPreparedEncryptedWalletBackupSource(
        authenticated[index]!,
      )
      const binding = validateEncryptedWalletBackupSnapshotSourcePinBinding({
        sourceDescriptor,
        pin,
      })
      requireSourceScope(binding, scope)
      const pinKey = pinOrderKey(decodeEncryptedWalletBackupSnapshotPin(pin))
      if (prior !== null && compareBytes(prior, pinKey) >= 0)
        throw new Error('backup manifest source keyset order is invalid')
      prior = pinKey
      return Object.freeze({
        pinKey,
        realm: binding.source.realm,
        vaultId: binding.source.vaultId,
        recordId: binding.source.recordId,
        commitment: binding.source.commitment,
        canonicalManifestEntry: row.prepared.canonicalManifestEntry.slice(),
        buildId: row.buildId,
        packId: row.packId,
        snapshotId: binding.pin.snapshotId,
        snapshotRevision: binding.pin.snapshotRevision,
        position: position + index,
      })
    }),
  )
}

function requireSourceRow(value: EncryptedWalletBackupManifestSourceJoinRow) {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('backup manifest source row is invalid')
  const row = value as unknown as Record<string, unknown>
  if (
    Object.keys(row).length !== 4 ||
    !('pin' in row) ||
    !('prepared' in row) ||
    !('buildId' in row) ||
    !('packId' in row) ||
    !(row.pin instanceof Uint8Array) ||
    row.pin.byteLength < 1 ||
    !isIdentifier(row.buildId) ||
    !isIdentifier(row.packId)
  )
    throw new Error('backup manifest source row is invalid')
  return Object.freeze({
    pin: row.pin.slice(),
    prepared: structuredClone(row.prepared) as PersistedPreparedEncryptedWalletBackupRecord,
    buildId: row.buildId,
    packId: row.packId,
  })
}

function requireCompactEntryBytes(rows: readonly CompactSourceRow[], expected: number): void {
  let total = 0
  for (const row of rows) {
    total = add(total, measureFinalManifestEntryBytes(row.canonicalManifestEntry))
  }
  if (total !== expected) throw new Error('backup manifest source entry bytes are invalid')
}

async function joinCompactSourceRows(
  rows: readonly CompactSourceRow[],
  provider: EncryptedWalletBackupManifestStagedPackProvider,
  boundary: EncryptedWalletBackupManifestPageBoundary,
): Promise<readonly EncryptedWalletBackupManifestEntryCapability[]> {
  if (!provider || typeof provider.rehydrateStagedPack !== 'function')
    throw new Error('backup manifest staged pack provider is invalid')
  const groups = groupCompactRows(rows)
  const entries: EncryptedWalletBackupManifestEntryCapability[] = Array.from({
    length: rows.length,
  })
  for (const group of groups) await joinOnePack(group, provider, entries, boundary)
  if (entries.some((entry) => entry === undefined))
    throw new Error('backup manifest source join is incomplete')
  return Object.freeze(entries)
}

interface CompactSourceGroup {
  readonly buildId: string
  readonly packId: string
  readonly rows: readonly CompactSourceRow[]
}

function groupCompactRows(rows: readonly CompactSourceRow[]): readonly CompactSourceGroup[] {
  const builds = new Map<string, Map<string, CompactSourceGroup>>()
  const groups: CompactSourceGroup[] = []
  for (const row of rows) {
    let packs = builds.get(row.buildId)
    if (packs === undefined) {
      packs = new Map()
      builds.set(row.buildId, packs)
    }
    const group = packs.get(row.packId)
    if (group === undefined) {
      const next = { buildId: row.buildId, packId: row.packId, rows: [row] }
      packs.set(row.packId, next)
      groups.push(next)
    } else (group.rows as CompactSourceRow[]).push(row)
  }
  return Object.freeze(
    groups.map((group) => Object.freeze({ ...group, rows: Object.freeze(group.rows.slice()) })),
  )
}

async function joinOnePack(
  group: CompactSourceGroup,
  provider: EncryptedWalletBackupManifestStagedPackProvider,
  output: EncryptedWalletBackupManifestEntryCapability[],
  boundary: EncryptedWalletBackupManifestPageBoundary,
): Promise<void> {
  const pack = await provider.rehydrateStagedPack({ buildId: group.buildId, packId: group.packId })
  const identity = readPreparedEncryptedWalletBackupPackObjectIdentity(pack)
  if (identity.buildId !== group.buildId || identity.packId !== group.packId)
    throw new Error('backup manifest staged pack identity is invalid')
  requirePackScope(identity, group.rows)
  const members = indexPackMembers(readPreparedEncryptedWalletBackupPackManifestEntries(pack))
  for (const row of group.rows) output[row.position] = issueJoinedEntry(row, members, boundary)
}

function requirePackScope(
  pack: ReturnType<typeof readPreparedEncryptedWalletBackupPackObjectIdentity>,
  rows: readonly CompactSourceRow[],
): void {
  for (const row of rows) {
    if (
      pack.realm !== row.realm ||
      pack.vaultId !== row.vaultId ||
      pack.snapshotId !== row.snapshotId ||
      pack.snapshotRevision !== row.snapshotRevision
    )
      throw new Error('backup manifest staged pack scope is invalid')
  }
}

type PackMember = Readonly<{
  recordId: string
  commitment: string
  canonicalManifestEntry: Uint8Array
  objectId: string
  objectDigest: string
  objectGeneration: number
}>

function indexPackMembers(
  rows: ReturnType<typeof readPreparedEncryptedWalletBackupPackManifestEntries>,
): ReadonlyMap<string, PackMember> {
  const members = new Map<string, PackMember>()
  for (const row of rows) {
    if (members.has(row.recordId))
      throw new Error('backup manifest staged pack membership is duplicate')
    members.set(row.recordId, row)
  }
  return members
}

function issueJoinedEntry(
  source: CompactSourceRow,
  members: ReadonlyMap<string, PackMember>,
  boundary: EncryptedWalletBackupManifestPageBoundary,
): EncryptedWalletBackupManifestEntryCapability {
  const member = members.get(source.recordId)
  if (
    member === undefined ||
    member.commitment !== source.commitment ||
    !equalBytes(member.canonicalManifestEntry, source.canonicalManifestEntry)
  )
    throw new Error('backup manifest staged pack membership is invalid')
  return issueEncryptedWalletBackupManifestEntryCapability({
    canonicalPreparedEntry: source.canonicalManifestEntry,
    chunkObjectId: hexToBytes(member.objectId),
    chunkDigest: hexToBytes(member.objectDigest),
    boundary,
    ordinal: source.position,
    pinKey: source.pinKey,
    commitment: source.commitment,
    chunkGeneration: member.objectGeneration,
  })
}

function issueEvidence(
  rows: readonly CompactSourceRow[],
  limits: Readonly<{ entryCount: number; canonicalEntryBytes: number }>,
): EncryptedWalletBackupManifestSourceJoinEvidence {
  return Object.freeze({
    entryCount: limits.entryCount,
    canonicalEntryBytes: limits.canonicalEntryBytes,
    firstPinKey: rows[0]?.pinKey.slice() ?? null,
    lastPinKey: rows.at(-1)?.pinKey.slice() ?? null,
  })
}

function cloneKey(value: Uint8Array | null): Uint8Array | null {
  if (value === null) return null
  if (!(value instanceof Uint8Array) || value.byteLength < 1)
    throw new Error('backup manifest source cursor is invalid')
  return value.slice()
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength)
  for (let index = 0; index < length; index += 1) {
    const difference = left[index]! - right[index]!
    if (difference !== 0) return difference
  }
  return left.byteLength - right.byteLength
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function add(left: number, right: number): number {
  if (!Number.isSafeInteger(right) || right < 0 || left > Number.MAX_SAFE_INTEGER - right)
    throw new Error('backup manifest source entry bytes are invalid')
  return left + right
}

function requireSourceScope(
  binding: ReturnType<typeof validateEncryptedWalletBackupSnapshotSourcePinBinding>,
  scope: ReturnType<typeof readEncryptedWalletBackupManifestPassABoundaryLimits>,
): void {
  if (
    binding.source.realm !== scope.realm ||
    binding.source.vaultId !== scope.vaultId ||
    binding.pin.snapshotId !== scope.snapshotId ||
    binding.pin.snapshotRevision !== scope.snapshotRevision
  )
    throw new Error('backup manifest source scope is invalid')
}

function pinOrderKey(pin: ReturnType<typeof decodeEncryptedWalletBackupSnapshotPin>): Uint8Array {
  return encodeEncryptedWalletBackupSnapshotPinOrderKey(pin)
}
