import { npubEncode } from 'nostr-tools/nip19'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { verifyEvent, type Event, type EventTemplate } from 'nostr-tools/pure'
import { readAllocationBoundedJsonResponse } from './boundedJsonResponse.ts'

// BUD-02 and BUD-11 at hzrd149/blossom b5bd2801d1763aa635fc8fea7a76597e0eb18990.
// https://github.com/hzrd149/blossom/tree/b5bd2801d1763aa635fc8fea7a76597e0eb18990/buds
export const NOSTR_PROFILE_IMAGE_PROVIDER = 'https://blossom.nostr.build'
const NOSTR_PROFILE_IMAGE_CONTENT_ORIGIN = 'https://image.nostr.build'
export const MAX_NOSTR_PROFILE_IMAGE_BYTES = 5 * 1024 * 1024
export const NOSTR_PROFILE_IMAGE_DEADLINE_MS = 120_000
export type NostrProfileImageType = 'image/jpeg' | 'image/png' | 'image/webp'

/** Browser callers must decode and re-encode the image without metadata first. */
export interface NormalizedNostrProfileImage {
  readonly bytes: Uint8Array
  readonly type: NostrProfileImageType
  readonly width: number
  readonly height: number
}
export interface NostrProfileImageReceipt {
  readonly url: string
  readonly sha256: string
  readonly size: number
  readonly type: NostrProfileImageType
  readonly uploaded: number
  readonly publicKeyHex: string
}
type NostrMediaUploadErrorCode =
  | 'invalid-image'
  | 'invalid-authorization'
  | 'invalid-response'
  | 'payment-required'
  | 'rate-limited'
  | 'http-error'
  | 'cancelled'
  | 'deadline'
  | 'network-error'
export class NostrMediaUploadError extends Error {
  readonly code: NostrMediaUploadErrorCode
  readonly status?: number
  constructor(
    code:
      | 'invalid-image'
      | 'invalid-authorization'
      | 'invalid-response'
      | 'payment-required'
      | 'rate-limited'
      | 'http-error'
      | 'cancelled'
      | 'deadline'
      | 'network-error',
    status?: number,
  ) {
    super(`Profile image upload: ${code}`)
    this.name = 'NostrMediaUploadError'
    this.code = code
    this.status = status
  }
}
interface TransportOptions {
  readonly signal?: AbortSignal
  readonly fetch?: typeof globalThis.fetch
}

async function withDeadline<T>(
  options: TransportOptions,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort(new NostrMediaUploadError('cancelled'))
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  const timer = setTimeout(
    () => controller.abort(new NostrMediaUploadError('deadline')),
    NOSTR_PROFILE_IMAGE_DEADLINE_MS,
  )
  let rejectAbort: (() => void) | undefined
  try {
    controller.signal.throwIfAborted()
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', rejectAbort, { once: true })
    })
    return await Promise.race([work(controller.signal), cancelled])
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason
    if (error instanceof NostrMediaUploadError) throw error
    // Do not expose a signer exception, response body, or authorization header.
    throw new NostrMediaUploadError('network-error')
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort)
  }
}

