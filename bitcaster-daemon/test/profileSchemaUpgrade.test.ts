import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import {
  readRangePreparation,
  transitionRangePreparation,
  bindRangePreparationAdmission,
} from '../src/ctfRangeOrderJournalSqlite.ts'
import { captureProfileSchemaManifest, validateOpenProfileDatabase } from '../src/profileSchema.ts'
import {
  FINAL_PROFILE_APPLICATION_ID,
  FINAL_PROFILE_SCHEMA_MANIFEST_DIGEST,
  FINAL_PROFILE_SCHEMA_MARKERS,
  FINAL_PROFILE_SCHEMA_VERSION,
  getFinalProfileSchemaManifest,
} from '../src/profileSchemaManifest.ts'
import {
  getRelease5aProfileSchemaManifest,
  release5aProfileSchemaSql,
  RELEASE_5A_PROFILE_SCHEMA_VERSION,
  upgradeOpenProfileDatabase,
} from '../src/profileSchemaUpgrade.ts'
import { encodeCanonicalRangePreparation } from '../src/ctfRangeOrderJournalSqlite.ts'

const SCOPE_ID = `custody:wallet:${'11'.repeat(32)}`
const CAPABILITY = {
  artifactId: '11111111-1111-4111-8111-111111111111',
  bindingDigest: '22'.repeat(32),
  artifactDigest: '33'.repeat(32),
  orderId: '44444444-4444-4444-8444-444444444444',
} as const
const RELEASE_4_STATES = [
  ['range-prepared', 'prepared', false],
  ['range-capability-requested', 'capability-requested', false],
  ['range-capability-bound', 'capability-bound', true],
  ['range-order-submitted', 'order-submitted', true],
  ['range-submission-rejected', 'submission-rejected', true],
  ['range-terminal', 'terminal', false],
] as const

function release5aDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:')
  database.exec(`
    PRAGMA application_id = ${FINAL_PROFILE_APPLICATION_ID};
    PRAGMA user_version = ${RELEASE_5A_PROFILE_SCHEMA_VERSION};
    PRAGMA foreign_keys = ON;
    ${release5aProfileSchemaSql().join(';\n')};
  `)
  return database
}

/** The bootstrap rows that the schema markers require, as release 5a wrote them. */
function insertProfileAuthority(database: DatabaseSync, schemaVersion: number): void {
  database.exec('PRAGMA foreign_keys = OFF')
  database
    .prepare(
      `INSERT INTO profile_schema_marker (singleton, schema_name, schema_version, initialized_at_ms)
       VALUES (1, 'bitcaster-daemon-profile', ?, 5)`,
    )
    .run(schemaVersion)
  database
    .prepare(
      `INSERT INTO custody_scopes (scope_id, scope_kind, wallet_id, wallet_seed_digest, created_at_ms)
       VALUES (?, 'wallet', ?, ?, 0)`,
    )
    .run(SCOPE_ID, '11'.repeat(32), '22'.repeat(32))
  database
    .prepare(
      `INSERT INTO custody_scope_state (scope_id, fencing_epoch, high_water_mark_ms) VALUES (?, 0, 0)`,
    )
    .run(SCOPE_ID)
  database
    .prepare(
      `INSERT INTO daemon_profile (singleton, nostr_public_key_hex, wallet_scope_id, initialized_at_ms)
       VALUES (1, ?, ?, 5)`,
    )
    .run('aa'.repeat(32), SCOPE_ID)
  database
    .prepare(
      `INSERT INTO daemon_secret_authority (
         singleton, wallet_scope_id, nostr_public_key_hex, protection, secret_body, created_at_ms
       ) VALUES (1, ?, ?, 'owner-only-plaintext', x'01', 5)`,
    )
    .run(SCOPE_ID, 'aa'.repeat(32))
  database
    .prepare(`INSERT INTO daemon_rpc_token (singleton, token, created_at_ms) VALUES (1, ?, 5)`)
    .run('a'.repeat(43))
  database.exec(
    'INSERT INTO daemon_oracle_nonce_allocator (singleton, next_nonce_index) VALUES (1, 0)',
  )
  database
    .prepare('INSERT INTO daemon_activity_feed_meta (singleton, instance_id) VALUES (1, ?)')
    .run('55555555-5555-4555-8555-555555555555')
  database.exec('PRAGMA foreign_keys = ON')
}

function insertRelease4Record(
  database: DatabaseSync,
  rangeOperationId: string,
  lifecycleState: string,
  withCapability: boolean,
): void {
  database
    .prepare(
      `INSERT INTO daemon_ctf_range_preparations (
         scope_id, range_operation_id, source_operation_id, authorization_id,
         client_order_id, order_route_id, normalized_mint, condition_id, unit,
         token_side, side, price_subunits, amount_subunits,
         minimum_fill_amount_subunits, consolidate_proofs, divisibility,
         authorization_expires_at_unix_seconds, preparation_body, fee_consent_body,
         lifecycle_state, revision,
         capability_artifact_id, capability_binding_digest, capability_artifact_digest,
         engine_order_id, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, 'condition-1-YES', 'https://mint.example', 'condition-1',
         'msat', 'Outcome', 'Buy', 500, 1000, 1000, 0, 1000, 2000000000, ?, NULL, ?, 2,
         ?, ?, ?, ?, 10, 12)`,
    )
    .run(
      SCOPE_ID,
      rangeOperationId,
      `source-${rangeOperationId}`,
      `authorization-${rangeOperationId}`,
      `client-${rangeOperationId}`,
      encodeCanonicalRangePreparation({ rangeOperationId }),
      lifecycleState,
      withCapability ? CAPABILITY.artifactId : null,
      withCapability ? CAPABILITY.bindingDigest : null,
      withCapability ? CAPABILITY.artifactDigest : null,
      withCapability ? CAPABILITY.orderId : null,
    )
}

