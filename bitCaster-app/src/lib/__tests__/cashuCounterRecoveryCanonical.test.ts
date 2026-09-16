// @vitest-environment node
import "fake-indexeddb/auto";
import {
  Amount,
  Keyset,
  OutputData,
  createBlindSignature,
  createDLEQProof,
  deriveKeysetId,
  pointFromHex,
  verifyProofsForReceive,
  type MintKeyset,
  type Proof,
} from "@cashu/cashu-ts";
import { bytesToHex } from "@noble/curves/utils.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toSeed } from "../bip39";
import { activateBrowserWalletDatabase, db, type BitcasterDB } from "../../stores/proof-db";
import {
  browserWalletScopeIdFromMnemonic,
  setActiveBrowserWalletProfile,
} from "../browserWalletProfile";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const MINT_URL = "https://mint.example";
const SEED = toSeed(MNEMONIC.split(/\s+/));
const MINT_PRIVATE_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const MINT_PUBLIC_KEY = secp256k1.getPublicKey(MINT_PRIVATE_KEY, true);
const KEYSET_ID = deriveKeysetId(
  { "7": bytesToHex(MINT_PUBLIC_KEY) },
  { unit: "msat", input_fee_ppk: 0, versionByte: 1 },
);

const keyset = new Keyset(KEYSET_ID, "msat", true, 0);
keyset.keys = { 7: bytesToHex(MINT_PUBLIC_KEY) };

const wallet = {
  mint: {
    mintUrl: MINT_URL,
    getKeySets: vi.fn(),
  },
  getKeyset: vi.fn(() => keyset),
  batchRestore: vi.fn(),
  groupProofsByState: vi.fn(),
};

const store = {
  mnemonic: MNEMONIC,
  activeMintUrl: MINT_URL,
  mints: [{ url: MINT_URL, keysets: [{ id: KEYSET_ID, unit: "msat" }] }],
  getWalletForUnit: vi.fn(async () => wallet),
};

vi.mock("@/stores/wallet", () => ({
  useWalletStore: { getState: () => store },
  getWalletForMnemonicUnit: vi.fn(async () => wallet),
}));

vi.mock("@/lib/walletProfileLock", () => ({
  withWalletProfileLock: async (_scopeId: string, action: () => Promise<unknown>) => action(),
}));

import { recoverKeysetCountersForMint } from "../cashu";

