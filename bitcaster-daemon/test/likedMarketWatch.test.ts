import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { BitcasterEngineClient } from '@bitcaster-market/client-sdk/engineClient'
import type { ObservedMarketState } from '@bitcaster-market/client-sdk/likedMarketClose'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { createDaemonStateSqliteSession } from '../src/stateSqlite.ts'
import { readLocalNativeBookmarks, setNativeMarketBookmark } from '../src/nativeBookmarks.ts'
import { createMarketWatch } from '../src/marketWatch.ts'
import { createLikedMarketWatch } from '../src/likedMarketWatch.ts'
import { validateDaemonWatchCommand, type DaemonWatchEvent } from '../src/protocol.ts'

const BINARY = 'ab'.repeat(32)
const CATEGORY = 'cd'.repeat(32)

test('liked admission deduplicates the complete local set; unlike applies on watch restart, not during capture', async () => {
  await fixture([BINARY, BINARY, CATEGORY], async (f) => {
    await f.setLiked(CATEGORY, false)
    const reader = f.liked.watch(f.controller.signal)
    const selection = (await reader.next()).value!
    assert.deepEqual(selection.data, {
      conditionIds: [BINARY],
      state: 'selected',
      selection: 'captured-at-start',
      restartAfterBookmarkEdit: true,
    })
    assert.equal(f.calls.length, 0)
    await reader.next()
    await reader.next()
    await f.setLiked(BINARY, false)
    await f.setLiked(CATEGORY, true)
    f.states.set(BINARY, 'closed')
    f.marketWatch.invalidate(CATEGORY)
    f.marketWatch.invalidate(BINARY)
    assert.equal(((await reader.next()).value!.data as { conditionId: string }).conditionId, BINARY)
    assert.equal((await reader.next()).value!.event, 'market.closed')
    assert.deepEqual(await readLocalNativeBookmarks({ directory: f.directory }), [CATEGORY])
    await reader.return()
    const reopened = f.liked.watch(f.controller.signal)
    assert.deepEqual(
      ((await reopened.next()).value!.data as { conditionIds: string[] }).conditionIds,
      [CATEGORY],
    )
    await reopened.next()
    assert.equal(
      ((await reopened.next()).value!.data as { conditionId: string }).conditionId,
      CATEGORY,
    )
    await reopened.return()
    assert.equal(f.owners.size, 0)
    assert.equal(f.released(), 2)
  })
})

test('an empty liked selection completes truthfully without hub work, even when application login is disabled', async () => {
  await fixture([], async (f) => {
    const liked = createLikedMarketWatch({
      marketWatch: f.marketWatch,
      readBookmarks: () => readLocalNativeBookmarks({ directory: f.directory }),
      assertCanWatch: () => {
        throw new Error('disconnected')
      },
    })
    const reader = liked.watch(f.controller.signal)
    const selection = (await reader.next()).value!
    assert.equal(selection.event, 'market.liked.selection')
    assert.deepEqual(selection.data, {
      conditionIds: [],
      state: 'empty',
      selection: 'captured-at-start',
      restartAfterBookmarkEdit: true,
    })
    assert.equal((await reader.next()).done, true)
    assert.equal(f.calls.length, 0)
    assert.equal(f.owners.size, 0)
  })
})

test('watch admission refuses excessive and invalid saved IDs without truncation or subscription', async () => {
  const many = Array.from({ length: 201 }, (_, index) => index.toString(16).padStart(64, '0'))
  for (const ids of [many, ['invalid']]) {
    await fixture(ids, async (f) => {
      await assert.rejects(
        f.liked.watch(f.controller.signal).next(),
        ids.length > 200 ? /at most 200.*unchanged/ : /invalid daemon watch command/,
      )
      assert.deepEqual(await readLocalNativeBookmarks({ directory: f.directory }), ids)
      assert.equal(f.calls.length, 0)
      assert.equal(f.owners.size, 0)
    })
  }
})

