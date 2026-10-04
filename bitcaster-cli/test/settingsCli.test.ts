import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import {
  createNativeConfig,
  defaultNativeConfig,
  readNativeConfig,
  type NativeConfig,
} from '../../bitcaster-daemon/src/nativeConfig.ts'
import {
  bootstrapFreshDaemonProfile,
  readBootstrappedProfileSecrets,
} from '../../bitcaster-daemon/src/profileBootstrap.ts'
import { createNativeOracleCreationStore } from '../../bitcaster-daemon/src/nativeOracleCreationStore.ts'

const execute = promisify(execFile)
const FIRST = 'http://localhost:8085'
const SECOND = 'https://second.example'
const THIRD = 'https://third.example'
const RELAY = 'wss://relay.example/Case?Key=Value'

test('actual relay add refuses an oversized formatted config without replacing bytes or revision or restarting', async () => {
  const f = await fixture()
  try {
    const before = await f.bytes()
    const revision = readNativeConfig(false, f.directory).revision
    await assert.rejects(
      f.run(['relay', 'add', `wss://relay.example/${'x'.repeat(70 * 1024)}`]),
      failed(/native config exceeds 64 KiB/),
    )
    const after = await f.bytes()
    assert.equal(Buffer.byteLength(after), Buffer.byteLength(before))
    assert.equal(createHash('sha256').update(after).digest('hex'), revision)
    assert.equal(readNativeConfig(false, f.directory).revision, revision)
    assert.deepEqual(await f.log(), [])
  } finally {
    await f.close()
  }
})

test('actual mint and relay lists read defaults offline and retain one mint parent with info', async () => {
  const f = await fixture({ missing: true })
  try {
    assert.deepEqual(JSON.parse((await f.run(['mint', 'list'])).stdout).mintUrls, [FIRST])
    assert.equal(JSON.parse((await f.run(['mint', 'list'])).stdout).revision, null)
    assert.ok(JSON.parse((await f.run(['relay', 'list'])).stdout).nostrRelays.length > 0)
    const help = (await f.run(['--help'])).stdout
    assert.equal((help.match(/^\s+mint\s/gm) ?? []).length, 1)
    const mintHelp = (await f.run(['mint', '--help'])).stdout
    for (const command of ['info', 'list', 'add', 'select', 'remove'])
      assert.match(mintHelp, new RegExp(`\\b${command}\\b`))
    assert.deepEqual(await f.log(), [])
    await assert.rejects(readFile(join(f.directory, 'config.json')), { code: 'ENOENT' })
    const metadata = JSON.parse((await f.run(['mint', 'info', SECOND])).stdout)
    assert.equal(metadata.mintUrl, SECOND)
    assert.equal((await f.log()).filter((entry) => entry.action === 'metadata').length, 3)
  } finally {
    await f.close()
  }
})

test('actual mint add, select and remove preserve a normalized saved list and revision checks', async () => {
  const f = await fixture()
  try {
    const added = JSON.parse((await f.run(['mint', 'add', `${SECOND}/`])).stdout).result
    assert.deepEqual(added.config.daemon.mintUrls, [FIRST, SECOND])
    assert.equal(added.config.daemon.mintUrl, SECOND)
    assert.equal(added.daemonRestarted, false)
    await f.run(['mint', 'add', SECOND])
    assert.deepEqual((await f.config()).daemon.mintUrls, [FIRST, SECOND])
    await f.run(['mint', 'select', `${FIRST}/`])
    assert.equal((await f.config()).daemon.mintUrl, FIRST)
    await f.run(['mint', 'add', THIRD])
    await f.run(['mint', 'remove', SECOND])
    assert.equal((await f.config()).daemon.mintUrl, THIRD)
    await f.run(['mint', 'remove', THIRD])
    assert.equal((await f.config()).daemon.mintUrl, FIRST)
    const before = await f.bytes()
    await assert.rejects(f.run(['mint', 'remove', FIRST]), failed(/final mint/))
    await assert.rejects(f.run(['mint', 'select', THIRD]), failed(/not in the saved list/))
    await assert.rejects(f.run(['mint', 'add', 'invalid']), failed(/Invalid mint URL/))
    assert.equal(await f.bytes(), before)
    assert.equal((await f.log()).filter((entry) => entry.action === 'metadata').length, 12)
    assert.equal((await f.log()).filter((entry) => entry.action === 'restart').length, 0)
  } finally {
    await f.close()
  }
})

