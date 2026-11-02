import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_PRIMAL_INDEXER_FRAME_BYTES,
  MAX_PRIMAL_INDEXER_FRAMES,
  PRIMAL_CACHE_URL,
  PRIMAL_PROFILE_INDEXER_TIMEOUT_MS,
  decodePrimalUserStats,
  readPrimalProfileStats,
  type PrimalProfileIndexerOptions,
  type PrimalSocket,
} from '../src/primalProfileIndexer.ts'

const pubkey = '82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2'
const now = 1_793_000_000
// Shape captured from a read-only `user_profile` request to wss://cache2.primal.net/v1.
const statsContent = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    pubkey,
    follows_count: 695,
    followers_count: 275_547,
    note_count: 5_692,
    long_form_note_count: 1,
    reply_count: 8_016,
    time_joined: 1_670_984_277,
    relay_count: 6,
    total_zap_count: 23_846,
    total_satszapped: 10_849_530,
    media_count: 462,
    content_zap_count: 525,
    ...overrides,
  })

class FakeSocket implements PrimalSocket {
  readyState = 0
  sent: string[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((message: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  readonly url: string
  constructor(url: string) {
    this.url = url
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.closed = true
    this.readyState = 3
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) })
  }
  subscription(): string {
    return (JSON.parse(this.sent[0]!) as [string, string])[1]
  }
}

function harness(extra: Partial<PrimalProfileIndexerOptions> = {}) {
  const sockets: FakeSocket[] = []
  const timers: { callback: () => void; ms: number; cleared: boolean }[] = []
  const options: PrimalProfileIndexerOptions = {
    openSocket: (url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      ;(handle as { cleared: boolean }).cleared = true
    },
    nowSeconds: () => now,
    ...extra,
  }
  return { sockets, timers, options }
}

const statsFrame = (socket: FakeSocket, content = statsContent()) => [
  'EVENT',
  socket.subscription(),
  { kind: 10_000_105, content },
]

test('reads follower, follow and note counts and the first activity time from user_profile', async () => {
  const { sockets, timers, options } = harness()
  const read = readPrimalProfileStats(pubkey, options)
  const socket = sockets[0]!
  assert.equal(socket.url, PRIMAL_CACHE_URL)
  assert.equal(timers[0]!.ms, PRIMAL_PROFILE_INDEXER_TIMEOUT_MS)
  socket.open()
  const [verb, subscription, filter] = JSON.parse(socket.sent[0]!) as [string, string, unknown]
  assert.equal(verb, 'REQ')
  assert.match(subscription, /^[0-9a-zA-Z-]{1,64}$/)
  assert.deepEqual(filter, { cache: ['user_profile', { pubkey }] })
  socket.receive([
    'EVENT',
    'other-subscription',
    { kind: 10_000_105, content: statsContent({ followers_count: 1 }) },
  ])
  socket.receive(['EVENT', subscription, { kind: 0, content: '{"name":"jack"}' }])
  socket.receive(statsFrame(socket))
  assert.deepEqual(await read, {
    followersCount: 275_547,
    followsCount: 695,
    noteCount: 5_692,
    firstActivityAt: 1_670_984_277,
  })
  assert.equal(socket.closed, true)
  assert.equal(timers[0]!.cleared, true)
  assert.deepEqual(JSON.parse(socket.sent[1]!), ['CLOSE', subscription])
})

test('decoder keeps only non-negative safe integers and a plausible first activity time', () => {
  assert.deepEqual(
    decodePrimalUserStats(
      statsContent({
        followers_count: -1,
        follows_count: 1.5,
        note_count: '12',
        time_joined: 1_000,
      }),
      pubkey,
      now,
    ),
    null,
  )
  assert.deepEqual(
    decodePrimalUserStats(
      statsContent({
        followers_count: 3,
        follows_count: null,
        note_count: 2 ** 60,
        time_joined: now + 7_200,
      }),
      pubkey,
      now,
    ),
    { followersCount: 3, followsCount: null, noteCount: null, firstActivityAt: null },
  )
  for (const content of [
    statsContent({ pubkey: 'b'.repeat(64) }),
    JSON.stringify({ followers_count: 3 }),
    '[1]',
    'null',
    '{',
    42,
  ])
    assert.equal(decodePrimalUserStats(content, pubkey, now), null)
})

test('returns null without a socket for an invalid public key or an aborted signal', async () => {
  const { sockets, options } = harness()
  assert.equal(await readPrimalProfileStats('npub1notvalid', options), null)
  assert.equal(await readPrimalProfileStats(pubkey.toUpperCase(), options), null)
  const controller = new AbortController()
  controller.abort()
  assert.equal(
    await readPrimalProfileStats(pubkey, { ...options, signal: controller.signal }),
    null,
  )
  assert.equal(sockets.length, 0)
})

test('returns null and closes the socket on timeout, abort, error, close and protocol refusals', async () => {
  const cases: Array<[string, (socket: FakeSocket, fire: () => void, abort: () => void) => void]> =
    [
      ['timeout', (_socket, fire) => fire()],
      ['abort', (_socket, _fire, abort) => abort()],
      ['error', (socket) => socket.onerror?.()],
      ['close', (socket) => socket.onclose?.()],
      ['eose without stats', (socket) => socket.receive(['EOSE', socket.subscription()])],
      ['closed', (socket) => socket.receive(['CLOSED', socket.subscription(), 'rate-limited'])],
      ['notice', (socket) => socket.receive(['NOTICE', 'unknown request'])],
      ['non-json', (socket) => socket.receive('not json')],
      ['binary', (socket) => socket.onmessage?.({ data: new Uint8Array(4) })],
      [
        'foreign pubkey',
        (socket) => socket.receive(statsFrame(socket, statsContent({ pubkey: 'c'.repeat(64) }))),
      ],
      [
        'oversized frame',
        (socket) =>
          socket.receive(
            statsFrame(
              socket,
              statsContent({ padding: 'x'.repeat(MAX_PRIMAL_INDEXER_FRAME_BYTES) }),
            ),
          ),
      ],
      [
        'too many frames',
        (socket) => {
          for (let i = 0; i <= MAX_PRIMAL_INDEXER_FRAMES; i++)
            socket.receive(['EVENT', socket.subscription(), { kind: 10_000_119, content: '{}' }])
          socket.receive(statsFrame(socket))
        },
      ],
    ]
  for (const [name, act] of cases) {
    const controller = new AbortController()
    const { sockets, timers, options } = harness({ signal: controller.signal })
    const read = readPrimalProfileStats(pubkey, options)
    const socket = sockets[0]!
    socket.open()
    act(
      socket,
      () => timers[0]!.callback(),
      () => controller.abort(),
    )
    // A late valid frame after the read settled must not change its result.
    socket.receive(statsFrame(socket))
    assert.equal(await read, null, name)
    assert.equal(socket.closed, true, name)
    assert.equal(timers[0]!.cleared, true, name)
  }
})

test('a socket constructor failure returns null', async () => {
  const { options } = harness({
    openSocket: () => {
      throw new Error('blocked')
    },
  })
  assert.equal(await readPrimalProfileStats(pubkey, options), null)
})
