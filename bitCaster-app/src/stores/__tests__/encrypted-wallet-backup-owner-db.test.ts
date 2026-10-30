// @vitest-environment node
import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEncryptedWalletBackupOwnerCurrentHead,
  enumerateEncryptedWalletBackupOwnerDescriptorPages,
  collectEncryptedWalletBackupOwnerDescriptorPages,
} from "@bitcaster/client-sdk/encryptedWalletBackupOwnerHead";
import { createEncryptedWalletBackupV2KeyHandle } from "@bitcaster/client-sdk/encryptedWalletBackupV2Keys";
import { prepareEncryptedWalletBackupV2TransportBundle } from "@bitcaster/client-sdk/encryptedWalletBackupV2Bundle";
import { prepareEncryptedWalletBackupOwnerBundleSupersessionMutation } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerMutation";
import {
  decodeEncryptedWalletBackupOwnerUploadGroup,
  encodeEncryptedWalletBackupOwnerUploadGroup,
} from "@bitcaster/client-sdk/encryptedWalletBackupOwnerUpload";
import {
  issueEncryptedWalletBackupOwnerBundleSupersessionReceipt,
  verifyEncryptedWalletBackupOwnerBundleSupersessionReceipt,
} from "@bitcaster/client-sdk/encryptedWalletBackupOwnerReceipt";
import { deriveEncryptedWalletBackupOwnerScope } from "@bitcaster/client-sdk/encryptedWalletBackupEnrollment";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import { createEncryptedWalletBackupV2DesiredAssetRow } from "../browser-encrypted-wallet-backup-v2-desired-asset";
import { browserWalletDatabaseName } from "@/lib/browserWalletProfile";
import { BitcasterDB } from "../proof-db";
import { EncryptedWalletBackupOwnerDexieAuthorityStore } from "../encrypted-wallet-backup-owner-db";
import { EncryptedWalletBackupOwnerClient } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerClient";
import { webcrypto } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";

const realm = "mainnet";
const walletId = "22".repeat(32);
const requestAuthPublicKey = "33".repeat(32);
const ownerA = deriveEncryptedWalletBackupOwnerScope({
  authorizationScheme: "test",
  ownerSubject: "owner-a",
});
const ownerB = deriveEncryptedWalletBackupOwnerScope({
  authorizationScheme: "test",
  ownerSubject: "owner-b",
});
const scopeId = deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId });
let database: BitcasterDB | undefined;
const extraDatabaseNames: string[] = [];

afterEach(async () => {
  database?.close();
  database = undefined;
  await Dexie.delete(browserWalletDatabaseName(scopeId));
  await Promise.all(extraDatabaseNames.splice(0).map((name) => Dexie.delete(name)));
});

