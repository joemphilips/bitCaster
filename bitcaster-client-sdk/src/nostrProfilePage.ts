import type { Filter } from 'nostr-tools/filter'
import type { Event } from 'nostr-tools/pure'
import { decode as decodeNip19 } from 'nostr-tools/nip19'
import { isPublicDnsName } from './nip05Verification.ts'
import {
  MAX_NOSTR_PROFILE_CONTENT_BYTES,
  MAX_NOSTR_PROFILE_EVENT_BYTES,
  MAX_NOSTR_PROFILE_RELAY_FRAMES,
  MAX_NOSTR_PROFILE_TRANSPORT_BYTES,
  NostrRelayFrameTooLargeError,
  compareNostrProfileEvents,
  readNostrAuthorRelays,
  verifyNostrAuthorEvent,
} from './nostrProfile.ts'
import { normalizeNostrRelayUrls } from './nostrRelays.ts'

/** The transport must reject a frame, a frame count or a byte total above these bounds. */
export interface NostrRelayReadBounds {
  readonly maxFrameBytes: number
  readonly maxFrames: number
  readonly maxTotalBytes: number
}

/**
 * Send one REQ with all filters and settle at EOSE. The transport must reject
 * the read when `onEvent` throws, and must reject with
 * `NostrRelayFrameTooLargeError` for a frame above `maxFrameBytes`.
 */
export type NostrBoundedRelayQuery = (
  relayUrl: string,
  filters: readonly Filter[],
  onEvent: (event: Event) => void,
  bounds: NostrRelayReadBounds,
) => Promise<void>

/** The public profile cache opens at most this many relay sockets for each author. */
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
/** An event dated after now plus this skew is not shown. */
export const MAX_NOSTR_CLOCK_SKEW_SECONDS = 3_600

// Reserve space for an EVENT frame and its maximum 64-character subscription ID.
const FOLLOW_LIST_TRANSPORT_EVENT_BYTES = MAX_NOSTR_FOLLOW_LIST_TRANSPORT_BYTES - 128

/**
 * Each filter keeps its own frame count bound and its event byte bound inside
 * the one REQ. The event bound is the filter's frame bound less the frame envelope.
 */
const PAGE_READS = [
  {
    kind: 0,
    limit: 1,
    maxFrames: MAX_NOSTR_PROFILE_RELAY_FRAMES,
    maxFrameBytes: MAX_NOSTR_PROFILE_TRANSPORT_BYTES,
    contentLimit: MAX_NOSTR_PROFILE_CONTENT_BYTES,
    eventLimit: MAX_NOSTR_PROFILE_EVENT_BYTES,
  },
  {
    kind: 3,
    limit: 1,
    maxFrames: MAX_NOSTR_FOLLOW_LIST_RELAY_FRAMES,
    maxFrameBytes: MAX_NOSTR_FOLLOW_LIST_TRANSPORT_BYTES,
    contentLimit: FOLLOW_LIST_TRANSPORT_EVENT_BYTES,
    eventLimit: FOLLOW_LIST_TRANSPORT_EVENT_BYTES,
  },
  {
    kind: 1,
    limit: MAX_NOSTR_RECENT_NOTES,
    maxFrames: MAX_NOSTR_NOTE_RELAY_FRAMES,
    maxFrameBytes: MAX_NOSTR_PROFILE_TRANSPORT_BYTES,
    contentLimit: MAX_NOSTR_PROFILE_CONTENT_BYTES,
    eventLimit: MAX_NOSTR_PROFILE_EVENT_BYTES,
  },
] as const

/** The one REQ has the sum of the filter bounds. */
const PAGE_BOUNDS: NostrRelayReadBounds = {
  maxFrameBytes: Math.max(...PAGE_READS.map((read) => read.maxFrameBytes)),
  maxFrames: PAGE_READS.reduce((sum, read) => sum + read.maxFrames, 0),
  maxTotalBytes: PAGE_READS.reduce((sum, read) => sum + read.maxFrames * read.maxFrameBytes, 0),
}

// Bidi controls can reorder the visible text, for example to disguise a URL or a name.
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g
const OTHER_CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g
// Zero-width, invisible, tag and Hangul filler characters can make a name look
// empty or like another name.
const INVISIBLE_NAME_CHARACTERS =
  /[\u00AD\u034F\u115F\u1160\u180E\u200B-\u200D\u2060-\u2064\u2800\u3164\uFEFF\uFFA0\u{E0000}-\u{E007F}]/gu
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

/**
 * Untrusted Nostr text for display: no bidi or control characters, bounded by
 * code point. Single-line text also has no invisible characters, so an empty
 * result means that the value has no visible character.
 */
export function sanitizeNostrDisplayText(
  value: unknown,
  maxCharacters: number,
  options: { readonly singleLine?: boolean } = {},
): string {
  if (typeof value !== 'string') return ''
  let text = value.replace(/\r\n?/g, '\n').replace(BIDI_CONTROLS, '')
  text = options.singleLine
    ? text.replace(INVISIBLE_NAME_CHARACTERS, '').replace(/\s+/g, ' ')
    : text
  const characters = Array.from(text.replace(OTHER_CONTROLS, '').trim())
  return characters.length > maxCharacters
    ? `${characters.slice(0, maxCharacters).join('').trimEnd()}…`
    : characters.join('')
}

