import assert from 'node:assert/strict'
import test from 'node:test'
import type { CtfRangeCapabilitySourcePlan } from '../src/ctfRangeCapabilitySourcePlan.ts'
import {
  planCtfRangeOrderAuthorization,
  type CtfRangeOrderAuthorizationPlan,
} from '../src/ctfRangeOrderAuthorization.ts'
import {
  summarizeCtfRangeOrderFees,
  regularCtfRangeOrderFeeTotal,
  assertCtfRangeOrderFeeConsent,
  composeCtfRangeOrderFeeFacts,
  type CtfRangeOrderFeeFacts,
} from '../src/ctfRangeOrderFeeComposition.ts'
import type { CtfRangeSourceMode } from '../src/ctfRangeSourceOperation.ts'
import type { DurableCtfRangeAsset } from '../src/durableCtfRangeOperation.ts'

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
const OTHER_CONDITIONAL_ASSET = { ...CONDITIONAL_ASSET, outcomeCollection: 'NO' } as const

test('composes shared source fees and explicit asset facts', () => {
  const cases = [
    {
      name: 'ordinary Buy',
      sourcePlan: sameKeysetSourcePlan(1),
      sourceMode: 'wallet-send',
      sourcePreparationAsset: REGULAR_ASSET,
      consolidationFeeSubunits: '0',
      consolidationAsset: REGULAR_ASSET,
      expectedSourceFeeSubunits: '1',
    },
    {
      name: 'same-keyset Sell',
      sourcePlan: sameKeysetSourcePlan(2),
      sourceMode: 'conditional-keyset-swap',
      sourcePreparationAsset: CONDITIONAL_ASSET,
      consolidationFeeSubunits: '0',
      consolidationAsset: CONDITIONAL_ASSET,
      expectedSourceFeeSubunits: '2',
    },
    {
      name: 'mixed Sell pays source fee in regular cash and consolidation fee in conditional value',
      sourcePlan: mixedSourcePlan(3),
      sourceMode: 'mixed-source-ctf-convert',
      sourcePreparationAsset: REGULAR_ASSET,
      consolidationFeeSubunits: '4',
      consolidationAsset: CONDITIONAL_ASSET,
      expectedSourceFeeSubunits: '3',
    },
  ] as const satisfies readonly {
    name: string
    sourcePlan: CtfRangeCapabilitySourcePlan
    sourceMode: CtfRangeSourceMode
    sourcePreparationAsset: DurableCtfRangeAsset
    consolidationFeeSubunits: string
    consolidationAsset: DurableCtfRangeAsset
    expectedSourceFeeSubunits: string
  }[]

  for (const scenario of cases) {
    const facts = composeCtfRangeOrderFeeFacts({
      authorizationPlan: authorizationWithHeadroom(),
      sourcePlan: scenario.sourcePlan,
      sourceMode: scenario.sourceMode,
      consolidationFeeSubunits: scenario.consolidationFeeSubunits,
      settlementAsset: REGULAR_ASSET,
      sourcePreparationAsset: scenario.sourcePreparationAsset,
      consolidationAsset: scenario.consolidationAsset,
    })

    assert.deepEqual(
      facts,
      {
        settlementInputFeeSubunits: '3',
        sourcePreparationFeeSubunits: scenario.expectedSourceFeeSubunits,
        consolidationFeeSubunits: scenario.consolidationFeeSubunits,
        settlementAsset: REGULAR_ASSET,
        sourcePreparationAsset: scenario.sourcePreparationAsset,
        consolidationAsset: scenario.consolidationAsset,
        sourceMode: scenario.sourceMode,
      },
      scenario.name,
    )
    assert.equal(Object.hasOwn(facts, 'reservedFeeHeadroom'), false)
  }
})

test('accounts for consolidation fees already paid', () => {
  assert.doesNotThrow(() =>
    assertCtfRangeOrderFeeConsent({
      consented: composeFacts({ consolidationFeeSubunits: '3' }),
      current: composeFacts({ consolidationFeeSubunits: '2' }),
      paidConsolidationFeeSubunits: '1',
    }),
  )
})

