import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import * as Cashu from "@cashu/cashu-ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { encode, rfc8949EncodeOptions } from "cborg";
import { deriveDurableCustodyProofId } from "../src/durableCustody.ts";
import {
  createEncryptedWalletBackupKeyHandle,
  decryptEncryptedWalletBackupDataChunk,
  decryptEncryptedWalletBackupManifestPage,
  ENCRYPTED_WALLET_BACKUP_DATA_CBOR_MAX_BYTES,
  packEncryptedWalletBackupDataChunk,
  prepareEncryptedWalletBackupManifest,
  prepareEncryptedWalletBackupManifestHead,
  prepareEncryptedWalletBackupObject,
  prepareEncryptedWalletBackupPendingSendParent,
  prepareEncryptedWalletBackupPendingSendProgression,
  prepareEncryptedWalletBackupProof,
  prepareEncryptedWalletBackupRequestProof,
  readAuthenticatedEncryptedWalletBackupHead,
  readPreparedEncryptedWalletBackupManifestHead,
  readPreparedEncryptedWalletBackupObject,
  type EncryptedWalletBackupKeyHandle,
} from "../src/encryptedWalletBackup.ts";
import {
  serializeEncryptedWalletBackupPackBinding,
  serializeEncryptedWalletBackupPreparedBuildRecord,
  type EncryptedWalletBackupPackPersistenceTransaction,
  type EncryptedWalletBackupPackSerializedPage,
  type PersistedEncryptedWalletBackupBuildCursor,
  type PersistedEncryptedWalletBackupPackBinding,
  type PersistedEncryptedWalletBackupPackControl,
  type PersistedEncryptedWalletBackupPreparedBuildRecord,
  type PersistedEncryptedWalletBackupStagedObject,
} from "../src/encryptedWalletBackupPackPersistence.ts";
import type {
  EncryptedWalletBackupPreparedRecordSnapshot,
  EncryptedWalletBackupPreparedRecordSnapshotBatchStore,
  EncryptedWalletBackupPreparedRecordSnapshotStore,
} from "../src/encryptedWalletBackupPreparedRecordPersistence.ts";
import * as RepackModule from "../src/encryptedWalletBackupRepackPersistence.ts";
import * as PublicSdk from "../src/index.ts";
import {
  advanceEncryptedWalletBackupRepackPage,
  beginEncryptedWalletBackupRepack,
  deserializeEncryptedWalletBackupRepackControl,
  deserializeEncryptedWalletBackupRepackSourceCoverage,
  deserializeEncryptedWalletBackupRepackProgress,
  ENCRYPTED_WALLET_BACKUP_REPACK_PAGE_RECORD_MAX,
  ENCRYPTED_WALLET_BACKUP_REPACK_REPLACEMENT_PACK_MAX,
  ENCRYPTED_WALLET_BACKUP_REPACK_SOURCE_MAX,
  rehydrateEncryptedWalletBackupRepack,
  requireCompletedEncryptedWalletBackupRepack,
  serializeEncryptedWalletBackupRepackControl,
  serializeEncryptedWalletBackupRepackSourceCoverage,
  serializeEncryptedWalletBackupRepackProgress,
  type EncryptedWalletBackupRepackPersistenceStore,
  type EncryptedWalletBackupRepackPersistenceTransaction,
  type PersistedEncryptedWalletBackupRepackControl,
  type PersistedEncryptedWalletBackupRepackProgress,
  type PersistedEncryptedWalletBackupRepackSourceCoverage,
} from "../src/encryptedWalletBackupRepackPersistence.ts";
import {
  authenticateEncryptedWalletBackupRepackOmissions,
  measureEncryptedWalletBackupRepackOmissionEvidence,
  prepareEncryptedWalletBackupRemovalIntent,
  type EncryptedWalletBackupRepackOmissionEvidenceRequest,
} from "../src/encryptedWalletBackupRepackOmission.ts";
import {
  requirePreparedEncryptedWalletBackupRecord,
  type PreparedEncryptedWalletBackupRecord,
} from "../src/encryptedWalletBackupRecord.ts";
import {
  createPartialPendingSendDeliveryRecord,
  createPendingSendFixture,
  exactPendingSendSnapshotStore,
  PENDING_SEND_FIXTURE_SEED,
} from "./encryptedWalletBackupPendingSendFixture.ts";

