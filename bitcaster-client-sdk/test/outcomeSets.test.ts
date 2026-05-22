import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  canonicalizeOutcomeSet,
  complementOutcomeSetId,
  outcomeSetIdsForMarketBooks,
  parseOutcomeSetId,
  resolveOutcomeSets,
} from '../src/outcomeSets.ts'
import type { SdkMarketForTrading } from '../src/types.ts'

const categoricalMarket: SdkMarketForTrading = {
  id: 'condition-1',
  type: 'categorical',
  outcomes: [
    { id: 'alice', label: 'Alice' },
    { id: 'bob', label: 'Bob' },
    { id: 'carol', label: 'Carol' },
  ],
}

test('canonicalizeOutcomeSet produces stable finite outcome-set ids', () => {
  assert.equal(canonicalizeOutcomeSet(['Carol', 'Alice', 'Alice']), 'Alice|Carol')
  assert.deepEqual(parseOutcomeSetId(' Bob | Alice | '), ['Bob', 'Alice'])
  assert.equal(
    complementOutcomeSetId(['Alice', 'Bob', 'Carol'], 'Alice|Carol'),
    'Bob',
  )
})

test('resolveOutcomeSets preserves categorical YES oracle labels', () => {
  assert.deepEqual(
    resolveOutcomeSets(categoricalMarket, { side: 'yes', outcomeId: 'alice' }),
    {
      selectedOutcomeSetId: 'Alice',
      complementOutcomeSetId: 'Bob|Carol',
    },
  )
})

test('resolveOutcomeSets maps categorical NO to the complement outcome set', () => {
  assert.deepEqual(
    resolveOutcomeSets(categoricalMarket, { side: 'no', outcomeId: 'alice' }),
    {
      selectedOutcomeSetId: 'Bob|Carol',
      complementOutcomeSetId: 'Alice',
    },
  )
})

test('outcomeSetIdsForMarketBooks enumerates direct and complement books', () => {
  assert.deepEqual(new Set(outcomeSetIdsForMarketBooks(categoricalMarket)), new Set([
    'Alice',
    'Bob',
    'Carol',
    'Alice|Bob',
    'Alice|Carol',
    'Bob|Carol',
  ]))
})

test('resolveOutcomeSets fails closed for missing or unmatched selections', () => {
  assert.equal(resolveOutcomeSets(categoricalMarket, { side: 'yes' }), null)
  assert.equal(
    resolveOutcomeSets(categoricalMarket, { side: 'yes', outcomeId: 'dave' }),
    null,
  )
  assert.equal(
    resolveOutcomeSets({ id: 'condition-empty', type: 'yesno', outcomes: [] }, {
      side: 'yes',
    }),
    null,
  )
})
