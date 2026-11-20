import { createHash } from 'node:crypto'
import { normalizeEndpointUrl } from './endpoint.ts'
import {
  DEFAULT_ENGINE_URL,
  DEFAULT_MINT_URL,
  DEFAULT_RECOVERY_INDEX_REALM,
  RECOVERY_INDEX_SETTINGS,
  isRecoveryIndexSetting,
  parseNativeConfig,
  type NativeConfig,
  type RecoveryIndexSetting,
} from './nativeConfig.ts'

/**
 * The layered settings of the CLI and the daemon (operator ruling
 * 2026-11-20). One row of the table gives each setting its `config.json` key,
 * the environment variable `BITCASTER_<KEY>` and the option `--<key>`. The
 * layers, from lowest to highest, are in the ASP.NET order: the built-in
 * default, the config file, the environment, and the command-line option.
 *
 * The CLI resolves the layers. It passes the values of its environment and
 * options to the daemon that it starts, so the daemon never reads the
 * environment for a setting. The data directory is not a setting: only
 * `--datadir` or `BITCASTER_DATADIR` selects it, because it holds the file.
 */

export type NativeSettingSource = 'default' | 'file' | 'environment' | 'option'

export interface NativeSettingValues {
  readonly engineUrl: string
  readonly mintUrl: string
  readonly assetMonitoringEnabled: boolean
  readonly autoRetireResolvedConditionInventory: boolean
  readonly recoveryIndexRealm: RecoveryIndexSetting
}

export type NativeSettingKey = keyof NativeSettingValues

/** The values of the environment or option layer. An absent key has no value there. */
export type NativeSettingOverrides = { readonly [K in NativeSettingKey]?: NativeSettingValues[K] }

/** The text values of the option layer, before parsing. */
export type NativeSettingTexts = { readonly [K in NativeSettingKey]?: string }

export type ResolvedNativeSettings = {
  readonly [K in NativeSettingKey]: {
    readonly value: NativeSettingValues[K]
    readonly source: NativeSettingSource
  }
}

interface NativeSettingRow<K extends NativeSettingKey> {
  readonly valueName: string
  readonly description: string
  readonly defaultValue: NativeSettingValues[K]
  /** The value of a parsed config file, or undefined when the file omits the key. */
  readonly fromFile: (config: NativeConfig) => NativeSettingValues[K] | undefined
  /** Parse one text value. Throw an error that names the key. */
  readonly parse: (text: string, key: K) => NativeSettingValues[K]
}

const TABLE: { readonly [K in NativeSettingKey]: NativeSettingRow<K> } = {
  engineUrl: {
    valueName: '<url>',
    description: 'Engine URL',
    defaultValue: DEFAULT_ENGINE_URL,
    fromFile: (config) => config.daemon.engineUrl,
    parse: (text, key) => normalizeEndpointUrl(text, key),
  },
  mintUrl: {
    valueName: '<url>',
    description: 'Selected mint URL',
    defaultValue: DEFAULT_MINT_URL,
    fromFile: (config) => config.daemon.mintUrl,
    parse: (text, key) => normalizeEndpointUrl(text, key),
  },
  assetMonitoringEnabled: {
    valueName: '<true|false>',
    description: 'Asset monitoring; false is privacy mode',
    defaultValue: false,
    fromFile: (config) => config.daemon.assetMonitoringEnabled,
    parse: parseBoolean,
  },
  autoRetireResolvedConditionInventory: {
    valueName: '<true|false>',
    description: 'Retire the inventory of resolved conditions automatically',
    defaultValue: false,
    fromFile: (config) => config.daemon.autoRetireResolvedConditionInventory,
    parse: parseBoolean,
  },
  recoveryIndexRealm: {
    valueName: '<realm>',
    description: `Recovery index realm of the engine, or disabled (${RECOVERY_INDEX_SETTINGS.join(', ')})`,
    defaultValue: DEFAULT_RECOVERY_INDEX_REALM,
    fromFile: (config) => config.daemon.recoveryIndexRealm,
    parse: (text, key) => {
      if (isRecoveryIndexSetting(text)) return text
      throw new Error(`Invalid ${key}: expected one of ${RECOVERY_INDEX_SETTINGS.join(', ')}`)
    },
  },
}

export const NATIVE_SETTING_KEYS: readonly NativeSettingKey[] = Object.freeze(
  Object.keys(TABLE) as NativeSettingKey[],
)

/** The CLI sends the digest of its overrides in this header on each daemon request. */
export const NATIVE_SETTING_DIGEST_HEADER = 'x-bitcaster-launch-settings'

/** The error code of a daemon that refuses a CLI with other overrides. */
export const DAEMON_SETTINGS_MISMATCH_CODE = 'daemon-settings-mismatch'

export function isNativeSettingKey(value: string): value is NativeSettingKey {
  return Object.hasOwn(TABLE, value)
}

/** `engineUrl` gives `BITCASTER_ENGINE_URL`. */
export function nativeSettingEnvironmentVariable(key: NativeSettingKey): string {
  return `BITCASTER_${words(key).join('_').toUpperCase()}`
}

/** `engineUrl` gives `--engine-url`. */
export function nativeSettingOptionFlag(key: NativeSettingKey): string {
  return `--${words(key).join('-')}`
}

export function nativeSettingOptionHelp(key: NativeSettingKey): {
  readonly flags: string
  readonly description: string
} {
  const row = TABLE[key]
  return {
    flags: `${nativeSettingOptionFlag(key)} ${row.valueName}`,
    description: `${row.description}. Environment: ${nativeSettingEnvironmentVariable(key)}`,
  }
}

