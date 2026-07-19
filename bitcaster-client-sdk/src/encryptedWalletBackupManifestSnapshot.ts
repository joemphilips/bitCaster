import { hexToBytes } from "@noble/hashes/utils.js";
import {
  compareEncryptedWalletBackupManifestBindings,
  digestEncryptedWalletBackupInventoryLeaf,
  digestEncryptedWalletBackupInventoryRoot,
  encryptedWalletBackupManifestBindingKey,
  measureEncryptedWalletBackupManifestPage,
  validateEncryptedWalletBackupPendingGroup,
  ENCRYPTED_WALLET_BACKUP_MANIFEST_INVENTORY_LEAF_MAX,
  ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_COUNT_MAX,
  ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_ENTRY_MAX,
  ENCRYPTED_WALLET_BACKUP_MANIFEST_SNAPSHOT_BYTES_MAX,
  ENCRYPTED_WALLET_BACKUP_MANIFEST_SNAPSHOT_ROW_MAX,
  type EncryptedWalletBackupManifestInventoryLeaf,
  type EncryptedWalletBackupManifestSnapshotRow,
} from "./encryptedWalletBackupManifestInventory.ts";
import {
  deserializeEncryptedWalletBackupManifestInventoryLeaf,
  deserializeEncryptedWalletBackupManifestPendingGroup,
  deserializeEncryptedWalletBackupManifestSnapshotControl,
  deserializeEncryptedWalletBackupManifestSnapshotRow,
  deserializeEncryptedWalletBackupManifestSourceControl,
  ENCRYPTED_WALLET_BACKUP_MANIFEST_POPULATION_SOURCE_ROW_MAX,
  manifestSnapshotScopeFromSource,
  requireEncryptedWalletBackupManifestSnapshotControl,
  serializeEncryptedWalletBackupManifestInventoryLeaf,
  serializeEncryptedWalletBackupManifestPageBoundary,
  serializeEncryptedWalletBackupManifestPendingGroup,
  serializeEncryptedWalletBackupManifestSnapshotControl,
  serializeEncryptedWalletBackupManifestSnapshotRow,
  type EncryptedWalletBackupManifestSnapshotScope,
  type PersistedEncryptedWalletBackupManifestSnapshotControl,
  type PersistedEncryptedWalletBackupManifestSourceControl,
} from "./encryptedWalletBackupManifestSnapshotCodec.ts";

const MANIFEST_PAGE_CBOR_MAX_BYTES = 65_532;
const DATA_READ_ROW_MAX = 254;
const CONTROL_BYTES_RESERVE = 16_384;
const DATA_READ_BYTES_MAX =
  ENCRYPTED_WALLET_BACKUP_MANIFEST_SNAPSHOT_BYTES_MAX - CONTROL_BYTES_RESERVE;
const POPULATION_SOURCE_BYTES_MAX = Math.floor(
  (ENCRYPTED_WALLET_BACKUP_MANIFEST_SNAPSHOT_BYTES_MAX -
    CONTROL_BYTES_RESERVE) /
    2,
);

export interface EncryptedWalletBackupManifestSerializedPage {
  readonly rows: readonly Uint8Array[];
  readonly serializedBytes: number;
}

export interface EncryptedWalletBackupManifestSnapshotTransaction {
  readSourceControl(buildId: string, maxBytes: number): Promise<Uint8Array>;
  readControl(buildId: string, maxBytes: number): Promise<Uint8Array | null>;
  writeControl(row: Uint8Array): Promise<void>;
  readSourcePage(
    buildId: string,
    sourceVersion: number,
    afterSourceKey: string | null,
    limit: number,
    maxBytes: number,
  ): Promise<EncryptedWalletBackupManifestSerializedPage>;
  insertSnapshotRow(sourceKey: string, row: Uint8Array): Promise<void>;
  readInventoryPage(
    buildId: string,
    after: string | null,
    limit: number,
    maxBytes: number,
  ): Promise<EncryptedWalletBackupManifestSerializedPage>;
  readPendingGroupKeys(
    buildId: string,
    after: string | null,
    limit: number,
  ): Promise<readonly string[]>;
  readPendingFragmentPage(
    buildId: string,
    groupKey: string,
    afterFragmentIndex: number,
    limit: number,
    maxBytes: number,
  ): Promise<EncryptedWalletBackupManifestSerializedPage>;
  readPendingGroup(
    groupKey: string,
    maxBytes: number,
  ): Promise<Uint8Array | null>;
  insertInventoryLeaf(index: number, row: Uint8Array): Promise<void>;
  readInventoryLeaves(
    buildId: string,
    afterLeafIndex: number | null,
    limit: number,
    maxBytes: number,
  ): Promise<EncryptedWalletBackupManifestSerializedPage>;
  insertPendingGroup(groupKey: string, row: Uint8Array): Promise<void>;
  insertPageBoundary(index: number, row: Uint8Array): Promise<void>;
}

