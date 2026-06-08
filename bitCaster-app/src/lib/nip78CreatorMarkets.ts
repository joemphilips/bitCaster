/**
 * NIP-78 creator-markets sync for bitCaster.
 *
 * Stores the set of markets the user has created as a parameterized
 * replaceable event (kind 30078, d-tag "bitcaster:creator-markets") so the
 * creator dashboard follows the user across devices. This is a UX mirror, not
 * a privacy boundary; creator-market discovery may also move to engine-side
 * indexing because the creator pubkey is public oracle metadata.
 *
 * Spec: https://github.com/nostr-protocol/nips/blob/master/78.md
 */

import NDK, { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import type {
  StoredCreatorMarket,
  StoredCreatorOracleMetadata,
} from "@/stores/creatorMarkets";
import { DEFAULT_RELAYS } from "./nostr";

export const CREATOR_MARKETS_KIND = 30078 as const;
export const CREATOR_MARKETS_D_TAG = "bitcaster:creator-markets" as const;

interface CreatorMarketsPayload {
  markets: StoredCreatorMarket[];
}

function isStoredCreatorOracle(
  value: unknown,
): value is StoredCreatorOracleMetadata {
  if (typeof value !== "object" || value === null) return false;
  const oracle = value as Record<string, unknown>;
  return (
    oracle.type === "self" &&
    typeof oracle.eventId === "string" &&
    (oracle.announcementEventId === undefined ||
      typeof oracle.announcementEventId === "string") &&
    Array.isArray(oracle.outcomes) &&
    oracle.outcomes.every((outcome) => typeof outcome === "string") &&
    (oracle.attestationHex === undefined ||
      typeof oracle.attestationHex === "string") &&
    (oracle.attestedOutcome === undefined ||
      typeof oracle.attestedOutcome === "string") &&
    (oracle.attestedAt === undefined || typeof oracle.attestedAt === "string")
  );
}

function isStoredCreatorMarket(value: unknown): value is StoredCreatorMarket {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.conditionId === "string" &&
    typeof m.title === "string" &&
    (m.thumbnailUrl === null || typeof m.thumbnailUrl === "string") &&
    typeof m.createdAt === "string" &&
    typeof m.creatorFeePercent === "number" &&
    (m.oracle === undefined || isStoredCreatorOracle(m.oracle))
  );
}

/**
 * Publish the user's current created-markets set as a NIP-78 replaceable
 * event. Uses a short-lived NDK instance so we don't keep extra relay
 * connections open on the shared singleton.
 */
export async function publishNip78CreatorMarkets(
  privateKeyHex: string,
  markets: StoredCreatorMarket[],
): Promise<void> {
  const ndk = new NDK({
    explicitRelayUrls: DEFAULT_RELAYS,
    signer: new NDKPrivateKeySigner(privateKeyHex),
  });
  await ndk.connect();

  const event = new NDKEvent(ndk);
  event.kind = CREATOR_MARKETS_KIND;
  event.tags = [["d", CREATOR_MARKETS_D_TAG]];
  event.content = JSON.stringify({ markets } satisfies CreatorMarketsPayload);

  try {
    await event.publishReplaceable();
  } finally {
    for (const relay of ndk.pool.relays.values()) {
      relay.disconnect();
    }
  }
}

/**
 * Fetch the most recent creator-markets event for a pubkey.
 *
 * Returns `null` if no event exists or the content cannot be parsed. Entries
 * that fail validation are dropped individually rather than failing the whole
 * fetch so a malformed record in the relay doesn't wipe the local state.
 */
export async function fetchNip78CreatorMarkets(
  pubkey: string,
): Promise<StoredCreatorMarket[] | null> {
  const ndk = new NDK({ explicitRelayUrls: DEFAULT_RELAYS });
  await ndk.connect();

  try {
    const event = await ndk.fetchEvent({
      kinds: [CREATOR_MARKETS_KIND as number],
      authors: [pubkey],
      "#d": [CREATOR_MARKETS_D_TAG],
    });
    if (!event) return null;
    try {
      const parsed = JSON.parse(
        event.content,
      ) as Partial<CreatorMarketsPayload>;
      if (!Array.isArray(parsed.markets)) return null;
      return parsed.markets.filter(isStoredCreatorMarket);
    } catch {
      return null;
    }
  } finally {
    for (const relay of ndk.pool.relays.values()) {
      relay.disconnect();
    }
  }
}
