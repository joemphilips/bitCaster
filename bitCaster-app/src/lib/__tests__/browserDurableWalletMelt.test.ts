// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Amount,
  OutputData,
  createBlindSignature,
  createDLEQProof,
  deriveKeysetId,
  pointFromHex,
  type MeltQuoteResponse,
  type Proof,
} from "@cashu/cashu-ts";
import { bytesToHex } from "@noble/curves/utils.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  meltBrowserDurableWallet,
  recoverBrowserDurableWalletMeltsInPass,
  type BrowserDurableWalletMeltContext,
  type BrowserDurableWalletMeltWallet,
} from "../browserDurableWalletMelt";
import {
  BitcasterDB,
  getBoundedCanonicalRegularProofs,
  getCanonicalSelectableProofs,
  storedProofRow,
} from "../../stores/proof-db";
import { createBrowserCustodyProofRow } from "../../stores/durable-custody-db";
import { createBrowserProofBackupAuthorityRow } from "../../stores/browser-proof-backup-authority";
import { browserWalletScope } from "../browserCtfRangeOrderSource";

const requireNewWritePermission = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../browserWalletNewWritePermission", () => ({
  requireBrowserWalletNewWritePermission: requireNewWritePermission,
}));

const MINT = "https://mint.example";
const PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 7]);
const KEYS = { "1": bytesToHex(secp256k1.getPublicKey(PRIVATE_KEY, true)) };
const KEYSET_ID = deriveKeysetId(KEYS, { unit: "msat", versionByte: 1 });
const SEED = new Uint8Array(64).fill(1);
const databases: BitcasterDB[] = [];
let testClock = Date.now();

afterEach(async () => {
  requireNewWritePermission.mockClear();
  requireNewWritePermission.mockResolvedValue(undefined);
  for (const database of databases.splice(0)) {
    database.close();
    await database.delete();
  }
});