function imageType(value: unknown): value is NostrProfileImageType {
  return value === 'image/jpeg' || value === 'image/png' || value === 'image/webp'
}
function contentUrl(value: unknown, publicKeyHex: string): string {
  if (!/^[0-9a-f]{64}$/.test(publicKeyHex)) throw new NostrMediaUploadError('invalid-response')
  // Provider docs: https://blossom.nostr.build/ — each npub gets its own domain.
  // Bind this CDN origin to the signer; never accept arbitrary Blossom tenants.
  const signerOrigin = `https://${npubEncode(publicKeyHex)}.blossom.band`
  if (typeof value !== 'string' || value.length > 2048)
    throw new NostrMediaUploadError('invalid-response')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new NostrMediaUploadError('invalid-response')
  }
  if (
    (url.origin !== NOSTR_PROFILE_IMAGE_PROVIDER && url.origin !== signerOrigin) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new NostrMediaUploadError('invalid-response')
  return url.href
}
function descriptor(
  value: unknown,
  expected: { hash: string; size: number; type: NostrProfileImageType; publicKeyHex: string },
): NostrProfileImageReceipt {
  if (!value || typeof value !== 'object') throw new NostrMediaUploadError('invalid-response')
  const data = value as Record<string, unknown>
  const url = contentUrl(data.url, expected.publicKeyHex)
  const extensions = expected.type === 'image/jpeg' ? ['jpg', 'jpeg'] : [expected.type.slice(6)]
  if (
    data.sha256 !== expected.hash ||
    data.size !== expected.size ||
    data.type !== expected.type ||
    !Number.isSafeInteger(data.uploaded) ||
    (data.uploaded as number) < 0 ||
    !extensions.some((extension) => new URL(url).pathname === `/${expected.hash}.${extension}`)
  )
    throw new NostrMediaUploadError('invalid-response')
  return {
    url,
    sha256: expected.hash,
    size: expected.size,
    type: expected.type,
    uploaded: data.uploaded as number,
    publicKeyHex: expected.publicKeyHex,
  }
}

function exactAuthorization(value: Event, expected: EventTemplate, publicKeyHex: string): Event {
  try {
    // Copy fields without nostr-tools' cached verification symbol. Never trust a
    // signer to retain the requested action, identity, hash, or server scope.
    if (
      value.pubkey !== publicKeyHex ||
      value.kind !== expected.kind ||
      value.created_at !== expected.created_at ||
      value.content !== expected.content ||
      !Array.isArray(value.tags) ||
      value.tags.length !== expected.tags.length ||
      expected.tags.some(
        (tag, index) =>
          !Array.isArray(value.tags[index]) ||
          value.tags[index].length !== tag.length ||
          tag.some((part, position) => part !== value.tags[index][position]),
      )
    )
      throw new Error()
    const event = {
      id: value.id,
      pubkey: value.pubkey,
      kind: value.kind,
      created_at: value.created_at,
      content: value.content,
      tags: expected.tags.map((tag) => [...tag]),
      sig: value.sig,
    }
    if (!verifyEvent(event)) throw new Error()
    return event
  } catch {
    throw new NostrMediaUploadError('invalid-authorization')
  }
}

