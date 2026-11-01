import assert from 'node:assert/strict'
import { test } from 'node:test'
import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools/pure'
import { neventEncode, noteEncode, npubEncode, nsecEncode } from 'nostr-tools/nip19'
import {
  MAX_NOSTR_FOLLOW_LIST_EVENT_BYTES,
  MAX_NOSTR_NOTE_CHARACTERS,
  MAX_NOSTR_PROFILE_ABOUT_CHARACTERS,
  MAX_NOSTR_PROFILE_NAME_CHARACTERS,
  MAX_NOSTR_RECENT_NOTES,
  parseNostrPublicKey,
  readNostrFollowCount,
  readNostrProfilePageMetadata,
  readNostrRecentNotes,
  safeNostrHttpUrl,
  sanitizeNostrDisplayText,
  selectPublicNostrProfileRelays,
  type NostrBoundedRelayQuery,
} from '../src/nostrProfilePage.ts'
import {
  MAX_NOSTR_PROFILE_RELAY_FRAMES,
  MAX_NOSTR_PROFILE_TRANSPORT_BYTES,
} from '../src/nostrProfile.ts'

const key = new Uint8Array(32).fill(7)
const otherKey = new Uint8Array(32).fill(8)
const pubkey = getPublicKey(key)
const relays = ['wss://one.example', 'wss://two.example']
const followA = 'a'.repeat(64)
const followB = 'b'.repeat(64)

const signed = (
  kind: number,
  content: string,
  created_at: number,
  tags: string[][] = [],
  secret = key,
): Event => finalizeEvent({ kind, created_at, tags, content }, secret)

/** Serve each relay's events in order. A relay mapped to an Error fails. */
function relayQuery(byRelay: Record<string, Event[] | Error>): {
  query: NostrBoundedRelayQuery
  calls: { url: string; filter: unknown; bounds: unknown }[]
} {
  const calls: { url: string; filter: unknown; bounds: unknown }[] = []
  const query: NostrBoundedRelayQuery = async (url, filter, onEvent, bounds) => {
    calls.push({ url, filter, bounds })
    const served = byRelay[url]
    if (served instanceof Error) throw served
    for (const event of served ?? []) onEvent(event)
  }
  return { query, calls }
}

test('display text removes bidi and control characters and bounds the length by code point', () => {
  assert.equal(
    sanitizeNostrDisplayText('a\u202Eevil\u202C\u2066b\u2069\u200F\u061C\u0007\u0000c', 100),
    'aevilbc',
  )
  assert.equal(
    sanitizeNostrDisplayText('line one\r\nline two\tend', 100),
    'line one\nline two\tend',
  )
  assert.equal(
    sanitizeNostrDisplayText('  name\n second  ', 100, { singleLine: true }),
    'name second',
  )
  assert.equal(sanitizeNostrDisplayText('😀😀😀', 2), '😀😀…')
  assert.equal(
    sanitizeNostrDisplayText('<script>alert(1)</script>', 100),
    '<script>alert(1)</script>',
  )
  for (const value of [undefined, null, 42, {}, ['text']])
    assert.equal(sanitizeNostrDisplayText(value, 10), '')
})

test('profile URLs accept only absolute http and https without credentials or hidden characters', () => {
  assert.equal(safeNostrHttpUrl(' https://img.example/a.png '), 'https://img.example/a.png')
  assert.equal(safeNostrHttpUrl('http://img.example/a.png'), 'http://img.example/a.png')
  for (const value of [
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'data:image/png;base64,AAAA',
    'vbscript:msgbox',
    'file:///etc/passwd',
    '//img.example/a.png',
    '/relative.png',
    'https://user:pass@img.example/a.png',
    'https://img.example/a b.png',
    'https://img.example/\u202Egnp.exe',
    `https://img.example/${'a'.repeat(2_048)}`,
    'https://',
    42,
    null,
  ])
    assert.equal(safeNostrHttpUrl(value), null, String(value).slice(0, 40))
})

test('public profile reads use at most the first three normalized relays', () => {
  assert.deepEqual(
    selectPublicNostrProfileRelays([
      'wss://a.example/',
      'wss://a.example',
      'wss://b.example',
      'wss://c.example',
      'wss://d.example',
    ]),
    ['wss://a.example', 'wss://b.example', 'wss://c.example'],
  )
})

