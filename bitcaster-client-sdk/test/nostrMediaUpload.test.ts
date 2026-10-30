import { npubEncode } from 'nostr-tools/nip19'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { finalizeEvent, getPublicKey, verifyEvent, type EventTemplate } from 'nostr-tools/pure'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  uploadNostrProfileImage,
  readNostrProfileImage,
  NOSTR_PROFILE_IMAGE_DEADLINE_MS,
} from '../src/nostrMediaUpload.ts'

const key = new Uint8Array(32).fill(1)
const pubkey = getPublicKey(key)
const bytes = Uint8Array.from([137, 80, 78, 71])
const hash = bytesToHex(sha256(bytes))
const image = { bytes, type: 'image/png' as const, width: 1, height: 1 }
const blob = {
  url: `https://blossom.nostr.build/${hash}.png`,
  sha256: hash,
  size: bytes.length,
  type: image.type,
  uploaded: 1,
}
const signEvent = async (template: EventTemplate) => finalizeEvent(template, key)
const response = (value: unknown = blob) => new Response(JSON.stringify(value), { status: 201 })

test('upload binds actual bytes, action, host and short expiry; public read sends no authorization', async () => {
  const receipt = await uploadNostrProfileImage({
    image,
    publicKeyHex: pubkey,
    signEvent,
    fetch: async (url, init) => {
      assert.equal(url, 'https://blossom.nostr.build/upload')
      assert.equal(init?.method, 'PUT')
      assert.equal(init?.redirect, 'error')
      assert.equal(init?.credentials, 'omit')
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('X-SHA-256'), hash)
      const encoded = headers.get('authorization')!.slice(6)
      assert.match(encoded, /^[A-Za-z0-9_-]+$/)
      const event = JSON.parse(Buffer.from(encoded, 'base64url').toString())
      assert.equal(verifyEvent(event), true)
      assert.equal(event.kind, 24242)
      assert.equal(event.pubkey, pubkey)
      assert.deepEqual(event.tags.slice(0, 3), [
        ['t', 'upload'],
        ['x', hash],
        ['server', 'blossom.nostr.build'],
      ])
      assert.equal(Number(event.tags[3][1]) - event.created_at, 121)
      assert.equal(bytesToHex(sha256(init!.body as Uint8Array)), hash)
      return response()
    },
  })
  assert.equal(receipt.publicKeyHex, pubkey)
  const read = await readNostrProfileImage(receipt, {
    fetch: async (url, init) => {
      assert.equal(url, `https://image.nostr.build/${hash}.png`)
      assert.equal(init?.redirect, 'error')
      assert.equal(init?.credentials, 'omit')
      assert.equal(new Headers(init?.headers).has('authorization'), false)
      return new Response(bytes, { headers: { 'content-type': image.type } })
    },
  })
  assert.equal(bytesToHex(sha256(read)), hash)
})

for (const mutation of ['identity', 'tags', 'content', 'signature'] as const) {
  test(`rejects signer ${mutation} tampering before network`, async () => {
    let calls = 0
    await assert.rejects(
      uploadNostrProfileImage({
        image,
        publicKeyHex: pubkey,
        signEvent: async (template) => {
          const event = finalizeEvent(
            template,
            mutation === 'identity' ? new Uint8Array(32).fill(2) : key,
          )
          if (mutation === 'tags') event.tags = [['t', 'upload']]
          if (mutation === 'content') event.content = 'Different request'
          if (mutation === 'signature') event.sig = '0'.repeat(128)
          return event
        },
        fetch: async () => {
          calls++
          return response()
        },
      }),
      { code: 'invalid-authorization' },
    )
    assert.equal(calls, 0)
  })
}

