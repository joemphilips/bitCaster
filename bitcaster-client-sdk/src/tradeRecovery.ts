export const MAKER_COLLATERAL_FAILURE_REASON = 'maker-collateral-failure'

const DEFAULT_MAX_RESUBMIT_ATTEMPTS = 2
const DEFAULT_MAX_TRANSPORT_RETRIES = 2
const DEFAULT_RETRY_DELAY_MS = 250

export interface TakerFillRecoverySourceOrder {
  marketId: string
  outcomeId: string
  tokenSide: 'Outcome' | 'Complement'
  side: 'Buy' | 'Sell'
  price: number
  timeInForce: 'FAK' | 'FOK' | 'GTC'
}

export interface TakerFillRecoverySubmitOrderResponse {
  orderId: string
}

export type TakerFillRecoveryOrderRequest = Omit<
  TakerFillRecoverySourceOrder,
  'marketId'
> & {
  amountSubunits: number
  clientOrderId: string
}

export interface TakerFillRecoveryRequest {
  /** Public, allowlisted terminal reason carried by TradeStateChanged. */
  failureReason?: string | null
  /** Recovery is only safe for the party whose order was the incoming fill. */
  isTaker: boolean
  /** Unix milliseconds. The caller derives this from the accepted trade locktime. */
  deadlineMs: number
  sourceOrder: TakerFillRecoverySourceOrder
  /** Exact face amount of the failed fill, never the original order's total. */
  failedFillAmountSubunits: number
  /** Number of prior replacement orders submitted for this failed fill. */
  resubmitAttempt: number
  maxResubmitAttempts?: number
  maxTransportRetries?: number
  retryDelayMs?: number
  submitOrder: (
    marketId: string,
    request: TakerFillRecoveryOrderRequest,
  ) => Promise<TakerFillRecoverySubmitOrderResponse>
  newClientOrderId: () => string
  now?: () => number
  delay?: (milliseconds: number) => Promise<void>
}

export type TakerFillRecoveryResult =
  | { kind: 'resubmitted'; orderId: string; clientOrderId: string }
  | { kind: 'not-recoverable' }
  | { kind: 'deadline-expired' }
  | { kind: 'resubmit-limit-reached' }

export interface RetryTransientTradeOperationParams<T> {
  /** Unix milliseconds, derived from the accepted trade's earliest locktime. */
  deadlineMs: number
  operation: () => Promise<T>
  maxTransportRetries?: number
  retryDelayMs?: number
  now?: () => number
  delay?: (milliseconds: number) => Promise<void>
}

export type RetryTransientTradeOperationResult<T> =
  | { kind: 'completed'; value: T }
  | { kind: 'deadline-expired' }

/**
 * Re-submits a failed taker fill only when the engine supplied the one public
 * reason that proves the maker, rather than the taker, caused the failure.
 * Replays use a stable client-order id so an ambiguous transport failure is
 * idempotent at the engine boundary.
 */
export async function recoverFailedTakerFill(
  params: TakerFillRecoveryRequest,
): Promise<TakerFillRecoveryResult> {
  if (
    params.failureReason !== MAKER_COLLATERAL_FAILURE_REASON ||
    !params.isTaker ||
    !isPositiveSafeInteger(params.failedFillAmountSubunits)
  ) {
    return { kind: 'not-recoverable' }
  }

  const now = params.now ?? Date.now
  if (now() >= params.deadlineMs) return { kind: 'deadline-expired' }

  const maxResubmits = params.maxResubmitAttempts ?? DEFAULT_MAX_RESUBMIT_ATTEMPTS
  if (params.resubmitAttempt >= maxResubmits) {
    return { kind: 'resubmit-limit-reached' }
  }

  const clientOrderId = params.newClientOrderId()
  const { marketId, ...sourceRequest } = params.sourceOrder
  const request = {
    ...sourceRequest,
    amountSubunits: params.failedFillAmountSubunits,
    clientOrderId,
  }
  const retry = await retryTransientTradeOperation({
    deadlineMs: params.deadlineMs,
    operation: () => params.submitOrder(marketId, request),
    maxTransportRetries: params.maxTransportRetries,
    retryDelayMs: params.retryDelayMs,
    now,
    delay: params.delay,
  })
  if (retry.kind === 'deadline-expired') {
    return retry
  }
  return {
    kind: 'resubmitted',
    orderId: retry.value.orderId,
    clientOrderId,
  }
}

/**
 * Retry an idempotent client operation only when transport ambiguity leaves
 * its delivery unknown. Logical protocol and authorization failures propagate
 * immediately, and no attempt begins at or after the supplied deadline.
 */
export async function retryTransientTradeOperation<T>(
  params: RetryTransientTradeOperationParams<T>,
): Promise<RetryTransientTradeOperationResult<T>> {
  const now = params.now ?? Date.now
  const maxTransportRetries = params.maxTransportRetries ?? DEFAULT_MAX_TRANSPORT_RETRIES
  const retryDelayMs = params.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const wait = params.delay ?? delay

  for (let attempt = 0; ; attempt += 1) {
    if (now() >= params.deadlineMs) return { kind: 'deadline-expired' }
    try {
      return { kind: 'completed', value: await params.operation() }
    } catch (error) {
      if (!isRetryableTransportError(error) || attempt >= maxTransportRetries) {
        throw error
      }
      const remainingMs = params.deadlineMs - now()
      if (remainingMs <= 0) return { kind: 'deadline-expired' }
      await wait(Math.min(retryDelayMs * (2 ** attempt), remainingMs))
    }
  }
}

/**
 * Retry errors where the caller cannot know whether the request reached the
 * engine, plus the one idempotent DCB reservation race on the same trade. A
 * shared-condition tag conflict remains an explicit protocol failure.
 */
export function isRetryableTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  if (/\bfailed to reserve tags:\s*tag trade:[0-9a-f]{32}\b.*\bis currently reserved\b/i.test(error.message)) {
    return true
  }
  return [
    'failed to fetch',
    'fetch failed',
    'networkerror',
    'network request failed',
    'connection is not in the connected state',
    'invocation canceled due to the underlying connection being closed',
    'tradehub not connected',
    'timed out',
  ].some((fragment) => message.includes(fragment))
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function delay(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
