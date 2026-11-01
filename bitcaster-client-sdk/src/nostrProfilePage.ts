import type { Filter } from 'nostr-tools/filter'
import type { Event } from 'nostr-tools/pure'
import { decode as decodeNip19 } from 'nostr-tools/nip19'
import {
  MAX_NOSTR_PROFILE_CONTENT_BYTES,
  MAX_NOSTR_PROFILE_EVENT_BYTES,
  MAX_NOSTR_PROFILE_RELAY_FRAMES,
  MAX_NOSTR_PROFILE_TRANSPORT_BYTES,
  compareNostrProfileEvents,
  readNostrAuthorRelays,
  verifyNostrAuthorEvent,
} from './nostrProfile.ts'
import { normalizeNostrRelayUrls } from './nostrRelays.ts'

/** The transport must reject a frame or a frame count above these bounds. */
export interface NostrRelayReadBounds {
  readonly maxFrameBytes: number
  readonly maxFrames: number
}

export type NostrBoundedRelayQuery = (
  relayUrl: string,
  filter: Filter,
  onEvent: (event: Event) => void,
  bounds: NostrRelayReadBounds,
) => Promise<void>

/** Public profile reads open at most this many relay sockets for each author. */
export const MAX_NOSTR_PUBLIC_PROFILE_RELAYS = 3
export const MAX_NOSTR_PROFILE_NAME_CHARACTERS = 100
export const MAX_NOSTR_PROFILE_ABOUT_CHARACTERS = 2_000
export const MAX_NOSTR_PROFILE_NIP05_CHARACTERS = 254
export const MAX_NOSTR_PROFILE_URL_CHARACTERS = 2_048
export const MAX_NOSTR_FOLLOW_LIST_EVENT_BYTES = 524_288
// The transport bound is above the count bound, so the reader sees an oversized
// newest list and reports no count instead of counting an older list.
export const MAX_NOSTR_FOLLOW_LIST_TRANSPORT_BYTES = 1_048_576
export const MAX_NOSTR_FOLLOW_LIST_RELAY_FRAMES = 8
export const MAX_NOSTR_RECENT_NOTES = 10
export const MAX_NOSTR_NOTE_RELAY_FRAMES = 32
export const MAX_NOSTR_NOTE_CHARACTERS = 2_000

const PROFILE_BOUNDS: NostrRelayReadBounds = {
  maxFrameBytes: MAX_NOSTR_PROFILE_TRANSPORT_BYTES,
  maxFrames: MAX_NOSTR_PROFILE_RELAY_FRAMES,
}
const FOLLOW_LIST_BOUNDS: NostrRelayReadBounds = {
  maxFrameBytes: MAX_NOSTR_FOLLOW_LIST_TRANSPORT_BYTES,
  maxFrames: MAX_NOSTR_FOLLOW_LIST_RELAY_FRAMES,
}
const NOTE_BOUNDS: NostrRelayReadBounds = {
  maxFrameBytes: MAX_NOSTR_PROFILE_TRANSPORT_BYTES,
  maxFrames: MAX_NOSTR_NOTE_RELAY_FRAMES,
}
// Reserve space for an EVENT frame and its maximum 64-character subscription ID.
const FOLLOW_LIST_TRANSPORT_EVENT_BYTES = MAX_NOSTR_FOLLOW_LIST_TRANSPORT_BYTES - 128

// Bidi controls can reorder the visible text, for example to disguise a URL or a name.
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g
const OTHER_CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g
const HIDDEN_URL_CHARACTERS =
  /[\u0000-\u0020\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/

/** Lowercase hex for a hex or `npub` public key, or null for any other value. */
export function parseNostrPublicKey(value: string): string | null {
  const input = value.trim()
  if (/^[0-9a-f]{64}$/i.test(input)) return input.toLowerCase()
  if (!input.startsWith('npub1')) return null
  try {
    const decoded = decodeNip19(input)
    return decoded.type === 'npub' ? decoded.data : null
  } catch {
    return null
  }
}

export function selectPublicNostrProfileRelays(relayUrls: readonly string[]): string[] {
  return normalizeNostrRelayUrls(relayUrls).slice(0, MAX_NOSTR_PUBLIC_PROFILE_RELAYS)
}

/** Untrusted Nostr text for display: no bidi or control characters, bounded by code point. */
export function sanitizeNostrDisplayText(
  value: unknown,
  maxCharacters: number,
  options: { readonly singleLine?: boolean } = {},
): string {
  if (typeof value !== 'string') return ''
  let text = value.replace(/\r\n?/g, '\n').replace(BIDI_CONTROLS, '')
  text = options.singleLine ? text.replace(/\s+/g, ' ') : text
  const characters = Array.from(text.replace(OTHER_CONTROLS, '').trim())
  return characters.length > maxCharacters
    ? `${characters.slice(0, maxCharacters).join('').trimEnd()}…`
    : characters.join('')
}

/** An absolute http or https URL without credentials, or null. */
export function safeNostrHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const input = value.trim()
  if (
    input.length > MAX_NOSTR_PROFILE_URL_CHARACTERS ||
    HIDDEN_URL_CHARACTERS.test(input) ||
    !/^https?:\/\//i.test(input)
  )
    return null
  try {
    const url = new URL(input)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password || !url.hostname) return null
    return url.href
  } catch {
    return null
  }
}

export interface NostrProfilePageMetadata {
  readonly name: string
  readonly displayName: string
  readonly about: string
  readonly picture: string | null
  readonly banner: string | null
  readonly website: string | null
  /** A kind-0 claim only. It is not proof of control of the address. */
  readonly nip05: string
  readonly createdAt: number
}

