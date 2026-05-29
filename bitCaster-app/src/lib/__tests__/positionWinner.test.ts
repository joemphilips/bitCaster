import { describe, expect, it } from 'vitest'
import { deriveWinnerStatus, parseOutcomeCollection } from '../positionWinner'

describe('parseOutcomeCollection', () => {
  it('splits a composite collection into legs', () => {
    expect(parseOutcomeCollection('A|B')).toEqual(['A', 'B'])
  })

  it('returns a single leg for a primitive collection', () => {
    expect(parseOutcomeCollection('A')).toEqual(['A'])
  })

  it('honours escaped pipes in outcome names', () => {
    expect(parseOutcomeCollection('A\\|B|C')).toEqual(['A|B', 'C'])
  })
})

describe('deriveWinnerStatus (P22 F3 single source-of-truth)', () => {
  it('marks a singular winning leg as a winner', () => {
    expect(
      deriveWinnerStatus({
        isClosed: true,
        finalOutcome: 'A',
        outcomeCollection: 'A',
      }),
    ).toBe('winner')
  })

  it('is case-insensitive on the final outcome match', () => {
    expect(
      deriveWinnerStatus({
        isClosed: true,
        finalOutcome: 'alice',
        outcomeCollection: 'Alice',
      }),
    ).toBe('winner')
  })

  it('marks a singular non-winning leg as a loser', () => {
    expect(
      deriveWinnerStatus({
        isClosed: true,
        finalOutcome: 'A',
        outcomeCollection: 'B',
      }),
    ).toBe('loser')
  })

  // The core F3 regression: a composite "A|B" position whose winning "A" leg
  // was already redeemed leaves a residual losing "B" leg STILL labelled "A|B".
  // A naive `.some` derivation would see the label contains the final outcome
  // "A" and falsely report it Won with nonzero value, re-offering Claim on
  // proofs the mint rejects. `.every` correctly treats it as a loser.
  it('does NOT treat a residual composite partial-claim leg as a winner', () => {
    expect(
      deriveWinnerStatus({
        isClosed: true,
        finalOutcome: 'A',
        outcomeCollection: 'A|B',
      }),
    ).toBe('loser')
  })

  it('treats a fully-losing composite as a loser', () => {
    expect(
      deriveWinnerStatus({
        isClosed: true,
        finalOutcome: 'C',
        outcomeCollection: 'A|B',
      }),
    ).toBe('loser')
  })

  it('treats an open market as active regardless of outcome label', () => {
    expect(
      deriveWinnerStatus({
        isClosed: false,
        finalOutcome: 'A',
        outcomeCollection: 'A',
      }),
    ).toBe('active')
  })

  it('treats a closed market with no attested outcome as a loser, never a winner', () => {
    expect(
      deriveWinnerStatus({
        isClosed: true,
        finalOutcome: undefined,
        outcomeCollection: 'A',
      }),
    ).toBe('loser')
  })

  it('treats an empty outcome collection as a loser, never a winner', () => {
    expect(
      deriveWinnerStatus({
        isClosed: true,
        finalOutcome: 'A',
        outcomeCollection: '',
      }),
    ).toBe('loser')
  })
})