describe("browser durable wallet melt", () => {
  it("selects a canonical successor when a retired predecessor remains in the legacy cache", async () => {
    const database = createDatabase();
    const predecessor = proofForOutput(
      OutputData.createSingleData(1, KEYSET_ID, "retired-predecessor", 7n),
    );
    const successor = proofForOutput(
      OutputData.createSingleData(1, KEYSET_ID, "selectable-successor", 11n),
    );
    await seedInput(database, predecessor);
    const rolloverQuote = meltQuote("quote-rollover");
    const rolloverWallet = meltWallet(meltPreview(rolloverQuote, predecessor, successor), {
      state: "PAID",
      change: [successor],
    });
    await meltBrowserDurableWallet({
      quote: rolloverQuote,
      mintUrl: MINT,
      proofs: [predecessor],
      wallet: rolloverWallet,
      context: meltContext(database),
    });
    await database.proofs.put(
      storedProofRow({ ...predecessor, mintUrl: MINT, baseAsset: "sat", unit: "msat" }),
    );

    const selected = await getBoundedCanonicalRegularProofs(
      MINT,
      { scopeId: browserWalletScope(SEED).scopeId, unit: "msat" },
      database,
    );
    expect(selected.map(({ secret }) => secret)).toEqual([successor.secret]);
    expect(
      (await getCanonicalSelectableProofs(browserWalletScope(SEED).scopeId, database))?.map(
        ({ secret }) => secret,
      ),
    ).toEqual([successor.secret]);
    expect(await database.proofs.get(predecessor.secret)).toBeDefined();

    const quote = meltQuote("quote-successor");
    const wallet = meltWallet(meltPreview(quote, successor), { state: "PAID", change: [] });
    await expect(
      meltBrowserDurableWallet({
        quote,
        mintUrl: MINT,
        proofs: [predecessor],
        wallet,
        context: meltContext(database),
      }),
    ).rejects.toThrow("browser wallet melt predecessor custody proof is foreign");
    expect(wallet.prepareMelt).not.toHaveBeenCalled();
    await expect(
      meltBrowserDurableWallet({
        quote,
        mintUrl: MINT,
        proofs: selected,
        wallet,
        context: meltContext(database),
      }),
    ).resolves.toMatchObject({ paid: true });
    expect(wallet.prepareMelt).toHaveBeenCalledOnce();
  });

  it("retires canonical inputs and admits only paid change", async () => {
    const database = createDatabase();
    const input = proofForOutput(OutputData.createSingleData(1, KEYSET_ID, "input", 7n));
    const change = proofForOutput(OutputData.createSingleData(1, KEYSET_ID, "change", 11n));
    const inputProofId = await seedInput(database, input);
    const quote = meltQuote("quote-paid");
    const preview = meltPreview(quote, input, change);
    const wallet = meltWallet(preview, { state: "PAID", change: [change] });

    await expect(
      meltBrowserDurableWallet({
        quote,
        mintUrl: MINT,
        proofs: [input],
        wallet,
        context: meltContext(database),
      }),
    ).resolves.toEqual({ paid: true, change: [change] });

    const rows = await database.custodyProofs.toArray();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.proofId === inputProofId)).toEqual(
      expect.objectContaining({ selectability: "spent" }),
    );
    expect(rows.find((row) => row.proofId !== inputProofId)).toEqual(
      expect.objectContaining({ selectability: "selectable", amount: 1 }),
    );
    expect(await database.proofs.get(input.secret)).toBeUndefined();
    expect(await database.proofs.get(change.secret)).toEqual(
      expect.objectContaining({ mintUrl: MINT, unit: "msat", amount: 1 }),
    );
    expect((await database.custodyOperations.toArray())[0]?.record.operation.state).toBe(
      "reconciled",
    );
    expect(wallet.completeMelt).toHaveBeenCalledOnce();
  });

  it("refuses a new melt before output preparation", async () => {
    const database = createDatabase();
    const input = proofForOutput(OutputData.createSingleData(1, KEYSET_ID, "blocked-input", 7n));
    await seedInput(database, input);
    const quote = meltQuote("quote-blocked");
    const wallet = meltWallet(meltPreview(quote, input), { state: "PAID", change: [] });
    requireNewWritePermission.mockRejectedValueOnce(
      new Error(
        "Another browser changed this wallet. Reload to start recovery before making a new wallet change.",
      ),
    );

    await expect(
      meltBrowserDurableWallet({
        quote,
        mintUrl: MINT,
        proofs: [input],
        wallet,
        context: meltContext(database),
      }),
    ).rejects.toThrow("Another browser changed this wallet");

    expect(wallet.prepareMelt).not.toHaveBeenCalled();
    expect(await database.custodyOperations.count()).toBe(0);
  });

  it("keeps a lost-response reservation and retries the exact persisted preview", async () => {
    const database = createDatabase();
    const input = proofForOutput(OutputData.createSingleData(1, KEYSET_ID, "retry-input", 7n));
    const change = proofForOutput(OutputData.createSingleData(1, KEYSET_ID, "retry-change", 11n));
    await seedInput(database, input);
    const quote = meltQuote("quote-retry");
    const preview = meltPreview(quote, input, change);
    const wallet = meltWallet(preview, { state: "PAID", change: [change] });
    vi.mocked(wallet.completeMelt).mockRejectedValueOnce(new Error("lost melt response"));

    await expect(
      meltBrowserDurableWallet({
        quote,
        mintUrl: MINT,
        proofs: [input],
        wallet,
        context: meltContext(database),
      }),
    ).rejects.toThrow("lost melt response");
    expect((await database.custodyProofs.toArray())[0]?.selectability).toBe("locked");

    requireNewWritePermission.mockClear();
    requireNewWritePermission.mockRejectedValue(
      new Error(
        "Another browser changed this wallet. Reload to start recovery before making a new wallet change.",
      ),
    );
    await expect(
      meltBrowserDurableWallet({
        quote,
        mintUrl: MINT,
        proofs: [],
        wallet,
        context: meltContext(database),
      }),
    ).resolves.toMatchObject({ paid: true, change: [change] });
    expect(requireNewWritePermission).not.toHaveBeenCalled();
    expect(wallet.prepareMelt).toHaveBeenCalledOnce();
    expect(wallet.completeMelt).toHaveBeenCalledOnce();
    expect(wallet.checkMeltQuote).toHaveBeenCalledOnce();
    expect(wallet.createMeltChangeProofs).toHaveBeenCalledOnce();
  });

  it("releases canonical inputs only for a definite unpaid response", async () => {
    const database = createDatabase();
    const input = proofForOutput(OutputData.createSingleData(1, KEYSET_ID, "unpaid-input", 7n));
    await seedInput(database, input);
    const quote = meltQuote("quote-unpaid");
    const preview = meltPreview(quote, input);
    const wallet = meltWallet(preview, { state: "UNPAID", change: [] });

    await expect(
      meltBrowserDurableWallet({
        quote,
        mintUrl: MINT,
        proofs: [input],
        wallet,
        context: meltContext(database),
      }),
    ).resolves.toEqual({ paid: false, change: [] });
    expect((await database.custodyProofs.toArray())[0]?.selectability).toBe("selectable");
    expect((await database.custodyOperations.toArray())[0]?.record.operation.state).toBe("aborted");
  });

  it("commits paid melts with no change without admitting a fabricated proof", async () => {
    const database = createDatabase();
    const input = proofForOutput(OutputData.createSingleData(1, KEYSET_ID, "zero-input", 7n));
    await seedInput(database, input);
    const quote = meltQuote("quote-zero");
    const preview = meltPreview(quote, input);
    const wallet = meltWallet(preview, { state: "PAID", change: [] });

    await expect(
      meltBrowserDurableWallet({
        quote,
        mintUrl: MINT,
        proofs: [input],
        wallet,
        context: meltContext(database),
      }),
    ).resolves.toEqual({ paid: true, change: [] });
    expect(await database.custodyProofs.count()).toBe(1);
    expect((await database.custodyProofs.toArray())[0]?.selectability).toBe("spent");
  });

  it("does not retire inputs for a paid response with a foreign quote", async () => {
    const database = createDatabase();
    const input = proofForOutput(
      OutputData.createSingleData(1, KEYSET_ID, "foreign-quote-input", 7n),
    );
    await seedInput(database, input);
    const quote = meltQuote("quote-authoritative");
    const preview = meltPreview(quote, input);
    const wallet = meltWallet(preview, {
      state: "PAID",
      change: [],
      quote: "quote-not-requested",
    });

    await expect(
      meltBrowserDurableWallet({
        quote,
        mintUrl: MINT,
        proofs: [input],
        wallet,
        context: meltContext(database),
      }),
    ).rejects.toThrow("foreign");
    expect((await database.custodyProofs.toArray())[0]?.selectability).toBe("locked");
    expect((await database.custodyOperations.toArray())[0]?.record.operation.result.state).toBe(
      "none",
    );
  });

  it("resumes an uncertain melt after a coordinator restart without preparing again", async () => {
    const database = createDatabase();
    const input = proofForOutput(OutputData.createSingleData(1, KEYSET_ID, "restart-input", 7n));
    const change = proofForOutput(OutputData.createSingleData(1, KEYSET_ID, "restart-change", 11n));
    await seedInput(database, input);
    const quote = meltQuote("quote-restart");
    const preview = meltPreview(quote, input, change);
    const firstWallet = meltWallet(preview, { state: "PAID", change: [change] });
    vi.mocked(firstWallet.completeMelt).mockRejectedValueOnce(new Error("lost melt response"));

    await expect(
      meltBrowserDurableWallet({
        quote,
        mintUrl: MINT,
        proofs: [input],
        wallet: firstWallet,
        context: meltContext(database),
      }),
    ).rejects.toThrow("lost melt response");

    const recoveredWallet = meltWallet(preview, { state: "PAID", change: [change] });
    await expect(
      recoverBrowserDurableWalletMeltsInPass({
        walletForMint: async () => recoveredWallet,
        context: meltContext(database),
      }),
    ).resolves.toEqual({ pending: 0, hasMore: false, nextCursor: null });
    expect(recoveredWallet.prepareMelt).not.toHaveBeenCalled();
    expect(recoveredWallet.completeMelt).not.toHaveBeenCalled();
    expect(recoveredWallet.checkMeltQuote).toHaveBeenCalledOnce();
    expect(recoveredWallet.createMeltChangeProofs).toHaveBeenCalledOnce();
    expect(await database.proofs.get(input.secret)).toBeUndefined();
    expect(await database.proofs.get(change.secret)).toEqual(
      expect.objectContaining({ mintUrl: MINT, unit: "msat", amount: 1 }),
    );
  });

  it("creates a new attempt after unpaid, then resumes that attempt after uncertainty", async () => {
    const database = createDatabase();
    const input = proofForOutput(OutputData.createSingleData(1, KEYSET_ID, "suffix-input", 7n));
    const change = proofForOutput(OutputData.createSingleData(1, KEYSET_ID, "suffix-change", 11n));
    await seedInput(database, input);
    const quote = meltQuote("quote-suffix");
    const preview = meltPreview(quote, input, change);
    const unpaidWallet = meltWallet(preview, { state: "UNPAID", change: [] });

    await expect(
      meltBrowserDurableWallet({
        quote,
        mintUrl: MINT,
        proofs: [input],
        wallet: unpaidWallet,
        context: meltContext(database),
      }),
    ).resolves.toEqual({ paid: false, change: [] });

    const uncertainWallet = meltWallet(preview, { state: "PAID", change: [change] });
    vi.mocked(uncertainWallet.completeMelt).mockRejectedValueOnce(new Error("lost melt response"));
    await expect(
      meltBrowserDurableWallet({
        quote,
        mintUrl: MINT,
        proofs: [input],
        wallet: uncertainWallet,
        context: meltContext(database),
      }),
    ).rejects.toThrow("lost melt response");
    expect(uncertainWallet.prepareMelt).toHaveBeenCalledOnce();

    const retryWallet = meltWallet(preview, { state: "PAID", change: [change] });
    await expect(
      meltBrowserDurableWallet({
        quote,
        mintUrl: MINT,
        proofs: [input],
        wallet: retryWallet,
        context: meltContext(database),
      }),
    ).resolves.toEqual({ paid: true, change: [change] });
    expect(retryWallet.prepareMelt).not.toHaveBeenCalled();
    expect(retryWallet.completeMelt).not.toHaveBeenCalled();
    expect(retryWallet.checkMeltQuote).toHaveBeenCalledOnce();
    expect(retryWallet.createMeltChangeProofs).toHaveBeenCalledOnce();

    const terminalReplayWallet = meltWallet(preview, { state: "PAID", change: [change] });
    await expect(
      meltBrowserDurableWallet({
        quote,
        mintUrl: MINT,
        proofs: [input],
        wallet: terminalReplayWallet,
        context: meltContext(database),
      }),
    ).resolves.toEqual({ paid: true, change: [change] });
    expect(terminalReplayWallet.prepareMelt).not.toHaveBeenCalled();
    expect(terminalReplayWallet.completeMelt).not.toHaveBeenCalled();
  });

  it("keeps a pending recovery held and does not release on status alone", async () => {
    const database = createDatabase();
    const input = proofForOutput(OutputData.createSingleData(1, KEYSET_ID, "pending-input", 7n));
    await seedInput(database, input);
    const quote = meltQuote("quote-pending");
    const preview = meltPreview(quote, input);
    const firstWallet = meltWallet(preview, { state: "PAID", change: [] });
    vi.mocked(firstWallet.completeMelt).mockRejectedValueOnce(new Error("lost melt response"));
    await expect(
      meltBrowserDurableWallet({
        quote,
        mintUrl: MINT,
        proofs: [input],
        wallet: firstWallet,
        context: meltContext(database),
      }),
    ).rejects.toThrow("lost melt response");

    const recoveryWallet = meltWallet(preview, { state: "PENDING", change: [] });
    await expect(
      recoverBrowserDurableWalletMeltsInPass({
        walletForMint: async () => recoveryWallet,
        context: meltContext(database),
      }),
    ).resolves.toEqual({ pending: 1, hasMore: false, nextCursor: null });
    expect(recoveryWallet.completeMelt).not.toHaveBeenCalled();
    expect((await database.custodyProofs.toArray())[0]?.selectability).toBe("locked");
  });

  it("resends an unpaid recovery and confirms paid after an ambiguous error", async () => {
    const database = createDatabase();
    const input = proofForOutput(OutputData.createSingleData(1, KEYSET_ID, "ambiguous-input", 7n));
    const change = proofForOutput(
      OutputData.createSingleData(1, KEYSET_ID, "ambiguous-change", 11n),
    );
    await seedInput(database, input);
    const quote = meltQuote("quote-ambiguous");
    const preview = meltPreview(quote, input, change);
    const firstWallet = meltWallet(preview, { state: "PAID", change: [change] });
    vi.mocked(firstWallet.completeMelt).mockRejectedValueOnce(new Error("already paid"));
    await expect(
      meltBrowserDurableWallet({
        quote,
        mintUrl: MINT,
        proofs: [input],
        wallet: firstWallet,
        context: meltContext(database),
      }),
    ).rejects.toThrow("already paid");

    const recoveryWallet = meltWallet(preview, { state: "PAID", change: [change] });
    vi.mocked(recoveryWallet.checkMeltQuote)
      .mockResolvedValueOnce({ quote: quote.quote, state: "UNPAID", change: [] })
      .mockResolvedValueOnce({ quote: quote.quote, state: "PAID", change: [] });
    vi.mocked(recoveryWallet.completeMelt).mockRejectedValueOnce(new Error("already paid"));
    await expect(
      recoverBrowserDurableWalletMeltsInPass({
        walletForMint: async () => recoveryWallet,
        context: meltContext(database),
      }),
    ).resolves.toEqual({ pending: 0, hasMore: false, nextCursor: null });
    expect(recoveryWallet.checkMeltQuote).toHaveBeenCalledTimes(2);
    expect(recoveryWallet.completeMelt).toHaveBeenCalledOnce();
    expect(recoveryWallet.createMeltChangeProofs).toHaveBeenCalledOnce();
    expect(await database.proofs.get(input.secret)).toBeUndefined();
    expect(await database.proofs.get(change.secret)).toEqual(
      expect.objectContaining({ mintUrl: MINT, unit: "msat", amount: 1 }),
    );
  });

  it("does not release when an unpaid status and safe resend remain unresolved", async () => {
    const database = createDatabase();
    const input = proofForOutput(
      OutputData.createSingleData(1, KEYSET_ID, "unpaid-held-input", 7n),
    );
    await seedInput(database, input);
    const quote = meltQuote("quote-unpaid-held");
    const preview = meltPreview(quote, input);
    const firstWallet = meltWallet(preview, { state: "PAID", change: [] });
    vi.mocked(firstWallet.completeMelt).mockRejectedValueOnce(new Error("lost melt response"));
    await expect(
      meltBrowserDurableWallet({
        quote,
        mintUrl: MINT,
        proofs: [input],
        wallet: firstWallet,
        context: meltContext(database),
      }),
    ).rejects.toThrow("lost melt response");

    const recoveryWallet = meltWallet(preview, { state: "UNPAID", change: [] });
    vi.mocked(recoveryWallet.checkMeltQuote)
      .mockResolvedValueOnce({ quote: quote.quote, state: "UNPAID", change: [] })
      .mockResolvedValueOnce({ quote: quote.quote, state: "UNPAID", change: [] });
    vi.mocked(recoveryWallet.completeMelt).mockRejectedValueOnce(new Error("ambiguous retry"));
    await expect(
      recoverBrowserDurableWalletMeltsInPass({
        walletForMint: async () => recoveryWallet,
        context: meltContext(database),
      }),
    ).resolves.toEqual({ pending: 1, hasMore: false, nextCursor: null });
    expect(recoveryWallet.completeMelt).toHaveBeenCalledOnce();
    expect(recoveryWallet.checkMeltQuote).toHaveBeenCalledTimes(2);
    expect((await database.custodyProofs.toArray())[0]?.selectability).toBe("locked");
  });

  it.each(["before-commit", "after-commit"] as const)(
    "keeps canonical and legacy custody coupled across a %s fault",
    async (fault) => {
      const database = createDatabase();
      const input = proofForOutput(OutputData.createSingleData(1, KEYSET_ID, `fault-${fault}`, 7n));
      const change = proofForOutput(
        OutputData.createSingleData(1, KEYSET_ID, `fault-change-${fault}`, 11n),
      );
      const inputProofId = await seedInput(database, input);
      const quote = meltQuote(`quote-fault-${fault}`);
      const preview = meltPreview(quote, input, change);
      const faults: {
        value?: "before-commit" | "after-commit";
        phase?: "stage" | "apply";
      } = { value: fault, phase: "apply" };
      const context = meltContext(database, faults);
      const wallet = meltWallet(preview, { state: "PAID", change: [change] });

      await expect(
        meltBrowserDurableWallet({
          quote,
          mintUrl: MINT,
          proofs: [input],
          wallet,
          context,
        }),
      ).rejects.toThrow(`injected browser custody fault ${fault.replace("-", " ")}`);
      if (fault === "before-commit") {
        expect(await database.proofs.get(input.secret)).toEqual(
          expect.objectContaining({ mintUrl: MINT, unit: "msat", amount: 1 }),
        );
        expect(await database.proofs.get(change.secret)).toBeUndefined();
        expect(
          (await database.custodyProofs.get([browserWalletScope(SEED).scopeId, inputProofId]))
            ?.selectability,
        ).toBe("locked");
      } else {
        expect(await database.proofs.get(input.secret)).toBeUndefined();
        expect(await database.proofs.get(change.secret)).toEqual(
          expect.objectContaining({ mintUrl: MINT, unit: "msat", amount: 1 }),
        );
        expect(
          (await database.custodyProofs.get([browserWalletScope(SEED).scopeId, inputProofId]))
            ?.selectability,
        ).toBe("spent");
      }

      faults.value = undefined;
      await expect(
        meltBrowserDurableWallet({
          quote,
          mintUrl: MINT,
          proofs: [input],
          wallet,
          context,
        }),
      ).resolves.toEqual({ paid: true, change: [change] });
      expect(await database.proofs.get(input.secret)).toBeUndefined();
      expect(await database.proofs.get(change.secret)).toEqual(
        expect.objectContaining({ mintUrl: MINT, unit: "msat", amount: 1 }),
      );
    },
  );
});

