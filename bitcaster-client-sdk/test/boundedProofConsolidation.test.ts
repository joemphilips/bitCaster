import assert from 'node:assert/strict'
import test from 'node:test'
import {
  planBoundedProofConsolidation,
  planProofConsolidationRound,
} from '../src/boundedProofConsolidation.ts'

const KEYS = Object.fromEntries(
  Array.from({ length: 21 }, (_, exponent) => [String(2 ** exponent), `key-${exponent}`]),
)

test('plans the exact fee-paying reduction needed to fit an authorization', () => {
  assert.deepEqual(
    planBoundedProofConsolidation({
      inventory: [
        { amount: '4096', count: 2 },
        { amount: '2', count: 3 },
      ],
      target: '8194',
      inputFeePpk: 100,
      maxInputs: 3,
      maxRounds: 256,
      keysetKeys: KEYS,
    }),
    {
      kind: 'ready',
      consolidationRounds: [
        {
          inputs: ['4096', '4096', '2'],
          outputs: ['8192', '1'],
          fee: '1',
        },
      ],
      selectedInputs: ['8192', '2', '2'],
      consolidationFee: '1',
      sourceFee: '1',
    },
  )
})

test('handles a 10,000-proof inventory as denomination counts', () => {
  const result = planBoundedProofConsolidation({
    inventory: [{ amount: '1', count: 10_000 }],
    target: '9000',
    inputFeePpk: 1,
    maxInputs: 64,
    maxRounds: 256,
    keysetKeys: KEYS,
  })

  assert.equal(result.kind, 'ready')
  if (result.kind !== 'ready') return
  assert.ok(result.consolidationRounds.length <= 256)
  assert.ok(result.selectedInputs.length <= 64)
})

test('plans one bounded manual sweep round from at most 64 proof bodies', () => {
  assert.deepEqual(
    planProofConsolidationRound({
      inventory: [{ amount: '1', count: 64 }],
      inputFeePpk: 1,
      maxInputs: 64,
      keysetKeys: KEYS,
    }),
    {
      kind: 'ready',
      round: {
        inputs: Array.from({ length: 64 }, () => '1'),
        outputs: ['32', '16', '8', '4', '2', '1'],
        fee: '1',
      },
    },
  )
})

test('manual sweep reports groups that are already compact or cannot be reduced', () => {
  assert.equal(
    planProofConsolidationRound({
      inventory: [{ amount: '8', count: 1 }],
      inputFeePpk: 1,
      maxInputs: 64,
      keysetKeys: KEYS,
    }).kind,
    'not-needed',
  )
  assert.equal(
    planProofConsolidationRound({
      inventory: [
        { amount: '8', count: 1 },
        { amount: '4', count: 1 },
      ],
      inputFeePpk: 1_000,
      maxInputs: 64,
      keysetKeys: { '1': 'key-0' },
    }).kind,
    'not-reducible',
  )
})

test('returns the smallest fee-aware sufficient prefix instead of maxInputs', () => {
  const result = planBoundedProofConsolidation({
    inventory: [
      { amount: '100', count: 1 },
      { amount: '60', count: 3 },
    ],
    target: '150',
    inputFeePpk: 100,
    maxInputs: 4,
    maxRounds: 0,
    keysetKeys: KEYS,
  })

  assert.equal(result.kind, 'ready')
  if (result.kind !== 'ready') return
  assert.deepEqual(result.selectedInputs, ['100', '60'])
  assert.equal(result.sourceFee, '1')
})

test('refuses underfunded and non-reducing plans before any mint effect', () => {
  assert.equal(
    planBoundedProofConsolidation({
      inventory: [{ amount: '1', count: 4 }],
      target: '5',
      inputFeePpk: 1,
      maxInputs: 3,
      maxRounds: 256,
      keysetKeys: KEYS,
    }).kind,
    'insufficient',
  )
  assert.equal(
    planBoundedProofConsolidation({
      inventory: [
        { amount: '8', count: 1 },
        { amount: '4', count: 1 },
        { amount: '2', count: 2 },
      ],
      target: '14',
      inputFeePpk: 100,
      maxInputs: 3,
      maxRounds: 256,
      keysetKeys: KEYS,
    }).kind,
    'not-reducible',
  )
})

