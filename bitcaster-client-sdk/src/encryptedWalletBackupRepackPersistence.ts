import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { decode } from "cborg";
import {
  type AuthenticatedEncryptedWalletBackupHeadEvidence,
  type DecryptedEncryptedWalletBackupDataChunk,
  type DecryptedEncryptedWalletBackupManifestPage,
  type EncryptedWalletBackupKeyHandle,
  type EncryptedWalletBackupManifestHead,
} from "./encryptedWalletBackup.ts";
import { encodeCanonicalBackupCbor as encodeCanonical } from "./encryptedWalletBackupCbor.ts";
import {
  createEncryptedWalletBackupCodecPrimitives,
  encryptedWalletBackupBytesEqual as equalBytes,
  encryptedWalletBackupBytesFromHex as fromHex,
} from "./encryptedWalletBackupCodecPrimitives.ts";
import {
  ENCRYPTED_WALLET_BACKUP_PACK_TRANSACTION_MAX_BYTES,
  commitPreparedEncryptedWalletBackupPackAppend,
  planEncryptedWalletBackupPackAppendPrefix,
  prepareEncryptedWalletBackupPackAppend,
  prepareEncryptedWalletBackupPackAppendFromFreshBatch,
  readEncryptedWalletBackupPackEvidencePage,
  serializeEncryptedWalletBackupPackControl,
  type EncryptedWalletBackupPackRecordPageRow,
  type EncryptedWalletBackupPackPersistenceTransaction,
} from "./encryptedWalletBackupPackPersistence.ts";
import {
  rehydratePreparedEncryptedWalletBackupRecordBatch,
  type EncryptedWalletBackupPreparedRecordSnapshotBatchStore,
  type PersistedPreparedEncryptedWalletBackupRecord,
} from "./encryptedWalletBackupPreparedRecordPersistence.ts";
import { sealFreshEncryptedWalletBackupPreparedRecordBatch } from "./encryptedWalletBackupFreshPreparedRecordBatch.ts";
import { issuePreparedEncryptedWalletBackupRecord } from "./encryptedWalletBackupRecord.ts";
import {
  readAuthenticatedEncryptedWalletBackupRepackDataChunkAuthority,
  readAuthenticatedEncryptedWalletBackupRepackHeadAuthority,
  readAuthenticatedEncryptedWalletBackupRepackManifestPageAuthority,
  type AuthenticatedEncryptedWalletBackupRepackRecordAuthority,
} from "./encryptedWalletBackupRepackAuthority.ts";
import {
  readAuthenticatedEncryptedWalletBackupRepackOmission,
  type AuthenticatedEncryptedWalletBackupRepackOmission,
  type EncryptedWalletBackupRepackOmissionAuthority,
} from "./encryptedWalletBackupRepackOmissionAuthority.ts";
import {
  deriveEncryptedWalletBackupRepackRetainedBindingDigest,
  digestEncryptedWalletBackupRepackProgress,
  ENCRYPTED_WALLET_BACKUP_REPACK_PROGRESS_MAX,
  prepareEncryptedWalletBackupRepackProgress,
  serializeEncryptedWalletBackupRepackProgress,
  verifyEncryptedWalletBackupRepackProgress,
  type PersistedEncryptedWalletBackupRepackPackEvidence,
  type PersistedEncryptedWalletBackupRepackProgress,
  type PersistedEncryptedWalletBackupRepackProgressDecision,
} from "./encryptedWalletBackupRepackProgress.ts";

export {
  deserializeEncryptedWalletBackupRepackProgress,
  ENCRYPTED_WALLET_BACKUP_REPACK_PROGRESS_MAX,
  serializeEncryptedWalletBackupRepackProgress,
  type PersistedEncryptedWalletBackupRepackPackEvidence,
  type PersistedEncryptedWalletBackupRepackProgress,
  type PersistedEncryptedWalletBackupRepackProgressDecision,
} from "./encryptedWalletBackupRepackProgress.ts";

export const ENCRYPTED_WALLET_BACKUP_REPACK_SOURCE_MAX = 4 as const;
export const ENCRYPTED_WALLET_BACKUP_REPACK_PAGE_RECORD_MAX = 256 as const;
/**
 * Next-fit packing uses at most `2 * sourceCount - 1` empty targets. One
 * already-open partial target can precede those, so four sources require at
 * most eight replacement packs even under adversarial global record ordering.
 */
export const ENCRYPTED_WALLET_BACKUP_REPACK_REPLACEMENT_PACK_MAX =
  ENCRYPTED_WALLET_BACKUP_REPACK_SOURCE_MAX * 2;

const REPACK_CODEC =
  createEncryptedWalletBackupCodecPrimitives("encrypted backup");
const PERSISTED_REPACK_CODEC = createEncryptedWalletBackupCodecPrimitives(
  "persisted encrypted backup",
);
const {
  boundedInteger,
  positive: requirePositive,
  nonNegative: requireNonNegative,
  lowerHex: requireLowerHex,
  text: requireText,
  identifier: requireIdentifier,
  fingerprint: requireFingerprint,
  objectId: requireObjectId,
  bytes: requireBytes,
} = REPACK_CODEC;
const strictRecord = PERSISTED_REPACK_CODEC.strictRecord;
const requireVersion = requireNonNegative;

export interface PersistedEncryptedWalletBackupRepackControl {
  readonly schemaVersion: 1;
  readonly repackId: string;
  readonly realm: string;
  readonly vaultId: string;
  readonly enrollmentEpoch: number;
  readonly parentGeneration: number;
  readonly parentManifestDigest: string;
  readonly parentReferenceSetDigest: string;
  readonly parentHeadDigest: string;
  readonly parentChunkReferencesDigest: string;
  readonly sourceSetDigest: string;
  readonly removalSetDigest: string;
  readonly sourceCount: number;
  readonly totalRecordCount: number;
  readonly nextRecordOrdinal: number;
  readonly retainedRecordCount: number;
  readonly omittedRecordCount: number;
  readonly buildId: string;
  readonly targetGeneration: number;
  readonly snapshotNonce: string;
  readonly snapshotId: string;
  readonly snapshotRevision: number;
  readonly replacementPackIds: readonly string[];
  readonly lastProgressDigest: string | null;
  readonly version: number;
  readonly state: "active" | "complete";
}

export interface PersistedEncryptedWalletBackupRepackSourceCoverage {
  readonly schemaVersion: 1;
  readonly repackId: string;
  readonly realm: string;
  readonly vaultId: string;
  readonly sourceOrdinal: number;
  readonly sourceObjectId: string;
  readonly sourceObjectDigest: string;
  readonly sourceGeneration: number;
  readonly recordCount: number;
  readonly coveredRecordCount: number;
  readonly retainedRecordCount: number;
  readonly omittedRecordCount: number;
  readonly version: number;
}

export interface EncryptedWalletBackupRepackPersistenceTransaction extends EncryptedWalletBackupPackPersistenceTransaction {
  readRepackControl(
    repackId: string,
  ): PersistedEncryptedWalletBackupRepackControl | null;
  readRepackSourceCoverages(
    repackId: string,
  ): readonly PersistedEncryptedWalletBackupRepackSourceCoverage[];
  readRepackProgress(
    repackId: string,
  ): readonly PersistedEncryptedWalletBackupRepackProgress[];
  insertRepackControl(row: PersistedEncryptedWalletBackupRepackControl): void;
  writeRepackControl(row: PersistedEncryptedWalletBackupRepackControl): void;
  insertRepackSourceCoverage(
    row: PersistedEncryptedWalletBackupRepackSourceCoverage,
  ): void;
  writeRepackSourceCoverage(
    row: PersistedEncryptedWalletBackupRepackSourceCoverage,
  ): void;
  insertRepackProgress(row: PersistedEncryptedWalletBackupRepackProgress): void;
}

export interface EncryptedWalletBackupRepackPersistenceStore {
  /** One physical exact-version transaction; thrown callbacks roll back all rows. */
  withExactRepackTransaction<T>(
    expected: Readonly<{
      repackId: string;
      repackVersion: number | null;
      sourceVersions: readonly Readonly<{
        sourceObjectId: string;
        version: number | null;
      }>[];
      buildId: string;
      buildVersion: number;
      packId: string;
      packVersion: number;
      realm: string;
      vaultId: string;
      snapshotId: string;
      snapshotRevision: number;
    }>,
    use: (transaction: EncryptedWalletBackupRepackPersistenceTransaction) => T,
  ): Promise<unknown>;
}

export interface AuthenticatedEncryptedWalletBackupRepack {
  readonly repackId: string;
  readonly nextRecordOrdinal: number;
  readonly totalRecordCount: number;
  readonly retainedRecordCount: number;
  readonly omittedRecordCount: number;
  readonly state: "active" | "complete";
}

export interface CompletedEncryptedWalletBackupRepack extends AuthenticatedEncryptedWalletBackupRepack {
  readonly state: "complete";
  readonly sourceSetDigest: string;
  readonly removalSetDigest: string;
  readonly targetGeneration: number;
  readonly snapshotNonce: string;
  readonly replacementPackIds: readonly string[];
}

interface RepackSourceRecord extends AuthenticatedEncryptedWalletBackupRepackRecordAuthority {
  readonly sourceOrdinal: number;
  readonly sourceObjectId: string;
  readonly sourceObjectDigest: string;
}

interface AuthenticatedRepackSelection {
  readonly keyHandle: EncryptedWalletBackupKeyHandle;
  readonly head: EncryptedWalletBackupManifestHead;
  readonly enrollmentEpoch: number;
  readonly parentHeadDigest: string;
  readonly parentChunkReferencesDigest: string;
  readonly sourceSetDigest: string;
  readonly removalSetDigest: string;
  readonly removalRecordIds: ReadonlySet<string>;
  readonly records: readonly RepackSourceRecord[];
  readonly sources: readonly PersistedEncryptedWalletBackupRepackSourceCoverage[];
}

interface RepackAuthority {
  readonly selection: AuthenticatedRepackSelection;
  readonly control: PersistedEncryptedWalletBackupRepackControl;
  readonly sources: readonly PersistedEncryptedWalletBackupRepackSourceCoverage[];
  consumed: boolean;
}

const REPACK_AUTHORITIES = new WeakMap<object, RepackAuthority>();
const COMPLETED_REPACK_AUTHORITIES = new WeakMap<object, RepackAuthority>();

