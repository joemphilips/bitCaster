import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { getProofs, isCtfProof } from "@/stores/proof-db";
import { useWalletStore } from "@/stores/wallet";
import { useSettingsStore } from "@/stores/settings";
import { useActivityLogStore } from "@/stores/activity-log";
import { safeHostname } from "@/lib/url";
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
  AssetMonitoringAssetResponse,
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

function monitoringPosition(asset: AssetMonitoringAssetResponse): Position | null {
  if (asset.asset.kind !== "conditional") return null;
  const value = monitoringAssetValue(asset);
  const conditionId = asset.asset.conditionId;
  return {
    id: `monitoring:${asset.asset.canonicalMintUrl}:${asset.asset.conditionId}:${asset.asset.internalOutcomeSetId}`,
    marketId: conditionId,
    marketTitle: conditionLabel(conditionId),
    marketImageUrl: "",
    side: "Outcome",
    outcomeId: asset.asset.internalOutcomeSetId,
    outcomeLabel: asset.asset.internalOutcomeSetId,
    canSell: false,
    canClaimPayout: false,
    canDiscard: false,
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

function positionConditionId(position: Position): string {
  const suffix = position.outcomeId ? `-${position.outcomeId}` : "";
  return suffix && position.marketId.endsWith(suffix)
    ? position.marketId.slice(0, -suffix.length)
    : position.marketId;
}

function positionAssetKey(position: Position): string {
  return JSON.stringify([
    position.mintUrl,
    positionConditionId(position),
    position.outcomeId ?? "",
  ]);
}

export function mergeMonitoringPositions(
  monitoringPositions: Position[],
  localPositions: Position[],
): Position[] {
  const localByAsset = new Map(
    localPositions.map((position) => [positionAssetKey(position), position] as const),
  );
  const merged = monitoringPositions.map((monitoringPosition) => {
    const key = positionAssetKey(monitoringPosition);
    const local = localByAsset.get(key);
    if (!local) return monitoringPosition;
    localByAsset.delete(key);
    return {
      ...local,
      currentValueSats: monitoringPosition.currentValueSats,
      valueKnown: monitoringPosition.valueKnown,
    };
  });
  return [...merged, ...localByAsset.values()];
}

export function mapMonitoringPortfolio(response: AssetMonitoringPortfolioResponse): {
  stats: PortfolioStats;
  positions: Position[];
  funds: Fund[];
  chart: PLChartDataPoint[];
  monitoring: Omit<PortfolioMonitoringState, "error">;
} {
  const positions = response.assets.assets
    .map(monitoringPosition)
    .filter((position): position is Position => position !== null);
  const funds = response.assets.assets
    .filter((asset) => asset.asset.kind === "collateral")
    .map(
      (asset): Fund => ({
        id: `monitoring:${asset.asset.canonicalMintUrl}`,
        unit: "sats",
        amount:
          asset.availableValueMsat ??
          cashuAmountToMarketSubunits(asset.availableSubunits, asset.asset.cashuUnit),
        mintUrl: asset.asset.canonicalMintUrl,
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
  const [monitoringUnavailable, setMonitoringUnavailable] = useState(false);
  const requestedMonitoringKey = useRef<string | null>(null);
  const activeMonitoringKey = useRef<string | null>(null);
  const activeMonitoringRequest = useRef(0);
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
    setMonitoringUnavailable(false);
    void createAuthenticatedBrowserEngineClient()
      .getPortfolio({ walletId, timeframe: selectedTimeRange, pageSize: 200 })
      .then((value) => {
        if (
          activeMonitoringKey.current !== monitoringKey ||
          activeMonitoringRequest.current !== requestId
        )
          return;
        setMonitoringResponse({ key: monitoringKey, value });
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
        const key = `${conditionId}:${outcomeCollection}:${baseAsset}`;
        const current = byOutcome.get(key);
        byOutcome.set(key, {
          conditionId,
          outcomeCollection,
          baseAsset,
          amount: (current?.amount ?? 0) + amountToNumber(proof.amount),
          mintUrl: current?.mintUrl ?? proof.mintUrl,
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
    monitoringResponse?.key === monitoringKey
      ? mapMonitoringPortfolio(monitoringResponse.value)
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
  };
}
