import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  DAEMON_PROFILE_DATABASE,
  validateDaemonProfileSchema,
} from './profileSchema.ts'
import { getFinalProfileSchemaManifest } from './profileSchemaManifest.ts'
import { withProfileStorageAccess } from './profileAccess.ts'

export type StateSqliteFaultPhase =
  | 'transaction-opened'
  | 'before-commit'
  | 'after-commit'

export interface StateSqliteTransactionOptions {
  readonly injectFault?: (phase: StateSqliteFaultPhase) => void
}

export async function openDaemonStateSqlite(
  directory: string,
): Promise<DatabaseSync> {
  await validateDaemonProfileSchema(directory, getFinalProfileSchemaManifest())
  const database = new DatabaseSync(join(directory, DAEMON_PROFILE_DATABASE))
  configureDaemonStateSqlite(database)
  return database
}

export async function withDaemonStateSqliteTransaction<T>(
  directory: string,
  action: (database: DatabaseSync) => T,
  options: StateSqliteTransactionOptions = {},
): Promise<T> {
  return withProfileStorageAccess(async () => {
    const database = await openDaemonStateSqlite(directory)
    let committed = false
    try {
      database.exec('BEGIN IMMEDIATE')
      // Operation rows intentionally precede their exact artifact rows in the
      // SDK transaction contract. Enforce all foreign keys at COMMIT.
      database.exec('PRAGMA defer_foreign_keys = ON')
      options.injectFault?.('transaction-opened')
      try {
        const result = action(database)
        options.injectFault?.('before-commit')
        database.exec('COMMIT')
        committed = true
        options.injectFault?.('after-commit')
        return result
      } catch (error) {
        if (!committed) {
          try {
            database.exec('ROLLBACK')
          } catch {
            // Preserve the initiating failure.
          }
        }
        throw error
      }
    } finally {
      database.close()
    }
  })
}

export function configureDaemonStateSqlite(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `)
}
