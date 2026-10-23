// @vitest-environment node
import { serializeDurableWalletSendOperation } from "@bitcaster/client-sdk/durableWalletOperation";
import {
  Amount,
  OutputData,
  createBlindSignature,
  createDLEQProof,
  pointFromHex,
} from "@cashu/cashu-ts";
import { bytesToHex } from "@noble/hashes/utils.js";
import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { createEncryptedWalletBackupV2DesiredAssetRow } from "../../stores/browser-encrypted-wallet-backup-v2-desired-asset";
import { getBoundedCanonicalRegularProofs } from "../../stores/proof-db";
import { executeBrowserDurableOutgoingCashuTransfer } from "../browserDurableOutgoingCashuTransfer";
import {
  readBrowserEncryptedWalletBackupV2LocalAvailableAmount,
  restoreAndAdmitBrowserEncryptedWalletBackupOwnerTargetedAsset,
} from "../browserEncryptedWalletBackupV2Restore";
import { recoverBrowserTargetedAsset } from "../browserTargetedAssetRecovery";
import { createBrowserEncryptedWalletBackupV2RuntimeDriver } from "../encryptedWalletBackupDriver";
import { ownerTargetedRangeFixture } from "./ownerTargetedRangeFixture";

import {
  disposeOwnerTargetedRecoveryFixtures,
  ownerTargetedRecoveryFixture as fixture,
  keysetId,
  locks,
  now,
  privateKey,
  publicKey,
} from "./ownerTargetedRecoveryFixture";
afterEach(disposeOwnerTargetedRecoveryFixtures);

it("restores a genuinely evicted asset through owner inventory/head/object codecs and custody admission", async () => {
  const f = await fixture();
  const result = await recoverBrowserTargetedAsset(f.input);
  expect(result).toEqual({ kind: "restored-backup" });
  expect(f.calls).toContain("current-inventory");
  expect(f.calls).toContain("descriptor-page");
  expect(f.calls).toContain("object-get");
  expect(await f.database.custodyProofs.get([f.input.scopeId, f.local.proofId])).toMatchObject({
    selectability: "selectable",
  });
  expect(f.input.readExactMonitoringRecovery).not.toHaveBeenCalled();
  expect((await f.database.encryptedWalletBackupV2DesiredAssets.toArray())[0]).toMatchObject({
    activeProofCount: 1,
    custodyRevision: "1",
  });
  await restoreAndAdmitBrowserEncryptedWalletBackupOwnerTargetedAsset({
    ...f.input,
    inventory: f.inventory,
    minimumAvailableAmount: 1n,
  });
  expect(await readBrowserEncryptedWalletBackupV2LocalAvailableAmount(f.input)).toBe(1n);
  expect((await f.database.encryptedWalletBackupV2DesiredAssets.toArray())[0]).toMatchObject({
    activeProofCount: 1,
    custodyRevision: "1",
  });
});
for (const fault of ["unavailable", "foreign-owner", "head-change", "abort"] as const)
  it(`refuses ${fault} without publishing custody or mint fallback`, async () => {
    const f = await fixture();
    f.setFault(fault);
    expect(await recoverBrowserTargetedAsset(f.input)).toEqual({ kind: "persistent-error" });
    expect(f.calls).toContain("current-inventory");
    expect(await f.database.custodyProofs.count()).toBe(0);
    expect(f.input.readExactMonitoringRecovery).not.toHaveBeenCalled();
  });

for (const receiptFault of ["missing", "foreign"] as const)
  it(`refuses ${receiptFault} owner receipt for an evicted asset before remote recovery`, async () => {
    const f = await fixture();
    const receipts = await f.database.encryptedWalletBackupOwnerAssetReceipts.toArray();
    await f.database.encryptedWalletBackupOwnerAssetReceipts.clear();
    if (receiptFault === "foreign")
      await f.database.encryptedWalletBackupOwnerAssetReceipts.put({
        ...receipts[0]!,
        ownerScopeId: "cd".repeat(32),
      });
    // A legacy acknowledgement cannot substitute for the current owner's receipt.
    const desired = (await f.database.encryptedWalletBackupV2DesiredAssets.toArray())[0]!;
    await f.database.encryptedWalletBackupV2DesiredAssets.put({
      ...desired,
      syncState: "acknowledged",
    });
    expect(await recoverBrowserTargetedAsset(f.input)).toEqual({ kind: "persistent-error" });
    expect(f.calls).toEqual([]);
    expect(f.input.readExactMonitoringRecovery).not.toHaveBeenCalled();
    expect(await f.database.custodyProofs.count()).toBe(0);
  });

