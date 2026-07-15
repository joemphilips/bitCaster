import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Proof } from "@cashu/cashu-ts";
import {
  splitRootCompleteSetForPreflightOrder,
  splitRootCompleteSetForSwap,
  type CtfProofOperationRecord,
  type CtfProofOperationStore,
} from "@/lib/ctfSplit";

const { MockAmount, MockOutputData, MockCtfMint, ctfMintState } = vi.hoisted(
  () => {
    class MockAmount {
      constructor(readonly value: number) {}
      static from(value: unknown) {
        return value instanceof MockAmount
          ? value
          : new MockAmount(Number(value));
      }
      isZero() {
        return this.value === 0;
      }
      equals(other: unknown) {
        return (
          this.value ===
          Number(other instanceof MockAmount ? other.value : other)
        );
      }
      toNumber() {
        return this.value;
      }
      toJSON() {
        return String(this.value);
      }
    }

    class MockOutputData {
      blindedMessage: { amount: MockAmount; id: string; B_: string };
      blindingFactor = 1n;
      secret = new Uint8Array([1]);

      constructor(
        kind: "p2pk" | "random",
        amount: MockAmount,
        keyset: { id: string },
      ) {
        if (typeof amount?.isZero !== "function") {
          throw new TypeError("amount.isZero is not a function");
        }
        this.blindedMessage = {
          amount,
          id: keyset.id,
          B_: `${kind}-${keyset.id}`,
        };
      }

      static createP2PKData(
        _p2pk: unknown,
        amount: MockAmount,
        keyset: { id: string },
      ): MockOutputData[] {
        return [new MockOutputData("p2pk", amount, keyset)];
      }

      static createRandomData(
        amount: MockAmount,
        keyset: { id: string },
      ): MockOutputData[] {
        return [new MockOutputData("random", amount, keyset)];
      }

      toProof(signature: { id: string; amount: unknown; C_: string }) {
        const amount =
          signature.amount instanceof MockAmount
            ? signature.amount.toNumber()
            : Number(signature.amount);
        return {
          id: signature.id,
          amount,
          secret: `proof-${this.blindedMessage.B_}`,
          C: signature.C_,
        };
      }
    }

    const ctfMintState = {
      keysets: {} as Record<string, string>,
      collateral: undefined as string | undefined,
      conditionalKeysets: [] as Array<{
        id: string;
        unit?: string;
        condition_id: string;
        outcome_collection: string;
        outcome_collection_id: string;
      }>,
      splitRequests: [] as Array<{
        condition_id: string;
        inputs: Proof[];
        outputs: Record<
          string,
          Array<{ id: string; amount: number; B_: string }>
        >;
      }>,
    };

    class MockCtfMint {
      constructor(readonly mintUrl: string) {}

      async getKeys(keysetId: string) {
        return {
          keysets: [
            {
              id: keysetId,
              unit: keysetId.startsWith("usd") ? "usd" : "sat",
              active: true,
              input_fee_ppk: 1,
              keys: { 1: "02".padEnd(66, "1") },
            },
          ],
        };
      }

      async getCtfCondition(conditionIdArg: string) {
        return {
          condition_id: conditionIdArg,
          collateral: ctfMintState.collateral,
          keysets: ctfMintState.keysets,
        };
      }

      async getConditionalKeysets() {
        return { keysets: ctfMintState.conditionalKeysets };
      }

      async ctfConvert(request: {
        condition_id: string;
        inputs: Record<string, Proof[]>;
        outputs: Record<
          string,
          Array<{ id: string; amount: number; B_: string }>
        >;
      }) {
        expect(Object.keys(request.inputs)).toEqual(["*"]);
        ctfMintState.splitRequests.push({
          condition_id: request.condition_id,
          inputs: request.inputs["*"] ?? [],
          outputs: request.outputs,
        });
        for (const outputs of Object.values(request.outputs)) {
          expect(
            outputs.every((output) => typeof output.amount === "number"),
          ).toBe(true);
        }
        return {
          signatures: Object.fromEntries(
            Object.entries(request.outputs).map(([collection, outputs]) => [
              collection,
              outputs.map((output) => ({
                id: output.id,
                amount: output.amount,
                C_: `02${collection}`.padEnd(66, "0"),
              })),
            ]),
          ),
        };
      }
    }

    return { MockAmount, MockOutputData, MockCtfMint, ctfMintState };
  },
);

