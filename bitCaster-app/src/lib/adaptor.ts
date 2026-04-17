/**
 * Schnorr adaptor signatures on secp256k1 for bitCaster atomic swaps.
 *
 * Implements the adaptor signature scheme described in the atomic-swap spec:
 *
 *   Standard Schnorr:  s  = r + e·x           (e = H(R,  P, m))
 *   Adaptor pre-sig:   s' = r + e·x            (but nonce point R' = R + T)
 *                      s  = s' + t             (valid sig, nonce = R = R' - T)
 *
 * Operations:
 *   generateAdaptorPoint()          → { secret: t, point: T }
 *   preSign(sk, message, T)         → s' (65 bytes: 33-byte R' || 32-byte s')
 *   preVerify(pk, message, s', T)   → bool
 *   adapt(s', t)                    → s (64 bytes: 32-byte R_x || 32-byte s)
 *   extract(s, s')                  → t
 *
 * Uses @noble/curves v2 API: secp256k1.Point (ProjectivePoint).
 */

import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'

const Pt = secp256k1.Point
const Fn = Pt.Fn          // Field of scalars mod n
const ORDER = Fn.ORDER    // curve order n

// ---------------------------------------------------------------------------
// Adaptor point generation
// ---------------------------------------------------------------------------

export interface AdaptorPoint {
  /** 32-byte adaptor secret scalar t. */
  secret: Uint8Array
  /** 33-byte compressed adaptor point T = t·G. */
  point: Uint8Array
}

/** Generate a random adaptor secret and its corresponding EC point. */
export function generateAdaptorPoint(): AdaptorPoint {
  const secret = secp256k1.utils.randomSecretKey()
  const point = hexToBytes(Pt.BASE.multiply(bytesToBigInt(secret)).toHex(true))
  return { secret, point }
}

// ---------------------------------------------------------------------------
// Pre-sign / pre-verify
// ---------------------------------------------------------------------------

/**
 * Create a Schnorr adaptor pre-signature.
 *
 * Nonce point R' = R + T  (R = r·G, T = adaptor point)
 * Challenge  e = BIP340_H(R'_x || P_x || message)
 * Pre-sig    s' = r + e·x  (mod n)
 *
 * @param privateKey   - 32-byte signer private key
 * @param message      - 32-byte message hash
 * @param adaptorPoint - 33-byte compressed T = t·G
 * @returns 65-byte pre-signature: 33-byte compressed R' || 32-byte s'
 */
export function preSign(
  privateKey: Uint8Array,
  message: Uint8Array,
  adaptorPoint: Uint8Array,
): Uint8Array {
  if (message.length !== 32) throw new Error('message must be 32 bytes')
  if (adaptorPoint.length !== 33) throw new Error('adaptorPoint must be 33 bytes')

  // Deterministic nonce derived from (sk, m, T) to avoid reuse
  const nonceBytes = deterministicNonce(privateKey, message, adaptorPoint)
  let r_scalar = Fn.create(bytesToBigInt(nonceBytes))
  if (r_scalar === 0n) throw new Error('degenerate nonce — try again')

  // R = r·G,  T = adaptorPoint,  R' = R + T
  let R = Pt.BASE.multiply(r_scalar)
  const T = Pt.fromHex(bytesToHex(adaptorPoint))
  let R_prime = R.add(T)

  // BIP-340 requires even-y for the nonce point used in the challenge.
  // If R' has odd y, negate r so that R' flips to even y.
  if (R_prime.toAffine().y % 2n !== 0n) {
    r_scalar = Fn.create(ORDER - r_scalar)
    R = Pt.BASE.multiply(r_scalar)
    R_prime = R.add(T)
  }

  // Signer's public key P = x·G
  const x = Fn.create(bytesToBigInt(privateKey))
  const P = Pt.BASE.multiply(x)

  // Challenge e = BIP340 tagged hash over (R'_x || P_x || m)
  const R_prime_x = bigIntToBytes32(R_prime.toAffine().x)
  const P_x = bigIntToBytes32(P.toAffine().x)
  const e = schnorrChallenge(R_prime_x, P_x, message)

  // s' = r + e·x  (mod n)
  const s_prime = Fn.create(r_scalar + Fn.create(e * x))

  const R_prime_compressed = hexToBytes(R_prime.toHex(true))  // 33 bytes
  const out = new Uint8Array(65)
  out.set(R_prime_compressed, 0)
  out.set(bigIntToBytes32(s_prime), 33)
  return out
}

