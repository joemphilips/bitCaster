// @vitest-environment node
import "fake-indexeddb/auto";
import { Amount, deriveKeysetId, Keyset, type Wallet as CashuWallet } from "@cashu/cashu-ts";
import {
  createEncryptedWalletBackupV2AssetIdentity,
  encryptedWalletBackupV2LocalAssetKey,
  verifyEncryptedWalletBackupV2RestoredProofSet,
} from "@bitcaster/client-sdk";
import { deriveDurableWalletProofSecret } from "@bitcaster/client-sdk/durableWalletProofDerivationLocator";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserEncryptedWalletBackupV2CacheRemovalEligibleAsset } from "../browserEncryptedWalletBackupV2SeedHandoff";
import { createBrowserCustodyProofRow } from "../../stores/durable-custody-db";
import { BitcasterDB } from "../../stores/proof-db";
import { EncryptedWalletBackupOwnerDexieAuthorityStore } from "../../stores/encrypted-wallet-backup-owner-db";
import { browserWalletScope } from "../browserCtfRangeOrderSource";
import { browserWalletDatabaseName } from "../browserWalletProfile";
import { retryBrowserEncryptedWalletBackupV2QuotaWrite } from "../browserEncryptedWalletBackupV2QuotaCleanup";
import { admitBrowserEncryptedWalletBackupV2Asset } from "../browserEncryptedWalletBackupV2Admission";
import {
  listBrowserEncryptedWalletBackupOwnerEvictedAssetMonitoringFacts,
  listBrowserEncryptedWalletBackupOwnerCacheRemovalEligibleAssets,
} from "../browserEncryptedWalletBackupV2SeedHandoff";
import { createBrowserCompletedProofRemovalMarkerRow } from "../../stores/browser-proof-backup-authority";
import { digestEncryptedWalletBackupV2BundleDescriptor } from "@bitcaster/client-sdk/encryptedWalletBackupV2Descriptor";
import { ownerReachabilitySnapshot } from "./ownerReachabilityFixture";
import {
  collectEncryptedWalletBackupOwnerDescriptorPages,
  createEncryptedWalletBackupOwnerCurrentHead,
  enumerateEncryptedWalletBackupOwnerDescriptorPages,
} from "@bitcaster/client-sdk/encryptedWalletBackupOwnerHead";
import { digestEncryptedWalletBackupOwnerBundleSupersessionReceipt } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerReceipt";

import {
  readAssetMonitoringSnapshot,
  buildBrowserAssetMonitoringHoldings,
  subscribeToCommittedProofChanges,
} from "../../hooks/useAssetMonitoringReporter";
import {
  registerBrowserEncryptedWalletBackupV2RuntimeDriver,
  subscribeToBrowserEncryptedBackupMonitoring,
  type BrowserEncryptedWalletBackupV2RuntimeDriver,
} from "../encryptedWalletBackupDriver";

// Keep the actual owner driver registry, custody/owner stores, snapshot reader and
// holdings builder. Control only profile selection and the remote catalogue.
const monitoring = vi.hoisted(() => ({
  scope: null as string | null,
  catalogue: vi.fn(async () => []),
}));
vi.mock("../browserWalletProfile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../browserWalletProfile")>()),
  activeBrowserWalletScopeId: () => monitoring.scope,
}));
vi.mock("../assetMonitoringReporter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../assetMonitoringReporter")>()),
  fetchAssetMonitoringCatalogue: monitoring.catalogue,
}));

const scopeId = browserWalletScope(new Uint8Array(64).fill(9)).scopeId;
const SEED = new Uint8Array(64).fill(9);
const OWNER_SCOPE_ID = "ab".repeat(32);
const KEYSET_ID = deriveKeysetId(
  { 1: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" },
  { unit: "msat", versionByte: 1 },
);
const { eligible } = vi.hoisted(() => ({ eligible: vi.fn() }));

vi.mock("../browserEncryptedWalletBackupV2SeedHandoff", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../browserEncryptedWalletBackupV2SeedHandoff")>();
  return { ...actual, listBrowserEncryptedWalletBackupV2CacheRemovalEligibleAssets: eligible };
});