test('rejects changed numeric fees and settlement asset identity', () => {
  const consented = composeFacts()
  for (const change of [
    { settlementInputFeeSubunits: '4' },
    { sourcePreparationFeeSubunits: '2' },
    { consolidationFeeSubunits: '2' },
    { settlementAsset: CONDITIONAL_ASSET },
  ]) {
    assert.throws(
      () =>
        assertCtfRangeOrderFeeConsent({
          consented,
          current: { ...consented, ...change },
          paidConsolidationFeeSubunits: '0',
        }),
      /^Error: CTF range fee consent does not match the current preparation plan$/,
    )
  }
})

test('rejects equal totals when the source mode or a fee asset changes', () => {
  const cases = [
    {
      name: 'source mode',
      consented: composeFacts({
        sourcePlan: mixedSourcePlan(1),
        sourceMode: 'mixed-source-ctf-convert',
        consolidationAsset: CONDITIONAL_ASSET,
      }),
      current: composeFacts({ consolidationAsset: CONDITIONAL_ASSET }),
    },
    {
      name: 'source fee asset',
      consented: composeFacts({
        sourceMode: 'conditional-keyset-swap',
        sourcePreparationAsset: CONDITIONAL_ASSET,
      }),
      current: composeFacts({
        sourceMode: 'conditional-keyset-swap',
        sourcePreparationAsset: OTHER_CONDITIONAL_ASSET,
      }),
    },
    {
      name: 'source fee condition',
      consented: composeFacts({
        sourceMode: 'conditional-keyset-swap',
        sourcePreparationAsset: CONDITIONAL_ASSET,
      }),
      current: composeFacts({
        sourceMode: 'conditional-keyset-swap',
        sourcePreparationAsset: { ...CONDITIONAL_ASSET, conditionId: 'another-condition' },
      }),
    },
    {
      name: 'consolidation fee asset',
      consented: composeFacts({
        sourcePlan: mixedSourcePlan(1),
        sourceMode: 'mixed-source-ctf-convert',
        consolidationAsset: CONDITIONAL_ASSET,
      }),
      current: composeFacts({
        sourcePlan: mixedSourcePlan(1),
        sourceMode: 'mixed-source-ctf-convert',
        consolidationAsset: REGULAR_ASSET,
      }),
    },
  ] as const

  for (const scenario of cases) {
    assert.equal(
      scenario.consented.sourcePreparationFeeSubunits,
      scenario.current.sourcePreparationFeeSubunits,
    )
    assert.equal(
      scenario.consented.consolidationFeeSubunits,
      scenario.current.consolidationFeeSubunits,
    )
    assert.throws(
      () =>
        assertCtfRangeOrderFeeConsent({
          consented: scenario.consented,
          current: scenario.current,
          paidConsolidationFeeSubunits: '0',
        }),
      /^Error: CTF range fee consent does not match the current preparation plan$/,
      scenario.name,
    )
  }
})

test('preserves conditional asset identity and rejects mismatched plans or assets', () => {
  const longAsset = { ...CONDITIONAL_ASSET, outcomeCollection: 'Y'.repeat(257) }
  const facts = composeFacts({
    sourceMode: 'conditional-keyset-swap',
    sourcePreparationAsset: longAsset,
  })
  assert.deepEqual(facts.sourcePreparationAsset, longAsset)

  assert.throws(() =>
    composeFacts({ sourcePlan: { kind: 'source-unavailable', shortfall: 'offered' } }),
  )
  assert.throws(() => composeFacts({ sourcePlan: mixedSourcePlan(1), sourceMode: 'wallet-send' }))
  assert.throws(() =>
    composeFacts({
      sourcePlan: mixedSourcePlan(1),
      sourceMode: 'mixed-source-ctf-convert',
      sourcePreparationAsset: CONDITIONAL_ASSET,
    }),
  )
})

test('rejects malformed and overflowing fee facts', () => {
  const facts = composeFacts()
  const maximumFee = ((1n << 64n) - 1n).toString()

  for (const value of ['', '-1', '01', '1.0', '1e3', 1, (1n << 64n).toString()]) {
    assert.throws(() =>
      composeCtfRangeOrderFeeFacts({
        authorizationPlan: {
          ...authorizationWithHeadroom(),
          participantFeeAllocationUpperBound: value as string,
        },
        sourcePlan: sameKeysetSourcePlan(1),
        sourceMode: 'wallet-send',
        consolidationFeeSubunits: '0',
        settlementAsset: REGULAR_ASSET,
        sourcePreparationAsset: REGULAR_ASSET,
        consolidationAsset: REGULAR_ASSET,
      }),
    )
  }
  for (const inputFee of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
    assert.throws(() => composeFacts({ sourcePlan: sameKeysetSourcePlan(inputFee) }))
  }
  assert.throws(() => composeFacts({ consolidationFeeSubunits: '01' }))
  assert.throws(() =>
    assertCtfRangeOrderFeeConsent({
      consented: facts,
      current: facts,
      paidConsolidationFeeSubunits: '2',
    }),
  )
  assert.throws(() =>
    assertCtfRangeOrderFeeConsent({
      consented: { ...facts, consolidationFeeSubunits: maximumFee },
      current: { ...facts, consolidationFeeSubunits: '1' },
      paidConsolidationFeeSubunits: maximumFee,
    }),
  )
})

