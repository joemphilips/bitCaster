import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertOrderRouteBelongsToCondition,
  conditionIdFromMarketId,
  parseOrderRouteId,
} from '../src/orderRoute.ts'

test('order route parsing uses the exact rightmost outcome boundary', () => {
  assert.deepEqual(parseOrderRouteId('condition-with-dashes-YES'), {
    conditionId: 'condition-with-dashes',
    outcomeId: 'YES',
  })
  assert.equal(parseOrderRouteId('missing-outcome-'), null)
  assert.equal(parseOrderRouteId('missingroute'), null)
  assert.equal(parseOrderRouteId('condition-Bob|Carol'), null)
})

test('condition id parsing preserves exact order-route validation', () => {
  assert.equal(conditionIdFromMarketId('condition-with-dashes-YES'), 'condition-with-dashes')
  assert.equal(conditionIdFromMarketId('abcdef-NO'), 'abcdef')
  assert.throws(() => conditionIdFromMarketId('missingroute'), /exact order route/)
})

test('order route condition authority is exact', () => {
  assert.deepEqual(
    assertOrderRouteBelongsToCondition('condition-with-dashes-NO', 'condition-with-dashes'),
    {
      conditionId: 'condition-with-dashes',
      outcomeId: 'NO',
    },
  )
  assert.throws(
    () => assertOrderRouteBelongsToCondition('foreign-condition-YES', 'condition-with-dashes'),
    /foreign condition/,
  )
})
