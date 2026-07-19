import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { decode } from "cborg";
import { encodeCanonicalBackupCbor as encodeCanonical } from "./encryptedWalletBackupCbor.ts";
import {
  compareEncryptedWalletBackupManifestBindings,
  encryptedWalletBackupManifestBindingKey,
  ENCRYPTED_WALLET_BACKUP_MANIFEST_INVENTORY_LEAF_MAX,
  ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_ENTRY_MAX,
  normalizeEncryptedWalletBackupManifestSnapshotRow,
  type EncryptedWalletBackupManifestInventoryLeaf,
  type EncryptedWalletBackupManifestSnapshotRow,
} from "./encryptedWalletBackupManifestInventory.ts";
import { ENCRYPTED_WALLET_BACKUP_RECORD_COUNT_MAX } from "./encryptedWalletBackupManifestHead.ts";

export const ENCRYPTED_WALLET_BACKUP_MANIFEST_POPULATION_SOURCE_ROW_MAX =
  125 as const;

export interface EncryptedWalletBackupManifestSourceScope {
  readonly buildId: string;
  readonly realm: string;
  readonly vaultId: string;
  readonly enrollmentEpoch: number;
  readonly parentGeneration: number | null;
  readonly parentManifestDigest: string | null;
  readonly parentReferenceSetDigest: string | null;
  readonly parentHeadDigest: string | null;
  readonly targetGeneration: number;
  readonly snapshotNonce: string;
  readonly snapshotId: string;
  readonly snapshotRevision: number;
  readonly sourceSetDigest: string;
  readonly replacementSetDigest: string;
  readonly removalSetDigest: string;
  readonly replacementPackIds: readonly string[];
}

export interface PersistedEncryptedWalletBackupManifestSourceControl extends EncryptedWalletBackupManifestSourceScope {
  readonly schemaVersion: 1;
  readonly sourceVersion: number;
  readonly recordCount: number;
  readonly dataObjectCount: number;
}

export interface EncryptedWalletBackupManifestSnapshotScope extends EncryptedWalletBackupManifestSourceScope {
  readonly sourceVersion: number;
  readonly expectedRecordCount: number;
  readonly expectedDataObjectCount: number;
}

export type EncryptedWalletBackupManifestSnapshotState =
  | "populating"
  | "inventory"
  | "pending"
  | "boundaries"
  | "complete";

export interface PersistedEncryptedWalletBackupManifestSnapshotControl extends EncryptedWalletBackupManifestSnapshotScope {
  readonly schemaVersion: 1;
  readonly version: number;
  readonly state: EncryptedWalletBackupManifestSnapshotState;
  readonly sourceCursor: string | null;
  readonly populatedRecordCount: number;
  readonly inventoryCursor: string | null;
  readonly inventoryLeafCount: number;
  readonly inventoryRecordCount: number;
  readonly logicalInventoryRoot: string | null;
  readonly pendingCursor: string | null;
  readonly pendingGroupCount: number;
  readonly pendingFragmentCount: number;
  readonly boundaryCursor: string | null;
  readonly boundaryCount: number;
  readonly boundaryRecordCount: number;
}

export interface PersistedEncryptedWalletBackupManifestPendingGroup {
  readonly schemaVersion: 1;
  readonly buildId: string;
  readonly groupIndex: number;
  readonly groupKey: string;
  readonly logicalRecordId: string;
  readonly recordKindCode: 1 | 2;
  readonly parentCommitment: string;
  readonly progressionCode: number | null;
  readonly childCommitment: string | null;
  readonly fragmentCount: number;
  readonly digest: string;
}

export interface PersistedEncryptedWalletBackupManifestPageBoundary {
  readonly schemaVersion: 1;
  readonly buildId: string;
  readonly pageIndex: number;
  readonly entryCount: number;
  readonly firstBindingKey: string;
  readonly lastBindingKey: string;
}

export function serializeEncryptedWalletBackupManifestSourceControl(
  value: PersistedEncryptedWalletBackupManifestSourceControl,
) {
  const source = requireEncryptedWalletBackupManifestSourceControl(value);
  return encodeCanonical([
    1,
    "encrypted-wallet-backup-manifest-source-control",
    sourceScopeWire(source),
    source.sourceVersion,
    source.recordCount,
    source.dataObjectCount,
  ]);
}

