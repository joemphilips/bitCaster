// @vitest-environment node
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import Dexie from "dexie";
import { afterEach, expect, it, vi } from "vitest";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import { createEncryptedWalletBackupV2KeyHandle } from "@bitcaster/client-sdk/encryptedWalletBackupV2Keys";
import { createEncryptedWalletBackupV2AssetIdentity } from "@bitcaster/client-sdk";
import { prepareEncryptedWalletBackupV2TransportBundle } from "@bitcaster/client-sdk/encryptedWalletBackupV2Bundle";
import { prepareEncryptedWalletBackupOwnerBundleSupersessionMutation } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerMutation";
import { encodeEncryptedWalletBackupOwnerUploadGroup } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerUpload";
import { deriveEncryptedWalletBackupOwnerScope } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerScope";
import { BitcasterDB } from "@/stores/proof-db";
import { browserWalletDatabaseName } from "@/lib/browserWalletProfile";
import {
  createBrowserCompletedProofRemovalMarkerRow,
  decodeBrowserCompletedProofRemovalMarkerRow,
} from "@/stores/browser-proof-backup-authority";
import { createBrowserCustodyProofRow } from "@/stores/durable-custody-db";
import { decodeBrowserCustodyProofRow } from "@/stores/durable-custody-types";
import {
  createEncryptedWalletBackupV2DesiredAssetRow,
  createEncryptedWalletBackupV2RemovalIntent,
  decodeEncryptedWalletBackupV2DesiredAssetRow,
} from "@/stores/browser-encrypted-wallet-backup-v2-desired-asset";
import { runBrowserEncryptedWalletBackupOwnerWorkerCycle } from "../browserEncryptedWalletBackupOwnerWorker";
import type { BrowserEncryptedWalletBackupOwnerWorkerInput } from "../browserEncryptedWalletBackupOwnerWorker";
import { createOwnerRemovalRemote } from "./fixtures/ownerRemovalFixture";

const databases: BitcasterDB[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) {
    db.close();
    await Dexie.delete(db.name);
  }
});

