// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { decodeEncryptedWalletBackupSnapshotCleanupJob } from "@bitcaster/client-sdk/encryptedWalletBackupSnapshotCleanup";
import type { EncryptedWalletBackupActiveUploadAttemptRecord } from "@bitcaster/client-sdk/encryptedWalletBackupSync";
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from "@bitcaster/client-sdk/durableCustody";
import { browserWalletDatabaseName } from "@/lib/browserWalletProfile";
import { runEncryptedWalletBackupSnapshotCleanupPage } from "../encrypted-wallet-backup-snapshot-cleanup-db";
import { BitcasterDB } from "../proof-db";

const realm = "cleanup.test";
const vaultId = "44".repeat(32);
const scopeId = deriveDurableCustodyScopeId({
  scopeKind: "wallet",
  walletId: deriveDurableCustodyWalletId(new Uint8Array(64).fill(4)),
});
const databases: BitcasterDB[] = [];
const lockManager = {
  request: async (_name: string, _options: LockOptions, action: () => Promise<unknown>) => action(),
} as unknown as Pick<LockManager, "request">;

afterEach(async () => {
  vi.restoreAllMocks();
  const opened = databases.splice(0);
  for (const database of opened) database.close();
  for (const database of opened) await database.delete();
});

it("rolls back an injected cleanup-job write fault", async () => {
  const database = openDatabase();
  await seedManifestCleanup(database, 1);
  const initial = await database.encryptedWalletBackupSnapshotCleanupJobs.get([realm, vaultId]);
  expect(initial?.job.cursor).toBeNull();

  vi.spyOn(database.encryptedWalletBackupSnapshotCleanupJobs, "put").mockRejectedValueOnce(
    new Error("injected cleanup job write fault"),
  );
  await expect(runPage(database)).rejects.toThrow(/injected/);
  expect(await database.encryptedWalletBackupManifestPages.count()).toBe(3);
  expect(
    (await database.encryptedWalletBackupSnapshotCleanupJobs.get([realm, vaultId]))?.job.cursor,
  ).toBeNull();
});

it("resumes the exact persisted manifest-page cursor after restart", async () => {
  const database = openDatabase();
  await seedManifestCleanup(database, 257);

  const first = await runPage(database);
  expect(first).toMatchObject({ state: "progress", readRows: 256, deletedRows: 256 });
  const persisted = await database.encryptedWalletBackupSnapshotCleanupJobs.get([realm, vaultId]);
  expect(persisted?.job.cursor).toEqual({
    phase: "manifest-pages",
    generation: 1,
    snapshotId: "obsolete",
    snapshotRevision: 0,
    pageIndex: 255,
  });

  database.close();
  const restarted = new BitcasterDB(database.name);
  databases.push(restarted);
  const second = await runPage(restarted);
  expect(second).toMatchObject({ state: "progress", readRows: 2, deletedRows: 1 });
  expect(
    await restarted.encryptedWalletBackupManifestPages.get([realm, vaultId, "current", 3, 0]),
  ).toBeDefined();
  expect(
    await restarted.encryptedWalletBackupManifestPages.get([realm, vaultId, "newer", 0, 0]),
  ).toBeDefined();
  expect(await restarted.encryptedWalletBackupUploadAttempts.count()).toBe(0);
});

it("fails closed when a persisted cursor or profile is substituted", async () => {
  const database = openDatabase();
  await database.encryptedWalletBackupSnapshotCleanupJobs.put({
    realm,
    vaultId,
    job: {
      ...cleanupJob(),
      cursor: {
        phase: "snapshot-pins",
        generation: 1,
        snapshotId: "obsolete",
        snapshotRevision: 0,
        recordId: "00".repeat(32),
        commitment: "11".repeat(32),
      },
    } as never,
  });
  await expect(runPage(database)).rejects.toThrow(/cursor phase/);
  await database.encryptedWalletBackupSnapshotCleanupJobs.clear();
  await database.encryptedWalletBackupSnapshotCleanupJobs.put({
    realm,
    vaultId,
    job: { ...cleanupJob(), vaultId: "55".repeat(32) },
  });
  await expect(runPage(database)).rejects.toThrow(/profile/);
});

it("rolls back when an active upload row is malformed", async () => {
  const database = openDatabase();
  await database.encryptedWalletBackupSnapshotCleanupJobs.put({
    realm,
    vaultId,
    job: cleanupJob(),
  });
  await database.encryptedWalletBackupManifestPages.add(page("obsolete", 0, 1, 0));
  await database.encryptedWalletBackupUploadAttempts.add({
    attemptId: "66".repeat(16),
    realm,
    vaultId,
    record: malformedActiveUploadRecord(),
  });
  await expect(runPage(database)).rejects.toThrow(/active backup upload attempt|active upload/);
  expect(await database.encryptedWalletBackupManifestPages.count()).toBe(1);
});

it("uses the active metadata phase for a control-table cursor", async () => {
  const database = openDatabase();
  await database.encryptedWalletBackupSnapshotCleanupJobs.put({
    realm,
    vaultId,
    job: { ...cleanupJob(), phase: "manifest-pass-a-results" },
  });
  await database.encryptedWalletBackupManifestPassAResults.add({
    scopeKey: "pass-a-obsolete",
    realm,
    vaultId,
    generation: 1,
    snapshotId: "obsolete",
    snapshotRevision: 0,
    canonical: new Uint8Array(16),
  });
  const result = await runPage(database);
  expect(result).toMatchObject({ state: "progress", deletedRows: 1 });
  expect(
    (await database.encryptedWalletBackupSnapshotCleanupJobs.get([realm, vaultId]))?.job,
  ).toMatchObject({
    phase: "manifest-cursors",
    cursor: null,
  });
});

