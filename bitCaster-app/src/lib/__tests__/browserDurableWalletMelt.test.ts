// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Amount,
  Wallet,
  Mint,
  type CounterSource,
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
import {
  createBrowserCustodyProofRow,
  BrowserDurableCustodyAdapter,
} from "../../stores/durable-custody-db";
import Dexie from "dexie";
import { createSpeculativeCounterTranscript } from "@bitcaster/client-sdk/speculativeCounterTranscript";
import {
  serializeDurableWalletMeltOperation,
  toDurableCustodyProofOperationInput,
} from "@bitcaster/client-sdk/durableWalletOperation";
import { prepareDurableCustodyMintOperationAuthority } from "@bitcaster/client-sdk/durableCustodyMintResult";
import {
  createDurableCustodyProofOperation,
  bindDurableCustodyProofOperation,
} from "@bitcaster/client-sdk/durableCustodyProofOperationRecord";
import { createBrowserProofBackupAuthorityRow } from "../../stores/browser-proof-backup-authority";
import { browserWalletScope } from "../browserCtfRangeOrderSource";

import { BrowserWalletCounterDexieStore } from "../../stores/browser-wallet-counter-db";
import { browserWalletDatabaseName } from "../browserWalletProfile";
const privateDraft = vi.hoisted(() => ({
  create: undefined as
    | undefined
    | ((
        source: import("@cashu/cashu-ts").CounterSource,
      ) => BrowserDurableWalletMeltWallet | Promise<BrowserDurableWalletMeltWallet>),
}));
vi.mock("../../stores/wallet", () => ({
  createUncachedWalletForSeedUnit: async (input: {
    counterSource: import("@cashu/cashu-ts").CounterSource;
  }) => privateDraft.create!(input.counterSource),
}));

import {
  createEncryptedWalletBackupOwnerCurrentHead,
  collectEncryptedWalletBackupOwnerDescriptorPages,
  enumerateEncryptedWalletBackupOwnerDescriptorPages,
} from "@bitcaster/client-sdk/encryptedWalletBackupOwnerHead";
import { EncryptedWalletBackupOwnerDexieAuthorityStore } from "../../stores/encrypted-wallet-backup-owner-db";
const requireNewWritePermission = vi.hoisted(() =>
  vi.fn(async (_input: { database: BitcasterDB; scopeId: string }): Promise<void> => undefined),
);

vi.mock("../browserWalletNewWritePermission", () => ({
  requireBrowserWalletNewWritePermission: requireNewWritePermission,
}));

const MINT = "https://mint.example";
const PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 7]);
const FOUR_PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 9]);
const TWO_PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 8]);
const KEYS = {
  "1": bytesToHex(secp256k1.getPublicKey(PRIVATE_KEY, true)),
  "2": bytesToHex(secp256k1.getPublicKey(TWO_PRIVATE_KEY, true)),
  "4": bytesToHex(secp256k1.getPublicKey(FOUR_PRIVATE_KEY, true)),
};
const KEYSET_ID = deriveKeysetId(KEYS, { unit: "msat", versionByte: 1, input_fee_ppk: 0 });
const SEED = new Uint8Array(64).fill(1);
const databases: BitcasterDB[] = [];
let testClock = Date.now();