async function fixture(count = 1) {
  let random = 0;
  const runtime = {
    subtle: webcrypto.subtle as unknown as SubtleCrypto,
    getRandomValues(target: Uint8Array) {
      return target.fill(++random);
    },
  };
  const seed = new Uint8Array(64).fill(7);
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed,
    realm: "mainnet",
    runtime,
  });
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: "wallet",
    walletId: keyHandle.walletId,
  });
  const db = new BitcasterDB(browserWalletDatabaseName(scopeId));
  databases.push(db);
  await db.open();
  const owner = {
    ...deriveEncryptedWalletBackupOwnerScope({
      authorizationScheme: "test",
      ownerSubject: "removal-owner-a",
    }),
    enrollmentEpoch: 1,
  };
  const ownerB = {
    ...deriveEncryptedWalletBackupOwnerScope({
      authorizationScheme: "test",
      ownerSubject: "removal-owner-b",
    }),
    enrollmentEpoch: 1,
  };
  const conditionId = "11".repeat(32),
    mintUrl = "https://mint.example";
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl,
    unit: "msat",
    asset: {
      kind: "ctf",
      conditionId,
      outcomeLabel: "NO",
      outcomeCollectionId: deriveRootCtfOutcomeCollectionId({
        conditionId,
        outcomeCollection: "NO",
      }),
      registeredAt: 1,
      finalExpiry: 2,
    },
  });
  const rows = Array.from({ length: count }, (_, index) =>
    createBrowserCustodyProofRow({
      scopeId,
      normalizedMint: mintUrl,
      unit: "msat",
      receivedAtMs: 1,
      proof: {
        id: `01${"22".repeat(32)}`,
        amount: 1 as never,
        secret: `owner-removal-${index}`,
        C: `02${"22".repeat(32)}`,
      },
      asset: { kind: "conditional", conditionId, outcomeCollection: "NO" },
    }),
  );
  await db.custodyProofs.bulkPut(rows);
  const desired = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId,
    asset,
    custodyRevision: 1n,
    activeProofCount: count,
    terminalCtfContext: {
      conditionId,
      outcomeLabel: "NO",
      outcomeCollectionId: deriveRootCtfOutcomeCollectionId({
        conditionId,
        outcomeCollection: "NO",
      }),
      registeredAt: 1,
      finalExpiry: 2,
    },
  });
  await db.encryptedWalletBackupV2DesiredAssets.put(desired);
  const remote = await createOwnerRemovalRemote({
    database: db,
    scopeId,
    keyHandle,
    owner,
    enrollmentEpoch: 1,
  });
  let selectedProofs = rows;
  const assetSource: NonNullable<BrowserEncryptedWalletBackupOwnerWorkerInput["assetSource"]> = {
    async read() {
      const current = decodeEncryptedWalletBackupV2DesiredAssetRow(
        await db.encryptedWalletBackupV2DesiredAssets.get([scopeId, desired.localAssetKey]),
      );
      return {
        desired: current,
        asset,
        proofs: selectedProofs.map((row, index) => ({
          mintUrl,
          unit: "msat" as const,
          asset: {
            kind: "ctf" as const,
            conditionId,
            outcomeLabel: "NO",
            outcomeCollectionId: deriveRootCtfOutcomeCollectionId({
              conditionId,
              outcomeCollection: "NO",
            }),
            registeredAt: 1,
            finalExpiry: 2,
          },
          proof: {
            id: row.keysetId,
            amount: 1 as never,
            secret: `owner-removal-${rows.indexOf(row)}`,
            C: `02${"22".repeat(32)}`,
          },
          locator: {
            schemaVersion: 1 as const,
            kind: "nut13" as const,
            keysetId: row.keysetId,
            counter: index,
          },
        })),
        losingProofs: [],
        refusalHistories: [],
        counterHighWaterMarks: [],
      };
    },
    async prepare(snapshot) {
      // The encrypted payload is controlled here; this suite covers Owner storage/receipt
      // transactions. The coordinator composition fixture covers real proof-set production.
      return prepareEncryptedWalletBackupV2TransportBundle({
        keyHandle,
        asset,
        declaredAmount: BigInt(snapshot.proofs.length),
        custodyRevision: BigInt(snapshot.desired.custodyRevision),
        canonicalPayload: new TextEncoder().encode(
          JSON.stringify(snapshot.proofs.map((p) => p.proof.secret)),
        ),
        runtime,
      });
    },
  };
  const worker: BrowserEncryptedWalletBackupOwnerWorkerInput = {
    database: db,
    scopeId,
    seed,
    keyHandle,
    owner,
    enrollmentEpoch: 1,
    remote: remote.remote,
    runtime,
    signal: new AbortController().signal,
    isCurrentProfile: () => true,
    assetSource,
  };
  expect(await runBrowserEncryptedWalletBackupOwnerWorkerCycle(worker)).toEqual({
    kind: "committed",
  });
  async function pending(targetCount = count, legacy = false) {
    const head = remote.readHead().head;
    const intent = createEncryptedWalletBackupV2RemovalIntent({
      ...(legacy ? {} : { ownerScopeId: owner.ownerScopeId }),
      intentId: "managed-removal",
      createdAtMs: 1,
      realm: keyHandle.realm,
      walletId: keyHandle.walletId,
      enrollmentEpoch: 1,
      expectedHeadVersion: head.headVersion,
      expectedActiveSetDigest: head.activeSetDigest,
      targetCustodyRevision: "2",
      proofs: rows.slice(0, targetCount).map((row) => ({
        proofId: row.proofId,
        proofFingerprint: row.proofFingerprint,
        proofRevision: row.revision,
        proofCommitment: "55".repeat(32),
      })),
    });
    await db.custodyProofs.bulkPut(
      rows.slice(0, targetCount).map((row) =>
        decodeBrowserCustodyProofRow({
          ...row,
          revision: row.revision + 1,
          selectability: "pending-removal",
        }),
      ),
    );
    selectedProofs = rows.slice(targetCount);
    const next = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId,
      asset,
      custodyRevision: 2n,
      activeProofCount: count - targetCount,
      terminalCtfContext: desired.terminalCtfContext,
      removalIntent: intent,
    });
    await db.encryptedWalletBackupV2DesiredAssets.put(next);
    return next;
  }
  return {
    db,
    owner,
    ownerB,
    worker,
    remote,
    pending,
    desired,
    rows,
    scopeId,
    keyHandle,
    runtime,
    seed,
    setSelectedProofs(value: typeof rows) {
      selectedProofs = value;
    },
  };
}