export interface EncryptedWalletBackupManifestSnapshotStore {
  readManifestSnapshotControl(
    buildId: string,
    maxBytes: number,
  ): Promise<Uint8Array | null>;
  /**
   * Runs the callback exactly once in one transaction and enforces both the
   * immutable source version and snapshot-control CAS. The adapter owns strict
   * uniqueness for source position, logical record identity, commitment, and
   * pending fragment identity. The supplied budget counts every row read and
   * written and every serialized byte crossing the transaction boundary.
   */
  withManifestSnapshotVersionTransaction<T>(
    expected: Readonly<{
      buildId: string;
      sourceVersion: number;
      snapshotVersion: number | null;
    }>,
    budget: Readonly<{ maxRowOperations: number; maxBytes: number }>,
    use: (
      transaction: EncryptedWalletBackupManifestSnapshotTransaction,
    ) => Promise<T>,
  ): Promise<unknown>;
}

/**
 * Non-authoritative local progress. Even `state: "complete"` cannot authorize
 * upload or eviction; Pass B must reauthenticate the parent and source and
 * issue a separate runtime capability.
 */
export interface EncryptedWalletBackupManifestPassACursor extends EncryptedWalletBackupManifestSnapshotScope {
  readonly state: PersistedEncryptedWalletBackupManifestSnapshotControl["state"];
  readonly version: number;
  readonly recordCount: number;
  readonly logicalInventoryRoot: string | null;
  readonly pendingGroupCount: number;
  readonly pendingFragmentCount: number;
  readonly pageCount: number;
}

const CURSOR_SCOPES = new WeakMap<
  object,
  EncryptedWalletBackupManifestSnapshotScope
>();

export async function beginEncryptedWalletBackupManifestSnapshot(input: {
  readonly store: EncryptedWalletBackupManifestSnapshotStore;
  readonly buildId: string;
  readonly expectedSourceVersion: number;
}) {
  let source!: PersistedEncryptedWalletBackupManifestSourceControl;
  let control!: PersistedEncryptedWalletBackupManifestSnapshotControl;
  await exactTransaction(
    input.store,
    input.buildId,
    input.expectedSourceVersion,
    null,
    async (transaction) => {
      source = await readExactSource(
        transaction,
        input.buildId,
        input.expectedSourceVersion,
      );
      if (await transaction.readControl(input.buildId, CONTROL_BYTES_RESERVE))
        throw new Error("encrypted backup manifest snapshot already exists");
      control = initialControl(manifestSnapshotScopeFromSource(source));
      await transaction.writeControl(
        serializeEncryptedWalletBackupManifestSnapshotControl(control),
      );
    },
  );
  return issueCursor(control, control);
}

export async function resumeEncryptedWalletBackupManifestSnapshot(input: {
  readonly store: EncryptedWalletBackupManifestSnapshotStore;
  readonly buildId: string;
  readonly expectedSourceVersion: number;
}) {
  const control = await readControl(input.store, input.buildId);
  if (control.sourceVersion !== input.expectedSourceVersion)
    throw new Error("encrypted backup manifest source version changed");
  await exactTransaction(
    input.store,
    input.buildId,
    input.expectedSourceVersion,
    control.version,
    async (transaction) => {
      const source = await readExactSource(
        transaction,
        input.buildId,
        input.expectedSourceVersion,
      );
      requireSourceMatchesScope(source, control);
    },
  );
  return issueCursor(control, control);
}

export async function continueEncryptedWalletBackupManifestPassA(input: {
  readonly store: EncryptedWalletBackupManifestSnapshotStore;
  readonly cursor: EncryptedWalletBackupManifestPassACursor;
  readonly expectedVersion: number;
}) {
  const scope = readCursorScope(input.cursor);
  const control = await readControl(input.store, scope.buildId);
  requireScope(control, scope);
  if (control.version !== input.expectedVersion)
    throw new Error("encrypted backup manifest snapshot CAS mismatch");
  switch (control.state) {
    case "populating":
      return continuePopulation(input.store, scope, control);
    case "inventory":
      return continueInventory(input.store, scope, control);
    case "pending":
      return continuePending(input.store, scope, control);
    case "boundaries":
      return continueBoundaries(input.store, scope, control);
    case "complete":
      return issueCursor(scope, control);
  }
}

export async function readEncryptedWalletBackupManifestSnapshot(input: {
  readonly store: EncryptedWalletBackupManifestSnapshotStore;
  readonly cursor: EncryptedWalletBackupManifestPassACursor;
}) {
  const scope = readCursorScope(input.cursor);
  return issueCursor(scope, await readControl(input.store, scope.buildId));
}

