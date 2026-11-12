import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { deriveRecoveryIndexKeys } from '../../bitcaster-client-sdk/src/recoveryIndexDocument.ts'

const SEED_HEX = 'cd'.repeat(64)
const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

test('wallet backup delete removes the engine document of the seed and leaves a tombstone', async () => {
  const home = await profile()
  try {
    const seedPath = join(home, 'wallet-seed.hex')
    await writeFile(seedPath, `${SEED_HEX}\n`, { mode: 0o600 })
    const key = deriveRecoveryIndexKeys(
      Buffer.from(SEED_HEX, 'hex'),
      'bitcaster-staging',
    ).locatorPublicKey
    const log = join(home, 'engine.log')
    await writeFile(log, '')

    const result = await runCli(
      home,
      [
        'wallet',
        'backup',
        'delete',
        '--wallet-seed-hex-file',
        seedPath,
        '--realm',
        'bitcaster-staging',
      ],
      {
        BITCASTER_TEST_RECOVERY_INDEX_REALM: 'bitcaster-staging',
        BITCASTER_TEST_RECOVERY_INDEX_KEY: key,
        BITCASTER_TEST_RECOVERY_INDEX_LOG: log,
      },
    )

    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), { status: 'deleted', version: 4 })
    const entries = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.deepEqual(entries, [
      { method: 'GET', key },
      { method: 'DELETE', key },
      { tombstone: { version: 4, hasDocument: false } },
    ])
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(SEED_HEX))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('wallet backup delete needs exactly one seed source and previews only the public key', async () => {
  const home = await profile()
  try {
    const missing = await runCli(home, ['--dry-run', 'wallet', 'backup', 'delete'])
    assert.notEqual(missing.code, 0)
    assert.match(missing.stderr, /exactly one of --wallet-seed-hex-file or --recovery-phrase-file/)

    const phrasePath = join(home, 'recovery-phrase.txt')
    await writeFile(phrasePath, `${PHRASE}\n`, { mode: 0o600 })
    const preview = await runCli(home, [
      '--dry-run',
      'wallet',
      'backup',
      'delete',
      '--recovery-phrase-file',
      phrasePath,
    ])
    assert.equal(preview.code, 0, preview.stderr)
    const shown = JSON.parse(preview.stdout)
    assert.equal(shown.method, 'wallet.backup.delete')
    assert.equal(shown.params.realm, 'bitcaster-production')
    assert.match(shown.params.requestPublicKey, /^[0-9a-f]{64}$/)
    assert.doesNotMatch(preview.stdout, /abandon/)

    const unknownRealm = await runCli(home, [
      '--dry-run',
      'wallet',
      'backup',
      'delete',
      '--recovery-phrase-file',
      phrasePath,
      '--realm',
      'bitcaster.local',
    ])
    assert.notEqual(unknownRealm.code, 0)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

async function profile(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-backup-'))
  await writeFile(
    join(home, 'config.json'),
    `${JSON.stringify({
      version: 2,
      daemon: {
        engineUrl: 'https://engine.example',
        mintUrl: 'https://mint.example',
        mintUrls: ['https://mint.example'],
        autoRetireResolvedConditionInventory: false,
        assetMonitoringEnabled: false,
        nostrRelays: [],
      },
      cli: { trustedEngineUrls: [] },
    })}\n`,
    { mode: 0o600 },
  )
  return home
}

async function runCli(
  home: string,
  args: readonly string[],
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, ...extraEnv }
  delete childEnv.NODE_TEST_CONTEXT
  const stdoutPath = join(home, `stdout-${Date.now()}-${Math.random()}`)
  const stderrPath = join(home, `stderr-${Date.now()}-${Math.random()}`)
  const stdoutFile = await open(stdoutPath, 'wx', 0o600)
  const stderrFile = await open(stderrPath, 'wx', 0o600)
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--import',
      join(import.meta.dirname, 'recoveryIndexDeleteCliPreload.mjs'),
      join(import.meta.dirname, '..', 'src', 'main.ts'),
      '--datadir',
      home,
      ...args,
    ],
    {
      cwd: join(import.meta.dirname, '..'),
      env: childEnv,
      stdio: ['ignore', stdoutFile.fd, stderrFile.fd],
    },
  )
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (exitCode) => resolve(exitCode ?? 1))
  })
  await stdoutFile.close()
  await stderrFile.close()
  return {
    code,
    stdout: await readFile(stdoutPath, 'utf8'),
    stderr: await readFile(stderrPath, 'utf8'),
  }
}
