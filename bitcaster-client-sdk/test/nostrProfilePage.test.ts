import assert from 'node:assert/strict'
import { test } from 'node:test'
import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools/pure'
import { neventEncode, noteEncode, npubEncode, nsecEncode } from 'nostr-tools/nip19'
import {
  MAX_NOSTR_FOLLOW_LIST_EVENT_BYTES,
  MAX_NOSTR_FOLLOW_LIST_RELAY_FRAMES,
  MAX_NOSTR_FOLLOW_LIST_TRANSPORT_BYTES,
  MAX_NOSTR_NOTE_CHARACTERS,
  MAX_NOSTR_NOTE_RELAY_FRAMES,
  MAX_NOSTR_PROFILE_ABOUT_CHARACTERS,
  MAX_NOSTR_PROFILE_NAME_CHARACTERS,
  MAX_NOSTR_RECENT_NOTES,
  parseNostrPublicKey,
  readNostrProfilePage,
  safeNostrHttpUrl,
  safeNostrImageUrl,
  sanitizeNostrDisplayText,
  selectPublicNostrProfileRelays,
  type NostrBoundedRelayQuery,
} from '../src/nostrProfilePage.ts'
import {
  MAX_NOSTR_PROFILE_TRANSPORT_BYTES,
  NostrRelayFrameTooLargeError,
} from '../src/nostrProfile.ts'

const key = new Uint8Array(32).fill(7)
const otherKey = new Uint8Array(32).fill(8)
const pubkey = getPublicKey(key)
const relays = ['wss://one.example', 'wss://two.example']
const followA = 'a'.repeat(64)
const followB = 'b'.repeat(64)
const now = 1_800_000_000
// The JavaScript Date range ends at 8.64e12 seconds. A later time makes toISOString throw.
const farFuture = 9_000_000_000_000

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
  calls: { url: string; filters: unknown; bounds: unknown }[]
} {
  const calls: { url: string; filters: unknown; bounds: unknown }[] = []
  const query: NostrBoundedRelayQuery = async (url, filters, onEvent, bounds) => {
    calls.push({ url, filters, bounds })
    const served = byRelay[url]
    if (served instanceof Error) throw served
    for (const event of served ?? []) onEvent(event)
  }
  return { query, calls }
}

const readPage = (query: NostrBoundedRelayQuery, relayUrls: readonly string[] = relays) =>
  readNostrProfilePage(pubkey, relayUrls, query, now)

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

