import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  deriveDlcConditionId,
  createOracleBackupEvent,
  decryptOracleBackupEvent,
  type OracleBackupRecord,
} from "@bitcaster/client-sdk";
import { createCreatorMarketsStore } from "@/stores/creatorMarkets";
import { useSettingsStore } from "@/stores/settings";
import { creatorMarketFixture } from "@/test/creatorOracleFixture";
import {
  browserOracleBackupValidator,
  getKormir,
  ensureKormirNsec,
  prepareEnumAnnouncement,
  prepareEnumAttestation,
  resetKormir,
  restoreKormirWithNsec,
} from "../kormir";
import { exportBrowserOracleBackup, importBrowserOracleBackup } from "../browserOracleBackup";
import {
  oracleEventToWire,
  publishBrowserOracleOutcome,
  retainedOracleAuthority,
} from "../oracleAttestation";

vi.mock("../kormir", async (original) => {
  const actual = await original<typeof import("../kormir")>();
  return {
    ...actual,
    getKormir: vi.fn(actual.getKormir),
    ensureKormirNsec: vi.fn(actual.ensureKormirNsec),
  };
});
beforeEach(() => {
  localStorage.clear();
  resetKormir();
  vi.clearAllMocks();
  useSettingsStore.setState({ nostrSignerMode: "nsec", nsecSecret: "11".repeat(32) });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function emptyPrivateTestStore() {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("kormir");
    request.onerror = () => reject(new Error("Test oracle database unavailable."));
    request.onsuccess = () => {
      const database = request.result;
      const tx = database.transaction("oracle", "readwrite");
      tx.objectStore("oracle").clear();
      tx.oncomplete = () => {
        database.close();
        resolve();
      };
      tx.onerror = () => {
        database.close();
        reject(new Error("Test oracle reset failed."));
      };
    };
  });
  resetKormir();
}

