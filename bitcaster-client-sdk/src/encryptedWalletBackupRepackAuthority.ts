import { decode } from "cborg";
import type {
  AuthenticatedEncryptedWalletBackupHeadEvidence,
  DecryptedEncryptedWalletBackupDataChunk,
  DecryptedEncryptedWalletBackupManifestPage,
  EncryptedWalletBackupKeyHandle,
  EncryptedWalletBackupManifestEntry,
  EncryptedWalletBackupManifestHead,
} from "./encryptedWalletBackup.ts";
import { encodeCanonicalBackupCbor as encodeCanonical } from "./encryptedWalletBackupCbor.ts";
import type { EncryptedWalletBackupRecordKindCode } from "./encryptedWalletBackupRecord.ts";

export interface AuthenticatedEncryptedWalletBackupRepackHeadAuthority {
  readonly enrollmentEpoch: number;
  readonly head: EncryptedWalletBackupManifestHead;
  readonly canonicalHead: Uint8Array;
  readonly canonicalChunkReferences: Uint8Array;
  readonly chunkReferences: readonly Readonly<{
    objectId: string;
    digest: string;
  }>[];
}

export interface AuthenticatedEncryptedWalletBackupRepackManifestPageAuthority {
  readonly head: EncryptedWalletBackupManifestHead;
  readonly generation: number;
  readonly snapshotNonce: string;
  readonly pageIndex: number;
  readonly pageCount: number;
  readonly canonicalPage: Uint8Array;
  readonly entries: readonly EncryptedWalletBackupManifestEntry[];
  readonly records: readonly Readonly<{
    entry: EncryptedWalletBackupManifestEntry;
    canonicalManifestEntry: Uint8Array;
  }>[];
}

export interface AuthenticatedEncryptedWalletBackupRepackRecordAuthority {
  readonly recordKindCode: EncryptedWalletBackupRecordKindCode;
  readonly recordId: string;
  readonly commitment: string;
  readonly canonicalRecord: Uint8Array;
  readonly canonicalManifestEntry: Uint8Array;
}

export interface AuthenticatedEncryptedWalletBackupRepackDataChunkAuthority {
  readonly head: EncryptedWalletBackupManifestHead;
  readonly objectId: string;
  readonly objectDigest: string;
  readonly generation: number;
  readonly records: readonly AuthenticatedEncryptedWalletBackupRepackRecordAuthority[];
}

interface RepackHeadAuthority {
  readonly keyHandle: EncryptedWalletBackupKeyHandle;
  readonly head: EncryptedWalletBackupManifestHead;
  readonly enrollmentEpoch: number;
  readonly canonicalHead: Uint8Array;
  readonly canonicalChunkReferences: Uint8Array;
  readonly chunkReferences: readonly Readonly<{
    objectId: string;
    digest: string;
  }>[];
}

interface RepackManifestPageAuthority {
  readonly keyHandle: EncryptedWalletBackupKeyHandle;
  readonly headEvidence: AuthenticatedEncryptedWalletBackupHeadEvidence;
  readonly head: EncryptedWalletBackupManifestHead;
  readonly generation: number;
  readonly snapshotNonce: string;
  readonly pageIndex: number;
  readonly pageCount: number;
  readonly canonicalPage: Uint8Array;
  readonly entries: readonly EncryptedWalletBackupManifestEntry[];
  readonly canonicalManifestEntries: readonly Uint8Array[];
}

interface RepackDataChunkAuthority {
  readonly keyHandle: EncryptedWalletBackupKeyHandle;
  readonly objectId: string;
  readonly objectDigest: string;
  readonly generation: number;
  readonly records: readonly AuthenticatedEncryptedWalletBackupRepackRecordAuthority[];
}

const AUTHENTICATED_REPACK_HEADS = new WeakMap<object, RepackHeadAuthority>();
const AUTHENTICATED_REPACK_MANIFEST_PAGES = new WeakMap<
  object,
  RepackManifestPageAuthority
>();
const AUTHENTICATED_REPACK_DATA_CHUNKS = new WeakMap<
  object,
  RepackDataChunkAuthority
>();

/** Internal issuer; deliberately absent from package and index exports. */
export function issueAuthenticatedEncryptedWalletBackupRepackHeadAuthority(
  evidence: AuthenticatedEncryptedWalletBackupHeadEvidence,
  input: Readonly<{
    keyHandle: EncryptedWalletBackupKeyHandle;
    head: EncryptedWalletBackupManifestHead;
    enrollmentEpoch: number;
    canonicalHead: Uint8Array;
    canonicalChunkReferences: Uint8Array;
    chunkReferences: readonly Readonly<{
      objectId: string;
      digest: string;
    }>[];
  }>,
): void {
  AUTHENTICATED_REPACK_HEADS.set(evidence, {
    keyHandle: input.keyHandle,
    head: input.head,
    enrollmentEpoch: input.enrollmentEpoch,
    canonicalHead: input.canonicalHead.slice(),
    canonicalChunkReferences: input.canonicalChunkReferences.slice(),
    chunkReferences: copyChunkReferences(input.chunkReferences),
  });
}