async function continuePopulation(
  store: EncryptedWalletBackupManifestSnapshotStore,
  scope: EncryptedWalletBackupManifestSnapshotScope,
  control: PersistedEncryptedWalletBackupManifestSnapshotControl,
) {
  let next!: PersistedEncryptedWalletBackupManifestSnapshotControl;
  await exactTransaction(
    store,
    scope.buildId,
    scope.sourceVersion,
    control.version,
    async (transaction) => {
      next = await populateNextSourcePage(transaction, scope, control.version);
      await transaction.writeControl(
        serializeEncryptedWalletBackupManifestSnapshotControl(next),
      );
    },
  );
  return issueCursor(scope, next);
}

async function populateNextSourcePage(
  transaction: EncryptedWalletBackupManifestSnapshotTransaction,
  scope: EncryptedWalletBackupManifestSnapshotScope,
  version: number,
) {
  const current = await readExactControl(transaction, scope, version);
  const source = await readExactSource(
    transaction,
    scope.buildId,
    scope.sourceVersion,
  );
  requireSourceMatchesScope(source, scope);
  const remaining = scope.expectedRecordCount - current.populatedRecordCount;
  const requested = Math.min(
    ENCRYPTED_WALLET_BACKUP_MANIFEST_POPULATION_SOURCE_ROW_MAX,
    remaining,
  );
  const page = await transaction.readSourcePage(
    scope.buildId,
    scope.sourceVersion,
    current.sourceCursor,
    requested + 1,
    POPULATION_SOURCE_BYTES_MAX,
  );
  const rows = decodeSourcePage(page, scope.buildId, requested + 1);
  requirePopulationPage(current, rows, requested, remaining);
  const accepted = rows.slice(0, requested);
  for (const row of accepted)
    await transaction.insertSnapshotRow(
      sourcePositionKey(row),
      serializeEncryptedWalletBackupManifestSnapshotRow(row),
    );
  const populated = current.populatedRecordCount + accepted.length;
  return requireEncryptedWalletBackupManifestSnapshotControl({
    ...current,
    version: current.version + 1,
    state:
      populated === current.expectedRecordCount ? "inventory" : "populating",
    sourceCursor: sourcePositionKey(accepted.at(-1)!),
    populatedRecordCount: populated,
  });
}

async function continueInventory(
  store: EncryptedWalletBackupManifestSnapshotStore,
  scope: EncryptedWalletBackupManifestSnapshotScope,
  control: PersistedEncryptedWalletBackupManifestSnapshotControl,
) {
  if (control.inventoryRecordCount === control.expectedRecordCount)
    return sealInventory(store, scope, control);
  const count = Math.min(
    ENCRYPTED_WALLET_BACKUP_MANIFEST_INVENTORY_LEAF_MAX,
    control.expectedRecordCount - control.inventoryRecordCount,
  );
  const rows = await readInventoryRows(store, scope, control, count);
  requireInventoryContinuation(control, rows);
  const leaf = digestEncryptedWalletBackupInventoryLeaf({
    leafIndex: control.inventoryLeafCount,
    bindings: rows,
  });
  const next = requireEncryptedWalletBackupManifestSnapshotControl({
    ...control,
    version: control.version + 1,
    inventoryCursor: encryptedWalletBackupManifestBindingKey(rows.at(-1)!),
    inventoryLeafCount: control.inventoryLeafCount + 1,
    inventoryRecordCount: control.inventoryRecordCount + rows.length,
  });
  await writeInventoryLeaf(store, scope, control, next, leaf);
  return issueCursor(scope, next);
}

async function sealInventory(
  store: EncryptedWalletBackupManifestSnapshotStore,
  scope: EncryptedWalletBackupManifestSnapshotScope,
  control: PersistedEncryptedWalletBackupManifestSnapshotControl,
) {
  const leaves = await readInventoryLeaves(store, scope, control);
  const root = digestEncryptedWalletBackupInventoryRoot({
    recordCount: control.inventoryRecordCount,
    leaves,
  });
  const next = requireEncryptedWalletBackupManifestSnapshotControl({
    ...control,
    version: control.version + 1,
    state: "pending",
    logicalInventoryRoot: root,
  });
  await writeControlOnly(store, scope, control, next);
  return issueCursor(scope, next);
}

