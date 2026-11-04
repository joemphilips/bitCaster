import { chmod, copyFile, mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// --target selects a Rust target triple for the host platform, for example a
// static musl target, so that a release helper does not need one glibc version.
const usage = 'usage: build-native-oracle-helper.mjs [--debug] [--target <rust-target>]'
const options = process.argv.slice(2)
let debugBuild = false
let rustTarget = null
while (options.length > 0) {
  const option = options.shift()
  if (option === '--debug' && !debugBuild) debugBuild = true
  else if (option === '--target' && rustTarget === null && options.length > 0) {
    rustTarget = options.shift()
    if (!/^[a-z0-9_]+(-[a-z0-9_]+){2,3}$/.test(rustTarget)) throw new Error(usage)
  } else throw new Error(usage)
}
if (process.platform === 'win32') {
  throw new Error('native oracle helper builds are unsupported on this platform')
}

const bitCasterRoot = fileURLToPath(new URL('../', import.meta.url))
const daemonRoot = join(bitCasterRoot, 'bitcaster-daemon')
const targetDirectory = join(bitCasterRoot, 'dlcdevkit', 'target')
const manifestPath = join(daemonRoot, 'native-oracle-helper', 'Cargo.toml')
const profile = debugBuild ? 'debug' : 'release'
const binaryName = 'bitcaster-oracle-helper'
const builtBinary =
  rustTarget === null
    ? join(targetDirectory, profile, binaryName)
    : join(targetDirectory, rustTarget, profile, binaryName)
const nativeDirectory = join(daemonRoot, 'native', `${process.platform}-${process.arch}`)
const packagedBinary = join(nativeDirectory, binaryName)

const cargoArguments = [
  'build',
  '--locked',
  '-j',
  '2',
  '--manifest-path',
  manifestPath,
  '--target-dir',
  targetDirectory,
]
if (!debugBuild) cargoArguments.push('--release')
if (rustTarget !== null) cargoArguments.push('--target', rustTarget)

const result = spawnSync('cargo', cargoArguments, {
  cwd: bitCasterRoot,
  stdio: 'inherit',
  shell: false,
})
if (result.error) throw new Error('native oracle helper build failed')
if (result.status !== 0) throw new Error('native oracle helper build failed')

await mkdir(nativeDirectory, { recursive: true })
await copyFile(builtBinary, packagedBinary)
await chmod(packagedBinary, 0o755)
process.stdout.write(
  `Built native oracle helper for ${process.platform}-${process.arch}` +
    `${rustTarget === null ? '' : ` with Rust target ${rustTarget}`}.\n`,
)