const vector = JSON.parse(
  await readFile(
    new URL(
      "../../test-vectors/encrypted-wallet-backup-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  inputs: {
    seedHex: string;
    realm: string;
    proof: {
      mint: string;
      unit: string;
      keysetId: string;
      amount: string;
      counter: number;
      signatureHex: string;
      dleq: { e: string; s: string; r: string };
      createdAtUnixSeconds: number;
      updatedAtUnixSeconds: number;
    };
  };
  expected: {
    derivedSecretHex: string;
    proofIdHex: string;
    commitmentHex: string;
  };
};

const SEED = fromHex(vector.inputs.seedHex);
const TARGET_SNAPSHOT_ID = "repack-snapshot";
const TARGET_SNAPSHOT_REVISION = 2;
const BUILD_ID = "repack-build";
const PACK_ID = "repack-pack";
const SECOND_PACK_ID = "repack-pack-2";
const REPACK_ID = "repack-operation";
const TARGET_GENERATION = 2;
const TARGET_SNAPSHOT_NONCE = "cd".repeat(16);

test("repack commits retained pack rows and coverage in one exact transaction", async () => {
  const fixture = await authenticatedSourceFixture();
  const store = new MemoryRepackStore(fixture.keyHandle);
  const started = await beginRepack(fixture, store, []);
  assert.equal(started.state, "active");
  assert.equal(started.totalRecordCount, 1);

  await assert.rejects(
    advanceEncryptedWalletBackupRepackPage({
      ...advanceInput(fixture, store, structuredClone(started)),
      omissions: [],
    }),
    /authenticated encrypted backup repack is invalid/,
  );

  const completed = await advanceEncryptedWalletBackupRepackPage({
    ...advanceInput(fixture, store, started),
    omissions: [],
  });
  assert.deepEqual(completed, {
    repackId: REPACK_ID,
    nextRecordOrdinal: 1,
    totalRecordCount: 1,
    retainedRecordCount: 1,
    omittedRecordCount: 0,
    state: "complete",
  });
  assert.equal(store.pack.recordCount, 1);
  assert.equal(store.prepared.size, 1);
  assert.equal(store.bindings.size, 1);
  assert.equal(store.control?.nextRecordOrdinal, 1);
  assert.equal(store.sources[0]?.coveredRecordCount, 1);
  assert.equal(store.progress.length, 1);
  assert.deepEqual(requireCompletedEncryptedWalletBackupRepack(completed), {
    ...completed,
    sourceSetDigest: store.control!.sourceSetDigest,
    removalSetDigest: store.control!.removalSetDigest,
    targetGeneration: TARGET_GENERATION,
    snapshotNonce: TARGET_SNAPSHOT_NONCE,
    replacementPackIds: [PACK_ID],
  });
  assert.equal(
    "retireEncryptedWalletBackupRepackSource" in RepackModule,
    false,
  );
});

test("repack restart rejects counter-only coverage without authenticated progress", async () => {
  const fixture = await authenticatedSourceFixture();
  const store = new MemoryRepackStore(fixture.keyHandle);
  await beginRepack(fixture, store, []);
  store.control = {
    ...store.control!,
    nextRecordOrdinal: 1,
    retainedRecordCount: 1,
    replacementPackIds: [PACK_ID],
    lastProgressDigest: "ef".repeat(32),
    version: 1,
    state: "complete",
  };
  store.sources[0] = {
    ...store.sources[0]!,
    coveredRecordCount: 1,
    retainedRecordCount: 1,
    version: 1,
  };
  const restarted = await restartSourceFixture(fixture);
  await assert.rejects(
    rehydrateEncryptedWalletBackupRepack({
      ...authenticatedInput(restarted, []),
      store,
      buildId: BUILD_ID,
      packId: PACK_ID,
      snapshotId: TARGET_SNAPSHOT_ID,
      snapshotRevision: TARGET_SNAPSHOT_REVISION,
      targetGeneration: TARGET_GENERATION,
      snapshotNonce: TARGET_SNAPSHOT_NONCE,
      expectedRepackVersion: 1,
      expectedSourceVersions: [1],
      expectedBuildVersion: 0,
      expectedPackVersion: 0,
    }),
    /progress is incomplete/,
  );
});

test("repack restart rejects modified authenticated progress", async () => {
  const fixture = await authenticatedSourceFixture();
  const store = new MemoryRepackStore(fixture.keyHandle);
  const started = await beginRepack(fixture, store, []);
  await advanceEncryptedWalletBackupRepackPage({
    ...advanceInput(fixture, store, started),
    omissions: [],
  });
  const authenticationTag = store.progress[0]!.authenticationTag.slice();
  authenticationTag[0] ^= 1;
  store.progress[0] = { ...store.progress[0]!, authenticationTag };
  const restarted = await restartSourceFixture(fixture);
  await assert.rejects(
    rehydrateEncryptedWalletBackupRepack({
      ...authenticatedInput(restarted, []),
      store,
      buildId: BUILD_ID,
      packId: PACK_ID,
      snapshotId: TARGET_SNAPSHOT_ID,
      snapshotRevision: TARGET_SNAPSHOT_REVISION,
      targetGeneration: TARGET_GENERATION,
      snapshotNonce: TARGET_SNAPSHOT_NONCE,
      expectedRepackVersion: 1,
      expectedSourceVersions: [1],
      expectedBuildVersion: 1,
      expectedPackVersion: 1,
    }),
    /authentication failed/,
  );
});

test("repack restart authenticates actual replacement rows", async () => {
  const fixture = await authenticatedSourceFixture();
  const store = new MemoryRepackStore(fixture.keyHandle);
  const started = await beginRepack(fixture, store, []);
  await advanceEncryptedWalletBackupRepackPage({
    ...advanceInput(fixture, store, started),
    omissions: [],
  });
  const honest = store.snapshot();
  const restart = async () => {
    const restarted = await restartSourceFixture(fixture);
    return rehydrateEncryptedWalletBackupRepack({
      ...authenticatedInput(restarted, []),
      store,
      buildId: BUILD_ID,
      packId: PACK_ID,
      snapshotId: TARGET_SNAPSHOT_ID,
      snapshotRevision: TARGET_SNAPSHOT_REVISION,
      targetGeneration: TARGET_GENERATION,
      snapshotNonce: TARGET_SNAPSHOT_NONCE,
      expectedRepackVersion: 1,
      expectedSourceVersions: [1],
      expectedBuildVersion: 1,
      expectedPackVersion: 1,
    });
  };
  assert.equal((await restart()).state, "complete");

  store.bindings.delete(`${BUILD_ID}:${PACK_ID}:${fixture.proofId}`);
  await assert.rejects(restart(), /evidence page is short/);

  store.bindings = structuredClone(honest.bindings);
  const preparedKey = `${BUILD_ID}:${fixture.proofId}`;
  const prepared = structuredClone(store.prepared.get(preparedKey)!);
  prepared.prepared = {
    ...prepared.prepared,
    commitment: "cd".repeat(32),
  };
  store.prepared.set(preparedKey, prepared);
  await assert.rejects(restart(), /authentication failed/);
});

test("repack rollback never advances coverage without the retained append", async () => {
  const fixture = await authenticatedSourceFixture();
  const store = new MemoryRepackStore(fixture.keyHandle);
  const started = await beginRepack(fixture, store, []);
  const before = store.snapshot();
  store.failOnRepackWrite = true;
  await assert.rejects(
    advanceEncryptedWalletBackupRepackPage({
      ...advanceInput(fixture, store, started),
      omissions: [],
    }),
    /injected repack write failure/,
  );
  assert.equal(
    isDeepStrictEqual(store.snapshot(), before),
    true,
    "repack transaction did not roll back",
  );

  store.failOnRepackWrite = false;
  const restarted = await restartSourceFixture(fixture);
  const rehydrated = await rehydrateEncryptedWalletBackupRepack({
    ...authenticatedInput(restarted, []),
    store,
    repackId: REPACK_ID,
    buildId: BUILD_ID,
    packId: PACK_ID,
    snapshotId: TARGET_SNAPSHOT_ID,
    snapshotRevision: TARGET_SNAPSHOT_REVISION,
    targetGeneration: TARGET_GENERATION,
    snapshotNonce: TARGET_SNAPSHOT_NONCE,
    expectedRepackVersion: 0,
    expectedSourceVersions: [0],
    expectedBuildVersion: 0,
    expectedPackVersion: 0,
  });
  const completed = await advanceEncryptedWalletBackupRepackPage({
    ...advanceInput(restarted, store, rehydrated),
    omissions: [],
  });
  assert.equal(completed.state, "complete");
  assert.equal(store.pack.recordCount, 1);
});

test("a real two-page repack resumes its exact second page after rollback", async () => {
  const fixture = await authenticatedSourceFixture(257);
  const store = new MemoryRepackStore(fixture.keyHandle);
  const started = await beginRepack(fixture, store, []);
  const first = await advanceEncryptedWalletBackupRepackPage({
    ...advanceInput(fixture, store, started),
    omissions: [],
  });
  assert.equal(first.state, "active");
  assert.equal(first.nextRecordOrdinal, 256);
  assert.equal(store.pack.recordCount, 256);

  const beforeSecond = store.snapshot();
  store.failOnRepackWrite = true;
  await assert.rejects(
    advanceEncryptedWalletBackupRepackPage({
      ...advanceInput(fixture, store, first, 1, 1),
      omissions: [],
    }),
    /injected repack write failure/,
  );
  assert.equal(
    isDeepStrictEqual(store.snapshot(), beforeSecond),
    true,
    "second repack page did not roll back",
  );

  store.failOnRepackWrite = false;
  const restarted = await restartSourceFixture(fixture);
  const rehydrated = await rehydrateEncryptedWalletBackupRepack({
    ...authenticatedInput(restarted, []),
    store,
    repackId: REPACK_ID,
    buildId: BUILD_ID,
    packId: PACK_ID,
    snapshotId: TARGET_SNAPSHOT_ID,
    snapshotRevision: TARGET_SNAPSHOT_REVISION,
    targetGeneration: TARGET_GENERATION,
    snapshotNonce: TARGET_SNAPSHOT_NONCE,
    expectedRepackVersion: 1,
    expectedSourceVersions: [1],
    expectedBuildVersion: 1,
    expectedPackVersion: 1,
  });
  const completed = await advanceEncryptedWalletBackupRepackPage({
    ...advanceInput(restarted, store, rehydrated, 1, 1),
    omissions: [],
  });
  assert.equal(completed.state, "complete");
  assert.equal(completed.nextRecordOrdinal, 257);
  assert.equal(store.pack.recordCount, 257);
});

test("repack advances a byte-fitting prefix and resumes in a new pack", async () => {
  const fixture = await authenticatedSourceFixture(2);
  const store = new MemoryRepackStore(fixture.keyHandle);
  store.build = {
    ...store.build,
    nextRecordOrdinal: 1,
  };
  store.installPartialPack(PACK_ID, fixture.records[0]!.canonicalRecordBytes);
  const started = await beginRepack(fixture, store, []);
  const partial = await advanceEncryptedWalletBackupRepackPage({
    ...advanceInput(fixture, store, started),
    omissions: [],
  });
  assert.equal(partial.state, "active");
  assert.equal(partial.nextRecordOrdinal, 1);
  assert.equal(store.pack.recordCount, 2);

  const beforeFullRetry = store.snapshot();
  await assert.rejects(
    advanceEncryptedWalletBackupRepackPage({
      ...advanceInput(fixture, store, partial, 1, 1),
      omissions: [],
    }),
    /target pack is full/,
  );
  assert.equal(
    isDeepStrictEqual(store.snapshot(), beforeFullRetry),
    true,
    "full target pack changed repack coverage",
  );

  store.build = {
    ...store.build,
    version: 2,
    openPackId: null,
  };
  store.archiveCurrentPack();
  store.pack = emptyPackControl(fixture.keyHandle, SECOND_PACK_ID);
  const restarted = await restartSourceFixture(fixture);
  const rehydrated = await rehydrateEncryptedWalletBackupRepack({
    ...authenticatedInput(restarted, []),
    store,
    buildId: BUILD_ID,
    packId: SECOND_PACK_ID,
    snapshotId: TARGET_SNAPSHOT_ID,
    snapshotRevision: TARGET_SNAPSHOT_REVISION,
    targetGeneration: TARGET_GENERATION,
    snapshotNonce: TARGET_SNAPSHOT_NONCE,
    expectedRepackVersion: 1,
    expectedSourceVersions: [1],
    expectedBuildVersion: 2,
    expectedPackVersion: 0,
  });
  const completed = await advanceEncryptedWalletBackupRepackPage({
    ...advanceInput(restarted, store, rehydrated, 2, 0, SECOND_PACK_ID),
    omissions: [],
  });
  assert.equal(completed.state, "complete");
  assert.deepEqual(
    requireCompletedEncryptedWalletBackupRepack(completed).replacementPackIds,
    [PACK_ID, SECOND_PACK_ID],
  );

  store.archivedPacks.delete(`${BUILD_ID}:${PACK_ID}`);
  const finalRestart = await restartSourceFixture(fixture);
  await assert.rejects(
    rehydrateEncryptedWalletBackupRepack({
      ...authenticatedInput(finalRestart, []),
      store,
      buildId: BUILD_ID,
      packId: SECOND_PACK_ID,
      snapshotId: TARGET_SNAPSHOT_ID,
      snapshotRevision: TARGET_SNAPSHOT_REVISION,
      targetGeneration: TARGET_GENERATION,
      snapshotNonce: TARGET_SNAPSHOT_NONCE,
      expectedRepackVersion: 2,
      expectedSourceVersions: [2],
      expectedBuildVersion: 3,
      expectedPackVersion: 1,
    }),
    /evidence control is missing/,
  );
});

test("repack omission requires non-clonable exact authority and writes no empty pack", async () => {
  const fixture = await authenticatedSourceFixture();
  const store = new MemoryRepackStore(fixture.keyHandle);
  const started = await beginRepack(fixture, store, [fixture.proofId]);
  const exact = await omissionAuthorities(fixture, [fixture.proofId]);
  await assert.rejects(
    advanceEncryptedWalletBackupRepackPage({
      ...advanceInput(fixture, store, started),
      omissions: exact.map((authority) => structuredClone(authority)),
    }),
    /authenticated encrypted backup repack omission is invalid/,
  );
  const restarted = await rehydrateEncryptedWalletBackupRepack({
    ...authenticatedInput(fixture, [fixture.proofId]),
    store,
    buildId: BUILD_ID,
    packId: PACK_ID,
    snapshotId: TARGET_SNAPSHOT_ID,
    snapshotRevision: TARGET_SNAPSHOT_REVISION,
    targetGeneration: TARGET_GENERATION,
    snapshotNonce: TARGET_SNAPSHOT_NONCE,
    expectedRepackVersion: 0,
    expectedSourceVersions: [0],
    expectedBuildVersion: 0,
    expectedPackVersion: 0,
  });
  const completed = await advanceEncryptedWalletBackupRepackPage({
    ...advanceInput(fixture, store, restarted),
    omissions: exact,
  });
  assert.equal(completed.omittedRecordCount, 1);
  assert.equal(completed.retainedRecordCount, 0);
  assert.equal(store.pack.recordCount, 0);
  assert.equal(store.prepared.size, 0);
  assert.deepEqual(
    requireCompletedEncryptedWalletBackupRepack(completed).replacementPackIds,
    [],
  );
});

test("repack preserves pending-send parent and progression fragments", async () => {
  const realm = "repack-pending-send";
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: PENDING_SEND_FIXTURE_SEED,
    realm,
  });
  const pending = createPendingSendFixture(2);
  const parent = await prepareEncryptedWalletBackupPendingSendParent({
    keyHandle,
    recordId: pending.snapshot.recordId,
    snapshotStore: exactPendingSendSnapshotStore(pending.snapshot),
  });
  const childSnapshot = {
    ...pending.snapshot,
    progression: "partial" as const,
    parentCommitment: parent.parentCommitment,
    deliveryRecord: await createPartialPendingSendDeliveryRecord(
      pending.deliveryRecord,
    ),
  };
  const child = await prepareEncryptedWalletBackupPendingSendProgression({
    keyHandle,
    recordId: childSnapshot.recordId,
    snapshotStore: exactPendingSendSnapshotStore(childSnapshot),
  });
  const fixture = await authenticatedPreparedFixture({
    keyHandle,
    seed: PENDING_SEND_FIXTURE_SEED,
    realm,
    records: [...parent.records, ...child.records],
    sourceCount: 2,
  });
  const store = new MemoryRepackStore(fixture.keyHandle);
  const started = await beginRepack(fixture, store, []);
  const completed = await advanceEncryptedWalletBackupRepackPage({
    ...advanceInput(fixture, store, started),
    omissions: [],
  });
  assert.equal(completed.state, "complete");
  assert.deepEqual(
    new Set(
      [...store.prepared.values()].map(
        ({ prepared }) => prepared.recordKindCode,
      ),
    ),
    new Set([1, 2]),
  );
});

