import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AssetMonitoringAssetsResponse,
  AssetMonitoringPortfolioResponse,
} from "@bitcaster/client-sdk/assetMonitoring";
import type { Fund, Position } from "@/types/portfolio";

const mocks = vi.hoisted(() => ({
  getPortfolio: vi.fn(),
  getAssetMonitoringAssets: vi.fn(),
  liveQueryCalls: 0,
}));

const monitoredConditionId = "b".repeat(64);
const rootParentConditionId = "0".repeat(64);

const localPosition: Position = {
  id: "local-position",
  marketId: "condition-local-YES",
  marketTitle: "Local condition",
  marketImageUrl: "",
  side: "yes",
  baseAsset: "sat",
  divisibility: 10_000,
  shares: 1,
  avgBuyPrice: 0,
  currentPrice: 0,
  currentValueSats: 4_000,
  profitLossSats: 0,
  profitLossPercent: 0,
  status: "active",
  isWinner: false,
  isLoser: false,
  isPending: false,
  acquiredDate: "",
  mintUrl: "https://mint.example",
};

const localFund: Fund = {
  id: "local-fund",
  unit: "sats",
  amount: 2_000,
  mintUrl: "https://mint.example",
};

vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: vi.fn(() => {
    mocks.liveQueryCalls += 1;
    return mocks.liveQueryCalls % 2 === 1 ? [localPosition] : [localFund];
  }),
}));

vi.mock("@/stores/proof-db", () => ({ getProofs: vi.fn(), isCtfProof: vi.fn() }));
vi.mock("@/stores/wallet", () => ({
  useWalletStore: (selector: (state: object) => unknown) =>
    selector({ setupComplete: true, mnemonic: "test mnemonic", mints: [] }),
}));
vi.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: object) => unknown) => selector({ nostrProfile: null }),
}));
vi.mock("@/stores/activity-log", () => ({
  useActivityLogStore: (selector: (state: object) => unknown) => selector({ items: [] }),
}));
vi.mock("@/lib/browserWalletProfile", () => ({
  browserWalletIdFromMnemonic: (mnemonic: string) => `wallet-${mnemonic}`,
}));
vi.mock("@/lib/markets", () => ({
  createAuthenticatedBrowserEngineClient: () => ({
    getPortfolio: mocks.getPortfolio,
    getAssetMonitoringAssets: mocks.getAssetMonitoringAssets,
  }),
}));

import {
  appendMonitoringAssets,
  canonicalMonitoringAssetIdentity,
  mapMonitoringPortfolio,
  mergeMonitoringPositions,
  usePortfolioState,
} from "../usePortfolioState";

function portfolioResponse(
  timeframe: "1D" | "1W" | "1M" | "ALL" = "ALL",
): AssetMonitoringPortfolioResponse {
  return {
    summary: {
      collateralUnit: "msat",
      availableValueMsat: 7_000,
      pendingOutgoingValueMsat: 0,
      estimatedTotalValueMsat: 12_000,
      unvaluedAssetCount: 1,
      unvaluedAvailableSubunits: 4_000,
      unvaluedPendingOutgoingSubunits: 0,
      valuationRevision: "revision-1",
      stale: true,
      incomplete: false,
      building: true,
    },
    assets: {
      assets: [
        {
          asset: {
            kind: "collateral",
            canonicalMintUrl: "https://mint.example",
            cashuUnit: "msat",
            displayBaseAsset: "msat",
          },
          availableSubunits: 7_000,
          pendingOutgoingSubunits: 0,
          availableValueMsat: 7_000,
          pendingOutgoingValueMsat: 0,
          estimatedValueMsat: 7_000,
          valuationStatus: "valued",
          recoveryHint: null,
        },
        {
          asset: {
            kind: "conditional",
            canonicalMintUrl: "https://mint.example",
            cashuUnit: "msat",
            displayBaseAsset: "msat",
            conditionId: monitoredConditionId,
            parentConditionId: rootParentConditionId,
            outcomeUniverseDigest: "a".repeat(64),
            internalOutcomeSetId: "YES",
          },
          availableSubunits: 5_000,
          pendingOutgoingSubunits: 0,
          estimatedValueMsat: 5_000,
          valuationStatus: "valued",
          recoveryHint: null,
        },
      ],
      valuationRevision: "revision-1",
      stale: false,
      incomplete: true,
      building: false,
    },
    history: {
      timeframe,
      points: [{ asOf: "2026-08-09T00:00:00.000Z", estimatedTotalValueMsat: 12_000 }],
      valuationRevision: "revision-1",
      stale: false,
      incomplete: false,
      building: false,
    },
  };
}

function deferred<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve: resolve! };
}

