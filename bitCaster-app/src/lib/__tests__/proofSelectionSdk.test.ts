import { describe, expect, it } from 'vitest'
import {
  subtractProofs,
  sumProofs,
  takeProofsForLock,
} from '@bitcaster/client-sdk/proofSelection'

describe('shared proof selection', () => {
  it('prefers a single keyset over mixed-keyset greedy selection', () => {
    const proofs = [
      { amount: 80, id: 'a', secret: 'a1', C: 'a1' },
      { amount: 60, id: 'b', secret: 'b1', C: 'b1' },
      { amount: 40, id: 'b', secret: 'b2', C: 'b2' },
    ]

    expect(takeProofsForLock(proofs, 100)).toEqual([proofs[1], proofs[2]])
  })

  it('selects enough face value to cover input fees for a lock target', () => {
    const proofs = [
      { amount: 64, id: 'fee-keyset', secret: 'a', C: 'a' },
      { amount: 32, id: 'fee-keyset', secret: 'b', C: 'b' },
      { amount: 4, id: 'fee-keyset', secret: 'c', C: 'c' },
      { amount: 2, id: 'fee-keyset', secret: 'd', C: 'd' },
    ]

    expect(takeProofsForLock(proofs, 100, { 'fee-keyset': 1 })).toEqual(proofs)
  })

  it('subtracts selected proofs by proof identity', () => {
    const keep = { amount: 40, id: 'a', secret: 's1', C: 'c1' }
    const spend = { amount: 60, id: 'a', secret: 's2', C: 'c2' }

    expect(subtractProofs([keep, spend], [spend])).toEqual([keep])
    expect(sumProofs([keep, spend])).toBe(100)
  })
})
