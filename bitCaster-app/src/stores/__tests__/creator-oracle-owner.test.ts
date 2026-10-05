import { beforeEach, expect, it } from "vitest";
import { createCreatorMarketsStore } from "../creatorMarkets";
import { installCreatorDocumentLocks } from "@/test/creatorDocumentLocks";
import {
  creatorMarketFixture,
  creatorOracleMetadata as metadata,
  creatorOraclePublication as publication,
} from "@/test/creatorOracleFixture";
import { publicCreatorMarket } from "@/lib/nip78CreatorMarkets";

beforeEach(() => {
  localStorage.clear();
  installCreatorDocumentLocks();
});

it("retains imported public metadata before completion and excludes it from created-market discovery", async () => {
  const store = createCreatorMarketsStore();
  await store.getState().retainImportedOracleMetadata(metadata);
  const reopened = createCreatorMarketsStore();
  const owner = await reopened.getState().readOracleOwner(metadata.binding.conditionId);
  expect(owner?.kind).toBe("imported");
  if (owner?.kind !== "imported") throw new Error("Imported owner required.");
  expect(owner.oracle.importComplete).toBe(false);
  expect(owner.oracle.destinations).toEqual(metadata.destinations);
  expect(reopened.getState().markets).toEqual([]);
  expect(Object.keys(owner.oracle).sort()).toEqual([
    "announcementHex",
    "binding",
    "destinations",
    "importComplete",
    "publication",
  ]);
  await reopened.getState().markOracleImportComplete(metadata.binding.conditionId);
  expect(
    (await createCreatorMarketsStore().getState().readOracleOwner(metadata.binding.conditionId))
      ?.kind,
  ).toBe("imported");
});

it("enriches a matching created oracle without changing its paid creation facts", async () => {
  const store = createCreatorMarketsStore();
  const market = {
    ...creatorMarketFixture(metadata.binding.conditionId),
    oracle: {
      type: "self" as const,
      eventId: metadata.binding.oracleEventId,
      outcomes: [...metadata.binding.outcomes],
      announcementHex: metadata.announcementHex,
    },
  };
  await store.getState().saveCreatedMarket(market);
  await store.getState().retainImportedOracleMetadata(metadata);
  expect(store.getState().markets[0]).toMatchObject(market);
  expect(store.getState().importedOracles).toEqual([]);
  const projected = publicCreatorMarket(store.getState().markets[0]);
  expect(JSON.stringify(projected)).not.toMatch(
    /destinations|importComplete|original-mint|original-engine/,
  );
  await expect(
    store.getState().retainImportedOracleMetadata({
      ...metadata,
      destinations: { ...metadata.destinations, mintUrl: "https://new-mint.example" },
    }),
  ).rejects.toThrow("conflicts");
  expect(store.getState().markets[0].creatorFeePercent).toBe(0.02);
});

it("merges stale publication progress and refuses a conflicting exact event or choice", async () => {
  const store = createCreatorMarketsStore();
  await store.getState().retainImportedOracleMetadata(metadata);
  await store
    .getState()
    .saveOraclePublication(metadata.binding.conditionId, { ...publication, relayPublished: true });
  expect(
    (await store.getState().saveOraclePublication(metadata.binding.conditionId, publication))
      .relayPublished,
  ).toBe(true);
  await expect(
    store.getState().saveOraclePublication(metadata.binding.conditionId, {
      ...publication,
      chosenOutcome: "NO",
      attestation: null,
    }),
  ).rejects.toThrow("conflicts");
  expect(
    (await store.getState().readOraclePublication(metadata.binding.conditionId))?.attestation
      ?.eventJson,
  ).toBe(publication.attestation!.eventJson);
});

it("refuses unavailable cross-tab locking and never persists cache-only setState", async () => {
  const store = createCreatorMarketsStore(
    () => localStorage,
    () => undefined,
  );
  store.setState({ markets: [creatorMarketFixture()] });
  expect(localStorage.getItem("bitcaster-creator-markets")).toBeNull();
  expect(store.getState().hasOraclePersistence()).toBe(false);
  await expect(store.getState().saveCreatedMarket(creatorMarketFixture())).rejects.toThrow(
    "Cross-tab creator locking is unavailable.",
  );
  expect(localStorage.getItem("bitcaster-creator-markets")).toBeNull();
});

it("expires the already-locked port when the local operation ends", async () => {
  const store = createCreatorMarketsStore();
  const port = await store.getState().withOracleMutation(async (locked) => locked);
  await expect(port.retainImportMetadata(metadata)).rejects.toThrow("expired");
  expect(localStorage.getItem("bitcaster-creator-markets")).toBeNull();
});

it.each(["imported", "created"] as const)(
  "resets a completed %s owner before each import attempt and preserves exact public state",
  async (kind) => {
    const store = createCreatorMarketsStore();
    const market = creatorMarketFixture(metadata.binding.conditionId);
    if (kind === "created") {
      await store.getState().saveCreatedMarket({
        ...market,
        oracle: {
          type: "self",
          eventId: metadata.binding.oracleEventId,
          outcomes: [...metadata.binding.outcomes],
          announcementHex: metadata.announcementHex,
        },
      });
    }
    await store.getState().retainImportedOracleMetadata(metadata);
    await store.getState().saveOraclePublication(metadata.binding.conditionId, {
      ...publication,
      relayPublished: true,
    });
    await store.getState().markOracleImportComplete(metadata.binding.conditionId);
    const before = await store.getState().readOraclePublication(metadata.binding.conditionId);

    await store.getState().withOracleMutation(async (locked) => {
      const saved = await locked.retainImportMetadata(metadata);
      expect(saved.kind).toBe(kind);
      const oracle = saved.kind === "created" ? saved.market.oracle! : saved.oracle;
      expect(oracle.importComplete).toBe(false);
      expect(oracle.destinations).toEqual(metadata.destinations);
    });

    const reopened = createCreatorMarketsStore();
    const owner = await reopened.getState().readOracleOwner(metadata.binding.conditionId);
    expect(owner?.kind).toBe(kind);
    if (!owner) throw new Error("Retained owner required.");
    const oracle = owner.kind === "created" ? owner.market.oracle! : owner.oracle;
    expect(oracle.importComplete).toBe(false);
    expect(oracle.destinations).toEqual(metadata.destinations);
    const after = await reopened.getState().readOraclePublication(metadata.binding.conditionId);
    expect(JSON.stringify(after) === JSON.stringify(before)).toBe(true);
    if (owner.kind === "created") {
      const { oracle: _oracle, ...paidFacts } = owner.market;
      expect(paidFacts).toEqual(market);
    }
  },
);
