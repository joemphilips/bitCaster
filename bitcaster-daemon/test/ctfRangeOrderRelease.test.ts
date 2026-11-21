import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CtfRangeOrderInsufficientFundsError,
  rangeBuyFundsShortfall,
} from '../src/ctfRangeOrderRelease.ts'

function shortfall(targetMsat: number, inputFeePpk: number, amounts: readonly number[]) {
  const inventory = new Map<number, number>()
  for (const amount of amounts) inventory.set(amount, (inventory.get(amount) ?? 0) + 1)
  const result = rangeBuyFundsShortfall(targetMsat, inputFeePpk, inventory)
  return result === null
    ? null
    : {
        error: result instanceof CtfRangeOrderInsufficientFundsError,
        requiredMsat: result.requiredMsat,
        availableMsat: result.availableMsat,
      }
}

test('a Buy bound counts the input fee of each useful proof', () => {
  // 11 proofs at 100 ppk cost ceil(1.1) = 2 msat, so 352 msat cannot pay 501 + 2.
  assert.deepEqual(shortfall(501, 100, Array(11).fill(32)), {
    error: true,
    requiredMsat: 503,
    availableMsat: 352,
  })
  // 512 msat pays 501 msat and the 1 msat fee of one input.
  assert.equal(shortfall(501, 100, [512]), null)
})

test('a Buy bound ignores dust proofs that are worth less than their own input fee', () => {
  // At 2000 ppk each input costs 2 msat. The 605 msat proof alone pays 600 + 2.
  // Five 1 msat proofs would add 10 msat of fee for 5 msat of value.
  assert.equal(shortfall(600, 2000, [605, 1, 1, 1, 1, 1]), null)
  // Without enough useful value, the bound names only the useful proofs.
  assert.deepEqual(shortfall(700, 2000, [605, 1, 1, 1, 1, 1]), {
    error: true,
    requiredMsat: 702,
    availableMsat: 605,
  })
})

test('a Buy bound keeps a proof that is worth exactly its input fee', () => {
  // At 1000 ppk a 1 msat proof pays its own 1 msat fee and changes nothing.
  assert.deepEqual(shortfall(10, 1000, [4, 1]), {
    error: true,
    requiredMsat: 12,
    availableMsat: 5,
  })
})
