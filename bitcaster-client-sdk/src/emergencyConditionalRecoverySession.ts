import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { decodeDurableCustodyScopeId } from "./durableCustody.ts";
import { normalizeDurableWalletMintUrl } from "./durableWalletMintUrl.ts";
import { validateSeedScanState } from "./seedRecoveryCore.ts";
import {
  CONDITIONAL_RECOVERY_MAX_CATALOGUE_BYTES,
  CONDITIONAL_RECOVERY_MAX_NUT07_AUDIT_BYTES,
  CONDITIONAL_RECOVERY_MAX_TOTAL_PROOFS,
  CONDITIONAL_RECOVERY_MAX_WORK_UNITS,
  type ConditionalRecoveryBudget,
  type ConditionalRecoverySession,
  type ConditionalRecoveryWalletScope,
} from "./emergencyConditionalRecoveryTypes.ts";

export const CONDITIONAL_RECOVERY_SESSION_SCHEMA_VERSION = 2 as const;
export const CONDITIONAL_RECOVERY_MAX_SESSION_BYTES = 65_536 as const;

export type ConditionalRecoverySessionTransition =
  | "completed-catalogue"
  | "conditional-keys"
  | "nut13-plan"
  | "nut09-request"
  | "nut09-response"
  | "proof-verification"
  | "atomic-admission"
  | "keyset-completed"
  | "keyset-skipped"
  | "expired-keyset-retention"
  | "recovery-completed"
  | "recovery-failed-closed";

export interface ConditionalRecoverySessionScan {
  readonly startCounter: number;
  readonly nextCounter: number;
  readonly plannedStart: number | null;
  readonly plannedCount: number;
  readonly totalRequestedOutputs: number;
  readonly totalReturnedProofs: number;
  readonly consecutiveEmptyOutputs: number;
}

export interface ConditionalRecoveryBatchBinding {
  readonly planDigest: string;
  readonly requestDigest: string | null;
  readonly planStart: number;
  readonly planCount: number;
  readonly batchDigest: string | null;
  readonly stagedBatchId: string | null;
  readonly returnedCount: number | null;
}

export type ConditionalRecoveryKeysetTerminalEvidence =
  | Readonly<{
      kind: "gap-limit";
      keysetId: string;
      gapLimit: number;
      digest: string;
    }>
  | Readonly<{
      kind: "expired-retention";
      keysetId: string;
      stagedBatchId: string;
      digest: string;
    }>;

export type ConditionalRecoverySkipReason =
  | "freshly-proven-ineligible"
  | "expired-before-request"
  | "expired-empty-response";

export interface ConditionalRecoverySkipEvidence {
  readonly catalogueOrdinal: number;
  readonly keysetId: string;
  readonly reason: ConditionalRecoverySkipReason;
  readonly authorityDigest: string;
}

export type ConditionalRecoveryTerminalEvidence =
  | Readonly<{
      kind: "completed";
      catalogueLength: number;
      digest: string;
    }>
  | Readonly<{
      kind: "failed-closed";
      reasonDigest: string;
    }>;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const HEX_32 = /^[0-9a-f]{64}$/;
const V2_KEYSET_ID = /^01[0-9a-f]{64}$/;

export function initialConditionalRecoveryScan(
  startCounter: number,
): ConditionalRecoverySessionScan {
  requireNonNegativeSafeInteger(startCounter, "start counter");
  return Object.freeze({
    startCounter,
    nextCounter: startCounter,
    plannedStart: null,
    plannedCount: 0,
    totalRequestedOutputs: 0,
    totalReturnedProofs: 0,
    consecutiveEmptyOutputs: 0,
  });
}

export function decodeConditionalRecoveryScan(
  value: unknown,
  limits: { readonly maxBatchSize: number; readonly maxTotalOutputs: number },
): ConditionalRecoverySessionScan {
  const scan = requireObject(value, "conditional recovery session scan");
  requireExactKeys(
    scan,
    [
      "startCounter",
      "nextCounter",
      "plannedStart",
      "plannedCount",
      "totalRequestedOutputs",
      "totalReturnedProofs",
      "consecutiveEmptyOutputs",
    ],
    "conditional recovery session scan",
  );
  const decoded = {
    startCounter: requireNonNegativeSafeInteger(scan.startCounter, "start counter"),
    nextCounter: requireNonNegativeSafeInteger(scan.nextCounter, "next counter"),
    plannedStart:
      scan.plannedStart === null
        ? null
        : requireNonNegativeSafeInteger(scan.plannedStart, "planned start"),
    plannedCount: requireBoundedCounter(scan.plannedCount, limits.maxBatchSize, "planned count"),
    totalRequestedOutputs: requireBoundedCounter(
      scan.totalRequestedOutputs,
      limits.maxTotalOutputs,
      "requested output count",
    ),
    totalReturnedProofs: requireBoundedCounter(
      scan.totalReturnedProofs,
      limits.maxTotalOutputs,
      "returned proof count",
    ),
    consecutiveEmptyOutputs: requireBoundedCounter(
      scan.consecutiveEmptyOutputs,
      limits.maxTotalOutputs,
      "empty output count",
    ),
  };
  validateSeedScanState(decoded, limits.maxTotalOutputs);
  return Object.freeze(decoded);
}

