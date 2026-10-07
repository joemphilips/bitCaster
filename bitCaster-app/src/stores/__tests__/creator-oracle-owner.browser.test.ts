import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createCreatorMarketsStore,
  creatorOraclePublicationStore,
  type BrowserOracleLockedPort,
} from "../creatorMarkets";
import {
  creatorMarketFixture,
  creatorOracleMetadata as metadata,
  creatorOraclePublication as publication,
} from "@/test/creatorOracleFixture";
import {
  fixture,
  deliveryOwner,
  saveRelayConfirmedResult,
} from "@/test/oracleBackupProviderFixture";
import { importBrowserOracleBackup } from "@/lib/browserOracleBackup";
import { createBrowserOracleBackupDeliveryAdapters } from "@/lib/browserOracleBackupDelivery";
import { publishBrowserOracleOutcome } from "@/lib/oracleAttestation";
import { useSettingsStore } from "@/stores/settings";
import { resetKormir } from "@/lib/kormir";
import { publicCreatorMarket } from "@/lib/nip78CreatorMarkets";

const tabs: Window[] = [];
beforeEach(() => {
  expect(navigator.locks).toBeDefined();
  localStorage.clear();
  resetKormir();
  useSettingsStore.setState({ nostrSignerMode: "nsec", nsecSecret: "11".repeat(32) });
});
afterEach(() => {
  for (const tab of tabs.splice(0)) tab.close();
});

/** Separate same-origin browsing contexts have independent modules and caches. */
async function openOwnerTab() {
  const tab = window.open("about:blank", "_blank");
  if (!tab) throw new Error("Independent browser tab is unavailable.");
  tabs.push(tab);
  const module = await new Promise<typeof import("../creatorMarkets")>((resolve, reject) => {
    const target = tab as Window & {
      ownerLoaded?: (module: typeof import("../creatorMarkets")) => void;
      ownerFailed?: () => void;
    };
    target.ownerLoaded = resolve;
    target.ownerFailed = () => reject(new Error("Independent owner module is unavailable."));
    const script = tab.document.createElement("script");
    script.type = "module";
    script.textContent = `import(${JSON.stringify(`${location.origin}/src/stores/creatorMarkets.ts`)}).then(window.ownerLoaded, window.ownerFailed)`;
    tab.document.head.append(script);
  });
  expect(tab.navigator.locks).toBeDefined();
  return {
    tab,
    owner: module,
    store: module.createCreatorMarketsStore(),
    publication: module.creatorOraclePublicationStore,
  };
}

it("preserves different-condition updates from independent tabs with stale caches", async () => {
  const a = await openOwnerTab();
  const b = await openOwnerTab();
  expect(a.store.getState().markets).toEqual([]);
  expect(b.store.getState().markets).toEqual([]);
  await Promise.all([
    a.store.getState().saveCreatedMarket(creatorMarketFixture("a".repeat(64))),
    b.store.getState().saveCreatedMarket(creatorMarketFixture("b".repeat(64))),
  ]);
  const reopened = createCreatorMarketsStore();
  expect(
    reopened
      .getState()
      .markets.map((market) => market.conditionId)
      .sort(),
  ).toEqual(["a".repeat(64), "b".repeat(64)]);
});

it("retains one choice from independent tabs and reloads that exact choice", async () => {
  await createCreatorMarketsStore().getState().retainImportedOracleMetadata(metadata);
  const a = await openOwnerTab();
  const b = await openOwnerTab();
  const outcomes = await Promise.allSettled([
    a.publication(a.store).saveChoice(metadata.binding, "YES"),
    b.publication(b.store).saveChoice(metadata.binding, "NO"),
  ]);
  expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
  const winner = outcomes.find((result) => result.status === "fulfilled")!;
  if (winner.status !== "fulfilled") throw new Error("One choice is required.");
  expect(
    (
      await createCreatorMarketsStore()
        .getState()
        .readOraclePublication(metadata.binding.conditionId)
    )?.chosenOutcome,
  ).toBe(winner.value.chosenOutcome);
});

