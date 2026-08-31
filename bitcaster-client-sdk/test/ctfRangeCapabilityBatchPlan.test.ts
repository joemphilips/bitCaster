import assert from 'node:assert/strict'
import test from 'node:test'
import type { Proof } from '@cashu/cashu-ts'
import {
  planCtfRangeCapabilityBatches,
  type CtfRangeCapabilityBatchChild,
  type CtfRangeCapabilityBatchPlanInput,
  type CtfRangeCapabilityParentMeasureInput,
} from '../src/ctfRangeCapabilityBatchPlan.ts'
import { planCtfRangeOrderAuthorization } from '../src/ctfRangeOrderAuthorization.ts'
import { DURABLE_ARTIFACT_BYTES_LIMIT_MAX } from '../src/durableCustody.ts'

const KEYS = Object.fromEntries(Array.from({ length: 20 }, (_, bit) => [String(2 ** bit), '02']))
const COLLATERAL = { id: 'regular', inputFeePpk: 100, keys: KEYS }
const CONDITIONAL_A = { id: 'conditional-a', inputFeePpk: 100, keys: KEYS }
const CONDITIONAL_B = { id: 'conditional-b', inputFeePpk: 100, keys: KEYS }
const COMPLEMENT = { id: 'conditional-complement', inputFeePpk: 100, keys: KEYS }

test('canonical ordering and digest are invariant under child and proof permutations', () => {
  const children = [
    child('c3', 'route-b', 'Sell', 30, 4, CONDITIONAL_A),
    child('c1', 'route-a', 'Sell', 20, 8, CONDITIONAL_A),
    child('c2', 'route-a', 'Buy', 20, 4, COLLATERAL),
  ]
  const inventory = [proof(COLLATERAL.id, 64, 'z'), proof(COLLATERAL.id, 32, 'a')]

  const first = planCtfRangeCapabilityBatches(baseInput(children, inventory))
  const second = planCtfRangeCapabilityBatches(
    baseInput([children[2]!, children[0]!, children[1]!], [inventory[1]!, inventory[0]!]),
  )

  assert.deepEqual(first, second)
  assert.deepEqual(first.canonicalChildIds, ['c2', 'c1', 'c3'])
  assert.equal(first.parents.length, 1)
  assert.equal(first.parents[0]?.kind, 'collateral-ctf-convert')
  assert.match(first.packingDigest, /^[0-9a-f]{64}$/)
})

test('uses locale-independent UTF-16 code-unit order for route authority', () => {
  const children = [
    child('japanese', 'あ', 'Sell', 1, 1, CONDITIONAL_A),
    child('lower', 'a', 'Sell', 1, 1, CONDITIONAL_A),
    child('accent', 'é', 'Sell', 1, 1, CONDITIONAL_A),
    child('upper', 'A', 'Sell', 1, 1, CONDITIONAL_A),
  ]
  const plan = planCtfRangeCapabilityBatches(baseInput(children, [proof(COLLATERAL.id, 16)]))
  assert.deepEqual(plan.canonicalChildIds, ['upper', 'lower', 'accent', 'japanese'])
})

test('reuses complete conditional groups before collateral and allocates each proof once', () => {
  const children = [
    child('conditional-1', 'route-a', 'Sell', 10, 8, CONDITIONAL_A),
    child('conditional-2', 'route-b', 'Sell', 20, 4, CONDITIONAL_A),
    child('collateral-1', 'route-c', 'Sell', 30, 8, CONDITIONAL_B),
  ]
  const plan = planCtfRangeCapabilityBatches({
    ...baseInput(children, [proof(COLLATERAL.id, 32)]),
    conditionalProofs: [proof(CONDITIONAL_A.id, 16), proof(CONDITIONAL_A.id, 4)],
  })

  assert.deepEqual(
    plan.parents.map(({ kind }) => kind),
    ['same-keyset-swap', 'collateral-ctf-convert'],
  )
  assert.deepEqual(
    plan.parents.map(({ children: rows }) => rows.map(({ clientOrderId }) => clientOrderId)),
    [['conditional-1', 'conditional-2'], ['collateral-1']],
  )
  const proofKeys = plan.parents.flatMap(({ inputs }) => inputs.map(proofKey))
  assert.equal(new Set(proofKeys).size, proofKeys.length)
  assert.deepEqual(
    plan.sourcePartitions.map(({ sourceKeysetId, childIds }) => ({ sourceKeysetId, childIds })),
    [
      { sourceKeysetId: CONDITIONAL_A.id, childIds: ['conditional-1', 'conditional-2'] },
      { sourceKeysetId: COLLATERAL.id, childIds: ['collateral-1'] },
    ],
  )
})

