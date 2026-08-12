import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listenForPortfolioInvalidation } from "@/lib/portfolioInvalidation";
import { useNotificationsStore } from "@/stores/notifications";
import { usePendingTradesStore } from "@/stores/pendingTrades";

const walletId = "a".repeat(64);
const { mockUseOrderHub, mockJoinOrder, mockRecover, mockFetchOrderStatus } = vi.hoisted(() => ({
  mockUseOrderHub: vi.fn(),
  mockJoinOrder: vi.fn(),
  mockRecover: vi.fn(),
  mockFetchOrderStatus: vi.fn(),
}));

vi.mock("@/hooks/useOrderHub", () => ({ useOrderHub: mockUseOrderHub }));
vi.mock("@/lib/browserCtfRangeOrderSubmission", () => ({
  recoverBrowserCtfRangeOrder: mockRecover,
}));
vi.mock("@/lib/browserWalletProfile", () => ({ browserWalletIdFromMnemonic: () => walletId }));
vi.mock("@/lib/orderStatus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/orderStatus")>()),
  fetchOrderStatus: mockFetchOrderStatus,
}));

import { useOrderSettlementLifecycle } from "../useOrderSettlementLifecycle";

const recoveryInput = {
  mnemonic:
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  mintUrls: ["https://mint.example"],
};

