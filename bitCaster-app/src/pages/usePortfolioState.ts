import { createDisplayResyncRepair } from "@bitcaster/client-sdk/displayResync";
import { EngineClientError } from "@bitcaster/client-sdk/engineClient";
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
import { createAuthenticatedBrowserEngineClient, type MarketCatalogueEntry } from "@/lib/markets";
import {
  activeBrowserWalletScopeId,
  browserWalletIdFromMnemonic,
  browserWalletScopeIdFromMnemonic,
} from "@/lib/browserWalletProfile";
import {
  cashuAmountToMarketSubunits,
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
  ActivityDisplayItem,
  CreatedMarket,
  PortfolioMonitoringState,
} from "@/types/portfolio";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import {
  classifyHeldPosition,
  summarizeHeldPositions,
} from "@bitcaster/client-sdk/heldPositionStatus";
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
import { useActivityCatalogue } from "@/hooks/useActivityCatalogue";
import { loadMarketCatalogue } from "@/lib/marketCatalogueBatches";

/**
 * A price or closure notice arrives before the engine valuation view applies
 * its event. The view applies events up to 13 s late, so notices for held
 * markets share one read after this delay.
 */
const valuationRefreshDelayMs = 15_000;
/** A projection that is still building is read again after these delays. */
const buildingPortfolioRetryDelaysMs = [1_000, 2_000, 4_000, 8_000] as const;
const maximumBuildingPortfolioExtraReads = buildingPortfolioRetryDelaysMs.length;
/**
 * The engine admits 12 Portfolio reads per caller in each minute. One page
 * holds 2 read permits and gets one more every 15 s. Each read spends a
 * permit. An automatic read waits for a permit, so one page starts at most
 * 2 + 60 / 15 = 6 automatic reads in any minute. The rest of the engine limit
 * covers a reload, a second tab, or a timeframe change, which does not wait.
 */
const portfolioReadBurst = 2;
const portfolioReadIntervalMs = 15_000;
/** A read that the engine refuses with 429 is read again after these delays. */
const rateLimitedPortfolioRetryDelaysMs = [5_000, 10_000, 20_000, 40_000] as const;
const maximumRateLimitedPortfolioRetries = rateLimitedPortfolioRetryDelaysMs.length;
/** Retry-After can extend a retry delay to this bound, and not beyond. */
const maximumRateLimitedPortfolioRetryDelayMs = 60_000;
/** A 429 retry delay varies by this fraction, so refused pages do not retry together. */
const rateLimitedPortfolioRetryJitter = 0.25;

type AutomaticPortfolioReadKind = "notification" | "building";

/**
 * The read permits of one page, as a generic cell rate: a read is in budget
 * when `nextReadAtMs` is at most `portfolioReadBurst - 1` intervals ahead.
 */
interface PortfolioReadBudget {
  nextReadAtMs: number;
  /** After a 429, no automatic read starts before this time. */
  refusedUntilMs: number;
}

function earliestBudgetedPortfolioReadAtMs(budget: PortfolioReadBudget, nowMs: number): number {
  return Math.max(
    nowMs,
    budget.nextReadAtMs - (portfolioReadBurst - 1) * portfolioReadIntervalMs,
    budget.refusedUntilMs,
  );
}

/** A read that reached the engine uses one permit. The budget never goes below empty. */
function spendPortfolioReadPermit(budget: PortfolioReadBudget, nowMs: number): void {
  budget.nextReadAtMs = Math.min(
    Math.max(budget.nextReadAtMs, nowMs) + portfolioReadIntervalMs,
    nowMs + portfolioReadBurst * portfolioReadIntervalMs,
  );
}

/**
 * A backoff delay varies by 25 % either side. A Retry-After delay only grows
 * by up to 25 %, because the engine does not admit the read before it.
 */
function rateLimitedPortfolioRetryDelayMs(
  error: EngineClientError,
  retry: number,
  unitRandom: number,
): number {
  if (error.retryAfterSeconds === undefined) {
    const delayMs =
      rateLimitedPortfolioRetryDelaysMs[retry - 1] ?? maximumRateLimitedPortfolioRetryDelayMs;
    return Math.round(
      delayMs *
        (1 - rateLimitedPortfolioRetryJitter + 2 * rateLimitedPortfolioRetryJitter * unitRandom),
    );
  }
  return Math.min(
    maximumRateLimitedPortfolioRetryDelayMs,
    Math.round(
      error.retryAfterSeconds * 1_000 * (1 + rateLimitedPortfolioRetryJitter * unitRandom),
    ),
  );
}

