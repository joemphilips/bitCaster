import "fake-indexeddb/auto";
import { Amount } from "@cashu/cashu-ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addProofs,
  configureGuiWalletIdProvider,
  db,
  getBoundedUnitProofsForAmountUnderLock,
  prepareStoredProofForWrite,
} from "../proof-db";
import { withGuiCustodyProfileLock } from "../gui-custody-authority";
import type { GuiWalletLockContext } from "../gui-wallet-lock";
import {
  canonicalKeysetId,
  canonicalSecpPoint,
} from "../../test/cashu-proof-fixtures";

const WALLET_ID = "aa".repeat(32);
const PROOF = {
  id: canonicalKeysetId(1),
  amount: Amount.from(1),
  secret: "proof-secret",
  C: canonicalSecpPoint(1),
  mintUrl: "https://mint.example",
  baseAsset: "sat",
  unit: "sat" as const,
};

const CTF_TEMPLATE = prepareStoredProofForWrite(
    {
      ...proofWith("ctf-template", 1_024),
      conditionId: "condition-a",
      outcomeCollection: "outcome-a",
      marketId: "condition-a-outcome-a",
    },
    1,
    WALLET_ID,
  );
const RESERVED_TEMPLATE = prepareStoredProofForWrite(
    {
      ...proofWith("reserved-template", 1_024),
      reservedBy: "another-operation",
    },
    1,
    WALLET_ID,
  );

describe.sequential("50,000-proof physical-index capacity", () => {
  beforeAll(async () => {
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
    configureGuiWalletIdProvider(() => WALLET_ID);
    db.close();
    await db.delete();
    await db.open();
  });

  afterAll(async () => {
    delete (navigator as { locks?: LockManager }).locks;
    db.close();
    await db.delete();
  });

  it.each(Array.from({ length: 10 }, (_, index) => index))(
    "seeds incompatible batch %i",
    async (batch) => {
      const offset = batch * 5_000;
      const incompatible = Array.from({ length: 5_000 }, (_, localIndex) => {
        const index = offset + localIndex;
        return {
          ...(index % 2 === 0 ? CTF_TEMPLATE : RESERVED_TEMPLATE),
          secret: `incompatible-${index}`,
          proofId: index.toString(16).padStart(64, "0"),
        };
      });
      await db.proofs.bulkPut(incompatible);
    },
  );

  it("uses the exact physical index despite 50,000 incompatible proofs", async () => {
    await addProofs([proofWith("only-spendable", 64)]);

    const selected = await withLock((lock) =>
      getBoundedUnitProofsForAmountUnderLock(lock, "https://mint.example", {
        unit: "sat",
        minimumAmount: 64,
      }),
    );

    expect(selected.map(({ secret }) => secret)).toEqual(["only-spendable"]);
  });
});

function proofWith(secret: string, amount: number) {
  return { ...PROOF, amount: Amount.from(amount), secret };
}

function withLock<T>(
  action: (lock: GuiWalletLockContext) => Promise<T>,
): Promise<T> {
  return withGuiCustodyProfileLock((_context, lock) => action(lock));
}
