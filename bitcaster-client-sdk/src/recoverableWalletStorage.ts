/**
 * Persistence-neutral wallet storage classification. Physical adapters store
 * the resulting record, but may not weaken its pin or purge disposition.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  requireVerifiedCtfLosingOutcomeEvidence,
  type CtfLosingOutcomeProofIdentity,
  type VerifiedCtfLosingOutcomeEvidence,
} from "./ctfRedeem.ts";
import {
  issueDurableWalletVerifiedLosingCtfClassification,
  requireDurableWalletVerifiedLosingCtfClassification,
} from "./walletStorageAuthority.ts";
import {
  requireDurableWalletAcknowledgedBackupSnapshot,
  requireDurableWalletAuthenticatedBackupReceipt,
} from "./encryptedWalletBackupAuthority.ts";

export {
  isDurableCustodySafeAbortEligible,
  type DurableCustodySafeAbortEvidence,
} from "./durableCustody.ts";

export const DURABLE_WALLET_STORAGE_SCHEMA_VERSION = 1 as const;

export interface DurableWalletVerifiedLosingCtfClassification {
  readonly schemaVersion: 1;
}

export function verifyDurableWalletLosingCtfClassification(input: {
  evidence: VerifiedCtfLosingOutcomeEvidence;
  operationId: string;
  mintUrl: string;
  conditionId: string;
  outcome: string;
  keysetId: string;
  proof: CtfLosingOutcomeProofIdentity;
}): DurableWalletVerifiedLosingCtfClassification {
  requireVerifiedCtfLosingOutcomeEvidence(input);
  return issueDurableWalletVerifiedLosingCtfClassification();
}

export const DURABLE_WALLET_STORAGE_CLASSES = [
  "pinned-local-recovery-state",
  "pinned-operation-bound-deterministic",
  "remotely-backed-deterministic-proof",
  "user-retained-nonselectable-ctf",
  "disposable-derived-data",
] as const;

export type DurableWalletStorageClass =
  (typeof DURABLE_WALLET_STORAGE_CLASSES)[number];

export const DURABLE_WALLET_STORAGE_PIN_REASONS = [
  "active-p2pk-or-htlc-material",
  "ephemeral-private-key",
  "adaptor-secret",
  "pre-signature",
  "exact-inbound-cipher",
  "exact-outbound-cipher",
  "external-token-unrotated",
  "ambiguous-mint-operation",
  "active-reservation",
  "open-order-collateral",
  "pending-outbox",
  "active-retry-cursor",
  "replay-tombstone",
  "nonterminal-operation-link",
  "unknown-operation-link",
  "unknown-proof-provenance",
  "unknown-proof-condition",
  "missing-derivation-locator",
  "unverified-proof-commitment",
  "missing-current-backup-receipt",
  "unknown-ctf-metadata",
] as const;

export type DurableWalletStoragePinReason =
  (typeof DURABLE_WALLET_STORAGE_PIN_REASONS)[number];

export interface DurableWalletStorageClassification {
  schemaVersion: typeof DURABLE_WALLET_STORAGE_SCHEMA_VERSION;
  recordId: string;
  recordKind: "recovery-artifact" | "deterministic-proof" | "derived-data";
  storageClass: DurableWalletStorageClass;
  pinReasons: DurableWalletStoragePinReason[];
  proofCommitment: string | null;
  backupBinding: DurableWalletProofBackupBinding | null;
  /** Only disposable derived data has an automatic deletion boundary. */
  purgeAfterMs: number | null;
}

export interface DurableWalletProofBackupBinding {
  snapshotId: string;
  chunkDigest: string;
  proofCommitment: string;
}

export const DURABLE_WALLET_ENCRYPTED_BACKUP_FORMAT_VERSION = 1 as const;

/**
 * Exact receipt produced only after the authenticated service response has
 * been verified. Later backup protocol slices own that verification step.
 */
export interface DurableWalletEncryptedBackupReceipt {
  readonly formatVersion: typeof DURABLE_WALLET_ENCRYPTED_BACKUP_FORMAT_VERSION;
  readonly realm: string;
  readonly backupPublicKey: string;
  readonly generation: number;
  readonly snapshotId: string;
  readonly manifestDigest: string;
  readonly chunkDigest: string;
  readonly proofCommitment: string;
}

export interface DurableWalletAuthenticatedBackupReceiptEvidence {
  state: "authenticated";
  readonly receipt: DurableWalletEncryptedBackupReceipt;
}

