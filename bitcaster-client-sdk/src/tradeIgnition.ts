import { secp256k1 } from '@noble/curves/secp256k1.js'
import type {
  PendingPubkeySubmission,
  SubmitEphemeralPubkeyResponse,
  SubmitOrderResponse,
} from './engineClient.ts'

export interface EphemeralKeypair {
  /** 32-byte secp256k1 private scalar, lowercase hex (64 chars). */
  privateKeyHex: string
  /** 33-byte compressed secp256k1 public key, lowercase hex (66 chars, 02/03 prefix). */
  publicKeyHex: string
}

export interface MatchedDelta {
  marketId: string
  tradeId: string
  makerOrderId: string
  takerOrderId: string
  executionPrice: number
  amountSubunits: number
  path: string
  matchedAt: string
  deadline: string
}

export interface KeypairStore {
  /** Get or create the per-trade compressed public key. Private material stays in the caller's store. */
  getOrCreatePublicKey(tradeId: string): Promise<string>
  /** Retrieve private material only for settlement; never needed for engine pubkey submission. */
  getPrivateKey(tradeId: string): Promise<string | null>
}

export type TradeIgnitionSubmitEphemeralPubkey = (
  tradeId: string,
  publicKeyHex: string,
  conditionId?: string,
) => Promise<SubmitEphemeralPubkeyResponse>

export interface TradeIgnitionResult {
  submitted: boolean
  tradeId: string
  role?: string
  reason?: 'duplicate' | 'not-maker-order' | 'no-pending-submissions'
}

export interface HandleMatchedForMakerParams {
  keypairStore: KeypairStore
  isOurOrder(orderId: string): boolean | Promise<boolean>
  submitEphemeralPubkey: TradeIgnitionSubmitEphemeralPubkey
  seenTradeIds?: Set<string>
}

export interface HandlePendingPubkeySubmissionsParams {
  keypairStore: KeypairStore
  submitEphemeralPubkey: TradeIgnitionSubmitEphemeralPubkey
  seenTradeIds?: Set<string>
  conditionId?: string
}

export interface TradeJoinResult {
  success: boolean
  error?: string
  deduped?: boolean
}

export interface JoinTradeWithRetryParams {
  tradeId: string
  invokeJoinTrade(tradeId: string): Promise<TradeJoinResult>
  getSwapStep(tradeId: string): string | undefined | Promise<string | undefined>
  joinedTradeIds?: Set<string>
  maxRetries?: number
  retryDelayMs?: number
  retryExhaustedRecoveryDelayMs?: number
  scheduleResumeActiveSwaps?: (delayMs: number) => void
  delay?: (ms: number) => Promise<void>
}

const DEFAULT_JOIN_TRADE_MAX_RETRIES = 5
const DEFAULT_JOIN_TRADE_RETRY_DELAY_MS = 500
const DEFAULT_RETRY_EXHAUSTED_RECOVERY_DELAY_MS = 10_000

/** Produce a fresh compressed secp256k1 keypair for one trade/order ignition. */
export function generateEphemeralKeypair(): EphemeralKeypair {
  const privateKey = secp256k1.utils.randomSecretKey()
  const publicKey = secp256k1.getPublicKey(privateKey, true)
  return {
    privateKeyHex: bytesToHex(privateKey),
    publicKeyHex: bytesToHex(publicKey),
  }
}

/**
 * Return the condition id portion of `{conditionId}-{outcomeName}`.
 * Outcome names must not contain `-`; split on the final dash to tolerate
 * condition ids that contain dashes.
 */
export function conditionIdFromMarketId(marketId: string): string {
  return marketId.slice(0, marketId.lastIndexOf('-'))
}

export function parseMatchedDelta(payload: unknown): MatchedDelta | null {
  if (payload === null || typeof payload !== 'object') return null
  const raw = payload as Record<string, unknown>
  const marketId = readString(raw, 'marketId', 'MarketId')
  const tradeId = readString(raw, 'tradeId', 'TradeId')
  const makerOrderId = readString(raw, 'makerOrderId', 'MakerOrderId')
  const takerOrderId = readString(raw, 'takerOrderId', 'TakerOrderId')
  const executionPrice = readNumber(raw, 'executionPrice', 'ExecutionPrice')
  const amountSubunits = readNumber(raw, 'amountSubunits', 'AmountSubunits')
  const path = readString(raw, 'path', 'Path')
  const matchedAt = readString(raw, 'matchedAt', 'MatchedAt')
  const deadline = readString(raw, 'deadline', 'Deadline')

  // Fail-closed: marketId, tradeId, deadline are required protocol fields.
  // path and matchedAt are required by asyncapi.yaml but may be absent in
  // older payloads — default path to empty string and matchedAt to now.
  if (
    !marketId ||
    !tradeId ||
    !makerOrderId ||
    !takerOrderId ||
    !deadline ||
    executionPrice === null ||
    amountSubunits === null
  ) {
    return null
  }

  return {
    marketId,
    tradeId,
    makerOrderId,
    takerOrderId,
    executionPrice,
    amountSubunits,
    path: path ?? '',
    matchedAt: matchedAt ?? new Date().toISOString(),
    deadline,
  }
}

