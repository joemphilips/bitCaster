import assert from 'node:assert/strict'
import test from 'node:test'
import { splitAmount } from '@cashu/cashu-ts'
import { planCtfRangeOrderAuthorization } from '../src/ctfRangeOrderAuthorization.ts'

const KEYS = Object.fromEntries(
  Array.from({ length: 63 }, (_, index) => [
    (1n << BigInt(index)).toString(),
    '02' + '11'.repeat(32),
  ]),
)

test('buy authorization reserves its per-proof fee and preserves the whole-share limit', () => {
  const plan = planCtfRangeOrderAuthorization({
    side: 'Buy',
    priceNumerator: 4_200,
    amountSubunits: 20_000,
    divisibility: 10_000,
    inputFeePpk: 100,
    offerKeysetKeys: KEYS,
    maxPoolEntries: 29,
  })

  assert.equal(plan.inputAmount, '8401')
  assert.equal(plan.participantFeeAllocationUpperBound, '1')
  assert.equal(plan.reservedFeeHeadroom, '0')
  assert.equal(
    plan.authorizationAmounts.reduce((sum, value) => sum + BigInt(value), 0n),
    8_401n,
  )
  assert.deepEqual(plan.policy, {
    rateN: '10000',
    rateD: '4201',
    minReceive: '10000',
    maxDebit: '8401',
  })
  assert.deepEqual(plan.manifest, { maxReceive: '20000', maxChange: '8401' })
})

test('sell authorization charges the fee from collateral receive at the minimum fill', () => {
  const plan = planCtfRangeOrderAuthorization({
    side: 'Sell',
    priceNumerator: 4_200,
    amountSubunits: 20_000,
    divisibility: 10_000,
    inputFeePpk: 100,
    offerKeysetKeys: KEYS,
    maxPoolEntries: 128,
  })

  assert.equal(plan.inputAmount, '20000')
  assert.equal(plan.participantFeeAllocationUpperBound, '1')
  assert.equal(plan.reservedFeeHeadroom, '0')
  assert.deepEqual(plan.policy, {
    rateN: '4199',
    rateD: '10000',
    minReceive: '4199',
    maxDebit: '20000',
  })
})

test('buy preparation retains only the minimal safe change headroom when fee count oscillates', () => {
  const plan = planCtfRangeOrderAuthorization({
    side: 'Buy',
    priceNumerator: 7,
    amountSubunits: 10_000,
    divisibility: 10_000,
    inputFeePpk: 1_000,
    offerKeysetKeys: KEYS,
    maxPoolEntries: 128,
  })

  assert.deepEqual(plan.authorizationAmounts, ['8'])
  assert.equal(plan.inputAmount, '8')
  assert.equal(plan.participantFeeAllocationUpperBound, '1')
  assert.equal(plan.reservedFeeHeadroom, '0')
  assert.equal(plan.policy.maxDebit, '8')
})

test('buy preparation finds a safe reserve between high-fee proof-count candidates', () => {
  const plan = planCtfRangeOrderAuthorization({
    side: 'Buy',
    priceNumerator: 12,
    amountSubunits: 10_000,
    divisibility: 10_000,
    inputFeePpk: 2_500,
    offerKeysetKeys: KEYS,
    maxPoolEntries: 128,
  })

  assert.deepEqual(plan.authorizationAmounts, ['16'])
  assert.equal(plan.inputAmount, '16')
  assert.equal(plan.participantFeeAllocationUpperBound, '3')
  assert.equal(plan.reservedFeeHeadroom, '1')
  assert.equal(plan.policy.maxDebit, '15')
})

test('authorization refuses an unsafe fee or proof-count bound', () => {
  assert.throws(
    () =>
      planCtfRangeOrderAuthorization({
        side: 'Sell',
        priceNumerator: 1,
        amountSubunits: 10_000,
        divisibility: 10_000,
        inputFeePpk: 1_000,
        offerKeysetKeys: KEYS,
        maxPoolEntries: 128,
      }),
    /fee exceeds/,
  )
  assert.throws(
    () =>
      planCtfRangeOrderAuthorization({
        side: 'Buy',
        priceNumerator: 4_200,
        amountSubunits: 10_000,
        divisibility: 10_000,
        inputFeePpk: 100,
        offerKeysetKeys: KEYS,
        maxPoolEntries: 128,
        maxInputs: 1,
      }),
    /input limit/,
  )
})

