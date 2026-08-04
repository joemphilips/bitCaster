import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { decode } from 'cborg'
import {
  ENCRYPTED_WALLET_BACKUP_MANIFEST_BODY_BYTES,
  prepareEncryptedWalletBackupManifestPage,
  readPreparedEncryptedWalletBackupObject,
  rehydratePreparedEncryptedWalletBackupManifestPage,
  type EncryptedWalletBackupKeyHandle,
  type EncryptedWalletBackupRuntime,
  type EncryptedWalletBackupWireObject,
  type PreparedEncryptedWalletBackupObject,
} from './encryptedWalletBackup.ts'
import { encodeCanonicalBackupCbor as encodeCanonical } from './encryptedWalletBackupCbor.ts'
import { readEncryptedWalletBackupManifestPageProvenance } from './encryptedWalletBackupManifestPageAuthority.ts'
import {
  readEncryptedWalletBackupManifestPassABoundary,
  rehydrateEncryptedWalletBackupManifestPassAResult,
} from './encryptedWalletBackupManifestPassA.ts'
import {
  joinEncryptedWalletBackupManifestSourcePage,
  type EncryptedWalletBackupManifestSourceJoinEvidence,
  type EncryptedWalletBackupManifestSourceJoinStore,
  type EncryptedWalletBackupManifestStagedPackProvider,
} from './encryptedWalletBackupManifestSourceJoin.ts'
import {
  decodeEncryptedWalletBackupFrozenSnapshot,
  encodeEncryptedWalletBackupFrozenSnapshotScope,
} from './encryptedWalletBackupSnapshotPersistence.ts'
import type { EncryptedWalletBackupFrozenSnapshotControl } from './encryptedWalletBackupSnapshotAuthority.ts'
import type { EncryptedWalletBackupPreparedRecordSnapshotBatchStore } from './encryptedWalletBackupPreparedRecordPersistence.ts'
import { requireRealm, requireUtf8Text } from './encryptedWalletBackupServerValidation.ts'

/** Covers the strict CBOR row metadata, AAD, source keys, and row digest. */
export const ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_ROW_OVERHEAD_MAX_BYTES = 8_192 as const
export const ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_ROW_MAX_BYTES =
  ENCRYPTED_WALLET_BACKUP_MANIFEST_BODY_BYTES +
  ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_ROW_OVERHEAD_MAX_BYTES
export const ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_TRANSACTION_MAX_BYTES = 1_048_576 as const
export const ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_TRANSACTION_ROW_MAX = 5 as const
export const ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_CURSOR_MAX_BYTES = 2_048 as const

export type EncryptedWalletBackupManifestPageOptionalBytes =
  | Readonly<{ state: 'absent' }>
  | Readonly<{ state: 'present'; value: Uint8Array }>

export interface PersistedEncryptedWalletBackupManifestPageCursor {
  readonly schemaVersion: 1
  readonly realm: string
  readonly vaultId: string
  readonly snapshotId: string
  readonly snapshotRevision: number
  readonly sealedControlDigest: string
  readonly sealedControlVersion: number
  readonly passAResultDigest: string
  readonly generation: number
  readonly snapshotNonce: string
  readonly nextPageIndex: number
  readonly exclusiveSourcePinKey: EncryptedWalletBackupManifestPageOptionalBytes
  readonly cumulativeEntryCount: number
  readonly cumulativeCanonicalEntryBytes: number
  readonly version: number
  readonly priorPageRowDigest: EncryptedWalletBackupManifestPageOptionalBytes
}

export interface PersistedEncryptedWalletBackupManifestPageRow {
  readonly schemaVersion: 1
  readonly realm: string
  readonly vaultId: string
  readonly snapshotId: string
  readonly snapshotRevision: number
  readonly sealedControlDigest: string
  readonly sealedControlVersion: number
  readonly passAResultDigest: string
  readonly generation: number
  readonly snapshotNonce: string
  readonly pageIndex: number
  readonly pageCount: number
  readonly sourceEvidence: Readonly<{
    entryCount: number
    canonicalEntryBytes: number
    firstPinKey: Uint8Array
    lastPinKey: Uint8Array
  }>
  readonly object: EncryptedWalletBackupWireObject
  readonly rowDigest: string
}

export interface EncryptedWalletBackupManifestPageState {
  readonly control: Uint8Array | null
  readonly passAResult: Uint8Array | null
  readonly cursor: Uint8Array | null
  readonly currentPage: Uint8Array | null
  readonly priorPage: Uint8Array | null
}

export interface EncryptedWalletBackupManifestPagePersistenceTransaction extends EncryptedWalletBackupManifestPageState {
  insertPageAndAdvance(input: Readonly<{ page: Uint8Array; cursor: Uint8Array }>): Promise<void>
  completeEmptyCursor(cursor: Uint8Array): Promise<void>
}

