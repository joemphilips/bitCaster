import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { decode } from "cborg";
import {
  encodeCanonicalBackupCbor,
  preflightEncryptedBackupHeadCbor,
  preflightEncryptedBackupReferenceSetCbor,
} from "./encryptedWalletBackupCbor.ts";

export const ENCRYPTED_WALLET_BACKUP_RECORD_COUNT_MAX = 512 as const;
export const ENCRYPTED_WALLET_BACKUP_BODY_BYTES = 262_172 as const;
export const ENCRYPTED_WALLET_BACKUP_MANIFEST_BODY_BYTES = 65_564 as const;
export const ENCRYPTED_WALLET_BACKUP_MANIFEST_ENTRY_COUNT_MAX = 512 as const;
export const ENCRYPTED_WALLET_BACKUP_MANIFEST_TOTAL_ENTRY_COUNT_MAX =
  512 * 1_024;
export const ENCRYPTED_WALLET_BACKUP_VAULT_STORED_BYTES_MAX =
  64 * 1_024 * 1_024;
export const ENCRYPTED_WALLET_BACKUP_REFERENCE_COUNT_MAX = 1_024 as const;
export const ENCRYPTED_WALLET_BACKUP_REFERENCE_METADATA_MAX_BYTES =
  65_536 as const;

export interface ValidatedEncryptedWalletBackupManifestHeadUnit {
  readonly realm: string;
  readonly vaultId: string;
  readonly backupPublicKey: string;
  readonly generation: number;
  readonly parent: null | Readonly<{
    generation: number;
    manifestDigest: string;
  }>;
  readonly snapshotNonce: string;
  readonly pageReferences: readonly EncryptedWalletBackupObjectReference[];
  readonly chunkReferences: readonly EncryptedWalletBackupObjectReference[];
  readonly recordCount: number;
  readonly storedBytes: number;
  readonly referenceSetDigest: string;
  readonly manifestDigest: string;
}

interface EncryptedWalletBackupObjectReference {
  readonly objectId: string;
  readonly digest: string;
}

/**
 * Validates one canonical manifest head and its canonical reference set as an
 * inseparable semantic unit. This function grants no storage or recovery
 * authority; callers separately bind the returned observation to their scope.
 */
