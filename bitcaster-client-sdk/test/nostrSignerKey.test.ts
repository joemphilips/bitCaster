import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nsecEncode, npubEncode } from 'nostr-tools/nip19'
import { encrypt } from 'nostr-tools/nip49'
import {
  decodePrivateNostrSignerKey,
  generatePrivateNostrSignerKey,
} from '../src/nostrSignerKey.ts'

const secret = new Uint8Array(32)
secret[31] = 1
const hex = `${'0'.repeat(63)}1`
const pubkey = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const nsec = nsecEncode(secret)

test('private signer import normalizes hex, nsec and real ncryptsec without exposing input on failure', () => {
  const passphrase = ' key password '
  for (const [input, password] of [
    [hex, undefined],
    [nsec, undefined],
    [encrypt(secret, passphrase, 4), passphrase],
  ] as const) {
    assert.deepEqual(decodePrivateNostrSignerKey(input, password), {
      secretKeyHex: hex,
      publicKeyHex: pubkey,
      nsec,
    })
  }
})

test('public keys, invalid scalars, oversize keys and incorrect encrypted passwords fail with constant redacted errors', () => {
  const encrypted = encrypt(secret, 'correct', 4)
  for (const value of [
    npubEncode(pubkey),
    '0'.repeat(64),
    'f'.repeat(64),
    'private-invalid-key',
    'x'.repeat(513),
    encrypted,
  ]) {
    assert.throws(() => decodePrivateNostrSignerKey(value, 'wrong'), {
      message: 'Private Nostr key is invalid or could not be decrypted.',
    })
  }
})

test('generated private signer roundtrips through the same public import boundary', () => {
  const generated = generatePrivateNostrSignerKey()
  assert.deepEqual(decodePrivateNostrSignerKey(generated.nsec), generated)
})
