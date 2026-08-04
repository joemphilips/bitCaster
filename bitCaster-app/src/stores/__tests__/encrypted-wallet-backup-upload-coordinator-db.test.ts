// @vitest-environment node
import "fake-indexeddb/auto";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEncryptedWalletBackupKeyHandle,
  prepareBoundedEncryptedWalletBackupManifestTarget,
  prepareEncryptedWalletBackupRequestProof,
  readAuthenticatedEncryptedWalletBackupHead,
  type EncryptedWalletBackupKeyHandle,
  type PreparedEncryptedWalletBackupManifestTarget,
} from "@bitcaster/client-sdk/encryptedWalletBackup";
import {
  claimBoundedEncryptedWalletBackupUploadAttempt,
  ENCRYPTED_WALLET_BACKUP_UPLOAD_BATCH_BYTES_MAX,
  measureEncryptedWalletBackupUploadBatchRecordBytes,
  planAndSealBoundedEncryptedWalletBackupUploadBatch,
  sealBoundedEncryptedWalletBackupUploadAttempt,
  sealOrRehydrateEncryptedWalletBackupCasAttempt,
  uploadEncryptedWalletBackupBatch,
} from "@bitcaster/client-sdk/encryptedWalletBackupSync";
import { encodeCanonicalBackupCbor } from "@bitcaster/client-sdk/encryptedWalletBackupCbor";
import { encryptedWalletBackupObjectDigest } from "@bitcaster/client-sdk/encryptedWalletBackupObjectDigest";
import { encodeEncryptedWalletBackupUploadCursor } from "@bitcaster/client-sdk/encryptedWalletBackupUploadPlanningPersistence";
import {
  ENCRYPTED_WALLET_BACKUP_EMPTY_REFERENCE_SET_DIGEST,
  issueEncryptedWalletBackupFrozenSnapshotControl,
} from "@bitcaster/client-sdk/encryptedWalletBackupSnapshotAuthority";
import { issueBoundedManifestTargetCapabilityForTest } from "@bitcaster/client-sdk/encryptedWalletBackupManifestTargetAuthority";
import {
  clearEncryptedWalletBackupRetryScheduler,
  createEncryptedWalletBackupUploadCoordinatorDexieStore,
  EncryptedWalletBackupUploadCoordinatorDexiePort,
  findEncryptedWalletBackupUploadAttemptId,
  readEncryptedWalletBackupRetryScheduler,
  scheduleEncryptedWalletBackupRetry,
} from "../encrypted-wallet-backup-upload-coordinator-db";
import { BitcasterDB } from "../proof-db";

const openDatabases: BitcasterDB[] = [];

afterEach(async () => {
  for (const database of openDatabases.splice(0)) {
    database.close();
    await database.delete();
  }
});

