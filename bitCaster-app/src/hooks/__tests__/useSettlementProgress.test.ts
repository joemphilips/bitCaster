import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettlementProgress } from "../useSettlementProgress";
import { publishSettlementProgressHint } from "@/lib/settlementProgressHints";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/settlementProgressReader", () => ({ readSettlementProgress: mocks.read }));
const entries = [{ operationId: "operation-1", orderId: "order-1", marketId: "condition-Alpha" }];
const group = { groupId: "group-1", status: "Reconciling", revision: 3,
  coalescingDeadline: "2026-09-07T00:00:00Z", frozenAt: null };

describe("read-only settlement progress", () => {
  beforeEach(() => { mocks.read.mockReset().mockResolvedValue(group); });

  it("does not read owner status without authentication or a capability", async () => {
    const unauthenticated = renderHook(() => useSettlementProgress(entries, false));
    act(() => publishSettlementProgressHint(null));
    expect(mocks.read).not.toHaveBeenCalled();
    unauthenticated.unmount();
    const local = [{ ...entries[0], orderId: null }];
    const view = renderHook(() => useSettlementProgress(local, true));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("retains the last observation with a stale flag after a failed refresh", async () => {
    const view = renderHook(() => useSettlementProgress(entries, true));
    await waitFor(() => expect(view.result.current.observations["operation-1"]?.group).toEqual(group));
    mocks.read.mockRejectedValueOnce(new Error("private provider detail"));
    act(() => view.result.current.refresh());
    await waitFor(() => expect(view.result.current.observations["operation-1"]).toEqual({ group, unavailable: true }));
  });

  it("ignores unrelated hints and coalesces hints during a read", async () => {
    let finish!: (value: typeof group) => void;
    mocks.read.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const view = renderHook(() => useSettlementProgress(entries, true));
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
    mocks.read.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const view = renderHook(({ page }) => useSettlementProgress(page, true), { initialProps: { page: entries } });
    const oldSignal = mocks.read.mock.calls[0][2] as AbortSignal;
    view.rerender({ page: [{ ...entries[0], operationId: "operation-2", orderId: "order-2" }] });
    await waitFor(() => expect(view.result.current.observations["operation-2"]?.group).toEqual(group));
    expect(oldSignal.aborted).toBe(true);
    await act(async () => finish(group));
    expect(view.result.current.observations["operation-1"]).toBeUndefined();
  });
});
