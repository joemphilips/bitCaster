import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { ensureRpcToken } from '@bitcaster-market/daemon/rpcAuth'

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
  assert.match(result.stdout, /bitcaster-cli wallet balance/)
  assert.match(result.stdout, /Subcommands:/)
  assert.match(result.stdout, /receive\s+Import a Cashu token/)
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
      'markets',
      'list',
      '--search',
      'weather',
      '--limit',
      '5',
      '--state',
      'All',
    ])
    await runCli(daemonUrl, ['markets', 'show', 'condition-1'])
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
      'consolidate',
      'cond-YES',
      '--type',
      't2',
    ])
    await runCli(daemonUrl, [
      'order',
      'submit',
      'cond-YES',
      'YES',
      'Buy',
      '42',
      '100',
      'FAK',
    ])
    await runCli(daemonUrl, [
      'order',
      'submit',
      'cond-NO',
      'NO',
      'Buy',
      '55',
      '200',
      'GTC',
      '--no-preflight-split',
    ])
    await runCli(daemonUrl, [
      'order',
      'submit',
      'cond-A',
      'A',
      'Buy',
      '60',
      '100',
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
      'consolidate',
      'cond-A',
      '--type',
      't2',
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
      'consolidate',
      '--all',
      '--type',
      't3',
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
        assert.equal((err as { code?: unknown }).code, 1)
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
    daemonPid = Number(
      (await readFile(join(home, 'daemon-autostart.pid'), 'utf8')).trim(),
    )
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

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
