import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  prepareBoundedEncryptedWalletBackupManifestTarget,
  rehydratePreparedEncryptedWalletBackupManifestPage,
  type AuthenticatedEncryptedWalletBackupHeadEvidence,
  type EncryptedWalletBackupKeyHandle,
  type PreparedEncryptedWalletBackupObject,
  type PreparedEncryptedWalletBackupManifestTarget,
} from './encryptedWalletBackup.ts'
import {
  issueBoundedManifestTargetCapability,
  type BoundedManifestTargetAuthority,
} from './encryptedWalletBackupManifestTargetAuthority.ts'
import {
  decodeEncryptedWalletBackupManifestPageCursor,
  decodeEncryptedWalletBackupManifestPageRow,
} from './encryptedWalletBackupManifestPagePersistence.ts'
import {
  readEncryptedWalletBackupManifestPageProvenance,
  readEncryptedWalletBackupManifestPassABoundaryLimits,
} from './encryptedWalletBackupManifestPageAuthority.ts'
import {
  readEncryptedWalletBackupManifestPassABoundary,
  rehydrateEncryptedWalletBackupManifestPassAResult,
} from './encryptedWalletBackupManifestPassA.ts'
import {
  decodeEncryptedWalletBackupFrozenSnapshot,
  encodeEncryptedWalletBackupFrozenSnapshotScope,
} from './encryptedWalletBackupSnapshotPersistence.ts'
import type { EncryptedWalletBackupFrozenSnapshotControl } from './encryptedWalletBackupSnapshotAuthority.ts'

export const ENCRYPTED_WALLET_BACKUP_MANIFEST_FINALIZATION_READ_ROWS_MAX = 256 as const
export const ENCRYPTED_WALLET_BACKUP_MANIFEST_FINALIZATION_READ_BYTES_MAX = 1_048_576 as const
export interface EncryptedWalletBackupManifestFinalizationState {
  readonly control: Uint8Array
  readonly passAResult: Uint8Array
  readonly cursor: Uint8Array
}

/** A storage-neutral, page-index cursor port for final target construction. */
export interface EncryptedWalletBackupManifestTargetFinalizationStore {
  readManifestFinalizationState(
    input: Readonly<{
      scope: Uint8Array
      maximumRows: number
      maximumBytes: number
    }>,
  ): Promise<EncryptedWalletBackupManifestFinalizationState>
  /**
   * Reserve the declared capacity before reading or cloning. Return the
   * maximum ordered page-index prefix that fits. Do not offset, sort, or trim
   * a materialized result.
   */
  readManifestFinalizationRows(
    input: Readonly<{
      scope: Uint8Array
      exclusivePageIndex: number
      maximumRows: number
      maximumBytes: number
    }>,
  ): Promise<readonly Uint8Array[]>
}

type CompactManifestPageReference = BoundedManifestTargetAuthority['pages'][number]
type CompactManifestChunkReference = BoundedManifestTargetAuthority['chunkReferences'][number]
type FinalizationScan = Readonly<{
  pages: readonly CompactManifestPageReference[]
  chunkReferences: readonly CompactManifestChunkReference[]
  finalRowDigest: string | null
  priorLastPinKey: Uint8Array | null
}>

/**
 * Rebuilds a manifest target from persisted Pass-B rows. It performs no I/O
 * other than the bounded store reads. It does not plan uploads or mutate state.
 */
export async function finalizeBoundedEncryptedWalletBackupManifestTarget(input: {
  readonly store: EncryptedWalletBackupManifestTargetFinalizationStore
  readonly control: EncryptedWalletBackupFrozenSnapshotControl
  readonly parentEvidence: AuthenticatedEncryptedWalletBackupHeadEvidence
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly seed: Uint8Array
}): Promise<PreparedEncryptedWalletBackupManifestTarget> {
  const scope = encodeEncryptedWalletBackupFrozenSnapshotScope(input.control)
  const state = requireState(
    await input.store.readManifestFinalizationState({
      scope: scope.slice(),
      maximumRows: 3,
      maximumBytes: ENCRYPTED_WALLET_BACKUP_MANIFEST_FINALIZATION_READ_BYTES_MAX,
    }),
  )
  const current = decodeEncryptedWalletBackupFrozenSnapshot(state.control)
  const result = rehydrateEncryptedWalletBackupManifestPassAResult({
    control: input.control,
    current,
    persisted: state.passAResult,
  })
  const cursor = decodeEncryptedWalletBackupManifestPageCursor(state.cursor)
  requireCompletedCursor(cursor, result, state.passAResult)
  const scan = await scanFinalizationPages({
    store: input.store,
    scope,
    state,
    result,
    keyHandle: input.keyHandle,
    seed: input.seed,
  })
  requireCursorTail(cursor, scan)
  const capability = issueBoundedManifestTargetCapability({
    control: input.control,
    parentEvidence: input.parentEvidence,
    pages: scan.pages,
    chunkReferences: scan.chunkReferences,
    proofCount: result.recordCount,
    keyHandle: input.keyHandle,
  })
  return prepareBoundedEncryptedWalletBackupManifestTarget({
    keyHandle: input.keyHandle,
    capability,
  })
}

