import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

const SEED_HEX = 'cd'.repeat(64)

interface FileDaemon {
  engineUrl?: string
  mintUrl?: string
  recoveryIndexRealm?: string
  [key: string]: unknown
}

test('config get and config list show the effective value and the layer that sets it', async () => {
  const home = await profile({ recoveryIndexRealm: 'bitcaster-staging' })
  try {
    // default < file
    assert.deepEqual(await getJson(home, ['config', 'get', 'recoveryIndexRealm']), {
      value: 'bitcaster-staging',
      source: 'file',
    })
    // file < environment
    const environment = { BITCASTER_ENGINE_URL: 'https://environment.example/' }
    assert.deepEqual(await getJson(home, ['config', 'get', 'engineUrl'], environment), {
      value: 'https://environment.example',
      source: 'environment',
    })
    // environment < option
    assert.deepEqual(
      await getJson(
        home,
        ['--engine-url', 'https://option.example', 'config', 'get', 'engineUrl'],
        environment,
      ),
      { value: 'https://option.example', source: 'option' },
    )
    // file < option
    assert.deepEqual(
      await getJson(home, [
        'config',
        'get',
        'assetMonitoringEnabled',
        '--asset-monitoring-enabled',
        'true',
      ]),
      { value: true, source: 'option' },
    )
    assert.deepEqual(await getJson(home, ['config', 'list'], environment), {
      engineUrl: { value: 'https://environment.example', source: 'environment' },
      mintUrl: { value: 'https://mint.example', source: 'file' },
      assetMonitoringEnabled: { value: false, source: 'file' },
      autoRetireResolvedConditionInventory: { value: false, source: 'file' },
      recoveryIndexRealm: { value: 'bitcaster-staging', source: 'file' },
    })
    const unknown = await runCli(home, ['config', 'get', 'trustedEngineUrls'])
    assert.equal(unknown.code, 2)
    assert.match(unknown.stderr, /Unknown config key: trustedEngineUrls/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }

  // A release 6 file without the optional realm key keeps the default.
  const plain = await profile()
  try {
    assert.deepEqual(await getJson(plain, ['config', 'get', 'recoveryIndexRealm']), {
      value: 'bitcaster-production',
      source: 'default',
    })
    // default < environment
    assert.deepEqual(
      await getJson(plain, ['config', 'get', 'recoveryIndexRealm'], {
        BITCASTER_RECOVERY_INDEX_REALM: 'bitcaster-local',
      }),
      { value: 'bitcaster-local', source: 'environment' },
    )
    // default < option
    assert.deepEqual(
      await getJson(plain, [
        '--recovery-index-realm',
        'disabled',
        'config',
        'get',
        'recoveryIndexRealm',
      ]),
      { value: 'disabled', source: 'option' },
    )
  } finally {
    await rm(plain, { recursive: true, force: true })
  }
})

test('an invalid value refuses with the setting name and the layer', async () => {
  const home = await profile()
  try {
    const environment = await runCli(home, ['config', 'list'], {
      BITCASTER_ASSET_MONITORING_ENABLED: 'yes',
    })
    assert.equal(environment.code, 2)
    assert.match(
      environment.stderr,
      /environment variable BITCASTER_ASSET_MONITORING_ENABLED: Invalid assetMonitoringEnabled: expected true or false/,
    )
    const option = await runCli(home, [
      '--recovery-index-realm',
      'bitcaster.local',
      'config',
      'list',
    ])
    assert.equal(option.code, 2)
    assert.match(option.stderr, /option --recovery-index-realm: Invalid recoveryIndexRealm/)
    const blankDirectory = await runCli(null, ['config', 'path'], { BITCASTER_DATADIR: ' ' })
    assert.equal(blankDirectory.code, 2)
    assert.match(
      blankDirectory.stderr,
      /environment variable BITCASTER_DATADIR: data directory must not be empty/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
  const insecureFile = await profile({ engineUrl: 'http://engine.example' })
  try {
    const file = await runCli(insecureFile, ['config', 'list'])
    assert.equal(file.code, 1)
    assert.match(
      file.stderr,
      /config file .*config\.json: Invalid config\.daemon\.engineUrl: expected https or loopback http URL/,
    )
  } finally {
    await rm(insecureFile, { recursive: true, force: true })
  }
})

test('only --datadir or BITCASTER_DATADIR selects the data directory', async () => {
  const selected = await profile()
  const other = await profile()
  try {
    const fromEnvironment = await runCli(null, ['config', 'path'], { BITCASTER_DATADIR: selected })
    assert.equal(fromEnvironment.code, 0, fromEnvironment.stderr)
    assert.equal(fromEnvironment.stdout, `${join(selected, 'config.json')}\n`)
    const fromOption = await runCli(selected, ['config', 'path'], { BITCASTER_DATADIR: other })
    assert.equal(fromOption.stdout, `${join(selected, 'config.json')}\n`)
  } finally {
    await rm(selected, { recursive: true, force: true })
    await rm(other, { recursive: true, force: true })
  }
  // The file has no data directory key.
  const withKey = await profile({ dataDir: '/tmp/elsewhere' })
  try {
    const refused = await runCli(withKey, ['config', 'list'])
    assert.equal(refused.code, 1)
    assert.match(refused.stderr, /missing or unknown keys/)
  } finally {
    await rm(withKey, { recursive: true, force: true })
  }
})

test('the engine URL trust check applies to a URL from the environment and from an option', async () => {
  const home = await profile({ engineUrl: 'https://trusted.example' }, ['https://trusted.example'])
  const configPath = join(home, 'config.json')
  const create = [
    'market',
    'create',
    '--condition-id',
    'cond-1',
    '--title',
    'Market',
    '--description',
    'Text',
    '--outcomes',
    'YES,NO',
  ]
  try {
    const before = await readFile(configPath, 'utf8')
    for (const [args, env] of [
      [create, { BITCASTER_ENGINE_URL: 'https://untrusted.example' }],
      [['--engine-url', 'https://untrusted.example', ...create], {}],
    ] as const) {
      const result = await runCli(home, args, env)
      assert.equal(result.code, 3, result.stderr)
      assert.match(
        result.stderr,
        /About to use engine URL for authenticated market create: https:\/\/untrusted\.example/,
      )
      assert.match(result.stderr, /Refusing to trust a new engine URL without --trust-engine-url/)
    }
    // An insecure URL refuses at its layer, before any trust prompt.
    const insecure = await runCli(home, create, {
      BITCASTER_ENGINE_URL: 'http://untrusted.example',
    })
    assert.equal(insecure.code, 2)
    assert.match(insecure.stderr, /environment variable BITCASTER_ENGINE_URL: Invalid engineUrl/)
    assert.equal(await readFile(configPath, 'utf8'), before)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('config set writes only the file, and the release 6 option names still work', async () => {
  const home = await profile({ engineUrl: 'https://file.example' })
  const configPath = join(home, 'config.json')
  const environment = { BITCASTER_ENGINE_URL: 'https://environment.example' }
  try {
    const mint = await runCli(
      home,
      ['config', 'set', '--mint-url', 'https://new-mint.example'],
      environment,
    )
    assert.equal(mint.code, 0, mint.stderr)
    let saved = JSON.parse(await readFile(configPath, 'utf8')) as { daemon: FileDaemon }
    assert.equal(saved.daemon.engineUrl, 'https://file.example')
    assert.equal(saved.daemon.mintUrl, 'https://new-mint.example')
    assert.deepEqual(saved.daemon.mintUrls, ['https://mint.example', 'https://new-mint.example'])

    const engine = await runCli(
      home,
      ['config', 'set', '--engine-url', 'https://new.example'],
      environment,
    )
    assert.equal(engine.code, 0, engine.stderr)
    assert.match(engine.stderr, /BITCASTER_ENGINE_URL overrides engineUrl of the config file/)
    saved = JSON.parse(await readFile(configPath, 'utf8')) as { daemon: FileDaemon }
    assert.equal(saved.daemon.engineUrl, 'https://new.example')
    assert.deepEqual(await getJson(home, ['config', 'get', 'engineUrl'], environment), {
      value: 'https://environment.example',
      source: 'environment',
    })

    const monitoring = await runCli(home, ['config', 'set', '--asset-monitoring', 'enabled'])
    assert.equal(monitoring.code, 0, monitoring.stderr)
    const realm = await runCli(home, ['config', 'set', '--recovery-index-realm', 'disabled'])
    assert.equal(realm.code, 0, realm.stderr)
    const retire = await runCli(home, [
      'config',
      'set',
      '--auto-retire-resolved-condition-inventory',
      'true',
    ])
    assert.equal(retire.code, 0, retire.stderr)
    saved = JSON.parse(await readFile(configPath, 'utf8')) as { daemon: FileDaemon }
    assert.equal(saved.daemon.assetMonitoringEnabled, true)
    assert.equal(saved.daemon.recoveryIndexRealm, 'disabled')
    assert.equal(saved.daemon.autoRetireResolvedConditionInventory, true)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('with the disabled realm, wallet backup delete needs an explicit realm', async () => {
  const home = await profile({ recoveryIndexRealm: 'disabled' })
  try {
    const seedPath = join(home, 'wallet-seed.hex')
    await writeFile(seedPath, `${SEED_HEX}\n`, { mode: 0o600 })
    const deleteArgs = [
      '--dry-run',
      'wallet',
      'backup',
      'delete',
      '--wallet-seed-hex-file',
      seedPath,
    ]
    const refused = await runCli(home, deleteArgs)
    assert.equal(refused.code, 2)
    assert.match(refused.stderr, /recovery index realm setting is disabled; pass --realm/)
    const explicit = await runCli(home, [...deleteArgs, '--realm', 'bitcaster-staging'])
    assert.equal(explicit.code, 0, explicit.stderr)
    assert.equal(JSON.parse(explicit.stdout).params.realm, 'bitcaster-staging')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('the CLI starts the daemon with its environment and option settings and names them on each request', async () => {
  const home = await inProcessDataDir()
  {
    const rpc = await import('../src/rpc.ts')
    const { nativeSettingOverridesDigest } =
      await import('../../bitcaster-daemon/src/nativeConfigLayers.ts')
    const overrides = {
      engineUrl: 'https://option.example',
      recoveryIndexRealm: 'disabled',
    } as const
    rpc.configureDaemonLaunchSettings(overrides)
    assert.deepEqual(rpc.daemonRunArguments('/daemon/main.js'), [
      '--experimental-strip-types',
      '/daemon/main.js',
      `--datadir=${home}`,
      'run',
      '--engine-url=https://option.example',
      '--recovery-index-realm=disabled',
    ])
    assert.deepEqual(rpc.daemonLaunchSettingsHeaders(), {
      'x-bitcaster-launch-settings': nativeSettingOverridesDigest(overrides),
    })
    rpc.configureDaemonLaunchSettings({})
  }
})

test('the wait for a started daemon treats a daemon with other settings as not ready', async () => {
  await inProcessDataDir()
  const rpc = await import('../src/rpc.ts')
  const testGlobal = globalThis as Record<symbol, unknown>
  const urlKey = Symbol.for('bitcaster.test.daemon-url')
  const previousFetch = globalThis.fetch
  const previousUrl = testGlobal[urlKey]
  const mismatch = {
    ok: false,
    code: 'daemon-settings-mismatch',
    error: 'bitcaster-daemon runs with other environment or option settings.',
  }
  const answers: unknown[] = []
  let requests = 0
  testGlobal[urlKey] = 'http://daemon.test'
  globalThis.fetch = async () => {
    requests += 1
    return Response.json(answers.shift() ?? mismatch, { status: 409 })
  }
  try {
    // A persistent mismatch ends the wait with a clear error, not a success.
    await assert.rejects(
      rpc.waitForDaemon(undefined, 0),
      /a bitcaster-daemon with other environment or option settings answers at http:\/\/daemon\.test\/rpc/,
    )
    assert.equal(requests, 1)
    // The wait goes on after a mismatch and ends at the first ready answer.
    requests = 0
    answers.push(mismatch, { ok: true, result: { status: 'ok' } })
    await rpc.waitForDaemon(undefined, 5_000)
    assert.equal(requests, 2)
  } finally {
    globalThis.fetch = previousFetch
    if (previousUrl === undefined) delete testGlobal[urlKey]
    else testGlobal[urlKey] = previousUrl
  }
})

let inProcessHome: Promise<string> | undefined

/** rpc.ts reads the data directory of the built daemon package, which is set once. */
function inProcessDataDir(): Promise<string> {
  inProcessHome ??= (async () => {
    const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-launch-'))
    const { configureDataDir } = await import('@bitcaster-market/daemon/dataDir')
    configureDataDir(home)
    return home
  })()
  return inProcessHome
}

after(async () => {
  if (inProcessHome !== undefined) await rm(await inProcessHome, { recursive: true, force: true })
})

async function profile(daemon: FileDaemon = {}, trustedEngineUrls: string[] = []): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-layers-'))
  // The form that the release 6 CLI writes before C6.
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
        ...daemon,
      },
      cli: { trustedEngineUrls },
    })}\n`,
    { mode: 0o600 },
  )
  return home
}

async function getJson(
  home: string,
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<unknown> {
  const result = await runCli(home, args, env)
  assert.equal(result.code, 0, result.stderr)
  return JSON.parse(result.stdout)
}

/** Run the CLI; `home` null omits `--datadir`. No daemon starts: the RPC URL is unreachable. */
async function runCli(
  home: string | null,
  args: readonly string[],
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const scratch = await mkdtemp(join(tmpdir(), 'bitcaster-cli-layers-out-'))
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: scratch,
    BITCASTER_TEST_DAEMON_URL: 'http://127.0.0.1:1',
    ...extraEnv,
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
        join(import.meta.dirname, 'rpcTransportTestSetup.ts'),
        join(import.meta.dirname, '..', 'src', 'main.ts'),
        ...(home === null ? [] : ['--datadir', home]),
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
