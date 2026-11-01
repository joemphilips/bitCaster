import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  classifyHeldPosition,
  summarizeHeldPositions,
  type HeldPosition,
} from "@bitcaster/client-sdk/heldPositionStatus";
import { assertNever } from "@/lib/enumDiscipline";
import { loadMarketCatalogue } from "@/lib/marketCatalogueBatches";
import type { MarketCatalogueEntry } from "@/lib/markets";
import type { MarketStatusChanged } from "@/lib/marketHub";
import { useNotificationsStore, type Notification } from "@/stores/notifications";
import type { PortfolioCustodyProofMetadata } from "@/stores/portfolio-custody";

/**
 * In-app close notifications for held positions.
 *
 * When a market in which a wallet holds outcome tokens closes with a verified
 * outcome, the bell gets one won or lost entry for that wallet and condition.
 * A held winning collection makes the entry a win. A closed market without a
 * verified outcome adds nothing: closure alone does not prove a loss.
 *
 * A persisted marker for each wallet and condition, not the bell list,
 * prevents a second entry. The bell is capped and the user can clear it.
 */

/**
 * One run adds at most this many entries, winners first. The bell keeps 100
 * entries, so a larger batch would hide most results and push out the order
 * entries. The remaining results come on later runs.
 */
const MAX_ENTRIES_PER_RUN = 20;

/**
 * A safety bound for corrupted or abandoned storage only. After each
 * successful custody read, a wallet keeps the markers of the conditions that
 * it holds and forgets the others, so normal use stays far below this bound.
 * Above it, the markers of the other wallets are dropped. The marker of a
 * condition that the current wallet holds is never dropped.
 */
const MAX_CLOSE_MARKERS = 5_000;

/** Wallet scope ID -> condition ID -> Unix ms when its entry was added. */
type CloseMarkers = Record<string, Record<string, number>>;

interface HeldPositionCloseMarkerState {
  markers: CloseMarkers;
  /**
   * Store the result of one reconcile after a successful custody read: keep
   * the markers of the held conditions, add the notified conditions, and
   * forget the conditions that the wallet no longer holds.
   */
  record: (
    scopeId: string,
    heldConditionIds: ReadonlySet<string>,
    notifiedConditionIds: readonly string[],
    now: number,
  ) => void;
}

