import {
  Amount,
  type HasKeysetKeys,
  type Proof,
  type SerializedBlindedMessage,
} from '@cashu/cashu-ts'
import {
  bindExactSeedRecoveryResponse,
  planExactSeedRecoveryBatch,
} from './conditionalKeysetSeedRecovery.ts'
import { DURABLE_SEED_DERIVED_COUNTER_MAX } from './durableSeedDerivedPolicy.ts'
import {
  SEED_COUNTER_GAP_LIMIT,
  SEED_COUNTER_PROBE_BATCH_MAX,
  SEED_COUNTER_SCAN_COUNTERS_MAX,
} from './seedCounterGapScan.ts'

/**
 * An admitting NUT-09 scan of one seed and keyset (ADR-033). It restores the
 * proofs of the NUT-13 outputs that the mint signed, so that the caller can
 * check their states and admit the unspent ones.
 *
 * A mint that answers every restore with a signature for each queried output
 * never shows a gap. So one scan asks about at most a counter budget of
 * counters. The caller keeps the returned `nextCounter` and continues from it
 * in a later recovery pass. A scan also stops at once on a restored amount
 * that the keyset cannot sign, or on a total that the wallet cannot hold.
 */

/** The counters that one admitting scan asks about, as in a counter-only gap scan. */
export const SEED_ADMISSION_SCAN_COUNTERS_MAX = SEED_COUNTER_SCAN_COUNTERS_MAX

/** Why a scan ended: the gap after its last signed counter, or its counter budget. */
export type SeedAdmissionScanStop = 'gap-limit' | 'counter-budget'

export interface SeedAdmissionScanResult {
  /** The restored proofs in counter order. Their states are not checked yet. */
  readonly proofs: readonly Proof[]
  readonly lastCounterWithSignature: number | null
  /** The first counter that this scan did not ask about. A later scan starts here. */
  readonly nextCounter: number
  readonly stop: SeedAdmissionScanStop
}

/** The mint restored an amount that no honest restore of this keyset holds. */
export class SeedAdmissionScanImplausibleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SeedAdmissionScanImplausibleError'
  }
}

const SAFE_TOTAL_MAX = BigInt(Number.MAX_SAFE_INTEGER)

/**
 * Check the amounts of restored NUT-09 signatures before a client admits
 * them. Each amount must be one that the keyset signs. The total from
 * `total` on must stay a safe integer: no wallet holds more. Return the new
 * total. A caller that restores in batches passes the total of its pass.
 */
export function requirePlausibleRestoredAmounts(input: {
  readonly amounts: readonly unknown[]
  readonly keyset: HasKeysetKeys
  readonly total: bigint
}): bigint {
  let total = input.total
  for (const value of input.amounts) {
    const amount = Amount.from(value as never).toBigInt()
    if (amount <= 0n || input.keyset.keys[amount.toString()] === undefined) {
      throw new SeedAdmissionScanImplausibleError(
        'seed admission scan restored an amount that the keyset does not sign',
      )
    }
    total += amount
    if (total > SAFE_TOTAL_MAX) {
      throw new SeedAdmissionScanImplausibleError(
        'seed admission scan restored more value than a wallet can hold',
      )
    }
  }
  return total
}

export async function scanSeedCountersForAdmission(input: {
  /** One NUT-09 request to the mint. */
  readonly restore: (outputs: SerializedBlindedMessage[]) => Promise<unknown>
  readonly seed: Uint8Array
  readonly keyset: HasKeysetKeys
  readonly startCounter: number
  readonly maxScannedCounters?: number
}): Promise<SeedAdmissionScanResult> {
  const budget = input.maxScannedCounters ?? SEED_ADMISSION_SCAN_COUNTERS_MAX
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > SEED_ADMISSION_SCAN_COUNTERS_MAX) {
    throw new Error('seed admission scan counter budget is invalid')
  }
  const start = input.startCounter
  if (!Number.isSafeInteger(start) || start < 0 || start > DURABLE_SEED_DERIVED_COUNTER_MAX) {
    throw new Error('seed admission scan start counter is invalid')
  }
  const proofs: Proof[] = []
  let total = 0n
  let last: number | null = null
  let next = start
  for (;;) {
    // The last counter that the current gap still covers.
    const gapEnd = (last ?? start - 1) + SEED_COUNTER_GAP_LIMIT
    const end = Math.min(gapEnd, start + budget - 1, DURABLE_SEED_DERIVED_COUNTER_MAX)
    if (next > end) {
      return {
        proofs,
        lastCounterWithSignature: last,
        nextCounter: next,
        // The end of the counter space also ends the keyset: no later output exists.
        stop:
          next > gapEnd || next > DURABLE_SEED_DERIVED_COUNTER_MAX ? 'gap-limit' : 'counter-budget',
      }
    }
    const candidates = planExactSeedRecoveryBatch({
      seed: input.seed,
      keysetId: input.keyset.id,
      startCounter: next,
      count: Math.min(SEED_COUNTER_PROBE_BATCH_MAX, end - next + 1),
    })
    const bound = bindExactSeedRecoveryResponse({
      candidates,
      response: await input.restore(candidates.map(({ blindedOutput }) => ({ ...blindedOutput }))),
    })
    const matches = [...bound.matches].sort(
      (left, right) => left.candidate.counter - right.candidate.counter,
    )
    total = requirePlausibleRestoredAmounts({
      amounts: matches.map(({ signature }) => signature.amount),
      keyset: input.keyset,
      total,
    })
    for (const { candidate, signature } of matches) {
      proofs.push(
        candidate.outputData.toProof(
          { ...signature, amount: Amount.from(signature.amount) },
          input.keyset,
        ),
      )
    }
    if (bound.lastCounterWithSignature !== null) last = bound.lastCounterWithSignature
    next += candidates.length
  }
}