it("spends a restored proof through the durable outgoing custody transaction", async () => {
  const f = await fixture();
  expect(await recoverBrowserTargetedAsset(f.input)).toEqual({ kind: "restored-backup" });
  const output = OutputData.createSingleDeterministicData(1, f.input.seed, 1, keysetId);
  const point = pointFromHex(output.blindedMessage.B_);
  const signature = createBlindSignature(point, privateKey, keysetId);
  const dleq = createDLEQProof(point, privateKey);
  const send = output.toProof(
    {
      id: keysetId,
      amount: Amount.from(1),
      C_: signature.C_.toHex(true),
      dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
    },
    { id: keysetId, keys: { "1": publicKey } },
  );
  const completeSwap = vi.fn(async () => ({ keep: [], send: [send] }));
  const result = await executeBrowserDurableOutgoingCashuTransfer({
    transfer: {
      transferId: "owner-restored-spend",
      mintUrl: f.input.asset.mintUrl,
      unit: "msat",
      requestedAmount: "1",
      deliveryIntent: {
        policy: "bearer-spend-classification",
        tokenBytesLimit: 4096,
        tokenProofLimit: 1,
      },
    },
    prepareWalletSendOperation: async () => {
      const available = await getBoundedCanonicalRegularProofs(
        f.input.asset.mintUrl,
        { scopeId: f.input.scopeId, unit: "msat" },
        f.database,
      );
      expect(available).toHaveLength(1);
      return serializeDurableWalletSendOperation({
        operationId: "wallet-send:owner-restored-spend",
        mintUrl: f.input.asset.mintUrl,
        unit: "msat",
        preview: {
          amount: Amount.from(1),
          fees: Amount.zero(),
          keysetId,
          inputs: [f.proof],
          sendOutputs: [output],
          keepOutputs: [],
          unselectedProofs: [],
        },
      });
    },
    preflightFundedAsset: async () => undefined,
    keepProofDerivationLocators: [],
    wallet: {
      completeSwap,
      checkProofsStates: vi.fn(),
      getKeyset: () => ({
        id: keysetId,
        unit: "msat",
        keys: { "1": publicKey },
        fee: 0,
        verify: () => true,
      }),
    },
    restoreExactOutputs: vi.fn(),
    context: {
      seed: f.input.seed,
      database: f.database,
      now: () => now * 1000,
      randomId: () => "restored-spend",
      requireCapturedProfile: () => {
        if (!f.input.isCurrentProfile()) throw new Error("stale fixture");
      },
      lockManager: locks,
    },
  });
  expect(result.token).not.toBeNull();
  expect(completeSwap).toHaveBeenCalledOnce();
  expect(
    (await f.database.custodyProofs.get([f.input.scopeId, f.local.proofId]))?.selectability,
  ).toBe("spent");
});

it("rolls back owner custody, desired count, counters and coverage when the final owner fence fails", async () => {
  const f = await fixture();
  const original = f.store.assertCurrentRestoreAuthority.bind(f.store);
  vi.spyOn(f.store, "assertCurrentRestoreAuthority").mockImplementation(async (input) => {
    await original(input);
    if (input.proofIds !== undefined) throw new Error("owned final fence fault");
  });
  expect(await recoverBrowserTargetedAsset(f.input)).toEqual({ kind: "persistent-error" });
  expect(f.calls).toContain("object-get");
  expect(await f.database.custodyProofs.count()).toBe(0);
  expect(await f.database.walletCounterCursors.count()).toBe(0);
  expect((await f.database.encryptedWalletBackupV2DesiredAssets.toArray())[0]).toMatchObject({
    activeProofCount: 1,
    custodyRevision: "1",
  });
  expect(f.input.readExactMonitoringRecovery).not.toHaveBeenCalled();
});

it("does not treat pending owner desired state as an evicted acknowledged asset", async () => {
  const f = await fixture();
  const desired = (await f.database.encryptedWalletBackupOwnerDesiredAssets.toArray())[0]!;
  await f.database.encryptedWalletBackupOwnerDesiredAssets.put({
    ...desired,
    syncState: "pending",
  });
  expect(await recoverBrowserTargetedAsset(f.input)).toEqual({ kind: "persistent-error" });
  expect(f.calls).toEqual([]);
  expect(await f.database.custodyProofs.count()).toBe(0);
});

