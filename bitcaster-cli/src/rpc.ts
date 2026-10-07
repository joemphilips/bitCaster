import type { DaemonCommand, DaemonResponse } from '@bitcaster-market/daemon/protocol'
import {
  DAEMON_WATCH_FRAME_BYTES_MAX,
  DAEMON_WATCH_MEDIA_TYPE,
  DAEMON_WATCH_REQUEST_BYTES_MAX,
  decodeDaemonWatchFrame,
  validateDaemonWatchCommand,
  type DaemonWatchCommand,
  type DaemonWatchFrame,
} from '@bitcaster-market/daemon/protocol'
import { once } from 'node:events'
import type { Writable } from 'node:stream'
import { awaitAbortable } from '@bitcaster-market/client-sdk/engineClient'
import { readLiveRpcToken, rpcSocketPath } from '@bitcaster-market/daemon/rpcAuth'
import { dataDir } from '@bitcaster-market/daemon/dataDir'
import { execFile, spawn } from 'node:child_process'
import { closeSync, constants, openSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { request, type IncomingMessage } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { cliHomeDir } from './paths.ts'

const DAEMON_STARTUP_TIMEOUT_MS = 10_000
const DAEMON_STARTUP_POLL_MS = 100
const TEST_DAEMON_URL = Symbol.for('bitcaster.test.daemon-url')
const execFileAsync = promisify(execFile)
let rpcTokenPromise: Promise<string | null> | undefined

interface DaemonPidFile {
  pid: number
  startedAt?: string
  daemonMain?: string
  dataDir?: string
}

export class DaemonNotReachableError extends Error {
  readonly address: string
  readonly hint = "Run 'bitcaster daemon init' and verify the selected --datadir."

  constructor(address: string, options?: { cause?: unknown }) {
    super(`daemon not reachable at ${address}`, options)
    this.name = 'DaemonNotReachableError'
    this.address = address
  }
}

export function daemonUrl(): string {
  const base = daemonBaseUrl()
  return `${base.replace(/\/+$/, '')}/rpc`
}

export function daemonSocketPath(): string | null {
  if (injectedDaemonBaseUrl() !== undefined) return null
  if (process.platform === 'win32') return null
  return rpcSocketPath()
}

export async function callDaemon<T = unknown>(
  command: DaemonCommand,
  options: { signal?: AbortSignal } = {},
): Promise<DaemonResponse<T>> {
  const signal = options.signal
  signal?.throwIfAborted()
  const address = daemonAttemptAddress()
  try {
    return await sendDaemonCommand(command, signal)
  } catch (err) {
    if (signal?.aborted) throw signal.reason ?? err
    if (!shouldAutoStartDaemon(err)) throwDaemonConnectionError(err, address)
  }
  try {
    signal?.throwIfAborted()
    await startDaemonProcess()
    await waitForDaemon(signal)
    return await sendDaemonCommand(command, signal)
  } catch (err) {
    if (signal?.aborted) throw signal.reason ?? err
    throwDaemonConnectionError(err, address)
  }
}

/** No reconnect replay is implied. Product watches must refresh their snapshot. */
export async function* watchDaemon(
  command: DaemonWatchCommand,
  options: { signal?: AbortSignal } = {},
): AsyncGenerator<DaemonWatchFrame> {
  const controller = new AbortController()
  const signal =
    options.signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, options.signal])
  signal.throwIfAborted()
  const exact = validateDaemonWatchCommand(command)
  const body = JSON.stringify(exact)
  if (Buffer.byteLength(body) > DAEMON_WATCH_REQUEST_BYTES_MAX)
    throw new Error('daemon watch request exceeds byte limit')
  let stream: WatchResponse | undefined
  try {
    try {
      stream = await openDaemonWatch(body, signal)
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error
      if (!shouldAutoStartDaemon(error)) throwDaemonConnectionError(error, daemonAttemptAddress())
      await startDaemonProcess()
      await waitForDaemon(signal)
      stream = await openDaemonWatch(body, signal)
    }
    yield* readDaemonWatchFrames(stream.chunks)
  } finally {
    controller.abort()
    await stream?.close()
  }
}

