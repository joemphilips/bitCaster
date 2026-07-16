import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Proof } from "@cashu/cashu-ts";

// ---------------------------------------------------------------------------
// Mock state (hoisted so the vi.mock factories can close over it)
// ---------------------------------------------------------------------------

const proofDbState = vi.hoisted(() => ({
  store: new Map<string, any>(),
  operations: new Map<string, any>(),
  addedProofs: [] as any[],
  removedSecrets: [] as string[],
  failNextMarkFailed: false,
}));

const cashuState = vi.hoisted(() => ({
  // outcome collections the mint considers winning, keyed by keyset id.
  // A redeem for a keyset NOT in this set throws OracleNotAttestedOutcome.
  winningKeysets: new Set<string>(),
  redeemCalls: [] as Array<{ inputs: Proof[] }>,
  transientFailKeysets: new Set<string>(),
  // When true, losing-leg rejections are surfaced as a bare message-only Error
  // (no structured `code`) to exercise `isLosingLegError`'s legacy fallback.
  losingLegMessageOnly: false,
  requireUnlockedMintIo: false,
  switchWalletOnGetKeys: false,
  proofState: "UNSPENT",
  restoreCalls: 0,
}));

const walletLockState = vi.hoisted(() => ({
  held: false,
  currentWalletId: "aa".repeat(32),
}));

function assertMintIoRunsWithoutWalletLock(): void {
  if (cashuState.requireUnlockedMintIo && walletLockState.held) {
    throw new Error("mint I/O ran while the GUI wallet Web Lock was held");
  }
}

async function withTestWalletLock<T>(
  expectedWalletId: string,
  action: (
    context: { walletId: string; scope: object },
    lock: { walletId: string },
  ) => Promise<T> | T,
): Promise<T> {
  if (walletLockState.currentWalletId !== expectedWalletId) {
    throw new Error("GUI wallet changed while awaiting custody ownership");
  }
  if (walletLockState.held) {
    throw new Error("test attempted to reacquire an already-held wallet lock");
  }
  walletLockState.held = true;
  try {
    return await action(
      { walletId: expectedWalletId, scope: {} },
      { walletId: expectedWalletId },
    );
  } finally {
    walletLockState.held = false;
  }
}

// ---------------------------------------------------------------------------
// proof DB and custody coordinator mocks — in-memory proof and op ledgers
// ---------------------------------------------------------------------------

vi.mock("@/stores/proof-db", () => {
  return {
    currentGuiWalletId: () => walletLockState.currentWalletId,
    addProofs: vi.fn(async (proofs: any[]) => {
      for (const p of proofs) {
        proofDbState.addedProofs.push(p);
        proofDbState.store.set(p.secret, p);
      }
    }),
    removeProofs: vi.fn(async (secrets: string[]) => {
      for (const s of secrets) {
        proofDbState.removedSecrets.push(s);
        proofDbState.store.delete(s);
      }
    }),
    getProofOperation: vi.fn(async (operationId: string) => {
      return proofDbState.operations.get(operationId) ?? null;
    }),
    getProofOperationUnderLock: vi.fn(
      async (_lock: unknown, operationId: string) => {
        return proofDbState.operations.get(operationId) ?? null;
      },
    ),
  };
});

