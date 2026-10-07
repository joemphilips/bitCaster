import assert from 'node:assert/strict'
import test from 'node:test'
import { createTradeCommentTemplate, tradeCommentToWire } from '../src/tradeComment.ts'

const input = {
  conditionId: 'condition A',
  marketUrl: 'https://app.example/markets/condition%20A',
  content: 'My trade reason',
  createdAt: 1_790_000_000,
}

test('trade comment binds the explicit market URL and preserves the signed wire payload', () => {
  const template = createTradeCommentTemplate(input)
  assert.deepEqual(template, {
    kind: 1,
    created_at: 1_790_000_000,
    tags: [['r', 'https://app.example/markets/condition%20A']],
    content: 'My trade reason',
  })
  assert.deepEqual(tradeCommentToWire({ ...template, id: 'id', pubkey: 'pubkey', sig: 'sig' }), {
    kind: 1,
    createdAt: 1_790_000_000,
    tags: [['r', 'https://app.example/markets/condition%20A']],
    content: 'My trade reason',
    id: 'id',
    pubkey: 'pubkey',
    sig: 'sig',
  })
})

test('trade comment refuses a different market, noncanonical URL, or oversized content', () => {
  for (const marketUrl of [
    'https://app.example/markets/other',
    `${input.marketUrl}?tracking=1`,
    `${input.marketUrl}#comment`,
    'https://user:password@app.example/markets/condition%20A',
    'file:///markets/condition%20A',
  ]) {
    assert.throws(() => createTradeCommentTemplate({ ...input, marketUrl }), /market page URL/)
  }
  assert.throws(() => createTradeCommentTemplate({ ...input, content: 'x'.repeat(281) }), /280/)
  assert.throws(() => createTradeCommentTemplate({ ...input, createdAt: 1.5 }), /timestamp/)
  assert.equal(
    createTradeCommentTemplate({ ...input, content: 'x'.repeat(280) }).content.length,
    280,
  )
})
