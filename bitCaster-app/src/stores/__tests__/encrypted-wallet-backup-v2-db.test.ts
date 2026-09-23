// @vitest-environment node
import "fake-indexeddb/auto";
import Dexie from "dexie";
import { schnorr } from "@noble/curves/secp256k1.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectEncryptedWalletBackupV2DescriptorPages,
  createEncryptedWalletBackupV2AssetIdentity,
  createEncryptedWalletBackupV2CurrentHead,
  createEncryptedWalletBackupV2KeyHandle,
  decodeEncryptedWalletBackupV2UploadGroup,
  encodeEncryptedWalletBackupV2BundleSupersessionReceipt,
  encodeEncryptedWalletBackupV2CurrentHead,
  encodeEncryptedWalletBackupV2SignedBundleSupersessionMutationWire,
  encodeEncryptedWalletBackupV2UploadGroup,
  enumerateEncryptedWalletBackupV2DescriptorPages,
  issueEncryptedWalletBackupV2BundleSupersessionReceipt,
  prepareEncryptedWalletBackupV2BundleSupersessionMutation,
  prepareEncryptedWalletBackupV2TransportBundle,
  verifyEncryptedWalletBackupV2BundleSupersessionReceipt,
} from "@bitcaster/client-sdk";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import { encodeCanonicalBackupCbor } from "@bitcaster/client-sdk/encryptedWalletBackupCbor";
import { browserWalletDatabaseName } from "../../lib/browserWalletProfile";
import {
  createEncryptedWalletBackupV2DesiredAssetRow,
  createEncryptedWalletBackupV2RemovalIntent,
} from "../browser-encrypted-wallet-backup-v2-desired-asset";
import { EncryptedWalletBackupV2DexieAuthorityStore } from "../encrypted-wallet-backup-v2-db";
import { BitcasterDB } from "../proof-db";

const REALM = "backup.example";
const SIGNING_KEY_ID = "55".repeat(16);
const SIGNING_PRIVATE_KEY = fromHex("03".repeat(32));
const SIGNING_PUBLIC_KEY = toHex(schnorr.getPublicKey(SIGNING_PRIVATE_KEY));
const openDatabases: BitcasterDB[] = [];
let sequence = 0;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const database of openDatabases.splice(0)) {
    database.close();
    await database.delete();
  }
});