/** Locally acknowledged current snapshot used to reject historical receipts. */
export interface DurableWalletAcknowledgedBackupSnapshot {
  readonly formatVersion: typeof DURABLE_WALLET_ENCRYPTED_BACKUP_FORMAT_VERSION;
  readonly realm: string;
  readonly backupPublicKey: string;
  readonly generation: number;
  readonly snapshotId: string;
  readonly manifestDigest: string;
  readonly reachableChunkDigests: readonly string[];
}

export interface DurableWalletAcknowledgedBackupSnapshotEvidence {
  readonly state: "acknowledged";
  readonly snapshot: DurableWalletAcknowledgedBackupSnapshot;
}

const PREPARED_BACKUP_SNAPSHOT = Symbol("prepared-backup-snapshot");
const PREPARED_BACKUP_REACHABILITY = new WeakMap<object, ReadonlySet<string>>();

export interface PreparedDurableWalletAcknowledgedBackupSnapshot {
  readonly [PREPARED_BACKUP_SNAPSHOT]: true;
  readonly snapshot: DurableWalletAcknowledgedBackupSnapshot;
}

export function deriveDurableWalletBackupSnapshotId(input: {
  formatVersion: typeof DURABLE_WALLET_ENCRYPTED_BACKUP_FORMAT_VERSION;
  realm: string;
  backupPublicKey: string;
  generation: number;
  manifestDigest: string;
}): string {
  if (input.formatVersion !== DURABLE_WALLET_ENCRYPTED_BACKUP_FORMAT_VERSION) {
    throw new Error("unsupported encrypted backup format version");
  }
  const canonical = [
    "bitcaster/encrypted-wallet-backup/snapshot-id/v1",
    String(input.formatVersion),
    requireIdentifier(input.realm, "backup realm"),
    requireLowerHex32(input.backupPublicKey, "backup public key"),
    String(requirePositiveInteger(input.generation, "backup generation")),
    requireLowerHex32(input.manifestDigest, "backup manifest digest"),
  ];
  return bytesToHex(sha256(encodeCanonicalParts(canonical)));
}

export function decodeDurableWalletEncryptedBackupReceipt(
  value: unknown,
): DurableWalletEncryptedBackupReceipt {
  const receipt = requireRecord(value, "encrypted backup receipt");
  requireKnownFields(receipt, [
    "formatVersion",
    "realm",
    "backupPublicKey",
    "generation",
    "snapshotId",
    "manifestDigest",
    "chunkDigest",
    "proofCommitment",
  ]);
  if (
    receipt.formatVersion !== DURABLE_WALLET_ENCRYPTED_BACKUP_FORMAT_VERSION
  ) {
    throw new Error("unsupported encrypted backup receipt format version");
  }
  const decoded = {
    formatVersion: DURABLE_WALLET_ENCRYPTED_BACKUP_FORMAT_VERSION,
    realm: requireIdentifier(receipt.realm, "backup realm"),
    backupPublicKey: requireLowerHex32(
      receipt.backupPublicKey,
      "backup public key",
    ),
    generation: requirePositiveInteger(receipt.generation, "backup generation"),
    snapshotId: requireLowerHex32(receipt.snapshotId, "backup snapshot id"),
    manifestDigest: requireLowerHex32(
      receipt.manifestDigest,
      "backup manifest digest",
    ),
    chunkDigest: requireLowerHex32(receipt.chunkDigest, "backup chunk digest"),
    proofCommitment: requireLowerHex32(
      receipt.proofCommitment,
      "backup proof commitment",
    ),
  };
  if (decoded.snapshotId !== deriveDurableWalletBackupSnapshotId(decoded)) {
    throw new Error("backup snapshot id does not match receipt head");
  }
  return decoded;
}