test('liked watch refreshes on reconnect, emits one observed closure, and ignores repeated closed snapshots', async () => {
  await fixture([BINARY], async (f) => {
    const reader = f.liked.watch(f.controller.signal)
    await reader.next()
    await reader.next()
    const open = (await reader.next()).value!
    assert.equal((open.data as { market: { state: string } }).market.state, 'open')
    f.marketWatch.disconnected()
    assert.deepEqual((await reader.next()).value!.data, { state: 'reconnecting' })
    const before = f.calls.length
    const connecting = reader.next()
    f.marketWatch.invalidate(BINARY)
    await tick()
    assert.equal(f.calls.length, before)
    f.states.set(BINARY, 'closed')
    f.marketWatch.reconnected()
    assert.deepEqual((await connecting).value!.data, { state: 'connected' })
    const refreshed = (await reader.next()).value!
    assert.equal((refreshed.data as { market: { state: string } }).market.state, 'closed')
    assert.equal(f.calls.length, before + 3)
    const close = (await reader.next()).value!
    assert.equal(close.event, 'market.closed')
    assert.deepEqual(close.data, { conditionId: BINARY, previousState: 'open', state: 'closed' })
    f.marketWatch.invalidate(BINARY)
    assert.equal((await reader.next()).value!.event, 'market.snapshot')
    const repeatedReconnect = reader.next()
    f.marketWatch.reconnected()
    assert.equal((await repeatedReconnect).value!.event, 'market.connection')
    assert.equal((await reader.next()).value!.event, 'market.snapshot')
    const idle = reader.next()
    const cancelled = assert.rejects(idle, /aborted/)
    await tick()
    f.controller.abort()
    await cancelled
    assert.equal(f.owners.size, 0)
    assert.equal(f.released(), 1)
  })
})

test('first already-closed observation is silent; paused output coalesces invalidations without an event buffer', async () => {
  await fixture([BINARY], async (f) => {
    f.states.set(BINARY, 'closed')
    const reader = f.liked.watch(f.controller.signal)
    await reader.next()
    await reader.next()
    assert.equal((await reader.next()).value!.event, 'market.snapshot')
    const before = f.calls.length
    for (let index = 0; index < 1_000; index++) f.marketWatch.invalidate(BINARY)
    assert.equal(f.calls.length, before)
    assert.equal((await reader.next()).value!.event, 'market.snapshot')
    assert.equal(f.calls.length, before + 3)
    const idle = reader.next()
    const cancelled = assert.rejects(idle, /aborted/)
    await tick()
    f.controller.abort()
    await cancelled
    assert.equal(f.released(), 1)
  })
})

test('source revision passes through closure output; missing catalogue rows do not erase an observed open state', async () => {
  let returned = 0
  const snapshots: DaemonWatchEvent[] = [
    {
      type: 'event',
      event: 'market.snapshot',
      data: { conditionId: BINARY, market: { conditionId: BINARY, state: 'open' } },
    },
    { type: 'event', event: 'market.snapshot', data: { conditionId: BINARY, market: null } },
    {
      type: 'event',
      event: 'market.snapshot',
      sourceRevision: 'lifecycle-2',
      data: { conditionId: BINARY, market: { conditionId: BINARY, state: 'closed' } },
    },
  ]
  const liked = createLikedMarketWatch({
    readBookmarks: async () => [BINARY],
    marketWatch: {
      async *watch() {
        try {
          yield* snapshots
        } finally {
          returned++
        }
      },
    },
  })
  const events = []
  for await (const event of liked.watch(new AbortController().signal)) events.push(event)
  const closed = events.filter((event) => event.event === 'market.closed')
  assert.equal(closed.length, 1)
  assert.equal(closed[0]!.sourceRevision, 'lifecycle-2')
  assert.equal(returned, 1)
})

test('malformed catalogue lifecycle or condition binding fails closed and returns the existing stream', async () => {
  for (const market of [
    { conditionId: BINARY, state: 'Closed' },
    { conditionId: CATEGORY, state: 'closed' },
  ]) {
    let returned = 0
    const liked = createLikedMarketWatch({
      readBookmarks: async () => [BINARY],
      marketWatch: {
        async *watch() {
          try {
            yield {
              type: 'event',
              event: 'market.snapshot',
              data: { conditionId: BINARY, market },
            } as const
          } finally {
            returned++
          }
        },
      },
    })
    const reader = liked.watch(new AbortController().signal)
    await reader.next()
    await assert.rejects(reader.next(), /invalid/)
    assert.equal(returned, 1)
  }
})

