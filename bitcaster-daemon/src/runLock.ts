import { randomUUID } from 'node:crypto'
import {
  mkdir,
  open,
  readFile,
  readdir,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises'
import { join } from 'node:path'
import { ensureProfileDir, profileDir } from './profile.ts'

export interface DaemonRunLock {
  path: string
  assertHeld(): Promise<void>
  release(): Promise<void>
}

const heldRunLocks = new WeakSet<DaemonRunLock>()

export async function assertDaemonRunLockHeld(
  lock: DaemonRunLock,
): Promise<void> {
  if (!heldRunLocks.has(lock)) {
    throw new Error('daemon profile run lock is not held')
  }
  await lock.assertHeld()
}

export function runLockPath(): string {
  return join(profileDir(), 'daemon-run.lock')
}

export async function acquireDaemonRunLock(): Promise<DaemonRunLock> {
  await ensureProfileDir()
  const path = runLockPath()
  await ensureClaimDirectory(path)
  return createClaim(path)
}

async function ensureClaimDirectory(path: string): Promise<void> {
  for (;;) {
    try {
      await mkdir(path, { mode: 0o700 })
      return
    } catch (err) {
      if (!isFileExistsError(err)) throw err
    }
    const existing = await stat(path).catch((err: unknown) => {
      if (isNotFoundError(err)) return undefined
      throw err
    })
    if (existing === undefined) continue
    if (existing.isDirectory()) return
    if (!existing.isFile() || (await lockOwnerIsAlive(path))) {
      throw alreadyRunningError()
    }
    await unlink(path).catch((err: unknown) => {
      if (!isNotFoundError(err) && !isDirectoryError(err)) throw err
    })
  }
}

async function createClaim(path: string): Promise<DaemonRunLock> {
  const claimId = `${process.pid}-${randomUUID()}.json`
  const claimPath = join(path, claimId)
  const claimNonce = randomUUID()
  const handle = await open(claimPath, 'wx', 0o600)
  try {
    await handle.writeFile(
      JSON.stringify(
        {
          pid: process.pid,
          startedAt: new Date().toISOString(),
          nonce: claimNonce,
        },
        null,
        2,
      ) + '\n',
    )
  } finally {
    await handle.close()
  }
  try {
    await rejectLiveCompetingClaims(path, claimId)
  } catch (error) {
    await unlink(claimPath).catch((err: unknown) => {
      if (!isNotFoundError(err)) throw err
    })
    await removeEmptyClaimDirectory(path)
    throw error
  }
  let released = false
  const lock: DaemonRunLock = {
    path,
    async assertHeld() {
      if (released || !heldRunLocks.has(lock)) {
        throw new Error('daemon profile run lock is not held')
      }
      let record: Awaited<ReturnType<typeof readClaimRecord>>
      try {
        record = await readClaimRecord(claimPath)
      } catch {
        heldRunLocks.delete(lock)
        throw new Error('daemon profile run lock is not held')
      }
      if (record?.nonce !== claimNonce) {
        heldRunLocks.delete(lock)
        throw new Error('daemon profile run lock is not held')
      }
    },
    async release() {
      if (released) return
      released = true
      heldRunLocks.delete(lock)
      const record = await readClaimRecord(claimPath)
      if (record !== null && record.nonce !== claimNonce) {
        throw new Error('daemon profile run lock ownership changed')
      }
      await unlink(claimPath).catch((err: unknown) => {
        if (!isNotFoundError(err)) throw err
      })
      await removeEmptyClaimDirectory(path)
    },
  }
  heldRunLocks.add(lock)
  return lock
}

async function rejectLiveCompetingClaims(
  path: string,
  ownClaimId: string,
): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === ownClaimId) continue
    if (!entry.isFile()) throw alreadyRunningError()
    const competitorPath = join(path, entry.name)
    if (await lockOwnerIsAlive(competitorPath)) throw alreadyRunningError()
    await unlink(competitorPath).catch((err: unknown) => {
      if (!isNotFoundError(err)) throw err
    })
  }
  const remaining = (await readdir(path)).filter((entry) => entry !== ownClaimId)
  if (remaining.length > 0) throw alreadyRunningError()
}

async function removeEmptyClaimDirectory(path: string): Promise<void> {
  await rmdir(path).catch((err: unknown) => {
    if (!isNotFoundError(err) && !isDirectoryNotEmptyError(err)) throw err
  })
}

async function readClaimRecord(
  path: string,
): Promise<{ pid?: unknown; nonce?: unknown } | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as {
      pid?: unknown
      nonce?: unknown
    }
  } catch (err) {
    if (isNotFoundError(err)) return null
    throw err
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

function isDirectoryError(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'EISDIR'
}

function isDirectoryNotEmptyError(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOTEMPTY'
}

function alreadyRunningError(): Error {
  return new Error(`bitcaster-daemon is already running for profile ${profileDir()}`)
}
