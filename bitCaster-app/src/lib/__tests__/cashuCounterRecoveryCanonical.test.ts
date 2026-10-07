// @vitest-environment node
import "fake-indexeddb/auto";
import {
  Amount,
  Keyset,
  OutputData,
  createBlindSignature,
  createDLEQProof,
  deriveConditionalKeysetId,
  deriveKeysetId,
  pointFromHex,
  verifyProofsForReceive,
  type MintKeyset,
  type Proof,
} from "@cashu/cashu-ts";
import { bytesToHex } from "@noble/curves/utils.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEncryptedWalletBackupV2AssetIdentity,
  encryptedWalletBackupV2LocalAssetKey,
} from "@bitcaster/client-sdk/encryptedWalletBackupV2ProofSet";
import { deriveDurableCustodyWalletId } from "@bitcaster/client-sdk/durableCustody";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import type { ActiveCtfRangeMintKeyset } from "@bitcaster/client-sdk/ctfRangeOrderPreparation";
import { toSeed } from "../bip39";
import { activateBrowserWalletDatabase, db, type BitcasterDB } from "../../stores/proof-db";
import { BrowserWalletCounterSource } from "../../stores/browser-wallet-counter-db";
import {
  activeBrowserWalletScopeId,
  browserWalletScopeIdFromMnemonic,
  setActiveBrowserWalletProfile,
} from "../browserWalletProfile";
import { createBrowserCustodyProofRow } from "../../stores/durable-custody-db";
import {
  createBrowserCompletedProofRemovalMarkerRow,
  requireBrowserLiveProofBackupAuthorityTableRow,
} from "../../stores/browser-proof-backup-authority";
import { withWalletProfileLock } from "../walletProfileLock";

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
const CONDITION_ID = "ab".repeat(32);
const OUTCOME_COLLECTION = "Selected outcome";
const OUTCOME_COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION_ID,
  outcomeCollection: OUTCOME_COLLECTION,
});
const CONDITIONAL_KEYSET_ID = deriveConditionalKeysetId({
  keys: { "7": bytesToHex(MINT_PUBLIC_KEY) },
  unit: "msat",
  conditionId: CONDITION_ID,
  outcomeCollectionId: OUTCOME_COLLECTION_ID,
});
const CONDITIONAL_METADATA = {
  conditionId: CONDITION_ID,
  outcomeCollection: OUTCOME_COLLECTION,
  outcomeCollectionId: OUTCOME_COLLECTION_ID,
  registeredAt: 1,
};

const keyset = new Keyset(KEYSET_ID, "msat", true, 0);
keyset.keys = { 7: bytesToHex(MINT_PUBLIC_KEY) };
const conditionalKeyset = new Keyset(
  CONDITIONAL_KEYSET_ID,
  "msat",
  true,
  0,
  undefined,
  CONDITIONAL_METADATA,
);
conditionalKeyset.keys = { 7: bytesToHex(MINT_PUBLIC_KEY) };
const knownKeysets = new Map<string, Keyset>([
  [KEYSET_ID, keyset],
  [CONDITIONAL_KEYSET_ID, conditionalKeyset],
]);
const walletLockState = vi.hoisted(() => ({ held: false, calls: 0 }));

const wallet = {
  mint: {
    mintUrl: MINT_URL,
    getKeySets: vi.fn(),
  },
  keyChain: {
    registerConditionalKeyset: vi.fn((meta, keys) => {
      const registered = Keyset.fromMintApi(meta, keys);
      knownKeysets.set(registered.id, registered);
      return registered;
    }),
  },
  getKeyset: vi.fn((id = KEYSET_ID) => knownKeysets.get(id)!),
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
  withWalletProfileLock: async (_scopeId: string, action: () => Promise<unknown>) => {
    walletLockState.calls += 1;
    if (walletLockState.held) throw new Error("wallet profile lock reentered");
    walletLockState.held = true;
    try {
      return await action();
    } finally {
      walletLockState.held = false;
    }
  },
}));

