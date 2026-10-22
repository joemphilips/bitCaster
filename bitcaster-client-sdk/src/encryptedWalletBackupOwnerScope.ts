import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { encodeCanonicalBackupCbor } from './encryptedWalletBackupCbor.ts'
import { requireEncryptedWalletBackupAuthorizationScheme } from './encryptedWalletBackupServerCodec.ts'

export interface EncryptedWalletBackupOwnerScope {
  readonly authorizationScheme: string
  readonly ownerSubject: string
  readonly ownerScopeId: string
}

/** Public metadata derived from an exact opaque subject; never authentication. */
export function deriveEncryptedWalletBackupOwnerScope(input: {
  authorizationScheme: string
  ownerSubject: string
}): EncryptedWalletBackupOwnerScope {
  const authorizationScheme = requireEncryptedWalletBackupAuthorizationScheme(
    input.authorizationScheme,
  )
  const subject = input.ownerSubject
  if (
    typeof subject !== 'string' ||
    subject.length > 512 ||
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      new TextEncoder().encode(subject),
    ) !== subject ||
    subject.includes('\0')
  )
    throw new Error('backup owner subject is invalid')
  const size = new TextEncoder().encode(subject).byteLength
  if (size < 1 || size > 512) throw new Error('backup owner subject is invalid')
  return Object.freeze({
    authorizationScheme,
    ownerSubject: subject,
    ownerScopeId: bytesToHex(
      sha256(encodeCanonicalBackupCbor([1, 'backup-owner-scope', authorizationScheme, subject])),
    ),
  })
}

export function decodeEncryptedWalletBackupOwnerScope(
  value: unknown,
): EncryptedWalletBackupOwnerScope {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'authorizationScheme,ownerScopeId,ownerSubject'
  )
    throw new Error('backup owner scope is invalid')
  const supplied = value as EncryptedWalletBackupOwnerScope
  const derived = deriveEncryptedWalletBackupOwnerScope(supplied)
  if (supplied.ownerScopeId !== derived.ownerScopeId)
    throw new Error('backup owner scope is invalid')
  return derived
}