export function decodeDurableWalletAcknowledgedBackupSnapshot(
  value: unknown,
): DurableWalletAcknowledgedBackupSnapshot {
  const snapshot = requireRecord(value, "acknowledged backup snapshot");
  requireKnownFields(snapshot, [
    "formatVersion",
    "realm",
    "backupPublicKey",
    "generation",
    "snapshotId",
    "manifestDigest",
    "reachableChunkDigests",
  ]);
  if (
    snapshot.formatVersion !== DURABLE_WALLET_ENCRYPTED_BACKUP_FORMAT_VERSION
  ) {
    throw new Error("unsupported acknowledged backup snapshot format version");
  }
  const reachableChunkDigests = requireArray(
    snapshot.reachableChunkDigests,
    "reachable backup chunk digests",
  ).map((digest) => requireLowerHex32(digest, "backup chunk digest"));
  if (reachableChunkDigests.length > 1_024) {
    throw new Error("acknowledged backup snapshot exceeds the chunk limit");
  }
  if (new Set(reachableChunkDigests).size !== reachableChunkDigests.length) {
    throw new Error("reachable backup chunk digest is duplicated");
  }
  const decoded = {
    formatVersion: DURABLE_WALLET_ENCRYPTED_BACKUP_FORMAT_VERSION,
    realm: requireIdentifier(snapshot.realm, "backup realm"),
    backupPublicKey: requireLowerHex32(
      snapshot.backupPublicKey,
      "backup public key",
    ),
    generation: requirePositiveInteger(
      snapshot.generation,
      "backup generation",
    ),
    snapshotId: requireLowerHex32(snapshot.snapshotId, "backup snapshot id"),
    manifestDigest: requireLowerHex32(
      snapshot.manifestDigest,
      "backup manifest digest",
    ),
    reachableChunkDigests: Object.freeze([...reachableChunkDigests]),
  };
  if (decoded.snapshotId !== deriveDurableWalletBackupSnapshotId(decoded)) {
    throw new Error("backup snapshot id does not match acknowledged head");
  }
  return decoded;
}

export function prepareDurableWalletAcknowledgedBackupSnapshot(
  evidenceInput: DurableWalletAcknowledgedBackupSnapshotEvidence,
): PreparedDurableWalletAcknowledgedBackupSnapshot {
  const snapshotAuthority =
    requireDurableWalletAcknowledgedBackupSnapshot(evidenceInput).snapshot;
  const snapshot = Object.freeze({
    ...snapshotAuthority,
    reachableChunkDigests: Object.freeze([
      ...snapshotAuthority.reachableChunkDigests,
    ]),
  });
  const prepared = {
    [PREPARED_BACKUP_SNAPSHOT]: true,
    snapshot,
  } as PreparedDurableWalletAcknowledgedBackupSnapshot;
  PREPARED_BACKUP_REACHABILITY.set(
    prepared,
    new Set(snapshot.reachableChunkDigests),
  );
  return Object.freeze(prepared);
}

type NonDerivableArtifactKind = Extract<
  DurableWalletStoragePinReason,
  | "active-p2pk-or-htlc-material"
  | "ephemeral-private-key"
  | "adaptor-secret"
  | "pre-signature"
  | "exact-inbound-cipher"
  | "exact-outbound-cipher"
  | "external-token-unrotated"
  | "pending-outbox"
  | "active-retry-cursor"
  | "replay-tombstone"
>;

export type DurableWalletStorageClassificationInput =
  | {
      schemaVersion: typeof DURABLE_WALLET_STORAGE_SCHEMA_VERSION;
      recordId: string;
      kind: "non-derivable-recovery-state";
      artifactKind: NonDerivableArtifactKind;
    }
  | {
      schemaVersion: typeof DURABLE_WALLET_STORAGE_SCHEMA_VERSION;
      recordId: string;
      kind: "deterministic-proof";
      provenance: "wallet-seed" | "external" | "unknown";
      proofKind: "ordinary" | "ctf" | "p2pk" | "htlc" | "unknown";
      ctfMetadata: {
        finalExpiryUnixSeconds: number;
        terminalEvidence: DurableWalletVerifiedLosingCtfClassification | null;
      } | null;
      effectiveNowUnixSeconds: number;
      operationBinding: "terminally-unlinked" | "nonterminal" | "unknown";
      reserved: boolean;
      ambiguousMintOperation: boolean;
      proofPins: {
        openOrderCollateral: "absent" | "present" | "unknown";
        outbox: "absent" | "present" | "unknown";
        retryCursor: "absent" | "present" | "unknown";
        replayTombstone: "absent" | "present" | "unknown";
        dependentWork: "absent" | "present" | "unknown";
      };
      derivationLocator: "committed" | "missing";
      proofCommitment:
        | { state: "verified"; digest: string }
        | { state: "unverified" };
      backupReceiptEvidence: DurableWalletAuthenticatedBackupReceiptEvidence | null;
    }
  | {
      schemaVersion: typeof DURABLE_WALLET_STORAGE_SCHEMA_VERSION;
      recordId: string;
      kind: "disposable-derived-data";
      purgeAfterMs: number;
    };

/**
 * Produces the only canonical storage class record accepted by adapters.
 * Unknown runtime values throw instead of becoming a newly evictable class.
 */