export interface EncryptedWalletBackupManifestPagePersistenceStore {
  /** Reserve the exact five state rows and bytes before exposing any buffer. */
  readManifestPageState(
    input: Readonly<{
      scope: Uint8Array
      maximumRows: number
      maximumBytes: number
    }>,
  ): Promise<EncryptedWalletBackupManifestPageState>
  /**
   * Reserve all rows and application bytes before copying a buffer. The adapter
   * invokes `use` once, commits only its exact return value, and rolls back on
   * every error. It enforces unique page slots and one cursor per scope.
   */
  withManifestPageTransaction<T>(
    expected: Readonly<{
      scope: Uint8Array
      expectedControl: Uint8Array
      expectedPassAResult: Uint8Array
      expectedCursor: Uint8Array | null
      expectedCurrentPage: Uint8Array | null
      expectedPriorPage: Uint8Array | null
      reservedReadRows: number
      reservedReadBytes: number
      reservedWriteRows: number
      reservedWriteBytes: number
    }>,
    use: (transaction: EncryptedWalletBackupManifestPagePersistenceTransaction) => Promise<T>,
  ): Promise<unknown>
}

export type EncryptedWalletBackupManifestPagePersistenceResult =
  | Readonly<{ state: 'completed' }>
  | Readonly<{ state: 'page'; page: PreparedEncryptedWalletBackupObject; recovered: boolean }>

export function encodeEncryptedWalletBackupManifestPageCursor(
  value: PersistedEncryptedWalletBackupManifestPageCursor,
): Uint8Array {
  const cursor = requireCursor(value)
  const encoded = encodeCanonical([
    1,
    'encrypted-wallet-backup-manifest-pass-b-cursor',
    cursor.realm,
    hexToBytes(cursor.vaultId),
    cursor.snapshotId,
    cursor.snapshotRevision,
    hexToBytes(cursor.sealedControlDigest),
    cursor.sealedControlVersion,
    hexToBytes(cursor.passAResultDigest),
    cursor.generation,
    hexToBytes(cursor.snapshotNonce),
    cursor.nextPageIndex,
    optionalBytesWire(cursor.exclusiveSourcePinKey),
    cursor.cumulativeEntryCount,
    cursor.cumulativeCanonicalEntryBytes,
    cursor.version,
    optionalBytesWire(cursor.priorPageRowDigest),
  ])
  if (encoded.byteLength > ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_CURSOR_MAX_BYTES)
    invalid('backup manifest Pass-B cursor')
  return encoded
}

export function decodeEncryptedWalletBackupManifestPageCursor(
  value: Uint8Array,
): PersistedEncryptedWalletBackupManifestPageCursor {
  const raw = decodeCanonical(
    value,
    17,
    'backup manifest Pass-B cursor',
    ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_CURSOR_MAX_BYTES,
  )
  if (raw[0] !== 1 || raw[1] !== 'encrypted-wallet-backup-manifest-pass-b-cursor')
    invalid('backup manifest Pass-B cursor')
  return requireCursor({
    schemaVersion: 1,
    realm: requireRealm(raw[2]),
    vaultId: hex(raw[3], 32),
    snapshotId: requireUtf8Text(raw[4], 128, 'snapshot id'),
    snapshotRevision: nonNegative(raw[5]),
    sealedControlDigest: hex(raw[6], 32),
    sealedControlVersion: positive(raw[7]),
    passAResultDigest: hex(raw[8], 32),
    generation: positive(raw[9]),
    snapshotNonce: hex(raw[10], 16),
    nextPageIndex: nonNegative(raw[11]),
    exclusiveSourcePinKey: decodeOptionalBytes(raw[12], 1_024),
    cumulativeEntryCount: nonNegative(raw[13]),
    cumulativeCanonicalEntryBytes: nonNegative(raw[14]),
    version: positive(raw[15]),
    priorPageRowDigest: decodeOptionalBytes(raw[16], 32),
  })
}

export function encodeEncryptedWalletBackupManifestPageRow(
  value: PersistedEncryptedWalletBackupManifestPageRow,
): Uint8Array {
  const row = requireRow(value)
  const body = rowBody(row)
  return encodeCanonical([...body, hexToBytes(row.rowDigest)])
}

export function decodeEncryptedWalletBackupManifestPageRow(
  value: Uint8Array,
): PersistedEncryptedWalletBackupManifestPageRow {
  const raw = decodeCanonical(value, 16, 'backup manifest page row')
  return requireRow({
    schemaVersion: 1,
    realm: requireRealm(raw[2]),
    vaultId: hex(raw[3], 32),
    snapshotId: requireUtf8Text(raw[4], 128, 'snapshot id'),
    snapshotRevision: nonNegative(raw[5]),
    sealedControlDigest: hex(raw[6], 32),
    sealedControlVersion: positive(raw[7]),
    passAResultDigest: hex(raw[8], 32),
    generation: positive(raw[9]),
    snapshotNonce: hex(raw[10], 16),
    pageIndex: nonNegative(raw[11]),
    pageCount: positive(raw[12]),
    sourceEvidence: decodeEvidence(raw[13]),
    object: decodeObject(raw[14]),
    rowDigest: hex(raw[15], 32),
  } as unknown as PersistedEncryptedWalletBackupManifestPageRow)
}