vi.mock("@cashu/cashu-ts", () => {
  return {
    Amount: MockAmount,
    CheckStateEnum: { SPENT: "SPENT", UNSPENT: "UNSPENT" },
    OutputData: MockOutputData,
    Mint: vi.fn(function MockMint(mintUrl: string) {
      return new MockCtfMint(mintUrl);
    }),
    Wallet: vi.fn(),
  };
});

const conditionId = "a".repeat(64);
const inputProof = {
  id: "sat-keyset",
  amount: 101,
  secret: "input-secret",
  C: "02".padEnd(66, "0"),
} as unknown as Proof;

function proofOperationStore(): CtfProofOperationStore {
  const operations = new Map<string, CtfProofOperationRecord>();
  const requireOperation = (operationId: string): CtfProofOperationRecord => {
    const operation = operations.get(operationId);
    if (!operation) throw new Error(`missing proof operation ${operationId}`);
    return operation;
  };
  return {
    getProofOperation: vi.fn(async (operationId) =>
      operations.get(operationId) ?? null,
    ),
    prepareProofOperation: vi.fn(
      async (input): Promise<CtfProofOperationRecord> => {
        const existing = operations.get(input.operationId);
        if (existing) return existing;
        const now = Date.now();
        const prepared = {
          ...input,
          state: "prepared" as const,
          resultProofs: undefined,
          lastError: null,
          createdAt: now,
          updatedAt: now,
        };
        operations.set(input.operationId, prepared);
        return prepared;
      },
    ),
    markProofOperationMintSubmitted: vi.fn(
      async (operationId): Promise<CtfProofOperationRecord> => {
        const submitted = {
          ...requireOperation(operationId),
          state: "mint-submitted" as const,
          updatedAt: Date.now(),
        };
        operations.set(operationId, submitted);
        return submitted;
      },
    ),
    markProofOperationCompleted: vi.fn(
      async (operationId, resultProofs): Promise<CtfProofOperationRecord> => {
        const completed = {
          ...requireOperation(operationId),
          state: "completed" as const,
          resultProofs,
          updatedAt: Date.now(),
        };
        operations.set(operationId, completed);
        return completed;
      },
    ),
  };
}

function mockMintCondition(
  keysets:
    | Record<string, string>
    | Array<Record<string, string>>
    | Array<{ keysets: Record<string, string>; collateral?: string }>,
) {
  const entries = Array.isArray(keysets) ? keysets : [keysets];
  ctfMintState.keysets = Object.assign(
    {},
    ...entries.map((entry) => toMockConditionKeysetEntry(entry).keysets),
  );
  ctfMintState.collateral = entries
    .map((entry) => toMockConditionKeysetEntry(entry).collateral)
    .find((collateral): collateral is string => typeof collateral === "string");
  ctfMintState.conditionalKeysets = [];
  ctfMintState.splitRequests = [];
}

interface MockConditionKeysetEntry {
  keysets: Record<string, string>;
  collateral?: string;
}

function toMockConditionKeysetEntry(
  entry: Record<string, string> | MockConditionKeysetEntry,
): MockConditionKeysetEntry {
  return isMockConditionKeysetEntry(entry) ? entry : { keysets: entry };
}

function isMockConditionKeysetEntry(
  entry: Record<string, string> | MockConditionKeysetEntry,
): entry is MockConditionKeysetEntry {
  return "keysets" in entry;
}

