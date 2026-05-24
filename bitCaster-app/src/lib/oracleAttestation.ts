import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { nip19 } from 'nostr-tools'
import { finalizeEvent } from 'nostr-tools/pure'
import type { components } from '@/generated/api'

export type OracleNostrEvent = components['schemas']['OracleNostrEvent']

const DLC_ATTESTATION_TAG = 'DLC/oracle/attestation/v0'
const KIND_DLC_ORACLE_ATTESTATION = 89 as const

export function signEnumOracleAttestationEvent(
  nsec: string,
  eventId: string,
  outcome: string,
): OracleNostrEvent {
  const privateKey = decodeNsecToBytes(nsec)
  const outcomeBytes = new TextEncoder().encode(outcome)
  const digest = taggedHash(DLC_ATTESTATION_TAG, outcomeBytes)
  const attestationSignature = schnorr.sign(digest, privateKey)
  const oraclePubkey = schnorr.getPublicKey(privateKey)
  const content = base64FromBytes(
    buildAttestationTlv(eventId, oraclePubkey, attestationSignature, outcome),
  )
  const signed = finalizeEvent(
    {
      kind: KIND_DLC_ORACLE_ATTESTATION,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content,
    },
    privateKey,
  )

  return {
    id: signed.id,
    pubkey: signed.pubkey,
    createdAt: signed.created_at,
    kind: KIND_DLC_ORACLE_ATTESTATION,
    content: signed.content,
    sig: signed.sig,
  }
}

function decodeNsecToBytes(nsec: string): Uint8Array {
  const trimmed = nsec.trim()
  if (trimmed.startsWith('nsec1')) {
    const decoded = nip19.decode(trimmed)
    if (decoded.type !== 'nsec') throw new Error('Expected an nsec private key')
    return decoded.data
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    const out = new Uint8Array(32)
    for (let i = 0; i < 32; i++) {
      out[i] = Number.parseInt(trimmed.slice(i * 2, i * 2 + 2), 16)
    }
    return out
  }
  throw new Error('Expected an nsec1... or 64-character hex private key')
}

function taggedHash(tag: string, message: Uint8Array): Uint8Array {
  const tagHash = sha256(new TextEncoder().encode(tag))
  const buf = new Uint8Array(tagHash.length * 2 + message.length)
  buf.set(tagHash, 0)
  buf.set(tagHash, tagHash.length)
  buf.set(message, tagHash.length * 2)
  return sha256(buf)
}

function buildAttestationTlv(
  eventId: string,
  oraclePubkey: Uint8Array,
  signature: Uint8Array,
  outcome: string,
): Uint8Array {
  const eventIdBytes = new TextEncoder().encode(eventId)
  const outcomeBytes = new TextEncoder().encode(outcome)
  const chunks = [
    encodeBigSize(eventIdBytes.length),
    eventIdBytes,
    oraclePubkey,
    new Uint8Array([0x00, 0x01]),
    signature,
    encodeBigSize(outcomeBytes.length),
    outcomeBytes,
  ]
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function encodeBigSize(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('BigSize value must be a non-negative safe integer')
  }
  if (value < 0xfd) return new Uint8Array([value])
  if (value <= 0xffff) {
    return new Uint8Array([0xfd, (value >> 8) & 0xff, value & 0xff])
  }
  if (value <= 0xffffffff) {
    return new Uint8Array([
      0xfe,
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    ])
  }
  throw new Error('BigSize values above uint32 are not needed for attestations')
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}
