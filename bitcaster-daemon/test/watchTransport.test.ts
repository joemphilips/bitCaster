import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { after, before, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleRequest } from '../src/server.ts'
import { streamDaemonWatch, type DaemonWatchProvider } from '../src/watchTransport.ts'
import {
  DAEMON_WATCH_FRAME_BYTES_MAX,
  DAEMON_WATCH_MEDIA_TYPE,
  DAEMON_WATCH_REQUEST_BYTES_MAX,
  type DaemonWatchEvent,
} from '../src/protocol.ts'

const command = { method: 'wallet.watch' as const }
const event: DaemonWatchEvent = {
  type: 'event',
  event: 'snapshot',
  sourceRevision: 7,
  data: { balance: 3 },
}
const token = 'fixture-auth-token'
const previousHome = process.env.BITCASTER_DAEMON_HOME
let directory: string
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ndjson-handler-'))
  process.env.BITCASTER_DAEMON_HOME = directory
})
after(async () => {
  if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
  else process.env.BITCASTER_DAEMON_HOME = previousHome
  await rm(directory, { recursive: true, force: true })
})

class MockResponse extends EventEmitter {
  status = 0
  headers: Record<string, string> = {}
  lines: string[] = []
  destroyed = false
  ended = false
  blocked = false
  writeHead(status: number, headers: Record<string, string>) {
    this.status = status
    this.headers = headers
  }
  write(line: string) {
    this.lines.push(line)
    return !this.blocked
  }
  end(line?: string) {
    if (line !== undefined) this.lines.push(line)
    this.ended = true
  }
  asResponse(): ServerResponse {
    return this as unknown as ServerResponse
  }
}

function mockRequest(body = JSON.stringify(command), headers: Record<string, string> = {}) {
  let consumed = 0
  const stream = Readable.from(
    (async function* () {
      consumed++
      yield Buffer.from(body)
    })(),
  )
  return {
    request: Object.assign(stream, {
      method: 'POST',
      url: '/rpc',
      headers,
      socket: { remoteAddress: '127.0.0.1' },
    }) as unknown as IncomingMessage,
    consumed: () => consumed,
  }
}

function providerFixture() {
  let pulls = 0
  let returns = 0
  let signal: AbortSignal | undefined
  const provider: DaemonWatchProvider = (_command, selectedSignal) => {
    signal = selectedSignal
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () =>
          ++pulls <= 2 ? { done: false, value: event } : { done: true, value: undefined },
        return: async () => {
          returns++
          return { done: true, value: undefined }
        },
      }),
    }
  }
  return { provider, pulls: () => pulls, returns: () => returns, signal: () => signal }
}

test('authenticated watch uses the existing handler and one bounded NDJSON response', async () => {
  const fixture = providerFixture()
  const req = mockRequest(undefined, {
    authorization: `Bearer ${token}`,
    accept: DAEMON_WATCH_MEDIA_TYPE,
  })
  const res = new MockResponse()
  await handleRequest(req.request, res.asResponse(), token, { watch: fixture.provider })
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], DAEMON_WATCH_MEDIA_TYPE)
  assert.equal(res.ended, true)
  assert.equal(res.lines.length, 3)
  assert.equal(JSON.parse(res.lines[2]!).type, 'complete')
  assert.equal(fixture.returns(), 1)
  assert.equal(fixture.signal()?.aborted, true)
})

for (const authorization of [undefined, 'Bearer wrong-token']) {
  test(`bad bearer ${authorization === undefined ? 'missing' : 'wrong'} consumes no request body`, async () => {
    const req = mockRequest('not JSON', {
      ...(authorization === undefined ? {} : { authorization }),
      accept: DAEMON_WATCH_MEDIA_TYPE,
    })
    const res = new MockResponse()
    await handleRequest(req.request, res.asResponse(), token)
    assert.equal(res.status, 401)
    assert.equal(req.consumed(), 0)
    assert.equal(res.headers['content-type'], 'application/json')
  })
}

test('watch requires explicit acceptance and an exact typed selector', async () => {
  for (const input of [
    { body: JSON.stringify(command), headers: { authorization: `Bearer ${token}` }, status: 406 },
    {
      body: JSON.stringify({ method: 'market.watch', params: { conditionIds: ['wrong'] } }),
      headers: { authorization: `Bearer ${token}`, accept: DAEMON_WATCH_MEDIA_TYPE },
      status: 400,
    },
    {
      body: JSON.stringify({ method: 'health' }),
      headers: { authorization: `Bearer ${token}`, accept: DAEMON_WATCH_MEDIA_TYPE },
      status: 400,
    },
  ]) {
    const req = mockRequest(input.body, input.headers)
    const res = new MockResponse()
    let opened = 0
    await handleRequest(req.request, res.asResponse(), token, {
      watch: () => {
        opened++
        throw new Error('must not open')
      },
    })
    assert.equal(res.status, input.status)
    assert.equal(opened, 0)
  }
})