export function decodeConditionalRecoverySessionTransition(
  value: unknown,
): ConditionalRecoverySessionTransition {
  switch (value) {
    case "completed-catalogue":
    case "conditional-keys":
    case "nut13-plan":
    case "nut09-request":
    case "nut09-response":
    case "proof-verification":
    case "atomic-admission":
    case "keyset-completed":
    case "keyset-skipped":
    case "expired-keyset-retention":
    case "recovery-completed":
    case "recovery-failed-closed":
      return value;
    default:
      throw new Error("conditional recovery session transition is invalid");
  }
}

export function validateConditionalRecoverySessionState(input: {
  readonly sequence: number;
  readonly predecessorDigest: string | null;
  readonly transition: ConditionalRecoverySessionTransition;
  readonly evidenceDigest: string;
  readonly budget: ConditionalRecoveryBudget;
  readonly nut07AuditBytes: number;
  readonly catalogueDigest: string;
  readonly completedKeysetProofCount: number;
  readonly catalogueOrdinal: number | null;
  readonly activeKeysetId: string | null;
  readonly keysetMetadataDigest: string | null;
  readonly keysDigest: string | null;
  readonly scan: ConditionalRecoverySessionScan;
  readonly currentBatch: ConditionalRecoveryBatchBinding | null;
  readonly keysetTerminalEvidence: ConditionalRecoveryKeysetTerminalEvidence | null;
  readonly skipEvidence: ConditionalRecoverySkipEvidence | null;
  readonly terminalEvidence: ConditionalRecoveryTerminalEvidence | null;
}): void {
  const inputProofs = checkedAdd(
    input.completedKeysetProofCount,
    input.scan.totalReturnedProofs,
    "proof budget",
  );
  if (input.budget.proofCount !== inputProofs) {
    throw new Error("conditional recovery session proof budget is inconsistent");
  }
  requireBoundedCounter(
    input.nut07AuditBytes,
    CONDITIONAL_RECOVERY_MAX_NUT07_AUDIT_BYTES,
    "NUT-07 audit bytes",
  );
  requireDigest(input.evidenceDigest, "evidence");
  requireDigest(input.catalogueDigest, "catalogue");
  if (input.sequence === 0) {
    if (
      input.predecessorDigest !== null ||
      input.transition !== "completed-catalogue"
    ) {
      throw new Error("conditional recovery initial session is unreachable");
    }
  } else {
    requireDigest(input.predecessorDigest, "predecessor");
  }
  const inactive =
    input.transition === "completed-catalogue" ||
    input.transition === "keyset-completed" ||
    input.transition === "keyset-skipped" ||
    input.transition === "recovery-completed";
  if (inactive) {
    if (input.activeKeysetId !== null || input.keysetMetadataDigest !== null) {
      throw new Error(
        "conditional recovery inactive state retained an active keyset",
      );
    }
  } else if (
    input.transition === "recovery-failed-closed" &&
    input.activeKeysetId === null
  ) {
    if (input.keysetMetadataDigest !== null) {
      throw new Error(
        "conditional recovery failed-closed keyset evidence is inconsistent",
      );
    }
  } else {
    requireKeysetId(input.activeKeysetId, "active keyset");
    requireDigest(input.keysetMetadataDigest, "keyset metadata");
    requireNonNegativeSafeInteger(input.catalogueOrdinal, "catalogue ordinal");
  }
  if (input.activeKeysetId === null) {
    if (input.keysDigest !== null) {
      throw new Error("conditional recovery inactive state retained keys evidence");
    }
  } else {
    requireDigest(input.keysDigest, "keys evidence");
  }
  validateEvidenceShape(input);
}

export function computeConditionalRecoverySessionDigest(
  input: Omit<ConditionalRecoverySession, "digest">,
): string {
  return digest([
    "conditional-recovery-session-v2",
    input.schemaVersion,
    input.walletScope,
    input.sequence,
    input.predecessorDigest,
    input.transition,
    input.evidenceDigest,
    input.budget,
    input.nut07AuditBytes,
    input.catalogueDigest,
    input.completedKeysetProofCount,
    input.catalogueOrdinal,
    input.activeKeysetId,
    input.keysetMetadataDigest,
    input.keysDigest,
    input.scan,
    input.currentBatch,
    input.keysetTerminalEvidence,
    input.skipEvidence,
    input.terminalEvidence,
  ]);
}