function createDatabase(): BitcasterDB {
  const database = new BitcasterDB(`browser-durable-melt-${crypto.randomUUID()}`);
  databases.push(database);
  return database;
}

function meltContext(
  database: BitcasterDB,
  faults: {
    value?: "before-commit" | "after-commit";
    phase?: "stage" | "apply";
  } = {},
): BrowserDurableWalletMeltContext {
  return {
    seed: SEED,
    database,
    now: () => ++testClock,
    get injectFault() {
      return faults.value;
    },
    get injectFaultPhase() {
      return faults.phase;
    },
    randomId: (() => {
      let value = 0;
      return () => `melt-${++value}`;
    })(),
    lockManager: {
      request: async (_name: string, _options: LockOptions, callback: () => Promise<unknown>) =>
        callback(),
    } as Pick<LockManager, "request">,
    requireCapturedProfile: () => undefined,
  };
}

async function seedInput(database: BitcasterDB, proof: Proof): Promise<string> {
  const row = createBrowserCustodyProofRow({
    scopeId: browserWalletScope(SEED).scopeId,
    normalizedMint: MINT,
    unit: "msat",
    proof,
    asset: { kind: "regular" },
    receivedAtMs: 1,
  });
  await database.custodyProofs.put(row);
  await database.custodyProofBackupAuthorities.put(
    createBrowserProofBackupAuthorityRow(row, 1, null, "initial-admission"),
  );
  await database.proofs.put(
    storedProofRow({ ...proof, mintUrl: MINT, baseAsset: "sat", unit: "msat" }),
  );
  return row.proofId;
}

