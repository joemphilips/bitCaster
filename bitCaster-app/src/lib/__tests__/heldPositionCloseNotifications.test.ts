import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNotificationsStore } from "@/stores/notifications";
import type { PortfolioCustodyProofMetadata } from "@/stores/portfolio-custody";
import {
  createHeldPositionCloseReconciler,
  useHeldPositionCloseMarkerStore,
} from "../heldPositionCloseNotifications";

type CatalogueFacts = { state: "open" | "closed"; finalOutcome: string | null; title: string };

const MINT = "https://mint.example";

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
let requestedIdBatches: string[][];

function stubCatalogue() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      expect(url.pathname).toBe("/api/v1/markets/query");
      const ids = url.searchParams.get("ids")?.split(",") ?? [];
      requestedIdBatches.push(ids);
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

function reconciler(proofs: () => readonly PortfolioCustodyProofMetadata[] | null) {
  return createHeldPositionCloseReconciler({
    isCurrent: () => true,
    readCustody: async () => proofs(),
    now: () => 1_800_000_000_000,
  });
}

function bell() {
  return useNotificationsStore.getState().items;
}

beforeEach(() => {
  localStorage.clear();
  useNotificationsStore.setState({ items: [] });
  useHeldPositionCloseMarkerStore.setState({ markers: {} });
  catalogue = new Map();
  requestedIdBatches = [];
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
    catalogue.set(won, { state: "closed", finalOutcome: "YES", title: "Rain in Tokyo?" });
    catalogue.set(lost, { state: "closed", finalOutcome: "Bob", title: "Who wins?" });
    catalogue.set(pending, { state: "closed", finalOutcome: null, title: "Deadline closed" });
    catalogue.set(open, { state: "open", finalOutcome: null, title: "Still trading" });
    const proofs = [
      heldProof(won, "YES"),
      heldProof(lost, "Alice"),
      heldProof(pending, "YES"),
      heldProof(open, "YES"),
    ];

    await reconciler(() => proofs).request();

    expect(
      bell().map(({ id, kind, marketId, marketTitle, conditionId: c }) => ({
        id,
        kind,
        marketId,
        marketTitle,
        conditionId: c,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          id: `${won}-YES-position_won`,
          kind: "position_won",
          marketId: `${won}-YES`,
          marketTitle: "Rain in Tokyo?",
          conditionId: won,
        },
        {
          id: `${lost}-Alice-position_lost`,
          kind: "position_lost",
          marketId: `${lost}-Alice`,
          marketTitle: "Who wins?",
          conditionId: lost,
        },
      ]),
    );
    expect(bell()).toHaveLength(2);
    expect(Object.keys(useHeldPositionCloseMarkerStore.getState().markers).sort()).toEqual(
      [won, lost].sort(),
    );
  });

  it("adds the entry when a pending market later gets its verified outcome", async () => {
    const condition = conditionId(5);
    catalogue.set(condition, { state: "closed", finalOutcome: null, title: "Late oracle" });
    const run = reconciler(() => [heldProof(condition, "NO")]);

    await run.request();
    expect(bell()).toHaveLength(0);

    catalogue.set(condition, { state: "closed", finalOutcome: "NO", title: "Late oracle" });
    await run.request();
    expect(bell().map(({ kind }) => kind)).toEqual(["position_won"]);
  });

  it("does not add the entries again after the bell is cleared or the app reloads", async () => {
    const condition = conditionId(6);
    catalogue.set(condition, { state: "closed", finalOutcome: "YES", title: "Once" });
    const run = reconciler(() => [heldProof(condition, "YES"), heldProof(condition, "NO")]);

    await run.request();
    expect(
      bell()
        .map(({ kind }) => kind)
        .sort(),
    ).toEqual(["position_lost", "position_won"]);

    useNotificationsStore.getState().clear();
    requestedIdBatches = [];
    await run.request();
    expect(bell()).toHaveLength(0);
    // A marked condition needs no catalogue read.
    expect(requestedIdBatches).toEqual([]);

    // Reload: memory starts empty and the persisted marker is read back.
    const persisted = localStorage.getItem("bitcaster-held-position-close-markers")!;
    useHeldPositionCloseMarkerStore.setState({ markers: {} });
    localStorage.setItem("bitcaster-held-position-close-markers", persisted);
    await useHeldPositionCloseMarkerStore.persist.rehydrate();
    expect(Object.keys(useHeldPositionCloseMarkerStore.getState().markers)).toEqual([condition]);
    await reconciler(() => [heldProof(condition, "YES")]).request();
    expect(bell()).toHaveLength(0);
  });

  it("reads the catalogue in batches of at most 100 IDs and reads every batch", async () => {
    const proofs = Array.from({ length: 120 }, (_, index) => {
      catalogue.set(conditionId(100 + index), {
        state: "open",
        finalOutcome: null,
        title: `Market ${index}`,
      });
      return heldProof(conditionId(100 + index), "YES");
    });
    catalogue.set(conditionId(215), {
      state: "closed",
      finalOutcome: "YES",
      title: "Market 115",
    });

    await reconciler(() => proofs).request();

    expect(requestedIdBatches.length).toBeGreaterThan(1);
    for (const ids of requestedIdBatches) expect(ids.length).toBeLessThanOrEqual(100);
    expect(new Set(requestedIdBatches.flat()).size).toBe(120);
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
    expect(useHeldPositionCloseMarkerStore.getState().markers).toEqual({});
  });

  it("keeps one entry for the same position at two mints and ignores retained history", async () => {
    const condition = conditionId(9);
    const history = conditionId(10);
    catalogue.set(condition, { state: "closed", finalOutcome: "YES", title: "Two mints" });
    catalogue.set(history, { state: "closed", finalOutcome: "YES", title: "History" });

    await reconciler(() => [
      heldProof(condition, "YES"),
      heldProof(condition, "YES", { normalizedMint: "https://second.example" }),
      heldProof(history, "YES", { selectability: "retained-unverified" }),
    ]).request();

    expect(bell().map(({ marketId }) => marketId)).toEqual([`${condition}-YES`]);
  });

  it("coalesces concurrent requests without a duplicate entry", async () => {
    const condition = conditionId(11);
    catalogue.set(condition, { state: "closed", finalOutcome: "YES", title: "Twice" });
    const run = reconciler(() => [heldProof(condition, "YES")]);

    await Promise.all([run.request(), run.request(), run.request()]);

    expect(bell()).toHaveLength(1);
  });

  it("adds nothing when the wallet changes during the read", async () => {
    const condition = conditionId(12);
    catalogue.set(condition, { state: "closed", finalOutcome: "YES", title: "Old wallet" });
    let current = true;
    const run = createHeldPositionCloseReconciler({
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

  it("bounds the markers and evicts the oldest", () => {
    const store = useHeldPositionCloseMarkerStore.getState();
    store.mark([conditionId(1)], 1);
    store.mark(
      Array.from({ length: 500 }, (_, index) => conditionId(1_000 + index)),
      2,
    );

    const markers = useHeldPositionCloseMarkerStore.getState().markers;
    expect(Object.keys(markers)).toHaveLength(500);
    expect(markers[conditionId(1)]).toBeUndefined();
  });
});
