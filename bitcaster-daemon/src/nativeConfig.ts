import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { dataDir } from './dataDir.ts'
import { normalizeEndpointUrl } from './endpoint.ts'

export const NATIVE_CONFIG_VERSION = 1
export const DEFAULT_ENGINE_URL = 'http://localhost:5000'
export const DEFAULT_MINT_URL = 'http://localhost:8085'
const MAX_CONFIG_BYTES = 64 * 1_024
let startupConfig: NativeConfigSnapshot | undefined

export interface NativeConfig {
  readonly version: 1
  readonly daemon: {
    readonly engineUrl: string
    readonly mintUrl: string
    readonly autoRetireResolvedConditionInventory: boolean
  }
  readonly cli: {
    readonly trustedEngineUrls: readonly string[]
  }
}

export interface NativeConfigSnapshot {
  readonly config: NativeConfig
  readonly revision: string | null
}

export interface NativeConfigCreation {
  readonly snapshot: NativeConfigSnapshot
  readonly created: boolean
}

export function nativeConfigPath(directory = dataDir()): string {
  return join(directory, 'config.json')
}

export function assertNativeConfigSourceAdmissible(directory = dataDir()): void {
  assertLegacyCliConfigAbsent(directory)
}

export function defaultNativeConfig(): NativeConfig {
  return {
    version: NATIVE_CONFIG_VERSION,
    daemon: {
      engineUrl: DEFAULT_ENGINE_URL,
      mintUrl: DEFAULT_MINT_URL,
      autoRetireResolvedConditionInventory: false,
    },
    cli: { trustedEngineUrls: [] },
  }
}

export function readNativeConfig(
  allowMissing = false,
  directory = dataDir(),
): NativeConfigSnapshot {
  return readNativeConfigFile(allowMissing, directory)
}

export function freezeNativeConfigAtStartup(): NativeConfigSnapshot {
  startupConfig ??= readNativeConfigFile(false, dataDir())
  return startupConfig
}

export function activeNativeConfig(): NativeConfigSnapshot {
  return startupConfig ?? readNativeConfigFile(false, dataDir())
}

function readNativeConfigFile(allowMissing: boolean, directory: string): NativeConfigSnapshot {
  assertAdmissibleConfigDirectory(directory, allowMissing)
  const path = nativeConfigPath(directory)
  const raw = readBoundedConfig(path, allowMissing)
  if (raw === null) {
    return { config: defaultNativeConfig(), revision: null }
  }
  return { config: parseNativeConfig(raw), revision: digest(raw) }
}

export function updateNativeConfig(
  update: (current: NativeConfig) => NativeConfig,
): NativeConfigSnapshot {
  const directory = dataDir()
  return withConfigWriteLock(directory, () => {
    const current = readNativeConfig(true, directory)
    const config = parseNativeConfig(JSON.stringify(update(current.config)))
    writeNativeConfig(config, current.revision, directory)
    return readNativeConfig(false, directory)
  })
}

export function createNativeConfig(
  config: NativeConfig,
  directory = dataDir(),
): NativeConfigSnapshot {
  return ensureNativeConfig(config, directory).snapshot
}

export function ensureNativeConfig(
  config: NativeConfig,
  directory = dataDir(),
): NativeConfigCreation {
  const validated = parseNativeConfig(JSON.stringify(config))
  return withConfigWriteLock(directory, () => {
    const current = readNativeConfig(true, directory)
    if (current.revision !== null) return { snapshot: current, created: false }
    writeNativeConfig(validated, null, directory)
    return { snapshot: readNativeConfig(false, directory), created: true }
  })
}

export function removeNativeConfigIfRevisionMatches(revision: string, directory = dataDir()): void {
  withConfigWriteLock(directory, () => {
    const current = readNativeConfig(true, directory)
    if (current.revision === revision) rmSync(nativeConfigPath(directory))
  })
}

export function parseNativeConfig(raw: string): NativeConfig {
  assertNoDuplicateKeys(raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('native config is not valid JSON')
  }
  const root = strictObject(parsed, ['version', 'daemon', 'cli'], 'config')
  if (root.version !== NATIVE_CONFIG_VERSION) {
    throw new Error('native config version is not supported')
  }
  const daemon = strictObject(
    root.daemon,
    ['engineUrl', 'mintUrl', 'autoRetireResolvedConditionInventory'],
    'config.daemon',
  )
  const cli = strictObject(root.cli, ['trustedEngineUrls'], 'config.cli')
  if (typeof daemon.autoRetireResolvedConditionInventory !== 'boolean') {
    throw new Error('config.daemon.autoRetireResolvedConditionInventory must be boolean')
  }
  if (!Array.isArray(cli.trustedEngineUrls)) {
    throw new Error('config.cli.trustedEngineUrls must be an array')
  }
  const trustedEngineUrls = cli.trustedEngineUrls.map((value) => {
    if (typeof value !== 'string') {
      throw new Error('config.cli.trustedEngineUrls must contain only strings')
    }
    return normalizeEndpointUrl(value, 'trusted engine URL')
  })
  if (new Set(trustedEngineUrls).size !== trustedEngineUrls.length) {
    throw new Error('config.cli.trustedEngineUrls must not contain duplicates')
  }
  if (typeof daemon.engineUrl !== 'string' || typeof daemon.mintUrl !== 'string') {
    throw new Error('config daemon endpoints must be strings')
  }
  return {
    version: NATIVE_CONFIG_VERSION,
    daemon: {
      engineUrl: normalizeEndpointUrl(daemon.engineUrl, 'engine URL'),
      mintUrl: normalizeEndpointUrl(daemon.mintUrl, 'mint URL'),
      autoRetireResolvedConditionInventory: daemon.autoRetireResolvedConditionInventory,
    },
    cli: { trustedEngineUrls },
  }
}

