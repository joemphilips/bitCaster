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

const currentTableNames = [
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
  "walletCounterCursors",
  "walletCounterAssociations",
  "encryptedWalletBackupV2DesiredAssets",
  "encryptedWalletBackupWalletEnrollmentResults",
  "encryptedWalletBackupWalletRetrySchedulers",
  "encryptedWalletBackupV2WalletPreparedMutations",
  "encryptedWalletBackupV2WalletAcceptedHeads",
  "encryptedWalletBackupV2WalletAssetReceipts",
  "encryptedWalletBackupV2WalletActiveDescriptors",
  "targetedAssetRecoveryAttempts",
].sort();

afterEach(async () => {
  db.close();
  await Promise.all(scopes.map((scopeId) => Dexie.delete(browserWalletDatabaseName(scopeId))));
});

describe("browser wallet databases", () => {
  it("installs the current V2 schema immediately after version 8", async () => {
    activateBrowserWalletDatabase(scopes[1]!);
    await db.open();

    expect(db.verno).toBe(9);
    expect(db.tables.map(({ name }) => name).sort()).toEqual(currentTableNames);
    expect(db.custodyProofs.schema.primKey.keyPath).toEqual(["scopeId", "proofId"]);
    expect(db.custodyProofBackupAuthorities.schema.primKey.keyPath).toEqual(["scopeId", "proofId"]);
    expect(db.custodyConditionalKeysets.schema.primKey.keyPath).toEqual([
      "scopeId",
      "normalizedMint",
      "unit",
      "keysetId",
    ]);
    expect(db.walletCounterCursors.schema.primKey.keyPath).toEqual(["scopeId", "keysetId"]);
    expect(db.walletCounterAssociations.schema.primKey.keyPath).toEqual([
      "scopeId",
      "normalizedMint",
      "unit",
      "keysetId",
    ]);
    expect(db.encryptedWalletBackupV2DesiredAssets.schema.primKey.keyPath).toEqual([
      "scopeId",
      "localAssetKey",
    ]);
    expect(db.encryptedWalletBackupEnrollmentResults.schema.primKey.keyPath).toEqual([
      "realm",
      "walletId",
    ]);
    expect(db.encryptedWalletBackupRetrySchedulers.schema.primKey.keyPath).toEqual([
      "scopeId",
      "realm",
      "walletId",
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
    expect(db.targetedAssetRecoveryAttempts.schema.primKey.keyPath).toEqual([
      "scopeId",
      "assetLocator",
      "backupHeadVersion",
      "monitoringFactVersion",
    ]);
  });

  it("keeps the version-8 reset for undeployed version-7 wallet data", async () => {
    const name = `bitcaster-wallet-v7-upgrade-${crypto.randomUUID()}`;
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
    await Promise.all([
      legacy.table("proofs").put({ secret: "undeployed-proof" }),
      legacy.table("custodyProofs").put({ scopeId: "scope", proofId: "proof" }),
    ]);
    legacy.close();

    const upgraded = new BitcasterDB(name);
    try {
      await upgraded.open();
      expect(await upgraded.proofs.count()).toBe(0);
      expect(await upgraded.custodyProofs.count()).toBe(0);
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
