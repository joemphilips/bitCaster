import type {
  AssetMonitoringAssetsQuery,
  AssetMonitoringPortfolioQuery,
  MarketCreationInput,
  OracleNostrEvent,
  QueryMarketsParams as EngineQueryMarketsParams,
} from '@bitcaster-market/client-sdk'
import type { WalletPaymentQuote } from '@bitcaster-market/client-sdk/walletPaymentQuote'
export type { WalletPaymentQuote } from '@bitcaster-market/client-sdk/walletPaymentQuote'
import type { MarketFundingDeliveryAttempt } from '@bitcaster-market/client-sdk/marketFundingDelivery'
import type { CtfRangeOrderFeeFacts } from '@bitcaster-market/client-sdk/ctfRangeOrderFeeComposition'
import { DURABLE_CUSTODY_RECOVERY_PAGE_BYTES_MAX } from '@bitcaster-market/client-sdk/durableCustody'

export const DAEMON_WATCH_MEDIA_TYPE = 'application/x-ndjson'
export const DAEMON_WATCH_REQUEST_BYTES_MAX = 64 * 1024
export const DAEMON_WATCH_FRAME_BYTES_MAX = DURABLE_CUSTODY_RECOVERY_PAGE_BYTES_MAX
export const DAEMON_MARKET_WATCH_CONDITIONS_MAX = 200
export const DAEMON_ACTIVITY_PAGE_SIZE_MAX = 50
export const DAEMON_ACTIVITY_CURSOR_BYTES_MAX = 512

export interface WalletActivityParams {
  walletId?: string
  cursor?: string | null
  pageSize?: number
}

export function validateWalletActivityParams(value: unknown): WalletActivityParams {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Wallet Activity request is invalid')
  }
  const params = value as Record<string, unknown>
  if (
    Object.keys(params).some((key) => !['walletId', 'cursor', 'pageSize'].includes(key)) ||
    (params.walletId !== undefined &&
      (typeof params.walletId !== 'string' || !/^[0-9a-f]{64}$/.test(params.walletId))) ||
    (params.cursor !== undefined &&
      params.cursor !== null &&
      (typeof params.cursor !== 'string' ||
        params.cursor.length === 0 ||
        new TextEncoder().encode(params.cursor).byteLength > DAEMON_ACTIVITY_CURSOR_BYTES_MAX)) ||
    (params.pageSize !== undefined &&
      (typeof params.pageSize !== 'number' ||
        !Number.isSafeInteger(params.pageSize) ||
        params.pageSize < 1 ||
        params.pageSize > DAEMON_ACTIVITY_PAGE_SIZE_MAX))
  ) {
    throw new Error('Wallet Activity request is invalid')
  }
  return params as WalletActivityParams
}

export type DaemonWatchCommand =
  | { method: 'market.watch'; params: { conditionIds: string[] } | { liked: true } }
  | { method: 'wallet.watch'; params?: undefined }
  | { method: 'wallet.request.watch'; params: { requestId: string } }

export interface DaemonWatchEvent<T = unknown> {
  type: 'event'
  event: string
  sourceRevision?: string | number
  data: T
}

export type DaemonWatchFrame<T = unknown> =
  | DaemonWatchEvent<T>
  | { type: 'complete' }
  | {
      type: 'error'
      code: 'watch-unavailable' | 'watch-failed'
      error: string
    }

export function isDaemonWatchCommand(value: unknown): value is DaemonWatchCommand {
  if (value === null || typeof value !== 'object') return false
  const method = (value as { method?: unknown }).method
  return method === 'market.watch' || method === 'wallet.watch' || method === 'wallet.request.watch'
}