interface RepackAuthenticatedInput {
  readonly repackId: string;
  readonly keyHandle: EncryptedWalletBackupKeyHandle;
  readonly headEvidence: AuthenticatedEncryptedWalletBackupHeadEvidence;
  readonly head: EncryptedWalletBackupManifestHead;
  readonly manifestPages: readonly DecryptedEncryptedWalletBackupManifestPage[];
  readonly sourceChunks: readonly DecryptedEncryptedWalletBackupDataChunk[];
  readonly removalRecordIds: readonly string[];
}

interface RepackScopeInput extends RepackAuthenticatedInput {
  readonly buildId: string;
  readonly targetGeneration: number;
  readonly snapshotNonce: string;
  readonly snapshotId: string;
  readonly snapshotRevision: number;
}

export async function beginEncryptedWalletBackupRepack(
  input: RepackScopeInput & {
    readonly store: EncryptedWalletBackupRepackPersistenceStore;
    readonly packId: string;
    readonly expectedBuildVersion: number;
    readonly expectedPackVersion: number;
  },
): Promise<AuthenticatedEncryptedWalletBackupRepack> {
  const selection = authenticateRepackSelection(input);
  const control = initialRepackControl(input, selection);
  const sources = selection.sources;
  const expectation = transactionExpectation(input, sources, null);
  const committed = await exactRepackTransaction(
    input.store,
    expectation,
    (transaction) => commitBegin(transaction, control, sources),
  );
  return issueRepack(selection, committed.control, committed.sources);
}

export async function rehydrateEncryptedWalletBackupRepack(
  input: RepackAuthenticatedInput & {
    readonly store: EncryptedWalletBackupRepackPersistenceStore;
    readonly buildId: string;
    readonly targetGeneration: number;
    readonly snapshotNonce: string;
    readonly packId: string;
    readonly snapshotId: string;
    readonly snapshotRevision: number;
    readonly expectedRepackVersion: number;
    readonly expectedSourceVersions: readonly number[];
    readonly expectedBuildVersion: number;
    readonly expectedPackVersion: number;
    readonly seed: Uint8Array;
    readonly snapshotStore: EncryptedWalletBackupPreparedRecordSnapshotBatchStore;
  },
): Promise<AuthenticatedEncryptedWalletBackupRepack> {
  const exactInput = snapshotRehydrateInput(input);
  const selection = authenticateRepackSelection(exactInput);
  const sourceVersions = expectedSourceVersions(exactInput, selection);
  const expectation = {
    ...baseExpectation(exactInput),
    repackVersion: requireVersion(
      exactInput.expectedRepackVersion,
      "repack version",
    ),
    sourceVersions,
  };
  const persisted = await exactRepackTransaction(
    exactInput.store,
    expectation,
    readPersistedRepack(exactInput.repackId, true),
  );
  const control = requireControlMatchesSelection(
    persisted.control,
    exactInput,
    selection,
  );
  if (control.version !== exactInput.expectedRepackVersion)
    throw new Error("persisted encrypted backup repack version changed");
  const sources = requireSourcesMatchSelection(
    persisted.sources,
    selection,
    exactInput.expectedSourceVersions,
  );
  const progress = await Promise.all(
    persisted.progress.map((row) =>
      verifyEncryptedWalletBackupRepackProgress(exactInput.keyHandle, row),
    ),
  );
  requireProgressConsistency(control, sources, selection, progress);
  await requirePersistedReplacementPackRows(
    exactInput,
    expectation,
    replacementPackExpectations(progress),
  );
  return issueRepack(selection, control, sources);
}

function snapshotRehydrateInput(
  input: Parameters<typeof rehydrateEncryptedWalletBackupRepack>[0],
) {
  return Object.freeze({
    ...input,
    seed: input.seed.slice(),
    manifestPages: Object.freeze([...input.manifestPages]),
    sourceChunks: Object.freeze([...input.sourceChunks]),
    removalRecordIds: Object.freeze([...input.removalRecordIds]),
    expectedSourceVersions: Object.freeze([...input.expectedSourceVersions]),
    snapshotStore: input.snapshotStore,
    store: input.store,
  });
}

export async function advanceEncryptedWalletBackupRepackPage(input: {
  readonly store: EncryptedWalletBackupRepackPersistenceStore;
  readonly repack: AuthenticatedEncryptedWalletBackupRepack;
  readonly seed: Uint8Array;
  readonly snapshotStore: EncryptedWalletBackupPreparedRecordSnapshotBatchStore;
  readonly omissions: readonly AuthenticatedEncryptedWalletBackupRepackOmission[];
  readonly packId: string;
  readonly expectedBuildVersion: number;
  readonly expectedPackVersion: number;
}): Promise<AuthenticatedEncryptedWalletBackupRepack> {
  const authority = consumeRepack(input.repack);
  if (authority.control.state !== "active")
    throw new Error("encrypted backup repack is already complete");
  const page = nextRepackPage(authority);
  const omitted = readOmissionEvidence(authority, page, input.omissions);
  const preparedPage = await prepareRetainedAppend(
    input,
    authority,
    page,
    omitted,
  );
  const progress = await prepareRepackProgress(
    authority,
    preparedPage.page,
    preparedPage.omitted,
    input.packId,
    input.expectedBuildVersion,
    input.expectedPackVersion,
    preparedPage.packRecordCountBefore,
  );
  const expectation = transactionExpectation(
    {
      ...scopeFromAuthority(authority),
      packId: input.packId,
      expectedBuildVersion: input.expectedBuildVersion,
      expectedPackVersion: input.expectedPackVersion,
    },
    authority.sources,
    authority.control.version,
  );
  const committed = await exactRepackTransaction(
    input.store,
    expectation,
    (transaction) =>
      commitAdvance(
        transaction,
        authority,
        preparedPage.page,
        preparedPage.omitted,
        input.packId,
        preparedPage.prepared,
        progress,
      ),
  );
  return issueRepack(authority.selection, committed.control, committed.sources);
}

export function requireCompletedEncryptedWalletBackupRepack(
  value: AuthenticatedEncryptedWalletBackupRepack,
): CompletedEncryptedWalletBackupRepack {
  const authority = readRepackAuthority(value);
  if (authority.control.state !== "complete")
    throw new Error("encrypted backup repack is not complete");
  const completed = Object.freeze({
    ...viewOf(authority.control),
    state: "complete" as const,
    sourceSetDigest: authority.control.sourceSetDigest,
    removalSetDigest: authority.control.removalSetDigest,
    targetGeneration: authority.control.targetGeneration,
    snapshotNonce: authority.control.snapshotNonce,
    replacementPackIds: Object.freeze([
      ...authority.control.replacementPackIds,
    ]),
  });
  COMPLETED_REPACK_AUTHORITIES.set(completed, authority);
  return completed;
}

function authenticateRepackSelection(
  input: RepackAuthenticatedInput,
): AuthenticatedRepackSelection {
  const head = readAuthenticatedEncryptedWalletBackupRepackHeadAuthority(
    input.headEvidence,
    input.keyHandle,
    input.head,
  );
  const pages = requireAuthenticatedPages(input, head.head);
  const chunks = requireAuthenticatedChunks(input, head);
  const records = bindSourceRecords(chunks, pages);
  const removalRecordIds = requireRemovalRecordIds(
    input.removalRecordIds,
    records,
  );
  return Object.freeze({
    keyHandle: input.keyHandle,
    head: head.head,
    enrollmentEpoch: head.enrollmentEpoch,
    parentHeadDigest: digest(head.canonicalHead),
    parentChunkReferencesDigest: digest(head.canonicalChunkReferences),
    sourceSetDigest: digestSourceSet(chunks),
    removalSetDigest: digestRemovalSet(removalRecordIds),
    removalRecordIds: new Set(removalRecordIds),
    records,
    sources: initialSourceRows(input, chunks),
  });
}

function requireAuthenticatedPages(
  input: RepackAuthenticatedInput,
  head: EncryptedWalletBackupManifestHead,
) {
  if (
    !Array.isArray(input.manifestPages) ||
    input.manifestPages.length < 1 ||
    input.manifestPages.length > 1_024
  )
    throw new Error("encrypted backup repack manifest selection is empty");
  const pages = input.manifestPages.map((page) =>
    readAuthenticatedEncryptedWalletBackupRepackManifestPageAuthority(
      page,
      input.keyHandle,
      input.headEvidence,
      head,
    ),
  );
  const pageIndexes = pages.map(({ pageIndex }) => pageIndex);
  if (new Set(pageIndexes).size !== pageIndexes.length)
    throw new Error("encrypted backup repack manifest page is duplicated");
  pages.sort((left, right) => left.pageIndex - right.pageIndex);
  return pages;
}

function requireAuthenticatedChunks(
  input: RepackAuthenticatedInput,
  head: ReturnType<
    typeof readAuthenticatedEncryptedWalletBackupRepackHeadAuthority
  >,
) {
  if (
    !Array.isArray(input.sourceChunks) ||
    input.sourceChunks.length < 1 ||
    input.sourceChunks.length > ENCRYPTED_WALLET_BACKUP_REPACK_SOURCE_MAX
  )
    throw new Error("encrypted backup repack source count is invalid");
  const chunks = input.sourceChunks.map((chunk) =>
    readAuthenticatedEncryptedWalletBackupRepackDataChunkAuthority(
      chunk,
      input.keyHandle,
      input.headEvidence,
      head.head,
    ),
  );
  const identities = chunks.map(
    ({ objectId, objectDigest }) => `${objectId}:${objectDigest}`,
  );
  if (new Set(identities).size !== identities.length)
    throw new Error("encrypted backup repack source is duplicated");
  const referenceOrder = new Map(
    head.chunkReferences.map((reference, index) => [
      `${reference.objectId}:${reference.digest}`,
      index,
    ]),
  );
  for (const identity of identities)
    if (!referenceOrder.has(identity))
      throw new Error("encrypted backup repack source is not current");
  chunks.sort(
    (left, right) =>
      referenceOrder.get(`${left.objectId}:${left.objectDigest}`)! -
      referenceOrder.get(`${right.objectId}:${right.objectDigest}`)!,
  );
  return chunks;
}