test('keeps a partially funded conditional keyset group together on collateral', () => {
  const children = [
    child('one', 'route-a', 'Sell', 1, 8, CONDITIONAL_A),
    child('two', 'route-b', 'Sell', 2, 8, CONDITIONAL_A),
  ]
  const plan = planCtfRangeCapabilityBatches({
    ...baseInput(children, [proof(COLLATERAL.id, 32)]),
    conditionalProofs: [proof(CONDITIONAL_A.id, 16)],
  })
  assert.equal(plan.parents.length, 1)
  assert.equal(plan.parents[0]?.kind, 'collateral-ctf-convert')
  assert.deepEqual(
    plan.parents[0]?.children.map(({ clientOrderId }) => clientOrderId),
    ['one', 'two'],
  )
})

test('does not split one preferred keyset group across multiple NUT-03 parents', () => {
  const children = [
    child('one', 'route-a', 'Sell', 1, 63, CONDITIONAL_A),
    child('two', 'route-b', 'Sell', 2, 63, CONDITIONAL_A),
  ]
  const plan = planCtfRangeCapabilityBatches({
    ...baseInput(children, [proof(COLLATERAL.id, 256)]),
    conditionalProofs: [proof(CONDITIONAL_A.id, 64, 'one'), proof(CONDITIONAL_A.id, 64, 'two')],
    limits: {
      maxInputs: 1,
      maxChildren: 32,
      maxOutputs: 256,
      maxRequestBytes: 1_048_576,
      maxPoolEntries: 128,
    },
  })
  assert.deepEqual(
    plan.parents.map(({ kind }) => kind),
    ['collateral-ctf-convert'],
  )
  assert.deepEqual(
    plan.parents[0]?.children.map(({ clientOrderId }) => clientOrderId),
    ['one', 'two'],
  )
})

test('preserves actionable preferred-source fragmentation when collateral is unavailable', () => {
  const plan = planCtfRangeCapabilityBatches({
    ...baseInput([child('one', 'route-a', 'Sell', 1, 8, CONDITIONAL_A)], []),
    conditionalProofs: [
      proof(CONDITIONAL_A.id, 4, '1'),
      proof(CONDITIONAL_A.id, 4, '2'),
      proof(CONDITIONAL_A.id, 4, '3'),
    ],
    limits: {
      maxInputs: 2,
      maxChildren: 32,
      maxOutputs: 256,
      maxRequestBytes: 1_048_576,
      maxPoolEntries: 128,
    },
  })
  assert.deepEqual(plan.omissions, [
    {
      clientOrderId: 'one',
      reason: 'preferred source consolidation required',
      sourceKeysetId: CONDITIONAL_A.id,
      selectedInputCount: 3,
      inputLimit: 2,
    },
  ])
})

test('uses one collateral parent for an ordinary fitting ladder', () => {
  const children = Array.from({ length: 12 }, (_, index) =>
    child(`level-${index}`, `route-${index % 2}`, 'Sell', index + 1, 2, CONDITIONAL_A),
  )
  const plan = planCtfRangeCapabilityBatches(
    baseInput(children, [proof(COLLATERAL.id, 64), proof(COLLATERAL.id, 32)]),
  )

  assert.equal(plan.parents.length, 1)
  assert.equal(plan.mintMutationCount, 1)
  assert.equal(plan.parents[0]?.children.length, children.length)
})