test("repack rejects inexact transactions, stale runtime authority, and excess sources", async () => {
  const fixture = await authenticatedSourceFixture();
  for (const mode of ["never", "double", "deferred", "substituted"] as const) {
    const store = new MemoryRepackStore(fixture.keyHandle);
    store.callbackMode = mode;
    await assert.rejects(beginRepack(fixture, store, []), /callback|exact/);
    assert.equal(store.control, null);
  }
  await assert.rejects(
    beginEncryptedWalletBackupRepack({
      ...authenticatedInput(fixture, []),
      sourceChunks: new Array(
        ENCRYPTED_WALLET_BACKUP_REPACK_SOURCE_MAX + 1,
      ).fill(fixture.sourceChunk),
      store: new MemoryRepackStore(fixture.keyHandle),
      repackId: REPACK_ID,
      buildId: BUILD_ID,
      packId: PACK_ID,
      snapshotId: TARGET_SNAPSHOT_ID,
      snapshotRevision: TARGET_SNAPSHOT_REVISION,
      targetGeneration: TARGET_GENERATION,
      snapshotNonce: TARGET_SNAPSHOT_NONCE,
      expectedBuildVersion: 0,
      expectedPackVersion: 0,
    }),
    /source count/,
  );
  const store = new MemoryRepackStore(fixture.keyHandle);
  await beginRepack(fixture, store, []);
  await assert.rejects(
    rehydrateEncryptedWalletBackupRepack({
      ...authenticatedInput(fixture, []),
      head: structuredClone(fixture.head),
      store,
      repackId: REPACK_ID,
      buildId: BUILD_ID,
      packId: PACK_ID,
      snapshotId: TARGET_SNAPSHOT_ID,
      snapshotRevision: TARGET_SNAPSHOT_REVISION,
      targetGeneration: TARGET_GENERATION,
      snapshotNonce: TARGET_SNAPSHOT_NONCE,
      expectedRepackVersion: 0,
      expectedSourceVersions: [0],
      expectedBuildVersion: 0,
      expectedPackVersion: 0,
    }),
    /repack head is invalid/,
  );
  await assert.rejects(
    rehydrateEncryptedWalletBackupRepack({
      ...authenticatedInput(fixture, []),
      store,
      buildId: BUILD_ID,
      packId: PACK_ID,
      snapshotId: TARGET_SNAPSHOT_ID,
      snapshotRevision: TARGET_SNAPSHOT_REVISION,
      targetGeneration: TARGET_GENERATION,
      snapshotNonce: "ef".repeat(16),
      expectedRepackVersion: 0,
      expectedSourceVersions: [0],
      expectedBuildVersion: 0,
      expectedPackVersion: 0,
    }),
    /repack is foreign/,
  );
});