export async function writeDaemonWatchFrames(
  frames: AsyncIterable<DaemonWatchFrame>,
  output: Writable = process.stdout,
  options: { signal?: AbortSignal } = {},
): Promise<'complete' | 'error'> {
  const controller = new AbortController()
  const signal =
    options.signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, options.signal])
  const close = () => controller.abort()
  output.once('close', close)
  output.once('error', close)
  const iterator = frames[Symbol.asyncIterator]()
  let result: 'complete' | 'error' = 'complete'
  try {
    while (true) {
      signal.throwIfAborted()
      const next = await awaitAbortable(Promise.resolve(iterator.next()), signal)
      if (next.done) return result
      const frame = next.value
      if (output.destroyed) throw new Error('daemon watch output is closed')
      const line = JSON.stringify(frame) + '\n'
      if (Buffer.byteLength(line) > DAEMON_WATCH_FRAME_BYTES_MAX)
        throw new Error('daemon watch frame exceeds byte limit')
      if (!output.write(line)) await once(output, 'drain', { signal })
      if (frame.type === 'error') result = 'error'
    }
  } finally {
    const cancelled = signal.aborted
    controller.abort()
    output.removeListener('close', close)
    output.removeListener('error', close)
    try {
      const returned = iterator.return?.()
      if (cancelled) void returned?.catch(() => undefined)
      else await returned
    } catch {
      /* Cleanup errors must not replace the original transport result. */
    }
  }
}

export async function watchDaemonToOutput(
  command: DaemonWatchCommand,
  output: Writable = process.stdout,
  options: { signal?: AbortSignal } = {},
): Promise<'complete' | 'error'> {
  const controller = new AbortController()
  const signal =
    options.signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, options.signal])
  const close = () => controller.abort()
  output.once('close', close)
  output.once('error', close)
  try {
    return await writeDaemonWatchFrames(watchDaemon(command, { signal }), output, { signal })
  } finally {
    controller.abort()
    output.removeListener('close', close)
    output.removeListener('error', close)
  }
}

interface WatchResponse {
  chunks: AsyncIterable<Uint8Array>
  close(): Promise<void>
}

async function openDaemonWatch(body: string, signal: AbortSignal): Promise<WatchResponse> {
  signal.throwIfAborted()
  const token = await readDaemonRpcToken()
  signal.throwIfAborted()
  const socketPath = daemonSocketPath()
  const headers = {
    'content-type': 'application/json',
    accept: DAEMON_WATCH_MEDIA_TYPE,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }
  if (socketPath !== null) return openDaemonWatchOverSocket(body, socketPath, headers, signal)
  const response = await fetch(daemonUrl(), { method: 'POST', headers, body, signal })
  if (
    !response.ok ||
    response.headers.get('content-type')?.split(';')[0] !== DAEMON_WATCH_MEDIA_TYPE ||
    response.body === null
  ) {
    await response.body?.cancel()
    throw new Error('daemon watch response was refused')
  }
  const reader = response.body.getReader()
  return {
    chunks: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          const next = await awaitAbortable(reader.read(), signal)
          if (next.done) return
          yield next.value
        }
      },
    },
    close: async () => {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    },
  }
}

