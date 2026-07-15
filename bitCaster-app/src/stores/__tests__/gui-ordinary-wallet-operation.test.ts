import { Amount, OutputData, type Proof } from "@cashu/cashu-ts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  walletId: "a".repeat(64),
  record: null as null | Record<string, unknown>,
  trace: [] as string[],
  rejectCompletion: false,
  switchSeedAfterPersistPlan: false,
  switchSeedAfterPersistSubmission: false,
  switchSeedAfterPersistResult: false,
  walletBootstrapError: null as Error | null,
  persistPlanError: null as Error | null,
  headroomReady: true,
  recoveryWake: vi.fn(),
  wallet: {} as Record<string, unknown>,
}));

vi.mock("@/lib/cashu", () => ({
  getWalletForUnit: vi.fn(async () => {
    if (state.walletBootstrapError) throw state.walletBootstrapError;
    return state.wallet;
  }),
}));

vi.mock("../gui-native-proof-operation-recovery", () => ({
  requestGuiNativeProofOperationRecovery: state.recoveryWake,
}));

vi.mock("../gui-durable-storage-headroom-custody-unit-of-work", () => {
  class TestHeadroomUnavailable extends Error {}
  return {
    GuiDurableStorageHeadroomUnavailable: TestHeadroomUnavailable,
    requireGuiNewEffectHeadroomForWallet: vi.fn(async () => {
      state.trace.push("require-headroom");
      if (!state.headroomReady) {
        throw new TestHeadroomUnavailable(
          "GUI durable storage emergency headroom is unavailable",
        );
      }
    }),
  };
});

vi.mock("@/lib/conditionalKeysetMetadata", () => ({
  proofsWithOptionalConditionalMetadata: vi.fn(
    async ({ proofs }: { proofs: Proof[] }) => proofs,
  ),
}));

vi.mock("../proof-db", () => ({
  currentGuiWalletId: () => state.walletId,
  getProofOperationForWallet: vi.fn(async () =>
    state.record ? structuredClone(state.record) : null,
  ),
}));

vi.mock("../gui-wallet-proof-operation-custody", () => ({
  abortPreparedGuiWalletMintForWallet: vi.fn(async () => {
    state.trace.push("persist-abort");
    if (!state.record || state.record.state !== "prepared") {
      throw new Error("mint is not prepared");
    }
    state.record.state = "Failed";
    state.record.lastError = "Lightning mint quote expired before transport";
    state.record.failureCode = 408;
    state.record.updatedAt = Date.now();
    return structuredClone(state.record);
  }),
  prepareProofOperationForWallet: vi.fn(
    async (walletId: string, input: Record<string, unknown>) => {
      state.trace.push("persist-plan");
      if (state.persistPlanError) throw state.persistPlanError;
      if (!state.record) {
        const now = Date.now();
        state.record = {
          ...structuredClone(input),
          walletId,
          state: "prepared",
          lastError: null,
          custodyOperationId: `custody:${String(input.operationId)}`,
          createdAt: now,
          updatedAt: now,
        };
      }
      if (state.switchSeedAfterPersistPlan) {
        state.switchSeedAfterPersistPlan = false;
        state.walletId = "b".repeat(64);
      }
      return structuredClone(state.record);
    },
  ),
  claimPreparedProofOperationMintSubmissionForWallet: vi.fn(async () => {
    state.trace.push("persist-submit");
    if (!state.record) throw new Error("missing operation");
    if (state.record.state === "prepared") {
      state.record.state = "mint-submitted";
      state.record.updatedAt = Date.now();
      if (state.switchSeedAfterPersistSubmission) {
        state.switchSeedAfterPersistSubmission = false;
        state.walletId = "b".repeat(64);
      }
      return { record: structuredClone(state.record), claimed: true };
    }
    if (state.record.state === "mint-submitted") {
      return { record: structuredClone(state.record), claimed: false };
    }
    throw new Error("terminal proof operation");
  }),
  markProofOperationCompletedForWallet: vi.fn(
    async (_walletId: string, _operationId: string, resultProofs: unknown) => {
      state.trace.push("persist-result");
      if (state.rejectCompletion) {
        state.rejectCompletion = false;
        throw new Error("crash before result commit");
      }
      if (!state.record) throw new Error("missing operation");
      state.record.state = "completed";
      state.record.resultProofs = structuredClone(resultProofs);
      state.record.updatedAt = Date.now();
      if (state.switchSeedAfterPersistResult) {
        state.switchSeedAfterPersistResult = false;
        state.walletId = "b".repeat(64);
      }
      return structuredClone(state.record);
    },
  ),
  requireCompletedGuiWalletProofOperationAuthorityForWallet: vi.fn(async () => {
    if (!state.record || state.record.state !== "completed") {
      throw new Error("GUI wallet operation is not completed");
    }
    return structuredClone(state.record);
  }),
}));

