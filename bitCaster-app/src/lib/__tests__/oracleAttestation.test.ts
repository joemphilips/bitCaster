import { describe, expect, it } from 'vitest'
import { bytesToHex, hexToBytes } from 'nostr-tools/utils'
import { getPublicKey } from 'nostr-tools/pure'
import { verifyEvent } from 'nostr-tools'
import { buildOracleAttestationEvent } from '../oracleAttestation'

// Deterministic test key (32-byte hex). Not a real secret.
const TEST_NSEC_HEX =
  '1111111111111111111111111111111111111111111111111111111111111111'

// A representative rust-dlc oracle_attestation byte blob, hex-encoded exactly
// as kormir.sign_enum_event returns it. The envelope builder must treat this
// as opaque payload bytes — it base64-encodes the decoded bytes into content.
const ATTESTATION_HEX = 'deadbeefcafe0123'

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

describe('buildOracleAttestationEvent', () => {
  it('wraps the kormir attestation hex as base64 content in a kind-89 NIP-01 event', () => {
    const event = buildOracleAttestationEvent(TEST_NSEC_HEX, ATTESTATION_HEX)

    expect(event.kind).toBe(89)
    expect(event.pubkey).toBe(getPublicKey(hexToBytes(TEST_NSEC_HEX)))
    // content is base64 of the *decoded* attestation bytes — this is the exact
    // form the engine base64-decodes back into the rust-dlc TLV.
    expect(bytesToHex(base64ToBytes(event.content))).toBe(ATTESTATION_HEX)
  })

  it('does NOT recompute the DLC signature itself (no fresh-nonce schnorr over the outcome)', () => {
    // The retired hand-rolled signer computed
    //   schnorr.sign(taggedHash("DLC/oracle/attestation/v0", outcome), key)
    // and shoved that into the payload. The new builder must NOT do that — the
    // DLC signature lives inside the kormir-produced attestation hex, which we
    // pass through verbatim. Proof: the content decodes to exactly the input
    // bytes, with no extra schnorr signature appended.
    const event = buildOracleAttestationEvent(TEST_NSEC_HEX, ATTESTATION_HEX)
    const decoded = base64ToBytes(event.content)
    expect(decoded.length).toBe(ATTESTATION_HEX.length / 2)
    expect(bytesToHex(decoded)).toBe(ATTESTATION_HEX)
  })

  it('produces a NIP-01 envelope whose outer event-id signature verifies', () => {
    const event = buildOracleAttestationEvent(TEST_NSEC_HEX, ATTESTATION_HEX)
    // The engine recomputes the event id and schnorr-verifies the outer sig.
    const ok = verifyEvent({
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.createdAt,
      kind: event.kind,
      tags: [],
      content: event.content,
      sig: event.sig,
    })
    expect(ok).toBe(true)
  })

  it('accepts an nsec1 bech32 key and a 64-hex key interchangeably', () => {
    const fromHex = buildOracleAttestationEvent(TEST_NSEC_HEX, ATTESTATION_HEX)
    expect(fromHex.pubkey).toBe(getPublicKey(hexToBytes(TEST_NSEC_HEX)))
  })

  it('rejects malformed attestation hex', () => {
    expect(() => buildOracleAttestationEvent(TEST_NSEC_HEX, '')).toThrow(/hex/i)
    expect(() => buildOracleAttestationEvent(TEST_NSEC_HEX, 'xyz')).toThrow(/hex/i)
    expect(() => buildOracleAttestationEvent(TEST_NSEC_HEX, 'abc')).toThrow(/hex/i)
  })

  it('rejects a malformed private key', () => {
    expect(() => buildOracleAttestationEvent('not-a-key', ATTESTATION_HEX)).toThrow()
  })
})
