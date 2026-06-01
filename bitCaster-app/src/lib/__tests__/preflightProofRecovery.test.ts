import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Proof } from "@cashu/cashu-ts";
import type { ProofOperationRecord, StoredProof } from "@/stores/proof-db";

const mocks = vi.hoisted(() => ({
  getProofOperations: vi.fn(),
  getProofs: vi.fn(),
  replaceProofs: vi.fn(),
}));

vi.mock("@/stores/proof-db", () => mocks);

import { reconcileCompletedPreflightProofOperations } from "../preflightProofRecovery";

function proof(secret: string, amount = 100): Proof {
  return {
    id: "keyset",
    amount,
    secret,
    C: `02${secret}`.padEnd(66, "0"),
  } as unknown as Proof;
}

function operation(
  override: Partial<ProofOperationRecord>,
): ProofOperationRecord {
  return {
    operationId: "order-preflight:epub:regular-split:0",
    kind: "regular-split",
    state: "completed",
    mintUrl: "https://mint.example",
    inputs: [proof("spent-input")],
    outputs: {},
    metadata: {},
    resultProofs: {
      send: [proof("restored-send")],
      keep: [proof("restored-keep")],
    },
    lastError: null,
    createdAt: 1,
    updatedAt: 2,
    ...override,
  };
}

describe("preflight proof recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProofs.mockResolvedValue([
      { ...proof("spent-input"), mintUrl: "https://mint.example" },
    ] satisfies StoredProof[]);
  });

  it("replaces stale regular split inputs with completed result proofs", async () => {
    mocks.getProofOperations.mockResolvedValue([operation({})]);

    const result = await reconcileCompletedPreflightProofOperations({
      mintUrl: "https://mint.example",
    });

    expect(mocks.replaceProofs).toHaveBeenCalledWith(
      ["spent-input"],
      [
        { ...proof("restored-send"), mintUrl: "https://mint.example" },
        { ...proof("restored-keep"), mintUrl: "https://mint.example" },
      ],
    );
    expect(result).toMatchObject({
      operationsChecked: 1,
      operationsReconciled: 1,
      inputsRemoved: 1,
      proofsRestored: 2,
    });
  });

  it("keeps active CTF preflight outputs reserved for pending trades", async () => {
    mocks.getProofOperations.mockResolvedValue([
      operation({
        operationId: "order-preflight:epub:ctf-split:0",
        kind: "ctf-split",
        metadata: { conditionId: "cond" },
        resultProofs: { YES: [proof("yes-proof")], NO: [proof("no-proof")] },
      }),
    ]);

    await reconcileCompletedPreflightProofOperations({
      mintUrl: "https://mint.example",
      activeReservationIds: ["order-preflight:epub"],
    });

    expect(mocks.replaceProofs).toHaveBeenCalledWith(
      ["spent-input"],
      [
        {
          ...proof("yes-proof"),
          mintUrl: "https://mint.example",
          conditionId: "cond",
          outcomeCollection: "YES",
          marketId: "cond-YES",
          reservedBy: "order-preflight:epub",
        },
        {
          ...proof("no-proof"),
          mintUrl: "https://mint.example",
          conditionId: "cond",
          outcomeCollection: "NO",
          marketId: "cond-NO",
          reservedBy: "order-preflight:epub",
        },
      ],
    );
  });
});