test('separates child and output limits before parent materialization', () => {
  const children = [
    child('one', 'route-a', 'Buy', 1, 1, COLLATERAL),
    child('two', 'route-b', 'Buy', 2, 1, COLLATERAL),
  ]
  const collateralProofs = [proof(COLLATERAL.id, 4, 'first'), proof(COLLATERAL.id, 4, 'second')]
  const measuredChildCounts: number[] = []
  const childLimited = planCtfRangeCapabilityBatches({
    ...baseInput(children, collateralProofs),
    limits: {
      maxInputs: 64,
      maxChildren: 1,
      maxOutputs: 256,
      maxRequestBytes: 1_048_576,
      maxPoolEntries: 128,
    },
    measureExactParentRequestBytes: ({ children: rows }) => {
      measuredChildCounts.push(rows.length)
      return 256
    },
  })
  const outputLimited = planCtfRangeCapabilityBatches({
    ...baseInput(children, collateralProofs),
    limits: {
      maxInputs: 64,
      maxChildren: 32,
      maxOutputs: 2,
      maxRequestBytes: 1_048_576,
      maxPoolEntries: 128,
    },
    measureExactParentRequestBytes: () => 256,
  })

  assert.deepEqual(
    childLimited.parents.map(({ children: rows }) => rows.length),
    [1, 1],
  )
  assert.ok(measuredChildCounts.every((count) => count <= 1))
  assert.ok(childLimited.parents.every(({ outputs }) => outputs.length <= 256))
  assert.deepEqual(
    outputLimited.parents.map(({ children: rows }) => rows.length),
    [1, 1],
  )
  assert.ok(outputLimited.parents.every(({ children: rows }) => rows.length < 32))
  assert.ok(outputLimited.parents.every(({ outputs }) => outputs.length <= 2))
})

test('keeps a 30-child categorical quote pass in one parent when outputs exceed 32', () => {
  const children = Array.from({ length: 30 }, (_, index) =>
    child(`level-${index}`, `route-${index}`, 'Sell', index + 1, 10, CONDITIONAL_A),
  )
  const plan = planCtfRangeCapabilityBatches({
    ...baseInput(children, [proof(COLLATERAL.id, 512)]),
    limits: {
      maxInputs: 64,
      maxChildren: 32,
      maxOutputs: 256,
      maxRequestBytes: 1_048_576,
      maxPoolEntries: 128,
    },
  })

  assert.equal(plan.parents.length, 1)
  assert.equal(plan.parents[0]?.children.length, 30)
  assert.equal(plan.parents[0]?.outputs.length, 125)
  assert.ok(plan.parents.every(({ children: rows }) => rows.length <= 32))
  assert.ok(plan.parents.every(({ outputs }) => outputs.length <= 256))
})

test('clamps durable outputs at 256 and splits a 257-output ladder', () => {
  const buy = (
    clientOrderId: string,
    route: string,
    outputCount: number,
  ): CtfRangeCapabilityBatchChild => ({
    route,
    side: 'Buy',
    price: '1',
    amount: '1000',
    clientOrderId,
    authorizationAmounts: Array.from({ length: outputCount }, () => '1'),
    poolEntryCount: outputCount,
    offeredAsset: 'collateral',
    offeredKeyset: COLLATERAL,
  })
  const children = [
    buy('first', 'route-a', 128),
    buy('second', 'route-b', 128),
    buy('third', 'route-c', 1),
  ]
  const plan = planCtfRangeCapabilityBatches({
    children,
    collateralKeyset: COLLATERAL,
    collateralProofs: [
      proof(COLLATERAL.id, 256, '256'),
      proof(COLLATERAL.id, 1, '1-a'),
      proof(COLLATERAL.id, 1, '1-b'),
      proof(COLLATERAL.id, 1, '1-c'),
    ],
    conditionalProofs: [],
    limits: {
      maxInputs: 64,
      maxChildren: 32,
      maxOutputs: 257,
      maxRequestBytes: 1_048_576,
      maxPoolEntries: 128,
    },
    measureExactParentRequestBytes: () => 1_024,
  })
  assert.deepEqual(
    plan.parents.map(({ outputs }) => outputs.length),
    [256, 1],
  )
  assert.deepEqual(
    plan.parents.map(({ children: rows }) => rows.length),
    [2, 1],
  )
  assert.deepEqual(plan.omissions, [])
})

