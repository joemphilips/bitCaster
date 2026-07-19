import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hexToBytes } from "@noble/hashes/utils.js";
import { decode } from "cborg";
import { encodeCanonicalBackupCbor as encodeCanonical } from "../src/encryptedWalletBackupCbor.ts";
import {
  beginEncryptedWalletBackupManifestSnapshot,
  continueEncryptedWalletBackupManifestPassA,
  readEncryptedWalletBackupManifestSnapshot,
  resumeEncryptedWalletBackupManifestSnapshot,
  type EncryptedWalletBackupManifestPassACursor,
  type EncryptedWalletBackupManifestSerializedPage,
  type EncryptedWalletBackupManifestSnapshotStore,
  type EncryptedWalletBackupManifestSnapshotTransaction,
} from "../src/encryptedWalletBackupManifestSnapshot.ts";
import * as manifestSnapshotModule from "../src/encryptedWalletBackupManifestSnapshot.ts";
import {
  digestEncryptedWalletBackupLogicalInventory,
  measureEncryptedWalletBackupManifestPage,
  type EncryptedWalletBackupManifestLogicalBinding,
} from "../src/encryptedWalletBackupManifestInventory.ts";
import {
  deserializeEncryptedWalletBackupManifestPageBoundary,
  deserializeEncryptedWalletBackupManifestSnapshotControl,
  deserializeEncryptedWalletBackupManifestSnapshotRow,
  deserializeEncryptedWalletBackupManifestSourceControl,
  serializeEncryptedWalletBackupManifestPageBoundary,
  serializeEncryptedWalletBackupManifestSnapshotControl,
  serializeEncryptedWalletBackupManifestSourceControl,
  type PersistedEncryptedWalletBackupManifestSourceControl,
} from "../src/encryptedWalletBackupManifestSnapshotCodec.ts";
import {
  derivePendingSendParentCommitment,
  derivePendingSendParentFragmentRecordId,
} from "../src/encryptedWalletBackupPendingSendParentCodec.ts";
import {
  derivePendingSendProgressionCommitment,
  derivePendingSendProgressionFragmentRecordId,
} from "../src/encryptedWalletBackupPendingSendProgressionCodec.ts";

const realm = "manifest-snapshot-test";
const vaultId = "11".repeat(32);
const snapshotId = "wallet-snapshot-7";
const snapshotRevision = 7;
const sourceVersion = 3;

