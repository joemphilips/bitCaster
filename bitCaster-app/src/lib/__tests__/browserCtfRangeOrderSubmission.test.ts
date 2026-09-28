import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TradeTicket } from "@bitcaster/client-sdk/tradeTicket";
import type { CtfRangeOrderFeeFacts } from "@bitcaster/client-sdk/ctfRangeOrderFeeComposition";
import type { MarketDetail } from "@/types/market-detail";
import {
  BrowserCtfRangeScoreTopUpCancelledError,
  BrowserCtfRangeScoreTopUpRequiredError,
  previewBrowserCtfRangeOrderFees,
  recoverBrowserCtfRangeOrder,
  recoverBrowserCtfRangeOrders,
  submitBrowserCtfRangeOrder,
  type BrowserCtfRangeOrderSubmission,
} from "../browserCtfRangeOrderSubmission";
import { BrowserCtfRangeOrderError } from "../browserCtfRangeOrderCoordinator";
import {
  listenForBrowserCtfRangeRecoveryWake,
  publishBrowserCtfRangeRecoveryWake,
} from "../browserCtfRangeOrderRecoveryWake";

const KEYSET_KEYS = Object.fromEntries(
  [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384].map((amount) => [
    String(amount),
    `02${"11".repeat(32)}`,
  ]),
);

// One share at divisibility 1,000 is 1,000 msat of conditional face value.
const ONE_SHARE_FACE_SUBUNITS = 1_000;
// A one-share Sell authorizes 1,000 = 512 + 256 + 128 + 64 + 32 + 8.
const ONE_SHARE_SELL_AUTHORIZATION_OUTPUTS = 6;
// A one-share Buy at 400 authorizes 401 = 256 + 128 + 16 + 1 (price plus fee).
const ONE_SHARE_BUY_AUTHORIZATION_OUTPUTS = 4;