/** Build or recover one Pass-B page. It performs no target or network operation. */
export async function persistNextEncryptedWalletBackupManifestPage(input: {
  readonly store: EncryptedWalletBackupManifestPagePersistenceStore
  readonly sourceStore: EncryptedWalletBackupManifestSourceJoinStore
  readonly stagedPackProvider: EncryptedWalletBackupManifestStagedPackProvider
  readonly snapshotStore: EncryptedWalletBackupPreparedRecordSnapshotBatchStore
  readonly control: EncryptedWalletBackupFrozenSnapshotControl
  readonly keyHandle: EncryptedWalletBackupKeyHandle
  readonly seed: Uint8Array
  readonly runtime?: EncryptedWalletBackupRuntime
}): Promise<EncryptedWalletBackupManifestPagePersistenceResult> {
  const scope = encodeEncryptedWalletBackupFrozenSnapshotScope(input.control)
  const state = await readManifestPageState(input.store, scope)
  const context = rehydrateContext(input.control, state)
  const cursor =
    state.cursor === null
      ? initialCursor(context)
      : decodeEncryptedWalletBackupManifestPageCursor(state.cursor)
  requireCursorContext(cursor, context)
  await validatePrior(input, context, cursor, state.priorPage)
  if (cursor.nextPageIndex === context.result.pageCount)
    return completeEmptyOrFinished(input.store, scope, state, context, cursor)
  if (state.currentPage !== null) throw new Error('backup manifest page slot conflicts with cursor')
  const boundary = readEncryptedWalletBackupManifestPassABoundary(
    context.result,
    cursor.nextPageIndex,
  )
  const joined = await joinEncryptedWalletBackupManifestSourcePage({
    store: input.sourceStore,
    stagedPackProvider: input.stagedPackProvider,
    boundary,
    keyHandle: input.keyHandle,
    seed: input.seed,
    snapshotStore: input.snapshotStore,
    exclusiveAfter: optionalValue(cursor.exclusiveSourcePinKey),
  })
  const page = await prepareEncryptedWalletBackupManifestPage({
    keyHandle: input.keyHandle,
    boundary,
    entries: joined.entries,
    runtime: input.runtime,
  })
  const row = pageRow(context, cursor, joined.evidence, page)
  const next = advanceCursor(cursor, row)
  try {
    await commit(
      input.store,
      scope,
      state,
      encodeEncryptedWalletBackupManifestPageRow(row),
      encodeEncryptedWalletBackupManifestPageCursor(next),
    )
    return Object.freeze({ state: 'page', page, recovered: false })
  } catch (error) {
    const recovered = await recoverCommit(input, scope, context, cursor, error)
    if (recovered !== null) return recovered
    throw error
  }
}

function rehydrateContext(
  control: EncryptedWalletBackupFrozenSnapshotControl,
  state: EncryptedWalletBackupManifestPageState,
) {
  if (state.control === null || state.passAResult === null)
    throw new Error('backup manifest persistence state is incomplete')
  const current = decodeEncryptedWalletBackupFrozenSnapshot(state.control)
  const result = rehydrateEncryptedWalletBackupManifestPassAResult({
    control,
    current,
    persisted: state.passAResult,
  })
  return Object.freeze({
    current,
    result,
    control: state.control,
    resultBytes: state.passAResult,
    resultDigest: bytesToHex(sha256(state.passAResult)),
  })
}

async function readManifestPageState(
  store: EncryptedWalletBackupManifestPagePersistenceStore,
  scope: Uint8Array,
): Promise<EncryptedWalletBackupManifestPageState> {
  return requireState(
    await store.readManifestPageState({
      scope: scope.slice(),
      maximumRows: ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_TRANSACTION_ROW_MAX,
      maximumBytes: ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_TRANSACTION_MAX_BYTES,
    }),
  )
}

function initialCursor(
  context: ReturnType<typeof rehydrateContext>,
): PersistedEncryptedWalletBackupManifestPageCursor {
  return Object.freeze({
    schemaVersion: 1,
    realm: context.result.realm,
    vaultId: context.result.vaultId,
    snapshotId: context.result.snapshotId,
    snapshotRevision: context.result.snapshotRevision,
    sealedControlDigest: context.result.sealedControlDigest,
    sealedControlVersion: context.result.sealedControlVersion,
    passAResultDigest: context.resultDigest,
    generation: context.result.generation,
    snapshotNonce: context.result.snapshotNonce,
    nextPageIndex: 0,
    exclusiveSourcePinKey: absent(),
    cumulativeEntryCount: 0,
    cumulativeCanonicalEntryBytes: 0,
    version: 1,
    priorPageRowDigest: absent(),
  })
}

