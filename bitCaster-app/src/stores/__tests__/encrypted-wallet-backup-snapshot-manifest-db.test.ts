// @vitest-environment node
import "fake-indexeddb/auto";
import * as Cashu from "@cashu/cashu-ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { encode, rfc8949EncodeOptions } from "cborg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEncryptedWalletBackupKeyHandle,
  prepareEncryptedWalletBackupFrozenSnapshotControl,
  prepareEncryptedWalletBackupProof,
  prepareEncryptedWalletBackupRequestProof,
  readAuthenticatedEncryptedWalletBackupHead,
  type EncryptedWalletBackupKeyHandle,
} from "@bitcaster/client-sdk/encryptedWalletBackup";
import {
  decodeEncryptedWalletBackupPreparedSourceDescriptor,
  encodeEncryptedWalletBackupPreparedSourceDescriptor,
  rehydratePreparedEncryptedWalletBackupRecord,
  rehydratePreparedEncryptedWalletBackupRecordBatch,
  sealPreparedEncryptedWalletBackupRecord,
  type EncryptedWalletBackupPreparedRecordSnapshot,
  type EncryptedWalletBackupPreparedRecordSnapshotBatchStore,
  type EncryptedWalletBackupPreparedRecordSnapshotStore,
  type PersistedPreparedEncryptedWalletBackupRecord,
} from "@bitcaster/client-sdk/encryptedWalletBackupPreparedRecordPersistence";
import {
  appendEncryptedWalletBackupFrozenSnapshotProofPage,
  beginEncryptedWalletBackupFrozenSnapshot,
  decodeEncryptedWalletBackupSnapshotPin,
  encodeEncryptedWalletBackupSnapshotPinOrderKey,
  encodeEncryptedWalletBackupFrozenSnapshotScope,
} from "@bitcaster/client-sdk/encryptedWalletBackupSnapshotPersistence";
import {
  readEncryptedWalletBackupSnapshotSealMetadataPage,
  sealEncryptedWalletBackupFrozenSnapshot,
  startEncryptedWalletBackupFrozenSnapshotSeal,
} from "@bitcaster/client-sdk/encryptedWalletBackupSnapshotSeal";
import { planEncryptedWalletBackupManifestPassA } from "@bitcaster/client-sdk/encryptedWalletBackupManifestPassA";
import { persistNextEncryptedWalletBackupManifestPage } from "@bitcaster/client-sdk/encryptedWalletBackupManifestPagePersistence";
import { finalizeBoundedEncryptedWalletBackupManifestTarget } from "@bitcaster/client-sdk/encryptedWalletBackupManifestTargetFinalization";
import {
  appendEncryptedWalletBackupPreparedRecordPage,
  freezeEncryptedWalletBackupPack,
  prepareEncryptedWalletBackupFrozenPackObject,
  rehydrateEncryptedWalletBackupStagedPackObject,
  serializeEncryptedWalletBackupPreparedBuildRecord,
  stageEncryptedWalletBackupPackObject,
} from "@bitcaster/client-sdk/encryptedWalletBackupPackPersistence";
import {
  deriveDurableCustodyProofId,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from "@bitcaster/client-sdk/durableCustody";
import { encodeDurableWalletProofDerivationLocatorCbor } from "@bitcaster/client-sdk/durableWalletProofDerivationLocator";
import { browserWalletDatabaseName } from "@/lib/browserWalletProfile";
import { EncryptedWalletBackupPreparedSourceDexieStore } from "../encrypted-wallet-backup-prepared-source-db";
import { EncryptedWalletBackupPackDexieStore } from "../encrypted-wallet-backup-pack-db";
import { EncryptedWalletBackupSnapshotManifestDexieStore } from "../encrypted-wallet-backup-snapshot-manifest-db";
import type {
  EncryptedWalletBackupDexieControlRow,
  EncryptedWalletBackupDexiePreparedRecordRow,
  EncryptedWalletBackupDexiePreparedSourceRow,
} from "../proof-db";
import { BitcasterDB } from "../proof-db";

const SEED = Uint8Array.from({ length: 64 }, (_, index) => index);
const REALM = "snapshot-dexie-test";
const WALLET_SCOPE_ID = deriveDurableCustodyScopeId({
  scopeKind: "wallet",
  walletId: deriveDurableCustodyWalletId(SEED),
});
const openDatabases: BitcasterDB[] = [];
const runtime = {
  subtle: crypto.subtle,
  getRandomValues: (target: Uint8Array) => crypto.getRandomValues(target),
};
const parentEvidence = new WeakMap<object, unknown>();

afterEach(async () => {
  for (const database of openDatabases.splice(0)) {
    database.close();
    await database.delete();
  }
});

describe("encrypted wallet backup Dexie snapshot and manifest store", () => {
  it("rehydrates sealed records through concrete single and batch snapshot reads", async () => {
    const fixture = await fixtureRecords(2);
    const database = databaseFor();
    const source = preparedSourceStore(database, fixture.keyHandle);
    for (const record of fixture.records) await source.insertPreparedSource(record);

    const one = await rehydratePreparedEncryptedWalletBackupRecord({
      keyHandle: fixture.keyHandle,
      seed: SEED,
      persisted: fixture.records[0]!,
      snapshotStore: source,
    });
    const batch = await rehydratePreparedEncryptedWalletBackupRecordBatch({
      keyHandle: fixture.keyHandle,
      seed: SEED,
      persisted: fixture.records,
      snapshotStore: source,
    });

    expect(one).toBeDefined();
    expect(batch).toHaveLength(fixture.records.length);
  });

  it("begins, appends, rejects stale versions, and restarts with exact snapshot accounting", async () => {
    const fixture = await fixtureRecords(2);
    const database = databaseFor();
    const source = preparedSourceStore(database, fixture.keyHandle);
    for (const record of fixture.records) await source.insertPreparedSource(record);
    const control = await snapshotControl(fixture.keyHandle, "dexie-snapshot");
    const store = snapshotStore(database, fixture.keyHandle);
    const begun = await beginEncryptedWalletBackupFrozenSnapshot({ store, control });
    const appended = await appendEncryptedWalletBackupFrozenSnapshotProofPage({
      store,
      control,
      current: begun,
      keyHandle: fixture.keyHandle,
      seed: SEED,
      preparedRecords: fixture.records,
      preparedSnapshotStore: source,
    });
    expect(appended.recordCount).toBe(2);
    expect(await database.encryptedWalletBackupSnapshotPins.count()).toBe(2);

    await expect(
      appendEncryptedWalletBackupFrozenSnapshotProofPage({
        store,
        control,
        current: begun,
        keyHandle: fixture.keyHandle,
        seed: SEED,
        preparedRecords: fixture.records,
        preparedSnapshotStore: source,
      }),
    ).rejects.toThrow(/stale/);

    database.close();
    const restarted = new BitcasterDB(database.name);
    openDatabases.push(restarted);
    const rows = await restarted.encryptedWalletBackupSnapshotPins.count();
    expect(rows).toBe(2);
  });

  it("rolls back source loss, duplicate identifiers, and incomplete reservation callbacks", async () => {
    const fixture = await fixtureRecords(1);
    const database = databaseFor();
    const source = preparedSourceStore(database, fixture.keyHandle);
    await source.insertPreparedSource(fixture.records[0]!);
    const control = await snapshotControl(fixture.keyHandle, "dexie-rollback");
    const store = snapshotStore(database, fixture.keyHandle);
    const begun = await beginEncryptedWalletBackupFrozenSnapshot({ store, control });

    const deletingStore: EncryptedWalletBackupPreparedRecordSnapshotBatchStore = {
      async withCommittedPreparedRecordSnapshotBatch<T>(
        recordIds: readonly string[],
        read: (rows: readonly EncryptedWalletBackupPreparedRecordSnapshot[]) => T,
      ): Promise<T> {
        const result = await source.withCommittedPreparedRecordSnapshotBatch(recordIds, read);
        await database.encryptedWalletBackupPreparedSources.delete([
          REALM,
          fixture.keyHandle.vaultId,
          0,
          fixture.records[0]!.recordId,
          fixture.records[0]!.snapshotRevision,
          preparedSourceBodyReference(fixture.records[0]!),
        ]);
        return result;
      },
    };
    await expect(
      appendEncryptedWalletBackupFrozenSnapshotProofPage({
        store,
        control,
        current: begun,
        keyHandle: fixture.keyHandle,
        seed: SEED,
        preparedRecords: fixture.records,
        preparedSnapshotStore: deletingStore,
      }),
    ).rejects.toThrow(/source changed/);
    expect(await database.encryptedWalletBackupSnapshotPins.count()).toBe(0);

    await source.insertPreparedSource(fixture.records[0]!);
    const appended = await appendEncryptedWalletBackupFrozenSnapshotProofPage({
      store,
      control,
      current: begun,
      keyHandle: fixture.keyHandle,
      seed: SEED,
      preparedRecords: fixture.records,
      preparedSnapshotStore: source,
    });
    await expect(
      appendEncryptedWalletBackupFrozenSnapshotProofPage({
        store,
        control,
        current: appended,
        keyHandle: fixture.keyHandle,
        seed: SEED,
        preparedRecords: fixture.records,
        preparedSnapshotStore: source,
      }),
    ).rejects.toThrow();
    expect(await database.encryptedWalletBackupSnapshotPins.count()).toBe(1);

    const scope = encodeEncryptedWalletBackupFrozenSnapshotScope(control);
    const controlRow = await database.encryptedWalletBackupSnapshotControls.get(bytesToHex(scope));
    if (!controlRow) throw new Error("missing test control");
    await expect(
      store.withExactVersionTransaction(
        {
          scope,
          expectedVersion: 2,
          reservedReadRows: 1,
          reservedReadBytes: scope.byteLength + controlRow.canonical.byteLength,
          reservedWriteRows: 1,
          reservedWriteBytes: 1,
        },
        async (transaction) => transaction.readSnapshotControl(scope),
      ),
    ).rejects.toThrow(/omitted|reservation/);
    expect(await database.encryptedWalletBackupSnapshotPins.count()).toBe(1);
  });

  it("keeps a maximum snapshot-pin append within its exact physical row and byte reservation", async () => {
    const fixture = await fixtureRecords(127, "maximum-pin-append");
    const database = databaseFor();
    const source = preparedSourceStore(database, fixture.keyHandle);
    for (const record of fixture.records) await source.insertPreparedSource(record);
    const control = await snapshotControl(fixture.keyHandle, "maximum-pin-append");
    const store = snapshotStore(database, fixture.keyHandle);
    const begun = await beginEncryptedWalletBackupFrozenSnapshot({ store, control });

    const exactTransaction = store.withExactVersionTransaction.bind(store);
    const controlGet = database.encryptedWalletBackupSnapshotControls.get.bind(
      database.encryptedWalletBackupSnapshotControls,
    );
    const controlPut = database.encryptedWalletBackupSnapshotControls.put.bind(
      database.encryptedWalletBackupSnapshotControls,
    );
    const sourceBulkGet = database.encryptedWalletBackupPreparedSources.bulkGet.bind(
      database.encryptedWalletBackupPreparedSources,
    );
    const pinBulkAdd = database.encryptedWalletBackupSnapshotPins.bulkAdd.bind(
      database.encryptedWalletBackupSnapshotPins,
    );
    let expectedReservation: Parameters<typeof store.withExactVersionTransaction>[0] | undefined;
    let controlReads = 0;
    let controlWrites = 0;
    let sourceReads = 0;
    let pinWrites = 0;
    let sourceBulkRequests = 0;
    let pinBulkRequests = 0;
    let readBytes = 0;
    let writeBytes = 0;
    let insideExactTransaction = false;
    vi.spyOn(store, "withExactVersionTransaction").mockImplementation(async (expected, use) => {
      expectedReservation = expected;
      insideExactTransaction = true;
      try {
        return await exactTransaction(expected, use);
      } finally {
        insideExactTransaction = false;
      }
    });
    vi.spyOn(database.encryptedWalletBackupSnapshotControls, "get").mockImplementation((...args) =>
      controlGet(...args).then((row) => {
        const control = row as EncryptedWalletBackupDexieControlRow | undefined;
        if (insideExactTransaction) {
          controlReads += 1;
          readBytes += control?.canonical.byteLength ?? 0;
        }
        return row;
      }),
    );
    vi.spyOn(database.encryptedWalletBackupSnapshotControls, "put").mockImplementation(
      (...args) => {
        if (insideExactTransaction) {
          controlWrites += 1;
          writeBytes += args[0].canonical.byteLength;
        }
        return controlPut(...args);
      },
    );
    vi.spyOn(database.encryptedWalletBackupPreparedSources, "bulkGet").mockImplementation((keys) =>
      sourceBulkGet(keys).then((rows) => {
        const sources = rows as Array<EncryptedWalletBackupDexiePreparedSourceRow | undefined>;
        if (insideExactTransaction) {
          sourceBulkRequests += 1;
          sourceReads += sources.length;
          readBytes += sources.reduce(
            (total, source) => total + (source?.canonicalDescriptor.byteLength ?? 0),
            0,
          );
        }
        return rows;
      }),
    );
    vi.spyOn(database.encryptedWalletBackupSnapshotPins, "bulkAdd").mockImplementation((rows) => {
      if (insideExactTransaction) {
        pinBulkRequests += 1;
        pinWrites += rows.length;
        writeBytes += rows.reduce((total, row) => total + row.canonical.byteLength, 0);
      }
      return pinBulkAdd(rows);
    });

    await appendEncryptedWalletBackupFrozenSnapshotProofPage({
      store,
      control,
      current: begun,
      keyHandle: fixture.keyHandle,
      seed: SEED,
      preparedRecords: fixture.records,
      preparedSnapshotStore: source,
    });

    if (!expectedReservation) throw new Error("missing snapshot reservation");
    readBytes += expectedReservation.scope.byteLength;
    expect(controlReads).toBe(1);
    expect(controlWrites).toBe(1);
    expect(sourceReads).toBe(127);
    expect(pinWrites).toBe(127);
    expect(sourceBulkRequests).toBe(1);
    expect(pinBulkRequests).toBe(1);
    expect(controlReads + controlWrites + sourceReads + pinWrites).toBe(256);
    expect(readBytes).toBe(expectedReservation.reservedReadBytes);
    expect(writeBytes).toBe(expectedReservation.reservedWriteBytes);
  });

  it("resolves each snapshot pin to its exact coexisting prepared source", async () => {
    const fixture = await fixtureRecords(1);
    const database = databaseFor();
    const source = preparedSourceStore(database, fixture.keyHandle);
    const original = fixture.records[0]!;
    const replacement = { ...original, snapshotRevision: original.snapshotRevision + 1 };
    await source.insertPreparedSource(original);
    await source.insertPreparedSource(replacement);
    await expect(
      rehydratePreparedEncryptedWalletBackupRecord({
        keyHandle: fixture.keyHandle,
        seed: SEED,
        persisted: original,
        snapshotStore: source,
      }),
    ).resolves.toBeDefined();
    const control = await snapshotControl(fixture.keyHandle, "exact-source");
    const store = snapshotStore(database, fixture.keyHandle);
    const begun = await beginEncryptedWalletBackupFrozenSnapshot({ store, control });
    const snapshots: EncryptedWalletBackupPreparedRecordSnapshotBatchStore = {
      async withCommittedPreparedRecordSnapshotBatch<T>(
        _recordIds: readonly string[],
        read: (rows: readonly EncryptedWalletBackupPreparedRecordSnapshot[]) => T,
      ): Promise<T> {
        return read([
          {
            schemaVersion: 1,
            snapshotId: original.snapshotId,
            snapshotRevision: original.snapshotRevision,
            recordId: original.recordId,
            commitment: original.commitment,
            recordKindCode: 0,
          },
        ]);
      },
    };
    await appendEncryptedWalletBackupFrozenSnapshotProofPage({
      store,
      control,
      current: begun,
      keyHandle: fixture.keyHandle,
      seed: SEED,
      preparedRecords: [original],
      preparedSnapshotStore: snapshots,
    });

    const pin = await database.encryptedWalletBackupSnapshotPins.toCollection().first();
    if (!pin) throw new Error("missing snapshot pin");
    expect(decodeEncryptedWalletBackupSnapshotPin(pin.canonical).sourceRevision).toBe(
      original.snapshotRevision,
    );
    expect(
      await database.encryptedWalletBackupPreparedSources.get([
        REALM,
        fixture.keyHandle.vaultId,
        0,
        original.recordId,
        original.snapshotRevision,
        preparedSourceBodyReference(original),
      ]),
    ).toBeDefined();
    expect(await database.encryptedWalletBackupPreparedSources.count()).toBe(2);
  });

  it("rejects duplicate record-id and duplicate commitment snapshot pins separately", async () => {
    const fixture = await fixtureRecords(1);
    const database = databaseFor();
    const source = preparedSourceStore(database, fixture.keyHandle);
    await source.insertPreparedSource(fixture.records[0]!);
    const control = await snapshotControl(fixture.keyHandle, "pin-collision");
    const store = snapshotStore(database, fixture.keyHandle);
    const begun = await beginEncryptedWalletBackupFrozenSnapshot({ store, control });
    await appendEncryptedWalletBackupFrozenSnapshotProofPage({
      store,
      control,
      current: begun,
      keyHandle: fixture.keyHandle,
      seed: SEED,
      preparedRecords: fixture.records,
      preparedSnapshotStore: source,
    });
    const existing = await database.encryptedWalletBackupSnapshotPins.toCollection().first();
    if (!existing) throw new Error("missing collision pin");
    await expect(database.encryptedWalletBackupSnapshotPins.add({ ...existing })).rejects.toThrow();
    await expect(
      database.encryptedWalletBackupSnapshotPins.add({
        ...existing,
        recordId: "f".repeat(64),
      }),
    ).rejects.toThrow();
  });

  it("rejects a foreign or profile-mismatched empty snapshot before it writes a control row", async () => {
    const fixture = await fixtureRecords(1);
    const database = databaseFor();
    const store = snapshotStore(database, fixture.keyHandle, "bound-snapshot", 1);
    const mismatched = await snapshotControl(fixture.keyHandle, "other-snapshot");
    await expect(
      beginEncryptedWalletBackupFrozenSnapshot({ store, control: mismatched }),
    ).rejects.toThrow(/bound wallet profile/);
    const foreignKey = await createEncryptedWalletBackupKeyHandle({
      seed: SEED,
      realm: "foreign.snapshot.test",
      runtime,
    });
    const foreign = await snapshotControl(foreignKey, "bound-snapshot");
    await expect(
      beginEncryptedWalletBackupFrozenSnapshot({ store, control: foreign }),
    ).rejects.toThrow(/bound wallet profile/);
    expect(await database.encryptedWalletBackupSnapshotControls.count()).toBe(0);
  });

  it("persists a Pass-A plan and a Pass-B page atomically across restart", async () => {
    const snapshotId = "dexie-manifest";
    const fixture = await fixtureRecords(1, snapshotId);
    const database = databaseFor();
    const source = preparedSourceStore(database, fixture.keyHandle);
    await source.insertPreparedSource(fixture.records[0]!);
    const control = await snapshotControl(fixture.keyHandle, snapshotId);
    const store = snapshotStore(database, fixture.keyHandle, snapshotId, 1);
    const begun = await beginEncryptedWalletBackupFrozenSnapshot({ store, control });
    const appended = await appendEncryptedWalletBackupFrozenSnapshotProofPage({
      store,
      control,
      current: begun,
      keyHandle: fixture.keyHandle,
      seed: SEED,
      preparedRecords: fixture.records,
      preparedSnapshotStore: source,
    });
    const sealed = await sealEncryptedWalletBackupFrozenSnapshot({
      store,
      control,
      current: appended,
    });
    const passA = await planEncryptedWalletBackupManifestPassA({ store, control, current: sealed });
    const repeatedPassA = await planEncryptedWalletBackupManifestPassA({
      store,
      control,
      current: sealed,
    });
    expect(repeatedPassA).toEqual(passA);

    const pack = new EncryptedWalletBackupPackDexieStore({
      database,
      scopeId: WALLET_SCOPE_ID,
      realm: REALM,
      vaultId: fixture.keyHandle.vaultId,
    });
    const base = {
      store: pack,
      keyHandle: fixture.keyHandle,
      seed: SEED,
      snapshotStore: source,
      buildId: "manifest-build",
      packId: "manifest-pack",
      snapshotId,
      snapshotRevision: 1,
    };
    await appendEncryptedWalletBackupPreparedRecordPage({
      ...base,
      expectedBuildVersion: 0,
      expectedPackVersion: 0,
      records: fixture.records,
    });
    await freezeEncryptedWalletBackupPack({
      ...base,
      expectedBuildVersion: 1,
      expectedPackVersion: 1,
    });
    const object = await prepareEncryptedWalletBackupFrozenPackObject({
      ...base,
      expectedBuildVersion: 2,
      expectedPackVersion: 2,
      generation: 1,
    });
    await stageEncryptedWalletBackupPackObject({
      store: pack,
      prepared: object,
      expectedBuildVersion: 2,
      expectedPackVersion: 2,
    });
    const stagedPackProvider = {
      rehydrateStagedPack: () =>
        rehydrateEncryptedWalletBackupStagedPackObject({
          ...base,
          expectedBuildVersion: 3,
          expectedPackVersion: 3,
        }),
    };
    const failingStore = {
      readManifestPageState: store.readManifestPageState.bind(store),
      withManifestPageTransaction: async (
        expected: Parameters<typeof store.withManifestPageTransaction>[0],
        use: Parameters<typeof store.withManifestPageTransaction>[1],
      ) =>
        store.withManifestPageTransaction(expected, async (transaction) =>
          use({
            ...transaction,
            insertPageAndAdvance: async () => {
              throw new Error("injected Pass-B failure");
            },
          }),
        ),
    };
    await expect(
      persistNextEncryptedWalletBackupManifestPage({
        store: failingStore,
        sourceStore: store,
        stagedPackProvider,
        snapshotStore: source,
        control,
        keyHandle: fixture.keyHandle,
        seed: SEED,
        runtime,
      }),
    ).rejects.toThrow("injected Pass-B failure");
    expect(await database.encryptedWalletBackupManifestPages.count()).toBe(0);
    expect(await database.encryptedWalletBackupManifestCursors.count()).toBe(0);

    const first = await persistNextEncryptedWalletBackupManifestPage({
      store,
      sourceStore: store,
      stagedPackProvider,
      snapshotStore: source,
      control,
      keyHandle: fixture.keyHandle,
      seed: SEED,
      runtime,
    });
    expect(first.state).toBe("page");
    expect(await database.encryptedWalletBackupManifestPages.count()).toBe(1);
    const complete = await persistNextEncryptedWalletBackupManifestPage({
      store,
      sourceStore: store,
      stagedPackProvider,
      snapshotStore: source,
      control,
      keyHandle: fixture.keyHandle,
      seed: SEED,
      runtime,
    });
    expect(complete).toEqual({ state: "completed" });
    const target = await finalizeBoundedEncryptedWalletBackupManifestTarget({
      store,
      control,
      parentEvidence: parentEvidence.get(control) as never,
      keyHandle: fixture.keyHandle,
      seed: SEED,
    });
    expect(target).toBeDefined();
    const manifest = await database.encryptedWalletBackupManifestPages.toCollection().first();
    if (!manifest) throw new Error("missing manifest page");
    const page = (
      await import("@bitcaster/client-sdk/encryptedWalletBackupManifestPagePersistence")
    ).decodeEncryptedWalletBackupManifestPageRow(manifest.canonical);
    await expect(
      store.readManifestPageObject({ ...page.object, maximumRows: 1, maximumBytes: 1_048_576 }),
    ).resolves.toMatchObject({ objectId: page.object.objectId });
    await expect(
      store.readManifestPageObject({ ...page.object, maximumRows: 1, maximumBytes: 1 } as never),
    ).rejects.toThrow(/outside/);
    await expect(
      store.readManifestPageObject({
        ...page.object,
        objectId: "other",
        maximumRows: 1,
        maximumBytes: 1_048_576,
      }),
    ).rejects.toThrow(/absent/);
    await expect(
      store.readProofChunkObject({ ...object.object, maximumRows: 1, maximumBytes: 1_048_576 }),
    ).resolves.toMatchObject({ objectId: object.object.objectId });
    await expect(
      store.readProofChunkObject({
        ...object.object,
        maximumRows: 2,
        maximumBytes: 1_048_576,
      } as never),
    ).rejects.toThrow(/outside/);

    database.close();
    const restarted = new BitcasterDB(database.name);
    openDatabases.push(restarted);
    expect(await restarted.encryptedWalletBackupManifestPassAResults.count()).toBe(1);
    expect(await restarted.encryptedWalletBackupManifestPages.count()).toBe(1);
  });

  it("uses deterministic, strict-exclusive pin keyset cursors", async () => {
    const fixture = await fixtureRecords(2, "dexie-cursor");
    const database = databaseFor();
    const source = preparedSourceStore(database, fixture.keyHandle);
    for (const record of fixture.records) await source.insertPreparedSource(record);
    const control = await snapshotControl(fixture.keyHandle, "dexie-cursor");
    const store = snapshotStore(database, fixture.keyHandle);
    const begun = await beginEncryptedWalletBackupFrozenSnapshot({ store, control });
    const appended = await appendEncryptedWalletBackupFrozenSnapshotProofPage({
      store,
      control,
      current: begun,
      keyHandle: fixture.keyHandle,
      seed: SEED,
      preparedRecords: fixture.records,
      preparedSnapshotStore: source,
    });
    const sealing = await startEncryptedWalletBackupFrozenSnapshotSeal({
      store,
      control,
      current: appended,
    });
    const empty = await readEncryptedWalletBackupSnapshotSealMetadataPage({
      store,
      control,
      current: sealing,
      exclusiveAfter: null,
      maximumPins: 1,
    });
    expect(empty.pins).toHaveLength(1);
    const one = await readEncryptedWalletBackupSnapshotSealMetadataPage({
      store,
      control,
      current: sealing,
      exclusiveAfter: empty.nextExclusiveAfter,
      maximumPins: 1,
    });
    expect(one.pins).toHaveLength(1);
    expect(decodeEncryptedWalletBackupSnapshotPin(empty.pins[0]!).recordId).not.toBe(
      decodeEncryptedWalletBackupSnapshotPin(one.pins[0]!).recordId,
    );
    const exhausted = await readEncryptedWalletBackupSnapshotSealMetadataPage({
      store,
      control,
      current: sealing,
      exclusiveAfter: one.nextExclusiveAfter,
      maximumPins: 1,
    });
    expect(exhausted.pins).toHaveLength(0);
  });

  it("uses bounded bulk requests for a 64-row source join", async () => {
    const fixture = await fixtureRecords(64, "read-bound");
    const database = databaseFor();
    const source = preparedSourceStore(database, fixture.keyHandle);
    for (const record of fixture.records) await source.insertPreparedSource(record);
    const control = await snapshotControl(fixture.keyHandle, "read-bound");
    const store = snapshotStore(database, fixture.keyHandle, "read-bound", 1);
    const begun = await beginEncryptedWalletBackupFrozenSnapshot({ store, control });
    await appendEncryptedWalletBackupFrozenSnapshotProofPage({
      store,
      control,
      current: begun,
      keyHandle: fixture.keyHandle,
      seed: SEED,
      preparedRecords: fixture.records,
      preparedSnapshotStore: source,
    });
    const pack = new EncryptedWalletBackupPackDexieStore({
      database,
      scopeId: WALLET_SCOPE_ID,
      realm: REALM,
      vaultId: fixture.keyHandle.vaultId,
    });
    const input = {
      store: pack,
      keyHandle: fixture.keyHandle,
      seed: SEED,
      snapshotStore: source,
      buildId: "read-bound-build",
      packId: "read-bound-pack",
      snapshotId: "read-bound",
      snapshotRevision: 1,
    };
    await appendEncryptedWalletBackupPreparedRecordPage({
      ...input,
      expectedBuildVersion: 0,
      expectedPackVersion: 0,
      records: [...fixture.records].sort((left, right) =>
        left.recordId.localeCompare(right.recordId),
      ),
    });
    let pinQueries = 0;
    let sourceBulkRequests = 0;
    let sourceBulkRows = 0;
    let sourcePointRequests = 0;
    let bindingQueries = 0;
    let preparedBulkRequests = 0;
    let preparedBulkRows = 0;
    let preparedPointRequests = 0;
    const readPins = database.encryptedWalletBackupSnapshotPins.where.bind(
      database.encryptedWalletBackupSnapshotPins,
    );
    const readSources = database.encryptedWalletBackupPreparedSources.get.bind(
      database.encryptedWalletBackupPreparedSources,
    );
    const readSourceBulk = database.encryptedWalletBackupPreparedSources.bulkGet.bind(
      database.encryptedWalletBackupPreparedSources,
    );
    const readBindings = database.encryptedWalletBackupPackBindings.where.bind(
      database.encryptedWalletBackupPackBindings,
    );
    const readPrepared = database.encryptedWalletBackupPreparedRecords.get.bind(
      database.encryptedWalletBackupPreparedRecords,
    );
    const readPreparedBulk = database.encryptedWalletBackupPreparedRecords.bulkGet.bind(
      database.encryptedWalletBackupPreparedRecords,
    );
    vi.spyOn(database.encryptedWalletBackupSnapshotPins, "where").mockImplementation((...args) => {
      pinQueries += 1;
      return readPins(...args);
    });
    vi.spyOn(database.encryptedWalletBackupPreparedSources, "get").mockImplementation((...args) => {
      sourcePointRequests += 1;
      return readSources(...args);
    });
    vi.spyOn(database.encryptedWalletBackupPreparedSources, "bulkGet").mockImplementation(
      (keys) => {
        sourceBulkRequests += 1;
        sourceBulkRows += keys.length;
        return readSourceBulk(keys);
      },
    );
    vi.spyOn(database.encryptedWalletBackupPackBindings, "where").mockImplementation((...args) => {
      bindingQueries += 1;
      return readBindings(...args);
    });
    vi.spyOn(database.encryptedWalletBackupPreparedRecords, "get").mockImplementation((...args) => {
      preparedPointRequests += 1;
      return readPrepared(...args);
    });
    vi.spyOn(database.encryptedWalletBackupPreparedRecords, "bulkGet").mockImplementation(
      (keys) => {
        preparedBulkRequests += 1;
        preparedBulkRows += keys.length;
        return readPreparedBulk(keys);
      },
    );
    const page = await store.readSourcePage(null, 64, 1_048_576);
    expect(page.rows).toHaveLength(64);
    expect(pinQueries).toBe(1);
    expect(sourceBulkRequests).toBe(1);
    expect(sourceBulkRows).toBe(64);
    expect(sourcePointRequests).toBe(0);
    expect(bindingQueries).toBe(1);
    expect(preparedBulkRequests).toBe(1);
    expect(preparedBulkRows).toBe(64);
    expect(preparedPointRequests).toBe(0);
    expect(page.rows.length + sourceBulkRows + page.rows.length + preparedBulkRows).toBe(256);
    await expect(store.readSourcePage(null, 65, 1_048_576)).rejects.toThrow(/reservation/);
  });

  it("selects a large prepared-record prefix before reading bodies and resumes exactly", async () => {
    const fixture = await fixtureRecords(4, "large-source-prefix");
    const database = databaseFor();
    const source = preparedSourceStore(database, fixture.keyHandle);
    for (const record of fixture.records) await source.insertPreparedSource(record);
    const control = await snapshotControl(fixture.keyHandle, "large-source-prefix");
    const store = snapshotStore(database, fixture.keyHandle, "large-source-prefix", 1);
    const begun = await beginEncryptedWalletBackupFrozenSnapshot({ store, control });
    await appendEncryptedWalletBackupFrozenSnapshotProofPage({
      store,
      control,
      current: begun,
      keyHandle: fixture.keyHandle,
      seed: SEED,
      preparedRecords: fixture.records,
      preparedSnapshotStore: source,
    });
    const pack = new EncryptedWalletBackupPackDexieStore({
      database,
      scopeId: WALLET_SCOPE_ID,
      realm: REALM,
      vaultId: fixture.keyHandle.vaultId,
    });
    await appendEncryptedWalletBackupPreparedRecordPage({
      store: pack,
      keyHandle: fixture.keyHandle,
      seed: SEED,
      snapshotStore: source,
      buildId: "large-source-prefix-build",
      packId: "large-source-prefix-pack",
      snapshotId: "large-source-prefix",
      snapshotRevision: 1,
      expectedBuildVersion: 0,
      expectedPackVersion: 0,
      records: [...fixture.records].sort((left, right) =>
        left.recordId.localeCompare(right.recordId),
      ),
    });
    for (const record of fixture.records) {
      const prepared = await database.encryptedWalletBackupPreparedRecords.get([
        "large-source-prefix-build",
        record.recordId,
      ]);
      const binding = await database.encryptedWalletBackupPackBindings.get([
        "large-source-prefix-build",
        "large-source-prefix-pack",
        record.recordId,
      ]);
      if (prepared === undefined || binding === undefined)
        throw new Error("missing large test row");
      const next: EncryptedWalletBackupDexiePreparedRecordRow = {
        ...prepared,
        prepared: { ...prepared.prepared, canonicalRecord: new Uint8Array(300_000) },
        preparedRecordSerializedBytes: 0,
      };
      const { preparedRecordSerializedBytes: _preparedRecordSerializedBytes, ...canonical } = next;
      next.preparedRecordSerializedBytes =
        serializeEncryptedWalletBackupPreparedBuildRecord(canonical).byteLength;
      await database.encryptedWalletBackupPreparedRecords.put(next);
      await database.encryptedWalletBackupPackBindings.put({
        ...binding,
        preparedRecordSerializedBytes: next.preparedRecordSerializedBytes,
      });
    }
    const readPreparedBulk = database.encryptedWalletBackupPreparedRecords.bulkGet.bind(
      database.encryptedWalletBackupPreparedRecords,
    );
    const preparedRequests: number[] = [];
    vi.spyOn(database.encryptedWalletBackupPreparedRecords, "bulkGet").mockImplementation(
      (keys) => {
        preparedRequests.push(keys.length);
        return readPreparedBulk(keys);
      },
    );

    const first = await store.readSourcePage(null, 64, 1_048_576);
    expect(first.rows).toHaveLength(3);
    expect(preparedRequests).toEqual([3]);
    const firstRecordIds = first.rows.map((row) => row.prepared.recordId);
    const after = encodeEncryptedWalletBackupSnapshotPinOrderKey(
      decodeEncryptedWalletBackupSnapshotPin(first.rows.at(-1)!.pin),
    );
    const second = await store.readSourcePage(after, 64, 1_048_576);
    expect(second.rows).toHaveLength(1);
    expect(preparedRequests).toEqual([3, 1]);
    expect([...firstRecordIds, ...second.rows.map((row) => row.prepared.recordId)]).toEqual(
      [...fixture.records].map((record) => record.recordId).sort(),
    );
    expect(Math.max(...preparedRequests)).toBe(3);
    expect(preparedRequests.reduce((total, count) => total + count, 0)).toBe(4);
  });

  it("fails closed when compact prepared-record size metadata does not match the body", async () => {
    const fixture = await fixtureRecords(1, "source-size-metadata");
    const database = databaseFor();
    const source = preparedSourceStore(database, fixture.keyHandle);
    await source.insertPreparedSource(fixture.records[0]!);
    const control = await snapshotControl(fixture.keyHandle, "source-size-metadata");
    const store = snapshotStore(database, fixture.keyHandle, "source-size-metadata", 1);
    const begun = await beginEncryptedWalletBackupFrozenSnapshot({ store, control });
    await appendEncryptedWalletBackupFrozenSnapshotProofPage({
      store,
      control,
      current: begun,
      keyHandle: fixture.keyHandle,
      seed: SEED,
      preparedRecords: fixture.records,
      preparedSnapshotStore: source,
    });
    const pack = new EncryptedWalletBackupPackDexieStore({
      database,
      scopeId: WALLET_SCOPE_ID,
      realm: REALM,
      vaultId: fixture.keyHandle.vaultId,
    });
    await appendEncryptedWalletBackupPreparedRecordPage({
      store: pack,
      keyHandle: fixture.keyHandle,
      seed: SEED,
      snapshotStore: source,
      buildId: "source-size-metadata-build",
      packId: "source-size-metadata-pack",
      snapshotId: "source-size-metadata",
      snapshotRevision: 1,
      expectedBuildVersion: 0,
      expectedPackVersion: 0,
      records: fixture.records,
    });
    const binding = await database.encryptedWalletBackupPackBindings.get([
      "source-size-metadata-build",
      "source-size-metadata-pack",
      fixture.records[0]!.recordId,
    ]);
    if (binding === undefined) throw new Error("missing size metadata binding");
    await database.encryptedWalletBackupPackBindings.put({
      ...binding,
      preparedRecordSerializedBytes: binding.preparedRecordSerializedBytes + 1,
    });
    await expect(store.readSourcePage(null, 64, 1_048_576)).rejects.toThrow(/size metadata/);
  });

  it("stores descriptor metadata without retaining a prepared proof body", async () => {
    const fixture = await fixtureRecords(1, "metadata-only");
    const database = databaseFor();
    const source = preparedSourceStore(database, fixture.keyHandle);
    const record = fixture.records[0]!;
    await source.insertPreparedSource(record);
    const row = await database.encryptedWalletBackupPreparedSources.get([
      REALM,
      fixture.keyHandle.vaultId,
      0,
      record.recordId,
      record.snapshotRevision,
      preparedSourceBodyReference(record),
    ]);
    if (!row) throw new Error("missing prepared source metadata");
    expect(row).not.toHaveProperty("prepared");
    expect(row.canonicalDescriptor.byteLength).toBeLessThan(1_024);
    expect(Object.keys(row)).toEqual([
      "realm",
      "vaultId",
      "recordKindCode",
      "recordId",
      "commitment",
      "bodyReference",
      "revision",
      "snapshotId",
      "snapshotRevision",
      "generation",
      "canonicalDescriptor",
    ]);

    const control = await snapshotControl(fixture.keyHandle, "metadata-only");
    const store = snapshotStore(database, fixture.keyHandle);
    const begun = await beginEncryptedWalletBackupFrozenSnapshot({ store, control });
    const appended = await appendEncryptedWalletBackupFrozenSnapshotProofPage({
      store,
      control,
      current: begun,
      keyHandle: fixture.keyHandle,
      seed: SEED,
      preparedRecords: fixture.records,
      preparedSnapshotStore: source,
    });
    await expect(
      sealEncryptedWalletBackupFrozenSnapshot({ store, control, current: appended }),
    ).resolves.toMatchObject({ state: "sealed" });
  });
});

function databaseFor(): BitcasterDB {
  const database = new BitcasterDB(browserWalletDatabaseName(WALLET_SCOPE_ID));
  openDatabases.push(database);
  return database;
}

function preparedSourceStore(database: BitcasterDB, keyHandle: EncryptedWalletBackupKeyHandle) {
  return new EncryptedWalletBackupPreparedSourceDexieStore({
    database,
    scopeId: WALLET_SCOPE_ID,
    realm: REALM,
    vaultId: keyHandle.vaultId,
    generation: 1,
  });
}

function snapshotStore(
  database: BitcasterDB,
  keyHandle: EncryptedWalletBackupKeyHandle,
  snapshotId?: string,
  snapshotRevision?: number,
) {
  return new EncryptedWalletBackupSnapshotManifestDexieStore({
    database,
    scopeId: WALLET_SCOPE_ID,
    realm: REALM,
    vaultId: keyHandle.vaultId,
    snapshotId,
    snapshotRevision,
  });
}

async function fixtureRecords(count: number, snapshotId = "prepared-snapshot") {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: SEED,
    realm: REALM,
    runtime,
  });
  const snapshots = new Map<
    string,
    { snapshotId: string; snapshotRevision: number; recordId: string; commitment: string }
  >();
  const records: PersistedPreparedEncryptedWalletBackupRecord[] = [];
  for (let counter = 1; counter <= count; counter += 1) {
    const prepared = await preparedRecord(keyHandle, counter, snapshots, snapshotId);
    records.push(
      await sealPreparedEncryptedWalletBackupRecord({
        keyHandle,
        seed: SEED,
        record: prepared,
        snapshotStore: snapshotMapStore(snapshots),
      }),
    );
  }
  return { keyHandle, records };
}