function safeNostrUrl(value: unknown, protocols: readonly string[]): string | null {
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
    if (!protocols.includes(url.protocol) || url.username || url.password) return null
    return isPublicDnsName(url.hostname) ? url.href : null
  } catch {
    return null
  }
}

/** An absolute http or https link to a public DNS name, without credentials, or null. */
export function safeNostrHttpUrl(value: unknown): string | null {
  return safeNostrUrl(value, ['http:', 'https:'])
}

/**
 * An https image URL on a public DNS name, without credentials, or null. An
 * https page upgrades or blocks an http image, so http gives no fallback.
 */
export function safeNostrImageUrl(value: unknown): string | null {
  return safeNostrUrl(value, ['https:'])
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
    picture: safeNostrImageUrl(record.picture) ?? safeNostrImageUrl(record.image),
    banner: safeNostrImageUrl(record.banner),
    website: safeNostrHttpUrl(record.website),
    nip05: sanitizeNostrDisplayText(record.nip05, MAX_NOSTR_PROFILE_NIP05_CHARACTERS, {
      singleLine: true,
    }),
    createdAt: event.created_at,
  }
}

export type NostrFollowCount =
  | { readonly status: 'counted'; readonly count: number }
  | { readonly status: 'not-found' }
  | { readonly status: 'unknown' }

export interface NostrRecentNote {
  readonly id: string
  /** At most now plus the clock skew, so it is a valid Date. */
  readonly createdAt: number
  readonly content: string
}

export interface NostrProfilePageSnapshot {
  /** The newest verified kind 0. A malformed newest event does not resurrect older metadata. */
  readonly metadata: NostrProfilePageRead
  /**
   * The unique valid `p` tags of the newest verified kind 3. A frame above the
   * size bound can be a newer list, so the count is then unknown.
   */
  readonly follows: NostrFollowCount
  /** The latest verified kind-1 notes, newest first. */
  readonly notes: readonly NostrRecentNote[]
}

function pageRead(value: unknown) {
  const kind = value !== null && typeof value === 'object' ? (value as Event).kind : undefined
  return PAGE_READS.find((read) => read.kind === kind)
}

/**
 * Read kind 0, kind 3 and the latest notes with one REQ for each selected
 * relay. An event dated after now plus the clock skew is dropped, so it cannot
 * replace a current event. At least one relay must complete.
 */
export async function readNostrProfilePage(
  publicKeyHex: string,
  relayUrls: readonly string[],
  query: NostrBoundedRelayQuery,
  nowSeconds: number,
): Promise<NostrProfilePageSnapshot> {
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0)
    throw new Error('Nostr profile page time is invalid.')
  const until = nowSeconds + MAX_NOSTR_CLOCK_SKEW_SECONDS
  // `until` asks a relay not to fill a filter limit with future-dated events.
  const filters = PAGE_READS.map((read) => ({
    kinds: [read.kind],
    authors: [publicKeyHex],
    limit: read.limit,
    until,
  }))
  const newest = new Map<number, Event>()
  const notes = new Map<string, Event>()
  let oversizedFrame = false
  await readNostrAuthorRelays(
    publicKeyHex,
    relayUrls,
    async (url, receive) => {
      const frames = new Map<number, number>()
      try {
        await query(
          url,
          filters,
          (value) => {
            const read = pageRead(value)
            if (!read) return
            const count = (frames.get(read.kind) ?? 0) + 1
            frames.set(read.kind, count)
            if (count > read.maxFrames) throw new Error('Nostr relay sent too many events.')
            receive(value)
          },
          PAGE_BOUNDS,
        )
      } catch (error) {
        if (error instanceof NostrRelayFrameTooLargeError) oversizedFrame = true
        throw error
      }
    },
    (value) => {
      const read = pageRead(value)
      if (!read) return
      const event = verifyNostrAuthorEvent(
        value,
        publicKeyHex,
        read.kind,
        read.contentLimit,
        read.eventLimit,
      )
      if (!event || event.created_at > until) return
      if (read.kind === 1) notes.set(event.id, event)
      else {
        const latest = newest.get(read.kind)
        if (!latest || compareNostrProfileEvents(event, latest) > 0) newest.set(read.kind, event)
      }
    },
  )
  const profile = newest.get(0)
  const metadata = profile ? projectProfilePageMetadata(profile) : null
  return {
    metadata: metadata ? { status: 'found', metadata } : { status: 'not-found' },
    follows: oversizedFrame ? { status: 'unknown' } : countFollows(newest.get(3)),
    notes: [...notes.values()]
      .sort((a, b) => compareNostrProfileEvents(b, a))
      .map((event) => ({
        id: event.id,
        createdAt: event.created_at,
        content: sanitizeNostrDisplayText(event.content, MAX_NOSTR_NOTE_CHARACTERS),
      }))
      .filter((note) => note.content !== '')
      .slice(0, MAX_NOSTR_RECENT_NOTES),
  }
}

function countFollows(latest: Event | undefined): NostrFollowCount {
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