const mocks = vi.hoisted(() => ({
  buildPreparation: vi.fn(),
  candidates: [{ id: "regular-keyset", amount: 10_000, secret: "secret", C: "02" }],
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
  readPreparation: vi.fn(),
  recordMessage: vi.fn(),
  ensureParticipationScoreForNextMatch: vi.fn(),
  counterReady: vi.fn(),
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
  readCtfRangePreparation: mocks.readPreparation,
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

vi.mock("../cashu", () => ({ ensureWalletKeysetCounterReady: mocks.counterReady }));

vi.mock("../browserCtfRangeOrderCoordinator", () => ({
  buildBrowserCtfRangeOrderPreparation: mocks.buildPreparation,
  BrowserCtfRangeOrderError: class extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly shortfall: string | null = null,
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
    mocks.planConsolidation.mockReset();
    mocks.getBoundedCanonicalRangeProofsForKeyset.mockReset();
    mocks.recoverFundedAsset.mockReset();
    mocks.counterReady.mockResolvedValue(undefined);
    mocks.buildPreparation.mockImplementation(({ request }) => preparationFor(request));
    mocks.engine.getSettlementCapabilityAdmissionPolicy.mockResolvedValue({
      coordinatorPubkey: "11".repeat(32),
    });
    mocks.loadMintMetadata.mockResolvedValue({ maxOutputs: 256, observation: {} });
    mocks.candidates = [{ id: "regular-keyset", amount: 10_000, secret: "secret", C: "02" }];
    mocks.getBoundedCanonicalRangeProofsForKeyset.mockImplementation((_mintUrl, { keysetId }) =>
      keysetId === "conditional-keyset"
        ? [
            {
              id: keysetId,
              amount: ONE_SHARE_FACE_SUBUNITS,
              secret: "conditional-secret",
              C: "02",
            },
          ]
        : mocks.candidates,
    );
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
    mocks.readPreparation.mockResolvedValue(null);
    mocks.readPreparation.mockClear();
    mocks.recordMessage.mockResolvedValue(undefined);
    mocks.ensureParticipationScoreForNextMatch.mockReset();
    mocks.recoverFundedAsset.mockImplementation(async ({ loadPlan }) => ({
      kind: "ready",
      plan: await loadPlan(),
    }));
  });

  it("wakes existing recovery once after a failed active attempt retains work", async () => {
    let rejectAttempt!: (error: Error) => void;
    mocks.prepareAndSubmit.mockImplementationOnce(
      () => new Promise<never>((_resolve, reject) => (rejectAttempt = reject)),
    );
    mocks.readPreparation.mockResolvedValue({ lifecycleState: "prepared" });
    const wakes: string[] = [];
    const stopWake = listenForBrowserCtfRangeRecoveryWake("custody:wallet:scope-1", () => {
      wakes.push("wake");
    });

    const submission = submitRangeOrder("client-retained-recovery");
    await vi.waitFor(() => expect(mocks.prepareAndSubmit).toHaveBeenCalledOnce());
    expect(wakes).toHaveLength(0);
    rejectAttempt(new Error("active attempt failed"));
    await expect(submission).rejects.toThrow("active attempt failed");

    expect(wakes).toEqual(["wake"]);
    stopWake();
  });

  it("does not wake for a successful or terminal active attempt", async () => {
    const wakes: string[] = [];
    const stopWake = listenForBrowserCtfRangeRecoveryWake("custody:wallet:scope-1", () => {
      wakes.push("wake");
    });

    await expect(submitRangeOrder("client-success-no-recovery")).resolves.toEqual({
      orderId: "order-1",
    });
    expect(wakes).toHaveLength(0);

    mocks.prepareAndSubmit.mockRejectedValueOnce(new Error("terminal attempt failed"));
    mocks.readPreparation.mockResolvedValue({ lifecycleState: "terminal" });
    await expect(submitRangeOrder("client-terminal-no-recovery")).rejects.toThrow(
      "terminal attempt failed",
    );
    expect(wakes).toHaveLength(0);
    stopWake();
  });

  it("lets a recovery wake run recovery without submitting a new order", async () => {
    mocks.recoverPage.mockResolvedValue({
      recoveredOperationIds: [],
      pending: [],
      nextCursor: null,
    });
    const recovery = vi.fn(() =>
      recoverBrowserCtfRangeOrders({
        mnemonic:
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        mintUrls: ["https://mint.example"],
      }),
    );
    const stopWake = listenForBrowserCtfRangeRecoveryWake("custody:wallet:scope-1", () => {
      void recovery();
    });

    publishBrowserCtfRangeRecoveryWake({ scopeId: "custody:wallet:scope-1" });
    await vi.waitFor(() => expect(recovery).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(mocks.recoverPage).toHaveBeenCalledOnce());
    expect(mocks.prepareAndSubmit).not.toHaveBeenCalled();
    stopWake();
  });

  it("recovers an insufficient explicit submission before returning insufficient funds", async () => {
    mocks.candidates = [];
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
            timeInForce: "FOK",
          },
        },
        clientOrderId: "client-recover",
        mintUrl: "https://mint.example",
        mnemonic:
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        consentedFeeFacts: feeFacts(),
      }),
    ).rejects.toMatchObject({ code: "insufficient-funds", shortfall: "offered" });

    expect(mocks.recoverFundedAsset).toHaveBeenCalledOnce();
  });

  it("records a revision-zero durable funds error when exact recovery fails", async () => {
    mocks.candidates = [];
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
            timeInForce: "FOK",
          },
        },
        clientOrderId: "client-recovery-error",
        mintUrl: "https://mint.example",
        mnemonic:
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        consentedFeeFacts: feeFacts(),
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
    mocks.candidates = [];
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
    mocks.candidates = [];
    mocks.recoverFundedAsset.mockImplementation(async () => {
      mocks.candidates = [{ id: "regular-keyset", amount: 10_000, secret: "recovered", C: "02" }];
      return { kind: "recovered" };
    });

    await expect(submitRangeOrder("client-recovery-ready")).resolves.toEqual({
      orderId: "order-1",
    });

    expect(mocks.planConsolidation).not.toHaveBeenCalled();
    expect(mocks.prepareAndSubmit).toHaveBeenCalledOnce();
  });

  it("submits a durable FOK ticket as GUI FOK", async () => {
    const ticket: TradeTicket = {
      marketId: "condition-1-YES",
      request: {
        outcomeId: "YES",
        tokenSide: "Outcome",
        side: "Buy",
        price: 400,
        amountSubunits: 1_000,
        timeInForce: "FOK",
      },
    };

    await submitBrowserCtfRangeOrder({
      market: market(),
      ticket,
      clientOrderId: "client-1",
      mintUrl: "https://mint.example",
      mnemonic:
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      consentedFeeFacts: feeFacts(),
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
          timeInForce: "FOK",
        }),
      }),
    );
    expect(mocks.prepareAndSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: mocks.candidates,
        preparation: expect.objectContaining({ operationId: "range-operation" }),
      }),
    );
    expect(mocks.counterReady).toHaveBeenCalledWith({
      scopeId: "custody:wallet:scope-1",
      mintUrl: "https://mint.example",
      unit: "msat",
      keyset: expect.objectContaining({ id: "regular-keyset" }),
    });
    expect(mocks.counterReady.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.prepareAndSubmit.mock.invocationCallOrder[0]!,
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

  it("previews and submits exact held shares with cash for fees under the authenticated output bound", async () => {
    const offered = {
      id: "conditional-keyset",
      amount: ONE_SHARE_FACE_SUBUNITS,
      secret: "held-share",
      C: "held-C",
    };
    const cash = { id: "regular-keyset", amount: 1, secret: "fee-cash", C: "cash-C" };
    const maxOutputs = ONE_SHARE_SELL_AUTHORIZATION_OUTPUTS;
    mocks.loadMintMetadata.mockResolvedValue({ maxOutputs, observation: {} });
    mocks.getBoundedCanonicalRangeProofsForKeyset.mockImplementation((_mintUrl, { keysetId }) =>
      keysetId === "conditional-keyset" ? [offered] : [cash],
    );

    const preview = await previewBrowserCtfRangeOrderFees({
      market: market("condition-exact-mixed"),
      ticket: sellTicket("condition-exact-mixed"),
      mintUrl: "https://mint.example",
    });

    expect(preview).toEqual(
      feeFacts("Sell", {
        source: "1",
        sourceMode: "mixed-source-ctf-convert",
        sourcePreparationAsset: { kind: "regular", unit: "msat" },
        consolidation: "0",
      }),
    );
    expect(mocks.counterReady).not.toHaveBeenCalled();
    expect(mocks.consolidateRound).not.toHaveBeenCalled();
    expect(mocks.prepareAndSubmit).not.toHaveBeenCalled();

    await submitSellOrder("client-mixed-exact", preview, "condition-exact-mixed");

    expect(mocks.counterReady).toHaveBeenCalledTimes(2);
    expect(mocks.counterReady).toHaveBeenCalledWith(
      expect.objectContaining({ keyset: expect.objectContaining({ id: "conditional-keyset" }) }),
    );
    expect(mocks.counterReady).toHaveBeenCalledWith(
      expect.objectContaining({ keyset: expect.objectContaining({ id: "regular-keyset" }) }),
    );
    expect(mocks.prepareAndSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: [offered],
        collateralCandidates: [cash],
        maxOutputs,
        currentFeeFacts: preview,
      }),
    );
    expect(mocks.consolidateRound).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "held shares cover the face but no regular cash pays the fee",
      heldSubunits: [ONE_SHARE_FACE_SUBUNITS],
      regularSubunits: [],
      maxOutputs: 256,
      shortfall: "collateral",
      offeredAssetRecoveries: 0,
    },
    {
      name: "fee cash is present but the joint outputs exceed the mint bound",
      heldSubunits: [ONE_SHARE_FACE_SUBUNITS],
      regularSubunits: [2],
      maxOutputs: ONE_SHARE_SELL_AUTHORIZATION_OUTPUTS,
      shortfall: "mint-limits",
      offeredAssetRecoveries: 0,
    },
    {
      name: "cash covers face and fee but 125 held proofs exceed the input bound",
      heldSubunits: Array.from({ length: 125 }, () => 8),
      regularSubunits: [2 * ONE_SHARE_FACE_SUBUNITS],
      maxOutputs: 256,
      shortfall: "mint-limits",
      offeredAssetRecoveries: 0,
    },
    {
      name: "a partial holding cannot be completed from regular cash",
      heldSubunits: [999],
      regularSubunits: [ONE_SHARE_FACE_SUBUNITS + 10],
      maxOutputs: 256,
      shortfall: "offered",
      offeredAssetRecoveries: 1,
    },
    {
      name: "no held shares cannot be synthesized from regular cash",
      heldSubunits: [],
      regularSubunits: [ONE_SHARE_FACE_SUBUNITS + 10],
      maxOutputs: 256,
      shortfall: "offered",
      offeredAssetRecoveries: 1,
    },
  ])(
    "refuses a one-share Sell and names the shortfall when $name",
    async ({ heldSubunits, regularSubunits, maxOutputs, shortfall, offeredAssetRecoveries }) => {
      // Mint metadata is cached per condition, so each output bound uses its own condition.
      const conditionId = `condition-sell-refusal-${maxOutputs}`;
      mocks.loadMintMetadata.mockResolvedValue({ maxOutputs, observation: {} });
      mocks.planConsolidation.mockReturnValue({ kind: "insufficient" });
      mocks.getBoundedCanonicalRangeProofsForKeyset.mockImplementation((_mintUrl, { keysetId }) =>
        (keysetId === "conditional-keyset" ? heldSubunits : regularSubunits).map(
          (amount, index) => ({ id: keysetId, amount, secret: `${keysetId}-${index}`, C: "02" }),
        ),
      );

      await expect(
        previewBrowserCtfRangeOrderFees({
          market: market(conditionId),
          ticket: sellTicket(conditionId),
          mintUrl: "https://mint.example",
        }),
      ).rejects.toMatchObject({ code: "insufficient-funds", shortfall });
      await expect(
        submitSellOrder("client-sell-refusal", feeFacts("Sell"), conditionId),
      ).rejects.toMatchObject({ code: "insufficient-funds", shortfall });

      expect(mocks.recoverFundedAsset).toHaveBeenCalledTimes(offeredAssetRecoveries);
      expect(mocks.consolidateRound).not.toHaveBeenCalled();
      expect(mocks.prepareAndSubmit).not.toHaveBeenCalled();
    },
  );

  it("reselects mixed Sell sources after funded recovery restores an exact held position", async () => {
    const held = {
      id: "conditional-keyset",
      amount: ONE_SHARE_FACE_SUBUNITS,
      secret: "recovered-held-share",
      C: "held-C",
    };
    const cash = { id: "regular-keyset", amount: 1, secret: "fee-cash", C: "cash-C" };
    let restored = false;
    mocks.planConsolidation.mockReturnValue({ kind: "insufficient" });
    mocks.getBoundedCanonicalRangeProofsForKeyset.mockImplementation((_mintUrl, { keysetId }) =>
      keysetId === "conditional-keyset" ? (restored ? [held] : []) : [cash],
    );
    mocks.recoverFundedAsset.mockImplementation(async () => {
      restored = true;
      return { kind: "recovered" };
    });

    await expect(
      submitSellOrder(
        "client-recovered-mixed-sell",
        feeFacts("Sell"),
        "condition-recovered-mixed-sell",
      ),
    ).resolves.toEqual({ orderId: "order-1" });

    expect(mocks.recoverFundedAsset).toHaveBeenCalledOnce();
    expect(mocks.consolidateRound).not.toHaveBeenCalled();
    expect(mocks.prepareAndSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: [held],
        collateralCandidates: [cash],
        maxOutputs: 256,
      }),
    );
  });

  it("keeps the consented fee-funded Sell mode after consolidating fragmented shares", async () => {
    const actualSourceOperation = await vi.importActual<
      typeof import("@bitcaster/client-sdk/ctfRangeSourceOperation")
    >("@bitcaster/client-sdk/ctfRangeSourceOperation");
    let held = Array.from({ length: 90 }, (_, index) => ({
      id: "conditional-keyset",
      amount: 12,
      secret: `held-fragment-${String(index).padStart(2, "0")}`,
      C: `held-C-${index}`,
    }));
    const cash = { id: "regular-keyset", amount: 2, secret: "fee-cash", C: "cash-C" };
    mocks.planConsolidation.mockImplementation(
      actualSourceOperation.planCtfRangeSourceConsolidation,
    );
    mocks.getBoundedCanonicalRangeProofsForKeyset.mockImplementation((_mintUrl, { keysetId }) =>
      keysetId === "conditional-keyset" ? held : [cash],
    );
    mocks.consolidateRound.mockImplementation(async ({ inputs, plannedRound }) => {
      const consumed = new Set(inputs.map((proof: { secret: string }) => proof.secret));
      held = [
        ...held.filter((proof) => !consumed.has(proof.secret)),
        ...plannedRound.outputs.map((amount: string, index: number) => ({
          id: "conditional-keyset",
          amount: Number(amount),
          secret: `held-consolidated-${index}`,
          C: `held-consolidated-C-${index}`,
        })),
      ];
    });

    const preview = await previewBrowserCtfRangeOrderFees({
      market: market("condition-fragmented-sell"),
      ticket: sellTicket("condition-fragmented-sell"),
      mintUrl: "https://mint.example",
    });
    expect(preview).toEqual(
      feeFacts("Sell", {
        source: "1",
        consolidation: "1",
        sourceMode: "conditional-keyset-swap",
      }),
    );

    await expect(
      submitSellOrder("client-fragmented-sell", preview, "condition-fragmented-sell"),
    ).resolves.toEqual({ orderId: "order-1" });

    expect(mocks.consolidateRound).toHaveBeenCalledOnce();
    expect(mocks.prepareAndSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        collateralCandidates: [],
        paidConsolidationFeeSubunits: "1",
        currentFeeFacts: feeFacts("Sell", {
          source: "1",
          consolidation: "0",
          sourceMode: "conditional-keyset-swap",
        }),
      }),
    );
  });

  it("refuses source output plans that exceed the current authenticated bound", async () => {
    mocks.loadMintMetadata.mockResolvedValue({
      maxOutputs: ONE_SHARE_SELL_AUTHORIZATION_OUTPUTS - 1,
      observation: {},
    });
    mocks.getBoundedCanonicalRangeProofsForKeyset.mockImplementation((_mintUrl, { keysetId }) =>
      keysetId === "conditional-keyset"
        ? [{ id: keysetId, amount: ONE_SHARE_FACE_SUBUNITS, secret: "held-share", C: "held-C" }]
        : [{ id: keysetId, amount: 1, secret: "fee-cash", C: "cash-C" }],
    );

    await expect(
      previewBrowserCtfRangeOrderFees({
        market: market("condition-output-bound"),
        ticket: sellTicket("condition-output-bound"),
        mintUrl: "https://mint.example",
      }),
    ).rejects.toThrow();
    expect(mocks.consolidateRound).not.toHaveBeenCalled();
    expect(mocks.prepareAndSubmit).not.toHaveBeenCalled();
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
        recoveryStatus: "insufficient",
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
          timeInForce: "FOK",
        },
      },
      clientOrderId: "client-score-top-up",
      mintUrl: "https://mint.example",
      mnemonic:
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      consentedFeeFacts: feeFacts(),
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
    expect(onScoreTopUpRequired).toHaveBeenCalledWith({
      requiredSats: 3,
      balanceSats: 0,
      recoveryStatus: "insufficient",
    });
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

  it("requires a new explicit continuation for every unavailable Score retry", async () => {
    const score = { purchasedTotal: 0, balance: -3, enabled: true };
    mocks.ensureParticipationScoreForNextMatch
      .mockResolvedValueOnce({
        kind: "needs-regular-top-up",
        score,
        requiredSats: 3,
        balanceSats: 0,
        deficitSats: 3,
        recoveryStatus: "unavailable",
      })
      .mockResolvedValueOnce({
        kind: "needs-regular-top-up",
        score,
        requiredSats: 3,
        balanceSats: 0,
        deficitSats: 3,
        recoveryStatus: "unavailable",
      })
      .mockResolvedValueOnce({ kind: "sufficient", score: { ...score, balance: 3 } });
    const releases: Array<() => void> = [];
    const onScoreTopUpRequired = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );

    await submitBrowserCtfRangeOrder(scoreOrderInput(onScoreTopUpRequired));

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
    expect(onScoreTopUpRequired).toHaveBeenCalledWith({
      requiredSats: 3,
      balanceSats: 0,
      recoveryStatus: "unavailable",
    });
    expect(onScoreTopUpRequired).toHaveBeenCalledTimes(1);
    expect(releases).toHaveLength(1);
    expect(mocks.ensureParticipationScoreForNextMatch).toHaveBeenCalledTimes(1);
    let completed = false;
    void continuation.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    releases[0]!();
    await Promise.resolve();
    await Promise.resolve();
    expect(onScoreTopUpRequired).toHaveBeenCalledTimes(2);
    expect(releases).toHaveLength(2);
    expect(mocks.ensureParticipationScoreForNextMatch).toHaveBeenCalledTimes(2);
    expect(completed).toBe(false);

    releases[1]!();
    await continuation;
    expect(mocks.ensureParticipationScoreForNextMatch).toHaveBeenCalledTimes(3);
    expect(mocks.ensureParticipationScoreForNextMatch).toHaveBeenNthCalledWith(1, {
      mintUrl: "https://mint.example",
      requiredScore: 7,
    });
    expect(mocks.ensureParticipationScoreForNextMatch).toHaveBeenNthCalledWith(2, {
      mintUrl: "https://mint.example",
      requiredScore: 7,
    });
    expect(mocks.ensureParticipationScoreForNextMatch).toHaveBeenNthCalledWith(3, {
      mintUrl: "https://mint.example",
      requiredScore: 7,
    });
    expect(mocks.prepareAndSubmit).toHaveBeenCalledOnce();
  });

  it("throws the typed Score top-up error when no continuation is available", async () => {
    mocks.ensureParticipationScoreForNextMatch.mockResolvedValueOnce({
      kind: "needs-regular-top-up",
      score: { purchasedTotal: 0, balance: -3, enabled: true },
      requiredSats: 3,
      balanceSats: null,
      deficitSats: null,
      recoveryStatus: "unavailable",
    });

    await submitBrowserCtfRangeOrder(scoreOrderInput());
    const beforeCreateCapability = (
      mocks.coordinatorInput as {
        beforeCreateCapability: (input: {
          mintUrl: string;
          requiredScore: number;
        }) => Promise<void>;
      }
    ).beforeCreateCapability;

    await expect(
      beforeCreateCapability({ mintUrl: "https://mint.example", requiredScore: 7 }),
    ).rejects.toMatchObject({
      name: "BrowserCtfRangeScoreTopUpRequiredError",
      recoveryStatus: "unavailable",
      balanceSats: null,
    });
    expect(mocks.ensureParticipationScoreForNextMatch).toHaveBeenCalledOnce();
  });

  it("propagates Score top-up cancellation without another ensure", async () => {
    const cancellation = new BrowserCtfRangeScoreTopUpCancelledError();
    mocks.ensureParticipationScoreForNextMatch.mockResolvedValueOnce({
      kind: "needs-regular-top-up",
      score: { purchasedTotal: 0, balance: -3, enabled: true },
      requiredSats: 3,
      balanceSats: 0,
      deficitSats: 3,
      recoveryStatus: "unavailable",
    });
    const onScoreTopUpRequired = vi.fn().mockRejectedValue(cancellation);

    await submitBrowserCtfRangeOrder(scoreOrderInput(onScoreTopUpRequired));
    const beforeCreateCapability = (
      mocks.coordinatorInput as {
        beforeCreateCapability: (input: {
          mintUrl: string;
          requiredScore: number;
        }) => Promise<void>;
      }
    ).beforeCreateCapability;

    await expect(
      beforeCreateCapability({ mintUrl: "https://mint.example", requiredScore: 7 }),
    ).rejects.toBe(cancellation);
    expect(onScoreTopUpRequired).toHaveBeenCalledOnce();
    expect(mocks.ensureParticipationScoreForNextMatch).toHaveBeenCalledOnce();
  });

  it("records a retained-funds explanation for a cancelled Score continuation", async () => {
    const cancellation = new BrowserCtfRangeScoreTopUpCancelledError();
    mocks.readPreparation.mockResolvedValue({ revision: 3, lifecycleState: "prepared" });
    mocks.prepareAndSubmit.mockRejectedValueOnce(cancellation);

    await expect(submitRangeOrder("client-score-cancelled")).rejects.toBe(cancellation);

    expect(mocks.recordMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "range-operation",
        revision: 3,
        code: "score-top-up-cancelled",
        kind: "order",
      }),
    );
    expect(mocks.recordMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "range-operation",
        revision: 3,
        code: "recovery-pending",
        kind: "funds",
      }),
    );
  });

  it("records a retained-funds explanation for required Score continuation", async () => {
    const required = new BrowserCtfRangeScoreTopUpRequiredError({
      requiredSats: 3,
      balanceSats: 0,
      recoveryStatus: "insufficient",
    });
    mocks.readPreparation.mockResolvedValue({ revision: 4, lifecycleState: "prepared" });
    mocks.prepareAndSubmit.mockRejectedValueOnce(required);

    await expect(submitRangeOrder("client-score-required")).rejects.toBe(required);

    expect(mocks.recordMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "range-operation",
        revision: 4,
        code: "score-top-up-required",
        kind: "order",
      }),
    );
    expect(mocks.recordMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "range-operation",
        revision: 4,
        code: "recovery-pending",
        kind: "funds",
      }),
    );
  });

  it("records a terminal order explanation without stale pending-funds recovery", async () => {
    const ended = new BrowserCtfRangeOrderError(
      "order-attempt-ended",
      "The prepared order attempt ended before capability creation. No order was submitted.",
    );
    mocks.readPreparation.mockResolvedValue({ revision: 5, lifecycleState: "terminal" });
    mocks.prepareAndSubmit.mockRejectedValueOnce(ended);

    await expect(submitRangeOrder("client-score-terminal")).rejects.toBe(ended);

    expect(mocks.recordMessage).toHaveBeenCalledTimes(1);
    expect(mocks.recordMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "range-operation",
        revision: 5,
        code: "order-attempt-ended",
        kind: "order",
      }),
    );
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
          timeInForce: "FOK",
        },
      };

      await submitBrowserCtfRangeOrder({
        market: market(),
        ticket,
        clientOrderId: "client-sell",
        mintUrl: "https://mint.example",
        mnemonic:
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        consentedFeeFacts: feeFacts("Sell"),
      });

      expect(mocks.counterReady).toHaveBeenCalledWith({
        scopeId: "custody:wallet:scope-1",
        mintUrl: "https://mint.example",
        unit: "msat",
        keyset: expect.objectContaining({ id: "conditional-keyset" }),
        conditionalAsset: {
          conditionId: "11".repeat(32),
          outcomeCollection: "YES",
        },
      });
      expect(mocks.counterReady.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.prepareAndSubmit.mock.invocationCallOrder[0]!,
      );
      expect(mocks.counterReady).toHaveBeenCalledWith(
        expect.objectContaining({ keyset: expect.objectContaining({ id: "regular-keyset" }) }),
      );
      expect(mocks.getBoundedCanonicalRangeProofsForKeyset).toHaveBeenCalledWith(
        "https://mint.example",
        expect.objectContaining({
          keysetId: "conditional-keyset",
          asset: expect.objectContaining({ kind: "conditional" }),
        }),
      );
    },
  );

  it.each(["Buy", "Sell"] as const)(
    "does not prepare or submit %s when selected counter recovery fails",
    async (side) => {
      const input = scoreOrderInput();
      mocks.counterReady.mockRejectedValue(new Error("private upstream detail"));

      await expect(
        submitBrowserCtfRangeOrder({
          ...input,
          ticket: { ...input.ticket, request: { ...input.ticket.request, side } },
          consentedFeeFacts: feeFacts(side),
        }),
      ).rejects.toMatchObject({
        code: "source-preparation-failed",
        message:
          "The wallet could not finish preparing this order. No order was submitted. Please try again.",
      });
      expect(mocks.recoverFundedAsset).not.toHaveBeenCalled();
      expect(mocks.consolidateRound).not.toHaveBeenCalled();
      expect(mocks.prepareAndSubmit).not.toHaveBeenCalled();
      expect(mocks.recordMessage).not.toHaveBeenCalled();
    },
  );

  it("previews the exact proof consolidation fee for the trade pane", async () => {
    mocks.candidates = fragmentedRegularCandidatesWithRoundInputs();
    mocks.planConsolidation.mockReturnValueOnce({
      kind: "ready",
      consolidationRounds: [{ inputs: ["4", "2"], outputs: ["4", "1"], fee: "1" }],
      selectedInputs: ["10000"],
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
            timeInForce: "FOK",
          },
        },
        mintUrl: "https://mint.example",
      }),
    ).resolves.toEqual(feeFacts("Buy", { source: "2", consolidation: "1" }));
  });

  it("previews a below-face buy from 512 msat using the real source planner", async () => {
    mocks.getBoundedCanonicalRangeProofsForKeyset.mockResolvedValueOnce([
      { id: "regular-keyset", amount: 512, secret: "canonical-secret", C: "canonical-C" },
    ]);

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
            timeInForce: "FOK",
          },
        },
        mintUrl: "https://mint.example",
      }),
    ).resolves.toEqual(feeFacts("Buy", { source: "1", consolidation: "0" }));

    expect(mocks.getBoundedCanonicalRangeProofsForKeyset).toHaveBeenCalledWith(
      "https://mint.example",
      expect.objectContaining({ keysetId: "regular-keyset", unit: "msat" }),
    );
    expect(mocks.planConsolidation).not.toHaveBeenCalled();
  });

  it("executes each planned consolidation round before source preparation", async () => {
    const actualSourceOperation = await vi.importActual<
      typeof import("@bitcaster/client-sdk/ctfRangeSourceOperation")
    >("@bitcaster/client-sdk/ctfRangeSourceOperation");
    mocks.candidates = fragmentedRegularCandidates();
    mocks.planConsolidation.mockImplementation(
      actualSourceOperation.planCtfRangeSourceConsolidation,
    );
    mocks.consolidateRound.mockImplementation(async ({ inputs, plannedRound }) => {
      const consumed = new Set(inputs.map((proof: { secret: string }) => proof.secret));
      mocks.candidates = mocks.candidates.filter((proof) => !consumed.has(proof.secret));
      mocks.candidates.push(
        ...plannedRound.outputs.map((amount: string, index: number) => ({
          id: "regular-keyset",
          amount: Number(amount),
          secret: `consolidated-${index}`,
          C: `C-consolidated-${index}`,
        })),
      );
    });

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
          timeInForce: "FOK",
        },
      },
      clientOrderId: "client-consolidated",
      mintUrl: "https://mint.example",
      mnemonic:
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      consentedFeeFacts: feeFacts("Buy", { source: "1", consolidation: "1" }),
    });

    expect(mocks.consolidateRound).toHaveBeenCalledOnce();
    expect(mocks.consolidateRound).toHaveBeenCalledWith(
      expect.objectContaining({
        round: 0,
        inputs: expect.arrayContaining([
          expect.objectContaining({ id: "regular-keyset", amount: 6 }),
        ]),
        plannedRound: expect.objectContaining({ fee: "1" }),
      }),
    );
    expect(mocks.prepareAndSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: expect.arrayContaining([expect.objectContaining({ id: "regular-keyset" })]),
        collateralCandidates: [],
        maxOutputs: 256,
      }),
    );
  });

  it("checks the authenticated output bound on each planned consolidation round before spending", async () => {
    const actualSourceOperation = await vi.importActual<
      typeof import("@bitcaster/client-sdk/ctfRangeSourceOperation")
    >("@bitcaster/client-sdk/ctfRangeSourceOperation");
    const conditionId = "condition-round-output-bound";
    mocks.candidates = fragmentedRegularCandidates();
    mocks.loadMintMetadata.mockResolvedValue({
      maxOutputs: ONE_SHARE_BUY_AUTHORIZATION_OUTPUTS,
      observation: {},
    });
    mocks.planConsolidation.mockImplementation(
      actualSourceOperation.planCtfRangeSourceConsolidation,
    );

    await expect(
      submitBrowserCtfRangeOrder({
        market: market(conditionId),
        ticket: {
          marketId: `${conditionId}-YES`,
          request: {
            outcomeId: "YES",
            tokenSide: "Outcome",
            side: "Buy",
            price: 400,
            amountSubunits: 1_000,
            timeInForce: "FOK",
          },
        },
        clientOrderId: "client-round-output-bound",
        mintUrl: "https://mint.example",
        mnemonic:
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        consentedFeeFacts: feeFacts("Buy", { source: "1", consolidation: "1" }),
      }),
    ).rejects.toMatchObject({ code: "source-preparation-failed" });

    expect(mocks.consolidateRound).not.toHaveBeenCalled();
    expect(mocks.prepareAndSubmit).not.toHaveBeenCalled();
  });

  it("does not mutate proofs when the displayed consolidation fee is stale", async () => {
    mocks.candidates = fragmentedRegularCandidatesWithRoundInputs();
    mocks.planConsolidation.mockReturnValueOnce({
      kind: "ready",
      consolidationRounds: [{ inputs: ["4", "2"], outputs: ["4", "1"], fee: "1" }],
      selectedInputs: ["10000"],
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
            timeInForce: "FOK",
          },
        },
        clientOrderId: "client-declined",
        mintUrl: "https://mint.example",
        mnemonic:
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        consentedFeeFacts: feeFacts("Buy", { source: "1" }),
      }),
    ).rejects.toThrow("Wallet proof fees changed");

    expect(mocks.consolidateRound).not.toHaveBeenCalled();
    expect(mocks.prepareAndSubmit).not.toHaveBeenCalled();
  });

  it.each([
    ["settlement input", { settlement: "2" }],
    ["source preparation", { source: "2" }],
    ["consolidation", { consolidation: "2" }],
  ] as const)("rejects a changed %s fee before the first consolidation", async (_label, change) => {
    mocks.candidates = fragmentedRegularCandidatesWithRoundInputs();
    mocks.planConsolidation.mockReturnValueOnce({
      kind: "ready",
      consolidationRounds: [{ inputs: ["4", "2"], outputs: ["4", "1"], fee: "1" }],
      selectedInputs: ["10000"],
      consolidationFee: "1",
      sourceFee: "1",
    });

    await expect(
      submitRangeOrderWithFacts(
        "client-changed-fee",
        feeFacts("Buy", { source: "1", consolidation: "1", ...change }),
      ),
    ).rejects.toMatchObject({ code: "source-preparation-failed" });

    expect(mocks.consolidateRound).not.toHaveBeenCalled();
    expect(mocks.prepareAndSubmit).not.toHaveBeenCalled();
  });

  it("stops before another mint call when replanning exceeds the approved fee", async () => {
    mocks.candidates = fragmentedRegularCandidatesWithRoundInputs();
    mocks.planConsolidation
      .mockReturnValueOnce({
        kind: "ready",
        consolidationRounds: [{ inputs: ["4", "2"], outputs: ["4", "1"], fee: "1" }],
        selectedInputs: ["10000"],
        consolidationFee: "1",
        sourceFee: "1",
      })
      .mockReturnValueOnce({
        kind: "ready",
        consolidationRounds: [{ inputs: ["4", "1"], outputs: ["4"], fee: "1" }],
        selectedInputs: ["10000"],
        consolidationFee: "1",
        sourceFee: "1",
      });
    mocks.getBoundedCanonicalRangeProofsForKeyset.mockResolvedValue([
      { id: "regular-keyset", amount: 4, secret: "four", C: "C-four" },
      { id: "regular-keyset", amount: 2, secret: "two", C: "C-two" },
    ]);

    await expect(submitRangeOrder("client-replanned-fee", 1, "1")).rejects.toThrow(
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
        timeInForce: "FOK",
      },
    };
    const input = {
      market: { ...market(), id: "condition-cache" },
      ticket,
      mintUrl: "https://mint.example",
      mnemonic:
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      consentedFeeFacts: feeFacts(),
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
            timeInForce: "FOK",
          },
        },
        clientOrderId: "client-1",
        mintUrl: "https://mint.example",
        mnemonic: "",
        consentedFeeFacts: feeFacts(),
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
    expect(mocks.counterReady).not.toHaveBeenCalled();
    expect(mocks.recoverPage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        limit: 64,
        after: { createdAtMs: 10, rangeOperationId: "range-2" },
      }),
    );
  });

  // DurableWalletErrors shows "Funds recovery needs attention" for each active
  // funds message, so a recorded funds message is the visible warning.
  it.each([
    {
      state: "a cancelled FOK before authorization expiry",
      code: "awaiting-authorization-expiry",
      fundsWarning: "not visible",
    },
    {
      state: "an unclassified mint recovery",
      code: "recovery-pending",
      fundsWarning: "visible",
    },
  ] as const)(
    "keeps retrying $state and leaves the funds warning $fundsWarning",
    async ({ code, fundsWarning }) => {
      const pending = [{ operationId: "range-1", revision: 3, code }];
      mocks.recoverPage.mockResolvedValue({
        recoveredOperationIds: [],
        pending,
        nextCursor: null,
      });
      mocks.recoverClientOrder.mockResolvedValue({ recoveredOperationIds: [], pending });
      const wallet = {
        mnemonic:
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        mintUrls: ["https://mint.example"],
      };

      await expect(recoverBrowserCtfRangeOrders(wallet)).resolves.toEqual({
        recovered: 0,
        pending,
      });
      await expect(
        recoverBrowserCtfRangeOrder({ ...wallet, clientOrderId: "client-1" }),
      ).resolves.toEqual({ recovered: 0, pending });

      const fundsMessages = mocks.recordMessage.mock.calls.filter(
        ([message]) => message.kind === "funds",
      );
      expect(fundsMessages.length > 0 ? "visible" : "not visible").toBe(fundsWarning);
    },
  );

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
    expect(mocks.counterReady).not.toHaveBeenCalled();
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

