import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { decode } from "cborg";
import type { EncryptedWalletBackupKeyHandle } from "./encryptedWalletBackup.ts";
import { encodeCanonicalBackupCbor as encodeCanonical } from "./encryptedWalletBackupCbor.ts";
import {
  createEncryptedWalletBackupCodecPrimitives,
  encryptedWalletBackupBytesEqual as equalBytes,
  encryptedWalletBackupBytesFromHex as fromHex,
} from "./encryptedWalletBackupCodecPrimitives.ts";
import {
  signEncryptedWalletBackupPreparationCapability,
  verifyEncryptedWalletBackupPreparationCapability,
} from "./encryptedWalletBackupKeyAuthority.ts";
import type { EncryptedWalletBackupRepackOmissionAuthorization } from "./encryptedWalletBackupRepackOmissionAuthority.ts";
import type { EncryptedWalletBackupRecordKindCode } from "./encryptedWalletBackupRecord.ts";

/** Eight 256-record pages plus at most one capacity cut per eight targets. */
export const ENCRYPTED_WALLET_BACKUP_REPACK_PROGRESS_MAX = 16 as const;

const PROGRESS_CODEC = createEncryptedWalletBackupCodecPrimitives(
  "persisted encrypted backup repack",
);
const {
  identifier,
  text,
  fingerprint,
  lowerHex,
  boundedInteger,
  positive,
  nonNegative,
  bytes: requireBytes,
} = PROGRESS_CODEC;

export interface PersistedEncryptedWalletBackupRepackProgressDecision {
  readonly sourceOrdinal: number;
  readonly sourceObjectId: string;
  readonly sourceObjectDigest: string;
  readonly recordKindCode: EncryptedWalletBackupRecordKindCode;
  readonly recordId: string;
  readonly commitment: string;
  readonly omissionAuthorization: EncryptedWalletBackupRepackOmissionAuthorization | null;
}

export interface PersistedEncryptedWalletBackupRepackPackEvidence {
  readonly packId: string;
  readonly buildVersionBefore: number;
  readonly buildVersionAfter: number;
  readonly packVersionBefore: number;
  readonly packVersionAfter: number;
  readonly packRecordCountBefore: number;
  readonly packRecordCountAfter: number;
  readonly retainedRecordCount: number;
  readonly firstRecordId: string;
  readonly lastRecordId: string;
  readonly retainedBindingDigest: string;
}

export interface PersistedEncryptedWalletBackupRepackProgress {
  readonly schemaVersion: 1;
  readonly repackId: string;
  readonly realm: string;
  readonly vaultId: string;
  readonly transitionOrdinal: number;
  readonly previousProgressDigest: string | null;
  readonly parentManifestDigest: string;
  readonly parentReferenceSetDigest: string;
  readonly sourceSetDigest: string;
  readonly removalSetDigest: string;
  readonly buildId: string;
  readonly targetGeneration: number;
  readonly snapshotNonce: string;
  readonly snapshotId: string;
  readonly snapshotRevision: number;
  readonly startRecordOrdinal: number;
  readonly endRecordOrdinal: number;
  readonly decisions: readonly PersistedEncryptedWalletBackupRepackProgressDecision[];
  readonly packEvidence: PersistedEncryptedWalletBackupRepackPackEvidence | null;
  readonly authenticationTag: Uint8Array;
}

export async function prepareEncryptedWalletBackupRepackProgress(input: {
  readonly keyHandle: EncryptedWalletBackupKeyHandle;
  readonly progress: Omit<
    PersistedEncryptedWalletBackupRepackProgress,
    "schemaVersion" | "realm" | "vaultId" | "authenticationTag"
  >;
}): Promise<PersistedEncryptedWalletBackupRepackProgress> {
  const unsigned = requireProgress({
    schemaVersion: 1,
    realm: input.keyHandle.realm,
    vaultId: input.keyHandle.vaultId,
    ...input.progress,
    authenticationTag: new Uint8Array(32),
  });
  const authenticationTag =
    await signEncryptedWalletBackupPreparationCapability(
      input.keyHandle,
      encodeCanonical(progressPayload(unsigned)),
    );
  return requireProgress({ ...unsigned, authenticationTag });
}

