import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { decode } from 'cborg'
import {
  encodeCanonicalBackupCbor as encodeCanonical,
  measureCanonicalBackupCbor,
} from './encryptedWalletBackupCbor.ts'
import {
  decodeEncryptedWalletBackupSnapshotPin,
  encodeEncryptedWalletBackupFrozenSnapshot,
  encodeEncryptedWalletBackupFrozenSnapshotScope,
  requireAuthenticatedEncryptedWalletBackupFrozenSnapshot,
  ENCRYPTED_WALLET_BACKUP_SNAPSHOT_RECORD_MAX,
  ENCRYPTED_WALLET_BACKUP_SNAPSHOT_TRANSACTION_MAX_BYTES,
  ENCRYPTED_WALLET_BACKUP_SNAPSHOT_TRANSACTION_ROW_MAX,
  type PersistedEncryptedWalletBackupFrozenSnapshot,
} from './encryptedWalletBackupSnapshotPersistence.ts'
import {
  ENCRYPTED_WALLET_BACKUP_SNAPSHOT_SEAL_LEAF_MAX,
  ENCRYPTED_WALLET_BACKUP_SNAPSHOT_SEAL_LEAF_MAX_COUNT,
  readEncryptedWalletBackupSnapshotSealMetadataPage,
  type EncryptedWalletBackupFrozenSnapshotSealStore,
} from './encryptedWalletBackupSnapshotSeal.ts'
import {
  readEncryptedWalletBackupManifestPassABoundary,
  registerEncryptedWalletBackupManifestPassABoundaries,
  type EncryptedWalletBackupManifestPageBoundary,
} from './encryptedWalletBackupManifestPageAuthority.ts'
import type { EncryptedWalletBackupFrozenSnapshotControl } from './encryptedWalletBackupSnapshotAuthority.ts'
import { requireRealm, requireUtf8Text } from './encryptedWalletBackupServerValidation.ts'

export const ENCRYPTED_WALLET_BACKUP_MANIFEST_PASS_A_PAGE_MAX_BYTES = 65_532 as const
export const ENCRYPTED_WALLET_BACKUP_MANIFEST_PASS_A_RESULT_MAX_BYTES = 65_535 as const

export {
  readEncryptedWalletBackupManifestPassABoundary,
  type EncryptedWalletBackupManifestPageBoundary,
}

export interface EncryptedWalletBackupManifestPassABoundary {
  readonly entryCount: number
  readonly canonicalEntryBytes: number
  readonly plannedCanonicalPageBytes: number
}

export interface PersistedEncryptedWalletBackupManifestPassAResult {
  readonly schemaVersion: 1
  readonly realm: string
  readonly vaultId: string
  readonly snapshotId: string
  readonly snapshotRevision: number
  readonly sealedControlVersion: number
  readonly sealRunRevision: number
  readonly sealedControlDigest: string
  readonly recordSetRoot: string
  readonly generation: number
  readonly snapshotNonce: string
  readonly recordCount: number
  readonly canonicalPinBytes: number
  readonly totalCanonicalManifestEntryBytes: number
  readonly pageCount: number
  readonly boundaries: readonly EncryptedWalletBackupManifestPassABoundary[]
}

export interface EncryptedWalletBackupManifestPassAResultTransaction {
  readonly control: Uint8Array | null
  readonly result: Uint8Array | null
  insertResult(result: Uint8Array): Promise<void>
}

export interface EncryptedWalletBackupManifestPassAResultStore {
  /**
   * Reserve two reads and at most one write before the callback receives data.
   * The transaction reads the exact snapshot control and its one Pass-A result.
   */
  withManifestPassAResultTransaction<T>(
    expected: Readonly<{
      readonly scope: Uint8Array
      readonly expectedVersion: number
      readonly expectedControl: Uint8Array
      readonly reservedReadRows: number
      readonly reservedReadBytes: number
      readonly reservedWriteRows: number
      readonly reservedWriteBytes: number
    }>,
    use: (transaction: EncryptedWalletBackupManifestPassAResultTransaction) => Promise<T>,
  ): Promise<unknown>
}

