import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  OrderLifecycleStatus,
  SettlementGroupStatus,
  SettlementGroupSummary,
} from "@bitcaster/client-sdk/engineClient";
import { SETTLEMENT_COMPLETION_NOTICE_MS, useSettlementProgress } from "../useSettlementProgress";
import { publishSettlementProgressHint } from "@/lib/settlementProgressHints";
import {
  useOrderSettlementObservations,
  type OrderSettlementObservation,
} from "@/stores/orderSettlementObservations";
import { usePendingTradesStore } from "@/stores/pendingTrades";
import { useNotificationsStore } from "@/stores/notifications";
import {
  ORDER_FAILURE_NOTICES_STORAGE_KEY,
  orderFailureNoticeKey,
  useOrderFailureNotices,
} from "@/stores/orderFailureNotices";

const mocks = vi.hoisted(() => ({ read: vi.fn(), readFailure: vi.fn(), readJournal: vi.fn() }));
vi.mock("@/lib/settlementProgressReader", () => ({
  readSettlementProgress: mocks.read,
  readSettlementFailure: mocks.readFailure,
}));
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
const failure = {
  groupId: "group-1",
  reason: "OwnOutputReused" as const,
  failedAt: "2026-09-07T00:00:01Z",
};
const group: SettlementGroupSummary = {
  groupId: "group-1",
  status: "Reconciling",
  revision: 3,
  coalescingDeadline: "2026-09-07T00:00:00Z",
  frozenAt: null,
};