export function encodeConditionalRecoverySession(
  session: ConditionalRecoverySession,
  authoritativeScope: ConditionalRecoveryWalletScope,
): Uint8Array {
  const canonicalScope = decodeAuthoritativeScope(authoritativeScope);
  assertScopeEqual(session.walletScope, canonicalScope);
  const expectedDigest = computeConditionalRecoverySessionDigest(session);
  if (session.digest !== expectedDigest) {
    throw new Error("conditional recovery session digest is invalid");
  }
  const bytes = encoder.encode(JSON.stringify(boundPayload(session)));
  if (bytes.byteLength > CONDITIONAL_RECOVERY_MAX_SESSION_BYTES) {
    throw new Error("conditional recovery session exceeded its encoded byte bound");
  }
  return bytes;
}

export function decodeConditionalRecoverySession(
  bytes: Uint8Array,
  authoritativeScope: ConditionalRecoveryWalletScope,
): ConditionalRecoverySession {
  const byteLength = actualByteLength(bytes);
  if (byteLength > CONDITIONAL_RECOVERY_MAX_SESSION_BYTES) {
    throw new Error("conditional recovery session exceeded its encoded byte bound");
  }
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new Error("conditional recovery session is not valid UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("conditional recovery session JSON is invalid");
  }
  const row = decodeBoundPayload(
    parsed,
    decodeAuthoritativeScope(authoritativeScope),
  );
  const canonical = JSON.stringify(boundPayload(row));
  if (canonical !== text) {
    throw new Error("conditional recovery session bytes are not canonical");
  }
  if (row.digest !== computeConditionalRecoverySessionDigest(row)) {
    throw new Error("conditional recovery session digest or scope is invalid");
  }
  return row;
}

export function validateConditionalRecoverySessionSuccessor(
  predecessor: ConditionalRecoverySession,
  successor: ConditionalRecoverySession,
): void {
  assertScopeEqual(predecessor.walletScope, successor.walletScope);
  if (successor.sequence !== predecessor.sequence + 1) {
    throw new Error("conditional recovery successor sequence is invalid");
  }
  if (successor.predecessorDigest !== predecessor.digest) {
    throw new Error("conditional recovery successor predecessor digest is invalid");
  }
  if (predecessor.digest !== computeConditionalRecoverySessionDigest(predecessor)) {
    throw new Error("conditional recovery predecessor digest is invalid");
  }
  if (successor.digest !== computeConditionalRecoverySessionDigest(successor)) {
    throw new Error("conditional recovery successor digest is invalid");
  }
  const allowed = allowedSuccessors(predecessor);
  if (!allowed.includes(successor.transition)) {
    throw new Error("conditional recovery successor edge is invalid");
  }
  validateEdgeFields(predecessor, successor);
}

function allowedSuccessors(
  predecessor: ConditionalRecoverySession,
): readonly ConditionalRecoverySessionTransition[] {
  if (
    predecessor.budget.transportBytes ===
      CONDITIONAL_RECOVERY_MAX_CATALOGUE_BYTES ||
    predecessor.budget.serializedBytes ===
      CONDITIONAL_RECOVERY_MAX_CATALOGUE_BYTES ||
    predecessor.budget.workUnits === CONDITIONAL_RECOVERY_MAX_WORK_UNITS ||
    predecessor.budget.proofCount === CONDITIONAL_RECOVERY_MAX_TOTAL_PROOFS ||
    predecessor.nut07AuditBytes ===
      CONDITIONAL_RECOVERY_MAX_NUT07_AUDIT_BYTES
  ) {
    return ["recovery-failed-closed"];
  }
  switch (predecessor.transition) {
    case "completed-catalogue":
    case "keyset-completed":
    case "keyset-skipped":
      return ["conditional-keys", "keyset-skipped", "recovery-completed"];
    case "conditional-keys":
      return ["nut13-plan", "keyset-skipped"];
    case "nut13-plan":
      return ["nut09-request", "keyset-skipped"];
    case "nut09-request":
      return ["nut09-response"];
    case "nut09-response":
      return predecessor.currentBatch?.returnedCount === 0
        ? ["nut13-plan", "keyset-completed", "keyset-skipped"]
        : ["proof-verification", "recovery-failed-closed"];
    case "proof-verification":
      return [
        "atomic-admission",
        "expired-keyset-retention",
        "recovery-failed-closed",
      ];
    case "atomic-admission":
      return ["nut13-plan"];
    case "expired-keyset-retention":
      return ["keyset-completed"];
    case "recovery-completed":
    case "recovery-failed-closed":
      throw new Error("conditional recovery terminal session has no successor");
    default:
      return assertNever(predecessor.transition);
  }
}

