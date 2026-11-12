import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchCreatorMarkets, type CreatorMarketEntry } from "@/lib/markets";
import { loadMarketCatalogue } from "@/lib/marketCatalogueBatches";
import { marketResolutionState } from "@/lib/marketResolution";
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

/** Engine creator facts, with the verified outcome that the catalogue reports for a closed market. */
type CreatorMarketSnapshotEntry = CreatorMarketEntry & { finalOutcome?: string | null };

function isEngineClosed(state: CreatorMarketEntry["state"]): boolean {
  switch (state) {
    case "open":
      return false;
    case "closed":
      return true;
    default:
      return assertNever(state);
  }
}

function toCreatedMarketStatus(
  market: CreatorMarketSnapshotEntry | null | undefined,
): CreatedMarketStatus {
  if (market?.state == null) return "unknown";
  const resolution = marketResolutionState(market.state, market.finalOutcome);
  switch (resolution) {
    case "open":
      return "active";
    case "awaitingResolution":
    case "resolved":
      return resolution;
    default:
      return assertNever(resolution);
  }
}

/**
 * The creator list has no outcome. A closed market reads its verified outcome
 * from the catalogue. A failed read leaves the outcome unknown, so the market
 * awaits resolution and is never shown as resolved.
 */
async function withVerifiedOutcomes(
  markets: CreatorMarketEntry[],
  signal: AbortSignal,
): Promise<CreatorMarketSnapshotEntry[]> {
  const closedIds = markets
    .filter((market) => isEngineClosed(market.state))
    .map((market) => market.conditionId);
  if (closedIds.length === 0) return markets;
  const catalogue = await loadMarketCatalogue(closedIds, { signal });
  return markets.map((market) => {
    const finalOutcome = catalogue.get(market.conditionId)?.finalOutcome;
    return finalOutcome ? { ...market, finalOutcome } : market;
  });
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
  backendByConditionId: Map<string, CreatorMarketSnapshotEntry>,
  currentConditionIds: ReadonlySet<string>,
): CreatedMarket {
  const backend = backendByConditionId.get(stored.conditionId);
  return {
    id: stored.conditionId,
    oracleOwnerKind: "created",
    title: stored.title,
    imageUrl: stored.thumbnailUrl ?? "",
    status: toCreatedMarketStatus(backend),
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
  markets: CreatorMarketSnapshotEntry[];
  currentConditionIds: string[];
  isLoading: boolean;
  error: string | null;
}

function mergeEngineSnapshot(
  previous: CreatorMarketSnapshotEntry[],
  incoming: CreatorMarketSnapshotEntry[],
) {
  const previousClosed = new Map(
    previous
      .filter((market) => isEngineClosed(market.state))
      .map((market) => [market.conditionId, market]),
  );
  const currentConditionIds: string[] = [];
  const markets = incoming.map((market) => {
    const closed = previousClosed.get(market.conditionId);
    previousClosed.delete(market.conditionId);
    // A delayed open snapshot cannot reopen a confirmed closure.
    if (closed && !isEngineClosed(market.state)) return closed;
    currentConditionIds.push(market.conditionId);
    // A missing outcome in this response must not erase a previously known outcome.
    if (closed?.finalOutcome && !market.finalOutcome)
      return { ...market, finalOutcome: closed.finalOutcome };
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
  const importedOracles = useCreatorMarketsStore((s) => s.importedOracles);

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
    const enrichmentController = new AbortController();
    let enrichmentTimeout: ReturnType<typeof setTimeout> | undefined;
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
        // Lifecycle and volume are the first-response facts. Optional outcome
        // enrichment must not hold them behind a catalogue request waterfall.
        setBackend((previous) => ({
          pubkey,
          ...mergeEngineSnapshot(
            previous.pubkey === pubkey ? previous.markets : [],
            response.markets,
          ),
          isLoading: false,
          error: null,
        }));
        if (!response.markets.some((market) => isEngineClosed(market.state))) return;
        // Bound the whole enrichment, not each batch. A slow request cannot
        // keep fetching after navigation, identity change, refresh, or timeout.
        enrichmentTimeout = setTimeout(() => enrichmentController.abort(), 10_000);
        try {
          const enriched = await withVerifiedOutcomes(
            response.markets,
            enrichmentController.signal,
          );
          if (cancelled || enrichmentController.signal.aborted) return;
          setBackend((previous) =>
            previous.pubkey !== pubkey
              ? previous
              : {
                  ...previous,
                  ...mergeEngineSnapshot(previous.markets, enriched),
                },
          );
        } catch {
          // The first response remains valid. Failed enrichment establishes no
          // new resolution; a previously verified outcome remains unchanged.
        } finally {
          clearTimeout(enrichmentTimeout);
        }
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
      enrichmentController.abort();
      clearTimeout(enrichmentTimeout);
    };
  }, [pubkey, refreshTick]);

  const refresh = useCallback(() => {
    setRefreshTick((tick) => tick + 1);
  }, []);

  const markets = useMemo<CreatedMarket[]>(() => {
    const backendByConditionId = new Map<string, CreatorMarketSnapshotEntry>();
    if (backend.pubkey === pubkey) {
      for (const entry of backend.markets) backendByConditionId.set(entry.conditionId, entry);
    }
    const currentConditionIds = new Set(
      backend.pubkey === pubkey ? backend.currentConditionIds : [],
    );
    const created = storedMarkets.map((m) =>
      buildCreatedMarket(m, backendByConditionId, currentConditionIds),
    );
    const createdIds = new Set(created.map((market) => market.id));
    const restored: CreatedMarket[] = importedOracles
      .filter((oracle) => !createdIds.has(oracle.binding.conditionId))
      .map((oracle) => ({
        id: oracle.binding.conditionId,
        oracleOwnerKind: "imported",
        title: oracle.binding.oracleEventId,
        imageUrl: "",
        status: "unknown",
        engineDataStatus: "unavailable",
        createdDate: null,
        baseAsset: "sat",
        divisibility: 1_000,
        volume: null,
        creatorFeesEarned: null,
        creatorFeePercent: null,
      }));
    return [...created, ...restored];
  }, [storedMarkets, importedOracles, backend, pubkey]);

  // Imported authority has no paid creation facts and does not contribute to these statistics.
  const paidMarkets = useMemo(
    () => markets.filter((market) => market.oracleOwnerKind !== "imported"),
    [markets],
  );
  const stats = useMemo<DashboardStats>(() => {
    const base = emptyStats();
    for (const market of paidMarkets) {
      switch (market.status) {
        case "active":
          base.activeMarketsCount += 1;
          break;
        case "awaitingResolution":
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
  }, [paidMarkets]);

  const scopedBackend = backend.pubkey === pubkey ? backend : null;
  const engineDataStatus: CreatorEngineDataStatus =
    !pubkey || paidMarkets.some((market) => market.engineDataStatus === "unavailable")
      ? "unavailable"
      : paidMarkets.some((market) => market.engineDataStatus === "stale")
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