function mergeAutomaticPortfolioReadKinds(
  pending: AutomaticPortfolioReadKind | null,
  requested: AutomaticPortfolioReadKind,
): AutomaticPortfolioReadKind {
  return pending === null || pending === requested ? requested : "notification";
}

type PortfolioPositionSnapshot = {
  scopeId: string;
  positions: Position[];
  marketCatalogue: Map<string, MarketCatalogueEntry>;
  /** Conditions whose catalogue read completed. A missing market is still read. */
  catalogueConditionIds: ReadonlySet<string>;
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
  activity: ActivityDisplayItem[];
  createdMarkets: CreatedMarket[];
  positionsTab: "active" | "closed";
  monitoring: PortfolioMonitoringState;
}

const EMPTY_PL_CHART_DATA: PLChartData = { "1D": [], "1W": [], "1M": [], ALL: [] };

const DEFAULT_PROFILE: UserProfile = { displayName: "", avatarUrl: null, bio: "" };

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

function buildingRetryDelayMs(buildingExtraReadsStarted: number): number {
  return (
    buildingPortfolioRetryDelaysMs[buildingExtraReadsStarted] ??
    buildingPortfolioRetryDelaysMs[maximumBuildingPortfolioExtraReads - 1]
  );
}

export function usePortfolioState(): PortfolioState & {
  setSelectedTimeRange: (range: PLTimeSelector) => void;
  setPositionsTab: (tab: "active" | "closed") => void;
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
  // A 429 is a wait, not an unavailable monitor: the scope shows loading
  // values and local data until its retry ends.
  const [rateLimitedMonitoringKey, setRateLimitedMonitoringKey] = useState<string | null>(null);
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
  // The read budget clock is performance.now(): a wall clock change must not refill permits.
  const automaticRefreshTimerAtMs = useRef(0);
  const valuationNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const valuationNoticeJoined = useRef(false);
  const automaticRefreshTimerKind = useRef<AutomaticPortfolioReadKind | null>(null);
  const automaticRefreshScheduled = useRef(false);
  const automaticRefreshScheduledKind = useRef<AutomaticPortfolioReadKind | null>(null);
  const buildingRefreshCycle = useRef<{
    monitoringKey: string;
    extraReadsStarted: number;
  } | null>(null);
  // Every timeframe and wallet scope of this page shares one engine caller.
  const portfolioReadBudget = useRef<PortfolioReadBudget>({
    nextReadAtMs: Number.NEGATIVE_INFINITY,
    refusedUntilMs: 0,
  });
  const rateLimitedPortfolioRetries = useRef(0);
  const portfolioObserver = useRef<ReturnType<typeof observePortfolioValuations> | null>(null);
  const portfolioRepair = useRef<ReturnType<typeof createDisplayResyncRepair> | null>(null);
  const portfolioRepairWaiter = useRef<{
    key: string;
    minimumRequest: number;
    signal: AbortSignal;
    controller?: AbortController;
    resolve: () => void;
    reject: (error: Error) => void;
  } | null>(null);
  const portfolioObserverRefresh = useRef<() => void>(() => {});
  const subscribedConditionIds = useRef<string[] | null>(null);
  const [positionsTab, setPositionsTab] = useState<"active" | "closed">("active");

  const nostrProfile = useSettingsStore((s) => s.nostrProfile);
  const connectionStatus = useSettingsStore((s) => s.signerConnectionStatus);
  const profile: UserProfile = useMemo(() => {
    if (connectionStatus !== "connected" || !nostrProfile) return DEFAULT_PROFILE;
    return {
      displayName: nostrProfile.displayName,
      avatarUrl: nostrProfile.avatar || null,
      bio: nostrProfile.bio,
    };
  }, [connectionStatus, nostrProfile]);

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
  const monitoringRateLimited =
    monitoringKey !== null && rateLimitedMonitoringKey === monitoringKey;
  useEffect(() => {
    setLastCompleteDisplay(null);
    setMonitoringError(null);
    setMonitoringUnavailable(false);
    setRateLimitedMonitoringKey(null);
    setLoadingMoreAssets(false);
  }, [displayScopeKey]);
  const clearValuationNoticeTimer = useCallback(() => {
    valuationNoticeJoined.current = false;
    if (valuationNoticeTimer.current === null) return;
    clearTimeout(valuationNoticeTimer.current);
    valuationNoticeTimer.current = null;
  }, []);
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

  // Wallet changes, price notices, building retries, 429 retries and display
  // repairs all request reads here. A read in flight owns the next read: it
  // starts when that read ends, and later requests only change its reason.
  // Otherwise one timer holds the earliest requested read that the read
  // budget permits. A notification read starts a new bounded building cycle.
  const requestAutomaticPortfolioRead = useCallback(
    function request(kind: AutomaticPortfolioReadKind, delayMs: number): void {
      if (monitoringKey === null || walletId === null) return;
      if (automaticRefreshScheduled.current) {
        automaticRefreshScheduledKind.current = mergeAutomaticPortfolioReadKinds(
          automaticRefreshScheduledKind.current,
          kind,
        );
        return;
      }

      const nowMs = performance.now();
      const atMs = Math.max(
        nowMs + delayMs,
        earliestBudgetedPortfolioReadAtMs(portfolioReadBudget.current, nowMs),
      );
      let readKind = kind;
      if (automaticRefreshTimer.current !== null) {
        readKind = mergeAutomaticPortfolioReadKinds(automaticRefreshTimerKind.current, kind);
        automaticRefreshTimerKind.current = readKind;
        if (automaticRefreshTimerAtMs.current <= atMs) return;
        clearTimeout(automaticRefreshTimer.current);
        automaticRefreshTimer.current = null;
      }
      if (atMs > nowMs) {
        automaticRefreshTimerKind.current = readKind;
        automaticRefreshTimerAtMs.current = atMs;
        automaticRefreshTimer.current = setTimeout(() => {
          automaticRefreshTimer.current = null;
          const wakeKind = automaticRefreshTimerKind.current;
          automaticRefreshTimerKind.current = null;
          if (activeMonitoringKey.current !== monitoringKey || wakeKind === null) return;
          request(wakeKind, 0);
        }, atMs - nowMs);
        return;
      }

      automaticRefreshTimerKind.current = null;
      if (activePortfolioRead.current?.monitoringKey === monitoringKey) {
        automaticRefreshScheduled.current = true;
        automaticRefreshScheduledKind.current = readKind;
        return;
      }
      if (readKind === "notification") {
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
      setPortfolioRefreshEpoch((current) => current + 1);
    },
    [monitoringKey, walletId],
  );

  // The notice read keeps its own timer. A wallet change that reads at once
  // comes before the valuation view applies the notice, so it must not take
  // the place of this later read. A notice that joins a pending timer can
  // arrive just before it fires, so its read is too early. One more timer for
  // the full delay then follows that read.
  const startValuationNoticeTimer = () => {
    valuationNoticeTimer.current = setTimeout(() => {
      valuationNoticeTimer.current = null;
      if (activeMonitoringKey.current !== monitoringKey) return;
      const joined = valuationNoticeJoined.current;
      valuationNoticeJoined.current = false;
      requestAutomaticPortfolioRead("notification", 0);
      if (joined) startValuationNoticeTimer();
    }, valuationRefreshDelayMs);
  };
  portfolioObserverRefresh.current = () => {
    if (monitoringKey === null || walletId === null) return;
    if (valuationNoticeTimer.current !== null) {
      valuationNoticeJoined.current = true;
      return;
    }
    startValuationNoticeTimer();
  };

  useEffect(() => {
    const observer = observePortfolioValuations(
      () => portfolioObserverRefresh.current(),
      (token) => portfolioRepair.current?.request(token),
    );
    portfolioObserver.current = observer;
    subscribedConditionIds.current = null;
    return () => {
      if (portfolioObserver.current === observer) portfolioObserver.current = null;
      subscribedConditionIds.current = null;
      observer.dispose();
    };
  }, []);

  const portfolioMembershipScope = useRef(displayScopeKey);
  useEffect(() => {
    if (portfolioMembershipScope.current === displayScopeKey) return;
    portfolioMembershipScope.current = displayScopeKey;
    subscribedConditionIds.current = null;
    void portfolioObserver.current?.replaceConditionIds([]).catch(() => {});
  }, [displayScopeKey]);

  useEffect(() => {
    activeMonitoringKey.current = monitoringKey;
    clearAutomaticRefreshTimer();
    automaticRefreshScheduled.current = false;
    automaticRefreshScheduledKind.current = null;
    buildingRefreshCycle.current =
      monitoringKey === null ? null : { monitoringKey, extraReadsStarted: 0 };
    rateLimitedPortfolioRetries.current = 0;
    const activeRead = activePortfolioRead.current;
    if (activeRead && activeRead.monitoringKey !== monitoringKey) abortActivePortfolioRead();
    return () => {
      clearAutomaticRefreshTimer();
      clearValuationNoticeTimer();
      automaticRefreshScheduled.current = false;
      automaticRefreshScheduledKind.current = null;
      if (activePortfolioRead.current?.monitoringKey === monitoringKey) {
        abortActivePortfolioRead();
      }
      if (activeMonitoringKey.current === monitoringKey) activeMonitoringKey.current = null;
    };
  }, [
    abortActivePortfolioRead,
    clearAutomaticRefreshTimer,
    clearValuationNoticeTimer,
    monitoringKey,
  ]);

  useEffect(() => {
    if (monitoringKey === null || walletId === null) return;
    const repair = createDisplayResyncRepair({
      initialJitterMs: 250,
      repair: async (signal) => {
        signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const waiter: NonNullable<typeof portfolioRepairWaiter.current> = {
            key: monitoringKey,
            signal,
            minimumRequest: activeMonitoringRequest.current + 1,
            resolve: () => finish(),
            reject: (error: Error) => finish(error),
          };
          const abort = () => {
            if (waiter.controller) waiter.controller.abort();
            else finish(new Error("Portfolio repair scope changed."));
          };
          const finish = (error?: Error) => {
            signal.removeEventListener("abort", abort);
            if (portfolioRepairWaiter.current === waiter) portfolioRepairWaiter.current = null;
            if (error) reject(error);
            else resolve();
          };
          portfolioRepairWaiter.current = waiter;
          signal.addEventListener("abort", abort, { once: true });
          requestAutomaticPortfolioRead("notification", 0);
        });
        signal.throwIfAborted();
      },
    });
    portfolioRepair.current = repair;
    return () => {
      if (portfolioRepair.current === repair) portfolioRepair.current = null;
      void repair.dispose();
    };
  }, [monitoringKey, walletId, requestAutomaticPortfolioRead]);

  const invalidatePortfolio = useCallback(
    (invalidation: PortfolioInvalidation) => {
      if (monitoringKey === null || walletId === null) return;
      try {
        if (decodeAssetMonitoringWalletId(invalidation.walletId) !== walletId) return;
      } catch {
        return;
      }
      // A change of this wallet's holdings is read as soon as the budget permits.
      requestAutomaticPortfolioRead("notification", 0);
    },
    [monitoringKey, requestAutomaticPortfolioRead, walletId],
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
    const pendingRepair = portfolioRepairWaiter.current;
    const repairForRead =
      pendingRepair?.key === monitoringKey && requestId >= pendingRepair.minimumRequest
        ? pendingRepair
        : null;
    if (repairForRead) repairForRead.controller = controller;
    activePortfolioRead.current = read;
    setLoadingMonitoringKey(monitoringKey);
    activeAssetPageRequest.current += 1;
    assetPageInFlight.current = false;
    setMonitoringUnavailable(false);
    // An aborted read can end before its request leaves the browser, for
    // example in a Strict Mode replay. Only a read that ends spends a permit.
    let permitSpent = false;
    const spendPermit = () => {
      if (permitSpent || controller.signal.aborted) return;
      permitSpent = true;
      spendPortfolioReadPermit(portfolioReadBudget.current, performance.now());
    };
    void createAuthenticatedBrowserEngineClient()
      .getPortfolio({ walletId, timeframe: selectedTimeRange, pageSize: 200 }, controller.signal)
      .then((value) => {
        spendPermit();
        if (
          activeMonitoringKey.current !== monitoringKey ||
          getNostrSignerRevision() !== signerRevision ||
          activeBrowserWalletScopeId() !== walletScopeId ||
          activeMonitoringRequest.current !== requestId ||
          activePortfolioRead.current !== read ||
          controller.signal.aborted
        )
          return;
        // Any 200 ends a 429 wait, also a 200 whose assets are unusable.
        rateLimitedPortfolioRetries.current = 0;
        setRateLimitedMonitoringKey(null);
        const initialAssets = appendMonitoringAssets([], value.assets.assets);
        if (initialAssets.kind !== "appended") {
          setMonitoringUnavailable(true);
          setMonitoringError("unavailable");
          const waiter = portfolioRepairWaiter.current;
          if (waiter?.key === monitoringKey && requestId >= waiter.minimumRequest)
            waiter.reject(new Error("Portfolio assets are unavailable."));
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
        const waiter = portfolioRepairWaiter.current;
        if (waiter?.key === monitoringKey && requestId >= waiter.minimumRequest) {
          if (
            value.summary.building ||
            value.assets.building ||
            value.history.building ||
            value.summary.incomplete ||
            value.assets.incomplete ||
            value.history.incomplete
          )
            waiter.reject(new Error("Portfolio repair is not complete."));
          else waiter.resolve();
        }
        const building = value.summary.building || value.assets.building || value.history.building;
        const cycle = buildingRefreshCycle.current;
        if (
          building &&
          cycle?.monitoringKey === monitoringKey &&
          cycle.extraReadsStarted < maximumBuildingPortfolioExtraReads
        ) {
          requestAutomaticPortfolioRead("building", buildingRetryDelayMs(cycle.extraReadsStarted));
        } else if (!building) {
          const notificationWakePending =
            automaticRefreshTimerKind.current === "notification" ||
            (automaticRefreshScheduled.current &&
              automaticRefreshScheduledKind.current === "notification");
          if (!notificationWakePending) buildingRefreshCycle.current = null;
          if (automaticRefreshTimerKind.current === "building") clearAutomaticRefreshTimer();
        }
      })
      .catch((error: unknown) => {
        spendPermit();
        if (
          activeMonitoringKey.current !== monitoringKey ||
          getNostrSignerRevision() !== signerRevision ||
          activeBrowserWalletScopeId() !== walletScopeId ||
          activeMonitoringRequest.current !== requestId ||
          activePortfolioRead.current !== read ||
          controller.signal.aborted
        )
          return;
        if (
          error instanceof EngineClientError &&
          error.status === 429 &&
          rateLimitedPortfolioRetries.current < maximumRateLimitedPortfolioRetries
        ) {
          // The engine read limit refused this read. Hold every automatic
          // read, then read again. A pending display repair waits for that read.
          rateLimitedPortfolioRetries.current += 1;
          const delayMs = rateLimitedPortfolioRetryDelayMs(
            error,
            rateLimitedPortfolioRetries.current,
            Math.random(),
          );
          const budget = portfolioReadBudget.current;
          budget.refusedUntilMs = Math.max(budget.refusedUntilMs, performance.now() + delayMs);
          setRateLimitedMonitoringKey(monitoringKey);
          requestAutomaticPortfolioRead("notification", delayMs);
          return;
        }
        rateLimitedPortfolioRetries.current = 0;
        setRateLimitedMonitoringKey(null);
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
        const waiter = portfolioRepairWaiter.current;
        if (waiter?.key === monitoringKey && requestId >= waiter.minimumRequest)
          waiter.reject(new Error("Portfolio repair is unavailable."));
      })
      .finally(() => {
        if (repairForRead?.signal.aborted)
          repairForRead.reject(new Error("Portfolio repair scope changed."));
        if (activePortfolioRead.current !== read) return;
        activePortfolioRead.current = null;
        setLoadingMonitoringKey(null);
        if (automaticRefreshScheduled.current) {
          const kind = automaticRefreshScheduledKind.current ?? "notification";
          automaticRefreshScheduled.current = false;
          automaticRefreshScheduledKind.current = null;
          requestAutomaticPortfolioRead(kind, 0);
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
    requestAutomaticPortfolioRead,
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
  // Monitored conditions that a row can show: the current asset pages and the
  // last complete display, which stays on screen when a later read fails.
  const displayMonitoringConditionIdsKey = useMemo(() => {
    const retainedAssets =
      lastCompleteDisplay?.scopeKey === displayScopeKey
        ? lastCompleteDisplay.value.assets.assets
        : [];
    const ids = [...(visibleAssets?.assets ?? []), ...retainedAssets].flatMap((asset) =>
      asset.asset.kind === "conditional" ? [asset.asset.conditionId] : [],
    );
    return [...new Set(ids)].sort().join(",");
  }, [visibleAssets, lastCompleteDisplay, displayScopeKey]);
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
      const entries = summarizeHeldPositions(proofs);
      const displayMonitoringConditionIds = displayMonitoringConditionIdsKey
        ? displayMonitoringConditionIdsKey.split(",")
        : [];
      // The catalogue read waits for the monitor so that one read covers its rows.
      const catalogueRead = monitoringUnavailable || monitoringReady || monitoringRateLimited;
      const catalogueConditionIds = new Set(
        catalogueRead
          ? [...entries.map((entry) => entry.conditionId), ...displayMonitoringConditionIds]
          : [],
      );
      const catalogue = catalogueRead
        ? await loadMarketCatalogue([...catalogueConditionIds])
        : new Map<string, MarketCatalogueEntry>();
      if (activeBrowserWalletScopeId() !== scopeId) return undefined;
      const positions = entries.map((entry): Position => {
        const market = catalogue.get(entry.conditionId);
        const divisibility = parseMarketDivisibility(market?.divisibility);
        // Closure alone does not prove a loss. Only mint classification or an
        // attested outcome can classify this display row.
        const classification = classifyHeldPosition(entry, market);
        const historyOnly = classification.result === "history";
        const isClosed = classification.closed;
        const isWinner = classification.result === "winner";
        const isLoser = classification.result === "loser";
        const isPending = classification.result === "pending";
        const status = isClosed ? "closed" : "active";
        const currentValueSats = isClosed && isWinner ? classification.claimableAmount : 0;
        const position: Position = {
          id: JSON.stringify([
            entry.mintUrl,
            entry.conditionId,
            entry.outcomeCollection,
            entry.baseAsset,
          ]),
          marketId: `${entry.conditionId}-${entry.outcomeCollection}`,
          marketTitle: market?.title ?? conditionLabel(entry.conditionId),
          marketLoading: !catalogueRead,
          marketImageUrl: market?.thumbnailUrl ?? "",
          side: "Outcome",
          outcomeId: entry.outcomeCollection,
          outcomeLabel: entry.outcomeCollection,
          canClaimPayout: !historyOnly && (isWinner || entry.claimRecoveryPending),
          canSell: !historyOnly,
          retainedUnverifiedAmountSubunits: entry.retainedUnverifiedAmount,
          claimRecoveryPending: entry.claimRecoveryPending,
          removalPending: entry.removalPending,
          canDiscard: !historyOnly && isLoser,
          monitoringAssetIdentity: localMonitoringAssetIdentity(entry, market) ?? undefined,
          baseAsset: entry.baseAsset,
          divisibility: divisibility ?? undefined,
          shares: divisibility === null ? undefined : entry.amount / divisibility,
          currentValueSats,
          // Local proof rows have no current market valuation until an
          // authoritative attestation or the exact display-only asset monitor
          // supplies one. Face amount is not a current value and must not enter
          // portfolio totals.
          valueKnown: !historyOnly && divisibility !== null && isClosed && !isPending,
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
      return { scopeId, positions, marketCatalogue: catalogue, catalogueConditionIds };
    },
    [
      monitoringReady,
      monitoringUnavailable,
      monitoringRateLimited,
      displayMonitoringConditionIdsKey,
      walletMnemonic,
    ],
    undefined as PortfolioPositionSnapshot | undefined,
  );
  const currentLocalPositions =
    positionsFromDb?.scopeId === walletScopeId ? positionsFromDb : undefined;
  const displayedActivity = useActivityCatalogue(
    activity,
    walletId,
    currentLocalPositions?.marketCatalogue ?? EMPTY_MARKET_CATALOGUE,
  );
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
  const valuesLoading =
    (monitoringKey !== null && loadingMonitoringKey === monitoringKey) || monitoringRateLimited;
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
  // Funds are wallet-local custody. The projection is a fallback only while
  // the local custody read is loading or unavailable.
  const funds = currentLocalFunds ?? displayMonitoring?.funds ?? [];
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
        displayMonitoring.positions.map((position) => ({
          ...enrichPositionWithCatalogue(
            position,
            (currentLocalPositions?.marketCatalogue ?? EMPTY_MARKET_CATALOGUE).get(
              position.marketId,
            ),
          ),
          marketLoading: !currentLocalPositions?.catalogueConditionIds.has(position.marketId),
        })),
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

  return {
    walletState,
    baseCurrency,
    selectedTimeRange,
    profile,
    plChartData,
    stats,
    positions: visiblePositions,
    funds,
    activity: displayedActivity,
    createdMarkets,
    positionsTab,
    monitoring,
    setSelectedTimeRange: selectTimeRange,
    setPositionsTab,
    dismissMonitoringError: () => setMonitoringError(null),
    loadMoreAssets,
    dismissAssetPageError: () => setAssetPageError(null),
  };
}
