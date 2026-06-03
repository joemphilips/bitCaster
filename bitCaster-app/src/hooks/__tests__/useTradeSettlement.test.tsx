import { renderHook, act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useActiveSwapsStore } from "@/stores/activeSwaps";
import { usePendingTradesStore } from "@/stores/pendingTrades";
import { usePartialLockFailuresStore } from "@/stores/partialLockFailures";

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
  mockGetBaseProofs,
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
  mockGetBaseProofs: vi.fn(),
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
  mockSellerLockOutcomeProofs,
  mockSellerPreparePrelockedSwap,
  mockSplitProofsForExactSend,
} = vi.hoisted(() => ({
  mockSellerLockOutcomeProofs: vi.fn(),
  mockSellerPreparePrelockedSwap: vi.fn(),
  mockSplitProofsForExactSend: vi.fn(),
}));

vi.mock("@/hooks/useTradeHub", () => ({
  useTradeHub: mockUseTradeHub,
}));

vi.mock("@/stores/proof-db", () => ({
  addProofs: mockAddProofs,
  getBaseProofs: mockGetBaseProofs,
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
  usePartialLockFailuresStore.setState({ byTradeId: {} });
  mockJoinOrder.mockResolvedValue(undefined);
  mockJoinTrade.mockResolvedValue(undefined);
  mockSendSwapMessage.mockResolvedValue(undefined);
  mockAddProofs.mockResolvedValue(undefined);
  mockGetBaseProofs.mockResolvedValue([]);
  mockGetOutcomeProofs.mockResolvedValue([]);
  mockGetProofOperation.mockResolvedValue(null);
  mockGetReservedProofs.mockResolvedValue([]);
  mockMarkProofOperationCompleted.mockResolvedValue({});
  mockPrepareProofOperation.mockResolvedValue({});
  mockReleaseProofReservationsBySecret.mockResolvedValue(undefined);
  mockRemoveProofs.mockResolvedValue(undefined);
  mockReplaceProofs.mockResolvedValue(undefined);
  mockReserveProofs.mockResolvedValue(undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        keysets: [
          keyset("keyset-YES", "cond", "YES"),
          keyset("keyset-NO", "cond", "NO"),
          keyset("keyset-B", "condition-1", "B"),
          keyset("keyset-C", "condition-1", "C"),
        ],
      }),
    }),
  );
  mockSellerPreparePrelockedSwap.mockResolvedValue({
    adaptorPointCipher: "cipher-adaptor",
    lockedProofsCipher: "cipher-seller",
    adaptorPoint: { point: new Uint8Array([1]), secret: new Uint8Array([2]) },
    lockedProofs: [],
    changeProofs: [],
  });
  mockSellerLockOutcomeProofs.mockImplementation(async (_ctx, proofs) => ({
    lockedProofs: [
      proof(
        100,
        `${proofs[0].secret.includes("lock") ? "lock" : "inventory"}-locked-100`,
      ),
    ],
    changeProofs: [
      {
        ...proof(
          36,
          `${proofs[0].secret.includes("lock") ? "lock" : "inventory"}-change-36`,
        ),
        id: proofs[0].id,
      },
    ],
  }));
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
    remainingAmountSats: 100,
    filledAmountSats: 0,
    fills: [],
  });
  mockUseTradeHub.mockReturnValue({
    joinOrder: mockJoinOrder,
    joinTrade: mockJoinTrade,
    sendSwapMessage: mockSendSwapMessage,
    connectionState: vi.fn(),
  });
});

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

  it("joins pending order groups so resting makers can receive TradeCreated", async () => {
    usePendingTradesStore.getState().add({
      orderId: "order-pending",
      marketId: "cond-YES",
      ephemeralPrivkey: "11".repeat(32),
      ephemeralPubkey: "02" + "22".repeat(32),
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
      ephemeralPrivkey: "11".repeat(32),
      ephemeralPubkey: "02" + "22".repeat(32),
      submittedAt: Date.now(),
    });

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

  it("retries pending order group joins after a transient hub failure", async () => {
    vi.useFakeTimers();
    mockJoinOrder
      .mockRejectedValueOnce(new Error("projection lag"))
      .mockResolvedValue(undefined);
    usePendingTradesStore.getState().add({
      orderId: "order-pending",
      marketId: "cond-YES",
      ephemeralPrivkey: "11".repeat(32),
      ephemeralPubkey: "02" + "22".repeat(32),
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

  it("waits for order status before joining pending order groups", async () => {
    vi.useFakeTimers();
    mockFetchOrderStatus.mockResolvedValueOnce(null).mockResolvedValue({
      orderId: "order-pending",
      marketId: "cond-YES",
      status: "resting",
      remainingAmountSats: 100,
      filledAmountSats: 0,
      fills: [],
    });
    usePendingTradesStore.getState().add({
      orderId: "order-pending",
      marketId: "cond-YES",
      ephemeralPrivkey: "11".repeat(32),
      ephemeralPubkey: "02" + "22".repeat(32),
      submittedAt: Date.now(),
    });

    renderHook(() => useTradeSettlement(true));

    await act(async () => {});
    expect(mockJoinOrder).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(mockJoinOrder).toHaveBeenCalledWith("cond-YES", "order-pending");
  });

  it("promotes an unsolicited TradeCreated event for a pending mint order", async () => {
    usePendingTradesStore.getState().add({
      orderId: "order-pending",
      marketId: "cond-NO",
      ephemeralPrivkey: "11".repeat(32),
      ephemeralPubkey: "02" + "22".repeat(32),
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
        outcomeFaceAmountSats?: number;
        quotePaymentSats?: number;
      }) => void;
    };

    await act(async () => {
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
        outcomeFaceAmountSats: 100,
        quotePaymentSats: 50,
      });
    });

    await waitFor(() =>
      expect(mockJoinTrade).toHaveBeenCalledWith("trade-pending"),
    );
    const swap = useActiveSwapsStore.getState().byTradeId["trade-pending"];
    expect(swap.orderId).toBe("order-pending");
    expect(swap.marketId).toBe("cond-NO");
    expect(swap.role).toBe("buyer");
    expect(swap.outcomeFaceAmountSats).toBe(100);
    expect(swap.quotePaymentSats).toBe(50);
  });

  it("keeps the maker market when promoting a mint seller TradeCreated event", async () => {
    usePendingTradesStore.getState().add({
      orderId: "order-pending",
      marketId: "cond-YES",
      ephemeralPrivkey: "11".repeat(32),
      ephemeralPubkey: "02" + "22".repeat(32),
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
        outcomeFaceAmountSats?: number;
        quotePaymentSats?: number;
      }) => void;
    };

    await act(async () => {
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
        outcomeFaceAmountSats: 100,
        quotePaymentSats: 50,
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

  it("splits oversized reserved pre-flight proofs before sending a mint seller opening", async () => {
    const reservationId = `order-preflight:${"02" + "22".repeat(32)}`;
    mockGetReservedProofs.mockResolvedValue([
      {
        ...proof(136, "reserved-lock-no-136", "keyset-NO"),
        mintUrl: "https://mint.example",
        reservedBy: reservationId,
        conditionId: "cond",
        outcomeCollection: "NO",
        marketId: "cond-NO",
      },
      {
        ...proof(136, "reserved-keep-yes-136", "keyset-YES"),
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
      ephemeralPrivkey: "11".repeat(32),
      ephemeralPubkey: "02" + "22".repeat(32),
      submittedAt: Date.now(),
      preflightSplit: {
        reservationId,
        conditionId: "cond",
        keepOutcomeSetId: "YES",
        lockOutcomeSetId: "NO",
        amountSats: 100,
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
        outcomeFaceAmountSats?: number;
        quotePaymentSats?: number;
      }) => void;
    };

    await act(async () => {
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
        outcomeFaceAmountSats: 100,
        quotePaymentSats: 50,
      });
    });

    await waitFor(() =>
      expect(mockSplitProofsForExactSend).toHaveBeenCalledTimes(1),
    );
    expect(mockSellerLockOutcomeProofs).not.toHaveBeenCalled();
    expect(mockSplitProofsForExactSend).toHaveBeenCalledWith(
      expect.objectContaining({
        amountSats: 100,
        operationId:
          "trade-preflight-overpay/browser/seller-preflight-keep-exact-v2/YES",
        preserveSourceKeyset: true,
        sourceProofs: [
          expect.objectContaining({ secret: "reserved-keep-yes-136" }),
        ],
      }),
    );
    expect(mockSellerPreparePrelockedSwap).toHaveBeenCalledWith(
      expect.objectContaining({ tradeId: "trade-preflight-overpay" }),
      [expect.objectContaining({ secret: "reserved-lock-no-136" })],
    );
    expect(mockReplaceProofs).toHaveBeenCalledWith(
      ["reserved-lock-no-136"],
      [],
    );
    expect(mockReplaceProofs).toHaveBeenCalledWith(
      ["reserved-keep-yes-136"],
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
      ephemeralPrivkey: "11".repeat(32),
      ephemeralPubkey: "02" + "22".repeat(32),
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
    };

    await act(async () => callbacks.onTradeCreated(payload));
    await act(async () => callbacks.onTradeCreated(payload));

    expect(mockJoinTrade).toHaveBeenCalledTimes(1);
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
      });
    });

    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onTradeCreated: (payload: {
        tradeId: string;
        sellerPubkey: string;
        buyerPubkey: string;
        sellerLocktime: string;
        buyerLocktime: string;
      }) => void;
    };

    await act(async () => {
      callbacks.onTradeCreated({
        tradeId: "trade-2",
        sellerPubkey: "22".repeat(32),
        buyerPubkey: "33".repeat(32),
        sellerLocktime: "2026-05-07T12:00:00Z",
        buyerLocktime: "2026-05-07T12:01:00Z",
      });
    });

    const swap = useActiveSwapsStore.getState().byTradeId["trade-2"];
    expect(swap.step).toBe("failed");
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
    condition_id: conditionId,
    outcome_collection: outcomeCollection,
    outcome_collection_id: outcomeCollection,
  };
}