export type EncryptedWalletBackupManifestPassAStore = EncryptedWalletBackupFrozenSnapshotSealStore &
  EncryptedWalletBackupManifestPassAResultStore

export function measureEncryptedWalletBackupManifestPageCbor(input: {
  readonly generation: number
  readonly pageIndex: number
  readonly pageCount: number
  readonly entryCount: number
  readonly canonicalEntryBytes: number
}): number {
  const exact = requirePageSizeInput(input)
  return safeAdd(
    canonicalArrayHeaderBytes(7),
    measureCanonicalBackupCbor(1),
    measureCanonicalBackupCbor(2),
    measureCanonicalBackupCbor(exact.generation),
    measureCanonicalBackupCbor(new Uint8Array(16)),
    measureCanonicalBackupCbor(exact.pageIndex),
    measureCanonicalBackupCbor(exact.pageCount),
    canonicalArrayHeaderBytes(exact.entryCount),
    exact.canonicalEntryBytes,
  )
}

export async function planEncryptedWalletBackupManifestPassA(input: {
  readonly store: EncryptedWalletBackupManifestPassAStore
  readonly control: EncryptedWalletBackupFrozenSnapshotControl
  readonly current: PersistedEncryptedWalletBackupFrozenSnapshot
}): Promise<PersistedEncryptedWalletBackupManifestPassAResult> {
  const current = requireSealedControl(input.control, input.current)
  const planner = new ManifestPassAPlanner(input.store, input.control, current)
  const result = await planner.plan()
  await persistManifestPassAResult(input.store, input.control, current, result)
  registerManifestPassABoundaries(result)
  return result
}

function registerManifestPassABoundaries(
  result: PersistedEncryptedWalletBackupManifestPassAResult,
): void {
  registerEncryptedWalletBackupManifestPassABoundaries({
    result,
    resultDigest: bytesToHex(sha256(encodeEncryptedWalletBackupManifestPassAResult(result))),
    realm: result.realm,
    vaultId: result.vaultId,
    snapshotId: result.snapshotId,
    snapshotRevision: result.snapshotRevision,
    sealedControlVersion: result.sealedControlVersion,
    sealRunRevision: result.sealRunRevision,
    sealedControlDigest: result.sealedControlDigest,
    generation: result.generation,
    snapshotNonce: result.snapshotNonce,
    boundaries: result.boundaries,
  })
}

export function encodeEncryptedWalletBackupManifestPassAResult(
  value: PersistedEncryptedWalletBackupManifestPassAResult,
): Uint8Array {
  const result = requireManifestPassAResult(value)
  const encoded = encodeCanonical([
    1,
    'encrypted-wallet-backup-manifest-pass-a',
    result.realm,
    hexBytes(result.vaultId),
    result.snapshotId,
    result.snapshotRevision,
    result.sealedControlVersion,
    result.sealRunRevision,
    hexBytes(result.sealedControlDigest),
    hexBytes(result.recordSetRoot),
    result.generation,
    hexBytes(result.snapshotNonce),
    result.recordCount,
    result.canonicalPinBytes,
    result.totalCanonicalManifestEntryBytes,
    result.pageCount,
    result.boundaries.map((boundary) => [
      boundary.entryCount,
      boundary.canonicalEntryBytes,
      boundary.plannedCanonicalPageBytes,
    ]),
  ])
  if (encoded.byteLength > ENCRYPTED_WALLET_BACKUP_MANIFEST_PASS_A_RESULT_MAX_BYTES)
    throw new Error('backup manifest Pass-A result exceeds its capacity')
  return encoded
}

