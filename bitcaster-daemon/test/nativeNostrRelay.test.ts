import assert from 'node:assert/strict'
import { test } from 'node:test'
import { finalizeEvent } from 'nostr-tools/pure'
import { NativeNostrRelay, createNativeNostrRelays } from '../src/nativeNostrRelay.ts'

function fakeTransport() {
  const sockets: FakeSocket[] = []
  class FakeSocket {
    readonly url: string
    readyState = 0
    onopen: WebSocket['onopen'] = null
    onclose: WebSocket['onclose'] = null
    onerror: WebSocket['onerror'] = null
    onmessage: WebSocket['onmessage'] = null
    sent: string[] = []
    closeCount = 0

    constructor(url: string) {
      this.url = url
      sockets.push(this)
    }
    open() {
      this.readyState = 1
      this.onopen?.call(this as unknown as WebSocket, new Event('open'))
    }
    message(value: unknown) {
      this.onmessage?.call(
        this as unknown as WebSocket,
        new MessageEvent('message', { data: JSON.stringify(value) }),
      )
    }
    fail() {
      this.onerror?.call(this as unknown as WebSocket, new Event('untrusted-error'))
    }
    remoteClose() {
      this.readyState = 3
      this.onclose?.call(this as unknown as WebSocket, new Event('close') as CloseEvent)
    }
    close() {
      this.closeCount += 1
      this.readyState = 3
      this.onclose?.call(this as unknown as WebSocket, new Event('close') as CloseEvent)
    }
    send(value: string) {
      this.sent.push(value)
    }
  }
  return { sockets, websocketImplementation: FakeSocket as unknown as typeof WebSocket }
}

const event = finalizeEvent(
  { kind: 1, created_at: 1_900_000_000, tags: [], content: 'unit-test-event' },
  new Uint8Array(32).fill(1),
)

test('receiver frame bound rejects before upstream JSON decode', async (t) => {
  const current = await ready({ maxMessageBytes: 8, awaitMessageCallbacks: true })
  t.after(() => current.relay.close())
  const parse = JSON.parse
  let parsed = 0
  const oversized = 'x'.repeat(9)
  JSON.parse = (...args: Parameters<typeof JSON.parse>) => {
    if (args[0] === oversized) parsed += 1
    return parse(...args)
  }
  try {
    current.sockets[0]!.onmessage?.call(
      current.sockets[0] as unknown as WebSocket,
      new MessageEvent('message', { data: oversized }),
    )
    await drain()
    assert.equal(parsed, 0)
    assert.equal(current.relay.closed, true)
  } finally {
    JSON.parse = parse
  }
})

test('unsolicited subscription closure is observable but local cleanup does not notify', async (t) => {
  const current = await ready()
  t.after(() => current.relay.close())
  let closures = 0
  const owner = current.relay.subscribe([{ kinds: [1] }], {
    onevent: () => {},
    onclose: () => {
      closures += 1
    },
  })
  await drain()
  const request = JSON.parse(current.sockets[0]!.sent[0]!)
  current.sockets[0]!.message(['CLOSED', request[1], 'untrusted refusal text'])
  await drain()
  assert.equal(closures, 1)
  owner.close()
  const second = current.relay.subscribe([{ kinds: [1] }], {
    onevent: () => {},
    onclose: () => {
      closures += 1
    },
  })
  second.close()
  current.relay.close()
  assert.equal(closures, 1)
})