export function validateDaemonWatchCommand(value: unknown): DaemonWatchCommand {
  if (!isDaemonWatchCommand(value)) throw new Error('invalid daemon watch command')
  switch (value.method) {
    case 'wallet.request.watch':
      if (
        value.params === undefined ||
        value.params === null ||
        typeof value.params !== 'object' ||
        Array.isArray(value.params) ||
        Object.keys(value.params).length !== 1 ||
        typeof value.params.requestId !== 'string' ||
        value.params.requestId.length === 0 ||
        new TextEncoder().encode(value.params.requestId).byteLength > 256
      )
        throw new Error('invalid daemon watch command')
      return { method: value.method, params: { requestId: value.params.requestId } }
    case 'wallet.watch':
      if (value.params !== undefined) throw new Error('invalid daemon watch command')
      return { method: value.method }
    case 'market.watch': {
      const params = value.params
      if (
        !params ||
        typeof params !== 'object' ||
        Array.isArray(params) ||
        Object.keys(params).length !== 1
      )
        throw new Error('invalid daemon watch command')
      if ('liked' in params) {
        if (params.liked !== true) throw new Error('invalid daemon watch command')
        return { method: value.method, params: { liked: true } }
      }
      const ids = 'conditionIds' in params ? params.conditionIds : undefined
      if (
        !Array.isArray(ids) ||
        ids.length < 1 ||
        ids.length > DAEMON_MARKET_WATCH_CONDITIONS_MAX ||
        ids.some((id) => typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) ||
        new Set(ids).size !== ids.length
      )
        throw new Error('invalid daemon watch command')
      return { method: value.method, params: { conditionIds: [...ids] } }
    }
  }
}

export function decodeDaemonWatchFrame(value: unknown): DaemonWatchFrame {
  if (value === null || typeof value !== 'object') throw new Error('invalid daemon watch frame')
  const frame = value as Record<string, unknown>
  switch (frame.type) {
    case 'complete':
      return { type: 'complete' }
    case 'error':
      if (typeof frame.error !== 'string') break
      switch (frame.code) {
        case 'watch-unavailable':
          return { type: 'error', code: frame.code, error: 'daemon watch is unavailable' }
        case 'watch-failed':
          return { type: 'error', code: frame.code, error: 'daemon watch failed' }
      }
      break
    case 'event':
      if (
        typeof frame.event !== 'string' ||
        frame.event.length === 0 ||
        !Object.hasOwn(frame, 'data') ||
        (frame.sourceRevision !== undefined &&
          typeof frame.sourceRevision !== 'string' &&
          !(typeof frame.sourceRevision === 'number' && Number.isSafeInteger(frame.sourceRevision)))
      )
        break
      return {
        type: 'event',
        event: frame.event,
        data: frame.data,
        ...(frame.sourceRevision === undefined
          ? {}
          : { sourceRevision: frame.sourceRevision as string | number }),
      }
  }
  throw new Error('invalid daemon watch frame')
}

