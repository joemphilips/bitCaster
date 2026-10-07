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
import { EventEmitter, once } from 'node:events'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { finalizeEvent } from 'nostr-tools/pure'
import {
  bootstrapFreshDaemonProfile,
  readBootstrappedProfileSecrets,
} from '../../bitcaster-daemon/src/profileBootstrap.ts'
import { isNetworkFailure, readDaemonRpcResponse } from '../src/rpc.ts'
import type { ScorePurchaseConsent } from '../../bitcaster-daemon/src/protocol.ts'

const execFileAsync = promisify(execFile)

test('Unix daemon RPC response abort and stream errors reject the pending read', async () => {
  const abortedResponse = new EventEmitter()
  const abortedRead = readDaemonRpcResponse(abortedResponse as never)
  abortedResponse.emit('data', Buffer.from('{"ok":'))
  abortedResponse.emit('aborted')
  await assert.rejects(abortedRead, /daemon RPC response was aborted/)

  const failedResponse = new EventEmitter()
  const failedRead = readDaemonRpcResponse(failedResponse as never)
  failedResponse.emit('error', new Error('response stream failed'))
  await assert.rejects(failedRead, /response stream failed/)
})

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

test('bitcaster-cli Score quote can be saved and reused for buy and status', async () => {
  if (process.platform === 'win32') return
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-score-consent-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  await ensureRpcToken()
  const received: Array<{ method: string; params?: Record<string, unknown> }> = []
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/rpc') {
      writeJson(res, 404, { ok: false, error: 'not found' })
      return
    }
    const command = JSON.parse(await readBody(req)) as {
      method: string
      params?: Record<string, unknown>
    }
    received.push(command)
    if (command.method === 'score.quote') {
      const params = command.params!
      const scorePoints = params.scorePoints as number
      const amountMsat = scorePoints * 1_000
      writeJson(res, 200, {
        ok: true,
        result: {
          request: {
            deliveryId: params.deliveryId,
            scorePoints,
            amountMsat,
            purchasedTotalEpoch: 3,
            engineBaseUrl: 'https://engine.example',
            accountSubject: '02'.repeat(32),
            walletId: '03'.repeat(32),
            mintUrl: 'https://mint.example',
          },
          cost: {
            amountMsat,
            sendPreparationFeeMsat: 2,
            totalWalletDebitMsat: amountMsat + 2,
          },
        },
      })
      return
    }
    writeJson(res, 200, { ok: true, result: { method: command.method } })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.equal(typeof address, 'object')
  assert.ok(address)
  const consentPath = join(home, 'score-quote.json')

  try {
    await runCli(`http://127.0.0.1:${address.port}`, ['score', 'show'])
    const quote = await runCliWithOutput(`http://127.0.0.1:${address.port}`, [
      'score',
      'quote',
      '3',
    ])
    const envelope = JSON.parse(quote.stdout) as { ok: boolean; result: ScorePurchaseConsent }
    assert.equal(envelope.ok, true)
    assert.equal(envelope.result.request.scorePoints, 3)
    assert.equal(envelope.result.request.amountMsat, 3_000)
    await writeFile(consentPath, JSON.stringify(envelope), { mode: 0o600 })
    await runCli(`http://127.0.0.1:${address.port}`, [
      'score',
      'buy',
      '--fee-consent-file',
      consentPath,
    ])
    await runCli(`http://127.0.0.1:${address.port}`, [
      'score',
      'status',
      '--fee-consent-file',
      consentPath,
    ])

    assert.deepEqual(received[0], { method: 'score.show' })
    assert.equal(received[1]?.method, 'score.quote')
    assert.equal(received[1]?.params?.scorePoints, 3)
    assert.match(received[1]?.params?.deliveryId as string, /^[0-9a-f-]{36}$/)
    assert.deepEqual(received[2], { method: 'score.buy', params: { consent: envelope.result } })
    assert.deepEqual(received[3], { method: 'score.status', params: { consent: envelope.result } })
  } finally {
    server.close()
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli order submit help is FOK-only and has no time-in-force choice', async () => {
  const result = await execFileAsync(
    join(import.meta.dirname, '..', 'src', 'main.ts'),
    ['order', 'submit', '--help'],
    { env: process.env },
  )

  assert.match(result.stdout, /order submit/)
  assert.doesNotMatch(result.stdout, /--tif|time in force/i)
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
  const feeConsentPath = join(home, 'fee-consent.json')
  const feeConsent = orderFeeConsentEnvelope({})
  await writeFile(feeConsentPath, JSON.stringify(feeConsent), { mode: 0o600 })

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
    await runCli(daemonUrl, ['wallet', 'positions'])
    await runCli(daemonUrl, ['wallet', 'portfolio', '--timeframe', '1W', '--page-size', '200'])
    await runCli(daemonUrl, ['wallet', 'assets'])
    await runCli(daemonUrl, ['wallet', 'assets', '--cursor', 'opaque/page +=', '--page-size', '75'])
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
      '--amount-msat',
      '100',
      '--min-fill-msat',
      '50',
      '--fee-consent-file',
      feeConsentPath,
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
      '--amount-msat',
      '200',
      '--fee-consent-file',
      feeConsentPath,
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
      '--amount-msat',
      '100',
      '--token-side',
      'Complement',
      '--fee-consent-file',
      feeConsentPath,
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
      { method: 'wallet.positions' },
      { method: 'wallet.portfolio', params: { timeframe: '1W', pageSize: 200 } },
      { method: 'wallet.assets' },
      { method: 'wallet.assets', params: { cursor: 'opaque/page +=', pageSize: 75 } },
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
        params: { amountMsat: 25_000, mintUrl: 'mint-a', operationId: 'wallet-send-1' },
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
          consolidateProofs: false,
          timeInForce: 'FOK',
          expiresAt: null,
          feeConsent: feeConsent.result,
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
          consolidateProofs: false,
          timeInForce: 'FOK',
          expiresAt: null,
          feeConsent: feeConsent.result,
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
          consolidateProofs: false,
          timeInForce: 'FOK',
          expiresAt: null,
          feeConsent: feeConsent.result,
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

test('wallet portfolio and assets CLI bound their query options', async () => {
  await assertCliFailure(
    ['wallet', 'portfolio', '--timeframe', '1Y'],
    /Invalid portfolio timeframe: 1Y/,
  )
  await assertCliFailure(
    ['wallet', 'portfolio', '--page-size', '201'],
    /page size: 201 \(must be 1\.\.200\)/,
  )
  await assertCliFailure(
    ['wallet', 'assets', '--page-size', '201'],
    /page size: 201 \(must be 1\.\.200\)/,
  )
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
        convertFeeMsat: 1,
        collateralReturnedMsat: 2,
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

for (const [option, value] of [
  ['--wallet-seed-hex', 'ab'.repeat(32)],
  ['--nostr-secret-key-hex', '01'.padStart(64, '0')],
  ['--force', undefined],
] as const) {
  test(`bitcaster-cli daemon init rejects unsupported ${option}`, async () => {
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
              option,
              ...(value === undefined ? [] : [value]),
            ],
            { env: { ...process.env, BITCASTER_DAEMON_HOME: home } },
          ),
        (error: unknown) => {
          const output = error as { stdout?: string; stderr?: string }
          assert.ok(
            `${output.stdout ?? ''}${output.stderr ?? ''}`.includes(`unknown option '${option}'`),
          )
          return true
        },
      )
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
}

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
  assert.doesNotMatch(result.stdout, /--force/)
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

test('market create and close reuse one canonical trusted engine URL', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-trusted-engine-idempotent-'))
  const configPath = join(home, 'config.json')
  const createCommand = {
    method: 'market.create',
    params: {
      conditionId: 'cond-1',
      title: 'Market',
      description: 'Description',
      outcomes: ['YES', 'NO'],
    },
  }
  const attestCommand = {
    method: 'market.attest',
    params: { conditionId: 'cond-1', outcome: 'Yes' },
  }

  const envForRpc = (command: object) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BITCASTER_DAEMON_HOME: home,
      BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
      BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([
        { command, response: { ok: true, result: { result: 'ok' } } },
      ]),
    }
    delete env.BITCASTER_TEST_ENGINE_URL
    delete env.BITCASTER_TEST_MINT_URL
    return env
  }

  try {
    await writeNativeConfigFixture(home, {
      engineUrl: 'https://engine.example/',
      mintUrl: 'https://mint.example',
    })
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
        '--trust-engine-url',
      ],
      envForRpc(createCommand),
    )

    const trustedAfterCreate = JSON.parse(await readFile(configPath, 'utf8')) as {
      cli: { trustedEngineUrls: string[] }
    }
    assert.deepEqual(trustedAfterCreate.cli.trustedEngineUrls, ['https://engine.example'])

    const closeArgs = [
      'market',
      'close',
      '--condition-id',
      'cond-1',
      '--outcome',
      'Yes',
      '--trust-engine-url',
    ]
    await runCliWithEnv(closeArgs, envForRpc(attestCommand))
    await runCliWithEnv(
      closeArgs.filter((arg) => arg !== '--trust-engine-url'),
      envForRpc(attestCommand),
    )

    const finalConfig = JSON.parse(await readFile(configPath, 'utf8')) as {
      cli: { trustedEngineUrls: string[] }
    }
    assert.deepEqual(finalConfig.cli.trustedEngineUrls, ['https://engine.example'])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('market close requires trust for a different engine origin or base path', async () => {
  for (const engineUrl of ['https://other-engine.example', 'https://engine.example/api']) {
    const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-trusted-engine-distinct-'))
    try {
      await writeNativeConfigFixture(home, { engineUrl, mintUrl: 'https://mint.example' }, [
        'https://engine.example',
      ])
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        BITCASTER_DAEMON_HOME: home,
        BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
        BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([]),
      }
      delete env.BITCASTER_TEST_ENGINE_URL
      delete env.BITCASTER_TEST_MINT_URL

      await assert.rejects(
        runCliWithEnv(['market', 'close', '--condition-id', 'cond-1', '--outcome', 'Yes'], env),
        (err: unknown) => {
          assert.equal((err as { code?: unknown }).code, 3)
          assert.match((err as { stderr?: string }).stderr ?? '', /without --trust-engine-url/)
          return true
        },
      )
      const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8')) as {
        cli: { trustedEngineUrls: string[] }
      }
      assert.deepEqual(config.cli.trustedEngineUrls, ['https://engine.example'])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
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

test('market comments reads public coordinates as JSON without a wallet or daemon', async () => {
  const fixtureModule = `data:text/javascript,${encodeURIComponent(`
    globalThis.fetch = async (input, init) => {
      if (String(input) !== 'https://engine.example/api/v1/markets/condition-1/comments') {
        throw new Error('Unexpected engine request: ' + String(input))
      }
      if (init?.method !== undefined && init.method !== 'GET') {
        throw new Error('Expected an anonymous GET request')
      }
      if (new Headers(init?.headers).has('authorization')) {
        throw new Error('Public comments must not require authorization')
      }
      return new Response(process.env.BITCASTER_TEST_COMMENTS_JSON, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
  `)}`
  const confirmed = {
    conditionId: 'condition-1',
    snapshotEventOrder: 'source-43',
    comments: [
      {
        commentId: '8f7a9a9e-8f8f-43d7-9d25-7d79c09bd6a2',
        content: 'confirmed',
        createdAt: '2026-05-25T10:00:00Z',
        authorPubkey: 'a'.repeat(64),
        trade: {
          fillId: '56ab09f2-4ce0-4f37-80ad-8d5846476042',
          outcomeId: 'YES',
          executedAt: '2026-05-25T10:01:00Z',
          price: 420,
          priceDenominator: 1000,
        },
      },
    ],
  }
  const withoutCoordinate = {
    ...confirmed,
    comments: [{ ...confirmed.comments[0], trade: null }],
  }

  for (const response of [confirmed, withoutCoordinate]) {
    const result = await runCliWithEnv(['market', 'comments', 'condition-1'], {
      ...process.env,
      BITCASTER_TEST_ENGINE_URL: 'https://engine.example',
      BITCASTER_TEST_DAEMON_URL: 'http://127.0.0.1:1',
      BITCASTER_TEST_FETCH_MODULE: fixtureModule,
      BITCASTER_TEST_COMMENTS_JSON: JSON.stringify(response),
    })
    assert.deepEqual(JSON.parse(result.stdout), response)
    assert.equal(result.stderr, '')
  }
})

test('market comments uses the default engine URL without a config file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-public-comments-'))
  const response = { conditionId: 'condition-1', comments: [] }
  const fixtureModule = `data:text/javascript,${encodeURIComponent(`
    globalThis.fetch = async (input, init) => {
      if (String(input) !== 'http://localhost:5000/api/v1/markets/condition-1/comments') {
        throw new Error('Unexpected default engine request: ' + String(input))
      }
      if (new Headers(init?.headers).has('authorization')) {
        throw new Error('Public comments must not require authorization')
      }
      return new Response(${JSON.stringify(JSON.stringify(response))}, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
  `)}`
  try {
    assert.equal(await fileExists(join(home, 'config.json')), false)
    const result = await execFileAsync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--import',
        fixtureModule,
        join(import.meta.dirname, '..', 'src', 'main.ts'),
        '--datadir',
        home,
        'market',
        'comments',
        'condition-1',
      ],
      { env: { ...process.env, NODE_NO_WARNINGS: '1' } },
    )
    assert.deepEqual(JSON.parse(result.stdout), response)
    assert.equal(result.stderr, '')
    assert.equal(await fileExists(join(home, 'config.json')), false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('mint info reads public metadata by explicit URL without config or daemon state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-public-mint-'))
  const mintUrl = 'https://mint.example'
  const responses = publicMintMetadataResponses(mintUrl)
  try {
    const configPath = join(home, 'config.json')
    assert.equal(await fileExists(configPath), false)
    const result = await execFileAsync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--import',
        publicMintFetchModule(mintUrl, responses),
        join(import.meta.dirname, '..', 'src', 'main.ts'),
        '--datadir',
        home,
        'mint',
        'info',
        mintUrl,
      ],
      {
        env: {
          ...process.env,
          BITCASTER_TEST_DAEMON_URL: 'http://127.0.0.1:1',
          NODE_NO_WARNINGS: '1',
        },
      },
    )

    assert.deepEqual(JSON.parse(result.stdout), {
      mintUrl,
      info: responses[`${mintUrl}/v1/info`],
      keysets: responses[`${mintUrl}/v1/keysets`].keysets,
      keys: responses[`${mintUrl}/v1/keys`].keysets,
    })
    assert.equal(result.stderr, '')
    assert.equal(await fileExists(configPath), false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('mint info uses the configured mint URL without changing config', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-configured-mint-'))
  const mintUrl = 'https://configured-mint.example'
  const configPath = join(home, 'config.json')
  const configText =
    JSON.stringify(nativeConfigFixture('https://engine.example', mintUrl), null, 2) + '\n'
  try {
    await writeFile(configPath, configText, { mode: 0o600 })
    const responses = publicMintMetadataResponses(mintUrl)
    const result = await runCliWithEnv(['mint', 'info'], {
      ...process.env,
      BITCASTER_DAEMON_HOME: home,
      BITCASTER_TEST_DAEMON_URL: 'http://127.0.0.1:1',
      BITCASTER_TEST_FETCH_MODULE: publicMintFetchModule(mintUrl, responses),
    })

    assert.equal(JSON.parse(result.stdout).mintUrl, mintUrl)
    assert.equal(result.stderr, '')
    assert.equal(await readFile(configPath, 'utf8'), configText)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('mint info rejects non-loopback HTTP URLs before making a request', async () => {
  await assertCliFailure(
    ['mint', 'info', 'http://mint.example'],
    /Public mint reads require an https or loopback http URL/,
  )
})

test('market history exposes every public timeframe and preserves all outcome-series fields anonymously', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-public-history-'))
  const point = {
    eventOrder: '00000000000000000042',
    timestamp: '2026-09-01T12:00:00Z',
    price: 420,
    volumeSubunits: 12_500,
    source: 'fill',
  }
  try {
    assert.equal(await fileExists(join(home, 'config.json')), false)
    for (const [option, timeframe] of [
      [[], '7d'],
      [['--timeframe', '1h'], '1h'],
      [['--timeframe', '24h'], '24h'],
      [['--timeframe', '7d'], '7d'],
      [['--timeframe', '30d'], '30d'],
      [['--timeframe', 'all'], 'all'],
    ] as const) {
      const response = {
        conditionId: 'condition-1',
        timeframe,
        snapshotEventOrder: 'source-42',
        asOf: '2026-10-03T00:00:00Z',
        outcomes: [
          { outcomeId: 'YES', data: [point] },
          { outcomeId: 'NO', data: [] },
        ],
      }
      const result = await runDefaultPublicEngineReadCli(
        home,
        ['market', 'history', 'condition-1', ...option],
        [
          {
            url: `http://localhost:5000/api/v1/markets/condition-1/price-history?timeframe=${timeframe}`,
            response,
          },
        ],
      )
      assert.deepEqual(JSON.parse(result.stdout), response)
      assert.equal(result.stderr, '')
    }
    assert.equal(await fileExists(join(home, 'config.json')), false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

for (const command of ['comments', 'history'] as const) {
  test(`market ${command} flags preserve opaque source and structured snapshot metadata`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-public-snapshot-'))
    const response =
      command === 'comments'
        ? { conditionId: 'condition-1', snapshotEventOrder: 'opaque /+?&=Ω', comments: [] }
        : {
            conditionId: 'condition-1',
            snapshotEventOrder: 'opaque /+?&=Ω',
            asOf: '2026-10-03T00:00:00Z',
            timeframe: '30d',
            outcomes: [],
          }
    try {
      for (const [flags, query] of [
        [
          ['--minimum-event-order', 'opaque /+?&=Ω'],
          'minimumEventOrder=opaque+%2F%2B%3F%26%3D%CE%A9',
        ],
        [['--refresh'], 'refresh=true'],
        [
          ['--minimum-event-order', 'opaque /+?&=Ω', '--refresh'],
          'minimumEventOrder=opaque+%2F%2B%3F%26%3D%CE%A9&refresh=true',
        ],
      ] as const) {
        const suffix =
          command === 'comments' ? `comments?${query}` : `price-history?timeframe=30d&${query}`
        const result = await runDefaultPublicEngineReadCli(
          home,
          [
            '--dry-run',
            '--json',
            'market',
            command,
            'condition-1',
            ...(command === 'history' ? ['--timeframe', '30d'] : []),
            ...flags,
          ],
          [{ url: `http://localhost:5000/api/v1/markets/condition-1/${suffix}`, response }],
        )
        assert.deepEqual(JSON.parse(result.stdout), response)
        assert.equal(result.stderr, '')
      }
      const help = await runDefaultPublicEngineReadCli(home, ['market', command, '--help'], [])
      assert.match(help.stdout, /--minimum-event-order <eventOrder>/)
      assert.match(help.stdout, /--refresh/)
      await assert.rejects(
        runDefaultPublicEngineReadCli(
          home,
          ['market', command, 'condition-1', '--minimum-event-order'],
          [],
        ),
        (error: unknown) =>
          /argument missing/.test(
            `${(error as { stderr?: string }).stderr ?? ''}\n${(error as { stdout?: string }).stdout ?? ''}`,
          ),
      )
      assert.equal(await fileExists(join(home, 'config.json')), false)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
}

test('market attestation reads public oracle details and preserves the 404 null result', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-public-attestation-'))
  const conditionId = 'ab'.repeat(32)
  const { created_at, ...signedEvent } = finalizeEvent(
    { kind: 89, created_at: 1_900_000_000, tags: [['e', '44'.repeat(32)]], content: 'AQ==' },
    new Uint8Array(32).fill(1),
  )
  const response = {
    conditionId,
    attestedOutcome: 'YES',
    attestationEvent: {
      id: signedEvent.id,
      pubkey: signedEvent.pubkey,
      createdAt: created_at,
      kind: 89 as const,
      tags: signedEvent.tags,
      content: signedEvent.content,
      sig: signedEvent.sig,
    },
    oracleWitness: { oracle_sigs: [] },
    registeredAuthority: {
      eventId: 'event-1',
      outcomes: ['YES', 'NO'],
      threshold: 1,
      oracles: [
        {
          oraclePublicKey: 'oracle-key',
          noncePoint: 'nonce-point',
          announcementIdentity: 'announcement-1',
        },
      ],
    },
  }
  try {
    for (const resultCase of [
      { response, expected: response, status: 200 },
      { response: { result: 'AttestationNotAvailable' }, expected: null, status: 404 },
    ]) {
      const result = await runDefaultPublicEngineReadCli(
        home,
        ['market', 'attestation', conditionId],
        [
          {
            url: `http://localhost:5000/api/v1/conditions/${conditionId}/attestation`,
            response: resultCase.response,
            status: resultCase.status,
          },
        ],
      )
      assert.deepEqual(JSON.parse(result.stdout), resultCase.expected)
      assert.equal(result.stderr, '')
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('market creator reads the existing public rollup once without a wallet or daemon', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-public-creator-'))
  const pubkey = 'cd'.repeat(32)
  const response = {
    pubkey,
    markets: [
      {
        conditionId: 'condition-open',
        totalVolumeSubunits: 12_500,
        createdAt: '2026-09-01T00:00:00Z',
        state: 'open',
      },
      {
        conditionId: 'condition-closed',
        totalVolumeSubunits: 0,
        createdAt: '2026-09-02T00:00:00Z',
        state: 'closed',
      },
    ],
  }
  try {
    assert.equal(await fileExists(join(home, 'config.json')), false)
    const result = await runDefaultPublicEngineReadCli(
      home,
      ['market', 'creator', pubkey],
      [
        {
          url: `http://localhost:5000/api/v1/creators/${pubkey}/markets`,
          response,
        },
      ],
    )
    assert.deepEqual(JSON.parse(result.stdout), response)
    assert.equal(result.stderr, '')
    assert.equal(await fileExists(join(home, 'config.json')), false)
  } finally {
    await rm(home, { recursive: true, force: true })
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

test('market list forwards every repeated OR tag to the direct engine query anonymously', async () => {
  const response = { markets: [], nextCursor: null }
  const result = await runCliWithEnv(
    [
      'market',
      'list',
      '--sort',
      'Trending',
      '--tag',
      'sports',
      '--tag',
      'politics',
      '--creator',
      'npub1creator',
      '--cursor',
      'page-2',
    ],
    {
      ...process.env,
      BITCASTER_TEST_ENGINE_URL: 'https://engine.example',
      BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
      BITCASTER_TEST_FETCH_MODULE: publicEngineGetSequenceModule([
        {
          url: 'https://engine.example/api/v1/markets/query?sort=Trending&tag=sports&tag=politics&creator_pubkey=npub1creator&cursor=page-2',
          response,
        },
      ]),
    },
  )

  assert.deepEqual(JSON.parse(result.stdout), response)
  assert.equal(result.stderr, '')
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
      {
        method: 'markets.query',
        params: { creator: 'npub1creator', sort: 'Trending' },
      },
      {
        method: 'markets.query',
        params: { creator: 'npub1creator', sort: 'Popular' },
      },
      {
        method: 'markets.query',
        params: { creator: 'npub1creator', sort: 'New' },
      },
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

test('market list rejects the unsupported Resolved catalogue state', async () => {
  await assert.rejects(
    () =>
      runCliWithEnv(['market', 'list', '--state', 'Resolved'], {
        ...process.env,
        BITCASTER_TEST_DAEMON_URL: 'http://127.0.0.1:9',
        BITCASTER_TEST_ENGINE_URL: undefined,
      }),
    (err: unknown) => {
      assert.equal((err as { code?: unknown }).code, 2)
      assert.match((err as { stderr?: string }).stderr ?? '', /Invalid market state: Resolved/)
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

test('market funding is an anonymous public read without a daemon profile', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-public-market-funding-'))
  const conditionId = 'a'.repeat(64)
  const market = {
    conditionId,
    ammBotBudgetSubunits: 8_000,
    fundingRevision: '000000000000000000000000000000000001',
  }
  try {
    const configPath = join(home, 'config.json')
    assert.equal(await fileExists(configPath), false)
    const result = await runDefaultPublicEngineReadCli(
      home,
      ['market', 'funding', conditionId],
      [
        {
          url: `http://localhost:5000/api/v1/markets/query?state=All&ids=${conditionId}&page_size=1`,
          response: { markets: [market], nextCursor: null },
        },
      ],
    )

    assert.deepEqual(JSON.parse(result.stdout), {
      conditionId,
      ammBotBudgetSubunits: 8_000,
      fundingRevision: market.fundingRevision,
    })
    assert.equal(result.stderr, '')
    assert.equal(await fileExists(configPath), false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('market funding quote and local head preserve named msat and nullable head facts', async () => {
  const conditionId = 'a'.repeat(64)
  const quote = {
    grossFundingMsat: 8_000,
    sendPreparationFeeMsat: 2,
    estimatedRecipientReceiveFeeMsat: 1,
    totalWalletDebitMsat: 8_002,
    netFundingMsat: 7_999,
  }
  const quoteResult = await runCliWithEnv(
    ['market', 'funding-quote', conditionId, '--amount-msat', '8000'],
    {
      ...process.env,
      BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
      BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([
        {
          command: {
            method: 'market.funding.quote',
            params: { conditionId, requestedAmountMsat: 8_000 },
          },
          response: { ok: true, result: quote },
        },
      ]),
    },
  )
  assert.deepEqual(JSON.parse(quoteResult.stdout), {
    ok: true,
    result: { conditionId, requestedAmountMsat: 8_000, quote },
  })
  assert.equal(quoteResult.stderr, '')

  const headResult = await runCliWithEnv(['market', 'funding-head', conditionId], {
    ...process.env,
    BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
    BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([
      {
        command: { method: 'market.funding.head', params: { conditionId } },
        response: { ok: true, result: null },
      },
    ]),
  })
  assert.deepEqual(JSON.parse(headResult.stdout), {
    ok: true,
    result: { conditionId, head: null },
  })
  assert.equal(headResult.stderr, '')
})

test('market fund begin quotes, reads the funding head, and returns its exact attempt identity', async () => {
  const conditionId = 'b'.repeat(64)
  const previousTransferId = '11111111-1111-4111-8111-111111111111'
  const quote = {
    grossFundingMsat: 8_000,
    sendPreparationFeeMsat: 2,
    estimatedRecipientReceiveFeeMsat: 1,
    totalWalletDebitMsat: 8_002,
    netFundingMsat: 7_999,
  }
  const result = await runCliWithEnv(
    [
      'market',
      'fund',
      'begin',
      conditionId,
      '--amount-msat',
      '8000',
      '--max-wallet-debit-msat',
      '8002',
    ],
    {
      ...process.env,
      BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
      BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([
        {
          command: {
            method: 'market.funding.quote',
            params: { conditionId, requestedAmountMsat: 8_000 },
          },
          response: { ok: true, result: quote },
        },
        {
          command: { method: 'market.funding.head', params: { conditionId } },
          response: { ok: true, result: { transferId: previousTransferId, revision: 4 } },
        },
        {
          commandMatch: {
            method: 'market.fund',
            conditionId,
            attemptKind: 'begin',
            expectedPreviousTransferId: previousTransferId,
            requestedAmount: '8000',
            maxWalletDebitMsat: 8_002,
          },
          responseFromAttempt: 'received',
        },
      ]),
    },
  )

  const output = JSON.parse(result.stdout) as {
    ok: boolean
    result: {
      conditionId: string
      attemptId: string
      expectedPreviousTransferId: string
      requestedAmountMsat: number
      maxWalletDebitMsat: number
      quote: typeof quote
      delivery: { deliveryId: string; transferId: string; state: string }
    }
  }
  assert.equal(output.ok, true)
  assert.match(output.result.attemptId, /^[0-9a-f-]{36}$/)
  assert.deepEqual(output.result, {
    conditionId,
    attemptId: output.result.attemptId,
    expectedPreviousTransferId: previousTransferId,
    requestedAmountMsat: 8_000,
    maxWalletDebitMsat: 8_002,
    quote,
    delivery: {
      deliveryId: output.result.attemptId,
      transferId: output.result.attemptId,
      state: 'received',
    },
  })
  assert.equal(result.stderr, '')
})

test('market fund begin refuses a quote over its explicit debit cap before reading head or dispatching', async () => {
  const conditionId = 'c'.repeat(64)
  const quote = {
    grossFundingMsat: 8_000,
    sendPreparationFeeMsat: 2,
    estimatedRecipientReceiveFeeMsat: 1,
    totalWalletDebitMsat: 8_002,
    netFundingMsat: 7_999,
  }
  await assert.rejects(
    () =>
      runCliWithEnv(
        [
          'market',
          'fund',
          'begin',
          conditionId,
          '--amount-msat',
          '8000',
          '--max-wallet-debit-msat',
          '8001',
        ],
        {
          ...process.env,
          BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
          BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([
            {
              command: {
                method: 'market.funding.quote',
                params: { conditionId, requestedAmountMsat: 8_000 },
              },
              response: { ok: true, result: quote },
            },
          ]),
        },
      ),
    (error: unknown) => {
      const output = error as { code?: number; stdout?: string; stderr?: string }
      assert.equal(output.code, 1)
      assert.deepEqual(JSON.parse(output.stdout ?? ''), {
        ok: false,
        code: 'market-funding-refused',
        error:
          'quoted wallet debit exceeds --max-wallet-debit-msat; no funding attempt was started',
        result: {
          conditionId,
          requestedAmountMsat: 8_000,
          maxWalletDebitMsat: 8_001,
          quote,
        },
      })
      assert.equal(output.stderr, '')
      return true
    },
  )
})

test('market fund begin preserves its recovery id when the funding RPC response is lost', async () => {
  const conditionId = 'd'.repeat(64)
  const quote = {
    grossFundingMsat: 8_000,
    sendPreparationFeeMsat: 2,
    estimatedRecipientReceiveFeeMsat: 1,
    totalWalletDebitMsat: 8_002,
    netFundingMsat: 7_999,
  }
  await assert.rejects(
    () =>
      runCliWithEnv(
        [
          'market',
          'fund',
          'begin',
          conditionId,
          '--amount-msat',
          '8000',
          '--max-wallet-debit-msat',
          '8002',
        ],
        {
          ...process.env,
          BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
          BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([
            {
              command: {
                method: 'market.funding.quote',
                params: { conditionId, requestedAmountMsat: 8_000 },
              },
              response: { ok: true, result: quote },
            },
            {
              command: { method: 'market.funding.head', params: { conditionId } },
              response: { ok: true, result: null },
            },
            {
              commandMatch: {
                method: 'market.fund',
                conditionId,
                attemptKind: 'begin',
                expectedPreviousTransferId: null,
                requestedAmount: '8000',
                maxWalletDebitMsat: 8_002,
              },
              rejectWith: 'fetch failed',
            },
          ]),
        },
      ),
    (error: unknown) => {
      const output = error as { code?: number; stdout?: string; stderr?: string }
      assert.equal(output.code, 1)
      const result = JSON.parse(output.stdout ?? '')
      assert.equal(result.ok, false)
      assert.equal(result.code, 'market-funding-unconfirmed')
      assert.match(result.result.attemptId, /^[0-9a-f-]{36}$/)
      assert.equal(result.result.transferId, result.result.attemptId)
      assert.equal(
        result.result.resumeCommand,
        `bitcaster-cli market fund resume ${conditionId} ${result.result.transferId}`,
      )
      assert.deepEqual(result.result.quote, quote)
      assert.equal(output.stderr, '')
      return true
    },
  )
})

test('market fund resume dispatches only the exact persisted transfer id', async () => {
  const conditionId = 'e'.repeat(64)
  const transferId = '22222222-2222-4222-8222-222222222222'
  const delivery = { deliveryId: transferId, transferId, state: 'credited' }
  const result = await runCliWithEnv(['market', 'fund', 'resume', conditionId, transferId], {
    ...process.env,
    BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
    BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([
      {
        commandMatch: {
          method: 'market.fund',
          conditionId,
          attemptKind: 'resume',
          transferId,
        },
        response: { ok: true, result: delivery },
      },
    ]),
  })
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    result: { conditionId, transferId, delivery },
  })
  assert.equal(result.stderr, '')
})

test('market funding commands reject unsafe or non-positive msat before RPC', async () => {
  const invalidCases = [
    ['market', 'funding-quote', 'a'.repeat(64), '--amount-msat', '0'],
    ['market', 'funding-quote', 'a'.repeat(64), '--amount-msat', '9007199254740992'],
    [
      'market',
      'fund',
      'begin',
      'a'.repeat(64),
      '--amount-msat',
      '1.5',
      '--max-wallet-debit-msat',
      '10',
    ],
    [
      'market',
      'fund',
      'begin',
      'a'.repeat(64),
      '--amount-msat',
      '1',
      '--max-wallet-debit-msat',
      '0',
    ],
  ]
  for (const args of invalidCases) {
    await assert.rejects(
      () =>
        runCliWithEnv(args, {
          ...process.env,
          BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
          BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([]),
        }),
      (error: unknown) => {
        const output = error as { stdout?: string; stderr?: string }
        assert.match(
          `${output.stdout ?? ''}\n${output.stderr ?? ''}`,
          /Invalid (amount msat|max wallet debit msat)/,
        )
        return true
      },
    )
  }
})

test('order preview preserves direct/complement requests and non-fillable results', async () => {
  const cases = [
    {
      marketId: 'condition-1-YES',
      side: 'Buy' as const,
      tokenSide: 'Outcome' as const,
      price: 537,
      amountMsat: 123_000,
      response: {
        fullFillAvailable: true,
        reason: 'fillable',
        previewRevision: 'revision-direct',
        quotePaymentSubunits: 61_500,
        averagePrice: 500,
        worstPrice: 520,
        currentLatestTradePrice: 480,
        projectedFinalPrice: 515,
        priceDenominator: 1_000,
        subsidyMayHelp: false,
      },
    },
    {
      marketId: 'condition-1-YES',
      side: 'Buy' as const,
      tokenSide: 'Complement' as const,
      price: 613,
      amountMsat: 123_000,
      response: {
        fullFillAvailable: true,
        reason: 'fillable',
        previewRevision: 'revision-complement',
        quotePaymentSubunits: 72_570,
        averagePrice: 590,
        worstPrice: 600,
        currentLatestTradePrice: 480,
        projectedFinalPrice: 400,
        priceDenominator: 1_000,
        subsidyMayHelp: false,
      },
    },
    {
      marketId: 'condition-1-YES',
      side: 'Buy' as const,
      tokenSide: 'Outcome' as const,
      price: 420,
      amountMsat: 123_000,
      response: {
        fullFillAvailable: false,
        reason: 'insufficient_liquidity',
        previewRevision: 'revision-insufficient',
        quotePaymentSubunits: null,
        averagePrice: null,
        worstPrice: null,
        currentLatestTradePrice: 480,
        projectedFinalPrice: null,
        priceDenominator: 1_000,
        subsidyMayHelp: true,
      },
    },
  ]

  for (const testCase of cases) {
    const request = {
      marketId: testCase.marketId,
      side: testCase.side,
      tokenSide: testCase.tokenSide,
      price: testCase.price,
      faceAmountSubunits: testCase.amountMsat,
    }
    const result = await runPublicOrderCli(previewCliArgs(request), [
      { path: '/api/v1/orders/preview', request, response: testCase.response },
    ])

    assert.deepEqual(JSON.parse(result.stdout), {
      request,
      preview: testCase.response,
    })
    assert.equal(result.stderr, '')
  }
})

test('order capacity preserves custom, server Auto, and unavailable responses', async () => {
  const cases = [
    {
      marketId: 'condition-1-YES',
      side: 'Sell' as const,
      tokenSide: 'Outcome' as const,
      price: 539,
      response: {
        status: 'ready',
        referencePrice: 600,
        effectiveLimitPrice: 539,
        maxFaceAmountSubunits: 10_000,
        quotePaymentSubunits: 5_500,
        worstPrice: 550,
        priceDenominator: 1_000,
        previewRevision: 'revision-custom',
      },
    },
    {
      marketId: 'condition-1-YES',
      side: 'Buy' as const,
      tokenSide: 'Complement' as const,
      price: undefined,
      response: {
        status: 'ready',
        referencePrice: 400,
        effectiveLimitPrice: 600,
        maxFaceAmountSubunits: 10_000,
        quotePaymentSubunits: 4_500,
        worstPrice: 450,
        priceDenominator: 1_000,
        previewRevision: 'revision-auto',
      },
    },
    {
      marketId: 'condition-1-YES',
      side: 'Sell' as const,
      tokenSide: 'Complement' as const,
      price: undefined,
      response: {
        status: 'temporarily_unavailable',
        referencePrice: null,
        effectiveLimitPrice: null,
        maxFaceAmountSubunits: null,
        quotePaymentSubunits: null,
        worstPrice: null,
        priceDenominator: null,
        previewRevision: null,
      },
    },
  ]

  for (const testCase of cases) {
    const request = {
      marketId: testCase.marketId,
      side: testCase.side,
      tokenSide: testCase.tokenSide,
      ...(testCase.price === undefined ? {} : { price: testCase.price }),
    }
    const result = await runPublicOrderCli(capacityCliArgs(request), [
      { path: '/api/v1/orders/capacity-preview', request, response: testCase.response },
    ])

    assert.deepEqual(JSON.parse(result.stdout), testCase.response)
    assert.equal(result.stderr, '')
  }
})

test('order preview Auto uses the public capacity limit and preserves missing-limit states', async () => {
  const autoLimit = 623
  const capacityRequest = {
    marketId: 'condition-1-YES',
    side: 'Buy',
    tokenSide: 'Outcome',
  }
  const previewRequest = {
    ...capacityRequest,
    price: autoLimit,
    faceAmountSubunits: 1_000,
  }
  const previewResponse = {
    fullFillAvailable: true,
    reason: 'fillable',
    previewRevision: 'revision-after-capacity',
    quotePaymentSubunits: 600,
    averagePrice: 600,
    worstPrice: 615,
    currentLatestTradePrice: 500,
    projectedFinalPrice: 610,
    priceDenominator: 1_000,
    subsidyMayHelp: false,
  }
  const capacityResponse = {
    status: 'ready',
    referencePrice: 423,
    effectiveLimitPrice: autoLimit,
    maxFaceAmountSubunits: 10_000,
    quotePaymentSubunits: 5_000,
    worstPrice: 500,
    priceDenominator: 1_000,
    previewRevision: 'revision-capacity',
  }
  const result = await runPublicOrderCli(
    previewCliArgs({
      ...capacityRequest,
      faceAmountSubunits: 1_000,
    }),
    [
      {
        path: '/api/v1/orders/capacity-preview',
        request: capacityRequest,
        response: capacityResponse,
      },
      { path: '/api/v1/orders/preview', request: previewRequest, response: previewResponse },
    ],
  )
  assert.deepEqual(JSON.parse(result.stdout), { request: previewRequest, preview: previewResponse })
  assert.equal(result.stderr, '')

  const unavailableCases = [
    {
      response: {
        status: 'temporarily_unavailable',
        referencePrice: null,
        effectiveLimitPrice: null,
        maxFaceAmountSubunits: null,
        quotePaymentSubunits: null,
        worstPrice: null,
        priceDenominator: null,
        previewRevision: null,
      },
    },
    {
      response: {
        status: 'ready',
        referencePrice: null,
        effectiveLimitPrice: null,
        maxFaceAmountSubunits: 0,
        quotePaymentSubunits: 0,
        worstPrice: null,
        priceDenominator: 1_000,
        previewRevision: 'revision-no-reference',
      },
    },
  ]
  for (const testCase of unavailableCases) {
    const input = {
      marketId: capacityRequest.marketId,
      side: capacityRequest.side,
      tokenSide: capacityRequest.tokenSide,
      faceAmountSubunits: 1_000,
    }
    const unavailable = await runPublicOrderCli(previewCliArgs(input), [
      {
        path: '/api/v1/orders/capacity-preview',
        request: capacityRequest,
        response: testCase.response,
      },
    ])
    assert.deepEqual(JSON.parse(unavailable.stdout), {
      request: input,
      capacity: testCase.response,
      preview: null,
    })
    assert.equal(unavailable.stderr, '')
  }
})

test('order preview and capacity reject unsafe or invalid input before public I/O', async () => {
  const invalidCases = [
    {
      args: ['order', 'preview', '--market', 'condition-1-YES', '--side', 'Buy', '--price', '420'],
      expected: /Missing amount msat/,
    },
    {
      args: [
        'order',
        'preview',
        '--market',
        'condition-1-YES',
        '--side',
        'Buy',
        '--price',
        '9007199254740992',
        '--amount-msat',
        '1000',
      ],
      expected: /Invalid price: 9007199254740992/,
    },
    {
      args: [
        'order',
        'preview',
        '--market',
        'condition-1-YES',
        '--side',
        'Buy',
        '--price',
        '420',
        '--amount-msat',
        '9007199254740992',
      ],
      expected: /Invalid amount msat: 9007199254740992/,
    },
    {
      args: [
        'order',
        'capacity',
        '--market',
        'condition-1-YES',
        '--side',
        'Buy',
        '--price',
        '9007199254740992',
      ],
      expected: /Invalid price: 9007199254740992/,
    },
    {
      args: ['order', 'capacity', '--market', 'condition-1-YES', '--side', 'Maybe'],
      expected: /Invalid side: Maybe/,
    },
  ]

  for (const testCase of invalidCases) {
    await assert.rejects(
      () => runPublicOrderCli(testCase.args, []),
      (error: unknown) => {
        const output = error as { stdout?: string; stderr?: string }
        assert.match(`${output.stdout ?? ''}\n${output.stderr ?? ''}`, testCase.expected)
        return true
      },
    )
  }
})

test('anonymous order reads use the default engine without creating a profile', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-order-capacity-default-'))
  const configPath = join(home, 'config.json')
  const response = {
    status: 'temporarily_unavailable',
    referencePrice: null,
    effectiveLimitPrice: null,
    maxFaceAmountSubunits: null,
    quotePaymentSubunits: null,
    worstPrice: null,
    priceDenominator: null,
    previewRevision: null,
  }
  try {
    assert.equal(await fileExists(configPath), false)
    const capacityRequest = {
      marketId: 'condition-1-YES',
      side: 'Buy',
      tokenSide: 'Outcome',
    }
    const capacityResult = await runDefaultPublicOrderCli(home, capacityCliArgs(capacityRequest), [
      {
        path: '/api/v1/orders/capacity-preview',
        request: capacityRequest,
        response,
      },
    ])
    assert.deepEqual(JSON.parse(capacityResult.stdout), response)
    assert.equal(capacityResult.stderr, '')
    assert.equal(await fileExists(configPath), false)

    const previewResponse = {
      fullFillAvailable: true,
      reason: 'fillable',
      previewRevision: 'revision-default',
      quotePaymentSubunits: 400,
      averagePrice: 400,
      worstPrice: 420,
      currentLatestTradePrice: 400,
      projectedFinalPrice: 410,
      priceDenominator: 1_000,
      subsidyMayHelp: false,
    }
    const previewRequest = {
      ...capacityRequest,
      price: 420,
      faceAmountSubunits: 1_000,
    }
    const preview = await runDefaultPublicOrderCli(home, previewCliArgs(previewRequest), [
      { path: '/api/v1/orders/preview', request: previewRequest, response: previewResponse },
    ])
    assert.deepEqual(JSON.parse(preview.stdout), {
      request: previewRequest,
      preview: previewResponse,
    })
    assert.equal(preview.stderr, '')
    assert.equal(await fileExists(configPath), false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('order preview keeps public engine errors in the JSON error envelope', async () => {
  const response = { code: 'engine-maintenance', detail: 'Preview temporarily unavailable' }
  const request = {
    marketId: 'condition-1-YES',
    side: 'Buy',
    tokenSide: 'Outcome',
    price: 420,
    faceAmountSubunits: 1_000,
  }
  await assert.rejects(
    () =>
      runPublicOrderCli(previewCliArgs(request), [
        {
          path: '/api/v1/orders/preview',
          request,
          response,
          status: 503,
        },
      ]),
    (error: unknown) => {
      const output = error as { code?: number; stdout?: string; stderr?: string }
      assert.equal(output.code, 1)
      assert.deepEqual(JSON.parse(output.stdout ?? ''), {
        ok: false,
        error: `engine returned HTTP 503: ${JSON.stringify(response)}`,
      })
      assert.equal(output.stderr, '')
      return true
    },
  )
})

test('order fee-preview sends explicit and Auto FOK drafts and preserves daemon refusals', async () => {
  const explicitDraft = {
    marketId: 'condition-1-YES',
    outcomeId: 'YES',
    tokenSide: 'Complement',
    side: 'Buy',
    price: 537,
    amountSubunits: 123_000,
    minimumFillAmountSubunits: 1_000,
    consolidateProofs: true,
    timeInForce: 'FOK',
    expiresAt: null,
  }
  const autoDraft = {
    marketId: 'condition-1-NO',
    outcomeId: 'NO',
    tokenSide: 'Outcome',
    side: 'Sell',
    amountSubunits: 45_000,
    consolidateProofs: false,
    timeInForce: 'FOK',
    expiresAt: null,
  }
  const explicitResponse = {
    ok: true,
    result: {
      request: { ...explicitDraft, minimumFillAmountSubunits: 1_000 },
      feeFacts: orderFeeFactsFixture(),
    },
  }
  const autoResponse = {
    ok: true,
    result: {
      request: { ...autoDraft, price: 611, minimumFillAmountSubunits: 1_000 },
      feeFacts: orderFeeFactsFixture(),
    },
  }
  const cases = [
    {
      args: [
        'order',
        'fee-preview',
        '--market',
        explicitDraft.marketId,
        '--outcome',
        explicitDraft.outcomeId,
        '--side',
        explicitDraft.side,
        '--token-side',
        explicitDraft.tokenSide,
        '--price',
        String(explicitDraft.price),
        '--amount-msat',
        String(explicitDraft.amountSubunits),
        '--min-fill-msat',
        String(explicitDraft.minimumFillAmountSubunits),
        '--consolidate-proofs',
      ],
      request: explicitDraft,
      response: explicitResponse,
    },
    {
      args: [
        'order',
        'fee-preview',
        '--market',
        autoDraft.marketId,
        '--outcome',
        autoDraft.outcomeId,
        '--side',
        autoDraft.side,
        '--amount-msat',
        String(autoDraft.amountSubunits),
      ],
      request: autoDraft,
      response: autoResponse,
    },
  ]

  for (const testCase of cases) {
    const result = await runCliWithEnv(testCase.args, {
      ...process.env,
      BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
      BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([
        {
          command: { method: 'order.fee-preview', params: testCase.request },
          response: testCase.response,
        },
      ]),
    })
    assert.deepEqual(JSON.parse(result.stdout), testCase.response)
    assert.equal(result.stderr, '')
  }

  const refusal = {
    ok: false,
    code: 'order-not-executable',
    error: 'Order rejected: protected FOK preview is not executable',
  }
  await assert.rejects(
    () =>
      runCliWithEnv(
        [
          'order',
          'fee-preview',
          '--market',
          explicitDraft.marketId,
          '--outcome',
          explicitDraft.outcomeId,
          '--side',
          'Buy',
          '--price',
          '537',
          '--amount-msat',
          '123000',
        ],
        {
          ...process.env,
          BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
          BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([
            {
              command: {
                method: 'order.fee-preview',
                params: {
                  marketId: explicitDraft.marketId,
                  outcomeId: explicitDraft.outcomeId,
                  tokenSide: 'Outcome',
                  side: 'Buy',
                  price: 537,
                  amountSubunits: 123_000,
                  consolidateProofs: false,
                  timeInForce: 'FOK',
                  expiresAt: null,
                },
              },
              response: refusal,
            },
          ]),
        },
      ),
    (error: unknown) => {
      const output = error as { code?: number; stdout?: string; stderr?: string }
      assert.equal(output.code, 1)
      assert.deepEqual(JSON.parse(output.stdout ?? ''), refusal)
      assert.equal(output.stderr, '')
      return true
    },
  )
})

test('order submit forwards exact fee-preview consent for explicit and Auto requests', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-order-fee-consent-'))
  const feeFacts = orderFeeFactsFixture()
  const explicitRequest = {
    marketId: 'condition-1-YES',
    outcomeId: 'YES',
    tokenSide: 'Complement',
    side: 'Buy',
    price: 537,
    amountSubunits: 123_000,
    minimumFillAmountSubunits: 1_000,
    consolidateProofs: true,
    timeInForce: 'FOK',
  }
  const autoRequest = {
    marketId: 'condition-1-NO',
    outcomeId: 'NO',
    tokenSide: 'Outcome',
    side: 'Sell',
    price: 611,
    amountSubunits: 45_000,
    minimumFillAmountSubunits: 1_000,
    consolidateProofs: false,
    timeInForce: 'FOK',
  }
  const explicitPath = join(home, 'explicit-fees.json')
  const autoPath = join(home, 'auto-fees.json')
  await writeFile(
    explicitPath,
    JSON.stringify({ ok: true, result: { request: explicitRequest, feeFacts } }),
  )
  await writeFile(
    autoPath,
    JSON.stringify({ ok: true, result: { request: autoRequest, feeFacts } }),
  )

  try {
    const cases = [
      {
        path: explicitPath,
        args: [
          'order',
          'submit',
          '--market',
          explicitRequest.marketId,
          '--outcome',
          explicitRequest.outcomeId,
          '--side',
          explicitRequest.side,
          '--token-side',
          explicitRequest.tokenSide,
          '--price',
          String(explicitRequest.price),
          '--amount-msat',
          String(explicitRequest.amountSubunits),
          '--min-fill-msat',
          String(explicitRequest.minimumFillAmountSubunits),
          '--consolidate-proofs',
          '--fee-consent-file',
          explicitPath,
          '--comment',
          'hello market',
          '--market-url',
          'https://market.example/condition-1-YES',
        ],
        request: {
          ...explicitRequest,
          expiresAt: null,
        },
        feeConsent: { request: explicitRequest, feeFacts },
        comment: { content: 'hello market', marketUrl: 'https://market.example/condition-1-YES' },
      },
      {
        path: autoPath,
        args: [
          'order',
          'submit',
          '--market',
          autoRequest.marketId,
          '--outcome',
          autoRequest.outcomeId,
          '--side',
          autoRequest.side,
          '--amount-msat',
          String(autoRequest.amountSubunits),
          '--fee-consent-file',
          autoPath,
        ],
        request: {
          marketId: autoRequest.marketId,
          outcomeId: autoRequest.outcomeId,
          tokenSide: 'Outcome',
          side: 'Sell',
          amountSubunits: autoRequest.amountSubunits,
          consolidateProofs: false,
          timeInForce: 'FOK',
          expiresAt: null,
        },
        feeConsent: { request: autoRequest, feeFacts },
      },
    ]

    for (const testCase of cases) {
      const response = { ok: true, result: { orderId: `order-${testCase.request.marketId}` } }
      const result = await runCliWithEnv(testCase.args, {
        ...process.env,
        BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
        BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([
          {
            command: {
              method: 'order.submit',
              params: {
                ...testCase.request,
                feeConsent: testCase.feeConsent,
                ...(testCase.comment === undefined ? {} : { comment: testCase.comment }),
              },
            },
            response,
          },
        ]),
      })
      assert.deepEqual(JSON.parse(result.stdout), response)
      assert.equal(result.stderr, '')
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('order submit validates fee consent files before any daemon RPC and keeps errors safe', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-order-fee-consent-invalid-'))
  const validPath = join(home, 'valid.json')
  await writeFile(validPath, JSON.stringify(orderFeeConsentEnvelope({})))
  const oversizedPath = join(home, 'oversized.json')
  await writeFile(oversizedPath, Buffer.alloc(8 * 1_024 + 1, 0x20))
  const malformedPath = join(home, 'malformed.json')
  await writeFile(malformedPath, '{"secret-marker":"must-not-be-printed"')
  const nonFilePath = join(home, 'directory')
  await mkdir(nonFilePath)
  const symlinkPath = join(home, 'linked.json')
  await symlink(validPath, symlinkPath)
  const fifoPath = join(home, 'fee-consent.fifo')
  if (process.platform !== 'win32') await execFileAsync('mkfifo', [fifoPath])

  try {
    const baseArgs = [
      'order',
      'submit',
      '--market',
      'condition-1-YES',
      '--outcome',
      'YES',
      '--side',
      'Buy',
      '--amount-msat',
      '1000',
    ]
    const cases = [
      { label: 'missing consent', args: baseArgs, error: /Missing fee-consent-file/ },
      {
        label: 'oversized file',
        args: [...baseArgs, '--fee-consent-file', oversizedPath],
        error: /exceeds 8192 bytes/,
      },
      {
        label: 'malformed envelope',
        args: [...baseArgs, '--fee-consent-file', malformedPath],
        error: /successful order fee-preview JSON envelope/,
      },
      {
        label: 'non-regular file',
        args: [...baseArgs, '--fee-consent-file', nonFilePath],
        error: /must name a regular file/,
      },
      ...(process.platform === 'win32'
        ? []
        : [
            {
              label: 'symbolic link',
              args: [...baseArgs, '--fee-consent-file', symlinkPath],
              error: /symbolic link/,
            },
            {
              label: 'fifo',
              args: [...baseArgs, '--fee-consent-file', fifoPath],
              error: /must name a regular file/,
            },
          ]),
    ]

    for (const testCase of cases) {
      await assert.rejects(
        () =>
          runCliWithEnv(
            testCase.args,
            {
              ...process.env,
              BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
              BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([]),
            },
            { childTimeoutMs: 5_000 },
          ),
        (error: unknown) => {
          const output = error as { code?: number; stdout?: string; stderr?: string }
          assert.equal(output.code, testCase.label === 'missing consent' ? 2 : 1, testCase.label)
          assert.match(
            `${output.stdout ?? ''}\n${output.stderr ?? ''}`,
            testCase.error,
            testCase.label,
          )
          assert.doesNotMatch(
            `${output.stdout ?? ''}\n${output.stderr ?? ''}`,
            /secret-marker|settlementInputFeeSubunits|nsec|token/i,
            testCase.label,
          )
          return true
        },
      )
    }

    const unsafePriceArgs = [
      'order',
      'submit',
      '--market',
      'condition-1-YES',
      '--outcome',
      'YES',
      '--side',
      'Buy',
      '--price',
      '9007199254740992',
      '--amount-msat',
      '1000',
      '--fee-consent-file',
      validPath,
    ]
    await assert.rejects(
      () =>
        runCliWithEnv(unsafePriceArgs, {
          ...process.env,
          BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
          BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([]),
        }),
      (error: unknown) => {
        const output = error as { stdout?: string; stderr?: string }
        assert.match(`${output.stdout ?? ''}\n${output.stderr ?? ''}`, /Invalid price/)
        return true
      },
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('order preview and capacity help explain price and observation semantics', async () => {
  const preview = await execFileAsync(
    process.execPath,
    [
      '--experimental-strip-types',
      join(import.meta.dirname, '..', 'src', 'main.ts'),
      'order',
      'preview',
      '--help',
    ],
    { env: { ...process.env, NODE_NO_WARNINGS: '1' } },
  )
  const normalizedPreviewHelp = preview.stdout.replace(/\s+/g, ' ')
  assert.match(normalizedPreviewHelp, /amount-msat/)
  assert.match(normalizedPreviewHelp, /wallet preparation fees are not included/)
  assert.match(normalizedPreviewHelp, /omit to use the server Auto limit/)

  const capacity = await execFileAsync(
    process.execPath,
    [
      '--experimental-strip-types',
      join(import.meta.dirname, '..', 'src', 'main.ts'),
      'order',
      'capacity',
      '--help',
    ],
    { env: { ...process.env, NODE_NO_WARNINGS: '1' } },
  )
  const normalizedCapacityHelp = capacity.stdout.replace(/\s+/g, ' ')
  assert.match(normalizedCapacityHelp, /omit to use the server Auto limit/)
  assert.match(normalizedCapacityHelp, /not a reservation or wallet balance/)
})

test('order wait polls matched and filled-with-active-group statuses until settlement is terminal', async () => {
  const marketId = 'condition-1-YES'
  const orderId = 'order-1'
  const group = {
    groupId: 'group-1',
    status: 'SubmissionPending',
    revision: 2,
    coalescingDeadline: '2026-09-29T12:00:00Z',
    frozenAt: '2026-09-29T11:59:59Z',
  }
  const responses = [
    orderStatusDaemonResponse(makeOrderStatus('matched', group, orderId)),
    orderStatusDaemonResponse(makeOrderStatus('filled', group, orderId)),
    orderStatusDaemonResponse(makeOrderStatus('filled', null, orderId)),
  ]
  const result = await runCliWithEnv(['order', 'wait', marketId, orderId, '--timeout-ms', '4000'], {
    ...process.env,
    BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
    BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule(
      responses.map((response) => ({
        command: orderStatusCommand(marketId, orderId),
        response,
      })),
    ),
  })

  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    result: {
      marketId,
      orderId,
      wait: { status: 'terminal', timeoutMs: 4000, pollCount: 3 },
      engine: responses[2].result.engine,
      local: responses[2].result.local,
    },
  })
  assert.equal(result.stderr, '')
})

test('order wait keeps missing orders pending until one becomes visible', async () => {
  const marketId = 'condition-1-YES'
  const orderId = 'order-not-visible-yet'
  const terminal = orderStatusDaemonResponse(makeOrderStatus('filled', null, orderId))
  const result = await runCliWithEnv(['order', 'wait', marketId, orderId, '--timeout-ms', '2000'], {
    ...process.env,
    BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
    BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([
      {
        command: orderStatusCommand(marketId, orderId),
        response: orderStatusDaemonResponse(null),
      },
      { command: orderStatusCommand(marketId, orderId), response: terminal },
    ]),
  })

  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    result: {
      marketId,
      orderId,
      wait: { status: 'terminal', timeoutMs: 2000, pollCount: 2 },
      engine: terminal.result.engine,
      local: terminal.result.local,
    },
  })
  assert.equal(result.stderr, '')
})

test('order wait returns refused and failed engine states without relabeling them', async () => {
  for (const status of ['rejected_capacity', 'failed'] as const) {
    const marketId = 'condition-1-YES'
    const orderId = `order-${status}`
    const terminal = orderStatusDaemonResponse(makeOrderStatus(status, null, orderId))
    const result = await runCliWithEnv(['order', 'wait', marketId, orderId], {
      ...process.env,
      BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
      BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([
        { command: orderStatusCommand(marketId, orderId), response: terminal },
      ]),
    })

    const output = JSON.parse(result.stdout)
    assert.equal(output.ok, true)
    assert.deepEqual(output.result, {
      marketId,
      orderId,
      wait: { status: 'terminal', timeoutMs: 30_000, pollCount: 1 },
      engine: terminal.result.engine,
      local: terminal.result.local,
    })
    assert.equal(output.result.engine.status, status)
    assert.equal(result.stderr, '')
  }
})

test('order wait bounds a slow status RPC and reports timeout, not success', async () => {
  const marketId = 'condition-1-YES'
  const orderId = 'order-slow-status'
  await assert.rejects(
    () =>
      runCliWithEnv(
        ['order', 'wait', marketId, orderId, '--timeout-ms', '500'],
        {
          ...process.env,
          BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
          BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule(
            [
              {
                command: orderStatusCommand(marketId, orderId),
                waitForAbort: true,
              },
            ],
            1,
          ),
        },
        { childTimeoutMs: 5000 },
      ),
    (error: unknown) => {
      const result = error as { code?: number; signal?: string; stdout?: string; stderr?: string }
      assert.equal(result.code, 1)
      assert.equal(result.signal, null)
      assert.ok(result.stdout, result.stderr ?? 'timed-out CLI returned no JSON output')
      assert.deepEqual(JSON.parse(result.stdout), {
        ok: false,
        error: 'order wait timed out before terminal engine status was observed',
        result: {
          marketId,
          orderId,
          wait: { status: 'timed_out', timeoutMs: 500, pollCount: 1 },
          engine: null,
          local: null,
        },
      })
      assert.equal(result.stderr, '')
      return true
    },
  )
})

test('order wait surfaces daemon command errors without polling again', async () => {
  const marketId = 'condition-1-YES'
  const orderId = 'order-command-error'
  const response = { ok: false, error: 'daemon profile is not initialized' }
  await assert.rejects(
    () =>
      runCliWithEnv(['order', 'wait', marketId, orderId, '--timeout-ms', '1000'], {
        ...process.env,
        BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
        BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([
          { command: orderStatusCommand(marketId, orderId), response },
        ]),
      }),
    (error: unknown) => {
      const result = error as { code?: number; stdout?: string; stderr?: string }
      assert.equal(result.code, 1)
      assert.deepEqual(JSON.parse(result.stdout ?? ''), response)
      assert.equal(result.stderr, '')
      return true
    },
  )
})

test('order wait rejects invalid timeout bounds before RPC and documents its limits', async () => {
  for (const value of ['0', '-1', '1.5', '300001', '9007199254740992']) {
    await assert.rejects(
      () =>
        runCliWithEnv(['order', 'wait', 'condition-1-YES', 'order-1', '--timeout-ms', value], {
          ...process.env,
          BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
          BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([]),
        }),
      (error: unknown) => {
        const result = error as { stdout?: string; stderr?: string }
        assert.match(`${result.stdout ?? ''}\n${result.stderr ?? ''}`, /Invalid timeout ms/)
        return true
      },
    )
  }

  const help = await execFileAsync(
    process.execPath,
    [
      '--experimental-strip-types',
      join(import.meta.dirname, '..', 'src', 'main.ts'),
      'order',
      'wait',
      '--help',
    ],
    { env: { ...process.env, NODE_NO_WARNINGS: '1' } },
  )
  const normalizedHelp = help.stdout.replace(/\s+/g, ' ')
  assert.match(normalizedHelp, /timeout-ms <milliseconds>/)
  assert.match(normalizedHelp, /default: 30000; max: 300000/)
  assert.match(normalizedHelp, /does not cancel the order or confirm wallet recovery/)
})

test('P47-4: bitcaster-cli order submit accepts named flags', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-named-flags-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  await ensureRpcToken()
  const feeConsentPath = join(home, 'fee-consent.json')
  const feeConsent = orderFeeConsentEnvelope({})
  await writeFile(feeConsentPath, JSON.stringify(feeConsent), { mode: 0o600 })
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
      '--amount-msat',
      '100',
      '--fee-consent-file',
      feeConsentPath,
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
      '--amount-msat',
      '200',
      '--consolidate-proofs',
      '--fee-consent-file',
      feeConsentPath,
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
      '--amount-msat',
      '100',
      '--fee-consent-file',
      feeConsentPath,
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
          consolidateProofs: false,
          timeInForce: 'FOK',
          expiresAt: null,
          feeConsent: feeConsent.result,
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
          consolidateProofs: true,
          timeInForce: 'FOK',
          expiresAt: null,
          feeConsent: feeConsent.result,
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
          consolidateProofs: false,
          timeInForce: 'FOK',
          expiresAt: null,
          feeConsent: feeConsent.result,
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
        convertFeeMsat: 1,
        collateralReturnedMsat: 2,
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
        convertFeeMsat: 1,
        collateralReturnedMsat: 2,
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
        convertFeeMsat: 1,
        collateralReturnedMsat: 2,
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
      {
        method: 'wallet.splitCompleteSet',
        params: { conditionId: 'cond-1', amountMsat: 100_000 },
      },
    ])
  } finally {
    server.close()
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('bitcaster-cli wallet split rejects invalid sats text before daemon RPC', async () => {
  for (const amount of ['0', '-1', '1.0001', '9007199254740992']) {
    const amountArgs = amount === '-1' ? ['--', amount] : [amount]
    await assertCliFailure(['wallet', 'split', 'cond-1', ...amountArgs], /Invalid amount sats:/)
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

test('market create --creation-id sends canonical native creation params', async () => {
  const command = {
    method: 'market.create-native',
    params: {
      creationId: 'create-native-001',
      eventId: 'event-native-001',
      market: {
        title: 'Will it rain?',
        description: 'Weather market',
        outcomeType: 'categorical',
        outcomeDetails: [{ name: 'Rain', color: '#12aBcD' }, { name: 'NoRain' }],
        maturityEpoch: 1_893_456_000,
        categoryTags: ['weather', 'daily'],
        baseAsset: 'sat',
      },
      relayUrls: ['wss://relay.one.example/', 'wss://relay.two.example/'],
      thumbnailPath: '/tmp/market.png',
      maxWalletDebitMsat: 1_000_000,
    },
  }
  const result = await runCliWithEnv(
    [
      'market',
      'create',
      '--creation-id',
      'create-native-001',
      '--event-id',
      'event-native-001',
      '--title',
      'Will it rain?',
      '--description',
      'Weather market',
      '--outcomes',
      'Rain,NoRain',
      '--outcome-type',
      'categorical',
      '--outcome-color',
      'Rain=#12aBcD',
      '--maturity-epoch',
      '1893456000',
      '--tag',
      'weather',
      '--tag',
      'daily',
      '--relay',
      'wss://relay.one.example/',
      '--relay',
      'wss://relay.two.example/',
      '--max-wallet-debit-msat',
      '1000000',
      '--thumbnail',
      '/tmp/market.png',
      '--trust-engine-url',
    ],
    {
      ...process.env,
      BITCASTER_TEST_ENGINE_URL: 'https://engine.example',
      BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
      BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([
        {
          command,
          response: { ok: true, result: { creationId: 'create-native-001', status: 'created' } },
        },
      ]),
    },
  )

  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    result: { creationId: 'create-native-001', status: 'created' },
  })
})

test('native market create infers yesno only for the exact Yes,No pair and defaults event id', async () => {
  const command = {
    method: 'market.create-native',
    params: {
      creationId: 'create-yesno-001',
      eventId: 'create-yesno-001',
      market: {
        title: 'Will it rain?',
        description: 'Weather market',
        outcomeType: 'yesno',
        outcomeDetails: [{ name: 'Yes' }, { name: 'No' }],
        maturityEpoch: 1_893_456_000,
        categoryTags: [],
        baseAsset: 'sat',
      },
      relayUrls: ['wss://relay.example/'],
    },
  }
  const result = await runCliWithEnv(
    [
      'market',
      'create',
      '--creation-id',
      'create-yesno-001',
      '--title',
      'Will it rain?',
      '--description',
      'Weather market',
      '--outcomes',
      'Yes,No',
      '--maturity-epoch',
      '1893456000',
      '--relay',
      'wss://relay.example/',
      '--trust-engine-url',
    ],
    {
      ...process.env,
      BITCASTER_TEST_ENGINE_URL: 'https://engine.example',
      BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
      BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([
        { command, response: { ok: true, result: { creationId: 'create-yesno-001' } } },
      ]),
    },
  )

  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    result: { creationId: 'create-yesno-001' },
  })
})

test('market create keeps the existing condition-id RPC payload', async () => {
  const command = {
    method: 'market.create',
    params: {
      conditionId: 'cond-existing',
      title: 'Existing condition',
      description: 'Registered on the mint already',
      outcomes: ['YES', 'NO'],
      tags: ['legacy'],
    },
  }
  const result = await runCliWithEnv(
    [
      'market',
      'create',
      '--condition-id',
      'cond-existing',
      '--title',
      'Existing condition',
      '--description',
      'Registered on the mint already',
      '--outcomes',
      'YES,NO',
      '--tag',
      'legacy',
      '--trust-engine-url',
    ],
    {
      ...process.env,
      BITCASTER_TEST_ENGINE_URL: 'https://engine.example',
      BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
      BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([
        { command, response: { ok: true, result: { conditionId: 'cond-existing' } } },
      ]),
    },
  )

  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    result: { conditionId: 'cond-existing' },
  })
})

test('native market creation commands reject conflicting or invalid inputs before RPC', async () => {
  const cases: Array<{ args: string[]; error: RegExp }> = [
    {
      args: ['--condition-id', 'cond-1', '--creation-id', 'create-1'],
      error: /Specify either --condition-id or --creation-id/,
    },
    { args: [], error: /Specify either --condition-id.*--creation-id/ },
    {
      args: ['--creation-id', 'create-no-relay', '--maturity-epoch', '1'],
      error: /requires at least one --relay URL/,
    },
    {
      args: ['--creation-id', 'create-no-maturity', '--relay', 'wss://relay.example'],
      error: /requires --maturity-epoch/,
    },
    {
      args: [
        '--creation-id',
        'create-bad-color',
        '--maturity-epoch',
        '1',
        '--relay',
        'wss://relay.example',
        '--outcome-color',
        'Maybe=red',
      ],
      error: /Invalid outcome color/,
    },
    {
      args: [
        '--creation-id',
        'create-bad-type',
        '--maturity-epoch',
        '1',
        '--relay',
        'wss://relay.example',
        '--outcome-type',
        'numeric',
      ],
      error: /Invalid market outcome type/,
    },
    {
      args: [
        '--creation-id',
        'create-bad-u32',
        '--maturity-epoch',
        '4294967296',
        '--relay',
        'wss://relay.example',
      ],
      error: /Invalid maturity epoch/,
    },
  ]
  for (const scenario of cases) {
    await assert.rejects(
      runCliWithEnv(
        [
          'market',
          'create',
          '--title',
          'Market',
          '--description',
          'Description',
          '--outcomes',
          'Yes,No',
          ...scenario.args,
        ],
        {
          ...process.env,
          BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([]),
        },
      ),
      (error: unknown) => scenario.error.test((error as { stderr?: string }).stderr ?? ''),
    )
  }
})

test('native creation dry runs stay local and do not trust the engine URL', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-native-create-dry-run-'))
  try {
    const env = {
      ...process.env,
      BITCASTER_CLI_HOME: home,
      BITCASTER_TEST_ENGINE_URL: 'https://engine.example',
      BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
      BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([]),
    }
    const created = await runCliWithEnv(
      [
        'market',
        'create',
        '--creation-id',
        'dry-create-001',
        '--title',
        'Will it rain?',
        '--description',
        'Weather market',
        '--outcomes',
        'Yes,No',
        '--maturity-epoch',
        '1893456000',
        '--relay',
        'wss://relay.example',
        '--max-wallet-debit-msat',
        '1000000',
        '--thumbnail',
        '/tmp/thumbnail.png',
        '--dry-run',
      ],
      env,
    )
    assert.deepEqual(JSON.parse(created.stdout), {
      creationId: 'dry-create-001',
      eventId: 'dry-create-001',
      market: {
        title: 'Will it rain?',
        description: 'Weather market',
        outcomeType: 'yesno',
        outcomeDetails: [{ name: 'Yes' }, { name: 'No' }],
        maturityEpoch: 1_893_456_000,
        categoryTags: [],
        baseAsset: 'sat',
      },
      relayUrls: ['wss://relay.example'],
      thumbnailPath: '/tmp/thumbnail.png',
      maxWalletDebitMsat: 1_000_000,
    })
    let config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8')) as {
      cli: { trustedEngineUrls: string[] }
    }
    assert.deepEqual(config.cli.trustedEngineUrls, [])

    const resumed = await runCliWithEnv(
      [
        'market',
        'creation-resume',
        'dry-create-001',
        '--thumbnail',
        '/tmp/thumbnail.png',
        '--dry-run',
      ],
      env,
    )
    assert.deepEqual(JSON.parse(resumed.stdout), {
      creationId: 'dry-create-001',
      thumbnailPath: '/tmp/thumbnail.png',
    })
    config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8')) as {
      cli: { trustedEngineUrls: string[] }
    }
    assert.deepEqual(config.cli.trustedEngineUrls, [])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('wallet claim sends the exact position and preserves oracle warnings and operation IDs in JSON', async () => {
  const params = { conditionId: 'ab'.repeat(32), outcomeCollection: 'Beta|Gamma' }
  const response = {
    ok: true,
    result: {
      ...params,
      legs: [
        {
          operationId: 'claim-operation',
          keysetId: 'historical-keyset',
          state: 'pending',
          payoutAmountSubunits: 0,
          oracleEvidence: {
            status: 'unverified',
            reason: 'unavailable',
            warning:
              'The mint reports this outcome, but we have not verified evidence from the intended oracle.',
          },
        },
      ],
    },
  }
  const result = await runCliWithEnv(
    ['wallet', 'claim', params.conditionId.toUpperCase(), params.outcomeCollection],
    {
      ...process.env,
      BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
      BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([
        { command: { method: 'wallet.claimPosition', params }, response },
      ]),
    },
  )
  assert.deepEqual(JSON.parse(result.stdout), response)
  const dryRun = await runCliWithEnv(
    ['wallet', 'claim', params.conditionId, params.outcomeCollection, '--dry-run'],
    {
      ...process.env,
      BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
      BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([]),
    },
  )
  const request = JSON.parse(dryRun.stdout)
  assert.equal(request.method, 'wallet.claimPosition')
  assert.deepEqual(request.params, params)
  await assert.rejects(
    runCliWithEnv(['wallet', 'claim', params.conditionId, 'Beta||Gamma'], {
      ...process.env,
      BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
      BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([]),
    }),
    (error: unknown) => {
      assert.match((error as { stderr?: string }).stderr ?? '', /wallet claim requires/)
      return true
    },
  )
})

test('wallet Remove requires an exact preview file and explicit acknowledgement with mocked network I/O', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cli-remove-'))
  try {
    const params = { conditionId: 'ab'.repeat(32), outcomeCollection: 'Beta|Gamma' }
    const preview = {
      version: 1,
      scopeId: 'custody:wallet:' + 'a'.repeat(64),
      mintUrl: 'https://mint.example',
      ...params,
      targets: [
        {
          proofId: 'b'.repeat(64),
          keysetId: 'historical',
          amountSubunits: 8,
          proofSnapshot: 'c'.repeat(64),
          operationId: 'losing-operation',
          operationSnapshot: 'd'.repeat(64),
          canonicalSnapshot: null,
        },
      ],
      batchDigest: 'e'.repeat(64),
      moreProofsRemain: true,
    }
    const envelope = { ok: true, result: preview }
    const file = join(home, 'preview.json')
    await writeFile(file, JSON.stringify(envelope), { mode: 0o600 })
    const env = {
      ...process.env,
      BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
      BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([
        { command: { method: 'wallet.removePreview', params }, response: envelope },
      ]),
    }
    const shown = await runCliWithEnv(
      ['wallet', 'remove-preview', params.conditionId.toUpperCase(), params.outcomeCollection],
      env,
    )
    assert.equal(JSON.stringify(JSON.parse(shown.stdout)), JSON.stringify(envelope))
    const result = {
      ok: true,
      result: {
        state: 'completed',
        retiredProofCount: 1,
        operationIds: ['losing-operation'],
        moreProofsRemain: true,
      },
    }
    const acknowledged = { preview, acknowledge: true }
    const removed = await runCliWithEnv(
      ['wallet', 'remove', '--preview-file', file, '--acknowledge-loss'],
      {
        ...env,
        BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([
          { command: { method: 'wallet.removePosition', params: acknowledged }, response: result },
        ]),
      },
    )
    assert.equal(JSON.stringify(JSON.parse(removed.stdout)), JSON.stringify(result))
    const noNetwork = { ...env, BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([]) }
    const dry = await runCliWithEnv(
      ['wallet', 'remove', '--preview-file', file, '--acknowledge-loss', '--dry-run'],
      noNetwork,
    )
    assert.equal(JSON.parse(dry.stdout).method, 'wallet.removePosition')
    await assert.rejects(runCliWithEnv(['wallet', 'remove', '--preview-file', file], noNetwork))
    await assert.rejects(
      runCliWithEnv(['wallet', 'remove-preview', params.conditionId, 'Beta||Gamma'], noNetwork),
    )
    await chmod(file, 0o644)
    await assert.rejects(
      runCliWithEnv(['wallet', 'remove', '--preview-file', file, '--acknowledge-loss'], noNetwork),
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('native creation resume, status, and quote send the exact daemon RPC params', async () => {
  const resumeResult = await runCliWithEnv(
    [
      'market',
      'creation-resume',
      'create-resume-001',
      '--max-wallet-debit-msat',
      '0',
      '--thumbnail',
      '/tmp/same-thumbnail.png',
    ],
    {
      ...process.env,
      BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
      BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([
        {
          command: {
            method: 'market.creation-resume',
            params: {
              creationId: 'create-resume-001',
              maxWalletDebitMsat: 0,
              thumbnailPath: '/tmp/same-thumbnail.png',
            },
          },
          response: {
            ok: true,
            result: { creationId: 'create-resume-001', status: 'payment-pending' },
          },
        },
      ]),
    },
  )
  assert.deepEqual(JSON.parse(resumeResult.stdout), {
    ok: true,
    result: { creationId: 'create-resume-001', status: 'payment-pending' },
  })

  const statusResult = await runCliWithEnv(['market', 'creation-status', 'create-status-001'], {
    ...process.env,
    BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
    BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([
      {
        command: {
          method: 'market.creation-status',
          params: { creationId: 'create-status-001' },
        },
        response: {
          ok: true,
          result: {
            creationId: 'create-status-001',
            eventId: 'event-status-001',
            conditionId: null,
            announcementPrepared: false,
            chosenOutcome: null,
            attestationPrepared: false,
          },
        },
      },
    ]),
  })
  assert.deepEqual(JSON.parse(statusResult.stdout), {
    ok: true,
    result: {
      creationId: 'create-status-001',
      eventId: 'event-status-001',
      conditionId: null,
      announcementPrepared: false,
      chosenOutcome: null,
      attestationPrepared: false,
    },
  })

  const quoteResult = await runCliWithEnv(
    ['market', 'creation-quote', '--outcomes', 'Alpha,Beta,Gamma'],
    {
      ...process.env,
      BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
      BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([
        {
          command: {
            method: 'market.creation-quote',
            params: { outcomes: ['Alpha', 'Beta', 'Gamma'] },
          },
          response: {
            ok: true,
            result: {
              requiredFeeMsat: 500,
              sendPreparationFeeMsat: 1,
              totalWalletDebitMsat: 501,
            },
          },
        },
      ]),
    },
  )
  assert.deepEqual(JSON.parse(quoteResult.stdout), {
    ok: true,
    result: {
      requiredFeeMsat: 500,
      sendPreparationFeeMsat: 1,
      totalWalletDebitMsat: 501,
    },
  })
})

test('market close selects native outcome signing or supplied attestation without changing either payload', async () => {
  const event = kind89Event()
  for (const [flags, command] of [
    [
      ['--outcome', 'Yes'],
      { method: 'market.attest', params: { conditionId: 'cond-1', outcome: 'Yes' } },
    ],
    [
      ['--outcome', 'Yes', '--explanation', 'Plain <b>text</b>.'],
      {
        method: 'market.attest',
        params: { conditionId: 'cond-1', outcome: 'Yes', explanation: 'Plain <b>text</b>.' },
      },
    ],
    [['--retry'], { method: 'market.attestation-retry', params: { conditionId: 'cond-1' } }],
    [
      ['--attestation', JSON.stringify(event)],
      { method: 'market.close', params: { conditionId: 'cond-1', attestationEvent: event } },
    ],
  ] as const) {
    const result = await runCliWithEnv(
      ['market', 'close', '--condition-id', 'cond-1', '--trust-engine-url', ...flags],
      {
        ...process.env,
        BITCASTER_TEST_ENGINE_URL: 'https://engine.example',
        BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
        BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([
          { command, response: { ok: true, result: { result: 'Closed' } } },
        ]),
      },
    )
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, result: { result: 'Closed' } })
  }
})

test('market close rejects missing or conflicting resolution modes before RPC', async () => {
  for (const flags of [[], ['--outcome', 'Yes', '--attestation', JSON.stringify(kind89Event())]]) {
    await assert.rejects(
      runCliWithEnv(['market', 'close', '--condition-id', 'cond-1', ...flags], {
        ...process.env,
        BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([]),
      }),
      (error: unknown) =>
        /Specify exactly one of --attestation, --outcome, or --retry/.test(
          String((error as { stderr?: string }).stderr),
        ),
    )
  }
})

test('native resolution status uses the existing daemon RPC family without sockets', async () => {
  const status = {
    conditionId: 'cond-1',
    chosenOutcome: 'Yes',
    relayPublished: false,
    engineSynchronized: true,
  }
  const result = await runCliWithEnv(['market', 'resolution-status', 'cond-1'], {
    ...process.env,
    BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
    BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([
      {
        command: { method: 'market.resolution-status', params: { conditionId: 'cond-1' } },
        response: { ok: true, result: status },
      },
    ]),
  })
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, result: status })
})

test('native resolution explanation uses one UTF-8 bound for inline text and files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-native-explanation-'))
  try {
    const file = join(home, 'reason.txt')
    const content = 'Ω'.repeat(2048)
    await writeFile(file, content)
    const params = { conditionId: 'cond-1', outcome: 'Yes', explanation: content }
    const result = await runCliWithEnv(
      [
        'market',
        'close',
        '--condition-id',
        'cond-1',
        '--outcome',
        'Yes',
        '--explanation',
        `@${file}`,
        '--trust-engine-url',
      ],
      {
        ...process.env,
        BITCASTER_TEST_ENGINE_URL: 'https://engine.example',
        BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
        BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([
          { command: { method: 'market.attest', params }, response: { ok: true, result: {} } },
        ]),
      },
    )
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, result: {} })
    await writeFile(file, `${content}Ω`)
    for (const reason of [`${content}Ω`, `@${file}`]) {
      await assert.rejects(
        runCliWithEnv(
          [
            'market',
            'close',
            '--condition-id',
            'cond-1',
            '--outcome',
            'Yes',
            '--explanation',
            reason,
            '--trust-engine-url',
          ],
          {
            ...process.env,
            BITCASTER_TEST_ENGINE_URL: 'https://engine.example',
            BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([]),
          },
        ),
        (error: unknown) => /4096 UTF-8 bytes/.test(String((error as { stderr?: string }).stderr)),
      )
    }
    await writeFile(file, Buffer.from([0xff]))
    await assert.rejects(
      runCliWithEnv(
        [
          'market',
          'close',
          '--condition-id',
          'cond-1',
          '--outcome',
          'Yes',
          '--explanation',
          `@${file}`,
          '--trust-engine-url',
        ],
        {
          ...process.env,
          BITCASTER_TEST_ENGINE_URL: 'https://engine.example',
          BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([]),
        },
      ),
      (error: unknown) =>
        /Explanation file is invalid/.test(String((error as { stderr?: string }).stderr)),
    )
    await assert.rejects(
      runCliWithEnv(
        ['market', 'close', '--condition-id', 'cond-1', '--retry', '--explanation', 'reason'],
        {
          ...process.env,
          BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([]),
        },
      ),
      (error: unknown) =>
        /--explanation requires --outcome/.test(String((error as { stderr?: string }).stderr)),
    )
  } finally {
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
    ...[
      { name: 'null event', event: null },
      { name: 'numeric tag item', event: { ...kind89Event(), tags: [['d', 1]] } },
      { name: 'numeric content', event: { ...kind89Event(), content: 1 } },
      { name: 'string timestamp', event: { ...kind89Event(), createdAt: '1' } },
    ].map(({ name, event }) => ({
      name,
      attestation: JSON.stringify(event),
      stderr: /Oracle attestation must be a kind-89 Nostr event/,
    })),
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
    '--amount-msat',
    '100',
    '--min-fill-msat',
    '50',
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
    consolidateProofs: false,
    timeInForce: 'FOK',
    expiresAt: null,
  })
  assert.doesNotMatch(result.stdout, /secret|witness|mnemonic|nwc|authorization|sig/i)
})

test('order submit maps exact aggregate consent flags for Buy and Sell', async () => {
  for (const [side, flag, field] of [
    ['Buy', '--max-quote-payment-msat', 'maxQuotePaymentSubunits'],
    ['Sell', '--min-quote-payment-msat', 'minQuotePaymentSubunits'],
  ] as const) {
    for (const tokenSide of ['Outcome', 'Complement']) {
      const result = await runCliWithOutput('http://127.0.0.1:1', [
        'order',
        'submit',
        '--market',
        'cond-YES',
        '--outcome',
        'YES',
        '--side',
        side,
        '--price',
        '500',
        '--amount-msat',
        '10000',
        '--token-side',
        tokenSide,
        flag,
        '4000',
        '--dry-run',
      ])
      const request = JSON.parse(result.stdout)
      assert.equal(request.side, side)
      assert.equal(request.tokenSide, tokenSide)
      assert.equal(request.price, 500)
      assert.equal(request[field], 4000)
      assert.equal(
        request[side === 'Buy' ? 'minQuotePaymentSubunits' : 'maxQuotePaymentSubunits'],
        undefined,
      )
    }
  }
})

test('order submit rejects invalid aggregate consent flags before RPC', async () => {
  for (const flags of [
    ['--max-quote-payment-msat', '-1'],
    ['--max-quote-payment-msat', '1.5'],
    ['--max-quote-payment-msat', '9007199254740992'],
    ['--min-quote-payment-msat', '4000'],
    ['--max-quote-payment-msat', '4000', '--min-quote-payment-msat', '4000'],
  ]) {
    await assert.rejects(
      () =>
        runCliWithOutput('http://127.0.0.1:1', [
          'order',
          'submit',
          '--market',
          'cond-YES',
          '--outcome',
          'YES',
          '--side',
          'Buy',
          '--price',
          '500',
          '--amount-msat',
          '10000',
          ...flags,
          '--dry-run',
        ]),
      /Invalid max quote payment|quote payment bound is invalid/,
    )
  }
})

test('public order submit rejects the removed --tif option', async () => {
  await assertCliFailure(
    [
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
      '--amount-msat',
      '100',
      '--tif',
      'FAK',
    ],
    /unknown option '--tif'/,
  )
})

test('market creation rejects the removed --liquidity-sats option', async () => {
  await assertCliFailure(
    [
      'market',
      'create',
      '--condition-id',
      'cond-1',
      '--title',
      'Winner',
      '--description',
      'Alpha or Beta',
      '--outcomes',
      'Alpha,Beta',
      '--liquidity-sats',
      '0',
    ],
    /unknown option '--liquidity-sats'/,
  )
})

test('P47-7: bitcaster-cli wallet and market --dry-run commands do not call daemon and redact sensitive fields', async () => {
  const attestation = kind89Event()
  const cases: Array<{ args: string[]; expected: unknown }> = [
    {
      args: ['wallet', 'send', '25', '--mint', 'mint-a', '--operation-id', 'op-1', '--dry-run'],
      expected: { amountMsat: 25_000, mintUrl: 'mint-a', operationId: 'op-1' },
    },
    {
      args: ['wallet', 'split', 'cond-1', '1.001', '--mint', 'mint-a', '--dry-run'],
      expected: { conditionId: 'cond-1', amountMsat: 1_001, mintUrl: 'mint-a' },
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
        '--trust-engine-url',
        '--dry-run',
      ],
      expected: {
        conditionId: 'cond-1',
        title: 'Market',
        description: 'Description',
        outcomes: ['YES', 'NO'],
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

test('wallet invoice CLI commands dispatch the exact daemon methods and support dry-run', async () => {
  if (process.platform === 'win32') return
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-native-invoice-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  await ensureRpcToken()
  const received: Array<{ method: string; params?: Record<string, unknown> }> = []
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/rpc') {
      writeJson(res, 404, { ok: false, error: 'not found' })
      return
    }
    const command = JSON.parse(await readBody(req)) as {
      method: string
      params?: Record<string, unknown>
    }
    received.push(command)
    writeJson(res, 200, { ok: true, result: command })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.equal(typeof address, 'object')
  assert.ok(address)
  const daemonUrl = `http://127.0.0.1:${address.port}`
  const quoteRecordId = 'a'.repeat(64)

  try {
    const replacementHelp = await runCliWithOutput(daemonUrl, [
      'wallet',
      'invoice',
      'replace',
      '--help',
    ])
    assert.match(
      replacementHelp.stdout,
      /Hide the previous invoice before creating its replacement/,
    )

    await runCli(daemonUrl, ['wallet', 'invoice', 'create', '--amount-msat', '25000'])
    await runCli(daemonUrl, ['wallet', 'invoice', 'show', quoteRecordId])
    await runCli(daemonUrl, ['wallet', 'invoice', 'hide', quoteRecordId])
    await runCli(daemonUrl, [
      'wallet',
      'invoice',
      'replace',
      quoteRecordId,
      '--amount-msat',
      '30000',
    ])

    assert.deepEqual(received, [
      { method: 'wallet.invoice.create', params: { amountMsat: 25_000 } },
      { method: 'wallet.invoice.show', params: { quoteRecordId } },
      { method: 'wallet.invoice.hide', params: { quoteRecordId } },
      { method: 'wallet.invoice.replace', params: { quoteRecordId, amountMsat: 30_000 } },
    ])

    const dryRun = await runCliWithOutput(daemonUrl, [
      'wallet',
      'invoice',
      'replace',
      quoteRecordId,
      '--amount-msat',
      '40000',
      '--dry-run',
    ])
    assert.match(dryRun.stdout, /"quoteRecordId"\s*:\s*"[a-f0-9]{64}"/)
    assert.match(dryRun.stdout, /"amountMsat"\s*:\s*40000/)
    assert.equal(received.length, 4)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('wallet payment CLI quotes an invoice file and reuses the exact consent for execute and status', async () => {
  if (process.platform === 'win32') return
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-wallet-payment-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  await ensureRpcToken()
  const invoice = 'lnbc1invoice-from-owner-only-file'
  const quote = {
    operationId: `wallet-melt:${'a'.repeat(64)}`,
    walletId: 'b'.repeat(64),
    mintUrl: 'https://mint.example',
    unit: 'msat',
    method: 'bolt11',
    invoice,
    quoteId: 'payment-quote-1',
    amountMsat: 2_000,
    feeReserveMsat: 25,
    selectedInputFeeMsat: 3,
    totalWalletDebitMsat: 2_028,
    expiryUnixSeconds: 1_900_000_000,
    state: 'UNPAID',
  }
  const received: Array<{ method: string; params?: Record<string, unknown> }> = []
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/rpc') {
      writeJson(res, 404, { ok: false, error: 'not found' })
      return
    }
    const command = JSON.parse(await readBody(req)) as {
      method: string
      params?: Record<string, unknown>
    }
    received.push(command)
    if (command.method === 'wallet.pay.quote') {
      writeJson(res, 200, { ok: true, result: quote })
    } else if (command.method === 'wallet.pay.execute') {
      writeJson(res, 200, {
        ok: true,
        result: { operationId: quote.operationId, state: 'pending', changeCount: 0 },
      })
    } else {
      writeJson(res, 200, {
        ok: true,
        result: { operationId: quote.operationId, state: 'paid', changeCount: 1 },
      })
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.equal(typeof address, 'object')
  assert.ok(address)
  const daemonUrl = `http://127.0.0.1:${address.port}`
  const invoiceFile = join(home, 'invoice.txt')
  const consentFile = join(home, 'payment-quote.json')

  try {
    await writeFile(invoiceFile, `${invoice}\n`, { mode: 0o600 })
    const dryRun = await runCliWithOutput(daemonUrl, [
      'wallet',
      'pay',
      'quote',
      '--invoice-file',
      invoiceFile,
      '--dry-run',
    ])
    assert.doesNotMatch(dryRun.stdout, new RegExp(invoice))
    assert.equal(received.length, 0)

    const quoted = await runCliWithOutput(daemonUrl, [
      'wallet',
      'pay',
      'quote',
      '--invoice-file',
      invoiceFile,
    ])
    assert.deepEqual(JSON.parse(quoted.stdout), { ok: true, result: quote })
    await writeFile(consentFile, quoted.stdout, { mode: 0o600 })

    await runCli(daemonUrl, ['wallet', 'pay', 'execute', '--fee-consent-file', consentFile])
    await runCli(daemonUrl, ['wallet', 'pay', 'status', quote.operationId])

    assert.deepEqual(received, [
      { method: 'wallet.pay.quote', params: { invoice } },
      { method: 'wallet.pay.execute', params: { consent: quote } },
      { method: 'wallet.pay.status', params: { operationId: quote.operationId } },
    ])
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('P47-7: removed aliases exit with usage error code 2', async () => {
  const removedAliases = [
    ['markets', 'list'],
    ['wallet', 'split-complete-set', 'cond-1', '100'],
    ['consolidate', 'cond-A'],
    ['wallet', 'consolidate', 'cond-A', '--type', 't1'],
    ['order', 'submit', 'cond-YES', 'YES', 'Buy', '42', '100'],
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
      mintUrls: [mintUrl],
      autoRetireResolvedConditionInventory: false,
      assetMonitoringEnabled: false,
      nostrRelays: [],
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
  options: { childTimeoutMs?: number } = {},
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
        ...(effectiveEnv.BITCASTER_TEST_FETCH_MODULE === undefined
          ? []
          : ['--import', effectiveEnv.BITCASTER_TEST_FETCH_MODULE]),
        join(import.meta.dirname, '..', 'src', 'main.ts'),
        ...effectiveArgs,
      ],
      {
        env: effectiveEnv,
        ...(options.childTimeoutMs === undefined ? {} : { timeout: options.childTimeoutMs }),
      },
    )
  } finally {
    if (transientDataDir !== undefined) {
      await rm(transientDataDir, { recursive: true, force: true })
    }
  }
}

type PublicMintTestResponses = Record<string, { keysets?: unknown[] } & Record<string, unknown>>

function publicMintMetadataResponses(mintUrl: string): PublicMintTestResponses {
  return {
    [`${mintUrl}/v1/info`]: {
      name: 'Example mint',
      pubkey: 'ab'.repeat(32),
      version: '2.0',
      description: 'Short description',
      description_long: 'Long description',
      motd: 'Notice',
      contact: [{ method: 'email', info: 'ops@example.test' }],
      nuts: {
        '4': {
          methods: [{ method: 'bolt11', unit: 'sat', min_amount: null, max_amount: 1000 }],
          disabled: false,
        },
        '5': { methods: [], disabled: true },
        '7': { supported: true },
      },
    },
    [`${mintUrl}/v1/keysets`]: {
      keysets: [
        { id: 'sat-active', unit: 'sat', active: true, input_fee_ppk: 1234 },
        { id: 'msat-old', unit: 'msat', active: false, input_fee_ppk: 0, final_expiry: 900 },
      ],
    },
    [`${mintUrl}/v1/keys`]: {
      keysets: [
        {
          id: 'sat-active',
          unit: 'sat',
          active: true,
          input_fee_ppk: 1234,
          keys: { '1': 'sat-key' },
        },
        {
          id: 'msat-active',
          unit: 'msat',
          active: true,
          input_fee_ppk: 17,
          keys: { '1': 'msat-key' },
        },
      ],
    },
  }
}

function publicMintFetchModule(mintUrl: string, responses: PublicMintTestResponses): string {
  const endpoints = ['/v1/info', '/v1/keysets', '/v1/keys'].map((path) => `${mintUrl}${path}`)
  const code = `
    import assert from 'node:assert/strict'
    const endpoints = ${JSON.stringify(endpoints)}
    const responses = ${JSON.stringify(responses)}
    const seen = []
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      assert.ok(endpoints.includes(url), 'Unexpected mint request: ' + url)
      assert.ok(init?.method === undefined || init.method === 'GET', 'Mint metadata reads must use GET')
      assert.equal(new Headers(init?.headers).has('authorization'), false, 'Mint metadata reads must be anonymous')
      seen.push(url)
      return new Response(JSON.stringify(responses[url]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    process.once('beforeExit', () => {
      assert.deepEqual(seen.sort(), [...endpoints].sort(), 'CLI must read info, keysets, and keys once each')
    })
  `
  return `data:text/javascript,${encodeURIComponent(code)}`
}

function publicEngineFetchSequenceModule(
  steps: Array<{ path: string; request: unknown; response: unknown; status?: number }>,
  baseUrl = 'https://engine.example',
): string {
  const code = `
    import assert from 'node:assert/strict'
    const steps = ${JSON.stringify(
      steps.map((step) => ({ ...step, url: `${baseUrl}${step.path}` })),
    )}
    let nextStep = 0
    process.once('beforeExit', () => {
      assert.equal(nextStep, steps.length, 'CLI did not consume every mocked engine response')
    })
    globalThis.fetch = async (input, init) => {
      const step = steps[nextStep++]
      assert.ok(step, 'Unexpected anonymous engine request')
      assert.equal(String(input), step.url)
      assert.equal(init?.method, 'POST')
      const headers = new Headers(init?.headers)
      assert.equal(headers.has('authorization'), false, 'Public order reads must be anonymous')
      assert.deepEqual(JSON.parse(String(init?.body ?? 'null')), step.request)
      return new Response(JSON.stringify(step.response), {
        status: step.status ?? 200,
        headers: { 'content-type': 'application/json' },
      })
    }
  `
  return `data:text/javascript,${encodeURIComponent(code)}`
}

function publicEngineGetSequenceModule(
  steps: Array<{ url: string; response: unknown; status?: number }>,
): string {
  const code = `
    import assert from 'node:assert/strict'
    const steps = ${JSON.stringify(steps)}
    let nextStep = 0
    process.once('beforeExit', () => {
      assert.equal(nextStep, steps.length, 'CLI did not consume every mocked public engine response')
    })
    globalThis.fetch = async (input, init) => {
      const step = steps[nextStep++]
      assert.ok(step, 'Unexpected public engine request')
      assert.equal(String(input), step.url)
      assert.equal(init?.method, undefined, 'Public engine reads must use GET')
      assert.equal(new Headers(init?.headers).has('authorization'), false)
      return new Response(JSON.stringify(step.response), {
        status: step.status ?? 200,
        headers: { 'content-type': 'application/json' },
      })
    }
  `
  return `data:text/javascript,${encodeURIComponent(code)}`
}

function runDefaultPublicEngineReadCli(
  home: string,
  args: string[],
  steps: Array<{ url: string; response: unknown; status?: number }>,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--import',
      join(import.meta.dirname, 'rpcTransportTestSetup.ts'),
      '--import',
      publicEngineGetSequenceModule(steps),
      join(import.meta.dirname, '..', 'src', 'main.ts'),
      '--datadir',
      home,
      ...args,
    ],
    {
      env: {
        ...process.env,
        BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
        NODE_NO_WARNINGS: '1',
      },
    },
  )
}

function orderStatusCommand(marketId: string, orderId: string): object {
  return { method: 'order.status', params: { marketId, orderId } }
}

function makeOrderStatus(
  status: string,
  activeSettlementGroup: object | null,
  orderId = 'order-1',
): Record<string, unknown> {
  return {
    orderId,
    marketId: 'condition-1-YES',
    status,
    remainingAmountSubunits: status === 'filled' ? 0 : 1000,
    filledAmountSubunits: status === 'filled' ? 1000 : 0,
    fills: [],
    amountSubunits: 1000,
    outcomeId: 'YES',
    side: 'Buy',
    price: 420,
    placedAt: '2026-09-29T11:59:00Z',
    timeInForce: 'FOK',
    expiresAt: null,
    tokenSide: 'Outcome',
    baseAsset: 'sat',
    divisibility: 1000,
    activeSettlementGroup,
  }
}

function orderStatusDaemonResponse(engine: Record<string, unknown> | null): {
  ok: true
  result: { engine: Record<string, unknown> | null; local: unknown }
} {
  return {
    ok: true,
    result: {
      engine,
      local:
        engine === null
          ? null
          : {
              orderId: engine.orderId,
              marketId: engine.marketId,
              status: engine.status,
            },
    },
  }
}

function daemonRpcFetchModule(
  steps: Array<{
    command?: object
    commandMatch?: {
      method: string
      conditionId: string
      attemptKind?: 'begin' | 'resume'
      expectedPreviousTransferId?: string | null
      requestedAmount?: string
      maxWalletDebitMsat?: number
      transferId?: string
    }
    response?: unknown
    responseFromAttempt?: 'pending' | 'received' | 'credited'
    rejectWith?: string
    waitForAbort?: boolean
  }>,
  expectedAbortCount = 0,
): string {
  const code = `
    import assert from 'node:assert/strict'
    const steps = ${JSON.stringify(steps)}
    let nextStep = 0
    let abortCount = 0
    process.once('beforeExit', () => {
      assert.equal(nextStep, steps.length, 'CLI did not consume every mocked daemon response')
      assert.equal(abortCount, ${expectedAbortCount}, 'CLI did not abort the pending daemon RPC')
    })
    globalThis.fetch = async (input, init) => {
      assert.equal(new URL(String(input)).pathname, '/rpc')
      assert.equal(init?.method, 'POST')
      const step = steps[nextStep++]
      assert.ok(step, 'Unexpected daemon RPC')
      const command = JSON.parse(String(init?.body ?? 'null'))
      if (step.command !== undefined) assert.deepEqual(command, step.command)
      if (step.commandMatch !== undefined) {
        assert.equal(command.method, step.commandMatch.method)
        assert.equal(command.params.conditionId, step.commandMatch.conditionId)
        if (step.commandMatch.attemptKind === 'begin') {
          assert.equal(command.params.attempt.kind, 'begin')
          assert.equal(
            command.params.attempt.expectedPreviousTransferId,
            step.commandMatch.expectedPreviousTransferId,
          )
          assert.equal(command.params.attempt.requestedAmount, step.commandMatch.requestedAmount)
          assert.match(command.params.attempt.newAttemptId, /^[0-9a-f-]{36}$/)
          assert.equal(command.params.maxWalletDebitMsat, step.commandMatch.maxWalletDebitMsat)
        } else if (step.commandMatch.attemptKind === 'resume') {
          assert.equal(command.params.attempt.kind, 'resume')
          assert.equal(command.params.attempt.transferId, step.commandMatch.transferId)
          assert.equal('maxWalletDebitMsat' in command.params, false)
        }
      }
      if (step.rejectWith !== undefined) throw new TypeError(step.rejectWith)
      if (step.waitForAbort) {
        const signal = init?.signal
        assert.ok(signal, 'wait command must pass its deadline signal to RPC')
        return await new Promise((_resolve, reject) => {
          const keepAlive = setInterval(() => {}, 1000)
          const onAbort = () => {
            clearInterval(keepAlive)
            abortCount += 1
            reject(signal.reason ?? new Error('daemon RPC aborted'))
          }
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        })
      }
      const response =
        step.responseFromAttempt === undefined
          ? step.response
          : {
              ok: true,
              result: {
                deliveryId: command.params.attempt.newAttemptId,
                transferId: command.params.attempt.newAttemptId,
                state: step.responseFromAttempt,
              },
            }
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
  `
  return `data:text/javascript,${encodeURIComponent(code)}`
}

function orderFeeFactsFixture() {
  const regularAsset = { kind: 'regular', unit: 'msat' }
  return {
    settlementInputFeeSubunits: '3',
    sourcePreparationFeeSubunits: '1',
    consolidationFeeSubunits: '0',
    settlementAsset: regularAsset,
    sourcePreparationAsset: regularAsset,
    consolidationAsset: regularAsset,
    sourceMode: 'wallet-send',
  }
}

function orderFeeConsentEnvelope(request: Record<string, unknown>) {
  return { ok: true, result: { request, feeFacts: orderFeeFactsFixture() } }
}

function previewCliArgs(request: {
  marketId: string
  side: string
  tokenSide?: string
  price?: number
  faceAmountSubunits: number
}): string[] {
  return [
    'order',
    'preview',
    '--market',
    request.marketId,
    '--side',
    request.side,
    ...(request.tokenSide === undefined || request.tokenSide === 'Outcome'
      ? []
      : ['--token-side', request.tokenSide]),
    ...(request.price === undefined ? [] : ['--price', String(request.price)]),
    '--amount-msat',
    String(request.faceAmountSubunits),
  ]
}

function capacityCliArgs(request: {
  marketId: string
  side: string
  tokenSide?: string
  price?: number
}): string[] {
  return [
    'order',
    'capacity',
    '--market',
    request.marketId,
    '--side',
    request.side,
    ...(request.tokenSide === undefined || request.tokenSide === 'Outcome'
      ? []
      : ['--token-side', request.tokenSide]),
    ...(request.price === undefined ? [] : ['--price', String(request.price)]),
  ]
}

function runPublicOrderCli(
  args: string[],
  steps: Array<{ path: string; request: unknown; response: unknown; status?: number }>,
  baseUrl = 'https://engine.example',
): Promise<{ stdout: string; stderr: string }> {
  return runCliWithEnv(args, {
    ...process.env,
    BITCASTER_TEST_ENGINE_URL: baseUrl,
    BITCASTER_TEST_DAEMON_URL: 'http://127.0.0.1:1',
    BITCASTER_TEST_FETCH_MODULE: publicEngineFetchSequenceModule(steps, baseUrl),
  })
}

function runDefaultPublicOrderCli(
  home: string,
  args: string[],
  steps: Array<{ path: string; request: unknown; response: unknown; status?: number }>,
): Promise<{ stdout: string; stderr: string }> {
  const baseUrl = 'http://localhost:5000'
  return execFileAsync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--import',
      join(import.meta.dirname, 'rpcTransportTestSetup.ts'),
      '--import',
      publicEngineFetchSequenceModule(steps, baseUrl),
      join(import.meta.dirname, '..', 'src', 'main.ts'),
      '--datadir',
      home,
      ...args,
    ],
    {
      env: {
        ...process.env,
        BITCASTER_TEST_DAEMON_URL: 'http://127.0.0.1:1',
        NODE_NO_WARNINGS: '1',
      },
    },
  )
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

test('oracle backup CLI invokes authenticated local RPCs with exact frozen parameter shapes', async () => {
  const eventId = '01'.repeat(32)
  const cursor = {
    schemaVersion: 1,
    author: '02'.repeat(32),
    relayUrls: ['wss://relay.example'],
    relayIndex: 0,
    until: 100,
  }
  for (const [args, command] of [
    [['oracle-backup-list'], { method: 'market.oracle-backup-list', params: {} }],
    [
      ['oracle-backup-list', '--relay', 'wss://relay.example', '--cursor', JSON.stringify(cursor)],
      { method: 'market.oracle-backup-list', params: { relay: 'wss://relay.example', cursor } },
    ],
    [
      ['oracle-backup-restore', '--event-id', eventId, '--relay', 'wss://relay.example'],
      { method: 'market.oracle-backup-restore', params: { eventId, relay: 'wss://relay.example' } },
    ],
    [
      ['oracle-backup-status', 'cond-1'],
      { method: 'market.oracle-backup-status', params: { conditionId: 'cond-1' } },
    ],
    [['oracle-backup-status'], { method: 'market.oracle-backup-status', params: {} }],
    [
      ['oracle-backup-retry', 'cond-1'],
      { method: 'market.oracle-backup-retry', params: { conditionId: 'cond-1' } },
    ],
    [
      ['announcement-republish', 'cond-1'],
      { method: 'market.announcement-republish', params: { conditionId: 'cond-1' } },
    ],
  ] as const) {
    const result = await runCliWithEnv(['market', ...args], {
      ...process.env,
      BITCASTER_TEST_ENGINE_URL: 'https://unavailable.example',
      BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
      BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([
        { command, response: { ok: true, result: { safe: true } } },
      ]),
    })
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, result: { safe: true } })
  }
})

test('market close relay-only skips engine trust and preflight and forwards exact retry republication', async () => {
  for (const [flags, command] of [
    [
      ['--outcome', 'Yes', '--relay-only'],
      {
        method: 'market.attest',
        params: { conditionId: 'cond-1', outcome: 'Yes', relayOnly: true },
      },
    ],
    [
      ['--retry', '--relay-only'],
      { method: 'market.attestation-retry', params: { conditionId: 'cond-1', relayOnly: true } },
    ],
    [
      ['--retry', '--republish', '--relay-only'],
      {
        method: 'market.attestation-retry',
        params: { conditionId: 'cond-1', relayOnly: true, republish: true },
      },
    ],
    [
      ['--retry', '--republish', '--trust-engine-url'],
      { method: 'market.attestation-retry', params: { conditionId: 'cond-1', republish: true } },
    ],
  ] as const) {
    const result = await runCliWithEnv(['market', 'close', '--condition-id', 'cond-1', ...flags], {
      ...process.env,
      BITCASTER_TEST_ENGINE_URL: 'https://unavailable.example',
      BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
      BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([
        { command, response: { ok: true, result: { relayPublished: true } } },
      ]),
    })
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, result: { relayPublished: true } })
  }
})

test('market close rejects unsupported relay-only and republish combinations before RPC', async () => {
  for (const flags of [
    ['--attestation', JSON.stringify(kind89Event()), '--relay-only'],
    ['--outcome', 'Yes', '--republish'],
    ['--attestation', JSON.stringify(kind89Event()), '--republish'],
  ])
    await assert.rejects(
      runCliWithEnv(['market', 'close', '--condition-id', 'cond-1', ...flags], {
        ...process.env,
        BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([]),
      }),
      (error: unknown) => /requires --/.test(String((error as { stderr?: string }).stderr)),
    )
})

test('oracle local status CLI maps bounded paging and rejects page options with a condition ID', async () => {
  const cursor = '01'.repeat(32)
  const result = await runCliWithEnv(
    ['market', 'oracle-backup-status', '--cursor', cursor, '--limit', '2'],
    {
      ...process.env,
      BITCASTER_TEST_DAEMON_URL: 'http://daemon.test',
      BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([
        {
          command: { method: 'market.oracle-backup-status', params: { cursor, limit: 2 } },
          response: { ok: true, result: { statuses: [], cursor: null } },
        },
      ]),
    },
  )
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, result: { statuses: [], cursor: null } })
  for (const flags of [
    ['cond-1', '--limit', '2'],
    ['cond-1', '--cursor', cursor],
    ['--limit', '0'],
    ['--limit', '129'],
    ['--limit', '1.5'],
    ['--cursor', 'bad'],
    ['--cursor', 'A'.repeat(64)],
  ])
    await assert.rejects(
      runCliWithEnv(['market', 'oracle-backup-status', ...flags], {
        ...process.env,
        BITCASTER_TEST_FETCH_MODULE: daemonRpcFetchModule([]),
      }),
      (error: unknown) =>
        /require status without|Status page limit|Status cursor|Invalid status page limit/.test(
          String((error as { stderr?: string }).stderr),
        ),
    )
})
