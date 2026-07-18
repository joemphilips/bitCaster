import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { decode } from "cborg";
import {
  DURABLE_CUSTODY_COMPOSITE_ID_LIMIT_MAX,
  decodeDurableCustodyRecord,
  deriveDurableCustodyArtifactFingerprint,
  encodeDurableCustodyArtifact,
  type DurableCustodyRecord,
} from "./durableCustody.ts";
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
import {
  issueAuthenticatedEncryptedWalletBackupRepackOmission,
  type AuthenticatedEncryptedWalletBackupRepackOmission,
} from "./encryptedWalletBackupRepackOmissionAuthority.ts";
import type { EncryptedWalletBackupRecordKindCode } from "./encryptedWalletBackupRecord.ts";

export const ENCRYPTED_WALLET_BACKUP_REPACK_OMISSION_BATCH_MAX = 256 as const;
export const ENCRYPTED_WALLET_BACKUP_REPACK_OMISSION_TRANSACTION_MAX_BYTES =
  1_048_576 as const;

const REMOVAL_INTENT_CODEC = createEncryptedWalletBackupCodecPrimitives(
  "encrypted backup removal intent",
  { trimmedText: true },
);
const REPACK_OMISSION_CODEC = createEncryptedWalletBackupCodecPrimitives(
  "encrypted backup repack",
  { trimmedText: true },
);
const {
  identifier,
  text,
  fingerprint,
  lowerHex,
  positive,
  nonNegative,
  bytes: requireBytes,
} = REMOVAL_INTENT_CODEC;

export interface EncryptedWalletBackupRepackOmissionBinding {
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
}

export interface PersistedEncryptedWalletBackupRemovalIntent extends EncryptedWalletBackupRepackOmissionBinding {
  readonly schemaVersion: 1;
  readonly intentId: string;
  readonly realm: string;
  readonly vaultId: string;
  readonly authenticationTag: Uint8Array;
}

export type EncryptedWalletBackupRepackOmissionEvidenceRequest = Readonly<{
  binding: EncryptedWalletBackupRepackOmissionBinding;
  evidence:
    | Readonly<{ kind: "spent-transition"; operationId: string }>
    | Readonly<{ kind: "explicit-removal-intent"; intentId: string }>;
}>;

export type EncryptedWalletBackupRepackOmissionEvidence =
  | Readonly<{ kind: "spent-transition"; operation: DurableCustodyRecord }>
  | Readonly<{
      kind: "explicit-removal-intent";
      intent: PersistedEncryptedWalletBackupRemovalIntent;
    }>;

export interface EncryptedWalletBackupRepackOmissionEvidenceStore {
  /**
   * One exact synchronous view over committed custody and removal-intent rows.
   * The adapter must stop before `maximumBytes` rather than materializing a
   * larger result, and must report the exact canonical bytes it read.
   */
  withCommittedEncryptedWalletBackupRepackOmissionEvidenceBatch<T>(
    requests: readonly EncryptedWalletBackupRepackOmissionEvidenceRequest[],
    maximumBytes: number,
    use: (
      page: Readonly<{
        evidence: readonly EncryptedWalletBackupRepackOmissionEvidence[];
        serializedBytes: number;
      }>,
    ) => T,
  ): Promise<unknown>;
}

/**
 * Creates the exact authenticated row that an adapter commits when a user
 * explicitly removes one wallet record. Row existence alone is not authority.
 */
export async function prepareEncryptedWalletBackupRemovalIntent(input: {
  readonly keyHandle: EncryptedWalletBackupKeyHandle;
  readonly intentId: string;
  readonly binding: EncryptedWalletBackupRepackOmissionBinding;
}): Promise<PersistedEncryptedWalletBackupRemovalIntent> {
  const unsigned = requireRemovalIntent({
    schemaVersion: 1,
    intentId: input.intentId,
    realm: input.keyHandle.realm,
    vaultId: input.keyHandle.vaultId,
    ...input.binding,
    authenticationTag: new Uint8Array(32),
  });
  const authenticationTag =
    await signEncryptedWalletBackupPreparationCapability(
      input.keyHandle,
      encodeCanonical(removalIntentPayload(unsigned)),
    );
  return requireRemovalIntent({ ...unsigned, authenticationTag });
}