export function classifyDurableWalletStorage(
  input: DurableWalletStorageClassificationInput,
): DurableWalletStorageClassification {
  const value = requireRecord(input, "wallet storage classification input");
  if (value.schemaVersion !== DURABLE_WALLET_STORAGE_SCHEMA_VERSION) {
    throw new Error("unsupported durable wallet storage schema version");
  }
  const recordId = requireIdentifier(
    value.recordId,
    "wallet storage record id",
  );
  switch (value.kind) {
    case "non-derivable-recovery-state": {
      requireKnownFields(value, [
        "schemaVersion",
        "recordId",
        "kind",
        "artifactKind",
      ]);
      const artifactKind = requirePinReason(value.artifactKind);
      if (!NON_DERIVABLE_ARTIFACT_KINDS.has(artifactKind)) {
        throw new Error("non-derivable artifact kind is invalid");
      }
      return classification(
        recordId,
        "recovery-artifact",
        "pinned-local-recovery-state",
        [artifactKind],
        null,
        null,
        null,
      );
    }
    case "deterministic-proof": {
      requireKnownFields(value, [
        "schemaVersion",
        "recordId",
        "kind",
        "provenance",
        "proofKind",
        "operationBinding",
        "reserved",
        "ambiguousMintOperation",
        "proofPins",
        "derivationLocator",
        "proofCommitment",
        "backupReceiptEvidence",
        "ctfMetadata",
        "effectiveNowUnixSeconds",
      ]);
      return classifyDeterministicProof(value, recordId);
    }
    case "disposable-derived-data":
      requireKnownFields(value, [
        "schemaVersion",
        "recordId",
        "kind",
        "purgeAfterMs",
      ]);
      return classification(
        recordId,
        "derived-data",
        "disposable-derived-data",
        [],
        null,
        null,
        requireNonNegativeInteger(
          value.purgeAfterMs,
          "wallet storage purge boundary",
        ),
      );
    default:
      throw new Error("wallet storage classification kind is invalid");
  }
}

/** Strict persisted-record decoder. Unknown versions/classes/reasons fail closed. */
export function decodeDurableWalletStorageClassification(
  value: unknown,
): DurableWalletStorageClassification {
  const record = requireRecord(value, "durable wallet storage classification");
  requireKnownFields(record, [
    "schemaVersion",
    "recordId",
    "recordKind",
    "storageClass",
    "pinReasons",
    "proofCommitment",
    "backupBinding",
    "purgeAfterMs",
  ]);
  if (record.schemaVersion !== DURABLE_WALLET_STORAGE_SCHEMA_VERSION) {
    throw new Error("unsupported durable wallet storage schema version");
  }
  const storageClass = requireStorageClass(record.storageClass);
  const recordKind = requireOneOf(
    record.recordKind,
    ["recovery-artifact", "deterministic-proof", "derived-data"],
    "wallet storage record kind",
  );
  const reasons = requireArray(
    record.pinReasons,
    "wallet storage pin reasons",
  ).map(requirePinReason);
  if (new Set(reasons).size !== reasons.length)
    throw new Error("wallet storage pin reason is duplicated");
  const canonicalReasons = canonicalizeReasons(reasons);
  if (canonicalReasons.some((reason, index) => reason !== reasons[index])) {
    throw new Error("wallet storage pin reasons are not canonical");
  }
  const purgeAfterMs =
    record.purgeAfterMs === null
      ? null
      : requireNonNegativeInteger(
          record.purgeAfterMs,
          "wallet storage purge boundary",
        );
  const proofCommitment =
    record.proofCommitment === null
      ? null
      : requireLowerHex32(record.proofCommitment, "proof commitment");
  const backupBinding =
    record.backupBinding === null
      ? null
      : decodeProofBackupBinding(record.backupBinding);
  const recordId =
    recordKind === "deterministic-proof"
      ? requireLowerHex32(record.recordId, "wallet proof id")
      : requireIdentifier(record.recordId, "wallet storage record id");
  validateClassBindings(
    recordKind,
    storageClass,
    canonicalReasons,
    proofCommitment,
    backupBinding,
    purgeAfterMs,
  );
  return {
    schemaVersion: DURABLE_WALLET_STORAGE_SCHEMA_VERSION,
    recordId,
    recordKind,
    storageClass,
    pinReasons: canonicalReasons,
    proofCommitment,
    backupBinding,
    purgeAfterMs,
  };
}

export type DurableWalletStoragePurgeDecision =
  | { kind: "retain" }
  | { kind: "evict-proof-body" }
  | { kind: "delete-record" };

