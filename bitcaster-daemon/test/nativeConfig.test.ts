import assert from 'node:assert/strict'
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
} from '../src/nativeConfig.ts'

test('strict native config rejects malformed, duplicate, missing, and unknown fields', () => {
  const valid = JSON.stringify(defaultNativeConfig())
  assert.deepEqual(parseNativeConfig(valid), defaultNativeConfig())
  for (const endpoint of ['http://localhost:5000', 'http://127.0.0.1:5000', 'http://[::1]:5000']) {
    const config = defaultNativeConfig()
    assert.equal(
      parseNativeConfig(
        JSON.stringify({
          ...config,
          daemon: { ...config.daemon, engineUrl: endpoint, mintUrl: endpoint },
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
    () => parseNativeConfig(valid.replace('"version":1', '"version":1,"version":1')),
    /duplicate key/,
  )
  assert.throws(() => parseNativeConfig('{"version":1}'), /missing or unknown keys/)
  assert.throws(
    () => parseNativeConfig(valid.replace('"version":1', '"version":1,"secret":"x"')),
    /missing or unknown keys/,
  )
  assert.throws(
    () =>
      parseNativeConfig(valid.replace('"autoRetireResolvedConditionInventory":false', '"x":false')),
    /missing or unknown keys/,
  )
})

test('native config uses owner-only atomic updates and one writer lock', async () => {
  await withDataDir(async (directory) => {
    const created = ensureNativeConfig(defaultNativeConfig())
    assert.equal(created.created, true)
    assert.match(created.snapshot.revision ?? '', /^[0-9a-f]{64}$/)
    assert.equal(ensureNativeConfig(defaultNativeConfig()).created, false)
    const updated = updateNativeConfig((current) => ({
      ...current,
      daemon: { ...current.daemon, engineUrl: 'https://engine.example/' },
    }))
    assert.equal(updated.config.daemon.engineUrl, 'https://engine.example')
    assert.equal(JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')).version, 1)

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
      daemon: { ...current.daemon, mintUrl: 'https://replacement.example' },
    }))
    assert.equal(activeNativeConfig().revision, frozen.revision)
    assert.equal(activeNativeConfig().config.daemon.mintUrl, 'http://localhost:8085')
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
