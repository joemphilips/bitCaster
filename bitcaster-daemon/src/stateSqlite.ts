import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DAEMON_PROFILE_DATABASE, validateDaemonProfileSchema } from './profileSchema.ts'
import { getFinalProfileSchemaManifest } from './profileSchemaManifest.ts'
import { withProfileStorageAccess } from './profileAccess.ts'

export type StateSqliteFaultPhase = 'transaction-opened' | 'before-commit' | 'after-commit'

export interface StateSqliteTransactionOptions {
  readonly injectFault?: (phase: StateSqliteFaultPhase) => void
  /** Notify observers only when the transaction can change wallet holdings. */
  readonly notifyWalletHoldingsCommit?: boolean
}

export interface DaemonStateSqliteSession {
  read<T>(action: (database: DatabaseSync) => T): Promise<T>
  transaction<T>(
    action: (database: DatabaseSync) => T,
    options?: StateSqliteTransactionOptions,
  ): Promise<T>
}

const walletHoldingsListenersByDatabase = new Map<string, Set<() => void>>()

/** Observes successful wallet-holdings commits for one profile database. */
export function subscribeToDaemonWalletHoldingsCommits(
  directory: string,
  callback: () => void,
): () => void {
  const databasePath = daemonDatabasePath(directory)
  const listeners = walletHoldingsListenersByDatabase.get(databasePath) ?? new Set<() => void>()
  listeners.add(callback)
  walletHoldingsListenersByDatabase.set(databasePath, listeners)
  return () => {
    listeners.delete(callback)
    if (listeners.size === 0) walletHoldingsListenersByDatabase.delete(databasePath)
  }
}

export async function openDaemonStateSqlite(directory: string): Promise<DatabaseSync> {
  await validateDaemonProfileSchema(directory, getFinalProfileSchemaManifest())
  return openConfiguredDatabase(directory)
}

/**
 * Validates the immutable profile/schema authority once, then serializes cheap
 * configured opens for a daemon runtime. The OS run lock protects the profile
 * identity for the lifetime of the runtime; custody fences protect mutations.
 */
export function createDaemonStateSqliteSession(directory: string): DaemonStateSqliteSession {
  const ready = withProfileStorageAccess(() =>
    validateDaemonProfileSchema(directory, getFinalProfileSchemaManifest()),
  )
  return {
    async read<T>(action: (database: DatabaseSync) => T): Promise<T> {
      await ready
      return withProfileStorageAccess(() => withConfiguredDatabase(directory, action))
    },
    async transaction<T>(
      action: (database: DatabaseSync) => T,
      options: StateSqliteTransactionOptions = {},
    ): Promise<T> {
      await ready
      return withProfileStorageAccess(() => withConfiguredTransaction(directory, action, options))
    },
  }
}

export async function withDaemonStateSqliteTransaction<T>(
  directory: string,
  action: (database: DatabaseSync) => T,
  options: StateSqliteTransactionOptions = {},
): Promise<T> {
  return withProfileStorageAccess(async () => {
    await validateDaemonProfileSchema(directory, getFinalProfileSchemaManifest())
    return withConfiguredTransaction(directory, action, options)
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

function openConfiguredDatabase(directory: string): DatabaseSync {
  const database = new DatabaseSync(daemonDatabasePath(directory))
  configureDaemonStateSqlite(database)
  return database
}

function withConfiguredDatabase<T>(directory: string, action: (database: DatabaseSync) => T): T {
  const database = openConfiguredDatabase(directory)
  try {
    return action(database)
  } finally {
    database.close()
  }
}

function withConfiguredTransaction<T>(
  directory: string,
  action: (database: DatabaseSync) => T,
  options: StateSqliteTransactionOptions,
): T {
  return withConfiguredDatabase(directory, (database) => {
    let committed = false
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
      if (options.notifyWalletHoldingsCommit) {
        for (const listener of walletHoldingsListenersByDatabase.get(
          daemonDatabasePath(directory),
        ) ?? []) {
          try {
            listener()
          } catch {
            // Monitoring observers must never affect durable custody commits.
          }
        }
      }
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
  })
}

function daemonDatabasePath(directory: string): string {
  return join(directory, DAEMON_PROFILE_DATABASE)
}