vi.mock("@/stores/gui-wallet-proof-operation-custody", () => {
  const prepare = vi.fn(async (input: any) => {
    const existing = proofDbState.operations.get(input.operationId);
    if (existing) return existing;
    const record = {
      ...input,
      state: "prepared",
      metadata: input.metadata ?? {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    proofDbState.operations.set(input.operationId, record);
    return record;
  });
  const submit = vi.fn(
    async (
      operationId: string,
      binding: { schemaVersion: number; requestDigest: string },
    ) => {
      const existing = proofDbState.operations.get(operationId);
      const updated = {
        ...existing,
        state: "mint-submitted",
        metadata: {
          ...existing.metadata,
          redeemMintSubmissionVersion: binding.schemaVersion,
          redeemMintSubmissionRequestDigest: binding.requestDigest,
        },
      };
      proofDbState.operations.set(operationId, updated);
      return updated;
    },
  );
  const complete = vi.fn(async (operationId: string, resultProofs: any) => {
    const existing = proofDbState.operations.get(operationId);
    for (const input of existing.inputs) {
      proofDbState.removedSecrets.push(input.secret);
      proofDbState.store.delete(input.secret);
    }
    for (const proof of Object.values(resultProofs).flat() as any[]) {
      proofDbState.addedProofs.push(proof);
      proofDbState.store.set(proof.secret, proof);
    }
    const updated = { ...existing, state: "completed", resultProofs };
    proofDbState.operations.set(operationId, updated);
    return updated;
  });
  const fail = vi.fn(async (operationId: string, error: unknown) => {
    if (proofDbState.failNextMarkFailed) {
      proofDbState.failNextMarkFailed = false;
      throw new Error("simulated crash before terminal operation state");
    }
    const existing = proofDbState.operations.get(operationId);
    const updated = {
      ...existing,
      state: "Failed",
      lastError: error instanceof Error ? error.message : String(error),
      failureCode:
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "number"
          ? (error as { code: number }).code
          : undefined,
    };
    proofDbState.operations.set(operationId, updated);
    return updated;
  });
  return {
    prepareProofOperation: prepare,
    prepareProofOperationForWallet: (walletId: string, input: unknown) =>
      withTestWalletLock(walletId, () =>
        prepare({ ...(input as object), walletId }),
      ),
    markProofOperationMintSubmitted: submit,
    markProofOperationMintSubmittedForWallet: (
      walletId: string,
      operationId: string,
      binding: { schemaVersion: number; requestDigest: string },
    ) => withTestWalletLock(walletId, () => submit(operationId, binding)),
    markProofOperationCompleted: complete,
    markProofOperationCompletedForWallet: (
      walletId: string,
      operationId: string,
      resultProofs: unknown,
    ) =>
      withTestWalletLock(walletId, () => complete(operationId, resultProofs)),
    markProofOperationFailed: fail,
    markProofOperationFailedForWallet: (
      walletId: string,
      operationId: string,
      error: unknown,
    ) => withTestWalletLock(walletId, () => fail(operationId, error)),
  };
});

vi.mock("@/stores/gui-custody-authority", () => ({
  withGuiCustodyProfileLock: (action: (...args: any[]) => any) =>
    withTestWalletLock(walletLockState.currentWalletId, action),
  withGuiCustodyProfileLockForWallet: (
    walletId: string,
    action: (...args: any[]) => any,
  ) => withTestWalletLock(walletId, action),
  releaseGuiCustodyAuthority: vi.fn(async () => undefined),
}));

vi.mock("@/stores/gui-wallet-lock", () => ({
  walletIdFromHeldGuiWalletLock: (lock: { walletId: string }) => lock.walletId,
}));

// ---------------------------------------------------------------------------
// cashu-ts mock — only the surface settleCtfPosition touches
// ---------------------------------------------------------------------------

vi.mock("@cashu/cashu-ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cashu/cashu-ts")>();

  class MockOutputData {
    blindedMessage: { amount: number; id: string; B_: string };
    blindingFactor: bigint;
    secret: Uint8Array;
    constructor(
      blindedMessage: { amount: number; id: string; B_: string },
      blindingFactor: bigint,
      secret: Uint8Array,
    ) {
      this.blindedMessage = blindedMessage;
      this.blindingFactor = blindingFactor;
      this.secret = secret;
    }
    toProof(signature: { C_?: string }): Proof {
      return {
        id: this.blindedMessage.id,
        amount: this.blindedMessage.amount,
        secret: new TextDecoder().decode(this.secret),
        C: signature.C_ ?? "02".padEnd(66, "9"),
      } as unknown as Proof;
    }
    static createRandomData(
      amount: { value: bigint } | number,
      keyset: { id: string },
    ): MockOutputData[] {
      const value = typeof amount === "number" ? amount : Number(amount.value);
      return [
        new MockOutputData(
          { amount: value, id: keyset.id, B_: "02".padEnd(66, "0") },
          1n,
          new TextEncoder().encode(`regular-${keyset.id}-${value}`),
        ),
      ];
    }
  }

  class MockMint {
    mintUrl: string;
    constructor(url: string) {
      this.mintUrl = url;
    }
    async getKeys() {
      assertMintIoRunsWithoutWalletLock();
      if (cashuState.switchWalletOnGetKeys) {
        walletLockState.currentWalletId = "bb".repeat(32);
      }
      return {
        keysets: [
          {
            id: "regular-keyset",
            unit: "sat",
            active: true,
            keys: { 1: "02".padEnd(66, "1") },
          },
        ],
      };
    }
    async getInfo() {
      assertMintIoRunsWithoutWalletLock();
      return { name: "mock", nuts: {} };
    }
    createRequestWithOptions() {
      return async () => {
        throw new Error("unexpected raw mint request");
      };
    }
    async restore({ outputs }: { outputs: Array<Record<string, unknown>> }) {
      assertMintIoRunsWithoutWalletLock();
      cashuState.restoreCalls += 1;
      return {
        outputs,
        signatures: outputs.map((output) => ({
          id: output.id,
          amount: output.amount,
          C_: "02".padEnd(66, "7"),
        })),
      };
    }
  }

  class MockWallet {
    mint: MockMint;
    constructor(mint: MockMint) {
      this.mint = mint;
    }
    async loadMint() {
      assertMintIoRunsWithoutWalletLock();
    }
    async checkProofsStates(
      inputs: Array<{ id: string; secret: string }>,
    ): Promise<Array<{ Y: string; state: string; witness: null }>> {
      assertMintIoRunsWithoutWalletLock();
      return inputs.map((input) => ({
        Y: actual
          .hashToCurve(new TextEncoder().encode(input.secret))
          .toHex(true),
        state: cashuState.proofState,
        witness: null,
      }));
    }
    async redeemOutcomeProofs({
      inputs,
      outputs,
    }: {
      inputs: Proof[];
      outputs: MockOutputData[];
    }): Promise<Proof[]> {
      assertMintIoRunsWithoutWalletLock();
      cashuState.redeemCalls.push({ inputs });
      const keysetId = inputs[0]?.id ?? "";
      if (cashuState.transientFailKeysets.has(keysetId)) {
        throw new Error("network timeout while contacting mint");
      }
      if (!cashuState.winningKeysets.has(keysetId)) {
        if (cashuState.losingLegMessageOnly) {
          // Transport dropped the structured code → bare message only.
          throw new Error("Oracle has not attested to this outcome collection");
        }
        // The mint condemns a non-winning leg with the terminal NUT-CTF
        // code 13015 (OracleNotAttestedOutcome), surfaced as MintOperationError.
        const err = new Error(
          "Oracle has not attested to this outcome collection",
        ) as Error & { code: number; status: number; name: string };
        err.name = "MintOperationError";
        err.code = 13015;
        err.status = 400;
        throw err;
      }
      return outputs.map((o) => o.toProof({ C_: "02".padEnd(66, "7") }));
    }
  }

  return {
    ...actual,
    CheckStateEnum: { SPENT: "SPENT", UNSPENT: "UNSPENT" },
    OutputData: MockOutputData,
    Mint: MockMint,
    Wallet: MockWallet,
  };
});