test('deterministic plans conserve value, reduce counts, terminate, and replay exactly', () => {
  for (let seed = 1; seed <= 96; seed += 1) {
    const inventory = Array.from({ length: 13 }, (_, exponent) => ({
      amount: String(2 ** exponent),
      count: ((seed * (exponent + 3)) % 19) + 1,
    }))
    const target = String(300 + seed * 41)
    const inputFeePpk = [1, 100, 333, 999][seed % 4]!
    const maxInputs = 8 + (seed % 25)
    const maxRounds = 256
    const plan = planBoundedProofConsolidation({
      inventory,
      target,
      inputFeePpk,
      maxInputs,
      maxRounds,
      keysetKeys: KEYS,
    })

    assert.ok(plan.consolidationRounds.length <= maxRounds)
    const executed = executeRounds(inventory, plan.consolidationRounds, inputFeePpk)
    if (plan.kind !== 'ready') continue

    assert.equal(
      plan.consolidationFee,
      plan.consolidationRounds.reduce((total, round) => total + BigInt(round.fee), 0n).toString(),
    )
    assertInputsAvailable(executed, plan.selectedInputs)
    const selectedTotal = sumStrings(plan.selectedInputs)
    const expectedSourceFee = feeForCount(inputFeePpk, plan.selectedInputs.length)
    assert.equal(plan.sourceFee, expectedSourceFee.toString())
    assert.ok(selectedTotal - expectedSourceFee >= BigInt(target))
    const previousInputs = plan.selectedInputs.slice(0, -1)
    assert.ok(
      sumStrings(previousInputs) - feeForCount(inputFeePpk, previousInputs.length) < BigInt(target),
    )

    const replay = planBoundedProofConsolidation({
      inventory: inventoryRows(executed),
      target,
      inputFeePpk,
      maxInputs,
      maxRounds: 0,
      keysetKeys: KEYS,
    })
    assert.equal(replay.kind, 'ready')
    if (replay.kind !== 'ready') continue
    assert.deepEqual(replay.selectedInputs, plan.selectedInputs)
    assert.equal(replay.sourceFee, plan.sourceFee)
    assert.deepEqual(replay.consolidationRounds, [])
  }
})

function executeRounds(
  initial: readonly { readonly amount: string; readonly count: number }[],
  rounds: readonly {
    readonly inputs: readonly string[]
    readonly outputs: readonly string[]
    readonly fee: string
  }[],
  inputFeePpk: number,
): Map<bigint, number> {
  const inventory = new Map(initial.map(({ amount, count }) => [BigInt(amount), count]))
  for (const round of rounds) {
    const expectedFee = feeForCount(inputFeePpk, round.inputs.length)
    assert.equal(BigInt(round.fee), expectedFee)
    assert.equal(sumStrings(round.inputs), sumStrings(round.outputs) + expectedFee)
    assert.ok(round.outputs.length < round.inputs.length)
    removeInputs(inventory, round.inputs)
    for (const amount of round.outputs.map((output) => BigInt(output))) {
      inventory.set(amount, (inventory.get(amount) ?? 0) + 1)
    }
  }
  return inventory
}

function removeInputs(inventory: Map<bigint, number>, inputs: readonly string[]): void {
  for (const rawAmount of inputs) {
    const amount = BigInt(rawAmount)
    const count = inventory.get(amount) ?? 0
    assert.ok(count > 0)
    if (count === 1) inventory.delete(amount)
    else inventory.set(amount, count - 1)
  }
}

function assertInputsAvailable(
  inventory: ReadonlyMap<bigint, number>,
  inputs: readonly string[],
): void {
  const retained = new Map(inventory)
  removeInputs(retained, inputs)
}

function inventoryRows(inventory: ReadonlyMap<bigint, number>): ProofCountRow[] {
  return [...inventory].map(([amount, count]) => ({ amount: amount.toString(), count }))
}

function sumStrings(amounts: readonly string[]): bigint {
  return amounts.reduce((total, amount) => total + BigInt(amount), 0n)
}

function feeForCount(inputFeePpk: number, count: number): bigint {
  return (BigInt(inputFeePpk) * BigInt(count) + 999n) / 1_000n
}

interface ProofCountRow {
  readonly amount: string
  readonly count: number
}
