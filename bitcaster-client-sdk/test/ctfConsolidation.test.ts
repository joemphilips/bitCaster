import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Proof, SerializedBlindedMessage } from '@cashu/cashu-ts'
import {
  COLLATERAL_COLLECTION,
  computeConvertFeeSubunits,
  payoffVector,
  planCtfConsolidation,
  planCtfConsolidationAmounts,
  materializeCtfConsolidationPlan,
  planCtfCompleteSetSplit,
  type CtfConsolidationParams,
} from '../src/ctfConsolidation.ts'

const CONDITION_ID = 'b'.repeat(64)
const OUTCOMES = ['A', 'B', 'C']

test('T1 converts N-1 singletons plus collateral top-up into the missing complement', () => {
  const result = planCtfConsolidation(
    params('t1', {
      A: [proof('ks-A', 10, 'a-10')],
      B: [proof('ks-B', 10, 'b-10')],
      [COLLATERAL_COLLECTION]: [proof('ks-base', 1, 'base-1')],
    }),
  )

  assert.equal(result.kind, 'plan')
  if (result.kind !== 'plan') return
  assert.equal(result.feeSubunits, 1)
  assert.deepEqual(result.inputPayoff, { A: 11, B: 11, C: 1 })
  assert.deepEqual(result.outputPayoff, { A: 10, B: 10, C: 0 })
  assert.deepEqual(Object.keys(result.request.inputs).sort(), [COLLATERAL_COLLECTION, 'A', 'B'])
  assert.deepEqual(result.request.outputs['A|B'], [output('ks-A|B', 10, 'A|B')])
})

test('T2 extracts max collateral from the 3-outcome NegRisk complement case', () => {
  const result = planCtfConsolidation(
    params('t2', {
      'B|C': [proof('ks-B|C', 2, 'not-a-2')],
      'A|C': [proof('ks-A|C', 2, 'not-b-2')],
    }),
  )

  assert.equal(result.kind, 'plan')
  if (result.kind !== 'plan') return
  assert.equal(result.feeSubunits, 1)
  assert.equal(result.collateralOutputSubunits, 1)
  assert.deepEqual(result.inputPayoff, { A: 2, B: 2, C: 4 })
  assert.deepEqual(result.outputPayoff, { A: 1, B: 1, C: 3 })
  assert.deepEqual(result.request.outputs[COLLATERAL_COLLECTION], [
    output('ks-base', 1, COLLATERAL_COLLECTION),
  ])
  assert.deepEqual(result.request.outputs.C, [output('ks-C', 2, 'C')])
})

test('T3 converts a complete uniform holding into pure base collateral', () => {
  const result = planCtfConsolidation(
    params('t3', {
      A: [proof('ks-A', 10, 'a-10')],
      B: [proof('ks-B', 10, 'b-10')],
      C: [proof('ks-C', 10, 'c-10')],
    }),
  )

  assert.equal(result.kind, 'plan')
  if (result.kind !== 'plan') return
  assert.equal(result.feeSubunits, 1)
  assert.equal(result.collateralOutputSubunits, 9)
  assert.deepEqual(result.inputPayoff, { A: 10, B: 10, C: 10 })
  assert.deepEqual(result.outputPayoff, { A: 9, B: 9, C: 9 })
  assert.deepEqual(Object.keys(result.request.outputs), [COLLATERAL_COLLECTION])
})

test('T3 leaves the regular collateral of the wallet out of the conversion', () => {
  const result = planCtfConsolidation(
    params('t3', {
      A: [proof('ks-A', 10, 'a-10')],
      B: [proof('ks-B', 10, 'b-10')],
      C: [proof('ks-C', 10, 'c-10')],
      [COLLATERAL_COLLECTION]: [proof('ks-base', 5, 'base-5')],
    }),
  )

  assert.equal(result.kind, 'plan')
  if (result.kind !== 'plan') return
  // Regular collateral adds the same amount to each outcome. It releases no
  // collateral and only adds input fees, so it is never an input.
  assert.deepEqual(Object.keys(result.request.inputs).sort(), ['A', 'B', 'C'])
  assert.equal(result.feeSubunits, 1)
  assert.equal(result.collateralOutputSubunits, 9)
  assert.deepEqual(Object.keys(result.request.outputs), [COLLATERAL_COLLECTION])
})

test('T3 skips a position without a complete set, also when the wallet holds regular collateral', () => {
  const result = planCtfConsolidation(
    params('t3', {
      A: [proof('ks-A', 10, 'a-10')],
      [COLLATERAL_COLLECTION]: [proof('ks-base', 5, 'base-5')],
    }),
  )

  assert.deepEqual(result, {
    kind: 'noop',
    strategy: 't3',
    reason: 'insufficient-outcome-floor',
    feeSubunits: 1,
    inputPayoff: { A: 10, B: 0, C: 0 },
  })
})

