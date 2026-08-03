import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { decode } from 'cborg'
import type {
  EncryptedWalletBackupReplayStore,
  EncryptedWalletBackupRequestMethod,
} from './encryptedWalletBackup.ts'
import {
  encodeCanonicalBackupCbor,
  preflightEncryptedBackupObjectAadCbor,
} from './encryptedWalletBackupCbor.ts'

export function requireBytes(
  value: unknown,
  minimum: number,
  maximum: number,
  name: string,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < minimum || value.byteLength > maximum) {
    throw new Error(`encrypted backup ${name} is invalid`)
  }
  return value
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  let difference = 0
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!
  }
  return difference === 0
}

export function requireLowerHex(value: unknown, byteLength: number, name: string): string {
  if (typeof value !== 'string' || value.length !== byteLength * 2 || !/^[0-9a-f]+$/u.test(value)) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

export function hexToBytesStrict(value: unknown, byteLength: number, name: string): Uint8Array {
  const hex = requireLowerHex(value, byteLength, name)
  return Uint8Array.from({ length: byteLength }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  )
}

export function requireRealm(value: unknown): string {
  const realm = requireUtf8Text(value, 64, 'encrypted backup realm')
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u.test(realm)) {
    throw new Error('encrypted backup realm is invalid')
  }
  return realm
}

export function requireUtf8Text(value: unknown, maximumBytes: number, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || hasInvalidText(value))
    throw new Error(`${name} is invalid`)
  if (new TextEncoder().encode(value).byteLength > maximumBytes)
    throw new Error(`${name} is invalid`)
  return value
}

export function requireInteger(value: unknown, minimum: number, name: string): number {
  return requireBoundedInteger(value, minimum, Number.MAX_SAFE_INTEGER, name)
}

export function requireBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${name} is invalid`)
  }
  return value as number
}

export function requireDelegatedMethod(value: unknown): EncryptedWalletBackupRequestMethod {
  if (value !== 'GET' && value !== 'PUT' && value !== 'POST' && value !== 'DELETE') {
    throw new Error('encrypted backup request method is invalid')
  }
  return value
}

export function requireExactHttpsUrl(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 2_048 ||
    /[^\x21-\x7e]/u.test(value)
  ) {
    throw new Error('encrypted backup request URL is invalid')
  }
  const parsed = parseUrl(value, 'encrypted backup request URL is invalid')
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hash !== '' ||
    parsed.href !== value
  ) {
    throw new Error('encrypted backup request URL is invalid')
  }
  return value
}

export function requireExactHttpsOrigin(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 2_048 ||
    /[^\x21-\x7e]/u.test(value)
  ) {
    throw new Error('encrypted backup origin is invalid')
  }
  const parsed = parseUrl(value, 'encrypted backup origin is invalid')
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.origin !== value
  ) {
    throw new Error('encrypted backup origin is invalid')
  }
  return value
}

export function requireValidXOnlyPublicKey(value: unknown, name: string): Uint8Array {
  const bytes = requireBytes(value, 32, 32, name)
  try {
    schnorr.utils.lift_x(BigInt(`0x${bytesToHex(bytes)}`))
    return bytes
  } catch {
    throw new Error(`encrypted backup ${name} is invalid`)
  }
}

export function requireReplayStore(
  value: unknown,
): asserts value is EncryptedWalletBackupReplayStore {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { consumeReplayNonce?: unknown }).consumeReplayNonce !== 'function'
  ) {
    throw new Error('encrypted backup replay store is invalid')
  }
}

export function decodeCanonicalBase64Url(value: string): Uint8Array {
  if (value.length % 4 === 1) throw new Error()
  const standard = value.replaceAll('-', '+').replaceAll('_', '/')
  const decodedText = atob(`${standard}${'='.repeat((4 - (standard.length % 4)) % 4)}`)
  const decoded = Uint8Array.from(decodedText, (character) => character.charCodeAt(0))
  if (encodeBase64Url(decoded) !== value) throw new Error()
  return decoded
}

export function framedEncryptedObjectDigest(
  aad: Uint8Array,
  encryptedBody: Uint8Array,
): Uint8Array {
  return sha256
    .create()
    .update(
      Uint8Array.of(
        aad.byteLength >>> 24,
        aad.byteLength >>> 16,
        aad.byteLength >>> 8,
        aad.byteLength,
      ),
    )
    .update(aad)
    .update(encryptedBody)
    .digest()
}

export function requireObjectAad(
  input: Readonly<{
    canonicalAad: Uint8Array
    kindCode: 1 | 2
    realm: string
    vaultId: string
    objectId: string
    generation: number
    paddedLength: 65_536 | 262_144
  }>,
): void {
  preflightEncryptedBackupObjectAadCbor(input.canonicalAad)
  const decoded = decode(input.canonicalAad)
  if (
    !equalBytes(input.canonicalAad, encodeCanonicalBackupCbor(decoded)) ||
    !Array.isArray(decoded) ||
    decoded.length !== 7 ||
    decoded[0] !== 1 ||
    decoded[1] !== input.kindCode ||
    decoded[2] !== input.realm ||
    bytesToHex(requireBytes(decoded[3], 32, 32, 'AAD vault id')) !== input.vaultId ||
    bytesToHex(requireBytes(decoded[4], 16, 16, 'AAD object id')) !== input.objectId ||
    decoded[5] !== input.generation ||
    decoded[6] !== input.paddedLength
  ) {
    throw new Error('encrypted backup object AAD is invalid')
  }
}

export function assertNever(value: never): never {
  throw new Error(`unexpected encrypted backup variant: ${String(value)}`)
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function parseUrl(value: string, message: string): URL {
  try {
    return new URL(value)
  } catch {
    throw new Error(message)
  }
}

function hasInvalidText(value: string): boolean {
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) return true
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}