async function fixture() {
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

it("restores encrypted authority into empty IndexedDB and retains only public metadata in the owner", async () => {
  const f = await fixture();
  const encrypted = await createOracleBackupEvent({
    record: f.record,
    privateKey: new Uint8Array(32).fill(0x11),
    createdAt: 1_800_000_001,
    validator: browserOracleBackupValidator,
  });
  const decoded = await decryptOracleBackupEvent({
    event: encrypted,
    privateKey: new Uint8Array(32).fill(0x11),
    validator: browserOracleBackupValidator,
  });
  await emptyPrivateTestStore();
  const owner = createCreatorMarketsStore();
  const imported = await importBrowserOracleBackup(decoded, owner);
  expect(imported.kind).toBe("imported");
  expect(owner.getState().markets).toHaveLength(0);
  expect(owner.getState().importedOracles[0].importComplete).toBe(true);
  const saved = localStorage.getItem("bitcaster-creator-markets")!;
  expect(saved.includes("nonceScalarHex")).toBe(false);
  expect(saved.includes(f.record.authority.nonceScalarHex!)).toBe(false);
  resetKormir();
  const reopened = createCreatorMarketsStore();
  const restored = await exportBrowserOracleBackup(f.record.conditionId, reopened);
  expect(JSON.stringify(restored) === JSON.stringify(f.record)).toBe(true);
  const signed = await prepareEnumAttestation(
    [],
    f.record.oracleEventId,
    "YES",
    f.record.authority.announcementEventJson,
  );
  expect(signed.artifactHex.length > 0).toBe(true);
});

it("refuses a failed metadata write before importing any per-event private authority", async () => {
  const f = await fixture();
  await emptyPrivateTestStore();
  const owner = createCreatorMarketsStore(() => ({
    getItem: (key) => localStorage.getItem(key),
    removeItem: (key) => localStorage.removeItem(key),
    setItem: () => {
      throw new Error("Private fixture diagnostic.");
    },
  }));
  await expect(importBrowserOracleBackup(f.record, owner)).rejects.toThrow(
    "Private oracle backup: invalid-record.",
  );
  expect(await owner.getState().readOracleOwner(f.record.conditionId)).toBeNull();
  await expect(
    (await getKormir([])).export_enum_authority(
      f.record.oracleEventId,
      f.record.authority.announcementEventJson,
    ),
  ).rejects.toBeDefined();
});

it.each([
  { kind: "imported", previouslyComplete: false },
  { kind: "created", previouslyComplete: false },
  { kind: "imported", previouslyComplete: true },
  { kind: "created", previouslyComplete: true },
] as const)(
  "refuses new signing after failed $kind import over older authority (previously complete: $previouslyComplete)",
  async ({ kind, previouslyComplete }) => {
    const f = await fixture();
    const signed = await prepareEnumAttestation(
      [],
      f.record.oracleEventId,
      "YES",
      f.record.authority.announcementEventJson,
    );
    const terminal = {
      ...f.record,
      authority: JSON.parse(
        await f.core.export_enum_authority(
          f.record.oracleEventId,
          f.record.authority.announcementEventJson,
        ),
      ),
    };
    await emptyPrivateTestStore();
    await ensureKormirNsec([], "11".repeat(32));
    const olderCore = await getKormir([]);
    await olderCore.import_enum_authority(JSON.stringify(f.record.authority));
    const owner = createCreatorMarketsStore();
    if (kind === "created") {
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
    }
    if (previouslyComplete) await importBrowserOracleBackup(f.record, owner);
    const privateImport = vi
      .spyOn(Object.getPrototypeOf(olderCore), "import_enum_authority")
      .mockRejectedValue(new Error("Private fixture diagnostic."));
    try {
      await expect(importBrowserOracleBackup(terminal, owner)).rejects.toThrow(
        "Private oracle backup: invalid-record.",
      );
    } finally {
      privateImport.mockRestore();
    }
    const incomplete = await owner.getState().readOracleOwner(f.record.conditionId);
    expect(incomplete?.kind).toBe(kind);
    expect(
      incomplete?.kind === "created"
        ? incomplete.market.oracle?.importComplete
        : incomplete?.oracle.importComplete,
    ).toBe(false);
    const prepare = vi
      .spyOn(Object.getPrototypeOf(olderCore), "prepare_enum_attestation")
      .mockRejectedValue(new Error("Unexpected signing."));
    const network = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", network);
    try {
      await expect(
        publishBrowserOracleOutcome(
          f.record.conditionId,
          "NO",
          undefined,
          [],
          owner,
          async () => null,
          { engineDelivery: "relay-only" },
        ),
      ).rejects.toThrow("Complete the oracle backup import before signing.");
      expect(prepare).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
      await expect(exportBrowserOracleBackup(f.record.conditionId, owner)).rejects.toThrow(
        "Private oracle backup: invalid-record.",
      );
    } finally {
      prepare.mockRestore();
    }
    await importBrowserOracleBackup(terminal, owner);
    expect(
      (await owner.getState().readOraclePublication(f.record.conditionId))?.attestation
        ?.eventJson === signed.eventJson,
    ).toBe(true);
    await expect(
      prepareEnumAttestation([], f.record.oracleEventId, "NO", f.prepared.eventJson),
    ).rejects.toBeDefined();
  },
);

it.each([true, false])(
  "retries a terminal exact artifact after logout without Kormir (import complete: %s)",
  async (complete) => {
    const f = await fixture();
    const exact = await prepareEnumAttestation(
      [],
      f.record.oracleEventId,
      "YES",
      f.record.authority.announcementEventJson,
    );
    const publication = {
      binding: f.binding,
      chosenOutcome: "YES",
      attestation: { attestationHex: exact.artifactHex, eventJson: exact.eventJson },
      relayPublished: true,
      engineEvidence: null,
      explanationEventJson: null,
      explanationRelayPublished: false,
    };
    const authority = JSON.parse(
      await f.core.export_enum_authority(
        f.record.oracleEventId,
        f.record.authority.announcementEventJson,
        JSON.stringify(publication),
      ),
    );
    const terminal = { ...f.record, authority: { ...authority, nonceScalarHex: null } };
    await emptyPrivateTestStore();
    let completionFault = !complete;
    const owner = createCreatorMarketsStore(() => ({
      getItem: (key) => localStorage.getItem(key),
      removeItem: (key) => localStorage.removeItem(key),
      setItem: (key, value) => {
        if (completionFault && JSON.parse(value).state.importedOracles[0]?.importComplete)
          throw new Error("Private fixture diagnostic.");
        localStorage.setItem(key, value);
      },
    }));
    if (complete) await importBrowserOracleBackup(terminal, owner);
    else
      await expect(importBrowserOracleBackup(terminal, owner)).rejects.toThrow(
        "Private oracle backup: invalid-record.",
      );
    completionFault = false;
    const imported = await owner.getState().readOracleOwner(f.record.conditionId);
    if (imported?.kind !== "imported") throw new Error("Imported metadata required.");
    expect(imported.oracle.importComplete).toBe(complete);
    const publicAuthority = await retainedOracleAuthority(f.binding, {
      announcementTlvHex: f.prepared.artifactHex,
    });
    useSettingsStore.setState({ nostrSignerMode: "none", nsecSecret: null });
    vi.mocked(getKormir).mockClear();
    vi.mocked(ensureKormirNsec).mockClear();
    const network = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({}),
    );
    vi.stubGlobal("fetch", network);
    const result = await publishBrowserOracleOutcome(
      f.record.conditionId,
      "YES",
      undefined,
      ["wss://current.example"],
      owner,
      async () => ({
        conditionId: f.record.conditionId,
        attestedOutcome: "YES",
        oracleWitness: {},
        registeredAuthority: {
          eventId: f.record.oracleEventId,
          outcomes: ["YES", "NO"],
          threshold: 1,
          oracles: publicAuthority.oracles,
        },
        attestationEvent: oracleEventToWire(exact.eventJson),
      }),
    );
    expect(result.failures).toHaveLength(0);
    expect(result.record.attestation?.eventJson === exact.eventJson).toBe(true);
    expect(network).toHaveBeenCalledTimes(1);
    expect(String(network.mock.calls[0][0]).startsWith("https://engine.original.example/")).toBe(
      true,
    );
    expect(getKormir).not.toHaveBeenCalled();
    expect(ensureKormirNsec).not.toHaveBeenCalled();
    expect(
      (await owner.getState().readOraclePublication(f.record.conditionId))?.engineEvidence?.outcome,
    ).toBe("YES");
  },
);