test('T1 skips a binary market, where the complement of one outcome is the other outcome', () => {
  const input = params('t1', {
    YES: [proof('ks-YES', 10, 'yes-10')],
    [COLLATERAL_COLLECTION]: [proof('ks-base', 1, 'base-1')],
  })
  input.outcomes = ['YES', 'NO']
  input.registration = { ...input.registration, outcomes: ['YES', 'NO'] }
  input.inputFeePpkByKeyset = { 'ks-YES': 1, 'ks-NO': 1, 'ks-base': 1 }
  input.outputKeysetByCollection = {
    YES: 'ks-YES',
    NO: 'ks-NO',
    [COLLATERAL_COLLECTION]: 'ks-base',
  }

  // A merge would give back the same YES position and charge the fee.
  assert.deepEqual(planCtfConsolidation(input), {
    kind: 'noop',
    strategy: 't1',
    reason: 'no-matching-inputs',
  })
})

test('T2 skips when the fee floor consumes the available collateral gain', () => {
  const result = planCtfConsolidation(
    params('t2', {
      'B|C': [proof('ks-B|C', 1, 'not-a-1')],
      'A|C': [proof('ks-A|C', 1, 'not-b-1')],
    }),
  )

  assert.deepEqual(result, {
    kind: 'noop',
    strategy: 't2',
    reason: 'net-collateral-nonpositive',
    feeSubunits: 1,
    inputPayoff: { A: 1, B: 1, C: 2 },
  })
})

test('T1 accepts an outcome amount exactly equal to the fee floor', () => {
  const result = planCtfConsolidation(
    params('t1', {
      A: [proof('ks-A', 1, 'a-1')],
      B: [proof('ks-B', 1, 'b-1')],
      [COLLATERAL_COLLECTION]: [proof('ks-base', 1, 'base-1')],
    }),
  )

  assert.equal(result.kind, 'plan')
  if (result.kind !== 'plan') return
  assert.equal(result.feeSubunits, 1)
  assert.equal(result.collateralOutputSubunits, 0)
  assert.deepEqual(result.inputPayoff, { A: 2, B: 2, C: 1 })
  assert.deepEqual(result.outputPayoff, { A: 1, B: 1, C: 0 })
  assert.deepEqual(Object.keys(result.request.outputs), ['A|B'])
  assert.deepEqual(result.request.outputs['A|B'], [output('ks-A|B', 1, 'A|B')])
})

test('T3 skips when F equals every input amount and outputs would net to zero', () => {
  const result = planCtfConsolidation(
    params('t3', {
      A: [proof('ks-A', 1, 'a-1')],
      B: [proof('ks-B', 1, 'b-1')],
      C: [proof('ks-C', 1, 'c-1')],
    }),
  )

  assert.deepEqual(result, {
    kind: 'noop',
    strategy: 't3',
    reason: 'net-collateral-nonpositive',
    feeSubunits: 1,
    inputPayoff: { A: 1, B: 1, C: 1 },
  })
})

test('skips parent-scoped consolidation because CDK convert is root-only', () => {
  const result = planCtfConsolidation({
    ...params('t3', {
      A: [proof('ks-A', 10, 'a-10')],
      B: [proof('ks-B', 10, 'b-10')],
      C: [proof('ks-C', 10, 'c-10')],
    }),
    parentCollectionId: 'A|B',
  })

  assert.deepEqual(result, {
    kind: 'noop',
    strategy: 't3',
    reason: 'unsupported-parent',
  })
})

test('payoff conservation uses the computed fee floor and covers F greater than 1', () => {
  const proofsByCollection = {
    A: manyProofs('ks-A', 334, 'a'),
    B: manyProofs('ks-B', 334, 'b'),
    C: manyProofs('ks-C', 333, 'c'),
  }
  const config = params('t3', proofsByCollection)
  const allProofs = Object.values(proofsByCollection).flat()
  const computedFee = computeConvertFeeSubunits(allProofs, config.inputFeePpkByKeyset)

  assert.equal(allProofs.length, 1001)
  assert.equal(computedFee, 2)

  const result = planCtfConsolidation(config)
  assert.equal(result.kind, 'plan')
  if (result.kind !== 'plan') return

  const inputPayoff = payoffVector(OUTCOMES, result.request.inputs)
  const outputPayoff = payoffVectorFromMessages(result.request.outputs)
  for (const outcome of OUTCOMES) {
    assert.equal(
      outputPayoff[outcome],
      inputPayoff[outcome] - computedFee,
      `${outcome} payoff should subtract computed F=${computedFee}`,
    )
  }
  assert.equal(result.feeSubunits, computedFee)
  assert.deepEqual(result.request.outputs[COLLATERAL_COLLECTION], [
    output('ks-base', 331, COLLATERAL_COLLECTION),
  ])
  assert.deepEqual(result.request.outputs['A|B'], [output('ks-A|B', 1, 'A|B')])
})

