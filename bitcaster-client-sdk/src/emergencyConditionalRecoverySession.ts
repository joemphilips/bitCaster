import { validateSeedScanState } from "./seedRecoveryCore.ts";

export const CONDITIONAL_RECOVERY_SESSION_SCHEMA_VERSION = 1 as const;

export type ConditionalRecoverySessionTransition =
  | "completed-catalogue"
  | "conditional-keys"
  | "nut13-plan"
  | "nut09-request"
  | "nut09-response"
  | "proof-verification"
  | "nut07-classification"
  | "atomic-admission";

export interface ConditionalRecoverySessionScan {
  readonly startCounter: number;
  readonly nextCounter: number;
  readonly plannedStart: number | null;
  readonly plannedCount: number;
  readonly totalRequestedOutputs: number;
  readonly totalReturnedProofs: number;
  readonly consecutiveEmptyOutputs: number;
}

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
    startCounter: requireNonNegativeSafeInteger(
      scan.startCounter,
      "start counter",
    ),
    nextCounter: requireNonNegativeSafeInteger(
      scan.nextCounter,
      "next counter",
    ),
    plannedStart:
      scan.plannedStart === null
        ? null
        : requireNonNegativeSafeInteger(scan.plannedStart, "planned start"),
    plannedCount: requireBoundedCounter(
      scan.plannedCount,
      limits.maxBatchSize,
      "planned count",
    ),
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
    case "nut07-classification":
    case "atomic-admission":
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
  readonly proofCount: number;
  readonly scan: ConditionalRecoverySessionScan;
}): void {
  if (input.proofCount !== input.scan.totalReturnedProofs) {
    throw new Error(
      "conditional recovery session proof budget is inconsistent",
    );
  }
  switch (input.transition) {
    case "completed-catalogue":
      requireInitialStage(input, "completed catalogue");
      return;
    case "conditional-keys":
      requireSuccessorStage(input, "conditional keys", 1, true);
      requireInitialScan(input.scan, "conditional keys");
      requireNoProofs(input, "conditional keys");
      return;
    case "nut13-plan":
      requireSuccessorStage(input, "NUT-13 plan", 2);
      requirePlannedScan(input.scan, "NUT-13 plan");
      return;
    case "nut09-request":
      requireSuccessorStage(input, "NUT-09 request", 3);
      requirePlannedScan(input.scan, "NUT-09 request");
      return;
    case "nut09-response":
      requireSuccessorStage(input, "NUT-09 response", 4);
      requireCompletedScan(input.scan, "NUT-09 response");
      return;
    case "proof-verification":
      requireSuccessorStage(input, "proof verification", 5);
      requireProofBearingCompletedScan(input, "proof verification");
      return;
    case "nut07-classification":
      requireSuccessorStage(input, "NUT-07 classification", 6);
      requireProofBearingCompletedScan(input, "NUT-07 classification");
      return;
    case "atomic-admission":
      requireSuccessorStage(input, "atomic admission", 7);
      requireProofBearingCompletedScan(input, "atomic admission");
      return;
    default:
      return assertNever(input.transition);
  }
}

function requireInitialStage(
  input: Parameters<typeof validateConditionalRecoverySessionState>[0],
  label: string,
): void {
  if (input.sequence !== 0 || input.predecessorDigest !== null) {
    throw new Error(`conditional recovery ${label} sequence is unreachable`);
  }
  requireEvidenceDigest(input.evidenceDigest, label);
  requireInitialScan(input.scan, label);
  requireNoProofs(input, label);
}

function requireSuccessorStage(
  input: Parameters<typeof validateConditionalRecoverySessionState>[0],
  label: string,
  minimumSequence: number,
  exactSequence = false,
): void {
  if (input.predecessorDigest === null) {
    throw new Error(
      `conditional recovery ${label} predecessor evidence is missing`,
    );
  }
  if (
    exactSequence
      ? input.sequence !== minimumSequence
      : input.sequence < minimumSequence
  ) {
    throw new Error(`conditional recovery ${label} sequence is unreachable`);
  }
  requireEvidenceDigest(input.predecessorDigest, `${label} predecessor`);
  requireEvidenceDigest(input.evidenceDigest, label);
}

function requireInitialScan(
  scan: ConditionalRecoverySessionScan,
  label: string,
): void {
  requireNoPlannedScan(scan, label);
  if (
    scan.nextCounter !== scan.startCounter ||
    scan.totalRequestedOutputs !== 0 ||
    scan.totalReturnedProofs !== 0 ||
    scan.consecutiveEmptyOutputs !== 0
  ) {
    throw new Error(`conditional recovery ${label} scan is unreachable`);
  }
}

function requirePlannedScan(
  scan: ConditionalRecoverySessionScan,
  label: string,
): void {
  if (
    scan.plannedStart === null ||
    scan.plannedCount < 1 ||
    scan.plannedStart !== scan.nextCounter
  ) {
    throw new Error(
      `conditional recovery ${label} planned scan is unreachable`,
    );
  }
}

function requireCompletedScan(
  scan: ConditionalRecoverySessionScan,
  label: string,
): void {
  requireNoPlannedScan(scan, label);
  if (scan.totalRequestedOutputs < 1) {
    throw new Error(`conditional recovery ${label} scan is unreachable`);
  }
}

function requireProofBearingCompletedScan(
  input: Parameters<typeof validateConditionalRecoverySessionState>[0],
  label: string,
): void {
  requireCompletedScan(input.scan, label);
  if (input.proofCount < 1) {
    throw new Error(`conditional recovery ${label} proof state is unreachable`);
  }
}

function requireNoPlannedScan(
  scan: ConditionalRecoverySessionScan,
  label: string,
): void {
  if (scan.plannedStart !== null || scan.plannedCount !== 0) {
    throw new Error(
      `conditional recovery ${label} planned scan is unreachable`,
    );
  }
}

function requireNoProofs(
  input: Parameters<typeof validateConditionalRecoverySessionState>[0],
  label: string,
): void {
  if (input.proofCount !== 0) {
    throw new Error(`conditional recovery ${label} proof state is unreachable`);
  }
}

function requireEvidenceDigest(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`conditional recovery ${label} evidence is invalid`);
  }
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const expected = new Set(keys);
  if (
    Object.keys(value).some((key) => !expected.has(key)) ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new Error(`${label} has invalid fields`);
  }
}

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`conditional recovery session ${label} is invalid`);
  }
  return value as number;
}

function requireBoundedCounter(
  value: unknown,
  maximum: number,
  label: string,
): number {
  const counter = requireNonNegativeSafeInteger(value, label);
  if (counter > maximum) {
    throw new Error(`conditional recovery session ${label} exceeded its bound`);
  }
  return counter;
}

function assertNever(value: never): never {
  throw new Error(
    `conditional recovery session transition is unhandled: ${String(value)}`,
  );
}