export interface DurableWalletStoragePurgeContext {
  effectiveNowMs: number;
  /** Remains false until the cross-browser and mint-restart qualification gate passes. */
  encryptedProofEvictionEnabled: boolean;
  preparedCurrentSnapshot: PreparedDurableWalletAcknowledgedBackupSnapshot | null;
}

/** SDK-owned purge decision; adapters never infer deletion from physical rows. */
export function decideDurableWalletStoragePurge(
  classificationRecord: DurableWalletStorageClassification,
  contextInput: DurableWalletStoragePurgeContext,
): DurableWalletStoragePurgeDecision {
  const record = decodeDurableWalletStorageClassification(classificationRecord);
  const context = requireRecord(contextInput, "wallet storage purge context");
  requireKnownFields(context, [
    "effectiveNowMs",
    "encryptedProofEvictionEnabled",
    "preparedCurrentSnapshot",
  ]);
  const nowMs = requireNonNegativeInteger(
    context.effectiveNowMs,
    "wallet storage effective time",
  );
  const encryptedProofEvictionEnabled = requireBoolean(
    context.encryptedProofEvictionEnabled,
    "encrypted-proof eviction gate",
  );
  const currentSnapshot =
    context.preparedCurrentSnapshot === null
      ? null
      : requirePreparedSnapshot(context.preparedCurrentSnapshot);
  switch (record.storageClass) {
    case "pinned-local-recovery-state":
    case "pinned-operation-bound-deterministic":
      return { kind: "retain" };
    case "remotely-backed-deterministic-proof":
      return encryptedProofEvictionEnabled &&
        currentSnapshot !== null &&
        isReceiptReachableFromCurrentSnapshot(record, currentSnapshot)
        ? { kind: "evict-proof-body" }
        : { kind: "retain" };
    case "user-retained-nonselectable-ctf":
      return { kind: "retain" };
    case "disposable-derived-data":
      return nowMs >= record.purgeAfterMs!
        ? { kind: "delete-record" }
        : { kind: "retain" };
  }
}

function isReceiptReachableFromCurrentSnapshot(
  record: DurableWalletStorageClassification,
  prepared: PreparedDurableWalletAcknowledgedBackupSnapshot,
): boolean {
  const binding = record.backupBinding;
  const snapshot = prepared.snapshot;
  const reachable = PREPARED_BACKUP_REACHABILITY.get(prepared);
  return (
    binding !== null &&
    reachable !== undefined &&
    record.proofCommitment !== null &&
    binding.snapshotId === snapshot.snapshotId &&
    binding.proofCommitment === record.proofCommitment &&
    reachable.has(binding.chunkDigest)
  );
}