export async function verifyEncryptedWalletBackupRepackProgress(
  keyHandle: EncryptedWalletBackupKeyHandle,
  value: PersistedEncryptedWalletBackupRepackProgress,
): Promise<PersistedEncryptedWalletBackupRepackProgress> {
  const row = requireProgress(value);
  if (row.realm !== keyHandle.realm || row.vaultId !== keyHandle.vaultId)
    throw new Error("persisted encrypted backup repack progress is foreign");
  await verifyEncryptedWalletBackupPreparationCapability(
    keyHandle,
    encodeCanonical(progressPayload(row)),
    row.authenticationTag,
  );
  return row;
}

export function digestEncryptedWalletBackupRepackProgress(
  value: PersistedEncryptedWalletBackupRepackProgress,
) {
  return digest(serializeEncryptedWalletBackupRepackProgress(value));
}

export function serializeEncryptedWalletBackupRepackProgress(
  value: PersistedEncryptedWalletBackupRepackProgress,
): Uint8Array {
  const row = requireProgress(value);
  return encodeCanonical([...progressPayload(row), row.authenticationTag]);
}

export function deserializeEncryptedWalletBackupRepackProgress(
  bytes: Uint8Array,
): PersistedEncryptedWalletBackupRepackProgress {
  const exact = requireBytes(bytes, 1, 1_048_576, "progress");
  const value = decode(exact);
  if (
    !Array.isArray(value) ||
    value.length !== 21 ||
    value[0] !== 1 ||
    value[1] !== "encrypted-wallet-backup-repack-progress" ||
    !equalBytes(exact, encodeCanonical(value))
  )
    throw new Error("persisted encrypted backup repack progress is invalid");
  return requireProgress({
    schemaVersion: value[0],
    repackId: value[2],
    realm: value[3],
    vaultId: fingerprintFromWire(value[4], "vault id"),
    transitionOrdinal: value[5],
    previousProgressDigest:
      value[6] === null
        ? null
        : fingerprintFromWire(value[6], "previous progress digest"),
    parentManifestDigest: fingerprintFromWire(
      value[7],
      "parent manifest digest",
    ),
    parentReferenceSetDigest: fingerprintFromWire(
      value[8],
      "parent reference-set digest",
    ),
    sourceSetDigest: fingerprintFromWire(value[9], "source-set digest"),
    removalSetDigest: fingerprintFromWire(value[10], "removal-set digest"),
    buildId: value[11],
    targetGeneration: value[12],
    snapshotNonce: lowerHexFromWire(value[13], 16, "snapshot nonce"),
    snapshotId: value[14],
    snapshotRevision: value[15],
    startRecordOrdinal: value[16],
    endRecordOrdinal: value[17],
    decisions: decodeDecisions(value[18]),
    packEvidence: decodePackEvidence(value[19]),
    authenticationTag: requireBytes(value[20], 32, 32, "authentication tag"),
  });
}

function requireProgress(
  value: unknown,
): PersistedEncryptedWalletBackupRepackProgress {
  const row = strictRecord(value, PROGRESS_FIELDS);
  if (row.schemaVersion !== 1)
    throw new Error(
      "persisted encrypted backup repack progress schema is invalid",
    );
  const chain = requireProgressChain(row);
  const range = requireProgressRange(row);
  return Object.freeze({
    schemaVersion: 1,
    ...requireProgressIdentity(row),
    ...chain,
    ...range,
    authenticationTag: requireBytes(
      row.authenticationTag,
      32,
      32,
      "authentication tag",
    ).slice(),
  });
}

const PROGRESS_FIELDS = [
  "schemaVersion",
  "repackId",
  "realm",
  "vaultId",
  "transitionOrdinal",
  "previousProgressDigest",
  "parentManifestDigest",
  "parentReferenceSetDigest",
  "sourceSetDigest",
  "removalSetDigest",
  "buildId",
  "targetGeneration",
  "snapshotNonce",
  "snapshotId",
  "snapshotRevision",
  "startRecordOrdinal",
  "endRecordOrdinal",
  "decisions",
  "packEvidence",
  "authenticationTag",
] as const;

function requireProgressChain(row: Record<string, unknown>) {
  const transitionOrdinal = boundedInteger(
    row.transitionOrdinal,
    0,
    ENCRYPTED_WALLET_BACKUP_REPACK_PROGRESS_MAX - 1,
    "transition ordinal",
  );
  const previousProgressDigest = nullableFingerprint(
    row.previousProgressDigest,
    "previous progress digest",
  );
  if ((transitionOrdinal === 0) !== (previousProgressDigest === null))
    throw new Error(
      "persisted encrypted backup repack progress chain is invalid",
    );
  return { transitionOrdinal, previousProgressDigest };
}

