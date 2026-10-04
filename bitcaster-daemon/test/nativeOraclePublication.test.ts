import assert from 'node:assert/strict'
import { test } from 'node:test'
import { finalizeEvent } from 'nostr-tools/pure'
import { createOracleExplanationTemplate } from '@bitcaster-market/client-sdk'
import { publishNativeOracleEvent } from '../src/nativeOraclePublication.ts'

const event = finalizeEvent(
  {
    kind: 88,
    created_at: 1_900_000_000,
    tags: [['title', 'Weather']],
    content: 'public-announcement',
  },
  new Uint8Array(32).fill(1),
)

test('companion relay publication requires the exact signed root and parent context', async () => {
  const attestation = finalizeEvent(
    { kind: 89, created_at: 1_900_000_001, tags: [['e', event.id]], content: 'Ag==' },
    new Uint8Array(32).fill(1),
  )
  const context = {
    oraclePubkey: event.pubkey,
    announcementEventJson: JSON.stringify(event),
    attestationEventJson: JSON.stringify(attestation),
  }
  const explanation = finalizeEvent(
    createOracleExplanationTemplate(context, 'Plain <b>text</b>.', 1_900_000_002),
    new Uint8Array(32).fill(1),
  )
  let factories = 0
  const factory = () => {
    factories++
    return {
      publishTimeout: 0,
      async connect() {},
      async publish(sent: typeof explanation) {
        assert.deepEqual(sent, explanation)
        return ''
      },
      close() {},
    }
  }
  await assert.rejects(
    publishNativeOracleEvent(['wss://relay.example'], JSON.stringify(explanation), factory),
    /Stored oracle event is invalid/,
  )
  assert.equal(factories, 0)
  const result = await publishNativeOracleEvent(
    ['wss://relay.example'],
    JSON.stringify(explanation),
    factory,
    context,
  )
  assert.equal(result.eventId, explanation.id)
  assert.equal(factories, 1)
  const foreign = finalizeEvent(
    {
      ...explanation,
      tags: [['E', '00'.repeat(32), '', event.pubkey], ...explanation.tags.slice(1)],
    },
    new Uint8Array(32).fill(1),
  )
  await assert.rejects(
    publishNativeOracleEvent(['wss://relay.example'], JSON.stringify(foreign), factory, context),
    /Stored oracle event is invalid/,
  )
  assert.equal(factories, 1)
})

test('oracle publication refuses more than the durable creation relay bound before transport', async () => {
  let factories = 0
  await assert.rejects(
    publishNativeOracleEvent(
      Array.from({ length: 65 }, (_, index) => `wss://relay-${index}.example`),
      JSON.stringify(event),
      () => {
        factories++
        throw new Error('No transport can start.')
      },
    ),
    /At most 64 oracle relays/,
  )
  assert.equal(factories, 0)
})

test('oracle publication requires a real acknowledgement and closes every relay', async () => {
  const closed: string[] = []
  const published: string[] = []
  const result = await publishNativeOracleEvent(
    ['wss://offline.example', 'wss://ready.example', 'wss://ready.example/'],
    JSON.stringify(event),
    (url) => ({
      publishTimeout: 0,
      async connect() {
        if (url.includes('offline')) throw new Error('connection failed')
      },
      async publish(sent) {
        assert.equal(sent.id, event.id)
        assert.equal(sent.sig, event.sig)
        published.push(url)
        return ''
      },
      close() {
        closed.push(url)
      },
    }),
  )
  assert.deepEqual(result, {
    eventId: event.id,
    acceptedRelays: ['wss://ready.example/'],
    rejectedRelayCount: 1,
  })
  assert.deepEqual(published, ['wss://ready.example/'])
  assert.deepEqual(closed.sort(), ['wss://offline.example/', 'wss://ready.example/'])
})

test('connection failures and relay rejections never report successful oracle publication', async () => {
  for (const stage of ['connect', 'publish']) {
    let closed = false
    await assert.rejects(
      publishNativeOracleEvent(['wss://relay.example'], JSON.stringify(event), () => ({
        publishTimeout: 0,
        async connect() {
          if (stage === 'connect') throw new Error('untrusted response')
        },
        async publish() {
          throw new Error('untrusted response')
        },
        close() {
          closed = true
        },
      })),
      /^Error: No relay acknowledged/,
    )
    assert.equal(closed, true)
  }
})

test('oracle publication bounds active relays and attempts every normalized relay', async () => {
  const relayUrls = Array.from({ length: 11 }, (_, index) => `wss://relay-${index}.example`)
  const attempted: string[] = []
  let active = 0
  let maxActive = 0

  const result = await publishNativeOracleEvent(relayUrls, JSON.stringify(event), (url) => {
    attempted.push(url)
    active += 1
    maxActive = Math.max(maxActive, active)
    return {
      publishTimeout: 0,
      async connect() {
        await new Promise<void>((resolve) => setImmediate(resolve))
      },
      async publish(sent) {
        assert.equal(sent.id, event.id)
        return event.id
      },
      close() {
        active -= 1
      },
    }
  })

  const normalizedRelayUrls = relayUrls.map((url) => `${url}/`)
  assert.equal(maxActive, 4)
  assert.deepEqual([...attempted].sort(), [...normalizedRelayUrls].sort())
  assert.deepEqual(result, {
    eventId: event.id,
    acceptedRelays: normalizedRelayUrls,
    rejectedRelayCount: 0,
  })
})

test('oracle publication refuses malformed events and relay inputs before network work', async () => {
  const factory = () => {
    throw new Error('network must not start')
  }
  for (const json of ['{', 'null', JSON.stringify({ ...event, content: 'tampered' })]) {
    await assert.rejects(
      publishNativeOracleEvent(['wss://relay.example'], json, factory),
      /Stored oracle event is invalid/,
    )
  }
  for (const relays of [[], ['https://relay.example'], ['wss://user:password@relay.example']]) {
    await assert.rejects(publishNativeOracleEvent(relays, JSON.stringify(event), factory), /relay/i)
  }
})