/**
 * Issues non-clonable omission handles only after one exact committed database
 * view proves every requested spent transition or explicit removal intent.
 */
export async function authenticateEncryptedWalletBackupRepackOmissions(input: {
  readonly keyHandle: EncryptedWalletBackupKeyHandle;
  readonly store: EncryptedWalletBackupRepackOmissionEvidenceStore;
  readonly requests: readonly EncryptedWalletBackupRepackOmissionEvidenceRequest[];
}): Promise<readonly AuthenticatedEncryptedWalletBackupRepackOmission[]> {
  const requests = requireRequests(input.requests);
  const evidence = await readExactEvidence(input.store, requests);
  if (evidence.length !== requests.length)
    throw new Error(
      "encrypted backup repack omission evidence count is invalid",
    );
  const result: AuthenticatedEncryptedWalletBackupRepackOmission[] = [];
  for (let index = 0; index < requests.length; index += 1) {
    result.push(
      await authenticateEvidence(
        input.keyHandle,
        requests[index]!,
        evidence[index]!,
      ),
    );
  }
  return Object.freeze(result);
}

export function serializeEncryptedWalletBackupRemovalIntent(
  value: PersistedEncryptedWalletBackupRemovalIntent,
): Uint8Array {
  const row = requireRemovalIntent(value);
  return encodeCanonical([...removalIntentPayload(row), row.authenticationTag]);
}

export function deserializeEncryptedWalletBackupRemovalIntent(
  bytes: Uint8Array,
): PersistedEncryptedWalletBackupRemovalIntent {
  const exact = requireBytes(bytes, 1, 4_096, "removal intent");
  const value = decode(exact);
  if (
    !Array.isArray(value) ||
    value.length !== 17 ||
    value[0] !== 1 ||
    value[1] !== "encrypted-wallet-backup-removal-intent" ||
    !equalBytes(exact, encodeCanonical(value))
  )
    throw new Error("persisted encrypted backup removal intent is invalid");
  return requireRemovalIntent({
    schemaVersion: value[0],
    intentId: value[2],
    realm: value[3],
    vaultId: bytesToHex(requireBytes(value[4], 32, 32, "vault id")),
    parentManifestDigest: fingerprintFromWire(
      value[5],
      "parent manifest digest",
    ),
    parentReferenceSetDigest: fingerprintFromWire(
      value[6],
      "parent reference-set digest",
    ),
    targetGeneration: value[7],
    snapshotNonce: bytesToHex(requireBytes(value[8], 16, 16, "snapshot nonce")),
    snapshotId: value[9],
    snapshotRevision: value[10],
    sourceObjectId: bytesToHex(
      requireBytes(value[11], 16, 16, "source object id"),
    ),
    sourceObjectDigest: fingerprintFromWire(value[12], "source object digest"),
    recordKindCode: value[13],
    recordId: fingerprintFromWire(value[14], "record id"),
    commitment: fingerprintFromWire(value[15], "commitment"),
    authenticationTag: requireBytes(value[16], 32, 32, "authentication tag"),
  });
}

export function measureEncryptedWalletBackupRepackOmissionEvidence(
  evidence: EncryptedWalletBackupRepackOmissionEvidence,
) {
  if (typeof evidence !== "object" || evidence === null)
    throw new Error("encrypted backup repack omission evidence is invalid");
  if (evidence.kind === "spent-transition")
    return encodeDurableCustodyArtifact(
      decodeDurableCustodyRecord(evidence.operation),
    ).byteLength;
  if (evidence.kind === "explicit-removal-intent")
    return serializeEncryptedWalletBackupRemovalIntent(evidence.intent)
      .byteLength;
  throw new Error("encrypted backup repack omission evidence is invalid");
}

