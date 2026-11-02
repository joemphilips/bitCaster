import {
  readNostrProfilePage,
  selectPublicNostrProfileRelays,
  type NostrBoundedRelayQuery,
} from "@bitcaster/client-sdk/nostrProfilePage";
import {
  readPrimalProfileStats,
  type NostrProfileIndexerStats,
} from "@bitcaster/client-sdk/primalProfileIndexer";
import { verifyNip05Address } from "@bitcaster/client-sdk/nip05Verification";
import { queryBrowserProfileRelayFilters } from "./browserProfileRelay";
import { effectiveRelayUrls } from "./relayDefaults";
import type { RelayConfig } from "@/types/settings";

// The same per-relay time bound as the public profile cache.
const PROFILE_PAGE_RELAY_TIMEOUT_MS = 5_000;

function relayQuery(signal: AbortSignal): NostrBoundedRelayQuery {
  return (url, filters, onEvent, bounds) =>
    queryBrowserProfileRelayFilters(url, filters, onEvent, {
      requireCurrent: () => {},
      signal,
      timeoutMs: PROFILE_PAGE_RELAY_TIMEOUT_MS,
      maxFrameBytes: bounds.maxFrameBytes,
      maxFrames: bounds.maxFrames,
      maxTotalBytes: bounds.maxTotalBytes,
    });
}

/** The profile page reads the same relays as the public profile cache. */
export function profilePageRelayUrls(relays: RelayConfig[]): string[] {
  return selectPublicNostrProfileRelays(effectiveRelayUrls(relays));
}

/** One request to each relay reads the profile, the follow list and the notes. */
export function loadProfilePage(pubkey: string, relays: string[], signal: AbortSignal) {
  return readNostrProfilePage(pubkey, relays, relayQuery(signal), Math.floor(Date.now() / 1000));
}

/** The setting turns the indexer off. A disabled indexer makes no request. */
export function loadProfileIndexerStats(
  pubkey: string,
  enabled: boolean,
  signal: AbortSignal,
): Promise<NostrProfileIndexerStats | null> {
  return enabled ? readPrimalProfileStats(pubkey, { signal }) : Promise.resolve(null);
}

/** The address domain sees the visitor's IP address, as an image host does. */
export function loadNip05Verification(address: string, pubkey: string, signal: AbortSignal) {
  return verifyNip05Address(address, pubkey, { signal });
}
