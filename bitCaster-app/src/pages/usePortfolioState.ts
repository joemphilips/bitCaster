import { useState, useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  db,
  getCanonicalCurrentProofs,
  isCtfProof,
  type BitcasterDB,
  type StoredProof,
} from "@/stores/proof-db";
import { readCanonicalPortfolioCustody } from "@/stores/portfolio-custody";
import { useWalletStore } from "@/stores/wallet";
import { useSettingsStore } from "@/stores/settings";
import { useActivityLogStore } from "@/stores/activity-log";
import { safeHostname } from "@/lib/url";
import { canonicalizeOutcomeSet } from "@bitcaster/client-sdk/outcomeSets";
import {
  createAuthenticatedBrowserEngineClient,
  type MarketCatalogueEntry,
  type MarketCatalogueResponse,
} from "@/lib/markets";
import {
  activeBrowserWalletScopeId,
  browserWalletIdFromMnemonic,
  browserWalletScopeIdFromMnemonic,
} from "@/lib/browserWalletProfile";
import {
  cashuAmountToMarketSubunits,
  normalizeMarketBaseAsset,
  parseCashuProofUnit,
  parseMarketDivisibility,
  type MarketBaseAsset,
} from "@bitcaster/client-sdk/marketUnits";
import { groupAmountsByUnit } from "@/lib/formatAmount";
import type {
  WalletState,
  BaseCurrency,
  PLTimeSelector,
  PLChartData,
  PLChartDataPoint,
  PortfolioStats,
  UserProfile,
  Position,
  Fund,
  ActivityItem,
  CreatedMarket,
  PortfolioMonitoringState,
} from "@/types/portfolio";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import { deriveWinner } from "@/lib/positionWinner";
import type {
  AssetMonitoringAssetReference,
  AssetMonitoringAssetResponse,
  AssetMonitoringConditionalAssetReference,
  AssetMonitoringPortfolioResponse,
} from "@bitcaster/client-sdk/assetMonitoring";
import {
  computeAssetMonitoringOutcomeUniverseDigest,
  decodeAssetMonitoringWalletId,
} from "@bitcaster/client-sdk/assetMonitoring";
import {
  listenForPortfolioInvalidation,
  type PortfolioInvalidation,
} from "@/lib/portfolioInvalidation";
import { observePortfolioValuations } from "@/lib/marketHub";
import { getNostrSignerRevision, subscribeToNostrSignerRevision } from "@/lib/nostr";

const automaticPortfolioRefreshDelayMs = 10_000;
const maximumBuildingPortfolioExtraReads = 3;
type PortfolioPositionSnapshot = {
  scopeId: string;
  positions: Position[];
  marketCatalogue: Map<string, MarketCatalogueEntry>;
};
const EMPTY_MARKET_CATALOGUE = new Map<string, MarketCatalogueEntry>();

interface PortfolioState {
  walletState: WalletState;
  baseCurrency: BaseCurrency;
  selectedTimeRange: PLTimeSelector;
  profile: UserProfile;
  plChartData: PLChartData;
  stats: PortfolioStats;
  positions: Position[];
  funds: Fund[];
  activity: ActivityItem[];
  createdMarkets: CreatedMarket[];
  positionsTab: "active" | "closed";
  monitoring: PortfolioMonitoringState;
}

const EMPTY_PL_CHART_DATA: PLChartData = { "1D": [], "1W": [], "1M": [], ALL: [] };

const DEFAULT_PROFILE: UserProfile = {
  userId: "",
  displayName: "Anon",
  avatarUrl: null,
  registeredDate: new Date().toISOString(),
};

function loadProfile(): UserProfile {
  try {
    const stored = localStorage.getItem("bitcaster-profile");
    if (stored) return JSON.parse(stored);
  } catch {
    // ignore
  }
  return DEFAULT_PROFILE;
}

export function computeStats(positions: Position[], funds: Fund[]): PortfolioStats {
  const activePositions = positions.filter((p) => p.status === "active");
  const valuedActivePositions = activePositions.filter((p) => p.valueKnown !== false);
  const positionsValueByUnit = groupAmountsByUnit(
    valuedActivePositions,
    (p) => p.baseAsset,
    (p) => p.currentValueSats,
  );
  const fundValueByUnit = groupAmountsByUnit(
    funds,
    (f) => (f.unit === "sats" ? "sat" : f.unit),
    (f) => f.amount,
  );
  const totalValueByUnit = groupAmountsByUnit(
    [...positionsValueByUnit, ...fundValueByUnit],
    (entry) => entry.unit,
    (entry) => entry.amount,
  );
  const positionsValueSats =
    positionsValueByUnit.find((entry) => entry.unit === "sat")?.amount ?? 0;
  const totalValueSats = totalValueByUnit.find((entry) => entry.unit === "sat")?.amount ?? 0;
  const positionsValueKnown = positions.every((position) => position.valueKnown !== false);
  return {
    positionsValueSats,
    totalValueSats,
    positionsValueKnown,
    totalValueKnown: positionsValueKnown,
    positionsValueByUnit,
    totalValueByUnit,
    predictionsCount: positions.length,
  };
}

function isBinaryYesNoUniverse(outcomes: readonly string[]): boolean {
  if (outcomes.length !== 2) return false;
  const normalized = new Set(outcomes.map((outcome) => outcome.toUpperCase()));
  return normalized.has("YES") && normalized.has("NO");
}

function positionSide(
  outcomeCollection: string,
  market: MarketCatalogueEntry | undefined,
): Position["side"] {
  if (!market || !isBinaryYesNoUniverse(market.outcomes)) return "Outcome";
  if (!market.outcomes.includes(outcomeCollection)) return "Outcome";
  const normalized = outcomeCollection.toUpperCase();
  if (normalized === "YES") return "yes";
  if (normalized === "NO") return "no";
  return "Outcome";
}

