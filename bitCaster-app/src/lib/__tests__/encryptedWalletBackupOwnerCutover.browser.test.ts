import Dexie from "dexie";
import {
  Amount,
  createBlindSignature,
  createDLEQProof,
  deriveKeysetId,
  hashToCurve,
  Keyset,
  OutputData,
  pointFromHex,
  type Wallet as CashuWallet,
} from "@cashu/cashu-ts";
import { bytesToHex } from "@noble/curves/utils.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { afterEach, expect, it, vi } from "vitest";
import {
  createEncryptedWalletBackupOwnerCurrentHead,
  collectEncryptedWalletBackupOwnerDescriptorPages,
  createEncryptedWalletBackupV2AssetIdentity,
  prepareEncryptedWalletBackupV2ProofSetBundle,
  deriveEncryptedWalletBackupOwnerScope,
  enumerateEncryptedWalletBackupOwnerDescriptorPages,
} from "@bitcaster/client-sdk";
import { createEncryptedWalletBackupV2KeyHandle } from "@bitcaster/client-sdk/encryptedWalletBackupV2Keys";
import { prepareEncryptedWalletBackupV2TransportBundle } from "@bitcaster/client-sdk/encryptedWalletBackupV2Bundle";
import {
  decodeEncryptedWalletBackupOwnerRequestProof,
  encryptedWalletBackupOwnerRequestDigest,
  verifyEncryptedWalletBackupOwnerRequest,
} from "@bitcaster/client-sdk/encryptedWalletBackupOwnerRequestProof";
import { encodeEncryptedWalletBackupOwnerDiscoveryPage } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerDiscovery";
import {
  encodeEncryptedWalletBackupOwnerEnrollmentEpochResult,
  encodeEncryptedWalletBackupOwnerHttpResponse,
} from "@bitcaster/client-sdk/encryptedWalletBackupOwnerHttpCodec";
import { encodeEncryptedWalletBackupOwnerDescriptorPage } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerServiceCodec";
import { encryptedWalletBackupOwnerServerRoute } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerDelegatedServerCodec";
import { EncryptedWalletBackupOwnerClient } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerClient";
import type { EncryptedWalletBackupOwnerCandidate } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerDiscovery";
import {
  issueEncryptedWalletBackupOwnerBundleSupersessionReceipt,
  verifyEncryptedWalletBackupOwnerBundleSupersessionReceipt,
} from "@bitcaster/client-sdk/encryptedWalletBackupOwnerReceipt";
import { decodeEncryptedWalletBackupOwnerUploadGroup } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerUpload";
import {
  createEncryptedWalletBackupV2DesiredAssetRow,
  decodeEncryptedWalletBackupV2DesiredAssetRow,
} from "../../stores/browser-encrypted-wallet-backup-v2-desired-asset";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import { discoverAndVerifyBrowserEncryptedWalletBackupOwnerDescriptor } from "../browserEncryptedWalletBackupV2Restore";
import { admitBrowserEncryptedWalletBackupOwnerAsset } from "../browserEncryptedWalletBackupOwnerAdmission";
import { encodeCanonicalBackupCbor } from "@bitcaster/client-sdk/encryptedWalletBackupCbor";
import { BitcasterDB } from "../../stores/proof-db";
import { browserWalletDatabaseName } from "../browserWalletProfile";
import { captureBrowserEncryptedWalletBackupOwnerSession } from "../browserEncryptedWalletBackupOwnerSession";
import { createBrowserEncryptedWalletBackupV2RuntimeDriver } from "../encryptedWalletBackupDriver";
import { runBrowserEncryptedWalletBackupOwnerWorkerCycle } from "../browserEncryptedWalletBackupOwnerWorker";
import { EncryptedWalletBackupOwnerDexieAuthorityStore } from "../../stores/encrypted-wallet-backup-owner-db";
import { recoverBrowserEncryptedWalletBackupOwnerConflict } from "../browserEncryptedWalletBackupOwnerConflictRecovery";

const configuration = {
  realm: "backup.example",
  signedOrigin: "https://backup.example",
  transportOrigin: "https://backup.example",
  pinnedReceiptKeys: [{ keyId: "55".repeat(16), publicKey: "66".repeat(32) }],
} as const;
const now = 1_800_000_000;
const databases: BitcasterDB[] = [];
const names: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(names.splice(0).map((databaseName) => Dexie.delete(databaseName)));
});

