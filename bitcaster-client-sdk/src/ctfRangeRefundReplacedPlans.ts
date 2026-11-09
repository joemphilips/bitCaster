import { Amount, OutputData, type HasKeysetKeys } from '@cashu/cashu-ts'
import {
  decodeDurableSeedDerivedOutputPlan,
  reconstructDurableSeedDerivedOutputs,
  type DurableSeedDerivedOutputPlan,
} from './durableSeedDerivedOutputs.ts'

/**
 * The replaced output plans of a range-order refund (ADR-037 mint refusal
 * settlement). After an 11003 or 11008 refusal of a refund with every input
 * unspent, the client plans new outputs for the same inputs. The refund
 * record keeps each replaced plan in `replacedRefundOutputPlans`, oldest
 * first.
 *
 * A plan was replaced because another request already signed its outputs.
 * So a NUT-09 hit on a replaced plan does not prove that this refund
 * committed with it: another client with the same seed can have signed the
 * same counters with the same amounts. A spent refund completes only from its
 * current plan. A hit only on a replaced plan halts the refund, and the
 * client admits nothing from it.
 */

/** Replaced output plans that one refund record keeps. */
export const CTF_RANGE_REFUND_REPLACED_OUTPUT_PLANS_MAX = 8

/** The NUT-09 restore found the outputs of a replaced plan, not of the current plan. */
export class CtfRangeRefundReplacedPlanSignedError extends Error {
  constructor() {
    super('CTF range refund outputs match only a replaced output plan')
    this.name = 'CtfRangeRefundReplacedPlanSignedError'
  }
}

/** The saved plans that a re-plan replaced, oldest first. */
export function savedReplacedCtfRangeRefundOutputPlans(
  metadata: Readonly<Record<string, unknown>>,
): readonly unknown[] {
  if (!Object.hasOwn(metadata, 'replacedRefundOutputPlans')) return []
  const plans: unknown = metadata.replacedRefundOutputPlans
  if (
    !Array.isArray(plans) ||
    plans.length === 0 ||
    plans.length > CTF_RANGE_REFUND_REPLACED_OUTPUT_PLANS_MAX
  ) {
    throw new Error('CTF range refund replaced output plans are invalid')
  }
  return plans
}

/** The decoded plans that a re-plan replaced, oldest first. */
export function decodeReplacedCtfRangeRefundOutputPlans(
  metadata: Readonly<Record<string, unknown>>,
): readonly DurableSeedDerivedOutputPlan[] {
  return savedReplacedCtfRangeRefundOutputPlans(metadata).map(decodeDurableSeedDerivedOutputPlan)
}

/**
 * Check that each replaced plan is seed derived on the refund keyset for the
 * amount of the current plan.
 */
export function assertReplacedCtfRangeRefundOutputPlans(input: {
  readonly metadata: Readonly<Record<string, unknown>>
  readonly seed: Uint8Array
  readonly keyset: HasKeysetKeys
  readonly total: number
}): void {
  for (const plan of decodeReplacedCtfRangeRefundOutputPlans(input.metadata)) {
    const amounts = plan.outputs.map((output) =>
      Amount.from(OutputData.deserialize(output).blindedMessage.amount).toNumber(),
    )
    if (amounts.reduce((sum, amount) => sum + amount, 0) !== input.total) {
      throw new Error('CTF range refund replaced output plan amount differs')
    }
    reconstructDurableSeedDerivedOutputs({ seed: input.seed, keyset: input.keyset, amounts, plan })
  }
}

/**
 * Restore the proofs of a spent refund from its current plan. When the
 * current plan does not restore, read each replaced plan, newest first. A
 * replaced plan that restores throws `CtfRangeRefundReplacedPlanSignedError`:
 * the caller halts the refund and admits nothing. A restore that the mint
 * did not answer proves nothing, so a transport failure is thrown at once.
 * Otherwise the error of the current plan is thrown, and the refund stays
 * pending.
 */
export async function restoreSpentCtfRangeRefund<Plan, Result>(input: {
  readonly currentPlan: Plan
  /** The replaced plans, oldest first. */
  readonly replacedPlans: readonly Plan[]
  readonly restore: (plan: Plan) => Promise<Result>
  readonly isTransportFailure: (error: unknown) => boolean
}): Promise<Result> {
  let currentError: unknown
  try {
    return await input.restore(input.currentPlan)
  } catch (error) {
    if (input.isTransportFailure(error)) throw error
    currentError = error
  }
  for (const plan of [...input.replacedPlans].reverse()) {
    try {
      await input.restore(plan)
    } catch (error) {
      if (input.isTransportFailure(error)) throw error
      continue
    }
    throw new CtfRangeRefundReplacedPlanSignedError()
  }
  throw currentError
}