it.each(["publication-write", "acknowledgment", "completion-write"] as const)(
  "resumes the exact imported publication after a failed %s boundary",
  async (boundary) => {
    const f = await fixture();
    const signed = await prepareEnumAttestation(
      [],
      f.record.oracleEventId,
      "YES",
      f.record.authority.announcementEventJson,
    );
    const publication = {
      binding: f.binding,
      chosenOutcome: "YES",
      attestation: { attestationHex: signed.artifactHex, eventJson: signed.eventJson },
      relayPublished: false,
      engineEvidence: null,
      explanationEventJson: null,
      explanationRelayPublished: false,
    };
    const backup = {
      ...f.record,
      authority: JSON.parse(
        await f.core.export_enum_authority(
          f.record.oracleEventId,
          f.record.authority.announcementEventJson,
          JSON.stringify(publication),
        ),
      ),
    };
    await emptyPrivateTestStore();
    await ensureKormirNsec([], "11".repeat(32));
    const restored = await getKormir([]);
    const ack =
      boundary === "acknowledgment"
        ? vi
            .spyOn(Object.getPrototypeOf(restored), "acknowledge_enum_publication")
            .mockRejectedValue(new Error("Private fixture diagnostic."))
        : undefined;
    let fault = true;
    const owner = createCreatorMarketsStore(() => ({
      getItem: (key) => localStorage.getItem(key),
      removeItem: (key) => localStorage.removeItem(key),
      setItem: (key, value) => {
        const record = JSON.parse(value).state.importedOracles[0];
        if (
          fault &&
          ((boundary === "publication-write" && record?.publication !== null) ||
            (boundary === "completion-write" && record?.importComplete === true))
        )
          throw new Error("Private fixture diagnostic.");
        localStorage.setItem(key, value);
      },
    }));
    try {
      await expect(importBrowserOracleBackup(backup, owner)).rejects.toThrow(
        "Private oracle backup: invalid-record.",
      );
      const before = await owner.getState().readOracleOwner(f.record.conditionId);
      if (before?.kind !== "imported") throw new Error("Imported metadata required.");
      expect(before.oracle.importComplete).toBe(false);
      expect((await restored.staged_enum_publication(f.record.oracleEventId)) !== undefined).toBe(
        boundary !== "completion-write",
      );
    } finally {
      ack?.mockRestore();
    }
    fault = false;
    resetKormir();
    const reopened = createCreatorMarketsStore();
    await importBrowserOracleBackup(backup, reopened);
    const after = await reopened.getState().readOracleOwner(f.record.conditionId);
    if (after?.kind !== "imported") throw new Error("Imported metadata required.");
    expect(after.oracle.importComplete).toBe(true);
    expect(after.oracle.publication?.attestation?.eventJson === signed.eventJson).toBe(true);
    expect(
      await (await getKormir([])).staged_enum_publication(f.record.oracleEventId),
    ).toBeUndefined();
    await expect(
      prepareEnumAttestation(
        [],
        f.record.oracleEventId,
        "NO",
        f.record.authority.announcementEventJson,
      ),
    ).rejects.toBeDefined();
  },
);
