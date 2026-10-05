import { deriveDlcConditionId } from "@bitcaster/client-sdk";
import type { OraclePublicationRecord } from "@bitcaster/client-sdk/oraclePublication";
import type { BrowserOracleImportMetadata, StoredCreatorMarket } from "@/stores/creatorMarkets";
import fixture from "@/lib/__tests__/fixtures/oraclePublication.json";

export const creatorOracleMetadata: BrowserOracleImportMetadata = {
  binding: {
    conditionId: deriveDlcConditionId({
      eventId: fixture.eventId,
      outcomeCount: 2,
      oraclePublicKeys: [fixture.oraclePubkey],
    }),
    oracleEventId: fixture.eventId,
    oraclePubkey: fixture.oraclePubkey,
    outcomes: ["YES", "NO"],
    announcementEventJson: fixture.announcementEventJson,
  },
  announcementHex: fixture.announcementHex,
  destinations: {
    mintUrl: "https://original-mint.example",
    engineUrl: "https://original-engine.example",
    relayUrls: ["wss://original-relay.example"],
  },
};
export const creatorOraclePublication: OraclePublicationRecord = {
  binding: creatorOracleMetadata.binding,
  chosenOutcome: "YES",
  attestation: { attestationHex: fixture.attestationHex, eventJson: fixture.attestationEventJson },
  relayPublished: false,
  engineEvidence: null,
  explanationEventJson: null,
  explanationRelayPublished: false,
};
export function creatorMarketFixture(conditionId = "a".repeat(64)): StoredCreatorMarket {
  return {
    conditionId,
    title: "Original title",
    thumbnailUrl: null,
    createdAt: "2026-10-06T00:00:00.000Z",
    baseAsset: "sat",
    divisibility: 1000,
    creatorFeePercent: 0.02,
  };
}
