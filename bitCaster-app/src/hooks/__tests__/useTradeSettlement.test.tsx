import { renderHook, act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useActiveSwapsStore } from "@/stores/activeSwaps";
import { usePendingTradesStore } from "@/stores/pendingTrades";
import { usePendingPubkeySubmissionsStore } from "@/stores/pendingPubkeySubmissions";
import { usePartialLockFailuresStore } from "@/stores/partialLockFailures";
import { useToastStore } from "@/stores/toast";

const { mockUseTradeHub, mockJoinOrder, mockJoinTrade, mockSendSwapMessage } =
  vi.hoisted(() => ({
    mockUseTradeHub: vi.fn(),
    mockJoinOrder: vi.fn(),
    mockJoinTrade: vi.fn(),
    mockSendSwapMessage: vi.fn(),
  }));

const { mockFetchOrderStatus } = vi.hoisted(() => ({
  mockFetchOrderStatus: vi.fn(),
}));

const {
  mockAddProofs,
  mockGetUnitProofs,
  mockGetOutcomeProofs,
  mockGetProofOperation,
  mockGetReservedProofs,
  mockMarkProofOperationCompleted,
  mockPrepareProofOperation,
  mockReleaseProofReservationsBySecret,
  mockRemoveProofs,
  mockReplaceProofs,
  mockReserveProofs,
} = vi.hoisted(() => ({
  mockAddProofs: vi.fn(),
  mockGetUnitProofs: vi.fn(),
  mockGetOutcomeProofs: vi.fn(),
  mockGetProofOperation: vi.fn(),
  mockGetReservedProofs: vi.fn(),
  mockMarkProofOperationCompleted: vi.fn(),
  mockPrepareProofOperation: vi.fn(),
  mockReleaseProofReservationsBySecret: vi.fn(),
  mockRemoveProofs: vi.fn(),
  mockReplaceProofs: vi.fn(),
  mockReserveProofs: vi.fn(),
}));

const {
  mockBuyerPrepareSwap,
  mockSellerLockOutcomeProofs,
  mockSellerPreparePrelockedSwap,
  mockSplitProofsForExactSend,
} = vi.hoisted(() => ({
  mockBuyerPrepareSwap: vi.fn(),
  mockSellerLockOutcomeProofs: vi.fn(),
  mockSellerPreparePrelockedSwap: vi.fn(),
  mockSplitProofsForExactSend: vi.fn(),
}));

vi.mock("@/hooks/useTradeHub", () => ({
  useTradeHub: mockUseTradeHub,
}));

vi.mock("@/stores/proof-db", () => ({
  addProofs: mockAddProofs,
  getUnitProofs: mockGetUnitProofs,
  getOutcomeProofs: mockGetOutcomeProofs,
  getProofOperation: mockGetProofOperation,
  getReservedProofs: mockGetReservedProofs,
  markProofOperationCompleted: mockMarkProofOperationCompleted,
  prepareProofOperation: mockPrepareProofOperation,
  releaseProofReservationsBySecret: mockReleaseProofReservationsBySecret,
  removeProofs: mockRemoveProofs,
  replaceProofs: mockReplaceProofs,
  reserveProofs: mockReserveProofs,
}));

vi.mock("@/lib/orderStatus", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/orderStatus")>();
  return {
    ...actual,
    fetchOrderStatus: mockFetchOrderStatus,
  };
});

vi.mock("@bitcaster/swap-protocol/atomicSwap", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@bitcaster/swap-protocol/atomicSwap")
    >();
  return {
    ...actual,
    buyerPrepareSwap: mockBuyerPrepareSwap,
    sellerLockOutcomeProofs: mockSellerLockOutcomeProofs,
    sellerPreparePrelockedSwap: mockSellerPreparePrelockedSwap,
    splitProofsForExactSend: mockSplitProofsForExactSend,
  };
});

vi.mock("@/stores/wallet", () => ({
  useWalletStore: (selector: (state: { activeMintUrl: string }) => unknown) =>
    selector({ activeMintUrl: "https://mint.example" }),
}));

const { useTradeSettlement, persistPartialLockFromError } =
  await import("../useTradeSettlement");

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  useActiveSwapsStore.setState({ byTradeId: {} });
  usePendingTradesStore.setState({ byOrderId: {} });
  usePendingPubkeySubmissionsStore.setState({ byTradeId: {} });
  usePartialLockFailuresStore.setState({ byTradeId: {} });
  useToastStore.setState({ toasts: [] });
  mockJoinOrder.mockResolvedValue(undefined);
  mockJoinTrade.mockResolvedValue(undefined);
  mockSendSwapMessage.mockResolvedValue(undefined);
  mockAddProofs.mockResolvedValue(undefined);
  mockGetUnitProofs.mockResolvedValue([]);
  mockGetOutcomeProofs.mockResolvedValue([]);
  mockGetProofOperation.mockResolvedValue(null);
  mockGetReservedProofs.mockResolvedValue([]);
  mockMarkProofOperationCompleted.mockResolvedValue({});
  mockPrepareProofOperation.mockResolvedValue({});
  mockReleaseProofReservationsBySecret.mockResolvedValue(undefined);
  mockRemoveProofs.mockResolvedValue(undefined);
  mockReplaceProofs.mockResolvedValue(undefined);
  mockReserveProofs.mockResolvedValue(undefined);
  mockBuyerPrepareSwap.mockResolvedValue({
    lockedProofsCipher: "cipher-buyer",
    lockedProofs: [proof(50, "buyer-locked-50", "base-keyset")],
    changeProofs: [proof(36, "buyer-change-36", "base-keyset")],
    preSigsHex: ["pre-buyer"],
    sellerPreSigsHex: ["pre-seller"],
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async () => {
      const body = {
        keysets: [
          keyset("keyset-YES", "cond", "YES"),
          keyset("keyset-NO", "cond", "NO"),
          keyset("keyset-B", "condition-1", "B"),
          keyset("keyset-C", "condition-1", "C"),
        ],
      };
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    }),
  );
  mockSellerPreparePrelockedSwap.mockResolvedValue({
    adaptorPointCipher: "cipher-adaptor",
    lockedProofsCipher: "cipher-seller",
    adaptorPoint: { point: new Uint8Array([1]), secret: new Uint8Array([2]) },
    lockedProofs: [],
    changeProofs: [],
  });
  mockSellerLockOutcomeProofs.mockImplementation(
    async (_ctx, proofs, amountSats) => {
      const total = proofs.reduce(
        (sum: number, candidate: { amount: unknown }) =>
          sum + Number(candidate.amount),
        0,
      );
      const prefix = proofs[0].secret.includes("lock") ? "lock" : "inventory";
      return {
        lockedProofs: [proof(amountSats, `${prefix}-locked-100`, proofs[0].id)],
        changeProofs:
          total > amountSats
            ? [
                {
                  ...proof(total - amountSats, `${prefix}-change-36`),
                  id: proofs[0].id,
                },
              ]
            : [],
      };
    },
  );
  mockSplitProofsForExactSend.mockImplementation(async (params) => {
    const source = params.sourceProofs[0];
    const prefix = source.secret.includes("lock") ? "lock" : "keep";
    return {
      sendProofs: [proof(100, `${prefix}-exact-100`, source.id)],
      changeProofs: [{ ...proof(36, `${prefix}-change-36`), id: source.id }],
      spentProofs: params.sourceProofs,
    };
  });
  mockFetchOrderStatus.mockResolvedValue({
    orderId: "order-pending",
    marketId: "cond-YES",
    status: "resting",
    remainingAmountSubunits: 100,
    filledAmountSubunits: 0,
    fills: [],
  });
  mockUseTradeHub.mockReturnValue({
    joinOrder: mockJoinOrder,
    joinTrade: mockJoinTrade,
    sendSwapMessage: mockSendSwapMessage,
    connectionState: vi.fn(),
  });
});

function seedPendingPubkey(
  tradeId: string,
  orderId = "order-pending",
  marketId = "cond-YES",
  pubkey = "02" + "22".repeat(32),
) {
  usePendingPubkeySubmissionsStore.getState().addPendingPubkey({
    tradeId,
    orderId,
    marketId,
    pubkey,
    privkey: "11".repeat(32),
    deadline: new Date(Date.now() + 60_000).toISOString(),
    submitted: true,
  });
}

