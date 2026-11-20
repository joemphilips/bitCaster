import {
  DEFAULT_RECOVERY_INDEX_REALM,
  nativeConfigPath,
  parseNativeConfig,
  readNativeConfig,
  updateNativeConfig,
  type NativeConfig,
} from '@bitcaster-market/daemon/nativeConfig'
import { normalizeEndpointUrl } from '@bitcaster-market/client-sdk/engineUrlSecurity'
import type { RecoveryIndexRealm } from '@bitcaster-market/client-sdk/recoveryIndexEngine'

export interface CliConfig {
  engineUrl?: string
  mintUrl?: string
  assetMonitoringEnabled: boolean
  trustedEngineUrls: string[]
  /** Present only after a user sets it. An absent value is the production realm. */
  recoveryIndexRealm?: RecoveryIndexRealm
}

/** The realm that the daemon writer and `wallet backup delete` use. */
export function effectiveRecoveryIndexRealm(config: CliConfig): RecoveryIndexRealm {
  return config.recoveryIndexRealm ?? DEFAULT_RECOVERY_INDEX_REALM
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

/** Validate an update like `updateConfig` without writing it. */
export function validateConfigUpdate(update: (current: CliConfig) => CliConfig): void {
  const current = readNativeConfig(true).config
  parseNativeConfig(JSON.stringify(toNativeConfig(current, update(toCliConfig(current)))))
}

function toNativeConfig(current: NativeConfig, update: CliConfig): NativeConfig {
  const mintUrl =
    update.mintUrl === undefined ? undefined : normalizeEndpointUrl(update.mintUrl, 'mint URL')
  return {
    ...current,
    daemon: {
      ...current.daemon,
      ...(update.engineUrl === undefined ? {} : { engineUrl: update.engineUrl }),
      ...(mintUrl === undefined
        ? {}
        : {
            mintUrl,
            mintUrls: [...new Set([...current.daemon.mintUrls, mintUrl])],
          }),
      assetMonitoringEnabled: update.assetMonitoringEnabled,
      ...(update.recoveryIndexRealm === undefined
        ? {}
        : { recoveryIndexRealm: update.recoveryIndexRealm }),
    },
    cli: { trustedEngineUrls: update.trustedEngineUrls },
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
