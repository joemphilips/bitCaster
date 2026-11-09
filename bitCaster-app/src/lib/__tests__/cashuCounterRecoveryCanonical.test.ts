import { requireValidCashuProofs } from "@bitcaster/client-sdk";
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
import {
  SEED_RESTORE_SCAN_CONTINUATIONS_MAX,
  deleteSeedRestoreDatabase,
  recordSeedRestoreDeferralFailure,
  seedRestoreDatabase,
  settleSeedRestoreDeferral,
} from "../../stores/seed-restore-db";

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
// A test can lower the counter budget of the SDK admitting scan. A budget
// test then stays small; the SDK tests cover the default budget.
const scanBudget = vi.hoisted(() => ({ counters: undefined as number | undefined }));

vi.mock("@bitcaster/client-sdk/seedCounterAdmissionScan", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@bitcaster/client-sdk/seedCounterAdmissionScan")>();
  return {
    ...actual,
    scanSeedCountersForAdmission: (
      input: Parameters<typeof actual.scanSeedCountersForAdmission>[0],
    ) =>
      actual.scanSeedCountersForAdmission(
        scanBudget.counters === undefined
          ? input
          : { ...input, maxScannedCounters: scanBudget.counters },
      ),
  };
});

const wallet = {
  mint: {
    mintUrl: MINT_URL,
    getKeySets: vi.fn(),
    restore: vi.fn(),
  },
  keyChain: {
    registerConditionalKeyset: vi.fn((meta, keys) => {
      const registered = Keyset.fromMintApi(meta, keys);
      knownKeysets.set(registered.id, registered);
      return registered;
    }),
    ensureKeysetKeys: vi.fn(async (id: string) => knownKeysets.get(id)!),
  },
  getKeyset: vi.fn((id = KEYSET_ID) => knownKeysets.get(id)!),
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
  advanceWalletKeysetCounterPastMint,
  recoverKeysetCountersForMint,
  rescanBrowserRegularKeyset,
  WalletKeysetCounterReadinessError,
} from "../cashu";
import { retryBrowserSeedPositionRestore } from "../browserSeedPositionRestore";
import { readSeedPositionRestoreStatus } from "@/hooks/useSeedPositionRestoreStatus";