describe("encrypted wallet backup Dexie upload coordinator", () => {
  it("uses a read-only preflight before the public SDK restart claim", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-04T00:00:00.000Z"));
    try {
      const fixture = await emptyTargetFixture();
      const database = databaseFor();
      const store = createEncryptedWalletBackupUploadCoordinatorDexieStore(database);
      const input = uploadInput(fixture, store, "11");
      const sealed = await sealBoundedEncryptedWalletBackupUploadAttempt(input);
      const retried = await sealBoundedEncryptedWalletBackupUploadAttempt(input);
      expect(retried.record).toEqual(sealed.record);
      expect(
        await findEncryptedWalletBackupUploadAttemptId(database, {
          realm: fixture.keyHandle.realm,
          vaultId: fixture.keyHandle.vaultId,
        }),
      ).toBe(sealed.record.attemptId);
      expect(
        (await database.encryptedWalletBackupUploadAttempts.get(sealed.record.attemptId))?.record,
      ).toEqual(sealed.record);

      database.close();
      const restarted = new BitcasterDB(database.name);
      openDatabases.push(restarted);
      const restartedStore = createEncryptedWalletBackupUploadCoordinatorDexieStore(restarted);
      expect(
        await claimBoundedEncryptedWalletBackupUploadAttempt({
          ownerId: "other-owner",
          leaseDurationMilliseconds: 60_000,
          keyHandle: fixture.keyHandle,
          store: restartedStore,
        }),
      ).toBeNull();
      vi.setSystemTime(sealed.record.leaseExpiresAtUnixMilliseconds);
      expect(
        (
          await claimBoundedEncryptedWalletBackupUploadAttempt({
            ownerId: "other-owner",
            leaseDurationMilliseconds: 60_000,
            keyHandle: fixture.keyHandle,
            store: restartedStore,
          })
        )?.record.ownerEpoch,
      ).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when indexed preflight finds multiple durable attempts", async () => {
    const fixture = await emptyTargetFixture();
    const database = databaseFor();
    const store = createEncryptedWalletBackupUploadCoordinatorDexieStore(database);
    const sealed = await sealBoundedEncryptedWalletBackupUploadAttempt(
      uploadInput(fixture, store, "55"),
    );
    const duplicateAttemptId = "66".repeat(16);
    const preflightDatabase = {
      encryptedWalletBackupUploadAttempts: {
        where: () => ({
          equals: () => ({
            limit: () => ({
              primaryKeys: async () => [sealed.record.attemptId, duplicateAttemptId],
            }),
          }),
        }),
      },
    } as unknown as BitcasterDB;

    await expect(
      findEncryptedWalletBackupUploadAttemptId(preflightDatabase, {
        realm: fixture.keyHandle.realm,
        vaultId: fixture.keyHandle.vaultId,
      }),
    ).rejects.toThrow(/scope is invalid/);
  });

  it("keeps one strict durable retry schedule for each wallet vault", async () => {
    const fixture = await emptyTargetFixture();
    const database = databaseFor();
    const identity = {
      scopeId: "wallet-scope",
      realm: fixture.keyHandle.realm,
      vaultId: fixture.keyHandle.vaultId,
    };
    await scheduleEncryptedWalletBackupRetry(database, {
      ...identity,
      attemptId: "77".repeat(16),
      minimumDelayMilliseconds: 5_000,
    });
    await scheduleEncryptedWalletBackupRetry(database, {
      ...identity,
      attemptId: "88".repeat(16),
      minimumDelayMilliseconds: 5_000,
    });

    await expect(readEncryptedWalletBackupRetryScheduler(database, identity)).resolves.toEqual({
      ...identity,
      attemptId: "88".repeat(16),
      retryStreak: 1,
      retryNotBeforeUnixMilliseconds: expect.any(Number),
    });
    expect(await database.encryptedWalletBackupRetrySchedulers.count()).toBe(1);

    await clearEncryptedWalletBackupRetryScheduler(database, {
      ...identity,
      attemptId: "88".repeat(16),
    });
    await expect(readEncryptedWalletBackupRetryScheduler(database, identity)).resolves.toBeNull();
  });

  it("rolls back raw writes, rejects a stale claim, and enforces unique live and CAS links", async () => {
    const fixture = await emptyTargetFixture();
    const database = databaseFor();
    const port = new EncryptedWalletBackupUploadCoordinatorDexiePort(database);
    const store = createEncryptedWalletBackupUploadCoordinatorDexieStore(database);
    const sealed = await sealBoundedEncryptedWalletBackupUploadAttempt(
      uploadInput(fixture, store, "22"),
    );
    const cursor = uploadCursor(sealed.record);

    await expect(
      port.transaction(controlReservation(), async (transaction) => {
        await transaction.insertAttempt({
          ...sealed.record,
          attemptId: "33".repeat(16),
          realm: "rollback.example.test",
        });
        await transaction.insertCursor({ attemptId: "33".repeat(16), canonicalCursor: cursor });
        throw new Error("rollback upload coordinator test");
      }),
    ).rejects.toThrow(/rollback upload coordinator test/);
    expect(await database.encryptedWalletBackupUploadAttempts.count()).toBe(1);
    expect(await database.encryptedWalletBackupUploadCursors.count()).toBe(1);

    await expect(
      sealBoundedEncryptedWalletBackupUploadAttempt(uploadInput(fixture, store, "44")),
    ).rejects.toThrow(/live backup upload attempt/);

    await port.transaction(controlReservation(), async (transaction) => {
      await transaction.replaceAttempt(sealed.record, {
        ...sealed.record,
        ownerEpoch: sealed.record.ownerEpoch + 1,
      });
    });
    await expect(store.validateUploadAttemptClaim(sealed.record, () => "stale")).rejects.toThrow(
      /stale/,
    );

    const claimed = await claimBoundedEncryptedWalletBackupUploadAttempt({
      ownerId: "owner",
      leaseDurationMilliseconds: 60_000,
      keyHandle: fixture.keyHandle,
      store,
    });
    if (claimed === null) throw new Error("upload attempt claim is absent");
    const cas = await sealOrRehydrateEncryptedWalletBackupCasAttempt({
      claim: claimed,
      keyHandle: fixture.keyHandle,
      store,
    });
    await expect(
      port.transaction(controlReservation(), async (transaction) => {
        await transaction.insertCasAttempt({ ...cas.record, attemptId: "55".repeat(16) });
      }),
    ).rejects.toThrow();
    expect(await database.encryptedWalletBackupUploadCasAttempts.count()).toBe(1);
  });

  it("enforces reservations and refuses a normalized batch after authority tampering", async () => {
    const fixture = await emptyTargetFixture();
    const database = databaseFor();
    const port = new EncryptedWalletBackupUploadCoordinatorDexiePort(database);
    const store = createEncryptedWalletBackupUploadCoordinatorDexieStore(database);
    const sealed = await sealBoundedEncryptedWalletBackupUploadAttempt(
      uploadInput(fixture, store, "66"),
    );
    const batch = batchFor(sealed.record, "77".repeat(16));

    await expect(
      port.transaction(
        { readRows: 0, writeRows: 0, readBytes: 0, writeBytes: 0 },
        async (transaction) => transaction.insertBatch(batch),
      ),
    ).rejects.toThrow(/reservation/);
    expect(await database.encryptedWalletBackupUploadBatches.count()).toBe(0);

    await port.transaction(controlReservation(), async (transaction) => {
      await transaction.insertBatch(batch);
    });
    const attempt = await database.encryptedWalletBackupUploadAttempts.get(sealed.record.attemptId);
    if (!attempt) throw new Error("missing upload attempt");
    await database.encryptedWalletBackupUploadAttempts.put({
      ...attempt,
      record: {
        ...attempt.record,
        canonicalTargetHead: Uint8Array.of(1),
      },
    });
    await expect(
      port.transaction(controlReservation(), async (transaction) =>
        transaction.readBatch(batch.batchId),
      ),
    ).rejects.toThrow(/authority does not match/);
  });

  it("accounts a near-1 MiB batch and does not reread cached rows for stale checks", async () => {
    const fixture = await emptyTargetFixture();
    const database = databaseFor();
    const port = new EncryptedWalletBackupUploadCoordinatorDexiePort(database);
    const store = createEncryptedWalletBackupUploadCoordinatorDexieStore(database);
    const sealed = await sealBoundedEncryptedWalletBackupUploadAttempt(
      uploadInput(fixture, store, "99"),
    );
    const batch = {
      ...batchFor(sealed.record, "aa".repeat(16)),
      items: [
        {
          objectId: "11".repeat(16),
          objectDigest: "22".repeat(32),
          payloadLength: 1_040_000,
          canonicalPutPayload: new Uint8Array(1_040_000),
        },
      ],
    };
    expect(measureEncryptedWalletBackupUploadBatchRecordBytes(batch)).toBeLessThanOrEqual(
      ENCRYPTED_WALLET_BACKUP_UPLOAD_BATCH_BYTES_MAX,
    );

    await port.transaction(controlReservation(), async (transaction) => {
      await transaction.insertBatch(batch);
    });
    const batchesGet = vi.spyOn(database.encryptedWalletBackupUploadBatches, "get");
    const batchesPut = vi.spyOn(database.encryptedWalletBackupUploadBatches, "put");
    const attemptsGet = vi.spyOn(database.encryptedWalletBackupUploadAttempts, "get");
    await port.transaction(controlReservation(), async (transaction) => {
      const current = await transaction.readBatch(batch.batchId);
      if (current === null) throw new Error("missing upload batch");
      await transaction.replaceBatch(current as typeof batch, {
        ...(current as typeof batch),
        executionEpoch: batch.executionEpoch + 1,
      });
    });
    expect(batchesGet).toHaveBeenCalledTimes(1);
    expect(batchesPut).toHaveBeenCalledTimes(1);
    expect(attemptsGet).toHaveBeenCalledTimes(1);

    attemptsGet.mockClear();
    await port.transaction(controlReservation(), async (transaction) => {
      const current = await transaction.readAttempt(sealed.record.attemptId);
      if (current === null) throw new Error("missing upload attempt");
      await transaction.replaceAttempt(current as typeof sealed.record, {
        ...(current as typeof sealed.record),
        ownerEpoch: sealed.record.ownerEpoch + 1,
      });
    });
    expect(attemptsGet).toHaveBeenCalledTimes(1);
  });

  it("reads one full active batch and 63 compact historical batches inside the control page", async () => {
    const fixture = await emptyTargetFixture();
    const database = databaseFor();
    const port = new EncryptedWalletBackupUploadCoordinatorDexiePort(database);
    const seedStore = createEncryptedWalletBackupUploadCoordinatorDexieStore(database);
    const sealed = await sealBoundedEncryptedWalletBackupUploadAttempt(
      uploadInput(fixture, seedStore, "88"),
    );
    const batchIds = Array.from({ length: 64 }, (_value, index) =>
      (index + 1).toString(16).padStart(32, "0"),
    );
    const attempt = { ...sealed.record, batchIds, activeBatchId: batchIds[0]! };
    await port.transaction(controlReservation(), async (transaction) => {
      await transaction.replaceAttempt(sealed.record, attempt);
      for (const [index, batchId] of batchIds.entries()) {
        const batch = batchFor(attempt, batchId);
        await transaction.insertBatch({
          ...batch,
          state: index === 0 ? "sealed" : "acknowledged",
          items:
            index === 0
              ? [
                  {
                    objectId: "11".repeat(16),
                    objectDigest: "22".repeat(32),
                    payloadLength: 980_000,
                    canonicalPutPayload: new Uint8Array(980_000),
                  },
                ]
              : [],
        } as never);
      }
    });
    const attemptsGet = vi.spyOn(database.encryptedWalletBackupUploadAttempts, "get");
    const batchesWhere = vi.spyOn(database.encryptedWalletBackupUploadBatches, "where");
    await expect(
      port.transaction(controlReservation(), async (transaction) => {
        const rows = await transaction.readBatchesForAttempt({
          attemptId: attempt.attemptId,
          maximumRows: 64,
        });
        const repeated = await transaction.readBatchesForAttempt({
          attemptId: attempt.attemptId,
          maximumRows: 64,
        });
        expect(repeated).toHaveLength(64);
        return rows;
      }),
    ).resolves.toHaveLength(64);
    expect(attemptsGet).toHaveBeenCalledTimes(1);
    expect(batchesWhere).toHaveBeenCalledTimes(1);
  });

  it("seals and acknowledges three successive bounded batches within the real Dexie reservation", async () => {
    const fixture = await chunkTargetFixture(7);
    const database = databaseFor();
    const store = createEncryptedWalletBackupUploadCoordinatorDexieStore(database);
    let claim = await sealBoundedEncryptedWalletBackupUploadAttempt(
      uploadInput(fixture, store, "ab"),
    );
    const source = chunkObjectSource(fixture.keyHandle);
    const sealedBatchIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const batch = await planAndSealBoundedEncryptedWalletBackupUploadBatch({
        claim,
        keyHandle: fixture.keyHandle,
        store,
        source,
      });
      if (batch === null) throw new Error("expected bounded upload batch");
      sealedBatchIds.push(batch.record.batchId);
      const acknowledged = await uploadEncryptedWalletBackupBatch({
        batch,
        claim,
        store,
        keyHandle: fixture.keyHandle,
        enrollmentEpoch: 1,
        clock: { nowUnixSeconds: () => 1_700_000_000 },
        objectUrl: (objectId) => `https://backup.example.test/v1/objects/${objectId}`,
        remote: {
          async putObject() {
            return { status: "stored" as const };
          },
        },
        signal: new AbortController().signal,
      });
      expect(acknowledged.record.state).toBe("acknowledged");
      const next = await claimBoundedEncryptedWalletBackupUploadAttempt({
        ownerId: "owner",
        leaseDurationMilliseconds: 60_000,
        keyHandle: fixture.keyHandle,
        store,
      });
      if (next === null) throw new Error("expected restarted bounded upload claim");
      claim = next;
    }
    expect(new Set(sealedBatchIds).size).toBe(3);
    expect(await database.encryptedWalletBackupUploadBatches.count()).toBe(3);

    database.close();
    const restarted = new BitcasterDB(database.name);
    openDatabases.push(restarted);
    const restartedStore = createEncryptedWalletBackupUploadCoordinatorDexieStore(restarted);
    const resumed = await claimBoundedEncryptedWalletBackupUploadAttempt({
      ownerId: "owner",
      leaseDurationMilliseconds: 60_000,
      keyHandle: fixture.keyHandle,
      store: restartedStore,
    });
    expect(resumed?.record.batchIds).toEqual(sealedBatchIds);
    expect(resumed?.record.activeBatchId).toBeNull();
  });
});