async function drain() {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

async function ready(options: ConstructorParameters<typeof NativeNostrRelay>[1] = {}) {
  const transport = fakeTransport()
  const relay = new NativeNostrRelay('wss://custom.example/Path?B=2&A=Case', {
    ...options,
    ...transport,
  })
  const connected = relay.connect()
  transport.sockets[0]!.open()
  await connected
  return { relay, ...transport }
}

test('per-instance seam connects exact selected endpoints without changing global WebSocket', async (t) => {
  const before = globalThis.WebSocket
  const transport = fakeTransport()
  const selected = [
    'wss://CUSTOM.example/Path?B=2&A=Case',
    'wss://custom.example/Path/',
    'wss://custom.example/Path',
    'wss://custom.example/a//b?z=Z&a=A',
    'wss://custom.example/npub1ExplicitTarget',
    'ws://[::1]:8080/Local?Case=Yes',
  ]
  const relays = createNativeNostrRelays([...selected, selected[0]!], transport)
  t.after(() => relays.forEach((relay) => relay.close()))
  const attempts = relays.map((relay) => relay.connect())
  assert.deepEqual(
    transport.sockets.map((socket) => socket.url),
    ['wss://custom.example/Path?B=2&A=Case', ...selected.slice(1)],
  )
  assert.equal(relays.length, 6)
  transport.sockets.forEach((socket) => socket.open())
  await Promise.all(attempts)
  assert.equal(globalThis.WebSocket, before)
  assert.deepEqual(
    relays.map((relay) => relay.url),
    transport.sockets.map((socket) => socket.url),
  )
})

test('explicit empty selection and invalid endpoints create no socket', () => {
  const transport = fakeTransport()
  assert.deepEqual(createNativeNostrRelays([], transport), [])
  for (const url of [
    'https://custom.example',
    'wss://user:password@custom.example',
    'wss://custom.example/#fragment',
    'ws://custom.example',
    'ws://127.1',
  ])
    assert.throws(() => createNativeNostrRelays([url], transport), /Relay|relay/)
  assert.equal(transport.sockets.length, 0)
})

test('pre-aborted owner refuses startup without a socket or signal.onabort overwrite', async () => {
  const transport = fakeTransport()
  const abort = new AbortController()
  const sentinel = () => {}
  abort.signal.onabort = sentinel
  abort.abort()
  const relay = new NativeNostrRelay('wss://custom.example', { ...transport, signal: abort.signal })
  await assert.rejects(relay.connect(), /^Error: Nostr relay is closed\.$/)
  assert.equal(transport.sockets.length, 0)
  assert.equal(abort.signal.onabort, sentinel)
})

test('cancellation owns a connecting socket and rejects late open with no reconnect', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const transport = fakeTransport()
  const abort = new AbortController()
  let closed = 0
  const relay = new NativeNostrRelay('wss://custom.example', {
    ...transport,
    signal: abort.signal,
    onclose: () => {
      closed += 1
    },
  })
  const attempt = relay.connect()
  const rejection = assert.rejects(attempt, /^Error: Nostr relay connection failed\.$/)
  const socket = transport.sockets[0]!
  const lateOpen = socket.onopen!
  const lateError = socket.onerror!
  abort.abort()
  lateOpen.call(socket as unknown as WebSocket, new Event('open'))
  lateError.call(socket as unknown as WebSocket, new Event('error'))
  await rejection
  relay.close()
  t.mock.timers.tick(120_000)
  await drain()
  assert.equal(socket.closeCount, 1)
  assert.equal(socket.onopen, null)
  assert.equal(socket.onmessage, null)
  assert.equal(relay.connected, false)
  assert.equal(closed, 1)
  assert.equal(transport.sockets.length, 1)
  assert.deepEqual(socket.sent, [])
  await assert.rejects(relay.connect(), /Nostr relay is closed/)
})

test('startup timeout closes a connecting socket and fences late open', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const transport = fakeTransport()
  const relay = new NativeNostrRelay('wss://custom.example', { ...transport, connectTimeoutMs: 25 })
  const attempt = relay.connect()
  const rejection = assert.rejects(attempt, /^Error: Nostr relay connection failed\.$/)
  const socket = transport.sockets[0]!
  const lateOpen = socket.onopen!
  t.mock.timers.tick(25)
  await rejection
  lateOpen.call(socket as unknown as WebSocket, new Event('open'))
  assert.equal(relay.closed, true)
  assert.equal(socket.closeCount, 1)
  assert.equal(relay.connected, false)
})

