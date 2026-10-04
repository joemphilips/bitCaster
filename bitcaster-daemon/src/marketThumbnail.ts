import { open } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import {
  MAX_MARKET_CREATION_THUMBNAIL_BYTES,
  type MarketThumbnailBytes,
} from '@bitcaster-market/client-sdk'
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

export async function readMarketThumbnail(path: string): Promise<MarketThumbnailBytes> {
  const contentType = CONTENT_TYPES[extname(path).toLowerCase()]
  if (!contentType) throw new Error('Market thumbnail must be a JPEG, PNG, or WebP file.')
  const file = await open(path, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_MARKET_CREATION_THUMBNAIL_BYTES) {
      throw new Error('Market thumbnail must be a nonempty file of at most 5 MiB.')
    }
    // A file can grow after stat. Do not let that turn a local upload into an unbounded read.
    const buffer = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length !== stat.size) throw new Error('Market thumbnail changed while reading. Retry.')
    return { data: buffer.subarray(0, length), filename: basename(path), contentType }
  } finally {
    await file.close()
  }
}
