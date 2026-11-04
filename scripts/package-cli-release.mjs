// Build a self-contained bitcaster-cli archive for the host platform.
//
// Usage: node scripts/package-cli-release.mjs --out <directory>
//
// Run `npm ci` (or `npm ci --ignore-scripts` and `npm run patch:dependencies`)
// first. The script builds the CLI, the daemon, the client SDK, and the native
// oracle helper. It copies their production dependencies from the installed
// tree, so the root lockfile decides every dependency version. The user needs
// only Node.js to run the archive. The script then extracts the archive in a
// temporary directory and checks it before it prints a JSON summary.
//
// The archive records the source commit in the CLI package, so
// `bitcaster-cli --version` prints, for example, `0.1.0+0123456789ab`.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CLI_PACKAGE = '@bitcaster-market/cli'
const DAEMON_PACKAGE = '@bitcaster-market/daemon'
const HELPER_NAME = 'bitcaster-oracle-helper'
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/
const BIN_NAME_PATTERN = /^[a-z0-9-]+$/
const PACKAGE_NAME_PATTERN = /^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i
const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const BUILD_INFO_FILE = 'build-info.json'
const OUTPUT_BYTES_MAX = 64 * 1024 * 1024
const SOCKET_PATH_BYTES_MAX = 100
const LOOPBACK_HTTP_URL = 'http://127.0.0.1:9'
const LOOPBACK_RELAY_URL = 'ws://127.0.0.1:9'

/** Return the archive target name, for example `linux-x64`. */
export function releaseTarget(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') {
    throw new Error('Windows is not a release target, because order submission does not work there')
  }
  // The daemon accepts the same names when it looks up the oracle helper.
  if (!/^[a-z0-9]+$/.test(platform) || !/^[a-z0-9]+$/.test(arch)) {
    throw new Error(`unsupported release target: ${platform}-${arch}`)
  }
  return `${platform}-${arch}`
}

/**
 * Map an installed package directory to its path in the archive. A workspace
 * package goes to `node_modules/<name>`. A dependency keeps its location below
 * the root or below a workspace, so Node resolves the same versions.
 */
export function stagedPackagePath(realPath, { root, workspaces }) {
  for (const workspace of workspaces) {
    if (realPath === workspace.realDir) {
      return { path: `node_modules/${workspace.name}`, workspace: workspace.name }
    }
  }
  for (const workspace of workspaces) {
    const inner = nodeModulesPath(workspace.realDir, realPath)
    if (inner !== null) return { path: `node_modules/${workspace.name}/${inner}`, workspace: null }
  }
  const inner = nodeModulesPath(root, realPath)
  if (inner !== null) return { path: inner, workspace: null }
  throw new Error(`a dependency is outside the install tree: ${realPath}`)
}

/** Keep the published files. The daemon keeps only the helper for the target. */
export function selectWorkspaceFiles(packageName, files, target) {
  if (packageName !== DAEMON_PACKAGE) return [...files]
  const helper = `native/${target}/${HELPER_NAME}`
  const selected = files.filter((file) => !file.startsWith('native/') || file === helper)
  if (!selected.includes(helper)) {
    throw new Error(
      `the daemon package has no oracle helper for ${target}; run scripts/build-native-oracle-helper.mjs`,
    )
  }
  return selected
}

/**
 * Return the dependencies that Node can load at run time. An optional peer
 * dependency is left out, because a production install does not add it.
 */
export function runtimeDependencies(manifest) {
  const optional = Object.keys(manifest.optionalDependencies ?? {})
  const optionalPeers = new Set(
    Object.entries(manifest.peerDependenciesMeta ?? {})
      .filter(([, meta]) => meta?.optional === true)
      .map(([name]) => name),
  )
  const required = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}).filter((name) => !optionalPeers.has(name)),
  ].filter((name) => !optional.includes(name))
  return { required: [...new Set(required)], optional }
}

/** Return the `node_modules` directories that Node searches, up to the root. */
export function moduleSearchDirs(fromDir, root) {
  const inner = relative(root, fromDir)
  if (inner.startsWith('..') || isAbsolute(inner)) {
    throw new Error(`a package is outside the install tree: ${fromDir}`)
  }
  const dirs = []
  for (let dir = fromDir; ; dir = dirname(dir)) {
    if (basename(dir) !== 'node_modules') dirs.push(join(dir, 'node_modules'))
    if (dir === root) return dirs
  }
}

/**
 * Return each `main`, `bin`, and `exports` target that the package does not
 * publish. Node fails at run time when it loads such an entry point.
 */
export function missingEntryPoints(manifest, files) {
  const published = new Set(files.map(withoutDotSlash))
  const targets = []
  if (typeof manifest.main === 'string') targets.push(manifest.main)
  if (typeof manifest.bin === 'string') targets.push(manifest.bin)
  else targets.push(...Object.values(manifest.bin ?? {}))
  collectExportTargets(manifest.exports, targets)
  return [...new Set(targets)].filter((target) => !published.has(withoutDotSlash(target)))
}