test('clamps measured request bytes to the durable artifact authority bound', () => {
  const plan = planCtfRangeCapabilityBatches({
    ...baseInput(
      [
        child('too-large', 'route-a', 'Sell', 1, 4, CONDITIONAL_A),
        child('fit', 'route-b', 'Sell', 2, 1, CONDITIONAL_A),
      ],
      [proof(COLLATERAL.id, 16)],
    ),
    limits: {
      maxInputs: 64,
      maxChildren: 32,
      maxOutputs: 256,
      maxRequestBytes: DURABLE_ARTIFACT_BYTES_LIMIT_MAX + 1,
      maxPoolEntries: 128,
    },
    measureExactParentRequestBytes: ({ children: rows }) =>
      rows.some(({ clientOrderId }) => clientOrderId === 'too-large')
        ? DURABLE_ARTIFACT_BYTES_LIMIT_MAX + 1
        : 1_024,
  })
  assert.deepEqual(
    plan.parents.flatMap(({ children }) => children.map(({ clientOrderId }) => clientOrderId)),
    ['fit'],
  )
  assert.deepEqual(plan.omissions, [{ clientOrderId: 'too-large', reason: 'request byte limit' }])
})

test('accepts exact limits and rejects or splits at limit plus one', () => {
  const one = child('one', 'route-a', 'Sell', 10, 8, CONDITIONAL_A, 4)
  const measured = (candidate: CtfRangeCapabilityParentMeasureInput): number =>
    candidate.children.length * 100
  const exact = planCtfRangeCapabilityBatches({
    ...baseInput([one], [proof(COLLATERAL.id, 8), proof(COLLATERAL.id, 4)]),
    limits: {
      maxInputs: 2,
      maxChildren: 1,
      maxOutputs: 4,
      maxRequestBytes: 100,
      maxPoolEntries: 4,
    },
    measureExactParentRequestBytes: measured,
  })
  assert.equal(exact.parents[0]?.inputs.length, 2)
  assert.equal(exact.parents[0]?.outputs.length, 4)
  assert.equal(exact.parents[0]?.requestBytes, 100)

  const fit = child('fit', 'route-z', 'Sell', 1, 1, CONDITIONAL_A)
  const rejected = { ...one, route: 'route-a' }
  const cases = [
    {
      limits: {
        maxInputs: 1,
        maxChildren: 32,
        maxOutputs: 8,
        maxRequestBytes: 100,
        maxPoolEntries: 4,
      },
      child: rejected,
      collateralProofs: [
        proof(COLLATERAL.id, 8, '8'),
        proof(COLLATERAL.id, 4, '4'),
        proof(COLLATERAL.id, 2, '2'),
      ],
      reason: 'input limit',
    },
    {
      limits: {
        maxInputs: 2,
        maxChildren: 32,
        maxOutputs: 3,
        maxRequestBytes: 100,
        maxPoolEntries: 4,
      },
      child: { ...child('one', 'route-a', 'Sell', 10, 3, CONDITIONAL_A), poolEntryCount: 4 },
      collateralProofs: [proof(COLLATERAL.id, 4, '4')],
      reason: 'output limit',
    },
    {
      limits: {
        maxInputs: 2,
        maxChildren: 32,
        maxOutputs: 8,
        maxRequestBytes: 99,
        maxPoolEntries: 4,
      },
      child: rejected,
      collateralProofs: [proof(COLLATERAL.id, 16, '16')],
      reason: 'request byte limit',
    },
    {
      limits: {
        maxInputs: 2,
        maxChildren: 32,
        maxOutputs: 8,
        maxRequestBytes: 100,
        maxPoolEntries: 4,
      },
      child: { ...rejected, poolEntryCount: 5 },
      collateralProofs: [proof(COLLATERAL.id, 16, '16')],
      reason: 'pool entry limit',
    },
  ] as const
  for (const scenario of cases) {
    const partial = planCtfRangeCapabilityBatches({
      ...baseInput([fit, scenario.child], scenario.collateralProofs),
      limits: scenario.limits,
      measureExactParentRequestBytes: ({ children: rows }) =>
        rows.reduce((total, row) => total + (row.clientOrderId === 'fit' ? 50 : 100), 0),
    })
    assert.deepEqual(
      partial.parents.flatMap(({ children: rows }) =>
        rows.map(({ clientOrderId }) => clientOrderId),
      ),
      ['fit'],
    )
    assert.deepEqual(partial.omissions, [{ clientOrderId: 'one', reason: scenario.reason }])
  }
})

