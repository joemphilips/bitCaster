import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAIN = join(import.meta.dirname, '..', 'src', 'main.ts')
const RPC_SETUP = join(import.meta.dirname, 'rpcTransportTestSetup.ts')
const FETCH_PRELOAD = join(import.meta.dirname, 'dryRunCliPreload.mjs')
const CONDITION = 'ab'.repeat(32)
const TRANSFER = '00000000-0000-4000-8000-000000000001'
const ENGINE_URL = 'https://engine.example'
const MINT_URL = 'https://mint.example'

interface CliRun {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

interface Fixture {
  readonly root: string
  readonly directory: string
  run(args: string[], options?: { daemon?: 'mock' | 'none' }): Promise<CliRun>
  requests(): Promise<Array<{ url: string; method?: string }>>
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
  return {
    root,
    directory,
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
        .map((line) => JSON.parse(line) as { url: string; method?: string })
    },
    async snapshot() {
      const files: Record<string, string> = {}
      for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) {
          files[join(entry.parentPath, entry.name)] = '<not a regular file>'
          continue
        }
        const path = join(entry.parentPath, entry.name)
        files[path] = (await readFile(path)).toString('base64')
      }
      return files
    },
    async close() {
      await stopAutoStartedDaemon(directory)
      await rm(root, { recursive: true, force: true })
    },
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

test('supported commands print the intended operation without RPC or saved-state change', async () => {
  const f = await fixture()
  try {
    const tokenFile = join(f.root, 'token.cashu')
    await writeFile(tokenFile, 'cashuBsecret-token-text\n', { mode: 0o600 })
    const cases: Array<{ args: string[]; expected: unknown }> = [
      {
        args: ['market', 'fund', 'resume', CONDITION, TRANSFER],
        expected: {
          method: 'market.fund',
          params: { conditionId: CONDITION, attempt: { kind: 'resume', transferId: TRANSFER } },
        },
      },
      {
        args: [
          'market',
          'oracle-backup-restore',
          '--event-id',
          'cd'.repeat(32),
          '--relay',
          'wss://relay.example',
        ],
        expected: {
          method: 'market.oracle-backup-restore',
          params: { eventId: 'cd'.repeat(32), relay: 'wss://relay.example' },
        },
      },
      {
        args: ['market', 'oracle-backup-retry', CONDITION],
        expected: { method: 'market.oracle-backup-retry', params: { conditionId: CONDITION } },
      },
      {
        args: ['market', 'announcement-republish', CONDITION],
        expected: { method: 'market.announcement-republish', params: { conditionId: CONDITION } },
      },
      {
        args: [
          'wallet',
          'receive',
          '--token-file',
          tokenFile,
          '--condition-id',
          CONDITION,
          '--outcome-set',
          'Yes',
        ],
        expected: {
          method: 'wallet.receive',
          tokenFile,
          params: { conditionId: CONDITION, outcomeSetId: 'Yes' },
        },
      },
      { args: ['wallet', 'recover'], expected: { method: 'wallet.recover' } },
      {
        args: ['order', 'cancel', `${CONDITION}-Yes`, 'order-1'],
        expected: {
          method: 'order.cancel',
          params: { marketId: `${CONDITION}-Yes`, orderId: 'order-1' },
        },
      },
      {
        args: [
          'config',
          'set',
          '--mint-url',
          'https://mint2.example',
          '--asset-monitoring',
          'enabled',
        ],
        expected: {
          dryRun: true,
          method: 'config.set',
          config: {
            engineUrl: ENGINE_URL,
            mintUrl: 'https://mint2.example',
            assetMonitoringEnabled: true,
            trustedEngineUrls: [],
          },
        },
      },
      {
        args: ['daemon', 'config', '--engine-url', 'https://engine2.example'],
        expected: {
          dryRun: true,
          method: 'config.set',
          config: {
            engineUrl: 'https://engine2.example',
            mintUrl: MINT_URL,
            assetMonitoringEnabled: false,
            trustedEngineUrls: [],
          },
        },
      },
      {
        args: [
          'market',
          'create',
          '--condition-id',
          CONDITION,
          '--title',
          'Market',
          '--description',
          'Description',
          '--outcomes',
          'YES,NO',
          '--trust-engine-url',
        ],
        expected: {
          conditionId: CONDITION,
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
          CONDITION,
          '--outcome',
          'Yes',
          '--trust-engine-url',
        ],
        expected: { conditionId: CONDITION, outcome: 'Yes' },
      },
    ]
    const before = await f.snapshot()
    for (const { args, expected } of cases) {
      const result = await f.run(['--dry-run', ...args])
      assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`)
      assert.deepEqual(JSON.parse(result.stdout), expected, args.join(' '))
      assert.doesNotMatch(result.stdout, /secret-token-text/)
      assert.deepEqual(await f.requests(), [], args.join(' '))
      // The engine URL stays untrusted and no daemon file appears.
      assert.deepEqual(await f.snapshot(), before, args.join(' '))
    }
  } finally {
    await f.close()
  }
})

test('refused commands stop with exit code 2 before any action', async () => {
  const f = await fixture()
  try {
    const before = await f.snapshot()
    for (const args of [
      ['daemon', 'init'],
      ['daemon', 'stop'],
      ['daemon', 'restart'],
    ]) {
      const result = await f.run(['--dry-run', ...args])
      assert.equal(result.code, 2, `${args.join(' ')}: ${result.stdout}${result.stderr}`)
      assert.equal(result.stdout, '')
      assert.match(
        result.stderr,
        new RegExp(
          `^bitcaster-cli ${args.join(' ')} refuses --dry-run\\. .*Nothing was changed\\.\\n$`,
        ),
      )
      assert.deepEqual(await f.requests(), [])
      assert.deepEqual(await f.snapshot(), before, args.join(' '))
    }
  } finally {
    await f.close()
  }
})

test('read-only commands run normally with --dry-run', async () => {
  const f = await fixture()
  try {
    const result = await f.run(['--dry-run', 'wallet', 'balance'])
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, result: { method: 'wallet.balance' } })
    assert.deepEqual(
      (await f.requests()).map((request) => request.method),
      ['wallet.balance'],
    )
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
