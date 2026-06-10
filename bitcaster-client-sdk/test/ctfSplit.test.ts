import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeGrossCtfInputAmountSats,
  resolveComplementaryOutcomeLegs,
  resolveMintOutcomeSetKey,
  selectRootPartitionKeysets,
  splitRegularProofsWithOperation,
  splitCompleteSetWithOperation,
  type CtfPrepareProofOperationInput,
  type CtfProofOperationRecord,
  type CtfProofOperationStore,
  type CtfSplitOutputData,
  type CtfSplitTransport,
} from "../src/ctfSplit.ts";
import type {
  MintKeys,
  Proof,
  SerializedBlindedMessage,
  SerializedBlindedSignature,
} from "@cashu/cashu-ts";
import {
  CheckStateEnum,
  OutputData,
  type ProofState,
  type SwapPreview,
} from "@cashu/cashu-ts";

test("resolveMintOutcomeSetKey matches engine outcome sets to mint keyset-map keys", () => {
  const keysets = {
    "Bob|Carol": "keyset-not-alice",
    Alice: "keyset-alice",
  };

  assert.equal(
    resolveMintOutcomeSetKey("Carol|Bob", keysets, "lock"),
    "Bob|Carol",
  );
  assert.equal(resolveMintOutcomeSetKey("Alice", keysets, "keep"), "Alice");
});

test("resolveMintOutcomeSetKey fails closed on ambiguous mint keyset-map matches", () => {
  assert.throws(
    () =>
      resolveMintOutcomeSetKey(
        "Bob|Alice",
        {
          "Alice|Bob": "keyset-1",
          "Bob|Alice": "keyset-2",
          Carol: "keyset-3",
        },
        "lock",
      ),
    /matched 2 mint keyset-map keys/,
  );
});

test("resolveComplementaryOutcomeLegs decomposes compound outcome sets into primitive mint collections", () => {
  const keysets = {
    Alice: "keyset-alice",
    Bob: "keyset-bob",
    Carol: "keyset-carol",
    Dave: "keyset-dave",
  };

  assert.deepEqual(
    resolveComplementaryOutcomeLegs("Bob|Carol", "Alice|Dave", keysets),
    {
      resolvedLockOutcomeSetId: "Bob|Carol",
      resolvedKeepOutcomeSetId: "Alice|Dave",
      lockCollections: ["Bob", "Carol"],
      keepCollections: ["Alice", "Dave"],
    },
  );
});

test("resolveComplementaryOutcomeLegs accepts a composite root collection as one branch", () => {
  const keysets = {
    Alice: "keyset-alice",
    "Bob|Carol|Dave": "keyset-not-alice",
  };

  assert.deepEqual(
    resolveComplementaryOutcomeLegs("Alice", "Carol|Bob|Dave", keysets),
    {
      resolvedLockOutcomeSetId: "Alice",
      resolvedKeepOutcomeSetId: "Bob|Carol|Dave",
      lockCollections: ["Alice"],
      keepCollections: ["Bob|Carol|Dave"],
    },
  );
});

test("resolveComplementaryOutcomeLegs requires strict complete primitive coverage", () => {
  assert.throws(
    () =>
      resolveComplementaryOutcomeLegs("Bob|Carol", "Alice", {
        Alice: "keyset-alice",
        Bob: "keyset-bob",
        Carol: "keyset-carol",
        Dave: "keyset-dave",
      }),
    /do not cover the full primitive outcome set; missing Dave/,
  );
});

test("selectRootPartitionKeysets chooses the root partition matching the requested split target", () => {
  const condition = {
    condition_id: CONDITION_ID,
    keysets: {
      Alice: "keyset-alice",
      "Bob|Carol|Dave": "keyset-not-alice",
      Bob: "keyset-bob",
      "Alice|Carol|Dave": "keyset-not-bob",
      Carol: "keyset-carol",
      "Alice|Bob|Dave": "keyset-not-carol",
    },
  };

  assert.deepEqual(
    selectRootPartitionKeysets(condition, {
      lockOutcomeSetId: "Alice",
      keepOutcomeSetId: "Carol|Bob|Dave",
    }),
    {
      Alice: "keyset-alice",
      "Bob|Carol|Dave": "keyset-not-alice",
    },
  );
});

test("selectRootPartitionKeysets expands one-vs-rest primitive root partitions", () => {
  const condition = {
    condition_id: CONDITION_ID,
    keysets: {
      Alice: "keyset-alice",
      Bob: "keyset-bob",
      Carol: "keyset-carol",
    },
  };

  assert.deepEqual(
    selectRootPartitionKeysets(condition, {
      lockOutcomeSetId: "Alice",
      keepOutcomeSetId: "Bob|Carol",
    }),
    {
      Alice: "keyset-alice",
      Bob: "keyset-bob",
      Carol: "keyset-carol",
    },
  );
});