describe("bounded encrypted-wallet manifest snapshot", () => {
  it("does not expose caller-authored manifest population authority", () => {
    assert.equal(
      "populateEncryptedWalletBackupManifestSnapshot" in manifestSnapshotModule,
      false,
    );
  });

  it("scans one immutable source namespace and records exact Pass-A progress", async () => {
    const parentCommitment = pendingParentCommitment("44".repeat(32), 2);
    const rows = [
      proofRow(3),
      pendingParent(0, 2),
      proofRow(1),
      pendingParent(1, 2),
      pendingProgression(0, 1, "44".repeat(32), parentCommitment),
    ];
    const store = sourceStore("build-a", rows);
    const cursor = await beginEncryptedWalletBackupManifestSnapshot({
      store,
      buildId: "build-a",
      expectedSourceVersion: sourceVersion,
    });
    const complete = await continueUntilComplete(store, cursor);
    const expected = digestEncryptedWalletBackupLogicalInventory(
      rows.map(binding),
    );

    assert.equal(complete.state, "complete");
    assert.equal(complete.recordCount, rows.length);
    assert.equal(complete.logicalInventoryRoot, expected.root);
    assert.equal(complete.pendingGroupCount, 2);
    assert.equal(complete.pendingFragmentCount, 3);
    assert.equal(complete.pageCount, 1);
    assert.deepEqual(
      store.inventoryOrder.slice(0, rows.length),
      [...rows].sort(compareRows).map((row) => bindingKey(binding(row))),
    );
    assert.ok(store.maxObservedRows <= 256);
    assert.ok(store.maxObservedBytes <= 1_048_576);
  });

  it("completes an empty wallet through the canonical Pass-A states", async () => {
    const store = sourceStore("build-empty", []);
    let cursor = await beginEncryptedWalletBackupManifestSnapshot({
      store,
      buildId: "build-empty",
      expectedSourceVersion: sourceVersion,
    });
    assert.equal(cursor.state, "inventory");
    const states: string[] = [];
    while (cursor.state !== "complete") {
      cursor = await continueEncryptedWalletBackupManifestPassA({
        store,
        cursor,
        expectedVersion: cursor.version,
      });
      states.push(cursor.state);
    }
    assert.deepEqual(states, ["pending", "boundaries", "complete"]);
    assert.equal(cursor.version, 3);
    assert.equal(cursor.recordCount, 0);
    assert.equal(cursor.pageCount, 0);
    assert.equal(
      cursor.logicalInventoryRoot,
      digestEncryptedWalletBackupLogicalInventory([]).root,
    );
  });

  it("resumes from source-bound progress without accepting replacement scope", async () => {
    const rows = Array.from({ length: 126 }, (_, index) => capacityRow(index));
    const store = sourceStore("build-restart", rows);
    const cursor = await beginEncryptedWalletBackupManifestSnapshot({
      store,
      buildId: "build-restart",
      expectedSourceVersion: sourceVersion,
    });
    const first = await continueEncryptedWalletBackupManifestPassA({
      store,
      cursor,
      expectedVersion: cursor.version,
    });
    assert.equal(first.state, "populating");
    assert.equal(first.recordCount, 125);

    const resumed = await resumeEncryptedWalletBackupManifestSnapshot({
      store,
      buildId: first.buildId,
      expectedSourceVersion: sourceVersion,
    });
    assert.equal(resumed.version, first.version);
    assert.equal(
      (await continueUntilComplete(store, resumed)).state,
      "complete",
    );
    await assert.rejects(
      resumeEncryptedWalletBackupManifestSnapshot({
        store,
        buildId: first.buildId,
        expectedSourceVersion: sourceVersion + 1,
      }),
      /source version/,
    );
  });

  it("rolls back and resumes every persisted Pass-A transition", async () => {
    const logicalRecordId = "44".repeat(32);
    const parentCommitment = pendingParentCommitment(logicalRecordId, 2);
    const rows = [
      ...Array.from({ length: 513 }, (_, index) => capacityRow(index)),
      pendingParent(0, 2),
      pendingParent(1, 2),
      pendingProgression(0, 1, logicalRecordId, parentCommitment),
    ];
    const store = sourceStore("build-faults", rows);
    let cursor = await beginEncryptedWalletBackupManifestSnapshot({
      store,
      buildId: "build-faults",
      expectedSourceVersion: sourceVersion,
    });

    while (cursor.state !== "complete") {
      const stale = cursor;
      const before = store.control!.slice();
      store.rejectNextCommit = true;
      await assert.rejects(
        continueEncryptedWalletBackupManifestPassA({
          store,
          cursor,
          expectedVersion: cursor.version,
        }),
        /injected manifest snapshot commit failure/,
      );
      assert.deepEqual(store.control, before);

      cursor = await continueEncryptedWalletBackupManifestPassA({
        store,
        cursor,
        expectedVersion: cursor.version,
      });
      await assert.rejects(
        continueEncryptedWalletBackupManifestPassA({
          store,
          cursor: stale,
          expectedVersion: stale.version,
        }),
        /CAS mismatch/,
      );
      const resumed = await resumeEncryptedWalletBackupManifestSnapshot({
        store,
        buildId: cursor.buildId,
        expectedSourceVersion: sourceVersion,
      });
      assert.equal(resumed.version, cursor.version);
      assert.equal(resumed.state, cursor.state);
      cursor = resumed;
    }
  });

  it("strictly rejects malformed proof metadata and duplicate logical identity", async () => {
    const malformed = sourceStore("build-invalid-proof", [
      {
        sourceOrdinal: 0,
        sourceRecordOrdinal: 0,
        canonicalManifestEntry: proofEntryWithIdentity({
          recordId: "ab".repeat(32),
          commitment: "cd".repeat(32),
          mint: "not-a-normalized-mint",
        }),
      },
    ]);
    const malformedCursor = await beginEncryptedWalletBackupManifestSnapshot({
      store: malformed,
      buildId: "build-invalid-proof",
      expectedSourceVersion: sourceVersion,
    });
    await assert.rejects(
      continueEncryptedWalletBackupManifestPassA({
        store: malformed,
        cursor: malformedCursor,
        expectedVersion: malformedCursor.version,
      }),
      /mint|manifest|proof/,
    );

    const first = proofRow(41);
    const duplicate = {
      ...first,
      sourceOrdinal: 42,
      canonicalManifestEntry: proofEntryWithIdentity({
        recordId: binding(first).recordId,
        commitment: "ef".repeat(32),
      }),
    };
    assert.throws(
      () =>
        digestEncryptedWalletBackupLogicalInventory(
          [first, duplicate].map(binding),
        ),
      /logical record|duplicate|identity/,
    );
    const duplicateStore = sourceStore("build-duplicate", [first, duplicate]);
    const duplicateCursor = await beginEncryptedWalletBackupManifestSnapshot({
      store: duplicateStore,
      buildId: "build-duplicate",
      expectedSourceVersion: sourceVersion,
    });
    await assert.rejects(
      continueEncryptedWalletBackupManifestPassA({
        store: duplicateStore,
        cursor: duplicateCursor,
        expectedVersion: duplicateCursor.version,
      }),
      /logical record|duplicate|identity/,
    );
  });

  it("rejects orphaned and aggregate-invalid pending groups", async () => {
    const logicalRecordId = "44".repeat(32);
    await assertPassARejects(
      "build-invalid-parent",
      [
        pendingParent(0, 2, "fe".repeat(32)),
        pendingParent(1, 2, "fe".repeat(32)),
      ],
      /parent aggregate commitment/,
    );

    const parentCommitment = pendingParentCommitment(logicalRecordId, 2);
    await assertPassARejects(
      "build-invalid-child",
      [
        pendingParent(0, 2),
        pendingParent(1, 2),
        pendingProgression(
          0,
          1,
          logicalRecordId,
          parentCommitment,
          "fd".repeat(32),
        ),
      ],
      /child aggregate commitment/,
    );

    await assertPassARejects(
      "build-orphan-child",
      [pendingProgression(0, 1)],
      /orphaned/,
    );
  });

  it("rejects corrupt complete controls and noncanonical page boundaries", async () => {
    const store = sourceStore("build-codecs", [proofRow(1)]);
    const cursor = await beginEncryptedWalletBackupManifestSnapshot({
      store,
      buildId: "build-codecs",
      expectedSourceVersion: sourceVersion,
    });
    const complete = await continueUntilComplete(store, cursor);
    const control = deserializeEncryptedWalletBackupManifestSnapshotControl(
      store.control!,
    );
    const source = deserializeEncryptedWalletBackupManifestSourceControl(
      store.sourceControl,
    );
    assert.equal(complete.state, "complete");
    assert.throws(
      () =>
        serializeEncryptedWalletBackupManifestSourceControl({
          ...source,
          dataObjectCount: 0,
        }),
      /source cardinality/,
    );
    assert.throws(
      () =>
        serializeEncryptedWalletBackupManifestSnapshotControl({
          ...control,
          boundaryRecordCount: 0,
        }),
      /complete equation|boundary equation/,
    );
    assert.throws(
      () =>
        serializeEncryptedWalletBackupManifestSnapshotControl({
          ...control,
          inventoryCursor: "0:a:b",
        }),
      /binding cursor/,
    );
    assert.throws(
      () =>
        serializeEncryptedWalletBackupManifestSnapshotControl({
          ...control,
          version: control.version + 1,
        }),
      /version equation/,
    );
    assert.throws(
      () =>
        serializeEncryptedWalletBackupManifestSnapshotControl({
          ...control,
          pendingCursor: null,
          pendingGroupCount: 5,
          pendingFragmentCount: 0,
        }),
      /pending progress equation/,
    );

    const exactBindingKey = `0:${"aa".repeat(32)}:${"bb".repeat(32)}`;
    const largeComplete = {
      ...control,
      version: 12,
      sourceCursor: "0001:000",
      populatedRecordCount: 513,
      expectedRecordCount: 513,
      expectedDataObjectCount: 2,
      inventoryCursor: exactBindingKey,
      inventoryLeafCount: 2,
      inventoryRecordCount: 513,
      boundaryCursor: exactBindingKey,
      boundaryCount: 2,
      boundaryRecordCount: 513,
    } as const;
    assert.doesNotThrow(() =>
      serializeEncryptedWalletBackupManifestSnapshotControl(largeComplete),
    );
    assert.throws(
      () =>
        serializeEncryptedWalletBackupManifestSnapshotControl({
          ...largeComplete,
          boundaryCount: 1,
        }),
      /boundary cardinality equation/,
    );
    const boundary = serializeEncryptedWalletBackupManifestPageBoundary({
      schemaVersion: 1,
      buildId: "build-codecs",
      pageIndex: 0,
      entryCount: 1,
      firstBindingKey: exactBindingKey,
      lastBindingKey: exactBindingKey,
    });
    assert.equal(
      deserializeEncryptedWalletBackupManifestPageBoundary(boundary).pageIndex,
      0,
    );
    await assert.rejects(
      async () =>
        deserializeEncryptedWalletBackupManifestPageBoundary(
          new Uint8Array([...boundary, 0]),
        ),
      /page boundary/,
    );
    assert.throws(
      () =>
        serializeEncryptedWalletBackupManifestPageBoundary({
          schemaVersion: 1,
          buildId: "build-codecs",
          pageIndex: 0,
          entryCount: 1,
          firstBindingKey: "0:a:b",
          lastBindingKey: "0:a:b",
        }),
      /binding cursor/,
    );
  });

  it("persists exact-fit and one-byte-over valid manifest boundaries", async () => {
    const exactRows = exactManifestBoundaryRows();
    const generation = 1;
    const nonce = hexToBytes("12".repeat(16));
    assert.equal(
      measureEncryptedWalletBackupManifestPage(
        generation,
        nonce,
        0,
        exactRows.map(({ canonicalManifestEntry }) => canonicalManifestEntry),
      ),
      65_532,
    );
    const exactStore = sourceStore("build-boundary-exact", exactRows);
    const exactCursor = await beginEncryptedWalletBackupManifestSnapshot({
      store: exactStore,
      buildId: "build-boundary-exact",
      expectedSourceVersion: sourceVersion,
    });
    assert.equal(
      (await continueUntilComplete(exactStore, exactCursor)).pageCount,
      1,
    );

    const last = exactRows.at(-1)!;
    const lastWire = decode(last.canonicalManifestEntry) as unknown[];
    lastWire[5] = `${lastWire[5] as string}a`;
    const oversizedRows = [
      ...exactRows.slice(0, -1),
      { ...last, canonicalManifestEntry: encodeCanonical(lastWire) },
    ];
    assert.equal(
      measureEncryptedWalletBackupManifestPage(
        generation,
        nonce,
        0,
        oversizedRows.map(
          ({ canonicalManifestEntry }) => canonicalManifestEntry,
        ),
      ),
      65_533,
    );
    const oversizedStore = sourceStore(
      "build-boundary-oversized",
      oversizedRows,
    );
    const oversizedCursor = await beginEncryptedWalletBackupManifestSnapshot({
      store: oversizedStore,
      buildId: "build-boundary-oversized",
      expectedSourceVersion: sourceVersion,
    });
    assert.equal(
      (await continueUntilComplete(oversizedStore, oversizedCursor)).pageCount,
      2,
    );
  });

  it("streams the 54,000-record in-memory capacity with bounded transactions", async () => {
    const recordCount = 54_000;
    const rows = Array.from({ length: recordCount }, (_, index) =>
      capacityRow(index),
    );
    const store = sourceStore("build-capacity-54k", rows, true);
    const cursor = await beginEncryptedWalletBackupManifestSnapshot({
      store,
      buildId: "build-capacity-54k",
      expectedSourceVersion: sourceVersion,
    });
    const complete = await continueUntilComplete(store, cursor, 4_096);

    assert.equal(complete.state, "complete");
    assert.equal(complete.recordCount, recordCount);
    assert.equal(store.rows.size, recordCount);
    assert.ok(store.leaves.size <= 106);
    assert.ok(store.boundaries.size <= 1_024);
    assert.ok(store.maxObservedRows <= 256);
    assert.ok(store.maxObservedBytes <= 1_048_576);
  });
});

