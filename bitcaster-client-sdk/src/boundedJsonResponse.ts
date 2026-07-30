export interface AllocationBoundedJsonResponse {
  readonly body: ReadableStream<Uint8Array> | null
  readonly headers: { get(name: string): string | null }
  /**
   * Non-streaming runtimes must provide a reader that enforces `maximumBytes`
   * before allocating or returning the complete body.
   */
  readBoundedBody?(maximumBytes: number): Promise<Uint8Array>
}

export type BoundedJsonTextDecoder = (text: string) => unknown
export const ALLOCATION_BOUNDED_JSON_RESPONSE_BYTES_LIMIT_MAX = 16 * 1_024 * 1_024

/**
 * Reads and parses one JSON response without allocating an unbounded body.
 *
 * Fetch streams expose decompressed bytes, so Content-Length is only an early
 * rejection signal. The streamed byte count remains the authoritative bound.
 */
export async function readAllocationBoundedJsonResponse(
  response: AllocationBoundedJsonResponse,
  maximumBytes: number,
  decodeText: BoundedJsonTextDecoder = JSON.parse,
): Promise<unknown> {
  const text = await readAllocationBoundedTextResponse(response, maximumBytes)
  try {
    return decodeText(text)
  } catch {
    throw new Error('JSON response returned invalid JSON')
  }
}

export async function readAllocationBoundedTextResponse(
  response: AllocationBoundedJsonResponse,
  maximumBytes: number,
): Promise<string> {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= 0 ||
    maximumBytes > ALLOCATION_BOUNDED_JSON_RESPONSE_BYTES_LIMIT_MAX
  ) {
    await response.body?.cancel().catch(() => {})
    throw new Error('JSON response byte limit is invalid')
  }
  try {
    const declaredBytes = parseDeclaredResponseBytes(response.headers.get('content-length'))
    if (declaredBytes !== null && declaredBytes > maximumBytes) {
      throw new Error('JSON response byte limit exceeded')
    }
  } catch (error) {
    await response.body?.cancel().catch(() => {})
    throw error
  }
  const bytes =
    response.body === null
      ? await readBoundedFallbackResponse(response, maximumBytes)
      : await readBoundedResponseStream(response.body, maximumBytes)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('text response returned invalid UTF-8')
  }
}

function parseDeclaredResponseBytes(value: string | null): number | null {
  if (value === null) return null
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error('JSON response Content-Length is invalid')
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new Error('JSON response Content-Length is invalid')
  }
  return parsed
}

async function readBoundedFallbackResponse(
  response: AllocationBoundedJsonResponse,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (response.readBoundedBody === undefined) {
    throw new Error('JSON response fallback requires an adapter-owned bounded body reader')
  }
  const bytes = await response.readBoundedBody(maximumBytes)
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > maximumBytes) {
    throw new Error('JSON response byte limit exceeded')
  }
  return bytes
}

async function readBoundedResponseStream(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader()
  const bytes = new Uint8Array(maximumBytes)
  let totalBytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (!ArrayBuffer.isView(next.value) || next.value.BYTES_PER_ELEMENT !== 1) {
        throw new Error('JSON response stream returned invalid data')
      }
      const chunk = new Uint8Array(next.value.buffer, next.value.byteOffset, next.value.byteLength)
      totalBytes += chunk.byteLength
      if (totalBytes > maximumBytes) {
        throw new Error('JSON response byte limit exceeded')
      }
      bytes.set(chunk, totalBytes - chunk.byteLength)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
  return bytes.slice(0, totalBytes)
}
