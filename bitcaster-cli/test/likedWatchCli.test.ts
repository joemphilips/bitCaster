import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { bootstrapFreshDaemonProfile } from '../../bitcaster-daemon/src/profileBootstrap.ts'
import { createDaemonStateSqliteSession } from '../../bitcaster-daemon/src/stateSqlite.ts'
import { readLocalNativeBookmarks } from '../../bitcaster-daemon/src/nativeBookmarks.ts'

const execute = promisify(execFile)
const CONDITION = 'ab'.repeat(32)

test('actual liked watch help/dry-run explain capture, refusal and restart semantics without network', async () => {
  const f = await fixture([CONDITION])
  try {
    const help = (await f.run(['market', 'watch', '--help'])).stdout
    assert.match(help, /--liked/)
    assert.match(help, /200/)
    assert.match(help, /Restart the watch after bookmark edits/)
    assert.match(help, /never truncated/)
    assert.deepEqual(
      JSON.parse((await f.run(['market', 'watch', '--liked', '--dry-run'])).stdout),
      {
        method: 'market.watch',
        params: { liked: true },
      },
    )
    assert.deepEqual(
      JSON.parse((await f.run(['--dry-run', 'market', 'watch', CONDITION])).stdout),
      {
        method: 'market.watch',
        params: { conditionIds: [CONDITION] },
      },
    )
    assert.deepEqual(await f.log(), [])
    assert.deepEqual(await readLocalNativeBookmarks({ directory: f.directory }), [CONDITION])
  } finally {
    await f.close()
  }
})

test('actual liked watch refuses explicit-ID conflicts and missing selection before authenticated I/O', async () => {
  const f = await fixture([CONDITION])
  try {
    for (const args of [
      ['market', 'watch', CONDITION, '--liked'],
      ['market', 'watch', '--liked', CONDITION],
      ['--dry-run', 'market', 'watch', '--liked', CONDITION],
      ['market', 'watch'],
    ])
      await assert.rejects(f.run(args), (error: unknown) => {
        assert.equal((error as { code: number }).code, 2)
        assert.match((error as { stderr: string }).stderr, /Specify --liked or/)
        return true
      })
    assert.deepEqual(await f.log(), [])
  } finally {
    await f.close()
  }
})

test('actual liked watch emits snapshots and one observed closure through real bearer-authenticated NDJSON', async () => {
  const f = await fixture([CONDITION, CONDITION])
  try {
    const events = lines((await f.run(['market', 'watch', '--liked'], 'frames')).stdout)
    assert.deepEqual(
      events.map((event) => event.event ?? event.type),
      [
        'market.liked.selection',
        'market.connection',
        'market.snapshot',
        'market.snapshot',
        'market.closed',
        'complete',
      ],
    )
    assert.deepEqual(events[0]!.data, {
      conditionIds: [CONDITION],
      state: 'selected',
      selection: 'captured-at-start',
      restartAfterBookmarkEdit: true,
    })
    assert.equal(events[2]!.data!.market!.state, 'open')
    assert.equal(events[3]!.data!.market!.state, 'closed')
    assert.deepEqual(events[4]!.data, {
      conditionId: CONDITION,
      previousState: 'open',
      state: 'closed',
    })
    const log = await f.log()
    assert.equal(log.filter((entry) => entry.action === 'rpc').length, 1)
    assert.equal(log.filter((entry) => entry.action === 'released').length, 1)
    assert.deepEqual(await readLocalNativeBookmarks({ directory: f.directory }), [CONDITION])
  } finally {
    await f.close()
  }
})

test('actual first closed snapshot is silent and an empty liked set completes without hub/engine work', async () => {
  for (const ids of [[CONDITION], []]) {
    const f = await fixture(ids)
    try {
      const events = lines(
        (await f.run(['market', 'watch', '--liked'], ids.length ? 'first-closed' : 'empty')).stdout,
      )
      assert.equal(
        events.some((event) => event.event === 'market.closed'),
        false,
      )
      assert.equal(events.at(-1)!.type, 'complete')
      if (ids.length === 0) {
        assert.equal(events.length, 2)
        assert.equal(events[0]!.data!.state, 'empty')
        assert.equal(
          (await f.log()).filter((entry) => entry.action === 'engine' || entry.action === 'joined')
            .length,
          0,
        )
      }
    } finally {
      await f.close()
    }
  }
})

test('actual excessive or invalid saved likes are explicitly refused; the complete saved set remains unchanged', async () => {
  const many = Array.from({ length: 201 }, (_, index) => index.toString(16).padStart(64, '0'))
  for (const ids of [many, ['invalid']]) {
    const f = await fixture(ids)
    try {
      await assert.rejects(f.run(['market', 'watch', '--liked']), (error: unknown) => {
        assert.equal((error as { code: number }).code, 1)
        assert.match(
          (error as { stderr: string }).stderr,
          ids.length > 200 ? /at most 200.*unchanged/ : /invalid daemon watch command/,
        )
        return true
      })
      assert.deepEqual(await readLocalNativeBookmarks({ directory: f.directory }), ids)
      assert.deepEqual(await f.log(), [])
    } finally {
      await f.close()
    }
  }
})

test('actual liked watch cancellation releases its authenticated stream and only owned hub membership', async () => {
  const f = await fixture([CONDITION])
  try {
    const result = await f.run(['market', 'watch', '--liked'], 'cancel')
    assert.equal(result.stderr, '')
    assert.deepEqual(
      lines(result.stdout).map((event) => event.event),
      ['market.liked.selection', 'market.connection', 'market.snapshot'],
    )
    assert.equal((await f.log()).filter((entry) => entry.action === 'released').length, 1)
  } finally {
    await f.close()
  }
})

test('built actual liked watch retains package wiring and authenticated closure output', async () => {
  const f = await fixture([CONDITION])
  try {
    const events = lines((await f.run(['market', 'watch', '--liked'], 'frames', true)).stdout)
    assert.equal(events.filter((event) => event.event === 'market.closed').length, 1)
    assert.equal(events.at(-1)!.type, 'complete')
    assert.equal((await f.log()).filter((entry) => entry.action === 'released').length, 1)
  } finally {
    await f.close()
  }
})

interface Frame {
  type: string
  event?: string
  data?: { state?: string; market?: { state: string } }
}
function lines(stdout: string): Frame[] {
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

async function fixture(ids: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'bitcaster-liked-watch-cli-'))
  const directory = join(root, 'profile')
  const logPath = join(root, 'calls.jsonl')
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
  return {
    directory,
    run: (args: string[], mode = 'none', built = false) =>
      execute(
        process.execPath,
        [
          '--experimental-strip-types',
          '--import',
          join(import.meta.dirname, 'likedWatchCliPreload.mjs'),
          join(import.meta.dirname, built ? '../dist/main.js' : '../src/main.ts'),
          '--datadir',
          directory,
          ...args,
        ],
        {
          env: {
            ...process.env,
            NODE_NO_WARNINGS: '1',
            BITCASTER_TEST_LIKED_WATCH_MODE: mode,
            BITCASTER_TEST_LIKED_WATCH_LOG: logPath,
          },
          timeout: 10_000,
          maxBuffer: 128 * 1_024,
        },
      ),
    log: async (): Promise<Array<{ action: string }>> => {
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
