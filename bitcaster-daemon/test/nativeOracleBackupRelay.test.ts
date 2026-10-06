import assert from 'node:assert/strict'
import { test } from 'node:test'
import { finalizeEvent } from 'nostr-tools/pure'
import {
  queryNativeOracleBackupRelay,
  publishNativeOracleBackupEvent,
  type NativeOracleBackupRelayFactory,
} from '../src/nativeOracleBackupRelay.ts'

function transport(
  frames: unknown[],
  options: { syntheticEose?: boolean; failConnect?: boolean; failPublish?: boolean } = {},
) {
  let closed = 0,
    subscriptionsClosed = 0,
    published = 0
  const factory: NativeOracleBackupRelayFactory = (_url, config) => ({
    async connect() {
      if (options.failConnect) throw new Error('Private transport detail.')
    },
    subscribe(_filters, handlers) {
      setImmediate(() => {
        for (const frame of frames) {
          if (!config.acceptMessage!(JSON.stringify(frame))) {
            config.onclose?.()
            return
          }
          if (Array.isArray(frame) && frame[0] === 'EOSE' && frame[1] === 'owned')
            handlers.oneose?.()
        }
        if (options.syntheticEose) handlers.oneose?.()
      })
      return {
        id: 'owned',
        close() {
          subscriptionsClosed++
        },
      }
    },
    async publish() {
      published++
      if (options.failPublish) throw new Error('Private transport detail.')
    },
    close() {
      closed++
      config.onclose?.()
    },
  })
  return { factory, counts: () => ({ closed, subscriptionsClosed, published }) }
}
function request(maxEvents = 32, maxBytes = 1024 * 1024) {
  return {
    relayUrl: 'wss://relay.example',
    filter: { kinds: [30078], authors: ['01'.repeat(32)], '#v': ['1'], limit: maxEvents },
    signal: new AbortController().signal,
    maxEvents,
    maxBytes,
  }
}

test('native backup transport returns raw invalid and duplicate candidates and closes at real owned EOSE', async () => {
  const bad = { id: 'bad', sig: 'bad' }
  const fake = transport([
    ['EVENT', 'owned', bad],
    ['EVENT', 'owned', bad],
    ['EOSE', 'owned'],
  ])
  assert.deepEqual(await queryNativeOracleBackupRelay(request(), fake.factory), {
    events: [bad, bad],
    complete: true,
  })
  assert.equal(fake.counts().closed, 1)
  assert.equal(fake.counts().subscriptionsClosed, 2)
})

test('native backup transport bounds raw candidates before filtering and leaves overflow incomplete', async () => {
  const fake = transport([
    ['EVENT', 'owned', null],
    ['EVENT', 'owned', null],
    ['EVENT', 'owned', null],
    ['EOSE', 'owned'],
  ])
  assert.deepEqual(await queryNativeOracleBackupRelay(request(2), fake.factory), {
    events: [null, null],
    complete: false,
  })
  assert.equal(fake.counts().closed, 1)
})

test('native backup transport bounds bytes and frames independently of valid events', async () => {
  for (const frames of [
    [['NOTICE', 'x'.repeat(1024)]],
    Array.from({ length: 513 }, () => ['NOTICE', 'x']),
  ]) {
    const fake = transport([...frames, ['EOSE', 'owned']])
    const result = await queryNativeOracleBackupRelay(
      request(32, frames.length === 1 ? 100 : 1024 * 1024),
      fake.factory,
    )
    assert.equal(result.complete, false)
    assert.deepEqual(result.events, [])
    assert.equal(fake.counts().closed, 1)
  }
})

test('native backup transport does not treat a local subscription timeout or unrelated EOSE as observed completion', async () => {
  for (const frames of [[], [['EOSE', 'foreign']]]) {
    const fake = transport(frames, { syntheticEose: true })
    assert.equal((await queryNativeOracleBackupRelay(request(), fake.factory)).complete, false)
    assert.equal(fake.counts().closed, 1)
  }
})

test('native backup transport abort and connection failure close the owner', async () => {
  const aborted = new AbortController()
  aborted.abort()
  const fake = transport([])
  assert.equal(
    (await queryNativeOracleBackupRelay({ ...request(), signal: aborted.signal }, fake.factory))
      .complete,
    false,
  )
  assert.equal(fake.counts().closed, 1)
  const failed = transport([], { failConnect: true })
  assert.equal((await queryNativeOracleBackupRelay(request(), failed.factory)).complete, false)
  assert.equal(failed.counts().closed, 1)
})

test('native backup publication is separate from public oracle kinds and uses exact strict deletion bytes', async () => {
  const key = Buffer.from('01'.repeat(32), 'hex')
  const deletion = finalizeEvent(
    {
      kind: 5,
      created_at: 100,
      tags: [
        ['e', '02'.repeat(32)],
        ['k', '30078'],
      ],
      content: '',
    },
    key,
  )
  const fake = transport([])
  assert.deepEqual(
    await publishNativeOracleBackupEvent(
      'wss://relay.example',
      JSON.stringify(deletion),
      fake.factory,
    ),
    { eventId: deletion.id, relayUrl: 'wss://relay.example' },
  )
  assert.deepEqual(fake.counts(), { published: 1, closed: 1, subscriptionsClosed: 0 })
  for (const event of [
    finalizeEvent({ kind: 88, created_at: 100, tags: [], content: '' }, key),
    finalizeEvent({ kind: 30078, created_at: 100, tags: [], content: 'bad' }, key),
    finalizeEvent(
      {
        kind: 5,
        created_at: 100,
        tags: [
          ['e', '02'.repeat(32)],
          ['k', '30078'],
        ],
        content: 'bad',
      },
      key,
    ),
  ])
    await assert.rejects(
      publishNativeOracleBackupEvent('wss://relay.example', JSON.stringify(event), fake.factory),
      /Stored oracle backup event is invalid/,
    )
  assert.equal(fake.counts().published, 1)
  const failed = transport([], { failPublish: true })
  await assert.rejects(
    publishNativeOracleBackupEvent('wss://relay.example', JSON.stringify(deletion), failed.factory),
    /did not acknowledge/,
  )
  assert.equal(failed.counts().closed, 1)
})