export function decodeEncryptedWalletBackupManifestPassAResult(
  value: Uint8Array,
): PersistedEncryptedWalletBackupManifestPassAResult {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < 1 ||
    value.byteLength > ENCRYPTED_WALLET_BACKUP_MANIFEST_PASS_A_RESULT_MAX_BYTES
  )
    throw new Error('backup manifest Pass-A result is invalid')
  const raw = decode(value)
  if (!Array.isArray(raw) || raw.length !== 17 || !equalBytes(value, encodeCanonical(raw)))
    throw new Error('backup manifest Pass-A result is invalid')
  if (raw[0] !== 1 || raw[1] !== 'encrypted-wallet-backup-manifest-pass-a')
    throw new Error('backup manifest Pass-A result is invalid')
  if (!Array.isArray(raw[16])) throw new Error('backup manifest Pass-A result is invalid')
  return requireManifestPassAResult({
    schemaVersion: 1,
    realm: requireRealm(raw[2]),
    vaultId: hexFingerprint(raw[3], 32, 'vault id'),
    snapshotId: requireUtf8Text(raw[4], 128, 'snapshot id'),
    snapshotRevision: integer(raw[5], 'snapshot revision'),
    sealedControlVersion: positive(raw[6], 'sealed control version'),
    sealRunRevision: positive(raw[7], 'seal run revision'),
    sealedControlDigest: hexFingerprint(raw[8], 32, 'sealed control digest'),
    recordSetRoot: hexFingerprint(raw[9], 32, 'record set root'),
    generation: positive(raw[10], 'generation'),
    snapshotNonce: hexFingerprint(raw[11], 16, 'snapshot nonce'),
    recordCount: nonNegative(raw[12], 'record count'),
    canonicalPinBytes: nonNegative(raw[13], 'canonical pin bytes'),
    totalCanonicalManifestEntryBytes: nonNegative(raw[14], 'manifest entry bytes'),
    pageCount: nonNegative(raw[15], 'page count'),
    boundaries: raw[16].map(decodeBoundary),
  })
}

/** Reissue opaque Pass-A boundaries only from the exact sealed snapshot row. */
export function rehydrateEncryptedWalletBackupManifestPassAResult(input: {
  readonly control: EncryptedWalletBackupFrozenSnapshotControl
  readonly current: PersistedEncryptedWalletBackupFrozenSnapshot
  readonly persisted: Uint8Array
}): PersistedEncryptedWalletBackupManifestPassAResult {
  const sealed = requireSealedControl(input.control, input.current)
  const result = decodeEncryptedWalletBackupManifestPassAResult(input.persisted)
  if (
    result.realm !== sealed.realm ||
    result.vaultId !== sealed.vaultId ||
    result.snapshotId !== sealed.snapshotId ||
    result.snapshotRevision !== sealed.snapshotRevision ||
    result.sealedControlVersion !== sealed.version ||
    result.sealRunRevision !== sealed.sealRunRevision ||
    result.sealedControlDigest !==
      bytesToHex(sha256(encodeEncryptedWalletBackupFrozenSnapshot(sealed))) ||
    result.recordSetRoot !== sealed.recordSetRoot ||
    result.generation !== sealed.generation ||
    result.snapshotNonce !== sealed.snapshotNonce ||
    result.recordCount !== sealed.recordCount ||
    result.canonicalPinBytes !== sealed.canonicalPinBytes
  ) {
    throw new Error('backup manifest Pass-A result belongs to a foreign snapshot')
  }
  registerManifestPassABoundaries(result)
  return result
}

class ManifestPassAPlanner {
  #after: Uint8Array | null = null
  #recordCount = 0
  #canonicalPinBytes = 0
  #entryBytes = 0
  #pageEntries = 0
  #pageEntryBytes = 0
  readonly #boundaries: EncryptedWalletBackupManifestPassABoundary[] = []
  readonly #store: EncryptedWalletBackupFrozenSnapshotSealStore
  readonly #control: EncryptedWalletBackupFrozenSnapshotControl
  readonly #sealed: PersistedEncryptedWalletBackupFrozenSnapshot

