import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

export interface CliConfig {
  engineUrl?: string
  mintUrl?: string
}

export function configFilePath(): string {
  return join(daemonProfileDir(), 'config.json')
}

function daemonProfileDir(): string {
  return process.env.BITCASTER_DAEMON_HOME || join(homedir(), '.bitcaster')
}

export function readConfig(): CliConfig {
  const path = configFilePath()
  if (!existsSync(path)) return {}
  let parsed: unknown
  try {
    const raw = readFileSync(path, 'utf8')
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  const config = sanitizeConfig(parsed)
  try {
    writeConfig(config)
  } catch {
    // Reading should still succeed even when an existing config cannot be rewritten.
  }
  return config
}

export function writeConfig(config: CliConfig): void {
  const path = configFilePath()
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(sanitizeConfig(config), null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

function sanitizeConfig(value: unknown): CliConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const source = value as Record<string, unknown>
  const config: CliConfig = {}
  if (typeof source.engineUrl === 'string') config.engineUrl = source.engineUrl
  if (typeof source.mintUrl === 'string') config.mintUrl = source.mintUrl
  return config
}

export function setConfigValue(key: 'engineUrl' | 'mintUrl', value: string): CliConfig {
  const config = readConfig()
  config[key] = value
  writeConfig(config)
  return config
}

export function resolveEngineUrl(cliFlag?: string): string | undefined {
  return cliFlag || process.env.BITCASTER_ENGINE_URL || readConfig().engineUrl
}

export function resolveMintUrl(cliFlag?: string): string | undefined {
  return cliFlag || process.env.BITCASTER_MINT_URL || readConfig().mintUrl
}
