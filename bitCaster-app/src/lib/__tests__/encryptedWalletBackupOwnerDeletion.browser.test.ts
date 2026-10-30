import Dexie from "dexie";
import { Amount, deriveConditionalKeysetId, deriveKeysetId } from "@cashu/cashu-ts";
import { afterEach, expect, it } from "vitest";
import { createEncryptedWalletBackupV2AssetIdentity } from "@bitcaster/client-sdk";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import { deserializeDurableCustodyProofArtifact } from "@bitcaster/client-sdk/durableCustodyProofMaterial";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import { createEncryptedWalletBackupV2KeyHandle } from "@bitcaster/client-sdk/encryptedWalletBackupV2Keys";
import {
  collectEncryptedWalletBackupOwnerDescriptorPages,
  createEncryptedWalletBackupOwnerCurrentHead,
  enumerateEncryptedWalletBackupOwnerDescriptorPages,
} from "@bitcaster/client-sdk/encryptedWalletBackupOwnerHead";
import { digestEncryptedWalletBackupV2BundleDescriptor } from "@bitcaster/client-sdk/encryptedWalletBackupV2Descriptor";
import { digestEncryptedWalletBackupOwnerBundleSupersessionReceipt } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerReceipt";
import { BitcasterDB } from "../../stores/proof-db";
import { createBrowserCustodyProofRow } from "../../stores/durable-custody-db";
import { BrowserDurableCustodyAdapter } from "../../stores/durable-custody-db";
import { createBrowserProofBackupAuthorityRow } from "../../stores/browser-proof-backup-authority";
import { EncryptedWalletBackupOwnerDexieAuthorityStore } from "../../stores/encrypted-wallet-backup-owner-db";
import { browserWalletDatabaseName } from "../browserWalletProfile";
import { createEncryptedWalletBackupV2DesiredAssetRow } from "../../stores/browser-encrypted-wallet-backup-v2-desired-asset";
import { retryBrowserEncryptedWalletBackupV2QuotaWrite } from "../browserEncryptedWalletBackupV2QuotaCleanup";
import { handoffBrowserEncryptedWalletBackupV2Seed } from "../browserEncryptedWalletBackupV2SeedHandoff";
import { ownerReachabilitySnapshot } from "./ownerReachabilityFixture";
import { commitBrowserCtfTerminalOperation } from "../../test/browserEncryptedWalletBackupV2CommittedTerminalFixture";
import { BROWSER_D4_CONDITION } from "../../test/browserD4OracleFixture";
import { startBrowserCtfRemove } from "../browserCtfRemoveCoordinator";

const REALM = "backup.example";
const OWNER_SCOPE_ID = "ab".repeat(32);
const MINT_URL = "https://mint.example";
const GENERATOR = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const KEYSET_ID = deriveKeysetId({ "1": GENERATOR }, { unit: "msat", versionByte: 1 });
const OPEN_DATABASES: BitcasterDB[] = [];
const DATABASE_NAMES: string[] = [];

afterEach(async () => {
  for (const database of OPEN_DATABASES.splice(0)) database.close();
  await Promise.all(DATABASE_NAMES.splice(0).map((name) => Dexie.delete(name)));
});

it("evicts after a real quota retry when a later selected-owner head retains the exact descriptor", async () => {
  expect(Dexie.dependencies.indexedDB).toBe(window.indexedDB);
  const fixture = await createFixture({ currentHeadVersion: 2, currentBundles: "retained" });
  const writes: string[] = [];

  const result = await retryBrowserEncryptedWalletBackupV2QuotaWrite({
    database: fixture.database,
    scopeId: fixture.scopeId,
    ownerScopeId: OWNER_SCOPE_ID,
    ownerAuthorityStore: fixture.store,
    isCurrentProfile: () => true,
    loadCurrentOwnerReachabilityEvidence: async () => fixture.currentReachability(),
    write: async () => {
      writes.push("attempt");
      if (writes.length === 1) throw quotaError();
      return "persisted";
    },
  });

  expect(result).toEqual({
    result: "persisted",
    evictedLocalAssetKey: fixture.desired.localAssetKey,
  });
  expect(writes).toHaveLength(2);
  expect(
    await fixture.database.custodyProofs.get([fixture.scopeId, fixture.proof.proofId]),
  ).toBeUndefined();
  expect(await fixture.database.encryptedWalletBackupOwnerAssetReceipts.count()).toBe(1);
});

