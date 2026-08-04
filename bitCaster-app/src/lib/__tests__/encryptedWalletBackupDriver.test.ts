// @vitest-environment node
import "fake-indexeddb/auto";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createEncryptedWalletBackupKeyHandle,
  EncryptedWalletBackupDeadlineError,
  EncryptedWalletBackupRemoteBackoffError,
  encryptedWalletBackupRequestDigest,
  prepareBoundedEncryptedWalletBackupManifestTarget,
  prepareEncryptedWalletBackupRequestProof,
  readAuthenticatedEncryptedWalletBackupHead,
  type EncryptedWalletBackupRequestProof,
} from "@bitcaster/client-sdk/encryptedWalletBackup";
import { EncryptedWalletBackupHttpTransportError } from "@bitcaster/client-sdk/encryptedWalletBackupHttpAdapter";
import { decodeEncryptedWalletBackupSnapshotCleanupJob } from "@bitcaster/client-sdk/encryptedWalletBackupSnapshotCleanup";
import { encodeCanonicalBackupCbor } from "@bitcaster/client-sdk/encryptedWalletBackupCbor";
import { encodeEncryptedWalletBackupHttpResponse } from "@bitcaster/client-sdk/encryptedWalletBackupHttpCodec";
import { encryptedWalletBackupObjectDigest } from "@bitcaster/client-sdk/encryptedWalletBackupObjectDigest";
import { sealBoundedEncryptedWalletBackupUploadAttempt } from "@bitcaster/client-sdk/encryptedWalletBackupSync";
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from "@bitcaster/client-sdk/durableCustody";
import { issueBoundedManifestTargetCapabilityForTest } from "../../../../bitcaster-client-sdk/src/encryptedWalletBackupManifestTargetAuthority";
import {
  ENCRYPTED_WALLET_BACKUP_EMPTY_REFERENCE_SET_DIGEST,
  issueEncryptedWalletBackupFrozenSnapshotControl,
} from "../../../../bitcaster-client-sdk/src/encryptedWalletBackupSnapshotAuthority";
import { browserWalletDatabaseName } from "@/lib/browserWalletProfile";
import {
  retryMinimumDelayMilliseconds,
  runEncryptedWalletBackupDriverCycle,
} from "../encryptedWalletBackupDriver";
import { EncryptedWalletBackupEnrollmentDexieStore } from "../../stores/encrypted-wallet-backup-enrollment-db";
import { createEncryptedWalletBackupUploadCoordinatorDexieStore } from "../../stores/encrypted-wallet-backup-upload-coordinator-db";
import { runEncryptedWalletBackupSnapshotCleanupPage } from "../../stores/encrypted-wallet-backup-snapshot-cleanup-db";
import { BitcasterDB } from "../../stores/proof-db";

const realm = "bitcaster.local";
const signedOrigin = "https://encrypted-backup.local";
const transportOrigin = "http://localhost:4970";
const seed = new Uint8Array(64).fill(9);
const scopeId = deriveDurableCustodyScopeId({
  scopeKind: "wallet",
  walletId: deriveDurableCustodyWalletId(seed),
});
const databases: BitcasterDB[] = [];
const walletLockManager = {
  request: async (_name: string, _options: LockOptions, action: () => Promise<unknown>) => action(),
};

beforeEach(() => {
  vi.stubGlobal("navigator", { locks: walletLockManager });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  const opened = databases.splice(0);
  for (const database of opened) database.close();
  for (const database of opened) await database.delete();
});

