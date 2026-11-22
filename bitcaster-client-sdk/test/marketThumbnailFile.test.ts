import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { BitcasterEngineClient } from '../src/engineClient.ts'
import { createMarketViaEngine } from '../src/marketLifecycle.ts'
import { checkMarketThumbnailFile, readMarketThumbnailFile } from '../src/marketThumbnailFile.ts'

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
      await checkMarketThumbnailFile(path)
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
        await readMarketThumbnailFile(path),
      )
      assert.equal(requests, 1)
    }
  })
})

test('native thumbnails reject unsupported, empty, and oversized files before upload', async () => {
  await withDirectory(async (directory) => {
    const gif = join(directory, 'image.gif')
    await writeFile(gif, new Uint8Array([1]))
    for (const inspect of [readMarketThumbnailFile, checkMarketThumbnailFile])
      await assert.rejects(inspect(gif), /JPEG, PNG, or WebP/)
    for (const size of [0, 5 * 1024 * 1024 + 1]) {
      const path = join(directory, 'image.png')
      await writeFile(path, Buffer.alloc(size))
      for (const inspect of [readMarketThumbnailFile, checkMarketThumbnailFile])
        await assert.rejects(inspect(path), /nonempty file of at most 5 MiB/)
    }
  })
})

test('the thumbnail check refuses a missing path, a directory, and an unreadable file', async () => {
  await withDirectory(async (directory) => {
    await assert.rejects(checkMarketThumbnailFile(join(directory, 'missing.png')), {
      code: 'ENOENT',
    })
    await mkdir(join(directory, 'folder.png'))
    await assert.rejects(
      checkMarketThumbnailFile(join(directory, 'folder.png')),
      /nonempty file of at most 5 MiB/,
    )
    // A process with root rights can read a file without read permission.
    if (process.getuid?.() !== 0) {
      const unreadable = join(directory, 'unreadable.png')
      await writeFile(unreadable, new Uint8Array([1]))
      await chmod(unreadable, 0o200)
      await assert.rejects(checkMarketThumbnailFile(unreadable), { code: 'EACCES' })
    }
  })
})

test(
  'the thumbnail check refuses a FIFO without waiting for a writer',
  { skip: process.platform === 'win32', timeout: 5_000 },
  async () => {
    await withDirectory(async (directory) => {
      const fifo = join(directory, 'pipe.png')
      assert.equal(spawnSync('mkfifo', [fifo]).status, 0)
      await assert.rejects(checkMarketThumbnailFile(fifo), /nonempty file of at most 5 MiB/)
    })
  },
)

async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-thumbnail-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
