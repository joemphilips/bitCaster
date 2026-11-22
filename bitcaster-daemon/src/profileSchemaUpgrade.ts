import { createHash } from 'node:crypto'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  captureProfileSchemaManifest,
  DAEMON_PROFILE_DATABASE,
  ProfileSchemaRefusalError,
  validateOpenProfileDatabase,
  type ProfileSchemaManifest,
  type ProfileSchemaMarker,
} from './profileSchema.ts'
import {
  FINAL_PROFILE_APPLICATION_ID,
  FINAL_PROFILE_SCHEMA_MARKERS,
  FINAL_PROFILE_SCHEMA_SQL,
  FINAL_PROFILE_SCHEMA_VERSION,
  getFinalProfileSchemaManifest,
  profileSchemaMarkerTableSql,
} from './profileSchemaManifest.ts'

/**
 * Forward-only profile schema upgrade (ADR-037 amendment of 2026-11-13,
 * decision 6). Version 17 adds the one-step order journal states
 * `order-requested` and `order-request-rejected`. The journal table has a
 * STRICT `CHECK` on the state and on the capability reference, so the upgrade
 * rebuilds that table. The profile marker admits exactly one version, so the
 * upgrade rebuilds it too. Every stored row keeps its values; a release 4 record
 * in `capability-requested`, `capability-bound`, `order-submitted` or
 * `submission-rejected` keeps its old-route recovery. An older binary cannot
 * open a version 17 profile.
 */
export const RELEASE_5A_PROFILE_SCHEMA_VERSION = 16
/** The frozen manifest digest of every version 16 profile (release 4 and 5a). */
export const RELEASE_5A_PROFILE_SCHEMA_MANIFEST_DIGEST =
  'f223b7f46405480d620fc6a6e270279442b6f0b5d0bef4645a8a521701ad2d9f'

const RANGE_PREPARATIONS_TABLE = 'daemon_ctf_range_preparations'
const RANGE_PREPARATION_INDEXES = [
  'daemon_ctf_range_active_recovery_idx',
  'daemon_ctf_range_active_client_order_idx',
] as const
const MARKER_TRIGGERS = [
  'profile_schema_marker_no_update',
  'profile_schema_marker_no_delete',
] as const

// The version 16 lifecycle CHECK and capability pairing CHECK, exactly as stored.
const RELEASE_5A_LIFECYCLE_CHECK = `lifecycle_state IN (
        'prepared', 'capability-requested', 'capability-bound',
        'order-submitted', 'submission-rejected', 'terminal'
      )`
const RELEASE_5A_PAIRING_CHECK = `(lifecycle_state IN ('prepared', 'capability-requested')
        AND capability_artifact_id IS NULL)`
const FINAL_LIFECYCLE_CHECK = `lifecycle_state IN (
        'prepared', 'order-requested', 'order-request-rejected',
        'capability-requested', 'capability-bound',
        'order-submitted', 'submission-rejected', 'terminal'
      )`
const FINAL_PAIRING_CHECK = `(lifecycle_state IN (
        'prepared', 'order-requested', 'order-request-rejected', 'capability-requested'
      )
        AND capability_artifact_id IS NULL)`

function finalStatement(prefix: string): string {
  const matches = FINAL_PROFILE_SCHEMA_SQL.filter((statement) => statement.startsWith(prefix))
  if (matches.length !== 1) throw new Error(`profile schema statement is not unique: ${prefix}`)
  return matches[0]!
}

function finalRangePreparationsTableSql(): string {
  return finalStatement(`CREATE TABLE ${RANGE_PREPARATIONS_TABLE} (`)
}

/** The version 16 journal table: the final table with the version 16 CHECKs. */
function release5aRangePreparationsTableSql(): string {
  const finalSql = finalRangePreparationsTableSql()
  if (!finalSql.includes(FINAL_LIFECYCLE_CHECK) || !finalSql.includes(FINAL_PAIRING_CHECK)) {
    throw new Error('profile schema journal CHECKs changed')
  }
  return finalSql
    .replace(FINAL_LIFECYCLE_CHECK, RELEASE_5A_LIFECYCLE_CHECK)
    .replace(FINAL_PAIRING_CHECK, RELEASE_5A_PAIRING_CHECK)
}

/** The complete version 16 schema. Its manifest digest proves the reconstruction. */
export function release5aProfileSchemaSql(): readonly string[] {
  const finalMarker = profileSchemaMarkerTableSql(FINAL_PROFILE_SCHEMA_VERSION)
  const finalTable = finalRangePreparationsTableSql()
  return FINAL_PROFILE_SCHEMA_SQL.map((statement) => {
    if (statement === finalMarker) {
      return profileSchemaMarkerTableSql(RELEASE_5A_PROFILE_SCHEMA_VERSION)
    }
    if (statement === finalTable) return release5aRangePreparationsTableSql()
    return statement
  })
}

const RELEASE_5A_MARKERS: readonly ProfileSchemaMarker[] = FINAL_PROFILE_SCHEMA_MARKERS.map(
  (marker) =>
    marker.name === 'schema-identity'
      ? {
          ...marker,
          expectedRows: marker.expectedRows.map((row) => ({
            ...row,
            schemaVersion: RELEASE_5A_PROFILE_SCHEMA_VERSION,
          })),
        }
      : marker,
)

let cachedRelease5aManifest: ProfileSchemaManifest | undefined

