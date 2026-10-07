import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_PUBLIC_NOSTR_RELAYS,
  normalizeNostrRelayUrl,
  normalizeNostrRelayUrls,
  selectNostrRelayUrls,
} from '../src/nostrRelays.ts'

test('curated defaults apply only to missing configuration', () => {
  assert.deepEqual(selectNostrRelayUrls(undefined), [
    'wss://nos.lol',
    'wss://nostr.bitcoiner.social',
    'wss://relay.primal.net',
    'wss://relay.nostr.net',
    'wss://relay.damus.io',
    'wss://relay.nostr.band',
    'wss://purplepag.es',
  ])
  assert.deepEqual(selectNostrRelayUrls([]), [])
  assert.deepEqual(selectNostrRelayUrls(['wss://custom.example/Private?Key=A']), [
    'wss://custom.example/Private?Key=A',
  ])
  assert.deepEqual(selectNostrRelayUrls(undefined, ['ws://localhost:7777']), [
    'ws://localhost:7777',
  ])
  const selected = selectNostrRelayUrls(undefined)
  selected.splice(selected.indexOf('wss://nos.lol'), 1)
  assert.deepEqual(selectNostrRelayUrls(selected), selected)
  assert.deepEqual(selectNostrRelayUrls([...selected, 'wss://nos.lol']).at(-1), 'wss://nos.lol')
  assert.equal(DEFAULT_PUBLIC_NOSTR_RELAYS.length, 7)
})

test('normalization preserves path and query case and deduplicates exact URLs, not origins', () => {
  assert.equal(normalizeNostrRelayUrl(' WSS://RELAY.EXAMPLE:443/ '), 'wss://relay.example')
  assert.deepEqual(
    normalizeNostrRelayUrls([
      'wss://RELAY.EXAMPLE/',
      'wss://relay.example',
      'wss://relay.example/Path?Key=ABC',
      'wss://relay.example/path?Key=ABC',
      'wss://relay.example/Path?Key=abc',
      'wss://relay.example/Path/',
    ]),
    [
      'wss://relay.example',
      'wss://relay.example/Path?Key=ABC',
      'wss://relay.example/path?Key=ABC',
      'wss://relay.example/Path?Key=abc',
      'wss://relay.example/Path/',
    ],
  )
})

test('plain WebSocket transport accepts only the exact loopback authorities', () => {
  for (const url of ['ws://localhost:7777', 'ws://127.0.0.1:7777', 'ws://[::1]:7777']) {
    assert.equal(normalizeNostrRelayUrl(url), url)
  }
  for (const url of [
    'ws://remote.example',
    'ws://127.1',
    'ws://2130706433',
    'ws://0x7f000001',
    'ws://localhost.',
    'ws://localhost.evil',
    'ws://127.0.0.2',
    'ws://[0:0:0:0:0:0:0:1]',
    'ws://[::ffff:127.0.0.1]',
  ])
    assert.throws(() => normalizeNostrRelayUrl(url), /exact loopback/)
})

test('invalid protocols, credentials and fragments are refused without echoing URL secrets', () => {
  for (const url of [
    '',
    'not-a-url',
    'https://relay.example',
    'file:///relay',
    'wss://user:secret@relay.example',
    'wss://@relay.example',
    'wss://relay.example#private',
    'wss://relay.example#',
    'wss://relay.example\\Private',
    'wss://relay.example/\nPrivate',
  ]) {
    assert.throws(
      () => normalizeNostrRelayUrl(url),
      (error: unknown) =>
        error instanceof Error &&
        !error.message.includes('secret') &&
        !error.message.includes('private'),
    )
  }
  assert.equal(
    normalizeNostrRelayUrl('wss://custom.example/Path?Key=%23Value'),
    'wss://custom.example/Path?Key=%23Value',
  )
})
