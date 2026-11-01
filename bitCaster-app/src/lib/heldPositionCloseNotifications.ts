import { create } from "zustand";
import { persist } from "zustand/middleware";
import { classifyHeldPosition } from "@bitcaster/client-sdk/heldPositionStatus";
import { assertNever } from "@/lib/enumDiscipline";
import {
  summarizePortfolioCustodyPositions,
  type PortfolioCustodyPosition,
} from "@/lib/heldPositions";
import { loadMarketCatalogue } from "@/lib/marketCatalogueBatches";
import type { MarketCatalogueEntry } from "@/lib/markets";
import type { MarketStatusChanged } from "@/lib/marketHub";
import { useNotificationsStore, type Notification } from "@/stores/notifications";
import type { PortfolioCustodyProofMetadata } from "@/stores/portfolio-custody";

/**
 * In-app close notifications for held positions.
 *
 * When a market in which the wallet holds outcome tokens closes with a
 * verified outcome, the bell gets one won or lost entry for each held outcome
 * collection. A closed market without a verified outcome adds nothing: closure
 * alone does not prove a loss.
 *
 * A persisted marker for each condition, not the bell list, prevents a second
 * entry. The bell is capped and the user can clear it.
 */

/**
 * A marker that this bound evicts can notify again only when the wallet still
 * holds that condition after 500 newer conditions were notified.
 */
const MAX_CLOSE_MARKERS = 500;

interface HeldPositionCloseMarkerState {
  /** conditionId -> Unix ms when its entries were added. */
  markers: Record<string, number>;
  mark: (conditionIds: readonly string[], now: number) => void;
}

export const useHeldPositionCloseMarkerStore = create<HeldPositionCloseMarkerState>()(
  persist(
    (set) => ({
      markers: {},
      mark: (conditionIds, now) => {
        if (conditionIds.length === 0) return;
        set((state) => {
          const next = { ...state.markers };
          for (const conditionId of conditionIds) next[conditionId] = now;
          const entries = Object.entries(next);
          if (entries.length <= MAX_CLOSE_MARKERS) return { markers: next };
          entries.sort(([, left], [, right]) => right - left);
          return { markers: Object.fromEntries(entries.slice(0, MAX_CLOSE_MARKERS)) };
        });
      },
    }),
    { name: "bitcaster-held-position-close-markers" },
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
  position: PortfolioCustodyPosition,
  market: HeldMarketFacts,
): "position_won" | "position_lost" | null {
  const { result } = classifyHeldPosition(
    {
      outcomeCollection: position.outcomeCollection,
      amount: position.amount,
      retainedUnverifiedAmount: position.retainedUnverifiedAmountSubunits,
      allVerifiedLosing: position.allVerifiedLosing,
      claimRecoveryPending: position.claimRecoveryPending,
    },
    market,
  );
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

/** Build the entries for unmarked conditions whose verified outcome decides a held position. */
function reconcileHeldPositionCloses(
  positions: readonly PortfolioCustodyPosition[],
  markets: ReadonlyMap<string, HeldMarketFacts>,
  markers: Readonly<Record<string, number>>,
  now: number,
): { notifications: Notification[]; conditionIds: string[] } {
  const byMarketId = new Map<string, Notification>();
  for (const position of positions) {
    if (markers[position.conditionId] !== undefined) continue;
    const market = markets.get(position.conditionId);
    // Only a verified outcome decides won or lost.
    if (!market?.finalOutcome?.trim()) continue;
    const kind = resultNotificationKind(position, market);
    if (kind === null) continue;
    const marketId = `${position.conditionId}-${position.outcomeCollection}`;
    // The same collection at a second mint adds no second entry. A win wins.
    if (byMarketId.get(marketId)?.kind === "position_won") continue;
    byMarketId.set(marketId, {
      id: `${marketId}-${kind}`,
      kind,
      orderId: "",
      marketId,
      filledAmountSubunits: 0,
      remainingAmountSubunits: 0,
      unit: position.baseAsset,
      occurredAt: now,
      read: false,
      conditionId: position.conditionId,
      ...(market.title?.trim() ? { marketTitle: market.title.trim() } : {}),
    });
  }
  const notifications = [...byMarketId.values()];
  const conditionIds = [...new Set(notifications.map(({ conditionId }) => conditionId!))];
  return { notifications, conditionIds };
}

export interface HeldPositionCloseReconcilerOptions {
  /** False after the active wallet changes. A stale run adds nothing. */
  isCurrent: () => boolean;
  /** Canonical custody metadata, or null when custody is unavailable. */
  readCustody: () => Promise<readonly PortfolioCustodyProofMetadata[] | null>;
  loadCatalogue?: (conditionIds: readonly string[]) => Promise<Map<string, MarketCatalogueEntry>>;
  now?: () => number;
}

export interface HeldPositionCloseReconciler {
  /**
   * Run one reconcile. A request during a run asks for one more run and gets
   * the promise that settles after it.
   */
  request: (live?: LiveMarketStatus) => Promise<void>;
  dispose: () => void;
}

export function createHeldPositionCloseReconciler({
  isCurrent,
  readCustody,
  loadCatalogue = loadMarketCatalogue,
  now = Date.now,
}: HeldPositionCloseReconcilerOptions): HeldPositionCloseReconciler {
  let disposed = false;
  let running: Promise<void> | null = null;
  let rerunRequested = false;
  const liveStatuses = new Map<string, LiveMarketStatus>();

  const active = () => !disposed && isCurrent();

  const runOnce = async () => {
    if (!active()) return;
    const proofs = await readCustody();
    if (proofs === null || !active()) return;
    const knownMarkers = useHeldPositionCloseMarkerStore.getState().markers;
    const positions = summarizePortfolioCustodyPositions(proofs).filter(
      ({ conditionId }) => knownMarkers[conditionId] === undefined,
    );
    const live = new Map(liveStatuses);
    liveStatuses.clear();
    if (positions.length === 0) return;
    const catalogue = await loadCatalogue(positions.map(({ conditionId }) => conditionId));
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
    const { notifications, conditionIds } = reconcileHeldPositionCloses(
      positions,
      markets,
      useHeldPositionCloseMarkerStore.getState().markers,
      timestamp,
    );
    const add = useNotificationsStore.getState().add;
    for (const notification of notifications) add(notification);
    useHeldPositionCloseMarkerStore.getState().mark(conditionIds, timestamp);
  };

  const request = (live?: LiveMarketStatus): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (live) liveStatuses.set(live.conditionId, live);
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