function bindSourceRecords(
  chunks: ReturnType<typeof requireAuthenticatedChunks>,
  pages: ReturnType<typeof requireAuthenticatedPages>,
): readonly RepackSourceRecord[] {
  const manifestRecords = selectedManifestRecords(chunks, pages);
  const records = chunks.flatMap((chunk, sourceOrdinal) =>
    bindChunkRecords(chunk, sourceOrdinal, manifestRecords),
  );
  // Physical packs are ordered by record id. The later frozen logical view
  // independently uses ADR-034's (kind, id, commitment) inventory order.
  records.sort((left, right) => compareLowerHex(left.recordId, right.recordId));
  for (let index = 1; index < records.length; index += 1) {
    if (records[index - 1]!.recordId === records[index]!.recordId)
      throw new Error("encrypted backup repack record is duplicated");
  }
  if (manifestRecords.size !== 0)
    throw new Error("encrypted backup repack manifest selection is not exact");
  return Object.freeze(records);
}

function selectedManifestRecords(
  chunks: ReturnType<typeof requireAuthenticatedChunks>,
  pages: ReturnType<typeof requireAuthenticatedPages>,
) {
  const sourceIdentities = new Set(
    chunks.map(({ objectId, objectDigest }) => `${objectId}:${objectDigest}`),
  );
  const manifestRecords = new Map<
    string,
    ReturnType<typeof requireAuthenticatedPages>[number]["records"][number]
  >();
  for (const page of pages) {
    for (const record of page.records) {
      const identity = `${record.entry.dataObjectId}:${record.entry.dataDigest}`;
      if (!sourceIdentities.has(identity)) continue;
      const key = manifestBindingKey(record);
      if (manifestRecords.has(key))
        throw new Error(
          "encrypted backup repack manifest record is duplicated",
        );
      manifestRecords.set(key, record);
    }
  }
  return manifestRecords;
}

function bindChunkRecords(
  chunk: ReturnType<typeof requireAuthenticatedChunks>[number],
  sourceOrdinal: number,
  manifestRecords: Map<string, unknown>,
) {
  return chunk.records.map((record) => {
    const candidate = Object.freeze({
      ...copyRecord(record),
      sourceOrdinal,
      sourceObjectId: chunk.objectId,
      sourceObjectDigest: chunk.objectDigest,
    });
    const key = sourceManifestBindingKey(candidate);
    if (!manifestRecords.delete(key))
      throw new Error("encrypted backup repack source membership is invalid");
    return candidate;
  });
}

function sourceManifestBindingKey(record: RepackSourceRecord) {
  return [
    record.sourceObjectId,
    record.sourceObjectDigest,
    record.recordKindCode,
    record.recordId,
    record.commitment,
    digest(record.canonicalManifestEntry),
  ].join(":");
}

function manifestBindingKey(
  record: ReturnType<
    typeof requireAuthenticatedPages
  >[number]["records"][number],
) {
  return [
    record.entry.dataObjectId,
    record.entry.dataDigest,
    record.entry.recordKindCode,
    record.entry.recordId,
    record.entry.commitment,
    digest(record.canonicalManifestEntry),
  ].join(":");
}

function initialSourceRows(
  input: RepackAuthenticatedInput,
  chunks: ReturnType<typeof requireAuthenticatedChunks>,
) {
  const repackId = requireIdentifier(input.repackId, "repack id");
  return Object.freeze(
    chunks.map((chunk, sourceOrdinal) =>
      Object.freeze({
        schemaVersion: 1 as const,
        repackId,
        realm: input.keyHandle.realm,
        vaultId: input.keyHandle.vaultId,
        sourceOrdinal,
        sourceObjectId: chunk.objectId,
        sourceObjectDigest: chunk.objectDigest,
        sourceGeneration: chunk.generation,
        recordCount: chunk.records.length,
        coveredRecordCount: 0,
        retainedRecordCount: 0,
        omittedRecordCount: 0,
        version: 0,
      }),
    ),
  );
}

function initialRepackControl(
  input: RepackScopeInput,
  selection: AuthenticatedRepackSelection,
): PersistedEncryptedWalletBackupRepackControl {
  return requireRepackControl({
    schemaVersion: 1,
    repackId: requireIdentifier(input.repackId, "repack id"),
    realm: input.keyHandle.realm,
    vaultId: input.keyHandle.vaultId,
    enrollmentEpoch: selection.enrollmentEpoch,
    parentGeneration: selection.head.generation,
    parentManifestDigest: selection.head.manifestDigest,
    parentReferenceSetDigest: selection.head.referenceSetDigest,
    parentHeadDigest: selection.parentHeadDigest,
    parentChunkReferencesDigest: selection.parentChunkReferencesDigest,
    sourceSetDigest: selection.sourceSetDigest,
    removalSetDigest: selection.removalSetDigest,
    sourceCount: selection.sources.length,
    totalRecordCount: selection.records.length,
    nextRecordOrdinal: 0,
    retainedRecordCount: 0,
    omittedRecordCount: 0,
    buildId: requireIdentifier(input.buildId, "build id"),
    targetGeneration: requireTargetGeneration(
      input.targetGeneration,
      selection.head.generation,
    ),
    snapshotNonce: requireLowerHex(input.snapshotNonce, 16, "snapshot nonce"),
    snapshotId: requireText(input.snapshotId, 128, "snapshot id"),
    snapshotRevision: requireNonNegative(
      input.snapshotRevision,
      "snapshot revision",
    ),
    replacementPackIds: [],
    lastProgressDigest: null,
    version: 0,
    state: "active",
  });
}

function commitBegin(
  transaction: EncryptedWalletBackupRepackPersistenceTransaction,
  control: PersistedEncryptedWalletBackupRepackControl,
  sources: readonly PersistedEncryptedWalletBackupRepackSourceCoverage[],
) {
  if (transaction.readRepackControl(control.repackId) !== null)
    throw new Error("encrypted backup repack already exists");
  if (transaction.readRepackSourceCoverages(control.repackId).length !== 0)
    throw new Error("encrypted backup repack source already exists");
  if (transaction.readRepackProgress(control.repackId).length !== 0)
    throw new Error("encrypted backup repack progress already exists");
  transaction.insertRepackControl(control);
  for (const source of sources) transaction.insertRepackSourceCoverage(source);
  requireTransactionBound([
    serializeEncryptedWalletBackupRepackControl(control),
    ...sources.map(serializeEncryptedWalletBackupRepackSourceCoverage),
  ]);
  return Object.freeze({ control, sources });
}

function readPersistedRepack(repackId: string, includeProgress = false) {
  return (transaction: EncryptedWalletBackupRepackPersistenceTransaction) => {
    const rawControl = transaction.readRepackControl(repackId);
    if (rawControl === null)
      throw new Error("encrypted backup repack is missing");
    const control = requireRepackControl(rawControl);
    const sources = transaction
      .readRepackSourceCoverages(repackId)
      .map(requireRepackSourceCoverage)
      .sort((left, right) => left.sourceOrdinal - right.sourceOrdinal);
    const progress = includeProgress
      ? transaction
          .readRepackProgress(repackId)
          .map((row) => structuredClone(row))
          .sort(
            (left, right) => left.transitionOrdinal - right.transitionOrdinal,
          )
      : [];
    const serializedRows = [
      serializeEncryptedWalletBackupRepackControl(control),
      ...sources.map(serializeEncryptedWalletBackupRepackSourceCoverage),
      ...progress.map(serializeEncryptedWalletBackupRepackProgress),
    ];
    requireTransactionBound(serializedRows);
    return Object.freeze({
      control,
      sources: Object.freeze(sources),
      progress: Object.freeze(progress),
      transactionBytes: serializedRows.reduce(
        (total, row) => total + row.byteLength,
        0,
      ),
    });
  };
}

function nextRepackPage(
  authority: RepackAuthority,
): readonly RepackSourceRecord[] {
  const start = authority.control.nextRecordOrdinal;
  const page = authority.selection.records.slice(
    start,
    start + ENCRYPTED_WALLET_BACKUP_REPACK_PAGE_RECORD_MAX,
  );
  if (page.length < 1)
    throw new Error("encrypted backup repack has no remaining page");
  return Object.freeze(page.map(copySourceRecord));
}

function readOmissionEvidence(
  authority: RepackAuthority,
  page: readonly RepackSourceRecord[],
  omissions: readonly AuthenticatedEncryptedWalletBackupRepackOmission[],
): ReadonlyMap<string, EncryptedWalletBackupRepackOmissionAuthority> {
  const selected = page.filter((record) =>
    authority.selection.removalRecordIds.has(record.recordId),
  );
  if (!Array.isArray(omissions) || omissions.length !== selected.length)
    throw new Error(
      "encrypted backup repack omission authority count is invalid",
    );
  const result = new Map<
    string,
    EncryptedWalletBackupRepackOmissionAuthority
  >();
  for (let index = 0; index < selected.length; index += 1) {
    const record = selected[index]!;
    const row = readAuthenticatedEncryptedWalletBackupRepackOmission(
      omissions[index],
      authority.selection.keyHandle,
    );
    if (
      row.parentManifestDigest !== authority.control.parentManifestDigest ||
      row.parentReferenceSetDigest !==
        authority.control.parentReferenceSetDigest ||
      row.targetGeneration !== authority.control.targetGeneration ||
      row.snapshotNonce !== authority.control.snapshotNonce ||
      row.snapshotId !== authority.control.snapshotId ||
      row.snapshotRevision !== authority.control.snapshotRevision ||
      row.sourceObjectId !== record.sourceObjectId ||
      row.sourceObjectDigest !== record.sourceObjectDigest ||
      row.recordKindCode !== record.recordKindCode ||
      row.recordId !== record.recordId ||
      row.commitment !== record.commitment
    )
      throw new Error("encrypted backup repack omission authority is foreign");
    if (result.has(row.recordId))
      throw new Error(
        "encrypted backup repack omission authority is duplicated",
      );
    result.set(row.recordId, row);
  }
  return result;
}