describe("useTradeSettlement", () => {
  it("does not start the private TradeHub when no swap is active", () => {
    renderHook(() => useTradeSettlement(true));

    expect(mockUseTradeHub).toHaveBeenCalledWith(false, expect.any(Object));
    expect(mockJoinOrder).not.toHaveBeenCalled();
    expect(mockJoinTrade).not.toHaveBeenCalled();
  });

  it("connects and joins only after an active swap is promoted", async () => {
    renderHook(() => useTradeSettlement(true));

    await act(async () => {
      useActiveSwapsStore.getState().promote({
        tradeId: "trade-1",
        orderId: "order-1",
        marketId: "market-1",
        ephemeralPrivkeyHex: "11".repeat(32),
        ephemeralPubkeyHex: "22".repeat(32),
      });
    });

    expect(mockUseTradeHub).toHaveBeenLastCalledWith(true, expect.any(Object));
    expect(mockJoinTrade).toHaveBeenCalledWith("trade-1");
  });

  it("retries active swap trade joins while the trade state is not ready", async () => {
    vi.useFakeTimers();
    mockJoinTrade
      .mockRejectedValueOnce(new Error("Not authorised to join this trade"))
      .mockResolvedValue(undefined);

    useActiveSwapsStore.getState().promote({
      tradeId: "trade-retry-active",
      orderId: "order-1",
      marketId: "market-1",
      ephemeralPrivkeyHex: "11".repeat(32),
      ephemeralPubkeyHex: "22".repeat(32),
    });
    renderHook(() => useTradeSettlement(true));
    await act(async () => {});

    expect(mockJoinTrade).toHaveBeenCalledTimes(1);
    expect(
      useActiveSwapsStore.getState().byTradeId["trade-retry-active"].step,
    ).toBe("awaiting-trade-created");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(mockJoinTrade).toHaveBeenCalledTimes(2);
    expect(mockJoinTrade).toHaveBeenLastCalledWith("trade-retry-active");
    expect(
      useActiveSwapsStore.getState().byTradeId["trade-retry-active"].step,
    ).toBe("awaiting-trade-created");
  });

  it("joins pending order groups so resting makers can receive TradeCreated", async () => {
    usePendingTradesStore.getState().add({
      orderId: "order-pending",
      marketId: "cond-YES",
      clientOrderId: "client-order-pending",
      side: "Buy",
      tokenSide: "Outcome",
      divisibility: 2_000,
      priceSubunits: 500,
      amountSubunits: 2_000,
      submittedAt: Date.now(),
    });

    renderHook(() => useTradeSettlement(true));

    await waitFor(() =>
      expect(mockJoinOrder).toHaveBeenCalledWith("cond-YES", "order-pending"),
    );
  });

  it("replays pending order joins during status recovery", async () => {
    vi.useFakeTimers();
    usePendingTradesStore.getState().add({
      orderId: "order-pending",
      marketId: "cond-YES",
      clientOrderId: "client-order-pending",
      submittedAt: Date.now(),
    });
    seedPendingPubkey("trade-status-retry");
    seedPendingPubkey("trade-status-retry");

    renderHook(() => useTradeSettlement(true));

    await act(async () => {});
    expect(mockJoinOrder).toHaveBeenCalledWith("cond-YES", "order-pending");
    expect(mockJoinOrder).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(mockJoinOrder).toHaveBeenCalledTimes(2);
    expect(mockJoinOrder).toHaveBeenLastCalledWith("cond-YES", "order-pending");
  });

  it("retries order-status recovered trade joins after transient hub authorization lag", async () => {
    vi.useFakeTimers();
    mockFetchOrderStatus.mockResolvedValue({
      orderId: "order-pending",
      marketId: "cond-YES",
      status: "Matched",
      remainingAmountSubunits: 0,
      filledAmountSubunits: 100,
      fills: [{ tradeId: "trade-status-retry" }],
    });
    mockJoinTrade
      .mockRejectedValueOnce(new Error("Not authorised to join this trade"))
      .mockResolvedValue(undefined);
    usePendingTradesStore.getState().add({
      orderId: "order-pending",
      marketId: "cond-YES",
      clientOrderId: "client-order-pending",
      submittedAt: Date.now(),
    });
    seedPendingPubkey("trade-status-retry");

    renderHook(() => useTradeSettlement(true));

    await act(async () => {});
    expect(mockJoinOrder).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(mockJoinTrade).toHaveBeenCalled();
    expect(
      useActiveSwapsStore.getState().byTradeId["trade-status-retry"].step,
    ).toBe("awaiting-trade-created");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(mockJoinTrade.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockJoinTrade).toHaveBeenLastCalledWith("trade-status-retry");
  });

  it("retries pending order group joins after a transient hub failure", async () => {
    vi.useFakeTimers();
    mockJoinOrder
      .mockRejectedValueOnce(new Error("projection lag"))
      .mockResolvedValue(undefined);
    usePendingTradesStore.getState().add({
      orderId: "order-pending",
      marketId: "cond-YES",
      clientOrderId: "client-order-pending",
      submittedAt: Date.now(),
    });

    renderHook(() => useTradeSettlement(true));

    await act(async () => {});
    expect(mockJoinOrder).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(mockJoinOrder).toHaveBeenCalledTimes(2);
    expect(mockJoinOrder).toHaveBeenLastCalledWith("cond-YES", "order-pending");
  });

  it("joins pending order groups while order status projection is lagging", async () => {
    vi.useFakeTimers();
    mockFetchOrderStatus.mockResolvedValueOnce(null).mockResolvedValue({
      orderId: "order-pending",
      marketId: "cond-YES",
      status: "resting",
      remainingAmountSubunits: 100,
      filledAmountSubunits: 0,
      fills: [],
    });
    usePendingTradesStore.getState().add({
      orderId: "order-pending",
      marketId: "cond-YES",
      clientOrderId: "client-order-pending",
      submittedAt: Date.now(),
    });

    renderHook(() => useTradeSettlement(true));

    await act(async () => {});
    expect(mockJoinOrder).toHaveBeenCalledWith("cond-YES", "order-pending");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(mockJoinOrder).toHaveBeenCalledWith("cond-YES", "order-pending");
  });

  it("promotes an unsolicited TradeCreated event for a pending mint order", async () => {
    usePendingTradesStore.getState().add({
      orderId: "order-pending",
      marketId: "cond-NO",
      clientOrderId: "client-order-pending",
      side: "Buy",
      tokenSide: "Outcome",
      priceSubunits: 500,
      amountSubunits: 1_000_000,
      submittedAt: Date.now(),
    });

    renderHook(() => useTradeSettlement(true));

    expect(mockUseTradeHub).toHaveBeenLastCalledWith(true, expect.any(Object));
    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onTradeCreated: (payload: {
        tradeId: string;
        sellerPubkey: string;
        buyerPubkey: string;
        sellerLocktime: string;
        buyerLocktime: string;
        marketId?: string;
        settlementKind?: string;
        sellerKeepOutcomeSetId?: string;
        sellerLockOutcomeSetId?: string;
        outcomeFaceAmountSubunits?: number;
        quotePaymentSubunits?: number;
        baseAsset?: string;
        divisibility?: number;
      }) => void;
    };

    await act(async () => {
      seedPendingPubkey("trade-pending");
      callbacks.onTradeCreated({
        tradeId: "trade-pending",
        sellerPubkey: "02" + "33".repeat(32),
        buyerPubkey: "02" + "22".repeat(32),
        sellerLocktime: "2026-05-07T12:01:00Z",
        buyerLocktime: "2026-05-07T12:00:00Z",
        marketId: "cond-NO",
        settlementKind: "Mint",
        sellerKeepOutcomeSetId: "YES",
        sellerLockOutcomeSetId: "NO",
        outcomeFaceAmountSubunits: 1_000_000,
        quotePaymentSubunits: 500_000,
        baseAsset: "sat",
        divisibility: 1_000,

      });
    });

    await waitFor(() =>
      expect(mockJoinTrade).toHaveBeenCalledWith("trade-pending"),
    );
    const swap = useActiveSwapsStore.getState().byTradeId["trade-pending"];
    expect(swap.orderId).toBe("order-pending");
    expect(swap.marketId).toBe("cond-NO");
    expect(swap.role).toBe("buyer");
    expect(swap.outcomeFaceAmountSubunits).toBe(1_000_000);
    expect(swap.quotePaymentSubunits).toBe(500_000);
    expect(swap.baseAsset).toBe("sat");
    expect(swap.divisibility).toBe(1_000);
    expect(swap.quotePaymentSubunits).toBe(500_000);
  });

  it("fails before locking proofs when TradeCreated unit metadata mismatches the local order", async () => {
    usePendingTradesStore.getState().add({
      orderId: "order-usd",
      marketId: "cond-NO",
      clientOrderId: "client-order-pending",
      baseAsset: "usd",
      divisibility: 2_000,
      side: "Buy",
      tokenSide: "Outcome",
      priceSubunits: 1_000,
      amountSubunits: 2_000,
      submittedAt: Date.now(),
    });

    renderHook(() => useTradeSettlement(true));

    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onTradeCreated: (payload: {
        tradeId: string;
        sellerPubkey: string;
        buyerPubkey: string;
        sellerLocktime: string;
        buyerLocktime: string;
        marketId?: string;
        settlementKind?: string;
        sellerKeepOutcomeSetId?: string;
        sellerLockOutcomeSetId?: string;
        outcomeFaceAmountSubunits?: number;
        quotePaymentSubunits?: number;
        baseAsset?: string;
        divisibility?: number;
      }) => void;
    };

    await act(async () => {
      seedPendingPubkey("trade-unit-mismatch");
      callbacks.onTradeCreated({
        tradeId: "trade-unit-mismatch",
        sellerPubkey: "02" + "33".repeat(32),
        buyerPubkey: "02" + "22".repeat(32),
        sellerLocktime: "2026-05-07T12:01:00Z",
        buyerLocktime: "2026-05-07T12:00:00Z",
        marketId: "cond-NO",
        settlementKind: "Mint",
        sellerKeepOutcomeSetId: "YES",
        sellerLockOutcomeSetId: "NO",
        outcomeFaceAmountSubunits: 1_000_000,
        quotePaymentSubunits: 500_000,
        baseAsset: "sat",
        divisibility: 1_000,
      });
    });

    await waitFor(() =>
      expect(
        useActiveSwapsStore.getState().byTradeId["trade-unit-mismatch"]?.step,
      ).toBe("Failed"),
    );
    expect(
      useActiveSwapsStore.getState().byTradeId["trade-unit-mismatch"]?.error,
    ).toContain("Trade unit mismatch");
    expect(mockSendSwapMessage).not.toHaveBeenCalled();
    expect(mockSellerLockOutcomeProofs).not.toHaveBeenCalled();
    expect(mockBuyerPrepareSwap).not.toHaveBeenCalled();
  });

  it("fails before locking proofs when TradeCreated violates local order economics", async () => {
    usePendingTradesStore.getState().add({
      orderId: "order-price-mismatch",
      marketId: "cond-YES",
      clientOrderId: "client-order-pending",
      baseAsset: "sat",
      divisibility: 10_000,
      side: "Sell",
      tokenSide: "Outcome",
      priceSubunits: 400,
      amountSubunits: 1_000_000,
      submittedAt: Date.now(),
    });

    renderHook(() => useTradeSettlement(true));

    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onTradeCreated: (payload: {
        tradeId: string;
        sellerPubkey: string;
        buyerPubkey: string;
        sellerLocktime: string;
        buyerLocktime: string;
        marketId?: string;
        settlementKind?: string;
        outcomeFaceAmountSubunits?: number;
        quotePaymentSubunits?: number;
        baseAsset?: string;
        divisibility?: number;
      }) => void;
    };

    await act(async () => {
      seedPendingPubkey("trade-price-mismatch");
      callbacks.onTradeCreated({
        tradeId: "trade-price-mismatch",
        sellerPubkey: "02" + "22".repeat(32),
        buyerPubkey: "02" + "33".repeat(32),
        sellerLocktime: "2026-05-07T12:01:00Z",
        buyerLocktime: "2026-05-07T12:00:00Z",
        marketId: "cond-YES",
        settlementKind: "DirectSwap",
        outcomeFaceAmountSubunits: 1_000_000,
        quotePaymentSubunits: 30_000,
        baseAsset: "sat",
        divisibility: 10_000,
      });
    });

    await waitFor(() =>
      expect(
        useActiveSwapsStore.getState().byTradeId["trade-price-mismatch"]?.step,
      ).toBe("Failed"),
    );
    expect(
      useActiveSwapsStore.getState().byTradeId["trade-price-mismatch"]?.error,
    ).toContain("does not satisfy the submitted order price");
    expect(mockJoinTrade).not.toHaveBeenCalled();
    expect(mockSendSwapMessage).not.toHaveBeenCalled();
    expect(mockSellerLockOutcomeProofs).not.toHaveBeenCalled();
    expect(mockBuyerPrepareSwap).not.toHaveBeenCalled();
  });

  it("fails before joining when a legacy pending trade lacks order economics", async () => {
    usePendingTradesStore.getState().add({
      orderId: "order-legacy-no-economics",
      marketId: "cond-YES",
      clientOrderId: "client-order-pending",
      baseAsset: "sat",
      divisibility: 10_000,
      submittedAt: Date.now(),
    });

    renderHook(() => useTradeSettlement(true));

    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onTradeCreated: (payload: {
        tradeId: string;
        sellerPubkey: string;
        buyerPubkey: string;
        sellerLocktime: string;
        buyerLocktime: string;
        marketId?: string;
        settlementKind?: string;
        outcomeFaceAmountSubunits?: number;
        quotePaymentSubunits?: number;
        baseAsset?: string;
        divisibility?: number;
      }) => void;
    };

    await act(async () => {
      seedPendingPubkey("trade-legacy-no-economics");
      callbacks.onTradeCreated({
        tradeId: "trade-legacy-no-economics",
        sellerPubkey: "02" + "22".repeat(32),
        buyerPubkey: "02" + "33".repeat(32),
        sellerLocktime: "2026-05-07T12:01:00Z",
        buyerLocktime: "2026-05-07T12:00:00Z",
        marketId: "cond-YES",
        settlementKind: "DirectSwap",
        outcomeFaceAmountSubunits: 10_000,
        quotePaymentSubunits: 5_000,
        baseAsset: "sat",
        divisibility: 10_000,
      });
    });

    await waitFor(() =>
      expect(
        useActiveSwapsStore.getState().byTradeId["trade-legacy-no-economics"]?.step,
      ).toBe("Failed"),
    );
    expect(
      useActiveSwapsStore.getState().byTradeId["trade-legacy-no-economics"]?.error,
    ).toContain("Expected order economics are missing");
    expect(mockJoinTrade).not.toHaveBeenCalled();
    expect(mockSellerLockOutcomeProofs).not.toHaveBeenCalled();
    expect(mockBuyerPrepareSwap).not.toHaveBeenCalled();
  });

  it("fails before locking proofs when non-default TradeCreated is missing canonical settlement amounts", async () => {
    usePendingTradesStore.getState().add({
      orderId: "order-usd-canonical",
      marketId: "cond-NO",
      clientOrderId: "client-order-pending",
      baseAsset: "usd",
      divisibility: 2_000,
      side: "Buy",
      tokenSide: "Outcome",
      priceSubunits: 500,
      amountSubunits: 2_000,
      submittedAt: Date.now(),
    });

    renderHook(() => useTradeSettlement(true));

    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onTradeCreated: (payload: {
        tradeId: string;
        sellerPubkey: string;
        buyerPubkey: string;
        sellerLocktime: string;
        buyerLocktime: string;
        marketId?: string;
        settlementKind?: string;
        sellerKeepOutcomeSetId?: string;
        sellerLockOutcomeSetId?: string;
        outcomeFaceAmountSubunits?: number;
        quotePaymentSubunits?: number;
        baseAsset?: string;
        divisibility?: number;
      }) => void;
    };

    await act(async () => {
      seedPendingPubkey("trade-missing-canonical");
      callbacks.onTradeCreated({
        tradeId: "trade-missing-canonical",
        sellerPubkey: "02" + "33".repeat(32),
        buyerPubkey: "02" + "22".repeat(32),
        sellerLocktime: "2026-05-07T12:01:00Z",
        buyerLocktime: "2026-05-07T12:00:00Z",
        marketId: "cond-NO",
        settlementKind: "Mint",
        sellerKeepOutcomeSetId: "YES",
        sellerLockOutcomeSetId: "NO",
        baseAsset: "usd",
        divisibility: 2_000,
      });
    });

    await waitFor(() =>
      expect(
        useActiveSwapsStore.getState().byTradeId["trade-missing-canonical"]?.step,
      ).toBe("Failed"),
    );
    expect(
      useActiveSwapsStore.getState().byTradeId["trade-missing-canonical"]?.error,
    ).toContain("missing outcome face subunits");
    expect(mockJoinTrade).not.toHaveBeenCalled();
    expect(mockSendSwapMessage).not.toHaveBeenCalled();
    expect(mockSellerLockOutcomeProofs).not.toHaveBeenCalled();
    expect(mockBuyerPrepareSwap).not.toHaveBeenCalled();
  });

  it("uses canonical non-default settlement amounts without legacy sats fields", async () => {
    usePendingTradesStore.getState().add({
      orderId: "order-usd-canonical-only",
      marketId: "cond-NO",
      clientOrderId: "client-order-pending",
      baseAsset: "usd",
      divisibility: 1_000,
      side: "Buy",
      tokenSide: "Outcome",
      priceSubunits: 400,
      amountSubunits: 1_000_000,
      submittedAt: Date.now(),
    });

    renderHook(() => useTradeSettlement(true));

    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onTradeCreated: (payload: {
        tradeId: string;
        sellerPubkey: string;
        buyerPubkey: string;
        sellerLocktime: string;
        buyerLocktime: string;
        marketId?: string;
        settlementKind?: string;
        sellerKeepOutcomeSetId?: string;
        sellerLockOutcomeSetId?: string;
        outcomeFaceAmountSubunits?: number;
        quotePaymentSubunits?: number;
        baseAsset?: string;
        divisibility?: number;
      }) => void;
    };

    await act(async () => {
      seedPendingPubkey("trade-canonical-only");
      callbacks.onTradeCreated({
        tradeId: "trade-canonical-only",
        sellerPubkey: "02" + "33".repeat(32),
        buyerPubkey: "02" + "22".repeat(32),
        sellerLocktime: "2026-05-07T12:01:00Z",
        buyerLocktime: "2026-05-07T12:00:00Z",
        marketId: "cond-NO",
        settlementKind: "Mint",
        sellerKeepOutcomeSetId: "YES",
        sellerLockOutcomeSetId: "NO",
        baseAsset: "usd",
        divisibility: 1_000,
        outcomeFaceAmountSubunits: 100_000,
        quotePaymentSubunits: 40_000,
      });
    });

    await waitFor(() =>
      expect(mockJoinTrade).toHaveBeenCalledWith("trade-canonical-only"),
    );
    const swap = useActiveSwapsStore.getState().byTradeId["trade-canonical-only"];
    expect(swap.role).toBe("buyer");
    expect(swap.outcomeFaceAmountSubunits).toBe(100_000);
    expect(swap.quotePaymentSubunits).toBe(40_000);
    expect(mockSendSwapMessage).not.toHaveBeenCalled();
  });

  it("fails before locking proofs when non-default divisibility is missing the local expected unit", async () => {
    usePendingTradesStore.getState().add({
      orderId: "order-nondefault-divisibility-no-unit",
      marketId: "cond-NO",
      clientOrderId: "client-order-pending",
      side: "Buy",
      tokenSide: "Outcome",
      priceSubunits: 500,
      amountSubunits: 1_000_000,
      submittedAt: Date.now(),
    });

    renderHook(() => useTradeSettlement(true));

    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onTradeCreated: (payload: {
        tradeId: string;
        sellerPubkey: string;
        buyerPubkey: string;
        sellerLocktime: string;
        buyerLocktime: string;
        marketId?: string;
        settlementKind?: string;
        sellerKeepOutcomeSetId?: string;
        sellerLockOutcomeSetId?: string;
        baseAsset?: string;
        divisibility?: number;
        outcomeFaceAmountSubunits?: number;
        quotePaymentSubunits?: number;
      }) => void;
    };

    await act(async () => {
      seedPendingPubkey("trade-nondefault-divisibility-no-unit");
      callbacks.onTradeCreated({
        tradeId: "trade-nondefault-divisibility-no-unit",
        sellerPubkey: "02" + "33".repeat(32),
        buyerPubkey: "02" + "22".repeat(32),
        sellerLocktime: "2026-05-07T12:01:00Z",
        buyerLocktime: "2026-05-07T12:00:00Z",
        marketId: "cond-NO",
        settlementKind: "Mint",
        sellerKeepOutcomeSetId: "YES",
        sellerLockOutcomeSetId: "NO",
        baseAsset: "sat",
        divisibility: 2_000,
        outcomeFaceAmountSubunits: 2_000,
        quotePaymentSubunits: 1_000_000,
      });
    });

    await waitFor(() =>
      expect(
        useActiveSwapsStore.getState().byTradeId[
          "trade-nondefault-divisibility-no-unit"
        ]?.step,
      ).toBe("Failed"),
    );
    expect(
      useActiveSwapsStore.getState().byTradeId[
        "trade-nondefault-divisibility-no-unit"
      ]?.error,
    ).toContain("non-default unit but the local expected unit is missing");
    expect(mockJoinTrade).not.toHaveBeenCalled();
    expect(mockSendSwapMessage).not.toHaveBeenCalled();
    expect(mockSellerLockOutcomeProofs).not.toHaveBeenCalled();
    expect(mockBuyerPrepareSwap).not.toHaveBeenCalled();
  });

  it("accepts non-default divisibility when the local expected unit is asserted", async () => {
    usePendingTradesStore.getState().add({
      orderId: "order-nondefault-divisibility-expected",
      marketId: "cond-NO",
      clientOrderId: "client-order-pending",
      baseAsset: "sat",
      divisibility: 2_000,
      side: "Buy",
      tokenSide: "Outcome",
      priceSubunits: 1_000,
      amountSubunits: 1_000_000,
      submittedAt: Date.now(),
    });

    renderHook(() => useTradeSettlement(true));

    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onTradeCreated: (payload: {
        tradeId: string;
        sellerPubkey: string;
        buyerPubkey: string;
        sellerLocktime: string;
        buyerLocktime: string;
        marketId?: string;
        settlementKind?: string;
        sellerKeepOutcomeSetId?: string;
        sellerLockOutcomeSetId?: string;
        baseAsset?: string;
        divisibility?: number;
        outcomeFaceAmountSubunits?: number;
        quotePaymentSubunits?: number;
      }) => void;
    };

    await act(async () => {
      seedPendingPubkey("trade-nondefault-divisibility-expected");
      callbacks.onTradeCreated({
        tradeId: "trade-nondefault-divisibility-expected",
        sellerPubkey: "02" + "33".repeat(32),
        buyerPubkey: "02" + "22".repeat(32),
        sellerLocktime: "2026-05-07T12:01:00Z",
        buyerLocktime: "2026-05-07T12:00:00Z",
        marketId: "cond-NO",
        settlementKind: "Mint",
        sellerKeepOutcomeSetId: "YES",
        sellerLockOutcomeSetId: "NO",
        baseAsset: "sat",
        divisibility: 2_000,
        outcomeFaceAmountSubunits: 1_000_000,
        quotePaymentSubunits: 500_000,
      });
    });

    await waitFor(() =>
      expect(mockJoinTrade).toHaveBeenCalledWith(
        "trade-nondefault-divisibility-expected",
      ),
    );
    const swap =
      useActiveSwapsStore.getState().byTradeId[
        "trade-nondefault-divisibility-expected"
      ];
    expect(swap.role).toBe("buyer");
    expect(swap.baseAsset).toBe("sat");
    expect(swap.divisibility).toBe(2_000);
    expect(swap.outcomeFaceAmountSubunits).toBe(1_000_000);
    expect(swap.quotePaymentSubunits).toBe(500_000);
    expect(mockSendSwapMessage).not.toHaveBeenCalled();
  });

  it("fails before locking proofs when expected unit assertion mismatches TradeCreated", async () => {
    usePendingTradesStore.getState().add({
      orderId: "order-nondefault-divisibility-mismatch",
      marketId: "cond-NO",
      clientOrderId: "client-order-pending",
      baseAsset: "sat",
      divisibility: 2_000,
      side: "Buy",
      tokenSide: "Outcome",
      priceSubunits: 1_000,
      amountSubunits: 2_000,
      submittedAt: Date.now(),
    });

    renderHook(() => useTradeSettlement(true));

    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onTradeCreated: (payload: {
        tradeId: string;
        sellerPubkey: string;
        buyerPubkey: string;
        sellerLocktime: string;
        buyerLocktime: string;
        marketId?: string;
        settlementKind?: string;
        sellerKeepOutcomeSetId?: string;
        sellerLockOutcomeSetId?: string;
        baseAsset?: string;
        divisibility?: number;
        outcomeFaceAmountSubunits?: number;
        quotePaymentSubunits?: number;
      }) => void;
    };

    await act(async () => {
      seedPendingPubkey("trade-nondefault-divisibility-mismatch");
      callbacks.onTradeCreated({
        tradeId: "trade-nondefault-divisibility-mismatch",
        sellerPubkey: "02" + "33".repeat(32),
        buyerPubkey: "02" + "22".repeat(32),
        sellerLocktime: "2026-05-07T12:01:00Z",
        buyerLocktime: "2026-05-07T12:00:00Z",
        marketId: "cond-NO",
        settlementKind: "Mint",
        sellerKeepOutcomeSetId: "YES",
        sellerLockOutcomeSetId: "NO",
        baseAsset: "sat",
        divisibility: 1_000,
        outcomeFaceAmountSubunits: 1_000_000,
        quotePaymentSubunits: 500_000,
      });
    });

    await waitFor(() =>
      expect(
        useActiveSwapsStore.getState().byTradeId[
          "trade-nondefault-divisibility-mismatch"
        ]?.step,
      ).toBe("Failed"),
    );
    expect(
      useActiveSwapsStore.getState().byTradeId[
        "trade-nondefault-divisibility-mismatch"
      ]?.error,
    ).toContain("Trade divisibility mismatch");
    expect(mockJoinTrade).not.toHaveBeenCalled();
    expect(mockSendSwapMessage).not.toHaveBeenCalled();
    expect(mockSellerLockOutcomeProofs).not.toHaveBeenCalled();
    expect(mockBuyerPrepareSwap).not.toHaveBeenCalled();
  });

  it("keeps the maker market when promoting a mint seller TradeCreated event", async () => {
    usePendingTradesStore.getState().add({
      orderId: "order-pending",
      marketId: "cond-YES",
      clientOrderId: "client-order-pending",
      side: "Buy",
      tokenSide: "Complement",
      priceSubunits: 500,
      amountSubunits: 1_000_000,
      baseAsset: "sat",
      divisibility: 1_000,
      submittedAt: Date.now(),
    });

    renderHook(() => useTradeSettlement(true));

    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onTradeCreated: (payload: {
        tradeId: string;
        sellerPubkey: string;
        buyerPubkey: string;
        sellerLocktime: string;
        buyerLocktime: string;
        marketId?: string;
        settlementKind?: string;
        sellerKeepOutcomeSetId?: string;
        sellerLockOutcomeSetId?: string;
        outcomeFaceAmountSubunits?: number;
        quotePaymentSubunits?: number;
        baseAsset?: string;
        divisibility?: number;
      }) => void;
    };

    await act(async () => {
      seedPendingPubkey("trade-pending-seller");
      callbacks.onTradeCreated({
        tradeId: "trade-pending-seller",
        sellerPubkey: "02" + "22".repeat(32),
        buyerPubkey: "02" + "33".repeat(32),
        sellerLocktime: "2026-05-07T12:01:00Z",
        buyerLocktime: "2026-05-07T12:00:00Z",
        marketId: "cond-NO",
        settlementKind: "Mint",
        sellerKeepOutcomeSetId: "YES",
        sellerLockOutcomeSetId: "NO",
        baseAsset: "sat",
        divisibility: 1_000,
        outcomeFaceAmountSubunits: 1_000_000,
        quotePaymentSubunits: 500_000,
      });
    });

    await waitFor(() =>
      expect(mockJoinTrade).toHaveBeenCalledWith("trade-pending-seller"),
    );
    const swap =
      useActiveSwapsStore.getState().byTradeId["trade-pending-seller"];
    expect(swap.orderId).toBe("order-pending");
    expect(swap.marketId).toBe("cond-YES");
    expect(swap.role).toBe("seller");
    expect(swap.sellerKeepOutcomeSetId).toBe("YES");
    expect(swap.sellerLockOutcomeSetId).toBe("NO");
  });

  it("recovers a buyer response from an existing proof operation without selecting depleted wallet proofs", async () => {
    const originalInputs = [proof(64, "buyer-original-64", "base-keyset")];
    mockGetProofOperation.mockImplementation(async (operationId: string) =>
      operationId === "trade-buyer-recover/browser/buyer-lock"
        ? {
            operationId,
            kind: "swap-lock",
            state: "completed",
            mintUrl: "https://mint.example",
            inputs: originalInputs,
            outputs: {},
            metadata: {},
            resultProofs: {
              send: [proof(50, "buyer-locked-50", "base-keyset")],
              keep: [proof(14, "buyer-change-14", "base-keyset")],
            },
            lastError: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }
        : null,
    );
    mockGetUnitProofs.mockResolvedValue([
      proof(32, "depleted-change-32", "base-keyset"),
      proof(4, "depleted-change-4", "base-keyset"),
    ]);
    usePendingTradesStore.getState().add({
      orderId: "order-buyer-recover",
      marketId: "cond-YES",
      clientOrderId: "client-order-pending",
      side: "Buy",
      tokenSide: "Outcome",
      priceSubunits: 500,
      amountSubunits: 1_000_000,
      baseAsset: "sat",
      divisibility: 1_000,
      submittedAt: Date.now(),
    });

    renderHook(() => useTradeSettlement(true));

    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onTradeCreated: (payload: {
        tradeId: string;
        sellerPubkey: string;
        buyerPubkey: string;
        sellerLocktime: string;
        buyerLocktime: string;
        marketId?: string;
        outcomeFaceAmountSubunits?: number;
        quotePaymentSubunits?: number;
        baseAsset?: string;
        divisibility?: number;
      }) => void;
      onSwapMessageReceived: (msg: {
        tradeId: string;
        messageType: string;
        ciphertext: string;
      }) => void;
    };

    await act(async () => {
      seedPendingPubkey("trade-buyer-recover");
      callbacks.onTradeCreated({
        tradeId: "trade-buyer-recover",
        sellerPubkey: "02" + "33".repeat(32),
        buyerPubkey: "02" + "22".repeat(32),
        sellerLocktime: "2026-05-07T12:01:00Z",
        buyerLocktime: "2026-05-07T12:00:00Z",
        marketId: "cond-YES",
        baseAsset: "sat",
        divisibility: 1_000,
        outcomeFaceAmountSubunits: 1_000_000,
        quotePaymentSubunits: 500_000,
      });
    });
    await act(async () => {
      callbacks.onSwapMessageReceived({
        tradeId: "trade-buyer-recover",
        messageType: "adaptor-point",
        ciphertext: "cipher-adaptor",
      });
      callbacks.onSwapMessageReceived({
        tradeId: "trade-buyer-recover",
        messageType: "locked-proofs-seller",
        ciphertext: "cipher-seller",
      });
    });

    await waitFor(() =>
      expect(mockSendSwapMessage).toHaveBeenCalledWith(
        "trade-buyer-recover",
        "locked-proofs-buyer",
        "cipher-buyer",
      ),
    );
    expect(mockGetUnitProofs).not.toHaveBeenCalled();
    expect(mockBuyerPrepareSwap).toHaveBeenCalledWith(
      expect.objectContaining({ tradeId: "trade-buyer-recover" }),
      "cipher-adaptor",
      "cipher-seller",
      originalInputs,
      500_000,
      expect.objectContaining({
        operationId: "trade-buyer-recover/browser/buyer-lock",
      }),
    );
    const swap =
      useActiveSwapsStore.getState().byTradeId["trade-buyer-recover"];
    expect(swap.messages.lockedProofsBuyer).toBe("cipher-buyer");
    expect(swap.buyerState?.lockedProofsCipher).toBe("cipher-buyer");
  });

  it("splits oversized reserved pre-flight proofs before sending a mint seller opening", async () => {
    const reservationId = `order-preflight:${"02" + "22".repeat(32)}`;
    mockGetReservedProofs.mockResolvedValue([
      {
        ...proof(1_000_036, "reserved-lock-no-10036", "keyset-NO"),
        mintUrl: "https://mint.example",
        reservedBy: reservationId,
        conditionId: "cond",
        outcomeCollection: "NO",
        marketId: "cond-NO",
      },
      {
        ...proof(1_000_036, "reserved-keep-yes-10036", "keyset-YES"),
        mintUrl: "https://mint.example",
        reservedBy: reservationId,
        conditionId: "cond",
        outcomeCollection: "YES",
        marketId: "cond-YES",
      },
    ]);
    usePendingTradesStore.getState().add({
      orderId: "order-preflight",
      marketId: "cond-YES",
      clientOrderId: "client-order-pending",
      side: "Buy",
      tokenSide: "Complement",
      priceSubunits: 500,
      amountSubunits: 1_000_000,
      submittedAt: Date.now(),
      preflightSplit: {
        reservationId,
        conditionId: "cond",
        keepOutcomeSetId: "YES",
        lockOutcomeSetId: "NO",
        amountSubunits: 1_000_000,
      },
    });

    renderHook(() => useTradeSettlement(true));

    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onTradeCreated: (payload: {
        tradeId: string;
        sellerPubkey: string;
        buyerPubkey: string;
        sellerLocktime: string;
        buyerLocktime: string;
        marketId?: string;
        settlementKind?: string;
        sellerKeepOutcomeSetId?: string;
        sellerLockOutcomeSetId?: string;
        outcomeFaceAmountSubunits?: number;
        quotePaymentSubunits?: number;
        baseAsset?: string;
        divisibility?: number;
      }) => void;
    };

    await act(async () => {
      seedPendingPubkey("trade-preflight-overpay");
      callbacks.onTradeCreated({
        tradeId: "trade-preflight-overpay",
        sellerPubkey: "02" + "22".repeat(32),
        buyerPubkey: "02" + "33".repeat(32),
        sellerLocktime: "2026-05-07T12:01:00Z",
        buyerLocktime: "2026-05-07T12:00:00Z",
        marketId: "cond-NO",
        settlementKind: "Mint",
        sellerKeepOutcomeSetId: "YES",
        sellerLockOutcomeSetId: "NO",
        outcomeFaceAmountSubunits: 1_000_000,
        quotePaymentSubunits: 500_000,
        divisibility: 1_000,
      });
    });
    await waitFor(() =>
      expect(mockSplitProofsForExactSend).toHaveBeenCalledTimes(1),
    );
    expect(mockSplitProofsForExactSend).toHaveBeenCalledWith(
      expect.objectContaining({
        amountSats: 1_000_000,
        operationId:
          "trade-preflight-overpay/browser/seller-preflight-keep-exact-v2",
        preserveSourceKeyset: true,
        sourceProofs: [
          expect.objectContaining({ secret: "reserved-keep-yes-10036" }),
        ],
      }),
    );
    expect(mockSellerLockOutcomeProofs).toHaveBeenCalledWith(
      expect.objectContaining({ tradeId: "trade-preflight-overpay" }),
      [expect.objectContaining({ secret: "reserved-lock-no-10036" })],
      1_000_000,
      expect.objectContaining({
        operationId: "trade-preflight-overpay/browser/seller-preflight-lock",
      }),
    );
    expect(mockSellerPreparePrelockedSwap).toHaveBeenCalledWith(
      expect.objectContaining({ tradeId: "trade-preflight-overpay" }),
      [expect.objectContaining({ secret: "lock-locked-100" })],
    );
    expect(mockReplaceProofs).toHaveBeenCalledWith(
      ["reserved-lock-no-10036"],
      [
        expect.objectContaining({
          secret: "lock-change-36",
          id: "keyset-NO",
          conditionId: "cond",
          outcomeCollection: "NO",
          marketId: "cond-NO",
          reservedBy: reservationId,
        }),
      ],
    );
    expect(mockReplaceProofs).toHaveBeenCalledWith(
      ["reserved-keep-yes-10036"],
      [
        expect.objectContaining({
          secret: "keep-exact-100",
          id: "keyset-YES",
          conditionId: "cond",
          outcomeCollection: "YES",
          marketId: "cond-YES",
          reservedBy: undefined,
        }),
        expect.objectContaining({
          secret: "keep-change-36",
          id: "keyset-YES",
          conditionId: "cond",
          outcomeCollection: "YES",
          marketId: "cond-YES",
          reservedBy: reservationId,
        }),
      ],
    );
    await waitFor(() =>
      expect(mockSendSwapMessage).toHaveBeenCalledWith(
        "trade-preflight-overpay",
        "locked-proofs-seller",
        "cipher-seller",
      ),
    );
  });

  it("persistPartialLockFromError_MultiKeyset_AttachesCorrectMetadataPerKeyset", async () => {
    const err = {
      partialLock: {
        failure: {
          refundLocktime: 1_779_393_600,
          affectedKeysets: ["keyset-B", "keyset-C"],
          detail: "leg 1 locked; leg 2 failed",
        },
        spentProofs: [proof(100, "spent-B"), proof(100, "spent-C")],
        lockedProofs: [
          { ...proof(100, "locked-B"), id: "keyset-B" },
          { ...proof(100, "locked-C"), id: "keyset-C" },
        ],
        changeProofs: [],
      },
    };

    await persistPartialLockFromError({
      err,
      swap: {
        tradeId: "trade-partial-multi",
        orderId: "order-partial-multi",
      } as Parameters<typeof persistPartialLockFromError>[0]["swap"],
      mintUrl: "https://mint.example",
      conditionId: "condition-1",
      collectionByKeyset: new Map([
        ["keyset-B", "B"],
        ["keyset-C", "C"],
      ]),
    });

    const record =
      usePartialLockFailuresStore.getState().byTradeId["trade-partial-multi"];
    expect(record.outcomeByKeyset["keyset-B"]).toEqual({
      conditionId: "condition-1",
      outcomeCollection: "B",
      marketId: "condition-1-B",
    });
    expect(record.outcomeByKeyset["keyset-C"]).toEqual({
      conditionId: "condition-1",
      outcomeCollection: "C",
      marketId: "condition-1-C",
    });
    expect(record.lockedProofs.map((locked) => locked.secret)).toEqual([
      "locked-B",
      "locked-C",
    ]);
    expect(mockReplaceProofs).toHaveBeenCalledWith(
      ["spent-B", "spent-C"],
      [
        expect.objectContaining({
          secret: "locked-B",
          conditionId: "condition-1",
          outcomeCollection: "B",
          marketId: "condition-1-B",
          reservedBy: "trade-partial-multi",
        }),
        expect.objectContaining({
          secret: "locked-C",
          conditionId: "condition-1",
          outcomeCollection: "C",
          marketId: "condition-1-C",
          reservedBy: "trade-partial-multi",
        }),
      ],
    );
  });

  it("ignores duplicate TradeCreated events after role assignment", async () => {
    usePendingTradesStore.getState().add({
      orderId: "order-pending",
      marketId: "cond-YES",
      clientOrderId: "client-order-pending",
      side: "Buy",
      tokenSide: "Outcome",
      priceSubunits: 500,
      amountSubunits: 1_000_000,
      baseAsset: "sat",
      divisibility: 1_000,
      submittedAt: Date.now(),
    });

    renderHook(() => useTradeSettlement(true));

    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onTradeCreated: (payload: {
        tradeId: string;
        sellerPubkey: string;
        buyerPubkey: string;
        sellerLocktime: string;
        buyerLocktime: string;
        marketId?: string;
      }) => void;
    };
    const payload = {
      tradeId: "trade-duplicate",
      sellerPubkey: "02" + "33".repeat(32),
      buyerPubkey: "02" + "22".repeat(32),
      sellerLocktime: "2026-05-07T12:01:00Z",
      buyerLocktime: "2026-05-07T12:00:00Z",
      marketId: "cond-YES",
      baseAsset: "sat",
      divisibility: 1_000,
      outcomeFaceAmountSubunits: 1_000_000,
      quotePaymentSubunits: 500_000,
    };
    seedPendingPubkey("trade-duplicate");

    await act(async () => callbacks.onTradeCreated(payload));
    await act(async () => callbacks.onTradeCreated(payload));

    expect(mockJoinTrade).toHaveBeenCalledTimes(1);
  });

  it("fails a changed duplicate TradeCreated while role assignment is in flight", async () => {
    let resolveJoinTrade: (() => void) | null = null;
    mockJoinTrade.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveJoinTrade = resolve;
        }),
    );
    usePendingTradesStore.getState().add({
      orderId: "order-pending",
      marketId: "cond-YES",
      clientOrderId: "client-order-pending",
      side: "Sell",
      tokenSide: "Outcome",
      priceSubunits: 500,
      amountSubunits: 1_000_000,
      submittedAt: Date.now(),
    });

    renderHook(() => useTradeSettlement(true));

    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onTradeCreated: (payload: {
        tradeId: string;
        sellerPubkey: string;
        buyerPubkey: string;
        sellerLocktime: string;
        buyerLocktime: string;
        marketId?: string;
        outcomeFaceAmountSubunits?: number;
        quotePaymentSubunits?: number;
      }) => void;
    };
    const payload = {
      tradeId: "trade-duplicate-inflight",
      sellerPubkey: "02" + "22".repeat(32),
      buyerPubkey: "02" + "33".repeat(32),
      sellerLocktime: "2026-05-07T12:01:00Z",
      buyerLocktime: "2026-05-07T12:00:00Z",
      marketId: "cond-YES",
      outcomeFaceAmountSubunits: 1_000_000,
      quotePaymentSubunits: 500_000,
    };
    seedPendingPubkey("trade-duplicate-inflight");

    await act(async () => callbacks.onTradeCreated(payload));
    await waitFor(() =>
      expect(
        useActiveSwapsStore.getState().byTradeId["trade-duplicate-inflight"],
      ).toBeTruthy(),
    );

    await act(async () =>
      callbacks.onTradeCreated({
        ...payload,
        quotePaymentSubunits: 5_100_000,
      }),
    );

    let swap =
      useActiveSwapsStore.getState().byTradeId["trade-duplicate-inflight"];
    expect(swap.step).toBe("Failed");
    expect(swap.role).toBeNull();
    expect(swap.error).toMatch(/TradeCreated payload changed/i);

    await act(async () => {
      resolveJoinTrade?.();
    });

    await waitFor(() => {
      swap =
        useActiveSwapsStore.getState().byTradeId["trade-duplicate-inflight"];
      expect(swap.step).toBe("Failed");
      expect(swap.role).toBeNull();
    });
    expect(mockSellerPreparePrelockedSwap).not.toHaveBeenCalled();
  });

  it("fails the swap before role assignment when TradeCreated locktimes are inverted", async () => {
    renderHook(() => useTradeSettlement(true));

    await act(async () => {
      useActiveSwapsStore.getState().promote({
        tradeId: "trade-2",
        orderId: "order-2",
        marketId: "market-1",
        ephemeralPrivkeyHex: "11".repeat(32),
        ephemeralPubkeyHex: "22".repeat(32),
        side: "Sell",
        tokenSide: "Outcome",
        priceSubunits: 500,
        amountSubunits: 1_000_000,
      });
    });

    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onTradeCreated: (payload: {
        tradeId: string;
        sellerPubkey: string;
        buyerPubkey: string;
        sellerLocktime: string;
        buyerLocktime: string;
        outcomeFaceAmountSubunits?: number;
        quotePaymentSubunits?: number;
      }) => void;
    };

    await act(async () => {
      seedPendingPubkey("trade-2", "order-2", "market-1", "22".repeat(32));
      callbacks.onTradeCreated({
        tradeId: "trade-2",
        sellerPubkey: "22".repeat(32),
        buyerPubkey: "33".repeat(32),
        sellerLocktime: "2026-05-07T12:00:00Z",
        buyerLocktime: "2026-05-07T12:01:00Z",
        outcomeFaceAmountSubunits: 1_000_000,
        quotePaymentSubunits: 500_000,
      });
    });

    const swap = useActiveSwapsStore.getState().byTradeId["trade-2"];
    expect(swap.step).toBe("Failed");
    expect(swap.role).toBeNull();
    expect(swap.error).toMatch(
      /locktime ordering violates protocol invariant/i,
    );
    expect(mockSendSwapMessage).not.toHaveBeenCalled();
  });

  it("keeps completed swaps terminal when a late failed state arrives", async () => {
    renderHook(() => useTradeSettlement(true));

    await act(async () => {
      useActiveSwapsStore.getState().promote({
        tradeId: "trade-3",
        orderId: "order-3",
        marketId: "market-1",
        ephemeralPrivkeyHex: "11".repeat(32),
        ephemeralPubkeyHex: "22".repeat(32),
      });
    });

    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onTradeStateChanged: (tradeId: string, newState: string) => void;
    };

    await act(async () => {
      callbacks.onTradeStateChanged("trade-3", "Confirmed");
    });
    expect(useActiveSwapsStore.getState().byTradeId["trade-3"].step).toBe(
      "completed",
    );

    await act(async () => {
      callbacks.onTradeStateChanged("trade-3", "Failed");
    });

    const swap = useActiveSwapsStore.getState().byTradeId["trade-3"];
    expect(swap.step).toBe("completed");
    expect(swap.error).toBeNull();
  });

  it("does not display raw trade failure errors for swaps without local participant pubkey confirmation", async () => {
    renderHook(() => useTradeSettlement(true));

    await act(async () => {
      useActiveSwapsStore.getState().promote({
        tradeId: "trade-nonparticipant-failure",
        orderId: "order-nonparticipant-failure",
        marketId: "market-1",
        ephemeralPrivkeyHex: "11".repeat(32),
        ephemeralPubkeyHex: "02" + "22".repeat(32),
      });
    });

    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onTradeStateChanged: (tradeId: string, newState: string) => void;
    };

    await act(async () => {
      callbacks.onTradeStateChanged("trade-nonparticipant-failure", "Failed");
    });

    expect(useToastStore.getState().toasts).toEqual([]);
    expect(
      useActiveSwapsStore.getState().byTradeId["trade-nonparticipant-failure"]
        .step,
    ).toBe("Failed");
  });

  it("fails before locking proofs when TradeCreated outcome face is not a whole market share for sat/10000", async () => {
    usePendingTradesStore.getState().add({
      orderId: "order-ambiguous-sat100",
      marketId: "cond-YES",
      clientOrderId: "client-order-pending",
      baseAsset: "sat",
      divisibility: 10_000,
      side: "Buy",
      tokenSide: "Outcome",
      priceSubunits: 500,
      amountSubunits: 20_000,
      submittedAt: Date.now(),
    });

    renderHook(() => useTradeSettlement(true));

    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onTradeCreated: (payload: {
        tradeId: string;
        sellerPubkey: string;
        buyerPubkey: string;
        sellerLocktime: string;
        buyerLocktime: string;
        marketId?: string;
        settlementKind?: string;
        outcomeFaceAmountSubunits?: number;
        quotePaymentSubunits?: number;
        baseAsset?: string;
        divisibility?: number;
      }) => void;
    };

    await act(async () => {
      seedPendingPubkey("trade-ambiguous-sat100");
      callbacks.onTradeCreated({
        tradeId: "trade-ambiguous-sat100",
        sellerPubkey: "02" + "33".repeat(32),
        buyerPubkey: "02" + "22".repeat(32),
        sellerLocktime: "2026-05-07T12:01:00Z",
        buyerLocktime: "2026-05-07T12:00:00Z",
        marketId: "cond-YES",
        settlementKind: "DirectSwap",
        outcomeFaceAmountSubunits: 15_000,
        quotePaymentSubunits: 7_500,
        baseAsset: "sat",
        divisibility: 10_000,
      });
    });

    await waitFor(() =>
      expect(
        useActiveSwapsStore.getState().byTradeId["trade-ambiguous-sat100"]?.step,
      ).toBe("Failed"),
    );
    expect(
      useActiveSwapsStore.getState().byTradeId["trade-ambiguous-sat100"]?.error,
    ).toContain("Trade outcome face amount is not a whole market share");
    expect(mockSendSwapMessage).not.toHaveBeenCalled();
    expect(mockSellerLockOutcomeProofs).not.toHaveBeenCalled();
    expect(mockBuyerPrepareSwap).not.toHaveBeenCalled();
  });

  it("fails before locking proofs when non-default TradeCreated carries inconsistent quote payment amounts", async () => {
    usePendingTradesStore.getState().add({
      orderId: "order-ambiguous-usd",
      marketId: "cond-NO",
      clientOrderId: "client-order-pending",
      baseAsset: "usd",
      divisibility: 1_000,
      side: "Buy",
      tokenSide: "Outcome",
      priceSubunits: 400,
      amountSubunits: 1_000_000,
      submittedAt: Date.now(),
    });

    renderHook(() => useTradeSettlement(true));

    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onTradeCreated: (payload: {
        tradeId: string;
        sellerPubkey: string;
        buyerPubkey: string;
        sellerLocktime: string;
        buyerLocktime: string;
        marketId?: string;
        settlementKind?: string;
        sellerKeepOutcomeSetId?: string;
        sellerLockOutcomeSetId?: string;
        outcomeFaceAmountSubunits?: number;
        quotePaymentSubunits?: number;
        baseAsset?: string;
        divisibility?: number;
      }) => void;
    };

    await act(async () => {
      seedPendingPubkey("trade-ambiguous-usd-quote");
      callbacks.onTradeCreated({
        tradeId: "trade-ambiguous-usd-quote",
        sellerPubkey: "02" + "33".repeat(32),
        buyerPubkey: "02" + "22".repeat(32),
        sellerLocktime: "2026-05-07T12:01:00Z",
        buyerLocktime: "2026-05-07T12:00:00Z",
        marketId: "cond-NO",
        settlementKind: "Mint",
        sellerKeepOutcomeSetId: "YES",
        sellerLockOutcomeSetId: "NO",
        outcomeFaceAmountSubunits: 100_000,
        quotePaymentSubunits: 99_999,
        baseAsset: "usd",
        divisibility: 1_000,
      });
    });

    await waitFor(() =>
      expect(
        useActiveSwapsStore.getState().byTradeId["trade-ambiguous-usd-quote"]?.step,
      ).toBe("Failed"),
    );
    expect(
      useActiveSwapsStore.getState().byTradeId["trade-ambiguous-usd-quote"]?.error,
    ).toContain("Trade quote payment exceeds the submitted order price");
    expect(mockSendSwapMessage).not.toHaveBeenCalled();
    expect(mockSellerLockOutcomeProofs).not.toHaveBeenCalled();
    expect(mockBuyerPrepareSwap).not.toHaveBeenCalled();
  });

  it("fails before locking proofs when a non-default TradeCreated arrives for a legacy pending trade with no expected unit", async () => {
    usePendingTradesStore.getState().add({
      orderId: "order-legacy-no-unit",
      marketId: "cond-NO",
      clientOrderId: "client-order-pending",
      side: "Buy",
      tokenSide: "Outcome",
      priceSubunits: 500,
      amountSubunits: 1_000_000,
      submittedAt: Date.now(),
    });

    renderHook(() => useTradeSettlement(true));

    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onTradeCreated: (payload: {
        tradeId: string;
        sellerPubkey: string;
        buyerPubkey: string;
        sellerLocktime: string;
        buyerLocktime: string;
        marketId?: string;
        settlementKind?: string;
        sellerKeepOutcomeSetId?: string;
        sellerLockOutcomeSetId?: string;
        outcomeFaceAmountSubunits?: number;
        quotePaymentSubunits?: number;
        baseAsset?: string;
        divisibility?: number;
      }) => void;
    };

    await act(async () => {
      seedPendingPubkey("trade-nondefault-no-expected-unit");
      callbacks.onTradeCreated({
        tradeId: "trade-nondefault-no-expected-unit",
        sellerPubkey: "02" + "33".repeat(32),
        buyerPubkey: "02" + "22".repeat(32),
        sellerLocktime: "2026-05-07T12:01:00Z",
        buyerLocktime: "2026-05-07T12:00:00Z",
        marketId: "cond-NO",
        settlementKind: "Mint",
        sellerKeepOutcomeSetId: "YES",
        sellerLockOutcomeSetId: "NO",
        outcomeFaceAmountSubunits: 100_000,
        quotePaymentSubunits: 50_000,
        baseAsset: "usd",
        divisibility: 2_000,
      });
    });

    await waitFor(() =>
      expect(
        useActiveSwapsStore.getState().byTradeId["trade-nondefault-no-expected-unit"]?.step,
      ).toBe("Failed"),
    );
    expect(
      useActiveSwapsStore.getState().byTradeId["trade-nondefault-no-expected-unit"]?.error,
    ).toContain("non-default unit but the local expected unit is missing");
    expect(mockSendSwapMessage).not.toHaveBeenCalled();
    expect(mockSellerLockOutcomeProofs).not.toHaveBeenCalled();
    expect(mockBuyerPrepareSwap).not.toHaveBeenCalled();
  });

  it("accepts an outcome-side buy order as the mint seller", async () => {
    usePendingTradesStore.getState().add({
      orderId: "order-tokenside-mismatch",
      marketId: "cond-YES",
      clientOrderId: "client-order-pending",
      side: "Buy",
      tokenSide: "Outcome",
      priceSubunits: 500,
      amountSubunits: 1_000_000,
      submittedAt: Date.now(),
    });

    renderHook(() => useTradeSettlement(true));

    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onTradeCreated: (payload: {
        tradeId: string;
        sellerPubkey: string;
        buyerPubkey: string;
        sellerLocktime: string;
        buyerLocktime: string;
        marketId?: string;
        settlementKind?: string;
        sellerKeepOutcomeSetId?: string;
        sellerLockOutcomeSetId?: string;
        outcomeFaceAmountSubunits?: number;
        quotePaymentSubunits?: number;
        baseAsset?: string;
        divisibility?: number;
      }) => void;
    };

    await act(async () => {
      seedPendingPubkey("trade-tokenside-mismatch");
      callbacks.onTradeCreated({
        tradeId: "trade-tokenside-mismatch",
        sellerPubkey: "02" + "22".repeat(32),
        buyerPubkey: "02" + "33".repeat(32),
        sellerLocktime: "2026-05-07T12:01:00Z",
        buyerLocktime: "2026-05-07T12:00:00Z",
        marketId: "cond-YES",
        settlementKind: "Mint",
        sellerKeepOutcomeSetId: "YES",
        sellerLockOutcomeSetId: "NO",
        outcomeFaceAmountSubunits: 1_000_000,
        quotePaymentSubunits: 500_000,
        baseAsset: "sat",
        divisibility: 1_000,
      });
    });

    await waitFor(() =>
      expect(mockJoinTrade).toHaveBeenCalledWith("trade-tokenside-mismatch"),
    );
    const swap =
      useActiveSwapsStore.getState().byTradeId["trade-tokenside-mismatch"];
    expect(swap?.role).toBe("seller");
    expect(swap?.orderId).toBe("order-tokenside-mismatch");
    expect(swap?.error ?? "").not.toContain(
      "does not match the submitted order side",
    );
    expect(mockSendSwapMessage).not.toHaveBeenCalled();
    expect(mockBuyerPrepareSwap).not.toHaveBeenCalled();
  });
});

function proof(amount: number, secret: string, id = `keyset-${amount}`) {
  return {
    id,
    amount,
    secret,
    C: `c-${secret}`,
  };
}

function keyset(id: string, conditionId: string, outcomeCollection: string) {
  return {
    id,
    unit: "sat",
    active: true,
    input_fee_ppk: 0,
    keys: { "1": "02" + "11".repeat(32) },
    condition_id: conditionId,
    outcome_collection: outcomeCollection,
    outcome_collection_id: outcomeCollection,
  };
}