it("replays the byte-identical prepared owner mutation after IndexedDB close and reopen", async () => {
  expect(Dexie.dependencies.indexedDB).toBe(window.indexedDB);
  const runtime = browserRuntime();
  const seed = window.crypto.getRandomValues(new Uint8Array(64));
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed,
    realm: configuration.realm,
    runtime,
  });
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: "wallet",
    walletId: keyHandle.walletId,
  });
  const databaseName = browserWalletDatabaseName(scopeId);
  names.push(databaseName);
  const database = new BitcasterDB(databaseName);
  databases.push(database);
  await database.open();
  const owner = {
    ...deriveEncryptedWalletBackupOwnerScope({
      authorizationScheme: "test",
      ownerSubject: "restart",
    }),
    enrollmentEpoch: 1,
  };
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: "https://restart.example",
    unit: "sat",
    asset: { kind: "ordinary" },
  });
  const desired = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId,
    asset,
    custodyRevision: 1n,
    activeProofCount: 1,
  });
  await database.encryptedWalletBackupV2DesiredAssets.put(desired);
  const bundle = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    asset,
    declaredAmount: 1n,
    custodyRevision: 1n,
    canonicalPayload: Uint8Array.of(0x31, 0x32),
    runtime,
  });
  let remoteHead = collectEncryptedWalletBackupOwnerDescriptorPages(
    enumerateEncryptedWalletBackupOwnerDescriptorPages({
      head: createEncryptedWalletBackupOwnerCurrentHead({
        ownerScopeId: owner.ownerScopeId,
        realm: configuration.realm,
        walletId: keyHandle.walletId,
        enrollmentEpoch: 1,
        headVersion: 0,
        bundles: [],
      }),
      bundles: [],
    }),
    {
      ownerScopeId: owner.ownerScopeId,
      realm: configuration.realm,
      walletId: keyHandle.walletId,
      enrollmentEpoch: 1,
    },
  );
  const signingKey = new Uint8Array(32).fill(0x44);
  const signingKeyId = "cc".repeat(16);
  const pinnedSigningKeys = [
    {
      keyId: signingKeyId,
      publicKey: Array.from(schnorr.getPublicKey(signingKey), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join(""),
    },
  ];
  const submitted: Uint8Array[] = [];
  let committedEvidence: Awaited<
    ReturnType<typeof verifyEncryptedWalletBackupOwnerBundleSupersessionReceipt>
  > | null = null;
  let simulatedServerCommit = false;
  const remote = {
    readCurrentHead: async () => remoteHead,
    mutateHead: async (input: { readonly canonicalUploadGroup: Uint8Array }) => {
      submitted.push(input.canonicalUploadGroup.slice());
      if (committedEvidence !== null) return committedEvidence;
      const group = decodeEncryptedWalletBackupOwnerUploadGroup({
        bytes: input.canonicalUploadGroup,
        expectedContext: {
          ownerScopeId: owner.ownerScopeId,
          realm: configuration.realm,
          walletId: keyHandle.walletId,
          enrollmentEpoch: 1,
        },
        expectedRequestAuthPublicKey: keyHandle.requestAuthPublicKey,
      });
      const resultHead = createEncryptedWalletBackupOwnerCurrentHead({
        ownerScopeId: owner.ownerScopeId,
        realm: configuration.realm,
        walletId: keyHandle.walletId,
        enrollmentEpoch: 1,
        headVersion: remoteHead.head.headVersion + 1,
        bundles: [bundle.descriptor],
      });
      const receipt = await issueEncryptedWalletBackupOwnerBundleSupersessionReceipt({
        mutationEvidence: group.mutationEvidence,
        expectedContext: {
          ownerScopeId: owner.ownerScopeId,
          realm: configuration.realm,
          walletId: keyHandle.walletId,
          enrollmentEpoch: 1,
        },
        resultHead,
        signingKeyId,
        signingPublicKey: pinnedSigningKeys[0]!.publicKey,
        signDigest: async (digest) =>
          schnorr.sign(digest, signingKey, new Uint8Array(32).fill(0x55)),
      });
      committedEvidence = verifyEncryptedWalletBackupOwnerBundleSupersessionReceipt({
        receipt,
        mutationEvidence: group.mutationEvidence,
        expectedContext: {
          ownerScopeId: owner.ownerScopeId,
          realm: configuration.realm,
          walletId: keyHandle.walletId,
          enrollmentEpoch: 1,
        },
        pinnedSigningKeys,
      });
      remoteHead = collectEncryptedWalletBackupOwnerDescriptorPages(
        enumerateEncryptedWalletBackupOwnerDescriptorPages({
          head: resultHead,
          bundles: [bundle.descriptor],
        }),
        {
          ownerScopeId: owner.ownerScopeId,
          realm: configuration.realm,
          walletId: keyHandle.walletId,
          enrollmentEpoch: 1,
        },
      );
      if (!simulatedServerCommit) {
        simulatedServerCommit = true;
        throw new Error("response lost after server commit");
      }
      return committedEvidence;
    },
  };
  const workerInput = {
    database,
    scopeId,
    seed,
    keyHandle,
    owner,
    enrollmentEpoch: 1,
    remote,
    runtime,
    signal: new AbortController().signal,
    isCurrentProfile: () => true,
    assetSource: createAssetSource(database, scopeId, bundle),
  };
  expect(await runBrowserEncryptedWalletBackupOwnerWorkerCycle(workerInput)).toEqual({
    kind: "head-accepted",
  });
  await expect(runBrowserEncryptedWalletBackupOwnerWorkerCycle(workerInput)).rejects.toThrow(
    "response lost after server commit",
  );
  const preparedBeforeRestart =
    await database.encryptedWalletBackupOwnerPreparedMutations.toArray();
  expect(preparedBeforeRestart).toHaveLength(1);
  expect(preparedBeforeRestart[0]!.canonicalUploadGroup).toEqual(submitted[0]);

  database.close();
  const restartedDatabase = new BitcasterDB(databaseName);
  databases.push(restartedDatabase);
  await restartedDatabase.open();
  const restartedResult = await runBrowserEncryptedWalletBackupOwnerWorkerCycle({
    ...workerInput,
    database: restartedDatabase,
    assetSource: createAssetSource(restartedDatabase, scopeId, bundle),
  });
  expect(restartedResult).toEqual({ kind: "committed" });
  expect(submitted).toHaveLength(2);
  expect(submitted[1]).toEqual(submitted[0]);
  expect(await restartedDatabase.encryptedWalletBackupOwnerPreparedMutations.count()).toBe(0);
  expect(
    await restartedDatabase.encryptedWalletBackupOwnerDesiredAssets.get([
      scopeId,
      owner.ownerScopeId,
      desired.localAssetKey,
    ]),
  ).toMatchObject({ syncState: "acknowledged", custodyRevision: "1" });
});

