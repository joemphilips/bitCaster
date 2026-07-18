import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import * as Cashu from "@cashu/cashu-ts";
import { bytesToHex } from "@noble/hashes/utils.js";
import { decode } from "cborg";
import {
  createEncryptedWalletBackupKeyHandle,
  packEncryptedWalletBackupDataChunk,
  prepareEncryptedWalletBackupPendingSendParent,
  prepareEncryptedWalletBackupPendingSendProgression,
  prepareEncryptedWalletBackupProof,
} from "../src/encryptedWalletBackup.ts";
import {
  rehydratePreparedEncryptedWalletBackupRecord,
  sealPreparedEncryptedWalletBackupRecord,
  type EncryptedWalletBackupPreparedRecordSnapshot,
  type EncryptedWalletBackupPreparedRecordSnapshotStore,
  type PersistedPreparedEncryptedWalletBackupRecord,
} from "../src/encryptedWalletBackupPreparedRecordPersistence.ts";
import { encodeCanonicalBackupCbor as encodeCanonical } from "../src/encryptedWalletBackupCbor.ts";
import { validatePreparedEncryptedWalletBackupRecord } from "../src/encryptedWalletBackupPreparedRecordValidation.ts";
import {
  PENDING_SEND_FIXTURE_SEED,
  createPartialPendingSendDeliveryRecord,
  createPendingSendFixture,
  exactPendingSendSnapshotStore,
} from "./encryptedWalletBackupPendingSendFixture.ts";

const proofVector = JSON.parse(
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
    proof: {
      mint: string;
      unit: string;
      keysetId: string;
      amount: string;
      signatureHex: string;
      dleq: { e: string; s: string; r: string };
      createdAtUnixSeconds: number;
      updatedAtUnixSeconds: number;
    };
  };
  expected: { canonicalCborHex: string };
};

test("direct persistence subpath rehydrates a prepared deterministic proof after process restart", async () => {
  const fixture = await preparedProofFixture();
  const persisted = await sealPreparedEncryptedWalletBackupRecord(fixture);
  const bindings = runRestartChild({
    seed: fixture.seed,
    realm: fixture.realm,
    records: [{ persisted, snapshot: fixture.snapshot }],
  });
  assert.deepEqual(bindings, [
    {
      recordId: fixture.snapshot.recordId,
      commitment: fixture.snapshot.commitment,
      recordKindCode: fixture.snapshot.recordKindCode,
    },
  ]);
});

test("prepared pending parent and child fragments survive process restart with exact SDK authority", async () => {
  const fixture = await pendingFixture();
  const records: RestartRecord[] = [];
  for (const prepared of [
    ...fixture.parent.records,
    ...fixture.child.records,
  ]) {
    const snapshot = preparedSnapshot(
      fixture.snapshotId,
      fixture.snapshotRevision,
      prepared,
    );
    const store = exactPreparedSnapshotStore(snapshot);
    const persisted = await sealPreparedEncryptedWalletBackupRecord({
      keyHandle: fixture.keyHandle,
      seed: PENDING_SEND_FIXTURE_SEED,
      record: prepared,
      snapshotStore: store,
    });
    records.push({ persisted, snapshot });
  }
  const bindings = runRestartChild({
    seed: PENDING_SEND_FIXTURE_SEED,
    realm: fixture.realm,
    records,
  });
  assert.deepEqual(
    bindings,
    records.map(({ snapshot }) => ({
      recordId: snapshot.recordId,
      commitment: snapshot.commitment,
      recordKindCode: snapshot.recordKindCode,
    })),
  );
});

