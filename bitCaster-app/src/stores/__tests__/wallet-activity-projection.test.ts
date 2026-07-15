import { Amount } from "@cashu/cashu-ts";
import { describe, expect, it } from "vitest";
import type { ProofOperationRecord } from "../proof-db";
import {
  projectCompletedGuiDepositActivity,
  requireWalletActivityRow,
} from "../wallet-activity-projection";

const WALLET_ID = "a".repeat(64);
const KEYSET_ID = `00${"22".repeat(7)}`;

function completedReceive(): ProofOperationRecord {
  return {
    walletId: WALLET_ID,
    operationId: "wallet-receive:deterministic-operation",
    custodyOperationId: "custody-operation",
    kind: "wallet-receive",
    state: "completed",
    mintUrl: "https://mint.example",
    inputs: [],
    outputs: {},
    metadata: { unit: "sat" },
    resultProofs: {
      receive: [
        {
          id: KEYSET_ID,
          amount: Amount.from(1),
          secret: "11".repeat(32),
          C: `02${"33".repeat(32)}`,
        },
        {
          id: KEYSET_ID,
          amount: Amount.from(2),
          secret: "22".repeat(32),
          C: `03${"44".repeat(32)}`,
        },
      ],
    },
    lastError: null,
    createdAt: Date.parse("2026-07-15T00:00:00.000Z"),
    updatedAt: Date.parse("2026-07-15T00:00:01.000Z"),
  };
}

describe("wallet activity projection", () => {
  it("derives one stable activity identity from reordered result proofs", () => {
    const operation = completedReceive();
    const forward = projectCompletedGuiDepositActivity(operation);
    operation.resultProofs!.receive.reverse();
    const reversed = projectCompletedGuiDepositActivity(operation);

    expect(forward).toEqual(reversed);
    expect(forward).toMatchObject({
      walletId: WALLET_ID,
      id: operation.operationId,
      amountSats: 3,
      type: "deposit",
    });
  });

  it("rejects a corrupt or foreign wallet activity row", () => {
    const row = projectCompletedGuiDepositActivity(completedReceive());
    expect(row).not.toBeNull();
    expect(() =>
      requireWalletActivityRow(
        { ...row!, walletId: "b".repeat(64) },
        WALLET_ID,
      ),
    ).toThrow(/another wallet|invalid/i);
    expect(() =>
      requireWalletActivityRow({ ...row!, amountSats: -1 }, WALLET_ID),
    ).toThrow(/invalid/i);
  });
});
