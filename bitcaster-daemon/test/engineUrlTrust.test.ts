import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import {
  DEFAULT_ENGINE_URL,
  defaultNativeConfig,
  isTrustedEngineUrl,
  parseNativeConfig,
  untrustedEngineUrlMessage,
  updateNativeConfig,
} from '../src/nativeConfig.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'

const execFileAsync = promisify(execFile)
const mainPath = join(import.meta.dirname, '..', 'src', 'main.ts')
const UNTRUSTED = 'https://untrusted.example'
const TRUSTED = 'https://trusted.example'

function config(engineUrl: string, trustedEngineUrls: string[]) {
  const defaults = defaultNativeConfig()
  return parseNativeConfig(
    JSON.stringify({
      ...defaults,
      daemon: { ...defaults.daemon, engineUrl },
      cli: { trustedEngineUrls },
    }),
  )
}

test('the default engine URL and a URL in trustedEngineUrls are trusted, and no other URL is', () => {
  assert.equal(isTrustedEngineUrl(config(DEFAULT_ENGINE_URL, [])), true)
  assert.equal(isTrustedEngineUrl(config(`${TRUSTED}/`, [TRUSTED])), true)
  assert.equal(isTrustedEngineUrl(config(TRUSTED, [`${TRUSTED}/`])), true)
  assert.equal(isTrustedEngineUrl(config(UNTRUSTED, [TRUSTED])), false)
  assert.equal(isTrustedEngineUrl(config('http://127.0.0.1:5000', [])), false)
  assert.equal(
    untrustedEngineUrlMessage(UNTRUSTED, '/profile'),
    'Engine URL is not trusted: https://untrusted.example. Check the URL. Then add --trust-engine-url to a bitcaster-cli command, or add the URL to cli.trustedEngineUrls in /profile/config.json.',
  )
})

test('the daemon runtime refuses an untrusted engine URL before it opens the profile or sends a request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bitcaster-engine-trust-'))
  const home = join(root, 'profile')
  const log = join(root, 'requests.log')
  const preload = join(root, 'record-requests.mjs')
  try {
    await bootstrapFreshDaemonProfile({
      directory: home,
      engineBaseUrl: UNTRUSTED,
      mintUrl: 'https://mint.example',
      walletSeedHex: '11'.repeat(64),
      nostrSecretKeyHex: '22'.repeat(32),
      nativeOracleNonceSeedHex: '33'.repeat(32),
    })
    // No relay: a daemon that started would not open a relay connection.
    updateNativeConfig(
      (current) => ({
        ...current,
        daemon: { ...current.daemon, nostrRelays: [] },
        cli: { trustedEngineUrls: [TRUSTED] },
      }),
      { directory: home },
    )
    await writeFile(log, '')
    await writeFile(
      preload,
      `import { appendFileSync } from 'node:fs'
globalThis.fetch = async (input) => {
  appendFileSync(${JSON.stringify(log)}, String(input) + '\\n')
  throw new Error('the test sends no request')
}
`,
    )
    const before = (await readdir(home)).sort()
    // The file layer, and the option layer of the CLI that starts the daemon.
    for (const [setFileUrl, options] of [
      [UNTRUSTED, []],
      [TRUSTED, [`--engine-url=${UNTRUSTED}`]],
    ] as const) {
      updateNativeConfig(
        (current) => ({ ...current, daemon: { ...current.daemon, engineUrl: setFileUrl } }),
        { directory: home },
      )
      const files = (await readdir(home)).sort()
      const refusal = await runMain(preload, home, options).then(
        () => assert.fail('the daemon started'),
        (error: { code?: unknown; killed?: boolean; stderr?: unknown }) => error,
      )
      assert.equal(refusal.killed, false, 'the daemon did not stop')
      assert.equal(refusal.code, 1)
      assert.ok(
        String(refusal.stderr).includes(
          `bitcaster-daemon did not start. Engine URL is not trusted: ${UNTRUSTED}. Check the URL. Then add --trust-engine-url to a bitcaster-cli command, or add the URL to cli.trustedEngineUrls in ${join(home, 'config.json')}.`,
        ),
        String(refusal.stderr),
      )
      // No run lock, no socket, and no request.
      assert.deepEqual((await readdir(home)).sort(), files)
      assert.equal(await readFile(log, 'utf8'), '')
    }
    assert.deepEqual((await readdir(home)).sort(), before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/** The bounded timeout only detects a daemon that does not stop. */
function runMain(preload: string, home: string, options: readonly string[]) {
  return execFileAsync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--import',
      preload,
      mainPath,
      '--datadir',
      home,
      'run',
      ...options,
    ],
    { timeout: 30_000 },
  )
}
