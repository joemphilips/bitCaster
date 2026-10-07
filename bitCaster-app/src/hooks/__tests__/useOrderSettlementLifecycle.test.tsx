import { StrictMode, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listenForPortfolioInvalidation } from "@/lib/portfolioInvalidation";
import { useNotificationsStore } from "@/stores/notifications";
import { usePendingTradesStore } from "@/stores/pendingTrades";
import { useActivityLogStore } from "@/stores/activity-log";
import { useOrderSettlementObservations } from "@/stores/orderSettlementObservations";
import type { OrderStatusResponse } from "@/lib/orderStatus";

const walletId = "a".repeat(64);
const otherWalletId = "b".repeat(64);
const mockSignerState = vi.hoisted(() => ({ revision: 0 }));
vi.mock("@/lib/nostr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/nostr")>()),
  getNostrSignerRevision: () => mockSignerState.revision,
}));
const { mockUseOrderHub, mockJoinOrder, mockRecover, mockFetchOrderStatus, mockWalletState } =
  vi.hoisted(() => ({
    mockUseOrderHub: vi.fn(),
    mockJoinOrder: vi.fn(),
    mockRecover: vi.fn(),
    mockFetchOrderStatus: vi.fn(),
    mockWalletState: { mnemonic: "wallet A mnemonic", activeScope: "scope-a" as string | null },
  }));

vi.mock("@/hooks/useOrderHub", () => ({ useOrderHub: mockUseOrderHub }));
vi.mock("@/lib/browserCtfRangeOrderSubmission", () => ({
  recoverBrowserCtfRangeOrder: mockRecover,
}));
vi.mock("@/lib/browserWalletProfile", () => ({
  browserWalletIdFromMnemonic: (mnemonic: string) =>
    mnemonic === "other mnemonic" ? otherWalletId : walletId,
  isActiveBrowserWalletId: (id: string, mnemonic: string) =>
    id === (mnemonic === "other mnemonic" ? otherWalletId : walletId) &&
    mockWalletState.activeScope === (mnemonic === "other mnemonic" ? "scope-b" : "scope-a"),
}));
vi.mock("@/stores/wallet", () => ({
  useWalletStore: { getState: () => mockWalletState },
}));
vi.mock("@/lib/orderStatus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/orderStatus")>()),
  fetchOrderStatus: mockFetchOrderStatus,
}));

import { useOrderSettlementLifecycle } from "../useOrderSettlementLifecycle";

const legacyOrderId = "33333333-3333-4333-8333-333333333333";
const legacyMarketId = "condition-YES";

function unscopedTrade(orderId = legacyOrderId, marketId = legacyMarketId) {
  return {
    orderId,
    marketId,
    clientOrderId: `legacy-${orderId}`,
    baseAsset: "sat" as const,
    divisibility: 1_000 as const,
    submittedAt: 1_700_000_000_000,
  };
}

function legacyStatus(
  orderId = legacyOrderId,
  marketId = legacyMarketId,
  overrides: Partial<OrderStatusResponse> = {},
): OrderStatusResponse {
  return {
    orderId,
    marketId,
    status: "cancelled",
    remainingAmountSubunits: 0,
    filledAmountSubunits: 0,
    amountSubunits: 1_000,
    outcomeId: "YES",
    side: "Buy",
    price: 500,
    placedAt: "2026-08-08T00:00:00Z",
    timeInForce: "FOK",
    expiresAt: null,
    tokenSide: "Outcome",
    baseAsset: "sat",
    divisibility: 1_000,
    fills: [],
    activeSettlementGroup: null,
    ...overrides,
  };
}

function legacyFailedFill(): OrderStatusResponse["fills"][number] {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    takerOrderId: legacyOrderId,
    makerOrderId: "66666666-6666-4666-8666-666666666666",
    amountSubunits: 0,
    executionPrice: 500,
    path: "Complementary",
    status: "Failed",
    baseAsset: "sat",
    divisibility: 1_000,
    quotePaymentSubunits: 0,
    outcomeFaceAmountSubunits: 0,
    tokenSide: "Outcome",
    filledAt: "2026-08-08T00:00:00Z",
    settlementGroup: {
      groupId: "77777777-7777-4777-8777-777777777777",
      status: "DefinitivelyRejected",
      revision: 1,
      coalescingDeadline: "2026-08-08T00:00:00Z",
      frozenAt: "2026-08-08T00:00:01Z",
    },
  };
}

function confirmedFill(
  fillId: string,
  orderId: string,
  overrides: Partial<OrderStatusResponse["fills"][number]> = {},
): OrderStatusResponse["fills"][number] {
  return {
    id: fillId,
    takerOrderId: orderId,
    makerOrderId: "66666666-6666-4666-8666-666666666666",
    amountSubunits: 2_500,
    executionPrice: 400,
    path: "Complementary",
    status: "Filled",
    baseAsset: "sat",
    divisibility: 1_000,
    quotePaymentSubunits: 1_003,
    outcomeFaceAmountSubunits: 2_500,
    tokenSide: "Outcome",
    filledAt: "2026-09-27T12:00:00.000Z",
    settlementGroup: {
      groupId: "77777777-7777-4777-8777-777777777777",
      status: "Confirmed",
      revision: 1,
      coalescingDeadline: "2026-09-27T11:59:00.000Z",
      frozenAt: "2026-09-27T11:59:01.000Z",
    },
    ...overrides,
  };
}