it("keeps a pending removal unacknowledged after session loss during receipt arrival, then replays it", async () => {
  expect(Dexie.dependencies.indexedDB).toBe(window.indexedDB);
  const runtime = browserRuntime();
  const seed = window.crypto.getRandomValues(new Uint8Array(64));
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed,
    realm: configuration.realm,
    runtime,
  });
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: "wallet",
    walletId: keyHandle.walletId,
  });
  const databaseName = browserWalletDatabaseName(scopeId);
  names.push(databaseName);
  const database = new BitcasterDB(databaseName);
  databases.push(database);
  await database.open();

  const owner = {
    ...deriveEncryptedWalletBackupOwnerScope({
      authorizationScheme: "test",
      ownerSubject: "pending-removal",
    }),
    enrollmentEpoch: 1,
  };
  const context = {
    ownerScopeId: owner.ownerScopeId,
    realm: configuration.realm,
    walletId: keyHandle.walletId,
    enrollmentEpoch: 1,
  };
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: "https://remove.example",
    unit: "sat",
    asset: { kind: "ordinary" },
  });
  const desired = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId,
    asset,
    custodyRevision: 1n,
    activeProofCount: 1,
  });
  await database.encryptedWalletBackupV2DesiredAssets.put(desired);
  const oldBundle = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    asset,
    declaredAmount: 1n,
    custodyRevision: 1n,
    canonicalPayload: Uint8Array.of(0x52, 0x4d),
    runtime,
  });
  let remoteEvidence = collectEncryptedWalletBackupOwnerDescriptorPages(
    enumerateEncryptedWalletBackupOwnerDescriptorPages({
      head: createEncryptedWalletBackupOwnerCurrentHead({
        ...context,
        headVersion: 0,
        bundles: [],
      }),
      bundles: [],
    }),
    context,
  );
  const ownerStore = new EncryptedWalletBackupOwnerDexieAuthorityStore({
    database,
    scopeId,
    ownerScopeId: owner.ownerScopeId,
    realm: context.realm,
    walletId: context.walletId,
    requestAuthPublicKey: keyHandle.requestAuthPublicKey,
    enrollmentEpoch: context.enrollmentEpoch,
    isCurrent: () => true,
  });
  expect(
    await ownerStore.acceptCurrentHead({ expectedHeadVersion: null, evidence: remoteEvidence }),
  ).toBe("accepted");

  const signingKey = window.crypto.getRandomValues(new Uint8Array(32));
  const signingKeyId = "cd".repeat(16);
  const signingPublicKey = Array.from(schnorr.getPublicKey(signingKey), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const pinnedSigningKeys = [{ keyId: signingKeyId, publicKey: signingPublicKey }];
  const submitted: Uint8Array[] = [];
  let verifiedReceipt: Awaited<
    ReturnType<typeof verifyEncryptedWalletBackupOwnerBundleSupersessionReceipt>
  > | null = null;
  let releaseLateReceipt!: () => void;
  let notifyReceiptReady!: () => void;
  const receiptReady = new Promise<void>((resolve) => (notifyReceiptReady = resolve));
  const lateReceiptRelease = new Promise<void>((resolve) => (releaseLateReceipt = resolve));
  const remote = {
    readCurrentHead: async () => remoteEvidence,
    mutateHead: async (input: { readonly canonicalUploadGroup: Uint8Array }) => {
      submitted.push(input.canonicalUploadGroup.slice());
      if (verifiedReceipt !== null) return verifiedReceipt;
      const group = decodeEncryptedWalletBackupOwnerUploadGroup({
        bytes: input.canonicalUploadGroup,
        expectedContext: context,
        expectedRequestAuthPublicKey: keyHandle.requestAuthPublicKey,
      });
      const mutation = group.mutationEvidence.envelope.mutation;
      const removing = mutation.addedBundle === null;
      expect(mutation.supersededBundleIds).toEqual(removing ? [oldBundle.descriptor.bundleId] : []);
      const nextBundles = removing ? [] : [oldBundle.descriptor];
      const resultHead = createEncryptedWalletBackupOwnerCurrentHead({
        ...context,
        headVersion: remoteEvidence.head.headVersion + 1,
        bundles: nextBundles,
      });
      const receipt = await issueEncryptedWalletBackupOwnerBundleSupersessionReceipt({
        mutationEvidence: group.mutationEvidence,
        expectedContext: context,
        resultHead,
        signingKeyId,
        signingPublicKey,
        signDigest: async (digest) => schnorr.sign(digest, signingKey),
      });
      const evidence = verifyEncryptedWalletBackupOwnerBundleSupersessionReceipt({
        receipt,
        mutationEvidence: group.mutationEvidence,
        expectedContext: context,
        pinnedSigningKeys,
      });
      if (removing) verifiedReceipt = evidence;
      remoteEvidence = collectEncryptedWalletBackupOwnerDescriptorPages(
        enumerateEncryptedWalletBackupOwnerDescriptorPages({
          head: resultHead,
          bundles: nextBundles,
        }),
        context,
      );
      if (removing) {
        notifyReceiptReady();
        await lateReceiptRelease;
      }
      return evidence;
    },
  };
  let sessionCurrent = true;
  const workerInput = {
    database,
    scopeId,
    seed,
    keyHandle,
    owner,
    enrollmentEpoch: 1,
    remote,
    runtime,
    signal: new AbortController().signal,
    isCurrentProfile: () => sessionCurrent,
    assetSource: createAssetSource(database, scopeId, oldBundle),
  };
  expect(await runBrowserEncryptedWalletBackupOwnerWorkerCycle(workerInput)).toEqual({
    kind: "committed",
  });
  expect(remoteEvidence.head.activeBundleCount).toBe(1);
  const removalDesired = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId,
    asset,
    custodyRevision: 2n,
    activeProofCount: 0,
  });
  await database.encryptedWalletBackupV2DesiredAssets.put(removalDesired);
  const removalInput = {
    ...workerInput,
    assetSource: {
      read: async () => {
        throw new Error("pending removal must not read replacement proof material");
      },
      prepare: async () => {
        throw new Error("pending removal must not prepare replacement proof material");
      },
    },
  };
  const firstAttempt = runBrowserEncryptedWalletBackupOwnerWorkerCycle(removalInput);
  let receiptWaitTimeout: number | undefined;
  try {
    await Promise.race([
      receiptReady,
      new Promise<never>((_, reject) => {
        receiptWaitTimeout = window.setTimeout(
          () => reject(new Error("pending-removal receipt was not prepared")),
          5_000,
        );
      }),
    ]);
  } finally {
    if (receiptWaitTimeout !== undefined) window.clearTimeout(receiptWaitTimeout);
  }
  sessionCurrent = false;
  releaseLateReceipt();
  await expect(firstAttempt).rejects.toThrow("browser owner backup worker profile is stale");

  expect(remoteEvidence.head.activeBundleCount).toBe(0);
  expect(await database.encryptedWalletBackupOwnerPreparedMutations.count()).toBe(1);
  expect(
    await database.encryptedWalletBackupOwnerAcceptedHeads.get([
      scopeId,
      owner.ownerScopeId,
      context.realm,
      context.walletId,
      context.enrollmentEpoch,
    ]),
  ).toMatchObject({ headVersion: 1, localRecoveryStatus: "ready" });

  sessionCurrent = true;
  const result = await runBrowserEncryptedWalletBackupOwnerWorkerCycle(removalInput);

  expect(result).toEqual({ kind: "committed" });
  expect(submitted).toHaveLength(3);
  expect(submitted[2]).toEqual(submitted[1]);
  expect(remoteEvidence.head.activeBundleCount).toBe(0);
  expect(await database.encryptedWalletBackupOwnerPreparedMutations.count()).toBe(0);
  expect(
    await database.encryptedWalletBackupOwnerDesiredAssets.get([
      scopeId,
      owner.ownerScopeId,
      removalDesired.localAssetKey,
    ]),
  ).toMatchObject({
    desiredAction: "remove",
    syncState: "acknowledged",
    custodyRevision: "2",
  });
});

