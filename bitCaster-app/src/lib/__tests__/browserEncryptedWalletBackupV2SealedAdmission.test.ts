// @vitest-environment node
import "fake-indexeddb/auto";
import { Amount, deriveConditionalKeysetId } from "@cashu/cashu-ts";
import {
  createEncryptedWalletBackupV2AssetIdentity,
  createEncryptedWalletBackupV2CurrentHead,
  createEncryptedWalletBackupV2KeyHandle,
  collectEncryptedWalletBackupV2DescriptorPages,
  createDurableCustodyArtifactReference,
  decryptEncryptedWalletBackupV2ProofSetBundle,
  digestEncryptedWalletBackupV2TerminalProofCommitment,
  encodeDurableWalletProofDerivationLocatorCbor,
  enumerateEncryptedWalletBackupV2DescriptorPages,
  prepareEncryptedWalletBackupV2TransportBundle,
  verifyEncryptedWalletBackupV2RestoredProofSet,
  type EncryptedWalletBackupV2ProofSetAsset,
} from "@bitcaster/client-sdk";
import {
  deriveDurableCustodyProofId,
  deriveDurableCustodyArtifactFingerprint,
  deriveDurableCustodyWalletId,
} from "@bitcaster/client-sdk/durableCustody";
import { prepareDurableCustodyProofImport } from "@bitcaster/client-sdk/durableCustodyProofImport";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import { encryptedWalletBackupV2LocalAssetKey } from "@bitcaster/client-sdk/encryptedWalletBackupV2ProofSet";
import { deriveDurableWalletProofSecret } from "@bitcaster/client-sdk/durableWalletProofDerivationLocator";
import { serializeDurableCustodyProofArtifact } from "@bitcaster/client-sdk/durableCustodyProofMaterial";
import { encodeCanonicalBackupCbor } from "@bitcaster/client-sdk/encryptedWalletBackupCbor";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEncryptedWalletBackupV2DesiredAssetRow,
  createEncryptedWalletBackupV2RemovalIntent,
} from "../../stores/browser-encrypted-wallet-backup-v2-desired-asset";
import {
  BrowserDurableCustodyAdapter,
  createBrowserCustodyProofRow,
} from "../../stores/durable-custody-db";
import {
  activateBrowserWalletDatabase,
  BitcasterDB,
  db,
  getProofs,
  storedProofRow,
} from "../../stores/proof-db";
import {
  createBrowserProofBackupAuthorityRow,
  createBrowserRemoteProofBackupAuthorityRow,
  requireBrowserLiveProofBackupAuthorityTableRow,
} from "../../stores/browser-proof-backup-authority";
import { createBrowserCompletedProofRemovalMarkerRow } from "../../stores/browser-proof-backup-authority";
import { admitBrowserEncryptedWalletBackupV2SealedAsset } from "../browserEncryptedWalletBackupV2Admission";
import { browserWalletScope } from "../browserCtfRangeOrderSource";
import { browserWalletDatabaseName } from "../browserWalletProfile";

const SEED = Uint8Array.from({ length: 64 }, (_, index) => index + 1);
const MINT = "https://mint.example";
const PUBLIC_KEY = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const CONDITION_ID = "55".repeat(32);
const COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION_ID,
  outcomeCollection: "YES",
});
const KEYSET_ID = deriveConditionalKeysetId({
  keys: { 1: PUBLIC_KEY },
  unit: "msat",
  input_fee_ppk: 0,
  final_expiry: 20,
  conditionId: CONDITION_ID,
  outcomeCollectionId: COLLECTION_ID,
});
const CTF_ASSET = {
  kind: "ctf",
  conditionId: CONDITION_ID,
  outcomeLabel: "YES",
  outcomeCollectionId: COLLECTION_ID,
  registeredAt: 10,
  finalExpiry: 20,
} as const;