function params(
  strategy: CtfConsolidationParams['strategy'],
  proofsByCollection: Record<string, Proof[]>,
): CtfConsolidationParams {
  return {
    conditionId: CONDITION_ID,
    registration: {
      normalizedMint: 'https://mint.example',
      conditionId: CONDITION_ID,
      canonicalParentCollectionId: null,
      unit: 'msat',
      eventId: 'test',
      outcomes: OUTCOMES,
      threshold: 1,
      oracles: [],
    },
    outcomes: OUTCOMES,
    marketStatus: 'pending',
    strategy,
    proofsByCollection,
    inputFeePpkByKeyset: {
      'ks-A': 1,
      'ks-B': 1,
      'ks-C': 1,
      'ks-A|B': 1,
      'ks-A|C': 1,
      'ks-B|C': 1,
      'ks-base': 1,
    },
    outputKeysetByCollection: {
      A: 'ks-A',
      B: 'ks-B',
      C: 'ks-C',
      'A|B': 'ks-A|B',
      'A|C': 'ks-A|C',
      'B|C': 'ks-B|C',
      [COLLATERAL_COLLECTION]: 'ks-base',
    },
    makeOutputs: ({ collection, amountSubunits, keysetId }) => [
      output(keysetId, amountSubunits, collection),
    ],
  }
}

function proof(id: string, amount: number, label: string): Proof {
  return {
    id,
    amount,
    secret: `secret-${label}`,
    C: `C-${label}`,
  }
}

function manyProofs(id: string, count: number, label: string): Proof[] {
  return Array.from({ length: count }, (_, index) => proof(id, 1, `${label}-${index}`))
}

function output(keysetId: string, amount: number, collection: string): SerializedBlindedMessage {
  return {
    amount,
    id: keysetId,
    B_: `B-${collection}-${amount}`,
  }
}

function payoffVectorFromMessages(
  outputs: Record<string, SerializedBlindedMessage[]>,
): Record<string, number> {
  const proofsByCollection = Object.fromEntries(
    Object.entries(outputs).map(([collection, messages]) => [
      collection,
      messages.map(
        (message) =>
          ({
            id: message.id,
            amount: message.amount,
            secret: '',
            C: '',
          }) as Proof,
      ),
    ]),
  )
  return payoffVector(OUTCOMES, proofsByCollection)
}

test('consolidation uses registered wire order independently of display order', () => {
  const input = params('t1', {
    C: [proof('ks-C', 10, 'c-10')],
    A: [proof('ks-A', 10, 'a-10')],
    [COLLATERAL_COLLECTION]: [proof('ks-base', 1, 'fee')],
  })
  input.registration = { ...input.registration, outcomes: ['C', 'A', 'B'] }
  input.outputKeysetByCollection['C|A'] = 'ks-C|A'
  const result = planCtfConsolidation(input)
  assert.equal(result.kind, 'plan')
  if (result.kind !== 'plan') throw new Error('fixture did not consolidate')
  assert.deepEqual(result.request.outputs['C|A'], [output('ks-C|A', 10, 'C|A')])
  assert.equal(result.request.outputs['A|C'], undefined)
})

for (const [strategy, inputs] of [
  [
    't1',
    { A: [proof('ks-A', 10, 'a')], B: [proof('ks-B', 10, 'b')], '*': [proof('ks-base', 1, 'fee')] },
  ],
  ['t2', { 'B|C': [proof('ks-B|C', 2, 'na')], 'A|C': [proof('ks-A|C', 2, 'nb')] }],
  ['t3', { A: [proof('ks-A', 10, 'a')], B: [proof('ks-B', 10, 'b')], C: [proof('ks-C', 10, 'c')] }],
] as const) {
  test(`${strategy} pure amount planning preserves the public planner and delays output construction`, () => {
    const input = params(strategy, inputs)
    let calls = 0
    const factory = input.makeOutputs
    const observed = {
      ...input,
      makeOutputs: (value: Parameters<typeof factory>[0]) => {
        calls++
        return factory(value)
      },
    }
    const amountPlan = planCtfConsolidationAmounts(observed)
    assert.equal(calls, 0)
    assert.equal(amountPlan.kind, 'plan')
    if (amountPlan.kind !== 'plan') return
    assert.deepEqual(
      materializeCtfConsolidationPlan(amountPlan, observed.makeOutputs),
      planCtfConsolidation(input),
    )
    assert.equal(calls, amountPlan.outputs.length)
  })
}

