import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  assertDaemonStateSchema,
  initializeDaemonStateV2MigrationFixtureForTest,
  migrateDaemonStateSchemaV2ToV3,
  setDaemonStateMigrationFaultHookForTest,
} from '../src/stateSqlite.ts'

const scope = 'custody:wallet:' + '11'.repeat(32)
const mint = 'https://mint.example'
const recoveryId = 'migration-recovery'

function databaseV2(): DatabaseSync {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000')
  initializeDaemonStateV2MigrationFixtureForTest(database)
  return database
}

function seedCompletedV2Job(database: DatabaseSync, keysetCount = 0): void {
  database.prepare(
    `INSERT INTO daemon_seed_recovery_jobs (
      wallet_scope_id, mint_url, unit, recovery_id, schema_version,
      disclosure_acknowledged, state, phase, revision, current_cursor,
      current_cursor_digest, capability_version, capability_max_page_size,
      page_count, keyset_count, transport_bytes, serialized_bytes,
      work_units, proof_count, imported_proofs, ignored_spent_proofs,
      retained_pending_proofs, created_at, updated_at
    ) VALUES (?, ?, 'sat', ?, 2, 1, 'completed', 'completed', 7,
      NULL, NULL, NULL, NULL, 0, ?, 0, 0, 0, 0, 0, 0, 0, 100, 101)`,
  ).run(scope, mint, recoveryId, keysetCount)
}

function snapshot(database: DatabaseSync): string {
  const schema = database.prepare(
    `SELECT type, name, tbl_name, sql FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
  ).all()
  const jobs = database.prepare('SELECT * FROM daemon_seed_recovery_jobs ORDER BY recovery_id').all()
  return JSON.stringify({ schema, jobs })
}

test('strict v2 to v3 migration preserves valid ordinary authority and creates exact evidence tables', () => {
  const database = databaseV2()
  try {
    seedCompletedV2Job(database)
    assert.equal(migrateDaemonStateSchemaV2ToV3(database), true)
    assertDaemonStateSchema(database)
    assert.equal(database.prepare('SELECT schema_version FROM daemon_state_metadata').get()?.schema_version, 3)
    const migrated = database.prepare(
      `SELECT schema_version, cursor_kind, revision, ordinary_baseline_keysets,
              ordinary_baseline_proofs, ordinary_baseline_transport_bytes
         FROM daemon_seed_recovery_jobs WHERE recovery_id = ?`,
    ).get(recoveryId)
    assert.deepEqual({ ...migrated }, {
      schema_version: 3,
      cursor_kind: 'ordinary',
      revision: 7,
      ordinary_baseline_keysets: 0,
      ordinary_baseline_proofs: 0,
      ordinary_baseline_transport_bytes: 0,
    })
    const tables = (database.prepare(
      `SELECT name FROM sqlite_schema WHERE type = 'table'
        AND name GLOB 'daemon_seed_recovery_*' ORDER BY name`,
    ).all() as Array<{ name: string }>).map(({ name }) => name)
    assert.equal(tables.includes('daemon_seed_recovery_current_sessions'), true)
    assert.equal(tables.includes('daemon_seed_recovery_requests'), true)
    assert.equal(tables.includes('daemon_seed_recovery_session_anchors'), true)
    assert.equal(tables.includes('daemon_seed_recovery_batches'), true)
    assert.equal(tables.some((name) => name.endsWith('_v2')), false)
    assert.equal(migrateDaemonStateSchemaV2ToV3(database), false)
  } finally {
    database.close()
  }
})

for (const stage of [
  'after-v2-recovery-drop',
  'after-v3-recovery-create',
  'after-v2-recovery-copy',
] as const) {
  test(`v2 to v3 migration rolls back exactly at ${stage}`, () => {
    const database = databaseV2()
    try {
      seedCompletedV2Job(database)
      const before = snapshot(database)
      setDaemonStateMigrationFaultHookForTest((current) => {
        if (current === stage) throw new Error(`fault:${stage}`)
      })
      assert.throws(() => migrateDaemonStateSchemaV2ToV3(database), new RegExp(`fault:${stage}`))
      assert.equal(snapshot(database), before)
      assert.equal(database.prepare('SELECT schema_version FROM daemon_state_metadata').get()?.schema_version, 2)
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
    } finally {
      setDaemonStateMigrationFaultHookForTest(undefined)
      database.close()
    }
  })
}

test('invalid v2 aggregate authority fails before dispatch and leaves exact v2 bytes', () => {
  const database = databaseV2()
  try {
    seedCompletedV2Job(database, 1)
    const before = snapshot(database)
    assert.throws(
      () => migrateDaemonStateSchemaV2ToV3(database),
      /v2 recovery authority is corrupt/,
    )
    assert.equal(snapshot(database), before)
    assert.equal(database.prepare('SELECT schema_version FROM daemon_state_metadata').get()?.schema_version, 2)
  } finally {
    database.close()
  }
})

test('a v2 schema reader fails closed on the v3 marker', () => {
  const database = databaseV2()
  try {
    assert.equal(migrateDaemonStateSchemaV2ToV3(database), true)
    const marker = database.prepare('SELECT schema_version FROM daemon_state_metadata').get()?.schema_version
    assert.notEqual(marker, 2, 'old schema reader must not accept the v3 marker')
  } finally {
    database.close()
  }
})