function collectExportTargets(value, targets) {
  if (typeof value === 'string') {
    if (value.includes('*')) throw new Error(`export patterns are not checked: ${value}`)
    targets.push(value)
  } else if (Array.isArray(value)) {
    for (const child of value) collectExportTargets(child, targets)
  } else if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) collectExportTargets(child, targets)
  }
}

function withoutDotSlash(path) {
  return path.startsWith('./') ? path.slice(2) : path
}

/**
 * Return the tar options that record owner 0 and group 0 for every entry. A
 * root user who extracts the archive then does not get files that belong to
 * the account that built it.
 */
export function tarOwnerArguments(versionText) {
  if (versionText.includes('GNU tar')) return ['--owner=0', '--group=0', '--numeric-owner']
  if (versionText.startsWith('bsdtar')) return ['--uid', '0', '--gid', '0', '--numeric-owner']
  throw new Error('packaging needs GNU tar or bsdtar')
}

/** Return the build information that the CLI reads for `--version`. */
export function buildInfoJson(commit) {
  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error(`the source commit is not 40 lowercase hex digits: ${JSON.stringify(commit)}`)
  }
  return `${JSON.stringify({ commit })}\n`
}

export function checksumLine(sha256Hex, fileName) {
  return `${sha256Hex}  ${fileName}\n`
}

function nodeModulesPath(base, path) {
  const inner = relative(base, path)
  if (inner.startsWith('..') || isAbsolute(inner)) return null
  const parts = inner.split(sep)
  if (parts[0] !== 'node_modules' || parts.length < 2) return null
  return parts.join('/')
}

async function main(argv) {
  const out = parseArguments(argv)
  const root = await realpath(fileURLToPath(new URL('../', import.meta.url)))
  const target = releaseTarget()
  const name = `bitcaster-cli-${target}`
  const cliManifest = JSON.parse(
    await readFile(join(root, 'bitcaster-cli', 'package.json'), 'utf8'),
  )
  const version = cliManifest.version
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    throw new Error(`the CLI package version is not a release version: ${String(version)}`)
  }
  const commit = sourceCommit(root)
  const versionText = `${version}+${commit.slice(0, 12)}`

  log('Build the client SDK, the daemon, and the CLI.')
  run('npm', ['run', 'build', '--workspace', CLI_PACKAGE], { cwd: root })
  log('Build the native oracle helper.')
  run(process.execPath, [join(root, 'scripts', 'build-native-oracle-helper.mjs')], { cwd: root })

  const workspaces = await readWorkspaces(root)
  const cli = workspaces.find((workspace) => workspace.name === CLI_PACKAGE)
  if (cli === undefined) throw new Error('the root package has no CLI workspace')
  const closure = await productionClosure(root, cli.realDir)
  // A short prefix keeps the daemon socket path in the check below the Unix limit.
  const temp = await mkdtemp(join(tmpdir(), 'bcli-'))
  try {
    const stageDir = join(temp, 's', name)
    log(`Stage ${closure.length} packages.`)
    await stagePackages({ root, workspaces, closure, stageDir, target })
    await linkBins(stageDir, cliManifest)
    await writeFile(
      join(stageDir, 'node_modules', ...CLI_PACKAGE.split('/'), BUILD_INFO_FILE),
      buildInfoJson(commit),
      { mode: 0o644 },
    )

    await mkdir(out, { recursive: true })
    const archiveName = `${name}.tar.gz`
    const archive = join(out, archiveName)
    await rm(archive, { force: true })
    const owner = tarOwnerArguments(run('tar', ['--version'], { capture: true }))
    // COPYFILE_DISABLE stops macOS tar from adding AppleDouble files.
    run('tar', [...owner, '-czf', archive, '-C', dirname(stageDir), name], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    })
    const sha256 = await sha256File(archive)
    await writeFile(`${archive}.sha256`, checksumLine(sha256, archiveName))

    log('Check the extracted archive.')
    await verifyArchive({ archive, name, versionText, target, temp })
    process.stdout.write(
      `${JSON.stringify({ version, commit, versionText, target, archive, sha256 })}\n`,
    )
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

function sourceCommit(root) {
  const commit = run('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd: root,
    capture: true,
  }).trim()
  const changes = run(
    'git',
    ['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=untracked'],
    { cwd: root, capture: true },
  )
  if (changes.trim().length > 0) {
    log(`Warning: tracked files differ from ${commit}, so the commit does not identify the source.`)
  }
  return commit
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== '--out' || argv[1].length === 0) {
    throw new Error('usage: package-cli-release.mjs --out <directory>')
  }
  return resolve(argv[1])
}

