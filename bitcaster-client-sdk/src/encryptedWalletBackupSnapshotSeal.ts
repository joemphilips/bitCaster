import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { encodeCanonicalBackupCbor as encodeCanonical } from './encryptedWalletBackupCbor.ts'
import {
  decodeEncryptedWalletBackupSnapshotPin,
  encodeEncryptedWalletBackupFrozenSnapshot,
  encodeEncryptedWalletBackupFrozenSnapshotScope,
  requireAuthenticatedEncryptedWalletBackupFrozenSnapshot,
  ENCRYPTED_WALLET_BACKUP_SNAPSHOT_RECORD_MAX,
  ENCRYPTED_WALLET_BACKUP_SNAPSHOT_TRANSACTION_MAX_BYTES,
  ENCRYPTED_WALLET_BACKUP_SNAPSHOT_TRANSACTION_ROW_MAX,
  type PersistedEncryptedWalletBackupFrozenSnapshot,
  type PersistedEncryptedWalletBackupSnapshotPin,
} from './encryptedWalletBackupSnapshotPersistence.ts'
import type { EncryptedWalletBackupFrozenSnapshotControl } from './encryptedWalletBackupSnapshotAuthority.ts'

export const ENCRYPTED_WALLET_BACKUP_SNAPSHOT_SEAL_PAGE_MAX = 255 as const
export const ENCRYPTED_WALLET_BACKUP_SNAPSHOT_SEAL_LEAF_MAX = 512 as const
export const ENCRYPTED_WALLET_BACKUP_SNAPSHOT_SEAL_LEAF_MAX_COUNT = 1_024 as const
export const ENCRYPTED_WALLET_BACKUP_SNAPSHOT_SEAL_ROOT_METADATA_MAX_BYTES = 65_536 as const

export interface EncryptedWalletBackupFrozenSnapshotSealTransaction {
  readonly control: Uint8Array | null
  readonly pins: readonly Uint8Array[]
}

export interface EncryptedWalletBackupFrozenSnapshotSealStore {
  /**
   * Compare `expectedControl` and `expectedVersion` in one transaction.
   * Read pins after `exclusiveAfter` in bytewise order.
   * Reserve the scan capacity before application buffers are exposed.
   * Debit only returned pin rows and bytes. D1a write reservations stay exact.
   * Write `nextControl` only when the callback completes successfully.
   */
  withSnapshotSealTransaction<T>(
    expected: Readonly<{
      readonly scope: Uint8Array
      readonly expectedVersion: number
      readonly expectedControl: Uint8Array
      readonly nextControl: Uint8Array | null
      readonly exclusiveAfter: Uint8Array | null
      readonly reservedPinRows: number
      readonly reservedPinBytes: number
    }>,
    use: (transaction: EncryptedWalletBackupFrozenSnapshotSealTransaction) => Promise<T>,
  ): Promise<unknown>
}

export interface EncryptedWalletBackupSnapshotSealLeafMetadata {
  readonly entryCount: number
  readonly canonicalBindingBytes: number
  readonly leafDigest: string
}

export async function sealEncryptedWalletBackupFrozenSnapshot(input: {
  readonly store: EncryptedWalletBackupFrozenSnapshotSealStore
  readonly control: EncryptedWalletBackupFrozenSnapshotControl
  readonly current: PersistedEncryptedWalletBackupFrozenSnapshot
}): Promise<PersistedEncryptedWalletBackupFrozenSnapshot> {
  const sealing = await startEncryptedWalletBackupFrozenSnapshotSeal(input)
  return scanAndSeal(input.store, input.control, sealing)
}

export async function startEncryptedWalletBackupFrozenSnapshotSeal(input: {
  readonly store: EncryptedWalletBackupFrozenSnapshotSealStore
  readonly control: EncryptedWalletBackupFrozenSnapshotControl
  readonly current: PersistedEncryptedWalletBackupFrozenSnapshot
}): Promise<PersistedEncryptedWalletBackupFrozenSnapshot> {
  const current = requireAuthenticatedEncryptedWalletBackupFrozenSnapshot(
    input.control,
    input.current,
  )
  if (current.state === 'sealed') throw new Error('backup snapshot is already sealed')
  const next = sealingControl(current)
  await sealTransaction(input.store, input.control, current, next, null, 0, () => undefined)
  return next
}

