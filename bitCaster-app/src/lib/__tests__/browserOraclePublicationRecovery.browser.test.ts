import { beforeEach, expect, it } from "vitest";
import { deriveDlcConditionId } from "@bitcaster/client-sdk";
import { createCreatorMarketsStore } from "@/stores/creatorMarkets";
import { browserOracleBackupValidator, resetKormir } from "@/lib/kormir";
import {
  fixtureOracleCore as getKormir,
  prepareFixtureAnnouncement as prepareEnumAnnouncement,
  prepareFixtureAttestation as prepareEnumAttestation,
  restoreFixtureOracleKey as restoreKormirWithNsec,
} from "@/test/localOracleProvider";
import {
  browserOraclePrivateAuthorityPort,
  reconcileBrowserOraclePublication,
} from "../browserOraclePublicationHandoff";

beforeEach(() => {
  localStorage.clear();
  resetKormir();
});

it("recovers the core's exact attestation after signing stops before its public handoff", async () => {
  await restoreKormirWithNsec("11".repeat(32));
  const eventId = `crash-before-handoff-${crypto.randomUUID()}`;
  const announcement = await prepareEnumAnnouncement(
    [],
    eventId,
    ["YES", "NO"],
    1_800_000_000,
    "Test",
    "Test",
  );
  const event = JSON.parse(announcement.eventJson);
  const binding = {
    conditionId: deriveDlcConditionId({
      eventId,
      outcomeCount: 2,
      oraclePublicKeys: [event.pubkey],
    }),
    oracleEventId: eventId,
    oraclePubkey: event.pubkey,
    outcomes: ["YES", "NO"],
    announcementEventJson: announcement.eventJson,
  };
  const owner = createCreatorMarketsStore();
  await owner.getState().saveCreatedMarket({
    conditionId: binding.conditionId,
    title: "Test",
    thumbnailUrl: null,
    createdAt: "2026-10-06T00:00:00.000Z",
    baseAsset: "sat",
    divisibility: 1000,
    creatorFeePercent: 0,
    oracle: {
      type: "self",
      eventId,
      outcomes: ["YES", "NO"],
      oraclePubkey: event.pubkey,
      announcementHex: announcement.artifactHex,
      announcementEventId: event.id,
      announcementEventJson: announcement.eventJson,
    },
  });
  const choice = {
    binding,
    chosenOutcome: "YES",
    attestation: null,
    relayPublished: false,
    engineEvidence: null,
    explanationEventJson: null,
    explanationRelayPublished: false,
  };
  const core = await getKormir([]);
  const stage = JSON.stringify(choice);
  await core.export_enum_authority(eventId, announcement.eventJson, stage);
  await owner.getState().saveOraclePublication(binding.conditionId, choice);
  await core.acknowledge_enum_publication(eventId, stage);
  const signed = await prepareEnumAttestation([], eventId, "YES", announcement.eventJson);
  resetKormir();
  const reopened = await getKormir([]);
  const result = await owner.getState().withOracleMutation((locked) =>
    reconcileBrowserOraclePublication({
      binding,
      core: browserOraclePrivateAuthorityPort(reopened),
      store: locked,
      validator: browserOracleBackupValidator,
    }),
  );
  expect(result.publication?.attestation?.eventJson === signed.eventJson).toBe(true);
  expect(result.publication?.attestation?.attestationHex === signed.artifactHex).toBe(true);
  expect(await reopened.staged_enum_publication(eventId)).toBeUndefined();
});