async function scanFinalizationPages(input: {
  readonly store: EncryptedWalletBackupManifestTargetFinalizationStore
  readonly scope: Uint8Array
  readonly state: EncryptedWalletBackupManifestFinalizationState
  readonly result: ReturnType<typeof rehydrateEncryptedWalletBackupManifestPassAResult>
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly seed: Uint8Array
}): Promise<FinalizationScan> {
  const pages: CompactManifestPageReference[] = []
  const chunks = new Map<string, string>()
  const pageIds = new Map<string, string>()
  const digests = new Map<string, string>()
  let exclusivePageIndex = -1
  let priorLastPinKey: Uint8Array | null = null
  let finalRowDigest: string | null = null
  let rowsSeen = 0
  while (rowsSeen < input.result.pageCount) {
    const remaining = input.result.pageCount - rowsSeen
    const rawRows = await readPrefix(input.store, input.scope, exclusivePageIndex, remaining)
    if (rawRows.length === 0)
      throw new Error('backup manifest finalization page coverage is incomplete')
    for (const raw of rawRows) {
      const row = decodeEncryptedWalletBackupManifestPageRow(raw)
      if (row.pageIndex !== rowsSeen || row.pageIndex !== exclusivePageIndex + 1)
        throw new Error('backup manifest finalization page order is invalid')
      if (
        row.realm !== input.result.realm ||
        row.vaultId !== input.result.vaultId ||
        row.snapshotId !== input.result.snapshotId ||
        row.snapshotRevision !== input.result.snapshotRevision ||
        row.sealedControlDigest !== input.result.sealedControlDigest ||
        row.sealedControlVersion !== input.result.sealedControlVersion ||
        row.passAResultDigest !== bytesToHex(sha256(input.state.passAResult)) ||
        row.generation !== input.result.generation ||
        row.snapshotNonce !== input.result.snapshotNonce ||
        row.pageCount !== input.result.pageCount
      ) {
        throw new Error('backup manifest finalization page context is invalid')
      }
      const boundary = readEncryptedWalletBackupManifestPassABoundary(input.result, row.pageIndex)
      const limits = readEncryptedWalletBackupManifestPassABoundaryLimits(boundary)
      if (
        row.sourceEvidence.entryCount !== limits.entryCount ||
        row.sourceEvidence.canonicalEntryBytes !== limits.canonicalEntryBytes ||
        (priorLastPinKey !== null &&
          compareBytes(row.sourceEvidence.firstPinKey, priorLastPinKey) <= 0)
      ) {
        throw new Error('backup manifest finalization source evidence is invalid')
      }
      const page = await rehydratePreparedEncryptedWalletBackupManifestPage({
        keyHandle: input.keyHandle,
        seed: input.seed,
        boundary,
        object: row.object,
        sourceEvidence: row.sourceEvidence,
      })
      const provenance = readEncryptedWalletBackupManifestPageProvenance(page)
      if (
        provenance.canonicalPageBytes > limits.plannedCanonicalPageBytes ||
        !equalBytes(provenance.firstPinKey, row.sourceEvidence.firstPinKey) ||
        !equalBytes(provenance.lastPinKey, row.sourceEvidence.lastPinKey)
      ) {
        throw new Error('backup manifest finalization page provenance is invalid')
      }
      addReference(pages, pageIds, digests, compactPageReference(page))
      for (const reference of provenance.chunkReferences)
        addChunkReference(chunks, pageIds, digests, reference.objectId, reference.digest)
      priorLastPinKey = row.sourceEvidence.lastPinKey.slice()
      finalRowDigest = row.rowDigest
      exclusivePageIndex = row.pageIndex
      rowsSeen += 1
    }
  }
  // Exact completion must be followed by an exhaustion read. This also rejects
  // a persisted row after a completed Pass-A plan.
  const exhausted = await readPrefix(input.store, input.scope, exclusivePageIndex, 1)
  if (exhausted.length !== 0) throw new Error('backup manifest finalization has extra pages')
  return Object.freeze({
    pages: Object.freeze(pages),
    chunkReferences: Object.freeze(
      [...chunks.entries()].map(([objectId, digest]) => Object.freeze({ objectId, digest })),
    ),
    finalRowDigest,
    priorLastPinKey: priorLastPinKey?.slice() ?? null,
  })
}

function requireCursorTail(
  cursor: ReturnType<typeof decodeEncryptedWalletBackupManifestPageCursor>,
  scan: FinalizationScan,
): void {
  if (
    (scan.finalRowDigest === null &&
      (cursor.priorPageRowDigest.state !== 'absent' ||
        cursor.exclusiveSourcePinKey.state !== 'absent')) ||
    (scan.finalRowDigest !== null &&
      (cursor.priorPageRowDigest.state !== 'present' ||
        bytesToHex(cursor.priorPageRowDigest.value) !== scan.finalRowDigest ||
        cursor.exclusiveSourcePinKey.state !== 'present' ||
        scan.priorLastPinKey === null ||
        !equalBytes(cursor.exclusiveSourcePinKey.value, scan.priorLastPinKey)))
  )
    throw new Error('backup manifest finalization cursor is invalid')
}