async function authenticateEvidence(
  keyHandle: EncryptedWalletBackupKeyHandle,
  request: EncryptedWalletBackupRepackOmissionEvidenceRequest,
  evidence: EncryptedWalletBackupRepackOmissionEvidence,
): Promise<AuthenticatedEncryptedWalletBackupRepackOmission> {
  if (request.evidence.kind !== evidence.kind)
    throw new Error("encrypted backup repack omission evidence is foreign");
  const authorization =
    evidence.kind === "spent-transition"
      ? spentAuthorization(request, evidence.operation)
      : await removalAuthorization(keyHandle, request, evidence.intent);
  return issueAuthenticatedEncryptedWalletBackupRepackOmission(
    Object.freeze({
      recordId: request.binding.recordId,
      reason: request.evidence.kind,
    }),
    { keyHandle, ...request.binding, authorization },
  );
}

function spentAuthorization(
  request: EncryptedWalletBackupRepackOmissionEvidenceRequest,
  value: DurableCustodyRecord,
) {
  if (request.evidence.kind !== "spent-transition")
    throw new Error("encrypted backup repack omission evidence is foreign");
  const operation = decodeDurableCustodyRecord(value);
  if (
    request.binding.recordKindCode !== 0 ||
    operation.operation.operationId !== request.evidence.operationId ||
    operation.operation.state !== "reconciled" ||
    operation.operation.result.state !== "applied" ||
    operation.operation.result.resultFingerprint === null ||
    operation.operation.reservation.inputs.filter(
      ({ proofId }) => proofId === request.binding.recordId,
    ).length !== 1
  )
    throw new Error("encrypted backup repack spent transition is invalid");
  return Object.freeze({
    kind: "spent-transition" as const,
    operationDigest: deriveDurableCustodyArtifactFingerprint(operation),
    successorRecordSetDigest: operation.operation.result.resultFingerprint,
  });
}

async function removalAuthorization(
  keyHandle: EncryptedWalletBackupKeyHandle,
  request: EncryptedWalletBackupRepackOmissionEvidenceRequest,
  value: PersistedEncryptedWalletBackupRemovalIntent,
) {
  if (request.evidence.kind !== "explicit-removal-intent")
    throw new Error("encrypted backup repack omission evidence is foreign");
  const intent = requireRemovalIntent(value);
  await verifyEncryptedWalletBackupPreparationCapability(
    keyHandle,
    encodeCanonical(removalIntentPayload(intent)),
    intent.authenticationTag,
  );
  if (
    intent.intentId !== request.evidence.intentId ||
    intent.realm !== keyHandle.realm ||
    intent.vaultId !== keyHandle.vaultId ||
    !sameBinding(intent, request.binding)
  )
    throw new Error("encrypted backup repack removal intent is foreign");
  return Object.freeze({
    kind: "explicit-removal-intent" as const,
    intentDigest: digest(serializeEncryptedWalletBackupRemovalIntent(intent)),
  });
}

async function readExactEvidence(
  store: EncryptedWalletBackupRepackOmissionEvidenceStore,
  requests: readonly EncryptedWalletBackupRepackOmissionEvidenceRequest[],
) {
  if (
    !store ||
    typeof store.withCommittedEncryptedWalletBackupRepackOmissionEvidenceBatch !==
      "function"
  )
    throw new Error(
      "encrypted backup repack omission evidence store is invalid",
    );
  const sentinel = Object.freeze({ exactOmissionEvidence: true });
  let calls = 0;
  let synchronous = true;
  let evidence: readonly EncryptedWalletBackupRepackOmissionEvidence[] = [];
  const pending =
    store.withCommittedEncryptedWalletBackupRepackOmissionEvidenceBatch(
      requests,
      ENCRYPTED_WALLET_BACKUP_REPACK_OMISSION_TRANSACTION_MAX_BYTES,
      (page) => {
        if (!synchronous || calls++ !== 0)
          throw new Error(
            "encrypted backup repack omission evidence callback is invalid",
          );
        evidence = requireEvidencePage(page, requests.length);
        return sentinel;
      },
    );
  synchronous = false;
  const returned = await pending;
  if (calls !== 1 || returned !== sentinel)
    throw new Error(
      "encrypted backup repack omission evidence callback must be exact",
    );
  return evidence;
}