async function continueUntilComplete(
  store: MemoryManifestSnapshotStore,
  initial: EncryptedWalletBackupManifestPassACursor,
  maxSteps = 128,
) {
  let cursor = initial;
  for (let step = 0; step < maxSteps; step += 1) {
    if (cursor.state === "complete")
      return readEncryptedWalletBackupManifestSnapshot({ store, cursor });
    cursor = await continueEncryptedWalletBackupManifestPassA({
      store,
      cursor,
      expectedVersion: cursor.version,
    });
  }
  throw new Error("manifest Pass A did not complete");
}

async function assertPassARejects(
  buildId: string,
  rows: readonly ManifestSourceRow[],
  expected: RegExp,
) {
  const store = sourceStore(buildId, rows);
  const cursor = await beginEncryptedWalletBackupManifestSnapshot({
    store,
    buildId,
    expectedSourceVersion: sourceVersion,
  });
  await assert.rejects(continueUntilComplete(store, cursor), expected);
}

interface ManifestSourceRow {
  readonly sourceOrdinal: number;
  readonly sourceRecordOrdinal: number;
  readonly canonicalManifestEntry: Uint8Array;
}

function sourceStore(
  buildId: string,
  rows: readonly ManifestSourceRow[],
  fast = false,
) {
  const source: PersistedEncryptedWalletBackupManifestSourceControl = {
    schemaVersion: 1,
    buildId,
    realm,
    vaultId,
    enrollmentEpoch: 1,
    parentGeneration: null,
    parentManifestDigest: null,
    parentReferenceSetDigest: null,
    parentHeadDigest: null,
    targetGeneration: 1,
    snapshotNonce: "12".repeat(16),
    snapshotId,
    snapshotRevision,
    sourceSetDigest: "21".repeat(32),
    replacementSetDigest: "22".repeat(32),
    removalSetDigest: "23".repeat(32),
    replacementPackIds: [],
    sourceVersion,
    recordCount: rows.length,
    dataObjectCount: rows.length === 0 ? 0 : Math.ceil(rows.length / 512),
  };
  return new MemoryManifestSnapshotStore(source, rows, fast);
}

