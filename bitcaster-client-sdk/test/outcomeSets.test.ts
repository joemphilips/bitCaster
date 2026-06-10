import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  canonicalizeOutcomeSet,
  complementOutcomeSetId,
  outcomeSetDisplayLabel,
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

test('resolveOutcomeSets maps binary NO to the No primitive outcome', () => {
  assert.deepEqual(resolveOutcomeSets(yesNoMarket, { side: 'no' }), {
    publicOutcomeSetId: 'No',
    tokenSide: 'Outcome',
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

test('outcomeSetDisplayLabel hides internal one-vs-rest complement ids', () => {
  assert.equal(
    outcomeSetDisplayLabel(['A', 'B', 'C'], 'B|C'),
    'NOT A',
  )
  assert.equal(
    outcomeSetDisplayLabel(['Alice', 'Bob', 'Carol'], 'Bob|Carol'),
    'NOT Alice',
  )
  assert.equal(outcomeSetDisplayLabel(['Yes', 'No'], 'No'), 'No')
  assert.equal(outcomeSetDisplayLabel([], 'B|C'), 'Complement')
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
