// @vitest-environment node
import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import { browserWalletDatabaseName } from "@/lib/browserWalletProfile";
import { activateBrowserWalletDatabase, BitcasterDB, db } from "../proof-db";
import { createBrowserCustodyProofRow } from "../durable-custody-db";

const scopes = ["11".repeat(32), "22".repeat(32)].map((walletId) =>
  deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId }),
);

const v1TableNames = [
  "encryptedWalletBackupBuildCursors",
  "encryptedWalletBackupPackControls",
  "encryptedWalletBackupPreparedRecords",
  "encryptedWalletBackupPackBindings",
  "encryptedWalletBackupStagedObjects",
  "encryptedWalletBackupSnapshotControls",
  "encryptedWalletBackupPreparedSources",
  "encryptedWalletBackupSnapshotPins",
  "encryptedWalletBackupManifestPassAResults",
  "encryptedWalletBackupManifestCursors",
  "encryptedWalletBackupManifestPages",
  "encryptedWalletBackupUploadAttempts",
  "encryptedWalletBackupUploadCursors",
  "encryptedWalletBackupUploadBatches",
  "encryptedWalletBackupUploadCasAttempts",
  "encryptedWalletBackupSnapshotCleanupJobs",
  "encryptedWalletBackupRestoreProofs",
] as const;

afterEach(async () => {
  db.close();
  await Promise.all(scopes.map((scopeId) => Dexie.delete(browserWalletDatabaseName(scopeId))));
});

