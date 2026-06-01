import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { request } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ensureRpcToken } from '../src/rpcAuth.ts'
import { startDaemonServer } from '../src/server.ts'

test('startDaemonServer rejects non-loopback bind hosts', async () => {
  await assert.rejects(
    () => startDaemonServer({ host: '0.0.0.0', port: 0 }),
    /refuses to bind non-loopback host 0\.0\.0\.0/,
  )
})

test('startDaemonServer serves local health RPC and returns a closeable server', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-server-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  const server = await startDaemonServer({ host: '127.0.0.1', port: 0 })
  try {
    const address = server.address()
    assert.equal(typeof address, 'object')
    assert.ok(address)

    const response = await fetch(`http://127.0.0.1:${address.port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'health' }),
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      ok: true,
      result: {
        status: 'ok',
        service: 'bitcaster-daemon',
        sdk: '@bitcaster-market/client-sdk',
        state: 'missing-profile',
      },
    })
  } finally {
    server.close()
    await once(server, 'close')
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('startDaemonServer serves default Unix socket RPC on Unix', async () => {
  if (process.platform === 'win32') return

  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-server-socket-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  const previousPort = process.env.BITCASTER_DAEMON_PORT
  process.env.BITCASTER_DAEMON_HOME = home
  delete process.env.BITCASTER_DAEMON_PORT
  const server = await startDaemonServer()
  try {
    const response = await postSocketJson(join(home, 'daemon.sock'), {
      method: 'health',
    })

    assert.deepEqual(response, {
      ok: true,
      result: {
        status: 'ok',
        service: 'bitcaster-daemon',
        sdk: '@bitcaster-market/client-sdk',
        state: 'missing-profile',
      },
    })
  } finally {
    server.close()
    await once(server, 'close')
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    if (previousPort === undefined) delete process.env.BITCASTER_DAEMON_PORT
    else process.env.BITCASTER_DAEMON_PORT = previousPort
    await rm(home, { recursive: true, force: true })
  }
})

test('startDaemonServer refuses to replace a live Unix socket daemon', async () => {
  if (process.platform === 'win32') return

  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-live-socket-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  const previousPort = process.env.BITCASTER_DAEMON_PORT
  process.env.BITCASTER_DAEMON_HOME = home
  delete process.env.BITCASTER_DAEMON_PORT
  const server = await startDaemonServer()
  try {
    await assert.rejects(
      () => startDaemonServer(),
      /RPC socket is already in use/,
    )
  } finally {
    server.close()
    await once(server, 'close')
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    if (previousPort === undefined) delete process.env.BITCASTER_DAEMON_PORT
    else process.env.BITCASTER_DAEMON_PORT = previousPort
    await rm(home, { recursive: true, force: true })
  }
})

test('startDaemonServer removes stale Unix socket before restart', async () => {
  if (process.platform === 'win32') return

  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-stale-socket-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  const previousPort = process.env.BITCASTER_DAEMON_PORT
  process.env.BITCASTER_DAEMON_HOME = home
  delete process.env.BITCASTER_DAEMON_PORT
  const socketPath = join(home, 'daemon.sock')
  const stale = spawn(
    process.execPath,
    [
      '-e',
      [
        "const net = require('node:net')",
        'const server = net.createServer()',
        "server.listen(process.argv[1], () => process.stdout.write('ready\\n'))",
        'setInterval(() => {}, 1000)',
      ].join(';'),
      socketPath,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  )

  try {
    await once(stale.stdout, 'data')
    stale.kill('SIGKILL')
    await once(stale, 'exit')

    const server = await startDaemonServer()
    try {
      const response = await postSocketJson(socketPath, { method: 'health' })
      assert.equal((response as { ok?: boolean }).ok, true)
    } finally {
      server.close()
      await once(server, 'close')
    }
  } finally {
    if (!stale.killed) stale.kill('SIGKILL')
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    if (previousPort === undefined) delete process.env.BITCASTER_DAEMON_PORT
    else process.env.BITCASTER_DAEMON_PORT = previousPort
    await rm(home, { recursive: true, force: true })
  }
})

test('startDaemonServer requires initialized RPC token for non-health commands', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-server-auth-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  const token = await ensureRpcToken()
  const server = await startDaemonServer({ host: '127.0.0.1', port: 0 })
  try {
    const address = server.address()
    assert.equal(typeof address, 'object')
    assert.ok(address)
    const url = `http://127.0.0.1:${address.port}/rpc`

    const missing = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'health' }),
    })
    assert.equal(missing.status, 401)
    assert.deepEqual(await missing.json(), {
      ok: false,
      error: 'unauthorized',
    })

    const authorized = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ method: 'health' }),
    })
    assert.equal(authorized.status, 200)
    assert.equal((await authorized.json()).ok, true)
  } finally {
    server.close()
    await once(server, 'close')
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

function postSocketJson(socketPath: string, body: unknown): Promise<unknown> {
  const text = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: '/rpc',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(text),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch (err) {
            reject(err)
          }
        })
      },
    )
    req.on('error', reject)
    req.end(text)
  })
}
