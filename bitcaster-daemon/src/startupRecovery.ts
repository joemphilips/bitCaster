import { COMPLETE_SET_RECOVERY_PAGE_SAMPLE_LIMIT } from './state.ts'

export interface StartupRecoveryResult {
  readonly recovered: readonly string[]
  readonly recoveredCount?: number
  readonly pending: ReadonlyArray<{ readonly operationId: string; readonly error: string }>
}

export interface CustodyRecoveryStatus {
  readonly nonRetirementPending: boolean
  readonly retirementPending: boolean
}

export interface ManualCustodyRecoveryStatus {
  readonly nonRetirementPending: boolean
  readonly retirementPending: boolean
}

export function composeStartupCustodyRecovery(recoveries: readonly StartupRecoveryResult[]): {
  readonly recovered: string[]
  readonly recoveredCount: number
  readonly pending: Array<{ operationId: string; error: string }>
} {
  const recovered: string[] = []
  const pending: Array<{ operationId: string; error: string }> = []
  let recoveredCount = 0
  for (const recovery of recoveries) {
    recoveredCount += recovery.recoveredCount ?? recovery.recovered.length
    for (const operationId of recovery.recovered) {
      if (recovered.length < COMPLETE_SET_RECOVERY_PAGE_SAMPLE_LIMIT) recovered.push(operationId)
    }
    pending.push(...recovery.pending)
  }
  return { recovered, recoveredCount, pending }
}

export function createCustodyReadinessTracker(initial: CustodyRecoveryStatus): {
  updateManualRecovery(status: ManualCustodyRecoveryStatus): void
  beginAutomaticRetirementScan(): number
  completeAutomaticRetirementScan(generation: number, retirementPending: boolean): boolean
  isReady(): boolean
} {
  let nonRetirementPending = initial.nonRetirementPending
  let retirementPending = initial.retirementPending
  let latestAutomaticRetirementScan = 0
  return {
    updateManualRecovery: (status) => {
      nonRetirementPending = status.nonRetirementPending
      if (status.retirementPending) retirementPending = true
    },
    beginAutomaticRetirementScan: () => {
      latestAutomaticRetirementScan += 1
      return latestAutomaticRetirementScan
    },
    completeAutomaticRetirementScan: (generation, pending) => {
      if (generation !== latestAutomaticRetirementScan) return false
      retirementPending = pending
      return true
    },
    isReady: () => !nonRetirementPending && !retirementPending,
  }
}