it("marks a competing selected-owner head recovery-required before any further write", async () => {
  expect(Dexie.dependencies.indexedDB).toBe(window.indexedDB);
  const runtime = browserRuntime();
  const seed = window.crypto.getRandomValues(new Uint8Array(64));
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed,
    realm: configuration.realm,
    runtime,
  });
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: "wallet",
    walletId: keyHandle.walletId,
  });
  const databaseName = browserWalletDatabaseName(scopeId);
  names.push(databaseName);
  const database = new BitcasterDB(databaseName);
  databases.push(database);
  await database.open();
  const owner = {
    ...deriveEncryptedWalletBackupOwnerScope({
      authorizationScheme: "test",
      ownerSubject: "conflicting-owner",
    }),
    enrollmentEpoch: 1,
  };
  const context = {
    ownerScopeId: owner.ownerScopeId,
    realm: configuration.realm,
    walletId: keyHandle.walletId,
    enrollmentEpoch: 1,
  };
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: "https://conflict.example",
    unit: "sat",
    asset: { kind: "ordinary" },
  });
  const bundle = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    asset,
    declaredAmount: 1n,
    custodyRevision: 1n,
    canonicalPayload: Uint8Array.of(0x43, 0x46),
    runtime,
  });
  const emptyHead = collectEncryptedWalletBackupOwnerDescriptorPages(
    enumerateEncryptedWalletBackupOwnerDescriptorPages({
      head: createEncryptedWalletBackupOwnerCurrentHead({
        ...context,
        headVersion: 0,
        bundles: [],
      }),
      bundles: [],
    }),
    context,
  );
  const competingHead = collectEncryptedWalletBackupOwnerDescriptorPages(
    enumerateEncryptedWalletBackupOwnerDescriptorPages({
      head: createEncryptedWalletBackupOwnerCurrentHead({
        ...context,
        headVersion: 1,
        bundles: [bundle.descriptor],
      }),
      bundles: [bundle.descriptor],
    }),
    context,
  );
  const ownerStore = new EncryptedWalletBackupOwnerDexieAuthorityStore({
    database,
    scopeId,
    ownerScopeId: owner.ownerScopeId,
    realm: context.realm,
    walletId: context.walletId,
    requestAuthPublicKey: keyHandle.requestAuthPublicKey,
    enrollmentEpoch: context.enrollmentEpoch,
    isCurrent: () => true,
  });
  expect(
    await ownerStore.acceptCurrentHead({ expectedHeadVersion: null, evidence: emptyHead }),
  ).toBe("accepted");
  let uploadCalls = 0;
  const result = await runBrowserEncryptedWalletBackupOwnerWorkerCycle({
    database,
    scopeId,
    seed,
    keyHandle,
    owner,
    enrollmentEpoch: 1,
    remote: {
      readCurrentHead: async () => competingHead,
      mutateHead: async () => {
        uploadCalls += 1;
        throw new Error("a competing head must pause writes before upload");
      },
    },
    runtime,
    signal: new AbortController().signal,
    isCurrentProfile: () => true,
  });

  expect(result).toEqual({ kind: "recovery-required" });
  expect(uploadCalls).toBe(0);
  expect(await ownerStore.readLocalRecoveryStatus()).toMatchObject({
    localRecoveryStatus: "recovery-required",
  });
  expect(await ownerStore.readNewWritePermission()).toMatchObject({ canWrite: false });
});

it("completes selected-owner conflict recovery after observing an unchanged higher head", async () => {
  expect(Dexie.dependencies.indexedDB).toBe(window.indexedDB);
  const runtime = browserRuntime();
  const seed = window.crypto.getRandomValues(new Uint8Array(64));
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed,
    realm: configuration.realm,
    runtime,
  });
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: "wallet",
    walletId: keyHandle.walletId,
  });
  const databaseName = browserWalletDatabaseName(scopeId);
  names.push(databaseName);
  const database = new BitcasterDB(databaseName);
  databases.push(database);
  await database.open();
  const owner = {
    ...deriveEncryptedWalletBackupOwnerScope({
      authorizationScheme: "test",
      ownerSubject: "recovering-owner",
    }),
    enrollmentEpoch: 1,
  };
  const context = {
    ownerScopeId: owner.ownerScopeId,
    realm: configuration.realm,
    walletId: keyHandle.walletId,
    enrollmentEpoch: 1,
  };
  const collectEmptyHead = (headVersion: number) =>
    collectEncryptedWalletBackupOwnerDescriptorPages(
      enumerateEncryptedWalletBackupOwnerDescriptorPages({
        head: createEncryptedWalletBackupOwnerCurrentHead({
          ...context,
          headVersion,
          bundles: [],
        }),
        bundles: [],
      }),
      context,
    );
  const initialHead = collectEmptyHead(0);
  const competingHead = collectEmptyHead(1);
  const ownerStore = new EncryptedWalletBackupOwnerDexieAuthorityStore({
    database,
    scopeId,
    ownerScopeId: owner.ownerScopeId,
    realm: context.realm,
    walletId: context.walletId,
    requestAuthPublicKey: keyHandle.requestAuthPublicKey,
    enrollmentEpoch: 1,
    isCurrent: () => true,
  });
  expect(
    await ownerStore.acceptCurrentHead({ expectedHeadVersion: null, evidence: initialHead }),
  ).toBe("accepted");
  await ownerStore.markCompetingHeadRecoveryRequired({ evidence: competingHead });

  const recovery = await recoverBrowserEncryptedWalletBackupOwnerConflict({
    database,
    scopeId,
    seed,
    keyHandle,
    owner,
    ownerContext: context,
    ownerClient: {
      readCurrentHead: async () => competingHead,
      readObject: async () => {
        throw new Error("empty-head recovery must not read object bytes");
      },
    },
    ownerStore,
    runtime,
    signal: new AbortController().signal,
    isCurrentProfile: () => true,
    loadWallet: async () => {
      throw new Error("empty-head recovery must not load a mint wallet");
    },
  });

  expect(recovery).toEqual({ kind: "completed", headVersion: 1, recoveryVersion: 2 });
  expect(await ownerStore.readLocalRecoveryStatus()).toMatchObject({
    localRecoveryStatus: "ready",
    localRecoveryVersion: 2,
  });
  expect((await ownerStore.readCurrentHead())?.head.headVersion).toBe(1);
  expect(await database.encryptedWalletBackupOwnerProofCoverage.count()).toBe(0);
});

