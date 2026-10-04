import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchCreatorMarkets, type CreatorMarketEntry } from "@/lib/markets";
import {
  normalizeMarketBaseAsset,
  normalizeMarketDivisibility,
} from "@bitcaster/client-sdk/marketUnits";
import { resolveCreatorPubkey } from "@/lib/identityOps";
import { useCreatorMarketsStore, type StoredCreatorMarket } from "@/stores/creatorMarkets";
import { useSettingsStore } from "@/stores/settings";
import { assertNever } from "@/lib/enumDiscipline";
import type {
  CreatedMarket,
  CreatedMarketStatus,
  CreatorEngineDataStatus,
} from "@/types/portfolio";
import type { DashboardStats } from "@/types/market-management";

interface UseCreatorDashboardStateResult {
  /** The creator pubkey the dashboard is scoped to, or `null` if none configured. */
  pubkey: string | null;
  /** Aggregated stats rendered at the top of the dashboard. */
  stats: DashboardStats;
  /** Merged client + backend view used by the `MyMarkets` row list. */
  markets: CreatedMarket[];
  /** True while the selected creator's engine read is in-flight. */
  isLoading: boolean;
  /** Non-null if the engine read failed. Known engine data remains visibly stale. */
  error: string | null;
  engineDataStatus: CreatorEngineDataStatus;
  /** Manually re-fetch engine state and volume. */
  refresh: () => void;
}

function toCreatedMarketStatus(
  state: CreatorMarketEntry["state"] | null | undefined,
): CreatedMarketStatus {
  if (state == null) return "unknown";

  switch (state) {
    case "open":
      return "active";
    case "closed":
      return "resolved";
    default:
      return assertNever(state);
  }
}

/**
 * Derive the CreatedMarket view used by the portfolio `MyMarkets` / `CreatedMarketRow`
 * components. Each market combines:
 *
 *  - Local wizard record (title, thumbnail, createdAt, creator fee %) — always present.
 *  - Engine lifecycle and confirmed volume, with explicit display freshness.
 *
 * Fees are stubbed to `0` for v1 since the matching engine does not accrue
 * them. Local oracle and relay metadata cannot establish trading lifecycle.
 */
function buildCreatedMarket(
  stored: StoredCreatorMarket,
  backendByConditionId: Map<string, CreatorMarketEntry>,
  currentConditionIds: ReadonlySet<string>,
): CreatedMarket {
  const backend = backendByConditionId.get(stored.conditionId);
  return {
    id: stored.conditionId,
    title: stored.title,
    imageUrl: stored.thumbnailUrl ?? "",
    status: toCreatedMarketStatus(backend?.state),
    engineDataStatus: !backend
      ? "unavailable"
      : currentConditionIds.has(stored.conditionId)
        ? "current"
        : "stale",
    createdDate: stored.createdAt,
    baseAsset: normalizeMarketBaseAsset(stored.baseAsset),
    divisibility: normalizeMarketDivisibility(stored.divisibility, stored.baseAsset),
    volume: backend?.totalVolumeSubunits ?? 0,
    creatorFeesEarned: 0,
    creatorFeePercent: stored.creatorFeePercent,
    oracle: stored.oracle,
  };
}

function emptyStats(): DashboardStats {
  return {
    activeMarketsCount: 0,
    resolvedMarketsCount: 0,
    refundedMarketsCount: 0,
    totalVolumeSubunits: 0,
    totalFeesEarnedSats: 0,
    totalFeesClaimedSats: 0,
    totalFeesUnclaimedSats: 0,
  };
}

interface CreatorEngineSnapshot {
  pubkey: string | null;
  markets: CreatorMarketEntry[];
  currentConditionIds: string[];
  isLoading: boolean;
  error: string | null;
}

function mergeEngineSnapshot(previous: CreatorMarketEntry[], incoming: CreatorMarketEntry[]) {
  const previousClosed = new Map(
    previous
      .filter((market) => toCreatedMarketStatus(market.state) === "resolved")
      .map((market) => [market.conditionId, market]),
  );
  const currentConditionIds: string[] = [];
  const markets = incoming.map((market) => {
    const closed = previousClosed.get(market.conditionId);
    previousClosed.delete(market.conditionId);
    // A delayed open snapshot cannot reopen a confirmed closure.
    if (closed && toCreatedMarketStatus(market.state) === "active") return closed;
    currentConditionIds.push(market.conditionId);
    return market;
  });
  return { markets: [...markets, ...previousClosed.values()], currentConditionIds };
}

