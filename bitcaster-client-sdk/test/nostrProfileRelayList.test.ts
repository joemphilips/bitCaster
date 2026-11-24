import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Filter } from 'nostr-tools/filter'
import { finalizeEvent, type Event } from 'nostr-tools/pure'
import {
  MAX_NOSTR_PROFILE_WRITE_RELAYS,
  readNostrProfileEditSnapshot,
  readNostrProfileEditSnapshotWithRelayList,
  readNostrProfileWithRelayList,
  selectNostrProfileEditBase,
  type NostrProfileFiltersQuery,
} from '../src/nostrProfile.ts'

const key = new Uint8Array(32).fill(3)
const signed = (kind: number, created_at: number, content: string, tags: string[][] = []) =>
  finalizeEvent({ kind, created_at, tags, content }, key)
const publicKey = signed(0, 1, '{}').pubkey
const selected = ['wss://selected.example', 'wss://down.example']
const index = ['wss://index.example']

/** Each relay answers with its stored events of the requested kinds. A listed relay fails. */
function relays(stored: Readonly<Record<string, readonly unknown[]>>, failing: readonly string[]) {
  const calls: { url: string; filters: readonly Filter[] }[] = []
  const query: NostrProfileFiltersQuery = async (url, filters, onEvent) => {
    calls.push({ url, filters })
    if (failing.includes(url)) throw new Error('private transport detail')
    for (const event of stored[url] ?? [])
      if (filters.some((filter) => filter.kinds?.includes((event as Event).kind)))
        onEvent(event as Event)
  }
  return { calls, query }
}

test('a profile read also reads the index relay and the write relays of the relay list', async () => {
  const relayList = signed(10002, 5, '', [
    ['r', 'wss://outbox.example'],
    ['r', 'wss://write.example', 'write'],
    ['r', 'wss://read.example', 'read'],
    ['r', 'ws://plain.example'],
    ['r', 'ws://localhost:7777'],
    ['r', 'https://not-a-relay.example'],
    ['r', 'wss://selected.example'],
  ])
  const older = signed(0, 6, '{"name":"Older"}')
  const newest = signed(0, 8, '{"name":"Outbox"}')
  const io = relays(
    {
      'wss://selected.example': [older],
      'wss://index.example': [relayList],
      'wss://outbox.example': [newest],
    },
    ['wss://down.example'],
  )
  const result = await readNostrProfileWithRelayList(publicKey, selected, index, io.query)
  assert.equal(result.profile?.displayName, 'Outbox')
  assert.equal(result.profile?.eventId, newest.id)
  // The first step sends one REQ to each selected and index relay. The second
  // step reads only the write relays that the first step did not read.
  assert.deepEqual(
    io.calls.map(({ url, filters }) => [url, filters.map((filter) => filter.kinds)]),
    [
      ['wss://selected.example', [[0], [10002]]],
      ['wss://down.example', [[0], [10002]]],
      ['wss://index.example', [[0], [10002]]],
      ['wss://outbox.example', [[0]]],
      ['wss://write.example', [[0]]],
    ],
  )
  assert.deepEqual(io.calls[0]!.filters, [
    { kinds: [0], authors: [publicKey], limit: 1 },
    { kinds: [10002], authors: [publicKey], limit: 1 },
  ])
  assert.equal(result.completedRelayCount, 4)
  assert.equal(result.failedRelayCount, 1)
})

test('the newest valid relay list wins and the write relays have a fixed bound', async () => {
  const many = Array.from({ length: MAX_NOSTR_PROFILE_WRITE_RELAYS + 2 }, (_, i) => [
    'r',
    `wss://w${i}.example`,
  ])
  const old = signed(10002, 4, '', [['r', 'wss://old.example']])
  const forgedNewer = {
    ...signed(10002, 9, '', [['r', 'wss://forged.example']]),
    sig: '00'.repeat(64),
  }
  const otherKey = finalizeEvent(
    { kind: 10002, created_at: 9, tags: [['r', 'wss://other.example']], content: '' },
    new Uint8Array(32).fill(4),
  )
  const io = relays(
    { 'wss://index.example': [old, signed(10002, 5, '', many), forgedNewer, otherKey] },
    [],
  )
  await readNostrProfileWithRelayList(publicKey, ['wss://selected.example'], index, io.query)
  assert.deepEqual(
    io.calls.slice(2).map(({ url }) => url),
    many.slice(0, MAX_NOSTR_PROFILE_WRITE_RELAYS).map(([, url]) => url),
  )
})

test('an edit after a relay-list read needs one answered relay, not every relay', async () => {
  const io = relays({}, ['wss://down.example'])
  const snapshot = await readNostrProfileEditSnapshotWithRelayList(
    publicKey,
    selected,
    index,
    io.query,
  )
  assert.equal(snapshot.status, 'absent')
  assert.equal(snapshot.readScope, 'relay-list')
  assert.equal(snapshot.completedRelayCount, 2)
  assert.equal(snapshot.failedRelayCount, 1)
  assert.equal(selectNostrProfileEditBase(publicKey, snapshot, null), null)
  // A read of the selected relays only still needs every selected relay.
  const strict = await readNostrProfileEditSnapshot(publicKey, selected, async (url) => {
    if (url === 'wss://down.example') throw new Error('down')
  })
  assert.equal(strict.readScope, 'selected-relays')
  assert.throws(() => selectNostrProfileEditBase(publicKey, strict, null), /completed/)
})

test('a relay-list read fails when no relay answers, and an empty selection reads nothing', async () => {
  const io = relays({}, [...selected, ...index])
  await assert.rejects(readNostrProfileWithRelayList(publicKey, selected, index, io.query), {
    message: 'Nostr profile read failed. Check the configured relays and retry.',
  })
  await assert.rejects(
    readNostrProfileEditSnapshotWithRelayList(publicKey, selected, index, io.query),
    { message: 'Nostr profile read failed. Check the configured relays and retry.' },
  )
  const empty = relays({}, [])
  await assert.rejects(readNostrProfileWithRelayList(publicKey, [], index, empty.query), {
    message: 'Configure a Nostr relay before reading the signer profile.',
  })
  assert.deepEqual(empty.calls, [])
})

test('a failed write relay counts as a failed read and does not fail an answered read', async () => {
  const relayList = signed(10002, 5, '', [['r', 'wss://outbox.example']])
  const io = relays({ 'wss://selected.example': [relayList] }, ['wss://outbox.example'])
  const result = await readNostrProfileWithRelayList(
    publicKey,
    ['wss://selected.example'],
    [],
    io.query,
  )
  assert.equal(result.profile, null)
  assert.equal(result.completedRelayCount, 1)
  assert.equal(result.failedRelayCount, 1)
})
