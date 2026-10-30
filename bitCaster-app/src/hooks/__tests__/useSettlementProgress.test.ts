import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettlementGroupStatus } from "@bitcaster/client-sdk/engineClient";
import { SETTLEMENT_COMPLETION_NOTICE_MS, useSettlementProgress } from "../useSettlementProgress";
import { publishSettlementProgressHint } from "@/lib/settlementProgressHints";
import {
  useOrderSettlementObservations,
  type OrderSettlementObservation,
} from "@/stores/orderSettlementObservations";

const mocks = vi.hoisted(() => ({ read: vi.fn(), readJournal: vi.fn() }));
vi.mock("@/lib/settlementProgressReader", () => ({ readSettlementProgress: mocks.read }));
vi.mock("@/stores/ctf-range-order-db", () => ({ readCtfRangePreparation: mocks.readJournal }));
const scope = { scopeId: "scope-1", walletId: "a".repeat(64), signerRevision: 1 };
const entries = [
  {
    operationId: "operation-1",
    orderId: "order-1",
    lifecycleState: "order-submitted" as const,
    marketId: "condition-Alpha",
  },
];
const group = {
  groupId: "group-1",
  status: "Reconciling",
  revision: 3,
  coalescingDeadline: "2026-09-07T00:00:00Z",
  frozenAt: null,
};