/**
 * Powers the creator dashboard. Pulls markets from the client-side store
 * (authoritative source of "what I have created") and enriches them with
 * engine state and volume. It does not fetch without a creator identity.
 */
export function useCreatorDashboardState(): UseCreatorDashboardStateResult {
  const nostrSignerMode = useSettingsStore((s) => s.nostrSignerMode);
  const nsecSecret = useSettingsStore((s) => s.nsecSecret);
  const nostrProfilePubkey = useSettingsStore((s) => s.nostrProfile?.pubkey ?? null);
  const storedMarkets = useCreatorMarketsStore((s) => s.markets);

  const pubkey = useMemo(
    () =>
      resolveCreatorPubkey({
        nostrSignerMode,
        nsecSecret,
        nostrProfilePubkey,
      }),
    [nostrSignerMode, nsecSecret, nostrProfilePubkey],
  );

  const [backend, setBackend] = useState<CreatorEngineSnapshot>({
    pubkey: null,
    markets: [],
    currentConditionIds: [],
    isLoading: false,
    error: null,
  });
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!pubkey) {
      setBackend({
        pubkey: null,
        markets: [],
        currentConditionIds: [],
        isLoading: false,
        error: null,
      });
      return;
    }

    let cancelled = false;
    setBackend((previous) => ({
      pubkey,
      markets: previous.pubkey === pubkey ? previous.markets : [],
      currentConditionIds: [],
      isLoading: true,
      error: null,
    }));
    void (async () => {
      try {
        const response = await fetchCreatorMarkets(pubkey);
        if (cancelled) return;
        if (response.pubkey !== pubkey)
          throw new Error("Creator market response did not match the selected creator");
        setBackend((previous) => ({
          pubkey,
          ...mergeEngineSnapshot(
            previous.pubkey === pubkey ? previous.markets : [],
            response.markets,
          ),
          isLoading: false,
          error: null,
        }));
      } catch (err) {
        if (cancelled) return;
        setBackend((previous) => ({
          pubkey,
          markets: previous.pubkey === pubkey ? previous.markets : [],
          currentConditionIds: [],
          isLoading: false,
          error: err instanceof Error ? err.message : "Failed to load creator markets",
        }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pubkey, refreshTick]);

  const refresh = useCallback(() => {
    setRefreshTick((tick) => tick + 1);
  }, []);

  const markets = useMemo<CreatedMarket[]>(() => {
    const backendByConditionId = new Map<string, CreatorMarketEntry>();
    if (backend.pubkey === pubkey) {
      for (const entry of backend.markets) backendByConditionId.set(entry.conditionId, entry);
    }
    const currentConditionIds = new Set(
      backend.pubkey === pubkey ? backend.currentConditionIds : [],
    );
    return storedMarkets.map((m) =>
      buildCreatedMarket(m, backendByConditionId, currentConditionIds),
    );
  }, [storedMarkets, backend, pubkey]);

  const stats = useMemo<DashboardStats>(() => {
    const base = emptyStats();
    for (const market of markets) {
      switch (market.status) {
        case "active":
          base.activeMarketsCount += 1;
          break;
        case "resolved":
          base.resolvedMarketsCount += 1;
          break;
        case "refunded":
          base.refundedMarketsCount += 1;
          break;
        case "unknown":
          break;
        default:
          assertNever(market.status);
      }
      base.totalVolumeSubunits += market.volume;
      base.totalFeesEarnedSats += market.creatorFeesEarned;
    }
    return base;
  }, [markets]);

  const scopedBackend = backend.pubkey === pubkey ? backend : null;
  const engineDataStatus: CreatorEngineDataStatus =
    !pubkey || markets.some((market) => market.engineDataStatus === "unavailable")
      ? "unavailable"
      : markets.some((market) => market.engineDataStatus === "stale")
        ? "stale"
        : !scopedBackend || scopedBackend.isLoading || scopedBackend.error
          ? "unavailable"
          : "current";
  return {
    pubkey,
    stats,
    markets,
    isLoading: pubkey !== null && (scopedBackend?.isLoading ?? true),
    error: scopedBackend?.error ?? null,
    engineDataStatus,
    refresh,
  };
}
