import Dexie from "dexie";
import { afterEach, expect, it, vi } from "vitest";
import {
  collectEncryptedWalletBackupOwnerDescriptorPages,
  createEncryptedWalletBackupV2AssetIdentity,
  createEncryptedWalletBackupOwnerCurrentHead,
  deriveEncryptedWalletBackupOwnerScope,
  enumerateEncryptedWalletBackupOwnerDescriptorPages,
  encryptedWalletBackupV2LocalAssetKey,
  type EncryptedWalletBackupV2BundleRuntime,
} from "@bitcaster/client-sdk";
import { createEncryptedWalletBackupV2KeyHandle } from "@bitcaster/client-sdk/encryptedWalletBackupV2Keys";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import { createBrowserEncryptedWalletBackupV2RuntimeDriver } from "../../lib/encryptedWalletBackupDriver";
import { captureBrowserEncryptedWalletBackupOwnerSession } from "../../lib/browserEncryptedWalletBackupOwnerSession";
import { browserWalletDatabaseName } from "../../lib/browserWalletProfile";
import { createBrowserCompletedProofRemovalMarkerRow } from "../browser-proof-backup-authority";
import { BitcasterDB } from "../proof-db";

const configuration = {
  realm: "backup.example",
  signedOrigin: "https://backup.example",
  transportOrigin: "https://backup.example",
  pinnedReceiptKeys: [
    {
      keyId: "55".repeat(16),
      publicKey: "531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337",
    },
  ],
} as const;

const opened: Dexie[] = [];
const names: string[] = [];

afterEach(async () => {
  for (const database of opened.splice(0)) database.close();
  await Promise.all(names.splice(0).map((name) => Dexie.delete(name)));
});

function name(): string {
  const value = `backup-owner-upgrade-${crypto.randomUUID()}`;
  names.push(value);
  return value;
}