function writeNativeConfig(
  config: NativeConfig,
  expectedRevision: string | null,
  directory: string,
): void {
  ensureOwnerOnlyDataDir(directory)
  const current = readNativeConfig(true, directory)
  if (current.revision !== expectedRevision) {
    throw new Error('native config changed before write')
  }
  const path = nativeConfigPath(directory)
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  const text = `${JSON.stringify(config, null, 2)}\n`
  let fd: number | undefined
  try {
    fd = openSync(
      temp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    )
    writeFileSync(fd, text)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, path)
    const dirFd = openSync(dirname(path), constants.O_RDONLY)
    try {
      fsyncSync(dirFd)
    } finally {
      closeSync(dirFd)
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(temp, { force: true })
  }
}

function withConfigWriteLock<T>(directory: string, action: () => T): T {
  ensureOwnerOnlyDataDir(directory)
  const lockPath = join(directory, '.config.lock')
  const fd = openSync(
    lockPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o600,
  )
  try {
    return action()
  } finally {
    closeSync(fd)
    rmSync(lockPath, { force: true })
  }
}

function ensureOwnerOnlyDataDir(directory: string): void {
  assertLegacyCliConfigAbsent(directory)
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 })
  assertOwnerOnlyDataDir(directory)
}

function assertAdmissibleConfigDirectory(directory: string, allowMissing: boolean): void {
  assertLegacyCliConfigAbsent(directory)
  if (!existsSync(directory)) {
    if (allowMissing) return
    throw new Error('native config is missing')
  }
  assertOwnerOnlyDataDir(directory)
}

function assertOwnerOnlyDataDir(directory: string): void {
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('data directory must be a plain directory')
  }
  if (
    process.platform !== 'win32' &&
    ((stat.mode & 0o777) !== 0o700 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()))
  ) {
    throw new Error('data directory must not be accessible by group or other users')
  }
}

function assertLegacyCliConfigAbsent(directory: string): void {
  const defaultDirectory = join(homedir(), '.bitcaster')
  if (directory !== defaultDirectory) return
  if (existsSync(join(homedir(), '.bitcaster-cli'))) {
    throw new Error('legacy ~/.bitcaster-cli configuration must be removed before use')
  }
}

function assertOwnerOnlyPlainFile(stat: Stats): void {
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('native config must be a plain file')
  if (stat.size > MAX_CONFIG_BYTES) throw new Error('native config exceeds 64 KiB')
  if (
    process.platform !== 'win32' &&
    ((stat.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()))
  ) {
    throw new Error('native config must not be accessible by group or other users')
  }
}

function readBoundedConfig(path: string, allowMissing: boolean): string | null {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if (isFileSystemError(error, 'ENOENT')) {
      if (allowMissing) return null
      throw new Error('native config is missing')
    }
    if (isFileSystemError(error, 'ELOOP')) throw new Error('native config must be a plain file')
    throw error
  }
  try {
    assertOwnerOnlyPlainFile(fstatSync(fd))
    const raw = readFileSync(fd)
    if (raw.byteLength > MAX_CONFIG_BYTES) throw new Error('native config exceeds 64 KiB')
    return raw.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function strictObject(
  value: unknown,
  keys: readonly string[],
  name: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  const object = value as Record<string, unknown>
  const actual = Object.keys(object)
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new Error(`${name} has missing or unknown keys`)
  }
  return object
}

function assertNoDuplicateKeys(raw: string): void {
  const stack: Array<Set<string> | null> = []
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]
    if (character === '{') stack.push(new Set())
    else if (character === '[') stack.push(null)
    else if (character === '}' || character === ']') stack.pop()
    else if (character === '"') index = inspectStringToken(raw, index, stack)
  }
}

function inspectStringToken(raw: string, start: number, stack: Array<Set<string> | null>): number {
  let end = start + 1
  for (; end < raw.length; end += 1) {
    if (raw[end] === '\\') end += 1
    else if (raw[end] === '"') break
  }
  if (end >= raw.length) return raw.length
  let next = end + 1
  while (/\s/.test(raw[next] ?? '')) next += 1
  const keys = stack.at(-1)
  if (raw[next] === ':' && keys !== null && keys !== undefined) {
    const key = JSON.parse(raw.slice(start, end + 1)) as string
    if (keys.has(key)) throw new Error(`native config contains duplicate key: ${key}`)
    keys.add(key)
  }
  return end
}

function digest(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}
