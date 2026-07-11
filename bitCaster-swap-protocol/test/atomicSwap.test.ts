import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Amount,
  CheckStateEnum,
  Mint as CashuMint,
  Wallet as CashuWallet,
  type ConditionalSwapPreview,
  type Proof,
  type ProofState,
} from "@cashu/cashu-ts";
import {
  assertConditionalSwapOutputsPinned,
  conditionalKeysetSwap,
  inspectExactPreparedProofOperation,
  resumeExactPreparedProofOperation,
  type PrepareProofOperationInput,
  type ProofOperationRecord,
  type ProofOperationStore,
  type SwapContext,
} from "../src/atomicSwap.ts";
import { adapt, generateAdaptorPoint, preSign } from "../src/adaptor.ts";
import { generateEphemeralKeypair } from "../src/ecdh.ts";

// The "leg-2 failure must not publish locked-proofs-seller" invariant is
// tested at the orchestration layer in
// bitCaster/bitcaster-daemon/test/swapExecutor.test.ts ::
// Block2_SellerLock_Leg2Failure_DoesNotPublishLockedProofsSeller. The
// protocol-layer `sellerPreparePrelockedSwap` function returns the cipher;
// whether and when it is sent to the hub is owned by the daemon.

test("Block2_MultiLegSwap_PerLegNonceR_AreDistinct", () => {
  const signer = generateEphemeralKeypair();
  const adaptorA = generateAdaptorPoint();
  const adaptorB = generateAdaptorPoint();
  const finalSigA = adapt(
    preSign(signer.privateKey, new Uint8Array(32).fill(1), adaptorA.point),
    adaptorA.secret,
  );
  const finalSigB = adapt(
    preSign(signer.privateKey, new Uint8Array(32).fill(2), adaptorB.point),
    adaptorB.secret,
  );

  assert.notEqual(
    Buffer.from(finalSigA.slice(0, 32)).toString("hex"),
    Buffer.from(finalSigB.slice(0, 32)).toString("hex"),
  );
});

test("Block2_MultiLegSwap_LocktimeIdenticalAcrossLegs", () => {
  const ctx = swapContext("trade-locktime-identical");
  const proofA = lockedProof(ctx, "keyset-A", 100);
  const proofB = lockedProof(ctx, "keyset-B", 100);

  assert.equal(extractLocktime(proofA), ctx.sellerLocktime);
  assert.equal(extractLocktime(proofB), ctx.sellerLocktime);
});

test("conditional swap previews fail before mint when outputs change keyset", () => {
  const conditionalKeysetId = "conditional-keyset-13017";
  const regularFallbackKeysetId = "regular-fallback-13041";
  const preview: ConditionalSwapPreview = {
    keysetId: conditionalKeysetId,
    inputs: [
      lockedProof(
        swapContext("trade-output-keyset"),
        conditionalKeysetId,
        100,
      ),
    ],
    outputDataByLabel: {
      lock: [outputData(regularFallbackKeysetId, 100)],
    },
  };

  assert.equal(preview.keysetId, conditionalKeysetId);
  assert.notEqual(preview.keysetId, regularFallbackKeysetId);
  assert.deepEqual(
    Object.entries(preview.outputDataByLabel).map(([label, outputs]) => ({
      label,
      count: outputs.length,
    })),
    [{ label: "lock", count: 1 }],
  );
  assert.throws(
    () => assertConditionalSwapOutputsPinned(preview),
    /output lock uses keyset regular-fallback-13041; expected conditional-keyset-13017/,
  );
});

