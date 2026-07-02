import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { ensureRpcToken } from '@bitcaster-market/daemon/rpcAuth'
import { isNetworkFailure } from '../src/rpc.ts'

const execFileAsync = promisify(execFile)

test('bitcaster-cli bin entrypoint is directly executable', async () => {
  const result = await execFileAsync(
    join(import.meta.dirname, '..', 'src', 'main.ts'),
    ['--help'],
    { env: process.env },
  )

  assert.match(result.stdout, /bitcaster-cli/)
  assert.match(result.stdout, /Commands:/)
  assert.match(result.stdout, /wallet\s+Manage wallet balance/)
  assert.doesNotMatch(result.stdout, /bitcaster-cli trade recover/)
})

test('bitcaster-cli command help includes usage and subcommand summaries', async () => {
  const result = await execFileAsync(
    join(import.meta.dirname, '..', 'src', 'main.ts'),
    ['wallet', '--help'],
    { env: process.env },
  )

  assert.match(result.stdout, /bitcaster-cli wallet/)
  assert.match(result.stdout, /Usage:/)
  assert.match(result.stdout, /wallet balance/)
  assert.match(result.stdout, /Commands:/)
  assert.match(result.stdout, /receive(?: \[options\])? <token>\s+Import a Cashu token/)
})

test('bitcaster-cli completion reports that shell completion is a stub', async () => {
  const result = await execFileAsync(
    join(import.meta.dirname, '..', 'src', 'main.ts'),
    ['completion'],
    { env: process.env },
  )

  assert.match(result.stdout, /not yet implemented/i)
})

