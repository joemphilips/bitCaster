import assert from 'node:assert/strict'
import test from 'node:test'
import type { Proof } from '@cashu/cashu-ts'
import { planCtfRangeCapabilitySource } from '../src/ctfRangeCapabilitySourcePlan.ts'

const KEYS = Object.fromEntries(Array.from({ length: 16 }, (_, bit) => [String(2 ** bit), '02']))
const OFFERED = { id: 'conditional-a', inputFeePpk: 100, keys: KEYS }
const COLLATERAL = { id: 'regular', inputFeePpk: 100, keys: KEYS }
const COMPLEMENT = { id: 'conditional-b-c', inputFeePpk: 100, keys: KEYS }

const sourceInput = (
  overrides: Partial<Parameters<typeof planCtfRangeCapabilitySource>[0]> = {},
): Parameters<typeof planCtfRangeCapabilitySource>[0] => ({
  side: 'Sell',
  authorizationAmounts: ['8', '2'],
  offeredKeyset: OFFERED,
  collateralKeyset: COLLATERAL,
  complementKeyset: COMPLEMENT,
  offeredCandidates: [],
  collateralCandidates: [],
  maxInputs: 64,
  maxOutputs: 128,
  ...overrides,
})

test('keeps collateral-only preparation distinct and preserves payoff', () => {
  const plan = planCtfRangeCapabilitySource(
    sourceInput({ collateralCandidates: [proof(COLLATERAL.id, 16)] }),
  )

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

test('plans held Sell sources with full face and one joint fee calculation', async (t) => {
  const highFeeOffered = { ...OFFERED, inputFeePpk: 1_000 }
  const highFeeCollateral = { ...COLLATERAL, inputFeePpk: 1_000 }
  const quarterFeeOffered = { ...OFFERED, inputFeePpk: 250 }
  const quarterFeeCollateral = { ...COLLATERAL, inputFeePpk: 250 }
  const lowFeeOffered = { ...OFFERED, inputFeePpk: 1 }
  const lowFeeCollateral = { ...COLLATERAL, inputFeePpk: 1 }
  const reselectionOffered = { ...OFFERED, inputFeePpk: 2_500 }
  const reselectionCollateral = { ...COLLATERAL, inputFeePpk: 500 }
  const cases = [
    {
      name: 'exact Q with exact fee cash',
      input: sourceInput({
        offeredKeyset: highFeeOffered,
        collateralKeyset: highFeeCollateral,
        offeredCandidates: [proof(highFeeOffered.id, 10)],
        collateralCandidates: [proof(highFeeCollateral.id, 2)],
      }),
      kind: 'mixed-source-ctf-convert',
      target: 10,
      fee: 2,
      offeredChange: 0,
      collateralChange: 0,
      inputCount: 2,
    },
    {
      name: 'conditional and regular change',
      input: sourceInput({
        offeredKeyset: highFeeOffered,
        collateralKeyset: highFeeCollateral,
        offeredCandidates: [proof(highFeeOffered.id, 12)],
        collateralCandidates: [proof(highFeeCollateral.id, 5)],
      }),
      kind: 'mixed-source-ctf-convert',
      target: 10,
      fee: 2,
      offeredChange: 2,
      collateralChange: 3,
      inputCount: 2,
    },
    {
      name: 'insufficient regular cash refuses when held fee funding is also short',
      input: sourceInput({
        offeredKeyset: highFeeOffered,
        collateralKeyset: highFeeCollateral,
        offeredCandidates: [proof(highFeeOffered.id, 10)],
        collateralCandidates: [proof(highFeeCollateral.id, 1)],
      }),
      kind: 'source-unavailable',
      shortfall: 'collateral',
    },
    {
      name: 'missing held shares name the offered asset even with fee cash',
      input: sourceInput({
        offeredKeyset: highFeeOffered,
        collateralKeyset: highFeeCollateral,
        offeredCandidates: [proof(highFeeOffered.id, 9)],
        collateralCandidates: [proof(highFeeCollateral.id, 2)],
      }),
      kind: 'source-unavailable',
      shortfall: 'offered',
    },
    {
      name: 'a short Buy names its offered regular cash',
      input: sourceInput({
        side: 'Buy',
        offeredKeyset: COLLATERAL,
        offeredCandidates: [proof(COLLATERAL.id, 10)],
      }),
      kind: 'source-unavailable',
      shortfall: 'offered',
    },
    {
      name: 'partial holding stays outside mixed inputs',
      input: sourceInput({
        offeredCandidates: [proof(OFFERED.id, 4)],
        collateralCandidates: [proof(COLLATERAL.id, 16)],
      }),
      kind: 'collateral-ctf-convert',
    },
    {
      name: 'multiple proof fees round once across both groups',
      input: sourceInput({
        offeredKeyset: quarterFeeOffered,
        collateralKeyset: quarterFeeCollateral,
        offeredCandidates: [
          proof(quarterFeeOffered.id, 5, 'held-5a'),
          proof(quarterFeeOffered.id, 5, 'held-5b'),
        ],
        collateralCandidates: [proof(quarterFeeCollateral.id, 1)],
      }),
      kind: 'mixed-source-ctf-convert',
      target: 10,
      fee: 1,
      offeredChange: 0,
      collateralChange: 0,
      inputCount: 3,
    },
    {
      name: 'one-msat joint fee funds a 1,000-msat held share',
      input: sourceInput({
        authorizationAmounts: ['1000'],
        offeredKeyset: lowFeeOffered,
        collateralKeyset: lowFeeCollateral,
        offeredCandidates: [proof(lowFeeOffered.id, 1_000)],
        collateralCandidates: [proof(lowFeeCollateral.id, 1)],
      }),
      kind: 'mixed-source-ctf-convert',
      target: 1_000,
      fee: 1,
      offeredChange: 0,
      collateralChange: 0,
      inputCount: 2,
    },
    {
      name: 'reselects collateral when the added proof changes the joint fee',
      input: sourceInput({
        offeredKeyset: reselectionOffered,
        collateralKeyset: reselectionCollateral,
        offeredCandidates: [proof(reselectionOffered.id, 10)],
        collateralCandidates: [
          proof(reselectionCollateral.id, 2),
          proof(reselectionCollateral.id, 1, 'cash-1a'),
          proof(reselectionCollateral.id, 1, 'cash-1b'),
        ],
      }),
      kind: 'mixed-source-ctf-convert',
      target: 10,
      fee: 4,
      offeredChange: 0,
      collateralChange: 0,
      inputCount: 4,
    },
    {
      name: 'total input bound includes both asset groups',
      input: sourceInput({
        offeredKeyset: highFeeOffered,
        collateralKeyset: highFeeCollateral,
        offeredCandidates: [proof(highFeeOffered.id, 10)],
        collateralCandidates: [proof(highFeeCollateral.id, 2)],
        maxInputs: 1,
      }),
      kind: 'source-unavailable',
      shortfall: 'mint-limits',
    },
    {
      name: 'the input bound without fee cash names the missing cash',
      input: sourceInput({
        offeredKeyset: highFeeOffered,
        collateralKeyset: highFeeCollateral,
        offeredCandidates: [proof(highFeeOffered.id, 10)],
        maxInputs: 1,
      }),
      kind: 'source-unavailable',
      shortfall: 'collateral',
    },
    {
      name: 'fee cash present but the joint outputs exceed the output bound',
      input: sourceInput({
        offeredKeyset: highFeeOffered,
        collateralKeyset: highFeeCollateral,
        offeredCandidates: [proof(highFeeOffered.id, 10)],
        collateralCandidates: [proof(highFeeCollateral.id, 3)],
        maxOutputs: 2,
      }),
      kind: 'source-unavailable',
      shortfall: 'mint-limits',
    },
    {
      name: 'fee cash present but the held shares exceed the input bound',
      input: sourceInput({
        offeredCandidates: Array.from({ length: 10 }, (_, index) =>
          proof(OFFERED.id, 1, `held-1-${index}`),
        ),
        collateralCandidates: [proof(COLLATERAL.id, 2)],
        maxInputs: 4,
      }),
      kind: 'source-unavailable',
      shortfall: 'mint-limits',
    },
    {
      name: 'cash covering face and fee does not replace held shares above the input bound',
      input: sourceInput({
        authorizationAmounts: ['8192', '2048', '512', '128', '64', '32', '16', '8'],
        offeredCandidates: Array.from({ length: 11 }, (_, share) =>
          [512, 256, 128, 64, 32, 8].map((amount) =>
            proof(OFFERED.id, amount, `share-${share}-${amount}`),
          ),
        ).flat(),
        collateralCandidates: [proof(COLLATERAL.id, 16_384)],
        maxInputs: 64,
      }),
      kind: 'source-unavailable',
      shortfall: 'mint-limits',
    },
    {
      name: 'fragmented fee cash that fits without the input bound names the mint limit',
      input: sourceInput({
        offeredKeyset: highFeeOffered,
        offeredCandidates: [
          proof(highFeeOffered.id, 5),
          proof(highFeeOffered.id, 3),
          proof(highFeeOffered.id, 2),
        ],
        collateralCandidates: [
          proof(COLLATERAL.id, 2, 'cash-2a'),
          proof(COLLATERAL.id, 2, 'cash-2b'),
          proof(COLLATERAL.id, 2, 'cash-2c'),
        ],
        maxInputs: 4,
      }),
      kind: 'source-unavailable',
      shortfall: 'mint-limits',
    },
  ] as const

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const plan = planCtfRangeCapabilitySource(scenario.input)
      assert.equal(plan.kind, scenario.kind)
      if (scenario.kind === 'source-unavailable') {
        if (plan.kind !== 'source-unavailable') return
        assert.equal(plan.shortfall, scenario.shortfall)
      }
      if (scenario.kind === 'mixed-source-ctf-convert') {
        if (plan.kind !== 'mixed-source-ctf-convert') return
        assert.equal(plan.inputFee, scenario.fee)
        assert.equal(
          sum(plan.offeredInputs.map(({ amount }) => Number(amount))),
          scenario.target + scenario.offeredChange,
        )
        assert.equal(
          sum(plan.collateralInputs.map(({ amount }) => Number(amount))),
          scenario.fee + scenario.collateralChange,
        )
        assert.equal(sum(plan.offeredChangeAmounts), scenario.offeredChange)
        assert.equal(sum(plan.collateralChangeAmounts), scenario.collateralChange)
        assert.equal(sum(plan.authorizationAmounts), scenario.target)
        assert.equal(plan.offeredInputs.length + plan.collateralInputs.length, scenario.inputCount)
      }
      if (scenario.name === 'partial holding stays outside mixed inputs') {
        if (plan.kind !== 'collateral-ctf-convert') return
        assert.equal(plan.inputs.includes(scenario.input.offeredCandidates[0]!), false)
        assert.equal(
          plan.inputs.every(({ id }) => id === COLLATERAL.id),
          true,
        )
      }
    })
  }
})