function firstPage(cursor = "cursor-1"): AssetMonitoringPortfolioResponse {
  const response = portfolioResponse();
  return { ...response, assets: { ...response.assets, nextCursor: cursor } };
}

function nextPage(
  asset: AssetMonitoringAssetsResponse["assets"][number],
  nextCursor: string | null = null,
): AssetMonitoringAssetsResponse {
  return {
    assets: [asset],
    nextCursor,
    valuationRevision: "revision-1",
    stale: false,
    incomplete: false,
    building: false,
  };
}

function conditionalAsset(outcome: string): AssetMonitoringAssetsResponse["assets"][number] {
  return {
    asset: {
      kind: "conditional",
      canonicalMintUrl: "https://mint.example",
      cashuUnit: "msat",
      displayBaseAsset: "msat",
      conditionId: `${outcome[0] ?? "x"}`.repeat(64),
      parentConditionId: rootParentConditionId,
      outcomeUniverseDigest: "a".repeat(64),
      internalOutcomeSetId: outcome,
    },
    availableSubunits: 2_000,
    pendingOutgoingSubunits: 0,
    estimatedValueMsat: 2_000,
    valuationStatus: "valued",
    recoveryHint: null,
  };
}

describe("usePortfolioState monitoring facade", () => {
  afterEach(() => {
    mocks.getPortfolio.mockReset();
    mocks.getAssetMonitoringAssets.mockReset();
    mocks.liveQueryCalls = 0;
  });

  it("uses one portfolio request on first paint and no catalogue request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    mocks.getPortfolio.mockResolvedValue(portfolioResponse());

    renderHook(() => usePortfolioState());

    await waitFor(() => expect(mocks.getPortfolio).toHaveBeenCalledTimes(1));
    expect(mocks.getPortfolio).toHaveBeenCalledWith({
      walletId: "wallet-test mnemonic",
      timeframe: "ALL",
      pageSize: 200,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("keeps the one facade request valid under React Strict Mode", async () => {
    mocks.getPortfolio.mockResolvedValue(portfolioResponse());
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;

    const { result } = renderHook(() => usePortfolioState(), { wrapper });

    await waitFor(() => expect(result.current.stats.totalValueSats).toBe(12_000));
    expect(mocks.getPortfolio).toHaveBeenCalledTimes(1);
  });

  it("uses server summary, history, and first asset page as display-only rows", () => {
    const mapped = mapMonitoringPortfolio(portfolioResponse());

    expect(mapped.stats.totalValueSats).toBe(12_000);
    expect(mapped.stats.positionsValueSats).toBe(5_000);
    expect(mapped.chart).toEqual([{ timestamp: "2026-08-09T00:00:00.000Z", cumulativePL: 12_000 }]);
    expect(mapped.funds).toHaveLength(1);
    expect(mapped.positions[0]).toMatchObject({
      marketTitle: "Condition bbbbbbbbbbbb",
      canSell: false,
      canClaimPayout: false,
      canDiscard: false,
      isWinner: false,
      isLoser: false,
    });
    expect(mapped.positions[0]?.shares).toBeUndefined();
    expect(mapped.monitoring).toMatchObject({
      stale: true,
      incomplete: true,
      building: true,
      unvaluedAssetCount: 1,
      hasPendingOutgoing: false,
      pendingOutgoingValueMsat: 0,
    });
  });

  it("retains local lifecycle and action authority for a page-loaded position", () => {
    const localWinner: Position = {
      ...localPosition,
      marketId: `${monitoredConditionId}-YES`,
      outcomeId: "YES",
      status: "closed",
      isWinner: true,
      canClaimPayout: true,
      currentValueSats: 1,
    };
    const response = portfolioResponse();
    const loadedAsset = response.assets.assets[1]!;
    const firstAssets = [response.assets.assets[0]!];
    const appended = appendMonitoringAssets(firstAssets, [loadedAsset]);
    localWinner.monitoringAssetIdentity = canonicalMonitoringAssetIdentity(loadedAsset.asset);
    const monitored = mapMonitoringPortfolio({
      ...response,
      assets: { ...response.assets, assets: appended.assets, nextCursor: null },
    }).positions;

    expect(mergeMonitoringPositions(monitored, [localWinner])[0]).toMatchObject({
      id: "local-position",
      status: "closed",
      isWinner: true,
      canClaimPayout: true,
      currentValueSats: 5_000,
      valueKnown: true,
    });
  });

  it("keeps null valuations unknown instead of rendering them as zero", () => {
    const response = portfolioResponse();
    response.summary.estimatedTotalValueMsat = null;
    response.assets.assets[1] = {
      ...response.assets.assets[1],
      estimatedValueMsat: null,
      valuationStatus: "unvalued",
    };
    response.history.points[0] = {
      ...response.history.points[0],
      estimatedTotalValueMsat: null,
    };

    const mapped = mapMonitoringPortfolio(response);

    expect(mapped.stats.totalValueKnown).toBe(false);
    expect(mapped.stats.positionsValueKnown).toBe(false);
    expect(mapped.positions[0]?.valueKnown).toBe(false);
    expect(mapped.chart).toEqual([]);
  });

  it("keeps local rows when authentication or monitoring fails", async () => {
    mocks.getPortfolio.mockRejectedValue(new Error("signer unavailable"));
    const { result } = renderHook(() => usePortfolioState());

    await waitFor(() => expect(result.current.monitoring.error).toBe("unavailable"));
    expect(result.current.positions).toEqual([localPosition]);
    expect(result.current.funds).toEqual([localFund]);
  });

  it.each([
    ["byte-identical", (response: AssetMonitoringPortfolioResponse) => response.assets.assets[0]!],
    [
      "conflicting",
      (response: AssetMonitoringPortfolioResponse) => ({
        ...response.assets.assets[0]!,
        availableSubunits: response.assets.assets[0]!.availableSubunits + 1,
      }),
    ],
  ])("rejects an initial %s duplicate page and keeps local rows", async (_kind, duplicate) => {
    const response = portfolioResponse();
    response.assets.assets = [response.assets.assets[0]!, duplicate(response)];
    mocks.getPortfolio.mockResolvedValue(response);
    const { result } = renderHook(() => usePortfolioState());

    await waitFor(() => expect(result.current.monitoring.error).toBe("unavailable"));

    expect(result.current.positions).toEqual([localPosition]);
    expect(result.current.funds).toEqual([localFund]);
  });

  it("keeps distinct canonical rows and prevents cross-asset local authority", () => {
    const response = portfolioResponse();
    const firstConditional = response.assets.assets[1]!;
    const secondConditional = {
      ...firstConditional,
      asset: { ...firstConditional.asset, canonicalMintUrl: "https://other-mint.example" },
    };
    const secondCollateral = {
      ...response.assets.assets[0]!,
      asset: {
        ...response.assets.assets[0]!.asset,
        cashuUnit: "sat" as const,
        displayBaseAsset: "sat" as const,
      },
    };
    response.assets.assets = [
      response.assets.assets[0]!,
      secondCollateral,
      firstConditional,
      secondConditional,
    ];
    const mapped = mapMonitoringPortfolio(response);
    const localWinner: Position = {
      ...localPosition,
      monitoringAssetIdentity: canonicalMonitoringAssetIdentity(firstConditional.asset),
      status: "closed",
      isWinner: true,
      canClaimPayout: true,
    };
    const merged = mergeMonitoringPositions(mapped.positions, [localWinner]);

    expect(new Set(mapped.positions.map((position) => position.id)).size).toBe(2);
    expect(new Set(mapped.funds.map((fund) => fund.id)).size).toBe(2);
    expect(merged[0]).toMatchObject({ id: "local-position", canClaimPayout: true });
    expect(merged[1]).toMatchObject({ canClaimPayout: false, isWinner: false });
  });

  it("ignores an older timeframe response", async () => {
    const all = deferred<AssetMonitoringPortfolioResponse>();
    const day = deferred<AssetMonitoringPortfolioResponse>();
    mocks.getPortfolio.mockReturnValueOnce(all.promise).mockReturnValueOnce(day.promise);
    const { result } = renderHook(() => usePortfolioState());

    await waitFor(() => expect(mocks.getPortfolio).toHaveBeenCalledTimes(1));
    act(() => result.current.setSelectedTimeRange("1D"));
    await waitFor(() => expect(mocks.getPortfolio).toHaveBeenCalledTimes(2));
    await act(async () => day.resolve(portfolioResponse("1D")));
    await waitFor(() => expect(result.current.stats.totalValueSats).toBe(12_000));
    await act(async () =>
      all.resolve({
        ...portfolioResponse(),
        summary: { ...portfolioResponse().summary, estimatedTotalValueMsat: 1 },
      }),
    );

    expect(result.current.selectedTimeRange).toBe("1D");
    expect(result.current.stats.totalValueSats).toBe(12_000);
  });

  it("ignores an older response when the same timeframe becomes active again", async () => {
    const firstAll = deferred<AssetMonitoringPortfolioResponse>();
    const day = deferred<AssetMonitoringPortfolioResponse>();
    const secondAll = deferred<AssetMonitoringPortfolioResponse>();
    mocks.getPortfolio
      .mockReturnValueOnce(firstAll.promise)
      .mockReturnValueOnce(day.promise)
      .mockReturnValueOnce(secondAll.promise);
    const { result } = renderHook(() => usePortfolioState());

    await waitFor(() => expect(mocks.getPortfolio).toHaveBeenCalledTimes(1));
    act(() => result.current.setSelectedTimeRange("1D"));
    await waitFor(() => expect(mocks.getPortfolio).toHaveBeenCalledTimes(2));
    act(() => result.current.setSelectedTimeRange("ALL"));
    await waitFor(() => expect(mocks.getPortfolio).toHaveBeenCalledTimes(3));
    await act(async () => secondAll.resolve(portfolioResponse()));
    await waitFor(() => expect(result.current.stats.totalValueSats).toBe(12_000));
    await act(async () =>
      firstAll.resolve({
        ...portfolioResponse(),
        summary: { ...portfolioResponse().summary, estimatedTotalValueMsat: 1 },
      }),
    );

    expect(result.current.stats.totalValueSats).toBe(12_000);
  });

  it("requests one exact page per click and appends its rows in page order", async () => {
    mocks.getPortfolio.mockResolvedValue(firstPage());
    mocks.getAssetMonitoringAssets.mockResolvedValue(nextPage(conditionalAsset("NO")));
    const { result } = renderHook(() => usePortfolioState());

    await waitFor(() => expect(result.current.monitoring.hasMoreAssets).toBe(true));
    act(() => {
      result.current.loadMoreAssets();
      result.current.loadMoreAssets();
    });
    await waitFor(() => expect(mocks.getAssetMonitoringAssets).toHaveBeenCalledTimes(1));
    expect(mocks.getAssetMonitoringAssets).toHaveBeenCalledWith({
      walletId: "wallet-test mnemonic",
      cursor: "cursor-1",
      pageSize: 200,
    });
    await waitFor(() => expect(result.current.monitoring.hasMoreAssets).toBe(false));
    expect(result.current.positions.map((position) => position.outcomeId)).toEqual([
      "YES",
      "NO",
      undefined,
    ]);
  });

  it("rejects duplicate and conflicting asset pages without double-counting", () => {
    const first = portfolioResponse().assets.assets[1]!;
    const duplicate = appendMonitoringAssets([first], [first]);
    const conflict = appendMonitoringAssets(
      [first],
      [{ ...first, availableSubunits: first.availableSubunits + 1 }],
    );

    expect(duplicate.kind).toBe("duplicate");
    expect(conflict.kind).toBe("conflict");
    expect(duplicate.assets).toEqual([first]);
    expect(conflict.assets).toEqual([first]);
  });

  it("keeps rows and permits an explicit retry after a page failure", async () => {
    mocks.getPortfolio.mockResolvedValue(firstPage());
    mocks.getAssetMonitoringAssets
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce(nextPage(conditionalAsset("NO")));
    const { result } = renderHook(() => usePortfolioState());

    await waitFor(() => expect(result.current.monitoring.hasMoreAssets).toBe(true));
    act(() => result.current.loadMoreAssets());
    await waitFor(() => expect(result.current.monitoring.assetPageError).toBe("unavailable"));
    expect(result.current.positions).toHaveLength(2);
    act(() => result.current.loadMoreAssets());
    await waitFor(() => expect(mocks.getAssetMonitoringAssets).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.monitoring.assetPageError).toBeNull());
    expect(result.current.positions).toHaveLength(3);
  });

  it("ignores a stale page after an A-to-B-to-A generation change", async () => {
    const oldPage = deferred<AssetMonitoringAssetsResponse>();
    mocks.getPortfolio
      .mockResolvedValueOnce(firstPage("cursor-a"))
      .mockResolvedValueOnce(portfolioResponse("1D"))
      .mockResolvedValueOnce(firstPage("cursor-a-again"));
    mocks.getAssetMonitoringAssets.mockReturnValueOnce(oldPage.promise);
    const { result } = renderHook(() => usePortfolioState());

    await waitFor(() => expect(result.current.monitoring.hasMoreAssets).toBe(true));
    act(() => result.current.loadMoreAssets());
    await waitFor(() => expect(mocks.getAssetMonitoringAssets).toHaveBeenCalledTimes(1));
    act(() => result.current.setSelectedTimeRange("1D"));
    await waitFor(() => expect(mocks.getPortfolio).toHaveBeenCalledTimes(2));
    act(() => result.current.setSelectedTimeRange("ALL"));
    await waitFor(() => expect(mocks.getPortfolio).toHaveBeenCalledTimes(3));
    await act(async () => oldPage.resolve(nextPage(conditionalAsset("STALE"))));

    expect(result.current.selectedTimeRange).toBe("ALL");
    expect(result.current.positions.some((position) => position.outcomeId === "STALE")).toBe(false);
  });
});
