import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  calculateSettlementCapabilityV1Tariff,
  planParticipationScoreTopUp,
} from '../src/participationScore.ts'

test('planParticipationScoreTopUp disables payment when Score is off', () => {
  assert.deepEqual(planParticipationScoreTopUp({ enabled: false, balance: -10 }, 7), {
    kind: 'disabled',
  })
})

test('planParticipationScoreTopUp accepts an existing sufficient balance', () => {
  assert.deepEqual(planParticipationScoreTopUp({ enabled: true, balance: 2 }, 2), {
    kind: 'sufficient',
    requiredScore: 2,
  })
})

test('planParticipationScoreTopUp computes deficit from negative balances', () => {
  assert.deepEqual(planParticipationScoreTopUp({ enabled: true, balance: -2 }, 1), {
    kind: 'needs-top-up',
    requiredScore: 1,
    deficitScore: 3,
  })
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