test('falls back to same-keyset Sell when cash does not cover its joint fee', () => {
  const plan = planCtfRangeCapabilitySource(
    sourceInput({
      offeredCandidates: [proof(OFFERED.id, 11)],
    }),
  )

  assert.equal(plan.kind, 'same-keyset-swap')
  if (plan.kind !== 'same-keyset-swap') return
  assert.equal(plan.inputFee, 1)
  assert.equal(plan.changeAmount, 0)
})

test('falls back when mixed change would exceed the output bound', () => {
  const offeredKeyset = { ...OFFERED, inputFeePpk: 1_000 }
  const collateralKeyset = { ...COLLATERAL, inputFeePpk: 1_000 }
  const plan = planCtfRangeCapabilitySource(
    sourceInput({
      offeredKeyset,
      collateralKeyset,
      offeredCandidates: [proof(offeredKeyset.id, 12)],
      collateralCandidates: [proof(collateralKeyset.id, 3)],
      maxOutputs: 3,
    }),
  )

  assert.equal(plan.kind, 'same-keyset-swap')
  if (plan.kind !== 'same-keyset-swap') return
  assert.equal(plan.inputFee, 1)
  assert.equal(plan.changeAmount, 1)
})

test('rejects a source that exceeds the output limit before mint I/O', () => {
  assert.throws(
    () =>
      planCtfRangeCapabilitySource(
        sourceInput({ collateralCandidates: [proof(COLLATERAL.id, 16)], maxOutputs: 2 }),
      ),
    /output limit/,
  )
})