describe("browser V2 sealed proof admission", () => {
  let database: BitcasterDB | null = null;
  let globalDatabaseActive = false;

  afterEach(async () => {
    if (globalDatabaseActive) {
      db.close();
      globalDatabaseActive = false;
    }
    database?.close();
    if (database) await indexedDB.deleteDatabase(database.name);
    database = null;
  });

  it("restores sealed CTF proofs without mint calls or a keyset row", async () => {
    const fixture = await sealedFixture();
    database = fixture.database;
    await putLegacyCache(fixture);

    await admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input);

    const proofRows = await database.custodyProofs.toArray();
    const authorityRows = (await database.custodyProofBackupAuthorities.toArray()).map((row) => {
      const authority = requireBrowserLiveProofBackupAuthorityTableRow(row, [
        row.scopeId,
        row.proofId,
      ]);
      if (!authority) throw new Error("test authority is missing");
      return authority;
    });
    expect(proofRows).toHaveLength(2);
    expect(proofRows.every((row) => row.selectability === "verified-losing")).toBe(true);
    expect(authorityRows).toHaveLength(2);
    expect(authorityRows.every((row) => row.backupState === "remote-backed")).toBe(true);
    expect(authorityRows.every((row) => row.terminalAuthority?.kind === "remote-seal")).toBe(true);
    expect(authorityRows.map((row) => row.backupRecordId).sort()).toEqual(
      fixture.verified.proofs.map(({ proofId }) => proofId).sort(),
    );
    expect(authorityRows.map((row) => row.backupRecordCommitment).sort()).toEqual(
      fixture.verified.proofs.map(({ terminalSeal }) => terminalSeal!.proofCommitment).sort(),
    );
    expect(await database.custodyConditionalKeysets.count()).toBe(0);
    expect(await database.custodyOperations.count()).toBe(0);
    expect(await database.proofs.count()).toBe(0);
    expect(
      await database.walletCounterAssociations.get([fixture.scopeId, MINT, "msat", KEYSET_ID]),
    ).toMatchObject({ recoveryComplete: true });
    expect(await database.walletCounterCursors.get([fixture.scopeId, KEYSET_ID])).toEqual({
      scopeId: fixture.scopeId,
      keysetId: KEYSET_ID,
      next: 5,
    });
    const desired = await database.encryptedWalletBackupV2DesiredAssets.toArray();
    expect(desired).toHaveLength(1);
    expect(desired[0]).toMatchObject({
      custodyRevision: "7",
      activeProofCount: 2,
      desiredAction: "replace",
      syncState: "acknowledged",
      terminalCtfContext: {
        conditionId: CONDITION_ID,
        outcomeLabel: "YES",
        outcomeCollectionId: COLLECTION_ID,
        registeredAt: 10,
        finalExpiry: 20,
      },
    });

    const adapter = new BrowserDurableCustodyAdapter(database);
    await expect(
      adapter.readProof(fixture.scopeId, fixture.verified.proofs[0]!.proofId),
    ).resolves.toMatchObject({ selectability: "verified-losing" });
    await expect(
      adapter.claimScope(browserWalletScope(SEED), {
        incarnationId: "origin-loss-test",
        observedAtMs: 2_000,
        leaseExpiresAtMs: 3_000,
      }),
    ).resolves.toMatchObject({ incarnationId: "origin-loss-test" });
  });

  it("promotes an exact active proof to retained losing state atomically", async () => {
    const fixture = await sealedFixture();
    database = fixture.database;
    const entry = fixture.verified.proofs[0]!;
    if (entry.asset.kind !== "ctf") throw new Error("test proof is not conditional");
    const local = createBrowserCustodyProofRow({
      scopeId: fixture.scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: entry.proof,
      asset: {
        kind: "conditional",
        conditionId: entry.asset.conditionId,
        outcomeCollection: entry.asset.outcomeLabel,
      },
      receivedAtMs: 1,
    });
    await fixture.database.custodyProofs.put(local);
    await fixture.database.custodyProofBackupAuthorities.put(
      createBrowserProofBackupAuthorityRow(local, 2, entry.locator, "local-admission"),
    );
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put({
      ...createEncryptedWalletBackupV2DesiredAssetRow({
        scopeId: fixture.scopeId,
        asset: fixture.input.asset,
        custodyRevision: 3n,
        activeProofCount: 1,
      }),
      syncState: "acknowledged",
    });
    await putLegacyCache(fixture);

    await admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input);

    await expect(
      fixture.database.custodyProofs.get([fixture.scopeId, entry.proofId]),
    ).resolves.toMatchObject({ selectability: "verified-losing", revision: 1 });
    await expect(
      fixture.database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        encryptedWalletBackupV2LocalAssetKey(fixture.input.asset),
      ]),
    ).resolves.toMatchObject({
      custodyRevision: "8",
      activeProofCount: 2,
      syncState: "pending",
      removalIntent: null,
    });
    expect(await fixture.database.proofs.count()).toBe(0);
  });

  it("uses the greater local revision before incrementing the sealed union", async () => {
    const fixture = await sealedFixture();
    database = fixture.database;
    await putActiveLocalSibling(fixture, fixture.verified.proofs[0]!, 9n);

    await admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input);

    await expect(
      database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        encryptedWalletBackupV2LocalAssetKey(fixture.input.asset),
      ]),
    ).resolves.toMatchObject({ custodyRevision: "11", activeProofCount: 2 });
  });

  it("rolls back active reconciliation and reopens the exact bundle", async () => {
    const fixture = await sealedFixture();
    database = fixture.database;
    const entry = fixture.verified.proofs[0]!;
    const local = await putActiveLocalSibling(fixture, entry, 3n);
    await putLegacyCache(fixture);

    await expect(
      admitBrowserEncryptedWalletBackupV2SealedAsset({
        ...fixture.input,
        fault: "before-commit",
      }),
    ).rejects.toThrow(/injected commit fault/);
    await expect(
      database.custodyProofs.get([fixture.scopeId, local.proofId]),
    ).resolves.toMatchObject({ selectability: "selectable", revision: 0 });
    await expect(
      database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        encryptedWalletBackupV2LocalAssetKey(fixture.input.asset),
      ]),
    ).resolves.toMatchObject({ custodyRevision: "3", activeProofCount: 1 });
    expect(await database.proofs.count()).toBe(2);

    await admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input);
    await expect(
      database.custodyProofs.get([fixture.scopeId, local.proofId]),
    ).resolves.toMatchObject({ selectability: "verified-losing", revision: 1 });
  });

  it("does not downgrade a retained losing sibling on a stale replay", async () => {
    const fixture = await sealedFixture();
    database = fixture.database;
    const entry = fixture.verified.proofs[0]!;
    const local = await putActiveLocalSibling(fixture, entry, 9n);
    const secondEntry = fixture.verified.proofs[1]!;
    const secondLocal = await putActiveLocalSibling(fixture, secondEntry, 9n);
    const losing = { ...local, selectability: "verified-losing" as const, revision: 4 };
    const secondLosing = {
      ...secondLocal,
      selectability: "verified-losing" as const,
      revision: 4,
    };
    await database.custodyProofs.put(losing);
    await database.custodyProofs.put(secondLosing);
    await database.custodyProofBackupAuthorities.put(
      createBrowserRemoteProofBackupAuthorityRow({
        proof: losing,
        observedAtMs: 3,
        derivationLocator: entry.locator,
        restoreProofId: entry.proofId,
        restoreProofCommitment: entry.terminalSeal!.proofCommitment,
      }),
    );
    await database.custodyProofBackupAuthorities.put(
      createBrowserRemoteProofBackupAuthorityRow({
        proof: secondLosing,
        observedAtMs: 3,
        derivationLocator: secondEntry.locator,
        restoreProofId: secondEntry.proofId,
        restoreProofCommitment: secondEntry.terminalSeal!.proofCommitment,
      }),
    );
    await database.encryptedWalletBackupV2DesiredAssets.put({
      ...createEncryptedWalletBackupV2DesiredAssetRow({
        scopeId: fixture.scopeId,
        asset: fixture.input.asset,
        custodyRevision: 9n,
        activeProofCount: 2,
      }),
      syncState: "pending",
    });

    await admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input);

    await expect(
      database.custodyProofs.get([fixture.scopeId, entry.proofId]),
    ).resolves.toMatchObject({ selectability: "verified-losing", revision: 4 });
    await expect(
      database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        encryptedWalletBackupV2LocalAssetKey(fixture.input.asset),
      ]),
    ).resolves.toMatchObject({ custodyRevision: "9", activeProofCount: 2 });
  });

  it("refuses promotion when an exact proof reservation exists", async () => {
    const fixture = await sealedFixture();
    database = fixture.database;
    const entry = fixture.verified.proofs[0]!;
    const local = await putActiveLocalSibling(fixture, entry, 3n);
    await database.custodyReservations.put({
      scopeId: fixture.scopeId,
      proofId: local.proofId,
      operationId: "reservation-operation",
      reservationId: "reservation-id",
      inputPosition: 0,
    });

    await expect(admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input)).rejects.toThrow(
      /proof reservation conflicts/,
    );
    await expect(
      database.custodyProofs.get([fixture.scopeId, local.proofId]),
    ).resolves.toMatchObject({ selectability: "selectable", revision: 0 });
    await expect(
      database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        encryptedWalletBackupV2LocalAssetKey(fixture.input.asset),
      ]),
    ).resolves.toMatchObject({ custodyRevision: "3", activeProofCount: 1 });
  });

  it("refuses promotion when the creator has a reconciled pending outbox pin", async () => {
    const fixture = await sealedFixture();
    database = fixture.database;
    const entry = fixture.verified.proofs[0]!;
    const local = await putActiveLocalSibling(fixture, entry, 3n);
    const preparedOperation = prepareDurableCustodyProofImport({
      scope: browserWalletScope(SEED),
      sourceOperationId: "sealed-reconcile-fence",
      normalizedMint: MINT,
      unit: "msat",
      inventoryAccountId: null,
      keysets: [
        {
          keysetId: KEYSET_ID,
          unit: "msat",
          curve: "secp256k1",
          publicKeys: { "1": PUBLIC_KEY },
          keysetExpiryMs: 20,
          requireDleq: false,
        },
      ],
      proofs: [entry.proof],
      inventoryAuthorityFingerprint: deriveDurableCustodyArtifactFingerprint({
        schemaVersion: 1,
        proofs: [
          {
            proofId: local.proofId,
            proofFingerprint: local.proofFingerprint,
            assetKind: local.assetKind,
            conditionId: local.conditionId,
            outcomeCollection: local.outcomeCollection,
            baseAsset: local.baseAsset,
          },
        ],
      }),
    });
    const operationId = preparedOperation.record.operation.operationId;
    await database.custodyProofBackupAuthorities.put(
      createBrowserProofBackupAuthorityRow(local, 2, entry.locator, operationId),
    );
    const successorAdmission = {
      scopeId: fixture.scopeId,
      operationId,
      admissionId: `proof-import:${operationId}`,
      proofRows: [{ proofId: local.proofId, expectedRevision: null, admittedRevision: 0 }],
    };
    const record = structuredClone(preparedOperation.record);
    record.revision = 1;
    record.operation.state = "reconciled";
    record.operation.result = {
      state: "applied",
      resultHandle: "reconciled-result",
      resultFingerprint: preparedOperation.artifacts.result.fingerprint,
      outputPlanFingerprint: record.operation.outputPlan.outputPlanFingerprint,
      exactResult: createDurableCustodyArtifactReference(
        `artifact:${operationId}:result`,
        preparedOperation.artifacts.result,
      ),
    };
    record.operation.proofStorage.lineage.selectedSuccessorProofIds = [local.proofId];
    record.operation.proofStorage.lineage.successorAdmission = successorAdmission;
    record.operation.proofStorage.pinReasons = ["pending-outbox"];
    record.operation.delivery = {
      deliveryKind: "outbox",
      deliveryId: "pending-delivery",
      exactPayload: createDurableCustodyArtifactReference(
        `artifact:${operationId}:delivery`,
        preparedOperation.artifacts.requestBody,
      ),
      expiresAtMs: null,
      state: "pending",
      receipt: null,
    };
    await database.custodyOperations.put({
      scopeId: fixture.scopeId,
      operationId,
      revision: record.revision,
      operationState: record.operation.state,
      nextAttemptAtMs: record.operation.retry.nextAttemptAtMs,
      estimatedBytes: 1,
      record,
    });

    await expect(admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input)).rejects.toThrow(
      /unfinished custody work/,
    );
    await expect(
      database.custodyProofs.get([fixture.scopeId, local.proofId]),
    ).resolves.toMatchObject({ selectability: "selectable", revision: 0 });
  });

  it("refuses an orphan active-work row for the exact creator operation", async () => {
    const fixture = await sealedFixture();
    database = fixture.database;
    const entry = fixture.verified.proofs[0]!;
    const local = await putActiveLocalSibling(fixture, entry, 3n);
    const operationId = "orphan-active-work-operation";
    await database.custodyProofBackupAuthorities.put(
      createBrowserProofBackupAuthorityRow(local, 2, entry.locator, operationId),
    );
    await database.custodyActiveWork.put({
      scopeId: fixture.scopeId,
      operationId,
      nextAttemptAtMs: 4,
      estimatedBytes: 1,
    });

    await expect(admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input)).rejects.toThrow(
      /unfinished custody work/,
    );
    await expect(
      database.custodyProofs.get([fixture.scopeId, local.proofId]),
    ).resolves.toMatchObject({ selectability: "selectable", revision: 0 });
  });

  it("refuses desired revision overflow without mutating the active proof", async () => {
    const fixture = await sealedFixture();
    database = fixture.database;
    const entry = fixture.verified.proofs[0]!;
    const local = await putActiveLocalSibling(fixture, entry, 18_446_744_073_709_551_615n);
    await expect(admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input)).rejects.toThrow(
      /uint64|revision/i,
    );
    await expect(
      database.custodyProofs.get([fixture.scopeId, local.proofId]),
    ).resolves.toMatchObject({ selectability: "selectable", revision: 0 });
    await expect(
      database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        encryptedWalletBackupV2LocalAssetKey(fixture.input.asset),
      ]),
    ).resolves.toMatchObject({
      custodyRevision: "18446744073709551615",
      activeProofCount: 1,
    });
  });

  it("allows only an exact idempotent replay", async () => {
    const fixture = await sealedFixture();
    database = fixture.database;
    await admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input);
    const beforeProofs = await database.custodyProofs.toArray();
    const beforeAuthorities = await database.custodyProofBackupAuthorities.toArray();
    const beforeDesired = await database.encryptedWalletBackupV2DesiredAssets.toArray();

    await admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input);

    expect(await database.custodyProofs.toArray()).toEqual(beforeProofs);
    expect(await database.custodyProofBackupAuthorities.toArray()).toEqual(beforeAuthorities);
    expect(await database.encryptedWalletBackupV2DesiredAssets.toArray()).toEqual(beforeDesired);
  });

  it("refuses a sealed proof with an exact completed-removal marker", async () => {
    const fixture = await sealedFixture();
    database = fixture.database;
    await putLegacyCache(fixture);
    const entry = fixture.verified.proofs[0]!;
    const marker = completedRemovalMarker(fixture, entry);
    await database.custodyProofBackupAuthorities.put(marker);

    await expect(admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input)).rejects.toThrow(
      /completed-removal/,
    );
    expect(await database.custodyProofs.count()).toBe(0);
    expect(await database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);
    expect(await database.walletCounterAssociations.count()).toBe(0);
    expect(await database.proofs.count()).toBe(2);
    await expect(
      database.custodyProofBackupAuthorities.get([fixture.scopeId, entry.proofId]),
    ).resolves.toEqual(marker);
  });

  it.each([false, true])(
    "refuses sealed admission with a removal intent when the local body is %s present",
    async (bodyPresent) => {
      const fixture = await sealedFixture();
      database = fixture.database;
      const entry = fixture.verified.proofs[0]!;
      const intent = removalIntentFor(fixture, entry);
      if (bodyPresent) {
        await admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input);
        const desired = (await database.encryptedWalletBackupV2DesiredAssets.toArray())[0]!;
        await database.encryptedWalletBackupV2DesiredAssets.put({
          ...desired,
          removalIntent: intent,
        });
      } else {
        const desired = createEncryptedWalletBackupV2DesiredAssetRow({
          scopeId: fixture.scopeId,
          asset: fixture.input.asset,
          custodyRevision: fixture.input.custodyRevision,
          activeProofCount: fixture.verified.proofs.length,
          terminalCtfContext: {
            conditionId: CTF_ASSET.conditionId,
            outcomeLabel: CTF_ASSET.outcomeLabel,
            outcomeCollectionId: CTF_ASSET.outcomeCollectionId,
            registeredAt: CTF_ASSET.registeredAt,
            finalExpiry: CTF_ASSET.finalExpiry,
          },
          removalIntent: intent,
        });
        await database.encryptedWalletBackupV2DesiredAssets.put({
          ...desired,
          syncState: "acknowledged",
        });
      }

      await expect(admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input)).rejects.toThrow(
        /desired authority conflicts/,
      );
      await expect(
        database.encryptedWalletBackupV2DesiredAssets.get([
          fixture.scopeId,
          encryptedWalletBackupV2LocalAssetKey(fixture.input.asset),
        ]),
      ).resolves.toMatchObject({ removalIntent: intent });
    },
  );

  it("admits a fresh asset when its keyset counter is shared with another asset", async () => {
    const fixture = await sealedFixture();
    database = fixture.database;
    await database.walletCounterAssociations.put({
      scopeId: fixture.scopeId,
      normalizedMint: MINT,
      unit: "msat",
      keysetId: KEYSET_ID,
      recoveryComplete: true,
    });
    await database.walletCounterCursors.put({
      scopeId: fixture.scopeId,
      keysetId: KEYSET_ID,
      next: 9,
    });

    await expect(
      admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input),
    ).resolves.toBeUndefined();
    expect(await database.custodyProofs.count()).toBe(2);
    expect(await database.walletCounterCursors.get([fixture.scopeId, KEYSET_ID])).toEqual({
      scopeId: fixture.scopeId,
      keysetId: KEYSET_ID,
      next: 9,
    });
  });

  it("rejects a full CTF tuple mismatch before writing any authority", async () => {
    const fixture = await sealedFixture({
      assets: [CTF_ASSET, { ...CTF_ASSET, finalExpiry: 21 }],
    });
    database = fixture.database;

    await expect(admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input)).rejects.toThrow(
      /CTF tuple conflicts/,
    );
    expect(await database.custodyProofs.count()).toBe(0);
    expect(await database.custodyProofBackupAuthorities.count()).toBe(0);
    expect(await database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);
    expect(await database.walletCounterAssociations.count()).toBe(0);
  });

  it.each(["selectable", "spent"] as const)(
    "rejects an existing canonical %s proof in the target asset",
    async (selectability) => {
      const fixture = await sealedFixture();
      database = fixture.database;
      const entry = fixture.verified.proofs[0]!;
      const row = createBrowserCustodyProofRow({
        scopeId: fixture.scopeId,
        normalizedMint: MINT,
        unit: "msat",
        proof: entry.proof,
        asset: { kind: "conditional", conditionId: CONDITION_ID, outcomeCollection: "YES" },
        receivedAtMs: 1_000,
      });
      await database.custodyProofs.put({ ...row, selectability, reservationOperationId: null });

      await expect(admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input)).rejects.toThrow(
        /local custody conflicts/,
      );
      expect(await database.custodyProofBackupAuthorities.count()).toBe(0);
      expect(await database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);
    },
  );

  it("rolls back proof, authority, desired context, counters, and cache together", async () => {
    const fixture = await sealedFixture();
    database = fixture.database;
    await putLegacyCache(fixture);

    await expect(
      admitBrowserEncryptedWalletBackupV2SealedAsset({
        ...fixture.input,
        fault: "before-commit",
      }),
    ).rejects.toThrow(/injected commit fault/);
    expect(await database.custodyProofs.count()).toBe(0);
    expect(await database.custodyProofBackupAuthorities.count()).toBe(0);
    expect(await database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);
    expect(await database.walletCounterAssociations.count()).toBe(0);
    expect(await database.walletCounterCursors.count()).toBe(0);
    expect(await database.proofs.count()).toBe(2);
    expect(await database.custodyScopes.count()).toBe(0);
  });

  it("fails closed when the desired state loses exact proof authority", async () => {
    const fixture = await sealedFixture();
    database = fixture.database;
    await admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input);
    await database.custodyProofBackupAuthorities.delete([
      fixture.scopeId,
      fixture.verified.proofs[0]!.proofId,
    ]);

    await expect(admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input)).rejects.toThrow(
      /authority is incomplete/,
    );
    expect(await database.custodyProofBackupAuthorities.count()).toBe(1);
  });

  it("fails closed when exact proof authority remains but desired state is lost", async () => {
    const fixture = await sealedFixture();
    database = fixture.database;
    await admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input);
    const desired = (await database.encryptedWalletBackupV2DesiredAssets.toArray())[0]!;
    await database.encryptedWalletBackupV2DesiredAssets.delete([
      fixture.scopeId,
      desired.localAssetKey,
    ]);

    await expect(admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input)).rejects.toThrow(
      /state is incomplete/,
    );
  });

  it("rejects a foreign same-secret legacy cache row", async () => {
    const fixture = await sealedFixture();
    database = fixture.database;
    const entry = fixture.verified.proofs[0]!;
    await database.proofs.put(
      storedProofRow({
        ...entry.proof,
        mintUrl: MINT,
        baseAsset: "sat",
        unit: "msat",
        conditionId: CONDITION_ID,
        outcomeCollection: "NO",
      }),
    );

    await expect(admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input)).rejects.toThrow(
      /legacy cache conflicts/,
    );
    expect(await database.custodyProofs.count()).toBe(0);
    expect(await database.custodyProofBackupAuthorities.count()).toBe(0);
    expect(await database.proofs.count()).toBe(1);
  });

  it("removes an exact stale cache row with an empty reservation marker", async () => {
    const fixture = await sealedFixture();
    database = fixture.database;
    const entry = fixture.verified.proofs[0]!;
    await database.proofs.put(
      storedProofRow({
        ...entry.proof,
        mintUrl: MINT,
        baseAsset: "sat",
        unit: "msat",
        conditionId: CONDITION_ID,
        outcomeCollection: "YES",
        reservedBy: "",
      }),
    );

    await admitBrowserEncryptedWalletBackupV2SealedAsset(fixture.input);
    expect(await database.proofs.get(entry.proof.secret)).toBeUndefined();

    activateBrowserWalletDatabase(fixture.scopeId);
    globalDatabaseActive = true;
    await expect(getProofs(MINT)).resolves.toHaveLength(0);
  });
});