it("restores a valid remote proof set while completing selected-owner conflict recovery", async () => {
  expect(Dexie.dependencies.indexedDB).toBe(window.indexedDB);
  const runtime = browserRuntime();
  const seed = window.crypto.getRandomValues(new Uint8Array(64));
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed,
    realm: configuration.realm,
    runtime,
  });
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: "wallet",
    walletId: keyHandle.walletId,
  });
  const databaseName = browserWalletDatabaseName(scopeId);
  names.push(databaseName);
  const database = new BitcasterDB(databaseName);
  databases.push(database);
  await database.open();
  const owner = {
    ...deriveEncryptedWalletBackupOwnerScope({
      authorizationScheme: "test",
      ownerSubject: "nonempty-recovering-owner",
    }),
    enrollmentEpoch: 1,
  };
  const context = {
    ownerScopeId: owner.ownerScopeId,
    realm: configuration.realm,
    walletId: keyHandle.walletId,
    enrollmentEpoch: 1,
  };
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: "https://conflict-restore.example",
    unit: "msat" as const,
    asset: { kind: "ordinary" },
  });
  const generator = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
  const mintPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => (index === 31 ? 1 : 0));
  const keysetId = deriveKeysetId({ "1": generator }, { unit: "msat", versionByte: 1 });
  const locator = { schemaVersion: 1 as const, kind: "nut13" as const, keysetId, counter: 0 };
  const output = OutputData.createSingleDeterministicData(1, seed, 0, keysetId);
  const blindedMessage = pointFromHex(output.blindedMessage.B_);
  const signature = createBlindSignature(blindedMessage, mintPrivateKey, keysetId);
  const dleq = createDLEQProof(blindedMessage, mintPrivateKey);
  const proof = output.toProof(
    {
      id: keysetId,
      amount: Amount.from(1),
      C_: signature.C_.toHex(true),
      dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
    },
    { id: keysetId, keys: { 1: generator } },
  );
  const bundle = await prepareEncryptedWalletBackupV2ProofSetBundle({
    keyHandle,
    seed,
    asset,
    custodyRevision: 1n,
    counterHighWaterMarks: [{ mintUrl: asset.mintUrl, unit: "msat", keysetId, nextCounter: 1 }],
    proofs: [{ mintUrl: asset.mintUrl, unit: "msat", asset: { kind: "ordinary" }, locator, proof }],
    runtime,
  });
  const emptyHead = collectEncryptedWalletBackupOwnerDescriptorPages(
    enumerateEncryptedWalletBackupOwnerDescriptorPages({
      head: createEncryptedWalletBackupOwnerCurrentHead({
        ...context,
        headVersion: 0,
        bundles: [],
      }),
      bundles: [],
    }),
    context,
  );
  const remoteHead = collectEncryptedWalletBackupOwnerDescriptorPages(
    enumerateEncryptedWalletBackupOwnerDescriptorPages({
      head: createEncryptedWalletBackupOwnerCurrentHead({
        ...context,
        headVersion: 1,
        bundles: [bundle.descriptor],
      }),
      bundles: [bundle.descriptor],
    }),
    context,
  );
  const ownerStore = new EncryptedWalletBackupOwnerDexieAuthorityStore({
    database,
    scopeId,
    ownerScopeId: owner.ownerScopeId,
    realm: context.realm,
    walletId: context.walletId,
    requestAuthPublicKey: keyHandle.requestAuthPublicKey,
    enrollmentEpoch: 1,
    isCurrent: () => true,
  });
  expect(
    await ownerStore.acceptCurrentHead({ expectedHeadVersion: null, evidence: emptyHead }),
  ).toBe("accepted");
  const workerResult = await runBrowserEncryptedWalletBackupOwnerWorkerCycle({
    database,
    scopeId,
    seed,
    keyHandle,
    owner,
    enrollmentEpoch: 1,
    remote: {
      readCurrentHead: async () => remoteHead,
      mutateHead: async () => {
        throw new Error("a competing head must not be overwritten before recovery");
      },
    },
    runtime,
    signal: new AbortController().signal,
    isCurrentProfile: () => true,
  });
  expect(workerResult).toEqual({ kind: "recovery-required" });

  const objects = new Map(bundle.objects.map((object) => [object.objectId, object]));
  const recoveryResult = await recoverBrowserEncryptedWalletBackupOwnerConflict({
    database,
    scopeId,
    seed,
    keyHandle,
    owner,
    ownerContext: context,
    ownerClient: {
      readCurrentHead: async () => remoteHead,
      readObject: async ({ objectId }) => {
        const object = objects.get(objectId);
        if (object === undefined) throw new Error("conflict restore object is absent");
        return object;
      },
    },
    ownerStore,
    runtime,
    signal: new AbortController().signal,
    isCurrentProfile: () => true,
    loadWallet: async (): Promise<CashuWallet> => {
      const keyset = new Keyset(keysetId, "msat", true, 0, 0);
      keyset.keys = { 1: generator };
      return {
        mint: { mintUrl: asset.mintUrl },
        getKeyset: () => keyset,
        checkProofsStates: async (proofsToCheck: readonly { readonly secret: string }[]) =>
          proofsToCheck.map(({ secret }) => ({
            Y: hashToCurve(new TextEncoder().encode(secret)).toHex(true),
            state: "UNSPENT" as const,
            witness: null,
          })),
      } as unknown as CashuWallet;
    },
  });

  expect(recoveryResult).toEqual({ kind: "completed", headVersion: 1, recoveryVersion: 2 });
  expect(await ownerStore.readCurrentHead()).toMatchObject({ head: { headVersion: 1 } });
  expect(await database.custodyProofs.count()).toBe(1);
  expect(await database.encryptedWalletBackupOwnerProofCoverage.toArray()).toMatchObject([
    {
      ownerScopeId: owner.ownerScopeId,
      enrollmentEpoch: 1,
      sourceKind: "head-restore",
      headVersion: 1,
      bundleId: bundle.descriptor.bundleId,
      receiptDigest: null,
    },
  ]);
});

it("does not complete owner conflict recovery when its final head reply arrives after session loss", async () => {
  expect(Dexie.dependencies.indexedDB).toBe(window.indexedDB);
  const runtime = browserRuntime();
  const seed = window.crypto.getRandomValues(new Uint8Array(64));
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed,
    realm: configuration.realm,
    runtime,
  });
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: "wallet",
    walletId: keyHandle.walletId,
  });
  const databaseName = browserWalletDatabaseName(scopeId);
  names.push(databaseName);
  const database = new BitcasterDB(databaseName);
  databases.push(database);
  await database.open();
  const owner = {
    ...deriveEncryptedWalletBackupOwnerScope({
      authorizationScheme: "test",
      ownerSubject: "cancelled-recovering-owner",
    }),
    enrollmentEpoch: 1,
  };
  const context = {
    ownerScopeId: owner.ownerScopeId,
    realm: configuration.realm,
    walletId: keyHandle.walletId,
    enrollmentEpoch: 1,
  };
  const evidence = (headVersion: number) =>
    collectEncryptedWalletBackupOwnerDescriptorPages(
      enumerateEncryptedWalletBackupOwnerDescriptorPages({
        head: createEncryptedWalletBackupOwnerCurrentHead({
          ...context,
          headVersion,
          bundles: [],
        }),
        bundles: [],
      }),
      context,
    );
  const initialHead = evidence(0);
  const competingHead = evidence(1);
  let isCurrent = true;
  const ownerStore = new EncryptedWalletBackupOwnerDexieAuthorityStore({
    database,
    scopeId,
    ownerScopeId: owner.ownerScopeId,
    realm: context.realm,
    walletId: context.walletId,
    requestAuthPublicKey: keyHandle.requestAuthPublicKey,
    enrollmentEpoch: 1,
    isCurrent: () => isCurrent,
  });
  expect(
    await ownerStore.acceptCurrentHead({ expectedHeadVersion: null, evidence: initialHead }),
  ).toBe("accepted");
  await ownerStore.markCompetingHeadRecoveryRequired({ evidence: competingHead });
  let enteredFinalRead!: () => void;
  const finalReadEntered = new Promise<void>((resolve) => (enteredFinalRead = resolve));
  let releaseFinalRead!: () => void;
  const finalReadRelease = new Promise<void>((resolve) => (releaseFinalRead = resolve));
  let readCount = 0;
  const recovery = recoverBrowserEncryptedWalletBackupOwnerConflict({
    database,
    scopeId,
    seed,
    keyHandle,
    owner,
    ownerContext: context,
    ownerClient: {
      readCurrentHead: async () => {
        readCount += 1;
        if (readCount === 2) {
          enteredFinalRead();
          await finalReadRelease;
        }
        return competingHead;
      },
      readObject: async () => {
        throw new Error("empty-head recovery must not read object bytes");
      },
    },
    ownerStore,
    runtime,
    signal: new AbortController().signal,
    isCurrentProfile: () => isCurrent,
    loadWallet: async () => {
      throw new Error("empty-head recovery must not load a mint wallet");
    },
  });
  try {
    await finalReadEntered;
    isCurrent = false;
    releaseFinalRead();
    await expect(recovery).rejects.toThrow(/cancelled/);
  } finally {
    releaseFinalRead();
  }
  expect(readCount).toBe(2);
  expect(
    await database.encryptedWalletBackupOwnerAcceptedHeads.get([
      scopeId,
      owner.ownerScopeId,
      context.realm,
      context.walletId,
      context.enrollmentEpoch,
    ]),
  ).toMatchObject({
    localRecoveryStatus: "recovery-required",
    localRecoveryVersion: 1,
  });
});

