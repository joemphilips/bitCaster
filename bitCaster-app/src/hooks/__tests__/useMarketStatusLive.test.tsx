import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketStatusChanged } from "@/lib/marketHub";
import { useNotificationsStore } from "@/stores/notifications";
import { useLikedMarketStateStore } from "@/lib/likedMarketClose";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be at the top so vi.mock factories can reference them
// ---------------------------------------------------------------------------

const { capturedHandlers, capturedReconciles, mockShowWebNotification } = vi.hoisted(() => ({
  capturedHandlers: [] as Array<(status: MarketStatusChanged) => void>,
  capturedReconciles: [] as Array<unknown[]>,
  mockShowWebNotification: vi.fn(),
}));

vi.mock("@/lib/marketHub", () => ({
  onMarketStatusChanged: (_conditionId: string, handler: (status: MarketStatusChanged) => void) => {
    capturedHandlers.push(handler);
    return () => {};
  },
}));

vi.mock("@/lib/webNotifications", () => ({
  showWebNotification: mockShowWebNotification,
}));

vi.mock("@/lib/likedMarketClose", async () => {
  const actual = await vi.importActual<typeof import("@/lib/likedMarketClose")>(
    "@/lib/likedMarketClose",
  );
  return {
    ...actual,
    reconcileLikedMarketCloses: (...args: Parameters<typeof actual.reconcileLikedMarketCloses>) => {
      capturedReconciles.push(args);
      return actual.reconcileLikedMarketCloses(...args);
    },
  };
});

// ---------------------------------------------------------------------------
// Import under test (after mocks are declared)
// ---------------------------------------------------------------------------

import { useMarketStatusLive } from "../useMarketStatusLive";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONDITION_ID = "a".repeat(64);

function makeStatus(state: "open" | "closed"): MarketStatusChanged {
  return { conditionId: CONDITION_ID, state };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  capturedHandlers.length = 0;
  capturedReconciles.length = 0;
  // Reset shared stores to a clean state
  useNotificationsStore.setState({ items: [] });
  useLikedMarketStateStore.setState({ states: {} });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useMarketStatusLive", () => {
  describe("subscription lifecycle", () => {
    it("registers an onMarketStatusChanged handler when conditionId is provided", () => {
      renderHook(() => useMarketStatusLive(CONDITION_ID, vi.fn()));
      expect(capturedHandlers).toHaveLength(1);
      expect(capturedHandlers[0]).toBeTypeOf("function");
    });

    it("is a no-op when conditionId is null", () => {
      renderHook(() => useMarketStatusLive(null, vi.fn()));
      expect(capturedHandlers).toHaveLength(0);
    });

    it("is a no-op when conditionId is undefined", () => {
      renderHook(() => useMarketStatusLive(undefined, vi.fn()));
      expect(capturedHandlers).toHaveLength(0);
    });
  });

  describe("open->closed transition", () => {
    it("calls onRefresh when a status push arrives", () => {
      const onRefresh = vi.fn();
      renderHook(() => useMarketStatusLive(CONDITION_ID, onRefresh));
      const handler = capturedHandlers[0];

      act(() => {
        handler(makeStatus("closed"));
      });

      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it("adds a market_closed notification when state transitions to closed with a prior open record", () => {
      // Seed last-seen state so the reconcile sees an open→closed transition
      useLikedMarketStateStore.setState({
        states: { [CONDITION_ID]: "open" },
      });

      renderHook(() => useMarketStatusLive(CONDITION_ID, vi.fn()));
      const handler = capturedHandlers[0];

      act(() => {
        handler(makeStatus("closed"));
      });

      const notifications = useNotificationsStore.getState().items;
      expect(notifications).toHaveLength(1);
      expect(notifications[0].kind).toBe("market_closed");
      expect(notifications[0].id).toBe(`${CONDITION_ID}-market_closed`);
      expect(notifications[0].marketId).toBe(CONDITION_ID);
    });

    it("does not invent uniform odds for lifecycle-only close reconciliation", () => {
      useLikedMarketStateStore.setState({
        states: { [CONDITION_ID]: "open" },
      });

      renderHook(() => useMarketStatusLive(CONDITION_ID, vi.fn()));
      act(() => {
        capturedHandlers[0](makeStatus("closed"));
      });

      expect(capturedReconciles[0]?.[0]).toEqual([
        expect.objectContaining({ currentOdds: { yes: null, no: null } }),
      ]);
    });

    it("updates the last-seen state store so the boot reconcile does not re-fire", () => {
      useLikedMarketStateStore.setState({
        states: { [CONDITION_ID]: "open" },
      });

      renderHook(() => useMarketStatusLive(CONDITION_ID, vi.fn()));
      const handler = capturedHandlers[0];

      act(() => {
        handler(makeStatus("closed"));
      });

      expect(useLikedMarketStateStore.getState().states[CONDITION_ID]).toBe("closed");
    });

    it("does not add a notification when there is no prior open record (first-seen-closed)", () => {
      // No prior state → reconcile skips notification (avoid burst on first load)
      renderHook(() => useMarketStatusLive(CONDITION_ID, vi.fn()));
      const handler = capturedHandlers[0];

      act(() => {
        handler(makeStatus("closed"));
      });

      // onRefresh still fires — the page should still refresh
      const notifications = useNotificationsStore.getState().items;
      expect(notifications).toHaveLength(0);
    });
  });

  describe("open status push", () => {
    it("calls onRefresh but does not add a notification for an open push", () => {
      const onRefresh = vi.fn();
      renderHook(() => useMarketStatusLive(CONDITION_ID, onRefresh));
      const handler = capturedHandlers[0];

      act(() => {
        handler(makeStatus("open"));
      });

      expect(onRefresh).toHaveBeenCalledTimes(1);
      expect(useNotificationsStore.getState().items).toHaveLength(0);
    });
  });

  describe("idempotency — no duplicate notification when both paths fire", () => {
    it("does not duplicate the bell entry when the hook fires twice for the same closed market", () => {
      useLikedMarketStateStore.setState({
        states: { [CONDITION_ID]: "open" },
      });

      renderHook(() => useMarketStatusLive(CONDITION_ID, vi.fn()));
      const handler = capturedHandlers[0];

      // First push — hook fires, updates last-seen to 'closed'
      act(() => {
        handler(makeStatus("closed"));
      });

      // Second push — last-seen is now 'closed', reconcile skips
      act(() => {
        handler(makeStatus("closed"));
      });

      // Notification store dedups on id — still exactly one entry
      const notifications = useNotificationsStore.getState().items;
      const closed = notifications.filter((n) => n.id === `${CONDITION_ID}-market_closed`);
      expect(closed).toHaveLength(1);
    });
  });
});
