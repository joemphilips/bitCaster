// Re-authored from the ordinary recovery core at 7e1385c.
export type SeedRecoveryMintState = 'UNSPENT' | 'PENDING' | 'SPENT' | 'UNKNOWN'

export type SeedRecoveryDisposition =
  | 'selectable'
  | 'retain-nonselectable'
  | 'spent'
  | 'fail-closed'

export interface SeedScanState {
  readonly startCounter: number
  readonly nextCounter: number
  readonly totalRequestedOutputs: number
  readonly totalReturnedProofs: number
  readonly consecutiveEmptyOutputs: number
}

export interface SeedScanCursor {
  readonly nextCounter: number
  readonly consecutiveEmptyOutputs: number
}

export function advanceSeedScanCursor(
  current: SeedScanCursor,
  observation: {
    readonly startCounter: number
    readonly requestedCount: number
    readonly returnedCounterOffsets: readonly number[]
  },
  maxBatchSize: number,
): SeedScanCursor {
  requireNonNegative(current.nextCounter, 'next counter')
  requireNonNegative(current.consecutiveEmptyOutputs, 'empty output count')
  requirePositive(maxBatchSize, 'maximum batch size')
  if (observation.startCounter !== current.nextCounter) {
    throw new Error('seed recovery observation has a stale counter')
  }
  if (
    !Number.isSafeInteger(observation.requestedCount) ||
    observation.requestedCount < 1 ||
    observation.requestedCount > maxBatchSize
  ) {
    throw new Error('seed recovery batch size is invalid')
  }
  const nextCounter = checkedAdd(
    observation.startCounter,
    observation.requestedCount,
    'counter',
  )
  const seen = new Set<number>()
  let highest = -1
  for (const offset of observation.returnedCounterOffsets) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset >= observation.requestedCount ||
      seen.has(offset)
    ) {
      throw new Error('seed recovery returned counter offset is invalid')
    }
    seen.add(offset)
    highest = Math.max(highest, offset)
  }
  return {
    nextCounter,
    consecutiveEmptyOutputs:
      highest < 0
        ? checkedAdd(
            current.consecutiveEmptyOutputs,
            observation.requestedCount,
            'empty output count',
          )
        : observation.requestedCount - highest - 1,
  }
}

export function advanceSeedScan(
  current: SeedScanState,
  observation: {
    readonly startCounter: number
    readonly requestedCount: number
    readonly returnedCounterOffsets: readonly number[]
  },
  limits: { readonly maxBatchSize: number; readonly maxTotalOutputs: number },
): SeedScanState {
  validateSeedScanState(current, limits.maxTotalOutputs)
  requirePositive(limits.maxBatchSize, 'maximum batch size')
  requirePositive(limits.maxTotalOutputs, 'maximum total outputs')
  const cursor = advanceSeedScanCursor(
    current,
    observation,
    limits.maxBatchSize,
  )
  const totalRequestedOutputs = checkedAdd(
    current.totalRequestedOutputs,
    observation.requestedCount,
    'requested output count',
  )
  if (totalRequestedOutputs > limits.maxTotalOutputs) {
    throw new Error('seed recovery total output bound exceeded')
  }
  const next: SeedScanState = {
    startCounter: current.startCounter,
    nextCounter: cursor.nextCounter,
    totalRequestedOutputs,
    totalReturnedProofs: checkedAdd(
      current.totalReturnedProofs,
      observation.returnedCounterOffsets.length,
      'returned proof count',
    ),
    consecutiveEmptyOutputs: cursor.consecutiveEmptyOutputs,
  }
  return validateSeedScanState(next, limits.maxTotalOutputs)
}

export function validateSeedScanState(
  value: SeedScanState,
  maxTotalOutputs: number,
): SeedScanState {
  requirePositive(maxTotalOutputs, 'maximum total outputs')
  requireNonNegative(value.startCounter, 'start counter')
  requireNonNegative(value.nextCounter, 'next counter')
  requireNonNegative(value.totalRequestedOutputs, 'requested output count')
  requireNonNegative(value.totalReturnedProofs, 'returned proof count')
  requireNonNegative(value.consecutiveEmptyOutputs, 'empty output count')
  if (
    value.totalRequestedOutputs > maxTotalOutputs ||
    value.totalReturnedProofs > value.totalRequestedOutputs ||
    value.consecutiveEmptyOutputs > value.totalRequestedOutputs ||
    value.nextCounter !== value.startCounter + value.totalRequestedOutputs ||
    (value.totalReturnedProofs === 0 &&
      value.consecutiveEmptyOutputs !== value.totalRequestedOutputs)
  ) {
    throw new Error('seed recovery scan state is inconsistent')
  }
  return { ...value }
}

export function classifySeedRecoveryMintState(
  state: SeedRecoveryMintState | unknown,
): SeedRecoveryDisposition {
  switch (state) {
    case 'UNSPENT':
      return 'selectable'
    case 'PENDING':
      return 'retain-nonselectable'
    case 'SPENT':
      return 'spent'
    case 'UNKNOWN':
      return 'fail-closed'
    default:
      return 'fail-closed'
  }
}

function checkedAdd(left: number, right: number, label: string): number {
  const value = left + right
  if (!Number.isSafeInteger(value)) {
    throw new Error(`seed recovery ${label} overflowed`)
  }
  return value
}

function requirePositive(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`seed recovery ${label} is invalid`)
  }
}

function requireNonNegative(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`seed recovery ${label} is invalid`)
  }
}
