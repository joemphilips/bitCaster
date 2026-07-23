import { homedir } from 'node:os'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import {
  DAEMON_PROFILE_DATABASE,
  validateDaemonProfileSchema,
} from './profileSchema.ts'
import { getFinalProfileSchemaManifest } from './profileSchemaManifest.ts'
import { withDaemonStateSqliteTransaction } from './stateSqlite.ts'
import { withProfileStorageAccess } from './profileAccess.ts'

export interface DaemonProfile {
  engineBaseUrl: string
  mintUrl: string
  nostrPublicKey?: string
  initializedAt: string
}

export function profileDir(): string {
  return process.env.BITCASTER_DAEMON_HOME || join(homedir(), '.bitcaster')
}

export function profileDatabasePath(): string {
  return join(profileDir(), DAEMON_PROFILE_DATABASE)
}

export function profilePath(): string {
  return profileDatabasePath()
}

/** Compatibility name for callers; this verifies and never creates or chmods. */
export async function ensureProfileDir(): Promise<string> {
  await assertDaemonProfileStorageComplete()
  return profileDir()
}

export async function assertDaemonProfileStorageComplete(): Promise<void> {
  await validateDaemonProfileSchema(
    profileDir(),
    getFinalProfileSchemaManifest(),
  )
}

export async function readProfile(): Promise<DaemonProfile | null> {
  return withProfileStorageAccess(async () => {
    try {
      await assertDaemonProfileStorageComplete()
    } catch (error) {
      if (await isMissingDaemonProfileError(error)) return null
      throw error
    }
    const database = openImmutableProfileDatabase()
    try {
      const row = database
        .prepare(
          `SELECT engine_base_url AS engineBaseUrl, mint_url AS mintUrl,
            nostr_public_key_hex AS nostrPublicKey,
            initialized_at_ms AS initializedAtMs
           FROM daemon_profile WHERE singleton = 1`,
        )
        .get() as ProfileRow | undefined
      if (row === undefined) throw new Error('daemon profile row is missing')
      return decodeProfileRow(row)
    } finally {
      database.close()
    }
  })
}

export async function writeProfile(_profile: DaemonProfile): Promise<void> {
  throw new Error(
    'daemon profile creation is only supported by fresh atomic init',
  )
}

export async function updateProfile(
  update: Partial<Pick<DaemonProfile, 'engineBaseUrl' | 'mintUrl'>>,
): Promise<DaemonProfile> {
  return withDaemonStateSqliteTransaction(profileDir(), (database) => {
    const current = database
      .prepare(
        `SELECT engine_base_url AS engineBaseUrl, mint_url AS mintUrl,
          nostr_public_key_hex AS nostrPublicKey,
          initialized_at_ms AS initializedAtMs
         FROM daemon_profile WHERE singleton = 1`,
      )
      .get() as ProfileRow | undefined
    if (current === undefined) throw new Error('daemon profile is not initialized')
    const engineBaseUrl =
      update.engineBaseUrl === undefined
        ? current.engineBaseUrl
        : normalizeEndpointUrl(update.engineBaseUrl, 'engine URL')
    const mintUrl =
      update.mintUrl === undefined
        ? current.mintUrl
        : normalizeEndpointUrl(update.mintUrl, 'mint URL')
    database
      .prepare(
        `UPDATE daemon_profile SET engine_base_url = ?, mint_url = ?
         WHERE singleton = 1`,
      )
      .run(engineBaseUrl, mintUrl)
    return decodeProfileRow({ ...current, engineBaseUrl, mintUrl })
  })
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
  return {
    ...profile,
    nostrPublicKey,
    ...(overrides.engineBaseUrl === undefined
      ? {}
      : {
          engineBaseUrl: normalizeEndpointUrl(
            overrides.engineBaseUrl,
            'engine URL',
          ),
        }),
    ...(overrides.mintUrl === undefined
      ? {}
      : { mintUrl: normalizeEndpointUrl(overrides.mintUrl, 'mint URL') }),
  }
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

export function openProfileDatabase(): DatabaseSync {
  const url = pathToFileURL(profileDatabasePath())
  url.searchParams.set('mode', 'rw')
  return new DatabaseSync(url, { allowExtension: false })
}

export async function profileDatabaseExists(): Promise<boolean> {
  try {
    await assertDaemonProfileStorageComplete()
    return true
  } catch (error) {
    if (await isMissingDaemonProfileError(error)) return false
    throw error
  }
}

interface ProfileRow {
  readonly engineBaseUrl: string
  readonly mintUrl: string
  readonly nostrPublicKey: string
  readonly initializedAtMs: number
}

function decodeProfileRow(row: ProfileRow): DaemonProfile {
  if (
    typeof row.engineBaseUrl !== 'string' ||
    typeof row.mintUrl !== 'string' ||
    !/^[0-9a-f]{64}$/.test(row.nostrPublicKey) ||
    !Number.isSafeInteger(row.initializedAtMs) ||
    row.initializedAtMs < 0
  ) {
    throw new Error('daemon profile row is invalid')
  }
  return {
    engineBaseUrl: normalizeEndpointUrl(row.engineBaseUrl, 'engine URL'),
    mintUrl: normalizeEndpointUrl(row.mintUrl, 'mint URL'),
    nostrPublicKey: row.nostrPublicKey,
    initializedAt: new Date(row.initializedAtMs).toISOString(),
  }
}

function openImmutableProfileDatabase(): DatabaseSync {
  const url = pathToFileURL(profileDatabasePath())
  url.searchParams.set('mode', 'ro')
  url.searchParams.set('immutable', '1')
  return new DatabaseSync(url, { readOnly: true, allowExtension: false })
}

export async function isMissingDaemonProfileError(
  error: unknown,
): Promise<boolean> {
  if (
    error instanceof Error &&
    'reason' in error &&
    (error as { reason?: unknown }).reason === 'sqlite-database-missing'
  ) {
    return true
  }
  if (
    !(error instanceof Error) ||
    !('reason' in error) ||
    (error as { reason?: unknown }).reason !== 'profile-directory-not-plain'
  ) {
    return false
  }
  try {
    await lstat(profileDir())
    return false
  } catch (statError) {
    return (
      statError instanceof Error &&
      'code' in statError &&
      statError.code === 'ENOENT'
    )
  }
}
