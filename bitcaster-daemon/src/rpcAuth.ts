import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureProfileDir, profileDir } from './profile.ts'

export function rpcTokenPath(): string {
  return join(profileDir(), 'daemon-rpc-token')
}

export function rpcSocketPath(): string {
  return process.env.BITCASTER_DAEMON_SOCKET || join(profileDir(), 'daemon.sock')
}

export async function readRpcToken(): Promise<string | null> {
  try {
    return (await readFile(rpcTokenPath(), 'utf8')).trim()
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return null
    }
    throw err
  }
}

export async function ensureRpcToken(): Promise<string> {
  const existing = await readRpcToken()
  if (existing) return existing

  const token = randomBytes(32).toString('base64url')
  const dir = await ensureProfileDir()
  const tmp = join(dir, `.daemon-rpc-token.${process.pid}.${Date.now()}.tmp`)
  await writeFile(tmp, `${token}\n`, { mode: 0o600 })
  await rename(tmp, rpcTokenPath())
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
