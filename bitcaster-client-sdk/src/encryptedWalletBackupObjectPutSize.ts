import {
  measureCanonicalBackupCbor,
  measureCanonicalBackupCborArrayHeader,
  measureCanonicalBackupCborByteString,
} from './encryptedWalletBackupCbor.ts'

/** Measures one canonical object PUT tuple from lengths only. */
export function measureEncryptedWalletBackupObjectPutPayload(input: {
  readonly kindCode: 1 | 2
  readonly realm: string
  readonly generation: number
  readonly paddedLength: 65_536 | 262_144
  readonly aadByteLength: number
  readonly bodyByteLength: number
}): number {
  return (
    measureCanonicalBackupCborArrayHeader(12) +
    measureCanonicalBackupCbor(1) +
    measureCanonicalBackupCbor('object-put') +
    measureCanonicalBackupCborByteString(32) +
    measureCanonicalBackupCbor(input.kindCode) +
    measureCanonicalBackupCbor(input.realm) +
    measureCanonicalBackupCborByteString(32) +
    measureCanonicalBackupCborByteString(16) +
    measureCanonicalBackupCbor(input.generation) +
    measureCanonicalBackupCbor(input.paddedLength) +
    measureCanonicalBackupCborByteString(32) +
    measureCanonicalBackupCborByteString(input.aadByteLength) +
    measureCanonicalBackupCborByteString(input.bodyByteLength)
  )
}
