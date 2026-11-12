import assert from 'node:assert/strict'
import { test } from 'node:test'
import { v2 as nip44 } from 'nostr-tools/nip44'
import {
  inspectOracleBackupLifecycleCapacity,
  assertOracleBackupLifecycleCapacity,
  OracleBackupCapacityError,
  type OracleBackupLifecycleCapacityInput,
} from '../src/oracleBackupCapacity.ts'

const destinations = {
  mintUrl: 'https://mint.bitcaster.cash',
  engineUrl: 'https://api.bitcaster.market',
  relayUrls: [
    'wss://nos.lol',
    'wss://nostr.bitcoiner.social',
    'wss://relay.primal.net',
    'wss://relay.nostr.net',
    'wss://relay.damus.io',
    'wss://purplepag.es',
  ],
}
const base: OracleBackupLifecycleCapacityInput = {
  title: 'Title',
  description: 'Description',
  eventId: 'a'.repeat(64),
  outcomes: Array.from({ length: 8 }, (_, index) => 'A'.repeat(190) + index),
  destinations,
  writeVersion: 1,
}

test('existing admitted quote text reserves its full future explanation and refuses overflow', () => {
  const input = { ...base, title: '"'.repeat(100), description: '"'.repeat(1024) }
  const capacity = inspectOracleBackupLifecycleCapacity(input)
  assert.ok(capacity.requiredPlaintextBytes > 65_535)
  assert.equal(capacity.fits, false)
  assert.throws(() => assertOracleBackupLifecycleCapacity(input), OracleBackupCapacityError)
  assert.equal(inspectOracleBackupLifecycleCapacity({ ...input, writeVersion: 2 }).fits, true)
})

test('normal destinations support proposed field maxima and full future explanation in compact wire', () => {
  for (const character of ['a', '界', '😀', '"', '\\', '\u0000', '\n']) {
    const capacity = assertOracleBackupLifecycleCapacity({
      ...base,
      writeVersion: 2,
      title: character.repeat(200),
      description: character.repeat(2000),
    })
    assert.ok(capacity.requiredPlaintextBytes < 65_535)
    assert.ok(capacity.requiredEncryptedPayloadChars <= 87_472)
  }
})

test('aggregate destinations use exact JSON bytes and the plaintext/encrypted boundaries', () => {
  const relayUrls: string[] = []
  const input = { ...base, writeVersion: 2 as const, destinations: { ...destinations, relayUrls } }
  for (;;) {
    const candidate = `wss://relay${relayUrls.length}.example/${'a'.repeat(128)}`
    relayUrls.push(candidate)
    if (inspectOracleBackupLifecycleCapacity(input).requiredPlaintextBytes > 65_000) break
  }
  const remainder = 65_535 - inspectOracleBackupLifecycleCapacity(input).requiredPlaintextBytes
  assert.ok(remainder >= 0)
  relayUrls[relayUrls.length - 1] += 'a'.repeat(remainder)
  const atLimit = assertOracleBackupLifecycleCapacity(input)
  assert.equal(atLimit.requiredPlaintextBytes, 65_535)
  assert.equal(atLimit.requiredEncryptedPayloadChars, 87_472)
  const ciphertext = nip44.encrypt(
    'a'.repeat(65_535),
    new Uint8Array(32).fill(1),
    new Uint8Array(32).fill(2),
  )
  assert.equal(ciphertext.length, atLimit.requiredEncryptedPayloadChars)
  relayUrls[relayUrls.length - 1] += 'a'
  assert.equal(inspectOracleBackupLifecycleCapacity(input).requiredPlaintextBytes, 65_536)
  assert.throws(() => assertOracleBackupLifecycleCapacity(input), OracleBackupCapacityError)
})

test('event identifiers account for BigSize transitions and escaped Unicode without assuming a browser slug', () => {
  const small = inspectOracleBackupLifecycleCapacity({ ...base, eventId: 'a'.repeat(252) })
  const next = inspectOracleBackupLifecycleCapacity({ ...base, eventId: 'a'.repeat(253) })
  assert.ok(next.requiredPlaintextBytes > small.requiredPlaintextBytes + 1)
  assert.equal(
    inspectOracleBackupLifecycleCapacity({
      ...base,
      writeVersion: 2,
      eventId: '\u0000'.repeat(512),
    }).fits,
    true,
  )
  for (const eventId of ['', 'a'.repeat(513), '\ud800'])
    assert.throws(
      () => inspectOracleBackupLifecycleCapacity({ ...base, eventId }),
      /capacity input is invalid/,
    )
})