function openDaemonWatchOverSocket(
  body: string,
  socketPath: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<WatchResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: '/rpc',
        method: 'POST',
        signal,
        headers: { ...headers, 'content-length': Buffer.byteLength(body) },
      },
      (response) => {
        if (
          response.statusCode !== 200 ||
          response.headers['content-type']?.split(';')[0] !== DAEMON_WATCH_MEDIA_TYPE
        ) {
          response.destroy()
          req.destroy()
          reject(new Error('daemon watch response was refused'))
          return
        }
        resolve({
          chunks: response,
          close: async () => {
            response.destroy()
            req.destroy()
          },
        })
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

/** Accumulate one bounded byte line, not decoded chunks or an event queue. */
export async function* readDaemonWatchFrames(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<DaemonWatchFrame> {
  let line = Buffer.alloc(0)
  let bytes = 0
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const append = (segment: Uint8Array) => {
    const required = bytes + segment.byteLength
    if (required >= DAEMON_WATCH_FRAME_BYTES_MAX)
      throw new Error('daemon watch frame exceeds byte limit')
    if (required > line.byteLength) {
      const grown = Buffer.allocUnsafe(
        Math.min(DAEMON_WATCH_FRAME_BYTES_MAX - 1, Math.max(required, line.byteLength * 2, 8192)),
      )
      line.copy(grown, 0, 0, bytes)
      line = grown
    }
    line.set(segment, bytes)
    bytes = required
  }
  try {
    for await (const chunk of chunks) {
      if (!(chunk instanceof Uint8Array)) throw new Error('invalid daemon watch bytes')
      let start = 0
      let end = chunk.indexOf(10, start)
      while (end !== -1) {
        append(chunk.subarray(start, end))
        let frame: DaemonWatchFrame
        try {
          frame = decodeDaemonWatchFrame(JSON.parse(decoder.decode(line.subarray(0, bytes))))
        } catch {
          throw new Error('invalid daemon watch frame')
        }
        bytes = 0
        yield frame
        if (frame.type === 'complete' || frame.type === 'error') return
        start = end + 1
        end = chunk.indexOf(10, start)
      }
      append(chunk.subarray(start))
    }
    throw new Error('daemon watch ended without a terminal frame')
  } finally {
    line = Buffer.alloc(0)
  }
}

export function daemonAttemptAddress(): string {
  return daemonSocketPath() ?? daemonUrl()
}

function daemonBaseUrl(): string {
  return injectedDaemonBaseUrl() ?? defaultDaemonBaseUrl()
}

function defaultDaemonBaseUrl(): string {
  return 'http://127.0.0.1:42871'
}

function injectedDaemonBaseUrl(): string | undefined {
  const value = (globalThis as Record<symbol, unknown>)[TEST_DAEMON_URL]
  return typeof value === 'string' ? value : undefined
}

async function sendDaemonCommand<T = unknown>(
  command: DaemonCommand,
  signal?: AbortSignal,
): Promise<DaemonResponse<T>> {
  signal?.throwIfAborted()
  const token = await readDaemonRpcToken()
  signal?.throwIfAborted()
  const socketPath = daemonSocketPath()
  if (socketPath) {
    return sendDaemonCommandOverSocket(command, socketPath, token, signal)
  }
  const response = await fetch(daemonUrl(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(command),
    ...(signal === undefined ? {} : { signal }),
  })
  return (await response.json()) as DaemonResponse<T>
}

function readDaemonRpcToken(): Promise<string | null> {
  rpcTokenPromise ??= readLiveRpcToken()
  return rpcTokenPromise
}

function sendDaemonCommandOverSocket<T = unknown>(
  command: DaemonCommand,
  socketPath: string,
  token: string | null,
  signal?: AbortSignal,
): Promise<DaemonResponse<T>> {
  signal?.throwIfAborted()
  const body = JSON.stringify(command)
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: '/rpc',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(signal === undefined ? {} : { signal }),
      },
      (res) => void readDaemonRpcResponse<T>(res).then(resolve, reject),
    )
    req.on('error', reject)
    req.end(body)
  })
}

export function readDaemonRpcResponse<T = unknown>(
  response: IncomingMessage,
): Promise<DaemonResponse<T>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    response.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    response.on('aborted', () => reject(new Error('daemon RPC response was aborted')))
    response.on('error', reject)
    response.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as DaemonResponse<T>)
      } catch (err) {
        reject(err)
      }
    })
  })
}