test('selection-read cancellation and consumer return after selection or snapshot release only owned resources', async () => {
  await fixture([BINARY], async (f) => {
    const blocked = new Promise<string[]>(() => {})
    const selecting = createLikedMarketWatch({
      marketWatch: f.marketWatch,
      readBookmarks: () => blocked,
    }).watch(f.controller.signal)
    const rejected = assert.rejects(selecting.next(), /aborted/)
    f.controller.abort()
    await rejected
    assert.equal(f.owners.size, 0)
    for (const snapshots of [0, 1]) {
      const reader = f.liked.watch(new AbortController().signal)
      await reader.next()
      if (snapshots > 0) {
        await reader.next()
        await reader.next()
      }
      await reader.return()
      assert.equal(f.owners.size, 0)
    }
    assert.equal(f.released(), 1)
  })
})

test('typed watch selector accepts liked only and rejects mixed, false, or unknown selector fields', () => {
  assert.deepEqual(
    validateDaemonWatchCommand({ method: 'market.watch', params: { liked: true } }),
    { method: 'market.watch', params: { liked: true } },
  )
  for (const params of [
    { liked: false },
    { liked: true, conditionIds: [BINARY] },
    { liked: true, extra: 1 },
    {},
    [],
  ])
    assert.throws(
      () => validateDaemonWatchCommand({ method: 'market.watch', params }),
      /invalid daemon watch command/,
    )
})

async function fixture(
  ids: string[],
  run: (f: {
    directory: string
    controller: AbortController
    calls: string[]
    states: Map<string, ObservedMarketState>
    owners: Map<object, readonly string[]>
    released: () => number
    marketWatch: ReturnType<typeof createMarketWatch>
    liked: ReturnType<typeof createLikedMarketWatch>
    setLiked: (id: string, liked: boolean) => Promise<unknown>
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'bitcaster-liked-watch-'))
  const directory = join(root, 'profile')
  const controller = new AbortController()
  try {
    await bootstrapFreshDaemonProfile({
      directory,
      engineBaseUrl: 'https://engine.example',
      mintUrl: 'https://mint.example',
      walletSeedHex: '11'.repeat(64),
      nostrSecretKeyHex: '22'.repeat(32),
    })
    await createDaemonStateSqliteSession(directory).transaction((db) =>
      db
        .prepare(
          `INSERT INTO daemon_bookmark_preferences
      (singleton,markets_json,sync_context,pending_local_edit,revision,last_event_time) VALUES(1,?,NULL,1,1,0)`,
        )
        .run(JSON.stringify(ids)),
    )
    const calls: string[] = []
    const owners = new Map<object, readonly string[]>()
    const states = new Map<string, ObservedMarketState>([
      [BINARY, 'open'],
      [CATEGORY, 'closed'],
    ])
    let released = 0
    const engine = new BitcasterEngineClient({
      baseUrl: 'https://engine.example',
      fetchImpl: async (input) => {
        const url = new URL(String(input))
        calls.push(url.pathname + url.search)
        if (url.pathname.endsWith('/registration'))
          return Response.json({
            conditionId: url.pathname.split('/').at(-2),
            outcomes: ['YES', 'NO'],
            baseAsset: 'sat',
            divisibility: 1000,
          })
        if (url.pathname.endsWith('/query')) {
          const conditionId = url.searchParams.get('ids')!
          return Response.json({
            markets: [{ conditionId, state: states.get(conditionId) }],
            nextCursor: null,
          })
        }
        return Response.json({ marketId: url.pathname.split('/').at(-2), bids: [], asks: [] })
      },
    })
    const marketWatch = createMarketWatch({
      engine,
      hub: {
        start: async () => {},
        isConnected: () => true,
        setMarkets: async (owner, routes) => {
          owners.set(owner, routes)
        },
        releaseMarkets: async (owner) => {
          owners.delete(owner)
          released++
        },
      },
    })
    const liked = createLikedMarketWatch({
      marketWatch,
      readBookmarks: () => readLocalNativeBookmarks({ directory }),
    })
    await run({
      directory,
      controller,
      calls,
      states,
      owners,
      marketWatch,
      liked,
      released: () => released,
      setLiked: (id, value) =>
        setNativeMarketBookmark(id, value, {
          directory,
          readSelection: async () => ({
            publicKeyHex: '00'.repeat(32),
            enabled: false,
            revision: 0,
            relays: [],
          }),
        }),
    })
  } finally {
    controller.abort()
    await rm(root, { recursive: true, force: true })
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