function proofRow(value: number): ManifestSourceRow {
  return {
    sourceOrdinal: value,
    sourceRecordOrdinal: 0,
    canonicalManifestEntry: proofEntry(value),
  };
}

function proofEntry(value: number) {
  return proofEntryWithIdentity({
    recordId: value.toString(16).padStart(2, "0").repeat(32),
    commitment: (value + 16).toString(16).padStart(2, "0").repeat(32),
    amount: String(value + 1),
  });
}

function proofEntryWithIdentity(input: {
  recordId: string;
  commitment: string;
  mint?: string;
  amount?: string;
}) {
  return encodeCanonical([
    0,
    hexToBytes(input.recordId),
    hexToBytes(input.commitment),
    hexToBytes("22".repeat(16)),
    hexToBytes("33".repeat(32)),
    input.mint ?? "https://mint.example",
    "sat",
    input.amount ?? "1",
    0,
    null,
    1,
    1,
  ]);
}

function exactManifestBoundaryRows() {
  const nonce = hexToBytes("12".repeat(16));
  for (let adjustment = 0; adjustment < 4; adjustment += 1) {
    const prefix = Array.from({ length: 30 }, (_, index) =>
      paddedProofRow(index, index === 0 ? 2_000 - adjustment : 2_000),
    );
    for (let padding = 1; padding <= 2_000; padding += 1) {
      const rows = [...prefix, paddedProofRow(prefix.length, padding)];
      const bytes = measureEncryptedWalletBackupManifestPage(
        1,
        nonce,
        0,
        rows.map(({ canonicalManifestEntry }) => canonicalManifestEntry),
      );
      if (bytes === 65_532) return rows;
      if (bytes > 65_532) break;
    }
  }
  throw new Error("exact valid manifest boundary fixture was not found");
}

