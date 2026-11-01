import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_NIP05_RESPONSE_BYTES,
  NIP05_TIMEOUT_MS,
  parseNip05Address,
  verifyNip05Address,
  type Nip05VerificationOptions,
} from '../src/nip05Verification.ts'

const pubkey = 'ab'.repeat(32)

function fakeFetch(respond: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return respond(String(input), init ?? {})
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

const json = (value: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    ...init,
  })

// The URL parser reads a numeric or 0x last label as IPv4, and these names are local by syntax.
const localHostAddresses = [
  '_@127.0x1',
  '_@0x7f.0x1',
  '_@192.168.0x1',
  '_@10.0.0.1',
  '_@1.0x',
  '_@x.localhost',
  '_@printer.local',
  '_@db.internal',
  '_@router.home.arpa',
  '_@home.arpa',
  '_@nas.lan',
]

test('address parser lowercases a valid address and rejects hosts that are not public domains', () => {
  assert.deepEqual(parseNip05Address(' Alice@Example.COM '), {
    name: 'alice',
    domain: 'example.com',
  })
  assert.deepEqual(parseNip05Address('_@example.com'), { name: '_', domain: 'example.com' })
  for (const value of [
    'alice',
    'alice@',
    '@example.com',
    'a@b@example.com',
    'al ice@example.com',
    'alice@localhost',
    'alice@127.0.0.1',
    'alice@[::1]',
    'alice@example.com:8443',
    'alice@example.com/path',
    'alice@-example.com',
    'alice@example',
    `alice@${'a'.repeat(250)}.com`,
    42,
    ...localHostAddresses,
  ])
    assert.equal(parseNip05Address(value), null, String(value).slice(0, 40))
})

test('verifies when the well-known names map the local part to the key, without redirects or credentials', async () => {
  const { fetch, calls } = fakeFetch(() => json({ names: { alice: pubkey } }))
  assert.equal(await verifyNip05Address('Alice@Example.com', pubkey, { fetch }), true)
  assert.equal(calls[0]!.url, 'https://example.com/.well-known/nostr.json?name=alice')
  assert.equal(calls[0]!.init.redirect, 'error')
  assert.equal(calls[0]!.init.credentials, 'omit')
  assert.equal(calls[0]!.init.referrerPolicy, 'no-referrer')
})

test('does not verify a mismatch, an error status, a redirect, a large body or malformed JSON', async () => {
  const cases: Array<[string, () => Response | Promise<Response>]> = [
    ['other key', () => json({ names: { alice: 'cd'.repeat(32) } })],
    ['missing name', () => json({ names: { bob: pubkey } })],
    ['names not object', () => json({ names: [pubkey] })],
    ['status', () => json({ names: { alice: pubkey } }, { status: 404 })],
    [
      'redirect',
      () => {
        throw new TypeError('redirect mode is set to error')
      },
    ],
    [
      'declared large body',
      () =>
        new Response('{}', {
          headers: { 'content-length': String(MAX_NIP05_RESPONSE_BYTES + 1) },
        }),
    ],
    [
      'streamed large body',
      () =>
        new Response(
          JSON.stringify({ names: { alice: pubkey }, pad: 'x'.repeat(MAX_NIP05_RESPONSE_BYTES) }),
        ),
    ],
    ['malformed', () => new Response('{')],
  ]
  for (const [name, respond] of cases) {
    const { fetch } = fakeFetch(respond)
    assert.equal(await verifyNip05Address('alice@example.com', pubkey, { fetch }), false, name)
  }
})

test('a timeout aborts the request and does not verify', async () => {
  let fire!: () => void
  let observed!: AbortSignal
  const options: Nip05VerificationOptions = {
    fetch: ((_input: string | URL | Request, init?: RequestInit) => {
      observed = init!.signal!
      return new Promise<Response>((_, reject) =>
        observed.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      )
    }) as typeof globalThis.fetch,
    setTimer: (callback, ms) => {
      assert.equal(ms, NIP05_TIMEOUT_MS)
      fire = callback
      return 1
    },
    clearTimer: () => {},
  }
  // The request and its timer start synchronously, before the first await.
  const result = verifyNip05Address('alice@example.com', pubkey, options)
  fire()
  assert.equal(await result, false)
  assert.equal(observed.aborted, true)
})

test('an invalid address, an invalid key or a cancelled read makes no request', async () => {
  const { fetch, calls } = fakeFetch(() => json({ names: { alice: pubkey } }))
  const controller = new AbortController()
  controller.abort()
  assert.equal(await verifyNip05Address('alice@localhost', pubkey, { fetch }), false)
  for (const address of localHostAddresses)
    assert.equal(await verifyNip05Address(address, pubkey, { fetch }), false, address)
  assert.equal(await verifyNip05Address('alice@example.com', 'AB'.repeat(32), { fetch }), false)
  assert.equal(
    await verifyNip05Address('alice@example.com', pubkey, { fetch, signal: controller.signal }),
    false,
  )
  assert.equal(calls.length, 0)
})
