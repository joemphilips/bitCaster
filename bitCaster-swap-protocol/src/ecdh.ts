/**
 * ECDH key agreement and symmetric encryption helpers for bitCaster atomic swaps.
 *
 * Implements Steps 3 of the atomic-swap protocol:
 *   Alice: S = a · B
 *   Bob:   S = b · A
 *   key = SHA-256(S_x || S_y)
 *
 * Encryption uses AES-256-GCM with a random 96-bit IV prepended to the ciphertext.
 * Everything is kept in Uint8Array so the caller controls hex-encoding.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js'

// ---------------------------------------------------------------------------
// Keypair
// ---------------------------------------------------------------------------

export interface EphemeralKeypair {
  /** 32-byte scalar. */
  privateKey: Uint8Array
  /** 33-byte compressed point, hex (starts 02/03). */
  publicKey: string
}

/** Generate a fresh ephemeral secp256k1 keypair for one trade. */
export function generateEphemeralKeypair(): EphemeralKeypair {
  const privateKey = secp256k1.utils.randomSecretKey()
  const publicKey = bytesToHex(secp256k1.getPublicKey(privateKey, true))
  return { privateKey, publicKey }
}

// ---------------------------------------------------------------------------
// ECDH shared secret
// ---------------------------------------------------------------------------

/**
 * Compute an ECDH shared secret.
 *
 * @param privateKey - 32-byte scalar (caller's secret key)
 * @param counterpartyPubkey - hex-encoded compressed 33-byte point
 * @returns 33-byte compressed shared point
 */
export function computeSharedSecret(
  privateKey: Uint8Array,
  counterpartyPubkey: string,
): Uint8Array {
  const pubBytes = hexToBytes(counterpartyPubkey)
  // getSharedSecret returns a 33-byte compressed point by default
  return secp256k1.getSharedSecret(privateKey, pubBytes)
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/**
 * Derive a 256-bit AES key from the shared EC point.
 * Uses SHA-256 over the raw bytes of the compressed shared point.
 */
export function deriveEncryptionKey(sharedSecret: Uint8Array): Promise<CryptoKey> {
  const digest = crypto.subtle.digest('SHA-256', sharedSecret.buffer as ArrayBuffer)
  return digest.then((raw) =>
    crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]),
  )
}

// ---------------------------------------------------------------------------
// Encrypt / decrypt — AES-256-GCM
// ---------------------------------------------------------------------------

const IV_BYTES = 12 // 96-bit IV for GCM

/**
 * Encrypt `plaintext` using AES-256-GCM.
 *
 * @returns base64-encoded `IV (12 bytes) || ciphertext+tag`
 */
export async function encrypt(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const encoded = new TextEncoder().encode(plaintext)
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded)
  const out = new Uint8Array(IV_BYTES + cipherBuf.byteLength)
  out.set(iv, 0)
  out.set(new Uint8Array(cipherBuf), IV_BYTES)
  return uint8ToBase64(out)
}

/**
 * Decrypt a base64-encoded `IV || ciphertext+tag` produced by `encrypt`.
 */
export async function decrypt(key: CryptoKey, ciphertext: string): Promise<string> {
  const buf = base64ToUint8(ciphertext)
  const iv = buf.slice(0, IV_BYTES)
  const data = buf.slice(IV_BYTES)
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data)
  return new TextDecoder().decode(plainBuf)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hex string has odd length')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function uint8ToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
