// @vitest-environment node
import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import { browserWalletDatabaseName } from "@/lib/browserWalletProfile";
import { activateBrowserWalletDatabase, BitcasterDB, db } from "../proof-db";

const scopes = ["11".repeat(32), "22".repeat(32)].map((walletId) =>
  deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId }),
);

afterEach(async () => {
  db.close();
  await Promise.all(scopes.map((scopeId) => Dexie.delete(browserWalletDatabaseName(scopeId))));
});

describe("browser wallet databases", () => {
  it("installs the current wallet backup authority tables", async () => {
    activateBrowserWalletDatabase(scopes[1]!);
    await db.open();

    expect(db.verno).toBe(14);
    expect(db.custodyProofBackupAuthorities.schema.primKey.keyPath).toEqual(["scopeId", "proofId"]);
    expect(db.custodyProofBackupAuthorities.schema.indexes.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "[scopeId+backupState+proofId]",
        "[scopeId+proofState+proofId]",
        "[scopeId+admissionOperationId]",
        "backupRecordId",
      ]),
    );
    expect(db.encryptedWalletBackupBuildCursors.schema.primKey.keyPath).toBe("buildId");
    expect(db.encryptedWalletBackupPackControls.schema.primKey.keyPath).toEqual([
      "buildId",
      "packId",
    ]);
    expect(db.encryptedWalletBackupPreparedRecords.schema.primKey.keyPath).toEqual([
      "buildId",
      "recordId",
    ]);
    expect(db.encryptedWalletBackupPackBindings.schema.primKey.keyPath).toEqual([
      "buildId",
      "packId",
      "recordId",
    ]);
    expect(
      db.encryptedWalletBackupPackBindings.schema.indexes.find(
        ({ name }) => name === "[buildId+packId+ordinal]",
      )?.unique,
    ).toBe(true);
    expect(db.custodyConditionalKeysets.schema.primKey.keyPath).toEqual([
      "scopeId",
      "normalizedMint",
      "unit",
      "keysetId",
    ]);
    expect(db.encryptedWalletBackupStagedObjects.schema.primKey.keyPath).toEqual([
      "buildId",
      "packId",
    ]);
    expect(db.encryptedWalletBackupEnrollmentResults.schema.primKey.keyPath).toEqual([
      "realm",
      "vaultId",
    ]);
    expect(db.encryptedWalletBackupRetrySchedulers.schema.primKey.keyPath).toEqual([
      "scopeId",
      "realm",
      "vaultId",
    ]);
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
        .put({ realm: "realm", vaultId: "vault" }),
      legacy
        .table("encryptedWalletBackupRetrySchedulers")
        .put({ scopeId: "scope", realm: "realm", vaultId: "vault" }),
    ]);
    legacy.close();

    const upgraded = new BitcasterDB(name);
    try {
      await upgraded.open();
      await Promise.all(
        clearedVersion12TableNames.map(async (tableName) => {
          expect(await upgraded.table(tableName).count()).toBe(0);
        }),
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
      expect(await upgraded.encryptedWalletBackupPreparedRecords.count()).toBe(0);
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

const clearedVersion12TableNames = [
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
  "encryptedWalletBackupEnrollmentResults",
  "encryptedWalletBackupRetrySchedulers",
] as const;

function version12Stores() {
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

function version13Stores() {
  return {
    ...version12Stores(),
    custodyProofBackupAuthorities:
      "&[scopeId+proofId], [scopeId+backupState+proofId], [scopeId+proofState+proofId], &backupRecordId, [scopeId+admissionOperationId]",
    custodyConditionalKeysets: "&[scopeId+normalizedMint+unit+keysetId]",
  };
}