async function sealedFixture(
  options: { readonly assets?: readonly EncryptedWalletBackupV2ProofSetAsset[] } = {},
) {
  const assets = options.assets ?? [CTF_ASSET, CTF_ASSET];
  const ctfAssets = assets.map((asset) => {
    if (asset.kind !== "ctf") throw new Error("test asset is not CTF");
    return asset;
  });
  const entries = ctfAssets.map((asset, index) => {
    const locator = {
      schemaVersion: 1 as const,
      kind: "ctf-range-manifest" as const,
      rangeOperationId: "range-operation",
      manifestIndex: index,
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
      C: PUBLIC_KEY,
    };
    const entry = {
      mintUrl: MINT,
      unit: "msat" as const,
      asset,
      proof,
      locator,
      proofId: deriveDurableCustodyProofId({
        scopeId: browserWalletScope(SEED).scopeId,
        normalizedMint: MINT,
        unit: "msat",
        keysetId: KEYSET_ID,
        secret: proof.secret,
      }),
    };
    return {
      ...entry,
      terminalSeal: {
        schemaVersion: 1 as const,
        kind: "ctf-verified-losing" as const,
        operationIdDigest: `${String(index + 1).padStart(2, "0")}`.repeat(32),
        requestDigest: `${String(index + 3).padStart(2, "0")}`.repeat(32),
        code: 13015 as const,
        classifiedAtMs: 1_000 + index,
        proofCommitment: digestEncryptedWalletBackupV2TerminalProofCommitment(entry),
      },
    };
  });
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: MINT,
    unit: "msat",
    asset: CTF_ASSET,
  });
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed: SEED,
    realm: "backup.production",
    runtime: { subtle: crypto.subtle },
  });
  const payload = encodeCanonicalBackupCbor([
    2,
    "encrypted-wallet-backup-v2-proof-set",
    entries.map((entry) => [
      entry.mintUrl,
      entry.unit,
      [
        1,
        entry.asset.conditionId,
        entry.asset.outcomeLabel,
        entry.asset.outcomeCollectionId,
        entry.asset.registeredAt,
        entry.asset.finalExpiry,
      ],
      serializeDurableCustodyProofArtifact(entry.proof),
      encodeDurableWalletProofDerivationLocatorCbor(entry.locator),
      [
        entry.terminalSeal.schemaVersion,
        entry.terminalSeal.kind,
        entry.terminalSeal.operationIdDigest,
        entry.terminalSeal.requestDigest,
        entry.terminalSeal.code,
        entry.terminalSeal.classifiedAtMs,
        entry.terminalSeal.proofCommitment,
      ],
    ]),
    [[MINT, "msat", KEYSET_ID, 5]],
  ]);
  const runtime = {
    subtle: crypto.subtle,
    getRandomValues: (target: Uint8Array) => crypto.getRandomValues(target),
  };
  const prepared = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    asset,
    declaredAmount: BigInt(entries.length),
    custodyRevision: 7n,
    canonicalPayload: payload,
    runtime,
  });
  const unverified = await decryptEncryptedWalletBackupV2ProofSetBundle({
    keyHandle,
    seed: SEED,
    expectedAsset: asset,
    custodyRevision: 7n,
    runtime,
    ...prepared,
  });
  const verified = await verifyEncryptedWalletBackupV2RestoredProofSet({
    seed: SEED,
    expectedAsset: asset,
    unverified,
    port: {
      resolveKeyset: async () => {
        throw new Error("mint keyset must not be requested");
      },
      verifyProofs: () => {
        throw new Error("mint proof verification must not be requested");
      },
      checkProofStates: async () => {
        throw new Error("NUT-07 must not be requested");
      },
    },
  });
  const head = createEncryptedWalletBackupV2CurrentHead({
    realm: keyHandle.realm,
    walletId: keyHandle.walletId,
    enrollmentEpoch: 1,
    headVersion: 1,
    bundles: [prepared.descriptor],
  });
  const collectedHeadEvidence = collectEncryptedWalletBackupV2DescriptorPages(
    enumerateEncryptedWalletBackupV2DescriptorPages({ head, bundles: [prepared.descriptor] }),
  );
  const scopeId = browserWalletScope(SEED).scopeId;
  const database = new BitcasterDB(browserWalletDatabaseName(scopeId));
  return {
    database,
    scopeId,
    verified,
    input: {
      seed: SEED,
      verified,
      asset,
      custodyRevision: 7n,
      sourceOperationId: "origin-loss-restore",
      collectedHeadEvidence,
      realm: keyHandle.realm,
      enrollmentEpoch: 1,
      database,
      scopeId,
      isCurrentProfile: () => true,
      lockManager: immediateLockManager(),
    },
  };
}