export function deserializeEncryptedWalletBackupManifestSourceControl(
  value: Uint8Array,
) {
  const row = canonicalArray(value, 6, "source control");
  if (
    row[0] !== 1 ||
    row[1] !== "encrypted-wallet-backup-manifest-source-control"
  )
    throw invalid("source control");
  return requireEncryptedWalletBackupManifestSourceControl({
    schemaVersion: 1,
    ...sourceScopeFromWire(row[2]),
    sourceVersion: row[3],
    recordCount: row[4],
    dataObjectCount: row[5],
  });
}

export function requireEncryptedWalletBackupManifestSourceControl(
  value: PersistedEncryptedWalletBackupManifestSourceControl,
) {
  const row = value as unknown as Record<string, unknown>;
  const source = Object.freeze({
    schemaVersion: literal(row.schemaVersion, 1, "source schema"),
    ...requireSourceScope(row),
    sourceVersion: integer(
      row.sourceVersion,
      0,
      Number.MAX_SAFE_INTEGER,
      "source version",
    ),
    recordCount: integer(row.recordCount, 0, 524_288, "source record count"),
    dataObjectCount: integer(
      row.dataObjectCount,
      0,
      1_024,
      "source object count",
    ),
  });
  requireSourceCardinality(source);
  return source;
}

export function manifestSnapshotScopeFromSource(
  source: PersistedEncryptedWalletBackupManifestSourceControl,
): EncryptedWalletBackupManifestSnapshotScope {
  const exact = requireEncryptedWalletBackupManifestSourceControl(source);
  return Object.freeze({
    ...copySourceScope(exact),
    sourceVersion: exact.sourceVersion,
    expectedRecordCount: exact.recordCount,
    expectedDataObjectCount: exact.dataObjectCount,
  });
}

export function serializeEncryptedWalletBackupManifestSnapshotRow(
  value: EncryptedWalletBackupManifestSnapshotRow,
) {
  return encodeCanonical([
    1,
    "encrypted-wallet-backup-manifest-snapshot-row",
    value.buildId,
    value.sourceOrdinal,
    value.sourceRecordOrdinal,
    value.canonicalManifestEntry,
  ]);
}

export function deserializeEncryptedWalletBackupManifestSnapshotRow(
  value: Uint8Array,
) {
  const row = canonicalArray(value, 6, "snapshot row");
  if (
    row[0] !== 1 ||
    row[1] !== "encrypted-wallet-backup-manifest-snapshot-row"
  )
    throw invalid("snapshot row");
  return normalizeEncryptedWalletBackupManifestSnapshotRow({
    buildId: row[2] as string,
    sourceOrdinal: row[3] as number,
    sourceRecordOrdinal: row[4] as number,
    canonicalManifestEntry: row[5] as Uint8Array,
  });
}

export function serializeEncryptedWalletBackupManifestSnapshotControl(
  value: PersistedEncryptedWalletBackupManifestSnapshotControl,
) {
  const row = requireEncryptedWalletBackupManifestSnapshotControl(value);
  return encodeCanonical([
    1,
    "encrypted-wallet-backup-manifest-snapshot-control",
    snapshotScopeWire(row),
    row.version,
    stateCode(row.state),
    row.sourceCursor,
    row.populatedRecordCount,
    row.inventoryCursor,
    row.inventoryLeafCount,
    row.inventoryRecordCount,
    row.logicalInventoryRoot === null
      ? null
      : hexToBytes(row.logicalInventoryRoot),
    row.pendingCursor,
    row.pendingGroupCount,
    row.pendingFragmentCount,
    row.boundaryCursor,
    row.boundaryCount,
    row.boundaryRecordCount,
  ]);
}

export function deserializeEncryptedWalletBackupManifestSnapshotControl(
  value: Uint8Array,
) {
  const row = canonicalArray(value, 17, "snapshot control");
  if (
    row[0] !== 1 ||
    row[1] !== "encrypted-wallet-backup-manifest-snapshot-control"
  )
    throw invalid("snapshot control");
  return requireEncryptedWalletBackupManifestSnapshotControl({
    schemaVersion: 1,
    ...snapshotScopeFromWire(row[2]),
    version: row[3],
    state: decodeState(row[4]),
    sourceCursor: row[5],
    populatedRecordCount: row[6],
    inventoryCursor: row[7],
    inventoryLeafCount: row[8],
    inventoryRecordCount: row[9],
    logicalInventoryRoot:
      row[10] === null ? null : bytesHex(row[10], 32, "inventory root"),
    pendingCursor: row[11],
    pendingGroupCount: row[12],
    pendingFragmentCount: row[13],
    boundaryCursor: row[14],
    boundaryCount: row[15],
    boundaryRecordCount: row[16],
  });
}

