import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDurableTradeProofOperationLink } from "@bitcaster/client-sdk/durableTradeRecovery";

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  partialByTradeId: {} as Record<string, unknown>,
  getGuiPartialLockFailure: vi.fn(),
  listElapsedGuiPartialLockFailures: vi.fn(),
  removeGuiPartialLockFailure: vi.fn(),
  walletState: { getWalletForUnit: vi.fn() },
  getProofOperation: vi.fn(),
  getReservedProofs: vi.fn(),
  inspectExactPreparedProofOperation: vi.fn(),
  restoreExactPreparedProofOperation: vi.fn(),
  completeGuiProofOperationWithSession: vi.fn(),
  loadGuiSwapSessionState: vi.fn(),
  markGuiProofOperationMintSubmittedWithSession: vi.fn(),
  prepareGuiProofOperationWithSession: vi.fn(),
  withGuiSwapSessionOwnership: vi.fn(),
}));

vi.mock("@cashu/cashu-ts", () => ({
  Amount: { from: (value: number) => value },
  getEncodedToken: vi.fn(() => "encoded-token"),
}));

vi.mock("@bitcaster/client-sdk/ctfSplit", () => ({
  serializeOutputDataArray: (outputs: unknown[]) => structuredClone(outputs),
  deserializeOutputGroups: (groups: Record<string, unknown[]>) =>
    structuredClone(groups),
}));

vi.mock("@bitcaster/swap-protocol/atomicSwap", () => ({
  inspectExactPreparedProofOperation: mocks.inspectExactPreparedProofOperation,
  restoreExactPreparedProofOperation: mocks.restoreExactPreparedProofOperation,
}));

vi.mock("@/stores/proof-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/proof-db")>();
  return {
    ...actual,
    currentGuiWalletId: () => "aa".repeat(32),
    getProofOperation: mocks.getProofOperation,
    getProofOperationUnderLock: mocks.getProofOperation,
    getReservedProofs: mocks.getReservedProofs,
    getReservedProofsUnderLock: mocks.getReservedProofs,
  };
});

vi.mock("@/stores/swap-session-db", () => ({
  completeGuiProofOperationWithSession:
    mocks.completeGuiProofOperationWithSession,
  completeGuiProofOperationWithSessionUnderLock:
    mocks.completeGuiProofOperationWithSession,
  loadGuiSwapSessionState: mocks.loadGuiSwapSessionState,
  loadGuiSwapSessionStateUnderLock: mocks.loadGuiSwapSessionState,
  markGuiProofOperationMintSubmittedWithSession:
    mocks.markGuiProofOperationMintSubmittedWithSession,
  markGuiProofOperationMintSubmittedWithSessionUnderLock:
    mocks.markGuiProofOperationMintSubmittedWithSession,
  prepareGuiProofOperationWithSession:
    mocks.prepareGuiProofOperationWithSession,
  prepareGuiProofOperationWithSessionUnderLock:
    mocks.prepareGuiProofOperationWithSession,
  resolveGuiProofOperationPreparation: vi.fn(async () => ({})),
  withGuiSwapSessionOwnership: mocks.withGuiSwapSessionOwnership,
}));

vi.mock("@/stores/partial-lock-failure-db", () => ({
  getGuiPartialLockFailure: mocks.getGuiPartialLockFailure,
  getGuiPartialLockFailureUnderLock: mocks.getGuiPartialLockFailure,
  listElapsedGuiPartialLockFailures: mocks.listElapsedGuiPartialLockFailures,
  removeGuiPartialLockFailureUnderLock: mocks.removeGuiPartialLockFailure,
}));

vi.mock("@/stores/wallet", () => ({
  useWalletStore: { getState: () => mocks.walletState },
}));

vi.mock("@/stores/gui-wallet-lock", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/stores/gui-wallet-lock")>();
  return {
    ...actual,
    walletIdFromHeldGuiWalletLock: () => "aa".repeat(32),
  };
});

