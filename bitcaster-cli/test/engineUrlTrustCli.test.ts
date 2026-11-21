import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// The daemon sends signed requests to its engine URL. The CLI checks the trust
// of that URL before it starts the daemon. The preload records each daemon
// start and each request, and does neither.

const UNTRUSTED = 'https://untrusted.example'
const TRUSTED = 'https://trusted.example'

interface TrustLogEntry {
  action: 'fetch' | 'spawn'
  url?: string
  args?: string[]
}

test('the CLI refuses to start the daemon with an untrusted engine URL from any layer and sends no request', async () => {
  for (const layer of ['file', 'environment', 'option'] as const) {
    const home = await profile(layer === 'file' ? UNTRUSTED : TRUSTED, [TRUSTED])
    try {
      const before = await readFile(join(home, 'config.json'), 'utf8')
      const result = await runCli(
        home,
        layer === 'option' ? ['--engine-url', UNTRUSTED, 'health'] : ['health'],
        layer === 'environment' ? { BITCASTER_ENGINE_URL: UNTRUSTED } : {},
      )
      assert.equal(result.code, 3, `${layer}: ${result.stderr}`)
      assert.match(
        result.stderr,
        /About to use engine URL for authenticated daemon requests: https:\/\/untrusted\.example\n/,
      )
      assert.ok(
        result.stderr.includes(
          `Engine URL is not trusted: ${UNTRUSTED}. Check the URL. Then add --trust-engine-url to a bitcaster-cli command, or add the URL to cli.trustedEngineUrls in ${join(home, 'config.json')}.`,
        ),
        result.stderr,
      )
      // No daemon process, no daemon log, no saved trust, and no request.
      assert.deepEqual(result.log, [], layer)
      assert.deepEqual(await readdir(home), ['config.json'], layer)
      assert.equal(await readFile(join(home, 'config.json'), 'utf8'), before, layer)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }
})

test('the trust option saves the engine URL before the daemon starts, and a saved or default URL needs no option', async () => {
  const home = await profile(TRUSTED, [TRUSTED])
  const defaultHome = await profile('http://localhost:5000', [])
  try {
    const trusted = await runCli(home, ['--engine-url', UNTRUSTED, '--trust-engine-url', 'health'])
    assert.equal(trusted.code, 1, trusted.stderr)
    assert.match(trusted.stderr, /the test starts no daemon/)
    assert.equal(trusted.log.length, 1)
    assert.equal(trusted.log[0]!.action, 'spawn')
    assert.ok(trusted.log[0]!.args!.includes(`--engine-url=${UNTRUSTED}`))
    assert.ok(trusted.stderr.includes(trustedNotice(home, UNTRUSTED)), trusted.stderr)
    assert.deepEqual(await trustedEngineUrls(home), [TRUSTED, UNTRUSTED])

    const saved = await runCli(home, ['--engine-url', UNTRUSTED, 'health'])
    assert.equal(saved.code, 1, saved.stderr)
    assert.doesNotMatch(saved.stderr, /About to use engine URL/)
    assert.deepEqual(
      saved.log.map((entry) => entry.action),
      ['spawn'],
    )

    const defaultUrl = await runCli(defaultHome, ['health'])
    assert.equal(defaultUrl.code, 1, defaultUrl.stderr)
    assert.doesNotMatch(defaultUrl.stderr, /About to use engine URL/)
    assert.deepEqual(
      defaultUrl.log.map((entry) => entry.action),
      ['spawn'],
    )
    assert.deepEqual(await trustedEngineUrls(defaultHome), [])
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(defaultHome, { recursive: true, force: true })
  }
})

test('daemon restart refuses an untrusted engine URL before it stops the running daemon', async () => {
  if (process.platform === 'win32') return
  const home = await profile(TRUSTED, [TRUSTED])
  try {
    await withRunningDaemon(home, async (assertStillRunning) => {
      const result = await runCli(home, ['--engine-url', UNTRUSTED, 'daemon', 'restart'])
      assert.equal(result.code, 3, result.stderr)
      assert.match(result.stderr, /Engine URL is not trusted: https:\/\/untrusted\.example\./)
      assert.deepEqual(result.log, [])
      await assertStillRunning()
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('config set with the trust option saves the trust of the engine URL that it writes', async () => {
  const home = await profile(TRUSTED, [TRUSTED])
  try {
    const trusted = await runCli(home, [
      'config',
      'set',
      '--engine-url',
      'https://new.example/',
      '--trust-engine-url',
    ])
    assert.equal(trusted.code, 0, trusted.stderr)
    assert.deepEqual(JSON.parse(trusted.stdout).result.config.trustedEngineUrls, [
      TRUSTED,
      'https://new.example',
    ])
    assert.deepEqual(await trustedEngineUrls(home), [TRUSTED, 'https://new.example'])
    assert.ok(trusted.stderr.includes(trustedNotice(home, 'https://new.example')), trusted.stderr)

    // Without the option, config set does not ask. The next daemon start asks.
    const untrusted = await runCli(home, ['config', 'set', '--engine-url', UNTRUSTED])
    assert.equal(untrusted.code, 0, untrusted.stderr)
    assert.doesNotMatch(untrusted.stderr, /About to use engine URL/)
    assert.deepEqual(await trustedEngineUrls(home), [TRUSTED, 'https://new.example'])
    assert.deepEqual([...trusted.log, ...untrusted.log], [])

    // The option trusts only an engine URL that the command writes.
    const before = await readFile(join(home, 'config.json'), 'utf8')
    const noEngine = await runCli(home, [
      'config',
      'set',
      '--mint-url',
      'https://mint2.example',
      '--trust-engine-url',
    ])
    assert.equal(noEngine.code, 2, noEngine.stderr)
    assert.match(noEngine.stderr, /config set --trust-engine-url needs --engine-url/)
    assert.equal(await readFile(join(home, 'config.json'), 'utf8'), before)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('config set trusts the written engine URL, not an environment URL that replaces it', async () => {
  const environment = { BITCASTER_ENGINE_URL: 'https://evil.example' }
  const write = ['config', 'set', '--engine-url', 'https://good.example', '--trust-engine-url']
  const home = await profile(TRUSTED, [TRUSTED])
  try {
    const result = await runCli(home, write, environment)
    assert.equal(result.code, 0, result.stderr)
    assert.ok(result.stderr.includes(trustedNotice(home, 'https://good.example')), result.stderr)
    assert.match(result.stderr, /BITCASTER_ENGINE_URL overrides engineUrl of the config file/)
    assert.doesNotMatch(result.stderr, /evil\.example/)
    assert.deepEqual(await trustedEngineUrls(home), [TRUSTED, 'https://good.example'])

    // The next daemon start checks the effective URL, which is still not trusted.
    const start = await runCli(home, ['health'], environment)
    assert.equal(start.code, 3, start.stderr)
    assert.match(start.stderr, /Engine URL is not trusted: https:\/\/evil\.example\./)
    assert.deepEqual([...result.log, ...start.log], [])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
  if (process.platform === 'win32') return
  // The restart of a running daemon checks the effective URL without the option.
  const running = await profile(TRUSTED, [TRUSTED])
  try {
    await withRunningDaemon(running, async (assertStillRunning) => {
      const result = await runCli(running, write, environment)
      assert.equal(result.code, 3, result.stderr)
      assert.ok(result.stderr.includes(trustedNotice(running, 'https://good.example')))
      assert.match(result.stderr, /Engine URL is not trusted: https:\/\/evil\.example\./)
      assert.deepEqual(result.log, [])
      assert.deepEqual(await trustedEngineUrls(running), [TRUSTED, 'https://good.example'])
      await assertStillRunning()
    })
  } finally {
    await rm(running, { recursive: true, force: true })
  }
})

test('an engine URL with user info or a control character is refused at its layer, before any prompt', async () => {
  const home = await profile(TRUSTED, [TRUSTED])
  try {
    for (const [args, env, layer] of [
      [
        ['health'],
        { BITCASTER_ENGINE_URL: 'https://evil.example/\x1b[1A\x1b[2Khttps://good.example' },
        /^environment variable BITCASTER_ENGINE_URL: Invalid engineUrl: the URL must contain only printable ASCII characters, with no space or control character$/m,
      ],
      [
        ['--engine-url', 'https://good.example@evil.example', 'health'],
        {},
        /^option --engine-url: Invalid engineUrl: the URL must not contain a user name or password$/m,
      ],
    ] as const) {
      const result = await runCli(home, args, env)
      assert.equal(result.code, 2, result.stderr)
      assert.match(result.stderr, layer)
      assert.doesNotMatch(result.stderr, /About to use engine URL|\x1b/)
      assert.deepEqual(result.log, [])
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

/** The notice that the CLI prints when it saves the trust of an engine URL. */
function trustedNotice(home: string, engineUrl: string): string {
  return `Trusted engine URL: ${engineUrl}. Saved it in cli.trustedEngineUrls of ${join(home, 'config.json')}.\n`
}

/** Run a process that the CLI takes for a daemon that it started, and stop it after `use`. */
async function withRunningDaemon(
  home: string,
  use: (assertStillRunning: () => Promise<void>) => Promise<void>,
): Promise<void> {
  // The CLI stops only a process with the command line of a daemon that it started.
  const daemonMain = join(home, 'node_modules', '@bitcaster-market', 'daemon', 'dist', 'main.js')
  await mkdir(join(home, 'node_modules', '@bitcaster-market', 'daemon', 'dist'), {
    recursive: true,
  })
  await writeFile(daemonMain, "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)\n")
  const running = spawn(process.execPath, [daemonMain, `--datadir=${home}`, 'run'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  try {
    // Wait for the process to run its own code, so that its command line is final.
    const [ready] = (await once(running.stdout!, 'data')) as [Buffer]
    assert.equal(ready.toString(), 'ready\n')
    const pidPath = join(home, 'daemon-autostart.pid')
    const pidFile = `${JSON.stringify({ pid: running.pid, daemonMain, dataDir: home })}\n`
    await writeFile(pidPath, pidFile, { mode: 0o600 })
    await use(async () => {
      assert.equal(running.exitCode, null)
      assert.equal(running.signalCode, null)
      assert.equal(await readFile(pidPath, 'utf8'), pidFile)
    })
  } finally {
    if (running.exitCode === null && running.signalCode === null) {
      const exited = once(running, 'exit')
      running.kill('SIGKILL')
      await exited
    }
  }
}

async function profile(engineUrl: string, trusted: string[]): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-trust-'))
  await writeFile(
    join(home, 'config.json'),
    `${JSON.stringify({
      version: 2,
      daemon: {
        engineUrl,
        mintUrl: 'https://mint.example',
        mintUrls: ['https://mint.example'],
        autoRetireResolvedConditionInventory: false,
        assetMonitoringEnabled: false,
        nostrRelays: [],
      },
      cli: { trustedEngineUrls: trusted },
    })}\n`,
    { mode: 0o600 },
  )
  return home
}

async function trustedEngineUrls(home: string): Promise<string[]> {
  const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8')) as {
    cli: { trustedEngineUrls: string[] }
  }
  return config.cli.trustedEngineUrls
}

/** Run the CLI without a terminal. The daemon is not running, so a command can start it. */
async function runCli(
  home: string,
  args: readonly string[],
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string; log: TrustLogEntry[] }> {
  const scratch = await mkdtemp(join(tmpdir(), 'bitcaster-cli-trust-out-'))
  const logPath = join(scratch, 'trust.log')
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: scratch,
    BITCASTER_TEST_TRUST_LOG: logPath,
    ...extraEnv,
  }
  delete childEnv.NODE_TEST_CONTEXT
  delete childEnv.BITCASTER_DAEMON_HOME
  delete childEnv.BITCASTER_TEST_DAEMON_URL
  if (extraEnv.BITCASTER_ENGINE_URL === undefined) delete childEnv.BITCASTER_ENGINE_URL
  try {
    await writeFile(logPath, '', { mode: 0o600 })
    const stdoutPath = join(scratch, 'stdout')
    const stderrPath = join(scratch, 'stderr')
    const stdoutFile = await open(stdoutPath, 'wx', 0o600)
    const stderrFile = await open(stderrPath, 'wx', 0o600)
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--import',
        join(import.meta.dirname, 'engineUrlTrustCliPreload.mjs'),
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
    const logText = await readFile(logPath, 'utf8')
    return {
      code,
      stdout: await readFile(stdoutPath, 'utf8'),
      stderr: await readFile(stderrPath, 'utf8'),
      log: logText
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as TrustLogEntry),
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
