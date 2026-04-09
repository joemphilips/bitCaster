/**
 * Event ID helpers for DLC oracle events.
 *
 * The DLC spec (dlcspecs/Oracle.md) defines `event_id` as a free-form
 * identifier string that must be unique for a given oracle. bitCaster derives
 * the event_id from the human-readable market title so the oracle's event log
 * stays browsable: e.g. "What is the Bitcoin Price?" -> "what_is_the_bitcoin_price".
 *
 * The slug is intentionally narrow (lowercase ASCII letters, digits, and
 * underscores) so that it round-trips cleanly through URLs, Nostr events, and
 * filesystems without escaping. A short random suffix is appended so that two
 * markets with identical titles do not collide in the oracle's event store.
 */

const MAX_SLUG_LENGTH = 64

/**
 * Convert a free-form title into a safe DLC event_id slug.
 *
 * - Lowercases the input
 * - Replaces any run of non-alphanumeric characters with a single underscore
 * - Trims leading/trailing underscores
 * - Truncates to `MAX_SLUG_LENGTH` characters
 *
 * Returns an empty string if the title contains no usable characters; callers
 * must handle that case (typically by falling back to a generated identifier).
 */
export function slugifyEventTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
}

/**
 * Build a DLC event_id from a market title. When the slug would be empty
 * (e.g. a title written entirely in non-latin characters that did not survive
 * normalization), fall back to a fixed prefix so the oracle still produces a
 * valid identifier.
 *
 * A short hex suffix (derived from `crypto.getRandomValues`) is appended to
 * avoid collisions between markets that share a title.
 */
export function buildEventId(title: string): string {
  const base = slugifyEventTitle(title) || 'market'
  const suffix = randomHexSuffix(6)
  // Leave room for "_" + suffix while staying under MAX_SLUG_LENGTH.
  const maxBase = MAX_SLUG_LENGTH - suffix.length - 1
  const trimmed = base.length > maxBase ? base.slice(0, maxBase) : base
  return `${trimmed}_${suffix}`
}

function randomHexSuffix(bytes: number): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}