it("commits signed removal exclusion atomically and keeps it after database reopen without an asset receipt", async () => {
  const f = await fixture();
  await f.pending();
  expect(await runBrowserEncryptedWalletBackupOwnerWorkerCycle(f.worker)).toEqual({
    kind: "committed",
  });
  f.db.close();
  await f.db.open();
  const desired = decodeEncryptedWalletBackupV2DesiredAssetRow(
    await f.db.encryptedWalletBackupV2DesiredAssets.get([f.scopeId, f.desired.localAssetKey]),
  );
  expect(desired.removalIntent).toMatchObject({
    schemaVersion: 2,
    ownerScopeId: f.owner.ownerScopeId,
    state: "exclusion-acknowledged",
    acknowledgedExclusionEvidence: {
      kind: "receipt",
      bundleId: null,
      owner: { desiredAction: "remove" },
    },
  });
  expect(await f.remote.store.readPreparedMutation()).toBeNull();
  expect(
    await f.remote.store.captureBackupReceiptForLocalAsset(f.desired.localAssetKey),
  ).toBeNull();
  await f.remote.store.assertRemovalExclusionInTransaction(desired);
  expect(await f.db.custodyProofs.count()).toBe(1);
  expect(await f.db.encryptedWalletBackupV2AcceptedHeads.count()).toBe(0);
});

it("retains exact prepared work on lost reply, then commits its same verified result", async () => {
  const f = await fixture();
  await f.pending();
  f.remote.loseNextSuccessfulReply();
  await expect(runBrowserEncryptedWalletBackupOwnerWorkerCycle(f.worker)).rejects.toThrow(
    "lost successful reply",
  );
  const prepared = await f.remote.store.readPreparedMutation();
  expect(prepared?.removalBinding?.intentId).toBe("managed-removal");
  f.db.close();
  await f.db.open();
  expect(await runBrowserEncryptedWalletBackupOwnerWorkerCycle(f.worker)).toEqual({
    kind: "committed",
  });
  expect(f.remote.remote.mutateHead.mock.calls.at(-1)![0].canonicalUploadGroup).toEqual(
    prepared!.canonicalUploadGroup,
  );
  expect(f.remote.readHead().head.headVersion).toBe(2);
});

it("rolls back head and exclusion acknowledgment when the transaction fails", async () => {
  const f = await fixture();
  await f.pending();
  const fail = () => {
    throw new Error("ack transaction injected failure");
  };
  f.db.encryptedWalletBackupOwnerPreparedMutations.hook("deleting", fail);
  await expect(runBrowserEncryptedWalletBackupOwnerWorkerCycle(f.worker)).rejects.toThrow(
    "injected failure",
  );
  f.db.encryptedWalletBackupOwnerPreparedMutations.hook("deleting").unsubscribe(fail);
  expect((await f.remote.store.readCurrentHead())!.head.headVersion).toBe(1);
  expect(
    (await f.db.encryptedWalletBackupV2DesiredAssets.get([f.scopeId, f.desired.localAssetKey]))!
      .removalIntent!.state,
  ).toBe("pending");
  expect(await f.remote.store.readPreparedMutation()).not.toBeNull();
  expect(await runBrowserEncryptedWalletBackupOwnerWorkerCycle(f.worker)).toEqual({
    kind: "committed",
  });
});

it.each([false, true])(
  "does not publish another owner's or legacy unbound removal (legacy=%s)",
  async (legacy) => {
    const f = await fixture();
    const desired = await f.pending(1, legacy);
    const other = await createOwnerRemovalRemote({
      database: f.db,
      scopeId: f.scopeId,
      keyHandle: f.keyHandle,
      owner: f.ownerB,
      enrollmentEpoch: 1,
    });
    const input = { ...f.worker, owner: f.ownerB, remote: other.remote };
    expect(await runBrowserEncryptedWalletBackupOwnerWorkerCycle(input)).toEqual({ kind: "idle" });
    expect(other.remote.mutateHead).not.toHaveBeenCalled();
    expect(await other.store.readPreparedMutation()).toBeNull();
    expect(
      await f.db.encryptedWalletBackupV2DesiredAssets.get([f.scopeId, desired.localAssetKey]),
    ).toEqual(desired);
    if (!legacy)
      expect(await runBrowserEncryptedWalletBackupOwnerWorkerCycle(f.worker)).toEqual({
        kind: "committed",
      });
  },
);