function ownedStatus(
  orderId: string,
  marketId = "condition-YES",
  overrides: Partial<OrderStatusResponse> = {},
): OrderStatusResponse {
  return {
    orderId,
    marketId,
    status: "partially_filled",
    remainingAmountSubunits: 2_500,
    filledAmountSubunits: 2_500,
    amountSubunits: 5_000,
    outcomeId: "YES",
    side: "Buy",
    price: 400,
    placedAt: "2026-09-27T11:58:00.000Z",
    timeInForce: "FOK",
    expiresAt: null,
    tokenSide: "Outcome",
    baseAsset: "sat",
    divisibility: 1_000,
    fills: [confirmedFill("88888888-8888-4888-8888-888888888888", orderId)],
    activeSettlementGroup: null,
    ...overrides,
  };
}

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
    | "RejectedBeforeSubmission"
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
      frozenAt: status === "RejectedBeforeSubmission" ? null : "2026-08-08T00:00:01.000Z",
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSignerState.revision = 0;
  useOrderSettlementObservations.setState({ byOrderId: {} });
  mockWalletState.mnemonic = recoveryInput.mnemonic;
  mockWalletState.activeScope = "scope-a";
  usePendingTradesStore.setState({ byOrderId: {} });
  localStorage.removeItem("bitcaster-activity-log");
  useActivityLogStore.setState({ items: [] });
  useNotificationsStore.setState({ items: [] });
  mockJoinOrder.mockResolvedValue(undefined);
  mockRecover.mockResolvedValue({ recovered: 0, pending: [] });
  mockFetchOrderStatus.mockResolvedValue(null);
  mockUseOrderHub.mockReturnValue({ joinOrder: mockJoinOrder });
});