export function getRelease5aProfileSchemaManifest(): ProfileSchemaManifest {
  if (cachedRelease5aManifest !== undefined) return cachedRelease5aManifest
  const database = new DatabaseSync(':memory:')
  try {
    database.exec(`
      PRAGMA application_id = ${FINAL_PROFILE_APPLICATION_ID};
      PRAGMA user_version = ${RELEASE_5A_PROFILE_SCHEMA_VERSION};
      ${release5aProfileSchemaSql().join(';\n')};
    `)
    const captured = captureProfileSchemaManifest(database, {
      applicationId: FINAL_PROFILE_APPLICATION_ID,
      userVersion: RELEASE_5A_PROFILE_SCHEMA_VERSION,
      markers: RELEASE_5A_MARKERS,
    })
    const digest = createHash('sha256').update(JSON.stringify(captured)).digest('hex')
    if (digest !== RELEASE_5A_PROFILE_SCHEMA_MANIFEST_DIGEST) {
      throw new Error(`release 5a profile schema reconstruction changed: ${digest}`)
    }
    cachedRelease5aManifest = captured
  } finally {
    database.close()
  }
  return cachedRelease5aManifest
}

function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get() as
    | { user_version?: unknown }
    | undefined
  const version = row?.user_version
  if (typeof version !== 'number' || !Number.isSafeInteger(version)) {
    throw new ProfileSchemaRefusalError('sqlite-corrupt')
  }
  return version
}

/**
 * Upgrades one open profile database from version 16 to the final version in
 * one transaction. A final profile is unchanged. Any other version or shape is
 * left for the validator to refuse. The caller holds the daemon run lock.
 */
export function upgradeOpenProfileDatabase(database: DatabaseSync): 'current' | 'upgraded' {
  if (readUserVersion(database) !== RELEASE_5A_PROFILE_SCHEMA_VERSION) return 'current'
  // A table rebuild must not rewrite or check the references of other tables.
  database.exec('PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON')
  try {
    database.exec('BEGIN IMMEDIATE')
    try {
      if (readUserVersion(database) !== RELEASE_5A_PROFILE_SCHEMA_VERSION) {
        database.exec('ROLLBACK')
        return 'current'
      }
      validateOpenProfileDatabase(database, getRelease5aProfileSchemaManifest())
      rebuildProfileSchemaMarker(database)
      rebuildRangePreparations(database)
      database.exec(`PRAGMA user_version = ${FINAL_PROFILE_SCHEMA_VERSION}`)
      validateOpenProfileDatabase(database, getFinalProfileSchemaManifest())
      database.exec('COMMIT')
      return 'upgraded'
    } catch (error) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // A failed BEGIN leaves no transaction.
      }
      throw error
    }
  } finally {
    database.exec('PRAGMA legacy_alter_table = OFF; PRAGMA foreign_keys = ON')
  }
}

function rebuildProfileSchemaMarker(database: DatabaseSync): void {
  for (const trigger of MARKER_TRIGGERS) database.exec(`DROP TRIGGER ${trigger}`)
  database.exec('ALTER TABLE profile_schema_marker RENAME TO profile_schema_marker_v16')
  database.exec(profileSchemaMarkerTableSql(FINAL_PROFILE_SCHEMA_VERSION))
  database.exec(
    `INSERT INTO profile_schema_marker (singleton, schema_name, schema_version, initialized_at_ms)
     SELECT singleton, schema_name, ${FINAL_PROFILE_SCHEMA_VERSION}, initialized_at_ms
     FROM profile_schema_marker_v16`,
  )
  database.exec('DROP TABLE profile_schema_marker_v16')
  for (const trigger of MARKER_TRIGGERS) database.exec(finalStatement(`CREATE TRIGGER ${trigger}`))
}

function rebuildRangePreparations(database: DatabaseSync): void {
  const columns = (
    database.prepare(`PRAGMA table_info(${RANGE_PREPARATIONS_TABLE})`).all() as Array<{
      name: string
    }>
  ).map(({ name }) => name)
  // The legacy rename keeps the references of the source and consolidation
  // tables on the original name, which the new table takes again.
  database.exec(`ALTER TABLE ${RANGE_PREPARATIONS_TABLE} RENAME TO ${RANGE_PREPARATIONS_TABLE}_v16`)
  database.exec(finalRangePreparationsTableSql())
  const list = columns.join(', ')
  const copied = database
    .prepare(
      `INSERT INTO ${RANGE_PREPARATIONS_TABLE} (${list})
       SELECT ${list} FROM ${RANGE_PREPARATIONS_TABLE}_v16`,
    )
    .run()
  const count = database
    .prepare(`SELECT count(*) AS count FROM ${RANGE_PREPARATIONS_TABLE}_v16`)
    .get() as {
    count: number
  }
  if (copied.changes !== count.count) throw new Error('profile journal upgrade lost a row')
  // Dropping the old table drops its indexes, so the final indexes can take their names.
  database.exec(`DROP TABLE ${RANGE_PREPARATIONS_TABLE}_v16`)
  database.exec(finalStatement(`CREATE INDEX ${RANGE_PREPARATION_INDEXES[0]}`))
  database.exec(finalStatement(`CREATE UNIQUE INDEX ${RANGE_PREPARATION_INDEXES[1]}`))
}

/**
 * Upgrades the profile database of `directory` when it holds version 16. A
 * missing database is left to the validator. The caller holds the run lock.
 */
export async function upgradeDaemonProfileSchema(
  directory: string,
): Promise<'current' | 'upgraded'> {
  const path = join(directory, DAEMON_PROFILE_DATABASE)
  try {
    await access(path)
  } catch {
    return 'current'
  }
  const database = new DatabaseSync(path, { allowExtension: false })
  try {
    database.exec('PRAGMA busy_timeout = 5000')
    return upgradeOpenProfileDatabase(database)
  } finally {
    database.close()
  }
}