function composeFacts(
  input: {
    readonly sourcePlan?: CtfRangeCapabilitySourcePlan
    readonly sourceMode?: CtfRangeSourceMode
    readonly consolidationFeeSubunits?: string
    readonly sourcePreparationAsset?: DurableCtfRangeAsset
    readonly consolidationAsset?: DurableCtfRangeAsset
  } = {},
): CtfRangeOrderFeeFacts {
  const sourceMode = input.sourceMode ?? 'wallet-send'
  return composeCtfRangeOrderFeeFacts({
    authorizationPlan: authorizationWithHeadroom(),
    sourcePlan: input.sourcePlan ?? sameKeysetSourcePlan(1),
    sourceMode,
    consolidationFeeSubunits: input.consolidationFeeSubunits ?? '1',
    settlementAsset: REGULAR_ASSET,
    sourcePreparationAsset: input.sourcePreparationAsset ?? REGULAR_ASSET,
    consolidationAsset: input.consolidationAsset ?? REGULAR_ASSET,
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

function sameKeysetSourcePlan(inputFee: number): CtfRangeCapabilitySourcePlan {
  return {
    kind: 'same-keyset-swap',
    inputs: [],
    inputFee,
    authorizationAmounts: [10],
    changeAmount: 0,
  }
}

function mixedSourcePlan(inputFee: number): CtfRangeCapabilitySourcePlan {
  return {
    kind: 'mixed-source-ctf-convert',
    offeredInputs: [],
    collateralInputs: [],
    inputFee,
    authorizationAmounts: [10],
    offeredChangeAmounts: [],
    collateralChangeAmounts: [],
  }
}

test('fee summary combines only identical assets and retains exact fractional cash', () => {
  const facts: CtfRangeOrderFeeFacts = {
    settlementInputFeeSubunits: '1',
    sourcePreparationFeeSubunits: '2',
    consolidationFeeSubunits: '3',
    settlementAsset: REGULAR_ASSET,
    sourcePreparationAsset: REGULAR_ASSET,
    consolidationAsset: REGULAR_ASSET,
    sourceMode: 'wallet-send',
  }
  assert.deepEqual(summarizeCtfRangeOrderFees(facts), [
    { asset: REGULAR_ASSET, amountSubunits: 6n },
  ])
  assert.equal(regularCtfRangeOrderFeeTotal(facts), 6n)
  const mixed = {
    ...facts,
    sourcePreparationAsset: CONDITIONAL_ASSET,
    consolidationAsset: CONDITIONAL_ASSET,
    sourceMode: 'conditional-keyset-swap' as const,
  }
  assert.deepEqual(summarizeCtfRangeOrderFees(mixed), [
    { asset: REGULAR_ASSET, amountSubunits: 1n },
    { asset: CONDITIONAL_ASSET, amountSubunits: 5n },
  ])
  assert.equal(regularCtfRangeOrderFeeTotal(mixed), 1n)
  for (const asset of [
    { ...CONDITIONAL_ASSET, outcomeCollection: 'NO' },
    { ...CONDITIONAL_ASSET, conditionId: 'condition-2' },
  ]) {
    const totals = summarizeCtfRangeOrderFees({ ...mixed, consolidationAsset: asset })
    assert.equal(totals.length, 3)
    assert.equal(totals[1].amountSubunits, 2n)
    assert.equal(totals[2].amountSubunits, 3n)
  }
  assert.equal(
    summarizeCtfRangeOrderFees({
      ...facts,
      settlementInputFeeSubunits: '0',
      sourcePreparationFeeSubunits: '0',
      consolidationFeeSubunits: '0',
    })[0].amountSubunits,
    0n,
  )
})
