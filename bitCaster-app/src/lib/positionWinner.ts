/**
 * Single source-of-truth for deciding whether a closed CTF position is a
 * winner, a loser, or still active (P22 F3).
 *
 * This is the ONLY place winner/loser status is derived. The portfolio row
 * badge ("Won"/"Lost"), the Claim button, the row value/P&L, and the
 * destructive "Remove" guard all consume this same result so the badge and the
 * destructive action can never disagree (these are bearer proofs — destroying a
 * mislabelled winner is permanent loss).
 *
 * The subtle case it must get right: a composite "A|B" position lives as proofs
 * across multiple primitive keysets. After a partial claim, the winning leg
 * ("A") is redeemed and removed but a leftover *losing* leg ("B") may remain,
 * still carrying the composite outcomeCollection label "A|B". A naive
 * "any held outcome matches the final outcome" check (`.some`) would see the
 * label "A|B" contains the final outcome "A" and falsely report Won with a
 * nonzero value, re-offering Claim on proofs that the mint will reject.
 *
 * Correct rule: a closed position is a winner only when EVERY held outcome leg
 * matches the final outcome. A residual losing-leg composite is therefore NOT a
 * winner. A row only fully leaves the Closed tab once all legs are resolved
 * (the claim path removes all legs; this derivation is the safety net).
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

export type WinnerStatus = 'active' | 'winner' | 'loser'

export interface DeriveWinnerInput {
  /** Whether the market is closed (final outcome attested). */
  isClosed: boolean
  /** The market's attested final outcome name (trimmed), if any. */
  finalOutcome: string | null | undefined
  /** The position's outcome-collection label, e.g. "A" or "A|B". */
  outcomeCollection: string
}

/**
 * Derive the closed-position winner status from the market state and the held
 * outcome legs. Winner ⇔ closed AND a final outcome is known AND EVERY held leg
 * matches the final outcome (`.every`, NOT `.some`). Anything else closed is a
 * loser; not-closed is active.
 */
export function deriveWinnerStatus({
  isClosed,
  finalOutcome,
  outcomeCollection,
}: DeriveWinnerInput): WinnerStatus {
  if (!isClosed) return 'active'
  const final = finalOutcome?.trim()
  if (!final) return 'loser'
  const legs = parseOutcomeCollection(outcomeCollection)
  if (legs.length === 0) return 'loser'
  const allLegsWin = legs.every(
    (held) => held.toLowerCase() === final.toLowerCase(),
  )
  return allLegsWin ? 'winner' : 'loser'
}