export type DaemonCommand =
  | { method: 'health'; params?: undefined }
  | { method: 'daemon.status'; params?: undefined }
  | { method: 'market.create'; params: MarketCreateParams }
  | { method: 'market.create-native'; params: MarketCreateNativeParams }
  | { method: 'market.creation-resume'; params: MarketCreationResumeParams }
  | { method: 'market.creation-status'; params: { creationId: string } }
  | { method: 'market.creation-quote'; params: { outcomes: string[] } }
  | { method: 'market.close'; params: MarketCloseParams }
  | {
      method: 'market.oracle-backup-list'
      params: {
        relay?: string
        cursor?: import('@bitcaster-market/client-sdk').OracleBackupScanCursor
      }
    }
  | { method: 'market.oracle-backup-restore'; params: { eventId: string; relay: string } }
  | {
      method: 'market.oracle-backup-status'
      params: { conditionId?: string; cursor?: string; limit?: number }
    }
  | { method: 'market.oracle-backup-retry'; params: { conditionId: string } }
  | { method: 'market.announcement-republish'; params: { conditionId: string } }
  | {
      method: 'market.attest'
      params: { conditionId: string; outcome: string; explanation?: string; relayOnly?: boolean }
    }
  | {
      method: 'market.attestation-retry'
      params: { conditionId: string; relayOnly?: boolean; republish?: boolean }
    }
  | { method: 'market.resolution-status'; params: { conditionId: string } }
  | { method: 'markets.query'; params: QueryMarketsParams }
  | { method: 'markets.show'; params: { conditionId: string } }
  | { method: 'market.funding.quote'; params: { conditionId: string; requestedAmountMsat: number } }
  | { method: 'market.funding.head'; params: { conditionId: string } }
  | { method: 'market.fund'; params: MarketFundParams }
  | { method: 'score.show'; params?: undefined }
  | { method: 'score.quote'; params: { deliveryId: string; scorePoints: number } }
  | { method: 'score.buy'; params: { consent: ScorePurchaseConsent } }
  | { method: 'score.status'; params: { consent: ScorePurchaseConsent } }
  | { method: 'wallet.balance'; params?: undefined }
  | { method: 'wallet.positions'; params?: undefined }
  | {
      method: 'wallet.portfolio'
      params?: Pick<AssetMonitoringPortfolioQuery, 'timeframe' | 'pageSize'>
    }
  | {
      method: 'wallet.assets'
      params?: Pick<AssetMonitoringAssetsQuery, 'cursor' | 'pageSize'>
    }
  | { method: 'wallet.pay.quote'; params: { invoice: string } }
  | { method: 'wallet.pay.execute'; params: { consent: WalletPaymentQuote } }
  | { method: 'wallet.pay.status'; params: { operationId: string } }
  | { method: 'wallet.receive'; params: WalletReceiveParams }
  | { method: 'wallet.request.create'; params?: { requestId?: string } }
  | { method: 'wallet.request.status'; params: { requestId: string } }
  | { method: 'wallet.request.recover'; params: { requestId: string } }
  | { method: 'wallet.request.list'; params?: { cursor?: string | null; pageSize?: number } }
  | {
      method: 'wallet.send'
      params: { amountMsat: number; mintUrl?: string; operationId?: string }
    }
  | { method: 'wallet.invoice.create'; params: { amountMsat: number } }
  | { method: 'wallet.invoice.show'; params: { quoteRecordId: string } }
  | { method: 'wallet.invoice.hide'; params: { quoteRecordId: string } }
  | {
      method: 'wallet.invoice.replace'
      params: { quoteRecordId: string; amountMsat: number }
    }
  | { method: 'wallet.reclaim'; params: { transferId: string } }
  | { method: 'wallet.splitCompleteSet'; params: WalletSplitCompleteSetParams }
  | { method: 'wallet.consolidateMarket'; params: WalletConsolidateMarketParams }
  | { method: 'wallet.consolidateProofs'; params?: undefined }
  | { method: 'wallet.retireCondition'; params: WalletRetireConditionParams }
  | { method: 'wallet.claimPosition'; params: WalletClaimPositionParams }
  | { method: 'wallet.removePreview'; params: WalletClaimPositionParams }
  | { method: 'wallet.removePosition'; params: { preview: WalletRemovePreview; acknowledge: true } }
  | { method: 'wallet.operations'; params?: { kind?: string; state?: string } }
  | { method: 'wallet.activity'; params?: WalletActivityParams }
  | { method: 'wallet.recover'; params?: undefined }
  | { method: 'order.submit'; params: SubmitOrderParams }
  | { method: 'order.fee-preview'; params: OrderDraftParams }
  | { method: 'order.status'; params: { marketId: string; orderId: string } }
  | { method: 'order.list'; params?: { marketId?: string; status?: string } }
  | { method: 'order.cancel'; params: { marketId: string; orderId: string } }
  | { method: 'order.book'; params: { marketId: string } }

export interface OrderDraftParams {
  marketId: string
  outcomeId: string
  tokenSide?: 'Outcome' | 'Complement'
  side: 'Buy' | 'Sell'
  price?: number
  maxQuotePaymentSubunits?: number | null
  minQuotePaymentSubunits?: number | null
  amountSubunits: number
  minimumFillAmountSubunits?: number
  consolidateProofs?: boolean
  timeInForce: 'FOK'
  expiresAt?: string | null
}

export interface WalletClaimPositionParams {
  conditionId: string
  outcomeCollection: string
}

export interface WalletRemovePreview extends WalletClaimPositionParams {
  version: 1
  scopeId: string
  mintUrl: string
  targets: Array<{
    proofId: string
    keysetId: string
    amountSubunits: number
    proofSnapshot: string
    operationId: string
    operationSnapshot: string
    canonicalSnapshot: string | null
  }>
  batchDigest: string
  moreProofsRemain: boolean
}

export interface WalletClaimPositionResult extends WalletClaimPositionParams {
  legs: Array<{
    operationId: string
    keysetId: string
    state: 'completed' | 'losing' | 'pending'
    payoutAmountSubunits: number
    oracleEvidence?: import('@bitcaster-market/client-sdk/conditionOracleEvidence').ConditionOracleEvidenceSummary
  }>
}