export function requireEncryptedWalletBackupManifestSnapshotControl(
  value: PersistedEncryptedWalletBackupManifestSnapshotControl,
) {
  const row = value as unknown as Record<string, unknown>;
  const control = Object.freeze({
    schemaVersion: literal(row.schemaVersion, 1, "snapshot schema"),
    ...requireSnapshotScope(row),
    ...requireSnapshotProgress(row),
  });
  requireControlEquations(control);
  return control;
}

export function serializeEncryptedWalletBackupManifestInventoryLeaf(
  buildId: string,
  leaf: EncryptedWalletBackupManifestInventoryLeaf,
) {
  const exact = requireInventoryLeaf(buildId, leaf);
  return encodeCanonical([
    1,
    "encrypted-wallet-backup-manifest-inventory-leaf",
    exact.buildId,
    exact.leafIndex,
    exact.entryCount,
    bindingWire(exact.first),
    bindingWire(exact.last),
    hexToBytes(exact.digest),
  ]);
}

export function deserializeEncryptedWalletBackupManifestInventoryLeaf(
  value: Uint8Array,
) {
  const row = canonicalArray(value, 8, "inventory leaf");
  if (
    row[0] !== 1 ||
    row[1] !== "encrypted-wallet-backup-manifest-inventory-leaf"
  )
    throw invalid("inventory leaf");
  return requireInventoryLeaf(row[2], {
    leafIndex: row[3] as number,
    entryCount: row[4] as number,
    first: bindingFromWire(row[5]),
    last: bindingFromWire(row[6]),
    digest: bytesHex(row[7], 32, "leaf digest"),
  });
}

function requireInventoryLeaf(
  buildId: unknown,
  value: EncryptedWalletBackupManifestInventoryLeaf,
) {
  encryptedWalletBackupManifestBindingKey(value.first);
  encryptedWalletBackupManifestBindingKey(value.last);
  const leaf = Object.freeze({
    buildId: text(buildId, 128, "build id"),
    leafIndex: integer(value.leafIndex, 0, 1_023, "leaf index"),
    entryCount: integer(value.entryCount, 1, 512, "entry count"),
    first: value.first,
    last: value.last,
    digest: lowerHex(value.digest, 32, "leaf digest"),
  });
  const endpointOrder = compareEncryptedWalletBackupManifestBindings(
    leaf.first,
    leaf.last,
  );
  if (
    (leaf.entryCount === 1 && endpointOrder !== 0) ||
    (leaf.entryCount > 1 && endpointOrder >= 0)
  )
    throw invalid("inventory leaf endpoints");
  return leaf;
}

export function serializeEncryptedWalletBackupManifestPendingGroup(
  value: PersistedEncryptedWalletBackupManifestPendingGroup,
) {
  const row = requirePendingGroup(value);
  return encodeCanonical([
    1,
    "encrypted-wallet-backup-manifest-pending-group",
    row.buildId,
    row.groupIndex,
    row.groupKey,
    hexToBytes(row.logicalRecordId),
    row.recordKindCode,
    hexToBytes(row.parentCommitment),
    row.progressionCode,
    row.childCommitment === null ? null : hexToBytes(row.childCommitment),
    row.fragmentCount,
    hexToBytes(row.digest),
  ]);
}

export function deserializeEncryptedWalletBackupManifestPendingGroup(
  value: Uint8Array,
) {
  const row = canonicalArray(value, 12, "pending group");
  if (
    row[0] !== 1 ||
    row[1] !== "encrypted-wallet-backup-manifest-pending-group"
  )
    throw invalid("pending group");
  return requirePendingGroup({
    schemaVersion: 1,
    buildId: row[2],
    groupIndex: row[3],
    groupKey: row[4],
    logicalRecordId: bytesHex(row[5], 32, "logical record id"),
    recordKindCode: row[6],
    parentCommitment: bytesHex(row[7], 32, "parent commitment"),
    progressionCode: row[8],
    childCommitment:
      row[9] === null ? null : bytesHex(row[9], 32, "child commitment"),
    fragmentCount: row[10],
    digest: bytesHex(row[11], 32, "group digest"),
  });
}

