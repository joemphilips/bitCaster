import type {
  ConditionOracleWitness,
  ConditionResolution,
  RegisteredConditionAuthority,
} from '@bitcaster-market/client-sdk/conditionResolution'
import type { DaemonConditionResolution } from '../../src/nativeConditionResolution.ts'

/** The facts of one verified condition result. */
export interface ConditionResultFixture {
  readonly conditionId: string
  readonly attestedOutcome: string
  readonly oracleWitness: ConditionOracleWitness
  readonly registeredAuthority: RegisteredConditionAuthority
}

/** A far announced maturity, so a pending fixture condition is not due. */
export const FAR_MATURITY_EPOCH = 4_000_000_000

export function resolvedRead(
  result: ConditionResultFixture,
  maturityEpoch = 1,
): ConditionResolution {
  return {
    conditionId: result.conditionId,
    registeredAuthority: result.registeredAuthority,
    maturityEpoch,
    state: {
      status: 'resolved',
      source: 'mint',
      attestedOutcome: result.attestedOutcome,
      oracleWitness: result.oracleWitness,
    },
  }
}

/** A resolution whose mint record holds this verified result. */
export function resolvedResolution(result: ConditionResultFixture): DaemonConditionResolution {
  return { read: async () => resolvedRead(result) }
}

/** A resolution without a result yet, announced to mature at `maturityEpoch`. */
export function pendingResolution(
  result: ConditionResultFixture,
  maturityEpoch = FAR_MATURITY_EPOCH,
): DaemonConditionResolution {
  return {
    read: async () => ({ ...resolvedRead(result, maturityEpoch), state: { status: 'pending' } }),
  }
}

/** A mint that does not answer the condition read. */
export const unavailableResolution: DaemonConditionResolution = {
  read: async () => {
    throw new Error('mint condition information is unavailable')
  },
}
