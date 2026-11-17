/**
 * Client rules of the one-step order admission (ADR-037 amendment of
 * 2026-11-13, decision 6). The browser, the daemon and, through the daemon, the
 * CLI share them.
 *
 * - The client commits `order-requested` before it sends the admission-form
 *   order request.
 * - An accepted response gives the capability of the order; the record moves to
 *   `order-submitted`.
 * - After an uncertain response or a restart, recovery never sends a request
 *   that can create the order. It reads the order through the read-only lookup
 *   with a bounded backoff until authorization expiry. At or after expiry, the
 *   existing NUT-09 and NUT-07 recovery and the refund path run.
 */
import {
  decodeCtfRangeOrderPreparationCapability,
  type CtfRangeOrderPreparationCapability,
} from './ctfRangeOrderJournal.ts'
import {
  EngineClientError,
  type OrderLookupResponse,
  type SettlementCapabilityState,
  type SubmitOrderResponse,
} from './engineClient.ts'

/** The local facts of one order request that a response or a lookup must match. */
export interface CtfRangeOrderAdmissionIdentity {
  readonly rangeOperationId: string
  readonly conditionId: string
  readonly clientOrderId: string
  readonly marketId: string
  /** Digest of the local capability artifact. */
  readonly artifactDigest: string
  readonly authorizationExpiresAtUnixSeconds: number
}

export const CTF_RANGE_ORDER_LOOKUP_FIRST_DELAY_MS = 5_000
export const CTF_RANGE_ORDER_LOOKUP_DELAY_MAX_MS = 60_000

/** The delay after the n-th lookup read: 5 seconds, doubled after each read, at most 60 seconds. */
export function ctfRangeOrderLookupDelayMs(readCount: number): number {
  if (!Number.isSafeInteger(readCount) || readCount < 1) {
    throw new Error('order lookup read count is invalid')
  }
  // 5 s * 2^4 = 80 s already exceeds the cap, so the exponent stays small.
  const exponent = Math.min(readCount - 1, 4)
  return Math.min(
    CTF_RANGE_ORDER_LOOKUP_FIRST_DELAY_MS * 2 ** exponent,
    CTF_RANGE_ORDER_LOOKUP_DELAY_MAX_MS,
  )
}

const SCHEDULE_OPERATIONS_MAX = 1_024

/**
 * The lookup read times of `order-requested` records. It is a load control,
 * not funds authority: losing an entry, for example after a restart, only
 * allows an earlier read.
 */
export class CtfRangeOrderLookupSchedule {
  readonly #maxOperations: number
  readonly #entries = new Map<string, { reads: number; nextReadAtMs: number }>()

  constructor(options: { readonly maxOperations?: number } = {}) {
    this.#maxOperations = options.maxOperations ?? SCHEDULE_OPERATIONS_MAX
  }

  state(
    operationId: string,
    nowMs: number,
  ): { readonly kind: 'due' } | { readonly kind: 'waiting'; readonly nextReadAtMs: number } {
    const entry = this.#entries.get(operationId)
    return entry === undefined || nowMs >= entry.nextReadAtMs
      ? { kind: 'due' }
      : { kind: 'waiting', nextReadAtMs: entry.nextReadAtMs }
  }

