import assert from 'node:assert/strict'
import { test } from 'node:test'
import { finalizeEvent } from 'nostr-tools/pure'
import { readSignedOracleEvent } from '../src/oracleResolutionExplanation.ts'
import { oracleTestKey } from './fixtures/oraclePublication.ts'

function signed(kind: 88 | 89 | 1111, tags: string[][]) {
  return JSON.stringify(
    finalizeEvent({ kind, tags, content: '', created_at: 1_700_000_000 }, oracleTestKey),
  )
}

test('signed announcement preserves Japanese descriptions above the old 1024-byte tag bound', () => {
  for (const description of ['界'.repeat(342), '界'.repeat(2000), '🌦'.repeat(2000)]) {
    const json = signed(88, [['description', description]])
    assert.equal(readSignedOracleEvent(json, 88).tags[0][1], description)
  }
})

test('description reader accepts the exact UTF-8 bound and refuses one extra byte', () => {
  const description = '界'.repeat(2730) + 'ab'
  assert.equal(new TextEncoder().encode(description).length, 8192)
  assert.equal(
    readSignedOracleEvent(signed(88, [['description', description]]), 88).tags[0][1],
    description,
  )
  assert.throws(
    () => readSignedOracleEvent(signed(88, [['description', description + 'c']]), 88),
    /tag|limit|large/i,
  )
})

test('larger announcement descriptions do not widen unrelated tags or event kinds', () => {
  for (const [kind, tags] of [
    [89, [['description', 'x'.repeat(1025)]]],
    [1111, [['description', 'x'.repeat(1025)]]],
    [88, [['title', 'x'.repeat(1025)]]],
    [88, [['description', 'ok', 'x'.repeat(1025)]]],
    [88, [['x'.repeat(1025), 'ok']]],
  ] as Array<[88 | 89 | 1111, string[][]]>) {
    assert.throws(() => readSignedOracleEvent(signed(kind, tags), kind), /tag/i)
  }
})