test("repack merges four 128-record source chunks in deterministic order", async () => {
  const fixture = await authenticatedSourceFixture(512, 4);
  const store = new MemoryRepackStore(fixture.keyHandle);
  await beginEncryptedWalletBackupRepack({
    ...authenticatedInput(fixture, []),
    sourceChunks: [...fixture.sourceChunks].reverse(),
    store,
    buildId: BUILD_ID,
    packId: PACK_ID,
    snapshotId: TARGET_SNAPSHOT_ID,
    snapshotRevision: TARGET_SNAPSHOT_REVISION,
    targetGeneration: TARGET_GENERATION,
    snapshotNonce: TARGET_SNAPSHOT_NONCE,
    expectedBuildVersion: 0,
    expectedPackVersion: 0,
  });
  store.reverseSourceReads = true;
  const rehydrated = await rehydrateEncryptedWalletBackupRepack({
    ...authenticatedInput(fixture, []),
    sourceChunks: [...fixture.sourceChunks].reverse(),
    store,
    buildId: BUILD_ID,
    packId: PACK_ID,
    snapshotId: TARGET_SNAPSHOT_ID,
    snapshotRevision: TARGET_SNAPSHOT_REVISION,
    targetGeneration: TARGET_GENERATION,
    snapshotNonce: TARGET_SNAPSHOT_NONCE,
    expectedRepackVersion: 0,
    expectedSourceVersions: [0, 0, 0, 0],
    expectedBuildVersion: 0,
    expectedPackVersion: 0,
  });
  const first = await advanceEncryptedWalletBackupRepackPage({
    ...advanceInput(fixture, store, rehydrated),
    omissions: [],
  });
  assert.equal(first.state, "active");
  const completed = await advanceEncryptedWalletBackupRepackPage({
    ...advanceInput(fixture, store, first, 1, 1),
    omissions: [],
  });
  assert.equal(completed.state, "complete");
  assert.deepEqual(
    store.sources.map((source) => source.coveredRecordCount),
    [128, 128, 128, 128],
  );
  assert.deepEqual(
    [...store.prepared.values()].map(({ recordId }) => recordId),
    [...fixture.records].map(({ recordId }) => recordId).sort(),
  );
});

test("four sources can progress through the proven eight-target bound", async () => {
  const fixture = await authenticatedSourceFixture(8, 4);
  const store = new MemoryRepackStore(fixture.keyHandle);
  store.build = { ...store.build, nextRecordOrdinal: 1 };
  store.installPartialPack(
    "repack-target-0",
    fixture.records[0]!.canonicalRecordBytes,
  );
  store.build = { ...store.build, openPackId: store.pack.packId };
  let repack = await beginEncryptedWalletBackupRepack({
    ...authenticatedInput(fixture, []),
    store,
    buildId: BUILD_ID,
    packId: store.pack.packId,
    snapshotId: TARGET_SNAPSHOT_ID,
    snapshotRevision: TARGET_SNAPSHOT_REVISION,
    targetGeneration: TARGET_GENERATION,
    snapshotNonce: TARGET_SNAPSHOT_NONCE,
    expectedBuildVersion: 0,
    expectedPackVersion: 0,
  });
  let buildVersion = 0;
  for (let index = 0; index < fixture.records.length; index += 1) {
    const packId = `repack-target-${index}`;
    repack = await advanceEncryptedWalletBackupRepackPage({
      ...advanceInput(fixture, store, repack, buildVersion, 0, packId),
      omissions: [],
    });
    assert.equal(repack.nextRecordOrdinal, index + 1);
    if (index === fixture.records.length - 1) break;
    buildVersion += 2;
    const nextPackId = `repack-target-${index + 1}`;
    store.build = {
      ...store.build,
      version: buildVersion,
      openPackId: nextPackId,
    };
    store.installPartialPack(
      nextPackId,
      fixture.records[index + 1]!.canonicalRecordBytes,
      true,
    );
  }
  assert.equal(repack.state, "complete");
  assert.equal(
    requireCompletedEncryptedWalletBackupRepack(repack).replacementPackIds
      .length,
    ENCRYPTED_WALLET_BACKUP_REPACK_REPLACEMENT_PACK_MAX,
  );
});

test("repack rows have strict canonical codecs and bounded public constants", async () => {
  const fixture = await authenticatedSourceFixture();
  const store = new MemoryRepackStore(fixture.keyHandle);
  await beginRepack(fixture, store, []);
  const control = store.control!;
  const source = store.sources[0]!;
  assert.deepEqual(
    deserializeEncryptedWalletBackupRepackControl(
      serializeEncryptedWalletBackupRepackControl(control),
    ),
    control,
  );
  assert.deepEqual(
    deserializeEncryptedWalletBackupRepackSourceCoverage(
      serializeEncryptedWalletBackupRepackSourceCoverage(source),
    ),
    source,
  );
  assert.throws(
    () =>
      serializeEncryptedWalletBackupRepackControl({
        ...control,
        unexpected: true,
      } as never),
    /fields are invalid/,
  );
  const canonical = serializeEncryptedWalletBackupRepackControl(control);
  assert.equal(canonical[2], 1);
  const nonCanonical = new Uint8Array(canonical.byteLength + 1);
  nonCanonical.set(canonical.subarray(0, 2), 0);
  nonCanonical.set([0x18, 0x01], 2);
  nonCanonical.set(canonical.subarray(3), 4);
  assert.throws(
    () => deserializeEncryptedWalletBackupRepackControl(nonCanonical),
    /repack control is invalid/,
  );
  assert.equal(ENCRYPTED_WALLET_BACKUP_REPACK_PAGE_RECORD_MAX, 256);
  assert.equal(ENCRYPTED_WALLET_BACKUP_REPACK_SOURCE_MAX, 4);
  assert.equal(
    "issueAuthenticatedEncryptedWalletBackupRepackOmission" in PublicSdk,
    false,
  );
  const started = await rehydrateEncryptedWalletBackupRepack({
    ...authenticatedInput(fixture, []),
    store,
    buildId: BUILD_ID,
    packId: PACK_ID,
    snapshotId: TARGET_SNAPSHOT_ID,
    snapshotRevision: TARGET_SNAPSHOT_REVISION,
    targetGeneration: TARGET_GENERATION,
    snapshotNonce: TARGET_SNAPSHOT_NONCE,
    expectedRepackVersion: 0,
    expectedSourceVersions: [0],
    expectedBuildVersion: 0,
    expectedPackVersion: 0,
  });
  await advanceEncryptedWalletBackupRepackPage({
    ...advanceInput(fixture, store, started),
    omissions: [],
  });
  assert.deepEqual(
    deserializeEncryptedWalletBackupRepackProgress(
      serializeEncryptedWalletBackupRepackProgress(store.progress[0]!),
    ),
    store.progress[0],
  );
});

