import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { getProofs, isCtfProof } from "@/stores/proof-db";
import { useWalletStore } from "@/stores/wallet";
import { useSettingsStore } from "@/stores/settings";
import { useActivityLogStore } from "@/stores/activity-log";
import { normalizeUrl, safeHostname } from "@/lib/url";
import {
  createAuthenticatedBrowserEngineClient,
  type MarketCatalogueEntry,
  type MarketCatalogueResponse,
} from "@/lib/markets";
import { browserWalletIdFromMnemonic } from "@/lib/browserWalletProfile";
import {
  cashuAmountToMarketSubunits,
  normalizeMarketBaseAsset,
  normalizeMarketDivisibility,
  parseCashuProofUnit,
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
import { deriveWinner } from "@/lib/positionWinner";
import type {
  AssetMonitoringAssetReference,
  AssetMonitoringAssetResponse,
  AssetMonitoringConditionalAssetReference,
  AssetMonitoringPortfolioResponse,
} from "@bitcaster/client-sdk/assetMonitoring";

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

const TIME_RANGE_MS: Record<PLTimeSelector, number> = {
  "1D": 24 * 60 * 60 * 1000,
  "1W": 7 * 24 * 60 * 60 * 1000,
  "1M": 30 * 24 * 60 * 60 * 1000,
  ALL: Infinity,
};

/** Build P/L chart data from activity history. Sat-market amounts are collateral subunits (msat). */
export function buildPLChartData(items: ActivityItem[]): PLChartData {
  // Sort oldest-first
  const sorted = [...items]
    .filter((a) => a.status === "completed")
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  if (sorted.length === 0) {
    return { "1D": [], "1W": [], "1M": [], ALL: [] };
  }

  // Build cumulative balance points
  const points: PLChartDataPoint[] = [];
  let cumulative = 0;
  for (const item of sorted) {
    const deltaSubunits =
      item.type === "deposit" ||
      item.type === "payout_claimed" ||
      item.type === "creator_fee_claimed"
        ? item.amountSats
        : -item.amountSats;
    cumulative += deltaSubunits;
    points.push({ timestamp: item.date, cumulativePL: cumulative });
  }

  const now = Date.now();
  const result: PLChartData = { "1D": [], "1W": [], "1M": [], ALL: points };
  for (const range of ["1D", "1W", "1M"] as const) {
    const cutoff = now - TIME_RANGE_MS[range];
    result[range] = points.filter((p) => new Date(p.timestamp).getTime() >= cutoff);
  }
  return result;
}

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
  const positionsValueByUnit = groupAmountsByUnit(
    activePositions,
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
  const biggestWinSats = positions.reduce((max, p) => Math.max(max, p.profitLossSats), 0);
  return {
    positionsValueSats,
    totalValueSats,
    positionsValueByUnit,
    totalValueByUnit,
    biggestWinSats,
    predictionsCount: positions.length,
  };
}

function positionSide(outcomeCollection: string): Position["side"] {
  const normalized = outcomeCollection.toUpperCase();
  if (normalized === "YES") return "yes";
  if (normalized === "NO") return "no";
  return "Outcome";
}

function conditionLabel(conditionId: string): string {
  return `Condition ${conditionId.slice(0, 12)}`;
}

async function loadMarketCatalogue(
  conditionIds: string[],
): Promise<Map<string, MarketCatalogueEntry>> {
  if (conditionIds.length === 0) return new Map();
  try {
    const search = new URLSearchParams({
      ids: conditionIds.join(","),
      state: "All",
      page_size: String(Math.min(Math.max(conditionIds.length, 1), 50)),
    });
    const response = await fetch(`/api/v1/markets/query?${search}`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return new Map();
    const body = (await response.json()) as MarketCatalogueResponse;
    return new Map((body.markets ?? []).map((market) => [market.conditionId, market]));
  } catch {
    return new Map();
  }
}

function monitoringAssetValue(asset: AssetMonitoringAssetResponse): number {
  return asset.estimatedValueMsat ?? 0;
}

export function canonicalMonitoringAssetIdentity(asset: AssetMonitoringAssetReference): string {
  return JSON.stringify(asset);
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
  proof: object,
  conditionId: string,
  outcomeCollection: string,
): string | null {
  const metadata = proof as Record<string, unknown>;
  const mintUrl = metadata.canonicalMintUrl ?? metadata.mintUrl;
  if (typeof mintUrl !== "string") return null;
  let canonicalMintUrl: string;
  try {
    canonicalMintUrl = normalizeUrl(mintUrl);
  } catch {
    return null;
  }
  const asset = {
    canonicalMintUrl,
    kind: "conditional" as const,
    cashuUnit: metadata.cashuUnit ?? metadata.unit,
    displayBaseAsset: metadata.displayBaseAsset ?? metadata.baseAsset,
    conditionId,
    parentConditionId: metadata.parentConditionId,
    outcomeUniverseDigest: metadata.outcomeUniverseDigest,
    internalOutcomeSetId: metadata.internalOutcomeSetId ?? outcomeCollection,
  };
  if (
    (asset.cashuUnit !== "sat" && asset.cashuUnit !== "msat") ||
    (asset.displayBaseAsset !== "sat" && asset.displayBaseAsset !== "msat") ||
    typeof asset.parentConditionId !== "string" ||
    typeof asset.outcomeUniverseDigest !== "string" ||
    asset.internalOutcomeSetId !== outcomeCollection
  )
    return null;
  const completeAsset: AssetMonitoringConditionalAssetReference = {
    canonicalMintUrl: asset.canonicalMintUrl,
    kind: "conditional",
    cashuUnit: asset.cashuUnit,
    displayBaseAsset: asset.displayBaseAsset,
    conditionId: asset.conditionId,
    parentConditionId: asset.parentConditionId,
    outcomeUniverseDigest: asset.outcomeUniverseDigest,
    internalOutcomeSetId: asset.internalOutcomeSetId,
  };
  return canonicalMonitoringAssetIdentity(completeAsset);
}

function mergeLocalMonitoringIdentity(
  current: string | null | undefined,
  candidate: string | null,
): string | null {
  if (current === undefined) return candidate;
  return current === candidate ? current : null;
}

function monitoringPosition(asset: AssetMonitoringAssetResponse): Position | null {
  if (asset.asset.kind !== "conditional") return null;
  const value = monitoringAssetValue(asset);
  const conditionId = asset.asset.conditionId;
  const identity = canonicalMonitoringAssetIdentity(asset.asset);
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
    divisibility: 10_000,
    avgBuyPrice: 0,
    currentPrice: 0,
    currentValueSats: value,
    valueKnown: asset.valuationStatus === "valued" && asset.estimatedValueMsat != null,
    profitLossSats: 0,
    profitLossPercent: 0,
    status: "active",
    isWinner: false,
    isLoser: false,
    isPending: false,
    acquiredDate: "",
    mintUrl: asset.asset.canonicalMintUrl,
  };
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
    "error" | "assetPageError" | "hasMoreAssets" | "loadingMoreAssets"
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
    positions.every((position) => position.valueKnown !== false);
  const positionsValueSats = positions.reduce(
    (total, position) => total + position.currentValueSats,
    0,
  );
  const totalValueKnown = response.summary.estimatedTotalValueMsat !== null;
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
      biggestWinSats: 0,
      predictionsCount: positions.length,
    },
    positions,
    funds,
    chart: response.history.points
      .filter((point) => point.estimatedTotalValueMsat !== null)
      .map((point) => ({
        timestamp: point.asOf,
        cumulativePL: point.estimatedTotalValueMsat!,
      })),
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
  const requestedMonitoringKey = useRef<string | null>(null);
  const activeMonitoringKey = useRef<string | null>(null);
  const activeMonitoringRequest = useRef(0);
  const activeAssetPageRequest = useRef(0);
  const assetPageInFlight = useRef(false);
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

  const activity = useActivityLogStore((s) => s.items);
  const [createdMarkets] = useState<CreatedMarket[]>([]);
  // Positions and funds are both wallet-local. CTF proofs are market
  // positions; base proofs are spendable ecash funds.
  const storeMints = useWalletStore((s) => s.mints);
  const walletMnemonic = useWalletStore((s) => s.mnemonic);
  const walletId = useMemo(() => browserWalletIdFromMnemonic(walletMnemonic), [walletMnemonic]);
  const monitoringKey =
    walletState === "ready" && walletId !== null ? `${walletId}:${selectedTimeRange}` : null;
  const monitoringReady = monitoringResponse?.key === monitoringKey;

  useEffect(() => {
    activeMonitoringKey.current = monitoringKey;
    if (monitoringKey === null || walletId === null) {
      requestedMonitoringKey.current = null;
      return;
    }
    if (requestedMonitoringKey.current === monitoringKey) return;
    requestedMonitoringKey.current = monitoringKey;
    const requestId = ++activeMonitoringRequest.current;
    assetPageInFlight.current = false;
    setMonitoringUnavailable(false);
    void createAuthenticatedBrowserEngineClient()
      .getPortfolio({ walletId, timeframe: selectedTimeRange, pageSize: 200 })
      .then((value) => {
        if (
          activeMonitoringKey.current !== monitoringKey ||
          activeMonitoringRequest.current !== requestId
        )
          return;
        const initialAssets = appendMonitoringAssets([], value.assets.assets);
        if (initialAssets.kind !== "appended") {
          setMonitoringUnavailable(true);
          setMonitoringError("unavailable");
          return;
        }
        setMonitoringResponse({ key: monitoringKey, value });
        setMonitoringAssets({
          key: monitoringKey,
          generation: requestId,
          assets: initialAssets.assets,
          nextCursor: value.assets.nextCursor ?? null,
        });
        setLoadingMoreAssets(false);
        setMonitoringError(null);
      })
      .catch(() => {
        if (
          activeMonitoringKey.current !== monitoringKey ||
          activeMonitoringRequest.current !== requestId
        )
          return;
        setMonitoringUnavailable(true);
        setMonitoringError("unavailable");
      });
  }, [monitoringKey, selectedTimeRange, walletId]);

  const visibleAssets =
    monitoringAssets?.key === monitoringKey &&
    monitoringAssets.generation === activeMonitoringRequest.current
      ? monitoringAssets
      : null;
  const visibleAssetPageError =
    assetPageError?.key === monitoringKey &&
    assetPageError.generation === activeMonitoringRequest.current;

  const loadMoreAssets = useCallback(() => {
    if (!visibleAssets || walletId === null || loadingMoreAssets || assetPageInFlight.current)
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
          activeMonitoringRequest.current !== generation ||
          activeAssetPageRequest.current !== requestId
        )
          return;
        setAssetPageError({ key, generation });
      })
      .finally(() => {
        if (
          activeMonitoringKey.current !== key ||
          activeMonitoringRequest.current !== generation ||
          activeAssetPageRequest.current !== requestId
        )
          return;
        assetPageInFlight.current = false;
        setLoadingMoreAssets(false);
      });
  }, [loadingMoreAssets, visibleAssets, walletId]);

  const positionsFromDb = useLiveQuery(
    async () => {
      const proofs = await getProofs();
      const byOutcome = new Map<
        string,
        {
          conditionId: string;
          outcomeCollection: string;
          baseAsset: MarketBaseAsset;
          amount: number;
          mintUrl: string;
          firstReceivedAt: number;
          monitoringAssetIdentity: string | null;
        }
      >();
      for (const proof of proofs.filter(isCtfProof)) {
        const candidate = proof as typeof proof & {
          conditionId?: string;
          condition_id?: string;
          outcomeCollection?: string;
          outcome_collection?: string;
        };
        const conditionId = candidate.conditionId ?? candidate.condition_id;
        const outcomeCollection = candidate.outcomeCollection ?? candidate.outcome_collection;
        if (!conditionId || !outcomeCollection) continue;
        const baseAsset = normalizeMarketBaseAsset(proof.baseAsset);
        const proofMonitoringIdentity = localMonitoringAssetIdentity(
          proof,
          conditionId,
          outcomeCollection,
        );
        const key = `${conditionId}:${outcomeCollection}:${baseAsset}`;
        const current = byOutcome.get(key);
        byOutcome.set(key, {
          conditionId,
          outcomeCollection,
          baseAsset,
          amount: (current?.amount ?? 0) + amountToNumber(proof.amount),
          mintUrl: current?.mintUrl ?? proof.mintUrl,
          monitoringAssetIdentity: mergeLocalMonitoringIdentity(
            current?.monitoringAssetIdentity,
            proofMonitoringIdentity,
          ),
          firstReceivedAt: Math.min(
            current?.firstReceivedAt ?? Number.POSITIVE_INFINITY,
            proof.receivedAt ?? Date.now(),
          ),
        });
      }
      const entries = Array.from(byOutcome.values());
      const catalogue =
        monitoringUnavailable || monitoringReady
          ? await loadMarketCatalogue([...new Set(entries.map((entry) => entry.conditionId))])
          : new Map<string, MarketCatalogueEntry>();
      return entries.map((entry): Position => {
        const market = catalogue.get(entry.conditionId);
        const divisibility = normalizeMarketDivisibility(
          market?.divisibility ?? 10_000,
          entry.baseAsset,
        );
        const finalOutcome = market?.finalOutcome?.trim();
        const isClosed = String(market?.state ?? "").toLowerCase() === "closed";
        // Single source-of-truth winner/value derivation (P22 Link F HIGH).
        // A keyset is a WINNING keyset iff the attested final outcome is a member
        // of that keyset's outcome-collection (the mint redeems a collection's
        // proofs iff the collection contains the attested outcome). A position is
        // a WINNER iff it holds >= 1 proof on a winning keyset — the existence
        // ("some winning leg") rule, NOT "every leg wins". An UNCLAIMED composite
        // "A|B" position (final "A") therefore correctly counts as a winner and
        // stays claimable; the old `.every` rule mis-classified it as a loser and
        // offered only the destructive Remove, destroying the winning A-leg.
        // Claimable value sums WINNING keysets only (losing-keyset proofs = 0).
        // Each position group shares one outcome-collection label by construction
        // (the group key includes it), so it is a single leg here.
        const { status: winnerStatus, claimableValue } = deriveWinner({
          isClosed,
          finalOutcome,
          legs: [{ outcomeCollection: entry.outcomeCollection, amount: entry.amount }],
        });
        const isWinner = winnerStatus === "winner";
        const isLoser = winnerStatus === "loser";
        // Closed but NOT YET ATTESTED (P22 Link F): win/loss undecided. The row
        // must offer NEITHER Claim NOR Remove (destroying not-yet-decided proofs
        // is permanent loss) and show an "awaiting resolution" indicator. It stays
        // visible in the Closed tab (status 'closed'), and its value is the full
        // held amount — an undecided outcome is not a loss, so it is NOT zeroed.
        const isPending = winnerStatus === "pending";
        const status = isClosed ? "closed" : "active";
        const currentValueSats = isClosed
          ? isWinner || isPending
            ? claimableValue
            : 0
          : entry.amount;
        return {
          id: `${entry.conditionId}-${entry.outcomeCollection}`,
          marketId: `${entry.conditionId}-${entry.outcomeCollection}`,
          marketTitle: market?.title ?? conditionLabel(entry.conditionId),
          marketImageUrl: market?.thumbnailUrl ?? "",
          side: positionSide(entry.outcomeCollection),
          outcomeId: entry.outcomeCollection,
          outcomeLabel: entry.outcomeCollection,
          canClaimPayout: isWinner,
          canDiscard: isLoser,
          monitoringAssetIdentity: entry.monitoringAssetIdentity ?? undefined,
          baseAsset: entry.baseAsset,
          divisibility,
          shares: entry.amount / divisibility,
          avgBuyPrice: 0,
          currentPrice: isClosed && isWinner ? divisibility : 0,
          currentValueSats,
          // Pending (undecided) shows no realised P&L; only attested winners/losers do.
          profitLossSats: isClosed && !isPending ? currentValueSats : 0,
          profitLossPercent: isClosed ? (isWinner ? 100 : isPending ? 0 : -100) : 0,
          status,
          isWinner,
          isLoser,
          isPending,
          finalOutcome: market?.finalOutcome ?? null,
          closedDate: isClosed ? (market?.closedAt ?? undefined) : undefined,
          acquiredDate: new Date(entry.firstReceivedAt).toISOString(),
          mintUrl: entry.mintUrl,
        };
      });
    },
    [monitoringReady, monitoringUnavailable, walletMnemonic],
    [] as Position[],
  );
  const positions: Position[] = positionsFromDb ?? [];
  const fundsFromDb = useLiveQuery(
    async () => {
      const proofs = await getProofs();
      const balanceByMintAndUnit: Record<
        string,
        { mintUrl: string; baseAsset: MarketBaseAsset; amount: number }
      > = {};
      for (const p of proofs.filter((proof) => !isCtfProof(proof))) {
        const baseAsset = normalizeMarketBaseAsset(p.baseAsset);
        const unit = parseCashuProofUnit(p.unit);
        if (!unit) throw new Error(`Stored proof has unsupported unit '${String(p.unit)}'`);
        const key = `${p.mintUrl}:${baseAsset}`;
        const current = balanceByMintAndUnit[key];
        balanceByMintAndUnit[key] = {
          mintUrl: p.mintUrl,
          baseAsset,
          amount:
            (current?.amount ?? 0) + cashuAmountToMarketSubunits(amountToNumber(p.amount), unit),
        };
      }
      return Object.values(balanceByMintAndUnit).map(({ mintUrl, baseAsset, amount }) => {
        const mintInfo = storeMints.find((m) => m.url === mintUrl);
        const name = (mintInfo?.info as Record<string, unknown>)?.name as string | undefined;
        return {
          id: `${mintUrl}:${baseAsset}`,
          unit: "sats" as const,
          amount,
          mintUrl,
          mintName: name ?? safeHostname(mintUrl),
        };
      });
    },
    [storeMints, walletMnemonic],
    [] as (Fund & { mintName: string })[],
  );
  const localFunds: Fund[] = fundsFromDb;
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
  const funds = visibleMonitoring?.funds ?? localFunds;
  const stats = visibleMonitoring?.stats ?? localStats;
  const visiblePositions = visibleMonitoring
    ? mergeMonitoringPositions(visibleMonitoring.positions, positions)
    : positions;
  const plChartData = useMemo(() => {
    if (!visibleMonitoring) return buildPLChartData(activity);
    return { ...buildPLChartData(activity), [selectedTimeRange]: visibleMonitoring.chart };
  }, [activity, selectedTimeRange, visibleMonitoring]);
  const monitoring: PortfolioMonitoringState = {
    stale: visibleMonitoring?.monitoring.stale ?? false,
    incomplete: visibleMonitoring?.monitoring.incomplete ?? false,
    building: visibleMonitoring?.monitoring.building ?? false,
    unvaluedAssetCount: visibleMonitoring?.monitoring.unvaluedAssetCount ?? 0,
    hasPendingOutgoing: visibleMonitoring?.monitoring.hasPendingOutgoing ?? false,
    pendingOutgoingValueMsat: visibleMonitoring?.monitoring.pendingOutgoingValueMsat ?? null,
    error: monitoringError,
    assetPageError: visibleAssetPageError ? "unavailable" : null,
    hasMoreAssets: visibleAssets?.nextCursor != null,
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
