import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { BitcasterEngineClient } from '../src/engineClient.ts'
import { createPreparedMarketViaEngine, type CreateMarketRequest } from '../src/marketLifecycle.ts'
import { MAX_MARKET_CREATION_METADATA_JSON_CODE_UNITS } from '../src/marketCreationInput.ts'
import {
  MAX_MARKET_CREATION_REQUEST_BYTES,
  MAX_MARKET_CREATION_THUMBNAIL_BYTES,
  prepareMarketCreationRequest,
} from '../src/marketCreationRequest.ts'

const metadata: CreateMarketRequest = {
  title: 'Title',
  description: 'Description',
  outcomes: [{ name: 'Yes' }, { name: 'No' }],
  baseAsset: 'sat',
}

test('supported thumbnail and exact metadata limit serialize below the total bound', async () => {
  const bounded = { ...metadata, description: '' }
  bounded.description = 'x'.repeat(
    MAX_MARKET_CREATION_METADATA_JSON_CODE_UNITS - JSON.stringify(bounded).length,
  )
  assert.equal(JSON.stringify(bounded).length, MAX_MARKET_CREATION_METADATA_JSON_CODE_UNITS)
  const prepared = await prepareMarketCreationRequest(bounded, {
    data: new Uint8Array(MAX_MARKET_CREATION_THUMBNAIL_BYTES),
    filename: 'original.png',
    contentType: 'image/png',
  })
  assert.ok(prepared.bodyBytes.byteLength <= MAX_MARKET_CREATION_REQUEST_BYTES)
})

test('file, UTF-16 metadata, and actual multipart overflow reject separately', async () => {
  await assert.rejects(
    prepareMarketCreationRequest(metadata, {
      data: new Uint8Array(MAX_MARKET_CREATION_THUMBNAIL_BYTES + 1),
      filename: 'image.png',
    }),
    /5 MiB/,
  )
  await assert.rejects(
    prepareMarketCreationRequest({
      ...metadata,
      description: '😀'.repeat(MAX_MARKET_CREATION_METADATA_JSON_CODE_UNITS / 2),
    }),
    /metadata exceeds/,
  )
  await assert.rejects(
    prepareMarketCreationRequest(metadata, {
      data: new Uint8Array(MAX_MARKET_CREATION_THUMBNAIL_BYTES),
      filename: 'x'.repeat(1024 * 1024),
    }),
    /6 MiB/,
  )
})

test('authentication binds the prepared multipart bytes and delivery preserves the original thumbnail', async () => {
  const thumbnail = new Uint8Array([1, 2, 3])
  const prepared = await prepareMarketCreationRequest(metadata, {
    data: thumbnail,
    filename: 'original.png',
    contentType: 'image/png',
  })
  thumbnail.fill(9)
  const expected = createHash('sha256').update(new Uint8Array(prepared.bodyBytes)).digest('hex')
  const client = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    authorization: async (request) => {
      assert.equal(request.payloadHash, expected)
      new Uint8Array(prepared.bodyBytes).fill(0)
      return 'test-auth'
    },
    fetchImpl: async (url, init) => {
      assert.equal(
        createHash('sha256')
          .update(new Uint8Array(init!.body as ArrayBuffer))
          .digest('hex'),
        expected,
      )
      const form = await new Request(String(url), init).formData()
      const file = form.get('thumbnail') as File
      assert.equal(file.name, 'original.png')
      assert.equal(file.type, 'image/png')
      assert.equal(
        createHash('sha256')
          .update(new Uint8Array(await file.arrayBuffer()))
          .digest('hex'),
        createHash('sha256')
          .update(new Uint8Array([1, 2, 3]))
          .digest('hex'),
      )
      return Response.json({
        conditionId: 'condition',
        marketsCreated: ['condition-Yes', 'condition-No'],
        baseAsset: 'sat',
        divisibility: 1000,
      })
    },
  })
  await createPreparedMarketViaEngine(client, 'condition', prepared)
})
