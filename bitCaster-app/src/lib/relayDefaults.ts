import {
  DEFAULT_PUBLIC_NOSTR_RELAYS,
  normalizeNostrRelayUrl,
  selectNostrRelayUrls,
} from "@bitcaster/client-sdk/nostrRelays";
import type { RelayConfig } from "@/types/settings";

export const KNOWN_PUBLIC_NOSTR_RELAYS = DEFAULT_PUBLIC_NOSTR_RELAYS;
export const LOCAL_NOSTR_RELAYS = ["ws://localhost:7777"] as const;

const configured = import.meta.env.VITE_NOSTR_RELAYS as string | undefined;
export const DEFAULT_NOSTR_RELAYS = selectNostrRelayUrls(
  configured === undefined
    ? undefined
    : configured
        .split(",")
        .map((url) => url.trim())
        .filter(Boolean),
  import.meta.env.PROD ? DEFAULT_PUBLIC_NOSTR_RELAYS : LOCAL_NOSTR_RELAYS,
);

export function defaultRelayConfigs(): RelayConfig[] {
  return DEFAULT_NOSTR_RELAYS.map((url) => ({ url, connectionStatus: "disconnected" }));
}

// Invalid saved URLs are excluded without restoring defaults to an explicit list.
export function normalizeRelayConfigs(relays?: RelayConfig[]): RelayConfig[] {
  if (relays === undefined) return defaultRelayConfigs();
  const result: RelayConfig[] = [];
  const seen = new Set<string>();
  for (const relay of relays) {
    try {
      const url = normalizeNostrRelayUrl(relay.url);
      if (seen.has(url)) continue;
      seen.add(url);
      result.push({ ...relay, url });
    } catch {
      // A saved invalid URL must not start a relay connection.
    }
  }
  return result;
}

export function effectiveRelayUrls(relays?: Array<{ url: string }>): string[] {
  return normalizeRelayConfigs(
    relays?.map(({ url }) => ({ url, connectionStatus: "disconnected" })),
  ).map(({ url }) => url);
}
