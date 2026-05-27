import assert from 'node:assert/strict'
import { test } from 'node:test'
import { keysetToOutcomeCollection } from '../src/proofSelection.ts'

test('keysetToOutcomeCollection maps each keyset to exactly one outcome collection', () => {
  assert.deepEqual(
    [...keysetToOutcomeCollection(
      [
        { keysetId: 'keyset-a', outcomeCollection: 'A' },
        { keysetId: 'keyset-b', outcomeCollection: 'B|C' },
      ],
      (row) => row,
    )],
    [
      ['keyset-a', 'A'],
      ['keyset-b', 'B|C'],
    ],
  )
})

test('keysetToOutcomeCollection rejects ambiguous keyset mappings', () => {
  assert.throws(
    () =>
      keysetToOutcomeCollection(
        [
          { keysetId: 'keyset-a', outcomeCollection: 'A' },
          { keysetId: 'keyset-a', outcomeCollection: 'B' },
        ],
        (row) => row,
      ),
    /maps to both A and B/,
  )
})