/**
 * Handle a MarketHub `Matched` delta for the maker side only. Taker ignition
 * uses order-submission `pendingPubkeySubmissions` via
 * `handlePendingPubkeySubmissions`.
 */
export async function handleMatchedForMaker(
  matched: MatchedDelta,
  params: HandleMatchedForMakerParams,
): Promise<TradeIgnitionResult> {
  // Mark as seen BEFORE any async work to prevent concurrent duplicate
  // Matched events from both passing the has() check.
  if (params.seenTradeIds?.has(matched.tradeId)) {
    return { submitted: false, tradeId: matched.tradeId, reason: 'duplicate' }
  }
  params.seenTradeIds?.add(matched.tradeId)

  try {
    if (!(await params.isOurOrder(matched.makerOrderId))) {
      params.seenTradeIds?.delete(matched.tradeId)
      return { submitted: false, tradeId: matched.tradeId, reason: 'not-maker-order' }
    }

    const publicKey = await params.keypairStore.getOrCreatePublicKey(matched.tradeId)
    const response = await params.submitEphemeralPubkey(
      matched.tradeId,
      publicKey,
      conditionIdFromMarketId(matched.marketId),
    )
    return { submitted: true, tradeId: matched.tradeId, role: response.role || 'maker' }
  } catch (err) {
    params.seenTradeIds?.delete(matched.tradeId)
    throw err
  }
}

export async function handlePendingPubkeySubmissions(
  response:
    | Pick<SubmitOrderResponse, 'pendingPubkeySubmissions'>
    | { pendingPubkeySubmissions?: PendingPubkeySubmission[] | null },
  params: HandlePendingPubkeySubmissionsParams,
): Promise<TradeIgnitionResult[]> {
  const pending = response.pendingPubkeySubmissions ?? []
  if (pending.length === 0) {
    return []
  }

  const results: TradeIgnitionResult[] = []
  for (const submission of pending) {
    // Mark as seen BEFORE any async work to prevent concurrent races.
    if (params.seenTradeIds?.has(submission.tradeId)) {
      results.push({ submitted: false, tradeId: submission.tradeId, reason: 'duplicate' })
      continue
    }
    params.seenTradeIds?.add(submission.tradeId)

    try {
      const publicKey = await params.keypairStore.getOrCreatePublicKey(submission.tradeId)
      const submitResult = await params.submitEphemeralPubkey(
        submission.tradeId,
        publicKey,
        params.conditionId,
      )
      results.push({
        submitted: true,
        tradeId: submission.tradeId,
        role: submitResult.role || submission.role,
      })
    } catch (err) {
      params.seenTradeIds?.delete(submission.tradeId)
      throw err
    }
  }
  return results
}

export async function joinTradeWithRetry(
  params: JoinTradeWithRetryParams,
): Promise<TradeJoinResult> {
  if (params.joinedTradeIds?.has(params.tradeId)) {
    return { success: true, deduped: true }
  }

  params.joinedTradeIds?.add(params.tradeId)
  try {
    const maxRetries = params.maxRetries ?? DEFAULT_JOIN_TRADE_MAX_RETRIES
    const retryDelayMs = params.retryDelayMs ?? DEFAULT_JOIN_TRADE_RETRY_DELAY_MS
    const retryExhaustedRecoveryDelayMs =
      params.retryExhaustedRecoveryDelayMs ?? DEFAULT_RETRY_EXHAUSTED_RECOVERY_DELAY_MS
    const wait = params.delay ?? delay
    let lastResult: TradeJoinResult = { success: false }

    for (let retry = 0; retry <= maxRetries; retry += 1) {
      if (retry > 0 && !(await shouldRetryJoinTrade(params))) {
        params.joinedTradeIds?.delete(params.tradeId)
        return lastResult
      }

      lastResult = await params.invokeJoinTrade(params.tradeId)
      if (lastResult.success) return lastResult

      if (!(await shouldRetryJoinTrade(params))) {
        params.joinedTradeIds?.delete(params.tradeId)
        return lastResult
      }
      if (retry >= maxRetries) break

      await wait(retryDelayMs)
    }

    params.joinedTradeIds?.delete(params.tradeId)
    params.scheduleResumeActiveSwaps?.(retryExhaustedRecoveryDelayMs)
    return lastResult
  } catch (err) {
    params.joinedTradeIds?.delete(params.tradeId)
    throw err
  }
}

async function shouldRetryJoinTrade(params: JoinTradeWithRetryParams): Promise<boolean> {
  return (await params.getSwapStep(params.tradeId)) === 'awaiting-trade-created'
}

function readString(
  raw: Record<string, unknown>,
  camelKey: string,
  pascalKey: string,
): string | null {
  const camel = raw[camelKey]
  if (typeof camel === 'string') return camel
  const pascal = raw[pascalKey]
  if (typeof pascal === 'string') return pascal
  return null
}

function readNumber(
  raw: Record<string, unknown>,
  camelKey: string,
  pascalKey: string,
): number | null {
  const camel = raw[camelKey]
  if (typeof camel === 'number') return camel
  const pascal = raw[pascalKey]
  if (typeof pascal === 'number') return pascal
  return null
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}