describe("recoverKeysetCountersForMint — canonical custody", () => {
  let database: BitcasterDB | null = null;

  beforeEach(() => {
    const scopeId = browserWalletScopeIdFromMnemonic(MNEMONIC);
    if (scopeId === null) throw new Error("test wallet scope is invalid");
    setActiveBrowserWalletProfile(MNEMONIC);
    activateBrowserWalletDatabase(scopeId);
    database = db;
    wallet.mint.getKeySets.mockReset();
    wallet.mint.restore.mockReset();
    wallet.mint.getKeySets.mockResolvedValue({
      keysets: [keyset.toMintKeyset() as MintKeyset],
    });
    knownKeysets.clear();
    knownKeysets.set(KEYSET_ID, keyset);
    knownKeysets.set(CONDITIONAL_KEYSET_ID, conditionalKeyset);
    wallet.keyChain.registerConditionalKeyset.mockClear();
    wallet.getKeyset.mockClear();
    wallet.getKeyset.mockImplementation((id = KEYSET_ID) => knownKeysets.get(id)!);
    wallet.groupProofsByState.mockReset();
    mintSigned([]);
    mintStates();
    scanBudget.counters = undefined;
    walletLockState.held = false;
    walletLockState.calls = 0;
  });

  afterEach(async () => {
    const active = database;
    database = null;
    // The restore record keeps deferral markers. A marker of one test must
    // not move the scan start of the next one.
    await deleteSeedRestoreDatabase(scopeId());
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

    expect(wallet.mint.restore).not.toHaveBeenCalled();
    expect(await database!.walletCounterAssociations.count()).toBe(0);
  });

  it("marks an empty regular scan ready and reserves from zero", async () => {
    mintSigned([]);

    await expect(
      recoverKeysetCountersForMint(MINT_URL, { unit: "msat", keysetId: KEYSET_ID }),
    ).resolves.toEqual({ scannedKeysets: [KEYSET_ID], complete: true, failed: false });

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
    mintSigned(range(0, 4), CONDITIONAL_KEYSET_ID);

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
    expect(requestedOutputs(0)[0]).toMatchObject({
      id: CONDITIONAL_KEYSET_ID,
      B_: outputOf(CONDITIONAL_KEYSET_ID, 0),
    });
    const scanRequests = wallet.mint.restore.mock.calls.length;
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

    expect(wallet.mint.restore).toHaveBeenCalledTimes(scanRequests);
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

    expect(wallet.mint.restore).not.toHaveBeenCalled();
    expect(await database!.walletCounterAssociations.count()).toBe(0);
  });

  it("coalesces concurrent readiness scans for the same exact conditional keyset", async () => {
    mintSigned(range(0, 1), CONDITIONAL_KEYSET_ID);
    const answer = wallet.mint.restore.getMockImplementation()!;
    let releaseRestore!: () => void;
    const restoreReleased = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    wallet.mint.restore.mockImplementation(async (payload: RestorePayload) => {
      await restoreReleased;
      return answer(payload);
    });

    const first = ensureWalletKeysetCounterReady(conditionalReadinessInput());
    const second = ensureWalletKeysetCounterReady(conditionalReadinessInput());
    await vi.waitFor(() => expect(wallet.mint.restore).toHaveBeenCalledTimes(1));
    releaseRestore();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(wallet.keyChain.registerConditionalKeyset).toHaveBeenCalledTimes(1);
  });

  it("keeps exact conditional high-water monotonic during forced repair", async () => {
    // Only the highest signed counter sets the high-water mark.
    mintSigned([100], CONDITIONAL_KEYSET_ID);
    await ensureWalletKeysetCounterReady(conditionalReadinessInput());
    mintSigned([7], CONDITIONAL_KEYSET_ID);
    const scanRequests = wallet.mint.restore.mock.calls.length;
    const association = await database!.walletCounterAssociations.get([
      scopeId(),
      MINT_URL,
      "msat",
      CONDITIONAL_KEYSET_ID,
    ]);
    if (association === undefined) throw new Error("conditional counter association is missing");
    await database!.walletCounterAssociations.put({ ...association, recoveryComplete: false });

    await ensureWalletKeysetCounterReady(conditionalReadinessInput());
    expect(wallet.mint.restore.mock.calls.length).toBeGreaterThan(scanRequests);

    expect(
      await database!.walletCounterCursors.get([scopeId(), CONDITIONAL_KEYSET_ID]),
    ).toMatchObject({
      next: 101,
    });
  });

  it("advances a completed conditional keyset past outputs that another client signed", async () => {
    mintSigned(range(0, 4), CONDITIONAL_KEYSET_ID);
    await ensureWalletKeysetCounterReady(conditionalReadinessInput());
    const scanRequests = wallet.mint.restore.mock.calls.length;
    // A completed keyset is not scanned again, so the browser keeps its stale cursor.
    await ensureWalletKeysetCounterReady(conditionalReadinessInput());
    expect(wallet.mint.restore).toHaveBeenCalledTimes(scanRequests);
    const locks = walletLockState.calls;
    const custodyProofs = await database!.custodyProofs.count();

    // The other client signed counters 5 to 40. The counter-only scan uses
    // NUT-09 directly with a work bound, and it restores no proof.
    const signed = new Set(
      Array.from(
        { length: 36 },
        (_, offset) =>
          OutputData.createSingleDeterministicData(1, SEED, 5 + offset, CONDITIONAL_KEYSET_ID)
            .blindedMessage.B_,
      ),
    );
    wallet.mint.restore.mockClear();
    wallet.mint.restore.mockImplementation(async ({ outputs }: { outputs: { B_: string }[] }) => ({
      outputs: outputs.filter(({ B_ }) => signed.has(B_)),
      signatures: [],
    }));
    const { profileLockHeld: _held, ...input } = conditionalReadinessInput();
    await advanceWalletKeysetCounterPastMint(input);

    // The scan starts at the cursor.
    const [firstScan] = wallet.mint.restore.mock.calls[0]!;
    expect((firstScan as { outputs: { B_: string }[] }).outputs[0]!.B_).toBe(
      OutputData.createSingleDeterministicData(1, SEED, 5, CONDITIONAL_KEYSET_ID).blindedMessage.B_,
    );
    expect(
      await database!.walletCounterCursors.get([scopeId(), CONDITIONAL_KEYSET_ID]),
    ).toMatchObject({ next: 41 });
    // The other client's outputs stay with that client. Nothing is admitted here,
    // so the caller's profile lock and custody scope are not taken again.
    expect(await database!.custodyProofs.count()).toBe(custodyProofs);
    expect(walletLockState.calls).toBe(locks);
  });

  it("reports a failed counter advance", async () => {
    mintSigned(range(0, 4), CONDITIONAL_KEYSET_ID);
    await ensureWalletKeysetCounterReady(conditionalReadinessInput());
    wallet.mint.restore.mockRejectedValueOnce(new Error("restore is offline"));
    const { profileLockHeld: _held, ...input } = conditionalReadinessInput();

    await expect(advanceWalletKeysetCounterPastMint(input)).rejects.toBeInstanceOf(
      WalletKeysetCounterReadinessError,
    );
    expect(
      await database!.walletCounterCursors.get([scopeId(), CONDITIONAL_KEYSET_ID]),
    ).toMatchObject({ next: 5 });
  });

  it("does not recursively acquire a profile lock when its caller already holds it", async () => {
    mintSigned(range(0, 2), CONDITIONAL_KEYSET_ID);

    await withWalletProfileLock(scopeId(), () =>
      ensureWalletKeysetCounterReady(conditionalReadinessInput({ profileLockHeld: true })),
    );

    expect(walletLockState.calls).toBe(1);
    expect(wallet.mint.restore).toHaveBeenCalled();
    expect(
      await database!.walletCounterCursors.get([scopeId(), CONDITIONAL_KEYSET_ID]),
    ).toMatchObject({
      next: 3,
    });
  });

  it("fails closed when the wallet profile changes during selected recovery", async () => {
    const otherMnemonic =
      "legal winner thank year wave sausage worth useful legal winner thank yellow";
    mintSigned(range(0, 2), CONDITIONAL_KEYSET_ID);
    const answer = wallet.mint.restore.getMockImplementation()!;
    wallet.mint.restore.mockImplementation(async (payload: RestorePayload) => {
      setActiveBrowserWalletProfile(otherMnemonic);
      return answer(payload);
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
    mintSigned([]);
    await recoverKeysetCountersForMint(MINT_URL, {
      force: true,
      unit: "msat",
      keysetId: KEYSET_ID,
    });
    const scanRequests = wallet.mint.restore.mock.calls.length;

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
    expect(wallet.mint.restore).toHaveBeenCalledTimes(scanRequests);
  });

  // Five real scans of about 300 derived outputs each, so this case has a longer bound.
  it("admits only unspent restored value into canonical custody and is retry-safe", async () => {
    const proofs = [restoredProof(0), restoredProof(1), restoredProof(2)];
    expect(keyset.verify()).toBe(true);
    expect(() => requireValidCashuProofs(proofs, () => keyset)).not.toThrow();
    mintSigned(range(0, 2));
    mintStates(
      new Map([
        [0, "unspent"],
        [1, "pending"],
      ]),
    );

    const first = await recoverKeysetCountersForMint(MINT_URL, { force: true });
    const second = await recoverKeysetCountersForMint(MINT_URL, { force: true });

    // A PENDING proof keeps the keyset incomplete. The counter still advances (ADR-033).
    const pending = {
      scannedKeysets: [KEYSET_ID],
      complete: false,
      failed: false,
      pendingKeysets: [KEYSET_ID],
    };
    expect(first).toEqual(pending);
    expect(second).toEqual(pending);
    expect(
      await database!.walletCounterAssociations.get([scopeId(), MINT_URL, "msat", KEYSET_ID]),
    ).toMatchObject({ recoveryComplete: false });
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
    expect(selectableRetry).toEqual(pending);
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
    expect(spentRetry).toEqual(pending);
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
    expect(lockedRetry).toEqual(pending);
    expect(await database!.custodyProofs.get([scopeId(), existing.proofId])).toMatchObject({
      revision: spent.revision + 1,
      selectability: "locked",
      reservationOperationId: "reservation:test",
    });
    expect(await database!.proofs.count()).toBe(0);
  }, 30_000);

  it("fails closed without admission when the mint answers with zero-amount signatures", async () => {
    // Zero-amount signatures for every queried output would keep a gap scan
    // running. The SDK scan refuses the first one.
    wallet.mint.restore.mockImplementation(async ({ outputs }: RestorePayload) =>
      restoreAnswer(outputs, (B_) => ({
        ...mintSignatureFor(KEYSET_ID, B_),
        amount: Amount.from(0),
      })),
    );

    await expect(
      recoverKeysetCountersForMint(MINT_URL, { unit: "msat", keysetId: KEYSET_ID }),
    ).resolves.toEqual({ scannedKeysets: [], complete: false, failed: true });
    expect(wallet.mint.restore).toHaveBeenCalledTimes(1);
    expect(await database!.custodyProofs.count()).toBe(0);
    expect(await database!.walletCounterCursors.count()).toBe(0);
    expect(await database!.walletCounterAssociations.count()).toBe(0);
  });

  // Each signed output costs real curve work, so this case has a longer bound.
  it("ends a pass at its counter budget when the mint signs every output, and resumes at the marker", async () => {
    scanBudget.counters = 40;
    // The mint signs every queried output, so a scan never sees a gap.
    wallet.mint.restore.mockImplementation(async ({ outputs }: RestorePayload) =>
      restoreAnswer(outputs, (B_) => mintSignatureFor(KEYSET_ID, B_)),
    );
    const continued = {
      scannedKeysets: [KEYSET_ID],
      complete: false,
      failed: false,
      pendingKeysets: [KEYSET_ID],
      continuedKeysets: [KEYSET_ID],
    };

    const first = await recoverKeysetCountersForMint(MINT_URL, {
      unit: "msat",
      keysetId: KEYSET_ID,
    });

    expect(first).toEqual(continued);
    expect(requestedOutputCount()).toBe(40);
    // The pass advanced the cursor past the signed outputs, and the keyset
    // stays incomplete. The restore record keeps where the scan stopped.
    expect(await database!.walletCounterCursors.get([scopeId(), KEYSET_ID])).toMatchObject({
      next: 40,
    });
    expect(
      await database!.walletCounterAssociations.get([scopeId(), MINT_URL, "msat", KEYSET_ID]),
    ).toMatchObject({ recoveryComplete: false });
    expect(await resyncRow(KEYSET_ID)).toMatchObject({
      pendingFromCounter: 40,
      waitReason: "scan-budget",
      failures: 0,
      scanContinuations: 1,
    });

    wallet.mint.restore.mockClear();
    const second = await recoverKeysetCountersForMint(MINT_URL, {
      unit: "msat",
      keysetId: KEYSET_ID,
    });

    expect(second).toEqual(continued);
    expect(requestedOutputs(0)[0]!.B_).toBe(outputOf(KEYSET_ID, 40));
    expect(requestedOutputCount()).toBe(40);
    expect(await database!.walletCounterCursors.get([scopeId(), KEYSET_ID])).toMatchObject({
      next: 80,
    });
    expect(await resyncRow(KEYSET_ID)).toMatchObject({
      pendingFromCounter: 80,
      waitReason: "scan-budget",
      failures: 0,
      scanContinuations: 2,
    });
  }, 30_000);

  it("refuses order readiness while a scan continues past its budget, without a pending-funds error", async () => {
    scanBudget.counters = 20;
    wallet.mint.restore.mockImplementation(async ({ outputs }: RestorePayload) =>
      restoreAnswer(outputs, (B_) => mintSignatureFor(CONDITIONAL_KEYSET_ID, B_)),
    );

    // No funds are pending at the mint. The scan only has more counters to read.
    await expect(ensureWalletKeysetCounterReady(conditionalReadinessInput())).rejects.toMatchObject(
      {
        name: "WalletKeysetCounterReadinessError",
        message: new WalletKeysetCounterReadinessError().message,
      },
    );
    expect(await resyncRow(CONDITIONAL_KEYSET_ID)).toMatchObject({
      pendingFromCounter: 20,
      waitReason: "scan-budget",
    });
  });

  it("scans past a budget window that holds a PENDING proof, and checks that proof again later", async () => {
    // The budget stays above the gap limit, as the SDK budget does, so a resumed
    // scan of an empty range ends.
    scanBudget.counters = 400;
    // Counter 5 is PENDING. The UNSPENT outputs at 500 and 750 lie beyond the first window.
    mintSigned([5, 250, 500, 750]);
    mintStates(
      new Map([
        [5, "pending"],
        [250, "unspent"],
        [500, "unspent"],
        [750, "unspent"],
      ]),
    );
    const scanStarts: string[] = [];
    for (let pass = 0; pass < 3; pass++) {
      wallet.mint.restore.mockClear();
      await recoverKeysetCountersForMint(MINT_URL, { unit: "msat", keysetId: KEYSET_ID });
      scanStarts.push(requestedOutputs(0)[0]!.B_);
    }

    expect(scanStarts).toEqual([0, 400, 800].map((n) => outputOf(KEYSET_ID, n)));
    expect(await database!.custodyProofs.count()).toBe(3);
    // The scan ended. The PENDING proof waits in its own marker, with its backoff.
    expect(await resyncRow(KEYSET_ID)).toMatchObject({
      pendingFromCounter: 5,
      waitReason: "pending-proof",
      failures: 1,
    });
    expect(
      await database!.walletCounterAssociations.get([scopeId(), MINT_URL, "msat", KEYSET_ID]),
    ).toMatchObject({ recoveryComplete: false });

    // After its backoff, the next pass checks the PENDING proof again.
    await seedRestoreDatabase(scopeId()).resync.update([scopeId(), MINT_URL, KEYSET_ID], {
      nextAttemptAtMs: 0,
    });
    mintStates(
      new Map([
        [5, "unspent"],
        [250, "unspent"],
        [500, "unspent"],
        [750, "unspent"],
      ]),
    );
    wallet.mint.restore.mockClear();
    await recoverKeysetCountersForMint(MINT_URL, { unit: "msat", keysetId: KEYSET_ID });
    expect(requestedOutputs(0)[0]!.B_).toBe(outputOf(KEYSET_ID, 5));
    expect(await database!.custodyProofs.count()).toBe(4);
  }, 60_000);

  it("keeps the position and the backoff of a continuation whose scan failed", async () => {
    scanBudget.counters = 40;
    wallet.mint.restore.mockImplementation(async ({ outputs }: RestorePayload) =>
      restoreAnswer(outputs, (B_) => mintSignatureFor(KEYSET_ID, B_)),
    );
    await recoverKeysetCountersForMint(MINT_URL, { unit: "msat", keysetId: KEYSET_ID });
    const key: [string, string, string] = [scopeId(), MINT_URL, KEYSET_ID];

    // The deferral pass records two failed scans of the continuation.
    for (const _ of [1, 2]) {
      await recordSeedRestoreDeferralFailure({
        scopeId: scopeId(),
        mintUrl: MINT_URL,
        keysetId: KEYSET_ID,
        nowMs: 1_000,
      });
    }
    const failed = await resyncRow(KEYSET_ID);
    expect(failed).toMatchObject({
      pendingFromCounter: 40,
      waitReason: "scan-budget",
      failures: 2,
    });
    // The second failure backs off 30 seconds, with 25 percent jitter.
    expect(failed!.nextAttemptAtMs).toBeGreaterThanOrEqual(1_000 + 22_500);

    // After the backoff, the scan resumes at its position and still covers the lower counters.
    await seedRestoreDatabase(scopeId()).resync.update(key, { nextAttemptAtMs: 0 });
    wallet.mint.restore.mockClear();
    await recoverKeysetCountersForMint(MINT_URL, { unit: "msat", keysetId: KEYSET_ID });
    expect(requestedOutputs(0)[0]!.B_).toBe(outputOf(KEYSET_ID, 40));
    expect(await resyncRow(KEYSET_ID)).toMatchObject({
      pendingFromCounter: 80,
      waitReason: "scan-budget",
      failures: 0,
    });
  }, 30_000);

  it("does not move a continuation back when a forced scan from counter 0 stops at its budget", async () => {
    scanBudget.counters = 40;
    wallet.mint.restore.mockImplementation(async ({ outputs }: RestorePayload) =>
      restoreAnswer(outputs, (B_) => mintSignatureFor(KEYSET_ID, B_)),
    );
    await recoverKeysetCountersForMint(MINT_URL, { unit: "msat", keysetId: KEYSET_ID });
    await recoverKeysetCountersForMint(MINT_URL, { unit: "msat", keysetId: KEYSET_ID });
    expect(await resyncRow(KEYSET_ID)).toMatchObject({ pendingFromCounter: 80 });

    await recoverKeysetCountersForMint(MINT_URL, {
      force: true,
      unit: "msat",
      keysetId: KEYSET_ID,
    });

    expect(await resyncRow(KEYSET_ID)).toMatchObject({
      pendingFromCounter: 80,
      waitReason: "scan-budget",
    });
  }, 30_000);

  it("stops automatic continuations at the cap and shows the restore error until Retry", async () => {
    const key: [string, string, string] = [scopeId(), MINT_URL, KEYSET_ID];
    for (let pass = 1; pass <= SEED_RESTORE_SCAN_CONTINUATIONS_MAX + 1; pass++) {
      await settleSeedRestoreDeferral({
        scopeId: scopeId(),
        mintUrl: MINT_URL,
        keysetId: KEYSET_ID,
        scannedFrom: (pass - 1) * 3_000,
        pendingFrom: null,
        continueFrom: pass * 3_000,
        condition: null,
        nowMs: 0,
      });
    }
    const capped = (SEED_RESTORE_SCAN_CONTINUATIONS_MAX + 1) * 3_000;
    expect(await resyncRow(KEYSET_ID)).toMatchObject({
      pendingFromCounter: capped,
      waitReason: "scan-budget",
    });
    expect(await readSeedPositionRestoreStatus(scopeId())).toEqual({
      kind: "failed",
      scopeId: scopeId(),
    });

    // The deferral pass sends no mint request for a capped continuation.
    mintSigned([]);
    const result = await rescanBrowserRegularKeyset({
      mintUrl: MINT_URL,
      keysetId: KEYSET_ID,
      startCounter: capped,
    });
    expect(result.scannedKeysets).toEqual([]);
    expect(wallet.mint.restore).not.toHaveBeenCalled();

    // Retry starts the chain again from its position.
    await retryBrowserSeedPositionRestore(scopeId());
    expect(await seedRestoreDatabase(scopeId()).resync.get(key)).toMatchObject({
      pendingFromCounter: capped,
      waitReason: "scan-budget",
      failures: 0,
      nextAttemptAtMs: 0,
      scanContinuations: 0,
    });
    expect((await readSeedPositionRestoreStatus(scopeId())).kind).not.toBe("failed");
    await recoverKeysetCountersForMint(MINT_URL, { unit: "msat", keysetId: KEYSET_ID });
    expect(requestedOutputs(0)[0]!.B_).toBe(outputOf(KEYSET_ID, capped));
  }, 30_000);

  // The default budget derives about 4,400 outputs, so this case has a longer bound.
  it("recovers a sparse proof beyond one scan budget in the next pass", async () => {
    // Signed counters 250 apart keep each gap below the gap limit. Counter
    // 4,097 lies beyond one scan budget, so the next pass reaches it from the
    // marker that the first pass kept.
    mintSigned([...Array.from({ length: 17 }, (_, index) => index * 250), 4_097]);
    mintStates(new Map([[4_097, "unspent"]]));

    const first = await recoverKeysetCountersForMint(MINT_URL, {
      unit: "msat",
      keysetId: KEYSET_ID,
    });

    expect(first).toEqual({
      scannedKeysets: [KEYSET_ID],
      complete: false,
      failed: false,
      pendingKeysets: [KEYSET_ID],
      continuedKeysets: [KEYSET_ID],
    });
    expect(await database!.custodyProofs.count()).toBe(0);

    const second = await recoverKeysetCountersForMint(MINT_URL, {
      unit: "msat",
      keysetId: KEYSET_ID,
    });

    expect(second).toEqual({ scannedKeysets: [KEYSET_ID], complete: true, failed: false });
    expect(await database!.custodyProofs.toArray()).toEqual([
      expect.objectContaining({ amount: 7, selectability: "selectable" }),
    ]);
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
    expect(
      await database!.walletCounterAssociations.get([scopeId(), MINT_URL, "msat", KEYSET_ID]),
    ).toMatchObject({ recoveryComplete: true });
    expect(await resyncRow(KEYSET_ID)).toMatchObject({
      pendingFromCounter: null,
      waitReason: null,
    });
  }, 60_000);

  it("fails closed on conflicting existing canonical material", async () => {
    mintSigned([0]);
    mintStates(new Map([[0, "unspent"]]));
    await expect(recoverKeysetCountersForMint(MINT_URL, { force: true })).resolves.toEqual({
      scannedKeysets: [KEYSET_ID],
      complete: true,
      failed: false,
    });

    const [existing] = await database!.custodyProofs.toArray();
    if (existing === undefined) throw new Error("recovered custody proof is missing");
    await database!.custodyProofs.put({ ...existing, amount: existing.amount + 1 });

    await expect(recoverKeysetCountersForMint(MINT_URL, { force: true })).resolves.toEqual({
      scannedKeysets: [],
      complete: false,
      failed: true,
    });
    expect(await database!.walletCounterCursors.get([scopeId(), KEYSET_ID])).toMatchObject({
      next: 1,
    });
  });

  it("fails closed on conflicting canonical backup locator", async () => {
    mintSigned([0]);
    mintStates(new Map([[0, "unspent"]]));
    await expect(recoverKeysetCountersForMint(MINT_URL, { force: true })).resolves.toEqual({
      scannedKeysets: [KEYSET_ID],
      complete: true,
      failed: false,
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
      failed: true,
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
    mintSigned([0]);
    mintStates(new Map([[0, "unspent"]]));

    await expect(recoverKeysetCountersForMint(MINT_URL, { force: true })).resolves.toEqual({
      scannedKeysets: [],
      complete: false,
      failed: true,
    });
    expect(await database!.custodyProofs.count()).toBe(0);
    expect(await database!.proofs.count()).toBe(0);
    // The rejected admission also leaves the counter as it was.
    expect(await database!.walletCounterCursors.count()).toBe(0);
    expect(await database!.walletCounterAssociations.count()).toBe(0);
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
  return output.toProof(mintSignatureFor(KEYSET_ID, output.blindedMessage.B_), keyset);
}

type RestorePayload = { outputs: { B_: string; id: string }[] };
type TestMintSignature = {
  id: string;
  amount: Amount;
  C_: string;
  dleq: { s: string; e: string };
};

function outputOf(keysetId: string, counter: number): string {
  return OutputData.createSingleDeterministicData(0, SEED, counter, keysetId).blindedMessage.B_;
}

function secretOf(keysetId: string, counter: number): string {
  return new TextDecoder().decode(
    OutputData.createSingleDeterministicData(0, SEED, counter, keysetId).secret,
  );
}

function range(from: number, through: number): number[] {
  return Array.from({ length: through - from + 1 }, (_, offset) => from + offset);
}

// A mint stores one signature for each output, so a restore returns the same one.
const mintSignatures = new Map<string, TestMintSignature>();

function mintSignatureFor(keysetId: string, B_: string): TestMintSignature {
  const key = `${keysetId}:${B_}`;
  const existing = mintSignatures.get(key);
  if (existing !== undefined) return existing;
  const blindedMessage = pointFromHex(B_);
  const dleq = createDLEQProof(blindedMessage, MINT_PRIVATE_KEY);
  const signature = {
    id: keysetId,
    amount: Amount.from(7),
    C_: createBlindSignature(blindedMessage, MINT_PRIVATE_KEY, keysetId).C_.toHex(true),
    dleq: { s: bytesToHex(dleq.s), e: bytesToHex(dleq.e) },
  };
  mintSignatures.set(key, signature);
  return signature;
}

/** A NUT-09 answer that names only the outputs that the mint signed. */
function restoreAnswer(
  outputs: RestorePayload["outputs"],
  signatureFor: (B_: string) => TestMintSignature | undefined,
) {
  const signed = outputs.flatMap((output) => {
    const signature = signatureFor(output.B_);
    return signature === undefined ? [] : [{ output, signature }];
  });
  return {
    outputs: signed.map(({ output }) => output),
    signatures: signed.map(({ signature }) => signature),
  };
}

/** The mint signed the outputs of these counters of one keyset. */
function mintSigned(counters: Iterable<number>, keysetId = KEYSET_ID): void {
  const signed = new Set([...counters].map((counter) => outputOf(keysetId, counter)));
  wallet.mint.restore.mockImplementation(async ({ outputs }: RestorePayload) =>
    restoreAnswer(outputs, (B_) => (signed.has(B_) ? mintSignatureFor(keysetId, B_) : undefined)),
  );
}

/** The NUT-07 state of restored regular proofs by counter. Every other proof is spent. */
function mintStates(states: ReadonlyMap<number, "unspent" | "pending"> = new Map()): void {
  const bySecret = new Map(
    [...states].map(([counter, state]) => [secretOf(KEYSET_ID, counter), state]),
  );
  wallet.groupProofsByState.mockImplementation(async (proofs: Proof[]) => ({
    unspent: proofs.filter(({ secret }) => bySecret.get(secret) === "unspent"),
    pending: proofs.filter(({ secret }) => bySecret.get(secret) === "pending"),
    spent: proofs.filter(({ secret }) => !bySecret.has(secret)),
  }));
}

function requestedOutputs(call: number): RestorePayload["outputs"] {
  return (wallet.mint.restore.mock.calls[call]![0] as RestorePayload).outputs;
}

function requestedOutputCount(): number {
  return wallet.mint.restore.mock.calls.reduce(
    (total, [payload]) => total + (payload as RestorePayload).outputs.length,
    0,
  );
}

async function resyncRow(keysetId: string) {
  return seedRestoreDatabase(scopeId()).resync.get([scopeId(), MINT_URL, keysetId]);
}