describe("encrypted wallet backup V2 Dexie authority", () => {
  it("persists one exact prepared mutation only while desired state and head match", async () => {
    const fixture = await preparedFixture();
    await expect(
      fixture.store.insertPreparedMutationForDesired({
        prepared: { ...fixture.insert.prepared, assetLocator: "ff".repeat(32) },
        desired: { ...fixture.insert.desired, assetLocator: "ff".repeat(32) },
      }),
    ).rejects.toThrow(/prepared asset binding is invalid/);
    await expect(fixture.store.insertPreparedMutationForDesired(fixture.insert)).resolves.toBe(
      "inserted",
    );
    await expect(fixture.store.insertPreparedMutationForDesired(fixture.insert)).resolves.toBe(
      "existing",
    );

    await fixture.database.encryptedWalletBackupV2DesiredAssets.put({
      ...fixture.desired,
      custodyRevision: "2",
    });
    await expect(fixture.store.insertPreparedMutationForDesired(fixture.insert)).resolves.toBe(
      "stale-desired",
    );
    expect((await fixture.store.readPreparedMutation())?.canonicalUploadGroup).toEqual(
      fixture.group,
    );

    await fixture.database.encryptedWalletBackupV2DesiredAssets.put({
      ...fixture.desired,
      activeProofCount: -1,
    });
    await expect(fixture.store.insertPreparedMutationForDesired(fixture.insert)).rejects.toThrow();

    await fixture.database.encryptedWalletBackupV2DesiredAssets.delete([
      fixture.scopeId,
      fixture.desired.localAssetKey,
    ]);
    await expect(fixture.store.insertPreparedMutationForDesired(fixture.insert)).rejects.toThrow();
  });

  it("accepts a complete competing head and deletes only the exact stale prepared row", async () => {
    const fixture = await preparedFixture();
    await fixture.store.insertPreparedMutationForDesired(fixture.insert);

    await expect(
      fixture.store.acceptCompetingHead({
        collectedHeadEvidence: fixture.resultEvidence,
        stalePreparedMutation: {
          mutationId: fixture.insert.prepared.mutationId,
          requestDigest: "aa".repeat(32),
        },
      }),
    ).resolves.toEqual({ deletedStalePreparedMutation: false });
    expect(await fixture.store.readPreparedMutation()).not.toBeNull();

    await expect(
      fixture.store.acceptCompetingHead({
        collectedHeadEvidence: fixture.resultEvidence,
        stalePreparedMutation: fixture.insert.prepared,
      }),
    ).resolves.toEqual({ deletedStalePreparedMutation: true });
    expect(await fixture.store.readPreparedMutation()).toBeNull();
    expect((await fixture.store.listActiveDescriptors()).map(({ bundleId }) => bundleId)).toEqual([
      fixture.bundle.descriptor.bundleId,
    ]);
  });

  it("persists conflict refusal while retaining the predecessor, desired, and prepared state", async () => {
    const fixture = await preparedFixture();
    await fixture.store.insertPreparedMutationForDesired(fixture.insert);
    const beforeDesired = await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
      fixture.scopeId,
      fixture.desired.localAssetKey,
    ]);

    await expect(
      fixture.store.markCompetingHeadRecoveryRequired({
        collectedHeadEvidence: fixture.resultEvidence,
      }),
    ).resolves.toEqual({
      localRecoveryStatus: "recovery-required",
      localRecoveryReason: "genuine-conflict",
      localRecoveryVersion: 1,
    });

    const accepted = await fixture.store.readAcceptedHead();
    expect(accepted).toMatchObject({
      headVersion: fixture.emptyHead.headVersion,
      localRecoveryStatus: "recovery-required",
      localRecoveryReason: "genuine-conflict",
      localRecoveryVersion: 1,
    });
    expect(accepted?.canonicalCurrentHead).toEqual(
      encodeEncryptedWalletBackupV2CurrentHead(fixture.emptyHead),
    );
    expect(await fixture.store.readPreparedMutation()).not.toBeNull();
    expect(
      await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        fixture.desired.localAssetKey,
      ]),
    ).toEqual(beforeDesired);
  });

  it("accepts an authenticated recovered head after one local transaction recheck", async () => {
    const fixture = await preparedFixture();
    await fixture.store.markCompetingHeadRecoveryRequired({
      collectedHeadEvidence: fixture.resultEvidence,
    });
    let transactionTables: readonly string[] = [];

    await expect(
      fixture.store.acceptRecoveredHead({
        collectedHeadEvidence: fixture.resultEvidence,
        expectedRecoveryVersion: 1,
        recheckLocalState: async (context) => {
          transactionTables = [...(Dexie.currentTransaction?.storeNames ?? [])].sort();
          expect(context.scopeId).toBe(fixture.scopeId);
          expect(context.currentAcceptedHead).toMatchObject({
            headVersion: 0,
            localRecoveryStatus: "recovery-required",
          });
          expect(context.recoveredAcceptedHead.headVersion).toBe(1);
          await Promise.all(
            recoveryAcceptanceTables(context.database).map((table) => table.count()),
          );
          return true;
        },
      }),
    ).resolves.toEqual({
      localRecoveryStatus: "ready",
      localRecoveryReason: "none",
      localRecoveryVersion: 2,
    });

    expect(transactionTables).toEqual(
      recoveryAcceptanceTables(fixture.database)
        .map(({ name }) => name)
        .sort(),
    );
    expect(await fixture.store.readAcceptedHead()).toMatchObject({
      headVersion: 1,
      localRecoveryStatus: "ready",
      localRecoveryVersion: 2,
    });
    expect((await fixture.store.listActiveDescriptors()).map(({ bundleId }) => bundleId)).toEqual([
      fixture.bundle.descriptor.bundleId,
    ]);
  });

  it("keeps recovery refused while an exact prepared mutation is unresolved", async () => {
    const fixture = await preparedFixture();
    await fixture.store.insertPreparedMutationForDesired(fixture.insert);
    await fixture.store.markCompetingHeadRecoveryRequired({
      collectedHeadEvidence: fixture.resultEvidence,
    });
    const recheckLocalState = vi.fn(() => true);

    await expect(
      fixture.store.acceptRecoveredHead({
        collectedHeadEvidence: fixture.resultEvidence,
        expectedRecoveryVersion: 1,
        recheckLocalState,
      }),
    ).rejects.toThrow(/prepared mutation/);

    expect(recheckLocalState).not.toHaveBeenCalled();
    expect(await fixture.store.readPreparedMutation()).not.toBeNull();
    expect(await fixture.store.readAcceptedHead()).toMatchObject({
      headVersion: 0,
      localRecoveryStatus: "recovery-required",
      localRecoveryVersion: 1,
    });
  });

  it("keeps the recovered authority unaccepted when the local predicate fails", async () => {
    const fixture = await preparedFixture();
    await fixture.store.markCompetingHeadRecoveryRequired({
      collectedHeadEvidence: fixture.resultEvidence,
    });

    await expect(
      fixture.store.acceptRecoveredHead({
        collectedHeadEvidence: fixture.resultEvidence,
        expectedRecoveryVersion: 1,
        recheckLocalState: () => false,
      }),
    ).rejects.toThrow(/recovery is incomplete/);

    expect(await fixture.store.readAcceptedHead()).toMatchObject({
      headVersion: 0,
      localRecoveryStatus: "recovery-required",
    });
    expect(await fixture.store.listActiveDescriptors()).toEqual([]);
  });

  it("rolls the recovered head back when descriptor replacement fails", async () => {
    const fixture = await preparedFixture();
    await fixture.store.markCompetingHeadRecoveryRequired({
      collectedHeadEvidence: fixture.resultEvidence,
    });
    vi.spyOn(
      fixture.database.encryptedWalletBackupV2ActiveDescriptors,
      "bulkAdd",
    ).mockRejectedValueOnce(new Error("local quota"));

    await expect(
      fixture.store.acceptRecoveredHead({
        collectedHeadEvidence: fixture.resultEvidence,
        expectedRecoveryVersion: 1,
        recheckLocalState: () => true,
      }),
    ).rejects.toThrow(/local quota/);

    expect(await fixture.store.readAcceptedHead()).toMatchObject({
      headVersion: 0,
      localRecoveryStatus: "recovery-required",
      localRecoveryVersion: 1,
    });
    expect(await fixture.store.listActiveDescriptors()).toEqual([]);
  });

  it("rolls back when the recovery version changes during the local recheck", async () => {
    const fixture = await preparedFixture();
    await fixture.store.markCompetingHeadRecoveryRequired({
      collectedHeadEvidence: fixture.resultEvidence,
    });

    await expect(
      fixture.store.acceptRecoveredHead({
        collectedHeadEvidence: fixture.resultEvidence,
        expectedRecoveryVersion: 1,
        recheckLocalState: async ({ database, currentAcceptedHead }) => {
          await database.encryptedWalletBackupV2AcceptedHeads.put({
            ...currentAcceptedHead,
            localRecoveryVersion: 2,
          });
          return true;
        },
      }),
    ).rejects.toThrow(/recovery status is stale/);

    expect(await fixture.store.readAcceptedHead()).toMatchObject({
      headVersion: 0,
      localRecoveryStatus: "recovery-required",
      localRecoveryVersion: 1,
    });
  });

  it("does not requeue an acknowledged desired asset when recovery succeeds", async () => {
    const fixture = await preparedFixture();
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put({
      ...fixture.desired,
      syncState: "acknowledged",
    });
    await fixture.store.markCompetingHeadRecoveryRequired({
      collectedHeadEvidence: fixture.resultEvidence,
    });

    await fixture.store.acceptRecoveredHead({
      collectedHeadEvidence: fixture.resultEvidence,
      expectedRecoveryVersion: 1,
      recheckLocalState: () => true,
    });

    expect(
      await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        fixture.desired.localAssetKey,
      ]),
    ).toMatchObject({ syncState: "acknowledged" });
  });

  it("rejects malformed local recovery fields before exposing an accepted head", async () => {
    const fixture = await preparedFixture();
    const row = await fixture.database.encryptedWalletBackupV2AcceptedHeads.get([
      fixture.scopeId,
      REALM,
      fixture.keyHandle.walletId,
      1,
    ]);
    if (row === undefined) throw new Error("missing accepted head fixture");
    await fixture.database.encryptedWalletBackupV2AcceptedHeads.put({
      ...row,
      localRecoveryStatus: "unexpected",
    } as never);
    await expect(fixture.store.readAcceptedHead()).rejects.toThrow(
      /local recovery status is invalid/,
    );
  });

  it("commits the exact per-asset receipt and rolls every authority row back on failure", async () => {
    const fixture = await preparedFixture();
    await fixture.store.insertPreparedMutationForDesired(fixture.insert);
    const receipt = await receiptFixture(fixture);
    await expect(
      fixture.store.commitVerifiedAssetReceipt({
        ...receipt,
        binding: { ...receipt.binding, custodyRevision: "2" },
      }),
    ).rejects.toThrow(/prepared receipt binding is invalid/);
    vi.spyOn(
      fixture.database.encryptedWalletBackupV2ActiveDescriptors,
      "put",
    ).mockRejectedValueOnce(new Error("local quota"));

    await expect(fixture.store.commitVerifiedAssetReceipt(receipt)).rejects.toThrow(/local quota/);
    expect(await fixture.store.readPreparedMutation()).not.toBeNull();
    expect(await fixture.store.readAssetReceipt(fixture.desired.localAssetKey)).toBeNull();
    expect((await fixture.store.readAcceptedHead())?.headVersion).toBe(0);

    await fixture.store.commitVerifiedAssetReceipt(receipt);
    const stored = await fixture.store.readAssetReceipt(fixture.desired.localAssetKey);
    expect(stored?.custodyRevision).toBe("1");
    expect(stored?.bundleId).toBe(fixture.bundle.descriptor.bundleId);
    expect(await fixture.store.readPreparedMutation()).toBeNull();
    expect((await fixture.store.readAcceptedHead())?.headVersion).toBe(1);
    expect(
      await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        fixture.desired.localAssetKey,
      ]),
    ).toMatchObject({ syncState: "acknowledged" });
  });

  it("commits an ordinary receipt while retaining a newer pending desired row", async () => {
    const fixture = await preparedFixture();
    await fixture.store.insertPreparedMutationForDesired(fixture.insert);
    const receipt = await receiptFixture(fixture);
    const newer = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: fixture.scopeId,
      asset: fixture.asset,
      custodyRevision: 2n,
      activeProofCount: 1,
    });
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put(newer);

    await expect(fixture.store.commitVerifiedAssetReceipt(receipt)).resolves.toBeUndefined();

    expect((await fixture.store.readAcceptedHead())?.headVersion).toBe(1);
    expect(await fixture.store.readPreparedMutation()).toBeNull();
    expect(
      await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        fixture.desired.localAssetKey,
      ]),
    ).toEqual(newer);
  });

  it("commits an ordinary receipt when its desired row disappeared", async () => {
    const fixture = await preparedFixture();
    await fixture.store.insertPreparedMutationForDesired(fixture.insert);
    const receipt = await receiptFixture(fixture);
    await fixture.database.encryptedWalletBackupV2DesiredAssets.delete([
      fixture.scopeId,
      fixture.desired.localAssetKey,
    ]);

    await expect(fixture.store.commitVerifiedAssetReceipt(receipt)).resolves.toBeUndefined();

    expect((await fixture.store.readAcceptedHead())?.headVersion).toBe(1);
    expect(await fixture.store.readPreparedMutation()).toBeNull();
    expect(
      await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        fixture.desired.localAssetKey,
      ]),
    ).toBeUndefined();
  });

  it("retains and acknowledges an explicit removal intent from an exact receipt", async () => {
    const fixture = await preparedFixture(ctfAsset());
    const intent = removalIntentFor(fixture);
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put({
      ...fixture.desired,
      removalIntent: intent,
    });
    await fixture.store.insertPreparedMutationForDesired(fixture.insert);
    const receipt = await receiptFixture(fixture);

    await fixture.store.commitVerifiedAssetReceipt({ ...receipt, acknowledgedAtMs: 2_000 });

    const desired = await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
      fixture.scopeId,
      fixture.desired.localAssetKey,
    ]);
    expect(desired).toMatchObject({
      syncState: "acknowledged",
      removalIntent: {
        state: "exclusion-acknowledged",
        acknowledgedExclusionEvidence: {
          kind: "receipt",
          headVersion: 1,
          acknowledgedAtMs: 2_000,
          bundleId: fixture.bundle.descriptor.bundleId,
        },
      },
    });
    expect(await fixture.store.readAssetReceipt(fixture.desired.localAssetKey)).not.toBeNull();

    const databaseName = fixture.database.name;
    fixture.database.close();
    const reopened = new BitcasterDB(databaseName);
    openDatabases.push(reopened);
    expect(
      await reopened.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        fixture.desired.localAssetKey,
      ]),
    ).toMatchObject({ syncState: "acknowledged" });
    const reopenedStore = new EncryptedWalletBackupV2DexieAuthorityStore({
      database: reopened,
      scopeId: fixture.scopeId,
      realm: REALM,
      walletId: fixture.keyHandle.walletId,
      enrollmentEpoch: 1,
      requestAuthPublicKey: fixture.keyHandle.requestAuthPublicKey,
    });

    await expect(
      reopenedStore.commitVerifiedAssetReceipt({ ...receipt, acknowledgedAtMs: 2_000 }),
    ).resolves.toBeUndefined();
    await expect(
      reopenedStore.commitVerifiedAssetReceipt({ ...receipt, acknowledgedAtMs: 2_001 }),
    ).rejects.toThrow(/exclusion evidence conflicts/);
  });

  it("retains fresh current-head exclusion evidence and accepts one exact replay", async () => {
    const fixture = await preparedFixture(ctfAsset());
    const intent = removalIntentFor(fixture);
    const removal = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: fixture.scopeId,
      asset: fixture.asset,
      custodyRevision: 1n,
      activeProofCount: 0,
      removalIntent: intent,
    });
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put(removal);
    const absentHead = createEncryptedWalletBackupV2CurrentHead({
      realm: REALM,
      walletId: fixture.keyHandle.walletId,
      enrollmentEpoch: 1,
      headVersion: 2,
      bundles: [],
    });
    const headEvidence = evidence(absentHead, []);

    await expect(
      fixture.store.acknowledgeCurrentHeadRemoval({
        binding: {
          localAssetKey: removal.localAssetKey,
          assetLocator: fixture.bundle.descriptor.assetLocator,
          custodyRevision: "1",
          desiredAction: "remove",
          activeProofCount: 0,
        },
        collectedHeadEvidence: headEvidence,
        acknowledgedAtMs: 2_000,
      }),
    ).resolves.toBe("acknowledged");
    await expect(
      fixture.store.acknowledgeCurrentHeadRemoval({
        binding: {
          localAssetKey: removal.localAssetKey,
          assetLocator: fixture.bundle.descriptor.assetLocator,
          custodyRevision: "1",
          desiredAction: "remove",
          activeProofCount: 0,
        },
        collectedHeadEvidence: headEvidence,
        acknowledgedAtMs: 2_000,
      }),
    ).resolves.toBe("acknowledged");
    await expect(
      fixture.store.acknowledgeCurrentHeadRemoval({
        binding: {
          localAssetKey: removal.localAssetKey,
          assetLocator: fixture.bundle.descriptor.assetLocator,
          custodyRevision: "1",
          desiredAction: "remove",
          activeProofCount: 0,
        },
        collectedHeadEvidence: headEvidence,
        acknowledgedAtMs: 2_001,
      }),
    ).rejects.toThrow(/exclusion evidence conflicts/);
    expect(
      await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        removal.localAssetKey,
      ]),
    ).toMatchObject({ syncState: "acknowledged" });
  });

  it("refuses foreign current-head evidence without changing the pending intent", async () => {
    const fixture = await preparedFixture(ctfAsset());
    const intent = removalIntentFor(fixture);
    const removal = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: fixture.scopeId,
      asset: fixture.asset,
      custodyRevision: 1n,
      activeProofCount: 0,
      removalIntent: intent,
    });
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put(removal);
    const foreignHead = createEncryptedWalletBackupV2CurrentHead({
      realm: REALM,
      walletId: fixture.keyHandle.walletId,
      enrollmentEpoch: 2,
      headVersion: 2,
      bundles: [],
    });
    await expect(
      fixture.store.acknowledgeCurrentHeadRemoval({
        binding: {
          localAssetKey: removal.localAssetKey,
          assetLocator: fixture.bundle.descriptor.assetLocator,
          custodyRevision: "1",
          desiredAction: "remove",
          activeProofCount: 0,
        },
        collectedHeadEvidence: evidence(foreignHead, []),
        acknowledgedAtMs: 2_000,
      }),
    ).rejects.toThrow(/foreign|artifact/);
    expect(
      await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        removal.localAssetKey,
      ]),
    ).toMatchObject({ syncState: "pending", removalIntent: intent });
  });

  it("removes an already-absent asset intent and its obsolete receipt atomically", async () => {
    const fixture = await preparedFixture();
    await fixture.store.insertPreparedMutationForDesired(fixture.insert);
    await fixture.store.commitVerifiedAssetReceipt(await receiptFixture(fixture));
    const removal = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: fixture.scopeId,
      asset: fixture.asset,
      custodyRevision: 2n,
      activeProofCount: 0,
    });
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put(removal);

    const absentHead = createEncryptedWalletBackupV2CurrentHead({
      realm: REALM,
      walletId: fixture.keyHandle.walletId,
      enrollmentEpoch: 1,
      headVersion: 2,
      bundles: [],
    });
    await fixture.store.acknowledgeCurrentHeadRemoval({
      binding: {
        localAssetKey: removal.localAssetKey,
        assetLocator: fixture.bundle.descriptor.assetLocator,
        custodyRevision: removal.custodyRevision,
        desiredAction: "remove",
        activeProofCount: 0,
      },
      collectedHeadEvidence: evidence(absentHead, []),
      acknowledgedAtMs: 1_000,
    });

    expect(
      await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        removal.localAssetKey,
      ]),
    ).toBeUndefined();
    expect(await fixture.store.readAssetReceipt(removal.localAssetKey)).toBeNull();
  });

  it("requeues acknowledged assets after accepting a competing head", async () => {
    const fixture = await preparedFixture();
    await fixture.store.insertPreparedMutationForDesired(fixture.insert);
    await fixture.store.commitVerifiedAssetReceipt(await receiptFixture(fixture));
    const competingHead = createEncryptedWalletBackupV2CurrentHead({
      realm: REALM,
      walletId: fixture.keyHandle.walletId,
      enrollmentEpoch: 1,
      headVersion: 2,
      bundles: [],
    });

    await fixture.store.acceptCompetingHead({
      collectedHeadEvidence: evidence(competingHead, []),
      stalePreparedMutation: {
        mutationId: "00".repeat(16),
        requestDigest: "00".repeat(32),
      },
    });

    expect(
      await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        fixture.desired.localAssetKey,
      ]),
    ).toMatchObject({ syncState: "pending", custodyRevision: "1" });
    expect(await fixture.store.listActiveDescriptors()).toEqual([]);
    expect((await fixture.store.readAcceptedHead())?.headVersion).toBe(2);
  });
});

