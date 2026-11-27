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
 * client admits nothing from it. When the current plan is empty or incomplete
 * and no replaced plan restores completely and exactly, the refund did not
 * commit, and the client classifies the settlement again.
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

/** One NUT-09 read of one refund output plan. */
export type CtfRangeRefundPlanRestore<Result> =
  /** The mint signed every output of the plan, exactly. */
  | { readonly kind: 'signed'; readonly proofs: Result }
  /** The mint holds no signature for any output of the plan. */
  | { readonly kind: 'unsigned' }
  /** A valid proper subset; it grants no refund proof authority. */
  | { readonly kind: 'incomplete' }

/** The result of a spent refund. */
export type CtfRangeSpentRefundRestore<Result> =
  /** This refund committed with its current plan. */
  | { readonly kind: 'refunded'; readonly proofs: Result }
  /**
   * This refund did not commit: the current plan has no signature, and no
   * replaced plan restores completely and exactly. A swap signs all of its
   * outputs when it commits, so another request spent the refund inputs.
   */
  | { readonly kind: 'unsigned' }
  /** A valid proper subset; it grants no refund proof authority. */
  | { readonly kind: 'incomplete' }

/**
 * Decide a refund whose inputs are all SPENT. Read the current plan first,
 * then each replaced plan, newest first.
 *
 * - The current plan restores completely and exactly: `refunded`.
 * - A replaced plan restores completely and exactly: throw
 *   `CtfRangeRefundReplacedPlanSignedError`. The caller halts the refund and
 *   admits nothing.
 * - The current plan is empty or incomplete, and no replaced plan restores
 *   completely and exactly: return its no-proof observation.
 * - Otherwise throw the error of the current plan. The refund stays pending.
 *
 * `restore` validates the entire response before returning `incomplete`. It
 * throws for an invalid answer. A restore that the
 * mint did not answer proves nothing, so a transport failure is thrown at once.
 */
export async function restoreSpentCtfRangeRefund<Plan, Result>(input: {
  readonly currentPlan: Plan
  /** The replaced plans, oldest first. */
  readonly replacedPlans: readonly Plan[]
  readonly restore: (plan: Plan) => Promise<CtfRangeRefundPlanRestore<Result>>
  readonly isTransportFailure: (error: unknown) => boolean
}): Promise<CtfRangeSpentRefundRestore<Result>> {
  let current: CtfRangeRefundPlanRestore<Result> | undefined
  let currentError: unknown
  try {
    current = await input.restore(input.currentPlan)
  } catch (error) {
    if (input.isTransportFailure(error)) throw error
    currentError = error
  }
  if (current?.kind === 'signed') return { kind: 'refunded', proofs: current.proofs }
  for (const plan of [...input.replacedPlans].reverse()) {
    let replaced: CtfRangeRefundPlanRestore<Result>
    try {
      replaced = await input.restore(plan)
    } catch (error) {
      if (input.isTransportFailure(error)) throw error
      continue
    }
    if (replaced.kind === 'signed') throw new CtfRangeRefundReplacedPlanSignedError()
  }
  if (current?.kind === 'unsigned' || current?.kind === 'incomplete') return current
  throw currentError
}
