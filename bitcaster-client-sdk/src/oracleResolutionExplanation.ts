import { verifyEvent, type Event, type EventTemplate } from 'nostr-tools/pure'

export const ORACLE_EXPLANATION_UTF8_BYTES_MAX = 4_096
export const ORACLE_EVENT_JSON_BYTES_MAX = 256 * 1_024
const TAG_COUNT_MAX = 128
const TAG_ITEMS_MAX = 16
const TAG_VALUE_BYTES_MAX = 1_024

export interface OracleExplanationContext {
  readonly oraclePubkey: string
  readonly announcementEventJson: string
  readonly attestationEventJson: string
}

/** Use the signed event as received. Do not rebuild its timestamp or envelope. */
export function readSignedOracleEvent(eventJson: string, kind: 88 | 89 | 1111): Event {
  boundedText(eventJson, ORACLE_EVENT_JSON_BYTES_MAX, 'Oracle event is too large.')
  let value: unknown
  try {
    value = JSON.parse(eventJson)
  } catch {
    throw new Error('Oracle event JSON is invalid.')
  }
  if (
    !record(value) ||
    Object.keys(value).sort().join(',') !== 'content,created_at,id,kind,pubkey,sig,tags' ||
    value.kind !== kind ||
    !lowerHex(value.id, 64) ||
    !lowerHex(value.pubkey, 64) ||
    !lowerHex(value.sig, 128) ||
    !Number.isSafeInteger(value.created_at) ||
    (value.created_at as number) < 0 ||
    typeof value.content !== 'string' ||
    !Array.isArray(value.tags) ||
    value.tags.length > TAG_COUNT_MAX
  )
    throw new Error('Signed oracle event is invalid.')
  for (const tag of value.tags) {
    if (!Array.isArray(tag) || tag.length === 0 || tag.length > TAG_ITEMS_MAX)
      throw new Error('Oracle event tags are invalid.')
    for (const item of tag) boundedText(item, TAG_VALUE_BYTES_MAX, 'Oracle event tag is invalid.')
  }
  const event = value as unknown as Event
  if (!verifyEvent(event)) throw new Error('Oracle event signature is invalid.')
  return event
}

export function createOracleExplanationTemplate(
  context: OracleExplanationContext,
  content: string,
  createdAt: number,
): EventTemplate {
  assertOracleExplanationText(content)
  if (!Number.isSafeInteger(createdAt) || createdAt < 0)
    throw new Error('Explanation timestamp is invalid.')
  const { announcement, attestation } = verifiedContext(context)
  return {
    kind: 1111,
    created_at: createdAt,
    content,
    tags: [
      ['E', announcement.id, '', context.oraclePubkey],
      ['K', '88'],
      ['P', context.oraclePubkey],
      ['e', attestation.id, '', context.oraclePubkey],
      ['k', '89'],
      ['p', context.oraclePubkey],
    ],
  }
}

/** NIP-22 is public commentary, not resolution or payout authority. */
export function verifyOracleResolutionExplanation(
  context: OracleExplanationContext,
  explanationEventJson: string,
): Event {
  const { announcement, attestation } = verifiedContext(context)
  const event = readSignedOracleEvent(explanationEventJson, 1111)
  assertOracleExplanationText(event.content)
  if (event.pubkey !== context.oraclePubkey) throw new Error('Explanation signer is foreign.')
  requireReference(event, 'E', announcement.id, context.oraclePubkey)
  requireReference(event, 'e', attestation.id, context.oraclePubkey)
  requirePair(event, 'K', '88')
  requirePair(event, 'k', '89')
  requirePair(event, 'P', context.oraclePubkey)
  requirePair(event, 'p', context.oraclePubkey)
  // Other root/parent reference forms must not introduce a second interpretation.
  if (event.tags.some(([name]) => ['A', 'a', 'I', 'i'].includes(name)))
    throw new Error('Explanation references are ambiguous.')
  return event
}

export function assertOracleExplanationText(value: unknown): asserts value is string {
  boundedText(value, ORACLE_EXPLANATION_UTF8_BYTES_MAX, 'Explanation exceeds its UTF-8 limit.')
  if ((value as string).trim().length === 0) throw new Error('Explanation is empty.')
}

function verifiedContext(context: OracleExplanationContext) {
  if (!lowerHex(context.oraclePubkey, 64)) throw new Error('Registered oracle is invalid.')
  const announcement = readSignedOracleEvent(context.announcementEventJson, 88)
  const attestation = readSignedOracleEvent(context.attestationEventJson, 89)
  if (announcement.pubkey !== context.oraclePubkey || attestation.pubkey !== context.oraclePubkey)
    throw new Error('Resolution signer is foreign.')
  const parents = attestation.tags.filter(([name]) => name === 'e')
  if (parents.length !== 1 || parents[0].length !== 2 || parents[0][1] !== announcement.id)
    throw new Error('Attestation announcement reference is invalid.')
  return { announcement, attestation }
}

function requireReference(event: Event, name: string, id: string, author: string): void {
  const tags = event.tags.filter(([key]) => key === name)
  if (tags.length !== 1 || tags[0].length !== 4 || tags[0][1] !== id || tags[0][3] !== author)
    throw new Error('Explanation event reference is invalid.')
}

function requirePair(event: Event, name: string, value: string): void {
  const tags = event.tags.filter(([key]) => key === name)
  if (tags.length !== 1 || tags[0].length !== 2 || tags[0][1] !== value)
    throw new Error('Explanation author or kind reference is invalid.')
}

function boundedText(value: unknown, max: number, message: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    new TextEncoder().encode(value).length > max
  )
    throw new Error(message)
}

function lowerHex(value: unknown, length: number): value is string {
  return typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