function recoveryAcceptanceTables(database: BitcasterDB) {
  return [
    database.encryptedWalletBackupV2AcceptedHeads,
    database.encryptedWalletBackupV2ActiveDescriptors,
    database.encryptedWalletBackupV2PreparedMutations,
    database.encryptedWalletBackupV2DesiredAssets,
    database.custodyProofs,
    database.custodyProofBackupAuthorities,
    database.custodyConditionalKeysets,
    database.custodyReservations,
    database.custodyOperations,
    database.custodyArtifacts,
    database.custodyActiveWork,
    database.proofOperations,
    database.mintQuotes,
    database.outgoingCashuTransfers,
    database.ctfRangePreparations,
    database.walletCounterCursors,
    database.walletCounterAssociations,
  ] as const;
}

async function preparedFixture(
  fixtureAsset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: "https://mint.example",
    unit: "sat",
    asset: { kind: "ordinary" },
  }),
) {
  sequence += 1;
  const seed = new Uint8Array(64).fill(sequence);
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed,
    realm: REALM,
    runtime: { subtle: crypto.subtle },
  });
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: "wallet",
    walletId: keyHandle.walletId,
  });
  const database = new BitcasterDB(browserWalletDatabaseName(scopeId));
  openDatabases.push(database);
  const store = new EncryptedWalletBackupV2DexieAuthorityStore({
    database,
    scopeId,
    realm: REALM,
    walletId: keyHandle.walletId,
    enrollmentEpoch: 1,
    requestAuthPublicKey: keyHandle.requestAuthPublicKey,
  });
  const asset = fixtureAsset;
  const desired = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId,
    asset,
    custodyRevision: 1n,
    activeProofCount: 1,
  });
  await database.encryptedWalletBackupV2DesiredAssets.put(desired);
  const emptyHead = createEncryptedWalletBackupV2CurrentHead({
    realm: REALM,
    walletId: keyHandle.walletId,
    enrollmentEpoch: 1,
    headVersion: 0,
    bundles: [],
  });
  await store.acceptCompetingHead({
    collectedHeadEvidence: evidence(emptyHead, []),
    stalePreparedMutation: { mutationId: "00".repeat(16), requestDigest: "00".repeat(32) },
  });
  const bundle = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    asset,
    declaredAmount: 1n,
    custodyRevision: 1n,
    canonicalPayload: encodeCanonicalBackupCbor(["proof"]),
    runtime: {
      subtle: crypto.subtle,
      getRandomValues: queuedRandom([hex(10 + sequence, 16), hex(20 + sequence, 12)]),
    },
  });
  const envelope = await prepareEncryptedWalletBackupV2BundleSupersessionMutation({
    keyHandle,
    expectedHeadEvidence: evidence(emptyHead, []),
    addedBundle: bundle.descriptor,
    supersededBundleIds: [],
    runtime: { getRandomValues: queuedRandom([hex(30 + sequence, 16), hex(40 + sequence, 32)]) },
  });
  const group = encodeEncryptedWalletBackupV2UploadGroup({
    envelope,
    objects: bundle.objects,
  });
  const resultHead = createEncryptedWalletBackupV2CurrentHead({
    realm: REALM,
    walletId: keyHandle.walletId,
    enrollmentEpoch: 1,
    headVersion: 1,
    bundles: [bundle.descriptor],
  });
  const binding = {
    localAssetKey: desired.localAssetKey,
    assetLocator: bundle.descriptor.assetLocator,
    custodyRevision: desired.custodyRevision,
    desiredAction: "replace" as const,
    activeProofCount: 1,
  };
  return {
    database,
    store,
    scopeId,
    keyHandle,
    asset,
    desired,
    bundle,
    envelope,
    group,
    resultHead,
    emptyHead,
    resultEvidence: evidence(resultHead, [bundle.descriptor]),
    insert: {
      prepared: {
        mutationId: envelope.mutation.mutationId,
        requestDigest: envelope.requestDigest,
        canonicalUploadGroup: group,
        createdAtUnixMilliseconds: 1,
        ...binding,
      },
      desired: binding,
    },
  };
}