function meltQuote(quote: string): MeltQuoteResponse {
  return {
    quote,
    amount: Amount.from(1),
    unit: "msat",
    state: "UNPAID",
    expiry: 2_000,
    request: "lnbc-test",
    fee_reserve: Amount.from(1),
    payment_preimage: null,
  };
}

function meltPreview(quote: MeltQuoteResponse, input: Proof, change?: Proof) {
  return {
    method: "bolt11",
    inputs: [input],
    outputData:
      change === undefined ? [] : [OutputData.createSingleData(1, KEYSET_ID, change.secret, 11n)],
    keysetId: KEYSET_ID,
    quote,
  };
}

function meltWallet(
  preview: ReturnType<typeof meltPreview>,
  response: { state: string; change: Proof[]; quote?: string },
): BrowserDurableWalletMeltWallet {
  return {
    prepareMelt: vi.fn(async () => preview),
    completeMelt: vi.fn(async () => ({
      quote: { quote: response.quote ?? preview.quote.quote, state: response.state },
      change: response.change,
    })),
    checkMeltQuote: vi.fn(async (_method: string, quote: string) => ({
      quote,
      state: response.state as MeltQuoteResponse["state"],
      change: response.change.map(() => ({
        id: KEYSET_ID,
        amount: Amount.from(1),
        C_: "02" + "11".repeat(32),
      })),
    })),
    createMeltChangeProofs: vi.fn(() => response.change),
    getKeyset: vi.fn(() => ({
      id: KEYSET_ID,
      unit: "msat",
      keys: KEYS,
      fee: 0,
      verify: () => true,
    })),
  };
}

function proofForOutput(output: OutputData): Proof {
  const signature = createBlindSignature(
    pointFromHex(output.blindedMessage.B_),
    PRIVATE_KEY,
    KEYSET_ID,
  );
  const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), PRIVATE_KEY);
  return output.toProof(
    {
      id: KEYSET_ID,
      amount: output.blindedMessage.amount,
      C_: signature.C_.toHex(true),
      dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
    },
    { id: KEYSET_ID, keys: KEYS },
  );
}
