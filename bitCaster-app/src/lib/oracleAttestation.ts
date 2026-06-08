import { nip19 } from 'nostr-tools'
import { finalizeEvent } from 'nostr-tools/pure'
import type { components } from '@/generated/api'

export type OracleNostrEvent = components['schemas']['OracleNostrEvent']

const KIND_DLC_ORACLE_ATTESTATION = 89 as const

export function buildOracleAttestationEvent(
  nsec: string,
  attestationHex: string,
  announcementEventId: string,
): OracleNostrEvent {
  const privateKey = decodeNsecToBytes(nsec)
  const content = base64FromBytes(hexToBytes(attestationHex))
  const signed = finalizeEvent(
    {
      kind: KIND_DLC_ORACLE_ATTESTATION,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['e', announcementEventId]],
      content,
    },
    privateKey,
  )

  return {
    id: signed.id,
    pubkey: signed.pubkey,
    createdAt: signed.created_at,
    kind: KIND_DLC_ORACLE_ATTESTATION,
    tags: signed.tags,
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

function hexToBytes(hex: string): Uint8Array {
  const trimmed = hex.trim()
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(trimmed)) {
    throw new Error('Expected hex-encoded DLC oracle attestation')
  }
  const out = new Uint8Array(trimmed.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(trimmed.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}