function validateEdgeFields(
  predecessor: ConditionalRecoverySession,
  successor: ConditionalRecoverySession,
): void {
  if (successor.catalogueDigest !== predecessor.catalogueDigest) {
    throw new Error(
      "conditional recovery immutable catalogue digest changed",
    );
  }
  if (successor.transition === "conditional-keys") {
    const expectedOrdinal =
      predecessor.catalogueOrdinal === null
        ? 0
        : predecessor.catalogueOrdinal + 1;
    if (successor.catalogueOrdinal !== expectedOrdinal) {
      throw new Error("conditional recovery catalogue ordinal is not strict");
    }
    const priorKeysetId =
      predecessor.keysetTerminalEvidence?.keysetId ??
      predecessor.skipEvidence?.keysetId ??
      null;
    if (successor.activeKeysetId === priorKeysetId) {
      throw new Error("conditional recovery keyset ordinal revisited a keyset");
    }
    if (
      successor.keysDigest === null ||
      successor.evidenceDigest !== successor.keysDigest
    ) {
      throw new Error(
        "conditional recovery exact keys entity binding is invalid",
      );
    }
    requireResetScan(successor.scan);
  } else if (successor.transition === "keyset-skipped") {
    const skip = successor.skipEvidence!;
    if (predecessor.activeKeysetId === null) {
      const expectedOrdinal =
        predecessor.catalogueOrdinal === null
          ? 0
          : predecessor.catalogueOrdinal + 1;
      if (
        skip.reason !== "freshly-proven-ineligible" ||
        successor.catalogueOrdinal !== expectedOrdinal
      ) {
        throw new Error(
          "conditional recovery freshly skipped catalogue ordinal is invalid",
        );
      }
      const priorKeysetId =
        predecessor.keysetTerminalEvidence?.keysetId ??
        predecessor.skipEvidence?.keysetId ??
        null;
      if (skip.keysetId === priorKeysetId) {
        throw new Error("conditional recovery skipped keyset was revisited");
      }
    } else {
      const expectedReason =
        predecessor.transition === "nut09-response"
          ? "expired-empty-response"
          : "expired-before-request";
      if (
        skip.reason !== expectedReason ||
        skip.keysetId !== predecessor.activeKeysetId ||
        successor.catalogueOrdinal !== predecessor.catalogueOrdinal
      ) {
        throw new Error(
          "conditional recovery active keyset skip evidence is invalid",
        );
      }
    }
    requireResetScan(successor.scan);
  } else if (successor.transition !== "recovery-completed") {
    if (successor.catalogueOrdinal !== predecessor.catalogueOrdinal) {
      throw new Error(
        "conditional recovery same-keyset edge changed catalogue ordinal",
      );
    }
  }
  if (
    predecessor.activeKeysetId !== null &&
    !["keyset-completed", "keyset-skipped", "recovery-completed"].includes(successor.transition) &&
    successor.activeKeysetId !== predecessor.activeKeysetId
  ) {
    throw new Error("conditional recovery same-keyset edge changed keyset");
  }
  if (
    predecessor.activeKeysetId !== null &&
    !["keyset-completed", "keyset-skipped", "recovery-completed"].includes(
      successor.transition,
    ) &&
    (successor.keysetMetadataDigest !== predecessor.keysetMetadataDigest ||
      successor.keysDigest !== predecessor.keysDigest)
  ) {
    throw new Error(
      "conditional recovery same-keyset immutable metadata or keys binding changed",
    );
  }
  if (predecessor.currentBatch !== null && successor.currentBatch !== null) {
    if (successor.transition !== "nut13-plan" && successor.currentBatch.planDigest !== predecessor.currentBatch.planDigest) {
      throw new Error("conditional recovery deterministic plan binding changed");
    }
    if (
      successor.transition !== "nut13-plan" &&
      (successor.currentBatch.planStart !==
        predecessor.currentBatch.planStart ||
        successor.currentBatch.planCount !==
          predecessor.currentBatch.planCount)
    ) {
      throw new Error(
        "conditional recovery deterministic plan range binding changed",
      );
    }
    if (
      !["nut13-plan", "nut09-request"].includes(successor.transition) &&
      successor.currentBatch.requestDigest !== predecessor.currentBatch.requestDigest
    ) {
      throw new Error("conditional recovery deterministic request binding changed");
    }
    if (
      ["proof-verification", "atomic-admission", "expired-keyset-retention"].includes(successor.transition) &&
      (successor.currentBatch.batchDigest !== predecessor.currentBatch.batchDigest ||
        successor.currentBatch.stagedBatchId !== predecessor.currentBatch.stagedBatchId)
    ) {
      throw new Error("conditional recovery staged batch binding changed");
    }
  }
  if (successor.transition === "keyset-completed") {
    if (predecessor.transition === "nut09-response") {
      if (predecessor.currentBatch?.returnedCount !== 0) {
        throw new Error(
          "conditional recovery proof-bearing batch cannot satisfy the gap limit",
        );
      }
      const evidence = successor.keysetTerminalEvidence;
      if (
        evidence?.kind !== "gap-limit" ||
        evidence.keysetId !== predecessor.activeKeysetId ||
        predecessor.scan.consecutiveEmptyOutputs !== evidence.gapLimit
      ) {
        throw new Error("conditional recovery gap-limit evidence is invalid");
      }
    } else if (predecessor.transition === "expired-keyset-retention") {
      const evidence = successor.keysetTerminalEvidence;
      if (
        evidence?.kind !== "expired-retention" ||
        evidence.keysetId !== predecessor.activeKeysetId ||
        evidence.stagedBatchId !== predecessor.currentBatch?.stagedBatchId
      ) {
        throw new Error(
          "conditional recovery expired-keyset retention evidence is invalid",
        );
      }
    }
    if (successor.completedKeysetProofCount !== predecessor.budget.proofCount) {
      throw new Error(
        "conditional recovery completed-keyset proof baseline is invalid",
      );
    }
  } else if (
    successor.transition === "keyset-skipped" &&
    predecessor.activeKeysetId !== null
  ) {
    if (successor.completedKeysetProofCount !== predecessor.budget.proofCount) {
      throw new Error(
        "conditional recovery skipped-keyset proof baseline is invalid",
      );
    }
  } else if (
    successor.completedKeysetProofCount !== predecessor.completedKeysetProofCount
  ) {
    throw new Error(
      "conditional recovery completed-keyset proof baseline changed early",
    );
  }
  if (
    successor.transition === "nut13-plan" &&
    (successor.currentBatch?.planStart !== successor.scan.plannedStart ||
      successor.currentBatch.planCount !== successor.scan.plannedCount)
  ) {
    throw new Error(
      "conditional recovery deterministic plan range binding is inconsistent",
    );
  }
  if (successor.transition === "nut13-plan" && successor.currentBatch?.requestDigest !== null) {
    throw new Error("conditional recovery plan retained a request binding");
  }
  if (successor.transition === "nut09-request" && successor.currentBatch?.requestDigest === null) {
    throw new Error("conditional recovery request binding is missing");
  }
  if (successor.transition === "nut09-response") {
    if (
      successor.currentBatch?.returnedCount !==
      successor.scan.totalReturnedProofs -
        predecessor.scan.totalReturnedProofs
    ) {
      // The current response count is persisted independently. The cumulative delta is exact.
      throw new Error("conditional recovery current batch returned count is inconsistent");
    }
    if (successor.currentBatch.returnedCount! > 0 && successor.currentBatch.stagedBatchId === null) {
      throw new Error("conditional recovery proof-bearing response is not staged");
    }
  }
}

