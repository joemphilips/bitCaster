import { bytesToHex } from '@noble/hashes/utils.js'
import { decode } from 'cborg'
import { encodeCanonicalBackupCbor } from './encryptedWalletBackupCbor.ts'
import {
  requireBoundedInteger,
  requireLowerHex,
  requireRealm,
} from './encryptedWalletBackupServerValidation.ts'

export const ENCRYPTED_WALLET_BACKUP_UPLOAD_CURSOR_MAX_BYTES = 1_024 as const

const UPLOAD_PAGE_INDEX_MAX = 1_024
const UPLOAD_BATCH_ORDINAL_MAX = 64
const UPLOAD_CURSOR_VERSION_MAX = 65

export type EncryptedWalletBackupUploadPlanningPhase = 'pages' | 'chunks' | 'complete'

type EncryptedWalletBackupUploadCursorBase = Readonly<{
  readonly schemaVersion: 1
  readonly realm: string
  readonly vaultId: string
  readonly targetManifestDigest: string
  readonly attemptId: string
  readonly nextPageIndex: number
  readonly nextBatchOrdinal: number
  readonly version: number
}>

export type PersistedEncryptedWalletBackupUploadCursor =
  | (EncryptedWalletBackupUploadCursorBase &
      Readonly<{ readonly phase: 'pages'; readonly exclusiveChunkObjectId: null }>)
  | (EncryptedWalletBackupUploadCursorBase &
      Readonly<{
        readonly phase: Exclude<EncryptedWalletBackupUploadPlanningPhase, 'pages'>
        readonly exclusiveChunkObjectId: string | null
      }>)

export function encodeEncryptedWalletBackupUploadCursor(
  value: PersistedEncryptedWalletBackupUploadCursor,
): Uint8Array {
  const cursor = requireCursor(value)
  const encoded = encodeCanonicalBackupCbor([
    1,
    'encrypted-wallet-backup-upload-cursor',
    cursor.realm,
    hexBytes(cursor.vaultId),
    hexBytes(cursor.targetManifestDigest),
    hexBytes(cursor.attemptId),
    cursor.phase,
    cursor.nextPageIndex,
    cursor.exclusiveChunkObjectId === null ? null : hexBytes(cursor.exclusiveChunkObjectId),
    cursor.nextBatchOrdinal,
    cursor.version,
  ])
  if (encoded.byteLength > ENCRYPTED_WALLET_BACKUP_UPLOAD_CURSOR_MAX_BYTES) invalid('upload cursor')
  return encoded
}

export function decodeEncryptedWalletBackupUploadCursor(
  value: Uint8Array,
): PersistedEncryptedWalletBackupUploadCursor {
  const raw = decodeCanonicalArray(value)
  if (raw[0] !== 1 || raw[1] !== 'encrypted-wallet-backup-upload-cursor') invalid('upload cursor')
  return requireCursor({
    schemaVersion: 1,
    realm: raw[2],
    vaultId: hex(raw[3], 32),
    targetManifestDigest: hex(raw[4], 32),
    attemptId: hex(raw[5], 16),
    phase: raw[6],
    nextPageIndex: raw[7],
    exclusiveChunkObjectId: raw[8] === null ? null : hex(raw[8], 16),
    nextBatchOrdinal: raw[9],
    version: raw[10],
  })
}

function requireCursor(value: unknown): PersistedEncryptedWalletBackupUploadCursor {
  try {
    const cursor = strictObject(value)
    if (cursor.schemaVersion !== 1) invalid('upload cursor')
    const currentPhase = phase(cursor.phase)
    const exclusiveChunkObjectId = optionalChunkObjectId(cursor.exclusiveChunkObjectId)
    if (currentPhase === 'pages' && exclusiveChunkObjectId !== null) invalid('upload cursor')
    const base: EncryptedWalletBackupUploadCursorBase = {
      schemaVersion: 1,
      realm: requireRealm(cursor.realm),
      vaultId: requireLowerHex(cursor.vaultId, 32, 'upload vault id'),
      targetManifestDigest: requireLowerHex(
        cursor.targetManifestDigest,
        32,
        'upload target manifest digest',
      ),
      attemptId: requireLowerHex(cursor.attemptId, 16, 'upload attempt id'),
      nextPageIndex: bounded(cursor.nextPageIndex, UPLOAD_PAGE_INDEX_MAX),
      nextBatchOrdinal: bounded(cursor.nextBatchOrdinal, UPLOAD_BATCH_ORDINAL_MAX),
      version: positive(cursor.version, UPLOAD_CURSOR_VERSION_MAX),
    }
    return currentPhase === 'pages'
      ? Object.freeze({ ...base, phase: 'pages' as const, exclusiveChunkObjectId: null })
      : Object.freeze({ ...base, phase: currentPhase, exclusiveChunkObjectId })
  } catch {
    invalid('upload cursor')
  }
}

function decodeCanonicalArray(value: Uint8Array): readonly unknown[] {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < 1 ||
    value.byteLength > ENCRYPTED_WALLET_BACKUP_UPLOAD_CURSOR_MAX_BYTES
  ) {
    invalid('upload cursor')
  }
  let raw: unknown
  try {
    raw = decode(value)
  } catch {
    invalid('upload cursor')
  }
  if (
    !Array.isArray(raw) ||
    raw.length !== 11 ||
    !equalBytes(value, encodeCanonicalBackupCbor(raw))
  )
    invalid('upload cursor')
  return raw
}

function strictObject(value: unknown): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== cursorFields.length
  ) {
    invalid('upload cursor')
  }
  const cursor = value as Record<string, unknown>
  if (cursorFields.some((field) => !Object.hasOwn(cursor, field))) invalid('upload cursor')
  return cursor
}

function phase(value: unknown): EncryptedWalletBackupUploadPlanningPhase {
  if (value === 'pages' || value === 'chunks' || value === 'complete') return value
  invalid('upload cursor')
}

function optionalChunkObjectId(value: unknown): string | null {
  return value === null ? null : requireLowerHex(value, 16, 'upload chunk object id')
}

function bounded(value: unknown, maximum: number): number {
  return requireBoundedInteger(value, 0, maximum, 'upload cursor')
}

function positive(value: unknown, maximum: number): number {
  return requireBoundedInteger(value, 1, maximum, 'upload cursor')
}

function hex(value: unknown, bytes: number): string {
  if (!(value instanceof Uint8Array) || value.byteLength !== bytes) invalid('upload cursor')
  return bytesToHex(value)
}

function hexBytes(value: string): Uint8Array {
  const result = new Uint8Array(value.length / 2)
  for (let index = 0; index < result.length; index += 1)
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  return result
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function invalid(name: string): never {
  throw new Error(`encrypted backup ${name} is invalid`)
}

const cursorFields = [
  'schemaVersion',
  'realm',
  'vaultId',
  'targetManifestDigest',
  'attemptId',
  'phase',
  'nextPageIndex',
  'exclusiveChunkObjectId',
  'nextBatchOrdinal',
  'version',
] as const