export type NostrProfilePageRead =
  | { readonly status: 'found'; readonly metadata: NostrProfilePageMetadata }
  | { readonly status: 'not-found' }

function projectProfilePageMetadata(event: Event): NostrProfilePageMetadata | null {
  let fields: unknown
  try {
    fields = JSON.parse(event.content)
  } catch {
    return null
  }
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) return null
  const record = fields as Record<string, unknown>
  const name = (key: string) =>
    sanitizeNostrDisplayText(record[key], MAX_NOSTR_PROFILE_NAME_CHARACTERS, { singleLine: true })
  const shortName = name('name')
  return {
    name: shortName,
    displayName: name('display_name') || name('displayName') || shortName,
    about: sanitizeNostrDisplayText(record.about, MAX_NOSTR_PROFILE_ABOUT_CHARACTERS),
    picture: safeNostrHttpUrl(record.picture) ?? safeNostrHttpUrl(record.image),
    banner: safeNostrHttpUrl(record.banner),
    website: safeNostrHttpUrl(record.website),
    nip05: sanitizeNostrDisplayText(record.nip05, MAX_NOSTR_PROFILE_NIP05_CHARACTERS, {
      singleLine: true,
    }),
    createdAt: event.created_at,
  }
}

/** Read the newest verified kind 0 from the selected relays for a profile page. */
export async function readNostrProfilePageMetadata(
  publicKeyHex: string,
  relayUrls: readonly string[],
  query: NostrBoundedRelayQuery,
): Promise<NostrProfilePageRead> {
  const latest = await readNewestAuthorEvent(publicKeyHex, relayUrls, query, 0, PROFILE_BOUNDS, {
    contentLimit: MAX_NOSTR_PROFILE_CONTENT_BYTES,
    eventLimit: MAX_NOSTR_PROFILE_EVENT_BYTES,
  })
  // A malformed newest event does not resurrect older metadata.
  const metadata = latest ? projectProfilePageMetadata(latest) : null
  return metadata ? { status: 'found', metadata } : { status: 'not-found' }
}

export type NostrFollowCount =
  | { readonly status: 'counted'; readonly count: number }
  | { readonly status: 'not-found' }
  | { readonly status: 'unknown' }

/** Count the unique valid `p` tags of the newest verified kind 3. */
export async function readNostrFollowCount(
  publicKeyHex: string,
  relayUrls: readonly string[],
  query: NostrBoundedRelayQuery,
): Promise<NostrFollowCount> {
  let latest: Event | null
  try {
    latest = await readNewestAuthorEvent(publicKeyHex, relayUrls, query, 3, FOLLOW_LIST_BOUNDS, {
      contentLimit: FOLLOW_LIST_TRANSPORT_EVENT_BYTES,
      eventLimit: FOLLOW_LIST_TRANSPORT_EVENT_BYTES,
    })
  } catch {
    return { status: 'unknown' }
  }
  if (!latest) return { status: 'not-found' }
  if (
    new TextEncoder().encode(JSON.stringify(latest)).byteLength > MAX_NOSTR_FOLLOW_LIST_EVENT_BYTES
  )
    return { status: 'unknown' }
  const follows = new Set<string>()
  for (const tag of latest.tags)
    if (tag[0] === 'p' && /^[0-9a-f]{64}$/.test(tag[1] ?? '')) follows.add(tag[1]!)
  return { status: 'counted', count: follows.size }
}

export interface NostrRecentNote {
  readonly id: string
  readonly createdAt: number
  readonly content: string
}

/** Read the latest verified kind-1 notes, newest first. */
export async function readNostrRecentNotes(
  publicKeyHex: string,
  relayUrls: readonly string[],
  query: NostrBoundedRelayQuery,
): Promise<NostrRecentNote[]> {
  const notes = new Map<string, Event>()
  const filter = { kinds: [1], authors: [publicKeyHex], limit: MAX_NOSTR_RECENT_NOTES }
  await readNostrAuthorRelays(
    publicKeyHex,
    relayUrls,
    (url, receive) => query(url, filter, receive, NOTE_BOUNDS),
    (value) => {
      const event = verifyNostrAuthorEvent(
        value,
        publicKeyHex,
        1,
        MAX_NOSTR_PROFILE_CONTENT_BYTES,
        MAX_NOSTR_PROFILE_EVENT_BYTES,
      )
      if (event) notes.set(event.id, event)
    },
  )
  return [...notes.values()]
    .sort((a, b) => compareNostrProfileEvents(b, a))
    .map((event) => ({
      id: event.id,
      createdAt: event.created_at,
      content: sanitizeNostrDisplayText(event.content, MAX_NOSTR_NOTE_CHARACTERS),
    }))
    .filter((note) => note.content !== '')
    .slice(0, MAX_NOSTR_RECENT_NOTES)
}

async function readNewestAuthorEvent(
  publicKeyHex: string,
  relayUrls: readonly string[],
  query: NostrBoundedRelayQuery,
  kind: number,
  bounds: NostrRelayReadBounds,
  limits: { readonly contentLimit: number; readonly eventLimit: number },
): Promise<Event | null> {
  let latest: Event | null = null
  const filter = { kinds: [kind], authors: [publicKeyHex], limit: 1 }
  await readNostrAuthorRelays(
    publicKeyHex,
    relayUrls,
    (url, receive) => query(url, filter, receive, bounds),
    (value) => {
      const event = verifyNostrAuthorEvent(
        value,
        publicKeyHex,
        kind,
        limits.contentLimit,
        limits.eventLimit,
      )
      if (event && (!latest || compareNostrProfileEvents(event, latest) > 0)) latest = event
    },
  )
  return latest
}
