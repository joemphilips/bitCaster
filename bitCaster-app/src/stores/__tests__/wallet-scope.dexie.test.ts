import "fake-indexeddb/auto";
import { Amount } from "@cashu/cashu-ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addProofs,
  configureGuiWalletIdProvider,
  db,
  deriveStoredProofId,
  getProofOperation,
  getProofs,
  removeProofs,
} from "../proof-db";
import {
  canonicalKeysetId,
  canonicalSecpPoint,
} from "../../test/cashu-proof-fixtures";

const WALLET_A = "aa".repeat(32);
const WALLET_B = "bb".repeat(32);

describe("seed-derived GUI wallet scope", () => {
  let activeWalletId = WALLET_A;

  beforeEach(async () => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: async <T>(
          _name: string,
          _options: LockOptions,
          callback: () => Promise<T>,
        ) => callback(),
      },
    });
    configureGuiWalletIdProvider(() => activeWalletId);
    db.close();
    await db.delete();
    await db.open();
  });

  afterEach(async () => {
    delete (navigator as { locks?: LockManager }).locks;
    db.close();
    await db.delete();
  });

  it("keeps proofs and recovery operations isolated when the active seed changes", async () => {
    const proofA = {
      id: canonicalKeysetId(1),
      amount: Amount.from(1),
      secret: "proof-a",
      C: canonicalSecpPoint(1),
      mintUrl: "https://mint.example",
      unit: "sat",
    } as const;
    await addProofs([proofA]);
    await db.proofOperations.put({
      walletId: WALLET_A,
      operationId: "operation-a",
      kind: "regular-split",
      state: "prepared",
      mintUrl: "https://mint.example",
      inputs: [],
      outputs: {},
      metadata: { unit: "sat" },
      lastError: null,
      custodyOperationId: "custody-operation-a",
      createdAt: 1,
      updatedAt: 1,
    });

    activeWalletId = WALLET_B;
    expect(await getProofs()).toEqual([]);
    await expect(getProofOperation("operation-a")).resolves.toBeNull();
    await expect(removeProofs([proofA])).rejects.toThrow(
      "another wallet scope",
    );

    const proofB = {
      id: canonicalKeysetId(2),
      amount: Amount.from(2),
      secret: "proof-b",
      C: canonicalSecpPoint(2),
      mintUrl: "https://mint.example",
      unit: "sat",
    } as const;
    await addProofs([proofB]);
    expect((await getProofs()).map(({ secret }) => secret)).toEqual([
      "proof-b",
    ]);

    activeWalletId = WALLET_A;
    expect((await getProofs()).map(({ secret }) => secret)).toEqual([
      "proof-a",
    ]);
    expect((await getProofOperation("operation-a"))?.walletId).toBe(WALLET_A);
    expect(await db.proofs.get(deriveStoredProofId(proofB))).toMatchObject({
      walletId: WALLET_B,
    });
  });

  it("stores the same deterministic operation id independently for two wallets", async () => {
    const operationId = "shared-deterministic-operation";
    await db.proofOperations.put(
      proofOperation(WALLET_A, operationId, "https://mint-a.example"),
    );
    await db.proofOperations.put(
      proofOperation(WALLET_B, operationId, "https://mint-b.example"),
    );

    activeWalletId = WALLET_A;
    await expect(getProofOperation(operationId)).resolves.toMatchObject({
      walletId: WALLET_A,
      mintUrl: "https://mint-a.example",
    });

    activeWalletId = WALLET_B;
    await expect(getProofOperation(operationId)).resolves.toMatchObject({
      walletId: WALLET_B,
      mintUrl: "https://mint-b.example",
    });
    expect(await db.proofOperations.count()).toBe(2);
  });
});

function proofOperation(
  walletId: string,
  operationId: string,
  mintUrl: string,
) {
  return {
    walletId,
    operationId,
    kind: "regular-split" as const,
    state: "prepared" as const,
    mintUrl,
    inputs: [],
    outputs: {},
    metadata: { unit: "sat" as const },
    lastError: null,
    custodyOperationId: `custody-${operationId}`,
    createdAt: 1,
    updatedAt: 1,
  };
}