test('actual mint capability and stale-write refusals leave saved selections unchanged', async () => {
  const f = await fixture()
  try {
    const revision = JSON.parse((await f.run(['mint', 'list'])).stdout).revision
    const before = await f.bytes()
    await assert.rejects(
      f.run(['mint', 'add', SECOND], { BITCASTER_TEST_SETTINGS_UNIT: 'sat' }),
      failed(/active regular.*msat/),
    )
    assert.equal(await f.bytes(), before)
    await assert.rejects(
      f.run(['mint', 'add', SECOND], { BITCASTER_TEST_SETTINGS_RACE: '1' }),
      failed(/changed before write/),
    )
    assert.deepEqual((await f.config()).daemon.mintUrls, [FIRST])
    assert.deepEqual((await f.config()).daemon.nostrRelays, ['wss://competing.example'])
    const reads = (await f.log()).filter((entry) => entry.action === 'metadata').length
    await assert.rejects(
      f.run(['mint', 'add', SECOND, '--expected-revision', revision]),
      failed(/changed before write/),
    )
    await assert.rejects(
      f.run(['relay', 'add', RELAY, '--expected-revision', revision]),
      failed(/changed before write/),
    )
    await assert.rejects(
      f.run(['relay', 'add', RELAY, '--expected-revision', 'invalid']),
      failed(/expected revision/),
    )
    assert.equal((await f.log()).filter((entry) => entry.action === 'metadata').length, reads)
    assert.equal((await f.log()).filter((entry) => entry.action === 'running-check').length, 0)
  } finally {
    await f.close()
  }
})

test('actual relay edits restart the CLI daemon with saved normalized relays and exact opt-out', async () => {
  const f = await fixture({ nostrRelays: [RELAY] })
  const running = { BITCASTER_TEST_SETTINGS_RUNNING: '1' }
  try {
    await f.run(['relay', 'add', 'wss://RELAY.example/Case?Key=Value'], running)
    assert.deepEqual((await f.config()).daemon.nostrRelays, [RELAY])
    const result = JSON.parse((await f.run(['relay', 'remove', RELAY], running)).stdout).result
    assert.equal(result.daemonRestarted, true)
    assert.deepEqual(result.config.daemon.nostrRelays, [])
    assert.deepEqual(JSON.parse((await f.run(['relay', 'list'])).stdout).nostrRelays, [])
    const log = await f.log()
    assert.equal(log.filter((entry) => entry.action === 'metadata').length, 0)
    assert.equal(log.filter((entry) => entry.action === 'running-check').length, 2)
    const restarts = log.filter((entry) => entry.action === 'restart')
    assert.deepEqual(
      restarts.map((entry) => entry.config?.daemon.nostrRelays),
      [[RELAY], []],
    )
    const before = await f.bytes()
    for (const invalid of [
      'https://relay.example',
      'ws://remote.example',
      'wss://u:p@relay.example',
      `${RELAY}#x`,
    ]) {
      await assert.rejects(f.run(['relay', 'add', invalid], running))
    }
    assert.equal(await f.bytes(), before)
    assert.equal((await f.log()).filter((entry) => entry.action === 'restart').length, 2)
  } finally {
    await f.close()
  }
})

test('actual settings dry runs validate URL and revision without metadata, restart or writes', async () => {
  const f = await fixture()
  try {
    const before = await f.bytes()
    for (const command of [
      ['mint', 'add', SECOND],
      ['mint', 'select', FIRST],
      ['mint', 'remove', FIRST],
      ['relay', 'add', RELAY],
      ['relay', 'remove', RELAY],
    ]) {
      assert.equal(JSON.parse((await f.run(['--dry-run', ...command])).stdout).dryRun, true)
    }
    await assert.rejects(f.run(['--dry-run', 'relay', 'add', 'http://remote.example']))
    assert.equal(await f.bytes(), before)
    assert.deepEqual(await f.log(), [])
  } finally {
    await f.close()
  }
})

test('actual config setters keep normalized saved mints and empty relays through the restart path', async () => {
  const f = await fixture({ nostrRelays: [] })
  const running = { BITCASTER_TEST_SETTINGS_RUNNING: '1' }
  try {
    await f.run(['config', 'set', '--mint-url', `${SECOND}///`], running)
    await f.run(
      ['daemon', 'config', '--mint-url', THIRD, '--engine-url', 'https://engine.example/'],
      running,
    )
    await f.run(['config', 'set', '--mint-url', `${SECOND}/`], running)
    const config = await f.config()
    assert.deepEqual(config.daemon.mintUrls, [FIRST, SECOND, THIRD])
    assert.equal(config.daemon.mintUrl, SECOND)
    assert.equal(config.daemon.engineUrl, 'https://engine.example')
    assert.deepEqual(config.daemon.nostrRelays, [])
    const restarts = (await f.log()).filter((entry) => entry.action === 'restart')
    assert.deepEqual(
      restarts.map((entry) => entry.config?.daemon.mintUrl),
      [SECOND, THIRD, SECOND],
    )
    assert.equal((await f.log()).filter((entry) => entry.action === 'metadata').length, 0)
  } finally {
    await f.close()
  }
})

