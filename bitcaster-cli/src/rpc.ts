import type { DaemonCommand, DaemonResponse } from 'bitcaster-daemon/protocol'
import { readRpcToken, rpcSocketPath } from 'bitcaster-daemon/rpcAuth'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DAEMON_STARTUP_TIMEOUT_MS = 10_000
const DAEMON_STARTUP_POLL_MS = 100

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
  try {
    return await sendDaemonCommand(command)
  } catch (err) {
    if (!shouldAutoStartDaemon(err)) throw err
  }
  await startDaemonProcess()
  await waitForDaemon()
  return sendDaemonCommand(command)
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

function isNetworkFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const cause = (err as { cause?: unknown }).cause
  if (cause && typeof cause === 'object') {
    const code = (cause as { code?: unknown }).code
    if (
      code === 'ECONNREFUSED' ||
      code === 'ECONNRESET' ||
      code === 'ENOTFOUND' ||
      code === 'EHOSTUNREACH' ||
      code === 'ENOENT'
    ) {
      return true
    }
  }
  return err.name === 'TypeError' && /fetch failed/i.test(err.message)
}

async function startDaemonProcess(): Promise<void> {
  const daemonMain = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'bitcaster-daemon',
    'src',
    'main.ts',
  )
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', daemonMain, 'run'],
    {
      detached: true,
      env: process.env,
      stdio: 'ignore',
    },
  )
  if (child.pid) {
    const dir = daemonProfileDir()
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(join(dir, 'daemon-autostart.pid'), `${child.pid}\n`, {
      mode: 0o600,
    })
  }
  child.unref()
}

function daemonProfileDir(): string {
  return process.env.BITCASTER_DAEMON_HOME || join(homedir(), '.bitcaster')
}

async function waitForDaemon(): Promise<void> {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
