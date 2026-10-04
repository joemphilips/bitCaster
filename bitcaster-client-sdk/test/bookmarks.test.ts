import assert from 'node:assert/strict'
import { test } from 'node:test'
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import {
  BOOKMARK_D_TAG,
  BOOKMARK_KIND,
  bookmarkEventTemplate,
  bookmarkSetsEqual,
  normalizeBookmarkMarkets,
  parseBookmarkPayload,
  setMarketBookmark,
  unionBookmarkMarkets,
} from '../src/bookmarks.ts'

test('bookmark payload accepts the browser wire shape, preserves strings, and deduplicates', () => {
  assert.deepEqual(parseBookmarkPayload('{"markets":["second","first","second"],"other":true}'), [
    'second',
    'first',
  ])
  assert.deepEqual(parseBookmarkPayload('{"markets":[]}'), [])
  for (const input of ['null', '[]', '{}', '{"markets":[1]}', '{"markets":"first"}', '{'])
    assert.equal(parseBookmarkPayload(input), null)
  assert.throws(() => normalizeBookmarkMarkets([1 as unknown as string]), /array of strings/)
})

test('bookmark set edits and initial union are idempotent without a size cutoff', () => {
  assert.deepEqual(setMarketBookmark(['a', 'a', 'b'], 'a', true), ['a', 'b'])
  assert.deepEqual(setMarketBookmark(['a', 'a', 'b'], 'a', false), ['b'])
  assert.deepEqual(setMarketBookmark(['a'], 'missing', false), ['a'])
  assert.deepEqual(unionBookmarkMarkets(['a', 'b'], ['b', 'c']), ['a', 'b', 'c'])
  assert.equal(bookmarkSetsEqual(['a', 'a', 'b'], ['b', 'a']), true)
  assert.equal(bookmarkSetsEqual(['a'], ['b']), false)
  const many = Array.from({ length: 1_001 }, (_, index) => `condition-${index}`)
  assert.deepEqual(parseBookmarkPayload(bookmarkEventTemplate(many, 1).content), many)
})

test('real signed public bookmark fixture has the exact replaceable kind and identifier', () => {
  const secret = new Uint8Array(32).fill(7)
  const event = finalizeEvent(
    bookmarkEventTemplate(['condition', 'condition'], 1_700_000_000),
    secret,
  )
  assert.equal(verifyEvent(event), true)
  assert.equal(event.pubkey, getPublicKey(secret))
  assert.equal(event.kind, BOOKMARK_KIND)
  assert.deepEqual(event.tags, [['d', BOOKMARK_D_TAG]])
  assert.deepEqual(parseBookmarkPayload(event.content), ['condition'])
  assert.throws(() => bookmarkEventTemplate([], -1), /time/)
})
