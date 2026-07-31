import assert from 'node:assert/strict'
import test from 'node:test'
import { assertOrderRouteBelongsToCondition, parseOrderRouteId } from '../src/orderRoute.ts'

test('order route parsing uses the exact rightmost outcome boundary', () => {
  assert.deepEqual(parseOrderRouteId('condition-with-dashes-YES'), {
    conditionId: 'condition-with-dashes',
    outcomeId: 'YES',
  })
  assert.equal(parseOrderRouteId('missing-outcome-'), null)
  assert.equal(parseOrderRouteId('missingroute'), null)
  assert.equal(parseOrderRouteId('condition-Bob|Carol'), null)
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