function market(id = "condition-1"): MarketDetail {
  return {
    id,
    type: "yesno",
    baseAsset: "sat",
    divisibility: 1_000,
    outcomes: [
      { id: "yes-id", label: "YES", odds: 50 },
      { id: "no-id", label: "NO", odds: 50 },
    ],
  } as MarketDetail;
}

function sellRequest(): TradeTicket["request"] {
  return {
    outcomeId: "YES",
    tokenSide: "Outcome",
    side: "Sell",
    price: 400,
    amountSubunits: 1_000,
    timeInForce: "FOK",
  };
}

function sellTicket(conditionId = "condition-1"): TradeTicket {
  return { marketId: `${conditionId}-YES`, request: sellRequest() };
}

function submitSellOrder(
  clientOrderId: string,
  consentedFeeFacts: CtfRangeOrderFeeFacts = feeFacts("Sell"),
  conditionId = "condition-1",
) {
  return submitBrowserCtfRangeOrder({
    market: market(conditionId),
    ticket: sellTicket(conditionId),
    clientOrderId,
    mintUrl: "https://mint.example",
    mnemonic:
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    consentedFeeFacts,
  });
}

function preparationFor(request: TradeTicket["request"]) {
  const regularKeyset = {
    id: "regular-keyset",
    canonicalMintUrl: "https://mint.example",
    unit: "msat" as const,
    active: true as const,
    inputFeePpk: 1,
    finalExpiry: null,
    keys: KEYSET_KEYS,
  };
  const offeredConditional = {
    id: "conditional-keyset",
    canonicalMintUrl: "https://mint.example",
    unit: "msat" as const,
    active: true as const,
    inputFeePpk: 1,
    finalExpiry: null,
    keys: KEYSET_KEYS,
    conditionId: "11".repeat(32),
    outcomeCollection: "YES",
    outcomeCollectionId: "22".repeat(32),
    registeredAt: 1,
  };
  const complementKeyset = {
    ...offeredConditional,
    id: "complement-keyset",
    outcomeCollection: "NO",
    outcomeCollectionId: "33".repeat(32),
  };
  return {
    version: 2 as const,
    operationId: "range-operation",
    sourceOperationId: "range-operation:source",
    authorizationId: "range-operation:authorization",
    mintUrl: "https://mint.example",
    conditionId: "11".repeat(32),
    coordinatorPublicKey: "44".repeat(32),
    side: request.side,
    priceNumerator: request.price,
    amountSubunits: request.amountSubunits,
    divisibility: 1_000,
    offerKeyset: request.side === "Sell" ? offeredConditional : regularKeyset,
    receiveKeyset: request.side === "Sell" ? regularKeyset : offeredConditional,
    complementKeyset,
    expiryObservation: {
      canonicalMintUrl: "https://mint.example",
      freshness: "fresh" as const,
      observedAt: 1,
      maxExpirySeconds: 1_000,
      conditionKeysetIds: ["conditional-keyset", "complement-keyset"],
      conditionalKeysets: [],
    },
    expiry: 300,
    maxPoolEntries: 64,
    maxInputs: 64,
    request,
  };
}

