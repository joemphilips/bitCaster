import type { SealedEncryptedWalletBackupSyncAttempt } from "@bitcaster/client-sdk/encryptedWalletBackup";
import { decodeActiveUploadAttemptRecord } from "@bitcaster/client-sdk/encryptedWalletBackupSync";
import {
  advanceEncryptedWalletBackupSnapshotCleanup,
  decodeEncryptedWalletBackupSnapshotCleanupJob,
  startOrSupersedeEncryptedWalletBackupSnapshotCleanup,
  ENCRYPTED_WALLET_BACKUP_SNAPSHOT_CLEANUP_BYTE_MAX,
  ENCRYPTED_WALLET_BACKUP_SNAPSHOT_CLEANUP_ROW_MAX,
  type EncryptedWalletBackupSnapshotCleanupCursor,
  type EncryptedWalletBackupSnapshotCleanupJob,
} from "@bitcaster/client-sdk/encryptedWalletBackupSnapshotCleanup";
import { browserWalletDatabaseName } from "../lib/browserWalletProfile";
import { withWalletProfileLock } from "../lib/walletProfileLock";
import type {
  BitcasterDB,
  EncryptedWalletBackupDexieControlRow,
  EncryptedWalletBackupDexieManifestPageRow,
  EncryptedWalletBackupDexiePreparedSourceRow,
  EncryptedWalletBackupDexieSnapshotPinRow,
} from "./proof-db";

type WalletLockManager = Pick<LockManager, "request">;

const PREPARED_SOURCE_CLEANUP_ROW_MAX = 64;
const PREPARED_SOURCE_REFERENCE_KEY_MAX_BYTES = 2_048;
const PREPARED_SOURCE_CLEANUP_BYTE_MAX =
  ENCRYPTED_WALLET_BACKUP_SNAPSHOT_CLEANUP_BYTE_MAX -
  PREPARED_SOURCE_CLEANUP_ROW_MAX * PREPARED_SOURCE_REFERENCE_KEY_MAX_BYTES;

export type EncryptedWalletBackupSnapshotCleanupRunResult =
  | Readonly<{ state: "idle" }>
  | Readonly<{
      state: "progress";
      job: EncryptedWalletBackupSnapshotCleanupJob | null;
      readRows: number;
      deletedRows: number;
    }>;

export interface RunEncryptedWalletBackupSnapshotCleanupInput {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly realm: string;
  readonly vaultId: string;
  readonly acknowledgedAttempt?: SealedEncryptedWalletBackupSyncAttempt;
  readonly lockManager?: WalletLockManager;
}

/** Runs one indexed cleanup page under the browser wallet-profile lock. */
export async function runEncryptedWalletBackupSnapshotCleanupPage(
  input: RunEncryptedWalletBackupSnapshotCleanupInput,
): Promise<EncryptedWalletBackupSnapshotCleanupRunResult> {
  requireProfile(input);
  if (input.acknowledgedAttempt === undefined) {
    const existing = await input.database.encryptedWalletBackupSnapshotCleanupJobs.get([
      input.realm,
      input.vaultId,
    ]);
    if (existing === undefined) return Object.freeze({ state: "idle" });
  }
  return withWalletProfileLock(input.scopeId, () => runLockedPage(input), input.lockManager);
}

async function runLockedPage(
  input: RunEncryptedWalletBackupSnapshotCleanupInput,
): Promise<EncryptedWalletBackupSnapshotCleanupRunResult> {
  return input.database.transaction("rw", cleanupTransactionTables(input.database), async () => {
    const key = [input.realm, input.vaultId] as [string, string];
    const persisted = await input.database.encryptedWalletBackupSnapshotCleanupJobs.get(key);
    const current =
      persisted === undefined
        ? null
        : decodeJobForProfile(persisted.job, input.realm, input.vaultId);
    const job =
      input.acknowledgedAttempt === undefined
        ? current
        : startOrSupersedeEncryptedWalletBackupSnapshotCleanup(current, input.acknowledgedAttempt);
    if (job === null) return Object.freeze({ state: "idle" as const });
    const protectedTuple = await readActiveTuple(input.database, input.realm, input.vaultId);
    const page = await readAndDeletePage(input.database, job, protectedTuple);
    const next = advanceEncryptedWalletBackupSnapshotCleanup(job, page);
    if (next === null) await input.database.encryptedWalletBackupSnapshotCleanupJobs.delete(key);
    else {
      await input.database.encryptedWalletBackupSnapshotCleanupJobs.put({
        realm: input.realm,
        vaultId: input.vaultId,
        job: next,
      });
    }
    return Object.freeze({
      state: "progress" as const,
      job: next,
      readRows: page.readRows,
      deletedRows: page.deletedRows,
    });
  });
}