// Wallet store: no mnemonic → getWallet uses the fallback CashuWallet path.
vi.mock("@/stores/wallet", () => ({
  useWalletStore: {
    getState: () => ({
      mnemonic: undefined,
      activeMintUrl: "http://mint.test",
      getWalletForUnit: async (
        mintUrl: string,
        _unit: string,
        options?: { expectedWalletId?: string },
      ) => {
        if (
          options?.expectedWalletId !== undefined &&
          options.expectedWalletId !== walletLockState.currentWalletId
        ) {
          throw new Error(
            "Active wallet seed does not match the held wallet lock",
          );
        }
        const { Mint, Wallet } = await import("@cashu/cashu-ts");
        const wallet = new Wallet(new Mint(mintUrl));
        await wallet.loadMint();
        return wallet;
      },
    }),
  },
}));

const CONDITION_ID = "a".repeat(64);

function makeProof(
  secret: string,
  amount: number,
  keysetId: string,
  outcomeCollection: string,
): Proof {
  return {
    id: keysetId,
    amount,
    secret,
    C: "02".padEnd(66, "0"),
    outcomeCollection,
  } as unknown as Proof;
}

function mockAttestation(attestedOutcome: string): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes(`/conditions/${CONDITION_ID}/attestation`)) {
      return new Response(
        JSON.stringify({
          conditionId: CONDITION_ID,
          attestedOutcome,
          oracleWitness: { oracle_sig: "deadbeef" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as never;
}

describe("settleCtfPosition — per-keyset redeem", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    proofDbState.store.clear();
    proofDbState.operations.clear();
    proofDbState.addedProofs.length = 0;
    proofDbState.removedSecrets.length = 0;
    proofDbState.failNextMarkFailed = false;
    cashuState.winningKeysets.clear();
    cashuState.transientFailKeysets.clear();
    cashuState.redeemCalls.length = 0;
    cashuState.losingLegMessageOnly = false;
    cashuState.requireUnlockedMintIo = false;
    cashuState.switchWalletOnGetKeys = false;
    cashuState.proofState = "UNSPENT";
    cashuState.restoreCalls = 0;
    walletLockState.held = false;
    walletLockState.currentWalletId = "aa".repeat(32);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('composite "A|B" stored per-primitive: redeems A and retains terminal B until user removal', async () => {
    // 3-outcome market A/B/C; taker holds composite "A|B" across keysets A and B.
    // Stored per-primitive: A-keyset proof labelled "A", B-keyset proof labelled "B".
    // B2 LOW: even though B's stored label ("B") excludes the attested outcome,
    // we must NOT short-circuit on the label — the B leg has to be presented to
    // the mint and remains pinned after the terminal 13015 until user removal.
    cashuState.winningKeysets.add("keyset-A");
    mockAttestation("A");
    const { settleCtfPosition } = await import("@/lib/cashu");

    const proofs = [
      makeProof("sA", 100, "keyset-A", "A"),
      makeProof("sB", 100, "keyset-B", "B"),
    ];
    const regular = await settleCtfPosition({
      conditionId: CONDITION_ID,
      amountSats: 200,
      proofs,
      mintUrl: "http://mint.test",
    });

    // A leg redeemed → 100 sats credited.
    expect(regular.reduce((s, p) => s + Number(p.amount), 0)).toBe(100);
    // BOTH keysets were presented to the mint — the B leg is NOT discarded on
    // its stored label; the mint adjudicates it.
    expect(cashuState.redeemCalls).toHaveLength(2);
    expect(cashuState.redeemCalls.map((c) => c.inputs[0].id).sort()).toEqual([
      "keyset-A",
      "keyset-B",
    ]);
    // The winning input is replaced atomically; the terminal losing proof is
    // retained as non-selectable evidence until explicit user removal.
    expect(proofDbState.removedSecrets).toEqual(["sA"]);
  });

  it("B2 LOW: a MISLABELLED would-be-winning proof is NOT destroyed — the mint redeems it despite the wrong stored label", async () => {
    // The A-keyset proof is the real winner (mint attests "A"), but settlement
    // mislabelled it "B" (a stale/wrong outcomeCollection). The pre-fix code
    // would have read the label, decided "loser", and silently destroyed this
    // proof with NO mint call — irreversible bearer-proof loss. Post-fix, the
    // leg is presented to the mint, which redeems it for full value.
    cashuState.winningKeysets.add("keyset-A");
    mockAttestation("A");
    const { settleCtfPosition } = await import("@/lib/cashu");

    const proofs = [makeProof("sA", 100, "keyset-A", "B")]; // label LIES
    const regular = await settleCtfPosition({
      conditionId: CONDITION_ID,
      amountSats: 100,
      proofs,
      mintUrl: "http://mint.test",
    });

    // Redeemed for full value despite the wrong label — value preserved.
    expect(regular.reduce((s, p) => s + Number(p.amount), 0)).toBe(100);
    expect(cashuState.redeemCalls).toHaveLength(1);
    expect(cashuState.redeemCalls[0].inputs[0].id).toBe("keyset-A");
    // The mislabelled winner's input is removed (spent), not silently discarded.
    expect(proofDbState.removedSecrets).toEqual(["sA"]);
    // Its op-id must NOT be marked failed — it succeeded.
    const op = Array.from(proofDbState.operations.values())[0];
    expect(op.state).toBe("completed");
  });

  it("does not classify a code-less rejection as a losing leg", async () => {
    cashuState.winningKeysets.add("keyset-A");
    cashuState.losingLegMessageOnly = true;
    mockAttestation("A");
    const { settleCtfPosition } = await import("@/lib/cashu");

    const proofs = [
      makeProof("sA", 100, "keyset-A", "A|B"),
      makeProof("sB", 100, "keyset-B", "A|B"),
    ];
    await expect(
      settleCtfPosition({
        conditionId: CONDITION_ID,
        amountSats: 200,
        proofs,
        mintUrl: "http://mint.test",
      }),
    ).rejects.toThrow(/Oracle has not attested/);

    expect(cashuState.redeemCalls).toHaveLength(2);
    expect(proofDbState.removedSecrets).toEqual(["sA"]);
    const losingOp = Array.from(proofDbState.operations.values()).find(
      (op) => op.metadata?.keysetId === "keyset-B",
    );
    expect(losingOp?.state).toBe("mint-submitted");
  });

  it("retains and resumes a losing leg when terminal-state commit fails", async () => {
    cashuState.winningKeysets.add("keyset-A");
    mockAttestation("A");
    const { settleCtfPosition } = await import("@/lib/cashu");

    const proofs = [
      makeProof("sA", 100, "keyset-A", "A|B"),
      makeProof("sB", 100, "keyset-B", "A|B"),
    ];
    proofDbState.failNextMarkFailed = true;

    await expect(
      settleCtfPosition({
        conditionId: CONDITION_ID,
        amountSats: 200,
        proofs,
        mintUrl: "http://mint.test",
      }),
    ).rejects.toThrow(/simulated crash/);

    const losingOpAfterCrash = Array.from(
      proofDbState.operations.values(),
    ).find((op) => op.metadata?.keysetId === "keyset-B");
    expect(losingOpAfterCrash?.state).toBe("mint-submitted");
    expect(proofDbState.removedSecrets).toEqual(["sA"]);

    const regular = await settleCtfPosition({
      conditionId: CONDITION_ID,
      amountSats: 200,
      proofs,
      mintUrl: "http://mint.test",
    });

    expect(regular.reduce((s, p) => s + Number(p.amount), 0)).toBe(100);
    const losingOpAfterResume = Array.from(
      proofDbState.operations.values(),
    ).find((op) => op.metadata?.keysetId === "keyset-B");
    expect(losingOpAfterResume?.state).toBe("Failed");
    expect(
      proofDbState.removedSecrets.filter((secret) => secret === "sB"),
    ).toHaveLength(0);
  });

  it('composite "A|B" stored under composite label: B leg remains terminally pinned, no error', async () => {
    // Composite-label storage: BOTH legs carry label "A|B" → both look like winners.
    // The B-keyset redeem fails terminally at the mint; we remove it silently.
    cashuState.winningKeysets.add("keyset-A");
    mockAttestation("A");
    const { settleCtfPosition } = await import("@/lib/cashu");

    const proofs = [
      makeProof("sA", 100, "keyset-A", "A|B"),
      makeProof("sB", 100, "keyset-B", "A|B"),
    ];
    const regular = await settleCtfPosition({
      conditionId: CONDITION_ID,
      amountSats: 200,
      proofs,
      mintUrl: "http://mint.test",
    });

    expect(regular.reduce((s, p) => s + Number(p.amount), 0)).toBe(100);
    // Both keysets were attempted at the mint (composite label can't pre-classify).
    expect(cashuState.redeemCalls).toHaveLength(2);
    // Only the redeemed winner is removed; losing terminal evidence remains.
    expect(proofDbState.removedSecrets).toEqual(["sA"]);
    const losingOp = Array.from(proofDbState.operations.values()).find(
      (op) => op.metadata?.keysetId === "keyset-B",
    );
    expect(losingOp?.state).toBe("Failed");
    expect(losingOp?.failureCode).toBe(13015);
  });

  it("does not treat a failed CTF redeem with a non-losing mint code as a condemned leg on resume", async () => {
    cashuState.transientFailKeysets.add("keyset-A");
    mockAttestation("A");
    const { settleCtfPosition } = await import("@/lib/cashu");

    const proof = makeProof("sA", 100, "keyset-A", "A");
    const input = {
      conditionId: CONDITION_ID,
      amountSats: 100,
      proofs: [proof],
      mintUrl: "http://mint.test",
    };
    await expect(settleCtfPosition(input)).rejects.toThrow(/network timeout/);
    cashuState.transientFailKeysets.clear();
    cashuState.redeemCalls.length = 0;
    const [operationId, submitted] = [...proofDbState.operations.entries()][0]!;
    proofDbState.operations.set(operationId, {
      ...submitted,
      state: "Failed",
      lastError: "mint rejected duplicate outputs",
      failureCode: 20006,
      updatedAt: Date.now(),
    });

    await expect(settleCtfPosition(input)).rejects.toThrow(
      /non-losing failure code 20006/,
    );

    expect(proofDbState.removedSecrets).toEqual([]);
    expect(cashuState.redeemCalls).toHaveLength(0);
  });

  it("fails closed for an undeployed legacy CTF row without exact request authority", async () => {
    cashuState.transientFailKeysets.add("keyset-A");
    mockAttestation("A");
    const { settleCtfPosition } = await import("@/lib/cashu");

    const proof = makeProof("sA", 100, "keyset-A", "A");
    const input = {
      conditionId: CONDITION_ID,
      amountSats: 100,
      proofs: [proof],
      mintUrl: "http://mint.test",
    };
    await expect(settleCtfPosition(input)).rejects.toThrow(/network timeout/);
    cashuState.transientFailKeysets.clear();
    const [operationId, submitted] = [...proofDbState.operations.entries()][0]!;
    proofDbState.operations.set(operationId, {
      ...submitted,
      state: "Failed",
      metadata: {
        ...submitted.metadata,
        redeemRequestVersion: undefined,
        redeemRequestDigest: undefined,
      },
      lastError: "legacy losing leg",
      updatedAt: Date.now(),
    });

    await expect(settleCtfPosition(input)).rejects.toThrow(
      /request binding is invalid/,
    );
    expect(proofDbState.removedSecrets).toEqual([]);
  });

  it('singular "A" maker claim still redeems the single keyset', async () => {
    cashuState.winningKeysets.add("keyset-A");
    mockAttestation("A");
    const { settleCtfPosition } = await import("@/lib/cashu");

    const proofs = [makeProof("sA", 150, "keyset-A", "A")];
    const regular = await settleCtfPosition({
      conditionId: CONDITION_ID,
      amountSats: 150,
      proofs,
      mintUrl: "http://mint.test",
    });

    expect(regular.reduce((s, p) => s + Number(p.amount), 0)).toBe(150);
    expect(cashuState.redeemCalls).toHaveLength(1);
    expect(proofDbState.removedSecrets).toEqual(["sA"]);
  });

  it("keeps the wallet Web Lock available during CTF mint I/O", async () => {
    cashuState.winningKeysets.add("keyset-A");
    cashuState.requireUnlockedMintIo = true;
    mockAttestation("A");
    const { settleCtfPosition } = await import("@/lib/cashu");

    const regular = await settleCtfPosition({
      conditionId: CONDITION_ID,
      amountSats: 100,
      proofs: [makeProof("sA", 100, "keyset-A", "A")],
      mintUrl: "http://mint.test",
    });

    expect(regular).toHaveLength(1);
    expect(cashuState.redeemCalls).toHaveLength(1);
  });

  it("fails before durable writes or mint effects when the seed changes during redeem preparation", async () => {
    cashuState.winningKeysets.add("keyset-A");
    cashuState.switchWalletOnGetKeys = true;
    mockAttestation("A");
    const { settleCtfPosition } = await import("@/lib/cashu");

    await expect(
      settleCtfPosition({
        conditionId: CONDITION_ID,
        amountSats: 100,
        proofs: [makeProof("sA", 100, "keyset-A", "A")],
        mintUrl: "http://mint.test",
      }),
    ).rejects.toThrow(/wallet changed/);

    expect(proofDbState.operations).toHaveLength(0);
    expect(cashuState.redeemCalls).toHaveLength(0);
    expect(proofDbState.addedProofs).toHaveLength(0);
    expect(proofDbState.removedSecrets).toHaveLength(0);
  });

  it("runs CTF proof-state recovery and retry with the wallet Web Lock available", async () => {
    cashuState.winningKeysets.add("keyset-A");
    cashuState.transientFailKeysets.add("keyset-A");
    mockAttestation("A");
    const cashu = await import("@/lib/cashu");
    const proof = makeProof("sA", 100, "keyset-A", "A");

    await expect(
      cashu.settleCtfPosition({
        conditionId: CONDITION_ID,
        amountSats: 100,
        proofs: [proof],
        mintUrl: "http://mint.test",
      }),
    ).rejects.toThrow(/network timeout/);
    const operation = [...proofDbState.operations.values()][0];
    cashuState.transientFailKeysets.clear();
    cashuState.requireUnlockedMintIo = true;
    cashuState.redeemCalls.length = 0;

    await cashu.recoverGuiCtfRedeemOperation(operation);

    expect(cashuState.redeemCalls).toHaveLength(1);
    expect(proofDbState.operations.get(operation.operationId)?.state).toBe(
      "completed",
    );
  });

  it("does not recover a persisted CTF operation under another seed", async () => {
    cashuState.winningKeysets.add("keyset-A");
    cashuState.transientFailKeysets.add("keyset-A");
    mockAttestation("A");
    const cashu = await import("@/lib/cashu");

    await expect(
      cashu.settleCtfPosition({
        conditionId: CONDITION_ID,
        amountSats: 100,
        proofs: [makeProof("sA", 100, "keyset-A", "A")],
        mintUrl: "http://mint.test",
      }),
    ).rejects.toThrow(/network timeout/);
    const operation = [...proofDbState.operations.values()][0];
    walletLockState.currentWalletId = "bb".repeat(32);
    cashuState.transientFailKeysets.clear();
    cashuState.redeemCalls.length = 0;

    await expect(cashu.recoverGuiCtfRedeemOperation(operation)).rejects.toThrow(
      /wallet lock|wallet seed/,
    );

    expect(cashuState.redeemCalls).toHaveLength(0);
    expect(proofDbState.operations.get(operation.operationId)?.state).toBe(
      "mint-submitted",
    );
    expect(proofDbState.addedProofs).toHaveLength(0);
    expect(proofDbState.removedSecrets).toHaveLength(0);
  });

  it("runs CTF output restoration with the wallet Web Lock available", async () => {
    cashuState.winningKeysets.add("keyset-A");
    cashuState.transientFailKeysets.add("keyset-A");
    mockAttestation("A");
    const cashu = await import("@/lib/cashu");

    await expect(
      cashu.settleCtfPosition({
        conditionId: CONDITION_ID,
        amountSats: 100,
        proofs: [makeProof("sA", 100, "keyset-A", "A")],
        mintUrl: "http://mint.test",
      }),
    ).rejects.toThrow(/network timeout/);
    const operation = [...proofDbState.operations.values()][0];
    cashuState.transientFailKeysets.clear();
    cashuState.proofState = "SPENT";
    cashuState.requireUnlockedMintIo = true;
    cashuState.redeemCalls.length = 0;

    await cashu.recoverGuiCtfRedeemOperation(operation);

    expect(cashuState.restoreCalls).toBe(1);
    expect(cashuState.redeemCalls).toHaveLength(0);
    expect(proofDbState.operations.get(operation.operationId)?.state).toBe(
      "completed",
    );
  });

  it("transient failure on a winning leg retains the submitted operation for exact recovery", async () => {
    cashuState.winningKeysets.add("keyset-A");
    cashuState.transientFailKeysets.add("keyset-A");
    mockAttestation("A");
    const { settleCtfPosition } = await import("@/lib/cashu");

    const proofs = [makeProof("sA", 100, "keyset-A", "A")];
    await expect(
      settleCtfPosition({
        conditionId: CONDITION_ID,
        amountSats: 100,
        proofs,
        mintUrl: "http://mint.test",
      }),
    ).rejects.toThrow(/network timeout/);

    // Winning-leg transient failure must NOT mark the op failed (would block
    // resume) and must NOT remove the still-valuable proofs.
    const op = Array.from(proofDbState.operations.values())[0];
    expect(op.state).toBe("mint-submitted");
    expect(proofDbState.removedSecrets).toEqual([]);
  });
});