/** Internal issuer; deliberately absent from package and index exports. */
export function issueAuthenticatedEncryptedWalletBackupRepackManifestPageAuthority(
  page: DecryptedEncryptedWalletBackupManifestPage,
  input: Readonly<{
    keyHandle: EncryptedWalletBackupKeyHandle;
    headEvidence: AuthenticatedEncryptedWalletBackupHeadEvidence;
    head: EncryptedWalletBackupManifestHead;
    canonicalPage: Uint8Array;
  }>,
): void {
  AUTHENTICATED_REPACK_MANIFEST_PAGES.set(page, {
    keyHandle: input.keyHandle,
    headEvidence: input.headEvidence,
    head: input.head,
    generation: page.generation,
    snapshotNonce: page.snapshotNonce,
    pageIndex: page.pageIndex,
    pageCount: page.pageCount,
    canonicalPage: input.canonicalPage.slice(),
    entries: copyManifestEntries(page.entries),
    canonicalManifestEntries: readCanonicalPreparedManifestEntries(
      input.canonicalPage,
      page.entries.length,
    ),
  });
}

/** Internal issuer; deliberately absent from package and index exports. */
export function issueAuthenticatedEncryptedWalletBackupRepackDataChunkAuthority(
  chunk: DecryptedEncryptedWalletBackupDataChunk,
  input: Readonly<{
    keyHandle: EncryptedWalletBackupKeyHandle;
    objectId: string;
    objectDigest: string;
    generation: number;
    records: readonly AuthenticatedEncryptedWalletBackupRepackRecordAuthority[];
  }>,
): void {
  AUTHENTICATED_REPACK_DATA_CHUNKS.set(chunk, {
    keyHandle: input.keyHandle,
    objectId: input.objectId,
    objectDigest: input.objectDigest,
    generation: input.generation,
    records: copyRepackRecords(input.records),
  });
}

export function readAuthenticatedEncryptedWalletBackupRepackHeadAuthority(
  evidence: unknown,
  keyHandle: EncryptedWalletBackupKeyHandle,
  head: EncryptedWalletBackupManifestHead,
): AuthenticatedEncryptedWalletBackupRepackHeadAuthority {
  const authority = readHeadAuthority(evidence, keyHandle, head);
  return Object.freeze({
    enrollmentEpoch: authority.enrollmentEpoch,
    head: authority.head,
    canonicalHead: authority.canonicalHead.slice(),
    canonicalChunkReferences: authority.canonicalChunkReferences.slice(),
    chunkReferences: copyChunkReferences(authority.chunkReferences),
  });
}

export function readAuthenticatedEncryptedWalletBackupRepackManifestPageAuthority(
  page: unknown,
  keyHandle: EncryptedWalletBackupKeyHandle,
  headEvidence: AuthenticatedEncryptedWalletBackupHeadEvidence,
  head: EncryptedWalletBackupManifestHead,
): AuthenticatedEncryptedWalletBackupRepackManifestPageAuthority {
  readHeadAuthority(headEvidence, keyHandle, head);
  const authority =
    typeof page === "object" && page !== null
      ? AUTHENTICATED_REPACK_MANIFEST_PAGES.get(page)
      : undefined;
  if (
    authority === undefined ||
    authority.keyHandle !== keyHandle ||
    authority.headEvidence !== headEvidence ||
    authority.head !== head
  ) {
    throw new Error("authenticated backup repack manifest page is invalid");
  }
  return Object.freeze({
    head: authority.head,
    generation: authority.generation,
    snapshotNonce: authority.snapshotNonce,
    pageIndex: authority.pageIndex,
    pageCount: authority.pageCount,
    canonicalPage: authority.canonicalPage.slice(),
    entries: copyManifestEntries(authority.entries),
    records: copyManifestRecords(
      authority.entries,
      authority.canonicalManifestEntries,
    ),
  });
}

function readCanonicalPreparedManifestEntries(
  canonicalPage: Uint8Array,
  expectedCount: number,
) {
  const page = decode(canonicalPage);
  if (
    !Array.isArray(page) ||
    page.length !== 7 ||
    !Array.isArray(page[6]) ||
    page[6].length !== expectedCount
  )
    throw new Error("authenticated backup repack manifest page is invalid");
  return Object.freeze(
    page[6].map((raw) => {
      if (!Array.isArray(raw) || raw.length < 8)
        throw new Error(
          "authenticated backup repack manifest entry is invalid",
        );
      return encodeCanonical([...raw.slice(0, 3), ...raw.slice(5)]);
    }),
  );
}

function copyManifestRecords(
  entries: readonly EncryptedWalletBackupManifestEntry[],
  canonicalEntries: readonly Uint8Array[],
) {
  if (entries.length !== canonicalEntries.length)
    throw new Error("authenticated backup repack manifest page is invalid");
  return Object.freeze(
    entries.map((entry, index) =>
      Object.freeze({
        entry: copyManifestEntry(entry),
        canonicalManifestEntry: canonicalEntries[index]!.slice(),
      }),
    ),
  );
}

