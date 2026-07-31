import { beforeEach, describe, expect, it, vi } from "vitest";
import { Amount } from "@cashu/cashu-ts";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";

// Mock Dexie before importing the module under test — we don't need a real
// IndexedDB (no polyfill installed in the jsdom harness), just an object
// that records what addProofs wrote so we can assert normalization.
type AnyProof = {
  secret: string;
  mintUrl: string;
  amount: unknown;
  id?: string;
  C?: string;
  receivedAt?: number;
  reservedBy?: string;
  conditionId?: string;
  condition_id?: string;
  outcomeCollection?: string;
  outcome_collection?: string;
  baseAsset?: string;
  unit?: string;
  operationId?: string;
};

const store = new Map<string, AnyProof>();
const txCallbacks: Array<() => Promise<void>> = [];

vi.mock("dexie", () => {
  class FakeTable {
    async bulkPut(rows: AnyProof[]): Promise<void> {
      for (const r of rows) store.set(r.secret ?? r.operationId ?? "", r);
    }
    async bulkDelete(keys: string[]): Promise<void> {
      for (const k of keys) store.delete(k);
    }
    async bulkGet(keys: string[]): Promise<Array<AnyProof | undefined>> {
      return keys.map((key) => store.get(key));
    }
    async get(key: string): Promise<AnyProof | undefined> {
      return store.get(key);
    }
    async toArray(): Promise<AnyProof[]> {
      return Array.from(store.values());
    }
    filter(predicate: (row: AnyProof) => boolean) {
      return {
        toArray: async () => Array.from(store.values()).filter(predicate),
      };
    }
    where(field: string) {
      return {
        equals: (v: string | [string, string, string]) => ({
          toArray: async () =>
            Array.from(store.values()).filter((r) => {
              if (field === "mintUrl") return r.mintUrl === v;
              if (field === "[mintUrl+conditionId+outcomeCollection]") {
                const [mintUrl, conditionId, outcomeCollection] = v as [string, string, string];
                return (
                  r.mintUrl === mintUrl &&
                  r.conditionId === conditionId &&
                  r.outcomeCollection === outcomeCollection
                );
              }
              return false;
            }),
        }),
      };
    }
    async put(row: AnyProof): Promise<void> {
      store.set(row.secret ?? row.operationId ?? "", row);
    }
  }

  class FakeDexie {
    constructor(_name: string) {}
    // Real Dexie assigns tables onto the instance as a side-effect of
    // `.stores()`, which runs AFTER the subclass's field initializers
    // have zeroed the slots with `!:` declarations. Mirror that lazy
    // assignment so `this.proofs` isn't clobbered to undefined.
    version(_v: number) {
      const self = this as unknown as Record<string, FakeTable>;
      return {
        stores: (schema: Record<string, string>) => {
          for (const name of Object.keys(schema)) {
            if (!self[name]) self[name] = new FakeTable();
          }
          return self;
        },
      };
    }
    async transaction(_mode: string, _table: unknown, cb: () => Promise<void>): Promise<void> {
      txCallbacks.push(cb);
      await cb();
    }
  }

  return { default: FakeDexie };
});

// Import after mock so the module picks up the fake.
import {
  addProofs,
  getBaseProofs,
  getConditionCtfProofs,
  getOutcomeProofs,
  getProofs,
  getUnitProofs,
  getReservedProofs,
  normalizeStoredMintUrls,
  getProofOperation,
  markProofOperationCompleted,
  prepareProofOperation,
  releaseProofReservation,
  releaseProofReservationsBySecret,
  reserveProofs,
  selectAndReserveUnitProofs,
} from "../proof-db";

beforeEach(() => {
  store.clear();
  txCallbacks.length = 0;
});

