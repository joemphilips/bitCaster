import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { BitcasterEngineClient } from '../src/engineClient.ts'
import {
  createMarketViaEngine,
  parseCreateMarketResponse,
  submitOracleAttestationViaEngine,
} from '../src/marketLifecycle.ts'
import { signNip98 } from '../../bitcaster-daemon/src/nostrAuth.ts'

const TEST_NOSTR_PRIVATE_KEY = `${'0'.repeat(62)}01`

test('createMarketViaEngine signs a NIP-98 payload tag for the exact serialized multipart bytes', async () => {
  let authPayloadHash: string | undefined
  let sentBodyHash: string | undefined
  let sentContentType: string | null = null
  let sentBodyText = ''
  const requests: Array<{ url: string; auth: string | null }> = []
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example/',
    authorization: ({ url, method, bodyText, payloadHash }) => {
      assert.equal(url, 'https://engine.example/api/v1/markets/cond%2F1')
      assert.equal(method, 'POST')
      assert.equal(bodyText, undefined)
      authPayloadHash = payloadHash
      return makeNip98LikeHeader({
        url,
        method,
        payloadHash: payloadHash ?? (bodyText ? sha256Utf8Hex(bodyText) : undefined),
      })
    },
    fetchImpl: async (input, init) => {
      const headers = new Headers(init?.headers)
      sentContentType = headers.get('content-type')
      const body = init?.body
      assert.ok(body instanceof ArrayBuffer)
      sentBodyHash = await sha256Hex(body)
      sentBodyText = new TextDecoder().decode(body)
      requests.push({
        url: String(input),
        auth: headers.get('authorization'),
      })
      return new Response(
        JSON.stringify({
          conditionId: 'cond/1',
          marketsCreated: ['cond/1-Yes', 'cond/1-No'],
          baseAsset: 'sat',
          thumbnailUrl: null,
          divisibility: 10000,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  })

  const response = await createMarketViaEngine(
    client,
    'cond/1',
    {
      title: 'Will it rain?',
      description: 'Weather market',
      outcomes: [
        { name: 'Yes', probability: 50 },
        { name: 'No', probability: 50 },
      ],
      baseAsset: 'sat',
      liquiditySats: 0,
    },
    {
      data: new Uint8Array([1, 2, 3]),
      filename: 'thumb.png',
      contentType: 'image/png',
    },
  )

  assert.equal(authPayloadHash, sentBodyHash)
  assert.match(sentContentType ?? '', /^multipart\/form-data; boundary=/)
  assert.match(sentBodyText, /name="thumbnail"; filename="thumb\.png"\r\nContent-Type: image\/png/)
  assert.equal(readNip98PayloadTag(requests[0]?.auth), sentBodyHash)
  assert.deepEqual(requests, [
    {
      url: 'https://engine.example/api/v1/markets/cond%2F1',
      auth: makeNip98LikeHeader({
        url: 'https://engine.example/api/v1/markets/cond%2F1',
        method: 'POST',
        payloadHash: sentBodyHash,
      }),
    },
  ])
  assert.deepEqual(response.marketsCreated, ['cond/1-Yes', 'cond/1-No'])
})

test('createMarketViaEngine can use the daemon NIP-98 signer for exact multipart bytes', async () => {
  let sentBodyHash: string | undefined
  let sentAuthorization: string | null = null
  const url = 'https://engine.example/api/v1/markets/cond%2Freal-signer'
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example/',
    authorization: ({ url, method, bodyText, payloadHash }) => {
      assert.equal(bodyText, undefined)
      assert.ok(payloadHash, 'multipart requests must provide a precomputed payload hash')
      return signNip98(
        { privateKeyHex: TEST_NOSTR_PRIVATE_KEY },
        url,
        method,
        bodyText,
        payloadHash,
      )
    },
    fetchImpl: async (input, init) => {
      assert.equal(String(input), url)
      const body = init?.body
      assert.ok(body instanceof ArrayBuffer)
      sentBodyHash = await sha256Hex(body)
      sentAuthorization = new Headers(init?.headers).get('authorization')
      return new Response(
        JSON.stringify({
          conditionId: 'cond/real-signer',
          marketsCreated: ['cond/real-signer-Yes', 'cond/real-signer-No'],
          baseAsset: 'sat',
          thumbnailUrl: null,
          divisibility: 10000,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  })

  await createMarketViaEngine(
    client,
    'cond/real-signer',
    {
      title: 'Will real NIP-98 bind the body?',
      description: 'Signer integration market',
      outcomes: [
        { name: 'Yes', probability: 50 },
        { name: 'No', probability: 50 },
      ],
      baseAsset: 'sat',
      liquiditySats: 0,
    },
    {
      data: new Uint8Array([9, 8, 7, 6]),
      filename: 'real-signer.png',
      contentType: 'image/png',
    },
  )

  const event = decodeNip98Header(sentAuthorization)
  assert.equal(event.kind, 27235)
  assert.equal(readTag(event, 'u'), url)
  assert.equal(readTag(event, 'method'), 'POST')
  assert.equal(readTag(event, 'payload'), sentBodyHash)
})

test('parseCreateMarketResponse requires canonical product metadata', () => {
  const valid = {
    conditionId: 'condition',
    marketsCreated: ['condition-Yes', 'condition-No'],
    baseAsset: 'sat',
    divisibility: 10_000,
  }
  assert.deepEqual(parseCreateMarketResponse(valid), valid)
  for (const key of ['baseAsset', 'divisibility'] as const) {
    const incomplete: Record<string, unknown> = { ...valid }
    delete incomplete[key]
    assert.throws(() => parseCreateMarketResponse(incomplete), /omitted canonical product metadata/)
  }
  assert.throws(
    () => parseCreateMarketResponse({ ...valid, baseAsset: 'usd' }),
    /omitted canonical product metadata/,
  )
})

test('submitOracleAttestationViaEngine posts self-authenticating JSON without authorization', async () => {
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    authorization: () => {
      throw new Error('oracle attestation must not request NIP-98 auth')
    },
    fetchImpl: async (input, init) => {
      const headers = new Headers(init?.headers)
      assert.equal(
        String(input),
        'https://engine.example/api/v1/markets/condition-1/oracle-attestation',
      )
      assert.equal(headers.get('authorization'), null)
      assert.equal(headers.get('content-type'), 'application/json')
      assert.equal(
        init?.body,
        JSON.stringify({
          id: 'a'.repeat(64),
          pubkey: 'b'.repeat(64),
          createdAt: 1,
          kind: 89,
          tags: [],
          content: 'payload',
          sig: 'c'.repeat(128),
        }),
      )
      return new Response(JSON.stringify({ result: 'Closed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  assert.deepEqual(
    await submitOracleAttestationViaEngine(client, 'condition-1', {
      id: 'a'.repeat(64),
      pubkey: 'b'.repeat(64),
      createdAt: 1,
      kind: 89,
      tags: [],
      content: 'payload',
      sig: 'c'.repeat(128),
    }),
    { result: 'Closed' },
  )
})

async function sha256Hex(data: BufferSource): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function sha256Utf8Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function makeNip98LikeHeader(input: { url: string; method: string; payloadHash?: string }): string {
  const tags = [
    ['u', input.url],
    ['method', input.method.toUpperCase()],
  ]
  if (input.payloadHash) tags.push(['payload', input.payloadHash])
  return `Nostr ${Buffer.from(JSON.stringify({ kind: 27235, tags })).toString('base64')}`
}

function readNip98PayloadTag(header: string | null | undefined): string | undefined {
  assert.ok(header?.startsWith('Nostr '))
  const event = decodeNip98Header(header)
  return event.tags?.find((tag) => tag[0] === 'payload')?.[1]
}

function decodeNip98Header(header: string | null | undefined): {
  kind?: number
  tags?: string[][]
} {
  assert.ok(header?.startsWith('Nostr '))
  return JSON.parse(Buffer.from(header.slice('Nostr '.length), 'base64').toString('utf8')) as {
    kind?: number
    tags?: string[][]
  }
}

function readTag(event: { tags?: string[][] }, name: string): string | undefined {
  return event.tags?.find((tag) => tag[0] === name)?.[1]
}