async function prepareRetainedAppend(
  input: Parameters<typeof advanceEncryptedWalletBackupRepackPage>[0],
  authority: RepackAuthority,
  page: readonly RepackSourceRecord[],
  omitted: ReadonlyMap<string, EncryptedWalletBackupRepackOmissionAuthority>,
) {
  const records = page.filter((record) => !omitted.has(record.recordId));
  if (records.length === 0)
    return Object.freeze({
      page,
      omitted,
      prepared: null,
      packRecordCountBefore: null,
    });
  const planningRecords = records.map((record) =>
    planningRecord(authority, record),
  );
  const plan = await planRetainedPrefix(input, authority, planningRecords);
  const selectedPage = selectSourcePagePrefix(
    page,
    omitted,
    plan.records.length,
  );
  if (selectedPage.length === 0)
    throw new Error("encrypted backup repack target pack is full");
  const selectedOmissions = new Map(
    selectedPage.flatMap((record) => {
      const omission = omitted.get(record.recordId);
      return omission === undefined
        ? []
        : [[record.recordId, omission] as const];
    }),
  );
  const selectedRetainedCount = selectedPage.length - selectedOmissions.size;
  const selectedRetained = selectedPage.filter(
    (record) => !selectedOmissions.has(record.recordId),
  );
  const prepared =
    selectedRetainedCount === 0
      ? null
      : prepareEncryptedWalletBackupPackAppendFromFreshBatch({
          keyHandle: authority.selection.keyHandle,
          batch: await resealSourceRecords(input, authority, selectedRetained),
          buildId: authority.control.buildId,
          packId: input.packId,
          snapshotId: authority.control.snapshotId,
          snapshotRevision: authority.control.snapshotRevision,
          expectedBuildVersion: input.expectedBuildVersion,
          expectedPackVersion: input.expectedPackVersion,
        });
  return Object.freeze({
    page: selectedPage,
    omitted: selectedOmissions,
    prepared,
    packRecordCountBefore:
      selectedRetainedCount === 0 ? null : plan.packRecordCount,
  });
}

function planningRecord(
  authority: RepackAuthority,
  record: RepackSourceRecord,
): PersistedPreparedEncryptedWalletBackupRecord {
  return Object.freeze({
    schemaVersion: 1,
    realm: authority.control.realm,
    vaultId: authority.control.vaultId,
    snapshotId: authority.control.snapshotId,
    snapshotRevision: authority.control.snapshotRevision,
    recordId: record.recordId,
    commitment: record.commitment,
    recordKindCode: record.recordKindCode,
    canonicalRecord: record.canonicalRecord.slice(),
    canonicalManifestEntry: record.canonicalManifestEntry.slice(),
    // Planning accounts for the exact fixed-size tag; it never treats this
    // placeholder as persisted or authenticated record authority.
    authenticationTag: new Uint8Array(32),
  });
}

async function planRetainedPrefix(
  input: Parameters<typeof advanceEncryptedWalletBackupRepackPage>[0],
  authority: RepackAuthority,
  records: readonly PersistedPreparedEncryptedWalletBackupRecord[],
) {
  const expectation = transactionExpectation(
    {
      ...scopeFromAuthority(authority),
      packId: input.packId,
      expectedBuildVersion: input.expectedBuildVersion,
      expectedPackVersion: input.expectedPackVersion,
    },
    authority.sources,
    authority.control.version,
  );
  return exactRepackTransaction(input.store, expectation, (transaction) => {
    const persisted = readPersistedRepack(authority.control.repackId)(
      transaction,
    );
    requireSameControl(persisted.control, authority.control);
    requireSameSources(persisted.sources, authority.sources);
    return planEncryptedWalletBackupPackAppendPrefix({
      transaction,
      buildId: authority.control.buildId,
      packId: input.packId,
      realm: authority.control.realm,
      vaultId: authority.control.vaultId,
      snapshotId: authority.control.snapshotId,
      snapshotRevision: authority.control.snapshotRevision,
      expectedBuildVersion: input.expectedBuildVersion,
      expectedPackVersion: input.expectedPackVersion,
      records,
    });
  });
}

function selectSourcePagePrefix(
  page: readonly RepackSourceRecord[],
  omitted: ReadonlyMap<string, EncryptedWalletBackupRepackOmissionAuthority>,
  retainedCapacity: number,
) {
  let retained = 0;
  let end = 0;
  for (const record of page) {
    if (omitted.has(record.recordId)) {
      end += 1;
      continue;
    }
    if (retained === retainedCapacity) break;
    retained += 1;
    end += 1;
  }
  return Object.freeze(page.slice(0, end).map(copySourceRecord));
}

async function resealSourceRecords(
  input: Parameters<typeof advanceEncryptedWalletBackupRepackPage>[0],
  authority: RepackAuthority,
  records: readonly RepackSourceRecord[],
) {
  const handles = records.map((record) => {
    const manifestEntry = decode(record.canonicalManifestEntry);
    if (!Array.isArray(manifestEntry))
      throw new Error("encrypted backup repack manifest metadata is invalid");
    return issuePreparedEncryptedWalletBackupRecord(Object.freeze({}), {
      recordId: record.recordId,
      commitment: record.commitment,
      recordKindCode: record.recordKindCode,
      keyHandle: authority.selection.keyHandle,
      canonicalRecord: record.canonicalRecord,
      snapshotId: authority.control.snapshotId,
      snapshotRevision: authority.control.snapshotRevision,
      manifestEntry,
    });
  });
  return sealFreshEncryptedWalletBackupPreparedRecordBatch({
    keyHandle: authority.selection.keyHandle,
    seed: input.seed,
    records: handles,
    snapshotStore: input.snapshotStore,
  });
}

async function prepareRepackProgress(
  authority: RepackAuthority,
  page: readonly RepackSourceRecord[],
  omitted: ReadonlyMap<string, EncryptedWalletBackupRepackOmissionAuthority>,
  packId: string,
  expectedBuildVersion: number,
  expectedPackVersion: number,
  packRecordCountBefore: number | null,
) {
  const decisions = Object.freeze(
    page.map((record) =>
      progressDecision(record, omitted.get(record.recordId)),
    ),
  );
  const retained = decisions.filter(
    ({ omissionAuthorization }) => omissionAuthorization === null,
  );
  const packEvidence =
    retained.length === 0
      ? null
      : progressPackEvidence(
          packId,
          expectedBuildVersion,
          expectedPackVersion,
          packRecordCountBefore,
          retained,
        );
  return prepareEncryptedWalletBackupRepackProgress({
    keyHandle: authority.selection.keyHandle,
    progress: {
      repackId: authority.control.repackId,
      transitionOrdinal: authority.control.version,
      previousProgressDigest: authority.control.lastProgressDigest,
      parentManifestDigest: authority.control.parentManifestDigest,
      parentReferenceSetDigest: authority.control.parentReferenceSetDigest,
      sourceSetDigest: authority.control.sourceSetDigest,
      removalSetDigest: authority.control.removalSetDigest,
      buildId: authority.control.buildId,
      targetGeneration: authority.control.targetGeneration,
      snapshotNonce: authority.control.snapshotNonce,
      snapshotId: authority.control.snapshotId,
      snapshotRevision: authority.control.snapshotRevision,
      startRecordOrdinal: authority.control.nextRecordOrdinal,
      endRecordOrdinal: authority.control.nextRecordOrdinal + page.length,
      decisions,
      packEvidence,
    },
  });
}

function progressDecision(
  record: RepackSourceRecord,
  omission: EncryptedWalletBackupRepackOmissionAuthority | undefined,
): PersistedEncryptedWalletBackupRepackProgressDecision {
  return Object.freeze({
    sourceOrdinal: record.sourceOrdinal,
    sourceObjectId: record.sourceObjectId,
    sourceObjectDigest: record.sourceObjectDigest,
    recordKindCode: record.recordKindCode,
    recordId: record.recordId,
    commitment: record.commitment,
    omissionAuthorization:
      omission === undefined
        ? null
        : Object.freeze({ ...omission.authorization }),
  });
}

function progressPackEvidence(
  packId: string,
  expectedBuildVersion: number,
  expectedPackVersion: number,
  packRecordCountBefore: number | null,
  retained: readonly PersistedEncryptedWalletBackupRepackProgressDecision[],
): PersistedEncryptedWalletBackupRepackPackEvidence {
  if (packRecordCountBefore === null)
    throw new Error("encrypted backup repack pack count is invalid");
  return Object.freeze({
    packId: requireIdentifier(packId, "replacement pack id"),
    buildVersionBefore: requireVersion(expectedBuildVersion, "build version"),
    buildVersionAfter: expectedBuildVersion + 1,
    packVersionBefore: requireVersion(expectedPackVersion, "pack version"),
    packVersionAfter: expectedPackVersion + 1,
    packRecordCountBefore,
    packRecordCountAfter: packRecordCountBefore + retained.length,
    retainedRecordCount: retained.length,
    firstRecordId: retained[0]!.recordId,
    lastRecordId: retained.at(-1)!.recordId,
    retainedBindingDigest:
      deriveEncryptedWalletBackupRepackRetainedBindingDigest(retained),
  });
}

function commitAdvance(
  transaction: EncryptedWalletBackupRepackPersistenceTransaction,
  authority: RepackAuthority,
  page: readonly RepackSourceRecord[],
  omitted: ReadonlyMap<string, EncryptedWalletBackupRepackOmissionAuthority>,
  packId: string,
  prepared: Awaited<
    ReturnType<typeof prepareEncryptedWalletBackupPackAppend>
  > | null,
  progress: PersistedEncryptedWalletBackupRepackProgress,
) {
  const persisted = readPersistedRepack(authority.control.repackId)(
    transaction,
  );
  requireSameControl(persisted.control, authority.control);
  requireSameSources(persisted.sources, authority.sources);
  const packResult =
    prepared === null
      ? null
      : commitPreparedEncryptedWalletBackupPackAppend({
          transaction,
          prepared,
        });
  requireProgressPackCommit(progress, packResult);
  const progressDigest = digestEncryptedWalletBackupRepackProgress(progress);
  const next = advanceCoverage(
    authority,
    page,
    omitted,
    packId,
    prepared !== null,
    progressDigest,
  );
  transaction.insertRepackProgress(progress);
  transaction.writeRepackControl(next.control);
  for (const source of next.sources)
    transaction.writeRepackSourceCoverage(source);
  const repackBytes = [
    serializeEncryptedWalletBackupRepackControl(next.control),
    ...next.sources.map(serializeEncryptedWalletBackupRepackSourceCoverage),
    serializeEncryptedWalletBackupRepackProgress(progress),
  ];
  requireTransactionBound(
    repackBytes,
    persisted.transactionBytes + (packResult?.transactionBytes ?? 0),
  );
  return next;
}