test('packs whole canonical prefixes without a global bin-packing search', () => {
  const sizes = new Map([
    ['a', 6],
    ['b', 6],
    ['c', 4],
    ['d', 4],
  ])
  const children = [...sizes.keys()].map((id, index) =>
    child(id, `route-${index}`, 'Sell', index + 1, 1, CONDITIONAL_A),
  )
  const plan = planCtfRangeCapabilityBatches({
    ...baseInput(children, [
      proof(COLLATERAL.id, 4, '1'),
      proof(COLLATERAL.id, 4, '2'),
      proof(COLLATERAL.id, 4, '3'),
      proof(COLLATERAL.id, 4, '4'),
    ]),
    limits: {
      maxInputs: 64,
      maxChildren: 32,
      maxOutputs: 64,
      maxRequestBytes: 10,
      maxPoolEntries: 8,
    },
    measureExactParentRequestBytes: ({ children: rows }) =>
      rows.reduce((total, row) => total + sizes.get(row.clientOrderId)!, 0),
  })

  assert.deepEqual(
    plan.parents.map(({ children: rows }) => rows.map(({ clientOrderId }) => clientOrderId)),
    [['a'], ['b', 'c'], ['d']],
  )
})

test('measures each growing prefix once and reuses the last fitting probe', () => {
  let measurements = 0
  const children = Array.from({ length: 8 }, (_, index) =>
    child(`buy-${index}`, `route-${index}`, 'Buy', index + 1, 1, COLLATERAL),
  )
  const plan = planCtfRangeCapabilityBatches({
    ...baseInput(children, [
      proof(COLLATERAL.id, 8, 'one'),
      proof(COLLATERAL.id, 8, 'two'),
      proof(COLLATERAL.id, 8, 'three'),
    ]),
    limits: {
      maxInputs: 64,
      maxChildren: 32,
      maxOutputs: 256,
      maxRequestBytes: 3,
      maxPoolEntries: 128,
    },
    measureExactParentRequestBytes: ({ children: rows }) => {
      measurements += 1
      return rows.length
    },
  })
  assert.equal(measurements, 10)
  assert.deepEqual(
    plan.parents.map(({ children: rows }) => rows.length),
    [3, 3, 2],
  )
})

test('rejects duplicate proof authority before planning', () => {
  const duplicate = proof(COLLATERAL.id, 16)
  assert.throws(
    () =>
      planCtfRangeCapabilityBatches({
        ...baseInput([child('one', 'route-a', 'Sell', 1, 4, CONDITIONAL_A)], [duplicate]),
        conditionalProofs: [duplicate],
      }),
    /duplicate proof/i,
  )

  assert.throws(
    () =>
      planCtfRangeCapabilityBatches({
        ...baseInput([child('one', 'route-a', 'Sell', 1, 4, CONDITIONAL_A)], [duplicate]),
        conditionalProofs: [{ ...duplicate, id: CONDITIONAL_A.id, C: '02changed' }],
      }),
    /duplicate proof/i,
  )
})

test('rejects conflicting keyset authority and mixed proof partitions', () => {
  const childRow = child('one', 'route-a', 'Sell', 1, 4, CONDITIONAL_A)
  assert.throws(
    () =>
      planCtfRangeCapabilityBatches(
        baseInput(
          [
            childRow,
            {
              ...child('two', 'route-b', 'Sell', 2, 4, CONDITIONAL_A),
              offeredKeyset: { ...CONDITIONAL_A, inputFeePpk: 200 },
            },
          ],
          [proof(COLLATERAL.id, 16)],
        ),
      ),
    /conflicting authority/i,
  )
  assert.throws(
    () =>
      planCtfRangeCapabilityBatches({
        ...baseInput([childRow], [proof(CONDITIONAL_A.id, 16)]),
      }),
    /collateral inventory contains a foreign proof/i,
  )
})

