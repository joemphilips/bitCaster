import { stdin as input, stdout as output } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { normalizeEndpointUrl } from '@bitcaster-market/client-sdk/engineUrlSecurity'
import {
  isTrustedEngineUrl,
  readNativeConfig,
  untrustedEngineUrlMessage,
} from '@bitcaster-market/daemon/nativeConfig'
import {
  applyNativeSettingOverrides,
  type NativeSettingOverrides,
} from '@bitcaster-market/daemon/nativeConfigLayers'
import { readConfig, updateConfig } from './config.ts'

let trustEngineUrlOption = false
let dryRun = false

/** The global `--trust-engine-url` and `--dry-run` options of this command. */
export function configureEngineUrlTrust(options: {
  readonly trustEngineUrl: boolean
  readonly dryRun: boolean
}): void {
  trustEngineUrlOption = options.trustEngineUrl
  dryRun = options.dryRun
}

export function engineUrlTrustRequested(): boolean {
  return trustEngineUrlOption
}

/**
 * Check the engine URL of a daemon that starts now: the config file with the
 * environment and option settings of this CLI. The daemon refuses the same
 * URLs at its start; this check can ask the user first.
 */
export async function ensureDaemonEngineUrlTrusted(
  overrides: NativeSettingOverrides,
): Promise<void> {
  const config = applyNativeSettingOverrides(readNativeConfig(true).config, overrides)
  if (isTrustedEngineUrl(config)) return
  await trustEngineUrl(config.daemon.engineUrl, 'daemon requests')
}

/** Market creation, attestation and backup deletion need the URL in `trustedEngineUrls`. */
export async function ensureListedEngineUrlTrusted(
  engineUrl: string,
  purpose: string,
): Promise<void> {
  const normalized = normalizeEndpointUrl(engineUrl, 'trusted engine URL')
  if (readConfig().trustedEngineUrls.includes(normalized)) return
  await trustEngineUrl(engineUrl, purpose)
}

/**
 * `--trust-engine-url` or the answer yes trusts the URL and saves it in
 * `trustedEngineUrls`. A dry run checks the trust but does not save it.
 */
async function trustEngineUrl(engineUrl: string, purpose: string): Promise<void> {
  if (!trustEngineUrlOption && !(await confirmEngineUrlTrust(engineUrl, purpose))) {
    refuse(untrustedEngineUrlMessage(engineUrl))
  }
  if (dryRun) return
  const normalized = normalizeEndpointUrl(engineUrl, 'trusted engine URL')
  updateConfig((current) => ({
    ...current,
    trustedEngineUrls: Array.from(new Set([...current.trustedEngineUrls, normalized])),
  }))
}

/** Without a terminal, refuse at once: an agent run never waits for an answer. */
async function confirmEngineUrlTrust(engineUrl: string, purpose: string): Promise<boolean> {
  process.stderr.write(`About to use engine URL for authenticated ${purpose}: ${engineUrl}\n`)
  if (!process.stdin.isTTY) {
    refuse(
      `Refusing to trust a new engine URL without --trust-engine-url in non-interactive mode. ${untrustedEngineUrlMessage(engineUrl)}`,
    )
  }
  const rl = createInterface({ input, output })
  try {
    const answer = await rl.question('Trust this engine URL? Type yes to continue: ')
    return answer.trim().toLowerCase() === 'yes'
  } finally {
    rl.close()
  }
}

/** A refusal is a validation error, exit code 3. No caller can treat it as a transport fault. */
function refuse(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(3)
}