function requireCursorContext(
  cursor: PersistedEncryptedWalletBackupManifestPageCursor,
  context: ReturnType<typeof rehydrateContext>,
): void {
  const result = context.result
  if (
    cursor.realm !== result.realm ||
    cursor.vaultId !== result.vaultId ||
    cursor.snapshotId !== result.snapshotId ||
    cursor.snapshotRevision !== result.snapshotRevision ||
    cursor.sealedControlDigest !== result.sealedControlDigest ||
    cursor.sealedControlVersion !== result.sealedControlVersion ||
    cursor.passAResultDigest !== context.resultDigest ||
    cursor.generation !== result.generation ||
    cursor.snapshotNonce !== result.snapshotNonce ||
    cursor.nextPageIndex > result.pageCount ||
    cursor.version !== add(cursor.nextPageIndex, 1)
  )
    invalid('backup manifest Pass-B cursor')
  let entries = 0
  let bytes = 0
  for (let index = 0; index < cursor.nextPageIndex; index += 1) {
    const boundary = result.boundaries[index]!
    entries = add(entries, boundary.entryCount)
    bytes = add(bytes, boundary.canonicalEntryBytes)
  }
  if (
    entries !== cursor.cumulativeEntryCount ||
    bytes !== cursor.cumulativeCanonicalEntryBytes ||
    (cursor.nextPageIndex === 0) !== (cursor.priorPageRowDigest.state === 'absent') ||
    (cursor.nextPageIndex === 0) !== (cursor.exclusiveSourcePinKey.state === 'absent')
  )
    invalid('backup manifest Pass-B cursor')
}

async function validatePrior(
  input: Parameters<typeof persistNextEncryptedWalletBackupManifestPage>[0],
  context: ReturnType<typeof rehydrateContext>,
  cursor: PersistedEncryptedWalletBackupManifestPageCursor,
  raw: Uint8Array | null,
): Promise<void> {
  if (cursor.nextPageIndex === 0) {
    if (raw !== null) invalid('backup manifest prior page')
    return
  }
  if (raw === null) invalid('backup manifest prior page')
  const row = decodeEncryptedWalletBackupManifestPageRow(raw)
  requireRowContext(row, context, cursor.nextPageIndex - 1)
  if (
    cursor.priorPageRowDigest.state !== 'present' ||
    !equalBytes(cursor.priorPageRowDigest.value, hexToBytes(row.rowDigest)) ||
    cursor.exclusiveSourcePinKey.state !== 'present' ||
    !equalBytes(cursor.exclusiveSourcePinKey.value, row.sourceEvidence.lastPinKey)
  )
    invalid('backup manifest prior page')
  const boundary = readEncryptedWalletBackupManifestPassABoundary(context.result, row.pageIndex)
  await rehydratePreparedEncryptedWalletBackupManifestPage({
    keyHandle: input.keyHandle,
    seed: input.seed,
    boundary,
    object: row.object,
    sourceEvidence: row.sourceEvidence,
  })
}

function pageRow(
  context: ReturnType<typeof rehydrateContext>,
  cursor: PersistedEncryptedWalletBackupManifestPageCursor,
  evidence: EncryptedWalletBackupManifestSourceJoinEvidence,
  page: PreparedEncryptedWalletBackupObject,
): PersistedEncryptedWalletBackupManifestPageRow {
  if (evidence.firstPinKey === null || evidence.lastPinKey === null || evidence.entryCount < 1)
    invalid('backup manifest source evidence')
  const boundary = readEncryptedWalletBackupManifestPassABoundary(
    context.result,
    cursor.nextPageIndex,
  )
  const provenance = readEncryptedWalletBackupManifestPageProvenance(page)
  if (
    provenance.boundary !== boundary ||
    !equalBytes(provenance.firstPinKey, evidence.firstPinKey) ||
    !equalBytes(provenance.lastPinKey, evidence.lastPinKey)
  )
    invalid('backup manifest page provenance')
  if (
    cursor.exclusiveSourcePinKey.state === 'present' &&
    compare(evidence.firstPinKey, cursor.exclusiveSourcePinKey.value) <= 0
  )
    invalid('backup manifest source evidence')
  const wire = readPreparedEncryptedWalletBackupObject(page)
  const base = {
    schemaVersion: 1 as const,
    realm: context.result.realm,
    vaultId: context.result.vaultId,
    snapshotId: context.result.snapshotId,
    snapshotRevision: context.result.snapshotRevision,
    sealedControlDigest: context.result.sealedControlDigest,
    sealedControlVersion: context.result.sealedControlVersion,
    passAResultDigest: context.resultDigest,
    generation: context.result.generation,
    snapshotNonce: context.result.snapshotNonce,
    pageIndex: cursor.nextPageIndex,
    pageCount: context.result.pageCount,
    sourceEvidence: {
      entryCount: evidence.entryCount,
      canonicalEntryBytes: evidence.canonicalEntryBytes,
      firstPinKey: provenance.firstPinKey,
      lastPinKey: provenance.lastPinKey,
    },
    object: cloneObject(wire),
  }
  return Object.freeze({
    ...base,
    rowDigest: bytesToHex(
      sha256(encodeCanonical(rowBody(base as PersistedEncryptedWalletBackupManifestPageRow))),
    ),
  })
}

function advanceCursor(
  cursor: PersistedEncryptedWalletBackupManifestPageCursor,
  row: PersistedEncryptedWalletBackupManifestPageRow,
): PersistedEncryptedWalletBackupManifestPageCursor {
  return requireCursor({
    ...cursor,
    nextPageIndex: add(cursor.nextPageIndex, 1),
    exclusiveSourcePinKey: present(row.sourceEvidence.lastPinKey),
    cumulativeEntryCount: add(cursor.cumulativeEntryCount, row.sourceEvidence.entryCount),
    cumulativeCanonicalEntryBytes: add(
      cursor.cumulativeCanonicalEntryBytes,
      row.sourceEvidence.canonicalEntryBytes,
    ),
    version: add(cursor.version, 1),
    priorPageRowDigest: present(hexToBytes(row.rowDigest)),
  })
}

