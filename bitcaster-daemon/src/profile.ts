import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { DAEMON_PROFILE_DATABASE, validateDaemonProfileSchema } from './profileSchema.ts'
import { getFinalProfileSchemaManifest } from './profileSchemaManifest.ts'
import { withProfileStorageAccess } from './profileAccess.ts'
import { dataDir } from './dataDir.ts'
import { normalizeEndpointUrl } from './endpoint.ts'
import { activeNativeConfig, defaultNativeConfig, type NativeConfig } from './nativeConfig.ts'

export { normalizeEndpointUrl } from './endpoint.ts'

export interface DaemonProfile {
  engineBaseUrl: string
  mintUrl: string
  nostrPublicKey?: string
  initializedAt: string
}

export function profileDir(): string {
  return dataDir()
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
  await validateDaemonProfileSchema(profileDir(), getFinalProfileSchemaManifest())
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
          `SELECT nostr_public_key_hex AS nostrPublicKey,
            initialized_at_ms AS initializedAtMs
           FROM daemon_profile WHERE singleton = 1`,
        )
        .get() as ProfileRow | undefined
      if (row === undefined) throw new Error('daemon profile row is missing')
      return decodeProfileRow(row, activeNativeConfig().config)
    } finally {
      database.close()
    }
  })
}

export async function writeProfile(_profile: DaemonProfile): Promise<void> {
  throw new Error('daemon profile creation is only supported by fresh atomic init')
}

export function defaultProfile(): DaemonProfile {
  const config = defaultNativeConfig()
  return {
    engineBaseUrl: config.daemon.engineUrl,
    mintUrl: config.daemon.mintUrl,
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
          engineBaseUrl: normalizeEndpointUrl(overrides.engineBaseUrl, 'engine URL'),
        }),
    ...(overrides.mintUrl === undefined
      ? {}
      : { mintUrl: normalizeEndpointUrl(overrides.mintUrl, 'mint URL') }),
  }
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
  readonly nostrPublicKey: string
  readonly initializedAtMs: number
}

function decodeProfileRow(row: ProfileRow, config: NativeConfig): DaemonProfile {
  if (
    !/^[0-9a-f]{64}$/.test(row.nostrPublicKey) ||
    !Number.isSafeInteger(row.initializedAtMs) ||
    row.initializedAtMs < 0
  ) {
    throw new Error('daemon profile row is invalid')
  }
  return {
    engineBaseUrl: config.daemon.engineUrl,
    mintUrl: config.daemon.mintUrl,
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

export async function isMissingDaemonProfileError(error: unknown): Promise<boolean> {
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
    return statError instanceof Error && 'code' in statError && statError.code === 'ENOENT'
  }
}