afterEach(async () => {
  vi.unstubAllEnvs();
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
      OutputData.createSingleData(2, KEYSET_ID, "retired-predecessor", 7n),
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
    const input = proofForOutput(OutputData.createSingleData(2, KEYSET_ID, "input", 7n));
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
    const input = proofForOutput(OutputData.createSingleData(2, KEYSET_ID, "blocked-input", 7n));
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
    const input = proofForOutput(OutputData.createSingleData(2, KEYSET_ID, "retry-input", 7n));
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
    const input = proofForOutput(OutputData.createSingleData(2, KEYSET_ID, "unpaid-input", 7n));
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
    const input = proofForOutput(OutputData.createSingleData(2, KEYSET_ID, "zero-input", 7n));
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
      OutputData.createSingleData(2, KEYSET_ID, "foreign-quote-input", 7n),
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
    const input = proofForOutput(OutputData.createSingleData(2, KEYSET_ID, "restart-input", 7n));
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
    const input = proofForOutput(OutputData.createSingleData(2, KEYSET_ID, "suffix-input", 7n));
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
    const input = proofForOutput(OutputData.createSingleData(2, KEYSET_ID, "pending-input", 7n));
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
    const input = proofForOutput(OutputData.createSingleData(2, KEYSET_ID, "ambiguous-input", 7n));
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
      OutputData.createSingleData(2, KEYSET_ID, "unpaid-held-input", 7n),
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
      const input = proofForOutput(OutputData.createSingleData(2, KEYSET_ID, `fault-${fault}`, 7n));
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
          expect.objectContaining({ mintUrl: MINT, unit: "msat", amount: 2 }),
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

describe("browser melt real private counter preparation", () => {
  it.each(["counter-written", "journal-bound"] as const)(
    "rolls back all authority at %s",
    async (phase) => {
      const f = await realMeltFixture();
      const before = await preparationFacts(f.database);
      f.context.injectPreparationFault = (at) => {
        if (at === phase) throw new Error("preparation rollback");
      };
      await expect(f.run()).rejects.toThrow("preparation rollback");
      expect(await preparationFacts(f.database)).toEqual(before);
      expect(f.complete).not.toHaveBeenCalled();
    },
  );

  it("lets actual Cashu reserve exactly two blanks for overage3", async () => {
    const f = await realMeltFixture({ inputAmount: 4 });
    const result = await f.run();
    expect(result.paid).toBe(true);
    expect(f.complete).toHaveBeenCalledOnce();
    expect(f.drafts).toHaveLength(1);
    expect(
      f.drafts[0]!.map((output) => ({
        id: output.blindedMessage.id,
        amount: Amount.from(output.blindedMessage.amount).toString(),
      })),
    ).toEqual([
      { id: KEYSET_ID, amount: "0" },
      { id: KEYSET_ID, amount: "0" },
    ]);
    expect((await f.database.walletCounterCursors.toArray())[0]?.next).toBe(2);
    expect(result.change).toHaveLength(2);
    expect(f.ranges).toEqual([{ keysetId: KEYSET_ID, start: 0, count: 2, next: 2 }]);
  });

  it("checks real owner permission within the joint readwrite transaction", async () => {
    const f = await realMeltFixture();
    const permission = await vi.importActual<typeof import("../browserWalletNewWritePermission")>(
      "../browserWalletNewWritePermission",
    );
    vi.stubEnv("VITE_ENCRYPTED_BACKUP_REALM", "backup.example");
    vi.stubEnv("VITE_ENCRYPTED_BACKUP_SIGNED_ORIGIN", "https://backup.example");
    vi.stubEnv("VITE_ENCRYPTED_BACKUP_RECEIPT_KEY_ID", "55".repeat(16));
    vi.stubEnv(
      "VITE_ENCRYPTED_BACKUP_RECEIPT_PUBLIC_KEY",
      "531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337",
    );
    const scopeId = browserWalletScope(SEED).scopeId;
    const session = permission.beginBrowserWalletBackupAuthenticationSession({
      database: f.database,
      scopeId,
      realm: "backup.example",
    });
    expect(session.markOwnerAuthenticated("aa".repeat(32), 1, "bb".repeat(32))).toBe(true);
    const context = {
      ownerScopeId: "aa".repeat(32),
      realm: "backup.example",
      walletId: scopeId.slice("custody:wallet:".length),
      enrollmentEpoch: 1,
    };
    const head = createEncryptedWalletBackupOwnerCurrentHead({
      ...context,
      headVersion: 0,
      bundles: [],
    });
    const evidence = collectEncryptedWalletBackupOwnerDescriptorPages(
      enumerateEncryptedWalletBackupOwnerDescriptorPages({ head, bundles: [] }),
      context,
    );
    const store = new EncryptedWalletBackupOwnerDexieAuthorityStore({
      ...context,
      database: f.database,
      scopeId,
      requestAuthPublicKey: "bb".repeat(32),
      isCurrent: () => true,
    });
    expect(await store.acceptCurrentHead({ expectedHeadVersion: null, evidence })).toBe("accepted");
    requireNewWritePermission.mockImplementation(permission.requireBrowserWalletNewWritePermission);
    const table = f.database.encryptedWalletBackupOwnerAcceptedHeads;
    const original = table.get.bind(table);
    const modes: string[] = [];
    const spy = vi.spyOn(table, "get").mockImplementation((...args: unknown[]) => {
      modes.push(Dexie.currentTransaction!.idbtrans.mode);
      return original(...(args as [never]));
    });
    try {
      await expect(f.run()).resolves.toMatchObject({ paid: true });
      expect(modes.filter((mode) => mode === "readwrite").length).toBeGreaterThanOrEqual(2);
    } finally {
      spy.mockRestore();
      session.stop();
    }
  });

  it("commits real NUT08 blanks at counter0 and reuses saved bytes after lost COMMIT reply", async () => {
    const f = await realMeltFixture();
    f.context.injectPreparationFault = (phase) => {
      if (phase === "after-commit") throw new Error("lost commit reply");
    };
    const result = await f.run();
    expect(result.paid).toBe(true);
    expect(result.change).toHaveLength(1);
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.status).toHaveBeenCalledOnce();
    expect(f.drafts).toHaveLength(1);
    expect(
      f.drafts[0]!.map((output) => Amount.from(output.blindedMessage.amount).toString()),
    ).toEqual(["0"]);
    expect((await f.database.walletCounterCursors.toArray())[0]?.next).toBe(1);
    expect(
      (await f.database.custodyProofs.toArray()).filter(
        (row) => row.selectability === "selectable",
      ),
    ).toHaveLength(1);
  });

  it("rebuilds only three typed conflicts without dispatching or changing the quote", async () => {
    const f = await realMeltFixture();
    const store = new BrowserWalletCounterDexieStore({
      database: f.database,
      scopeId: browserWalletScope(SEED).scopeId,
      isCurrentProfile: () => true,
    });
    let attempts = 0;
    f.context.observePrepared = async () => {
      attempts++;
      await store.reserveInContext({ mintUrl: MINT, unit: "msat" }, KEYSET_ID, 1, true);
    };
    await expect(f.run()).rejects.toThrow("counter snapshot changed");
    expect(attempts).toBe(3);
    expect(f.drafts).toHaveLength(3);
    expect(f.complete).not.toHaveBeenCalled();
    expect(await f.database.custodyOperations.count()).toBe(0);
    expect((await f.database.walletCounterCursors.toArray())[0]?.next).toBe(3);
  });

  it("refuses profile loss at the final preparation write and rolls back", async () => {
    const f = await realMeltFixture();
    const before = await preparationFacts(f.database);
    let current = true;
    f.context.requireCapturedProfile = () => {
      if (!current) throw new Error("profile lost");
    };
    f.context.injectPreparationFault = (phase) => {
      if (phase === "journal-bound") current = false;
    };
    await expect(f.run()).rejects.toThrow("profile lost");
    expect(await preparationFacts(f.database)).toEqual(before);
    expect(f.complete).not.toHaveBeenCalled();
  });

  it("recovers the exact differing committed winner before CAS", async () => {
    const f = await realMeltFixture();
    const store = new BrowserWalletCounterDexieStore({
      database: f.database,
      scopeId: browserWalletScope(SEED).scopeId,
      isCurrentProfile: () => true,
    });
    let winnerPoints: string[] = [];
    let loserPoints: string[] = [];
    f.context.observePrepared = async (draft) => {
      loserPoints = draft.preview.outputData.map((output) => output.blindedMessage.B_);
      await store.reserveInContext({ mintUrl: MINT, unit: "msat" }, KEYSET_ID, 7, true);
      const transcript = createSpeculativeCounterTranscript([
        await store.readSnapshotInContext({ mintUrl: MINT, unit: "msat" }, KEYSET_ID),
      ]);
      const wallet = await privateDraft.create!(transcript.counterSource);
      const preview = await wallet.prepareMelt("bolt11", f.quote, [f.input], {
        keysetId: KEYSET_ID,
        onCountersReserved: () => undefined,
      });
      const operation = serializeDurableWalletMeltOperation({
        operationId: draft.operationId,
        mintUrl: MINT,
        unit: "msat",
        preview,
      });
      winnerPoints = operation.preview.outputData.map((output) => output.blindedMessage.B_);
      const custody = toDurableCustodyProofOperationInput(operation);
      const authority = prepareDurableCustodyMintOperationAuthority({
        operation: custody,
        keysets: [
          {
            canonicalMintUrl: MINT,
            id: KEYSET_ID,
            unit: "msat",
            keys: KEYS,
            inputFeePpk: 0,
            finalExpiry: null,
            identity: { kind: "regular" },
          },
        ],
      });
      const scope = browserWalletScope(SEED);
      const record = createDurableCustodyProofOperation({
        scope,
        operation: custody,
        facts: authority.facts,
        inventoryAccountId: null,
        exactBoundary: {
          method: "POST",
          path: "/v1/melt/bolt11",
          idempotencyKey: operation.operationId,
          requestBody: authority.exactRequest,
          output: authority.exactOutput,
          privateMaterial: authority.exactAuthority,
        },
      });
      const artifacts = {
        requestBody: authority.exactRequest,
        output: authority.exactOutput,
        privateMaterial: authority.exactAuthority,
      };
      const state = (await f.database.custodyScopes.get(scope.scopeId))!.state;
      const predecessor = (await f.database.custodyProofs.toArray())[0]!;
      await f.database.transaction(
        "rw",
        [
          f.database.custodyScopes,
          f.database.custodyOperations,
          f.database.custodyArtifacts,
          f.database.custodyProofs,
          f.database.custodyReservations,
          f.database.custodyActiveWork,
          f.database.custodyProofBackupAuthorities,
          f.database.custodyConditionalKeysets,
          f.database.encryptedWalletBackupV2DesiredAssets,
          f.database.walletCounterAssociations,
          f.database.walletCounterCursors,
        ],
        async () => {
          await store.compareAndAdvanceInCurrentTransaction(
            Dexie.currentTransaction!,
            { mintUrl: MINT, unit: "msat" },
            transcript.changes()[0]!,
          );
          await new BrowserDurableCustodyAdapter(f.database).transactInCurrentTransaction(
            Dexie.currentTransaction!,
            {
              scope,
              owner: {
                incarnationId: state.owner!.incarnationId,
                fencingEpoch: state.fencingEpoch,
                observedAtMs: f.context.now!(),
              },
              operationRows: [
                { operationId: record.operation.operationId, expectedRevision: null },
              ],
            },
            (transaction) => bindDurableCustodyProofOperation(transaction, record, artifacts),
            { predecessorProofs: { [record.operation.operationId]: [predecessor] } },
          );
        },
      );
    };
    const beforeStatus = f.status.getMockImplementation()!;
    f.status.mockImplementation(async () => {
      expect(winnerPoints).not.toEqual(loserPoints);
      const row = (await f.database.custodyOperations.toArray())[0]!;
      const saved = await new BrowserDurableCustodyAdapter(f.database).readOperationSnapshot(
        browserWalletScope(SEED),
        row.operationId,
      );
      expect(saved).not.toBeNull();
      return beforeStatus();
    });
    const result = await f.run();
    expect(result.paid).toBe(true);
    expect(result.change[0]?.secret).toBe(new TextDecoder().decode(f.drafts[1]![0]!.secret));
    expect(result.change[0]?.secret).not.toBe(new TextDecoder().decode(f.drafts[0]![0]!.secret));
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.status).toHaveBeenCalledOnce();
    expect((await f.database.walletCounterCursors.toArray())[0]?.next).toBe(8);
    expect(await f.database.custodyOperations.count()).toBe(1);
    const recovered = (await f.database.custodyProofs.toArray()).find(
      (row) => row.selectability === "selectable",
    )!;
    expect(recovered).toBeDefined();
  });

  it("refuses takeover on uncertain readback before status or completion I/O", async () => {
    const f = await realMeltFixture();
    f.context.injectPreparationFault = (phase) => {
      if (phase === "after-commit") throw new Error("lost reply");
    };
    const original = BrowserDurableCustodyAdapter.prototype.readOperationSnapshot;
    let takeover = false;
    const spy = vi
      .spyOn(BrowserDurableCustodyAdapter.prototype, "readOperationSnapshot")
      .mockImplementation(async function (this: BrowserDurableCustodyAdapter, scope, id) {
        const snapshot = await original.call(this, scope, id);
        if (!takeover && snapshot !== null && Dexie.currentTransaction === null) {
          takeover = true;
          const at = testClock + 20 * 60 * 1000;
          f.context.now = () => at + 1;
          await this.claimScope(scope, {
            incarnationId: "replacement-owner",
            observedAtMs: at,
            leaseExpiresAtMs: at + 600000,
          });
        }
        return snapshot;
      });
    try {
      await expect(f.run()).rejects.toThrow();
      expect(takeover).toBe(true);
      expect(f.status).not.toHaveBeenCalled();
      expect(f.complete).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("uses no counter association for inactive V2 no-change withdrawal", async () => {
    const f = await realMeltFixture({ noChange: true });
    await f.database.walletCounterAssociations.clear();
    await f.database.walletCounterCursors.clear();
    await expect(f.run()).resolves.toMatchObject({ paid: true, change: [] });
    expect(await f.database.walletCounterAssociations.count()).toBe(0);
    expect(await f.database.walletCounterCursors.count()).toBe(0);
    expect(f.drafts).toHaveLength(0);
    expect(f.complete).toHaveBeenCalledOnce();
  });

  it("rejects duplicate reservation callbacks without durable authority", async () => {
    const f = await realMeltFixture();
    const create = privateDraft.create!;
    privateDraft.create = async (source) => {
      const wallet = await create(source);
      const prepare = wallet.prepareMelt.bind(wallet);
      wallet.prepareMelt = async (method, quote, proofs, config) => {
        let range: import("@cashu/cashu-ts").OperationCounters | undefined;
        const preview = await prepare(method, quote, proofs, {
          keysetId: config!.keysetId,
          onCountersReserved: (value) => {
            range = value;
            config!.onCountersReserved(value);
          },
        });
        config!.onCountersReserved(range!);
        return preview;
      };
      return wallet;
    };
    const before = await preparationFacts(f.database);
    await expect(f.run()).rejects.toThrow("counter transcript conflicts");
    expect(await preparationFacts(f.database)).toEqual(before);
    expect(f.complete).not.toHaveBeenCalled();
  });

  it("does not turn corrupt committed artifacts into successful readback", async () => {
    const f = await realMeltFixture();
    f.context.injectPreparationFault = (phase) => {
      if (phase === "after-commit") throw new Error("lost reply");
    };
    const original = BrowserDurableCustodyAdapter.prototype.readOperationSnapshot;
    let corrupted = false;
    const spy = vi
      .spyOn(BrowserDurableCustodyAdapter.prototype, "readOperationSnapshot")
      .mockImplementation(async function (this: BrowserDurableCustodyAdapter, scope, id) {
        if (
          !corrupted &&
          Dexie.currentTransaction === null &&
          (await f.database.custodyOperations.count()) === 1
        ) {
          corrupted = true;
          await f.database.custodyArtifacts.clear();
        }
        return original.call(this, scope, id);
      });
    try {
      await expect(f.run()).rejects.toThrow();
      expect(corrupted).toBe(true);
      expect(f.complete).not.toHaveBeenCalled();
      expect(f.status).not.toHaveBeenCalled();
      expect((await f.database.walletCounterCursors.toArray())[0]?.next).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("preserves the durable SDK legacy-keyset refusal for no-change", async () => {
    const f = await realMeltFixture({ noChange: true, legacy: true });
    await f.database.walletCounterAssociations.clear();
    await expect(f.run()).rejects.toThrow();
    expect(await f.database.custodyOperations.count()).toBe(0);
    expect(f.complete).not.toHaveBeenCalled();
  });

  it("refuses changed canonical signed input bytes before counter commit", async () => {
    const f = await realMeltFixture();
    f.context.observePrepared = async () => {
      const row = (await f.database.custodyProofs.toArray())[0]!;
      // Publish a valid replacement denomination and its matching backup authority.
      const replacement = createBrowserCustodyProofRow({
        scopeId: row.scopeId,
        normalizedMint: MINT,
        unit: "msat",
        asset: { kind: "regular" },
        receivedAtMs: 1,
        proof: proofForOutput(OutputData.createSingleData(1, KEYSET_ID, "real-input", 7n)),
      });
      const updated = { ...replacement, revision: row.revision + 1 };
      await f.database.custodyProofs.put(updated);
      await f.database.custodyProofBackupAuthorities.put(
        createBrowserProofBackupAuthorityRow(updated, 2, null, "initial-admission"),
      );
    };
    await expect(f.run()).rejects.toThrow("source material changed");
    expect(await f.database.custodyOperations.count()).toBe(0);
    expect((await f.database.walletCounterCursors.toArray())[0]?.next ?? 0).toBe(0);
    expect(f.complete).not.toHaveBeenCalled();
  });
});

async function preparationFacts(database: BitcasterDB) {
  const tables = [
    database.custodyOperations,
    database.custodyArtifacts,
    database.custodyProofs,
    database.custodyReservations,
    database.custodyActiveWork,
    database.custodyProofBackupAuthorities,
    database.custodyConditionalKeysets,
    database.encryptedWalletBackupV2DesiredAssets,
    database.walletCounterAssociations,
    database.walletCounterCursors,
    database.encryptedWalletBackupOwnerAcceptedHeads,
    database.encryptedWalletBackupV2AcceptedHeads,
  ];
  return Promise.all(tables.map((table) => table.orderBy(":id").toArray()));
}

async function realMeltFixture(
  options: { noChange?: boolean; legacy?: boolean; inputAmount?: 2 | 4 } = {},
) {
  const database = createDatabase();
  const input = proofForOutput(
    OutputData.createSingleData(options.inputAmount ?? 2, KEYSET_ID, "real-input", 7n),
  );
  await seedInput(database, input);
  const quote = meltQuote("real-quote");
  quote.amount = Amount.from(options.noChange ? (options.inputAmount ?? 2) : 1);
  const context: {
    -readonly [P in keyof BrowserDurableWalletMeltContext]: BrowserDurableWalletMeltContext[P];
  } = meltContext(database);
  const drafts: OutputData[][] = [];
  const ranges: import("@cashu/cashu-ts").OperationCounters[] = [];
  let change: Proof[] = [];
  const complete = vi.fn(
    async (preview: import("@cashu/cashu-ts").MeltPreview<Pick<MeltQuoteResponse, "quote">>) => {
      change = preview.outputData.map((output) => realBlankProof(output as OutputData));
      return {
        quote: { quote: quote.quote, state: "PAID" },
        change,
        outputData: preview.outputData,
      };
    },
  );
  const status = vi.fn(async () => ({
    quote: quote.quote,
    state: "PAID" as const,
    change: (drafts.at(-1) ?? []).map((output) => ({
      id: KEYSET_ID,
      amount: Amount.from(1),
      C_: createBlindSignature(
        pointFromHex(output.blindedMessage.B_),
        PRIVATE_KEY,
        KEYSET_ID,
      ).C_.toHex(true),
      dleq: (() => {
        const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), PRIVATE_KEY);
        return { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) };
      })(),
    })),
  }));
  const selectedId = options.legacy
    ? deriveKeysetId(KEYS, { unit: "msat", versionByte: 0 })
    : KEYSET_ID;
  const create = async (source?: CounterSource) => {
    const mint = new Mint(MINT);
    mint.getInfo = async () => ({
      name: "test",
      pubkey: KEYS["1"],
      version: "test",
      contact: [],
      nuts: {
        "4": { methods: [], disabled: false },
        "5": {
          methods: [{ method: "bolt11", unit: "msat", min_amount: 1, max_amount: 10000 }],
          disabled: false,
        },
      },
    });
    mint.getKeySets = async () => ({
      keysets: [
        { id: KEYSET_ID, unit: "msat", active: !options.noChange, input_fee_ppk: 0 },
        ...(options.legacy
          ? [{ id: selectedId, unit: "msat", active: false, input_fee_ppk: 0 }]
          : []),
      ],
    });
    mint.getKeys = async () => ({
      keysets: [
        { id: KEYSET_ID, unit: "msat", keys: KEYS },
        ...(options.legacy ? [{ id: selectedId, unit: "msat", keys: KEYS }] : []),
      ],
    });
    const wallet = new Wallet(mint, {
      unit: "msat",
      bip39seed: SEED,
      counterSource: source,
      keysetId: selectedId,
    });
    await wallet.loadMint();
    const prepare = wallet.prepareMelt.bind(wallet);
    wallet.prepareMelt = async (...args) => {
      const callback = args[3]?.onCountersReserved;
      args[3] = {
        ...args[3],
        onCountersReserved: (range) => {
          ranges.push(range);
          callback?.(range);
        },
      };
      const preview = await prepare(...args);
      if (source) drafts.push(preview.outputData as OutputData[]);
      return preview;
    };
    wallet.completeMelt = complete as typeof wallet.completeMelt;
    wallet.checkMeltQuote = status as typeof wallet.checkMeltQuote;
    return wallet;
  };
  privateDraft.create = create;
  const wallet = await create();
  return {
    input,
    database,
    context,
    drafts,
    ranges,
    complete,
    status,
    wallet,
    quote,
    run: () => meltBrowserDurableWallet({ mintUrl: MINT, quote, proofs: [input], wallet, context }),
  };
}

function realBlankProof(output: OutputData): Proof {
  const signature = createBlindSignature(
    pointFromHex(output.blindedMessage.B_),
    PRIVATE_KEY,
    KEYSET_ID,
  );
  const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), PRIVATE_KEY);
  return output.toProof(
    {
      id: KEYSET_ID,
      amount: Amount.from(1),
      C_: signature.C_.toHex(true),
      dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
    },
    { id: KEYSET_ID, keys: KEYS },
  );
}

function createDatabase(): BitcasterDB {
  const database = new BitcasterDB(browserWalletDatabaseName(browserWalletScope(SEED).scopeId));
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
  await new BrowserWalletCounterDexieStore({
    database,
    scopeId: browserWalletScope(SEED).scopeId,
    isCurrentProfile: () => true,
  }).restoreInContext({ mintUrl: MINT, unit: "msat" }, KEYSET_ID, 0, false, () => undefined);
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
  quote.amount = Amount.from(change === undefined ? input.amount : 1);
  return {
    method: "bolt11",
    inputs: [input],
    outputData:
      change === undefined ? [] : [OutputData.createSingleData(0, KEYSET_ID, change.secret, 11n)],
    keysetId: KEYSET_ID,
    quote,
  };
}

function meltWallet(
  preview: ReturnType<typeof meltPreview>,
  response: { state: string; change: Proof[]; quote?: string },
): BrowserDurableWalletMeltWallet {
  const wallet: BrowserDurableWalletMeltWallet = {
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
  privateDraft.create = (source) => ({
    ...wallet,
    prepareMelt: vi.fn(async (_method, _quote, _proofs, config) => {
      if (preview.outputData.length > 0) {
        const range = await source.reserve(KEYSET_ID, preview.outputData.length);
        config?.onCountersReserved({
          keysetId: KEYSET_ID,
          ...range,
          next: range.start + range.count,
        });
      }
      return wallet.prepareMelt(_method, _quote, _proofs, config);
    }),
  });
  return wallet;
}

function proofForOutput(output: OutputData): Proof {
  const amount = Amount.from(output.blindedMessage.amount).toBigInt();
  const privateKey =
    amount === 4n ? FOUR_PRIVATE_KEY : amount === 2n ? TWO_PRIVATE_KEY : PRIVATE_KEY;
  const signature = createBlindSignature(
    pointFromHex(output.blindedMessage.B_),
    privateKey,
    KEYSET_ID,
  );
  const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), privateKey);
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