async function commit(
  store: EncryptedWalletBackupManifestPagePersistenceStore,
  scope: Uint8Array,
  state: EncryptedWalletBackupManifestPageState,
  page: Uint8Array,
  cursor: Uint8Array,
): Promise<void> {
  const expected = reservation(scope, state, page, cursor)
  const sentinel = Object.freeze({ manifestPage: true })
  let calls = 0
  let settled = false
  await store
    .withManifestPageTransaction(expected, async (transaction) => {
      if (settled || calls++ !== 0) invalid('backup manifest page callback')
      requireExactState(transaction, state)
      await transaction.insertPageAndAdvance({ page: page.slice(), cursor: cursor.slice() })
      return sentinel
    })
    .then((value) => {
      if (calls !== 1 || value !== sentinel) invalid('backup manifest page callback')
    })
    .finally(() => {
      settled = true
    })
}

async function recoverCommit(
  input: Parameters<typeof persistNextEncryptedWalletBackupManifestPage>[0],
  scope: Uint8Array,
  context: ReturnType<typeof rehydrateContext>,
  cursor: PersistedEncryptedWalletBackupManifestPageCursor,
  _error: unknown,
): Promise<EncryptedWalletBackupManifestPagePersistenceResult | null> {
  const state = await readManifestPageState(input.store, scope)
  const current = rehydrateContext(input.control, state)
  if (
    current.resultDigest !== context.resultDigest ||
    state.cursor === null ||
    state.priorPage === null
  )
    return null
  const next = decodeEncryptedWalletBackupManifestPageCursor(state.cursor)
  requireCursorContext(next, current)
  if (next.nextPageIndex !== cursor.nextPageIndex + 1) return null
  const row = decodeEncryptedWalletBackupManifestPageRow(state.priorPage)
  requireRowContext(row, current, cursor.nextPageIndex)
  if (
    next.priorPageRowDigest.state !== 'present' ||
    !equalBytes(next.priorPageRowDigest.value, hexToBytes(row.rowDigest)) ||
    next.exclusiveSourcePinKey.state !== 'present' ||
    !equalBytes(next.exclusiveSourcePinKey.value, row.sourceEvidence.lastPinKey)
  )
    return null
  const boundary = readEncryptedWalletBackupManifestPassABoundary(current.result, row.pageIndex)
  const page = await rehydratePreparedEncryptedWalletBackupManifestPage({
    keyHandle: input.keyHandle,
    seed: input.seed,
    boundary,
    object: row.object,
    sourceEvidence: row.sourceEvidence,
  })
  return Object.freeze({ state: 'page', page, recovered: true })
}

async function completeEmptyOrFinished(
  store: EncryptedWalletBackupManifestPagePersistenceStore,
  scope: Uint8Array,
  state: EncryptedWalletBackupManifestPageState,
  context: ReturnType<typeof rehydrateContext>,
  cursor: PersistedEncryptedWalletBackupManifestPageCursor,
): Promise<EncryptedWalletBackupManifestPagePersistenceResult> {
  if (
    cursor.cumulativeEntryCount !== context.result.recordCount ||
    cursor.cumulativeCanonicalEntryBytes !== context.result.totalCanonicalManifestEntryBytes
  )
    invalid('backup manifest completion')
  if (state.cursor === null)
    await commitEmpty(store, scope, state, encodeEncryptedWalletBackupManifestPageCursor(cursor))
  return Object.freeze({ state: 'completed' })
}

async function commitEmpty(
  store: EncryptedWalletBackupManifestPagePersistenceStore,
  scope: Uint8Array,
  state: EncryptedWalletBackupManifestPageState,
  cursor: Uint8Array,
): Promise<void> {
  const expected = reservation(scope, state, new Uint8Array(), cursor)
  const sentinel = Object.freeze({ manifestEmptyPage: true })
  let calls = 0
  let settled = false
  await store
    .withManifestPageTransaction(expected, async (transaction) => {
      if (settled || calls++ !== 0) invalid('backup manifest page callback')
      requireExactState(transaction, state)
      await transaction.completeEmptyCursor(cursor.slice())
      return sentinel
    })
    .then((value) => {
      if (calls !== 1 || value !== sentinel) invalid('backup manifest page callback')
    })
    .finally(() => {
      settled = true
    })
}

