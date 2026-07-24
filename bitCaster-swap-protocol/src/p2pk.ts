/**
 * NUT-11 P2PK spending condition helpers for bitCaster atomic swaps.
 *
 * Constructs the JSON-encoded NUT-11 P2PK spending condition that Cashu proofs
 * must satisfy, and creates the corresponding Schnorr witness signatures.
 *
 * Spec reference: nuts/11.md (P2PK spending conditions)
 */

import { schnorr } from '@noble/curves/secp256k1.js'

// ---------------------------------------------------------------------------
// NUT-11 secret structure
// ---------------------------------------------------------------------------

/** Parameters for building a NUT-11 P2PK spending condition. */
export interface P2PKSecretParams {
  /** Compressed secp256k1 pubkey (hex, 66 chars) that must sign to spend. */
  recipientPubkey: string
  /** Unix timestamp after which the refund pubkey may spend. */
  locktime: number
  /** Compressed secp256k1 pubkey (hex) that can spend after locktime expires. */
  refundPubkey: string
  /**
   * NUT-11 sigflag. Defaults to 'SIG_INPUTS' (only inputs must be signed).
   * Use 'SIG_ALL' to also commit to outputs.
   */
  sigFlag?: string
}

/**
 * Build a NUT-11 P2PK secret string — the JSON array the Cashu proof's
 * `secret` field must contain to impose a spending condition.
 *
 * Result shape (matches NUT-11):
 * ```json
 * ["P2PK", {
 *   "nonce": "<random 32-byte hex>",
 *   "data": "<recipient compressed pubkey hex>",
 *   "tags": [
 *     ["sigflag", "SIG_INPUTS"],
 *     ["locktime", "<unix timestamp>"],
 *     ["refund", "<refund compressed pubkey hex>"]
 *   ]
 * }]
 * ```
 */
export function createP2PKSecret(params: P2PKSecretParams): string {
  const nonce = randomHex(32)
  return JSON.stringify([
    'P2PK',
    {
      nonce,
      data: params.recipientPubkey,
      tags: [
        ['sigflag', params.sigFlag ?? 'SIG_INPUTS'],
        ['locktime', String(params.locktime)],
        ['refund', params.refundPubkey],
      ],
    },
  ])
}

// ---------------------------------------------------------------------------
// NUT-11 witness
// ---------------------------------------------------------------------------

/**
 * Sign a 32-byte message with a secp256k1 private key and return a
 * JSON-encoded NUT-11 witness object.
 *
 * @param privateKey - 32-byte scalar
 * @param message    - 32-byte message hash (typically SHA-256 of the proof secret)
 * @returns JSON string `{"signatures": ["<hex sig>"]}`
 */
export function createP2PKWitness(privateKey: Uint8Array, message: Uint8Array): string {
  if (message.length !== 32) throw new Error('message must be 32 bytes')
  // NUT-11 requires BIP-340 Schnorr signatures (not ECDSA).
  // schnorr.sign returns a 64-byte Uint8Array directly — no cast needed.
  const sig = schnorr.sign(message, privateKey)
  return JSON.stringify({ signatures: [bytesToHex(sig)] })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return bytesToHex(arr)
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
