import {
  advanceSeedScanCursor,
  classifySeedRecoveryMintState,
} from "./seedRecoveryCore.ts";

export const EMERGENCY_SEED_RECOVERY_SCHEMA_VERSION = 1 as const;
export const EMERGENCY_SEED_RECOVERY_BATCH_SIZE = 300 as const;
export const EMERGENCY_SEED_RECOVERY_GAP_LIMIT = 300 as const;

export interface EmergencySeedRecoveryCursor {
  schemaVersion: typeof EMERGENCY_SEED_RECOVERY_SCHEMA_VERSION;
  recoveryId: string;
  mintUrl: string;
  unit: string;
  keysetId: string;
  nextCounter: number;
  trailingEmptyCounters: number;
  revision: number;
  state: "active" | "completed";
}

export interface EmergencySeedRecoveryBatchObservation {
  startCounter: number;
  requestedCount: number;
  lastCounterWithSignature: number | null;
}

export type EmergencySeedRecoveryProofDisposition =
  | "import-selectable"
  | "retain-nonselectable"
  | "ignore-spent"
  | "fail-closed";

export function createEmergencySeedRecoveryCursor(input: {
  recoveryId: string;
  mintUrl: string;
  unit: string;
  keysetId: string;
}): EmergencySeedRecoveryCursor {
  return validateEmergencySeedRecoveryCursor({
    schemaVersion: EMERGENCY_SEED_RECOVERY_SCHEMA_VERSION,
    ...input,
    nextCounter: 0,
    trailingEmptyCounters: 0,
    revision: 0,
    state: "active",
  });
}

export function advanceEmergencySeedRecoveryCursor(
  input: EmergencySeedRecoveryCursor,
  observation: EmergencySeedRecoveryBatchObservation,
): EmergencySeedRecoveryCursor {
  const cursor = validateEmergencySeedRecoveryCursor(input);
  if (cursor.state !== "active") {
    throw new Error("emergency seed recovery cursor is already completed");
  }
  if (observation.startCounter !== cursor.nextCounter) {
    throw new Error("emergency seed recovery observation has a stale counter");
  }
  if (
    !Number.isSafeInteger(observation.requestedCount) ||
    observation.requestedCount < 1 ||
    observation.requestedCount > EMERGENCY_SEED_RECOVERY_BATCH_SIZE
  ) {
    throw new Error("emergency seed recovery batch size is invalid");
  }
  const lastCounterWithSignature = observation.lastCounterWithSignature;
  const advanced = advanceSeedScanCursor(
    {
      nextCounter: cursor.nextCounter,
      consecutiveEmptyOutputs: cursor.trailingEmptyCounters,
    },
    {
      startCounter: observation.startCounter,
      requestedCount: observation.requestedCount,
      returnedCounterOffsets:
        lastCounterWithSignature === null
          ? []
          : [lastCounterWithSignature - observation.startCounter],
    },
    EMERGENCY_SEED_RECOVERY_BATCH_SIZE,
  );
  const trailingEmptyCounters = advanced.consecutiveEmptyOutputs;
  return {
    ...cursor,
    nextCounter: advanced.nextCounter,
    trailingEmptyCounters,
    revision: cursor.revision + 1,
    state:
      trailingEmptyCounters >= EMERGENCY_SEED_RECOVERY_GAP_LIMIT
        ? "completed"
        : "active",
  };
}

export function classifyEmergencySeedRecoveryProof(
  mintState: "UNSPENT" | "SPENT" | "PENDING" | "UNKNOWN",
): EmergencySeedRecoveryProofDisposition {
  switch (classifySeedRecoveryMintState(mintState)) {
    case "selectable":
      return "import-selectable";
    case "spent":
      return "ignore-spent";
    case "retain-nonselectable":
      return "retain-nonselectable";
    case "fail-closed":
      return "fail-closed";
  }
}

export function validateEmergencySeedRecoveryCursor(
  value: EmergencySeedRecoveryCursor,
): EmergencySeedRecoveryCursor {
  if (value.schemaVersion !== EMERGENCY_SEED_RECOVERY_SCHEMA_VERSION) {
    throw new Error("emergency seed recovery schema is unsupported");
  }
  requireIdentifier(value.recoveryId, "recovery id");
  requireIdentifier(value.mintUrl, "mint URL");
  requireIdentifier(value.unit, "mint unit");
  requireIdentifier(value.keysetId, "keyset id");
  requireNonNegativeInteger(value.nextCounter, "next counter");
  requireNonNegativeInteger(
    value.trailingEmptyCounters,
    "trailing empty counter count",
  );
  requireNonNegativeInteger(value.revision, "cursor revision");
  if (value.state !== "active" && value.state !== "completed") {
    throw new Error("emergency seed recovery state is invalid");
  }
  const shouldBeCompleted =
    value.trailingEmptyCounters >= EMERGENCY_SEED_RECOVERY_GAP_LIMIT;
  if ((value.state === "completed") !== shouldBeCompleted) {
    throw new Error("emergency seed recovery completion state is inconsistent");
  }
  return { ...value };
}

function requireIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`emergency seed recovery ${label} is invalid`);
  }
}

function requireNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`emergency seed recovery ${label} is invalid`);
  }
}
