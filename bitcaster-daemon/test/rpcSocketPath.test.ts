import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { updateNativeConfig } from '../src/nativeConfig.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { rpcSocketPath } from '../src/rpcAuth.ts'

const execFileAsync = promisify(execFile)
const mainPath = join(import.meta.dirname, '..', 'src', 'main.ts')
// Linux binds a path that fills its 108-byte `sun_path` (measured). macOS has
// a 104-byte `sun_path`; the daemon keeps one byte for the NUL (not measured).
const socketPathLimits = [
  { platform: 'linux', limit: 108 },
  { platform: 'darwin', limit: 103 },
] as const
const hostLimit = process.platform === 'linux' ? 108 : 103
const skipOnWindows = {
  skip: process.platform === 'win32' ? 'the daemon uses loopback TCP on Windows' : false,
}

/** Two-byte characters make the byte count differ from the character count. */
function dataDirWithSocketPathBytes(bytes: number): string {
  const wide = 'é'.repeat(8)
  const narrow = 'd'.repeat(bytes - Buffer.byteLength(`/${wide}/daemon.sock`))
  return `/${wide}${narrow}`
}

async function withDaemonHome<T>(home: string, run: () => T | Promise<T>): Promise<T> {
  const previous = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previous
  }
}

async function withLongDataDir(run: (root: string, home: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'bitcaster-socket-limit-'))
  try {
    await run(root, join(root, 'd'.repeat(120)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** The bounded timeout only detects a daemon that does not stop. */
function runMain(home: string, command: string) {
  return execFileAsync(
    process.execPath,
    ['--experimental-strip-types', mainPath, '--datadir', home, command],
    { timeout: 60_000 },
  )
}

function assertRefusedOverLimit(error: { code?: unknown; stderr?: unknown }): true {
  assert.equal(error.code, 1)
  assert.match(
    String(error.stderr),
    new RegExp(`over the ${hostLimit}-byte Unix socket path limit`),
  )
  return true
}

for (const { platform, limit } of socketPathLimits) {
  test(`the ${platform} socket path may have ${limit} bytes and no more`, async () => {
    const fits = dataDirWithSocketPathBytes(limit)
    assert.equal(
      await withDaemonHome(fits, () => rpcSocketPath(platform)),
      join(fits, 'daemon.sock'),
    )
    const tooLong = dataDirWithSocketPathBytes(limit + 1)
    await withDaemonHome(tooLong, () =>
      assert.throws(() => rpcSocketPath(platform), {
        message:
          `daemon socket path is ${limit + 1} bytes, over the ${limit}-byte Unix socket path ` +
          `limit: ${join(tooLong, 'daemon.sock')}. Choose a shorter --datadir.`,
      }),
    )
  })
}

test(
  'daemon init refuses a socket path over the limit before it writes a profile',
  skipOnWindows,
  async () => {
    await withLongDataDir(async (root, home) => {
      await assert.rejects(runMain(home, 'init'), assertRefusedOverLimit)
      assert.deepEqual(await readdir(root), [])
    })
  },
)

test(
  'daemon run refuses a socket path over the limit before it opens the profile',
  skipOnWindows,
  async () => {
    await withLongDataDir(async (_root, home) => {
      await withDaemonHome(home, async () => {
        await bootstrapFreshDaemonProfile({
          directory: home,
          engineBaseUrl: 'http://127.0.0.1:9',
          mintUrl: 'http://127.0.0.1:9',
          walletSeedHex: '11'.repeat(64),
          nostrSecretKeyHex: '22'.repeat(32),
          nativeOracleNonceSeedHex: '33'.repeat(32),
        })
        updateNativeConfig((config) => config)
      })
      const before = await readdir(home)
      await assert.rejects(runMain(home, 'run'), assertRefusedOverLimit)
      // No run lock or socket file appears.
      assert.deepEqual(await readdir(home), before)
    })
  },
)
