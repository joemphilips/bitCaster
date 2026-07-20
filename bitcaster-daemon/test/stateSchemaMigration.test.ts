import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  assertDaemonStateSchema,
  initializeDaemonStateV1MigrationFixtureForTest,
  migrateDaemonStateSchemaV1ToV2,
  setDaemonStateMigrationFaultHookForTest,
} from '../src/stateSqlite.ts'

test('the exact v1 state schema migrates to strict v2 without changing non-recovery custody', () => {
  const database = legacyDatabase()
  try {
    seedV1Custody(database)
    const before = snapshotPreservedRows(database)

    assert.equal(migrateDaemonStateSchemaV1ToV2(database), true)

    assert.equal(
      database
        .prepare(
          'SELECT schema_version FROM daemon_state_metadata WHERE singleton = 1',
        )
        .get()?.schema_version,
      2,
    )
    assert.deepEqual(snapshotPreservedRows(database), before)
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
    assert.deepEqual(recoveryTables(database), [
      'daemon_seed_recovery_catalogue',
      'daemon_seed_recovery_clocks',
      'daemon_seed_recovery_cursor_history',
      'daemon_seed_recovery_jobs',
      'daemon_seed_recovery_keysets',
      'daemon_seed_recovery_proof_retention',
    ])
    assert.equal(
      recoveryTables(database).every((table) =>
        String(
          database
            .prepare(
              "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
            )
            .get(table)?.sql,
        ).includes('STRICT'),
      ),
      true,
    )
    assert.equal(
      database
        .prepare('SELECT COUNT(*) AS count FROM daemon_seed_recovery_jobs')
        .get()?.count,
      0,
    )
    assert.equal(migrateDaemonStateSchemaV1ToV2(database), false)
  } finally {
    database.close()
  }
})

test('v1 migration rejects an unknown schema and rolls back without resetting recovery', () => {
  const database = legacyDatabase()
  try {
    seedV1Recovery(database)
    database.exec(
      'ALTER TABLE daemon_seed_recovery_jobs ADD COLUMN future_authority TEXT',
    )

    assert.throws(
      () => migrateDaemonStateSchemaV1ToV2(database),
      /daemon SQLite state schema is unsupported/,
    )
    assert.equal(
      database
        .prepare('SELECT COUNT(*) AS count FROM daemon_seed_recovery_jobs')
        .get()?.count,
      1,
    )
    assert.equal(
      database
        .prepare(
          'SELECT schema_version FROM daemon_state_metadata WHERE singleton = 1',
        )
        .get()?.schema_version,
      1,
    )
  } finally {
    database.close()
  }
})

test('v1 migration rejects partial recovery storage and leaves every surviving row intact', () => {
  const database = legacyDatabase()
  try {
    seedV1Custody(database)
    database.exec('DROP TABLE daemon_seed_recovery_keysets')
    const before = snapshotAllRows(database)

    assert.throws(
      () => migrateDaemonStateSchemaV1ToV2(database),
      /daemon SQLite state schema is incomplete/,
    )
    assert.deepEqual(snapshotAllRows(database), before)
  } finally {
    database.close()
  }
})

test('v1 migration rolls back DDL and row resets when migration fails after child drop', () => {
  const database = legacyDatabase()
  try {
    seedV1Custody(database)
    seedV1Recovery(database)
    const before = snapshotAllRows(database)
    setDaemonStateMigrationFaultHookForTest((stage) => {
      if (stage === 'after-v1-recovery-drop') {
        throw new Error('simulated migration crash')
      }
    })

    assert.throws(
      () => migrateDaemonStateSchemaV1ToV2(database),
      /simulated migration crash/,
    )
    assert.deepEqual(snapshotAllRows(database), before)
    assert.equal(
      database
        .prepare(
          'SELECT schema_version FROM daemon_state_metadata WHERE singleton = 1',
        )
        .get()?.schema_version,
      1,
    )
  } finally {
    setDaemonStateMigrationFaultHookForTest(undefined)
    database.close()
  }
})