import {
  completeGuiLightningMint,
  prepareGuiLightningMint,
  receiveGuiCashuToken,
  recoverGuiOrdinaryWalletOperation,
} from "../gui-ordinary-wallet-operation";
import { GuiCustodyMintKeysUnavailable } from "../gui-custody-authority";
import { durableStageForGuiProofOperation } from "../gui-swap-session-record";

const MINT_URL = "https://mint.example";
const KEYSET_ID = `00${"22".repeat(7)}`;
const QUOTE = {
  quote: "quote-1",
  request: "lnbc1invoice",
  amount: Amount.from(3),
  unit: "sat",
  state: "UNPAID" as const,
  expiry: null,
};

describe("GUI ordinary wallet coordinator", () => {
  beforeEach(() => {
    state.walletId = "a".repeat(64);
    state.record = null;
    state.trace = [];
    state.rejectCompletion = false;
    state.switchSeedAfterPersistPlan = false;
    state.switchSeedAfterPersistSubmission = false;
    state.switchSeedAfterPersistResult = false;
    state.walletBootstrapError = null;
    state.persistPlanError = null;
    state.headroomReady = true;
    state.recoveryWake.mockReset().mockResolvedValue("pending");
    state.wallet = walletFixture();
  });

  it("persists the exact mint plan before exposing it for dispatch", async () => {
    const plan = await prepareGuiLightningMint({
      amount: 3,
      quote: QUOTE,
      mintUrl: MINT_URL,
      unit: "sat",
    });

    expect(plan.operationId.length).toBeLessThanOrEqual(512);
    expect(state.trace).toEqual(["prepare-mint", "persist-plan"]);
    expect(walletMethod("completeMint")).not.toHaveBeenCalled();
    expect(state.record?.metadata).toMatchObject({
      guiDepositActivityProjection: {
        schemaVersion: 1,
        lightningInvoice: QUOTE.request,
      },
    });
  });

  it("reconciles exact NUT-09 outputs instead of blindly redispatching after response-before-commit", async () => {
    const plan = await prepareGuiLightningMint({
      amount: 3,
      quote: QUOTE,
      mintUrl: MINT_URL,
      unit: "sat",
    });
    state.rejectCompletion = true;

    await expect(completeGuiLightningMint(plan)).rejects.toThrow(
      "crash before result commit",
    );
    expect(state.record?.state).toBe("mint-submitted");
    walletMethod("checkMintQuote").mockResolvedValue({
      ...QUOTE,
      state: "ISSUED",
    });
    installExactMintRestore();
    const toProof = vi
      .spyOn(OutputData.prototype, "toProof")
      .mockImplementation(function (this: OutputData) {
        return proofForOutput(this);
      });

    const recovered = await completeGuiLightningMint(plan);

    expect(walletMethod("completeMint")).toHaveBeenCalledOnce();
    expect(walletMethod("restore")).toHaveBeenCalledOnce();
    expect(recovered[0]?.secret).toBe(
      proofForOutput(mintPreview().outputData[0]!).secret,
    );
    expect(state.record?.state).toBe("completed");
    toProof.mockRestore();
  });

  it("uses one initial claim and only classifier-gated exact reissues across concurrent tabs", async () => {
    const plan = await prepareGuiLightningMint({
      amount: 3,
      quote: QUOTE,
      mintUrl: MINT_URL,
      unit: "sat",
    });
    const firstResponse = deferred<Proof[]>();
    walletMethod("completeMint")
      .mockImplementationOnce(() => firstResponse.promise)
      .mockRejectedValueOnce(new Error("duplicate response unknown"));

    const first = completeGuiLightningMint(plan);
    await vi.waitFor(() =>
      expect(walletMethod("completeMint")).toHaveBeenCalledOnce(),
    );
    walletMethod("checkMintQuote").mockResolvedValue({
      ...QUOTE,
      state: "PAID",
    });

    await expect(completeGuiLightningMint(plan)).rejects.toThrow(
      "duplicate response unknown",
    );
    expect(walletMethod("completeMint")).toHaveBeenCalledTimes(2);
    const firstOutput =
      walletMethod("completeMint").mock.calls[0]![0].outputData[0];
    const secondOutput =
      walletMethod("completeMint").mock.calls[1]![0].outputData[0];
    expect(secondOutput.blindedMessage.B_).toBe(firstOutput.blindedMessage.B_);
    expect(Array.from(secondOutput.secret)).toEqual(
      Array.from(firstOutput.secret),
    );
    expect(
      state.trace.filter((entry) => entry === "persist-submit"),
    ).toHaveLength(1);

    firstResponse.reject(new Error("initial response unknown"));
    await expect(first).rejects.toThrow("initial response unknown");
    walletMethod("checkMintQuote").mockResolvedValue({
      ...QUOTE,
      state: "ISSUED",
    });
    installExactMintRestore();
    const toProof = vi
      .spyOn(OutputData.prototype, "toProof")
      .mockImplementation(function (this: OutputData) {
        return proofForOutput(this);
      });

    await expect(completeGuiLightningMint(plan)).resolves.toHaveLength(1);
    expect(walletMethod("completeMint")).toHaveBeenCalledTimes(2);
    expect(state.record?.state).toBe("completed");
    toProof.mockRestore();
  });

  it("deduplicates reordered token proofs across ingress wrappers", async () => {
    const left = incomingProof(2, "11");
    const right = incomingProof(3, "22");
    const first = await receiveGuiCashuToken({
      expectedWalletId: state.walletId,
      token: { mint: MINT_URL, unit: "sat", proofs: [left, right] },
      mintUrl: MINT_URL,
      unit: "sat",
    });
    const operationId = String(state.record?.operationId);
    const second = await receiveGuiCashuToken({
      expectedWalletId: state.walletId,
      token: { mint: MINT_URL, unit: "sat", proofs: [right, left] },
      mintUrl: MINT_URL,
      unit: "sat",
    });

    expect(walletMethod("prepareSwapToReceive")).toHaveBeenCalledOnce();
    expect(walletMethod("completeSwap")).toHaveBeenCalledOnce();
    expect(String(state.record?.operationId)).toBe(operationId);
    expect(first[0]?.secret).toBe(second[0]?.secret);
  });

  it("rejects an explicitly captured old wallet before token preparation", async () => {
    const expectedWalletId = state.walletId;
    state.walletId = "b".repeat(64);

    await expect(
      receiveGuiCashuToken({
        expectedWalletId,
        token: {
          mint: MINT_URL,
          unit: "sat",
          proofs: [incomingProof(2, "23")],
        },
        mintUrl: MINT_URL,
        unit: "sat",
      }),
    ).rejects.toThrow("Active wallet seed changed");

    expect(walletMethod("prepareSwapToReceive")).not.toHaveBeenCalled();
    expect(state.record).toBeNull();
  });

  it("fails before persistence when the active seed changes during preparation", async () => {
    walletMethod("prepareMint").mockImplementationOnce(async () => {
      state.walletId = "b".repeat(64);
      return mintPreview();
    });

    await expect(
      prepareGuiLightningMint({
        amount: 3,
        quote: QUOTE,
        mintUrl: MINT_URL,
        unit: "sat",
      }),
    ).rejects.toThrow("Active wallet seed changed");
    expect(state.record).toBeNull();
  });

  it("fences a seed change immediately after persisting the exact plan", async () => {
    state.switchSeedAfterPersistPlan = true;

    await expect(
      prepareGuiLightningMint({
        amount: 3,
        quote: QUOTE,
        mintUrl: MINT_URL,
        unit: "sat",
      }),
    ).rejects.toThrow("Active wallet seed changed");

    expect(state.record?.state).toBe("prepared");
    expect(walletMethod("completeMint")).not.toHaveBeenCalled();
  });

  it("fences a seed change immediately after committing the exact result", async () => {
    const plan = await prepareGuiLightningMint({
      amount: 3,
      quote: QUOTE,
      mintUrl: MINT_URL,
      unit: "sat",
    });
    state.switchSeedAfterPersistResult = true;

    await expect(completeGuiLightningMint(plan)).rejects.toThrow(
      "Active wallet seed changed",
    );

    expect(state.record?.state).toBe("completed");
    expect(walletMethod("completeMint")).toHaveBeenCalledOnce();
  });

  it("fences a seed change immediately after committing mint submission", async () => {
    const plan = await prepareGuiLightningMint({
      amount: 3,
      quote: QUOTE,
      mintUrl: MINT_URL,
      unit: "sat",
    });
    state.switchSeedAfterPersistSubmission = true;

    await expect(completeGuiLightningMint(plan)).rejects.toThrow(
      "Active wallet seed changed",
    );

    expect(state.record?.state).toBe("mint-submitted");
    expect(walletMethod("completeMint")).not.toHaveBeenCalled();
  });

  it.each([
    ["empty quote id", { quote: "" }],
    ["foreign unit", { unit: "msat" }],
    ["foreign amount", { amount: Amount.from(4) }],
  ])(
    "rejects an initial mint quote with %s before persistence",
    async (_label, override) => {
      await expect(
        prepareGuiLightningMint({
          amount: 3,
          quote: { ...QUOTE, ...override },
          mintUrl: MINT_URL,
          unit: "sat",
        }),
      ).rejects.toThrow("foreign quote authority");

      expect(state.record).toBeNull();
      expect(walletMethod("prepareMint")).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["quote id", { quote: "foreign-quote" }],
    ["unit", { unit: "msat" }],
    ["amount", { amount: Amount.from(4) }],
  ])(
    "rejects a recovery response with a foreign %s",
    async (_label, override) => {
      const plan = await prepareGuiLightningMint({
        amount: 3,
        quote: QUOTE,
        mintUrl: MINT_URL,
        unit: "sat",
      });
      walletMethod("completeMint").mockRejectedValueOnce(
        new Error("response lost"),
      );
      await expect(completeGuiLightningMint(plan)).rejects.toThrow(
        "response lost",
      );
      walletMethod("checkMintQuote").mockResolvedValue({
        ...QUOTE,
        state: "ISSUED",
        ...override,
      });

      await expect(completeGuiLightningMint(plan)).rejects.toThrow(
        "foreign quote authority",
      );

      expect(walletMethod("restore")).not.toHaveBeenCalled();
      expect(state.record?.state).toBe("mint-submitted");
    },
  );

  it("uses NUT-07 to replay the exact persisted receive operation", async () => {
    const token = {
      mint: MINT_URL,
      unit: "sat",
      proofs: [incomingProof(5, "31")],
    };
    walletMethod("completeSwap").mockRejectedValueOnce(
      new Error("response unknown"),
    );
    await expect(
      receiveGuiCashuToken({
        expectedWalletId: state.walletId,
        token,
        mintUrl: MINT_URL,
        unit: "sat",
      }),
    ).rejects.toThrow("response unknown");
    walletMethod("checkProofsStates").mockResolvedValue([
      { Y: "ignored", state: "UNSPENT", witness: null },
    ]);

    await recoverGuiOrdinaryWalletOperation(state.record as never);

    expect(walletMethod("prepareSwapToReceive")).toHaveBeenCalledOnce();
    expect(walletMethod("completeSwap")).toHaveBeenCalledTimes(2);
    const first = walletMethod("completeSwap").mock.calls[0]![0];
    const second = walletMethod("completeSwap").mock.calls[1]![0];
    expect(first.keepOutputs[0].blindedMessage.B_).toBe(
      second.keepOutputs[0].blindedMessage.B_,
    );
    expect(state.record?.state).toBe("completed");
  });

  it("wakes persisted recovery after the initial exact mint response is lost", async () => {
    const plan = await prepareGuiLightningMint({
      amount: 3,
      quote: QUOTE,
      mintUrl: MINT_URL,
      unit: "sat",
    });
    walletMethod("completeMint").mockRejectedValueOnce(
      new Error("initial mint response lost"),
    );

    await expect(completeGuiLightningMint(plan)).rejects.toThrow(
      "initial mint response lost",
    );
    await vi.waitFor(() => expect(state.recoveryWake).toHaveBeenCalledOnce());

    expect(state.record?.state).toBe("mint-submitted");
  });

  it("wakes persisted recovery after the initial exact receive response is lost", async () => {
    walletMethod("completeSwap").mockRejectedValueOnce(
      new Error("initial receive response lost"),
    );

    await expect(
      receiveGuiCashuToken({
        expectedWalletId: state.walletId,
        token: {
          mint: MINT_URL,
          unit: "sat",
          proofs: [incomingProof(5, "34")],
        },
        mintUrl: MINT_URL,
        unit: "sat",
      }),
    ).rejects.toThrow("initial receive response lost");
    await vi.waitFor(() => expect(state.recoveryWake).toHaveBeenCalledOnce());

    expect(state.record?.state).toBe("mint-submitted");
  });

  it("classifies persisted wallet bootstrap rejection for bounded retry", async () => {
    await prepareGuiLightningMint({
      amount: 3,
      quote: QUOTE,
      mintUrl: MINT_URL,
      unit: "sat",
    });
    state.walletBootstrapError = new Error("temporary loadMint failure");

    await expect(
      recoverGuiOrdinaryWalletOperation(state.record as never),
    ).resolves.toEqual({
      kind: "retry-later",
      reason: "mint-response-unknown",
    });

    expect(walletMethod("checkMintQuote")).not.toHaveBeenCalled();
    expect(state.record?.state).toBe("prepared");
  });

  it("classifies persisted mint-key loading rejection for bounded retry", async () => {
    await prepareGuiLightningMint({
      amount: 3,
      quote: QUOTE,
      mintUrl: MINT_URL,
      unit: "sat",
    });
    state.persistPlanError = new GuiCustodyMintKeysUnavailable(
      "temporary loadMint failure",
    );

    await expect(
      recoverGuiOrdinaryWalletOperation(state.record as never),
    ).resolves.toEqual({
      kind: "retry-later",
      reason: "mint-response-unknown",
    });

    expect(walletMethod("checkMintQuote")).not.toHaveBeenCalled();
    expect(state.record?.state).toBe("prepared");
  });

  it("classifies exact startup reissue response loss for timer retry", async () => {
    const plan = await prepareGuiLightningMint({
      amount: 3,
      quote: QUOTE,
      mintUrl: MINT_URL,
      unit: "sat",
    });
    walletMethod("completeMint").mockRejectedValueOnce(
      new Error("initial response lost"),
    );
    await expect(completeGuiLightningMint(plan)).rejects.toThrow(
      "initial response lost",
    );
    walletMethod("checkMintQuote").mockResolvedValue({
      ...QUOTE,
      state: "PAID",
    });
    walletMethod("completeMint").mockRejectedValueOnce(
      new Error("reissue response lost"),
    );

    await expect(
      recoverGuiOrdinaryWalletOperation(state.record as never),
    ).resolves.toEqual({
      kind: "retry-later",
      reason: "mint-response-unknown",
    });

    expect(walletMethod("completeMint")).toHaveBeenCalledTimes(2);
    const initial = walletMethod("completeMint").mock.calls[0]![0];
    const reissue = walletMethod("completeMint").mock.calls[1]![0];
    expect(reissue.outputData[0].blindedMessage.B_).toBe(
      initial.outputData[0].blindedMessage.B_,
    );
    expect(Array.from(reissue.outputData[0].secret)).toEqual(
      Array.from(initial.outputData[0].secret),
    );
    expect(state.record?.state).toBe("mint-submitted");
  });

  it("defers an exact recovery reissue before mint transport when headroom is unavailable", async () => {
    const plan = await prepareGuiLightningMint({
      amount: 3,
      quote: QUOTE,
      mintUrl: MINT_URL,
      unit: "sat",
    });
    walletMethod("completeMint").mockRejectedValueOnce(
      new Error("initial response lost"),
    );
    await expect(completeGuiLightningMint(plan)).rejects.toThrow(
      "initial response lost",
    );
    walletMethod("checkMintQuote").mockResolvedValue({
      ...QUOTE,
      state: "PAID",
    });
    state.headroomReady = false;

    await expect(completeGuiLightningMint(plan)).rejects.toThrow(
      "emergency headroom is unavailable",
    );
    expect(walletMethod("completeMint")).toHaveBeenCalledOnce();

    await expect(
      recoverGuiOrdinaryWalletOperation(state.record as never),
    ).resolves.toEqual({
      kind: "retry-later",
      reason: "storage-unavailable",
    });

    expect(walletMethod("completeMint")).toHaveBeenCalledOnce();
    expect(state.record?.state).toBe("mint-submitted");
  });

  it("classifies an unpaid persisted Lightning mint for bounded retry", async () => {
    await prepareGuiLightningMint({
      amount: 3,
      quote: QUOTE,
      mintUrl: MINT_URL,
      unit: "sat",
    });
    walletMethod("checkMintQuote").mockResolvedValue({ ...QUOTE });

    await expect(
      recoverGuiOrdinaryWalletOperation(state.record as never),
    ).resolves.toEqual({
      kind: "retry-later",
      reason: "pending-or-mixed",
    });

    expect(walletMethod("completeMint")).not.toHaveBeenCalled();
    expect(state.record?.state).toBe("prepared");
  });

  it("atomically retires an exact expired unpaid mint before transport", async () => {
    const expiry = Math.floor(Date.now() / 1_000) - 1;
    const quote = { ...QUOTE, expiry };
    await prepareGuiLightningMint({
      amount: 3,
      quote,
      mintUrl: MINT_URL,
      unit: "sat",
    });
    walletMethod("checkMintQuote").mockResolvedValue({ ...quote });

    await expect(
      recoverGuiOrdinaryWalletOperation(state.record as never),
    ).resolves.toEqual({ kind: "settled" });

    expect(state.trace).toContain("persist-abort");
    expect(walletMethod("completeMint")).not.toHaveBeenCalled();
    expect(state.record?.state).toBe("Failed");
  });

  it("retries a transient mint quote evidence failure", async () => {
    await prepareGuiLightningMint({
      amount: 3,
      quote: QUOTE,
      mintUrl: MINT_URL,
      unit: "sat",
    });
    walletMethod("checkMintQuote").mockRejectedValue(
      new Error("temporary quote transport failure"),
    );

    await expect(
      recoverGuiOrdinaryWalletOperation(state.record as never),
    ).resolves.toEqual({
      kind: "retry-later",
      reason: "mint-response-unknown",
    });

    expect(state.record?.state).toBe("prepared");
  });

  it("classifies pending receive inputs for bounded retry", async () => {
    const token = {
      mint: MINT_URL,
      unit: "sat",
      proofs: [incomingProof(5, "32")],
    };
    walletMethod("completeSwap").mockRejectedValueOnce(
      new Error("response unknown"),
    );
    await expect(
      receiveGuiCashuToken({
        expectedWalletId: state.walletId,
        token,
        mintUrl: MINT_URL,
        unit: "sat",
      }),
    ).rejects.toThrow("response unknown");
    walletMethod("checkProofsStates").mockResolvedValue([
      { Y: "ignored", state: "PENDING", witness: null },
    ]);

    await expect(
      recoverGuiOrdinaryWalletOperation(state.record as never),
    ).resolves.toEqual({
      kind: "retry-later",
      reason: "pending-or-mixed",
    });

    expect(walletMethod("completeSwap")).toHaveBeenCalledOnce();
    expect(state.record?.state).toBe("mint-submitted");
  });

  it("retries a transient NUT-07 evidence failure", async () => {
    const token = {
      mint: MINT_URL,
      unit: "sat",
      proofs: [incomingProof(5, "42")],
    };
    walletMethod("completeSwap").mockRejectedValueOnce(
      new Error("response unknown"),
    );
    await expect(
      receiveGuiCashuToken({
        expectedWalletId: state.walletId,
        token,
        mintUrl: MINT_URL,
        unit: "sat",
      }),
    ).rejects.toThrow("response unknown");
    walletMethod("checkProofsStates").mockRejectedValue(
      new Error("temporary NUT-07 transport failure"),
    );

    await expect(
      recoverGuiOrdinaryWalletOperation(state.record as never),
    ).resolves.toEqual({
      kind: "retry-later",
      reason: "mint-response-unknown",
    });
  });

  it("blocks a malformed partial NUT-07 response instead of retrying it", async () => {
    const token = {
      mint: MINT_URL,
      unit: "sat",
      proofs: [incomingProof(5, "43")],
    };
    walletMethod("completeSwap").mockRejectedValueOnce(
      new Error("response unknown"),
    );
    await expect(
      receiveGuiCashuToken({
        expectedWalletId: state.walletId,
        token,
        mintUrl: MINT_URL,
        unit: "sat",
      }),
    ).rejects.toThrow("response unknown");
    walletMethod("checkProofsStates").mockResolvedValue([]);

    await expect(
      recoverGuiOrdinaryWalletOperation(state.record as never),
    ).rejects.toThrow("partial NUT-07 result");
  });

  it("restores an issued mint from only the exact persisted NUT-09 outputs", async () => {
    const plan = await prepareGuiLightningMint({
      amount: 3,
      quote: QUOTE,
      mintUrl: MINT_URL,
      unit: "sat",
    });
    walletMethod("completeMint").mockRejectedValueOnce(
      new Error("response lost"),
    );
    await expect(completeGuiLightningMint(plan)).rejects.toThrow(
      "response lost",
    );
    walletMethod("checkMintQuote").mockResolvedValue({
      ...QUOTE,
      state: "ISSUED",
    });
    installExactMintRestore();
    const toProof = vi
      .spyOn(OutputData.prototype, "toProof")
      .mockImplementation(function (this: OutputData) {
        return proofForOutput(this);
      });

    await recoverGuiOrdinaryWalletOperation(state.record as never);

    expect(walletMethod("restore")).toHaveBeenCalledOnce();
    expect(toProof).toHaveBeenCalledOnce();
    expect(state.record?.state).toBe("completed");
    toProof.mockRestore();
  });

  it("retries a transient NUT-09 evidence failure", async () => {
    const plan = await prepareGuiLightningMint({
      amount: 3,
      quote: QUOTE,
      mintUrl: MINT_URL,
      unit: "sat",
    });
    walletMethod("completeMint").mockRejectedValueOnce(new Error("lost"));
    await expect(completeGuiLightningMint(plan)).rejects.toThrow("lost");
    walletMethod("checkMintQuote").mockResolvedValue({
      ...QUOTE,
      state: "ISSUED",
    });
    walletMethod("restore").mockRejectedValue(
      new Error("temporary NUT-09 transport failure"),
    );

    await expect(
      recoverGuiOrdinaryWalletOperation(state.record as never),
    ).resolves.toEqual({
      kind: "retry-later",
      reason: "mint-response-unknown",
    });
  });

  it("rejects a foreign NUT-09 output without committing it", async () => {
    const plan = await prepareGuiLightningMint({
      amount: 3,
      quote: QUOTE,
      mintUrl: MINT_URL,
      unit: "sat",
    });
    walletMethod("completeMint").mockRejectedValueOnce(new Error("lost"));
    await expect(completeGuiLightningMint(plan)).rejects.toThrow("lost");
    walletMethod("checkMintQuote").mockResolvedValue({
      ...QUOTE,
      state: "ISSUED",
    });
    walletMethod("restore").mockResolvedValue({
      outputs: [
        { id: KEYSET_ID, amount: Amount.from(3), B_: `02${"77".repeat(32)}` },
      ],
      signatures: [
        { id: KEYSET_ID, amount: Amount.from(3), C_: `02${"66".repeat(32)}` },
      ],
    });

    await expect(
      recoverGuiOrdinaryWalletOperation(state.record as never),
    ).rejects.toThrow("foreign NUT-09 output");
    expect(state.record?.state).toBe("mint-submitted");
  });

  it("never commits a partial NUT-09 restore", async () => {
    const plan = await prepareGuiLightningMint({
      amount: 3,
      quote: QUOTE,
      mintUrl: MINT_URL,
      unit: "sat",
    });
    walletMethod("completeMint").mockRejectedValueOnce(new Error("lost"));
    await expect(completeGuiLightningMint(plan)).rejects.toThrow("lost");
    walletMethod("checkMintQuote").mockResolvedValue({
      ...QUOTE,
      state: "ISSUED",
    });
    walletMethod("restore").mockResolvedValue({ outputs: [], signatures: [] });

    await recoverGuiOrdinaryWalletOperation(state.record as never);

    expect(state.record?.state).toBe("mint-submitted");
    expect(
      state.trace.filter((entry) => entry === "persist-result"),
    ).toHaveLength(0);
  });

  it("keeps ordinary wallet kinds out of trade-session stages", () => {
    expect(() => durableStageForGuiProofOperation("wallet-mint")).toThrow(
      "cannot bind to a trade stage",
    );
    expect(() => durableStageForGuiProofOperation("wallet-receive")).toThrow(
      "cannot bind to a trade stage",
    );
  });
});