function createV20(name: string): Dexie {
  const database = new Dexie(name);
  // Complete merged v20 store map from commit 00fdb0e6, before owner-scoped
  // v21 stores were added. Keep this independent of the current schema.
  database.version(20).stores({
    proofs:
      "&secret, mintUrl, marketId, conditionId, outcomeCollection, reservedBy, terminalOperationId, [mintUrl+unit+id], [mintUrl+unit+id+amount+secret]",
    proofOperations: "operationId, state, kind, mintUrl, updatedAt",
    ctfRangePreparations:
      "&[scopeId+rangeOperationId], scopeId, [scopeId+clientOrderId], [scopeId+lifecycleState+createdAtMs+rangeOperationId]",
    ctfRangePreparationSources: "&[scopeId+rangeOperationId], &[scopeId+sourceOperationId]",
    ctfRangePreparationConsolidations: "&[scopeId+rangeOperationId+round], &[scopeId+operationId]",
    custodyScopes: "&scopeId",
    custodyOperations: "&[scopeId+operationId], [scopeId+operationState]",
    custodyArtifacts: "&[scopeId+operationId+artifactId], [scopeId+operationId]",
    custodyProofs:
      "&[scopeId+proofId], [scopeId+selectability], [scopeId+selectability+proofId], [scopeId+normalizedMint+unit+selectability], [scopeId+conditionId+outcomeCollection+selectability], [scopeId+normalizedMint+unit+keysetId+selectability], [scopeId+normalizedMint+unit+assetKind+selectability], [scopeId+normalizedMint+unit+conditionId+outcomeCollection+selectability], [scopeId+normalizedMint+unit+assetKind+selectability+curve+amount+proofId], [scopeId+normalizedMint+unit+keysetId+assetKind+selectability+curve+amount+proofId], [scopeId+normalizedMint+unit+keysetId+conditionId+outcomeCollection+selectability+curve+amount+proofId], [scopeId+normalizedMint+unit+conditionId+selectability+proofId]",
    custodyReservations:
      "&[scopeId+proofId], [scopeId+operationId], &[scopeId+operationId+inputPosition]",
    custodyActiveWork: "&[scopeId+operationId], [scopeId+nextAttemptAtMs+operationId]",
    ctfRangeMessages:
      "&[scopeId+operationId+revision+code], [scopeId+status+observedAtMs+operationId+revision+code]",
    custodyProofBackupAuthorities:
      "&[scopeId+proofId], [scopeId+backupState+proofId], [scopeId+proofState+proofId], &backupRecordId, [scopeId+admissionOperationId]",
    custodyConditionalKeysets:
      "&[scopeId+normalizedMint+unit+keysetId], [scopeId+normalizedMint+unit+conditionId+outcomeCollectionId]",
    walletCounterCursors: "&[scopeId+keysetId], scopeId",
    walletCounterAssociations:
      "&[scopeId+normalizedMint+unit+keysetId], scopeId, [scopeId+keysetId], [scopeId+normalizedMint+unit]",
    encryptedWalletBackupV2DesiredAssets:
      "&[scopeId+localAssetKey], [scopeId+mintUrl+unit+assetIdentity], [scopeId+localAssetKey], [scopeId+syncState+localAssetKey]",
    encryptedWalletBackupWalletEnrollmentResults: "&[realm+walletId]",
    encryptedWalletBackupWalletRetrySchedulers: "&[scopeId+realm+walletId]",
    encryptedWalletBackupV2WalletPreparedMutations: "&[scopeId+realm+walletId+enrollmentEpoch]",
    encryptedWalletBackupV2WalletAcceptedHeads: "&[scopeId+realm+walletId+enrollmentEpoch]",
    encryptedWalletBackupV2WalletAssetReceipts:
      "&[scopeId+realm+walletId+enrollmentEpoch+localAssetKey], [scopeId+realm+walletId+enrollmentEpoch]",
    encryptedWalletBackupV2WalletActiveDescriptors:
      "&[scopeId+realm+walletId+enrollmentEpoch+bundleId], [scopeId+realm+walletId+enrollmentEpoch]",
    targetedAssetRecoveryAttempts:
      "&[scopeId+assetLocator+backupHeadVersion+monitoringFactVersion], scopeId, [scopeId+completedAtUnixMilliseconds+assetLocator+backupHeadVersion+monitoringFactVersion]",
    mintQuotes:
      "&[scopeId+paymentMethod+quoteRecordId], [scopeId+paymentMethod+observedState+quoteRecordId], [scopeId+paymentMethod+recoveryState+lastRecoveryAttemptAtMs+quoteRecordId]",
    outgoingCashuTransfers:
      "&[scopeId+transferId], [scopeId+mintUrl+mintRecoveryState+dueAtMs+transferId], [scopeId+mintRecoveryState+dueAtMs+mintUrl+transferId], [scopeId+localAuthorityState+transferId], [scopeId+bearerMintUrl+localAuthorityState+transferId], [scopeId+recipientBinding+transferId], &[scopeId+recipientBinding+predecessorKey]",
    outgoingCashuTransferAdmissions: "&[scopeId+transferId]",
    participationScoreDeliveryPointers: "&[scopeId+mintUrl+accountSubject], [scopeId+deliveryId]",
    marketFundingHeads: "&[scopeId+recipientBinding], [scopeId+transferId]",
    marketCreations: "&[walletScopeId+creationId], [walletScopeId+creatorId]",
  });
  opened.push(database);
  return database;
}