function outcomeDisplayColor(
  outcomeCollection: string,
  market: MarketCatalogueEntry | undefined,
): string | undefined {
  if (
    !market ||
    isBinaryYesNoUniverse(market.outcomes) ||
    outcomeCollection.includes("|") ||
    !market.outcomes.includes(outcomeCollection)
  )
    return undefined;
  const color = market.outcomeDetails?.find((detail) => detail.name === outcomeCollection)?.color;
  return typeof color === "string" ? color : undefined;
}

export function enrichPositionWithCatalogue(
  position: Position,
  market: MarketCatalogueEntry | undefined,
): Position {
  const outcomeCollection = position.outcomeId ?? position.outcomeLabel ?? "";
  return {
    ...position,
    marketTitle: market?.title ?? position.marketTitle,
    marketImageUrl: market?.thumbnailUrl ?? position.marketImageUrl,
    side: positionSide(outcomeCollection, market),
    outcomeColor: outcomeDisplayColor(outcomeCollection, market),
  };
}

function conditionLabel(conditionId: string): string {
  return `Condition ${conditionId.slice(0, 12)}`;
}

async function loadMarketCatalogue(
  conditionIds: string[],
): Promise<Map<string, MarketCatalogueEntry>> {
  if (conditionIds.length === 0) return new Map();
  const uniqueConditionIds = [...new Set(conditionIds)];
  const catalogue = new Map<string, MarketCatalogueEntry>();
  for (let offset = 0; offset < uniqueConditionIds.length; offset += 50) {
    const batch = uniqueConditionIds.slice(offset, offset + 50);
    try {
      const search = new URLSearchParams({
        ids: batch.join(","),
        state: "All",
        page_size: String(batch.length),
      });
      const response = await fetch(`/api/v1/markets/query?${search}`, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) continue;
      const body = (await response.json()) as MarketCatalogueResponse;
      const requestedIds = new Set(batch);
      for (const market of body.markets ?? []) {
        if (requestedIds.has(market.conditionId)) catalogue.set(market.conditionId, market);
      }
    } catch {
      // Keep successful sibling batches when one catalogue page is unavailable.
    }
  }
  return catalogue;
}

function monitoringAssetValue(asset: AssetMonitoringAssetResponse): number {
  return asset.estimatedValueMsat ?? 0;
}

export function canonicalMonitoringAssetIdentity(asset: AssetMonitoringAssetReference): string {
  const common = [asset.kind, asset.canonicalMintUrl, asset.cashuUnit, asset.displayBaseAsset];
  switch (asset.kind) {
    case "collateral":
      return JSON.stringify(common);
    case "conditional":
      return JSON.stringify([
        ...common,
        asset.conditionId,
        asset.parentConditionId,
        asset.outcomeUniverseDigest,
        asset.internalOutcomeSetId,
      ]);
  }
}