async function scanAndSeal(
  store: EncryptedWalletBackupFrozenSnapshotSealStore,
  control: EncryptedWalletBackupFrozenSnapshotControl,
  sealing: PersistedEncryptedWalletBackupFrozenSnapshot,
): Promise<PersistedEncryptedWalletBackupFrozenSnapshot> {
  const scanner = new SnapshotSealScanner(store, control, sealing)
  await scanner.scan()
  return scanner.finish()
}

class SnapshotSealScanner {
  readonly #store: EncryptedWalletBackupFrozenSnapshotSealStore
  readonly #control: EncryptedWalletBackupFrozenSnapshotControl
  readonly #sealing: PersistedEncryptedWalletBackupFrozenSnapshot
  readonly #leaves: EncryptedWalletBackupSnapshotSealLeafMetadata[] = []
  #after: Uint8Array | null = null
  #recordCount = 0
  #canonicalPinBytes = 0
  #bindings: Uint8Array[] = []

  constructor(
    store: EncryptedWalletBackupFrozenSnapshotSealStore,
    control: EncryptedWalletBackupFrozenSnapshotControl,
    sealing: PersistedEncryptedWalletBackupFrozenSnapshot,
  ) {
    this.#store = store
    this.#control = control
    this.#sealing = sealing
  }

