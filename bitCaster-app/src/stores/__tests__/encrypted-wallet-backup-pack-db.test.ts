// @vitest-environment node
import "fake-indexeddb/auto";
import * as Cashu from "@cashu/cashu-ts";
import Dexie from "dexie";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { encode, rfc8949EncodeOptions } from "cborg";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEncryptedWalletBackupKeyHandle,
  prepareEncryptedWalletBackupProof,
  type EncryptedWalletBackupKeyHandle,
} from "@bitcaster/client-sdk/encryptedWalletBackup";
import {
  appendEncryptedWalletBackupPreparedRecordPage,
  freezeEncryptedWalletBackupPack,
  prepareEncryptedWalletBackupFrozenPackObject,
  serializeEncryptedWalletBackupPackBinding,
  serializeEncryptedWalletBackupPreparedBuildRecord,
  stageEncryptedWalletBackupPackObject,
  type PersistedEncryptedWalletBackupPreparedBuildRecord,
} from "@bitcaster/client-sdk/encryptedWalletBackupPackPersistence";
import {
  sealPreparedEncryptedWalletBackupRecord,
  type EncryptedWalletBackupPreparedRecordSnapshot,
  type EncryptedWalletBackupPreparedRecordSnapshotBatchStore,
  type EncryptedWalletBackupPreparedRecordSnapshotStore,
  type PersistedPreparedEncryptedWalletBackupRecord,
} from "@bitcaster/client-sdk/encryptedWalletBackupPreparedRecordPersistence";
import {
  deriveDurableCustodyProofId,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from "@bitcaster/client-sdk/durableCustody";
import { browserWalletDatabaseName } from "@/lib/browserWalletProfile";
import { EncryptedWalletBackupPackDexieStore } from "../encrypted-wallet-backup-pack-db";
import { BitcasterDB } from "../proof-db";

const SEED = Uint8Array.from({ length: 64 }, (_, index) => index);
const REALM = "pack-dexie-test";
const BUILD_ID = "build-a";
const PACK_ID = "pack-a";
const SNAPSHOT_ID = "pack-snapshot";
const WALLET_SCOPE_ID = deriveDurableCustodyScopeId({
  scopeKind: "wallet",
  walletId: deriveDurableCustodyWalletId(SEED),
});
const openDatabases: BitcasterDB[] = [];

afterEach(async () => {
  for (const database of openDatabases.splice(0)) {
    database.close();
    await database.delete();
  }
});

describe("encrypted wallet backup Dexie pack store", () => {
  it("defines normalized primary keys and preserves the existing wallet schema", () => {
    const database = createDatabase();
    expect(database.verno).toBe(9);
    expect(database.proofs.schema.primKey.keyPath).toBe("secret");
    expect(database.encryptedWalletBackupBuildCursors.schema.primKey.keyPath).toBe("buildId");
    expect(database.encryptedWalletBackupPackControls.schema.primKey.keyPath).toEqual([
      "buildId",
      "packId",
    ]);
    expect(database.encryptedWalletBackupPreparedRecords.schema.primKey.keyPath).toEqual([
      "buildId",
      "recordId",
    ]);
    expect(database.encryptedWalletBackupPackBindings.schema.primKey.keyPath).toEqual([
      "buildId",
      "packId",
      "recordId",
    ]);
    expect(
      database.encryptedWalletBackupPackBindings.schema.indexes.find(
        (index) => index.name === "[buildId+packId+ordinal]",
      )?.unique,
    ).toBe(true);
    expect(database.encryptedWalletBackupStagedObjects.schema.primKey.keyPath).toEqual([
      "buildId",
      "packId",
    ]);
  });

  it("keeps existing v8 wallet rows when it installs the undeployed schema", async () => {
    const name = `backup-pack-v8-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(8).stores({ proofs: "secret" });
    await legacy.open();
    await legacy.table("proofs").add({ secret: "v8-proof", amount: 1 });
    legacy.close();

    const database = new BitcasterDB(name);
    openDatabases.push(database);
    expect(await database.proofs.get("v8-proof")).toMatchObject({ secret: "v8-proof", amount: 1 });
    expect(await database.encryptedWalletBackupBuildCursors.count()).toBe(0);
  });

  it("rejects a database that does not belong to the bound wallet scope", async () => {
    const fixture = await preparedFixture(1);
    const database = new BitcasterDB(`wrong-wallet-profile-${crypto.randomUUID()}`);
    openDatabases.push(database);
    expect(
      () =>
        new EncryptedWalletBackupPackDexieStore({
          database,
          scopeId: WALLET_SCOPE_ID,
          realm: REALM,
          vaultId: fixture.keyHandle.vaultId,
        }),
    ).toThrow(/does not match its scope/);
    expect(await database.encryptedWalletBackupBuildCursors.count()).toBe(0);
    expect(await database.encryptedWalletBackupPackControls.count()).toBe(0);
  });

  it("rejects wrong realm or vault before a version-zero callback can write rows", async () => {
    const fixture = await preparedFixture(1);
    const database = createDatabase(WALLET_SCOPE_ID);
    const store = storeFor(database, fixture);
    for (const wrongScope of [
      { ...expected(fixture, 0, 0), realm: "foreign-realm" },
      { ...expected(fixture, 0, 0), vaultId: "f".repeat(64) },
    ]) {
      let calls = 0;
      await expect(
        store.withExactVersionTransaction(wrongScope, async (transaction) => {
          calls += 1;
          await transaction.writeBuildCursor(buildCursor(fixture, 0));
        }),
      ).rejects.toThrow(/does not match the bound wallet profile/);
      expect(calls).toBe(0);
      expect(await database.encryptedWalletBackupBuildCursors.count()).toBe(0);
      expect(await database.encryptedWalletBackupPackControls.count()).toBe(0);
    }
  });

  it("appends, freezes, prepares, stages, and restarts using one concrete database", async () => {
    const fixture = await preparedFixture(2);
    const database = createDatabase(WALLET_SCOPE_ID);
    const store = storeFor(database, fixture);
    const appended = await append(store, fixture, 0, 0);
    const frozen = await freezeEncryptedWalletBackupPack(packInput(store, fixture, 1, 1));
    const prepared = await prepareEncryptedWalletBackupFrozenPackObject({
      ...packInput(store, fixture, 2, 2),
      generation: 1,
    });
    const staged = await stageEncryptedWalletBackupPackObject({
      store,
      prepared,
      expectedBuildVersion: 2,
      expectedPackVersion: 2,
    });

    expect(appended.packControl.recordCount).toBe(2);
    expect(frozen.packControl.state).toBe("frozen");
    expect(staged.idempotent).toBe(false);
    expect(await database.encryptedWalletBackupStagedObjects.count()).toBe(1);

    database.close();
    const restartedDatabase = new BitcasterDB(database.name);
    openDatabases.push(restartedDatabase);
    const restarted = storeFor(restartedDatabase, fixture);
    const returned = await restarted.withExactVersionTransaction(
      expected(fixture, 3, 3),
      async (transaction) => transaction.readStagedObject(BUILD_ID, PACK_ID),
    );
    expect(returned).toMatchObject({ buildId: BUILD_ID, packId: PACK_ID });
  });

  it("rolls back an injected callback failure", async () => {
    const fixture = await preparedFixture(1);
    const database = createDatabase(WALLET_SCOPE_ID);
    const store = storeFor(database, fixture);
    await expect(
      store.withExactVersionTransaction(expected(fixture, 0, 0), async (transaction) => {
        await transaction.writeBuildCursor(buildCursor(fixture, 0));
        await transaction.writePackControl(packControl(fixture, 0));
        throw new Error("injected failure");
      }),
    ).rejects.toThrow("injected failure");
    expect(await database.encryptedWalletBackupBuildCursors.count()).toBe(0);
    expect(await database.encryptedWalletBackupPackControls.count()).toBe(0);
  });

  it("rejects stale expected versions before it invokes the callback", async () => {
    const fixture = await preparedFixture(1);
    const store = storeFor(createDatabase(WALLET_SCOPE_ID), fixture);
    await append(store, fixture, 0, 0);
    let calls = 0;
    await expect(
      store.withExactVersionTransaction(expected(fixture, 0, 0), async () => {
        calls += 1;
        return "unexpected";
      }),
    ).rejects.toThrow(/stale|conflicts/);
    expect(calls).toBe(0);
  });

  it("returns defensive clones of persisted control rows", async () => {
    const fixture = await preparedFixture(1);
    const store = storeFor(createDatabase(WALLET_SCOPE_ID), fixture);
    await append(store, fixture, 0, 0);
    const controls = await store.withExactVersionTransaction(
      expected(fixture, 1, 1),
      async (transaction) => {
        const first = await transaction.readBuildCursor(BUILD_ID);
        const second = await transaction.readBuildCursor(BUILD_ID);
        return { first, second };
      },
    );
    const rows = controls as { first: object; second: object };
    expect(rows.first).not.toBe(rows.second);
  });

  it("uses immutable inserts with database-enforced prepared and binding identities", async () => {
    const fixture = await preparedFixture(1);
    const database = createDatabase(WALLET_SCOPE_ID);
    const store = storeFor(database, fixture);
    const prepared = buildRecord(fixture.records[0]!);
    const binding = bindingFor(prepared, 0);
    await expect(
      store.withExactVersionTransaction(expected(fixture, 0, 0), async (transaction) => {
        await transaction.insertPreparedRecord(prepared);
        await transaction.insertPreparedRecord(prepared);
      }),
    ).rejects.toThrow();
    expect(await database.encryptedWalletBackupPreparedRecords.count()).toBe(0);

    await store.withExactVersionTransaction(expected(fixture, 0, 0), async (transaction) => {
      await transaction.insertPackBinding(binding);
      return "binding";
    });
    await expect(
      store.withExactVersionTransaction(expected(fixture, 0, 0), async (transaction) => {
        await transaction.insertPackBinding({ ...binding, recordId: `${"a".repeat(63)}b` });
      }),
    ).rejects.toThrow();
  });

  it("uses record-id keyset pages and stops before exact serialized-byte limits", async () => {
    const fixture = await preparedFixture(2);
    const database = createDatabase(WALLET_SCOPE_ID);
    const store = storeFor(database, fixture);
    await append(store, fixture, 0, 0);
    const controls = await controlsOf(database);
    const firstBinding = await database.encryptedWalletBackupPackBindings
      .where("[buildId+packId+recordId]")
      .between([BUILD_ID, PACK_ID, Dexie.minKey], [BUILD_ID, PACK_ID, Dexie.maxKey])
      .first();
    if (!firstBinding) throw new Error("missing test binding");
    const firstPrepared = await database.encryptedWalletBackupPreparedRecords.get([
      BUILD_ID,
      firstBinding.recordId,
    ]);
    if (!firstPrepared) throw new Error("missing test prepared record");
    const firstBytes =
      serializeEncryptedWalletBackupPackBinding(firstBinding).byteLength +
      serializeEncryptedWalletBackupPreparedBuildRecord(firstPrepared).byteLength;

    const exact = await store.withExactVersionTransaction(
      expected(fixture, controls.build.version, controls.pack.version),
      async (transaction) => transaction.readPackRecordPage(BUILD_ID, PACK_ID, null, 2, firstBytes),
    );
    const page = exact as Awaited<
      ReturnType<EncryptedWalletBackupPackDexieStore["withExactVersionTransaction"]>
    > & {
      rows: Array<{ binding: Uint8Array; prepared: Uint8Array }>;
      serializedBytes: number;
    };
    expect(page.rows).toHaveLength(1);
    expect(page.serializedBytes).toBe(firstBytes);

    const next = await store.withExactVersionTransaction(
      expected(fixture, controls.build.version, controls.pack.version),
      async (transaction) =>
        transaction.readPackRecordPage(BUILD_ID, PACK_ID, firstBinding.recordId, 2, 1_000_000),
    );
    expect((next as { rows: unknown[] }).rows).toHaveLength(1);

    const empty = await store.withExactVersionTransaction(
      expected(fixture, controls.build.version, controls.pack.version),
      async (transaction) =>
        transaction.readPackRecordPage(BUILD_ID, PACK_ID, null, 2, firstBytes - 1),
    );
    expect((empty as { rows: unknown[] }).rows).toHaveLength(0);
  });

  it("does not scan into a lexically later foreign pack after the current pack is exhausted", async () => {
    const fixture = await preparedFixture(1);
    const database = createDatabase(WALLET_SCOPE_ID);
    const store = storeFor(database, fixture);
    await append(store, fixture, 0, 0);
    const controls = await controlsOf(database);
    const current = buildRecord(fixture.records[0]!);
    await database.encryptedWalletBackupPackBindings.add({
      ...bindingFor(current, 0),
      packId: "pack-z",
      recordId: "f".repeat(64),
    });

    const page = await store.withExactVersionTransaction(
      expected(fixture, controls.build.version, controls.pack.version),
      async (transaction) =>
        transaction.readPackRecordPage(BUILD_ID, PACK_ID, current.recordId, 1, 1_000_000),
    );
    expect((page as { rows: unknown[] }).rows).toHaveLength(0);
  });

  it("fails closed when a pack binding loses its prepared-row join and returns the exact callback result", async () => {
    const fixture = await preparedFixture(1);
    const database = createDatabase(WALLET_SCOPE_ID);
    const store = storeFor(database, fixture);
    await append(store, fixture, 0, 0);
    const controls = await controlsOf(database);
    const token = Object.freeze({ exact: true });
    await expect(
      store.withExactVersionTransaction(
        expected(fixture, controls.build.version, controls.pack.version),
        async (transaction) => {
          const result = await transaction.readBuildCursor(BUILD_ID);
          if (!result) throw new Error("missing test build");
          return token;
        },
      ),
    ).resolves.toBe(token);

    const binding = await database.encryptedWalletBackupPackBindings.get([
      BUILD_ID,
      PACK_ID,
      buildRecord(fixture.records[0]!).recordId,
    ]);
    if (!binding) throw new Error("missing test binding");
    await database.encryptedWalletBackupPreparedRecords.delete([BUILD_ID, binding.recordId]);
    await expect(
      store.withExactVersionTransaction(
        expected(fixture, controls.build.version, controls.pack.version),
        async (transaction) =>
          transaction.readPackRecordPage(BUILD_ID, PACK_ID, null, 1, 1_000_000),
      ),
    ).rejects.toThrow(/no prepared record/);
  });
});

function createDatabase(scopeId = walletScopeId("11".repeat(32))): BitcasterDB {
  const database = new BitcasterDB(browserWalletDatabaseName(scopeId));
  openDatabases.push(database);
  return database;
}

function storeFor(database: BitcasterDB, fixture: Fixture): EncryptedWalletBackupPackDexieStore {
  return new EncryptedWalletBackupPackDexieStore({
    database,
    scopeId: WALLET_SCOPE_ID,
    realm: REALM,
    vaultId: fixture.keyHandle.vaultId,
  });
}

function walletScopeId(vaultId: string): string {
  return deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId: vaultId });
}

function expected(fixture: Fixture, buildVersion: number, packVersion: number) {
  return {
    buildId: BUILD_ID,
    buildVersion,
    packId: PACK_ID,
    packVersion,
    realm: REALM,
    vaultId: fixture.keyHandle.vaultId,
    snapshotId: SNAPSHOT_ID,
    snapshotRevision: 1,
  };
}

function packInput(
  store: EncryptedWalletBackupPackDexieStore,
  fixture: Fixture,
  buildVersion: number,
  packVersion: number,
) {
  return {
    store,
    keyHandle: fixture.keyHandle,
    seed: SEED,
    snapshotStore: fixture.snapshotStore,
    buildId: BUILD_ID,
    packId: PACK_ID,
    snapshotId: SNAPSHOT_ID,
    snapshotRevision: 1,
    expectedBuildVersion: buildVersion,
    expectedPackVersion: packVersion,
  };
}

function append(
  store: EncryptedWalletBackupPackDexieStore,
  fixture: Fixture,
  buildVersion: number,
  packVersion: number,
) {
  return appendEncryptedWalletBackupPreparedRecordPage({
    ...packInput(store, fixture, buildVersion, packVersion),
    records: fixture.records,
  });
}

function buildCursor(fixture: Fixture, version: number) {
  return {
    schemaVersion: 1 as const,
    buildId: BUILD_ID,
    realm: REALM,
    vaultId: fixture.keyHandle.vaultId,
    snapshotId: SNAPSHOT_ID,
    snapshotRevision: 1,
    version,
    nextRecordOrdinal: 0,
    openPackId: PACK_ID,
  };
}

function packControl(fixture: Fixture, version: number) {
  return {
    schemaVersion: 1 as const,
    buildId: BUILD_ID,
    packId: PACK_ID,
    realm: REALM,
    vaultId: fixture.keyHandle.vaultId,
    version,
    state: "open" as const,
    snapshotId: SNAPSHOT_ID,
    snapshotRevision: 1,
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

function buildRecord(
  prepared: PersistedPreparedEncryptedWalletBackupRecord,
): PersistedEncryptedWalletBackupPreparedBuildRecord {
  return {
    schemaVersion: 1,
    buildId: BUILD_ID,
    realm: REALM,
    vaultId: prepared.vaultId,
    snapshotId: SNAPSHOT_ID,
    snapshotRevision: 1,
    recordId: prepared.recordId,
    prepared,
  };
}

function bindingFor(record: PersistedEncryptedWalletBackupPreparedBuildRecord, ordinal: number) {
  return {
    schemaVersion: 1 as const,
    buildId: BUILD_ID,
    packId: PACK_ID,
    realm: REALM,
    vaultId: record.vaultId,
    snapshotId: SNAPSHOT_ID,
    snapshotRevision: 1,
    recordId: record.recordId,
    ordinal,
  };
}

async function controlsOf(database: BitcasterDB) {
  const build = await database.encryptedWalletBackupBuildCursors.get(BUILD_ID);
  const pack = await database.encryptedWalletBackupPackControls.get([BUILD_ID, PACK_ID]);
  if (!build || !pack) throw new Error("missing test controls");
  return { build, pack };
}

interface Fixture {
  readonly keyHandle: EncryptedWalletBackupKeyHandle;
  readonly records: readonly PersistedPreparedEncryptedWalletBackupRecord[];
  readonly snapshotStore: EncryptedWalletBackupPreparedRecordSnapshotStore &
    EncryptedWalletBackupPreparedRecordSnapshotBatchStore;
}

async function preparedFixture(count: number): Promise<Fixture> {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({ seed: SEED, realm: REALM });
  const snapshots = new Map<string, EncryptedWalletBackupPreparedRecordSnapshot>();
  const records: PersistedPreparedEncryptedWalletBackupRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    const record = await preparedRecord(keyHandle, 7 + index, snapshots);
    records.push(
      await sealPreparedEncryptedWalletBackupRecord({
        keyHandle,
        seed: SEED,
        record,
        snapshotStore: exactSnapshotStore(snapshots),
      }),
    );
  }
  records.sort((left, right) => left.recordId.localeCompare(right.recordId));
  return { keyHandle, records, snapshotStore: exactSnapshotStore(snapshots) };
}

async function preparedRecord(
  keyHandle: EncryptedWalletBackupKeyHandle,
  counter: number,
  snapshots: Map<string, EncryptedWalletBackupPreparedRecordSnapshot>,
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
          fromHex("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),
          [fromHex("22".repeat(32)), fromHex("33".repeat(32)), fromHex("44".repeat(32))],
          counter,
          0,
          null,
          1_700_000_000,
          1_700_000_000,
        ],
        rfc8949EncodeOptions,
      ),
    ),
  );
  snapshots.set(recordId, {
    schemaVersion: 1,
    snapshotId: SNAPSHOT_ID,
    snapshotRevision: 1,
    recordId,
    commitment,
    recordKindCode: 0,
  });
  return prepareEncryptedWalletBackupProof({
    keyHandle,
    seed: SEED,
    mint: "https://mint.example",
    unit: "sat",
    counter,
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
        const snapshot = snapshots.get(expectedRecordId);
        if (!snapshot) throw new Error("missing test proof snapshot");
        return read({
          schemaVersion: 1,
          snapshotId: snapshot.snapshotId,
          revision: snapshot.snapshotRevision,
          proofId: snapshot.recordId,
          proofCommitment: snapshot.commitment,
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
          derivationLocator: "committed",
        });
      },
    },
  });
}

function exactSnapshotStore(
  snapshots: ReadonlyMap<string, EncryptedWalletBackupPreparedRecordSnapshot>,
): EncryptedWalletBackupPreparedRecordSnapshotStore &
  EncryptedWalletBackupPreparedRecordSnapshotBatchStore {
  return {
    async withCommittedPreparedRecordSnapshot(recordId, read) {
      const snapshot = snapshots.get(recordId);
      if (!snapshot) throw new Error("missing test prepared snapshot");
      return read(structuredClone(snapshot));
    },
    async withCommittedPreparedRecordSnapshotBatch(recordIds, read) {
      return read(
        recordIds.map((recordId) => {
          const snapshot = snapshots.get(recordId);
          if (!snapshot) throw new Error("missing test prepared snapshot");
          return structuredClone(snapshot);
        }),
      );
    },
  };
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g)!.map((byte) => Number.parseInt(byte, 16)));
}