test('requests consolidation instead of bypassing sufficiently funded fragmented inventory', () => {
  const plan = planCtfRangeCapabilitySource(
    sourceInput({
      authorizationAmounts: ['4'],
      offeredCandidates: Array.from({ length: 5 }, (_, index) =>
        proof(OFFERED.id, 1, `fragment-${index}`),
      ),
      collateralCandidates: [proof(COLLATERAL.id, 16)],
      maxInputs: 4,
    }),
  )

  assert.deepEqual(plan, {
    kind: 'consolidation-required',
    keysetId: OFFERED.id,
    selectedInputCount: 5,
    maxInputs: 4,
  })
})

test('preserves payoff for collateral-only source proof counts', () => {
  for (const target of [1, 2, 3, 7, 10, 31]) {
    for (const inputAmounts of [[target + 1], [target + 2, 1], [target + 4, 2, 1]]) {
      const plan = planCtfRangeCapabilitySource(
        sourceInput({
          authorizationAmounts: [String(target)],
          collateralCandidates: inputAmounts.map((amount, index) =>
            proof(COLLATERAL.id, amount, `property-${target}-${index}`),
          ),
        }),
      )
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

test('rejects duplicate and wrong-keyset source candidates', () => {
  assert.throws(
    () =>
      planCtfRangeCapabilitySource(
        sourceInput({
          offeredCandidates: [{ ...proof(OFFERED.id, 10), secret: 'duplicate-secret' }],
          collateralCandidates: [{ ...proof(COLLATERAL.id, 2), secret: 'duplicate-secret' }],
        }),
      ),
    /duplicate proof/,
  )
  assert.throws(
    () =>
      planCtfRangeCapabilitySource(sourceInput({ offeredCandidates: [proof(COLLATERAL.id, 10)] })),
    /foreign keyset/,
  )
})

test('allows a Buy to reuse one regular proof in alternative candidate views', () => {
  const candidate = proof(COLLATERAL.id, 11)
  const plan = planCtfRangeCapabilitySource(
    sourceInput({
      side: 'Buy',
      offeredKeyset: COLLATERAL,
      offeredCandidates: [candidate],
      collateralCandidates: [candidate],
    }),
  )

  assert.equal(plan.kind, 'same-keyset-swap')
})

function proof(id: string, amount: number, suffix = String(amount)): Proof {
  return { id, amount, secret: `${id}-${suffix}`, C: '02' }
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}