/**
 * Verify a Schnorr adaptor pre-signature.
 *
 * The pre-sign equation is: s' = r + e·x  where R' = R + T
 * So: s'·G = R + e·P = (R' - T) + e·P
 * Rearranging: s'·G - e·P == R' - T
 */
export function preVerify(
  publicKey: Uint8Array,
  message: Uint8Array,
  preSig: Uint8Array,
  adaptorPoint: Uint8Array,
): boolean {
  if (message.length !== 32) return false
  if (preSig.length !== 65) return false
  if (adaptorPoint.length !== 33) return false

  try {
    const R_prime = Pt.fromHex(bytesToHex(preSig.slice(0, 33)))
    const s_prime = bytesToBigInt(preSig.slice(33, 65))
    const P = Pt.fromHex(bytesToHex(publicKey))
    const T = Pt.fromHex(bytesToHex(adaptorPoint))

    const R_prime_x = bigIntToBytes32(R_prime.toAffine().x)
    const P_x = bigIntToBytes32(P.toAffine().x)
    const e = schnorrChallenge(R_prime_x, P_x, message)

    // s'·G - e·P == R' - T
    const lhs = Pt.BASE.multiply(Fn.create(s_prime)).subtract(P.multiply(Fn.create(e)))
    const rhs = R_prime.subtract(T)
    return lhs.equals(rhs)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Adapt / extract
// ---------------------------------------------------------------------------

/**
 * Complete an adaptor pre-signature into a valid Schnorr signature.
 *
 * s = s' + t  (mod n)
 *
 * @param preSig        - 65-byte pre-signature from preSign
 * @param adaptorSecret - 32-byte adaptor secret t
 * @returns 64-byte Schnorr signature (32-byte R_x || 32-byte s)
 */
export function adapt(preSig: Uint8Array, adaptorSecret: Uint8Array): Uint8Array {
  if (preSig.length !== 65) throw new Error('preSig must be 65 bytes')
  if (adaptorSecret.length !== 32) throw new Error('adaptorSecret must be 32 bytes')

  const s_prime = bytesToBigInt(preSig.slice(33, 65))
  const t = Fn.create(bytesToBigInt(adaptorSecret))

  // Canonical nonce: R = R' - T
  const R_prime = Pt.fromHex(bytesToHex(preSig.slice(0, 33)))
  const T = Pt.BASE.multiply(t)
  const R = R_prime.subtract(T)

  // BIP-340 requires even-y for R. If R has odd y, negate s so the
  // verifier's reconstruction of R (from s·G - e·P) yields the even-y point.
  let s_val = Fn.create(s_prime + t)
  if (R.toAffine().y % 2n !== 0n) {
    s_val = Fn.create(ORDER - s_val)
  }

  const sig = new Uint8Array(64)
  sig.set(bigIntToBytes32(R.toAffine().x), 0)  // x-only 32 bytes
  sig.set(bigIntToBytes32(s_val), 32)
  return sig
}

/**
 * Extract the adaptor secret from a completed signature and pre-signature.
 *
 * When R = R' - T has even y:  t = s - s'  (mod n)
 * When R = R' - T has odd y:   adapt() negated s, so s_adapted = -(s'+t),
 *                               therefore t = -s_adapted - s' = n - s - s'  (mod n)
 *
 * We disambiguate by trying both candidates and checking which gives a T
 * consistent with R' = R + T (i.e. T = R' - R for the right parity of R).
 */
export function extract(signature: Uint8Array, preSig: Uint8Array): Uint8Array {
  if (signature.length !== 64) throw new Error('signature must be 64 bytes')
  if (preSig.length !== 65) throw new Error('preSig must be 65 bytes')

  const s_val = bytesToBigInt(signature.slice(32, 64))
  const s_prime = bytesToBigInt(preSig.slice(33, 65))
  const R_prime = Pt.fromHex(bytesToHex(preSig.slice(0, 33)))
  const R_x = bytesToBigInt(signature.slice(0, 32))

  // Try both candidates for t (even-y and odd-y R cases)
  const t_even = Fn.create(s_val - s_prime + ORDER)   // even-y R case
  const t_odd  = Fn.create(ORDER - s_val - s_prime + ORDER)  // odd-y R (s was negated)

  // For each candidate, reconstruct T = t·G and check R' = R_even + T or R' = R_odd + T
  for (const t_candidate of [t_even, t_odd]) {
    if (t_candidate === 0n) continue
    try {
      const T = Pt.BASE.multiply(t_candidate)
      // R = R' - T; check that R's x-coordinate matches the sig
      const R_reconstructed = R_prime.subtract(T)
      if (R_reconstructed.toAffine().x === R_x) {
        return bigIntToBytes32(t_candidate)
      }
    } catch {
      // invalid point, try next candidate
    }
  }

  // Fallback: return the even-y candidate (caller's responsibility to verify)
  return bigIntToBytes32(t_even)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * BIP-340 tagged Schnorr challenge hash:
 *   H_tag = SHA256(SHA256(tag) || SHA256(tag) || data)
 *   tag  = "BIP0340/challenge"
 *   data = R_x (32) || P_x (32) || message (32)
 */
const BIP340_CHALLENGE_TAG = 'BIP0340/challenge'
// Pre-compute the tag prefix once (two SHA-256 hashes of the tag)
let _tagPrefix: Uint8Array | null = null

function getTagPrefix(): Uint8Array {
  if (_tagPrefix) return _tagPrefix
  const tagBytes = new TextEncoder().encode(BIP340_CHALLENGE_TAG)
  const tagHash = sha256(tagBytes)
  _tagPrefix = new Uint8Array(64)
  _tagPrefix.set(tagHash, 0)
  _tagPrefix.set(tagHash, 32)
  return _tagPrefix
}

function schnorrChallenge(R_x: Uint8Array, P_x: Uint8Array, message: Uint8Array): bigint {
  const prefix = getTagPrefix()
  const data = new Uint8Array(64 + 96)  // prefix(64) + R_x(32) + P_x(32) + m(32)
  data.set(prefix, 0)
  data.set(R_x, 64)
  data.set(P_x, 96)
  data.set(message, 128)
  const digest = sha256(data)
  return Fn.create(bytesToBigInt(digest))
}

// Pre-computed tagged hash prefix for adaptor nonce derivation (cached at module level)
let _nonceTagPrefix: Uint8Array | null = null

function getNonceTagPrefix(): Uint8Array {
  if (_nonceTagPrefix) return _nonceTagPrefix
  const tagHash = sha256(new TextEncoder().encode('bitcaster/adaptor-nonce'))
  _nonceTagPrefix = new Uint8Array(64)
  _nonceTagPrefix.set(tagHash, 0)
  _nonceTagPrefix.set(tagHash, 32)
  return _nonceTagPrefix
}

/**
 * Deterministic nonce with domain separation.
 * Uses a BIP-340-style tagged hash: SHA256(tag || tag || sk || m || T).
 */
function deterministicNonce(
  privateKey: Uint8Array,
  message: Uint8Array,
  adaptorPoint: Uint8Array,
): Uint8Array {
  const prefix = getNonceTagPrefix()
  const data = new Uint8Array(64 + privateKey.length + message.length + adaptorPoint.length)
  data.set(prefix, 0)
  data.set(privateKey, 64)
  data.set(message, 64 + privateKey.length)
  data.set(adaptorPoint, 64 + privateKey.length + message.length)
  return sha256(data)
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  return BigInt('0x' + bytesToHex(bytes))
}

function bigIntToBytes32(v: bigint): Uint8Array {
  const hex = v.toString(16).padStart(64, '0')
  return hexToBytes(hex)
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}