function scoreOrderInput(
  onScoreTopUpRequired?: BrowserCtfRangeOrderSubmission["onScoreTopUpRequired"],
): BrowserCtfRangeOrderSubmission {
  return {
    market: market(),
    ticket: {
      marketId: "condition-1-YES",
      request: {
        outcomeId: "YES",
        tokenSide: "Outcome",
        side: "Buy",
        price: 400,
        amountSubunits: 1_000,
        timeInForce: "FOK",
      },
    },
    clientOrderId: "client-score-recovery-unavailable",
    mintUrl: "https://mint.example",
    mnemonic:
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    consentedFeeFacts: feeFacts(),
    onScoreTopUpRequired,
  };
}

function submitRangeOrder(
  clientOrderId: string,
  consolidationFeeSubunits = 0,
  sourceFeeSubunits = "1",
) {
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
        timeInForce: "FOK",
      },
    },
    clientOrderId,
    mintUrl: "https://mint.example",
    mnemonic:
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    consentedFeeFacts: feeFacts("Buy", {
      source: sourceFeeSubunits,
      consolidation: String(consolidationFeeSubunits),
    }),
  });
}

function submitRangeOrderWithFacts(
  clientOrderId: string,
  consentedFeeFacts: ReturnType<typeof feeFacts>,
) {
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
        timeInForce: "FOK",
      },
    },
    clientOrderId,
    mintUrl: "https://mint.example",
    mnemonic:
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    consentedFeeFacts,
  });
}