async function continuePending(
  store: EncryptedWalletBackupManifestSnapshotStore,
  scope: EncryptedWalletBackupManifestSnapshotScope,
  control: PersistedEncryptedWalletBackupManifestSnapshotControl,
) {
  const keys = await readPendingKeys(store, scope, control);
  if (keys.length === 0) {
    const next = requireEncryptedWalletBackupManifestSnapshotControl({
      ...control,
      version: control.version + 1,
      state: "boundaries",
    });
    await writeControlOnly(store, scope, control, next);
    return issueCursor(scope, next);
  }
  const rows = await readPendingGroupRows(store, scope, control, keys[0]!);
  const group = validateEncryptedWalletBackupPendingGroup(rows);
  await requirePendingParent(store, scope, control, group);
  const next = requireEncryptedWalletBackupManifestSnapshotControl({
    ...control,
    version: control.version + 1,
    pendingCursor: group.groupKey,
    pendingGroupCount: control.pendingGroupCount + 1,
    pendingFragmentCount: control.pendingFragmentCount + group.fragmentCount,
  });
  await writePendingGroup(store, scope, control, next, group);
  return issueCursor(scope, next);
}

async function requirePendingParent(
  store: EncryptedWalletBackupManifestSnapshotStore,
  scope: EncryptedWalletBackupManifestSnapshotScope,
  control: PersistedEncryptedWalletBackupManifestSnapshotControl,
  group: ReturnType<typeof validateEncryptedWalletBackupPendingGroup>,
) {
  if (group.recordKindCode === 1) return;
  let bytes: Uint8Array | null = null;
  await exactTransaction(
    store,
    scope.buildId,
    scope.sourceVersion,
    control.version,
    async (transaction) => {
      bytes = await transaction.readPendingGroup(
        `${group.logicalRecordId}:1`,
        CONTROL_BYTES_RESERVE,
      );
    },
  );
  if (bytes === null)
    throw new Error("encrypted backup pending child is orphaned");
  const parent = deserializeEncryptedWalletBackupManifestPendingGroup(bytes);
  if (
    parent.buildId !== scope.buildId ||
    parent.groupKey !== `${group.logicalRecordId}:1` ||
    parent.groupIndex >= control.pendingGroupCount ||
    parent.logicalRecordId !== group.logicalRecordId ||
    parent.recordKindCode !== 1 ||
    parent.parentCommitment !== group.parentCommitment ||
    parent.progressionCode !== null ||
    parent.childCommitment !== null
  )
    throw new Error("encrypted backup pending child parent changed");
}

async function continueBoundaries(
  store: EncryptedWalletBackupManifestSnapshotStore,
  scope: EncryptedWalletBackupManifestSnapshotScope,
  control: PersistedEncryptedWalletBackupManifestSnapshotControl,
) {
  if (control.boundaryRecordCount === control.expectedRecordCount) {
    const next = requireEncryptedWalletBackupManifestSnapshotControl({
      ...control,
      version: control.version + 1,
      state: "complete",
    });
    await writeControlOnly(store, scope, control, next);
    return issueCursor(scope, next);
  }
  const rows = await readInventoryRows(
    store,
    scope,
    control,
    ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_ENTRY_MAX,
    control.boundaryCursor,
  );
  const page = selectBoundaryRows(rows, scope, control.boundaryCount);
  const next = requireEncryptedWalletBackupManifestSnapshotControl({
    ...control,
    version: control.version + 1,
    boundaryCursor: encryptedWalletBackupManifestBindingKey(page.at(-1)!),
    boundaryCount: control.boundaryCount + 1,
    boundaryRecordCount: control.boundaryRecordCount + page.length,
  });
  await writeBoundary(store, scope, control, next, page);
  return issueCursor(scope, next);
}

function selectBoundaryRows(
  rows: readonly EncryptedWalletBackupManifestSnapshotRow[],
  scope: EncryptedWalletBackupManifestSnapshotScope,
  pageIndex: number,
) {
  if (rows.length === 0)
    throw new Error("encrypted backup manifest boundary page is missing");
  const fixedBytes = manifestPageFixedBytes(
    scope.targetGeneration,
    hexToBytes(scope.snapshotNonce),
    pageIndex,
  );
  let itemBytes = 0;
  let count = 0;
  for (const row of rows) {
    const nextItemBytes = itemBytes + row.canonicalManifestEntry.byteLength;
    const nextCount = count + 1;
    if (
      fixedBytes + cborArrayHeaderBytes(nextCount) + nextItemBytes >
      MANIFEST_PAGE_CBOR_MAX_BYTES
    ) {
      if (count === 0)
        throw new Error(
          "encrypted backup manifest entry exceeds page capacity",
        );
      break;
    }
    itemBytes = nextItemBytes;
    count = nextCount;
  }
  return rows.slice(0, count);
}

function manifestPageFixedBytes(
  generation: number,
  snapshotNonce: Uint8Array,
  pageIndex: number,
) {
  // The empty entries array contributes one byte (0x80). This exact helper is
  // called once per page, never once per candidate row.
  return (
    measureEncryptedWalletBackupManifestPage(
      generation,
      snapshotNonce,
      pageIndex,
      [],
    ) - 1
  );
}