function cleanupTransactionTables(database: BitcasterDB) {
  return [
    database.encryptedWalletBackupSnapshotCleanupJobs,
    database.encryptedWalletBackupPreparedSources,
    database.encryptedWalletBackupSnapshotControls,
    database.encryptedWalletBackupSnapshotPins,
    database.encryptedWalletBackupManifestPassAResults,
    database.encryptedWalletBackupManifestCursors,
    database.encryptedWalletBackupManifestPages,
    database.encryptedWalletBackupUploadAttempts,
  ];
}

function decodeJobForProfile(
  value: unknown,
  realm: string,
  vaultId: string,
): EncryptedWalletBackupSnapshotCleanupJob {
  const job = decodeEncryptedWalletBackupSnapshotCleanupJob(value);
  if (job.realm !== realm || job.vaultId !== vaultId)
    throw new Error("backup cleanup job profile is invalid");
  return job;
}

async function readActiveTuple(
  database: BitcasterDB,
  realm: string,
  vaultId: string,
): Promise<Readonly<{ snapshotId: string; snapshotRevision: number }> | null> {
  const active = await database.encryptedWalletBackupUploadAttempts
    .where("[realm+vaultId]")
    .equals([realm, vaultId])
    .first();
  if (active === undefined) return null;
  if (
    active.attemptId !== active.record.attemptId ||
    active.realm !== realm ||
    active.vaultId !== vaultId
  )
    throw new Error("backup cleanup active upload row is invalid");
  const record = decodeActiveUploadAttemptRecord(active.record);
  if (record.attemptId !== active.attemptId || record.realm !== realm || record.vaultId !== vaultId)
    throw new Error("backup cleanup active upload record is invalid");
  return Object.freeze({
    snapshotId: record.localSnapshotId,
    snapshotRevision: record.localSnapshotRevision,
  });
}

async function readAndDeletePage(
  database: BitcasterDB,
  job: EncryptedWalletBackupSnapshotCleanupJob,
  protectedTuple: Readonly<{ snapshotId: string; snapshotRevision: number }> | null,
) {
  switch (job.phase) {
    case "prepared-sources":
      return scanPreparedSources(database, job, protectedTuple);
    case "snapshot-pins":
      return scanRows(database.encryptedWalletBackupSnapshotPins, job, protectedTuple, (row) =>
        pinRow(row as EncryptedWalletBackupDexieSnapshotPinRow),
      );
    case "manifest-pass-a-results":
      return scanRows(
        database.encryptedWalletBackupManifestPassAResults,
        job,
        protectedTuple,
        (row) => controlRow(row as EncryptedWalletBackupDexieControlRow, "manifest-pass-a-results"),
      );
    case "manifest-cursors":
      return scanRows(database.encryptedWalletBackupManifestCursors, job, protectedTuple, (row) =>
        controlRow(row as EncryptedWalletBackupDexieControlRow, "manifest-cursors"),
      );
    case "manifest-pages":
      return scanRows(database.encryptedWalletBackupManifestPages, job, protectedTuple, (row) =>
        pageRow(row as EncryptedWalletBackupDexieManifestPageRow),
      );
    case "snapshot-controls":
      return scanRows(database.encryptedWalletBackupSnapshotControls, job, protectedTuple, (row) =>
        controlRow(row as EncryptedWalletBackupDexieControlRow, "snapshot-controls"),
      );
    default:
      return assertNever(job.phase);
  }
}