test('bitcaster-cli delegates commands to bitcaster-daemon RPC', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-rpc-auth-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  const token = await ensureRpcToken()
  const received: unknown[] = []
  const authorizationHeaders: Array<string | undefined> = []
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/rpc') {
      writeJson(res, 404, { ok: false, error: 'not found' })
      return
    }
    authorizationHeaders.push(req.headers.authorization)
    const command = JSON.parse(await readBody(req)) as { method: string }
    received.push(command)
    writeJson(res, 200, { ok: true, result: { method: command.method } })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.equal(typeof address, 'object')
  assert.ok(address)
  const daemonUrl = `http://127.0.0.1:${address.port}`

  try {
    await runCli(daemonUrl, ['health'])
    await runCli(daemonUrl, ['daemon', 'status'])
    await runCli(daemonUrl, [
      'daemon',
      'config',
      '--engine-url',
      'http://engine.example',
      '--mint-url',
      'https://mint.example',
    ])
    await runCli(daemonUrl, [
      'market',
      'list',
      '--search',
      'weather',
      '--limit',
      '5',
      '--state',
      'All',
    ])
    await runCli(daemonUrl, ['market', 'show', 'condition-1'])
    await runCli(daemonUrl, [
      'wallet',
      'balance',
    ])
    await runCli(daemonUrl, [
      'wallet',
      'receive',
      'cashuBoGZha2U=',
    ])
    await runCli(daemonUrl, [
      'wallet',
      'receive',
      'cashuOutcomeToken=',
      '--condition-id',
      'cond',
      '--outcome-set',
      'YES',
    ])
    await runCli(daemonUrl, [
      'wallet',
      'send',
      '25',
      '--mint',
      'mint-a',
      '--operation-id',
      'wallet-send-1',
    ])
    await runCli(daemonUrl, [
      'wallet',
      'operations',
      '--kind',
      'wallet-send',
      '--state',
      'prepared',
    ])
    await runCli(daemonUrl, [
      'wallet',
      'recover',
    ])
    await runCli(daemonUrl, [
      'wallet',
      'consolidate',
      'cond-YES',
      '--strategy',
      'sweep',
    ])
    await runCli(daemonUrl, [
      'order',
      'submit',
      '--market',
      'cond-YES',
      '--outcome',
      'YES',
      '--side',
      'Buy',
      '--price',
      '42',
      '--amount',
      '100',
      '--tif',
      'FAK',
    ])
    await runCli(daemonUrl, [
      'order',
      'submit',
      '--market',
      'cond-NO',
      '--outcome',
      'NO',
      '--side',
      'Buy',
      '--price',
      '55',
      '--amount',
      '200',
      '--tif',
      'GTC',
      '--no-preflight-split',
    ])
    await runCli(daemonUrl, [
      'order',
      'submit',
      '--market',
      'cond-A',
      '--outcome',
      'A',
      '--side',
      'Buy',
      '--price',
      '60',
      '--amount',
      '100',
      '--tif',
      'FAK',
      '--token-side',
      'Complement',
    ])
    await runCli(daemonUrl, ['order', 'status', 'cond-YES', 'order-1'])
    await runCli(daemonUrl, [
      'order',
      'list',
      '--market',
      'cond-YES',
      '--status',
      'resting',
    ])
    await runCli(daemonUrl, ['order', 'cancel', 'cond-YES', 'order-1'])
    await runCli(daemonUrl, ['order', 'book', 'cond-YES'])
    await runCli(daemonUrl, [
      'trade',
      'list',
      '--market',
      'cond-YES',
      '--order',
      'order-1',
      '--step',
      'seller-opened',
    ])
    await runCli(daemonUrl, ['trade', 'recover'])
    await runCli(daemonUrl, ['trade', 'watch', 'trade-1'])

    assert.deepEqual(received, [
      { method: 'health' },
      { method: 'daemon.status' },
      {
        method: 'daemon.config',
        params: {
          engineUrl: 'http://engine.example',
          mintUrl: 'https://mint.example',
        },
      },
      {
        method: 'markets.query',
        params: { search: 'weather', limit: 5, state: 'All' },
      },
      {
        method: 'markets.show',
        params: { conditionId: 'condition-1' },
      },
      { method: 'wallet.balance' },
      {
        method: 'wallet.receive',
        params: { token: 'cashuBoGZha2U=' },
      },
      {
        method: 'wallet.receive',
        params: {
          token: 'cashuOutcomeToken=',
          conditionId: 'cond',
          outcomeSetId: 'YES',
        },
      },
      {
        method: 'wallet.send',
        params: { amountSats: 25, mintUrl: 'mint-a', operationId: 'wallet-send-1' },
      },
      {
        method: 'wallet.operations',
        params: { kind: 'wallet-send', state: 'prepared' },
      },
      { method: 'wallet.recover' },
      {
        method: 'wallet.consolidateMarket',
        params: { marketId: 'cond-YES', type: 't2' },
      },
      {
        method: 'order.submit',
        params: {
          marketId: 'cond-YES',
          outcomeId: 'YES',
          tokenSide: 'Outcome',
          side: 'Buy',
          price: 42,
          amountSats: 100,
          timeInForce: 'FAK',
          preflightSplit: true,
        },
      },
      {
        method: 'order.submit',
        params: {
          marketId: 'cond-NO',
          outcomeId: 'NO',
          tokenSide: 'Outcome',
          side: 'Buy',
          price: 55,
          amountSats: 200,
          timeInForce: 'GTC',
          preflightSplit: false,
        },
      },
      {
        method: 'order.submit',
        params: {
          marketId: 'cond-A',
          outcomeId: 'A',
          tokenSide: 'Complement',
          side: 'Buy',
          price: 60,
          amountSats: 100,
          timeInForce: 'FAK',
          preflightSplit: true,
        },
      },
      {
        method: 'order.status',
        params: { marketId: 'cond-YES', orderId: 'order-1' },
      },
      {
        method: 'order.list',
        params: { marketId: 'cond-YES', status: 'resting' },
      },
      {
        method: 'order.cancel',
        params: { marketId: 'cond-YES', orderId: 'order-1' },
      },
      {
        method: 'order.book',
        params: { marketId: 'cond-YES' },
      },
      {
        method: 'trade.list',
        params: {
          marketId: 'cond-YES',
          orderId: 'order-1',
          step: 'seller-opened',
        },
      },
      { method: 'trade.recover' },
      {
        method: 'trade.watch',
        params: { tradeId: 'trade-1' },
      },
    ])
    assert.deepEqual(
      authorizationHeaders,
      Array.from({ length: received.length }, () => `Bearer ${token}`),
    )
  } finally {
    server.close()
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli exits non-zero when daemon returns ok false', async () => {
  const server = createServer(async (_req, res) => {
    writeJson(res, 200, { ok: false, error: 'daemon rejected command' })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.equal(typeof address, 'object')
  assert.ok(address)

  try {
    await assert.rejects(
      () => runCli(`http://127.0.0.1:${address.port}`, ['health']),
      (err: unknown) => {
        assert.equal((err as { code?: unknown }).code, 1)
        const stdout = (err as { stdout?: string }).stdout ?? ''
        assert.deepEqual(JSON.parse(stdout), {
          ok: false,
          error: 'daemon rejected command',
        })
        return true
      },
    )
  } finally {
    server.close()
  }
})

test('bitcaster-cli consolidate treats no-gain as a warning exit', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-consolidate-nogain-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  await ensureRpcToken()
  const server = createServer(async (_req, res) => {
    writeJson(res, 200, {
      ok: false,
      code: 'ctf-consolidation-no-gain',
      error: 'market cond consolidation has no net collateral gain',
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.equal(typeof address, 'object')
  assert.ok(address)

  try {
    const result = await runCliWithOutput(`http://127.0.0.1:${address.port}`, [
      'wallet',
      'consolidate',
      'cond-A',
      '--strategy',
      'sweep',
    ])
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /Warning: skipped cond-A: market cond consolidation has no net collateral gain/)
    assert.doesNotMatch(result.stderr, /secret|witness|mnemonic|nwc/i)
  } finally {
    server.close()
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli consolidate exits non-zero for a non-pending market', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-consolidate-closed-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  await ensureRpcToken()
  const server = createServer(async (_req, res) => {
    writeJson(res, 200, {
      ok: false,
      code: 'market-not-pending',
      error: 'market closed is not pending',
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.equal(typeof address, 'object')
  assert.ok(address)

  try {
    await assert.rejects(
      () => runCliWithOutput(`http://127.0.0.1:${address.port}`, [
        'wallet',
        'consolidate',
        'closed-A',
      ]),
      (err: unknown) => {
        assert.equal((err as { code?: unknown }).code, 1)
        assert.match((err as { stderr?: string }).stderr ?? '', /market closed is not pending/)
        assert.doesNotMatch((err as { stderr?: string }).stderr ?? '', /secret|witness|mnemonic|nwc/i)
        return true
      },
    )
  } finally {
    server.close()
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli consolidate --all sweeps wallet markets and warns on non-pending', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-consolidate-all-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  await ensureRpcToken()
  const received: unknown[] = []
  const server = createServer(async (req, res) => {
    const command = JSON.parse(await readBody(req)) as {
      method: string
      params?: { marketId?: string }
    }
    received.push(command)
    if (command.method === 'wallet.balance') {
      writeJson(res, 200, {
        ok: true,
        result: {
          outcomePositions: [
            { conditionId: 'cond1', outcomeSetId: 'A' },
            { conditionId: 'cond2', outcomeSetId: 'B' },
            { conditionId: 'closed', outcomeSetId: 'C' },
          ],
        },
      })
      return
    }
    if (command.params?.marketId === 'closed-C') {
      writeJson(res, 200, {
        ok: false,
        code: 'market-not-pending',
        error: 'market closed is not pending',
      })
      return
    }
    writeJson(res, 200, {
      ok: true,
      result: {
        marketId: command.params?.marketId,
        status: 'consolidated',
        convertFeeSats: 1,
        collateralReturnedSats: 2,
        spentInputs: [],
        outputs: [],
      },
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.equal(typeof address, 'object')
  assert.ok(address)

  try {
    const result = await runCliWithOutput(`http://127.0.0.1:${address.port}`, [
      'wallet',
      'consolidate',
      '--all',
      '--strategy',
      'reclaim',
    ])
    assert.match(result.stdout, /cond1-A/)
    assert.match(result.stdout, /cond2-B/)
    assert.match(result.stderr, /Warning: skipped closed-C: market closed is not pending/)
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /secret|witness|mnemonic|nwc/i)
    assert.deepEqual(received, [
      { method: 'wallet.balance' },
      { method: 'wallet.consolidateMarket', params: { marketId: 'closed-C', type: 't3' } },
      { method: 'wallet.consolidateMarket', params: { marketId: 'cond1-A', type: 't3' } },
      { method: 'wallet.consolidateMarket', params: { marketId: 'cond2-B', type: 't3' } },
    ])
  } finally {
    server.close()
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli rejects partial outcome-token receive metadata before RPC', async () => {
  const server = createServer(async (_req, res) => {
    writeJson(res, 500, { ok: false, error: 'RPC should not be called' })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.equal(typeof address, 'object')
  assert.ok(address)

  try {
    await assert.rejects(
      () =>
        runCliWithOutput(`http://127.0.0.1:${address.port}`, [
          'wallet',
          'receive',
          'cashuOutcomeToken=',
          '--condition-id',
          'cond',
        ]),
      (err: unknown) => {
        assert.equal((err as { code?: unknown }).code, 2)
        assert.match(
          (err as { stderr?: string }).stderr ?? '',
          /require both --condition-id and --outcome-set/,
        )
        return true
      },
    )
  } finally {
    server.close()
  }
})

test('bitcaster-cli uses default Unix socket RPC when no URL override is set', async () => {
  if (process.platform === 'win32') return

  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-socket-rpc-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  const token = await ensureRpcToken()
  let received: unknown = null
  let authorization: string | undefined
  const server = createServer(async (req, res) => {
    authorization = req.headers.authorization
    received = JSON.parse(await readBody(req))
    writeJson(res, 200, { ok: true, result: { socket: true } })
  })
  server.listen(join(home, 'daemon.sock'))
  await once(server, 'listening')

  try {
    const result = await runCliWithEnv(['health'], {
      ...process.env,
      BITCASTER_DAEMON_HOME: home,
      BITCASTER_CLI_AUTOSTART_DAEMON: '0',
      BITCASTER_DAEMON_URL: undefined,
      BITCASTER_DAEMON_PORT: undefined,
    })

    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      result: { socket: true },
    })
    assert.deepEqual(received, { method: 'health' })
    assert.equal(authorization, `Bearer ${token}`)
  } finally {
    server.close()
    await once(server, 'close')
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli trade watch --wait streams changed states until terminal', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-watch-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  const token = await ensureRpcToken()
  const states = ['opened', 'opened', 'confirmed']
  const authorizationHeaders: Array<string | undefined> = []
  const server = createServer(async (req, res) => {
    authorizationHeaders.push(req.headers.authorization)
    const command = JSON.parse(await readBody(req)) as {
      method: string
      params?: { tradeId?: string }
    }
    assert.equal(command.method, 'trade.watch')
    assert.equal(command.params?.tradeId, 'trade-1')
    const step = states.shift() ?? 'confirmed'
    writeJson(res, 200, {
      ok: true,
      result: {
        tradeId: 'trade-1',
        step,
      },
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.equal(typeof address, 'object')
  assert.ok(address)

  try {
    const result = await runCliWithOutput(
      `http://127.0.0.1:${address.port}`,
      ['trade', 'watch', 'trade-1', '--wait', '--interval-ms', '1', '--timeout-ms', '250'],
    )
    const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
    assert.deepEqual(lines, [
      { ok: true, result: { tradeId: 'trade-1', step: 'opened' } },
      { ok: true, result: { tradeId: 'trade-1', step: 'confirmed' } },
    ])
    assert.deepEqual(
      authorizationHeaders,
      Array.from({ length: 3 }, () => `Bearer ${token}`),
    )
  } finally {
    server.close()
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli trade watch --wait exits non-zero on timeout', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-watch-timeout-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  await ensureRpcToken()
  const server = createServer(async (_req, res) => {
    writeJson(res, 200, {
      ok: true,
      result: {
        tradeId: 'trade-1',
        step: 'opened',
      },
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.equal(typeof address, 'object')
  assert.ok(address)

  try {
    await assert.rejects(
      () =>
        runCliWithOutput(`http://127.0.0.1:${address.port}`, [
          'trade',
          'watch',
          'trade-1',
          '--wait',
          '--interval-ms',
          '1',
          '--timeout-ms',
          '20',
        ]),
      (err: unknown) => {
        assert.equal((err as { code?: unknown }).code, 1)
        assert.match(
          (err as { stderr?: string }).stderr ?? '',
          /Timed out waiting for trade trade-1/,
        )
        return true
      },
    )
  } finally {
    server.close()
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli daemon init delegates setup/import to bitcaster-daemon', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-daemon-init-'))
  const walletSeedHex = 'ab'.repeat(32)
  const nostrSecretKeyHex = '01'.padStart(64, '0')
  try {
    const result = await execFileAsync(
      process.execPath,
      [
        '--experimental-strip-types',
        join(import.meta.dirname, '..', 'src', 'main.ts'),
        'daemon',
        'init',
        '--wallet-seed-hex',
        walletSeedHex,
        '--nostr-secret-key-hex',
        nostrSecretKeyHex,
        '--engine-url',
        'http://engine.example',
        '--mint-url',
        'http://mint.example',
      ],
      {
        env: {
          ...process.env,
          BITCASTER_DAEMON_HOME: home,
        },
      },
    )

    assert.match(result.stdout, /bitcaster-daemon profile initialized/)
    const secrets = JSON.parse(
      await readFile(join(home, 'daemon-secrets.json'), 'utf8'),
    ) as {
      protection: string
      secrets: {
        walletSeedHex: string
        nostrSecretKeyHex: string
        nostrPublicKeyHex: string
      }
    }
    assert.equal(secrets.protection, 'file-mode-0600')
    assert.equal(secrets.secrets.walletSeedHex, walletSeedHex)
    assert.equal(secrets.secrets.nostrSecretKeyHex, nostrSecretKeyHex)
    assert.equal(
      secrets.secrets.nostrPublicKeyHex,
      '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    )
    const profile = JSON.parse(
      await readFile(join(home, 'daemon-profile.json'), 'utf8'),
    ) as {
      engineBaseUrl: string
      mintUrl: string
    }
    assert.equal(profile.engineBaseUrl, 'http://engine.example')
    assert.equal(profile.mintUrl, 'http://mint.example')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli daemon init delegates file-based setup/import to bitcaster-daemon', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-daemon-init-files-'))
  const walletSeedHex = 'ab'.repeat(32)
  const nostrSecretKeyHex = '01'.padStart(64, '0')
  const walletSeedFile = join(home, 'wallet-seed.hex')
  const nostrSecretKeyFile = join(home, 'nostr-secret-key.hex')

  try {
    await writeFile(walletSeedFile, `${walletSeedHex}\n`)
    await writeFile(nostrSecretKeyFile, `${nostrSecretKeyHex}\n`)
    const result = await execFileAsync(
      process.execPath,
      [
        '--experimental-strip-types',
        join(import.meta.dirname, '..', 'src', 'main.ts'),
        'daemon',
        'init',
        '--wallet-seed-hex-file',
        walletSeedFile,
        '--nostr-secret-key-hex-file',
        nostrSecretKeyFile,
        '--engine-url',
        'http://engine.example',
        '--mint-url',
        'http://mint.example',
      ],
      {
        env: {
          ...process.env,
          BITCASTER_DAEMON_HOME: home,
        },
      },
    )

    assert.match(result.stdout, /bitcaster-daemon profile initialized/)
    const secrets = JSON.parse(
      await readFile(join(home, 'daemon-secrets.json'), 'utf8'),
    ) as {
      secrets: {
        walletSeedHex: string
        nostrSecretKeyHex: string
      }
    }
    assert.equal(secrets.secrets.walletSeedHex, walletSeedHex)
    assert.equal(secrets.secrets.nostrSecretKeyHex, nostrSecretKeyHex)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli auto-starts default local daemon when RPC is unavailable', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-autostart-'))
  const port = 44_000 + Math.floor(Math.random() * 10_000)
  const env = {
    ...process.env,
    BITCASTER_DAEMON_HOME: home,
    BITCASTER_DAEMON_PORT: String(port),
    BITCASTER_CLI_AUTOSTART_DAEMON: '1',
  }
  delete env.BITCASTER_DAEMON_URL
  let daemonPid: number | undefined
  try {
    await execFileAsync(
      process.execPath,
      [
        '--experimental-strip-types',
        join(import.meta.dirname, '..', 'src', 'main.ts'),
        'daemon',
        'init',
      ],
      { env },
    )

    const result = await execFileAsync(
      process.execPath,
      [
        '--experimental-strip-types',
        join(import.meta.dirname, '..', 'src', 'main.ts'),
        'health',
      ],
      { env },
    )

    assert.equal(JSON.parse(result.stdout).ok, true)
    daemonPid = JSON.parse(
      (await readFile(join(home, 'daemon-autostart.pid'), 'utf8')).trim(),
    ).pid as number
    assert.equal(Number.isSafeInteger(daemonPid), true)
  } finally {
    if (daemonPid) {
      try {
        process.kill(daemonPid, 'SIGTERM')
      } catch {
        // Process may have exited during test teardown.
      }
    }
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli daemon stop refuses a stale pid file when process start time differs', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-stale-pid-'))
  const pidPath = join(home, 'daemon-autostart.pid')
  try {
    await writeFile(
      pidPath,
      JSON.stringify({
        pid: process.pid,
        startedAt: 'definitely-not-this-process-start-time',
        daemonMain: process.argv[1] ?? 'bitcaster-cli-test',
      }) + '\n',
    )

    await assert.rejects(
      () => runCliWithEnv(['daemon', 'stop'], {
        ...process.env,
        BITCASTER_DAEMON_HOME: home,
      }),
      (err: unknown) => {
        assert.equal((err as { code?: unknown }).code, 1)
        assert.match(
          (err as { stderr?: string }).stderr ?? '',
          new RegExp(`PID ${process.pid} no longer belongs to bitcaster-daemon`),
        )
        return true
      },
    )
    assert.ok(await fileExists(pidPath), 'stale pid file should not be removed')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli daemon stop fails and keeps pid file when daemon ignores SIGTERM', async () => {
  if (process.platform === 'win32') return

  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-stop-timeout-'))
  const daemonMain = join(home, 'node_modules', '@bitcaster-market', 'daemon', 'dist', 'main.js')
  const pidPath = join(home, 'daemon-autostart.pid')
  let childPid: number | undefined
  try {
    await mkdir(join(home, 'node_modules', '@bitcaster-market', 'daemon', 'dist'), { recursive: true })
    await writeFile(
      daemonMain,
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n",
    )
    const child = spawn(process.execPath, [daemonMain, 'run'], {
      stdio: 'ignore',
    })
    assert.ok(child.pid)
    childPid = child.pid
    await waitForProcessStartTime(childPid)
    await writeFile(
      pidPath,
      JSON.stringify({
        pid: childPid,
        startedAt: await processStartTime(childPid),
        daemonMain,
      }) + '\n',
    )

    await assert.rejects(
      () => runCliWithEnv(['daemon', 'stop'], {
        ...process.env,
        BITCASTER_DAEMON_HOME: home,
      }),
      (err: unknown) => {
        assert.equal((err as { code?: unknown }).code, 1)
        assert.match(
          (err as { stderr?: string }).stderr ?? '',
          /daemon did not exit within 5000ms after SIGTERM/,
        )
        return true
      },
    )
    assert.ok(await fileExists(pidPath), 'pid file should remain when daemon is still alive')
    assert.doesNotThrow(() => process.kill(childPid!, 0))
  } finally {
    if (childPid) {
      try {
        process.kill(childPid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli classifies broader network and fetch failures', () => {
  for (const code of ['ETIMEDOUT', 'ENETUNREACH', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']) {
    const err = new Error('connect failed') as Error & { code: string }
    err.code = code
    assert.equal(isNetworkFailure(err), true, code)
  }
  assert.equal(isNetworkFailure(new TypeError('network request failed')), true)
  assert.equal(isNetworkFailure(new TypeError('fetch failed: connection timeout')), true)
})

// ---------------------------------------------------------------------------
// P47 Phase 0 — red-first tests for the new CLI surface.
// These tests assert the target behavior and are skipped until the
// corresponding phase lands. Unskip them as each phase is implemented.
// ---------------------------------------------------------------------------

test('P47-1: bitcaster-cli --version prints a version string', async () => {
  const result = await execFileAsync(
    join(import.meta.dirname, '..', 'src', 'main.ts'),
    ['--version'],
    { env: process.env },
  )
  assert.match(result.stdout, /\d+\.\d+\.\d+/)
})

test('P47-1: bitcaster-cli -V is an alias for --version', async () => {
  const result = await execFileAsync(
    join(import.meta.dirname, '..', 'src', 'main.ts'),
    ['-V'],
    { env: process.env },
  )
  assert.match(result.stdout, /\d+\.\d+\.\d+/)
})

test('P47-1: bitcaster-cli market list works (singular command name)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-singular-market-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  await ensureRpcToken()
  const server = createServer(async (_req, res) => {
    writeJson(res, 200, { ok: true, result: { markets: [] } })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.equal(typeof address, 'object')
  assert.ok(address)

  try {
    await runCli(`http://127.0.0.1:${address.port}`, ['market', 'list'])
  } finally {
    server.close()
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('P47-1: bitcaster-cli daemon init --help shows help text (not an error)', async () => {
  const result = await execFileAsync(
    join(import.meta.dirname, '..', 'src', 'main.ts'),
    ['daemon', 'init', '--help'],
    { env: process.env },
  )
  assert.match(result.stdout, /daemon init/)
  assert.match(result.stdout, /wallet-seed-hex/)
})

test('P47-1: bitcaster-cli config is a top-level command', async () => {
  const result = await execFileAsync(
    join(import.meta.dirname, '..', 'src', 'main.ts'),
    ['config', '--help'],
    { env: process.env },
  )
  assert.match(result.stdout, /config/)
  assert.match(result.stdout, /engine-url|mint-url/)
})

test('P47-1: bitcaster-cli config path shows config file location', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-config-path-'))
  try {
    const result = await runCliWithEnv(['config', 'path'], {
      ...process.env,
      BITCASTER_DAEMON_HOME: home,
    })
    assert.match(result.stdout, /config\.json/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli config list drops unknown config keys and preserves private file mode', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-config-sanitize-'))
  const configPath = join(home, 'config.json')
  try {
    await writeFile(
      configPath,
      JSON.stringify(
        {
          engineUrl: 'http://engine.example',
          mintUrl: 'https://mint.example',
          nostrSecretKeyHex: 'super-secret-key',
        },
        null,
        2,
      ) + '\n',
    )

    const result = await runCliWithEnv(['config', 'list'], {
      ...process.env,
      BITCASTER_DAEMON_HOME: home,
    })

    assert.doesNotMatch(result.stdout, /nostrSecretKeyHex|super-secret-key/)
    assert.deepEqual(JSON.parse(result.stdout), {
      engineUrl: 'http://engine.example',
      mintUrl: 'https://mint.example',
      trustedEngineUrls: [],
    })
    const fileMode = (await stat(configPath)).mode & 0o777
    assert.equal(fileMode, 0o600)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli config set writes config without auto-starting an unreachable daemon', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-config-set-no-daemon-'))
  const configPath = join(home, 'config.json')
  try {
    const result = await runCliWithEnv(
      ['config', 'set', '--engine-url', 'http://engine.example'],
      {
        ...process.env,
        BITCASTER_DAEMON_HOME: home,
        BITCASTER_CLI_AUTOSTART_DAEMON: '0',
        BITCASTER_DAEMON_URL: 'http://127.0.0.1:1',
      },
    )

    assert.match(result.stderr, /daemon not reachable; config\.json updated/i)
    assert.match(result.stderr, /bitcaster daemon init/)
    const parsed = JSON.parse(result.stdout) as {
      ok?: boolean
      result?: { config?: { engineUrl?: string }; daemonUpdated?: boolean }
    }
    assert.equal(parsed.ok, true)
    assert.equal(parsed.result?.daemonUpdated, false)
    assert.equal(parsed.result?.config?.engineUrl, 'http://engine.example')
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {
      engineUrl: 'http://engine.example',
      trustedEngineUrls: [],
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli config set does not auto-start the daemon when autostart is otherwise enabled', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-config-set-autostart-enabled-'))
  const port = 44_000 + Math.floor(Math.random() * 10_000)
  const configPath = join(home, 'config.json')
  const autostartPidPath = join(home, 'daemon-autostart.pid')
  let daemonPid: number | undefined
  const env = {
    ...process.env,
    BITCASTER_DAEMON_HOME: home,
    BITCASTER_DAEMON_PORT: String(port),
  }
  delete env.BITCASTER_CLI_AUTOSTART_DAEMON
  delete env.BITCASTER_DAEMON_URL

  try {
    const result = await runCliWithEnv(
      ['config', 'set', '--engine-url', 'http://engine.example'],
      env,
    )

    const combinedOutput = `${result.stdout}\n${result.stderr}`
    assert.match(combinedOutput, /daemon not reachable; config\.json updated/i)
    assert.match(combinedOutput, /bitcaster daemon init/i)
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {
      engineUrl: 'http://engine.example',
      trustedEngineUrls: [],
    })
    await assert.rejects(
      () => stat(autostartPidPath),
      (err: unknown) =>
        typeof err === 'object' &&
        err !== null &&
        (err as { code?: unknown }).code === 'ENOENT',
    )
  } finally {
    try {
      daemonPid = JSON.parse((await readFile(autostartPidPath, 'utf8')).trim()).pid as number
    } catch {
      // No auto-start PID was written.
    }
    if (daemonPid) {
      try {
        process.kill(daemonPid, 'SIGTERM')
      } catch {
        // Process may have exited during test teardown.
      }
    }
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli config set --engine-url records URL without trusting it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-config-set-untrusted-'))
  const configPath = join(home, 'config.json')
  try {
    await runCliWithEnv(['config', 'set', '--engine-url', 'https://engine.example'], {
      ...process.env,
      BITCASTER_DAEMON_HOME: home,
      BITCASTER_CLI_AUTOSTART_DAEMON: '0',
      BITCASTER_DAEMON_URL: 'http://127.0.0.1:1',
    })

    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {
      engineUrl: 'https://engine.example',
      trustedEngineUrls: [],
    })

    await assert.rejects(
      () => runCliWithEnv([
        'market', 'create',
        '--condition-id', 'cond-1',
        '--title', 'Market',
        '--description', 'Description',
        '--outcomes', 'YES,NO',
        '--dry-run',
      ], {
        ...process.env,
        BITCASTER_DAEMON_HOME: home,
        BITCASTER_CLI_AUTOSTART_DAEMON: '0',
        BITCASTER_DAEMON_URL: 'http://127.0.0.1:1',
      }),
      (err: unknown) => {
        assert.equal((err as { code?: unknown }).code, 3)
        assert.match((err as { stderr?: string }).stderr ?? '', /without --trust-engine-url/)
        return true
      },
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli market create --trust-engine-url records URL in trusted engine list', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-market-create-trust-list-'))
  const configPath = join(home, 'config.json')
  try {
    await runCliWithEnv([
      'market', 'create',
      '--condition-id', 'cond-1',
      '--title', 'Market',
      '--description', 'Description',
      '--outcomes', 'YES,NO',
      '--dry-run',
      '--trust-engine-url',
    ], {
      ...process.env,
      BITCASTER_DAEMON_HOME: home,
      BITCASTER_ENGINE_URL: 'https://engine.example',
      BITCASTER_CLI_AUTOSTART_DAEMON: '0',
      BITCASTER_DAEMON_URL: 'http://127.0.0.1:1',
    })

    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {
      trustedEngineUrls: ['https://engine.example/'],
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli config list does not rewrite already sanitized config', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-config-no-rewrite-'))
  const configPath = join(home, 'config.json')
  const configText = JSON.stringify({
    engineUrl: 'https://engine.example',
    mintUrl: 'https://mint.example',
    trustedEngineUrls: ['https://trusted-engine.example'],
  }, null, 2) + '\n'
  try {
    await writeFile(configPath, configText, { mode: 0o600 })
    const oldTime = new Date('2026-01-01T00:00:00.000Z')
    await utimes(configPath, oldTime, oldTime)
    const before = await stat(configPath)

    const result = await runCliWithEnv(['config', 'list'], {
      ...process.env,
      BITCASTER_DAEMON_HOME: home,
    })

    assert.deepEqual(JSON.parse(result.stdout), {
      engineUrl: 'https://engine.example',
      mintUrl: 'https://mint.example',
      trustedEngineUrls: ['https://trusted-engine.example'],
    })
    const after = await stat(configPath)
    assert.equal(after.mtimeMs, before.mtimeMs)
    assert.equal(await readFile(configPath, 'utf8'), configText)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('P47-2: bitcaster-cli shows friendly error when daemon is unreachable', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-no-daemon-'))
  try {
    await assert.rejects(
      () =>
        runCliWithEnv(['health'], {
          ...process.env,
          BITCASTER_DAEMON_HOME: home,
          BITCASTER_CLI_AUTOSTART_DAEMON: '0',
          BITCASTER_DAEMON_URL: undefined,
          BITCASTER_DAEMON_PORT: undefined,
        }),
      (err: unknown) => {
        const stderr = (err as { stderr?: string }).stderr ?? ''
        const parsed = JSON.parse(stderr) as { ok?: boolean; error?: string; hint?: string }
        assert.equal(parsed.ok, false)
        assert.match(parsed.error ?? '', /daemon not reachable|daemon is not running/i)
        assert.equal(parsed.hint, "Run 'bitcaster daemon init' or set BITCASTER_DAEMON_URL.")
        assert.doesNotMatch(stderr, /triggerUncaughtException|TypeError|ECONNREFUSED/)
        return true
      },
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('P47-3: market list with --engine-url calls engine directly without daemon RPC', async () => {
  const daemonCalls: unknown[] = []
  const daemon = createServer(async (req, res) => {
    daemonCalls.push({ method: req.method, url: req.url })
    writeJson(res, 500, { ok: false, error: 'daemon should not be called' })
  })
  const engineRequests: Array<{ method?: string; url?: string }> = []
  const engine = createServer(async (req, res) => {
    engineRequests.push({ method: req.method, url: req.url })
    assert.equal(req.method, 'GET')
    assert.equal(req.url, '/api/v1/markets/query?state=All&search=weather&page_size=5')
    writeJson(res, 200, {
      markets: [{ conditionId: 'condition-1', title: 'Weather' }],
      nextCursor: null,
      lastSuccessfulRefreshAt: '2026-07-02T00:00:00Z',
    })
  })
  daemon.listen(0, '127.0.0.1')
  engine.listen(0, '127.0.0.1')
  await Promise.all([once(daemon, 'listening'), once(engine, 'listening')])
  const daemonAddress = daemon.address()
  const engineAddress = engine.address()
  assert.equal(typeof daemonAddress, 'object')
  assert.equal(typeof engineAddress, 'object')
  assert.ok(daemonAddress)
  assert.ok(engineAddress)

  try {
    const result = await runCliWithEnv(
      [
        '--engine-url',
        `http://127.0.0.1:${engineAddress.port}`,
        'market',
        'list',
        '--search',
        'weather',
        '--limit',
        '5',
        '--state',
        'All',
      ],
      {
        ...process.env,
        BITCASTER_DAEMON_URL: `http://127.0.0.1:${daemonAddress.port}`,
        BITCASTER_CLI_AUTOSTART_DAEMON: '0',
      },
    )

    assert.deepEqual(JSON.parse(result.stdout), {
      markets: [{ conditionId: 'condition-1', title: 'Weather' }],
      nextCursor: null,
      lastSuccessfulRefreshAt: '2026-07-02T00:00:00Z',
    })
    assert.deepEqual(engineRequests, [
      { method: 'GET', url: '/api/v1/markets/query?state=All&search=weather&page_size=5' },
    ])
    assert.deepEqual(daemonCalls, [])
  } finally {
    daemon.close()
    engine.close()
  }
})

test('P47-3 regression: market show with --engine-url prints one market from engine query response', async () => {
  const daemonCalls: unknown[] = []
  const daemon = createServer(async (req, res) => {
    daemonCalls.push({ method: req.method, url: req.url })
    writeJson(res, 500, { ok: false, error: 'daemon should not be called' })
  })
  const engineRequests: Array<{ method?: string; url?: string }> = []
  const engine = createServer(async (req, res) => {
    engineRequests.push({ method: req.method, url: req.url })
    assert.equal(req.method, 'GET')
    assert.equal(req.url, '/api/v1/markets/query?state=All&ids=condition-1&page_size=1')
    writeJson(res, 200, {
      markets: [
        { conditionId: 'condition-1', title: 'Weather' },
        { conditionId: 'condition-2', title: 'Ignored' },
      ],
      nextCursor: null,
    })
  })
  daemon.listen(0, '127.0.0.1')
  engine.listen(0, '127.0.0.1')
  await Promise.all([once(daemon, 'listening'), once(engine, 'listening')])
  const daemonAddress = daemon.address()
  const engineAddress = engine.address()
  assert.equal(typeof daemonAddress, 'object')
  assert.equal(typeof engineAddress, 'object')
  assert.ok(daemonAddress)
  assert.ok(engineAddress)

  try {
    const result = await runCliWithEnv(
      ['--engine-url', `http://127.0.0.1:${engineAddress.port}`, 'market', 'show', 'condition-1'],
      {
        ...process.env,
        BITCASTER_DAEMON_URL: `http://127.0.0.1:${daemonAddress.port}`,
        BITCASTER_CLI_AUTOSTART_DAEMON: '0',
      },
    )

    assert.deepEqual(JSON.parse(result.stdout), { conditionId: 'condition-1', title: 'Weather' })
    assert.deepEqual(engineRequests, [
      { method: 'GET', url: '/api/v1/markets/query?state=All&ids=condition-1&page_size=1' },
    ])
    assert.deepEqual(daemonCalls, [])
  } finally {
    daemon.close()
    engine.close()
  }
})

test('P47-3 regression: engine HTTP 500 is surfaced without daemon fallback', async () => {
  const daemonCalls: unknown[] = []
  const daemon = createServer(async (req, res) => {
    daemonCalls.push({ method: req.method, url: req.url })
    writeJson(res, 200, { ok: true, result: { markets: [] } })
  })
  const engine = createServer(async (_req, res) => {
    writeJson(res, 500, { error: 'engine exploded' })
  })
  daemon.listen(0, '127.0.0.1')
  engine.listen(0, '127.0.0.1')
  await Promise.all([once(daemon, 'listening'), once(engine, 'listening')])
  const daemonAddress = daemon.address()
  const engineAddress = engine.address()
  assert.equal(typeof daemonAddress, 'object')
  assert.equal(typeof engineAddress, 'object')
  assert.ok(daemonAddress)
  assert.ok(engineAddress)

  try {
    await assert.rejects(
      () => runCliWithEnv(
        ['--engine-url', `http://127.0.0.1:${engineAddress.port}`, 'market', 'list'],
        {
          ...process.env,
          BITCASTER_DAEMON_URL: `http://127.0.0.1:${daemonAddress.port}`,
          BITCASTER_CLI_AUTOSTART_DAEMON: '0',
        },
      ),
      (err: unknown) => {
        assert.equal((err as { code?: unknown }).code, 1)
        assert.deepEqual(JSON.parse((err as { stdout?: string }).stdout ?? ''), {
          ok: false,
          error: 'engine returned HTTP 500: {"error":"engine exploded"}',
        })
        assert.deepEqual(daemonCalls, [])
        return true
      },
    )
  } finally {
    daemon.close()
    engine.close()
  }
})

test('P47-3 regression: market list direct engine forwards sort creator tag and cursor params', async () => {
  const daemonCalls: unknown[] = []
  const daemon = createServer(async (req, res) => {
    daemonCalls.push({ method: req.method, url: req.url })
    writeJson(res, 500, { ok: false, error: 'daemon should not be called' })
  })
  const engineRequests: Array<{ method?: string; url?: string }> = []
  const engine = createServer(async (req, res) => {
    engineRequests.push({ method: req.method, url: req.url })
    assert.equal(req.method, 'GET')
    assert.equal(req.url, '/api/v1/markets/query?sort=Trending&tag=sports&creator_pubkey=npub1creator&cursor=page-2')
    writeJson(res, 200, { markets: [], nextCursor: null })
  })
  daemon.listen(0, '127.0.0.1')
  engine.listen(0, '127.0.0.1')
  await Promise.all([once(daemon, 'listening'), once(engine, 'listening')])
  const daemonAddress = daemon.address()
  const engineAddress = engine.address()
  assert.equal(typeof daemonAddress, 'object')
  assert.equal(typeof engineAddress, 'object')
  assert.ok(daemonAddress)
  assert.ok(engineAddress)

  try {
    await runCliWithEnv(
      [
        '--engine-url',
        `http://127.0.0.1:${engineAddress.port}`,
        'market',
        'list',
        '--sort',
        'Trending',
        '--tag',
        'sports',
        '--creator',
        'npub1creator',
        '--cursor',
        'page-2',
      ],
      {
        ...process.env,
        BITCASTER_DAEMON_URL: `http://127.0.0.1:${daemonAddress.port}`,
        BITCASTER_CLI_AUTOSTART_DAEMON: '0',
      },
    )

    assert.deepEqual(engineRequests, [
      { method: 'GET', url: '/api/v1/markets/query?sort=Trending&tag=sports&creator_pubkey=npub1creator&cursor=page-2' },
    ])
    assert.deepEqual(daemonCalls, [])
  } finally {
    daemon.close()
    engine.close()
  }
})

test('P47-3 regression: market list daemon forwards canonical CLI sort values and keeps creator param', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-market-list-sort-daemon-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  await ensureRpcToken()
  const received: unknown[] = []
  const daemon = createServer(async (req, res) => {
    received.push(JSON.parse(await readBody(req)))
    writeJson(res, 200, { ok: true, result: { markets: [] } })
  })
  daemon.listen(0, '127.0.0.1')
  await once(daemon, 'listening')
  const daemonAddress = daemon.address()
  assert.equal(typeof daemonAddress, 'object')
  assert.ok(daemonAddress)

  try {
    for (const sort of ['Trending', 'Popular', 'New']) {
      await runCliWithEnv(['market', 'list', '--sort', sort, '--creator', 'npub1creator'], {
        ...process.env,
        BITCASTER_DAEMON_URL: `http://127.0.0.1:${daemonAddress.port}`,
        BITCASTER_ENGINE_URL: undefined,
      })
    }

    assert.deepEqual(received, [
      { method: 'markets.query', params: { creator: 'npub1creator', sort: 'Trending' } },
      { method: 'markets.query', params: { creator: 'npub1creator', sort: 'Popular' } },
      { method: 'markets.query', params: { creator: 'npub1creator', sort: 'New' } },
    ])
  } finally {
    daemon.close()
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('P47-3 regression: market list direct engine times out after 5s and falls back to daemon', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-market-list-timeout-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  await ensureRpcToken()
  const received: unknown[] = []
  const daemon = createServer(async (req, res) => {
    received.push(JSON.parse(await readBody(req)))
    writeJson(res, 200, { ok: true, result: { markets: [{ conditionId: 'from-daemon' }], nextCursor: null } })
  })
  const engineRequests: Array<{ method?: string; url?: string }> = []
  const engine = createServer(async (req, _res) => {
    engineRequests.push({ method: req.method, url: req.url })
  })
  daemon.listen(0, '127.0.0.1')
  engine.listen(0, '127.0.0.1')
  await Promise.all([once(daemon, 'listening'), once(engine, 'listening')])
  const daemonAddress = daemon.address()
  const engineAddress = engine.address()
  assert.equal(typeof daemonAddress, 'object')
  assert.equal(typeof engineAddress, 'object')
  assert.ok(daemonAddress)
  assert.ok(engineAddress)

  try {
    const startedAt = Date.now()
    const result = await runCliWithEnv(
      ['--engine-url', `http://127.0.0.1:${engineAddress.port}`, 'market', 'list', '--sort', 'Trending'],
      {
        ...process.env,
        BITCASTER_DAEMON_URL: `http://127.0.0.1:${daemonAddress.port}`,
        BITCASTER_CLI_AUTOSTART_DAEMON: '0',
      },
    )
    const elapsedMs = Date.now() - startedAt

    assert.ok(elapsedMs >= 4_500, `expected direct engine timeout to wait about 5s, got ${elapsedMs}ms`)
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      result: { markets: [{ conditionId: 'from-daemon' }], nextCursor: null },
    })
    assert.match(result.stderr, /falling back to daemon/)
    assert.deepEqual(engineRequests, [
      { method: 'GET', url: '/api/v1/markets/query?sort=Trending' },
    ])
    assert.deepEqual(received, [
      { method: 'markets.query', params: { sort: 'Trending' } },
    ])
  } finally {
    daemon.close()
    engine.close()
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('P47-3 regression: market list rejects unknown sort values', async () => {
  await assert.rejects(
    () => runCliWithEnv(['market', 'list', '--sort', 'Hot'], {
      ...process.env,
      BITCASTER_DAEMON_URL: 'http://127.0.0.1:9',
      BITCASTER_CLI_AUTOSTART_DAEMON: '0',
      BITCASTER_ENGINE_URL: undefined,
    }),
    (err: unknown) => {
      assert.equal((err as { code?: unknown }).code, 2)
      assert.match((err as { stderr?: string }).stderr ?? '', /Invalid market sort: Hot/)
      return true
    },
  )
})

test('P47-3: market list without --engine-url falls back to daemon RPC', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-market-list-daemon-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  await ensureRpcToken()
  const received: unknown[] = []
  const daemon = createServer(async (req, res) => {
    received.push(JSON.parse(await readBody(req)))
    writeJson(res, 200, { ok: true, result: { markets: [] } })
  })
  daemon.listen(0, '127.0.0.1')
  await once(daemon, 'listening')
  const daemonAddress = daemon.address()
  assert.equal(typeof daemonAddress, 'object')
  assert.ok(daemonAddress)

  try {
    await runCliWithEnv(['market', 'list', '--search', 'weather', '--limit', '5', '--state', 'All'], {
      ...process.env,
      BITCASTER_DAEMON_URL: `http://127.0.0.1:${daemonAddress.port}`,
      BITCASTER_ENGINE_URL: undefined,
    })

    assert.deepEqual(received, [
      { method: 'markets.query', params: { search: 'weather', limit: 5, state: 'All' } },
    ])
  } finally {
    daemon.close()
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('P47-3: order book with --engine-url calls engine directly without daemon RPC', async () => {
  const daemonCalls: unknown[] = []
  const daemon = createServer(async (req, res) => {
    daemonCalls.push({ method: req.method, url: req.url })
    writeJson(res, 500, { ok: false, error: 'daemon should not be called' })
  })
  const engineRequests: Array<{ method?: string; url?: string }> = []
  const engine = createServer(async (req, res) => {
    engineRequests.push({ method: req.method, url: req.url })
    assert.equal(req.method, 'GET')
    assert.equal(req.url, '/api/v1/cond-YES/orderbook')
    writeJson(res, 200, { marketId: 'cond-YES', bids: [{ price: 42, amount: 100 }], asks: [] })
  })
  daemon.listen(0, '127.0.0.1')
  engine.listen(0, '127.0.0.1')
  await Promise.all([once(daemon, 'listening'), once(engine, 'listening')])
  const daemonAddress = daemon.address()
  const engineAddress = engine.address()
  assert.equal(typeof daemonAddress, 'object')
  assert.equal(typeof engineAddress, 'object')
  assert.ok(daemonAddress)
  assert.ok(engineAddress)

  try {
    const result = await runCliWithEnv(
      ['--engine-url', `http://127.0.0.1:${engineAddress.port}`, 'order', 'book', 'cond-YES'],
      {
        ...process.env,
        BITCASTER_DAEMON_URL: `http://127.0.0.1:${daemonAddress.port}`,
        BITCASTER_CLI_AUTOSTART_DAEMON: '0',
      },
    )

    assert.deepEqual(JSON.parse(result.stdout), {
      marketId: 'cond-YES',
      bids: [{ price: 42, amount: 100 }],
      asks: [],
    })
    assert.deepEqual(engineRequests, [{ method: 'GET', url: '/api/v1/cond-YES/orderbook' }])
    assert.deepEqual(daemonCalls, [])
  } finally {
    daemon.close()
    engine.close()
  }
})

test('P47-4: bitcaster-cli order submit accepts named flags', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-named-flags-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  await ensureRpcToken()
  const received: unknown[] = []
  const server = createServer(async (req, res) => {
    const command = JSON.parse(await readBody(req))
    received.push(command)
    writeJson(res, 200, { ok: true, result: { orderId: 'ord-1' } })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.equal(typeof address, 'object')
  assert.ok(address)

  try {
    await runCli(`http://127.0.0.1:${address.port}`, [
      'order', 'submit',
      '--market', 'cond-YES',
      '--outcome', 'YES',
      '--side', 'Buy',
      '--price', '42',
      '--amount', '100',
      '--tif', 'FAK',
    ])
    await runCli(`http://127.0.0.1:${address.port}`, [
      'order', 'submit',
      '--market', 'cond-NO',
      '--outcome', 'NO',
      '--side', 'buy',
      '--price', '55',
      '--amount', '200',
      '--no-preflight-split',
    ])
    assert.deepEqual(received, [
      {
        method: 'order.submit',
        params: {
          marketId: 'cond-YES',
          outcomeId: 'YES',
          tokenSide: 'Outcome',
          side: 'Buy',
          price: 42,
          amountSats: 100,
          timeInForce: 'FAK',
          preflightSplit: true,
        },
      },
      {
        method: 'order.submit',
        params: {
          marketId: 'cond-NO',
          outcomeId: 'NO',
          tokenSide: 'Outcome',
          side: 'Buy',
          price: 55,
          amountSats: 200,
          timeInForce: 'GTC',
          preflightSplit: false,
        },
      },
    ])
  } finally {
    server.close()
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('P47-5: bitcaster-cli wallet consolidate merge maps to t1', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-wallet-consolidate-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  await ensureRpcToken()
  const received: unknown[] = []
  const server = createServer(async (req, res) => {
    const command = JSON.parse(await readBody(req))
    received.push(command)
    writeJson(res, 200, {
      ok: true,
      result: { marketId: 'cond-A', status: 'consolidated', convertFeeSats: 1, collateralReturnedSats: 2, spentInputs: [], outputs: [] },
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.equal(typeof address, 'object')
  assert.ok(address)

  try {
    await runCli(`http://127.0.0.1:${address.port}`, [
      'wallet', 'consolidate', 'cond-A', '--strategy', 'merge',
    ])
    assert.deepEqual(received, [
      { method: 'wallet.consolidateMarket', params: { marketId: 'cond-A', type: 't1' } },
    ])
  } finally {
    server.close()
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('P47-5: bitcaster-cli wallet consolidate sweep maps to t2', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-wallet-sweep-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  await ensureRpcToken()
  const received: unknown[] = []
  const server = createServer(async (req, res) => {
    const command = JSON.parse(await readBody(req))
    received.push(command)
    writeJson(res, 200, {
      ok: true,
      result: { marketId: 'cond-A', status: 'consolidated', convertFeeSats: 1, collateralReturnedSats: 2, spentInputs: [], outputs: [] },
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.equal(typeof address, 'object')
  assert.ok(address)

  try {
    await runCli(`http://127.0.0.1:${address.port}`, [
      'wallet', 'consolidate', 'cond-A', '--strategy', 'sweep',
    ])
    assert.deepEqual(received, [
      { method: 'wallet.consolidateMarket', params: { marketId: 'cond-A', type: 't2' } },
    ])
  } finally {
    server.close()
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('P47-5: bitcaster-cli wallet consolidate reclaim maps to t3 (default)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-wallet-reclaim-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  await ensureRpcToken()
  const received: unknown[] = []
  const server = createServer(async (req, res) => {
    const command = JSON.parse(await readBody(req))
    received.push(command)
    writeJson(res, 200, {
      ok: true,
      result: { marketId: 'cond-A', status: 'consolidated', convertFeeSats: 1, collateralReturnedSats: 2, spentInputs: [], outputs: [] },
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.equal(typeof address, 'object')
  assert.ok(address)

  try {
    await runCli(`http://127.0.0.1:${address.port}`, [
      'wallet', 'consolidate', 'cond-A',
    ])
    assert.deepEqual(received, [
      { method: 'wallet.consolidateMarket', params: { marketId: 'cond-A', type: 't3' } },
    ])
  } finally {
    server.close()
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('P47-5: bitcaster-cli wallet consolidate help describes strategy names', async () => {
  const result = await execFileAsync(
    join(import.meta.dirname, '..', 'src', 'main.ts'),
    ['wallet', 'consolidate', '--help'],
    { env: process.env },
  )

  assert.match(result.stdout, /--strategy <type>\s+Consolidation strategy:/)
  assert.match(result.stdout, /merge\s+- Merge singletons \+ collateral into the missing complement set/)
  assert.match(result.stdout, /sweep\s+- Extract collateral from overlapping complement collections/)
  assert.match(result.stdout, /reclaim\s+- Extract collateral from all mixed positions \(default\)/)
  assert.doesNotMatch(result.stdout, /--type/)
})

test('P47-4: bitcaster-cli wallet split (renamed from split-complete-set)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-wallet-split-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  await ensureRpcToken()
  const received: unknown[] = []
  const server = createServer(async (req, res) => {
    const command = JSON.parse(await readBody(req))
    received.push(command)
    writeJson(res, 200, { ok: true, result: {} })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.equal(typeof address, 'object')
  assert.ok(address)

  try {
    await runCli(`http://127.0.0.1:${address.port}`, [
      'wallet', 'split', 'cond-1', '100',
    ])
    assert.deepEqual(received, [
      { method: 'wallet.splitCompleteSet', params: { conditionId: 'cond-1', amountSats: 100 } },
    ])
  } finally {
    server.close()
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('P47-6b: market create with named flags sends daemon RPC params', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-market-create-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  await ensureRpcToken()
  const received: unknown[] = []
  const server = createServer(async (req, res) => {
    received.push(JSON.parse(await readBody(req)))
    writeJson(res, 200, { ok: true, result: { conditionId: 'cond-1' } })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.equal(typeof address, 'object')
  assert.ok(address)

  try {
    await runCliWithEnv([
      'market', 'create',
      '--condition-id', 'cond-1',
      '--title', 'Will it rain?',
      '--description', 'Weather market',
      '--outcomes', 'YES,NO,MAYBE',
      '--liquidity-sats', '1000',
      '--tag', 'weather',
      '--tag', 'test',
      '--thumbnail', '/tmp/thumb.png',
      '--trust-engine-url',
    ], {
      ...process.env,
      BITCASTER_DAEMON_HOME: home,
      BITCASTER_DAEMON_URL: `http://127.0.0.1:${address.port}`,
      BITCASTER_ENGINE_URL: 'https://engine.example',
    })

    assert.deepEqual(received, [
      {
        method: 'market.create',
        params: {
          conditionId: 'cond-1',
          title: 'Will it rain?',
          description: 'Weather market',
          outcomes: ['YES', 'NO', 'MAYBE'],
          liquiditySats: 1000,
          tags: ['weather', 'test'],
          thumbnailPath: '/tmp/thumb.png',
        },
      },
    ])
  } finally {
    server.close()
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('P47-6b: market close --attestation @file reads JSON locally before RPC', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-market-close-file-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  await ensureRpcToken()
  const attestation = kind89Event()
  const attestationPath = join(home, 'attestation.json')
  await writeFile(attestationPath, JSON.stringify(attestation))
  const received: unknown[] = []
  const server = createServer(async (req, res) => {
    received.push(JSON.parse(await readBody(req)))
    writeJson(res, 200, { ok: true, result: { result: 'Closed' } })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.equal(typeof address, 'object')
  assert.ok(address)

  try {
    await runCli(`http://127.0.0.1:${address.port}`, [
      'market', 'close',
      '--condition-id', 'cond-1',
      '--attestation', `@${attestationPath}`,
    ])
    assert.deepEqual(received, [
      {
        method: 'market.close',
        params: { conditionId: 'cond-1', attestationEvent: attestation },
      },
    ])
  } finally {
    server.close()
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('P47-6b: market close --attestation inline JSON sends event JSON', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-market-close-inline-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  await ensureRpcToken()
  const attestation = kind89Event()
  const received: unknown[] = []
  const server = createServer(async (req, res) => {
    received.push(JSON.parse(await readBody(req)))
    writeJson(res, 200, { ok: true, result: { result: 'Closed' } })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.equal(typeof address, 'object')
  assert.ok(address)

  try {
    await runCli(`http://127.0.0.1:${address.port}`, [
      'market', 'close',
      '--condition-id', 'cond-1',
      '--attestation', JSON.stringify(attestation),
    ])
    assert.deepEqual(received, [
      {
        method: 'market.close',
        params: { conditionId: 'cond-1', attestationEvent: attestation },
      },
    ])
  } finally {
    server.close()
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('P47-6b: market close rejects @file path containing parent traversal', async () => {
  await assert.rejects(
    () => runCliWithEnv([
      'market', 'close',
      '--condition-id', 'cond-1',
      '--attestation', '@../attestation.json',
    ], {
      ...process.env,
      BITCASTER_DAEMON_URL: 'http://127.0.0.1:9',
      BITCASTER_CLI_AUTOSTART_DAEMON: '0',
    }),
    (err: unknown) => {
      assert.equal((err as { code?: unknown }).code, 3)
      assert.match((err as { stderr?: string }).stderr ?? '', /must not contain \.\./)
      return true
    },
  )
})

test('P47-6b: market close --attestation rejects invalid event JSON before RPC', async () => {
  const invalidCases: Array<{ name: string; attestation: string; stderr: RegExp }> = [
    {
      name: 'non-json input',
      attestation: 'not-json',
      stderr: /Oracle attestation must be valid JSON/,
    },
    {
      name: 'wrong kind',
      attestation: JSON.stringify({ ...kind89Event(), kind: 1 }),
      stderr: /Oracle attestation must be a kind-89 Nostr event/,
    },
    {
      name: 'missing sig',
      attestation: JSON.stringify(kind89EventWithout('sig')),
      stderr: /Oracle attestation must be a kind-89 Nostr event/,
    },
    {
      name: 'missing id',
      attestation: JSON.stringify(kind89EventWithout('id')),
      stderr: /Oracle attestation must be a kind-89 Nostr event/,
    },
    {
      name: 'missing pubkey',
      attestation: JSON.stringify(kind89EventWithout('pubkey')),
      stderr: /Oracle attestation must be a kind-89 Nostr event/,
    },
    {
      name: 'tags is not an array of arrays',
      attestation: JSON.stringify({ ...kind89Event(), tags: ['e', 'c'.repeat(64)] }),
      stderr: /Oracle attestation must be a kind-89 Nostr event/,
    },
  ]

  for (const invalidCase of invalidCases) {
    await assert.rejects(
      () => runCliWithEnv([
        'market', 'close',
        '--condition-id', 'cond-1',
        '--attestation', invalidCase.attestation,
      ], {
        ...process.env,
        BITCASTER_DAEMON_URL: 'http://127.0.0.1:9',
        BITCASTER_CLI_AUTOSTART_DAEMON: '0',
      }),
      (err: unknown) => {
        assert.equal((err as { code?: unknown }).code, 3, invalidCase.name)
        assert.match((err as { stderr?: string }).stderr ?? '', invalidCase.stderr, invalidCase.name)
        return true
      },
      invalidCase.name,
    )
  }
})

test('P47-6b: market create refuses plain http engine URL without insecure localhost override', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-market-create-http-'))
  try {
    await assert.rejects(
      () => runCliWithEnv([
        'market', 'create',
        '--condition-id', 'cond-1',
        '--title', 'Market',
        '--description', 'Description',
        '--outcomes', 'YES,NO',
        '--trust-engine-url',
      ], {
        ...process.env,
        BITCASTER_DAEMON_HOME: home,
        BITCASTER_DAEMON_URL: 'http://127.0.0.1:9',
        BITCASTER_ENGINE_URL: 'http://engine.example',
        BITCASTER_ALLOW_INSECURE_ENGINE: undefined,
        BITCASTER_CLI_AUTOSTART_DAEMON: '0',
      }),
      (err: unknown) => {
        assert.equal((err as { code?: unknown }).code, 3)
        assert.match((err as { stderr?: string }).stderr ?? '', /Refusing insecure engine URL/)
        return true
      },
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('P47-7: bitcaster-cli order submit --dry-run prints payload without calling daemon', async () => {
  const result = await runCliWithOutput('http://127.0.0.1:1', [
    'order', 'submit',
    '--market', 'cond-YES',
    '--outcome', 'YES',
    '--side', 'Buy',
    '--price', '42',
    '--amount', '100',
    '--tif', 'FAK',
    '--token-side', 'Complement',
    '--dry-run',
  ])
  assert.deepEqual(JSON.parse(result.stdout), {
    marketId: 'cond-YES',
    outcomeId: 'YES',
    tokenSide: 'Complement',
    side: 'Buy',
    price: 42,
    amountSats: 100,
    timeInForce: 'FAK',
    preflightSplit: true,
  })
  assert.doesNotMatch(result.stdout, /secret|witness|mnemonic|nwc|authorization|sig/i)
})

test('P47-7: bitcaster-cli wallet and market --dry-run commands do not call daemon and redact sensitive fields', async () => {
  const attestation = kind89Event()
  const cases: Array<{ args: string[]; expected: unknown }> = [
    {
      args: ['wallet', 'send', '25', '--mint', 'mint-a', '--operation-id', 'op-1', '--dry-run'],
      expected: { amountSats: 25, mintUrl: 'mint-a', operationId: 'op-1' },
    },
    {
      args: ['wallet', 'split', 'cond-1', '100', '--mint', 'mint-a', '--dry-run'],
      expected: { conditionId: 'cond-1', amountSats: 100, mintUrl: 'mint-a' },
    },
    {
      args: ['wallet', 'consolidate', 'cond-A', '--strategy', 'merge', '--dry-run'],
      expected: { marketId: 'cond-A', type: 't1' },
    },
    {
      args: ['market', 'create', '--condition-id', 'cond-1', '--title', 'Market', '--description', 'Description', '--outcomes', 'YES,NO', '--liquidity-sats', '1000', '--dry-run'],
      expected: { conditionId: 'cond-1', title: 'Market', description: 'Description', outcomes: ['YES', 'NO'], liquiditySats: 1000 },
    },
    {
      args: ['market', 'close', '--condition-id', 'cond-1', '--attestation', JSON.stringify(attestation), '--dry-run'],
      expected: {
        conditionId: 'cond-1',
        attestationTemplate: {
          kind: 89,
          createdAt: attestation.createdAt,
          tags: attestation.tags,
          contentHash: 'dc540359a784bd009f963db761392a256fe02a8ae8ef8d0efc0f61fb9f4acd33',
        },
      },
    },
  ]

  for (const testCase of cases) {
    const result = await runCliWithOutput('http://127.0.0.1:1', testCase.args)
    assert.deepEqual(JSON.parse(result.stdout), testCase.expected)
    assert.doesNotMatch(result.stdout, /secret|witness|mnemonic|nwc|authorization|sig|nostrSecretKeyHex/i)
  }
})

test('P47-7: removed aliases exit with usage error code 2', async () => {
  const removedAliases = [
    ['markets', 'list'],
    ['wallet', 'split-complete-set', 'cond-1', '100'],
    ['consolidate', 'cond-A'],
    ['wallet', 'consolidate', 'cond-A', '--type', 't1'],
    ['order', 'submit', 'cond-YES', 'YES', 'Buy', '42', '100', 'FAK'],
  ]

  for (const args of removedAliases) {
    await assert.rejects(
      () => runCliWithOutput('http://127.0.0.1:1', args),
      (err: unknown) => {
        assert.equal((err as { code?: unknown }).code, 2, args.join(' '))
        return true
      },
      args.join(' '),
    )
  }
})

test('P47-7: bitcaster-cli lint gate — CLI source must not import NIP-98 signing functions', async () => {
  const sourceFiles = await sourceTsFiles(join(import.meta.dirname, '..', 'src'))
  const sourceText = (
    await Promise.all(
      sourceFiles.map(async (filePath) => `// ${filePath}\n${await readFile(filePath, 'utf8')}`),
    )
  ).join('\n')

  assert.ok(sourceFiles.length > 0, 'bitcaster-cli/src should contain TypeScript source files')
  assert.doesNotMatch(
    sourceText,
    /generateNip98Header|finalizeNip98|signNip98|nip98.*sign/,
    'bitcaster-cli/src must not import NIP-98 signing functions — signing stays in the daemon',
  )
})

async function sourceTsFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) return sourceTsFiles(entryPath)
    if (entry.isFile() && entry.name.endsWith('.ts')) return [entryPath]
    return []
  }))
  return files.flat().sort()
}

async function runCli(daemonUrl: string, args: string[]): Promise<void> {
  const result = await runCliWithOutput(daemonUrl, args)
  const parsed = JSON.parse(result.stdout) as { ok?: boolean }
  assert.equal(parsed.ok, true)
}

async function runCliWithOutput(
  daemonUrl: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return runCliWithEnv(args, {
    ...process.env,
    BITCASTER_DAEMON_URL: daemonUrl,
  })
}

async function runCliWithEnv(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    process.execPath,
    [
      '--experimental-strip-types',
      join(import.meta.dirname, '..', 'src', 'main.ts'),
      ...args,
    ],
    { env },
  )
}

function kind89Event(): {
  id: string
  pubkey: string
  createdAt: number
  kind: 89
  tags: string[][]
  content: string
  sig: string
} {
  return {
    id: 'a'.repeat(64),
    pubkey: 'b'.repeat(64),
    createdAt: 1_782_950_400,
    kind: 89,
    tags: [['e', 'c'.repeat(64)]],
    content: 'attestation-payload',
    sig: 'd'.repeat(128),
  }
}

function kind89EventWithout(field: 'id' | 'pubkey' | 'sig'): Record<string, unknown> {
  const event: Record<string, unknown> = kind89Event()
  delete event[field]
  return event
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT') {
      return false
    }
    throw err
  }
}

async function waitForProcessStartTime(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if ((await processStartTime(pid)) !== null) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`process ${pid} did not expose start time`)
}

async function processStartTime(pid: number): Promise<string | null> {
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

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