function compactPageReference(
  page: PreparedEncryptedWalletBackupObject,
): CompactManifestPageReference {
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

async function readPrefix(
  store: EncryptedWalletBackupManifestTargetFinalizationStore,
  scope: Uint8Array,
  exclusivePageIndex: number,
  remaining: number,
): Promise<readonly Uint8Array[]> {
  const rows = await store.readManifestFinalizationRows({
    scope: scope.slice(),
    exclusivePageIndex,
    maximumRows: Math.min(remaining, ENCRYPTED_WALLET_BACKUP_MANIFEST_FINALIZATION_READ_ROWS_MAX),
    maximumBytes: ENCRYPTED_WALLET_BACKUP_MANIFEST_FINALIZATION_READ_BYTES_MAX,
  })
  if (!Array.isArray(rows) || rows.length > Math.min(remaining, 256))
    throw new Error('backup manifest finalization page read exceeded its capacity')
  let bytes = 0
  for (const row of rows) {
    if (!(row instanceof Uint8Array))
      throw new Error('backup manifest finalization page row is invalid')
    bytes += row.byteLength
  }
  if (bytes > ENCRYPTED_WALLET_BACKUP_MANIFEST_FINALIZATION_READ_BYTES_MAX)
    throw new Error('backup manifest finalization page read exceeded its capacity')
  return rows
}

function requireCompletedCursor(
  cursor: ReturnType<typeof decodeEncryptedWalletBackupManifestPageCursor>,
  result: ReturnType<typeof rehydrateEncryptedWalletBackupManifestPassAResult>,
  persistedResult: Uint8Array,
): void {
  const resultDigest = bytesToHex(sha256(persistedResult))
  if (
    cursor.realm !== result.realm ||
    cursor.vaultId !== result.vaultId ||
    cursor.snapshotId !== result.snapshotId ||
    cursor.snapshotRevision !== result.snapshotRevision ||
    cursor.sealedControlDigest !== result.sealedControlDigest ||
    cursor.sealedControlVersion !== result.sealedControlVersion ||
    cursor.passAResultDigest !== resultDigest ||
    cursor.generation !== result.generation ||
    cursor.snapshotNonce !== result.snapshotNonce ||
    cursor.nextPageIndex !== result.pageCount ||
    cursor.cumulativeEntryCount !== result.recordCount ||
    cursor.cumulativeCanonicalEntryBytes !== result.totalCanonicalManifestEntryBytes ||
    cursor.version !== result.pageCount + 1 ||
    (result.pageCount === 0 && cursor.exclusiveSourcePinKey.state !== 'absent') ||
    (result.pageCount > 0 && cursor.exclusiveSourcePinKey.state !== 'present') ||
    (result.pageCount === 0 && cursor.priorPageRowDigest.state !== 'absent') ||
    (result.pageCount > 0 && cursor.priorPageRowDigest.state !== 'present')
  ) {
    throw new Error('backup manifest finalization cursor is invalid')
  }
}

function requireState(value: unknown): EncryptedWalletBackupManifestFinalizationState {
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== 3 ||
    !Object.hasOwn(value, 'control') ||
    !Object.hasOwn(value, 'passAResult') ||
    !Object.hasOwn(value, 'cursor')
  )
    throw new Error('backup manifest finalization state is invalid')
  const state = value as EncryptedWalletBackupManifestFinalizationState
  if (
    !(state.control instanceof Uint8Array) ||
    !(state.passAResult instanceof Uint8Array) ||
    !(state.cursor instanceof Uint8Array)
  )
    throw new Error('backup manifest finalization state is invalid')
  return Object.freeze({
    control: state.control.slice(),
    passAResult: state.passAResult.slice(),
    cursor: state.cursor.slice(),
  })
}

function addReference(
  pages: PreparedEncryptedWalletBackupObject[],
  pageIds: Map<string, string>,
  digests: Map<string, string>,
  value: PreparedEncryptedWalletBackupObject,
): void {
  const byId = pageIds.get(value.objectId)
  const byDigest = digests.get(value.digest)
  if (byId !== undefined || byDigest !== undefined)
    throw new Error('backup manifest finalization reference conflicts')
  pageIds.set(value.objectId, value.digest)
  digests.set(value.digest, value.objectId)
  pages.push(value)
}

function addChunkReference(
  references: Map<string, string>,
  pageIds: Map<string, string>,
  digests: Map<string, string>,
  objectId: string,
  digest: string,
): void {
  const byId = references.get(objectId) ?? pageIds.get(objectId)
  const byDigest = digests.get(digest)
  if ((byId !== undefined && byId !== digest) || (byDigest !== undefined && byDigest !== objectId))
    throw new Error('backup manifest finalization reference conflicts')
  references.set(objectId, digest)
  digests.set(digest, objectId)
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < Math.min(left.byteLength, right.byteLength); index += 1) {
    const difference = left[index]! - right[index]!
    if (difference !== 0) return difference
  }
  return left.byteLength - right.byteLength
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  )
}