it("refuses remote readmission over a retained desired removal", async () => {
  const f = await fixture();
  await f.database.encryptedWalletBackupV2DesiredAssets.put(
    createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: f.input.scopeId,
      asset: f.input.asset,
      custodyRevision: 2n,
      activeProofCount: 0,
    }),
  );
  await expect(
    restoreAndAdmitBrowserEncryptedWalletBackupOwnerTargetedAsset({
      ...f.input,
      inventory: f.inventory,
      minimumAvailableAmount: 1n,
    }),
  ).rejects.toThrow();
  expect(await f.database.custodyProofs.count()).toBe(0);
  expect((await f.database.encryptedWalletBackupV2DesiredAssets.toArray())[0]?.desiredAction).toBe(
    "remove",
  );
});

it("uses the actual selected-owner driver for targeted codec recovery", async () => {
  const f = await fixture();
  vi.spyOn(f.client, "discover").mockResolvedValue([{ entries: [f.input.owner] }] as never);
  vi.spyOn(f.client, "resolveFirstAccount").mockReturnValue({
    kind: "active",
    owner: f.input.owner,
  });
  vi.spyOn(f.client, "readEnrollmentEpoch").mockResolvedValue({
    status: "active",
    enrollmentEpoch: 1,
  });
  const session = {
    authenticatedOwnerScope: f.input.owner,
    signal: f.input.signal,
    isCurrent: f.input.isCurrentProfile,
    requireCurrent: () => {
      if (!f.input.isCurrentProfile()) throw new Error("stale fixture");
    },
    requireLifecycleOwner: () => f.input.owner,
    dispose() {},
  };
  const driver = createBrowserEncryptedWalletBackupV2RuntimeDriver({
    configuration: {
      realm: f.input.keyHandle.realm,
      signedOrigin: "https://backup.example",
      transportOrigin: "https://backup.example",
      pinnedReceiptKeys: [f.receipt.pinnedSigningKey],
    },
    database: f.database,
    scopeId: f.input.scopeId,
    seed: f.input.seed,
    ownerSession: session,
    ownerClient: f.client,
    runtime: f.runtime,
    signal: f.input.signal,
    isCurrentProfile: f.input.isCurrentProfile,
    runWorkerCycle: vi.fn().mockResolvedValue({ kind: "idle" }) as never,
    leadership: { hold: async (_name, _signal, task) => task() },
    lockManager: locks,
  });
  try {
    await vi.waitFor(async () =>
      expect(await driver.readSelectedOwnerLocalRecoveryStatus()).not.toBeNull(),
    );
    f.calls.length = 0;
    expect(
      await driver.recoverTargetedAsset({
        asset: f.input.asset,
        requiredAmount: 1n,
        loadWallet: f.input.loadWallet,
        readExactMonitoringRecovery: f.input.readExactMonitoringRecovery,
        lockManager: locks,
      }),
    ).toEqual({ kind: "restored-backup" });
    expect(f.calls).toContain("current-inventory");
    expect(f.calls).toContain("object-get");
    expect(await readBrowserEncryptedWalletBackupV2LocalAvailableAmount(f.input)).toBe(1n);
  } finally {
    driver.stop();
  }
});

for (const side of ["Buy", "Sell"] as const)
  it(`rehydrates verified ${side} conditional successors with their saved counter preparation`, async () => {
    const source = await ownerTargetedRangeFixture(side);
    const f = await fixture(source);
    expect(await recoverBrowserTargetedAsset(f.input)).toEqual({ kind: "restored-backup" });
    const restored = await f.database.custodyProofs.get([f.input.scopeId, f.local.proofId]);
    expect(restored?.selectability).toBe("selectable");
    expect(restored?.assetKind).toBe("conditional");
    expect(restored?.conditionId).toBe(source.asset.conditionId);
    expect((await f.database.custodyProofBackupAuthorities.toArray())[0]).toMatchObject({
      derivationLocator: source.locator,
    });
    expect((await f.database.encryptedWalletBackupV2DesiredAssets.toArray())[0]).toMatchObject({
      activeProofCount: 1,
      custodyRevision: "1",
    });
    expect(await readBrowserEncryptedWalletBackupV2LocalAvailableAmount(f.input)).toBe(
      BigInt(source.proof.amount.toString()),
    );
  });