function classifyDeterministicProof(
  value: Record<string, unknown>,
  recordId: string,
): DurableWalletStorageClassification {
  requireLowerHex32(recordId, "wallet proof id");
  const provenance = requireOneOf(
    value.provenance,
    ["wallet-seed", "external", "unknown"],
    "proof provenance",
  );
  const proofKind = requireOneOf(
    value.proofKind,
    ["ordinary", "ctf", "p2pk", "htlc", "unknown"],
    "proof kind",
  );
  const ctfMetadata =
    value.ctfMetadata === null
      ? null
      : requireRecord(value.ctfMetadata, "CTF metadata");
  if (ctfMetadata !== null) {
    requireKnownFields(ctfMetadata, [
      "finalExpiryUnixSeconds",
      "terminalEvidence",
    ]);
  }
  if ((proofKind === "ctf") !== (ctfMetadata !== null)) {
    throw new Error("CTF metadata does not match proof kind");
  }
  const finalExpiryUnixSeconds =
    ctfMetadata === null
      ? null
      : requireNonNegativeInteger(
          ctfMetadata.finalExpiryUnixSeconds,
          "CTF final expiry",
        );
  const terminalEvidence =
    ctfMetadata === null ? null : ctfMetadata.terminalEvidence;
  if (
    terminalEvidence !== null
  ) {
    requireDurableWalletVerifiedLosingCtfClassification(terminalEvidence);
  }
  const effectiveNowUnixSeconds = requireNonNegativeInteger(
    value.effectiveNowUnixSeconds,
    "wallet storage effective time",
  );
  const isRetainedCtf =
    terminalEvidence !== null ||
    (finalExpiryUnixSeconds !== null &&
      finalExpiryUnixSeconds <= effectiveNowUnixSeconds);
  const operationBinding = requireOneOf(
    value.operationBinding,
    ["terminally-unlinked", "nonterminal", "unknown"],
    "proof operation binding",
  );
  const reserved = requireBoolean(value.reserved, "proof reservation marker");
  const ambiguousMintOperation = requireBoolean(
    value.ambiguousMintOperation,
    "ambiguous mint operation marker",
  );
  const pins = decodeProofPins(value.proofPins);
  const derivationLocator = requireOneOf(
    value.derivationLocator,
    ["committed", "missing"],
    "proof derivation locator",
  );
  const proofCommitment = requireOneOf(
    requireRecord(value.proofCommitment, "proof commitment").state,
    ["verified", "unverified"],
    "proof commitment state",
  );
  const proofCommitmentRecord = requireRecord(
    value.proofCommitment,
    "proof commitment",
  );
  requireKnownFields(
    proofCommitmentRecord,
    proofCommitment === "verified" ? ["state", "digest"] : ["state"],
  );
  const proofCommitmentDigest =
    proofCommitment === "verified"
      ? requireLowerHex32(proofCommitmentRecord.digest, "proof commitment")
      : null;
  const receiptEvidence =
    value.backupReceiptEvidence === null
      ? null
      : decodeAuthenticatedReceiptEvidence(value.backupReceiptEvidence);
  const backupReceipt = receiptEvidence?.receipt ?? null;
  if (
    backupReceipt !== null &&
    proofCommitmentDigest !== null &&
    backupReceipt.proofCommitment !== proofCommitmentDigest
  ) {
    throw new Error("backup receipt proof commitment does not match");
  }

  const operationReasons: DurableWalletStoragePinReason[] = [];
  if (ambiguousMintOperation) operationReasons.push("ambiguous-mint-operation");
  if (reserved) operationReasons.push("active-reservation");
  if (pins.openOrderCollateral !== "absent")
    operationReasons.push("open-order-collateral");
  if (pins.outbox !== "absent") operationReasons.push("pending-outbox");
  if (pins.retryCursor !== "absent")
    operationReasons.push("active-retry-cursor");
  if (pins.replayTombstone !== "absent")
    operationReasons.push("replay-tombstone");
  if (pins.dependentWork !== "absent")
    operationReasons.push("nonterminal-operation-link");
  if (operationBinding === "nonterminal")
    operationReasons.push("nonterminal-operation-link");
  if (operationBinding === "unknown")
    operationReasons.push("unknown-operation-link");
  if (operationReasons.length > 0) {
    return classification(
      recordId,
      "deterministic-proof",
      "pinned-operation-bound-deterministic",
      canonicalizeReasons(operationReasons),
      proofCommitmentDigest,
      null,
      null,
    );
  }

  const reasons: DurableWalletStoragePinReason[] = [];
  if (provenance === "external") reasons.push("external-token-unrotated");
  if (provenance === "unknown") reasons.push("unknown-proof-provenance");
  if (proofKind === "p2pk" || proofKind === "htlc")
    reasons.push("active-p2pk-or-htlc-material");
  if (proofKind === "unknown") reasons.push("unknown-proof-condition");
  if (derivationLocator === "missing")
    reasons.push("missing-derivation-locator");
  if (proofCommitment === "unverified")
    reasons.push("unverified-proof-commitment");
  if (!isRetainedCtf && backupReceipt === null)
    reasons.push("missing-current-backup-receipt");
  if (reasons.length > 0) {
    return classification(
      recordId,
      "deterministic-proof",
      "pinned-local-recovery-state",
      canonicalizeReasons(reasons),
      proofCommitmentDigest,
      null,
      null,
    );
  }
  if (isRetainedCtf) {
    return classification(
      recordId,
      "deterministic-proof",
      "user-retained-nonselectable-ctf",
      [],
      proofCommitmentDigest,
      backupReceipt === null
        ? null
        : {
            snapshotId: backupReceipt.snapshotId,
            chunkDigest: backupReceipt.chunkDigest,
            proofCommitment: backupReceipt.proofCommitment,
          },
      null,
    );
  }
  return classification(
    recordId,
    "deterministic-proof",
    "remotely-backed-deterministic-proof",
    [],
    proofCommitmentDigest,
    backupReceipt === null
      ? null
      : {
          snapshotId: backupReceipt.snapshotId,
          chunkDigest: backupReceipt.chunkDigest,
          proofCommitment: backupReceipt.proofCommitment,
        },
    null,
  );
}

