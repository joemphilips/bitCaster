import assert from 'node:assert/strict'
import test from 'node:test'
import {
  generateOrderEphemeralKeypair,
  normalizeSecp256k1PrivateKeyHex,
} from '../src/ephemeralKey.ts'

test('normalizeSecp256k1PrivateKeyHex preserves 32-byte scalar width', () => {
  assert.equal(normalizeSecp256k1PrivateKeyHex('1'), `${'0'.repeat(63)}1`)
  assert.equal(
    normalizeSecp256k1PrivateKeyHex('ABCDEF'.padStart(64, '0')),
    'abcdef'.padStart(64, '0'),
  )
})

test('generateOrderEphemeralKeypair stores fixed-width private and compressed public keys', () => {
  for (let i = 0; i < 50; i += 1) {
    const key = generateOrderEphemeralKeypair()
    assert.match(key.privateKeyHex, /^[0-9a-f]{64}$/)
    assert.match(key.publicKeyHex, /^(02|03)[0-9a-f]{64}$/)
  }
})
