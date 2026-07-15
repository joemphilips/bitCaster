import "fake-indexeddb/auto";
import { Amount, type Proof } from "@cashu/cashu-ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BitcasterDB,
  configureGuiWalletIdProvider,
  db,
  prepareStoredProofForWrite,
  type StoredProofRow,
} from "../proof-db";
import {
  commitGuiPartialLockFailureUnderLock,
  getGuiPartialLockFailure,
  listElapsedGuiPartialLockFailures,
} from "../partial-lock-failure-db";
import type { GuiPartialLockFailureRecord } from "../partial-lock-failure-model";
import { withGuiWalletLock } from "../gui-wallet-lock";
import {
  canonicalKeysetId,
  canonicalSecpPoint,
} from "../../test/cashu-proof-fixtures";

const TRADE_ID = "trade-partial-lock";
const MINT_URL = "https://mint.example";
const REFUND_LOCKTIME = 1_780_000_000;
const KEYSET_B = canonicalKeysetId(2);
const KEYSET_C = canonicalKeysetId(3);
const WALLET_ID = "ab".repeat(32);
const ORIGINAL_LOCKS = Object.getOwnPropertyDescriptor(navigator, "locks");

function proof(id: string, secret: string, amount = 100): Proof {
  return {
    id,
    amount: Amount.from(amount),
    secret,
    C: canonicalSecpPoint(1),
  };
}

function storedProof(
  value: Proof,
  outcomeCollection: string,
  reservedBy?: string,
): StoredProofRow {
  return prepareStoredProofForWrite(
    {
      ...value,
      mintUrl: MINT_URL,
      unit: "msat",
      baseAsset: "sat",
      conditionId: "condition-1",
      outcomeCollection,
      marketId: `condition-1-${outcomeCollection}`,
      ...(reservedBy ? { reservedBy } : {}),
    },
    1,
    WALLET_ID,
  );
}

function fixture() {
  const spentB = proof(KEYSET_B, "spent-B");
  const spentC = proof(KEYSET_C, "spent-C");
  const lockedB = proof(KEYSET_B, "locked-B");
  const lockedC = proof(KEYSET_C, "locked-C");
  const changeB = proof(KEYSET_B, "change-B", 20);
  const record: GuiPartialLockFailureRecord = {
    kind: "PartialLockHeld",
    tradeId: TRADE_ID,
    orderId: "order-partial-lock",
    mintUrl: MINT_URL,
    refundLocktime: REFUND_LOCKTIME,
    affectedKeysets: [KEYSET_B, KEYSET_C],
    detail: "second outcome lock failed",
    outcomeByKeyset: {
      [KEYSET_B]: {
        conditionId: "condition-1",
        outcomeCollection: "B",
        marketId: "condition-1-B",
      },
      [KEYSET_C]: {
        conditionId: "condition-1",
        outcomeCollection: "C",
        marketId: "condition-1-C",
      },
    },
    lockedProofs: [lockedB, lockedC],
    createdAt: 1_780_000_001_000,
  };
  return {
    spentProofs: [spentB, spentC],
    storedInputs: [
      storedProof(spentB, "B", TRADE_ID),
      storedProof(spentC, "C", TRADE_ID),
    ],
    replacementProofs: [
      storedProof(lockedB, "B", TRADE_ID),
      storedProof(lockedC, "C", TRADE_ID),
      storedProof(changeB, "B"),
    ],
    record,
  };
}

describe("partial-lock Dexie authority", () => {
  beforeEach(async () => {
    configureGuiWalletIdProvider(() => WALLET_ID);
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
    await db.delete();
    await db.open();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (ORIGINAL_LOCKS) {
      Object.defineProperty(navigator, "locks", ORIGINAL_LOCKS);
    }
    await db.delete();
  });

  it("commits proofs and refund authority atomically and restores them after restart", async () => {
    const input = fixture();
    await db.proofs.put(input.storedInputs[1]!);

    await commitPartialLock(input);

    expect(await storedRow(input.spentProofs[1]!.secret)).toBeUndefined();
    expect(await storedRow("locked-B")).toMatchObject({
      reservedBy: TRADE_ID,
      outcomeCollection: "B",
    });
    const change = await storedRow("change-B");
    expect(change).toMatchObject({ outcomeCollection: "B" });
    expect(change?.reservedBy).toBeUndefined();
    expect(
      await listElapsedGuiPartialLockFailures(REFUND_LOCKTIME),
    ).toHaveLength(1);

    db.close();
    const restarted = new BitcasterDB();
    await restarted.open();
    try {
      expect(await getGuiPartialLockFailure(TRADE_ID, restarted)).toEqual(
        expect.objectContaining({
          tradeId: TRADE_ID,
          affectedKeysets: [KEYSET_B, KEYSET_C],
        }),
      );
      expect(await storedRow("locked-C", restarted)).toMatchObject({
        reservedBy: TRADE_ID,
        unit: "msat",
      });
    } finally {
      restarted.close();
    }
  });

  it("rolls back proof mutations when the refund marker write fails", async () => {
    const input = fixture();
    await db.proofs.bulkPut(input.storedInputs);
    vi.spyOn(db.partialLockFailures, "put").mockImplementationOnce(() => {
      throw new Error("injected refund-marker failure");
    });

    await expect(commitPartialLock(input)).rejects.toThrow(
      "injected refund-marker failure",
    );

    expect(await storedRow("spent-B")).toMatchObject({
      reservedBy: TRADE_ID,
    });
    expect(await storedRow("spent-C")).toMatchObject({
      reservedBy: TRADE_ID,
    });
    expect(await storedRow("locked-B")).toBeUndefined();
    expect(
      await db.partialLockFailures.get([WALLET_ID, TRADE_ID]),
    ).toBeUndefined();
  });

  it("rejects a proof currently owned by another trade without changing authority", async () => {
    const input = fixture();
    await db.proofs.bulkPut([
      input.storedInputs[0]!,
      { ...input.storedInputs[1]!, reservedBy: "foreign-trade" },
    ]);

    await expect(commitPartialLock(input)).rejects.toThrow(
      "not owned by the exact trade",
    );

    expect(await storedRow("spent-C")).toMatchObject({
      reservedBy: "foreign-trade",
    });
    expect(await storedRow("locked-C")).toBeUndefined();
    expect(
      await db.partialLockFailures.get([WALLET_ID, TRADE_ID]),
    ).toBeUndefined();
  });
});

async function commitPartialLock(
  input: ReturnType<typeof fixture>,
): Promise<GuiPartialLockFailureRecord> {
  return withGuiWalletLock(
    WALLET_ID,
    () => WALLET_ID,
    (lock) => commitGuiPartialLockFailureUnderLock(lock, input),
  );
}

async function storedRow(secret: string, database: BitcasterDB = db) {
  return (await database.proofs.toArray()).find(
    (proof) => proof.secret === secret,
  );
}
