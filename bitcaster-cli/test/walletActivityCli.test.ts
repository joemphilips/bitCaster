import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { promisify } from 'node:util'
import { bootstrapFreshDaemonProfile } from '../../bitcaster-daemon/src/profileBootstrap.ts'

const execute = promisify(execFile)
const WALLET_ID = 'ab'.repeat(32)
const PAGE = {
  items: [
    {
      id: 'deposit-1',
      walletId: WALLET_ID,
      type: 'deposit',
      amountSubunits: 1234,
      baseAsset: 'sat',
      date: '2026-10-04T00:00:00.000Z',
      status: 'completed',
      txId: null,
      lightningInvoice: null,
    },
  ],
  nextCursor: null,
  hasMore: false,
}
let directory: string
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'bitcaster-activity-cli-'))
  await bootstrapFreshDaemonProfile({
    directory,
    engineBaseUrl: 'https://engine.example',
    mintUrl: 'https://mint.example',
    walletSeedHex: '51'.repeat(64),
    nostrSecretKeyHex: '52'.repeat(32),
  })
})
after(async () => {
  await rm(directory, { recursive: true, force: true })
})

function run(args: string[], command?: unknown, response: unknown = { ok: true, result: PAGE }) {
  const preload =
    'data:text/javascript,' +
    encodeURIComponent(`
    import assert from 'node:assert/strict'
    import { readRpcToken } from ${JSON.stringify(import.meta.resolve('@bitcaster-market/daemon/rpcAuth'))}
    globalThis[Symbol.for('bitcaster.test.daemon-url')] = 'http://daemon.test'
    let calls = 0
    process.once('beforeExit', () => assert.equal(calls, ${command === undefined ? 0 : 1}))
    globalThis.fetch = async (url, init) => {
      calls++
      assert.equal(url, 'http://daemon.test/rpc')
      assert.equal(init.method, 'POST')
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + await readRpcToken())
      assert.deepEqual(JSON.parse(init.body), ${JSON.stringify(command ?? null)})
      return Response.json(${JSON.stringify(response)})
    }
  `)
  return execute(
    process.execPath,
    [
      '--experimental-strip-types',
      '--import',
      preload,
      join(import.meta.dirname, '../src/main.ts'),
      '--datadir',
      directory,
      ...args,
    ],
    { env: { ...process.env, NODE_NO_WARNINGS: '1' }, timeout: 10000, maxBuffer: 128 * 1024 },
  )
}

test('actual wallet activity command emits machine-readable rows and forwards bounded paging options', async () => {
  const initial = await run(['wallet', 'activity'], { method: 'wallet.activity' })
  assert.deepEqual(JSON.parse(initial.stdout), { ok: true, result: PAGE })
  const next = await run(
    [
      'wallet',
      'activity',
      '--wallet-id',
      WALLET_ID,
      '--cursor',
      'page-cursor',
      '--page-size',
      '50',
    ],
    {
      method: 'wallet.activity',
      params: { walletId: WALLET_ID, cursor: 'page-cursor', pageSize: 50 },
    },
  )
  assert.deepEqual(JSON.parse(next.stdout), { ok: true, result: PAGE })
})

test('actual wallet activity help explains units, paging, local reads, and display scope', async () => {
  const result = await run(['wallet', 'activity', '--help'])
  for (const phrase of [
    '--page-size',
    '--cursor',
    '--wallet-id',
    'amountSubunits (msats)',
    'retained local display rows',
    'spendable balance',
    'lifetime audit',
  ]) {
    assert.ok(result.stdout.includes(phrase), `missing Activity help: ${phrase}`)
  }
})

test('actual wallet activity refuses malformed options without RPC and supports global dry-run', async () => {
  for (const args of [
    ['--page-size', '0'],
    ['--page-size', '51'],
    ['--page-size', '1.5'],
    ['--page-size', 'NaN'],
    ['--wallet-id', 'foreign'],
    ['--cursor', ''],
    ['--cursor', 'é'.repeat(257)],
    ['unexpected'],
  ]) {
    await assert.rejects(run(['wallet', 'activity', ...args]), (error: unknown) => {
      assert.equal((error as { code: number }).code, 2)
      return true
    })
  }
  const dryRun = await run(['--dry-run', 'wallet', 'activity', '--page-size', '2'])
  assert.ok(dryRun.stdout.includes('wallet.activity'))
  assert.ok(dryRun.stdout.includes('"pageSize": 2'))
})

test('actual wallet activity retains a daemon refusal and exits unsuccessfully', async () => {
  const response = {
    ok: false,
    code: 'wallet-activity-wallet-mismatch',
    error: 'Wallet Activity wallet ID does not match the selected wallet',
  }
  await assert.rejects(
    run(['wallet', 'activity'], { method: 'wallet.activity' }, response),
    (error: unknown) => {
      const failed = error as { code: number; stdout: string }
      assert.equal(failed.code, 1)
      assert.deepEqual(JSON.parse(failed.stdout), response)
      return true
    },
  )
})