test('v2 recovery authorities reject oversized cursors, foreign scopes, and selectable retained proofs', () => {
  const database = legacyDatabase()
  try {
    assert.equal(migrateDaemonStateSchemaV1ToV2(database), true)
    seedV2Job(database)
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE daemon_seed_recovery_jobs
            SET current_cursor = ?, current_cursor_digest = ?
          WHERE recovery_id = 'recovery-v2'`,
          )
          .run('x'.repeat(2_049), '11'.repeat(32)),
      /constraint failed/i,
    )
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO daemon_seed_recovery_keysets (
           wallet_scope_id, mint_url, unit, recovery_id, keyset_id, ordinal,
           keyset_kind, curve, catalogue_ordinal, state, next_counter,
           trailing_empty_counters, revision, batch_count, imported_proofs,
           ignored_spent_proofs, retained_pending_proofs, key_count,
           keys_json, keys_digest
         ) VALUES ('foreign-scope', 'https://mint.example', 'sat',
           'recovery-v2', 'ordinary-keyset', 0, 'ordinary', 'secp256k1',
           NULL, 'active', 0, 0, 0, 0, 0, 0, 0, 0, NULL, NULL)`,
          )
          .run(),
      /foreign key constraint failed/i,
    )

    const conditionId = '22'.repeat(32)
    const outcomeCollectionId = '33'.repeat(32)
    const proofId = '44'.repeat(32)
    database
      .prepare(
        `INSERT INTO daemon_seed_recovery_catalogue (
         wallet_scope_id, mint_url, unit, recovery_id, ordinal, keyset_id,
         active, input_fee_ppk, final_expiry, condition_id,
         outcome_collection, outcome_collection_id, registered_at
       ) VALUES ('custody:wallet:${'55'.repeat(32)}', 'https://mint.example',
         'sat', 'recovery-v2', 0, ?, 0, NULL, 2000, ?, ?, ?, 1000)`,
      )
      .run(
        '01'.padEnd(66, '1'),
        conditionId,
        '["YES","NO"]',
        outcomeCollectionId,
      )
    database
      .prepare(
        `INSERT INTO daemon_seed_recovery_keysets (
         wallet_scope_id, mint_url, unit, recovery_id, keyset_id, ordinal,
         keyset_kind, curve, catalogue_ordinal, state, next_counter,
         trailing_empty_counters, revision, batch_count, imported_proofs,
         ignored_spent_proofs, retained_pending_proofs, key_count,
         keys_json, keys_digest
       ) VALUES ('custody:wallet:${'55'.repeat(32)}', 'https://mint.example',
         'sat', 'recovery-v2', ?, 0, 'conditional', 'secp256k1', 0,
         'skipped-expired', 0, 0, 0, 0, 0, 0, 1, 1, ?, ?)`,
      )
      .run('01'.padEnd(66, '1'), '{"1":"02aa"}', '66'.repeat(32))
    database
      .prepare(
        `INSERT INTO daemon_wallet_proofs (
         proof_id, mint_url, unit, proof_secret, keyset_id, amount, signature,
         witness_present, witness_json, dleq_present, dleq_json, p2pk_e,
         proof_condition_id, proof_outcome_collection, state, reserved_by,
         asset_kind, asset_condition_id, asset_outcome_set_id, base_asset,
         created_at, updated_at
       ) VALUES (?, 'https://mint.example', 'sat', 'retained-secret', ?, 1,
         '02aa', 0, NULL, 0, NULL, NULL, ?, ?, 'locked',
         'seed-recovery:recovery-v2', 'Outcome', ?, ?, 'sat', ?, ?)`,
      )
      .run(
        proofId,
        'wrong-keyset',
        conditionId,
        '["YES","NO"]',
        conditionId,
        outcomeCollectionId,
        '2026-07-20T00:00:00.000Z',
        '2026-07-20T00:00:00.000Z',
      )
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO daemon_seed_recovery_proof_retention (
             wallet_scope_id, mint_url, unit, recovery_id, keyset_id,
             retention_id, wallet_proof_id, proof_digest, proof_y, mint_state,
             reason, asset_kind, condition_id, outcome_collection,
             outcome_collection_id, observed_at
           ) VALUES ('custody:wallet:${'55'.repeat(32)}', 'https://mint.example',
             'sat', 'recovery-v2', ?, 'wrong-keyset', ?, ?, '02aa', 'UNSPENT',
             'expired-keyset', 'Outcome', ?, ?, ?, 2000)`,
          )
          .run(
            '01'.padEnd(66, '1'),
            proofId,
            '70'.repeat(32),
            conditionId,
            '["YES","NO"]',
            outcomeCollectionId,
          ),
      /retained proof authority is invalid/,
    )
    database
      .prepare('UPDATE daemon_wallet_proofs SET keyset_id = ? WHERE proof_id = ?')
      .run('01'.padEnd(66, '1'), proofId)
    database
      .prepare(
        `INSERT INTO daemon_seed_recovery_proof_retention (
         wallet_scope_id, mint_url, unit, recovery_id, keyset_id,
         retention_id, wallet_proof_id, proof_digest, proof_y, mint_state,
         reason, asset_kind, condition_id, outcome_collection,
         outcome_collection_id, observed_at
       ) VALUES ('custody:wallet:${'55'.repeat(32)}', 'https://mint.example',
         'sat', 'recovery-v2', ?, 'retained-1', ?, ?, '02aa', 'UNSPENT',
         'expired-keyset', 'Outcome', ?, ?, ?, 2000)`,
      )
      .run(
        '01'.padEnd(66, '1'),
        proofId,
        '77'.repeat(32),
        conditionId,
        '["YES","NO"]',
        outcomeCollectionId,
      )
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE daemon_wallet_proofs
            SET state = 'available', reserved_by = NULL
          WHERE proof_id = ?`,
          )
          .run(proofId),
      /retained proof cannot become selectable/,
    )
    assert.throws(
      () =>
        database
          .prepare(
            'UPDATE daemon_wallet_proofs SET signature = ? WHERE proof_id = ?',
          )
          .run('02bb', proofId),
      /retained proof cannot become selectable/,
    )
  } finally {
    database.close()
  }
})

