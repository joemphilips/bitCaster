import assert from 'node:assert/strict'
import test from 'node:test'
import { readAllocationBoundedJsonResponse } from '../src/boundedJsonResponse.ts'

test('bounded JSON reader rejects declared length before reading a fallback body', async () => {
  let fallbackReads = 0
  await assert.rejects(
    () =>
      readAllocationBoundedJsonResponse(
        {
          body: null,
          headers: new Headers({ 'content-length': '33' }),
          async readBoundedBody() {
            fallbackReads += 1
            return new Uint8Array()
          },
        },
        32,
      ),
    /response byte limit exceeded/,
  )
  assert.equal(fallbackReads, 0)
})

test('bounded JSON reader cancels a stream rejected by declared metadata', async () => {
  let cancelled = false
  const response = new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    }),
    { headers: { 'content-length': '33' } },
  )

  await assert.rejects(() => readAllocationBoundedJsonResponse(response, 32), /byte limit exceeded/)
  assert.equal(cancelled, true)
})

test('bounded JSON reader cancels a stream rejected by an invalid configured cap', async () => {
  let cancelled = false
  const response = new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    }),
  )

  await assert.rejects(() => readAllocationBoundedJsonResponse(response, 0), /limit is invalid/)
  assert.equal(cancelled, true)
})

test('bounded JSON reader cancels a decompressed stream immediately on overflow', async () => {
  let cancelled = false
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"value":"'))
        controller.enqueue(new Uint8Array(64))
      },
      cancel() {
        cancelled = true
      },
    }),
  )

  await assert.rejects(() => readAllocationBoundedJsonResponse(response, 16), /byte limit exceeded/)
  assert.equal(cancelled, true)
})

test('bounded JSON reader rejects malformed UTF-8 before JSON parsing', async () => {
  const response = new Response(Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]))

  await assert.rejects(
    () => readAllocationBoundedJsonResponse(response, 32),
    /returned invalid UTF-8/,
  )
})

test('bounded JSON reader cancels a stream after an invalid chunk', async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue('foreign chunk' as unknown as Uint8Array)
    },
    cancel() {
      cancelled = true
    },
  })

  await assert.rejects(
    () => readAllocationBoundedJsonResponse(new Response(stream), 32),
    /stream returned invalid data/,
  )
  assert.equal(cancelled, true)
})