for (const altered of [
  { sha256: '0'.repeat(64) },
  { size: 2 },
  { type: 'image/jpeg' },
  { url: `https://evil.example/${hash}.png` },
  { url: `https://user:pass@blossom.nostr.build/${hash}.png` },
  { url: `https://blossom.nostr.build/other.png` },
  { uploaded: -1 },
]) {
  test(`rejects invalid descriptor ${Object.keys(altered)[0]} ${JSON.stringify(altered).slice(0, 60)}`, async () => {
    await assert.rejects(
      uploadNostrProfileImage({
        image,
        publicKeyHex: pubkey,
        signEvent,
        fetch: async () => response({ ...blob, ...altered }),
      }),
      { code: 'invalid-response' },
    )
  })
}

for (const [status, code] of [
  [402, 'payment-required'],
  [429, 'rate-limited'],
  [503, 'http-error'],
] as const) {
  test(`${status} stops without retries or payment`, async () => {
    let calls = 0
    await assert.rejects(
      uploadNostrProfileImage({
        image,
        publicKeyHex: pubkey,
        signEvent,
        fetch: async () => {
          calls++
          return new Response('private provider diagnostics', { status })
        },
      }),
      { code, status },
    )
    assert.equal(calls, 1)
  })
}

test('bounds descriptor bytes and rejects malformed JSON', async () => {
  for (const data of ['x'.repeat(16385), '{broken']) {
    await assert.rejects(
      uploadNostrProfileImage({
        image,
        publicKeyHex: pubkey,
        signEvent,
        fetch: async () => new Response(data, { status: 201 }),
      }),
      { code: 'invalid-response' },
    )
  }
})

test('cancelled signer cannot upload after its late completion', async () => {
  const controller = new AbortController()
  let release!: (event: ReturnType<typeof finalizeEvent>) => void
  let template!: EventTemplate
  let calls = 0
  const task = uploadNostrProfileImage({
    image,
    publicKeyHex: pubkey,
    signal: controller.signal,
    signEvent: (event) => {
      template = event
      return new Promise((resolve) => {
        release = resolve
      })
    },
    fetch: async () => {
      calls++
      return response()
    },
  })
  controller.abort()
  await assert.rejects(task, { code: 'cancelled' })
  release(finalizeEvent(template, key))
  // Drain the signer continuation; its first action must check the aborted signal.
  await Promise.resolve()
  assert.equal(calls, 0)
})

test('two-minute deadline settles an uncooperative signer using a controlled clock', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let release!: (event: ReturnType<typeof finalizeEvent>) => void
  let template!: EventTemplate
  const task = uploadNostrProfileImage({
    image,
    publicKeyHex: pubkey,
    signEvent: (event) => {
      template = event
      return new Promise((resolve) => {
        release = resolve
      })
    },
    fetch: async () => {
      assert.fail('expired authorization must not upload')
    },
  })
  context.mock.timers.tick(NOSTR_PROFILE_IMAGE_DEADLINE_MS)
  await assert.rejects(task, { code: 'deadline' })
  release(finalizeEvent(template, key))
  await Promise.resolve()
})

test('rejects oversized and altered public content', async () => {
  const receipt = { ...blob, publicKeyHex: pubkey }
  for (const content of [new Uint8Array(5), new Uint8Array(4)]) {
    await assert.rejects(
      readNostrProfileImage(receipt, {
        fetch: async () => new Response(content, { headers: { 'content-type': image.type } }),
      }),
      { code: 'invalid-response' },
    )
  }
})

test('rejects invalid normalized inputs before signing', async () => {
  for (const invalid of [
    { ...image, width: 1025 },
    { ...image, bytes: new Uint8Array(0) },
    { ...image, bytes: new Uint8Array(5 * 1024 * 1024 + 1) },
  ]) {
    await assert.rejects(
      uploadNostrProfileImage({
        image: invalid,
        publicKeyHex: pubkey,
        signEvent: async () => {
          assert.fail('invalid image must not sign')
        },
      }),
      { code: 'invalid-image' },
    )
  }
})