test("every persisted authority field and unknown field fails closed when changed", async () => {
  const fixture = await preparedProofFixture();
  const persisted = await sealPreparedEncryptedWalletBackupRecord(fixture);
  const mutations: Array<(row: Record<string, unknown>) => void> = [
    (row) => {
      row.schemaVersion = 2;
    },
    (row) => {
      row.realm = "foreign-realm";
    },
    (row) => {
      row.vaultId = "12".repeat(32);
    },
    (row) => {
      row.snapshotId = "foreign-snapshot";
    },
    (row) => {
      row.snapshotRevision = 2;
    },
    (row) => {
      row.recordId = "13".repeat(32);
    },
    (row) => {
      row.commitment = "14".repeat(32);
    },
    (row) => {
      row.recordKindCode = 2;
    },
    (row) => {
      (row.canonicalRecord as Uint8Array)[0] ^= 1;
    },
    (row) => {
      (row.canonicalManifestEntry as Uint8Array)[0] ^= 1;
    },
    (row) => {
      (row.authenticationTag as Uint8Array)[0] ^= 1;
    },
    (row) => {
      row.unexpected = true;
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(persisted) as unknown as Record<
      string,
      unknown
    >;
    mutate(changed);
    await assert.rejects(
      rehydratePreparedEncryptedWalletBackupRecord({
        keyHandle: fixture.keyHandle,
        seed: fixture.seed,
        persisted:
          changed as unknown as PersistedPreparedEncryptedWalletBackupRecord,
        snapshotStore: fixture.snapshotStore,
      }),
    );
  }
});

test("canonical proof, parent, child, and manifest metadata are recomputed", async () => {
  const proof = await preparedProofFixture();
  const persistedProof = await sealPreparedEncryptedWalletBackupRecord(proof);
  assertSemanticTamperRejected(persistedProof, 7, "2");
  assertManifestTamperRejected(persistedProof);

  const pending = await pendingFixture();
  const records = [pending.parent.records[0]!, pending.child.records[0]!];
  for (const prepared of records) {
    const store = exactPreparedSnapshotStore(
      preparedSnapshot(pending.snapshotId, pending.snapshotRevision, prepared),
    );
    const persisted = await sealPreparedEncryptedWalletBackupRecord({
      keyHandle: pending.keyHandle,
      seed: PENDING_SEND_FIXTURE_SEED,
      record: prepared,
      snapshotStore: store,
    });
    const decoded = decode(persisted.canonicalRecord) as unknown[];
    const fragmentIndex = decoded.length - 1;
    const fragment = (decoded[fragmentIndex] as Uint8Array).slice();
    fragment[0] ^= 1;
    decoded[fragmentIndex] = fragment;
    assert.throws(() =>
      validatePreparedEncryptedWalletBackupRecord({
        seed: PENDING_SEND_FIXTURE_SEED,
        canonicalRecord: encodeCanonical(decoded),
        canonicalManifestEntry: persisted.canonicalManifestEntry,
      }),
    );
    assertManifestTamperRejected(persisted);
  }
});

test("host-shaped objects and stale snapshot callbacks never become preparation authority", async () => {
  const fixture = await preparedProofFixture();
  assert.throws(() =>
    packEncryptedWalletBackupDataChunk([
      { recordId: fixture.snapshot.recordId } as never,
    ]),
  );
  const persisted = await sealPreparedEncryptedWalletBackupRecord(fixture);
  await assert.rejects(
    rehydratePreparedEncryptedWalletBackupRecord({
      keyHandle: fixture.keyHandle,
      seed: fixture.seed,
      persisted,
      snapshotStore: exactPreparedSnapshotStore({
        ...fixture.snapshot,
        snapshotRevision: fixture.snapshot.snapshotRevision + 1,
      }),
    }),
    /snapshot changed/,
  );
  await assert.rejects(
    rehydratePreparedEncryptedWalletBackupRecord({
      keyHandle: fixture.keyHandle,
      seed: fixture.seed,
      persisted,
      snapshotStore: exactPreparedSnapshotStore({
        ...fixture.snapshot,
        unexpected: true,
      } as EncryptedWalletBackupPreparedRecordSnapshot),
    }),
    /snapshot is invalid/,
  );
  const foreignRealmHandle = await createEncryptedWalletBackupKeyHandle({
    seed: fixture.seed,
    realm: "foreign-prepared-record-test",
    runtime: cryptoRuntime(),
  });
  await assert.rejects(
    rehydratePreparedEncryptedWalletBackupRecord({
      keyHandle: foreignRealmHandle,
      seed: fixture.seed,
      persisted,
      snapshotStore: fixture.snapshotStore,
    }),
    /foreign vault/,
  );
  const foreignSeed = new Uint8Array(fixture.seed).fill(23);
  const foreignSeedHandle = await createEncryptedWalletBackupKeyHandle({
    seed: foreignSeed,
    realm: fixture.realm,
    runtime: cryptoRuntime(),
  });
  await assert.rejects(
    rehydratePreparedEncryptedWalletBackupRecord({
      keyHandle: foreignSeedHandle,
      seed: foreignSeed,
      persisted,
      snapshotStore: fixture.snapshotStore,
    }),
    /foreign vault/,
  );
});

interface RestartRecord {
  readonly persisted: PersistedPreparedEncryptedWalletBackupRecord;
  readonly snapshot: EncryptedWalletBackupPreparedRecordSnapshot;
}

function runRestartChild(input: {
  readonly seed: Uint8Array;
  readonly realm: string;
  readonly records: readonly RestartRecord[];
}): Array<{
  recordId: string;
  commitment: string;
  recordKindCode: number;
}> {
  const child = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(
        new URL(
          "./encryptedWalletBackupPreparedRecordPersistenceChild.ts",
          import.meta.url,
        ),
      ),
    ],
    {
      input: JSON.stringify({
        seed: [...input.seed],
        realm: input.realm,
        records: input.records.map(({ persisted, snapshot }) => ({
          persisted: {
            ...persisted,
            canonicalRecord: [...persisted.canonicalRecord],
            canonicalManifestEntry: [...persisted.canonicalManifestEntry],
            authenticationTag: [...persisted.authenticationTag],
          },
          snapshot,
        })),
      }),
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);
  return JSON.parse(child.stdout) as Array<{
    recordId: string;
    commitment: string;
    recordKindCode: number;
  }>;
}

