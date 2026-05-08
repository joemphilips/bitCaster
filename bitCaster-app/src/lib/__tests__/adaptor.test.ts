import { describe, expect, it } from 'vitest'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import {
  generateAdaptorPoint,
  preSign,
  preVerify,
  adapt,
  extract,
} from '../adaptor'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomMessage(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32))
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

function getPubkey(privateKey: Uint8Array): Uint8Array {
  return hexToBytes(
    secp256k1.Point.BASE
      .multiply(BigInt('0x' + bytesToHex(privateKey)))
      .toHex(true),
  )
}

function getXOnlyPubkey(privateKey: Uint8Array): Uint8Array {
  return schnorr.getPublicKey(privateKey)
}

// ---------------------------------------------------------------------------
// generateAdaptorPoint
// ---------------------------------------------------------------------------

describe('generateAdaptorPoint', () => {
  it('returns a 32-byte secret and a 33-byte compressed point', () => {
    const { secret, point } = generateAdaptorPoint()
    expect(secret).toBeInstanceOf(Uint8Array)
    expect(secret.byteLength).toBe(32)
    expect(point).toBeInstanceOf(Uint8Array)
    expect(point.byteLength).toBe(33)
    expect(point[0] === 2 || point[0] === 3).toBe(true)
  })

  it('T = t·G (point is derived from secret)', () => {
    const { secret, point } = generateAdaptorPoint()
    const t = BigInt('0x' + bytesToHex(secret))
    const computed = secp256k1.Point.BASE.multiply(t).toHex(true)
    expect(bytesToHex(point)).toBe(computed)
  })

  it('generates distinct points on each call', () => {
    const a = generateAdaptorPoint()
    const b = generateAdaptorPoint()
    expect(bytesToHex(a.secret)).not.toBe(bytesToHex(b.secret))
  })
})

// ---------------------------------------------------------------------------
// preSign / preVerify
// ---------------------------------------------------------------------------

describe('preSign / preVerify', () => {
  it('produces a 65-byte pre-signature', () => {
    const sk = secp256k1.utils.randomSecretKey()
    const msg = randomMessage()
    const { point } = generateAdaptorPoint()
    const preSig = preSign(sk, msg, point)
    expect(preSig).toBeInstanceOf(Uint8Array)
    expect(preSig.byteLength).toBe(65)
  })

  it('preVerify accepts a valid pre-signature', () => {
    const sk = secp256k1.utils.randomSecretKey()
    const pk = getPubkey(sk)
    const msg = randomMessage()
    const { point } = generateAdaptorPoint()
    const preSig = preSign(sk, msg, point)
    expect(preVerify(pk, msg, preSig, point)).toBe(true)
  })

  it('preVerify rejects a corrupted pre-signature', () => {
    const sk = secp256k1.utils.randomSecretKey()
    const pk = getPubkey(sk)
    const msg = randomMessage()
    const { point } = generateAdaptorPoint()
    const preSig = preSign(sk, msg, point)

    const corrupted = new Uint8Array(preSig)
    corrupted[40] ^= 0xff  // flip bits in s'
    expect(preVerify(pk, msg, corrupted, point)).toBe(false)
  })

  it('preVerify rejects a wrong adaptor point', () => {
    const sk = secp256k1.utils.randomSecretKey()
    const pk = getPubkey(sk)
    const msg = randomMessage()
    const { point } = generateAdaptorPoint()
    const { point: wrongPoint } = generateAdaptorPoint()
    const preSig = preSign(sk, msg, point)
    expect(preVerify(pk, msg, preSig, wrongPoint)).toBe(false)
  })

  it('preVerify rejects a wrong message', () => {
    const sk = secp256k1.utils.randomSecretKey()
    const pk = getPubkey(sk)
    const msg = randomMessage()
    const wrongMsg = randomMessage()
    const { point } = generateAdaptorPoint()
    const preSig = preSign(sk, msg, point)
    expect(preVerify(pk, wrongMsg, preSig, point)).toBe(false)
  })

  it('throws on a non-32-byte message', () => {
    const sk = secp256k1.utils.randomSecretKey()
    const { point } = generateAdaptorPoint()
    expect(() => preSign(sk, new Uint8Array(16), point)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// adapt / extract — full cycle
// ---------------------------------------------------------------------------

describe('adapt + extract cycle', () => {
  it('adapt produces a 64-byte signature', () => {
    const sk = secp256k1.utils.randomSecretKey()
    const msg = randomMessage()
    const ap = generateAdaptorPoint()
    const preSig = preSign(sk, msg, ap.point)
    const sig = adapt(preSig, ap.secret)
    expect(sig).toBeInstanceOf(Uint8Array)
    expect(sig.byteLength).toBe(64)
  })

  it('adapt produces a BIP-340 signature accepted by the Cashu P2PK verifier shape', () => {
    for (let i = 0; i < 25; i++) {
      const sk = secp256k1.utils.randomSecretKey()
      const pk = getXOnlyPubkey(sk)
      const msg = randomMessage()
      const ap = generateAdaptorPoint()
      const preSig = preSign(sk, msg, ap.point)
      const sig = adapt(preSig, ap.secret)

      expect(schnorr.verify(sig, msg, pk)).toBe(true)
    }
  })

  it('extract recovers the adaptor secret from (sig, preSig)', () => {
    const sk = secp256k1.utils.randomSecretKey()
    const msg = randomMessage()
    const ap = generateAdaptorPoint()
    const preSig = preSign(sk, msg, ap.point)
    const sig = adapt(preSig, ap.secret)
    const recovered = extract(sig, preSig)
    expect(bytesToHex(recovered)).toBe(bytesToHex(ap.secret))
  })

  it('extract recovers the same secret for multiple proofs using the same T', () => {
    const sk = secp256k1.utils.randomSecretKey()
    const ap = generateAdaptorPoint()

    // Two different messages (simulating two proof secrets)
    const msg1 = randomMessage()
    const msg2 = randomMessage()

    const preSig1 = preSign(sk, msg1, ap.point)
    const preSig2 = preSign(sk, msg2, ap.point)
    const sig1 = adapt(preSig1, ap.secret)
    const sig2 = adapt(preSig2, ap.secret)

    const t1 = extract(sig1, preSig1)
    const t2 = extract(sig2, preSig2)

    // Both should yield the same adaptor secret
    expect(bytesToHex(t1)).toBe(bytesToHex(ap.secret))
    expect(bytesToHex(t2)).toBe(bytesToHex(ap.secret))
  })

  it('preSign is deterministic (same inputs → same pre-sig)', () => {
    const sk = secp256k1.utils.randomSecretKey()
    const msg = randomMessage()
    const { point } = generateAdaptorPoint()
    const preSig1 = preSign(sk, msg, point)
    const preSig2 = preSign(sk, msg, point)
    expect(bytesToHex(preSig1)).toBe(bytesToHex(preSig2))
  })

  it('different messages produce different pre-sigs', () => {
    const sk = secp256k1.utils.randomSecretKey()
    const { point } = generateAdaptorPoint()
    const preSig1 = preSign(sk, randomMessage(), point)
    const preSig2 = preSign(sk, randomMessage(), point)
    expect(bytesToHex(preSig1)).not.toBe(bytesToHex(preSig2))
  })
})