async function readWorkspaces(root) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  return Promise.all(
    manifest.workspaces.map(async (directory) => {
      const realDir = await realpath(join(root, directory))
      const workspace = JSON.parse(await readFile(join(realDir, 'package.json'), 'utf8'))
      return { name: workspace.name, realDir }
    }),
  )
}

/** Return the real directory of every package that the CLI can load at run time. */
async function productionClosure(root, start) {
  const packages = new Set()
  const pending = [start]
  while (pending.length > 0) {
    const dir = pending.pop()
    if (packages.has(dir)) continue
    packages.add(dir)
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    const { required, optional } = runtimeDependencies(manifest)
    for (const name of required) pending.push(await resolvePackage(name, dir, root))
    for (const name of optional) {
      const found = await resolvePackage(name, dir, root, { optional: true })
      if (found !== null) pending.push(found)
    }
  }
  return [...packages].sort()
}

async function resolvePackage(name, fromDir, root, { optional = false } = {}) {
  if (!PACKAGE_NAME_PATTERN.test(name)) throw new Error(`unsafe package name: ${name}`)
  for (const dir of moduleSearchDirs(fromDir, root)) {
    const candidate = join(dir, ...name.split('/'))
    try {
      await access(join(candidate, 'package.json'))
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue
      throw error
    }
    return realpath(candidate)
  }
  if (optional) return null
  throw new Error(`${fromDir} needs ${name}, but it is not installed; run npm ci`)
}

async function stagePackages({ root, workspaces, closure, stageDir, target }) {
  const staged = closure.map((real) => ({ real, ...stagedPackagePath(real, { root, workspaces }) }))
  const packFiles = publishedFiles(
    root,
    staged.filter((entry) => entry.workspace !== null).map((entry) => entry.workspace),
  )
  if (!staged.some((entry) => entry.workspace === CLI_PACKAGE)) {
    throw new Error('the dependency tree does not contain the CLI package')
  }
  for (const entry of staged) {
    const destination = join(stageDir, ...entry.path.split('/'))
    if (entry.workspace === null) {
      await copyPackageTree(entry.real, destination, true)
      continue
    }
    const files = selectWorkspaceFiles(entry.workspace, packFiles.get(entry.workspace), target)
    const manifest = JSON.parse(await readFile(join(entry.real, 'package.json'), 'utf8'))
    const missing = missingEntryPoints(manifest, files)
    if (missing.length > 0) {
      throw new Error(`${entry.workspace} does not publish its entry points: ${missing.join(', ')}`)
    }
    for (const file of files) {
      await copyRegularFile(join(entry.real, file), join(destination, file))
    }
  }
}

/** List the files that `npm pack` would publish for each workspace. */
function publishedFiles(root, names) {
  const output = run(
    'npm',
    [
      'pack',
      '--dry-run',
      '--json',
      '--ignore-scripts',
      ...names.flatMap((name) => ['--workspace', name]),
    ],
    { cwd: root, capture: true },
  )
  const files = new Map()
  for (const entry of JSON.parse(output)) {
    files.set(
      entry.name,
      entry.files.map((file) => file.path),
    )
  }
  for (const name of names) {
    if (!files.has(name)) throw new Error(`npm pack did not list the files of ${name}`)
  }
  return files
}

async function copyPackageTree(source, destination, packageRoot) {
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    // Nested dependencies are separate closure entries.
    if (packageRoot && entry.name === 'node_modules') continue
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.isDirectory()) await copyPackageTree(from, to, false)
    else if (entry.isFile()) await copyRegularFile(from, to)
    else throw new Error(`a dependency contains a link or a special file: ${from}`)
  }
}

async function copyRegularFile(from, to) {
  const stats = await lstat(from)
  if (!stats.isFile()) throw new Error(`a published path is not a regular file: ${from}`)
  await mkdir(dirname(to), { recursive: true })
  await copyFile(from, to)
  await chmod(to, stats.mode & 0o111 ? 0o755 : 0o644)
}