test("selectRootPartitionKeysets resolves id-keyed root keysets through conditional metadata", () => {
  const aliceCollectionId = "a".repeat(64);
  const notAliceCollectionId = "b".repeat(64);
  const condition = {
    condition_id: CONDITION_ID,
    keysets: {
      [aliceCollectionId]: "keyset-alice",
      [notAliceCollectionId]: "keyset-not-alice",
    },
  };

  assert.deepEqual(
    selectRootPartitionKeysets(
      condition,
      {
        lockOutcomeSetId: "Alice",
        keepOutcomeSetId: "Carol|Bob|Dave",
      },
      [
        {
          id: "keyset-alice",
          condition_id: CONDITION_ID,
          outcome_collection: "Alice",
          outcome_collection_id: aliceCollectionId,
        },
        {
          id: "keyset-not-alice",
          condition_id: CONDITION_ID,
          outcome_collection: "Bob|Carol|Dave",
          outcome_collection_id: notAliceCollectionId,
        },
      ],
    ),
    {
      Alice: "keyset-alice",
      "Bob|Carol|Dave": "keyset-not-alice",
    },
  );
});

test("selectRootPartitionKeysets keeps binary single-root compatibility without a target", () => {
  const condition = {
    condition_id: CONDITION_ID,
    keysets: {
      YES: "keyset-yes",
      NO: "keyset-no",
    },
  };

  assert.deepEqual(selectRootPartitionKeysets(condition), {
    YES: "keyset-yes",
    NO: "keyset-no",
  });
});

test("splitCompleteSetWithOperation prepares outputs before posting and completes results", async () => {
  const transport = new FakeSplitTransport();
  const store = new MemoryProofOperationStore();

  const result = await splitCompleteSetWithOperation({
    mintUrl: "https://mint.example",
    baseAsset: "usd",
    operationId: "op-1",
    transport,
    conditionId: CONDITION_ID,
    collateralProofs: [proof("input-keyset", 100, "input-secret")],
    outcomeCollectionKeysets: { YES: "keyset-yes", NO: "keyset-no" },
    amountSats: 100,
    proofOperationStore: store,
    makeOutputs: ({ collection, amountSats, keyset }) => [
      output(collection, amountSats, keyset.id),
    ],
  });

  assert.deepEqual(Object.keys(result).sort(), ["NO", "YES"]);
  assert.equal(result.YES[0].secret, "proof-YES");
  assert.equal(result.NO[0].secret, "proof-NO");
  assert.equal(transport.posted.length, 1);
  assert.deepEqual(transport.posted[0].outputs.YES, [
    { amount: 100, id: "keyset-yes", B_: "B-YES" },
  ]);

  const record = await store.getProofOperation("op-1");
  assert.equal(record?.state, "completed");
  assert.equal(record?.metadata.conditionId, CONDITION_ID);
  assert.equal(record?.metadata.amountSats, 100);
  assert.equal(record?.metadata.baseAsset, "usd");
  assert.deepEqual(record?.metadata.outcomeCollectionKeysets, {
    YES: "keyset-yes",
    NO: "keyset-no",
  });
});

test("splitCompleteSetWithOperation normalizes structured Cashu Amount inputs before mint calls", async () => {
  const transport = new FakeSplitTransport();
  const store = new MemoryProofOperationStore();

  await splitCompleteSetWithOperation({
    mintUrl: "https://mint.example",
    operationId: "op-structured-input",
    transport,
    conditionId: CONDITION_ID,
    collateralProofs: [
      {
        ...proof("input-keyset", 100, "input-secret"),
        amount: { value: 100n },
      } as unknown as Proof,
    ],
    outcomeCollectionKeysets: { YES: "keyset-yes", NO: "keyset-no" },
    amountSats: 100,
    proofOperationStore: store,
    makeOutputs: ({ collection, amountSats, keyset }) => [
      output(collection, amountSats, keyset.id),
    ],
  });

  assert.equal(typeof transport.posted[0].inputs[0].amount, "number");
  assert.equal(transport.posted[0].inputs[0].amount, 100);
  assert.equal(
    typeof store.records.get("op-structured-input")?.inputs[0].amount,
    "number",
  );
});

