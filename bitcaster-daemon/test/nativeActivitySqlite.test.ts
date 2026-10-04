import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import type { ActivityItem } from '@bitcaster-market/client-sdk/activityLog'
import { NATIVE_ACTIVITY_SCHEMA_SQL, NativeActivitySqlite } from '../src/nativeActivitySqlite.ts'

const WALLET_A = 'a'.repeat(64)
const WALLET_B = 'b'.repeat(64)
const INSTANCE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const INSTANCE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function createStore(instanceId = INSTANCE_A) {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  database.exec('CREATE TABLE custody_scopes (scope_id TEXT PRIMARY KEY NOT NULL) STRICT')
  database
    .prepare('INSERT INTO custody_scopes (scope_id) VALUES (?)')
    .run(`custody:wallet:${WALLET_A}`)
  database
    .prepare('INSERT INTO custody_scopes (scope_id) VALUES (?)')
    .run(`custody:wallet:${WALLET_B}`)
  for (const statement of NATIVE_ACTIVITY_SCHEMA_SQL) database.exec(statement)
  const activity = new NativeActivitySqlite(database)
  activity.initialize(instanceId)
  return { database, activity }
}

function item(walletId: string, id: string, amountSubunits = 100): ActivityItem {
  return {
    id,
    walletId,
    type: 'Buy',
    amountSubunits,
    baseAsset: 'sat',
    date: '2026-10-04T00:00:00.000Z',
    status: 'completed',
    txId: null,
    lightningInvoice: null,
  }
}

test('pages exact rows by sequence while an old source gains a fill', () => {
  const { activity, database } = createStore()
  try {
    for (const id of ['trade-1', 'trade-2', 'trade-3'])
      activity.upsert({
        walletId: WALLET_A,
        item: item(WALLET_A, id),
        origin: 'native',
        sourceId: 'order-1',
      })
    const first = activity.page({ walletId: WALLET_A, pageSize: 2 })
    assert.deepEqual(
      first.items.map((row) => row.id),
      ['trade-3', 'trade-2'],
    )
    assert.equal(first.hasMore, true)
    assert.notEqual(first.nextCursor, null)
    activity.upsert({
      walletId: WALLET_A,
      item: item(WALLET_A, 'trade-4'),
      origin: 'native',
      sourceId: 'order-1',
    })
    const second = activity.page({ walletId: WALLET_A, pageSize: 2, cursor: first.nextCursor })
    assert.deepEqual(
      second.items.map((row) => row.id),
      ['trade-1'],
    )
    assert.equal(second.nextCursor, null)
    assert.deepEqual(
      activity.page({ walletId: WALLET_A, pageSize: 2 }).items.map((row) => row.id),
      ['trade-4', 'trade-3'],
    )
  } finally {
    database.close()
  }
})

test('local exact-ID rows take precedence over relay rows', () => {
  const { activity, database } = createStore()
  try {
    const relay = item(WALLET_A, 'deposit-1', 100)
    activity.upsert({ walletId: WALLET_A, item: relay, origin: 'relay', sourceId: 'event-1' })
    activity.upsert({
      walletId: WALLET_A,
      item: item(WALLET_A, 'deposit-1', 90),
      origin: 'native',
      sourceId: 'receive-1',
    })
    activity.upsert({ walletId: WALLET_A, item: relay, origin: 'relay', sourceId: 'event-2' })
    assert.equal(activity.page({ walletId: WALLET_A, pageSize: 1 }).items[0]?.amountSubunits, 90)
    assert.throws(
      () =>
        activity.upsert({
          walletId: WALLET_A,
          item: relay,
          origin: 'native',
          sourceId: 'receive-2',
        }),
      /source identity conflicts/,
    )
    assert.throws(
      () =>
        activity.upsert({
          walletId: WALLET_A,
          item: item(WALLET_B, 'foreign'),
          origin: 'relay',
          sourceId: 'event-3',
        }),
      /item is invalid/,
    )
  } finally {
    database.close()
  }
})

test('rejects a cursor from another wallet or profile instance', () => {
  const a = createStore()
  const b = createStore(INSTANCE_B)
  try {
    for (const id of ['one', 'two'])
      a.activity.upsert({
        walletId: WALLET_A,
        item: item(WALLET_A, id),
        origin: 'native',
        sourceId: id,
      })
    const cursor = a.activity.page({ walletId: WALLET_A, pageSize: 1 }).nextCursor
    assert.notEqual(cursor, null)
    assert.throws(() => a.activity.page({ walletId: WALLET_B, cursor }), /foreign or stale/)
    assert.throws(() => b.activity.page({ walletId: WALLET_A, cursor }), /foreign or stale/)
    assert.throws(
      () => a.activity.page({ walletId: WALLET_A, cursor: 'not-base64url' }),
      /cursor is invalid/,
    )
  } finally {
    a.database.close()
    b.database.close()
  }
})

test('a feed page uses the wallet sequence index without a temporary sort', () => {
  const { database } = createStore()
  try {
    const plan = database
      .prepare(
        `EXPLAIN QUERY PLAN SELECT sequence, item_json
         FROM daemon_activity_feed
         WHERE scope_id = ? AND sequence <= ? AND sequence < ?
         ORDER BY sequence DESC LIMIT ?`,
      )
      .all(`custody:wallet:${WALLET_A}`, 10, 10, 26) as Array<{ detail: string }>
    assert.ok(plan.some(({ detail }) => detail.includes('daemon_activity_feed_page_idx')))
    assert.equal(
      plan.some(({ detail }) => detail.includes('TEMP B-TREE')),
      false,
    )
  } finally {
    database.close()
  }
})