describe("read-only settlement progress", () => {
  beforeEach(() => {
    mocks.read.mockReset().mockResolvedValue(group);
    mocks.readJournal.mockReset().mockResolvedValue({ lifecycleState: "terminal" });
    useOrderSettlementObservations.setState({ byOrderId: {} });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not read owner status without authentication or a capability", async () => {
    const unauthenticated = renderHook(() => useSettlementProgress(entries, false, scope));
    act(() => publishSettlementProgressHint(null));
    expect(mocks.read).not.toHaveBeenCalled();
    unauthenticated.unmount();
    const local = [{ ...entries[0], lifecycleState: "prepared" as const, orderId: null }];
    const view = renderHook(() => useSettlementProgress(local, true, scope));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it.each(["prepared", "capability-requested", "capability-bound", "submission-rejected"] as const)(
    "does not read settlement status for %s journal state",
    async (lifecycleState) => {
      const local = [{ ...entries[0], lifecycleState }];
      const view = renderHook(() => useSettlementProgress(local, true, scope));
      await waitFor(() => expect(view.result.current.loading).toBe(false));
      expect(mocks.read).not.toHaveBeenCalled();
    },
  );

  it("retains the last observation with a stale flag after a failed refresh", async () => {
    const view = renderHook(() => useSettlementProgress(entries, true, scope));
    await waitFor(() =>
      expect(view.result.current.observations["operation-1"]?.group).toEqual(group),
    );
    mocks.read.mockRejectedValueOnce(new Error("private provider detail"));
    act(() => view.result.current.refresh());
    await waitFor(() =>
      expect(view.result.current.observations["operation-1"]).toEqual({ group, unavailable: true }),
    );
  });

  it("ignores unrelated hints and coalesces hints during a read", async () => {
    let finish!: (value: typeof group) => void;
    mocks.read.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = renderHook(() => useSettlementProgress(entries, true, scope));
    act(() => {
      publishSettlementProgressHint({ orderId: "other-order", marketId: "other-market" });
      for (let index = 0; index < 10; index++) publishSettlementProgressHint(entries[0]);
    });
    expect(mocks.read).toHaveBeenCalledTimes(1);
    await act(async () => finish(group));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });

  it("aborts retired page reads and ignores their late results", async () => {
    let finish!: (value: typeof group) => void;
    mocks.read.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = renderHook(({ page }) => useSettlementProgress(page, true, scope), {
      initialProps: { page: entries },
    });
    const oldSignal = mocks.read.mock.calls[0][2] as AbortSignal;
    view.rerender({ page: [{ ...entries[0], operationId: "operation-2", orderId: "order-2" }] });
    await waitFor(() =>
      expect(view.result.current.observations["operation-2"]?.group).toEqual(group),
    );
    expect(oldSignal.aborted).toBe(true);
    await act(async () => finish(group));
    expect(view.result.current.observations["operation-1"]).toBeUndefined();
  });
  it("adopts the published group of a filled order without another read", async () => {
    mocks.read.mockResolvedValue(groupWith("SubmissionPending", 1));
    const view = renderHook(() => useSettlementProgress(entries, true, scope));
    await waitFor(() =>
      expect(view.result.current.observations["operation-1"]?.group?.status).toBe(
        "SubmissionPending",
      ),
    );
    act(() => publish(published("Confirmed", 2)));
    expect(view.result.current.observations["operation-1"]).toEqual({
      group: groupWith("Confirmed", 2),
      unavailable: false,
    });
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });

  it("keeps a newer published group when an older read finishes later", async () => {
    let finish!: (value: typeof group) => void;
    mocks.read.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = renderHook(() => useSettlementProgress(entries, true, scope));
    act(() => publish(published("Confirmed", 2)));
    await act(async () => finish(groupWith("SubmissionPending", 1)));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.observations["operation-1"]).toEqual({
      group: groupWith("Confirmed", 2),
      unavailable: false,
    });
  });

  it.each([
    ["the active wallet and signer", {}, "Confirmed"],
    ["another wallet", { walletId: "b".repeat(64) }, null],
    ["another signer", { signerRevision: 2 }, null],
    ["another market", { marketId: "condition-Beta" }, null],
  ] as const)("uses a published group from %s only when it matches", async (_, change, status) => {
    mocks.read.mockResolvedValue(null);
    publish({ ...published("Confirmed", 2), ...change });
    const view = renderHook(() => useSettlementProgress(entries, true, scope));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.observations["operation-1"]?.group?.status ?? null).toBe(status);
  });

  it("does not adopt a published group without owner authentication", () => {
    publish(published("Confirmed", 2));
    const view = renderHook(() => useSettlementProgress(entries, false, scope));
    expect(view.result.current.observations).toEqual({});
  });

  it("shows a confirmed trade as complete after its journal becomes terminal, then closes it", async () => {
    mocks.read.mockResolvedValue(groupWith("Confirmed", 2));
    const view = renderHook(({ page }) => useSettlementProgress(page, true, scope), {
      initialProps: { page: entries },
    });
    await waitFor(() =>
      expect(view.result.current.observations["operation-1"]?.group?.status).toBe("Confirmed"),
    );
    // The success notice closes after a bounded delay. A fake clock owns it.
    vi.useFakeTimers();
    let finish!: (value: { lifecycleState: "terminal" }) => void;
    mocks.readJournal.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    view.rerender({ page: [] });
    expect(mocks.readJournal).toHaveBeenCalledExactlyOnceWith("scope-1", "operation-1");
    await act(async () => finish({ lifecycleState: "terminal" }));
    expect(view.result.current.completed).toEqual([entries[0]]);
    await act(async () => vi.advanceTimersByTime(SETTLEMENT_COMPLETION_NOTICE_MS - 1));
    expect(view.result.current.completed).toEqual([entries[0]]);
    await act(async () => vi.advanceTimersByTime(1));
    expect(view.result.current.completed).toEqual([]);
  });

  it("does not show completion for an unconfirmed trade", async () => {
    mocks.read.mockResolvedValue(groupWith("Reconciling", 2));
    const view = renderHook(({ page }) => useSettlementProgress(page, true, scope), {
      initialProps: { page: entries },
    });
    await waitFor(() =>
      expect(view.result.current.observations["operation-1"]?.group?.status).toBe("Reconciling"),
    );
    view.rerender({ page: [] });
    expect(mocks.readJournal).not.toHaveBeenCalled();
    expect(view.result.current.completed).toEqual([]);
  });

  it("does not show completion when a confirmed trade leaves the page without a terminal journal", async () => {
    mocks.read.mockResolvedValue(groupWith("Confirmed", 2));
    let finish!: (value: { lifecycleState: "order-submitted" }) => void;
    mocks.readJournal.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = renderHook(({ page }) => useSettlementProgress(page, true, scope), {
      initialProps: { page: entries },
    });
    await waitFor(() =>
      expect(view.result.current.observations["operation-1"]?.group?.status).toBe("Confirmed"),
    );
    view.rerender({ page: [] });
    await act(async () => finish({ lifecycleState: "order-submitted" }));
    expect(mocks.readJournal).toHaveBeenCalledExactlyOnceWith("scope-1", "operation-1");
    expect(view.result.current.completed).toEqual([]);
  });
});

function groupWith(status: SettlementGroupStatus, revision: number) {
  return { ...group, status, revision };
}

function published(status: SettlementGroupStatus, revision: number): OrderSettlementObservation {
  return {
    walletId: scope.walletId,
    signerRevision: scope.signerRevision,
    marketId: "condition-Alpha",
    orderId: "order-1",
    status: "filled",
    group: groupWith(status, revision),
  };
}

function publish(observation: OrderSettlementObservation) {
  useOrderSettlementObservations.setState({ byOrderId: { [observation.orderId]: observation } });
}