function advanceCoverage(
  authority: RepackAuthority,
  page: readonly RepackSourceRecord[],
  omitted: ReadonlyMap<string, EncryptedWalletBackupRepackOmissionAuthority>,
  packId: string,
  appended: boolean,
  progressDigest: string,
) {
  const { deltas, retained } = coverageDeltas(authority, page, omitted);
  if (retained > 0 !== appended)
    throw new Error("encrypted backup repack append decision is invalid");
  const sources = authority.sources.map((source, index) =>
    advanceSourceCoverage(source, deltas[index]!),
  );
  const nextOrdinal = authority.control.nextRecordOrdinal + page.length;
  const replacementPackIds =
    retained === 0
      ? authority.control.replacementPackIds
      : appendReplacementPackId(authority.control.replacementPackIds, packId);
  const control = requireRepackControl({
    ...authority.control,
    nextRecordOrdinal: nextOrdinal,
    retainedRecordCount: authority.control.retainedRecordCount + retained,
    omittedRecordCount: authority.control.omittedRecordCount + omitted.size,
    replacementPackIds,
    lastProgressDigest: requireFingerprint(
      progressDigest,
      "last progress digest",
    ),
    version: authority.control.version + 1,
    state:
      nextOrdinal === authority.control.totalRecordCount
        ? "complete"
        : "active",
  });
  requireCoverageConsistency(control, sources);
  return Object.freeze({ control, sources: Object.freeze(sources) });
}

function requireProgressPackCommit(
  progress: PersistedEncryptedWalletBackupRepackProgress,
  result: ReturnType<
    typeof commitPreparedEncryptedWalletBackupPackAppend
  > | null,
) {
  const evidence = progress.packEvidence;
  if (evidence === null) {
    if (result !== null)
      throw new Error("encrypted backup repack progress pack is invalid");
    return;
  }
  if (
    result === null ||
    result.buildCursor.buildId !== progress.buildId ||
    result.buildCursor.version !== evidence.buildVersionAfter ||
    result.packControl.packId !== evidence.packId ||
    result.packControl.version !== evidence.packVersionAfter ||
    result.packControl.recordCount !== evidence.packRecordCountAfter
  )
    throw new Error("encrypted backup repack progress pack is invalid");
}

function coverageDeltas(
  authority: RepackAuthority,
  page: readonly RepackSourceRecord[],
  omitted: ReadonlyMap<string, EncryptedWalletBackupRepackOmissionAuthority>,
) {
  const deltas = authority.sources.map(() => ({
    covered: 0,
    retained: 0,
    omitted: 0,
  }));
  let retained = 0;
  for (const record of page) {
    const delta = deltas[record.sourceOrdinal]!;
    delta.covered += 1;
    if (omitted.has(record.recordId)) delta.omitted += 1;
    else {
      delta.retained += 1;
      retained += 1;
    }
  }
  return { deltas, retained };
}

function advanceSourceCoverage(
  source: PersistedEncryptedWalletBackupRepackSourceCoverage,
  delta: { covered: number; retained: number; omitted: number },
) {
  return requireRepackSourceCoverage({
    ...source,
    coveredRecordCount: source.coveredRecordCount + delta.covered,
    retainedRecordCount: source.retainedRecordCount + delta.retained,
    omittedRecordCount: source.omittedRecordCount + delta.omitted,
    version: source.version + 1,
  });
}

function appendReplacementPackId(current: readonly string[], packId: string) {
  const exact = requireIdentifier(packId, "replacement pack id");
  if (current.at(-1) === exact) return current;
  if (current.includes(exact))
    throw new Error("encrypted backup repack replacement pack cannot reopen");
  if (current.length >= ENCRYPTED_WALLET_BACKUP_REPACK_REPLACEMENT_PACK_MAX)
    throw new Error(
      "encrypted backup repack replacement pack count is invalid",
    );
  return Object.freeze([...current, exact]);
}

function requireControlMatchesSelection(
  control: PersistedEncryptedWalletBackupRepackControl,
  input: Parameters<typeof rehydrateEncryptedWalletBackupRepack>[0],
  selection: AuthenticatedRepackSelection,
) {
  if (
    control.repackId !== input.repackId ||
    control.realm !== input.keyHandle.realm ||
    control.vaultId !== input.keyHandle.vaultId ||
    control.enrollmentEpoch !== selection.enrollmentEpoch ||
    control.parentGeneration !== selection.head.generation ||
    control.parentManifestDigest !== selection.head.manifestDigest ||
    control.parentReferenceSetDigest !== selection.head.referenceSetDigest ||
    control.parentHeadDigest !== selection.parentHeadDigest ||
    control.parentChunkReferencesDigest !==
      selection.parentChunkReferencesDigest ||
    control.sourceSetDigest !== selection.sourceSetDigest ||
    control.removalSetDigest !== selection.removalSetDigest ||
    control.buildId !== input.buildId ||
    control.targetGeneration !== input.targetGeneration ||
    control.snapshotNonce !== input.snapshotNonce ||
    control.snapshotId !== input.snapshotId ||
    control.snapshotRevision !== input.snapshotRevision ||
    control.totalRecordCount !== selection.records.length ||
    control.sourceCount !== selection.sources.length
  )
    throw new Error("persisted encrypted backup repack is foreign");
  return control;
}

function requireSourcesMatchSelection(
  persisted: readonly PersistedEncryptedWalletBackupRepackSourceCoverage[],
  selection: AuthenticatedRepackSelection,
  expectedVersions?: readonly number[],
) {
  if (persisted.length !== selection.sources.length)
    throw new Error("persisted encrypted backup repack source count changed");
  return persisted.map((source, index) => {
    const expected = selection.sources[index]!;
    if (
      source.sourceOrdinal !== index ||
      source.sourceObjectId !== expected.sourceObjectId ||
      source.sourceObjectDigest !== expected.sourceObjectDigest ||
      source.sourceGeneration !== expected.sourceGeneration ||
      source.recordCount !== expected.recordCount ||
      source.repackId !== expected.repackId ||
      source.realm !== expected.realm ||
      source.vaultId !== expected.vaultId
    )
      throw new Error("persisted encrypted backup repack source is foreign");
    if (
      expectedVersions !== undefined &&
      source.version !== expectedVersions[index]
    )
      throw new Error(
        "persisted encrypted backup repack source version changed",
      );
    return source;
  });
}

function requireCoverageConsistency(
  control: PersistedEncryptedWalletBackupRepackControl,
  sources: readonly PersistedEncryptedWalletBackupRepackSourceCoverage[],
) {
  const sum = (
    field: "coveredRecordCount" | "retainedRecordCount" | "omittedRecordCount",
  ) => sources.reduce((total, source) => total + source[field], 0);
  if (
    sum("coveredRecordCount") !== control.nextRecordOrdinal ||
    sum("retainedRecordCount") !== control.retainedRecordCount ||
    sum("omittedRecordCount") !== control.omittedRecordCount ||
    sources.some((source) => source.version !== control.version) ||
    control.retainedRecordCount + control.omittedRecordCount !==
      control.nextRecordOrdinal ||
    (control.state === "complete") !==
      (control.nextRecordOrdinal === control.totalRecordCount)
  )
    throw new Error("persisted encrypted backup repack coverage is invalid");
}

function requireProgressConsistency(
  control: PersistedEncryptedWalletBackupRepackControl,
  sources: readonly PersistedEncryptedWalletBackupRepackSourceCoverage[],
  selection: AuthenticatedRepackSelection,
  progress: readonly PersistedEncryptedWalletBackupRepackProgress[],
) {
  if (progress.length !== control.version)
    throw new Error("persisted encrypted backup repack progress is incomplete");
  const replay = replayProgress(control, selection, progress);
  requireProgressReplayMatchesControl(replay, control);
  const exactSources = replay.sources.map(requireRepackSourceCoverage);
  requireSameSources(exactSources, sources);
  requireCoverageConsistency(control, sources);
}

function replayProgress(
  control: PersistedEncryptedWalletBackupRepackControl,
  selection: AuthenticatedRepackSelection,
  progress: readonly PersistedEncryptedWalletBackupRepackProgress[],
) {
  const replay = initialProgressReplay(selection);
  for (let index = 0; index < progress.length; index += 1) {
    applyProgressTransition(
      replay,
      progress[index]!,
      index,
      control,
      selection,
    );
  }
  return replay;
}

function initialProgressReplay(selection: AuthenticatedRepackSelection) {
  return {
    sources: selection.sources.map((source) => ({
      ...source,
      coveredRecordCount: 0,
      retainedRecordCount: 0,
      omittedRecordCount: 0,
      version: 0,
    })),
    nextRecordOrdinal: 0,
    retainedRecordCount: 0,
    omittedRecordCount: 0,
    previousProgressDigest: null as string | null,
    replacementPackIds: [] as readonly string[],
  };
}

function applyProgressTransition(
  replay: ReturnType<typeof initialProgressReplay>,
  row: PersistedEncryptedWalletBackupRepackProgress,
  index: number,
  control: PersistedEncryptedWalletBackupRepackControl,
  selection: AuthenticatedRepackSelection,
) {
  requireProgressScope(row, control, index, replay.previousProgressDigest);
  if (row.startRecordOrdinal !== replay.nextRecordOrdinal)
    throw new Error(
      "persisted encrypted backup repack progress is not contiguous",
    );
  const selected = selection.records.slice(
    row.startRecordOrdinal,
    row.endRecordOrdinal,
  );
  if (selected.length !== row.decisions.length)
    throw new Error(
      "persisted encrypted backup repack progress range is invalid",
    );
  const retained = applyProgressDecisions(replay, selected, row, selection);
  for (const source of replay.sources) source.version += 1;
  if ((row.packEvidence === null) !== (retained === 0))
    throw new Error(
      "persisted encrypted backup repack pack evidence is invalid",
    );
  if (row.packEvidence !== null)
    replay.replacementPackIds = appendReplacementPackId(
      replay.replacementPackIds,
      row.packEvidence.packId,
    );
  replay.nextRecordOrdinal = row.endRecordOrdinal;
  replay.previousProgressDigest =
    digestEncryptedWalletBackupRepackProgress(row);
}

