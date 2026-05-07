import type { RelayConfig } from '@/types/settings'

export const PRODUCTION_NOSTR_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.bitcoiner.social',
] as const

export function defaultRelayConfigs(): RelayConfig[] {
  return PRODUCTION_NOSTR_RELAYS.map((url) => ({
    url,
    connectionStatus: 'disconnected',
  }))
}