export function parseNativeSettingEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): NativeSettingOverrides {
  return parseLayer((key) => {
    const name = nativeSettingEnvironmentVariable(key)
    const text = environment[name]
    return text === undefined ? undefined : { text, layer: `environment variable ${name}` }
  })
}

export function parseNativeSettingOptions(options: NativeSettingTexts): NativeSettingOverrides {
  return parseLayer((key) => {
    const text = options[key]
    return text === undefined
      ? undefined
      : { text, layer: `option ${nativeSettingOptionFlag(key)}` }
  })
}

export function resolveNativeSettings(layers: {
  readonly file: NativeConfig | null
  readonly environment: NativeSettingOverrides
  readonly options: NativeSettingOverrides
}): ResolvedNativeSettings {
  const resolved: Record<string, { value: unknown; source: NativeSettingSource }> = {}
  for (const key of NATIVE_SETTING_KEYS) {
    const row = TABLE[key] as NativeSettingRow<NativeSettingKey>
    const file = layers.file === null ? undefined : row.fromFile(layers.file)
    resolved[key] =
      layers.options[key] !== undefined
        ? { value: layers.options[key], source: 'option' }
        : layers.environment[key] !== undefined
          ? { value: layers.environment[key], source: 'environment' }
          : file !== undefined
            ? { value: file, source: 'file' }
            : { value: row.defaultValue, source: 'default' }
  }
  return resolved as ResolvedNativeSettings
}

/** The values of the environment and option layers, which the daemon cannot read itself. */
export function nativeSettingOverrides(resolved: ResolvedNativeSettings): NativeSettingOverrides {
  const overrides: Record<string, unknown> = {}
  for (const key of NATIVE_SETTING_KEYS) {
    const setting = resolved[key]
    if (setting.source === 'environment' || setting.source === 'option') {
      overrides[key] = setting.value
    }
  }
  return overrides as NativeSettingOverrides
}

/** The `run` options that pass the overrides to the daemon, in table order. */
export function nativeSettingLaunchArguments(overrides: NativeSettingOverrides): string[] {
  return NATIVE_SETTING_KEYS.flatMap((key) =>
    overrides[key] === undefined ? [] : [`${nativeSettingOptionFlag(key)}=${overrides[key]}`],
  )
}

/** Parse the `run` options of the daemon: only table options, as `--key=value` or `--key value`. */
export function parseNativeSettingLaunchArguments(args: readonly string[]): NativeSettingOverrides {
  const texts: Partial<Record<NativeSettingKey, string>> = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    const equals = arg.indexOf('=')
    const flag = equals === -1 ? arg : arg.slice(0, equals)
    const key = NATIVE_SETTING_KEYS.find((candidate) => nativeSettingOptionFlag(candidate) === flag)
    if (key === undefined) throw new Error(`Unknown run option: ${flag}`)
    if (texts[key] !== undefined) throw new Error(`Repeated run option: ${flag}`)
    const value = equals === -1 ? args[++index] : arg.slice(equals + 1)
    if (value === undefined) throw new Error(`Missing value for ${flag}`)
    texts[key] = value
  }
  return parseNativeSettingOptions(texts)
}

/** A digest of the overrides. Equal overrides give an equal digest. */
export function nativeSettingOverridesDigest(overrides: NativeSettingOverrides): string {
  const entries = NATIVE_SETTING_KEYS.flatMap((key) =>
    overrides[key] === undefined ? [] : [[key, overrides[key]]],
  )
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

/** The config of the daemon: the file config with the overrides of the starting CLI. */
export function applyNativeSettingOverrides(
  config: NativeConfig,
  overrides: NativeSettingOverrides,
): NativeConfig {
  const mintUrl = overrides.mintUrl
  return parseNativeConfig(
    JSON.stringify({
      ...config,
      daemon: {
        ...config.daemon,
        ...(overrides.engineUrl === undefined ? {} : { engineUrl: overrides.engineUrl }),
        // The selected mint is always a configured mint.
        ...(mintUrl === undefined
          ? {}
          : { mintUrl, mintUrls: [...new Set([...config.daemon.mintUrls, mintUrl])] }),
        ...(overrides.assetMonitoringEnabled === undefined
          ? {}
          : { assetMonitoringEnabled: overrides.assetMonitoringEnabled }),
        ...(overrides.autoRetireResolvedConditionInventory === undefined
          ? {}
          : {
              autoRetireResolvedConditionInventory: overrides.autoRetireResolvedConditionInventory,
            }),
        ...(overrides.recoveryIndexRealm === undefined
          ? {}
          : { recoveryIndexRealm: overrides.recoveryIndexRealm }),
      },
    }),
  )
}

function parseLayer(
  read: (key: NativeSettingKey) => { readonly text: string; readonly layer: string } | undefined,
): NativeSettingOverrides {
  const values: Record<string, unknown> = {}
  for (const key of NATIVE_SETTING_KEYS) {
    const input = read(key)
    if (input === undefined) continue
    const row = TABLE[key] as NativeSettingRow<NativeSettingKey>
    try {
      values[key] = row.parse(input.text, key)
    } catch (error) {
      throw new Error(`${input.layer}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return values as NativeSettingOverrides
}

function parseBoolean(text: string, key: string): boolean {
  if (text === 'true') return true
  if (text === 'false') return false
  throw new Error(`Invalid ${key}: expected true or false`)
}

function words(key: string): string[] {
  return key.split(/(?=[A-Z])/).map((word) => word.toLowerCase())
}