function applyProgressDecisions(
  replay: ReturnType<typeof initialProgressReplay>,
  selected: readonly RepackSourceRecord[],
  row: PersistedEncryptedWalletBackupRepackProgress,
  selection: AuthenticatedRepackSelection,
) {
  let retained = 0;
  for (let index = 0; index < selected.length; index += 1) {
    const record = selected[index]!;
    const decision = row.decisions[index]!;
    requireProgressDecision(record, decision, selection.removalRecordIds);
    const source = replay.sources[record.sourceOrdinal]!;
    source.coveredRecordCount += 1;
    if (decision.omissionAuthorization === null) {
      source.retainedRecordCount += 1;
      replay.retainedRecordCount += 1;
      retained += 1;
    } else {
      source.omittedRecordCount += 1;
      replay.omittedRecordCount += 1;
    }
  }
  return retained;
}

function requireProgressReplayMatchesControl(
  replay: ReturnType<typeof initialProgressReplay>,
  control: PersistedEncryptedWalletBackupRepackControl,
) {
  if (
    replay.nextRecordOrdinal !== control.nextRecordOrdinal ||
    replay.retainedRecordCount !== control.retainedRecordCount ||
    replay.omittedRecordCount !== control.omittedRecordCount ||
    replay.previousProgressDigest !== control.lastProgressDigest ||
    replay.replacementPackIds.length !== control.replacementPackIds.length ||
    replay.replacementPackIds.some(
      (packId, index) => packId !== control.replacementPackIds[index],
    )
  )
    throw new Error(
      "persisted encrypted backup repack progress is inconsistent",
    );
}

interface ReplacementPackExpectedRow {
  readonly ordinal: number;
  readonly decision: PersistedEncryptedWalletBackupRepackProgressDecision;
}

interface ReplacementPackExpectation {
  readonly packId: string;
  readonly requiredRecordCount: number;
  readonly lastPackVersion: number;
  readonly rows: readonly ReplacementPackExpectedRow[];
}

function replacementPackExpectations(
  progress: readonly PersistedEncryptedWalletBackupRepackProgress[],
): readonly ReplacementPackExpectation[] {
  const result: ReplacementPackExpectation[] = [];
  for (const transition of progress) {
    const evidence = transition.packEvidence;
    if (evidence === null) continue;
    const retained = transition.decisions.filter(
      ({ omissionAuthorization }) => omissionAuthorization === null,
    );
    const previous = result.at(-1);
    const current =
      previous?.packId === evidence.packId
        ? previous
        : beginReplacementPackExpectation(result, evidence);
    if (current !== previous) result.push(current);
    if (
      current.requiredRecordCount !== evidence.packRecordCountBefore ||
      (previous?.packId === evidence.packId &&
        previous.lastPackVersion !== evidence.packVersionBefore)
    )
      throw new Error(
        "persisted encrypted backup repack pack history is not contiguous",
      );
    const rows = retained.map((decision, index) =>
      Object.freeze({
        ordinal: evidence.packRecordCountBefore + index,
        decision,
      }),
    );
    result[result.length - 1] = Object.freeze({
      packId: evidence.packId,
      requiredRecordCount: evidence.packRecordCountAfter,
      lastPackVersion: evidence.packVersionAfter,
      rows: Object.freeze([...current.rows, ...rows]),
    });
  }
  return Object.freeze(result);
}

function beginReplacementPackExpectation(
  existing: readonly ReplacementPackExpectation[],
  evidence: PersistedEncryptedWalletBackupRepackPackEvidence,
): ReplacementPackExpectation {
  if (existing.some(({ packId }) => packId === evidence.packId))
    throw new Error(
      "persisted encrypted backup repack replacement pack cannot reopen",
    );
  const initial = Object.freeze({
    packId: evidence.packId,
    requiredRecordCount: evidence.packRecordCountBefore,
    lastPackVersion: evidence.packVersionBefore,
    rows: Object.freeze([]),
  });
  return initial;
}

async function requirePersistedReplacementPackRows(
  input: Parameters<typeof rehydrateEncryptedWalletBackupRepack>[0],
  transactionExpectation: Parameters<
    EncryptedWalletBackupRepackPersistenceStore["withExactRepackTransaction"]
  >[0],
  packs: readonly ReplacementPackExpectation[],
) {
  for (const pack of packs)
    await requirePersistedReplacementPack(input, transactionExpectation, pack);
}

async function requirePersistedReplacementPack(
  input: Parameters<typeof rehydrateEncryptedWalletBackupRepack>[0],
  transactionExpectation: Parameters<
    EncryptedWalletBackupRepackPersistenceStore["withExactRepackTransaction"]
  >[0],
  expected: ReplacementPackExpectation,
) {
  let recordsRead = 0;
  let afterRecordId: string | null = null;
  let stableControl: Uint8Array | null = null;
  while (recordsRead < expected.requiredRecordCount) {
    const page = await exactRepackTransaction(
      input.store,
      transactionExpectation,
      (transaction) =>
        readEncryptedWalletBackupPackEvidencePage({
          transaction,
          keyHandle: input.keyHandle,
          buildId: input.buildId,
          packId: expected.packId,
          snapshotId: input.snapshotId,
          snapshotRevision: input.snapshotRevision,
          requiredRecordCount: expected.requiredRecordCount,
          recordsRead,
          afterRecordId,
        }),
    );
    const control = serializeEncryptedWalletBackupPackControl(page.packControl);
    if (stableControl !== null && !equalBytes(stableControl, control))
      throw new Error(
        "persisted encrypted backup replacement pack changed between pages",
      );
    stableControl ??= control;
    if (page.packControl.version < expected.lastPackVersion)
      throw new Error(
        "persisted encrypted backup replacement pack version regressed",
      );
    await requirePersistedReplacementPackPage(input, expected, page.rows);
    recordsRead += page.rows.length;
    afterRecordId = page.rows.at(-1)!.binding.recordId;
  }
}

async function requirePersistedReplacementPackPage(
  input: Parameters<typeof rehydrateEncryptedWalletBackupRepack>[0],
  expected: ReplacementPackExpectation,
  rows: readonly EncryptedWalletBackupPackRecordPageRow[],
) {
  const expectedByOrdinal = new Map(
    expected.rows.map((row) => [row.ordinal, row.decision] as const),
  );
  const retained = rows.filter((row) =>
    expectedByOrdinal.has(row.binding.ordinal),
  );
  if (retained.length === 0) return;
  await rehydratePreparedEncryptedWalletBackupRecordBatch({
    keyHandle: input.keyHandle,
    seed: input.seed,
    persisted: retained.map(({ prepared }) => prepared.prepared),
    snapshotStore: input.snapshotStore,
  });
  for (const row of retained) {
    const decision = expectedByOrdinal.get(row.binding.ordinal)!;
    if (
      row.binding.recordId !== decision.recordId ||
      row.prepared.prepared.recordId !== decision.recordId ||
      row.prepared.prepared.commitment !== decision.commitment ||
      row.prepared.prepared.recordKindCode !== decision.recordKindCode
    )
      throw new Error(
        "persisted encrypted backup replacement pack row is foreign",
      );
  }
}

function requireProgressScope(
  row: PersistedEncryptedWalletBackupRepackProgress,
  control: PersistedEncryptedWalletBackupRepackControl,
  transitionOrdinal: number,
  previousProgressDigest: string | null,
) {
  if (
    row.repackId !== control.repackId ||
    row.realm !== control.realm ||
    row.vaultId !== control.vaultId ||
    row.transitionOrdinal !== transitionOrdinal ||
    row.previousProgressDigest !== previousProgressDigest ||
    row.parentManifestDigest !== control.parentManifestDigest ||
    row.parentReferenceSetDigest !== control.parentReferenceSetDigest ||
    row.sourceSetDigest !== control.sourceSetDigest ||
    row.removalSetDigest !== control.removalSetDigest ||
    row.buildId !== control.buildId ||
    row.targetGeneration !== control.targetGeneration ||
    row.snapshotNonce !== control.snapshotNonce ||
    row.snapshotId !== control.snapshotId ||
    row.snapshotRevision !== control.snapshotRevision
  )
    throw new Error("persisted encrypted backup repack progress is foreign");
}

function requireProgressDecision(
  record: RepackSourceRecord,
  decision: PersistedEncryptedWalletBackupRepackProgressDecision,
  removalRecordIds: ReadonlySet<string>,
) {
  if (
    decision.sourceOrdinal !== record.sourceOrdinal ||
    decision.sourceObjectId !== record.sourceObjectId ||
    decision.sourceObjectDigest !== record.sourceObjectDigest ||
    decision.recordKindCode !== record.recordKindCode ||
    decision.recordId !== record.recordId ||
    decision.commitment !== record.commitment ||
    (decision.omissionAuthorization !== null) !==
      removalRecordIds.has(record.recordId)
  )
    throw new Error("persisted encrypted backup repack decision is foreign");
}

function issueRepack(
  selection: AuthenticatedRepackSelection,
  control: PersistedEncryptedWalletBackupRepackControl,
  sources: readonly PersistedEncryptedWalletBackupRepackSourceCoverage[],
) {
  const result = Object.freeze(viewOf(control));
  REPACK_AUTHORITIES.set(result, {
    selection,
    control,
    sources: Object.freeze(
      sources.map((source) => Object.freeze({ ...source })),
    ),
    consumed: false,
  });
  return result;
}

function viewOf(control: PersistedEncryptedWalletBackupRepackControl) {
  return {
    repackId: control.repackId,
    nextRecordOrdinal: control.nextRecordOrdinal,
    totalRecordCount: control.totalRecordCount,
    retainedRecordCount: control.retainedRecordCount,
    omittedRecordCount: control.omittedRecordCount,
    state: control.state,
  } as const;
}

function consumeRepack(value: AuthenticatedEncryptedWalletBackupRepack) {
  const authority = readRepackAuthority(value);
  if (authority.consumed)
    throw new Error("encrypted backup repack authority was already consumed");
  authority.consumed = true;
  return authority;
}

function readRepackAuthority(value: unknown): RepackAuthority {
  const authority =
    typeof value === "object" && value !== null
      ? (REPACK_AUTHORITIES.get(value) ??
        COMPLETED_REPACK_AUTHORITIES.get(value))
      : undefined;
  if (authority === undefined)
    throw new Error("authenticated encrypted backup repack is invalid");
  return authority;
}

function expectedSourceVersions(
  input: Parameters<typeof rehydrateEncryptedWalletBackupRepack>[0],
  selection: AuthenticatedRepackSelection,
) {
  if (
    !Array.isArray(input.expectedSourceVersions) ||
    input.expectedSourceVersions.length !== selection.sources.length
  )
    throw new Error("encrypted backup repack source versions are invalid");
  return selection.sources.map((source, index) => ({
    sourceObjectId: source.sourceObjectId,
    version: requireVersion(
      input.expectedSourceVersions[index],
      "source version",
    ),
  }));
}

