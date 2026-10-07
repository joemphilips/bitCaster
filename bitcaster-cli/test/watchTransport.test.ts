import assert from 'node:assert/strict'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { Readable, Writable } from 'node:stream'
import { isDeepStrictEqual } from 'node:util'
import { after, before, mock, test } from 'node:test'
import { bootstrapFreshDaemonProfile } from '../../bitcaster-daemon/src/profileBootstrap.ts'
import { readRpcToken } from '../../bitcaster-daemon/src/rpcAuth.ts'
import { configureDataDirForTest } from '@bitcaster-market/daemon/dataDir'
import {
  DAEMON_WATCH_FRAME_BYTES_MAX,
  DAEMON_WATCH_MEDIA_TYPE,
  type DaemonWatchFrame,
} from '@bitcaster-market/daemon/protocol'
import {
  readDaemonWatchFrames,
  watchDaemon,
  watchDaemonToOutput,
  writeDaemonWatchFrames,
} from '../src/rpc.ts'

const watch = { method: 'wallet.watch' as const }
const event: DaemonWatchFrame = {
  type: 'event',
  event: 'snapshot',
  sourceRevision: 4,
  data: { label: 'Alpha 😀' },
}
const terminal: DaemonWatchFrame = { type: 'complete' }
const line = (frame: DaemonWatchFrame) => Buffer.from(JSON.stringify(frame) + '\n')
const urlSymbol = Symbol.for('bitcaster.test.daemon-url')
const globals = globalThis as Record<symbol, unknown>
const previousHome = process.env.BITCASTER_DAEMON_HOME
let directory: string

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ndjson-cli-'))
  process.env.BITCASTER_DAEMON_HOME = directory
  configureDataDirForTest(() => process.env.BITCASTER_DAEMON_HOME)
  await bootstrapFreshDaemonProfile({
    directory,
    engineBaseUrl: 'https://engine.example',
    mintUrl: 'https://mint.example',
    walletSeedHex: '11'.repeat(64),
    nostrSecretKeyHex: '22'.repeat(32),
  })
})
after(async () => {
  if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
  else process.env.BITCASTER_DAEMON_HOME = previousHome
  delete globals[urlSymbol]
  await rm(directory, { recursive: true, force: true })
})

async function* chunks(values: Uint8Array[]) {
  for (const value of values) yield value
}

test('real byte parser accepts split UTF-8 and coalesced frames without decoded chunk assumptions', async () => {
  const bytes = Buffer.concat([line(event), line(event), line(terminal)])
  const split = bytes.indexOf(Buffer.from('😀')) + 1
  const frames = []
  for await (const frame of readDaemonWatchFrames(
    chunks([bytes.subarray(0, split), bytes.subarray(split)]),
  ))
    frames.push(frame)
  assert.equal(frames.length, 3)
  assert.equal(isDeepStrictEqual(frames[0], event), true)
  assert.equal(frames[2]?.type, 'complete')
})

test('line bound counts bytes and newline at the adjacent 4 MiB boundary', async () => {
  const base = { type: 'event' as const, event: 'snapshot', data: '' }
  const exact = line({
    ...base,
    data: 'x'.repeat(DAEMON_WATCH_FRAME_BYTES_MAX - line(base).byteLength),
  })
  assert.equal(exact.byteLength, DAEMON_WATCH_FRAME_BYTES_MAX)
  let count = 0
  for await (const frame of readDaemonWatchFrames(chunks([exact, line(terminal)]))) {
    count++
    if (frame.type === 'event') assert.equal(typeof frame.data, 'string')
  }
  assert.equal(count, 2)
  await assert.rejects(async () => {
    for await (const _frame of readDaemonWatchFrames(
      chunks([Buffer.alloc(DAEMON_WATCH_FRAME_BYTES_MAX, 120)]),
    )) {
      /* no accepted frame */
    }
  }, /byte limit/)
})

test('malformed or unterminated input fails safely and remote terminal errors are redacted', async () => {
  for (const value of [
    Buffer.from('{bad}\n'),
    Buffer.from([255, 10]),
    line(event).subarray(0, -1),
    line(event),
  ]) {
    await assert.rejects(async () => {
      for await (const _frame of readDaemonWatchFrames(chunks([value]))) {
        /* consume */
      }
    }, /invalid daemon watch frame|without a terminal frame/)
  }
  const error: DaemonWatchFrame = { type: 'error', code: 'watch-failed', error: 'fixture-secret' }
  const result = await readDaemonWatchFrames(chunks([line(error)])).next()
  assert.equal(JSON.stringify(result).includes('fixture-secret'), false)
})

