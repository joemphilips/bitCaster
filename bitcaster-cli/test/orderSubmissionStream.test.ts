import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readOrderSubmissionFrames } from '../src/rpc.ts'
async function* chunks(lines: string[]) {
  for (const line of lines) yield Buffer.from(line)
}
async function read(lines: string[]) {
  const out = []
  for await (const f of readOrderSubmissionFrames(chunks(lines))) out.push(f)
  return out
}
test('submission parser retains progress and terminal response across split bytes', async () => {
  const body =
    JSON.stringify({ type: 'quotes-refreshing', attempt: 1, remainingMs: 58000 }) +
    '\n' +
    JSON.stringify({ type: 'result', response: { ok: true, result: { orderId: 'original' } } }) +
    '\n'
  const result = await read([body.slice(0, 13), body.slice(13)])
  assert.equal(result.length, 2)
})
test('EOF is uncertainty, never a successful terminal response', async () => {
  await assert.rejects(
    read([JSON.stringify({ type: 'quotes-refreshing', attempt: 1, remainingMs: 58000 }) + '\n']),
    /without a terminal/,
  )
})
test('malformed and excessive progress are rejected', async () => {
  await assert.rejects(
    read([JSON.stringify({ type: 'quotes-refreshing', attempt: 99, remainingMs: 58000 }) + '\n']),
    /invalid/,
  )
  await assert.rejects(
    read(
      Array(32).fill(
        JSON.stringify({ type: 'quotes-refreshing', attempt: 1, remainingMs: 58000 }) + '\n',
      ),
    ),
    /frame count/,
  )
})