function requireProgressRange(row: Record<string, unknown>) {
  const startRecordOrdinal = boundedInteger(
    row.startRecordOrdinal,
    0,
    2_047,
    "start record ordinal",
  );
  const endRecordOrdinal = boundedInteger(
    row.endRecordOrdinal,
    startRecordOrdinal + 1,
    2_048,
    "end record ordinal",
  );
  const decisions = requireDecisions(row.decisions);
  if (endRecordOrdinal - startRecordOrdinal !== decisions.length)
    throw new Error(
      "persisted encrypted backup repack progress range is invalid",
    );
  const retained = decisions.filter(
    ({ omissionAuthorization }) => omissionAuthorization === null,
  );
  const packEvidence = requirePackEvidence(row.packEvidence, retained);
  return { startRecordOrdinal, endRecordOrdinal, decisions, packEvidence };
}

function requireProgressIdentity(row: Record<string, unknown>) {
  return {
    repackId: identifier(row.repackId, "repack id"),
    realm: text(row.realm, 64, "realm"),
    vaultId: fingerprint(row.vaultId, "vault id"),
    parentManifestDigest: fingerprint(
      row.parentManifestDigest,
      "parent manifest digest",
    ),
    parentReferenceSetDigest: fingerprint(
      row.parentReferenceSetDigest,
      "parent reference-set digest",
    ),
    sourceSetDigest: fingerprint(row.sourceSetDigest, "source-set digest"),
    removalSetDigest: fingerprint(row.removalSetDigest, "removal-set digest"),
    buildId: identifier(row.buildId, "build id"),
    targetGeneration: positive(row.targetGeneration, "target generation"),
    snapshotNonce: lowerHex(row.snapshotNonce, 16, "snapshot nonce"),
    snapshotId: text(row.snapshotId, 128, "snapshot id"),
    snapshotRevision: nonNegative(row.snapshotRevision, "snapshot revision"),
  };
}

function requireDecisions(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256)
    throw new Error("persisted encrypted backup repack decisions are invalid");
  const seen = new Set<string>();
  return Object.freeze(
    value.map((candidate) => {
      const row = strictRecord(candidate, [
        "sourceOrdinal",
        "sourceObjectId",
        "sourceObjectDigest",
        "recordKindCode",
        "recordId",
        "commitment",
        "omissionAuthorization",
      ]);
      const recordId = fingerprint(row.recordId, "decision record id");
      if (seen.has(recordId))
        throw new Error(
          "persisted encrypted backup repack decision is duplicated",
        );
      seen.add(recordId);
      return Object.freeze({
        sourceOrdinal: boundedInteger(
          row.sourceOrdinal,
          0,
          3,
          "source ordinal",
        ),
        sourceObjectId: lowerHex(row.sourceObjectId, 16, "source object id"),
        sourceObjectDigest: fingerprint(
          row.sourceObjectDigest,
          "source object digest",
        ),
        recordKindCode: recordKind(row.recordKindCode),
        recordId,
        commitment: fingerprint(row.commitment, "decision commitment"),
        omissionAuthorization: requireAuthorization(row.omissionAuthorization),
      });
    }),
  );
}

function requireAuthorization(
  value: unknown,
): EncryptedWalletBackupRepackOmissionAuthorization | null {
  if (value === null) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("persisted encrypted backup repack omission is invalid");
  const row = value as Record<string, unknown>;
  if (row.kind === "spent-transition") {
    requireExactKeys(row, [
      "kind",
      "operationDigest",
      "successorRecordSetDigest",
    ]);
    return Object.freeze({
      kind: row.kind,
      operationDigest: fingerprint(row.operationDigest, "operation digest"),
      successorRecordSetDigest: fingerprint(
        row.successorRecordSetDigest,
        "successor record-set digest",
      ),
    });
  }
  if (row.kind === "explicit-removal-intent") {
    requireExactKeys(row, ["kind", "intentDigest"]);
    return Object.freeze({
      kind: row.kind,
      intentDigest: fingerprint(row.intentDigest, "removal intent digest"),
    });
  }
  throw new Error("persisted encrypted backup repack omission is invalid");
}