function validateEvidenceShape(
  input: Parameters<typeof validateConditionalRecoverySessionState>[0],
): void {
  const terminal =
    input.transition === "recovery-completed" ||
    input.transition === "recovery-failed-closed";
  if (terminal !== (input.terminalEvidence !== null)) {
    throw new Error("conditional recovery terminal evidence is invalid");
  }
  if (input.transition === "keyset-skipped" !== (input.skipEvidence !== null)) {
    throw new Error("conditional recovery skip evidence is invalid");
  }
  if (input.skipEvidence !== null) {
    requireNonNegativeSafeInteger(
      input.skipEvidence.catalogueOrdinal,
      "skip ordinal",
    );
    requireKeysetId(input.skipEvidence.keysetId, "skipped keyset");
    requireDigest(input.skipEvidence.authorityDigest, "skip authority");
    if (input.skipEvidence.catalogueOrdinal !== input.catalogueOrdinal) {
      throw new Error("conditional recovery skip evidence ordinal is invalid");
    }
  }
  if (input.keysetTerminalEvidence !== null) {
    requireKeysetId(input.keysetTerminalEvidence.keysetId, "terminal keyset");
    requireDigest(
      input.keysetTerminalEvidence.digest,
      "keyset terminal evidence",
    );
    switch (input.keysetTerminalEvidence.kind) {
      case "gap-limit":
        requirePositiveSafeInteger(
          input.keysetTerminalEvidence.gapLimit,
          "gap limit",
        );
        break;
      case "expired-retention":
        requireBoundedString(
          input.keysetTerminalEvidence.stagedBatchId,
          256,
          "retained staged batch id",
        );
        break;
      default:
        assertNever(input.keysetTerminalEvidence);
    }
  }
  if (
    (input.transition === "keyset-completed") !==
    (input.keysetTerminalEvidence !== null)
  ) {
    throw new Error("conditional recovery keyset terminal evidence is invalid");
  }
  if (input.currentBatch !== null) validateBatchBinding(input.currentBatch);
  const needsBatch = [
    "nut13-plan",
    "nut09-request",
    "nut09-response",
    "proof-verification",
    "atomic-admission",
    "expired-keyset-retention",
  ].includes(input.transition);
  if (
    input.transition === "recovery-failed-closed" &&
    input.currentBatch !== null
  ) {
    return;
  }
  if (needsBatch !== (input.currentBatch !== null)) {
    throw new Error(
      "conditional recovery deterministic batch binding is invalid",
    );
  }
}

