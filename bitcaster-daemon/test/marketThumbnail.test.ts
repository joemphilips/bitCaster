import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { BitcasterEngineClient, createMarketViaEngine } from '@bitcaster-market/client-sdk'
import { readMarketThumbnail } from '../src/marketThumbnail.ts'

test('native thumbnail upload sends each supported image content type through the SDK', async () => {
  await withDirectory(async (directory) => {
    for (const [extension, contentType] of [
      ['jpg', 'image/jpeg'],
      ['JPEG', 'image/jpeg'],
      ['png', 'image/png'],
      ['webp', 'image/webp'],
    ]) {
      const filename = `thumbnail.${extension}`
      const path = join(directory, filename)
      await writeFile(path, new Uint8Array([1, 2, 3]))
      let requests = 0
      const client = new BitcasterEngineClient({
        baseUrl: 'https://engine.example',
        fetchImpl: async (url, init) => {
          requests++
          const form = await new Request(String(url), init).formData()
          const thumbnail = form.get('thumbnail')
          assert.ok(thumbnail instanceof File)
          assert.equal(thumbnail.type, contentType)
          assert.equal(thumbnail.name, filename)
          assert.deepEqual(new Uint8Array(await thumbnail.arrayBuffer()), new Uint8Array([1, 2, 3]))
          return Response.json({
            conditionId: 'condition',
            marketsCreated: ['condition-Yes', 'condition-No'],
            baseAsset: 'sat',
            divisibility: 1000,
          })
        },
      })
      await createMarketViaEngine(
        client,
        'condition',
        {
          title: 'Title',
          description: 'Description',
          outcomes: [{ name: 'Yes' }, { name: 'No' }],
          baseAsset: 'sat',
        },
        await readMarketThumbnail(path),
      )
      assert.equal(requests, 1)
    }
  })
})

test('native thumbnails reject unsupported, empty, and oversized files before upload', async () => {
  await withDirectory(async (directory) => {
    await assert.rejects(readMarketThumbnail(join(directory, 'image.gif')), /JPEG, PNG, or WebP/)
    for (const size of [0, 5 * 1024 * 1024 + 1]) {
      const path = join(directory, 'image.png')
      await writeFile(path, Buffer.alloc(size))
      await assert.rejects(readMarketThumbnail(path), /nonempty file of at most 5 MiB/)
    }
  })
})

async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-thumbnail-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