async function linkBins(stageDir, cliManifest) {
  const binDir = join(stageDir, 'bin')
  await mkdir(binDir, { recursive: true })
  for (const [binName, binPath] of Object.entries(cliManifest.bin ?? {})) {
    if (!BIN_NAME_PATTERN.test(binName)) throw new Error(`unsafe CLI bin name: ${binName}`)
    const inner = relative('.', binPath)
    if (inner.startsWith('..') || isAbsolute(inner))
      throw new Error(`unsafe CLI bin path: ${binPath}`)
    const targetPath = join(stageDir, 'node_modules', ...CLI_PACKAGE.split('/'), inner)
    await chmod(targetPath, 0o755)
    // A relative link keeps the archive movable. Node follows the link to the
    // real file, so the CLI resolves its dependencies from the archive.
    await symlink(relative(binDir, targetPath), join(binDir, binName))
  }
}

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function verifyArchive({ archive, name, versionText, target, temp }) {
  const extractDir = join(temp, 'x')
  const home = join(temp, 'h')
  const dataDir = join(temp, 'd')
  await mkdir(extractDir)
  await mkdir(home)
  // macOS limits a Unix socket path to 104 bytes.
  if (Buffer.byteLength(join(dataDir, 'daemon.sock')) > SOCKET_PATH_BYTES_MAX) {
    throw new Error('the temporary directory path is too long; set TMPDIR to a shorter path')
  }
  run('tar', ['-xzf', archive, '-C', extractDir])
  const packageDir = join(extractDir, name)
  // A minimal environment keeps the user's real profile and settings out.
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    LANG: 'C',
    NODE_NO_WARNINGS: '1',
    ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
  }
  const cli = (args) =>
    run(join(packageDir, 'bin', 'bitcaster-cli'), ['--datadir', dataDir, ...args], {
      cwd: extractDir,
      env,
      capture: true,
    })

  expect(
    cli(['--version']).trim() === versionText,
    `bitcaster-cli --version does not print ${versionText}`,
  )
  for (const bin of ['bitcaster-cli', 'bitcaster']) {
    const help = run(join(packageDir, 'bin', bin), ['--help'], { env, capture: true })
    expect(help.includes('Usage: bitcaster-cli'), `${bin} --help does not print the usage`)
  }

  // Every endpoint is a closed loopback port, so the daemon contacts no service.
  cli(['config', 'set', '--engine-url', LOOPBACK_HTTP_URL, '--mint-url', LOOPBACK_HTTP_URL])
  const config = JSON.parse(cli(['config', 'list']))
  expect(config.engineUrl === LOOPBACK_HTTP_URL, 'bitcaster-cli config set did not save the URL')
  cli(['relay', 'add', LOOPBACK_RELAY_URL])
  for (const relay of JSON.parse(cli(['relay', 'list'])).nostrRelays) {
    if (relay !== LOOPBACK_RELAY_URL) cli(['relay', 'remove', relay])
  }

  const preview = JSON.parse(
    cli(['--dry-run', 'wallet', 'invoice', 'create', '--amount-msat', '1000']),
  )
  expect(preview.dryRun === true, 'bitcaster-cli --dry-run does not print a preview')
  expect(
    !(await readdir(dataDir)).includes('daemon-autostart.pid'),
    'bitcaster-cli --dry-run started the daemon',
  )

  cli(['daemon', 'init'])
  try {
    // The CLI starts the daemon when a command needs it.
    const health = JSON.parse(cli(['health']))
    expect(health.ok === true, 'the CLI did not start the daemon')
  } finally {
    stopDaemon(cli)
  }

  await verifyOracleHelper({ packageDir, target, extractDir, env })
}

async function verifyOracleHelper({ packageDir, target, extractDir, env }) {
  const daemonDir = join(packageDir, 'node_modules', ...DAEMON_PACKAGE.split('/'))
  const helper = join(daemonDir, 'native', target, HELPER_NAME)
  // An empty request proves that the helper runs on this platform.
  const probe = spawnSync(helper, [], { input: '', encoding: 'utf8', env })
  expect(
    probe.status === 1,
    `the oracle helper did not run: ${probe.error?.message ?? probe.status}`,
  )
  const response = JSON.parse(probe.stdout)
  expect(
    response.ok === false && response.code === 'invalid-request',
    'the oracle helper did not reject an empty request',
  )

  // The daemon must find the helper inside the archive.
  const lookup = pathToFileURL(join(daemonDir, 'dist', 'nativeOracleHelper.js')).href
  const resolved = run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      'const helper = await import(process.argv[1]); helper.assertNativeOracleHelperAvailable(); process.stdout.write(helper.resolveNativeOracleHelperPath())',
      lookup,
    ],
    { cwd: extractDir, env, capture: true },
  )
  expect(
    (await realpath(resolved)) === (await realpath(helper)),
    'the daemon does not find the oracle helper',
  )
}

function stopDaemon(cli) {
  try {
    cli(['daemon', 'stop'])
  } catch (error) {
    // Report the failure but keep the first error of the check.
    log(`The daemon did not stop: ${error.message}`)
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(`archive check failed: ${message}`)
}

function run(command, args, { cwd, env, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: OUTPUT_BYTES_MAX,
    shell: false,
    // Build output goes to standard error, so standard output holds only the summary.
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 2, 2],
  })
  if (result.error) throw new Error(`${command} did not start: ${result.error.message}`)
  if (result.status !== 0) {
    const detail = capture ? `\n${result.stdout}${result.stderr}` : ''
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}${detail}`)
  }
  return result.stdout ?? ''
}

function log(message) {
  process.stderr.write(`package-cli-release: ${message}\n`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2))
}
