import { beforeEach, describe, expect, it, vi } from "vitest";
import { Amount } from "@cashu/cashu-ts";
import { createDurableTradeProofOperationLink } from "@bitcaster/client-sdk/durableTradeRecovery";
import {
  BLS_G1_GENERATOR,
  CANONICAL_BLS_KEYSET_ID,
  canonicalKeysetId as keysetId,
  canonicalSecpPoint as secpPoint,
} from "../../test/cashu-proof-fixtures";

// Mock Dexie before importing the module under test — we don't need a real
// IndexedDB (no polyfill installed in the jsdom harness), just an object
// that records what addProofs wrote so we can assert normalization.
type AnyProof = {
  proofId?: string;
  secret: string;
  walletId?: string;
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
  marketId?: string;
  baseAsset?: string;
  unit?: string;
};

const store = new Map<string, AnyProof>();
const TEST_WALLET_ID = "ab".repeat(32);
let transactionTail = Promise.resolve();
let dbOpenError: Error | null = null;

vi.mock("dexie", () => {
  class FakeTable {
    async bulkPut(rows: AnyProof[]): Promise<void> {
      for (const r of rows) store.set(r.proofId!, r);
    }
    async bulkDelete(keys: string[]): Promise<void> {
      for (const k of keys) store.delete(k);
    }
    async bulkGet(keys: string[]): Promise<Array<AnyProof | undefined>> {
      return keys.map((key) => store.get(key));
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
        equals: (v: string | string[]) => ({
          toArray: async () =>
            Array.from(store.values()).filter((r) => {
              if (field === "walletId") return r.walletId === v;
              if (field === "mintUrl") return r.mintUrl === v;
              if (field === "[walletId+mintUrl]") {
                const [walletId, mintUrl] = v as string[];
                return r.walletId === walletId && r.mintUrl === mintUrl;
              }
              if (field === "[walletId+reservedBy]") {
                const [walletId, reservedBy] = v as string[];
                return r.walletId === walletId && r.reservedBy === reservedBy;
              }
              if (field === "[walletId+conditionId+outcomeCollection]") {
                const [walletId, conditionId, outcomeCollection] =
                  v as string[];
                return (
                  r.walletId === walletId &&
                  r.conditionId === conditionId &&
                  r.outcomeCollection === outcomeCollection
                );
              }
              if (
                field === "[walletId+mintUrl+conditionId+outcomeCollection]"
              ) {
                const [walletId, mintUrl, conditionId, outcomeCollection] =
                  v as string[];
                return (
                  r.walletId === walletId &&
                  r.mintUrl === mintUrl &&
                  r.conditionId === conditionId &&
                  r.outcomeCollection === outcomeCollection
                );
              }
              if (field === "[mintUrl+conditionId+outcomeCollection]") {
                const [mintUrl, conditionId, outcomeCollection] = v as [
                  string,
                  string,
                  string,
                ];
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
      store.set(row.proofId!, row);
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
    upgrade(_callback: unknown) {
      return this;
    }
    on(_event: string, _callback: () => void): void {}
    async open(): Promise<void> {
      if (dbOpenError) throw dbOpenError;
    }
    async transaction(
      _mode: string,
      _table: unknown,
      cb: () => Promise<void>,
    ): Promise<void> {
      const run = transactionTail.then(cb);
      transactionTail = run.catch(() => undefined);
      await run;
    }
  }

  return { default: FakeDexie };
});

// Import after mock so the module picks up the fake.
import {
  addProofs as addStoredProofs,
  configureGuiWalletIdProvider,
  ensureDurableSwapStorage,
  deriveStoredProofId,
  getBaseProofs,
  getConditionCtfProofs,
  getOutcomeProofs,
  getProofs,
  getUnitProofs,
  getReservedProofs,
  removeProofs,
  requireProofOperationRecord,
  releaseProofReservation,
  releaseProofReservations,
  reserveProofs,
  tryReserveProofs,
  type ProofOperationKind,
} from "../proof-db";

async function addProofs(proofs: AnyProof[]): Promise<void> {
  await addStoredProofs(
    proofs.map((proof) => ({ ...proof, unit: proof.unit ?? "sat" })) as never,
  );
}

function storedProofs(...secrets: string[]) {
  const selected = new Set(secrets);
  return Array.from(store.values()).filter((proof) =>
    selected.has(proof.secret),
  ) as never;
}

beforeEach(() => {
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
  configureGuiWalletIdProvider(() => TEST_WALLET_ID);
  store.clear();
  transactionTail = Promise.resolve();
  dbOpenError = null;
});

describe("proof-db normalization", () => {
  it("surfaces an unavailable durable swap database before protected work begins", async () => {
    dbOpenError = new Error("IndexedDB unavailable");

    await expect(ensureDurableSwapStorage()).rejects.toThrow(
      /Durable swap storage is unavailable: IndexedDB unavailable/,
    );
  });

  it("normalizes trailing slash on write", async () => {
    await addProofs([
      {
        secret: "s1",
        amount: Amount.from(100),
        id: keysetId(1),
        C: secpPoint(1),
        mintUrl: "http://mint.example/",
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
        id: keysetId(1),
        C: secpPoint(1),
        mintUrl: "http://mint.example",
      },
      {
        secret: "s2",
        amount: { value: 110n },
        id: keysetId(2),
        C: secpPoint(2),
        mintUrl: "http://mint.example",
      } as never,
    ]);

    const rows = await getProofs("http://mint.example");

    expect(rows.map((proof) => proof.amount)).toEqual([100, 110]);
    expect(Array.from(store.values()).map((proof) => proof.amount)).toEqual([
      100, 110,
    ]);
  });

  it("accepts canonical secp256k1 and BLS proof rows", async () => {
    await addStoredProofs([
      {
        ...validProof(),
        secret: "secp-proof",
        mintUrl: "https://mint.example",
        unit: "sat",
      },
      {
        ...validBlsProof(),
        secret: "bls-proof",
        mintUrl: "https://mint.example",
        unit: "sat",
      },
    ] as never);

    expect(
      (await getProofs("https://mint.example")).map((proof) => proof.secret),
    ).toEqual(["secp-proof", "bls-proof"]);
  });

  it.each(strictProofMutations())(
    "rejects %s at stored-row, operation-input, and completed-result boundaries",
    async (_case, mutation) => {
      await expect(
        addStoredProofs([
          {
            ...mutation,
            mintUrl: "https://mint.example",
            unit: "sat",
          },
        ] as never),
      ).rejects.toThrow(/Stored proof identity is invalid/);
      expect(store.size).toBe(0);

      expect(() =>
        requireProofOperationRecord(
          validProofOperation({ inputs: [mutation] }),
        ),
      ).toThrow(/Stored proof operation is invalid: inputs/);
      expect(() =>
        requireProofOperationRecord(
          validProofOperation({
            state: "completed",
            resultProofs: { change: [mutation] },
          }),
        ),
      ).toThrow(/Stored proof operation is invalid: result proofs/);
    },
  );

  it("does not delete a persisted input whose bearer artifact is corrupt", async () => {
    await addStoredProofs([
      {
        ...validProof(),
        mintUrl: "https://mint.example",
        unit: "sat",
      },
    ] as never);
    const [persisted] = Array.from(store.values());
    persisted!.C = `02${"ff".repeat(32)}`;

    await expect(removeProofs([persisted!] as never)).rejects.toThrow(
      /Stored proof identity is invalid/,
    );
    expect(store.size).toBe(1);
  });

  it("getProofs also normalizes the query argument", async () => {
    await addProofs([
      {
        secret: "s1",
        amount: Amount.from(100),
        id: keysetId(1),
        C: secpPoint(1),
        mintUrl: "http://mint.example",
      },
    ]);
    const rows = await getProofs("http://mint.example//");
    expect(rows).toHaveLength(1);
  });

  it("getBaseProofs excludes CTF proofs from spendable ecash balances", async () => {
    await addProofs([
      {
        secret: "base",
        amount: Amount.from(100),
        id: keysetId(1),
        C: secpPoint(1),
        mintUrl: "http://m",
      },
      {
        secret: "ctf",
        amount: Amount.from(200),
        id: keysetId(2),
        C: secpPoint(2),
        mintUrl: "http://m",
        conditionId: "cond-yes",
        outcomeCollection: "YES",
        marketId: "cond-yes-YES",
      } as never,
    ]);

    const rows = await getBaseProofs("http://m");

    expect(rows.map((r) => r.secret)).toEqual(["base"]);
  });

  it("requires a complete exact CTF metadata relation on stored proofs", async () => {
    const valid = {
      secret: "ctf",
      amount: Amount.from(100),
      id: keysetId(1),
      C: secpPoint(1),
      mintUrl: "http://m",
      conditionId: "cond",
      outcomeCollection: "A|B",
      marketId: "cond-A|B",
    };
    const missingOutcome = { ...valid } as Record<string, unknown>;
    delete missingOutcome.outcomeCollection;
    const mutations = [
      missingOutcome,
      { ...valid, marketId: "other-A|B" },
      { ...valid, condition_id: "other" },
      { ...valid, outcome_collection: "B|A" },
      { ...valid, condition_id: undefined },
    ];

    for (const mutation of mutations) {
      await expect(addProofs([mutation as never])).rejects.toThrow(
        /Stored proof identity is invalid/,
      );
    }
    await expect(
      addProofs([
        {
          ...valid,
          condition_id: valid.conditionId,
          outcome_collection: valid.outcomeCollection,
        } as never,
      ]),
    ).resolves.toBeUndefined();
  });

  it("getBaseProofs filters by explicit base asset", async () => {
    await addProofs([
      {
        secret: "legacy-sat",
        amount: Amount.from(100),
        id: keysetId(1),
        C: secpPoint(1),
        mintUrl: "http://m",
      },
      {
        secret: "usd",
        amount: Amount.from(100),
        id: keysetId(2),
        C: secpPoint(2),
        mintUrl: "http://m",
        baseAsset: "usd",
        unit: "usd",
      },
    ]);

    expect((await getBaseProofs("http://m")).map((r) => r.secret)).toEqual([
      "legacy-sat",
    ]);
    expect(
      (await getBaseProofs("http://m", { baseAsset: "usd" })).map(
        (r) => r.secret,
      ),
    ).toEqual(["usd"]);
  });

  it("getUnitProofs filters exact sat and msat units while getBaseProofs groups both for display", async () => {
    await addProofs([
      {
        secret: "sat-proof",
        amount: Amount.from(100),
        id: keysetId(1),
        C: secpPoint(1),
        mintUrl: "http://m",
        baseAsset: "sat",
        unit: "sat",
      },
      {
        secret: "msat-proof",
        amount: Amount.from(200),
        id: keysetId(2),
        C: secpPoint(2),
        mintUrl: "http://m",
        baseAsset: "sat",
        unit: "msat",
      },
    ]);

    expect(
      (await getUnitProofs("http://m", { unit: "msat" })).map((r) => r.secret),
    ).toEqual(["msat-proof"]);
    expect(
      (await getUnitProofs("http://m", { unit: "sat" })).map((r) => r.secret),
    ).toEqual(["sat-proof"]);
    expect(
      (await getBaseProofs("http://m", { baseAsset: "sat" })).map(
        (r) => r.secret,
      ),
    ).toEqual(["sat-proof", "msat-proof"]);
  });

  it("rejects a durable proof without an explicit unit", async () => {
    await expect(
      addStoredProofs([
        {
          secret: "legacy-sat",
          amount: Amount.from(100),
          id: keysetId(1),
          C: secpPoint(1),
          mintUrl: "http://m",
          baseAsset: "sat",
        },
      ] as never),
    ).rejects.toThrow("Stored proof has no supported Cashu unit");
  });

  it("rejects mismatched base asset and unit on write", async () => {
    await expect(
      addProofs([
        {
          secret: "bad",
          amount: Amount.from(100),
          id: keysetId(1),
          C: secpPoint(1),
          mintUrl: "http://m",
          baseAsset: "sat",
          unit: "usd",
        },
      ]),
    ).rejects.toThrow("Stored proof unit is incompatible with its base asset");
  });

  it("derives base asset from explicit unit before validating on write", async () => {
    await addProofs([
      {
        secret: "usd-without-base",
        amount: Amount.from(100),
        id: keysetId(1),
        C: secpPoint(1),
        mintUrl: "http://m",
        unit: "usd",
      },
    ]);

    const rows = await getProofs("http://m");

    expect(rows[0]).toMatchObject({
      secret: "usd-without-base",
      baseAsset: "usd",
      unit: "usd",
    });
  });

  it("getOutcomeProofs returns only the requested condition outcome", async () => {
    await addProofs([
      {
        secret: "yes",
        amount: Amount.from(100),
        id: keysetId(1),
        C: secpPoint(1),
        mintUrl: "http://m",
        conditionId: "cond",
        outcomeCollection: "YES",
        marketId: "cond-YES",
      },
      {
        secret: "no",
        amount: Amount.from(100),
        id: keysetId(2),
        C: secpPoint(2),
        mintUrl: "http://m",
        condition_id: "cond",
        outcome_collection: "NO",
        marketId: "cond-NO",
      } as never,
      {
        secret: "base",
        amount: Amount.from(100),
        id: keysetId(3),
        C: secpPoint(3),
        mintUrl: "http://m",
      },
    ]);

    const rows = await getOutcomeProofs("http://m", "cond", "YES");

    expect(rows.map((r) => r.secret)).toEqual(["yes"]);
  });

  it("getConditionCtfProofs gathers every keyset leg regardless of label storage", async () => {
    await addProofs([
      // composite-label storage: both keysets tagged "A|B"
      {
        secret: "compA",
        amount: Amount.from(100),
        id: keysetId(10),
        C: secpPoint(1),
        mintUrl: "http://m",
        conditionId: "cond",
        outcomeCollection: "A|B",
        marketId: "cond-A|B",
      },
      {
        secret: "compB",
        amount: Amount.from(100),
        id: keysetId(11),
        C: secpPoint(2),
        mintUrl: "http://m",
        conditionId: "cond",
        outcomeCollection: "A|B",
        marketId: "cond-A|B",
      },
      // per-primitive storage variant under condition_id snake-case key
      {
        secret: "primC",
        amount: Amount.from(100),
        id: keysetId(12),
        C: secpPoint(3),
        mintUrl: "http://m",
        condition_id: "cond",
        outcome_collection: "C",
        marketId: "cond-C",
      } as never,
      // different condition — must be excluded
      {
        secret: "other",
        amount: Amount.from(100),
        id: keysetId(10),
        C: secpPoint(4),
        mintUrl: "http://m",
        conditionId: "cond2",
        outcomeCollection: "A",
        marketId: "cond2-A",
      },
      // base (non-CTF) proof — must be excluded
      {
        secret: "base",
        amount: Amount.from(100),
        id: keysetId(5),
        C: secpPoint(5),
        mintUrl: "http://m",
      },
    ]);

    const rows = await getConditionCtfProofs("http://m", "cond");

    expect(rows.map((r) => r.secret).sort()).toEqual([
      "compA",
      "compB",
      "primC",
    ]);
    // Bucketing by real keyset id recovers all three legs.
    expect(new Set(rows.map((r) => r.id))).toEqual(
      new Set([keysetId(10), keysetId(11), keysetId(12)]),
    );
  });

  it("getOutcomeProofs filters by explicit base asset", async () => {
    await addProofs([
      {
        secret: "legacy-sat-yes",
        amount: Amount.from(100),
        id: keysetId(1),
        C: secpPoint(1),
        mintUrl: "http://m",
        conditionId: "cond",
        outcomeCollection: "YES",
        marketId: "cond-YES",
      },
      {
        secret: "usd-yes",
        amount: Amount.from(100),
        id: keysetId(2),
        C: secpPoint(2),
        mintUrl: "http://m",
        conditionId: "cond",
        outcomeCollection: "YES",
        marketId: "cond-YES",
        baseAsset: "usd",
        unit: "usd",
      },
    ]);

    expect(
      (await getOutcomeProofs("http://m", "cond", "YES")).map((r) => r.secret),
    ).toEqual(["legacy-sat-yes"]);
    expect(
      (
        await getOutcomeProofs("http://m", "cond", "YES", { baseAsset: "usd" })
      ).map((r) => r.secret),
    ).toEqual(["usd-yes"]);
  });

  it("hides reserved proofs from spendable base and outcome queries", async () => {
    await addProofs([
      {
        secret: "base-free",
        amount: Amount.from(100),
        id: keysetId(1),
        C: secpPoint(1),
        mintUrl: "http://m",
      },
      {
        secret: "base-reserved",
        amount: Amount.from(100),
        id: keysetId(2),
        C: secpPoint(2),
        mintUrl: "http://m",
      },
      {
        secret: "yes-free",
        amount: Amount.from(100),
        id: keysetId(3),
        C: secpPoint(3),
        mintUrl: "http://m",
        conditionId: "cond",
        outcomeCollection: "YES",
        marketId: "cond-YES",
      },
      {
        secret: "yes-reserved",
        amount: Amount.from(100),
        id: keysetId(4),
        C: secpPoint(4),
        mintUrl: "http://m",
        conditionId: "cond",
        outcomeCollection: "YES",
        marketId: "cond-YES",
      },
    ]);
    await reserveProofs(
      storedProofs("base-reserved", "yes-reserved"),
      "order-1",
    );

    expect((await getBaseProofs("http://m")).map((r) => r.secret)).toEqual([
      "base-free",
    ]);
    expect(
      (await getOutcomeProofs("http://m", "cond", "YES")).map((r) => r.secret),
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
        id: keysetId(1),
        C: secpPoint(1),
        mintUrl: "http://m",
      },
      {
        secret: "s2",
        amount: Amount.from(100),
        id: keysetId(2),
        C: secpPoint(2),
        mintUrl: "http://m",
      },
    ]);
    await reserveProofs(storedProofs("s1", "s2"), "order-1");
    await releaseProofReservations(storedProofs("s1"));

    expect((await getProofs("http://m")).map((r) => r.secret)).toEqual(["s1"]);

    await releaseProofReservation("order-1");
    expect((await getProofs("http://m")).map((r) => r.secret)).toEqual([
      "s1",
      "s2",
    ]);
  });

  it("allows only one concurrent owner to reserve the same proof set", async () => {
    await addProofs([
      {
        secret: "shared",
        amount: Amount.from(100),
        id: keysetId(1),
        C: secpPoint(1),
        mintUrl: "http://m",
        baseAsset: "sat",
        unit: "msat",
      },
    ]);

    const [first, second] = await Promise.all([
      tryReserveProofs(storedProofs("shared"), "trade-a"),
      tryReserveProofs(storedProofs("shared"), "trade-b"),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(
      (await getReservedProofs("trade-a")).length +
        (await getReservedProofs("trade-b")).length,
    ).toBe(1);
  });
});

const PROOF_OPERATION_KINDS: readonly ProofOperationKind[] = [
  "swap-lock",
  "swap-claim",
  "conditional-keyset-swap",
  "swap-refund",
  "ctf-split",
  "ctf-merge",
  "ctf-redeem",
  "ctf-condition-registration",
  "regular-split",
  "proof-split",
  "wallet-mint",
  "wallet-receive",
];

describe("proof operation record decoder", () => {
  it.each(PROOF_OPERATION_KINDS)(
    "accepts the current %s writer shape and opaque metadata",
    (kind) => {
      const record = validProofOperation({ kind });

      expect(requireProofOperationRecord(record)).toBe(record);
    },
  );

  it("accepts current in-memory Amounts and finite StoredProof extensions", () => {
    const storedProof = validStoredOperationProof();
    const record = validProofOperation({ inputs: [storedProof] });

    expect(requireProofOperationRecord(record)).toBe(record);
  });

  it("accepts canonical secp256k1 and BLS proofs in inputs and completed results", () => {
    const secpProof = validProof();
    const blsProof = validBlsProof();
    const prepared = validProofOperation({ inputs: [secpProof, blsProof] });
    const completed = validProofOperation({
      state: "completed",
      resultProofs: { change: [secpProof, blsProof] },
    });

    expect(requireProofOperationRecord(prepared)).toBe(prepared);
    expect(requireProofOperationRecord(completed)).toBe(completed);
  });

  it("rejects an unknown top-level field", () => {
    expect(() =>
      requireProofOperationRecord(validProofOperation({ unexpected: true })),
    ).toThrow(/Stored proof operation is invalid/);
  });

  it.each(["custodyOperationId", "metadata", "lastError"])(
    "rejects a missing top-level %s field",
    (field) => {
      const record = validProofOperation();
      delete record[field];

      expect(() => requireProofOperationRecord(record)).toThrow(
        /Stored proof operation is invalid/,
      );
    },
  );

  it("rejects a present-but-undefined last error", () => {
    expect(() =>
      requireProofOperationRecord(validProofOperation({ lastError: undefined })),
    ).toThrow(/Stored proof operation is invalid/);
  });

  it.each([
    [
      "missing proof signature",
      { id: keysetId(1), amount: 1, secret: "secret" },
    ],
    ["unknown proof field", { ...validProof(), signature: "02" }],
    ["unsafe proof amount", { ...validProof(), amount: Number.MAX_VALUE }],
    ["malformed DLEQ", { ...validProof(), dleq: { e: "zz", s: "01" } }],
    ["malformed witness", { ...validProof(), witness: { signatures: [1] } }],
  ])("rejects %s", (_case, proof) => {
    expect(() =>
      requireProofOperationRecord(validProofOperation({ inputs: [proof] })),
    ).toThrow(/Stored proof operation is invalid/);
  });

  it("rejects a malformed completed result proof", () => {
    expect(() =>
      requireProofOperationRecord(
        validProofOperation({
          state: "completed",
          resultProofs: { change: [{ ...validProof(), C: "invalid" }] },
        }),
      ),
    ).toThrow(/Stored proof operation is invalid: result proofs/);
  });

  it("requires complete exact CTF metadata on nested operation proofs", () => {
    const valid = {
      ...validProof(),
      conditionId: "condition-a",
      outcomeCollection: "YES",
      marketId: "condition-a-YES",
    };
    expect(
      requireProofOperationRecord(
        validProofOperation({
          inputs: [
            {
              ...valid,
              condition_id: valid.conditionId,
              outcome_collection: valid.outcomeCollection,
            },
          ],
        }),
      ),
    ).toBeDefined();

    const missingMarket = { ...valid } as Record<string, unknown>;
    delete missingMarket.marketId;
    const mutations = [
      missingMarket,
      { ...valid, conditionId: undefined },
      { ...valid, marketId: "condition-a-NO" },
      { ...valid, condition_id: "condition-b" },
      { ...valid, outcome_collection: "NO" },
    ];
    for (const mutation of mutations) {
      expect(() =>
        requireProofOperationRecord(
          validProofOperation({ inputs: [mutation] }),
        ),
      ).toThrow(/Stored proof operation is invalid: inputs/);
    }
  });

  it.each([
    [
      "an output missing private material",
      { blindedMessage: validBlindedMessage(), secret: "01".repeat(32) },
    ],
    [
      "an output with an unknown field",
      { ...validOutput(), privateKey: "01".repeat(32) },
    ],
    [
      "a malformed blinded message",
      {
        ...validOutput(),
        blindedMessage: { ...validBlindedMessage(), B_: "x" },
      },
    ],
  ])("rejects %s", (_case, output) => {
    expect(() =>
      requireProofOperationRecord(
        validProofOperation({ outputs: { change: [output] } }),
      ),
    ).toThrow(/Stored proof operation is invalid/);
  });

  it.each([
    [
      "completed state without results",
      { state: "completed", resultProofs: undefined },
    ],
    [
      "a completed error",
      { state: "completed", resultProofs: {}, lastError: "bad" },
    ],
    ["a non-failed failure code", { failureCode: 13015 }],
    ["a failed result", failedProofOperation({ resultProofs: {} })],
    [
      "a failed state without an error",
      failedProofOperation({ lastError: null }),
    ],
    [
      "a failed state without a code",
      failedProofOperation({ failureCode: undefined }),
    ],
  ])("rejects illegal lifecycle combination: %s", (_case, changes) => {
    expect(() =>
      requireProofOperationRecord(validProofOperation(changes)),
    ).toThrow(/Stored proof operation is invalid/);
  });

  it.each(["prepared", "mint-submitted"])(
    "accepts authenticated result staging while state remains %s",
    (state) => {
      const record = validProofOperation({
        state,
        resultProofs: { change: [validProof()] },
      });

      expect(requireProofOperationRecord(record)).toBe(record);
    },
  );

  it("requires exact trade-link mirrors and matching native state", () => {
    const operationId = "operation-linked";
    const link = createDurableTradeProofOperationLink({
      tradeId: "trade-linked",
      role: "buyer",
      stage: "claim",
      state: "prepared",
      operationKey: operationId,
    });
    const linked = validProofOperation({
      operationId,
      durableTradeRecovery: link,
      durableOperationId: link.operationId,
      durableTradeId: link.tradeId,
    });
    expect(requireProofOperationRecord(linked)).toBe(linked);

    expect(() =>
      requireProofOperationRecord({
        ...linked,
        state: "mint-submitted",
      }),
    ).toThrow(/recovery binding is invalid/);
    expect(() =>
      requireProofOperationRecord(
        validProofOperation({ durableOperationId: link.operationId }),
      ),
    ).toThrow(/recovery binding is invalid/);
  });

  it.each([
    "https://mint.example/",
    "https://mint.example?alias=true",
    " https://mint.example",
    "ftp://mint.example",
  ])("rejects non-canonical persisted mint URL %s", (mintUrl) => {
    expect(() =>
      requireProofOperationRecord(validProofOperation({ mintUrl })),
    ).toThrow(/Stored proof operation is invalid/);
  });
});

function validProofOperation(
  changes: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    walletId: TEST_WALLET_ID,
    operationId: "operation-1",
    kind: "regular-split",
    state: "prepared",
    mintUrl: "https://mint.example",
    inputs: [validProof()],
    outputs: { change: [validOutput()] },
    metadata: {
      unit: "sat",
      implementationOwned: { nested: ["metadata", 1] },
    },
    lastError: null,
    custodyOperationId: "custody-operation-1",
    createdAt: 1,
    updatedAt: 2,
    ...changes,
  };
}

function failedProofOperation(
  changes: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    state: "Failed",
    lastError: "terminal mint rejection",
    failureCode: 13015,
    ...changes,
  };
}

function validProof(): Record<string, unknown> {
  return {
    id: keysetId(1),
    amount: 1,
    secret: "secret-1",
    C: secpPoint(1),
  };
}

function validBlsProof(): Record<string, unknown> {
  return {
    id: CANONICAL_BLS_KEYSET_ID,
    amount: 1,
    secret: "secret-bls",
    C: BLS_G1_GENERATOR,
  };
}

function validDleq(): Record<string, unknown> {
  return {
    e: "11".repeat(32),
    s: "22".repeat(32),
    r: "33".repeat(32),
  };
}

function strictProofMutations(): Array<[string, Record<string, unknown>]> {
  return [
    ["a noncanonical keyset id", { ...validProof(), id: "00aa" }],
    [
      "an invalid secp256k1 point",
      { ...validProof(), C: `02${"ff".repeat(32)}` },
    ],
    [
      "a keyset/curve mismatch",
      { ...validProof(), id: CANONICAL_BLS_KEYSET_ID },
    ],
    ["BLS proof DLEQ", { ...validBlsProof(), dleq: validDleq() }],
    [
      "a malformed DLEQ",
      { ...validProof(), dleq: { ...validDleq(), e: "11" } },
    ],
    [
      "a malformed witness",
      { ...validProof(), witness: { signatures: ["44"] } },
    ],
  ];
}

function validStoredOperationProof(): Record<string, unknown> {
  const proof = {
    ...validProof(),
    amount: Amount.from(1),
    walletId: TEST_WALLET_ID,
    mintUrl: "https://mint.example",
    baseAsset: "sat",
    unit: "sat",
    receivedAt: 1,
    proofClass: "regular",
    selectability: "spendable",
  };
  return {
    ...proof,
    proofId: deriveStoredProofId(proof as never),
  };
}

function validOutput(): Record<string, unknown> {
  return {
    blindedMessage: validBlindedMessage(),
    blindingFactor: "01",
    secret: "01".repeat(32),
  };
}

function validBlindedMessage(): Record<string, unknown> {
  return {
    amount: 1,
    id: "00aa",
    B_: `02${"22".repeat(32)}`,
  };
}