function countMarkers(markers: CloseMarkers): number {
  let count = 0;
  for (const conditions of Object.values(markers)) count += Object.keys(conditions).length;
  return count;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keep only well-formed persisted markers. Browser storage can hold any value. */
function readPersistedMarkers(persisted: unknown): CloseMarkers {
  const stored = isRecord(persisted) ? persisted.markers : undefined;
  if (!isRecord(stored)) return {};
  const markers: CloseMarkers = {};
  for (const [scopeId, conditions] of Object.entries(stored)) {
    if (!isRecord(conditions)) continue;
    const kept: Record<string, number> = {};
    for (const [conditionId, notifiedAt] of Object.entries(conditions)) {
      if (typeof notifiedAt === "number" && Number.isFinite(notifiedAt)) {
        kept[conditionId] = notifiedAt;
      }
    }
    if (Object.keys(kept).length > 0) markers[scopeId] = kept;
  }
  return markers;
}

export const useHeldPositionCloseMarkerStore = create<HeldPositionCloseMarkerState>()(
  persist(
    (set) => ({
      markers: {},
      record: (scopeId, heldConditionIds, notifiedConditionIds, now) => {
        set((state) => {
          const previous = state.markers[scopeId] ?? {};
          const scopeMarkers: Record<string, number> = {};
          for (const [conditionId, notifiedAt] of Object.entries(previous)) {
            if (heldConditionIds.has(conditionId)) scopeMarkers[conditionId] = notifiedAt;
          }
          for (const conditionId of notifiedConditionIds) scopeMarkers[conditionId] = now;
          const previousCount = Object.keys(previous).length;
          const scopeCount = Object.keys(scopeMarkers).length;
          const overBound =
            countMarkers(state.markers) - previousCount + scopeCount > MAX_CLOSE_MARKERS;
          if (!overBound && notifiedConditionIds.length === 0 && scopeCount === previousCount) {
            return state;
          }
          const markers: CloseMarkers = overBound ? {} : { ...state.markers };
          delete markers[scopeId];
          if (scopeCount > 0) markers[scopeId] = scopeMarkers;
          return { markers };
        });
      },
    }),
    {
      name: "bitcaster-held-position-close-markers",
      merge: (persisted, current) =>
        persisted === undefined
          ? current
          : { ...current, markers: readPersistedMarkers(persisted) },
    },
  ),
);

interface HeldMarketFacts {
  title: string | null | undefined;
  state: string | null | undefined;
  finalOutcome: string | null | undefined;
}

/** Live lifecycle facts. A newer push can precede the catalogue projection. */
type LiveMarketStatus = Pick<MarketStatusChanged, "conditionId" | "state" | "finalOutcome">;

function resultNotificationKind(
  position: HeldPosition,
  market: HeldMarketFacts,
): "position_won" | "position_lost" | null {
  const { result } = classifyHeldPosition(position, market);
  switch (result) {
    case "winner":
      return "position_won";
    case "loser":
      return "position_lost";
    case "active":
    case "pending":
    case "history":
      return null;
    default:
      return assertNever(result);
  }
}

/**
 * Build at most one entry for each unmarked condition whose verified outcome
 * decides a held position. Winners come first. The result has at most
 * `MAX_ENTRIES_PER_RUN` entries.
 */
function reconcileHeldPositionCloses(
  scopeId: string,
  positions: readonly HeldPosition[],
  markets: ReadonlyMap<string, HeldMarketFacts>,
  markers: Readonly<Record<string, number>>,
  now: number,
): Notification[] {
  const byCondition = new Map<string, Notification>();
  for (const position of positions) {
    const { conditionId } = position;
    if (markers[conditionId] !== undefined) continue;
    const market = markets.get(conditionId);
    // Only a verified outcome decides won or lost.
    if (!market?.finalOutcome?.trim()) continue;
    const kind = resultNotificationKind(position, market);
    if (kind === null) continue;
    // One entry for each condition. A held winning collection makes it a win.
    // Otherwise the first lost collection names the entry.
    const current = byCondition.get(conditionId);
    if (current && (current.kind === "position_won" || kind === "position_lost")) continue;
    const marketId = `${conditionId}-${position.outcomeCollection}`;
    byCondition.set(conditionId, {
      // The wallet is part of the ID, so a second wallet that holds the same
      // condition gets its own entry.
      id: `${conditionId}-position_result-${scopeId}`,
      kind,
      orderId: "",
      marketId,
      filledAmountSubunits: 0,
      remainingAmountSubunits: 0,
      unit: position.baseAsset,
      occurredAt: now,
      read: false,
      conditionId,
      ...(market.title?.trim() ? { marketTitle: market.title.trim() } : {}),
    });
  }
  // The sort is stable, so the custody order decides the order of equal kinds.
  return [...byCondition.values()]
    .sort(
      (left, right) => Number(right.kind === "position_won") - Number(left.kind === "position_won"),
    )
    .slice(0, MAX_ENTRIES_PER_RUN);
}

export interface HeldPositionCloseReconcilerOptions {
  /** Custody scope of the wallet. Markers and entry IDs are kept for each scope. */
  scopeId: string;
  /** False after the active wallet changes. A stale run adds nothing. */
  isCurrent: () => boolean;
  /** Canonical custody metadata, or null when custody is unavailable. */
  readCustody: () => Promise<readonly PortfolioCustodyProofMetadata[] | null>;
  loadCatalogue?: (conditionIds: readonly string[]) => Promise<Map<string, MarketCatalogueEntry>>;
  now?: () => number;
}

export interface HeldPositionCloseReconciler {
  /**
   * Run one reconcile. Without a live status, the run reads the catalogue for
   * every unmarked held condition. With a live close, it reads the catalogue
   * only for that condition, and only when the wallet holds it. A request
   * during a run asks for one more run and gets the promise that settles
   * after it.
   */
  request: (live?: LiveMarketStatus) => Promise<void>;
  dispose: () => void;
}

export function createHeldPositionCloseReconciler({
  scopeId,
  isCurrent,
  readCustody,
  loadCatalogue = loadMarketCatalogue,
  now = Date.now,
}: HeldPositionCloseReconcilerOptions): HeldPositionCloseReconciler {
  let disposed = false;
  let running: Promise<void> | null = null;
  let rerunRequested = false;
  let fullRequested = false;
  const liveStatuses = new Map<string, LiveMarketStatus>();

  const active = () => !disposed && isCurrent();
  const scopeMarkers = () => useHeldPositionCloseMarkerStore.getState().markers[scopeId] ?? {};

  const runOnce = async () => {
    // A run serves the requests that are pending when it starts.
    const full = fullRequested;
    fullRequested = false;
    const live = new Map(liveStatuses);
    liveStatuses.clear();
    if (!active()) return;
    const proofs = await readCustody();
    if (proofs === null || !active()) return;
    const positions = summarizeHeldPositions(proofs);
    const heldConditionIds = new Set(positions.map(({ conditionId }) => conditionId));
    const knownMarkers = scopeMarkers();
    const candidates = positions.filter(
      ({ conditionId }) =>
        knownMarkers[conditionId] === undefined && (full || live.has(conditionId)),
    );
    const catalogue =
      candidates.length === 0
        ? new Map<string, MarketCatalogueEntry>()
        : await loadCatalogue(candidates.map(({ conditionId }) => conditionId));
    if (!active()) return;
    const markets = new Map<string, HeldMarketFacts>();
    for (const [conditionId, entry] of catalogue) {
      const status = live.get(conditionId);
      markets.set(conditionId, {
        title: entry.title,
        state: status?.state ?? entry.state,
        finalOutcome: status?.finalOutcome ?? entry.finalOutcome,
      });
    }
    // No await from here: the marker check, the bell write and the marker
    // write happen together, so a concurrent run cannot add the entry twice.
    const timestamp = now();
    const notifications = reconcileHeldPositionCloses(
      scopeId,
      candidates,
      markets,
      scopeMarkers(),
      timestamp,
    );
    const add = useNotificationsStore.getState().add;
    // The bell lists the newest entry first. Adding in reverse puts winners on top.
    for (const notification of [...notifications].reverse()) add(notification);
    useHeldPositionCloseMarkerStore.getState().record(
      scopeId,
      heldConditionIds,
      notifications.map(({ conditionId }) => conditionId!),
      timestamp,
    );
  };

  const request = (live?: LiveMarketStatus): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (live) liveStatuses.set(live.conditionId, live);
    else fullRequested = true;
    if (running) {
      rerunRequested = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          rerunRequested = false;
          try {
            await runOnce();
          } catch {
            // A display notification is best effort. The next start, visible
            // tab, or live close reads the custody and the catalogue again.
          }
        } while (rerunRequested && !disposed);
      } finally {
        running = null;
      }
    })();
    return running;
  };

  return {
    request,
    dispose: () => {
      disposed = true;
      liveStatuses.clear();
    },
  };
}