describe("splitRootCompleteSetForSwap", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mockMintCondition({});
  });

  it("keys split outputs by the exact singleton/composite mint keysets and locks the resolved branch", async () => {
    mockMintCondition([
      {
        Alice: "keyset-alice",
        Bob: "keyset-bob",
        Carol: "keyset-carol",
      },
      {
        Alice: "keyset-alice",
        "Bob|Carol": "keyset-not-alice",
      },
    ]);

    const result = await splitRootCompleteSetForSwap({
      mintUrl: "https://mint.example",
      conditionId,
      collateralProofs: [inputProof],
      amountSats: 100,
      lockOutcomeSetId: "Carol|Bob",
      keepOutcomeSetId: "Alice",
      p2pk: { pubkey: ["02".padEnd(66, "2")], locktime: 1 },
      operationId: "op-1",
      proofOperationStore: proofOperationStore(),
    });

    const splitRequest = ctfMintState.splitRequests[0];
    expect(Object.keys(splitRequest.outputs)).toEqual([
      "Alice",
      "Bob|Carol",
    ]);
    expect(splitRequest.inputs[0].amount).toBe(101);
    expect(splitRequest.outputs.Alice[0].B_).toBe("random-keyset-alice");
    expect(splitRequest.outputs["Bob|Carol"][0].B_).toBe(
      "p2pk-keyset-not-alice",
    );
    expect(result.resolvedLockOutcomeSetId).toBe("Bob|Carol");
    expect(result.resolvedKeepOutcomeSetId).toBe("Alice");
    expect(result.lockedProofs.map((proof) => proof.id)).toEqual([
      "keyset-not-alice",
    ]);
    expect(result.keepProofs[0].id).toBe("keyset-alice");
  });

  it("pre-flight splits to one selected singleton and one composite complement", async () => {
    mockMintCondition({
      YES: "keyset-yes",
      NO: "keyset-no",
    });

    const result = await splitRootCompleteSetForPreflightOrder({
      mintUrl: "https://mint.example",
      conditionId,
      collateralProofs: [inputProof],
      amountSats: 100,
      lockOutcomeSetId: "NO",
      keepOutcomeSetId: "YES",
      operationId: "op-preflight",
      proofOperationStore: proofOperationStore(),
    });

    const splitRequest = ctfMintState.splitRequests[0];
    expect(splitRequest.inputs[0].amount).toBe(101);
    expect(splitRequest.outputs.NO[0].B_).toBe("random-keyset-no");
    expect(splitRequest.outputs.YES[0].B_).toBe("random-keyset-yes");
    expect(result.lockProofs[0].id).toBe("keyset-no");
    expect(result.keepProofs[0].id).toBe("keyset-yes");
    expect(result.proofsByCollection.NO[0].secret).toBe(
      "proof-random-keyset-no",
    );
    expect(result.proofsByCollection.YES[0].secret).toBe(
      "proof-random-keyset-yes",
    );
  });

  it("pre-flight resolves id-keyed composite complement keysets", async () => {
    const aCollectionId = "a".repeat(64);
    const notACollectionId = "b".repeat(64);
    mockMintCondition([
      {
        keysets: {
          [aCollectionId]: "keyset-a",
          [notACollectionId]: "keyset-not-a",
        },
      },
    ]);
    ctfMintState.conditionalKeysets = [
      {
        id: "keyset-a",
        condition_id: conditionId,
        outcome_collection: "A",
        outcome_collection_id: aCollectionId,
      },
      {
        id: "keyset-not-a",
        condition_id: conditionId,
        outcome_collection: "B|C|D",
        outcome_collection_id: notACollectionId,
      },
    ];

    const result = await splitRootCompleteSetForPreflightOrder({
      mintUrl: "https://mint.example",
      conditionId,
      collateralProofs: [inputProof],
      amountSats: 100,
      lockOutcomeSetId: "B|C|D",
      keepOutcomeSetId: "A",
      operationId: "op-preflight-id-keyed",
      proofOperationStore: proofOperationStore(),
    });

    const splitRequest = ctfMintState.splitRequests[0];
    expect(Object.keys(splitRequest.outputs)).toEqual(["A", "B|C|D"]);
    expect(splitRequest.outputs.A[0].B_).toBe("random-keyset-a");
    expect(splitRequest.outputs["B|C|D"][0].B_).toBe(
      "random-keyset-not-a",
    );
    expect(result.keepProofs[0].id).toBe("keyset-a");
    expect(result.lockProofs[0].id).toBe("keyset-not-a");
  });

  it("selects conditional keysets matching the requested collateral unit", async () => {
    mockMintCondition([
      {
        keysets: {
          Alpha: "usd-alpha",
          Beta: "usd-beta",
        },
        collateral: "usd",
      },
    ]);
    ctfMintState.conditionalKeysets = [
      {
        id: "sat-alpha",
        unit: "sat",
        condition_id: conditionId,
        outcome_collection: "Alpha",
        outcome_collection_id: "alpha-id",
      },
      {
        id: "sat-beta",
        unit: "sat",
        condition_id: conditionId,
        outcome_collection: "Beta",
        outcome_collection_id: "beta-id",
      },
      {
        id: "usd-alpha",
        unit: "usd",
        condition_id: conditionId,
        outcome_collection: "Alpha",
        outcome_collection_id: "alpha-id",
      },
      {
        id: "usd-beta",
        unit: "usd",
        condition_id: conditionId,
        outcome_collection: "Beta",
        outcome_collection_id: "beta-id",
      },
    ];

    await splitRootCompleteSetForSwap({
      mintUrl: "https://mint.example",
      baseAsset: "usd",
      conditionId,
      collateralProofs: [{ ...inputProof, id: "usd-regular" }],
      amountSats: 100,
      lockOutcomeSetId: "Beta",
      keepOutcomeSetId: "Alpha",
      p2pk: { pubkey: ["02".padEnd(66, "2")], locktime: 1 },
      operationId: "op-usd-keysets",
      proofOperationStore: proofOperationStore(),
    });

    const splitRequest = ctfMintState.splitRequests[0];
    expect(splitRequest.outputs.Alpha[0].id).toBe("usd-alpha");
    expect(splitRequest.outputs.Beta[0].id).toBe("usd-beta");
  });

  it("fails closed before posting when input proof keysets do not match the requested unit", async () => {
    mockMintCondition([
      {
        keysets: {
          Alpha: "usd-alpha",
          Beta: "usd-beta",
        },
        collateral: "usd",
      },
    ]);

    await expect(
      splitRootCompleteSetForSwap({
        mintUrl: "https://mint.example",
        baseAsset: "usd",
        conditionId,
        collateralProofs: [{ ...inputProof, id: "sat-regular" }],
        amountSats: 100,
        lockOutcomeSetId: "Beta",
        keepOutcomeSetId: "Alpha",
        p2pk: { pubkey: ["02".padEnd(66, "2")], locktime: 1 },
        operationId: "op-usd-wrong-input-unit",
        proofOperationStore: proofOperationStore(),
      }),
    ).rejects.toThrow(/input proof keyset sat-regular unit mismatch: expected usd, got sat/);
    expect(ctfMintState.splitRequests).toHaveLength(0);
  });

  it("fails closed before posting when output keysets do not match the requested unit", async () => {
    mockMintCondition([
      {
        keysets: {
          Alpha: "sat-alpha",
          Beta: "sat-beta",
        },
        collateral: "usd",
      },
    ]);

    await expect(
      splitRootCompleteSetForSwap({
        mintUrl: "https://mint.example",
        baseAsset: "usd",
        conditionId,
        collateralProofs: [{ ...inputProof, id: "usd-regular" }],
        amountSats: 100,
        lockOutcomeSetId: "Beta",
        keepOutcomeSetId: "Alpha",
        p2pk: { pubkey: ["02".padEnd(66, "2")], locktime: 1 },
        operationId: "op-usd-wrong-output-unit",
        proofOperationStore: proofOperationStore(),
      }),
    ).rejects.toThrow(/output keyset sat-alpha for Alpha unit mismatch: expected usd, got sat/);
    expect(ctfMintState.splitRequests).toHaveLength(0);
  });

  it("fails closed for non-sat conditional keysets with missing unit metadata", async () => {
    const alphaCollectionId = "a".repeat(64);
    const betaCollectionId = "b".repeat(64);
    mockMintCondition([
      {
        keysets: {
          [alphaCollectionId]: "usd-alpha",
          [betaCollectionId]: "usd-beta",
        },
        collateral: "usd",
      },
    ]);
    ctfMintState.conditionalKeysets = [
      {
        id: "usd-alpha",
        condition_id: conditionId,
        outcome_collection: "Alpha",
        outcome_collection_id: alphaCollectionId,
      },
      {
        id: "usd-beta",
        condition_id: conditionId,
        outcome_collection: "Beta",
        outcome_collection_id: betaCollectionId,
      },
    ];

    await expect(
      splitRootCompleteSetForSwap({
        mintUrl: "https://mint.example",
        baseAsset: "usd",
        conditionId,
        collateralProofs: [{ ...inputProof, id: "usd-regular" }],
        amountSats: 100,
        lockOutcomeSetId: "Beta",
        keepOutcomeSetId: "Alpha",
        p2pk: { pubkey: ["02".padEnd(66, "2")], locktime: 1 },
        operationId: "op-usd-missing-keyset-unit",
        proofOperationStore: proofOperationStore(),
      }),
    ).rejects.toThrow("Expected root usd CTF keysets");
    expect(ctfMintState.splitRequests).toHaveLength(0);
  });

  it("fails closed for conditional keysets with unsupported unit metadata", async () => {
    const alphaCollectionId = "a".repeat(64);
    const betaCollectionId = "b".repeat(64);
    mockMintCondition([
      {
        keysets: {
          [alphaCollectionId]: "usd-alpha",
          [betaCollectionId]: "usd-beta",
        },
        collateral: "usd",
      },
    ]);
    ctfMintState.conditionalKeysets = [
      {
        id: "usd-alpha",
        unit: "credits",
        condition_id: conditionId,
        outcome_collection: "Alpha",
        outcome_collection_id: alphaCollectionId,
      },
      {
        id: "usd-beta",
        unit: "credits",
        condition_id: conditionId,
        outcome_collection: "Beta",
        outcome_collection_id: betaCollectionId,
      },
    ];

    await expect(
      splitRootCompleteSetForSwap({
        mintUrl: "https://mint.example",
        baseAsset: "usd",
        conditionId,
        collateralProofs: [{ ...inputProof, id: "usd-regular" }],
        amountSats: 100,
        lockOutcomeSetId: "Beta",
        keepOutcomeSetId: "Alpha",
        p2pk: { pubkey: ["02".padEnd(66, "2")], locktime: 1 },
        operationId: "op-usd-invalid-keyset-unit",
        proofOperationStore: proofOperationStore(),
      }),
    ).rejects.toThrow("Expected root usd CTF keysets");
    expect(ctfMintState.splitRequests).toHaveLength(0);
  });

  it("throws before posting when no exact singleton/composite keyset pair exists", async () => {
    mockMintCondition([
      {
        Alice: "keyset-alice",
        Bob: "keyset-bob",
        Carol: "keyset-carol",
      },
      {
        "Alice|Bob": "keyset-1",
        Carol: "keyset-3",
      },
    ]);

    await expect(
      splitRootCompleteSetForSwap({
        mintUrl: "https://mint.example",
        conditionId,
        collateralProofs: [inputProof],
        amountSats: 100,
        lockOutcomeSetId: "Bob|Carol",
        keepOutcomeSetId: "Alice",
        p2pk: { pubkey: ["02".padEnd(66, "2")], locktime: 1 },
        operationId: "op-2",
        proofOperationStore: proofOperationStore(),
      }),
    ).rejects.toThrow(
      "CTF split root outcome collection Alice|Bob overlaps primitive outcome Alice with Alice",
    );
    expect(ctfMintState.splitRequests).toHaveLength(0);
  });
});
