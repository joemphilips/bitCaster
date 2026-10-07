import type { Filter } from 'nostr-tools/filter'
import { validateEvent, verifyEvent, type Event, type EventTemplate } from 'nostr-tools/pure'
import { normalizeNostrRelayUrls } from './nostrRelays.ts'

export interface NostrPublicProfile {
  readonly pubkey: string
  readonly displayName: string
  readonly avatar: string
  readonly nip05: string
  readonly nip05verified: false
  readonly bio: string
  readonly eventId: string
  readonly createdAt: number
}

export interface NostrProfileReadResult {
  readonly status: 'found' | 'not-found'
  readonly profile: NostrPublicProfile | null
  readonly completedRelayCount: number
  readonly failedRelayCount: number
}

export type NostrProfileQuery = (
  relayUrl: string,
  filter: Filter,
  onEvent: (event: Event) => void,
) => Promise<void>

export const MAX_NOSTR_PROFILE_CONTENT_BYTES = 65_536
export const MAX_NOSTR_PROFILE_TRANSPORT_BYTES = 131_072
export const MAX_NOSTR_PROFILE_RELAY_FRAMES = 64
// Reserve space for an EVENT frame and its maximum 64-character subscription ID.
export const MAX_NOSTR_PROFILE_EVENT_BYTES = MAX_NOSTR_PROFILE_TRANSPORT_BYTES - 128

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function verifiedProfileEvent(
  value: unknown,
  publicKeyHex: string,
  contentLimit = MAX_NOSTR_PROFILE_CONTENT_BYTES,
  eventLimit = MAX_NOSTR_PROFILE_EVENT_BYTES,
): Event | null {
  try {
    if (value === null || typeof value !== 'object') return null
    const event = value as Event
    if (
      !Array.isArray(event.tags) ||
      event.tags.some((tag) => !Array.isArray(tag) || tag.some((part) => typeof part !== 'string'))
    )
      return null
    // Do not inherit nostr-tools' cached verification symbol from a caller's object.
    const signed = {
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: Array.from(event.tags, (tag) => Array.from(tag)),
      content: event.content,
      sig: event.sig,
    }
    // validateEvent uses a realm-specific instanceof check. Validate the owned
    // envelope so a valid NIP-07 response from another realm can still verify.
    if (
      !validateEvent(signed) ||
      signed.kind !== 0 ||
      signed.pubkey !== publicKeyHex ||
      !Number.isSafeInteger(signed.created_at) ||
      signed.created_at < 0 ||
      new TextEncoder().encode(signed.content).byteLength > contentLimit
    )
      return null
    return jsonBytes(signed) <= eventLimit && verifyEvent(signed) ? signed : null
  } catch {
    return null
  }
}

/** A positive result means that a replaces b under NIP-01 ordering. */
export function compareNostrProfileEvents(a: Event, b: Event): number {
  if (a.created_at !== b.created_at) return a.created_at > b.created_at ? 1 : -1
  if (a.id === b.id) return 0
  return a.id < b.id ? 1 : -1
}