function scanPreparedSources(
  database: BitcasterDB,
  job: EncryptedWalletBackupSnapshotCleanupJob,
  protectedTuple: Readonly<{ snapshotId: string; snapshotRevision: number }> | null,
) {
  return scanRows(
    database.encryptedWalletBackupPreparedSources,
    job,
    protectedTuple,
    (row) => sourceRow(row as EncryptedWalletBackupDexiePreparedSourceRow),
    async (row) => {
      const source = row as EncryptedWalletBackupDexiePreparedSourceRow;
      const pinKeys = await database.encryptedWalletBackupSnapshotPins
        .where("[realm+vaultId+recordKindCode+recordId+sourceRevision+sourceBodyReference]")
        .equals([
          source.realm,
          source.vaultId,
          source.recordKindCode,
          source.recordId,
          source.revision,
          source.bodyReference,
        ])
        .limit(1)
        .primaryKeys();
      const pinKey = pinKeys[0];
      if (pinKey === undefined)
        return Object.freeze({ canDelete: true, readRows: 0, readBytes: 0 });
      const readBytes = indexedKeyBytes(pinKey);
      if (readBytes > PREPARED_SOURCE_REFERENCE_KEY_MAX_BYTES)
        throw new Error("backup cleanup prepared-source reference key is too large");
      return Object.freeze({ canDelete: false, readRows: 1, readBytes });
    },
    {
      rowMax: PREPARED_SOURCE_CLEANUP_ROW_MAX,
      byteMax: PREPARED_SOURCE_CLEANUP_BYTE_MAX,
    },
  );
}

type MetadataRow = Readonly<{
  generation: number;
  snapshotId: string;
  snapshotRevision: number;
  canonical?: Uint8Array;
  canonicalDescriptor?: Uint8Array;
}>;

async function scanRows<Row extends MetadataRow>(
  table: {
    where(index: string): {
      between(
        lower: readonly unknown[],
        upper: readonly unknown[],
        includeLower: boolean,
        includeUpper: boolean,
      ): {
        until(
          stop: (value: Row) => boolean,
          includeStopEntry?: boolean,
        ): { toArray(): Promise<Row[]> };
      };
    };
    bulkDelete(keys: readonly unknown[]): Promise<void>;
  },
  job: EncryptedWalletBackupSnapshotCleanupJob,
  protectedTuple: Readonly<{ snapshotId: string; snapshotRevision: number }> | null,
  row: (
    value: Row,
  ) => Readonly<{ key: unknown; cursor: EncryptedWalletBackupSnapshotCleanupCursor }>,
  inspectReference?: (
    value: Row,
  ) => Promise<Readonly<{ canDelete: boolean; readRows: number; readBytes: number }>>,
  candidateLimit: Readonly<{ rowMax: number; byteMax: number }> = Object.freeze({
    rowMax: ENCRYPTED_WALLET_BACKUP_SNAPSHOT_CLEANUP_ROW_MAX,
    byteMax: ENCRYPTED_WALLET_BACKUP_SNAPSHOT_CLEANUP_BYTE_MAX,
  }),
) {
  let cursor = job.cursor;
  let readRows = 0;
  let deletedRows = 0;
  let readBytes = 0;
  const deleteKeys: unknown[] = [];
  let stopped = false;
  const candidates = await nextRows(table, job, cursor, (candidate) => {
    const bytes = canonicalBytes(candidate).byteLength;
    if (bytes < 0 || bytes > ENCRYPTED_WALLET_BACKUP_SNAPSHOT_CLEANUP_BYTE_MAX)
      throw new Error("backup cleanup metadata row is too large");
    if (readRows === candidateLimit.rowMax || readBytes + bytes > candidateLimit.byteMax) {
      stopped = true;
      return true;
    }
    readRows += 1;
    readBytes += bytes;
    return false;
  });
  for (const candidate of candidates) {
    const identified = row(candidate);
    cursor = identified.cursor;
    const reference =
      inspectReference === undefined
        ? Object.freeze({ canDelete: true, readRows: 0, readBytes: 0 })
        : await inspectReference(candidate);
    readRows += reference.readRows;
    readBytes += reference.readBytes;
    if (
      readRows > ENCRYPTED_WALLET_BACKUP_SNAPSHOT_CLEANUP_ROW_MAX ||
      readBytes > ENCRYPTED_WALLET_BACKUP_SNAPSHOT_CLEANUP_BYTE_MAX
    )
      throw new Error("backup cleanup combined read budget is invalid");
    if (isObsolete(job, candidate, protectedTuple) && reference.canDelete) {
      deleteKeys.push(identified.key);
      deletedRows += 1;
    }
  }
  await table.bulkDelete(deleteKeys);
  return Object.freeze({
    readRows,
    deletedRows,
    readBytes,
    nextCursor: stopped ? cursor : null,
    phaseComplete: !stopped,
  });
}