export function serializeEncryptedWalletBackupManifestPageBoundary(
  value: PersistedEncryptedWalletBackupManifestPageBoundary,
) {
  const row = requirePageBoundary(value);
  return encodeCanonical([
    1,
    "encrypted-wallet-backup-manifest-page-boundary",
    row.buildId,
    row.pageIndex,
    row.entryCount,
    row.firstBindingKey,
    row.lastBindingKey,
  ]);
}

export function deserializeEncryptedWalletBackupManifestPageBoundary(
  value: Uint8Array,
) {
  const row = canonicalArray(value, 7, "page boundary");
  if (
    row[0] !== 1 ||
    row[1] !== "encrypted-wallet-backup-manifest-page-boundary"
  )
    throw invalid("page boundary");
  return requirePageBoundary({
    schemaVersion: 1,
    buildId: row[2],
    pageIndex: row[3],
    entryCount: row[4],
    firstBindingKey: row[5],
    lastBindingKey: row[6],
  });
}

function requireSourceScope(row: Record<string, unknown>) {
  const parent = requireParentScope(row);
  const targetGeneration = integer(
    row.targetGeneration,
    1,
    Number.MAX_SAFE_INTEGER,
    "target generation",
  );
  if (
    targetGeneration !==
    (parent.parentGeneration === null ? 1 : parent.parentGeneration + 1)
  )
    throw invalid("target generation");
  return Object.freeze({
    buildId: text(row.buildId, 128, "build id"),
    realm: text(row.realm, 128, "realm"),
    vaultId: lowerHex(row.vaultId, 32, "vault id"),
    enrollmentEpoch: integer(
      row.enrollmentEpoch,
      0,
      Number.MAX_SAFE_INTEGER,
      "enrollment epoch",
    ),
    ...parent,
    targetGeneration,
    snapshotNonce: lowerHex(row.snapshotNonce, 16, "snapshot nonce"),
    snapshotId: text(row.snapshotId, 128, "snapshot id"),
    snapshotRevision: integer(
      row.snapshotRevision,
      0,
      Number.MAX_SAFE_INTEGER,
      "snapshot revision",
    ),
    ...requireSetScope(row),
  });
}

function requireParentScope(row: Record<string, unknown>) {
  const parentGeneration = nullableInteger(
    row.parentGeneration,
    1,
    Number.MAX_SAFE_INTEGER - 1,
    "parent generation",
  );
  const parentManifestDigest = nullableHex(
    row.parentManifestDigest,
    32,
    "parent manifest digest",
  );
  const parentReferenceSetDigest = nullableHex(
    row.parentReferenceSetDigest,
    32,
    "parent reference-set digest",
  );
  const parentHeadDigest = nullableHex(
    row.parentHeadDigest,
    32,
    "parent head digest",
  );
  const parentValues = [
    parentGeneration,
    parentManifestDigest,
    parentReferenceSetDigest,
    parentHeadDigest,
  ];
  if (
    parentValues.some((value) => value === null) &&
    parentValues.some((value) => value !== null)
  )
    throw invalid("parent scope");
  return Object.freeze({
    parentGeneration,
    parentManifestDigest,
    parentReferenceSetDigest,
    parentHeadDigest,
  });
}

function requireSetScope(row: Record<string, unknown>) {
  return Object.freeze({
    sourceSetDigest: lowerHex(row.sourceSetDigest, 32, "source-set digest"),
    replacementSetDigest: lowerHex(
      row.replacementSetDigest,
      32,
      "replacement-set digest",
    ),
    removalSetDigest: lowerHex(row.removalSetDigest, 32, "removal-set digest"),
    replacementPackIds: identifiers(row.replacementPackIds),
  });
}

function requireSnapshotProgress(row: Record<string, unknown>) {
  return Object.freeze({
    version: integer(row.version, 0, Number.MAX_SAFE_INTEGER, "version"),
    state: requireState(row.state),
    sourceCursor: nullableSourceCursor(row.sourceCursor),
    populatedRecordCount: integer(
      row.populatedRecordCount,
      0,
      524_288,
      "populated count",
    ),
    inventoryCursor: nullableBindingCursor(row.inventoryCursor),
    inventoryLeafCount: integer(row.inventoryLeafCount, 0, 1_024, "leaf count"),
    inventoryRecordCount: integer(
      row.inventoryRecordCount,
      0,
      524_288,
      "inventory count",
    ),
    logicalInventoryRoot: nullableHex(
      row.logicalInventoryRoot,
      32,
      "inventory root",
    ),
    pendingCursor: nullablePendingCursor(row.pendingCursor),
    pendingGroupCount: integer(
      row.pendingGroupCount,
      0,
      524_288,
      "pending group count",
    ),
    pendingFragmentCount: integer(
      row.pendingFragmentCount,
      0,
      524_288,
      "pending fragment count",
    ),
    boundaryCursor: nullableBindingCursor(row.boundaryCursor),
    boundaryCount: integer(row.boundaryCount, 0, 1_024, "boundary count"),
    boundaryRecordCount: integer(
      row.boundaryRecordCount,
      0,
      524_288,
      "boundary record count",
    ),
  });
}

