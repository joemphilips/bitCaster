import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  canonicalizeOutcomeSet,
  complementOutcomeSetId,
  outcomeSetDisplayLabel,
  outcomeSetIdsForMarketBooks,
  parseMarketOutcomes,
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
  assert.equal(complementOutcomeSetId(['Alice', 'Bob', 'Carol'], 'Alice|Carol'), 'Bob')
})

test('parseMarketOutcomes rejects malformed or ambiguous engine authority', () => {
  assert.deepEqual(
    parseMarketOutcomes({
      outcomes: ['Yes', { id: 'no', label: 'No' }, { id: 'draw', name: 'Draw' }],
    }),
    [
      { id: 'Yes', label: 'Yes' },
      { id: 'no', label: 'No' },
      { id: 'draw', label: 'Draw' },
    ],
  )
  for (const market of [
    {},
    { outcomes: [] },
    { outcomes: ['Only'] },
    { outcomes: Array.from({ length: 9 }, (_, index) => `outcome-${index}`) },
    { outcomes: ['Yes', ''] },
    { outcomes: [{ id: 'yes' }] },
    { outcomes: ['Yes', { id: 'other', label: 'Yes' }] },
    {
      outcomes: [
        { id: 'same', label: 'Yes' },
        { id: 'same', label: 'No' },
      ],
    },
  ]) {
    assert.throws(() => parseMarketOutcomes(market), /engine market outcome/)
  }
})

test('resolveOutcomeSets preserves categorical YES oracle labels', () => {
  assert.deepEqual(resolveOutcomeSets(categoricalMarket, { side: 'yes', outcomeId: 'alice' }), {
    publicOutcomeSetId: 'Alice',
    tokenSide: 'Outcome',
    selectedOutcomeSetId: 'Alice',
    complementOutcomeSetId: 'Bob|Carol',
  })
})

test('resolveOutcomeSets maps categorical NO to primitive public route plus internal complement', () => {
  assert.deepEqual(resolveOutcomeSets(categoricalMarket, { side: 'no', outcomeId: 'alice' }), {
    publicOutcomeSetId: 'Alice',
    tokenSide: 'Complement',
    selectedOutcomeSetId: 'Bob|Carol',
    complementOutcomeSetId: 'Alice',
  })
})

test('resolveOutcomeSets maps binary NO to the YES complement', () => {
  assert.deepEqual(resolveOutcomeSets(yesNoMarket, { side: 'no' }), {
    publicOutcomeSetId: 'Yes',
    tokenSide: 'Complement',
    selectedOutcomeSetId: 'No',
    complementOutcomeSetId: 'Yes',
  })
})

test('outcomeSetIdsForMarketBooks enumerates primitive public books only', () => {
  assert.deepEqual(
    new Set(outcomeSetIdsForMarketBooks(categoricalMarket)),
    new Set(['Alice', 'Bob', 'Carol']),
  )
})

test('outcomeSetDisplayLabel hides internal one-vs-rest complement ids', () => {
  assert.equal(outcomeSetDisplayLabel(['A', 'B', 'C'], 'B|C'), 'Not A')
  assert.equal(outcomeSetDisplayLabel(['Alice', 'Bob', 'Carol'], 'Bob|Carol'), 'Not Alice')
  assert.equal(outcomeSetDisplayLabel(['Yes', 'No'], 'No'), 'No')
  assert.equal(outcomeSetDisplayLabel([], 'B|C'), 'B or C')
  assert.equal(outcomeSetDisplayLabel(['A', 'B', 'C', 'D'], 'B|C'), 'B or C')
})

test('resolveOutcomeSets fails closed for missing or unmatched selections', () => {
  assert.equal(resolveOutcomeSets(categoricalMarket, { side: 'yes' }), null)
  assert.equal(resolveOutcomeSets(categoricalMarket, { side: 'yes', outcomeId: 'dave' }), null)
  assert.equal(
    resolveOutcomeSets(
      { id: 'condition-empty', type: 'yesno', outcomes: [] },
      {
        side: 'yes',
      },
    ),
    null,
  )
})