test('accepts normal Buy face amount and binds exact child authority into plan digests', () => {
  const childRow = child('one', 'route-a', 'Sell', 1, 4, CONDITIONAL_A)
  const buyAuthorization = planCtfRangeOrderAuthorization({
    side: 'Buy',
    priceNumerator: 4,
    amountSubunits: 1_000,
    divisibility: 1_000,
    inputFeePpk: COLLATERAL.inputFeePpk,
    offerKeysetKeys: COLLATERAL.keys,
    maxPoolEntries: 128,
  })
  const buy: CtfRangeCapabilityBatchChild = {
    route: 'route-buy',
    side: 'Buy',
    price: '4',
    amount: '1000',
    clientOrderId: 'buy',
    authorizationAmounts: buyAuthorization.authorizationAmounts,
    poolEntryCount: 2,
    offeredAsset: 'collateral',
    offeredKeyset: COLLATERAL,
  }
  const buyPlan = planCtfRangeCapabilityBatches(baseInput([buy], [proof(COLLATERAL.id, 8)]))
  assert.deepEqual(buyPlan.canonicalChildIds, ['buy'])

  const first = planCtfRangeCapabilityBatches(baseInput([childRow], [proof(COLLATERAL.id, 16)]))
  const second = planCtfRangeCapabilityBatches(
    baseInput([{ ...childRow, price: '2' }], [proof(COLLATERAL.id, 16)]),
  )
  assert.notEqual(first.parents[0]?.parentDigest, second.parents[0]?.parentDigest)
  assert.notEqual(first.packingDigest, second.packingDigest)
})

test('rejects malformed runtime side and offered-asset pairs', () => {
  const sell = child('sell', 'route-a', 'Sell', 1, 4, CONDITIONAL_A)
  assert.throws(
    () =>
      planCtfRangeCapabilityBatches(
        baseInput(
          [{ ...sell, side: 'Buy' } as unknown as CtfRangeCapabilityBatchChild],
          [proof(COLLATERAL.id, 16)],
        ),
      ),
    /Buy.*collateral/i,
  )
  const buy = child('buy', 'route-b', 'Buy', 1, 4, COLLATERAL)
  assert.throws(
    () =>
      planCtfRangeCapabilityBatches(
        baseInput(
          [{ ...buy, side: 'Sell' } as unknown as CtfRangeCapabilityBatchChild],
          [proof(COLLATERAL.id, 16)],
        ),
      ),
    /Sell.*conditional/i,
  )
})

test('binds full proof authority and request bytes and returns detached immutable data', () => {
  const inputProof = {
    ...proof(COLLATERAL.id, 16),
    dleq: { e: 'e', s: 's' },
    p2pk_e: 'p2pk',
    witness: { signatures: ['one'] },
  } as Proof
  const childRow = child('one', 'route-a', 'Sell', 1, 4, CONDITIONAL_A)
  const input = baseInput([childRow], [inputProof])
  const first = planCtfRangeCapabilityBatches(input)
  const prior = JSON.stringify(first)
  ;(inputProof as { C: string }).C = 'changed'
  ;(inputProof.witness as { signatures: string[] }).signatures.push('changed')
  ;(childRow as { route: string }).route = 'changed'
  assert.equal(JSON.stringify(first), prior)
  assert.throws(() => ((first.parents[0]!.inputs[0] as { C: string }).C = 'changed'))

  const proofWithOtherWitness = {
    ...proof(COLLATERAL.id, 16),
    dleq: { e: 'e', s: 's' },
    p2pk_e: 'p2pk',
    witness: { signatures: ['two'] },
  } as Proof
  const second = planCtfRangeCapabilityBatches(
    baseInput([child('one', 'route-a', 'Sell', 1, 4, CONDITIONAL_A)], [proofWithOtherWitness]),
  )
  const third = planCtfRangeCapabilityBatches({
    ...baseInput([child('one', 'route-a', 'Sell', 1, 4, CONDITIONAL_A)], [proofWithOtherWitness]),
    measureExactParentRequestBytes: () => 257,
  })
  const changedDleq = planCtfRangeCapabilityBatches(
    baseInput(
      [child('one', 'route-a', 'Sell', 1, 4, CONDITIONAL_A)],
      [{ ...proofWithOtherWitness, dleq: { e: 'other', s: 's' } } as Proof],
    ),
  )
  const changedP2pk = planCtfRangeCapabilityBatches(
    baseInput(
      [child('one', 'route-a', 'Sell', 1, 4, CONDITIONAL_A)],
      [{ ...proofWithOtherWitness, p2pk_e: 'other' } as Proof],
    ),
  )
  assert.notEqual(first.parents[0]?.parentDigest, second.parents[0]?.parentDigest)
  assert.notEqual(second.parents[0]?.parentDigest, third.parents[0]?.parentDigest)
  assert.notEqual(second.parents[0]?.parentDigest, changedDleq.parents[0]?.parentDigest)
  assert.notEqual(second.parents[0]?.parentDigest, changedP2pk.parents[0]?.parentDigest)
})