function requireEvidencePage(value: unknown, expectedCount: number) {
  requireExactKeys(
    requireObject(value, "omission evidence page"),
    ["evidence", "serializedBytes"],
    "omission evidence page",
  );
  const page = value as {
    evidence: unknown;
    serializedBytes: unknown;
  };
  if (
    !Array.isArray(page.evidence) ||
    page.evidence.length !== expectedCount ||
    !Number.isSafeInteger(page.serializedBytes) ||
    (page.serializedBytes as number) < 1 ||
    (page.serializedBytes as number) >
      ENCRYPTED_WALLET_BACKUP_REPACK_OMISSION_TRANSACTION_MAX_BYTES
  )
    throw new Error(
      "encrypted backup repack omission evidence page is invalid",
    );
  let measuredBytes = 0;
  const evidence = page.evidence.map((row) => {
    measuredBytes += measureEncryptedWalletBackupRepackOmissionEvidence(
      row as EncryptedWalletBackupRepackOmissionEvidence,
    );
    if (
      measuredBytes >
      ENCRYPTED_WALLET_BACKUP_REPACK_OMISSION_TRANSACTION_MAX_BYTES
    )
      throw new Error(
        "encrypted backup repack omission evidence exceeds the transaction byte limit",
      );
    return copyEvidence(row as EncryptedWalletBackupRepackOmissionEvidence);
  });
  if (measuredBytes !== page.serializedBytes)
    throw new Error(
      "encrypted backup repack omission evidence byte accounting is invalid",
    );
  return Object.freeze(evidence);
}

function requireObject(value: unknown, label: string) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`encrypted backup repack ${label} is invalid`);
  return value;
}

function copyEvidence(
  evidence: EncryptedWalletBackupRepackOmissionEvidence,
): EncryptedWalletBackupRepackOmissionEvidence {
  if (typeof evidence !== "object" || evidence === null)
    throw new Error("encrypted backup repack omission evidence is invalid");
  if (evidence.kind === "spent-transition")
    return Object.freeze({
      kind: evidence.kind,
      operation: structuredClone(evidence.operation),
    });
  if (evidence.kind === "explicit-removal-intent")
    return Object.freeze({
      kind: evidence.kind,
      intent: requireRemovalIntent(evidence.intent),
    });
  throw new Error("encrypted backup repack omission evidence is invalid");
}

function requireRequests(
  value: readonly EncryptedWalletBackupRepackOmissionEvidenceRequest[],
) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > ENCRYPTED_WALLET_BACKUP_REPACK_OMISSION_BATCH_MAX
  )
    throw new Error(
      "encrypted backup repack omission request count is invalid",
    );
  const seen = new Set<string>();
  return Object.freeze(
    value.map((request) => {
      if (typeof request !== "object" || request === null)
        throw new Error("encrypted backup repack omission request is invalid");
      requireExactKeys(request, ["binding", "evidence"], "omission request");
      const binding = requireBinding(request.binding, true);
      const evidence = requireEvidenceReference(request.evidence);
      if (seen.has(binding.recordId))
        throw new Error(
          "encrypted backup repack omission request is duplicated",
        );
      seen.add(binding.recordId);
      return Object.freeze({ binding, evidence });
    }),
  );
}

function requireRemovalIntent(
  value: unknown,
): PersistedEncryptedWalletBackupRemovalIntent {
  const row = strictRecord(value, [
    "schemaVersion",
    "intentId",
    "realm",
    "vaultId",
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
    "authenticationTag",
  ]);
  if (row.schemaVersion !== 1)
    throw new Error("encrypted backup removal intent schema is invalid");
  return Object.freeze({
    schemaVersion: 1,
    intentId: identifier(row.intentId, "intent id"),
    realm: text(row.realm, 64, "realm"),
    vaultId: fingerprint(row.vaultId, "vault id"),
    ...requireBinding(row),
    authenticationTag: requireBytes(
      row.authenticationTag,
      32,
      32,
      "authentication tag",
    ).slice(),
  });
}