function cborArrayHeaderBytes(length: number) {
  if (length < 24) return 1;
  if (length <= 0xff) return 2;
  if (length <= 0xffff) return 3;
  return 5;
}

async function readInventoryRows(
  store: EncryptedWalletBackupManifestSnapshotStore,
  scope: EncryptedWalletBackupManifestSnapshotScope,
  control: PersistedEncryptedWalletBackupManifestSnapshotControl,
  count: number,
  after = control.inventoryCursor,
) {
  const rows: EncryptedWalletBackupManifestSnapshotRow[] = [];
  let cursor = after;
  while (rows.length < count) {
    const limit = Math.min(DATA_READ_ROW_MAX, count - rows.length);
    const page = await readPage(store, scope, control, (transaction) =>
      transaction.readInventoryPage(
        scope.buildId,
        cursor,
        limit,
        DATA_READ_BYTES_MAX,
      ),
    );
    const decoded = decodeSnapshotPage(page, scope.buildId, limit);
    if (decoded.length === 0) break;
    rows.push(...decoded);
    cursor = encryptedWalletBackupManifestBindingKey(decoded.at(-1)!);
  }
  return rows;
}

async function readPendingGroupRows(
  store: EncryptedWalletBackupManifestSnapshotStore,
  scope: EncryptedWalletBackupManifestSnapshotScope,
  control: PersistedEncryptedWalletBackupManifestSnapshotControl,
  groupKey: string,
) {
  const rows: EncryptedWalletBackupManifestSnapshotRow[] = [];
  let after = -1;
  while (rows.length < 1_024) {
    const page = await readPage(store, scope, control, (transaction) =>
      transaction.readPendingFragmentPage(
        scope.buildId,
        groupKey,
        after,
        DATA_READ_ROW_MAX,
        DATA_READ_BYTES_MAX,
      ),
    );
    const decoded = decodeSnapshotPage(page, scope.buildId, DATA_READ_ROW_MAX);
    if (decoded.length === 0) break;
    rows.push(...decoded);
    after = decoded.at(-1)!.fragmentIndex!;
  }
  return rows;
}

async function readInventoryLeaves(
  store: EncryptedWalletBackupManifestSnapshotStore,
  scope: EncryptedWalletBackupManifestSnapshotScope,
  control: PersistedEncryptedWalletBackupManifestSnapshotControl,
) {
  const leaves: ReturnType<
    typeof deserializeEncryptedWalletBackupManifestInventoryLeaf
  >[] = [];
  let after: number | null = null;
  while (leaves.length < control.inventoryLeafCount) {
    const page = await readPage(store, scope, control, (transaction) =>
      transaction.readInventoryLeaves(
        scope.buildId,
        after,
        DATA_READ_ROW_MAX,
        DATA_READ_BYTES_MAX,
      ),
    );
    requireRawPage(page, DATA_READ_ROW_MAX, DATA_READ_BYTES_MAX);
    if (page.rows.length === 0) break;
    for (const row of page.rows) {
      const leaf = deserializeEncryptedWalletBackupManifestInventoryLeaf(row);
      if (leaf.buildId !== scope.buildId || leaf.leafIndex !== leaves.length)
        throw new Error("encrypted backup manifest inventory leaf is foreign");
      leaves.push(leaf);
    }
    after = leaves.at(-1)!.leafIndex;
  }
  if (leaves.length !== control.inventoryLeafCount)
    throw new Error("encrypted backup manifest inventory leaves changed");
  return leaves;
}

async function readPendingKeys(
  store: EncryptedWalletBackupManifestSnapshotStore,
  scope: EncryptedWalletBackupManifestSnapshotScope,
  control: PersistedEncryptedWalletBackupManifestSnapshotControl,
) {
  let keys: readonly string[] = [];
  await exactTransaction(
    store,
    scope.buildId,
    scope.sourceVersion,
    control.version,
    async (transaction) => {
      keys = await transaction.readPendingGroupKeys(
        scope.buildId,
        control.pendingCursor,
        1,
      );
      if (
        !Array.isArray(keys) ||
        keys.length > 1 ||
        (keys[0] !== undefined && keys[0] <= (control.pendingCursor ?? ""))
      )
        throw new Error("encrypted backup manifest pending index is invalid");
    },
  );
  return keys;
}

async function readPage(
  store: EncryptedWalletBackupManifestSnapshotStore,
  scope: EncryptedWalletBackupManifestSnapshotScope,
  control: PersistedEncryptedWalletBackupManifestSnapshotControl,
  read: (
    transaction: EncryptedWalletBackupManifestSnapshotTransaction,
  ) => Promise<EncryptedWalletBackupManifestSerializedPage>,
) {
  let page!: EncryptedWalletBackupManifestSerializedPage;
  await exactTransaction(
    store,
    scope.buildId,
    scope.sourceVersion,
    control.version,
    async (transaction) => {
      page = await read(transaction);
    },
  );
  return page;
}

