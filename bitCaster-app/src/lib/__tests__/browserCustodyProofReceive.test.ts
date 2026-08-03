// @vitest-environment node
import "fake-indexeddb/auto";
import { OutputData, type Wallet as CashuWallet } from "@cashu/cashu-ts";
import { afterEach, describe, expect, it } from "vitest";
import { BitcasterDB, type StoredProof } from "../../stores/proof-db";
import { admitBrowserReceivedProofs } from "../browserCustodyProofReceive";

const KEYSET_ID = `00${"11".repeat(7)}`;
const PUBLIC_KEY = `02${"22".repeat(32)}`;
const MODERN_KEYSET_ID = `01${"33".repeat(32)}`;
const MODERN_SEED = Uint8Array.from({ length: 64 }, (_, index) => index + 1);

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
      derivationAuthority: null,
      database,
      lockManager: immediateLockManager(),
      now: () => 10,
      randomId: () => "test",
    };

    await admitBrowserReceivedProofs(input);
    await admitBrowserReceivedProofs(input);

    expect(await database.custodyProofs.count()).toBe(130);
    expect(await database.custodyProofBackupAuthorities.count()).toBe(130);
    expect((await database.custodyProofBackupAuthorities.toArray())[0]).toMatchObject({
      derivationKeysetId: null,
      derivationCounter: null,
    });
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

  it("maps a reordered subset from the verified modern range to exact counters", async () => {
    database = new BitcasterDB(`proof-receive-modern-${crypto.randomUUID()}`);
    const rangeProofs = [modernProof(0), modernProof(1), modernProof(2)];
    await admitBrowserReceivedProofs({
      seed: MODERN_SEED,
      sourceOperationId: "receive:modern",
      mintUrl: "https://mint.example",
      unit: "sat",
      wallet: wallet(MODERN_KEYSET_ID),
      proofs: [rangeProofs[2], rangeProofs[0]],
      derivationRangeProofs: rangeProofs,
      derivationAuthority: { keysetId: MODERN_KEYSET_ID, counterStart: 0, counterCount: 3 },
      database,
      lockManager: immediateLockManager(),
      now: () => 10,
    });

    expect(
      (await database.custodyProofBackupAuthorities.toArray())
        .map((row) => row.derivationCounter)
        .sort(),
    ).toEqual([0, 2]);
  });

  it("keeps a verified legacy receive locally when it has a persisted counter authority", async () => {
    database = new BitcasterDB(`proof-receive-legacy-${crypto.randomUUID()}`);
    await admitBrowserReceivedProofs({
      seed: new Uint8Array(32).fill(7),
      sourceOperationId: "receive:legacy",
      mintUrl: "https://mint.example",
      unit: "sat",
      wallet: wallet(),
      proofs: [proof(0)],
      derivationAuthority: { keysetId: KEYSET_ID, counterStart: 4, counterCount: 1 },
      database,
      lockManager: immediateLockManager(),
      now: () => 10,
    });

    expect((await database.custodyProofBackupAuthorities.toArray())[0]).toMatchObject({
      derivationKeysetId: null,
      derivationCounter: null,
    });
  });

  it.each([
    { counterStart: 0, counterCount: 1 },
    { counterStart: 2_147_483_647, counterCount: 2 },
  ])("rejects an invalid modern range before mutation", async (derivationAuthority) => {
    database = new BitcasterDB(`proof-receive-invalid-${crypto.randomUUID()}`);

    await expect(
      admitBrowserReceivedProofs({
        seed: MODERN_SEED,
        sourceOperationId: "receive:invalid",
        mintUrl: "https://mint.example",
        unit: "sat",
        wallet: wallet(MODERN_KEYSET_ID),
        proofs: [modernProof(0), modernProof(1)],
        derivationAuthority: { keysetId: MODERN_KEYSET_ID, ...derivationAuthority },
        database,
        lockManager: immediateLockManager(),
      }),
    ).rejects.toThrow(/derivation keyset/);
    expect(await database.custodyProofs.count()).toBe(0);
    expect(await database.custodyProofBackupAuthorities.count()).toBe(0);
  });

  it("rejects a noncanonical modern-looking derivation keyset", async () => {
    database = new BitcasterDB(`proof-receive-uppercase-${crypto.randomUUID()}`);
    const noncanonicalKeysetId = `01${"AA".repeat(32)}`;
    await expect(
      admitBrowserReceivedProofs({
        seed: MODERN_SEED,
        sourceOperationId: "receive:uppercase",
        mintUrl: "https://mint.example",
        unit: "sat",
        wallet: wallet(noncanonicalKeysetId),
        proofs: [{ ...modernProof(0), id: noncanonicalKeysetId }],
        derivationAuthority: { keysetId: noncanonicalKeysetId, counterStart: 0, counterCount: 1 },
        database,
        lockManager: immediateLockManager(),
      }),
    ).rejects.toThrow(/derivation keyset/);
    expect(await database.custodyProofs.count()).toBe(0);
  });

  it("rejects conditional metadata that conflicts with a verified regular keyset", async () => {
    database = new BitcasterDB(`proof-receive-asset-${crypto.randomUUID()}`);
    await expect(
      admitBrowserReceivedProofs({
        seed: new Uint8Array(32).fill(7),
        sourceOperationId: "receive:asset",
        mintUrl: "https://mint.example",
        unit: "sat",
        wallet: wallet(),
        proofs: [{ ...proof(0), conditionId: "aa".repeat(32), outcomeCollection: "YES" }],
        derivationAuthority: null,
        database,
        lockManager: immediateLockManager(),
      }),
    ).rejects.toThrow(/metadata conflicts/);
    expect(await database.custodyProofs.count()).toBe(0);
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

function modernProof(counter: number): StoredProof {
  return {
    ...proof(counter),
    id: MODERN_KEYSET_ID,
    secret: new TextDecoder().decode(
      OutputData.createSingleDeterministicData(1, MODERN_SEED, counter, MODERN_KEYSET_ID).secret,
    ),
  };
}

function wallet(keysetId = KEYSET_ID): CashuWallet {
  return {
    getKeyset: () => ({
      id: keysetId,
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
