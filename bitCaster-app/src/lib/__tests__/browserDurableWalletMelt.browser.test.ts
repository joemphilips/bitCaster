import { expect, it, vi } from "vitest";
import {
  Amount,
  Mint,
  Wallet,
  OutputData,
  deriveKeysetId,
  createBlindSignature,
  createDLEQProof,
  pointFromHex,
  type CounterSource,
  type MeltQuoteResponse,
} from "@cashu/cashu-ts";
import { bytesToHex } from "@noble/curves/utils.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { BitcasterDB } from "@/stores/proof-db";
import { browserWalletDatabaseName } from "../browserWalletProfile";
import { browserWalletScope } from "../browserCtfRangeOrderSource";
import { BrowserWalletCounterDexieStore } from "@/stores/browser-wallet-counter-db";
import { createBrowserCustodyProofRow } from "@/stores/durable-custody-db";
import { createBrowserProofBackupAuthorityRow } from "@/stores/browser-proof-backup-authority";
const factory = vi.hoisted(() => ({
  create: undefined as undefined | ((source: CounterSource) => Promise<Wallet>),
}));
vi.mock("@/stores/wallet", () => ({
  createUncachedWalletForSeedUnit: async (input: { counterSource: CounterSource }) =>
    factory.create!(input.counterSource),
}));
vi.mock("../browserWalletNewWritePermission", () => ({
  requireBrowserWalletNewWritePermission: async () => undefined,
}));
import {
  meltBrowserDurableWallet,
  type BrowserDurableWalletMeltContext,
} from "../browserDurableWalletMelt";

const SEED = new Uint8Array(32).fill(19);
const SCOPE = browserWalletScope(SEED);
const MINT = "https://mint.test";
const PRIVATE = Uint8Array.from([...new Uint8Array(31), 7]);
const KEYS = { "2": bytesToHex(secp256k1.getPublicKey(PRIVATE, true)) };
const KEYSET = deriveKeysetId(KEYS, { unit: "msat", versionByte: 1 });

it("atomically aborts, commits/reopens and rejects separate-connection melt CAS in native IndexedDB", async () => {
  let database = new BitcasterDB(browserWalletDatabaseName(SCOPE.scopeId));
  const other = new BitcasterDB(database.name);
  let time = Date.now();
  const create = async (counterSource?: CounterSource) => {
    const mint = new Mint(MINT);
    mint.getInfo = async () => ({
      name: "fixture",
      pubkey: KEYS["2"],
      version: "fixture",
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
      keysets: [{ id: KEYSET, unit: "msat", active: true, input_fee_ppk: 0 }],
    });
    mint.getKeys = async () => ({ keysets: [{ id: KEYSET, unit: "msat", keys: KEYS }] });
    const wallet = new Wallet(mint, { unit: "msat", bip39seed: SEED, counterSource });
    await wallet.loadMint();
    return wallet;
  };
  factory.create = create;
  const wallet = await create();
  const complete = vi
    .spyOn(wallet, "completeMelt")
    .mockRejectedValue(new Error("native transport offline"));
  vi.spyOn(wallet, "checkMeltQuote").mockImplementation(async () => ({
    quote: "native-melt",
    state: "PENDING",
    amount: Amount.from(1),
    unit: "msat",
    expiry: 2000000000,
  }));
  const output = OutputData.createSingleData(2, KEYSET, "native-input", 7n);
  const signature = createBlindSignature(pointFromHex(output.blindedMessage.B_), PRIVATE, KEYSET);
  const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), PRIVATE);
  const proof = output.toProof(
    {
      id: KEYSET,
      amount: Amount.from(2),
      C_: signature.C_.toHex(true),
      dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
    },
    { id: KEYSET, keys: KEYS },
  );
  const quote: MeltQuoteResponse = {
    quote: "native-melt",
    amount: Amount.from(1),
    unit: "msat",
    fee_reserve: Amount.from(1),
    expiry: 2000000000,
    request: "fixture-invoice",
    state: "UNPAID",
    payment_preimage: null,
  };
  const context: {
    -readonly [P in keyof BrowserDurableWalletMeltContext]: BrowserDurableWalletMeltContext[P];
  } = {
    seed: SEED,
    database,
    now: () => ++time,
    lockManager: {
      request: async (_name: string, _options: LockOptions, action: () => Promise<unknown>) =>
        action(),
    } as Pick<LockManager, "request">,
    requireCapturedProfile: () => undefined,
  };
  const run = () =>
    meltBrowserDurableWallet({ mintUrl: MINT, quote, proofs: [proof], wallet, context });
  const facts = async () =>
    JSON.stringify(
      await Promise.all(
        [
          database.custodyOperations,
          database.custodyArtifacts,
          database.custodyProofs,
          database.custodyReservations,
          database.custodyActiveWork,
          database.custodyProofBackupAuthorities,
          database.encryptedWalletBackupV2DesiredAssets,
          database.walletCounterAssociations,
          database.walletCounterCursors,
        ].map((table) => table.toArray()),
      ),
    );
  try {
    const row = createBrowserCustodyProofRow({
      scopeId: SCOPE.scopeId,
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
    await new BrowserWalletCounterDexieStore({
      database,
      scopeId: SCOPE.scopeId,
      isCurrentProfile: () => true,
    }).restoreInContext({ mintUrl: MINT, unit: "msat" }, KEYSET, 0, false, () => undefined);
    const before = await facts();
    context.injectPreparationFault = (phase) => {
      if (phase === "journal-bound") throw new Error("native transaction abort");
    };
    await expect(run()).rejects.toThrow("native transaction abort");
    expect(await facts()).toBe(before);
    expect(complete).not.toHaveBeenCalled();
    context.injectPreparationFault = undefined;
    let conflicts = 0;
    context.observePrepared = async () => {
      conflicts++;
      await new BrowserWalletCounterDexieStore({
        database: other,
        scopeId: SCOPE.scopeId,
        isCurrentProfile: () => true,
      }).reserveInContext({ mintUrl: MINT, unit: "msat" }, KEYSET, 1, true);
    };
    await expect(run()).rejects.toThrow("counter snapshot changed");
    expect(conflicts).toBe(3);
    expect(await database.custodyOperations.count()).toBe(0);
    context.observePrepared = undefined;
    await expect(run()).rejects.toThrow("native transport offline");
    expect(complete).toHaveBeenCalledOnce();
    expect((await database.walletCounterCursors.toArray())[0]?.next).toBe(4);
    expect(await database.custodyOperations.count()).toBe(1);
    database.close();
    database = new BitcasterDB(browserWalletDatabaseName(SCOPE.scopeId));
    context.database = database;
    await expect(run()).rejects.toThrow();
    expect(complete).toHaveBeenCalledOnce();
    expect((await database.walletCounterCursors.toArray())[0]?.next).toBe(4);
  } finally {
    other.close();
    database.close();
    await database.delete();
  }
});
