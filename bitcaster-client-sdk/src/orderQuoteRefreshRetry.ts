/** This wait policy does not establish rejection or authorize custody release. */
export interface OrderQuotesRefreshingProgress {
  attempt: number
  remainingMs: number
}

export interface OrderQuoteRefreshRetryOptions {
  authorizationExpiresAtUnixSeconds: number
  onWaiting?: (progress: OrderQuotesRefreshingProgress) => void
}

export interface SubmitOrderOptions {
  signal?: AbortSignal
  quoteRefreshRetry?: OrderQuoteRefreshRetryOptions
  /** A caller can shorten, but cannot extend, the 10-second attempt limit. */
  requestTimeoutMs?: number
}

export class OrderQuoteRefreshWaitStopped extends Error {
  readonly reason: 'cancelled' | 'expired' | 'budget'
  constructor(reason: 'cancelled' | 'expired' | 'budget') {
    super('Order waiting stopped; the original operation still requires reconciliation')
    this.name = 'OrderQuoteRefreshWaitStopped'
    this.reason = reason
  }
}

/** Timers, original expiry and attempt count bound one live submission action. */
export async function runOrderQuoteRefreshRetry<T>(
  submit: (signal: AbortSignal) => Promise<T>,
  isRefreshing: (error: unknown) => boolean,
  options: SubmitOrderOptions & { quoteRefreshRetry: OrderQuoteRefreshRetryOptions },
): Promise<T> {
  const expiryMs = options.quoteRefreshRetry.authorizationExpiresAtUnixSeconds * 1_000
  const timeoutMs = options.requestTimeoutMs ?? 10_000
  if (!Number.isSafeInteger(expiryMs) || expiryMs <= 0)
    throw new Error('Order authorization expiry is invalid')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10_000)
    throw new Error('Order request timeout must be between 1 and 10000 milliseconds')
  const startedAt = performance.now()
  const remaining = () => Math.min(60_000 - (performance.now() - startedAt), expiryMs - Date.now())
  const stop = () => {
    if (options.signal?.aborted) throw new OrderQuoteRefreshWaitStopped('cancelled')
    if (remaining() < timeoutMs)
      throw new OrderQuoteRefreshWaitStopped(
        expiryMs - Date.now() < timeoutMs ? 'expired' : 'budget',
      )
  }
  for (let attempt = 1; attempt <= 30; attempt++) {
    stop()
    const controller = new AbortController()
    const abort = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(
      () => controller.abort(new Error('Order request timed out')),
      timeoutMs,
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
      if (options.signal?.aborted) throw new OrderQuoteRefreshWaitStopped('cancelled')
      // A timeout is ambiguous even if a late transport yields a readiness error.
      if (controller.signal.aborted || !isRefreshing(error)) throw error
      refreshing = true
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
    }
    if (!refreshing || attempt === 30) throw new OrderQuoteRefreshWaitStopped('budget')
    const delayMs = attempt === 1 ? 1_000 : 2_000
    stop()
    if (remaining() < delayMs + timeoutMs)
      throw new OrderQuoteRefreshWaitStopped(
        expiryMs - Date.now() < delayMs + timeoutMs ? 'expired' : 'budget',
      )
    options.quoteRefreshRetry.onWaiting?.({
      attempt,
      remainingMs: Math.max(0, Math.floor(remaining())),
    })
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        reject(new OrderQuoteRefreshWaitStopped('cancelled'))
      }
      const timer = setTimeout(() => {
        options.signal?.removeEventListener('abort', abort)
        resolve()
      }, delayMs)
      options.signal?.addEventListener('abort', abort, { once: true })
      if (options.signal?.aborted) abort()
    })
  }
  throw new OrderQuoteRefreshWaitStopped('budget')
}
