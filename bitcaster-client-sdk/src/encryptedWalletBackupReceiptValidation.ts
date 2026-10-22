import {
  type EncryptedWalletBackupV2ObjectReference,
  ENCRYPTED_WALLET_BACKUP_V2_DESCRIPTOR_OBJECT_MAX,
} from './encryptedWalletBackupV2Descriptor.ts'
import {
  hexToBytesStrict,
  requireBytes,
  requireLowerHex,
  requireValidXOnlyPublicKey,
} from './encryptedWalletBackupServerValidation.ts'
const ENCRYPTED_WALLET_BACKUP_V2_SUPERSEDED_BUNDLE_MAX = 256
interface Pin {
  readonly keyId: string
  readonly publicKey: string
}
// Structural validators only. Each authority version owns its capability registry.
export function requireSignature(value: unknown): Uint8Array {
  return new Uint8Array(requireBytes(value, 64, 64, 'receipt signature'))
}

export function decodePins(value: unknown): readonly Pin[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2)
    throw new Error('encrypted backup receipt pins are invalid')
  const pins = value.map((item) => {
    const record = exactRecord(item, ['keyId', 'publicKey'])
    const keyId = requireLowerHex(record.keyId, 16, 'receipt key id')
    const publicKey = requirePublicKey(record.publicKey)
    return Object.freeze({ keyId, publicKey })
  })
  if (
    new Set(pins.map((item) => item.keyId)).size !== pins.length ||
    new Set(pins.map((item) => item.publicKey)).size !== pins.length
  )
    throw new Error('encrypted backup receipt pins are duplicated')
  return Object.freeze(pins)
}

export function decodeObjects(value: unknown): readonly EncryptedWalletBackupV2ObjectReference[] {
  if (!Array.isArray(value) || value.length > ENCRYPTED_WALLET_BACKUP_V2_DESCRIPTOR_OBJECT_MAX)
    throw new Error('encrypted backup receipt objects are invalid')
  const objects = Object.freeze(
    value.map((item) => {
      const record = exactRecord(item, ['objectId', 'digest'])
      return Object.freeze({
        objectId: requireLowerHex(record.objectId, 16, 'object id'),
        digest: requireLowerHex(record.digest, 32, 'object digest'),
      })
    }),
  )
  if (new Set(objects.map((item) => item.objectId)).size !== objects.length)
    throw new Error('encrypted backup receipt objects are duplicated')
  return objects
}

export function decodeBundleIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > ENCRYPTED_WALLET_BACKUP_V2_SUPERSEDED_BUNDLE_MAX)
    throw new Error('encrypted backup receipt superseded bundles are invalid')
  const ids = value.map((item) => requireLowerHex(item, 16, 'superseded bundle id'))
  if (ids.some((item, index) => index > 0 && item <= ids[index - 1]!))
    throw new Error('encrypted backup receipt superseded bundles are invalid')
  return Object.freeze(ids)
}

export function nullableHex(value: unknown, bytes: number, name: string): string | null {
  return value === null ? null : requireLowerHex(value, bytes, name)
}

export function objectTuple(value: EncryptedWalletBackupV2ObjectReference): readonly Uint8Array[] {
  return [
    hexToBytesStrict(value.objectId, 16, 'object id'),
    hexToBytesStrict(value.digest, 32, 'object digest'),
  ]
}

export function sameObjects(
  left: readonly EncryptedWalletBackupV2ObjectReference[],
  right: readonly EncryptedWalletBackupV2ObjectReference[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (item, index) =>
        item.objectId === right[index]?.objectId && item.digest === right[index]?.digest,
    )
  )
}

export function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

export function requirePublicKey(value: unknown): string {
  const key = requireLowerHex(value, 32, 'receipt public key')
  requireValidXOnlyPublicKey(hexToBytesStrict(key, 32, 'receipt public key'), 'receipt public key')
  return key
}

export function positive(value: unknown, name: string): number {
  return bounded(value, 1, name)
}

export function bounded(value: unknown, min: number, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min)
    throw new Error(`encrypted backup ${name} is invalid`)
  return value as number
}

export function exactRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))
  )
    throw new Error('encrypted backup receipt is invalid')
  return value as Record<string, unknown>
}

export function toHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