function requireSnapshotScope(row: Record<string, unknown>) {
  const scope = Object.freeze({
    ...requireSourceScope(row),
    sourceVersion: integer(
      row.sourceVersion,
      0,
      Number.MAX_SAFE_INTEGER,
      "source version",
    ),
    expectedRecordCount: integer(
      row.expectedRecordCount,
      0,
      524_288,
      "expected record count",
    ),
    expectedDataObjectCount: integer(
      row.expectedDataObjectCount,
      0,
      1_024,
      "expected object count",
    ),
  });
  requireSourceCardinality({
    recordCount: scope.expectedRecordCount,
    dataObjectCount: scope.expectedDataObjectCount,
  });
  return scope;
}

function requireControlEquations(
  control: PersistedEncryptedWalletBackupManifestSnapshotControl,
) {
  requirePopulationEquation(control);
  requireInventoryEquation(control);
  requirePendingEquation(control);
  requireBoundaryEquation(control);
  requireVersionEquation(control);
}

function requireSourceCardinality(
  source: Pick<
    PersistedEncryptedWalletBackupManifestSourceControl,
    "recordCount" | "dataObjectCount"
  >,
) {
  const minimumObjects = Math.ceil(
    source.recordCount / ENCRYPTED_WALLET_BACKUP_RECORD_COUNT_MAX,
  );
  if (
    (source.recordCount === 0) !== (source.dataObjectCount === 0) ||
    source.dataObjectCount < minimumObjects ||
    source.dataObjectCount > source.recordCount ||
    source.dataObjectCount + minimumObjects > 1_024
  )
    throw invalid("source cardinality");
}

function requirePopulationEquation(
  control: PersistedEncryptedWalletBackupManifestSnapshotControl,
) {
  const expected = control.expectedRecordCount;
  const populated = control.populatedRecordCount;
  if (
    populated > expected ||
    (control.state === "populating" && populated >= expected) ||
    (control.state !== "populating" && populated !== expected) ||
    (populated === 0) !== (control.sourceCursor === null) ||
    (control.state === "populating" &&
      populated % ENCRYPTED_WALLET_BACKUP_MANIFEST_POPULATION_SOURCE_ROW_MAX !==
        0)
  )
    throw invalid("population equation");
}

function requireInventoryEquation(
  control: PersistedEncryptedWalletBackupManifestSnapshotControl,
) {
  const expected = control.expectedRecordCount;
  if (
    control.inventoryRecordCount > expected ||
    control.inventoryLeafCount !==
      Math.ceil(
        control.inventoryRecordCount /
          ENCRYPTED_WALLET_BACKUP_MANIFEST_INVENTORY_LEAF_MAX,
      ) ||
    (control.inventoryRecordCount === 0) !== (control.inventoryCursor === null)
  )
    throw invalid("inventory equation");
  if (
    (control.state === "populating" && control.inventoryRecordCount !== 0) ||
    (control.inventoryRecordCount < expected &&
      control.inventoryRecordCount !==
        control.inventoryLeafCount *
          ENCRYPTED_WALLET_BACKUP_MANIFEST_INVENTORY_LEAF_MAX)
  )
    throw invalid("inventory progress equation");
  const inventorySealed =
    control.state === "pending" ||
    control.state === "boundaries" ||
    control.state === "complete";
  if (
    inventorySealed !== (control.logicalInventoryRoot !== null) ||
    (inventorySealed && control.inventoryRecordCount !== expected)
  )
    throw invalid("inventory seal equation");
}