async function beginRepack(
  fixture: AuthenticatedSourceFixture,
  store: MemoryRepackStore,
  removalRecordIds: readonly string[],
) {
  return beginEncryptedWalletBackupRepack({
    ...authenticatedInput(fixture, removalRecordIds),
    store,
    repackId: REPACK_ID,
    buildId: BUILD_ID,
    packId: PACK_ID,
    snapshotId: TARGET_SNAPSHOT_ID,
    snapshotRevision: TARGET_SNAPSHOT_REVISION,
    targetGeneration: TARGET_GENERATION,
    snapshotNonce: TARGET_SNAPSHOT_NONCE,
    expectedBuildVersion: 0,
    expectedPackVersion: 0,
  });
}

function authenticatedInput(
  fixture: AuthenticatedSourceFixture,
  removalRecordIds: readonly string[],
) {
  return {
    repackId: REPACK_ID,
    keyHandle: fixture.keyHandle,
    seed: fixture.seed,
    snapshotStore: targetSnapshotStore(fixture),
    headEvidence: fixture.headEvidence,
    head: fixture.head,
    manifestPages: fixture.manifestPages,
    sourceChunks: fixture.sourceChunks,
    removalRecordIds,
  };
}

function advanceInput(
  fixture: AuthenticatedSourceFixture,
  store: MemoryRepackStore,
  repack: Awaited<ReturnType<typeof beginRepack>>,
  expectedBuildVersion = 0,
  expectedPackVersion = 0,
  packId = PACK_ID,
) {
  return {
    store,
    repack,
    seed: fixture.seed,
    snapshotStore: targetSnapshotStore(fixture),
    packId,
    expectedBuildVersion,
    expectedPackVersion,
  };
}

function emptyPackControl(
  keyHandle: Pick<EncryptedWalletBackupKeyHandle, "realm" | "vaultId">,
  packId: string,
): PersistedEncryptedWalletBackupPackControl {
  return {
    schemaVersion: 1,
    buildId: BUILD_ID,
    packId,
    realm: keyHandle.realm,
    vaultId: keyHandle.vaultId,
    version: 0,
    state: "open",
    snapshotId: TARGET_SNAPSHOT_ID,
    snapshotRevision: TARGET_SNAPSHOT_REVISION,
    recordCount: 0,
    recordCanonicalBytes: 0,
    persistedRowBytes: 0,
    lastRecordId: null,
    canonicalBytes: 4,
    membershipDigest: null,
    stagedObjectId: null,
    stagedObjectDigest: null,
  };
}

async function omissionAuthorities(
  fixture: AuthenticatedSourceFixture,
  recordIds: readonly string[],
) {
  const requests: EncryptedWalletBackupRepackOmissionEvidenceRequest[] = [];
  const intents = await Promise.all(
    recordIds.map(async (recordId, intentIndex) => {
      const recordIndex = fixture.records.findIndex(
        (record) => record.recordId === recordId,
      );
      if (recordIndex < 0) throw new Error("missing omission test record");
      const record = fixture.records[recordIndex]!;
      const source =
        fixture.sourceObjects[recordIndex % fixture.sourceObjects.length]!;
      const intentId = `removal-intent-${intentIndex}`;
      const binding = {
        parentManifestDigest: fixture.head.manifestDigest,
        parentReferenceSetDigest: fixture.head.referenceSetDigest,
        targetGeneration: TARGET_GENERATION,
        snapshotNonce: TARGET_SNAPSHOT_NONCE,
        snapshotId: TARGET_SNAPSHOT_ID,
        snapshotRevision: TARGET_SNAPSHOT_REVISION,
        sourceObjectId: source.objectId,
        sourceObjectDigest: source.digest,
        recordKindCode: record.recordKindCode,
        recordId,
        commitment: record.commitment,
      } as const;
      requests.push({
        binding,
        evidence: { kind: "explicit-removal-intent", intentId },
      });
      return prepareEncryptedWalletBackupRemovalIntent({
        keyHandle: fixture.keyHandle,
        intentId,
        binding,
      });
    }),
  );
  return authenticateEncryptedWalletBackupRepackOmissions({
    keyHandle: fixture.keyHandle,
    requests,
    store: {
      async withCommittedEncryptedWalletBackupRepackOmissionEvidenceBatch(
        expected,
        _maximumBytes,
        use,
      ) {
        assert.deepEqual(expected, requests);
        const evidence = intents.map((intent) => ({
          kind: "explicit-removal-intent" as const,
          intent: structuredClone(intent),
        }));
        return use({
          evidence,
          serializedBytes: evidence.reduce(
            (total, row) =>
              total + measureEncryptedWalletBackupRepackOmissionEvidence(row),
            0,
          ),
        });
      },
    },
  });
}

async function authenticatedSourceFixture(
  count = 1,
  sourceCount = 1,
): Promise<AuthenticatedSourceFixture> {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: vector.inputs.realm,
  });
  const snapshots = new Map<
    string,
    EncryptedWalletBackupPreparedRecordSnapshot
  >();
  const proofs = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      prepareProofAtCounter(
        keyHandle,
        vector.inputs.proof.counter + index,
        snapshots,
      ),
    ),
  );
  return authenticatedPreparedFixture({
    keyHandle,
    seed: SEED,
    realm: vector.inputs.realm,
    records: proofs,
    sourceCount,
  });
}

