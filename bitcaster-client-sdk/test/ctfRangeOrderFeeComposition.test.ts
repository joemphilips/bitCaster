import assert from 'node:assert/strict'
import test from 'node:test'
import { planBoundedProofConsolidation } from '../src/boundedProofConsolidation.ts'
import {
  planCtfRangeOrderAuthorization,
  type CtfRangeOrderAuthorizationPlan,
} from '../src/ctfRangeOrderAuthorization.ts'
import {
  assertCtfRangeOrderFeeConsent,
  composeCtfRangeOrderFeeFacts,
  type CtfRangeOrderFeeFacts,
} from '../src/ctfRangeOrderFeeComposition.ts'

const KEYS = Object.fromEntries(
  Array.from({ length: 21 }, (_, exponent) => [String(2 ** exponent), `key-${exponent}`]),
)

const REGULAR_ASSET = { kind: 'regular', unit: 'msat' } as const
const CONDITIONAL_ASSET = {
  kind: 'conditional',
  unit: 'msat',
  conditionId: 'condition-1',
  outcomeCollection: 'YES',
} as const

test('composes exact fees and excludes reserved buy headroom', () => {
  const authorization = authorizationWithHeadroom()
  const sourcePlan = sourcePlanWithFees()
  const facts = composeCtfRangeOrderFeeFacts({
    authorizationPlan: authorization,
    sourcePlan,
    settlementAsset: REGULAR_ASSET,
    preparationAsset: REGULAR_ASSET,
  })

  assert.deepEqual(facts, {
    settlementInputFeeSubunits: '3',
    sourcePreparationFeeSubunits: '1',
    consolidationFeeSubunits: '1',
    settlementAsset: REGULAR_ASSET,
    preparationAsset: REGULAR_ASSET,
  })
  assert.equal(Object.hasOwn(facts, 'reservedFeeHeadroom'), false)
})

test('accepts an unchanged consent after one consolidation payment', () => {
  const facts = composeFacts()
  const consented = { ...facts, consolidationFeeSubunits: '3' }
  const current = { ...facts, consolidationFeeSubunits: '2' }

  assert.doesNotThrow(() =>
    assertCtfRangeOrderFeeConsent({
      consented,
      current,
      paidConsolidationFeeSubunits: '1',
    }),
  )
})

test('preserves valid long conditional asset identities', () => {
  const longAsset = {
    ...CONDITIONAL_ASSET,
    outcomeCollection: 'Y'.repeat(257),
  }
  const facts = composeCtfRangeOrderFeeFacts({
    authorizationPlan: authorizationForSell(),
    sourcePlan: sourcePlanWithFees(),
    settlementAsset: REGULAR_ASSET,
    preparationAsset: longAsset,
  })

  assert.equal(facts.preparationAsset.kind, 'conditional')
  assert.equal(facts.preparationAsset.outcomeCollection, longAsset.outcomeCollection)
})

test('rejects every changed consented fee fact', () => {
  const facts = composeFacts()

  for (const field of [
    'settlementInputFeeSubunits',
    'sourcePreparationFeeSubunits',
    'consolidationFeeSubunits',
  ] as const) {
    const current = { ...facts, [field]: '2' }
    assert.throws(
      () =>
        assertCtfRangeOrderFeeConsent({
          consented: facts,
          current,
          paidConsolidationFeeSubunits: '0',
        }),
      /^Error: CTF range fee consent does not match the current preparation plan$/,
    )
  }
})

test('rejects a changed settlement or preparation asset identity', () => {
  const facts = composeFacts()

  assert.throws(
    () =>
      assertCtfRangeOrderFeeConsent({
        consented: facts,
        current: { ...facts, settlementAsset: CONDITIONAL_ASSET },
        paidConsolidationFeeSubunits: '0',
      }),
    /^Error: CTF range fee consent does not match the current preparation plan$/,
  )
  assert.throws(
    () =>
      assertCtfRangeOrderFeeConsent({
        consented: facts,
        current: {
          ...facts,
          preparationAsset: { ...CONDITIONAL_ASSET, outcomeCollection: 'NO' },
        },
        paidConsolidationFeeSubunits: '0',
      }),
    /^Error: CTF range fee consent does not match the current preparation plan$/,
  )
})

test('rejects malformed, unsafe, and overpaid fee facts', () => {
  const facts = composeFacts()

  for (const value of ['', '-1', '01', '1.0', '1e3', 1, (1n << 64n).toString()]) {
    assert.throws(() =>
      composeCtfRangeOrderFeeFacts({
        authorizationPlan: {
          ...authorizationWithHeadroom(),
          participantFeeAllocationUpperBound: value as string,
        },
        sourcePlan: sourcePlanWithFees(),
        settlementAsset: REGULAR_ASSET,
        preparationAsset: REGULAR_ASSET,
      }),
    )
  }

  assert.throws(() =>
    assertCtfRangeOrderFeeConsent({
      consented: facts,
      current: facts,
      paidConsolidationFeeSubunits: '2',
    }),
  )
})

function composeFacts(): CtfRangeOrderFeeFacts {
  return composeCtfRangeOrderFeeFacts({
    authorizationPlan: authorizationWithHeadroom(),
    sourcePlan: sourcePlanWithFees(),
    settlementAsset: REGULAR_ASSET,
    preparationAsset: REGULAR_ASSET,
  })
}

function authorizationWithHeadroom(): CtfRangeOrderAuthorizationPlan {
  return planCtfRangeOrderAuthorization({
    side: 'Buy',
    priceNumerator: 12,
    amountSubunits: 1_000,
    divisibility: 1_000,
    inputFeePpk: 2_500,
    offerKeysetKeys: KEYS,
    maxPoolEntries: 128,
  })
}

function authorizationForSell(): CtfRangeOrderAuthorizationPlan {
  return planCtfRangeOrderAuthorization({
    side: 'Sell',
    priceNumerator: 420,
    amountSubunits: 1_000,
    divisibility: 1_000,
    inputFeePpk: 2_500,
    offerKeysetKeys: KEYS,
    maxPoolEntries: 128,
  })
}

function sourcePlanWithFees() {
  const plan = planBoundedProofConsolidation({
    inventory: [
      { amount: '4096', count: 2 },
      { amount: '2', count: 3 },
    ],
    target: '8194',
    inputFeePpk: 100,
    maxInputs: 3,
    maxRounds: 256,
    keysetKeys: KEYS,
  })
  assert.equal(plan.kind, 'ready')
  return plan
}
