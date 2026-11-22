/** This wait policy does not establish rejection or authorize custody release. */
export interface OrderQuotesRefreshingProgress {
  attempt: number
  remainingMs: number
}

export interface OrderQuoteRefreshRetryOptions {
  authorizationExpiresAtUnixSeconds: number
  onWaiting?: (progress: OrderQuotesRefreshingProgress) => void
}

/**
 * One order attempt can take more than 10 seconds on a hosted engine. A
 * shorter limit reports an accepted order as uncertain.
 */
export const ORDER_REQUEST_TIMEOUT_MS = 30_000

export interface SubmitOrderOptions {
  signal?: AbortSignal
  quoteRefreshRetry?: OrderQuoteRefreshRetryOptions
  /** A caller can shorten, but cannot extend, the 30-second attempt limit. */
  requestTimeoutMs?: number
}

export function requireOrderRequestTimeoutMs(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > ORDER_REQUEST_TIMEOUT_MS)
    throw new Error(
      `Order request timeout must be between 1 and ${ORDER_REQUEST_TIMEOUT_MS} milliseconds`,
    )
  return value
}

export class OrderQuoteRefreshWaitStopped extends Error {
  readonly reason: 'cancelled' | 'expired' | 'budget'
  /**
   * True when every sent attempt got a resendable refusal, which commits
   * nothing (or when no attempt was sent). False when the stop interrupted an
   * attempt in flight, whose result is unknown.
   */
  readonly allAttemptsRefused: boolean
  /** The code of the last refusal, or null when no attempt was refused. */
  readonly lastRefusalCode: string | null
  constructor(
    reason: 'cancelled' | 'expired' | 'budget',
    allAttemptsRefused = false,
    lastRefusalCode: string | null = null,
  ) {
    super('Order waiting stopped; the original operation still requires reconciliation')
    this.name = 'OrderQuoteRefreshWaitStopped'
    this.reason = reason
    this.allAttemptsRefused = allAttemptsRefused
    this.lastRefusalCode = lastRefusalCode
  }
}

function refusalCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : null
}

/** Timers, original expiry and attempt count bound one live submission action. */
export async function runOrderQuoteRefreshRetry<T>(
  submit: (signal: AbortSignal) => Promise<T>,
  isRefreshing: (error: unknown) => boolean,
  options: SubmitOrderOptions & { quoteRefreshRetry: OrderQuoteRefreshRetryOptions },
): Promise<T> {
  const expiryMs = options.quoteRefreshRetry.authorizationExpiresAtUnixSeconds * 1_000
  const timeoutMs = requireOrderRequestTimeoutMs(
    options.requestTimeoutMs ?? ORDER_REQUEST_TIMEOUT_MS,
  )
  if (!Number.isSafeInteger(expiryMs) || expiryMs <= 0)
    throw new Error('Order authorization expiry is invalid')
  const startedAt = performance.now()
  // Every stop below an attempt in flight follows only refusals that commit nothing.
  let lastRefusal: string | null = null
  const stopped = (reason: 'cancelled' | 'expired' | 'budget') =>
    new OrderQuoteRefreshWaitStopped(reason, true, lastRefusal)
  const remaining = () => Math.min(60_000 - (performance.now() - startedAt), expiryMs - Date.now())
  // Stop unless more than reservedMs is left before both the wait deadline
  // and the authorization expiry.
  const stop = (reservedMs: number) => {
    if (options.signal?.aborted) throw stopped('cancelled')
    if (remaining() <= reservedMs)
      throw stopped(expiryMs - Date.now() <= reservedMs ? 'expired' : 'budget')
  }
  for (let attempt = 1; attempt <= 30; attempt++) {
    stop(0)
    // A short-lived authorization still gets an attempt. The attempt ends at
    // the earlier of its own limit, the wait deadline and the expiry.
    const attemptTimeoutMs = Math.min(timeoutMs, Math.ceil(remaining()))
    const controller = new AbortController()
    const abort = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(
      () => controller.abort(new Error('Order request timed out')),
      attemptTimeoutMs,
    )
    let refreshing = false
    try {
      return await new Promise<T>((resolve, reject) => {
        const aborted = () => reject(controller.signal.reason)
        controller.signal.addEventListener('abort', aborted, { once: true })
        if (controller.signal.aborted) aborted()
        else
          Promise.resolve()
            .then(() => {
              controller.signal.throwIfAborted()
              return submit(controller.signal)
            })
            .then(resolve, reject)
            .finally(() => controller.signal.removeEventListener('abort', aborted))
      })
    } catch (error) {
      // A cancel during an attempt leaves that attempt's result unknown.
      if (options.signal?.aborted)
        throw new OrderQuoteRefreshWaitStopped('cancelled', false, lastRefusal)
      // A timeout is ambiguous even if a late transport yields a readiness error.
      if (controller.signal.aborted || !isRefreshing(error)) throw error
      refreshing = true
      lastRefusal = refusalCode(error)
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
    }
    if (!refreshing || attempt === 30) throw stopped('budget')
    const delayMs = attempt === 1 ? 1_000 : 2_000
    stop(delayMs)
    options.quoteRefreshRetry.onWaiting?.({
      attempt,
      remainingMs: Math.max(0, Math.floor(remaining())),
    })
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        reject(stopped('cancelled'))
      }
      const timer = setTimeout(() => {
        options.signal?.removeEventListener('abort', abort)
        resolve()
      }, delayMs)
      options.signal?.addEventListener('abort', abort, { once: true })
      if (options.signal?.aborted) abort()
    })
  }
  throw stopped('budget')
}