function walletFixture(): Record<string, unknown> {
  const minted = proofForOutput(mintPreview().outputData[0]!);
  return {
    prepareMint: vi.fn(async () => {
      state.trace.push("prepare-mint");
      return mintPreview();
    }),
    completeMint: vi.fn(async () => {
      state.trace.push("dispatch-mint");
      return [minted];
    }),
    prepareSwapToReceive: vi.fn(async (token: { proofs: Proof[] }) => ({
      amount: Amount.from(4),
      fees: Amount.from(1),
      keysetId: KEYSET_ID,
      inputs: token.proofs,
      keepOutputs: [output(4, 0x44)],
    })),
    completeSwap: vi.fn(async (preview: { keepOutputs: OutputData[] }) => ({
      keep: [proofForOutput(preview.keepOutputs[0]!)],
      send: [],
    })),
    checkMintQuote: vi.fn(async () => ({ ...QUOTE, state: "PAID" as const })),
    checkProofsStates: vi.fn(),
    keyChain: { ensureKeysetKeys: vi.fn(async () => undefined) },
    mint: { restore: vi.fn() },
    getKeyset: vi.fn(() => ({ id: KEYSET_ID, unit: "sat", keys: {} })),
  };
}

function walletMethod(name: string) {
  if (name === "restore") {
    return (state.wallet.mint as { restore: ReturnType<typeof vi.fn> }).restore;
  }
  return state.wallet[name] as ReturnType<typeof vi.fn>;
}

