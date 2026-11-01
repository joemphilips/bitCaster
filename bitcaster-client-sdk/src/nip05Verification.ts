import { readAllocationBoundedJsonResponse } from './boundedJsonResponse.ts'

/**
 * NIP-05 address check for display. The domain host sees the visitor's IP
 * address and the checked name. A false result hides the address; it is not
 * an error for the user.
 */
export const NIP05_TIMEOUT_MS = 4_000
export const MAX_NIP05_RESPONSE_BYTES = 65_536

export interface Nip05Address {
  readonly name: string
  readonly domain: string
}

export interface Nip05VerificationOptions {
  readonly fetch?: typeof globalThis.fetch
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly setTimer?: (callback: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * Accept only `name@domain` with a public DNS name. An IP literal, a port, a
 * path or a single-label host such as `localhost` is not a NIP-05 domain and
 * must not make the browser contact a local service.
 */
export function parseNip05Address(value: unknown): Nip05Address | null {
  if (typeof value !== 'string') return null
  const parts = value.trim().toLowerCase().split('@')
  if (parts.length !== 2) return null
  const [name, domain] = parts as [string, string]
  if (!/^[a-z0-9._-]{1,64}$/.test(name) || domain.length > 253) return null
  const labels = domain.split('.')
  if (labels.length < 2 || !labels.every((label) => DOMAIN_LABEL.test(label))) return null
  if (!/[a-z]/.test(labels[labels.length - 1]!)) return null
  return { name, domain }
}

function namesMatch(body: unknown, name: string, publicKeyHex: string): boolean {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false
  const names = (body as Record<string, unknown>).names
  if (names === null || typeof names !== 'object' || Array.isArray(names)) return false
  return Object.hasOwn(names, name) && (names as Record<string, unknown>)[name] === publicKeyHex
}

/** True only when the domain's well-known names map the address to this key. */
export async function verifyNip05Address(
  address: unknown,
  publicKeyHex: string,
  options: Nip05VerificationOptions = {},
): Promise<boolean> {
  const parsed = parseNip05Address(address)
  if (!parsed || !/^[0-9a-f]{64}$/.test(publicKeyHex) || options.signal?.aborted) return false
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timer = setTimer(abort, options.timeoutMs ?? NIP05_TIMEOUT_MS)
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    const url = `https://${parsed.domain}/.well-known/nostr.json?name=${encodeURIComponent(parsed.name)}`
    const response = await (options.fetch ?? globalThis.fetch)(url, {
      redirect: 'error',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok || response.redirected) {
      await response.body?.cancel().catch(() => {})
      return false
    }
    const body = await readAllocationBoundedJsonResponse(response, MAX_NIP05_RESPONSE_BYTES)
    return namesMatch(body, parsed.name, publicKeyHex)
  } catch {
    return false
  } finally {
    clearTimer(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}