function decodeSourcePage(
  page: EncryptedWalletBackupManifestSerializedPage,
  buildId: string,
  limit: number,
) {
  const rows = decodeSnapshotPage(
    page,
    buildId,
    limit,
    POPULATION_SOURCE_BYTES_MAX,
  );
  for (let index = 1; index < rows.length; index += 1)
    if (sourcePositionKey(rows[index - 1]!) >= sourcePositionKey(rows[index]!))
      throw new Error("encrypted backup manifest source order is invalid");
  return rows;
}

function decodeSnapshotPage(
  page: EncryptedWalletBackupManifestSerializedPage,
  buildId: string,
  limit: number,
  maxBytes = DATA_READ_BYTES_MAX,
) {
  requireRawPage(page, limit, maxBytes);
  const rows = page.rows.map(
    deserializeEncryptedWalletBackupManifestSnapshotRow,
  );
  if (
    rows.some((row) => row.buildId !== buildId) ||
    rows.reduce(
      (sum, row) =>
        sum + serializeEncryptedWalletBackupManifestSnapshotRow(row).byteLength,
      0,
    ) !== page.serializedBytes
  )
    throw new Error("encrypted backup manifest snapshot page is invalid");
  return rows;
}

function requireRawPage(
  page: EncryptedWalletBackupManifestSerializedPage,
  limit: number,
  maxBytes: number,
) {
  if (
    !page ||
    !Array.isArray(page.rows) ||
    page.rows.length > limit ||
    !Number.isSafeInteger(page.serializedBytes) ||
    page.serializedBytes < 0 ||
    page.serializedBytes > maxBytes ||
    page.rows.some((row) => !(row instanceof Uint8Array)) ||
    page.rows.reduce((sum, row) => sum + row.byteLength, 0) !==
      page.serializedBytes
  )
    throw new Error("encrypted backup manifest snapshot page is invalid");
}

function requirePopulationPage(
  control: PersistedEncryptedWalletBackupManifestSnapshotControl,
  rows: readonly EncryptedWalletBackupManifestSnapshotRow[],
  requested: number,
  remaining: number,
) {
  if (
    rows.length < requested ||
    (remaining <= ENCRYPTED_WALLET_BACKUP_MANIFEST_POPULATION_SOURCE_ROW_MAX &&
      rows.length !== remaining)
  )
    throw new Error("encrypted backup manifest source count changed");
  if (
    control.sourceCursor !== null &&
    sourcePositionKey(rows[0]!) <= control.sourceCursor
  )
    throw new Error("encrypted backup manifest source cursor changed");
}

function requireInventoryContinuation(
  control: PersistedEncryptedWalletBackupManifestSnapshotControl,
  rows: readonly EncryptedWalletBackupManifestSnapshotRow[],
) {
  const expected = Math.min(
    ENCRYPTED_WALLET_BACKUP_MANIFEST_INVENTORY_LEAF_MAX,
    control.expectedRecordCount - control.inventoryRecordCount,
  );
  if (rows.length !== expected)
    throw new Error("encrypted backup manifest inventory count changed");
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1]!;
    const current = rows[index]!;
    if (
      previous.recordKindCode === current.recordKindCode &&
      previous.recordId === current.recordId
    )
      throw new Error("encrypted backup manifest logical record is duplicated");
    if (compareEncryptedWalletBackupManifestBindings(previous, current) >= 0)
      throw new Error("encrypted backup manifest inventory order changed");
  }
  const previousLogicalIdentity =
    control.inventoryCursor === null
      ? null
      : control.inventoryCursor.slice(
          0,
          control.inventoryCursor.lastIndexOf(":"),
        );
  const firstLogicalIdentity = `${rows[0]!.recordKindCode}:${rows[0]!.recordId}`;
  if (
    control.inventoryCursor !== null &&
    (encryptedWalletBackupManifestBindingKey(rows[0]!) <=
      control.inventoryCursor ||
      firstLogicalIdentity === previousLogicalIdentity)
  )
    throw new Error("encrypted backup manifest inventory cursor changed");
}

async function writeInventoryLeaf(
  store: EncryptedWalletBackupManifestSnapshotStore,
  scope: EncryptedWalletBackupManifestSnapshotScope,
  current: PersistedEncryptedWalletBackupManifestSnapshotControl,
  next: PersistedEncryptedWalletBackupManifestSnapshotControl,
  leaf: EncryptedWalletBackupManifestInventoryLeaf,
) {
  await exactTransaction(
    store,
    scope.buildId,
    scope.sourceVersion,
    current.version,
    async (transaction) => {
      await transaction.insertInventoryLeaf(
        leaf.leafIndex,
        serializeEncryptedWalletBackupManifestInventoryLeaf(
          scope.buildId,
          leaf,
        ),
      );
      await transaction.writeControl(
        serializeEncryptedWalletBackupManifestSnapshotControl(next),
      );
    },
  );
}