function shouldAutoStartDaemon(err: unknown): boolean {
  if (injectedDaemonBaseUrl() !== undefined) return false
  if (!isNetworkFailure(err)) return false
  const socketPath = daemonSocketPath()
  return Boolean(socketPath) || daemonBaseUrl() === defaultDaemonBaseUrl()
}

export function isNetworkFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const directCode = (err as { code?: unknown }).code
  const causeObj = (err as { cause?: unknown }).cause
  const causeCode =
    causeObj && typeof causeObj === 'object' ? (causeObj as { code?: unknown }).code : undefined
  const code = directCode ?? causeCode
  if (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ENOTFOUND' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENOENT' ||
    code === 'ETIMEDOUT' ||
    code === 'ENETUNREACH' ||
    code === 'EAI_AGAIN' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  ) {
    return true
  }
  return err.name === 'TypeError' && /fetch failed|network/i.test(err.message)
}

function throwDaemonConnectionError(err: unknown, address: string): never {
  if (err instanceof DaemonNotReachableError) throw err
  if (isNetworkFailure(err)) {
    throw new DaemonNotReachableError(address, { cause: err })
  }
  throw err
}

export async function startDaemonProcess(): Promise<void> {
  const dir = cliHomeDir()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const logFd = openSync(
    daemonLogPath(),
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o600,
  )
  const daemonMain = fileURLToPath(import.meta.resolve('@bitcaster-market/daemon'))
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', daemonMain, `--datadir=${dataDir()}`, 'run'],
    {
      detached: true,
      env: process.env,
      stdio: ['ignore', logFd, logFd],
    },
  )
  closeSync(logFd)
  if (child.pid) {
    const startedAt = await readProcessStartTime(child.pid)
    const pidPath = daemonPidPath()
    const tempPidPath = `${pidPath}.${process.pid}.${child.pid}.tmp`
    await writeFile(
      tempPidPath,
      `${JSON.stringify({
        pid: child.pid,
        ...(startedAt ? { startedAt } : {}),
        daemonMain,
        dataDir: dataDir(),
      })}\n`,
      { mode: 0o600, flag: 'wx' },
    )
    try {
      await rename(tempPidPath, pidPath)
    } catch (error) {
      await rm(tempPidPath, { force: true })
      throw error
    }
  }
  child.unref()
}

export function daemonPidPath(): string {
  return join(cliHomeDir(), 'daemon-autostart.pid')
}

export function daemonLogPath(): string {
  return join(cliHomeDir(), 'daemon.log')
}