function paddedProofRow(index: number, mintPadding: number) {
  return {
    sourceOrdinal: 0,
    sourceRecordOrdinal: index,
    canonicalManifestEntry: proofEntryWithIdentity({
      recordId: capacityHex(index),
      commitment: capacityHex(index + 100_000),
      mint: `https://mint.example/${"a".repeat(mintPadding)}`,
      amount: String(index + 1),
    }),
  } satisfies ManifestSourceRow;
}

function capacityRow(index: number): ManifestSourceRow {
  return {
    sourceOrdinal: Math.floor(index / 512),
    sourceRecordOrdinal: index % 512,
    canonicalManifestEntry: proofEntryWithIdentity({
      recordId: capacityHex(index),
      commitment: capacityHex(index + 60_000),
      amount: String(index + 1),
    }),
  };
}

function capacityHex(value: number) {
  return value.toString(16).padStart(64, "0");
}

function pendingParent(
  fragmentIndex: number,
  fragmentCount: number,
  parentCommitment?: string,
): ManifestSourceRow {
  const logicalRecordId = "44".repeat(32);
  const exactParentCommitment =
    parentCommitment ?? pendingParentCommitment(logicalRecordId, fragmentCount);
  return {
    sourceOrdinal: 8,
    sourceRecordOrdinal: fragmentIndex,
    canonicalManifestEntry: encodeCanonical([
      1,
      hexToBytes(
        derivePendingSendParentFragmentRecordId(logicalRecordId, fragmentIndex),
      ),
      hexToBytes(pendingParentFragmentCommitment(fragmentIndex)),
      hexToBytes("22".repeat(16)),
      hexToBytes("33".repeat(32)),
      hexToBytes(logicalRecordId),
      hexToBytes(exactParentCommitment),
      fragmentIndex,
      fragmentCount,
    ]),
  };
}

function pendingProgression(
  fragmentIndex: number,
  fragmentCount: number,
  logicalRecordId = "77".repeat(32),
  parentCommitment = "88".repeat(32),
  childCommitment?: string,
): ManifestSourceRow {
  const fragmentCommitments = Array.from(
    { length: fragmentCount },
    (_, index) => pendingProgressionFragmentCommitment(index),
  );
  const exactChildCommitment =
    childCommitment ??
    derivePendingSendProgressionCommitment({
      logicalRecordId,
      parentCommitment,
      progression: "partial",
      fragmentCommitments,
    });
  return {
    sourceOrdinal: 9,
    sourceRecordOrdinal: fragmentIndex,
    canonicalManifestEntry: encodeCanonical([
      2,
      hexToBytes(
        derivePendingSendProgressionFragmentRecordId({
          logicalRecordId,
          parentCommitment,
          progression: "partial",
          fragmentIndex,
        }),
      ),
      hexToBytes(fragmentCommitments[fragmentIndex]!),
      hexToBytes("22".repeat(16)),
      hexToBytes("33".repeat(32)),
      hexToBytes(logicalRecordId),
      hexToBytes(parentCommitment),
      1,
      hexToBytes(exactChildCommitment),
      fragmentIndex,
      fragmentCount,
    ]),
  };
}