function requirePackEvidence(
  value: unknown,
  retained: readonly PersistedEncryptedWalletBackupRepackProgressDecision[],
): PersistedEncryptedWalletBackupRepackPackEvidence | null {
  if (retained.length === 0) {
    if (value !== null)
      throw new Error(
        "persisted encrypted backup repack pack evidence is invalid",
      );
    return null;
  }
  const row = strictRecord(value, [
    "packId",
    "buildVersionBefore",
    "buildVersionAfter",
    "packVersionBefore",
    "packVersionAfter",
    "packRecordCountBefore",
    "packRecordCountAfter",
    "retainedRecordCount",
    "firstRecordId",
    "lastRecordId",
    "retainedBindingDigest",
  ]);
  const result = Object.freeze({
    packId: identifier(row.packId, "pack id"),
    ...requirePackVersions(row),
    ...requirePackCounts(row),
    retainedRecordCount: boundedInteger(
      row.retainedRecordCount,
      1,
      256,
      "retained record count",
    ),
    firstRecordId: fingerprint(row.firstRecordId, "first record id"),
    lastRecordId: fingerprint(row.lastRecordId, "last record id"),
    retainedBindingDigest: fingerprint(
      row.retainedBindingDigest,
      "retained binding digest",
    ),
  });
  requirePackEvidenceConsistency(result, retained);
  return result;
}

function requirePackVersions(row: Record<string, unknown>) {
  return {
    buildVersionBefore: nonNegative(
      row.buildVersionBefore,
      "build version before",
    ),
    buildVersionAfter: nonNegative(
      row.buildVersionAfter,
      "build version after",
    ),
    packVersionBefore: nonNegative(
      row.packVersionBefore,
      "pack version before",
    ),
    packVersionAfter: nonNegative(row.packVersionAfter, "pack version after"),
  };
}

function requirePackCounts(row: Record<string, unknown>) {
  return {
    packRecordCountBefore: boundedInteger(
      row.packRecordCountBefore,
      0,
      511,
      "pack record count before",
    ),
    packRecordCountAfter: boundedInteger(
      row.packRecordCountAfter,
      1,
      512,
      "pack record count after",
    ),
  };
}

function requirePackEvidenceConsistency(
  result: PersistedEncryptedWalletBackupRepackPackEvidence,
  retained: readonly PersistedEncryptedWalletBackupRepackProgressDecision[],
) {
  if (
    result.buildVersionAfter !== result.buildVersionBefore + 1 ||
    result.packVersionAfter !== result.packVersionBefore + 1 ||
    result.packRecordCountAfter !==
      result.packRecordCountBefore + retained.length ||
    result.retainedRecordCount !== retained.length ||
    result.firstRecordId !== retained[0]!.recordId ||
    result.lastRecordId !== retained.at(-1)!.recordId ||
    result.retainedBindingDigest !==
      deriveEncryptedWalletBackupRepackRetainedBindingDigest(retained)
  )
    throw new Error(
      "persisted encrypted backup repack pack evidence is invalid",
    );
}

function progressPayload(row: PersistedEncryptedWalletBackupRepackProgress) {
  return [
    1,
    "encrypted-wallet-backup-repack-progress",
    row.repackId,
    row.realm,
    fromHex(row.vaultId),
    row.transitionOrdinal,
    row.previousProgressDigest === null
      ? null
      : fromHex(row.previousProgressDigest),
    fromHex(row.parentManifestDigest),
    fromHex(row.parentReferenceSetDigest),
    fromHex(row.sourceSetDigest),
    fromHex(row.removalSetDigest),
    row.buildId,
    row.targetGeneration,
    fromHex(row.snapshotNonce),
    row.snapshotId,
    row.snapshotRevision,
    row.startRecordOrdinal,
    row.endRecordOrdinal,
    row.decisions.map(decisionToWire),
    row.packEvidence === null ? null : packEvidenceToWire(row.packEvidence),
  ] as const;
}

function decisionToWire(
  row: PersistedEncryptedWalletBackupRepackProgressDecision,
) {
  return [
    row.sourceOrdinal,
    fromHex(row.sourceObjectId),
    fromHex(row.sourceObjectDigest),
    row.recordKindCode,
    fromHex(row.recordId),
    fromHex(row.commitment),
    authorizationToWire(row.omissionAuthorization),
  ];
}

function authorizationToWire(
  value: EncryptedWalletBackupRepackOmissionAuthorization | null,
) {
  if (value === null) return null;
  return value.kind === "spent-transition"
    ? [
        0,
        fromHex(value.operationDigest),
        fromHex(value.successorRecordSetDigest),
      ]
    : [1, fromHex(value.intentDigest)];
}