function classification(
  recordId: string,
  recordKind: DurableWalletStorageClassification["recordKind"],
  storageClass: DurableWalletStorageClass,
  pinReasons: DurableWalletStoragePinReason[],
  proofCommitment: string | null,
  backupBinding: DurableWalletProofBackupBinding | null,
  purgeAfterMs: number | null,
): DurableWalletStorageClassification {
  validateClassBindings(
    recordKind,
    storageClass,
    pinReasons,
    proofCommitment,
    backupBinding,
    purgeAfterMs,
  );
  return {
    schemaVersion: DURABLE_WALLET_STORAGE_SCHEMA_VERSION,
    recordId,
    recordKind,
    storageClass,
    pinReasons,
    proofCommitment,
    backupBinding,
    purgeAfterMs,
  };
}

function validateClassBindings(
  recordKind: DurableWalletStorageClassification["recordKind"],
  storageClass: DurableWalletStorageClass,
  pinReasons: DurableWalletStoragePinReason[],
  proofCommitment: string | null,
  backupBinding: DurableWalletProofBackupBinding | null,
  purgeAfterMs: number | null,
): void {
  if (
    storageClass === "pinned-operation-bound-deterministic" &&
    recordKind !== "deterministic-proof"
  ) {
    throw new Error("operation-bound storage requires a proof record");
  }
  if (
    storageClass === "disposable-derived-data" &&
    recordKind !== "derived-data"
  ) {
    throw new Error("disposable storage requires a derived-data record");
  }
  if (
    storageClass === "pinned-local-recovery-state" ||
    storageClass === "pinned-operation-bound-deterministic"
  ) {
    if (pinReasons.length === 0)
      throw new Error("pinned storage requires a reason");
    if (purgeAfterMs !== null)
      throw new Error("pinned storage cannot have a purge boundary");
    if (backupBinding !== null) {
      throw new Error("pinned storage cannot carry an eviction receipt");
    }
    if (
      storageClass === "pinned-operation-bound-deterministic" &&
      pinReasons.some((reason) => !OPERATION_BOUND_PIN_REASONS.has(reason))
    ) {
      throw new Error("operation-bound deterministic pin reason is invalid");
    }
    return;
  }
  if (pinReasons.length !== 0)
    throw new Error("unpinned storage cannot have pin reasons");
  if (storageClass === "remotely-backed-deterministic-proof") {
    if (purgeAfterMs !== null)
      throw new Error("remotely backed proof cannot have a purge boundary");
    if (
      recordKind !== "deterministic-proof" ||
      proofCommitment === null ||
      backupBinding === null
    ) {
      throw new Error("remotely backed proof requires an exact receipt");
    }
    if (backupBinding.proofCommitment !== proofCommitment) {
      throw new Error("backup receipt proof commitment does not match");
    }
  }
  if (storageClass === "user-retained-nonselectable-ctf") {
    if (purgeAfterMs !== null) {
      throw new Error("user-retained CTF storage cannot have a purge boundary");
    }
    if (recordKind !== "deterministic-proof" || proofCommitment === null) {
      throw new Error(
        "user-retained CTF storage requires an exact proof commitment",
      );
    }
    if (
      backupBinding !== null &&
      backupBinding.proofCommitment !== proofCommitment
    ) {
      throw new Error("backup receipt proof commitment does not match");
    }
  }
  if (storageClass === "disposable-derived-data" && purgeAfterMs === null) {
    throw new Error("disposable storage requires a purge boundary");
  }
  if (
    storageClass === "disposable-derived-data" &&
    (proofCommitment !== null || backupBinding !== null)
  ) {
    throw new Error("disposable storage cannot carry proof backup state");
  }
}

const NON_DERIVABLE_ARTIFACT_KINDS = new Set<DurableWalletStoragePinReason>([
  "active-p2pk-or-htlc-material",
  "ephemeral-private-key",
  "adaptor-secret",
  "pre-signature",
  "exact-inbound-cipher",
  "exact-outbound-cipher",
  "external-token-unrotated",
  "pending-outbox",
  "active-retry-cursor",
  "replay-tombstone",
]);

const OPERATION_BOUND_PIN_REASONS = new Set<DurableWalletStoragePinReason>([
  "ambiguous-mint-operation",
  "active-reservation",
  "open-order-collateral",
  "pending-outbox",
  "active-retry-cursor",
  "replay-tombstone",
  "nonterminal-operation-link",
  "unknown-operation-link",
]);