describe("useOrderSettlementLifecycle", () => {
  it("keeps newer group evidence and bounds display retention to the active wallet's pending work", () => {
    const trade = { ...unscopedTrade(), walletId };
    usePendingTradesStore.getState().add(trade);
    const group = settlementDelta(trade.orderId, "Confirmed").settlementGroup;
    const status = ownedStatus(trade.orderId, trade.marketId, {
      status: "matched",
      fills: [],
      activeSettlementGroup: group,
    });
    const observations = useOrderSettlementObservations.getState();
    observations.publish(trade, 0, status);
    const confirmed = useOrderSettlementObservations.getState().byOrderId[trade.orderId];
    observations.publish(trade, 0, {
      ...status,
      activeSettlementGroup: { ...group, revision: 2, status: "Prepared" },
    });
    expect(useOrderSettlementObservations.getState().byOrderId[trade.orderId]).toBe(confirmed);
    observations.publish(trade, 0, { ...status, orderId: "foreign-order" });
    observations.publish(trade, 0, { ...status, marketId: "foreign-market" });
    expect(useOrderSettlementObservations.getState().byOrderId[trade.orderId]).toBe(confirmed);

    observations.retain(otherWalletId, usePendingTradesStore.getState().byOrderId);
    expect(useOrderSettlementObservations.getState().byOrderId).toEqual({});
    usePendingTradesStore.getState().remove(trade.orderId, walletId);
    observations.publish(trade, 0, status);
    expect(useOrderSettlementObservations.getState().byOrderId).toEqual({});
  });

  it("shares authenticated display observations without another read and removes completed work", async () => {
    const trade = { ...unscopedTrade(), walletId };
    usePendingTradesStore.getState().add(trade);
    const group = settlementDelta(trade.orderId, "Prepared").settlementGroup;
    mockFetchOrderStatus.mockResolvedValue(
      ownedStatus(trade.orderId, trade.marketId, {
        status: "matched",
        fills: [],
        activeSettlementGroup: group,
      }),
    );
    renderHook(() => useOrderSettlementLifecycle(true, recoveryInput));

    await waitFor(() =>
      expect(useOrderSettlementObservations.getState().byOrderId[trade.orderId]).toEqual({
        walletId,
        signerRevision: 0,
        marketId: trade.marketId,
        orderId: trade.orderId,
        status: "matched",
        group,
      }),
    );
    expect(mockFetchOrderStatus).toHaveBeenCalledOnce();
    expect(mockRecover).not.toHaveBeenCalled();

    act(() => usePendingTradesStore.getState().remove(trade.orderId, walletId));
    await waitFor(() => expect(useOrderSettlementObservations.getState().byOrderId).toEqual({}));
    expect(mockFetchOrderStatus).toHaveBeenCalledOnce();
  });

  it.each(["signer change", "disposal"] as const)(
    "does not publish a delayed display observation after %s",
    async (change) => {
      const trade = { ...unscopedTrade(), walletId };
      usePendingTradesStore.getState().add(trade);
      let resolve!: (status: OrderStatusResponse) => void;
      mockFetchOrderStatus.mockImplementation(
        () =>
          new Promise<OrderStatusResponse>((done) => {
            resolve = done;
          }),
      );
      const { unmount } = renderHook(() => useOrderSettlementLifecycle(true, recoveryInput));
      await waitFor(() => expect(mockFetchOrderStatus).toHaveBeenCalledOnce());
      if (change === "signer change") mockSignerState.revision++;
      else unmount();
      await act(async () =>
        resolve(
          ownedStatus(trade.orderId, trade.marketId, {
            status: "matched",
            fills: [],
            activeSettlementGroup: settlementDelta(trade.orderId, "Prepared").settlementGroup,
          }),
        ),
      );

      expect(useOrderSettlementObservations.getState().byOrderId).toEqual({});
      expect(mockFetchOrderStatus).toHaveBeenCalledOnce();
      expect(mockRecover).not.toHaveBeenCalled();
    },
  );

  it.each(["cancelled", "expired", "evicted_capacity", "rejected_capacity", "failed"] as const)(
    "clears an unscoped order after an authenticated zero-fill %s result",
    async (status) => {
      const trade = unscopedTrade();
      usePendingTradesStore.setState({ byOrderId: { [trade.orderId]: trade } });
      mockFetchOrderStatus.mockResolvedValueOnce(
        legacyStatus(trade.orderId, trade.marketId, { status }),
      );

      renderHook(() => useOrderSettlementLifecycle(true, recoveryInput));

      await waitFor(() => expect(mockFetchOrderStatus).toHaveBeenCalledOnce());
      await waitFor(() =>
        expect(usePendingTradesStore.getState().byOrderId[trade.orderId]).toBeUndefined(),
      );
      expect(mockFetchOrderStatus).toHaveBeenCalledExactlyOnceWith(trade.marketId, trade.orderId);
      expect(usePendingTradesStore.getState().hasUnscopedPending()).toBe(false);
      expect(useNotificationsStore.getState().items).toEqual([]);
      expect(mockRecover).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["unavailable response", null],
    ["different order", legacyStatus("44444444-4444-4444-8444-444444444444")],
    ["different market", legacyStatus(legacyOrderId, "condition-NO")],
    ["nonterminal status", legacyStatus(legacyOrderId, legacyMarketId, { status: "resting" })],
    [
      "fill requiring recovery",
      legacyStatus(legacyOrderId, legacyMarketId, { filledAmountSubunits: 1 }),
    ],
    [
      "failed fill record with zero aggregate amount",
      legacyStatus(legacyOrderId, legacyMarketId, {
        fills: [legacyFailedFill()],
        filledAmountSubunits: 0,
      }),
    ],
    [
      "active settlement",
      legacyStatus(legacyOrderId, legacyMarketId, {
        activeSettlementGroup: {
          groupId: "22222222-2222-4222-8222-222222222222",
          status: "Confirmed",
          revision: 1,
          coalescingDeadline: "2026-08-08T00:00:00.000Z",
          frozenAt: "2026-08-08T00:00:01.000Z",
        },
      }),
    ],
    ["filled terminal status", legacyStatus(legacyOrderId, legacyMarketId, { status: "filled" })],
  ] as const)("keeps an unscoped order for %s", async (_reason, response) => {
    const trade = unscopedTrade();
    usePendingTradesStore.setState({ byOrderId: { [trade.orderId]: trade } });
    mockFetchOrderStatus.mockResolvedValueOnce(response);

    renderHook(() => useOrderSettlementLifecycle(true, recoveryInput));

    await waitFor(() => expect(mockFetchOrderStatus).toHaveBeenCalledOnce());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(usePendingTradesStore.getState().byOrderId[trade.orderId]).toBe(trade);
    expect(usePendingTradesStore.getState().hasUnscopedPending()).toBe(true);
  });

  it("does not remove a replacement legacy record after a deferred old status response", async () => {
    const observed = unscopedTrade();
    const deferred = ((): {
      promise: Promise<OrderStatusResponse | null>;
      resolve: (value: OrderStatusResponse | null) => void;
    } => {
      let resolve!: (value: OrderStatusResponse | null) => void;
      const promise = new Promise<OrderStatusResponse | null>((complete) => {
        resolve = complete;
      });
      return { promise, resolve };
    })();
    usePendingTradesStore.setState({ byOrderId: { [observed.orderId]: observed } });
    mockFetchOrderStatus.mockReturnValueOnce(deferred.promise);
    renderHook(() => useOrderSettlementLifecycle(true, recoveryInput));
    await waitFor(() => expect(mockFetchOrderStatus).toHaveBeenCalledOnce());

    const replacement = { ...observed, submittedAt: observed.submittedAt + 1 };
    act(() =>
      usePendingTradesStore.setState({ byOrderId: { [replacement.orderId]: replacement } }),
    );
    deferred.resolve(legacyStatus(observed.orderId, observed.marketId));

    await waitFor(() => expect(mockFetchOrderStatus).toHaveBeenCalledTimes(2));
    expect(usePendingTradesStore.getState().byOrderId[observed.orderId]).toBe(replacement);
    expect(usePendingTradesStore.getState().hasUnscopedPending()).toBe(true);
  });

  it.each(["missing", "failed", "terminal"])(
    "reconciles pre-submission rejection without confirmed recovery (%s read)",
    async (readResult) => {
      const orderId = "11111111-1111-4111-8111-111111111111";
      if (readResult === "failed")
        mockFetchOrderStatus.mockRejectedValueOnce(new Error("read unavailable"));
      if (readResult === "terminal")
        mockFetchOrderStatus.mockResolvedValueOnce({
          orderId,
          marketId: "condition-YES",
          status: "cancelled",
          remainingAmountSubunits: 0,
          filledAmountSubunits: 0,
          amountSubunits: 1_000,
          outcomeId: "YES",
          side: "Buy",
          price: 500,
          placedAt: "2026-08-08T00:00:00Z",
          timeInForce: "FOK",
          expiresAt: null,
          tokenSide: "Outcome",
          baseAsset: "sat",
          divisibility: 1_000,
          fills: [],
          activeSettlementGroup: null,
        } satisfies OrderStatusResponse);
      usePendingTradesStore.getState().add({
        orderId,
        walletId,
        clientOrderId: "rejected-order",
        marketId: "condition-YES",
        baseAsset: "sat",
        divisibility: 1_000,
        submittedAt: Date.now(),
      });
      const invalidated = vi.fn();
      const stop = listenForPortfolioInvalidation(invalidated);
      try {
        renderHook(() => useOrderSettlementLifecycle(true, recoveryInput));
        const callbacks = mockUseOrderHub.mock.calls.at(-1)?.[1];
        act(() =>
          callbacks.onSettlementGroupStateChanged(
            settlementDelta(orderId, "RejectedBeforeSubmission"),
          ),
        );
        await waitFor(() =>
          expect(mockFetchOrderStatus).toHaveBeenCalledExactlyOnceWith("condition-YES", orderId),
        );
        expect(mockRecover).not.toHaveBeenCalled();
        expect(invalidated).not.toHaveBeenCalled();
        if (readResult === "terminal") {
          expect(usePendingTradesStore.getState().byOrderId[orderId]).toBeUndefined();
          expect(useNotificationsStore.getState().items).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ id: `${orderId}-cancelled`, kind: "cancelled" }),
            ]),
          );
        } else {
          expect(usePendingTradesStore.getState().byOrderId[orderId]).toBeDefined();
        }
      } finally {
        stop();
      }
    },
  );

  it("joins an owned order and recovers only after confirmation", async () => {
    const orderId = "11111111-1111-4111-8111-111111111111";
    mockFetchOrderStatus.mockResolvedValueOnce(null).mockResolvedValueOnce(ownedStatus(orderId));
    usePendingTradesStore.getState().add({
      orderId,
      walletId,
      clientOrderId: "client-order-1",
      marketId: "condition-YES",
      baseAsset: "sat",
      divisibility: 1_000,
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
    await waitFor(() => expect(mockFetchOrderStatus).toHaveBeenCalledOnce());
    expect(mockRecover).not.toHaveBeenCalled();

    callbacks.onSettlementGroupStateChanged(settlementDelta(orderId, "Confirmed"));
    await waitFor(() =>
      expect(mockRecover).toHaveBeenCalledWith({
        ...recoveryInput,
        clientOrderId: "client-order-1",
      }),
    );
    await waitFor(() => expect(useActivityLogStore.getState().items).toHaveLength(1));
    await waitFor(() =>
      expect(usePendingTradesStore.getState().byOrderId[orderId]).toBeUndefined(),
    );
  });

  it("records each authenticated confirmed fill once across reconnect recovery reads", async () => {
    const orderId = "11111111-1111-4111-8111-111111111111";
    const firstFillId = "88888888-8888-4888-8888-888888888888";
    const secondFillId = "99999999-9999-4999-8999-999999999999";
    const status = ownedStatus(orderId, "condition-YES", {
      fills: [
        confirmedFill(firstFillId, orderId),
        confirmedFill(secondFillId, orderId, {
          quotePaymentSubunits: 997,
          outcomeFaceAmountSubunits: 2_000,
          filledAt: "2026-09-27T12:01:00.000Z",
        }),
      ],
    });
    mockFetchOrderStatus.mockResolvedValue(status);
    mockRecover.mockReturnValue(new Promise(() => {}));
    usePendingTradesStore.getState().add({
      orderId,
      walletId,
      clientOrderId: "client-order-1",
      marketId: "condition-YES",
      baseAsset: "sat",
      divisibility: 1_000,
      submittedAt: Date.now(),
    });
    const { unmount } = renderHook(() => useOrderSettlementLifecycle(true, recoveryInput));

    await waitFor(() => expect(useActivityLogStore.getState().items).toHaveLength(2));
    const firstReadItems = useActivityLogStore.getState().items;
    expect(firstReadItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `trade:${walletId}:${firstFillId}`,
          walletId,
          type: "Buy",
          amountSubunits: 1_003,
          marketId: "condition-YES",
          tradeDetails: expect.objectContaining({
            fillId: firstFillId,
            outcomeId: "YES",
            tokenSide: "Outcome",
            faceAmountSubunits: 2_500,
            divisibility: 1_000,
          }),
        }),
        expect.objectContaining({
          id: `trade:${walletId}:${secondFillId}`,
          amountSubunits: 997,
          tradeDetails: expect.objectContaining({ faceAmountSubunits: 2_000 }),
        }),
      ]),
    );
    await waitFor(() => expect(mockRecover).toHaveBeenCalledOnce());

    act(() => mockUseOrderHub.mock.calls.at(-1)?.[1].onReconnected());
    await waitFor(() => expect(mockFetchOrderStatus).toHaveBeenCalledTimes(2));
    expect(useActivityLogStore.getState().items).toHaveLength(2);
    unmount();
  });

  it("re-reads an in-flight matched snapshot after a confirmed settlement event", async () => {
    const orderId = "11111111-1111-4111-8111-111111111111";
    const initial = ownedStatus(orderId, "condition-YES", {
      status: "matched",
      fills: [
        confirmedFill("88888888-8888-4888-8888-888888888888", orderId, {
          status: "Matched",
          settlementGroup: {
            groupId: "77777777-7777-4777-8777-777777777777",
            status: "SubmissionPending",
            revision: 1,
            coalescingDeadline: "2026-09-27T11:59:00.000Z",
            frozenAt: "2026-09-27T11:59:01.000Z",
          },
        }),
      ],
      activeSettlementGroup: {
        groupId: "77777777-7777-4777-8777-777777777777",
        status: "SubmissionPending",
        revision: 1,
        coalescingDeadline: "2026-09-27T11:59:00.000Z",
        frozenAt: "2026-09-27T11:59:01.000Z",
      },
    });
    let resolveInitial!: (value: OrderStatusResponse) => void;
    mockFetchOrderStatus
      .mockReturnValueOnce(
        new Promise<OrderStatusResponse>((resolve) => {
          resolveInitial = resolve;
        }),
      )
      .mockResolvedValueOnce(ownedStatus(orderId));
    usePendingTradesStore.getState().add({
      orderId,
      walletId,
      clientOrderId: "client-order-1",
      marketId: "condition-YES",
      baseAsset: "sat",
      divisibility: 1_000,
      submittedAt: Date.now(),
    });
    renderHook(() => useOrderSettlementLifecycle(true, recoveryInput));
    const callbacks = mockUseOrderHub.mock.calls.at(-1)?.[1];

    await waitFor(() => expect(mockFetchOrderStatus).toHaveBeenCalledOnce());
    act(() => {
      callbacks.onOrderLifecycleChanged({
        orderId,
        marketId: "condition-YES",
        status: "filled",
        remainingAmountSubunits: 0,
        baseAsset: "sat",
        collateralUnit: "msat",
        divisibility: 1_000,
        activeSettlementGroup: null,
      });
      callbacks.onSettlementGroupStateChanged(settlementDelta(orderId, "Confirmed"));
    });
    act(() => resolveInitial(initial));

    await waitFor(() => expect(mockFetchOrderStatus).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(useActivityLogStore.getState().items).toHaveLength(1));
    await waitFor(() => expect(mockRecover).toHaveBeenCalledOnce());
  });

  it.each(["Matched", "Failed"] as const)(
    "does not create activity from a %s fill",
    async (fillStatus) => {
      const orderId = "11111111-1111-4111-8111-111111111111";
      mockFetchOrderStatus.mockResolvedValue(
        ownedStatus(orderId, "condition-YES", {
          fills: [
            confirmedFill("88888888-8888-4888-8888-888888888888", orderId, {
              status: fillStatus,
            }),
          ],
        }),
      );
      usePendingTradesStore.getState().add({
        orderId,
        walletId,
        clientOrderId: "client-order-1",
        marketId: "condition-YES",
        baseAsset: "sat",
        divisibility: 1_000,
        submittedAt: Date.now(),
      });

      renderHook(() => useOrderSettlementLifecycle(true, recoveryInput));

      await waitFor(() => expect(mockFetchOrderStatus).toHaveBeenCalledOnce());
      await act(async () => {
        await Promise.resolve();
      });
      expect(useActivityLogStore.getState().items).toEqual([]);
      expect(mockRecover).not.toHaveBeenCalled();
    },
  );

  it("does not join or mutate a pending order owned by another wallet", async () => {
    const orderId = "other-wallet-order";
    usePendingTradesStore.getState().add({
      orderId,
      walletId: otherWalletId,
      clientOrderId: "other-client-order",
      marketId: "condition-YES",
      baseAsset: "sat",
      divisibility: 1_000,
      submittedAt: Date.now(),
    });
    renderHook(() => useOrderSettlementLifecycle(true, recoveryInput));
    const callbacks = mockUseOrderHub.mock.calls.at(-1)?.[1];

    act(() =>
      callbacks.onOrderLifecycleChanged({
        orderId,
        marketId: "condition-YES",
        status: "cancelled",
        remainingAmountSubunits: 0,
        baseAsset: "sat",
        collateralUnit: "msat",
        divisibility: 1_000,
        activeSettlementGroup: null,
      }),
    );

    expect(mockJoinOrder).not.toHaveBeenCalled();
    expect(usePendingTradesStore.getState().byOrderId[orderId]).toBeDefined();
    expect(useNotificationsStore.getState().items).toEqual([]);
  });

  it("stores a late confirmed result under its captured wallet but hides it from the new wallet", async () => {
    const orderId = "11111111-1111-4111-8111-111111111111";
    let resolveStatus!: (value: OrderStatusResponse) => void;
    mockFetchOrderStatus.mockReturnValueOnce(
      new Promise<OrderStatusResponse>((resolve) => {
        resolveStatus = resolve;
      }),
    );
    usePendingTradesStore.getState().add({
      orderId,
      walletId,
      clientOrderId: "client-order-1",
      marketId: "condition-YES",
      baseAsset: "sat",
      divisibility: 1_000,
      submittedAt: Date.now(),
    });
    renderHook(() => useOrderSettlementLifecycle(true, recoveryInput));
    const callbacks = mockUseOrderHub.mock.calls.at(-1)?.[1];

    act(() =>
      callbacks.onSettlementGroupStateChanged(settlementDelta(orderId, "RejectedBeforeSubmission")),
    );
    act(() => {
      mockWalletState.mnemonic = "other mnemonic";
      mockWalletState.activeScope = "scope-b";
    });
    resolveStatus(ownedStatus(orderId));

    await waitFor(() => expect(useActivityLogStore.getState().items).toHaveLength(1));
    expect(useActivityLogStore.getState().items[0]?.walletId).toBe(walletId);
    expect(
      useActivityLogStore
        .getState()
        .items.filter((activity) => activity.walletId === otherWalletId),
    ).toEqual([]);
    expect(useNotificationsStore.getState().items).toEqual([]);
    expect(usePendingTradesStore.getState().byOrderId[orderId]?.walletId).toBe(walletId);
  });

  it("ignores a deferred status response during profile invalidation before the store switch", async () => {
    const orderId = "11111111-1111-4111-8111-111111111111";
    let resolveStatus!: (value: OrderStatusResponse) => void;
    mockFetchOrderStatus.mockReturnValueOnce(
      new Promise<OrderStatusResponse>((resolve) => {
        resolveStatus = resolve;
      }),
    );
    usePendingTradesStore.getState().add({
      orderId,
      walletId,
      clientOrderId: "client-order-1",
      marketId: "condition-YES",
      baseAsset: "sat",
      divisibility: 1_000,
      submittedAt: Date.now(),
    });
    renderHook(() => useOrderSettlementLifecycle(true, recoveryInput));
    const callbacks = mockUseOrderHub.mock.calls.at(-1)?.[1];

    act(() =>
      callbacks.onSettlementGroupStateChanged(settlementDelta(orderId, "RejectedBeforeSubmission")),
    );
    act(() => {
      // Handoff invalidates the module scope before the wallet store changes.
      mockWalletState.activeScope = null;
    });
    resolveStatus(ownedStatus(orderId));

    await waitFor(() => expect(useActivityLogStore.getState().items).toHaveLength(1));
    expect(useActivityLogStore.getState().items[0]?.walletId).toBe(walletId);
    expect(useNotificationsStore.getState().items).toEqual([]);
    expect(usePendingTradesStore.getState().byOrderId[orderId]?.walletId).toBe(walletId);
  });

  it("keeps the durable order when recovery completes after the active wallet changes", async () => {
    const orderId = "11111111-1111-4111-8111-111111111111";
    mockFetchOrderStatus.mockResolvedValue(ownedStatus(orderId));
    let finishRecovery!: (value: { recovered: number; pending: [] }) => void;
    mockRecover.mockReturnValueOnce(
      new Promise<{ recovered: number; pending: [] }>((resolve) => {
        finishRecovery = resolve;
      }),
    );
    usePendingTradesStore.getState().add({
      orderId,
      walletId,
      clientOrderId: "client-order-1",
      marketId: "condition-YES",
      baseAsset: "sat",
      divisibility: 1_000,
      submittedAt: Date.now(),
    });
    renderHook(() => useOrderSettlementLifecycle(true, recoveryInput));
    const callbacks = mockUseOrderHub.mock.calls.at(-1)?.[1];

    act(() => callbacks.onSettlementGroupStateChanged(settlementDelta(orderId, "Confirmed")));
    await waitFor(() => expect(mockRecover).toHaveBeenCalledOnce());
    act(() => {
      mockWalletState.mnemonic = "other mnemonic";
      mockWalletState.activeScope = "scope-b";
    });
    await act(async () => finishRecovery({ recovered: 1, pending: [] }));

    expect(usePendingTradesStore.getState().byOrderId[orderId]?.walletId).toBe(walletId);
  });

  it("retains the order while exact settlement recovery is pending", async () => {
    const orderId = "11111111-1111-4111-8111-111111111111";
    mockFetchOrderStatus.mockResolvedValue(ownedStatus(orderId));
    mockRecover.mockResolvedValue({
      recovered: 0,
      pending: [{ operationId: "operation-1", revision: 1, code: "recovery-pending" }],
    });
    usePendingTradesStore.getState().add({
      orderId,
      walletId,
      clientOrderId: "client-order-1",
      marketId: "condition-YES",
      baseAsset: "sat",
      divisibility: 1_000,
      submittedAt: Date.now(),
    });
    renderHook(() => useOrderSettlementLifecycle(true, recoveryInput));
    const callbacks = mockUseOrderHub.mock.calls.at(-1)?.[1];

    await act(async () => {});
    expect(mockRecover).toHaveBeenCalledOnce();
    await act(async () =>
      callbacks.onSettlementGroupStateChanged(settlementDelta(orderId, "Confirmed")),
    );

    expect(mockRecover).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(useActivityLogStore.getState().items).toHaveLength(1));
    expect(usePendingTradesStore.getState().byOrderId[orderId]).toBeDefined();
  });

  it("rechecks recovery immediately when confirmation arrives during an older recovery pass", async () => {
    vi.useFakeTimers();
    const orderId = "11111111-1111-4111-8111-111111111111";
    const startedAt = Date.now();
    mockFetchOrderStatus.mockResolvedValue(ownedStatus(orderId));
    let finishOlderRecovery!: (value: {
      recovered: number;
      pending: Array<{ operationId: string; revision: number; code: string }>;
    }) => void;
    mockRecover
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishOlderRecovery = resolve;
        }),
      )
      .mockResolvedValue({ recovered: 1, pending: [] });
    usePendingTradesStore.getState().add({
      orderId,
      walletId,
      clientOrderId: "client-order-1",
      marketId: "condition-YES",
      baseAsset: "sat",
      divisibility: 1_000,
      submittedAt: startedAt,
    });
    const { unmount } = renderHook(() => useOrderSettlementLifecycle(true, recoveryInput));
    try {
      await act(async () => {});
      expect(mockRecover).toHaveBeenCalledOnce();
      const callbacks = mockUseOrderHub.mock.calls.at(-1)?.[1];

      await act(async () => {
        callbacks.onSettlementGroupStateChanged(settlementDelta(orderId, "Confirmed"));
      });
      expect(mockFetchOrderStatus).toHaveBeenCalledTimes(2);
      expect(mockRecover).toHaveBeenCalledOnce();

      await act(async () => {
        finishOlderRecovery({
          recovered: 0,
          pending: [{ operationId: "operation-1", revision: 1, code: "recovery-pending" }],
        });
      });

      expect(Date.now()).toBe(startedAt);
      expect(mockRecover).toHaveBeenCalledTimes(2);
      expect(usePendingTradesStore.getState().byOrderId[orderId]).toBeUndefined();
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it.each(["pending", "failed"] as const)(
    "coalesces confirmation bursts after a %s pass and cancels stale fallback timers",
    async (firstResult) => {
      vi.useFakeTimers();
      const startedAt = Date.now();
      const first = recoveryBarrier();
      const followup = recoveryBarrier();
      const last = recoveryBarrier();
      let inFlight = 0;
      let maxInFlight = 0;
      for (const barrier of [first, followup, last]) {
        mockRecover.mockImplementationOnce(async () => {
          maxInFlight = Math.max(maxInFlight, ++inFlight);
          try {
            return await barrier.promise;
          } finally {
            inFlight -= 1;
          }
        });
      }
      const { orderId, unmount } = mountRecoveringOrder();
      try {
        await act(async () => {});
        const callbacks = mockUseOrderHub.mock.calls.at(-1)?.[1];
        for (let index = 0; index < 20; index += 1) {
          await act(async () =>
            callbacks.onSettlementGroupStateChanged(settlementDelta(orderId, "Confirmed")),
          );
        }
        expect(mockRecover).toHaveBeenCalledOnce();
        await act(async () => {
          if (firstResult === "pending") first.resolve(pendingRecovery);
          else first.reject(new Error("mint unavailable"));
        });
        expect(mockRecover).toHaveBeenCalledTimes(2);
        await act(async () => followup.reject(new Error("mint unavailable")));
        expect(Date.now()).toBe(startedAt);
        expect(usePendingTradesStore.getState().byOrderId[orderId]).toBeDefined();
        await act(async () => vi.advanceTimersByTimeAsync(14_999));
        expect(mockRecover).toHaveBeenCalledTimes(2);
        await act(async () =>
          callbacks.onSettlementGroupStateChanged(settlementDelta(orderId, "Confirmed")),
        );
        expect(mockRecover).toHaveBeenCalledTimes(3);
        await act(async () => last.resolve({ recovered: 1, pending: [] }));
        expect(usePendingTradesStore.getState().byOrderId[orderId]).toBeUndefined();
        await act(async () => vi.advanceTimersByTimeAsync(15_000));
        expect(mockRecover).toHaveBeenCalledTimes(3);
        expect(maxInFlight).toBe(1);
      } finally {
        unmount();
        vi.useRealTimers();
      }
    },
  );

  it("uses the fallback after an immediate follow-up fails without another wake", async () => {
    vi.useFakeTimers();
    const first = recoveryBarrier();
    mockRecover
      .mockReturnValueOnce(first.promise)
      .mockRejectedValueOnce(new Error("mint unavailable"))
      .mockResolvedValue({ recovered: 1, pending: [] });
    const { orderId, unmount } = mountRecoveringOrder();
    try {
      await act(async () => {});
      const callbacks = mockUseOrderHub.mock.calls.at(-1)?.[1];
      await act(async () =>
        callbacks.onSettlementGroupStateChanged(settlementDelta(orderId, "Confirmed")),
      );
      await act(async () => first.resolve(pendingRecovery));
      expect(mockRecover).toHaveBeenCalledTimes(2);
      expect(usePendingTradesStore.getState().byOrderId[orderId]).toBeDefined();
      await act(async () => vi.advanceTimersByTimeAsync(14_999));
      expect(mockRecover).toHaveBeenCalledTimes(2);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(mockRecover).toHaveBeenCalledTimes(3);
      expect(usePendingTradesStore.getState().byOrderId[orderId]).toBeUndefined();
      await act(async () => vi.advanceTimersByTimeAsync(15_000));
      expect(mockRecover).toHaveBeenCalledTimes(3);
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it.each(["dispose", "handoff", "remove"] as const)(
    "drops queued recovery after %s without deleting uncertain wallet work",
    async (action) => {
      vi.useFakeTimers();
      const first = recoveryBarrier();
      mockRecover.mockReturnValueOnce(first.promise);
      const { orderId, unmount } = mountRecoveringOrder();
      try {
        await act(async () => {});
        const callbacks = mockUseOrderHub.mock.calls.at(-1)?.[1];
        await act(async () =>
          callbacks.onSettlementGroupStateChanged(settlementDelta(orderId, "Confirmed")),
        );
        if (action === "dispose") unmount();
        if (action === "handoff") mockWalletState.activeScope = null;
        if (action === "remove")
          act(() => usePendingTradesStore.getState().remove(orderId, walletId));
        await act(async () => first.resolve(pendingRecovery));
        await act(async () => vi.advanceTimersByTimeAsync(15_000));
        expect(mockRecover).toHaveBeenCalledOnce();
        if (action !== "remove")
          expect(usePendingTradesStore.getState().byOrderId[orderId]).toBeDefined();
      } finally {
        unmount();
        vi.useRealTimers();
      }
    },
  );

  it("does not start recovery from a status response that arrives after disposal", async () => {
    const status = deferredStatus();
    mockFetchOrderStatus.mockReturnValueOnce(status.promise);
    const { orderId, unmount } = mountRecoveringOrder(false);
    await act(async () => {});
    unmount();
    await act(async () => status.resolve(ownedStatus(orderId)));
    expect(mockRecover).not.toHaveBeenCalled();
    expect(usePendingTradesStore.getState().byOrderId[orderId]).toBeDefined();
  });

  it("recovers once after StrictMode effect cleanup while an authenticated read is pending", async () => {
    const status = deferredStatus();
    mockFetchOrderStatus.mockReturnValueOnce(status.promise);
    const { orderId, unmount } = mountRecoveringOrder(false, true);
    mockFetchOrderStatus.mockResolvedValue(ownedStatus(orderId));
    try {
      await act(async () => status.resolve(ownedStatus(orderId)));
      expect(mockRecover).toHaveBeenCalledOnce();
      expect(usePendingTradesStore.getState().byOrderId[orderId]).toBeUndefined();
    } finally {
      unmount();
    }
  });

  it("rejoins retained orders after reconnect", async () => {
    usePendingTradesStore.getState().add({
      orderId: "11111111-1111-4111-8111-111111111111",
      walletId,
      clientOrderId: "client-order-1",
      marketId: "condition-YES",
      baseAsset: "sat",
      divisibility: 1_000,
      submittedAt: Date.now(),
    });
    renderHook(() => useOrderSettlementLifecycle(true, recoveryInput));
    await waitFor(() => expect(mockJoinOrder).toHaveBeenCalledOnce());
    const callbacks = mockUseOrderHub.mock.calls.at(-1)?.[1];

    act(() => callbacks.onReconnected());

    await waitFor(() => expect(mockJoinOrder).toHaveBeenCalledTimes(2));
  });

  it("uses an exact owner status response before clearing a terminal order", async () => {
    const orderId = "11111111-1111-4111-8111-111111111111";
    mockFetchOrderStatus
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(legacyStatus(orderId, "condition-YES", { status: "cancelled" }));
    usePendingTradesStore.getState().add({
      orderId,
      walletId,
      clientOrderId: "client-order-1",
      marketId: "condition-YES",
      baseAsset: "sat",
      divisibility: 1_000,
      amountSubunits: 10,
      submittedAt: Date.now(),
    });
    renderHook(() => useOrderSettlementLifecycle(true, recoveryInput));
    await waitFor(() => expect(mockFetchOrderStatus).toHaveBeenCalledOnce());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const callbacks = mockUseOrderHub.mock.calls.at(-1)?.[1];

    act(() =>
      callbacks.onOrderLifecycleChanged({
        orderId,
        marketId: "condition-YES",
        status: "cancelled",
        remainingAmountSubunits: 10,
        baseAsset: "sat",
        collateralUnit: "msat",
        divisibility: 1_000,
        activeSettlementGroup: null,
      }),
    );

    await waitFor(() => expect(mockFetchOrderStatus).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(usePendingTradesStore.getState().byOrderId[orderId]).toBeUndefined(),
    );
    expect(useNotificationsStore.getState().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: `${orderId}-cancelled`, kind: "cancelled" }),
      ]),
    );
  });

  it("coalesces portfolio invalidation for confirmed owner updates", async () => {
    const invalidate = vi.fn();
    const stop = listenForPortfolioInvalidation(invalidate);
    try {
      for (const orderId of ["order-a", "order-b"]) {
        usePendingTradesStore.getState().add({
          orderId,
          walletId,
          clientOrderId: `client-${orderId}`,
          marketId: "condition-YES",
          baseAsset: "sat",
          divisibility: 1_000,
          submittedAt: Date.now(),
        });
      }
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

  it("retries confirmed-fill recovery after an in-flight status read fails", async () => {
    const orderId = "11111111-1111-4111-8111-111111111111";
    let rejectStatus!: (reason: Error) => void;
    mockFetchOrderStatus
      .mockReturnValueOnce(
        new Promise<OrderStatusResponse | null>((_resolve, reject) => {
          rejectStatus = reject;
        }),
      )
      .mockResolvedValueOnce(ownedStatus(orderId));
    usePendingTradesStore.getState().add({
      orderId,
      walletId,
      clientOrderId: "client-order-1",
      marketId: "condition-YES",
      baseAsset: "sat",
      divisibility: 1_000,
      submittedAt: Date.now(),
    });
    renderHook(() => useOrderSettlementLifecycle(true, recoveryInput));
    const callbacks = mockUseOrderHub.mock.calls.at(-1)?.[1];

    act(() => callbacks.onSettlementGroupStateChanged(settlementDelta(orderId, "Confirmed")));

    await waitFor(() => expect(mockFetchOrderStatus).toHaveBeenCalledOnce());
    rejectStatus(new Error("temporary read failure"));
    await waitFor(() => expect(mockFetchOrderStatus).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(useActivityLogStore.getState().items).toHaveLength(1));
    await waitFor(() => expect(mockRecover).toHaveBeenCalledOnce());
  });
});

const pendingRecovery = {
  recovered: 0,
  pending: [{ operationId: "operation-1", revision: 1, code: "recovery-pending" }],
};

function recoveryBarrier() {
  let resolve!: (value: typeof pendingRecovery) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<typeof pendingRecovery>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function deferredStatus() {
  let resolve!: (value: OrderStatusResponse) => void;
  const promise = new Promise<OrderStatusResponse>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function mountRecoveringOrder(setStatus = true, strict = false) {
  const orderId = "11111111-1111-4111-8111-111111111111";
  if (setStatus) mockFetchOrderStatus.mockResolvedValue(ownedStatus(orderId));
  usePendingTradesStore.getState().add({
    orderId,
    walletId,
    clientOrderId: "client-order-1",
    marketId: "condition-YES",
    baseAsset: "sat",
    divisibility: 1_000,
    submittedAt: Date.now(),
  });
  const { unmount } = renderHook(
    () => useOrderSettlementLifecycle(true, recoveryInput),
    strict
      ? { wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode> }
      : undefined,
  );
  return { orderId, unmount };
}