function requirePendingEquation(
  control: PersistedEncryptedWalletBackupManifestSnapshotControl,
) {
  if (
    (control.state === "populating" || control.state === "inventory") &&
    (control.pendingCursor !== null ||
      control.pendingGroupCount !== 0 ||
      control.pendingFragmentCount !== 0)
  )
    throw invalid("pending equation");
  if (
    control.pendingGroupCount > control.pendingFragmentCount ||
    control.pendingFragmentCount > control.expectedRecordCount ||
    (control.pendingGroupCount === 0) !== (control.pendingCursor === null)
  )
    throw invalid("pending progress equation");
}

function requireBoundaryEquation(
  control: PersistedEncryptedWalletBackupManifestSnapshotControl,
) {
  const expected = control.expectedRecordCount;
  const boundariesStarted =
    control.state === "boundaries" || control.state === "complete";
  if (
    !boundariesStarted &&
    (control.boundaryCursor !== null ||
      control.boundaryCount !== 0 ||
      control.boundaryRecordCount !== 0)
  )
    throw invalid("boundary equation");
  if (
    control.boundaryRecordCount > expected ||
    (control.boundaryRecordCount === 0) !== (control.boundaryCursor === null) ||
    (control.boundaryRecordCount === 0) !== (control.boundaryCount === 0)
  )
    throw invalid("boundary equation");
  if (
    control.boundaryCount > control.boundaryRecordCount ||
    control.boundaryCount <
      Math.ceil(
        control.boundaryRecordCount /
          ENCRYPTED_WALLET_BACKUP_MANIFEST_PAGE_ENTRY_MAX,
      )
  )
    throw invalid("boundary cardinality equation");
  if (
    control.state === "complete" &&
    (control.boundaryRecordCount !== expected ||
      control.boundaryCount + control.expectedDataObjectCount > 1_024)
  )
    throw invalid("complete equation");
}

function requireVersionEquation(
  control: PersistedEncryptedWalletBackupManifestSnapshotControl,
) {
  const populationPages = Math.ceil(
    control.expectedRecordCount /
      ENCRYPTED_WALLET_BACKUP_MANIFEST_POPULATION_SOURCE_ROW_MAX,
  );
  let expectedVersion: number;
  switch (control.state) {
    case "populating":
      expectedVersion =
        control.populatedRecordCount /
        ENCRYPTED_WALLET_BACKUP_MANIFEST_POPULATION_SOURCE_ROW_MAX;
      break;
    case "inventory":
      expectedVersion = populationPages + control.inventoryLeafCount;
      break;
    case "pending":
      expectedVersion =
        populationPages +
        control.inventoryLeafCount +
        1 +
        control.pendingGroupCount;
      break;
    case "boundaries":
      expectedVersion =
        populationPages +
        control.inventoryLeafCount +
        2 +
        control.pendingGroupCount +
        control.boundaryCount;
      break;
    case "complete":
      expectedVersion =
        populationPages +
        control.inventoryLeafCount +
        3 +
        control.pendingGroupCount +
        control.boundaryCount;
      break;
  }
  if (control.version !== expectedVersion) throw invalid("version equation");
}

function requirePendingGroup(
  value: PersistedEncryptedWalletBackupManifestPendingGroup,
) {
  const row = value as unknown as Record<string, unknown>;
  const recordKindCode =
    row.recordKindCode === 1 || row.recordKindCode === 2
      ? row.recordKindCode
      : invalidValue("pending group kind");
  const logicalRecordId = lowerHex(
    row.logicalRecordId,
    32,
    "logical record id",
  );
  const progressionCode =
    row.progressionCode === null
      ? null
      : integer(row.progressionCode, 0, 3, "progression code");
  const childCommitment = nullableHex(
    row.childCommitment,
    32,
    "child commitment",
  );
  if (
    (recordKindCode === 1 &&
      (progressionCode !== null || childCommitment !== null)) ||
    (recordKindCode === 2 &&
      (progressionCode === null || childCommitment === null))
  )
    throw invalid("pending group progression");
  const groupKey = text(row.groupKey, 140, "group key");
  if (groupKey !== `${logicalRecordId}:${recordKindCode}`)
    throw invalid("pending group key");
  return Object.freeze({
    schemaVersion: literal(row.schemaVersion, 1, "pending group schema"),
    buildId: text(row.buildId, 128, "build id"),
    groupIndex: integer(row.groupIndex, 0, 524_287, "group index"),
    groupKey,
    logicalRecordId,
    recordKindCode,
    parentCommitment: lowerHex(row.parentCommitment, 32, "parent commitment"),
    progressionCode,
    childCommitment,
    fragmentCount: integer(row.fragmentCount, 1, 1_024, "fragment count"),
    digest: lowerHex(row.digest, 32, "group digest"),
  });
}