it("upgrades a real v20 IndexedDB without assigning legacy rows to an owner", async () => {
  expect(Dexie.dependencies.indexedDB).toBe(window.indexedDB);
  const databaseName = name();
  const legacy = createV20(databaseName);
  await legacy.open();
  const walletId = "22".repeat(32);
  const scopeId = deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId });
  const completedAssetKey = encryptedWalletBackupV2LocalAssetKey(
    createEncryptedWalletBackupV2AssetIdentity({
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
    }),
  );
  const rows = {
    proof: { secret: "proof-secret", amount: 4 },
    custodyScope: { scopeId: "scope", revision: 3 },
    custodyOperation: { scopeId: "scope", operationId: "operation", operationState: "pending" },
    custodyArtifact: {
      scopeId: "scope",
      operationId: "operation",
      artifactId: "artifact",
      payload: "retained-custody-artifact",
    },
    custodyProof: {
      scopeId: "scope",
      proofId: "proof-id",
      secret: "proof-secret",
      normalizedMint: "https://mint.example",
      unit: "sat",
      selectability: "selectable",
      conditionId: null,
      outcomeCollection: null,
    },
    custodyReservation: {
      scopeId: "scope",
      proofId: "proof-id",
      operationId: "operation",
      inputPosition: 0,
    },
    custodyActiveWork: {
      scopeId: "scope",
      operationId: "operation",
      nextAttemptAtMs: 42,
    },
    terminalAuthority: {
      schemaVersion: 4,
      scopeId,
      proofId: "33".repeat(32),
      proofFingerprint: "44".repeat(32),
      proofRevision: 2,
      proofState: "spent",
      terminalOperationId: "terminal-operation",
      terminalAuthority: { kind: "local-operation", operationId: "terminal-operation" },
      recordCreatedAtUnixSeconds: 1,
      recordUpdatedAtUnixSeconds: 2,
      derivationLocator: null,
      updatedAtMs: 2,
      admissionOperationId: null,
      backupState: "local-only",
      backupRecordId: null,
      backupRecordCommitment: null,
    },
    completedRemoval: createBrowserCompletedProofRemovalMarkerRow({
      scopeId,
      proofId: "55".repeat(32),
      proofFingerprint: "66".repeat(32),
      proofRevision: 1,
      proofCommitment: "77".repeat(32),
      localAssetKey: completedAssetKey,
      removalIntentId: "completed-removal-intent",
      proofSetCommitment: "88".repeat(32),
      completionCustodyRevision: "3",
      realm: "backup.example",
      walletId,
      enrollmentEpoch: 1,
      acknowledgedHeadVersion: 4,
      acknowledgedActiveSetDigest: "99".repeat(32),
      acknowledgementKind: "current-head",
      receiptDigest: null,
      acknowledgedAtMs: 10,
      completedAtMs: 11,
    }),
    enrollment: { realm: "mainnet", walletId: "wallet", record: { lifecycle: "active" } },
    retry: { scopeId: "scope", realm: "mainnet", walletId: "wallet", attemptId: "retry" },
    prepared: {
      scopeId: "scope",
      realm: "mainnet",
      walletId: "wallet",
      enrollmentEpoch: 1,
      mutationId: "uncertain-request",
    },
    head: {
      scopeId: "scope",
      realm: "mainnet",
      walletId: "wallet",
      enrollmentEpoch: 1,
      headVersion: 3,
    },
    receipt: {
      scopeId: "scope",
      realm: "mainnet",
      walletId: "wallet",
      enrollmentEpoch: 1,
      localAssetKey: "asset",
      bundleId: "bundle",
    },
    descriptor: {
      scopeId: "scope",
      realm: "mainnet",
      walletId: "wallet",
      enrollmentEpoch: 1,
      bundleId: "bundle",
      objectCount: 1,
    },
    desired: {
      scopeId: "scope",
      localAssetKey: "asset",
      removalIntent: { state: "pending", operationId: "remove" },
    },
    backupAuthority: {
      scopeId: "scope",
      proofId: "proof-id",
      backupState: "remote-backed",
      proofState: "active",
    },
  };
  await Promise.all([
    legacy.table("proofs").put(rows.proof),
    legacy.table("custodyScopes").put(rows.custodyScope),
    legacy.table("custodyOperations").put(rows.custodyOperation),
    legacy.table("custodyArtifacts").put(rows.custodyArtifact),
    legacy.table("custodyProofs").put(rows.custodyProof),
    legacy.table("custodyReservations").put(rows.custodyReservation),
    legacy.table("custodyActiveWork").put(rows.custodyActiveWork),
    legacy.table("custodyProofBackupAuthorities").put(rows.terminalAuthority),
    legacy.table("encryptedWalletBackupWalletEnrollmentResults").put(rows.enrollment),
    legacy.table("encryptedWalletBackupWalletRetrySchedulers").put(rows.retry),
    legacy.table("encryptedWalletBackupV2WalletPreparedMutations").put(rows.prepared),
    legacy.table("encryptedWalletBackupV2WalletAcceptedHeads").put(rows.head),
    legacy.table("encryptedWalletBackupV2WalletAssetReceipts").put(rows.receipt),
    legacy.table("encryptedWalletBackupV2WalletActiveDescriptors").put(rows.descriptor),
    legacy.table("encryptedWalletBackupV2DesiredAssets").put(rows.desired),
    legacy.table("custodyProofBackupAuthorities").put(rows.backupAuthority),
    legacy.table("custodyProofBackupAuthorities").put(rows.completedRemoval),
  ]);

  const versionChange = new Promise<void>((resolve) => {
    legacy.on("versionchange", () => resolve());
  });
  const upgraded = new BitcasterDB(databaseName);
  opened.push(upgraded);
  await upgraded.open();
  await versionChange;

  expect(upgraded.verno).toBe(21);
  expect(legacy.isOpen()).toBe(false);
  expect(await upgraded.proofs.toArray()).toEqual([rows.proof]);
  expect(await upgraded.custodyScopes.toArray()).toEqual([rows.custodyScope]);
  expect(await upgraded.custodyOperations.toArray()).toEqual([rows.custodyOperation]);
  expect(await upgraded.custodyArtifacts.toArray()).toEqual([rows.custodyArtifact]);
  expect(await upgraded.custodyProofs.toArray()).toEqual([rows.custodyProof]);
  expect(await upgraded.custodyReservations.toArray()).toEqual([rows.custodyReservation]);
  expect(await upgraded.custodyActiveWork.toArray()).toEqual([rows.custodyActiveWork]);
  expect(await upgraded.encryptedWalletBackupEnrollmentResults.toArray()).toEqual([
    rows.enrollment,
  ]);
  expect(await upgraded.encryptedWalletBackupRetrySchedulers.toArray()).toEqual([rows.retry]);
  expect(await upgraded.encryptedWalletBackupV2PreparedMutations.toArray()).toEqual([
    rows.prepared,
  ]);
  expect(await upgraded.encryptedWalletBackupV2AcceptedHeads.toArray()).toEqual([rows.head]);
  expect(await upgraded.encryptedWalletBackupV2AssetReceipts.toArray()).toEqual([rows.receipt]);
  expect(await upgraded.encryptedWalletBackupV2ActiveDescriptors.toArray()).toEqual([
    rows.descriptor,
  ]);
  expect(await upgraded.encryptedWalletBackupV2DesiredAssets.toArray()).toEqual([rows.desired]);
  expect(
    await upgraded.custodyProofBackupAuthorities.get([scopeId, rows.terminalAuthority.proofId]),
  ).toEqual(rows.terminalAuthority);
  expect(
    await upgraded.custodyProofBackupAuthorities.get([scopeId, rows.completedRemoval.proofId]),
  ).toEqual(rows.completedRemoval);
  expect(await upgraded.encryptedWalletBackupOwnerEnrollmentResults.count()).toBe(0);
  expect(await upgraded.encryptedWalletBackupOwnerRetrySchedulers.count()).toBe(0);
  expect(await upgraded.encryptedWalletBackupOwnerPreparedMutations.count()).toBe(0);
  expect(await upgraded.encryptedWalletBackupOwnerAcceptedHeads.count()).toBe(0);
  expect(await upgraded.encryptedWalletBackupOwnerAssetReceipts.count()).toBe(0);
  expect(await upgraded.encryptedWalletBackupOwnerActiveDescriptors.count()).toBe(0);
  expect(await upgraded.encryptedWalletBackupOwnerDesiredAssets.count()).toBe(0);
  expect(await upgraded.encryptedWalletBackupOwnerProofCoverage.count()).toBe(0);
});