  /** Record one read at `nowMs` and return the time of the next read. */
  recordRead(operationId: string, nowMs: number): number {
    const reads = (this.#entries.get(operationId)?.reads ?? 0) + 1
    const nextReadAtMs = nowMs + ctfRangeOrderLookupDelayMs(reads)
    this.#entries.delete(operationId)
    this.#entries.set(operationId, { reads, nextReadAtMs })
    while (this.#entries.size > this.#maxOperations) {
      const oldest = this.#entries.keys().next().value
      if (oldest === undefined) break
      this.#entries.delete(oldest)
    }
    return nextReadAtMs
  }

  /**
   * Move the next read to `atMs` or later without counting a read, for
   * example after the `order-lookup` rate limit. Return the time of the next read.
   */
  deferRead(operationId: string, nowMs: number, atMs: number): number {
    const entry = this.#entries.get(operationId)
    const reads = entry?.reads ?? 0
    // The wait is at least the step that the next counted read would wait.
    const nextReadAtMs = Math.max(atMs, nowMs + ctfRangeOrderLookupDelayMs(reads + 1))
    this.#entries.delete(operationId)
    this.#entries.set(operationId, { reads, nextReadAtMs })
    while (this.#entries.size > this.#maxOperations) {
      const oldest = this.#entries.keys().next().value
      if (oldest === undefined) break
      this.#entries.delete(oldest)
    }
    return nextReadAtMs
  }

  forget(operationId: string): void {
    this.#entries.delete(operationId)
  }
}

/** The response states of an accepted order. A refusal never returns a capability. */
const ACCEPTED_CAPABILITY_STATES = new Set<SettlementCapabilityState>([
  'bindingPending',
  'bound',
  'selected',
  'uncertain',
  'terminal',
])

/**
 * The capability of an accepted admission-form response. It throws when the
 * response has no capability or a foreign one; the caller then keeps
 * `order-requested` and recovery reads the order.
 */
export function projectCtfRangeOrderAdmissionResponse(
  response: SubmitOrderResponse,
  identity: CtfRangeOrderAdmissionIdentity,
): CtfRangeOrderPreparationCapability {
  const capability = response.settlementCapability
  if (
    capability === undefined ||
    capability.orderId !== response.orderId ||
    capability.clientOrderId !== identity.clientOrderId ||
    capability.marketId !== identity.marketId ||
    capability.artifactDigest !== identity.artifactDigest ||
    !ACCEPTED_CAPABILITY_STATES.has(capability.state)
  ) {
    throw new Error('engine returned a foreign order admission response')
  }
  return decodeCtfRangeOrderPreparationCapability({
    artifactId: capability.reference.artifactId,
    bindingDigest: capability.reference.bindingDigest,
    artifactDigest: capability.artifactDigest,
    orderId: capability.orderId,
  })
}

/**
 * The capability of a found order, or null when the order holds another
 * artifact or route. A null result keeps `order-requested`.
 */
export function projectCtfRangeOrderLookup(
  lookup: OrderLookupResponse,
  identity: CtfRangeOrderAdmissionIdentity,
): CtfRangeOrderPreparationCapability | null {
  if (lookup.artifactDigest !== identity.artifactDigest || lookup.marketId !== identity.marketId) {
    return null
  }
  return decodeCtfRangeOrderPreparationCapability({
    artifactId: lookup.settlementCapability.artifactId,
    bindingDigest: lookup.settlementCapability.bindingDigest,
    artifactDigest: lookup.artifactDigest,
    orderId: lookup.orderId,
  })
}

export type CtfRangeOrderRequestRecovery =
  /** At or after authorization expiry: run the NUT-09 and NUT-07 recovery and the refund path. */
  | { readonly kind: 'expired' }
  /** The engine accepted the order with the local artifact: move to `order-submitted`. */
  | { readonly kind: 'submitted'; readonly capability: CtfRangeOrderPreparationCapability }
  /** Keep `order-requested` and read again at `retryAtMs`. */
  | {
      readonly kind: 'pending'
      readonly reason: 'waiting' | 'not-found' | 'digest-mismatch' | 'rate-limited'
      readonly retryAtMs: number
    }

/**
 * One recovery pass of an `order-requested` record. It sends at most one
 * read-only lookup and never a request that can create the order. A lookup
 * refused by its rate limit (429) is not a counted read: the next read waits
 * at least until its `Retry-After`. Any other failed lookup throws after the
 * schedule records the read.
 */
export async function recoverCtfRangeOrderRequest(input: {
  readonly identity: CtfRangeOrderAdmissionIdentity
  readonly nowMs: number
  readonly schedule: CtfRangeOrderLookupSchedule
  readonly lookupOrder: (
    conditionId: string,
    clientOrderId: string,
  ) => Promise<OrderLookupResponse | null>
}): Promise<CtfRangeOrderRequestRecovery> {
  const { identity, nowMs, schedule } = input
  const operationId = identity.rangeOperationId
  const expiryMs = identity.authorizationExpiresAtUnixSeconds * 1_000
  if (nowMs >= expiryMs) {
    schedule.forget(operationId)
    return { kind: 'expired' }
  }
  const state = schedule.state(operationId, nowMs)
  if (state.kind === 'waiting') {
    return { kind: 'pending', reason: 'waiting', retryAtMs: Math.min(state.nextReadAtMs, expiryMs) }
  }
  let found: OrderLookupResponse | null
  try {
    found = await input.lookupOrder(identity.conditionId, identity.clientOrderId)
  } catch (error) {
    if (error instanceof EngineClientError && error.status === 429) {
      const retryAfterMs = (error.retryAfterSeconds ?? 0) * 1_000
      const nextReadAtMs = schedule.deferRead(operationId, nowMs, nowMs + retryAfterMs)
      return {
        kind: 'pending',
        reason: 'rate-limited',
        retryAtMs: Math.min(nextReadAtMs, expiryMs),
      }
    }
    schedule.recordRead(operationId, nowMs)
    throw error
  }
  const retryAtMs = Math.min(schedule.recordRead(operationId, nowMs), expiryMs)
  if (found === null) return { kind: 'pending', reason: 'not-found', retryAtMs }
  const capability = projectCtfRangeOrderLookup(found, identity)
  if (capability === null) return { kind: 'pending', reason: 'digest-mismatch', retryAtMs }
  schedule.forget(operationId)
  return { kind: 'submitted', capability }
}