function requirePageBoundary(
  value: PersistedEncryptedWalletBackupManifestPageBoundary,
) {
  const row = value as unknown as Record<string, unknown>;
  const firstBindingKey = bindingCursor(row.firstBindingKey);
  const lastBindingKey = bindingCursor(row.lastBindingKey);
  const entryCount = integer(row.entryCount, 1, 512, "page entry count");
  if (
    (entryCount === 1 && firstBindingKey !== lastBindingKey) ||
    (entryCount > 1 && firstBindingKey >= lastBindingKey)
  )
    throw invalid("page boundary order");
  return Object.freeze({
    schemaVersion: literal(row.schemaVersion, 1, "page boundary schema"),
    buildId: text(row.buildId, 128, "build id"),
    pageIndex: integer(row.pageIndex, 0, 1_023, "page index"),
    entryCount,
    firstBindingKey,
    lastBindingKey,
  });
}

function sourceScopeWire(value: EncryptedWalletBackupManifestSourceScope) {
  return [
    value.buildId,
    value.realm,
    hexToBytes(value.vaultId),
    value.enrollmentEpoch,
    value.parentGeneration,
    nullableHexBytes(value.parentManifestDigest),
    nullableHexBytes(value.parentReferenceSetDigest),
    nullableHexBytes(value.parentHeadDigest),
    value.targetGeneration,
    hexToBytes(value.snapshotNonce),
    value.snapshotId,
    value.snapshotRevision,
    hexToBytes(value.sourceSetDigest),
    hexToBytes(value.replacementSetDigest),
    hexToBytes(value.removalSetDigest),
    value.replacementPackIds,
  ];
}

function sourceScopeFromWire(value: unknown) {
  if (!Array.isArray(value) || value.length !== 16)
    throw invalid("source scope");
  return {
    buildId: value[0],
    realm: value[1],
    vaultId: bytesHex(value[2], 32, "vault id"),
    enrollmentEpoch: value[3],
    parentGeneration: value[4],
    parentManifestDigest: nullableBytesHex(
      value[5],
      32,
      "parent manifest digest",
    ),
    parentReferenceSetDigest: nullableBytesHex(
      value[6],
      32,
      "parent reference-set digest",
    ),
    parentHeadDigest: nullableBytesHex(value[7], 32, "parent head digest"),
    targetGeneration: value[8],
    snapshotNonce: bytesHex(value[9], 16, "snapshot nonce"),
    snapshotId: value[10],
    snapshotRevision: value[11],
    sourceSetDigest: bytesHex(value[12], 32, "source-set digest"),
    replacementSetDigest: bytesHex(value[13], 32, "replacement-set digest"),
    removalSetDigest: bytesHex(value[14], 32, "removal-set digest"),
    replacementPackIds: value[15],
  };
}

function snapshotScopeWire(value: EncryptedWalletBackupManifestSnapshotScope) {
  return [
    sourceScopeWire(value),
    value.sourceVersion,
    value.expectedRecordCount,
    value.expectedDataObjectCount,
  ];
}

function snapshotScopeFromWire(value: unknown) {
  if (!Array.isArray(value) || value.length !== 4)
    throw invalid("snapshot scope");
  return {
    ...sourceScopeFromWire(value[0]),
    sourceVersion: value[1],
    expectedRecordCount: value[2],
    expectedDataObjectCount: value[3],
  };
}

function copySourceScope(value: EncryptedWalletBackupManifestSourceScope) {
  return Object.freeze({
    buildId: value.buildId,
    realm: value.realm,
    vaultId: value.vaultId,
    enrollmentEpoch: value.enrollmentEpoch,
    parentGeneration: value.parentGeneration,
    parentManifestDigest: value.parentManifestDigest,
    parentReferenceSetDigest: value.parentReferenceSetDigest,
    parentHeadDigest: value.parentHeadDigest,
    targetGeneration: value.targetGeneration,
    snapshotNonce: value.snapshotNonce,
    snapshotId: value.snapshotId,
    snapshotRevision: value.snapshotRevision,
    sourceSetDigest: value.sourceSetDigest,
    replacementSetDigest: value.replacementSetDigest,
    removalSetDigest: value.removalSetDigest,
    replacementPackIds: Object.freeze([...value.replacementPackIds]),
  });
}

