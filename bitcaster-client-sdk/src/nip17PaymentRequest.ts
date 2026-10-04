import { nprofileEncode } from 'nostr-tools/nip19'
import { v2 as nip44 } from 'nostr-tools/nip44'
import { getEventHash, getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure'
import { DURABLE_CUSTODY_RECOVERY_PAGE_BYTES_MAX } from './durableCustody.ts'
import { normalizeNostrRelayUrls } from './nostrRelays.ts'

// NIP-44 v2 bounds apply before its base64 decoder allocates payload bytes.
export const NIP44_V2_PAYLOAD_CHARS_MAX = 87_472
export const NIP44_V2_PAYLOAD_CHARS_MIN = 132
// This is the existing receive resource ceiling, not a NIP-imposed event size limit.
export const NIP17_PAYMENT_REQUEST_FRAME_BYTES_MAX = DURABLE_CUSTODY_RECOVERY_PAGE_BYTES_MAX

export interface DecryptedNip17PaymentRequestMessage {
  readonly wrapId: string
  readonly rumorId: string
  readonly senderPubkey: string
  readonly content: string
}

/** Bind the receive presentation to exactly the selected relays. No discovery or defaults. */
export function encodeNip17PaymentRequestNprofile(
  publicKey: string,
  relays: readonly string[],
): string {
  try {
    if (!hex(publicKey, 64)) throw new Error()
    const selected = normalizeNostrRelayUrls(relays)
    // NIP-19 TLV length uses one byte. Do not let its encoder truncate a relay hint.
    if (selected.some((relay) => new TextEncoder().encode(relay).length > 255)) throw new Error()
    const encoded = nprofileEncode({ pubkey: publicKey, relays: selected })
    if (encoded.length > 65_536) throw new Error()
    return encoded
  } catch {
    throw new Error('payment receive nprofile is invalid')
  }
}

/** Validate NIPs 17, 44 and 59. This is transport authentication, not proof acceptance. */
export function decryptNip17PaymentRequestMessage(input: {
  readonly wrap: unknown
  readonly privateKey: Uint8Array
}): DecryptedNip17PaymentRequestMessage | null {
  try {
    const recipient = getPublicKey(input.privateKey)
    const wrap = signedEvent(input.wrap, 1059)
    if (wrap === null || !hasRecipient(wrap.tags, recipient)) return null
    const seal = signedEvent(decryptEvent(wrap, input.privateKey), 13)
    if (seal === null || seal.tags.length !== 0) return null
    const rumor = decryptEvent(seal, input.privateKey)
    if (
      !record(rumor) ||
      !eventFields(rumor, 14) ||
      'sig' in rumor ||
      rumor.pubkey !== seal.pubkey ||
      !hasRecipient(rumor.tags, recipient) ||
      rumor.id !== getEventHash(rumor)
    )
      return null
    return {
      wrapId: wrap.id,
      rumorId: rumor.id,
      senderPubkey: rumor.pubkey,
      content: rumor.content,
    }
  } catch {
    // Parser and decrypt errors can contain private plaintext. Never expose them.
    return null
  }
}

function decryptEvent(event: Event, privateKey: Uint8Array): unknown {
  if (
    event.content.length < NIP44_V2_PAYLOAD_CHARS_MIN ||
    event.content.length > NIP44_V2_PAYLOAD_CHARS_MAX
  )
    throw new Error()
  return JSON.parse(
    nip44.decrypt(event.content, nip44.utils.getConversationKey(privateKey, event.pubkey)),
  )
}

function signedEvent(value: unknown, kind: number): Event | null {
  if (!record(value) || !eventFields(value, kind) || !hex(value.sig, 128)) return null
  if (
    value.content.length < NIP44_V2_PAYLOAD_CHARS_MIN ||
    value.content.length > NIP44_V2_PAYLOAD_CHARS_MAX
  )
    return null
  // Do not inherit a caller's nostr-tools signature-cache symbol after a mutation.
  const event: Event = {
    id: value.id,
    pubkey: value.pubkey,
    created_at: value.created_at,
    kind: value.kind,
    tags: value.tags,
    content: value.content,
    sig: value.sig,
  }
  return verifyEvent(event) ? event : null
}

function eventFields(
  value: Record<string, unknown>,
  kind: number,
): value is Record<string, unknown> & {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
} {
  return (
    hex(value.id, 64) &&
    hex(value.pubkey, 64) &&
    value.kind === kind &&
    typeof value.created_at === 'number' &&
    Number.isSafeInteger(value.created_at) &&
    value.created_at >= 0 &&
    typeof value.content === 'string' &&
    value.content.length <= NIP17_PAYMENT_REQUEST_FRAME_BYTES_MAX &&
    boundedTags(value.tags)
  )
}

function boundedTags(value: unknown): value is string[][] {
  if (!Array.isArray(value) || value.length > NIP17_PAYMENT_REQUEST_FRAME_BYTES_MAX) return false
  let bytes = 0
  for (const tag of value) {
    if (!Array.isArray(tag)) return false
    // Each empty tag/value still occupies JSON delimiters inside the frame budget.
    bytes += 2
    for (const field of tag) {
      if (typeof field !== 'string' || field.length > NIP17_PAYMENT_REQUEST_FRAME_BYTES_MAX)
        return false
      bytes += 3 + new TextEncoder().encode(field).length
      if (bytes > NIP17_PAYMENT_REQUEST_FRAME_BYTES_MAX) return false
    }
    if (bytes > NIP17_PAYMENT_REQUEST_FRAME_BYTES_MAX) return false
  }
  return true
}

function hasRecipient(tags: string[][], recipient: string): boolean {
  return tags.some((tag) => tag[0] === 'p' && tag[1] === recipient)
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function hex(value: unknown, length: number): value is string {
  return typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value)
}