describe("browser encrypted wallet backup V2 quota cleanup", () => {
  let database: BitcasterDB | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    monitoring.scope = null;
    monitoring.catalogue.mockReset().mockResolvedValue([]);
    eligible.mockReset();
    database?.close();
    if (database) await database.delete();
    database = null;
  });

  it("passes a non-quota write error through without cleanup", async () => {
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    const failure = new Error("write failed");

    await expect(
      retryBrowserEncryptedWalletBackupV2QuotaWrite({
        database,
        scopeId,
        isCurrentProfile: () => true,
        write: async () => {
          throw failure;
        },
        lockManager: immediateLockManager(),
      }),
    ).rejects.toBe(failure);
    expect(eligible).not.toHaveBeenCalled();
  });

  it("rethrows the original quota error when no candidate is eligible", async () => {
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    eligible.mockResolvedValue([]);
    const quota = quotaError();
    const write = vi.fn(async () => {
      throw quota;
    });

    await expect(
      retryBrowserEncryptedWalletBackupV2QuotaWrite({
        database,
        scopeId,
        isCurrentProfile: () => true,
        write,
        lockManager: immediateLockManager(),
      }),
    ).rejects.toBe(quota);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("does not treat a legacy V2 receipt as owner-bound quota deletion authority", async () => {
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    const protectedCandidate = await candidate(database, "protected", "11", 1);
    const small = await candidate(database, "small", "22", 2);
    const largest = await candidate(database, "largest", "33", 3, 20);
    eligible.mockResolvedValue([protectedCandidate, small, largest]);
    const write = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(quotaError())
      .mockResolvedValueOnce("written");

    await expect(
      retryBrowserEncryptedWalletBackupV2QuotaWrite({
        database,
        scopeId,
        isCurrentProfile: () => true,
        protectedLocalAssetKeys: ["protected"],
        write,
        lockManager: immediateLockManager(),
      }),
    ).rejects.toThrow(/quota/);
    expect(write).toHaveBeenCalledTimes(1);
    expect(await database.custodyProofs.get([scopeId, largest.proofs[0]!.proofId])).toBeDefined();
    expect(
      await database.custodyProofBackupAuthorities.get([scopeId, largest.proofs[0]!.proofId]),
    ).toBeDefined();
    expect(
      (await database.proofs.toArray()).some((proof) => proof.secret.startsWith("33".repeat(31))),
    ).toBe(true);
    expect(await database.custodyProofs.get([scopeId, small.proofs[0]!.proofId])).toBeDefined();
    expect(
      await database.custodyProofs.get([scopeId, protectedCandidate.proofs[0]!.proofId]),
    ).toBeDefined();
    expect(
      await database.encryptedWalletBackupV2DesiredAssets.get([scopeId, "largest"]),
    ).toBeDefined();
  });

  it("reads one full current head for a bounded 256-key batch and revalidates each call", async () => {
    let phaseStarted = performance.now();
    const completedPhase = (phase: string) => {
      const now = performance.now();
      process.stderr.write(
        `[owner-batch-fixture] ${phase} milliseconds=${Math.round(now - phaseStarted)}\n`,
      );
      phaseStarted = now;
    };
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    const victim = await ownerAuthorizedCandidate(database, "batch-owner", "38", 8);
    const store = await persistOwnerReceipt(database, victim);
    const context = {
      ownerScopeId: OWNER_SCOPE_ID,
      realm: victim.descriptor.realm,
      walletId: victim.descriptor.walletId,
      enrollmentEpoch: 1,
    };
    const candidates = [victim];
    for (let i = 0; i < 255; i += 1) {
      const mintUrl = `https://batch-mint-${i}.example`;
      const localAssetKey = encryptedWalletBackupV2LocalAssetKey(
        createEncryptedWalletBackupV2AssetIdentity({
          mintUrl,
          unit: "msat",
          asset: { kind: "ordinary" },
        }),
      );
      const candidate = {
        ...victim,
        desired: { ...victim.desired, mintUrl, localAssetKey },
        descriptor: {
          ...victim.descriptor,
          bundleId: (i + 1).toString(16).padStart(32, "0"),
          assetLocator: (i + 1).toString(16).padStart(64, "0"),
          objects: [{ objectId: (i + 1).toString(16).padStart(32, "0"), digest: "78".repeat(32) }],
        },
      };
      await database.encryptedWalletBackupV2DesiredAssets.put(candidate.desired);
      // The same real signed/verified receipt fixture is used for every distinct
      // asset; only installation of an intermediate single-bundle head is skipped.
      await persistOwnerReceipt(database, candidate, false);
      candidates.push(candidate);
    }
    completedPhase("256-signed-receipt-setup");
    const bundles = candidates
      .map((candidate) => candidate.descriptor)
      .sort((left, right) => left.bundleId.localeCompare(right.bundleId));
    const fullHead = createEncryptedWalletBackupOwnerCurrentHead({
      ...context,
      headVersion: 2,
      bundles,
    });
    await store.acceptCurrentHead({
      expectedHeadVersion: 1,
      evidence: collectEncryptedWalletBackupOwnerDescriptorPages(
        enumerateEncryptedWalletBackupOwnerDescriptorPages({ head: fullHead, bundles }),
        context,
      ),
    });
    completedPhase("install-256-descriptor-head");
    const keys = candidates.map((candidate) => candidate.desired.localAssetKey);
    const headReads = vi.spyOn(database.encryptedWalletBackupOwnerAcceptedHeads, "get");
    const descriptorReads = vi.spyOn(database.encryptedWalletBackupOwnerActiveDescriptors, "where");
    const originalGet = database.encryptedWalletBackupOwnerDesiredAssets.get.bind(
      database.encryptedWalletBackupOwnerDesiredAssets,
    );
    const ownerReads = vi.spyOn(database.encryptedWalletBackupOwnerDesiredAssets, "get");
    expect(
      await store.captureBackupReceipt({
        desired: {
          localAssetKey: "missing-single",
          assetLocator: victim.descriptor.assetLocator,
          custodyRevision: "1",
          desiredAction: "replace",
          activeProofCount: 1,
        },
      }),
    ).toBeNull();
    expect(headReads).not.toHaveBeenCalled();
    expect(descriptorReads).not.toHaveBeenCalled();
    const first = await store.captureBackupReceiptsForLocalAssets(keys);
    completedPhase("first-256-asset-capture");
    expect(first).toHaveLength(256);
    expect(first.map((snapshot) => snapshot.desired.localAssetKey)).toEqual(keys);
    expect(headReads).toHaveBeenCalledTimes(1);
    expect(descriptorReads).toHaveBeenCalledTimes(1);
    for (const key of keys) expect(ownerReads).toHaveBeenCalledWith([scopeId, OWNER_SCOPE_ID, key]);
    await database.encryptedWalletBackupV2DesiredAssets.update(
      [scopeId, victim.desired.localAssetKey],
      { custodyRevision: "2" },
    );
    const stale = await store.captureBackupReceiptsForLocalAssets(keys);
    completedPhase("stale-revision-capture-and-prior-assertions");
    expect(stale).toHaveLength(255);
    expect(
      stale.some((snapshot) => snapshot.desired.localAssetKey === victim.desired.localAssetKey),
    ).toBe(false);
    expect(headReads).toHaveBeenCalledTimes(2);
    expect(descriptorReads).toHaveBeenCalledTimes(2);
    await expect(store.captureBackupReceiptsForLocalAssets([...keys, "overflow"])).rejects.toThrow(
      "batch is invalid",
    );
    await expect(store.captureBackupReceiptsForLocalAssets([keys[0]!, keys[0]!])).rejects.toThrow(
      "batch is invalid",
    );
    expect(headReads).toHaveBeenCalledTimes(2);
    await database.encryptedWalletBackupV2DesiredAssets.update(
      [scopeId, victim.desired.localAssetKey],
      { custodyRevision: "1" },
    );
    const retainedBundles = bundles.filter(
      (bundle) => bundle.bundleId !== victim.descriptor.bundleId,
    );
    const nextHead = createEncryptedWalletBackupOwnerCurrentHead({
      ...context,
      headVersion: 3,
      bundles: retainedBundles,
    });
    await store.acceptCurrentHead({
      expectedHeadVersion: 2,
      evidence: collectEncryptedWalletBackupOwnerDescriptorPages(
        enumerateEncryptedWalletBackupOwnerDescriptorPages({
          head: nextHead,
          bundles: retainedBundles,
        }),
        context,
      ),
    });
    completedPhase("replace-head-and-boundary-assertions");
    const readsBeforeNewReport = headReads.mock.calls.length;
    const refreshed = await store.captureBackupReceiptsForLocalAssets(keys);
    completedPhase("fresh-head-capture");
    expect(refreshed).toHaveLength(255);
    expect(
      refreshed.some((snapshot) => snapshot.desired.localAssetKey === victim.desired.localAssetKey),
    ).toBe(false);
    expect(headReads).toHaveBeenCalledTimes(readsBeforeNewReport + 1);
    let current = true;
    const guarded = new EncryptedWalletBackupOwnerDexieAuthorityStore({
      database,
      scopeId,
      ownerScopeId: OWNER_SCOPE_ID,
      realm: victim.descriptor.realm,
      walletId: victim.descriptor.walletId,
      requestAuthPublicKey: victim.keyHandle.requestAuthPublicKey,
      enrollmentEpoch: 1,
      isCurrent: () => current,
    });
    ownerReads.mockImplementationOnce((...args: Parameters<typeof originalGet>) =>
      originalGet(...args).then((row) => {
        current = false;
        return row;
      }),
    );
    await expect(guarded.captureBackupReceiptsForLocalAssets(keys)).rejects.toThrow();
    completedPhase("owner-loss-refusal");
    // This stress fixture signs and verifies 256 real receipts, then performs
    // three full IndexedDB captures. The measured isolated case takes 6.5s.
  }, 30_000);

  it("composes real owner-only snapshots with locked local holdings and current-head refusal", async () => {
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    monitoring.scope = scopeId;
    const victim = await ownerAuthorizedCandidate(database, "snapshot-owner", "36", 6);
    const store = await persistOwnerReceipt(database, victim);
    await database.custodyProofs.bulkDelete(
      victim.proofs.map((proof) => [proof.scopeId, proof.proofId]),
    );
    await database.custodyProofBackupAuthorities.clear();
    await database.encryptedWalletBackupV2AssetReceipts.clear();
    await database.encryptedWalletBackupV2AcceptedHeads.clear();
    await database.encryptedWalletBackupV2ActiveDescriptors.clear();
    const pending = createBrowserCustodyProofRow({
      scopeId,
      normalizedMint: "https://other-mint.example",
      unit: "msat",
      proof: {
        id: KEYSET_ID,
        amount: Amount.from(3),
        secret: "pending-monitoring",
        C: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
      },
      asset: { kind: "regular" },
      receivedAtMs: 7,
    });
    await database.custodyProofs.put({
      ...pending,
      selectability: "locked",
      reservationOperationId: "pending-order",
    });
    let current = true;
    const driver = {
      captureSelectedOwnerMonitoringAuthority: async () => ({
        isCurrent: () => current,
        captureBackupReceiptsForLocalAssets: store.captureBackupReceiptsForLocalAssets.bind(store),
      }),
    } as unknown as BrowserEncryptedWalletBackupV2RuntimeDriver;
    const wake = vi.fn();
    const unsubscribeWake = subscribeToBrowserEncryptedBackupMonitoring(scopeId, wake);
    const unregister = registerBrowserEncryptedWalletBackupV2RuntimeDriver(scopeId, driver);
    const committed = vi.fn();
    const unsubscribeCommit = subscribeToCommittedProofChanges(database, committed);
    try {
      expect(wake).toHaveBeenCalledOnce();
      const snapshot = await readAssetMonitoringSnapshot(database, scopeId);
      expect(snapshot.evictedAssets).toEqual([
        { kind: "ordinary", mintUrl: victim.desired.mintUrl, unit: "msat", declaredAmount: 1 },
      ]);
      const holdings = await buildBrowserAssetMonitoringHoldings(database, scopeId, {
        engineBaseUrl: "https://engine.example",
        fetchImpl: fetch,
      });
      expect(holdings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            asset: expect.objectContaining({ canonicalMintUrl: victim.desired.mintUrl }),
            availableSubunits: 1,
            pendingOutgoingSubunits: 0,
          }),
          expect.objectContaining({
            asset: expect.objectContaining({ canonicalMintUrl: "https://other-mint.example" }),
            availableSubunits: 0,
            pendingOutgoingSubunits: 3,
          }),
        ]),
      );
      const context = {
        ownerScopeId: OWNER_SCOPE_ID,
        realm: victim.descriptor.realm,
        walletId: victim.descriptor.walletId,
        enrollmentEpoch: 1,
      };
      const head = createEncryptedWalletBackupOwnerCurrentHead({
        ...context,
        headVersion: 2,
        bundles: [],
      });
      await store.acceptCurrentHead({
        expectedHeadVersion: 1,
        evidence: collectEncryptedWalletBackupOwnerDescriptorPages(
          enumerateEncryptedWalletBackupOwnerDescriptorPages({ head, bundles: [] }),
          context,
        ),
      });
      expect(committed).toHaveBeenCalledOnce();
      expect((await readAssetMonitoringSnapshot(database, scopeId)).evictedAssets).toEqual([]);
      current = false;
      unregister();
      expect(wake).toHaveBeenCalledTimes(2);
      const withoutOwner = await buildBrowserAssetMonitoringHoldings(database, scopeId, {
        engineBaseUrl: "https://engine.example",
        fetchImpl: fetch,
      });
      expect(withoutOwner).toEqual([expect.objectContaining({ pendingOutgoingSubunits: 3 })]);
    } finally {
      unregister();
      unsubscribeWake();
      unsubscribeCommit();
    }
  });

  it("refuses a captured owner's report when the registered owner changes during catalogue work", async () => {
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    monitoring.scope = scopeId;
    const victim = await ownerAuthorizedCandidate(database, "switch-owner", "37", 7);
    const store = await persistOwnerReceipt(database, victim);
    await database.custodyProofs.bulkDelete(
      victim.proofs.map((proof) => [proof.scopeId, proof.proofId]),
    );
    const driver = {
      captureSelectedOwnerMonitoringAuthority: async () => ({
        isCurrent: () => true,
        captureBackupReceiptsForLocalAssets: store.captureBackupReceiptsForLocalAssets.bind(store),
      }),
    } as unknown as BrowserEncryptedWalletBackupV2RuntimeDriver;
    const unregister = registerBrowserEncryptedWalletBackupV2RuntimeDriver(scopeId, driver);
    let release!: () => void;
    let entered!: () => void;
    const called = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    monitoring.catalogue.mockImplementationOnce(async () => {
      entered();
      await held;
      return [];
    });
    let unregisterReplacement = () => {};
    try {
      const report = buildBrowserAssetMonitoringHoldings(database, scopeId, {
        engineBaseUrl: "https://engine.example",
        fetchImpl: fetch,
      });
      await called;
      unregisterReplacement = registerBrowserEncryptedWalletBackupV2RuntimeDriver(
        scopeId,
        {} as BrowserEncryptedWalletBackupV2RuntimeDriver,
      );
      release();
      expect(await report).toBeNull();
    } finally {
      release();
      unregisterReplacement();
      unregister();
    }
  });

  it("reports an owner-backed evicted holding without legacy authority and refuses stale or locally present assets", async () => {
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    const victim = await ownerAuthorizedCandidate(database, "monitoring-owner", "35", 5);
    const ownerAuthority = await persistOwnerReceipt(database, victim);
    await database.encryptedWalletBackupV2AssetReceipts.clear();
    await database.encryptedWalletBackupV2AcceptedHeads.clear();
    await database.encryptedWalletBackupV2ActiveDescriptors.clear();
    await database.encryptedWalletBackupV2DesiredAssets.update(
      [scopeId, victim.desired.localAssetKey],
      { syncState: "pending" },
    );
    const input = { database, scopeId, isCurrentProfile: () => true, ownerAuthority };
    expect(await listBrowserEncryptedWalletBackupOwnerEvictedAssetMonitoringFacts(input)).toEqual(
      [],
    );
    await database.custodyProofs.bulkDelete(
      victim.proofs.map((proof) => [proof.scopeId, proof.proofId]),
    );
    const facts = await database.transaction(
      "r",
      [
        database.custodyProofs,
        database.custodyConditionalKeysets,
        database.encryptedWalletBackupV2DesiredAssets,
        database.encryptedWalletBackupOwnerDesiredAssets,
        database.encryptedWalletBackupOwnerAssetReceipts,
        database.encryptedWalletBackupOwnerAcceptedHeads,
        database.encryptedWalletBackupOwnerActiveDescriptors,
      ],
      async () => await listBrowserEncryptedWalletBackupOwnerEvictedAssetMonitoringFacts(input),
    );
    expect(facts).toEqual([
      { kind: "ordinary", mintUrl: victim.desired.mintUrl, unit: "msat", declaredAmount: 1 },
    ]);
    const wrongOwner = new EncryptedWalletBackupOwnerDexieAuthorityStore({
      database,
      scopeId,
      ownerScopeId: "cd".repeat(32),
      realm: victim.descriptor.realm,
      walletId: victim.descriptor.walletId,
      requestAuthPublicKey: victim.keyHandle.requestAuthPublicKey,
      enrollmentEpoch: 1,
      isCurrent: () => true,
    });
    expect(
      await listBrowserEncryptedWalletBackupOwnerEvictedAssetMonitoringFacts({
        ...input,
        ownerAuthority: wrongOwner,
      }),
    ).toEqual([]);
    await expect(
      listBrowserEncryptedWalletBackupOwnerEvictedAssetMonitoringFacts({
        ...input,
        isCurrentProfile: () => false,
      }),
    ).rejects.toThrow();
    const savedReceipts = await database.encryptedWalletBackupOwnerAssetReceipts.toArray();
    await database.encryptedWalletBackupOwnerAssetReceipts.clear();
    expect(await listBrowserEncryptedWalletBackupOwnerEvictedAssetMonitoringFacts(input)).toEqual(
      [],
    );
    await database.encryptedWalletBackupOwnerAssetReceipts.bulkPut(savedReceipts);
    await database.encryptedWalletBackupV2DesiredAssets.update(
      [scopeId, victim.desired.localAssetKey],
      { custodyRevision: "2" },
    );
    expect(await listBrowserEncryptedWalletBackupOwnerEvictedAssetMonitoringFacts(input)).toEqual(
      [],
    );
  });

  it("evicts only after the selected owner's fresh collected head matches the exact candidate", async () => {
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    const victim = await ownerAuthorizedCandidate(database, "fresh-head", "34", 4);
    const ownerAuthorityStore = await persistOwnerReceipt(database, victim);
    const candidates = await listBrowserEncryptedWalletBackupOwnerCacheRemovalEligibleAssets({
      database,
      scopeId,
      isCurrentProfile: () => true,
      ownerAuthorityStore,
    });
    expect(candidates.map(({ desired }) => desired.localAssetKey)).toEqual([
      victim.desired.localAssetKey,
    ]);
    const loadCurrentOwnerReachabilityEvidence = vi.fn(async () => {
      const reachability = await ownerReachabilitySnapshot({
        ownerScopeId: OWNER_SCOPE_ID,
        descriptor: victim.descriptor,
        enrollmentEpoch: 1,
      });
      return withReceiptSnapshot(
        victim,
        reachability,
        await ownerAuthorityStore.captureBackupReceiptForLocalAsset(victim.desired.localAssetKey),
      );
    });
    const write = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(quotaError())
      .mockResolvedValueOnce("written");

    const outcome = await retryBrowserEncryptedWalletBackupV2QuotaWrite({
      database,
      scopeId,
      ownerScopeId: OWNER_SCOPE_ID,
      ownerAuthorityStore,
      loadCurrentOwnerReachabilityEvidence,
      isCurrentProfile: () => true,
      write,
      lockManager: immediateLockManager(),
    }).then(
      (value) => value,
      (error: unknown) => error,
    );
    expect(loadCurrentOwnerReachabilityEvidence).toHaveBeenCalledOnce();
    expect(await database.encryptedWalletBackupOwnerAssetReceipts.count()).toBe(1);
    expect(outcome).toMatchObject({
      result: "written",
      evictedLocalAssetKey: victim.desired.localAssetKey,
    });
    expect(await database.custodyProofs.get([scopeId, victim.proofs[0]!.proofId])).toBeUndefined();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("refuses quota eviction when the captured profile becomes stale during head fetch", async () => {
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    const victim = await ownerAuthorizedCandidate(database, "stale-head", "45", 5);
    const ownerAuthorityStore = await persistOwnerReceipt(database, victim);
    let currentProfile = true;
    const write = vi.fn().mockRejectedValueOnce(quotaError());

    await expect(
      retryBrowserEncryptedWalletBackupV2QuotaWrite({
        database,
        scopeId,
        ownerScopeId: OWNER_SCOPE_ID,
        ownerAuthorityStore,
        loadCurrentOwnerReachabilityEvidence: async () => {
          const snapshot = await ownerReachabilitySnapshot({
            ownerScopeId: OWNER_SCOPE_ID,
            descriptor: victim.descriptor,
            enrollmentEpoch: 1,
          });
          currentProfile = false;
          return withReceiptSnapshot(
            victim,
            snapshot,
            await ownerAuthorityStore.captureBackupReceiptForLocalAsset(
              victim.desired.localAssetKey,
            ),
          );
        },
        isCurrentProfile: () => currentProfile,
        write,
        lockManager: immediateLockManager(),
      }),
    ).rejects.toThrow(/profile is stale/);
    expect(write).toHaveBeenCalledOnce();
    expect(await database.custodyProofs.get([scopeId, victim.proofs[0]!.proofId])).toBeDefined();
  });

  it("refuses owner evidence whose collected head omits the exact local descriptor", async () => {
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    const victim = await ownerAuthorizedCandidate(database, "wrong-head", "46", 6);
    const ownerAuthorityStore = await persistOwnerReceipt(database, victim);
    const otherDescriptor = {
      ...victim.descriptor,
      assetLocator: "89".repeat(32),
    };
    const write = vi.fn().mockRejectedValueOnce(quotaError());

    await expect(
      retryBrowserEncryptedWalletBackupV2QuotaWrite({
        database,
        scopeId,
        ownerScopeId: OWNER_SCOPE_ID,
        ownerAuthorityStore,
        loadCurrentOwnerReachabilityEvidence: async () =>
          withReceiptSnapshot(
            victim,
            await ownerReachabilitySnapshot({
              ownerScopeId: OWNER_SCOPE_ID,
              descriptor: otherDescriptor,
              enrollmentEpoch: 1,
              keyHandle: undefined,
            }),
            await ownerAuthorityStore.captureBackupReceiptForLocalAsset(
              victim.desired.localAssetKey,
            ),
          ),
        isCurrentProfile: () => true,
        write,
        lockManager: immediateLockManager(),
      }),
    ).rejects.toThrow(/quota/);
    expect(write).toHaveBeenCalledOnce();
    expect(await database.custodyProofs.get([scopeId, victim.proofs[0]!.proofId])).toBeDefined();
  });

  it("rechecks the descriptor inside the delete transaction after async owner collection", async () => {
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    const victim = await ownerAuthorizedCandidate(database, "changed-local", "47", 7);
    const ownerAuthorityStore = await persistOwnerReceipt(database, victim);
    const candidates = await listBrowserEncryptedWalletBackupOwnerCacheRemovalEligibleAssets({
      database,
      scopeId,
      isCurrentProfile: () => true,
      ownerAuthorityStore,
    });
    expect(candidates).toHaveLength(1);
    const write = vi.fn().mockRejectedValueOnce(quotaError());

    await expect(
      retryBrowserEncryptedWalletBackupV2QuotaWrite({
        database,
        scopeId,
        ownerScopeId: OWNER_SCOPE_ID,
        ownerAuthorityStore,
        loadCurrentOwnerReachabilityEvidence: async () => {
          const snapshot = await ownerReachabilitySnapshot({
            ownerScopeId: OWNER_SCOPE_ID,
            descriptor: victim.descriptor,
            enrollmentEpoch: 1,
          });
          const receiptSnapshot = await ownerAuthorityStore.captureBackupReceiptForLocalAsset(
            victim.desired.localAssetKey,
          );
          await database!.encryptedWalletBackupV2DesiredAssets.put({
            ...(await database!.encryptedWalletBackupV2DesiredAssets.get([
              scopeId,
              victim.desired.localAssetKey,
            ]))!,
            custodyRevision: "2",
          });
          return withReceiptSnapshot(victim, snapshot, receiptSnapshot);
        },
        isCurrentProfile: () => true,
        write,
        lockManager: immediateLockManager(),
      }),
    ).rejects.toThrow(/owner deletion authority changed/);
    expect(write).toHaveBeenCalledOnce();
    expect(await database.custodyProofs.get([scopeId, victim.proofs[0]!.proofId])).toBeDefined();
    expect(
      await database.custodyProofBackupAuthorities.get([scopeId, victim.proofs[0]!.proofId]),
    ).toBeDefined();
    expect(
      (await database.proofs.toArray()).some((proof) => proof.secret.includes("47".repeat(20))),
    ).toBe(true);
  });

  it("preserves completed-removal markers and proofs when only legacy V2 evidence exists", async () => {
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    const victim = await candidate(database, "victim", "66", 6);
    const marker = completedRemovalMarker();
    await database.custodyProofBackupAuthorities.put(marker);
    eligible.mockResolvedValue([victim]);

    await expect(
      retryBrowserEncryptedWalletBackupV2QuotaWrite({
        database,
        scopeId,
        isCurrentProfile: () => true,
        write: vi.fn().mockRejectedValueOnce(quotaError()).mockResolvedValueOnce("written"),
        lockManager: immediateLockManager(),
      }),
    ).rejects.toThrow(/quota/);
    expect(await database.custodyProofBackupAuthorities.get([scopeId, marker.proofId])).toEqual(
      marker,
    );
    expect(await database.custodyProofs.get([scopeId, victim.proofs[0]!.proofId])).toBeDefined();
  });

  it("fails stale profiles before cache deletion", async () => {
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    const victim = await candidate(database, "victim", "44", 4);
    eligible.mockResolvedValue([victim]);
    const quota = quotaError();

    await expect(
      retryBrowserEncryptedWalletBackupV2QuotaWrite({
        database,
        scopeId,
        isCurrentProfile: () => false,
        write: async () => {
          throw quota;
        },
        lockManager: immediateLockManager(),
      }),
    ).rejects.toThrow(/profile is stale/);
    expect(await database.custodyProofs.get([scopeId, victim.proofs[0]!.proofId])).toBeDefined();
  });

  it("does not retry a quota write when legacy evidence cannot authorize eviction", async () => {
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    const victim = await candidate(database, "victim", "55", 5);
    eligible.mockResolvedValue([victim]);
    const first = quotaError();
    const second = quotaError();
    const write = vi.fn().mockRejectedValueOnce(first).mockRejectedValueOnce(second);

    await expect(
      retryBrowserEncryptedWalletBackupV2QuotaWrite({
        database,
        scopeId,
        isCurrentProfile: () => true,
        write,
        lockManager: immediateLockManager(),
      }),
    ).rejects.toThrow(/quota/);
    expect(eligible).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("keeps terminal reimport operation and artifact counts bounded across eviction cycles", async () => {
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    const verified = await verifiedProof();
    const asset = createEncryptedWalletBackupV2AssetIdentity({
      mintUrl: "https://mint.example",
      unit: "msat",
      asset: { kind: "ordinary" },
    });
    const input = {
      seed: SEED,
      verified,
      asset,
      custodyRevision: 1n,
      sourceOperationId: "backup-v2-restore:bundle",
      wallet: restoreWallet(),
      database,
      scopeId,
      isCurrentProfile: () => true,
      lockManager: immediateLockManager(),
    };
    await admitBrowserEncryptedWalletBackupV2Asset(input);
    await database.custodyProofs.clear();
    await database.custodyProofBackupAuthorities.clear();
    await database.proofs.clear();
    await database.custodyOperations.bulkPut(
      Array.from({ length: 513 }, (_, index) => ({
        scopeId,
        operationId: `unrelated-${index}`,
        revision: 0,
        operationState: "reconciled" as const,
        nextAttemptAtMs: null,
        estimatedBytes: 0,
        record: {},
      })) as unknown as Parameters<typeof database.custodyOperations.bulkPut>[0],
    );
    const retainedOperationCount = await database.custodyOperations.count();
    const retainedArtifactCount = await database.custodyArtifacts.count();

    for (const cycle of ["one", "two", "three"]) {
      await admitBrowserEncryptedWalletBackupV2Asset({ ...input, randomId: () => cycle });
      const desired = (await database.encryptedWalletBackupV2DesiredAssets.toArray())[0]!;
      eligible.mockResolvedValue([
        {
          desired,
          proofs: await database.custodyProofs.toArray(),
        } as unknown as BrowserEncryptedWalletBackupV2CacheRemovalEligibleAsset,
      ]);
      await expect(
        retryBrowserEncryptedWalletBackupV2QuotaWrite({
          database,
          scopeId,
          isCurrentProfile: () => true,
          lockManager: immediateLockManager(),
          write: vi.fn().mockRejectedValueOnce(quotaError()).mockResolvedValueOnce("written"),
        }),
      ).rejects.toThrow(/quota/);
      expect(await database.custodyOperations.count()).toBe(retainedOperationCount);
      expect(await database.custodyArtifacts.count()).toBe(retainedArtifactCount);
    }
  });
});

async function verifiedProof() {
  const locator = {
    schemaVersion: 1 as const,
    kind: "nut13" as const,
    keysetId: KEYSET_ID,
    counter: 0,
  };
  const proof = {
    id: KEYSET_ID,
    amount: Amount.from(1),
    secret: deriveDurableWalletProofSecret({
      seed: SEED,
      locator,
      proofKeysetId: KEYSET_ID,
      proofAmount: 1,
    }),
    C: `02${"33".repeat(32)}`,
  };
  return verifyEncryptedWalletBackupV2RestoredProofSet({
    seed: SEED,
    expectedAsset: createEncryptedWalletBackupV2AssetIdentity({
      mintUrl: "https://mint.example",
      unit: "msat",
      asset: { kind: "ordinary" },
    }),
    unverified: {
      proofs: [
        {
          mintUrl: "https://mint.example",
          unit: "msat",
          asset: { kind: "ordinary" },
          proof,
          locator,
          proofId: "11".repeat(32),
        },
      ],
      counterHighWaterMarks: [
        { mintUrl: "https://mint.example", unit: "msat", keysetId: KEYSET_ID, nextCounter: 1 },
      ],
    },
    port: {
      async resolveKeyset({ mintUrl, unit, keysetId }) {
        return { mintUrl, unit, keysetId, keyset: {}, requireDleq: true, verify: () => true };
      },
      verifyProofs: () => undefined,
      checkProofStates: async ({ proofs }) =>
        proofs.map(({ proofId }) => ({ proofId, state: "UNSPENT" })),
    },
  });
}

function restoreWallet(): CashuWallet {
  const keyset = new Keyset(KEYSET_ID, "msat", true, 0);
  keyset.keys = { 1: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" };
  return {
    mint: { mintUrl: "https://mint.example" },
    getKeyset: () => keyset,
  } as unknown as CashuWallet;
}

async function candidate(
  database: BitcasterDB,
  localAssetKey: string,
  secretPart: string,
  receivedAtMs: number,
  proofCount = 1,
  ownerListCompatible = false,
): Promise<BrowserEncryptedWalletBackupV2CacheRemovalEligibleAsset> {
  const proofs = await Promise.all(
    Array.from({ length: proofCount }, async (_, index) => {
      const secret = `${secretPart.repeat(31)}${index.toString(16).padStart(2, "0")}`;
      const proof = createBrowserCustodyProofRow({
        scopeId,
        normalizedMint: "https://mint.example",
        unit: "msat",
        proof: {
          id: "01" + "22".repeat(32),
          amount: Amount.from(1),
          secret,
          C: "02" + "33".repeat(32),
        },
        asset: { kind: "regular" },
        receivedAtMs,
      });
      await database.custodyProofs.put(proof);
      await database.custodyProofBackupAuthorities.put({
        schemaVersion: 4,
        scopeId,
        proofId: proof.proofId,
        proofFingerprint: proof.proofFingerprint,
        proofRevision: 0,
        proofState: "selectable",
        terminalOperationId: null,
        terminalAuthority: null,
        recordCreatedAtUnixSeconds: 1,
        recordUpdatedAtUnixSeconds: 1,
        derivationLocator: null,
        updatedAtMs: 1,
        admissionOperationId: null,
        backupState: "remote-backed",
        backupRecordId: proof.proofId,
        backupRecordCommitment: "aa".repeat(32),
      });
      await database.proofs.put({
        id: proof.keysetId,
        amount: 1,
        secret,
        C: "02" + "33".repeat(32),
        mintUrl: "https://mint.example",
      });
      return proof;
    }),
  );
  const canonicalLocalAssetKey = ownerListCompatible
    ? encryptedWalletBackupV2LocalAssetKey(
        createEncryptedWalletBackupV2AssetIdentity({
          mintUrl: "https://mint.example",
          unit: "msat",
          asset: { kind: "ordinary" },
        }),
      )
    : localAssetKey;
  await database.encryptedWalletBackupV2DesiredAssets.put({
    scopeId,
    localAssetKey: canonicalLocalAssetKey,
    mintUrl: "https://mint.example",
    unit: "msat",
    assetIdentity: ownerListCompatible ? "cashu:ordinary" : "ordinary",
    custodyRevision: "1",
    activeProofCount: proofs.length,
    desiredAction: "replace",
    syncState: "acknowledged",
    terminalCtfContext: null,
    removalIntent: null,
  });
  return {
    desired: { localAssetKey: canonicalLocalAssetKey },
    proofs,
  } as unknown as BrowserEncryptedWalletBackupV2CacheRemovalEligibleAsset;
}

async function ownerAuthorizedCandidate(
  database: BitcasterDB,
  localAssetKey: string,
  secretPart: string,
  receivedAtMs: number,
) {
  const base = await candidate(database, localAssetKey, secretPart, receivedAtMs, 1, true);
  const keyHandle = await import("@bitcaster/client-sdk/encryptedWalletBackupV2Keys").then(
    ({ createEncryptedWalletBackupV2KeyHandle }) =>
      createEncryptedWalletBackupV2KeyHandle({
        seed: new Uint8Array(64).fill(0x17),
        realm: "backup.example",
        runtime: crypto,
      }),
  );
  const desired = (await database.encryptedWalletBackupV2DesiredAssets.get([
    scopeId,
    base.desired.localAssetKey,
  ]))!;
  const descriptor = {
    formatVersion: 2 as const,
    realm: "backup.example",
    walletId: keyHandle.walletId,
    bundleId: `${receivedAtMs.toString(16).padStart(2, "0")}`.repeat(16),
    assetLocator: `${(receivedAtMs + 32).toString(16).padStart(2, "0")}`.repeat(32),
    declaredAmount: 1n,
    custodyRevision: 1n,
    payloadCommitment: "56".repeat(32),
    objects: [{ objectId: "67".repeat(16), digest: "78".repeat(32) }],
  };
  return {
    ...base,
    desired,
    descriptor,
    keyHandle,
  };
}

async function persistOwnerReceipt(
  database: BitcasterDB,
  candidate: Awaited<ReturnType<typeof ownerAuthorizedCandidate>>,
  installHead = true,
): Promise<EncryptedWalletBackupOwnerDexieAuthorityStore> {
  const { descriptor, keyHandle, desired } = candidate;
  const store = new EncryptedWalletBackupOwnerDexieAuthorityStore({
    database,
    scopeId,
    ownerScopeId: OWNER_SCOPE_ID,
    realm: descriptor.realm,
    walletId: descriptor.walletId,
    requestAuthPublicKey: keyHandle.requestAuthPublicKey,
    enrollmentEpoch: 1,
    isCurrent: () => true,
  });
  const context = {
    ownerScopeId: OWNER_SCOPE_ID,
    realm: descriptor.realm,
    walletId: descriptor.walletId,
    enrollmentEpoch: 1,
  };
  const emptyHead = createEncryptedWalletBackupOwnerCurrentHead({
    ...context,
    headVersion: 0,
    bundles: [],
  });
  const emptyEvidence = collectEncryptedWalletBackupOwnerDescriptorPages(
    enumerateEncryptedWalletBackupOwnerDescriptorPages({ head: emptyHead, bundles: [] }),
    context,
  );
  if (installHead)
    await store.acceptCurrentHead({ expectedHeadVersion: null, evidence: emptyEvidence });
  const ownerReceipt = await ownerReachabilitySnapshot({
    ownerScopeId: OWNER_SCOPE_ID,
    descriptor,
    enrollmentEpoch: 1,
    keyHandle,
  });
  if (installHead)
    await store.acceptCurrentHead({
      expectedHeadVersion: 0,
      evidence: ownerReceipt.collectedHeadEvidence,
    });
  const receipt = ownerReceipt.receipt;
  await database.encryptedWalletBackupOwnerAssetReceipts.put({
    scopeId,
    ownerScopeId: OWNER_SCOPE_ID,
    realm: descriptor.realm,
    walletId: descriptor.walletId,
    enrollmentEpoch: 1,
    localAssetKey: desired.localAssetKey,
    assetLocator: descriptor.assetLocator,
    custodyRevision: descriptor.custodyRevision.toString(),
    bundleId: descriptor.bundleId,
    bundleDescriptorDigest: digestEncryptedWalletBackupV2BundleDescriptor(descriptor),
    canonicalSignedMutation: ownerReceipt.canonicalSignedMutation,
    canonicalSignedReceipt: ownerReceipt.canonicalSignedReceipt,
  });
  await database.encryptedWalletBackupOwnerDesiredAssets.put({
    scopeId,
    ownerScopeId: OWNER_SCOPE_ID,
    realm: descriptor.realm,
    walletId: descriptor.walletId,
    enrollmentEpoch: 1,
    localAssetKey: desired.localAssetKey,
    assetLocator: descriptor.assetLocator,
    custodyRevision: descriptor.custodyRevision.toString(),
    desiredAction: "replace",
    activeProofCount: 1,
    syncState: "acknowledged",
    lastObservedHeadVersion: ownerReceipt.collectedHeadEvidence.head.headVersion,
    receiptDigest: digestEncryptedWalletBackupOwnerBundleSupersessionReceipt(receipt),
  });
  return store;
}

function withReceiptSnapshot(
  _candidate: Awaited<ReturnType<typeof ownerAuthorizedCandidate>>,
  reachability: Awaited<ReturnType<typeof ownerReachabilitySnapshot>>,
  snapshot: Awaited<
    ReturnType<EncryptedWalletBackupOwnerDexieAuthorityStore["captureBackupReceiptForLocalAsset"]>
  >,
) {
  if (snapshot === null) throw new Error("owner receipt fixture is absent");
  return {
    ...reachability,
    backupReceiptSnapshot: snapshot,
  };
}

function quotaError(): Error {
  return Object.assign(new Error("quota"), { name: "QuotaExceededError" });
}

function completedRemovalMarker() {
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: "https://mint.example",
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
  return createBrowserCompletedProofRemovalMarkerRow({
    scopeId,
    proofId: "ff".repeat(32),
    proofFingerprint: "ee".repeat(32),
    proofRevision: 0,
    proofCommitment: "dd".repeat(32),
    localAssetKey: encryptedWalletBackupV2LocalAssetKey(asset),
    removalIntentId: "quota-cleanup-marker",
    proofSetCommitment: "cc".repeat(32),
    completionCustodyRevision: "1",
    realm: "development",
    walletId: browserWalletScope(SEED).walletId,
    enrollmentEpoch: 1,
    acknowledgedHeadVersion: 0,
    acknowledgedActiveSetDigest: "ab".repeat(32),
    acknowledgementKind: "current-head",
    receiptDigest: null,
    acknowledgedAtMs: 1,
    completedAtMs: 2,
  });
}

function immediateLockManager(): Pick<LockManager, "request"> {
  return {
    request: async <T>(
      name: string,
      optionsOrCallback: LockOptions | LockGrantedCallback<T>,
      callback?: LockGrantedCallback<T>,
    ) => {
      const invoke = typeof optionsOrCallback === "function" ? optionsOrCallback : callback!;
      const mode = typeof optionsOrCallback === "function" ? "exclusive" : optionsOrCallback.mode;
      return invoke({ name, mode } as Lock);
    },
  };
}
