import type { EncryptedWalletBackupKeyHandle } from "./encryptedWalletBackup.ts";
import { createEncryptedWalletBackupCodecPrimitives } from "./encryptedWalletBackupCodecPrimitives.ts";
import type { EncryptedWalletBackupRecordKindCode } from "./encryptedWalletBackupRecord.ts";

declare const authenticatedRepackOmissionBrand: unique symbol;

export interface AuthenticatedEncryptedWalletBackupRepackOmission {
  readonly recordId: string;
  readonly reason: "spent-transition" | "explicit-removal-intent";
  readonly [authenticatedRepackOmissionBrand]: true;
}

export type EncryptedWalletBackupRepackOmissionAuthorization =
  | Readonly<{
      kind: "spent-transition";
      operationDigest: string;
      successorRecordSetDigest: string;
    }>
  | Readonly<{
      kind: "explicit-removal-intent";
      intentDigest: string;
    }>;

export interface EncryptedWalletBackupRepackOmissionAuthority {
  readonly keyHandle: EncryptedWalletBackupKeyHandle;
  readonly parentManifestDigest: string;
  readonly parentReferenceSetDigest: string;
  readonly targetGeneration: number;
  readonly snapshotNonce: string;
  readonly snapshotId: string;
  readonly snapshotRevision: number;
  readonly sourceObjectId: string;
  readonly sourceObjectDigest: string;
  readonly recordKindCode: EncryptedWalletBackupRecordKindCode;
  readonly recordId: string;
  readonly commitment: string;
  readonly authorization: EncryptedWalletBackupRepackOmissionAuthorization;
}

const AUTHENTICATED_REPACK_OMISSIONS = new WeakMap<
  object,
  EncryptedWalletBackupRepackOmissionAuthority
>();

const AUTHORITY_CODEC = createEncryptedWalletBackupCodecPrimitives(
  "encrypted backup repack omission",
);
const {
  fingerprint,
  objectId,
  text: boundedText,
  nonNegative,
  positive,
  lowerHex,
} = AUTHORITY_CODEC;

/**
 * Internal issuer for SDK code that has already authenticated an exact durable
 * spend transition or explicit user-removal intent. Deliberately absent from
 * public package and index exports.
 */
export function issueAuthenticatedEncryptedWalletBackupRepackOmission<
  T extends object,
>(
  handle: T,
  input: EncryptedWalletBackupRepackOmissionAuthority,
): T & AuthenticatedEncryptedWalletBackupRepackOmission {
  const authority = requireAuthority(input);
  AUTHENTICATED_REPACK_OMISSIONS.set(handle, authority);
  return handle as T & AuthenticatedEncryptedWalletBackupRepackOmission;
}

export function readAuthenticatedEncryptedWalletBackupRepackOmission(
  value: unknown,
  keyHandle: EncryptedWalletBackupKeyHandle,
): EncryptedWalletBackupRepackOmissionAuthority {
  const authority =
    typeof value === "object" && value !== null
      ? AUTHENTICATED_REPACK_OMISSIONS.get(value)
      : undefined;
  if (authority === undefined || authority.keyHandle !== keyHandle)
    throw new Error(
      "authenticated encrypted backup repack omission is invalid",
    );
  return copyAuthority(authority);
}

function requireAuthority(
  input: EncryptedWalletBackupRepackOmissionAuthority,
): EncryptedWalletBackupRepackOmissionAuthority {
  if (typeof input !== "object" || input === null)
    throw new Error("encrypted backup repack omission authority is invalid");
  requireExactKeys(input, [
    "keyHandle",
    "parentManifestDigest",
    "parentReferenceSetDigest",
    "targetGeneration",
    "snapshotNonce",
    "snapshotId",
    "snapshotRevision",
    "sourceObjectId",
    "sourceObjectDigest",
    "recordKindCode",
    "recordId",
    "commitment",
    "authorization",
  ]);
  const authorization = requireAuthorization(input.authorization);
  return Object.freeze({
    keyHandle: input.keyHandle,
    parentManifestDigest: fingerprint(
      input.parentManifestDigest,
      "parent manifest digest",
    ),
    parentReferenceSetDigest: fingerprint(
      input.parentReferenceSetDigest,
      "parent reference-set digest",
    ),
    targetGeneration: positive(input.targetGeneration, "target generation"),
    snapshotNonce: lowerHex(input.snapshotNonce, 16, "snapshot nonce"),
    snapshotId: boundedText(input.snapshotId, 128, "snapshot id"),
    snapshotRevision: nonNegative(input.snapshotRevision, "snapshot revision"),
    sourceObjectId: objectId(input.sourceObjectId, "object id"),
    sourceObjectDigest: fingerprint(input.sourceObjectDigest, "source digest"),
    recordKindCode: recordKind(input.recordKindCode),
    recordId: fingerprint(input.recordId, "record id"),
    commitment: fingerprint(input.commitment, "commitment"),
    authorization,
  });
}

function requireAuthorization(
  value: EncryptedWalletBackupRepackOmissionAuthorization,
): EncryptedWalletBackupRepackOmissionAuthorization {
  if (typeof value !== "object" || value === null)
    throw new Error(
      "encrypted backup repack omission authorization is invalid",
    );
  switch (value.kind) {
    case "spent-transition": {
      requireExactKeys(value, [
        "kind",
        "operationDigest",
        "successorRecordSetDigest",
      ]);
      return Object.freeze({
        kind: value.kind,
        operationDigest: fingerprint(value.operationDigest, "operation digest"),
        successorRecordSetDigest: fingerprint(
          value.successorRecordSetDigest,
          "successor record-set digest",
        ),
      });
    }
    case "explicit-removal-intent": {
      requireExactKeys(value, ["kind", "intentDigest"]);
      return Object.freeze({
        kind: value.kind,
        intentDigest: fingerprint(value.intentDigest, "removal intent digest"),
      });
    }
    default:
      throw new Error(
        "encrypted backup repack omission authorization is invalid",
      );
  }
}

function copyAuthority(
  authority: EncryptedWalletBackupRepackOmissionAuthority,
): EncryptedWalletBackupRepackOmissionAuthority {
  return Object.freeze({
    ...authority,
    authorization: Object.freeze({ ...authority.authorization }),
  });
}

function requireExactKeys(value: object, fields: readonly string[]) {
  AUTHORITY_CODEC.exactKeys(value, fields, "authority fields");
}

function recordKind(value: unknown): EncryptedWalletBackupRecordKindCode {
  if (value !== 0 && value !== 1 && value !== 2)
    throw new Error("encrypted backup repack omission record kind is invalid");
  return value;
}
