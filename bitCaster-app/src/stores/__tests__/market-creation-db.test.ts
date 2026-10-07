// @vitest-environment node
import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, expect, it, vi } from "vitest";
import { finalizeEvent } from "nostr-tools/pure";
import {
  CreateMarketError,
  completeDurableMarketCreation,
  deriveDurableCustodyScopeId,
  type MarketCreationPreparation,
  type MarketCreationCoordinatorAdapters,
} from "@bitcaster/client-sdk";
import { browserWalletDatabaseName } from "@/lib/browserWalletProfile";
import { BitcasterDB } from "../proof-db";
import { BrowserMarketCreationStore } from "../market-creation-db";

const walletId = "22".repeat(32);
const scopeId = deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId });
const databaseName = browserWalletDatabaseName(scopeId);
const databases: BitcasterDB[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Dexie.delete(databaseName);
});

function preparation(): MarketCreationPreparation {
  const signed = finalizeEvent(
    { kind: 88, created_at: 1_700_000_000, tags: [], content: "fixture" },
    new Uint8Array(32).fill(17),
  );
  return {
    creationId: "saved-creation",
    eventId: "saved-event",
    creatorId: signed.pubkey,
    walletId,
    walletScopeId: scopeId,
    mintUrl: "https://mint.example",
    engineBaseUrl: "https://engine.example",
    relayUrls: ["wss://relay.example"],
    metadata: {
      title: "Saved market",
      description: "Original description",
      baseAsset: "sat",
      outcomes: [{ name: "Yes" }, { name: "No" }],
      oracleAnnouncementHex: "aabb",
    },
    announcement: {
      conditionId: "33".repeat(32),
      announcementTlvHex: "aabb",
      announcementNostrEventJson: JSON.stringify(signed),
    },
    registration: {
      feeOperationRef: "original-fee",
      feeAmount: 7,
      feeUnit: "msat",
    },
    thumbnail: {
      data: new Uint8Array(2 * 1024 * 1024).fill(42),
      filename: "original.png",
      contentType: "image/png",
    },
  };
}

function open(input: MarketCreationPreparation) {
  const database = new BitcasterDB(databaseName);
  databases.push(database);
  return {
    database,
    store: new BrowserMarketCreationStore(database, input, () => input),
  };
}

it("keeps exact terminal engine retries and refuses a changed engine result", async () => {
  const input = preparation();
  const { store } = open(input);
  await store.reserve(input);
  await store.confirmMint(input.creationId);
  const result = {
    conditionId: input.announcement.conditionId,
    baseAsset: "sat" as const,
    divisibility: 1000 as const,
    marketsCreated: input.metadata.outcomes.map(
      ({ name }) => `${input.announcement.conditionId}-${name}`,
    ),
    thumbnailUrl: "/original-thumbnail",
  };
  await store.confirmEngine(input.creationId, result);
  expect((await store.confirmEngine(input.creationId, result)).engineResult).toEqual(result);
  await expect(
    store.confirmEngine(input.creationId, {
      ...result,
      thumbnailUrl: "/different-thumbnail",
    }),
  ).rejects.toThrow("conflicts");
  expect((await store.read(input.creationId))?.engineResult).toEqual(result);
});

it("reloads the original thumbnail and resumes a paid engine rejection with one fee operation", async () => {
  const input = preparation();
  const first = open(input);
  const fee = vi.fn(async () => "ready" as const);
  const publish = vi.fn(async () => {});
  const registerMint = vi.fn(async () => ({
    condition_id: input.announcement.conditionId,
  }));
  const result = {
    conditionId: input.announcement.conditionId,
    baseAsset: "sat" as const,
    divisibility: 1000 as const,
    marketsCreated: input.metadata.outcomes.map(
      ({ name }) => `${input.announcement.conditionId}-${name}`,
    ),
  };
  const createEngine = vi
    .fn()
    .mockRejectedValueOnce(new CreateMarketError("engine rejected", 401, false))
    .mockResolvedValue(result);
  const adapters: MarketCreationCoordinatorAdapters = {
    store: first.store,
    prepareFee: fee,
    confirmFee: async () => {},
    publishAnnouncement: publish,
    lookupMint: async () => null,
    registerMint,
    lookupEngine: async () => null,
    createEngine,
  };
  await expect(completeDurableMarketCreation(adapters, input, input)).rejects.toThrow(
    "engine rejected",
  );
  first.database.close();
  input.thumbnail!.data.fill(0);

  const restarted = open(input);
  const retained = await restarted.store.read(input.creationId);
  expect(retained?.mintConfirmed).toBe(true);
  expect(retained?.engineResult).toBeNull();
  expect(retained?.thumbnail?.data.byteLength).toBe(2 * 1024 * 1024);
  expect(retained?.thumbnail?.data.every((value) => value === 42)).toBe(true);
  expect(retained?.registration.feeOperationRef).toBe("original-fee");
  expect(retained?.announcement.announcementNostrEventJson).toBe(
    input.announcement.announcementNostrEventJson,
  );
  expect(
    (await completeDurableMarketCreation({ ...adapters, store: restarted.store }, retained!, input))
      .status,
  ).toBe("created");
  expect(fee).toHaveBeenCalledOnce();
  expect(publish).toHaveBeenCalledOnce();
  expect(registerMint).toHaveBeenCalledOnce();
  expect(createEngine).toHaveBeenCalledTimes(2);
});

it.each(["metadata", "thumbnail", "registration"] as const)(
  "refuses changed %s without overwriting preparation",
  async (field) => {
    const input = preparation();
    const { store } = open(input);
    await store.reserve(input);
    const changed = structuredClone(input);
    let requested = changed;
    switch (field) {
      case "metadata":
        changed.metadata.title = "Changed title";
        break;
      case "thumbnail":
        changed.thumbnail!.data[0] = 0;
        break;
      case "registration":
        requested = {
          ...changed,
          registration: { ...changed.registration, feeOperationRef: "new-fee" },
        };
        break;
    }
    await expect(store.reserve(requested)).rejects.toThrow("facts cannot change");
    expect((await store.read(input.creationId))?.metadata.title).toBe("Saved market");
  },
);

it("refuses changed active identity before reading or mutating stored progress", async () => {
  const input = preparation();
  const { database } = open(input);
  let active = { ...input };
  const store = new BrowserMarketCreationStore(database, input, () => active);
  await store.reserve(input);
  active = { ...input, creatorId: "different-creator" };
  await expect(store.confirmMint(input.creationId)).rejects.toThrow("original creator");
  expect((await database.marketCreations.get([scopeId, input.creationId]))?.mintConfirmed).toBe(
    false,
  );
});

it("stops every external effect if the IndexedDB preparation write fails", async () => {
  const input = preparation();
  const { database, store } = open(input);
  database.marketCreations.hook("creating", () => {
    throw new Error("storage unavailable");
  });
  const effect = vi.fn(async () => {
    throw new Error("unexpected effect");
  });
  await expect(
    completeDurableMarketCreation(
      {
        store,
        prepareFee: effect,
        confirmFee: effect,
        publishAnnouncement: effect,
        lookupMint: effect,
        registerMint: effect,
        lookupEngine: effect,
        createEngine: effect,
      },
      input,
      input,
    ),
  ).rejects.toThrow("storage unavailable");
  expect(effect).not.toHaveBeenCalled();
  expect(await database.marketCreations.count()).toBe(0);
});
