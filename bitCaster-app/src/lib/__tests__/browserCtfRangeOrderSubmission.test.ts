import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TradeTicket } from "@bitcaster/client-sdk/tradeTicket";
import type { MarketDetail } from "@/types/market-detail";
import {
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
  getSelectableUnitProofsForKeyset: vi.fn(),
  getWalletForMnemonicUnit: vi.fn(),
  loadMintMetadata: vi.fn(),
  prepareAndSubmit: vi.fn(),
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

vi.mock("@/lib/browserWalletProfile", () => ({
  browserWalletScopeIdFromMnemonic: () => "custody:wallet:scope-1",
}));

vi.mock("@/stores/proof-db", () => ({
  getSelectableUnitProofsForKeyset: mocks.getSelectableUnitProofsForKeyset,
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
  BrowserCtfRangeOrderCoordinator: class {
    constructor(input: unknown) {
      mocks.coordinatorInput = input;
    }

    prepareAndSubmit = mocks.prepareAndSubmit;
    recoverPage = mocks.recoverPage;
  },
}));

describe("submitBrowserCtfRangeOrder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildPreparation.mockImplementation(({ request }) => ({
      operationId: "range-operation",
      offerKeyset: { id: request.side === "Sell" ? "conditional-keyset" : "regular-keyset" },
      side: request.side,
      maxInputs: 64,
    }));
    mocks.engine.getSettlementCapabilityAdmissionPolicy.mockResolvedValue({
      coordinatorPubkey: "11".repeat(32),
    });
    mocks.loadMintMetadata.mockResolvedValue({ observation: {} });
    mocks.getSelectableUnitProofsForKeyset.mockResolvedValue(mocks.candidates);
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
    expect(mocks.getSelectableUnitProofsForKeyset).toHaveBeenCalledWith("https://mint.example", {
      unit: "msat",
      keysetId: "regular-keyset",
      conditional: false,
      limit: 64,
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
      });

      expect(mocks.getSelectableUnitProofsForKeyset).toHaveBeenCalledWith(
        "https://mint.example",
        expect.objectContaining({
          keysetId: "conditional-keyset",
          conditional: true,
        }),
      );
    },
  );

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
