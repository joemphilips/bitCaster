import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildInfoJson,
  checksumLine,
  missingEntryPoints,
  moduleSearchDirs,
  releaseTarget,
  runtimeDependencies,
  selectWorkspaceFiles,
  stagedPackagePath,
  tarOwnerArguments,
} from '../package-cli-release.mjs'

const bounded = { timeout: 10_000 }
const root = '/repo'
const workspaces = [
  { name: '@bitcaster-market/cli', realDir: '/repo/bitcaster-cli' },
  { name: '@bitcaster-market/daemon', realDir: '/repo/bitcaster-daemon' },
  { name: '@cashu/cashu-ts', realDir: '/repo/cashu-ts' },
]

test('a release target is named after the host platform and architecture', bounded, () => {
  assert.equal(releaseTarget('linux', 'x64'), 'linux-x64')
  assert.equal(releaseTarget('darwin', 'arm64'), 'darwin-arm64')
  assert.throws(() => releaseTarget('win32', 'x64'), /Windows/)
})

test('a dependency keeps its install location in the archive', bounded, () => {
  const stage = (realPath) => stagedPackagePath(realPath, { root, workspaces })
  assert.deepEqual(stage('/repo/bitcaster-cli'), {
    path: 'node_modules/@bitcaster-market/cli',
    workspace: '@bitcaster-market/cli',
  })
  assert.deepEqual(stage('/repo/node_modules/nostr-tools'), {
    path: 'node_modules/nostr-tools',
    workspace: null,
  })
  assert.deepEqual(stage('/repo/node_modules/crc/node_modules/buffer'), {
    path: 'node_modules/crc/node_modules/buffer',
    workspace: null,
  })
  assert.deepEqual(stage('/repo/bitcaster-cli/node_modules/commander'), {
    path: 'node_modules/@bitcaster-market/cli/node_modules/commander',
    workspace: null,
  })
  assert.deepEqual(stage('/repo/cashu-ts/node_modules/@noble/hashes'), {
    path: 'node_modules/@cashu/cashu-ts/node_modules/@noble/hashes',
    workspace: null,
  })
})

test('a dependency outside the install tree stops the packaging', bounded, () => {
  const stage = (realPath) => stagedPackagePath(realPath, { root, workspaces })
  assert.throws(() => stage('/elsewhere/node_modules/left-pad'), /outside/)
  assert.throws(() => stage('/repo/bitcaster-cli/src'), /outside/)
  assert.throws(() => stage('/repo/node_modules-copy/x'), /outside/)
})

test('the daemon package keeps only the oracle helper of the release target', bounded, () => {
  const files = [
    'package.json',
    'dist/main.js',
    'native/linux-x64/bitcaster-oracle-helper',
    'native/darwin-arm64/bitcaster-oracle-helper',
  ]
  assert.deepEqual(selectWorkspaceFiles('@bitcaster-market/daemon', files, 'linux-x64'), [
    'package.json',
    'dist/main.js',
    'native/linux-x64/bitcaster-oracle-helper',
  ])
  assert.throws(
    () => selectWorkspaceFiles('@bitcaster-market/daemon', files.slice(0, 2), 'linux-x64'),
    /oracle helper/,
  )
  assert.deepEqual(selectWorkspaceFiles('@bitcaster-market/cli', files.slice(0, 2), 'linux-x64'), [
    'package.json',
    'dist/main.js',
  ])
})

test('an optional peer dependency is not a runtime dependency', bounded, () => {
  const manifest = {
    dependencies: { '@noble/curves': '2.0.1', ws: '8.21.0' },
    optionalDependencies: { bufferutil: '4.0.0' },
    peerDependencies: { typescript: '>=5.0.0', '@noble/hashes': '^2.0.0' },
    peerDependenciesMeta: { typescript: { optional: true } },
    devDependencies: { vitest: '4.0.0' },
  }
  assert.deepEqual(runtimeDependencies(manifest), {
    required: ['@noble/curves', 'ws', '@noble/hashes'],
    optional: ['bufferutil'],
  })
  assert.deepEqual(runtimeDependencies({}), { required: [], optional: [] })
})

test(
  'a package resolves its dependencies like Node, from its directory up to the root',
  bounded,
  () => {
    assert.deepEqual(moduleSearchDirs('/repo/node_modules/@noble/curves', root), [
      '/repo/node_modules/@noble/curves/node_modules',
      '/repo/node_modules/@noble/node_modules',
      '/repo/node_modules',
    ])
    assert.deepEqual(moduleSearchDirs('/repo/bitcaster-cli', root), [
      '/repo/bitcaster-cli/node_modules',
      '/repo/node_modules',
    ])
    assert.deepEqual(moduleSearchDirs('/repo', root), ['/repo/node_modules'])
    assert.throws(() => moduleSearchDirs('/elsewhere/x', root), /outside/)
  },
)

test('an export or bin entry that the package does not publish is reported', bounded, () => {
  const manifest = {
    main: './dist/index.js',
    bin: { 'bitcaster-cli': 'dist/main.js' },
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './tradingClient': './src/tradingClient.ts',
      './protocol': { types: './dist/protocol.d.ts', import: './dist/protocol.js' },
    },
  }
  const files = ['package.json', 'dist/index.js', 'dist/index.d.ts', 'dist/main.js']
  assert.deepEqual(missingEntryPoints(manifest, files), [
    './src/tradingClient.ts',
    './dist/protocol.d.ts',
    './dist/protocol.js',
  ])
  assert.deepEqual(missingEntryPoints({ bin: 'dist/cli.js' }, ['dist/cli.js']), [])
  assert.throws(() => missingEntryPoints({ exports: { './*': './dist/*.js' } }, []), /pattern/)
})

test('the archive records root as the owner for GNU tar and for bsdtar', bounded, () => {
  assert.deepEqual(tarOwnerArguments('tar (GNU tar) 1.35\nCopyright'), [
    '--owner=0',
    '--group=0',
    '--numeric-owner',
  ])
  assert.deepEqual(tarOwnerArguments('bsdtar 3.7.2 - libarchive 3.7.2 zlib/1.2.12'), [
    '--uid',
    '0',
    '--gid',
    '0',
    '--numeric-owner',
  ])
  assert.throws(() => tarOwnerArguments('tar (busybox) 1.36'), /tar/)
})

test('the build information holds only the full lowercase source commit', bounded, () => {
  const commit = '0123456789abcdef0123456789abcdef01234567'
  assert.deepEqual(JSON.parse(buildInfoJson(commit)), { commit })
  assert.throws(() => buildInfoJson(commit.toUpperCase()), /commit/)
  assert.throws(() => buildInfoJson(commit.slice(1)), /commit/)
  assert.throws(() => buildInfoJson(`${commit}\n`), /commit/)
})

test('a checksum line uses the sha256sum text format', bounded, () => {
  assert.equal(
    checksumLine('ab'.repeat(32), 'bitcaster-cli-linux-x64.tar.gz'),
    `${'ab'.repeat(32)}  bitcaster-cli-linux-x64.tar.gz\n`,
  )
})