export async function waitForDaemon(signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + DAEMON_STARTUP_TIMEOUT_MS
  let lastErr: unknown
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    try {
      await sendDaemonCommand({ method: 'health' }, signal)
      return
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err
      lastErr = err
      await sleepWithSignal(
        Math.min(DAEMON_STARTUP_POLL_MS, Math.max(0, deadline - Date.now())),
        signal,
      )
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error('timed out waiting for bitcaster-daemon to start')
}

export async function isCliSpawnedDaemonRunning(): Promise<boolean> {
  const pidFile = await readDaemonPidFile()
  if (!pidFile) return false
  if (!isProcessAlive(pidFile.pid)) return false
  if (!(await pidStartTimeMatches(pidFile))) return false
  return isBitcasterDaemonProcess(pidFile)
}

export async function stopDaemon(): Promise<{ stopped: boolean; message: string }> {
  const pidFile = await readDaemonPidFile()
  if (!pidFile) {
    return { stopped: false, message: 'daemon is not running' }
  }
  if (!isProcessAlive(pidFile.pid)) {
    await removePidFile()
    return { stopped: false, message: 'daemon is not running' }
  }
  if (!(await pidStartTimeMatches(pidFile))) {
    throw new Error(`PID ${pidFile.pid} no longer belongs to bitcaster-daemon (possible PID reuse)`)
  }
  if (!(await isBitcasterDaemonProcess(pidFile))) {
    return { stopped: false, message: 'daemon is not running' }
  }

  try {
    process.kill(pidFile.pid, 'SIGTERM')
  } catch (err) {
    const code =
      typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
    if (code === 'ESRCH') {
      await removePidFile()
      return { stopped: false, message: 'daemon is not running' }
    }
    if (code === 'EPERM') {
      throw new Error(`cannot stop daemon pid ${pidFile.pid}: permission denied`)
    }
    throw err
  }
  await waitForProcessExit(pidFile.pid)
  await removePidFile()
  return { stopped: true, message: 'daemon stopped' }
}

export async function restartDaemon(): Promise<void> {
  const address = daemonAttemptAddress()
  try {
    await stopDaemon()
    await startDaemonProcess()
    await waitForDaemon()
  } catch (err) {
    throwDaemonConnectionError(err, address)
  }
}

async function readDaemonPidFile(): Promise<DaemonPidFile | null> {
  let text: string
  try {
    text = (await readFile(daemonPidPath(), 'utf8')).trim()
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT') {
      return null
    }
    throw err
  }
  if (!text) return null
  const numericPid = Number(text)
  if (Number.isSafeInteger(numericPid) && numericPid > 0) {
    return { pid: numericPid }
  }
  try {
    const parsed = JSON.parse(text) as {
      pid?: unknown
      startedAt?: unknown
      daemonMain?: unknown
      dataDir?: unknown
    }
    if (Number.isSafeInteger(parsed.pid) && Number(parsed.pid) > 0) {
      return {
        pid: Number(parsed.pid),
        ...(typeof parsed.startedAt === 'string' ? { startedAt: parsed.startedAt } : {}),
        ...(typeof parsed.daemonMain === 'string' ? { daemonMain: parsed.daemonMain } : {}),
        ...(typeof parsed.dataDir === 'string' ? { dataDir: parsed.dataDir } : {}),
      }
    }
  } catch {
    // Fall through to treating an invalid pid file as not running.
  }
  return null
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'EPERM') {
      return true
    }
    return false
  }
}

async function pidStartTimeMatches(pidFile: DaemonPidFile): Promise<boolean> {
  if (!pidFile.startedAt) return true
  const actualStartedAt = await readProcessStartTime(pidFile.pid)
  return actualStartedAt === pidFile.startedAt
}

async function isBitcasterDaemonProcess(pidFile: DaemonPidFile): Promise<boolean> {
  if (pidFile.dataDir !== dataDir()) return false
  const args = await readProcessArguments(pidFile.pid)
  if (!args) return false
  const daemonMainMatches = pidFile.daemonMain ? args.includes(pidFile.daemonMain) : false
  return (
    (daemonMainMatches || args.some((arg) => arg.includes('@bitcaster-market/daemon'))) &&
    args.includes(`--datadir=${pidFile.dataDir}`) &&
    args.includes('run')
  )
}

async function readProcessArguments(pid: number): Promise<string[] | null> {
  if (process.platform === 'linux') {
    try {
      return (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean)
    } catch {
      return null
    }
  }
  try {
    const result = await execFileAsync('ps', ['-p', String(pid), '-o', 'args='])
    return result.stdout.trim().split(/\s+/).filter(Boolean)
  } catch {
    return null
  }
}

async function readProcessStartTime(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      const statText = await readFile(`/proc/${pid}/stat`, 'utf8')
      const closeParen = statText.lastIndexOf(')')
      if (closeParen === -1) return null
      const fieldsFrom3 = statText
        .slice(closeParen + 2)
        .trim()
        .split(/\s+/)
      return fieldsFrom3[19] ?? null
    } catch {
      return null
    }
  }
  try {
    const result = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart='])
    return result.stdout.trim() || null
  } catch {
    return null
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const timeoutMs = 5_000
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return
    await sleep(100)
  }
  if (isProcessAlive(pid)) {
    throw new Error(`daemon did not exit within ${timeoutMs}ms after SIGTERM`)
  }
}

async function removePidFile(): Promise<void> {
  await rm(daemonPidPath(), { force: true })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return sleep(ms)
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason ?? new Error('daemon wait aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}
