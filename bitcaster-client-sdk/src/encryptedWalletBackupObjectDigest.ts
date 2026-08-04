import { sha256 } from '@noble/hashes/sha2.js'

/** Hashes the framed object without copying the complete encrypted body. */
export function encryptedWalletBackupObjectDigest(aad: Uint8Array, body: Uint8Array): Uint8Array {
  return sha256.create().update(uint32be(aad.byteLength)).update(aad).update(body).digest()
}

function uint32be(value: number): Uint8Array {
  return Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value)
}