async function preparedRecord(
  keyHandle: EncryptedWalletBackupKeyHandle,
  counter: number,
  snapshots: Map<
    string,
    { snapshotId: string; snapshotRevision: number; recordId: string; commitment: string }
  >,
  snapshotId: string,
) {
  const keysetId = `01${"11".repeat(32)}`;
  const deriver = (
    Cashu as unknown as {
      createSecretAndBlindingFactorDeriver(
        seed: Uint8Array,
        keyset: string,
      ): (index: number) => { secret: Uint8Array };
    }
  ).createSecretAndBlindingFactorDeriver(SEED, keysetId);
  const secret = bytesToHex(deriver(counter).secret);
  const recordId = deriveDurableCustodyProofId({
    scopeId: WALLET_SCOPE_ID,
    normalizedMint: "https://mint.example",
    unit: "sat",
    keysetId,
    secret,
  });
  const commitment = bytesToHex(
    sha256(
      encode(
        [
          1,
          "proof-record-commitment",
          "https://mint.example",
          "sat",
          [2, keysetId],
          "1",
          new TextEncoder().encode(secret),
          hex("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),
          [hex("22".repeat(32)), hex("33".repeat(32)), hex("44".repeat(32))],
          encodeDurableWalletProofDerivationLocatorCbor({
            schemaVersion: 1,
            kind: "nut13",
            keysetId,
            counter,
          }),
          0,
          null,
          1_700_000_000,
          1_700_000_000,
        ],
        rfc8949EncodeOptions,
      ),
    ),
  );
  snapshots.set(recordId, { snapshotId, snapshotRevision: 1, recordId, commitment });
  return prepareEncryptedWalletBackupProof({
    keyHandle,
    seed: SEED,
    mint: "https://mint.example",
    unit: "sat",
    derivationLocator: { schemaVersion: 1, kind: "nut13", keysetId, counter },
    proof: {
      id: keysetId,
      amount: "1",
      secret,
      C: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
      dleq: { e: "22".repeat(32), s: "33".repeat(32), r: "44".repeat(32) },
    },
    proofKind: "ordinary",
    ctfMetadata: null,
    terminalEvidence: null,
    effectiveNowUnixSeconds: 1_700_000_000,
    createdAtUnixSeconds: 1_700_000_000,
    updatedAtUnixSeconds: 1_700_000_000,
    proofSnapshotStore: {
      async withCommittedProofSnapshot(expectedRecordId, read) {
        const value = snapshots.get(expectedRecordId);
        if (!value) throw new Error("missing test proof");
        return read({
          schemaVersion: 1,
          snapshotId: value.snapshotId,
          revision: value.snapshotRevision,
          proofId: value.recordId,
          proofCommitment: value.commitment,
          proofKind: "ordinary",
          ctfMetadata: null,
          terminalOperationId: null,
          conditionalKeysetEvidence: null,
          provenance: "wallet-seed",
          operationBinding: "terminally-unlinked",
          reserved: false,
          ambiguousMintOperation: false,
          proofPins: {
            openOrderCollateral: "absent",
            outbox: "absent",
            retryCursor: "absent",
            replayTombstone: "absent",
            dependentWork: "absent",
          },
          derivationLocator: { schemaVersion: 1, kind: "nut13", keysetId, counter },
        });
      },
    },
  });
}

function snapshotMapStore(
  values: ReadonlyMap<
    string,
    { snapshotId: string; snapshotRevision: number; recordId: string; commitment: string }
  >,
): EncryptedWalletBackupPreparedRecordSnapshotStore {
  return {
    async withCommittedPreparedRecordSnapshot<T>(
      recordId: string,
      read: (row: EncryptedWalletBackupPreparedRecordSnapshot) => T,
    ): Promise<T> {
      const value = values.get(recordId);
      if (!value) throw new Error("missing prepared snapshot");
      return read({ schemaVersion: 1, ...value, recordKindCode: 0 });
    },
  };
}

async function snapshotControl(keyHandle: EncryptedWalletBackupKeyHandle, snapshotId: string) {
  const requestProof = await prepareEncryptedWalletBackupRequestProof({
    keyHandle,
    enrollmentEpoch: 1,
    method: "GET",
    url: "https://backup.example.test/v1/head",
    issuedAtUnixSeconds: 1,
    expiresAtUnixSeconds: 2,
    payload: new Uint8Array(),
    signal: new AbortController().signal,
    runtime,
  });
  const headEvidence = await readAuthenticatedEncryptedWalletBackupHead({
    keyHandle,
    enrollmentEpoch: 1,
    requestProof,
    remote: {
      async readCurrentHead() {
        return { status: "not-found" as const };
      },
    },
  });
  const control = prepareEncryptedWalletBackupFrozenSnapshotControl({
    keyHandle,
    headEvidence,
    snapshotNonce: "22".repeat(16),
    snapshotId,
    snapshotRevision: 1,
  });
  parentEvidence.set(control, headEvidence);
  return control;
}

function hex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g)!.map((byte) => Number.parseInt(byte, 16)));
}

function preparedSourceBodyReference(record: PersistedPreparedEncryptedWalletBackupRecord): string {
  return decodeEncryptedWalletBackupPreparedSourceDescriptor(
    encodeEncryptedWalletBackupPreparedSourceDescriptor(record),
  ).bodyReference;
}