async function authenticatedPreparedFixture(input: {
  keyHandle: EncryptedWalletBackupKeyHandle;
  seed: Uint8Array;
  realm: string;
  records: readonly PreparedEncryptedWalletBackupRecord[];
  sourceCount: number;
}): Promise<AuthenticatedSourceFixture> {
  const records = [...input.records].sort((left, right) => {
    const leftId = requirePreparedEncryptedWalletBackupRecord(left).recordId;
    const rightId = requirePreparedEncryptedWalletBackupRecord(right).recordId;
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
  if (input.sourceCount < 1 || input.sourceCount > records.length)
    throw new Error("test source count is invalid");
  const packed = Array.from({ length: input.sourceCount }, (_, sourceOrdinal) =>
    packEncryptedWalletBackupDataChunk(
      records.filter((_, index) => index % input.sourceCount === sourceOrdinal),
    ),
  );
  const objects = await Promise.all(
    packed.map((chunk) =>
      prepareEncryptedWalletBackupObject({
        keyHandle: input.keyHandle,
        chunk,
        generation: 1,
      }),
    ),
  );
  const manifest = await prepareEncryptedWalletBackupManifest({
    keyHandle: input.keyHandle,
    generation: 1,
    snapshotNonce: webcrypto.getRandomValues(new Uint8Array(16)),
    chunks: packed.map((chunk, index) => ({
      chunk,
      object: objects[index]!,
    })),
    snapshotStore: {
      async sealCommittedBackupSnapshot(expected, seal) {
        return seal(expected);
      },
    },
  });
  const preparedHead = prepareEncryptedWalletBackupManifestHead({
    keyHandle: input.keyHandle,
    manifest,
    parent: null,
  });
  const headWire = readPreparedEncryptedWalletBackupManifestHead(preparedHead);
  return authenticateFixture({
    keyHandle: input.keyHandle,
    seed: input.seed,
    realm: input.realm,
    records: records.map((record) => {
      const authority = requirePreparedEncryptedWalletBackupRecord(record);
      return {
        recordId: authority.recordId,
        commitment: authority.commitment,
        recordKindCode: authority.recordKindCode,
        canonicalRecordBytes: authority.canonicalRecord.byteLength,
      };
    }),
    headWire,
    manifestObjects: manifest.pages.map(
      readPreparedEncryptedWalletBackupObject,
    ),
    sourceObjects: objects.map(readPreparedEncryptedWalletBackupObject),
  });
}

async function restartSourceFixture(
  fixture: AuthenticatedSourceFixture,
): Promise<AuthenticatedSourceFixture> {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: fixture.seed,
    realm: fixture.realm,
  });
  return authenticateFixture({
    keyHandle,
    seed: fixture.seed,
    realm: fixture.realm,
    records: fixture.records,
    headWire: structuredClone(fixture.headWire),
    manifestObjects: fixture.manifestObjects.map((object) =>
      structuredClone(object),
    ),
    sourceObjects: fixture.sourceObjects.map((object) =>
      structuredClone(object),
    ),
  });
}

async function authenticateFixture(input: {
  keyHandle: EncryptedWalletBackupKeyHandle;
  seed: Uint8Array;
  realm: string;
  records: readonly Readonly<{
    recordId: string;
    commitment: string;
    recordKindCode: 0 | 1 | 2;
    canonicalRecordBytes: number;
  }>[];
  headWire: AuthenticatedSourceFixture["headWire"];
  manifestObjects: AuthenticatedSourceFixture["manifestObjects"];
  sourceObjects: AuthenticatedSourceFixture["sourceObjects"];
}): Promise<AuthenticatedSourceFixture> {
  const requestProof = await prepareEncryptedWalletBackupRequestProof({
    keyHandle: input.keyHandle,
    enrollmentEpoch: 1,
    method: "GET",
    url: "https://backup.example.test/v1/vault/head",
    issuedAtUnixSeconds: 1_700_000_000,
    expiresAtUnixSeconds: 1_700_000_030,
    payload: new Uint8Array(),
    signal: AbortSignal.timeout(60_000),
  });
  const headEvidence = await readAuthenticatedEncryptedWalletBackupHead({
    keyHandle: input.keyHandle,
    enrollmentEpoch: 1,
    requestProof,
    remote: {
      async readCurrentHead() {
        return {
          status: "found" as const,
          enrollmentEpoch: 1,
          head: structuredClone(input.headWire),
        };
      },
    },
  });
  const manifestPages = await Promise.all(
    input.manifestObjects.map((object) =>
      decryptEncryptedWalletBackupManifestPage({
        keyHandle: input.keyHandle,
        seed: input.seed,
        object: structuredClone(object),
        headEvidence,
      }),
    ),
  );
  const sourceChunks = await Promise.all(
    input.sourceObjects.map((object) =>
      decryptEncryptedWalletBackupDataChunk({
        keyHandle: input.keyHandle,
        seed: input.seed,
        object: structuredClone(object),
      }),
    ),
  );
  return {
    seed: input.seed.slice(),
    realm: input.realm,
    keyHandle: input.keyHandle,
    headEvidence,
    head: headEvidence.head!,
    headWire: structuredClone(input.headWire),
    manifestPage: manifestPages[0]!,
    manifestPages,
    sourceChunk: sourceChunks[0]!,
    sourceChunks,
    manifestObject: structuredClone(input.manifestObjects[0]!),
    manifestObjects: input.manifestObjects.map((object) =>
      structuredClone(object),
    ),
    sourceObject: structuredClone(input.sourceObjects[0]!),
    sourceObjects: input.sourceObjects.map((object) => structuredClone(object)),
    records: input.records.map((record) => ({ ...record })),
    proofId: input.records[0]!.recordId,
    commitment: input.records[0]!.commitment,
  };
}

async function prepareProofAtCounter(
  keyHandle: EncryptedWalletBackupKeyHandle,
  counter: number,
  snapshots: Map<string, EncryptedWalletBackupPreparedRecordSnapshot>,
) {
  const proof = vector.inputs.proof;
  const derive = (
    Cashu as unknown as {
      createSecretAndBlindingFactorDeriver(
        seed: Uint8Array,
        keyset: string,
      ): (index: number) => { secret: Uint8Array };
    }
  ).createSecretAndBlindingFactorDeriver(SEED, proof.keysetId);
  const secret = bytesToHex(derive(counter).secret);
  const recordId = deriveDurableCustodyProofId({
    normalizedMint: proof.mint,
    unit: proof.unit,
    keysetId: proof.keysetId,
    secret,
  });
  const commitment = bytesToHex(
    sha256(
      encode(
        [
          1,
          "wallet-record-commitment",
          0,
          proof.mint,
          proof.unit,
          [2, proof.keysetId],
          proof.amount,
          new TextEncoder().encode(secret),
          fromHex(proof.signatureHex),
          [fromHex(proof.dleq.e), fromHex(proof.dleq.s), fromHex(proof.dleq.r)],
          counter,
          0,
          null,
          proof.createdAtUnixSeconds,
          proof.updatedAtUnixSeconds,
        ],
        rfc8949EncodeOptions,
      ),
    ),
  );
  snapshots.set(recordId, {
    schemaVersion: 1,
    snapshotId: "test-snapshot",
    snapshotRevision: 1,
    recordId,
    commitment,
    recordKindCode: 0,
  });
  return prepareEncryptedWalletBackupProof({
    keyHandle,
    seed: SEED,
    mint: proof.mint,
    unit: proof.unit,
    counter,
    proof: {
      id: proof.keysetId,
      amount: proof.amount,
      secret,
      C: proof.signatureHex,
      dleq: { ...proof.dleq },
    },
    proofKind: "ordinary" as const,
    ctfMetadata: null,
    terminalEvidence: null,
    effectiveNowUnixSeconds: 1_700_000_000,
    createdAtUnixSeconds: proof.createdAtUnixSeconds,
    updatedAtUnixSeconds: proof.updatedAtUnixSeconds,
    proofSnapshotStore: {
      async withCommittedProofSnapshot(expectedRecordId, read) {
        const expected = snapshots.get(expectedRecordId);
        if (expected === undefined)
          throw new Error("missing prepared proof snapshot");
        return read(ordinaryProofSnapshot(expected));
      },
    },
  });
}

function ordinaryProofSnapshot(
  expected: EncryptedWalletBackupPreparedRecordSnapshot,
) {
  return Object.freeze({
    schemaVersion: 1 as const,
    snapshotId: "test-snapshot",
    revision: 1,
    proofId: expected.recordId,
    proofCommitment: expected.commitment,
    proofKind: "ordinary" as const,
    ctfMetadata: null,
    terminalOperationId: null,
    conditionalKeysetEvidence: null,
    provenance: "wallet-seed" as const,
    operationBinding: "terminally-unlinked" as const,
    reserved: false,
    ambiguousMintOperation: false,
    proofPins: {
      openOrderCollateral: "absent" as const,
      outbox: "absent" as const,
      retryCursor: "absent" as const,
      replayTombstone: "absent" as const,
      dependentWork: "absent" as const,
    },
    derivationLocator: "committed" as const,
  });
}

