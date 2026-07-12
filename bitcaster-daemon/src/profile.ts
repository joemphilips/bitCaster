import { chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

export interface DaemonProfile {
  engineBaseUrl: string
  mintUrl: string
  nostrPublicKey?: string
  initializedAt: string
}

export interface DaemonProfileBootstrapInput {
  profile: DaemonProfile
  secretsPayload: string
  statePayload: string
  rpcToken: string
  /** Only `init --force` after an empty verified state may replace a complete profile. */
  replaceExisting?: boolean
  /** Executes under the bootstrap BEGIN IMMEDIATE transaction before replacement. */
  assertReplacementSafe?: (database: DatabaseSync) => void
}

const mandatoryProfileTables = [
  'daemon_profile',
  'daemon_secrets',
  'daemon_state',
  'daemon_rpc_token',
] as const

export function profileDir(): string {
  return process.env.BITCASTER_DAEMON_HOME || join(homedir(), '.bitcaster')
}

/** The one durable authority for configuration, secrets, and operational profile state. */
export function profileDatabasePath(): string {
  return join(profileDir(), 'daemon-state.sqlite')
}

export async function ensureProfileDir(): Promise<string> {
  const dir = profileDir()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') {
    await chmod(dir, 0o700)
  }
  return dir
}

export async function readProfile(): Promise<DaemonProfile | null> {
  if (!await profileDatabaseExists()) return null
  const database = openProfileDatabase()
  try {
    const profile = readProfileFromDatabase(database)
    if (!profile && profileInitializationIsComplete(database)) {
      throw new Error('daemon profile row is missing')
    }
    return profile
  } finally {
    database.close()
  }
}

export async function writeProfile(profile: DaemonProfile): Promise<void> {
  await ensureProfileDir()
  const normalized = normalizeProfile(profile)
  const database = openProfileDatabase()
  try {
    if (process.platform !== 'win32') await chmod(profileDatabasePath(), 0o600)
    database.exec('BEGIN IMMEDIATE')
    try {
      ensureProfileTable(database)
      writeProfileToDatabase(database, normalized)
      database.exec('COMMIT')
    } catch (error) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // The transaction may already have completed.
      }
      throw error
    }
  } finally {
    database.close()
  }
}

/**
 * Creates every profile-owned row in one SQLite transaction.  The normal CLI
 * must use this rather than composing the individual low-level writers: a
 * crash cannot leave a repairable half-profile that could be mistaken for a
 * fresh wallet identity.
 */