it("verifies and admits owner-restored proofs only for the current session and exact owner head", async () => {
  expect(Dexie.dependencies.indexedDB).toBe(window.indexedDB);
  const runtime = browserRuntime();
  const seed = window.crypto.getRandomValues(new Uint8Array(64));
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed,
    realm: configuration.realm,
    runtime,
  });
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: "wallet",
    walletId: keyHandle.walletId,
  });
  const databaseName = browserWalletDatabaseName(scopeId);
  names.push(databaseName);
  const database = new BitcasterDB(databaseName);
  databases.push(database);
  await database.open();
  const owner = {
    ...deriveEncryptedWalletBackupOwnerScope({
      authorizationScheme: "test",
      ownerSubject: "restore-owner",
    }),
    enrollmentEpoch: 1,
  };
  const context = {
    ownerScopeId: owner.ownerScopeId,
    realm: configuration.realm,
    walletId: keyHandle.walletId,
    enrollmentEpoch: 1,
  };
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: "https://restore.example",
    unit: "msat" as const,
    asset: { kind: "ordinary" },
  });
  const generator = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
  const mintPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => (index === 31 ? 1 : 0));
  const keysetId = deriveKeysetId({ "1": generator }, { unit: "msat", versionByte: 1 });
  const locator = { schemaVersion: 1 as const, kind: "nut13" as const, keysetId, counter: 0 };
  const output = OutputData.createSingleDeterministicData(1, seed, 0, keysetId);
  const blindedMessage = pointFromHex(output.blindedMessage.B_);
  const signature = createBlindSignature(blindedMessage, mintPrivateKey, keysetId);
  const dleq = createDLEQProof(blindedMessage, mintPrivateKey);
  const proof = output.toProof(
    {
      id: keysetId,
      amount: Amount.from(1),
      C_: signature.C_.toHex(true),
      dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
    },
    { id: keysetId, keys: { 1: generator } },
  );
  const bundle = await prepareEncryptedWalletBackupV2ProofSetBundle({
    keyHandle,
    seed,
    asset,
    custodyRevision: 1n,
    counterHighWaterMarks: [{ mintUrl: asset.mintUrl, unit: "msat", keysetId, nextCounter: 1 }],
    proofs: [{ mintUrl: asset.mintUrl, unit: "msat", asset: { kind: "ordinary" }, locator, proof }],
    runtime,
  });
  const emptyHead = collectEncryptedWalletBackupOwnerDescriptorPages(
    enumerateEncryptedWalletBackupOwnerDescriptorPages({
      head: createEncryptedWalletBackupOwnerCurrentHead({
        ...context,
        headVersion: 0,
        bundles: [],
      }),
      bundles: [],
    }),
    context,
  );
  const currentHead = collectEncryptedWalletBackupOwnerDescriptorPages(
    enumerateEncryptedWalletBackupOwnerDescriptorPages({
      head: createEncryptedWalletBackupOwnerCurrentHead({
        ...context,
        headVersion: 1,
        bundles: [bundle.descriptor],
      }),
      bundles: [bundle.descriptor],
    }),
    context,
  );
  let sessionCurrent = true;
  const ownerStore = new EncryptedWalletBackupOwnerDexieAuthorityStore({
    database,
    scopeId,
    ownerScopeId: owner.ownerScopeId,
    realm: context.realm,
    walletId: context.walletId,
    requestAuthPublicKey: keyHandle.requestAuthPublicKey,
    enrollmentEpoch: context.enrollmentEpoch,
    isCurrent: () => sessionCurrent,
  });
  await ownerStore.acceptCurrentHead({ expectedHeadVersion: null, evidence: emptyHead });
  await ownerStore.acceptCurrentHead({ expectedHeadVersion: 0, evidence: currentHead });

  let blockFirstObject = true;
  let signalObjectRead!: () => void;
  const objectReadStarted = new Promise<void>((resolve) => (signalObjectRead = resolve));
  let releaseObjectRead!: () => void;
  const objectReadRelease = new Promise<void>((resolve) => (releaseObjectRead = resolve));
  const objects = new Map(bundle.objects.map((object) => [object.objectId, object]));
  const ownerClient = {
    readObject: async ({ objectId }: { readonly objectId: string }) => {
      if (blockFirstObject) {
        blockFirstObject = false;
        signalObjectRead();
        await objectReadRelease;
      }
      const object = objects.get(objectId);
      if (object === undefined) throw new Error("owner restore test object is absent");
      return object;
    },
  };
  const restoreInput = {
    seed,
    keyHandle,
    runtime,
    signal: new AbortController().signal,
    isCurrentProfile: () => sessionCurrent,
    ownerClient: ownerClient as never,
    owner,
    ownerContext: context,
    collectedOwnerHeadEvidence: currentHead,
    descriptor: bundle.descriptor,
    loadWallet: async (): Promise<CashuWallet> => {
      const keyset = new Keyset(keysetId, "msat", true, 0, 0);
      keyset.keys = { 1: generator };
      return {
        mint: { mintUrl: asset.mintUrl },
        getKeyset: () => keyset,
        checkProofsStates: async (proofsToCheck: readonly { readonly secret: string }[]) =>
          proofsToCheck.map(({ secret }) => ({
            Y: hashToCurve(new TextEncoder().encode(secret)).toHex(true),
            state: "UNSPENT" as const,
            witness: null,
          })),
      } as unknown as CashuWallet;
    },
  };

  const staleRestore = discoverAndVerifyBrowserEncryptedWalletBackupOwnerDescriptor(restoreInput);
  let objectWaitTimeout: number | undefined;
  try {
    await Promise.race([
      objectReadStarted,
      new Promise<never>((_, reject) => {
        objectWaitTimeout = window.setTimeout(
          () => reject(new Error("owner restore object read did not start")),
          5_000,
        );
      }),
    ]);
  } finally {
    if (objectWaitTimeout !== undefined) window.clearTimeout(objectWaitTimeout);
  }
  sessionCurrent = false;
  releaseObjectRead();
  await expect(staleRestore).rejects.toThrow(/session|profile/i);
  expect(await database.custodyProofs.count()).toBe(0);
  sessionCurrent = true;

  const verified = await discoverAndVerifyBrowserEncryptedWalletBackupOwnerDescriptor(restoreInput);
  await admitBrowserEncryptedWalletBackupOwnerAsset({
    seed,
    verified: verified.verified,
    collectedHeadEvidence: currentHead,
    ownerContext: context,
    ownerAuthorityStore: ownerStore,
    asset: verified.asset,
    database,
    isCurrentProfile: () => sessionCurrent,
    wallet: await restoreInput.loadWallet(),
    sourceOperationId: `browser-owner-restore:${bundle.descriptor.bundleId}`,
    randomId: () => "browser-owner-restore",
    lockManager: navigator.locks,
  });

  expect(await database.custodyProofs.count()).toBe(1);
  expect(await database.encryptedWalletBackupV2AcceptedHeads.count()).toBe(0);
  expect(await database.encryptedWalletBackupOwnerProofCoverage.toArray()).toMatchObject([
    {
      ownerScopeId: owner.ownerScopeId,
      enrollmentEpoch: 1,
      sourceKind: "head-restore",
      headVersion: 1,
      bundleId: bundle.descriptor.bundleId,
      receiptDigest: null,
    },
  ]);
});

