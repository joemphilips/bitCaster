import assert from 'node:assert/strict'
import { pbkdf2Sync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const sync = require('pbkdf2/lib/sync')
const asyncFallback = require('pbkdf2/lib/async')
const salt = Buffer.from('salt\0binary')

test('fallback preserves native outputs across digest and password boundaries', () => {
  for (const digest of [
    'md5',
    'sha1',
    'sha224',
    'sha256',
    'sha384',
    'sha512',
    'sha512-256',
    'ripemd160',
  ]) {
    for (const length of [0, 63, 64, 65, 127, 128, 129, 1000]) {
      const password = Buffer.alloc(length, 0xa5)
      for (const iterations of [1, 3]) {
        for (const size of [1, 70]) {
          assert.deepEqual(
            sync(password, salt, iterations, size, digest),
            pbkdf2Sync(password, salt, iterations, size, digest),
          )
        }
      }
    }
  }
  assert.equal(
    sync('password', 'salt', 1, 20, 'sha1').toString('hex'),
    '0c60c80f961f0e71f3a9b524af6012062fe037a6',
  )
  for (const [alias, digest] of [
    ['SHA256', 'sha256'],
    ['sha-256', 'sha256'],
    ['rmd160', 'ripemd160'],
  ]) {
    assert.deepEqual(
      sync('日本語\0', salt, 3, 70, alias),
      pbkdf2Sync('日本語\0', salt, 3, 70, digest),
    )
  }
})

test('long passwords reach each HMAC only as a normalized key', () => {
  // Load the actual fallback with an observation-only dependency wrapper.
  // Its public Node export uses native crypto and would not exercise this fix.
  const path = require.resolve('pbkdf2/lib/sync')
  const localRequire = createRequire(path)
  for (const [digest, blockSize] of [
    ['sha256', 64],
    ['sha512', 128],
  ]) {
    const lengths = []
    const actualHmac = localRequire('create-hmac')
    const observedRequire = (name) =>
      name === 'create-hmac'
        ? (algorithm, key) => {
            lengths.push(key.length)
            return actualHmac(algorithm, key)
          }
        : localRequire(name)
    const module = { exports: {} }
    vm.runInThisContext(`(function(require,module,exports){${readFileSync(path, 'utf8')}\n})`)(
      observedRequire,
      module,
      module.exports,
    )
    const password = Buffer.alloc(4096, 0x81)
    assert.deepEqual(
      module.exports(password, salt, 20, 70, digest),
      pbkdf2Sync(password, salt, 20, 70, digest),
    )
    assert.ok(lengths.length > 1)
    assert.ok(
      lengths.every((length) => length <= blockSize),
      `${digest} repeatedly receives the full password`,
    )
  }
})

test('async fallback and actual consumers preserve outputs', async () => {
  for (const name of ['crypto-browserify', 'parse-asn1']) {
    const owner = createRequire(require.resolve(`${name}/package.json`))
    assert.equal(owner('pbkdf2/package.json').version, '3.1.7')
  }
  for (const digest of ['sha256', 'sha512']) {
    const password = Buffer.alloc(1000, 0x93)
    const expected = pbkdf2Sync(password, salt, 3, 70, digest)
    for (const fn of [asyncFallback, require('crypto-browserify').pbkdf2]) {
      const actual = await new Promise((resolve, reject) =>
        fn(password, salt, 3, 70, digest, (error, result) =>
          error ? reject(error) : resolve(result),
        ),
      )
      assert.deepEqual(actual, expected)
    }
    assert.deepEqual(
      require('crypto-browserify').pbkdf2Sync(password, salt, 3, 70, digest),
      expected,
    )
  }
})

test('fallback retains invalid-input rejection and zero output', () => {
  for (const iterations of [-1, NaN, Infinity])
    assert.throws(() => sync('p', salt, iterations, 32, 'sha256'))
  assert.throws(() => sync('p', salt, 1, 32, 'unknown'))
  assert.equal(sync('p', salt, 1, 0, 'sha256').length, 0)
})