function requireBinding(
  value: unknown,
  exact = false,
): EncryptedWalletBackupRepackOmissionBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("encrypted backup repack omission binding is invalid");
  if (exact)
    requireExactKeys(
      value,
      [
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
      ],
      "omission binding",
    );
  const row = value as Record<string, unknown>;
  return Object.freeze({
    parentManifestDigest: fingerprint(
      row.parentManifestDigest,
      "parent manifest digest",
    ),
    parentReferenceSetDigest: fingerprint(
      row.parentReferenceSetDigest,
      "parent reference-set digest",
    ),
    targetGeneration: positive(row.targetGeneration, "target generation"),
    snapshotNonce: lowerHex(row.snapshotNonce, 16, "snapshot nonce"),
    snapshotId: text(row.snapshotId, 128, "snapshot id"),
    snapshotRevision: nonNegative(row.snapshotRevision, "snapshot revision"),
    sourceObjectId: lowerHex(row.sourceObjectId, 16, "source object id"),
    sourceObjectDigest: fingerprint(
      row.sourceObjectDigest,
      "source object digest",
    ),
    recordKindCode: recordKind(row.recordKindCode),
    recordId: fingerprint(row.recordId, "record id"),
    commitment: fingerprint(row.commitment, "commitment"),
  });
}

function requireEvidenceReference(value: unknown) {
  if (typeof value !== "object" || value === null)
    throw new Error("encrypted backup repack omission evidence is invalid");
  const row = value as Record<string, unknown>;
  if (row.kind === "spent-transition") {
    requireExactKeys(value, ["kind", "operationId"], "omission evidence");
    return Object.freeze({
      kind: row.kind,
      operationId: durableOperationId(row.operationId),
    });
  }
  if (row.kind === "explicit-removal-intent") {
    requireExactKeys(value, ["kind", "intentId"], "omission evidence");
    return Object.freeze({
      kind: row.kind,
      intentId: identifier(row.intentId, "intent id"),
    });
  }
  throw new Error("encrypted backup repack omission evidence is invalid");
}

function removalIntentPayload(
  row: PersistedEncryptedWalletBackupRemovalIntent,
) {
  return [
    1,
    "encrypted-wallet-backup-removal-intent",
    row.intentId,
    row.realm,
    fromHex(row.vaultId),
    fromHex(row.parentManifestDigest),
    fromHex(row.parentReferenceSetDigest),
    row.targetGeneration,
    fromHex(row.snapshotNonce),
    row.snapshotId,
    row.snapshotRevision,
    fromHex(row.sourceObjectId),
    fromHex(row.sourceObjectDigest),
    row.recordKindCode,
    fromHex(row.recordId),
    fromHex(row.commitment),
  ] as const;
}

function sameBinding(
  left: EncryptedWalletBackupRepackOmissionBinding,
  right: EncryptedWalletBackupRepackOmissionBinding,
) {
  return Object.keys(requireBinding(left)).every(
    (key) =>
      left[key as keyof EncryptedWalletBackupRepackOmissionBinding] ===
      right[key as keyof EncryptedWalletBackupRepackOmissionBinding],
  );
}

function strictRecord(value: unknown, fields: readonly string[]) {
  return REMOVAL_INTENT_CODEC.strictRecord(value, fields, "row");
}

function requireExactKeys(
  value: object,
  fields: readonly string[],
  label: string,
) {
  REPACK_OMISSION_CODEC.exactKeys(value, fields, `${label} fields`);
}

function recordKind(value: unknown): EncryptedWalletBackupRecordKindCode {
  if (value !== 0 && value !== 1 && value !== 2)
    throw new Error("encrypted backup removal intent record kind is invalid");
  return value;
}

function durableOperationId(value: unknown) {
  return text(value, DURABLE_CUSTODY_COMPOSITE_ID_LIMIT_MAX, "operation id");
}

function fingerprintFromWire(value: unknown, label: string) {
  return bytesToHex(requireBytes(value, 32, 32, label));
}

function digest(bytes: Uint8Array) {
  return bytesToHex(sha256(bytes));
}
