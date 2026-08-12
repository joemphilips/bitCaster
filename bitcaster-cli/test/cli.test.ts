import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { promisify } from 'node:util'
import {
  bootstrapFreshDaemonProfile,
  readBootstrappedProfileSecrets,
} from '../../bitcaster-daemon/src/profileBootstrap.ts'
import { isNetworkFailure } from '../src/rpc.ts'

const execFileAsync = promisify(execFile)

async function ensureRpcToken(): Promise<string> {
  const testRoot = process.env.BITCASTER_DAEMON_HOME
  if (!testRoot) throw new Error('BITCASTER_DAEMON_HOME is required by this test')
  const directory = join(testRoot, 'daemon-profile')
  process.env.BITCASTER_DAEMON_HOME = directory
  return (
    await bootstrapFreshDaemonProfile({
      directory,
      engineBaseUrl: 'https://engine.example',
      mintUrl: 'https://mint.example',
      walletSeedHex: 'ab'.repeat(64),
      nostrSecretKeyHex: '01'.padStart(64, '0'),
    })
  ).rpcToken
}

test('bitcaster-cli bin entrypoint is directly executable', async () => {
  const result = await execFileAsync(
    join(import.meta.dirname, '..', 'src', 'main.ts'),
    ['--help'],
    { env: process.env },
  )

  assert.match(result.stdout, /bitcaster-cli/)
  assert.match(result.stdout, /Commands:/)
  assert.match(result.stdout, /wallet\s+Manage wallet balance/)
  assert.doesNotMatch(result.stdout, /^\s+trade\s/m)
  await assert.rejects(
    () =>
      execFileAsync(join(import.meta.dirname, '..', 'src', 'main.ts'), ['trade', 'list'], {
        env: process.env,
      }),
    (error: unknown) => {
      assert.match((error as { stdout?: string }).stdout ?? '', /unknown command 'trade'/)
      return true
    },
  )
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
  assert.match(result.stdout, /receive(?: \[options\])?\s+Import a Cashu token/)
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
  const receivedTokenFile = join(home, 'received-token.cashu')
  await writeFile(receivedTokenFile, 'cashuBoGZha2U=', { mode: 0o600 })

  try {
    await runCli(daemonUrl, ['health'])
    await runCli(daemonUrl, ['daemon', 'status'])
    await runCli(daemonUrl, [
      'daemon',
      'config',
      '--engine-url',
      'https://engine.example',
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
    await runCli(daemonUrl, ['wallet', 'balance'])
    await runCli(daemonUrl, ['wallet', 'receive', '--token-file', receivedTokenFile])
    const outcomeTokenFile = join(home, 'outcome-token.cashu')
    await writeFile(outcomeTokenFile, 'cashuOutcomeToken=', { mode: 0o600 })
    await runCli(daemonUrl, [
      'wallet',
      'receive',
      '--token-file',
      outcomeTokenFile,
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
    await runCli(daemonUrl, ['wallet', 'recover'])
    await runCli(daemonUrl, ['wallet', 'reclaim', 'outgoing-transfer-1'])
    await runCli(daemonUrl, ['wallet', 'consolidate-proofs'])
    await runCli(daemonUrl, ['wallet', 'consolidate', 'cond-YES', '--strategy', 'sweep'])
    await runCli(daemonUrl, ['wallet', 'retire-condition', 'ab'.repeat(32)])
    await runCli(daemonUrl, ['wallet', 'retire-condition', 'cd'.repeat(32), '--acknowledge'])
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
      '--min-fill',
      '50',
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
    await runCli(daemonUrl, ['order', 'list', '--market', 'cond-YES', '--status', 'resting'])
    await runCli(daemonUrl, ['order', 'cancel', 'cond-YES', 'order-1'])
    await runCli(daemonUrl, ['order', 'book', 'cond-YES'])

    assert.deepEqual(received, [
      { method: 'health' },
      { method: 'daemon.status' },
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
      { method: 'wallet.reclaim', params: { transferId: 'outgoing-transfer-1' } },
      { method: 'wallet.consolidateProofs' },
      {
        method: 'wallet.consolidateMarket',
        params: { marketId: 'cond-YES', type: 't2' },
      },
      {
        method: 'wallet.retireCondition',
        params: { conditionId: 'ab'.repeat(32), acknowledge: false },
      },
      {
        method: 'wallet.retireCondition',
        params: { conditionId: 'cd'.repeat(32), acknowledge: true },
      },
      {
        method: 'order.submit',
        params: {
          marketId: 'cond-YES',
          outcomeId: 'YES',
          tokenSide: 'Outcome',
          side: 'Buy',
          price: 42,
          amountSubunits: 100,
          minimumFillAmountSubunits: 50,
          continueAfterPartialFill: false,
          consolidateProofs: false,
          timeInForce: 'FAK',
          expiresAt: null,
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
          amountSubunits: 200,
          continueAfterPartialFill: false,
          consolidateProofs: false,
          timeInForce: 'GTC',
          expiresAt: null,
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
          amountSubunits: 100,
          continueAfterPartialFill: false,
          consolidateProofs: false,
          timeInForce: 'FAK',
          expiresAt: null,
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

test('bitcaster-cli rejects an oversized private token file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-token-size-'))
  const tokenPath = join(home, 'oversized.cashu')
  try {
    const file = await open(tokenPath, 'w', 0o600)
    await file.truncate(4 * 1_024 * 1_024 + 1)
    await file.close()
    await assertCliFailure(
      ['wallet', 'receive', '--token-file', tokenPath],
      /token-file exceeds 4194304 bytes/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli rejects a group-readable token file', async () => {
  if (process.platform === 'win32') return
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-token-mode-'))
  const tokenPath = join(home, 'readable.cashu')
  try {
    await writeFile(tokenPath, 'cashuBoGZha2U=', { mode: 0o600 })
    await chmod(tokenPath, 0o640)
    await assertCliFailure(
      ['wallet', 'receive', '--token-file', tokenPath],
      /must not be accessible by group or other users/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli rejects a symlinked token file', async () => {
  if (process.platform === 'win32') return
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-token-link-'))
  const targetPath = join(home, 'target.cashu')
  const linkPath = join(home, 'link.cashu')
  try {
    await writeFile(targetPath, 'cashuBoGZha2U=', { mode: 0o600 })
    await symlink(targetPath, linkPath)
    await assertCliFailure(['wallet', 'receive', '--token-file', linkPath], /ELOOP|symbolic link/i)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli requires private token-file input and rejects bearer tokens in argv', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-token-source-'))
  const tokenPath = join(home, 'token.cashu')
  try {
    await writeFile(tokenPath, 'cashuBoGZha2U=', { mode: 0o600 })
    await assertCliFailure(['wallet', 'receive'], /requires --token-file/)
    await assertCliFailure(
      ['wallet', 'receive', 'cashuBinline', '--token-file', tokenPath],
      /too many arguments|excess arguments/i,
    )
    await assertCliFailure(
      ['wallet', 'receive', 'cashuBinline'],
      /too many arguments|excess arguments/i,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli exits non-zero when daemon returns ok false', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-daemon-error-'))
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
      () =>
        runCliWithEnv(['health'], {
          ...process.env,
          BITCASTER_CLI_HOME: home,
          BITCASTER_DAEMON_HOME: join(home, 'daemon-profile'),
          BITCASTER_TEST_DAEMON_URL: `http://127.0.0.1:${address.port}`,
        }),
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
    await rm(home, { recursive: true, force: true })
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
    assert.match(
      result.stderr,
      /Warning: skipped cond-A: market cond consolidation has no net collateral gain/,
    )
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
      () =>
        runCliWithOutput(`http://127.0.0.1:${address.port}`, ['wallet', 'consolidate', 'closed-A']),
      (err: unknown) => {
        assert.equal((err as { code?: unknown }).code, 1)
        assert.match((err as { stderr?: string }).stderr ?? '', /market closed is not pending/)
        assert.doesNotMatch(
          (err as { stderr?: string }).stderr ?? '',
          /secret|witness|mnemonic|nwc/i,
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
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-partial-token-'))
  const tokenPath = join(home, 'outcome.cashu')
  await writeFile(tokenPath, 'cashuOutcomeToken=', { mode: 0o600 })
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
          '--token-file',
          tokenPath,
          '--condition-id',
          'cond',
        ]),
      (err: unknown) => {
        assert.equal((err as { code?: unknown }).code, 2)
        const output = err as { stdout?: string; stderr?: string }
        assert.match(
          `${output.stdout ?? ''}\n${output.stderr ?? ''}`,
          /require both --condition-id and --outcome-set/,
        )
        return true
      },
    )
  } finally {
    server.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli uses default Unix socket RPC when no URL override is set', async () => {
  if (process.platform === 'win32') return

  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-socket-rpc-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  const token = await ensureRpcToken()
  const daemonHome = process.env.BITCASTER_DAEMON_HOME
  assert.ok(daemonHome)
  const socketPath = join(daemonHome, 'daemon.sock')
  let received: unknown = null
  let authorization: string | undefined
  const server = createServer(async (req, res) => {
    authorization = req.headers.authorization
    received = JSON.parse(await readBody(req))
    writeJson(res, 200, { ok: true, result: { socket: true } })
  })
  server.listen(socketPath)
  await once(server, 'listening')
  await chmod(socketPath, 0o600)

  try {
    const result = await runCliWithEnv(['health'], {
      ...process.env,
      BITCASTER_TEST_DAEMON_URL: undefined,
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

test('bitcaster-cli daemon init rejects secrets passed through argv', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-daemon-init-argv-'))
  try {
    await assert.rejects(
      () =>
        execFileAsync(
          process.execPath,
          [
            '--experimental-strip-types',
            join(import.meta.dirname, '..', 'src', 'main.ts'),
            'daemon',
            'init',
            '--wallet-seed-hex',
            'ab'.repeat(32),
          ],
          { env: { ...process.env, BITCASTER_DAEMON_HOME: home } },
        ),
      (error: unknown) => {
        const output = error as { stdout?: string; stderr?: string }
        assert.match(
          `${output.stdout ?? ''}${output.stderr ?? ''}`,
          /unknown option '--wallet-seed-hex'/,
        )
        return true
      },
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli daemon init delegates file-based setup/import to bitcaster-daemon', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-daemon-init-files-'))
  const daemonHome = join(home, 'daemon-profile')
  const walletSeedHex = 'ab'.repeat(64)
  const nostrSecretKeyHex = '01'.padStart(64, '0')
  const walletSeedFile = join(home, 'wallet-seed.hex')
  const nostrSecretKeyFile = join(home, 'nostr-secret-key.hex')

  try {
    await writeFile(walletSeedFile, `${walletSeedHex}\n`, { mode: 0o600 })
    await writeFile(nostrSecretKeyFile, `${nostrSecretKeyHex}\n`, {
      mode: 0o600,
    })
    await mkdir(daemonHome, { mode: 0o700 })
    await writeNativeConfigFixture(daemonHome, {
      engineUrl: 'https://engine.example',
      mintUrl: 'https://mint.example',
    })
    const result = await execFileAsync(
      process.execPath,
      [
        '--experimental-strip-types',
        join(import.meta.dirname, '..', 'src', 'main.ts'),
        '--datadir',
        daemonHome,
        'daemon',
        'init',
        '--wallet-seed-hex-file',
        walletSeedFile,
        '--nostr-secret-key-hex-file',
        nostrSecretKeyFile,
      ],
      {
        env: {
          ...process.env,
        },
      },
    )

    assert.match(result.stdout, /bitcaster-daemon profile initialized/)
    const secrets = await readBootstrappedProfileSecrets(daemonHome)
    assert.equal(secrets.walletSeedHex, walletSeedHex)
    assert.equal(secrets.nostrSecretKeyHex, nostrSecretKeyHex)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-daemon --datadir initializes only the selected directory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-datadir-'))
  const selected = join(home, 'selected')
  const ignored = join(home, 'ignored')
  try {
    const result = await execFileAsync(
      process.execPath,
      [
        '--experimental-strip-types',
        join(import.meta.dirname, '..', '..', 'bitcaster-daemon', 'src', 'main.ts'),
        '--datadir',
        selected,
        'init',
      ],
      { env: { ...process.env, BITCASTER_DAEMON_HOME: ignored } },
    )

    assert.match(result.stdout, /profile initialized/)
    assert.equal((await readdir(selected)).includes('daemon-state.sqlite'), true)
    await assert.rejects(() => readdir(ignored), /ENOENT/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli refuses ordinary commands when config.json is missing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-missing-config-'))
  try {
    await assert.rejects(
      () =>
        execFileAsync(
          process.execPath,
          [
            '--experimental-strip-types',
            join(import.meta.dirname, '..', 'src', 'main.ts'),
            '--datadir',
            home,
            'health',
          ],
          { env: { ...process.env } },
        ),
      (error: unknown) => {
        assert.match((error as { stderr?: string }).stderr ?? '', /native config is missing/)
        return true
      },
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli refuses legacy default config before creating the new profile', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-legacy-config-'))
  const legacy = join(home, '.bitcaster-cli')
  const selected = join(home, '.bitcaster')
  await mkdir(legacy, { mode: 0o700 })
  try {
    await assert.rejects(
      () =>
        execFileAsync(
          process.execPath,
          [
            '--experimental-strip-types',
            join(import.meta.dirname, '..', 'src', 'main.ts'),
            'daemon',
            'init',
          ],
          { env: { ...process.env, HOME: home } },
        ),
      (error: unknown) => {
        assert.match((error as { stderr?: string }).stderr ?? '', /legacy ~\/.bitcaster-cli/)
        return true
      },
    )
    await assert.rejects(() => stat(selected), /ENOENT/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli auto-starts default local daemon when RPC is unavailable', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-autostart-'))
  const env = {
    ...process.env,
    BITCASTER_TEST_DAEMON_URL: undefined,
  }
  let daemonPid: number | undefined
  try {
    await execFileAsync(
      process.execPath,
      [
        '--experimental-strip-types',
        join(import.meta.dirname, '..', 'src', 'main.ts'),
        '--datadir',
        home,
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
        '--datadir',
        home,
        'health',
      ],
      { env },
    )

    assert.equal(JSON.parse(result.stdout).ok, true)
    const profileArtifacts = await readdir(home)
    assert.equal(profileArtifacts.includes('config.json'), true)
    assert.equal(profileArtifacts.includes('daemon.log'), true)
    assert.equal(profileArtifacts.includes('daemon-autostart.pid'), true)
    assert.equal((await stat(join(home, 'daemon.sock'))).mode & 0o777, 0o600)
    daemonPid = JSON.parse((await readFile(join(home, 'daemon-autostart.pid'), 'utf8')).trim())
      .pid as number
    assert.equal(Number.isSafeInteger(daemonPid), true)
  } finally {
    if (daemonPid) await terminateProcess(daemonPid)
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
        dataDir: home,
      }) + '\n',
    )

    await assert.rejects(
      () => runCliWithEnv(['--datadir', home, 'daemon', 'stop'], process.env),
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

test('bitcaster-cli daemon stop does not signal a daemon for another data directory', async () => {
  if (process.platform === 'win32') return

  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-pid-datadir-'))
  const selected = join(home, 'selected')
  const other = `${selected}-other`
  const daemonMain = join(home, 'node_modules', '@bitcaster-market', 'daemon', 'dist', 'main.js')
  let childPid: number | undefined
  try {
    await mkdir(join(home, 'node_modules', '@bitcaster-market', 'daemon', 'dist'), {
      recursive: true,
    })
    await mkdir(selected, { recursive: true, mode: 0o700 })
    await writeFile(daemonMain, 'setInterval(() => {}, 1000)\n')
    const child = spawn(process.execPath, [daemonMain, `--datadir=${other}`, 'run'], {
      stdio: 'ignore',
    })
    assert.ok(child.pid)
    childPid = child.pid
    await waitForProcessStartTime(childPid)
    await writeFile(
      join(selected, 'daemon-autostart.pid'),
      JSON.stringify({
        pid: childPid,
        startedAt: await processStartTime(childPid),
        daemonMain,
        dataDir: other,
      }) + '\n',
    )

    const result = await runCliWithEnv(['--datadir', selected, 'daemon', 'stop'], process.env)

    assert.equal(result.stdout, 'daemon is not running\n')
    assert.equal(isProcessAliveForTest(childPid), true)
  } finally {
    if (childPid !== undefined) await terminateProcess(childPid)
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
    await mkdir(join(home, 'node_modules', '@bitcaster-market', 'daemon', 'dist'), {
      recursive: true,
    })
    await writeFile(daemonMain, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n")
    const child = spawn(process.execPath, [daemonMain, `--datadir=${home}`, 'run'], {
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
        dataDir: home,
      }) + '\n',
    )

    await assert.rejects(
      () => runCliWithEnv(['--datadir', home, 'daemon', 'stop'], process.env),
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
  const result = await execFileAsync(join(import.meta.dirname, '..', 'src', 'main.ts'), ['-V'], {
    env: process.env,
  })
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
  assert.match(result.stdout, /wallet-seed-hex-file/)
  assert.doesNotMatch(result.stdout, /--wallet-seed-hex <hex>/)
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
    const result = await runCliWithEnv(['--datadir', home, 'config', 'path'], {
      ...process.env,
    })
    assert.match(result.stdout, /config\.json/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli --datadir selects the shared config directory', async () => {
  const selected = await mkdtemp(join(tmpdir(), 'bitcaster-cli-datadir-'))
  const ignored = await mkdtemp(join(tmpdir(), 'bitcaster-cli-home-'))
  try {
    const result = await runCliWithEnv(['--datadir', selected, 'config', 'path'], {
      ...process.env,
      BITCASTER_DAEMON_HOME: ignored,
      BITCASTER_CLI_HOME: ignored,
    })
    assert.equal(result.stdout, `${join(selected, 'config.json')}\n`)
  } finally {
    await rm(selected, { recursive: true, force: true })
    await rm(ignored, { recursive: true, force: true })
  }
})

test('CLI and daemon reject missing or blank data-directory values', async () => {
  const cliMain = join(import.meta.dirname, '..', 'src', 'main.ts')
  const daemonMain = join(import.meta.dirname, '..', '..', 'bitcaster-daemon', 'src', 'main.ts')

  await assert.rejects(
    () =>
      execFileAsync(process.execPath, [
        '--experimental-strip-types',
        cliMain,
        '--datadir',
        '',
        'config',
        'path',
      ]),
    /data directory must not be empty/,
  )
  await assert.rejects(
    () => execFileAsync(process.execPath, ['--experimental-strip-types', daemonMain, '--datadir']),
    /Missing value for --datadir/,
  )
  await assert.rejects(
    () =>
      execFileAsync(process.execPath, [
        '--experimental-strip-types',
        cliMain,
        '--engine-url',
        'https://ignored.example',
        'config',
        'path',
      ]),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 2)
      assert.match((error as { stdout?: string }).stdout ?? '', /unknown option '--engine-url'/i)
      return true
    },
  )
  await assert.rejects(
    () =>
      execFileAsync(process.execPath, [
        '--experimental-strip-types',
        daemonMain,
        'init',
        '--mint-url',
        'https://ignored.example',
      ]),
    /Unknown init option: --mint-url/,
  )
})

test('bitcaster-cli config list rejects unknown config keys without rewriting', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-config-sanitize-'))
  const configPath = join(home, 'config.json')
  try {
    await writeFile(
      configPath,
      JSON.stringify(
        {
          ...nativeConfigFixture('https://engine.example', 'https://mint.example'),
          nostrSecretKeyHex: 'super-secret-key',
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    )

    await assert.rejects(
      () =>
        runCliWithEnv(['config', 'list'], {
          ...process.env,
          BITCASTER_DAEMON_HOME: home,
        }),
      /missing or unknown keys/,
    )
    assert.match(await readFile(configPath, 'utf8'), /super-secret-key/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli config set writes config without auto-starting an unreachable daemon', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-config-set-no-daemon-'))
  const configPath = join(home, 'config.json')
  try {
    const result = await runCliWithEnv(
      ['config', 'set', '--engine-url', 'https://engine.example'],
      {
        ...process.env,
        BITCASTER_DAEMON_HOME: home,
        BITCASTER_TEST_DAEMON_URL: 'http://127.0.0.1:1',
      },
    )

    assert.match(result.stderr, /config\.json updated; restart bitcaster-daemon/i)
    const parsed = JSON.parse(result.stdout) as {
      ok?: boolean
      result?: { config?: { engineUrl?: string } }
    }
    assert.equal(parsed.ok, true)
    assert.equal(parsed.result?.config?.engineUrl, 'https://engine.example')
    assert.deepEqual(
      JSON.parse(await readFile(configPath, 'utf8')),
      nativeConfigFixture('https://engine.example', 'http://localhost:8085'),
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli config set accepts both asset-monitoring privacy values and rejects others', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-config-monitoring-'))
  try {
    const env = {
      ...process.env,
      BITCASTER_DAEMON_HOME: home,
      BITCASTER_TEST_DAEMON_URL: 'http://127.0.0.1:1',
    }
    await runCliWithEnv(['config', 'set', '--asset-monitoring', 'enabled'], env)
    assert.equal(
      (
        JSON.parse(await readFile(join(home, 'config.json'), 'utf8')) as {
          daemon: { assetMonitoringEnabled: boolean }
        }
      ).daemon.assetMonitoringEnabled,
      true,
    )
    await runCliWithEnv(['config', 'set', '--asset-monitoring', 'disabled'], env)
    assert.equal(
      (
        JSON.parse(await readFile(join(home, 'config.json'), 'utf8')) as {
          daemon: { assetMonitoringEnabled: boolean }
        }
      ).daemon.assetMonitoringEnabled,
      false,
    )
    await assert.rejects(
      () => runCliWithEnv(['config', 'set', '--asset-monitoring', 'maybe'], env),
      /enabled or disabled/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli config set does not auto-start the daemon when autostart is otherwise enabled', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-config-set-autostart-enabled-'))
  const configPath = join(home, 'config.json')
  const autostartPidPath = join(home, 'daemon-autostart.pid')
  let daemonPid: number | undefined
  const env = {
    ...process.env,
    BITCASTER_DAEMON_HOME: home,
  }
  try {
    const result = await runCliWithEnv(
      ['config', 'set', '--engine-url', 'https://engine.example'],
      env,
    )

    const combinedOutput = `${result.stdout}\n${result.stderr}`
    assert.match(combinedOutput, /config\.json updated; restart bitcaster-daemon/i)
    assert.deepEqual(
      JSON.parse(await readFile(configPath, 'utf8')),
      nativeConfigFixture('https://engine.example', 'http://localhost:8085'),
    )
    await assert.rejects(
      () => stat(autostartPidPath),
      (err: unknown) =>
        typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT',
    )
  } finally {
    try {
      daemonPid = JSON.parse((await readFile(autostartPidPath, 'utf8')).trim()).pid as number
    } catch {
      // No auto-start PID was written.
    }
    if (daemonPid) await terminateProcess(daemonPid)
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
      BITCASTER_TEST_DAEMON_URL: 'http://127.0.0.1:1',
    })

    assert.deepEqual(
      JSON.parse(await readFile(configPath, 'utf8')),
      nativeConfigFixture('https://engine.example', 'http://localhost:8085'),
    )

    await assert.rejects(
      () =>
        runCliWithEnv(
          [
            'market',
            'create',
            '--condition-id',
            'cond-1',
            '--title',
            'Market',
            '--description',
            'Description',
            '--outcomes',
            'YES,NO',
            '--dry-run',
          ],
          {
            ...process.env,
            BITCASTER_DAEMON_HOME: home,
            BITCASTER_TEST_DAEMON_URL: 'http://127.0.0.1:1',
          },
        ),
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
    await runCliWithEnv(
      [
        'market',
        'create',
        '--condition-id',
        'cond-1',
        '--title',
        'Market',
        '--description',
        'Description',
        '--outcomes',
        'YES,NO',
        '--dry-run',
        '--trust-engine-url',
      ],
      {
        ...process.env,
        BITCASTER_DAEMON_HOME: home,
        BITCASTER_TEST_ENGINE_URL: 'https://engine.example',
        BITCASTER_TEST_DAEMON_URL: 'http://127.0.0.1:1',
      },
    )

    assert.deepEqual(
      JSON.parse(await readFile(configPath, 'utf8')),
      nativeConfigFixture('https://engine.example', 'http://localhost:8085', [
        'https://engine.example',
      ]),
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli config list does not rewrite already sanitized config', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-config-no-rewrite-'))
  const configPath = join(home, 'config.json')
  const configText =
    JSON.stringify(
      nativeConfigFixture('https://engine.example', 'https://mint.example', [
        'https://trusted-engine.example',
      ]),
      null,
      2,
    ) + '\n'
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
      assetMonitoringEnabled: false,
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
          BITCASTER_TEST_DAEMON_URL: 'http://127.0.0.1:9',
        }),
      (err: unknown) => {
        const stderr = (err as { stderr?: string }).stderr ?? ''
        const parsed = JSON.parse(stderr) as { ok?: boolean; error?: string; hint?: string }
        assert.equal(parsed.ok, false)
        assert.match(parsed.error ?? '', /daemon not reachable|daemon is not running/i)
        assert.equal(parsed.hint, "Run 'bitcaster daemon init' and verify the selected --datadir.")
        assert.doesNotMatch(stderr, /triggerUncaughtException|TypeError|ECONNREFUSED/)
        return true
      },
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('P47-3: market list with a configured engine calls it without daemon RPC', async () => {
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
      ['market', 'list', '--search', 'weather', '--limit', '5', '--state', 'All'],
      {
        ...process.env,
        BITCASTER_TEST_ENGINE_URL: `http://127.0.0.1:${engineAddress.port}`,
        BITCASTER_TEST_DAEMON_URL: `http://127.0.0.1:${daemonAddress.port}`,
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

test('P47-3 regression: market show with a configured engine prints one query result', async () => {
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
    const result = await runCliWithEnv(['market', 'show', 'condition-1'], {
      ...process.env,
      BITCASTER_TEST_ENGINE_URL: `http://127.0.0.1:${engineAddress.port}`,
      BITCASTER_TEST_DAEMON_URL: `http://127.0.0.1:${daemonAddress.port}`,
    })

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
      () =>
        runCliWithEnv(['market', 'list'], {
          ...process.env,
          BITCASTER_TEST_ENGINE_URL: `http://127.0.0.1:${engineAddress.port}`,
          BITCASTER_TEST_DAEMON_URL: `http://127.0.0.1:${daemonAddress.port}`,
        }),
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
    assert.equal(
      req.url,
      '/api/v1/markets/query?sort=Trending&tag=sports&creator_pubkey=npub1creator&cursor=page-2',
    )
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
        BITCASTER_TEST_ENGINE_URL: `http://127.0.0.1:${engineAddress.port}`,
        BITCASTER_TEST_DAEMON_URL: `http://127.0.0.1:${daemonAddress.port}`,
      },
    )

    assert.deepEqual(engineRequests, [
      {
        method: 'GET',
        url: '/api/v1/markets/query?sort=Trending&tag=sports&creator_pubkey=npub1creator&cursor=page-2',
      },
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
        BITCASTER_TEST_DAEMON_URL: `http://127.0.0.1:${daemonAddress.port}`,
        BITCASTER_TEST_ENGINE_URL: undefined,
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
    writeJson(res, 200, {
      ok: true,
      result: { markets: [{ conditionId: 'from-daemon' }], nextCursor: null },
    })
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
    const result = await runCliWithEnv(['market', 'list', '--sort', 'Trending'], {
      ...process.env,
      BITCASTER_TEST_ENGINE_URL: `http://127.0.0.1:${engineAddress.port}`,
      BITCASTER_TEST_DAEMON_URL: `http://127.0.0.1:${daemonAddress.port}`,
    })
    const elapsedMs = Date.now() - startedAt

    assert.ok(
      elapsedMs >= 4_500,
      `expected direct engine timeout to wait about 5s, got ${elapsedMs}ms`,
    )
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      result: { markets: [{ conditionId: 'from-daemon' }], nextCursor: null },
    })
    assert.match(result.stderr, /falling back to daemon/)
    assert.deepEqual(engineRequests, [
      { method: 'GET', url: '/api/v1/markets/query?sort=Trending' },
    ])
    assert.deepEqual(received, [{ method: 'markets.query', params: { sort: 'Trending' } }])
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
    () =>
      runCliWithEnv(['market', 'list', '--sort', 'Hot'], {
        ...process.env,
        BITCASTER_TEST_DAEMON_URL: 'http://127.0.0.1:9',
        BITCASTER_TEST_ENGINE_URL: undefined,
      }),
    (err: unknown) => {
      assert.equal((err as { code?: unknown }).code, 2)
      assert.match((err as { stderr?: string }).stderr ?? '', /Invalid market sort: Hot/)
      return true
    },
  )
})

test('P47-3: market list falls back to daemon RPC when the configured engine is unavailable', async () => {
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
    await runCliWithEnv(
      ['market', 'list', '--search', 'weather', '--limit', '5', '--state', 'All'],
      {
        ...process.env,
        BITCASTER_TEST_DAEMON_URL: `http://127.0.0.1:${daemonAddress.port}`,
        BITCASTER_TEST_ENGINE_URL: undefined,
      },
    )

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

test('P47-3: order book with a configured engine calls it without daemon RPC', async () => {
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
    const result = await runCliWithEnv(['order', 'book', 'cond-YES'], {
      ...process.env,
      BITCASTER_TEST_ENGINE_URL: `http://127.0.0.1:${engineAddress.port}`,
      BITCASTER_TEST_DAEMON_URL: `http://127.0.0.1:${daemonAddress.port}`,
    })

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
    await runCli(`http://127.0.0.1:${address.port}`, [
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
      '--continue-after-partial-fill',
      '--consolidate-proofs',
      '--no-preflight-split',
    ])
    await runCli(`http://127.0.0.1:${address.port}`, [
      'order',
      'submit',
      '--market',
      'cond-GTD',
      '--outcome',
      'GTD',
      '--side',
      'Sell',
      '--price',
      '40',
      '--amount',
      '100',
      '--tif',
      'GTD',
      '--expires-at',
      '2030-01-01T00:00:00Z',
      '--continue-after-partial-fill',
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
          amountSubunits: 100,
          continueAfterPartialFill: false,
          consolidateProofs: false,
          timeInForce: 'FAK',
          expiresAt: null,
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
          amountSubunits: 200,
          continueAfterPartialFill: true,
          consolidateProofs: true,
          timeInForce: 'GTC',
          expiresAt: null,
          preflightSplit: false,
        },
      },
      {
        method: 'order.submit',
        params: {
          marketId: 'cond-GTD',
          outcomeId: 'GTD',
          tokenSide: 'Outcome',
          side: 'Sell',
          price: 40,
          amountSubunits: 100,
          continueAfterPartialFill: true,
          consolidateProofs: false,
          timeInForce: 'GTD',
          expiresAt: '2030-01-01T00:00:00.000Z',
          preflightSplit: true,
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
      result: {
        marketId: 'cond-A',
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
    await runCli(`http://127.0.0.1:${address.port}`, [
      'wallet',
      'consolidate',
      'cond-A',
      '--strategy',
      'merge',
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
      result: {
        marketId: 'cond-A',
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
    await runCli(`http://127.0.0.1:${address.port}`, [
      'wallet',
      'consolidate',
      'cond-A',
      '--strategy',
      'sweep',
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
      result: {
        marketId: 'cond-A',
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
    await runCli(`http://127.0.0.1:${address.port}`, ['wallet', 'consolidate', 'cond-A'])
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
  assert.match(
    result.stdout,
    /merge\s+- Merge singletons \+ collateral into the missing complement set/,
  )
  assert.match(
    result.stdout,
    /sweep\s+- Extract collateral from overlapping complement collections/,
  )
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
    await runCli(`http://127.0.0.1:${address.port}`, ['wallet', 'split', 'cond-1', '100'])
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
    await runCliWithEnv(
      [
        'market',
        'create',
        '--condition-id',
        'cond-1',
        '--title',
        'Will it rain?',
        '--description',
        'Weather market',
        '--outcomes',
        'YES,NO,MAYBE',
        '--liquidity-sats',
        '1000',
        '--tag',
        'weather',
        '--tag',
        'test',
        '--thumbnail',
        '/tmp/thumb.png',
        '--trust-engine-url',
      ],
      {
        ...process.env,
        BITCASTER_CLI_HOME: home,
        BITCASTER_TEST_DAEMON_URL: `http://127.0.0.1:${address.port}`,
        BITCASTER_TEST_ENGINE_URL: 'https://engine.example',
      },
    )

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
      'market',
      'close',
      '--condition-id',
      'cond-1',
      '--attestation',
      `@${attestationPath}`,
      '--trust-engine-url',
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
      'market',
      'close',
      '--condition-id',
      'cond-1',
      '--attestation',
      JSON.stringify(attestation),
      '--trust-engine-url',
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
    () =>
      runCliWithEnv(
        [
          'market',
          'close',
          '--condition-id',
          'cond-1',
          '--attestation',
          '@../attestation.json',
          '--trust-engine-url',
        ],
        {
          ...process.env,
          BITCASTER_TEST_DAEMON_URL: 'http://127.0.0.1:9',
        },
      ),
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
      () =>
        runCliWithEnv(
          [
            'market',
            'close',
            '--condition-id',
            'cond-1',
            '--attestation',
            invalidCase.attestation,
            '--trust-engine-url',
          ],
          {
            ...process.env,
            BITCASTER_TEST_DAEMON_URL: 'http://127.0.0.1:9',
          },
        ),
      (err: unknown) => {
        assert.equal((err as { code?: unknown }).code, 3, invalidCase.name)
        assert.match(
          (err as { stderr?: string }).stderr ?? '',
          invalidCase.stderr,
          invalidCase.name,
        )
        return true
      },
      invalidCase.name,
    )
  }
})

test('P47-6b: native config refuses a remote plain HTTP engine URL', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-market-create-http-'))
  try {
    await assert.rejects(
      () =>
        runCliWithEnv(
          [
            'market',
            'create',
            '--condition-id',
            'cond-1',
            '--title',
            'Market',
            '--description',
            'Description',
            '--outcomes',
            'YES,NO',
            '--trust-engine-url',
          ],
          {
            ...process.env,
            BITCASTER_DAEMON_HOME: home,
            BITCASTER_TEST_DAEMON_URL: 'http://127.0.0.1:9',
            BITCASTER_TEST_ENGINE_URL: 'http://engine.example',
          },
        ),
      (err: unknown) => {
        assert.equal((err as { code?: unknown }).code, 1)
        assert.match(
          (err as { stderr?: string }).stderr ?? '',
          /expected https or loopback http URL/,
        )
        return true
      },
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('P47-7: bitcaster-cli order submit --dry-run prints payload without calling daemon', async () => {
  const result = await runCliWithOutput('http://127.0.0.1:1', [
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
    '--min-fill',
    '50',
    '--tif',
    'FAK',
    '--token-side',
    'Complement',
    '--dry-run',
  ])
  assert.deepEqual(JSON.parse(result.stdout), {
    marketId: 'cond-YES',
    outcomeId: 'YES',
    tokenSide: 'Complement',
    side: 'Buy',
    price: 42,
    amountSubunits: 100,
    minimumFillAmountSubunits: 50,
    continueAfterPartialFill: false,
    consolidateProofs: false,
    timeInForce: 'FAK',
    expiresAt: null,
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
      args: [
        'market',
        'create',
        '--condition-id',
        'cond-1',
        '--title',
        'Market',
        '--description',
        'Description',
        '--outcomes',
        'YES,NO',
        '--liquidity-sats',
        '1000',
        '--trust-engine-url',
        '--dry-run',
      ],
      expected: {
        conditionId: 'cond-1',
        title: 'Market',
        description: 'Description',
        outcomes: ['YES', 'NO'],
        liquiditySats: 1000,
      },
    },
    {
      args: [
        'market',
        'close',
        '--condition-id',
        'cond-1',
        '--attestation',
        JSON.stringify(attestation),
        '--trust-engine-url',
        '--dry-run',
      ],
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
    assert.doesNotMatch(
      result.stdout,
      /secret|witness|mnemonic|nwc|authorization|sig|nostrSecretKeyHex/i,
    )
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
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(directory, entry.name)
      if (entry.isDirectory()) return sourceTsFiles(entryPath)
      if (entry.isFile() && entry.name.endsWith('.ts')) return [entryPath]
      return []
    }),
  )
  return files.flat().sort()
}

async function runCli(daemonUrl: string, args: string[]): Promise<void> {
  const result = await runCliWithOutput(daemonUrl, args)
  const parsed = JSON.parse(result.stdout) as { ok?: boolean }
  assert.equal(parsed.ok, true)
}

async function writeNativeConfigFixture(
  directory: string,
  endpoints: { engineUrl: string; mintUrl: string },
  trustedEngineUrls: string[] = [],
): Promise<void> {
  await writeFile(
    join(directory, 'config.json'),
    `${JSON.stringify(nativeConfigFixture(endpoints.engineUrl, endpoints.mintUrl, trustedEngineUrls), null, 2)}\n`,
    { mode: 0o600 },
  )
}

function nativeConfigFixture(
  engineUrl: string,
  mintUrl: string,
  trustedEngineUrls: string[] = [],
): object {
  return {
    version: 2,
    daemon: {
      engineUrl,
      mintUrl,
      autoRetireResolvedConditionInventory: false,
      assetMonitoringEnabled: false,
    },
    cli: { trustedEngineUrls },
  }
}

async function runCliWithOutput(
  daemonUrl: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return runCliWithEnv(args, {
    ...process.env,
    BITCASTER_TEST_DAEMON_URL: daemonUrl,
  })
}

async function runCliWithEnv(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  const effectiveArgs = [...args]
  const effectiveEnv = { ...env }
  let transientDataDir: string | undefined
  let selectedDataDir = env.BITCASTER_DAEMON_HOME ?? env.BITCASTER_CLI_HOME
  if (selectedDataDir === undefined) {
    transientDataDir = await mkdtemp(join(tmpdir(), 'bitcaster-cli-test-datadir-'))
    selectedDataDir = transientDataDir
  }
  if (selectedDataDir !== undefined && !effectiveArgs.includes('--datadir')) {
    effectiveArgs.unshift('--datadir', selectedDataDir)
  }
  if (selectedDataDir !== undefined) {
    const configPath = join(selectedDataDir, 'config.json')
    if (
      !(await fileExists(configPath)) ||
      effectiveEnv.BITCASTER_TEST_ENGINE_URL !== undefined ||
      effectiveEnv.BITCASTER_TEST_MINT_URL !== undefined
    ) {
      await mkdir(selectedDataDir, { recursive: true, mode: 0o700 })
      await chmod(selectedDataDir, 0o700)
      await writeFile(
        configPath,
        `${JSON.stringify(
          nativeConfigFixture(
            effectiveEnv.BITCASTER_TEST_ENGINE_URL ?? 'http://localhost:5000',
            effectiveEnv.BITCASTER_TEST_MINT_URL ?? 'http://localhost:8085',
          ),
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      )
    }
  }
  effectiveEnv.NODE_NO_WARNINGS = '1'
  try {
    return await execFileAsync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--import',
        join(import.meta.dirname, 'rpcTransportTestSetup.ts'),
        join(import.meta.dirname, '..', 'src', 'main.ts'),
        ...effectiveArgs,
      ],
      { env: effectiveEnv },
    )
  } finally {
    if (transientDataDir !== undefined) {
      await rm(transientDataDir, { recursive: true, force: true })
    }
  }
}

async function assertCliFailure(args: string[], expected: RegExp): Promise<void> {
  await assert.rejects(
    () =>
      runCliWithEnv(args, {
        ...process.env,
        BITCASTER_TEST_DAEMON_URL: 'http://127.0.0.1:1',
      }),
    (err: unknown) => {
      const output = err as { stdout?: string; stderr?: string }
      assert.match(`${output.stdout ?? ''}\n${output.stderr ?? ''}`, expected)
      return true
    },
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

function isProcessAliveForTest(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function terminateProcess(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM')
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ESRCH') {
      return
    }
    throw err
  }
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await isZombieProcess(pid)) return
    try {
      process.kill(pid, 0)
    } catch (err) {
      if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ESRCH') {
        return
      }
      throw err
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`process ${pid} did not exit after SIGTERM`)
}

async function isZombieProcess(pid: number): Promise<boolean> {
  if (process.platform !== 'linux') return false
  try {
    const statText = await readFile(`/proc/${pid}/stat`, 'utf8')
    const closeParen = statText.lastIndexOf(')')
    if (closeParen === -1) return false
    return (
      statText
        .slice(closeParen + 2)
        .trim()
        .split(/\s+/, 1)[0] === 'Z'
    )
  } catch {
    return false
  }
}

async function processStartTime(pid: number): Promise<string | null> {
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

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
