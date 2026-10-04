import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AssetMonitoringAssetsResponse,
  AssetMonitoringPortfolioResponse,
} from "@bitcaster/client-sdk/assetMonitoring";
import { computeAssetMonitoringOutcomeUniverseDigest } from "@bitcaster/client-sdk/assetMonitoring";
import {
  portfolioInvalidatedEvent,
  publishPortfolioInvalidation,
} from "@/lib/portfolioInvalidation";
import type { ActivityItem, Fund, Position } from "@/types/portfolio";

const mocks = vi.hoisted(() => ({
  getPortfolio: vi.fn(),
  getAssetMonitoringAssets: vi.fn(),
  portfolioObservers: [] as Array<{
    onRefresh: () => void;
    conditionSets: string[][];
    disposeCalls: number;
  }>,
  readCustody: vi.fn(),
  activeScopeId: "custody:wallet:" + "a".repeat(64),
  localQueries: [] as (() => Promise<unknown>)[],
  localQueryDependencies: [] as unknown[][],
  positionSnapshot: null as null | {
    positions: Position[];
    marketCatalogue: Map<string, unknown>;
  },
  activityItems: [] as ActivityItem[],
  liveQueryCalls: 0,
  localFundsState: "available" as "available" | "null" | "undefined",
  walletMnemonic: "test mnemonic",
  signerRevision: 0,
}));

const monitoredConditionId = "b".repeat(64);
const rootParentConditionId = "0".repeat(64);
const activeWalletId = "a".repeat(64);

const localPosition: Position = {
  id: "local-position",
  marketId: "condition-local-YES",
  marketTitle: "Local condition",
  marketImageUrl: "",
  side: "yes",
  baseAsset: "sat",
  divisibility: 1_000,
  shares: 1,
  currentValueSats: 4_000,
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
  useLiveQuery: vi.fn((query: () => Promise<unknown>, dependencies: unknown[] = []) => {
    mocks.localQueries.push(query);
    mocks.localQueryDependencies.push(dependencies);
    mocks.liveQueryCalls += 1;
    return mocks.liveQueryCalls % 2 === 1
      ? {
          scopeId: "custody:wallet:" + "a".repeat(64),
          ...(mocks.positionSnapshot ?? { positions: [localPosition], marketCatalogue: new Map() }),
        }
      : mocks.localFundsState === "null"
        ? null
        : mocks.localFundsState === "undefined"
          ? undefined
          : { scopeId: "custody:wallet:" + "a".repeat(64), funds: [localFund] };
  }),
}));

vi.mock("@/stores/proof-db", () => ({ getProofs: vi.fn(), isCtfProof: vi.fn() }));
vi.mock("@/stores/portfolio-custody", () => ({
  readCanonicalPortfolioCustody: mocks.readCustody,
}));
vi.mock("@/stores/wallet", () => ({
  useWalletStore: (selector: (state: object) => unknown) =>
    selector({ setupComplete: true, mnemonic: mocks.walletMnemonic, mints: [] }),
}));
vi.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: object) => unknown) => selector({ nostrProfile: null }),
}));
vi.mock("@/stores/activity-log", () => ({
  useActivityLogStore: (selector: (state: object) => unknown) =>
    selector({ items: mocks.activityItems }),
}));
vi.mock("@/lib/browserWalletProfile", () => ({
  browserWalletIdFromMnemonic: () =>
    mocks.walletMnemonic === "test mnemonic" ? activeWalletId : "c".repeat(64),
  browserWalletScopeIdFromMnemonic: (mnemonic: string) =>
    "custody:wallet:" + (mnemonic === "test mnemonic" ? "a" : "c").repeat(64),
  activeBrowserWalletScopeId: () => mocks.activeScopeId,
}));
vi.mock("@/lib/nostr", () => ({
  getNostrSignerRevision: () => mocks.signerRevision,
  subscribeToNostrSignerRevision: () => () => {},
}));
vi.mock("@/lib/markets", () => ({
  createAuthenticatedBrowserEngineClient: () => ({
    getPortfolio: mocks.getPortfolio,
    getAssetMonitoringAssets: mocks.getAssetMonitoringAssets,
  }),
}));
vi.mock("@/lib/marketHub", () => ({
  observePortfolioValuations: (onRefresh: () => void) => {
    const observer = {
      onRefresh,
      conditionSets: [] as string[][],
      disposeCalls: 0,
    };
    mocks.portfolioObservers.push(observer);
    return {
      replaceConditionIds: async (conditionIds: readonly string[]) => {
        observer.conditionSets.push([...conditionIds]);
      },
      dispose: () => {
        observer.disposeCalls += 1;
      },
    };
  },
}));

import {
  appendMonitoringAssets,
  canonicalMonitoringAssetIdentity,
  enrichPositionWithCatalogue,
  mapMonitoringPortfolio,
  mergeMonitoringPositions,
  usePortfolioState,
} from "../usePortfolioState";
import type { MarketCatalogueEntry } from "@/lib/markets";

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
            displayBaseAsset: "sat",
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
            displayBaseAsset: "sat",
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

function completePortfolioResponse(
  timeframe: "1D" | "1W" | "1M" | "ALL" = "ALL",
  estimatedTotalValueMsat = 15_000,
): AssetMonitoringPortfolioResponse {
  const response = portfolioResponse(timeframe);
  Object.assign(response.summary, {
    estimatedTotalValueMsat,
    unvaluedAssetCount: 0,
    unvaluedAvailableSubunits: 0,
    stale: false,
    incomplete: false,
    building: false,
  });
  Object.assign(response.assets, {
    stale: false,
    incomplete: false,
    building: false,
  });
  Object.assign(response.history, {
    stale: false,
    incomplete: false,
    building: false,
    points: [{ asOf: "2026-08-09T00:00:00.000Z", estimatedTotalValueMsat }],
  });
  return response;
}

function buildingUnvaluedPortfolioResponse(): AssetMonitoringPortfolioResponse {
  const response = completePortfolioResponse();
  Object.assign(response.summary, {
    estimatedTotalValueMsat: null,
    unvaluedAssetCount: 1,
    unvaluedAvailableSubunits: 5_000,
    stale: true,
    building: true,
  });
  response.assets.assets[1] = {
    ...response.assets.assets[1]!,
    estimatedValueMsat: null,
    valuationStatus: "unvalued",
  };
  return response;
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
      displayBaseAsset: "sat",
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

function conditionalAssetForCondition(
  conditionId: string,
): AssetMonitoringAssetsResponse["assets"][number] {
  const asset = conditionalAsset("YES");
  if (asset.asset.kind !== "conditional") throw new Error("fixture must be conditional");
  return {
    ...asset,
    asset: { ...asset.asset, conditionId },
  };
}

function portfolioWithConditionalConditions(
  conditionIds: readonly string[],
  nextCursor: string | null,
): AssetMonitoringPortfolioResponse {
  const response = completePortfolioResponse();
  response.assets.assets = conditionIds.map(conditionalAssetForCondition);
  response.assets.nextCursor = nextCursor;
  response.summary.unvaluedAssetCount = 0;
  response.summary.estimatedTotalValueMsat = conditionIds.length * 2_000;
  response.assets.incomplete = nextCursor !== null;
  return response;
}

function conditionIdFor(index: number): string {
  return BigInt(index + 1)
    .toString(16)
    .padStart(64, "0");
}

function canonicalConditionalCustody(
  conditionId: string,
  outcomeCollection = "YES",
  selectability: "selectable" | "verified-losing" = "selectable",
) {
  return {
    normalizedMint: "https://mint.example",
    assetKind: "conditional",
    conditionId,
    outcomeCollection,
    baseAsset: "sat",
    unit: "msat",
    amount: 1_000,
    receivedAtMs: 10,
    selectability,
    claimRecoveryPending: false,
  };
}

function stubCatalogue({
  failedBatchStart,
  closedConditionId,
}: {
  failedBatchStart?: string;
  closedConditionId: string;
}) {
  const requests: Array<{
    conditionIds: string[];
    state: string | null;
    pageSize: string | null;
  }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const search = new URL(String(input), "http://localhost").searchParams;
      const requestedIds = search.get("ids")?.split(",") ?? [];
      requests.push({
        conditionIds: requestedIds,
        state: search.get("state"),
        pageSize: search.get("page_size"),
      });
      if (requestedIds[0] === failedBatchStart) return new Response(null, { status: 503 });
      return new Response(
        JSON.stringify({
          markets: requestedIds.map((conditionId) => ({
            conditionId,
            outcomes: ["NO", "YES"],
            divisibility: 1_000,
            state: conditionId === closedConditionId ? "closed" : "open",
            finalOutcome: conditionId === closedConditionId ? "YES" : null,
          })),
        }),
        { status: 200 },
      );
    }),
  );
  return requests;
}

