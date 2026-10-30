import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { Wallet, Mint, Amount, deriveKeysetId } from "@cashu/cashu-ts";
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from "@bitcaster/client-sdk/durableCustody";
import { BitcasterDB } from "@/stores/proof-db";
import { browserWalletDatabaseName } from "../browserWalletProfile";
import { BrowserWalletCounterDexieStore } from "@/stores/browser-wallet-counter-db";

const state = vi.hoisted(() => ({ context: undefined as any, create: undefined as any }));
vi.mock("@/stores/wallet", () => ({
  getWalletForMnemonicUnit: async () => state.create(),
  createUncachedWalletForMnemonicUnit: async (input: any) => state.create(input.counterSource),
}));
vi.mock("../browserWalletNewWritePermission", () => ({
  requireBrowserWalletNewWritePermission: async () => undefined,
}));
vi.mock("@/lib/cashu", () => ({
  captureBrowserMintPersistenceContext: () => state.context,
  browserDurableWalletMintStore: () => {
    throw new Error("unexpected mint execution");
  },
  restoreExactMintOutputs: () => {
    throw new Error("unexpected mint restore");
  },
  waitForMintQuotePaidForUnit: () => {
    throw new Error("unexpected mint wait");
  },
}));
import { createBrowserDurableBolt11MintQuote } from "../browserDurableBolt11MintQuote";

const SEED = new Uint8Array(32).fill(7);
const SCOPE = deriveDurableCustodyScopeId({
  scopeKind: "wallet",
  walletId: deriveDurableCustodyWalletId(SEED),
});
const MINT = "https://mint.test";
const KEYS = { "1": "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" };
const KEYSET = deriveKeysetId(KEYS, { unit: "msat", versionByte: 1 });
let database: BitcasterDB;
let other: BitcasterDB | undefined;
let remote = "native-quote";
let quotes = 0;

beforeEach(async () => {
  database = new BitcasterDB(browserWalletDatabaseName(SCOPE));
  other = undefined;
  quotes = 0;
  remote = "native-quote";
  state.context = {
    database,
    scopeId: SCOPE,
    seed: SEED,
    mnemonic: "fixture",
    activeMintUrl: MINT,
    requireCapturedProfile: () => undefined,
  };
  state.create = async (source?: import("@cashu/cashu-ts").CounterSource) => {
    const mint = new Mint(MINT);
    mint.getInfo = async () => ({
      name: "test",
      pubkey: KEYS["1"],
      version: "test",
      contact: [],
      nuts: {
        "4": {
          methods: [{ method: "bolt11", unit: "msat", min_amount: 1, max_amount: 1000000 }],
          disabled: false,
        },
        "5": { methods: [], disabled: false },
      },
    });
    mint.getKeySets = async () => ({
      keysets: [{ id: KEYSET, unit: "msat", active: true, input_fee_ppk: 0 }],
    });
    mint.getKeys = async () => ({ keysets: [{ id: KEYSET, unit: "msat", keys: KEYS }] });
    const wallet = new Wallet(mint, { unit: "msat", bip39seed: SEED, counterSource: source });
    await wallet.loadMint();
    wallet.createMintQuoteBolt11 = async () => {
      quotes++;
      return {
        quote: remote,
        request: `invoice-${remote}`,
        amount: Amount.from(1),
        unit: "msat",
        state: "UNPAID" as const,
        expiry: 50,
      };
    };
    return wallet;
  };
  await new BrowserWalletCounterDexieStore({ database, scopeId: SCOPE }).restoreInContext(
    { mintUrl: MINT, unit: "msat" },
    KEYSET,
    0,
    false,
    () => undefined,
  );
});

afterEach(async () => {
  other?.close();
  database.close();
  await database.delete();
});

it("atomically aborts, commits, reopens and refuses separate-connection stale quote snapshots", async () => {
  const before = await facts();
  state.context.injectPreparationFault = (phase: string) => {
    if (phase === "journal-bound") throw new Error("native joint abort");
  };
  await expect(
    createBrowserDurableBolt11MintQuote({ amount: 1, mintUrl: MINT, unit: "msat" }),
  ).rejects.toThrow("native joint abort");
  expect(await facts()).toEqual(before);
  state.context.injectPreparationFault = undefined;
  const created = await createBrowserDurableBolt11MintQuote({
    amount: 1,
    mintUrl: MINT,
    unit: "msat",
  });
  expect((await database.walletCounterCursors.get([SCOPE, KEYSET]))!.next).toBe(1);
  database.close();
  database = new BitcasterDB(browserWalletDatabaseName(SCOPE));
  state.context.database = database;
  const committed = await facts();
  expect(
    await createBrowserDurableBolt11MintQuote({ amount: 1, mintUrl: MINT, unit: "msat" }),
  ).toEqual(created);
  expect(await facts()).toEqual(committed);
  other = new BitcasterDB(database.name);
  const competitor = new BrowserWalletCounterDexieStore({ database: other, scopeId: SCOPE });
  remote = "stale-quote";
  let drafts = 0;
  const beforeQuotes = quotes;
  state.context.observePrepared = async () => {
    drafts++;
    await competitor.reserveInContext({ mintUrl: MINT, unit: "msat" }, KEYSET, 1, true);
  };
  await expect(
    createBrowserDurableBolt11MintQuote({ amount: 1, mintUrl: MINT, unit: "msat" }),
  ).rejects.toBeInstanceOf(Error);
  expect(drafts).toBe(3);
  expect(quotes - beforeQuotes).toBe(1);
  expect((await database.walletCounterCursors.get([SCOPE, KEYSET]))!.next).toBe(4);
  expect(await database.mintQuotes.count()).toBe(1);
  expect(await database.proofOperations.count()).toBe(1);
});

async function facts() {
  const tables = [
    database.mintQuotes,
    database.proofOperations,
    database.walletCounterAssociations,
    database.walletCounterCursors,
    database.encryptedWalletBackupV2DesiredAssets,
  ];
  return database.transaction("r", tables, async () =>
    Object.fromEntries(
      await Promise.all(
        tables.map(async (table) => [
          table.name,
          (await table.toArray()).map((row) => JSON.stringify(row)).sort(),
        ]),
      ),
    ),
  );
}