function targetSnapshotStore(
  fixture: AuthenticatedSourceFixture,
): EncryptedWalletBackupPreparedRecordSnapshotStore &
  EncryptedWalletBackupPreparedRecordSnapshotBatchStore {
  const snapshots = new Map(
    fixture.records.map((record) => [
      record.recordId,
      {
        schemaVersion: 1 as const,
        snapshotId: TARGET_SNAPSHOT_ID,
        snapshotRevision: TARGET_SNAPSHOT_REVISION,
        recordId: record.recordId,
        commitment: record.commitment,
        recordKindCode: record.recordKindCode,
      },
    ]),
  );
  return {
    async withCommittedPreparedRecordSnapshot(recordId, read) {
      const snapshot = snapshots.get(recordId);
      if (snapshot === undefined) throw new Error("missing target snapshot");
      return read(structuredClone(snapshot));
    },
    async withCommittedPreparedRecordSnapshotBatch(recordIds, read) {
      return read(
        recordIds.map((recordId) => {
          const snapshot = snapshots.get(recordId);
          if (snapshot === undefined)
            throw new Error("missing target snapshot");
          return structuredClone(snapshot);
        }),
      );
    },
  };
}

type CallbackMode = "exact" | "never" | "double" | "deferred" | "substituted";

class MemoryRepackStore implements EncryptedWalletBackupRepackPersistenceStore {
  build: PersistedEncryptedWalletBackupBuildCursor;
  pack: PersistedEncryptedWalletBackupPackControl;
  archivedPacks = new Map<string, PersistedEncryptedWalletBackupPackControl>();
  control: PersistedEncryptedWalletBackupRepackControl | null = null;
  sources: PersistedEncryptedWalletBackupRepackSourceCoverage[] = [];
  progress: PersistedEncryptedWalletBackupRepackProgress[] = [];
  prepared = new Map<
    string,
    PersistedEncryptedWalletBackupPreparedBuildRecord
  >();
  bindings = new Map<string, PersistedEncryptedWalletBackupPackBinding>();
  staged = new Map<string, PersistedEncryptedWalletBackupStagedObject>();
  callbackMode: CallbackMode = "exact";
  failOnRepackWrite = false;
  reverseSourceReads = false;
  private syntheticRecordIndex = 0;

  constructor(keyHandle: EncryptedWalletBackupKeyHandle) {
    this.build = {
      schemaVersion: 1,
      buildId: BUILD_ID,
      realm: keyHandle.realm,
      vaultId: keyHandle.vaultId,
      snapshotId: TARGET_SNAPSHOT_ID,
      snapshotRevision: TARGET_SNAPSHOT_REVISION,
      version: 0,
      nextRecordOrdinal: 0,
      openPackId: PACK_ID,
    };
    this.pack = {
      schemaVersion: 1,
      buildId: BUILD_ID,
      packId: PACK_ID,
      realm: keyHandle.realm,
      vaultId: keyHandle.vaultId,
      version: 0,
      state: "open",
      snapshotId: TARGET_SNAPSHOT_ID,
      snapshotRevision: TARGET_SNAPSHOT_REVISION,
      recordCount: 0,
      recordCanonicalBytes: 0,
      persistedRowBytes: 0,
      lastRecordId: null,
      canonicalBytes: 4,
      membershipDigest: null,
      stagedObjectId: null,
      stagedObjectDigest: null,
    };
  }

  async withExactRepackTransaction<T>(
    expected: Parameters<
      EncryptedWalletBackupRepackPersistenceStore["withExactRepackTransaction"]
    >[0],
    use: (transaction: EncryptedWalletBackupRepackPersistenceTransaction) => T,
  ): Promise<unknown> {
    this.requireExpected(expected);
    const working = this.snapshot();
    const transaction = this.transaction(working);
    if (this.callbackMode === "never") return { skipped: true };
    if (this.callbackMode === "deferred")
      return Promise.resolve().then(() => use(transaction));
    const result = use(transaction);
    if (this.callbackMode === "double") use(transaction);
    if (this.callbackMode === "substituted") return { substituted: true };
    this.restore(working);
    return result;
  }

  snapshot() {
    return structuredClone({
      build: this.build,
      pack: this.pack,
      archivedPacks: this.archivedPacks,
      control: this.control,
      sources: this.sources,
      progress: this.progress,
      prepared: this.prepared,
      bindings: this.bindings,
      staged: this.staged,
      syntheticRecordIndex: this.syntheticRecordIndex,
    });
  }

  installPartialPack(packId: string, nextRecordBytes: number, archive = false) {
    if (archive) this.archiveCurrentPack();
    const recordId = this.syntheticRecordIndex.toString(16).padStart(64, "0");
    this.syntheticRecordIndex += 1;
    const existingRecordBytes =
      ENCRYPTED_WALLET_BACKUP_DATA_CBOR_MAX_BYTES - 4 - nextRecordBytes;
    const prepared: PersistedEncryptedWalletBackupPreparedBuildRecord = {
      schemaVersion: 1,
      buildId: BUILD_ID,
      realm: this.pack.realm,
      vaultId: this.pack.vaultId,
      snapshotId: TARGET_SNAPSHOT_ID,
      snapshotRevision: TARGET_SNAPSHOT_REVISION,
      recordId,
      prepared: {
        schemaVersion: 1,
        realm: this.pack.realm,
        vaultId: this.pack.vaultId,
        snapshotId: TARGET_SNAPSHOT_ID,
        snapshotRevision: TARGET_SNAPSHOT_REVISION,
        recordId,
        commitment: "ab".repeat(32),
        recordKindCode: 0,
        canonicalRecord: new Uint8Array(existingRecordBytes),
        canonicalManifestEntry: new Uint8Array([0x80]),
        authenticationTag: new Uint8Array(32),
      },
    };
    const binding: PersistedEncryptedWalletBackupPackBinding = {
      schemaVersion: 1,
      buildId: BUILD_ID,
      packId,
      realm: this.pack.realm,
      vaultId: this.pack.vaultId,
      snapshotId: TARGET_SNAPSHOT_ID,
      snapshotRevision: TARGET_SNAPSHOT_REVISION,
      recordId,
      ordinal: 0,
    };
    const persistedRowBytes =
      serializeEncryptedWalletBackupPreparedBuildRecord(prepared).byteLength +
      serializeEncryptedWalletBackupPackBinding(binding).byteLength;
    this.prepared.set(`${BUILD_ID}:${recordId}`, structuredClone(prepared));
    this.bindings.set(
      `${BUILD_ID}:${packId}:${recordId}`,
      structuredClone(binding),
    );
    this.pack = {
      ...emptyPackControl(
        { realm: this.pack.realm, vaultId: this.pack.vaultId },
        packId,
      ),
      recordCount: 1,
      recordCanonicalBytes: existingRecordBytes,
      persistedRowBytes,
      lastRecordId: recordId,
      canonicalBytes: 4 + existingRecordBytes,
    };
  }

  archiveCurrentPack() {
    this.archivedPacks.set(
      `${this.pack.buildId}:${this.pack.packId}`,
      structuredClone(this.pack),
    );
  }