import {
  ensureWalletKeysetCounterReady,
  recoverKeysetCountersForMint,
  WalletKeysetCounterReadinessError,
} from "../cashu";

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
    knownKeysets.clear();
    knownKeysets.set(KEYSET_ID, keyset);
    knownKeysets.set(CONDITIONAL_KEYSET_ID, conditionalKeyset);
    wallet.keyChain.registerConditionalKeyset.mockClear();
    wallet.getKeyset.mockClear();
    wallet.getKeyset.mockImplementation((id = KEYSET_ID) => knownKeysets.get(id)!);
    wallet.batchRestore.mockReset();
    wallet.groupProofsByState.mockReset();
    walletLockState.held = false;
    walletLockState.calls = 0;
  });

  afterEach(async () => {
    const active = database;
    database = null;
    if (active === null) return;
    for (const table of active.tables) await table.clear();
  });

  it("does not report an undiscovered requested keyset as recovered", async () => {
    const missingKeysetId = `01${"f".repeat(64)}`;

    await expect(
      recoverKeysetCountersForMint(MINT_URL, {
        force: true,
        unit: "msat",
        keysetId: missingKeysetId,
      }),
    ).resolves.toEqual({ scannedKeysets: [], complete: false });

    expect(wallet.batchRestore).not.toHaveBeenCalled();
    expect(await database!.walletCounterAssociations.count()).toBe(0);
  });

  it("marks an empty regular scan ready and reserves from zero", async () => {
    wallet.batchRestore.mockResolvedValue({ proofs: [], lastCounterWithSignature: undefined });

    await expect(
      recoverKeysetCountersForMint(MINT_URL, { unit: "msat", keysetId: KEYSET_ID }),
    ).resolves.toEqual({ scannedKeysets: [KEYSET_ID], complete: true });

    expect(
      await database!.walletCounterAssociations.get([scopeId(), MINT_URL, "msat", KEYSET_ID]),
    ).toMatchObject({ recoveryComplete: true });
    const source = new BrowserWalletCounterSource(
      {
        database: database!,
        scopeId: scopeId(),
        isCurrentProfile: () => activeBrowserWalletScopeId() === scopeId(),
      },
      { mintUrl: MINT_URL, unit: "msat" },
    );
    await expect(source.reserve(KEYSET_ID, 1)).resolves.toEqual({ start: 0, count: 1 });
  });

  it("recovers and registers one preparation-selected conditional keyset", async () => {
    wallet.batchRestore.mockResolvedValue({ proofs: [], lastCounterWithSignature: 4 });

    await expect(
      ensureWalletKeysetCounterReady(conditionalReadinessInput()),
    ).resolves.toBeUndefined();

    expect(wallet.mint.getKeySets).toHaveBeenCalledTimes(1);
    expect(wallet.keyChain.registerConditionalKeyset).toHaveBeenCalledTimes(1);
    expect(wallet.keyChain.registerConditionalKeyset).toHaveBeenCalledWith(
      expect.objectContaining({
        id: CONDITIONAL_KEYSET_ID,
        unit: "msat",
        conditional: CONDITIONAL_METADATA,
      }),
      expect.objectContaining({
        id: CONDITIONAL_KEYSET_ID,
        keys: { "7": bytesToHex(MINT_PUBLIC_KEY) },
      }),
    );
    expect(wallet.batchRestore).toHaveBeenCalledWith(300, 100, 0, CONDITIONAL_KEYSET_ID);
    expect(
      await database!.walletCounterCursors.get([scopeId(), CONDITIONAL_KEYSET_ID]),
    ).toMatchObject({
      next: 5,
    });
    expect(
      await database!.walletCounterAssociations.get([
        scopeId(),
        MINT_URL,
        "msat",
        CONDITIONAL_KEYSET_ID,
      ]),
    ).toBeDefined();

    knownKeysets.delete(CONDITIONAL_KEYSET_ID);
    await ensureWalletKeysetCounterReady(conditionalReadinessInput());

    expect(wallet.batchRestore).toHaveBeenCalledTimes(1);
    expect(wallet.keyChain.registerConditionalKeyset).toHaveBeenCalledTimes(2);
    const source = new BrowserWalletCounterSource(
      {
        database: database!,
        scopeId: scopeId(),
        isCurrentProfile: () => activeBrowserWalletScopeId() === scopeId(),
      },
      { mintUrl: MINT_URL, unit: "msat" },
    );
    await expect(source.reserve(CONDITIONAL_KEYSET_ID, 1)).resolves.toEqual({ start: 5, count: 1 });
  });

  it.each([
    [
      "foreign mint",
      conditionalPreparationKeyset({ canonicalMintUrl: "https://other.example" }),
      undefined,
    ],
    [
      "foreign condition",
      conditionalPreparationKeyset({ conditionId: "cd".repeat(32) }),
      undefined,
    ],
    [
      "foreign collection",
      conditionalPreparationKeyset({ outcomeCollection: "Other outcome" }),
      undefined,
    ],
    ["conditional metadata absent", regularPreparationKeyset(), undefined],
    [
      "foreign expected condition",
      conditionalPreparationKeyset(),
      { conditionId: "cd".repeat(32), outcomeCollection: OUTCOME_COLLECTION },
    ],
  ])("rejects %s keyset authority without scanning", async (_name, keyset, conditionalAsset) => {
    const input = conditionalReadinessInput({
      keyset: keyset as ActiveCtfRangeMintKeyset,
      conditionalAsset: (conditionalAsset as
        | { conditionId: string; outcomeCollection: string }
        | undefined) ?? { conditionId: CONDITION_ID, outcomeCollection: OUTCOME_COLLECTION },
    });

    await expect(ensureWalletKeysetCounterReady(input)).rejects.toMatchObject({
      name: "WalletKeysetCounterReadinessError",
      message: new WalletKeysetCounterReadinessError().message,
    });

    expect(wallet.batchRestore).not.toHaveBeenCalled();
    expect(await database!.walletCounterAssociations.count()).toBe(0);
  });

  it("coalesces concurrent readiness scans for the same exact conditional keyset", async () => {
    let completeRestore!: (value: { proofs: Proof[]; lastCounterWithSignature: number }) => void;
    wallet.batchRestore.mockImplementation(
      () =>
        new Promise((resolve) => {
          completeRestore = resolve;
        }),
    );

    const first = ensureWalletKeysetCounterReady(conditionalReadinessInput());
    const second = ensureWalletKeysetCounterReady(conditionalReadinessInput());
    await vi.waitFor(() => expect(wallet.batchRestore).toHaveBeenCalledTimes(1));
    completeRestore({ proofs: [], lastCounterWithSignature: 1 });
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(wallet.keyChain.registerConditionalKeyset).toHaveBeenCalledTimes(1);
  });

  it("keeps exact conditional high-water monotonic during forced repair", async () => {
    wallet.batchRestore.mockResolvedValueOnce({ proofs: [], lastCounterWithSignature: 100 });
    await ensureWalletKeysetCounterReady(conditionalReadinessInput());
    wallet.batchRestore.mockResolvedValueOnce({ proofs: [], lastCounterWithSignature: 7 });
    const association = await database!.walletCounterAssociations.get([
      scopeId(),
      MINT_URL,
      "msat",
      CONDITIONAL_KEYSET_ID,
    ]);
    if (association === undefined) throw new Error("conditional counter association is missing");
    await database!.walletCounterAssociations.put({ ...association, recoveryComplete: false });

    await ensureWalletKeysetCounterReady(conditionalReadinessInput());
    expect(wallet.batchRestore).toHaveBeenCalledTimes(2);

    expect(
      await database!.walletCounterCursors.get([scopeId(), CONDITIONAL_KEYSET_ID]),
    ).toMatchObject({
      next: 101,
    });
  });

  it("does not recursively acquire a profile lock when its caller already holds it", async () => {
    wallet.batchRestore.mockResolvedValue({ proofs: [], lastCounterWithSignature: 2 });

    await withWalletProfileLock(scopeId(), () =>
      ensureWalletKeysetCounterReady(conditionalReadinessInput({ profileLockHeld: true })),
    );

    expect(walletLockState.calls).toBe(1);
    expect(wallet.batchRestore).toHaveBeenCalledTimes(1);
    expect(
      await database!.walletCounterCursors.get([scopeId(), CONDITIONAL_KEYSET_ID]),
    ).toMatchObject({
      next: 3,
    });
  });

  it("fails closed when the wallet profile changes during selected recovery", async () => {
    const otherMnemonic =
      "legal winner thank year wave sausage worth useful legal winner thank yellow";
    wallet.batchRestore.mockImplementation(async () => {
      setActiveBrowserWalletProfile(otherMnemonic);
      return { proofs: [], lastCounterWithSignature: 2 };
    });

    await expect(ensureWalletKeysetCounterReady(conditionalReadinessInput())).rejects.toMatchObject(
      {
        name: "WalletKeysetCounterReadinessError",
        message: new WalletKeysetCounterReadinessError().message,
      },
    );

    expect(await database!.walletCounterCursors.count()).toBe(0);
    expect(await database!.walletCounterAssociations.count()).toBe(0);
  });

  it("fences a profile change after the final readiness read", async () => {
    const otherMnemonic =
      "legal winner thank year wave sausage worth useful legal winner thank yellow";
    wallet.batchRestore.mockResolvedValue({ proofs: [], lastCounterWithSignature: undefined });
    await recoverKeysetCountersForMint(MINT_URL, {
      force: true,
      unit: "msat",
      keysetId: KEYSET_ID,
    });

    const readAssociation = database!.walletCounterAssociations.get.bind(
      database!.walletCounterAssociations,
    );
    let reads = 0;
    vi.spyOn(database!.walletCounterAssociations, "get")
      .mockImplementationOnce((key) => {
        reads += 1;
        return readAssociation(key);
      })
      .mockImplementationOnce((key) => {
        reads += 1;
        return readAssociation(key).then((row) => {
          setActiveBrowserWalletProfile(otherMnemonic);
          return row;
        });
      });

    await expect(ensureWalletKeysetCounterReady(regularReadinessInput())).rejects.toMatchObject({
      name: "WalletKeysetCounterReadinessError",
      message: new WalletKeysetCounterReadinessError().message,
    });
    expect(reads).toBe(2);
    expect(wallet.batchRestore).toHaveBeenCalledTimes(1);
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
    const [rawAuthority] = await database!.custodyProofBackupAuthorities.toArray();
    const authority = requireBrowserLiveProofBackupAuthorityTableRow(rawAuthority, [
      scopeId(),
      existing.proofId,
    ]);
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
    const spentAuthorityRow = await database!.custodyProofBackupAuthorities.get([
      scopeId(),
      existing.proofId,
    ]);
    const spentAuthority = requireBrowserLiveProofBackupAuthorityTableRow(spentAuthorityRow, [
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

    const [existing] = await database!.custodyProofs.toArray();
    if (existing === undefined) throw new Error("recovered custody proof is missing");
    const [rawAuthority] = await database!.custodyProofBackupAuthorities.toArray();
    const authority = requireBrowserLiveProofBackupAuthorityTableRow(rawAuthority, [
      scopeId(),
      existing.proofId,
    ]);
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

  it("fences an exact completed-removal marker from counter recovery", async () => {
    const proof = restoredProof(0);
    const asset = createEncryptedWalletBackupV2AssetIdentity({
      mintUrl: MINT_URL,
      unit: "msat",
      asset: {
        kind: "ctf",
        conditionId: "aa".repeat(32),
        outcomeLabel: "YES",
        outcomeCollectionId: "bb".repeat(32),
        registeredAt: 1,
        finalExpiry: 2,
      },
    });
    const proofRow = createBrowserCustodyProofRow({
      scopeId: scopeId(),
      normalizedMint: MINT_URL,
      unit: "msat",
      proof,
      asset: { kind: "regular" },
      receivedAtMs: 0,
    });
    const marker = createBrowserCompletedProofRemovalMarkerRow({
      scopeId: scopeId(),
      proofId: proofRow.proofId,
      proofFingerprint: proofRow.proofFingerprint,
      proofRevision: proofRow.revision,
      proofCommitment: "11".repeat(32),
      localAssetKey: encryptedWalletBackupV2LocalAssetKey(asset),
      removalIntentId: "counter-recovery-marker",
      proofSetCommitment: "22".repeat(32),
      completionCustodyRevision: "1",
      realm: "development",
      walletId: deriveDurableCustodyWalletId(SEED),
      enrollmentEpoch: 1,
      acknowledgedHeadVersion: 1,
      acknowledgedActiveSetDigest: "33".repeat(32),
      acknowledgementKind: "current-head",
      receiptDigest: null,
      acknowledgedAtMs: 1,
      completedAtMs: 2,
    });
    await database!.custodyProofBackupAuthorities.put(marker);
    wallet.batchRestore.mockResolvedValue({
      proofs: [proof],
      lastCounterWithSignature: 0,
    });
    wallet.groupProofsByState.mockResolvedValue({
      unspent: [proof],
      pending: [],
      spent: [],
    });

    await expect(recoverKeysetCountersForMint(MINT_URL, { force: true })).resolves.toEqual({
      scannedKeysets: [],
      complete: false,
    });
    expect(await database!.custodyProofs.count()).toBe(0);
    expect(await database!.proofs.count()).toBe(0);
    expect(
      await database!.custodyProofBackupAuthorities.get([scopeId(), proofRow.proofId]),
    ).toEqual(marker);
  });
});

function scopeId(): string {
  const value = browserWalletScopeIdFromMnemonic(MNEMONIC);
  if (value === null) throw new Error("test wallet scope is invalid");
  return value;
}

function conditionalPreparationKeyset(
  overrides: Record<string, unknown> = {},
): ActiveCtfRangeMintKeyset {
  return {
    canonicalMintUrl: MINT_URL,
    id: CONDITIONAL_KEYSET_ID,
    unit: "msat",
    keys: { "7": bytesToHex(MINT_PUBLIC_KEY) },
    inputFeePpk: 0,
    finalExpiry: null,
    active: true,
    ...CONDITIONAL_METADATA,
    ...overrides,
  } as unknown as ActiveCtfRangeMintKeyset;
}

function regularPreparationKeyset(): ActiveCtfRangeMintKeyset {
  return {
    canonicalMintUrl: MINT_URL,
    id: KEYSET_ID,
    unit: "msat",
    keys: { "7": bytesToHex(MINT_PUBLIC_KEY) },
    inputFeePpk: 0,
    finalExpiry: null,
    active: true,
  };
}

function conditionalReadinessInput(
  overrides: Partial<Parameters<typeof ensureWalletKeysetCounterReady>[0]> = {},
): Parameters<typeof ensureWalletKeysetCounterReady>[0] {
  return {
    scopeId: scopeId(),
    mintUrl: MINT_URL,
    unit: "msat",
    keyset: conditionalPreparationKeyset(),
    conditionalAsset: { conditionId: CONDITION_ID, outcomeCollection: OUTCOME_COLLECTION },
    ...overrides,
  };
}

function regularReadinessInput(): Parameters<typeof ensureWalletKeysetCounterReady>[0] {
  return {
    scopeId: scopeId(),
    mintUrl: MINT_URL,
    unit: "msat",
    keyset: regularPreparationKeyset(),
  };
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
