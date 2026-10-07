import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  activeNativeConfig,
  createNativeConfig,
  defaultNativeConfig,
  ensureNativeConfig,
  freezeNativeConfigAtStartup,
  parseNativeConfig,
  readNativeConfig,
  updateNativeConfig,
  type NativeConfig,
} from '../src/nativeConfig.ts'

function formattedBytes(config: NativeConfig): number {
  return Buffer.byteLength(`${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

function boundaryConfig(bytes: number): NativeConfig {
  const config = defaultNativeConfig()
  const prefix = 'wss://relay.example/'
  const base = { ...config, daemon: { ...config.daemon, nostrRelays: [prefix] } }
  return {
    ...base,
    daemon: { ...base.daemon, nostrRelays: [prefix + 'x'.repeat(bytes - formattedBytes(base))] },
  }
}

test('formatted config accepts exactly 64 KiB including newline and refuses the next byte without replacing it', async () => {
  await withDataDir(async (directory) => {
    const accepted = boundaryConfig(64 * 1024)
    assert.equal(formattedBytes(accepted), 64 * 1024)
    const previous = createNativeConfig(accepted, directory)
    const path = join(directory, 'config.json')
    const before = await readFile(path)
    assert.equal(before.byteLength, 64 * 1024)
    assert.equal(before.at(-1), 10)
    assert.throws(
      () => updateNativeConfig(() => boundaryConfig(64 * 1024 + 1), { directory }),
      /native config exceeds 64 KiB/,
    )
    const after = await readFile(path)
    assert.equal(after.byteLength, before.byteLength)
    assert.equal(createHash('sha256').update(after).digest('hex'), previous.revision)
    assert.equal(readNativeConfig(false, directory).revision, previous.revision)
  })
})

test('multibyte relay input is normalized before the formatted config byte bound and preserves the prior revision on refusal', async () => {
  await withDataDir(async (directory) => {
    const previous = createNativeConfig(defaultNativeConfig(), directory)
    const path = join(directory, 'config.json')
    const before = await readFile(path)
    const config = defaultNativeConfig()
    const relay = `wss://relay.example/${'é'.repeat(11_000)}`
    assert.ok(Buffer.byteLength(relay, 'utf8') < 64 * 1024)
    const candidate = parseNativeConfig(
      JSON.stringify({
        ...config,
        daemon: { ...config.daemon, nostrRelays: [relay] },
      }),
    )
    assert.ok(formattedBytes(candidate) > 64 * 1024)
    assert.throws(
      () => updateNativeConfig(() => candidate, { directory }),
      /native config exceeds 64 KiB/,
    )
    const after = await readFile(path)
    assert.equal(after.byteLength, before.byteLength)
    assert.equal(createHash('sha256').update(after).digest('hex'), previous.revision)
    assert.equal(readNativeConfig(false, directory).revision, previous.revision)
  })
})

