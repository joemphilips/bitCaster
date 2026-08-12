import { bytesToHex } from '@noble/hashes/utils.js'
import { decode } from 'cborg'
import type { EncryptedWalletBackupRequestProof } from './encryptedWalletBackup.ts'
import {
  encodeCanonicalBackupCbor,
  preflightEncryptedBackupRequestProofCbor,
} from './encryptedWalletBackupCbor.ts'
import {
  decodeCanonicalBase64Url,
  equalBytes,
  requireBoundedInteger,
  requireBytes,
  requireDelegatedMethod,
  requireExactHttpsUrl,
  requireInteger,
  requireRealm,
  requireValidXOnlyPublicKey,
} from './encryptedWalletBackupServerValidation.ts'

const AUTHORIZATION_PREFIX = 'BackupV1 '
export const ENCRYPTED_WALLET_BACKUP_REQUEST_PROOF_MAX_BYTES = 4_096 as const
export const ENCRYPTED_WALLET_BACKUP_AUTHORIZATION_HEADER_MAX_CHARACTERS = 5_471 as const

/** The shared V1 label identifies the account and delegated-request wire, not the removed backup pipeline. */
export interface DecodedEncryptedWalletBackupRequestProofClaims extends EncryptedWalletBackupRequestProof {}

/** Decodes one raw, uncombined, canonical `Authorization: BackupV1` value. */
export function decodeEncryptedWalletBackupAuthorizationHeader(
  rawHeaderValues: readonly string[],
): Uint8Array {
  try {
    if (
      !Array.isArray(rawHeaderValues) ||
      rawHeaderValues.length !== 1 ||
      typeof rawHeaderValues[0] !== 'string'
    )
      throw new Error()
    const value = rawHeaderValues[0]
    if (
      value.length > ENCRYPTED_WALLET_BACKUP_AUTHORIZATION_HEADER_MAX_CHARACTERS ||
      !/^BackupV1 [A-Za-z0-9_-]+$/u.test(value)
    )
      throw new Error()
    return requireBytes(
      decodeCanonicalBase64Url(value.slice(AUTHORIZATION_PREFIX.length)),
      1,
      ENCRYPTED_WALLET_BACKUP_REQUEST_PROOF_MAX_BYTES,
      'request proof',
    )
  } catch {
    throw new Error('encrypted backup authorization header is invalid; request proof is invalid')
  }
}

/** Strict public decoder for canonical request-proof claims. */
export function decodeEncryptedWalletBackupRequestProofClaims(
  canonicalProof: Uint8Array,
  maximumPayloadBytes = 4 * 1_024 * 1_024,
): DecodedEncryptedWalletBackupRequestProofClaims {
  try {
    const proofBytes = requireBytes(
      canonicalProof,
      1,
      ENCRYPTED_WALLET_BACKUP_REQUEST_PROOF_MAX_BYTES,
      'request proof',
    )
    const maximum = requireBoundedInteger(
      maximumPayloadBytes,
      0,
      4 * 1_024 * 1_024,
      'request payload maximum',
    )
    preflightEncryptedBackupRequestProofCbor(proofBytes)
    const decoded = decode(proofBytes)
    if (
      !equalBytes(proofBytes, encodeCanonicalBackupCbor(decoded)) ||
      !Array.isArray(decoded) ||
      decoded.length !== 14 ||
      decoded[0] !== 1 ||
      decoded[1] !== 'backup-request-proof'
    )
      throw new Error()
    return Object.freeze({
      formatVersion: 1,
      realm: requireRealm(decoded[2]),
      walletId: bytesToHex(requireBytes(decoded[3], 32, 32, 'request wallet id')),
      requestAuthPublicKey: bytesToHex(
        requireValidXOnlyPublicKey(
          requireBytes(decoded[4], 32, 32, 'request public key'),
          'request public key',
        ),
      ),
      enrollmentEpoch: requireInteger(decoded[5], 0, 'request epoch'),
      method: requireDelegatedMethod(decoded[6]),
      url: requireExactHttpsUrl(decoded[7]),
      issuedAtUnixSeconds: requireInteger(decoded[8], 0, 'request issue time'),
      expiresAtUnixSeconds: requireInteger(decoded[9], 0, 'request expiry time'),
      replayNonce: bytesToHex(requireBytes(decoded[10], 16, 16, 'request replay nonce')),
      payloadLength: requireBoundedInteger(decoded[11], 0, maximum, 'request payload length'),
      payloadDigest: bytesToHex(requireBytes(decoded[12], 32, 32, 'request payload digest')),
      signature: bytesToHex(requireBytes(decoded[13], 64, 64, 'request signature')),
    })
  } catch {
    throw new Error('encrypted backup request proof is invalid')
  }
}
