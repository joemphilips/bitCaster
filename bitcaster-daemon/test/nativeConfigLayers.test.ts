import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import {
  NATIVE_SETTING_DIGEST_HEADER,
  NATIVE_SETTING_KEYS,
  applyNativeSettingOverrides,
  nativeSettingEnvironmentVariable,
  nativeSettingLaunchArguments,
  nativeSettingOptionFlag,
  nativeSettingOverridesDigest,
  parseNativeSettingEnvironment,
  parseNativeSettingLaunchArguments,
  parseNativeSettingOptions,
  resolveNativeSettings,
} from '../src/nativeConfigLayers.ts'
import { defaultNativeConfig, parseNativeConfig, type NativeConfig } from '../src/nativeConfig.ts'
import { handleRequest } from '../src/server.ts'

function fileConfig(daemon: Partial<NativeConfig['daemon']>): NativeConfig {
  const config = defaultNativeConfig()
  return parseNativeConfig(JSON.stringify({ ...config, daemon: { ...config.daemon, ...daemon } }))
}

test('one table gives each setting its config key, environment variable, and option', () => {
  assert.deepEqual(
    NATIVE_SETTING_KEYS.map((key) => [
      key,
      nativeSettingEnvironmentVariable(key),
      nativeSettingOptionFlag(key),
    ]),
    [
      ['engineUrl', 'BITCASTER_ENGINE_URL', '--engine-url'],
      ['mintUrl', 'BITCASTER_MINT_URL', '--mint-url'],
      [
        'assetMonitoringEnabled',
        'BITCASTER_ASSET_MONITORING_ENABLED',
        '--asset-monitoring-enabled',
      ],
      [
        'autoRetireResolvedConditionInventory',
        'BITCASTER_AUTO_RETIRE_RESOLVED_CONDITION_INVENTORY',
        '--auto-retire-resolved-condition-inventory',
      ],
      ['recoveryIndexRealm', 'BITCASTER_RECOVERY_INDEX_REALM', '--recovery-index-realm'],
    ],
  )
})

test('each higher layer replaces each lower layer: default, file, environment, option', () => {
  const file = fileConfig({
    engineUrl: 'https://file.example',
    recoveryIndexRealm: 'bitcaster-staging',
  })
  const none = resolveNativeSettings({ file: null, environment: {}, options: {} })
  assert.deepEqual(none.engineUrl, { value: 'http://localhost:5000', source: 'default' })
  assert.deepEqual(none.recoveryIndexRealm, { value: 'bitcaster-production', source: 'default' })

  // default < file
  const fromFile = resolveNativeSettings({ file, environment: {}, options: {} })
  assert.deepEqual(fromFile.engineUrl, { value: 'https://file.example', source: 'file' })
  assert.deepEqual(fromFile.recoveryIndexRealm, { value: 'bitcaster-staging', source: 'file' })
  // A file without the optional realm key leaves the default.
  const withoutRealm = resolveNativeSettings({
    file: fileConfig({ engineUrl: 'https://file.example' }),
    environment: {},
    options: {},
  })
  assert.deepEqual(withoutRealm.recoveryIndexRealm, {
    value: 'bitcaster-production',
    source: 'default',
  })

  // file < environment, and default < environment
  const environment = parseNativeSettingEnvironment({
    BITCASTER_ENGINE_URL: 'https://environment.example/',
    BITCASTER_ASSET_MONITORING_ENABLED: 'true',
  })
  const fromEnvironment = resolveNativeSettings({ file, environment, options: {} })
  assert.deepEqual(fromEnvironment.engineUrl, {
    value: 'https://environment.example',
    source: 'environment',
  })
  assert.deepEqual(
    resolveNativeSettings({ file: null, environment, options: {} }).assetMonitoringEnabled,
    {
      value: true,
      source: 'environment',
    },
  )

  // environment < option, file < option, and default < option
  const options = parseNativeSettingOptions({
    engineUrl: 'https://option.example',
    recoveryIndexRealm: 'disabled',
  })
  const fromOption = resolveNativeSettings({ file, environment, options })
  assert.deepEqual(fromOption.engineUrl, { value: 'https://option.example', source: 'option' })
  assert.deepEqual(fromOption.recoveryIndexRealm, { value: 'disabled', source: 'option' })
  assert.deepEqual(
    resolveNativeSettings({ file: null, environment: {}, options }).recoveryIndexRealm,
    { value: 'disabled', source: 'option' },
  )
  // Other variables, such as the daemon passphrase, are not settings.
  assert.deepEqual(parseNativeSettingEnvironment({ BITCASTER_DAEMON_PASSPHRASE: 'secret' }), {})
})