test('single-line text removes zero-width and invisible characters', () => {
  const name = (value: string) => sanitizeNostrDisplayText(value, 100, { singleLine: true })
  assert.equal(name('a\u200Bl\u200Ci\u200Dc\u2060e\u2061\u2062\u2063\u2064\uFEFF'), 'alice')
  assert.equal(name('\u{E0041}x\u{E007F}'), 'x')
  assert.equal(name('a\u200B \u3164 b'), 'a b')
  assert.equal(name('\u115F\u1160\u3164\uFFA0'), '')
  assert.equal(name(' \u200B\u2060\uFEFF\u{E0020} '), '')
  // Multi-line text keeps a joiner, so an emoji sequence in a note stays intact.
  assert.equal(
    sanitizeNostrDisplayText('\u{1F468}\u200D\u{1F469}', 100),
    '\u{1F468}\u200D\u{1F469}',
  )
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

test('profile URLs reject hosts that are local by syntax or that the URL parser reads as IPv4', () => {
  assert.equal(safeNostrHttpUrl('https://img.example:8443/a.png'), 'https://img.example:8443/a.png')
  assert.equal(safeNostrImageUrl('https://IMG.Example/a.png'), 'https://img.example/a.png')
  for (const value of [
    'https://127.0x1/a.png',
    'https://0x7f.0x1/a.png',
    'https://192.168.0x1/a.png',
    'https://10.0.0.1/a.png',
    'https://2130706433/a.png',
    'https://[::1]/a.png',
    'https://localhost/a.png',
    'https://x.localhost/a.png',
    'https://printer.local/a.png',
    'https://db.internal/a.png',
    'https://router.home.arpa/a.png',
    'https://home.arpa/a.png',
    'https://nas.lan/a.png',
    'https://intranet/a.png',
  ]) {
    assert.equal(safeNostrHttpUrl(value), null, value)
    assert.equal(safeNostrImageUrl(value), null, value)
  }
})

test('profile image URLs accept only https', () => {
  assert.equal(safeNostrImageUrl('https://img.example/a.png'), 'https://img.example/a.png')
  for (const value of ['http://img.example/a.png', 'javascript:alert(1)', 'data:image/png,AAAA'])
    assert.equal(safeNostrImageUrl(value), null, value)
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

test('a page read sends one request to each relay with the kind 0, kind 3 and note filters', async () => {
  const { query, calls } = relayQuery({})
  await readPage(query)
  assert.deepEqual(
    calls.map((call) => call.url),
    relays,
  )
  const until = now + 3_600
  for (const call of calls) {
    assert.deepEqual(call.filters, [
      { kinds: [0], authors: [pubkey], limit: 1, until },
      { kinds: [3], authors: [pubkey], limit: 1, until },
      { kinds: [1], authors: [pubkey], limit: MAX_NOSTR_RECENT_NOTES, until },
    ])
    // The sum of the three former reads: 64 profile frames, 8 follow-list frames and
    // 32 note frames; 8 MiB + 8 MiB + 4 MiB in total; the largest frame is a follow list.
    assert.deepEqual(call.bounds, {
      maxFrameBytes: 1_048_576,
      maxFrames: 104,
      maxTotalBytes: 20_971_520,
    })
  }
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
  const { query } = relayQuery({ [relays[0]!]: [older], [relays[1]!]: [newest] })
  const { metadata: result } = await readPage(query)
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
})

test('profile page images load only over https and the website link can use http', async () => {
  const event = signed(
    0,
    JSON.stringify({
      picture: 'http://img.example/p.png',
      image: 'https://img.example/fallback.png',
      banner: 'http://img.example/b.png',
      website: 'http://alice.example',
    }),
    10,
  )
  const { query } = relayQuery({ [relays[0]!]: [event] })
  const { metadata: result } = await readPage(query, [relays[0]!])
  assert.ok(result.status === 'found')
  assert.equal(result.metadata.picture, 'https://img.example/fallback.png')
  assert.equal(result.metadata.banner, null)
  assert.equal(result.metadata.website, 'http://alice.example/')
})

test('profile page names that hold only invisible characters fall back or stay empty', async () => {
  const event = signed(
    0,
    JSON.stringify({ name: '\u3164\u200B', display_name: '\uFFA0\u2060', displayName: 'Bob' }),
    10,
  )
  const { query } = relayQuery({ [relays[0]!]: [event] })
  const { metadata: result } = await readPage(query, [relays[0]!])
  assert.ok(result.status === 'found')
  assert.equal(result.metadata.name, '')
  assert.equal(result.metadata.displayName, 'Bob')
})

test('a page read drops kind 0, kind 3 and notes dated more than one hour after now', async () => {
  const { query } = relayQuery({
    [relays[0]!]: [
      signed(0, JSON.stringify({ name: 'future' }), farFuture),
      signed(0, JSON.stringify({ name: 'skewed' }), now + 3_601),
      signed(0, JSON.stringify({ name: 'current' }), now - 5),
      signed(3, '', now + 3_601, [
        ['p', followA],
        ['p', followB],
      ]),
      signed(3, '', now - 5, [['p', followA]]),
      signed(1, 'far future', farFuture),
      signed(1, 'skewed', now + 3_601),
      signed(1, 'within skew', now + 3_600),
      signed(1, 'current', now),
    ],
  })
  const page = await readPage(query, [relays[0]!])
  assert.ok(page.metadata.status === 'found')
  assert.equal(page.metadata.metadata.name, 'current')
  assert.deepEqual(page.follows, { status: 'counted', count: 1 })
  assert.deepEqual(
    page.notes.map((note) => note.content),
    ['within skew', 'current'],
  )
  for (const note of page.notes)
    assert.doesNotThrow(() => new Date(note.createdAt * 1000).toISOString())
})

test('a page read rejects an invalid current time before any relay call', async () => {
  const { query, calls } = relayQuery({})
  for (const value of [Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(readNostrProfilePage(pubkey, relays, query, value), {
      message: 'Nostr profile page time is invalid.',
    })
  assert.equal(calls.length, 0)
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
  const { metadata: result } = await readPage(query, [relays[0]!])
  assert.ok(result.status === 'found')
  assert.equal(Array.from(result.metadata.name).length, MAX_NOSTR_PROFILE_NAME_CHARACTERS + 1)
  assert.equal(result.metadata.displayName, result.metadata.name)
})

test('a page read reports not-found, survives a failed relay and throws when all fail', async () => {
  const { query } = relayQuery({ [relays[0]!]: new Error('private relay text'), [relays[1]!]: [] })
  assert.deepEqual(await readPage(query), {
    metadata: { status: 'not-found' },
    follows: { status: 'not-found' },
    notes: [],
  })
  const failing = relayQuery({ [relays[0]!]: new Error('down') })
  await assert.rejects(readPage(failing.query, [relays[0]!]), {
    message: 'Nostr profile read failed. Check the configured relays and retry.',
  })
  const malformed = relayQuery({ [relays[0]!]: [signed(0, '[1,2]', 10)] })
  assert.deepEqual((await readPage(malformed.query, [relays[0]!])).metadata, {
    status: 'not-found',
  })
})

test('a kind 0 above its event byte bound is dropped although the request allows larger frames', async () => {
  const tags = Array.from({ length: 2_000 }, (_, i) => ['t', `${'x'.repeat(60)}${i}`])
  const large = signed(0, JSON.stringify({ name: 'large' }), 20, tags)
  const bytes = JSON.stringify(large).length
  assert.ok(
    bytes > MAX_NOSTR_PROFILE_TRANSPORT_BYTES && bytes < MAX_NOSTR_FOLLOW_LIST_TRANSPORT_BYTES,
  )
  const small = signed(0, JSON.stringify({ name: 'small' }), 10)
  const { query } = relayQuery({ [relays[0]!]: [large], [relays[1]!]: [small] })
  const { metadata } = await readPage(query)
  assert.ok(metadata.status === 'found')
  assert.equal(metadata.metadata.name, 'small')
})

test('a relay that sends more events of one kind than its filter bound fails', async () => {
  const lists = Array.from({ length: MAX_NOSTR_FOLLOW_LIST_RELAY_FRAMES + 1 }, (_, i) =>
    signed(3, '', 10 + i),
  )
  const tooMany = relayQuery({ [relays[0]!]: lists })
  await assert.rejects(readPage(tooMany.query, [relays[0]!]))
  const notes = Array.from({ length: MAX_NOSTR_NOTE_RELAY_FRAMES + 1 }, (_, i) =>
    signed(1, `note ${i}`, 10 + i),
  )
  await assert.rejects(readPage(relayQuery({ [relays[0]!]: notes }).query, [relays[0]!]))
  // Each kind has its own bound: the largest allowed number of each kind still completes.
  const within = relayQuery({ [relays[0]!]: [...lists.slice(1), ...notes.slice(1)] })
  const page = await readPage(within.query, [relays[0]!])
  assert.deepEqual(page.follows, { status: 'counted', count: 0 })
  assert.equal(page.notes.length, MAX_NOSTR_RECENT_NOTES)
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
  const { query } = relayQuery({ [relays[0]!]: [older], [relays[1]!]: [newest] })
  assert.deepEqual((await readPage(query)).follows, { status: 'counted', count: 2 })
})

test('follow count is unknown when the newest list is above the byte bound', async () => {
  const tags = Array.from({ length: 7_500 }, (_, i) => ['p', i.toString(16).padStart(64, '0')])
  const huge = signed(3, '', 30, tags)
  assert.ok(JSON.stringify(huge).length > MAX_NOSTR_FOLLOW_LIST_EVENT_BYTES)
  const small = signed(3, '', 10, [['p', followA]])
  const { query } = relayQuery({ [relays[0]!]: [huge], [relays[1]!]: [small] })
  assert.deepEqual((await readPage(query)).follows, { status: 'unknown' })
})

test('follow count is unknown when a relay rejects a frame above the size bound', async () => {
  // The rejected frame can be a newer follow list than the smaller list on the other relay.
  const { query } = relayQuery({
    [relays[0]!]: new NostrRelayFrameTooLargeError(),
    [relays[1]!]: [
      signed(0, JSON.stringify({ name: 'alice' }), 10),
      signed(3, '', 10, [['p', followA]]),
      signed(1, 'note', 10),
    ],
  })
  const page = await readPage(query)
  assert.deepEqual(page.follows, { status: 'unknown' })
  assert.ok(page.metadata.status === 'found')
  assert.deepEqual(
    page.notes.map((note) => note.content),
    ['note'],
  )
  // Another relay failure does not hide the count.
  const down = relayQuery({
    [relays[0]!]: new Error('down'),
    [relays[1]!]: [signed(3, '', 10, [['p', followA]])],
  })
  assert.deepEqual((await readPage(down.query)).follows, { status: 'counted', count: 1 })
})

test('follow count ignores forged and foreign lists and the tags of a note', async () => {
  const forged = { ...signed(3, '', 50, [['p', followA]]), sig: '00'.repeat(64) }
  const foreign = signed(3, '', 50, [['p', followA]], otherKey)
  const note = signed(1, 'note', 50, [['p', followA]])
  const { query } = relayQuery({ [relays[0]!]: [forged, foreign, note] })
  assert.deepEqual((await readPage(query, [relays[0]!])).follows, { status: 'not-found' })
  const partial = relayQuery({
    [relays[0]!]: new Error('down'),
    [relays[1]!]: [signed(3, '', 5, [['p', followB]])],
  })
  assert.deepEqual((await readPage(partial.query)).follows, { status: 'counted', count: 1 })
})

test('recent notes are verified, deduplicated across relays, newest first and at most ten', async () => {
  const notes = Array.from({ length: 14 }, (_, i) => signed(1, `note ${i}`, 100 + i))
  const forged = { ...signed(1, 'forged', 999), sig: '00'.repeat(64) }
  const foreign = signed(1, 'foreign', 998, [], otherKey)
  const metadata = signed(0, '{}', 997)
  const { query } = relayQuery({
    [relays[0]!]: [...notes.slice(0, 9), forged, foreign, metadata],
    [relays[1]!]: notes.slice(5),
  })
  const result = (await readPage(query)).notes
  assert.equal(result.length, MAX_NOSTR_RECENT_NOTES)
  assert.deepEqual(
    result.map((note) => note.content),
    Array.from({ length: 10 }, (_, i) => `note ${13 - i}`),
  )
  assert.equal(result[0]!.id, notes[13]!.id)
  assert.equal(result[0]!.createdAt, 113)
})

test('recent notes strip bidi controls, bound content, drop empty notes and survive one failed relay', async () => {
  const hostile = signed(1, `\u202E${'z'.repeat(MAX_NOSTR_NOTE_CHARACTERS + 10)}`, 20)
  const empty = signed(1, ' \u202E\u2066 ', 30)
  const { query } = relayQuery({
    [relays[0]!]: new Error('down'),
    [relays[1]!]: [hostile, empty],
  })
  const result = (await readPage(query)).notes
  assert.equal(result.length, 1)
  assert.equal(result[0]!.content.includes('\u202E'), false)
  assert.equal(Array.from(result[0]!.content).length, MAX_NOSTR_NOTE_CHARACTERS + 1)
})

test('a page read rejects an invalid public key before any relay call', async () => {
  const { query, calls } = relayQuery({})
  await assert.rejects(readNostrProfilePage('npub1bad', relays, query, now))
  await assert.rejects(readNostrProfilePage('A'.repeat(64), relays, query, now))
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