test("conditional keyset swap stays resumable when completion aborts before signed outputs", async () => {
  const operationId = "conditional-op-abort-before-sign";
  const keysetId = "conditional-keyset-resume";
  const input = proof(keysetId, 100, "conditional-input");
  const store = new MemoryProofOperationStore();
  let completionCalls = 0;
  const originalPrepare = CashuWallet.prototype.prepareConditionalSwap;
  const originalComplete = CashuWallet.prototype.completeConditionalSwap;
  const originalCheckProofsStates = CashuWallet.prototype.checkProofsStates;
  const originalGetKeys = CashuMint.prototype.getKeys;

  CashuMint.prototype.getKeys = async (id?: string) =>
    ({
      keysets: [
        {
          id: id ?? keysetId,
          unit: "sat",
          active: true,
          input_fee_ppk: 0,
          keys: { 1: "02".padEnd(66, "1") },
        },
      ],
    }) as never;
  CashuWallet.prototype.prepareConditionalSwap = async () =>
    ({
      keysetId,
      inputs: [input],
      outputDataByLabel: {
        lock: [outputData(keysetId, 100)],
      },
    }) as ConditionalSwapPreview;
  CashuWallet.prototype.completeConditionalSwap = async () => {
    completionCalls += 1;
    if (completionCalls === 1) {
      throw new Error("abort after inputs accepted before output signatures");
    }
    return {
      lock: [proof(keysetId, 100, "signed-output")],
    };
  };
  CashuWallet.prototype.checkProofsStates = async (): Promise<ProofState[]> => [
    { Y: "input-y", state: CheckStateEnum.UNSPENT, witness: null },
  ];

  try {
    await assert.rejects(
      () =>
        conditionalKeysetSwap(
          "https://mint.example",
          [input],
          [{ label: "lock", kind: "random", amount: 100 }],
          { operationId, proofOperationStore: store },
        ),
      /abort after inputs accepted before output signatures/,
    );

    const prepared = await store.getProofOperation(operationId);
    assert.equal(prepared?.state, "mint-submitted");
    assert.equal(prepared?.resultProofs, undefined);
    assert.equal(prepared?.metadata.unit, "sat");

    const resumed = await conditionalKeysetSwap(
      "https://mint.example",
      [input],
      [{ label: "lock", kind: "random", amount: 100 }],
      { operationId, proofOperationStore: store },
    );

    const expectedSignedOutput = {
      id: keysetId,
      amount: 100,
      secret: "signed-output",
      C: "02signed-output000000000000000000000000000000000000000000000000000",
    };
    assert.deepEqual(resumed, {
      lock: [expectedSignedOutput],
    });
    assert.equal(completionCalls, 2);
    const completed = await store.getProofOperation(operationId);
    assert.equal(completed?.state, "completed");
    assert.deepEqual(completed?.resultProofs, resumed);
    assert.equal(completed?.metadata.unit, "sat");
  } finally {
    CashuWallet.prototype.prepareConditionalSwap = originalPrepare;
    CashuWallet.prototype.completeConditionalSwap = originalComplete;
    CashuWallet.prototype.checkProofsStates = originalCheckProofsStates;
    CashuMint.prototype.getKeys = originalGetKeys;
  }
});

test("exact prepared recovery inspects and completes only persisted operation data", async () => {
  const originalCheck = CashuWallet.prototype.checkProofsStates;
  const originalComplete = CashuWallet.prototype.completeSwap;
  const input = proof("keyset-exact", 10, "exact-input");
  const send = proof("keyset-exact", 6, "exact-send");
  const keep = proof("keyset-exact", 4, "exact-keep");
  const entry: ProofOperationRecord = {
    operationId: "exact-operation",
    kind: "swap-lock",
    state: "mint-submitted",
    mintUrl: "https://mint.example",
    inputs: [input],
    outputs: { send: [storedOutput("keyset-exact", 6)], keep: [storedOutput("keyset-exact", 4)] },
    metadata: { amount: 6, fees: 0, keysetId: "keyset-exact", unit: "sat", unselectedProofs: [] },
    createdAt: 1,
    updatedAt: 1,
  };
  const wallet = new CashuWallet(new CashuMint(entry.mintUrl), { unit: "sat" });
  try {
    CashuWallet.prototype.checkProofsStates = async () => [
      { state: CheckStateEnum.UNSPENT },
    ] as ProofState[];
    CashuWallet.prototype.completeSwap = async () => ({ send: [send], keep: [keep] }) as never;

    await assert.doesNotReject(() => inspectExactPreparedProofOperation(wallet, entry));
    assert.equal(await inspectExactPreparedProofOperation(wallet, entry), "all-unspent");
    assert.deepEqual(await resumeExactPreparedProofOperation(wallet, entry), {
      send: [{ ...send, amount: 6 }],
      keep: [{ ...keep, amount: 4 }],
    });
  } finally {
    CashuWallet.prototype.checkProofsStates = originalCheck;
    CashuWallet.prototype.completeSwap = originalComplete;
  }
});