describe("recoverKeysetCountersForMint — canonical custody", () => {
  let database: BitcasterDB | null = null;

  beforeEach(() => {
    const scopeId = browserWalletScopeIdFromMnemonic(MNEMONIC);
    if (scopeId === null) throw new Error("test wallet scope is invalid");
    setActiveBrowserWalletProfile(MNEMONIC);
    activateBrowserWalletDatabase(scopeId);
    database = db;
    wallet.mint.getKeySets.mockReset();
    wallet.mint.getKeySets.mockResolvedValue({
      keysets: [keyset.toMintKeyset() as MintKeyset],
    });
    wallet.getKeyset.mockClear();
    wallet.getKeyset.mockReturnValue(keyset);
    wallet.batchRestore.mockReset();
    wallet.groupProofsByState.mockReset();
  });

  afterEach(async () => {
    const active = database;
    database = null;
    if (active === null) return;
    for (const table of active.tables) await table.clear();
  });

  it("admits only unspent restored value into canonical custody and is retry-safe", async () => {
    const proofs = [restoredProof(0), restoredProof(1), restoredProof(2)];
    expect(keyset.verify()).toBe(true);
    expect(() => verifyProofsForReceive(proofs, () => keyset, { requireDleq: true })).not.toThrow();
    wallet.batchRestore.mockResolvedValue({ proofs, lastCounterWithSignature: 2 });
    wallet.groupProofsByState.mockResolvedValue({
      unspent: [proofs[0]],
      pending: [proofs[1]],
      spent: [proofs[2]],
    });

    const first = await recoverKeysetCountersForMint(MINT_URL, { force: true });
    const second = await recoverKeysetCountersForMint(MINT_URL, { force: true });

    expect(first).toEqual({ scannedKeysets: [KEYSET_ID], complete: true });
    expect(second).toEqual({ scannedKeysets: [KEYSET_ID], complete: true });
    expect(await database!.custodyProofs.count()).toBe(1);
    expect(await database!.custodyProofs.toArray()).toEqual(
      expect.arrayContaining([expect.objectContaining({ amount: 7, selectability: "selectable" })]),
    );
    expect(await database!.custodyProofBackupAuthorities.count()).toBe(1);
    expect(await database!.proofs.count()).toBe(1);
    expect(await database!.walletCounterCursors.get([scopeId(), KEYSET_ID])).toMatchObject({
      next: 3,
    });

    const [existing] = await database!.custodyProofs.toArray();
    if (existing === undefined) throw new Error("recovered custody proof is missing");
    await database!.proofs.clear();
    const selectableRetry = await recoverKeysetCountersForMint(MINT_URL, { force: true });
    expect(selectableRetry).toEqual({ scannedKeysets: [KEYSET_ID], complete: true });
    expect(await database!.proofs.count()).toBe(0);
    await database!.custodyProofs.put({
      ...existing,
      revision: existing.revision + 1,
      selectability: "spent",
      reservationOperationId: null,
    });
    const [authority] = await database!.custodyProofBackupAuthorities.toArray();
    if (authority === undefined) throw new Error("recovered backup authority is missing");
    await database!.custodyProofBackupAuthorities.put({
      ...authority,
      proofRevision: existing.revision + 1,
      proofState: "spent",
    });
    const spentRetry = await recoverKeysetCountersForMint(MINT_URL, { force: true });
    expect(spentRetry).toEqual({ scannedKeysets: [KEYSET_ID], complete: true });
    expect(await database!.custodyProofs.get([scopeId(), existing.proofId])).toMatchObject({
      revision: existing.revision + 1,
      selectability: "spent",
    });
    expect(await database!.proofs.count()).toBe(0);

    const spent = await database!.custodyProofs.get([scopeId(), existing.proofId]);
    const spentAuthority = await database!.custodyProofBackupAuthorities.get([
      scopeId(),
      existing.proofId,
    ]);
    if (spent === undefined || spentAuthority === undefined) {
      throw new Error("spent custody authority is missing");
    }
    await database!.custodyProofs.put({
      ...spent,
      revision: spent.revision + 1,
      selectability: "locked",
      reservationOperationId: "reservation:test",
    });
    await database!.custodyProofBackupAuthorities.put({
      ...spentAuthority,
      proofRevision: spent.revision + 1,
      proofState: "locked",
    });
    const lockedRetry = await recoverKeysetCountersForMint(MINT_URL, { force: true });
    expect(lockedRetry).toEqual({ scannedKeysets: [KEYSET_ID], complete: true });
    expect(await database!.custodyProofs.get([scopeId(), existing.proofId])).toMatchObject({
      revision: spent.revision + 1,
      selectability: "locked",
      reservationOperationId: "reservation:test",
    });
    expect(await database!.proofs.count()).toBe(0);
  });

  it("rolls back canonical custody and the counter when admission rejects recovered metadata", async () => {
    const foreignMetadata = { ...restoredProof(0), conditionId: "aa".repeat(32) };
    wallet.batchRestore.mockResolvedValue({
      proofs: [foreignMetadata],
      lastCounterWithSignature: 0,
    });
    wallet.groupProofsByState.mockResolvedValue({
      unspent: [foreignMetadata],
      pending: [],
      spent: [],
    });

    await expect(recoverKeysetCountersForMint(MINT_URL, { force: true })).resolves.toEqual({
      scannedKeysets: [],
      complete: false,
    });
    expect(await database!.custodyProofs.count()).toBe(0);
    expect(await database!.proofs.count()).toBe(0);
    expect(await database!.walletCounterCursors.count()).toBe(0);
    expect(await database!.walletCounterAssociations.count()).toBe(0);
  });

  it("recovers a sparse proof beyond the targeted candidate bound", async () => {
    const sparse = restoredProof(4_097);
    wallet.batchRestore.mockResolvedValue({
      proofs: [sparse],
      lastCounterWithSignature: 4_097,
    });
    wallet.groupProofsByState.mockResolvedValue({
      unspent: [sparse],
      pending: [],
      spent: [],
    });

    const result = await recoverKeysetCountersForMint(MINT_URL, { force: true });

    expect(result).toEqual({ scannedKeysets: [KEYSET_ID], complete: true });
    expect(await database!.custodyProofs.toArray()).toEqual(
      expect.arrayContaining([expect.objectContaining({ amount: 7, selectability: "selectable" })]),
    );
    expect(await database!.custodyProofBackupAuthorities.toArray()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          derivationLocator: expect.objectContaining({ kind: "nut13", counter: 4_097 }),
        }),
      ]),
    );
    expect(await database!.walletCounterCursors.get([scopeId(), KEYSET_ID])).toMatchObject({
      next: 4_098,
    });
  });

  it("fails closed on conflicting existing canonical material", async () => {
    const proof = restoredProof(0);
    wallet.batchRestore.mockResolvedValue({ proofs: [proof], lastCounterWithSignature: 0 });
    wallet.groupProofsByState.mockResolvedValue({ unspent: [proof], pending: [], spent: [] });
    await expect(recoverKeysetCountersForMint(MINT_URL, { force: true })).resolves.toEqual({
      scannedKeysets: [KEYSET_ID],
      complete: true,
    });

    const [existing] = await database!.custodyProofs.toArray();
    if (existing === undefined) throw new Error("recovered custody proof is missing");
    await database!.custodyProofs.put({ ...existing, amount: existing.amount + 1 });

    await expect(recoverKeysetCountersForMint(MINT_URL, { force: true })).resolves.toEqual({
      scannedKeysets: [],
      complete: false,
    });
    expect(await database!.walletCounterCursors.get([scopeId(), KEYSET_ID])).toMatchObject({
      next: 1,
    });
  });

  it("fails closed on conflicting canonical backup locator", async () => {
    const proof = restoredProof(0);
    wallet.batchRestore.mockResolvedValue({ proofs: [proof], lastCounterWithSignature: 0 });
    wallet.groupProofsByState.mockResolvedValue({ unspent: [proof], pending: [], spent: [] });
    await expect(recoverKeysetCountersForMint(MINT_URL, { force: true })).resolves.toEqual({
      scannedKeysets: [KEYSET_ID],
      complete: true,
    });

    const [authority] = await database!.custodyProofBackupAuthorities.toArray();
    if (authority === undefined || authority.derivationLocator === null) {
      throw new Error("recovered backup authority is missing");
    }
    await database!.custodyProofBackupAuthorities.put({
      ...authority,
      derivationLocator: {
        schemaVersion: 1,
        kind: "nut13",
        keysetId: KEYSET_ID,
        counter: 1,
      },
    });

    await expect(recoverKeysetCountersForMint(MINT_URL, { force: true })).resolves.toEqual({
      scannedKeysets: [],
      complete: false,
    });
    expect(await database!.walletCounterCursors.get([scopeId(), KEYSET_ID])).toMatchObject({
      next: 1,
    });
  });
});

function scopeId(): string {
  const value = browserWalletScopeIdFromMnemonic(MNEMONIC);
  if (value === null) throw new Error("test wallet scope is invalid");
  return value;
}

function restoredProof(counter: number): Proof {
  const output = OutputData.createSingleDeterministicData(0, SEED, counter, KEYSET_ID);
  const blindedMessage = pointFromHex(output.blindedMessage.B_);
  const blindSignature = createBlindSignature(blindedMessage, MINT_PRIVATE_KEY, KEYSET_ID);
  const dleq = createDLEQProof(blindedMessage, MINT_PRIVATE_KEY);
  return output.toProof(
    {
      id: KEYSET_ID,
      amount: Amount.from(7),
      C_: blindSignature.C_.toHex(true),
      dleq: { s: bytesToHex(dleq.s), e: bytesToHex(dleq.e) },
    },
    keyset,
  );
}