test('conserves exact selected value and current input fees for every parent', () => {
  for (let seed = 1; seed <= 32; seed += 1) {
    const children = Array.from({ length: 1 + (seed % 7) }, (_, index) =>
      child(
        `property-${seed}-${index}`,
        `route-${index % 3}`,
        index % 2 === 0 ? 'Sell' : 'Buy',
        index + 1,
        1 + ((seed + index) % 4),
        index % 2 === 0 ? CONDITIONAL_A : COLLATERAL,
      ),
    )
    const plan = planCtfRangeCapabilityBatches(
      baseInput(children, [proof(COLLATERAL.id, 64), proof(COLLATERAL.id, 32)]),
    )
    for (const parent of plan.parents) {
      const inputTotal = sum(parent.inputs.map(({ amount }) => Number(amount)))
      const collateralOutputs = parent.outputs
        .filter(({ role }) => role !== 'complement')
        .reduce((total, { amount }) => total + amount, 0)
      assert.equal(collateralOutputs, inputTotal - parent.inputFee)
      for (const childRow of parent.children) {
        assert.equal(
          parent.outputs
            .filter(
              (output) =>
                output.role === 'authorization' && output.clientOrderId === childRow.clientOrderId,
            )
            .reduce((total, { amount }) => total + amount, 0),
          Number(childRow.amount),
        )
      }
    }
  }
})

