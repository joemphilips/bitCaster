import { bytesToHex } from '@noble/hashes/utils.js'
import { decode } from 'cborg'
import {
  encodeCanonicalBackupCbor,
  preflightEncryptedBackupObjectAadCbor,
} from './encryptedWalletBackupCbor.ts'

export type EncryptedWalletBackupObjectAad =
  | Readonly<{ kindCode: 1 }>
  | Readonly<{
      kindCode: 2
      snapshotId: string
      snapshotRevision: number
      sealedControlDigest: Uint8Array
      resultDigest: Uint8Array
      pageIndex: number
      pageCount: number
      sourceIntervalCommitment: Uint8Array
    }>

export function requireEncryptedWalletBackupObjectAad(
  input: Readonly<{
    canonicalAad: Uint8Array
    kindCode: 1 | 2
    realm: string
    vaultId: string
    objectId: string
    generation: number
    paddedLength: 65_536 | 262_144
  }>,
): EncryptedWalletBackupObjectAad {
  preflightEncryptedBackupObjectAadCbor(input.canonicalAad)
  const value = decode(input.canonicalAad)
  if (!equalBytes(input.canonicalAad, encodeCanonicalBackupCbor(value)) || !Array.isArray(value)) {
    throw new Error('encrypted backup object AAD is invalid')
  }
  return input.kindCode === 1
    ? requireProofChunkAad(value, input)
    : requireManifestPageAad(value, input)
}

function requireProofChunkAad(
  value: unknown[],
  input: Parameters<typeof requireEncryptedWalletBackupObjectAad>[0],
): Readonly<{ kindCode: 1 }> {
  if (
    value.length !== 7 ||
    value[0] !== 1 ||
    value[1] !== 1 ||
    value[2] !== input.realm ||
    bytesToHex(exactBytes(value[3], 32)) !== input.vaultId ||
    bytesToHex(exactBytes(value[4], 16)) !== input.objectId ||
    value[5] !== input.generation ||
    value[6] !== input.paddedLength
  ) {
    throw new Error('encrypted backup object AAD is invalid')
  }
  return Object.freeze({ kindCode: 1 })
}

function requireManifestPageAad(
  value: unknown[],
  input: Parameters<typeof requireEncryptedWalletBackupObjectAad>[0],
): Extract<EncryptedWalletBackupObjectAad, { kindCode: 2 }> {
  requireManifestPageIdentity(value, input)
  const snapshotId = boundedText(value[8], 128)
  const snapshotRevision = boundedInteger(value[9], 0, Number.MAX_SAFE_INTEGER)
  const sealedControlDigest = exactBytes(value[10], 32)
  const resultDigest = exactBytes(value[11], 32)
  const pageIndex = boundedInteger(value[12], 0, 1_023)
  const pageCount = boundedInteger(value[13], 1, 1_024)
  const sourceIntervalCommitment = exactBytes(value[14], 32)
  if (pageIndex >= pageCount) throw new Error('encrypted backup object AAD is invalid')
  return Object.freeze({
    kindCode: 2,
    snapshotId,
    snapshotRevision,
    sealedControlDigest: sealedControlDigest.slice(),
    resultDigest: resultDigest.slice(),
    pageIndex,
    pageCount,
    sourceIntervalCommitment: sourceIntervalCommitment.slice(),
  })
}

function requireManifestPageIdentity(
  value: unknown[],
  input: Parameters<typeof requireEncryptedWalletBackupObjectAad>[0],
): void {
  if (
    value.length !== 15 ||
    value[0] !== 1 ||
    value[1] !== 'encrypted-wallet-backup-manifest-page-aad' ||
    value[2] !== 2 ||
    value[3] !== input.realm ||
    bytesToHex(exactBytes(value[4], 32)) !== input.vaultId ||
    bytesToHex(exactBytes(value[5], 16)) !== input.objectId ||
    value[6] !== input.generation ||
    value[7] !== input.paddedLength
  ) {
    throw new Error('encrypted backup object AAD is invalid')
  }
}

function exactBytes(value: unknown, length: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new Error('encrypted backup object AAD is invalid')
  }
  return value
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error('encrypted backup object AAD is invalid')
  }
  return value as number
}

function boundedText(value: unknown, maximumBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    hasInvalidText(value) ||
    new TextEncoder().encode(value).byteLength > maximumBytes
  ) {
    throw new Error('encrypted backup object AAD is invalid')
  }
  return value
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

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  let difference = 0
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!
  }
  return difference === 0
}