it.each(["missing", "swapped"])(
  "refuses a %s prepared removal binding before replay network work",
  async (kind) => {
    const f = await fixture();
    await f.pending();
    f.remote.loseNextSuccessfulReply();
    await expect(runBrowserEncryptedWalletBackupOwnerWorkerCycle(f.worker)).rejects.toThrow();
    const row = await f.remote.store.readPreparedMutation();
    const changed = { ...row! };
    if (kind === "missing") delete changed.removalBinding;
    else changed.removalBinding = { ...changed.removalBinding!, intentId: "another-intent" };
    await f.db.encryptedWalletBackupOwnerPreparedMutations.put(changed);
    const before = f.remote.remote.mutateHead.mock.calls.length;
    await expect(runBrowserEncryptedWalletBackupOwnerWorkerCycle(f.worker)).rejects.toThrow(
      "intent changed",
    );
    expect(f.remote.remote.mutateHead.mock.calls).toHaveLength(before);
    expect(await f.db.custodyProofs.count()).toBe(1);
  },
);

it("isolates a reopened legacy unbound intent while an unrelated canonical asset progresses", async () => {
  const f = await fixture();
  const legacy = await f.pending(1, true);
  const marker = createBrowserCompletedProofRemovalMarkerRow({
    scopeId: f.scopeId,
    proofId: "77".repeat(32),
    proofFingerprint: "88".repeat(32),
    proofRevision: 1,
    proofCommitment: "99".repeat(32),
    localAssetKey: f.desired.localAssetKey,
    removalIntentId: "older-completed",
    proofSetCommitment: "aa".repeat(32),
    completionCustodyRevision: "1",
    realm: f.keyHandle.realm,
    walletId: f.keyHandle.walletId,
    enrollmentEpoch: 1,
    acknowledgedHeadVersion: 1,
    acknowledgedActiveSetDigest: "bb".repeat(32),
    acknowledgementKind: "current-head",
    receiptDigest: null,
    acknowledgedAtMs: 1,
    completedAtMs: 2,
  });
  await f.db.custodyProofBackupAuthorities.put(marker);
  f.db.close();
  await f.db.open();
  const reopened = decodeBrowserCompletedProofRemovalMarkerRow(
    await f.db.custodyProofBackupAuthorities.get([f.scopeId, marker.proofId]),
  );
  expect(reopened.schemaVersion).toBe(1);
  expect(reopened.ownerScopeId).toBeUndefined();
  expect(reopened.recordKind).toBe("completed-removal");
  const unrelated = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId: f.scopeId,
    asset: { mintUrl: "https://unrelated.example", unit: "msat", assetIdentity: "cashu:ordinary" },
    custodyRevision: 1n,
    activeProofCount: 0,
  });
  await f.db.encryptedWalletBackupV2DesiredAssets.put(unrelated);
  const before = f.remote.remote.mutateHead.mock.calls.length;
  expect(await runBrowserEncryptedWalletBackupOwnerWorkerCycle(f.worker)).toEqual({ kind: "idle" });
  const acknowledged = await f.db.encryptedWalletBackupOwnerDesiredAssets.get([
    f.scopeId,
    f.owner.ownerScopeId,
    unrelated.localAssetKey,
  ]);
  expect(acknowledged?.syncState).toBe("acknowledged");
  expect(
    await f.db.encryptedWalletBackupV2DesiredAssets.get([f.scopeId, legacy.localAssetKey]),
  ).toEqual(legacy);
  expect(f.remote.remote.mutateHead.mock.calls).toHaveLength(before);
  expect(await f.db.custodyProofs.count()).toBe(1);
});

it("refuses a replacement containing the removed target before preparing or uploading", async () => {
  const f = await fixture(2);
  await f.pending(1);
  f.setSelectedProofs([f.rows[0]!]);
  const before = f.remote.remote.mutateHead.mock.calls.length;
  await expect(runBrowserEncryptedWalletBackupOwnerWorkerCycle(f.worker)).rejects.toThrow(
    "invalid survivors",
  );
  expect(await f.remote.store.readPreparedMutation()).toBeNull();
  expect(f.remote.remote.mutateHead.mock.calls).toHaveLength(before);
  f.setSelectedProofs([f.rows[1]!]);
  expect(await runBrowserEncryptedWalletBackupOwnerWorkerCycle(f.worker)).toEqual({
    kind: "committed",
  });
  const desired = decodeEncryptedWalletBackupV2DesiredAssetRow(
    await f.db.encryptedWalletBackupV2DesiredAssets.get([f.scopeId, f.desired.localAssetKey]),
  );
  expect(desired.removalIntent?.acknowledgedExclusionEvidence).toMatchObject({
    kind: "receipt",
    owner: { desiredAction: "replace" },
  });
  await f.remote.store.assertRemovalExclusionInTransaction(desired);
  expect(await f.db.custodyProofs.count()).toBe(2);
});

