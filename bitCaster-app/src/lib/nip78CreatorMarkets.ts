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

import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { verifyEvent } from "nostr-tools/pure";
import type { StoredCreatorMarket, StoredCreatorOracleMetadata } from "@/stores/creatorMarkets";
import { withTemporaryRelayNdk, type RelayOperationOptions } from "./nostr";
import {
  readSignedOracleEvent,
  verifyOracleResolutionExplanation,
} from "@bitcaster/client-sdk/oracleResolutionExplanation";
import { retainedOracleAuthority, verifyRetainedOracleAttestation } from "./oracleAttestation";

export const CREATOR_MARKETS_KIND = 30078 as const;
export const CREATOR_MARKETS_D_TAG = "bitcaster:creator-markets" as const;

interface CreatorMarketsPayload {
  markets: StoredCreatorMarket[];
}

/** Publish only public discovery and signed artifacts. Never spread a private creator row. */
export function publicCreatorMarket(market: StoredCreatorMarket): StoredCreatorMarket {
  const oracle = market.oracle;
  let publicOracle: StoredCreatorOracleMetadata | undefined;
  if (oracle) {
    publicOracle = {
      type: "self",
      eventId: oracle.eventId,
      outcomes: [...oracle.outcomes],
      announcementHex: oracle.announcementHex,
      announcementEventId: oracle.announcementEventId,
      announcementEventJson: oracle.announcementEventJson,
    };
    if (oracle.attestationEventJson && oracle.attestationHex && oracle.attestedOutcome) {
      publicOracle.attestationHex = oracle.attestationHex;
      publicOracle.attestationEventJson = oracle.attestationEventJson;
      publicOracle.attestedOutcome = oracle.attestedOutcome;
      publicOracle.attestedAt = oracle.attestedAt;
      publicOracle.explanationEventJson = oracle.explanationEventJson;
    }
  }
  return {
    conditionId: market.conditionId,
    title: market.title,
    thumbnailUrl: market.thumbnailUrl,
    createdAt: market.createdAt,
    baseAsset: market.baseAsset,
    divisibility: market.divisibility,
    creatorFeePercent: market.creatorFeePercent,
    ...(publicOracle ? { oracle: publicOracle } : {}),
  };
}

export function publicCreatorMarketsEqual(
  a: readonly StoredCreatorMarket[],
  b: readonly StoredCreatorMarket[],
): boolean {
  const project = (markets: readonly StoredCreatorMarket[]) =>
    markets.map(publicCreatorMarket).sort((x, y) => x.conditionId.localeCompare(y.conditionId));
  return JSON.stringify(project(a)) === JSON.stringify(project(b));
}

async function verifyPublicCreatorMarket(input: StoredCreatorMarket): Promise<StoredCreatorMarket> {
  const market = publicCreatorMarket(input);
  const oracle = market.oracle;
  if (!oracle?.announcementEventJson) {
    if (oracle) {
      delete oracle.attestationHex;
      delete oracle.attestationEventJson;
      delete oracle.attestedOutcome;
      delete oracle.attestedAt;
      delete oracle.explanationEventJson;
    }
    return market;
  }
  const announcement = readSignedOracleEvent(oracle.announcementEventJson, 88);
  const binding = {
    conditionId: market.conditionId,
    oracleEventId: oracle.eventId,
    oraclePubkey: announcement.pubkey,
    outcomes: oracle.outcomes,
    announcementEventJson: oracle.announcementEventJson,
  };
  if (!oracle.announcementHex)
    throw new Error("Original public announcement bytes are unavailable.");
  await retainedOracleAuthority(binding, { announcementTlvHex: oracle.announcementHex });
  if (announcement.id !== oracle.announcementEventId)
    throw new Error("Public creator announcement is foreign.");
  if (oracle.attestationHex && oracle.attestationEventJson && oracle.attestedOutcome) {
    await verifyRetainedOracleAttestation(
      binding,
      oracle.attestedOutcome,
      {
        attestationHex: oracle.attestationHex,
        eventJson: oracle.attestationEventJson,
      },
      { announcementTlvHex: oracle.announcementHex },
    );
    if (oracle.explanationEventJson) {
      try {
        verifyOracleResolutionExplanation(
          {
            oraclePubkey: announcement.pubkey,
            announcementEventJson: oracle.announcementEventJson,
            attestationEventJson: oracle.attestationEventJson,
          },
          oracle.explanationEventJson,
        );
      } catch {
        delete oracle.explanationEventJson;
      }
    }
  }
  return market;
}

