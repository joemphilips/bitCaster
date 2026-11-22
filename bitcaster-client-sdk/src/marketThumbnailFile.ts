import { constants, type Stats } from 'node:fs'
import { access, open, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { MAX_MARKET_CREATION_THUMBNAIL_BYTES } from './marketCreationRequest.ts'
import type { MarketThumbnailBytes } from './marketLifecycle.ts'

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

function thumbnailContentType(path: string): string {
  const contentType = CONTENT_TYPES[extname(path).toLowerCase()]
  if (!contentType) throw new Error('Market thumbnail must be a JPEG, PNG, or WebP file.')
  return contentType
}

function assertThumbnailFileSize(metadata: Stats): void {
  if (
    !metadata.isFile() ||
    metadata.size === 0 ||
    metadata.size > MAX_MARKET_CREATION_THUMBNAIL_BYTES
  ) {
    throw new Error('Market thumbnail must be a nonempty file of at most 5 MiB.')
  }
}

/**
 * Check a local thumbnail file before a client sends its path. The file can change after this
 * check, so readMarketThumbnailFile stays the authority.
 */
export async function checkMarketThumbnailFile(path: string): Promise<void> {
  thumbnailContentType(path)
  // Read only the metadata. An open of a FIFO waits for a writer.
  assertThumbnailFileSize(await stat(path))
  await access(path, constants.R_OK)
}

export async function readMarketThumbnailFile(path: string): Promise<MarketThumbnailBytes> {
  const contentType = thumbnailContentType(path)
  const file = await open(path, 'r')
  try {
    const metadata = await file.stat()
    assertThumbnailFileSize(metadata)
    // A file can grow after stat. Do not let that turn a local upload into an unbounded read.
    const buffer = Buffer.alloc(metadata.size + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length !== metadata.size) throw new Error('Market thumbnail changed while reading. Retry.')
    return { data: buffer.subarray(0, length), filename: basename(path), contentType }
  } finally {
    await file.close()
  }
}
