import { renderHook, act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useActiveSwapsStore, type ActiveSwap } from "@/stores/activeSwaps";
import {
  usePendingTradesStore,
  type PendingTrade,
  type PendingTradeRecord,
} from "@/stores/pendingTrades";
import { usePendingPubkeySubmissionsStore } from "@/stores/pendingPubkeySubmissions";
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
  mockCurrentWalletId,
  mockLoadGuiPendingTrades,
  mockPersistGuiPendingTrade,
  mockRemoveGuiPendingTrade,
} = vi.hoisted(() => ({
  mockCurrentWalletId: vi.fn(),
  mockLoadGuiPendingTrades: vi.fn(),
  mockPersistGuiPendingTrade: vi.fn(),
  mockRemoveGuiPendingTrade: vi.fn(),
}));

const { mockWalletState } = vi.hoisted(() => ({
  mockWalletState: {
    activeMintUrl: "https://mint.example",
    mnemonic:
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  },
}));

const {
  mockCompleteGuiProofOperationWithSession,
  mockLoadGuiSwapSessionStateUnderLock,
  mockLoadRecoverableGuiTradeOperationPage,
  mockLoadRecoverableGuiSwapSessions,
  mockPersistGuiSwapSession,
  mockPrepareGuiProofOperationWithSession,
  mockRecoverGuiDurableTradeSession,
  mockRecordGuiRecoveredProofOperationOutputs,
  mockWithGuiSwapSessionOwnership,
} = vi.hoisted(() => ({
  mockCompleteGuiProofOperationWithSession: vi.fn(),
  mockLoadGuiSwapSessionStateUnderLock: vi.fn(),
  mockLoadRecoverableGuiTradeOperationPage: vi.fn(),
  mockLoadRecoverableGuiSwapSessions: vi.fn(),
  mockPersistGuiSwapSession: vi.fn(),
  mockPrepareGuiProofOperationWithSession: vi.fn(),
  mockRecoverGuiDurableTradeSession: vi.fn(),
  mockRecordGuiRecoveredProofOperationOutputs: vi.fn(),
  mockWithGuiSwapSessionOwnership: vi.fn(),
}));

const {
  mockGuiTradeRefundDueAtMs,
  mockGuiTradeRefundEvidenceUnderLock,
  mockPrepareGuiTradeRefundUnderLock,
  mockSalvageGuiTradeRefundUnderLock,
} = vi.hoisted(() => ({
  mockGuiTradeRefundDueAtMs: vi.fn(),
  mockGuiTradeRefundEvidenceUnderLock: vi.fn(),
  mockPrepareGuiTradeRefundUnderLock: vi.fn(),
  mockSalvageGuiTradeRefundUnderLock: vi.fn(),
}));

const { mockGetGuiPendingSwapIntent, mockLoadGuiPendingSwapIntents } =
  vi.hoisted(() => ({
    mockGetGuiPendingSwapIntent: vi.fn(),
    mockLoadGuiPendingSwapIntents: vi.fn(),
  }));

const { mockSubmitOrder, mockSubmitEphemeralPubkey } = vi.hoisted(() => ({
  mockSubmitOrder: vi.fn(),
  mockSubmitEphemeralPubkey: vi.fn(),
}));

const { mockSubmitAdmittedGuiPendingSwapIntents } = vi.hoisted(() => ({
  mockSubmitAdmittedGuiPendingSwapIntents: vi.fn(),
}));

const {
  mockAddProofs,
  mockGetUnitProofs,
  mockGetOutcomeProofs,
  mockGetProofOperation,
  mockGetReservedProofs,
  mockMarkProofOperationCompleted,
  mockPrepareProofOperation,
  mockReleaseProofReservation,
  mockRemoveProofs,
  mockReserveProofs,
  mockTryReserveProofs,
} = vi.hoisted(() => ({
  mockAddProofs: vi.fn(),
  mockGetUnitProofs: vi.fn(),
  mockGetOutcomeProofs: vi.fn(),
  mockGetProofOperation: vi.fn(),
  mockGetReservedProofs: vi.fn(),
  mockMarkProofOperationCompleted: vi.fn(),
  mockPrepareProofOperation: vi.fn(),
  mockReleaseProofReservation: vi.fn(),
  mockRemoveProofs: vi.fn(),
  mockReserveProofs: vi.fn(),
  mockTryReserveProofs: vi.fn(),
}));

const {
  mockBuyerPrepareSwap,
  mockGenerateAdaptorPoint,
  mockSellerLockOutcomeProofs,
  mockSellerPreparePersistedPrelockedSwap,
  mockSellerPreparePrelockedSwap,
  mockSplitProofsForExactSend,
} = vi.hoisted(() => ({
  mockBuyerPrepareSwap: vi.fn(),
  mockGenerateAdaptorPoint: vi.fn(),
  mockSellerLockOutcomeProofs: vi.fn(),
  mockSellerPreparePersistedPrelockedSwap: vi.fn(),
  mockSellerPreparePrelockedSwap: vi.fn(),
  mockSplitProofsForExactSend: vi.fn(),
}));

vi.mock("@/hooks/useTradeHub", () => ({
  useTradeHub: mockUseTradeHub,
}));

vi.mock("@/stores/proof-db", () => ({
  currentGuiWalletId: mockCurrentWalletId,
  addProofs: mockAddProofs,
  getUnitProofs: mockGetUnitProofs,
  getUnitProofsUnderLock: (_lock: unknown, mintUrl: string, options: unknown) =>
    mockGetUnitProofs(mintUrl, options),
  getOutcomeProofs: mockGetOutcomeProofs,
  getOutcomeProofsUnderLock: (
    _lock: unknown,
    mintUrl: string,
    conditionId: string,
    outcomeCollection: string,
    options: unknown,
  ) => mockGetOutcomeProofs(mintUrl, conditionId, outcomeCollection, options),
  getProofOperation: mockGetProofOperation,
  getProofOperationUnderLock: (_lock: unknown, operationId: string) =>
    mockGetProofOperation(operationId),
  getReservedProofs: mockGetReservedProofs,
  markProofOperationCompleted: mockMarkProofOperationCompleted,
  prepareProofOperation: mockPrepareProofOperation,
  releaseProofReservation: mockReleaseProofReservation,
  releaseProofReservationUnderLock: (_lock: unknown, reservedBy: string) =>
    mockReleaseProofReservation(reservedBy),
  removeProofs: mockRemoveProofs,
  reserveProofs: mockReserveProofs,
  tryReserveProofs: mockTryReserveProofs,
  tryReserveProofsUnderLock: (
    _lock: unknown,
    secrets: string[],
    reservedBy: string,
  ) => mockTryReserveProofs(secrets, reservedBy),
}));

vi.mock("@/stores/pendingTrades", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/stores/pendingTrades")>();
  return {
    ...actual,
    loadGuiPendingTrades: mockLoadGuiPendingTrades,
    persistGuiPendingTrade: mockPersistGuiPendingTrade,
    removeGuiPendingTrade: mockRemoveGuiPendingTrade,
  };
});

vi.mock("@/stores/swap-session-db", () => ({
  loadRecoverableGuiTradeOperationPage:
    mockLoadRecoverableGuiTradeOperationPage,
  loadRecoverableGuiSwapSessions: mockLoadRecoverableGuiSwapSessions,
  loadGuiSwapSessionStateUnderLock: (_lock: unknown, tradeId: string) =>
    mockLoadGuiSwapSessionStateUnderLock(tradeId),
  persistGuiSwapSessionUnderLock: (
    _lock: unknown,
    active: unknown,
    mintUrl: string,
  ) => mockPersistGuiSwapSession(active, mintUrl),
  prepareGuiProofOperationWithSession: mockPrepareGuiProofOperationWithSession,
  recoverGuiDurableTradeSession: (tradeId: string, input: unknown) =>
    mockRecoverGuiDurableTradeSession(tradeId, input),
  recordGuiRecoveredProofOperationOutputsUnderLock: (
    _lock: unknown,
    tradeId: string,
    operationId: string,
    resultProofs: unknown,
  ) =>
    mockRecordGuiRecoveredProofOperationOutputs(
      tradeId,
      operationId,
      resultProofs,
    ),
  completeGuiProofOperationWithSession:
    mockCompleteGuiProofOperationWithSession,
  withGuiSwapSessionOwnership: mockWithGuiSwapSessionOwnership,
}));

vi.mock("@/stores/gui-trade-refund-recovery", () => ({
  guiTradeRefundDueAtMs: mockGuiTradeRefundDueAtMs,
  guiTradeRefundEvidenceUnderLock: mockGuiTradeRefundEvidenceUnderLock,
  isGuiTradeRefundLink: (operation: { stage?: string }) =>
    operation.stage === "refund",
  prepareGuiTradeRefund: mockPrepareGuiTradeRefundUnderLock,
  salvageGuiTradeRefund: mockSalvageGuiTradeRefundUnderLock,
}));

vi.mock("@/stores/gui-wallet-lock", () => ({
  walletIdFromHeldGuiWalletLock: () => "aa".repeat(32),
}));

const { mockReleaseGuiCustodyAuthority, mockTryWithGuiCustodyProfileLock } =
  vi.hoisted(() => ({
    mockReleaseGuiCustodyAuthority: vi.fn(),
    mockTryWithGuiCustodyProfileLock: vi.fn(),
  }));

vi.mock("@/stores/gui-custody-authority", () => ({
  releaseGuiCustodyAuthority: mockReleaseGuiCustodyAuthority,
  tryWithGuiCustodyProfileLock: mockTryWithGuiCustodyProfileLock,
}));

vi.mock("@/stores/pending-swap-intent-db", () => ({
  getGuiPendingSwapIntent: mockGetGuiPendingSwapIntent,
  loadGuiPendingSwapIntents: mockLoadGuiPendingSwapIntents,
}));

vi.mock("@/stores/gui-pretrade-storage", () => ({
  submitAdmittedGuiPendingSwapIntents: mockSubmitAdmittedGuiPendingSwapIntents,
}));

const { mockCommitGuiPartialLockFailure } = vi.hoisted(() => ({
  mockCommitGuiPartialLockFailure: vi.fn(),
}));

vi.mock("@/stores/partial-lock-failure-db", () => ({
  commitGuiPartialLockFailureUnderLock: mockCommitGuiPartialLockFailure,
}));

vi.mock("@/lib/orderStatus", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/orderStatus")>();
  return {
    ...actual,
    fetchOrderStatus: mockFetchOrderStatus,
  };
});

vi.mock("@/lib/markets", () => ({
  submitOrder: mockSubmitOrder,
  submitEphemeralPubkey: mockSubmitEphemeralPubkey,
}));

vi.mock("@bitcaster/swap-protocol/atomicSwap", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@bitcaster/swap-protocol/atomicSwap")
    >();
  return {
    ...actual,
    buyerPrepareSwap: mockBuyerPrepareSwap,
    generateAdaptorPoint: mockGenerateAdaptorPoint,
    sellerLockOutcomeProofs: mockSellerLockOutcomeProofs,
    sellerPreparePersistedPrelockedSwap:
      mockSellerPreparePersistedPrelockedSwap,
    sellerPreparePrelockedSwap: mockSellerPreparePrelockedSwap,
    splitProofsForExactSend: mockSplitProofsForExactSend,
  };
});

vi.mock("@/stores/wallet", () => {
  const useWalletStore = Object.assign(
    (selector: (value: typeof mockWalletState) => unknown) =>
      selector(mockWalletState),
    { getState: () => mockWalletState },
  );
  return { useWalletStore };
});

const { useTradeSettlement } = await import("../useTradeSettlement");

