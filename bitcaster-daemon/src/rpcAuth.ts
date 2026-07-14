import { randomBytes, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import {
  ensureDaemonRpcTokenTable,
  ensureProfileDir,
  openProfileDatabase,
  profileDatabaseExists,
  profileDatabasePath,
  profileInitializationIsComplete,
  profileDir,
  tableExists,
} from './profile.ts'

export function rpcSocketPath(): string {
  return (
    process.env.BITCASTER_DAEMON_SOCKET || join(profileDir(), 'daemon.sock')
  )
}

/** Creates the bearer value inserted by the atomic profile bootstrap transaction. */
export function createRpcToken(): string {
  return randomBytes(32).toString('base64url')
}

export async function readRpcToken(): Promise<string | null> {
  if (!(await profileDatabaseExists())) return null
  const database = openProfileDatabase()
  try {
    if (!tableExists(database, 'daemon_rpc_token')) {
      if (profileInitializationIsComplete(database)) {
        throw new Error('daemon RPC token schema is missing')
      }
      return null
    }
    ensureDaemonRpcTokenTable(database)
    const row = database
      .prepare(
      'SELECT schema_version, token FROM daemon_rpc_token WHERE singleton = 1',
      )
      .get() as { schema_version?: unknown; token?: unknown } | undefined
    if (!row) {
      if (profileInitializationIsComplete(database)) {
        throw new Error('daemon RPC token row is missing')
      }
      return null
    }
    if (
      row.schema_version !== 1 ||
      typeof row.token !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(row.token)
    ) {
      throw new Error('daemon RPC token row is invalid')
    }
    return row.token
  } finally {
    database.close()
  }
}

export async function ensureRpcToken(): Promise<string> {
  const existing = await readRpcToken()
  if (existing) return existing

  const token = createRpcToken()
  await ensureProfileDir()
  const database = openProfileDatabase()
  try {
    if (process.platform !== 'win32') {
      const { chmod } = await import('node:fs/promises')
      await chmod(profileDatabasePath(), 0o600)
    }
    database.exec('BEGIN IMMEDIATE')
    try {
      ensureDaemonRpcTokenTable(database)
      const current = database
        .prepare(
        'SELECT schema_version, token FROM daemon_rpc_token WHERE singleton = 1',
        )
        .get() as { schema_version?: unknown; token?: unknown } | undefined
      if (current) {
        if (
          current.schema_version !== 1 ||
          typeof current.token !== 'string' ||
          !/^[A-Za-z0-9_-]{43}$/.test(current.token)
        ) {
          throw new Error('daemon RPC token row is invalid')
        }
        database.exec('COMMIT')
        return current.token
      }
      database
        .prepare(
        'INSERT INTO daemon_rpc_token (singleton, schema_version, token) VALUES (1, 1, ?)',
        )
        .run(token)
      database.exec('COMMIT')
      return token
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

export function bearerToken(
  header: string | string[] | undefined,
): string | null {
  if (typeof header !== 'string') return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1] ?? null
}

export function tokenMatches(actual: string | null, expected: string): boolean {
  if (!actual) return false
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  if (actualBytes.length !== expectedBytes.length) return false
  return timingSafeEqual(actualBytes, expectedBytes)
}
