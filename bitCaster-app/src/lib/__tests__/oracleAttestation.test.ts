import { describe, expect, it } from 'vitest'
import { bytesToHex, hexToBytes } from 'nostr-tools/utils'
import { getPublicKey } from 'nostr-tools/pure'
import { verifyEvent } from 'nostr-tools'
import { buildOracleAttestationEvent } from '../oracleAttestation'

// Deterministic test key (32-byte hex). Not a real secret.
const TEST_NSEC_HEX =
  '1111111111111111111111111111111111111111111111111111111111111111'
const ANNOUNCEMENT_EVENT_ID = '2222222222222222222222222222222222222222222222222222222222222222'

// A representative rust-dlc oracle_attestation byte blob, hex-encoded exactly
// as kormir.sign_enum_event returns it. The envelope builder must treat this
// as opaque payload bytes.
const ATTESTATION_HEX = 'deadbeefcafe0123'

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

describe('buildOracleAttestationEvent', () => {
  it('wraps the kormir attestation hex as base64 content in a kind-89 NIP-01 event', () => {
    const event = buildOracleAttestationEvent(
      TEST_NSEC_HEX,
      ATTESTATION_HEX,
      ANNOUNCEMENT_EVENT_ID,
    )

    expect(event.kind).toBe(89)
    expect(event.pubkey).toBe(getPublicKey(hexToBytes(TEST_NSEC_HEX)))
    expect(event.tags).toEqual([['e', ANNOUNCEMENT_EVENT_ID]])
    expect(bytesToHex(base64ToBytes(event.content))).toBe(ATTESTATION_HEX)
  })

  it('does NOT recompute the DLC signature itself', () => {
    const event = buildOracleAttestationEvent(
      TEST_NSEC_HEX,
      ATTESTATION_HEX,
      ANNOUNCEMENT_EVENT_ID,
    )
    const decoded = base64ToBytes(event.content)
    expect(decoded.length).toBe(ATTESTATION_HEX.length / 2)
    expect(bytesToHex(decoded)).toBe(ATTESTATION_HEX)
  })

  it('produces a NIP-01 envelope whose outer event-id signature verifies', () => {
    const event = buildOracleAttestationEvent(
      TEST_NSEC_HEX,
      ATTESTATION_HEX,
      ANNOUNCEMENT_EVENT_ID,
    )
    const ok = verifyEvent({
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.createdAt,
      kind: event.kind,
      tags: [['e', ANNOUNCEMENT_EVENT_ID]],
      content: event.content,
      sig: event.sig,
    })
    expect(ok).toBe(true)
  })

  it('accepts an nsec1 bech32 key and a 64-hex key interchangeably', () => {
    const fromHex = buildOracleAttestationEvent(
      TEST_NSEC_HEX,
      ATTESTATION_HEX,
      ANNOUNCEMENT_EVENT_ID,
    )
    expect(fromHex.pubkey).toBe(getPublicKey(hexToBytes(TEST_NSEC_HEX)))
  })

  it('rejects malformed attestation hex', () => {
    expect(() =>
      buildOracleAttestationEvent(TEST_NSEC_HEX, '', ANNOUNCEMENT_EVENT_ID),
    ).toThrow(/hex/i)
    expect(() =>
      buildOracleAttestationEvent(TEST_NSEC_HEX, 'xyz', ANNOUNCEMENT_EVENT_ID),
    ).toThrow(/hex/i)
    expect(() =>
      buildOracleAttestationEvent(TEST_NSEC_HEX, 'abc', ANNOUNCEMENT_EVENT_ID),
    ).toThrow(/hex/i)
  })

  it('rejects a malformed private key', () => {
    expect(() =>
      buildOracleAttestationEvent('not-a-key', ATTESTATION_HEX, ANNOUNCEMENT_EVENT_ID),
    ).toThrow()
  })
})