it("reloads metadata before completion, retains original destinations, and excludes imported mirror rows", async () => {
  const store = createCreatorMarketsStore();
  await store.getState().retainImportedOracleMetadata(metadata);
  const reopened = createCreatorMarketsStore();
  const before = await reopened.getState().readOracleOwner(metadata.binding.conditionId);
  expect(before?.kind).toBe("imported");
  if (before?.kind !== "imported") throw new Error("Imported metadata required.");
  expect(before.oracle.importComplete).toBe(false);
  expect(before.oracle.destinations).toEqual(metadata.destinations);
  expect(before.oracle.publication).toBeNull();
  await reopened
    .getState()
    .mergeRemoteMarkets([creatorMarketFixture(metadata.binding.conditionId)]);
  expect(reopened.getState().markets).toEqual([]);
  await expect(
    reopened.getState().retainImportedOracleMetadata({
      ...metadata,
      destinations: { ...metadata.destinations, relayUrls: ["wss://changed.example"] },
    }),
  ).rejects.toThrow("conflicts");
  await reopened.getState().withOracleMutation(async (locked) => {
    await locked.save(metadata.binding.conditionId, publication);
    expect((await locked.readOwner(metadata.binding.conditionId))?.kind).toBe("imported");
    await locked.markImportComplete(metadata.binding.conditionId);
  });
  const complete = await createCreatorMarketsStore()
    .getState()
    .readOracleOwner(metadata.binding.conditionId);
  if (complete?.kind !== "imported") throw new Error("Imported metadata required.");
  expect(complete.oracle.importComplete).toBe(true);
  expect(complete.oracle.publication?.attestation?.eventJson).toBe(
    publication.attestation!.eventJson,
  );
  expect(complete.oracle.destinations).toEqual(metadata.destinations);
  expect(localStorage.getItem("bitcaster-creator-markets")).not.toMatch(
    /nonceScalarHex|schemaVersion|creatorFeePercent|createdAt/,
  );
});

it("preserves exact handoff and monotonic progress during mirror and failure writes", async () => {
  const first = createCreatorMarketsStore();
  const second = createCreatorMarketsStore();
  await first.getState().retainImportedOracleMetadata(metadata);
  await first.getState().saveOraclePublication(metadata.binding.conditionId, publication);
  const port = creatorOraclePublicationStore(second);
  await Promise.all([
    port.confirmRelay(
      metadata.binding.conditionId,
      JSON.parse(publication.attestation!.eventJson).id,
    ),
    first.getState().mergeRemoteMarkets([creatorMarketFixture()]),
    first.getState().saveOraclePublicationFailures(metadata.binding.conditionId, ["engine"]),
  ]);
  await second.getState().saveOraclePublication(metadata.binding.conditionId, publication);
  const reopened = createCreatorMarketsStore();
  const owner = await reopened.getState().readOracleOwner(metadata.binding.conditionId);
  if (owner?.kind !== "imported") throw new Error("Imported metadata required.");
  expect(owner.oracle.publication?.relayPublished).toBe(true);
  expect(owner.oracle.publication?.attestation?.eventJson).toBe(publication.attestation!.eventJson);
  expect(owner.oracle.publicationFailures).toEqual(["engine"]);
  expect(reopened.getState().markets).toHaveLength(1);
  expect(JSON.stringify(reopened.getState().markets.map(publicCreatorMarket))).not.toMatch(
    /destinations|importComplete|publicationFailures/,
  );
});