async function nextRows<Row extends MetadataRow>(
  table: {
    where(index: string): {
      between(
        lower: readonly unknown[],
        upper: readonly unknown[],
        includeLower: boolean,
        includeUpper: boolean,
      ): {
        until(
          stop: (value: Row) => boolean,
          includeStopEntry?: boolean,
        ): { toArray(): Promise<Row[]> };
      };
    };
  },
  job: EncryptedWalletBackupSnapshotCleanupJob,
  cursor: EncryptedWalletBackupSnapshotCleanupCursor | null,
  stop: (value: Row) => boolean,
): Promise<Row[]> {
  const index = indexFor(job.phase);
  const lower = lowerKey(job, cursor);
  const upper = upperKey(job);
  return table
    .where(index)
    .between(lower, upper, cursor === null, true)
    .until(stop, false)
    .toArray();
}

function indexFor(phase: EncryptedWalletBackupSnapshotCleanupJob["phase"]): string {
  switch (phase) {
    case "prepared-sources":
      return "[realm+vaultId+generation+snapshotId+snapshotRevision+recordKindCode+recordId+revision+bodyReference]";
    case "snapshot-pins":
      return "[realm+vaultId+generation+snapshotId+snapshotRevision+recordKindCode+recordId+commitment]";
    case "manifest-pages":
      return "[realm+vaultId+generation+snapshotId+snapshotRevision+pageIndex]";
    case "manifest-pass-a-results":
    case "manifest-cursors":
    case "snapshot-controls":
      return "[realm+vaultId+generation+snapshotId+snapshotRevision]";
    default:
      return assertNever(phase);
  }
}

function lowerKey(
  job: EncryptedWalletBackupSnapshotCleanupJob,
  cursor: EncryptedWalletBackupSnapshotCleanupCursor | null,
): readonly unknown[] {
  const base = [job.realm, job.vaultId];
  if (cursor === null) {
    switch (job.phase) {
      case "prepared-sources":
        return [...base, 1, "", 0, 0, "", 0, ""];
      case "snapshot-pins":
        return [...base, 1, "", 0, 0, "", ""];
      case "manifest-pages":
        return [...base, 1, "", 0, 0];
      default:
        return [...base, 1, "", 0];
    }
  }
  switch (cursor.phase) {
    case "prepared-sources":
      return [
        ...base,
        cursor.generation,
        cursor.snapshotId,
        cursor.snapshotRevision,
        0,
        cursor.recordId,
        cursor.revision,
        cursor.bodyReference,
      ];
    case "snapshot-pins":
      return [
        ...base,
        cursor.generation,
        cursor.snapshotId,
        cursor.snapshotRevision,
        0,
        cursor.recordId,
        cursor.commitment,
      ];
    case "manifest-pages":
      return [
        ...base,
        cursor.generation,
        cursor.snapshotId,
        cursor.snapshotRevision,
        cursor.pageIndex,
      ];
    default:
      return [...base, cursor.generation, cursor.snapshotId, cursor.snapshotRevision];
  }
}

function upperKey(job: EncryptedWalletBackupSnapshotCleanupJob): readonly unknown[] {
  const maxText = "\uffff";
  switch (job.phase) {
    case "prepared-sources":
      return [
        job.realm,
        job.vaultId,
        job.acknowledgedGeneration,
        maxText,
        Number.MAX_SAFE_INTEGER,
        0,
        maxText,
        Number.MAX_SAFE_INTEGER,
        maxText,
      ];
    case "snapshot-pins":
      return [
        job.realm,
        job.vaultId,
        job.acknowledgedGeneration,
        maxText,
        Number.MAX_SAFE_INTEGER,
        0,
        maxText,
        maxText,
      ];
    case "manifest-pages":
      return [
        job.realm,
        job.vaultId,
        job.acknowledgedGeneration,
        maxText,
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
      ];
    default:
      return [job.realm, job.vaultId, job.acknowledgedGeneration, maxText, Number.MAX_SAFE_INTEGER];
  }
}