function pendingParentCommitment(
  logicalRecordId: string,
  fragmentCount: number,
) {
  return derivePendingSendParentCommitment(
    logicalRecordId,
    Array.from({ length: fragmentCount }, (_, index) =>
      pendingParentFragmentCommitment(index),
    ),
  );
}

function pendingParentFragmentCommitment(index: number) {
  return (index + 96).toString(16).padStart(2, "0").repeat(32);
}

function pendingProgressionFragmentCommitment(index: number) {
  return (index + 144).toString(16).padStart(2, "0").repeat(32);
}

function binding(
  row: ManifestSourceRow,
): EncryptedWalletBackupManifestLogicalBinding {
  const decoded = decode(row.canonicalManifestEntry) as unknown[];
  return {
    recordKindCode: decoded[0] as 0 | 1 | 2,
    recordId: Buffer.from(decoded[1] as Uint8Array).toString("hex"),
    commitment: Buffer.from(decoded[2] as Uint8Array).toString("hex"),
  };
}

function compareRows(left: ManifestSourceRow, right: ManifestSourceRow) {
  const a = binding(left);
  const b = binding(right);
  return (
    a.recordKindCode - b.recordKindCode ||
    a.recordId.localeCompare(b.recordId) ||
    a.commitment.localeCompare(b.commitment)
  );
}

function bindingKey(value: EncryptedWalletBackupManifestLogicalBinding) {
  return `${value.recordKindCode}:${value.recordId}:${value.commitment}`;
}

class TransactionBudget {
  rows = 0;
  bytes = 0;
  readonly maxRows: number;
  readonly maxBytes: number;

  constructor(maxRows: number, maxBytes: number) {
    this.maxRows = maxRows;
    this.maxBytes = maxBytes;
  }

  add(row: Uint8Array) {
    this.rows += 1;
    this.bytes += row.byteLength;
    if (this.rows > this.maxRows || this.bytes > this.maxBytes)
      throw new Error("manifest snapshot transaction budget exceeded");
  }

  addPage(rows: readonly Uint8Array[]) {
    for (const row of rows) this.add(row);
  }
}

class MemoryManifestSnapshotStore implements EncryptedWalletBackupManifestSnapshotStore {
  readonly sourceControl: Uint8Array;
  sourceKeys: string[];
  sourceIndex: Uint8Array[];
  control: Uint8Array | null = null;
  rows = new Map<string, Uint8Array>();
  logicalIds = new Set<string>();
  commitments = new Set<string>();
  leaves = new Map<number, Uint8Array>();
  groups = new Map<string, Uint8Array>();
  boundaries = new Map<number, Uint8Array>();
  inventoryOrder: string[] = [];
  pendingOrder: string[] = [];
  inventoryIndex: Uint8Array[] | null = null;
  inventoryKeys: string[] | null = null;
  pendingIndex: Map<string, Uint8Array[]> | null = null;
  pendingKeys: string[] | null = null;
  maxObservedRows = 0;
  maxObservedBytes = 0;
  rejectNextCommit = false;
  readonly fast: boolean;

  constructor(
    source: PersistedEncryptedWalletBackupManifestSourceControl,
    rows: readonly ManifestSourceRow[],
    fast = false,
  ) {
    this.fast = fast;
    this.sourceControl =
      serializeEncryptedWalletBackupManifestSourceControl(source);
    const sourceEntries = rows
      .map(
        (row) => [sourceKey(row), rawSnapshotRow(source.buildId, row)] as const,
      )
      .sort(([left], [right]) => left.localeCompare(right));
    this.sourceKeys = sourceEntries.map(([key]) => key);
    this.sourceIndex = sourceEntries.map(([, row]) => row);
  }

  async readManifestSnapshotControl() {
    return this.control?.slice() ?? null;
  }