function reservation(
  scope: Uint8Array,
  state: EncryptedWalletBackupManifestPageState,
  page: Uint8Array,
  cursor: Uint8Array,
) {
  const reads = [
    scope,
    state.control,
    state.passAResult,
    state.cursor,
    state.currentPage,
    state.priorPage,
  ].filter((value): value is Uint8Array => value !== null)
  const writes = page.byteLength === 0 ? [cursor] : [page, cursor]
  const readBytes = reads.reduce((total, value) => add(total, value.byteLength), 0)
  const writeBytes = writes.reduce((total, value) => add(total, value.byteLength), 0)
  if (
    reads.length > ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_TRANSACTION_ROW_MAX ||
    writes.length > 2 ||
    add(readBytes, writeBytes) > ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_TRANSACTION_MAX_BYTES
  )
    invalid('backup manifest page transaction')
  return Object.freeze({
    scope: scope.slice(),
    expectedControl: state.control!.slice(),
    expectedPassAResult: state.passAResult!.slice(),
    expectedCursor: state.cursor?.slice() ?? null,
    expectedCurrentPage: state.currentPage?.slice() ?? null,
    expectedPriorPage: state.priorPage?.slice() ?? null,
    reservedReadRows: reads.length,
    reservedReadBytes: readBytes,
    reservedWriteRows: writes.length,
    reservedWriteBytes: writeBytes,
  })
}

function requireRowContext(
  row: PersistedEncryptedWalletBackupManifestPageRow,
  context: ReturnType<typeof rehydrateContext>,
  pageIndex: number,
): void {
  const result = context.result
  if (
    row.realm !== result.realm ||
    row.vaultId !== result.vaultId ||
    row.snapshotId !== result.snapshotId ||
    row.snapshotRevision !== result.snapshotRevision ||
    row.sealedControlDigest !== result.sealedControlDigest ||
    row.sealedControlVersion !== result.sealedControlVersion ||
    row.passAResultDigest !== context.resultDigest ||
    row.generation !== result.generation ||
    row.snapshotNonce !== result.snapshotNonce ||
    row.pageIndex !== pageIndex ||
    row.pageCount !== result.pageCount
  )
    invalid('backup manifest page row')
  const boundary = result.boundaries[pageIndex]
  if (
    boundary === undefined ||
    row.sourceEvidence.entryCount !== boundary.entryCount ||
    row.sourceEvidence.canonicalEntryBytes !== boundary.canonicalEntryBytes
  )
    invalid('backup manifest page row')
}

function requireState(value: unknown): EncryptedWalletBackupManifestPageState {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 5
  )
    invalid('backup manifest persistence state')
  const row = value as Record<string, unknown>
  for (const field of ['control', 'passAResult', 'cursor', 'currentPage', 'priorPage'])
    if (!Object.hasOwn(row, field) || (row[field] !== null && !(row[field] instanceof Uint8Array)))
      invalid('backup manifest persistence state')
  const bytes = [
    row.control,
    row.passAResult,
    row.cursor,
    row.currentPage,
    row.priorPage,
  ].reduce<number>(
    (total, buffer) => total + (buffer instanceof Uint8Array ? buffer.byteLength : 0),
    0,
  )
  if (bytes > ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_TRANSACTION_MAX_BYTES)
    invalid('backup manifest persistence state')
  return Object.freeze({
    control: cloneNullable(row.control),
    passAResult: cloneNullable(row.passAResult),
    cursor: cloneNullable(row.cursor),
    currentPage: cloneNullable(row.currentPage),
    priorPage: cloneNullable(row.priorPage),
  })
}

function requireExactState(
  actual: EncryptedWalletBackupManifestPageState,
  expected: EncryptedWalletBackupManifestPageState,
): void {
  for (const field of ['control', 'passAResult', 'cursor', 'currentPage', 'priorPage'] as const)
    if (!equalNullable(actual[field], expected[field])) invalid('backup manifest page transaction')
}

function requireCursor(value: unknown): PersistedEncryptedWalletBackupManifestPageCursor {
  const row = strict(
    value,
    [
      'schemaVersion',
      'realm',
      'vaultId',
      'snapshotId',
      'snapshotRevision',
      'sealedControlDigest',
      'sealedControlVersion',
      'passAResultDigest',
      'generation',
      'snapshotNonce',
      'nextPageIndex',
      'exclusiveSourcePinKey',
      'cumulativeEntryCount',
      'cumulativeCanonicalEntryBytes',
      'version',
      'priorPageRowDigest',
    ],
    'backup manifest Pass-B cursor',
  )
  if (row.schemaVersion !== 1) invalid('backup manifest Pass-B cursor')
  return Object.freeze({
    schemaVersion: 1,
    realm: requireRealm(row.realm),
    vaultId: hexText(row.vaultId, 32),
    snapshotId: requireUtf8Text(row.snapshotId, 128, 'snapshot id'),
    snapshotRevision: nonNegative(row.snapshotRevision),
    sealedControlDigest: hexText(row.sealedControlDigest, 32),
    sealedControlVersion: positive(row.sealedControlVersion),
    passAResultDigest: hexText(row.passAResultDigest, 32),
    generation: positive(row.generation),
    snapshotNonce: hexText(row.snapshotNonce, 16),
    nextPageIndex: nonNegative(row.nextPageIndex),
    exclusiveSourcePinKey: requireOptionalBytes(row.exclusiveSourcePinKey, 1024),
    cumulativeEntryCount: nonNegative(row.cumulativeEntryCount),
    cumulativeCanonicalEntryBytes: nonNegative(row.cumulativeCanonicalEntryBytes),
    version: positive(row.version),
    priorPageRowDigest: requireOptionalBytes(row.priorPageRowDigest, 32),
  })
}