test('concurrent startup reuses one attempt; successful close releases the abort listener', async (t) => {
  const transport = fakeTransport()
  const abort = new AbortController()
  const remove = t.mock.method(abort.signal, 'removeEventListener')
  const sentinel = () => {}
  abort.signal.onabort = sentinel
  const relay = new NativeNostrRelay('wss://custom.example', { ...transport, signal: abort.signal })
  const first = relay.connect()
  const second = relay.connect()
  assert.equal(transport.sockets.length, 1)
  transport.sockets[0]!.open()
  await Promise.all([first, second])
  assert.equal(abort.signal.onabort, sentinel)
  relay.close()
  assert.equal(remove.mock.calls.length, 1)
  assert.equal(remove.mock.calls[0]!.arguments[0], 'abort')
  abort.abort()
  assert.equal(transport.sockets[0]!.closeCount, 1)
})

test('constructor, peer error and peer close produce redacted terminal startup errors', async () => {
  const throwing = class {
    constructor() {
      throw new Error('untrusted constructor details')
    }
  }
  const refused = new NativeNostrRelay('wss://custom.example', {
    websocketImplementation: throwing as unknown as typeof WebSocket,
  })
  await assert.rejects(refused.connect(), /^Error: Nostr relay connection failed\.$/)
  for (const kind of ['fail', 'remoteClose'] as const) {
    const transport = fakeTransport()
    const relay = new NativeNostrRelay('wss://custom.example', transport)
    const attempt = relay.connect()
    const rejection = assert.rejects(attempt, /^Error: Nostr relay connection failed\.$/)
    transport.sockets[0]![kind]()
    await rejection
    assert.equal(relay.closed, true)
    assert.equal(transport.sockets[0]!.closeCount, 1)
  }
})

test('real nostr-tools subscription verifies signatures and filters, then cancellation fences callbacks', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const abort = new AbortController()
  const { relay, sockets } = await ready({ signal: abort.signal })
  t.after(() => relay.close())
  const received: string[] = []
  let eose = 0
  const debug = t.mock.method(console, 'debug', () => {})
  relay.subscribe([{ kinds: [1], authors: [event.pubkey] }], {
    onevent: (value) => {
      received.push(value.id)
    },
    oneose: () => {
      eose += 1
    },
    eoseTimeoutMs: 20,
  })
  await drain()
  const socket = sockets[0]!
  const id = JSON.parse(socket.sent[0]!)[1]
  socket.message(['EVENT', id, event])
  socket.message(['EVENT', id, { ...event, content: 'tampered' }])
  socket.message([
    'EVENT',
    id,
    finalizeEvent(
      { kind: 2, created_at: event.created_at, tags: [], content: '' },
      new Uint8Array(32).fill(1),
    ),
  ])
  socket.message(['NOTICE', 'untrusted notice'])
  const lateMessage = socket.onmessage!
  abort.abort()
  lateMessage.call(
    socket as unknown as WebSocket,
    new MessageEvent('message', { data: JSON.stringify(['EVENT', id, event]) }),
  )
  t.mock.timers.tick(120_000)
  await drain()
  assert.deepEqual(received, [event.id])
  assert.equal(eose, 0)
  assert.equal(debug.mock.calls.length, 0)
  assert.equal(socket.closeCount, 1)
  assert.equal(sockets.length, 1)
})

test('individual subscription close is idempotent and leaves other subscriptions active', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { relay, sockets } = await ready()
  t.after(() => relay.close())
  let first = 0
  let second = 0
  let eose = 0
  const subscription = relay.subscribe([{ kinds: [1] }], {
    onevent: () => {
      first += 1
    },
    oneose: () => {
      eose += 1
    },
    eoseTimeoutMs: 20,
  })
  relay.subscribe([{ kinds: [1] }], {
    onevent: () => {
      second += 1
    },
    eoseTimeoutMs: 20,
  })
  await drain()
  const socket = sockets[0]!
  const ids = socket.sent.map((line) => JSON.parse(line)[1])
  subscription.close()
  subscription.close()
  await drain()
  socket.message(['EVENT', ids[0], event])
  socket.message(['EVENT', ids[1], event])
  t.mock.timers.tick(20)
  assert.equal(first, 0)
  assert.equal(second, 1)
  assert.equal(eose, 0)
  assert.equal(socket.sent.filter((line) => JSON.parse(line)[0] === 'CLOSE').length, 1)
})