test("splitCompleteSetWithOperation replays completed operations without mint calls", async () => {
  const completed = new MemoryProofOperationStore();
  completed.records.set("op-completed", {
    operationId: "op-completed",
    kind: "ctf-split",
    state: "completed",
    mintUrl: "https://mint.example",
    inputs: [proof("input-keyset", 100, "input-secret")],
    outputs: {},
    metadata: {},
    resultProofs: {
      YES: [proof("keyset-yes", 100, "stored-proof")],
    },
    createdAt: 1,
    updatedAt: 2,
  });
  const transport = new FakeSplitTransport();

  const result = await splitCompleteSetWithOperation({
    mintUrl: "https://mint.example",
    operationId: "op-completed",
    transport,
    conditionId: CONDITION_ID,
    collateralProofs: [proof("input-keyset", 100, "input-secret")],
    outcomeCollectionKeysets: { YES: "keyset-yes", NO: "keyset-no" },
    amountSats: 100,
    proofOperationStore: completed,
    makeOutputs: ({ collection, amountSats, keyset }) => [
      output(collection, amountSats, keyset.id),
    ],
  });

  assert.deepEqual(result, {
    YES: [proof("keyset-yes", 100, "stored-proof")],
  });
  result.YES[0].secret = "mutated";
  assert.equal(
    completed.records.get("op-completed")?.resultProofs?.YES[0].secret,
    "stored-proof",
  );
  assert.equal(transport.posted.length, 0);
});

test("splitCompleteSetWithOperation fails closed for failed existing operations", async () => {
  const failed = new MemoryProofOperationStore();
  failed.records.set("op-failed", {
    operationId: "op-failed",
    kind: "ctf-split",
    state: "failed",
    mintUrl: "https://mint.example",
    inputs: [proof("input-keyset", 100, "input-secret")],
    outputs: {},
    metadata: {},
    lastError: "mint refused split",
    createdAt: 1,
    updatedAt: 2,
  });
  const transport = new FakeSplitTransport();

  await assert.rejects(
    () =>
      splitCompleteSetWithOperation({
        mintUrl: "https://mint.example",
        operationId: "op-failed",
        transport,
        conditionId: CONDITION_ID,
        collateralProofs: [proof("input-keyset", 100, "input-secret")],
        outcomeCollectionKeysets: { YES: "keyset-yes", NO: "keyset-no" },
        amountSats: 100,
        proofOperationStore: failed,
        makeOutputs: ({ collection, amountSats, keyset }) => [
          output(collection, amountSats, keyset.id),
        ],
      }),
    /previously failed: mint refused split/,
  );
  assert.equal(transport.posted.length, 0);
});

test("splitRegularProofsWithOperation turns a larger regular proof into an exact CTF input", async () => {
  const store = new MemoryProofOperationStore();
  const wallet = new FakeRegularSplitWallet({
    preview: {
      amount: 100,
      fees: 0,
      keysetId: "regular-keyset",
      inputs: [proof("regular-keyset", 210, "input-210")],
      sendOutputs: [
        new OutputData(
          { amount: 100, id: "regular-keyset", B_: "B-send" },
          1n,
          new Uint8Array([1]),
        ),
      ],
      keepOutputs: [
        new OutputData(
          { amount: 110, id: "regular-keyset", B_: "B-keep" },
          2n,
          new Uint8Array([2]),
        ),
      ],
      unselectedProofs: [],
    },
    result: {
      send: [proof("regular-keyset", 100, "send-100")],
      keep: [proof("regular-keyset", 110, "keep-110")],
    },
  });

  const split = await splitRegularProofsWithOperation({
    mintUrl: "https://mint.example",
    baseAsset: "usd",
    operationId: "regular-op-210",
    wallet,
    proofs: [proof("regular-keyset", 210, "input-210")],
    amountSats: 100,
    proofOperationStore: store,
  });

  assert.deepEqual(split.send, [proof("regular-keyset", 100, "send-100")]);
  assert.deepEqual(split.keep, [proof("regular-keyset", 110, "keep-110")]);
  assert.deepEqual(split.spent, [proof("regular-keyset", 210, "input-210")]);
  assert.equal(wallet.prepareCalls, 1);
  assert.equal(wallet.completeCalls, 1);
  assert.equal(store.records.get("regular-op-210")?.state, "completed");
  assert.equal(store.records.get("regular-op-210")?.metadata.baseAsset, "usd");
});

test("splitRegularProofsWithOperation replays completed regular splits without mint calls", async () => {
  const store = new MemoryProofOperationStore();
  store.records.set("regular-op-completed", {
    operationId: "regular-op-completed",
    kind: "regular-split",
    state: "completed",
    mintUrl: "https://mint.example",
    inputs: [proof("regular-keyset", 210, "input-210")],
    outputs: {},
    metadata: {},
    resultProofs: {
      send: [proof("regular-keyset", 100, "send-100")],
      keep: [proof("regular-keyset", 110, "keep-110")],
    },
    createdAt: 1,
    updatedAt: 2,
  });
  const wallet = new FakeRegularSplitWallet();

  const split = await splitRegularProofsWithOperation({
    mintUrl: "https://mint.example",
    operationId: "regular-op-completed",
    wallet,
    proofs: [],
    amountSats: 100,
    proofOperationStore: store,
  });

  assert.deepEqual(split.send, [proof("regular-keyset", 100, "send-100")]);
  assert.equal(wallet.prepareCalls, 0);
  assert.equal(wallet.completeCalls, 0);
});

