import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { DRY_RUN_MODES, type DryRunMode } from '../src/dryRunPolicy.ts'

const execFileAsync = promisify(execFile)
const MAIN = join(import.meta.dirname, '..', 'src', 'main.ts')
const RPC_SETUP = join(import.meta.dirname, 'rpcTransportTestSetup.ts')
const FETCH_PRELOAD = join(import.meta.dirname, 'dryRunCliPreload.mjs')
const CONDITION = 'ab'.repeat(32)
const MARKET = `${CONDITION}-Yes`
const RECORD_ID = 'cd'.repeat(32)
const TRANSFER = '00000000-0000-4000-8000-000000000001'
const ENGINE_URL = 'https://engine.example'
const MINT_URL = 'https://mint.example'
const TOKEN_TEXT = 'cashuBsecret-token-text'
const SEED_HEX = 'ab'.repeat(64)
const SIGNER_KEY_HEX = '11'.repeat(32)

// Daemon methods that only read or quote. A read-only command can send only
// these methods with --dry-run. Every other daemon method changes state.
const READ_DAEMON_METHODS = new Set([
  'health',
  'daemon.status',
  'markets.query',
  'markets.show',
  'market.funding.quote',
  'market.funding.head',
  'market.creation-status',
  'market.creation-quote',
  'market.oracle-backup-list',
  'market.oracle-backup-status',
  'market.resolution-status',
  'wallet.balance',
  'wallet.positions',
  'wallet.portfolio',
  'wallet.assets',
  'wallet.invoice.show',
  'wallet.pay.status',
  'wallet.operations',
  'score.show',
  'score.status',
  'order.fee-preview',
  'order.status',
  'order.list',
  'order.book',
])

// Public engine previews that the contract defines as read-only POST requests.
const READ_POST_PATHS = new Set(['/api/v1/orders/preview', '/api/v1/orders/capacity-preview'])