  async scan(): Promise<void> {
    while (!this.reachedFrozenBoundary()) {
      const pins = await readSealPage(this.#store, this.#control, this.#sealing, this.#after)
      if (pins.length === 0) return
      this.addPins(pins)
    }
  }

  private reachedFrozenBoundary(): boolean {
    return (
      this.#recordCount === this.#sealing.recordCount ||
      this.#canonicalPinBytes === this.#sealing.canonicalPinBytes
    )
  }

  finish(): Promise<PersistedEncryptedWalletBackupFrozenSnapshot> {
    if (this.#bindings.length > 0) this.addLeaf()
    requireScanTotals(this.#sealing, this.#recordCount, this.#canonicalPinBytes)
    const root = recordSetRoot(this.#sealing, this.#leaves)
    const sealed = Object.freeze({
      ...this.#sealing,
      state: 'sealed' as const,
      recordSetRoot: root,
      version: nextVersion(this.#sealing.version),
    })
    return sealTransaction(
      this.#store,
      this.#control,
      this.#sealing,
      sealed,
      this.#after,
      1,
      (pins) => {
        if (pins.length !== 0) throw new Error('backup snapshot contains a later pin')
        return sealed
      },
    )
  }

  private addPins(pins: readonly Uint8Array[]): void {
    for (const pin of pins) {
      const decoded = decodePinInScope(this.#sealing, pin)
      const key = pinKey(decoded)
      if (this.#after !== null && compareBytes(key, this.#after) <= 0)
        throw new Error('backup snapshot pin order is invalid')
      const recordCount = this.#recordCount + 1
      const canonicalPinBytes = safeAdd(this.#canonicalPinBytes, pin.byteLength)
      if (
        recordCount > this.#sealing.recordCount ||
        canonicalPinBytes > this.#sealing.canonicalPinBytes
      )
        throw new Error('backup snapshot seal totals are invalid')
      this.#after = key
      this.#recordCount = recordCount
      this.#canonicalPinBytes = canonicalPinBytes
      this.#bindings.push(bindingBytes(decoded))
      if (this.#bindings.length === ENCRYPTED_WALLET_BACKUP_SNAPSHOT_SEAL_LEAF_MAX) this.addLeaf()
    }
  }

  private addLeaf(): void {
    if (this.#leaves.length >= ENCRYPTED_WALLET_BACKUP_SNAPSHOT_SEAL_LEAF_MAX_COUNT)
      throw new Error('backup snapshot leaf count exceeds its capacity')
    this.#leaves.push(leafMetadata(this.#leaves.length, this.#bindings))
    this.#bindings = []
  }
}

async function readSealPage(
  store: EncryptedWalletBackupFrozenSnapshotSealStore,
  control: EncryptedWalletBackupFrozenSnapshotControl,
  sealing: PersistedEncryptedWalletBackupFrozenSnapshot,
  after: Uint8Array | null,
): Promise<readonly Uint8Array[]> {
  return sealTransaction(
    store,
    control,
    sealing,
    null,
    after,
    ENCRYPTED_WALLET_BACKUP_SNAPSHOT_SEAL_PAGE_MAX,
    (pins) => {
      requirePageOrder(sealing, after, pins)
      return pins.map((pin) => pin.slice())
    },
  )
}

function requirePageOrder(
  control: PersistedEncryptedWalletBackupFrozenSnapshot,
  after: Uint8Array | null,
  pins: readonly Uint8Array[],
): void {
  if (pins.length > ENCRYPTED_WALLET_BACKUP_SNAPSHOT_SEAL_PAGE_MAX)
    throw new Error('backup snapshot seal page exceeds its capacity')
  let previous = after
  for (const pin of pins) {
    const key = pinKey(decodePinInScope(control, pin))
    if (previous !== null && compareBytes(key, previous) <= 0)
      throw new Error('backup snapshot pin order is invalid')
    previous = key
  }
}

function sealTransaction<T>(
  store: EncryptedWalletBackupFrozenSnapshotSealStore,
  control: EncryptedWalletBackupFrozenSnapshotControl,
  current: PersistedEncryptedWalletBackupFrozenSnapshot,
  next: PersistedEncryptedWalletBackupFrozenSnapshot | null,
  after: Uint8Array | null,
  pinRows: number,
  use: (pins: readonly Uint8Array[]) => T,
): Promise<T> {
  if (!store || typeof store.withSnapshotSealTransaction !== 'function')
    throw new Error('backup snapshot seal store is invalid')
  if (pinRows < 0 || pinRows > ENCRYPTED_WALLET_BACKUP_SNAPSHOT_SEAL_PAGE_MAX)
    throw new Error('backup snapshot seal page exceeds its capacity')
  const scope = encodeEncryptedWalletBackupFrozenSnapshotScope(control)
  const expectedControl = encodeEncryptedWalletBackupFrozenSnapshot(current)
  const nextControl = next === null ? null : encodeEncryptedWalletBackupFrozenSnapshot(next)
  const exactAfter = after?.slice() ?? null
  const pinBytes = sealPinByteCapacity(scope, expectedControl, nextControl, exactAfter)
  return exactSealCallback(
    store,
    Object.freeze({
      scope,
      expectedVersion: current.version,
      expectedControl,
      nextControl,
      exclusiveAfter: exactAfter,
      reservedPinRows: pinRows,
      reservedPinBytes: pinRows === 0 ? 0 : pinBytes,
    }),
    (transaction) => {
      requireExactControl(transaction.control, expectedControl)
      requireReservedPins(transaction.pins, pinRows, pinRows === 0 ? 0 : pinBytes)
      return use(transaction.pins)
    },
  )
}

function exactSealCallback<T>(
  store: EncryptedWalletBackupFrozenSnapshotSealStore,
  expected: Parameters<
    EncryptedWalletBackupFrozenSnapshotSealStore['withSnapshotSealTransaction']
  >[0],
  use: (transaction: EncryptedWalletBackupFrozenSnapshotSealTransaction) => T,
): Promise<T> {
  const sentinel = Object.freeze({ seal: true })
  let calls = 0
  let settled = false
  let result: T | undefined
  return store
    .withSnapshotSealTransaction(expected, async (transaction) => {
      if (settled || calls++ !== 0) throw new Error('backup snapshot seal callback is invalid')
      result = use(transaction)
      return sentinel
    })
    .then((returned) => {
      if (calls !== 1 || returned !== sentinel)
        throw new Error('backup snapshot seal callback is invalid')
      return result as T
    })
    .finally(() => {
      settled = true
    })
}

function sealingControl(
  current: PersistedEncryptedWalletBackupFrozenSnapshot,
): PersistedEncryptedWalletBackupFrozenSnapshot {
  const sealRunRevision = nextVersion(current.sealRunRevision)
  return Object.freeze({
    ...current,
    state: 'sealing' as const,
    sealRunRevision,
    recordSetRoot: null,
    version: nextVersion(current.version),
  })
}

function decodePinInScope(
  control: PersistedEncryptedWalletBackupFrozenSnapshot,
  value: Uint8Array,
): PersistedEncryptedWalletBackupSnapshotPin {
  const pin = decodeEncryptedWalletBackupSnapshotPin(value)
  if (
    pin.realm !== control.realm ||
    pin.vaultId !== control.vaultId ||
    pin.snapshotId !== control.snapshotId ||
    pin.snapshotRevision !== control.snapshotRevision
  )
    throw new Error('backup snapshot pin belongs to a foreign scope')
  return pin
}

function bindingBytes(pin: PersistedEncryptedWalletBackupSnapshotPin): Uint8Array {
  return encodeCanonical([
    1,
    'encrypted-wallet-backup-snapshot-binding',
    pin.recordKindCode,
    hexBytes(pin.recordId),
    hexBytes(pin.commitment),
    hexBytes(pin.sourceBodyReference),
    pin.sourceRevision,
    pin.canonicalManifestEntryBytes,
  ])
}

function leafMetadata(
  index: number,
  bindings: readonly Uint8Array[],
): EncryptedWalletBackupSnapshotSealLeafMetadata {
  const canonicalBindingBytes = sum(bindings)
  const leafDigest = digest(
    encodeCanonical([1, 'encrypted-wallet-backup-snapshot-leaf', index, bindings.length, bindings]),
  )
  return Object.freeze({ entryCount: bindings.length, canonicalBindingBytes, leafDigest })
}

function recordSetRoot(
  control: PersistedEncryptedWalletBackupFrozenSnapshot,
  leaves: readonly EncryptedWalletBackupSnapshotSealLeafMetadata[],
): string {
  return digest(
    encodeEncryptedWalletBackupSnapshotRecordSetRootMetadata({
      recordCount: control.recordCount,
      canonicalPinBytes: control.canonicalPinBytes,
      leaves,
    }),
  )
}

export function encodeEncryptedWalletBackupSnapshotRecordSetRootMetadata(input: {
  readonly recordCount: number
  readonly canonicalPinBytes: number
  readonly leaves: readonly EncryptedWalletBackupSnapshotSealLeafMetadata[]
}): Uint8Array {
  const exact = requireRootMetadataInput(input)
  if (
    !Number.isSafeInteger(exact.recordCount) ||
    exact.recordCount < 0 ||
    exact.recordCount > ENCRYPTED_WALLET_BACKUP_SNAPSHOT_RECORD_MAX
  )
    throw new Error('backup snapshot record count is invalid')
  if (!Number.isSafeInteger(exact.canonicalPinBytes) || exact.canonicalPinBytes < 0)
    throw new Error('backup snapshot pin bytes are invalid')
  requireLeafPartition(exact.recordCount, exact.leaves)
  const metadata = exact.leaves.map(encodeLeafMetadata)
  const root = encodeCanonical([
    1,
    'encrypted-wallet-backup-snapshot-record-set-root',
    exact.recordCount,
    exact.canonicalPinBytes,
    metadata,
  ])
  if (root.byteLength > ENCRYPTED_WALLET_BACKUP_SNAPSHOT_SEAL_ROOT_METADATA_MAX_BYTES)
    throw new Error('backup snapshot root metadata exceeds its capacity')
  return root
}

function requireRootMetadataInput(value: unknown): Readonly<{
  recordCount: number
  canonicalPinBytes: number
  leaves: readonly EncryptedWalletBackupSnapshotSealLeafMetadata[]
}> {
  const input = strictObject(
    value,
    ['recordCount', 'canonicalPinBytes', 'leaves'],
    'backup snapshot root metadata',
  )
  if (!Array.isArray(input.leaves)) throw new Error('backup snapshot root metadata is invalid')
  return {
    recordCount: input.recordCount as number,
    canonicalPinBytes: input.canonicalPinBytes as number,
    leaves: input.leaves as readonly EncryptedWalletBackupSnapshotSealLeafMetadata[],
  }
}

function requireLeafPartition(
  recordCount: number,
  leaves: readonly EncryptedWalletBackupSnapshotSealLeafMetadata[],
): void {
  const expectedLeaves = Math.ceil(recordCount / ENCRYPTED_WALLET_BACKUP_SNAPSHOT_SEAL_LEAF_MAX)
  if (
    !Array.isArray(leaves) ||
    leaves.length !== expectedLeaves ||
    leaves.length > ENCRYPTED_WALLET_BACKUP_SNAPSHOT_SEAL_LEAF_MAX_COUNT
  )
    throw new Error('backup snapshot leaf count exceeds its capacity')
  for (let index = 0; index < leaves.length; index += 1) {
    const expectedEntries = Math.min(
      ENCRYPTED_WALLET_BACKUP_SNAPSHOT_SEAL_LEAF_MAX,
      recordCount - index * ENCRYPTED_WALLET_BACKUP_SNAPSHOT_SEAL_LEAF_MAX,
    )
    if (leaves[index]?.entryCount !== expectedEntries)
      throw new Error('backup snapshot leaf partition is invalid')
  }
}

function encodeLeafMetadata(
  leaf: EncryptedWalletBackupSnapshotSealLeafMetadata,
): readonly unknown[] {
  const exact = strictObject(
    leaf,
    ['entryCount', 'canonicalBindingBytes', 'leafDigest'],
    'backup snapshot leaf metadata',
  )
  if (
    !Number.isSafeInteger(exact.entryCount) ||
    (exact.entryCount as number) < 1 ||
    (exact.entryCount as number) > ENCRYPTED_WALLET_BACKUP_SNAPSHOT_SEAL_LEAF_MAX ||
    !Number.isSafeInteger(exact.canonicalBindingBytes) ||
    (exact.canonicalBindingBytes as number) < 1 ||
    typeof exact.leafDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(exact.leafDigest)
  )
    throw new Error('backup snapshot leaf metadata is invalid')
  return [exact.entryCount, exact.canonicalBindingBytes, hexBytes(exact.leafDigest)]
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

function requireScanTotals(
  control: PersistedEncryptedWalletBackupFrozenSnapshot,
  recordCount: number,
  canonicalPinBytes: number,
): void {
  if (
    recordCount !== control.recordCount ||
    canonicalPinBytes !== control.canonicalPinBytes ||
    recordCount > ENCRYPTED_WALLET_BACKUP_SNAPSHOT_RECORD_MAX
  )
    throw new Error('backup snapshot seal totals are invalid')
}

function requireReservedPins(
  pins: readonly Uint8Array[],
  rowLimit: number,
  byteLimit: number,
): void {
  if (pins.length > rowLimit || sum(pins) > byteLimit)
    throw new Error('backup snapshot seal reservation is invalid')
}

function sealPinByteCapacity(
  scope: Uint8Array,
  expectedControl: Uint8Array,
  nextControl: Uint8Array | null,
  exclusiveAfter: Uint8Array | null,
): number {
  const used =
    scope.byteLength +
    expectedControl.byteLength +
    (nextControl?.byteLength ?? 0) +
    (exclusiveAfter?.byteLength ?? 0)
  if (used >= ENCRYPTED_WALLET_BACKUP_SNAPSHOT_TRANSACTION_MAX_BYTES)
    throw new Error('backup snapshot seal transaction exceeds the aggregate byte limit')
  return ENCRYPTED_WALLET_BACKUP_SNAPSHOT_TRANSACTION_MAX_BYTES - used
}

function pinKey(pin: PersistedEncryptedWalletBackupSnapshotPin): Uint8Array {
  return encodeCanonical([pin.recordKindCode, hexBytes(pin.recordId), hexBytes(pin.commitment)])
}

function digest(value: Uint8Array): string {
  return bytesToHex(sha256(value))
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g)!, (part) => Number.parseInt(part, 16))
}

function sum(values: readonly Uint8Array[]): number {
  let total = 0
  for (const value of values) total = safeAdd(total, value.byteLength)
  return total
}

function safeAdd(left: number, right: number): number {
  if (
    !Number.isSafeInteger(left) ||
    !Number.isSafeInteger(right) ||
    left > Number.MAX_SAFE_INTEGER - right
  )
    throw new Error('backup snapshot byte count is invalid')
  return left + right
}

function nextVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER)
    throw new Error('backup snapshot version is invalid')
  return value + 1
}

function requireExactControl(actual: Uint8Array | null, expected: Uint8Array): void {
  if (actual === null || !equalBytes(actual, expected))
    throw new Error('backup snapshot control changed')
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

const maximumScanRows = ENCRYPTED_WALLET_BACKUP_SNAPSHOT_SEAL_PAGE_MAX + 1
if (maximumScanRows > ENCRYPTED_WALLET_BACKUP_SNAPSHOT_TRANSACTION_ROW_MAX)
  throw new Error('backup snapshot scan row capacity is invalid')