it("preserves local proof bytes when a higher selected-owner head excludes the receipt descriptor", async () => {
  expect(Dexie.dependencies.indexedDB).toBe(window.indexedDB);
  const fixture = await createFixture({ currentHeadVersion: 2, currentBundles: "excluded" });
  const quota = quotaError();
  const before = await localProofSnapshot(fixture);
  let writes = 0;

  await expect(
    retryBrowserEncryptedWalletBackupV2QuotaWrite({
      database: fixture.database,
      scopeId: fixture.scopeId,
      ownerScopeId: OWNER_SCOPE_ID,
      ownerAuthorityStore: fixture.store,
      isCurrentProfile: () => true,
      loadCurrentOwnerReachabilityEvidence: async () => fixture.currentReachability(),
      write: async () => {
        writes += 1;
        throw quota;
      },
    }),
  ).rejects.toBe(quota);

  expect(writes).toBe(1);
  expect(await localProofSnapshot(fixture)).toEqual(before);
});

it("activates a new seed only after current owner receipt evidence survives a later retained head", async () => {
  expect(Dexie.dependencies.indexedDB).toBe(window.indexedDB);
  const fixture = await createFixture({ currentHeadVersion: 2, currentBundles: "retained" });
  let invalidated = false;
  let activated = false;
  let restored = false;

  await handoffBrowserEncryptedWalletBackupV2Seed({
    database: fixture.database,
    scopeId: fixture.scopeId,
    ownerScopeId: OWNER_SCOPE_ID,
    ownerAuthorityStore: fixture.store,
    isCurrentProfile: () => true,
    assertNoPendingOrders: () => undefined,
    loadCurrentOwnerReachabilityEvidence: async () => fixture.currentReachability(),
    invalidateOldProfile: () => {
      invalidated = true;
    },
    activateNewProfile: async () => {
      activated = true;
    },
    restoreOldProfile: async () => {
      restored = true;
    },
  });

  expect({ invalidated, activated, restored }).toEqual({
    invalidated: true,
    activated: true,
    restored: false,
  });
  expect(await Dexie.exists(fixture.databaseName)).toBe(false);
});

it("refuses seed handoff when the higher selected-owner head no longer contains the signed descriptor", async () => {
  expect(Dexie.dependencies.indexedDB).toBe(window.indexedDB);
  const fixture = await createFixture({ currentHeadVersion: 2, currentBundles: "excluded" });
  const before = await localProofSnapshot(fixture);
  let invalidated = false;
  let activated = false;

  await expect(
    handoffBrowserEncryptedWalletBackupV2Seed({
      database: fixture.database,
      scopeId: fixture.scopeId,
      ownerScopeId: OWNER_SCOPE_ID,
      ownerAuthorityStore: fixture.store,
      isCurrentProfile: () => true,
      assertNoPendingOrders: () => undefined,
      loadCurrentOwnerReachabilityEvidence: async () => fixture.currentReachability(),
      invalidateOldProfile: () => {
        invalidated = true;
      },
      activateNewProfile: async () => {
        activated = true;
      },
      restoreOldProfile: async () => undefined,
    }),
  ).rejects.toThrow(/uncovered desired assets/);

  expect(invalidated).toBe(false);
  expect(activated).toBe(false);
  expect(await localProofSnapshot(fixture)).toEqual(before);
  expect(await Dexie.exists(fixture.databaseName)).toBe(true);
});

