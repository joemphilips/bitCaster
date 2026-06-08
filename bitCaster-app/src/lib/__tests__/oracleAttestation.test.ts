import { describe, expect, it } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { buildOracleAttestationEvent } from '../oracleAttestation'

const PRIVATE_KEY_HEX = '11'.repeat(32)

describe('oracle attestation helpers', () => {
  it('wraps an attestation payload into a signed kind-89 Nostr event', () => {
    const announcementEventId = '22'.repeat(32)
    const event = buildOracleAttestationEvent(PRIVATE_KEY_HEX, '000102', announcementEventId)

    expect(event.kind).toBe(89)
    expect(event.content).toBe('AAEC')
    expect(event.tags).toEqual([['e', announcementEventId]])
    expect(event.pubkey).toBe(bytesToHex(schnorr.getPublicKey(hexToBytes(PRIVATE_KEY_HEX))))
    expect(event.sig).toMatch(/^[0-9a-f]{128}$/)
  })
})

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