test('the reconstructed version 16 schema equals the frozen release 5a manifest', () => {
  // The digest check inside the getter proves an exact reconstruction.
  assert.equal(getRelease5aProfileSchemaManifest().userVersion, RELEASE_5A_PROFILE_SCHEMA_VERSION)
  assert.equal(getFinalProfileSchemaManifest().userVersion, FINAL_PROFILE_SCHEMA_VERSION)
  assert.equal(FINAL_PROFILE_SCHEMA_VERSION, RELEASE_5A_PROFILE_SCHEMA_VERSION + 1)
})

test('a version 16 journal refuses the one-step states', (t) => {
  const database = release5aDatabase()
  t.after(() => database.close())
  insertProfileAuthority(database, RELEASE_5A_PROFILE_SCHEMA_VERSION)
  assert.throws(
    () => insertRelease4Record(database, 'range-new', 'order-requested', false),
    /constraint/,
  )
})

test('the upgrade rebuilds the journal and keeps every release 4 record readable', (t) => {
  const database = release5aDatabase()
  t.after(() => database.close())
  insertProfileAuthority(database, RELEASE_5A_PROFILE_SCHEMA_VERSION)
  for (const [rangeOperationId, state, withCapability] of RELEASE_4_STATES) {
    insertRelease4Record(database, rangeOperationId, state, withCapability)
  }
  validateOpenProfileDatabase(database, getRelease5aProfileSchemaManifest())

  assert.equal(upgradeOpenProfileDatabase(database), 'upgraded')

  // The real validator admits the result as the final schema.
  validateOpenProfileDatabase(database, getFinalProfileSchemaManifest())
  const captured = captureProfileSchemaManifest(database, {
    applicationId: FINAL_PROFILE_APPLICATION_ID,
    userVersion: FINAL_PROFILE_SCHEMA_VERSION,
    markers: FINAL_PROFILE_SCHEMA_MARKERS,
  })
  assert.equal(
    createHash('sha256').update(JSON.stringify(captured)).digest('hex'),
    FINAL_PROFILE_SCHEMA_MANIFEST_DIGEST,
  )
  for (const [rangeOperationId, state, withCapability] of RELEASE_4_STATES) {
    const record = readRangePreparation(database, SCOPE_ID, rangeOperationId)
    assert.equal(record?.lifecycleState, state, rangeOperationId)
    assert.equal(record?.revision, 2)
    assert.equal(record?.capability?.orderId ?? null, withCapability ? CAPABILITY.orderId : null)
  }
  // The marker stays immutable after its rebuild.
  assert.throws(
    () => database.exec('UPDATE profile_schema_marker SET initialized_at_ms = 6'),
    /immutable/,
  )
  // Foreign keys of the dependent tables point at the rebuilt table.
  assert.throws(
    () =>
      database.exec(
        `INSERT INTO daemon_ctf_range_consolidations (
           scope_id, range_operation_id, round, operation_id, reservation_id, operation_purpose
         ) VALUES ('${SCOPE_ID}', 'absent', 0, 'op', 'res', 'ctf-range-authorization-consolidation')`,
      ),
    /FOREIGN KEY/,
  )
  // A second run is a no-op.
  assert.equal(upgradeOpenProfileDatabase(database), 'current')
})

test('the upgraded journal admits the one-step transitions', (t) => {
  const database = release5aDatabase()
  t.after(() => database.close())
  insertProfileAuthority(database, RELEASE_5A_PROFILE_SCHEMA_VERSION)
  insertRelease4Record(database, 'range-prepared', 'prepared', false)
  upgradeOpenProfileDatabase(database)

  const requested = transitionRangePreparation(database, {
    scopeId: SCOPE_ID,
    rangeOperationId: 'range-prepared',
    expectedRevision: 2,
    from: 'prepared',
    to: 'order-requested',
    updatedAtMs: 20,
  })
  assert.equal(requested.capability, null)
  const submitted = bindRangePreparationAdmission(database, {
    scopeId: SCOPE_ID,
    rangeOperationId: 'range-prepared',
    expectedRevision: 3,
    capability: CAPABILITY,
    updatedAtMs: 21,
  })
  assert.equal(submitted.lifecycleState, 'order-submitted')
  assert.equal(submitted.capability?.artifactDigest, CAPABILITY.artifactDigest)
  // The STRICT CHECK refuses a capability on order-requested.
  assert.throws(
    () =>
      database.exec(
        `UPDATE daemon_ctf_range_preparations SET lifecycle_state = 'order-requested'
         WHERE range_operation_id = 'range-prepared'`,
      ),
    /constraint/,
  )
})

test('a failed upgrade leaves the version 16 profile unchanged', (t) => {
  const database = release5aDatabase()
  t.after(() => database.close())
  insertProfileAuthority(database, RELEASE_5A_PROFILE_SCHEMA_VERSION)
  insertRelease4Record(database, 'range-bound', 'capability-bound', true)
  // A foreign object makes the version 16 shape check fail before any change.
  database.exec('CREATE TABLE foreign_object (id INTEGER PRIMARY KEY) STRICT')
  assert.throws(() => upgradeOpenProfileDatabase(database), /schema/)
  const version = database.prepare('PRAGMA user_version').get() as { user_version: number }
  assert.equal(version.user_version, RELEASE_5A_PROFILE_SCHEMA_VERSION)
  assert.equal(
    readRangePreparation(database, SCOPE_ID, 'range-bound')?.lifecycleState,
    'capability-bound',
  )
})