function stateCode(value: EncryptedWalletBackupManifestSnapshotState) {
  return [
    "populating",
    "inventory",
    "pending",
    "boundaries",
    "complete",
  ].indexOf(value);
}

function decodeState(value: unknown) {
  const states = [
    "populating",
    "inventory",
    "pending",
    "boundaries",
    "complete",
  ] as const;
  return states[integer(value, 0, 4, "state")];
}

function requireState(value: unknown) {
  if (
    value !== "populating" &&
    value !== "inventory" &&
    value !== "pending" &&
    value !== "boundaries" &&
    value !== "complete"
  )
    throw invalid("state");
  return value;
}

function bindingWire(value: {
  recordKindCode: number;
  recordId: string;
  commitment: string;
}) {
  return [
    value.recordKindCode,
    hexToBytes(value.recordId),
    hexToBytes(value.commitment),
  ];
}

function bindingFromWire(value: unknown) {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    (value[0] !== 0 && value[0] !== 1 && value[0] !== 2)
  )
    throw invalid("binding");
  return Object.freeze({
    recordKindCode: value[0],
    recordId: bytesHex(value[1], 32, "record id"),
    commitment: bytesHex(value[2], 32, "commitment"),
  });
}

function identifiers(value: unknown) {
  if (!Array.isArray(value) || value.length > 1_024)
    throw invalid("replacement pack ids");
  const result = value.map((item) => text(item, 128, "replacement pack id"));
  if (new Set(result).size !== result.length)
    throw invalid("replacement pack ids");
  return Object.freeze(result);
}

function canonicalArray(value: Uint8Array, length: number, label: string) {
  if (!(value instanceof Uint8Array)) throw invalid(label);
  let decoded: unknown;
  try {
    decoded = decode(value);
  } catch {
    throw invalid(label);
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== length ||
    !bytesEqual(value, encodeCanonical(decoded))
  )
    throw invalid(label);
  return decoded;
}

function nullableHexBytes(value: string | null) {
  return value === null ? null : hexToBytes(value);
}

function nullableBytesHex(value: unknown, length: number, label: string) {
  return value === null ? null : bytesHex(value, length, label);
}

function bytesHex(value: unknown, length: number, label: string) {
  if (!(value instanceof Uint8Array) || value.byteLength !== length)
    throw invalid(label);
  return bytesToHex(value);
}

function lowerHex(value: unknown, length: number, label: string) {
  if (
    typeof value !== "string" ||
    !new RegExp(`^[0-9a-f]{${length * 2}}$`).test(value)
  )
    throw invalid(label);
  return value;
}

function nullableHex(value: unknown, length: number, label: string) {
  return value === null ? null : lowerHex(value, length, label);
}

function text(value: unknown, max: number, label: string) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    new TextEncoder().encode(value).byteLength > max
  )
    throw invalid(label);
  return value;
}

function nullableSourceCursor(value: unknown) {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}:\d{3}$/.test(value))
    throw invalid("source cursor");
  const [sourceOrdinal, recordOrdinal] = value.split(":").map(Number);
  if (sourceOrdinal! > 1_023 || recordOrdinal! > 511)
    throw invalid("source cursor");
  return value;
}

function nullableBindingCursor(value: unknown) {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !/^[012]:[0-9a-f]{64}:[0-9a-f]{64}$/.test(value)
  )
    throw invalid("binding cursor");
  return value;
}

function bindingCursor(value: unknown) {
  const cursor = nullableBindingCursor(value);
  if (cursor === null) throw invalid("binding cursor");
  return cursor;
}

function nullablePendingCursor(value: unknown) {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[0-9a-f]{64}:[12]$/.test(value))
    throw invalid("pending cursor");
  return value;
}

function integer(value: unknown, min: number, max: number, label: string) {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    throw invalid(label);
  return value as number;
}

function nullableInteger(
  value: unknown,
  min: number,
  max: number,
  label: string,
) {
  return value === null ? null : integer(value, min, max, label);
}

function literal<T>(value: unknown, expected: T, label: string) {
  if (value !== expected) throw invalid(label);
  return expected;
}

function invalidValue(label: string): never {
  throw invalid(label);
}

function bytesEqual(left: Uint8Array, right: Uint8Array) {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}

function invalid(label: string) {
  return new Error(`persisted encrypted backup manifest ${label} is invalid`);
}
