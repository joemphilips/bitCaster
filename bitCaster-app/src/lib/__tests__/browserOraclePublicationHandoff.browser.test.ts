import { beforeEach, expect, it } from "vitest";
import { deriveDlcConditionId } from "@bitcaster/client-sdk";
import type { OraclePublicationRecord } from "@bitcaster/client-sdk/oraclePublication";
import { createCreatorMarketsStore, type BrowserOracleLockedPort } from "@/stores/creatorMarkets";
import {
  browserOracleBackupValidator,
  getKormir,
  prepareEnumAnnouncement,
  prepareEnumAttestation,
  resetKormir,
  restoreKormirWithNsec,
} from "../kormir";
import {
  browserOraclePrivateAuthorityPort,
  reconcileBrowserOraclePublication as reconcile,
} from "../browserOraclePublicationHandoff";

function reconcileBrowserOraclePublication(
  input: Omit<Parameters<typeof reconcile>[0], "store"> & {
    store: Parameters<typeof reconcile>[0]["store"] & {
      withMutation<T>(action: (locked: BrowserOracleLockedPort) => Promise<T>): Promise<T>;
    };
  },
) {
  return input.store.withMutation((locked) => reconcile({ ...input, store: locked }));
}

beforeEach(() => {
  localStorage.clear();
  resetKormir();
});

async function fixture() {
  // Public test material in an isolated headless-browser origin.
  await restoreKormirWithNsec("11".repeat(32));
  const eventId = `handoff-${crypto.randomUUID()}`;
  const prepared = await prepareEnumAnnouncement(
    [],
    eventId,
    ["YES", "NO"],
    1_800_000_000,
    "Test",
    "Test",
  );
  const announcement = JSON.parse(prepared.eventJson);
  const binding = {
    conditionId: deriveDlcConditionId({
      eventId,
      outcomeCount: 2,
      oraclePublicKeys: [announcement.pubkey],
    }),
    oracleEventId: eventId,
    oraclePubkey: announcement.pubkey,
    outcomes: ["YES", "NO"],
    announcementEventJson: prepared.eventJson,
  };
  let failWrite = false;
  const storage = {
    getItem: (key: string) => localStorage.getItem(key),
    setItem: (key: string, value: string) => {
      if (failWrite) throw new Error("Private storage diagnostic must not escape.");
      localStorage.setItem(key, value);
    },
    removeItem: (key: string) => localStorage.removeItem(key),
  };
  function openStore() {
    const owner = createCreatorMarketsStore(() => storage);
    return {
      owner,
      port: {
        withMutation: owner.getState().withOracleMutation,
        read: (conditionId: string) => owner.getState().readOraclePublication(conditionId),
        save: (conditionId: string, record: OraclePublicationRecord) =>
          owner.getState().saveOraclePublication(conditionId, record),
      },
    };
  }
  const store = openStore();
  await store.owner.getState().saveCreatedMarket({
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
      outcomes: binding.outcomes,
      oraclePubkey: announcement.pubkey,
      announcementHex: prepared.artifactHex,
      announcementEventId: announcement.id,
      announcementEventJson: prepared.eventJson,
    },
  });
  return {
    binding,
    prepared,
    store,
    openStore,
    failWrites: (value: boolean) => {
      failWrite = value;
    },
  };
}

