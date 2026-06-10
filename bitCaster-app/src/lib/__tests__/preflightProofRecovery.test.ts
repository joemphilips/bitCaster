import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Proof } from "@cashu/cashu-ts";
import type { ProofOperationRecord, StoredProof } from "@/stores/proof-db";

const mocks = vi.hoisted(() => ({
  getProofOperation: vi.fn(),
  getProofOperations: vi.fn(),
  getProofs: vi.fn(),
  markProofOperationCompleted: vi.fn(),
  prepareProofOperation: vi.fn(),
  replaceProofs: vi.fn(),
  splitCompleteSetWithOperation: vi.fn(),
  splitRegularProofsWithOperation: vi.fn(),
  getWallet: vi.fn(),
}));

vi.mock("@/stores/proof-db", () => mocks);
vi.mock("@/lib/ctfSplit", () => ({
  CashuMintCtfSplitTransport: vi.fn(),
  splitCompleteSetWithOperation: mocks.splitCompleteSetWithOperation,
  splitRegularProofsWithOperation: mocks.splitRegularProofsWithOperation,
}));
vi.mock("@/stores/wallet", () => ({
  useWalletStore: {
    getState: () => ({
      getWallet: mocks.getWallet,
    }),
  },
}));

import {
  reconcileCompletedPreflightProofOperations,
  runPreflightMintSingleFlight,
} from "../preflightProofRecovery";

function proof(secret: string, amount = 100, id = "keyset"): Proof {
  return {
    id,
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
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          keysets: [
            keyset("keyset-YES", "cond", "YES"),
            keyset("keyset-NO", "cond", "NO"),
          ],
        }),
      }),
    );
    mocks.getWallet.mockResolvedValue({ checkProofsStates: vi.fn() });
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
        resultProofs: {
          YES: [proof("yes-proof", 100, "keyset-YES")],
          NO: [proof("no-proof", 100, "keyset-NO")],
        },
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
          id: "keyset-YES",
          mintUrl: "https://mint.example",
          conditionId: "cond",
          outcomeCollection: "YES",
          marketId: "cond-YES",
          baseAsset: "sat",
          reservedBy: "order-preflight:epub",
        },
        {
          ...proof("no-proof"),
          id: "keyset-NO",
          mintUrl: "https://mint.example",
          conditionId: "cond",
          outcomeCollection: "NO",
          marketId: "cond-NO",
          baseAsset: "sat",
          reservedBy: "order-preflight:epub",
        },
      ],
    );
  });

  it("resumes prepared regular split operations before replacing stale inputs", async () => {
    mocks.getProofOperations.mockResolvedValue([
      operation({
        state: "prepared",
        resultProofs: undefined,
        metadata: { amount: 100 },
      }),
    ]);
    mocks.splitRegularProofsWithOperation.mockResolvedValue({
      send: [proof("restored-send")],
      keep: [proof("restored-keep")],
      spent: [proof("spent-input")],
    });

    const result = await reconcileCompletedPreflightProofOperations({
      mintUrl: "https://mint.example",
    });

    expect(mocks.splitRegularProofsWithOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        mintUrl: "https://mint.example",
        operationId: "order-preflight:epub:regular-split:0",
        proofs: [],
        amountSats: 100,
      }),
    );
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
    });
  });

  it("counts malformed CTF operations instead of silently dropping them", async () => {
    mocks.getProofOperations.mockResolvedValue([
      operation({
        operationId: "order-preflight:epub:ctf-split:0",
        kind: "ctf-split",
        metadata: {},
        resultProofs: { YES: [proof("yes-proof")] },
      }),
    ]);

    const result = await reconcileCompletedPreflightProofOperations({
      mintUrl: "https://mint.example",
    });

    expect(mocks.replaceProofs).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      operationsChecked: 1,
      operationsReconciled: 0,
      invalidCtfOperationsSkipped: 1,
    });
  });

  it("serializes three same-mint preflight tasks instead of stampeding waiters", async () => {
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const task = (id: number) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`start-${id}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
      order.push(`end-${id}`);
      active -= 1;
      return id;
    };

    await expect(
      Promise.all([
        runPreflightMintSingleFlight("https://mint.example", task(1)),
        runPreflightMintSingleFlight("https://mint.example", task(2)),
        runPreflightMintSingleFlight("https://mint.example", task(3)),
      ]),
    ).resolves.toEqual([1, 2, 3]);

    expect(maxActive).toBe(1);
    expect(order).toEqual([
      "start-1",
      "end-1",
      "start-2",
      "end-2",
      "start-3",
      "end-3",
    ]);
  });
});

function keyset(id: string, conditionId: string, outcomeCollection: string) {
  return {
    id,
    condition_id: conditionId,
    outcome_collection: outcomeCollection,
    outcome_collection_id: outcomeCollection,
  };
}
