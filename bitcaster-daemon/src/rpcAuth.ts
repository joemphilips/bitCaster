import { randomBytes, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import {
  isMissingDaemonProfileError,
  profileDatabasePath,
  profileDir,
} from './profile.ts'
import { readBootstrappedRpcToken } from './profileBootstrap.ts'
import { withProfileStorageAccess } from './profileAccess.ts'

export function rpcSocketPath(): string {
  return process.env.BITCASTER_DAEMON_SOCKET || join(profileDir(), 'daemon.sock')
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

export async function ensureRpcToken(): Promise<string> {
  const token = await readRpcToken()
  if (token === null) {
    throw new Error('daemon RPC token is not initialized; run bitcaster-daemon init')
  }
  return token
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
