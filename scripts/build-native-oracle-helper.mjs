import { chmod, copyFile, mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const debugBuild = process.argv.slice(2).join('') === '--debug'
if (process.argv.length > 3 || (process.argv.length === 3 && !debugBuild)) {
  throw new Error('usage: build-native-oracle-helper.mjs [--debug]')
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
const builtBinary = join(targetDirectory, profile, binaryName)
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
process.stdout.write(`Built host native oracle helper for ${process.platform}-${process.arch}.\n`)
