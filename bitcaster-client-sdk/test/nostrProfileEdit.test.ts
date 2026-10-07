import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { finalizeEvent } from 'nostr-tools/pure'
import {
  decodeNostrProfileEditEvent,
  decodeNostrProfileAcknowledgment,
  MAX_NOSTR_PROFILE_CONTENT_BYTES,
  MAX_NOSTR_PROFILE_EVENT_BYTES,
  MAX_NOSTR_PROFILE_TRANSPORT_BYTES,
  prepareNostrProfileEdit,
  readNostrProfileEditSnapshot,
  selectNostrProfileEditBase,
  signNostrProfileEdit,
  validateNostrProfilePatch,
} from '../src/nostrProfile.ts'

const key = new Uint8Array(32).fill(1)
const signed = (content: string, created_at = 10) =>
  finalizeEvent({ kind: 0, created_at, tags: [], content }, key)
const profile = signed('{"name":"Old","about":"Bio"}')
const relays = ['wss://first.example', 'wss://second.example']

test('edit snapshot distinguishes absent and newest signed unusable metadata', async () => {
  const absent = await readNostrProfileEditSnapshot(profile.pubkey, relays, async () => {})
  assert.equal(absent.status, 'absent')
  assert.equal(selectNostrProfileEditBase(profile.pubkey, absent, null), null)
  for (const content of ['{', 'null', '[]', '"string"']) {
    const newest = signed(content, 11)
    const snapshot = await readNostrProfileEditSnapshot(
      profile.pubkey,
      relays,
      async (_, __, on) => {
        on(profile)
        on(newest)
      },
    )
    assert.equal(snapshot.status, 'unusable')
    assert.equal(snapshot.event!.id, newest.id)
    assert.throws(() => selectNostrProfileEditBase(profile.pubkey, snapshot, profile), /unusable/)
  }
})

test('patch preserves arbitrary unrelated JSON and changes only supplied canonical fields', () => {
  const content =
    '{"name":"Old","display_name":"Alias","displayName":"Legacy","bio":"Alias bio","image":"alias.png","nip05":"claim","nested":{"__proto__":{"a":1},"array":[null,false,1e400,9007199254740993]},"__proto__":{"safe":true},"constructor":"value","about":"Old bio"}'
  const base = signed(content)
  const prepared = prepareNostrProfileEdit(base.pubkey, base, { name: 'New', about: '' }, 5)
  assert.equal(
    prepared.content,
    content.replace('"name":"Old"', '"name":"New"').replace('"about":"Old bio"', '"about":""'),
  )
  assert.equal(prepared.created_at, 11)
  assert.deepEqual(prepared.tags, [])
  assert.equal(({} as Record<string, unknown>).safe, undefined)
})

test('new profile and omitted canonical fields do not import display aliases', () => {
  const prepared = prepareNostrProfileEdit(
    profile.pubkey,
    null,
    { picture: 'https://image.example/a' },
    20,
  )
  assert.equal(prepared.content, '{"picture":"https://image.example/a"}')
  const base = signed('{ "display_name":"Alias", "bio":"Legacy", "nested":[{},[]] }')
  const edited = prepareNostrProfileEdit(base.pubkey, base, { name: 'Canonical' }, 20)
  assert.deepEqual(JSON.parse(edited.content), {
    display_name: 'Alias',
    bio: 'Legacy',
    nested: [{}, []],
    name: 'Canonical',
  })
})

test('selected relay failures refuse edit even with a retained newer event', async () => {
  const snapshot = await readNostrProfileEditSnapshot(
    profile.pubkey,
    relays,
    async (url, _, on) => {
      if (url === relays[1]) throw new Error('untrusted detail')
      on(profile)
    },
  )
  assert.equal(snapshot.failedRelayCount, 1)
  assert.throws(
    () => selectNostrProfileEditBase(profile.pubkey, snapshot, signed('{}', 99)),
    /completed/,
  )
})

test('retained newer metadata survives stale replies and timestamp ties use the lowest ID', async () => {
  const retained = signed('{"custom":{"preserve":true}}', 12)
  const snapshot = await readNostrProfileEditSnapshot(profile.pubkey, relays, async (_, __, on) =>
    on(profile),
  )
  assert.equal(selectNostrProfileEditBase(profile.pubkey, snapshot, retained)!.id, retained.id)
  const a = signed('{"a":1}', 12)
  const b = signed('{"b":2}', 12)
  const ties = await readNostrProfileEditSnapshot(profile.pubkey, relays, async (_, __, on) =>
    on(a),
  )
  assert.equal(selectNostrProfileEditBase(profile.pubkey, ties, b)!.id, a.id < b.id ? a.id : b.id)
  const newerUsable = await readNostrProfileEditSnapshot(
    profile.pubkey,
    relays,
    async (_, __, on) => on(signed('{', 11)),
  )
  assert.equal(selectNostrProfileEditBase(profile.pubkey, newerUsable, retained)!.id, retained.id)
})

