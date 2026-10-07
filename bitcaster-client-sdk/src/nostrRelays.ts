/** Curated public defaults from ADR-028. An explicit list replaces these defaults. */
export const DEFAULT_PUBLIC_NOSTR_RELAYS = [
  'wss://nos.lol',
  'wss://nostr.bitcoiner.social',
  'wss://relay.primal.net',
  'wss://relay.nostr.net',
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://purplepag.es',
] as const

/** Normalize a relay URL without changing path or query case. */
export function normalizeNostrRelayUrl(value: string): string {
  const input = value.trim()
  const authority = /^wss?:\/\/([^/?#]+)/i.exec(input)?.[1]
  if (!authority || input.includes('\\') || /[\u0000-\u0020\u007f]/.test(input)) {
    throw new Error('Relay URL must start with wss:// or local ws://')
  }
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    throw new Error('Relay URL must start with wss:// or local ws://')
  }
  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
    throw new Error('Relay URL must start with wss:// or local ws://')
  }
  if (authority.includes('@') || parsed.username || parsed.password || input.includes('#')) {
    throw new Error('Relay URL must not contain credentials or a fragment')
  }
  // Check the supplied authority, not only URL.hostname: URL parsing accepts
  // aliases such as 127.1 and converts them to 127.0.0.1.
  if (
    parsed.protocol === 'ws:' &&
    !/^(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/i.test(authority)
  ) {
    throw new Error('Plain ws:// relay URLs require exact loopback hosts')
  }
  const normalized = parsed.toString()
  return parsed.pathname === '/' && parsed.search === ''
    ? normalized.replace(/\/$/, '')
    : normalized
}

/** Normalize and deduplicate exact URLs, not origins. */
export function normalizeNostrRelayUrls(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeNostrRelayUrl))]
}

/** Missing configuration uses defaults. An explicit empty list stays empty. */
export function selectNostrRelayUrls(
  configured: readonly string[] | undefined,
  defaults: readonly string[] = DEFAULT_PUBLIC_NOSTR_RELAYS,
): string[] {
  return normalizeNostrRelayUrls(configured ?? defaults)
}
