import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TradeTicket } from "@bitcaster/client-sdk/tradeTicket";
import type { MarketDetail } from "@/types/market-detail";
import {
  previewBrowserCtfRangeOrderFees,
  recoverBrowserCtfRangeOrders,
  submitBrowserCtfRangeOrder,
} from "../browserCtfRangeOrderSubmission";

const mocks = vi.hoisted(() => ({
  buildPreparation: vi.fn(),
  candidates: [{ id: "keyset", amount: 10_000n, secret: "secret", C: "02" }],
  coordinatorInput: null as unknown,
  engine: {
    getSettlementCapabilityAdmissionPolicy: vi.fn(),
  },
  consolidateRound: vi.fn(),
  getProofAmountInventoryForKeyset: vi.fn(),
  getSelectableUnitProofsForAmounts: vi.fn(),
  getWalletForMnemonicUnit: vi.fn(),
  loadMintMetadata: vi.fn(),
  prepareAndSubmit: vi.fn(),
  planConsolidation: vi.fn(),
  recoverPage: vi.fn(),
  recordMessage: vi.fn(),
  wallet: {},
}));

vi.mock("@cashu/cashu-ts", () => ({
  Mint: vi.fn(),
}));

vi.mock("@bitcaster/client-sdk/ctfRangeMintMetadata", () => ({
  loadCtfRangeMintMetadata: mocks.loadMintMetadata,
}));

vi.mock("@bitcaster/client-sdk/ctfRangeSourceOperation", () => ({
  planCtfRangeSourceConsolidation: mocks.planConsolidation,
}));

vi.mock("@/lib/browserWalletProfile", () => ({
  browserWalletScopeIdFromMnemonic: () => "custody:wallet:scope-1",
}));

vi.mock("@/stores/proof-db", () => ({
  getProofAmountInventoryForKeyset: mocks.getProofAmountInventoryForKeyset,
  getSelectableUnitProofsForAmounts: mocks.getSelectableUnitProofsForAmounts,
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
  },
}));

describe("submitBrowserCtfRangeOrder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildPreparation.mockImplementation(({ request }) => ({
      operationId: "range-operation",
      mintUrl: "https://mint.example",
      offerKeyset: { id: request.side === "Sell" ? "conditional-keyset" : "regular-keyset" },
      side: request.side,
      maxInputs: 64,
    }));
    mocks.engine.getSettlementCapabilityAdmissionPolicy.mockResolvedValue({
      coordinatorPubkey: "11".repeat(32),
    });
    mocks.loadMintMetadata.mockResolvedValue({ observation: {} });
    mocks.getProofAmountInventoryForKeyset.mockResolvedValue([{ amount: "10000", count: 1 }]);
    mocks.getSelectableUnitProofsForAmounts.mockResolvedValue(mocks.candidates);
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
    mocks.recordMessage.mockResolvedValue(undefined);
  });

  it.each([
    ["FAK", "FAK"],
    ["GTC", "FOK"],
  ] as const)("submits a durable %s ticket as immediate %s", async (ticketTif, expectedTif) => {
    const ticket: TradeTicket = {
      marketId: "condition-1-YES",
      request: {
        outcomeId: "YES",
        tokenSide: "Outcome",
        side: "Buy",
        price: 4_000,
        amountSubunits: 10_000,
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
          minimumFillAmountSubunits: 10_000,
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
    expect(mocks.getSelectableUnitProofsForAmounts).toHaveBeenCalledWith("https://mint.example", {
      unit: "msat",
      keysetId: "regular-keyset",
      conditional: false,
      amounts: ["10000"],
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
          price: 4_000,
          amountSubunits: 10_000,
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

      expect(mocks.getSelectableUnitProofsForAmounts).toHaveBeenCalledWith(
        "https://mint.example",
        expect.objectContaining({
          keysetId: "conditional-keyset",
          conditional: true,
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
            price: 4_000,
            amountSubunits: 10_000,
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
    mocks.getSelectableUnitProofsForAmounts
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
          price: 4_000,
          amountSubunits: 10_000,
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
            price: 4_000,
            amountSubunits: 10_000,
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

  it("reuses bounded recent mint metadata for the same condition", async () => {
    const ticket: TradeTicket = {
      marketId: "condition-cache-YES",
      request: {
        outcomeId: "YES",
        tokenSide: "Outcome",
        side: "Buy",
        price: 4_000,
        amountSubunits: 10_000,
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
            price: 4_000,
            amountSubunits: 10_000,
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
});

function market(): MarketDetail {
  return {
    id: "condition-1",
    type: "yesno",
    baseAsset: "sat",
    divisibility: 10_000,
    outcomes: [
      { id: "yes-id", label: "YES", odds: 50 },
      { id: "no-id", label: "NO", odds: 50 },
    ],
  } as MarketDetail;
}