test('profile page metadata projects bounded text and safe image URLs from the newest kind 0', async () => {
  const older = signed(0, JSON.stringify({ name: 'old' }), 10)
  const newest = signed(
    0,
    JSON.stringify({
      name: 'alice\u202E',
      display_name: '<img src=x onerror=alert(1)>',
      about: `${'x'.repeat(MAX_NOSTR_PROFILE_ABOUT_CHARACTERS + 50)}`,
      picture: 'javascript:alert(1)',
      banner: 'https://banner.example/b.jpg',
      website: 'https://alice.example',
      nip05: 'alice@alice.example',
    }),
    11,
  )
  const { query, calls } = relayQuery({ [relays[0]!]: [older], [relays[1]!]: [newest] })
  const result = await readNostrProfilePageMetadata(pubkey, relays, query)
  assert.equal(result.status, 'found')
  assert.ok(result.status === 'found')
  const { metadata } = result
  assert.equal(metadata.name, 'alice')
  assert.equal(metadata.displayName, '<img src=x onerror=alert(1)>')
  assert.equal(Array.from(metadata.about).length, MAX_NOSTR_PROFILE_ABOUT_CHARACTERS + 1)
  assert.ok(metadata.about.endsWith('…'))
  assert.equal(metadata.picture, null)
  assert.equal(metadata.banner, 'https://banner.example/b.jpg')
  assert.equal(metadata.website, 'https://alice.example/')
  assert.equal(metadata.nip05, 'alice@alice.example')
  assert.equal(metadata.createdAt, 11)
  assert.deepEqual(calls[0]!.filter, { kinds: [0], authors: [pubkey], limit: 1 })
  assert.deepEqual(calls[0]!.bounds, {
    maxFrameBytes: MAX_NOSTR_PROFILE_TRANSPORT_BYTES,
    maxFrames: MAX_NOSTR_PROFILE_RELAY_FRAMES,
  })
})

test('profile page metadata ignores forged, foreign and malformed events and bounds long names', async () => {
  const valid = signed(0, JSON.stringify({ name: 'n'.repeat(500) }), 10)
  const { query } = relayQuery({
    [relays[0]!]: [
      { ...signed(0, JSON.stringify({ name: 'forged' }), 99), sig: '00'.repeat(64) },
      signed(0, JSON.stringify({ name: 'foreign' }), 99, [], otherKey),
      { ...valid, content: JSON.stringify({ name: 'tampered' }), created_at: 98 },
      { kind: 0 } as unknown as Event,
      null as unknown as Event,
      valid,
    ],
  })
  const result = await readNostrProfilePageMetadata(pubkey, [relays[0]!], query)
  assert.ok(result.status === 'found')
  assert.equal(Array.from(result.metadata.name).length, MAX_NOSTR_PROFILE_NAME_CHARACTERS + 1)
  assert.equal(result.metadata.displayName, result.metadata.name)
})

test('profile page metadata reports not-found, survives a failed relay and throws when all fail', async () => {
  const { query } = relayQuery({ [relays[0]!]: new Error('private relay text'), [relays[1]!]: [] })
  assert.deepEqual(await readNostrProfilePageMetadata(pubkey, relays, query), {
    status: 'not-found',
  })
  const failing = relayQuery({ [relays[0]!]: new Error('down') })
  await assert.rejects(readNostrProfilePageMetadata(pubkey, [relays[0]!], failing.query), {
    message: 'Nostr profile read failed. Check the configured relays and retry.',
  })
  const malformed = relayQuery({ [relays[0]!]: [signed(0, '[1,2]', 10)] })
  assert.deepEqual(await readNostrProfilePageMetadata(pubkey, [relays[0]!], malformed.query), {
    status: 'not-found',
  })
})

test('follow count counts unique valid p tags of the newest kind 3 across relays', async () => {
  const older = signed(3, '', 10, [['p', followA]])
  const newest = signed(3, '', 20, [
    ['p', followA],
    ['p', followA, 'wss://relay.example'],
    ['p', followB],
    ['p', 'A'.repeat(64)],
    ['p', 'not-hex'],
    ['p'],
    ['e', followB],
    ['t', 'nostr'],
  ])
  const { query, calls } = relayQuery({ [relays[0]!]: [older], [relays[1]!]: [newest] })
  assert.deepEqual(await readNostrFollowCount(pubkey, relays, query), {
    status: 'counted',
    count: 2,
  })
  assert.deepEqual(calls[0]!.filter, { kinds: [3], authors: [pubkey], limit: 1 })
  const bounds = calls[0]!.bounds as { maxFrameBytes: number; maxFrames: number }
  assert.ok(bounds.maxFrameBytes > MAX_NOSTR_FOLLOW_LIST_EVENT_BYTES)
  assert.ok(bounds.maxFrames <= 8)
})

test('follow count is unknown when the newest list is above the byte bound', async () => {
  const tags = Array.from({ length: 7_500 }, (_, i) => ['p', i.toString(16).padStart(64, '0')])
  const huge = signed(3, '', 30, tags)
  assert.ok(JSON.stringify(huge).length > MAX_NOSTR_FOLLOW_LIST_EVENT_BYTES)
  const small = signed(3, '', 10, [['p', followA]])
  const { query } = relayQuery({ [relays[0]!]: [huge], [relays[1]!]: [small] })
  assert.deepEqual(await readNostrFollowCount(pubkey, relays, query), { status: 'unknown' })
})