interface PortfolioPositionSnapshot {
  positions: Position[];
  marketCatalogue: Map<string, MarketCatalogueEntry>;
}

async function localPositionSnapshotAfterMonitoringFailure(): Promise<PortfolioPositionSnapshot> {
  mocks.getPortfolio.mockRejectedValue(new Error("signer unavailable"));
  const { result } = renderHook(() => usePortfolioState());
  await waitFor(() => expect(result.current.monitoring.error).toBe("unavailable"));
  return (await mocks.localQueries.at(-2)!()) as PortfolioPositionSnapshot;
}

async function localPositionsAfterMonitoringFailure(): Promise<Position[]> {
  return (await localPositionSnapshotAfterMonitoringFailure()).positions;
}

function conditionalMonitoringAsset(
  conditionId: string,
): AssetMonitoringAssetsResponse["assets"][number] {
  const asset = conditionalAsset("YES");
  if (asset.asset.kind !== "conditional") throw new Error("fixture must be conditional");
  return {
    ...asset,
    estimatedValueMsat: 700,
    asset: {
      ...asset.asset,
      conditionId,
      outcomeUniverseDigest: computeAssetMonitoringOutcomeUniverseDigest(["NO", "YES"]),
    },
  };
}

describe("usePortfolioState monitoring facade", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    mocks.getPortfolio.mockReset();
    mocks.getAssetMonitoringAssets.mockReset();
    mocks.readCustody.mockReset();
    mocks.activeScopeId = "custody:wallet:" + "a".repeat(64);
    mocks.portfolioObservers.length = 0;
    mocks.localQueries.length = 0;
    mocks.localQueryDependencies.length = 0;
    mocks.positionSnapshot = null;
    mocks.activityItems.length = 0;
    mocks.liveQueryCalls = 0;
    mocks.localFundsState = "available";
    mocks.walletMnemonic = "test mnemonic";
    mocks.signerRevision = 0;
  });

  it("retains the last complete display through a building response and a failed refresh", async () => {
    vi.useFakeTimers();
    const pending = deferred<AssetMonitoringPortfolioResponse>();
    mocks.getPortfolio
      .mockResolvedValueOnce(completePortfolioResponse())
      .mockReturnValueOnce(pending.promise)
      .mockRejectedValueOnce(new Error("unavailable"));
    const { result } = renderHook(() => usePortfolioState());
    await act(async () => {});
    const previousChart = result.current.plChartData;
    act(() => publishPortfolioInvalidation({ walletId: activeWalletId }));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(result.current.stats.totalValueSats).toBe(15_000);
    expect(result.current.stats.totalValueKnown).toBe(true);
    await act(async () => pending.resolve(buildingUnvaluedPortfolioResponse()));
    expect(result.current.stats.totalValueKnown).toBe(true);
    expect(result.current.stats.totalValueSats).toBe(15_000);
    expect(result.current.plChartData).toEqual(previousChart);
    expect(result.current.monitoring).toMatchObject({ stale: true, building: true });
    expect(
      result.current.positions.filter((position) => position.id.startsWith("monitoring:")),
    ).toHaveLength(1);
    expect(result.current.positions.every((position) => position.canClaimPayout !== true)).toBe(
      true,
    );
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(result.current.monitoring.error).toBe("unavailable");
    expect(result.current.stats.totalValueSats).toBe(15_000);
    expect(result.current.stats.totalValueKnown).toBe(true);
  });

  it("does not retain an unavailable initial estimate", async () => {
    mocks.localFundsState = "undefined";
    mocks.getPortfolio.mockRejectedValue(new Error("unavailable"));
    const { result } = renderHook(() => usePortfolioState());
    await waitFor(() => expect(result.current.monitoring.error).toBe("unavailable"));
    expect(result.current.monitoring.retainingDisplay).toBe(false);
    expect(result.current.stats.totalValueKnown).toBe(false);
    expect(result.current.plChartData.ALL).toHaveLength(0);
  });

  it("retains display estimates during claim recovery without retaining custody actions", async () => {
    mocks.getPortfolio.mockResolvedValue(completePortfolioResponse());
    const { result, rerender } = renderHook(() => usePortfolioState());
    await waitFor(() => expect(result.current.stats.totalValueKnown).toBe(true));
    mocks.positionSnapshot = {
      positions: [{ ...localPosition, claimRecoveryPending: true, canClaimPayout: true }],
      marketCatalogue: new Map(),
    };
    mocks.localFundsState = "undefined";
    rerender();
    expect(result.current.stats.totalValueSats).toBe(15_000);
    expect(result.current.stats.totalValueLoading).toBe(true);
    expect(result.current.monitoring.stale).toBe(true);
    mocks.positionSnapshot = { positions: [], marketCatalogue: new Map() };
    rerender();
    expect(result.current.positions.every((position) => position.canClaimPayout !== true)).toBe(
      true,
    );
  });

  it.each(["wallet", "account"] as const)(
    "clears retained values on %s scope change and rejects the previous response",
    async (scope) => {
      vi.useFakeTimers();
      const old = deferred<AssetMonitoringPortfolioResponse>();
      const next = deferred<AssetMonitoringPortfolioResponse>();
      mocks.getPortfolio
        .mockResolvedValueOnce(completePortfolioResponse())
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(next.promise);
      const { result, rerender } = renderHook(() => usePortfolioState());
      await act(async () => {});
      act(() => publishPortfolioInvalidation({ walletId: activeWalletId }));
      await act(async () => vi.advanceTimersByTimeAsync(10_000));
      if (scope === "wallet") {
        mocks.walletMnemonic = "another mnemonic";
        mocks.activeScopeId = "custody:wallet:" + "c".repeat(64);
      } else mocks.signerRevision += 1;
      rerender();
      expect(result.current.stats.totalValueSats).not.toBe(15_000);
      expect(result.current.plChartData.ALL).toHaveLength(0);
      if (scope === "wallet") {
        expect(result.current.positions).toHaveLength(0);
        expect(result.current.funds).toHaveLength(0);
        expect(result.current.stats.totalValueKnown).toBe(false);
      }
      await act(async () => old.resolve(completePortfolioResponse("ALL", 99_000)));
      expect(result.current.stats.totalValueSats).not.toBe(99_000);
      expect(mocks.getPortfolio).toHaveBeenCalledTimes(3);
      await act(async () => next.resolve(completePortfolioResponse("ALL", 23_000)));
      expect(result.current.stats.totalValueSats).toBe(23_000);
    },
  );

  it.each(
    ["winner", "loser"].flatMap((outcome) => [
      { outcome, catalogueOutcomes: ["Alpha", "Beta"] },
      { outcome, catalogueOutcomes: ["Beta", "Alpha"] },
    ]),
  )(
    "merges canonical $outcome custody with catalogue order $catalogueOutcomes",
    async ({ outcome, catalogueOutcomes }) => {
      mocks.getPortfolio.mockRejectedValue(new Error("signer unavailable"));
      mocks.readCustody.mockResolvedValue([
        {
          normalizedMint: "https://mint.example",
          assetKind: "conditional",
          conditionId: monitoredConditionId,
          outcomeCollection: "Alpha",
          baseAsset: "sat",
          unit: "msat",
          amount: 1000,
          receivedAtMs: 10,
          selectability: outcome === "winner" ? "selectable" : "verified-losing",
          claimRecoveryPending: false,
        },
      ]);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              markets: [
                {
                  conditionId: monitoredConditionId,
                  outcomes: catalogueOutcomes,
                  divisibility: 1000,
                  state: "closed",
                  finalOutcome: outcome === "winner" ? "Alpha" : "Beta",
                },
              ],
            }),
            { status: 200 },
          ),
        ),
      );
      const { result } = renderHook(() => usePortfolioState());
      await waitFor(() => expect(result.current.monitoring.error).toBe("unavailable"));
      const positions = ((await mocks.localQueries.at(-2)!()) as PortfolioPositionSnapshot)
        .positions;
      const monitoringIdentity = canonicalMonitoringAssetIdentity({
        kind: "conditional",
        canonicalMintUrl: "https://mint.example",
        cashuUnit: "msat",
        displayBaseAsset: "sat",
        conditionId: monitoredConditionId,
        parentConditionId: rootParentConditionId,
        outcomeUniverseDigest: computeAssetMonitoringOutcomeUniverseDigest(["Alpha", "Beta"]),
        internalOutcomeSetId: "Alpha",
      });
      const remote = {
        ...localPosition,
        monitoringAssetIdentity: monitoringIdentity,
        currentValueSats: 700,
      };
      expect(fetch).toHaveBeenCalled();
      expect(positions[0]?.monitoringAssetIdentity).toBe(monitoringIdentity);
      const merged = mergeMonitoringPositions([remote], positions);
      expect(merged).toHaveLength(1);
      expect(merged[0]).toMatchObject({
        status: "closed",
        canClaimPayout: outcome === "winner",
        canDiscard: outcome === "loser",
        currentValueSats: 700,
      });
      expect(
        mergeMonitoringPositions(
          [{ ...remote, monitoringAssetIdentity: "another-universe" }],
          positions,
        ),
      ).toHaveLength(2);
    },
  );

  it.each(["verified-losing", "pending-removal"])(
    "keeps %s holdings separate by mint and shows their removal state",
    async (selectability) => {
      mocks.getPortfolio.mockReturnValue(new Promise(() => {}));
      const proof = {
        assetKind: "conditional",
        conditionId: monitoredConditionId,
        outcomeCollection: "Alpha",
        baseAsset: "sat",
        unit: "msat",
        amount: 1_000,
        receivedAtMs: 10,
        selectability,
        claimRecoveryPending: false,
      };
      mocks.readCustody.mockResolvedValue([
        { ...proof, normalizedMint: "https://mint-a.example" },
        { ...proof, normalizedMint: "https://mint-b.example", amount: 2_000 },
      ]);
      renderHook(() => usePortfolioState());

      const positions = ((await mocks.localQueries[0]!()) as PortfolioPositionSnapshot).positions;

      expect(mocks.readCustody).toHaveBeenCalledWith("custody:wallet:" + "a".repeat(64));
      expect(positions.map(({ mintUrl, outcomeLabel }) => ({ mintUrl, outcomeLabel }))).toEqual([
        { mintUrl: "https://mint-a.example", outcomeLabel: "Alpha" },
        { mintUrl: "https://mint-b.example", outcomeLabel: "Alpha" },
      ]);
      expect(new Set(positions.map(({ id }) => id)).size).toBe(2);
      expect(positions.map(({ removalPending }) => removalPending)).toEqual([
        selectability === "pending-removal",
        selectability === "pending-removal",
      ]);
      expect(
        positions.every(
          ({ status, isLoser, canClaimPayout }) =>
            status === "closed" && isLoser && canClaimPayout === false,
        ),
      ).toBe(true);
    },
  );

  it("keeps unavailable canonical positions distinct from an empty wallet", async () => {
    mocks.getPortfolio.mockReturnValue(new Promise(() => {}));
    mocks.readCustody.mockResolvedValue(null);
    renderHook(() => usePortfolioState());

    await expect(mocks.localQueries[0]!()).resolves.toBeUndefined();
  });

  it.each([51, 101])(
    "loads all %i canonical conditions in distinct catalogue batches and keeps a later winner claimable",
    async (conditionCount) => {
      const conditionIds = Array.from({ length: conditionCount }, (_, index) =>
        conditionIdFor(index),
      );
      mocks.readCustody.mockResolvedValue([
        ...conditionIds.map((conditionId) => canonicalConditionalCustody(conditionId)),
        canonicalConditionalCustody(conditionIds[0]!, "NO"),
      ]);
      const requests = stubCatalogue({
        closedConditionId: conditionIds.at(-1)!,
      });

      const positions = await localPositionsAfterMonitoringFailure();

      expect(requests.map(({ conditionIds: ids }) => ids.length)).toEqual(
        conditionCount === 51 ? [50, 1] : [50, 50, 1],
      );
      expect(requests.flatMap(({ conditionIds: ids }) => ids)).toEqual(conditionIds);
      expect(
        requests.every(
          ({ conditionIds: ids, state, pageSize }) =>
            state === "All" && pageSize === `${ids.length}`,
        ),
      ).toBe(true);
      expect(positions).toHaveLength(conditionCount + 1);
      expect(
        positions.find((position) => position.marketId === `${conditionIds.at(-1)}-YES`),
      ).toMatchObject({
        status: "closed",
        isWinner: true,
        canClaimPayout: true,
      });
    },
  );

  it("keeps canonical holdings and successful sibling enrichment when a middle catalogue batch fails", async () => {
    const conditionIds = Array.from({ length: 101 }, (_, index) => conditionIdFor(index));
    mocks.readCustody.mockResolvedValue(
      conditionIds.map((conditionId, index) =>
        canonicalConditionalCustody(
          conditionId,
          "YES",
          index === 50 ? "verified-losing" : "selectable",
        ),
      ),
    );
    const requests = stubCatalogue({
      failedBatchStart: conditionIds[50],
      closedConditionId: conditionIds.at(-1)!,
    });

    const positions = await localPositionsAfterMonitoringFailure();
    const positionFor = (index: number) =>
      positions.find((position) => position.marketId === `${conditionIds[index]}-YES`)!;
    const verifiedLoser = positionFor(50);
    const missingMetadata = positionFor(51);
    const earlySibling = positionFor(0);
    const laterWinner = positionFor(100);

    expect(requests.map(({ conditionIds: ids }) => ids.length)).toEqual([50, 50, 1]);
    expect(requests.map(({ conditionIds: ids }) => ids[0])).toEqual([
      conditionIds[0],
      conditionIds[50],
      conditionIds[100],
    ]);
    expect(positions).toHaveLength(101);
    expect(verifiedLoser).toMatchObject({
      status: "closed",
      isLoser: true,
      canDiscard: true,
      canClaimPayout: false,
    });
    expect(verifiedLoser.monitoringAssetIdentity).toBeUndefined();
    expect(missingMetadata).toMatchObject({
      status: "active",
      side: "Outcome",
      isWinner: false,
      isLoser: false,
      isPending: false,
      canDiscard: false,
      canClaimPayout: false,
    });
    expect(missingMetadata.monitoringAssetIdentity).toBeUndefined();
    expect(missingMetadata.outcomeColor).toBeUndefined();
    expect(earlySibling).toMatchObject({ divisibility: 1_000, shares: 1 });
    expect(earlySibling.monitoringAssetIdentity).toBeDefined();
    expect(laterWinner).toMatchObject({
      status: "closed",
      isWinner: true,
      canClaimPayout: true,
    });
    expect(laterWinner.monitoringAssetIdentity).toBeDefined();

    const expectedIdentity = canonicalMonitoringAssetIdentity({
      kind: "conditional",
      canonicalMintUrl: "https://mint.example",
      cashuUnit: "msat",
      displayBaseAsset: "sat",
      conditionId: conditionIds[100]!,
      parentConditionId: rootParentConditionId,
      outcomeUniverseDigest: computeAssetMonitoringOutcomeUniverseDigest(["NO", "YES"]),
      internalOutcomeSetId: "YES",
    });
    expect(laterWinner.monitoringAssetIdentity).toBe(expectedIdentity);
    const monitorResponse = portfolioResponse();
    const monitored = mapMonitoringPortfolio({
      ...monitorResponse,
      assets: {
        ...monitorResponse.assets,
        assets: [conditionalMonitoringAsset(conditionIds[100]!)],
      },
    }).positions;
    const merged = mergeMonitoringPositions(monitored, positions);

    expect(monitored[0]?.monitoringAssetIdentity).toBe(laterWinner.monitoringAssetIdentity);
    expect(merged.find((position) => position.id === laterWinner.id)).toMatchObject({
      canClaimPayout: true,
      currentValueSats: 700,
    });
  });

  it("uses one portfolio request on first paint and no catalogue request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    mocks.getPortfolio.mockResolvedValue(portfolioResponse());

    renderHook(() => usePortfolioState());

    await waitFor(() => expect(mocks.getPortfolio).toHaveBeenCalledTimes(1));
    expect(mocks.getPortfolio).toHaveBeenCalledWith(
      {
        walletId: activeWalletId,
        timeframe: "ALL",
        pageSize: 200,
      },
      expect.any(AbortSignal),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("subscribes to only first-page conditions and marks appended rows outside that coverage", async () => {
    vi.useFakeTimers();
    try {
      const firstConditionIds = Array.from({ length: 200 }, (_, index) => conditionIdFor(index));
      const laterConditionIds = Array.from({ length: 10 }, (_, index) =>
        conditionIdFor(index + firstConditionIds.length),
      );
      mocks.getPortfolio.mockResolvedValue(
        portfolioWithConditionalConditions(firstConditionIds, "cursor-1"),
      );
      mocks.getAssetMonitoringAssets.mockResolvedValue({
        assets: laterConditionIds.map(conditionalAssetForCondition),
        nextCursor: null,
        valuationRevision: "revision-1",
        stale: false,
        incomplete: false,
        building: false,
      });
      const { result } = renderHook(() => usePortfolioState());
      const observer = mocks.portfolioObservers[0];

      await act(async () => {});
      expect(result.current.monitoring.incomplete).toBe(true);
      expect(result.current.monitoring.hasMoreAssets).toBe(true);
      expect(result.current.stats.totalValueSats).toBe(400_000);
      expect(observer?.conditionSets).toEqual([[...firstConditionIds].sort()]);
      expect(observer?.conditionSets[0]).toHaveLength(200);

      act(() => result.current.loadMoreAssets());
      await act(async () => {});

      expect(result.current.monitoring.hasMoreAssets).toBe(false);
      expect(result.current.monitoring.liveUpdateCoverageLimited).toBe(true);
      expect(result.current.positions).toHaveLength(211);
      expect(observer?.conditionSets).toHaveLength(1);

      act(() => observer?.onRefresh());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9_999);
      });
      expect(mocks.getPortfolio).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });

      expect(mocks.getPortfolio).toHaveBeenCalledTimes(2);
      expect(observer?.conditionSets).toHaveLength(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("batches local and paginated monitoring metadata by exact outcome identity", async () => {
    const localCondition = conditionIdFor(800);
    const firstMonitorCondition = conditionIdFor(801);
    const laterMonitorCondition = conditionIdFor(802);
    mocks.readCustody.mockResolvedValue([
      canonicalConditionalCustody(localCondition, "YES"),
      canonicalConditionalCustody(localCondition, "ALPHA|GAMMA"),
    ]);
    mocks.getPortfolio.mockResolvedValue(
      portfolioWithConditionalConditions([firstMonitorCondition], "cursor-1"),
    );
    mocks.getAssetMonitoringAssets.mockResolvedValue({
      assets: [conditionalAssetForCondition(laterMonitorCondition)],
      nextCursor: null,
      valuationRevision: "revision-1",
      stale: false,
      incomplete: false,
      building: false,
    });
    const catalogueRequests: string[][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const ids =
          new URL(String(input), "http://localhost").searchParams.get("ids")?.split(",") ?? [];
        catalogueRequests.push(ids);
        return new Response(
          JSON.stringify({
            markets: ids.map((conditionId) => ({
              conditionId,
              outcomes:
                conditionId === localCondition
                  ? ["YES", "ALPHA", "GAMMA"]
                  : conditionId === laterMonitorCondition
                    ? ["NO", "YES", "ALPHA"]
                    : ["NO", "YES"],
              outcomeDetails:
                conditionId === localCondition
                  ? [
                      { name: "GAMMA", color: "#CCCCCC" },
                      { name: "YES", color: "#123ABC" },
                      { name: "ALPHA", color: "#AABBCC" },
                    ]
                  : [{ name: "YES", color: "#FF00FF" }],
              title: "Market " + conditionId.slice(0, 4),
              divisibility: 1_000,
              state: "open",
            })),
          }),
          { status: 200 },
        );
      }),
    );

    const { result, rerender } = renderHook(() => usePortfolioState());
    await waitFor(() => expect(result.current.monitoring.hasMoreAssets).toBe(true));
    act(() => result.current.loadMoreAssets());
    await waitFor(() => expect(result.current.monitoring.hasMoreAssets).toBe(false));

    const expectedConditionKey = [firstMonitorCondition, laterMonitorCondition].sort().join(",");
    expect(mocks.localQueryDependencies.at(-2)).toContain(expectedConditionKey);
    const snapshot = (await mocks.localQueries.at(-2)!()) as PortfolioPositionSnapshot;
    expect(catalogueRequests).toHaveLength(1);
    expect(new Set(catalogueRequests[0])).toEqual(
      new Set([localCondition, firstMonitorCondition, laterMonitorCondition]),
    );

    const primitive = snapshot.positions.find((position) => position.outcomeId === "YES")!;
    const composite = snapshot.positions.find((position) => position.outcomeId === "ALPHA|GAMMA")!;
    expect(primitive).toMatchObject({ side: "Outcome", outcomeColor: "#123ABC" });
    expect(composite).toMatchObject({ side: "Outcome", outcomeColor: undefined });

    mocks.positionSnapshot = snapshot;
    rerender();
    const hookEnrichedMonitor = result.current.positions.find(
      (position) => position.marketId === laterMonitorCondition,
    )!;
    expect(hookEnrichedMonitor).toMatchObject({
      side: "Outcome",
      outcomeColor: "#FF00FF",
      marketTitle: "Market " + laterMonitorCondition.slice(0, 4),
      canSell: false,
      canClaimPayout: false,
      canDiscard: false,
    });

    const hookBinaryMonitor = result.current.positions.find(
      (position) => position.marketId === firstMonitorCondition,
    )!;
    expect(hookBinaryMonitor).toMatchObject({
      side: "yes",
      outcomeColor: undefined,
      canSell: false,
      canClaimPayout: false,
      canDiscard: false,
    });

    const monitorOnly = result.current.positions.find(
      (position) => position.marketId === laterMonitorCondition,
    )!;
    const enrichedMonitorOnly = enrichPositionWithCatalogue(
      monitorOnly,
      snapshot.marketCatalogue.get(laterMonitorCondition),
    );
    expect(enrichedMonitorOnly).toMatchObject({
      side: "Outcome",
      outcomeColor: "#FF00FF",
      canSell: false,
      canClaimPayout: false,
      canDiscard: false,
      marketTitle: "Market " + laterMonitorCondition.slice(0, 4),
    });

    const matchingMonitor = {
      ...monitorOnly,
      monitoringAssetIdentity: primitive.monitoringAssetIdentity,
      currentValueSats: 700,
    };
    const merged = mergeMonitoringPositions([matchingMonitor], [primitive]);
    expect(merged[0]).toMatchObject({
      outcomeColor: "#123ABC",
      currentValueSats: 700,
      canClaimPayout: false,
      canDiscard: false,
    });
  });

  it("keeps monitored rows visible while display catalogue enrichment is delayed or fails", async () => {
    const conditionId = conditionIdFor(803);
    mocks.readCustody.mockResolvedValue([canonicalConditionalCustody(conditionId)]);
    mocks.getPortfolio.mockResolvedValue(portfolioWithConditionalConditions([conditionId], null));
    const { result } = renderHook(() => usePortfolioState());
    await waitFor(() =>
      expect(result.current.positions.some((position) => position.marketId === conditionId)).toBe(
        true,
      ),
    );
    const remotePosition = result.current.positions.find(
      (position) => position.marketId === conditionId,
    )!;
    const originalStats = result.current.stats;
    expect(remotePosition).toMatchObject({
      side: "Outcome",
      canSell: false,
      canClaimPayout: false,
      canDiscard: false,
    });

    let resolveCatalogue!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveCatalogue = resolve;
          }),
      ),
    );
    const pendingRead = mocks.localQueries.at(-2)!();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(result.current.positions.some((position) => position.id === remotePosition.id)).toBe(
      true,
    );
    expect(result.current.stats).toEqual(originalStats);
    resolveCatalogue(new Response(null, { status: 503 }));
    const snapshot = (await pendingRead) as PortfolioPositionSnapshot;
    expect(snapshot.positions).toHaveLength(1);
    expect(snapshot.positions[0]).toMatchObject({ side: "Outcome", outcomeColor: undefined });
    expect(result.current.positions.some((position) => position.id === remotePosition.id)).toBe(
      true,
    );
    expect(result.current.stats).toEqual(originalStats);
  });

  it("discards a catalogue result after the active wallet scope changes", async () => {
    const conditionId = conditionIdFor(804);
    mocks.readCustody.mockResolvedValue([canonicalConditionalCustody(conditionId)]);
    mocks.getPortfolio.mockRejectedValue(new Error("signer unavailable"));
    let resolveCatalogue!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveCatalogue = resolve;
          }),
      ),
    );
    const { result } = renderHook(() => usePortfolioState());
    await waitFor(() => expect(result.current.monitoring.error).toBe("unavailable"));
    const pendingRead = mocks.localQueries.at(-2)!();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    mocks.activeScopeId = "new-wallet-scope";
    resolveCatalogue(
      new Response(
        JSON.stringify({
          markets: [
            {
              conditionId,
              outcomes: ["NO", "YES"],
              divisibility: 1_000,
              state: "open",
            },
          ],
        }),
        { status: 200 },
      ),
    );

    await expect(pendingRead).resolves.toBeUndefined();
  });

  it("coalesces valuation events on the first fixed ten-second wake", async () => {
    vi.useFakeTimers();
    try {
      mocks.getPortfolio.mockResolvedValue(completePortfolioResponse());
      renderHook(() => usePortfolioState());

      await act(async () => {});
      const observer = mocks.portfolioObservers[0];
      expect(observer?.conditionSets).toHaveLength(1);

      act(() => observer?.onRefresh());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      act(() => observer?.onRefresh());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_999);
      });
      expect(mocks.getPortfolio).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(mocks.getPortfolio).toHaveBeenCalledTimes(2);
      expect(observer?.conditionSets).toHaveLength(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("keeps one read in flight and drains a dirty trailing valuation wake", async () => {
    vi.useFakeTimers();
    try {
      const inFlight = deferred<AssetMonitoringPortfolioResponse>();
      const trailing = deferred<AssetMonitoringPortfolioResponse>();
      mocks.getPortfolio
        .mockResolvedValueOnce(completePortfolioResponse())
        .mockReturnValueOnce(inFlight.promise)
        .mockReturnValueOnce(trailing.promise);
      const { result } = renderHook(() => usePortfolioState());

      expect(result.current.stats.totalValueLoading).toBe(true);
      expect(result.current.stats.positionsValueLoading).toBe(true);
      await act(async () => {});
      const previousTotal = result.current.stats.totalValueSats;
      expect(result.current.stats.totalValueLoading).toBe(false);
      const observer = mocks.portfolioObservers[0];
      act(() => observer?.onRefresh());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(mocks.getPortfolio).toHaveBeenCalledTimes(2);
      expect(result.current.stats.totalValueLoading).toBe(true);
      expect(result.current.stats.positionsValueLoading).toBe(true);
      expect(result.current.stats.totalValueKnown).toBe(true);
      expect(result.current.stats.totalValueSats).toBe(previousTotal);

      act(() => observer?.onRefresh());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(mocks.getPortfolio).toHaveBeenCalledTimes(2);

      await act(async () => inFlight.resolve(completePortfolioResponse("ALL", 19_000)));
      expect(mocks.getPortfolio).toHaveBeenCalledTimes(3);
      await act(async () => trailing.resolve(completePortfolioResponse("ALL", 23_000)));

      expect(result.current.stats.totalValueSats).toBe(23_000);
      expect(result.current.stats.totalValueLoading).toBe(false);
      expect(result.current.stats.positionsValueLoading).toBe(false);
      expect(mocks.getPortfolio).toHaveBeenCalledTimes(3);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("refreshes a building unvalued portfolio and publishes the resolved total", async () => {
    vi.useFakeTimers();
    try {
      mocks.getPortfolio
        .mockResolvedValueOnce(buildingUnvaluedPortfolioResponse())
        .mockResolvedValueOnce(completePortfolioResponse("ALL", 19_000));
      const { result } = renderHook(() => usePortfolioState());

      await act(async () => {});
      expect(mocks.getPortfolio).toHaveBeenCalledTimes(1);
      expect(result.current.stats.totalValueKnown).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(mocks.getPortfolio).toHaveBeenCalledTimes(2);
      expect(result.current.stats.totalValueKnown).toBe(true);
      expect(result.current.stats.totalValueSats).toBe(19_000);
      expect(result.current.monitoring.building).toBe(false);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each(["summary", "assets", "history"] as const)(
    "refreshes when only %s reports building",
    async (section) => {
      vi.useFakeTimers();
      try {
        const building = completePortfolioResponse();
        building[section].building = true;
        mocks.getPortfolio
          .mockResolvedValueOnce(building)
          .mockResolvedValueOnce(completePortfolioResponse());
        renderHook(() => usePortfolioState());

        await act(async () => {});
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_000);
        });

        expect(mocks.getPortfolio).toHaveBeenCalledTimes(2);
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it("limits a continuously building portfolio to three extra reads", async () => {
    vi.useFakeTimers();
    try {
      mocks.getPortfolio.mockResolvedValue(buildingUnvaluedPortfolioResponse());
      const { result } = renderHook(() => usePortfolioState());

      await act(async () => {});
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_000);
        });
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(mocks.getPortfolio).toHaveBeenCalledTimes(4);
      expect(result.current.monitoring.building).toBe(true);
      expect(result.current.stats.totalValueKnown).toBe(false);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each(["stale", "incomplete", "unvalued"] as const)(
    "does not refresh a non-building %s portfolio",
    async (state) => {
      vi.useFakeTimers();
      try {
        const response = completePortfolioResponse();
        if (state === "stale") response.summary.stale = true;
        if (state === "incomplete") response.summary.incomplete = true;
        if (state === "unvalued") {
          response.summary.estimatedTotalValueMsat = null;
          response.summary.unvaluedAssetCount = 1;
          response.assets.assets[1] = {
            ...response.assets.assets[1]!,
            estimatedValueMsat: null,
            valuationStatus: "unvalued",
          };
        }
        mocks.getPortfolio.mockResolvedValue(response);
        renderHook(() => usePortfolioState());

        await act(async () => {});
        await act(async () => {
          await vi.advanceTimersByTimeAsync(40_000);
        });

        expect(mocks.getPortfolio).toHaveBeenCalledTimes(1);
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it("stops building refreshes after a failed read", async () => {
    vi.useFakeTimers();
    try {
      mocks.getPortfolio
        .mockResolvedValueOnce(buildingUnvaluedPortfolioResponse())
        .mockRejectedValueOnce(new Error("rate limited"));
      const { result } = renderHook(() => usePortfolioState());

      await act(async () => {});
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(40_000);
      });

      expect(mocks.getPortfolio).toHaveBeenCalledTimes(2);
      expect(result.current.monitoring.error).toBe("unavailable");
      expect(result.current.stats.totalValueLoading).toBe(false);
      expect(result.current.stats.positionsValueLoading).toBe(false);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("cancels a building refresh when the timeframe changes", async () => {
    vi.useFakeTimers();
    try {
      mocks.getPortfolio
        .mockResolvedValueOnce(buildingUnvaluedPortfolioResponse())
        .mockResolvedValueOnce(completePortfolioResponse("1D"));
      const { result } = renderHook(() => usePortfolioState());

      await act(async () => {});
      act(() => result.current.setSelectedTimeRange("1D"));
      await act(async () => {});
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });

      expect(mocks.getPortfolio).toHaveBeenCalledTimes(2);
      expect(mocks.getPortfolio).toHaveBeenLastCalledWith(
        {
          walletId: activeWalletId,
          timeframe: "1D",
          pageSize: 200,
        },
        expect.any(AbortSignal),
      );
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("cancels a building refresh when the hook unmounts", async () => {
    vi.useFakeTimers();
    try {
      mocks.getPortfolio.mockResolvedValue(buildingUnvaluedPortfolioResponse());
      const { unmount } = renderHook(() => usePortfolioState());

      await act(async () => {});
      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });

      expect(mocks.getPortfolio).toHaveBeenCalledTimes(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("coalesces wallet invalidations on the fixed wake and starts a new bounded cycle", async () => {
    vi.useFakeTimers();
    try {
      mocks.getPortfolio.mockResolvedValue(buildingUnvaluedPortfolioResponse());
      renderHook(() => usePortfolioState());

      await act(async () => {});
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(mocks.getPortfolio).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      act(() => publishPortfolioInvalidation({ walletId: activeWalletId }));
      act(() => publishPortfolioInvalidation({ walletId: activeWalletId }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_999);
      });
      expect(mocks.getPortfolio).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(mocks.getPortfolio).toHaveBeenCalledTimes(3);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_000);
        });
      }

      expect(mocks.getPortfolio).toHaveBeenCalledTimes(6);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("retries an aborted initial read during React Strict Mode effect replay", async () => {
    const firstRead = deferred<AssetMonitoringPortfolioResponse>();
    mocks.getPortfolio
      .mockReturnValueOnce(firstRead.promise)
      .mockResolvedValueOnce(portfolioResponse());
    const { result } = renderHook(() => usePortfolioState(), { reactStrictMode: true });

    await waitFor(() => expect(mocks.getPortfolio).toHaveBeenCalledTimes(2));
    expect(mocks.getPortfolio.mock.calls[0]?.[1]?.aborted).toBe(true);
    expect(mocks.getPortfolio.mock.calls[1]?.[1]?.aborted).toBe(false);
    await waitFor(() => expect(result.current.stats.totalValueSats).toBe(12_000));
    await act(async () =>
      firstRead.resolve({
        ...portfolioResponse(),
        summary: { ...portfolioResponse().summary, estimatedTotalValueMsat: 1 },
      }),
    );
    expect(result.current.stats.totalValueSats).toBe(12_000);
    expect(mocks.getPortfolio).toHaveBeenCalledTimes(2);
  });

  it("ignores invalid and inactive-wallet portfolio invalidations", async () => {
    vi.useFakeTimers();
    mocks.getPortfolio.mockResolvedValue(completePortfolioResponse());
    try {
      renderHook(() => usePortfolioState());

      await act(async () => {});
      expect(mocks.getPortfolio).toHaveBeenCalledTimes(1);
      act(() => {
        window.dispatchEvent(
          new CustomEvent(portfolioInvalidatedEvent, { detail: { walletId: "b".repeat(64) } }),
        );
        window.dispatchEvent(
          new CustomEvent(portfolioInvalidatedEvent, { detail: { walletId: "A".repeat(64) } }),
        );
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(mocks.getPortfolio).toHaveBeenCalledTimes(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("coalesces wallet invalidations without aborting an in-flight read", async () => {
    vi.useFakeTimers();
    try {
      const initial = deferred<AssetMonitoringPortfolioResponse>();
      const refresh = deferred<AssetMonitoringPortfolioResponse>();
      mocks.getPortfolio.mockReturnValueOnce(initial.promise).mockReturnValueOnce(refresh.promise);
      const { result } = renderHook(() => usePortfolioState());

      await act(async () => {});
      expect(mocks.getPortfolio).toHaveBeenCalledTimes(1);
      act(() => {
        publishPortfolioInvalidation({ walletId: activeWalletId });
        publishPortfolioInvalidation({ walletId: activeWalletId });
      });
      await act(async () =>
        initial.resolve({
          ...portfolioResponse(),
          summary: { ...portfolioResponse().summary, estimatedTotalValueMsat: 13_000 },
        }),
      );
      expect(result.current.stats.totalValueSats).toBe(13_000);
      expect(mocks.getPortfolio.mock.calls[0]?.[1]?.aborted).toBe(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9_999);
      });
      expect(mocks.getPortfolio).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(mocks.getPortfolio).toHaveBeenCalledTimes(2);
      expect(mocks.getPortfolio.mock.calls[1]?.[1]?.aborted).toBe(false);
      await act(async () => refresh.resolve(portfolioResponse()));

      expect(result.current.stats.totalValueSats).toBe(12_000);
      expect(mocks.getPortfolio).toHaveBeenCalledTimes(2);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("refreshes the active generation without waiting for an obsolete request", async () => {
    const obsolete = deferred<AssetMonitoringPortfolioResponse>();
    mocks.getPortfolio
      .mockReturnValueOnce(obsolete.promise)
      .mockResolvedValueOnce(portfolioResponse("1D"))
      .mockResolvedValueOnce(portfolioResponse("1D"));
    const { result } = renderHook(() => usePortfolioState());

    await waitFor(() => expect(mocks.getPortfolio).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    act(() => result.current.setSelectedTimeRange("1D"));
    await act(async () => {});
    expect(result.current.stats.totalValueSats).toBe(12_000);
    act(() => {
      publishPortfolioInvalidation({ walletId: activeWalletId });
    });

    expect(mocks.getPortfolio).toHaveBeenCalledTimes(2);
    expect(mocks.getPortfolio.mock.calls[1]?.[1]?.aborted).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    vi.clearAllTimers();
    vi.useRealTimers();

    expect(mocks.getPortfolio.mock.calls.map(([input]) => input.timeframe)).toEqual([
      "ALL",
      "1D",
      "1D",
    ]);
    expect(mocks.getPortfolio.mock.calls[0]?.[1]?.aborted).toBe(true);
    await act(async () =>
      obsolete.resolve({
        ...portfolioResponse(),
        summary: { ...portfolioResponse().summary, estimatedTotalValueMsat: 1 },
      }),
    );

    expect(result.current.selectedTimeRange).toBe("1D");
    expect(result.current.stats.totalValueSats).toBe(12_000);
  });

  it("resets appended pagination for a portfolio invalidation", async () => {
    const portfolioWithMoreAssets = completePortfolioResponse();
    portfolioWithMoreAssets.assets.nextCursor = "cursor-1";
    portfolioWithMoreAssets.assets.incomplete = true;
    mocks.getPortfolio
      .mockResolvedValueOnce(portfolioWithMoreAssets)
      .mockResolvedValueOnce(completePortfolioResponse());
    mocks.getAssetMonitoringAssets.mockResolvedValue(nextPage(conditionalAsset("NO")));
    const { result } = renderHook(() => usePortfolioState());

    await waitFor(() => expect(result.current.monitoring.hasMoreAssets).toBe(true));
    act(() => result.current.loadMoreAssets());
    await waitFor(() =>
      expect(result.current.positions.some((item) => item.outcomeId === "NO")).toBe(true),
    );
    vi.useFakeTimers();
    act(() => {
      publishPortfolioInvalidation({ walletId: activeWalletId });
    });

    expect(mocks.getPortfolio).toHaveBeenCalledTimes(1);
    expect(result.current.positions.some((item) => item.outcomeId === "NO")).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    vi.clearAllTimers();
    vi.useRealTimers();

    expect(mocks.getPortfolio).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.monitoring.hasMoreAssets).toBe(false));
    expect(result.current.positions.some((item) => item.outcomeId === "NO")).toBe(false);
  });

  it("does not retry a failed portfolio invalidation refresh", async () => {
    vi.useFakeTimers();
    try {
      mocks.getPortfolio
        .mockResolvedValueOnce(portfolioResponse())
        .mockRejectedValueOnce(new Error("down"));
      const { result } = renderHook(() => usePortfolioState());

      await act(async () => {});
      expect(result.current.stats.totalValueSats).toBe(12_000);
      act(() => {
        publishPortfolioInvalidation({ walletId: activeWalletId });
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(result.current.monitoring.error).toBe("unavailable");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(40_000);
      });
      expect(mocks.getPortfolio).toHaveBeenCalledTimes(2);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("uses server summary, history, and first asset page as display-only rows", () => {
    const mapped = mapMonitoringPortfolio(portfolioResponse());

    expect(mapped.stats.totalValueSats).toBe(12_000);
    expect(mapped.stats.positionsValueSats).toBe(5_000);
    expect(mapped.chart).toEqual([]);
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
    expect(mapped.positions[0]?.divisibility).toBeUndefined();
    expect(mapped.monitoring).toMatchObject({
      stale: true,
      incomplete: true,
      building: true,
      unvaluedAssetCount: 1,
      hasPendingOutgoing: false,
      pendingOutgoingValueMsat: 0,
    });
  });

  it("preserves the server aggregate with available and pending values", () => {
    const response = completePortfolioResponse("ALL", 12_000);
    response.summary.availableValueMsat = 4_000;
    response.summary.pendingOutgoingValueMsat = 8_000;
    Object.assign(response.assets.assets[0]!, {
      availableSubunits: 1_000,
      pendingOutgoingSubunits: 2_000,
      availableValueMsat: 1_000,
      pendingOutgoingValueMsat: 2_000,
      estimatedValueMsat: 3_000,
    });
    Object.assign(response.assets.assets[1]!, {
      availableSubunits: 3_000,
      pendingOutgoingSubunits: 6_000,
      availableValueMsat: 3_000,
      pendingOutgoingValueMsat: 6_000,
      estimatedValueMsat: 9_000,
    });

    const mapped = mapMonitoringPortfolio(response);

    expect(mapped.stats.totalValueSats).toBe(12_000);
    expect(mapped.stats.positionsValueSats).toBe(9_000);
    expect(mapped.funds[0]?.amount).toBe(1_000);
    expect(mapped.monitoring).toMatchObject({
      hasPendingOutgoing: true,
      pendingOutgoingValueMsat: 8_000,
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

  it.each([
    ["priced", 720, 720],
    ["missing current price", null, null],
    ["missing historical price", 720, null],
  ] as const)(
    "preserves the server estimate for a No B-only portfolio: %s",
    (_case, currentValue, historicalValue) => {
      const response = portfolioResponse();
      const holding = conditionalAsset("A|C");
      if (holding.asset.kind !== "conditional") throw new Error("fixture must be conditional");
      holding.asset.conditionId = monitoredConditionId;
      holding.asset.outcomeUniverseDigest = computeAssetMonitoringOutcomeUniverseDigest([
        "A",
        "B",
        "C",
      ]);
      holding.availableSubunits = 1_000;
      holding.estimatedValueMsat = currentValue;
      holding.valuationStatus = currentValue === null ? "unvalued" : "valued";
      Object.assign(response.summary, {
        availableValueMsat: currentValue ?? 0,
        estimatedTotalValueMsat: currentValue ?? 0,
        unvaluedAssetCount: currentValue === null ? 1 : 0,
        unvaluedAvailableSubunits: currentValue === null ? 1_000 : 0,
        stale: false,
        incomplete: false,
        building: false,
      });
      response.assets.assets = [holding];
      response.assets.incomplete = false;
      response.history.points[0].estimatedTotalValueMsat = historicalValue;

      const mapped = mapMonitoringPortfolio(response);

      expect(mapped.positions).toHaveLength(1);
      expect(mapped.positions[0].valueKnown).toBe(currentValue !== null);
      expect(mapped.stats.totalValueKnown).toBe(currentValue !== null);
      expect(mapped.stats.positionsValueKnown).toBe(currentValue !== null);
      if (currentValue !== null) expect(mapped.stats.totalValueSats).toBe(720);
      expect(mapped.monitoring).toMatchObject({ stale: false, incomplete: false, building: false });
      expect(mapped.chart).toHaveLength(historicalValue === null ? 0 : 1);
    },
  );

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

  it("keeps a non-null partial total unknown while any asset is unvalued", () => {
    const response = portfolioResponse();
    response.summary.estimatedTotalValueMsat = 12_000;
    response.summary.unvaluedAssetCount = 1;

    const mapped = mapMonitoringPortfolio(response);

    expect(mapped.stats.totalValueKnown).toBe(false);
    expect(mapped.stats.totalValueByUnit).toBeUndefined();
    expect(mapped.chart).toEqual([]);
  });

  it.each(["incomplete", "building"] as const)(
    "keeps a non-null total unknown while the summary is %s",
    (flag) => {
      const response = portfolioResponse();
      response.summary.unvaluedAssetCount = 0;
      response.summary.incomplete = false;
      response.summary.building = false;
      response.summary[flag] = true;
      response.assets.incomplete = false;
      response.assets.building = false;
      response.assets.nextCursor = null;

      const mapped = mapMonitoringPortfolio(response);

      expect(mapped.stats.totalValueKnown).toBe(false);
      expect(mapped.stats.totalValueByUnit).toBeUndefined();
      expect(mapped.chart).toEqual([]);
    },
  );

  it.each(["incomplete", "building"] as const)(
    "keeps positions unknown while the asset page is %s",
    (flag) => {
      const response = portfolioResponse();
      response.summary.unvaluedAssetCount = 0;
      response.summary.incomplete = false;
      response.summary.building = false;
      response.assets.incomplete = false;
      response.assets.building = false;
      response.assets[flag] = true;

      const mapped = mapMonitoringPortfolio(response);

      expect(mapped.stats.positionsValueKnown).toBe(false);
      expect(mapped.stats.totalValueKnown).toBe(true);
      expect(mapped.stats.totalValueByUnit).toEqual([{ unit: "sat", amount: 12_000 }]);
    },
  );

  it("keeps positions unknown until all asset pages are loaded", () => {
    const response = portfolioResponse();
    response.summary.unvaluedAssetCount = 0;
    response.summary.incomplete = false;
    response.summary.building = false;
    response.assets.incomplete = false;
    response.assets.building = false;
    response.assets.nextCursor = "cursor-next";

    const mapped = mapMonitoringPortfolio(response);

    expect(mapped.stats.positionsValueKnown).toBe(false);
    expect(mapped.monitoring.incomplete).toBe(true);
  });

  it.each(["incomplete", "building"] as const)(
    "does not emit a chart while history is %s",
    (flag) => {
      const response = portfolioResponse();
      response.summary.unvaluedAssetCount = 0;
      response.summary.incomplete = false;
      response.summary.building = false;
      response.assets.incomplete = false;
      response.assets.building = false;
      response.assets.nextCursor = null;
      response.history[flag] = true;

      const mapped = mapMonitoringPortfolio(response);

      expect(mapped.stats.totalValueKnown).toBe(true);
      expect(mapped.chart).toEqual([]);
    },
  );

  it("does not filter unknown history points into a partial chart", () => {
    const response = portfolioResponse();
    response.summary.unvaluedAssetCount = 0;
    response.summary.incomplete = false;
    response.summary.building = false;
    response.assets.incomplete = false;
    response.assets.building = false;
    response.assets.nextCursor = null;
    response.history.points = [
      { asOf: "2026-08-09T00:00:00.000Z", estimatedTotalValueMsat: 12_000 },
      { asOf: "2026-08-10T00:00:00.000Z", estimatedTotalValueMsat: null },
      { asOf: "2026-08-11T00:00:00.000Z", estimatedTotalValueMsat: 13_000 },
    ];

    const mapped = mapMonitoringPortfolio(response);

    expect(mapped.stats.totalValueKnown).toBe(true);
    expect(mapped.chart).toEqual([]);
  });

  it("keeps local rows and activity but no chart history when monitoring fails", async () => {
    mocks.activityItems.push(
      {
        id: "deposit-1",
        walletId: activeWalletId,
        type: "deposit",
        amountSubunits: 5_000,
        baseAsset: "sat",
        date: "2026-09-23T00:00:00.000Z",
        status: "completed",
        txId: null,
        lightningInvoice: null,
      },
      {
        id: "payout-1",
        walletId: activeWalletId,
        type: "payout_claimed",
        amountSubunits: 2_000,
        baseAsset: "sat",
        date: "2026-09-24T00:00:00.000Z",
        status: "completed",
        txId: null,
        lightningInvoice: null,
      },
      {
        id: "previous-wallet-deposit",
        walletId: "b".repeat(64),
        type: "deposit",
        amountSubunits: 7_000,
        baseAsset: "sat",
        date: "2026-09-25T00:00:00.000Z",
        status: "completed",
        txId: null,
        lightningInvoice: null,
      },
      {
        id: "legacy-deposit",
        type: "deposit",
        amountSubunits: 8_000,
        baseAsset: "sat",
        date: "2026-09-26T00:00:00.000Z",
        status: "completed",
        txId: null,
        lightningInvoice: null,
      },
    );
    mocks.getPortfolio.mockRejectedValue(new Error("signer unavailable"));
    const { result } = renderHook(() => usePortfolioState());

    await waitFor(() => expect(result.current.monitoring.error).toBe("unavailable"));
    expect(result.current.positions).toEqual([localPosition]);
    expect(result.current.funds).toEqual([localFund]);
    expect(result.current.activity).toHaveLength(2);
    expect(result.current.stats.totalValueSats).toBe(6_000);
    expect(result.current.plChartData).toEqual({ "1D": [], "1W": [], "1M": [], ALL: [] });
  });

  it.each(["null", "undefined"] as const)(
    "marks totals unknown when canonical local custody is %s",
    async (localFundsState) => {
      mocks.localFundsState = localFundsState;
      mocks.getPortfolio.mockRejectedValue(new Error("signer unavailable"));
      const { result } = renderHook(() => usePortfolioState());

      await waitFor(() => expect(result.current.monitoring.error).toBe("unavailable"));
      expect(result.current.stats.totalValueKnown).toBe(false);
      expect(result.current.stats.totalValueByUnit).toBeUndefined();
    },
  );

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
        canonicalMintUrl: "https://other-mint.example",
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
      walletId: activeWalletId,
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