it("keeps identical wallet contexts isolated by ownerScopeId in v21", async () => {
  const database = new BitcasterDB(name());
  opened.push(database);
  await database.open();
  const first = {
    scopeId: "scope-a",
    ownerScopeId: "11".repeat(32),
    realm: "mainnet",
    walletId: "22".repeat(32),
    record: {
      schemaVersion: 1 as const,
      operationId: "01".repeat(16),
      intentDigest: "02".repeat(32),
      action: "enroll" as const,
      realm: "mainnet",
      walletId: "22".repeat(32),
      requestAuthPublicKey: "03".repeat(32),
      expectedEnrollmentEpoch: 0,
      observedEnrollmentEpoch: 1,
      lifecycle: "active" as const,
      result: "committed" as const,
    },
  };
  const second = { ...first, ownerScopeId: "33".repeat(32) };
  await database.encryptedWalletBackupOwnerEnrollmentResults.bulkPut([first, second]);
  expect(await database.encryptedWalletBackupOwnerEnrollmentResults.count()).toBe(2);
  expect(
    await database.encryptedWalletBackupOwnerEnrollmentResults.get([
      first.scopeId,
      first.ownerScopeId,
      first.realm,
      first.walletId,
    ]),
  ).toEqual(first);
  expect(
    await database.encryptedWalletBackupOwnerEnrollmentResults.get([
      second.scopeId,
      second.ownerScopeId,
      second.realm,
      second.walletId,
    ]),
  ).toEqual(second);
});

