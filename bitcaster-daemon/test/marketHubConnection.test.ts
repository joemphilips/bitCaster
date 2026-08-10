import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseMarketStatusChanged } from '../src/marketHubConnection.ts'

test('MarketStatusChanged requires one exact closed-condition identity', () => {
  const conditionId = 'ab'.repeat(32)
  assert.deepEqual(
    parseMarketStatusChanged({
      conditionId: conditionId.toUpperCase(),
      state: 'closed',
      closedAt: '2026-08-02T00:00:00.000Z',
      finalOutcome: 'YES',
    }),
    {
      conditionId,
      state: 'closed',
      closedAt: '2026-08-02T00:00:00.000Z',
      finalOutcome: 'YES',
    },
  )
  assert.throws(
    () =>
      parseMarketStatusChanged({
        conditionId,
        state: 'closed',
        closedAt: null,
        finalOutcome: 'YES',
      }),
    /lifecycle fields/,
  )
})