it("reopens a durable attempt and performs bounded object PUTs plus one head CAS", async () => {
  const database = openDatabase();
  const fixture = await targetFixture();
  await seedEnrollment(database, fixture.keyHandle);
  await sealBoundedEncryptedWalletBackupUploadAttempt({
    attemptId: "77".repeat(16),
    ownerId: "driver-owner",
    leaseDurationMilliseconds: 60_000,
    keyHandle: fixture.keyHandle,
    target: fixture.target,
    store: createEncryptedWalletBackupUploadCoordinatorDexieStore(database),
  });

  database.close();
  const restarted = new BitcasterDB(database.name);
  databases.push(restarted);
  const objectPaths = fixture.objects.map(
    (object) =>
      `/v1/encrypted-wallet-backup/realms/${realm}/vaults/${fixture.keyHandle.vaultId}/objects/${object.objectId}`,
  );
  const casPath = `/v1/encrypted-wallet-backup/realms/${realm}/vaults/${fixture.keyHandle.vaultId}/head:compare-and-swap`;
  const headPath = `/v1/encrypted-wallet-backup/realms/${realm}/vaults/${fixture.keyHandle.vaultId}/head`;
  const observed = { inFlight: 0, maximumInFlight: 0, putBytes: 0, requests: [] as string[] };
  const result = await runEncryptedWalletBackupDriverCycle({
    configuration: { realm, signedOrigin, transportOrigin },
    database: restarted,
    scopeId,
    keyHandle: fixture.keyHandle,
    ownerId: "driver-owner",
    signal: AbortSignal.timeout(60_000),
    clock: { nowUnixSeconds: () => 1_700_000_000 },
    source: fixture.source,
    fetch: async (resource, init) => {
      const url = String(resource);
      const pathname = new URL(url).pathname;
      const requestDigest = digestFromAuthorization(init);
      observed.requests.push(`${init?.method} ${pathname}`);
      observed.inFlight += 1;
      observed.maximumInFlight = Math.max(observed.maximumInFlight, observed.inFlight);
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        if (init?.method === "PUT" && objectPaths.includes(pathname)) {
          const body = init.body as Uint8Array;
          observed.putBytes += body.byteLength;
          return cborResponse(
            url,
            encodeEncryptedWalletBackupHttpResponse({
              kind: "object-put-result",
              requestDigest,
              result: "stored",
            }),
          );
        }
        if (init?.method === "POST" && pathname === casPath) {
          return cborResponse(
            url,
            encodeEncryptedWalletBackupHttpResponse({
              kind: "head-cas-result",
              requestDigest,
              result: "committed",
            }),
          );
        }
        if (init?.method === "GET" && pathname === headPath) {
          return cborResponse(
            url,
            encodeEncryptedWalletBackupHttpResponse({
              kind: "head-result",
              requestDigest,
              result: "found",
              enrollmentEpoch: 1,
              canonicalHead: fixture.target.wire.canonicalHead,
              canonicalReferenceSet: fixture.target.wire.canonicalReferenceSet,
            }),
          );
        }
        throw new Error(`unexpected backup network request: ${init?.method} ${pathname}`);
      } finally {
        observed.inFlight -= 1;
      }
    },
  });

  expect(result).toEqual({
    state: "committed",
    attemptId: "77".repeat(16),
    vaultId: fixture.keyHandle.vaultId,
  });
  expect(observed.requests).toHaveLength(objectPaths.length + 2);
  expect(observed.requests).toEqual(
    expect.arrayContaining([
      ...objectPaths.map((path) => `PUT ${path}`),
      `POST ${casPath}`,
      `GET ${headPath}`,
    ]),
  );
  expect(observed.maximumInFlight).toBeLessThanOrEqual(4);
  expect(observed.putBytes).toBeLessThanOrEqual(1_048_576);
  expect(observed.putBytes).toBeGreaterThan(0);
  expect(
    (
      await restarted.encryptedWalletBackupSnapshotCleanupJobs.get([
        realm,
        fixture.keyHandle.vaultId,
      ])
    )?.job,
  ).toMatchObject({
    acknowledgedGeneration: 1,
    localSnapshotId: "driver-test",
    localSnapshotRevision: 1,
    phase: "prepared-sources",
    cursor: null,
  });
});

