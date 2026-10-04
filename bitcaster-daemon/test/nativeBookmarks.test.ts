import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { finalizeEvent, getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure'
import { bookmarkEventTemplate, parseBookmarkPayload } from '@bitcaster-market/client-sdk/bookmarks'
import {
  bootstrapFreshDaemonProfile,
  readBootstrappedProfileSecrets,
} from '../src/profileBootstrap.ts'
import {
  listNativeBookmarks,
  readLocalNativeBookmarks,
  setNativeMarketBookmark,
} from '../src/nativeBookmarks.ts'
import { createDaemonStateSqliteSession } from '../src/stateSqlite.ts'
import { bookmarkRelayFixture } from './bookmarkRelayFixture.ts'

const SECRET = '22'.repeat(32)
const KEY = Uint8Array.from(Buffer.from(SECRET, 'hex'))
const AUTHOR = getPublicKey(KEY)
const RELAYS = ['wss://first.example/Case?Key=Value', 'wss://second.example']
const signed = (markets: string[], time = 100): Event =>
  finalizeEvent(bookmarkEventTemplate(markets, time), KEY)

test('native preferences work with no relays and preserve unrelated profile authorities', async () => {
  await fixture(async (directory) => {
    const before = await readBootstrappedProfileSecrets(directory)
    const transport = bookmarkRelayFixture()
    const options = optionsFor(directory, transport, [])
    assert.equal((await setNativeMarketBookmark('first', true, options)).sync.status, 'no-relays')
    await setNativeMarketBookmark('first', true, options)
    await setNativeMarketBookmark('second', true, options)
    await setNativeMarketBookmark('missing', false, options)
    assert.deepEqual(await readLocalNativeBookmarks({ directory }), ['first', 'second'])
    await setNativeMarketBookmark('first', false, options)
    assert.deepEqual((await listNativeBookmarks(options)).markets, ['second'])
    assert.equal(transport.sockets.length, 0)
    assert.deepEqual(await readBootstrappedProfileSecrets(directory), before)
    await createDaemonStateSqliteSession(directory).read((db) => {
      assert.throws(() =>
        db.prepare('UPDATE daemon_bookmark_preferences SET markets_json=?').run('{}'),
      )
      assert.throws(() =>
        db.prepare('UPDATE daemon_bookmark_preferences SET pending_local_edit=2').run(),
      )
      assert.throws(() => db.prepare('UPDATE daemon_bookmark_preferences SET singleton=2').run())
    })
  })
})

test('initial selected-author union rejects invalid/filter-mismatched events and publishes exact signed set', async () => {
  await fixture(async (directory) => {
    await setNativeMarketBookmark('local', true, optionsFor(directory, bookmarkRelayFixture(), []))
    const wrongAuthor = finalizeEvent(
      bookmarkEventTemplate(['wrong-author'], 900),
      new Uint8Array(32).fill(8),
    )
    const wrongTag = finalizeEvent(
      { ...bookmarkEventTemplate(['wrong-tag'], 900), tags: [['d', 'other']] },
      KEY,
    )
    const wrongKind = finalizeEvent({ ...bookmarkEventTemplate(['wrong-kind'], 900), kind: 1 }, KEY)
    const malformed = finalizeEvent(
      { ...bookmarkEventTemplate([], 900), content: '{"markets":[3]}' },
      KEY,
    )
    const wrongFirstTag = finalizeEvent(
      {
        ...bookmarkEventTemplate(['wrong-first-tag'], 900),
        tags: [
          ['d', 'other'],
          ['d', 'bitcaster:bookmarks'],
        ],
      },
      KEY,
    )
    const unsafeTime = finalizeEvent(
      { ...bookmarkEventTemplate(['unsafe-time'], 1), created_at: Number.MAX_SAFE_INTEGER + 1 },
      KEY,
    )
    const tampered = { ...signed(['tampered'], 900), content: '{"markets":["changed"]}' }
    const transport = bookmarkRelayFixture({
      events: [
        wrongAuthor,
        wrongTag,
        wrongKind,
        malformed,
        wrongFirstTag,
        unsafeTime,
        tampered,
        signed(['old'], 99),
        signed(['remote', 'remote'], 100),
      ],
    })
    const result = await listNativeBookmarks(optionsFor(directory, transport))
    assert.deepEqual(result.markets, ['local', 'remote'])
    assert.equal(result.sync.remote, 'merged')
    assert.equal(result.sync.status, 'synced')
    assert.deepEqual(result.sync.publishedRelays, RELAYS)
    const events = transport.sockets.flatMap((socket) =>
      socket.frames.filter((frame) => frame[0] === 'EVENT').map((frame) => frame[1] as Event),
    )
    assert.equal(events.length, 2)
    for (const event of events) {
      assert.equal(event.pubkey, AUTHOR)
      assert.equal(verifyEvent(event), true)
      assert.deepEqual(parseBookmarkPayload(event.content), ['local', 'remote'])
      assert.equal(event.created_at, 101)
    }
    assert.ok(transport.sockets.every((socket) => socket.closeCount === 1))
  })
})

test('failed unlike stays empty across reopen and stale remote retry; no initial re-union', async () => {
  await fixture(async (directory) => {
    const remote = signed(['only'])
    await listNativeBookmarks(optionsFor(directory, bookmarkRelayFixture({ events: [remote] })))
    const failed = bookmarkRelayFixture({ events: [remote], failPublish: true })
    const removed = await setNativeMarketBookmark('only', false, optionsFor(directory, failed))
    assert.deepEqual(removed.markets, [])
    assert.equal(removed.sync.status, 'pending')
    assert.deepEqual(removed.sync.failedRelays, RELAYS)
    assert.deepEqual(await readLocalNativeBookmarks({ directory }), [])
    const retry = bookmarkRelayFixture({ events: [remote] })
    const reopened = await listNativeBookmarks(optionsFor(directory, retry))
    assert.deepEqual(reopened.markets, [])
    assert.equal(reopened.sync.status, 'synced')
    assert.equal(reopened.sync.remote, 'not-read')
    assert.ok(retry.sockets.every((socket) => !socket.frames.some((frame) => frame[0] === 'REQ')))
    const publications = retry.sockets.flatMap((socket) =>
      socket.frames.filter((frame) => frame[0] === 'EVENT').map((frame) => frame[1] as Event),
    )
    assert.ok(
      publications.every(
        (event) => parseBookmarkPayload(event.content)!.length === 0 && event.created_at === 102,
      ),
    )
    const settled = bookmarkRelayFixture({ events: [remote] })
    assert.deepEqual((await listNativeBookmarks(optionsFor(directory, settled))).markets, [])
    assert.equal(settled.sockets.length, 0)
  })
})

test('connection failures retain local success, and disconnected signer never reads its private key', async () => {
  await fixture(async (directory) => {
    const failed = bookmarkRelayFixture({ failConnect: true })
    const added = await setNativeMarketBookmark('offline', true, optionsFor(directory, failed))
    assert.deepEqual(added.markets, ['offline'])
    assert.equal(added.sync.status, 'pending')
    assert.equal(added.sync.remote, 'unavailable')
    const transport = bookmarkRelayFixture()
    const disabled = {
      ...optionsFor(directory, transport),
      readSelection: async () => ({
        publicKeyHex: AUTHOR,
        enabled: false,
        revision: 1,
        relays: RELAYS,
      }),
      readSecretKey: async () => {
        throw new Error('must not read key')
      },
    }
    assert.equal(
      (await setNativeMarketBookmark('disabled', true, disabled)).sync.status,
      'disabled',
    )
    assert.deepEqual(await readLocalNativeBookmarks({ directory }), ['offline', 'disabled'])
    assert.equal(transport.sockets.length, 0)
  })
})

test('signer revision and exact relay-selection changes fence publication without losing local edits', async () => {
  await fixture(async (directory) => {
    let reads = 0
    const transport = bookmarkRelayFixture()
    const options = {
      ...optionsFor(directory, transport),
      readSelection: async () => ({
        publicKeyHex: AUTHOR,
        enabled: true,
        revision: reads++ === 0 ? 0 : 1,
        relays: RELAYS,
      }),
    }
    const result = await setNativeMarketBookmark('saved', true, options)
    assert.equal(result.sync.status, 'selection-changed')
    assert.deepEqual(await readLocalNativeBookmarks({ directory }), ['saved'])
    assert.ok(
      transport.sockets.every((socket) => !socket.frames.some((frame) => frame[0] === 'EVENT')),
    )
    const next = bookmarkRelayFixture({ events: [signed(['new-context'])] })
    const newContext = await listNativeBookmarks(
      optionsFor(directory, next, [RELAYS[1]!, RELAYS[0]!]),
    )
    assert.deepEqual(newContext.markets, ['saved', 'new-context'])
    assert.equal(newContext.sync.remote, 'merged')
  })
})

test('exact relay changes and different application keys fence stale publication; concurrent local edits remain pending', async () => {
  for (const change of ['relays', 'private-key', 'local-edit'] as const) {
    await fixture(async (directory) => {
      const transport = bookmarkRelayFixture()
      let reads = 0
      const options = {
        ...optionsFor(directory, transport),
        readSelection: async () => ({
          publicKeyHex: AUTHOR,
          enabled: true,
          revision: 0,
          relays: change === 'relays' && reads++ > 0 ? [...RELAYS].reverse() : RELAYS,
        }),
        readSecretKey: async () => {
          if (change === 'local-edit')
            await setNativeMarketBookmark(
              'concurrent',
              true,
              optionsFor(directory, bookmarkRelayFixture(), []),
            )
          return change === 'private-key' ? '44'.repeat(32) : SECRET
        },
      }
      const result = await setNativeMarketBookmark('saved', true, options)
      assert.equal(
        result.sync.status,
        change === 'local-edit' ? 'local-changed' : 'selection-changed',
      )
      assert.deepEqual(
        await readLocalNativeBookmarks({ directory }),
        change === 'local-edit' ? ['saved', 'concurrent'] : ['saved'],
      )
      assert.ok(
        transport.sockets.every((socket) => !socket.frames.some((frame) => frame[0] === 'EVENT')),
      )
    })
  }
})

function optionsFor(
  directory: string,
  transport: ReturnType<typeof bookmarkRelayFixture>,
  relays: string[] = RELAYS,
) {
  return {
    directory,
    relayOptions: { websocketImplementation: transport.websocketImplementation },
    readSelection: async () => ({ publicKeyHex: AUTHOR, enabled: true, revision: 0, relays }),
    readSecretKey: async () => SECRET,
    now: () => 100_000,
  }
}

async function fixture(run: (directory: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'bitcaster-native-bookmarks-'))
  const directory = join(root, 'profile')
  try {
    await bootstrapFreshDaemonProfile({
      directory,
      engineBaseUrl: 'https://engine.example',
      mintUrl: 'https://mint.example',
      walletSeedHex: '11'.repeat(64),
      nostrSecretKeyHex: SECRET,
      nativeOracleNonceSeedHex: '33'.repeat(32),
    })
    await run(directory)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