function createAssetSource(
  database: BitcasterDB,
  scopeId: string,
  bundle: Awaited<ReturnType<typeof prepareEncryptedWalletBackupV2TransportBundle>>,
) {
  return {
    read: async ({ localAssetKey }: { readonly localAssetKey: string }) => {
      const raw = await database.encryptedWalletBackupV2DesiredAssets.get([scopeId, localAssetKey]);
      if (raw === undefined) throw new Error("desired asset disappeared");
      const decoded = decodeEncryptedWalletBackupV2DesiredAssetRow(raw);
      return {
        desired: decoded,
        asset: {
          mintUrl: decoded.mintUrl,
          unit: decoded.unit,
          assetIdentity: decoded.assetIdentity,
        },
        proofs: [],
        losingProofs: [],
        refusalHistories: [],
        counterHighWaterMarks: [],
      };
    },
    prepare: async () => bundle,
  };
}

it.each([
  { label: "no candidate", subjects: [] },
  { label: "one candidate", subjects: ["one-owner"] },
  { label: "multiple candidates", subjects: ["owner-a", "owner-b"] },
  { label: "malformed discovery page", subjects: ["one-owner"], malformedDiscovery: true },
  { label: "invalid owner identity", subjects: ["one-owner"], invalidOwnerIdentity: true },
])(
  "connects real browser discovery and selection for $label",
  async ({ subjects, malformedDiscovery = false, invalidOwnerIdentity = false }) => {
    expect(Dexie.dependencies.indexedDB).toBe(window.indexedDB);
    const runtime = browserRuntime();
    const seed = window.crypto.getRandomValues(new Uint8Array(64));
    const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
      seed,
      realm: configuration.realm,
      runtime,
    });
    const scopeId = deriveDurableCustodyScopeId({
      scopeKind: "wallet",
      walletId: keyHandle.walletId,
    });
    const databaseName = browserWalletDatabaseName(scopeId);
    names.push(databaseName);
    const database = new BitcasterDB(databaseName);
    databases.push(database);
    await database.open();
    const owners = subjects
      .map((ownerSubject) => ({
        ...deriveEncryptedWalletBackupOwnerScope({
          authorizationScheme: "test",
          ownerSubject,
        }),
        enrollmentEpoch: 1,
      }))
      .sort((left, right) => left.ownerScopeId.localeCompare(right.ownerScopeId));
    const requests: string[] = [];
    const client = new EncryptedWalletBackupOwnerClient({
      origin: configuration.signedOrigin,
      keyHandle,
      pinnedReceiptKeys: configuration.pinnedReceiptKeys,
      fetch: ownerServerFetch({
        keyHandle,
        owners,
        requests,
        malformedDiscovery,
        invalidOwnerIdentity,
      }),
      nowUnixSeconds: () => now,
    });
    const session = captureBrowserEncryptedWalletBackupOwnerSession({
      isCurrentProfile: () => true,
      selectedOwnerScope: null,
      readAuthenticatedOwner: () => null,
      readSignerRevision: () => 1,
      subscribeSignerRevision: () => () => undefined,
    });
    const reportError = vi.fn();
    const driver = createBrowserEncryptedWalletBackupV2RuntimeDriver({
      configuration,
      database,
      scopeId,
      seed,
      ownerSession: session,
      ownerClient: client,
      remote: unusedLegacyRemote(),
      runtime,
      signal: session.signal,
      isCurrentProfile: session.isCurrent,
      leadership: {
        async hold(_name, signal, becomeLeader) {
          if (!signal.aborted) await becomeLeader();
        },
      },
      reportError,
    });

    try {
      if (malformedDiscovery || invalidOwnerIdentity) {
        await vi.waitFor(() => expect(reportError).toHaveBeenCalledOnce());
        expect(requests.length).toBeGreaterThan(0);
        expect(requests.every((path) => path.split("?", 1)[0]!.endsWith("/owners"))).toBe(true);
        expect(await database.encryptedWalletBackupOwnerAcceptedHeads.count()).toBe(0);
      } else if (owners.length === 1) {
        const owner = owners[0]!;
        await vi.waitFor(async () => {
          expect(
            await database.encryptedWalletBackupOwnerAcceptedHeads.get([
              scopeId,
              owner.ownerScopeId,
              configuration.realm,
              keyHandle.walletId,
              1,
            ]),
          ).toMatchObject({ headVersion: 0, localRecoveryStatus: "ready" });
        });
        const discoveryIndex = requests.findIndex((path) => path.endsWith("/owners"));
        const epochIndex = requests.findIndex((path) => path.endsWith("/enrollment-epoch"));
        const headIndex = requests.findIndex((path) => path.endsWith("/head"));
        expect(discoveryIndex).toBeGreaterThanOrEqual(0);
        expect(epochIndex).toBeGreaterThan(discoveryIndex);
        expect(headIndex).toBeGreaterThan(epochIndex);
        expect(requests.some((path) => path.includes("/objects/"))).toBe(false);
        expect(requests.some((path) => path.includes("compare-and-swap"))).toBe(false);
        expect(reportError).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() => expect(reportError).toHaveBeenCalledOnce());
        expect(requests.length).toBeGreaterThan(0);
        expect(requests.every((path) => path.split("?", 1)[0]!.endsWith("/owners"))).toBe(true);
        if (owners.length > 1) {
          expect(requests.length).toBeGreaterThanOrEqual(2);
          expect(requests.length % 2).toBe(0);
          const listingPath = requests[0]!.split("?", 1)[0]!;
          for (let index = 0; index < requests.length; index += 2) {
            expect(requests[index]).toBe(listingPath);
            expect(requests[index + 1]).toBe(`${listingPath}?after=${owners[0]!.ownerScopeId}`);
          }
        } else {
          expect(requests).toHaveLength(1);
        }
        expect(requests.some((path) => path.endsWith("/enrollment-epoch"))).toBe(false);
        expect(requests.some((path) => path.endsWith("/head"))).toBe(false);
        expect(requests.some((path) => path.includes("/objects/"))).toBe(false);
        expect(requests.some((path) => path.includes("compare-and-swap"))).toBe(false);
        expect(await database.encryptedWalletBackupOwnerAcceptedHeads.count()).toBe(0);
      }
    } finally {
      driver.stop();
      session.dispose();
    }
  },
);