function ctfAsset() {
  return createEncryptedWalletBackupV2AssetIdentity({
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
}

function removalIntentFor(fixture: Awaited<ReturnType<typeof preparedFixture>>) {
  return createEncryptedWalletBackupV2RemovalIntent({
    intentId: "explicit-remove-intent",
    createdAtMs: 1_000,
    realm: REALM,
    walletId: fixture.keyHandle.walletId,
    enrollmentEpoch: 1,
    expectedHeadVersion: fixture.emptyHead.headVersion,
    expectedActiveSetDigest: fixture.emptyHead.activeSetDigest,
    targetCustodyRevision: 1n,
    proofs: [
      {
        proofId: "aa".repeat(32),
        proofFingerprint: "bb".repeat(32),
        proofRevision: 0,
        proofCommitment: "cc".repeat(32),
      },
    ],
  });
}

async function receiptFixture(fixture: Awaited<ReturnType<typeof preparedFixture>>) {
  const mutationEvidence = decodeEncryptedWalletBackupV2UploadGroup({
    bytes: fixture.group,
    expectedRequestAuthPublicKey: fixture.keyHandle.requestAuthPublicKey,
    expectedContext: {
      realm: REALM,
      walletId: fixture.keyHandle.walletId,
      enrollmentEpoch: 1,
    },
  }).mutationEvidence;
  const receipt = await issueEncryptedWalletBackupV2BundleSupersessionReceipt({
    mutationEvidence,
    resultHead: fixture.resultHead,
    signingKeyId: SIGNING_KEY_ID,
    signingPublicKey: SIGNING_PUBLIC_KEY,
    signDigest: (digest) => schnorr.sign(digest, SIGNING_PRIVATE_KEY),
  });
  return {
    binding: {
      ...fixture.insert.desired,
      bundleId: fixture.bundle.descriptor.bundleId,
      bundleDescriptorDigest: receipt.bundleDescriptorDigest,
    },
    canonicalSignedMutation: encodeEncryptedWalletBackupV2SignedBundleSupersessionMutationWire(
      fixture.envelope,
    ),
    canonicalSignedReceipt: encodeEncryptedWalletBackupV2BundleSupersessionReceipt(receipt),
    verifiedReceipt: verifyEncryptedWalletBackupV2BundleSupersessionReceipt({
      receipt,
      mutationEvidence,
      pinnedSigningKeys: [{ keyId: SIGNING_KEY_ID, publicKey: SIGNING_PUBLIC_KEY }],
    }),
    collectedHeadEvidence: fixture.resultEvidence,
    preparedMutation: fixture.insert.prepared,
  };
}

function evidence(
  head: ReturnType<typeof createEncryptedWalletBackupV2CurrentHead>,
  bundles: Parameters<typeof enumerateEncryptedWalletBackupV2DescriptorPages>[0]["bundles"],
) {
  return collectEncryptedWalletBackupV2DescriptorPages(
    enumerateEncryptedWalletBackupV2DescriptorPages({ head, bundles }),
  );
}

function queuedRandom(values: readonly string[]) {
  const queue = values.map(fromHex);
  return (target: Uint8Array): Uint8Array => {
    const next = queue.shift();
    if (next === undefined || next.byteLength !== target.byteLength) throw new Error("test random");
    target.set(next);
    return target;
  };
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from({ length: value.length / 2 }, (_item, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  );
}

function toHex(value: Uint8Array): string {
  return Array.from(value, (item) => item.toString(16).padStart(2, "0")).join("");
}

function hex(value: number, bytes: number): string {
  return value.toString(16).padStart(2, "0").repeat(bytes);
}
