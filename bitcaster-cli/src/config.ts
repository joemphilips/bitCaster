import {
  nativeConfigPath,
  readNativeConfig,
  updateNativeConfig,
  type NativeConfig,
} from '@bitcaster-market/daemon/nativeConfig'

export interface CliConfig {
  engineUrl?: string
  mintUrl?: string
  trustedEngineUrls: string[]
}

export function configFilePath(): string {
  return nativeConfigPath()
}

export function readConfig(allowMissing = false): CliConfig {
  return toCliConfig(readNativeConfig(allowMissing).config)
}

export function updateConfig(update: (current: CliConfig) => CliConfig): CliConfig {
  const snapshot = updateNativeConfig((current) =>
    toNativeConfig(current, update(toCliConfig(current))),
  )
  return toCliConfig(snapshot.config)
}

function toNativeConfig(current: NativeConfig, update: CliConfig): NativeConfig {
  return {
    ...current,
    daemon: {
      ...current.daemon,
      ...(update.engineUrl === undefined ? {} : { engineUrl: update.engineUrl }),
      ...(update.mintUrl === undefined ? {} : { mintUrl: update.mintUrl }),
    },
    cli: { trustedEngineUrls: update.trustedEngineUrls },
  }
}

function toCliConfig(config: NativeConfig): CliConfig {
  return {
    engineUrl: config.daemon.engineUrl,
    mintUrl: config.daemon.mintUrl,
    trustedEngineUrls: [...config.cli.trustedEngineUrls],
  }
}