it("retains removal work on rejection and refuses the generic discard entry", async () => {
  const f = await fixture();
  await f.pending();
  const rejected = {
    ...f.worker,
    remote: {
      ...f.worker.remote,
      mutateHead: vi.fn(async () => {
        throw new Error("fixture rejection without verified cancellation");
      }),
    },
  };
  await expect(runBrowserEncryptedWalletBackupOwnerWorkerCycle(rejected)).rejects.toThrow(
    "fixture rejection",
  );
  const prepared = await f.remote.store.readPreparedMutation();
  expect(prepared).not.toBeNull();
  await expect(f.remote.store.discardRejectedPreparedMutation(prepared!)).rejects.toThrow(
    "no verified cancellation",
  );
  expect(await f.remote.store.readPreparedMutation()).toEqual(prepared);
  expect(
    (await f.db.encryptedWalletBackupV2DesiredAssets.get([f.scopeId, f.desired.localAssetKey]))!
      .removalIntent!.state,
  ).toBe("pending");
  expect(await f.db.custodyProofs.count()).toBe(1);
});

it("retains old ordinary prepared work when its canonical asset is missing instead of guessing its history", async () => {
  const f = await fixture();
  await f.db.encryptedWalletBackupV2DesiredAssets.put({
    ...f.desired,
    custodyRevision: "2",
    syncState: "pending",
  });
  f.remote.loseNextSuccessfulReply();
  await expect(runBrowserEncryptedWalletBackupOwnerWorkerCycle(f.worker)).rejects.toThrow(
    "lost successful reply",
  );
  const prepared = await f.remote.store.readPreparedMutation();
  expect(prepared?.removalBinding).toBeUndefined();
  await f.db.encryptedWalletBackupV2DesiredAssets.delete([f.scopeId, f.desired.localAssetKey]);
  const before = f.remote.remote.mutateHead.mock.calls.length;
  await expect(runBrowserEncryptedWalletBackupOwnerWorkerCycle(f.worker)).rejects.toThrow(
    "canonical asset is absent",
  );
  expect(f.remote.remote.mutateHead.mock.calls).toHaveLength(before);
  expect(await f.remote.store.readPreparedMutation()).toEqual(prepared);
});

it("acknowledges already absent only from the bound current Owner head, without inventing a receipt", async () => {
  const f = await fixture();
  await f.pending();
  const envelope = await prepareEncryptedWalletBackupOwnerBundleSupersessionMutation({
    keyHandle: f.keyHandle,
    expectedContext: f.remote.context,
    expectedHeadEvidence: f.remote.readHead(),
    addedBundle: null,
    supersededBundleIds: f.remote.readHead().bundles.map((bundle) => bundle.bundleId),
    runtime: f.runtime,
  });
  const group = encodeEncryptedWalletBackupOwnerUploadGroup({ envelope, objects: [] });
  await f.remote.remote.mutateHead({
    owner: f.owner,
    enrollmentEpoch: 1,
    mutationEvidence: envelope,
    canonicalUploadGroup: group,
    signal: new AbortController().signal,
  });
  await f.remote.store.acceptCurrentHead({ expectedHeadVersion: 1, evidence: f.remote.readHead() });
  const calls = f.remote.remote.mutateHead.mock.calls.length;
  expect(await runBrowserEncryptedWalletBackupOwnerWorkerCycle(f.worker)).toEqual({ kind: "idle" });
  const desired = decodeEncryptedWalletBackupV2DesiredAssetRow(
    await f.db.encryptedWalletBackupV2DesiredAssets.get([f.scopeId, f.desired.localAssetKey]),
  );
  expect(desired.removalIntent?.acknowledgedExclusionEvidence).toMatchObject({
    kind: "current-head",
    bundleId: null,
    owner: { ownerScopeId: f.owner.ownerScopeId, mutationId: null, requestDigest: null },
  });
  await f.remote.store.assertRemovalExclusionInTransaction(desired);
  expect(f.remote.remote.mutateHead.mock.calls).toHaveLength(calls);
});

