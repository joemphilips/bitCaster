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
