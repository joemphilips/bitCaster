import assert from 'node:assert/strict'
import { test } from 'node:test'
import { finalizeEvent } from 'nostr-tools/pure'
import { decodeNostrProfileEvent, readNostrProfile } from '../src/nostrProfile.ts'

const key = new Uint8Array(32).fill(1)
const event = (metadata: unknown, created_at = 10) =>
  finalizeEvent(
    {
      kind: 0,
      created_at,
      tags: [],
      content: JSON.stringify(metadata),
    },
    key,
  )
const profile = event({
  name: 'Name',
  display_name: 'Display',
  picture: 'https://image.example/a',
  nip05: 'name@example.test',
  about: 'About',
  privateKey: 'must-not-project',
  extra: 'ignored',
})
const relays = ['wss://first.example/Path?Case=Yes', 'wss://second.example']

test('real signed kind-0 decoder projects only public fields and never claims NIP-05 verification', () => {
  assert.deepEqual(decodeNostrProfileEvent(profile, profile.pubkey), {
    pubkey: profile.pubkey,
    displayName: 'Display',
    avatar: 'https://image.example/a',
    nip05: 'name@example.test',
    nip05verified: false,
    bio: 'About',
    eventId: profile.id,
    createdAt: 10,
  })
})

test('missing and wrong-type fields use safe GUI-equivalent display defaults', () => {
  const input = event({ name: 42, display_name: {}, picture: false, nip05: [], about: null })
  const decoded = decodeNostrProfileEvent(input, input.pubkey)!
  assert.equal(decoded.displayName, input.pubkey.slice(0, 8))
  assert.equal(decoded.avatar, '')
  assert.equal(decoded.nip05, '')
  assert.equal(decoded.bio, '')
})

test('decoder rejects mismatched owner, kind, invalid signature, cached-verification tampering and malformed content', () => {
  const cases = [
    { ...profile, content: '{}' },
    { ...profile, sig: '00'.repeat(64) },
    finalizeEvent({ kind: 1, created_at: 10, tags: [], content: '{}' }, key),
    finalizeEvent({ kind: 0, created_at: 10, tags: [], content: '{' }, key),
    event([]),
    event(null),
    event({ about: 'a'.repeat(65_536) }),
  ]
  for (const value of cases) assert.equal(decodeNostrProfileEvent(value, profile.pubkey), null)
  assert.equal(decodeNostrProfileEvent(profile, '02'.repeat(32)), null)
})

test('fresh read uses exact selected endpoints and author, selects newest metadata, and does not retain a prior result', async () => {
  const calls: string[] = []
  const newer = event({ name: 'New' }, 11)
  const result = await readNostrProfile(profile.pubkey, relays, async (url, filter, receive) => {
    calls.push(url)
    assert.deepEqual(filter, { kinds: [0], authors: [profile.pubkey], limit: 1 })
    receive(url === relays[0] ? newer : profile)
  })
  assert.deepEqual(calls, relays)
  assert.equal(result.profile!.displayName, 'New')
  assert.equal(result.completedRelayCount, 2)
  const missed = await readNostrProfile(profile.pubkey, relays, async () => {})
  assert.equal(missed.status, 'not-found')
  assert.equal(missed.profile, null)
})

test('equal timestamps use NIP-01 lowest event ID, independent of arrival order', async () => {
  const other = event({ name: 'Other' })
  const expected = [profile, other].sort((a, b) => a.id.localeCompare(b.id))[0]!
  for (const inputs of [
    [profile, other],
    [other, profile],
  ]) {
    const result = await readNostrProfile(profile.pubkey, [relays[0]!], async (_, __, receive) => {
      inputs.forEach(receive)
    })
    assert.equal(result.profile!.eventId, expected.id)
  }
})

test('malformed latest replacement does not resurrect stale display metadata', async () => {
  const malformed = finalizeEvent({ kind: 0, created_at: 11, tags: [], content: '{' }, key)
  const result = await readNostrProfile(profile.pubkey, [relays[0]!], async (_, __, receive) => {
    receive(malformed)
    receive(profile)
  })
  assert.equal(result.status, 'not-found')
  assert.equal(result.profile, null)
})

test('empty or invalid selection makes no transport call and never restores public defaults', async () => {
  let calls = 0
  const query = async () => {
    calls += 1
  }
  await assert.rejects(readNostrProfile(profile.pubkey, [], query), /Configure a Nostr relay/)
  await assert.rejects(
    readNostrProfile(profile.pubkey, ['https://invalid.example'], query),
    /Relay|relay/,
  )
  await assert.rejects(readNostrProfile('not-a-key', relays, query), /public key is invalid/)
  assert.equal(calls, 0)
})

test('partial relay failure is explicit and total failure is actionable and redacted', async () => {
  const query = async (url: string) => {
    if (url === relays[0]) throw new Error('untrusted private text')
  }
  const partial = await readNostrProfile(profile.pubkey, relays, query)
  assert.equal(partial.completedRelayCount, 1)
  assert.equal(partial.failedRelayCount, 1)
  assert.equal(partial.status, 'not-found')
  await assert.rejects(readNostrProfile(profile.pubkey, [relays[0]!], query), {
    message: 'Nostr profile read failed. Check the configured relays and retry.',
  })
})

test('events delivered after a query settles cannot change the pending read result', async () => {
  let late: ((value: typeof profile) => void) | undefined
  const result = await readNostrProfile(profile.pubkey, relays, async (url, _, receive) => {
    if (url === relays[0]) {
      receive(profile)
      late = receive
      return
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
    late!(event({ name: 'Late' }, 20))
  })
  assert.equal(result.profile!.displayName, 'Display')
})