test('parser cancellation returns its byte source once and does not pull ahead', async () => {
  let pulls = 0
  let returned = 0
  const source = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        pulls++
        return { done: false, value: line(event) }
      },
      return: async () => {
        returned++
        return { done: true as const, value: undefined }
      },
    }),
  }
  const reader = readDaemonWatchFrames(source)
  await reader.next()
  assert.equal(pulls, 1)
  await reader.return(undefined)
  assert.equal(returned, 1)
  assert.equal(pulls, 1)
})

test('stdout backpressure and cancellation stop the next event pull', async () => {
  let pulls = 0
  let returned = 0
  let release: (() => void) | undefined
  const source = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        pulls++
        return { done: false, value: event }
      },
      return: async () => {
        returned++
        return { done: true as const, value: undefined }
      },
    }),
  }
  const output = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      release = () => callback()
    },
  })
  const controller = new AbortController()
  const pending = writeDaemonWatchFrames(source, output, { signal: controller.signal })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(pulls, 1)
  controller.abort()
  await assert.rejects(pending, /aborted/)
  assert.equal(returned, 1)
  assert.equal(pulls, 1)
  assert.equal(output.listenerCount('drain'), 0)
  release?.()
  output.destroy()
})

test('TCP watch uses existing bearer auth and closes its fetch body on cancellation', async () => {
  globals[urlSymbol] = 'http://daemon.test'
  let cancelled = 0
  let pulls = 0
  const token = await readRpcToken()
  const fetchMock = mock.method(globalThis, 'fetch', async (url: unknown, options: RequestInit) => {
    assert.equal(url, 'http://daemon.test/rpc')
    const headers = new Headers(options.headers)
    assert.equal(headers.get('accept'), DAEMON_WATCH_MEDIA_TYPE)
    assert.equal(headers.get('authorization') === `Bearer ${token}`, true)
    assert.equal(options.body, JSON.stringify(watch))
    return new Response(
      new ReadableStream(
        {
          pull(controller) {
            pulls++
            controller.enqueue(line(event))
          },
          cancel() {
            cancelled++
          },
        },
        { highWaterMark: 0 },
      ),
      { headers: { 'content-type': DAEMON_WATCH_MEDIA_TYPE } },
    )
  })
  try {
    const reader = watchDaemon(watch)
    assert.equal((await reader.next()).value?.type, 'event')
    assert.equal(pulls, 1)
    await reader.return(undefined)
    assert.equal(cancelled, 1)
    assert.equal(pulls, 1)
  } finally {
    fetchMock.mock.restore()
    delete globals[urlSymbol]
  }
})

test('output adapter reports redacted terminal failure and closes its response once', async () => {
  globals[urlSymbol] = 'http://daemon.test'
  let cancelled = 0
  const lines: string[] = []
  const output = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk))
      callback()
    },
  })
  const fetchMock = mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        new ReadableStream({
          start(body) {
            body.enqueue(
              line({ type: 'error', code: 'watch-failed', error: 'fixture-private-details' }),
            )
          },
          cancel() {
            cancelled++
          },
        }),
        { headers: { 'content-type': DAEMON_WATCH_MEDIA_TYPE } },
      ),
  )
  try {
    assert.equal(await watchDaemonToOutput(watch, output), 'error')
    assert.deepEqual(
      lines.map((value) => JSON.parse(value)),
      [{ type: 'error', code: 'watch-failed', error: 'daemon watch failed' }],
    )
    assert.equal(cancelled, 1)
    assert.equal(output.listenerCount('close'), 0)
    assert.equal(output.listenerCount('error'), 0)
  } finally {
    fetchMock.mock.restore()
    delete globals[urlSymbol]
    output.destroy()
  }
})

test('output adapter reports ordinary completion without changing its JSON lines', async () => {
  const lines: string[] = []
  const output = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk))
      callback()
    },
  })
  async function* frames() {
    yield event
    yield terminal
  }
  assert.equal(await writeDaemonWatchFrames(frames(), output), 'complete')
  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[1]!).type, 'complete')
  output.destroy()
})

test('watch reader refuses unauthorized or ordinary JSON responses without echoing body errors', async () => {
  globals[urlSymbol] = 'http://daemon.test'
  const fetchMock = mock.method(
    globalThis,
    'fetch',
    async () => new Response('fixture-private-error', { status: 401 }),
  )
  try {
    await assert.rejects(watchDaemon(watch).next(), /daemon watch response was refused/)
  } finally {
    fetchMock.mock.restore()
    delete globals[urlSymbol]
  }
})