describe("read-only settlement progress", () => {
  beforeEach(() => {
    mocks.read.mockReset().mockResolvedValue(progressRead(group));
    mocks.readFailure.mockReset().mockResolvedValue(failure);
    mocks.readJournal.mockReset().mockResolvedValue({ lifecycleState: "terminal" });
    useOrderSettlementObservations.setState({ byOrderId: {} });
    localStorage.clear();
    useOrderFailureNotices.setState({ notices: {} });
    usePendingTradesStore.setState({ byOrderId: {} });
    useNotificationsStore.setState({ items: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
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
      expect(view.result.current.observations["operation-1"]).toEqual({
        group,
        orderStatus: "matched",
        unavailable: true,
      }),
    );
  });

  it("ignores unrelated hints and coalesces hints during a read", async () => {
    let finish!: (value: ReturnType<typeof progressRead>) => void;
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
    await act(async () => finish(progressRead(group)));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });

  it("aborts retired page reads and ignores their late results", async () => {
    let finish!: (value: ReturnType<typeof progressRead>) => void;
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
    await act(async () => finish(progressRead(group)));
    expect(view.result.current.observations["operation-1"]).toBeUndefined();
  });
  it("adopts the published group of a filled order without another read", async () => {
    mocks.read.mockResolvedValue(progressRead(groupWith("SubmissionPending", 1)));
    const view = renderHook(() => useSettlementProgress(entries, true, scope));
    await waitFor(() =>
      expect(view.result.current.observations["operation-1"]?.group?.status).toBe(
        "SubmissionPending",
      ),
    );
    act(() => publish(published("Confirmed", 2)));
    expect(view.result.current.observations["operation-1"]).toEqual({
      group: groupWith("Confirmed", 2),
      orderStatus: "filled",
      unavailable: false,
    });
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });

  it("keeps a newer published group when an older read finishes later", async () => {
    let finish!: (value: ReturnType<typeof progressRead>) => void;
    mocks.read.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = renderHook(() => useSettlementProgress(entries, true, scope));
    act(() => publish(published("Confirmed", 2)));
    await act(async () => finish(progressRead(groupWith("SubmissionPending", 1))));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.observations["operation-1"]).toEqual({
      group: groupWith("Confirmed", 2),
      orderStatus: "filled",
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
    mocks.read.mockResolvedValue(progressRead(groupWith("Confirmed", 2)));
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
    mocks.read.mockResolvedValue(progressRead(groupWith("Reconciling", 2)));
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
    mocks.read.mockResolvedValue(progressRead(groupWith("Confirmed", 2)));
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

  it("records the failure reason of a definitively rejected group once for its order", async () => {
    mocks.read.mockResolvedValue(progressRead(groupWith("DefinitivelyRejected", 4)));
    const view = renderHook(() => useSettlementProgress(entries, true, scope));
    await waitFor(() =>
      expect(recordedNotice()).toMatchObject({ ...expectedNotice, dismissed: false }),
    );
    expect(view.result.current.observations["operation-1"]).toEqual({
      group: groupWith("DefinitivelyRejected", 4),
      orderStatus: "matched",
      unavailable: false,
    });
    expect(mocks.readFailure).toHaveBeenCalledTimes(1);
    expect(mocks.readFailure.mock.calls[0].slice(0, 2)).toEqual(["condition-Alpha", "order-1"]);
    act(() => view.result.current.refresh());
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(mocks.readFailure).toHaveBeenCalledTimes(1);
    expect(recordedNotice()).toMatchObject({ ...expectedNotice, dismissed: false });
  });

  it.each([
    ["its pending trade", "pending"],
    ["its order notification", "notification"],
  ] as const)(
    "stores the market title from %s when it records a failure",
    async (_case, source) => {
      const title = "Will Alice win the cup?";
      if (source === "pending")
        usePendingTradesStore.setState({
          byOrderId: {
            "order-1": {
              orderId: "order-1",
              walletId: scope.walletId,
              marketId: "condition-Alpha",
              marketTitle: title,
              submittedAt: 1,
              baseAsset: "sat",
              divisibility: 1_000,
            },
          },
        });
      else
        useNotificationsStore.setState({
          items: [
            {
              id: "order-1-failed",
              kind: "Failed",
              orderId: "order-1",
              marketId: "condition-Alpha",
              filledAmountSubunits: 0,
              remainingAmountSubunits: 1_000,
              unit: "sat",
              marketTitle: title,
              occurredAt: 1,
              read: false,
            },
          ],
        });
      mocks.read.mockResolvedValue(progressRead(groupWith("Refundable", 4)));
      renderHook(() => useSettlementProgress(entries, true, scope));
      await waitFor(() => expect(recordedNotice()?.marketTitle).toBe(title));
    },
  );

  it("does not read a reason again after a reload when the order already has a specific reason", async () => {
    useOrderFailureNotices.getState().record(expectedNotice);
    useOrderFailureNotices.getState().dismiss("scope-1", "operation-1");
    mocks.read.mockResolvedValue(progressRead(groupWith("DefinitivelyRejected", 4)));
    const view = renderHook(() => useSettlementProgress(entries, true, scope));
    await waitFor(() =>
      expect(view.result.current.observations["operation-1"]?.group?.status).toBe(
        "DefinitivelyRejected",
      ),
    );
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(mocks.readFailure).not.toHaveBeenCalled();
    expect(recordedNotice()).toMatchObject({ reason: "OwnOutputReused", dismissed: true });
  });

  it("reads the reason of a generic notice again and keeps its dismissal", async () => {
    useOrderFailureNotices.getState().record({ ...expectedNotice, reason: "Unspecified" });
    useOrderFailureNotices.getState().dismiss("scope-1", "operation-1");
    mocks.read.mockResolvedValue(progressRead(groupWith("DefinitivelyRejected", 4)));
    renderHook(() => useSettlementProgress(entries, true, scope));
    await waitFor(() => expect(recordedNotice()?.reason).toBe("OwnOutputReused"));
    expect(recordedNotice()?.dismissed).toBe(true);
    expect(mocks.readFailure).toHaveBeenCalledTimes(1);
  });

  it("records the generic reason when the engine has no reason for the rejection", async () => {
    mocks.read.mockResolvedValue(progressRead(groupWith("DefinitivelyRejected", 4)));
    mocks.readFailure.mockResolvedValue(null);
    const view = renderHook(() => useSettlementProgress(entries, true, scope));
    await waitFor(() => expect(mocks.readFailure).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(recordedNotice()).toMatchObject({
      ...expectedNotice,
      reason: "Unspecified",
      dismissed: false,
    });
  });

  it.each(["Refundable", "ExpiredBeforeSubmission", "RejectedBeforeSubmission"] as const)(
    "records the generic reason for %s without a reason read",
    async (status) => {
      mocks.read.mockResolvedValue(progressRead(groupWith(status, 4)));
      const view = renderHook(() => useSettlementProgress(entries, true, scope));
      await waitFor(() => expect(recordedNotice()?.reason).toBe("Unspecified"));
      await waitFor(() => expect(view.result.current.loading).toBe(false));
      expect(mocks.readFailure).not.toHaveBeenCalled();
    },
  );

  // A refused request shows in its wallet alert; a stopped wait is no failure.
  it.each(["order-request-rejected", "submission-rejected"] as const)(
    "records no failure notice for the local refusal state %s",
    async (lifecycleState) => {
      const local = [{ ...entries[0], lifecycleState }];
      const view = renderHook(() => useSettlementProgress(local, true, scope));
      await waitFor(() => expect(view.result.current.loading).toBe(false));
      expect(useOrderFailureNotices.getState().notices).toEqual({});
      expect(mocks.read).not.toHaveBeenCalled();
    },
  );

  it.each(["failed", "rejected_capacity", "evicted_capacity"] as const)(
    "records the generic reason for an accepted order that ended %s with no settlement group",
    async (status) => {
      mocks.read.mockResolvedValue(progressRead(null, status));
      const view = renderHook(() => useSettlementProgress(entries, true, scope));
      await waitFor(() => expect(recordedNotice()?.reason).toBe("Unspecified"));
      await waitFor(() => expect(view.result.current.loading).toBe(false));
      expect(view.result.current.observations["operation-1"]).toEqual({
        group: null,
        orderStatus: status,
        unavailable: false,
      });
      expect(mocks.readFailure).not.toHaveBeenCalled();
    },
  );

  // The engine cancels a FOK only when it cannot fill within the consented
  // total. The wire carries no reason, so the cancellation is the reason.
  it.each([
    ["cancelled", "FokCancelled"],
    ["expired", "Unspecified"],
  ] as const)(
    "records an order that ended %s with no settlement group as a failed trade (%s)",
    async (status, reason) => {
      mocks.read.mockResolvedValue(progressRead(null, status));
      const view = renderHook(() => useSettlementProgress(entries, true, scope));
      await waitFor(() => expect(recordedNotice()?.reason).toBe(reason));
      await waitFor(() => expect(view.result.current.loading).toBe(false));
      expect(recordedNotice()).toMatchObject({
        orderId: "order-1",
        marketId: "condition-Alpha",
        funds: "pending",
        dismissed: false,
      });
      expect(mocks.readFailure).not.toHaveBeenCalled();
    },
  );

  it("records no failure for a matched order with no settlement group", async () => {
    mocks.read.mockResolvedValue(progressRead(null, "matched"));
    const view = renderHook(() => useSettlementProgress(entries, true, scope));
    await waitFor(() =>
      expect(view.result.current.observations["operation-1"]?.orderStatus).toBe("matched"),
    );
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(useOrderFailureNotices.getState().notices).toEqual({});
  });

  it("writes the notice once while later reads observe the same failure", async () => {
    mocks.read.mockResolvedValue(progressRead(groupWith("Refundable", 4)));
    const view = renderHook(() => useSettlementProgress(entries, true, scope));
    await waitFor(() => expect(recordedNotice()?.reason).toBe("Unspecified"));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    act(() => view.result.current.refresh());
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(setItem.mock.calls.filter(([key]) => key === ORDER_FAILURE_NOTICES_STORAGE_KEY)).toEqual(
      [],
    );
    setItem.mockRestore();
  });

  it.each(["Prepared", "SubmissionPending", "Reconciling", "Confirmed"] as const)(
    "records no failure and reads no reason for %s",
    async (status) => {
      mocks.read.mockResolvedValue(progressRead(groupWith(status, 4)));
      const view = renderHook(() => useSettlementProgress(entries, true, scope));
      await waitFor(() =>
        expect(view.result.current.observations["operation-1"]?.group?.status).toBe(status),
      );
      await waitFor(() => expect(view.result.current.loading).toBe(false));
      expect(mocks.readFailure).not.toHaveBeenCalled();
      expect(useOrderFailureNotices.getState().notices).toEqual({});
    },
  );

  it("records no failure for an unavailable status read", async () => {
    mocks.read.mockRejectedValue(new Error("private provider detail"));
    const view = renderHook(() => useSettlementProgress(entries, true, scope));
    await waitFor(() =>
      expect(view.result.current.observations["operation-1"]).toEqual({
        group: null,
        orderStatus: null,
        unavailable: true,
      }),
    );
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(useOrderFailureNotices.getState().notices).toEqual({});
  });

  it("keeps the generic reason when the failure reason is unavailable, and reads it again later", async () => {
    mocks.read.mockResolvedValue(progressRead(groupWith("DefinitivelyRejected", 4)));
    mocks.readFailure.mockRejectedValueOnce(new Error("private provider detail"));
    const view = renderHook(() => useSettlementProgress(entries, true, scope));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.observations["operation-1"]).toEqual({
      group: groupWith("DefinitivelyRejected", 4),
      orderStatus: "matched",
      unavailable: false,
    });
    expect(recordedNotice()?.reason).toBe("Unspecified");
    act(() => view.result.current.refresh());
    await waitFor(() =>
      expect(recordedNotice()).toMatchObject({ ...expectedNotice, dismissed: false }),
    );
    expect(mocks.readFailure).toHaveBeenCalledTimes(2);
  });
});

const expectedNotice = {
  scopeId: "scope-1",
  operationId: "operation-1",
  orderId: "order-1",
  marketId: "condition-Alpha",
  marketTitle: null,
  reason: "OwnOutputReused" as const,
};

function recordedNotice() {
  return useOrderFailureNotices.getState().notices[orderFailureNoticeKey("scope-1", "operation-1")];
}

function progressRead(
  readGroup: SettlementGroupSummary | null,
  status: OrderLifecycleStatus = "matched",
) {
  return { status, group: readGroup };
}

function groupWith(status: SettlementGroupStatus, revision: number): SettlementGroupSummary {
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