function browserRuntime() {
  return {
    subtle: window.crypto.subtle,
    getRandomValues<T extends ArrayBufferView>(target: T): T {
      return window.crypto.getRandomValues(target);
    },
  };
}

function ownerServerFetch(input: {
  readonly keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupV2KeyHandle>>;
  readonly owners: readonly EncryptedWalletBackupOwnerCandidate[];
  readonly requests: string[];
  readonly malformedDiscovery?: boolean;
  readonly invalidOwnerIdentity?: boolean;
}): typeof fetch {
  return async (resource, init) => {
    try {
      const url = String(resource);
      const parsed = new URL(url);
      const root = `/v1/encrypted-wallet-backup/realms/${configuration.realm}/wallets/${input.keyHandle.walletId}/owners`;
      const ownerScopeId = parsed.pathname.startsWith(`${root}/`)
        ? parsed.pathname.slice(root.length + 1).split("/", 1)[0]!
        : (input.owners[0]?.ownerScopeId ?? "00".repeat(32));
      const route =
        parsed.pathname === root
          ? encryptedWalletBackupOwnerServerRoute({
              operation: "owner-discovery",
              realm: configuration.realm,
              walletId: input.keyHandle.walletId,
              requestedCursor: parsed.searchParams.get("after"),
            })
          : parsed.pathname.endsWith("/enrollment-epoch")
            ? encryptedWalletBackupOwnerServerRoute({
                operation: "enrollment-epoch",
                realm: configuration.realm,
                walletId: input.keyHandle.walletId,
                ownerScopeId,
              })
            : encryptedWalletBackupOwnerServerRoute({
                operation: "descriptor-page",
                realm: configuration.realm,
                walletId: input.keyHandle.walletId,
                ownerScopeId,
                afterBundleId: null,
              });
      input.requests.push(parsed.pathname + parsed.search);
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization === null || !authorization.startsWith("BackupV1 "))
        throw new Error("owner request proof is missing");
      const encodedProof = authorization.slice("BackupV1 ".length);
      const proofBytes = decodeBase64Url(encodedProof);
      const proof = decodeEncryptedWalletBackupOwnerRequestProof(proofBytes);
      const verified = verifyEncryptedWalletBackupOwnerRequest({
        canonicalProof: proofBytes,
        route: route.context,
        expectedMethod: route.method,
        expectedUrl: url,
        payload: new Uint8Array(),
        serverNowUnixSeconds: now,
      });
      let responseBytes: Uint8Array;
      if (route.context.operation === "owner-discovery") {
        if (input.malformedDiscovery) {
          responseBytes = Uint8Array.of(0);
        } else if (input.invalidOwnerIdentity) {
          const owner = input.owners[0]!;
          responseBytes = encodeCanonicalBackupCbor([
            1,
            "backup-owner-discovery-page",
            hexBytes(verified.requestDigest),
            verified.claims.realm,
            hexBytes(verified.claims.walletId),
            hexBytes(verified.claims.requestAuthPublicKey),
            parsed.searchParams.get("after"),
            [
              [
                "00".repeat(32),
                owner.authorizationScheme,
                owner.ownerSubject,
                owner.enrollmentEpoch,
              ],
            ],
            null,
          ]);
        } else {
          const firstPage = input.owners.length > 1 && parsed.searchParams.get("after") === null;
          responseBytes = encodeEncryptedWalletBackupOwnerDiscoveryPage({
            request: verified,
            entries: firstPage
              ? input.owners.slice(0, 1)
              : input.owners.slice(input.owners.length > 1 ? 1 : 0),
            nextCursor: firstPage ? input.owners[0]!.ownerScopeId : null,
          });
        }
      } else {
        const owner = input.owners.find(
          ({ ownerScopeId: candidate }) => candidate === route.context.ownerScopeId,
        );
        if (owner === undefined) throw new Error("test owner candidate is absent");
        const body =
          route.context.operation === "enrollment-epoch"
            ? encodeEncryptedWalletBackupOwnerEnrollmentEpochResult({
                result: "active",
                enrollmentEpoch: owner.enrollmentEpoch,
              })
            : encodeEncryptedWalletBackupOwnerDescriptorPage({
                head: createEncryptedWalletBackupOwnerCurrentHead({
                  ownerScopeId: owner.ownerScopeId,
                  realm: configuration.realm,
                  walletId: input.keyHandle.walletId,
                  enrollmentEpoch: owner.enrollmentEpoch,
                  headVersion: 0,
                  bundles: [],
                }),
                afterBundleId: null,
                bundles: [],
                nextAfterBundleId: null,
              });
        responseBytes = encodeEncryptedWalletBackupOwnerHttpResponse({
          kind:
            route.context.operation === "enrollment-epoch" ? "enrollment-epoch" : "descriptor-page",
          requestDigest: encryptedWalletBackupOwnerRequestDigest(proof),
          ownerScopeId: owner.ownerScopeId,
          realm: configuration.realm,
          walletId: input.keyHandle.walletId,
          enrollmentEpoch:
            route.context.operation === "enrollment-epoch" ? 0 : owner.enrollmentEpoch,
          body,
        });
      }
      const response = new Response(responseBytes as BodyInit, {
        status: 200,
        headers: { "content-type": "application/cbor", "cache-control": "no-store" },
      });
      Object.defineProperty(response, "url", { value: url });
      return response;
    } catch (error) {
      console.error("owner test server request failed", error);
      throw error;
    }
  };
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Uint8Array.from(window.atob(padded), (character) => character.charCodeAt(0));
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function unusedLegacyRemote() {
  const unavailable = async (): Promise<never> => {
    throw new Error("owner route expected in owner cutover browser test");
  };
  return {
    discoverEnrollmentEpoch: unavailable,
    readDescriptorPage: unavailable,
    readObject: unavailable,
    mutateHeadOnce: unavailable,
    executeAccountOperation: unavailable,
  } as never;
}