test('authorization rejects invalid or case-drifted sides instead of treating them as sells', () => {
  for (const side of ['buy', 'SELL', 'Hold']) {
    assert.throws(
      () =>
        planCtfRangeOrderAuthorization({
          side: side as 'Buy',
          priceNumerator: 4_200,
          amountSubunits: 10_000,
          divisibility: 10_000,
          inputFeePpk: 100,
          offerKeysetKeys: KEYS,
          maxPoolEntries: 128,
        }),
      /^Error: CTF range order side is invalid$/,
    )
  }
})

test('authorization rejects a huge amount against a shallow denomination map without materializing inputs', () => {
  const hugeWholeShareAmount = Math.floor(Number.MAX_SAFE_INTEGER / 10_000) * 10_000
  const shallowKeys = {
    '1': '02' + '11'.repeat(32),
    '2': '02' + '22'.repeat(32),
  }

  // Keep the failure assertion bounded: never include a decomposition in its output.
  assert.throws(
    () =>
      planCtfRangeOrderAuthorization({
        side: 'Sell',
        priceNumerator: 4_200,
        amountSubunits: hugeWholeShareAmount,
        divisibility: 10_000,
        inputFeePpk: 100,
        offerKeysetKeys: shallowKeys,
        maxPoolEntries: 128,
        maxInputs: 64,
      }),
    /^Error: CTF range authorization exceeds the mint input limit$/,
  )
})

test('participant fee allocation upper bound rounds proof weight at ppk boundaries', () => {
  for (const [inputFeePpk, expectedFee] of [
    [999, '1'],
    [1_000, '1'],
    [1_001, '2'],
  ] as const) {
    const plan = planCtfRangeOrderAuthorization({
      side: 'Buy',
      priceNumerator: 14,
      amountSubunits: 10_000,
      divisibility: 10_000,
      inputFeePpk,
      offerKeysetKeys: KEYS,
      maxPoolEntries: 128,
    })

    assert.equal(plan.authorizationAmounts.length, 1)
    assert.equal(plan.participantFeeAllocationUpperBound, expectedFee)
  }
})

test('authorization validates advertised option bounds', () => {
  const base = {
    side: 'Sell' as const,
    priceNumerator: 4_200,
    amountSubunits: 10_000,
    divisibility: 10_000,
    inputFeePpk: 100,
    offerKeysetKeys: KEYS,
    maxPoolEntries: 128,
  }

  for (const maxInputs of [0, 1.5, 65, Number.MAX_SAFE_INTEGER]) {
    assert.throws(
      () => planCtfRangeOrderAuthorization({ ...base, maxInputs }),
      /^Error: CTF range input limit is invalid$/,
    )
  }
  for (const maxPoolEntries of [0, 1, 2.5, 129, Number.MAX_SAFE_INTEGER]) {
    assert.throws(
      () => planCtfRangeOrderAuthorization({ ...base, maxPoolEntries }),
      /^Error: CTF range manifest entry limit is invalid$/,
    )
  }
})

test('authorization validates input fee ppk safe-integer boundaries', () => {
  const base = {
    side: 'Buy' as const,
    priceNumerator: 14,
    amountSubunits: 10_000,
    divisibility: 10_000,
    offerKeysetKeys: KEYS,
    maxPoolEntries: 128,
  }

  for (const inputFeePpk of [
    0,
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () => planCtfRangeOrderAuthorization({ ...base, inputFeePpk }),
      /^Error: input fee ppk is invalid$/,
    )
  }

  for (const [inputFeePpk, expectedFeeUpperBound] of [
    [1, '1'],
    [Number.MAX_SAFE_INTEGER, '9007199254741'],
  ] as const) {
    const plan = planCtfRangeOrderAuthorization({ ...base, inputFeePpk })
    assert.equal(plan.participantFeeAllocationUpperBound, expectedFeeUpperBound)
  }
})

