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
  it("installs the one-to-one proof backup authority table", async () => {
    activateBrowserWalletDatabase(scopes[1]!);
    await db.open();

    expect(db.verno).toBe(10);
    expect(db.custodyProofBackupAuthorities.schema.primKey.keyPath).toEqual(["scopeId", "proofId"]);
    expect(db.custodyProofBackupAuthorities.schema.indexes.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "[scopeId+backupState+proofId]",
        "[scopeId+proofState+proofId]",
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
    expect(db.encryptedWalletBackupStagedObjects.schema.primKey.keyPath).toEqual([
      "buildId",
      "packId",
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