export async function bootstrapDaemonProfile(
  input: DaemonProfileBootstrapInput,
): Promise<void> {
  // `DatabaseSync` creates a file on open. Preserve whether it existed before
  // this invocation so a wiped schema in an existing profile cannot masquerade
  // as the first bootstrap of a new daemon identity.
  const databaseExisted = await profileDatabaseExists()
  await ensureProfileDir()
  const database = openProfileDatabase()
  try {
    if (process.platform !== 'win32') await chmod(profileDatabasePath(), 0o600)
    const profile = normalizeProfile(input.profile)
    if (!/^[A-Za-z0-9_-]{43}$/.test(input.rpcToken)) {
      throw new Error('daemon RPC token is invalid')
    }
    database.exec('BEGIN IMMEDIATE')
    try {
      const hasProfileStorage = mandatoryProfileTables.some((table) => tableExists(database, table))
        || tableExists(database, 'daemon_profile_initialization')
      if (!hasProfileStorage && databaseExisted) {
        throw new Error('daemon profile storage is incomplete; refusing bootstrap repair')
      }
      if (hasProfileStorage) {
        assertCompleteProfileStorage(database)
        if (!input.replaceExisting) {
          throw new Error('daemon profile is already initialized; use daemon.config to change endpoints')
        }
        if (!input.assertReplacementSafe) {
          throw new Error('daemon profile identity replacement safety check is missing')
        }
        input.assertReplacementSafe(database)
      }

      ensureProfileTable(database)
      ensureDaemonSecretsTable(database)
      ensureDaemonStateTable(database)
      ensureDaemonRpcTokenTable(database)
      ensureProfileInitializationTable(database)
      writeProfileToDatabase(database, profile)
      database.prepare(
        `INSERT INTO daemon_secrets (singleton, schema_version, payload)
         VALUES (1, 1, ?)
         ON CONFLICT(singleton) DO UPDATE SET schema_version = excluded.schema_version, payload = excluded.payload`,
      ).run(input.secretsPayload)
      database.prepare(
        `INSERT INTO daemon_state (singleton, schema_version, payload)
         VALUES (1, 1, ?)
         ON CONFLICT(singleton) DO UPDATE SET schema_version = excluded.schema_version, payload = excluded.payload`,
      ).run(input.statePayload)
      database.prepare(
        `INSERT INTO daemon_rpc_token (singleton, schema_version, token)
         VALUES (1, 1, ?)
         ON CONFLICT(singleton) DO UPDATE SET schema_version = excluded.schema_version, token = excluded.token`,
      ).run(input.rpcToken)
      database.prepare(
        `INSERT INTO daemon_profile_initialization (singleton, schema_version)
         VALUES (1, 1)
         ON CONFLICT(singleton) DO UPDATE SET schema_version = excluded.schema_version`,
      ).run()
      database.exec('COMMIT')
    } catch (error) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // The transaction may already have completed.
      }
      throw error
    }
  } finally {
    database.close()
  }
}

/** Runtime startup is never allowed to repair a partial custody profile. */
export async function assertDaemonProfileStorageComplete(): Promise<void> {
  if (!await profileDatabaseExists()) {
    throw new Error('daemon profile is not initialized; run bitcaster-daemon init')
  }
  const database = openProfileDatabase()
  try {
    assertCompleteProfileStorage(database)
  } finally {
    database.close()
  }
}

export async function updateProfile(
  update: Partial<Pick<DaemonProfile, 'engineBaseUrl' | 'mintUrl'>>,
): Promise<DaemonProfile> {
  await ensureProfileDir()
  const database = openProfileDatabase()
  try {
    if (process.platform !== 'win32') await chmod(profileDatabasePath(), 0o600)
    database.exec('BEGIN IMMEDIATE')
    try {
      const profile = readProfileFromDatabase(database)
      if (!profile) throw new Error('daemon profile is not initialized')
      const next = {
        ...profile,
        ...(update.engineBaseUrl === undefined
          ? {}
          : { engineBaseUrl: normalizeEndpointUrl(update.engineBaseUrl, 'engine URL') }),
        ...(update.mintUrl === undefined
          ? {}
          : { mintUrl: normalizeEndpointUrl(update.mintUrl, 'mint URL') }),
      }
      writeProfileToDatabase(database, next)
      database.exec('COMMIT')
      return next
    } catch (error) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // The transaction may already have completed.
      }
      throw error
    }
  } finally {
    database.close()
  }
}

export function defaultProfile(): DaemonProfile {
  return {
    engineBaseUrl: process.env.BITCASTER_ENGINE_URL || 'http://localhost:5000',
    mintUrl: process.env.BITCASTER_MINT_URL || 'http://localhost:8085',
    initializedAt: new Date().toISOString(),
  }
}

export function profileFromPublicKey(
  nostrPublicKey: string,
  overrides: Partial<Pick<DaemonProfile, 'engineBaseUrl' | 'mintUrl'>> = {},
): DaemonProfile {
  const profile = defaultProfile()
  if (overrides.engineBaseUrl !== undefined) {
    profile.engineBaseUrl = normalizeEndpointUrl(overrides.engineBaseUrl, 'engine URL')
  }
  if (overrides.mintUrl !== undefined) {
    profile.mintUrl = normalizeEndpointUrl(overrides.mintUrl, 'mint URL')
  }
  return { ...profile, nostrPublicKey }
}

