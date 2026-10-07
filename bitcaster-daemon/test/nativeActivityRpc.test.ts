import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { deriveDurableCustodyWalletId } from '@bitcaster-market/client-sdk/durableCustody'
import type { ActivityItem } from '@bitcaster-market/client-sdk/activityLog'
import { NativeActivitySqlite, type NativeActivityPage } from '../src/nativeActivitySqlite.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { dispatch } from '../src/server.ts'
import { DAEMON_ACTIVITY_PAGE_SIZE_MAX, DAEMON_ACTIVITY_CURSOR_BYTES_MAX } from '../src/protocol.ts'
import { openDaemonStateSqlite } from '../src/stateSqlite.ts'

const WALLET_A = deriveDurableCustodyWalletId(Buffer.from('31'.repeat(64), 'hex'))
const WALLET_B = deriveDurableCustodyWalletId(Buffer.from('32'.repeat(64), 'hex'))

test('wallet Activity rejects malformed requests before profile access', async () => {
  for (const params of [
    null,
    [],
    'all',
    { walletId: 'A'.repeat(64) },
    { walletId: 10 },
    { pageSize: 0 },
    { pageSize: 51 },
    { pageSize: 1.5 },
    { pageSize: '2' },
    { cursor: '' },
    { cursor: 'é'.repeat(257) },
    { cursor: {} },
    { account: 'all-wallets' },
  ]) {
    assert.deepEqual(await dispatch({ method: 'wallet.activity', params } as never), {
      ok: false,
      code: 'invalid-wallet-activity-request',
      error: 'Wallet Activity request is invalid',
    })
  }
})

test('wallet Activity pages retained local rows offline across reopen and excludes a foreign wallet', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'bitcaster-activity-rpc-'))
  const directory = join(root, 'wallet-a')
  const foreignDirectory = join(root, 'wallet-b')
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Activity must remain offline')
  })
  try {
    await bootstrapFreshDaemonProfile({
      directory,
      engineBaseUrl: 'https://engine.example',
      mintUrl: 'https://mint.example',
      walletSeedHex: '31'.repeat(64),
      nostrSecretKeyHex: '33'.repeat(32),
    })
    await bootstrapFreshDaemonProfile({
      directory: foreignDirectory,
      engineBaseUrl: 'https://engine.example',
      mintUrl: 'https://mint.example',
      walletSeedHex: '32'.repeat(64),
      nostrSecretKeyHex: '33'.repeat(32),
    })
    const database = await openDaemonStateSqlite(directory)
    try {
      database.prepare('UPDATE daemon_profile SET signer_enabled = 0 WHERE singleton = 1').run()
      const activity = new NativeActivitySqlite(database)
      for (const [id, status] of [
        ['invoice', 'pending'],
        ['trade', 'completed'],
        ['withdrawal', 'Failed'],
      ] as const) {
        activity.upsert({
          walletId: WALLET_A,
          item: row(WALLET_A, id, status),
          origin: 'native',
          sourceId: id,
        })
      }
    } finally {
      database.close()
    }
    const deps = {
      isCustodyReady: () => false,
      createEngineClient: () => {
        throw new Error('Activity must not use the engine')
      },
    }
    const first = await dispatch(
      { method: 'wallet.activity', params: { pageSize: 2, walletId: WALLET_A } },
      deps,
    )
    assert.equal(first.ok, true)
    const page = first.result as NativeActivityPage
    assert.deepEqual(
      page.items.map(({ id, status, amountSubunits }) => ({ id, status, amountSubunits })),
      [
        { id: 'withdrawal', status: 'Failed', amountSubunits: 1234 },
        { id: 'trade', status: 'completed', amountSubunits: 1234 },
      ],
    )
    assert.ok(page.items.every(({ walletId }) => walletId === WALLET_A))
    assert.equal(page.hasMore, true)
    const next = await dispatch(
      { method: 'wallet.activity', params: { cursor: page.nextCursor, pageSize: 2 } },
      deps,
    )
    assert.deepEqual(next, {
      ok: true,
      result: { items: [row(WALLET_A, 'invoice', 'pending')], nextCursor: null, hasMore: false },
    })
    assert.deepEqual(
      await dispatch({ method: 'wallet.activity', params: { walletId: WALLET_B } }, deps),
      {
        ok: false,
        code: 'wallet-activity-wallet-mismatch',
        error: 'Wallet Activity wallet ID does not match the selected wallet',
      },
    )
    await assert.rejects(
      dispatch({ method: 'wallet.activity', params: { cursor: 'invalid' } }, deps),
      /cursor is invalid/,
    )
    process.env.BITCASTER_DAEMON_HOME = foreignDirectory
    assert.deepEqual(await dispatch({ method: 'wallet.activity' }, deps), {
      ok: true,
      result: { items: [], nextCursor: null, hasMore: false },
    })
    await assert.rejects(
      dispatch({ method: 'wallet.activity', params: { cursor: page.nextCursor } }, deps),
      /foreign or stale/,
    )
    process.env.BITCASTER_DAEMON_HOME = directory
    assert.deepEqual((await dispatch({ method: 'wallet.activity' }, deps)).result, {
      items: [
        row(WALLET_A, 'withdrawal', 'Failed'),
        row(WALLET_A, 'trade', 'completed'),
        row(WALLET_A, 'invoice', 'pending'),
      ],
      nextCursor: null,
      hasMore: false,
    })
    const damaged = await openDaemonStateSqlite(directory)
    try {
      damaged.exec('DROP INDEX daemon_activity_feed_page_idx')
    } finally {
      damaged.close()
    }
    await assert.rejects(dispatch({ method: 'wallet.activity' }, deps), {
      reason: 'sqlite-schema-mismatch',
    })
    await assert.rejects(openDaemonStateSqlite(directory), {
      reason: 'sqlite-schema-mismatch',
    })
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})