const SPLIT_PARTITION = { NO: 'ks-NO', YES: 'ks-YES' }

function splitPlan(
  proofs: Proof[],
  amountSubunits: number,
  inputFeePpkByKeyset: Record<string, number> = { 'ks-base': 1_000 },
  partitionKeysets: Record<string, string> = SPLIT_PARTITION,
) {
  return planCtfCompleteSetSplit({
    conditionId: CONDITION_ID,
    partitionKeysets,
    collateralKeysetId: 'ks-change',
    proofs,
    inputFeePpkByKeyset,
    amountSubunits,
  })
}

test('a complete-set split pays the face amount to each outcome and returns the change', () => {
  const plan = splitPlan(
    [proof('ks-base', 8, 'base-8'), proof('ks-base', 64, 'base-64'), proof('ks-base', 32, 'b-32')],
    50,
  )
  assert.equal(plan.kind, 'plan')
  if (plan.kind !== 'plan') return
  // One 64 msat input at 1000 ppk costs 1 msat. 64 - 1 - 50 = 13 returns as change.
  assert.deepEqual(
    plan.inputs[COLLATERAL_COLLECTION]!.map(({ secret }) => secret),
    ['secret-base-64'],
  )
  assert.equal(plan.feeSubunits, 1)
  assert.equal(plan.collateralOutputSubunits, 13)
  assert.deepEqual(plan.outputs, [
    { collection: 'NO', amountSubunits: 50, keysetId: 'ks-NO' },
    { collection: 'YES', amountSubunits: 50, keysetId: 'ks-YES' },
    { collection: COLLATERAL_COLLECTION, amountSubunits: 13, keysetId: 'ks-change' },
  ])
  assert.deepEqual(plan.inputPayoff, { NO: 64, YES: 64 })
  assert.deepEqual(plan.outputPayoff, { NO: 63, YES: 63 })
})

test('a complete-set split with an exact cover has no change output', () => {
  const plan = splitPlan([proof('ks-base', 64, 'base-64')], 63)
  assert.equal(plan.kind, 'plan')
  if (plan.kind !== 'plan') return
  assert.equal(plan.collateralOutputSubunits, 0)
  assert.deepEqual(
    plan.outputs.map(({ collection }) => collection),
    ['NO', 'YES'],
  )
})

test('a complete-set split adds the input fee of each keyset', () => {
  const proofs = [proof('ks-a', 32, 'a-32'), proof('ks-b', 32, 'b-32')]
  const fees = { 'ks-a': 1_000, 'ks-b': 500 }
  // 1000 + 500 ppk round up to 2 msat, so 64 msat pay at most 62 msat.
  assert.deepEqual(splitPlan(proofs, 63, fees), { kind: 'refused', reason: 'insufficient-inputs' })
  const plan = splitPlan(proofs, 62, fees)
  assert.equal(plan.kind, 'plan')
  if (plan.kind !== 'plan') return
  assert.equal(plan.feeSubunits, 2)
  assert.equal(plan.collateralOutputSubunits, 0)
})

test('a complete-set split pays each collection of a partition with three outcomes', () => {
  const plan = splitPlan([proof('ks-base', 128, 'base-128')], 100, undefined, {
    A: 'ks-A',
    B: 'ks-B',
    C: 'ks-C',
  })
  assert.equal(plan.kind, 'plan')
  if (plan.kind !== 'plan') return
  assert.deepEqual(plan.outputPayoff, { A: 127, B: 127, C: 127 })
  assert.deepEqual(
    plan.outputs.map(({ collection, amountSubunits }) => [collection, amountSubunits]),
    [
      ['A', 100],
      ['B', 100],
      ['C', 100],
      [COLLATERAL_COLLECTION, 27],
    ],
  )
})

test('a complete-set split refuses before any effect when the mint cannot accept it', () => {
  assert.deepEqual(splitPlan([proof('ks-base', 16, 'base-16')], 16), {
    kind: 'refused',
    reason: 'insufficient-inputs',
  })
  assert.deepEqual(splitPlan([proof('ks-base', 64, 'base-64')], 16, { 'ks-base': 0 }), {
    kind: 'refused',
    reason: 'input-fee-floor-zero',
  })
  const ones = Array.from({ length: 300 }, (_, index) => proof('ks-base', 1, `one-${index}`))
  assert.deepEqual(splitPlan(ones, 280), { kind: 'refused', reason: 'input-limit' })
  const wide = Object.fromEntries(
    Array.from({ length: 16 }, (_, index) => [`O${index}`, `ks-O${index}`]),
  )
  assert.deepEqual(splitPlan([proof('ks-base', 64, 'base-64')], 16, undefined, wide), {
    kind: 'refused',
    reason: 'output-group-limit',
  })
})
