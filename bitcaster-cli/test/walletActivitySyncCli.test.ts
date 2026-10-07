import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, after, test } from 'node:test'
import { promisify } from 'node:util'
import { bootstrapFreshDaemonProfile } from '../../bitcaster-daemon/src/profileBootstrap.ts'

const execute = promisify(execFile)
const WALLET_ID = 'ab'.repeat(32)
const RESULT = {
  walletId: WALLET_ID,
  importedRows: 1,
  completeHistory: false,
  window: { localLimit: 100, localTruncated: true },
  publication: { requested: false, status: 'not-requested' },
}
let directory: string
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'activity-sync-cli-profile-'))
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

async function run(
  args: string[],
  command?: unknown,
  response: unknown = { ok: true, result: RESULT },
) {
  const root = await mkdtemp(join(tmpdir(), 'activity-sync-cli-transport-'))
  const preload = join(root, 'mock.mjs')
  await writeFile(
    preload,
    `
    import assert from 'node:assert/strict'
    import { readRpcToken } from ${JSON.stringify(new URL('../../bitcaster-daemon/dist/rpcAuth.js', import.meta.url).href)}
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
  `,
  )
  try {
    return await execute(
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
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('actual Activity sync CLI defaults to import and forwards explicit publication and bounded window options', async () => {
  assert.deepEqual(
    JSON.parse((await run(['wallet', 'activity-sync'], { method: 'wallet.activity-sync' })).stdout),
    { ok: true, result: RESULT },
  )
  const explicit = await run(
    ['wallet', 'activity-sync', '--wallet-id', WALLET_ID, '--limit', '50', '--publish'],
    { method: 'wallet.activity-sync', params: { walletId: WALLET_ID, limit: 50, publish: true } },
  )
  assert.deepEqual(JSON.parse(explicit.stdout), { ok: true, result: RESULT })
})

test('actual Activity sync help explains encrypted bounds, explicit publication, acknowledgements, and remaining race', async () => {
  const result = await run(['wallet', 'activity-sync', '--help'])
  for (const phrase of [
    '--publish',
    '--limit',
    'Default sync imports only',
    '65535 bytes',
    'acknowledgements',
    'read-to-publish race',
    'does not promise complete history',
    'offline local read',
  ])
    assert.ok(result.stdout.includes(phrase), `missing Activity sync help: ${phrase}`)
})

test('actual Activity sync rejects malformed options before RPC and supports global dry run', async () => {
  for (const args of [
    ['--limit', '0'],
    ['--limit', '501'],
    ['--limit', '1.5'],
    ['--limit', 'NaN'],
    ['--wallet-id', 'invalid'],
    ['unexpected'],
  ]) {
    await assert.rejects(run(['wallet', 'activity-sync', ...args]), (error: unknown) => {
      assert.equal((error as { code: number }).code, 2)
      return true
    })
  }
  const dry = await run(['--dry-run', 'wallet', 'activity-sync', '--limit', '5', '--publish'])
  assert.ok(dry.stdout.includes('wallet.activity-sync'))
  assert.ok(dry.stdout.includes('"publish": true'))
  assert.ok(dry.stdout.includes('"limit": 5'))
})

test('actual Activity sync preserves a daemon refusal and exits unsuccessfully', async () => {
  await assert.rejects(
    run(
      ['wallet', 'activity-sync'],
      { method: 'wallet.activity-sync' },
      { ok: false, code: 'signer-disconnected', error: 'Application signer is disconnected.' },
    ),
    (error: unknown) => {
      const value = error as { code: number; stdout: string }
      assert.equal(value.code, 1)
      assert.equal(JSON.parse(value.stdout).code, 'signer-disconnected')
      return true
    },
  )
})
