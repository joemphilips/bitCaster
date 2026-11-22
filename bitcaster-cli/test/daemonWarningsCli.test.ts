import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const SOON = {
  code: 'conditional-keyset-final-expiry-soon',
  conditionId: 'ab'.repeat(32),
  keysetId: `01${'cd'.repeat(32)}`,
  finalExpiryAt: '2026-11-25T00:00:00.000Z',
}
const PAST = {
  code: 'conditional-keyset-final-expiry-soon',
  conditionId: 'ef'.repeat(32),
  keysetId: `01${'12'.repeat(32)}`,
  finalExpiryAt: '2026-11-20T00:00:00.000Z',
}

test('a daemon result keeps its warnings in the JSON and writes one stderr line for each', async () => {
  const home = await profile()
  try {
    const response = { ok: true, result: { totalAvailableSats: 12 }, warnings: [SOON, PAST] }
    for (const args of [['wallet', 'balance'], ['wallet', 'positions'], ['health']]) {
      const run = await runCli(home, args, response)
      assert.equal(run.code, 0, run.stderr)
      assert.deepEqual(JSON.parse(run.stdout), response)
      assert.equal(
        run.stderr,
        [SOON, PAST]
          .map(
            (warning) =>
              `Warning: conditional keyset ${warning.keysetId} of condition ${warning.conditionId} ` +
              `reaches its final expiry at ${warning.finalExpiryAt}. After that time, the mint ` +
              'does not have to honor its proofs.\n',
          )
          .join(''),
      )
    }
    // A failed result keeps its warnings and its exit code.
    const failed = await runCli(home, ['wallet', 'balance'], {
      ok: false,
      error: 'refused',
      warnings: [SOON],
    })
    assert.equal(failed.code, 1)
    assert.match(failed.stderr, /^Warning: conditional keyset 01(cd){32} of condition (ab){32} /)
    // A result without a warning writes nothing to stderr.
    const quiet = await runCli(home, ['wallet', 'balance'], { ok: true, result: {} })
    assert.equal(quiet.code, 0, quiet.stderr)
    assert.equal(quiet.stderr, '')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

async function profile(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-warnings-'))
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
  response: unknown,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const scratch = await mkdtemp(join(tmpdir(), 'bitcaster-cli-warnings-out-'))
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: scratch,
    BITCASTER_TEST_DAEMON_RESPONSE: JSON.stringify(response),
  }
  delete childEnv.NODE_TEST_CONTEXT
  delete childEnv.BITCASTER_DAEMON_HOME
  try {
    const stdoutPath = join(scratch, 'stdout')
    const stderrPath = join(scratch, 'stderr')
    const stdoutFile = await open(stdoutPath, 'wx', 0o600)
    const stderrFile = await open(stderrPath, 'wx', 0o600)
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--import',
        join(import.meta.dirname, 'daemonWarningsCliPreload.mjs'),
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
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