test('publish requires an actual acknowledgement and redacts relay refusal', async (t) => {
  const { relay, sockets } = await ready()
  t.after(() => relay.close())
  const accepted = relay.publish(event)
  await drain()
  assert.equal(sockets[0]!.sent[0], JSON.stringify(['EVENT', event]))
  sockets[0]!.message(['OK', event.id, true, 'untrusted acknowledgement'])
  await accepted
  const refused = relay.publish(event)
  const rejection = assert.rejects(refused, /^Error: Nostr relay publication failed\.$/)
  await drain()
  sockets[0]!.message(['OK', event.id, false, 'untrusted refusal'])
  await rejection
})

test('terminal close rejects pending publish and bounds inert upstream timer without I/O', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { relay, sockets } = await ready({ publishTimeoutMs: 30 })
  const pending = relay.publish(event)
  const rejection = assert.rejects(pending, /^Error: Nostr relay publication failed\.$/)
  await drain()
  const socket = sockets[0]!
  const lateMessage = socket.onmessage!
  relay.close()
  await rejection
  const sent = socket.sent.length
  lateMessage.call(
    socket as unknown as WebSocket,
    new MessageEvent('message', { data: JSON.stringify(['OK', event.id, true, 'late']) }),
  )
  t.mock.timers.tick(120_000)
  await drain()
  assert.equal(socket.sent.length, sent)
  assert.equal(socket.closeCount, 1)
  assert.equal(sockets.length, 1)
  assert.equal(relay.connected, false)
  await assert.rejects(relay.publish(event), /^Error: Nostr relay is not connected\.$/)
})

test('terminal close fences queued sends; re-add requires a fresh explicit instance', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const transport = fakeTransport()
  const old = new NativeNostrRelay('wss://custom.example', transport)
  const attempt = old.connect()
  transport.sockets[0]!.open()
  await attempt
  old.subscribe([{ kinds: [1] }], { onevent: () => assert.fail('cancelled callback') })
  old.close()
  await drain()
  assert.deepEqual(transport.sockets[0]!.sent, [])
  assert.deepEqual(createNativeNostrRelays([], transport), [])
  const fresh = createNativeNostrRelays(['wss://custom.example'], transport)[0]!
  t.after(() => fresh.close())
  const next = fresh.connect()
  transport.sockets[1]!.open()
  await next
  assert.equal(fresh.connected, true)
  assert.equal(old.connected, false)
  t.mock.timers.tick(120_000)
  assert.equal(transport.sockets.length, 2)
})

test('configured operation deadlines must fit finite native timer bounds', () => {
  const transport = fakeTransport()
  for (const value of [0, -1, NaN, Infinity, 1.5, 2_147_483_648]) {
    assert.throws(
      () => new NativeNostrRelay('wss://custom.example', { ...transport, connectTimeoutMs: value }),
      /timeout is invalid/,
    )
    assert.throws(
      () => new NativeNostrRelay('wss://custom.example', { ...transport, publishTimeoutMs: value }),
      /timeout is invalid/,
    )
  }
  assert.equal(transport.sockets.length, 0)
})

test('receiver raw budget observes duplicate and invalid frames before upstream filtering', async () => {
  const frames: string[] = []
  const current = await ready({
    acceptMessage(message) {
      frames.push(message)
      return frames.length <= 3
    },
  })
  let accepted = 0
  const subscription = current.relay.subscribe([{ kinds: [1] }], {
    onevent() {
      accepted++
    },
  })
  await drain()
  const id = JSON.parse(current.sockets[0]!.sent[0]!)[1]
  assert.equal(subscription.id, id)
  current.sockets[0]!.message(['EVENT', id, event])
  await drain()
  current.sockets[0]!.message(['EVENT', id, event])
  current.sockets[0]!.message(['EVENT', id, { ...event, sig: '00'.repeat(64) }])
  await drain()
  assert.equal(frames.length, 3)
  assert.equal(accepted, 2)
  current.sockets[0]!.message(['NOTICE', 'Untrusted frame'])
  await drain()
  assert.equal(frames.length, 4)
  assert.equal(current.relay.closed, true)
  assert.equal(current.sockets[0]!.closeCount, 1)
})
