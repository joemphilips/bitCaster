import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { serveOrderSubmission } from '../src/orderSubmissionTransport.ts'
import { decodeOrderSubmissionFrame } from '../src/protocol.ts'

function transport() {
  const req = Object.assign(new EventEmitter(), { aborted: false })
  const lines: string[] = []
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
    writeHead() {},
    write(line: string) {
      lines.push(line)
      return true
    },
    end() {
      this.writableEnded = true
    },
    destroy() {
      this.destroyed = true
      this.emit('close')
    },
  })
  return { req: req as unknown as IncomingMessage, res: res as unknown as ServerResponse, lines }
}
test('one mutation yields progress then one terminal response', async () => {
  const { req, res, lines } = transport()
  let dispatched = 0
  await serveOrderSubmission(req, res, true, async (_signal, waiting) => {
    dispatched++
    waiting({ attempt: 1, remainingMs: 59000 })
    return { ok: true, result: { orderId: 'original' } }
  })
  assert.equal(dispatched, 1)
  assert.equal(res.writableEnded, true)
  assert.deepEqual(
    lines.map((s) => decodeOrderSubmissionFrame(JSON.parse(s))).map((f) => f.type),
    ['quotes-refreshing', 'result'],
  )
  assert.equal(req.listenerCount('aborted'), 0)
  assert.equal(res.listenerCount('close'), 0)
})
test('disconnect cancels waiting and emits no invented rejection', async () => {
  const { req, res, lines } = transport()
  let signal: AbortSignal | undefined
  await serveOrderSubmission(req, res, true, async (s, waiting) => {
    signal = s
    waiting({ attempt: 1, remainingMs: 59000 })
    res.emit('close')
    assert.equal(s.aborted, true)
    return { ok: false, error: 'recover' }
  })
  assert.equal(signal?.aborted, true)
  assert.equal(lines.length, 1)
})
test('slow reader stops submission instead of buffering unbounded progress', async () => {
  const { req, res } = transport()
  res.write = (() => false) as typeof res.write
  await serveOrderSubmission(req, res, true, async (signal, waiting) => {
    waiting({ attempt: 1, remainingMs: 59000 })
    assert.equal(signal.aborted, true)
    return { ok: false, error: 'recover' }
  })
  assert.equal(res.destroyed, true)
})
test('ordinary JSON submission remains compatible', async () => {
  const { req, res, lines } = transport()
  let output = ''
  res.end = ((value: string) => {
    output = value
    return res
  }) as typeof res.end
  await serveOrderSubmission(req, res, false, async (_signal, waiting) => {
    waiting({ attempt: 1, remainingMs: 59000 })
    return { ok: true, result: { orderId: 'original' } }
  })
  assert.equal(lines.length, 0)
  assert.equal(JSON.parse(output).ok, true)
})
