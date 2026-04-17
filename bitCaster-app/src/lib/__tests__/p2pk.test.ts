import { describe, expect, it } from 'vitest'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { createP2PKSecret, createP2PKWitness } from '../p2pk'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomPubkey(): string {
  const sk = secp256k1.utils.randomSecretKey()
  const pt = secp256k1.Point.BASE.multiply(
    BigInt('0x' + Array.from(sk).map((b) => b.toString(16).padStart(2, '0')).join('')),
  )
  return pt.toHex(true)
}

function randomHash(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32))
}

// ---------------------------------------------------------------------------
// createP2PKSecret
// ---------------------------------------------------------------------------

describe('createP2PKSecret', () => {
  it('returns a valid JSON-encoded NUT-11 P2PK secret', () => {
    const recipient = randomPubkey()
    const refund = randomPubkey()
    const secret = createP2PKSecret({
      recipientPubkey: recipient,
      locktime: 1_700_000_000,
      refundPubkey: refund,
    })

    expect(() => JSON.parse(secret)).not.toThrow()
  })

  it('first element is "P2PK"', () => {
    const secret = createP2PKSecret({
      recipientPubkey: randomPubkey(),
      locktime: 1_700_000_000,
      refundPubkey: randomPubkey(),
    })
    const parsed = JSON.parse(secret) as [string, unknown]
    expect(parsed[0]).toBe('P2PK')
  })

  it('data field contains the recipient pubkey', () => {
    const recipient = randomPubkey()
    const secret = createP2PKSecret({
      recipientPubkey: recipient,
      locktime: 1_700_000_000,
      refundPubkey: randomPubkey(),
    })
    const [, payload] = JSON.parse(secret) as [string, { data: string }]
    expect(payload.data).toBe(recipient)
  })

  it('includes sigflag tag defaulting to SIG_INPUTS', () => {
    const secret = createP2PKSecret({
      recipientPubkey: randomPubkey(),
      locktime: 1_700_000_000,
      refundPubkey: randomPubkey(),
    })
    const [, payload] = JSON.parse(secret) as [string, { tags: string[][] }]
    const sigflag = payload.tags.find((t) => t[0] === 'sigflag')
    expect(sigflag).toBeDefined()
    expect(sigflag![1]).toBe('SIG_INPUTS')
  })

  it('accepts a custom sigflag', () => {
    const secret = createP2PKSecret({
      recipientPubkey: randomPubkey(),
      locktime: 1_700_000_000,
      refundPubkey: randomPubkey(),
      sigFlag: 'SIG_ALL',
    })
    const [, payload] = JSON.parse(secret) as [string, { tags: string[][] }]
    const sigflag = payload.tags.find((t) => t[0] === 'sigflag')
    expect(sigflag![1]).toBe('SIG_ALL')
  })

  it('includes locktime tag with the correct unix timestamp', () => {
    const ts = 1_700_000_000
    const secret = createP2PKSecret({
      recipientPubkey: randomPubkey(),
      locktime: ts,
      refundPubkey: randomPubkey(),
    })
    const [, payload] = JSON.parse(secret) as [string, { tags: string[][] }]
    const locktime = payload.tags.find((t) => t[0] === 'locktime')
    expect(locktime).toBeDefined()
    expect(Number(locktime![1])).toBe(ts)
  })

  it('includes refund tag with the correct pubkey', () => {
    const refund = randomPubkey()
    const secret = createP2PKSecret({
      recipientPubkey: randomPubkey(),
      locktime: 1_700_000_000,
      refundPubkey: refund,
    })
    const [, payload] = JSON.parse(secret) as [string, { tags: string[][] }]
    const refundTag = payload.tags.find((t) => t[0] === 'refund')
    expect(refundTag).toBeDefined()
    expect(refundTag![1]).toBe(refund)
  })

  it('includes a nonce field', () => {
    const secret = createP2PKSecret({
      recipientPubkey: randomPubkey(),
      locktime: 1_700_000_000,
      refundPubkey: randomPubkey(),
    })
    const [, payload] = JSON.parse(secret) as [string, { nonce: string }]
    expect(payload.nonce).toMatch(/^[0-9a-f]{64}$/)
  })

  it('nonce is unique across calls', () => {
    const opts = {
      recipientPubkey: randomPubkey(),
      locktime: 1_700_000_000,
      refundPubkey: randomPubkey(),
    }
    const s1 = createP2PKSecret(opts)
    const s2 = createP2PKSecret(opts)
    const [, p1] = JSON.parse(s1) as [string, { nonce: string }]
    const [, p2] = JSON.parse(s2) as [string, { nonce: string }]
    expect(p1.nonce).not.toBe(p2.nonce)
  })
})

// ---------------------------------------------------------------------------
// createP2PKWitness
// ---------------------------------------------------------------------------

describe('createP2PKWitness', () => {
  it('returns JSON with a "signatures" array', () => {
    const sk = secp256k1.utils.randomSecretKey()
    const msg = randomHash()
    const witness = createP2PKWitness(sk, msg)
    expect(() => JSON.parse(witness)).not.toThrow()
    const parsed = JSON.parse(witness) as { signatures: string[] }
    expect(Array.isArray(parsed.signatures)).toBe(true)
    expect(parsed.signatures).toHaveLength(1)
  })

  it('signature is a 128-char hex string (64-byte Schnorr compact)', () => {
    const sk = secp256k1.utils.randomSecretKey()
    const witness = createP2PKWitness(sk, randomHash())
    const { signatures } = JSON.parse(witness) as { signatures: string[] }
    expect(signatures[0]).toMatch(/^[0-9a-f]{128}$/)
  })

  it('throws if message is not 32 bytes', () => {
    const sk = secp256k1.utils.randomSecretKey()
    expect(() => createP2PKWitness(sk, new Uint8Array(16))).toThrow()
  })

  it('different private keys produce different signatures for the same message', () => {
    const sk1 = secp256k1.utils.randomSecretKey()
    const sk2 = secp256k1.utils.randomSecretKey()
    const msg = randomHash()
    const w1 = createP2PKWitness(sk1, msg)
    const w2 = createP2PKWitness(sk2, msg)
    const { signatures: sigs1 } = JSON.parse(w1) as { signatures: string[] }
    const { signatures: sigs2 } = JSON.parse(w2) as { signatures: string[] }
    expect(sigs1[0]).not.toBe(sigs2[0])
  })
})