test('strict native config rejects malformed, duplicate, missing, and unknown fields', () => {
  const valid = JSON.stringify(defaultNativeConfig())
  assert.deepEqual(parseNativeConfig(valid), defaultNativeConfig())
  const normalizedEndpoints = parseNativeConfig(
    JSON.stringify({
      ...defaultNativeConfig(),
      daemon: {
        ...defaultNativeConfig().daemon,
        engineUrl: 'https://engine.example///',
        mintUrl: 'https://mint.example///',
        mintUrls: ['https://mint.example///'],
      },
      cli: { trustedEngineUrls: ['https://engine.example/api///'] },
    }),
  )
  assert.equal(normalizedEndpoints.daemon.engineUrl, 'https://engine.example')
  assert.equal(normalizedEndpoints.daemon.mintUrl, 'https://mint.example')
  assert.deepEqual(normalizedEndpoints.cli.trustedEngineUrls, ['https://engine.example/api'])
  assert.throws(
    () =>
      parseNativeConfig(
        JSON.stringify({
          ...defaultNativeConfig(),
          cli: {
            trustedEngineUrls: ['https://engine.example', 'https://engine.example/'],
          },
        }),
      ),
    /trustedEngineUrls must not contain duplicates/,
  )
  for (const endpoint of ['http://localhost:5000', 'http://127.0.0.1:5000', 'http://[::1]:5000']) {
    const config = defaultNativeConfig()
    assert.equal(
      parseNativeConfig(
        JSON.stringify({
          ...config,
          daemon: {
            ...config.daemon,
            engineUrl: endpoint,
            mintUrl: endpoint,
            mintUrls: [endpoint],
          },
        }),
      ).daemon.engineUrl,
      endpoint,
    )
  }
  for (const field of ['engineUrl', 'mintUrl'] as const) {
    const config = defaultNativeConfig()
    assert.throws(
      () =>
        parseNativeConfig(
          JSON.stringify({
            ...config,
            daemon: { ...config.daemon, [field]: `http://${field}.example` },
          }),
        ),
      /expected https or loopback http URL/,
    )
  }
  assert.throws(() => parseNativeConfig('{'), /valid JSON/)
  assert.throws(
    () => parseNativeConfig(valid.replace('"version":2', '"version":2,"version":2')),
    /duplicate key/,
  )
  assert.throws(
    () => parseNativeConfig(valid.replace('"version":2', '"version":1')),
    /version is not supported/,
  )
  assert.throws(
    () =>
      parseNativeConfig(
        valid.replace('"assetMonitoringEnabled":false', '"assetMonitoringEnabled":"false"'),
      ),
    /assetMonitoringEnabled must be boolean/,
  )
  assert.throws(() => parseNativeConfig('{"version":2}'), /missing or unknown keys/)
  assert.throws(
    () => parseNativeConfig(valid.replace('"version":2', '"version":2,"secret":"x"')),
    /missing or unknown keys/,
  )
  assert.throws(
    () =>
      parseNativeConfig(valid.replace('"autoRetireResolvedConditionInventory":false', '"x":false')),
    /missing or unknown keys/,
  )
})

test('native relay selection uses public defaults only for new config and preserves exact opt-out', () => {
  const defaults = defaultNativeConfig()
  assert.ok(defaults.daemon.nostrRelays.length > 0)
  const config = (nostrRelays: unknown) =>
    JSON.stringify({ ...defaults, daemon: { ...defaults.daemon, nostrRelays } })
  assert.deepEqual(parseNativeConfig(config([])).daemon.nostrRelays, [])
  assert.deepEqual(
    parseNativeConfig(
      config([
        'wss://Custom.example/Path?B=2&A=1',
        'wss://custom.example/Path?B=2&A=1',
        'wss://custom.example/Path/',
      ]),
    ).daemon.nostrRelays,
    ['wss://custom.example/Path?B=2&A=1', 'wss://custom.example/Path/'],
  )
  assert.deepEqual(parseNativeConfig(config(['ws://localhost:8080'])).daemon.nostrRelays, [
    'ws://localhost:8080',
  ])
  assert.throws(() => parseNativeConfig(config(undefined)), /missing or unknown keys/)
  for (const relays of [
    null,
    'wss://relay.example',
    [1],
    ['https://relay.example'],
    ['ws://relay.example'],
    ['wss://user:secret@relay.example'],
    ['wss://relay.example/#fragment'],
  ])
    assert.throws(() => parseNativeConfig(config(relays)))
})

test('saved mints require one unique valid destination and a saved selection', () => {
  const defaults = defaultNativeConfig()
  const raw = (mintUrls: unknown, mintUrl = defaults.daemon.mintUrl) =>
    JSON.stringify({ ...defaults, daemon: { ...defaults.daemon, mintUrl, mintUrls } })
  assert.deepEqual(
    parseNativeConfig(raw(['https://mint.example///'], 'https://mint.example/')).daemon.mintUrls,
    ['https://mint.example'],
  )
  for (const invalid of [[], 'mint', [123]]) {
    assert.throws(() => parseNativeConfig(raw(invalid)), /nonempty array of strings/)
  }
  assert.throws(
    () => parseNativeConfig(raw(['https://mint.example', 'https://mint.example/'])),
    /must not contain duplicates/,
  )
  assert.throws(() => parseNativeConfig(raw(['invalid'])), /Invalid mint URL/)
  assert.throws(() => parseNativeConfig(raw(['https://mint.example'])), /must be in mintUrls/)
  const { mintUrls: _missing, ...daemon } = defaults.daemon
  assert.throws(
    () => parseNativeConfig(JSON.stringify({ ...defaults, daemon })),
    /missing or unknown keys/,
  )
})

