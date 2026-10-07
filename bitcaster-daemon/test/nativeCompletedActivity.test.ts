import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { NATIVE_ACTIVITY_SCHEMA_SQL, NativeActivitySqlite } from '../src/nativeActivitySqlite.ts'
import {
  creditedProofAmountMsat,
  writeNativeCompletedActivity,
  writeNativeRecoveredClaimActivity,
} from '../src/nativeCompletedActivity.ts'

const WALLET_A = '11'.repeat(32)
const WALLET_B = '22'.repeat(32)

for (const [unit, expected] of [
  ['sat', 3000],
  ['msat', 3],
] as const) {
  test(`completed Activity converts exact ${unit} proof outputs to msats`, () => {
    assert.equal(creditedProofAmountMsat([{ amount: 1 }, { amount: 2 }], unit), expected)
    assert.throws(
      () => creditedProofAmountMsat([{ amount: Number.MAX_SAFE_INTEGER }], 'sat'),
      /credited amount/,
    )
  })
}

test('completed source retries preserve date and sequence while bounded optional text stays unavailable', () => {
  const database = new DatabaseSync(':memory:')
  try {
    database.exec(
      'PRAGMA foreign_keys = ON; CREATE TABLE custody_scopes(scope_id TEXT PRIMARY KEY) STRICT',
    )
    for (const sql of NATIVE_ACTIVITY_SCHEMA_SQL) database.exec(sql)
    for (const wallet of [WALLET_A, WALLET_B]) {
      database
        .prepare('INSERT INTO custody_scopes(scope_id) VALUES (?)')
        .run(`custody:wallet:${wallet}`)
    }
    const store = new NativeActivitySqlite(database)
    store.initialize('10000000-0000-0000-0000-000000000001')
    const input = {
      scopeId: `custody:wallet:${WALLET_A}`,
      sourceKind: 'position-claim',
      sourceId: 'claim-source-'.repeat(1024),
      type: 'payout_claimed' as const,
      amountMsat: 7,
      completedAtMs: 1000,
      txId: 'claim-source-'.repeat(1024),
      lightningInvoice: '\u0000'.repeat(4096),
    }
    writeNativeCompletedActivity(database, input)
    const before = database
      .prepare('SELECT sequence, source_id, item_json FROM daemon_activity_feed')
      .get()
    const item = store.page({ walletId: WALLET_A }).items[0]!
    assert.equal(item.date, '1970-01-01T00:00:01.000Z')
    assert.equal(item.txId, null)
    assert.equal(item.lightningInvoice, null)
    assert.equal(item.amountSubunits, 7)
    assert.ok(Buffer.byteLength(item.id) < 1024)
    writeNativeCompletedActivity(database, { ...input, completedAtMs: 2000 })
    assert.deepEqual(
      database.prepare('SELECT sequence, source_id, item_json FROM daemon_activity_feed').get(),
      before,
    )
    assert.equal(store.page({ walletId: WALLET_B }).items.length, 0)
    writeNativeCompletedActivity(database, {
      ...input,
      scopeId: `custody:wallet:${WALLET_B}`,
      completedAtMs: 3000,
    })
    assert.notEqual(store.page({ walletId: WALLET_B }).items[0]?.id, item.id)
    assert.equal(store.page({ walletId: WALLET_B }).items[0]?.walletId, WALLET_B)
    assert.equal(store.page({ walletId: WALLET_A }).items.length, 1)
  } finally {
    database.close()
  }
})

test('recovered Claim admission sets keep separate immutable credits for one retained target', () => {
  const database = new DatabaseSync(':memory:')
  try {
    database.exec(
      'PRAGMA foreign_keys = ON; CREATE TABLE custody_scopes(scope_id TEXT PRIMARY KEY) STRICT',
    )
    for (const sql of NATIVE_ACTIVITY_SCHEMA_SQL) database.exec(sql)
    const scopeId = `custody:wallet:${WALLET_A}`
    database.prepare('INSERT INTO custody_scopes(scope_id) VALUES (?)').run(scopeId)
    const store = new NativeActivitySqlite(database)
    store.initialize('10000000-0000-0000-0000-000000000001')
    const first = {
      scopeId,
      targetOperationId: 'retained-target-one',
      admittedProofIds: ['proof-b', 'proof-a'],
      amountMsat: 8,
      completedAtMs: 1000,
    }
    writeNativeRecoveredClaimActivity(database, first)
    const frozen = database
      .prepare('SELECT sequence, source_id, item_json FROM daemon_activity_feed')
      .all()
    writeNativeRecoveredClaimActivity(database, {
      ...first,
      admittedProofIds: ['proof-a', 'proof-b'],
      completedAtMs: 2000,
    })
    assert.deepEqual(
      database.prepare('SELECT sequence, source_id, item_json FROM daemon_activity_feed').all(),
      frozen,
    )
    writeNativeRecoveredClaimActivity(database, {
      ...first,
      admittedProofIds: ['proof-c'],
      amountMsat: 16,
      completedAtMs: 3000,
    })
    const rows = store.page({ walletId: WALLET_A }).items
    assert.deepEqual(
      rows.map((item) => item.amountSubunits).sort((a, b) => a - b),
      [8, 16],
    )
    assert.notEqual(rows[0]!.id, rows[1]!.id)
    assert.equal(
      rows.every((item) => item.claimRecovery?.originalOperationId === 'retained-target-one'),
      true,
    )
    assert.equal(
      rows.every(
        (item) =>
          item.claimRecovery?.originalStatus === 'Failed' &&
          item.claimRecovery.originalFailureCode === 13015,
      ),
      true,
    )
    assert.doesNotMatch(JSON.stringify(rows), /proof-a|proof-b|proof-c/)
  } finally {
    database.close()
  }
})
