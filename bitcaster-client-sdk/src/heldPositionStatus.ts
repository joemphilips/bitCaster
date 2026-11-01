/**
 * Closed, won, lost and pending classification for a held conditional-token
 * position. Every client uses this one rule, so the GUI badge, the Claim and
 * Remove guards, the close notification and the CLI listing cannot disagree.
 *
 * A position is held as proofs on one or more keysets. Each keyset is bound to
 * an outcome collection (for example "A", "B", or the composite "A|B"). The
 * mint redeems a collection's proofs only when the collection contains the
 * attested outcome.
 *
 * - A leg wins when the attested outcome is a member of its collection.
 * - A position wins when it holds at least one proof on a winning leg ("some",
 *   not "every": a composite position with a winning and a losing leg must
 *   still offer Claim, or Remove would destroy the winning proofs). Its
 *   claimable value counts the winning legs only.
 * - A position loses when the market is closed, an outcome is attested, and no
 *   held leg wins.
 * - A position is pending when the market is closed but no outcome is attested
 *   (a deadline close, or the time before the oracle attests). A pending
 *   position offers neither Claim nor Remove, because its result is undecided.
 *   Closure alone never proves a loss.
 */

/** Split a NUT-CTF outcome-collection label ("A|B", escaped "\|") into legs. */
export function parseOutcomeCollection(value: string): string[] {
  const outcomes: string[] = []
  let current = ''
  let escaped = false
  for (const ch of value) {
    if (escaped) {
      current += ch
      escaped = false
    } else if (ch === '\\') {
      escaped = true
    } else if (ch === '|') {
      outcomes.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  outcomes.push(current)
  return outcomes.filter((outcome) => outcome.length > 0)
}

export type WinnerStatus = 'active' | 'winner' | 'loser' | 'pending'

/** One held keyset leg: its outcome-collection label and the amount held on it. */
export interface HeldLeg {
  outcomeCollection: string
  amount: number
}

/**
 * The exact membership rule that the mint applies. Normalizing case or
 * whitespace here could match a different registered outcome.
 */
export function isWinningCollection(
  outcomeCollection: string,
  finalOutcome: string | null | undefined,
): boolean {
  if (!finalOutcome) return false
  return parseOutcomeCollection(outcomeCollection).includes(finalOutcome)
}

export interface DeriveWinnerInput {
  isClosed: boolean
  finalOutcome: string | null | undefined
  legs: HeldLeg[]
}

export interface WinnerResult {
  status: WinnerStatus
  /**
   * Winner: the amount on winning legs. Pending: the full held amount, because
   * an undecided result is not a loss. Active and loser: 0.
   */
  claimableValue: number
}

export function deriveWinner({ isClosed, finalOutcome, legs }: DeriveWinnerInput): WinnerResult {
  if (!isClosed) return { status: 'active', claimableValue: 0 }
  if (!finalOutcome?.trim()) {
    const heldValue = legs.reduce((sum, leg) => sum + leg.amount, 0)
    return { status: 'pending', claimableValue: heldValue }
  }

  let claimableValue = 0
  for (const leg of legs) {
    if (isWinningCollection(leg.outcomeCollection, finalOutcome)) claimableValue += leg.amount
  }
  if (claimableValue > 0) return { status: 'winner', claimableValue }
  return { status: 'loser', claimableValue: 0 }
}

/** Local custody facts for one held outcome collection. */
export interface HeldPositionCustodyFacts {
  outcomeCollection: string
  /** Amount on proofs that the wallet can act on. Excludes retained unverified proofs. */
  amount: number
  /** Amount on retained proofs whose mint refusal has no verified losing evidence. */
  retainedUnverifiedAmount: number
  /** Every held proof is a mint-verified loser, retained, or pending removal. */
  allVerifiedLosing: boolean
  /** A claim of these proofs started and has not finished. */
  claimRecoveryPending: boolean
}

/** Catalogue facts for the position's market. */
export interface HeldPositionMarketFacts {
  state?: string | null
  /** The engine-verified attested outcome. Null until the result is verified. */
  finalOutcome?: string | null
}

/**
 * - `active`: the market is open or unknown.
 * - `winner` and `loser`: the result is decided.
 * - `pending`: the row is closed, but no verified outcome decides the result.
 * - `history`: only retained unverified proofs remain; the row has no result
 *   and no action.
 */
export type HeldPositionResult = 'active' | 'winner' | 'loser' | 'pending' | 'history'

export interface HeldPositionStatus {
  closed: boolean
  result: HeldPositionResult
  /** The redeemable amount of a winner. 0 for every other result. */
  claimableAmount: number
}

export function classifyHeldPosition(
  custody: HeldPositionCustodyFacts,
  market: HeldPositionMarketFacts | undefined,
): HeldPositionStatus {
  const historyOnly = custody.amount === 0 && custody.retainedUnverifiedAmount > 0
  const closed =
    historyOnly ||
    custody.allVerifiedLosing ||
    custody.claimRecoveryPending ||
    String(market?.state ?? '').toLowerCase() === 'closed'
  if (historyOnly) return { closed, result: 'history', claimableAmount: 0 }
  // A mint-verified loss is decided before the catalogue reports the outcome.
  if (custody.allVerifiedLosing) return { closed, result: 'loser', claimableAmount: 0 }
  const { status, claimableValue } = deriveWinner({
    isClosed: closed,
    finalOutcome: market?.finalOutcome?.trim(),
    legs: [{ outcomeCollection: custody.outcomeCollection, amount: custody.amount }],
  })
  return { closed, result: status, claimableAmount: status === 'winner' ? claimableValue : 0 }
}