async function writePendingGroup(
  store: EncryptedWalletBackupManifestSnapshotStore,
  scope: EncryptedWalletBackupManifestSnapshotScope,
  current: PersistedEncryptedWalletBackupManifestSnapshotControl,
  next: PersistedEncryptedWalletBackupManifestSnapshotControl,
  group: ReturnType<typeof validateEncryptedWalletBackupPendingGroup>,
) {
  await exactTransaction(
    store,
    scope.buildId,
    scope.sourceVersion,
    current.version,
    async (transaction) => {
      await transaction.insertPendingGroup(
        group.groupKey,
        serializeEncryptedWalletBackupManifestPendingGroup({
          schemaVersion: 1,
          buildId: scope.buildId,
          groupIndex: current.pendingGroupCount,
          ...group,
        }),
      );
      await transaction.writeControl(
        serializeEncryptedWalletBackupManifestSnapshotControl(next),
      );
    },
  );
}

async function writeBoundary(
  store: EncryptedWalletBackupManifestSnapshotStore,
  scope: EncryptedWalletBackupManifestSnapshotScope,
  current: PersistedEncryptedWalletBackupManifestSnapshotControl,
  next: PersistedEncryptedWalletBackupManifestSnapshotControl,
  rows: readonly EncryptedWalletBackupManifestSnapshotRow[],
) {
  if (current.boundaryCount >= ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_COUNT_MAX)
    throw new Error("encrypted backup manifest page count exceeds its limit");
  await exactTransaction(
    store,
    scope.buildId,
    scope.sourceVersion,
    current.version,
    async (transaction) => {
      await transaction.insertPageBoundary(
        current.boundaryCount,
        serializeEncryptedWalletBackupManifestPageBoundary({
          schemaVersion: 1,
          buildId: scope.buildId,
          pageIndex: current.boundaryCount,
          entryCount: rows.length,
          firstBindingKey: encryptedWalletBackupManifestBindingKey(rows[0]!),
          lastBindingKey: encryptedWalletBackupManifestBindingKey(rows.at(-1)!),
        }),
      );
      await transaction.writeControl(
        serializeEncryptedWalletBackupManifestSnapshotControl(next),
      );
    },
  );
}

async function writeControlOnly(
  store: EncryptedWalletBackupManifestSnapshotStore,
  scope: EncryptedWalletBackupManifestSnapshotScope,
  current: PersistedEncryptedWalletBackupManifestSnapshotControl,
  next: PersistedEncryptedWalletBackupManifestSnapshotControl,
) {
  await exactTransaction(
    store,
    scope.buildId,
    scope.sourceVersion,
    current.version,
    async (transaction) => {
      await transaction.writeControl(
        serializeEncryptedWalletBackupManifestSnapshotControl(next),
      );
    },
  );
}

async function exactTransaction(
  store: EncryptedWalletBackupManifestSnapshotStore,
  buildId: string,
  sourceVersion: number,
  snapshotVersion: number | null,
  use: (
    transaction: EncryptedWalletBackupManifestSnapshotTransaction,
  ) => Promise<void>,
) {
  if (
    !store ||
    typeof store.withManifestSnapshotVersionTransaction !== "function"
  )
    throw new Error("encrypted backup manifest snapshot store is invalid");
  const token = Object.freeze({ manifestSnapshotCommit: true });
  let calls = 0;
  const returned = await store.withManifestSnapshotVersionTransaction(
    { buildId, sourceVersion, snapshotVersion },
    {
      maxRowOperations: ENCRYPTED_WALLET_BACKUP_MANIFEST_SNAPSHOT_ROW_MAX,
      maxBytes: ENCRYPTED_WALLET_BACKUP_MANIFEST_SNAPSHOT_BYTES_MAX,
    },
    async (transaction) => {
      if (calls++ !== 0)
        throw new Error(
          "encrypted backup manifest transaction callback is invalid",
        );
      await use(transaction);
      return token;
    },
  );
  if (calls !== 1 || returned !== token)
    throw new Error(
      "encrypted backup manifest snapshot transaction is invalid",
    );
}

async function readControl(
  store: EncryptedWalletBackupManifestSnapshotStore,
  buildId: string,
) {
  const bytes = await store.readManifestSnapshotControl(
    buildId,
    CONTROL_BYTES_RESERVE,
  );
  if (bytes === null)
    throw new Error("encrypted backup manifest snapshot is missing");
  const control =
    deserializeEncryptedWalletBackupManifestSnapshotControl(bytes);
  if (control.buildId !== buildId)
    throw new Error("encrypted backup manifest snapshot is foreign");
  return control;
}