function transactionExpectation(
  input: {
    repackId: string;
    keyHandle?: EncryptedWalletBackupKeyHandle;
    realm?: string;
    vaultId?: string;
    buildId: string;
    packId: string;
    snapshotId: string;
    snapshotRevision: number;
    expectedBuildVersion: number;
    expectedPackVersion: number;
  },
  sources: readonly PersistedEncryptedWalletBackupRepackSourceCoverage[],
  repackVersion: number | null,
) {
  return {
    ...baseExpectation(input),
    repackVersion,
    sourceVersions: sources.map((source) => ({
      sourceObjectId: source.sourceObjectId,
      version: repackVersion === null ? null : source.version,
    })),
  };
}

function baseExpectation(input: {
  repackId: string;
  keyHandle?: EncryptedWalletBackupKeyHandle;
  realm?: string;
  vaultId?: string;
  buildId: string;
  packId: string;
  snapshotId: string;
  snapshotRevision: number;
  expectedBuildVersion: number;
  expectedPackVersion: number;
}) {
  const realm = input.keyHandle?.realm ?? input.realm;
  const vaultId = input.keyHandle?.vaultId ?? input.vaultId;
  if (realm === undefined || vaultId === undefined)
    throw new Error("encrypted backup repack scope is invalid");
  return {
    repackId: requireIdentifier(input.repackId, "repack id"),
    buildId: requireIdentifier(input.buildId, "build id"),
    buildVersion: requireVersion(input.expectedBuildVersion, "build version"),
    packId: requireIdentifier(input.packId, "pack id"),
    packVersion: requireVersion(input.expectedPackVersion, "pack version"),
    realm: requireText(realm, 64, "realm"),
    vaultId: requireFingerprint(vaultId, "vault id"),
    snapshotId: requireText(input.snapshotId, 128, "snapshot id"),
    snapshotRevision: requireNonNegative(
      input.snapshotRevision,
      "snapshot revision",
    ),
  };
}

function scopeFromAuthority(authority: RepackAuthority) {
  return {
    repackId: authority.control.repackId,
    realm: authority.control.realm,
    vaultId: authority.control.vaultId,
    buildId: authority.control.buildId,
    snapshotId: authority.control.snapshotId,
    snapshotRevision: authority.control.snapshotRevision,
  };
}

async function exactRepackTransaction<T>(
  store: EncryptedWalletBackupRepackPersistenceStore,
  expected: Parameters<
    EncryptedWalletBackupRepackPersistenceStore["withExactRepackTransaction"]
  >[0],
  use: (transaction: EncryptedWalletBackupRepackPersistenceTransaction) => T,
): Promise<T> {
  if (!store || typeof store.withExactRepackTransaction !== "function")
    throw new Error("encrypted backup repack persistence store is invalid");
  const sentinel = Object.freeze({ exactRepackCommit: true });
  let calls = 0;
  let synchronous = true;
  let result: T | undefined;
  const pending = store.withExactRepackTransaction(expected, (transaction) => {
    if (!synchronous || calls++ !== 0)
      throw new Error(
        "encrypted backup repack transaction callback is invalid",
      );
    result = use(transaction);
    if (isThenable(result))
      throw new Error(
        "encrypted backup repack transaction must be synchronous",
      );
    return sentinel;
  });
  synchronous = false;
  const returned = await pending;
  if (calls !== 1 || returned !== sentinel)
    throw new Error(
      "encrypted backup repack transaction callback must be exact",
    );
  return result as T;
}

function requireSameControl(
  left: PersistedEncryptedWalletBackupRepackControl,
  right: PersistedEncryptedWalletBackupRepackControl,
) {
  if (
    !equalBytes(
      serializeEncryptedWalletBackupRepackControl(left),
      serializeEncryptedWalletBackupRepackControl(right),
    )
  )
    throw new Error("persisted encrypted backup repack changed");
}

function requireSameSources(
  left: readonly PersistedEncryptedWalletBackupRepackSourceCoverage[],
  right: readonly PersistedEncryptedWalletBackupRepackSourceCoverage[],
) {
  if (
    left.length !== right.length ||
    left.some(
      (row, index) =>
        !equalBytes(
          serializeEncryptedWalletBackupRepackSourceCoverage(row),
          serializeEncryptedWalletBackupRepackSourceCoverage(right[index]!),
        ),
    )
  )
    throw new Error("persisted encrypted backup repack coverage changed");
}

export function serializeEncryptedWalletBackupRepackControl(
  value: PersistedEncryptedWalletBackupRepackControl,
): Uint8Array {
  const row = requireRepackControl(value);
  return encodeCanonical([
    1,
    row.repackId,
    row.realm,
    hexBytes(row.vaultId),
    row.enrollmentEpoch,
    row.parentGeneration,
    hexBytes(row.parentManifestDigest),
    hexBytes(row.parentReferenceSetDigest),
    hexBytes(row.parentHeadDigest),
    hexBytes(row.parentChunkReferencesDigest),
    hexBytes(row.sourceSetDigest),
    hexBytes(row.removalSetDigest),
    row.sourceCount,
    row.totalRecordCount,
    row.nextRecordOrdinal,
    row.retainedRecordCount,
    row.omittedRecordCount,
    row.buildId,
    row.targetGeneration,
    fromHex(row.snapshotNonce),
    row.snapshotId,
    row.snapshotRevision,
    row.replacementPackIds,
    row.lastProgressDigest === null ? null : hexBytes(row.lastProgressDigest),
    row.version,
    row.state === "active" ? 0 : 1,
  ]);
}

export function deserializeEncryptedWalletBackupRepackControl(
  bytes: Uint8Array,
): PersistedEncryptedWalletBackupRepackControl {
  const value = requireCanonicalRepackRow(bytes, 26, "repack control");
  return requireRepackControl({
    schemaVersion: 1,
    repackId: value[1],
    realm: value[2],
    vaultId: bytesToHex(requireBytes(value[3], 32, 32, "vault id")),
    enrollmentEpoch: value[4],
    parentGeneration: value[5],
    parentManifestDigest: fingerprintFromWire(
      value[6],
      "parent manifest digest",
    ),
    parentReferenceSetDigest: fingerprintFromWire(
      value[7],
      "parent reference-set digest",
    ),
    parentHeadDigest: fingerprintFromWire(value[8], "parent head digest"),
    parentChunkReferencesDigest: fingerprintFromWire(
      value[9],
      "parent chunk-reference digest",
    ),
    sourceSetDigest: fingerprintFromWire(value[10], "source-set digest"),
    removalSetDigest: fingerprintFromWire(value[11], "removal-set digest"),
    sourceCount: value[12],
    totalRecordCount: value[13],
    nextRecordOrdinal: value[14],
    retainedRecordCount: value[15],
    omittedRecordCount: value[16],
    buildId: value[17],
    targetGeneration: value[18],
    snapshotNonce: bytesToHex(
      requireBytes(value[19], 16, 16, "snapshot nonce"),
    ),
    snapshotId: value[20],
    snapshotRevision: value[21],
    replacementPackIds: value[22],
    lastProgressDigest:
      value[23] === null
        ? null
        : fingerprintFromWire(value[23], "last progress digest"),
    version: value[24],
    state:
      value[25] === 0 ? "active" : value[25] === 1 ? "complete" : value[25],
  });
}

export function serializeEncryptedWalletBackupRepackSourceCoverage(
  value: PersistedEncryptedWalletBackupRepackSourceCoverage,
): Uint8Array {
  const row = requireRepackSourceCoverage(value);
  return encodeCanonical([
    1,
    row.repackId,
    row.realm,
    hexBytes(row.vaultId),
    row.sourceOrdinal,
    hexBytes16(row.sourceObjectId),
    hexBytes(row.sourceObjectDigest),
    row.sourceGeneration,
    row.recordCount,
    row.coveredRecordCount,
    row.retainedRecordCount,
    row.omittedRecordCount,
    row.version,
  ]);
}

export function deserializeEncryptedWalletBackupRepackSourceCoverage(
  bytes: Uint8Array,
): PersistedEncryptedWalletBackupRepackSourceCoverage {
  const value = requireCanonicalRepackRow(bytes, 13, "repack source");
  return requireRepackSourceCoverage({
    schemaVersion: 1,
    repackId: value[1],
    realm: value[2],
    vaultId: bytesToHex(requireBytes(value[3], 32, 32, "vault id")),
    sourceOrdinal: value[4],
    sourceObjectId: bytesToHex(
      requireBytes(value[5], 16, 16, "source object id"),
    ),
    sourceObjectDigest: fingerprintFromWire(value[6], "source object digest"),
    sourceGeneration: value[7],
    recordCount: value[8],
    coveredRecordCount: value[9],
    retainedRecordCount: value[10],
    omittedRecordCount: value[11],
    version: value[12],
  });
}

function requireCanonicalRepackRow(
  bytes: Uint8Array,
  length: number,
  label: string,
): readonly unknown[] {
  const exact = requireBytes(
    bytes,
    1,
    ENCRYPTED_WALLET_BACKUP_PACK_TRANSACTION_MAX_BYTES,
    label,
  );
  const value = decode(exact);
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    value[0] !== 1 ||
    !equalBytes(exact, encodeCanonical(value))
  )
    throw new Error(`persisted encrypted backup ${label} is invalid`);
  return value;
}

function requireRepackControl(
  value: unknown,
): PersistedEncryptedWalletBackupRepackControl {
  const row = strictRecord(value, REPACK_CONTROL_FIELDS, "repack control");
  const counts = requireRepackControlCounts(row);
  const parent = requireRepackParentBinding(row);
  const targetGeneration = requireTargetGeneration(
    row.targetGeneration,
    parent.parentGeneration,
  );
  const replacementPackIds = requireReplacementPackIds(row.replacementPackIds);
  const version = boundedInteger(
    row.version,
    0,
    ENCRYPTED_WALLET_BACKUP_REPACK_PROGRESS_MAX,
    "repack version",
  );
  const state = requireRepackState(
    row.state,
    counts.nextRecordOrdinal,
    counts.totalRecordCount,
  );
  return Object.freeze({
    ...requireRepackControlIdentity(row),
    ...parent,
    ...counts,
    buildId: requireIdentifier(row.buildId, "build id"),
    targetGeneration,
    snapshotNonce: requireLowerHex(row.snapshotNonce, 16, "snapshot nonce"),
    snapshotId: requireText(row.snapshotId, 128, "snapshot id"),
    snapshotRevision: requireNonNegative(
      row.snapshotRevision,
      "snapshot revision",
    ),
    replacementPackIds,
    lastProgressDigest: requireLastProgressDigest(
      row.lastProgressDigest,
      version,
    ),
    version,
    state,
  });
}

