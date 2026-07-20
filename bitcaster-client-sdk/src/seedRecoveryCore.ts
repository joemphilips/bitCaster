export type SeedRecoveryMintState = "UNSPENT" | "PENDING" | "SPENT" | "UNKNOWN";

export type SeedRecoveryDisposition =
  | "selectable"
  | "retain-nonselectable"
  | "spent"
  | "fail-closed";

export interface SeedScanState {
  readonly startCounter: number;
  readonly nextCounter: number;
  readonly totalRequestedOutputs: number;
  readonly totalReturnedProofs: number;
  readonly consecutiveEmptyOutputs: number;
}

export interface SeedScanCursor {
  readonly nextCounter: number;
  readonly consecutiveEmptyOutputs: number;
}

export function advanceSeedScanCursor(
  current: SeedScanCursor,
  observation: {
    readonly startCounter: number;
    readonly requestedCount: number;
    readonly returnedCounterOffsets: readonly number[];
  },
  maxBatchSize: number,
): SeedScanCursor {
  requireNonNegativeSafeInteger(current.nextCounter, "next counter");
  requireNonNegativeSafeInteger(
    current.consecutiveEmptyOutputs,
    "empty output count",
  );
  requirePositiveSafeInteger(maxBatchSize, "maximum batch size");
  if (observation.startCounter !== current.nextCounter) {
    throw new Error("seed recovery observation has a stale counter");
  }
  if (
    !Number.isSafeInteger(observation.requestedCount) ||
    observation.requestedCount < 1 ||
    observation.requestedCount > maxBatchSize
  ) {
    throw new Error("seed recovery batch size is invalid");
  }
  const nextCounter = checkedAdd(
    observation.startCounter,
    observation.requestedCount,
    "counter",
  );
  const seenOffsets = new Set<number>();
  let highestReturnedOffset = -1;
  for (const offset of observation.returnedCounterOffsets) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset >= observation.requestedCount ||
      seenOffsets.has(offset)
    ) {
      throw new Error("seed recovery returned counter offset is invalid");
    }
    seenOffsets.add(offset);
    highestReturnedOffset = Math.max(highestReturnedOffset, offset);
  }
  return {
    nextCounter,
    consecutiveEmptyOutputs:
      highestReturnedOffset < 0
        ? checkedAdd(
            current.consecutiveEmptyOutputs,
            observation.requestedCount,
            "empty output count",
          )
        : observation.requestedCount - highestReturnedOffset - 1,
  };
}

export function advanceSeedScan(
  current: SeedScanState,
  observation: {
    readonly startCounter: number;
    readonly requestedCount: number;
    readonly returnedCounterOffsets: readonly number[];
  },
  limits: { readonly maxBatchSize: number; readonly maxTotalOutputs: number },
): SeedScanState {
  validateSeedScanState(current, limits.maxTotalOutputs);
  requirePositiveSafeInteger(limits.maxBatchSize, "maximum batch size");
  requirePositiveSafeInteger(limits.maxTotalOutputs, "maximum total outputs");
  const cursor = advanceSeedScanCursor(
    current,
    observation,
    limits.maxBatchSize,
  );
  const totalRequestedOutputs = checkedAdd(
    current.totalRequestedOutputs,
    observation.requestedCount,
    "requested output count",
  );
  if (totalRequestedOutputs > limits.maxTotalOutputs) {
    throw new Error("seed recovery total output bound exceeded");
  }
  const totalReturnedProofs = checkedAdd(
    current.totalReturnedProofs,
    observation.returnedCounterOffsets.length,
    "returned proof count",
  );
  const next = {
    startCounter: current.startCounter,
    nextCounter: cursor.nextCounter,
    totalRequestedOutputs,
    totalReturnedProofs,
    consecutiveEmptyOutputs: cursor.consecutiveEmptyOutputs,
  };
  validateSeedScanState(next, limits.maxTotalOutputs);
  return next;
}

export function validateSeedScanState(
  value: SeedScanState,
  maxTotalOutputs: number,
): SeedScanState {
  requireNonNegativeSafeInteger(value.startCounter, "start counter");
  requireNonNegativeSafeInteger(value.nextCounter, "next counter");
  requireNonNegativeSafeInteger(
    value.totalRequestedOutputs,
    "requested output count",
  );
  requireNonNegativeSafeInteger(
    value.totalReturnedProofs,
    "returned proof count",
  );
  requireNonNegativeSafeInteger(
    value.consecutiveEmptyOutputs,
    "empty output count",
  );
  if (
    value.totalRequestedOutputs > maxTotalOutputs ||
    value.totalReturnedProofs > value.totalRequestedOutputs ||
    value.consecutiveEmptyOutputs > value.totalRequestedOutputs ||
    value.nextCounter !== value.startCounter + value.totalRequestedOutputs ||
    (value.totalReturnedProofs === 0 &&
      value.consecutiveEmptyOutputs !== value.totalRequestedOutputs)
  ) {
    throw new Error("seed recovery scan state is inconsistent");
  }
  return { ...value };
}

export function classifySeedRecoveryMintState(
  state: SeedRecoveryMintState,
): SeedRecoveryDisposition {
  switch (state) {
    case "UNSPENT":
      return "selectable";
    case "PENDING":
      return "retain-nonselectable";
    case "SPENT":
      return "spent";
    case "UNKNOWN":
      return "fail-closed";
    default:
      return assertNever(state);
  }
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new Error(`seed recovery ${label} overflowed`);
  }
  return result;
}

function requirePositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`seed recovery ${label} is invalid`);
  }
}

function requireNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`seed recovery ${label} is invalid`);
  }
}

function assertNever(value: never): never {
  throw new Error(`unknown seed recovery mint state: ${String(value)}`);
}