function settlementDelta(
  orderId: string,
  status:
    | "Prepared"
    | "Confirmed"
    | "DefinitivelyRejected"
    | "Refundable"
    | "ExpiredBeforeSubmission",
) {
  return {
    orderId,
    marketId: "condition-YES",
    settlementGroup: {
      groupId: "22222222-2222-4222-8222-222222222222",
      status,
      revision: 3,
      coalescingDeadline: "2026-08-08T00:00:00.000Z",
      frozenAt: "2026-08-08T00:00:01.000Z",
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  usePendingTradesStore.setState({ byOrderId: {} });
  useNotificationsStore.setState({ items: [] });
  mockJoinOrder.mockResolvedValue(undefined);
  mockRecover.mockResolvedValue({ recovered: 0, pending: [] });
  mockFetchOrderStatus.mockResolvedValue(null);
  mockUseOrderHub.mockReturnValue({ joinOrder: mockJoinOrder });
});

describe("useOrderSettlementLifecycle", () => {
  it("joins an owned order and recovers only after confirmation", async () => {
    usePendingTradesStore.getState().add({
      orderId: "11111111-1111-4111-8111-111111111111",
      clientOrderId: "client-order-1",
      marketId: "condition-YES",
      baseAsset: "sat",
      divisibility: 10_000,
      submittedAt: Date.now(),
    });
    renderHook(() => useOrderSettlementLifecycle(true, recoveryInput));

    await waitFor(() =>
      expect(mockJoinOrder).toHaveBeenCalledWith("condition-YES", expect.any(String)),
    );
    const callbacks = mockUseOrderHub.mock.calls.at(-1)?.[1];
    callbacks.onSettlementGroupStateChanged(
      settlementDelta("11111111-1111-4111-8111-111111111111", "Prepared"),
    );
    expect(mockRecover).not.toHaveBeenCalled();
    expect(mockFetchOrderStatus).not.toHaveBeenCalled();

    callbacks.onSettlementGroupStateChanged(
      settlementDelta("11111111-1111-4111-8111-111111111111", "Confirmed"),
    );
    await waitFor(() =>
      expect(mockRecover).toHaveBeenCalledWith({
        ...recoveryInput,
        clientOrderId: "client-order-1",
      }),
    );
    await waitFor(() =>
      expect(
        usePendingTradesStore.getState().byOrderId["11111111-1111-4111-8111-111111111111"],
      ).toBeUndefined(),
    );
  });

  it("retains the order while exact settlement recovery is pending", async () => {
    mockRecover.mockResolvedValue({
      recovered: 0,
      pending: [{ operationId: "operation-1", revision: 1, code: "recovery-pending" }],
    });
    usePendingTradesStore.getState().add({
      orderId: "11111111-1111-4111-8111-111111111111",
      clientOrderId: "client-order-1",
      marketId: "condition-YES",
      baseAsset: "sat",
      divisibility: 10_000,
      submittedAt: Date.now(),
    });
    renderHook(() => useOrderSettlementLifecycle(true, recoveryInput));
    const callbacks = mockUseOrderHub.mock.calls.at(-1)?.[1];

    callbacks.onSettlementGroupStateChanged(
      settlementDelta("11111111-1111-4111-8111-111111111111", "Confirmed"),
    );

    await waitFor(() => expect(mockRecover).toHaveBeenCalledOnce());
    expect(
      usePendingTradesStore.getState().byOrderId["11111111-1111-4111-8111-111111111111"],
    ).toBeDefined();
  });

  it("rejoins retained orders after reconnect", async () => {
    usePendingTradesStore.getState().add({
      orderId: "11111111-1111-4111-8111-111111111111",
      clientOrderId: "client-order-1",
      marketId: "condition-YES",
      baseAsset: "sat",
      divisibility: 10_000,
      submittedAt: Date.now(),
    });
    renderHook(() => useOrderSettlementLifecycle(true, recoveryInput));
    await waitFor(() => expect(mockJoinOrder).toHaveBeenCalledOnce());
    const callbacks = mockUseOrderHub.mock.calls.at(-1)?.[1];

    act(() => callbacks.onReconnected());

    await waitFor(() => expect(mockJoinOrder).toHaveBeenCalledTimes(2));
  });

  it("uses an owner lifecycle callback for notification and terminal state", async () => {
    const orderId = "11111111-1111-4111-8111-111111111111";
    usePendingTradesStore.getState().add({
      orderId,
      clientOrderId: "client-order-1",
      marketId: "condition-YES",
      baseAsset: "sat",
      divisibility: 10_000,
      amountSubunits: 10,
      submittedAt: Date.now(),
    });
    renderHook(() => useOrderSettlementLifecycle(true, recoveryInput));
    const callbacks = mockUseOrderHub.mock.calls.at(-1)?.[1];

    act(() =>
      callbacks.onOrderLifecycleChanged({
        orderId,
        marketId: "condition-YES",
        status: "cancelled",
        remainingAmountSubunits: 10,
        baseAsset: "sat",
        collateralUnit: "msat",
        divisibility: 10_000,
        activeSettlementGroup: null,
      }),
    );

    expect(useNotificationsStore.getState().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: `${orderId}-cancelled`, kind: "cancelled" }),
      ]),
    );
    expect(usePendingTradesStore.getState().byOrderId[orderId]).toBeUndefined();
  });

  it("coalesces portfolio invalidation for confirmed owner updates", async () => {
    const invalidate = vi.fn();
    const stop = listenForPortfolioInvalidation(invalidate);
    try {
      renderHook(() => useOrderSettlementLifecycle(true, recoveryInput));
      const callbacks = mockUseOrderHub.mock.calls.at(-1)?.[1];
      act(() => {
        callbacks.onSettlementGroupStateChanged(settlementDelta("order-a", "Confirmed"));
        callbacks.onSettlementGroupStateChanged(settlementDelta("order-b", "Confirmed"));
      });
      await waitFor(() => expect(invalidate).toHaveBeenCalledExactlyOnceWith({ walletId }));
    } finally {
      stop();
    }
  });

  it("reconciles terminal settlement state once and still recovers after a failed read", async () => {
    const orderId = "11111111-1111-4111-8111-111111111111";
    mockFetchOrderStatus.mockRejectedValueOnce(new Error("temporary read failure"));
    usePendingTradesStore.getState().add({
      orderId,
      clientOrderId: "client-order-1",
      marketId: "condition-YES",
      baseAsset: "sat",
      divisibility: 10_000,
      submittedAt: Date.now(),
    });
    renderHook(() => useOrderSettlementLifecycle(true, recoveryInput));
    const callbacks = mockUseOrderHub.mock.calls.at(-1)?.[1];

    act(() => callbacks.onSettlementGroupStateChanged(settlementDelta(orderId, "Confirmed")));

    await waitFor(() => expect(mockFetchOrderStatus).toHaveBeenCalledOnce());
    await waitFor(() => expect(mockRecover).toHaveBeenCalledOnce());
  });
});