function sameMonitoringAsset(
  left: AssetMonitoringAssetResponse,
  right: AssetMonitoringAssetResponse,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export type MonitoringAssetAppendResult =
  | { kind: "appended"; assets: AssetMonitoringAssetResponse[] }
  | { kind: "duplicate" | "conflict"; assets: AssetMonitoringAssetResponse[] };

export function appendMonitoringAssets(
  existing: AssetMonitoringAssetResponse[],
  incoming: AssetMonitoringAssetResponse[],
): MonitoringAssetAppendResult {
  const known = new Map(
    existing.map((asset) => [canonicalMonitoringAssetIdentity(asset.asset), asset]),
  );
  for (const asset of incoming) {
    const identity = canonicalMonitoringAssetIdentity(asset.asset);
    const current = known.get(identity);
    if (!current) {
      known.set(identity, asset);
      continue;
    }
    return {
      kind: sameMonitoringAsset(current, asset) ? "duplicate" : "conflict",
      assets: existing,
    };
  }
  return { kind: "appended", assets: [...existing, ...incoming] };
}

function localMonitoringAssetIdentity(
  position: {
    mintUrl: string;
    conditionId: string;
    outcomeCollection: string;
    baseAsset: MarketBaseAsset;
    unit: string;
  },
  market: MarketCatalogueEntry | undefined,
): string | null {
  if (!market || position.baseAsset !== "sat" || position.unit !== "msat") return null;
  const selected = position.outcomeCollection.split("|");
  try {
    if (
      selected.length >= market.outcomes.length ||
      canonicalizeOutcomeSet(selected) !== position.outcomeCollection ||
      !selected.every((outcome) => market.outcomes.includes(outcome))
    )
      return null;
    const asset: AssetMonitoringConditionalAssetReference = {
      canonicalMintUrl: position.mintUrl,
      kind: "conditional",
      cashuUnit: "msat",
      displayBaseAsset: position.baseAsset,
      conditionId: position.conditionId,
      parentConditionId: "0".repeat(64),
      outcomeUniverseDigest: computeAssetMonitoringOutcomeUniverseDigest(
        [...market.outcomes].sort(),
      ),
      internalOutcomeSetId: position.outcomeCollection,
    };
    return canonicalMonitoringAssetIdentity(asset);
  } catch {
    // Missing or invalid display metadata must not hide local custody or its actions.
    return null;
  }
}

function monitoringPosition(asset: AssetMonitoringAssetResponse): Position | null {
  if (asset.asset.kind !== "conditional") return null;
  const value = monitoringAssetValue(asset);
  const conditionId = asset.asset.conditionId;
  const identity = canonicalMonitoringAssetIdentity(asset.asset);
  const divisibility = parseMarketDivisibility(
    (asset as AssetMonitoringAssetResponse & { divisibility?: unknown }).divisibility,
  );
  return {
    id: `monitoring:${identity}`,
    marketId: conditionId,
    marketTitle: conditionLabel(conditionId),
    marketImageUrl: "",
    side: "Outcome",
    outcomeId: asset.asset.internalOutcomeSetId,
    outcomeLabel: asset.asset.internalOutcomeSetId,
    canSell: false,
    canClaimPayout: false,
    canDiscard: false,
    monitoringAssetIdentity: identity,
    baseAsset: "sat",
    divisibility: divisibility ?? undefined,
    currentValueSats: value,
    valueKnown: asset.valuationStatus === "valued" && asset.estimatedValueMsat != null,
    status: "active",
    isWinner: false,
    isLoser: false,
    isPending: false,
    acquiredDate: "",
    mintUrl: asset.asset.canonicalMintUrl,
  };
}

type LocalFundMint = { readonly url: string; readonly info?: Record<string, unknown> };

/** Groups canonical, spendable product proofs for the read-only Funds view. */
export function buildLocalFunds(
  proofs: readonly StoredProof[],
  mints: readonly LocalFundMint[],
): (Fund & { mintName: string })[] {
  const balanceByMintAndAsset = new Map<
    string,
    { mintUrl: string; baseAsset: MarketBaseAsset; unit: "msat"; amount: number }
  >();
  for (const proof of proofs) {
    const unit = parseCashuProofUnit(proof.unit);
    if (!unit) {
      throw new Error(`Stored proof has unsupported unit '${String(proof.unit)}'`);
    }
    if (
      isCtfProof(proof) ||
      proof.reservedBy !== undefined ||
      proof.terminalOperationId !== undefined ||
      unit !== "msat"
    )
      continue;
    // Canonical custody rows carry the normalized mint and product asset
    // metadata before this helper runs. Product regular assets are msat
    // displayed as sats.
    if (proof.baseAsset !== "sat") continue;
    const key = `${proof.mintUrl}:msat:sat`;
    const current = balanceByMintAndAsset.get(key);
    balanceByMintAndAsset.set(key, {
      mintUrl: proof.mintUrl,
      baseAsset: "sat",
      unit: "msat",
      amount:
        (current?.amount ?? 0) + cashuAmountToMarketSubunits(amountToNumber(proof.amount), "msat"),
    });
  }
  return [...balanceByMintAndAsset.values()].map(({ mintUrl, baseAsset, unit, amount }) => {
    const mintInfo = mints.find((mint) => mint.url === mintUrl);
    const name = mintInfo?.info?.name;
    return {
      id: `${mintUrl}:${unit}:${baseAsset}`,
      unit: "sats" as const,
      amount,
      mintUrl,
      mintName: typeof name === "string" ? name : safeHostname(mintUrl),
    };
  });
}

/** Reads the canonical spendable source used by the local Funds fallback. */
export async function readCanonicalLocalFunds(
  scopeId: string,
  mints: readonly LocalFundMint[],
  database: BitcasterDB = db,
): Promise<(Fund & { mintName: string })[] | null> {
  const proofs = await getCanonicalCurrentProofs(scopeId, database);
  return proofs === null ? null : buildLocalFunds(proofs, mints);
}

export function mergeMonitoringPositions(
  monitoringPositions: Position[],
  localPositions: Position[],
): Position[] {
  const unmatchedLocal = new Set(localPositions);
  const localByAsset = new Map(
    localPositions
      .filter((position) => position.monitoringAssetIdentity !== undefined)
      .map((position) => [position.monitoringAssetIdentity!, position] as const),
  );
  const merged = monitoringPositions.map((monitoringPosition) => {
    const key = monitoringPosition.monitoringAssetIdentity;
    if (!key) return monitoringPosition;
    const local = localByAsset.get(key);
    if (!local) return monitoringPosition;
    localByAsset.delete(key);
    unmatchedLocal.delete(local);
    return {
      ...local,
      currentValueSats: monitoringPosition.currentValueSats,
      valueKnown: monitoringPosition.valueKnown,
    };
  });
  return [...merged, ...unmatchedLocal];
}

export function mapMonitoringPortfolio(response: AssetMonitoringPortfolioResponse): {
  stats: PortfolioStats;
  positions: Position[];
  funds: Fund[];
  chart: PLChartDataPoint[];
  monitoring: Omit<
    PortfolioMonitoringState,
    "error" | "assetPageError" | "hasMoreAssets" | "loadingMoreAssets" | "retainingDisplay"
  >;
} {
  const positions = response.assets.assets
    .map(monitoringPosition)
    .filter((position): position is Position => position !== null);
  const funds = response.assets.assets
    .filter((asset) => asset.asset.kind === "collateral")
    .map(
      (asset): Fund => ({
        id: `monitoring:${canonicalMonitoringAssetIdentity(asset.asset)}`,
        unit: "sats",
        amount:
          asset.availableValueMsat ??
          cashuAmountToMarketSubunits(asset.availableSubunits, asset.asset.cashuUnit),
        mintUrl: asset.asset.canonicalMintUrl,
        monitoringAssetIdentity: canonicalMonitoringAssetIdentity(asset.asset),
      }),
    );
  const positionsValueKnown =
    response.assets.nextCursor == null &&
    response.summary.unvaluedAssetCount === 0 &&
    !response.assets.incomplete &&
    !response.assets.building &&
    positions.every((position) => position.valueKnown !== false);
  const positionsValueSats = positions
    .filter((position) => position.valueKnown !== false)
    .reduce((total, position) => total + position.currentValueSats, 0);
  const totalValueKnown =
    response.summary.estimatedTotalValueMsat !== null &&
    response.summary.unvaluedAssetCount === 0 &&
    !response.summary.incomplete &&
    !response.summary.building;
  const historyComplete =
    !response.history.incomplete &&
    !response.history.building &&
    response.history.points.every((point) => point.estimatedTotalValueMsat !== null);
  const chartComplete = totalValueKnown && historyComplete;
  return {
    stats: {
      positionsValueSats,
      totalValueSats: response.summary.estimatedTotalValueMsat ?? 0,
      positionsValueKnown,
      totalValueKnown,
      positionsValueByUnit: positionsValueKnown
        ? [{ unit: "sat", amount: positionsValueSats }]
        : undefined,
      totalValueByUnit: totalValueKnown
        ? [{ unit: "sat", amount: response.summary.estimatedTotalValueMsat! }]
        : undefined,
      predictionsCount: positions.length,
    },
    positions,
    funds,
    chart: chartComplete
      ? response.history.points.map((point) => ({
          timestamp: point.asOf,
          cumulativePL: point.estimatedTotalValueMsat!,
        }))
      : [],
    monitoring: {
      stale: response.summary.stale || response.assets.stale || response.history.stale,
      incomplete:
        response.summary.incomplete ||
        response.assets.incomplete ||
        response.assets.nextCursor != null ||
        response.history.incomplete,
      building: response.summary.building || response.assets.building || response.history.building,
      unvaluedAssetCount: response.summary.unvaluedAssetCount,
      hasPendingOutgoing: response.assets.assets.some((asset) => asset.pendingOutgoingSubunits > 0),
      pendingOutgoingValueMsat: response.summary.pendingOutgoingValueMsat,
      liveUpdateCoverageLimited: false,
    },
  };
}

export function usePortfolioState(): PortfolioState & {
  setSelectedTimeRange: (range: PLTimeSelector) => void;
  setPositionsTab: (tab: "active" | "closed") => void;
  saveProfile: (profile: UserProfile) => void;
  dismissMonitoringError: () => void;
  loadMoreAssets: () => void;
  dismissAssetPageError: () => void;
} {
  const walletSetupComplete = useWalletStore((s) => s.setupComplete);
  const walletState: WalletState = walletSetupComplete ? "ready" : "none";
  const [baseCurrency] = useState<BaseCurrency>("BTC");
  const [selectedTimeRange, setSelectedTimeRange] = useState<PLTimeSelector>("ALL");
  const [monitoringResponse, setMonitoringResponse] = useState<{
    key: string;
    value: AssetMonitoringPortfolioResponse;
  } | null>(null);
  const [monitoringError, setMonitoringError] = useState<"unavailable" | null>(null);
  // One bounded first-page response, for display only. Never retain local actions or proofs.
  const [lastCompleteDisplay, setLastCompleteDisplay] = useState<{
    scopeKey: string;
    value: AssetMonitoringPortfolioResponse;
  } | null>(null);
  const signerRevision = useSyncExternalStore(
    subscribeToNostrSignerRevision,
    getNostrSignerRevision,
    getNostrSignerRevision,
  );
  const [loadingMonitoringKey, setLoadingMonitoringKey] = useState<string | null>(null);
  const [monitoringAssets, setMonitoringAssets] = useState<{
    key: string;
    generation: number;
    assets: AssetMonitoringAssetResponse[];
    nextCursor: string | null;
  } | null>(null);
  const [assetPageError, setAssetPageError] = useState<{
    key: string;
    generation: number;
  } | null>(null);
  const [loadingMoreAssets, setLoadingMoreAssets] = useState(false);
  const [monitoringUnavailable, setMonitoringUnavailable] = useState(false);
  const [portfolioRefreshEpoch, setPortfolioRefreshEpoch] = useState(0);
  const requestedMonitoringKey = useRef<string | null>(null);
  const activeMonitoringKey = useRef<string | null>(null);
  const activeMonitoringRequest = useRef(0);
  const activeAssetPageRequest = useRef(0);
  const assetPageInFlight = useRef(false);
  const activePortfolioRead = useRef<{
    monitoringKey: string;
    requestKey: string;
    requestId: number;
    controller: AbortController;
  } | null>(null);
  const automaticRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const automaticRefreshTimerKind = useRef<"notification" | "building" | null>(null);
  const automaticRefreshScheduled = useRef(false);
  const automaticRefreshScheduledKind = useRef<"notification" | "building" | null>(null);
  const buildingRefreshCycle = useRef<{
    monitoringKey: string;
    extraReadsStarted: number;
  } | null>(null);
  const portfolioObserver = useRef<ReturnType<typeof observePortfolioValuations> | null>(null);
  const portfolioObserverRefresh = useRef<() => void>(() => {});
  const subscribedConditionIds = useRef<string[] | null>(null);
  const [localProfile, setLocalProfile] = useState<UserProfile>(loadProfile);
  const [positionsTab, setPositionsTab] = useState<"active" | "closed">("active");

  // Merge nostr profile into local profile when available
  const nostrProfile = useSettingsStore((s) => s.nostrProfile);
  const profile: UserProfile = useMemo(() => {
    if (!nostrProfile) return localProfile;
    return {
      ...localProfile,
      displayName: nostrProfile.displayName || localProfile.displayName,
      avatarUrl: nostrProfile.avatar || localProfile.avatarUrl,
    };
  }, [localProfile, nostrProfile]);

  const activityItems = useActivityLogStore((s) => s.items);
  const [createdMarkets] = useState<CreatedMarket[]>([]);
  // Positions and funds are both wallet-local. CTF proofs are market
  // positions; base proofs are spendable ecash funds.
  const storeMints = useWalletStore((s) => s.mints);
  const walletMnemonic = useWalletStore((s) => s.mnemonic);
  const walletId = useMemo(() => browserWalletIdFromMnemonic(walletMnemonic), [walletMnemonic]);
  const walletScopeId = useMemo(
    () =>
      walletId === null ? null : deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId }),
    [walletId],
  );
  const displayScopeKey =
    walletState === "ready" && walletId !== null
      ? `${walletId}:${signerRevision}:${nostrProfile?.pubkey ?? ""}`
      : null;
  const activity = useMemo(
    () => activityItems.filter((item) => walletId !== null && item.walletId === walletId),
    [activityItems, walletId],
  );
  const monitoringKey = displayScopeKey !== null ? `${displayScopeKey}:${selectedTimeRange}` : null;
  const monitoringReady = monitoringResponse?.key === monitoringKey;
  useEffect(() => {
    setLastCompleteDisplay(null);
    setMonitoringError(null);
    setMonitoringUnavailable(false);
    setLoadingMoreAssets(false);
  }, [displayScopeKey]);
  const clearAutomaticRefreshTimer = useCallback(() => {
    if (automaticRefreshTimer.current !== null) {
      clearTimeout(automaticRefreshTimer.current);
      automaticRefreshTimer.current = null;
    }
    automaticRefreshTimerKind.current = null;
  }, []);

  const abortActivePortfolioRead = useCallback(() => {
    const read = activePortfolioRead.current;
    if (!read) return;
    activePortfolioRead.current = null;
    setLoadingMonitoringKey(null);
    if (requestedMonitoringKey.current === read.requestKey) {
      requestedMonitoringKey.current = null;
    }
    activeMonitoringRequest.current += 1;
    read.controller.abort();
  }, []);

  const scheduleAutomaticPortfolioRefresh = useCallback(
    (kind: "notification" | "building") => {
      if (monitoringKey === null || walletId === null) return;

      // A timer wake that already became dirty owns the next read. More events
      // can change its reason, but they must not enqueue or defer another read.
      if (automaticRefreshScheduled.current) {
        if (kind === "notification") {
          automaticRefreshScheduledKind.current = "notification";
          buildingRefreshCycle.current = { monitoringKey, extraReadsStarted: 0 };
        }
        return;
      }

      // Later notifications join the first timer. A notification also turns a
      // pending building retry into the new bounded cycle's reconciliation read.
      if (automaticRefreshTimer.current !== null) {
        if (kind === "notification") automaticRefreshTimerKind.current = "notification";
        return;
      }

      automaticRefreshTimerKind.current = kind;
      automaticRefreshTimer.current = setTimeout(() => {
        automaticRefreshTimer.current = null;
        const wakeKind = automaticRefreshTimerKind.current;
        automaticRefreshTimerKind.current = null;
        if (activeMonitoringKey.current !== monitoringKey || wakeKind === null) return;

        if (wakeKind === "notification") {
          buildingRefreshCycle.current = { monitoringKey, extraReadsStarted: 0 };
        } else {
          const cycle = buildingRefreshCycle.current;
          if (
            cycle?.monitoringKey !== monitoringKey ||
            cycle.extraReadsStarted >= maximumBuildingPortfolioExtraReads
          )
            return;
          cycle.extraReadsStarted += 1;
        }

        if (activePortfolioRead.current?.monitoringKey === monitoringKey) {
          automaticRefreshScheduled.current = true;
          automaticRefreshScheduledKind.current = wakeKind;
          return;
        }
        setPortfolioRefreshEpoch((current) => current + 1);
      }, automaticPortfolioRefreshDelayMs);
    },
    [monitoringKey, walletId],
  );

  portfolioObserverRefresh.current = () => scheduleAutomaticPortfolioRefresh("notification");

  useEffect(() => {
    const observer = observePortfolioValuations(() => portfolioObserverRefresh.current());
    portfolioObserver.current = observer;
    subscribedConditionIds.current = null;
    return () => {
      if (portfolioObserver.current === observer) portfolioObserver.current = null;
      subscribedConditionIds.current = null;
      observer.dispose();
    };
  }, []);

  useEffect(() => {
    activeMonitoringKey.current = monitoringKey;
    clearAutomaticRefreshTimer();
    automaticRefreshScheduled.current = false;
    automaticRefreshScheduledKind.current = null;
    buildingRefreshCycle.current =
      monitoringKey === null ? null : { monitoringKey, extraReadsStarted: 0 };
    const activeRead = activePortfolioRead.current;
    if (activeRead && activeRead.monitoringKey !== monitoringKey) abortActivePortfolioRead();
    return () => {
      clearAutomaticRefreshTimer();
      automaticRefreshScheduled.current = false;
      automaticRefreshScheduledKind.current = null;
      if (activePortfolioRead.current?.monitoringKey === monitoringKey) {
        abortActivePortfolioRead();
      }
      if (activeMonitoringKey.current === monitoringKey) activeMonitoringKey.current = null;
    };
  }, [abortActivePortfolioRead, clearAutomaticRefreshTimer, monitoringKey]);

  const invalidatePortfolio = useCallback(
    (invalidation: PortfolioInvalidation) => {
      if (monitoringKey === null || walletId === null) return;
      try {
        if (decodeAssetMonitoringWalletId(invalidation.walletId) !== walletId) return;
      } catch {
        return;
      }
      scheduleAutomaticPortfolioRefresh("notification");
    },
    [monitoringKey, scheduleAutomaticPortfolioRefresh, walletId],
  );

  useEffect(() => {
    return listenForPortfolioInvalidation(invalidatePortfolio);
  }, [invalidatePortfolio]);

  useEffect(() => {
    activeMonitoringKey.current = monitoringKey;
    if (monitoringKey === null || walletId === null) {
      requestedMonitoringKey.current = null;
      return;
    }
    const requestKey = `${monitoringKey}:${portfolioRefreshEpoch}`;
    if (requestedMonitoringKey.current === requestKey) return;
    requestedMonitoringKey.current = requestKey;
    const requestId = ++activeMonitoringRequest.current;
    const controller = new AbortController();
    const read = { monitoringKey, requestKey, requestId, controller };
    activePortfolioRead.current = read;
    setLoadingMonitoringKey(monitoringKey);
    activeAssetPageRequest.current += 1;
    assetPageInFlight.current = false;
    setMonitoringUnavailable(false);
    void createAuthenticatedBrowserEngineClient()
      .getPortfolio({ walletId, timeframe: selectedTimeRange, pageSize: 200 }, controller.signal)
      .then((value) => {
        if (
          activeMonitoringKey.current !== monitoringKey ||
          getNostrSignerRevision() !== signerRevision ||
          activeBrowserWalletScopeId() !== walletScopeId ||
          activeMonitoringRequest.current !== requestId ||
          activePortfolioRead.current !== read ||
          controller.signal.aborted
        )
          return;
        const initialAssets = appendMonitoringAssets([], value.assets.assets);
        if (initialAssets.kind !== "appended") {
          setMonitoringUnavailable(true);
          setMonitoringError("unavailable");
          return;
        }
        setMonitoringResponse({ key: monitoringKey, value });
        if (
          displayScopeKey !== null &&
          !value.summary.building &&
          !value.assets.building &&
          !value.history.building &&
          !value.summary.incomplete &&
          !value.assets.incomplete &&
          !value.history.incomplete &&
          value.summary.estimatedTotalValueMsat !== null &&
          value.summary.unvaluedAssetCount === 0
        ) {
          setLastCompleteDisplay({ scopeKey: displayScopeKey, value });
        }
        setMonitoringAssets({
          key: monitoringKey,
          generation: requestId,
          assets: initialAssets.assets,
          nextCursor: value.assets.nextCursor ?? null,
        });
        setLoadingMoreAssets(false);
        setMonitoringError(null);
        const building = value.summary.building || value.assets.building || value.history.building;
        const cycle = buildingRefreshCycle.current;
        if (
          building &&
          cycle?.monitoringKey === monitoringKey &&
          cycle.extraReadsStarted < maximumBuildingPortfolioExtraReads
        ) {
          scheduleAutomaticPortfolioRefresh("building");
        } else if (!building) {
          const notificationWakePending =
            automaticRefreshTimerKind.current === "notification" ||
            (automaticRefreshScheduled.current &&
              automaticRefreshScheduledKind.current === "notification");
          if (!notificationWakePending) buildingRefreshCycle.current = null;
          if (automaticRefreshTimerKind.current === "building") clearAutomaticRefreshTimer();
        }
      })
      .catch(() => {
        if (
          activeMonitoringKey.current !== monitoringKey ||
          getNostrSignerRevision() !== signerRevision ||
          activeBrowserWalletScopeId() !== walletScopeId ||
          activeMonitoringRequest.current !== requestId ||
          activePortfolioRead.current !== read ||
          controller.signal.aborted
        )
          return;
        const notificationWakePending =
          automaticRefreshTimerKind.current === "notification" ||
          (automaticRefreshScheduled.current &&
            automaticRefreshScheduledKind.current === "notification");
        if (!notificationWakePending) buildingRefreshCycle.current = null;
        if (automaticRefreshTimerKind.current === "building") clearAutomaticRefreshTimer();
        if (automaticRefreshScheduledKind.current === "building") {
          automaticRefreshScheduled.current = false;
          automaticRefreshScheduledKind.current = null;
        }
        setMonitoringUnavailable(true);
        setMonitoringError("unavailable");
      })
      .finally(() => {
        if (activePortfolioRead.current !== read) return;
        activePortfolioRead.current = null;
        setLoadingMonitoringKey(null);
        if (automaticRefreshScheduled.current) {
          automaticRefreshScheduled.current = false;
          automaticRefreshScheduledKind.current = null;
          setPortfolioRefreshEpoch((current) => current + 1);
        }
      });
    return () => {
      if (activePortfolioRead.current !== read) return;
      abortActivePortfolioRead();
    };
  }, [
    abortActivePortfolioRead,
    clearAutomaticRefreshTimer,
    monitoringKey,
    portfolioRefreshEpoch,
    scheduleAutomaticPortfolioRefresh,
    selectedTimeRange,
    walletId,
    displayScopeKey,
    signerRevision,
    walletScopeId,
  ]);

  const firstPageConditionIds = useMemo(() => {
    if (monitoringResponse?.key !== monitoringKey) return null;
    return [
      ...new Set(
        monitoringResponse.value.assets.assets.flatMap((asset) =>
          asset.asset.kind === "conditional" ? [asset.asset.conditionId] : [],
        ),
      ),
    ].sort();
  }, [monitoringKey, monitoringResponse]);
  const firstPageConditionIdSet = useMemo(
    () => new Set(firstPageConditionIds ?? []),
    [firstPageConditionIds],
  );

  useEffect(() => {
    const observer = portfolioObserver.current;
    if (!observer || firstPageConditionIds === null) return;
    const previous = subscribedConditionIds.current;
    if (
      previous !== null &&
      previous.length === firstPageConditionIds.length &&
      previous.every((conditionId, index) => conditionId === firstPageConditionIds[index])
    )
      return;

    const nextConditionIds = firstPageConditionIds;
    subscribedConditionIds.current = nextConditionIds;
    const resetFailedReplacement = () => {
      if (
        portfolioObserver.current === observer &&
        subscribedConditionIds.current === nextConditionIds
      ) {
        subscribedConditionIds.current = null;
      }
    };
    try {
      void observer.replaceConditionIds(nextConditionIds).catch(resetFailedReplacement);
    } catch {
      resetFailedReplacement();
    }
  }, [firstPageConditionIds]);

  const visibleAssets = monitoringAssets?.key === monitoringKey ? monitoringAssets : null;
  const visibleMonitoringConditionIdsKey = useMemo(() => {
    const ids = visibleAssets?.assets.flatMap((asset) =>
      asset.asset.kind === "conditional" ? [asset.asset.conditionId] : [],
    );
    return [...new Set(ids ?? [])].sort().join(",");
  }, [visibleAssets]);
  const visibleAssetPageError =
    assetPageError?.key === monitoringKey &&
    assetPageError.generation === activeMonitoringRequest.current;
  const liveUpdateCoverageLimited =
    visibleAssets !== null &&
    firstPageConditionIds !== null &&
    visibleAssets.assets.some(
      (asset) =>
        asset.asset.kind === "conditional" && !firstPageConditionIdSet.has(asset.asset.conditionId),
    );

  const loadMoreAssets = useCallback(() => {
    if (
      !visibleAssets ||
      visibleAssets.generation !== activeMonitoringRequest.current ||
      walletId === null ||
      loadingMoreAssets ||
      assetPageInFlight.current
    )
      return;
    const cursor = visibleAssets.nextCursor;
    if (cursor === null) return;
    const requestId = ++activeAssetPageRequest.current;
    const { generation, key } = visibleAssets;
    assetPageInFlight.current = true;
    setLoadingMoreAssets(true);
    void createAuthenticatedBrowserEngineClient()
      .getAssetMonitoringAssets({ walletId, cursor, pageSize: 200 })
      .then((page) => {
        if (
          activeMonitoringKey.current !== key ||
          getNostrSignerRevision() !== signerRevision ||
          activeBrowserWalletScopeId() !== walletScopeId ||
          activeMonitoringRequest.current !== generation ||
          activeAssetPageRequest.current !== requestId
        )
          return;
        const appended = appendMonitoringAssets(visibleAssets.assets, page.assets);
        if (appended.kind !== "appended") {
          setAssetPageError({ key, generation });
          return;
        }
        setMonitoringAssets({
          key,
          generation,
          assets: appended.assets,
          nextCursor: page.nextCursor ?? null,
        });
        setAssetPageError(null);
      })
      .catch(() => {
        if (
          activeMonitoringKey.current !== key ||
          getNostrSignerRevision() !== signerRevision ||
          activeBrowserWalletScopeId() !== walletScopeId ||
          activeMonitoringRequest.current !== generation ||
          activeAssetPageRequest.current !== requestId
        )
          return;
        setAssetPageError({ key, generation });
      })
      .finally(() => {
        if (
          activeMonitoringKey.current !== key ||
          getNostrSignerRevision() !== signerRevision ||
          activeBrowserWalletScopeId() !== walletScopeId ||
          activeMonitoringRequest.current !== generation ||
          activeAssetPageRequest.current !== requestId
        )
          return;
        assetPageInFlight.current = false;
        setLoadingMoreAssets(false);
      });
  }, [loadingMoreAssets, visibleAssets, walletId, signerRevision, walletScopeId]);

  const positionsFromDb = useLiveQuery(
    async () => {
      const scopeId = browserWalletScopeIdFromMnemonic(walletMnemonic);
      if (scopeId === null || activeBrowserWalletScopeId() !== scopeId) return undefined;
      const proofs = await readCanonicalPortfolioCustody(scopeId);
      if (activeBrowserWalletScopeId() !== scopeId || proofs === null) return undefined;
      const byOutcome = new Map<
        string,
        {
          conditionId: string;
          outcomeCollection: string;
          baseAsset: MarketBaseAsset;
          unit: string;
          amount: number;
          mintUrl: string;
          firstReceivedAt: number;
          allVerifiedLosing: boolean;
          claimRecoveryPending: boolean;
          removalPending: boolean;
        }
      >();
      for (const proof of proofs) {
        if (proof.assetKind !== "conditional") continue;
        const { conditionId, outcomeCollection } = proof;
        if (!conditionId || !outcomeCollection) continue;
        const baseAsset = normalizeMarketBaseAsset(proof.baseAsset);
        const key = JSON.stringify([
          proof.normalizedMint,
          proof.unit,
          conditionId,
          outcomeCollection,
          baseAsset,
        ]);
        const current = byOutcome.get(key);
        byOutcome.set(key, {
          conditionId,
          outcomeCollection,
          baseAsset,
          amount: (current?.amount ?? 0) + proof.amount,
          unit: proof.unit,
          mintUrl: proof.normalizedMint,
          claimRecoveryPending:
            (current?.claimRecoveryPending ?? false) || proof.claimRecoveryPending,
          removalPending:
            (current?.removalPending ?? false) || proof.selectability === "pending-removal",
          allVerifiedLosing:
            (current?.allVerifiedLosing ?? true) &&
            (proof.selectability === "verified-losing" ||
              proof.selectability === "pending-removal"),
          firstReceivedAt: Math.min(
            current?.firstReceivedAt ?? Number.POSITIVE_INFINITY,
            proof.receivedAtMs,
          ),
        });
      }
      const entries = Array.from(byOutcome.values());
      const visibleMonitoringConditionIds = visibleMonitoringConditionIdsKey
        ? visibleMonitoringConditionIdsKey.split(",")
        : [];
      const catalogue =
        monitoringUnavailable || monitoringReady
          ? await loadMarketCatalogue([
              ...entries.map((entry) => entry.conditionId),
              ...visibleMonitoringConditionIds,
            ])
          : new Map<string, MarketCatalogueEntry>();
      if (activeBrowserWalletScopeId() !== scopeId) return undefined;
      const positions = entries.map((entry): Position => {
        const market = catalogue.get(entry.conditionId);
        const divisibility = parseMarketDivisibility(market?.divisibility);
        const finalOutcome = market?.finalOutcome?.trim();
        const isClosed =
          entry.allVerifiedLosing ||
          entry.claimRecoveryPending ||
          String(market?.state ?? "").toLowerCase() === "closed";
        // Closure alone does not prove a loss. Only mint classification or an
        // attested outcome can classify this display row.
        const { status: winnerStatus, claimableValue } = entry.allVerifiedLosing
          ? { status: "loser" as const, claimableValue: 0 }
          : deriveWinner({
              isClosed,
              finalOutcome,
              legs: [{ outcomeCollection: entry.outcomeCollection, amount: entry.amount }],
            });
        const isWinner = winnerStatus === "winner";
        const isLoser = winnerStatus === "loser";
        const isPending = winnerStatus === "pending";
        const status = isClosed ? "closed" : "active";
        const currentValueSats = isClosed && isWinner ? claimableValue : 0;
        const position: Position = {
          id: JSON.stringify([
            entry.mintUrl,
            entry.conditionId,
            entry.outcomeCollection,
            entry.baseAsset,
          ]),
          marketId: `${entry.conditionId}-${entry.outcomeCollection}`,
          marketTitle: market?.title ?? conditionLabel(entry.conditionId),
          marketImageUrl: market?.thumbnailUrl ?? "",
          side: "Outcome",
          outcomeId: entry.outcomeCollection,
          outcomeLabel: entry.outcomeCollection,
          canClaimPayout: isWinner || entry.claimRecoveryPending,
          claimRecoveryPending: entry.claimRecoveryPending,
          removalPending: entry.removalPending,
          canDiscard: isLoser,
          monitoringAssetIdentity: localMonitoringAssetIdentity(entry, market) ?? undefined,
          baseAsset: entry.baseAsset,
          divisibility: divisibility ?? undefined,
          shares: divisibility === null ? undefined : entry.amount / divisibility,
          currentValueSats,
          // Local proof rows have no current market valuation until an
          // authoritative attestation or the exact display-only asset monitor
          // supplies one. Face amount is not a current value and must not enter
          // portfolio totals.
          valueKnown: divisibility !== null && isClosed && !isPending,
          status,
          isWinner,
          isLoser,
          isPending,
          finalOutcome: market?.finalOutcome ?? null,
          closedDate: isClosed ? (market?.closedAt ?? undefined) : undefined,
          acquiredDate: new Date(entry.firstReceivedAt).toISOString(),
          mintUrl: entry.mintUrl,
        };
        return enrichPositionWithCatalogue(position, market);
      });
      return { scopeId, positions, marketCatalogue: catalogue };
    },
    [monitoringReady, monitoringUnavailable, visibleMonitoringConditionIdsKey, walletMnemonic],
    undefined as PortfolioPositionSnapshot | undefined,
  );
  const currentLocalPositions =
    positionsFromDb?.scopeId === walletScopeId ? positionsFromDb : undefined;
  const positions: Position[] = currentLocalPositions?.positions ?? [];
  const localPositionsUnavailable = currentLocalPositions === undefined;
  const fundsFromDb = useLiveQuery(
    async () => {
      const scopeId = browserWalletScopeIdFromMnemonic(walletMnemonic);
      if (scopeId === null || activeBrowserWalletScopeId() !== scopeId) return undefined;
      const funds = await readCanonicalLocalFunds(scopeId, storeMints);
      return activeBrowserWalletScopeId() === scopeId ? { scopeId, funds } : undefined;
    },
    [storeMints, walletMnemonic],
    undefined as { scopeId: string; funds: (Fund & { mintName: string })[] | null } | undefined,
  );
  const currentLocalFunds = fundsFromDb?.scopeId === walletScopeId ? fundsFromDb.funds : undefined;
  const localFunds: Fund[] = currentLocalFunds ?? [];
  const localFundsUnavailable = currentLocalFunds == null;
  const localStats = useMemo(() => computeStats(positions, localFunds), [positions, localFunds]);
  const visibleMonitoring =
    monitoringResponse?.key === monitoringKey && visibleAssets
      ? mapMonitoringPortfolio({
          ...monitoringResponse.value,
          assets: {
            ...monitoringResponse.value.assets,
            assets: visibleAssets.assets,
            nextCursor: visibleAssets.nextCursor,
          },
        })
      : null;
  const cachedDisplay =
    lastCompleteDisplay?.scopeKey === displayScopeKey ? lastCompleteDisplay : null;
  const claimInProgress = positions.some((position) => position.claimRecoveryPending);
  const valuesLoading = monitoringKey !== null && loadingMonitoringKey === monitoringKey;
  const retainingDisplay =
    cachedDisplay !== null &&
    (valuesLoading ||
      monitoringUnavailable ||
      visibleMonitoring === null ||
      visibleMonitoring.monitoring.building ||
      claimInProgress);
  const displayMonitoring = retainingDisplay
    ? mapMonitoringPortfolio(cachedDisplay.value)
    : visibleMonitoring;
  const funds = displayMonitoring?.funds ?? localFunds;
  const currentStats = displayMonitoring?.stats
    ? displayMonitoring.stats
    : localFundsUnavailable || localPositionsUnavailable
      ? {
          ...localStats,
          totalValueKnown: false,
          totalValueByUnit: undefined,
          positionsValueKnown: !localPositionsUnavailable && localStats.positionsValueKnown,
        }
      : localStats;
  const stats = {
    ...currentStats,
    totalValueLoading: valuesLoading || claimInProgress,
    positionsValueLoading: valuesLoading || claimInProgress,
  };
  const visiblePositions = displayMonitoring
    ? mergeMonitoringPositions(
        displayMonitoring.positions.map((position) =>
          enrichPositionWithCatalogue(
            position,
            (currentLocalPositions?.marketCatalogue ?? EMPTY_MARKET_CATALOGUE).get(
              position.marketId,
            ),
          ),
        ),
        positions,
      )
    : positions;
  const plChartData = useMemo(() => {
    if (
      !displayMonitoring ||
      stats.totalValueKnown === false ||
      (retainingDisplay && cachedDisplay?.value.history.timeframe !== selectedTimeRange)
    )
      return EMPTY_PL_CHART_DATA;
    return { ...EMPTY_PL_CHART_DATA, [selectedTimeRange]: displayMonitoring.chart };
  }, [
    selectedTimeRange,
    stats.totalValueKnown,
    displayMonitoring,
    retainingDisplay,
    cachedDisplay,
  ]);
  const monitoring: PortfolioMonitoringState = {
    stale: retainingDisplay || (visibleMonitoring?.monitoring.stale ?? false),
    retainingDisplay,
    incomplete: visibleMonitoring?.monitoring.incomplete ?? false,
    building: visibleMonitoring?.monitoring.building ?? false,
    unvaluedAssetCount: visibleMonitoring?.monitoring.unvaluedAssetCount ?? 0,
    hasPendingOutgoing: visibleMonitoring?.monitoring.hasPendingOutgoing ?? false,
    pendingOutgoingValueMsat: visibleMonitoring?.monitoring.pendingOutgoingValueMsat ?? null,
    liveUpdateCoverageLimited,
    error:
      monitoringError ??
      (!visibleMonitoring && (localFundsUnavailable || localPositionsUnavailable)
        ? "unavailable"
        : null),
    assetPageError: visibleAssetPageError ? "unavailable" : null,
    hasMoreAssets:
      visibleAssets?.nextCursor != null &&
      visibleAssets.generation === activeMonitoringRequest.current,
    loadingMoreAssets: visibleAssets !== null && loadingMoreAssets,
  };
  const selectTimeRange = useCallback((range: PLTimeSelector) => {
    setSelectedTimeRange(range);
  }, []);

  const saveProfile = useCallback((updated: UserProfile) => {
    setLocalProfile(updated);
    localStorage.setItem("bitcaster-profile", JSON.stringify(updated));
  }, []);

  return {
    walletState,
    baseCurrency,
    selectedTimeRange,
    profile,
    plChartData,
    stats,
    positions: visiblePositions,
    funds,
    activity,
    createdMarkets,
    positionsTab,
    monitoring,
    setSelectedTimeRange: selectTimeRange,
    setPositionsTab,
    saveProfile,
    dismissMonitoringError: () => setMonitoringError(null),
    loadMoreAssets,
    dismissAssetPageError: () => setAssetPageError(null),
  };
}