test('follow count ignores forged and foreign lists and reports not-found or unknown', async () => {
  const forged = { ...signed(3, '', 50, [['p', followA]]), sig: '00'.repeat(64) }
  const foreign = signed(3, '', 50, [['p', followA]], otherKey)
  const wrongKind = signed(1, '', 50, [['p', followA]])
  const { query } = relayQuery({ [relays[0]!]: [forged, foreign, wrongKind] })
  assert.deepEqual(await readNostrFollowCount(pubkey, [relays[0]!], query), {
    status: 'not-found',
  })
  const down = relayQuery({ [relays[0]!]: new Error('down'), [relays[1]!]: new Error('down') })
  assert.deepEqual(await readNostrFollowCount(pubkey, relays, down.query), { status: 'unknown' })
  const partial = relayQuery({
    [relays[0]!]: new Error('down'),
    [relays[1]!]: [signed(3, '', 5, [['p', followB]])],
  })
  assert.deepEqual(await readNostrFollowCount(pubkey, relays, partial.query), {
    status: 'counted',
    count: 1,
  })
})

test('recent notes are verified, deduplicated across relays, newest first and at most ten', async () => {
  const notes = Array.from({ length: 14 }, (_, i) => signed(1, `note ${i}`, 100 + i))
  const forged = { ...signed(1, 'forged', 999), sig: '00'.repeat(64) }
  const foreign = signed(1, 'foreign', 998, [], otherKey)
  const metadata = signed(0, '{}', 997)
  const { query, calls } = relayQuery({
    [relays[0]!]: [...notes.slice(0, 9), forged, foreign, metadata],
    [relays[1]!]: notes.slice(5),
  })
  const result = await readNostrRecentNotes(pubkey, relays, query)
  assert.equal(result.length, MAX_NOSTR_RECENT_NOTES)
  assert.deepEqual(
    result.map((note) => note.content),
    Array.from({ length: 10 }, (_, i) => `note ${13 - i}`),
  )
  assert.equal(result[0]!.id, notes[13]!.id)
  assert.equal(result[0]!.createdAt, 113)
  assert.deepEqual(calls[0]!.filter, { kinds: [1], authors: [pubkey], limit: 10 })
  const bounds = calls[0]!.bounds as { maxFrameBytes: number; maxFrames: number }
  assert.equal(bounds.maxFrameBytes, MAX_NOSTR_PROFILE_TRANSPORT_BYTES)
  assert.ok(bounds.maxFrames >= MAX_NOSTR_RECENT_NOTES + 1)
})

test('recent notes strip bidi controls, bound content, drop empty notes and survive one failed relay', async () => {
  const hostile = signed(1, `\u202E${'z'.repeat(MAX_NOSTR_NOTE_CHARACTERS + 10)}`, 20)
  const empty = signed(1, ' \u202E\u2066 ', 30)
  const { query } = relayQuery({
    [relays[0]!]: new Error('down'),
    [relays[1]!]: [hostile, empty],
  })
  const result = await readNostrRecentNotes(pubkey, relays, query)
  assert.equal(result.length, 1)
  assert.equal(result[0]!.content.includes('\u202E'), false)
  assert.equal(Array.from(result[0]!.content).length, MAX_NOSTR_NOTE_CHARACTERS + 1)
  const down = relayQuery({ [relays[0]!]: new Error('down') })
  await assert.rejects(readNostrRecentNotes(pubkey, [relays[0]!], down.query))
})

test('page readers reject an invalid public key before any relay call', async () => {
  const { query, calls } = relayQuery({})
  await assert.rejects(readNostrProfilePageMetadata('npub1bad', relays, query))
  await assert.rejects(readNostrRecentNotes('A'.repeat(64), relays, query))
  assert.deepEqual(await readNostrFollowCount('xyz', relays, query), { status: 'unknown' })
  assert.equal(calls.length, 0)
})

test('public key parser accepts hex in any case and npub, and rejects other identifiers', () => {
  assert.equal(parseNostrPublicKey(pubkey.toUpperCase()), pubkey)
  assert.equal(parseNostrPublicKey(` ${npubEncode(pubkey)} `), pubkey)
  for (const value of [
    nsecEncode(key),
    noteEncode('a'.repeat(64)),
    neventEncode({ id: 'a'.repeat(64) }),
    `${npubEncode(pubkey).slice(0, -1)}q`,
    'a'.repeat(63),
    'g'.repeat(64),
    '',
    'unknown',
  ])
    assert.equal(parseNostrPublicKey(value), null, value.slice(0, 12))
})
