import { randomBytes, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { isMissingDaemonProfileError, profileDatabasePath, profileDir } from './profile.ts'
import { readBootstrappedRpcToken, readLiveBootstrappedRpcToken } from './profileBootstrap.ts'
import { withProfileStorageAccess } from './profileAccess.ts'
import { DAEMON_RPC_SOCKET } from './profileSchema.ts'

/**
 * Linux binds and connects a path that fills its 108-byte `sun_path`, measured
 * on Node.js 22, 24 and 26. Node.js 22 truncates a longer path without an
 * error, so the daemon would bind a different file. macOS and the BSDs have a
 * 104-byte `sun_path`; 103 bytes leaves room for the NUL byte. That value is
 * conservative and not measured.
 */
function unixSocketPathBytesMax(platform: NodeJS.Platform): number {
  return platform === 'linux' || platform === 'android' ? 108 : 103
}

export function rpcSocketPath(platform: NodeJS.Platform = process.platform): string {
  const path = join(profileDir(), DAEMON_RPC_SOCKET)
  const bytes = Buffer.byteLength(path)
  const limit = unixSocketPathBytesMax(platform)
  if (bytes > limit) {
    throw new Error(
      `daemon socket path is ${bytes} bytes, over the ${limit}-byte Unix socket path limit: ${path}. Choose a shorter --datadir.`,
    )
  }
  return path
}

export function rpcTokenPath(): string {
  return profileDatabasePath()
}

export function createRpcToken(): string {
  return randomBytes(32).toString('base64url')
}

export async function readRpcToken(): Promise<string | null> {
  return withProfileStorageAccess(async () => {
    try {
      return await readBootstrappedRpcToken(profileDir())
    } catch (error) {
      if (await isMissingDaemonProfileError(error)) return null
      throw error
    }
  })
}

export async function readLiveRpcToken(): Promise<string | null> {
  return withProfileStorageAccess(async () => {
    try {
      // Immutable inspection can read mixed main-file pages during a live checkpoint.
      return await readLiveBootstrappedRpcToken(profileDir())
    } catch (error) {
      if (await isMissingDaemonProfileError(error)) return null
      throw error
    }
  })
}

export async function ensureRpcToken(): Promise<string> {
  const token = await readRpcToken()
  if (token === null) {
    throw new Error('daemon RPC token is not initialized; run bitcaster-daemon init')
  }
  return token
}

export function bearerToken(header: string | string[] | undefined): string | null {
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
