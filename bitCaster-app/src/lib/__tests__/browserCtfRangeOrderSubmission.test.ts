import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TradeTicket } from "@bitcaster/client-sdk/tradeTicket";
import type { MarketDetail } from "@/types/market-detail";
import {
  previewBrowserCtfRangeOrderFees,
  recoverBrowserCtfRangeOrder,
  recoverBrowserCtfRangeOrders,
  submitBrowserCtfRangeOrder,
} from "../browserCtfRangeOrderSubmission";

const KEYSET_KEYS = Object.fromEntries(
  [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384].map((amount) => [
    String(amount),
    `02${"11".repeat(32)}`,
  ]),
);

const mocks = vi.hoisted(() => ({
  buildPreparation: vi.fn(),
  candidates: [{ id: "keyset", amount: 10_000n, secret: "secret", C: "02" }],
  coordinatorInput: null as unknown,
  engine: {
    getSettlementCapabilityAdmissionPolicy: vi.fn(),
  },
  consolidateRound: vi.fn(),
  getBoundedCanonicalRangeProofsForKeyset: vi.fn(),
  getWalletForMnemonicUnit: vi.fn(),
  loadMintMetadata: vi.fn(),
  prepareAndSubmit: vi.fn(),
  planConsolidation: vi.fn(),
  recoverPage: vi.fn(),
  recoverClientOrder: vi.fn(),
  recoverFundedAsset: vi.fn(),
  recordMessage: vi.fn(),
  ensureParticipationScoreForNextMatch: vi.fn(),
  database: {},
  wallet: {},
}));

vi.mock("@cashu/cashu-ts", async () => {
  const actual = await vi.importActual<object>("@cashu/cashu-ts");
  return { ...actual, Mint: vi.fn() };
});

vi.mock("@bitcaster/client-sdk/ctfRangeMintMetadata", () => ({
  loadCtfRangeMintMetadata: mocks.loadMintMetadata,
}));

vi.mock("@bitcaster/client-sdk/ctfRangeSourceOperation", () => ({
  planCtfRangeSourceConsolidation: mocks.planConsolidation,
}));

vi.mock("@/lib/browserWalletProfile", () => ({
  browserWalletScopeIdFromMnemonic: () => "custody:wallet:scope-1",
  activeBrowserWalletScopeId: () => "custody:wallet:scope-1",
}));

vi.mock("@/stores/proof-db", () => ({
  db: mocks.database,
  getBoundedCanonicalRangeProofsForKeyset: mocks.getBoundedCanonicalRangeProofsForKeyset,
}));

vi.mock("@/stores/ctf-range-order-db", () => ({
  readCtfRangePreparation: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/stores/ctf-range-order-messages", () => ({
  recordBrowserCtfRangeMessage: mocks.recordMessage,
}));

vi.mock("@/stores/wallet", () => ({
  getWalletForMnemonicUnit: mocks.getWalletForMnemonicUnit,
}));

vi.mock("../markets", () => ({
  createAuthenticatedBrowserEngineClient: () => mocks.engine,
}));

vi.mock("../participationScorePayment", () => ({
  ensureParticipationScoreForNextMatch: mocks.ensureParticipationScoreForNextMatch,
}));

vi.mock("../browserCtfRangeOrderCoordinator", () => ({
  buildBrowserCtfRangeOrderPreparation: mocks.buildPreparation,
  BrowserCtfRangeOrderError: class extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
  BrowserCtfRangeOrderCoordinator: class {
    constructor(input: unknown) {
      mocks.coordinatorInput = input;
    }

    consolidateRound = mocks.consolidateRound;
    prepareAndSubmit = mocks.prepareAndSubmit;
    recoverPage = mocks.recoverPage;
    recoverClientOrder = mocks.recoverClientOrder;
  },
}));

vi.mock("../browserFundedAssetRecovery", () => ({
  recoverBrowserFundedAsset: mocks.recoverFundedAsset,
}));