const TRADE_ID = "trade-1";
const REFUND_LOCKTIME = 1_780_000_000;
const PRIVATE_KEY = "11".repeat(32);

function lockedProofs() {
  return [
    {
      id: "keyset-B",
      amount: 100,
      secret: "locked-B",
      C: "02".padEnd(66, "0"),
      mintUrl: "https://mint.example",
      reservedBy: TRADE_ID,
      unit: "msat" as const,
    },
    {
      id: "keyset-C",
      amount: 100,
      secret: "locked-C",
      C: "03".padEnd(66, "0"),
      mintUrl: "https://mint.example",
      reservedBy: TRADE_ID,
      unit: "msat" as const,
    },
  ];
}

function refundOutput() {
  return {
    blindedMessage: {
      amount: 200,
      id: "refund-keyset",
      B_: "02".padEnd(66, "4"),
    },
    blindingFactor: "44".repeat(32),
    secret: "refund-secret",
  };
}

function refundProof() {
  return {
    id: "keyset-B",
    amount: 200,
    secret: "refund-secret",
    C: "02".padEnd(66, "5"),
  };
}

function preparedOperation(
  state: "prepared" | "mint-submitted" | "completed" = "prepared",
) {
  return {
    operationId: `${TRADE_ID}/browser/partial-lock-refund`,
    kind: "swap-refund" as const,
    state,
    mintUrl: "https://mint.example",
    inputs: lockedProofs(),
    outputs: { refund: [refundOutput()] },
    metadata: {
      tradeId: TRADE_ID,
      refundLocktime: REFUND_LOCKTIME,
      affectedKeysets: ["keyset-B", "keyset-C"],
      amount: 200,
      fees: 0,
      keysetId: "refund-keyset",
      unit: "msat",
      unselectedProofs: [],
    },
    resultProofs:
      state === "completed" ? { refund: [refundProof()] } : undefined,
    lastError: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function completedCleanupOperation() {
  const operation = preparedOperation("completed");
  const durableTradeRecovery = createDurableTradeProofOperationLink({
    tradeId: TRADE_ID,
    role: "seller",
    stage: "refund",
    state: "reconciled",
    operationKey: operation.operationId,
  });
  return {
    ...operation,
    walletId: "aa".repeat(32),
    durableTradeRecovery,
    durableOperationId: durableTradeRecovery.operationId,
    durableTradeId: TRADE_ID,
    custodyOperationId: "custody-refund-1",
  };
}

function swapAuthority() {
  return {
    tradeId: TRADE_ID,
    role: "seller" as const,
    ephemeralPrivkeyHex: PRIVATE_KEY,
    sellerLocktime: REFUND_LOCKTIME,
    buyerLocktime: REFUND_LOCKTIME + 600,
  };
}

describe("partial-lock recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date((REFUND_LOCKTIME + 61) * 1_000));
    mocks.events.length = 0;
    mocks.partialByTradeId = {
      [TRADE_ID]: {
        kind: "PartialLockHeld",
        tradeId: TRADE_ID,
        orderId: "order-1",
        mintUrl: "https://mint.example",
        refundLocktime: REFUND_LOCKTIME,
        affectedKeysets: ["keyset-B", "keyset-C"],
        detail: "partial lock",
        lockedProofs: lockedProofs(),
        outcomeByKeyset: {
          "keyset-B": {
            conditionId: "condition-1",
            outcomeCollection: "B",
            marketId: "condition-1-B",
          },
          "keyset-C": {
            conditionId: "condition-1",
            outcomeCollection: "C",
            marketId: "condition-1-C",
          },
        },
      },
    };
    mocks.listElapsedGuiPartialLockFailures.mockResolvedValue(
      Object.values(mocks.partialByTradeId),
    );
    mocks.getGuiPartialLockFailure.mockImplementation(
      async (_lock: unknown, tradeId: string) =>
        mocks.partialByTradeId[tradeId] ?? null,
    );
    mocks.removeGuiPartialLockFailure.mockImplementation(() => {
      mocks.events.push("remove-failure");
    });
    mocks.getReservedProofs.mockResolvedValue(lockedProofs());
    mocks.getProofOperation.mockResolvedValue(null);
    mocks.loadGuiSwapSessionState.mockResolvedValue(swapAuthority());
    mocks.withGuiSwapSessionOwnership.mockImplementation(
      async (_tradeId: string, action: (lock: unknown) => Promise<unknown>) =>
        action({}),
    );
    mocks.inspectExactPreparedProofOperation.mockImplementation(async () => {
      mocks.events.push("inspect");
      return "all-unspent";
    });
    mocks.prepareGuiProofOperationWithSession.mockImplementation(
      async (_lock: unknown, input: ReturnType<typeof preparedOperation>) => {
        mocks.events.push("prepare-operation");
        return { ...input, state: "prepared" };
      },
    );
    mocks.markGuiProofOperationMintSubmittedWithSession.mockImplementation(
      async () => {
        mocks.events.push("mark-submitted");
      },
    );
    mocks.completeGuiProofOperationWithSession.mockImplementation(async () => {
      mocks.events.push("complete-operation");
    });
    mocks.restoreExactPreparedProofOperation.mockResolvedValue({
      refund: [refundProof()],
    });
    mocks.walletState.getWalletForUnit.mockResolvedValue({
      prepareSwapToReceive: vi.fn(async () => {
        mocks.events.push("prepare-preview");
        return {
          amount: 200,
          fees: 0,
          keysetId: "refund-keyset",
          inputs: lockedProofs(),
          keepOutputs: [refundOutput()],
        };
      }),
      completeSwap: vi.fn(async () => {
        mocks.events.push("complete-swap");
        return { keep: [refundProof()] };
      }),
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("persists exact outputs before mint dispatch and commits proofs with the session", async () => {
    const { sweepElapsedPartialLockFailures } =
      await import("../partialLockRecovery");

    await sweepElapsedPartialLockFailures();

    expect(console.warn).not.toHaveBeenCalled();
    expect(mocks.walletState.getWalletForUnit).toHaveBeenCalledWith(
      "https://mint.example",
      "msat",
      { expectedWalletId: "aa".repeat(32) },
    );
    expect(mocks.events).toEqual([
      "prepare-preview",
      "prepare-operation",
      "inspect",
      "mark-submitted",
      "complete-swap",
      "complete-operation",
      "remove-failure",
    ]);
    expect(mocks.completeGuiProofOperationWithSession).toHaveBeenCalledWith(
      expect.anything(),
      `${TRADE_ID}/browser/partial-lock-refund`,
      { refund: [refundProof()] },
      expect.objectContaining({ tradeId: TRADE_ID }),
      "https://mint.example",
    );
    expect(mocks.prepareGuiProofOperationWithSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({
          conditionId: "condition-1",
          outcomeByKeyset: expect.objectContaining({
            "keyset-B": expect.objectContaining({
              outcomeCollection: "B",
            }),
          }),
          durableWalletProofTransition: expect.objectContaining({
            inputSource: "wallet",
            resultGroups: {
              refund: {
                kind: "wallet",
                asset: "conditional",
                reservedBy: null,
              },
            },
          }),
        }),
      }),
      expect.objectContaining({ tradeId: TRADE_ID }),
      expect.anything(),
    );
  });

  it("restores the persisted output plan when every input is already spent", async () => {
    const operation = preparedOperation("mint-submitted");
    mocks.getProofOperation.mockResolvedValue(operation);
    mocks.inspectExactPreparedProofOperation.mockResolvedValue("all-spent");
    const wallet = await mocks.walletState.getWalletForUnit();
    const { sweepElapsedPartialLockFailures } =
      await import("../partialLockRecovery");

    await sweepElapsedPartialLockFailures();

    expect(mocks.restoreExactPreparedProofOperation).toHaveBeenCalledWith(
      operation,
    );
    expect(wallet.completeSwap).not.toHaveBeenCalled();
    expect(
      mocks.markGuiProofOperationMintSubmittedWithSession,
    ).not.toHaveBeenCalled();
    expect(mocks.completeGuiProofOperationWithSession).toHaveBeenCalledOnce();
    expect(mocks.removeGuiPartialLockFailure).toHaveBeenCalledWith(
      expect.anything(),
      TRADE_ID,
    );
  });

  it("keeps local authority when restored outputs do not match the persisted plan", async () => {
    mocks.getProofOperation.mockResolvedValue(
      preparedOperation("mint-submitted"),
    );
    mocks.inspectExactPreparedProofOperation.mockResolvedValue("all-spent");
    mocks.restoreExactPreparedProofOperation.mockResolvedValue({
      refund: [{ ...refundProof(), secret: "foreign-secret" }],
    });
    const { sweepElapsedPartialLockFailures } =
      await import("../partialLockRecovery");

    await sweepElapsedPartialLockFailures();

    expect(mocks.completeGuiProofOperationWithSession).not.toHaveBeenCalled();
    expect(mocks.removeGuiPartialLockFailure).not.toHaveBeenCalled();
  });

  it("fails closed before wallet effects without exact session authority or unit", async () => {
    mocks.loadGuiSwapSessionState.mockResolvedValue(null);
    const wallet = await mocks.walletState.getWalletForUnit();
    const { sweepElapsedPartialLockFailures } =
      await import("../partialLockRecovery");

    await sweepElapsedPartialLockFailures();

    expect(wallet.prepareSwapToReceive).not.toHaveBeenCalled();
    expect(wallet.completeSwap).not.toHaveBeenCalled();
    expect(mocks.completeGuiProofOperationWithSession).not.toHaveBeenCalled();

    mocks.loadGuiSwapSessionState.mockResolvedValue(swapAuthority());
    mocks.getReservedProofs.mockResolvedValue([
      { ...lockedProofs()[0], unit: undefined },
    ]);
    await sweepElapsedPartialLockFailures();
    expect(wallet.prepareSwapToReceive).not.toHaveBeenCalled();
  });

  it("does not treat a completed journal with still-reserved inputs as success", async () => {
    mocks.getProofOperation.mockResolvedValue(preparedOperation("completed"));
    const { sweepElapsedPartialLockFailures } =
      await import("../partialLockRecovery");

    await sweepElapsedPartialLockFailures();

    expect(mocks.completeGuiProofOperationWithSession).not.toHaveBeenCalled();
    expect(mocks.removeGuiPartialLockFailure).not.toHaveBeenCalled();
  });

  it("retains recovery authority when reserved proofs disappear without an exact completed refund", async () => {
    mocks.getReservedProofs.mockResolvedValue([]);
    mocks.getProofOperation.mockResolvedValue(null);
    const wallet = await mocks.walletState.getWalletForUnit();
    const { sweepElapsedPartialLockFailures } =
      await import("../partialLockRecovery");

    await sweepElapsedPartialLockFailures();

    expect(mocks.removeGuiPartialLockFailure).not.toHaveBeenCalled();
    expect(wallet.prepareSwapToReceive).not.toHaveBeenCalled();
    expect(wallet.completeSwap).not.toHaveBeenCalled();
  });

  it("removes recovery authority after the exact completed refund replaced its inputs", async () => {
    mocks.getReservedProofs.mockResolvedValue([]);
    mocks.getProofOperation.mockResolvedValue(completedCleanupOperation());
    const wallet = await mocks.walletState.getWalletForUnit();
    const { sweepElapsedPartialLockFailures } =
      await import("../partialLockRecovery");

    await sweepElapsedPartialLockFailures();

    expect(mocks.removeGuiPartialLockFailure).toHaveBeenCalledWith(
      expect.anything(),
      TRADE_ID,
    );
    expect(wallet.prepareSwapToReceive).not.toHaveBeenCalled();
    expect(wallet.completeSwap).not.toHaveBeenCalled();
  });
});