  async withManifestSnapshotVersionTransaction<T>(
    expected: {
      buildId: string;
      sourceVersion: number;
      snapshotVersion: number | null;
    },
    budget: { maxRowOperations: number; maxBytes: number },
    use: (
      transaction: EncryptedWalletBackupManifestSnapshotTransaction,
    ) => Promise<T>,
  ) {
    const source = deserializeEncryptedWalletBackupManifestSourceControl(
      this.sourceControl,
    );
    const snapshotVersion =
      this.control === null
        ? null
        : deserializeEncryptedWalletBackupManifestSnapshotControl(this.control)
            .version;
    if (
      source.buildId !== expected.buildId ||
      source.sourceVersion !== expected.sourceVersion ||
      snapshotVersion !== expected.snapshotVersion
    )
      throw new Error("manifest snapshot CAS mismatch");
    const target = this.fast ? this : this.clone();
    const accounting = new TransactionBudget(
      budget.maxRowOperations,
      budget.maxBytes,
    );
    accounting.add(this.sourceControl);
    if (this.control !== null) accounting.add(this.control);
    const result = await use(target.transaction(accounting));
    this.maxObservedRows = Math.max(this.maxObservedRows, accounting.rows);
    this.maxObservedBytes = Math.max(this.maxObservedBytes, accounting.bytes);
    if (
      this.rejectNextCommit &&
      !sameOptionalBytes(this.control, target.control)
    ) {
      this.rejectNextCommit = false;
      throw new Error("injected manifest snapshot commit failure");
    }
    if (!this.fast) this.commit(target);
    return result;
  }

  transaction(
    accounting: TransactionBudget,
  ): EncryptedWalletBackupManifestSnapshotTransaction {
    return {
      readSourceControl: async () => this.sourceControl.slice(),
      readControl: async () => this.control?.slice() ?? null,
      writeControl: async (row) => {
        accounting.add(row);
        this.control = row.slice();
      },
      readSourcePage: async (_buildId, _version, after, limit, maxBytes) => {
        const start = upperBound(this.sourceKeys, after);
        const selected = boundedRows(this.sourceIndex, limit, maxBytes, start);
        accounting.addPage(selected);
        return page(selected);
      },
      insertSnapshotRow: async (_key, row) => {
        const decoded =
          deserializeEncryptedWalletBackupManifestSnapshotRow(row);
        const logicalId = `${decoded.recordKindCode}:${decoded.recordId}`;
        if (this.logicalIds.has(logicalId))
          throw new Error(
            "manifest snapshot logical record identity is duplicated",
          );
        if (this.commitments.has(decoded.commitment))
          throw new Error("manifest snapshot commitment is duplicated");
        accounting.add(row);
        this.rows.set(sourcePositionKey(decoded), row.slice());
        this.logicalIds.add(logicalId);
        this.commitments.add(decoded.commitment);
        this.inventoryIndex = null;
        this.inventoryKeys = null;
        this.pendingIndex = null;
        this.pendingKeys = null;
      },
      readInventoryPage: async (_buildId, after, limit, maxBytes) => {
        this.ensureInventoryIndex();
        const start = upperBound(this.inventoryKeys!, after);
        const selected = boundedRows(
          this.inventoryIndex!,
          limit,
          maxBytes,
          start,
        );
        this.inventoryOrder.push(
          ...this.inventoryKeys!.slice(start, start + selected.length),
        );
        accounting.addPage(selected);
        return page(selected);
      },
      readPendingGroupKeys: async (_buildId, after, limit) => {
        this.ensurePendingIndex();
        const start = upperBound(this.pendingKeys!, after);
        const keys = this.pendingKeys!.slice(start, start + limit);
        for (const key of keys) accounting.add(encodeCanonical(key));
        return keys;
      },
      readPendingFragmentPage: async (
        _buildId,
        groupKey,
        afterIndex,
        limit,
        maxBytes,
      ) => {
        this.ensurePendingIndex();
        const group = this.pendingIndex!.get(groupKey) ?? [];
        const selected = boundedRows(group, limit, maxBytes, afterIndex + 1);
        this.pendingOrder.push(
          ...selected.map((row) => `${groupKey}:${fragmentIndex(row)}`),
        );
        accounting.addPage(selected);
        return page(selected);
      },
      readPendingGroup: async (key) => {
        const row = this.groups.get(key);
        if (row !== undefined) accounting.add(row);
        return row?.slice() ?? null;
      },
      insertInventoryLeaf: async (index, row) => {
        if (this.leaves.has(index)) throw new Error("leaf conflict");
        accounting.add(row);
        this.leaves.set(index, row.slice());
      },
      readInventoryLeaves: async (_buildId, after, limit, maxBytes) => {
        const selected = boundedRows(
          [...this.leaves]
            .sort(([left], [right]) => left - right)
            .filter(([index]) => after === null || index > after)
            .map(([, row]) => row),
          limit,
          maxBytes,
        );
        accounting.addPage(selected);
        return page(selected);
      },
      insertPendingGroup: async (key, row) => {
        if (this.groups.has(key)) throw new Error("group conflict");
        accounting.add(row);
        this.groups.set(key, row.slice());
      },
      insertPageBoundary: async (index, row) => {
        if (this.boundaries.has(index)) throw new Error("boundary conflict");
        accounting.add(row);
        this.boundaries.set(index, row.slice());
      },
    };
  }

