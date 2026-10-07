import {
  fixture,
  deliveryOwner,
  saveRelayConfirmedResult,
} from "@/test/oracleBackupProviderFixture";
import { creatorMarketFixture } from "@/test/creatorOracleFixture";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOracleBackupEvent, decryptOracleBackupEvent } from "@bitcaster/client-sdk";
import { createCreatorMarketsStore } from "@/stores/creatorMarkets";
import { useSettingsStore } from "@/stores/settings";
import {
  browserOracleBackupValidator,
  resetKormir,
  prepareBrowserOracleMutation,
  decodeOracleAttestation,
} from "@/lib/kormir";
import {
  fixtureOracleCore as getKormir,
  installFixtureOracleKey as ensureKormirNsec,
  prepareFixtureAnnouncement as prepareEnumAnnouncement,
  prepareFixtureAttestation as prepareEnumAttestation,
} from "@/test/localOracleProvider";
import {
  exportBrowserOracleBackup,
  importBrowserOracleBackup,
  importBrowserOracleBackupEnvelope,
} from "../browserOracleBackup";
import {
  oracleEventToWire,
  publishBrowserOracleOutcome,
  retainedOracleAuthority,
} from "../oracleAttestation";
import {
  createBrowserOracleBackupDeliveryAdapters,
  deliverBrowserOracleBackup,
  retryBrowserOracleBackupDelivery,
  requestBrowserOracleBackup,
} from "../browserOracleBackupDelivery";
import { publicCreatorMarket } from "../nip78CreatorMarkets";