function row(walletId: string, id: string, status: ActivityItem['status']): ActivityItem {
  return {
    id,
    walletId,
    type: 'deposit',
    amountSubunits: 1234,
    baseAsset: 'sat',
    date: '2026-10-04T00:00:00.000Z',
    status,
    txId: null,
    lightningInvoice: null,
  }
}

test('actual Activity RPC bounds serialized pages with near-limit UTF-8 and escaped rows', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-activity-rpc-bytes-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Activity must remain offline')
  })
  // Fifty 16 KiB persisted rows plus the bounded cursor and fixed RPC framing fit below 1 MiB.
  const rowBytesMax = 16 * 1024
  const responseBytesMax =
    DAEMON_ACTIVITY_PAGE_SIZE_MAX * rowBytesMax + DAEMON_ACTIVITY_CURSOR_BYTES_MAX + 1024
  assert.ok(responseBytesMax < 1024 * 1024)
  try {
    await bootstrapFreshDaemonProfile({
      directory,
      engineBaseUrl: 'https://engine.example',
      mintUrl: 'https://mint.example',
      walletSeedHex: '31'.repeat(64),
      nostrSecretKeyHex: '33'.repeat(32),
    })
    const database = await openDaemonStateSqlite(directory)
    try {
      const activity = new NativeActivitySqlite(database)
      for (let index = 0; index < DAEMON_ACTIVITY_PAGE_SIZE_MAX + 1; index++) {
        const id = `large-${index}`
        const large: ActivityItem = {
          ...row(WALLET_A, id, 'completed'),
          marketTitle: '\u0001'.repeat(1200) + '雪'.repeat(2000),
        }
        large.marketTitle += 'x'.repeat(rowBytesMax - Buffer.byteLength(JSON.stringify(large)))
        assert.equal(Buffer.byteLength(JSON.stringify(large)), rowBytesMax)
        activity.upsert({ walletId: WALLET_A, item: large, origin: 'native', sourceId: id })
      }
    } finally {
      database.close()
    }
    const response = await dispatch({
      method: 'wallet.activity',
      params: { pageSize: DAEMON_ACTIVITY_PAGE_SIZE_MAX },
    })
    assert.equal(response.ok, true)
    const page = response.result as NativeActivityPage
    assert.equal(page.items.length, DAEMON_ACTIVITY_PAGE_SIZE_MAX)
    assert.equal(page.hasMore, true)
    assert.ok(page.nextCursor !== null)
    assert.ok(Buffer.byteLength(page.nextCursor) <= DAEMON_ACTIVITY_CURSOR_BYTES_MAX)
    const bytes = Buffer.byteLength(JSON.stringify(response))
    assert.ok(bytes > 800 * 1024, 'fixture must exercise the full-size page')
    assert.ok(
      bytes <= responseBytesMax,
      `serialized RPC response exceeded its derived bound: ${bytes}`,
    )
    t.diagnostic(`Maximum-size RPC page: ${bytes} bytes; derived bound: ${responseBytesMax} bytes`)
    const next = await dispatch({
      method: 'wallet.activity',
      params: { pageSize: DAEMON_ACTIVITY_PAGE_SIZE_MAX, cursor: page.nextCursor },
    })
    assert.equal((next.result as NativeActivityPage).items.length, 1)
    assert.ok(Buffer.byteLength(JSON.stringify(next)) <= responseBytesMax)
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
})