test('an invalid value refuses with the setting name and its layer', () => {
  assert.throws(
    () => parseNativeSettingEnvironment({ BITCASTER_ENGINE_URL: 'http://engine.example' }),
    /environment variable BITCASTER_ENGINE_URL: Invalid engineUrl: expected https or loopback http URL/,
  )
  assert.throws(
    () => parseNativeSettingEnvironment({ BITCASTER_RECOVERY_INDEX_REALM: 'bitcaster.local' }),
    /environment variable BITCASTER_RECOVERY_INDEX_REALM: Invalid recoveryIndexRealm: expected one of bitcaster-production, bitcaster-staging, bitcaster-local, disabled/,
  )
  assert.throws(
    () => parseNativeSettingOptions({ assetMonitoringEnabled: 'enabled' }),
    /option --asset-monitoring-enabled: Invalid assetMonitoringEnabled: expected true or false/,
  )
  assert.throws(
    () => parseNativeSettingOptions({ mintUrl: '' }),
    /option --mint-url: Invalid mintUrl/,
  )
})

test('the daemon applies the settings that the CLI passes at its start', () => {
  const overrides = {
    ...parseNativeSettingEnvironment({ BITCASTER_MINT_URL: 'https://other-mint.example' }),
    ...parseNativeSettingOptions({
      engineUrl: 'https://option.example',
      recoveryIndexRealm: 'disabled',
    }),
  }
  const args = nativeSettingLaunchArguments(overrides)
  assert.deepEqual(args, [
    '--engine-url=https://option.example',
    '--mint-url=https://other-mint.example',
    '--recovery-index-realm=disabled',
  ])
  assert.deepEqual(parseNativeSettingLaunchArguments(args), overrides)
  assert.deepEqual(parseNativeSettingLaunchArguments(['--engine-url', 'https://option.example']), {
    engineUrl: 'https://option.example',
  })
  assert.throws(
    () => parseNativeSettingLaunchArguments(['--datadir=/tmp/x']),
    /Unknown run option: --datadir/,
  )
  assert.throws(
    () => parseNativeSettingLaunchArguments(['--engine-url=ftp://engine.example']),
    /option --engine-url: Invalid engineUrl/,
  )

  const file = fileConfig({ mintUrl: 'https://mint.example', mintUrls: ['https://mint.example'] })
  const applied = applyNativeSettingOverrides(file, overrides)
  assert.equal(applied.daemon.engineUrl, 'https://option.example')
  assert.equal(applied.daemon.mintUrl, 'https://other-mint.example')
  // The selected mint is always a configured mint; the file keeps its list.
  assert.deepEqual(applied.daemon.mintUrls, ['https://mint.example', 'https://other-mint.example'])
  assert.equal(applied.daemon.recoveryIndexRealm, 'disabled')
  assert.deepEqual(applyNativeSettingOverrides(file, {}), file)
})

test('a running daemon refuses a CLI with other environment or option settings', async () => {
  // The health answer reads the profile; an empty directory has none.
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-settings-'))
  const previous = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    await assertLaunchSettingsCheck()
  } finally {
    if (previous === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

async function assertLaunchSettingsCheck(): Promise<void> {
  const daemonOverrides = parseNativeSettingOptions({ engineUrl: 'https://option.example' })
  const digest = nativeSettingOverridesDigest(daemonOverrides)
  assert.equal(digest, nativeSettingOverridesDigest({ engineUrl: 'https://option.example' }))
  assert.notEqual(digest, nativeSettingOverridesDigest({}))
  assert.notEqual(digest, nativeSettingOverridesDigest({ engineUrl: 'https://other.example' }))

  const same = await health({ [NATIVE_SETTING_DIGEST_HEADER]: digest }, digest)
  assert.equal(same.status, 200)
  const other = await health({}, digest)
  assert.equal(other.status, 409)
  assert.deepEqual(other.body, {
    ok: false,
    code: 'daemon-settings-mismatch',
    error:
      'bitcaster-daemon runs with other environment or option settings. Run bitcaster-cli daemon restart with the settings of this command.',
  })
  // A daemon without overrides accepts a client without the header.
  assert.equal((await health({}, nativeSettingOverridesDigest({}))).status, 200)
  assert.equal(
    (await health({ [NATIVE_SETTING_DIGEST_HEADER]: digest }, nativeSettingOverridesDigest({})))
      .status,
    409,
  )
}

async function health(
  headers: Record<string, string>,
  launchSettingsDigest: string,
): Promise<{ status: number; body: unknown }> {
  class Response extends EventEmitter {
    status = 0
    text = ''
    writeHead(status: number) {
      this.status = status
    }
    end(value: string) {
      this.text = value
    }
  }
  const response = new Response()
  const request = Object.assign(
    Readable.from([Buffer.from(JSON.stringify({ method: 'health' }))]),
    {
      method: 'POST',
      url: '/rpc',
      headers: { authorization: 'Bearer test-token', ...headers },
      socket: { remoteAddress: '127.0.0.1' },
    },
  ) as unknown as IncomingMessage
  await handleRequest(request, response as unknown as ServerResponse, 'test-token', {
    launchSettingsDigest,
  })
  return { status: response.status, body: JSON.parse(response.text) }
}