test('cancellation closes a stalled descriptor stream', async () => {
  const controller = new AbortController()
  let started!: () => void
  let closed!: () => void
  const reading = new Promise<void>((resolve) => {
    started = resolve
  })
  const cancelled = new Promise<void>((resolve) => {
    closed = resolve
  })
  const task = uploadNostrProfileImage({
    image,
    publicKeyHex: pubkey,
    signEvent,
    signal: controller.signal,
    fetch: async () =>
      new Response(
        new ReadableStream({
          pull() {
            started()
          },
          cancel() {
            closed()
          },
        }),
        { status: 201 },
      ),
  })
  try {
    await reading
    controller.abort()
    await assert.rejects(task, { code: 'cancelled' })
    await cancelled
  } finally {
    controller.abort()
    await task.catch(() => {})
  }
})

test('upload snapshots image bytes before external signer work', async () => {
  const mutable = Uint8Array.from(bytes)
  await uploadNostrProfileImage({
    image: { ...image, bytes: mutable },
    publicKeyHex: pubkey,
    signEvent: async (template) => {
      mutable.fill(0)
      return signEvent(template)
    },
    fetch: async (_url, init) => {
      assert.equal(bytesToHex(sha256(init!.body as Uint8Array)), hash)
      return response()
    },
  })
})

test('accepts only the exact signer-owned provider CDN origin for upload and read', async () => {
  const url = `https://${npubEncode(pubkey)}.blossom.band/${hash}.png`
  const receipt = await uploadNostrProfileImage({
    image,
    publicKeyHex: pubkey,
    signEvent,
    fetch: async () => response({ ...blob, url }),
  })
  assert.equal(receipt.url, url)
  await readNostrProfileImage(receipt, {
    fetch: async (request, init) => {
      assert.equal(request, `https://image.nostr.build/${hash}.png`)
      assert.equal(init?.redirect, 'error')
      assert.equal(init?.credentials, 'omit')
      assert.equal(new Headers(init?.headers).has('authorization'), false)
      return new Response(bytes, { headers: { 'content-type': image.type } })
    },
  })
  const otherPubkey = getPublicKey(new Uint8Array(32).fill(2))
  let calls = 0
  await assert.rejects(
    readNostrProfileImage(
      { ...receipt, publicKeyHex: otherPubkey },
      {
        fetch: async () => {
          calls++
          return new Response(bytes)
        },
      },
    ),
    { code: 'invalid-response' },
  )
  assert.equal(calls, 0)
  for (const origin of [
    `https://${npubEncode(otherPubkey)}.blossom.band`,
    `https://${npubEncode(pubkey)}.blossom.band.evil.example`,
    'https://custom.blossom.band',
  ]) {
    await assert.rejects(
      uploadNostrProfileImage({
        image,
        publicKeyHex: pubkey,
        signEvent,
        fetch: async () => response({ ...blob, url: `${origin}/${hash}.png` }),
      }),
      { code: 'invalid-response' },
    )
  }
})

test('public CDN redirects are not followed and receipt cannot select a different CDN', async () => {
  let calls = 0
  await assert.rejects(
    readNostrProfileImage(
      { ...blob, publicKeyHex: pubkey },
      {
        fetch: async (_url, init) => {
          calls++
          assert.equal(init?.redirect, 'error')
          return new Response(null, {
            status: 307,
            headers: { location: 'https://evil.example/image.png' },
          })
        },
      },
    ),
    { code: 'invalid-response' },
  )
  assert.equal(calls, 1)
  for (const url of [`https://image.nostr.build/${hash}.png`, `https://evil.example/${hash}.png`]) {
    await assert.rejects(
      readNostrProfileImage(
        { ...blob, url, publicKeyHex: pubkey },
        {
          fetch: async () => {
            assert.fail('only original provider or signer-owned descriptor URLs are accepted')
          },
        },
      ),
      { code: 'invalid-response' },
    )
  }
})
