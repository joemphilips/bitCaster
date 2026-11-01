import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNotificationsStore } from "@/stores/notifications";
import type { PortfolioCustodyProofMetadata } from "@/stores/portfolio-custody";
import {
  createHeldPositionCloseReconciler,
  useHeldPositionCloseMarkerStore,
} from "../heldPositionCloseNotifications";

type CatalogueFacts = { state: "open" | "closed"; finalOutcome: string | null; title: string };

const MINT = "https://mint.example";
const SCOPE = `custody:wallet:${"a".repeat(64)}`;
const SECOND_SCOPE = `custody:wallet:${"b".repeat(64)}`;
const MARKER_STORAGE_KEY = "bitcaster-held-position-close-markers";

function conditionId(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function heldProof(
  condition: string,
  outcomeCollection: string,
  overrides: Partial<PortfolioCustodyProofMetadata> = {},
): PortfolioCustodyProofMetadata {
  return {
    normalizedMint: MINT,
    unit: "msat",
    assetKind: "conditional",
    conditionId: condition,
    outcomeCollection,
    baseAsset: "sat",
    amount: 2_000,
    keysetId: "00aa",
    proofId: `${condition}-${outcomeCollection}-${overrides.normalizedMint ?? MINT}`,
    revision: 1,
    selectability: "selectable",
    reservationOperationId: null,
    receivedAtMs: 1_700_000_000_000,
    claimRecoveryPending: false,
    ...overrides,
  };
}

let catalogue: Map<string, CatalogueFacts>;
let catalogueRequests: Array<{ ids: string[]; state: string | null; pageSize: string | null }>;
let custodyReads: number;

function stubCatalogue() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      expect(url.pathname).toBe("/api/v1/markets/query");
      const ids = url.searchParams.get("ids")?.split(",") ?? [];
      catalogueRequests.push({
        ids,
        state: url.searchParams.get("state"),
        pageSize: url.searchParams.get("page_size"),
      });
      const markets = ids.flatMap((id) => {
        const facts = catalogue.get(id);
        return facts ? [{ conditionId: id, ...facts }] : [];
      });
      return new Response(JSON.stringify({ markets, nextCursor: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

function reconciler(
  proofs: () => readonly PortfolioCustodyProofMetadata[] | null,
  scopeId: string = SCOPE,
) {
  return createHeldPositionCloseReconciler({
    scopeId,
    isCurrent: () => true,
    readCustody: async () => {
      custodyReads += 1;
      return proofs();
    },
    now: () => 1_800_000_000_000,
  });
}

function closeMarket(condition: string, finalOutcome: string | null, title: string) {
  catalogue.set(condition, { state: "closed", finalOutcome, title });
}

function bell() {
  return useNotificationsStore.getState().items;
}

function markedConditions(scopeId: string = SCOPE): string[] {
  return Object.keys(useHeldPositionCloseMarkerStore.getState().markers[scopeId] ?? {}).sort();
}

beforeEach(() => {
  localStorage.clear();
  useNotificationsStore.setState({ items: [] });
  useHeldPositionCloseMarkerStore.setState({ markers: {} });
  catalogue = new Map();
  catalogueRequests = [];
  custodyReads = 0;
  stubCatalogue();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("held position close notifications", () => {
  it("adds one won or lost entry only after a verified outcome", async () => {
    const won = conditionId(1);
    const lost = conditionId(2);
    const pending = conditionId(3);
    const open = conditionId(4);
    closeMarket(won, "YES", "Rain in Tokyo?");
    closeMarket(lost, "Bob", "Who wins?");
    closeMarket(pending, null, "Deadline closed");
    catalogue.set(open, { state: "open", finalOutcome: null, title: "Still trading" });
    const proofs = [
      heldProof(won, "YES"),
      heldProof(lost, "Alice"),
      heldProof(pending, "YES"),
      heldProof(open, "YES"),
    ];

    await reconciler(() => proofs).request();

    expect(
      bell().map(({ kind, marketId, marketTitle, conditionId: c }) => ({
        kind,
        marketId,
        marketTitle,
        conditionId: c,
      })),
    ).toEqual([
      {
        kind: "position_won",
        marketId: `${won}-YES`,
        marketTitle: "Rain in Tokyo?",
        conditionId: won,
      },
      {
        kind: "position_lost",
        marketId: `${lost}-Alice`,
        marketTitle: "Who wins?",
        conditionId: lost,
      },
    ]);
    expect(markedConditions()).toEqual([won, lost].sort());
  });

  it("adds the entry when a pending market later gets its verified outcome", async () => {
    const condition = conditionId(5);
    closeMarket(condition, null, "Late oracle");
    const run = reconciler(() => [heldProof(condition, "NO")]);

    await run.request();
    expect(bell()).toHaveLength(0);

    closeMarket(condition, "NO", "Late oracle");
    await run.request();
    expect(bell().map(({ kind }) => kind)).toEqual(["position_won"]);
  });

  it("does not add the entry again after the bell is cleared or the app reloads", async () => {
    const condition = conditionId(6);
    closeMarket(condition, "YES", "Once");
    const run = reconciler(() => [heldProof(condition, "YES")]);

    await run.request();
    expect(bell().map(({ kind }) => kind)).toEqual(["position_won"]);

    useNotificationsStore.getState().clear();
    catalogueRequests = [];
    await run.request();
    expect(bell()).toHaveLength(0);
    // A marked condition needs no catalogue read.
    expect(catalogueRequests).toEqual([]);

    // Reload: memory starts empty and the persisted marker is read back.
    const persisted = localStorage.getItem(MARKER_STORAGE_KEY)!;
    useHeldPositionCloseMarkerStore.setState({ markers: {} });
    localStorage.setItem(MARKER_STORAGE_KEY, persisted);
    await useHeldPositionCloseMarkerStore.persist.rehydrate();
    expect(markedConditions()).toEqual([condition]);
    await reconciler(() => [heldProof(condition, "YES")]).request();
    expect(bell()).toHaveLength(0);
  });

  it("adds one entry for each condition and prefers a held winning collection", async () => {
    const pair = conditionId(20);
    const composite = conditionId(21);
    const lostTwice = conditionId(22);
    closeMarket(pair, "YES", "Pair");
    closeMarket(composite, "C", "Composite");
    closeMarket(lostTwice, "C", "Lost twice");

    await reconciler(() => [
      heldProof(pair, "NO"),
      heldProof(pair, "YES"),
      heldProof(composite, "A"),
      heldProof(composite, "B|C"),
      heldProof(lostTwice, "A"),
      heldProof(lostTwice, "B"),
    ]).request();

    const byMarketId = (left: { marketId: string }, right: { marketId: string }) =>
      left.marketId.localeCompare(right.marketId);
    expect(
      bell()
        .map(({ kind, marketId }) => ({ kind, marketId }))
        .sort(byMarketId),
    ).toEqual(
      [
        { kind: "position_won", marketId: `${pair}-YES` },
        { kind: "position_won", marketId: `${composite}-B|C` },
        { kind: "position_lost", marketId: `${lostTwice}-A` },
      ].sort(byMarketId),
    );
  });

  it("gives a second wallet that holds the same condition its own entry", async () => {
    const condition = conditionId(23);
    closeMarket(condition, "YES", "Shared market");

    await reconciler(() => [heldProof(condition, "NO")], SCOPE).request();
    await reconciler(() => [heldProof(condition, "YES")], SECOND_SCOPE).request();

    expect(bell().map(({ kind }) => kind)).toEqual(["position_won", "position_lost"]);
    expect(new Set(bell().map(({ id }) => id)).size).toBe(2);
    expect(markedConditions(SCOPE)).toEqual([condition]);
    expect(markedConditions(SECOND_SCOPE)).toEqual([condition]);
  });

  it("adds at most 20 entries in one run, winners first, and adds the rest later", async () => {
    const won = Array.from({ length: 10 }, (_, index) => conditionId(300 + 2 * index));
    const lost = Array.from({ length: 20 }, (_, index) => conditionId(301 + 2 * index));
    for (const condition of [...won, ...lost]) closeMarket(condition, "YES", `Market ${condition}`);
    const proofs = [
      ...lost.map((condition) => heldProof(condition, "NO")),
      ...won.map((condition) => heldProof(condition, "YES")),
    ];
    const run = reconciler(() => proofs);

    await run.request();

    expect(bell()).toHaveLength(20);
    expect(
      bell()
        .slice(0, 10)
        .map(({ kind }) => kind),
    ).toEqual(Array(10).fill("position_won"));
    expect(
      bell()
        .slice(10)
        .map(({ kind }) => kind),
    ).toEqual(Array(10).fill("position_lost"));
    expect(markedConditions()).toEqual(
      bell()
        .map(({ conditionId: c }) => c!)
        .sort(),
    );

    useNotificationsStore.getState().clear();
    await run.request();
    expect(bell().map(({ kind }) => kind)).toEqual(Array(10).fill("position_lost"));
    expect(markedConditions()).toEqual([...won, ...lost].sort());

    useNotificationsStore.getState().clear();
    await run.request();
    expect(bell()).toHaveLength(0);
  });

  it("keeps the marker of every held condition, so a large wallet gets no repeated entry", async () => {
    const conditions = Array.from({ length: 600 }, (_, index) => conditionId(1_000 + index));
    for (const condition of conditions) closeMarket(condition, "YES", `Market ${condition}`);
    const proofs = conditions.map((condition) => heldProof(condition, "YES"));
    const run = reconciler(() => proofs);
    const notified = new Set<string>();

    // Each run adds a bounded number of entries; the bell keeps 100.
    for (let attempt = 0; attempt < 40 && notified.size < conditions.length; attempt += 1) {
      await run.request();
      for (const { conditionId: c } of bell()) notified.add(c!);
      useNotificationsStore.getState().clear();
    }
    expect(notified.size).toBe(conditions.length);

    catalogueRequests = [];
    await run.request();
    expect(bell()).toEqual([]);
    expect(catalogueRequests).toEqual([]);
  });

  it("forgets the marker of a condition that the wallet no longer holds", async () => {
    const sold = conditionId(30);
    const kept = conditionId(31);
    closeMarket(sold, "YES", "Claimed");
    closeMarket(kept, "NO", "Kept");
    let proofs = [heldProof(sold, "YES"), heldProof(kept, "YES")];
    const run = reconciler(() => proofs);

    await run.request();
    expect(markedConditions()).toEqual([sold, kept].sort());

    proofs = [heldProof(kept, "YES")];
    await run.request();
    expect(markedConditions()).toEqual([kept]);
    expect(bell()).toHaveLength(2);
  });

  it("keeps only well-formed persisted markers", async () => {
    const valid = conditionId(40);
    const invalid = conditionId(41);
    localStorage.setItem(
      MARKER_STORAGE_KEY,
      JSON.stringify({
        state: {
          markers: {
            [SCOPE]: { [valid]: 1_700_000_000_000, [invalid]: "yesterday" },
            [SECOND_SCOPE]: null,
            // A marker that names no wallet.
            [conditionId(42)]: 1_700_000_000_000,
          },
        },
        version: 0,
      }),
    );

    await useHeldPositionCloseMarkerStore.persist.rehydrate();

    expect(useHeldPositionCloseMarkerStore.getState().markers).toEqual({
      [SCOPE]: { [valid]: 1_700_000_000_000 },
    });
  });

  it("drops other wallets first when the safety bound is reached", async () => {
    const otherMarkers = Object.fromEntries(
      Array.from({ length: 5_000 }, (_, index) => [conditionId(10_000 + index), 1]),
    );
    useHeldPositionCloseMarkerStore.setState({ markers: { [SECOND_SCOPE]: otherMarkers } });
    const condition = conditionId(50);
    closeMarket(condition, "YES", "Current wallet");

    await reconciler(() => [heldProof(condition, "YES")]).request();

    expect(useHeldPositionCloseMarkerStore.getState().markers).toEqual({
      [SCOPE]: { [condition]: 1_800_000_000_000 },
    });
  });

  it("reads the catalogue in one-page batches of at most 50 IDs", async () => {
    const proofs = Array.from({ length: 120 }, (_, index) => {
      catalogue.set(conditionId(100 + index), {
        state: "open",
        finalOutcome: null,
        title: `Market ${index}`,
      });
      return heldProof(conditionId(100 + index), "YES");
    });
    closeMarket(conditionId(215), "YES", "Market 115");

    await reconciler(() => proofs).request();

    expect(catalogueRequests).toHaveLength(3);
    for (const { ids, state, pageSize } of catalogueRequests) {
      expect(ids.length).toBeLessThanOrEqual(50);
      expect(pageSize).toBe(String(ids.length));
      expect(state).toBe("All");
    }
    expect(new Set(catalogueRequests.flatMap(({ ids }) => ids)).size).toBe(120);
    expect(bell().map(({ marketTitle }) => marketTitle)).toEqual(["Market 115"]);
  });

  it("uses a verified live close before the catalogue reports it", async () => {
    const condition = conditionId(7);
    catalogue.set(condition, { state: "open", finalOutcome: null, title: "Live" });
    const run = reconciler(() => [heldProof(condition, "Alice|Bob")]);

    await run.request({ conditionId: condition, state: "closed", finalOutcome: "Carol" });

    expect(bell().map(({ kind, marketId }) => ({ kind, marketId }))).toEqual([
      { kind: "position_lost", marketId: `${condition}-Alice|Bob` },
    ]);
  });

  it("ignores a live close without a verified outcome", async () => {
    const condition = conditionId(8);
    catalogue.set(condition, { state: "open", finalOutcome: null, title: "Deadline" });

    await reconciler(() => [heldProof(condition, "YES")]).request({
      conditionId: condition,
      state: "closed",
      finalOutcome: null,
    });

    expect(bell()).toHaveLength(0);
    expect(markedConditions()).toEqual([]);
  });

  it("reads the catalogue only for a pushed condition that the wallet holds", async () => {
    const pushed = conditionId(60);
    const other = conditionId(61);
    const notHeld = conditionId(62);
    for (const condition of [pushed, other, notHeld])
      catalogue.set(condition, { state: "open", finalOutcome: null, title: "Open" });
    const run = reconciler(() => [heldProof(pushed, "YES"), heldProof(other, "YES")]);

    await run.request({ conditionId: notHeld, state: "closed", finalOutcome: "YES" });
    expect(catalogueRequests).toEqual([]);
    expect(bell()).toHaveLength(0);

    await run.request({ conditionId: pushed, state: "closed", finalOutcome: "YES" });
    expect(catalogueRequests.map(({ ids }) => ids)).toEqual([[pushed]]);
    expect(bell().map(({ conditionId: c }) => c)).toEqual([pushed]);
  });

  it("keeps one entry for the same position at two mints and ignores retained history", async () => {
    const condition = conditionId(9);
    const history = conditionId(10);
    closeMarket(condition, "YES", "Two mints");
    closeMarket(history, "YES", "History");

    await reconciler(() => [
      heldProof(condition, "YES"),
      heldProof(condition, "YES", { normalizedMint: "https://second.example" }),
      heldProof(history, "YES", { selectability: "retained-unverified" }),
    ]).request();

    expect(bell().map(({ marketId }) => marketId)).toEqual([`${condition}-YES`]);
  });

  it("coalesces concurrent requests into one more run", async () => {
    const condition = conditionId(11);
    closeMarket(condition, "YES", "Twice");
    const run = reconciler(() => [heldProof(condition, "YES")]);

    await Promise.all([run.request(), run.request(), run.request()]);

    // The first run reads both sources. The two requests that arrive during it
    // share one more run, which finds the condition marked.
    expect(custodyReads).toBe(2);
    expect(catalogueRequests).toHaveLength(1);
    expect(bell()).toHaveLength(1);
  });

  it("adds nothing when the wallet changes during the read", async () => {
    const condition = conditionId(12);
    closeMarket(condition, "YES", "Old wallet");
    let current = true;
    const run = createHeldPositionCloseReconciler({
      scopeId: SCOPE,
      isCurrent: () => current,
      readCustody: async () => {
        current = false;
        return [heldProof(condition, "YES")];
      },
    });

    await run.request();

    expect(bell()).toHaveLength(0);
    expect(useHeldPositionCloseMarkerStore.getState().markers).toEqual({});
  });
});