describe("proof-db normalization", () => {
  it("normalizes trailing slash on write", async () => {
    await addProofs([
      {
        secret: "s1",
        amount: Amount.from(100),
        id: "id1",
        C: "C1",
        mintUrl: "http://mint.example/",
        baseAsset: "sat",
        unit: "sat",
      },
    ]);
    const rows = await getProofs("http://mint.example");
    expect(rows).toHaveLength(1);
    expect(rows[0].mintUrl).toBe("http://mint.example");
  });

  it("normalizes Cashu Amount values to numbers on write", async () => {
    await addProofs([
      {
        secret: "s1",
        amount: Amount.from(100),
        id: "id1",
        C: "C1",
        mintUrl: "http://mint.example",
        baseAsset: "sat",
        unit: "sat",
      },
      {
        secret: "s2",
        amount: { value: 110n },
        id: "id2",
        C: "C2",
        mintUrl: "http://mint.example",
        baseAsset: "sat",
        unit: "sat",
      } as never,
    ]);

    const rows = await getProofs("http://mint.example");

    expect(rows.map((proof) => amountToNumber(proof.amount))).toEqual([100, 110]);
    expect(Array.from(store.values()).map((proof) => proof.amount)).toEqual([100, 110]);
  });

  it("getProofs also normalizes the query argument", async () => {
    await addProofs([
      {
        secret: "s1",
        amount: Amount.from(100),
        id: "id1",
        C: "C1",
        mintUrl: "http://mint.example",
        baseAsset: "sat",
        unit: "sat",
      },
    ]);
    const rows = await getProofs("http://mint.example//");
    expect(rows).toHaveLength(1);
  });

  it("migration rewrites pre-existing un-normalized rows", async () => {
    // Seed directly so we bypass the write-time normalizer.
    store.set("legacy", {
      secret: "legacy",
      amount: Amount.from(500),
      id: "idL",
      C: "CL",
      mintUrl: "https://mint.staging//",
      baseAsset: "sat",
      unit: "sat",
    });
    const changed = await normalizeStoredMintUrls();
    expect(changed).toBe(1);
    const rows = await getProofs("https://mint.staging");
    expect(rows).toHaveLength(1);
  });

  it("migration is a no-op when all rows are already normalized", async () => {
    await addProofs([
      {
        secret: "s1",
        amount: Amount.from(100),
        id: "id1",
        C: "C1",
        mintUrl: "http://m",
        baseAsset: "sat",
        unit: "sat",
      },
    ]);
    const changed = await normalizeStoredMintUrls();
    expect(changed).toBe(0);
  });

  it("getBaseProofs excludes CTF proofs from spendable ecash balances", async () => {
    await addProofs([
      {
        secret: "base",
        amount: Amount.from(100),
        id: "id1",
        C: "C1",
        mintUrl: "http://m",
        baseAsset: "sat",
        unit: "sat",
      },
      {
        secret: "ctf",
        amount: Amount.from(200),
        id: "id2",
        C: "C2",
        mintUrl: "http://m",
        conditionId: "cond-yes",
        baseAsset: "sat",
        unit: "msat",
      } as never,
    ]);

    const rows = await getBaseProofs("http://m", { baseAsset: "sat" });

    expect(rows.map((r) => r.secret)).toEqual(["base"]);
  });

  it("getUnitProofs filters exact sat and msat units while getBaseProofs groups both for display", async () => {
    await addProofs([
      {
        secret: "sat-proof",
        amount: Amount.from(100),
        id: "id1",
        C: "C1",
        mintUrl: "http://m",
        baseAsset: "sat",
        unit: "sat",
      },
      {
        secret: "msat-proof",
        amount: Amount.from(200),
        id: "id2",
        C: "C2",
        mintUrl: "http://m",
        baseAsset: "sat",
        unit: "msat",
      },
    ]);

    expect((await getUnitProofs("http://m", { unit: "msat" })).map((r) => r.secret)).toEqual([
      "msat-proof",
    ]);
    expect((await getUnitProofs("http://m", { unit: "sat" })).map((r) => r.secret)).toEqual([
      "sat-proof",
    ]);
    expect((await getBaseProofs("http://m", { baseAsset: "sat" })).map((r) => r.secret)).toEqual([
      "sat-proof",
      "msat-proof",
    ]);
  });

  it("getUnitProofs excludes legacy rows without an explicit unit", async () => {
    store.set("legacy-sat", {
      secret: "legacy-sat",
      amount: Amount.from(100),
      id: "id1",
      C: "C1",
      mintUrl: "http://m",
      baseAsset: "sat",
    });
    await addProofs([
      {
        secret: "msat-proof",
        amount: Amount.from(200),
        id: "id2",
        C: "C2",
        mintUrl: "http://m",
        baseAsset: "sat",
        unit: "msat",
      },
    ]);

    expect((await getUnitProofs("http://m", { unit: "msat" })).map((r) => r.secret)).toEqual([
      "msat-proof",
    ]);
    expect((await getUnitProofs("http://m", { unit: "sat" })).map((r) => r.secret)).toEqual([]);
    expect((await getBaseProofs("http://m", { baseAsset: "sat" })).map((r) => r.secret)).toEqual([
      "legacy-sat",
      "msat-proof",
    ]);
  });

  it("requires an exact unit on every new proof write", async () => {
    await expect(
      addProofs([
        {
          secret: "missing-unit",
          amount: Amount.from(1),
          id: "id1",
          C: "C1",
          mintUrl: "http://m",
          baseAsset: "sat",
        },
      ]),
    ).rejects.toThrow("Stored proof unit is required");
  });

  it("rejects sat-unit CTF writes and excludes malformed legacy CTF rows", async () => {
    const malformed = {
      secret: "legacy-ctf-sat",
      amount: Amount.from(100),
      id: "conditional-id",
      C: "C1",
      mintUrl: "http://m",
      conditionId: "cond",
      outcomeCollection: "YES",
      baseAsset: "sat",
      unit: "sat",
    } as const;
    await expect(addProofs([malformed])).rejects.toThrow(
      "CTF proofs require exact Cashu unit 'msat'",
    );

    store.set(malformed.secret, malformed);
    await expect(getConditionCtfProofs("http://m", "cond", { baseAsset: "sat" })).resolves.toEqual(
      [],
    );
    await expect(
      getOutcomeProofs("http://m", "cond", "YES", { baseAsset: "sat" }),
    ).resolves.toEqual([]);
  });

  it("rejects mismatched base asset and unit on write", async () => {
    await expect(
      addProofs([
        {
          secret: "bad",
          amount: Amount.from(100),
          id: "id1",
          C: "C1",
          mintUrl: "http://m",
          baseAsset: "sat",
          unit: "usd" as never,
        },
      ]),
    ).rejects.toThrow("Unsupported Cashu proof unit 'usd'");
  });

  it("rejects an unsupported explicit proof unit before persistence", async () => {
    await expect(
      addProofs([
        {
          secret: "usd-without-base",
          amount: Amount.from(100),
          id: "id1",
          C: "C1",
          mintUrl: "http://m",
          unit: "usd" as never,
        },
      ]),
    ).rejects.toThrow(/unsupported Cashu proof unit/i);
  });

  it("getOutcomeProofs returns only the requested condition outcome", async () => {
    await addProofs([
      {
        secret: "yes",
        amount: Amount.from(100),
        id: "id1",
        C: "C1",
        mintUrl: "http://m",
        conditionId: "cond",
        outcomeCollection: "YES",
        baseAsset: "sat",
        unit: "msat",
      },
      {
        secret: "no",
        amount: Amount.from(100),
        id: "id2",
        C: "C2",
        mintUrl: "http://m",
        condition_id: "cond",
        outcome_collection: "NO",
        baseAsset: "sat",
        unit: "msat",
      } as never,
      {
        secret: "base",
        amount: Amount.from(100),
        id: "id3",
        C: "C3",
        mintUrl: "http://m",
        baseAsset: "sat",
        unit: "sat",
      },
    ]);

    const rows = await getOutcomeProofs("http://m", "cond", "YES", { baseAsset: "sat" });

    expect(rows.map((r) => r.secret)).toEqual(["yes"]);
  });

  it("getConditionCtfProofs gathers every keyset leg regardless of label storage", async () => {
    await addProofs([
      // composite-label storage: both keysets tagged "A|B"
      {
        secret: "compA",
        amount: Amount.from(100),
        id: "keyset-A",
        C: "C1",
        mintUrl: "http://m",
        conditionId: "cond",
        outcomeCollection: "A|B",
        baseAsset: "sat",
        unit: "msat",
      },
      {
        secret: "compB",
        amount: Amount.from(100),
        id: "keyset-B",
        C: "C2",
        mintUrl: "http://m",
        conditionId: "cond",
        outcomeCollection: "A|B",
        baseAsset: "sat",
        unit: "msat",
      },
      // per-primitive storage variant under condition_id snake-case key
      {
        secret: "primC",
        amount: Amount.from(100),
        id: "keyset-C",
        C: "C3",
        mintUrl: "http://m",
        condition_id: "cond",
        outcome_collection: "C",
        baseAsset: "sat",
        unit: "msat",
      } as never,
      // different condition — must be excluded
      {
        secret: "other",
        amount: Amount.from(100),
        id: "keyset-A",
        C: "C4",
        mintUrl: "http://m",
        conditionId: "cond2",
        outcomeCollection: "A",
        baseAsset: "sat",
        unit: "msat",
      },
      // base (non-CTF) proof — must be excluded
      {
        secret: "base",
        amount: Amount.from(100),
        id: "id5",
        C: "C5",
        mintUrl: "http://m",
        baseAsset: "sat",
        unit: "sat",
      },
    ]);

    const rows = await getConditionCtfProofs("http://m", "cond", { baseAsset: "sat" });

    expect(rows.map((r) => r.secret).sort()).toEqual(["compA", "compB", "primC"]);
    // Bucketing by real keyset id recovers all three legs.
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(["keyset-A", "keyset-B", "keyset-C"]));
  });

  it("hides reserved proofs from spendable base and outcome queries", async () => {
    await addProofs([
      {
        secret: "base-free",
        amount: Amount.from(100),
        id: "id1",
        C: "C1",
        mintUrl: "http://m",
        baseAsset: "sat",
        unit: "sat",
      },
      {
        secret: "base-reserved",
        amount: Amount.from(100),
        id: "id2",
        C: "C2",
        mintUrl: "http://m",
        baseAsset: "sat",
        unit: "sat",
      },
      {
        secret: "yes-free",
        amount: Amount.from(100),
        id: "id3",
        C: "C3",
        mintUrl: "http://m",
        conditionId: "cond",
        outcomeCollection: "YES",
        baseAsset: "sat",
        unit: "msat",
      },
      {
        secret: "yes-reserved",
        amount: Amount.from(100),
        id: "id4",
        C: "C4",
        mintUrl: "http://m",
        conditionId: "cond",
        outcomeCollection: "YES",
        baseAsset: "sat",
        unit: "msat",
      },
    ]);
    await reserveProofs(["base-reserved", "yes-reserved"], "order-1");

    expect((await getBaseProofs("http://m", { baseAsset: "sat" })).map((r) => r.secret)).toEqual([
      "base-free",
    ]);
    expect(
      (await getOutcomeProofs("http://m", "cond", "YES", { baseAsset: "sat" })).map(
        (r) => r.secret,
      ),
    ).toEqual(["yes-free"]);
    expect((await getReservedProofs("order-1")).map((r) => r.secret)).toEqual([
      "base-reserved",
      "yes-reserved",
    ]);
  });

  it("releases reserved proofs by owner or selected secret", async () => {
    await addProofs([
      {
        secret: "s1",
        amount: Amount.from(100),
        id: "id1",
        C: "C1",
        mintUrl: "http://m",
        baseAsset: "sat",
        unit: "sat",
      },
      {
        secret: "s2",
        amount: Amount.from(100),
        id: "id2",
        C: "C2",
        mintUrl: "http://m",
        baseAsset: "sat",
        unit: "sat",
      },
    ]);
    await reserveProofs(["s1", "s2"], "order-1");
    await releaseProofReservationsBySecret(["s1"]);

    expect((await getProofs("http://m")).map((r) => r.secret)).toEqual(["s1"]);

    await releaseProofReservation("order-1");
    expect((await getProofs("http://m")).map((r) => r.secret)).toEqual(["s1", "s2"]);
  });

  it("selects spendable unit proofs and reserves them in one transaction", async () => {
    await addProofs([
      {
        secret: "s1",
        amount: Amount.from(60),
        id: "id1",
        C: "C1",
        mintUrl: "http://m",
        baseAsset: "sat",
        unit: "msat",
      },
      {
        secret: "s2",
        amount: Amount.from(50),
        id: "id2",
        C: "C2",
        mintUrl: "http://m",
        baseAsset: "sat",
        unit: "msat",
      },
      {
        secret: "s3",
        amount: Amount.from(100),
        id: "id3",
        C: "C3",
        mintUrl: "http://m",
        baseAsset: "sat",
        unit: "sat",
      },
      {
        secret: "ctf",
        amount: Amount.from(100),
        id: "id4",
        C: "C4",
        mintUrl: "http://m",
        baseAsset: "sat",
        unit: "msat",
        conditionId: "cond",
      },
    ]);

    const selected = await selectAndReserveUnitProofs("http://m/", { unit: "msat" }, "pay-1");

    expect(txCallbacks).toHaveLength(1);
    expect(selected.map((proof) => proof.secret)).toEqual(["s1", "s2"]);
    expect((await getReservedProofs("pay-1")).map((proof) => proof.secret)).toEqual(["s1", "s2"]);
    expect(
      (await getUnitProofs("http://m", { unit: "msat" })).map((proof) => proof.secret),
    ).toEqual([]);
  });

  it("fails atomic unit proof selection when the selected proofs cannot satisfy the requested amount", async () => {
    await addProofs([
      {
        secret: "reserved",
        amount: Amount.from(60),
        id: "id1",
        C: "C1",
        mintUrl: "http://m",
        baseAsset: "sat",
        unit: "msat",
      },
      {
        secret: "free",
        amount: Amount.from(20),
        id: "id2",
        C: "C2",
        mintUrl: "http://m",
        baseAsset: "sat",
        unit: "msat",
      },
    ]);
    await reserveProofs(["reserved"], "other-flow");

    await expect(
      selectAndReserveUnitProofs("http://m", { unit: "msat", minimumAmount: 50 }, "pay-1"),
    ).rejects.toThrow("Insufficient spendable proofs");
    expect(await getReservedProofs("pay-1")).toEqual([]);
  });

  it("persists SDK-supplied CTF completion fields verbatim", async () => {
    await prepareProofOperation({
      operationId: "ctf-split:1",
      kind: "ctf-split",
      mintUrl: "https://mint.example/",
      inputs: [],
      outputs: {},
      metadata: { unit: "msat" },
    });
    const resultProofs = {
      YES: [{ secret: "yes", amount: Amount.from(100), id: "keyset-yes", C: "02aa" }],
      NO: [{ secret: "no", amount: Amount.from(100), id: "keyset-no", C: "02bb" }],
    };

    const suppliedDigest = "ab".repeat(32);
    const completed = await markProofOperationCompleted("ctf-split:1", {
      kind: "ctf-split",
      resultProofs,
      resultProofsDigest: suppliedDigest,
    });

    expect(completed.resultProofsDigest).toBe(suppliedDigest);
    expect((await getProofOperation("ctf-split:1"))?.resultProofsDigest).toBe(suppliedDigest);
    await expect(
      markProofOperationCompleted("ctf-split:1", {
        kind: "ctf-merge",
        resultProofs,
        resultProofsDigest: suppliedDigest,
      }),
    ).rejects.toThrow("does not match completion");
  });

  it("does not attach a CTF authority digest to ordinary proof operations", async () => {
    await prepareProofOperation({
      operationId: "token-receive:1",
      kind: "token-receive",
      mintUrl: "https://mint.example",
      inputs: [],
      outputs: {},
      metadata: { unit: "sat" },
    });

    const completed = await markProofOperationCompleted("token-receive:1", {
      receive: [{ secret: "received", amount: Amount.from(1), id: "keyset", C: "02cc" }],
    });

    expect(completed.resultProofsDigest).toBeUndefined();
  });
});