function swapContext(tradeId: string): SwapContext {
  const seller = generateEphemeralKeypair();
  const buyer = generateEphemeralKeypair();
  return {
    tradeId,
    role: "seller",
    ephemeralKey: seller,
    counterpartyPubkey: buyer.publicKey,
    sellerLocktime: 1_779_393_600,
    buyerLocktime: 1_779_393_000,
    mintUrl: "https://mint.example",
  };
}

function lockedProof(
  ctx: SwapContext,
  keysetId: string,
  amount: number,
): Proof {
  return {
    id: keysetId,
    amount: Amount.from(amount),
    secret: JSON.stringify([
      "P2PK",
      {
        data: ctx.ephemeralKey.publicKey,
        tags: [
          ["pubkeys", ctx.counterpartyPubkey],
          ["n_sigs", "2"],
          ["sigflag", "SIG_INPUTS"],
          ["locktime", String(ctx.sellerLocktime)],
          ["refund", ctx.ephemeralKey.publicKey],
        ],
      },
    ]),
    C: `02${keysetId}`.padEnd(66, "0").slice(0, 66),
  } as Proof;
}

function extractLocktime(proof: Proof): number {
  const parsed = JSON.parse(proof.secret) as [string, { tags: string[][] }];
  const tag = parsed[1].tags.find(([name]) => name === "locktime");
  return Number(tag?.[1]);
}

function outputData(keysetId: string, amount: number) {
  return {
    blindedMessage: {
      id: keysetId,
      amount: Amount.from(amount),
      B_: `02${keysetId}`.padEnd(66, "0").slice(0, 66),
    },
    blindingFactor: 1n,
    secret: new TextEncoder().encode(`secret-${keysetId}`),
    toProof: () => proof(keysetId, amount, `secret-${keysetId}`),
  };
}

function storedOutput(keysetId: string, amount: number) {
  return {
    blindedMessage: {
      id: keysetId,
      amount,
      B_: `02${keysetId}`.padEnd(66, "0").slice(0, 66),
    },
    blindingFactor: "01",
    secret: Buffer.from(`stored-${keysetId}`).toString("hex"),
  };
}

function proof(keysetId: string, amount: number, secret: string): Proof {
  return {
    id: keysetId,
    amount: Amount.from(amount),
    secret,
    C: `02${secret}`.padEnd(66, "0").slice(0, 66),
  } as Proof;
}

class MemoryProofOperationStore implements ProofOperationStore {
  readonly records = new Map<string, ProofOperationRecord>();

  async getProofOperation(
    operationId: string,
  ): Promise<ProofOperationRecord | null> {
    return this.records.get(operationId) ?? null;
  }

  async prepareProofOperation(
    input: PrepareProofOperationInput,
  ): Promise<ProofOperationRecord> {
    const record: ProofOperationRecord = {
      ...input,
      metadata: input.metadata ?? {},
      state: "prepared",
      createdAt: 1,
      updatedAt: 1,
    };
    this.records.set(input.operationId, record);
    return record;
  }

  async markProofOperationMintSubmitted(
    operationId: string,
  ): Promise<ProofOperationRecord> {
    const existing = this.records.get(operationId);
    if (!existing) throw new Error(`missing operation ${operationId}`);
    const submitted = {
      ...existing,
      state: "mint-submitted" as const,
      updatedAt: existing.updatedAt + 1,
    } satisfies ProofOperationRecord;
    this.records.set(operationId, submitted);
    return submitted;
  }

  async markProofOperationCompleted(
    operationId: string,
    resultProofs: Record<string, Proof[]>,
  ): Promise<ProofOperationRecord> {
    const existing = this.records.get(operationId);
    if (!existing) throw new Error(`missing operation ${operationId}`);
    const completed = {
      ...existing,
      state: "completed",
      resultProofs,
      updatedAt: existing.updatedAt + 1,
    } satisfies ProofOperationRecord;
    this.records.set(operationId, completed);
    return completed;
  }
}
