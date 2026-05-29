/**
 * Single source-of-truth for deciding whether a closed CTF position is a
 * winner, a loser, or still active, and how much of it is claimable (P22 F3).
 *
 * This is the ONLY place winner/loser status and claimable value are derived.
 * The portfolio row badge ("Won"/"Lost"), the Claim button, the row
 * value/P&L, and the destructive "Remove" guard all consume this same result
 * so the badge and the destructive action can never disagree (these are bearer
 * proofs — destroying a mislabelled winner is permanent loss).
 *
 * ## The precise spec (P22 Link F HIGH)
 *
 * A CTF position is held as proofs spanning one or more primitive keysets. Each
 * keyset is bound to an outcome-collection (e.g. "A", "B", or a composite
 * "A|B"). The mint redeems a collection's proofs iff the collection CONTAINS
 * the attested outcome.
 *
 * - A keyset/leg is a WINNING leg iff the final/attested outcome is a member of
 *   that leg's outcome-collection (`final ∈ parseOutcomeCollection(collection)`).
 * - A position is a WINNER / CLAIMABLE iff it holds >= 1 proof on a winning
 *   keyset — the existence ("some winning leg") rule, NOT "every leg wins".
 * - Its claimable VALUE = sum of amounts on WINNING keysets only
 *   (losing-keyset proofs are worth 0).
 * - A position is a LOSER iff closed, ATTESTED (a final outcome is known), AND
 *   it holds NO proof on any winning keyset.
 * - A position is PENDING (awaiting resolution) iff closed but NOT YET ATTESTED
 *   (final outcome null/empty — e.g. closed by deadline, or before the oracle
 *   attests). Its win/loss is UNDECIDED: it offers NEITHER Claim NOR Remove, and
 *   its value is the full held amount (not zeroed). Treating this as a loser was
 *   the P22 Link F regression — it let the user destroy not-yet-decided proofs.
 *
 * ## Why "some", not "every"
 *
 * The earlier implementation used `.every` (a closed position was a winner only
 * if EVERY held leg matched). That MIS-CLASSIFIES an UNCLAIMED composite "A|B"
 * position that holds BOTH a winning "A" leg and a losing "B" leg: `.every` →
 * not all legs win → LOSER → the row offers ONLY the destructive Remove button
 * and NEVER Claim → the user clicks Remove and PERMANENTLY DESTROYS the winning
 * A-keyset proofs without redeeming. Catastrophic value loss.
 *
 * The original false-winner concern that motivated `.every` is already handled
 * elsewhere: Link B2's claim removes ALL legs on a successful claim (winning
 * redeemed + losing removed), so no leftover keeps a row alive. A
 * genuinely-winning leftover leg SHOULD remain claimable. The per-keyset
 * winning-leg rule is correct; the `.every` over-correction is wrong.
 *
 * Derive winner/value from the ACTUAL held proofs' keyset outcome-collections,
 * not from a possibly-stale aggregate position label.
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

/**
 * - `active`     — market still open; no claim/remove.
 * - `winner`     — closed, attested, holds a winning leg; Claim offered.
 * - `loser`      — closed, attested, holds NO winning leg (value 0); Remove offered.
 * - `pending`    — closed but NOT YET ATTESTED (no final outcome). The
 *   winning/losing status is UNDECIDED, so neither Claim nor Remove may be
 *   offered: removing here would PERMANENTLY DESTROY proofs whose value is not
 *   yet known. Value is the full held amount (an undecided position is not a
 *   loss). The row shows an "awaiting resolution" indicator and no actions.
 */
export type WinnerStatus = 'active' | 'winner' | 'loser' | 'pending'

/**
 * One held leg of a position: the keyset's outcome-collection label and the
 * total proof amount currently held on that keyset.
 */
export interface HeldLeg {
  /** The keyset's outcome-collection label, e.g. "A" or "A|B". */
  outcomeCollection: string
  /** Total amount of proofs currently held on this keyset. */
  amount: number
}

/**
 * Whether a single outcome-collection is a WINNING collection: the final
 * attested outcome is a member of the collection. The mint redeems a
 * collection's proofs iff the collection contains the attested outcome, so this
 * is the exact membership rule (case-insensitive, trimmed).
 */
export function isWinningCollection(
  outcomeCollection: string,
  finalOutcome: string | null | undefined,
): boolean {
  const final = finalOutcome?.trim().toLowerCase()
  if (!final) return false
  return parseOutcomeCollection(outcomeCollection).some(
    (leg) => leg.trim().toLowerCase() === final,
  )
}

export interface DeriveWinnerInput {
  /** Whether the market is closed (final outcome attested). */
  isClosed: boolean
  /** The market's attested final outcome name, if any. */
  finalOutcome: string | null | undefined
  /**
   * The legs (keysets) actually held by this position. Each leg carries its
   * keyset's outcome-collection label and the amount held on it.
   */
  legs: HeldLeg[]
}

export interface WinnerResult {
  status: WinnerStatus
  /**
   * For `winner`: sum of amounts on WINNING keysets only (losing-keyset proofs
   * are worth 0). For `pending` (closed-but-unattested): the full held amount —
   * the outcome is undecided, not a loss, so the value is NOT zeroed. For
   * `active`/`loser`: 0.
   */
  claimableValue: number
}

/**
 * Derive the closed-position winner status and claimable value from the actual
 * held legs.
 *
 * - Not closed → `active`.
 * - Closed but NO final outcome attested (closed by deadline, or in the window
 *   before the oracle attests) → `pending`: the win/loss is UNDECIDED, so this
 *   is NON-DESTRUCTIVE — neither Claim nor Remove is offered, and the value is
 *   the full held amount (NOT zeroed; an undecided outcome is not a loss).
 *   Treating this as a loser is the P22 Link F regression: it offered the
 *   destructive Remove and let the user permanently destroy proofs whose status
 *   was not yet decided.
 * - Closed AND attested AND holds >= 1 proof on a WINNING keyset (existence
 *   rule) → `winner`; claimable value sums only the winning legs.
 * - Closed AND attested AND no winning leg → `loser` (value 0).
 */
export function deriveWinner({
  isClosed,
  finalOutcome,
  legs,
}: DeriveWinnerInput): WinnerResult {
  if (!isClosed) return { status: 'active', claimableValue: 0 }
  const final = finalOutcome?.trim()
  if (!final) {
    // Closed but unattested: undecided, never destructive. Value = full held
    // amount across all legs (the outcome is not yet a loss).
    const heldValue = legs.reduce((sum, leg) => sum + leg.amount, 0)
    return { status: 'pending', claimableValue: heldValue }
  }

  let claimableValue = 0
  for (const leg of legs) {
    if (isWinningCollection(leg.outcomeCollection, final)) {
      claimableValue += leg.amount
    }
  }
  if (claimableValue > 0) return { status: 'winner', claimableValue }
  return { status: 'loser', claimableValue: 0 }
}

/** Convenience wrapper returning only the status. */
export function deriveWinnerStatus(input: DeriveWinnerInput): WinnerStatus {
  return deriveWinner(input).status
}