describe("browser wallet databases", () => {
  it("installs version 23 without V1 tables and keeps V2, enrollment, retry, and custody authorities", async () => {
    activateBrowserWalletDatabase(scopes[1]!);
    await db.open();

    expect(db.verno).toBe(23);
    expect(db.tables.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining([...v1TableNames]),
    );
    expect(db.custodyProofBackupAuthorities.schema.primKey.keyPath).toEqual(["scopeId", "proofId"]);
    expect(db.encryptedWalletBackupEnrollmentResults.schema.primKey.keyPath).toEqual([
      "realm",
      "walletId",
    ]);
    expect(db.encryptedWalletBackupRetrySchedulers.schema.primKey.keyPath).toEqual([
      "scopeId",
      "realm",
      "walletId",
    ]);
    expect(db.encryptedWalletBackupV2DesiredAssets.schema.primKey.keyPath).toEqual([
      "scopeId",
      "localAssetKey",
    ]);
    expect(db.encryptedWalletBackupV2PreparedMutations.schema.primKey.keyPath).toEqual([
      "scopeId",
      "realm",
      "walletId",
      "enrollmentEpoch",
    ]);
    expect(db.encryptedWalletBackupV2AcceptedHeads.schema.primKey.keyPath).toEqual([
      "scopeId",
      "realm",
      "walletId",
      "enrollmentEpoch",
    ]);
    expect(db.encryptedWalletBackupV2AssetReceipts.schema.primKey.keyPath).toEqual([
      "scopeId",
      "realm",
      "walletId",
      "enrollmentEpoch",
      "localAssetKey",
    ]);
    expect(db.encryptedWalletBackupV2ActiveDescriptors.schema.primKey.keyPath).toEqual([
      "scopeId",
      "realm",
      "walletId",
      "enrollmentEpoch",
      "bundleId",
    ]);
  });

  it("drops legacy backup authority rows from a version-20 database", async () => {
    const name = `bitcaster-wallet-v20-upgrade-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(20).stores(version20Stores());
    await legacy.open();
    await Promise.all([
      legacy.table("custodyProofBackupAuthorities").put({ scopeId: "scope", proofId: "proof" }),
      legacy
        .table("encryptedWalletBackupEnrollmentResults")
        .put({ realm: "backup.example.test", vaultId: "11".repeat(32) }),
      legacy.table("encryptedWalletBackupRetrySchedulers").put({
        scopeId: "scope",
        realm: "backup.example.test",
        vaultId: "11".repeat(32),
      }),
      legacy
        .table("encryptedWalletBackupV2DesiredAssets")
        .put({ scopeId: "scope", localAssetKey: "asset" }),
      legacy.table("encryptedWalletBackupV2PreparedMutations").put({
        scopeId: "scope",
        realm: "backup.example.test",
        vaultId: "11".repeat(32),
        enrollmentEpoch: 1,
      }),
      legacy.table("encryptedWalletBackupV2AcceptedHeads").put({
        scopeId: "scope",
        realm: "backup.example.test",
        vaultId: "11".repeat(32),
        enrollmentEpoch: 1,
      }),
      legacy.table("encryptedWalletBackupV2AssetReceipts").put({
        scopeId: "scope",
        realm: "backup.example.test",
        vaultId: "11".repeat(32),
        enrollmentEpoch: 1,
        localAssetKey: "asset",
      }),
      legacy.table("encryptedWalletBackupV2ActiveDescriptors").put({
        scopeId: "scope",
        realm: "backup.example.test",
        vaultId: "11".repeat(32),
        enrollmentEpoch: 1,
        bundleId: "bundle",
      }),
    ]);
    legacy.close();

    const upgraded = new BitcasterDB(name);
    try {
      await upgraded.open();
      expect(upgraded.tables.map(({ name }) => name)).not.toEqual(
        expect.arrayContaining([...v1TableNames]),
      );
      await Promise.all([
        expect(upgraded.custodyProofBackupAuthorities.count()).resolves.toBe(1),
        expect(upgraded.encryptedWalletBackupEnrollmentResults.count()).resolves.toBe(0),
        expect(upgraded.encryptedWalletBackupRetrySchedulers.count()).resolves.toBe(0),
        expect(upgraded.encryptedWalletBackupV2DesiredAssets.count()).resolves.toBe(1),
        expect(upgraded.encryptedWalletBackupV2PreparedMutations.count()).resolves.toBe(0),
        expect(upgraded.encryptedWalletBackupV2AcceptedHeads.count()).resolves.toBe(0),
        expect(upgraded.encryptedWalletBackupV2AssetReceipts.count()).resolves.toBe(0),
        expect(upgraded.encryptedWalletBackupV2ActiveDescriptors.count()).resolves.toBe(0),
      ]);
    } finally {
      upgraded.close();
      await Dexie.delete(name);
    }
  });

  it("seeds one ordinary desired asset when upgrading an active V2 custody row", async () => {
    const name = `bitcaster-wallet-v18-upgrade-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(18).stores({
      custodyProofs:
        "&[scopeId+proofId], [scopeId+normalizedMint+unit+selectability], [scopeId+conditionId+outcomeCollection+selectability]",
      custodyConditionalKeysets: "&[scopeId+normalizedMint+unit+keysetId]",
    });
    await legacy.open();
    await legacy.table("custodyProofs").put(
      createBrowserCustodyProofRow({
        scopeId: scopes[0],
        normalizedMint: "https://mint.example",
        unit: "sat",
        proof: {
          id: `01${"aa".repeat(32)}`,
          amount: 1 as never,
          secret: "migration-proof",
          C: `02${"22".repeat(32)}`,
        },
        asset: { kind: "regular" },
        receivedAtMs: 1,
      }),
    );
    legacy.close();

    const upgraded = new BitcasterDB(name);
    try {
      await upgraded.open();
      expect(await upgraded.encryptedWalletBackupV2DesiredAssets.toArray()).toMatchObject([
        {
          scopeId: scopes[0],
          mintUrl: "https://mint.example",
          unit: "sat",
          assetIdentity: "cashu:ordinary",
          custodyRevision: "1",
          activeProofCount: 1,
          desiredAction: "replace",
        },
      ]);
    } finally {
      upgraded.close();
      await Dexie.delete(name);
    }
  });

  it("fails closed when an active legacy CTF proof has no verified keyset authority", async () => {
    const name = `bitcaster-wallet-v18-ctf-upgrade-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(18).stores({
      custodyProofs:
        "&[scopeId+proofId], [scopeId+normalizedMint+unit+selectability], [scopeId+conditionId+outcomeCollection+selectability]",
      custodyConditionalKeysets: "&[scopeId+normalizedMint+unit+keysetId]",
    });
    await legacy.open();
    const conditional = createBrowserCustodyProofRow({
      scopeId: scopes[0],
      normalizedMint: "https://mint.example",
      unit: "msat",
      proof: {
        id: `01${"aa".repeat(32)}`,
        amount: 1 as never,
        secret: "migration-ctf-proof",
        C: `02${"22".repeat(32)}`,
      },
      asset: {
        kind: "conditional",
        conditionId: "11".repeat(32),
        outcomeCollection: "Display label",
      },
      receivedAtMs: 1,
    });
    await legacy.table("custodyProofs").put({
      ...conditional,
      selectability: "locked",
      reservationOperationId: "migration-lock",
      revision: 1,
    });
    legacy.close();

    const upgraded = new BitcasterDB(name);
    try {
      await expect(upgraded.open()).rejects.toThrow("conditional authority is missing");
    } finally {
      upgraded.close();
      await Dexie.delete(name);
    }
  });

  it("clears the undeployed wallet schema instead of inferring backup authority", async () => {
    const name = `bitcaster-wallet-upgrade-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(7).stores({
      proofs:
        "secret, id, C, amount, mintUrl, receivedAt, conditionId, outcomeCollection, [conditionId+outcomeCollection], [mintUrl+unit+id], [mintUrl+conditionId+outcomeCollection]",
      proofOperations: "operationId, state, kind, mintUrl, updatedAt",
      ctfRangePreparations:
        "&[scopeId+rangeOperationId], scopeId, [scopeId+clientOrderId], [scopeId+lifecycleState+createdAtMs+rangeOperationId]",
      ctfRangePreparationSources: "&[scopeId+rangeOperationId], &[scopeId+sourceOperationId]",
      ctfRangePreparationConsolidations:
        "&[scopeId+rangeOperationId+round], &[scopeId+operationId]",
      ctfRangeMessages:
        "&[scopeId+operationId+revision+code], [scopeId+status+observedAtMs+operationId+revision+code]",
      custodyScopes: "&scopeId",
      custodyOperations: "&[scopeId+operationId], [scopeId+operationState]",
      custodyArtifacts: "&[scopeId+operationId+artifactId], [scopeId+operationId]",
      custodyProofs:
        "&[scopeId+proofId], [scopeId+normalizedMint+unit+selectability], [scopeId+conditionId+outcomeCollection+selectability]",
      custodyReservations:
        "&[scopeId+proofId], [scopeId+operationId], &[scopeId+operationId+inputPosition]",
      custodyActiveWork: "&[scopeId+operationId], [scopeId+nextAttemptAtMs+operationId]",
    });
    await legacy.open();
    await legacy.table("proofs").put({ secret: "undeployed-proof" });
    legacy.close();

    const upgraded = new BitcasterDB(name);
    try {
      await upgraded.open();
      expect(await upgraded.proofs.count()).toBe(0);
      expect(await upgraded.custodyProofBackupAuthorities.count()).toBe(0);
      expect(await upgraded.encryptedWalletBackupEnrollmentResults.count()).toBe(0);
      expect(await upgraded.encryptedWalletBackupRetrySchedulers.count()).toBe(0);
    } finally {
      upgraded.close();
      await Dexie.delete(name);
    }
  });

  it("clears all approved undeployed wallet tables when upgrading from version 12", async () => {
    const name = `bitcaster-wallet-v12-upgrade-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(12).stores(version12Stores());
    await legacy.open();
    await Promise.all([
      legacy.table("proofs").put({ secret: "undeployed-proof" }),
      legacy.table("custodyProofs").put({ scopeId: "scope", proofId: "proof" }),
      legacy
        .table("custodyProofBackupAuthorities")
        .put({ scopeId: "scope", proofId: "proof", backupRecordId: "record" }),
      legacy.table("encryptedWalletBackupBuildCursors").put({ buildId: "build" }),
      legacy.table("encryptedWalletBackupSnapshotControls").put({ scopeKey: "scope" }),
      legacy
        .table("encryptedWalletBackupEnrollmentResults")
        .put({ realm: "realm", vaultId: "wallet" }),
      legacy
        .table("encryptedWalletBackupRetrySchedulers")
        .put({ scopeId: "scope", realm: "realm", vaultId: "wallet" }),
    ]);
    legacy.close();

    const upgraded = new BitcasterDB(name);
    try {
      await upgraded.open();
      await Promise.all(
        clearedVersion12RetainedTableNames.map(async (tableName) => {
          expect(await upgraded.table(tableName).count()).toBe(0);
        }),
      );
      expect(upgraded.tables.map(({ name }) => name)).not.toEqual(
        expect.arrayContaining([...v1TableNames]),
      );
    } finally {
      upgraded.close();
      await Dexie.delete(name);
    }
  });

  it("clears locator-authority rows when upgrading from version 13", async () => {
    const name = `bitcaster-wallet-v13-upgrade-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(13).stores(version13Stores());
    await legacy.open();
    await Promise.all([
      legacy.table("custodyProofs").put({ scopeId: "scope", proofId: "proof" }),
      legacy.table("custodyProofBackupAuthorities").put({
        scopeId: "scope",
        proofId: "proof",
        derivationKeysetId: `01${"11".repeat(32)}`,
        derivationCounter: 7,
      }),
      legacy
        .table("encryptedWalletBackupPreparedRecords")
        .put({ buildId: "build", recordId: "record" }),
    ]);
    legacy.close();

    const upgraded = new BitcasterDB(name);
    try {
      await upgraded.open();
      expect(await upgraded.custodyProofs.count()).toBe(0);
      expect(await upgraded.custodyProofBackupAuthorities.count()).toBe(0);
      expect(upgraded.tables.map(({ name }) => name)).not.toEqual(
        expect.arrayContaining([...v1TableNames]),
      );
    } finally {
      upgraded.close();
      await Dexie.delete(name);
    }
  });

  it("clears incompatible proof backup authority rows when upgrading from version 15", async () => {
    const name = `bitcaster-wallet-v15-upgrade-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(15).stores({
      proofs: "secret",
      proofOperations: "operationId",
      custodyProofs: "&[scopeId+proofId]",
      custodyReservations: "&[scopeId+proofId]",
      custodyProofBackupAuthorities: "&[scopeId+proofId], &backupRecordId",
      encryptedWalletBackupSnapshotControls: "&scopeKey",
    });
    await legacy.open();
    await Promise.all([
      legacy.table("proofs").put({ secret: "legacy-proof" }),
      legacy.table("proofOperations").put({ operationId: "legacy-operation" }),
      legacy.table("custodyProofs").put({ scopeId: "scope", proofId: "proof" }),
      legacy.table("custodyReservations").put({ scopeId: "scope", proofId: "proof" }),
      legacy.table("custodyProofBackupAuthorities").put({
        scopeId: "scope",
        proofId: "proof",
        backupState: "local-only",
        admissionOperationId: "legacy-operation",
      }),
      legacy.table("encryptedWalletBackupSnapshotControls").put({ scopeKey: "scope" }),
    ]);
    legacy.close();

    const upgraded = new BitcasterDB(name);
    try {
      await upgraded.open();
      await Promise.all([
        expect(upgraded.proofs.count()).resolves.toBe(0),
        expect(upgraded.proofOperations.count()).resolves.toBe(0),
        expect(upgraded.custodyProofs.count()).resolves.toBe(0),
        expect(upgraded.custodyReservations.count()).resolves.toBe(0),
        expect(upgraded.custodyProofBackupAuthorities.count()).resolves.toBe(0),
      ]);
      expect(upgraded.tables.map(({ name }) => name)).not.toEqual(
        expect.arrayContaining([...v1TableNames]),
      );
    } finally {
      upgraded.close();
      await Dexie.delete(name);
    }
  });

  it("opens one physical database and keeps another seed's rows separate", async () => {
    const firstScope = scopes[0]!;
    const secondScope = scopes[1]!;
    activateBrowserWalletDatabase(firstScope);
    const firstDatabase = db;
    await firstDatabase.proofs.put({
      secret: "first-proof",
      id: "keyset",
      C: "point",
      amount: 1,
      mintUrl: "https://mint.example",
      baseAsset: "sat",
      unit: "msat",
    });

    activateBrowserWalletDatabase(secondScope);
    expect(firstDatabase.isOpen()).toBe(false);
    expect(await db.proofs.count()).toBe(0);

    activateBrowserWalletDatabase(firstScope);
    expect(await db.proofs.get("first-proof")).toMatchObject({ secret: "first-proof" });
  });
});

const clearedVersion12RetainedTableNames = [
  "proofs",
  "proofOperations",
  "ctfRangePreparations",
  "ctfRangePreparationSources",
  "ctfRangePreparationConsolidations",
  "ctfRangeMessages",
  "custodyScopes",
  "custodyOperations",
  "custodyArtifacts",
  "custodyProofs",
  "custodyReservations",
  "custodyActiveWork",
  "custodyProofBackupAuthorities",
  "custodyConditionalKeysets",
] as const;

function version12Stores(): Record<string, string> {
  return {
    proofs:
      "secret, id, C, amount, mintUrl, receivedAt, conditionId, outcomeCollection, [conditionId+outcomeCollection], [mintUrl+unit+id], [mintUrl+conditionId+outcomeCollection]",
    proofOperations: "operationId, state, kind, mintUrl, updatedAt",
    ctfRangePreparations:
      "&[scopeId+rangeOperationId], scopeId, [scopeId+clientOrderId], [scopeId+lifecycleState+createdAtMs+rangeOperationId]",
    ctfRangePreparationSources: "&[scopeId+rangeOperationId], &[scopeId+sourceOperationId]",
    ctfRangePreparationConsolidations: "&[scopeId+rangeOperationId+round], &[scopeId+operationId]",
    ctfRangeMessages:
      "&[scopeId+operationId+revision+code], [scopeId+status+observedAtMs+operationId+revision+code]",
    custodyScopes: "&scopeId",
    custodyOperations: "&[scopeId+operationId], [scopeId+operationState]",
    custodyArtifacts: "&[scopeId+operationId+artifactId], [scopeId+operationId]",
    custodyProofs:
      "&[scopeId+proofId], [scopeId+normalizedMint+unit+selectability], [scopeId+conditionId+outcomeCollection+selectability]",
    custodyReservations:
      "&[scopeId+proofId], [scopeId+operationId], &[scopeId+operationId+inputPosition]",
    custodyActiveWork: "&[scopeId+operationId], [scopeId+nextAttemptAtMs+operationId]",
    custodyProofBackupAuthorities:
      "&[scopeId+proofId], [scopeId+backupState+proofId], [scopeId+proofState+proofId], &backupRecordId",
    encryptedWalletBackupBuildCursors: "&buildId",
    encryptedWalletBackupPackControls: "&[buildId+packId]",
    encryptedWalletBackupPreparedRecords: "&[buildId+recordId], recordId",
    encryptedWalletBackupPackBindings:
      "&[buildId+packId+recordId], &[buildId+packId+ordinal], [realm+vaultId+snapshotId+snapshotRevision+recordId]",
    encryptedWalletBackupStagedObjects:
      "&[buildId+packId], [realm+vaultId+generation+objectId+digest]",
    encryptedWalletBackupSnapshotControls: "&scopeKey, [realm+vaultId+snapshotId+snapshotRevision]",
    encryptedWalletBackupPreparedSources:
      "&[realm+vaultId+recordKindCode+recordId+revision+bodyReference], &[realm+vaultId+recordKindCode+commitment+revision+bodyReference], [realm+vaultId+recordKindCode+recordId]",
    encryptedWalletBackupSnapshotPins:
      "&[realm+vaultId+snapshotId+snapshotRevision+recordKindCode+recordId], &[realm+vaultId+snapshotId+snapshotRevision+recordKindCode+commitment], [realm+vaultId+snapshotId+snapshotRevision+recordKindCode+recordId+commitment]",
    encryptedWalletBackupManifestPassAResults:
      "&scopeKey, [realm+vaultId+snapshotId+snapshotRevision]",
    encryptedWalletBackupManifestCursors: "&scopeKey, [realm+vaultId+snapshotId+snapshotRevision]",
    encryptedWalletBackupManifestPages:
      "&[realm+vaultId+snapshotId+snapshotRevision+pageIndex], &[realm+vaultId+generation+objectId+digest], [realm+vaultId+snapshotId+snapshotRevision+pageIndex+objectId]",
    encryptedWalletBackupUploadAttempts: "&attemptId, &[realm+vaultId]",
    encryptedWalletBackupUploadCursors: "&attemptId",
    encryptedWalletBackupUploadBatches: "&batchId, attemptId",
    encryptedWalletBackupUploadCasAttempts: "&attemptId, &uploadAttemptId",
    encryptedWalletBackupEnrollmentResults: "&[realm+vaultId]",
    encryptedWalletBackupRetrySchedulers: "&[scopeId+realm+vaultId]",
  };
}

function version13Stores(): Record<string, string> {
  return {
    ...version12Stores(),
    custodyProofBackupAuthorities:
      "&[scopeId+proofId], [scopeId+backupState+proofId], [scopeId+proofState+proofId], &backupRecordId, [scopeId+admissionOperationId]",
    custodyConditionalKeysets: "&[scopeId+normalizedMint+unit+keysetId]",
  };
}

function version20Stores(): Record<string, string> {
  return {
    encryptedWalletBackupBuildCursors: "&buildId",
    encryptedWalletBackupPackControls: "&[buildId+packId]",
    encryptedWalletBackupPreparedRecords: "&[buildId+recordId], recordId",
    encryptedWalletBackupPackBindings:
      "&[buildId+packId+recordId], &[buildId+packId+ordinal], [realm+vaultId+snapshotId+snapshotRevision+recordId]",
    encryptedWalletBackupStagedObjects:
      "&[buildId+packId], [realm+vaultId+generation+objectId+digest]",
    encryptedWalletBackupSnapshotControls:
      "&scopeKey, [realm+vaultId+snapshotId+snapshotRevision], [realm+vaultId+generation+snapshotId+snapshotRevision]",
    encryptedWalletBackupPreparedSources:
      "&[realm+vaultId+recordKindCode+recordId+revision+bodyReference], &[realm+vaultId+recordKindCode+commitment+revision+bodyReference], [realm+vaultId+recordKindCode+recordId], [realm+vaultId+generation+snapshotId+snapshotRevision+recordKindCode+recordId+revision+bodyReference]",
    encryptedWalletBackupSnapshotPins:
      "&[realm+vaultId+snapshotId+snapshotRevision+recordKindCode+recordId], &[realm+vaultId+snapshotId+snapshotRevision+recordKindCode+commitment], [realm+vaultId+snapshotId+snapshotRevision+recordKindCode+recordId+commitment], [realm+vaultId+generation+snapshotId+snapshotRevision+recordKindCode+recordId+commitment], [realm+vaultId+recordKindCode+recordId+sourceRevision+sourceBodyReference]",
    encryptedWalletBackupManifestPassAResults:
      "&scopeKey, [realm+vaultId+snapshotId+snapshotRevision], [realm+vaultId+generation+snapshotId+snapshotRevision]",
    encryptedWalletBackupManifestCursors:
      "&scopeKey, [realm+vaultId+snapshotId+snapshotRevision], [realm+vaultId+generation+snapshotId+snapshotRevision]",
    encryptedWalletBackupManifestPages:
      "&[realm+vaultId+snapshotId+snapshotRevision+pageIndex], &[realm+vaultId+generation+objectId+digest], [realm+vaultId+snapshotId+snapshotRevision+pageIndex+objectId], [realm+vaultId+generation+snapshotId+snapshotRevision+pageIndex]",
    encryptedWalletBackupUploadAttempts: "&attemptId, &[realm+vaultId]",
    encryptedWalletBackupUploadCursors: "&attemptId",
    encryptedWalletBackupUploadBatches: "&batchId, attemptId",
    encryptedWalletBackupUploadCasAttempts: "&attemptId, &uploadAttemptId",
    encryptedWalletBackupSnapshotCleanupJobs: "&[realm+vaultId]",
    encryptedWalletBackupRestoreProofs: "&[scopeId+proofId]",
    custodyProofBackupAuthorities:
      "&[scopeId+proofId], [scopeId+backupState+proofId], [scopeId+proofState+proofId], &backupRecordId, [scopeId+admissionOperationId]",
    encryptedWalletBackupEnrollmentResults: "&[realm+vaultId]",
    encryptedWalletBackupRetrySchedulers: "&[scopeId+realm+vaultId]",
    encryptedWalletBackupV2DesiredAssets:
      "&[scopeId+localAssetKey], [scopeId+mintUrl+unit+assetIdentity], [scopeId+localAssetKey], [scopeId+syncState+localAssetKey]",
    encryptedWalletBackupV2PreparedMutations: "&[scopeId+realm+vaultId+enrollmentEpoch]",
    encryptedWalletBackupV2AcceptedHeads: "&[scopeId+realm+vaultId+enrollmentEpoch]",
    encryptedWalletBackupV2AssetReceipts: "&[scopeId+realm+vaultId+enrollmentEpoch+localAssetKey]",
    encryptedWalletBackupV2ActiveDescriptors:
      "&[scopeId+realm+vaultId+enrollmentEpoch+bundleId], [scopeId+realm+vaultId+enrollmentEpoch]",
  };
}