function installExactMintRestore(): void {
  walletMethod("restore").mockImplementation(async ({ outputs }) => ({
    outputs,
    signatures: outputs.map((output: { id: string; amount: Amount }) => ({
      id: output.id,
      amount: output.amount,
      C_: `02${"66".repeat(32)}`,
    })),
  }));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function mintPreview() {
  const outputData = [output(3)];
  return {
    method: "bolt11",
    payload: {
      quote: QUOTE.quote,
      outputs: outputData.map(({ blindedMessage }) => blindedMessage),
    },
    outputData,
    keysetId: KEYSET_ID,
    quote: QUOTE,
  };
}

function output(amount: number, secretByte = 0x33): OutputData {
  return new OutputData(
    {
      id: KEYSET_ID,
      amount: Amount.from(amount),
      B_: `02${secretByte.toString(16).padStart(2, "0").repeat(32)}`,
    },
    2n,
    new Uint8Array(32).fill(secretByte),
  );
}

function proofForOutput(outputData: OutputData): Proof {
  return {
    id: outputData.blindedMessage.id,
    amount: outputData.blindedMessage.amount,
    secret: new TextDecoder().decode(outputData.secret),
    C: `02${"55".repeat(32)}`,
  };
}

function incomingProof(amount: number, byte: string): Proof {
  return {
    id: KEYSET_ID,
    amount: Amount.from(amount),
    secret: byte.repeat(32),
    C: `02${"55".repeat(32)}`,
  };
}