function validateBatchBinding(binding: ConditionalRecoveryBatchBinding): void {
  requireDigest(binding.planDigest, "plan binding");
  requireNonNegativeSafeInteger(binding.planStart, "plan start binding");
  requirePositiveSafeInteger(binding.planCount, "plan count binding");
  if (binding.requestDigest !== null) requireDigest(binding.requestDigest, "request binding");
  if (binding.batchDigest !== null) requireDigest(binding.batchDigest, "batch binding");
  if (binding.stagedBatchId !== null && (typeof binding.stagedBatchId !== "string" || encoder.encode(binding.stagedBatchId).byteLength > 256 || binding.stagedBatchId.length === 0)) {
    throw new Error("conditional recovery staged batch id is invalid");
  }
  if (binding.returnedCount !== null) requireNonNegativeSafeInteger(binding.returnedCount, "batch returned count");
}

function boundPayload(session: ConditionalRecoverySession): Record<string, unknown> {
  return {
    schemaVersion: session.schemaVersion,
    sequence: session.sequence,
    predecessorDigest: session.predecessorDigest,
    transition: session.transition,
    evidenceDigest: session.evidenceDigest,
    budget: session.budget,
    nut07AuditBytes: session.nut07AuditBytes,
    catalogueDigest: session.catalogueDigest,
    completedKeysetProofCount: session.completedKeysetProofCount,
    catalogueOrdinal: session.catalogueOrdinal,
    activeKeysetId: session.activeKeysetId,
    keysetMetadataDigest: session.keysetMetadataDigest,
    keysDigest: session.keysDigest,
    scan: session.scan,
    currentBatch: session.currentBatch,
    keysetTerminalEvidence: session.keysetTerminalEvidence,
    skipEvidence: session.skipEvidence,
    terminalEvidence: session.terminalEvidence,
    digest: session.digest,
  };
}

function decodeBoundPayload(
  value: unknown,
  walletScope: ConditionalRecoveryWalletScope,
): ConditionalRecoverySession {
  const row = requireObject(value, "conditional recovery session");
  requireExactKeys(row, Object.keys(boundPayload({} as ConditionalRecoverySession)), "conditional recovery session");
  if (row.schemaVersion !== CONDITIONAL_RECOVERY_SESSION_SCHEMA_VERSION) {
    throw new Error("conditional recovery session schema version is unsupported");
  }
  const session = Object.freeze({
    schemaVersion: CONDITIONAL_RECOVERY_SESSION_SCHEMA_VERSION,
    walletScope: Object.freeze({ ...walletScope }),
    sequence: requireNonNegativeSafeInteger(row.sequence, "sequence"),
    predecessorDigest: row.predecessorDigest === null ? null : requireDigest(row.predecessorDigest, "predecessor"),
    transition: decodeConditionalRecoverySessionTransition(row.transition),
    evidenceDigest: requireDigest(row.evidenceDigest, "evidence"),
    budget: decodeBudget(row.budget),
    nut07AuditBytes: requireBoundedCounter(
      row.nut07AuditBytes,
      CONDITIONAL_RECOVERY_MAX_NUT07_AUDIT_BYTES,
      "NUT-07 audit bytes",
    ),
    catalogueDigest: requireDigest(row.catalogueDigest, "catalogue"),
    completedKeysetProofCount: requireNonNegativeSafeInteger(row.completedKeysetProofCount, "completed proof baseline"),
    catalogueOrdinal: row.catalogueOrdinal === null ? null : requireNonNegativeSafeInteger(row.catalogueOrdinal, "catalogue ordinal"),
    activeKeysetId: row.activeKeysetId === null ? null : requireKeysetId(row.activeKeysetId, "active keyset"),
    keysetMetadataDigest: row.keysetMetadataDigest === null ? null : requireDigest(row.keysetMetadataDigest, "keyset metadata"),
    keysDigest:
      row.keysDigest === null ? null : requireDigest(row.keysDigest, "keys evidence"),
    scan: decodeConditionalRecoveryScan(row.scan, { maxBatchSize: 100, maxTotalOutputs: 100_000 }),
    currentBatch: decodeBatchBinding(row.currentBatch),
    keysetTerminalEvidence: decodeKeysetTerminalEvidence(row.keysetTerminalEvidence),
    skipEvidence: decodeSkipEvidence(row.skipEvidence),
    terminalEvidence: decodeTerminalEvidence(row.terminalEvidence),
    digest: requireDigest(row.digest, "digest"),
  });
  validateConditionalRecoverySessionState(session);
  return session;
}