test('patch and timestamp bounds fail before signing', () => {
  for (const patch of [
    {},
    { name: undefined },
    { name: 1 },
    { extra: 'value' },
    { about: 'a'.repeat(65_536) },
  ])
    assert.throws(() => validateNostrProfilePatch(patch), /patch|size/)
  for (const now of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(
      () => prepareNostrProfileEdit(profile.pubkey, null, { name: 'ok' }, now),
      /timestamp/,
    )
  assert.throws(
    () =>
      prepareNostrProfileEdit(
        profile.pubkey,
        signed('{}', Number.MAX_SAFE_INTEGER),
        { name: 'ok' },
        1,
      ),
    /timestamp/,
  )
  assert.throws(
    () => prepareNostrProfileEdit(profile.pubkey, signed('{'), { name: 'ok' }, 1),
    /base/,
  )
})

test('real signer response must match owner and exact intended event despite in-place request mutation', async () => {
  const prepared = prepareNostrProfileEdit(profile.pubkey, profile, { name: 'New' }, 20)
  const accepted = await signNostrProfileEdit(profile.pubkey, prepared, async (template) =>
    finalizeEvent(template, key),
  )
  assert.equal(accepted.content, prepared.content)
  assert.equal(decodeNostrProfileEditEvent(accepted, profile.pubkey)!.id, accepted.id)
  const mutations = [
    (template: typeof prepared) => ({ ...template, content: '{}' }),
    (template: typeof prepared) => ({ ...template, created_at: 21 }),
    (template: typeof prepared) => ({ ...template, kind: 1 }),
    (template: typeof prepared) => ({ ...template, tags: [['x', 'altered']] }),
  ]
  for (const mutate of mutations)
    await assert.rejects(
      signNostrProfileEdit(profile.pubkey, prepared, async (template) =>
        finalizeEvent(mutate(template), key),
      ),
      /signer/,
    )
  await assert.rejects(
    signNostrProfileEdit(profile.pubkey, prepared, async (template) => {
      template.content = '{}'
      return finalizeEvent(template, key)
    }),
    /signer/,
  )
  await assert.rejects(
    signNostrProfileEdit(profile.pubkey, prepared, async (template) =>
      finalizeEvent(template, new Uint8Array(32).fill(2)),
    ),
    /signer/,
  )
  await assert.rejects(
    signNostrProfileEdit(profile.pubkey, prepared, async () => ({
      ...accepted,
      sig: '00'.repeat(64),
    })),
    /signer/,
  )
  await assert.rejects(
    signNostrProfileEdit(profile.pubkey, prepared, async () => {
      throw new Error('Refused')
    }),
    /Refused/,
  )
})

test('retained validation clones tags and ignores cached signature verification', () => {
  const source = finalizeEvent(
    { kind: 0, created_at: 10, tags: [['x', 'original']], content: '{}' },
    key,
  )
  const decoded = decodeNostrProfileEditEvent(source, source.pubkey)!
  source.tags[0]![1] = 'changed'
  assert.equal(decoded.tags[0]![1], 'original')
  assert.equal(decodeNostrProfileEditEvent(source, source.pubkey), null)
  assert.equal(decodeNostrProfileEditEvent({ ...profile, content: '{}' }, profile.pubkey), null)
})

test('patch handles escaped keys, escaped quotes, duplicate canonical fields and nested delimiters', () => {
  const content =
    '{ "na\\u006de": "first", "nested":{"text":"a\\\"},[b","inner":[{"name":"nested"}]},"name":"last", "other\\\"key":true }'
  const base = signed(content)
  const prepared = prepareNostrProfileEdit(
    base.pubkey,
    base,
    { name: 'new "name"', picture: '' },
    20,
  )
  const parsed = JSON.parse(prepared.content)
  assert.equal(parsed.name, 'new "name"')
  assert.equal(parsed.picture, '')
  assert.equal(parsed.nested.inner[0].name, 'nested')
  assert.equal(parsed.nested.text, 'a"},[b')
  assert.equal(parsed['other"key'], true)
  assert.equal(prepared.content.includes('"first"'), false)
  assert.equal(prepared.content.includes('"last"'), false)
  assert.equal(prepared.content.includes('"na\\u006de"'), true)
})

test('content and escaped event envelope bounds apply to preparation and retained records', () => {
  const bounded = prepareNostrProfileEdit(profile.pubkey, null, { about: 'a'.repeat(65_520) }, 20)
  assert.ok(new TextEncoder().encode(bounded.content).byteLength <= MAX_NOSTR_PROFILE_CONTENT_BYTES)
  const accepted = finalizeEvent(bounded, key)
  assert.ok(
    new TextEncoder().encode(JSON.stringify(accepted)).byteLength <= MAX_NOSTR_PROFILE_EVENT_BYTES,
  )
  assert.ok(decodeNostrProfileEditEvent(accepted, profile.pubkey))
  assert.throws(
    () => prepareNostrProfileEdit(profile.pubkey, null, { name: '\\'.repeat(32_760) }, 20),
    /event size/,
  )
  const oversizedEnvelope = signed(JSON.stringify({ name: '\\'.repeat(32_760) }))
  assert.equal(decodeNostrProfileEditEvent(oversizedEnvelope, profile.pubkey), null)
  assert.equal(
    decodeNostrProfileEditEvent(
      signed(JSON.stringify({ about: 'a'.repeat(65_536) })),
      profile.pubkey,
    ),
    null,
  )
})

test('newest signed oversized content remains an unusable edit floor inside the transport bound', async () => {
  const newest = signed(' '.repeat(MAX_NOSTR_PROFILE_CONTENT_BYTES) + '{}', 11)
  const snapshot = await readNostrProfileEditSnapshot(profile.pubkey, relays, async (_, __, on) => {
    on(profile)
    on(newest)
  })
  assert.equal(snapshot.status, 'unusable')
  assert.equal(snapshot.event!.id, newest.id)
  assert.throws(() => selectNostrProfileEditBase(profile.pubkey, snapshot, null), /unusable/)
})

test('signed event inside transport bounds but above retained bounds remains an unusable newest base', async () => {
  const newest = signed(JSON.stringify({ name: '\\'.repeat(32_660) }), 11)
  const encode = new TextEncoder()
  assert.ok(encode.encode(JSON.stringify(newest)).byteLength > MAX_NOSTR_PROFILE_EVENT_BYTES)
  assert.ok(
    encode.encode(JSON.stringify(['EVENT', 'x', newest])).byteLength <=
      MAX_NOSTR_PROFILE_TRANSPORT_BYTES,
  )
  const snapshot = await readNostrProfileEditSnapshot(profile.pubkey, relays, async (_, __, on) => {
    on(profile)
    on(newest)
  })
  assert.equal(snapshot.status, 'unusable')
  assert.equal(snapshot.event!.id, newest.id)
  assert.throws(() => selectNostrProfileEditBase(profile.pubkey, snapshot, profile), /unusable/)
  assert.equal(decodeNostrProfileEditEvent(newest, profile.pubkey), null)
})

test('invalid retained records refuse rather than resetting the edit base', async () => {
  const snapshot = await readNostrProfileEditSnapshot(profile.pubkey, relays, async () => {})
  for (const retained of [
    signed('{'),
    signed('[]'),
    { ...profile, content: '{}' },
    signed('{}', -1),
  ])
    assert.throws(() => selectNostrProfileEditBase(profile.pubkey, snapshot, retained), /Retained/)
  assert.throws(() => prepareNostrProfileEdit('bad-owner', null, { name: 'new' }, 1), /public key/)
  assert.throws(() => prepareNostrProfileEdit('02'.repeat(32), profile, { name: 'new' }, 1), /base/)
})

test('edit reads query exact selected relay URLs and refuse total failure without exposing transport errors', async () => {
  const calls: string[] = []
  const selected = ['wss://relay.example/Path?Case=YES', 'wss://relay.example/Other']
  const result = await readNostrProfileEditSnapshot(
    profile.pubkey,
    selected,
    async (url, filter, on) => {
      calls.push(url)
      assert.deepEqual(filter, { kinds: [0], authors: [profile.pubkey], limit: 1 })
      on(profile)
      on({ ...signed('{}', 99), sig: '00'.repeat(64) })
    },
  )
  assert.deepEqual(calls, selected)
  assert.equal(result.event!.id, profile.id)
  await assert.rejects(
    readNostrProfileEditSnapshot(profile.pubkey, selected, async () => {
      throw new Error('private transport error')
    }),
    {
      message: 'Nostr profile read failed. Check the configured relays and retry.',
    },
  )
})

test('only an exact event OK boolean is an acknowledgment; relay text never enters the result', () => {
  assert.equal(
    decodeNostrProfileAcknowledgment(['OK', profile.id, true, 'private relay reason'], profile.id),
    'accepted',
  )
  assert.equal(
    decodeNostrProfileAcknowledgment(['OK', profile.id, false, 'private relay reason'], profile.id),
    'rejected',
  )
  for (const frame of [
    null,
    [],
    ['OK', 'wrong', true, ''],
    ['OK', profile.id, 'true', ''],
    ['OK', profile.id, true],
    ['OK', profile.id, true, 1],
    ['OK', profile.id, true, '', 'extra'],
    ['NOTICE', profile.id, true, ''],
  ])
    assert.equal(decodeNostrProfileAcknowledgment(frame, profile.id), null)
})

test('real signed events from another realm validate without changing crypto or accepting malformed tags', async () => {
  const foreign = runInNewContext(
    `JSON.parse(${JSON.stringify(JSON.stringify(profile))})`,
  ) as typeof profile
  assert.equal(foreign instanceof Object, false)
  assert.equal(decodeNostrProfileEditEvent(foreign, profile.pubkey)!.id, profile.id)
  const template = prepareNostrProfileEdit(profile.pubkey, foreign, { name: 'Other realm' }, 20)
  const verified = await signNostrProfileEdit(profile.pubkey, template, async (request) =>
    runInNewContext(`JSON.parse(${JSON.stringify(JSON.stringify(finalizeEvent(request, key)))})`),
  )
  assert.equal(verified.content, template.content)
  for (const tags of ['not-an-array', ['not-an-array'], [[42]], [null]])
    assert.equal(decodeNostrProfileEditEvent({ ...profile, tags }, profile.pubkey), null)
})