  private requireExpected(
    expected: Parameters<
      EncryptedWalletBackupRepackPersistenceStore["withExactRepackTransaction"]
    >[0],
  ) {
    assert.equal(this.control?.version ?? null, expected.repackVersion);
    assert.equal(this.build.version, expected.buildVersion);
    assert.equal(this.pack.version, expected.packVersion);
    assert.equal(this.build.buildId, expected.buildId);
    assert.equal(this.pack.packId, expected.packId);
    assert.equal(this.build.realm, expected.realm);
    assert.equal(this.build.vaultId, expected.vaultId);
    assert.equal(this.build.snapshotId, expected.snapshotId);
    assert.equal(this.build.snapshotRevision, expected.snapshotRevision);
    for (const source of expected.sourceVersions) {
      const current = this.sources.find(
        (row) => row.sourceObjectId === source.sourceObjectId,
      );
      assert.equal(current?.version ?? null, source.version);
    }
    assert.equal(
      this.sources.length,
      expected.sourceVersions.filter(({ version }) => version !== null).length,
    );
  }

  private transaction(
    working: ReturnType<MemoryRepackStore["snapshot"]>,
  ): EncryptedWalletBackupRepackPersistenceTransaction {
    return {
      ...this.packTransaction(working),
      readRepackControl: (repackId) =>
        working.control?.repackId === repackId
          ? structuredClone(working.control)
          : null,
      readRepackSourceCoverages: (repackId) =>
        (this.reverseSourceReads
          ? [...working.sources].reverse()
          : working.sources
        )
          .filter((source) => source.repackId === repackId)
          .map((source) => structuredClone(source)),
      readRepackProgress: (repackId) =>
        working.progress
          .filter((row) => row.repackId === repackId)
          .map((row) => structuredClone(row)),
      insertRepackControl: (row) => {
        if (working.control !== null) throw new Error("unique repack control");
        working.control = structuredClone(row);
      },
      writeRepackControl: (row) => {
        if (this.failOnRepackWrite)
          throw new Error("injected repack write failure");
        working.control = structuredClone(row);
      },
      insertRepackSourceCoverage: (row) => {
        if (
          working.sources.some(
            (source) => source.sourceObjectId === row.sourceObjectId,
          )
        )
          throw new Error("unique repack source");
        working.sources.push(structuredClone(row));
      },
      writeRepackSourceCoverage: (row) => {
        const index = working.sources.findIndex(
          (source) => source.sourceObjectId === row.sourceObjectId,
        );
        if (index < 0) throw new Error("missing repack source");
        working.sources[index] = structuredClone(row);
      },
      insertRepackProgress: (row) => {
        if (
          working.progress.some(
            (current) =>
              current.repackId === row.repackId &&
              current.transitionOrdinal === row.transitionOrdinal,
          )
        )
          throw new Error("unique repack progress");
        working.progress.push(structuredClone(row));
      },
    };
  }

  private packTransaction(
    working: ReturnType<MemoryRepackStore["snapshot"]>,
  ): EncryptedWalletBackupPackPersistenceTransaction {
    return {
      readBuildCursor: (buildId) =>
        working.build.buildId === buildId
          ? structuredClone(working.build)
          : null,
      readPackControl: (buildId, packId) =>
        working.pack.buildId === buildId && working.pack.packId === packId
          ? structuredClone(working.pack)
          : structuredClone(
              working.archivedPacks.get(`${buildId}:${packId}`) ?? null,
            ),
      readPackRecordPage: (buildId, packId, afterRecordId, limit, maxBytes) => {
        const rows: EncryptedWalletBackupPackSerializedPage["rows"][number][] =
          [];
        let serializedBytes = 0;
        const bindings = [...working.bindings.values()]
          .filter(
            (row) =>
              row.buildId === buildId &&
              row.packId === packId &&
              (afterRecordId === null || row.recordId > afterRecordId),
          )
          .sort((left, right) => left.ordinal - right.ordinal)
          .slice(0, limit);
        for (const binding of bindings) {
          const prepared = working.prepared.get(
            `${buildId}:${binding.recordId}`,
          );
          if (prepared === undefined) continue;
          const wire = {
            binding: serializeEncryptedWalletBackupPackBinding(binding),
            prepared:
              serializeEncryptedWalletBackupPreparedBuildRecord(prepared),
          };
          const nextBytes =
            serializedBytes +
            wire.binding.byteLength +
            wire.prepared.byteLength;
          if (nextBytes > maxBytes) break;
          rows.push(wire);
          serializedBytes = nextBytes;
        }
        return { rows, serializedBytes };
      },
      readStagedObject: (buildId, packId) =>
        structuredClone(working.staged.get(`${buildId}:${packId}`) ?? null),
      insertPreparedRecord: (row) => {
        const key = `${row.buildId}:${row.recordId}`;
        if (working.prepared.has(key))
          throw new Error("unique prepared record");
        serializeEncryptedWalletBackupPreparedBuildRecord(row);
        working.prepared.set(key, structuredClone(row));
      },
      insertPackBinding: (row) => {
        const key = `${row.buildId}:${row.packId}:${row.recordId}`;
        if (working.bindings.has(key)) throw new Error("unique pack binding");
        serializeEncryptedWalletBackupPackBinding(row);
        working.bindings.set(key, structuredClone(row));
      },
      writeBuildCursor: (row) => {
        working.build = structuredClone(row);
      },
      writePackControl: (row) => {
        working.pack = structuredClone(row);
      },
      insertStagedObject: (row) => {
        working.staged.set(
          `${row.buildId}:${row.packId}`,
          structuredClone(row),
        );
      },
    };
  }

  private restore(snapshot: ReturnType<MemoryRepackStore["snapshot"]>) {
    this.build = snapshot.build;
    this.pack = snapshot.pack;
    this.archivedPacks = snapshot.archivedPacks;
    this.control = snapshot.control;
    this.sources = snapshot.sources;
    this.progress = snapshot.progress;
    this.prepared = snapshot.prepared;
    this.bindings = snapshot.bindings;
    this.staged = snapshot.staged;
    this.syntheticRecordIndex = snapshot.syntheticRecordIndex;
  }
}

interface AuthenticatedSourceFixture {
  seed: Uint8Array;
  realm: string;
  keyHandle: EncryptedWalletBackupKeyHandle;
  headEvidence: Awaited<
    ReturnType<typeof readAuthenticatedEncryptedWalletBackupHead>
  >;
  head: NonNullable<
    Awaited<
      ReturnType<typeof readAuthenticatedEncryptedWalletBackupHead>
    >["head"]
  >;
  headWire: ReturnType<typeof readPreparedEncryptedWalletBackupManifestHead>;
  manifestPage: Awaited<
    ReturnType<typeof decryptEncryptedWalletBackupManifestPage>
  >;
  manifestPages: readonly Awaited<
    ReturnType<typeof decryptEncryptedWalletBackupManifestPage>
  >[];
  sourceChunk: Awaited<
    ReturnType<typeof decryptEncryptedWalletBackupDataChunk>
  >;
  sourceChunks: readonly Awaited<
    ReturnType<typeof decryptEncryptedWalletBackupDataChunk>
  >[];
  manifestObject: ReturnType<typeof readPreparedEncryptedWalletBackupObject>;
  manifestObjects: readonly ReturnType<
    typeof readPreparedEncryptedWalletBackupObject
  >[];
  sourceObject: ReturnType<typeof readPreparedEncryptedWalletBackupObject>;
  sourceObjects: readonly ReturnType<
    typeof readPreparedEncryptedWalletBackupObject
  >[];
  records: readonly Readonly<{
    recordId: string;
    commitment: string;
    recordKindCode: 0 | 1 | 2;
    canonicalRecordBytes: number;
  }>[];
  proofId: string;
  commitment: string;
}

function fromHex(value: string) {
  return Uint8Array.from(
    value.match(/../g)!.map((pair) => Number.parseInt(pair, 16)),
  );
}
