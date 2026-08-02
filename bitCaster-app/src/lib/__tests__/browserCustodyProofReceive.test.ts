// @vitest-environment node
import "fake-indexeddb/auto";
import type { Wallet as CashuWallet } from "@cashu/cashu-ts";
import { afterEach, describe, expect, it } from "vitest";
import { BitcasterDB, type StoredProof } from "../../stores/proof-db";
import { admitBrowserReceivedProofs } from "../browserCustodyProofReceive";

const KEYSET_ID = `00${"11".repeat(7)}`;
const PUBLIC_KEY = `02${"22".repeat(32)}`;

describe("browser custody proof receive", () => {
  let database: BitcasterDB | null = null;

  afterEach(async () => {
    database?.close();
    if (database) await indexedDB.deleteDatabase(database.name);
    database = null;
  });

  it("pages one verified receive and retries every page exactly", async () => {
    database = new BitcasterDB(`proof-receive-${crypto.randomUUID()}`);
    const proofs = Array.from({ length: 130 }, (_, index) => proof(index));
    const input = {
      seed: new Uint8Array(32).fill(7),
      sourceOperationId: "receive:large",
      mintUrl: "https://mint.example",
      unit: "sat" as const,
      wallet: wallet(),
      proofs,
      database,
      lockManager: immediateLockManager(),
      now: () => 10,
      randomId: () => "test",
    };

    await admitBrowserReceivedProofs(input);
    await admitBrowserReceivedProofs(input);

    expect(await database.custodyProofs.count()).toBe(130);
    expect(await database.custodyProofBackupAuthorities.count()).toBe(130);
    expect(await database.custodyOperations.count()).toBe(2);
    expect(
      (await database.custodyOperations.toArray())
        .map((row) =>
          row.record.operation.binding.kind === "wallet"
            ? row.record.operation.binding.activityId
            : null,
        )
        .sort(),
    ).toEqual(["receive:large", "receive:large:page:1"]);
  });
});

function proof(index: number): StoredProof {
  return {
    id: KEYSET_ID,
    amount: 1 as never,
    secret: `proof-secret-${index}`,
    C: PUBLIC_KEY,
    mintUrl: "https://mint.example",
    baseAsset: "sat",
    unit: "sat",
  };
}

function wallet(): CashuWallet {
  return {
    getKeyset: () => ({
      id: KEYSET_ID,
      unit: "sat",
      keys: { 1: PUBLIC_KEY },
      expiry: undefined,
      verify: () => true,
    }),
  } as unknown as CashuWallet;
}

function immediateLockManager(): Pick<LockManager, "request"> {
  const manager = {
    request: async (
      _name: string,
      _options: LockOptions,
      callback: (lock: Lock | null) => unknown,
    ) => callback(null),
  };
  return manager as unknown as Pick<LockManager, "request">;
}
