import type { DaemonCommand, DaemonResponse } from '@bitcaster-market/daemon/protocol'
import { readRpcToken, rpcSocketPath } from '@bitcaster-market/daemon/rpcAuth'
import { execFile, spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const DAEMON_STARTUP_TIMEOUT_MS = 10_000
const DAEMON_STARTUP_POLL_MS = 100
const execFileAsync = promisify(execFile)

interface DaemonPidFile {
  pid: number
  startedAt?: string
  daemonMain?: string
}

export class DaemonNotReachableError extends Error {
  readonly address: string
  readonly hint = "Run 'bitcaster daemon init' or set BITCASTER_DAEMON_URL."

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
  if (process.env.BITCASTER_DAEMON_URL) return null
  if (process.env.BITCASTER_DAEMON_PORT) return null
  if (process.platform === 'win32') return null
  return rpcSocketPath()
}

export async function callDaemon<T = unknown>(
  command: DaemonCommand,
): Promise<DaemonResponse<T>> {
  const address = daemonAttemptAddress()
  try {
    return await sendDaemonCommand(command)
  } catch (err) {
    if (!shouldAutoStartDaemon(err)) throwDaemonConnectionError(err, address)
  }
  try {
    await startDaemonProcess()
    await waitForDaemon()
    return await sendDaemonCommand(command)
  } catch (err) {
    throwDaemonConnectionError(err, address)
  }
}

export function daemonAttemptAddress(): string {
  return daemonSocketPath() ?? daemonUrl()
}

function daemonBaseUrl(): string {
  return process.env.BITCASTER_DAEMON_URL || defaultDaemonBaseUrl()
}

function defaultDaemonBaseUrl(): string {
  return `http://127.0.0.1:${process.env.BITCASTER_DAEMON_PORT || '42871'}`
}

async function sendDaemonCommand<T = unknown>(
  command: DaemonCommand,
): Promise<DaemonResponse<T>> {
  const token = await readRpcToken()
  const socketPath = daemonSocketPath()
  if (socketPath) {
    return sendDaemonCommandOverSocket(command, socketPath, token)
  }
  const response = await fetch(daemonUrl(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(command),
  })
  return (await response.json()) as DaemonResponse<T>
}

function sendDaemonCommandOverSocket<T = unknown>(
  command: DaemonCommand,
  socketPath: string,
  token: string | null,
): Promise<DaemonResponse<T>> {
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
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })
        res.on('end', () => {
          try {
            resolve(
              JSON.parse(Buffer.concat(chunks).toString('utf8')) as DaemonResponse<T>,
            )
          } catch (err) {
            reject(err)
          }
        })
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

function shouldAutoStartDaemon(err: unknown): boolean {
  if (process.env.BITCASTER_CLI_AUTOSTART_DAEMON === '0') return false
  if (process.env.BITCASTER_DAEMON_URL) return false
  if (!isNetworkFailure(err)) return false
  const socketPath = daemonSocketPath()
  return Boolean(socketPath) || daemonBaseUrl() === defaultDaemonBaseUrl()
}

export function isNetworkFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const directCode = (err as { code?: unknown }).code
  const causeObj = (err as { cause?: unknown }).cause
  const causeCode =
    causeObj && typeof causeObj === 'object'
      ? (causeObj as { code?: unknown }).code
      : undefined
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
  const dir = daemonProfileDir()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const logFd = openSync(daemonLogPath(), 'a', 0o600)
  const daemonMain = fileURLToPath(import.meta.resolve('@bitcaster-market/daemon'))
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', daemonMain, 'run'],
    {
      detached: true,
      env: process.env,
      stdio: ['ignore', logFd, logFd],
    },
  )
  closeSync(logFd)
  if (child.pid) {
    const startedAt = await readProcessStartTime(child.pid)
    await writeFile(
      daemonPidPath(),
      `${JSON.stringify({
        pid: child.pid,
        ...(startedAt ? { startedAt } : {}),
        daemonMain,
      })}\n`,
      { mode: 0o600 },
    )
  }
  child.unref()
}

export function daemonProfileDir(): string {
  return process.env.BITCASTER_DAEMON_HOME || join(homedir(), '.bitcaster')
}

export function daemonPidPath(): string {
  return join(daemonProfileDir(), 'daemon-autostart.pid')
}

export function daemonLogPath(): string {
  return join(daemonProfileDir(), 'daemon.log')
}

export async function waitForDaemon(): Promise<void> {
  const deadline = Date.now() + DAEMON_STARTUP_TIMEOUT_MS
  let lastErr: unknown
  while (Date.now() < deadline) {
    try {
      await sendDaemonCommand({ method: 'health' })
      return
    } catch (err) {
      lastErr = err
      await sleep(DAEMON_STARTUP_POLL_MS)
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
    const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
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
    const parsed = JSON.parse(text) as { pid?: unknown; startedAt?: unknown; daemonMain?: unknown }
    if (Number.isSafeInteger(parsed.pid) && Number(parsed.pid) > 0) {
      return {
        pid: Number(parsed.pid),
        ...(typeof parsed.startedAt === 'string' ? { startedAt: parsed.startedAt } : {}),
        ...(typeof parsed.daemonMain === 'string' ? { daemonMain: parsed.daemonMain } : {}),
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
  const cmdline = await readProcessCommandLine(pidFile.pid)
  if (!cmdline) return false
  const daemonMainMatches = pidFile.daemonMain
    ? cmdline.includes(pidFile.daemonMain)
    : false
  return (
    (daemonMainMatches || cmdline.includes('@bitcaster-market/daemon')) &&
    /(?:^|\s)run(?:\s|$)/.test(cmdline)
  )
}

async function readProcessCommandLine(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      return (await readFile(`/proc/${pid}/cmdline`, 'utf8')).replace(/\0/g, ' ').trim()
    } catch {
      return null
    }
  }
  try {
    const result = await execFileAsync('ps', ['-p', String(pid), '-o', 'args='])
    return result.stdout.trim()
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
      const fieldsFrom3 = statText.slice(closeParen + 2).trim().split(/\s+/)
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
