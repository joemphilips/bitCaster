import {
  assertMintSupportsMsat,
  normalizeEndpointUrl,
  readPublicMintMetadata,
  type ReadPublicMintMetadataOptions,
} from '@bitcaster-market/client-sdk'
import { normalizeNostrRelayUrl } from '@bitcaster-market/client-sdk/nostrRelays'
import {
  readNativeConfig,
  updateNativeConfig,
  type NativeConfig,
  type NativeConfigSnapshot,
} from './nativeConfig.ts'

export interface NativeSettingsOptions extends ReadPublicMintMetadataOptions {
  readonly directory?: string
  readonly expectedRevision?: string | null
}

// Settings persist desired startup configuration. They do not rebind live services.
export function listNativeMints(options: NativeSettingsOptions = {}) {
  const snapshot = readSettings(options)
  return {
    mintUrls: [...snapshot.config.daemon.mintUrls],
    selectedMintUrl: snapshot.config.daemon.mintUrl,
    revision: snapshot.revision,
  }
}

export function listNativeRelays(options: NativeSettingsOptions = {}) {
  const snapshot = readSettings(options)
  return { nostrRelays: [...snapshot.config.daemon.nostrRelays], revision: snapshot.revision }
}

export async function addNativeMint(
  value: string,
  options: NativeSettingsOptions = {},
): Promise<NativeConfigSnapshot> {
  const mintUrl = normalizeEndpointUrl(value, 'mint URL')
  const snapshot = readSettings(options)
  assertMintSupportsMsat(await readPublicMintMetadata(mintUrl, { request: options.request }))
  return saveSettings(snapshot, options, (config) => ({
    ...config,
    daemon: {
      ...config.daemon,
      mintUrl,
      mintUrls: [...new Set([...config.daemon.mintUrls, mintUrl])],
    },
  }))
}

export async function selectNativeMint(
  value: string,
  options: NativeSettingsOptions = {},
): Promise<NativeConfigSnapshot> {
  const mintUrl = normalizeEndpointUrl(value, 'mint URL')
  const snapshot = readSettings(options)
  assertSavedMint(snapshot.config, mintUrl)
  assertMintSupportsMsat(await readPublicMintMetadata(mintUrl, { request: options.request }))
  return saveSettings(snapshot, options, (config) => ({
    ...config,
    daemon: { ...config.daemon, mintUrl },
  }))
}

export function removeNativeMint(
  value: string,
  options: NativeSettingsOptions = {},
): NativeConfigSnapshot {
  const mintUrl = normalizeEndpointUrl(value, 'mint URL')
  const snapshot = readSettings(options)
  assertSavedMint(snapshot.config, mintUrl)
  const mintUrls = snapshot.config.daemon.mintUrls.filter((url) => url !== mintUrl)
  if (mintUrls.length === 0) throw new Error('cannot remove the final mint')
  return saveSettings(snapshot, options, (config) => ({
    ...config,
    daemon: {
      ...config.daemon,
      mintUrls,
      mintUrl: config.daemon.mintUrl === mintUrl ? mintUrls[0]! : config.daemon.mintUrl,
    },
  }))
}

export function addNativeRelay(
  value: string,
  options: NativeSettingsOptions = {},
): NativeConfigSnapshot {
  const relay = normalizeNostrRelayUrl(value)
  const snapshot = readSettings(options)
  return saveSettings(snapshot, options, (config) => ({
    ...config,
    daemon: { ...config.daemon, nostrRelays: [...config.daemon.nostrRelays, relay] },
  }))
}

export function removeNativeRelay(
  value: string,
  options: NativeSettingsOptions = {},
): NativeConfigSnapshot {
  const relay = normalizeNostrRelayUrl(value)
  const snapshot = readSettings(options)
  return saveSettings(snapshot, options, (config) => ({
    ...config,
    daemon: {
      ...config.daemon,
      nostrRelays: config.daemon.nostrRelays.filter((url) => url !== relay),
    },
  }))
}

function assertSavedMint(config: NativeConfig, mintUrl: string): void {
  if (!config.daemon.mintUrls.includes(mintUrl)) throw new Error('mint is not in the saved list')
}

function readSettings(options: NativeSettingsOptions): NativeConfigSnapshot {
  const snapshot = readNativeConfig(true, options.directory)
  if (options.expectedRevision !== undefined && snapshot.revision !== options.expectedRevision) {
    throw new Error('native config changed before write')
  }
  return snapshot
}

function saveSettings(
  snapshot: NativeConfigSnapshot,
  options: NativeSettingsOptions,
  update: (config: NativeConfig) => NativeConfig,
): NativeConfigSnapshot {
  return updateNativeConfig(update, {
    directory: options.directory,
    expectedRevision: snapshot.revision,
  })
}