describe("submitBrowserCtfRangeOrder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildPreparation.mockImplementation(({ request }) => ({
      operationId: "range-operation",
      mintUrl: "https://mint.example",
      offerKeyset:
        request.side === "Sell"
          ? {
              id: "conditional-keyset",
              canonicalMintUrl: "https://mint.example",
              unit: "msat",
              active: true,
              inputFeePpk: 1,
              finalExpiry: null,
              keys: KEYSET_KEYS,
              conditionId: "11".repeat(32),
              outcomeCollection: "YES",
              outcomeCollectionId: "22".repeat(32),
              registeredAt: 1,
            }
          : {
              id: "regular-keyset",
              canonicalMintUrl: "https://mint.example",
              unit: "msat",
              active: true,
              inputFeePpk: 1,
              finalExpiry: null,
              keys: KEYSET_KEYS,
            },
      side: request.side,
      maxInputs: 64,
      maxPoolEntries: 64,
      priceNumerator: request.price,
      amountSubunits: request.amountSubunits,
      divisibility: request.divisibility,
    }));
    mocks.engine.getSettlementCapabilityAdmissionPolicy.mockResolvedValue({
      coordinatorPubkey: "11".repeat(32),
    });
    mocks.loadMintMetadata.mockResolvedValue({ observation: {} });
    mocks.getBoundedCanonicalRangeProofsForKeyset.mockResolvedValue(mocks.candidates);
    mocks.planConsolidation.mockReturnValue({
      kind: "ready",
      consolidationRounds: [],
      selectedInputs: ["10000"],
      consolidationFee: "0",
      sourceFee: "0",
    });
    mocks.consolidateRound.mockResolvedValue(undefined);
    mocks.getWalletForMnemonicUnit.mockResolvedValue(mocks.wallet);
    mocks.prepareAndSubmit.mockResolvedValue({ orderId: "order-1" });
    mocks.recoverPage.mockReset();
    mocks.recoverClientOrder.mockReset();
    mocks.recordMessage.mockResolvedValue(undefined);
    mocks.ensureParticipationScoreForNextMatch.mockReset();
    mocks.recoverFundedAsset.mockImplementation(async ({ loadPlan }) => ({
      kind: "ready",
      plan: await loadPlan(),
    }));
  });

  it("recovers an insufficient explicit submission before returning insufficient funds", async () => {
    mocks.planConsolidation.mockReturnValue({ kind: "insufficient" });
    mocks.recoverFundedAsset.mockResolvedValue({ kind: "unavailable" });

    await expect(
      submitBrowserCtfRangeOrder({
        market: market(),
        ticket: {
          marketId: "condition-1-YES",
          request: {
            outcomeId: "YES",
            tokenSide: "Outcome",
            side: "Buy",
            price: 400,
            amountSubunits: 1_000,
            timeInForce: "FAK",
          },
        },
        clientOrderId: "client-recover",
        mintUrl: "https://mint.example",
        mnemonic:
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        expectedConsolidationFeeSubunits: 0,
      }),
    ).rejects.toMatchObject({ code: "insufficient-funds" });

    expect(mocks.recoverFundedAsset).toHaveBeenCalledOnce();
  });

  it("records a revision-zero durable funds error when exact recovery fails", async () => {
    mocks.planConsolidation.mockReturnValue({ kind: "insufficient" });
    mocks.recoverFundedAsset.mockResolvedValue({ kind: "persistent-error" });

    await expect(
      submitBrowserCtfRangeOrder({
        market: market(),
        ticket: {
          marketId: "condition-1-YES",
          request: {
            outcomeId: "YES",
            tokenSide: "Outcome",
            side: "Buy",
            price: 400,
            amountSubunits: 1_000,
            timeInForce: "FAK",
          },
        },
        clientOrderId: "client-recovery-error",
        mintUrl: "https://mint.example",
        mnemonic:
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        expectedConsolidationFeeSubunits: 0,
      }),
    ).rejects.toMatchObject({ code: "asset-recovery-failed" });

    expect(mocks.recordMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "range-operation",
        revision: 0,
        code: "asset-recovery-failed",
        kind: "funds",
      }),
    );
  });

  it("fails durably when the single post-recovery replan remains insufficient", async () => {
    mocks.recoverFundedAsset.mockResolvedValue({ kind: "recovered" });
    mocks.planConsolidation.mockReturnValue({ kind: "insufficient" });

    await expect(submitRangeOrder("client-recovery-replan")).rejects.toMatchObject({
      code: "asset-recovery-failed",
    });

    expect(mocks.planConsolidation).toHaveBeenCalledOnce();
    expect(mocks.recordMessage).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 0, code: "asset-recovery-failed", kind: "funds" }),
    );
  });

  it("uses the one post-recovery replan when it becomes ready", async () => {
    mocks.recoverFundedAsset.mockResolvedValue({ kind: "recovered" });

    await expect(submitRangeOrder("client-recovery-ready")).resolves.toEqual({
      orderId: "order-1",
    });

    expect(mocks.planConsolidation).toHaveBeenCalledOnce();
    expect(mocks.prepareAndSubmit).toHaveBeenCalledOnce();
  });

  it.each([
    ["FAK", "FAK"],
    ["FOK", "FAK"],
  ] as const)("submits a durable %s ticket as GUI FAK", async (ticketTif, expectedTif) => {
    const ticket: TradeTicket = {
      marketId: "condition-1-YES",
      request: {
        outcomeId: "YES",
        tokenSide: "Outcome",
        side: "Buy",
        price: 400,
        amountSubunits: 1_000,
        timeInForce: ticketTif,
      },
    };

    await submitBrowserCtfRangeOrder({
      market: market(),
      ticket,
      clientOrderId: "client-1",
      mintUrl: "https://mint.example",
      mnemonic:
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      expectedConsolidationFeeSubunits: 0,
    });

    expect(mocks.buildPreparation).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          marketId: ticket.marketId,
          conditionId: "condition-1",
          clientOrderId: "client-1",
          minimumFillAmountSubunits: 1_000,
          baseAsset: "sat",
          collateralUnit: "msat",
          timeInForce: expectedTif,
        }),
      }),
    );
    expect(mocks.prepareAndSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: mocks.candidates,
        preparation: expect.objectContaining({ operationId: "range-operation" }),
      }),
    );
    expect(mocks.getBoundedCanonicalRangeProofsForKeyset).toHaveBeenCalledWith(
      "https://mint.example",
      expect.objectContaining({
        scopeId: "custody:wallet:scope-1",
        keysetId: "regular-keyset",
        asset: { kind: "regular" },
      }),
    );
  });

  it("awaits Score top-up before rerunning the exact required tariff", async () => {
    const score = { purchasedTotal: 0, balance: -3, enabled: true };
    mocks.ensureParticipationScoreForNextMatch
      .mockResolvedValueOnce({
        kind: "needs-regular-top-up",
        score,
        requiredSats: 3,
        balanceSats: 0,
        deficitSats: 3,
      })
      .mockResolvedValueOnce({ kind: "sufficient", score: { ...score, balance: 3 } });
    let releaseTopUp!: () => void;
    const onScoreTopUpRequired = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseTopUp = resolve;
        }),
    );

    await submitBrowserCtfRangeOrder({
      market: market(),
      ticket: {
        marketId: "condition-1-YES",
        request: {
          outcomeId: "YES",
          tokenSide: "Outcome",
          side: "Buy",
          price: 400,
          amountSubunits: 1_000,
          timeInForce: "FAK",
        },
      },
      clientOrderId: "client-score-top-up",
      mintUrl: "https://mint.example",
      mnemonic:
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      expectedConsolidationFeeSubunits: 0,
      onScoreTopUpRequired,
    });

    const beforeCreateCapability = (
      mocks.coordinatorInput as {
        beforeCreateCapability: (input: {
          mintUrl: string;
          requiredScore: number;
        }) => Promise<void>;
      }
    ).beforeCreateCapability;
    const continuation = beforeCreateCapability({
      mintUrl: "https://mint.example",
      requiredScore: 7,
    });
    await Promise.resolve();
    expect(onScoreTopUpRequired).toHaveBeenCalledWith({ requiredSats: 3, balanceSats: 0 });
    expect(mocks.ensureParticipationScoreForNextMatch).toHaveBeenNthCalledWith(1, {
      mintUrl: "https://mint.example",
      requiredScore: 7,
    });
    let completed = false;
    void continuation.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    releaseTopUp();
    await continuation;
    expect(mocks.ensureParticipationScoreForNextMatch).toHaveBeenNthCalledWith(2, {
      mintUrl: "https://mint.example",
      requiredScore: 7,
    });
  });

  it.each(["Outcome", "Complement"] as const)(
    "selects exact conditional %s proofs for a Sell order",
    async (tokenSide) => {
      const ticket: TradeTicket = {
        marketId: "condition-1-YES",
        request: {
          outcomeId: "YES",
          tokenSide,
          side: "Sell",
          price: 400,
          amountSubunits: 1_000,
          timeInForce: "FAK",
        },
      };

      await submitBrowserCtfRangeOrder({
        market: market(),
        ticket,
        clientOrderId: "client-sell",
        mintUrl: "https://mint.example",
        mnemonic:
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        expectedConsolidationFeeSubunits: 0,
      });

      expect(mocks.getBoundedCanonicalRangeProofsForKeyset).toHaveBeenCalledWith(
        "https://mint.example",
        expect.objectContaining({
          keysetId: "conditional-keyset",
          asset: expect.objectContaining({ kind: "conditional" }),
        }),
      );
    },
  );

  it("previews the exact proof consolidation fee for the trade pane", async () => {
    mocks.planConsolidation.mockReturnValueOnce({
      kind: "ready",
      consolidationRounds: [{ inputs: ["4", "2"], outputs: ["4", "1"], fee: "1" }],
      selectedInputs: ["4", "1"],
      consolidationFee: "1",
      sourceFee: "2",
    });

    await expect(
      previewBrowserCtfRangeOrderFees({
        market: market(),
        ticket: {
          marketId: "condition-1-YES",
          request: {
            outcomeId: "YES",
            tokenSide: "Outcome",
            side: "Buy",
            price: 400,
            amountSubunits: 1_000,
            timeInForce: "FAK",
          },
        },
        mintUrl: "https://mint.example",
      }),
    ).resolves.toEqual({ consolidationFeeSubunits: 1, sourceFeeSubunits: 2 });
  });

  it("executes each planned consolidation round before source preparation", async () => {
    mocks.planConsolidation.mockReturnValueOnce({
      kind: "ready",
      consolidationRounds: [{ inputs: ["4", "2"], outputs: ["4", "1"], fee: "1" }],
      selectedInputs: ["4", "1"],
      consolidationFee: "1",
      sourceFee: "1",
    });
    mocks.getBoundedCanonicalRangeProofsForKeyset
      .mockResolvedValueOnce([
        { id: "regular-keyset", amount: 4, secret: "four", C: "C-four" },
        { id: "regular-keyset", amount: 2, secret: "two", C: "C-two" },
      ])
      .mockResolvedValueOnce([
        { id: "regular-keyset", amount: 4, secret: "four", C: "C-four" },
        { id: "regular-keyset", amount: 2, secret: "two", C: "C-two" },
      ])
      .mockResolvedValueOnce(mocks.candidates);

    await submitBrowserCtfRangeOrder({
      market: market(),
      ticket: {
        marketId: "condition-1-YES",
        request: {
          outcomeId: "YES",
          tokenSide: "Outcome",
          side: "Buy",
          price: 400,
          amountSubunits: 1_000,
          timeInForce: "FAK",
        },
      },
      clientOrderId: "client-consolidated",
      mintUrl: "https://mint.example",
      mnemonic:
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      expectedConsolidationFeeSubunits: 1,
    });

    expect(mocks.consolidateRound).toHaveBeenCalledOnce();
    expect(mocks.consolidateRound).toHaveBeenCalledWith(
      expect.objectContaining({ round: 0, plannedRound: expect.objectContaining({ fee: "1" }) }),
    );
    expect(mocks.prepareAndSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ candidates: mocks.candidates }),
    );
  });

  it("does not mutate proofs when the displayed consolidation fee is stale", async () => {
    mocks.planConsolidation.mockReturnValueOnce({
      kind: "ready",
      consolidationRounds: [{ inputs: ["4", "2"], outputs: ["4", "1"], fee: "1" }],
      selectedInputs: ["4", "1"],
      consolidationFee: "1",
      sourceFee: "1",
    });

    await expect(
      submitBrowserCtfRangeOrder({
        market: market(),
        ticket: {
          marketId: "condition-1-YES",
          request: {
            outcomeId: "YES",
            tokenSide: "Outcome",
            side: "Buy",
            price: 400,
            amountSubunits: 1_000,
            timeInForce: "FAK",
          },
        },
        clientOrderId: "client-declined",
        mintUrl: "https://mint.example",
        mnemonic:
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        expectedConsolidationFeeSubunits: 0,
      }),
    ).rejects.toThrow("Wallet proof fees changed");

    expect(mocks.consolidateRound).not.toHaveBeenCalled();
    expect(mocks.prepareAndSubmit).not.toHaveBeenCalled();
  });

  it("stops before another mint call when replanning exceeds the approved fee", async () => {
    mocks.planConsolidation
      .mockReturnValueOnce({
        kind: "ready",
        consolidationRounds: [{ inputs: ["4", "2"], outputs: ["4", "1"], fee: "1" }],
        selectedInputs: ["4", "1"],
        consolidationFee: "1",
        sourceFee: "1",
      })
      .mockReturnValueOnce({
        kind: "ready",
        consolidationRounds: [{ inputs: ["4", "1"], outputs: ["4"], fee: "1" }],
        selectedInputs: ["4"],
        consolidationFee: "1",
        sourceFee: "1",
      });
    mocks.getBoundedCanonicalRangeProofsForKeyset.mockResolvedValue([
      { id: "regular-keyset", amount: 4, secret: "four", C: "C-four" },
      { id: "regular-keyset", amount: 2, secret: "two", C: "C-two" },
    ]);

    await expect(submitRangeOrder("client-replanned-fee", 1)).rejects.toThrow(
      "Wallet proof fees changed",
    );

    expect(mocks.consolidateRound).toHaveBeenCalledOnce();
    expect(mocks.prepareAndSubmit).not.toHaveBeenCalled();
  });

  it("reuses bounded recent mint metadata for the same condition", async () => {
    const ticket: TradeTicket = {
      marketId: "condition-cache-YES",
      request: {
        outcomeId: "YES",
        tokenSide: "Outcome",
        side: "Buy",
        price: 400,
        amountSubunits: 1_000,
        timeInForce: "FAK",
      },
    };
    const input = {
      market: { ...market(), id: "condition-cache" },
      ticket,
      mintUrl: "https://mint.example",
      mnemonic:
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      expectedConsolidationFeeSubunits: 0,
    };

    await submitBrowserCtfRangeOrder({ ...input, clientOrderId: "client-cache-1" });
    await submitBrowserCtfRangeOrder({ ...input, clientOrderId: "client-cache-2" });

    expect(mocks.loadMintMetadata).toHaveBeenCalledOnce();
    expect(mocks.prepareAndSubmit).toHaveBeenCalledTimes(2);
  });

  it("fails before wallet or network work when the seed is absent", async () => {
    await expect(
      submitBrowserCtfRangeOrder({
        market: market(),
        ticket: {
          marketId: "condition-1-YES",
          request: {
            outcomeId: "YES",
            tokenSide: "Outcome",
            side: "Buy",
            price: 400,
            amountSubunits: 1_000,
            timeInForce: "FAK",
          },
        },
        clientOrderId: "client-1",
        mintUrl: "https://mint.example",
        mnemonic: "",
        expectedConsolidationFeeSubunits: 0,
      }),
    ).rejects.toThrow(/seed is unavailable/);
    expect(mocks.engine.getSettlementCapabilityAdmissionPolicy).not.toHaveBeenCalled();
  });

  it("recovers active operations in bounded pages", async () => {
    mocks.recoverPage
      .mockResolvedValueOnce({
        recoveredOperationIds: ["range-1"],
        pending: [{ operationId: "range-2", revision: 2, code: "recovery-pending" }],
        nextCursor: { createdAtMs: 10, rangeOperationId: "range-2" },
      })
      .mockResolvedValueOnce({
        recoveredOperationIds: ["range-3"],
        pending: [],
        nextCursor: null,
      });

    await expect(
      recoverBrowserCtfRangeOrders({
        mnemonic:
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        mintUrls: ["https://mint.example"],
      }),
    ).resolves.toEqual({
      recovered: 2,
      pending: [{ operationId: "range-2", revision: 2, code: "recovery-pending" }],
    });
    expect(mocks.recordMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeId: "custody:wallet:scope-1",
        operationId: "range-2",
        revision: 2,
        code: "recovery-pending",
        kind: "funds",
      }),
    );
    expect(mocks.recoverPage).toHaveBeenCalledTimes(2);
    expect(mocks.recoverPage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        limit: 64,
        after: { createdAtMs: 10, rangeOperationId: "range-2" },
      }),
    );
  });

  it("recovers only the active preparation for one engine order", async () => {
    mocks.recoverClientOrder.mockResolvedValue({
      recoveredOperationIds: ["range-target"],
      pending: [{ operationId: "range-target", revision: 2, code: "recovery-pending" }],
    });

    await expect(
      recoverBrowserCtfRangeOrder({
        mnemonic:
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        mintUrls: ["https://mint.example"],
        clientOrderId: "client-target",
      }),
    ).resolves.toEqual({
      recovered: 1,
      pending: [{ operationId: "range-target", revision: 2, code: "recovery-pending" }],
    });
    expect(mocks.recoverClientOrder).toHaveBeenCalledWith(
      expect.objectContaining({ clientOrderId: "client-target" }),
    );
    expect(mocks.recoverPage).not.toHaveBeenCalled();
    expect(mocks.recordMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "range-target",
        revision: 2,
        code: "recovery-pending",
      }),
    );
  });
});

function market(): MarketDetail {
  return {
    id: "condition-1",
    type: "yesno",
    baseAsset: "sat",
    divisibility: 1_000,
    outcomes: [
      { id: "yes-id", label: "YES", odds: 50 },
      { id: "no-id", label: "NO", odds: 50 },
    ],
  } as MarketDetail;
}

function submitRangeOrder(clientOrderId: string, expectedConsolidationFeeSubunits = 0) {
  return submitBrowserCtfRangeOrder({
    market: market(),
    ticket: {
      marketId: "condition-1-YES",
      request: {
        outcomeId: "YES",
        tokenSide: "Outcome",
        side: "Buy",
        price: 400,
        amountSubunits: 1_000,
        timeInForce: "FAK",
      },
    },
    clientOrderId,
    mintUrl: "https://mint.example",
    mnemonic:
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    expectedConsolidationFeeSubunits,
  });
}
