import { open, readFile, unlink } from 'node:fs/promises'
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

  if (!(await lockOwnerIsAlive(path))) {
    await unlink(path).catch((err: unknown) => {
      if (!isNotFoundError(err)) throw err
    })
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
      await unlink(path).catch((err: unknown) => {
        if (!isNotFoundError(err)) throw err
      })
    },
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