it("keeps metadata durable after a later write failure and refuses an expired locked port", async () => {
  let fail = false;
  const storage = {
    getItem: (key: string) => localStorage.getItem(key),
    removeItem: (key: string) => localStorage.removeItem(key),
    setItem: (key: string, value: string) => {
      if (fail) throw new Error("Fixture storage refused.");
      localStorage.setItem(key, value);
    },
  };
  const store = createCreatorMarketsStore(() => storage);
  let retained: BrowserOracleLockedPort | undefined;
  await expect(
    store.getState().withOracleMutation(async (locked) => {
      retained = locked;
      await locked.retainImportMetadata(metadata);
      fail = true;
      await locked.save(metadata.binding.conditionId, publication);
    }),
  ).rejects.toThrow("Fixture storage refused.");
  const reopened = createCreatorMarketsStore();
  const owner = await reopened.getState().readOracleOwner(metadata.binding.conditionId);
  if (owner?.kind !== "imported") throw new Error("Imported metadata required.");
  expect(owner.oracle.publication).toBeNull();
  expect(owner.oracle.importComplete).toBe(false);
  expect(owner.oracle.destinations).toEqual(metadata.destinations);
  await expect(retained!.markImportComplete(metadata.binding.conditionId)).rejects.toThrow(
    "expired",
  );
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("retains one encrypted stage across independent tabs, different conditions, and mirror writes", async () => {
  const f = await fixture();
  const g = await fixture();
  await deliveryOwner("created", f);
  await deliveryOwner("created", g);
  const a = await openOwnerTab();
  const b = await openOwnerTab();
  const adapterA = createBrowserOracleBackupDeliveryAdapters({
    store: a.store,
    nowSeconds: () => 1_800_000_002,
  });
  const adapterB = createBrowserOracleBackupDeliveryAdapters({
    store: b.store,
    nowSeconds: () => 1_800_000_002,
  });
  const [first, second, other] = await Promise.all([
    adapterA.store.prepare(f.record.conditionId),
    adapterB.store.prepare(f.record.conditionId),
    adapterA.store.prepare(g.record.conditionId),
    b.store.getState().mergeRemoteMarkets([creatorMarketFixture("c".repeat(64))]),
  ]);
  expect(first.current!.eventJson === second.current!.eventJson).toBe(true);
  expect(first.current!.eventId === other.current!.eventId).toBe(false);
  const reopened = createCreatorMarketsStore();
  expect(reopened.getState().markets.length).toBe(3);
  expect(
    (await reopened.getState().readOracleBackupDelivery(f.record.conditionId))?.current
      ?.eventJson === first.current!.eventJson,
  ).toBe(true);
  expect(
    (await reopened.getState().readOracleBackupDelivery(g.record.conditionId))?.current
      ?.eventJson === other.current!.eventJson,
  ).toBe(true);
  await saveRelayConfirmedResult(f, reopened);
  const terminal = await createBrowserOracleBackupDeliveryAdapters({
    store: reopened,
    nowSeconds: () => 1_800_000_001,
  }).store.prepare(f.record.conditionId);
  await expect(
    a.store.getState().confirmOracleBackupDelivery(f.record.conditionId, {
      kind: "backup",
      eventId: first.current!.eventId,
      relayUrl: f.record.destinations.relayUrls[0],
    }),
  ).rejects.toThrow("invalid-acknowledgment");
  expect(
    (await b.store.getState().readOracleBackupDelivery(f.record.conditionId))?.current
      ?.eventJson === terminal.current!.eventJson,
  ).toBe(true);
});

it("keeps independent-tab signing outside an in-progress encrypted stage write", async () => {
  const f = await fixture();
  f.record = { ...f.record, destinations: { ...f.record.destinations, relayUrls: [] } };
  const entered = deferred();
  const release = deferred();
  let pause = true;
  const owner = createCreatorMarketsStore(() => ({
    getItem: (key) => localStorage.getItem(key),
    removeItem: (key) => localStorage.removeItem(key),
    setItem: async (key, value) => {
      if (pause && JSON.parse(value).state.importedOracles[0]?.backupDelivery?.current) {
        entered.resolve();
        await release.promise;
      }
      localStorage.setItem(key, value);
    },
  }));
  await importBrowserOracleBackup(f.record, owner);
  const second = await openOwnerTab();
  const queued = deferred();
  const signingOwner = second.owner.createCreatorMarketsStore(undefined, () => ({
    request: async (name, action) => {
      queued.resolve();
      return await second.tab.navigator.locks.request(name, action);
    },
  }));
  const preparing = createBrowserOracleBackupDeliveryAdapters({
    store: owner,
    nowSeconds: () => 1_800_000_002,
  }).store.prepare(f.record.conditionId);
  let signing: ReturnType<typeof publishBrowserOracleOutcome>;
  try {
    await providerBarrier(entered.promise, "stage write");
    signing = publishBrowserOracleOutcome(
      f.record.conditionId,
      "YES",
      undefined,
      [],
      signingOwner,
      async () => {
        throw new Error("Relay-only signing cannot read the engine.");
      },
      { engineDelivery: "relay-only" },
    );
    await providerBarrier(queued.promise, "signing lock");
    expect((await owner.getState().readOraclePublication(f.record.conditionId)) === null).toBe(
      true,
    );
  } finally {
    pause = false;
    release.resolve();
  }
  const initial = await preparing;
  const result = await signing;
  expect(result.record.chosenOutcome).toBe("YES");
  expect(result.record.attestation != null).toBe(true);
  expect(result.record.relayPublished).toBe(false);
  expect(
    (await signingOwner.getState().readOracleBackupDelivery(f.record.conditionId))?.current
      ?.eventJson === initial.current!.eventJson,
  ).toBe(true);
  await creatorOraclePublicationStore(signingOwner).confirmRelay(
    f.record.conditionId,
    JSON.parse(result.record.attestation!.eventJson).id,
  );
  const terminal = await createBrowserOracleBackupDeliveryAdapters({
    store: signingOwner,
    nowSeconds: () => 1_800_000_002,
  }).store.prepare(f.record.conditionId);
  expect(terminal.current?.mode).toBe("terminal");
  expect(terminal.knownEventIds.includes(initial.current!.eventId)).toBe(true);
});

async function providerBarrier(promise: Promise<void>, phase: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Provider barrier timed out: ${phase}.`)), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