let mockOwnershipTail = Promise.resolve();
let mockProfileLockDepth = 0;
let mockTryProfileLockAvailable = true;
let mockSendProfileLockDepths: number[] = [];

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mockOwnershipTail = Promise.resolve();
  mockProfileLockDepth = 0;
  mockTryProfileLockAvailable = true;
  mockSendProfileLockDepths = [];
  useActiveSwapsStore.setState({ byTradeId: {} });
  mockCurrentWalletId.mockReturnValue(TEST_WALLET_ID);
  mockWalletState.activeMintUrl = "https://mint.example";
  mockWalletState.mnemonic = TEST_MNEMONIC_A;
  pendingTradeRows.clear();
  usePendingTradesStore.setState({ walletId: TEST_WALLET_ID, byOrderId: {} });
  usePendingPubkeySubmissionsStore.setState({ byTradeId: {} });
  useToastStore.setState({ toasts: [] });
  mockJoinOrder.mockResolvedValue(undefined);
  mockJoinTrade.mockResolvedValue(undefined);
  mockSendSwapMessage.mockImplementation(async () => {
    mockSendProfileLockDepths.push(mockProfileLockDepth);
  });
  mockAddProofs.mockResolvedValue(undefined);
  mockGetUnitProofs.mockResolvedValue([]);
  mockGetOutcomeProofs.mockResolvedValue([]);
  mockGetProofOperation.mockResolvedValue(null);
  mockGetReservedProofs.mockResolvedValue([]);
  mockMarkProofOperationCompleted.mockResolvedValue({});
  mockPrepareProofOperation.mockResolvedValue({});
  mockReleaseProofReservation.mockResolvedValue(undefined);
  mockRemoveProofs.mockResolvedValue(undefined);
  mockCommitGuiPartialLockFailure.mockResolvedValue(undefined);
  mockReserveProofs.mockResolvedValue(undefined);
  mockTryReserveProofs.mockResolvedValue(true);
  mockBuyerPrepareSwap.mockResolvedValue({
    lockedProofsCipher: "cipher-buyer",
    lockedProofs: [proof(50, "buyer-locked-50", "base-keyset")],
    changeProofs: [proof(36, "buyer-change-36", "base-keyset")],
    preSigsHex: ["pre-buyer"],
    sellerPreSigsHex: ["pre-seller"],
  });
  mockGenerateAdaptorPoint.mockReturnValue({
    point: new Uint8Array(33).fill(3),
    secret: new Uint8Array(32).fill(4),
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
  mockSellerPreparePersistedPrelockedSwap.mockResolvedValue({
    adaptorPointCipher: "cipher-adaptor",
    lockedProofsCipher: "cipher-seller",
    adaptorPoint: {
      point: new Uint8Array(33).fill(3),
      secret: new Uint8Array(32).fill(4),
    },
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
  mockFetchOrderStatus.mockImplementation(
    async (marketId: string, orderId: string) => {
      const swap = Object.values(useActiveSwapsStore.getState().byTradeId).find(
        (candidate) =>
          candidate.marketId === marketId && candidate.orderId === orderId,
      );
      if (!swap) {
        return {
          orderId,
          marketId,
          status: "resting",
          remainingAmountSubunits: 100,
          filledAmountSubunits: 0,
          fills: [],
        };
      }
      return matchedOrderStatusForSwap(swap);
    },
  );
  mockLoadRecoverableGuiSwapSessions.mockResolvedValue([]);
  mockLoadRecoverableGuiTradeOperationPage.mockResolvedValue({
    tradeIds: [],
    nextCursor: null,
  });
  mockLoadGuiPendingTrades.mockImplementation(async (walletId: string) =>
    [...pendingTradeRows.values()].filter(
      (record) => record.walletId === walletId,
    ),
  );
  mockPersistGuiPendingTrade.mockImplementation(async (trade: PendingTrade) =>
    seedPendingTrade(trade),
  );
  mockRemoveGuiPendingTrade.mockImplementation(
    async (record: PendingTradeRecord) => {
      pendingTradeRows.delete(`${record.walletId}:${record.orderId}`);
      const state = usePendingTradesStore.getState();
      if (state.walletId !== record.walletId) return;
      const byOrderId = { ...state.byOrderId };
      delete byOrderId[record.orderId];
      usePendingTradesStore.setState({ walletId: record.walletId, byOrderId });
    },
  );
  mockLoadGuiSwapSessionStateUnderLock.mockImplementation(
    async (tradeId: string) => {
      const active = useActiveSwapsStore.getState().byTradeId[tradeId];
      return active
        ? {
            ...structuredClone(active),
            mintUrl: active.mintUrl ?? mockWalletState.activeMintUrl,
          }
        : null;
    },
  );
  mockGuiTradeRefundDueAtMs.mockImplementation(
    (swap: { role: string; sellerLocktime: number; buyerLocktime: number }) =>
      (swap.role === "seller" ? swap.sellerLocktime : swap.buyerLocktime) *
      1_000,
  );
  mockGuiTradeRefundEvidenceUnderLock.mockResolvedValue(null);
  mockPrepareGuiTradeRefundUnderLock.mockResolvedValue({
    kind: "no-locked-value",
  });
  mockSalvageGuiTradeRefundUnderLock.mockResolvedValue({ refund: [] });
  mockPersistGuiSwapSession.mockResolvedValue(undefined);
  mockPrepareGuiProofOperationWithSession.mockImplementation(async (input) => ({
    ...input,
    state: "prepared",
  }));
  mockCompleteGuiProofOperationWithSession.mockImplementation(
    async (operationId, resultProofs) => ({
      operationId,
      state: "completed",
      resultProofs,
    }),
  );
  mockRecoverGuiDurableTradeSession.mockImplementation(
    async (
      tradeId: string,
      input: { transport: { joinTrade: (id: string) => Promise<void> } },
    ) => {
      await input.transport.joinTrade(tradeId);
      return { sessions: [{ kind: "ready", tradeId }], orphans: [] };
    },
  );
  mockRecordGuiRecoveredProofOperationOutputs.mockResolvedValue(undefined);
  mockWithGuiSwapSessionOwnership.mockImplementation(
    async (_tradeId, action) => {
      const prior = mockOwnershipTail;
      let release!: () => void;
      mockOwnershipTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await prior;
      try {
        mockProfileLockDepth += 1;
        return await action({});
      } finally {
        mockProfileLockDepth -= 1;
        release();
      }
    },
  );
  mockTryWithGuiCustodyProfileLock.mockImplementation(
    async (action, expectedWalletId) => {
      if (!mockTryProfileLockAvailable) return { acquired: false };
      if (mockCurrentWalletId() !== expectedWalletId) {
        throw new Error("GUI wallet changed while awaiting custody ownership");
      }
      mockProfileLockDepth += 1;
      try {
        return {
          acquired: true,
          value: await action(
            {
              walletId: expectedWalletId,
              scope: { walletId: expectedWalletId },
            },
            {},
          ),
        };
      } finally {
        mockProfileLockDepth -= 1;
      }
    },
  );
  mockReleaseGuiCustodyAuthority.mockResolvedValue(undefined);
  mockGetGuiPendingSwapIntent.mockResolvedValue(null);
  mockLoadGuiPendingSwapIntents.mockResolvedValue([]);
  mockSubmitAdmittedGuiPendingSwapIntents.mockImplementation(
    async (
      requests: Array<{ create: () => Record<string, unknown> }>,
      submit: (intent: Record<string, unknown>) => Promise<void>,
    ) => {
      const intents = requests.map((request) => request.create());
      for (const intent of intents) await submit(intent);
      return intents.map((intent: object) => ({
        ...intent,
        submitted: true,
      }));
    },
  );
  mockSubmitOrder.mockResolvedValue({ orderId: "recovery-order" });
  mockSubmitEphemeralPubkey.mockResolvedValue(undefined);
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

const TEST_WALLET_ID = "aa".repeat(32);
const TEST_WALLET_B_ID = "bb".repeat(32);
const TEST_MNEMONIC_A =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const TEST_MNEMONIC_B =
  "legal winner thank year wave sausage worth useful legal winner thank yellow";
const pendingTradeRows = new Map<string, PendingTradeRecord>();

type PendingTradeSeed = Pick<
  PendingTrade,
  "orderId" | "marketId" | "submittedAt"
> &
  Partial<PendingTrade>;

function seedPendingTrade(trade: PendingTradeSeed): PendingTradeRecord {
  const walletId = mockCurrentWalletId();
  const record: PendingTradeRecord = {
    walletId,
    clientOrderId: `client-${trade.orderId}`,
    baseAsset: "sat",
    divisibility: 1_000,
    side: "Buy",
    tokenSide: "Outcome",
    priceSubunits: 500,
    amountSubunits: 1_000,
    timeInForce: "GTC",
    recoveryAttempt: 0,
    ...trade,
  };
  pendingTradeRows.set(`${walletId}:${trade.orderId}`, record);
  const state = usePendingTradesStore.getState();
  const byOrderId = state.walletId === walletId ? state.byOrderId : {};
  usePendingTradesStore.setState({
    walletId,
    byOrderId: { ...byOrderId, [trade.orderId]: record },
  });
  return record;
}

function matchedOrderStatusForSwap(swap: ActiveSwap) {
  if (!swap.orderId) throw new Error("test swap has no order id");
  return {
    orderId: swap.orderId,
    marketId: swap.marketId,
    status: "matched",
    remainingAmountSubunits: 0,
    filledAmountSubunits: swap.matchedAmountSubunits ?? 100,
    fills: [
      {
        id: `fill-${swap.tradeId}`,
        makerOrderId: swap.orderId,
        takerOrderId: `counterparty-${swap.orderId}`,
        amountSubunits: swap.matchedAmountSubunits ?? 100,
        executionPrice: swap.priceSubunits ?? 500,
        path: "Complementary" as const,
        status: "Matched" as const,
        baseAsset: "sat" as const,
        divisibility: swap.divisibility ?? 1_000,
        tokenSide: "Outcome" as const,
        filledAt: new Date().toISOString(),
        tradeId: swap.tradeId,
      },
    ],
  };
}

function seedSettlementCompletePending(
  tradeId: string,
  orderId = `order-${tradeId}`,
): ActiveSwap {
  const swaps = useActiveSwapsStore.getState();
  swaps.promote({
    tradeId,
    orderId,
    marketId: "cond-YES",
    ephemeralPrivkeyHex: "11".repeat(32),
    ephemeralPubkeyHex: "02" + "22".repeat(32),
  });
  swaps.setRoleAndCounterparty(tradeId, "seller", "02" + "33".repeat(32), {
    sellerLocktime: Math.floor(Date.now() / 1_000) + 120,
    buyerLocktime: Math.floor(Date.now() / 1_000) + 60,
  });
  swaps.setStep(tradeId, "awaiting-confirmation");
  swaps.setSettlementCompleteDelivery(tradeId, "pending");
  return useActiveSwapsStore.getState().byTradeId[tradeId];
}

async function flushAsyncWork(steps = 16): Promise<void> {
  await act(async () => {
    for (let index = 0; index < steps; index += 1) await Promise.resolve();
  });
}

async function renderHydratedTradeSettlement() {
  const priorRenderCount = mockUseTradeHub.mock.calls.length;
  const rendered = renderHook(() => useTradeSettlement(true));
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
  expect(mockUseTradeHub.mock.calls.length).toBeGreaterThan(
    priorRenderCount + 1,
  );
  return rendered;
}

describe("useTradeSettlement", () => {
  it("does not start the private TradeHub when no swap is active", async () => {
    await renderHydratedTradeSettlement();

    expect(mockUseTradeHub).toHaveBeenCalledWith(false, expect.any(Object));
    expect(mockJoinOrder).not.toHaveBeenCalled();
    expect(mockJoinTrade).not.toHaveBeenCalled();
  });

  it("connects and joins only after an active swap is promoted", async () => {
    await renderHydratedTradeSettlement();

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

  it("runs the SDK durable coordinator before any hydrated swap continuation", async () => {
    await renderHydratedTradeSettlement();

    await act(async () => {
      useActiveSwapsStore.getState().promote({
        tradeId: "trade-coordinator",
        orderId: "order-1",
        marketId: "market-1",
        ephemeralPrivkeyHex: "11".repeat(32),
        ephemeralPubkeyHex: "22".repeat(32),
      });
    });

    await waitFor(() =>
      expect(mockRecoverGuiDurableTradeSession).toHaveBeenCalledWith(
        "trade-coordinator",
        expect.objectContaining({
          mint: expect.any(Object),
          transport: expect.any(Object),
        }),
      ),
    );
  });

  it("pages past native wallet work and fails closed an orphaned trade operation", async () => {
    mockLoadRecoverableGuiTradeOperationPage
      .mockResolvedValueOnce({ tradeIds: [], nextCursor: "wallet-cursor" })
      .mockResolvedValueOnce({
        tradeIds: ["trade-orphan-operation"],
        nextCursor: null,
      });
    mockRecoverGuiDurableTradeSession.mockResolvedValueOnce({
      sessions: [],
      orphans: [
        {
          kind: "failed-closed",
          operationId: "orphan-operation",
          reason: "missing-session",
        },
      ],
    });

    await renderHydratedTradeSettlement();

    await waitFor(() =>
      expect(mockRecoverGuiDurableTradeSession).toHaveBeenCalledWith(
        "trade-orphan-operation",
        expect.any(Object),
      ),
    );
    expect(mockLoadRecoverableGuiTradeOperationPage.mock.calls).toEqual([
      [TEST_WALLET_ID, null],
      [TEST_WALLET_ID, "wallet-cursor"],
    ]);
    expect(mockJoinTrade).not.toHaveBeenCalledWith("trade-orphan-operation");
    expect(
      useActiveSwapsStore.getState().byTradeId["trade-orphan-operation"],
    ).toBeUndefined();
  });

  it("replays active trade recovery after a hub reconnect", async () => {
    await renderHydratedTradeSettlement();

    await act(async () => {
      useActiveSwapsStore.getState().promote({
        tradeId: "trade-reconnect",
        orderId: "order-reconnect",
        marketId: "market-1",
        ephemeralPrivkeyHex: "11".repeat(32),
        ephemeralPubkeyHex: "22".repeat(32),
      });
    });
    await waitFor(() => expect(mockJoinTrade).toHaveBeenCalledTimes(1));

    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onReconnected?: () => void;
    };
    await act(async () => callbacks.onReconnected?.());

    await waitFor(() => expect(mockJoinTrade).toHaveBeenCalledTimes(2));
  });

  it("recovers the durable settlement-complete intent after commit-before-send", async () => {
    const tradeId = "trade-settlement-delivery";
    const swaps = useActiveSwapsStore.getState();
    swaps.promote({
      tradeId,
      orderId: "order-settlement-delivery",
      marketId: "cond-YES",
      ephemeralPrivkeyHex: "11".repeat(32),
      ephemeralPubkeyHex: "02" + "22".repeat(32),
    });
    swaps.setRoleAndCounterparty(tradeId, "seller", "02" + "33".repeat(32), {
      sellerLocktime: Math.floor(Date.now() / 1_000) + 120,
      buyerLocktime: Math.floor(Date.now() / 1_000) + 60,
    });
    swaps.setStep(tradeId, "awaiting-confirmation");
    swaps.setSettlementCompleteDelivery(tradeId, "pending");

    await renderHydratedTradeSettlement();

    await waitFor(() =>
      expect(mockSendSwapMessage).toHaveBeenCalledWith(
        tradeId,
        "settlement-complete",
        "",
      ),
    );
    await waitFor(() =>
      expect(
        useActiveSwapsStore.getState().byTradeId[tradeId]
          .settlementCompleteDelivery,
      ).toBe("delivered"),
    );
    expect(
      mockLoadGuiSwapSessionStateUnderLock.mock.invocationCallOrder.some(
        (callOrder) =>
          callOrder < mockSendSwapMessage.mock.invocationCallOrder.at(-1)!,
      ),
    ).toBe(true);
    expect(mockSendProfileLockDepths).toEqual([0]);
  });

  it("reconciles a filled exact fill after ACK loss without replaying settlement-complete", async () => {
    // This durable pending row is the restart state after the engine accepted
    // the prior message but the browser lost its transport acknowledgement.
    const tradeId = "trade-settlement-ack-lost";
    const orderId = "order-settlement-ack-lost";
    const marketId = "cond-YES";
    const swaps = useActiveSwapsStore.getState();
    swaps.promote({
      tradeId,
      orderId,
      marketId,
      ephemeralPrivkeyHex: "11".repeat(32),
      ephemeralPubkeyHex: "02" + "22".repeat(32),
    });
    swaps.setRoleAndCounterparty(tradeId, "seller", "02" + "33".repeat(32), {
      sellerLocktime: Math.floor(Date.now() / 1_000) + 120,
      buyerLocktime: Math.floor(Date.now() / 1_000) + 60,
    });
    swaps.setStep(tradeId, "awaiting-confirmation");
    swaps.setSettlementCompleteDelivery(tradeId, "pending");
    mockFetchOrderStatus.mockResolvedValue({
      orderId,
      marketId,
      status: "filled",
      remainingAmountSubunits: 0,
      filledAmountSubunits: 100,
      fills: [
        {
          id: "fill-settlement-ack-lost",
          makerOrderId: orderId,
          takerOrderId: "counterparty-order",
          amountSubunits: 100,
          executionPrice: 500,
          path: "Complementary",
          status: "Filled",
          baseAsset: "sat",
          divisibility: 1_000,
          tokenSide: "Outcome",
          filledAt: new Date().toISOString(),
          tradeId,
        },
      ],
    });

    await renderHydratedTradeSettlement();
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });

    expect(mockSendSwapMessage).not.toHaveBeenCalled();
    expect(useActiveSwapsStore.getState().byTradeId[tradeId]?.step).toBe(
      "completed",
    );
  });

  it("fails closed when the authorized status has no exact fill", async () => {
    vi.useFakeTimers();
    const tradeId = "trade-status-fill-mismatch";
    const swap = seedSettlementCompletePending(tradeId);
    const status = matchedOrderStatusForSwap(swap);
    mockFetchOrderStatus.mockResolvedValue({
      ...status,
      fills: [{ ...status.fills[0], tradeId: "foreign-trade" }],
    });

    await renderHydratedTradeSettlement();
    await flushAsyncWork();

    expect(mockFetchOrderStatus).toHaveBeenCalledWith(
      swap.marketId,
      swap.orderId,
    );
    expect(mockSendSwapMessage).not.toHaveBeenCalled();
    expect(useActiveSwapsStore.getState().byTradeId[tradeId]?.step).toBe(
      "awaiting-confirmation",
    );
    const initialFetches = mockFetchOrderStatus.mock.calls.length;

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    await flushAsyncWork();

    expect(mockFetchOrderStatus.mock.calls.length).toBeGreaterThan(
      initialFetches,
    );
    expect(mockSendSwapMessage).not.toHaveBeenCalled();
    for (const delayMs of [2_000, 5_000, 10_000, 30_000]) {
      await act(async () => vi.advanceTimersByTimeAsync(delayMs));
      await flushAsyncWork();
    }
    const boundedFetches = mockFetchOrderStatus.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    await flushAsyncWork();
    expect(mockFetchOrderStatus).toHaveBeenCalledTimes(boundedFetches);
    vi.useRealTimers();
  });

  it("retries unavailable authorized status before replaying", async () => {
    vi.useFakeTimers();
    const tradeId = "trade-status-unavailable";
    const swap = seedSettlementCompletePending(tradeId);
    mockFetchOrderStatus
      .mockRejectedValueOnce(new Error("failed to fetch"))
      .mockResolvedValue(matchedOrderStatusForSwap(swap));

    await renderHydratedTradeSettlement();
    await flushAsyncWork();
    expect(mockFetchOrderStatus).toHaveBeenCalledTimes(1);
    expect(mockSendSwapMessage).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(250));
    await flushAsyncWork();

    expect(mockFetchOrderStatus).toHaveBeenCalledTimes(2);
    expect(mockSendSwapMessage).toHaveBeenCalledWith(
      tradeId,
      "settlement-complete",
      "",
    );
    vi.useRealTimers();
  });

  it("moves an exact failed fill to refund recovery without replaying", async () => {
    const tradeId = "trade-status-failed";
    const swap = seedSettlementCompletePending(tradeId);
    const status = matchedOrderStatusForSwap(swap);
    mockFetchOrderStatus.mockResolvedValue({
      ...status,
      status: "failed",
      fills: [{ ...status.fills[0], status: "Failed" }],
    });

    await renderHydratedTradeSettlement();
    await flushAsyncWork();

    expect(mockSendSwapMessage).not.toHaveBeenCalled();
    expect(useActiveSwapsStore.getState().byTradeId[tradeId]?.step).toBe(
      "awaiting-refund",
    );
  });

  it("leaves collected durable ciphers pending when the delivery snapshot lock is busy", async () => {
    const tradeId = "trade-collected-outbox-busy";
    const swaps = useActiveSwapsStore.getState();
    swaps.promote({
      tradeId,
      orderId: "order-collected-outbox-busy",
      marketId: "cond-YES",
      ephemeralPrivkeyHex: "11".repeat(32),
      ephemeralPubkeyHex: "02" + "22".repeat(32),
    });
    swaps.setRoleAndCounterparty(tradeId, "seller", "02" + "33".repeat(32), {
      sellerLocktime: Math.floor(Date.now() / 1_000) + 120,
      buyerLocktime: Math.floor(Date.now() / 1_000) + 60,
    });
    swaps.setSellerState(tradeId, {
      adaptorPoint: {
        point: new Uint8Array(33).fill(3),
        secret: new Uint8Array(32).fill(4),
      },
      adaptorPointCipher: "durable-adaptor-cipher",
      lockedProofsCipher: "durable-seller-cipher",
    });
    mockRecoverGuiDurableTradeSession.mockImplementation(
      async (
        id: string,
        input: {
          transport: {
            joinTrade: (value: string) => Promise<void>;
            sendCipher: (
              value: string,
              messageType: "adaptor-point" | "locked-proofs-seller",
              ciphertext: string,
            ) => Promise<void>;
          };
        },
      ) => {
        await input.transport.joinTrade(id);
        await input.transport.sendCipher(
          id,
          "adaptor-point",
          "durable-adaptor-cipher",
        );
        await input.transport.sendCipher(
          id,
          "locked-proofs-seller",
          "durable-seller-cipher",
        );
        return { sessions: [{ kind: "replayed", tradeId: id }], orphans: [] };
      },
    );
    mockTryProfileLockAvailable = false;

    const firstMount = await renderHydratedTradeSettlement();
    await waitFor(() =>
      expect(mockRecoverGuiDurableTradeSession).toHaveBeenCalledWith(
        tradeId,
        expect.any(Object),
      ),
    );
    await act(async () => {
      for (let index = 0; index < 4; index += 1) await Promise.resolve();
    });
    expect(mockSendSwapMessage).not.toHaveBeenCalled();

    mockTryProfileLockAvailable = true;
    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onReconnected?: () => void;
    };
    await act(async () => callbacks.onReconnected?.());
    firstMount.unmount();
    mockOwnershipTail = Promise.resolve();
    mockProfileLockDepth = 0;
    await renderHydratedTradeSettlement();
    await waitFor(() => expect(mockSendSwapMessage).toHaveBeenCalledTimes(2));
    expect(mockSendSwapMessage.mock.calls).toEqual([
      [tradeId, "adaptor-point", "durable-adaptor-cipher"],
      [tradeId, "locked-proofs-seller", "durable-seller-cipher"],
    ]);
    expect(mockSendProfileLockDepths).toEqual([0, 0]);
    expect(mockRecoverGuiDurableTradeSession.mock.calls.length).toBeGreaterThan(
      1,
    );
  });

  it("rejects a substituted durable recovery cipher before transport", async () => {
    const tradeId = "trade-substituted-outbox";
    const swaps = useActiveSwapsStore.getState();
    swaps.promote({
      tradeId,
      orderId: "order-substituted-outbox",
      marketId: "cond-YES",
      ephemeralPrivkeyHex: "11".repeat(32),
      ephemeralPubkeyHex: "02" + "22".repeat(32),
    });
    swaps.setRoleAndCounterparty(tradeId, "seller", "02" + "33".repeat(32), {
      sellerLocktime: Math.floor(Date.now() / 1_000) + 120,
      buyerLocktime: Math.floor(Date.now() / 1_000) + 60,
    });
    swaps.setSellerState(tradeId, {
      adaptorPoint: {
        point: new Uint8Array(33).fill(3),
        secret: new Uint8Array(32).fill(4),
      },
      adaptorPointCipher: "persisted-adaptor-cipher",
      lockedProofsCipher: "persisted-seller-cipher",
    });
    mockRecoverGuiDurableTradeSession.mockImplementationOnce(
      async (
        id: string,
        input: {
          transport: {
            sendCipher: (
              value: string,
              messageType: "adaptor-point",
              ciphertext: string,
            ) => Promise<void>;
          };
        },
      ) => {
        await input.transport.sendCipher(
          id,
          "adaptor-point",
          "substituted-adaptor-cipher",
        );
        return { sessions: [{ kind: "replayed", tradeId: id }], orphans: [] };
      },
    );

    await renderHydratedTradeSettlement();
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });

    expect(mockSendSwapMessage).not.toHaveBeenCalledWith(
      tradeId,
      "adaptor-point",
      "substituted-adaptor-cipher",
    );
  });

  it("does not mark settlement delivery under a different seed after send", async () => {
    const tradeId = "trade-settlement-seed-switch";
    const swaps = useActiveSwapsStore.getState();
    swaps.promote({
      tradeId,
      orderId: "order-settlement-seed-switch",
      marketId: "cond-YES",
      ephemeralPrivkeyHex: "11".repeat(32),
      ephemeralPubkeyHex: "02" + "22".repeat(32),
    });
    swaps.setRoleAndCounterparty(tradeId, "seller", "02" + "33".repeat(32), {
      sellerLocktime: Math.floor(Date.now() / 1_000) + 120,
      buyerLocktime: Math.floor(Date.now() / 1_000) + 60,
    });
    swaps.setStep(tradeId, "awaiting-confirmation");
    swaps.setSettlementCompleteDelivery(tradeId, "pending");
    mockSendSwapMessage.mockImplementationOnce(async () => {
      mockSendProfileLockDepths.push(mockProfileLockDepth);
      mockCurrentWalletId.mockReturnValue(TEST_WALLET_B_ID);
      mockWalletState.mnemonic = TEST_MNEMONIC_B;
    });

    await renderHydratedTradeSettlement();
    await waitFor(() => expect(mockSendSwapMessage).toHaveBeenCalledTimes(1));
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });

    expect(mockSendProfileLockDepths).toEqual([0]);
    expect(
      mockPersistGuiSwapSession.mock.calls.some(
        ([candidate]) =>
          candidate.tradeId === tradeId &&
          candidate.settlementCompleteDelivery === "delivered",
      ),
    ).toBe(false);
  });

  it("does not resend adapter ciphertext after the SDK outbox replay", async () => {
    const tradeId = "trade-sdk-outbox-only";
    const swaps = useActiveSwapsStore.getState();
    swaps.promote({
      tradeId,
      orderId: "order-sdk-outbox-only",
      marketId: "cond-YES",
      ephemeralPrivkeyHex: "11".repeat(32),
      ephemeralPubkeyHex: "02" + "22".repeat(32),
    });
    swaps.setRoleAndCounterparty(tradeId, "seller", "02" + "33".repeat(32), {
      sellerLocktime: Math.floor(Date.now() / 1_000) + 120,
      buyerLocktime: Math.floor(Date.now() / 1_000) + 60,
    });
    swaps.setSellerState(tradeId, {
      adaptorPoint: {
        point: new Uint8Array(33).fill(3),
        secret: new Uint8Array(32).fill(4),
      },
      adaptorPointCipher: "durable-adaptor-cipher",
      lockedProofsCipher: "durable-seller-cipher",
    });
    mockRecoverGuiDurableTradeSession.mockImplementationOnce(
      async (
        id: string,
        input: { transport: { joinTrade: (value: string) => Promise<void> } },
      ) => {
        await input.transport.joinTrade(id);
        return { sessions: [{ kind: "replayed", tradeId: id }], orphans: [] };
      },
    );

    await renderHydratedTradeSettlement();
    await waitFor(() =>
      expect(mockRecoverGuiDurableTradeSession).toHaveBeenCalledWith(
        tradeId,
        expect.any(Object),
      ),
    );
    await act(async () => {
      for (let index = 0; index < 4; index += 1) await Promise.resolve();
    });

    expect(mockSendSwapMessage).not.toHaveBeenCalled();
    expect(mockSellerPreparePersistedPrelockedSwap).not.toHaveBeenCalled();
  });

  it("stops durable outbox effects when the active seed changes mid-replay", async () => {
    const tradeId = "trade-seed-switch-mid-replay";
    const sendLockDepths: number[] = [];
    const swaps = useActiveSwapsStore.getState();
    swaps.promote({
      tradeId,
      orderId: "order-seed-switch-mid-replay",
      marketId: "cond-YES",
      ephemeralPrivkeyHex: "11".repeat(32),
      ephemeralPubkeyHex: "02" + "22".repeat(32),
    });
    swaps.setRoleAndCounterparty(tradeId, "seller", "02" + "33".repeat(32), {
      sellerLocktime: Math.floor(Date.now() / 1_000) + 120,
      buyerLocktime: Math.floor(Date.now() / 1_000) + 60,
    });
    swaps.setSellerState(tradeId, {
      adaptorPoint: {
        point: new Uint8Array(33).fill(3),
        secret: new Uint8Array(32).fill(4),
      },
      adaptorPointCipher: "cipher-one",
      lockedProofsCipher: "cipher-two",
    });
    mockSendSwapMessage.mockImplementationOnce(async () => {
      sendLockDepths.push(mockProfileLockDepth);
      mockCurrentWalletId.mockReturnValue(TEST_WALLET_B_ID);
      throw new Error("failed to fetch");
    });
    mockRecoverGuiDurableTradeSession.mockImplementationOnce(
      async (
        id: string,
        input: {
          transport: {
            sendCipher: (
              tradeId: string,
              messageType: "adaptor-point" | "locked-proofs-seller",
              ciphertext: string,
            ) => Promise<void>;
          };
        },
      ) => {
        await input.transport.sendCipher(id, "adaptor-point", "cipher-one");
        await input.transport.sendCipher(
          id,
          "locked-proofs-seller",
          "cipher-two",
        );
        return { sessions: [{ kind: "replayed", tradeId: id }], orphans: [] };
      },
    );

    await renderHydratedTradeSettlement();
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });

    expect(mockSendSwapMessage).toHaveBeenCalledTimes(1);
    expect(mockSendSwapMessage).toHaveBeenCalledWith(
      tradeId,
      "adaptor-point",
      "cipher-one",
    );
    expect(mockSendSwapMessage).not.toHaveBeenCalledWith(
      tradeId,
      "locked-proofs-seller",
      "cipher-two",
    );
    expect(sendLockDepths).toEqual([0]);
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
    await renderHydratedTradeSettlement();
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
    seedPendingTrade({
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

    await renderHydratedTradeSettlement();

    await waitFor(() =>
      expect(mockJoinOrder).toHaveBeenCalledWith("cond-YES", "order-pending"),
    );
  });

  it("keeps A recovery inert under B and resumes A after seed re-entry", async () => {
    const staleStatus = deferred<{
      orderId: string;
      marketId: string;
      status: string;
      tradeId: string;
      deadline: string;
      remainingAmountSubunits: number;
      filledAmountSubunits: number;
      fills: { tradeId: string }[];
    }>();
    seedPendingTrade({
      orderId: "order-wallet-a",
      marketId: "cond-YES",
      clientOrderId: "client-wallet-a",
      submittedAt: Date.now(),
    });
    mockFetchOrderStatus.mockImplementationOnce(() => staleStatus.promise);

    const rendered = await renderHydratedTradeSettlement();
    await waitFor(() => expect(mockFetchOrderStatus).toHaveBeenCalledTimes(1));
    expect(mockJoinOrder).not.toHaveBeenCalled();

    mockCurrentWalletId.mockReturnValue(TEST_WALLET_B_ID);
    mockWalletState.mnemonic = TEST_MNEMONIC_B;
    rendered.rerender();
    await waitFor(() =>
      expect(usePendingTradesStore.getState()).toEqual({
        walletId: TEST_WALLET_B_ID,
        byOrderId: {},
      }),
    );

    staleStatus.resolve({
      orderId: "order-wallet-a",
      marketId: "cond-YES",
      status: "Matched",
      tradeId: "trade-wallet-a",
      deadline: "2099-01-01T00:00:00.000Z",
      remainingAmountSubunits: 0,
      filledAmountSubunits: 100,
      fills: [{ tradeId: "trade-wallet-a" }],
    });
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });

    expect(mockJoinOrder).not.toHaveBeenCalled();
    expect(mockJoinTrade).not.toHaveBeenCalled();
    expect(mockSubmitAdmittedGuiPendingSwapIntents).not.toHaveBeenCalled();
    expect(mockSubmitEphemeralPubkey).not.toHaveBeenCalled();
    expect(mockGetUnitProofs).not.toHaveBeenCalled();
    expect(mockGetOutcomeProofs).not.toHaveBeenCalled();
    expect(mockPrepareProofOperation).not.toHaveBeenCalled();
    expect(mockTryReserveProofs).not.toHaveBeenCalled();
    expect(mockSellerLockOutcomeProofs).not.toHaveBeenCalled();
    expect(mockBuyerPrepareSwap).not.toHaveBeenCalled();
    expect(mockSendSwapMessage).not.toHaveBeenCalled();
    expect(useActiveSwapsStore.getState().byTradeId).toEqual({});

    mockFetchOrderStatus.mockResolvedValue({
      orderId: "order-wallet-a",
      marketId: "cond-YES",
      status: "resting",
      remainingAmountSubunits: 100,
      filledAmountSubunits: 0,
      fills: [],
    });
    mockCurrentWalletId.mockReturnValue(TEST_WALLET_ID);
    mockWalletState.mnemonic = TEST_MNEMONIC_A;
    rendered.rerender();

    await waitFor(() =>
      expect(mockJoinOrder).toHaveBeenCalledWith("cond-YES", "order-wallet-a"),
    );
    expect(
      usePendingTradesStore.getState().byOrderId["order-wallet-a"]?.walletId,
    ).toBe(TEST_WALLET_ID);
  });

  it("publishes and joins TradeCreated only after its durable commit", async () => {
    const tradeId = "trade-created-commit-fault";
    seedPendingTrade({
      orderId: "order-created-commit-fault",
      marketId: "cond-YES",
      clientOrderId: "client-created-commit-fault",
      side: "Buy",
      tokenSide: "Outcome",
      priceSubunits: 500,
      amountSubunits: 1_000_000,
      baseAsset: "sat",
      divisibility: 1_000,
      submittedAt: Date.now(),
    });
    await renderHydratedTradeSettlement();
    seedPendingPubkey(tradeId, "order-created-commit-fault");
    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onTradeCreated: (payload: {
        tradeId: string;
        sellerPubkey: string;
        buyerPubkey: string;
        sellerLocktime: string;
        buyerLocktime: string;
        marketId: string;
        baseAsset: string;
        divisibility: number;
        outcomeFaceAmountSubunits: number;
        quotePaymentSubunits: number;
      }) => void;
    };
    const payload = {
      tradeId,
      sellerPubkey: "02" + "33".repeat(32),
      buyerPubkey: "02" + "22".repeat(32),
      sellerLocktime: new Date(Date.now() + 120_000).toISOString(),
      buyerLocktime: new Date(Date.now() + 60_000).toISOString(),
      marketId: "cond-YES",
      baseAsset: "sat",
      divisibility: 1_000,
      outcomeFaceAmountSubunits: 1_000_000,
      quotePaymentSubunits: 500_000,
    };
    mockPersistGuiSwapSession.mockRejectedValueOnce(
      new DOMException("quota exhausted", "QuotaExceededError"),
    );

    await act(async () => callbacks.onTradeCreated(payload));
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });

    expect(useActiveSwapsStore.getState().byTradeId[tradeId]).toBeUndefined();
    expect(mockSendSwapMessage).not.toHaveBeenCalled();
    expect(mockBuyerPrepareSwap).not.toHaveBeenCalled();
    expect(mockSellerLockOutcomeProofs).not.toHaveBeenCalled();

    await waitFor(() => expect(mockJoinTrade).toHaveBeenCalledWith(tradeId));

    callbacks.onTradeCreated(payload);
    await waitFor(() =>
      expect(useActiveSwapsStore.getState().byTradeId[tradeId]?.role).toBe(
        "buyer",
      ),
    );
    await waitFor(() => expect(mockJoinTrade).toHaveBeenCalledWith(tradeId));
    expect(
      usePendingPubkeySubmissionsStore.getState().byTradeId[tradeId],
    ).toBeUndefined();
    expect(
      mockPersistGuiSwapSession.mock.invocationCallOrder.at(-1),
    ).toBeLessThan(mockJoinTrade.mock.invocationCallOrder.at(-1)!);
  });

  it("publishes an inbound cipher only after commit and accepts its replay", async () => {
    const tradeId = "trade-cipher-commit-fault";
    const swaps = useActiveSwapsStore.getState();
    swaps.promote({
      tradeId,
      orderId: "order-cipher-commit-fault",
      marketId: "cond-YES",
      ephemeralPrivkeyHex: "11".repeat(32),
      ephemeralPubkeyHex: "02" + "22".repeat(32),
      baseAsset: "sat",
      divisibility: 1_000,
    });
    swaps.setRoleAndCounterparty(
      tradeId,
      "buyer",
      "02" + "33".repeat(32),
      {
        sellerLocktime: Math.floor(Date.now() / 1_000) + 120,
        buyerLocktime: Math.floor(Date.now() / 1_000) + 60,
      },
      {
        baseAsset: "sat",
        divisibility: 1_000,
        outcomeFaceAmountSubunits: 1_000,
        quotePaymentSubunits: 500,
      },
    );
    await renderHydratedTradeSettlement();
    mockPersistGuiSwapSession.mockClear();
    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onSwapMessageReceived: (message: {
        tradeId: string;
        messageType: string;
        ciphertext: string;
      }) => void;
    };
    const message = {
      tradeId,
      messageType: "adaptor-point",
      ciphertext: "cipher-adaptor-fault",
    };
    mockPersistGuiSwapSession.mockRejectedValueOnce(
      new DOMException("transaction aborted", "AbortError"),
    );

    callbacks.onSwapMessageReceived(message);
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });

    expect(
      useActiveSwapsStore.getState().byTradeId[tradeId]?.messages.adaptorPoint,
    ).toBeUndefined();
    expect(mockBuyerPrepareSwap).not.toHaveBeenCalled();
    expect(mockSendSwapMessage).not.toHaveBeenCalled();

    callbacks.onSwapMessageReceived(message);
    await waitFor(() =>
      expect(
        useActiveSwapsStore.getState().byTradeId[tradeId]?.messages
          .adaptorPoint,
      ).toBe("cipher-adaptor-fault"),
    );
    expect(mockPersistGuiSwapSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tradeId,
        messages: expect.objectContaining({
          adaptorPoint: "cipher-adaptor-fault",
        }),
      }),
      "https://mint.example",
    );
  });

  it("uses the exact durable session instead of a stale active-swap projection", async () => {
    await renderHydratedTradeSettlement();
    const tradeId = "trade-stale-projection";
    const swaps = useActiveSwapsStore.getState();
    swaps.promote({
      tradeId,
      orderId: "order-stale-projection",
      marketId: "cond-YES",
      ephemeralPrivkeyHex: "11".repeat(32),
      ephemeralPubkeyHex: "02" + "22".repeat(32),
      baseAsset: "sat",
      divisibility: 1_000,
    });
    swaps.setRoleAndCounterparty(
      tradeId,
      "buyer",
      "02" + "33".repeat(32),
      {
        sellerLocktime: Math.floor(Date.now() / 1_000) + 120,
        buyerLocktime: Math.floor(Date.now() / 1_000) + 60,
      },
      {
        baseAsset: "sat",
        divisibility: 1_000,
        outcomeFaceAmountSubunits: 1_000,
        quotePaymentSubunits: 500,
      },
    );
    const exact = structuredClone(
      useActiveSwapsStore.getState().byTradeId[tradeId],
    );
    exact.step = "awaiting-refund";
    exact.error = "engine terminal";
    mockLoadGuiSwapSessionStateUnderLock.mockResolvedValue(exact);
    mockPersistGuiSwapSession.mockClear();

    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onSwapMessageReceived: (message: {
        tradeId: string;
        messageType: string;
        ciphertext: string;
      }) => void;
    };
    callbacks.onSwapMessageReceived({
      tradeId,
      messageType: "adaptor-point",
      ciphertext: "must-not-be-published",
    });
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });

    expect(mockPersistGuiSwapSession).not.toHaveBeenCalled();
    expect(mockBuyerPrepareSwap).not.toHaveBeenCalled();
    expect(mockSendSwapMessage).not.toHaveBeenCalledWith(
      tradeId,
      "adaptor-point",
      expect.any(String),
    );
  });

  it("retains an engine-terminal swap for exact refund recovery", async () => {
    const tradeId = "trade-engine-terminal-recovery";
    const swaps = useActiveSwapsStore.getState();
    swaps.promote({
      tradeId,
      orderId: "order-engine-terminal-recovery",
      marketId: "cond-YES",
      ephemeralPrivkeyHex: "11".repeat(32),
      ephemeralPubkeyHex: "02" + "22".repeat(32),
      baseAsset: "sat",
      divisibility: 1_000,
    });
    swaps.setRoleAndCounterparty(
      tradeId,
      "seller",
      "02" + "33".repeat(32),
      {
        sellerLocktime: Math.floor(Date.now() / 1_000) + 120,
        buyerLocktime: Math.floor(Date.now() / 1_000) + 60,
      },
      { baseAsset: "sat", divisibility: 1_000 },
    );
    await renderHydratedTradeSettlement();
    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onTradeStateChanged: (id: string, state: string, reason?: string) => void;
    };

    callbacks.onTradeStateChanged(tradeId, "Failed", "engine-terminal");

    await waitFor(() =>
      expect(useActiveSwapsStore.getState().byTradeId[tradeId]?.step).toBe(
        "awaiting-refund",
      ),
    );
    expect(mockPersistGuiSwapSession).toHaveBeenCalledWith(
      expect.objectContaining({ tradeId, step: "awaiting-refund" }),
      "https://mint.example",
    );
    expect(useActiveSwapsStore.getState().byTradeId[tradeId]).toBeDefined();
  });

  it("wakes at the own locktime and salvages the exact refund through the SDK", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
    const tradeId = "trade-automatic-refund";
    const ownLocktime = Math.floor(Date.now() / 1_000) + 5;
    const swaps = useActiveSwapsStore.getState();
    swaps.promote({
      tradeId,
      orderId: "order-automatic-refund",
      marketId: "cond-YES",
      ephemeralPrivkeyHex: "11".repeat(32),
      ephemeralPubkeyHex: "02" + "22".repeat(32),
    });
    swaps.setRoleAndCounterparty(tradeId, "seller", "02" + "33".repeat(32), {
      sellerLocktime: ownLocktime,
      buyerLocktime: ownLocktime - 1,
    });
    swaps.setStep(tradeId, "awaiting-refund");
    const refundOperation = {
      operationId: "durable-refund-operation",
      operationKey: `${tradeId}/browser/expired-refund`,
      tradeId,
      role: "seller" as const,
      stage: "refund" as const,
      state: "mint-submitted" as const,
    };
    let refundPrepared = false;
    mockPrepareGuiTradeRefundUnderLock
      .mockResolvedValueOnce({
        kind: "not-due",
        retryAtMs: ownLocktime * 1_000,
      })
      .mockImplementationOnce(async () => {
        refundPrepared = true;
        return { kind: "ready", operation: refundOperation };
      });
    mockGuiTradeRefundEvidenceUnderLock.mockResolvedValue({
      proofOperation: refundOperation,
    });
    mockRecoverGuiDurableTradeSession.mockImplementation(
      async (
        id: string,
        input: {
          mint: {
            inspect: (operation: typeof refundOperation) => Promise<unknown>;
            getRefundSalvageEvidence: (
              operation: typeof refundOperation,
            ) => Promise<unknown>;
            salvageExpiredRefund: (
              operation: typeof refundOperation,
            ) => Promise<void>;
          };
        },
      ) => {
        if (refundPrepared) {
          expect(await input.mint.inspect(refundOperation)).toEqual({
            kind: "expired-refund-salvage",
          });
          await input.mint.getRefundSalvageEvidence(refundOperation);
          await input.mint.salvageExpiredRefund(refundOperation);
        }
        return { sessions: [{ kind: "ready", tradeId: id }], orphans: [] };
      },
    );

    await renderHydratedTradeSettlement();
    await act(async () => {});
    expect(mockPrepareGuiTradeRefundUnderLock).toHaveBeenCalledTimes(1);
    expect(useActiveSwapsStore.getState().byTradeId[tradeId]?.step).toBe(
      "awaiting-refund",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });

    expect(mockPrepareGuiTradeRefundUnderLock).toHaveBeenCalledTimes(2);
    expect(mockGuiTradeRefundEvidenceUnderLock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tradeId, step: "awaiting-refund" }),
      refundOperation,
    );
    expect(mockSalvageGuiTradeRefundUnderLock).toHaveBeenCalledWith(
      expect.objectContaining({ tradeId, step: "awaiting-refund" }),
      refundOperation,
      "aa".repeat(32),
    );
    expect(mockRecordGuiRecoveredProofOperationOutputs).toHaveBeenCalledWith(
      tradeId,
      refundOperation.operationId,
      { refund: [] },
    );
    expect(useActiveSwapsStore.getState().byTradeId[tradeId]?.step).toBe(
      "Failed",
    );
  });

  it("replays pending order joins during status recovery", async () => {
    vi.useFakeTimers();
    seedPendingTrade({
      orderId: "order-pending",
      marketId: "cond-YES",
      clientOrderId: "client-order-pending",
      submittedAt: Date.now(),
    });
    seedPendingPubkey("trade-status-retry");
    seedPendingPubkey("trade-status-retry");

    await renderHydratedTradeSettlement();

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
    seedPendingTrade({
      orderId: "order-pending",
      marketId: "cond-YES",
      clientOrderId: "client-order-pending",
      submittedAt: Date.now(),
    });
    seedPendingPubkey("trade-status-retry");

    await renderHydratedTradeSettlement();

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
    seedPendingTrade({
      orderId: "order-pending",
      marketId: "cond-YES",
      clientOrderId: "client-order-pending",
      submittedAt: Date.now(),
    });

    await renderHydratedTradeSettlement();

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
    seedPendingTrade({
      orderId: "order-pending",
      marketId: "cond-YES",
      clientOrderId: "client-order-pending",
      submittedAt: Date.now(),
    });

    await renderHydratedTradeSettlement();

    await act(async () => {});
    expect(mockJoinOrder).toHaveBeenCalledWith("cond-YES", "order-pending");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(mockJoinOrder).toHaveBeenCalledWith("cond-YES", "order-pending");
  });

  it("promotes an unsolicited TradeCreated event for a pending mint order", async () => {
    seedPendingTrade({
      orderId: "order-pending",
      marketId: "cond-NO",
      clientOrderId: "client-order-pending",
      side: "Buy",
      tokenSide: "Outcome",
      priceSubunits: 500,
      amountSubunits: 1_000_000,
      submittedAt: Date.now(),
    });

    await renderHydratedTradeSettlement();

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
    await waitFor(() =>
      expect(
        useActiveSwapsStore.getState().byTradeId["trade-pending"]?.role,
      ).toBe("buyer"),
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
    seedPendingTrade({
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

    await renderHydratedTradeSettlement();

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

    await act(async () => Promise.resolve());
    expect(
      useActiveSwapsStore.getState().byTradeId["trade-unit-mismatch"],
    ).toBeUndefined();
    expect(mockSendSwapMessage).not.toHaveBeenCalled();
    expect(mockSellerLockOutcomeProofs).not.toHaveBeenCalled();
    expect(mockBuyerPrepareSwap).not.toHaveBeenCalled();
  });

  it.each(["msat", " SAT "])(
    "fails before locking proofs when TradeCreated uses the non-canonical unit %j",
    async (baseAsset) => {
      const tradeId = `trade-unit-${baseAsset.trim().toLowerCase()}`;
      seedPendingTrade({
        orderId: `order-${tradeId}`,
        marketId: "cond-NO",
        clientOrderId: `client-${tradeId}`,
        baseAsset: "sat",
        divisibility: 1_000,
        side: "Buy",
        tokenSide: "Outcome",
        priceSubunits: 500,
        amountSubunits: 1_000_000,
        submittedAt: Date.now(),
      });

      await renderHydratedTradeSettlement();

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
        seedPendingPubkey(tradeId);
        callbacks.onTradeCreated({
          tradeId,
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
          baseAsset,
          divisibility: 1_000,
        });
      });

      await act(async () => Promise.resolve());
      expect(useActiveSwapsStore.getState().byTradeId[tradeId]).toBeUndefined();
      expect(mockJoinTrade).not.toHaveBeenCalled();
      expect(mockSendSwapMessage).not.toHaveBeenCalled();
      expect(mockSellerLockOutcomeProofs).not.toHaveBeenCalled();
      expect(mockBuyerPrepareSwap).not.toHaveBeenCalled();
    },
  );

  it("treats a non-canonical TradeCreated replay as conflicting raw authority", async () => {
    const tradeId = "trade-unit-conflicting-replay";
    seedPendingTrade({
      orderId: "order-unit-conflicting-replay",
      marketId: "cond-NO",
      clientOrderId: "client-unit-conflicting-replay",
      baseAsset: "sat",
      divisibility: 1_000,
      side: "Buy",
      tokenSide: "Outcome",
      priceSubunits: 500,
      amountSubunits: 1_000_000,
      submittedAt: Date.now(),
    });
    await renderHydratedTradeSettlement();

    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onTradeCreated: (payload: {
        tradeId: string;
        sellerPubkey: string;
        buyerPubkey: string;
        sellerLocktime: string;
        buyerLocktime: string;
        marketId: string;
        settlementKind: string;
        sellerKeepOutcomeSetId: string;
        sellerLockOutcomeSetId: string;
        outcomeFaceAmountSubunits: number;
        quotePaymentSubunits: number;
        baseAsset: string;
        divisibility: number;
      }) => void;
    };
    const canonical = {
      tradeId,
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
    };

    await act(async () => {
      seedPendingPubkey(tradeId);
      callbacks.onTradeCreated(canonical);
    });
    await waitFor(() =>
      expect(useActiveSwapsStore.getState().byTradeId[tradeId]?.role).toBe(
        "buyer",
      ),
    );

    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    await act(async () => {
      callbacks.onTradeCreated({ ...canonical, baseAsset: "msat" });
    });

    expect(warning).toHaveBeenCalledWith(
      "[swap.recovery-retained]",
      expect.objectContaining({ tradeId }),
    );
    warning.mockRestore();
  });

  it("fails before locking proofs when TradeCreated violates local order economics", async () => {
    seedPendingTrade({
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

    await renderHydratedTradeSettlement();

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

    await act(async () => Promise.resolve());
    expect(
      useActiveSwapsStore.getState().byTradeId["trade-price-mismatch"],
    ).toBeUndefined();
    expect(mockJoinTrade).not.toHaveBeenCalled();
    expect(mockSendSwapMessage).not.toHaveBeenCalled();
    expect(mockSellerLockOutcomeProofs).not.toHaveBeenCalled();
    expect(mockBuyerPrepareSwap).not.toHaveBeenCalled();
  });

  it("fails before joining when the persisted amount violates divisibility", async () => {
    seedPendingTrade({
      orderId: "order-legacy-no-economics",
      marketId: "cond-YES",
      clientOrderId: "client-order-pending",
      baseAsset: "sat",
      divisibility: 10_000,
      submittedAt: Date.now(),
    });

    await renderHydratedTradeSettlement();

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

    await act(async () => Promise.resolve());
    expect(
      useActiveSwapsStore.getState().byTradeId["trade-legacy-no-economics"],
    ).toBeUndefined();
    expect(mockJoinTrade).not.toHaveBeenCalled();
    expect(mockSellerLockOutcomeProofs).not.toHaveBeenCalled();
    expect(mockBuyerPrepareSwap).not.toHaveBeenCalled();
  });

  it("fails before locking proofs when non-default TradeCreated is missing canonical settlement amounts", async () => {
    seedPendingTrade({
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

    await renderHydratedTradeSettlement();

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

    await act(async () => Promise.resolve());
    expect(
      useActiveSwapsStore.getState().byTradeId["trade-missing-canonical"],
    ).toBeUndefined();
    expect(mockJoinTrade).not.toHaveBeenCalled();
    expect(mockSendSwapMessage).not.toHaveBeenCalled();
    expect(mockSellerLockOutcomeProofs).not.toHaveBeenCalled();
    expect(mockBuyerPrepareSwap).not.toHaveBeenCalled();
  });

  it("uses canonical non-default settlement amounts without legacy sats fields", async () => {
    seedPendingTrade({
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

    await renderHydratedTradeSettlement();

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
    const swap =
      useActiveSwapsStore.getState().byTradeId["trade-canonical-only"];
    expect(swap.role).toBe("buyer");
    expect(swap.outcomeFaceAmountSubunits).toBe(100_000);
    expect(swap.quotePaymentSubunits).toBe(40_000);
    expect(mockSendSwapMessage).not.toHaveBeenCalled();
  });

  it("fails before locking proofs when TradeCreated changes persisted divisibility", async () => {
    seedPendingTrade({
      orderId: "order-nondefault-divisibility-no-unit",
      marketId: "cond-NO",
      clientOrderId: "client-order-pending",
      side: "Buy",
      tokenSide: "Outcome",
      priceSubunits: 500,
      amountSubunits: 1_000_000,
      submittedAt: Date.now(),
    });

    await renderHydratedTradeSettlement();

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

    await act(async () => Promise.resolve());
    expect(
      useActiveSwapsStore.getState().byTradeId[
        "trade-nondefault-divisibility-no-unit"
      ],
    ).toBeUndefined();
    expect(mockJoinTrade).not.toHaveBeenCalled();
    expect(mockSendSwapMessage).not.toHaveBeenCalled();
    expect(mockSellerLockOutcomeProofs).not.toHaveBeenCalled();
    expect(mockBuyerPrepareSwap).not.toHaveBeenCalled();
  });

  it("accepts non-default divisibility when the local expected unit is asserted", async () => {
    seedPendingTrade({
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

    await renderHydratedTradeSettlement();

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
    seedPendingTrade({
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

    await renderHydratedTradeSettlement();

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

    await act(async () => Promise.resolve());
    expect(
      useActiveSwapsStore.getState().byTradeId[
        "trade-nondefault-divisibility-mismatch"
      ],
    ).toBeUndefined();
    expect(mockJoinTrade).not.toHaveBeenCalled();
    expect(mockSendSwapMessage).not.toHaveBeenCalled();
    expect(mockSellerLockOutcomeProofs).not.toHaveBeenCalled();
    expect(mockBuyerPrepareSwap).not.toHaveBeenCalled();
  });

  it("keeps the maker market when promoting a mint seller TradeCreated event", async () => {
    seedPendingTrade({
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

    await renderHydratedTradeSettlement();

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

  it("journals one seller adaptor before the first proof operation", async () => {
    mockSellerLockOutcomeProofs.mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    mockGetOutcomeProofs.mockResolvedValue([
      proof(1_000_000, "seller-outcome", "keyset-YES"),
    ]);
    seedPendingTrade({
      orderId: "order-seller-adaptor",
      marketId: "cond-YES",
      clientOrderId: "client-seller-adaptor",
      side: "Sell",
      tokenSide: "Outcome",
      priceSubunits: 500,
      amountSubunits: 1_000_000,
      baseAsset: "sat",
      divisibility: 1_000,
      submittedAt: Date.now(),
    });

    const firstMount = await renderHydratedTradeSettlement();
    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onTradeCreated: (payload: {
        tradeId: string;
        sellerPubkey: string;
        buyerPubkey: string;
        sellerLocktime: string;
        buyerLocktime: string;
        marketId: string;
        outcomeFaceAmountSubunits: number;
        quotePaymentSubunits: number;
        baseAsset: string;
        divisibility: number;
      }) => void;
    };

    await act(async () => {
      seedPendingPubkey("trade-seller-adaptor", "order-seller-adaptor");
      callbacks.onTradeCreated({
        tradeId: "trade-seller-adaptor",
        sellerPubkey: "02" + "22".repeat(32),
        buyerPubkey: "02" + "33".repeat(32),
        sellerLocktime: new Date(Date.now() + 120_000).toISOString(),
        buyerLocktime: new Date(Date.now() + 60_000).toISOString(),
        marketId: "cond-YES",
        outcomeFaceAmountSubunits: 1_000_000,
        quotePaymentSubunits: 500_000,
        baseAsset: "sat",
        divisibility: 1_000,
      });
    });

    await waitFor(() =>
      expect(
        mockPersistGuiSwapSession.mock.calls.some(
          ([candidate]) =>
            candidate.tradeId === "trade-seller-adaptor" &&
            candidate.sellerState?.adaptorPoint !== undefined,
        ),
      ).toBe(true),
    );
    const persistedAdaptorCall = mockPersistGuiSwapSession.mock.calls.find(
      ([candidate]) =>
        candidate.tradeId === "trade-seller-adaptor" &&
        candidate.sellerState?.adaptorPoint !== undefined,
    )!;
    expect(persistedAdaptorCall).toBeDefined();
    expect(
      mockPersistGuiSwapSession.mock.invocationCallOrder[
        mockPersistGuiSwapSession.mock.calls.indexOf(persistedAdaptorCall!)
      ],
    ).toBeLessThan(mockSellerLockOutcomeProofs.mock.invocationCallOrder[0]);
    const durable = structuredClone(persistedAdaptorCall[0]);
    durable.inFlightSteps = {};
    firstMount.unmount();
    // A crashed page releases its Web Lock. Reset the serialized lock mock so
    // this second mount models a new process rather than a still-live tab.
    mockOwnershipTail = Promise.resolve();
    mockProfileLockDepth = 0;
    useActiveSwapsStore.setState({
      byTradeId: { "trade-seller-adaptor": durable },
    });

    await renderHydratedTradeSettlement();
    const restartedCallbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onReconnected?: () => void;
    };
    await act(async () => restartedCallbacks.onReconnected?.());
    await waitFor(() =>
      expect(mockSellerPreparePersistedPrelockedSwap).toHaveBeenCalled(),
    );
    const recoveredAdaptor =
      mockSellerPreparePersistedPrelockedSwap.mock.calls.at(-1)?.[2];
    expect(mockGenerateAdaptorPoint).toHaveBeenCalledTimes(1);
    expect(
      recoveredAdaptor.secret.every(
        (byte: number, index: number) =>
          byte === durable.sellerState.adaptorPoint.secret[index],
      ),
    ).toBe(true);
    expect(
      recoveredAdaptor.point.every(
        (byte: number, index: number) =>
          byte === durable.sellerState.adaptorPoint.point[index],
      ),
    ).toBe(true);
    expect(mockSellerPreparePrelockedSwap).not.toHaveBeenCalled();
  });

  it("sends a freshly journaled seller opening outside the profile lock in protocol order", async () => {
    const tradeId = "trade-seller-unlocked-delivery";
    mockGetOutcomeProofs.mockResolvedValue([
      proof(100, "seller-unlocked-outcome", "keyset-YES"),
    ]);
    const swaps = useActiveSwapsStore.getState();
    swaps.promote({
      tradeId,
      orderId: "order-seller-unlocked-delivery",
      marketId: "cond-YES",
      ephemeralPrivkeyHex: "11".repeat(32),
      ephemeralPubkeyHex: "02" + "22".repeat(32),
      baseAsset: "sat",
      divisibility: 1_000,
    });
    swaps.setRoleAndCounterparty(
      tradeId,
      "seller",
      "02" + "33".repeat(32),
      {
        sellerLocktime: Math.floor(Date.now() / 1_000) + 120,
        buyerLocktime: Math.floor(Date.now() / 1_000) + 60,
      },
      {
        outcomeFaceAmountSubunits: 100,
        baseAsset: "sat",
        divisibility: 1_000,
      },
    );

    await renderHydratedTradeSettlement();

    await waitFor(() => expect(mockSendSwapMessage).toHaveBeenCalledTimes(2));
    expect(mockSendSwapMessage.mock.calls).toEqual([
      [tradeId, "adaptor-point", "cipher-adaptor"],
      [tradeId, "locked-proofs-seller", "cipher-seller"],
    ]);
    expect(mockSendProfileLockDepths).toEqual([0, 0]);
  });

  it("automatically retries a fresh seller delivery after a busy snapshot lock", async () => {
    vi.useFakeTimers();
    const tradeId = "trade-seller-busy-delivery";
    let recoveries = 0;
    mockRecoverGuiDurableTradeSession.mockImplementation(
      async (
        id: string,
        input: {
          transport: {
            sendCipher: (
              value: string,
              messageType: "adaptor-point" | "locked-proofs-seller",
              ciphertext: string,
            ) => Promise<void>;
          };
        },
      ) => {
        recoveries += 1;
        if (recoveries > 1) {
          await input.transport.sendCipher(
            id,
            "adaptor-point",
            "cipher-adaptor",
          );
          await input.transport.sendCipher(
            id,
            "locked-proofs-seller",
            "cipher-seller",
          );
        }
        return { sessions: [{ kind: "ready", tradeId: id }], orphans: [] };
      },
    );
    mockGetOutcomeProofs.mockResolvedValue([
      proof(100, "seller-busy-outcome", "keyset-YES"),
    ]);
    const swaps = useActiveSwapsStore.getState();
    swaps.promote({
      tradeId,
      orderId: "order-seller-busy-delivery",
      marketId: "cond-YES",
      ephemeralPrivkeyHex: "11".repeat(32),
      ephemeralPubkeyHex: "02" + "22".repeat(32),
      baseAsset: "sat",
      divisibility: 1_000,
    });
    swaps.setRoleAndCounterparty(
      tradeId,
      "seller",
      "02" + "33".repeat(32),
      {
        sellerLocktime: Math.floor(Date.now() / 1_000) + 120,
        buyerLocktime: Math.floor(Date.now() / 1_000) + 60,
      },
      {
        outcomeFaceAmountSubunits: 100,
        baseAsset: "sat",
        divisibility: 1_000,
      },
    );
    mockTryProfileLockAvailable = false;

    await renderHydratedTradeSettlement();
    await flushAsyncWork(32);
    expect(mockSendSwapMessage).not.toHaveBeenCalled();

    mockTryProfileLockAvailable = true;
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    await flushAsyncWork(32);

    expect(mockSendSwapMessage.mock.calls).toEqual([
      [tradeId, "adaptor-point", "cipher-adaptor"],
      [tradeId, "locked-proofs-seller", "cipher-seller"],
    ]);
    vi.useRealTimers();
  });

  it("automatically retries a fresh buyer delivery after a busy snapshot lock", async () => {
    vi.useFakeTimers();
    const tradeId = "trade-buyer-busy-delivery";
    let recoveries = 0;
    mockRecoverGuiDurableTradeSession.mockImplementation(
      async (
        id: string,
        input: {
          transport: {
            sendCipher: (
              value: string,
              messageType: "locked-proofs-buyer",
              ciphertext: string,
            ) => Promise<void>;
          };
        },
      ) => {
        recoveries += 1;
        if (recoveries > 1) {
          await input.transport.sendCipher(
            id,
            "locked-proofs-buyer",
            "cipher-buyer",
          );
        }
        return { sessions: [{ kind: "ready", tradeId: id }], orphans: [] };
      },
    );
    const operationId = `${tradeId}/browser/buyer-lock`;
    mockGetProofOperation.mockImplementation(async (candidate: string) =>
      candidate === operationId
        ? {
            operationId,
            kind: "swap-lock",
            state: "completed",
            mintUrl: "https://mint.example",
            inputs: [proof(64, "buyer-busy-input", "base-keyset")],
            outputs: {},
            metadata: {},
            resultProofs: {
              send: [proof(50, "buyer-busy-locked", "base-keyset")],
              keep: [proof(14, "buyer-busy-change", "base-keyset")],
            },
          }
        : null,
    );
    const swaps = useActiveSwapsStore.getState();
    swaps.promote({
      tradeId,
      orderId: "order-buyer-busy-delivery",
      marketId: "cond-YES",
      ephemeralPrivkeyHex: "11".repeat(32),
      ephemeralPubkeyHex: "02" + "22".repeat(32),
      baseAsset: "sat",
      divisibility: 1_000,
    });
    swaps.setRoleAndCounterparty(
      tradeId,
      "buyer",
      "02" + "33".repeat(32),
      {
        sellerLocktime: Math.floor(Date.now() / 1_000) + 120,
        buyerLocktime: Math.floor(Date.now() / 1_000) + 60,
      },
      { quotePaymentSubunits: 50, baseAsset: "sat", divisibility: 1_000 },
    );
    swaps.recordMessage(tradeId, "adaptorPoint", "cipher-adaptor");
    swaps.recordMessage(tradeId, "lockedProofsSeller", "cipher-seller");
    mockTryProfileLockAvailable = false;

    await renderHydratedTradeSettlement();
    await flushAsyncWork(32);
    expect(mockSendSwapMessage).not.toHaveBeenCalled();

    mockTryProfileLockAvailable = true;
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    await flushAsyncWork(32);

    expect(mockSendSwapMessage).toHaveBeenCalledWith(
      tradeId,
      "locked-proofs-buyer",
      "cipher-buyer",
    );
    vi.useRealTimers();
  });

  it("automatically retries settlement delivery after a busy snapshot lock", async () => {
    vi.useFakeTimers();
    const tradeId = "trade-settlement-busy-delivery";
    mockRecoverGuiDurableTradeSession.mockResolvedValue({
      sessions: [{ kind: "ready", tradeId }],
      orphans: [],
    });
    seedSettlementCompletePending(tradeId);
    mockTryProfileLockAvailable = false;

    await renderHydratedTradeSettlement();
    await flushAsyncWork(32);
    expect(mockSendSwapMessage).not.toHaveBeenCalled();

    mockTryProfileLockAvailable = true;
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    await flushAsyncWork(32);

    expect(mockSendSwapMessage).toHaveBeenCalledWith(
      tradeId,
      "settlement-complete",
      "",
    );
    vi.useRealTimers();
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
    seedPendingTrade({
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

    await renderHydratedTradeSettlement();

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
        sellerLocktime: new Date(Date.now() + 120_000).toISOString(),
        buyerLocktime: new Date(Date.now() + 60_000).toISOString(),
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
        lockedProofsCipherIv: expect.any(Uint8Array),
      }),
    );
    const durablePreparation = mockPersistGuiSwapSession.mock.calls.find(
      ([candidate]) =>
        candidate.tradeId === "trade-buyer-recover" &&
        candidate.buyerPreparation !== null,
    );
    expect(
      durablePreparation?.[0].buyerPreparation.lockedProofsCipherIv,
    ).toBeInstanceOf(Uint8Array);
    expect(
      mockPersistGuiSwapSession.mock.invocationCallOrder[
        mockPersistGuiSwapSession.mock.calls.indexOf(durablePreparation!)
      ],
    ).toBeLessThan(mockBuyerPrepareSwap.mock.invocationCallOrder.at(-1)!);
    const swap =
      useActiveSwapsStore.getState().byTradeId["trade-buyer-recover"];
    expect(swap.messages.lockedProofsBuyer).toBe("cipher-buyer");
    expect(swap.buyerState?.lockedProofsCipher).toBe("cipher-buyer");
    expect(mockSendProfileLockDepths).toEqual([0]);
  });

  it("reuses the byte-identical buyer cipher IV after a completion-boundary crash", async () => {
    const tradeId = "trade-buyer-private-recovery";
    mockGetProofOperation.mockResolvedValue({
      operationId: `${tradeId}/browser/buyer-lock`,
      kind: "swap-lock",
      state: "completed",
      mintUrl: "https://mint.example",
      inputs: [proof(64, "buyer-original-private", "base-keyset")],
      outputs: {},
      metadata: {},
      resultProofs: {
        send: [proof(50, "buyer-locked-private", "base-keyset")],
        keep: [proof(14, "buyer-change-private", "base-keyset")],
      },
    });
    mockBuyerPrepareSwap.mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    const swaps = useActiveSwapsStore.getState();
    swaps.promote({
      tradeId,
      orderId: "order-buyer-private-recovery",
      marketId: "cond-YES",
      ephemeralPrivkeyHex: "11".repeat(32),
      ephemeralPubkeyHex: "02" + "22".repeat(32),
      baseAsset: "sat",
      divisibility: 1_000,
    });
    swaps.setRoleAndCounterparty(
      tradeId,
      "buyer",
      "02" + "33".repeat(32),
      {
        sellerLocktime: Math.floor(Date.now() / 1_000) + 120,
        buyerLocktime: Math.floor(Date.now() / 1_000) + 60,
      },
      { quotePaymentSubunits: 500_000, baseAsset: "sat", divisibility: 1_000 },
    );
    swaps.recordMessage(tradeId, "adaptorPoint", "cipher-adaptor");
    swaps.recordMessage(tradeId, "lockedProofsSeller", "cipher-seller");

    const firstMount = await renderHydratedTradeSettlement();
    await waitFor(() => expect(mockBuyerPrepareSwap).toHaveBeenCalledTimes(1));
    const firstIv = mockBuyerPrepareSwap.mock.calls[0][5]
      .lockedProofsCipherIv as Uint8Array;
    const durablePreparationCall = mockPersistGuiSwapSession.mock.calls.find(
      ([candidate]) =>
        candidate.tradeId === tradeId && candidate.buyerPreparation !== null,
    )!;
    const durable = structuredClone(durablePreparationCall[0]);
    durable.inFlightSteps = {};
    firstMount.unmount();
    // A crashed page releases its Web Lock. Reset the serialized lock mock so
    // this second mount models a new process rather than a still-live tab.
    mockOwnershipTail = Promise.resolve();
    useActiveSwapsStore.setState({ byTradeId: { [tradeId]: durable } });
    mockBuyerPrepareSwap.mockResolvedValue({
      lockedProofsCipher: "cipher-buyer",
      lockedProofs: [proof(50, "buyer-locked-private", "base-keyset")],
      changeProofs: [proof(14, "buyer-change-private", "base-keyset")],
      preSigsHex: ["pre-buyer"],
      sellerPreSigsHex: ["pre-seller"],
    });

    await renderHydratedTradeSettlement();
    const restartedCallbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onReconnected?: () => void;
    };
    await act(async () => restartedCallbacks.onReconnected?.());
    await waitFor(() => expect(mockBuyerPrepareSwap).toHaveBeenCalledTimes(2));
    const recoveredIv = mockBuyerPrepareSwap.mock.calls[1][5]
      .lockedProofsCipherIv as Uint8Array;
    expect(recoveredIv.every((byte, index) => byte === firstIv[index])).toBe(
      true,
    );
    expect(mockGetUnitProofs).not.toHaveBeenCalled();
  });

  it("reserves fresh buyer proofs before the initial swap lock", async () => {
    mockGetUnitProofs.mockResolvedValue([
      proof(6_000, "buyer-free-6000", "keyset-YES"),
    ]);
    seedPendingTrade({
      orderId: "order-buyer-reserve",
      marketId: "cond-YES",
      clientOrderId: "client-buyer-reserve",
      side: "Buy",
      tokenSide: "Outcome",
      baseAsset: "sat",
      divisibility: 10_000,
      priceSubunits: 5_000,
      amountSubunits: 10_000,
      submittedAt: Date.now(),
    });

    await renderHydratedTradeSettlement();
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
      onSwapMessageReceived: (message: {
        tradeId: string;
        messageType: string;
        ciphertext: string;
      }) => void;
    };

    await act(async () => {
      seedPendingPubkey("trade-buyer-reserve", "order-buyer-reserve");
      callbacks.onTradeCreated({
        tradeId: "trade-buyer-reserve",
        sellerPubkey: "02" + "33".repeat(32),
        buyerPubkey: "02" + "22".repeat(32),
        sellerLocktime: new Date(Date.now() + 120_000).toISOString(),
        buyerLocktime: new Date(Date.now() + 60_000).toISOString(),
        marketId: "cond-YES",
        outcomeFaceAmountSubunits: 10_000,
        quotePaymentSubunits: 5_000,
        baseAsset: "sat",
        divisibility: 10_000,
      });
    });
    await waitFor(() =>
      expect(
        useActiveSwapsStore.getState().byTradeId["trade-buyer-reserve"]?.role,
      ).toBe("buyer"),
    );
    await act(async () => {
      callbacks.onSwapMessageReceived({
        tradeId: "trade-buyer-reserve",
        messageType: "adaptor-point",
        ciphertext: "cipher-adaptor",
      });
      callbacks.onSwapMessageReceived({
        tradeId: "trade-buyer-reserve",
        messageType: "locked-proofs-seller",
        ciphertext: "cipher-seller",
      });
    });

    await waitFor(() =>
      expect(mockTryReserveProofs).toHaveBeenCalledWith(
        [expect.objectContaining({ secret: "buyer-free-6000" })],
        "trade-buyer-reserve/browser/buyer-lock",
      ),
    );
  });

  it("releases a buyer proof reservation when locking fails before mint preparation", async () => {
    mockGetUnitProofs.mockResolvedValue([
      proof(6_000, "buyer-pre-mint-6000", "keyset-YES"),
    ]);
    mockBuyerPrepareSwap.mockRejectedValue(
      new Error("mint unavailable before proof operation preparation"),
    );
    seedPendingTrade({
      orderId: "order-buyer-pre-mint-failure",
      marketId: "cond-YES",
      clientOrderId: "client-buyer-pre-mint-failure",
      side: "Buy",
      tokenSide: "Outcome",
      baseAsset: "sat",
      divisibility: 10_000,
      priceSubunits: 5_000,
      amountSubunits: 10_000,
      submittedAt: Date.now(),
    });

    await renderHydratedTradeSettlement();
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
      onSwapMessageReceived: (message: {
        tradeId: string;
        messageType: string;
        ciphertext: string;
      }) => void;
    };

    await act(async () => {
      seedPendingPubkey(
        "trade-buyer-pre-mint-failure",
        "order-buyer-pre-mint-failure",
      );
      callbacks.onTradeCreated({
        tradeId: "trade-buyer-pre-mint-failure",
        sellerPubkey: "02" + "33".repeat(32),
        buyerPubkey: "02" + "22".repeat(32),
        sellerLocktime: new Date(Date.now() + 120_000).toISOString(),
        buyerLocktime: new Date(Date.now() + 60_000).toISOString(),
        marketId: "cond-YES",
        outcomeFaceAmountSubunits: 10_000,
        quotePaymentSubunits: 5_000,
        baseAsset: "sat",
        divisibility: 10_000,
      });
    });
    await waitFor(() =>
      expect(
        useActiveSwapsStore.getState().byTradeId["trade-buyer-pre-mint-failure"]
          ?.role,
      ).toBe("buyer"),
    );
    await act(async () => {
      callbacks.onSwapMessageReceived({
        tradeId: "trade-buyer-pre-mint-failure",
        messageType: "adaptor-point",
        ciphertext: "cipher-adaptor",
      });
      callbacks.onSwapMessageReceived({
        tradeId: "trade-buyer-pre-mint-failure",
        messageType: "locked-proofs-seller",
        ciphertext: "cipher-seller",
      });
    });

    await waitFor(() =>
      expect(mockReleaseProofReservation).toHaveBeenCalledWith(
        "trade-buyer-pre-mint-failure/browser/buyer-lock",
      ),
    );
    expect(mockSendSwapMessage).not.toHaveBeenCalledWith(
      "trade-buyer-pre-mint-failure",
      "locked-proofs-buyer",
      expect.any(String),
    );
  });

  it("retains a buyer proof reservation once a lock operation exists", async () => {
    mockGetUnitProofs.mockResolvedValue([
      proof(6_000, "buyer-submitted-6000", "keyset-YES"),
    ]);
    mockBuyerPrepareSwap.mockRejectedValue(
      new Error("mint response lost after proof operation preparation"),
    );
    mockGetProofOperation
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ kind: "swap-lock", state: "prepared" });
    seedPendingTrade({
      orderId: "order-buyer-submitted-failure",
      marketId: "cond-YES",
      clientOrderId: "client-buyer-submitted-failure",
      side: "Buy",
      tokenSide: "Outcome",
      baseAsset: "sat",
      divisibility: 10_000,
      priceSubunits: 5_000,
      amountSubunits: 10_000,
      submittedAt: Date.now(),
    });

    await renderHydratedTradeSettlement();
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
      onSwapMessageReceived: (message: {
        tradeId: string;
        messageType: string;
        ciphertext: string;
      }) => void;
    };

    await act(async () => {
      seedPendingPubkey(
        "trade-buyer-submitted-failure",
        "order-buyer-submitted-failure",
      );
      callbacks.onTradeCreated({
        tradeId: "trade-buyer-submitted-failure",
        sellerPubkey: "02" + "33".repeat(32),
        buyerPubkey: "02" + "22".repeat(32),
        sellerLocktime: new Date(Date.now() + 120_000).toISOString(),
        buyerLocktime: new Date(Date.now() + 60_000).toISOString(),
        marketId: "cond-YES",
        outcomeFaceAmountSubunits: 10_000,
        quotePaymentSubunits: 5_000,
        baseAsset: "sat",
        divisibility: 10_000,
      });
    });
    await waitFor(() =>
      expect(
        useActiveSwapsStore.getState().byTradeId[
          "trade-buyer-submitted-failure"
        ]?.role,
      ).toBe("buyer"),
    );
    await act(async () => {
      callbacks.onSwapMessageReceived({
        tradeId: "trade-buyer-submitted-failure",
        messageType: "adaptor-point",
        ciphertext: "cipher-adaptor",
      });
      callbacks.onSwapMessageReceived({
        tradeId: "trade-buyer-submitted-failure",
        messageType: "locked-proofs-seller",
        ciphertext: "cipher-seller",
      });
    });

    await waitFor(() => expect(mockBuyerPrepareSwap).toHaveBeenCalled());
    expect(mockReleaseProofReservation).not.toHaveBeenCalled();
  });

  it("ignores duplicate TradeCreated events after role assignment", async () => {
    seedPendingTrade({
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

    await renderHydratedTradeSettlement();

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

  it("ignores a changed duplicate after the first TradeCreated commit", async () => {
    let resolveJoinTrade: (() => void) | null = null;
    mockJoinTrade.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveJoinTrade = resolve;
        }),
    );
    seedPendingTrade({
      orderId: "order-pending",
      marketId: "cond-YES",
      clientOrderId: "client-order-pending",
      side: "Sell",
      tokenSide: "Outcome",
      priceSubunits: 500,
      amountSubunits: 1_000_000,
      submittedAt: Date.now(),
    });

    await renderHydratedTradeSettlement();

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
      baseAsset: "sat",
      divisibility: 1_000,
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
    expect(swap.step).toBe("awaiting-counterparty");
    expect(swap.role).toBe("seller");
    expect(swap.error).toBeNull();

    await act(async () => {
      resolveJoinTrade?.();
    });

    await waitFor(() => {
      swap =
        useActiveSwapsStore.getState().byTradeId["trade-duplicate-inflight"];
      expect(swap.role).toBe("seller");
    });
  });

  it("does not publish role assignment when TradeCreated locktimes are inverted", async () => {
    await renderHydratedTradeSettlement();

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
    expect(swap.step).toBe("awaiting-trade-created");
    expect(swap.role).toBeNull();
    expect(swap.error).toBeNull();
    expect(mockSendSwapMessage).not.toHaveBeenCalled();
  });

  it("keeps completed swaps terminal when a late failed state arrives", async () => {
    await renderHydratedTradeSettlement();

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

  it("commits a custody-bound terminal swap before publishing it in memory", async () => {
    await renderHydratedTradeSettlement();
    useActiveSwapsStore.getState().promote({
      tradeId: "trade-terminal-boundary",
      orderId: "order-terminal-boundary",
      marketId: "market-1",
      ephemeralPrivkeyHex: "11".repeat(32),
      ephemeralPubkeyHex: "22".repeat(32),
    });
    useActiveSwapsStore
      .getState()
      .setRoleAndCounterparty(
        "trade-terminal-boundary",
        "seller",
        "33".repeat(32),
        { sellerLocktime: 200, buyerLocktime: 100 },
      );
    let finishPersist!: () => void;
    mockPersistGuiSwapSession.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishPersist = resolve;
      }),
    );
    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onTradeStateChanged: (tradeId: string, newState: string) => void;
    };

    await act(async () => {
      callbacks.onTradeStateChanged("trade-terminal-boundary", "Confirmed");
      await Promise.resolve();
    });

    expect(
      useActiveSwapsStore.getState().byTradeId["trade-terminal-boundary"].step,
    ).not.toBe("completed");
    expect(mockPersistGuiSwapSession).toHaveBeenCalledWith(
      expect.objectContaining({
        tradeId: "trade-terminal-boundary",
        step: "completed",
        mintUrl: "https://mint.example",
      }),
      "https://mint.example",
    );

    await act(async () => finishPersist());
    await waitFor(() =>
      expect(
        useActiveSwapsStore.getState().byTradeId["trade-terminal-boundary"]
          .step,
      ).toBe("completed"),
    );
  });

  it("does not display raw trade failure errors for swaps without local participant pubkey confirmation", async () => {
    await renderHydratedTradeSettlement();

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
    ).toBe("awaiting-refund");
  });

  it("resubmits an exact taker fill after a maker collateral failure", async () => {
    await renderHydratedTradeSettlement();

    await act(async () => {
      useActiveSwapsStore.getState().promote({
        tradeId: "trade-recover-taker",
        orderId: "order-recover-taker",
        marketId: "condition-YES",
        ephemeralPrivkeyHex: "11".repeat(32),
        ephemeralPubkeyHex: "02" + "22".repeat(32),
        side: "Buy",
        tokenSide: "Outcome",
        priceSubunits: 75,
        amountSubunits: 5_000,
        baseAsset: "sat",
        divisibility: 1_000,
      });
    });
    useActiveSwapsStore.setState(
      (state) =>
        ({
          byTradeId: {
            ...state.byTradeId,
            "trade-recover-taker": {
              ...state.byTradeId["trade-recover-taker"]!,
              isTaker: true,
              matchedAmountSubunits: 1_000,
              timeInForce: "FAK",
              buyerLocktime: Math.floor(Date.now() / 1_000) + 60,
              resubmitAttempt: 0,
            },
          },
        }) as never,
    );

    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onTradeStateChanged: (
        tradeId: string,
        newState: string,
        failureReason?: string,
      ) => void;
    };

    await act(async () => {
      callbacks.onTradeStateChanged(
        "trade-recover-taker",
        "Failed",
        "maker-collateral-failure",
      );
    });

    await waitFor(() =>
      expect(mockSubmitOrder).toHaveBeenCalledWith(
        "condition-YES",
        expect.objectContaining({
          outcomeId: "YES",
          tokenSide: "Outcome",
          side: "Buy",
          price: 75,
          amountSubunits: 1_000,
          timeInForce: "FAK",
        }),
      ),
    );
    expect(
      usePendingTradesStore.getState().byOrderId["recovery-order"],
    ).toMatchObject({
      marketId: "condition-YES",
      amountSubunits: 1_000,
      recoveryAttempt: 1,
    });

    await act(async () => {
      callbacks.onTradeStateChanged(
        "trade-recover-taker",
        "Failed",
        "maker-collateral-failure",
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockSubmitOrder).toHaveBeenCalledTimes(1);
  });

  it("fails before locking proofs when TradeCreated outcome face is not a whole market share for sat/10000", async () => {
    seedPendingTrade({
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

    await renderHydratedTradeSettlement();

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

    await act(async () => Promise.resolve());
    expect(
      useActiveSwapsStore.getState().byTradeId["trade-ambiguous-sat100"],
    ).toBeUndefined();
    expect(mockSendSwapMessage).not.toHaveBeenCalled();
    expect(mockSellerLockOutcomeProofs).not.toHaveBeenCalled();
    expect(mockBuyerPrepareSwap).not.toHaveBeenCalled();
  });

  it("fails before locking proofs when non-default TradeCreated carries inconsistent quote payment amounts", async () => {
    seedPendingTrade({
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

    await renderHydratedTradeSettlement();

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

    await act(async () => Promise.resolve());
    expect(
      useActiveSwapsStore.getState().byTradeId["trade-ambiguous-usd-quote"],
    ).toBeUndefined();
    expect(mockSendSwapMessage).not.toHaveBeenCalled();
    expect(mockSellerLockOutcomeProofs).not.toHaveBeenCalled();
    expect(mockBuyerPrepareSwap).not.toHaveBeenCalled();
  });

  it("fails before locking proofs when TradeCreated changes the persisted unit", async () => {
    seedPendingTrade({
      orderId: "order-legacy-no-unit",
      marketId: "cond-NO",
      clientOrderId: "client-order-pending",
      side: "Buy",
      tokenSide: "Outcome",
      priceSubunits: 500,
      amountSubunits: 1_000_000,
      submittedAt: Date.now(),
    });

    await renderHydratedTradeSettlement();

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

    await act(async () => Promise.resolve());
    expect(
      useActiveSwapsStore.getState().byTradeId[
        "trade-nondefault-no-expected-unit"
      ],
    ).toBeUndefined();
    expect(mockSendSwapMessage).not.toHaveBeenCalled();
    expect(mockSellerLockOutcomeProofs).not.toHaveBeenCalled();
    expect(mockBuyerPrepareSwap).not.toHaveBeenCalled();
  });

  it("accepts an outcome-side buy order as the mint seller", async () => {
    seedPendingTrade({
      orderId: "order-tokenside-mismatch",
      marketId: "cond-YES",
      clientOrderId: "client-order-pending",
      side: "Buy",
      tokenSide: "Outcome",
      priceSubunits: 500,
      amountSubunits: 1_000_000,
      submittedAt: Date.now(),
    });

    await renderHydratedTradeSettlement();

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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