function isStoredCreatorOracle(value: unknown): value is StoredCreatorOracleMetadata {
  if (typeof value !== "object" || value === null) return false;
  const oracle = value as Record<string, unknown>;
  return (
    oracle.type === "self" &&
    typeof oracle.eventId === "string" &&
    (oracle.announcementEventId === undefined || typeof oracle.announcementEventId === "string") &&
    (oracle.announcementHex === undefined || typeof oracle.announcementHex === "string") &&
    Array.isArray(oracle.outcomes) &&
    oracle.outcomes.every((outcome) => typeof outcome === "string") &&
    (oracle.attestationHex === undefined || typeof oracle.attestationHex === "string") &&
    (oracle.attestedOutcome === undefined || typeof oracle.attestedOutcome === "string") &&
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
    m.baseAsset === "sat" &&
    (m.divisibility === 1_000 || m.divisibility === 1_000_000) &&
    typeof m.creatorFeePercent === "number" &&
    Number.isFinite(m.creatorFeePercent) &&
    m.title.length <= 65536 &&
    m.conditionId.length <= 128 &&
    m.createdAt.length <= 64 &&
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
  options: RelayOperationOptions = {},
): Promise<void> {
  const publicMarkets: StoredCreatorMarket[] = [];
  for (const market of markets) publicMarkets.push(await verifyPublicCreatorMarket(market));
  const content = JSON.stringify({ markets: publicMarkets } satisfies CreatorMarketsPayload);
  if (publicMarkets.length > 256 || content.length > 2 * 1024 * 1024)
    throw new Error("Public creator mirror exceeds its bounded payload limit.");
  await withTemporaryRelayNdk(options, new NDKPrivateKeySigner(privateKeyHex), async (ndk) => {
    const event = new NDKEvent(ndk);
    event.kind = CREATOR_MARKETS_KIND;
    event.tags = [["d", CREATOR_MARKETS_D_TAG]];
    event.content = content;

    await event.publishReplaceable();
  });
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
  options: RelayOperationOptions = {},
): Promise<StoredCreatorMarket[] | null> {
  return (
    (await withTemporaryRelayNdk(options, undefined, async (ndk) => {
      const event = await ndk.fetchEvent({
        kinds: [CREATOR_MARKETS_KIND as number],
        authors: [pubkey],
        "#d": [CREATOR_MARKETS_D_TAG],
      });
      if (!event) return null;
      if (
        event.kind !== CREATOR_MARKETS_KIND ||
        event.pubkey !== pubkey ||
        !verifyEvent(event.rawEvent()) ||
        event.tags.filter((tag) => tag[0] === "d").length !== 1 ||
        event.tags.find((tag) => tag[0] === "d")?.[1] !== CREATOR_MARKETS_D_TAG
      )
        return null;
      try {
        if (event.content.length > 2 * 1024 * 1024) return null;
        const parsed = JSON.parse(event.content) as Partial<CreatorMarketsPayload>;
        if (!Array.isArray(parsed.markets) || parsed.markets.length > 256) return null;
        const markets: StoredCreatorMarket[] = [];
        for (const input of parsed.markets.filter(isStoredCreatorMarket)) {
          try {
            markets.push(await verifyPublicCreatorMarket(input));
          } catch {
            /* Invalid public evidence must not replace local recovery state. */
          }
        }
        return markets;
      } catch {
        return null;
      }
    })) ?? null
  );
}