function decodeProofPins(value: unknown): {
  openOrderCollateral: "absent" | "present" | "unknown";
  outbox: "absent" | "present" | "unknown";
  retryCursor: "absent" | "present" | "unknown";
  replayTombstone: "absent" | "present" | "unknown";
  dependentWork: "absent" | "present" | "unknown";
} {
  const pins = requireRecord(value, "proof pins");
  requireKnownFields(pins, [
    "openOrderCollateral",
    "outbox",
    "retryCursor",
    "replayTombstone",
    "dependentWork",
  ]);
  return {
    openOrderCollateral: requireOneOf(
      pins.openOrderCollateral,
      ["absent", "present", "unknown"],
      "open-order collateral pin",
    ),
    outbox: requireOneOf(
      pins.outbox,
      ["absent", "present", "unknown"],
      "outbox pin",
    ),
    retryCursor: requireOneOf(
      pins.retryCursor,
      ["absent", "present", "unknown"],
      "retry cursor pin",
    ),
    replayTombstone: requireOneOf(
      pins.replayTombstone,
      ["absent", "present", "unknown"],
      "replay tombstone pin",
    ),
    dependentWork: requireOneOf(
      pins.dependentWork,
      ["absent", "present", "unknown"],
      "dependent work pin",
    ),
  };
}

function decodeAuthenticatedReceiptEvidence(
  value: unknown,
): DurableWalletAuthenticatedBackupReceiptEvidence {
  return requireDurableWalletAuthenticatedBackupReceipt(value);
}

function decodeProofBackupBinding(
  value: unknown,
): DurableWalletProofBackupBinding {
  const binding = requireRecord(value, "proof backup binding");
  requireKnownFields(binding, ["snapshotId", "chunkDigest", "proofCommitment"]);
  return {
    snapshotId: requireLowerHex32(binding.snapshotId, "backup snapshot id"),
    chunkDigest: requireLowerHex32(binding.chunkDigest, "backup chunk digest"),
    proofCommitment: requireLowerHex32(
      binding.proofCommitment,
      "backup proof commitment",
    ),
  };
}

function requirePreparedSnapshot(
  value: unknown,
): PreparedDurableWalletAcknowledgedBackupSnapshot {
  const prepared = requireRecord(
    value,
    "prepared acknowledged backup snapshot",
  ) as unknown as PreparedDurableWalletAcknowledgedBackupSnapshot;
  if (
    prepared[PREPARED_BACKUP_SNAPSHOT] !== true ||
    !PREPARED_BACKUP_REACHABILITY.has(prepared)
  ) {
    throw new Error("acknowledged backup snapshot is not prepared");
  }
  return prepared;
}

function encodeCanonicalParts(parts: readonly string[]): Uint8Array {
  const encoder = new TextEncoder();
  const encoded = parts.map((part) => encoder.encode(part));
  const length = encoded.reduce(
    (total, part) => total + 4 + part.byteLength,
    0,
  );
  const result = new Uint8Array(length);
  const view = new DataView(result.buffer);
  let offset = 0;
  for (const part of encoded) {
    view.setUint32(offset, part.byteLength, false);
    offset += 4;
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function canonicalizeReasons(
  reasons: readonly DurableWalletStoragePinReason[],
): DurableWalletStoragePinReason[] {
  const selected = new Set(reasons);
  return DURABLE_WALLET_STORAGE_PIN_REASONS.filter((reason) =>
    selected.has(reason),
  );
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireKnownFields(
  record: Record<string, unknown>,
  expected: readonly string[],
): void {
  for (const key of Object.keys(record)) {
    if (!expected.includes(key)) throw new Error(`unknown field '${key}'`);
  }
  for (const key of expected) {
    if (!(key in record)) throw new Error(`missing required field '${key}'`);
  }
}

function requireIdentifier(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requireLowerHex32(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requireArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} is invalid`);
  return value;
}

function requireNonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, name: string): number {
  const result = requireNonNegativeInteger(value, name);
  if (result === 0) throw new Error(`${name} is invalid`);
  return result;
}

function requireOneOf<const T extends readonly string[]>(
  value: unknown,
  options: T,
  name: string,
): T[number] {
  if (typeof value !== "string" || !options.includes(value))
    throw new Error(`${name} is invalid`);
  return value as T[number];
}

function requireStorageClass(value: unknown): DurableWalletStorageClass {
  if (
    typeof value !== "string" ||
    !DURABLE_WALLET_STORAGE_CLASSES.includes(value as DurableWalletStorageClass)
  ) {
    throw new Error("wallet storage class is invalid");
  }
  return value as DurableWalletStorageClass;
}

function requirePinReason(value: unknown): DurableWalletStoragePinReason {
  if (
    typeof value !== "string" ||
    !DURABLE_WALLET_STORAGE_PIN_REASONS.includes(
      value as DurableWalletStoragePinReason,
    )
  ) {
    throw new Error("wallet storage pin reason is invalid");
  }
  return value as DurableWalletStoragePinReason;
}
