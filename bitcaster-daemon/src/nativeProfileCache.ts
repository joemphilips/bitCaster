import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import type { Event } from 'nostr-tools/pure'
import {
  compareNostrProfileEvents,
  decodeNostrProfileEditEvent,
  MAX_NOSTR_PROFILE_EVENT_BYTES,
} from '@bitcaster-market/client-sdk'
import { profileDir } from './profile.ts'
import { NOSTR_PROFILE_CACHE_DIRECTORY, validateDaemonProfileSchema } from './profileSchema.ts'
import { getFinalProfileSchemaManifest } from './profileSchemaManifest.ts'

export interface NativeProfileEditSession {
  read(): Promise<Event | null>
  retain(event: Event): Promise<void>
}

interface ProfileCacheOptions {
  readonly directory?: string
  readonly signal?: AbortSignal
  readonly lockTimeoutMs?: number
}

function assertKey(publicKey: string): void {
  if (!/^[0-9a-f]{64}$/.test(publicKey)) throw new Error('Nostr profile public key is invalid.')
}

function assertOwnerOnly(stat: Stats, directory: boolean): void {
  if (
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    stat.isSymbolicLink() ||
    typeof process.getuid !== 'function' ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
    (!directory && stat.nlink !== 1)
  )
    throw new Error('Nostr profile cache ownership or permissions are invalid.')
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

async function cacheDirectory(directory: string): Promise<string> {
  await validateDaemonProfileSchema(directory, getFinalProfileSchemaManifest())
  const cache = join(directory, NOSTR_PROFILE_CACHE_DIRECTORY)
  try {
    await mkdir(cache, { mode: 0o700 })
  } catch (error) {
    if (!isCode(error, 'EEXIST')) throw error
  }
  assertOwnerOnly(await lstat(cache), true)
  await syncDirectory(directory)
  return cache
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function readRecord(path: string, publicKey: string): Promise<Event | null> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (isCode(error, 'ENOENT')) return null
    throw error
  }
  try {
    const stat = await handle.stat()
    assertOwnerOnly(stat, false)
    if (stat.size > MAX_NOSTR_PROFILE_EVENT_BYTES)
      throw new Error('Nostr profile cache record is too large.')
    const buffer = Buffer.alloc(MAX_NOSTR_PROFILE_EVENT_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, null)
      if (result.bytesRead === 0) break
      length += result.bytesRead
    }
    if (length > MAX_NOSTR_PROFILE_EVENT_BYTES)
      throw new Error('Nostr profile cache record is too large.')
    let value: unknown
    try {
      value = JSON.parse(buffer.subarray(0, length).toString('utf8'))
    } catch {
      throw new Error('Nostr profile cache record is invalid.')
    }
    const event = decodeNostrProfileEditEvent(value, publicKey)
    if (!event) throw new Error('Nostr profile cache record is invalid.')
    return event
  } finally {
    await handle.close()
  }
}

async function retainRecord(cache: string, publicKey: string, value: Event): Promise<void> {
  const event = decodeNostrProfileEditEvent(value, publicKey)
  if (!event) throw new Error('Nostr profile cache record is invalid.')
  const path = join(cache, `${publicKey}.json`)
  const previous = await readRecord(path, publicKey)
  if (previous && compareNostrProfileEvents(previous, event) >= 0) return
  // One temporary path per locked identity bounds leftovers after repeated crashes.
  const temporary = join(cache, `${publicKey}.tmp`)
  try {
    assertOwnerOnly(await lstat(temporary), false)
    await unlink(temporary)
  } catch (error) {
    if (!isCode(error, 'ENOENT')) throw error
  }
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(event), 'utf8')
    await handle.sync()
    await handle.close()
    await rename(temporary, path)
    await syncDirectory(cache)
  } finally {
    await handle.close()
    await unlink(temporary).catch((error: unknown) => {
      if (!isCode(error, 'ENOENT')) throw error
    })
  }
}

async function openLock(path: string): Promise<DatabaseSync> {
  try {
    const created = await open(path, 'wx', 0o600)
    await created.close()
  } catch (error) {
    if (!isCode(error, 'EEXIST')) throw error
  }
  assertOwnerOnly(await lstat(path), false)
  const database = new DatabaseSync(path, { allowExtension: false })
  database.exec('PRAGMA busy_timeout = 0')
  return database
}

async function acquireLock(database: DatabaseSync, options: ProfileCacheOptions): Promise<void> {
  const timeoutMs = options.lockTimeoutMs ?? 15_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000)
    throw new Error('Nostr profile lock timeout is invalid.')
  const deadline = performance.now() + timeoutMs
  for (;;) {
    options.signal?.throwIfAborted()
    try {
      database.exec('BEGIN IMMEDIATE')
      return
    } catch (error) {
      if (!(error instanceof Error && 'errcode' in error && error.errcode === 5)) throw error
    }
    if (performance.now() >= deadline)
      throw new Error('Another Nostr profile edit is in progress. Retry after it completes.')
    await delay(Math.min(25, Math.max(1, deadline - performance.now())), undefined, {
      signal: options.signal,
    })
  }
}

/** Hold this independent public-profile lock through reads, signing, ACKs, and retention. */
export async function withNativeProfileEditSession<T>(
  publicKey: string,
  action: (session: NativeProfileEditSession) => Promise<T>,
  options: ProfileCacheOptions = {},
): Promise<T> {
  assertKey(publicKey)
  const cache = await cacheDirectory(options.directory ?? profileDir())
  const database = await openLock(join(cache, `${publicKey}.lock.sqlite`))
  try {
    await acquireLock(database, options)
    return await action({
      read: () => readRecord(join(cache, `${publicKey}.json`), publicKey),
      retain: (event) => retainRecord(cache, publicKey, event),
    })
  } finally {
    // Closing releases the OS lock, including when a callback fails. Never unlink
    // the lock inode: another process can already be waiting on that same file.
    database.close()
  }
}