export interface ProtectedOrderConsentRequest {
  marketId: string
  outcomeId: string
  tokenSide: 'Outcome' | 'Complement'
  side: 'Buy' | 'Sell'
  price: number
  maxQuotePaymentSubunits: number | null
  minQuotePaymentSubunits: number | null
  amountSubunits: number
  minimumFillAmountSubunits: number
  consolidateProofs: boolean
  timeInForce: 'FOK'
}

export interface OrderFeeConsent {
  request: ProtectedOrderConsentRequest
  feeFacts: CtfRangeOrderFeeFacts
}

export interface SubmitOrderParams extends OrderDraftParams {
  feeConsent: OrderFeeConsent
  comment?: { content: string; marketUrl: string }
}

export interface QueryMarketsParams {
  state?: EngineQueryMarketsParams['state']
  sort?: EngineQueryMarketsParams['sort']
  tag?: EngineQueryMarketsParams['tag']
  creator?: string
  ids?: string[]
  search?: string
  limit?: number
  cursor?: string
}

export interface MarketCreateParams {
  conditionId: string
  title: string
  description: string
  outcomes: string[]
  tags?: string[]
  /** Local file path on the daemon host. */
  thumbnailPath?: string
}

export interface MarketCreateNativeParams {
  creationId: string
  eventId: string
  market: MarketCreationInput
  relayUrls: string[]
  /** Local file path on the daemon host. */
  thumbnailPath?: string
  /** Maximum wallet debit for a nonzero registration fee. */
  maxWalletDebitMsat?: number
}

export interface MarketCreationResumeParams {
  creationId: string
  /** Maximum wallet debit for a nonzero registration fee. */
  maxWalletDebitMsat?: number
  /** Retry with the exact same thumbnail bytes that the creation first used. */
  thumbnailPath?: string
}

export interface MarketCloseParams {
  conditionId: string
  /** Signed kind-89 DLC oracle attestation event JSON. */
  attestationEvent: OracleNostrEvent
}

export interface MarketFundParams {
  conditionId: string
  attempt: MarketFundingDeliveryAttempt
  /** Required only when a new begin reaches wallet preparation. */
  maxWalletDebitMsat?: number
}

export interface ScorePurchaseRequest {
  deliveryId: string
  scorePoints: number
  amountMsat: number
  purchasedTotalEpoch: number
  engineBaseUrl: string
  accountSubject: string
  walletId: string
  mintUrl: string
}

export interface ScorePurchaseCost {
  amountMsat: number
  sendPreparationFeeMsat: number
  totalWalletDebitMsat: number
}

export interface ScorePurchaseConsent {
  request: ScorePurchaseRequest
  cost: ScorePurchaseCost
}

export interface WalletReceiveParams {
  token: string
  conditionId?: string
  outcomeSetId?: string
}

export interface WalletSplitCompleteSetParams {
  conditionId: string
  amountMsat: number
  mintUrl?: string
  operationId?: string
}

export interface WalletConsolidateMarketParams {
  marketId: string
  // CLI strategy names: merge→t1, sweep→t2, reclaim→t3
  type: 't1' | 't2' | 't3'
}

export interface WalletRetireConditionParams {
  conditionId: string
  acknowledge: boolean
}

export interface WalletRetireConditionResult {
  conditionId: string
  state: 'preview' | 'retired'
  action: 'redeem-winning-and-retain-losing'
  proofCount: number
  redeemableProofCount: number
  retainedProofCount: number
  grossAmountSubunits: number
  retainedAmountSubunits: number
  estimatedInputFeeSubunits: number
  netAmountSubunits: number
}

export interface WalletConsolidationProofSummary {
  id: string
  amount: number
  label: string
  keysetId: string
}

export interface WalletConsolidationResult {
  marketId: string
  conditionId: string
  type: 't1' | 't2' | 't3'
  status: 'consolidated' | 'skipped'
  reason?: string
  convertFeeMsat: number
  collateralReturnedMsat: number
  spentInputs: WalletConsolidationProofSummary[]
  outputs: WalletConsolidationProofSummary[]
}

export interface DaemonResponse<T = unknown> {
  ok: boolean
  result?: T
  error?: string
  code?: string
  clientOrderId?: string
  operationId?: string
  orderId?: string
}

export interface DaemonHealth {
  status: 'ok'
  service: 'bitcaster-daemon'
  sdk: '@bitcaster-market/client-sdk'
  state: 'ready' | 'custody-recovery-pending' | 'missing-profile'
}