test('actual settings commands retain saved operation destinations and profile authority', async () => {
  const f = await fixture({ profile: true })
  try {
    const store = createNativeOracleCreationStore(f.directory)
    const canonicalInput = JSON.stringify({
      mintUrl: FIRST,
      engineBaseUrl: 'https://engine.example',
      relays: [RELAY],
    })
    const saved = await store.reserveCreation({
      creationId: 'saved',
      eventId: 'saved-event',
      canonicalInput,
    })
    await f.run(['mint', 'add', SECOND])
    await f.run(['mint', 'remove', FIRST])
    assert.equal((await f.config()).daemon.mintUrl, SECOND)
    const recovered = await createNativeOracleCreationStore(f.directory).readCreation('saved')
    assert.equal(recovered?.canonicalInput, saved.canonicalInput)
    assert.equal(recovered?.nonceIndex, saved.nonceIndex)
    assert.equal((await readBootstrappedProfileSecrets(f.directory)).walletSeedHex, '11'.repeat(64))
    assert.equal(
      (await readBootstrappedProfileSecrets(f.directory)).nativeOracleNonceSeedHex,
      '33'.repeat(32),
    )
  } finally {
    await f.close()
  }
})

test('built CLI consumes the native settings package export with revisions and restart', async () => {
  const f = await fixture({ missing: true })
  try {
    const result = JSON.parse(
      (await f.run(['mint', 'add', SECOND, '--expected-revision', 'missing'], {}, true)).stdout,
    ).result
    assert.equal(result.config.daemon.mintUrl, SECOND)
    assert.match(result.revision, /^[0-9a-f]{64}$/)
    await f.run(
      ['relay', 'add', RELAY, '--expected-revision', result.revision],
      { BITCASTER_TEST_SETTINGS_RUNNING: '1' },
      true,
    )
    assert.ok(
      JSON.parse((await f.run(['relay', 'list'], {}, true)).stdout).nostrRelays.includes(RELAY),
    )
    assert.equal((await f.log()).filter((entry) => entry.action === 'restart').length, 1)
  } finally {
    await f.close()
  }
})

interface LogEntry {
  action: string
  url?: string
  config?: NativeConfig
}

async function fixture(
  options: { missing?: boolean; profile?: boolean; nostrRelays?: string[] } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'bitcaster-settings-cli-'))
  const directory = join(root, 'profile')
  const logPath = join(root, 'calls.jsonl')
  if (options.profile) {
    await bootstrapFreshDaemonProfile({
      directory,
      engineBaseUrl: 'https://engine.example',
      mintUrl: FIRST,
      walletSeedHex: '11'.repeat(64),
      nostrSecretKeyHex: '22'.repeat(32),
      nativeOracleNonceSeedHex: '33'.repeat(32),
    })
  } else if (!options.missing) {
    const defaults = defaultNativeConfig()
    createNativeConfig(
      {
        ...defaults,
        daemon: {
          ...defaults.daemon,
          nostrRelays: options.nostrRelays ?? defaults.daemon.nostrRelays,
        },
      },
      directory,
    )
  }
  return {
    directory,
    run: (args: string[], env: NodeJS.ProcessEnv = {}, built = false) =>
      execute(
        process.execPath,
        [
          '--experimental-strip-types',
          '--import',
          join(import.meta.dirname, 'settingsCliPreload.mjs'),
          join(import.meta.dirname, built ? '../dist/main.js' : '../src/main.ts'),
          '--datadir',
          directory,
          ...args,
        ],
        {
          env: {
            ...process.env,
            NODE_NO_WARNINGS: '1',
            BITCASTER_DAEMON_PASSPHRASE: '',
            BITCASTER_TEST_SETTINGS_DIRECTORY: directory,
            BITCASTER_TEST_SETTINGS_LOG: logPath,
            ...env,
          },
          timeout: 10_000,
          maxBuffer: 128 * 1024,
        },
      ),
    config: async () => readNativeConfig(false, directory).config,
    bytes: () => readFile(join(directory, 'config.json'), 'utf8'),
    log: async (): Promise<LogEntry[]> => {
      try {
        return (await readFile(logPath, 'utf8'))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
    },
    close: () => rm(root, { recursive: true, force: true }),
  }
}

function failed(pattern: RegExp) {
  return (error: unknown) => {
    const result = error as { code: number; stdout: string; stderr: string }
    assert.ok(result.code > 0)
    assert.match(result.stdout + result.stderr, pattern)
    return true
  }
}