function requireRow(value: unknown): PersistedEncryptedWalletBackupManifestPageRow {
  const row = strict(
    value,
    [
      'schemaVersion',
      'realm',
      'vaultId',
      'snapshotId',
      'snapshotRevision',
      'sealedControlDigest',
      'sealedControlVersion',
      'passAResultDigest',
      'generation',
      'snapshotNonce',
      'pageIndex',
      'pageCount',
      'sourceEvidence',
      'object',
      'rowDigest',
    ],
    'backup manifest page row',
  )
  if (row.schemaVersion !== 1) invalid('backup manifest page row')
  const result = Object.freeze({
    schemaVersion: 1 as const,
    realm: requireRealm(row.realm),
    vaultId: hexText(row.vaultId, 32),
    snapshotId: requireUtf8Text(row.snapshotId, 128, 'snapshot id'),
    snapshotRevision: nonNegative(row.snapshotRevision),
    sealedControlDigest: hexText(row.sealedControlDigest, 32),
    sealedControlVersion: positive(row.sealedControlVersion),
    passAResultDigest: hexText(row.passAResultDigest, 32),
    generation: positive(row.generation),
    snapshotNonce: hexText(row.snapshotNonce, 16),
    pageIndex: nonNegative(row.pageIndex),
    pageCount: positive(row.pageCount),
    sourceEvidence: requireEvidence(row.sourceEvidence),
    object: requireObject(row.object),
    rowDigest: hexText(row.rowDigest, 32),
  })
  const encoded = encodeCanonical([...rowBody(result), hexToBytes(result.rowDigest)])
  if (
    result.pageIndex >= result.pageCount ||
    encoded.byteLength > ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_ROW_MAX_BYTES ||
    !equalHex(result.rowDigest, bytesToHex(sha256(encodeCanonical(rowBody(result)))))
  )
    invalid('backup manifest page row')
  return result
}

function rowBody(
  row:
    | Omit<PersistedEncryptedWalletBackupManifestPageRow, 'rowDigest'>
    | PersistedEncryptedWalletBackupManifestPageRow,
): unknown[] {
  return [
    1,
    'encrypted-wallet-backup-manifest-page',
    row.realm,
    hexToBytes(row.vaultId),
    row.snapshotId,
    row.snapshotRevision,
    hexToBytes(row.sealedControlDigest),
    row.sealedControlVersion,
    hexToBytes(row.passAResultDigest),
    row.generation,
    hexToBytes(row.snapshotNonce),
    row.pageIndex,
    row.pageCount,
    [
      row.sourceEvidence.entryCount,
      row.sourceEvidence.canonicalEntryBytes,
      row.sourceEvidence.firstPinKey,
      row.sourceEvidence.lastPinKey,
    ],
    objectWire(row.object),
  ]
}

