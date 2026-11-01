/**
 * Optional profile statistics from the Primal cache service. A relay does not
 * supply follower counts or a first-activity date, so this indexer is the only
 * source of them. The indexer sees the visitor's IP address and which profile
 * the visitor opens. Every failure returns null; the caller hides the values.
 */

/** Primal's public cache endpoint, the same one the Primal web client uses. */
export const PRIMAL_CACHE_URL = 'wss://cache2.primal.net/v1'
/** Primal's `UserStats` response kind for the `user_profile` cache request. */
export const PRIMAL_USER_STATS_KIND = 10_000_105
export const PRIMAL_PROFILE_INDEXER_TIMEOUT_MS = 4_000
export const MAX_PRIMAL_INDEXER_FRAME_BYTES = 131_072
export const MAX_PRIMAL_INDEXER_TOTAL_BYTES = 524_288
export const MAX_PRIMAL_INDEXER_FRAMES = 32
// Nostr started in 2020. An earlier first-seen time comes from a backdated event.
export const MIN_PLAUSIBLE_NOSTR_ACTIVITY_SECONDS = 1_577_836_800
const MAX_CLOCK_SKEW_SECONDS = 3_600

export interface NostrProfileIndexerStats {
  readonly followersCount: number | null
  readonly followsCount: number | null
  readonly noteCount: number | null
  /** Unix seconds of the first event that the indexer saw for this key. */
  readonly firstActivityAt: number | null
}

/** The subset of the browser and Node `WebSocket` API that the client uses. */
export interface PrimalSocket {
  readonly readyState: number
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((message: { data: unknown }) => void) | null
  onerror: (() => void) | null
  onclose: (() => void) | null
}

export interface PrimalProfileIndexerOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly openSocket?: (url: string) => PrimalSocket
  readonly setTimer?: (callback: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
  readonly nowSeconds?: () => number
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** Decode the JSON content of a `UserStats` event. The content must name this key. */
export function decodePrimalUserStats(
  content: unknown,
  publicKeyHex: string,
  nowSeconds: number,
): NostrProfileIndexerStats | null {
  if (typeof content !== 'string') return null
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const stats = value as Record<string, unknown>
  if (stats.pubkey !== publicKeyHex) return null
  const joined = count(stats.time_joined)
  const result = {
    followersCount: count(stats.followers_count),
    followsCount: count(stats.follows_count),
    noteCount: count(stats.note_count),
    firstActivityAt:
      joined !== null &&
      joined >= MIN_PLAUSIBLE_NOSTR_ACTIVITY_SECONDS &&
      joined <= nowSeconds + MAX_CLOCK_SKEW_SECONDS
        ? joined
        : null,
  }
  return Object.values(result).every((field) => field === null) ? null : result
}

function frameBytes(data: unknown): number | null {
  if (typeof data !== 'string' || data.length > MAX_PRIMAL_INDEXER_FRAME_BYTES) return null
  const bytes = new TextEncoder().encode(data).byteLength
  return bytes > MAX_PRIMAL_INDEXER_FRAME_BYTES ? null : bytes
}

type FrameResult = { done: false } | { done: true; stats: NostrProfileIndexerStats | null }

function readFrame(
  frame: unknown,
  subscription: string,
  publicKeyHex: string,
  nowSeconds: number,
): FrameResult {
  if (!Array.isArray(frame)) return { done: true, stats: null }
  if (frame[0] === 'NOTICE') return { done: true, stats: null }
  if (frame[1] !== subscription) return { done: false }
  if (frame[0] === 'EOSE' || frame[0] === 'CLOSED') return { done: true, stats: null }
  if (frame[0] !== 'EVENT' || frame.length !== 3) return { done: true, stats: null }
  const event = frame[2] as { kind?: unknown; content?: unknown } | null
  if (event === null || typeof event !== 'object' || event.kind !== PRIMAL_USER_STATS_KIND)
    return { done: false }
  return { done: true, stats: decodePrimalUserStats(event.content, publicKeyHex, nowSeconds) }
}

/** Request `user_profile` from the Primal cache. Resolve null on any failure. */
export function readPrimalProfileStats(
  publicKeyHex: string,
  options: PrimalProfileIndexerOptions = {},
): Promise<NostrProfileIndexerStats | null> {
  if (!/^[0-9a-f]{64}$/.test(publicKeyHex) || options.signal?.aborted) return Promise.resolve(null)
  const openSocket = options.openSocket ?? ((url: string) => new WebSocket(url) as PrimalSocket)
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000))
  return new Promise((resolve) => {
    const subscription = `profile-${crypto.randomUUID()}`
    let socket: PrimalSocket | undefined
    let settled = false
    let frames = 0
    let totalBytes = 0
    const finish = (stats: NostrProfileIndexerStats | null) => {
      if (settled) return
      settled = true
      clearTimer(timer)
      options.signal?.removeEventListener('abort', abort)
      if (socket) {
        socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null
        try {
          if (socket.readyState === 1) socket.send(JSON.stringify(['CLOSE', subscription]))
          socket.close()
        } catch {
          // The read still settles when the socket cannot close cleanly.
        }
      }
      resolve(stats)
    }
    const abort = () => finish(null)
    const timer = setTimer(abort, options.timeoutMs ?? PRIMAL_PROFILE_INDEXER_TIMEOUT_MS)
    options.signal?.addEventListener('abort', abort, { once: true })
    try {
      socket = openSocket(PRIMAL_CACHE_URL)
      socket.onopen = () => {
        try {
          socket!.send(
            JSON.stringify([
              'REQ',
              subscription,
              { cache: ['user_profile', { pubkey: publicKeyHex }] },
            ]),
          )
        } catch {
          finish(null)
        }
      }
      socket.onerror = socket.onclose = abort
      socket.onmessage = (message) => {
        if (settled) return
        try {
          const bytes = frameBytes(message.data)
          totalBytes += bytes ?? 0
          if (bytes === null || ++frames > MAX_PRIMAL_INDEXER_FRAMES) return finish(null)
          if (totalBytes > MAX_PRIMAL_INDEXER_TOTAL_BYTES) return finish(null)
          const result = readFrame(
            JSON.parse(message.data as string),
            subscription,
            publicKeyHex,
            nowSeconds(),
          )
          if (result.done) finish(result.stats)
        } catch {
          finish(null)
        }
      }
    } catch {
      finish(null)
    }
  })
}
