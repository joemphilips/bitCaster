import "fake-indexeddb/auto";
import { Amount } from "@cashu/cashu-ts";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BitcasterDB,
  addProofs,
  configureGuiWalletIdProvider,
  db,
  deriveStoredProofId,
  getBoundedUnitProofsForAmountUnderLock,
  getProofs,
  prepareStoredProofForWrite,
  releaseProofReservation,
  reserveProofs,
} from "../proof-db";
import { withGuiCustodyProfileLock } from "../gui-custody-authority";
import type { GuiWalletLockContext } from "../gui-wallet-lock";
import {
  canonicalKeysetId,
  canonicalSecpPoint,
} from "../../test/cashu-proof-fixtures";

const WALLET_A = "aa".repeat(32);
const WALLET_B = "bb".repeat(32);
const PROOF = {
  id: canonicalKeysetId(1),
  amount: Amount.from(1),
  secret: "proof-secret-must-remain-payload-only",
  C: canonicalSecpPoint(1),
  mintUrl: "https://mint.example",
  baseAsset: "sat",
  unit: "sat" as const,
};

describe("derived GUI proof identity schema", () => {
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

  it("uses only the derived proof id as the primary key and never indexes the bearer secret", () => {
    expect(db.proofs.schema.primKey.keyPath).toBe("proofId");
    expect(db.proofs.schema.indexes.map(({ name }) => name)).not.toContain(
      "secret",
    );
    expect(db.proofs.schema.indexes.map(({ name }) => name)).toContain(
      "[walletId+mintUrl+unit+proofClass+selectability+amount]",
    );
    expect(db.proofOperations.schema.primKey.keyPath).toEqual([
      "walletId",
      "operationId",
    ]);
  });

  it("selects high denominations through the bounded unit-and-amount index", async () => {
    await addProofs([
      proofWith("small", 1),
      proofWith("large", 64),
      ctfProofWith("ctf", 128),
      { ...proofWith("reserved", 256), reservedBy: "other-operation" },
    ]);

    const selected = await withLock((lock) =>
      getBoundedUnitProofsForAmountUnderLock(lock, "https://mint.example", {
        unit: "sat",
        minimumAmount: 64,
      }),
    );

    expect(selected.map(({ secret }) => secret)).toEqual(["large"]);
  });

  it("never selects more inputs than the durable operation limit", async () => {
    await addProofs(
      Array.from({ length: 257 }, (_, index) =>
        proofWith(`fragment-${String(index).padStart(3, "0")}`, 1),
      ),
    );

    const selected = await withLock((lock) =>
      getBoundedUnitProofsForAmountUnderLock(lock, "https://mint.example", {
        unit: "sat",
        minimumAmount: 257,
      }),
    );

    expect(selected).toHaveLength(256);
  });

  it("keeps derived selectability exact across reservation mutations", async () => {
    await addProofs([PROOF]);
    const [stored] = await getProofs();
    expect(stored).toMatchObject({
      proofClass: "regular",
      selectability: "spendable",
    });
    if (!stored?.proofId) throw new Error("Stored proof id is missing");
    const proofId = stored.proofId;

    await reserveProofs([stored], "operation-a");
    expect(await db.proofs.get(proofId)).toMatchObject({
      proofClass: "regular",
      selectability: "reserved",
    });

    await releaseProofReservation("operation-a");
    expect(await db.proofs.get(proofId)).toMatchObject({
      proofClass: "regular",
      selectability: "spendable",
    });
  });

  it("rejects a physically stored row whose proof id does not bind its payload", async () => {
    const valid = prepareStoredProofForWrite(PROOF, 1, WALLET_A);
    await db.proofs.put({ ...valid, proofId: "00".repeat(32) });

    await expect(getProofs()).rejects.toThrow(
      "Stored proof identity is invalid",
    );
  });

  it.each([{ proofClass: "ctf" }, { selectability: "reserved" }])(
    "rejects stale physical classification $proofClass$selectability",
    async (change) => {
      const valid = prepareStoredProofForWrite(PROOF, 1, WALLET_A);
      await db.proofs.put({ ...valid, ...change } as typeof valid);

      await expect(getProofs()).rejects.toThrow(
        "Stored proof classification is invalid",
      );
    },
  );

  it("rejects a physical row missing required durability metadata", async () => {
    const valid = prepareStoredProofForWrite(PROOF, 1, WALLET_A);
    const malformed = { ...valid } as Partial<typeof valid>;
    delete malformed.receivedAt;
    await db.proofs.put(malformed as typeof valid);

    await expect(getProofs()).rejects.toThrow(
      "Stored proof identity is invalid",
    );
  });

  it("rejects conflicting duplicate bearer authority instead of overwriting it", async () => {
    await addProofs([PROOF]);

    await expect(
      addProofs([{ ...PROOF, C: canonicalSecpPoint(2) }]),
    ).rejects.toThrow("Stored proof conflicts with existing authority");
    expect((await getProofs())[0]?.C).toBe(PROOF.C);
  });

  it.each([
    {
      name: "DLEQ",
      conflict: {
        dleq: {
          e: "11".repeat(32),
          s: "22".repeat(32),
          r: "33".repeat(32),
        },
      },
    },
    { name: "P2PK", conflict: { p2pk_e: canonicalSecpPoint(2) } },
    {
      name: "witness",
      conflict: {
        witness: JSON.stringify({ signatures: ["44".repeat(64)] }),
      },
    },
  ])("rejects conflicting duplicate $name authority", async ({ conflict }) => {
    await addProofs([PROOF]);

    await expect(addProofs([{ ...PROOF, ...conflict }])).rejects.toThrow(
      "Stored proof conflicts with existing authority",
    );
    expect(await getProofs()).toHaveLength(1);
  });

  it("rejects moving one bearer proof between seed-derived wallets", async () => {
    await addProofs([PROOF]);
    activeWalletId = WALLET_B;

    await expect(addProofs([PROOF])).rejects.toThrow(
      "Stored proof belongs to another wallet scope",
    );
  });

  it("derives stable identities from normalized mint, unit, keyset and secret", () => {
    const canonical = deriveStoredProofId(PROOF);
    expect(
      deriveStoredProofId({ ...PROOF, mintUrl: "HTTPS://MINT.EXAMPLE/" }),
    ).toBe(canonical);
    expect(canonical).not.toContain(PROOF.secret);
  });
});