test('external cancellation aborts a pending TCP body read and closes it once', async () => {
  globals[urlSymbol] = 'http://daemon.test'
  let cancelled = 0
  let seenSignal: AbortSignal | undefined
  const controller = new AbortController()
  const fetchMock = mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, options: RequestInit) => {
      seenSignal = options.signal!
      return new Response(
        new ReadableStream({
          start(body) {
            options.signal!.addEventListener(
              'abort',
              () => body.error(new Error('transport cancelled')),
              { once: true },
            )
          },
          cancel() {
            cancelled++
          },
        }),
        { headers: { 'content-type': DAEMON_WATCH_MEDIA_TYPE } },
      )
    },
  )
  try {
    const reader = watchDaemon(watch, { signal: controller.signal })
    const next = reader.next()
    await new Promise<void>((resolve) => setImmediate(resolve))
    controller.abort()
    await assert.rejects(next, /request aborted|transport cancelled/)
    assert.equal(seenSignal?.aborted, true)
    // An already errored body has no underlying cancel callback to invoke.
    assert.equal(cancelled, 0)
  } finally {
    fetchMock.mock.restore()
    delete globals[urlSymbol]
  }
})

test('closed stdout while waiting for drain releases the event source once', async () => {
  let returned = 0
  const source = {
    [Symbol.asyncIterator]: () => ({
      next: async () => ({ done: false, value: event }),
      return: async () => {
        returned++
        return { done: true as const, value: undefined }
      },
    }),
  }
  const output = new Writable({
    highWaterMark: 1,
    write() {
      /* drain never arrives */
    },
  })
  const pending = writeDaemonWatchFrames(source, output)
  await new Promise<void>((resolve) => setImmediate(resolve))
  output.destroy()
  await assert.rejects(pending, /aborted/)
  assert.equal(returned, 1)
  assert.equal(output.listenerCount('drain'), 0)
  assert.equal(output.listenerCount('close'), 0)
})

test('output adapter closes the actual pending reader through its shared network signal', async () => {
  globals[urlSymbol] = 'http://daemon.test'
  let signal: AbortSignal | undefined
  const fetchMock = mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, options: RequestInit) => {
      signal = options.signal!
      return new Response(
        new ReadableStream({
          start(body) {
            signal!.addEventListener('abort', () => body.error(new Error('transport cancelled')), {
              once: true,
            })
          },
        }),
        { headers: { 'content-type': DAEMON_WATCH_MEDIA_TYPE } },
      )
    },
  )
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
  try {
    const pending = watchDaemonToOutput(watch, output)
    await new Promise<void>((resolve) => setImmediate(resolve))
    output.destroy()
    await assert.rejects(pending, /request aborted|transport cancelled/)
    assert.equal(signal?.aborted, true)
    assert.equal(output.listenerCount('close'), 0)
    assert.equal(output.listenerCount('error'), 0)
  } finally {
    fetchMock.mock.restore()
    delete globals[urlSymbol]
  }
})

test('generic output cancellation does not wait for a noncooperative next or return', async () => {
  let returned = 0
  const source = {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<DaemonWatchFrame>>(() => undefined),
      return: () => {
        returned++
        return new Promise<IteratorResult<DaemonWatchFrame>>(() => undefined)
      },
    }),
  }
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
  const pending = writeDaemonWatchFrames(source, output)
  await new Promise<void>((resolve) => setImmediate(resolve))
  output.destroy()
  await assert.rejects(pending, /request aborted/)
  assert.equal(returned, 1)
  assert.equal(output.listenerCount('close'), 0)
})

test('Unix watch uses the existing HTTP request path and destroys its response and request once', async () => {
  delete globals[urlSymbol]
  let requestDestroyed = 0
  let responseClosed = 0
  const response = Object.assign(Readable.from([line(event)]), {
    statusCode: 200,
    headers: { 'content-type': DAEMON_WATCH_MEDIA_TYPE },
  })
  response.once('close', () => responseClosed++)
  const req = Object.assign(new EventEmitter(), {
    end: (body: string) => {
      assert.equal(body, JSON.stringify(watch))
    },
    destroy: () => {
      requestDestroyed++
    },
  })
  const token = await readRpcToken()
  const requestMock = mock.method(
    http,
    'request',
    (options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
      assert.equal(typeof options.socketPath, 'string')
      assert.equal(options.path, '/rpc')
      const headers = options.headers as Record<string, string>
      assert.equal(headers.accept, DAEMON_WATCH_MEDIA_TYPE)
      assert.equal(headers.authorization === `Bearer ${token}`, true)
      queueMicrotask(() => callback(response as unknown as http.IncomingMessage))
      return req as unknown as http.ClientRequest
    },
  )
  syncBuiltinESMExports()
  try {
    const reader = watchDaemon(watch)
    assert.equal((await reader.next()).value?.type, 'event')
    await reader.return(undefined)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(requestDestroyed, 1)
    assert.equal(responseClosed, 1)
  } finally {
    requestMock.mock.restore()
    syncBuiltinESMExports()
  }
})