function databaseFor(): BitcasterDB {
  const database = new BitcasterDB(`upload-coordinator-${crypto.randomUUID()}`);
  openDatabases.push(database);
  return database;
}

function controlReservation() {
  return Object.freeze({
    readRows: 68,
    writeRows: 67,
    readBytes: 1_048_576,
    writeBytes: 1_048_576,
  });
}

function uploadInput(
  fixture: Awaited<ReturnType<typeof emptyTargetFixture>>,
  store: ReturnType<typeof createEncryptedWalletBackupUploadCoordinatorDexieStore>,
  suffix: string,
) {
  return {
    attemptId: suffix.repeat(16),
    ownerId: "owner",
    leaseDurationMilliseconds: 60_000,
    keyHandle: fixture.keyHandle,
    target: fixture.target,
    store,
  };
}

function uploadCursor(
  record: Awaited<ReturnType<typeof sealBoundedEncryptedWalletBackupUploadAttempt>>["record"],
): Uint8Array {
  return encodeEncryptedWalletBackupUploadCursor({
    schemaVersion: 1,
    realm: record.realm,
    vaultId: record.vaultId,
    attemptId: record.attemptId,
    targetManifestDigest: record.targetManifestDigest,
    phase: "complete",
    nextPageIndex: 0,
    exclusiveChunkObjectId: null,
    nextBatchOrdinal: 0,
    version: 1,
  });
}

