import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildTokenHoldings,
  canBackOrder,
  computeTokenRatio,
  vcsAvailable,
  type TokenHoldings,
} from '../src/tradingClient.ts'

test('VCS with balanced inventory uses the minimum complete set amount', () => {
  assert.equal(vcsAvailable(holdings({ A: 10, B: 10 }), {}), 10)
})

test('VCS with imbalanced inventory uses the limiting atom', () => {
  assert.equal(vcsAvailable(holdings({ A: 5, B: 10 }), {}), 5)
})

test('VCS includes complement tokens as physical proofs for the same atom', () => {
  assert.equal(vcsAvailable(holdings({ A: 5, B: 3 }, { B: 2 }), {}), 5)
})

test('VCS subtracts reservations per atom', () => {
  assert.equal(vcsAvailable(holdings({ A: 10, B: 10 }), { A: 3 }), 7)
})

test('VCS with zero inventory is zero', () => {
  assert.equal(vcsAvailable(holdings({}, {}), {}), 0)
})

test('computeTokenRatio uses 2n+1 holdings and returns pure ratio state only', () => {
  const ratio = computeTokenRatio(holdings({ YES: 60, NO: 60 }, { YES: 40, NO: 40 }, 100))

  assert.equal(ratio.baseUnitRatio, 0.5)
  assert.equal(ratio.withinBounds, true)
  assert.equal('rebalancingPending' in ratio, false)
})

test('computeTokenRatio is within bounds between 5% and 60%', () => {
  assert.equal(computeTokenRatio(holdings({ YES: 95, NO: 95 }, {}, 5)).withinBounds, true)
  assert.equal(computeTokenRatio(holdings({ YES: 40, NO: 40 }, {}, 60)).withinBounds, true)
})

test('computeTokenRatio is out of bounds below 5% or above 60%', () => {
  assert.equal(computeTokenRatio(holdings({ YES: 100, NO: 100 }, {}, 4)).withinBounds, false)
  assert.equal(computeTokenRatio(holdings({ YES: 39, NO: 39 }, {}, 61)).withinBounds, false)
})

test('canBackOrder returns the correct maximum whole shares', () => {
  assert.deepEqual(
    canBackOrder(
      { side: 'bid', sizeSubunits: 2_000, shareFaceSubunits: 1_000 },
      holdings({ YES: 5_500, NO: 5_500 }),
      {},
      1_000,
    ),
    { canBack: true, maxShares: 5 },
  )
})

test('canBackOrder with zero VCS returns canBack=false', () => {
  assert.deepEqual(
    canBackOrder(
      { side: 'ask', sizeSubunits: 1_000, shareFaceSubunits: 1_000 },
      holdings({}, {}),
      {},
      1_000,
    ),
    { canBack: false, maxShares: 0 },
  )
})

test('binary market tracks 2 atoms, 2 complements, and 1 base token type', () => {
  const binary = holdings({ YES: 10, NO: 10 }, { YES: 1, NO: 2 }, 3)

  assert.equal(Object.keys(binary.primitiveProofsByAtom).length, 2)
  assert.equal(Object.keys(binary.complementProofsByAtom).length, 2)
  assert.equal(binary.baseUnitProofs, 3)
  assert.equal(vcsAvailable(binary, {}), 11)
})

test('categorical 3-outcome market tracks 3 atoms, 3 complements, and 1 base token type', () => {
  const categorical = holdings({ A: 10, B: 10, C: 10 }, { A: 1, B: 2, C: 3 }, 4)

  assert.equal(Object.keys(categorical.primitiveProofsByAtom).length, 3)
  assert.equal(Object.keys(categorical.complementProofsByAtom).length, 3)
  assert.equal(categorical.baseUnitProofs, 4)
  assert.equal(vcsAvailable(categorical, {}), 11)
})

test('buildTokenHoldings sums proof amounts correctly', () => {
  assert.deepEqual(
    buildTokenHoldings(
      { A: [{ amount: 1 }, { amount: 2 }], B: [{ amount: 3 }] },
      { A: [{ amount: 4 }], B: [{ amount: 5 }, { amount: 6 }] },
      [{ amount: 7 }, { amount: 8 }],
    ),
    {
      primitiveProofsByAtom: { A: 3, B: 3 },
      complementProofsByAtom: { A: 4, B: 11 },
      baseUnitProofs: 15,
    },
  )
})

function holdings(
  primitiveProofsByAtom: Record<string, number>,
  complementProofsByAtom: Record<string, number> = {},
  baseUnitProofs = 0,
): TokenHoldings {
  return {
    primitiveProofsByAtom,
    complementProofsByAtom,
    baseUnitProofs,
  }
}