it("keeps the real IndexedDB stage through a failed public save and completes the exact handoff after reopen", async () => {
  const f = await fixture();
  const signed = await prepareEnumAttestation(
    [],
    f.binding.oracleEventId,
    "YES",
    f.binding.announcementEventJson,
  );
  const publication: OraclePublicationRecord = {
    binding: f.binding,
    chosenOutcome: "YES",
    attestation: { attestationHex: signed.artifactHex, eventJson: signed.eventJson },
    relayPublished: false,
    engineEvidence: null,
    explanationEventJson: null,
    explanationRelayPublished: false,
  };
  const staged = JSON.stringify(publication);
  const core = await getKormir([]);
  await core.export_enum_authority(
    f.binding.oracleEventId,
    f.binding.announcementEventJson,
    staged,
  );
  f.failWrites(true);
  await expect(
    reconcileBrowserOraclePublication({
      binding: f.binding,
      core: browserOraclePrivateAuthorityPort(core),
      store: f.store.port,
      validator: browserOracleBackupValidator,
    }),
  ).rejects.toThrow("Private oracle backup: invalid-record.");
  expect(await core.staged_enum_publication(f.binding.oracleEventId)).toBe(staged);
  expect(await f.store.port.read(f.binding.conditionId)).toBeNull();

  f.failWrites(false);
  resetKormir();
  const reopened = await getKormir([]);
  const publicStore = f.openStore();
  await publicStore.owner.persist.rehydrate();
  const result = await reconcileBrowserOraclePublication({
    binding: f.binding,
    core: browserOraclePrivateAuthorityPort(reopened),
    store: publicStore.port,
    validator: browserOracleBackupValidator,
  });
  expect(result.publication?.attestation?.eventJson).toBe(signed.eventJson);
  expect(await publicStore.port.read(f.binding.conditionId)).toEqual(publication);
  expect(await reopened.staged_enum_publication(f.binding.oracleEventId)).toBeUndefined();
  expect(localStorage.getItem("bitcaster-creator-markets")).not.toContain("nonceScalarHex");
});

it("merges older staged progress and preserves terminal authority after restart", async () => {
  const f = await fixture();
  const signed = await prepareEnumAttestation(
    [],
    f.binding.oracleEventId,
    "YES",
    f.binding.announcementEventJson,
  );
  const publication: OraclePublicationRecord = {
    binding: f.binding,
    chosenOutcome: "YES",
    attestation: { attestationHex: signed.artifactHex, eventJson: signed.eventJson },
    relayPublished: false,
    engineEvidence: null,
    explanationEventJson: null,
    explanationRelayPublished: false,
  };
  const core = await getKormir([]);
  const exported = JSON.parse(
    await core.export_enum_authority(
      f.binding.oracleEventId,
      f.binding.announcementEventJson,
      JSON.stringify(publication),
    ),
  );
  await f.store.port.save(f.binding.conditionId, { ...publication, relayPublished: true });
  const first = await reconcileBrowserOraclePublication({
    binding: f.binding,
    core: browserOraclePrivateAuthorityPort(core),
    store: f.store.port,
    validator: browserOracleBackupValidator,
  });
  expect(first.publication?.relayPublished).toBe(true);
  await core.import_enum_authority(
    JSON.stringify({
      ...exported,
      nonceScalarHex: null,
      publicationRecordJson: JSON.stringify(first.publication),
    }),
  );
  resetKormir();
  const reopened = await getKormir([]);
  const result = await reconcileBrowserOraclePublication({
    binding: f.binding,
    core: browserOraclePrivateAuthorityPort(reopened),
    store: f.openStore().port,
    validator: browserOracleBackupValidator,
  });
  expect(result.authority.nonceScalarHex).toBeNull();
  expect(result.publication?.attestation?.eventJson).toBe(signed.eventJson);
  expect(result.publication?.relayPublished).toBe(true);
  expect(await reopened.staged_enum_publication(f.binding.oracleEventId)).toBeUndefined();
});

it("reserves one real IndexedDB choice before either competing tab writes its public choice", async () => {
  const f = await fixture();
  const a = await getKormir([]);
  resetKormir();
  const b = await getKormir([]);
  const results = await Promise.allSettled(
    ["YES", "NO"].map((choice, index) =>
      reconcileBrowserOraclePublication({
        binding: f.binding,
        core: browserOraclePrivateAuthorityPort(index === 0 ? a : b),
        store: f.openStore().port,
        validator: browserOracleBackupValidator,
        incoming: {
          binding: f.binding,
          chosenOutcome: choice,
          attestation: null,
          relayPublished: false,
          engineEvidence: null,
          explanationEventJson: null,
          explanationRelayPublished: false,
        },
      }),
    ),
  );
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  const winner = results.find((result) => result.status === "fulfilled")!;
  if (winner.status !== "fulfilled") throw new Error("A retained choice is required.");
  resetKormir();
  const reopened = await getKormir([]);
  const authority = JSON.parse(
    await reopened.export_enum_authority(f.binding.oracleEventId, f.binding.announcementEventJson),
  );
  const publicChoice = await f.openStore().port.read(f.binding.conditionId);
  expect(authority.signedOutcome).toBe(winner.value.publication!.chosenOutcome);
  expect(publicChoice?.chosenOutcome).toBe(authority.signedOutcome);
});
