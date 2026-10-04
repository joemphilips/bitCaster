import { assertMarketCreationMetadataSize } from './marketCreationInput.ts'
import type { CreateMarketRequest, MarketThumbnailBytes } from './marketLifecycle.ts'

export const MAX_MARKET_CREATION_THUMBNAIL_BYTES = 5 * 1024 * 1024
export const MAX_MARKET_CREATION_REQUEST_BYTES = 6 * 1024 * 1024

export interface PreparedMarketCreationRequest {
  readonly bodyBytes: ArrayBuffer
  readonly contentType: string
}

export function snapshotMarketCreationThumbnail(thumbnail?: MarketThumbnailBytes) {
  if (thumbnail === undefined) return null
  const data = new Uint8Array(
    ArrayBuffer.isView(thumbnail.data) ? thumbnail.data.buffer : thumbnail.data,
    ArrayBuffer.isView(thumbnail.data) ? thumbnail.data.byteOffset : 0,
    thumbnail.data.byteLength,
  )
  if (data.byteLength === 0 || data.byteLength > MAX_MARKET_CREATION_THUMBNAIL_BYTES)
    throw new Error('Market thumbnail must contain at most 5 MiB.')
  if (typeof thumbnail.filename !== 'string' || thumbnail.filename.length === 0)
    throw new Error('Market thumbnail filename is required.')
  const contentType = thumbnail.contentType ?? 'application/octet-stream'
  if (
    typeof contentType !== 'string' ||
    new TextEncoder().encode(thumbnail.filename + contentType).byteLength >
      MAX_MARKET_CREATION_REQUEST_BYTES
  )
    throw new Error('Market thumbnail headers exceed the request limit.')
  return { data: data.slice(), filename: thumbnail.filename, contentType }
}

/** Serialize before payment. Authentication and delivery must use these same bytes. */
export async function prepareMarketCreationRequest(
  metadata: CreateMarketRequest,
  thumbnail?: MarketThumbnailBytes,
): Promise<PreparedMarketCreationRequest> {
  assertMarketCreationMetadataSize(metadata)
  const snapshot = snapshotMarketCreationThumbnail(thumbnail)
  const formData = new FormData()
  formData.append('metadata', JSON.stringify(metadata))
  if (snapshot !== null) {
    formData.append(
      'thumbnail',
      new Blob([snapshot.data.buffer], { type: snapshot.contentType }),
      snapshot.filename,
    )
  }
  const serialized = new Request('https://creation.invalid/', { method: 'POST', body: formData })
  const bodyBytes = await serialized.arrayBuffer()
  if (bodyBytes.byteLength > MAX_MARKET_CREATION_REQUEST_BYTES)
    throw new Error('Market creation exceeds the 6 MiB request limit.')
  const contentType = serialized.headers.get('Content-Type')
  if (contentType === null) throw new Error('Market creation Content-Type is missing.')
  return { bodyBytes, contentType }
}