it("retires an application database instance on a later versionchange", async () => {
  const database = new BitcasterDB(name());
  opened.push(database);
  await database.open();
  const changed = new Promise<void>((resolve) => database.on("versionchange", () => resolve()));
  const next = new Dexie(database.name);
  next.version(22).stores({ schemaUpgradeSentinel: "&id" });
  opened.push(next);
  await next.open();
  await changed;
  expect(database.isOpen()).toBe(false);
  await expect(database.open()).rejects.toThrow("superseded by a schema upgrade");
});

it("does not write captured-account authority when an account switch releases a deferred head", async () => {
  expect(Dexie.dependencies.indexedDB).toBe(window.indexedDB);
  const seed = Uint8Array.from({ length: 64 }, (_, index) => index + 1);
  const runtime: EncryptedWalletBackupV2BundleRuntime = {
    subtle: window.crypto.subtle,
    getRandomValues: <T extends ArrayBufferView>(target: T) =>
      window.crypto.getRandomValues(target),
  };
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
  opened.push(database);
  await database.open();

  const accountA = deriveEncryptedWalletBackupOwnerScope({
    authorizationScheme: "test",
    ownerSubject: "account-a",
  });
  const accountC = deriveEncryptedWalletBackupOwnerScope({
    authorizationScheme: "test",
    ownerSubject: "account-c",
  });
  const selectedOwner = {
    ...accountA,
    enrollmentEpoch: 1,
  };
  let activeSigner = accountA;
  let signerRevision = 1;
  const signerListeners = new Set<() => void>();
  const sessionAbort = new AbortController();
  const ownerSession = captureBrowserEncryptedWalletBackupOwnerSession({
    isCurrentProfile: () => true,
    signal: sessionAbort.signal,
    readAuthenticatedOwner: () => activeSigner,
    readSignerRevision: () => signerRevision,
    subscribeSignerRevision: (listener) => {
      signerListeners.add(listener);
      return () => signerListeners.delete(listener);
    },
  });
  const context = {
    ownerScopeId: selectedOwner.ownerScopeId,
    realm: configuration.realm,
    walletId: keyHandle.walletId,
    enrollmentEpoch: selectedOwner.enrollmentEpoch,
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
  const readStarted = deferred<void>();
  const readResponse = deferred<typeof evidence>();
  const leaderFinished = deferred<void>();
  const ownerClient = {
    discover: async () => [{ entries: [selectedOwner] }],
    resolveFirstAccount: () => ({ kind: "active" as const, owner: selectedOwner }),
    readEnrollmentEpoch: async () => ({ status: "active" as const, enrollmentEpoch: 1 }),
    readCurrentHead: () => {
      readStarted.resolve();
      return readResponse.promise;
    },
    mutateHead: vi.fn(async () => {
      throw new Error("late account-switch response must not mutate the owner head");
    }),
    readObject: async () => {
      throw new Error("empty head must not read objects");
    },
    operateAccount: async () => {
      throw new Error("existing-account recovery must not run enrollment");
    },
  };
  const driver = createBrowserEncryptedWalletBackupV2RuntimeDriver({
    configuration,
    database,
    scopeId,
    seed,
    signal: ownerSession.signal,
    ownerSession,
    isCurrentProfile: ownerSession.isCurrent,
    ownerClient: ownerClient as never,
    runtime,
    leadership: {
      async hold(_name, signal, becomeLeader) {
        try {
          if (!signal.aborted) await becomeLeader();
        } finally {
          leaderFinished.resolve();
        }
      },
    },
    scheduleRetry: () => () => undefined,
  });

  try {
    await readStarted.promise;
    activeSigner = accountC;
    signerRevision += 1;
    for (const listener of signerListeners) listener();
    expect(ownerSession.signal.aborted).toBe(true);

    readResponse.resolve(evidence);
    await leaderFinished.promise;

    expect(await database.encryptedWalletBackupOwnerAcceptedHeads.count()).toBe(0);
    expect(await database.encryptedWalletBackupOwnerActiveDescriptors.count()).toBe(0);
    expect(await database.encryptedWalletBackupOwnerDesiredAssets.count()).toBe(0);
    expect(await database.encryptedWalletBackupOwnerRetrySchedulers.count()).toBe(0);
    expect(ownerClient.mutateHead).not.toHaveBeenCalled();
  } finally {
    driver.stop();
    ownerSession.dispose();
    readResponse.resolve(evidence);
    await leaderFinished.promise;
  }
});

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