const REPACK_CONTROL_FIELDS = [
  "schemaVersion",
  "repackId",
  "realm",
  "vaultId",
  "enrollmentEpoch",
  "parentGeneration",
  "parentManifestDigest",
  "parentReferenceSetDigest",
  "parentHeadDigest",
  "parentChunkReferencesDigest",
  "sourceSetDigest",
  "removalSetDigest",
  "sourceCount",
  "totalRecordCount",
  "nextRecordOrdinal",
  "retainedRecordCount",
  "omittedRecordCount",
  "buildId",
  "targetGeneration",
  "snapshotNonce",
  "snapshotId",
  "snapshotRevision",
  "replacementPackIds",
  "lastProgressDigest",
  "version",
  "state",
] as const;

function requireRepackControlCounts(row: Record<string, unknown>) {
  const sourceCount = boundedInteger(
    row.sourceCount,
    1,
    ENCRYPTED_WALLET_BACKUP_REPACK_SOURCE_MAX,
    "source count",
  );
  const total = boundedInteger(
    row.totalRecordCount,
    1,
    2_048,
    "total record count",
  );
  const next = boundedInteger(
    row.nextRecordOrdinal,
    0,
    total,
    "next record ordinal",
  );
  const retained = boundedInteger(
    row.retainedRecordCount,
    0,
    next,
    "retained record count",
  );
  const omitted = boundedInteger(
    row.omittedRecordCount,
    0,
    next,
    "omitted record count",
  );
  if (retained + omitted !== next)
    throw new Error("persisted encrypted backup repack counts are invalid");
  return {
    sourceCount,
    totalRecordCount: total,
    nextRecordOrdinal: next,
    retainedRecordCount: retained,
    omittedRecordCount: omitted,
  };
}

function requireReplacementPackIds(value: unknown) {
  if (
    !Array.isArray(value) ||
    value.length > ENCRYPTED_WALLET_BACKUP_REPACK_REPLACEMENT_PACK_MAX
  )
    throw new Error("persisted encrypted backup replacement packs are invalid");
  const replacementPackIds = value.map((id) =>
    requireIdentifier(id, "replacement pack id"),
  );
  if (new Set(replacementPackIds).size !== replacementPackIds.length)
    throw new Error(
      "persisted encrypted backup replacement pack is duplicated",
    );
  return Object.freeze(replacementPackIds);
}

function requireRepackState(value: unknown, next: number, total: number) {
  if (value !== "active" && value !== "complete")
    throw new Error("persisted encrypted backup repack state is invalid");
  if ((value === "complete") !== (next === total))
    throw new Error("persisted encrypted backup repack completion is invalid");
  return value;
}

function requireLastProgressDigest(value: unknown, version: number) {
  if (version === 0) {
    if (value !== null)
      throw new Error("persisted encrypted backup repack progress is invalid");
    return null;
  }
  return requireFingerprint(value, "last progress digest");
}

function requireRepackControlIdentity(row: Record<string, unknown>) {
  return {
    schemaVersion: requireOne(row.schemaVersion),
    repackId: requireIdentifier(row.repackId, "repack id"),
    realm: requireText(row.realm, 64, "realm"),
    vaultId: requireFingerprint(row.vaultId, "vault id"),
    enrollmentEpoch: requirePositive(row.enrollmentEpoch, "enrollment epoch"),
  };
}

function requireRepackParentBinding(row: Record<string, unknown>) {
  return {
    parentGeneration: requirePositive(
      row.parentGeneration,
      "parent generation",
    ),
    parentManifestDigest: requireFingerprint(
      row.parentManifestDigest,
      "parent manifest digest",
    ),
    parentReferenceSetDigest: requireFingerprint(
      row.parentReferenceSetDigest,
      "parent reference-set digest",
    ),
    parentHeadDigest: requireFingerprint(
      row.parentHeadDigest,
      "parent head digest",
    ),
    parentChunkReferencesDigest: requireFingerprint(
      row.parentChunkReferencesDigest,
      "parent chunk-reference digest",
    ),
    sourceSetDigest: requireFingerprint(
      row.sourceSetDigest,
      "source-set digest",
    ),
    removalSetDigest: requireFingerprint(
      row.removalSetDigest,
      "removal-set digest",
    ),
  };
}

function requireRepackSourceCoverage(
  value: unknown,
): PersistedEncryptedWalletBackupRepackSourceCoverage {
  const row = strictRecord(value, REPACK_SOURCE_FIELDS, "repack source");
  const counts = requireRepackSourceCounts(row);
  return Object.freeze({
    schemaVersion: requireOne(row.schemaVersion),
    repackId: requireIdentifier(row.repackId, "repack id"),
    realm: requireText(row.realm, 64, "realm"),
    vaultId: requireFingerprint(row.vaultId, "vault id"),
    sourceOrdinal: boundedInteger(
      row.sourceOrdinal,
      0,
      ENCRYPTED_WALLET_BACKUP_REPACK_SOURCE_MAX - 1,
      "source ordinal",
    ),
    sourceObjectId: requireObjectId(row.sourceObjectId, "source object id"),
    sourceObjectDigest: requireFingerprint(
      row.sourceObjectDigest,
      "source object digest",
    ),
    sourceGeneration: requirePositive(
      row.sourceGeneration,
      "source generation",
    ),
    ...counts,
    version: requireVersion(row.version, "source version"),
  });
}

const REPACK_SOURCE_FIELDS = [
  "schemaVersion",
  "repackId",
  "realm",
  "vaultId",
  "sourceOrdinal",
  "sourceObjectId",
  "sourceObjectDigest",
  "sourceGeneration",
  "recordCount",
  "coveredRecordCount",
  "retainedRecordCount",
  "omittedRecordCount",
  "version",
] as const;

function requireRepackSourceCounts(row: Record<string, unknown>) {
  const recordCount = boundedInteger(
    row.recordCount,
    1,
    512,
    "source record count",
  );
  const covered = boundedInteger(
    row.coveredRecordCount,
    0,
    recordCount,
    "covered record count",
  );
  const retained = boundedInteger(
    row.retainedRecordCount,
    0,
    covered,
    "retained record count",
  );
  const omitted = boundedInteger(
    row.omittedRecordCount,
    0,
    covered,
    "omitted record count",
  );
  if (retained + omitted !== covered)
    throw new Error("persisted encrypted backup source counts are invalid");
  return {
    recordCount,
    coveredRecordCount: covered,
    retainedRecordCount: retained,
    omittedRecordCount: omitted,
  };
}

function digestSourceSet(
  chunks: ReturnType<typeof requireAuthenticatedChunks>,
) {
  return digest(
    encodeCanonical([
      1,
      "encrypted-wallet-backup-repack-source-set",
      chunks.map((chunk) => [
        hexBytes16(chunk.objectId),
        hexBytes(chunk.objectDigest),
        chunk.generation,
        chunk.records.length,
      ]),
    ]),
  );
}

function requireRemovalRecordIds(
  value: readonly string[],
  records: readonly RepackSourceRecord[],
) {
  if (!Array.isArray(value) || value.length > records.length)
    throw new Error("encrypted backup repack removal set is invalid");
  const ids = value.map((id) => requireFingerprint(id, "removal record id"));
  ids.sort();
  if (new Set(ids).size !== ids.length)
    throw new Error("encrypted backup repack removal record is duplicated");
  const available = new Set(records.map(({ recordId }) => recordId));
  if (ids.some((id) => !available.has(id)))
    throw new Error("encrypted backup repack removal record is foreign");
  return Object.freeze(ids);
}

function digestRemovalSet(ids: readonly string[]) {
  return digest(
    encodeCanonical([
      1,
      "encrypted-wallet-backup-repack-removal-set",
      ids.map(hexBytes),
    ]),
  );
}

function digest(bytes: Uint8Array) {
  return bytesToHex(sha256(bytes));
}

function copyRecord(
  record: AuthenticatedEncryptedWalletBackupRepackRecordAuthority,
) {
  return {
    recordKindCode: record.recordKindCode,
    recordId: record.recordId,
    commitment: record.commitment,
    canonicalRecord: record.canonicalRecord.slice(),
    canonicalManifestEntry: record.canonicalManifestEntry.slice(),
  };
}

function copySourceRecord(record: RepackSourceRecord): RepackSourceRecord {
  return Object.freeze({
    ...copyRecord(record),
    sourceOrdinal: record.sourceOrdinal,
    sourceObjectId: record.sourceObjectId,
    sourceObjectDigest: record.sourceObjectDigest,
  });
}

function requireTransactionBound(
  rows: readonly Uint8Array[],
  existingBytes = 0,
) {
  let total = requireNonNegative(existingBytes, "transaction bytes");
  for (const row of rows) {
    total += row.byteLength;
    if (total > ENCRYPTED_WALLET_BACKUP_PACK_TRANSACTION_MAX_BYTES)
      throw new Error(
        "encrypted backup repack transaction exceeds the byte limit",
      );
  }
}

function requireOne(value: unknown): 1 {
  if (value !== 1)
    throw new Error("encrypted backup schema version is invalid");
  return value;
}

function requireTargetGeneration(value: unknown, parentGeneration: number) {
  const generation = requirePositive(value, "target generation");
  if (generation !== parentGeneration + 1)
    throw new Error("encrypted backup target generation is invalid");
  return generation;
}

function fingerprintFromWire(value: unknown, label: string) {
  return bytesToHex(requireBytes(value, 32, 32, label));
}

function hexBytes(value: unknown) {
  return fromHex(requireFingerprint(value, "fingerprint"));
}

function hexBytes16(value: unknown) {
  return fromHex(requireObjectId(value, "object id"));
}

function compareLowerHex(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isThenable(value: unknown) {
  return (
    ((typeof value === "object" && value !== null) ||
      typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
