import "fake-indexeddb/auto";
import { Amount } from "@cashu/cashu-ts";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeAssetMonitoringOutcomeUniverseDigest,
  type AssetMonitoringPortfolioResponse,
} from "@bitcaster/client-sdk/assetMonitoring";
import { createBrowserCustodyProofRow } from "@/stores/durable-custody-db";
import { db } from "@/stores/proof-db";
import { usePortfolioState } from "../usePortfolioState";

const mocks = vi.hoisted(() => ({
  getPortfolio: vi.fn(),
  onRefresh: null as (() => void) | null,
  replaceConditionIds: vi.fn(async () => {}),
  walletId: "a".repeat(64),
  wallet: { setupComplete: true, mnemonic: "test mnemonic", mints: [] },
  settings: { nostrProfile: null, signerConnectionStatus: "disconnected" },
  activity: { items: [] },
}));
const walletId = "a".repeat(64);
const scopeId = `custody:wallet:${walletId}`;
const conditionId = "b".repeat(64);
const mintUrl = "https://mint.example";

// Keep the real database, custody reader and Dexie live-query implementation.
// Only the database name is isolated from other tests and browser profiles.
vi.mock("@/stores/proof-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/proof-db")>();
  const database = new actual.BitcasterDB(`portfolio-lifecycle-${crypto.randomUUID()}`);
  // fake-indexeddb clones through Node's realm; normalize only the byte field
  // into jsdom's realm, preserving actual validation and query subscriptions.
  database.custodyProofs.hook("reading", (row) => ({
    ...row,
    proofBody: Uint8Array.from(row.proofBody),
  }));
  return { ...actual, db: database };
});
vi.mock("@/stores/wallet", () => ({
  useWalletStore: (selector: (state: object) => unknown) => selector(mocks.wallet),
}));
vi.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: object) => unknown) => selector(mocks.settings),
}));
vi.mock("@/stores/activity-log", () => ({
  useActivityLogStore: (selector: (state: object) => unknown) => selector(mocks.activity),
}));
vi.mock("@/lib/browserWalletProfile", () => ({
  browserWalletIdFromMnemonic: () => mocks.walletId,
  browserWalletScopeIdFromMnemonic: () => `custody:wallet:${mocks.walletId}`,
  activeBrowserWalletScopeId: () => `custody:wallet:${mocks.walletId}`,
}));
vi.mock("@/lib/nostr", () => ({
  getNostrSignerRevision: () => 0,
  subscribeToNostrSignerRevision: () => () => {},
}));
vi.mock("@/lib/markets", () => ({
  createAuthenticatedBrowserEngineClient: () => ({ getPortfolio: mocks.getPortfolio }),
}));
vi.mock("@/lib/marketHub", () => ({
  observePortfolioValuations: (onRefresh: () => void) => {
    mocks.onRefresh = onRefresh;
    return { replaceConditionIds: mocks.replaceConditionIds, dispose: () => {} };
  },
}));

function readyPortfolio(value: number, ids = [conditionId]): AssetMonitoringPortfolioResponse {
  const state = {
    valuationRevision: `revision-${value}`,
    stale: false,
    incomplete: false,
    building: false,
  };
  return {
    summary: {
      ...state,
      collateralUnit: "msat",
      availableValueMsat: value,
      pendingOutgoingValueMsat: 0,
      estimatedTotalValueMsat: value,
      unvaluedAssetCount: 0,
      unvaluedAvailableSubunits: 0,
      unvaluedPendingOutgoingSubunits: 0,
    },
    assets: {
      ...state,
      assets: ids.map((conditionId) => ({
        asset: {
          kind: "conditional",
          canonicalMintUrl: mintUrl,
          cashuUnit: "msat",
          displayBaseAsset: "sat",
          conditionId,
          parentConditionId: "0".repeat(64),
          outcomeUniverseDigest: computeAssetMonitoringOutcomeUniverseDigest(["NO", "YES"]),
          internalOutcomeSetId: "YES",
        },
        availableSubunits: 5_000,
        pendingOutgoingSubunits: 0,
        estimatedValueMsat: value,
        valuationStatus: "valued",
        recoveryHint: null,
      })),
    },
    history: {
      ...state,
      timeframe: "ALL",
      points: [{ asOf: "2026-11-11T12:25:00.000Z", estimatedTotalValueMsat: value }],
    },
  };
}