interface CliRun {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

interface Request {
  readonly url?: string
  readonly method?: string
  readonly httpMethod?: string
  readonly websocket?: string
}

interface Files {
  readonly token: string
  readonly invoice: string
  readonly payQuote: string
  readonly scoreQuote: string
  readonly removalPreview: string
  readonly seed: string
  readonly signerKey: string
  readonly exportTarget: string
}

interface Fixture {
  readonly directory: string
  readonly files: Files
  run(args: readonly string[], options?: { daemon?: 'mock' | 'none' }): Promise<CliRun>
  requests(): Promise<Request[]>
  snapshot(): Promise<Record<string, string>>
  close(): Promise<void>
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'bitcaster-cli-dry-run-'))
  const directory = join(root, 'datadir')
  const logPath = join(root, 'requests.log')
  await mkdir(directory, { mode: 0o700 })
  await writeFile(logPath, '', { mode: 0o600 })
  await writeFile(
    join(directory, 'config.json'),
    `${JSON.stringify(
      {
        version: 2,
        daemon: {
          engineUrl: ENGINE_URL,
          mintUrl: MINT_URL,
          mintUrls: [MINT_URL],
          autoRetireResolvedConditionInventory: false,
          assetMonitoringEnabled: false,
          nostrRelays: [],
        },
        cli: { trustedEngineUrls: [] },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
  const files = await writeInputFiles(root)
  return {
    directory,
    files,
    async run(args, options = {}) {
      const daemon = options.daemon ?? 'mock'
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_NO_WARNINGS: '1',
        BITCASTER_TEST_FETCH_LOG: logPath,
      }
      delete env.BITCASTER_TEST_DAEMON_URL
      if (daemon === 'mock') env.BITCASTER_TEST_DAEMON_URL = 'http://daemon.test'
      try {
        const { stdout, stderr } = await execFileAsync(
          process.execPath,
          [
            '--experimental-strip-types',
            ...(daemon === 'mock' ? ['--import', RPC_SETUP, '--import', FETCH_PRELOAD] : []),
            MAIN,
            '--datadir',
            directory,
            ...args,
          ],
          { env, timeout: 30_000 },
        )
        return { code: 0, stdout, stderr }
      } catch (error) {
        const failure = error as { code?: unknown; stdout?: string; stderr?: string }
        if (typeof failure.code !== 'number') throw error
        return { code: failure.code, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
      } finally {
        await stopAutoStartedDaemon(directory)
      }
    },
    async requests() {
      return (await readFile(logPath, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Request)
    },
    async snapshot() {
      const snapshot: Record<string, string> = {}
      for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
        const path = join(entry.parentPath, entry.name)
        snapshot[path] = entry.isFile()
          ? (await readFile(path)).toString('base64')
          : '<not a regular file>'
      }
      return snapshot
    },
    async close() {
      await stopAutoStartedDaemon(directory)
      await rm(root, { recursive: true, force: true })
    },
  }
}

// Owner-only input files outside the data directory, valid for each command.
async function writeInputFiles(root: string): Promise<Files> {
  const write = async (name: string, content: string) => {
    const path = join(root, name)
    await writeFile(path, content, { mode: 0o600 })
    return path
  }
  return {
    token: await write('token.cashu', `${TOKEN_TEXT}\n`),
    invoice: await write('invoice.txt', 'lnbc10n1pexampleinvoice\n'),
    payQuote: await write(
      'pay-quote.json',
      JSON.stringify({
        ok: true,
        result: {
          operationId: `wallet-melt:${RECORD_ID}`,
          walletId: '03'.repeat(32),
          mintUrl: MINT_URL,
          unit: 'msat',
          method: 'bolt11',
          invoice: 'lnbc10n1pexampleinvoice',
          quoteId: 'quote-1',
          amountMsat: 1_000,
          feeReserveMsat: 2,
          selectedInputFeeMsat: 0,
          totalWalletDebitMsat: 1_002,
          expiryUnixSeconds: 1_893_456_000,
          state: 'UNPAID',
        },
      }),
    ),
    scoreQuote: await write(
      'score-quote.json',
      JSON.stringify({
        ok: true,
        result: {
          request: {
            deliveryId: TRANSFER,
            scorePoints: 1,
            amountMsat: 1_000,
            purchasedTotalEpoch: 0,
            engineBaseUrl: ENGINE_URL,
            accountSubject: '02'.repeat(32),
            mintUrl: MINT_URL,
            walletId: '03'.repeat(32),
          },
          cost: { amountMsat: 1_000, sendPreparationFeeMsat: 2, totalWalletDebitMsat: 1_002 },
        },
      }),
    ),
    removalPreview: await write(
      'removal-preview.json',
      JSON.stringify({ ok: true, result: { version: 1, targets: [{}], batchDigest: RECORD_ID } }),
    ),
    seed: await write('wallet-seed.hex', `${SEED_HEX}\n`),
    signerKey: await write('nostr-key.txt', `${SIGNER_KEY_HEX}\n`),
    exportTarget: join(root, 'exported-nsec.txt'),
  }
}

// A command that ignores --dry-run can start a detached daemon. Stop it so a
// failing run does not leave a process behind.
async function stopAutoStartedDaemon(directory: string): Promise<void> {
  const pidPath = join(directory, 'daemon-autostart.pid')
  if (!existsSync(pidPath)) return
  const { pid } = JSON.parse(await readFile(pidPath, 'utf8')) as { pid: number }
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'ESRCH') throw error
  }
}

type Args = (files: Files) => readonly string[]

const fundBeginArgs = [
  'market',
  'fund',
  'begin',
  CONDITION,
  '--amount-msat',
  '8000',
  '--max-wallet-debit-msat',
  '8002',
]

// Minimal valid arguments and the expected preview method of each supported command.
const SUPPORTED: Record<string, { args: Args; method: string }> = {
  'market watch': { args: () => ['market', 'watch', CONDITION], method: 'market.watch' },
  'market fund begin': { args: () => fundBeginArgs, method: 'market.fund' },
  'market fund resume': {
    args: () => ['market', 'fund', 'resume', CONDITION, TRANSFER],
    method: 'market.fund',
  },
  'market create': {
    args: () => [
      'market',
      'create',
      '--creation-id',
      'create-1',
      '--title',
      'Question',
      '--description',
      'Details',
      '--outcomes',
      'Yes,No',
      '--maturity-epoch',
      '1893456000',
      '--relay',
      'wss://relay.example',
    ],
    method: 'market.create-native',
  },
  'market creation-resume': {
    args: () => ['market', 'creation-resume', 'create-1'],
    method: 'market.creation-resume',
  },
  'market oracle-backup-restore': {
    args: () => [
      'market',
      'oracle-backup-restore',
      '--event-id',
      RECORD_ID,
      '--relay',
      'wss://relay.example',
    ],
    method: 'market.oracle-backup-restore',
  },
  'market oracle-backup-retry': {
    args: () => ['market', 'oracle-backup-retry', CONDITION],
    method: 'market.oracle-backup-retry',
  },
  'market announcement-republish': {
    args: () => ['market', 'announcement-republish', CONDITION],
    method: 'market.announcement-republish',
  },
  // --trust-engine-url checks trust. The unchanged data directory proves it is not saved.
  'market close': {
    args: () => [
      'market',
      'close',
      '--condition-id',
      CONDITION,
      '--outcome',
      'Yes',
      '--trust-engine-url',
    ],
    method: 'market.attest',
  },
  'market liked': { args: () => ['market', 'liked'], method: 'market.liked' },
  'market like': { args: () => ['market', 'like', CONDITION], method: 'market.like' },
  'market unlike': { args: () => ['market', 'unlike', CONDITION], method: 'market.unlike' },
  'mint add': { args: () => ['mint', 'add', 'https://mint2.example'], method: 'mint.add' },
  'mint select': { args: () => ['mint', 'select', MINT_URL], method: 'mint.select' },
  'mint remove': { args: () => ['mint', 'remove', MINT_URL], method: 'mint.remove' },
  'relay add': { args: () => ['relay', 'add', 'wss://relay2.example'], method: 'relay.add' },
  'relay remove': {
    args: () => ['relay', 'remove', 'wss://relay2.example'],
    method: 'relay.remove',
  },
  'wallet request create': {
    args: () => ['wallet', 'request', 'create'],
    method: 'wallet.request.create',
  },
  'wallet request status': {
    args: () => ['wallet', 'request', 'status', 'request-1'],
    method: 'wallet.request.status',
  },
  'wallet request recover': {
    args: () => ['wallet', 'request', 'recover', 'request-1'],
    method: 'wallet.request.recover',
  },
  'wallet request list': {
    args: () => ['wallet', 'request', 'list'],
    method: 'wallet.request.list',
  },
  'wallet request watch': {
    args: () => ['wallet', 'request', 'watch', 'request-1'],
    method: 'wallet.request.watch',
  },
  'wallet activity': { args: () => ['wallet', 'activity'], method: 'wallet.activity' },
  'wallet activity-sync': {
    args: () => ['wallet', 'activity-sync', '--publish'],
    method: 'wallet.activity-sync',
  },
  'wallet watch': { args: () => ['wallet', 'watch'], method: 'wallet.watch' },
  'wallet invoice create': {
    args: () => ['wallet', 'invoice', 'create', '--amount-msat', '1000'],
    method: 'wallet.invoice.create',
  },
  'wallet invoice hide': {
    args: () => ['wallet', 'invoice', 'hide', RECORD_ID],
    method: 'wallet.invoice.hide',
  },
  'wallet invoice replace': {
    args: () => ['wallet', 'invoice', 'replace', RECORD_ID, '--amount-msat', '1000'],
    method: 'wallet.invoice.replace',
  },
  'wallet pay quote': {
    args: (files) => ['wallet', 'pay', 'quote', '--invoice-file', files.invoice],
    method: 'wallet.pay.quote',
  },
  'wallet pay execute': {
    args: (files) => ['wallet', 'pay', 'execute', '--fee-consent-file', files.payQuote],
    method: 'wallet.pay.execute',
  },
  'wallet receive': {
    args: (files) => ['wallet', 'receive', '--token-file', files.token],
    method: 'wallet.receive',
  },
  'wallet recover-seed': {
    args: (files) => [
      'wallet',
      'recover-seed',
      '--wallet-seed-hex-file',
      files.seed,
      '--recovery-id',
      'recovery-1',
      '--mint',
      MINT_URL,
      '--acknowledge-seed-disclosure',
    ],
    method: 'wallet.recover-seed',
  },
  'wallet send': { args: () => ['wallet', 'send', '25'], method: 'wallet.send' },
  'wallet reclaim': { args: () => ['wallet', 'reclaim', TRANSFER], method: 'wallet.reclaim' },
  'wallet split': {
    args: () => ['wallet', 'split', CONDITION, '1'],
    method: 'wallet.splitCompleteSet',
  },
  'wallet consolidate-proofs': {
    args: () => ['wallet', 'consolidate-proofs'],
    method: 'wallet.consolidateProofs',
  },
  'wallet consolidate': {
    args: () => ['wallet', 'consolidate', MARKET],
    method: 'wallet.consolidateMarket',
  },
  'wallet retire-condition': {
    args: () => ['wallet', 'retire-condition', CONDITION, '--acknowledge'],
    method: 'wallet.retireCondition',
  },
  'wallet claim': {
    args: () => ['wallet', 'claim', CONDITION, 'Yes'],
    method: 'wallet.claimPosition',
  },
  'wallet remove-preview': {
    args: () => ['wallet', 'remove-preview', CONDITION, 'Yes'],
    method: 'wallet.removePreview',
  },
  'wallet remove': {
    args: (files) => [
      'wallet',
      'remove',
      '--preview-file',
      files.removalPreview,
      '--acknowledge-loss',
    ],
    method: 'wallet.removePosition',
  },
  'wallet recover': { args: () => ['wallet', 'recover'], method: 'wallet.recover' },
  'score quote': { args: () => ['score', 'quote', '1'], method: 'score.quote' },
  'score buy': {
    args: (files) => ['score', 'buy', '--fee-consent-file', files.scoreQuote],
    method: 'score.buy',
  },
  'order submit': {
    args: () => [
      'order',
      'submit',
      '--market',
      MARKET,
      '--outcome',
      'Yes',
      '--side',
      'Buy',
      '--amount-msat',
      '1000',
    ],
    method: 'order.submit',
  },
  'order cancel': { args: () => ['order', 'cancel', MARKET, 'order-1'], method: 'order.cancel' },
  'daemon config': {
    args: () => ['daemon', 'config', '--engine-url', 'https://engine2.example'],
    method: 'config.set',
  },
  'config set': {
    args: () => ['config', 'set', '--mint-url', 'https://mint2.example'],
    method: 'config.set',
  },
  'signer profile': { args: () => ['signer', 'profile'], method: 'signer.profile' },
  'signer disconnect': {
    args: () => ['signer', 'disconnect', '--expected-revision', '0'],
    method: 'signer.disconnect',
  },
  'signer connect': {
    args: () => ['signer', 'connect', '--expected-revision', '0'],
    method: 'signer.connect',
  },
  'signer import': {
    args: (files) => [
      'signer',
      'import',
      '--key-file',
      files.signerKey,
      '--expected-revision',
      '0',
    ],
    method: 'signer.import',
  },
  'signer generate': {
    args: () => ['signer', 'generate', '--expected-revision', '0'],
    method: 'signer.generate',
  },
  'signer export': {
    args: (files) => ['signer', 'export', '--output-file', files.exportTarget],
    method: 'signer.export',
  },
}

const READ_ONLY: Record<string, Args> = {
  health: () => ['health'],
  market: () => ['market'],
  'market list': () => ['market', 'list'],
  'market show': () => ['market', 'show', CONDITION],
  'market comments': () => ['market', 'comments', CONDITION],
  'market history': () => ['market', 'history', CONDITION],
  'market attestation': () => ['market', 'attestation', CONDITION],
  'market creator': () => ['market', 'creator', '02'.repeat(32)],
  'market funding': () => ['market', 'funding', CONDITION],
  'market funding-head': () => ['market', 'funding-head', CONDITION],
  'market funding-quote': () => ['market', 'funding-quote', CONDITION, '--amount-msat', '8000'],
  'market creation-status': () => ['market', 'creation-status', 'create-1'],
  'market creation-quote': () => ['market', 'creation-quote', '--outcomes', 'Yes,No'],
  'market oracle-backup-list': () => ['market', 'oracle-backup-list'],
  'market oracle-backup-status': () => ['market', 'oracle-backup-status'],
  'market resolution-status': () => ['market', 'resolution-status', CONDITION],
  'mint info': () => ['mint', 'info'],
  'mint list': () => ['mint', 'list'],
  'relay list': () => ['relay', 'list'],
  'wallet balance': () => ['wallet', 'balance'],
  'wallet positions': () => ['wallet', 'positions'],
  'wallet portfolio': () => ['wallet', 'portfolio'],
  'wallet assets': () => ['wallet', 'assets'],
  'wallet invoice show': () => ['wallet', 'invoice', 'show', RECORD_ID],
  'wallet pay status': () => ['wallet', 'pay', 'status', `wallet-melt:${RECORD_ID}`],
  'wallet operations': () => ['wallet', 'operations'],
  'score show': () => ['score', 'show'],
  'score status': (files) => ['score', 'status', '--fee-consent-file', files.scoreQuote],
  'order preview': () => [
    'order',
    'preview',
    '--market',
    MARKET,
    '--side',
    'Buy',
    '--amount-msat',
    '1000',
  ],
  'order capacity': () => ['order', 'capacity', '--market', MARKET, '--side', 'Buy'],
  'order fee-preview': () => [
    'order',
    'fee-preview',
    '--market',
    MARKET,
    '--outcome',
    'Yes',
    '--side',
    'Buy',
    '--amount-msat',
    '1000',
  ],
  'order status': () => ['order', 'status', MARKET, 'order-1'],
  'order wait': () => ['order', 'wait', MARKET, 'order-1', '--timeout-ms', '1000'],
  'order list': () => ['order', 'list'],
  'order book': () => ['order', 'book', MARKET],
  'daemon status': () => ['daemon', 'status'],
  'daemon logs': () => ['daemon', 'logs'],
  'config get': () => ['config', 'get'],
  'config path': () => ['config', 'path'],
  'config list': () => ['config', 'list'],
  'signer show': () => ['signer', 'show'],
  completion: () => ['completion'],
}

const REFUSED: Record<string, Args> = {
  'daemon init': () => ['daemon', 'init'],
  'daemon stop': () => ['daemon', 'stop'],
  'daemon restart': () => ['daemon', 'restart'],
}

function declaredWithMode(mode: DryRunMode): string[] {
  return Object.entries(DRY_RUN_MODES)
    .filter(([, declared]) => declared === mode)
    .map(([path]) => path)
    .sort()
}

// Run each case in its own fixture, a few at a time. Collect every failure.
async function forEachCase(
  paths: readonly string[],
  check: (path: string, f: Fixture) => Promise<void>,
): Promise<void> {
  const queue = [...paths]
  const failures: string[] = []
  const worker = async () => {
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      const f = await fixture()
      try {
        await check(path, f)
      } catch (error) {
        failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        await f.close()
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker))
  assert.deepEqual(failures, [])
}

test('every declared command has one dry-run case of its mode', () => {
  assert.deepEqual(Object.keys(SUPPORTED).sort(), declaredWithMode('supported'))
  assert.deepEqual(Object.keys(READ_ONLY).sort(), declaredWithMode('read-only'))
  assert.deepEqual(Object.keys(REFUSED).sort(), declaredWithMode('refused'))
})

test('every supported command previews with no network, daemon, relay, or saved-state change', async () => {
  await forEachCase(Object.keys(SUPPORTED), async (path, f) => {
    const { args, method } = SUPPORTED[path]!
    const before = await f.snapshot()
    const result = await f.run(['--dry-run', ...args(f.files)])
    assert.equal(result.code, 0, result.stderr)
    const preview = JSON.parse(result.stdout) as Record<string, unknown>
    assert.deepEqual(Object.keys(preview), ['dryRun', 'method', 'params'])
    assert.equal(preview.dryRun, true)
    assert.equal(preview.method, method)
    assert.equal(typeof preview.params, 'object')
    for (const secret of [TOKEN_TEXT, SEED_HEX, SIGNER_KEY_HEX])
      assert.equal(result.stdout.includes(secret), false, 'preview contains a secret')
    assert.deepEqual(await f.requests(), [])
    assert.deepEqual(await f.snapshot(), before)
    assert.equal(existsSync(f.files.exportTarget), false)
  })
})

test('every read-only command sends only read requests with --dry-run', async () => {
  await forEachCase(Object.keys(READ_ONLY), async (path, f) => {
    const before = await f.snapshot()
    const result = await f.run(['--dry-run', ...READ_ONLY[path]!(f.files)])
    assert.notEqual(result.code, 2, `usage error: ${result.stdout}${result.stderr}`)
    for (const request of await f.requests()) {
      assert.equal(request.websocket, undefined, `WebSocket ${request.websocket}`)
      if (request.method !== undefined)
        assert.ok(READ_DAEMON_METHODS.has(request.method), `writing RPC ${request.method}`)
      else
        assert.ok(
          request.httpMethod === 'GET' ||
            (request.httpMethod === 'POST' && READ_POST_PATHS.has(new URL(request.url!).pathname)),
          `${request.httpMethod} ${request.url}`,
        )
    }
    assert.deepEqual(await f.snapshot(), before)
  })
})

test('every refused command stops with exit code 2 before any action', async () => {
  await forEachCase(Object.keys(REFUSED), async (path, f) => {
    const before = await f.snapshot()
    const result = await f.run(['--dry-run', ...REFUSED[path]!(f.files)])
    assert.equal(result.code, 2, result.stdout + result.stderr)
    assert.equal(result.stdout, '')
    assert.equal(
      result.stderr,
      `bitcaster-cli ${path} refuses --dry-run. It cannot show its effect without acting. Nothing was changed.\n`,
    )
    assert.deepEqual(await f.requests(), [])
    assert.deepEqual(await f.snapshot(), before)
  })
})

test('market fund begin --dry-run prints the funding request and makes no RPC or payment', async () => {
  const f = await fixture()
  try {
    const before = await f.snapshot()
    for (const args of [
      ['--dry-run', ...fundBeginArgs],
      [...fundBeginArgs, '--dry-run'],
    ]) {
      const result = await f.run(args)
      assert.equal(result.code, 0, result.stderr)
      assert.deepEqual(JSON.parse(result.stdout), {
        dryRun: true,
        method: 'market.fund',
        params: {
          conditionId: CONDITION,
          attempt: { kind: 'begin', requestedAmount: '8000' },
          maxWalletDebitMsat: 8002,
        },
      })
    }
    assert.deepEqual(await f.requests(), [])
    assert.deepEqual(await f.snapshot(), before)
  } finally {
    await f.close()
  }
})

test('without --dry-run, market fund begin quotes, reads the head, and pays', async () => {
  const f = await fixture()
  try {
    const result = await f.run(fundBeginArgs)
    assert.equal(result.code, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).result.delivery.state, 'credited')
    assert.deepEqual(
      (await f.requests()).map((request) => request.method),
      ['market.funding.quote', 'market.funding.head', 'market.fund'],
    )
  } finally {
    await f.close()
  }
})

test('secret inputs are validated but only their file paths are previewed', async () => {
  const f = await fixture()
  try {
    const receive = await f.run(['--dry-run', ...SUPPORTED['wallet receive']!.args(f.files)])
    assert.deepEqual(JSON.parse(receive.stdout).params, { tokenFile: f.files.token })
    const seed = await f.run(['--dry-run', ...SUPPORTED['wallet recover-seed']!.args(f.files)])
    assert.deepEqual(Object.keys(JSON.parse(seed.stdout).params).sort(), [
      'allConditions',
      'disclosureAcknowledged',
      'mintUrl',
      'recoveryId',
      'scanPolicy',
      'unit',
    ])
    const config = await f.run(['--dry-run', ...SUPPORTED['config set']!.args(f.files)])
    assert.deepEqual(JSON.parse(config.stdout).params, { mintUrl: 'https://mint2.example' })
  } finally {
    await f.close()
  }
})

test('an unread --dry-run token stops with exit code 2 before any action', async () => {
  const f = await fixture()
  try {
    const before = await f.snapshot()
    for (const args of [
      ['order', 'cancel', MARKET, 'order-1', '--', '--dry-run'],
      ['wallet', 'send', '25', '--', '--dry-run'],
      ['order', 'cancel', MARKET, 'order-1', '--', '--dry-run=false'],
    ]) {
      const result = await f.run(args)
      assert.equal(result.code, 2, `${args.join(' ')}: ${result.stdout}${result.stderr}`)
      assert.equal(
        result.stderr,
        'bitcaster-cli did not read --dry-run as an option. Put --dry-run before any "--" and give it no value. Nothing was changed.\n',
      )
    }
    // The option parser rejects a value before any action.
    for (const args of [
      ['--dry-run=false', 'order', 'cancel', MARKET, 'order-1'],
      ['order', 'cancel', MARKET, 'order-1', '--dry-run=false'],
    ]) {
      const result = await f.run(args)
      assert.equal(result.code, 2, `${args.join(' ')}: ${result.stdout}${result.stderr}`)
      assert.match(result.stdout, /unknown option '--dry-run=false'/)
    }
    assert.deepEqual(await f.requests(), [])
    assert.deepEqual(await f.snapshot(), before)
  } finally {
    await f.close()
  }
})

test('a read-only command with --dry-run does not start the daemon', async () => {
  const f = await fixture()
  try {
    const before = await f.snapshot()
    const result = await f.run(['--dry-run', 'health'], { daemon: 'none' })
    assert.equal(result.code, 1, result.stdout)
    const failure = JSON.parse(result.stderr) as { ok: boolean; error: string; hint: string }
    assert.equal(failure.ok, false)
    assert.match(failure.error, /^daemon not reachable at /)
    assert.match(failure.hint, /--dry-run does not start bitcaster-daemon/)
    assert.deepEqual(await f.snapshot(), before)
  } finally {
    await f.close()
  }
})

test('help states each command dry-run mode', async () => {
  const f = await fixture()
  try {
    const root = await f.run(['--help'])
    assert.match(
      root.stdout,
      /Dry run:\n {2}Each command help states how the command handles --dry-run\./,
    )
    assert.match(root.stdout, /With --dry-run, the CLI does not start bitcaster-daemon\./)
    for (const [args, mode] of [
      [['market', 'fund', 'begin'], 'supported'],
      [['wallet', 'receive'], 'supported'],
      [['wallet', 'balance'], 'read-only'],
      [['daemon', 'init'], 'refused'],
    ] as const) {
      const help = await f.run([...args, '--help'])
      assert.equal(help.code, 0)
      assert.match(help.stdout, new RegExp(`\\nDry run: ${mode}\\. `), args.join(' '))
    }
  } finally {
    await f.close()
  }
})