export function normalizeEndpointUrl(value: string, name: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Invalid ${name}: ${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Invalid ${name}: expected http or https URL`)
  }
  return value.replace(/\/+$/, '')
}

/** Opens the profile database without creating or repairing any logical row. */
export function openProfileDatabase(): DatabaseSync {
  const database = new DatabaseSync(profileDatabasePath())
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `)
    assertProfileDatabasePragmas(database)
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

export function profileDatabaseExists(): Promise<boolean> {
  return databaseExists(profileDatabasePath())
}

export function profileTableExists(database: DatabaseSync): boolean {
  return tableExists(database, 'daemon_profile')
}

/** A marker is written only after every mandatory profile row exists. */
export function profileInitializationIsComplete(database: DatabaseSync): boolean {
  if (!tableExists(database, 'daemon_profile_initialization')) return false
  const row = database.prepare(
    'SELECT schema_version FROM daemon_profile_initialization WHERE singleton = 1',
  ).get() as { schema_version?: unknown } | undefined
  if (!row) throw new Error('daemon profile initialization row is missing')
  if (row.schema_version !== 1) throw new Error('daemon profile initialization schema is unsupported')
  return true
}

/** Completes first-profile initialization only after all SQLite-owned rows exist. */
export async function markProfileInitializationComplete(): Promise<void> {
  await ensureProfileDir()
  const database = openProfileDatabase()
  try {
    if (process.platform !== 'win32') await chmod(profileDatabasePath(), 0o600)
    database.exec('BEGIN IMMEDIATE')
    try {
      assertMandatoryProfileRows(database)
      ensureProfileInitializationTable(database)
      database.prepare(
        `INSERT INTO daemon_profile_initialization (singleton, schema_version)
         VALUES (1, 1)
         ON CONFLICT(singleton) DO UPDATE SET schema_version = excluded.schema_version`,
      ).run()
      database.exec('COMMIT')
    } catch (error) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // The transaction may already have completed.
      }
      throw error
    }
  } finally {
    database.close()
  }
}

export function tableExists(database: DatabaseSync, tableName: string): boolean {
  return database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(tableName) !== undefined
}

function ensureProfileTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS daemon_profile (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      engine_base_url TEXT NOT NULL,
      mint_url TEXT NOT NULL,
      nostr_public_key TEXT,
      initialized_at TEXT NOT NULL
    ) STRICT;
  `)
}

function ensureProfileInitializationTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS daemon_profile_initialization (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1)
    ) STRICT;
  `)
}

/** Shared physical schema for the daemon secret singleton. */
export function ensureDaemonSecretsTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS daemon_secrets (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      payload TEXT NOT NULL
    ) STRICT;
  `)
}

/** Shared physical schema for the daemon operational-state singleton. */
export function ensureDaemonStateTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS daemon_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      payload TEXT NOT NULL
    ) STRICT;
  `)
}