  constructor(
    store: EncryptedWalletBackupFrozenSnapshotSealStore,
    control: EncryptedWalletBackupFrozenSnapshotControl,
    sealed: PersistedEncryptedWalletBackupFrozenSnapshot,
  ) {
    this.#store = store
    this.#control = control
    this.#sealed = sealed
  }

  async plan(): Promise<PersistedEncryptedWalletBackupManifestPassAResult> {
    while (this.#recordCount < this.#sealed.recordCount) await this.readPage()
    await this.requireExhausted()
    if (this.#pageEntries > 0) this.finishPage()
    requireScanTotals(this.#sealed, this.#recordCount, this.#canonicalPinBytes)
    return resultFromPlan(this.#sealed, this.#entryBytes, this.#boundaries)
  }

  private async readPage(): Promise<void> {
    const page = await readEncryptedWalletBackupSnapshotSealMetadataPage({
      store: this.#store,
      control: this.#control,
      current: this.#sealed,
      exclusiveAfter: this.#after,
    })
    if (page.pins.length === 0) throw new Error('backup manifest Pass-A scan ended early')
    for (const pin of page.pins) this.addPin(pin)
    this.#after = page.nextExclusiveAfter
  }

  private async requireExhausted(): Promise<void> {
    const page = await readEncryptedWalletBackupSnapshotSealMetadataPage({
      store: this.#store,
      control: this.#control,
      current: this.#sealed,
      exclusiveAfter: this.#after,
      maximumPins: 1,
    })
    if (page.pins.length !== 0) throw new Error('backup manifest Pass-A scan contains a later pin')
  }

  private addPin(value: Uint8Array): void {
    const pin = decodeEncryptedWalletBackupSnapshotPin(value)
    requirePinScope(this.#sealed, pin)
    const key = pinKey(pin)
    if (this.#after !== null && compareBytes(key, this.#after) <= 0)
      throw new Error('backup manifest Pass-A pin order is invalid')
    this.#after = key
    this.#recordCount = safeAdd(this.#recordCount, 1)
    this.#canonicalPinBytes = safeAdd(this.#canonicalPinBytes, value.byteLength)
    this.#entryBytes = safeAdd(this.#entryBytes, pin.canonicalManifestEntryBytes)
    if (
      this.#recordCount > this.#sealed.recordCount ||
      this.#canonicalPinBytes > this.#sealed.canonicalPinBytes
    )
      throw new Error('backup manifest Pass-A scan totals are invalid')
    this.addEntry(pin.canonicalManifestEntryBytes)
  }

  private addEntry(entryBytes: number): void {
    const nextEntries = this.#pageEntries + 1
    const nextBytes = safeAdd(this.#pageEntryBytes, entryBytes)
    if (
      nextEntries <= ENCRYPTED_WALLET_BACKUP_SNAPSHOT_SEAL_LEAF_MAX &&
      this.pageFits(nextEntries, nextBytes)
    ) {
      this.#pageEntries = nextEntries
      this.#pageEntryBytes = nextBytes
      return
    }
    if (this.#pageEntries > 0) this.finishPage()
    if (!this.pageFits(1, entryBytes))
      throw new Error('backup manifest entry exceeds page capacity')
    this.#pageEntries = 1
    this.#pageEntryBytes = entryBytes
  }

  private pageFits(entryCount: number, entryBytes: number): boolean {
    return (
      measureEncryptedWalletBackupManifestPageCbor({
        generation: this.#sealed.generation,
        pageIndex: ENCRYPTED_WALLET_BACKUP_SNAPSHOT_SEAL_LEAF_MAX_COUNT - 1,
        pageCount: ENCRYPTED_WALLET_BACKUP_SNAPSHOT_SEAL_LEAF_MAX_COUNT,
        entryCount,
        canonicalEntryBytes: entryBytes,
      }) <= ENCRYPTED_WALLET_BACKUP_MANIFEST_PASS_A_PAGE_MAX_BYTES
    )
  }

  private finishPage(): void {
    if (this.#boundaries.length >= ENCRYPTED_WALLET_BACKUP_SNAPSHOT_SEAL_LEAF_MAX_COUNT)
      throw new Error('backup manifest page count exceeds its capacity')
    this.#boundaries.push(
      Object.freeze({
        entryCount: this.#pageEntries,
        canonicalEntryBytes: this.#pageEntryBytes,
        plannedCanonicalPageBytes: this.pageBytes(this.#pageEntries, this.#pageEntryBytes),
      }),
    )
    this.#pageEntries = 0
    this.#pageEntryBytes = 0
  }

  private pageBytes(entryCount: number, entryBytes: number): number {
    return measureEncryptedWalletBackupManifestPageCbor({
      generation: this.#sealed.generation,
      pageIndex: ENCRYPTED_WALLET_BACKUP_SNAPSHOT_SEAL_LEAF_MAX_COUNT - 1,
      pageCount: ENCRYPTED_WALLET_BACKUP_SNAPSHOT_SEAL_LEAF_MAX_COUNT,
      entryCount,
      canonicalEntryBytes: entryBytes,
    })
  }
}

async function persistManifestPassAResult(
  store: EncryptedWalletBackupManifestPassAResultStore,
  control: EncryptedWalletBackupFrozenSnapshotControl,
  sealed: PersistedEncryptedWalletBackupFrozenSnapshot,
  result: PersistedEncryptedWalletBackupManifestPassAResult,
): Promise<void> {
  if (!store || typeof store.withManifestPassAResultTransaction !== 'function')
    throw new Error('backup manifest Pass-A result store is invalid')
  const scope = encodeEncryptedWalletBackupFrozenSnapshotScope(control)
  const expectedControl = encodeEncryptedWalletBackupFrozenSnapshot(sealed)
  const candidate = encodeEncryptedWalletBackupManifestPassAResult(result)
  const reservedReadBytes = safeAdd(scope.byteLength, safeAdd(expectedControl.byteLength, 65_536))
  await exactResultCallback(
    store,
    Object.freeze({
      scope,
      expectedVersion: sealed.version,
      expectedControl,
      reservedReadRows: 2,
      reservedReadBytes,
      reservedWriteRows: 1,
      reservedWriteBytes: candidate.byteLength,
    }),
    async (transaction) => {
      requireExactControl(transaction.control, expectedControl)
      if (transaction.result === null) return transaction.insertResult(candidate.slice())
      if (!equalBytes(transaction.result, candidate))
        throw new Error('backup manifest Pass-A result conflicts')
    },
  )
}

async function exactResultCallback(
  store: EncryptedWalletBackupManifestPassAResultStore,
  expected: Parameters<
    EncryptedWalletBackupManifestPassAResultStore['withManifestPassAResultTransaction']
  >[0],
  use: (transaction: EncryptedWalletBackupManifestPassAResultTransaction) => Promise<void>,
): Promise<void> {
  const sentinel = Object.freeze({ manifestPassA: true })
  let calls = 0
  let settled = false
  await store
    .withManifestPassAResultTransaction(expected, async (transaction) => {
      if (settled || calls++ !== 0) throw new Error('backup manifest Pass-A callback is invalid')
      await use(transaction)
      return sentinel
    })
    .then((returned) => {
      if (calls !== 1 || returned !== sentinel)
        throw new Error('backup manifest Pass-A callback is invalid')
    })
    .finally(() => {
      settled = true
    })
}

function resultFromPlan(
  sealed: PersistedEncryptedWalletBackupFrozenSnapshot,
  entryBytes: number,
  boundaries: readonly EncryptedWalletBackupManifestPassABoundary[],
): PersistedEncryptedWalletBackupManifestPassAResult {
  return requireManifestPassAResult({
    schemaVersion: 1,
    realm: sealed.realm,
    vaultId: sealed.vaultId,
    snapshotId: sealed.snapshotId,
    snapshotRevision: sealed.snapshotRevision,
    sealedControlVersion: sealed.version,
    sealRunRevision: sealed.sealRunRevision,
    sealedControlDigest: bytesToHex(sha256(encodeEncryptedWalletBackupFrozenSnapshot(sealed))),
    recordSetRoot: sealed.recordSetRoot!,
    generation: sealed.generation,
    snapshotNonce: sealed.snapshotNonce,
    recordCount: sealed.recordCount,
    canonicalPinBytes: sealed.canonicalPinBytes,
    totalCanonicalManifestEntryBytes: entryBytes,
    pageCount: boundaries.length,
    boundaries: Object.freeze(boundaries.map((boundary) => Object.freeze({ ...boundary }))),
  })
}

function requireSealedControl(
  control: EncryptedWalletBackupFrozenSnapshotControl,
  current: PersistedEncryptedWalletBackupFrozenSnapshot,
): PersistedEncryptedWalletBackupFrozenSnapshot {
  const sealed = requireAuthenticatedEncryptedWalletBackupFrozenSnapshot(control, current)
  if (sealed.state !== 'sealed' || sealed.recordSetRoot === null)
    throw new Error('backup snapshot is not sealed')
  return sealed
}

function requireManifestPassAResult(
  value: unknown,
): PersistedEncryptedWalletBackupManifestPassAResult {
  const result = strictObject(value, resultFields, 'backup manifest Pass-A result')
  if (result.schemaVersion !== 1) throw new Error('backup manifest Pass-A result is invalid')
  const boundaries = decodeBoundaries(result.boundaries)
  const recordCount = nonNegative(result.recordCount, 'record count')
  const pageCount = nonNegative(result.pageCount, 'page count')
  if (
    pageCount !== boundaries.length ||
    pageCount > ENCRYPTED_WALLET_BACKUP_SNAPSHOT_SEAL_LEAF_MAX_COUNT ||
    recordCount > ENCRYPTED_WALLET_BACKUP_SNAPSHOT_RECORD_MAX
  )
    throw new Error('backup manifest Pass-A result is invalid')
  requireBoundaryEquations(
    result.generation,
    recordCount,
    boundaries,
    result.totalCanonicalManifestEntryBytes,
  )
  return Object.freeze({
    schemaVersion: 1,
    realm: requireRealm(result.realm),
    vaultId: hexText(result.vaultId, 32, 'vault id'),
    snapshotId: requireUtf8Text(result.snapshotId, 128, 'snapshot id'),
    snapshotRevision: integer(result.snapshotRevision, 'snapshot revision'),
    sealedControlVersion: positive(result.sealedControlVersion, 'sealed control version'),
    sealRunRevision: positive(result.sealRunRevision, 'seal run revision'),
    sealedControlDigest: hexText(result.sealedControlDigest, 32, 'sealed control digest'),
    recordSetRoot: hexText(result.recordSetRoot, 32, 'record set root'),
    generation: positive(result.generation, 'generation'),
    snapshotNonce: hexText(result.snapshotNonce, 16, 'snapshot nonce'),
    recordCount,
    canonicalPinBytes: nonNegative(result.canonicalPinBytes, 'canonical pin bytes'),
    totalCanonicalManifestEntryBytes: nonNegative(
      result.totalCanonicalManifestEntryBytes,
      'manifest entry bytes',
    ),
    pageCount,
    boundaries,
  })
}

function decodeBoundaries(value: unknown): readonly EncryptedWalletBackupManifestPassABoundary[] {
  if (!Array.isArray(value)) throw new Error('backup manifest Pass-A result is invalid')
  return Object.freeze(value.map((boundary) => requireBoundary(boundary)))
}

function decodeBoundary(value: unknown): EncryptedWalletBackupManifestPassABoundary {
  if (!Array.isArray(value) || value.length !== 3)
    throw new Error('backup manifest Pass-A result is invalid')
  return requireBoundary({
    entryCount: value[0],
    canonicalEntryBytes: value[1],
    plannedCanonicalPageBytes: value[2],
  })
}

function requireBoundary(value: unknown): EncryptedWalletBackupManifestPassABoundary {
  const boundary = strictObject(value, boundaryFields, 'backup manifest Pass-A boundary')
  const entryCount = positive(boundary.entryCount, 'entry count')
  const canonicalEntryBytes = positive(boundary.canonicalEntryBytes, 'entry bytes')
  const plannedCanonicalPageBytes = positive(boundary.plannedCanonicalPageBytes, 'page bytes')
  if (
    entryCount > ENCRYPTED_WALLET_BACKUP_SNAPSHOT_SEAL_LEAF_MAX ||
    plannedCanonicalPageBytes > ENCRYPTED_WALLET_BACKUP_MANIFEST_PASS_A_PAGE_MAX_BYTES
  )
    throw new Error('backup manifest Pass-A boundary is invalid')
  return Object.freeze({ entryCount, canonicalEntryBytes, plannedCanonicalPageBytes })
}

function requireBoundaryEquations(
  generation: unknown,
  recordCount: number,
  boundaries: readonly EncryptedWalletBackupManifestPassABoundary[],
  totalEntryBytes: unknown,
): void {
  let entries = 0
  let bytes = 0
  for (const boundary of boundaries) {
    entries = safeAdd(entries, boundary.entryCount)
    bytes = safeAdd(bytes, boundary.canonicalEntryBytes)
    const planned = measureEncryptedWalletBackupManifestPageCbor({
      generation: positive(generation, 'generation'),
      pageIndex: ENCRYPTED_WALLET_BACKUP_SNAPSHOT_SEAL_LEAF_MAX_COUNT - 1,
      pageCount: ENCRYPTED_WALLET_BACKUP_SNAPSHOT_SEAL_LEAF_MAX_COUNT,
      entryCount: boundary.entryCount,
      canonicalEntryBytes: boundary.canonicalEntryBytes,
    })
    if (planned !== boundary.plannedCanonicalPageBytes)
      throw new Error('backup manifest Pass-A boundary is invalid')
  }
  if (entries !== recordCount || bytes !== nonNegative(totalEntryBytes, 'manifest entry bytes'))
    throw new Error('backup manifest Pass-A result is invalid')
  if ((recordCount === 0) !== (boundaries.length === 0))
    throw new Error('backup manifest Pass-A result is invalid')
}

function requirePageSizeInput(value: unknown): {
  generation: number
  pageIndex: number
  pageCount: number
  entryCount: number
  canonicalEntryBytes: number
} {
  const input = strictObject(value, pageSizeFields, 'backup manifest page size')
  return {
    generation: positive(input.generation, 'generation'),
    pageIndex: nonNegative(input.pageIndex, 'page index'),
    pageCount: positive(input.pageCount, 'page count'),
    entryCount: positive(input.entryCount, 'entry count'),
    canonicalEntryBytes: nonNegative(input.canonicalEntryBytes, 'entry bytes'),
  }
}

function requirePinScope(
  control: PersistedEncryptedWalletBackupFrozenSnapshot,
  pin: ReturnType<typeof decodeEncryptedWalletBackupSnapshotPin>,
): void {
  if (
    pin.realm !== control.realm ||
    pin.vaultId !== control.vaultId ||
    pin.snapshotId !== control.snapshotId ||
    pin.snapshotRevision !== control.snapshotRevision
  )
    throw new Error('backup manifest Pass-A pin belongs to a foreign scope')
}

function requireScanTotals(
  control: PersistedEncryptedWalletBackupFrozenSnapshot,
  recordCount: number,
  canonicalPinBytes: number,
): void {
  if (recordCount !== control.recordCount || canonicalPinBytes !== control.canonicalPinBytes)
    throw new Error('backup manifest Pass-A scan totals are invalid')
}

function pinKey(pin: ReturnType<typeof decodeEncryptedWalletBackupSnapshotPin>): Uint8Array {
  return encodeCanonical([pin.recordKindCode, hexBytes(pin.recordId), hexBytes(pin.commitment)])
}

function canonicalArrayHeaderBytes(length: number): number {
  if (!Number.isSafeInteger(length) || length < 0)
    throw new Error('canonical array length is invalid')
  if (length < 24) return 1
  if (length <= 0xff) return 2
  if (length <= 0xffff) return 3
  if (length <= 0xffffffff) return 5
  return 9
}

function strictObject(
  value: unknown,
  fields: readonly string[],
  name: string,
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))
  )
    throw new Error(`${name} is invalid`)
  return value as Record<string, unknown>
}

function hexFingerprint(value: unknown, length: number, name: string): string {
  if (!(value instanceof Uint8Array) || value.byteLength !== length)
    throw new Error(`backup manifest Pass-A ${name} is invalid`)
  return bytesToHex(value)
}

function hexText(value: unknown, length: number, name: string): string {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${length * 2}}$`).test(value))
    throw new Error(`backup manifest Pass-A ${name} is invalid`)
  return value
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g)!, (part) => Number.parseInt(part, 16))
}

function positive(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new Error(`backup manifest Pass-A ${name} is invalid`)
  return value as number
}

function nonNegative(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`backup manifest Pass-A ${name} is invalid`)
  return value as number
}

function integer(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`backup manifest Pass-A ${name} is invalid`)
  return value as number
}

function safeAdd(...values: readonly number[]): number {
  let total = 0
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || total > Number.MAX_SAFE_INTEGER - value)
      throw new Error('backup manifest Pass-A count is invalid')
    total += value
  }
  return total
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const count = Math.min(left.byteLength, right.byteLength)
  for (let index = 0; index < count; index += 1) {
    const delta = left[index]! - right[index]!
    if (delta !== 0) return delta
  }
  return left.byteLength - right.byteLength
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  )
}

function requireExactControl(actual: Uint8Array | null, expected: Uint8Array): void {
  if (actual === null || !equalBytes(actual, expected))
    throw new Error('backup manifest Pass-A control changed')
}

const resultFields = [
  'schemaVersion',
  'realm',
  'vaultId',
  'snapshotId',
  'snapshotRevision',
  'sealedControlVersion',
  'sealRunRevision',
  'sealedControlDigest',
  'recordSetRoot',
  'generation',
  'snapshotNonce',
  'recordCount',
  'canonicalPinBytes',
  'totalCanonicalManifestEntryBytes',
  'pageCount',
  'boundaries',
] as const
const boundaryFields = ['entryCount', 'canonicalEntryBytes', 'plannedCanonicalPageBytes'] as const
const pageSizeFields = [
  'generation',
  'pageIndex',
  'pageCount',
  'entryCount',
  'canonicalEntryBytes',
] as const

const maximumResultRows = 3
if (maximumResultRows > ENCRYPTED_WALLET_BACKUP_SNAPSHOT_TRANSACTION_ROW_MAX)
  throw new Error('backup manifest Pass-A transaction row capacity is invalid')
if (
  ENCRYPTED_WALLET_BACKUP_MANIFEST_PASS_A_RESULT_MAX_BYTES >=
  ENCRYPTED_WALLET_BACKUP_SNAPSHOT_TRANSACTION_MAX_BYTES
)
  throw new Error('backup manifest Pass-A transaction byte capacity is invalid')