it("continues cleanup pages without network work or a remount", async () => {
  const database = openDatabase();
  const fixture = await targetFixture();
  await database.encryptedWalletBackupSnapshotCleanupJobs.put({
    realm,
    vaultId: fixture.keyHandle.vaultId,
    job: decodeEncryptedWalletBackupSnapshotCleanupJob({
      schemaVersion: 1,
      realm,
      vaultId: fixture.keyHandle.vaultId,
      acknowledgedGeneration: 2,
      localSnapshotId: "current",
      localSnapshotRevision: 1,
      phase: "manifest-pages",
      cursor: null,
    }),
  });
  await database.encryptedWalletBackupManifestPages.bulkAdd(
    Array.from({ length: 300 }, (_, pageIndex) => ({
      realm,
      vaultId: fixture.keyHandle.vaultId,
      snapshotId: "obsolete",
      snapshotRevision: 0,
      generation: 1,
      pageIndex,
      objectId: objectId(100 + pageIndex),
      digest: "aa".repeat(32),
      canonical: new Uint8Array(32),
    })),
  );
  const fetch = vi.fn(async () => {
    throw new Error("cleanup must not use the network");
  });
  const input = {
    configuration: { realm, signedOrigin, transportOrigin },
    database,
    scopeId,
    keyHandle: fixture.keyHandle,
    ownerId: "cleanup-owner",
    signal: AbortSignal.timeout(60_000),
    fetch,
  };
  expect(await runEncryptedWalletBackupDriverCycle(input)).toEqual({ state: "cleanup-pending" });
  expect(await runEncryptedWalletBackupDriverCycle(input)).toEqual({ state: "cleanup-pending" });
  expect(await runEncryptedWalletBackupDriverCycle(input)).toEqual({
    state: "idle-needs-snapshot",
  });
  expect(await database.encryptedWalletBackupManifestPages.count()).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps an SDK-decoded active upload snapshot tuple", async () => {
  const database = openDatabase();
  const fixture = await targetFixture();
  await sealBoundedEncryptedWalletBackupUploadAttempt({
    attemptId: "99".repeat(16),
    ownerId: "active-owner",
    leaseDurationMilliseconds: 60_000,
    keyHandle: fixture.keyHandle,
    target: fixture.target,
    store: createEncryptedWalletBackupUploadCoordinatorDexieStore(database),
  });
  await database.encryptedWalletBackupSnapshotCleanupJobs.put({
    realm,
    vaultId: fixture.keyHandle.vaultId,
    job: decodeEncryptedWalletBackupSnapshotCleanupJob({
      schemaVersion: 1,
      realm,
      vaultId: fixture.keyHandle.vaultId,
      acknowledgedGeneration: 2,
      localSnapshotId: "current",
      localSnapshotRevision: 1,
      phase: "manifest-pages",
      cursor: null,
    }),
  });
  await database.encryptedWalletBackupManifestPages.add({
    realm,
    vaultId: fixture.keyHandle.vaultId,
    snapshotId: "driver-test",
    snapshotRevision: 1,
    generation: 1,
    pageIndex: 0,
    objectId: objectId(400),
    digest: "aa".repeat(32),
    canonical: new Uint8Array(32),
  });
  await runEncryptedWalletBackupSnapshotCleanupPage({
    database,
    scopeId,
    realm,
    vaultId: fixture.keyHandle.vaultId,
  });
  expect(await database.encryptedWalletBackupManifestPages.count()).toBe(1);
  expect(await database.encryptedWalletBackupUploadAttempts.count()).toBe(1);
});