function packEvidenceToWire(
  row: PersistedEncryptedWalletBackupRepackPackEvidence,
) {
  return [
    row.packId,
    row.buildVersionBefore,
    row.buildVersionAfter,
    row.packVersionBefore,
    row.packVersionAfter,
    row.packRecordCountBefore,
    row.packRecordCountAfter,
    row.retainedRecordCount,
    fromHex(row.firstRecordId),
    fromHex(row.lastRecordId),
    fromHex(row.retainedBindingDigest),
  ];
}

function decodeDecisions(value: unknown) {
  if (!Array.isArray(value))
    throw new Error("persisted encrypted backup repack decisions are invalid");
  return value.map((candidate) => {
    if (!Array.isArray(candidate) || candidate.length !== 7)
      throw new Error("persisted encrypted backup repack decision is invalid");
    return {
      sourceOrdinal: candidate[0],
      sourceObjectId: lowerHexFromWire(candidate[1], 16, "source object id"),
      sourceObjectDigest: fingerprintFromWire(
        candidate[2],
        "source object digest",
      ),
      recordKindCode: candidate[3],
      recordId: fingerprintFromWire(candidate[4], "record id"),
      commitment: fingerprintFromWire(candidate[5], "commitment"),
      omissionAuthorization: decodeAuthorization(candidate[6]),
    };
  });
}

function decodeAuthorization(value: unknown) {
  if (value === null) return null;
  if (!Array.isArray(value))
    throw new Error("persisted encrypted backup repack omission is invalid");
  if (value.length === 3 && value[0] === 0)
    return {
      kind: "spent-transition" as const,
      operationDigest: fingerprintFromWire(value[1], "operation digest"),
      successorRecordSetDigest: fingerprintFromWire(
        value[2],
        "successor record-set digest",
      ),
    };
  if (value.length === 2 && value[0] === 1)
    return {
      kind: "explicit-removal-intent" as const,
      intentDigest: fingerprintFromWire(value[1], "removal intent digest"),
    };
  throw new Error("persisted encrypted backup repack omission is invalid");
}

function decodePackEvidence(value: unknown) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== 11)
    throw new Error(
      "persisted encrypted backup repack pack evidence is invalid",
    );
  return {
    packId: value[0],
    buildVersionBefore: value[1],
    buildVersionAfter: value[2],
    packVersionBefore: value[3],
    packVersionAfter: value[4],
    packRecordCountBefore: value[5],
    packRecordCountAfter: value[6],
    retainedRecordCount: value[7],
    firstRecordId: fingerprintFromWire(value[8], "first record id"),
    lastRecordId: fingerprintFromWire(value[9], "last record id"),
    retainedBindingDigest: fingerprintFromWire(
      value[10],
      "retained binding digest",
    ),
  };
}

export function deriveEncryptedWalletBackupRepackRetainedBindingDigest(
  records: readonly PersistedEncryptedWalletBackupRepackProgressDecision[],
) {
  return digest(
    encodeCanonical([
      1,
      "encrypted-wallet-backup-repack-retained-bindings",
      records.map((row) => [
        row.sourceOrdinal,
        fromHex(row.sourceObjectId),
        fromHex(row.sourceObjectDigest),
        row.recordKindCode,
        fromHex(row.recordId),
        fromHex(row.commitment),
      ]),
    ]),
  );
}

function strictRecord(value: unknown, fields: readonly string[]) {
  return PROGRESS_CODEC.strictRecord(value, fields, "progress");
}

function requireExactKeys(
  row: Record<string, unknown>,
  fields: readonly string[],
) {
  PROGRESS_CODEC.exactKeys(row, fields, "progress fields");
}

function recordKind(value: unknown): EncryptedWalletBackupRecordKindCode {
  if (value !== 0 && value !== 1 && value !== 2)
    throw new Error("persisted encrypted backup repack record kind is invalid");
  return value;
}

function nullableFingerprint(value: unknown, label: string) {
  return value === null ? null : fingerprint(value, label);
}

function fingerprintFromWire(value: unknown, label: string) {
  return bytesToHex(requireBytes(value, 32, 32, label));
}

function lowerHexFromWire(value: unknown, bytes: number, label: string) {
  return bytesToHex(requireBytes(value, bytes, bytes, label));
}

function digest(bytes: Uint8Array) {
  return bytesToHex(sha256(bytes));
}