export function validateEncryptedWalletBackupManifestHeadUnit(
  input: Readonly<{
    canonicalHead: Uint8Array;
    canonicalReferenceSet: Uint8Array;
  }>,
): ValidatedEncryptedWalletBackupManifestHeadUnit {
  requireBytesRange(
    input.canonicalHead,
    1,
    ENCRYPTED_WALLET_BACKUP_REFERENCE_METADATA_MAX_BYTES,
    "canonical manifest head",
  );
  requireBytesRange(
    input.canonicalReferenceSet,
    1,
    ENCRYPTED_WALLET_BACKUP_REFERENCE_METADATA_MAX_BYTES,
    "canonical manifest reference set",
  );
  preflightEncryptedBackupHeadCbor(input.canonicalHead);
  preflightEncryptedBackupReferenceSetCbor(input.canonicalReferenceSet);
  const head = decode(input.canonicalHead) as unknown;
  const referenceSet = decode(input.canonicalReferenceSet) as unknown;
  if (
    !equalBytes(input.canonicalHead, encodeCanonicalBackupCbor(head)) ||
    !equalBytes(
      input.canonicalReferenceSet,
      encodeCanonicalBackupCbor(referenceSet),
    ) ||
    !Array.isArray(head) ||
    head.length !== 13 ||
    head[0] !== 1 ||
    head[1] !== "manifest-head"
  ) {
    throw new Error("manifest head encoding is invalid");
  }
  const realm = requireRealm(head[2]);
  const vaultId = bytesToHex(
    requireExactBytes(head[3], 32, "manifest vault id"),
  );
  const backupPublicKey = bytesToHex(
    requireExactBytes(head[4], 32, "manifest public key"),
  );
  const generation = requireInteger(
    head[5],
    1,
    Number.MAX_SAFE_INTEGER,
    "manifest generation",
  );
  let parent: ValidatedEncryptedWalletBackupManifestHeadUnit["parent"];
  if (head[6] === null) {
    if (generation !== 1) throw new Error("manifest parent is invalid");
    parent = null;
  } else {
    if (!Array.isArray(head[6]) || head[6].length !== 2) {
      throw new Error("manifest parent is invalid");
    }
    const parentGeneration = requireInteger(
      head[6][0],
      1,
      Number.MAX_SAFE_INTEGER,
      "parent generation",
    );
    if (parentGeneration !== generation - 1) {
      throw new Error("manifest parent is invalid");
    }
    parent = Object.freeze({
      generation: parentGeneration,
      manifestDigest: bytesToHex(
        requireExactBytes(head[6][1], 32, "parent digest"),
      ),
    });
  }
  const snapshotNonce = bytesToHex(
    requireExactBytes(head[7], 16, "manifest snapshot nonce"),
  );
  const pageReferences = decodeReferences(head[8], "manifest page references");
  const chunkReferences = decodeReferences(
    head[9],
    "manifest chunk references",
  );
  if (
    pageReferences.length + chunkReferences.length >
    ENCRYPTED_WALLET_BACKUP_REFERENCE_COUNT_MAX
  ) {
    throw new Error("manifest reference count is invalid");
  }
  for (let index = 1; index < chunkReferences.length; index += 1) {
    if (
      chunkReferences[index - 1]!.objectId >= chunkReferences[index]!.objectId
    ) {
      throw new Error("manifest chunk references are not canonical");
    }
  }
  const allReferences = [...pageReferences, ...chunkReferences];
  if (
    new Set(allReferences.map((reference) => reference.objectId)).size !==
      allReferences.length ||
    new Set(allReferences.map((reference) => reference.digest)).size !==
      allReferences.length
  ) {
    throw new Error("manifest references are duplicated");
  }
  const recordCount = requireInteger(
    head[10],
    0,
    ENCRYPTED_WALLET_BACKUP_MANIFEST_TOTAL_ENTRY_COUNT_MAX,
    "manifest record count",
  );
  if (
    (recordCount === 0 && allReferences.length !== 0) ||
    (recordCount > 0 &&
      (pageReferences.length === 0 || chunkReferences.length === 0)) ||
    chunkReferences.length <
      Math.ceil(recordCount / ENCRYPTED_WALLET_BACKUP_RECORD_COUNT_MAX) ||
    chunkReferences.length > recordCount ||
    pageReferences.length <
      Math.ceil(
        recordCount / ENCRYPTED_WALLET_BACKUP_MANIFEST_ENTRY_COUNT_MAX,
      ) ||
    pageReferences.length > recordCount
  ) {
    throw new Error("manifest record count does not match reference bounds");
  }
  const storedBytes = requireInteger(
    head[11],
    0,
    ENCRYPTED_WALLET_BACKUP_VAULT_STORED_BYTES_MAX,
    "manifest stored bytes",
  );
  const expectedStoredBytes =
    pageReferences.length * ENCRYPTED_WALLET_BACKUP_MANIFEST_BODY_BYTES +
    chunkReferences.length * ENCRYPTED_WALLET_BACKUP_BODY_BYTES;
  if (storedBytes !== expectedStoredBytes) {
    throw new Error("manifest stored bytes do not match references");
  }
  const referenceSetDigest = bytesToHex(
    requireExactBytes(head[12], 32, "reference set digest"),
  );
  if (
    !Array.isArray(referenceSet) ||
    referenceSet.length !== 4 ||
    referenceSet[0] !== 1 ||
    referenceSet[1] !== "reference-set" ||
    !equalBytes(
      encodeCanonicalBackupCbor(referenceSet[2]),
      encodeCanonicalBackupCbor(head[8]),
    ) ||
    !equalBytes(
      encodeCanonicalBackupCbor(referenceSet[3]),
      encodeCanonicalBackupCbor(head[9]),
    ) ||
    referenceSetDigest !== bytesToHex(sha256(input.canonicalReferenceSet))
  ) {
    throw new Error("manifest reference set does not match head");
  }
  return Object.freeze({
    realm,
    vaultId,
    backupPublicKey,
    generation,
    parent,
    snapshotNonce,
    pageReferences: Object.freeze(pageReferences),
    chunkReferences: Object.freeze(chunkReferences),
    recordCount,
    storedBytes,
    referenceSetDigest,
    manifestDigest: bytesToHex(sha256(input.canonicalHead)),
  });
}

function decodeReferences(
  value: unknown,
  name: string,
): EncryptedWalletBackupObjectReference[] {
  if (
    !Array.isArray(value) ||
    value.length > ENCRYPTED_WALLET_BACKUP_REFERENCE_COUNT_MAX
  ) {
    throw new Error(`${name} are invalid`);
  }
  return value.map((raw) => {
    if (!Array.isArray(raw) || raw.length !== 2) {
      throw new Error(`${name} are invalid`);
    }
    return Object.freeze({
      objectId: bytesToHex(
        requireExactBytes(raw[0], 16, "referenced object id"),
      ),
      digest: bytesToHex(
        requireExactBytes(raw[1], 32, "referenced object digest"),
      ),
    });
  });
}

function requireRealm(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(value)
  ) {
    throw new Error("manifest realm is invalid");
  }
  return value;
}

function requireInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value as number;
}

function requireExactBytes(
  value: unknown,
  length: number,
  name: string,
): Uint8Array {
  return requireBytesRange(value, length, length, name);
}

function requireBytesRange(
  value: unknown,
  minimum: number,
  maximum: number,
  name: string,
): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < minimum ||
    value.byteLength > maximum
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}
