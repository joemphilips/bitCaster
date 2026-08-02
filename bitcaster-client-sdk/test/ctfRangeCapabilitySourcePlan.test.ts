import assert from 'node:assert/strict'
import test from 'node:test'
import type { Proof } from '@cashu/cashu-ts'
import { planCtfRangeCapabilitySource } from '../src/ctfRangeCapabilitySourcePlan.ts'

const KEYS = Object.fromEntries(Array.from({ length: 16 }, (_, bit) => [String(2 ** bit), '02']))
const OFFERED = { id: 'conditional-a', inputFeePpk: 100, keys: KEYS }
const COLLATERAL = { id: 'regular', inputFeePpk: 100, keys: KEYS }
const COMPLEMENT = { id: 'conditional-b-c', inputFeePpk: 100, keys: KEYS }

test('plans one collateral conversion into a locked offer, complement, and change', () => {
  const plan = planCtfRangeCapabilitySource({
    side: 'Sell',
    authorizationAmounts: ['8', '2'],
    offeredKeyset: OFFERED,
    collateralKeyset: COLLATERAL,
    complementKeyset: COMPLEMENT,
    offeredCandidates: [],
    collateralCandidates: [proof(COLLATERAL.id, 16)],
    maxInputs: 64,
    maxOutputs: 128,
  })

  assert.equal(plan.kind, 'collateral-ctf-convert')
  if (plan.kind !== 'collateral-ctf-convert') return
  assert.equal(plan.inputFee, 1)
  assert.equal(sum(plan.authorizationAmounts), 10)
  assert.equal(sum(plan.complementAmounts), 10)
  assert.equal(sum(plan.collateralChangeAmounts), 5)
  assert.equal(sum(plan.inputs.map(({ amount }) => Number(amount))), 16)
  assert.equal(sum(plan.authorizationAmounts) + sum(plan.collateralChangeAmounts), 15)
  assert.equal(sum(plan.complementAmounts) + sum(plan.collateralChangeAmounts), 15)
})

test('prefers a complete offered source and never mixes it with collateral', () => {
  const plan = planCtfRangeCapabilitySource({
    side: 'Sell',
    authorizationAmounts: ['8', '2'],
    offeredKeyset: OFFERED,
    collateralKeyset: COLLATERAL,
    complementKeyset: COMPLEMENT,
    offeredCandidates: [proof(OFFERED.id, 8), proof(OFFERED.id, 4)],
    collateralCandidates: [proof(COLLATERAL.id, 16)],
    maxInputs: 64,
    maxOutputs: 128,
  })

  assert.equal(plan.kind, 'same-keyset-swap')
  if (plan.kind !== 'same-keyset-swap') return
  assert.equal(
    plan.inputs.every(({ id }) => id === OFFERED.id),
    true,
  )
  assert.equal(plan.inputFee, 1)
  assert.equal(plan.changeAmount, 1)
})

test('leaves partial offered inventory untouched and falls back to collateral', () => {
  const partial = proof(OFFERED.id, 4)
  const plan = planCtfRangeCapabilitySource({
    side: 'Sell',
    authorizationAmounts: ['8', '2'],
    offeredKeyset: OFFERED,
    collateralKeyset: COLLATERAL,
    complementKeyset: COMPLEMENT,
    offeredCandidates: [partial],
    collateralCandidates: [proof(COLLATERAL.id, 16)],
    maxInputs: 64,
    maxOutputs: 128,
  })

  assert.equal(plan.kind, 'collateral-ctf-convert')
  if (plan.kind !== 'collateral-ctf-convert') return
  assert.equal(plan.inputs.includes(partial), false)
  assert.equal(
    plan.inputs.every(({ id }) => id === COLLATERAL.id),
    true,
  )
})

test('rejects a source that exceeds the output limit before mint I/O', () => {
  assert.throws(
    () =>
      planCtfRangeCapabilitySource({
        side: 'Sell',
        authorizationAmounts: ['8', '2'],
        offeredKeyset: OFFERED,
        collateralKeyset: COLLATERAL,
        complementKeyset: COMPLEMENT,
        offeredCandidates: [],
        collateralCandidates: [proof(COLLATERAL.id, 16)],
        maxInputs: 64,
        maxOutputs: 2,
      }),
    /output limit/,
  )
})

test('requests consolidation instead of bypassing sufficiently funded fragmented inventory', () => {
  const plan = planCtfRangeCapabilitySource({
    side: 'Sell',
    authorizationAmounts: ['4'],
    offeredKeyset: OFFERED,
    collateralKeyset: COLLATERAL,
    complementKeyset: COMPLEMENT,
    offeredCandidates: Array.from({ length: 5 }, (_, index) =>
      proof(OFFERED.id, 1, `fragment-${index}`),
    ),
    collateralCandidates: [proof(COLLATERAL.id, 16)],
    maxInputs: 4,
    maxOutputs: 128,
  })

  assert.deepEqual(plan, {
    kind: 'consolidation-required',
    keysetId: OFFERED.id,
    selectedInputCount: 5,
    maxInputs: 4,
  })
})

test('preserves every outcome payoff across collateral amounts and proof counts', () => {
  for (const target of [1, 2, 3, 7, 10, 31]) {
    for (const inputAmounts of [[target + 1], [target + 2, 1], [target + 4, 2, 1]]) {
      const inputs = inputAmounts.map((amount, index) =>
        proof(COLLATERAL.id, amount, `property-${target}-${index}`),
      )
      const plan = planCtfRangeCapabilitySource({
        side: 'Sell',
        authorizationAmounts: [String(target)],
        offeredKeyset: OFFERED,
        collateralKeyset: COLLATERAL,
        complementKeyset: COMPLEMENT,
        offeredCandidates: [],
        collateralCandidates: inputs,
        maxInputs: 64,
        maxOutputs: 128,
      })
      if (plan.kind === 'source-unavailable') continue
      assert.equal(plan.kind, 'collateral-ctf-convert')
      if (plan.kind !== 'collateral-ctf-convert') continue
      const inputValue = sum(plan.inputs.map(({ amount }) => Number(amount)))
      const change = sum(plan.collateralChangeAmounts)
      assert.equal(sum(plan.authorizationAmounts) + change, inputValue - plan.inputFee)
      assert.equal(sum(plan.complementAmounts) + change, inputValue - plan.inputFee)
    }
  }
})

function proof(id: string, amount: number, suffix = String(amount)): Proof {
  return { id, amount, secret: `${id}-${suffix}`, C: '02' }
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}