test('v2 schema validation rejects a missing singleton marker', () => {
  const database = legacyDatabase()
  try {
    assert.equal(migrateDaemonStateSchemaV1ToV2(database), true)
    database.exec('DELETE FROM daemon_state_metadata')
    assert.throws(
      () => assertDaemonStateSchema(database),
      /daemon SQLite state row is missing/,
    )
  } finally {
    database.close()
  }
})

test('an unknown v1 marker and corrupt v1 foreign key both fail without DDL changes', () => {
  const unknown = legacyDatabase()
  try {
    unknown.exec('PRAGMA ignore_check_constraints = ON')
    unknown
      .prepare(
        'UPDATE daemon_state_metadata SET schema_version = 9 WHERE singleton = 1',
      )
      .run()
    unknown.exec('PRAGMA ignore_check_constraints = OFF')
    const before = snapshotAllRows(unknown)
    assert.throws(
      () => migrateDaemonStateSchemaV1ToV2(unknown),
      /schema is unsupported/,
    )
    assert.deepEqual(snapshotAllRows(unknown), before)
  } finally {
    unknown.close()
  }

  const corrupt = legacyDatabase()
  try {
    corrupt.exec('PRAGMA foreign_keys = OFF')
    corrupt
      .prepare(
        `INSERT INTO daemon_seed_recovery_keysets (
         recovery_id, keyset_id, ordinal, next_counter,
         trailing_empty_counters, revision, state
       ) VALUES ('missing-job', 'orphan', 0, 0, 0, 0, 'active')`,
      )
      .run()
    corrupt.exec('PRAGMA foreign_keys = ON')
    const before = snapshotAllRows(corrupt)
    assert.throws(
      () => migrateDaemonStateSchemaV1ToV2(corrupt),
      /foreign keys are corrupt/,
    )
    assert.deepEqual(snapshotAllRows(corrupt), before)
  } finally {
    corrupt.close()
  }
})

function legacyDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  initializeDaemonStateV1MigrationFixtureForTest(database)
  return database
}