it("resumes rejected-fork cleanup after abort backoff and deletes its partition", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
  try {
    const database = openDatabase();
    const fixture = await targetFixture();
    const competitor = await targetFixture({
      snapshotNonce: "44".repeat(16),
      snapshotId: "competing-snapshot",
      objectOffset: 10,
    });
    await seedEnrollment(database, fixture.keyHandle);
    const attemptId = "88".repeat(16);
    await sealBoundedEncryptedWalletBackupUploadAttempt({
      attemptId,
      ownerId: "driver-owner",
      leaseDurationMilliseconds: 60_000,
      keyHandle: fixture.keyHandle,
      target: fixture.target,
      store: createEncryptedWalletBackupUploadCoordinatorDexieStore(database),
    });
    let aborts = 0;
    let restarting = false;
    const remote = {
      async executeAccountOperation() {
        throw new Error("unexpected enrollment");
      },
      async putObject() {
        if (restarting) throw new Error("restart repeated object PUT");
        return { status: "stored" as const };
      },
      async compareAndSwapCurrentHead() {
        if (restarting) throw new Error("restart repeated CAS");
        return { status: "conflict" as const };
      },
      async readCurrentHead() {
        if (restarting) throw new Error("restart repeated head read");
        return {
          status: "found" as const,
          enrollmentEpoch: 1,
          head: competitor.target.wire,
        };
      },
      async abortUploadAttempt({
        requestProof,
      }: Readonly<{ requestProof: EncryptedWalletBackupRequestProof }>) {
        aborts += 1;
        expect(requestProof.method).toBe("DELETE");
        expect(requestProof.url).toBe(
          `${signedOrigin}/v1/encrypted-wallet-backup/realms/${realm}/vaults/${fixture.keyHandle.vaultId}/upload-attempts/${attemptId}`,
        );
        return aborts === 1
          ? { status: "unavailable" as const, retryAfterSeconds: 5 }
          : { status: "abandoned" as const };
      },
    };
    const cycleInput = {
      configuration: { realm, signedOrigin, transportOrigin },
      database,
      scopeId,
      keyHandle: fixture.keyHandle,
      signal: AbortSignal.timeout(120_000),
      clock: { nowUnixSeconds: () => 1_700_000_000 },
      source: fixture.source,
      remote,
    };

    const deferred = await runEncryptedWalletBackupDriverCycle({
      ...cycleInput,
      ownerId: "driver-owner",
    });
    expect(deferred.state).toBe("retry-pending");
    if (deferred.state !== "retry-pending") {
      throw new Error("expected durable cleanup backoff");
    }
    expect(await database.encryptedWalletBackupUploadAttempts.count()).toBe(1);
    expect(await database.encryptedWalletBackupUploadCasAttempts.count()).toBe(1);

    const persistedAttempt = await database.encryptedWalletBackupUploadAttempts.get(attemptId);
    if (persistedAttempt === undefined) throw new Error("expected rejected upload attempt");
    restarting = true;
    vi.setSystemTime(
      Math.max(
        deferred.retryNotBeforeUnixMilliseconds,
        persistedAttempt.record.leaseExpiresAtUnixMilliseconds,
      ) + 1,
    );
    await expect(
      runEncryptedWalletBackupDriverCycle({
        ...cycleInput,
        ownerId: "restart-owner",
        signal: AbortSignal.timeout(120_000),
      }),
    ).resolves.toEqual({ state: "idle-needs-snapshot" });

    expect(aborts).toBe(2);
    expect(await database.encryptedWalletBackupUploadAttempts.count()).toBe(0);
    expect(await database.encryptedWalletBackupUploadCursors.count()).toBe(0);
    expect(await database.encryptedWalletBackupUploadBatches.count()).toBe(0);
    expect(await database.encryptedWalletBackupUploadCasAttempts.count()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("leaves an empty wallet idle without enrollment, signing, or remote I/O", async () => {
  const database = openDatabase();
  const fetch = vi.fn<typeof globalThis.fetch>();
  const enrollmentRead = vi.spyOn(EncryptedWalletBackupEnrollmentDexieStore.prototype, "read");

  await expect(
    runEncryptedWalletBackupDriverCycle({
      configuration: { realm, signedOrigin, transportOrigin },
      database,
      scopeId,
      keyHandle: await createEncryptedWalletBackupKeyHandle({ seed, realm }),
      ownerId: "driver-owner",
      signal: AbortSignal.timeout(60_000),
      fetch,
    }),
  ).resolves.toEqual({ state: "idle-needs-snapshot" });

  expect(enrollmentRead).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("waits for a foreign live lease without enrollment or network I/O", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
  try {
    const database = openDatabase();
    const fixture = await targetFixture();
    await sealBoundedEncryptedWalletBackupUploadAttempt({
      attemptId: "99".repeat(16),
      ownerId: "other-owner",
      leaseDurationMilliseconds: 60_000,
      keyHandle: fixture.keyHandle,
      target: fixture.target,
      store: createEncryptedWalletBackupUploadCoordinatorDexieStore(database),
    });
    const fetch = vi.fn<typeof globalThis.fetch>();
    const enrollmentRead = vi.spyOn(EncryptedWalletBackupEnrollmentDexieStore.prototype, "read");

    await expect(
      runEncryptedWalletBackupDriverCycle({
        configuration: { realm, signedOrigin, transportOrigin },
        database,
        scopeId,
        keyHandle: fixture.keyHandle,
        ownerId: "new-owner",
        signal: AbortSignal.timeout(60_000),
        fetch,
      }),
    ).resolves.toEqual({
      state: "lease-pending",
      wakeAtUnixMilliseconds: Date.now() + 60_000,
    });
    expect(enrollmentRead).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("waits for the active PUT lease after a short remote backoff", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
  try {
    const database = openDatabase();
    const fixture = await targetFixture();
    await seedEnrollment(database, fixture.keyHandle);
    await sealBoundedEncryptedWalletBackupUploadAttempt({
      attemptId: "aa".repeat(16),
      ownerId: "driver-owner",
      leaseDurationMilliseconds: 60_000,
      keyHandle: fixture.keyHandle,
      target: fixture.target,
      store: createEncryptedWalletBackupUploadCoordinatorDexieStore(database),
    });
    const remote = {
      async executeAccountOperation() {
        throw new Error("unexpected enrollment");
      },
      async putObject() {
        return {
          status: "rate-limited" as const,
          retryAfterSeconds: 5,
        };
      },
      async compareAndSwapCurrentHead() {
        throw new Error("unexpected CAS");
      },
      async readCurrentHead() {
        throw new Error("unexpected head read");
      },
      async abortUploadAttempt() {
        throw new Error("unexpected abort");
      },
    };

    const failed = await runEncryptedWalletBackupDriverCycle({
      configuration: { realm, signedOrigin, transportOrigin },
      database,
      scopeId,
      keyHandle: fixture.keyHandle,
      ownerId: "driver-owner",
      signal: AbortSignal.timeout(120_000),
      clock: { nowUnixSeconds: () => 1_700_000_000 },
      source: fixture.source,
      remote,
    });
    expect(failed.state).toBe("retry-pending");
    if (failed.state !== "retry-pending") {
      throw new Error("expected a durable retry boundary");
    }

    vi.setSystemTime(failed.retryNotBeforeUnixMilliseconds + 1);
    await expect(
      runEncryptedWalletBackupDriverCycle({
        configuration: { realm, signedOrigin, transportOrigin },
        database,
        scopeId,
        keyHandle: fixture.keyHandle,
        ownerId: "driver-owner",
        signal: AbortSignal.timeout(120_000),
        clock: { nowUnixSeconds: () => 1_700_000_000 },
        source: fixture.source,
        remote,
      }),
    ).resolves.toEqual({
      state: "lease-pending",
      wakeAtUnixMilliseconds: Date.parse("2026-08-05T00:00:00.000Z") + 60_000,
    });
  } finally {
    vi.useRealTimers();
  }
});

it("classifies only recoverable background failures for retry", () => {
  expect(
    retryMinimumDelayMilliseconds(new EncryptedWalletBackupRemoteBackoffError("rate-limited", 37)),
  ).toBe(37_000);
  expect(
    retryMinimumDelayMilliseconds(new EncryptedWalletBackupRemoteBackoffError("quota-exceeded")),
  ).toBeNull();
  expect(
    retryMinimumDelayMilliseconds(
      new EncryptedWalletBackupHttpTransportError("transport-failure", "uncertain"),
    ),
  ).toBe(5_000);
  expect(
    retryMinimumDelayMilliseconds(
      new EncryptedWalletBackupHttpTransportError("invalid-request", "not-dispatched"),
    ),
  ).toBeNull();
  expect(retryMinimumDelayMilliseconds(new EncryptedWalletBackupDeadlineError())).toBe(5_000);
  expect(retryMinimumDelayMilliseconds(new Error("terminal"))).toBeNull();
});

function openDatabase(): BitcasterDB {
  const database = new BitcasterDB(browserWalletDatabaseName(scopeId));
  databases.push(database);
  return database;
}

async function seedEnrollment(
  database: BitcasterDB,
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>,
): Promise<void> {
  const enrollment = new EncryptedWalletBackupEnrollmentDexieStore({
    database,
    scopeId,
    realm,
    vaultId: keyHandle.vaultId,
    requestAuthPublicKey: keyHandle.requestAuthPublicKey,
  });
  await enrollment.commitAccountOperationResult(
    {
      schemaVersion: 1,
      operationId: "11".repeat(16),
      intentDigest: "22".repeat(32),
      action: "enroll",
      realm,
      vaultId: keyHandle.vaultId,
      requestAuthPublicKey: keyHandle.requestAuthPublicKey,
      expectedEnrollmentEpoch: 0,
      observedEnrollmentEpoch: 1,
      lifecycle: "active",
      result: "committed",
    },
    () => undefined,
  );
}

async function targetFixture(
  options: Readonly<{
    snapshotNonce?: string;
    snapshotId?: string;
    objectOffset?: number;
  }> = {},
) {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({ seed, realm });
  const snapshotNonce = options.snapshotNonce ?? "33".repeat(16);
  const snapshotId = options.snapshotId ?? "driver-test";
  const objectOffset = options.objectOffset ?? 0;
  const control = issueEncryptedWalletBackupFrozenSnapshotControl(
    {},
    {
      realm,
      vaultId: keyHandle.vaultId,
      enrollmentEpoch: 1,
      parentGeneration: null,
      parentManifestDigest: null,
      parentReferenceSetDigest: ENCRYPTED_WALLET_BACKUP_EMPTY_REFERENCE_SET_DIGEST,
      generation: 1,
      snapshotNonce,
      snapshotId,
      snapshotRevision: 1,
    },
  );
  const parentEvidence = await readAuthenticatedEncryptedWalletBackupHead({
    keyHandle,
    enrollmentEpoch: 1,
    requestProof: await prepareEncryptedWalletBackupRequestProof({
      keyHandle,
      enrollmentEpoch: 1,
      method: "GET",
      url: `${signedOrigin}/v1/encrypted-wallet-backup/realms/${realm}/vaults/${keyHandle.vaultId}/head`,
      issuedAtUnixSeconds: 1_700_000_000,
      expiresAtUnixSeconds: 1_700_000_060,
      payload: new Uint8Array(),
      signal: AbortSignal.timeout(60_000),
    }),
    remote: {
      async readCurrentHead() {
        return { status: "not-found" as const };
      },
    },
  });
  const page = manifestPageObject(keyHandle, objectId(objectOffset), snapshotId);
  const chunks = [1, 2, 3].map((index) => chunkObject(keyHandle, objectId(objectOffset + index)));
  const objects = [page, ...chunks];
  const target = prepareBoundedEncryptedWalletBackupManifestTarget({
    keyHandle,
    capability: issueBoundedManifestTargetCapabilityForTest({
      keyHandle,
      control,
      parentEvidence,
      pages: [objectReference(page)],
      chunkReferences: chunks.map(objectReference),
      proofCount: chunks.length,
    }),
  });
  return {
    keyHandle,
    target,
    objects,
    source: {
      async readManifestPageObject(input: Readonly<{ objectId: string }>) {
        if (input.objectId !== page.objectId) throw new Error("manifest page object is absent");
        return page;
      },
      async readProofChunkObject(input: Readonly<{ objectId: string }>) {
        const object = chunks.find((candidate) => candidate.objectId === input.objectId);
        if (object === undefined) throw new Error("proof chunk object is absent");
        return object;
      },
    },
  };
}

function chunkObject(
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>,
  objectId: string,
) {
  const aad = encodeCanonicalBackupCbor([
    1,
    1,
    realm,
    hexToBytes(keyHandle.vaultId),
    hexToBytes(objectId),
    1,
    262_144,
  ]);
  const body = new Uint8Array(262_172);
  return {
    formatVersion: 1 as const,
    kindCode: 1 as const,
    realm,
    vaultId: keyHandle.vaultId,
    objectId,
    generation: 1,
    paddedLength: 262_144 as const,
    digest: bytesToHex(encryptedWalletBackupObjectDigest(aad, body)),
    aad,
    body,
  };
}

function manifestPageObject(
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupKeyHandle>>,
  objectId: string,
  snapshotId = "driver-test",
) {
  const aad = encodeCanonicalBackupCbor([
    1,
    "encrypted-wallet-backup-manifest-page-aad",
    2,
    realm,
    hexToBytes(keyHandle.vaultId),
    hexToBytes(objectId),
    1,
    65_536,
    snapshotId,
    1,
    new Uint8Array(32).fill(0x16),
    new Uint8Array(32).fill(0x17),
    0,
    1,
    new Uint8Array(32).fill(0x18),
  ]);
  const body = new Uint8Array(65_564);
  return {
    formatVersion: 1 as const,
    kindCode: 2 as const,
    realm,
    vaultId: keyHandle.vaultId,
    objectId,
    generation: 1,
    paddedLength: 65_536 as const,
    digest: bytesToHex(encryptedWalletBackupObjectDigest(aad, body)),
    aad,
    body,
  };
}

function objectReference(object: {
  readonly formatVersion: 1;
  readonly kindCode: 1 | 2;
  readonly realm: string;
  readonly vaultId: string;
  readonly objectId: string;
  readonly generation: number;
  readonly paddedLength: 65_536 | 262_144;
  readonly digest: string;
}) {
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
}

function objectId(index: number): string {
  return index.toString(16).padStart(32, "0");
}

function digestFromAuthorization(init: RequestInit | undefined): string {
  const authorization = new Headers(init?.headers).get("authorization");
  if (authorization === null || !authorization.startsWith("BackupV1 ")) {
    throw new Error("backup request authorization is absent");
  }
  const canonicalProof = fromBase64Url(authorization.slice("BackupV1 ".length));
  return encryptedWalletBackupRequestDigest(
    canonicalProof as unknown as EncryptedWalletBackupRequestProof,
  );
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function cborResponse(url: string, body: Uint8Array): Response {
  return {
    status: 200,
    url,
    redirected: false,
    headers: new Headers({
      "content-type": "application/cbor",
      "cache-control": "private, no-store",
    }),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    }),
  } as Response;
}