test('revision conflicts and invalid updates leave config bytes unchanged', async () => {
  await withDataDir(async (directory) => {
    const old = createNativeConfig(defaultNativeConfig())
    const current = updateNativeConfig((config) => ({
      ...config,
      daemon: { ...config.daemon, nostrRelays: [] },
    }))
    const before = await readFile(join(directory, 'config.json'), 'utf8')
    assert.throws(
      () => updateNativeConfig((config) => config, { expectedRevision: old.revision }),
      /changed before write/,
    )
    assert.throws(
      () =>
        updateNativeConfig((config) => ({ ...config, daemon: { ...config.daemon, mintUrls: [] } })),
      /nonempty array/,
    )
    assert.equal(await readFile(join(directory, 'config.json'), 'utf8'), before)
    assert.equal(readNativeConfig().revision, current.revision)
  })
})

test('native config uses owner-only atomic updates and one writer lock', async () => {
  await withDataDir(async (directory) => {
    const created = ensureNativeConfig(defaultNativeConfig())
    assert.equal(created.created, true)
    assert.match(created.snapshot.revision ?? '', /^[0-9a-f]{64}$/)
    assert.equal(ensureNativeConfig(defaultNativeConfig()).created, false)
    const updated = updateNativeConfig((current) => ({
      ...current,
      daemon: { ...current.daemon, engineUrl: 'https://engine.example/', nostrRelays: [] },
    }))
    assert.equal(updated.config.daemon.engineUrl, 'https://engine.example')
    assert.deepEqual(updated.config.daemon.nostrRelays, [])
    assert.equal(JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')).version, 2)

    await writeFile(join(directory, '.config.lock'), '', { mode: 0o600 })
    assert.throws(() => updateNativeConfig((current) => current), /EEXIST/)
  })
})

test('native config rejects unsafe files and symlinks', async () => {
  if (process.platform === 'win32') return
  await withDataDir(async (directory) => {
    const path = join(directory, 'config.json')
    assert.throws(() => readNativeConfig(false), /missing/)
    assert.deepEqual(readNativeConfig(true).config, defaultNativeConfig())
    await writeFile(path, JSON.stringify(defaultNativeConfig()), { mode: 0o644 })
    await chmod(path, 0o644)
    assert.throws(() => readNativeConfig(), /must not be accessible/)
    await rm(path)
    const target = join(directory, 'target.json')
    await writeFile(target, JSON.stringify(defaultNativeConfig()), { mode: 0o600 })
    await symlink(target, path)
    assert.throws(() => readNativeConfig(), /plain file/)
    await rm(path)
    await chmod(directory, 0o755)
    await writeFile(path, JSON.stringify(defaultNativeConfig()), { mode: 0o600 })
    assert.throws(() => readNativeConfig(false), /data directory must not be accessible/)
    await chmod(directory, 0o700)
  })
})

test('daemon startup keeps one immutable config snapshot', async () => {
  await withDataDir(async () => {
    createNativeConfig(defaultNativeConfig())
    const frozen = freezeNativeConfigAtStartup()
    updateNativeConfig((current) => ({
      ...current,
      daemon: {
        ...current.daemon,
        mintUrl: 'https://replacement.example',
        mintUrls: ['https://replacement.example'],
        nostrRelays: [],
      },
    }))
    assert.equal(activeNativeConfig().revision, frozen.revision)
    assert.equal(activeNativeConfig().config.daemon.mintUrl, 'http://localhost:8085')
    assert.deepEqual(
      activeNativeConfig().config.daemon.nostrRelays,
      defaultNativeConfig().daemon.nostrRelays,
    )
  })
})

async function withDataDir(action: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-native-config-'))
  await chmod(directory, 0o700)
  const previous = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  try {
    await action(directory)
  } finally {
    if (previous === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previous
    await rm(directory, { recursive: true, force: true })
  }
}