function objectMetadata(event: Event | null): Record<string, unknown> | null {
  if (
    !event ||
    jsonBytes(event) > MAX_NOSTR_PROFILE_EVENT_BYTES ||
    new TextEncoder().encode(event.content).byteLength > MAX_NOSTR_PROFILE_CONTENT_BYTES
  )
    return null
  try {
    const value: unknown = JSON.parse(event.content)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export function decodeNostrProfileEvent(
  value: unknown,
  publicKeyHex: string,
): NostrPublicProfile | null {
  const event = verifiedProfileEvent(value, publicKeyHex)
  if (!event) return null
  try {
    const fields = objectMetadata(event)
    if (!fields) return null
    const text = (key: string): string | undefined =>
      typeof fields[key] === 'string' ? (fields[key] as string) : undefined
    return {
      pubkey: publicKeyHex,
      displayName:
        text('display_name') ?? text('displayName') ?? text('name') ?? publicKeyHex.slice(0, 8),
      avatar: text('picture') ?? text('image') ?? '',
      nip05: text('nip05') ?? '',
      // A kind-0 claim is not proof of control of the NIP-05 address.
      nip05verified: false,
      bio: text('bio') ?? text('about') ?? '',
      eventId: event.id,
      createdAt: event.created_at,
    }
  } catch {
    return null
  }
}

/** Each read queries only the selected relays. It has no persistent metadata cache. */
export async function readNostrProfile(
  publicKeyHex: string,
  relayUrls: readonly string[],
  query: NostrProfileQuery,
): Promise<NostrProfileReadResult> {
  const { latest, completedRelayCount, failedRelayCount } = await queryProfileEvents(
    publicKeyHex,
    relayUrls,
    query,
    MAX_NOSTR_PROFILE_CONTENT_BYTES,
  )
  const profile = decodeNostrProfileEvent(latest, publicKeyHex)
  return { status: profile ? 'found' : 'not-found', profile, completedRelayCount, failedRelayCount }
}

async function queryProfileEvents(
  publicKeyHex: string,
  relayUrls: readonly string[],
  query: NostrProfileQuery,
  contentLimit: number,
  eventLimit = MAX_NOSTR_PROFILE_EVENT_BYTES,
): Promise<{ latest: Event | null; completedRelayCount: number; failedRelayCount: number }> {
  if (!/^[0-9a-f]{64}$/.test(publicKeyHex)) throw new Error('Nostr profile public key is invalid.')
  const relays = normalizeNostrRelayUrls(relayUrls)
  if (relays.length === 0)
    throw new Error('Configure a Nostr relay before reading the signer profile.')
  let latest: Event | null = null
  let completedRelayCount = 0
  let failedRelayCount = 0
  await Promise.all(
    relays.map(async (url) => {
      let active = true
      try {
        await query(url, { kinds: [0], authors: [publicKeyHex], limit: 1 }, (value) => {
          if (!active) return
          const event = verifiedProfileEvent(value, publicKeyHex, contentLimit, eventLimit)
          if (event && (!latest || compareNostrProfileEvents(event, latest) > 0)) latest = event
        })
        completedRelayCount += 1
      } catch {
        failedRelayCount += 1
      } finally {
        active = false
      }
    }),
  )
  if (completedRelayCount === 0)
    throw new Error('Nostr profile read failed. Check the configured relays and retry.')
  return { latest, completedRelayCount, failedRelayCount }
}

export interface NostrProfilePatch {
  readonly name?: string
  readonly about?: string
  readonly picture?: string
}

export interface NostrProfileEditSnapshot {
  readonly status: 'absent' | 'usable' | 'unusable'
  /** The signed content is the edit authority. Metadata is only a display projection. */
  readonly event: Event | null
  readonly metadata: Record<string, unknown> | null
  readonly completedRelayCount: number
  readonly failedRelayCount: number
}

export async function readNostrProfileEditSnapshot(
  publicKeyHex: string,
  relayUrls: readonly string[],
  query: NostrProfileQuery,
): Promise<NostrProfileEditSnapshot> {
  const {
    latest: event,
    completedRelayCount,
    failedRelayCount,
  } = await queryProfileEvents(
    publicKeyHex,
    relayUrls,
    query,
    MAX_NOSTR_PROFILE_TRANSPORT_BYTES,
    MAX_NOSTR_PROFILE_TRANSPORT_BYTES,
  )
  const metadata = objectMetadata(event)
  return {
    status: event ? (metadata ? 'usable' : 'unusable') : 'absent',
    event,
    metadata,
    completedRelayCount,
    failedRelayCount,
  }
}

/** Validate retained public records on every storage read. */
export function decodeNostrProfileEditEvent(value: unknown, publicKeyHex: string): Event | null {
  const event = verifiedProfileEvent(value, publicKeyHex)
  return objectMetadata(event) ? event : null
}

/** Call inside the consumer's identity-specific save lock after fresh relay reads. */
export function selectNostrProfileEditBase(
  publicKeyHex: string,
  snapshot: NostrProfileEditSnapshot,
  retained: unknown | null,
): Event | null {
  if (snapshot.completedRelayCount < 1 || snapshot.failedRelayCount !== 0)
    throw new Error('Nostr profile edit requires completed reads from all selected relays.')
  const saved = retained === null ? null : decodeNostrProfileEditEvent(retained, publicKeyHex)
  if (retained !== null && !saved) throw new Error('Retained Nostr profile edit base is invalid.')
  const fresh =
    snapshot.event === null
      ? null
      : verifiedProfileEvent(
          snapshot.event,
          publicKeyHex,
          MAX_NOSTR_PROFILE_TRANSPORT_BYTES,
          MAX_NOSTR_PROFILE_TRANSPORT_BYTES,
        )
  if (snapshot.event !== null && !fresh)
    throw new Error('Fresh Nostr profile edit base is invalid.')
  const selected = saved && (!fresh || compareNostrProfileEvents(saved, fresh) > 0) ? saved : fresh
  if (selected && !objectMetadata(selected))
    throw new Error('Newest Nostr profile metadata is unusable. Edit it with another client first.')
  return selected
}

const editableFields = ['name', 'about', 'picture'] as const

/** Validate CLI dry-run input without loading a signer or contacting relays. */
export function validateNostrProfilePatch(value: unknown): NostrProfilePatch {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Nostr profile patch is invalid.')
  const patch = value as Record<string, unknown>
  const keys = Object.keys(patch)
  if (keys.length === 0 || keys.some((key) => !editableFields.some((field) => field === key)))
    throw new Error('Nostr profile patch must supply name, about, or picture strings.')
  for (const key of keys)
    if (typeof patch[key] !== 'string')
      throw new Error('Nostr profile patch must supply name, about, or picture strings.')
  const copy = Object.fromEntries(keys.map((key) => [key, patch[key]])) as NostrProfilePatch
  if (new TextEncoder().encode(JSON.stringify(copy)).byteLength > MAX_NOSTR_PROFILE_CONTENT_BYTES)
    throw new Error('Nostr profile patch exceeds the content size limit.')
  return copy
}

function jsonValueEnd(content: string, start: number): number {
  let depth = 0
  let quoted = false
  for (let i = start; i < content.length; i += 1) {
    const char = content[i]
    if (quoted) {
      if (char === '\\') i += 1
      else if (char === '"') quoted = false
    } else {
      if (char === '"') quoted = true
      else if (char === '{' || char === '[') depth += 1
      else if (char === '}' || char === ']') {
        if (depth === 0) return i
        depth -= 1
      } else if (char === ',' && depth === 0) return i
    }
  }
  return content.length
}

function patchMetadataContent(content: string, patch: NostrProfilePatch): string {
  const edits: { start: number; end: number; value: string }[] = []
  const seen = new Set<string>()
  let cursor = content.indexOf('{') + 1
  while (cursor < content.length) {
    while (/\s/.test(content[cursor] ?? '')) cursor += 1
    if (content[cursor] === '}') break
    const keyStart = cursor++
    while (content[cursor] !== '"') {
      if (content[cursor] === '\\') cursor += 1
      cursor += 1
    }
    const key = JSON.parse(content.slice(keyStart, ++cursor)) as string
    while (content[cursor] !== ':') cursor += 1
    const start = ++cursor
    cursor = jsonValueEnd(content, start)
    if (Object.hasOwn(patch, key)) {
      edits.push({
        start,
        end: cursor,
        value: JSON.stringify(patch[key as keyof NostrProfilePatch]),
      })
      seen.add(key)
    }
    if (content[cursor] === ',') cursor += 1
    else break
  }
  const missing = editableFields.filter((key) => Object.hasOwn(patch, key) && !seen.has(key))
  if (missing.length) {
    const hasFields = Object.keys(JSON.parse(content) as object).length > 0
    edits.push({
      start: cursor,
      end: cursor,
      value: `${hasFields ? ',' : ''}${missing.map((key) => `${JSON.stringify(key)}:${JSON.stringify(patch[key])}`).join(',')}`,
    })
  }
  for (const edit of edits.reverse())
    content = content.slice(0, edit.start) + edit.value + content.slice(edit.end)
  return content
}

export function prepareNostrProfileEdit(
  publicKeyHex: string,
  base: Event | null,
  value: NostrProfilePatch,
  nowSeconds: number,
): EventTemplate {
  if (!/^[0-9a-f]{64}$/.test(publicKeyHex)) throw new Error('Nostr profile public key is invalid.')
  const patch = validateNostrProfilePatch(value)
  const previous = base === null ? null : decodeNostrProfileEditEvent(base, publicKeyHex)
  if (base !== null && !previous) throw new Error('Nostr profile edit base is invalid.')
  const created_at = Math.max(nowSeconds, previous ? previous.created_at + 1 : 0)
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0 || !Number.isSafeInteger(created_at))
    throw new Error('Nostr profile edit timestamp is invalid.')
  const content = patchMetadataContent(previous?.content ?? '{}', patch)
  if (new TextEncoder().encode(content).byteLength > MAX_NOSTR_PROFILE_CONTENT_BYTES)
    throw new Error('Nostr profile edit exceeds the content size limit.')
  const template = { kind: 0, created_at, tags: [] as string[][], content }
  const envelope = { ...template, pubkey: publicKeyHex, id: '0'.repeat(64), sig: '0'.repeat(128) }
  if (jsonBytes(envelope) > MAX_NOSTR_PROFILE_EVENT_BYTES)
    throw new Error('Nostr profile edit exceeds the event size limit.')
  return template
}

export function validateSignedNostrProfileEdit(
  value: unknown,
  publicKeyHex: string,
  expected: EventTemplate,
): Event {
  const event = decodeNostrProfileEditEvent(value, publicKeyHex)
  if (
    !event ||
    expected.kind !== 0 ||
    event.kind !== expected.kind ||
    event.content !== expected.content ||
    event.created_at !== expected.created_at ||
    JSON.stringify(event.tags) !== JSON.stringify(expected.tags)
  )
    throw new Error('Nostr profile signer returned an invalid or altered event.')
  return event
}

export async function signNostrProfileEdit(
  publicKeyHex: string,
  template: EventTemplate,
  signer: (event: EventTemplate) => Promise<unknown>,
): Promise<Event> {
  const expected = { ...template, tags: template.tags.map((tag) => [...tag]) }
  const request = { ...expected, tags: expected.tags.map((tag) => [...tag]) }
  return validateSignedNostrProfileEdit(await signer(request), publicKeyHex, expected)
}

/** An absent or invalid OK frame leaves delivery uncertain. Never expose the relay's text. */
export function decodeNostrProfileAcknowledgment(
  frame: unknown,
  eventId: string,
): 'accepted' | 'rejected' | null {
  if (
    !Array.isArray(frame) ||
    frame.length !== 4 ||
    frame[0] !== 'OK' ||
    frame[1] !== eventId ||
    typeof frame[2] !== 'boolean' ||
    typeof frame[3] !== 'string'
  )
    return null
  return frame[2] ? 'accepted' : 'rejected'
}