function seedV1Custody(database: DatabaseSync): void {
  database
    .prepare(
      `INSERT INTO daemon_wallet_proofs (
       proof_id, mint_url, unit, proof_secret, keyset_id, amount, signature,
       witness_present, witness_json, dleq_present, dleq_json, p2pk_e,
       proof_condition_id, proof_outcome_collection, state, reserved_by,
       asset_kind, asset_condition_id, asset_outcome_set_id, base_asset,
       created_at, updated_at
     ) VALUES (?, ?, 'sat', ?, ?, 8, ?, 0, NULL, 0, NULL, NULL,
       ?, ?, 'locked', ?, 'Outcome', ?, ?, 'sat', ?, ?)`,
    )
    .run(
      '11'.repeat(32),
      'https://mint.example',
      'secret-that-must-survive',
      '01'.padEnd(66, '1'),
      '02'.padEnd(66, '2'),
      '22'.repeat(32),
      '["YES","NO"]',
      'swap:retained',
      '22'.repeat(32),
      'outcome-set',
      '2026-07-20T00:00:00.000Z',
      '2026-07-20T00:00:00.000Z',
    )
  database
    .prepare(
      'INSERT INTO daemon_keyset_counters (counter_key, counter_value) VALUES (?, ?)',
    )
    .run('https://mint.example/keyset', 41)
  database
    .prepare(
      `INSERT INTO daemon_orders (
       order_id, market_id, status, engine_status_present, engine_status_json,
       created_at, updated_at
     ) VALUES (?, ?, 'resting', 0, NULL, ?, ?)`,
    )
    .run(
      'order-preserved',
      'condition-YES',
      '2026-07-20T00:00:00.000Z',
      '2026-07-20T00:00:00.000Z',
    )
  database
    .prepare(
      `INSERT INTO daemon_swaps (
       trade_id, order_id, step, created_at, updated_at
     ) VALUES (?, ?, 'opened', ?, ?)`,
    )
    .run(
      'trade-preserved',
      'order-preserved',
      '2026-07-20T00:00:00.000Z',
      '2026-07-20T00:00:00.000Z',
    )
  database.exec(`
    CREATE TABLE daemon_migration_preservation_fixture (
      singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
      profile_bytes BLOB NOT NULL,
      encrypted_credential_bytes BLOB NOT NULL,
      secret_bytes BLOB NOT NULL,
      session_bytes BLOB NOT NULL,
      outbox_bytes BLOB NOT NULL,
      ownership_epoch INTEGER NOT NULL,
      lease_bytes BLOB NOT NULL
    ) STRICT;
  `)
  database
    .prepare(
      `INSERT INTO daemon_migration_preservation_fixture (
       singleton, profile_bytes, encrypted_credential_bytes, secret_bytes,
       session_bytes, outbox_bytes, ownership_epoch, lease_bytes
     ) VALUES (1, ?, ?, ?, ?, ?, 7, ?)`,
    )
    .run(
      Buffer.from([0, 1, 2, 3]),
      Buffer.from([4, 5, 6]),
      Buffer.from([7, 8, 9]),
      Buffer.from([10, 11]),
      Buffer.from([12, 13, 14]),
      Buffer.from([15, 16]),
    )
}

function seedV1Recovery(database: DatabaseSync): void {
  database
    .prepare(
      `INSERT INTO daemon_seed_recovery_jobs (
       recovery_id, schema_version, mint_url, unit, disclosure_acknowledged,
       state, imported_proofs, ignored_spent_proofs, created_at, updated_at
     ) VALUES ('recovery-v1', 1, 'https://mint.example', 'sat', 1,
       'active', 2, 3, 1000, 2000)`,
    )
    .run()
  database
    .prepare(
      `INSERT INTO daemon_seed_recovery_keysets (
       recovery_id, keyset_id, ordinal, next_counter,
       trailing_empty_counters, revision, state
     ) VALUES ('recovery-v1', 'keyset-v1', 0, 300, 0, 1, 'active')`,
    )
    .run()
}

function seedV2Job(database: DatabaseSync): void {
  database
    .prepare(
      `INSERT INTO daemon_seed_recovery_jobs (
       wallet_scope_id, mint_url, unit, recovery_id, schema_version,
       disclosure_acknowledged, state, phase, revision, current_cursor,
       current_cursor_digest, capability_version, capability_max_page_size,
       page_count, keyset_count, transport_bytes, serialized_bytes,
       work_units, proof_count, imported_proofs, ignored_spent_proofs,
       retained_pending_proofs, created_at, updated_at
     ) VALUES ('custody:wallet:${'55'.repeat(32)}', 'https://mint.example',
       'sat', 'recovery-v2', 2, 1, 'active', 'catalogue', 0, NULL, NULL,
       1, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1000, 1000)`,
    )
    .run()
}

function recoveryTables(database: DatabaseSync): string[] {
  return (
    database
      .prepare(
        `SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name GLOB 'daemon_seed_recovery_*'
      ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map(({ name }) => name)
}

function snapshotPreservedRows(database: DatabaseSync): unknown[] {
  return snapshotAllRows(database).filter(
    ([table]) =>
      table !== 'daemon_state_metadata' &&
      !table.startsWith('daemon_seed_recovery_'),
  )
}

function snapshotAllRows(database: DatabaseSync): Array<[string, unknown[]]> {
  const tables = (
    database
      .prepare(
        `SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map(({ name }) => name)
  return tables.map((table) => [
    table,
    database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  ])
}
