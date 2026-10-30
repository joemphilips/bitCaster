import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  calculateSettlementCapabilityV1Tariff,
  PARTICIPATION_SCORE_TOP_UP_BUFFER,
  PARTICIPATION_SCORE_TOP_UP_BUFFER_MINIMUM_SPARE,
  planParticipationScoreTopUp,
  planParticipationScoreTopUpFromWallet,
} from '../src/participationScore.ts'

test('planParticipationScoreTopUp disables payment when Score is off', () => {
  assert.deepEqual(planParticipationScoreTopUp({ enabled: false, balance: -10 }, 7), {
    kind: 'disabled',
  })
  assert.deepEqual(planParticipationScoreTopUp({ enabled: false, balance: -10 }, 7, 0), {
    kind: 'disabled',
  })
})

test('planParticipationScoreTopUp accepts an existing sufficient balance', () => {
  assert.deepEqual(planParticipationScoreTopUp({ enabled: true, balance: 2 }, 2), {
    kind: 'sufficient',
    requiredScore: 2,
  })
  assert.deepEqual(planParticipationScoreTopUp({ enabled: true, balance: 2 }, 2, 0), {
    kind: 'sufficient',
    requiredScore: 2,
  })
})

test('the Score top-up buffer is 50 Score units and needs 200 spare', () => {
  assert.equal(PARTICIPATION_SCORE_TOP_UP_BUFFER, 50)
  assert.equal(PARTICIPATION_SCORE_TOP_UP_BUFFER_MINIMUM_SPARE, 200)
})

test('planParticipationScoreTopUp buys only the shortfall without a payable Score', () => {
  assert.deepEqual(planParticipationScoreTopUp({ enabled: true, balance: -2 }, 1), {
    kind: 'needs-top-up',
    requiredScore: 1,
    deficitScore: 3,
    topUpScore: 3,
  })
})

test('planParticipationScoreTopUp buys the buffer when the wallet keeps enough spare', () => {
  for (const availableScore of [200, 10_000]) {
    assert.deepEqual(
      planParticipationScoreTopUp({ enabled: true, balance: 0 }, 3, availableScore),
      {
        kind: 'needs-top-up',
        requiredScore: 3,
        deficitScore: 3,
        topUpScore: 50,
      },
    )
  }
})

test('planParticipationScoreTopUp keeps a small wallet for trades', () => {
  for (const availableScore of [0, 2, 20, 199]) {
    assert.deepEqual(
      planParticipationScoreTopUp({ enabled: true, balance: 1 }, 4, availableScore),
      {
        kind: 'needs-top-up',
        requiredScore: 4,
        deficitScore: 3,
        topUpScore: 3,
      },
    )
  }
})

test('planParticipationScoreTopUp buys the full shortfall when it exceeds the buffer', () => {
  assert.deepEqual(planParticipationScoreTopUp({ enabled: true, balance: -680 }, 20), {
    kind: 'needs-top-up',
    requiredScore: 20,
    deficitScore: 700,
    topUpScore: 700,
  })
  assert.deepEqual(planParticipationScoreTopUp({ enabled: true, balance: -680 }, 20, 10_000), {
    kind: 'needs-top-up',
    requiredScore: 20,
    deficitScore: 700,
    topUpScore: 700,
  })
})

test('planParticipationScoreTopUp rejects an invalid payable Score', () => {
  for (const availableScore of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => planParticipationScoreTopUp({ enabled: true, balance: 0 }, 1, availableScore),
      /payable Score is invalid/,
    )
  }
})

test('planParticipationScoreTopUpFromWallet reads the wallet only for a shortfall', async () => {
  let reads = 0
  const readAvailableScore = async () => {
    reads += 1
    return 20
  }
  assert.deepEqual(
    await planParticipationScoreTopUpFromWallet(
      { enabled: false, balance: -10 },
      7,
      readAvailableScore,
    ),
    { kind: 'disabled' },
  )
  assert.deepEqual(
    await planParticipationScoreTopUpFromWallet(
      { enabled: true, balance: 2 },
      2,
      readAvailableScore,
    ),
    { kind: 'sufficient', requiredScore: 2 },
  )
  assert.equal(reads, 0)
  assert.deepEqual(
    await planParticipationScoreTopUpFromWallet(
      { enabled: true, balance: 1 },
      4,
      readAvailableScore,
    ),
    { kind: 'needs-top-up', requiredScore: 4, deficitScore: 3, topUpScore: 3 },
  )
  assert.equal(reads, 1)
})

test('planParticipationScoreTopUp rejects an invalid explicit tariff', () => {
  assert.throws(
    () => planParticipationScoreTopUp({ enabled: true, balance: 0 }, 0),
    /tariff is invalid/,
  )
})

test('calculateSettlementCapabilityV1Tariff applies the immutable formula', () => {
  assert.equal(
    calculateSettlementCapabilityV1Tariff({
      inputCount: 17,
      manifestCount: 17,
      artifactByteCount: 4_097,
    }),
    22,
  )
})

test('calculateSettlementCapabilityV1Tariff enforces server work bounds', () => {
  assert.throws(
    () =>
      calculateSettlementCapabilityV1Tariff({
        inputCount: 65,
        manifestCount: 0,
        artifactByteCount: 1,
      }),
    /input count is invalid/,
  )
  assert.throws(
    () =>
      calculateSettlementCapabilityV1Tariff({
        inputCount: 1,
        manifestCount: 129,
        artifactByteCount: 1,
      }),
    /manifest count is invalid/,
  )
  assert.throws(
    () =>
      calculateSettlementCapabilityV1Tariff({
        inputCount: 1,
        manifestCount: 0,
        artifactByteCount: 262_145,
      }),
    /artifact byte count is invalid/,
  )
})
