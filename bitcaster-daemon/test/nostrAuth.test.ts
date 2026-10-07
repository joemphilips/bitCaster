import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { signNativeTradeComment } from '../src/nostrAuth.ts'

const require = createRequire(import.meta.url)
const { verifyEvent } = require('nostr-tools/pure') as {
  verifyEvent(event: unknown): boolean
}

test('native trade comment carries a valid signature over the shared market payload', () => {
  const comment = signNativeTradeComment(
    { privateKeyHex: '01'.repeat(32) },
    {
      conditionId: 'test-condition',
      marketUrl: 'http://localhost:5173/markets/test-condition',
      content: 'Test trade reason',
      createdAt: 1_790_000_000,
    },
  )
  const { createdAt, ...wire } = comment
  const signed = { ...wire, created_at: createdAt }
  assert.equal(verifyEvent(signed), true)
  assert.deepEqual(comment.tags, [['r', 'http://localhost:5173/markets/test-condition']])
  assert.equal(comment.content, 'Test trade reason')
  assert.equal(comment.kind, 1)
  assert.equal(verifyEvent({ ...wire, created_at: createdAt, content: 'Different reason' }), false)
})
