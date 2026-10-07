import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  didMarketTransitionToClosed,
  parseObservedMarketState,
  type ObservedMarketState,
} from '../src/likedMarketClose.ts'

test('the browser closure predicate emits only an observed open-to-closed transition', () => {
  for (const [previous, current, closed] of [
    [undefined, 'open', false],
    [undefined, 'closed', false],
    [null, 'closed', false],
    ['open', 'open', false],
    ['open', 'closed', true],
    ['closed', 'open', false],
    ['closed', 'closed', false],
  ] as const)
    assert.equal(didMarketTransitionToClosed(previous, current), closed)
})

test('lifecycle ingress uses the exact generated catalogue wire values and refuses unknown states', () => {
  assert.equal(parseObservedMarketState('open'), 'open')
  assert.equal(parseObservedMarketState('closed'), 'closed')
  for (const input of [undefined, null, '', 'Open', 'Closed', 'pending', 1])
    assert.throws(() => parseObservedMarketState(input), /lifecycle state/)
  assert.throws(
    () => didMarketTransitionToClosed('other' as ObservedMarketState, 'closed'),
    /lifecycle state/,
  )
  assert.throws(
    () => didMarketTransitionToClosed('open', 'other' as ObservedMarketState),
    /lifecycle state/,
  )
})