function assertSemanticTamperRejected(
  persisted: PersistedPreparedEncryptedWalletBackupRecord,
  index: number,
  value: unknown,
): void {
  const decoded = decode(persisted.canonicalRecord) as unknown[];
  decoded[index] = value;
  assert.throws(() =>
    validatePreparedEncryptedWalletBackupRecord({
      seed: fromHex(proofVector.inputs.seedHex),
      canonicalRecord: encodeCanonical(decoded),
      canonicalManifestEntry: persisted.canonicalManifestEntry,
    }),
  );
}

function assertManifestTamperRejected(
  persisted: PersistedPreparedEncryptedWalletBackupRecord,
): void {
  const manifest = decode(persisted.canonicalManifestEntry) as unknown[];
  manifest[2] = new Uint8Array(32).fill(99);
  assert.throws(() =>
    validatePreparedEncryptedWalletBackupRecord({
      seed: fromHex(proofVector.inputs.seedHex),
      canonicalRecord: persisted.canonicalRecord,
      canonicalManifestEntry: encodeCanonical(manifest),
    }),
  );
}

async function preparedProofFixture() {
  const seed = fromHex(proofVector.inputs.seedHex);
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed,
    realm: "prepared-record-test",
    runtime: cryptoRuntime(),
  });
  const root = decode(
    fromHex(proofVector.expected.canonicalCborHex),
  ) as unknown[];
  const record = (root[2] as unknown[][])[0]!;
  const snapshot = {
    schemaVersion: 1 as const,
    snapshotId: "prepared-record-snapshot",
    snapshotRevision: 1,
    recordId: bytesToHex(record[2] as Uint8Array),
    commitment: bytesToHex(record[3] as Uint8Array),
    recordKindCode: 0 as const,
  };
  const proof = proofVector.inputs.proof;
  const prepared = await prepareEncryptedWalletBackupProof({
    keyHandle,
    seed,
    mint: proof.mint,
    unit: proof.unit,
    counter: record[11] as number,
    proof: {
      id: proof.keysetId,
      amount: proof.amount,
      secret: new TextDecoder().decode(record[8] as Uint8Array),
      C: proof.signatureHex,
      dleq: { ...proof.dleq },
    },
    proofKind: "ordinary",
    ctfMetadata: null,
    terminalEvidence: null,
    effectiveNowUnixSeconds: proof.createdAtUnixSeconds,
    createdAtUnixSeconds: proof.createdAtUnixSeconds,
    updatedAtUnixSeconds: proof.updatedAtUnixSeconds,
    proofSnapshotStore: {
      async withCommittedProofSnapshot(_proofId, read) {
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
  return {
    keyHandle,
    seed,
    realm: "prepared-record-test",
    record: prepared,
    snapshot,
    snapshotStore: exactPreparedSnapshotStore(snapshot),
  };
}

async function pendingFixture() {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: PENDING_SEND_FIXTURE_SEED,
    realm: "prepared-pending-test",
    runtime: cryptoRuntime(),
  });
  const fixture = createPendingSendFixture(2);
  const parent = await prepareEncryptedWalletBackupPendingSendParent({
    keyHandle,
    recordId: fixture.snapshot.recordId,
    snapshotStore: exactPendingSendSnapshotStore(fixture.snapshot),
  });
  const childSnapshot = {
    ...fixture.snapshot,
    progression: "partial" as const,
    parentCommitment: parent.parentCommitment,
    deliveryRecord: await createPartialPendingSendDeliveryRecord(
      fixture.deliveryRecord,
    ),
  };
  const child = await prepareEncryptedWalletBackupPendingSendProgression({
    keyHandle,
    recordId: childSnapshot.recordId,
    snapshotStore: exactPendingSendSnapshotStore(childSnapshot),
  });
  return {
    keyHandle,
    realm: "prepared-pending-test",
    parent,
    child,
    snapshotId: fixture.snapshot.snapshotId,
    snapshotRevision: fixture.snapshot.revision,
  };
}

function preparedSnapshot(
  snapshotId: string,
  snapshotRevision: number,
  prepared: { recordId: string; commitment: string; recordKindCode: 0 | 1 | 2 },
): EncryptedWalletBackupPreparedRecordSnapshot {
  return {
    schemaVersion: 1,
    snapshotId,
    snapshotRevision,
    recordId: prepared.recordId,
    commitment: prepared.commitment,
    recordKindCode: prepared.recordKindCode,
  };
}

function exactPreparedSnapshotStore(
  snapshot: EncryptedWalletBackupPreparedRecordSnapshot,
): EncryptedWalletBackupPreparedRecordSnapshotStore {
  return {
    async withCommittedPreparedRecordSnapshot(recordId, read) {
      if (recordId !== snapshot.recordId) throw new Error("record id changed");
      return read(structuredClone(snapshot));
    },
  };
}

function cryptoRuntime() {
  return {
    subtle: webcrypto.subtle,
    getRandomValues(target: Uint8Array) {
      return webcrypto.getRandomValues(target);
    },
  };
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (part) =>
    Number.parseInt(part, 16),
  );
}