test('fee-adjusted covenants cover every whole-share partial fill', () => {
  for (const side of ['Buy', 'Sell'] as const) {
    for (const shares of [1, 2, 5, 20]) {
      const plan = planCtfRangeOrderAuthorization({
        side,
        priceNumerator: 4_200,
        amountSubunits: shares * 10_000,
        divisibility: 10_000,
        inputFeePpk: 250,
        offerKeysetKeys: KEYS,
        maxPoolEntries: 128,
      })
      const fee = BigInt(plan.participantFeeAllocationUpperBound)
      const rateN = BigInt(plan.policy.rateN)
      const rateD = BigInt(plan.policy.rateD)
      for (let filled = 1; filled <= shares; filled += 1) {
        const face = BigInt(filled * 10_000)
        const quote = BigInt(filled * 4_200)
        const debit = side === 'Buy' ? quote + fee : face
        const receive = side === 'Buy' ? face : quote - fee
        assert.ok(receive * rateD >= debit * rateN)
        assert.ok(debit <= BigInt(plan.policy.maxDebit))
        assert.ok(receive >= BigInt(plan.policy.minReceive))
      }
    }
  }
})

test('authorization refuses a range larger than the advertised manifest limit', () => {
  assert.throws(
    () =>
      planCtfRangeOrderAuthorization({
        side: 'Buy',
        priceNumerator: 4_200,
        amountSubunits: 20_000,
        divisibility: 10_000,
        inputFeePpk: 100,
        offerKeysetKeys: KEYS,
        maxPoolEntries: 28,
      }),
    /manifest entry limit/,
  )
})

test('buy fee reservation is minimal across bounded proof-count candidates', () => {
  for (const priceNumerator of [1, 7, 511, 4_200]) {
    for (const shares of [1, 2, 5, 20]) {
      for (const inputFeePpk of [1, 250, 1_000, 2_500]) {
        const plan = planCtfRangeOrderAuthorization({
          side: 'Buy',
          priceNumerator,
          amountSubunits: shares * 10_000,
          divisibility: 10_000,
          inputFeePpk,
          offerKeysetKeys: KEYS,
          maxPoolEntries: 128,
        })
        const reservedFee =
          BigInt(plan.participantFeeAllocationUpperBound) + BigInt(plan.reservedFeeHeadroom)
        const quote = BigInt(priceNumerator * shares)
        for (let candidate = 0n; candidate < reservedFee; candidate += 1n) {
          const amounts = splitAmount(quote + candidate, { ...KEYS })
          const requiredFee = feeForCount(inputFeePpk, amounts.length)
          assert.ok(amounts.length > 64 || candidate < requiredFee)
        }
      }
    }
  }
})

test('sell planning is deterministic across bounded proof-count and fee combinations', () => {
  const truncatedKeys = Object.fromEntries(Object.entries(KEYS).slice(0, 14))
  for (const [shares, expectedProofCount] of [
    [1, 5],
    [3, 8],
    [9, 17],
    [13, 22],
  ]) {
    for (const inputFeePpk of [1, 999, 1_000, 1_001, 2_500]) {
      const input = {
        side: 'Sell' as const,
        priceNumerator: 9_000,
        amountSubunits: shares * 10_000,
        divisibility: 10_000,
        inputFeePpk,
        offerKeysetKeys: truncatedKeys,
        maxPoolEntries: 128,
      }
      const first = planCtfRangeOrderAuthorization(input)
      const second = planCtfRangeOrderAuthorization(input)
      const proofCount = first.authorizationAmounts.length
      const cashuSplit = splitAmount(BigInt(input.amountSubunits), { ...truncatedKeys })
        .map((amount) => amount.toString())
        .join(',')

      assert.equal(proofCount, expectedProofCount)
      assert.equal(first.authorizationAmounts.join(','), cashuSplit)
      assert.equal(
        first.participantFeeAllocationUpperBound,
        feeForCount(inputFeePpk, proofCount).toString(),
      )
      assert.equal(first.inputAmount, second.inputAmount)
      assert.equal(first.authorizationAmounts.join(','), second.authorizationAmounts.join(','))
      assert.equal(
        first.participantFeeAllocationUpperBound,
        second.participantFeeAllocationUpperBound,
      )
    }
  }
})

function feeForCount(inputFeePpk: number, inputCount: number): bigint {
  return (BigInt(inputFeePpk) * BigInt(inputCount) + 999n) / 1_000n
}
