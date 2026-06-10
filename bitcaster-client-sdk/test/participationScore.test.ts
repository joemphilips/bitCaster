import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planParticipationScoreTopUp } from '../src/participationScore.ts'

test('planParticipationScoreTopUp disables payment when Score is off', () => {
  assert.deepEqual(
    planParticipationScoreTopUp({
      enabled: false,
      balance: -10,
      matchDebitScore: 0,
    }),
    { kind: 'disabled' },
  )
})

test('planParticipationScoreTopUp accepts an existing sufficient balance', () => {
  assert.deepEqual(
    planParticipationScoreTopUp({
      enabled: true,
      balance: 2,
      matchDebitScore: 2,
    }),
    { kind: 'sufficient', requiredScore: 2 },
  )
})

test('planParticipationScoreTopUp computes deficit from negative balances', () => {
  assert.deepEqual(
    planParticipationScoreTopUp({
      enabled: true,
      balance: -2,
      matchDebitScore: 1,
    }),
    { kind: 'needs-top-up', requiredScore: 1, deficitScore: 3 },
  )
})

test('planParticipationScoreTopUp rejects invalid enabled debit settings', () => {
  assert.throws(
    () =>
      planParticipationScoreTopUp({
        enabled: true,
        balance: 0,
        matchDebitScore: 0,
      }),
    /Engine Score debit is misconfigured/,
  )
})