async function putLegacyCache(fixture: Awaited<ReturnType<typeof sealedFixture>>): Promise<void> {
  for (const entry of fixture.verified.proofs) {
    await fixture.database.proofs.put(
      storedProofRow({
        ...entry.proof,
        mintUrl: MINT,
        baseAsset: "sat",
        unit: "msat",
        conditionId: CONDITION_ID,
        outcomeCollection: "YES",
      }),
    );
  }
}

async function putActiveLocalSibling(
  fixture: Awaited<ReturnType<typeof sealedFixture>>,
  entry: Awaited<ReturnType<typeof sealedFixture>>["verified"]["proofs"][number],
  custodyRevision: bigint,
) {
  if (entry.asset.kind !== "ctf") throw new Error("test proof is not conditional");
  const local = createBrowserCustodyProofRow({
    scopeId: fixture.scopeId,
    normalizedMint: MINT,
    unit: "msat",
    proof: entry.proof,
    asset: {
      kind: "conditional",
      conditionId: entry.asset.conditionId,
      outcomeCollection: entry.asset.outcomeLabel,
    },
    receivedAtMs: 1,
  });
  await fixture.database.custodyProofs.put(local);
  await fixture.database.custodyProofBackupAuthorities.put(
    createBrowserProofBackupAuthorityRow(local, 2, entry.locator, "local-admission"),
  );
  await fixture.database.encryptedWalletBackupV2DesiredAssets.put({
    ...createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: fixture.scopeId,
      asset: fixture.input.asset,
      custodyRevision,
      activeProofCount: 1,
    }),
    syncState: "acknowledged",
  });
  return local;
}

