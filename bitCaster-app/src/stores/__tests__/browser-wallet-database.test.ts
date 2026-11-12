// @vitest-environment node
import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import {
  createEncryptedWalletBackupV2AssetIdentity,
  encryptedWalletBackupV2LocalAssetKey,
} from "@bitcaster/client-sdk/encryptedWalletBackupV2ProofSet";
import { browserWalletDatabaseName } from "@/lib/browserWalletProfile";
import { createBrowserCompletedLocalProofRemovalMarkerRow } from "../browser-proof-backup-authority";
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
  "mintQuotes",
  "outgoingCashuTransferAdmissions",
  "outgoingCashuTransfers",
  "marketFundingHeads",
  "marketCreations",
  "participationScoreDeliveryPointers",
].sort();

afterEach(async () => {
  db.close();
  await Promise.all(scopes.map((scopeId) => Dexie.delete(browserWalletDatabaseName(scopeId))));
});

describe("browser wallet databases", () => {
  it("installs the current scoped schema", async () => {
    activateBrowserWalletDatabase(scopes[1]!);
    await db.open();

    expect(db.verno).toBe(22);
    expect(db.tables.map(({ name }) => name).sort()).toEqual(currentTableNames);
    expect(db.custodyProofs.schema.primKey.keyPath).toEqual(["scopeId", "proofId"]);
    expect(db.custodyProofs.schema.idxByName["[scopeId+selectability+proofId]"]).toBeDefined();
    expect(
      db.custodyProofs.schema.idxByName[
        "[scopeId+normalizedMint+unit+conditionId+selectability+proofId]"
      ],
    ).toBeDefined();
    expect(
      db.custodyProofs.schema.idxByName[
        "[scopeId+normalizedMint+unit+assetKind+selectability+curve+amount+proofId]"
      ],
    ).toBeDefined();
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
    expect(db.mintQuotes.schema.primKey.keyPath).toEqual([
      "scopeId",
      "paymentMethod",
      "quoteRecordId",
    ]);
    expect(
      db.mintQuotes.schema.idxByName["[scopeId+paymentMethod+observedState+quoteRecordId]"],
    ).toBeDefined();
    expect(
      db.mintQuotes.schema.idxByName[
        "[scopeId+paymentMethod+recoveryState+lastRecoveryAttemptAtMs+quoteRecordId]"
      ],
    ).toBeDefined();
    expect(db.marketFundingHeads.schema.primKey.keyPath).toEqual(["scopeId", "recipientBinding"]);
    expect(db.marketCreations.schema.primKey.keyPath).toEqual(["walletScopeId", "creationId"]);
    expect(
      db.outgoingCashuTransfers.schema.idxByName["[scopeId+recipientBinding+predecessorKey]"],
    ).toBeDefined();
  });

  it("round-trips completed local-removal markers without live authority indexes", async () => {
    const scopeId = scopes[1]!;
    activateBrowserWalletDatabase(scopeId);
    await db.open();
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
    const marker = createBrowserCompletedLocalProofRemovalMarkerRow({
      scopeId,
      proofId: "44".repeat(32),
      proofFingerprint: "55".repeat(32),
      proofRevision: 0,
      localAssetKey: encryptedWalletBackupV2LocalAssetKey(asset),
      terminalOperationId: "redeem-marker-test",
      completedAtMs: 3,
    });
    await db.custodyProofBackupAuthorities.put(marker);

    await expect(db.custodyProofBackupAuthorities.get([scopeId, marker.proofId])).resolves.toEqual(
      marker,
    );
    await expect(
      db.custodyProofBackupAuthorities
        .where("[scopeId+proofState+proofId]")
        .equals([scopeId, "selectable", marker.proofId])
        .count(),
    ).resolves.toBe(0);
    await expect(
      db.custodyProofBackupAuthorities
        .where("[scopeId+admissionOperationId]")
        .equals([scopeId, "admission-marker-test"])
        .count(),
    ).resolves.toBe(0);
  });

  it("drops the encrypted proof backup tables of a version 20 database and keeps custody rows", async () => {
    const name = `bitcaster-wallet-v20-upgrade-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(20).stores({
      proofs: "&secret",
      custodyProofBackupAuthorities: "&[scopeId+proofId]",
      encryptedWalletBackupV2DesiredAssets: "&[scopeId+localAssetKey]",
      encryptedWalletBackupWalletEnrollmentResults: "&[realm+walletId]",
      encryptedWalletBackupV2WalletAcceptedHeads: "&[scopeId+realm+walletId+enrollmentEpoch]",
    });
    await legacy.open();
    const custody = { scopeId: "scope", proofId: "proof", backupState: "local-only" };
    await Promise.all([
      legacy.table("custodyProofBackupAuthorities").put(custody),
      legacy
        .table("encryptedWalletBackupV2DesiredAssets")
        .put({ scopeId: "scope", localAssetKey: "a" }),
      legacy
        .table("encryptedWalletBackupWalletEnrollmentResults")
        .put({ realm: "mainnet", walletId: "wallet" }),
      legacy.table("encryptedWalletBackupV2WalletAcceptedHeads").put({
        scopeId: "scope",
        realm: "mainnet",
        walletId: "wallet",
        enrollmentEpoch: 1,
      }),
    ]);
    legacy.close();

    const upgraded = new BitcasterDB(name);
    try {
      await upgraded.open();
      expect(upgraded.verno).toBe(22);
      expect(upgraded.tables.map(({ name: table }) => table)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^encryptedWalletBackup/)]),
      );
      expect(await upgraded.custodyProofBackupAuthorities.toArray()).toEqual([custody]);
    } finally {
      upgraded.close();
      await Dexie.delete(name);
    }
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
    expect(await db.proofs.get("first-proof")).toMatchObject({
      secret: "first-proof",
    });
  });
});