async function readExactControl(
  transaction: EncryptedWalletBackupManifestSnapshotTransaction,
  scope: EncryptedWalletBackupManifestSnapshotScope,
  version: number,
) {
  const bytes = await transaction.readControl(
    scope.buildId,
    CONTROL_BYTES_RESERVE,
  );
  if (bytes === null)
    throw new Error("encrypted backup manifest snapshot is missing");
  const control =
    deserializeEncryptedWalletBackupManifestSnapshotControl(bytes);
  requireScope(control, scope);
  if (control.version !== version)
    throw new Error("encrypted backup manifest snapshot CAS mismatch");
  return control;
}

async function readExactSource(
  transaction: EncryptedWalletBackupManifestSnapshotTransaction,
  buildId: string,
  sourceVersion: number,
) {
  const bytes = await transaction.readSourceControl(
    buildId,
    CONTROL_BYTES_RESERVE,
  );
  const source = deserializeEncryptedWalletBackupManifestSourceControl(bytes);
  if (source.buildId !== buildId || source.sourceVersion !== sourceVersion)
    throw new Error("encrypted backup manifest source changed");
  return source;
}

function initialControl(scope: EncryptedWalletBackupManifestSnapshotScope) {
  return requireEncryptedWalletBackupManifestSnapshotControl({
    schemaVersion: 1,
    ...scope,
    version: 0,
    state: scope.expectedRecordCount === 0 ? "inventory" : "populating",
    sourceCursor: null,
    populatedRecordCount: 0,
    inventoryCursor: null,
    inventoryLeafCount: 0,
    inventoryRecordCount: 0,
    logicalInventoryRoot: null,
    pendingCursor: null,
    pendingGroupCount: 0,
    pendingFragmentCount: 0,
    boundaryCursor: null,
    boundaryCount: 0,
    boundaryRecordCount: 0,
  });
}

function requireSourceMatchesScope(
  source: PersistedEncryptedWalletBackupManifestSourceControl,
  scope: EncryptedWalletBackupManifestSnapshotScope,
) {
  requireScope(manifestSnapshotScopeFromSource(source), scope);
}

function requireScope(
  actual: EncryptedWalletBackupManifestSnapshotScope,
  expected: EncryptedWalletBackupManifestSnapshotScope,
) {
  for (const key of [
    "buildId",
    "realm",
    "vaultId",
    "enrollmentEpoch",
    "parentGeneration",
    "parentManifestDigest",
    "parentReferenceSetDigest",
    "parentHeadDigest",
    "targetGeneration",
    "snapshotNonce",
    "snapshotId",
    "snapshotRevision",
    "sourceSetDigest",
    "replacementSetDigest",
    "removalSetDigest",
    "sourceVersion",
    "expectedRecordCount",
    "expectedDataObjectCount",
  ] as const)
    if (actual[key] !== expected[key])
      throw new Error("encrypted backup manifest snapshot scope changed");
  if (
    actual.replacementPackIds.length !== expected.replacementPackIds.length ||
    actual.replacementPackIds.some(
      (id, index) => id !== expected.replacementPackIds[index],
    )
  )
    throw new Error("encrypted backup manifest replacement scope changed");
}

function sourcePositionKey(row: EncryptedWalletBackupManifestSnapshotRow) {
  return `${row.sourceOrdinal.toString().padStart(4, "0")}:${row.sourceRecordOrdinal
    .toString()
    .padStart(3, "0")}`;
}

function issueCursor(
  scope: EncryptedWalletBackupManifestSnapshotScope,
  control: PersistedEncryptedWalletBackupManifestSnapshotControl,
): EncryptedWalletBackupManifestPassACursor {
  requireScope(control, scope);
  const cursor = Object.freeze({
    ...scope,
    replacementPackIds: Object.freeze([...scope.replacementPackIds]),
    state: control.state,
    version: control.version,
    recordCount: control.populatedRecordCount,
    logicalInventoryRoot: control.logicalInventoryRoot,
    pendingGroupCount: control.pendingGroupCount,
    pendingFragmentCount: control.pendingFragmentCount,
    pageCount: control.boundaryCount,
  });
  CURSOR_SCOPES.set(cursor, Object.freeze({ ...scope }));
  return cursor;
}

function readCursorScope(value: EncryptedWalletBackupManifestPassACursor) {
  const scope =
    typeof value === "object" && value !== null
      ? CURSOR_SCOPES.get(value)
      : undefined;
  if (scope === undefined)
    throw new Error("encrypted backup manifest Pass A cursor is invalid");
  return scope;
}