test("computeGrossCtfInputAmountSats funds the convert fee from the output proof count", () => {
  const keyset = feePlanningKeyset(1, { 1: "k1", 2: "k2", 4: "k4" });

  assert.equal(
    computeGrossCtfInputAmountSats({
      faceAmountSats: 2,
      keyset,
    }),
    3,
  );
});

test("computeGrossCtfInputAmountSats handles F greater than 1 for many proofs", () => {
  const keyset = feePlanningKeyset(1, { 1: "k1" });

  assert.equal(
    computeGrossCtfInputAmountSats({
      faceAmountSats: 1001,
      keyset,
    }),
    1003,
  );
});

const CONDITION_ID = "a".repeat(64);

class FakeSplitTransport implements CtfSplitTransport {
  readonly posted: Array<Parameters<CtfSplitTransport["postSplit"]>[0]> = [];

  async getKeys(keysetId: string): Promise<MintKeys> {
    return {
      id: keysetId,
      unit: "sat",
      keys: {},
      input_fee_ppk: 0,
    } as MintKeys;
  }

  async getRootPartitionKeysets(): Promise<Record<string, string>> {
    return { YES: "keyset-yes", NO: "keyset-no" };
  }

  async postSplit(
    request: Parameters<CtfSplitTransport["postSplit"]>[0],
  ): ReturnType<CtfSplitTransport["postSplit"]> {
    this.posted.push(request);
    return {
      signatures: Object.fromEntries(
        Object.entries(request.outputs).map(([collection, outputs]) => [
          collection,
          outputs.map((message) => signature(message)),
        ]),
      ),
    };
  }
}

class MemoryProofOperationStore implements CtfProofOperationStore {
  readonly records = new Map<string, CtfProofOperationRecord>();

  async getProofOperation(
    operationId: string,
  ): Promise<CtfProofOperationRecord | null> {
    return this.records.get(operationId) ?? null;
  }

  async prepareProofOperation(
    input: CtfPrepareProofOperationInput,
  ): Promise<CtfProofOperationRecord> {
    const record: CtfProofOperationRecord = {
      ...input,
      state: "prepared",
      createdAt: 1,
      updatedAt: 1,
    };
    this.records.set(input.operationId, record);
    return record;
  }

  async markProofOperationCompleted(
    operationId: string,
    resultProofs: Record<string, Proof[]>,
  ): Promise<CtfProofOperationRecord> {
    const existing = this.records.get(operationId);
    if (!existing) throw new Error(`missing operation ${operationId}`);
    const completed: CtfProofOperationRecord = {
      ...existing,
      state: "completed",
      resultProofs,
      updatedAt: existing.updatedAt + 1,
    };
    this.records.set(operationId, completed);
    return completed;
  }
}

class FakeRegularSplitWallet {
  prepareCalls = 0;
  completeCalls = 0;
  proofStates: ProofState[] = [];
  private readonly script: {
    preview?: SwapPreview;
    result?: { keep: Proof[]; send: Proof[] };
  };

  constructor(
    script: {
      preview?: SwapPreview;
      result?: { keep: Proof[]; send: Proof[] };
    } = {},
  ) {
    this.script = script;
  }

  async prepareSwapToSend(): Promise<SwapPreview> {
    this.prepareCalls += 1;
    if (!this.script.preview) throw new Error("unexpected prepareSwapToSend");
    return this.script.preview;
  }

  async completeSwap(): Promise<{ keep: Proof[]; send: Proof[] }> {
    this.completeCalls += 1;
    if (!this.script.result) throw new Error("unexpected completeSwap");
    return this.script.result;
  }

  async checkProofsStates(): Promise<ProofState[]> {
    return this.proofStates.length > 0
      ? this.proofStates
      : [{ Y: "Y-input", state: CheckStateEnum.UNSPENT }];
  }
}

function proof(id: string, amount: number, secret: string): Proof {
  return {
    id,
    amount,
    secret,
    C: `C-${secret}`,
  };
}

function output(
  collection: string,
  amount: number,
  keysetId: string,
): CtfSplitOutputData {
  return {
    blindedMessage: { amount, id: keysetId, B_: `B-${collection}` },
    blindingFactor: 1n,
    secret: new TextEncoder().encode(`secret-${collection}`),
    toProof: (sig) => proof(sig.id, sig.amount, `proof-${collection}`),
  };
}

function signature(
  message: SerializedBlindedMessage,
): SerializedBlindedSignature {
  return {
    amount: message.amount,
    id: message.id,
    C_: `C-${message.B_}`,
  };
}

function feePlanningKeyset(
  inputFeePpk: number,
  keys: Record<number, string>,
) {
  return {
    id: "regular-keyset",
    keys,
    input_fee_ppk: inputFeePpk,
  };
}