function decodeBudget(value: unknown): ConditionalRecoveryBudget {
  const row = requireObject(value, "conditional recovery budget");
  requireExactKeys(row, ["transportBytes", "serializedBytes", "workUnits", "proofCount"], "conditional recovery budget");
  return Object.freeze({
    transportBytes: requireNonNegativeSafeInteger(row.transportBytes, "transport bytes"),
    serializedBytes: requireNonNegativeSafeInteger(row.serializedBytes, "serialized bytes"),
    workUnits: requireNonNegativeSafeInteger(row.workUnits, "work units"),
    proofCount: requireNonNegativeSafeInteger(row.proofCount, "proof count"),
  });
}

function decodeBatchBinding(value: unknown): ConditionalRecoveryBatchBinding | null {
  if (value === null) return null;
  const row = requireObject(value, "conditional recovery batch binding");
  requireExactKeys(row, ["planDigest", "planStart", "planCount", "requestDigest", "batchDigest", "stagedBatchId", "returnedCount"], "conditional recovery batch binding");
  const result = Object.freeze({
    planDigest: requireDigest(row.planDigest, "plan binding"),
    planStart: requireNonNegativeSafeInteger(row.planStart, "plan start binding"),
    planCount: requirePositiveSafeInteger(row.planCount, "plan count binding"),
    requestDigest: row.requestDigest === null ? null : requireDigest(row.requestDigest, "request binding"),
    batchDigest: row.batchDigest === null ? null : requireDigest(row.batchDigest, "batch binding"),
    stagedBatchId: row.stagedBatchId === null ? null : requireBoundedString(row.stagedBatchId, 256, "staged batch id"),
    returnedCount: row.returnedCount === null ? null : requireNonNegativeSafeInteger(row.returnedCount, "batch returned count"),
  });
  validateBatchBinding(result);
  return result;
}

function decodeKeysetTerminalEvidence(value: unknown): ConditionalRecoveryKeysetTerminalEvidence | null {
  if (value === null) return null;
  const row = requireObject(value, "conditional recovery keyset terminal evidence");
  switch (row.kind) {
    case "gap-limit":
      requireExactKeys(row, ["kind", "keysetId", "gapLimit", "digest"], "conditional recovery keyset terminal evidence");
      return Object.freeze({
        kind: row.kind,
        keysetId: requireKeysetId(row.keysetId, "terminal keyset"),
        gapLimit: requirePositiveSafeInteger(row.gapLimit, "gap limit"),
        digest: requireDigest(row.digest, "gap evidence"),
      });
    case "expired-retention":
      requireExactKeys(row, ["kind", "keysetId", "stagedBatchId", "digest"], "conditional recovery keyset terminal evidence");
      return Object.freeze({
        kind: row.kind,
        keysetId: requireKeysetId(row.keysetId, "terminal keyset"),
        stagedBatchId: requireBoundedString(row.stagedBatchId, 256, "retained staged batch id"),
        digest: requireDigest(row.digest, "retention evidence"),
      });
    default:
      throw new Error("conditional recovery keyset terminal evidence kind is invalid");
  }
}

function decodeSkipEvidence(value: unknown): ConditionalRecoverySkipEvidence | null {
  if (value === null) return null;
  const row = requireObject(value, "conditional recovery skip evidence");
  requireExactKeys(row, ["catalogueOrdinal", "keysetId", "reason", "authorityDigest"], "conditional recovery skip evidence");
  switch (row.reason) {
    case "freshly-proven-ineligible":
    case "expired-before-request":
    case "expired-empty-response":
      break;
    default:
      throw new Error("conditional recovery skip evidence reason is invalid");
  }
  return Object.freeze({
    catalogueOrdinal: requireNonNegativeSafeInteger(row.catalogueOrdinal, "skip ordinal"),
    keysetId: requireKeysetId(row.keysetId, "skipped keyset"),
    reason: row.reason,
    authorityDigest: requireDigest(row.authorityDigest, "skip authority"),
  });
}