function completedRemovalMarker(
  fixture: Awaited<ReturnType<typeof sealedFixture>>,
  entry: Awaited<ReturnType<typeof sealedFixture>>["verified"]["proofs"][number],
) {
  if (entry.asset.kind !== "ctf") throw new Error("test proof is not conditional");
  const proofRow = createBrowserCustodyProofRow({
    scopeId: fixture.scopeId,
    normalizedMint: MINT,
    unit: "msat",
    proof: entry.proof,
    asset: {
      kind: "conditional",
      conditionId: entry.asset.conditionId,
      outcomeCollection: entry.asset.outcomeLabel,
    },
    receivedAtMs: 1_000,
  });
  return createBrowserCompletedProofRemovalMarkerRow({
    scopeId: fixture.scopeId,
    proofId: entry.proofId,
    proofFingerprint: proofRow.proofFingerprint,
    proofRevision: proofRow.revision,
    proofCommitment: "11".repeat(32),
    localAssetKey: encryptedWalletBackupV2LocalAssetKey(fixture.input.asset),
    removalIntentId: "browser-v2-sealed-admission-marker",
    proofSetCommitment: "22".repeat(32),
    completionCustodyRevision: fixture.input.custodyRevision,
    realm: "development",
    walletId: deriveDurableCustodyWalletId(SEED),
    enrollmentEpoch: 1,
    acknowledgedHeadVersion: 1,
    acknowledgedActiveSetDigest: "33".repeat(32),
    acknowledgementKind: "current-head",
    receiptDigest: null,
    acknowledgedAtMs: 1_000,
    completedAtMs: 1_001,
  });
}