it("keeps committed local terminal cleanup independent of owner backup receipts", async () => {
  expect(Dexie.dependencies.indexedDB).toBe(window.indexedDB);
  const seed = new Uint8Array(64).fill(19);
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed,
    realm: REALM,
    runtime: { subtle: crypto.subtle },
  });
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: "wallet",
    walletId: keyHandle.walletId,
  });
  const databaseName = browserWalletDatabaseName(scopeId);
  DATABASE_NAMES.push(databaseName);
  const database = new BitcasterDB(databaseName);
  OPEN_DATABASES.push(database);
  await database.open();
  const scope = { scopeKind: "wallet" as const, walletId: keyHandle.walletId, scopeId };
  const adapter = new BrowserDurableCustodyAdapter(database);
  const owner = await adapter.claimScope(scope, {
    incarnationId: "owner-independent-terminal-test",
    observedAtMs: 1_000,
    leaseExpiresAtMs: 10_000,
  });
  const outcomeCollectionId = deriveRootCtfOutcomeCollectionId({
    conditionId: BROWSER_D4_CONDITION,
    outcomeCollection: "YES",
  });
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: MINT_URL,
    unit: "msat",
    asset: {
      kind: "ctf",
      conditionId: BROWSER_D4_CONDITION,
      outcomeLabel: "YES",
      outcomeCollectionId,
      registeredAt: 1,
      finalExpiry: 2,
    },
  });
  const conditionalKeysetId = deriveConditionalKeysetId({
    keys: { "1": GENERATOR },
    unit: "msat",
    input_fee_ppk: 0,
    final_expiry: 2,
    conditionId: BROWSER_D4_CONDITION,
    outcomeCollectionId,
  });
  const row = createBrowserCustodyProofRow({
    scopeId,
    normalizedMint: MINT_URL,
    unit: "msat",
    proof: {
      id: conditionalKeysetId,
      amount: Amount.from(1),
      secret: "terminal-cleanup-proof-secret",
      C: GENERATOR,
    },
    asset: { kind: "conditional", conditionId: BROWSER_D4_CONDITION, outcomeCollection: "YES" },
    receivedAtMs: 900,
  });
  await database.custodyProofs.put(row);
  await database.custodyProofBackupAuthorities.put(
    createBrowserProofBackupAuthorityRow(row, 1_000, null, "terminal-cleanup-admission"),
  );
  await database.proofs.put({
    id: row.keysetId,
    amount: 1,
    secret: "terminal-cleanup-proof-secret",
    C: GENERATOR,
    mintUrl: MINT_URL,
    unit: "msat",
    conditionId: BROWSER_D4_CONDITION,
    outcomeCollection: "YES",
  });
  await database.custodyConditionalKeysets.put({
    schemaVersion: 1,
    scopeId,
    normalizedMint: MINT_URL,
    unit: "msat",
    keysetId: row.keysetId,
    denominationPublicKeys: { "1": GENERATOR },
    inputFeePpk: 0,
    conditionId: BROWSER_D4_CONDITION,
    outcomeCollection: "YES",
    outcomeCollectionId,
    registeredAtUnixSeconds: 1,
    finalExpiryUnixSeconds: 2,
    curve: "secp256k1",
  });
  const proofMaterial = deserializeDurableCustodyProofArtifact(
    JSON.parse(new TextDecoder().decode(row.proofBody)),
  );
  const terminal = await commitBrowserCtfTerminalOperation({
    adapter,
    database,
    scope,
    owner: { ...owner, observedAtMs: 1_500 },
    operationId: "ctf-terminal-cleanup-independent",
    mintUrl: MINT_URL,
    proofs: [proofMaterial as never],
    predecessorProofs: [row],
    publicKey: GENERATOR,
    classifiedAtMs: 2_000,
  });
  const terminalAuthority = await database.custodyProofBackupAuthorities.get([
    scopeId,
    row.proofId,
  ]);
  expect(terminalAuthority).toMatchObject({
    backupState: "local-only",
    proofState: "verified-losing",
    terminalOperationId: terminal.operationId,
    terminalAuthority: { kind: "local-operation", operationId: terminal.operationId },
  });
  expect(await database.encryptedWalletBackupOwnerAssetReceipts.count()).toBe(0);
  const classifiedProof = await database.custodyProofs.get([scopeId, row.proofId]);
  if (classifiedProof === undefined) throw new Error("committed terminal proof is missing");

  await expect(
    startBrowserCtfRemove({
      database,
      scopeId,
      asset,
      targets: [
        {
          proofId: classifiedProof.proofId,
          proofFingerprint: classifiedProof.proofFingerprint,
          proofRevision: classifiedProof.revision,
        },
      ],
      observedAtMs: 3_000,
      isCurrentProfile: () => true,
    }),
  ).resolves.toMatchObject({ kind: "completed" });

  expect(await database.custodyProofs.get([scopeId, row.proofId])).toBeUndefined();
  expect(await database.custodyProofBackupAuthorities.get([scopeId, row.proofId])).toMatchObject({
    recordKind: "completed-local-removal",
    terminalOperationId: terminal.operationId,
  });
  expect(await database.encryptedWalletBackupOwnerAssetReceipts.count()).toBe(0);
});

