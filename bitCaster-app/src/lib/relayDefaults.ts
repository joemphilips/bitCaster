import type { RelayConfig } from "@/types/settings";

export const KNOWN_PUBLIC_NOSTR_RELAYS = [
  "wss://nos.lol",
  "wss://nostr.bitcoiner.social",
  "wss://relay.primal.net",
  "wss://relay.nostr.net",
  "wss://relay.damus.io",
  "wss://relay.nostr.band",
  "wss://purplepag.es",
] as const;

/**
 * All environments default to the curated public relay set (ADR-028).
 * Operators can override with VITE_NOSTR_RELAYS for app-owned relays.
 * Users can also configure custom relays in Settings.
 */
export const PRODUCTION_NOSTR_RELAYS = KNOWN_PUBLIC_NOSTR_RELAYS;

export const LOCAL_NOSTR_RELAYS = ["ws://localhost:7777"] as const;

function normalizedRelayUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

function relayOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return null;
    return parsed.origin.toLowerCase();
  } catch {
    return null;
  }
}

function relayHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

const KNOWN_PUBLIC_NOSTR_RELAY_HOSTS = new Set(
  KNOWN_PUBLIC_NOSTR_RELAYS.map((url) => relayHost(url)).filter((host): host is string => !!host),
);

function configuredAllowedRelayOrigins(): string[] {
  const raw = import.meta.env.VITE_NOSTR_ALLOWED_RELAY_ORIGINS as string | undefined;
  return (raw ?? "")
    .split(",")
    .map((url) => relayOrigin(url.trim()) ?? normalizedRelayUrl(url))
    .filter((origin) => origin.length > 0);
}

function isLoopbackRelayUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "ws:" &&
      (parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "[::1]" ||
        parsed.hostname === "::1")
    );
  } catch {
    return false;
  }
}

function isConfiguredAppOwnedRelayUrl(url: string): boolean {
  if (isKnownPublicNostrRelayUrl(url)) return false;
  const origin = relayOrigin(url);
  if (!origin) return false;
  const allowedOrigins = configuredAllowedRelayOrigins();
  if (allowedOrigins.length > 0) return allowedOrigins.includes(origin);
  return !import.meta.env.PROD && isLoopbackRelayUrl(url);
}

function configuredDefaultRelays(): string[] {
  const raw = import.meta.env.VITE_NOSTR_RELAYS as string | undefined;
  if (raw !== undefined) {
    return raw
      .split(",")
      .map((url) => url.trim())
      .filter((url) => url.length > 0)
      .filter(isConfiguredAppOwnedRelayUrl);
  }
  if (!import.meta.env.PROD) {
    return [...LOCAL_NOSTR_RELAYS];
  }
  return [...PRODUCTION_NOSTR_RELAYS];
}

export const DEFAULT_NOSTR_RELAYS = configuredDefaultRelays();

export function defaultRelayConfigs(): RelayConfig[] {
  return DEFAULT_NOSTR_RELAYS.map((url) => ({
    url,
    connectionStatus: "disconnected",
  }));
}

export function isKnownPublicNostrRelayUrl(url: string): boolean {
  const host = relayHost(url);
  if (!host) return false;
  return KNOWN_PUBLIC_NOSTR_RELAY_HOSTS.has(host);
}

export function isAllowedNostrRelayUrl(url: string): boolean {
  const normalized = normalizedRelayUrl(url);
  if (DEFAULT_NOSTR_RELAYS.some((relay) => normalizedRelayUrl(relay) === normalized)) {
    return true;
  }

  if (isKnownPublicNostrRelayUrl(url)) return false;

  return isConfiguredAppOwnedRelayUrl(url);
}

export function removeRetiredPublicDefaultRelays(relays?: RelayConfig[]): RelayConfig[] {
  if (relays === undefined) return defaultRelayConfigs();

  const filtered = relays.filter((relay) => isAllowedNostrRelayUrl(relay.url));
  return filtered;
}

export function effectiveRelayUrls(relays?: Array<{ url: string }>): string[] {
  return removeRetiredPublicDefaultRelays(
    relays?.map((relay) => ({
      url: relay.url,
      connectionStatus: "disconnected" as const,
    })),
  ).map((relay) => relay.url);
}
