import assert from 'node:assert/strict'
import { test } from 'node:test'
import { finalizeEvent } from 'nostr-tools/pure'
import { createPublicNostrProfileCache } from '../src/publicNostrProfileCache.ts'

const event = finalizeEvent(
  {
    kind: 0,
    created_at: 1,
    tags: [],
    content: JSON.stringify({ name: 'Alice', picture: 'https://example.com/avatar.png' }),
  },
  new Uint8Array(32).fill(1),
)
test('deduplicates readers and returns verified shared names with bounded expiry', async () => {
  let reads = 0,
    now = 0
  const cache = createPublicNostrProfileCache(
    async (_url, _filter, receive) => {
      reads++
      receive(event)
    },
    () => now,
  )
  const first = cache.read(event.pubkey, ['wss://example.com'])
  const second = cache.read(event.pubkey, ['wss://example.com'])
  assert.equal((await first)?.displayName, 'Alice')
  assert.equal((await second)?.displayName, 'Alice')
  await cache.read(event.pubkey, ['wss://example.com'])
  assert.equal(reads, 1)
  now = 60_001
  await cache.read(event.pubkey, ['wss://example.com'])
  assert.equal(reads, 2)
  await cache.read(event.pubkey, ['wss://other.example'])
  assert.equal(reads, 3)
})
test('bounds active authors and queued memory while keeping fallback available', async () => {
  const releases: Array<() => void> = []
  let active = 0,
    maxActive = 0
  const cache = createPublicNostrProfileCache(async () => {
    active++
    maxActive = Math.max(maxActive, active)
    await new Promise<void>((resolve) => releases.push(resolve))
    active--
  })
  const requests = Array.from({ length: 128 }, (_, i) =>
    cache.read(i.toString(16).padStart(64, '0'), ['wss://example.com']),
  )
  assert.equal(active, 4)
  assert.equal(await cache.read('f'.repeat(64), ['wss://example.com']), null)
  // Drain each owned batch through its completion signal, not elapsed time.
  for (let i = 0; i < requests.length; i += 4) {
    const batch = releases.splice(0)
    batch.forEach((release) => release())
    await Promise.all(requests.slice(i, i + 4))
    // The queue advances in the finalizer after the result promises resolve.
    await Promise.resolve()
  }
  await Promise.all(requests)
  assert.equal(maxActive, 4)
})
test('limits relays and ignores forged profiles and invalid public keys', async () => {
  let reads = 0
  const cache = createPublicNostrProfileCache(async (_url, _filter, receive) => {
    reads++
    receive({ ...event, content: '{"name":"Forged"}' })
  })
  assert.equal(await cache.read('invalid', ['wss://example.com']), null)
  assert.equal(reads, 0)
  assert.equal(
    await cache.read(
      event.pubkey,
      Array.from({ length: 9 }, (_, i) => `wss://r${i}.example`),
    ),
    null,
  )
  assert.equal(reads, 3)
})

test('cancelling one consumer preserves the other shared request', async () => {
  let release!: () => void
  let transportSignal!: AbortSignal
  let calls = 0
  const cache = createPublicNostrProfileCache(async (_url, _filter, receive, signal) => {
    calls++
    transportSignal = signal
    await new Promise<void>((done) => {
      release = done
    })
    receive(event)
  })
  const left = new AbortController(),
    right = new AbortController()
  const a = cache.read(event.pubkey, ['wss://example.com'], left.signal)
  const b = cache.read(event.pubkey, ['wss://example.com'], right.signal)
  left.abort()
  assert.equal(await a, null)
  assert.equal(transportSignal.aborted, false)
  release()
  assert.equal((await b)?.displayName, 'Alice')
  assert.equal(calls, 1)
})

test('route cancellation discards queued authors and releases active slots for a new route', async () => {
  const oldRoute = new AbortController()
  const started: string[] = []
  const stopped: string[] = []
  let newStarted!: () => void
  const startedNew = new Promise<void>((resolve) => {
    newStarted = resolve
  })
  const cache = createPublicNostrProfileCache(async (_url, filter, receive, signal) => {
    const author = filter.authors![0]!
    started.push(author)
    if (author === event.pubkey) {
      receive(event)
      newStarted()
      return
    }
    await new Promise<void>((resolve) => {
      signal.addEventListener(
        'abort',
        () => {
          stopped.push(author)
          resolve()
        },
        { once: true },
      )
    })
  })
  const old = Array.from({ length: 128 }, (_, i) =>
    cache.read(i.toString(16).padStart(64, '0'), ['wss://example.com'], oldRoute.signal),
  )
  assert.equal(started.length, 4)
  oldRoute.abort()
  await Promise.all(old)
  const next = cache.read(event.pubkey, ['wss://example.com'])
  await startedNew
  assert.equal((await next)?.displayName, 'Alice')
  assert.equal(stopped.length, 4)
  assert.equal(started.length, 5)
})

test('already cancelled consumers never enqueue or start a query', async () => {
  let calls = 0
  const cache = createPublicNostrProfileCache(async () => {
    calls++
  })
  const controller = new AbortController()
  controller.abort()
  assert.equal(await cache.read(event.pubkey, ['wss://example.com'], controller.signal), null)
  assert.equal(calls, 0)
})