function batchFor(
  attempt: Awaited<ReturnType<typeof sealBoundedEncryptedWalletBackupUploadAttempt>>["record"],
  batchId: string,
) {
  return {
    schemaVersion: 1 as const,
    batchId,
    attemptId: attempt.attemptId,
    targetManifestDigest: attempt.targetManifestDigest,
    canonicalTargetHead: attempt.canonicalTargetHead.slice(),
    canonicalTargetReferenceSet: attempt.canonicalTargetReferenceSet.slice(),
    canonicalInheritedReferenceSet: attempt.canonicalInheritedReferenceSet.slice(),
    localSnapshotId: attempt.localSnapshotId,
    localSnapshotRevision: attempt.localSnapshotRevision,
    repackedChunkCount: 0,
    uploadedBytes: 0,
    executionEpoch: 1,
    executionLeaseExpiresAtUnixMilliseconds: null,
    items: [],
    state: "acknowledged" as const,
  };
}

async function emptyTargetFixture(chunkCount = 0): Promise<{
  keyHandle: EncryptedWalletBackupKeyHandle;
  target: PreparedEncryptedWalletBackupManifestTarget;
}> {
  const seed = new Uint8Array(64).fill(9);
  const runtime = {
    subtle: crypto.subtle,
    getRandomValues: (value: Uint8Array) => crypto.getRandomValues(value),
  };
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed,
    realm: "backup.example.test",
    runtime,
  });
  const control = issueEncryptedWalletBackupFrozenSnapshotControl(
    {},
    {
      realm: keyHandle.realm,
      vaultId: keyHandle.vaultId,
      enrollmentEpoch: 1,
      parentGeneration: null,
      parentManifestDigest: null,
      parentReferenceSetDigest: ENCRYPTED_WALLET_BACKUP_EMPTY_REFERENCE_SET_DIGEST,
      generation: 1,
      snapshotNonce: "22".repeat(16),
      snapshotId: "empty",
      snapshotRevision: 1,
    },
  );
  const requestProof = await prepareEncryptedWalletBackupRequestProof({
    keyHandle,
    enrollmentEpoch: 1,
    method: "GET",
    url: "https://backup.example.test/v1/vault/head",
    issuedAtUnixSeconds: 1_700_000_000,
    expiresAtUnixSeconds: 1_700_000_030,
    payload: new Uint8Array(),
    runtime,
    signal: AbortSignal.timeout(60_000),
  });
  const parentEvidence = await readAuthenticatedEncryptedWalletBackupHead({
    keyHandle,
    enrollmentEpoch: 1,
    requestProof,
    remote: {
      async readCurrentHead() {
        return { status: "not-found" as const };
      },
    },
  });
  return {
    keyHandle,
    target: prepareBoundedEncryptedWalletBackupManifestTarget({
      keyHandle,
      capability: issueBoundedManifestTargetCapabilityForTest({
        keyHandle,
        control,
        parentEvidence,
        pages:
          chunkCount === 0
            ? []
            : [
                (() => {
                  const object = manifestPageObject(keyHandle, "empty", 1, 0, 1);
                  return {
                    formatVersion: object.formatVersion,
                    kindCode: object.kindCode,
                    realm: object.realm,
                    vaultId: object.vaultId,
                    objectId: object.objectId,
                    generation: object.generation,
                    paddedLength: object.paddedLength,
                    digest: object.digest,
                  };
                })(),
              ],
        chunkReferences: Array.from({ length: chunkCount }, (_value, index) => {
          const object = chunkObject(keyHandle, chunkObjectId(index + 32));
          return { objectId: object.objectId, digest: object.digest };
        }),
        proofCount: chunkCount,
      }),
    }),
  };
}