function feeFacts(
  side: "Buy" | "Sell" = "Buy",
  overrides: {
    settlement?: string;
    source?: string;
    consolidation?: string;
    sourceMode?: "wallet-send" | "conditional-keyset-swap" | "mixed-source-ctf-convert";
    sourcePreparationAsset?: ReturnType<typeof preparationAssetForTest>;
    consolidationAsset?: ReturnType<typeof preparationAssetForTest>;
  } = {},
) {
  const sourceMode =
    overrides.sourceMode ?? (side === "Buy" ? "wallet-send" : "mixed-source-ctf-convert");
  const sourcePreparationAsset =
    overrides.sourcePreparationAsset ??
    (sourceMode === "conditional-keyset-swap"
      ? preparationAssetForTest("Sell")
      : { kind: "regular" as const, unit: "msat" as const });
  return {
    settlementInputFeeSubunits: overrides.settlement ?? "1",
    sourcePreparationFeeSubunits: overrides.source ?? "1",
    consolidationFeeSubunits: overrides.consolidation ?? "0",
    settlementAsset: { kind: "regular", unit: "msat" } as const,
    sourcePreparationAsset,
    consolidationAsset: overrides.consolidationAsset ?? preparationAssetForTest(side),
    sourceMode,
  };
}

function preparationAssetForTest(side: "Buy" | "Sell") {
  return side === "Buy"
    ? ({ kind: "regular", unit: "msat" } as const)
    : ({
        kind: "conditional",
        unit: "msat",
        conditionId: "11".repeat(32),
        outcomeCollection: "YES",
      } as const);
}

// The mocked consolidation rounds spend one 4-msat and one 2-msat proof. The
// 6-msat fragments make the shared planner require consolidation first.
function fragmentedRegularCandidatesWithRoundInputs() {
  return [
    { id: "regular-keyset", amount: 4, secret: "round-input-4", C: "C-round-4" },
    { id: "regular-keyset", amount: 2, secret: "round-input-2", C: "C-round-2" },
    ...fragmentedRegularCandidates(),
  ];
}

function fragmentedRegularCandidates() {
  return Array.from({ length: 80 }, (_, index) => ({
    id: "regular-keyset",
    amount: 6,
    secret: `fragment-${String(index).padStart(2, "0")}`,
    C: `C-${index}`,
  }));
}
