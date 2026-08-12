import { beforeEach, describe, expect, it, vi } from "vitest";
import { Amount, OutputData } from "@cashu/cashu-ts";

const mocks = vi.hoisted(() => ({
  classifyBearer: vi.fn(),
  executeOutgoing: vi.fn(),
  getBoundedCanonicalRegularProofs: vi.fn(),
  getWalletForUnit: vi.fn(),
  recoverFundedAsset: vi.fn(),
  readOutgoing: vi.fn(),
  registerCondition: vi.fn(),
  restoreExactMintOutputs: vi.fn(),
  requireCapturedProfile: vi.fn(),
  wallet: null as ReturnType<typeof registrationWallet> | null,
}));

vi.mock("@/lib/browserDurableOutgoingCashuTransfer", () => ({
  classifyBrowserDurableOutgoingBearerTransfer: (...args: unknown[]) =>
    mocks.classifyBearer(...args),
  executeBrowserDurableOutgoingCashuTransfer: (...args: unknown[]) =>
    mocks.executeOutgoing(...args),
  readBrowserDurableOutgoingCashuTransfer: (...args: unknown[]) => mocks.readOutgoing(...args),
}));

vi.mock("@/lib/browserFundedAssetRecovery", () => ({
  recoverBrowserFundedAsset: (...args: unknown[]) => mocks.recoverFundedAsset(...args),
}));

vi.mock("@/lib/cashu", () => ({
  captureBrowserMintPersistenceContext: () => ({
    database: {},
    mnemonic: "test mnemonic",
    scopeId: "scope-1",
    seed: new Uint8Array(64).fill(1),
    requireCapturedProfile: mocks.requireCapturedProfile,
  }),
  getWalletForUnit: (...args: unknown[]) => mocks.getWalletForUnit(...args),
  restoreExactMintOutputs: (...args: unknown[]) => mocks.restoreExactMintOutputs(...args),
}));

vi.mock("@/lib/markets", () => ({
  MintError: class MintError extends Error {
    constructor(
      public readonly code: number,
      public readonly detail: string,
    ) {
      super(detail);
      this.name = "MintError";
    }
  },
  registerCondition: (...args: unknown[]) => mocks.registerCondition(...args),
}));

vi.mock("@/stores/proof-db", () => ({
  getBoundedCanonicalRegularProofs: (...args: unknown[]) =>
    mocks.getBoundedCanonicalRegularProofs(...args),
}));

const { registerConditionWithFee, registrationFeeForPolicy } =
  await import("../marketRegistrationFee");

const request = {
  tags: [["title", "Registration fee"]],
  announcementHex: "announcement",
  collateral: "sat",
};
const V2_KEYSET_ID = `01${"1".repeat(64)}`;
const WALLET_SEED = new Uint8Array(64).fill(1);

function registrationProof(secret = "registration-input-proof") {
  return {
    id: V2_KEYSET_ID,
    amount: 4,
    secret,
    C: `02${"2".repeat(64)}`,
    mintUrl: "https://mint.example.test",
    baseAsset: "sat" as const,
    unit: "sat" as const,
  };
}

function registrationWallet(keysetId = V2_KEYSET_ID) {
  return {
    checkProofsStates: vi.fn().mockResolvedValue([{ Y: "y-registration-fee", state: "SPENT" }]),
    getKeyset: vi.fn(() => ({ id: keysetId })),
    prepareSwapToSend: vi.fn(async (amount, proofs, config) => {
      config.onCountersReserved({ keysetId, start: 0, count: 2 });
      return {
        amount: Amount.from(amount),
        fees: Amount.zero(),
        keysetId,
        inputs: proofs,
        sendOutputs: [OutputData.createSingleDeterministicData(amount, WALLET_SEED, 0, keysetId)],
        keepOutputs: [OutputData.createSingleDeterministicData(1, WALLET_SEED, 1, keysetId)],
        unselectedProofs: [],
      };
    }),
  };
}

