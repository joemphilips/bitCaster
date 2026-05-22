import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface DaemonProfile {
  engineBaseUrl: string
  mintUrl: string
  nostrPublicKey?: string
  initializedAt: string
}

export function profileDir(): string {
  return process.env.BITCASTER_DAEMON_HOME || join(homedir(), '.bitcaster')
}

export function profilePath(): string {
  return join(profileDir(), 'daemon-profile.json')
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
  try {
    return JSON.parse(await readFile(profilePath(), 'utf8')) as DaemonProfile
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return null
    }
    throw err
  }
}

export async function writeProfile(profile: DaemonProfile): Promise<void> {
  const dir = await ensureProfileDir()
  const target = profilePath()
  const tmp = join(dir, `.daemon-profile.${process.pid}.${Date.now()}.tmp`)
  await writeFile(tmp, `${JSON.stringify(profile, null, 2)}\n`, {
    mode: 0o600,
  })
  await rename(tmp, target)
}

export async function updateProfile(
  update: Partial<Pick<DaemonProfile, 'engineBaseUrl' | 'mintUrl'>>,
): Promise<DaemonProfile> {
  const profile = await readProfile()
  if (!profile) throw new Error('daemon profile is not initialized')
  if (update.engineBaseUrl !== undefined) {
    profile.engineBaseUrl = normalizeEndpointUrl(update.engineBaseUrl, 'engine URL')
  }
  if (update.mintUrl !== undefined) {
    profile.mintUrl = normalizeEndpointUrl(update.mintUrl, 'mint URL')
  }
  await writeProfile(profile)
  return profile
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
