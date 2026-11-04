import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const bash = '/bin/bash'
const rg = spawnSync(bash, ['-c', 'command -v rg'], { encoding: 'utf8' }).stdout.trim()
assert.ok(rg, 'Install ripgrep before running the boundary-check tests')

for (const [name, violation] of [
  ['identity', 'loginWithExtension()'],
  ['wallet', 'wallet.setActiveMint("https://mint.example")'],
]) {
  function check(t, source, search = 'real') {
    const fixture = mkdtempSync(resolve(tmpdir(), 'bitcaster-boundary-check-'))
    t.after(() => rmSync(fixture, { recursive: true, force: true }))
    mkdirSync(resolve(fixture, 'scripts'))
    mkdirSync(resolve(fixture, 'src'))
    mkdirSync(resolve(fixture, 'bin'))
    const script = `check-${name}-ops-boundary.sh`
    copyFileSync(
      resolve(root, 'bitCaster-app/scripts', script),
      resolve(fixture, 'scripts', script),
    )
    writeFileSync(resolve(fixture, 'src/consumer.ts'), source)
    symlinkSync('/usr/bin/dirname', resolve(fixture, 'bin/dirname'))
    if (search === 'real') symlinkSync(rg, resolve(fixture, 'bin/rg'))
    if (search === 'error') {
      writeFileSync(resolve(fixture, 'bin/rg'), '#!/bin/sh\nexit 2\n', { mode: 0o755 })
    }
    return spawnSync(bash, [resolve(fixture, 'scripts', script)], {
      env: { ...process.env, PATH: resolve(fixture, 'bin') },
      encoding: 'utf8',
      timeout: 10_000,
    })
  }

  test(`${name} boundary accepts a source with no forbidden operation`, (t) => {
    const result = check(t, 'const value = 1')
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /boundary gate: clean/)
  })

  test(`${name} boundary rejects a forbidden operation`, (t) => {
    const result = check(t, violation)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stdout, /boundary violation/)
    assert.doesNotMatch(result.stdout, /boundary gate: clean/)
  })

  test(`${name} boundary fails when ripgrep is missing`, (t) => {
    const result = check(t, violation, 'missing')
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(result.stdout, /boundary gate: clean/)
  })

  test(`${name} boundary fails when the source search fails`, (t) => {
    const result = check(t, violation, 'error')
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(result.stdout, /boundary gate: clean/)
  })
}