function decodeTerminalEvidence(value: unknown): ConditionalRecoveryTerminalEvidence | null {
  if (value === null) return null;
  const row = requireObject(value, "conditional recovery terminal evidence");
  switch (row.kind) {
    case "completed":
      requireExactKeys(row, ["kind", "catalogueLength", "digest"], "conditional recovery terminal evidence");
      return Object.freeze({ kind: row.kind, catalogueLength: requireNonNegativeSafeInteger(row.catalogueLength, "catalogue length"), digest: requireDigest(row.digest, "terminal digest") });
    case "failed-closed":
      requireExactKeys(row, ["kind", "reasonDigest"], "conditional recovery terminal evidence");
      return Object.freeze({ kind: row.kind, reasonDigest: requireDigest(row.reasonDigest, "failed-closed reason") });
    default:
      throw new Error("conditional recovery terminal evidence kind is invalid");
  }
}

function requireResetScan(scan: ConditionalRecoverySessionScan): void {
  if (scan.nextCounter !== scan.startCounter || scan.plannedStart !== null || scan.plannedCount !== 0 || scan.totalRequestedOutputs !== 0 || scan.totalReturnedProofs !== 0 || scan.consecutiveEmptyOutputs !== 0) {
    throw new Error("conditional recovery next keyset scan was not reset");
  }
}

function decodeAuthoritativeScope(
  value: unknown,
): ConditionalRecoveryWalletScope {
  const scope = requireObject(
    value,
    "conditional recovery authoritative wallet scope",
  );
  requireExactKeys(
    scope,
    ["schemaVersion", "scopeId", "mintUrl", "unit"],
    "conditional recovery authoritative wallet scope",
  );
  if (scope.schemaVersion !== 1) {
    throw new Error(
      "conditional recovery authoritative wallet scope schema is unsupported",
    );
  }
  const scopeId = decodeDurableCustodyScopeId(scope.scopeId);
  if (!scopeId.startsWith("custody:wallet:")) {
    throw new Error(
      "conditional recovery authoritative scope is not a wallet scope",
    );
  }
  const mintUrl = normalizeDurableWalletMintUrl(scope.mintUrl);
  const unit = requireBoundedString(scope.unit, 64, "wallet unit");
  if (mintUrl !== scope.mintUrl) {
    throw new Error(
      "conditional recovery authoritative mint scope is not canonical",
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    scopeId,
    mintUrl,
    unit,
  });
}

function assertScopeEqual(left: ConditionalRecoveryWalletScope, right: ConditionalRecoveryWalletScope): void {
  if (left.schemaVersion !== right.schemaVersion || left.scopeId !== right.scopeId || left.mintUrl !== right.mintUrl || left.unit !== right.unit) {
    throw new Error("conditional recovery authoritative wallet scope mismatch");
  }
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !expected.has(key)) || keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new Error(`${label} has invalid fields`);
  }
}

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`conditional recovery session ${label} is invalid`);
  return value as number;
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  const result = requireNonNegativeSafeInteger(value, label);
  if (result === 0) throw new Error(`conditional recovery session ${label} is invalid`);
  return result;
}

function requireBoundedCounter(value: unknown, maximum: number, label: string): number {
  const counter = requireNonNegativeSafeInteger(value, label);
  if (counter > maximum) throw new Error(`conditional recovery session ${label} exceeded its bound`);
  return counter;
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !HEX_32.test(value)) throw new Error(`conditional recovery session ${label} digest is invalid`);
  return value;
}

function requireKeysetId(value: unknown, label: string): string {
  if (typeof value !== "string" || !V2_KEYSET_ID.test(value)) throw new Error(`conditional recovery session ${label} id is invalid`);
  return value;
}

function requireBoundedString(value: unknown, maximumBytes: number, label: string): string {
  if (typeof value !== "string" || value.length === 0 || encoder.encode(value).byteLength > maximumBytes) throw new Error(`conditional recovery session ${label} is invalid`);
  return value;
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error(`conditional recovery session ${label} overflowed`);
  return result;
}

function digest(value: unknown): string {
  return bytesToHex(sha256(encoder.encode(JSON.stringify(value))));
}

function actualByteLength(value: Uint8Array): number {
  if (!(value instanceof Uint8Array)) throw new Error("conditional recovery session bytes are invalid");
  return value.byteLength;
}

function assertNever(value: never): never {
  throw new Error(`conditional recovery session transition is unhandled: ${String(value)}`);
}