describe("owner-qualified backup authority storage", () => {
  it("requires recovery for a nonempty first head and keeps that owner read-only", async () => {
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    await database.open();
    const runtime = {
      subtle: webcrypto.subtle as unknown as Pick<
        SubtleCrypto,
        "deriveBits" | "importKey" | "encrypt" | "decrypt"
      >,
      getRandomValues(target: Uint8Array) {
        return target.fill(7);
      },
    };
    const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
      seed: Uint8Array.from({ length: 64 }, (_, index) => index + 1),
      realm,
      runtime,
    });
    const selectedScopeId = deriveDurableCustodyScopeId({
      scopeKind: "wallet",
      walletId: keyHandle.walletId,
    });
    const selectedDatabase = new BitcasterDB(browserWalletDatabaseName(selectedScopeId));
    extraDatabaseNames.push(selectedDatabase.name);
    await selectedDatabase.open();
    const store = new EncryptedWalletBackupOwnerDexieAuthorityStore({
      database: selectedDatabase,
      scopeId: selectedScopeId,
      ownerScopeId: ownerA.ownerScopeId,
      realm,
      walletId: keyHandle.walletId,
      requestAuthPublicKey: keyHandle.requestAuthPublicKey,
      enrollmentEpoch: 1,
      isCurrent: () => true,
    });
    const bundle = await prepareEncryptedWalletBackupV2TransportBundle({
      keyHandle,
      asset: {
        mintUrl: "https://mint.example",
        unit: "sat",
        assetIdentity: "cashu:first-head",
      },
      declaredAmount: 1n,
      custodyRevision: 1n,
      canonicalPayload: Uint8Array.of(1),
      runtime,
    });
    const head = createEncryptedWalletBackupOwnerCurrentHead({
      ownerScopeId: ownerA.ownerScopeId,
      realm,
      walletId: keyHandle.walletId,
      enrollmentEpoch: 1,
      headVersion: 1,
      bundles: [bundle.descriptor],
    });
    const evidence = collectEncryptedWalletBackupOwnerDescriptorPages(
      enumerateEncryptedWalletBackupOwnerDescriptorPages({
        head,
        bundles: [bundle.descriptor],
      }),
      {
        ownerScopeId: ownerA.ownerScopeId,
        realm,
        walletId: keyHandle.walletId,
        enrollmentEpoch: 1,
      },
    );

    await expect(store.acceptCurrentHead({ expectedHeadVersion: null, evidence })).rejects.toThrow(
      "nonempty encrypted backup owner head requires conflict recovery",
    );
    const status = await store.markCompetingHeadRecoveryRequired({ evidence });
    expect(status.localRecoveryStatus).toBe("recovery-required");
    expect((await store.readNewWritePermission()).canWrite).toBe(false);
    expect(await store.readCurrentHead()).toMatchObject({ head: { headVersion: 1 } });
  });

  it("isolates equal wallet contexts by selected owner and accepts only monotonic verified heads", async () => {
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    await database.open();
    const storeA = new EncryptedWalletBackupOwnerDexieAuthorityStore({
      database,
      scopeId,
      ownerScopeId: ownerA.ownerScopeId,
      realm,
      walletId,
      requestAuthPublicKey,
      enrollmentEpoch: 1,
      isCurrent: () => true,
    });
    const storeB = new EncryptedWalletBackupOwnerDexieAuthorityStore({
      database,
      scopeId,
      ownerScopeId: ownerB.ownerScopeId,
      realm,
      walletId,
      requestAuthPublicKey,
      enrollmentEpoch: 1,
      isCurrent: () => true,
    });
    const initial = evidence(ownerA.ownerScopeId, 0);
    expect(await storeA.acceptCurrentHead({ expectedHeadVersion: null, evidence: initial })).toBe(
      "accepted",
    );
    expect(await storeA.readCurrentHead()).toMatchObject({ head: { headVersion: 0 } });
    expect(await storeB.readCurrentHead()).toBeNull();

    const advanced = evidence(ownerA.ownerScopeId, 1);
    expect(await storeA.acceptCurrentHead({ expectedHeadVersion: 0, evidence: advanced })).toBe(
      "accepted",
    );
    expect(await storeA.acceptCurrentHead({ expectedHeadVersion: null, evidence: initial })).toBe(
      "stale",
    );
    await expect(
      storeA.acceptCurrentHead({ expectedHeadVersion: 1, evidence: initial }),
    ).rejects.toThrow("head version regressed");
    expect(await storeA.acceptCurrentHead({ expectedHeadVersion: 1, evidence: advanced })).toBe(
      "accepted",
    );
    await expect(
      storeB.acceptCurrentHead({ expectedHeadVersion: null, evidence: initial }),
    ).rejects.toThrow();
  });

  it("rolls back the accepted head if descriptor replacement fails in the transaction", async () => {
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    await database.open();
    const store = new EncryptedWalletBackupOwnerDexieAuthorityStore({
      database,
      scopeId,
      ownerScopeId: ownerA.ownerScopeId,
      realm,
      walletId,
      requestAuthPublicKey,
      enrollmentEpoch: 1,
      isCurrent: () => true,
    });
    const table = database.encryptedWalletBackupOwnerActiveDescriptors;
    vi.spyOn(table, "bulkDelete").mockRejectedValue(
      new Error("injected descriptor replacement failure"),
    );
    await expect(
      store.acceptCurrentHead({
        expectedHeadVersion: null,
        evidence: evidence(ownerA.ownerScopeId, 0),
      }),
    ).rejects.toThrow("injected descriptor replacement failure");
    vi.restoreAllMocks();
    expect(await database.encryptedWalletBackupOwnerAcceptedHeads.count()).toBe(0);
    expect(await database.encryptedWalletBackupOwnerActiveDescriptors.count()).toBe(0);
  });

  it("rechecks local rows inside the same owner recovery acceptance transaction", async () => {
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    await database.open();
    const store = new EncryptedWalletBackupOwnerDexieAuthorityStore({
      database,
      scopeId,
      ownerScopeId: ownerA.ownerScopeId,
      realm,
      walletId,
      requestAuthPublicKey,
      enrollmentEpoch: 1,
      isCurrent: () => true,
    });
    const accepted = evidence(ownerA.ownerScopeId, 0);
    const competing = evidence(ownerA.ownerScopeId, 1);
    expect(await store.acceptCurrentHead({ expectedHeadVersion: null, evidence: accepted })).toBe(
      "accepted",
    );
    await store.markCompetingHeadRecoveryRequired({ evidence: competing });
    expect(
      await store.stageRecoveryHead({
        expectedHeadVersion: 0,
        expectedRecoveryVersion: 1,
        evidence: competing,
      }),
    ).toBe("staged");

    let localRowsRead = false;
    expect(
      await store.acceptRecoveredHead({
        expectedHeadVersion: 1,
        expectedRecoveryVersion: 1,
        evidence: competing,
        recheckLocalState: async () => {
          // These reads must remain in acceptRecoveredHead's physical Dexie transaction.
          await database!.custodyProofs.count();
          await database!.custodyProofBackupAuthorities.count();
          await database!.encryptedWalletBackupV2DesiredAssets.count();
          await database!.encryptedWalletBackupOwnerDesiredAssets.count();
          localRowsRead = true;
          return true;
        },
      }),
    ).toBe("accepted");
    expect(localRowsRead).toBe(true);
    expect(await store.readNewWritePermission()).toMatchObject({
      canWrite: true,
      localRecoveryStatus: "ready",
      localRecoveryVersion: 2,
    });
  });

  it("rejects different owner-head content at the same version during recovery staging", async () => {
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    await database.open();
    const runtime = {
      subtle: webcrypto.subtle as unknown as Pick<
        SubtleCrypto,
        "deriveBits" | "importKey" | "encrypt" | "decrypt"
      >,
      getRandomValues(target: Uint8Array) {
        return target.fill(9);
      },
    };
    const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
      seed: new Uint8Array(64).fill(12),
      realm,
      runtime,
    });
    const selectedScopeId = deriveDurableCustodyScopeId({
      scopeKind: "wallet",
      walletId: keyHandle.walletId,
    });
    const selectedDatabase = new BitcasterDB(browserWalletDatabaseName(selectedScopeId));
    extraDatabaseNames.push(selectedDatabase.name);
    await selectedDatabase.open();
    const context = {
      ownerScopeId: ownerA.ownerScopeId,
      realm,
      walletId: keyHandle.walletId,
      enrollmentEpoch: 1,
    };
    const store = new EncryptedWalletBackupOwnerDexieAuthorityStore({
      database: selectedDatabase,
      scopeId: selectedScopeId,
      ...context,
      requestAuthPublicKey: keyHandle.requestAuthPublicKey,
      isCurrent: () => true,
    });
    const competingBundle = await prepareEncryptedWalletBackupV2TransportBundle({
      keyHandle,
      asset: {
        mintUrl: "https://mint.example",
        unit: "sat",
        assetIdentity: "cashu:same-version-conflict",
      },
      declaredAmount: 1n,
      custodyRevision: 1n,
      canonicalPayload: Uint8Array.of(8),
      runtime,
    });
    const collect = (
      headVersion: number,
      bundles: readonly (typeof competingBundle.descriptor)[] = [],
    ) => {
      const head = createEncryptedWalletBackupOwnerCurrentHead({
        ...context,
        headVersion,
        bundles,
      });
      return collectEncryptedWalletBackupOwnerDescriptorPages(
        enumerateEncryptedWalletBackupOwnerDescriptorPages({ head, bundles }),
        context,
      );
    };
    const accepted = collect(1);
    const conflictingSameVersion = collect(1, [competingBundle.descriptor]);
    await store.acceptCurrentHead({ expectedHeadVersion: null, evidence: accepted });
    await store.markCompetingHeadRecoveryRequired({ evidence: conflictingSameVersion });

    await expect(
      store.stageRecoveryHead({
        expectedHeadVersion: 1,
        expectedRecoveryVersion: 1,
        evidence: conflictingSameVersion,
      }),
    ).rejects.toThrow("encrypted backup owner recovery head version conflicts");
    await expect(store.readCurrentHead()).resolves.toMatchObject({
      head: { headVersion: 1, activeBundleCount: 0 },
      bundles: [],
    });
    await expect(store.readNewWritePermission()).resolves.toMatchObject({
      canWrite: false,
      localRecoveryStatus: "recovery-required",
      localRecoveryVersion: 1,
    });
  });

  it("rechecks submitted owner work after local recovery validation", async () => {
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    await database.open();
    const store = new EncryptedWalletBackupOwnerDexieAuthorityStore({
      database,
      scopeId,
      ownerScopeId: ownerA.ownerScopeId,
      realm,
      walletId,
      requestAuthPublicKey,
      enrollmentEpoch: 1,
      isCurrent: () => true,
    });
    const accepted = evidence(ownerA.ownerScopeId, 0);
    const competing = evidence(ownerA.ownerScopeId, 1);
    await store.acceptCurrentHead({ expectedHeadVersion: null, evidence: accepted });
    await store.markCompetingHeadRecoveryRequired({ evidence: competing });
    await store.stageRecoveryHead({
      expectedHeadVersion: 0,
      expectedRecoveryVersion: 1,
      evidence: competing,
    });

    await expect(
      store.acceptRecoveredHead({
        expectedHeadVersion: 1,
        expectedRecoveryVersion: 1,
        evidence: competing,
        recheckLocalState: async () => {
          await database!.encryptedWalletBackupOwnerPreparedMutations.put({
            scopeId,
            ownerScopeId: ownerA.ownerScopeId,
            realm,
            walletId,
            enrollmentEpoch: 1,
            mutationId: "44".repeat(16),
            requestDigest: "55".repeat(32),
            canonicalUploadGroup: Uint8Array.of(1),
            createdAtUnixMilliseconds: 1_000,
            localAssetKey: "asset",
            assetLocator: "66".repeat(32),
            custodyRevision: "1",
            desiredAction: "replace",
            activeProofCount: 1,
          });
          return true;
        },
      }),
    ).rejects.toThrow("encrypted backup owner recovery has submitted work");
    expect(await database.encryptedWalletBackupOwnerPreparedMutations.count()).toBe(0);
    expect(await store.readNewWritePermission()).toMatchObject({
      canWrite: false,
      localRecoveryStatus: "recovery-required",
      localRecoveryVersion: 1,
    });
  });

  it("rejects unissued evidence and mismatched persisted rows", async () => {
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    await database.open();
    const store = new EncryptedWalletBackupOwnerDexieAuthorityStore({
      database,
      scopeId,
      ownerScopeId: ownerA.ownerScopeId,
      realm,
      walletId,
      requestAuthPublicKey,
      enrollmentEpoch: 1,
      isCurrent: () => true,
    });
    await expect(
      store.acceptCurrentHead({
        expectedHeadVersion: null,
        evidence: { head: { formatVersion: 3 }, bundles: [] },
      }),
    ).rejects.toThrow();
    await database.encryptedWalletBackupOwnerAcceptedHeads.put({
      scopeId,
      ownerScopeId: ownerB.ownerScopeId,
      realm,
      walletId,
      enrollmentEpoch: 1,
      headVersion: 0,
      activeBundleCount: 0,
      activeObjectCount: 0,
      activeSetDigest: "00".repeat(32),
      canonicalCurrentHead: new Uint8Array(),
      localRecoveryStatus: "ready",
      localRecoveryReason: "none",
      localRecoveryVersion: 0,
    });
    const foreign = new EncryptedWalletBackupOwnerDexieAuthorityStore({
      database,
      scopeId,
      ownerScopeId: ownerB.ownerScopeId,
      realm,
      walletId,
      requestAuthPublicKey,
      enrollmentEpoch: 1,
      isCurrent: () => true,
    });
    await expect(foreign.readCurrentHead()).rejects.toThrow();
  });

  it("keeps enrollment and retry receipts isolated by selected owner", async () => {
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    await database.open();
    const storeA = new EncryptedWalletBackupOwnerDexieAuthorityStore({
      database,
      scopeId,
      ownerScopeId: ownerA.ownerScopeId,
      realm,
      walletId,
      requestAuthPublicKey,
      enrollmentEpoch: 1,
      isCurrent: () => true,
    });
    const storeB = new EncryptedWalletBackupOwnerDexieAuthorityStore({
      database,
      scopeId,
      ownerScopeId: ownerB.ownerScopeId,
      realm,
      walletId,
      requestAuthPublicKey,
      enrollmentEpoch: 1,
      isCurrent: () => true,
    });
    const enrollment = {
      schemaVersion: 1 as const,
      operationId: "44".repeat(16),
      intentDigest: "55".repeat(32),
      action: "enroll" as const,
      realm,
      walletId,
      requestAuthPublicKey,
      expectedEnrollmentEpoch: 0,
      observedEnrollmentEpoch: 1,
      lifecycle: "active" as const,
      result: "committed" as const,
    };
    expect(
      await storeA.commitEnrollmentResult({ result: enrollment, commit: () => "committed" }),
    ).toBe("committed");
    expect(await storeA.readEnrollmentResult()).toEqual(enrollment);
    expect(await storeB.readEnrollmentResult()).toBeNull();

    const retry = await storeA.scheduleRetry({
      attemptId: "66".repeat(16),
      minimumDelayMilliseconds: 50,
      nowUnixMilliseconds: 1_000,
    });
    expect(retry.ownerScopeId).toBe(ownerA.ownerScopeId);
    expect(retry.retryNotBeforeUnixMilliseconds).toBeGreaterThan(1_000);
    expect(await storeB.readRetryScheduler()).toBeNull();
    await storeA.clearRetryScheduler(retry.attemptId);
    expect(await storeA.readRetryScheduler()).toBeNull();
  });

  it("rolls back a lifecycle result if the owner session retires during the IDB write", async () => {
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    await database.open();
    let current = true;
    const store = new EncryptedWalletBackupOwnerDexieAuthorityStore({
      database,
      scopeId,
      ownerScopeId: ownerA.ownerScopeId,
      realm,
      walletId,
      requestAuthPublicKey,
      enrollmentEpoch: 1,
      isCurrent: () => current,
    });
    const table = database.encryptedWalletBackupOwnerEnrollmentResults;
    const put = table.put.bind(table);
    vi.spyOn(table, "put").mockImplementation((row) =>
      put(row).then((result) => {
        current = false;
        return result;
      }),
    );
    const commit = vi.fn();
    await expect(
      store.commitEnrollmentResult({
        result: {
          schemaVersion: 1,
          operationId: "77".repeat(16),
          intentDigest: "88".repeat(32),
          action: "enroll",
          realm,
          walletId,
          requestAuthPublicKey,
          expectedEnrollmentEpoch: 0,
          observedEnrollmentEpoch: 1,
          lifecycle: "active",
          result: "committed",
        },
        commit,
      }),
    ).rejects.toThrow("session changed");
    expect(commit).not.toHaveBeenCalled();
    expect(await table.count()).toBe(0);
  });

  it("prepares owner B's upload when the seed-scoped desired row says owner A already synced", async () => {
    let random = 0;
    const runtime = {
      subtle: webcrypto.subtle as unknown as Pick<
        SubtleCrypto,
        "deriveBits" | "importKey" | "encrypt" | "decrypt"
      >,
      getRandomValues(target: Uint8Array) {
        random += 1;
        return target.fill(random);
      },
    };
    const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
      seed: Uint8Array.from({ length: 64 }, (_, index) => index + 1),
      realm,
      runtime,
    });
    const walletScope = deriveDurableCustodyScopeId({
      scopeKind: "wallet",
      walletId: keyHandle.walletId,
    });
    const name = browserWalletDatabaseName(walletScope);
    extraDatabaseNames.push(name);
    database = new BitcasterDB(name);
    await database.open();

    const storeB = new EncryptedWalletBackupOwnerDexieAuthorityStore({
      database,
      scopeId: walletScope,
      ownerScopeId: ownerB.ownerScopeId,
      realm,
      walletId: keyHandle.walletId,
      requestAuthPublicKey: keyHandle.requestAuthPublicKey,
      enrollmentEpoch: 1,
      isCurrent: () => true,
    });
    const head = createEncryptedWalletBackupOwnerCurrentHead({
      ownerScopeId: ownerB.ownerScopeId,
      realm,
      walletId: keyHandle.walletId,
      enrollmentEpoch: 1,
      headVersion: 0,
      bundles: [],
    });
    const headEvidence = collectEncryptedWalletBackupOwnerDescriptorPages(
      enumerateEncryptedWalletBackupOwnerDescriptorPages({ head, bundles: [] }),
      {
        ownerScopeId: ownerB.ownerScopeId,
        realm,
        walletId: keyHandle.walletId,
        enrollmentEpoch: 1,
      },
    );
    await storeB.acceptCurrentHead({ expectedHeadVersion: null, evidence: headEvidence });

    const asset = {
      mintUrl: "https://mint.example",
      unit: "sat",
      assetIdentity: "cashu:ordinary",
    } as const;
    const localDesired = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: walletScope,
      asset,
      custodyRevision: 1n,
      activeProofCount: 1,
    });
    await database.encryptedWalletBackupV2DesiredAssets.put({
      ...localDesired,
      syncState: "acknowledged",
    });

    const binding = {
      localAssetKey: localDesired.localAssetKey,
      assetLocator: "aa".repeat(32),
      custodyRevision: "1",
      desiredAction: "replace" as const,
      activeProofCount: 1,
    };
    await database.encryptedWalletBackupOwnerDesiredAssets.put({
      scopeId: walletScope,
      ownerScopeId: ownerA.ownerScopeId,
      realm,
      walletId: keyHandle.walletId,
      enrollmentEpoch: 1,
      ...binding,
      syncState: "acknowledged",
      lastObservedHeadVersion: 1,
      receiptDigest: "bb".repeat(32),
    });

    const preparedBundle = await prepareEncryptedWalletBackupV2TransportBundle({
      keyHandle,
      asset,
      declaredAmount: 1n,
      custodyRevision: 1n,
      canonicalPayload: Uint8Array.of(1),
      runtime,
    });
    const envelope = await prepareEncryptedWalletBackupOwnerBundleSupersessionMutation({
      keyHandle,
      expectedContext: {
        ownerScopeId: ownerB.ownerScopeId,
        realm,
        walletId: keyHandle.walletId,
        enrollmentEpoch: 1,
      },
      expectedHeadEvidence: headEvidence,
      addedBundle: preparedBundle.descriptor,
      supersededBundleIds: [],
      runtime,
    });
    const ownerBDesired = {
      ...binding,
      assetLocator: preparedBundle.descriptor.assetLocator,
    };
    expect(await storeB.isDesiredAssetSynchronized(ownerBDesired)).toBe(false);
    const canonicalUploadGroup = encodeEncryptedWalletBackupOwnerUploadGroup({
      envelope,
      objects: preparedBundle.objects,
    });
    await expect(
      storeB.insertPreparedMutationForDesired({
        prepared: {
          mutationId: envelope.mutation.mutationId,
          requestDigest: envelope.requestDigest,
          canonicalUploadGroup,
          createdAtUnixMilliseconds: 1_000,
          localAssetKey: localDesired.localAssetKey,
          assetLocator: preparedBundle.descriptor.assetLocator,
          custodyRevision: "1",
          desiredAction: "replace",
          activeProofCount: 1,
        },
        desired: ownerBDesired,
      }),
    ).resolves.toBe("inserted");
    expect(await database.encryptedWalletBackupOwnerPreparedMutations.count()).toBe(1);
    expect(await storeB.isDesiredAssetSynchronized(ownerBDesired)).toBe(false);
    expect(
      await database.encryptedWalletBackupV2DesiredAssets.get([
        walletScope,
        localDesired.localAssetKey,
      ]),
    ).toMatchObject({
      syncState: "acknowledged",
    });
    const preparedRow = await database.encryptedWalletBackupOwnerPreparedMutations.get([
      walletScope,
      ownerB.ownerScopeId,
      realm,
      keyHandle.walletId,
      1,
    ]);
    expect(preparedRow).toBeDefined();
    await database.encryptedWalletBackupOwnerPreparedMutations.put({
      ...preparedRow!,
      mutationId: "ff".repeat(16),
    });
    await expect(storeB.readPreparedMutation()).rejects.toThrow("row is inconsistent");
    await database.encryptedWalletBackupOwnerPreparedMutations.put(preparedRow!);

    const resultHead = createEncryptedWalletBackupOwnerCurrentHead({
      ownerScopeId: ownerB.ownerScopeId,
      realm,
      walletId: keyHandle.walletId,
      enrollmentEpoch: 1,
      headVersion: 1,
      bundles: [preparedBundle.descriptor],
    });
    const receiptPrivateKey = new Uint8Array(32).fill(0x44);
    const signingKeyId = "cc".repeat(16);
    const receiptPublicKey = Buffer.from(schnorr.getPublicKey(receiptPrivateKey)).toString("hex");
    const receipt = await issueEncryptedWalletBackupOwnerBundleSupersessionReceipt({
      mutationEvidence: decodeEncryptedWalletBackupOwnerUploadGroup({
        bytes: canonicalUploadGroup,
        expectedContext: {
          ownerScopeId: ownerB.ownerScopeId,
          realm,
          walletId: keyHandle.walletId,
          enrollmentEpoch: 1,
        },
        expectedRequestAuthPublicKey: keyHandle.requestAuthPublicKey,
      }).mutationEvidence,
      expectedContext: {
        ownerScopeId: ownerB.ownerScopeId,
        realm,
        walletId: keyHandle.walletId,
        enrollmentEpoch: 1,
      },
      resultHead,
      signingKeyId,
      signingPublicKey: receiptPublicKey,
      signDigest: async (digest) =>
        schnorr.sign(digest, receiptPrivateKey, new Uint8Array(32).fill(0x55)),
    });
    const receiptEvidence = verifyEncryptedWalletBackupOwnerBundleSupersessionReceipt({
      receipt,
      mutationEvidence: decodeEncryptedWalletBackupOwnerUploadGroup({
        bytes: canonicalUploadGroup,
        expectedContext: {
          ownerScopeId: ownerB.ownerScopeId,
          realm,
          walletId: keyHandle.walletId,
          enrollmentEpoch: 1,
        },
        expectedRequestAuthPublicKey: keyHandle.requestAuthPublicKey,
      }).mutationEvidence,
      expectedContext: {
        ownerScopeId: ownerB.ownerScopeId,
        realm,
        walletId: keyHandle.walletId,
        enrollmentEpoch: 1,
      },
      pinnedSigningKeys: [
        {
          keyId: signingKeyId,
          publicKey: receiptPublicKey,
        },
      ],
    });
    await expect(
      storeB.commitVerifiedMutationResult({
        preparedMutation: {
          mutationId: envelope.mutation.mutationId,
          requestDigest: envelope.requestDigest,
        },
        canonicalUploadGroup,
        expectedHeadEvidence: headEvidence,
        receiptEvidence,
        desired: ownerBDesired,
      }),
    ).resolves.toBe("committed");
    expect(await storeB.isDesiredAssetSynchronized(ownerBDesired)).toBe(true);
    const backupSnapshot = await storeB.captureBackupReceipt({ desired: ownerBDesired });
    expect(backupSnapshot).not.toBeNull();
    const currentOwnerHead = await storeB.readCurrentHead();
    expect(currentOwnerHead).not.toBeNull();
    if (currentOwnerHead === null) throw new Error("expected accepted owner head");
    const ownerClient = new EncryptedWalletBackupOwnerClient({
      origin: "https://backup.example",
      keyHandle,
      pinnedReceiptKeys: [{ keyId: signingKeyId, publicKey: receiptPublicKey }],
    });
    const reachability = ownerClient.verifyStoredBackupReachability({
      expectedContext: {
        ownerScopeId: ownerB.ownerScopeId,
        realm,
        walletId: keyHandle.walletId,
        enrollmentEpoch: 1,
      },
      canonicalSignedMutation: backupSnapshot!.receipt.canonicalSignedMutation,
      canonicalSignedReceipt: backupSnapshot!.receipt.canonicalSignedReceipt,
      collectedHeadEvidence: currentOwnerHead,
    });
    await database.transaction(
      "rw",
      [
        database.encryptedWalletBackupV2DesiredAssets,
        database.encryptedWalletBackupOwnerDesiredAssets,
        database.encryptedWalletBackupOwnerAssetReceipts,
        database.encryptedWalletBackupOwnerAcceptedHeads,
        database.encryptedWalletBackupOwnerActiveDescriptors,
      ],
      () =>
        storeB.assertCurrentBackupReceiptInTransaction({
          snapshot: backupSnapshot!,
          reachabilityEvidence: reachability,
          desired: ownerBDesired,
        }),
    );
    await expect(
      database.transaction(
        "rw",
        [
          database.encryptedWalletBackupV2DesiredAssets,
          database.encryptedWalletBackupOwnerDesiredAssets,
          database.encryptedWalletBackupOwnerAssetReceipts,
          database.encryptedWalletBackupOwnerAcceptedHeads,
          database.encryptedWalletBackupOwnerActiveDescriptors,
        ],
        async () => {
          const stored = await database!.encryptedWalletBackupOwnerAssetReceipts.get([
            walletScope,
            ownerB.ownerScopeId,
            realm,
            keyHandle.walletId,
            1,
            localDesired.localAssetKey,
          ]);
          expect(stored).toBeDefined();
          await database!.encryptedWalletBackupOwnerAssetReceipts.put({
            ...stored!,
            canonicalSignedMutation: Uint8Array.of(0),
          });
          await storeB.assertCurrentBackupReceiptInTransaction({
            snapshot: backupSnapshot!,
            reachabilityEvidence: reachability,
            desired: ownerBDesired,
          });
        },
      ),
    ).rejects.toThrow("encrypted backup owner deletion authority changed");
    expect(
      await database.encryptedWalletBackupOwnerAssetReceipts.get([
        walletScope,
        ownerB.ownerScopeId,
        realm,
        keyHandle.walletId,
        1,
        localDesired.localAssetKey,
      ]),
    ).toEqual(backupSnapshot!.receipt);
    expect(
      await database.encryptedWalletBackupV2DesiredAssets.get([
        walletScope,
        localDesired.localAssetKey,
      ]),
    ).toMatchObject({
      syncState: "acknowledged",
    });
  });
});

function evidence(ownerScopeId: string, headVersion: number) {
  const head = createEncryptedWalletBackupOwnerCurrentHead({
    ownerScopeId,
    realm,
    walletId,
    enrollmentEpoch: 1,
    headVersion,
    bundles: [],
  });
  return collectEncryptedWalletBackupOwnerDescriptorPages(
    enumerateEncryptedWalletBackupOwnerDescriptorPages({ head, bundles: [] }),
    { ownerScopeId, realm, walletId, enrollmentEpoch: 1 },
  );
}
