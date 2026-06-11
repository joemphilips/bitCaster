import type { RelayConfig } from '@/types/settings'

/**
 * NDK publishes to **all** relays in the pool concurrently via
 * `event.publish()` / `event.publishReplaceable()` — every relay in this list
 * receives the event in parallel rather than in series.  Ordering here does
 * not change publish latency; it only affects which relay an NDK subscription
 * prefers for fetching when multiple relays return the same event.
 *
 * Relays are ordered by staging-verified reliability for kind-88 DLC oracle
 * events.  relay.damus.io is kept as a last-resort fallback: it is listed on
 * the Nostr relay directory and reaches a large audience, but exhibits
 * intermittent TLS connection resets in staging.
 */
export const PRODUCTION_NOSTR_RELAYS = [
  'wss://nos.lol',
  'wss://nostr.bitcoiner.social',
  'wss://relay.primal.net',
  'wss://relay.nostr.net',
  'wss://relay.damus.io', // fallback — flaky TLS resets observed in staging
] as const

export function defaultRelayConfigs(): RelayConfig[] {
  return PRODUCTION_NOSTR_RELAYS.map((url) => ({
    url,
    connectionStatus: 'disconnected',
  }))
}