function proofWith(secret: string, amount: number) {
  return {
    ...PROOF,
    amount: Amount.from(amount),
    secret,
  };
}

function ctfProofWith(secret: string, amount: number) {
  return withCtfMetadata(proofWith(secret, amount));
}

function withCtfMetadata<T extends ReturnType<typeof proofWith>>(proof: T) {
  return {
    ...proof,
    conditionId: "condition-a",
    outcomeCollection: "outcome-a",
    marketId: "condition-a-outcome-a",
  };
}

async function withLock<T>(
  action: (lock: GuiWalletLockContext) => Promise<T>,
): Promise<T> {
  return withGuiCustodyProfileLock((_context, lock) => action(lock));
}

describe("pre-release GUI custody cutover", () => {
  afterEach(async () => {
    await Dexie.delete("bitcaster");
  });

  it("deletes incompatible version-8 custody rows rather than guessing ownership", async () => {
    await Dexie.delete("bitcaster");
    const legacy = new Dexie("bitcaster");
    legacy.version(8).stores({
      proofs: "secret, mintUrl",
      proofOperations: "operationId",
      swapSessions: "tradeId",
      swapIntents: "tradeId",
    });
    await legacy.open();
    await Promise.all([
      legacy.table("proofs").put({ ...PROOF }),
      legacy.table("proofOperations").put({ operationId: "operation" }),
      legacy.table("swapSessions").put({ tradeId: "trade" }),
      legacy.table("swapIntents").put({ tradeId: "intent" }),
    ]);
    legacy.close();

    configureGuiWalletIdProvider(() => WALLET_A);
    const upgraded = new BitcasterDB();
    await upgraded.open();
    try {
      expect(await upgraded.proofs.count()).toBe(0);
      expect(await upgraded.proofOperations.count()).toBe(0);
      expect(await upgraded.swapSessions.count()).toBe(0);
      expect(await upgraded.swapIntents.count()).toBe(0);
      expect(upgraded.proofs.schema.primKey.keyPath).toBe("proofId");
    } finally {
      upgraded.close();
    }
  });

  it("also deletes a locally-created development version-9 proof table", async () => {
    await Dexie.delete("bitcaster");
    const developmentV9 = new Dexie("bitcaster");
    developmentV9.version(9).stores({
      proofs: "secret, walletId",
      proofOperations: "operationId, walletId",
      swapSessions: "tradeId, walletId",
      swapIntents: "tradeId, walletId",
    });
    await developmentV9.open();
    await developmentV9.table("proofs").put({ ...PROOF, walletId: WALLET_A });
    developmentV9.close();

    configureGuiWalletIdProvider(() => WALLET_A);
    const upgraded = new BitcasterDB();
    await upgraded.open();
    try {
      expect(await upgraded.proofs.count()).toBe(0);
      expect(upgraded.proofs.schema.primKey.keyPath).toBe("proofId");
    } finally {
      upgraded.close();
    }
  });

  it("resets the undeployed version-10 single-wallet operation key", async () => {
    await Dexie.delete("bitcaster");
    const developmentV10 = new Dexie("bitcaster");
    developmentV10.version(10).stores({
      proofOperations: "operationId, walletId",
    });
    await developmentV10.open();
    await developmentV10.table("proofOperations").put({
      operationId: "shared-operation",
      walletId: WALLET_A,
    });
    developmentV10.close();

    configureGuiWalletIdProvider(() => WALLET_A);
    const upgraded = new BitcasterDB();
    await upgraded.open();
    try {
      expect(await upgraded.proofOperations.count()).toBe(0);
      expect(upgraded.proofOperations.schema.primKey.keyPath).toEqual([
        "walletId",
        "operationId",
      ]);
    } finally {
      upgraded.close();
    }
  });
});
