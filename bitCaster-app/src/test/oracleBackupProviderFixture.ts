import { deriveDlcConditionId, type OracleBackupRecord } from "@bitcaster/client-sdk";
import { createCreatorMarketsStore } from "@/stores/creatorMarkets";
import { creatorMarketFixture } from "./creatorOracleFixture";
import {
  getKormir,
  restoreKormirWithNsec,
  prepareEnumAnnouncement,
  prepareEnumAttestation,
} from "@/lib/kormir";
import { importBrowserOracleBackup } from "@/lib/browserOracleBackup";

export async function fixture() {
  await restoreKormirWithNsec("11".repeat(32));
  const eventId = `backup-owner-${crypto.randomUUID()}`;
  const prepared = await prepareEnumAnnouncement(
    [],
    eventId,
    ["YES", "NO"],
    1_800_000_000,
    "Test",
    "Test",
  );
  const event = JSON.parse(prepared.eventJson);
  const binding = {
    conditionId: deriveDlcConditionId({
      eventId,
      outcomeCount: 2,
      oraclePublicKeys: [event.pubkey],
    }),
    oracleEventId: eventId,
    oraclePubkey: event.pubkey,
    outcomes: ["YES", "NO"],
    announcementEventJson: prepared.eventJson,
  };
  const core = await getKormir([]);
  const record: OracleBackupRecord = {
    schemaVersion: 1,
    conditionId: binding.conditionId,
    oraclePubkey: event.pubkey,
    oracleEventId: eventId,
    authority: JSON.parse(await core.export_enum_authority(eventId, prepared.eventJson)),
    destinations: {
      mintUrl: "https://mint.original.example",
      engineUrl: "https://engine.original.example",
      relayUrls: ["wss://relay.original.example"],
    },
  };
  return { record, binding, prepared, core };
}

export async function deliveryOwner(
  kind: "created" | "imported",
  f: Awaited<ReturnType<typeof fixture>>,
) {
  const owner = createCreatorMarketsStore();
  if (kind === "imported") await importBrowserOracleBackup(f.record, owner);
  else
    await owner.getState().addCreatedMarket({
      ...creatorMarketFixture(f.record.conditionId),
      oracle: {
        type: "self",
        eventId: f.record.oracleEventId,
        announcementEventId: JSON.parse(f.prepared.eventJson).id,
        announcementEventJson: f.prepared.eventJson,
        announcementHex: f.prepared.artifactHex,
        oraclePubkey: f.record.oraclePubkey,
        outcomes: ["YES", "NO"],
        destinations: f.record.destinations,
      },
    });
  return owner;
}

export async function saveRelayConfirmedResult(
  f: Awaited<ReturnType<typeof fixture>>,
  owner: ReturnType<typeof createCreatorMarketsStore>,
) {
  const signed = await prepareEnumAttestation(
    [],
    f.record.oracleEventId,
    "YES",
    f.prepared.eventJson,
  );
  await owner.getState().saveOraclePublication(f.record.conditionId, {
    binding: f.binding,
    chosenOutcome: "YES",
    attestation: { attestationHex: signed.artifactHex, eventJson: signed.eventJson },
    relayPublished: true,
    engineEvidence: null,
    explanationEventJson: null,
    explanationRelayPublished: false,
  });
  return signed;
}