function quotaError(): Error {
  return Object.assign(new Error("quota"), { name: "QuotaExceededError" });
}

async function localProofSnapshot(fixture: {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly proof: { readonly proofId: string };
  readonly secret: string;
  readonly desired: { readonly localAssetKey: string };
}) {
  return {
    custodyProof: await fixture.database.custodyProofs.get([
      fixture.scopeId,
      fixture.proof.proofId,
    ]),
    backupAuthority: await fixture.database.custodyProofBackupAuthorities.get([
      fixture.scopeId,
      fixture.proof.proofId,
    ]),
    legacyProof: await fixture.database.proofs.get(fixture.secret),
    legacyDesired: await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
      fixture.scopeId,
      fixture.desired.localAssetKey,
    ]),
  };
}

async function createFixture(input: {
  currentHeadVersion: number;
  currentBundles: "retained" | "excluded";
}) {
  const seed = window.crypto.getRandomValues(new Uint8Array(64));
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed,
    realm: REALM,
    runtime: { subtle: crypto.subtle },
  });
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: "wallet",
    walletId: keyHandle.walletId,
  });
  const databaseName = browserWalletDatabaseName(scopeId);
  DATABASE_NAMES.push(databaseName);
  const database = new BitcasterDB(databaseName);
  OPEN_DATABASES.push(database);
  await database.open();

  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: MINT_URL,
    unit: "msat",
    asset: { kind: "ordinary" },
  });
  const desired = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId,
    asset,
    custodyRevision: 1n,
    activeProofCount: 1,
  });
  const secret = `browser-owner-proof-${scopeId.slice(0, 12)}`;
  const proof = createBrowserCustodyProofRow({
    scopeId,
    normalizedMint: MINT_URL,
    unit: "msat",
    proof: { id: KEYSET_ID, amount: Amount.from(1), secret, C: `02${"33".repeat(32)}` },
    asset: { kind: "regular" },
    receivedAtMs: 10,
  });
  await database.custodyProofs.put(proof);
  await database.custodyProofBackupAuthorities.put({
    schemaVersion: 4,
    scopeId,
    proofId: proof.proofId,
    proofFingerprint: proof.proofFingerprint,
    proofRevision: proof.revision,
    proofState: proof.selectability,
    terminalOperationId: null,
    terminalAuthority: null,
    recordCreatedAtUnixSeconds: 1,
    recordUpdatedAtUnixSeconds: 1,
    derivationLocator: null,
    updatedAtMs: 10,
    admissionOperationId: null,
    backupState: "remote-backed",
    backupRecordId: proof.proofId,
    backupRecordCommitment: "aa".repeat(32),
  });
  await database.proofs.put({
    id: KEYSET_ID,
    amount: 1,
    secret,
    C: `02${"33".repeat(32)}`,
    mintUrl: MINT_URL,
  });
  await database.encryptedWalletBackupV2DesiredAssets.put(desired);

  const descriptor = {
    formatVersion: 2 as const,
    realm: REALM,
    walletId: keyHandle.walletId,
    bundleId: "11".repeat(16),
    assetLocator: "22".repeat(32),
    declaredAmount: 1n,
    custodyRevision: 1n,
    payloadCommitment: "33".repeat(32),
    objects: [{ objectId: "44".repeat(16), digest: "55".repeat(32) }],
  };
  const context = {
    ownerScopeId: OWNER_SCOPE_ID,
    realm: REALM,
    walletId: keyHandle.walletId,
    enrollmentEpoch: 1,
  };
  const store = new EncryptedWalletBackupOwnerDexieAuthorityStore({
    database,
    scopeId,
    ...context,
    requestAuthPublicKey: keyHandle.requestAuthPublicKey,
    isCurrent: () => true,
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
  await store.acceptCurrentHead({ expectedHeadVersion: null, evidence: emptyHead });
  const signedReceipt = await ownerReachabilitySnapshot({
    ownerScopeId: OWNER_SCOPE_ID,
    descriptor,
    enrollmentEpoch: 1,
    keyHandle,
  });
  const currentBundles = input.currentBundles === "retained" ? [descriptor] : [];
  const currentHead = collectEncryptedWalletBackupOwnerDescriptorPages(
    enumerateEncryptedWalletBackupOwnerDescriptorPages({
      head: createEncryptedWalletBackupOwnerCurrentHead({
        ...context,
        headVersion: input.currentHeadVersion,
        bundles: currentBundles,
      }),
      bundles: currentBundles,
    }),
    context,
  );
  expect(
    await store.acceptCurrentHead({
      expectedHeadVersion: 0,
      evidence: currentHead,
    }),
  ).toBe("accepted");
  await database.encryptedWalletBackupOwnerAssetReceipts.put({
    scopeId,
    ownerScopeId: OWNER_SCOPE_ID,
    realm: REALM,
    walletId: keyHandle.walletId,
    enrollmentEpoch: 1,
    localAssetKey: desired.localAssetKey,
    assetLocator: descriptor.assetLocator,
    custodyRevision: "1",
    bundleId: descriptor.bundleId,
    bundleDescriptorDigest: digestEncryptedWalletBackupV2BundleDescriptor(descriptor),
    canonicalSignedMutation: signedReceipt.canonicalSignedMutation,
    canonicalSignedReceipt: signedReceipt.canonicalSignedReceipt,
  });
  await database.encryptedWalletBackupOwnerDesiredAssets.put({
    scopeId,
    ownerScopeId: OWNER_SCOPE_ID,
    realm: REALM,
    walletId: keyHandle.walletId,
    enrollmentEpoch: 1,
    localAssetKey: desired.localAssetKey,
    assetLocator: descriptor.assetLocator,
    custodyRevision: "1",
    desiredAction: "replace",
    activeProofCount: 1,
    syncState: "acknowledged",
    lastObservedHeadVersion: 1,
    receiptDigest: digestEncryptedWalletBackupOwnerBundleSupersessionReceipt(signedReceipt.receipt),
  });

  return {
    database,
    databaseName,
    scopeId,
    proof,
    secret,
    desired,
    store,
    currentReachability: async () => {
      const snapshot = await store.captureBackupReceiptForLocalAsset(desired.localAssetKey);
      if (snapshot === null) throw new Error("signed owner receipt was not captured");
      const reachability = await ownerReachabilitySnapshot({
        ownerScopeId: OWNER_SCOPE_ID,
        descriptor,
        enrollmentEpoch: 1,
        keyHandle,
        currentHeadVersion: input.currentHeadVersion,
        currentBundles,
      });
      return { ...reachability, backupReceiptSnapshot: snapshot };
    },
  };
}