it("refuses exclusion authority when the same Owner head requires recovery after acknowledgment", async () => {
  const f = await fixture();
  await f.pending();
  expect(await runBrowserEncryptedWalletBackupOwnerWorkerCycle(f.worker)).toEqual({
    kind: "committed",
  });
  const before = await f.db.encryptedWalletBackupV2DesiredAssets.get([
    f.scopeId,
    f.desired.localAssetKey,
  ]);
  await f.remote.store.markCompetingHeadRecoveryRequired({ evidence: f.remote.readHead() });
  await expect(
    f.remote.store.assertRemovalExclusionInTransaction(
      decodeEncryptedWalletBackupV2DesiredAssetRow(before),
    ),
  ).rejects.toThrow("recovery is not ready");
  expect(
    await f.db.encryptedWalletBackupV2DesiredAssets.get([f.scopeId, f.desired.localAssetKey]),
  ).toEqual(before);
  expect(await f.db.custodyProofs.count()).toBe(1);
  expect(await f.db.custodyProofBackupAuthorities.count()).toBe(0);
});

it("refuses changed survivor material with the same proof ID before persisting or sending the prepared replacement", async () => {
  const f = await fixture(2);
  const desired = await f.pending(1);
  const source = f.worker.assetSource!;
  const survivor = f.rows[1]!;
  const calls = f.remote.remote.mutateHead.mock.calls.length;
  const worker = {
    ...f.worker,
    assetSource: {
      ...source,
      async prepare(snapshot: Parameters<typeof source.prepare>[0]) {
        const bundle = await source.prepare(snapshot);
        const changed = createBrowserCustodyProofRow({
          scopeId: f.scopeId,
          normalizedMint: survivor.normalizedMint,
          unit: "msat",
          receivedAtMs: 1,
          proof: {
            id: survivor.keysetId,
            amount: 1 as never,
            secret: "owner-removal-1",
            C: `03${"33".repeat(32)}`,
          },
          asset: { kind: "conditional", conditionId: "11".repeat(32), outcomeCollection: "NO" },
        });
        expect(changed.proofId).toBe(survivor.proofId);
        expect(changed.proofFingerprint).not.toBe(survivor.proofFingerprint);
        await f.db.custodyProofs.put(changed);
        return bundle;
      },
    },
  };
  await expect(runBrowserEncryptedWalletBackupOwnerWorkerCycle(worker)).rejects.toThrow(
    "survivor set changed",
  );
  expect(await f.remote.store.readPreparedMutation()).toBeNull();
  expect(f.remote.remote.mutateHead.mock.calls).toHaveLength(calls);
  expect(
    await f.db.encryptedWalletBackupV2DesiredAssets.get([f.scopeId, desired.localAssetKey]),
  ).toEqual(desired);
  expect(await f.db.custodyProofs.count()).toBe(2);
});

it("refuses new managed preparation if the unchanged Owner head requires recovery during source preparation", async () => {
  const f = await fixture(2);
  const desired = await f.pending(1);
  const source = f.worker.assetSource!;
  const calls = f.remote.remote.mutateHead.mock.calls.length;
  const worker = {
    ...f.worker,
    assetSource: {
      ...source,
      async prepare(snapshot: Parameters<typeof source.prepare>[0]) {
        const bundle = await source.prepare(snapshot);
        await f.remote.store.markCompetingHeadRecoveryRequired({ evidence: f.remote.readHead() });
        return bundle;
      },
    },
  };
  await expect(runBrowserEncryptedWalletBackupOwnerWorkerCycle(worker)).rejects.toThrow(
    "recovery is not ready",
  );
  expect(await f.remote.store.readPreparedMutation()).toBeNull();
  expect(f.remote.remote.mutateHead.mock.calls).toHaveLength(calls);
  expect(
    await f.db.encryptedWalletBackupV2DesiredAssets.get([f.scopeId, desired.localAssetKey]),
  ).toEqual(desired);
  expect(await f.db.custodyProofs.count()).toBe(2);
});