test('keeps mixed-source multi-parent partitions invariant with simultaneous omissions', () => {
  const children = [
    child('a-1', 'route-a', 'Sell', 1, 4, CONDITIONAL_A),
    child('a-2', 'route-b', 'Sell', 2, 4, CONDITIONAL_A),
    child('buy', 'route-c', 'Buy', 3, 1, COLLATERAL),
    child('sell', 'route-d', 'Sell', 4, 2, CONDITIONAL_B),
    { ...child('request', 'route-e', 'Sell', 5, 4, CONDITIONAL_B), poolEntryCount: 1 },
    { ...child('pool', 'route-f', 'Sell', 6, 1, CONDITIONAL_B), poolEntryCount: 3 },
  ]
  const collateral = [
    proof(COLLATERAL.id, 32, '32'),
    proof(COLLATERAL.id, 16, '16'),
    proof(COLLATERAL.id, 8, '8'),
  ]
  const conditional = [proof(CONDITIONAL_A.id, 16, '16')]
  const input = (
    childRows: readonly CtfRangeCapabilityBatchChild[],
    collateralProofs: readonly Proof[],
    conditionalProofs: readonly Proof[],
  ): CtfRangeCapabilityBatchPlanInput => ({
    ...baseInput(childRows, collateralProofs),
    conditionalProofs,
    limits: {
      maxInputs: 64,
      maxChildren: 32,
      maxOutputs: 256,
      maxRequestBytes: 100,
      maxPoolEntries: 2,
    },
    measureExactParentRequestBytes: ({ kind, children: rows }) =>
      rows.some(({ clientOrderId }) => clientOrderId === 'request')
        ? 101
        : kind === 'same-keyset-swap'
          ? 80
          : rows.length * 60,
  })
  const expected = planCtfRangeCapabilityBatches(input(children, collateral, conditional))
  for (let offset = 0; offset < 8; offset += 1) {
    const rotated = [
      ...children.slice(offset % children.length),
      ...children.slice(0, offset % children.length),
    ]
    const actual = planCtfRangeCapabilityBatches(
      input(rotated, [...collateral].reverse(), [...conditional].reverse()),
    )
    assert.deepEqual(actual, expected)
  }

  assert.deepEqual(
    expected.parents.map(({ kind }) => kind),
    ['same-keyset-swap', 'collateral-ctf-convert', 'collateral-ctf-convert'],
  )
  assert.deepEqual(expected.omissions, [
    { clientOrderId: 'request', reason: 'request byte limit' },
    { clientOrderId: 'pool', reason: 'pool entry limit' },
  ])
  const partition = [
    ...expected.parents.flatMap(({ children: rows }) =>
      rows.map(({ clientOrderId }) => clientOrderId),
    ),
    ...expected.omissions.map(({ clientOrderId }) => clientOrderId),
  ].sort()
  assert.deepEqual(partition, expected.canonicalChildIds.slice().sort())
  const proofKeys = expected.parents.flatMap(({ inputs }) => inputs.map(proofKey))
  assert.equal(new Set(proofKeys).size, proofKeys.length)
  for (const parent of expected.parents) {
    assert.deepEqual(
      parent.outputs.map(({ outputIndex }) => outputIndex),
      parent.outputs.map((_, index) => index),
    )
    for (const childRow of parent.children.filter(({ side }) => side === 'Sell')) {
      const authorization = parent.outputs
        .filter(
          ({ role, clientOrderId }) =>
            role === 'authorization' && clientOrderId === childRow.clientOrderId,
        )
        .reduce((total, { amount }) => total + amount, 0)
      const complement = parent.outputs
        .filter(
          ({ role, clientOrderId }) =>
            role === 'complement' && clientOrderId === childRow.clientOrderId,
        )
        .reduce((total, { amount }) => total + amount, 0)
      if (parent.kind === 'collateral-ctf-convert') assert.equal(complement, authorization)
    }
  }
})

function baseInput(
  children: readonly CtfRangeCapabilityBatchChild[],
  collateralProofs: readonly Proof[],
): CtfRangeCapabilityBatchPlanInput {
  return {
    children,
    collateralKeyset: COLLATERAL,
    collateralProofs,
    conditionalProofs: [],
    limits: {
      maxInputs: 64,
      maxChildren: 32,
      maxOutputs: 256,
      maxRequestBytes: 1_048_576,
      maxPoolEntries: 128,
    },
    measureExactParentRequestBytes: () => 256,
  }
}

function child(
  clientOrderId: string,
  route: string,
  side: 'Buy' | 'Sell',
  price: number,
  amount: number,
  offeredKeyset: typeof COLLATERAL,
  poolEntryCount = 2,
): CtfRangeCapabilityBatchChild {
  return {
    route,
    side,
    price: String(price),
    amount: String(amount),
    clientOrderId,
    ...(offeredKeyset.id === COLLATERAL.id
      ? { offeredAsset: 'collateral' as const, offeredKeyset }
      : {
          offeredAsset: 'conditional' as const,
          offeredKeyset,
          complementKeyset: COMPLEMENT,
        }),
    authorizationAmounts: split(amount).map(String),
    poolEntryCount,
  }
}

function split(value: number): number[] {
  const amounts: number[] = []
  let remaining = value
  for (let amount = 2 ** Math.floor(Math.log2(value)); amount >= 1; amount /= 2) {
    if (amount <= remaining) {
      amounts.push(amount)
      remaining -= amount
    }
  }
  return amounts
}

function proof(id: string, amount: number, suffix = String(amount)): Proof {
  return { id, amount, secret: `${id}-${suffix}`, C: `02${suffix}` }
}

function proofKey(value: Proof): string {
  return `${value.id}:${value.secret}:${value.C}`
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}