it("resumes prepared-source namespace removal after restart", async () => {
  const database = openDatabase();
  await database.encryptedWalletBackupSnapshotCleanupJobs.put({
    realm,
    vaultId,
    job: { ...cleanupJob(), phase: "prepared-sources" },
  });
  await database.encryptedWalletBackupPreparedSources.bulkAdd(
    Array.from({ length: 65 }, (_, index) => source("obsolete", 0, 1, index)),
  );
  await database.encryptedWalletBackupPreparedSources.bulkAdd([
    source("current", 3, 2, 66),
    source("newer", 0, 3, 67),
  ]);
  const first = await runPage(database);
  expect(first).toMatchObject({ state: "progress", readRows: 64, deletedRows: 64 });
  database.close();
  const restarted = new BitcasterDB(database.name);
  databases.push(restarted);
  const second = await runPage(restarted);
  expect(second).toMatchObject({ state: "progress", readRows: 2, deletedRows: 1 });
  expect(await restarted.encryptedWalletBackupPreparedSources.count()).toBe(2);
});

it("counts retained pin keys in the prepared-source page budget", async () => {
  const database = openDatabase();
  const sources = Array.from({ length: 64 }, (_, index) => source("obsolete", 0, 1, index));
  await database.encryptedWalletBackupSnapshotCleanupJobs.put({
    realm,
    vaultId,
    job: { ...cleanupJob(), phase: "prepared-sources" },
  });
  await database.encryptedWalletBackupPreparedSources.bulkAdd(sources);
  await database.encryptedWalletBackupSnapshotPins.bulkAdd(
    sources.map((retained) => ({
      realm,
      vaultId,
      snapshotId: "newer",
      snapshotRevision: 0,
      generation: 3,
      recordKindCode: 0 as const,
      recordId: retained.recordId,
      commitment: retained.commitment,
      sourceRevision: retained.revision,
      sourceBodyReference: retained.bodyReference,
      canonical: new Uint8Array(32),
    })),
  );

  const result = await runPage(database);

  expect(result).toMatchObject({ state: "progress", readRows: 128, deletedRows: 0 });
  expect(await database.encryptedWalletBackupPreparedSources.count()).toBe(64);
});

it("keeps a prepared source that a retained snapshot pin reuses", async () => {
  const database = openDatabase();
  const retained = source("obsolete", 0, 1, 7);
  await database.encryptedWalletBackupSnapshotCleanupJobs.put({
    realm,
    vaultId,
    job: { ...cleanupJob(), phase: "prepared-sources" },
  });
  await database.encryptedWalletBackupPreparedSources.add(retained);
  await database.encryptedWalletBackupSnapshotPins.add({
    realm,
    vaultId,
    snapshotId: "newer",
    snapshotRevision: 0,
    generation: 3,
    recordKindCode: 0,
    recordId: retained.recordId,
    commitment: retained.commitment,
    sourceRevision: retained.revision,
    sourceBodyReference: retained.bodyReference,
    canonical: new Uint8Array(32),
  });
  await runPage(database);
  expect(await database.encryptedWalletBackupPreparedSources.count()).toBe(1);
});

function cleanupJob() {
  return decodeEncryptedWalletBackupSnapshotCleanupJob({
    schemaVersion: 1,
    realm,
    vaultId,
    acknowledgedGeneration: 2,
    localSnapshotId: "current",
    localSnapshotRevision: 3,
    phase: "manifest-pages",
    cursor: null,
  });
}

async function seedManifestCleanup(database: BitcasterDB, obsoleteCount: number): Promise<void> {
  await database.encryptedWalletBackupSnapshotCleanupJobs.put({
    realm,
    vaultId,
    job: cleanupJob(),
  });
  await database.encryptedWalletBackupManifestPages.bulkAdd(
    Array.from({ length: obsoleteCount }, (_, pageIndex) => page("obsolete", 0, 1, pageIndex)),
  );
  await database.encryptedWalletBackupManifestPages.bulkAdd([
    page("current", 3, 2, 0),
    page("newer", 0, 3, 0),
  ]);
}

function page(snapshotId: string, snapshotRevision: number, generation: number, pageIndex: number) {
  return {
    realm,
    vaultId,
    snapshotId,
    snapshotRevision,
    generation,
    pageIndex,
    objectId: `object-${snapshotId}-${pageIndex}`,
    digest: "aa".repeat(32),
    canonical: new Uint8Array(32),
  };
}

function source(snapshotId: string, snapshotRevision: number, generation: number, index: number) {
  const recordId = index.toString(16).padStart(64, "0");
  const bodyReference = (index + 1_000).toString(16).padStart(64, "0");
  const commitment = (index + 2_000).toString(16).padStart(64, "0");
  return {
    realm,
    vaultId,
    generation,
    snapshotId,
    snapshotRevision,
    recordKindCode: 0 as const,
    recordId,
    commitment,
    bodyReference,
    revision: 0,
    canonicalDescriptor: new Uint8Array(32),
  };
}

function malformedActiveUploadRecord(): EncryptedWalletBackupActiveUploadAttemptRecord {
  return {
    localSnapshotId: "obsolete",
    localSnapshotRevision: 0,
  } as unknown as EncryptedWalletBackupActiveUploadAttemptRecord;
}

function runPage(database: BitcasterDB) {
  return runEncryptedWalletBackupSnapshotCleanupPage({
    database,
    scopeId,
    realm,
    vaultId,
    lockManager,
  });
}

function openDatabase(): BitcasterDB {
  const database = new BitcasterDB(browserWalletDatabaseName(scopeId));
  databases.push(database);
  return database;
}