function removalIntentFor(
  fixture: Awaited<ReturnType<typeof sealedFixture>>,
  entry: Awaited<ReturnType<typeof sealedFixture>>["verified"]["proofs"][number],
) {
  if (entry.asset.kind !== "ctf") throw new Error("test proof is not conditional");
  const proofRow = createBrowserCustodyProofRow({
    scopeId: fixture.scopeId,
    normalizedMint: MINT,
    unit: "msat",
    proof: entry.proof,
    asset: {
      kind: "conditional",
      conditionId: entry.asset.conditionId,
      outcomeCollection: entry.asset.outcomeLabel,
    },
    receivedAtMs: 1_000,
  });
  return createEncryptedWalletBackupV2RemovalIntent({
    intentId: "browser-v2-sealed-removal-intent",
    createdAtMs: 1_000,
    realm: "development",
    walletId: deriveDurableCustodyWalletId(SEED),
    enrollmentEpoch: 1,
    expectedHeadVersion: 1,
    expectedActiveSetDigest: "33".repeat(32),
    targetCustodyRevision: fixture.input.custodyRevision,
    proofs: [
      {
        proofId: entry.proofId,
        proofFingerprint: proofRow.proofFingerprint,
        proofRevision: proofRow.revision,
        proofCommitment: "11".repeat(32),
      },
    ],
  });
}

function immediateLockManager(): Pick<LockManager, "request"> {
  return {
    request: async <T>(_name: string, _options: LockOptions, callback: LockGrantedCallback<T>) =>
      callback(null),
  } as Pick<LockManager, "request">;
}
