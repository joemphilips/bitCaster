import { beforeEach, describe, expect, it, vi } from "vitest";
import { Amount, MintOperationError } from "@cashu/cashu-ts";
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
  terminalOperationId?: string;
  conditionId?: string;
  condition_id?: string;
  outcomeCollection?: string;
  outcome_collection?: string;
  baseAsset?: string;
  unit?: string;
  operationId?: string;
};

const store = new Map<string, AnyProof>();
vi.mock("@/lib/browserWalletProfile", () => ({
  browserWalletDatabaseName: () => "bitcaster-wallet-test",
}));

vi.mock("dexie", () => {
  class FakeTable {
    async bulkAdd(rows: AnyProof[]): Promise<void> {
      for (const row of rows) {
        const key = row.secret ?? row.operationId ?? "";
        if (store.has(key)) throw new Error("duplicate key");
        store.set(key, row);
      }
    }
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
    where(field: string) {
      const conditionPrefix = (value: string[]) =>
        Array.from(store.values()).filter(
          (row) => row.mintUrl === value[0] && row.conditionId === value[1],
        );
      return {
        equals: (v: string | string[]) => {
          const matching = () =>
            Array.from(store.values()).filter((r) => {
              if (field === "mintUrl") return r.mintUrl === v;
              if (field === "[mintUrl+conditionId+outcomeCollection]") {
                const [mintUrl, conditionId, outcomeCollection] = v as string[];
                return (
                  r.mintUrl === mintUrl &&
                  r.conditionId === conditionId &&
                  r.outcomeCollection === outcomeCollection
                );
              }
              if (field === "[mintUrl+unit+id]") {
                const [mintUrl, unit, id] = v as string[];
                return r.mintUrl === mintUrl && r.unit === unit && r.id === id;
              }
              return false;
            });
          return {
            toArray: async () => matching(),
            each: async (callback: (row: AnyProof) => void) => {
              for (const row of matching()) callback(row);
            },
          };
        },
        between: (lower: string[]) => ({
          toArray: async () =>
            field === "[mintUrl+conditionId+outcomeCollection]" ? conditionPrefix(lower) : [],
        }),
      };
    }
    async put(row: AnyProof): Promise<void> {
      store.set(row.secret ?? row.operationId ?? "", row);
    }
  }

  class FakeDexie {
    constructor(_name: string) {}
    table(name: string): FakeTable {
      const self = this as unknown as Record<string, FakeTable>;
      return (self[name] ??= new FakeTable());
    }
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
          return {
            upgrade: (_callback: unknown) => undefined,
          };
        },
      };
    }
    async transaction(_mode: string, _table: unknown, cb: () => Promise<void>): Promise<void> {
      await cb();
    }
  }

  return { default: FakeDexie };
});

// Import after mock so the module picks up the fake.
import {
  addProofs,
  addProofsIfMissing,
  getProofs,
  getProofOperation,
  markProofOperationCompleted,
  markProofOperationFailed,
  prepareProofOperation,
} from "../proof-db";

beforeEach(() => {
  store.clear();
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

  it("rejects sat-unit CTF writes", async () => {
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

  it("preserves terminal authority when a losing CTF proof is re-imported", async () => {
    const proof = {
      secret: "terminal",
      amount: Amount.from(100),
      id: "id-terminal",
      C: "C-terminal",
      mintUrl: "http://m",
      conditionId: "cond",
      outcomeCollection: "YES",
      baseAsset: "sat",
      unit: "msat" as const,
    };
    await addProofs([{ ...proof, terminalOperationId: "ctf-redeem:terminal" }]);
    await addProofs([proof]);

    await expect(getProofs("http://m")).resolves.toEqual([]);
    expect(store.get(proof.secret)?.terminalOperationId).toBe("ctf-redeem:terminal");
  });

  it("does not overwrite a live reservation during compatibility-cache repair", async () => {
    const proof = {
      secret: "locked",
      amount: Amount.from(100),
      id: "id-locked",
      C: "C-locked",
      mintUrl: "http://m",
      baseAsset: "sat",
      unit: "msat" as const,
    };
    await addProofs([{ ...proof, reservedBy: "order-1" }]);

    await addProofsIfMissing([proof]);

    expect(store.get(proof.secret)?.reservedBy).toBe("order-1");
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

  it("rejects generic terminal classification for a CTF redeem", async () => {
    await prepareProofOperation({
      operationId: "ctf-redeem:terminal",
      kind: "ctf-redeem",
      mintUrl: "https://mint.example",
      inputs: [],
      outputs: {},
      metadata: { unit: "msat" },
    });

    await expect(
      markProofOperationFailed(
        "ctf-redeem:terminal",
        new MintOperationError(13015, "oracle not attested"),
      ),
    ).rejects.toThrow("requires authenticated mint evidence");
    expect((await getProofOperation("ctf-redeem:terminal"))?.state).toBe("prepared");
  });
});