async function chunkTargetFixture(chunkCount: number): Promise<{
  keyHandle: EncryptedWalletBackupKeyHandle;
  target: PreparedEncryptedWalletBackupManifestTarget;
}> {
  return emptyTargetFixture(chunkCount);
}

function chunkObjectSource(keyHandle: EncryptedWalletBackupKeyHandle) {
  return {
    async readManifestPageObject(input: Readonly<{ objectId: string }>) {
      return manifestPageObject(keyHandle, "empty", 1, 0, 1, input.objectId);
    },
    async readProofChunkObject(input: Readonly<{ objectId: string }>) {
      return chunkObject(keyHandle, input.objectId);
    },
  };
}

function chunkObject(keyHandle: EncryptedWalletBackupKeyHandle, objectId: string) {
  const aad = encodeCanonicalBackupCbor([
    1,
    1,
    keyHandle.realm,
    hexToBytes(keyHandle.vaultId),
    hexToBytes(objectId),
    1,
    262_144,
  ]);
  const body = new Uint8Array(262_172);
  return Object.freeze({
    formatVersion: 1 as const,
    kindCode: 1 as const,
    realm: keyHandle.realm,
    vaultId: keyHandle.vaultId,
    objectId,
    generation: 1,
    paddedLength: 262_144 as const,
    digest: bytesToHex(encryptedWalletBackupObjectDigest(aad, body)),
    aad,
    body,
  });
}

function chunkObjectId(index: number): string {
  return (index + 1).toString(16).padStart(32, "0");
}

function manifestPageObject(
  keyHandle: EncryptedWalletBackupKeyHandle,
  snapshotId: string,
  snapshotRevision: number,
  pageIndex: number,
  pageCount: number,
  objectId = chunkObjectId(0),
) {
  const aad = encodeCanonicalBackupCbor([
    1,
    "encrypted-wallet-backup-manifest-page-aad",
    2,
    keyHandle.realm,
    hexToBytes(keyHandle.vaultId),
    hexToBytes(objectId),
    1,
    65_536,
    snapshotId,
    snapshotRevision,
    new Uint8Array(32).fill(0x16),
    new Uint8Array(32).fill(0x17),
    pageIndex,
    pageCount,
    new Uint8Array(32).fill(0x18),
  ]);
  const body = new Uint8Array(65_564);
  return Object.freeze({
    formatVersion: 1 as const,
    kindCode: 2 as const,
    realm: keyHandle.realm,
    vaultId: keyHandle.vaultId,
    objectId,
    generation: 1,
    paddedLength: 65_536 as const,
    digest: bytesToHex(encryptedWalletBackupObjectDigest(aad, body)),
    aad,
    body,
  });
}