beforeEach(async () => {
  await db.open();
  mocks.getPortfolio.mockReset();
  mocks.replaceConditionIds.mockClear();
  mocks.walletId = walletId;
  mocks.wallet.mnemonic = "test mnemonic";
});

async function seedCustody(ids = [conditionId]) {
  await db.custodyProofs.bulkPut(
    ids.map((id) =>
      createBrowserCustodyProofRow({
        scopeId,
        normalizedMint: mintUrl,
        unit: "msat",
        proof: {
          id: `01${"3".repeat(64)}`,
          amount: Amount.from(5_000),
          secret: `synthetic-lifecycle-proof-${id}`,
          C: `02${"5".repeat(64)}`,
        },
        asset: { kind: "conditional", conditionId: id, outcomeCollection: "YES" },
        receivedAtMs: 1,
      }),
    ),
  );
}

function catalogue() {
  let state: "open" | "closed" = "open";
  const fetch = vi.fn(async (url: string) => {
    const ids = new URL(url, "https://app.example").searchParams.get("ids")!.split(",");
    expect(ids.length).toBeLessThanOrEqual(50);
    return new Response(
      JSON.stringify({
        markets: ids.map((id) => ({
          conditionId: id,
          title: "Lifecycle test market",
          outcomes: ["NO", "YES"],
          divisibility: 1_000,
          state,
          finalOutcome: null,
        })),
      }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", fetch);
  return {
    fetch,
    close: () => {
      state = "closed";
    },
  };
}

async function notifyLifecycle() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await act(async () => {
    mocks.onRefresh!();
    await vi.advanceTimersByTimeAsync(15_000);
  });
  // React's committed dependency change schedules the new Dexie subscription.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  vi.useRealTimers();
}

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  db.close();
  await db.delete();
});

describe("Portfolio lifecycle catalogue refresh", () => {
  it.each([1, 51])(
    "refreshes closed/pending classification for %i unchanged conditions in bounded batches",
    async (count) => {
      const ids =
        count === 1
          ? [conditionId]
          : Array.from({ length: count }, (_, index) => (index + 1).toString(16).padStart(64, "0"));
      const batches = Math.ceil(count / 50);
      const monotonicNow = vi.spyOn(performance, "now").mockReturnValue(0);
      await seedCustody(ids);
      const originalCustody = await db.custodyProofs.toArray();
      const markets = catalogue();
      mocks.getPortfolio
        .mockResolvedValueOnce(readyPortfolio(4_000, ids))
        .mockResolvedValueOnce(readyPortfolio(3_000, ids));
      const { result, rerender } = renderHook(() => usePortfolioState());
      await waitFor(() => {
        expect(result.current.positions).toHaveLength(count);
        expect(result.current.positions.every((position) => position.marketLoading === false)).toBe(
          true,
        );
        expect(result.current.positions[0]).toMatchObject({
          status: "active",
          isPending: false,
          currentValueSats: 4_000,
        });
        expect(result.current.monitoring.building).toBe(false);
        expect(mocks.replaceConditionIds).toHaveBeenCalledWith(ids);
      });

      expect(markets.fetch).toHaveBeenCalledTimes(batches);
      await act(async () => {
        rerender();
        result.current.setPositionsTab("closed");
      });
      expect(markets.fetch).toHaveBeenCalledTimes(batches);

      // A normal lifecycle notice changes neither wallet/custody nor membership.
      // Advance only the existing coalescing timer, not an invented polling loop.
      markets.close();
      monotonicNow.mockReturnValue(15_000);
      await notifyLifecycle();
      await waitFor(() => {
        expect(mocks.getPortfolio).toHaveBeenCalledTimes(2);
        expect(result.current.positions[0]?.currentValueSats).toBe(3_000);
        expect(result.current.monitoring.retainingDisplay).toBe(false);
      });
      expect(await db.custodyProofs.toArray()).toEqual(originalCustody);
      await waitFor(() =>
        expect(result.current.positions[0]).toMatchObject({
          status: "closed",
          isPending: true,
          isWinner: false,
          isLoser: false,
          canClaimPayout: false,
          canDiscard: false,
        }),
      );
      expect(markets.fetch).toHaveBeenCalledTimes(batches * 2);
      await act(async () => {
        rerender();
        result.current.setPositionsTab("active");
      });
      expect(markets.fetch).toHaveBeenCalledTimes(batches * 2);
    },
  );

  it("does not refresh the new wallet catalogue when an old wallet response arrives", async () => {
    const monotonicNow = vi.spyOn(performance, "now").mockReturnValue(0);
    await seedCustody();
    const markets = catalogue();
    let finishOld!: (response: AssetMonitoringPortfolioResponse) => void;
    const oldResponse = new Promise<AssetMonitoringPortfolioResponse>((resolve) => {
      finishOld = resolve;
    });
    mocks.getPortfolio
      .mockResolvedValueOnce(readyPortfolio(4_000))
      .mockReturnValueOnce(oldResponse)
      .mockResolvedValueOnce(readyPortfolio(2_000));
    const { result, rerender } = renderHook(() => usePortfolioState());
    await waitFor(() => expect(result.current.positions[0]?.currentValueSats).toBe(4_000));
    monotonicNow.mockReturnValue(15_000);
    await notifyLifecycle();
    expect(mocks.getPortfolio).toHaveBeenCalledTimes(2);
    expect(markets.fetch).toHaveBeenCalledTimes(1); // Request start is not acceptance.
    await act(async () => {
      mocks.walletId = "c".repeat(64);
      mocks.wallet.mnemonic = "other test mnemonic";
      rerender();
    });
    await waitFor(() => {
      expect(mocks.getPortfolio).toHaveBeenCalledTimes(3);
      expect(result.current.positions[0]?.currentValueSats).toBe(2_000);
      expect(result.current.positions[0]?.marketLoading).toBe(false);
    });
    const beforeStale = markets.fetch.mock.calls.length;
    markets.close();
    await act(async () => {
      finishOld(readyPortfolio(9_000));
      await oldResponse;
    });
    expect(result.current.positions[0]?.currentValueSats).toBe(2_000);
    expect(markets.fetch).toHaveBeenCalledTimes(beforeStale);
  });

  it("preserves failed-monitor catalogue behavior without a repeated refresh trigger", async () => {
    const monotonicNow = vi.spyOn(performance, "now").mockReturnValue(0);
    await seedCustody();
    const markets = catalogue();
    let failRead!: (error: Error) => void;
    const failedResponse = new Promise<AssetMonitoringPortfolioResponse>((_, reject) => {
      failRead = reject;
    });
    mocks.getPortfolio
      .mockResolvedValueOnce(readyPortfolio(4_000))
      .mockReturnValueOnce(failedResponse);
    const { result, rerender } = renderHook(() => usePortfolioState());
    await waitFor(() => expect(result.current.positions[0]?.marketLoading).toBe(false));
    expect(markets.fetch).toHaveBeenCalledTimes(1);
    monotonicNow.mockReturnValue(15_000);
    await notifyLifecycle();
    expect(mocks.getPortfolio).toHaveBeenCalledTimes(2);
    expect(markets.fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      failRead(new Error("synthetic unavailable monitor"));
    });
    await waitFor(() => {
      expect(result.current.monitoring.error).toBe("unavailable");
      // The pre-existing unavailable flag still permits its fallback catalogue pass.
      expect(markets.fetch).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      rerender();
      result.current.setPositionsTab("closed");
    });
    expect(markets.fetch).toHaveBeenCalledTimes(2);
    expect(result.current.positions[0]?.currentValueSats).toBe(4_000);
  });
});
