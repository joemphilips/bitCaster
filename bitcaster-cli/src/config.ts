import {
  nativeConfigPath,
  parseNativeConfig,
  readNativeConfig,
  updateNativeConfig,
  type NativeConfig,
  type NativeConfigSnapshot,
  type RecoveryIndexSetting,
} from '@bitcaster-market/daemon/nativeConfig'
import {
  applyNativeSettingOverrides,
  resolveNativeSettings,
  type NativeSettingOverrides,
  type ResolvedNativeSettings,
} from '@bitcaster-market/daemon/nativeConfigLayers'

/** The values that `config.json` holds, as `config set` reports them. */
export interface CliConfig {
  engineUrl: string
  mintUrl: string
  assetMonitoringEnabled: boolean
  trustedEngineUrls: string[]
  /** Present only after a user sets it. An absent value is the production realm. */
  recoveryIndexRealm?: RecoveryIndexSetting
}

export function configFilePath(): string {
  return nativeConfigPath()
}

/** The file view. A missing file with `allowMissing` gives the defaults. */
export function readConfig(allowMissing = false): CliConfig {
  return toCliConfig(readConfigSnapshot(allowMissing).config)
}

/** The effective settings: default, then file, then environment, then option. */
export function resolveCliSettings(layers: {
  readonly allowMissing: boolean
  readonly environment: NativeSettingOverrides
  readonly options: NativeSettingOverrides
}): ResolvedNativeSettings {
  const snapshot = readConfigSnapshot(layers.allowMissing)
  return resolveNativeSettings({
    file: snapshot.revision === null ? null : snapshot.config,
    environment: layers.environment,
    options: layers.options,
  })
}

export function updateConfig(update: (current: CliConfig) => CliConfig): CliConfig {
  const snapshot = updateNativeConfig((current) => ({
    ...current,
    cli: { trustedEngineUrls: update(toCliConfig(current)).trustedEngineUrls },
  }))
  return toCliConfig(snapshot.config)
}

/** `config set` writes the values to the file only. The other layers stay as they are. */
export function writeConfigSettings(values: NativeSettingOverrides): CliConfig {
  return toCliConfig(
    updateNativeConfig((current) => applyNativeSettingOverrides(current, values)).config,
  )
}

/** Validate a write like `writeConfigSettings` without writing it. */
export function validateConfigSettingsWrite(values: NativeSettingOverrides): void {
  const current = readNativeConfig(true).config
  parseNativeConfig(JSON.stringify(applyNativeSettingOverrides(current, values)))
}

function readConfigSnapshot(allowMissing: boolean): NativeConfigSnapshot {
  try {
    return readNativeConfig(allowMissing)
  } catch (error) {
    // Name the layer of an invalid value. The file errors name the key.
    throw new Error(
      `config file ${nativeConfigPath()}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function toCliConfig(config: NativeConfig): CliConfig {
  return {
    engineUrl: config.daemon.engineUrl,
    mintUrl: config.daemon.mintUrl,
    assetMonitoringEnabled: config.daemon.assetMonitoringEnabled,
    trustedEngineUrls: [...config.cli.trustedEngineUrls],
    ...(config.daemon.recoveryIndexRealm === undefined
      ? {}
      : { recoveryIndexRealm: config.daemon.recoveryIndexRealm }),
  }
}
