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

const yesNoMarket: SdkMarketForTrading = {
  id: 'condition-yesno',
  type: 'yesno',
  outcomes: [
    { id: 'yes', label: 'Yes' },
    { id: 'no', label: 'No' },
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
      publicOutcomeSetId: 'Alice',
      tokenSide: 'Outcome',
      selectedOutcomeSetId: 'Alice',
      complementOutcomeSetId: 'Bob|Carol',
    },
  )
})

test('resolveOutcomeSets maps categorical NO to primitive public route plus internal complement', () => {
  assert.deepEqual(
    resolveOutcomeSets(categoricalMarket, { side: 'no', outcomeId: 'alice' }),
    {
      publicOutcomeSetId: 'Alice',
      tokenSide: 'Complement',
      selectedOutcomeSetId: 'Bob|Carol',
      complementOutcomeSetId: 'Alice',
    },
  )
})

test('resolveOutcomeSets maps binary NO to the Yes primitive complement', () => {
  assert.deepEqual(resolveOutcomeSets(yesNoMarket, { side: 'no' }), {
    publicOutcomeSetId: 'Yes',
    tokenSide: 'Complement',
    selectedOutcomeSetId: 'No',
    complementOutcomeSetId: 'Yes',
  })
})

test('outcomeSetIdsForMarketBooks enumerates primitive public books only', () => {
  assert.deepEqual(new Set(outcomeSetIdsForMarketBooks(categoricalMarket)), new Set([
    'Alice',
    'Bob',
    'Carol',
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