function transfer(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    transferId: "ctf-condition-registration:test",
    walletScopeId: "scope-1",
    mintUrl: "https://mint.example.test",
    unit: "sat",
    requestedAmount: "3",
    deliveryIntent: {
      policy: "bearer-spend-classification",
      tokenBytesLimit: 61_440,
      tokenProofLimit: 512,
    },
    deliveryState: "delivery-pending",
    token: {
      encodedToken: "cashuBtoken",
      sha256: "a".repeat(64),
      encodedLength: 11,
      proofs: [
        {
          id: `01${"a".repeat(64)}`,
          amount: "3",
          secret: "exact-registration-fee-proof",
          C: "02deadbeef",
          dleq: null,
          p2pkE: null,
          witness: null,
        },
      ],
      unspentProofs: null,
      custodyRevisions: [],
    },
    recipientReceipt: null,
    reclaim: null,
    recovery: { dueAtMs: 0, attemptCount: 0 },
    revision: 1,
    ...overrides,
  };
}

describe("registerConditionWithFee", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.wallet = registrationWallet();
    mocks.getWalletForUnit.mockResolvedValue(mocks.wallet);
    mocks.readOutgoing.mockResolvedValue(null);
    mocks.getBoundedCanonicalRegularProofs.mockResolvedValue([registrationProof()]);
    mocks.recoverFundedAsset.mockResolvedValue({ kind: "ready", plan: { kind: "ready" } });
    mocks.executeOutgoing.mockResolvedValue(transfer());
    mocks.classifyBearer.mockResolvedValue(transfer({ deliveryState: "bearer-spent" }));
    mocks.registerCondition.mockResolvedValue({
      condition_id: "cond-1",
      keysets: { Yes: "ks-yes", No: "ks-no" },
    });
  });

  it("charges one-vs-rest registration fees for every generated collection", () => {
    expect(
      registrationFeeForPolicy(
        ["A", "B", "C"],
        {
          defaultKeysetCreation: "one-vs-rest",
          registrationFees: [
            { unit: "msat", registrationFeeBase: 10000, registrationFeePerKeyset: 10000 },
          ],
        },
        "msat",
      ),
    ).toBe(70000);
  });

  it("submits an exact durable registration-fee token without legacy change outputs", async () => {
    await expect(
      registerConditionWithFee({
        mintUrl: "https://mint.example.test",
        requiredFeeSubunits: 3,
        request,
      }),
    ).resolves.toMatchObject({ condition_id: "cond-1" });

    const outgoing = mocks.executeOutgoing.mock.calls[0]![0];
    expect(outgoing).toMatchObject({
      reuseTransferId: true,
      transfer: {
        mintUrl: "https://mint.example.test",
        unit: "sat",
        requestedAmount: "3",
        deliveryIntent: {
          policy: "bearer-spend-classification",
          tokenBytesLimit: 61_440,
          tokenProofLimit: 512,
        },
      },
    });
    const submitted = mocks.registerCondition.mock.calls[0]![0];
    expect(submitted).toMatchObject(request);
    expect(submitted.fee).toHaveLength(1);
    expect(submitted.fee[0].secret).toBe("exact-registration-fee-proof");
    expect(String(submitted.fee[0].amount)).toBe("3");
    expect(submitted).not.toHaveProperty("outputs");
    expect(mocks.classifyBearer).toHaveBeenCalledWith(
      expect.objectContaining({
        transfer: expect.objectContaining({ transferId: "ctf-condition-registration:test" }),
      }),
    );
  });

  it("reuses the exact durable transfer after a restart and does not select a fresh fee proof", async () => {
    const firstError = new Error("temporary registration failure");
    mocks.registerCondition.mockRejectedValueOnce(firstError).mockResolvedValueOnce({
      condition_id: "cond-1",
      keysets: { Yes: "ks-yes", No: "ks-no" },
    });

    await expect(
      registerConditionWithFee({
        mintUrl: "https://mint.example.test",
        requiredFeeSubunits: 3,
        request,
      }),
    ).rejects.toBe(firstError);
    await expect(
      registerConditionWithFee({
        mintUrl: "https://mint.example.test",
        requiredFeeSubunits: 3,
        request,
      }),
    ).resolves.toMatchObject({ condition_id: "cond-1" });

    const [first, second] = mocks.executeOutgoing.mock.calls.map(([input]) => input);
    expect(second.transfer.transferId).toBe(first.transfer.transferId);
    expect(second.transfer.requestedAmount).toBe("3");
    expect(mocks.getBoundedCanonicalRegularProofs).not.toHaveBeenCalled();
  });

  it("runs targeted preflight recovery and reloads canonical candidates for the final locked plan", async () => {
    await registerConditionWithFee({
      mintUrl: "https://mint.example.test",
      requiredFeeSubunits: 3,
      request,
    });

    const outgoing = mocks.executeOutgoing.mock.calls[0]![0];
    await outgoing.preflightFundedAsset();
    const recovery = mocks.recoverFundedAsset.mock.calls[0]![0];
    await expect(recovery.loadPlan()).resolves.toEqual({ kind: "ready" });
    expect(mocks.getBoundedCanonicalRegularProofs).toHaveBeenCalledWith(
      "https://mint.example.test",
      {
        unit: "sat",
        scopeId: "scope-1",
      },
    );

    const operation = await outgoing.prepareWalletSendOperation();
    expect(mocks.getBoundedCanonicalRegularProofs).toHaveBeenCalledTimes(2);
    expect(mocks.wallet?.prepareSwapToSend).toHaveBeenCalledWith(
      3,
      [expect.objectContaining({ secret: "registration-input-proof" })],
      expect.objectContaining({ includeFees: false, keysetId: V2_KEYSET_ID }),
      {
        send: { type: "deterministic", counter: 0 },
        keep: { type: "deterministic", counter: 0 },
      },
    );
    expect(operation.operationId).toBe(outgoing.transfer.transferId);
    expect(outgoing.keepProofDerivationLocators).toEqual([
      { schemaVersion: 1, kind: "nut13", keysetId: V2_KEYSET_ID, counter: 1 },
    ]);
  });

  it("maps targeted recovery outcomes and rejects non-V2 send keysets", async () => {
    await registerConditionWithFee({
      mintUrl: "https://mint.example.test",
      requiredFeeSubunits: 3,
      request,
    });
    const outgoing = mocks.executeOutgoing.mock.calls[0]![0];

    mocks.recoverFundedAsset.mockResolvedValueOnce({ kind: "unavailable" });
    await expect(outgoing.preflightFundedAsset()).rejects.toThrow(
      "Not enough regular sat proofs are available for the 3 sat condition registration fee.",
    );

    mocks.wallet = registrationWallet("00legacy");
    mocks.getWalletForUnit.mockResolvedValue(mocks.wallet);
    await registerConditionWithFee({
      mintUrl: "https://mint.example.test",
      requiredFeeSubunits: 3,
      request: { ...request, announcementHex: "non-v2-announcement" },
    });
    const nonV2Outgoing = mocks.executeOutgoing.mock.calls[1]![0];
    await expect(nonV2Outgoing.prepareWalletSendOperation()).rejects.toThrow(
      "Condition registration fee requires a canonical V2 keyset",
    );
  });

  it("restores persisted exact outputs in keep then send order and rejects incomplete restores", async () => {
    await registerConditionWithFee({
      mintUrl: "https://mint.example.test",
      requiredFeeSubunits: 3,
      request,
    });
    const outgoing = mocks.executeOutgoing.mock.calls[0]![0];
    const restore = {
      mintUrl: "https://mint.example.test",
      unit: "sat",
      outputs: {
        keep: [{ blindedMessage: { amount: "1", id: "keep", B_: "keep-B" } }],
        send: [{ blindedMessage: { amount: "3", id: "send", B_: "send-B" } }],
      },
    };
    mocks.restoreExactMintOutputs.mockResolvedValueOnce(["restored-keep", "restored-send"]);
    await expect(outgoing.restoreExactOutputs(restore)).resolves.toEqual({
      keep: ["restored-keep"],
      send: ["restored-send"],
    });
    expect(mocks.restoreExactMintOutputs).toHaveBeenCalledWith(expect.anything(), {
      mintUrl: "https://mint.example.test",
      unit: "sat",
      outputs: [restore.outputs.keep[0], restore.outputs.send[0]],
    });

    mocks.restoreExactMintOutputs.mockResolvedValueOnce(["only-one"]);
    await expect(outgoing.restoreExactOutputs(restore)).rejects.toThrow(
      "Condition registration fee restored output set is incomplete",
    );
  });

  it("keeps the exact durable token after an unspent registration-fee failure", async () => {
    const { MintError } = await import("@/lib/markets");
    mocks.registerCondition.mockRejectedValue(new MintError(13044, "Token already spent"));
    mocks.classifyBearer.mockResolvedValue(transfer({ deliveryState: "delivery-pending" }));

    await expect(
      registerConditionWithFee({
        mintUrl: "https://mint.example.test",
        requiredFeeSubunits: 3,
        request,
      }),
    ).rejects.toThrow("Registration fee was missing or insufficient.");

    expect(mocks.classifyBearer).toHaveBeenCalledOnce();
    expect(mocks.registerCondition).toHaveBeenCalledOnce();
  });

  it("recovers a lost successful registration response from the exact spent token", async () => {
    const { MintError } = await import("@/lib/markets");
    mocks.registerCondition
      .mockRejectedValueOnce(new MintError(13044, "Token already spent"))
      .mockResolvedValueOnce({
        condition_id: "cond-1",
        keysets: { Yes: "ks-yes", No: "ks-no" },
      });
    mocks.classifyBearer.mockResolvedValue(transfer({ deliveryState: "bearer-spent" }));

    await expect(
      registerConditionWithFee({
        mintUrl: "https://mint.example.test",
        requiredFeeSubunits: 3,
        request,
      }),
    ).resolves.toMatchObject({ condition_id: "cond-1" });

    expect(mocks.registerCondition.mock.calls).toHaveLength(2);
    expect(mocks.registerCondition.mock.calls[1]![0]).toEqual(request);
    expect(mocks.classifyBearer).toHaveBeenCalledOnce();
  });

  it("retries a persisted terminal registration without constructing a mint wallet", async () => {
    mocks.readOutgoing.mockImplementation(({ transferId }) =>
      Promise.resolve(transfer({ transferId, deliveryState: "bearer-spent" })),
    );

    await expect(
      registerConditionWithFee({
        mintUrl: "https://mint.example.test",
        requiredFeeSubunits: 3,
        request,
      }),
    ).resolves.toMatchObject({ condition_id: "cond-1" });

    expect(mocks.readOutgoing).toHaveBeenCalledOnce();
    expect(mocks.getWalletForUnit).not.toHaveBeenCalled();
    expect(mocks.executeOutgoing).not.toHaveBeenCalled();
    expect(mocks.registerCondition).toHaveBeenCalledWith(request);
  });

  it("passes the durable coordinator callbacks without a parallel registration-fee state machine", async () => {
    await registerConditionWithFee({
      mintUrl: "https://mint.example.test",
      requiredFeeSubunits: 3,
      request,
    });

    const outgoing = mocks.executeOutgoing.mock.calls[0]![0];
    expect(outgoing.preflightFundedAsset).toEqual(expect.any(Function));
    expect(outgoing.prepareWalletSendOperation).toEqual(expect.any(Function));
    expect(outgoing.keepProofDerivationLocators).toEqual([]);
    expect(mocks.executeOutgoing).toHaveBeenCalledOnce();
  });
});