export function readAuthenticatedEncryptedWalletBackupRepackDataChunkAuthority(
  chunk: unknown,
  keyHandle: EncryptedWalletBackupKeyHandle,
  headEvidence: AuthenticatedEncryptedWalletBackupHeadEvidence,
  head: EncryptedWalletBackupManifestHead,
): AuthenticatedEncryptedWalletBackupRepackDataChunkAuthority {
  const headAuthority = readHeadAuthority(headEvidence, keyHandle, head);
  const authority =
    typeof chunk === "object" && chunk !== null
      ? AUTHENTICATED_REPACK_DATA_CHUNKS.get(chunk)
      : undefined;
  if (authority === undefined || authority.keyHandle !== keyHandle) {
    throw new Error("authenticated backup repack data chunk is invalid");
  }
  if (authority.generation > headAuthority.head.generation) {
    throw new Error("authenticated backup repack data chunk is unreachable");
  }
  const matches = headAuthority.chunkReferences.filter(
    (reference) =>
      reference.objectId === authority.objectId &&
      reference.digest === authority.objectDigest,
  );
  if (matches.length !== 1) {
    throw new Error("authenticated backup repack data chunk is unreachable");
  }
  return Object.freeze({
    head: headAuthority.head,
    objectId: authority.objectId,
    objectDigest: authority.objectDigest,
    generation: authority.generation,
    records: copyRepackRecords(authority.records),
  });
}

function readHeadAuthority(
  evidence: unknown,
  keyHandle: EncryptedWalletBackupKeyHandle,
  head: EncryptedWalletBackupManifestHead,
): RepackHeadAuthority {
  const authority =
    typeof evidence === "object" && evidence !== null
      ? AUTHENTICATED_REPACK_HEADS.get(evidence)
      : undefined;
  if (
    authority === undefined ||
    authority.keyHandle !== keyHandle ||
    authority.head !== head
  ) {
    throw new Error("authenticated backup repack head is invalid");
  }
  return authority;
}

function copyChunkReferences(
  references: readonly Readonly<{ objectId: string; digest: string }>[],
): readonly Readonly<{ objectId: string; digest: string }>[] {
  return Object.freeze(
    references.map((reference) =>
      Object.freeze({
        objectId: reference.objectId,
        digest: reference.digest,
      }),
    ),
  );
}

function copyRepackRecords(
  records: readonly AuthenticatedEncryptedWalletBackupRepackRecordAuthority[],
): readonly AuthenticatedEncryptedWalletBackupRepackRecordAuthority[] {
  return Object.freeze(
    records.map((record) =>
      Object.freeze({
        recordKindCode: record.recordKindCode,
        recordId: record.recordId,
        commitment: record.commitment,
        canonicalRecord: record.canonicalRecord.slice(),
        canonicalManifestEntry: record.canonicalManifestEntry.slice(),
      }),
    ),
  );
}

function copyManifestEntries(
  entries: readonly EncryptedWalletBackupManifestEntry[],
): readonly EncryptedWalletBackupManifestEntry[] {
  return Object.freeze(entries.map(copyManifestEntry));
}

function copyManifestEntry(
  entry: EncryptedWalletBackupManifestEntry,
): EncryptedWalletBackupManifestEntry {
  const common = {
    recordId: entry.recordId,
    commitment: entry.commitment,
    dataObjectId: entry.dataObjectId,
    dataDigest: entry.dataDigest,
  };
  switch (entry.recordKindCode) {
    case 0:
      return Object.freeze({
        ...common,
        recordKindCode: entry.recordKindCode,
        proofId: entry.proofId,
        mint: entry.mint,
        unit: entry.unit,
        amount: entry.amount,
        proofKind: entry.proofKind,
        ctfMetadata:
          entry.ctfMetadata === null
            ? null
            : Object.freeze({ ...entry.ctfMetadata }),
        terminalEvidence:
          entry.terminalEvidence === null
            ? null
            : Object.freeze({ ...entry.terminalEvidence }),
        createdAtUnixSeconds: entry.createdAtUnixSeconds,
        updatedAtUnixSeconds: entry.updatedAtUnixSeconds,
      });
    case 1:
      return Object.freeze({
        ...common,
        recordKindCode: entry.recordKindCode,
        logicalRecordId: entry.logicalRecordId,
        parentCommitment: entry.parentCommitment,
        fragmentIndex: entry.fragmentIndex,
        fragmentCount: entry.fragmentCount,
      });
    case 2:
      return Object.freeze({
        ...common,
        recordKindCode: entry.recordKindCode,
        logicalRecordId: entry.logicalRecordId,
        parentCommitment: entry.parentCommitment,
        progression: entry.progression,
        childCommitment: entry.childCommitment,
        fragmentIndex: entry.fragmentIndex,
        fragmentCount: entry.fragmentCount,
      });
    default:
      return assertNever(entry);
  }
}

function assertNever(value: never): never {
  throw new Error(`unsupported encrypted backup record: ${String(value)}`);
}
