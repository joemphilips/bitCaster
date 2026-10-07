import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { finalizeEvent, getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure'
import { bookmarkEventTemplate, parseBookmarkPayload } from '@bitcaster-market/client-sdk/bookmarks'
import {
  bootstrapFreshDaemonProfile,
  readBootstrappedProfileSecrets,
} from '../../bitcaster-daemon/src/profileBootstrap.ts'
import { readNativeConfig, updateNativeConfig } from '../../bitcaster-daemon/src/nativeConfig.ts'
import { createDaemonStateSqliteSession } from '../../bitcaster-daemon/src/stateSqlite.ts'

const execute = promisify(execFile)
const KEY = Uint8Array.from(Buffer.from('22'.repeat(32), 'hex'))
const RELAY = 'wss://relay.example/Case?Key=Value'
const signed = (ids: string[]) => finalizeEvent(bookmarkEventTemplate(ids, 100), KEY)

test('actual liked commands are registered under the existing market parent; empty relays stay local', async () => {
  const f = await fixture([])
  try {
    assert.equal(((await f.run(['--help'])).stdout.match(/^\s+market\s/gm) ?? []).length, 1)
    const help = (await f.run(['market', '--help'])).stdout
    for (const name of ['liked', 'like', 'unlike', 'show', 'list', 'watch'])
      assert.match(help, new RegExp(`\\b${name}\\b`))
    const before = await readBootstrappedProfileSecrets(f.directory)
    const added = JSON.parse((await f.run(['market', 'like', 'first'])).stdout).result
    assert.deepEqual(added.conditionIds, ['first'])
    assert.equal(added.sync.status, 'no-relays')
    await f.run(['market', 'like', 'first'])
    await f.run(['market', 'like', 'second'])
    await f.run(['market', 'unlike', 'first'])
    assert.deepEqual(
      JSON.parse((await f.run(['market', 'liked', '--local'])).stdout).conditionIds,
      ['second'],
    )
    assert.deepEqual(await f.log(), [])
    assert.deepEqual(readNativeConfig(false, f.directory).config.daemon.nostrRelays, [])
    assert.deepEqual(await readBootstrappedProfileSecrets(f.directory), before)
  } finally {
    await f.close()
  }
})

test('actual selected application signer merges valid remote state and publishes a real public event', async () => {
  const f = await fixture([RELAY])
  try {
    const remote = signed(['remote', 'remote'])
    const wrong = finalizeEvent(
      bookmarkEventTemplate(['wrong-author'], 999),
      new Uint8Array(32).fill(8),
    )
    const result = JSON.parse(
      (
        await f.run(['market', 'like', 'local'], {
          BITCASTER_TEST_BOOKMARK_EVENTS: JSON.stringify([wrong, remote]),
        })
      ).stdout,
    ).result
    assert.deepEqual(result.conditionIds, ['remote', 'local'])
    assert.equal(result.sync.status, 'synced')
    const frames = (await f.log()).filter((entry) => entry.action === 'relay')
    const request = frames.find((entry) => entry.frame?.[0] === 'REQ')!.frame!
    assert.deepEqual(request[2], {
      kinds: [30078],
      authors: [getPublicKey(KEY)],
      '#d': ['bitcaster:bookmarks'],
    })
    const event = frames.find((entry) => entry.frame?.[0] === 'EVENT')!.frame![1] as Event
    assert.equal(verifyEvent(event), true)
    assert.equal(event.pubkey, getPublicKey(KEY))
    assert.deepEqual(parseBookmarkPayload(event.content), ['remote', 'local'])
    const list = JSON.parse((await f.run(['market', 'liked'])).stdout)
    assert.deepEqual(list.conditionIds, ['remote', 'local'])
    assert.deepEqual(
      list.markets.map((market: { id: string }) => market.id),
      ['remote', 'local'],
    )
    assert.equal(list.metadataStatus, 'available')
    assert.ok(frames.every((entry) => entry.url === RELAY))
  } finally {
    await f.close()
  }
})

test('actual failed unlike persists empty across child-process reopen and retries without stale re-add', async () => {
  const f = await fixture([RELAY])
  const remote = signed(['only'])
  try {
    await f.run(['market', 'liked'], { BITCASTER_TEST_BOOKMARK_EVENTS: JSON.stringify([remote]) })
    const unlike = JSON.parse(
      (
        await f.run(['market', 'unlike', 'only'], {
          BITCASTER_TEST_BOOKMARK_FAIL_PUBLISH: '1',
          BITCASTER_TEST_BOOKMARK_EVENTS: JSON.stringify([remote]),
        })
      ).stdout,
    ).result
    assert.deepEqual(unlike.conditionIds, [])
    assert.equal(unlike.sync.status, 'pending')
    assert.deepEqual(
      JSON.parse((await f.run(['market', 'liked', '--local'])).stdout).conditionIds,
      [],
    )
    const retry = JSON.parse(
      (
        await f.run(['market', 'liked'], {
          BITCASTER_TEST_BOOKMARK_EVENTS: JSON.stringify([remote]),
        })
      ).stdout,
    )
    assert.deepEqual(retry.conditionIds, [])
    assert.equal(retry.sync.status, 'synced')
    assert.equal(retry.sync.remote, 'not-read')
    const log = await f.log()
    assert.equal(log.filter((entry) => entry.frame?.[0] === 'REQ').length, 1)
    const events = log
      .filter((entry) => entry.frame?.[0] === 'EVENT')
      .map((entry) => entry.frame![1] as Event)
    assert.equal(events.length, 2)
    assert.ok(events.every((event) => parseBookmarkPayload(event.content)!.length === 0))
    assert.ok(events[1]!.created_at > events[0]!.created_at)
  } finally {
    await f.close()
  }
})

test('actual liked metadata retains 205 IDs with <=100-ID batches and reports unresolved/failure honestly', async () => {
  const f = await fixture([])
  try {
    const ids = [...Array.from({ length: 204 }, (_, index) => `condition-${index}`), 'unresolved']
    await createDaemonStateSqliteSession(f.directory).transaction((db) =>
      db
        .prepare(
          `INSERT INTO daemon_bookmark_preferences
      (singleton,markets_json,sync_context,pending_local_edit,revision,last_event_time) VALUES(1,?,NULL,1,1,0)`,
        )
        .run(JSON.stringify(ids)),
    )
    const list = JSON.parse((await f.run(['market', 'liked'])).stdout)
    assert.deepEqual(list.conditionIds, ids)
    assert.deepEqual(
      list.markets.map((market: { id: string }) => market.id),
      ids.slice(0, 204),
    )
    const queries = (await f.log()).filter((entry) => entry.action === 'engine')
    assert.deepEqual(
      queries.map((entry) => entry.ids!.length),
      [100, 100, 5],
    )
    assert.ok(queries.every((entry) => entry.state === 'All' && entry.pageSize === '100'))
    const failed = JSON.parse(
      (await f.run(['market', 'liked'], { BITCASTER_TEST_BOOKMARK_FAIL_ENGINE: '1' })).stdout,
    )
    assert.deepEqual(failed.conditionIds, ids)
    assert.equal(failed.metadataStatus, 'unavailable')
    assert.deepEqual(failed.markets, [])
  } finally {
    await f.close()
  }
})

test('actual dry-run and local list make no network requests or preference changes', async () => {
  const f = await fixture([RELAY])
  try {
    for (const command of [['like', 'first'], ['unlike', 'first'], ['liked']]) {
      const result = JSON.parse((await f.run(['--dry-run', 'market', ...command])).stdout)
      assert.equal(result.dryRun, true)
    }
    assert.deepEqual(
      JSON.parse((await f.run(['market', 'liked', '--local'])).stdout).conditionIds,
      [],
    )
    assert.deepEqual(await f.log(), [])
    await createDaemonStateSqliteSession(f.directory).read((db) => {
      assert.equal(
        (
          db.prepare('SELECT COUNT(*) AS count FROM daemon_bookmark_preferences').get() as {
            count: number
          }
        ).count,
        0,
      )
    })
  } finally {
    await f.close()
  }
})

test('built actual CLI uses bookmark package export and local success despite relay/engine failure', async () => {
  const f = await fixture([RELAY])
  try {
    const result = JSON.parse(
      (
        await f.run(
          ['market', 'like', 'offline'],
          { BITCASTER_TEST_BOOKMARK_FAIL_CONNECT: '1' },
          true,
        )
      ).stdout,
    ).result
    assert.deepEqual(result.conditionIds, ['offline'])
    assert.equal(result.sync.status, 'pending')
    const listed = JSON.parse(
      (
        await f.run(
          ['market', 'liked'],
          {
            BITCASTER_TEST_BOOKMARK_FAIL_CONNECT: '1',
            BITCASTER_TEST_BOOKMARK_FAIL_ENGINE: '1',
          },
          true,
        )
      ).stdout,
    )
    assert.deepEqual(listed.conditionIds, ['offline'])
    assert.equal(listed.sync.status, 'pending')
    assert.equal(listed.metadataStatus, 'unavailable')
  } finally {
    await f.close()
  }
})

interface LogEntry {
  action: string
  url?: string
  frame?: unknown[]
  ids?: string[]
  state?: string
  pageSize?: string
}

async function fixture(relays: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'bitcaster-liked-cli-'))
  const directory = join(root, 'profile')
  const logPath = join(root, 'calls.jsonl')
  await bootstrapFreshDaemonProfile({
    directory,
    engineBaseUrl: 'https://engine.example',
    mintUrl: 'https://mint.example',
    walletSeedHex: '11'.repeat(64),
    nostrSecretKeyHex: '22'.repeat(32),
    nativeOracleNonceSeedHex: '33'.repeat(32),
  })
  updateNativeConfig(
    (current) => ({ ...current, daemon: { ...current.daemon, nostrRelays: relays } }),
    { directory },
  )
  return {
    directory,
    run: (args: string[], env: NodeJS.ProcessEnv = {}, built = false) =>
      execute(
        process.execPath,
        [
          '--experimental-strip-types',
          '--import',
          join(import.meta.dirname, 'likedMarketCliPreload.mjs'),
          join(import.meta.dirname, built ? '../dist/main.js' : '../src/main.ts'),
          '--datadir',
          directory,
          ...args,
        ],
        {
          env: { ...process.env, BITCASTER_TEST_BOOKMARK_LOG: logPath, ...env },
          timeout: 10_000,
          maxBuffer: 128 * 1_024,
        },
      ),
    log: async (): Promise<LogEntry[]> => {
      try {
        return (await readFile(logPath, 'utf8'))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
    },
    close: () => rm(root, { recursive: true, force: true }),
  }
}