/** Shared physical schema for the daemon local-RPC bearer singleton. */
export function ensureDaemonRpcTokenTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS daemon_rpc_token (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      token TEXT NOT NULL
    ) STRICT;
  `)
}

function assertCompleteProfileStorage(database: DatabaseSync): void {
  if (!profileInitializationIsComplete(database)) {
    throw new Error('daemon profile storage is incomplete; refusing bootstrap repair')
  }
  assertMandatoryProfileRows(database)
}

function assertMandatoryProfileRows(database: DatabaseSync): void {
  for (const table of mandatoryProfileTables) {
    if (!tableExists(database, table)) {
      throw new Error(`daemon profile initialization is missing ${table}`)
    }
    const row = database.prepare(`SELECT 1 AS present FROM ${table} WHERE singleton = 1`).get()
    if (!row) throw new Error(`daemon profile initialization row is missing for ${table}`)
  }
}

function readProfileFromDatabase(database: DatabaseSync): DaemonProfile | null {
  if (!profileTableExists(database)) return null
  const row = database.prepare(
    `SELECT schema_version, engine_base_url, mint_url, nostr_public_key, initialized_at
     FROM daemon_profile WHERE singleton = 1`,
  ).get() as {
    schema_version?: unknown
    engine_base_url?: unknown
    mint_url?: unknown
    nostr_public_key?: unknown
    initialized_at?: unknown
  } | undefined
  if (!row) return null
  return decodeProfileRow(row)
}

function writeProfileToDatabase(database: DatabaseSync, profile: DaemonProfile): void {
  database.prepare(
    `INSERT INTO daemon_profile (
       singleton, schema_version, engine_base_url, mint_url, nostr_public_key, initialized_at
     ) VALUES (1, 1, ?, ?, ?, ?)
     ON CONFLICT(singleton) DO UPDATE SET
       schema_version = excluded.schema_version,
       engine_base_url = excluded.engine_base_url,
       mint_url = excluded.mint_url,
       nostr_public_key = excluded.nostr_public_key,
       initialized_at = excluded.initialized_at`,
  ).run(
    profile.engineBaseUrl,
    profile.mintUrl,
    profile.nostrPublicKey ?? null,
    profile.initializedAt,
  )
}

function assertProfileDatabasePragmas(database: DatabaseSync): void {
  const journalMode = database.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown } | undefined
  const synchronous = database.prepare('PRAGMA synchronous').get() as { synchronous?: unknown } | undefined
  const foreignKeys = database.prepare('PRAGMA foreign_keys').get() as { foreign_keys?: unknown } | undefined
  const busyTimeout = database.prepare('PRAGMA busy_timeout').get() as { timeout?: unknown } | undefined
  if (journalMode?.journal_mode !== 'wal'
    || synchronous?.synchronous !== 2
    || foreignKeys?.foreign_keys !== 1
    || busyTimeout?.timeout !== 5_000) {
    throw new Error('daemon SQLite durability settings are unavailable')
  }
}

async function databaseExists(path: string): Promise<boolean> {
  try {
    const { stat } = await import('node:fs/promises')
    await stat(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

function decodeProfileRow(row: {
  schema_version?: unknown
  engine_base_url?: unknown
  mint_url?: unknown
  nostr_public_key?: unknown
  initialized_at?: unknown
}): DaemonProfile {
  if (row.schema_version !== 1) throw new Error('daemon profile schema is unsupported')
  return normalizeProfile({
    engineBaseUrl: row.engine_base_url,
    mintUrl: row.mint_url,
    nostrPublicKey: row.nostr_public_key === null ? undefined : row.nostr_public_key,
    initializedAt: row.initialized_at,
  })
}

function normalizeProfile(value: {
  engineBaseUrl: unknown
  mintUrl: unknown
  nostrPublicKey?: unknown
  initializedAt: unknown
}): DaemonProfile {
  if (typeof value.engineBaseUrl !== 'string' || typeof value.mintUrl !== 'string') {
    throw new Error('daemon profile row is invalid')
  }
  if (typeof value.initializedAt !== 'string' || value.initializedAt.length === 0) {
    throw new Error('daemon profile row is invalid')
  }
  if (value.nostrPublicKey !== undefined
    && (typeof value.nostrPublicKey !== 'string' || value.nostrPublicKey.length === 0)) {
    throw new Error('daemon profile row is invalid')
  }
  return {
    // `writeProfile` is also the low-level test/import writer. CLI-supplied
    // endpoint changes are normalized by profileFromPublicKey/updateProfile;
    // do not silently rewrite an already durable configuration row here.
    engineBaseUrl: value.engineBaseUrl,
    mintUrl: value.mintUrl,
    ...(value.nostrPublicKey === undefined ? {} : { nostrPublicKey: value.nostrPublicKey }),
    initializedAt: value.initializedAt,
  }
}
