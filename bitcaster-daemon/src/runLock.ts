import { lstat, open, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureProfileDir, profileDir } from './profile.ts'

export interface DaemonRunLock {
  path: string
  release(): Promise<void>
}

export function runLockPath(): string {
  return join(profileDir(), 'daemon-run.lock')
}

export async function acquireDaemonRunLock(): Promise<DaemonRunLock> {
  await ensureProfileDir()
  const path = runLockPath()
  try {
    return await createLock(path)
  } catch (err) {
    if (!isFileExistsError(err)) throw err
  }

  const staleIdentity = await readPlainLockIdentity(path)
  if (staleIdentity !== null && !(await lockOwnerIsAlive(path))) {
    await unlinkIfIdentityMatches(path, staleIdentity)
    try {
      return await createLock(path)
    } catch (err) {
      if (!isFileExistsError(err)) throw err
    }
  }

  throw new Error(`bitcaster-daemon is already running for profile ${profileDir()}`)
}

async function createLock(path: string): Promise<DaemonRunLock> {
  const handle = await open(path, 'wx', 0o600)
  const metadata = await handle.stat({ bigint: true })
  const identity = { dev: metadata.dev, ino: metadata.ino }
  try {
    await handle.writeFile(
      JSON.stringify(
        {
          pid: process.pid,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + '\n',
    )
  } finally {
    await handle.close()
  }
  let released = false
  return {
    path,
    async release() {
      if (released) return
      released = true
      await unlinkIfIdentityMatches(path, identity)
    },
  }
}

async function readPlainLockIdentity(
  path: string,
): Promise<{ readonly dev: bigint; readonly ino: bigint } | null> {
  try {
    const metadata = await lstat(path, { bigint: true })
    if (!metadata.isFile() || metadata.isSymbolicLink()) return null
    return { dev: metadata.dev, ino: metadata.ino }
  } catch (error) {
    if (isNotFoundError(error)) return null
    throw error
  }
}

async function unlinkIfIdentityMatches(
  path: string,
  identity: { readonly dev: bigint; readonly ino: bigint },
): Promise<void> {
  const current = await readPlainLockIdentity(path)
  if (current !== null && current.dev === identity.dev && current.ino === identity.ino) {
    await unlink(path)
  }
}

async function lockOwnerIsAlive(path: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown }
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid)) {
      return false
    }
    if (parsed.pid <= 0) return false
    try {
      process.kill(parsed.pid, 0)
      return true
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ESRCH') {
        return false
      }
      return true
    }
  } catch (err) {
    if (isNotFoundError(err)) return false
    return true
  }
}

function isFileExistsError(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'EEXIST'
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT'
}