const oracleNetwork = vi.hoisted(() => ({ publish: vi.fn() }));
vi.mock("../oracleRelayTransport", async (original) => ({
  ...(await original<typeof import("../oracleRelayTransport")>()),
  publishRetainedOracleEvent: (relays: string[], json: string) =>
    oracleNetwork.publish(relays, json),
}));
vi.mock("../kormir", async (original) => {
  const actual = await original<typeof import("../kormir")>();
  return {
    ...actual,
    prepareBrowserOracleMutation: vi.fn(actual.prepareBrowserOracleMutation),
    decodeOracleAttestation: vi.fn(actual.decodeOracleAttestation),
  };
});
vi.mock("../browserOracleBackupDelivery", async (original) => ({
  ...(await original<typeof import("../browserOracleBackupDelivery")>()),
  requestBrowserOracleBackup: vi.fn(),
}));
beforeEach(() => {
  localStorage.clear();
  resetKormir();
  vi.clearAllMocks();
  oracleNetwork.publish.mockImplementation(async (_relays, json: string) => JSON.parse(json).id);
  useSettingsStore.setState({ nostrSignerMode: "nsec", nsecSecret: "11".repeat(32) });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it.each(["metadata-write", "private-import", "completion-write"] as const)(
  "retains authenticated source provenance before the %s import boundary",
  async (boundary) => {
    const f = await fixture();
    const event = await createOracleBackupEvent({
      record: f.record,
      privateKey: Uint8Array.from({ length: 32 }, () => 0x11),
      createdAt: 1_800_000_040,
      validator: browserOracleBackupValidator,
    });
    await emptyPrivateTestStore();
    await ensureKormirNsec([], "11".repeat(32));
    const core = await getKormir([]);
    let fail = true;
    const owner = createCreatorMarketsStore(() => ({
      getItem: (key) => localStorage.getItem(key),
      removeItem: (key) => localStorage.removeItem(key),
      setItem: (key, value) => {
        const imported = JSON.parse(value).state.importedOracles[0];
        if (
          fail &&
          ((boundary === "metadata-write" && imported?.backupDelivery?.knownEventIds.length) ||
            (boundary === "completion-write" && imported?.importComplete))
        )
          throw new Error("Private fixture diagnostic.");
        localStorage.setItem(key, value);
      },
    }));
    const privateImport =
      boundary === "private-import"
        ? vi
            .spyOn(Object.getPrototypeOf(core), "import_enum_authority")
            .mockRejectedValue(new Error("Private fixture diagnostic."))
        : null;
    try {
      await expect(
        importBrowserOracleBackupEnvelope(event, "wss://source.example", owner),
      ).rejects.toThrow("Private oracle backup: invalid-record.");
    } finally {
      privateImport?.mockRestore();
    }
    const reloaded = createCreatorMarketsStore();
    const saved = await reloaded.getState().readOracleOwner(f.record.conditionId);
    if (boundary === "metadata-write") {
      expect(saved).toBeNull();
      await expect(
        core.export_enum_authority(f.record.oracleEventId, f.prepared.eventJson),
      ).rejects.toThrow();
    } else {
      if (saved?.kind !== "imported") throw new Error("Imported owner required.");
      expect(saved.oracle.importComplete).toBe(false);
      expect(saved.oracle.backupDelivery?.current).toBeNull();
      expect(saved.oracle.backupDelivery?.knownEventIds.join(",")).toBe(event.id);
      expect(saved.oracle.backupDelivery?.timestampHighWater).toBe(event.created_at);
    }
    fail = false;
    await importBrowserOracleBackupEnvelope(event, "wss://source.example", owner);
    const complete = await createCreatorMarketsStore()
      .getState()
      .readOracleOwner(f.record.conditionId);
    if (complete?.kind !== "imported") throw new Error("Imported owner required.");
    expect(complete.oracle.importComplete).toBe(true);
    expect(complete.oracle.backupDelivery?.knownEventIds.join(",")).toBe(event.id);
    const prepared = await createBrowserOracleBackupDeliveryAdapters({
      store: owner,
      nowSeconds: () => 1,
    }).store.prepare(f.record.conditionId);
    expect(JSON.parse(prepared.current!.eventJson).created_at).toBe(event.created_at + 1);
  },
);

it("refuses a new terminal source before changing a usable owner and supports fresh terminal restore", async () => {
  const f = await fixture();
  const source = await createOracleBackupEvent({
    record: f.record,
    privateKey: Uint8Array.from({ length: 32 }, () => 0x11),
    createdAt: 1_800_000_040,
    validator: browserOracleBackupValidator,
  });
  const owner = createCreatorMarketsStore();
  await importBrowserOracleBackupEnvelope(source, "wss://source.example", owner);
  await createBrowserOracleBackupDeliveryAdapters({ store: owner }).store.prepare(
    f.record.conditionId,
  );
  await saveRelayConfirmedResult(f, owner);
  const staged = await createBrowserOracleBackupDeliveryAdapters({ store: owner }).store.prepare(
    f.record.conditionId,
  );
  const terminal = await decryptOracleBackupEvent({
    event: JSON.parse(staged.current!.eventJson),
    privateKey: Uint8Array.from({ length: 32 }, () => 0x11),
    validator: browserOracleBackupValidator,
  });
  const late = await createOracleBackupEvent({
    record: terminal,
    privateKey: Uint8Array.from({ length: 32 }, () => 0x11),
    createdAt: JSON.parse(staged.current!.eventJson).created_at + 1,
    validator: browserOracleBackupValidator,
  });
  const before = localStorage.getItem("bitcaster-creator-markets");
  await expect(
    importBrowserOracleBackupEnvelope(late, "wss://source.example", owner),
  ).rejects.toThrow("terminal-backup-source-not-admitted");
  expect(localStorage.getItem("bitcaster-creator-markets") === before).toBe(true);
  const retained = await owner.getState().readOracleOwner(f.record.conditionId);
  if (retained?.kind !== "imported") throw new Error("Imported owner required.");
  expect(retained.oracle.importComplete).toBe(true);
  await emptyPrivateTestStore();
  await owner.getState().clear();
  const descriptor = await importBrowserOracleBackupEnvelope(late, "wss://source.example", owner);
  expect(descriptor.state).toBe("terminal");
  const fresh = await owner.getState().readOracleBackupDelivery(f.record.conditionId);
  expect(fresh?.current).toBeNull();
  expect(fresh?.terminalAdmission).toBeNull();
  expect(fresh?.terminalCommitPending).toBe(false);
  expect(fresh?.knownEventIds.join(",")).toBe(late.id);
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

it.each(["stage-write", "backup-ack", "deletion-ack", "terminal-commit"] as const)(
  "recovers the exact encrypted stage after a failed %s save",
  async (boundary) => {
    const f = await fixture();
    let fault = false;
    const owner = createCreatorMarketsStore(() => ({
      getItem: (key) => localStorage.getItem(key),
      removeItem: (key) => localStorage.removeItem(key),
      setItem: (key, value) => {
        const state = JSON.parse(value).state.importedOracles[0]?.backupDelivery;
        const old = JSON.parse(localStorage.getItem(key) ?? "null")?.state.importedOracles[0]
          ?.backupDelivery;
        const refused =
          (boundary === "stage-write" && state?.current && !old?.current) ||
          (boundary === "backup-ack" &&
            state?.current?.mode === "initial" &&
            state.current.acknowledgedRelayIndexes.length > 0) ||
          (boundary === "deletion-ack" && old?.deletion && !state?.deletion) ||
          (boundary === "terminal-commit" &&
            old?.terminalCommitPending &&
            state?.terminalCommitPending === false);
        if (fault && refused) throw new Error("Private fixture save diagnostic.");
        localStorage.setItem(key, value);
      },
    }));
    await importBrowserOracleBackup(f.record, owner);
    const sent: string[] = [];
    const options = {
      store: owner,
      nowSeconds: () => 1_800_000_003,
      publishRelay: async (relayUrl: string, eventJson: string) => {
        sent.push(eventJson);
        return { relayUrl, eventId: JSON.parse(eventJson).id };
      },
    };
    if (boundary === "deletion-ack" || boundary === "terminal-commit") {
      expect(
        (await deliverBrowserOracleBackup(f.record.conditionId, options)).failures.length,
      ).toBe(0);
      await saveRelayConfirmedResult(f, owner);
    }
    if (boundary !== "stage-write")
      await createBrowserOracleBackupDeliveryAdapters(options).store.prepare(f.record.conditionId);
    sent.length = 0;
    fault = true;
    const failed =
      boundary === "stage-write"
        ? await deliverBrowserOracleBackup(f.record.conditionId, options)
        : await retryBrowserOracleBackupDelivery(f.record.conditionId, options);
    expect(failed.failures.length > 0).toBe(true);
    const before = await createCreatorMarketsStore()
      .getState()
      .readOracleBackupDelivery(f.record.conditionId);
    if (boundary === "stage-write") {
      expect(sent.length).toBe(0);
      expect(before).toBeNull();
      fault = false;
      expect(
        (await deliverBrowserOracleBackup(f.record.conditionId, options)).failures.length,
      ).toBe(0);
      return;
    }
    expect(before?.current != null).toBe(true);
    if (boundary === "backup-ack") expect(before?.current?.acknowledgedRelayIndexes.length).toBe(0);
    if (boundary === "deletion-ack") expect(before?.deletion != null).toBe(true);
    if (boundary === "terminal-commit") expect(before?.terminalCommitPending).toBe(true);
    const savedCurrent = before!.current!.eventJson;
    const savedDeletion = before!.deletion?.eventJson;
    fault = false;
    useSettingsStore.setState({ nostrSignerMode: "none", nsecSecret: null });
    vi.mocked(prepareBrowserOracleMutation).mockClear();
    const resumedSends: string[] = [];
    const resumed = await retryBrowserOracleBackupDelivery(f.record.conditionId, {
      store: createCreatorMarketsStore(),
      publishRelay: async (relayUrl, eventJson) => {
        resumedSends.push(eventJson);
        return { relayUrl, eventId: JSON.parse(eventJson).id };
      },
    });
    expect(resumed.failures.length).toBe(0);
    expect(resumedSends.every((event) => event === savedCurrent || event === savedDeletion)).toBe(
      true,
    );
    expect(resumedSends.length).toBe(boundary === "terminal-commit" ? 0 : 1);
    expect(vi.mocked(prepareBrowserOracleMutation).mock.calls.length).toBe(0);
    if (boundary !== "backup-ack") expect(resumed.state?.terminalCommitPending).toBe(false);
  },
);

it.each(["created", "imported"] as const)(
  "reopens %s backup stages and retries exact terminal replacement and deletion after logout",
  async (kind) => {
    const f = await fixture();
    f.record = {
      ...f.record,
      destinations: {
        ...f.record.destinations,
        relayUrls: ["wss://relay.original.example", "wss://relay.second.example"],
      },
    };
    const owner = await deliveryOwner(kind, f);
    const initialSends: string[] = [];
    const first = await deliverBrowserOracleBackup(f.record.conditionId, {
      store: owner,
      nowSeconds: () => 1_800_000_002,
      publishRelay: async (relayUrl, eventJson) => {
        // This would deadlock if external delivery still owned the document lock.
        await owner.getState().saveOraclePublicationFailures(f.record.conditionId, []);
        initialSends.push(eventJson);
        if (relayUrl === f.record.destinations.relayUrls[1])
          throw new Error("Private transport diagnostic.");
        return { relayUrl, eventId: JSON.parse(eventJson).id };
      },
    });
    expect(first.state?.current?.mode).toBe("initial");
    expect(first.failures.includes("backup-relay")).toBe(true);
    const initialJson = first.state!.current!.eventJson;
    expect(initialSends.every((event) => event === initialJson)).toBe(true);
    const savedText = localStorage.getItem("bitcaster-creator-markets")!;
    expect(savedText.includes("nonceScalarHex")).toBe(false);
    expect(savedText.includes(f.record.authority.nonceScalarHex!)).toBe(false);
    if (kind === "created") {
      const mirror = JSON.stringify(publicCreatorMarket(owner.getState().markets[0]));
      expect(mirror.includes("backupDelivery")).toBe(false);
      expect(mirror.includes(JSON.parse(initialJson).content)).toBe(false);
    }
    useSettingsStore.setState({ nostrSignerMode: "none", nsecSecret: null });
    vi.mocked(prepareBrowserOracleMutation).mockClear();
    const reopened = createCreatorMarketsStore();
    const retrySends: string[] = [];
    const retried = await retryBrowserOracleBackupDelivery(f.record.conditionId, {
      store: reopened,
      publishRelay: async (relayUrl, eventJson) => {
        retrySends.push(eventJson);
        return { relayUrl, eventId: JSON.parse(eventJson).id };
      },
    });
    expect(retried.failures.length).toBe(0);
    expect(retrySends.length).toBe(1);
    expect(retrySends[0] === initialJson).toBe(true);
    expect(vi.mocked(prepareBrowserOracleMutation).mock.calls.length).toBe(0);

    useSettingsStore.setState({ nostrSignerMode: "nsec", nsecSecret: "11".repeat(32) });
    const signed = await saveRelayConfirmedResult(f, reopened);
    const terminal = await createBrowserOracleBackupDeliveryAdapters({
      store: reopened,
      nowSeconds: () => 1_700_000_000,
    }).store.prepare(f.record.conditionId);
    expect(terminal.current?.mode).toBe("terminal");
    const terminalJson = terminal.current!.eventJson;
    const deletionJson = terminal.deletion!.eventJson;
    expect(JSON.parse(terminalJson).created_at).toBe(JSON.parse(initialJson).created_at + 1);
    expect(terminal.knownEventIds.includes(JSON.parse(initialJson).id)).toBe(true);
    const terminalPayload = await decryptOracleBackupEvent({
      event: JSON.parse(terminalJson),
      privateKey: new Uint8Array(32).fill(0x11),
      validator: browserOracleBackupValidator,
    });
    expect(terminalPayload.authority.nonceScalarHex).toBeNull();
    expect(terminalPayload.authority.attestationEventJson === signed.eventJson).toBe(true);
    expect(JSON.parse(deletionJson).tags.some((tag: string[]) => tag[0] === "a")).toBe(false);

    useSettingsStore.setState({ nostrSignerMode: "none", nsecSecret: null });
    vi.mocked(prepareBrowserOracleMutation).mockClear();
    const secondOwner = createCreatorMarketsStore();
    const partialSends: { relay: string; kind: number; json: string }[] = [];
    const partial = await retryBrowserOracleBackupDelivery(f.record.conditionId, {
      store: secondOwner,
      publishRelay: async (relayUrl, eventJson) => {
        const event = JSON.parse(eventJson);
        partialSends.push({ relay: relayUrl, kind: event.kind, json: eventJson });
        if (relayUrl === f.record.destinations.relayUrls[1])
          throw new Error("Private transport diagnostic.");
        return { relayUrl, eventId: event.id };
      },
    });
    expect(partial.state?.terminalCommitPending).toBe(false);
    expect(partialSends.filter((sent) => sent.kind === 5).length).toBe(1);
    expect(
      partialSends.some(
        (sent) => sent.kind === 5 && sent.relay === f.record.destinations.relayUrls[1],
      ),
    ).toBe(false);
    const finalSends: string[] = [];
    const finalOwner = createCreatorMarketsStore();
    const finished = await retryBrowserOracleBackupDelivery(f.record.conditionId, {
      store: finalOwner,
      publishRelay: async (relayUrl, eventJson) => {
        finalSends.push(eventJson);
        return { relayUrl, eventId: JSON.parse(eventJson).id };
      },
    });
    expect(finished.failures.length).toBe(0);
    expect(finalSends.length).toBe(2);
    expect(finalSends.every((json) => json === terminalJson || json === deletionJson)).toBe(true);
    expect(finished.state?.deletion).toBeNull();
    expect(finished.state?.knownEventIds.length).toBe(0);
    expect(useSettingsStore.getState().nostrSignerMode).toBe("none");
    const portable = await exportBrowserOracleBackup(f.record.conditionId, finalOwner);
    expect(portable.authority.nonceScalarHex).toBeNull();
    expect(portable.authority.attestationEventJson === signed.eventJson).toBe(true);
    expect(vi.mocked(prepareBrowserOracleMutation).mock.calls.length).toBe(0);
  },
);

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

it("allocates a distinct unrelated nonce after encrypted restore without changing imported authority", async () => {
  const f = await fixture();
  const event = await createOracleBackupEvent({
    record: f.record,
    privateKey: new Uint8Array(32).fill(0x11),
    createdAt: 1_800_000_001,
    validator: browserOracleBackupValidator,
  });
  await emptyPrivateTestStore();
  const owner = createCreatorMarketsStore();
  await importBrowserOracleBackupEnvelope(event, "wss://source.example", owner);
  const before = await exportBrowserOracleBackup(f.record.conditionId, owner);
  const original = await browserOracleBackupValidator.validateAuthority(
    JSON.stringify(before.authority),
    before.oraclePubkey,
  );
  const unrelatedId = `unrelated-after-restore-${crypto.randomUUID()}`;
  const unrelated = await prepareEnumAnnouncement([], unrelatedId, ["YES", "NO"], 1_800_000_002);
  const core = await getKormir([]);
  const unrelatedAuthority = await core.export_enum_authority(unrelatedId, unrelated.eventJson);
  const fresh = await browserOracleBackupValidator.validateAuthority(
    unrelatedAuthority,
    before.oraclePubkey,
  );
  expect(fresh.eventId).toBe(unrelatedId);
  expect(fresh.noncePoint === original.noncePoint).toBe(false);
  resetKormir();
  const reopened = createCreatorMarketsStore();
  const after = await exportBrowserOracleBackup(f.record.conditionId, reopened);
  // Compare private authority without printing its contents on failure.
  expect(JSON.stringify(after) === JSON.stringify(before)).toBe(true);
  expect(reopened.getState().markets.length).toBe(0);
  expect(reopened.getState().importedOracles.length).toBe(1);
  const retained = await browserOracleBackupValidator.validateAuthority(
    JSON.stringify(after.authority),
    after.oraclePubkey,
  );
  expect(retained.noncePoint).toBe(original.noncePoint);
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
    vi.mocked(prepareBrowserOracleMutation).mockClear();
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
    expect(prepareBrowserOracleMutation).not.toHaveBeenCalled();
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

function oracleGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("cancels an A-B-A identity change before real oracle import admission", async () => {
  const f = await fixture();
  await emptyPrivateTestStore();
  const waiting = oracleGate();
  const release = oracleGate();
  const owner = createCreatorMarketsStore(
    () => localStorage,
    () => ({
      async request(_name, action) {
        waiting.resolve();
        await release.promise;
        return action();
      },
    }),
  );
  const pending = importBrowserOracleBackup(f.record, owner);
  await waiting.promise;
  useSettingsStore.setState({ nsecSecret: "22".repeat(32) });
  useSettingsStore.setState({ nsecSecret: "11".repeat(32) });
  release.resolve();
  await expect(pending).rejects.toMatchObject({ reason: "identity-changed" });
  expect((await owner.getState().readOracleOwner(f.record.conditionId)) === null).toBe(true);
  const records = await privateOracleSnapshot();
  expect(records === "[]").toBe(true);
});

it("completes an admitted real private import and document handoff for its captured owner", async () => {
  const f = await fixture();
  await emptyPrivateTestStore();
  const admitted = oracleGate();
  const release = oracleGate();
  let firstWrite = true;
  const owner = createCreatorMarketsStore(() => ({
    getItem: (key) => localStorage.getItem(key),
    removeItem: (key) => localStorage.removeItem(key),
    async setItem(key, value) {
      if (firstWrite) {
        firstWrite = false;
        admitted.resolve();
        await release.promise;
      }
      localStorage.setItem(key, value);
    },
  }));
  const pending = importBrowserOracleBackup(f.record, owner);
  await admitted.promise;
  useSettingsStore.setState({ nsecSecret: "22".repeat(32) });
  release.resolve();
  await expect(pending).rejects.toMatchObject({ reason: "identity-changed" });
  const retained = await owner.getState().readOracleOwner(f.record.conditionId);
  expect(retained?.kind === "imported" && retained.oracle.importComplete).toBe(true);
  useSettingsStore.setState({ nsecSecret: "11".repeat(32) });
  const exported = await exportBrowserOracleBackup(f.record.conditionId, owner);
  expect(JSON.stringify(exported) === JSON.stringify(f.record)).toBe(true);
});

async function privateOracleSnapshot(): Promise<string> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("kormir");
    open.onerror = () => reject(new Error("Test oracle database unavailable."));
    open.onsuccess = () => {
      const database = open.result;
      const tx = database.transaction("oracle", "readonly");
      const records = tx.objectStore("oracle").getAll();
      tx.oncomplete = () => {
        database.close();
        resolve(JSON.stringify(records.result));
      };
      tx.onerror = () => {
        database.close();
        reject(new Error("Test oracle read failed."));
      };
    };
  });
}

it("refuses a foreign retained key before changing private records or creator metadata", async () => {
  const f = await fixture();
  await emptyPrivateTestStore();
  await ensureKormirNsec([], "22".repeat(32));
  await prepareEnumAnnouncement([], `foreign-${crypto.randomUUID()}`, ["Yes", "No"], 1800000000);
  const before = await privateOracleSnapshot();
  const owner = createCreatorMarketsStore();
  await expect(importBrowserOracleBackup(f.record, owner)).rejects.toMatchObject({
    reason: "key-conflict",
  });
  expect((await privateOracleSnapshot()) === before).toBe(true);
  expect((await owner.getState().readOracleOwner(f.record.conditionId)) === null).toBe(true);
  await emptyPrivateTestStore();
});

it.each(["relay", "decode", "post-success", "post-failure"] as const)(
  "blocks subsequent network stages after identity changes during %s",
  async (stage) => {
    const f = await fixture();
    const owner = await deliveryOwner("imported", f);
    const reached = oracleGate();
    const release = oracleGate();
    const decode = vi.mocked(decodeOracleAttestation);
    const originalDecode = decode.getMockImplementation()!;
    let paused = false;
    if (stage === "relay") {
      oracleNetwork.publish.mockImplementation(async (_relays, json: string) => {
        reached.resolve();
        await release.promise;
        return JSON.parse(json).id;
      });
    }
    if (stage === "decode") {
      decode.mockImplementation(async (hex) => {
        const result = await originalDecode(hex);
        if (!paused && oracleNetwork.publish.mock.calls.length > 0) {
          paused = true;
          reached.resolve();
          await release.promise;
        }
        return result;
      });
    }
    const network = vi.fn(async () => {
      if (stage === "post-success" || stage === "post-failure") {
        reached.resolve();
        await release.promise;
      }
      if (stage === "post-failure") throw new Error("Controlled lost POST response.");
      return Response.json({});
    });
    vi.stubGlobal("fetch", network);
    const read = vi.fn(async () => null);
    try {
      const pending = publishBrowserOracleOutcome(
        f.record.conditionId,
        "YES",
        undefined,
        [],
        owner,
        read,
      );
      await reached.promise;
      useSettingsStore.setState({ nsecSecret: "22".repeat(32) });
      release.resolve();
      await expect(pending).rejects.toMatchObject({ reason: "identity-changed" });
      expect(network.mock.calls.length).toBe(stage.startsWith("post-") ? 1 : 0);
      expect(read.mock.calls.length).toBe(0);
      const saved = await owner.getState().readOraclePublication(f.record.conditionId);
      expect(saved?.relayPublished).toBe(true);
      expect(saved?.binding.oraclePubkey === f.record.oraclePubkey).toBe(true);
      expect(vi.mocked(requestBrowserOracleBackup).mock.calls.length).toBe(0);
    } finally {
      decode.mockImplementation(originalDecode);
    }
  },
);