test('ordinary authenticated RPC remains JSON and no-token health stays separately bounded', async () => {
  const req = mockRequest(JSON.stringify({ method: 'health' }), {
    authorization: `Bearer ${token}`,
  })
  const response = new MockResponse()
  await handleRequest(req.request, response.asResponse(), token)
  assert.equal(response.status, 200)
  assert.equal(response.headers['content-type'], 'application/json')
  assert.equal(JSON.parse(response.lines[0]!).ok, true)
  const unauthenticated = mockRequest(JSON.stringify({ method: 'health' }))
  const health = new MockResponse()
  await handleRequest(unauthenticated.request, health.asResponse(), null)
  assert.equal(health.status, 200)
  const funded = mockRequest(JSON.stringify({ method: 'wallet.send', params: { amountMsat: 1 } }))
  const refused = new MockResponse()
  await handleRequest(funded.request, refused.asResponse(), null)
  assert.equal(refused.status, 401)
  const oversized = mockRequest(' '.repeat(DAEMON_WATCH_REQUEST_BYTES_MAX + 1))
  const capped = new MockResponse()
  await handleRequest(oversized.request, capped.asResponse(), null)
  assert.equal(capped.status, 400)
})

test('watch request bytes are refused before JSON parsing or subscription creation', async () => {
  const req = mockRequest(' '.repeat(DAEMON_WATCH_REQUEST_BYTES_MAX + 1), {
    authorization: `Bearer ${token}`,
    accept: DAEMON_WATCH_MEDIA_TYPE,
  })
  const res = new MockResponse()
  let opened = 0
  await handleRequest(req.request, res.asResponse(), token, {
    watch: () => {
      opened++
      throw new Error('must not open')
    },
  })
  assert.equal(res.status, 400)
  assert.equal(opened, 0)
})

test('slow socket consumer blocks the next provider pull without an event queue', async () => {
  const fixture = providerFixture()
  const res = new MockResponse()
  res.blocked = true
  const pending = streamDaemonWatch(
    mockRequest().request,
    res.asResponse(),
    command,
    fixture.provider,
  )
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(fixture.pulls(), 1)
  assert.equal(res.lines.length, 1)
  res.blocked = false
  res.emit('drain')
  await pending
  assert.equal(fixture.pulls(), 3)
  assert.equal(fixture.returns(), 1)
})

for (const pendingAt of ['drain', 'next'] as const) {
  test(`disconnect at pending ${pendingAt} releases the iterator once`, async () => {
    const res = new MockResponse()
    res.blocked = pendingAt === 'drain'
    let returned = 0
    let signal: AbortSignal | undefined
    const pending = streamDaemonWatch(
      mockRequest().request,
      res.asResponse(),
      command,
      (_command, selectedSignal) => {
        signal = selectedSignal
        return {
          [Symbol.asyncIterator]: () => ({
            next: () =>
              pendingAt === 'next'
                ? new Promise(() => undefined)
                : Promise.resolve({ done: false, value: event }),
            return: async () => {
              returned++
              return { done: true, value: undefined }
            },
          }),
        }
      },
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    res.destroyed = true
    res.emit('close')
    await pending
    assert.equal(returned, 1)
    assert.equal(signal?.aborted, true)
    assert.equal(res.listenerCount('drain'), 0)
    assert.equal(res.listenerCount('close'), 0)
    assert.equal(res.listenerCount('error'), 0)
  })
}

test('unavailable and failed providers emit only redacted terminal frames', async () => {
  const secret = 'fixture-private-error'
  for (const provider of [
    undefined,
    () => {
      throw new Error(secret)
    },
    async function* () {
      yield { ...event, data: 'x'.repeat(DAEMON_WATCH_FRAME_BYTES_MAX) }
    },
  ]) {
    const res = new MockResponse()
    await streamDaemonWatch(mockRequest().request, res.asResponse(), command, provider)
    assert.equal(res.lines.length, 1)
    assert.equal(JSON.parse(res.lines[0]!).type, 'error')
    assert.equal(res.lines[0]!.includes(secret), false)
    assert.equal(Buffer.byteLength(res.lines[0]!) < 256, true)
  }
})

test('provider resolved after disconnect still releases its iterator once', async () => {
  const res = new MockResponse()
  let returned = 0
  let resolveProvider: ((source: AsyncIterable<DaemonWatchEvent>) => void) | undefined
  const pending = streamDaemonWatch(
    mockRequest().request,
    res.asResponse(),
    command,
    () =>
      new Promise((resolve) => {
        resolveProvider = resolve
      }),
  )
  await new Promise<void>((resolve) => setImmediate(resolve))
  res.destroyed = true
  res.emit('close')
  await pending
  resolveProvider!({
    [Symbol.asyncIterator]: () => ({
      next: async () => ({ done: true, value: undefined }),
      return: async () => {
        returned++
        return { done: true, value: undefined }
      },
    }),
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(returned, 1)
})
