import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { cliVersion, readCliVersion } from '../src/version.ts'

const execFileAsync = promisify(execFile)
const COMMIT = '0123456789abcdef0123456789abcdef01234567'

test('a source build prints the package version only', () => {
  assert.equal(cliVersion('0.1.0', null), '0.1.0')
})

test('a release build adds the first 12 hex digits of the source commit', () => {
  assert.equal(cliVersion('0.1.0', JSON.stringify({ commit: COMMIT })), '0.1.0+0123456789ab')
})

test('invalid build information stops the CLI instead of printing a false commit', () => {
  for (const text of [
    '{',
    '[]',
    'null',
    JSON.stringify({}),
    JSON.stringify({ commit: COMMIT.toUpperCase() }),
    JSON.stringify({ commit: COMMIT.slice(1) }),
    JSON.stringify({ commit: COMMIT, dirty: true }),
  ]) {
    assert.throws(() => cliVersion('0.1.0', text), /build-info\.json/, text)
  }
})

test('the version comes from the package directory and its optional build information', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bitcaster-cli-version-'))
  try {
    const root = pathToFileURL(`${dir}/`)
    await writeFile(join(dir, 'package.json'), JSON.stringify({ version: '1.2.3' }))
    assert.equal(readCliVersion(root), '1.2.3')
    await writeFile(join(dir, 'build-info.json'), JSON.stringify({ commit: COMMIT }))
    assert.equal(readCliVersion(root), '1.2.3+0123456789ab')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('bitcaster-cli --version prints the plain package version in the source tree', async () => {
  const manifest = JSON.parse(
    await readFile(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
  ) as { version: string }
  const result = await execFileAsync(
    process.execPath,
    ['--experimental-strip-types', join(import.meta.dirname, '..', 'src', 'main.ts'), '--version'],
    { env: { ...process.env, NODE_NO_WARNINGS: '1' } },
  )
  assert.equal(result.stdout.trim(), manifest.version)
})