function isObsolete(
  job: EncryptedWalletBackupSnapshotCleanupJob,
  row: MetadataRow,
  protectedTuple: Readonly<{ snapshotId: string; snapshotRevision: number }> | null,
): boolean {
  if (row.generation > job.acknowledgedGeneration) return false;
  if (row.snapshotId === job.localSnapshotId && row.snapshotRevision === job.localSnapshotRevision)
    return false;
  if (
    protectedTuple !== null &&
    row.snapshotId === protectedTuple.snapshotId &&
    row.snapshotRevision === protectedTuple.snapshotRevision
  ) {
    return false;
  }
  return true;
}

function controlRow(
  value: EncryptedWalletBackupDexieControlRow,
  phase: "snapshot-controls" | "manifest-pass-a-results" | "manifest-cursors",
) {
  return Object.freeze({
    key: value.scopeKey,
    cursor: Object.freeze({
      phase,
      generation: value.generation,
      snapshotId: value.snapshotId,
      snapshotRevision: value.snapshotRevision,
    }),
  });
}

function pinRow(value: EncryptedWalletBackupDexieSnapshotPinRow) {
  return Object.freeze({
    key: [value.realm, value.vaultId, value.snapshotId, value.snapshotRevision, 0, value.recordId],
    cursor: Object.freeze({
      phase: "snapshot-pins" as const,
      generation: value.generation,
      snapshotId: value.snapshotId,
      snapshotRevision: value.snapshotRevision,
      recordId: value.recordId,
      commitment: value.commitment,
    }),
  });
}

function pageRow(value: EncryptedWalletBackupDexieManifestPageRow) {
  return Object.freeze({
    key: [value.realm, value.vaultId, value.snapshotId, value.snapshotRevision, value.pageIndex],
    cursor: Object.freeze({
      phase: "manifest-pages" as const,
      generation: value.generation,
      snapshotId: value.snapshotId,
      snapshotRevision: value.snapshotRevision,
      pageIndex: value.pageIndex,
    }),
  });
}

function sourceRow(value: EncryptedWalletBackupDexiePreparedSourceRow) {
  return Object.freeze({
    key: [
      value.realm,
      value.vaultId,
      value.recordKindCode,
      value.recordId,
      value.revision,
      value.bodyReference,
    ],
    cursor: Object.freeze({
      phase: "prepared-sources" as const,
      generation: value.generation,
      snapshotId: value.snapshotId,
      snapshotRevision: value.snapshotRevision,
      recordId: value.recordId,
      revision: value.revision,
      bodyReference: value.bodyReference,
    }),
  });
}

function canonicalBytes(row: MetadataRow): Uint8Array {
  const canonical = row.canonical ?? row.canonicalDescriptor;
  if (!(canonical instanceof Uint8Array)) throw new Error("backup cleanup metadata row is invalid");
  return canonical;
}

function indexedKeyBytes(value: unknown): number {
  if (typeof value === "string") return new TextEncoder().encode(value).byteLength;
  if (typeof value === "number" && Number.isSafeInteger(value)) return 8;
  if (Array.isArray(value))
    return value.reduce((total, item) => total + indexedKeyBytes(item), value.length + 1);
  throw new Error("backup cleanup reference key is invalid");
}

function requireProfile(input: RunEncryptedWalletBackupSnapshotCleanupInput): void {
  if (input.database.name !== browserWalletDatabaseName(input.scopeId))
    throw new Error("backup cleanup database profile is invalid");
  if (!/^[^\s]{1,128}$/.test(input.realm) || !/^[0-9a-f]{64}$/.test(input.vaultId))
    throw new Error("backup cleanup profile is invalid");
}

function assertNever(value: never): never {
  throw new Error(`unsupported backup cleanup phase: ${String(value)}`);
}