export async function uploadNostrProfileImage(
  options: TransportOptions & {
    readonly image: NormalizedNostrProfileImage
    readonly publicKeyHex: string
    readonly signEvent: (event: EventTemplate) => Promise<Event>
  },
): Promise<NostrProfileImageReceipt> {
  const { image, publicKeyHex, signEvent } = options
  const type = image.type
  if (
    !(image.bytes instanceof Uint8Array) ||
    image.bytes.length < 1 ||
    image.bytes.length > MAX_NOSTR_PROFILE_IMAGE_BYTES ||
    !imageType(image.type) ||
    !Number.isInteger(image.width) ||
    image.width < 1 ||
    image.width > 1024 ||
    !Number.isInteger(image.height) ||
    image.height < 1 ||
    image.height > 1024
  )
    throw new NostrMediaUploadError('invalid-image')
  if (!/^[0-9a-f]{64}$/.test(publicKeyHex)) throw new NostrMediaUploadError('invalid-authorization')
  // Own the bytes before awaiting a signer so mutable UI buffers cannot change
  // the authorized upload after its digest has been calculated.
  const bytes = Uint8Array.from(image.bytes)
  const hash = bytesToHex(sha256(bytes))
  return withDeadline(options, async (signal) => {
    const createdAt = Math.floor(Date.now() / 1000)
    const template: EventTemplate = {
      kind: 24242,
      created_at: createdAt - 1,
      content: 'Upload a public bitCaster profile image',
      tags: [
        ['t', 'upload'],
        ['x', hash],
        ['server', new URL(NOSTR_PROFILE_IMAGE_PROVIDER).hostname],
        ['expiration', String(createdAt + 120)],
      ],
    }
    const signed = await signEvent({ ...template, tags: template.tags.map((tag) => [...tag]) })
    signal.throwIfAborted()
    const event = exactAuthorization(signed, template, publicKeyHex)
    const auth = btoa(JSON.stringify(event))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '')
    const response = await (options.fetch ?? globalThis.fetch)(
      `${NOSTR_PROFILE_IMAGE_PROVIDER}/upload`,
      {
        method: 'PUT',
        body: bytes,
        headers: { Authorization: `Nostr ${auth}`, 'Content-Type': type, 'X-SHA-256': hash },
        signal,
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      },
    )
    signal.throwIfAborted()
    if (response.status !== 200 && response.status !== 201) {
      void response.body?.cancel().catch(() => {})
      throw new NostrMediaUploadError(
        response.status === 402
          ? 'payment-required'
          : response.status === 429
            ? 'rate-limited'
            : 'http-error',
        response.status,
      )
    }
    let value: unknown
    const source = response.body?.getReader()
    const cancel = () => {
      void source?.cancel().catch(() => {})
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const body = source
        ? new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const next = await source.read()
                if (next.done) controller.close()
                else controller.enqueue(next.value)
              } catch (error) {
                controller.error(error)
              }
            },
            cancel() {
              return source.cancel()
            },
          })
        : null
      value = await readAllocationBoundedJsonResponse({ body, headers: response.headers }, 16_384)
    } catch {
      throw new NostrMediaUploadError('invalid-response')
    } finally {
      signal.removeEventListener('abort', cancel)
      void source?.cancel().catch(() => {})
      source?.releaseLock()
    }
    signal.throwIfAborted()
    return descriptor(value, { hash, size: bytes.length, type, publicKeyHex })
  })
}

/** Verify the public read without forwarding the upload authorization. */
export async function readNostrProfileImage(
  receipt: NostrProfileImageReceipt,
  options: TransportOptions = {},
): Promise<Uint8Array> {
  if (
    !/^[0-9a-f]{64}$/.test(receipt.sha256) ||
    !Number.isSafeInteger(receipt.size) ||
    receipt.size < 1 ||
    receipt.size > MAX_NOSTR_PROFILE_IMAGE_BYTES ||
    !imageType(receipt.type)
  )
    throw new NostrMediaUploadError('invalid-response')
  const checked = descriptor(receipt, {
    hash: receipt.sha256,
    size: receipt.size,
    type: receipt.type,
    publicKeyHex: receipt.publicKeyHex,
  })
  return withDeadline(options, async (signal) => {
    // The provider redirects its signer tenant URLs to this fixed content CDN.
    // Derive the path from the validated descriptor, not an untrusted Location.
    // Keep the original tenant URL in the public profile and receipt.
    const readUrl = `${NOSTR_PROFILE_IMAGE_CONTENT_ORIGIN}${new URL(checked.url).pathname}`
    const response = await (options.fetch ?? globalThis.fetch)(readUrl, {
      signal,
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    })
    if (
      response.status !== 200 ||
      response.headers.get('content-type')?.split(';')[0].trim() !== checked.type ||
      !response.body
    ) {
      void response.body?.cancel().catch(() => {})
      throw new NostrMediaUploadError('invalid-response')
    }
    const reader = response.body.getReader()
    const cancel = () => {
      void reader.cancel().catch(() => {})
    }
    signal.addEventListener('abort', cancel, { once: true })
    const bytes = new Uint8Array(checked.size)
    let size = 0
    try {
      while (true) {
        signal.throwIfAborted()
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.length
        if (size > bytes.length) throw new NostrMediaUploadError('invalid-response')
        bytes.set(chunk.value, size - chunk.value.length)
      }
      signal.throwIfAborted()
      if (size !== checked.size || bytesToHex(sha256(bytes)) !== checked.sha256)
        throw new NostrMediaUploadError('invalid-response')
      return bytes
    } finally {
      signal.removeEventListener('abort', cancel)
      void reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  })
}