function objectWire(object: EncryptedWalletBackupWireObject): unknown[] {
  return [
    object.formatVersion,
    object.kindCode,
    object.realm,
    hexToBytes(object.vaultId),
    hexToBytes(object.objectId),
    object.generation,
    object.paddedLength,
    hexToBytes(object.digest),
    object.aad,
    object.body,
  ]
}
function decodeObject(value: unknown): EncryptedWalletBackupWireObject {
  if (!Array.isArray(value) || value.length !== 10) invalid('backup manifest page row')
  return requireObject({
    formatVersion: value[0],
    kindCode: value[1],
    realm: value[2],
    vaultId: hex(value[3], 32),
    objectId: hex(value[4], 16),
    generation: value[5],
    paddedLength: value[6],
    digest: hex(value[7], 32),
    aad: value[8],
    body: value[9],
  })
}
function requireObject(value: unknown): EncryptedWalletBackupWireObject {
  const row = strict(
    value,
    [
      'formatVersion',
      'kindCode',
      'realm',
      'vaultId',
      'objectId',
      'generation',
      'paddedLength',
      'digest',
      'aad',
      'body',
    ],
    'backup manifest page row',
  )
  if (
    row.formatVersion !== 1 ||
    row.kindCode !== 2 ||
    row.paddedLength !== 65_536 ||
    !(row.aad instanceof Uint8Array) ||
    row.aad.byteLength < 1 ||
    row.aad.byteLength > 4096 ||
    !(row.body instanceof Uint8Array) ||
    row.body.byteLength !== ENCRYPTED_WALLET_BACKUP_MANIFEST_BODY_BYTES
  )
    invalid('backup manifest page row')
  return Object.freeze({
    formatVersion: 1,
    kindCode: 2,
    realm: requireRealm(row.realm),
    vaultId: hexText(row.vaultId, 32),
    objectId: hexText(row.objectId, 16),
    generation: positive(row.generation),
    paddedLength: 65_536,
    digest: hexText(row.digest, 32),
    aad: row.aad.slice(),
    body: row.body.slice(),
  })
}
function cloneObject(object: EncryptedWalletBackupWireObject): EncryptedWalletBackupWireObject {
  return requireObject(object)
}
function requireEvidence(value: unknown) {
  const row = strict(
    value,
    ['entryCount', 'canonicalEntryBytes', 'firstPinKey', 'lastPinKey'],
    'backup manifest page row',
  )
  if (
    !(row.firstPinKey instanceof Uint8Array) ||
    !(row.lastPinKey instanceof Uint8Array) ||
    row.firstPinKey.byteLength < 1 ||
    row.lastPinKey.byteLength < 1 ||
    row.firstPinKey.byteLength > 1024 ||
    row.lastPinKey.byteLength > 1024 ||
    compare(row.firstPinKey, row.lastPinKey) > 0
  )
    invalid('backup manifest page row')
  return Object.freeze({
    entryCount: positive(row.entryCount),
    canonicalEntryBytes: positive(row.canonicalEntryBytes),
    firstPinKey: row.firstPinKey.slice(),
    lastPinKey: row.lastPinKey.slice(),
  })
}
function decodeEvidence(value: unknown) {
  if (!Array.isArray(value) || value.length !== 4) invalid('backup manifest page row')
  return requireEvidence({
    entryCount: value[0],
    canonicalEntryBytes: value[1],
    firstPinKey: value[2],
    lastPinKey: value[3],
  })
}
function optionalBytesWire(value: EncryptedWalletBackupManifestPageOptionalBytes): unknown[] {
  return value.state === 'absent' ? [0] : [1, value.value]
}
function decodeOptionalBytes(
  value: unknown,
  max: number,
): EncryptedWalletBackupManifestPageOptionalBytes {
  if (
    !Array.isArray(value) ||
    (value.length !== 1 && value.length !== 2) ||
    value[0] !== value.length - 1
  )
    invalid('backup manifest Pass-B cursor')
  return value.length === 1
    ? absent()
    : present(requireBytes(value[1], 1, max, 'backup manifest Pass-B cursor'))
}
function requireOptionalBytes(
  value: unknown,
  max: number,
): EncryptedWalletBackupManifestPageOptionalBytes {
  const row = strict(
    value,
    [
      'state',
      ...(typeof value === 'object' &&
      value !== null &&
      Object.hasOwn(value, 'state') &&
      (value as { state?: unknown }).state === 'present'
        ? ['value']
        : []),
    ],
    'backup manifest Pass-B cursor',
  )
  if (row.state === 'absent') return absent()
  if (row.state === 'present')
    return present(requireBytes(row.value, 1, max, 'backup manifest Pass-B cursor'))
  invalid('backup manifest Pass-B cursor')
}
function absent(): EncryptedWalletBackupManifestPageOptionalBytes {
  return Object.freeze({ state: 'absent' })
}
function present(value: Uint8Array): EncryptedWalletBackupManifestPageOptionalBytes {
  return Object.freeze({ state: 'present', value: value.slice() })
}
function optionalValue(value: EncryptedWalletBackupManifestPageOptionalBytes): Uint8Array | null {
  return value.state === 'absent' ? null : value.value.slice()
}
function decodeCanonical(
  value: Uint8Array,
  length: number,
  name: string,
  maximum = ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_ROW_MAX_BYTES,
): unknown[] {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > maximum)
    invalid(name)
  let raw: unknown
  try {
    raw = decode(value)
  } catch {
    invalid(name)
  }
  if (!Array.isArray(raw) || raw.length !== length || !equalBytes(value, encodeCanonical(raw)))
    invalid(name)
  return raw
}
function strict(value: unknown, fields: readonly string[], name: string): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== fields.length
  )
    invalid(name)
  const row = value as Record<string, unknown>
  for (const field of fields) if (!Object.hasOwn(row, field)) invalid(name)
  return row
}
function requireBytes(value: unknown, min: number, max: number, name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < min || value.byteLength > max)
    invalid(name)
  return value.slice()
}
function hex(value: unknown, bytes: number): string {
  if (!(value instanceof Uint8Array) || value.byteLength !== bytes)
    invalid('backup manifest page row')
  return bytesToHex(value)
}
function hexText(value: unknown, bytes: number): string {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value))
    invalid('backup manifest page row')
  return value
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid('backup manifest page row')
  return value as number
}
function nonNegative(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid('backup manifest page row')
  return value as number
}
function add(left: number, right: number): number {
  if (!Number.isSafeInteger(right) || right < 0 || left > Number.MAX_SAFE_INTEGER - right)
    invalid('backup manifest page bounds')
  return left + right
}
function compare(left: Uint8Array, right: Uint8Array): number {
  for (let i = 0; i < Math.min(left.byteLength, right.byteLength); i += 1) {
    const d = left[i]! - right[i]!
    if (d !== 0) return d
  }
  return left.byteLength - right.byteLength
}
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let i = 0; i < left.byteLength; i += 1) if (left[i] !== right[i]) return false
  return true
}
function equalHex(left: string, right: string): boolean {
  return left === right
}
function cloneNullable(value: unknown): Uint8Array | null {
  return value === null ? null : (value as Uint8Array).slice()
}
function equalNullable(left: Uint8Array | null, right: Uint8Array | null): boolean {
  return left === null || right === null ? left === right : equalBytes(left, right)
}
function invalid(name: string): never {
  throw new Error(`${name} is invalid`)
}