  ensureInventoryIndex() {
    if (this.inventoryIndex !== null) return;
    this.inventoryIndex = [...this.rows.values()].sort((a, b) =>
      rowKey(a).localeCompare(rowKey(b)),
    );
    this.inventoryKeys = this.inventoryIndex.map(rowKey);
  }

  ensurePendingIndex() {
    if (this.pendingIndex !== null) return;
    const groups = new Map<string, Uint8Array[]>();
    for (const row of this.rows.values()) {
      const key = pendingKey(row);
      if (key === null) continue;
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    for (const group of groups.values())
      group.sort((left, right) => fragmentIndex(left) - fragmentIndex(right));
    this.pendingIndex = groups;
    this.pendingKeys = [...groups.keys()].sort();
  }

  clone() {
    const source = deserializeEncryptedWalletBackupManifestSourceControl(
      this.sourceControl,
    );
    const clone = new MemoryManifestSnapshotStore(source, [], false);
    clone.control = this.control?.slice() ?? null;
    clone.sourceKeys = this.sourceKeys;
    clone.sourceIndex = this.sourceIndex;
    clone.rows = cloneMap(this.rows);
    clone.logicalIds = new Set(this.logicalIds);
    clone.commitments = new Set(this.commitments);
    clone.leaves = cloneMap(this.leaves);
    clone.groups = cloneMap(this.groups);
    clone.boundaries = cloneMap(this.boundaries);
    clone.inventoryOrder = this.inventoryOrder;
    clone.pendingOrder = this.pendingOrder;
    clone.inventoryIndex = this.inventoryIndex;
    clone.inventoryKeys = this.inventoryKeys;
    clone.pendingIndex = this.pendingIndex;
    clone.pendingKeys = this.pendingKeys;
    return clone;
  }

  commit(clone: MemoryManifestSnapshotStore) {
    this.control = clone.control;
    this.rows = clone.rows;
    this.logicalIds = clone.logicalIds;
    this.commitments = clone.commitments;
    this.leaves = clone.leaves;
    this.groups = clone.groups;
    this.boundaries = clone.boundaries;
    this.inventoryIndex = clone.inventoryIndex;
    this.inventoryKeys = clone.inventoryKeys;
    this.pendingIndex = clone.pendingIndex;
    this.pendingKeys = clone.pendingKeys;
  }
}

function rawSnapshotRow(buildId: string, row: ManifestSourceRow) {
  return encodeCanonical([
    1,
    "encrypted-wallet-backup-manifest-snapshot-row",
    buildId,
    row.sourceOrdinal,
    row.sourceRecordOrdinal,
    row.canonicalManifestEntry,
  ]);
}

function boundedRows(
  rows: readonly Uint8Array[],
  limit: number,
  maxBytes: number,
  start = 0,
) {
  const selected: Uint8Array[] = [];
  let bytes = 0;
  for (let index = start; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (selected.length === limit || bytes + row.byteLength > maxBytes) break;
    selected.push(row.slice());
    bytes += row.byteLength;
  }
  return selected;
}

function cloneMap<K>(value: Map<K, Uint8Array>) {
  return new Map([...value].map(([key, row]) => [key, row.slice()]));
}

function page(
  rows: readonly Uint8Array[],
): EncryptedWalletBackupManifestSerializedPage {
  return {
    rows: rows.map((row) => row.slice()),
    serializedBytes: rows.reduce((sum, row) => sum + row.byteLength, 0),
  };
}

function sameOptionalBytes(left: Uint8Array | null, right: Uint8Array | null) {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.byteLength === right.byteLength &&
      left.every((byte, index) => byte === right[index]))
  );
}

function rowJson(row: Uint8Array) {
  return deserializeEncryptedWalletBackupManifestSnapshotRow(row);
}

function rowKey(row: Uint8Array) {
  return bindingKey(rowJson(row));
}

function pendingKey(row: Uint8Array) {
  const value = rowJson(row);
  return value.logicalRecordId === null
    ? null
    : `${value.logicalRecordId}:${value.recordKindCode}`;
}

function fragmentIndex(row: Uint8Array) {
  return rowJson(row).fragmentIndex as number;
}

function sourceKey(row: ManifestSourceRow) {
  return `${row.sourceOrdinal.toString().padStart(4, "0")}:${row.sourceRecordOrdinal
    .toString()
    .padStart(3, "0")}`;
}

function sourcePositionKey(row: {
  sourceOrdinal: number;
  sourceRecordOrdinal: number;
}) {
  return sourceKey({ ...row, canonicalManifestEntry: new Uint8Array() });
}

function upperBound(keys: readonly string[], after: string | null) {
  if (after === null) return 0;
  let low = 0;
  let high = keys.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (keys[middle]! <= after) low = middle + 1;
    else high = middle;
  }
  return low;
}
