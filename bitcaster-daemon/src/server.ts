import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { measureOrderPhase, type OrderTimelineObserver } from './orderTimeline.ts'
import { createConnection } from 'node:net'
import { chmod, unlink } from 'node:fs/promises'
import { readMarketThumbnail } from './marketThumbnail.ts'
import { createAuthenticatedBitcasterEngineClient } from './engineClient.ts'
import { activeNativeConfig } from './nativeConfig.ts'
import { dispatchNativeMarketCreation } from './nativeMarketCreationRpc.ts'
import { createNativeOracleCreationStore } from './nativeOracleCreationStore.ts'
import { createNativeOracleHelperAdapter } from './nativeOracleHelper.ts'
import {
  publishNativeMarketOutcome,
  retryNativeMarketPublication,
  nativeOraclePublicationRpcResult,
  type NativeOraclePublicationPorts,
} from './nativeOraclePublicationCoordinator.ts'
import { publishNativeOracleEvent } from './nativeOraclePublication.ts'
import { Amount, OutputData, type Proof } from '@cashu/cashu-ts'
import {
  BitcasterEngineClient,
  EngineClientError,
  isDefinitiveOrderSubmissionError,
  type OrderBookSnapshot,
  type OrderStatusResponse,
  type ParticipationScoreResponse,
  type QueryMarketsParams,
  type QueryMarketsResponse,
  type CreateSettlementCapabilityRequest,
  type AcknowledgeSettlementCapabilityResultRequest,
  type SettlementCapabilityAdmissionPolicyResponse,
  type SettlementCapabilityResponse,
  type SettlementCapabilityResultResponse,
  type SubmitOrderRequest,
  type SubmitOrderResponse,
  type ConditionAttestationResponse,
} from '@bitcaster-market/client-sdk/engineClient'
import type {
  DurableRecipientDeliveryStatus,
  DurableRecipientDeliverySubmission,
} from '@bitcaster-market/client-sdk/durableRecipientDelivery'
import {
  type AssetMonitoringAssetsQuery,
  type AssetMonitoringAssetsResponse,
  type AssetMonitoringPortfolioQuery,
  type AssetMonitoringPortfolioResponse,
  decodeAssetMonitoringAssetsQuery,
  decodeAssetMonitoringPortfolioQuery,
  createMarketViaEngine,
  conditionIdFromMarketId,
  isKind89NostrEvent,
  parseMarketOutcomes,
  validateMarketCreateEngineUrl,
  submitOracleAttestationViaEngine,
  type CreateMarketOutcome,
} from '@bitcaster-market/client-sdk'
import {
  isWalletPaymentOperationId,
  isWalletPaymentQuote,
} from '@bitcaster-market/client-sdk/walletPaymentQuote'
import {
  planParticipationScoreTopUp,
  type ParticipationScoreTopUpPlan,
} from '@bitcaster-market/client-sdk/participationScore'
import {
  validateOrderIntent,
  validateOrderRoutingIdentity,
} from '@bitcaster-market/client-sdk/orderValidation'
import { checkOrderSettlementSupport } from '@bitcaster-market/client-sdk/settlementSupport'
import {
  buildProtectedTradeTicket,
  decodeOrderQuotePaymentBounds,
} from '@bitcaster-market/client-sdk/tradeTicket'
import {
  decodeCtfRangeOrderFeeFacts,
  type CtfRangeOrderFeeFacts,
} from '@bitcaster-market/client-sdk/ctfRangeOrderFeeComposition'
import { createTradeCommentTemplate } from '@bitcaster-market/client-sdk/tradeComment'
import type {
  PreviewFokOrderRequest,
  PreviewFokOrderResponse,
  PreviewFokOrderCapacityRequest,
  PreviewFokOrderCapacityResponse,
} from '@bitcaster-market/client-sdk/fokOrderPreview'
import {
  COLLATERAL_COLLECTION,
  planCtfConsolidation,
  type CtfConsolidationStrategy,
} from '@bitcaster-market/client-sdk/ctfConsolidation'
import {
  normalizeMarketBaseAsset,
  normalizeMarketDivisibility,
  parseMarketDivisibility,
  type MarketBaseAsset,
} from '@bitcaster-market/client-sdk/marketUnits'
import { signNativeTradeComment } from './nostrAuth.ts'
import { recoverCompleteSetSplits, splitWalletCompleteSet } from './completeSetConversion.ts'
import { composeStartupCustodyRecovery, outgoingCashuRecoveryStatus } from './startupRecovery.ts'
import type { ManualCustodyRecoveryStatus } from './startupRecovery.ts'
import type { NativeLightningOps } from './nativeLightningOps.ts'
import type { NativePaymentRequestService } from './nativePaymentRequestService.ts'
import type {
  DaemonCommand,
  DaemonHealth,
  DaemonResponse,
  OrderDraftParams,
  OrderFeeConsent,
  ProtectedOrderConsentRequest,
  ScorePurchaseConsent,
  SubmitOrderParams,
  WalletPaymentQuote,
} from './protocol.ts'
import type { NativeWalletPaymentOps } from './nativeWalletPaymentOps.ts'
import type { NativeWalletPaymentRecoveryScan } from './nativeWalletPaymentRecovery.ts'
import { profileDir, readProfile } from './profile.ts'
import { bearerToken, readRpcToken, rpcSocketPath, tokenMatches } from './rpcAuth.ts'
import { readSecrets, readSelectedDaemonSigner, hasUnfinishedDaemonAccountWork } from './secrets.ts'
import {
  ensureState,
  listProofOperations,
  listLocalOrders,
  recordSubmittedOrder,
  recordOrderStatus,
} from './state.ts'
import {
  recoverPreparedWalletSends,
  recoverDurableWalletReceives,
  recoverDurableWalletProofImports,
  recoverDurableOutgoingCashuTransfers,
  reclaimDurableOutgoingCashuTransfer,
  deliverParticipationScoreCashu,
  ParticipationScoreRetryUnavailableError,
  quoteParticipationScoreCashu,
  readParticipationScoreDeliveryStatus,
  deliverMarketFundingCashu,
  quoteMarketFundingCashu,
  readMarketFundingHeadCashu,
  receiveWalletToken,
  sendWalletToken,
  executeCtfConsolidationPlan,
  resolveCtfConsolidationInputFees,
  resolveCtfConsolidationOutputKeysets,
  resolveMintKeysByKeyset,
  type WalletOpsDependencies,
} from './walletOps.ts'
import { readDaemonAvailableRegularMsatBalance } from './walletHoldings.ts'
import { readDaemonWalletBalance } from './walletBalance.ts'
import { NativeActivitySqlite } from './nativeActivitySqlite.ts'
import { createDaemonStateSqliteSession } from './stateSqlite.ts'
import { validateWalletActivityParams } from './protocol.ts'
import { deriveDurableCustodyWalletId } from '@bitcaster-market/client-sdk/durableCustody'
import type { CustodyScopeFence } from './profileFencing.ts'
import {
  consolidateWalletProofs,
  recoverWalletProofConsolidations,
} from './walletProofConsolidation.ts'
import {
  resumeDaemonConditionRetirements,
  retireDaemonConditionInventory,
} from './managedConditionRetirement.ts'
import { claimDaemonPosition, recoverDaemonPositionClaims } from './nativePositionClaim.ts'
import { previewDaemonPositionRemove, removeDaemonPosition } from './nativePositionRemove.ts'
import { streamDaemonWatch, type DaemonWatchProvider } from './watchTransport.ts'
import {
  DAEMON_WATCH_MEDIA_TYPE,
  DAEMON_WATCH_REQUEST_BYTES_MAX,
  isDaemonWatchCommand,
  validateDaemonWatchCommand,
} from './protocol.ts'

export interface DaemonServerOptions {
  observeOrderTimeline?: OrderTimelineObserver
  nativePaymentRequests?: NativePaymentRequestService
  watch?: DaemonWatchProvider
  host?: string
  port?: number
  socketPath?: string
  trackOwnedOrder?: (marketId: string, orderId: string) => Promise<void>
  prepareSettlementCapability?: PrepareSettlementCapability
  previewSettlementCapabilityFees?: PreviewSettlementCapabilityFees
  triggerSettlementRecovery?: () => void
  triggerCustodyRecovery?: () => void
  getCustodyFence?: () => CustodyScopeFence
  isCustodyReady?: () => boolean
  markCustodyReady?: () => void
  onManualCustodyRecoveryStatus?: (status: ManualCustodyRecoveryStatus) => void
  onOutcomeProofsReceived?: (conditionId: string, outcomeSetId: string) => Promise<void>
  nativeLightningOps?: NativeLightningOps
  nativeWalletPaymentOps?: DispatchDependencies['nativeWalletPaymentOps']
}

export interface EngineClientLike {
  submitOrder(marketId: string, request: SubmitOrderRequest): Promise<SubmitOrderResponse>
  getOrderStatus(marketId: string, orderId: string): Promise<OrderStatusResponse | null>
  cancelOrder(marketId: string, orderId: string): Promise<boolean>
  getOrderBook(marketId: string): Promise<OrderBookSnapshot>
  getAssetMonitoringAssets?(
    query: AssetMonitoringAssetsQuery,
  ): Promise<AssetMonitoringAssetsResponse>
  getPortfolio?(query: AssetMonitoringPortfolioQuery): Promise<AssetMonitoringPortfolioResponse>
  queryMarkets(params: QueryMarketsParams): Promise<QueryMarketsResponse>
  getParticipationScore(): Promise<ParticipationScoreResponse>
  getDurableRecipientDeliveryStatus?(
    deliveryId: string,
  ): Promise<DurableRecipientDeliveryStatus | null>
  submitDurableRecipientDelivery?(
    submission: DurableRecipientDeliverySubmission,
  ): Promise<DurableRecipientDeliveryStatus>
  getMarket?(conditionId: string): Promise<unknown | null>
  getConditionAttestation?(conditionId: string): Promise<ConditionAttestationResponse | null>
  createSettlementCapability?(
    request: CreateSettlementCapabilityRequest,
  ): Promise<SettlementCapabilityResponse>
  getSettlementCapabilityAdmissionPolicy?(): Promise<SettlementCapabilityAdmissionPolicyResponse>
  getSettlementCapabilityResultByOperation?(
    operationId: string,
  ): Promise<SettlementCapabilityResultResponse | null>
  acknowledgeSettlementCapabilityResult?(
    resultId: string,
    request: AcknowledgeSettlementCapabilityResultRequest,
  ): Promise<SettlementCapabilityResultResponse | null>
  previewFokOrder?(request: PreviewFokOrderRequest): Promise<PreviewFokOrderResponse>
  previewFokOrderCapacity?(
    request: PreviewFokOrderCapacityRequest,
  ): Promise<PreviewFokOrderCapacityResponse>
}

export interface PrepareSettlementCapabilityInput {
  clientOrderId: string
  marketId: string
  conditionId: string
  outcomeId: string
  tokenSide: 'Outcome' | 'Complement'
  side: 'Buy' | 'Sell'
  price: number
  maxQuotePaymentSubunits: number | null
  minQuotePaymentSubunits: number | null
  amountSubunits: number
  minimumFillAmountSubunits: number
  consolidateProofs: boolean
  baseAsset: 'sat'
  collateralUnit: 'msat'
  divisibility: number
  timeInForce: 'FOK'
  expiresAt: string | null
  mintUrl: string
  walletSeedHex: string
}

export interface PreparedSettlementCapability {
  operationId: string
  capability: SettlementCapabilityResponse
  markSubmitted(): Promise<void>
  markRejected(): Promise<void>
  consolidation: {
    operationIds: string[]
    feeSubunits: number
  }
}

export type BeforeCreateSettlementCapability = (requiredScore: number) => Promise<void>

export type PrepareSettlementCapability = (
  input: PrepareSettlementCapabilityInput,
  client: EngineClientLike,
  beforeCreateCapability?: BeforeCreateSettlementCapability,
  consentedFeeFacts?: CtfRangeOrderFeeFacts,
) => Promise<PreparedSettlementCapability>

export type PreviewSettlementCapabilityFees = (
  input: PrepareSettlementCapabilityInput,
  client: EngineClientLike,
) => Promise<CtfRangeOrderFeeFacts>

type DaemonParticipationScorePreflightResult =
  | { kind: 'disabled' | 'sufficient'; score: ParticipationScoreResponse }
  | {
      kind: 'paid'
      score: ParticipationScoreResponse
      deliveryId: string
      deliveryState: 'credited'
      operationId: string
    }

class InsufficientParticipationScoreBackingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InsufficientParticipationScoreBackingError'
  }
}

export interface DispatchDependencies extends WalletOpsDependencies {
  observeOrderTimeline?: OrderTimelineObserver
  nativePaymentRequests?: NativePaymentRequestService
  watch?: DaemonWatchProvider
  createEngineClient?: (options: { baseUrl: string; nostrSecretKeyHex: string }) => EngineClientLike
  /** Test seam for the native portfolio privacy setting. */
  isAssetMonitoringEnabled?: () => boolean
  /** Test seam for the three existing native funding operations. */
  marketFundingOps?: {
    quote: typeof quoteMarketFundingCashu
    head: typeof readMarketFundingHeadCashu
    deliver: typeof deliverMarketFundingCashu
  }
  participationScoreOps?: {
    quote: typeof quoteParticipationScoreCashu
    deliver: typeof deliverParticipationScoreCashu
  }
  nativeWalletPaymentOps?: Pick<NativeWalletPaymentOps, 'quote' | 'pay' | 'status'> & {
    recoverPage(): Promise<NativeWalletPaymentRecoveryScan>
  }
  prepareSettlementCapability?: PrepareSettlementCapability
  previewSettlementCapabilityFees?: PreviewSettlementCapabilityFees
  trackOwnedOrder?: (marketId: string, orderId: string) => Promise<void>
  triggerSettlementRecovery?: () => void
  triggerCustodyRecovery?: () => void
  getCustodyFence?: () => CustodyScopeFence
  isCustodyReady?: () => boolean
  markCustodyReady?: () => void
  onManualCustodyRecoveryStatus?: (status: ManualCustodyRecoveryStatus) => void
  onOutcomeProofsReceived?: (conditionId: string, outcomeSetId: string) => Promise<void>
  nativeLightningOps?: NativeLightningOps
  waitForParticipationScoreDeliveryRetry?: (attempt: number, delayMs: number) => Promise<void>
}

const PARTICIPATION_SCORE_DELIVERY_POLL_ATTEMPTS = 10
const PARTICIPATION_SCORE_DELIVERY_POLL_INTERVAL_MS = 8_000

export async function startDaemonServer(options: DaemonServerOptions = {}): Promise<Server> {
  const socketPath =
    options.socketPath ?? (options.host || options.port ? undefined : defaultRpcSocketPath())
  const host = options.host ?? '127.0.0.1'
  if (!socketPath && !isLoopbackBindHost(host)) {
    throw new Error(`bitcaster-daemon refuses to bind non-loopback host ${host}`)
  }
  // A running daemon cannot replace its profile authority. Validate and pin
  // the RPC token once at startup so concurrent WAL commits cannot turn
  // per-request immutable profile inspection into a process-level failure.
  const expectedToken = await readRpcToken()
  const server = createServer((req, res) => {
    void handleRequest(req, res, expectedToken, {
      observeOrderTimeline: options.observeOrderTimeline,
      watch: options.watch,
      nativePaymentRequests: options.nativePaymentRequests,
      trackOwnedOrder: options.trackOwnedOrder,
      prepareSettlementCapability: options.prepareSettlementCapability,
      previewSettlementCapabilityFees: options.previewSettlementCapabilityFees,
      triggerSettlementRecovery: options.triggerSettlementRecovery,
      triggerCustodyRecovery: options.triggerCustodyRecovery,
      getCustodyFence: options.getCustodyFence,
      isCustodyReady: options.isCustodyReady,
      markCustodyReady: options.markCustodyReady,
      onManualCustodyRecoveryStatus: options.onManualCustodyRecoveryStatus,
      onOutcomeProofsReceived: options.onOutcomeProofsReceived,
      nativeLightningOps: options.nativeLightningOps,
      nativeWalletPaymentOps: options.nativeWalletPaymentOps,
    })
  })
  if (socketPath) {
    await unlinkStaleSocket(socketPath)
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    try {
      await chmod(socketPath, 0o600)
    } catch (error) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await unlink(socketPath).catch(() => undefined)
      throw error
    }
    server.once('close', () => {
      void unlink(socketPath).catch(() => undefined)
    })
    process.stdout.write(`bitcaster-daemon listening on unix://${socketPath}\n`)
    return server
  }

  const port = options.port ?? 42871
  await new Promise<void>((resolve) => server.listen(port, host, resolve))
  const address = server.address()
  const boundPort = typeof address === 'object' && address ? address.port : port
  process.stdout.write(`bitcaster-daemon listening on http://${host}:${boundPort}\n`)
  return server
}

export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedToken: string | null,
  deps: DispatchDependencies = {},
): Promise<void> {
  if (!isLocalCaller(req.socket.remoteAddress)) {
    return writeJson(res, 403, { ok: false, error: 'forbidden' })
  }

  if (req.method !== 'POST' || req.url !== '/rpc') {
    return writeJson(res, 404, { ok: false, error: 'not found' })
  }

  // Authenticate before body consumption, not after an unbounded JSON decode.
  if (expectedToken && !tokenMatches(bearerToken(req.headers.authorization), expectedToken)) {
    return writeJson(res, 401, { ok: false, error: 'unauthorized' })
  }
  const wantsWatch = req.headers.accept === DAEMON_WATCH_MEDIA_TYPE
  let command: DaemonCommand
  try {
    command = JSON.parse(
      await readBody(
        req,
        wantsWatch || !expectedToken ? DAEMON_WATCH_REQUEST_BYTES_MAX : undefined,
      ),
    ) as DaemonCommand
  } catch {
    return writeJson(res, 400, { ok: false, error: 'invalid JSON command' })
  }
  if (command === null || typeof command !== 'object' || typeof command.method !== 'string') {
    return writeJson(res, 400, { ok: false, error: 'invalid JSON command' })
  }

  if (!expectedToken && command.method !== 'health') {
    return writeJson(res, 401, { ok: false, error: 'daemon RPC token is not initialized' })
  }
  if (isDaemonWatchCommand(command)) {
    if (!wantsWatch)
      return writeJson(res, 406, { ok: false, error: 'daemon watch requires NDJSON acceptance' })
    try {
      const selected = validateDaemonWatchCommand(command)
      const provider =
        selected.method === 'wallet.request.watch'
          ? deps.nativePaymentRequests === undefined
            ? undefined
            : (_command: unknown, signal: AbortSignal) =>
                deps.nativePaymentRequests!.watch(selected.params.requestId, signal)
          : deps.watch
      return await streamDaemonWatch(req, res, selected, provider)
    } catch {
      return writeJson(res, 400, { ok: false, error: 'invalid daemon watch command' })
    }
  }
  if (wantsWatch)
    return writeJson(res, 400, { ok: false, error: 'explicit daemon watch command required' })

  try {
    return writeJson(res, 200, await dispatch(command, deps))
  } catch (err) {
    return writeJson(res, 500, normalizeRpcError(err))
  }
}

function normalizeRpcError(err: unknown): DaemonResponse {
  if (!(err instanceof Error)) {
    return { ok: false, error: String(err) }
  }

  const status = 'status' in err && typeof err.status === 'number' ? err.status : undefined
  const cause = 'cause' in err && err.cause instanceof Error ? err.cause.message : undefined
  const detail = [err.message, status ? `status=${status}` : null, cause].filter(Boolean).join('; ')
  return { ok: false, error: detail || err.message }
}

function retirementPending(
  retirements: ReadonlyArray<{ readonly conditionId: string; readonly error: string | null }>,
): Array<{ operationId: string; error: string }> {
  return retirements
    .filter((entry) => entry.error !== null)
    .map((entry) => ({
      operationId: `condition-retirement:${entry.conditionId}`,
      error: entry.error!,
    }))
}

export async function dispatch(
  command: DaemonCommand,
  deps: DispatchDependencies = {},
): Promise<DaemonResponse> {
  const unsupportedPublicOrder = rejectUnsupportedPublicOrder(command)
  if (unsupportedPublicOrder !== null) return unsupportedPublicOrder
  if (deps.isCustodyReady?.() === false && requiresReadyCustody(command.method)) {
    return {
      ok: false,
      code: 'custody-recovery-pending',
      error: 'wallet recovery must complete before this command can use funds',
    }
  }
  if (
    requiresApplicationSigner(command.method) &&
    (await readProfile()) !== null &&
    !(await readSelectedDaemonSigner()).enabled
  )
    return { ok: false, code: 'signer-disconnected', error: 'Application signer is disconnected.' }
  switch (command.method) {
    case 'wallet.request.create':
    case 'wallet.request.status':
    case 'wallet.request.list':
    case 'wallet.request.recover':
      return dispatchNativePaymentRequest(command, deps)
    case 'health':
      return {
        ok: true,
        result: {
          status: 'ok',
          service: 'bitcaster-daemon',
          sdk: '@bitcaster-market/client-sdk',
          state: (await readProfile())
            ? deps.isCustodyReady?.() === false
              ? 'custody-recovery-pending'
              : 'ready'
            : 'missing-profile',
        } satisfies DaemonHealth,
      }
    case 'daemon.status': {
      const profile = await readProfile()
      if (!profile) {
        return { ok: false, error: 'daemon profile is not initialized' }
      }
      const state = await ensureState()
      return {
        ok: true,
        result: {
          profile,
          counts: {
            proofs: state.wallet.proofs.length,
            proofOperations: Object.keys(state.proofOperations).length,
            orders: Object.keys(state.orders).length,
          },
          wallet: await readDaemonWalletBalance(profileDir()),
        },
      }
    }
    case 'market.create-native':
    case 'market.creation-resume':
    case 'market.creation-status':
    case 'market.creation-quote':
      return dispatchNativeMarketCreation(command, deps)
    case 'market.create': {
      const profile = await readProfile()
      if (!profile) {
        return { ok: false, error: 'daemon profile is not initialized' }
      }
      const secrets = await readSecrets()
      if (!secrets) {
        return { ok: false, error: 'daemon secrets are not initialized' }
      }
      const engineUrlValidation = validateMarketCreateEngineUrl(profile.engineBaseUrl, true)
      if (!engineUrlValidation.ok) {
        return {
          ok: false,
          error: engineUrlValidation.error,
          code: engineUrlValidation.code,
        }
      }
      const client = createAuthenticatedBitcasterEngineClient({
        baseUrl: profile.engineBaseUrl,
        nostrSecretKeyHex: secrets.nostrSecretKeyHex,
      })
      const thumbnailBytes = command.params.thumbnailPath
        ? await readMarketThumbnail(command.params.thumbnailPath)
        : undefined
      const response = await createMarketViaEngine(
        client,
        command.params.conditionId,
        {
          baseAsset: 'sat',
          title: command.params.title,
          description: command.params.description,
          outcomes: createMarketOutcomes(command.params.outcomes),
          ...(command.params.tags !== undefined ? { categoryTags: command.params.tags } : {}),
        },
        thumbnailBytes,
      )
      return { ok: true, result: response }
    }
    case 'market.resolution-status': {
      const profile = await readProfile()
      if (!profile) return { ok: false, error: 'daemon profile is not initialized' }
      const saved = await createNativeOracleCreationStore(profileDir()).readByConditionId(
        command.params.conditionId,
      )
      if (!saved)
        return { ok: false, error: 'This profile did not create the oracle announcement.' }
      return {
        ok: true,
        result: {
          conditionId: command.params.conditionId,
          chosenOutcome: saved.chosenOutcome,
          attestationPrepared: saved.attestation !== null,
          relayPublished: saved.relayPublished,
          engineSynchronized: saved.engineEvidence !== null,
          explanationPrepared: saved.explanationEventJson !== null,
          explanationDraftSaved: saved.explanationDraft !== null,
          explanationRelayPublished: saved.explanationRelayPublished,
          attestationEventId:
            saved.attestation === null
              ? null
              : JSON.parse(saved.attestation.attestationNostrEventJson).id,
          explanationEventId:
            saved.explanationEventJson === null ? null : JSON.parse(saved.explanationEventJson).id,
        },
      }
    }
    case 'market.attest':
    case 'market.attestation-retry': {
      const profile = await readProfile()
      if (!profile) return { ok: false, error: 'daemon profile is not initialized' }
      const store = createNativeOracleCreationStore(profileDir())
      const creation = await store.readByConditionId(command.params.conditionId)
      if (!creation)
        return { ok: false, error: 'This profile did not create the oracle announcement.' }
      const { destination } = JSON.parse(creation.canonicalInput) as {
        destination: { engineBaseUrl: string; relayUrls: string[] }
      }
      if (destination.engineBaseUrl !== profile.engineBaseUrl) {
        return { ok: false, error: 'Use the engine configured when this market was created.' }
      }
      const validation = validateMarketCreateEngineUrl(profile.engineBaseUrl, true)
      if (!validation.ok) return { ok: false, error: validation.error, code: validation.code }
      const client = new BitcasterEngineClient({
        baseUrl: profile.engineBaseUrl,
        fetchImpl: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }),
      })
      const ports: NativeOraclePublicationPorts = {
        store,
        helper: createNativeOracleHelperAdapter(),
        async readSigner() {
          const secrets = await readSecrets()
          if (!secrets) throw new Error('Native oracle signer is unavailable.')
          return {
            secretKeyHex: (await store.readCreationSigner(creation.creationId)).secretKeyHex,
            nonceSeedHex: secrets.nativeOracleNonceSeedHex,
          }
        },
        async publishRelay(eventJson) {
          const saved = await store.readByConditionId(command.params.conditionId)
          if (saved?.announcement == null || saved.attestation === null)
            throw new Error('Native oracle signed publication is unavailable.')
          return publishNativeOracleEvent(destination.relayUrls, eventJson, undefined, {
            oraclePubkey: saved.creatorPublicKeyHex,
            announcementEventJson: saved.announcement.announcementNostrEventJson,
            attestationEventJson: saved.attestation.attestationNostrEventJson,
          })
        },
        async submitEvent(conditionId, eventJson) {
          const { created_at, ...event } = JSON.parse(eventJson)
          const wireEvent = { ...event, createdAt: created_at }
          if (!isKind89NostrEvent(wireEvent))
            throw new Error('Native oracle attestation is invalid.')
          return submitOracleAttestationViaEngine(client, conditionId, wireEvent)
        },
        // The additive public response supplies the exact signed event. The adapter fails closed without it.
        readResolution: (conditionId) => client.getConditionAttestation(conditionId),
      }
      const result =
        command.method === 'market.attestation-retry'
          ? await retryNativeMarketPublication(ports, command.params.conditionId)
          : await publishNativeMarketOutcome(
              ports,
              command.params.conditionId,
              command.params.outcome,
              command.params.explanation,
            )
      return { ok: true, result: nativeOraclePublicationRpcResult(result) }
    }
    case 'market.close': {
      const profile = await readProfile()
      if (!profile) {
        return { ok: false, error: 'daemon profile is not initialized' }
      }
      const engineUrlValidation = validateMarketCreateEngineUrl(profile.engineBaseUrl, true)
      if (!engineUrlValidation.ok) {
        return {
          ok: false,
          error: engineUrlValidation.error,
          code: engineUrlValidation.code,
        }
      }
      if (!isKind89NostrEvent(command.params.attestationEvent)) {
        return { ok: false, error: 'attestationEvent must be a kind-89 Nostr event' }
      }
      const client = new BitcasterEngineClient({ baseUrl: profile.engineBaseUrl })
      const response = await submitOracleAttestationViaEngine(
        client,
        command.params.conditionId,
        command.params.attestationEvent,
      )
      return { ok: true, result: response }
    }
    case 'wallet.balance':
      if (!(await readProfile())) {
        return { ok: false, error: 'daemon profile is not initialized' }
      }
      await ensureState()
      return {
        ok: true,
        result: await readDaemonWalletBalance(profileDir()),
      }
    case 'wallet.positions': {
      if (!(await readProfile())) {
        return { ok: false, error: 'daemon profile is not initialized' }
      }
      await ensureState()
      const balance = await readDaemonWalletBalance(profileDir())
      return { ok: true, result: { positions: balance.outcomePositions } }
    }
    case 'wallet.portfolio':
      return dispatchWalletPortfolio(command.params, deps)
    case 'wallet.assets':
      return dispatchWalletAssets(command.params, deps)
    case 'wallet.pay.quote':
    case 'wallet.pay.execute':
    case 'wallet.pay.status':
      return dispatchNativeWalletPayment(command, deps)
    case 'wallet.invoice.create':
    case 'wallet.invoice.show':
    case 'wallet.invoice.hide':
    case 'wallet.invoice.replace':
      return dispatchNativeLightningInvoice(command, deps)
    case 'wallet.receive': {
      const profile = await readProfile()
      if (!profile) {
        return { ok: false, error: 'daemon profile is not initialized' }
      }
      const secrets = await readSecrets()
      if (!secrets) {
        return { ok: false, error: 'daemon secrets are not initialized' }
      }
      const received = await receiveWalletToken(
        command.params.token,
        profile,
        secrets,
        deps,
        command.params,
      )
      if (received.asset.kind === 'Outcome') {
        await deps.onOutcomeProofsReceived?.(
          received.asset.conditionId,
          received.asset.outcomeSetId,
        )
      }
      return { ok: true, result: received }
    }
    case 'wallet.send': {
      const profile = await readProfile()
      if (!profile) {
        return { ok: false, error: 'daemon profile is not initialized' }
      }
      const secrets = await readSecrets()
      if (!secrets) {
        return { ok: false, error: 'daemon secrets are not initialized' }
      }
      try {
        return {
          ok: true,
          result: await sendWalletToken(
            command.params.amountMsat,
            profile,
            secrets,
            deps,
            command.params.mintUrl,
            command.params.operationId,
          ),
        }
      } finally {
        deps.triggerCustodyRecovery?.()
      }
    }
    case 'wallet.reclaim': {
      const profile = await readProfile()
      if (!profile) return { ok: false, error: 'daemon profile is not initialized' }
      const secrets = await readSecrets()
      if (!secrets) return { ok: false, error: 'daemon secrets are not initialized' }
      try {
        return {
          ok: true,
          result: await reclaimDurableOutgoingCashuTransfer(
            command.params.transferId,
            secrets,
            deps,
          ),
        }
      } finally {
        deps.triggerCustodyRecovery?.()
      }
    }
    case 'wallet.splitCompleteSet': {
      const profile = await readProfile()
      if (!profile) {
        return { ok: false, error: 'daemon profile is not initialized' }
      }
      const secrets = await readSecrets()
      if (!secrets) {
        return { ok: false, error: 'daemon secrets are not initialized' }
      }
      return {
        ok: true,
        result: await splitWalletCompleteSet({
          mintUrl: command.params.mintUrl ?? profile.mintUrl,
          conditionId: command.params.conditionId,
          amountMsat: command.params.amountMsat,
          operationId:
            command.params.operationId ??
            `wallet-split-complete-set:${command.params.conditionId}:${Date.now()}`,
          secrets,
          deps,
        }),
      }
    }
    case 'wallet.consolidateMarket': {
      const profile = await readProfile()
      if (!profile) {
        return { ok: false, error: 'daemon profile is not initialized' }
      }
      const secrets = await readSecrets()
      if (!secrets) {
        return { ok: false, error: 'daemon secrets are not initialized' }
      }
      const client = await createEngineClient(deps, {
        baseUrl: profile.engineBaseUrl,
        nostrSecretKeyHex: secrets.nostrSecretKeyHex,
      })
      return consolidateMarket({
        client,
        marketId: command.params.marketId,
        type: command.params.type,
        mintUrl: profile.mintUrl,
        secrets,
        deps,
      })
    }
    case 'wallet.consolidateProofs': {
      const profile = await readProfile()
      if (!profile) {
        return { ok: false, error: 'daemon profile is not initialized' }
      }
      const secrets = await readSecrets()
      if (!secrets) {
        return { ok: false, error: 'daemon secrets are not initialized' }
      }
      if (!deps.getCustodyFence) {
        return { ok: false, error: 'wallet proof consolidation requires custody authority' }
      }
      const getCustodyFence = deps.getCustodyFence
      return {
        ok: true,
        result: await consolidateWalletProofs({
          secrets,
          mutation: () => ({ fence: getCustodyFence(), observedAtMs: Date.now() }),
          dependencies: deps,
        }),
      }
    }
    case 'wallet.removePreview':
    case 'wallet.removePosition': {
      const profile = await readProfile()
      if (!profile || !deps.getCustodyFence)
        return { ok: false, error: 'position removal requires initialized custody authority' }
      try {
        const context = {
          profile,
          fence: deps.getCustodyFence(),
          isCustodyReady: () => deps.isCustodyReady?.() !== false,
        }
        return {
          ok: true,
          result:
            command.method === 'wallet.removePreview'
              ? await previewDaemonPositionRemove({
                  ...context,
                  conditionId: command.params.conditionId,
                  outcomeCollection: command.params.outcomeCollection,
                })
              : await removeDaemonPosition({
                  ...context,
                  preview: command.params.preview,
                  acknowledge: command.params.acknowledge,
                }),
        }
      } catch {
        return {
          ok: false,
          code: 'position-remove-refused',
          error: 'position removal could not use the acknowledged exact losing batch',
        }
      }
    }
    case 'wallet.claimPosition': {
      const profile = await readProfile()
      if (!profile) return { ok: false, error: 'daemon profile is not initialized' }
      const secrets = await readSecrets()
      if (!secrets) return { ok: false, error: 'daemon secrets are not initialized' }
      if (!deps.getCustodyFence)
        return { ok: false, error: 'position claim requires custody authority' }
      const client = await createEngineClient(deps, {
        baseUrl: profile.engineBaseUrl,
        nostrSecretKeyHex: secrets.nostrSecretKeyHex,
      })
      if (!client.getConditionAttestation)
        return { ok: false, error: 'engine client does not support condition attestation' }
      try {
        const result = await claimDaemonPosition({
          ...command.params,
          profile,
          secrets,
          fence: deps.getCustodyFence(),
          walletDependencies: deps,
          engine: { getConditionAttestation: (id) => client.getConditionAttestation!(id) },
        })
        if (result.legs.some((leg) => leg.state === 'pending')) deps.triggerCustodyRecovery?.()
        return { ok: true, result }
      } catch {
        return {
          ok: false,
          code: 'position-claim-refused',
          error: 'position claim could not use the exact custody target',
        }
      }
    }
    case 'wallet.retireCondition': {
      const profile = await readProfile()
      if (!profile) return { ok: false, error: 'daemon profile is not initialized' }
      const secrets = await readSecrets()
      if (!secrets) return { ok: false, error: 'daemon secrets are not initialized' }
      if (!deps.getCustodyFence) {
        return { ok: false, error: 'condition retirement requires custody authority' }
      }
      const client = await createEngineClient(deps, {
        baseUrl: profile.engineBaseUrl,
        nostrSecretKeyHex: secrets.nostrSecretKeyHex,
      })
      if (!client.getConditionAttestation) {
        return { ok: false, error: 'engine client does not support condition attestation' }
      }
      return {
        ok: true,
        result: await retireDaemonConditionInventory({
          conditionId: command.params.conditionId,
          acknowledge: command.params.acknowledge,
          intentKind: 'explicit-user-command',
          profile,
          secrets,
          fence: deps.getCustodyFence(),
          engine: { getConditionAttestation: (id) => client.getConditionAttestation!(id) },
          walletDependencies: deps,
        }),
      }
    }
    case 'wallet.recover': {
      const profile = await readProfile()
      if (!profile) {
        return { ok: false, error: 'daemon profile is not initialized' }
      }
      const secrets = await readSecrets()
      if (!secrets) {
        return { ok: false, error: 'daemon secrets are not initialized' }
      }
      const wallet = await recoverPreparedWalletSends(secrets, deps)
      if (!deps.getCustodyFence) return { ok: true, result: wallet }
      const getCustodyFence = deps.getCustodyFence
      const receives = await recoverDurableWalletReceives(secrets, deps)
      const imports = await recoverDurableWalletProofImports(secrets, deps)
      const client = await createEngineClient(deps, {
        baseUrl: profile.engineBaseUrl,
        nostrSecretKeyHex: secrets.nostrSecretKeyHex,
      })
      const signerEnabled = (await readSelectedDaemonSigner()).enabled
      const accountRecoveryPending = !signerEnabled && (await hasUnfinishedDaemonAccountWork())
      const outgoing = await recoverDurableOutgoingCashuTransfers(
        secrets,
        deps,
        signerEnabled
          ? {
              client: {
                getDurableRecipientDeliveryStatus: async (deliveryId) => {
                  if (!client.getDurableRecipientDeliveryStatus) {
                    throw new Error(
                      'daemon engine client does not support durable Cashu deliveries',
                    )
                  }
                  return client.getDurableRecipientDeliveryStatus(deliveryId)
                },
                submitDurableRecipientDelivery: async (submission) => {
                  if (!client.submitDurableRecipientDelivery) {
                    throw new Error(
                      'daemon engine client does not support durable Cashu deliveries',
                    )
                  }
                  return client.submitDurableRecipientDelivery(submission)
                },
              },
              accountSubject: secrets.nostrPublicKeyHex,
            }
          : undefined,
      )
      const outgoingStatus = outgoingCashuRecoveryStatus(outgoing)
      const consolidation = await recoverWalletProofConsolidations({
        secrets,
        mutation: () => ({ fence: getCustodyFence(), observedAtMs: Date.now() }),
        dependencies: deps,
      })
      const completeSets = await recoverCompleteSetSplits({ secrets, deps })
      const positionClaims = await recoverDaemonPositionClaims({
        profile,
        secrets,
        fence: getCustodyFence(),
        walletDependencies: deps,
      })
      const invoiceRecovery = await deps.nativeLightningOps?.recoverPage()
      const paymentRecovery = await deps.nativeWalletPaymentOps?.recoverPage()
      const retirements = await resumeDaemonConditionRetirements({
        profile,
        secrets,
        fence: getCustodyFence(),
        walletDependencies: deps,
      })
      const retired = retirements
        .filter((entry) => entry.error === null)
        .map((entry) => entry.conditionId)
      const result = composeStartupCustodyRecovery([
        wallet,
        receives,
        imports,
        outgoing,
        consolidation,
        completeSets,
        positionClaims,
        ...(invoiceRecovery === undefined ? [] : [invoiceRecovery.recovery]),
        ...(paymentRecovery === undefined ? [] : [paymentRecovery.recovery]),
        { recovered: retired, pending: retirementPending(retirements) },
        ...(accountRecoveryPending
          ? [
              {
                recovered: [],
                pending: [
                  {
                    operationId: 'application-account-recovery',
                    error: 'Application signer is disconnected.',
                  },
                ],
              },
            ]
          : []),
      ])
      deps.onManualCustodyRecoveryStatus?.({
        nonRetirementPending:
          accountRecoveryPending ||
          wallet.pending.length > 0 ||
          receives.pending.length > 0 ||
          receives.pendingCount > 0 ||
          receives.hasMore ||
          imports.pendingCount > 0 ||
          imports.hasMore ||
          outgoingStatus.blockingPending ||
          consolidation.pending.length > 0 ||
          completeSets.pending.length > 0 ||
          positionClaims.pending.length > 0 ||
          (invoiceRecovery?.blockingPending ?? false) ||
          (paymentRecovery?.blockingPending ?? false),
        retryPending:
          accountRecoveryPending ||
          wallet.pending.length > 0 ||
          receives.pending.length > 0 ||
          receives.pendingCount > 0 ||
          receives.hasMore ||
          imports.pendingCount > 0 ||
          imports.hasMore ||
          outgoingStatus.retryPending ||
          consolidation.pending.length > 0 ||
          completeSets.pending.length > 0 ||
          positionClaims.pending.length > 0 ||
          (invoiceRecovery?.retryPending ?? false) ||
          (paymentRecovery?.retryPending ?? false),
        retirementPending: retirements.some((entry) => entry.error !== null),
      })
      if (imports.hasMore || invoiceRecovery?.hasMore || paymentRecovery?.hasMore) {
        deps.triggerCustodyRecovery?.()
      }
      if (
        !deps.onManualCustodyRecoveryStatus &&
        result.pending.length === 0 &&
        receives.pendingCount === 0 &&
        !receives.hasMore &&
        imports.pendingCount === 0 &&
        !imports.hasMore &&
        !outgoingStatus.blockingPending &&
        !(invoiceRecovery?.blockingPending ?? false) &&
        !(paymentRecovery?.blockingPending ?? false)
      ) {
        deps.markCustodyReady?.()
      }
      await deps.nativePaymentRequests?.resumeReceiving().catch(() => false)
      return {
        ok: true,
        result,
      }
    }
    case 'wallet.operations': {
      if (!(await readProfile())) {
        return { ok: false, error: 'daemon profile is not initialized' }
      }
      return {
        ok: true,
        result: await listProofOperations(command.params ?? {}),
      }
    }
    case 'wallet.activity':
      return dispatchWalletActivity(command.params)
    case 'markets.query': {
      const profile = await readProfile()
      if (!profile) {
        return { ok: false, error: 'daemon profile is not initialized' }
      }
      const secrets = await readSecrets()
      if (!secrets) {
        return { ok: false, error: 'daemon secrets are not initialized' }
      }
      const client = await createEngineClient(deps, {
        baseUrl: profile.engineBaseUrl,
        nostrSecretKeyHex: secrets.nostrSecretKeyHex,
      })
      return {
        ok: true,
        result: await client.queryMarkets(command.params),
      }
    }
    case 'markets.show': {
      const profile = await readProfile()
      if (!profile) {
        return { ok: false, error: 'daemon profile is not initialized' }
      }
      const secrets = await readSecrets()
      if (!secrets) {
        return { ok: false, error: 'daemon secrets are not initialized' }
      }
      const client = await createEngineClient(deps, {
        baseUrl: profile.engineBaseUrl,
        nostrSecretKeyHex: secrets.nostrSecretKeyHex,
      })
      const market =
        client.getMarket !== undefined
          ? await client.getMarket(command.params.conditionId)
          : ((
              await client.queryMarkets({
                ids: [command.params.conditionId],
                state: 'All',
                limit: 1,
              })
            ).markets[0] ?? null)
      return {
        ok: true,
        result: market,
      }
    }
    case 'market.funding.quote':
    case 'market.funding.head':
    case 'market.fund':
      return dispatchMarketFunding(command, deps)
    case 'score.show':
    case 'score.quote':
    case 'score.buy':
    case 'score.status':
      return dispatchParticipationScore(command, deps)
    case 'order.fee-preview':
      return dispatchOrderFeePreview(command.params, deps)
    case 'order.submit':
      return dispatchProtectedOrderSubmit(command.params, deps)
    case 'order.status': {
      const profile = await readProfile()
      if (!profile) {
        return { ok: false, error: 'daemon profile is not initialized' }
      }
      const secrets = await readSecrets()
      if (!secrets) {
        return { ok: false, error: 'daemon secrets are not initialized' }
      }
      const client = await createEngineClient(deps, {
        baseUrl: profile.engineBaseUrl,
        nostrSecretKeyHex: secrets.nostrSecretKeyHex,
      })
      const status = await client.getOrderStatus(command.params.marketId, command.params.orderId)
      const marketUnit = status
        ? await loadMarketUnit(client, conditionIdFromMarketId(command.params.marketId))
        : null
      const local = status
        ? await recordOrderStatus(
            command.params.marketId,
            command.params.orderId,
            status,
            marketUnit?.baseAsset,
            marketUnit?.divisibility,
          )
        : null
      if (local && deps.isCustodyReady?.() !== false) {
        await trackOwnedOrderBestEffort(deps.trackOwnedOrder, local.marketId, local.orderId)
      }
      return {
        ok: true,
        result: { engine: status, local },
      }
    }
    case 'order.list': {
      const profile = await readProfile()
      if (!profile) {
        return { ok: false, error: 'daemon profile is not initialized' }
      }
      return {
        ok: true,
        result: await listLocalOrders(command.params ?? {}),
      }
    }
    case 'order.cancel': {
      const profile = await readProfile()
      if (!profile) {
        return { ok: false, error: 'daemon profile is not initialized' }
      }
      const secrets = await readSecrets()
      if (!secrets) {
        return { ok: false, error: 'daemon secrets are not initialized' }
      }
      const client = await createEngineClient(deps, {
        baseUrl: profile.engineBaseUrl,
        nostrSecretKeyHex: secrets.nostrSecretKeyHex,
      })
      const cancelled = await client.cancelOrder(command.params.marketId, command.params.orderId)
      const marketUnit = cancelled
        ? await loadMarketUnit(client, conditionIdFromMarketId(command.params.marketId))
        : null
      const local = cancelled
        ? await recordOrderStatus(
            command.params.marketId,
            command.params.orderId,
            {
              orderId: command.params.orderId,
              marketId: command.params.marketId,
              status: 'cancelled',
            },
            marketUnit?.baseAsset,
            marketUnit?.divisibility,
          )
        : null
      return {
        ok: true,
        result: { cancelled, local },
      }
    }
    case 'order.book': {
      const profile = await readProfile()
      if (!profile) {
        return { ok: false, error: 'daemon profile is not initialized' }
      }
      const secrets = await readSecrets()
      if (!secrets) {
        return { ok: false, error: 'daemon secrets are not initialized' }
      }
      const client = await createEngineClient(deps, {
        baseUrl: profile.engineBaseUrl,
        nostrSecretKeyHex: secrets.nostrSecretKeyHex,
      })
      return {
        ok: true,
        result: await client.getOrderBook(command.params.marketId),
      }
    }
  }
}

async function dispatchWalletPortfolio(
  rawQuery: unknown,
  deps: DispatchDependencies,
): Promise<DaemonResponse> {
  const query = decodeDaemonPortfolioOptions(rawQuery)
  if (query === null) {
    return {
      ok: false,
      code: 'invalid-portfolio-query',
      error: 'wallet portfolio accepts only a bounded timeframe and page size',
    }
  }
  const context = await readWalletMonitoringContext(deps)
  if (context === null) return { ok: false, error: 'daemon profile is not initialized' }
  const { profile, localHoldings } = context
  if (!context.monitoringEnabled) {
    return {
      ok: true,
      result: { localHoldings, monitoring: { status: 'disabled' } },
    }
  }

  try {
    const { client, walletId } = await createWalletMonitoringClient(profile, deps)
    if (client.getPortfolio === undefined) throw new Error('portfolio query is unavailable')
    const portfolioQuery: AssetMonitoringPortfolioQuery = {
      walletId,
      ...(query.timeframe === undefined ? {} : { timeframe: query.timeframe }),
      ...(query.pageSize === undefined ? {} : { pageSize: query.pageSize }),
    }
    const portfolio = await client.getPortfolio(portfolioQuery)
    return {
      ok: true,
      result: { localHoldings, monitoring: { status: 'available', portfolio } },
    }
  } catch {
    return {
      ok: true,
      result: { localHoldings, monitoring: { status: 'unavailable' } },
    }
  }
}

async function dispatchWalletAssets(
  rawQuery: unknown,
  deps: DispatchDependencies,
): Promise<DaemonResponse> {
  const query = decodeDaemonAssetsOptions(rawQuery)
  if (query === null) {
    return {
      ok: false,
      code: 'invalid-asset-query',
      error: 'wallet assets accepts only a bounded cursor and page size',
    }
  }
  const context = await readWalletMonitoringContext(deps)
  if (context === null) return { ok: false, error: 'daemon profile is not initialized' }
  const { profile, localHoldings } = context
  if (!context.monitoringEnabled) {
    return {
      ok: true,
      result: { localHoldings, monitoring: { status: 'disabled' } },
    }
  }

  try {
    const { client, walletId } = await createWalletMonitoringClient(profile, deps)
    if (client.getAssetMonitoringAssets === undefined) {
      throw new Error('asset page query is unavailable')
    }
    const assetsQuery: AssetMonitoringAssetsQuery = {
      walletId,
      ...(query.pageSize === undefined ? {} : { pageSize: query.pageSize }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    }
    const assets = await client.getAssetMonitoringAssets(assetsQuery)
    return {
      ok: true,
      result: { localHoldings, monitoring: { status: 'available', assets } },
    }
  } catch {
    return {
      ok: true,
      result: { localHoldings, monitoring: { status: 'unavailable' } },
    }
  }
}

async function readWalletMonitoringContext(deps: DispatchDependencies): Promise<{
  profile: NonNullable<Awaited<ReturnType<typeof readProfile>>>
  localHoldings: Awaited<ReturnType<typeof readDaemonWalletBalance>>
  monitoringEnabled: boolean
} | null> {
  const profile = await readProfile()
  if (!profile) return null
  await ensureState()
  const localHoldings = await readDaemonWalletBalance(profileDir())
  const monitoringEnabled =
    (await readSelectedDaemonSigner()).enabled &&
    (deps.isAssetMonitoringEnabled?.() ?? activeNativeConfig().config.daemon.assetMonitoringEnabled)
  return { profile, localHoldings, monitoringEnabled }
}

async function createWalletMonitoringClient(
  profile: NonNullable<Awaited<ReturnType<typeof readProfile>>>,
  deps: DispatchDependencies,
): Promise<{ client: EngineClientLike; walletId: string }> {
  const secrets = await readSecrets()
  if (!secrets) throw new Error('daemon secrets are not initialized')
  const client = await createEngineClient(deps, {
    baseUrl: profile.engineBaseUrl,
    nostrSecretKeyHex: secrets.nostrSecretKeyHex,
  })
  return {
    client,
    walletId: deriveDurableCustodyWalletId(Buffer.from(secrets.walletSeedHex, 'hex')),
  }
}

function decodeDaemonPortfolioOptions(
  value: unknown,
): Omit<AssetMonitoringPortfolioQuery, 'walletId'> | null {
  const options = value ?? {}
  if (typeof options !== 'object' || options === null || Array.isArray(options)) return null
  const record = options as Record<string, unknown>
  if (Object.keys(record).some((key) => key !== 'timeframe' && key !== 'pageSize')) return null
  try {
    const decoded = decodeAssetMonitoringPortfolioQuery({
      walletId: '00'.repeat(32),
      ...(record.timeframe === undefined ? {} : { timeframe: record.timeframe }),
      ...(record.pageSize === undefined ? {} : { pageSize: record.pageSize }),
    })
    return {
      ...(decoded.timeframe === undefined ? {} : { timeframe: decoded.timeframe }),
      ...(decoded.pageSize === undefined ? {} : { pageSize: decoded.pageSize }),
    }
  } catch {
    return null
  }
}

function decodeDaemonAssetsOptions(
  value: unknown,
): Omit<AssetMonitoringAssetsQuery, 'walletId'> | null {
  const options = value ?? {}
  if (typeof options !== 'object' || options === null || Array.isArray(options)) return null
  const record = options as Record<string, unknown>
  if (Object.keys(record).some((key) => key !== 'cursor' && key !== 'pageSize')) return null
  try {
    const decoded = decodeAssetMonitoringAssetsQuery({
      walletId: '00'.repeat(32),
      ...(record.pageSize === undefined ? {} : { pageSize: record.pageSize }),
      ...(record.cursor === undefined ? {} : { cursor: record.cursor }),
    })
    return {
      ...(decoded.pageSize === undefined ? {} : { pageSize: decoded.pageSize }),
      ...(decoded.cursor === undefined ? {} : { cursor: decoded.cursor }),
    }
  } catch {
    return null
  }
}

type ResolvedProtectedOrder = {
  request: ProtectedOrderConsentRequest
  conditionId: string
  marketUnit: { baseAsset: MarketBaseAsset; divisibility: number }
  profile: NonNullable<Awaited<ReturnType<typeof readProfile>>>
  secrets: NonNullable<Awaited<ReturnType<typeof readSecrets>>>
  client: EngineClientLike
}

async function resolveProtectedOrderDraft(
  params: OrderDraftParams,
  deps: DispatchDependencies,
  acceptedRequest?: ProtectedOrderConsentRequest,
): Promise<
  { ok: true; value: ResolvedProtectedOrder } | { ok: false; error: string; code?: string }
> {
  const draft = { tokenSide: 'Outcome' as const, ...params }
  const shape = validateOrderRoutingIdentity(draft)
  if (!shape.valid) return { ok: false, error: shape.message }
  if (draft.price !== undefined && (!Number.isSafeInteger(draft.price) || draft.price <= 0)) {
    return { ok: false, error: 'Order rejected: price must be a positive integer.' }
  }
  if (draft.consolidateProofs !== undefined && typeof draft.consolidateProofs !== 'boolean') {
    return { ok: false, error: 'Order rejected: proof consolidation policy must be boolean' }
  }
  if (draft.expiresAt !== undefined && draft.expiresAt !== null) {
    return { ok: false, error: 'Order rejected: public FOK orders cannot expire' }
  }
  const support = checkOrderSettlementSupport({ request: { side: draft.side } })
  if (!support.supported) return { ok: false, error: support.message }
  const profile = await readProfile()
  if (!profile) return { ok: false, error: 'daemon profile is not initialized' }
  const secrets = await readSecrets()
  if (!secrets) return { ok: false, error: 'daemon secrets are not initialized' }
  const client = await createEngineClient(deps, {
    baseUrl: profile.engineBaseUrl,
    nostrSecretKeyHex: secrets.nostrSecretKeyHex,
  })
  const conditionId = conditionIdFromMarketId(draft.marketId)
  const marketUnit = await loadMarketUnit(client, conditionId)
  const minimumFillAmountSubunits =
    draft.minimumFillAmountSubunits === undefined
      ? marketUnit.divisibility
      : draft.minimumFillAmountSubunits
  if (
    !Number.isSafeInteger(minimumFillAmountSubunits) ||
    minimumFillAmountSubunits <= 0 ||
    minimumFillAmountSubunits > draft.amountSubunits ||
    minimumFillAmountSubunits % marketUnit.divisibility !== 0
  ) {
    return {
      ok: false,
      error: `Order rejected: minimum fill must be a positive multiple of ${marketUnit.divisibility} and no larger than the order amount`,
    }
  }
  if (acceptedRequest !== undefined) {
    const expected = {
      marketId: draft.marketId,
      outcomeId: draft.outcomeId,
      tokenSide: draft.tokenSide,
      side: draft.side,
      price: draft.price ?? acceptedRequest.price,
      maxQuotePaymentSubunits:
        draft.maxQuotePaymentSubunits === undefined
          ? acceptedRequest.maxQuotePaymentSubunits
          : draft.maxQuotePaymentSubunits,
      minQuotePaymentSubunits:
        draft.minQuotePaymentSubunits === undefined
          ? acceptedRequest.minQuotePaymentSubunits
          : draft.minQuotePaymentSubunits,
      amountSubunits: draft.amountSubunits,
      minimumFillAmountSubunits,
      consolidateProofs: draft.consolidateProofs === true,
      timeInForce: draft.timeInForce,
    }
    const intent = validateOrderIntent({
      ...expected,
      baseAsset: marketUnit.baseAsset,
      divisibility: marketUnit.divisibility,
    })
    if (!intent.valid) return { ok: false, error: intent.message }
    if (!isDeepStrictEqual(acceptedRequest, expected)) {
      return {
        ok: false,
        code: 'fee-consent-mismatch',
        error: 'Order fee consent does not match the current order',
      }
    }
    return {
      ok: true,
      value: {
        request: structuredClone(acceptedRequest),
        conditionId,
        marketUnit,
        profile,
        secrets,
        client,
      },
    }
  }
  let limitPrice = draft.price
  if (limitPrice === undefined) {
    if (!client.previewFokOrderCapacity) {
      return { ok: false, error: 'daemon order capacity preview is unavailable' }
    }
    const capacity = await client.previewFokOrderCapacity({
      marketId: draft.marketId,
      side: draft.side,
      tokenSide: draft.tokenSide,
    })
    if (capacity.status !== 'ready' || !Number.isSafeInteger(capacity.effectiveLimitPrice)) {
      return { ok: false, error: 'Order rejected: Auto price is unavailable' }
    }
    limitPrice = capacity.effectiveLimitPrice!
  }
  const intent = validateOrderIntent({
    ...draft,
    price: limitPrice,
    baseAsset: marketUnit.baseAsset,
    divisibility: marketUnit.divisibility,
  })
  if (!intent.valid) return { ok: false, error: intent.message }
  if (!client.previewFokOrder) return { ok: false, error: 'daemon order preview is unavailable' }
  const previewRequest: PreviewFokOrderRequest = {
    marketId: draft.marketId,
    side: draft.side,
    tokenSide: draft.tokenSide,
    price: limitPrice,
    faceAmountSubunits: draft.amountSubunits,
  }
  const previewResponse = await client.previewFokOrder(previewRequest)
  let protectedRequest: ReturnType<typeof buildProtectedTradeTicket>['request']
  try {
    protectedRequest = buildProtectedTradeTicket({
      ticket: {
        marketId: draft.marketId,
        request: {
          outcomeId: draft.outcomeId,
          tokenSide: draft.tokenSide,
          side: draft.side,
          price: limitPrice,
          amountSubunits: draft.amountSubunits,
          timeInForce: 'FOK',
        },
      },
      previewRequest,
      previewResponse,
      priceOverride: draft.price ?? null,
    }).request
    if (
      draft.maxQuotePaymentSubunits !== undefined ||
      draft.minQuotePaymentSubunits !== undefined
    ) {
      const bounds = decodeOrderQuotePaymentBounds(draft.side, draft)
      if (
        bounds.maxQuotePaymentSubunits !== protectedRequest.maxQuotePaymentSubunits ||
        bounds.minQuotePaymentSubunits !== protectedRequest.minQuotePaymentSubunits
      ) {
        throw new Error('accepted quote payment conflicts with preview')
      }
    }
  } catch {
    return {
      ok: false,
      code: 'order-not-executable',
      error: 'Order rejected: protected FOK preview is not executable',
    }
  }
  return {
    ok: true,
    value: {
      request: {
        marketId: draft.marketId,
        outcomeId: draft.outcomeId,
        tokenSide: draft.tokenSide,
        side: draft.side,
        price: protectedRequest.price,
        ...decodeOrderQuotePaymentBounds(draft.side, protectedRequest),
        amountSubunits: draft.amountSubunits,
        minimumFillAmountSubunits,
        consolidateProofs: draft.consolidateProofs === true,
        timeInForce: 'FOK',
      },
      conditionId,
      marketUnit,
      profile,
      secrets,
      client,
    },
  }
}

function preparationInput(
  resolved: ResolvedProtectedOrder,
  clientOrderId: string,
): PrepareSettlementCapabilityInput {
  const { request, conditionId, marketUnit, profile, secrets } = resolved
  return {
    clientOrderId,
    marketId: request.marketId,
    conditionId,
    outcomeId: request.outcomeId,
    tokenSide: request.tokenSide,
    side: request.side,
    price: request.price,
    maxQuotePaymentSubunits: request.maxQuotePaymentSubunits,
    minQuotePaymentSubunits: request.minQuotePaymentSubunits,
    amountSubunits: request.amountSubunits,
    minimumFillAmountSubunits: request.minimumFillAmountSubunits,
    consolidateProofs: request.consolidateProofs,
    baseAsset: marketUnit.baseAsset,
    collateralUnit: 'msat',
    divisibility: marketUnit.divisibility,
    timeInForce: 'FOK',
    expiresAt: null,
    mintUrl: profile.mintUrl,
    walletSeedHex: secrets.walletSeedHex,
  }
}

async function dispatchOrderFeePreview(
  params: OrderDraftParams,
  deps: DispatchDependencies,
): Promise<DaemonResponse> {
  let resolved: Awaited<ReturnType<typeof resolveProtectedOrderDraft>>
  try {
    resolved = await resolveProtectedOrderDraft(params, deps)
  } catch {
    return { ok: false, code: 'order-preview-unavailable', error: 'Order preview is unavailable' }
  }
  if (!resolved.ok) return resolved
  if (!deps.previewSettlementCapabilityFees) {
    return { ok: false, error: 'daemon fee preview is unavailable' }
  }
  let feeFacts: CtfRangeOrderFeeFacts
  try {
    feeFacts = decodeCtfRangeOrderFeeFacts(
      await deps.previewSettlementCapabilityFees(
        preparationInput(resolved.value, randomUUID()),
        resolved.value.client,
      ),
    )
  } catch {
    return { ok: false, code: 'fee-preview-unavailable', error: 'Order fee preview is unavailable' }
  }
  return { ok: true, result: { request: resolved.value.request, feeFacts } }
}

function decodeOrderFeeConsent(value: unknown): OrderFeeConsent | null {
  if (!isRpcRecord(value) || Object.keys(value).length !== 2 || !('request' in value)) {
    return null
  }
  try {
    const feeFacts = decodeCtfRangeOrderFeeFacts(value.feeFacts)
    if (!isDeepStrictEqual(value.feeFacts, feeFacts)) return null
    const request = value.request
    const keys = [
      'marketId',
      'outcomeId',
      'tokenSide',
      'side',
      'price',
      'maxQuotePaymentSubunits',
      'minQuotePaymentSubunits',
      'amountSubunits',
      'minimumFillAmountSubunits',
      'consolidateProofs',
      'timeInForce',
    ]
    if (
      !isRpcRecord(request) ||
      Object.keys(request).length !== keys.length ||
      Object.keys(request).some((key) => !keys.includes(key)) ||
      typeof request.marketId !== 'string' ||
      typeof request.outcomeId !== 'string' ||
      (request.tokenSide !== 'Outcome' && request.tokenSide !== 'Complement') ||
      (request.side !== 'Buy' && request.side !== 'Sell') ||
      typeof request.price !== 'number' ||
      !Number.isSafeInteger(request.price) ||
      request.price <= 0 ||
      typeof request.amountSubunits !== 'number' ||
      !Number.isSafeInteger(request.amountSubunits) ||
      request.amountSubunits <= 0 ||
      typeof request.minimumFillAmountSubunits !== 'number' ||
      !Number.isSafeInteger(request.minimumFillAmountSubunits) ||
      request.minimumFillAmountSubunits <= 0 ||
      typeof request.consolidateProofs !== 'boolean' ||
      request.timeInForce !== 'FOK'
    )
      return null
    const bounds = decodeOrderQuotePaymentBounds(request.side, request)
    if (
      !isDeepStrictEqual(bounds, {
        maxQuotePaymentSubunits: request.maxQuotePaymentSubunits,
        minQuotePaymentSubunits: request.minQuotePaymentSubunits,
      })
    )
      return null
    return {
      request: structuredClone(request) as unknown as ProtectedOrderConsentRequest,
      feeFacts,
    }
  } catch {
    return null
  }
}

async function dispatchProtectedOrderSubmit(
  params: SubmitOrderParams,
  deps: DispatchDependencies,
): Promise<DaemonResponse> {
  const feeConsent = decodeOrderFeeConsent(isRpcRecord(params) ? params.feeConsent : undefined)
  if (!feeConsent) {
    return { ok: false, code: 'fee-consent-required', error: 'Order fee consent is required' }
  }
  let resolved: Awaited<ReturnType<typeof resolveProtectedOrderDraft>>
  try {
    resolved = await resolveProtectedOrderDraft(params, deps, feeConsent.request)
  } catch {
    return { ok: false, code: 'order-preview-unavailable', error: 'Order preview is unavailable' }
  }
  if (!resolved.ok) return resolved
  const { request, profile, secrets, client, marketUnit, conditionId } = resolved.value
  if (!isDeepStrictEqual(feeConsent.request, request)) {
    return {
      ok: false,
      code: 'fee-consent-mismatch',
      error: 'Order fee consent does not match the current order',
    }
  }
  const comment = (params as { comment?: unknown }).comment
  if (comment !== undefined) {
    if (
      !isRpcRecord(comment) ||
      Object.keys(comment).length !== 2 ||
      typeof comment.content !== 'string' ||
      typeof comment.marketUrl !== 'string'
    ) {
      return { ok: false, error: 'Order comment is invalid' }
    }
    try {
      createTradeCommentTemplate({
        conditionId,
        content: comment.content,
        marketUrl: comment.marketUrl,
        createdAt: Math.floor(Date.now() / 1_000),
      })
    } catch {
      return { ok: false, error: 'Order comment is invalid' }
    }
  }
  if (!deps.prepareSettlementCapability) {
    return { ok: false, error: 'daemon settlement capability coordinator is unavailable' }
  }
  const clientOrderId = randomUUID()
  let operationId: string | undefined
  let orderId: string | undefined
  let participationScore: DaemonParticipationScorePreflightResult | undefined
  let prepared: PreparedSettlementCapability
  try {
    prepared = await deps.prepareSettlementCapability(
      preparationInput(resolved.value, clientOrderId),
      client,
      async (requiredScore) => {
        const score = await client.getParticipationScore()
        const plan = planParticipationScoreTopUp(score, requiredScore)
        const availableScoreMsat = await readDaemonAvailableRegularMsatBalance(profileDir(), {
          mintUrl: profile.mintUrl,
        })
        const backingError = participationScoreBackingError({ availableScoreMsat, plan })
        if (backingError) throw new InsufficientParticipationScoreBackingError(backingError)
        participationScore = await ensureDaemonParticipationScoreForNextMatch({
          client,
          profile,
          secrets,
          deps,
          score,
          plan,
          requiredScore,
        })
      },
      feeConsent.feeFacts,
    )
    operationId = prepared.operationId
    orderId = prepared.capability.orderId
    assertPreparedSettlementCapability(prepared, { clientOrderId, marketId: request.marketId })
    if (!participationScore)
      throw new Error('daemon settlement capability coordinator skipped Score admission')
  } catch (error) {
    if (error instanceof InsufficientParticipationScoreBackingError) {
      return { ok: false, error: error.message, clientOrderId, operationId, orderId }
    }
    deps.triggerSettlementRecovery?.()
    return {
      ok: false,
      error: 'Order preparation is uncertain; check order status before retrying',
      clientOrderId,
      operationId,
      orderId,
    }
  }
  let submitted: SubmitOrderResponse
  try {
    const signedComment =
      comment === undefined
        ? null
        : signNativeTradeComment(
            { privateKeyHex: secrets.nostrSecretKeyHex },
            {
              conditionId,
              content: (comment as { content: string }).content,
              marketUrl: (comment as { marketUrl: string }).marketUrl,
              createdAt: Math.floor(Date.now() / 1_000),
            },
          )
    submitted = await measureOrderPhase(
      deps.observeOrderTimeline,
      'order-submit',
      {
        clientOrderId,
        operationId,
        orderId,
      },
      () =>
        client.submitOrder(request.marketId, {
          settlementCapability: prepared.capability.reference,
          comment: signedComment,
        }),
    )
  } catch (error) {
    if (error instanceof EngineClientError && isDefinitiveOrderSubmissionError(error)) {
      try {
        await prepared.markRejected()
      } catch {
        deps.triggerSettlementRecovery?.()
      }
      return {
        ok: false,
        code: error.code,
        error: 'Order submission was rejected',
        clientOrderId,
        operationId,
        orderId,
      }
    }
    deps.triggerSettlementRecovery?.()
    return {
      ok: false,
      error: 'Order submission is uncertain; check order status before retrying',
      clientOrderId,
      operationId,
      orderId,
    }
  }
  if (submitted.orderId !== orderId) {
    deps.triggerSettlementRecovery?.()
    return {
      ok: false,
      error: 'Order submission is uncertain; check order status before retrying',
      clientOrderId,
      operationId,
      orderId,
    }
  }
  try {
    const local = await measureOrderPhase(
      deps.observeOrderTimeline,
      'submitted-record',
      {
        clientOrderId,
        operationId,
        orderId,
      },
      async () => {
        const recorded = await recordSubmittedOrder(
          request.marketId,
          clientOrderId,
          submitted,
          null,
          request.tokenSide,
          request.side,
          request.price,
          request.amountSubunits,
          marketUnit.baseAsset,
          marketUnit.divisibility,
        )
        await prepared.markSubmitted()
        return recorded
      },
    )
    await trackOwnedOrderBestEffort(deps.trackOwnedOrder, local.marketId, local.orderId)
    return {
      ok: true,
      result: {
        engine: submitted,
        local,
        participationScore,
        settlementCapability: prepared.capability,
        operationId,
        consolidation: prepared.consolidation,
      },
    }
  } catch {
    deps.triggerSettlementRecovery?.()
    return {
      ok: false,
      error: 'Order submission is uncertain; check order status before retrying',
      clientOrderId,
      operationId,
      orderId,
    }
  }
}

async function dispatchWalletActivity(params: unknown): Promise<DaemonResponse> {
  let request: ReturnType<typeof validateWalletActivityParams>
  try {
    request = validateWalletActivityParams(params)
  } catch {
    return {
      ok: false,
      code: 'invalid-wallet-activity-request',
      error: 'Wallet Activity request is invalid',
    }
  }
  if (!(await readProfile())) {
    return { ok: false, error: 'daemon profile is not initialized' }
  }
  const secrets = await readSecrets()
  if (!secrets) return { ok: false, error: 'daemon secrets are not initialized' }
  const walletId = deriveDurableCustodyWalletId(Buffer.from(secrets.walletSeedHex, 'hex'))
  if (request.walletId !== undefined && request.walletId !== walletId) {
    return {
      ok: false,
      code: 'wallet-activity-wallet-mismatch',
      error: 'Wallet Activity wallet ID does not match the selected wallet',
    }
  }
  const session = createDaemonStateSqliteSession(profileDir())
  const page = await session.read((database) =>
    new NativeActivitySqlite(database).page({ ...request, walletId }),
  )
  return { ok: true, result: page }
}

function requiresReadyCustody(method: DaemonCommand['method']): boolean {
  return (
    method === 'market.create' ||
    method === 'market.create-native' ||
    method === 'market.creation-resume' ||
    method === 'market.creation-quote' ||
    method === 'market.funding.quote' ||
    method === 'market.funding.head' ||
    method === 'market.fund' ||
    method === 'score.quote' ||
    method === 'score.buy' ||
    method === 'score.status' ||
    method === 'wallet.receive' ||
    method === 'wallet.request.create' ||
    method === 'wallet.send' ||
    method === 'wallet.pay.quote' ||
    method === 'wallet.pay.execute' ||
    method === 'wallet.invoice.create' ||
    method === 'wallet.invoice.replace' ||
    method === 'wallet.splitCompleteSet' ||
    method === 'wallet.consolidateMarket' ||
    method === 'wallet.consolidateProofs' ||
    method === 'wallet.retireCondition' ||
    method === 'wallet.claimPosition' ||
    method === 'wallet.removePreview' ||
    method === 'wallet.removePosition' ||
    method === 'order.submit' ||
    method === 'order.fee-preview'
  )
}

async function dispatchNativePaymentRequest(
  command: Extract<
    DaemonCommand,
    {
      method:
        | 'wallet.request.create'
        | 'wallet.request.status'
        | 'wallet.request.list'
        | 'wallet.request.recover'
    }
  >,
  deps: DispatchDependencies,
): Promise<DaemonResponse> {
  const params: unknown = command.params
  if (
    params !== undefined &&
    (typeof params !== 'object' || params === null || Array.isArray(params))
  )
    return {
      ok: false,
      code: 'invalid-payment-request',
      error: 'invalid native payment request command',
    }
  const row = (params ?? {}) as Record<string, unknown>
  const validId = (value: unknown) =>
    typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 256
  let valid: boolean
  switch (command.method) {
    case 'wallet.request.create':
      valid =
        Object.keys(row).every((key) => key === 'requestId') &&
        (row.requestId === undefined || validId(row.requestId))
      break
    case 'wallet.request.status':
    case 'wallet.request.recover':
      valid = Object.keys(row).length === 1 && validId(row.requestId)
      break
    case 'wallet.request.list':
      valid =
        Object.keys(row).every((key) => key === 'cursor' || key === 'pageSize') &&
        (row.cursor === undefined ||
          row.cursor === null ||
          (typeof row.cursor === 'string' && Buffer.byteLength(row.cursor) <= 4096)) &&
        (row.pageSize === undefined ||
          (Number.isSafeInteger(row.pageSize) &&
            Number(row.pageSize) >= 1 &&
            Number(row.pageSize) <= 256))
      break
  }
  if (!valid)
    return {
      ok: false,
      code: 'invalid-payment-request',
      error: 'invalid native payment request command',
    }
  if (deps.nativePaymentRequests === undefined)
    return {
      ok: false,
      code: 'payment-request-unavailable',
      error: 'native payment request service is unavailable',
    }
  try {
    switch (command.method) {
      case 'wallet.request.create':
        return { ok: true, result: await deps.nativePaymentRequests.create(command.params) }
      case 'wallet.request.status':
        return { ok: true, result: await deps.nativePaymentRequests.status(command.params) }
      case 'wallet.request.recover':
        return { ok: true, result: await deps.nativePaymentRequests.recover(command.params) }
      case 'wallet.request.list':
        return {
          ok: true,
          result: await deps.nativePaymentRequests.list({
            cursor: command.params?.cursor ?? null,
            limit: command.params?.pageSize,
          }),
        }
    }
  } catch {
    return {
      ok: false,
      code: 'payment-request-failed',
      error: 'native payment request command failed',
    }
  }
}

type NativeLightningInvoiceCommand = Extract<
  DaemonCommand,
  {
    method:
      | 'wallet.invoice.create'
      | 'wallet.invoice.show'
      | 'wallet.invoice.hide'
      | 'wallet.invoice.replace'
  }
>

async function dispatchNativeLightningInvoice(
  command: NativeLightningInvoiceCommand,
  deps: DispatchDependencies,
): Promise<DaemonResponse> {
  if (!isValidNativeLightningInvoiceParams(command.method, command.params as unknown)) {
    return invalidNativeLightningInvoiceRequest()
  }

  if (!(await readProfile())) {
    return { ok: false, error: 'daemon profile is not initialized' }
  }
  const ops = deps.nativeLightningOps
  if (!ops) return { ok: false, error: 'native Lightning invoice operations are unavailable' }

  try {
    switch (command.method) {
      case 'wallet.invoice.create': {
        const invoice = await ops.createInvoice(command.params.amountMsat)
        deps.triggerCustodyRecovery?.()
        return { ok: true, result: invoice }
      }
      case 'wallet.invoice.show': {
        const invoice = await ops.showInvoice(command.params.quoteRecordId)
        return invoice === null
          ? { ok: false, code: 'invoice-not-found', error: 'invoice was not found' }
          : { ok: true, result: invoice }
      }
      case 'wallet.invoice.hide':
        return { ok: true, result: await ops.hideInvoice(command.params.quoteRecordId) }
      case 'wallet.invoice.replace': {
        const replacement = await ops.replaceInvoice(
          command.params.quoteRecordId,
          command.params.amountMsat,
        )
        deps.triggerCustodyRecovery?.()
        return { ok: true, result: replacement }
      }
    }
  } catch {
    return {
      ok: false,
      code: 'invoice-operation-failed',
      error: 'Invoice operation failed. Inspect saved invoices before retrying.',
    }
  }
}

function isValidNativeLightningInvoiceParams(
  method: NativeLightningInvoiceCommand['method'],
  value: unknown,
): boolean {
  if (!isRpcRecord(value)) return false
  switch (method) {
    case 'wallet.invoice.create':
      return isPositiveSafeMsat(value.amountMsat)
    case 'wallet.invoice.show':
    case 'wallet.invoice.hide':
      return isNativeInvoiceRecordId(value.quoteRecordId)
    case 'wallet.invoice.replace':
      return isNativeInvoiceRecordId(value.quoteRecordId) && isPositiveSafeMsat(value.amountMsat)
  }
  return false
}

function invalidNativeLightningInvoiceRequest(): DaemonResponse {
  return {
    ok: false,
    code: 'invalid-invoice-request',
    error: 'Invoice request is invalid',
  }
}

function isNativeInvoiceRecordId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

type NativeWalletPaymentCommand = Extract<
  DaemonCommand,
  { method: 'wallet.pay.quote' | 'wallet.pay.execute' | 'wallet.pay.status' }
>

async function dispatchNativeWalletPayment(
  command: NativeWalletPaymentCommand,
  deps: DispatchDependencies,
): Promise<DaemonResponse> {
  const params = command.params as unknown
  if (!isRpcRecord(params)) return invalidNativeWalletPaymentRequest()
  if (command.method === 'wallet.pay.quote') {
    if (
      typeof params.invoice !== 'string' ||
      params.invoice.length === 0 ||
      params.invoice.length > 10_000 ||
      params.invoice.trim() !== params.invoice
    ) {
      return invalidNativeWalletPaymentRequest()
    }
  } else if (command.method === 'wallet.pay.execute') {
    if (!isWalletPaymentQuote(params.consent)) return invalidNativeWalletPaymentRequest()
  } else if (!isWalletPaymentOperationId(params.operationId)) {
    return invalidNativeWalletPaymentRequest()
  }

  if (!(await readProfile())) {
    return { ok: false, error: 'daemon profile is not initialized' }
  }
  const ops = deps.nativeWalletPaymentOps
  if (!ops) {
    return { ok: false, code: 'wallet-payment-unavailable', error: 'Wallet payment is unavailable' }
  }

  switch (command.method) {
    case 'wallet.pay.quote':
      try {
        return { ok: true, result: await ops.quote({ invoice: params.invoice as string }) }
      } catch {
        return {
          ok: false,
          code: 'wallet-payment-quote-unavailable',
          error: 'Invoice payment quote is unavailable; no payment was started',
        }
      }
    case 'wallet.pay.execute': {
      const consent = params.consent as WalletPaymentQuote
      try {
        return {
          ok: true,
          result: await ops.pay({
            ...consent,
            approvedMaxDebitMsat: consent.totalWalletDebitMsat,
          }),
        }
      } catch {
        return {
          ok: false,
          code: 'wallet-payment-unconfirmed',
          error: 'Wallet payment could not be confirmed; inspect status before retrying',
          result: { operationId: consent.operationId },
        }
      } finally {
        deps.triggerCustodyRecovery?.()
      }
    }
    case 'wallet.pay.status':
      try {
        return {
          ok: true,
          result: await ops.status({ operationId: params.operationId as string }),
        }
      } catch {
        return {
          ok: false,
          code: 'wallet-payment-status-unavailable',
          error: 'Wallet payment status is unavailable',
        }
      }
  }
  return invalidNativeWalletPaymentRequest()
}

function invalidNativeWalletPaymentRequest(): DaemonResponse {
  return {
    ok: false,
    code: 'invalid-wallet-payment-request',
    error: 'Wallet payment request is invalid',
  }
}

type ParticipationScoreCommand = Extract<
  DaemonCommand,
  { method: 'score.show' | 'score.quote' | 'score.buy' | 'score.status' }
>

interface ParticipationScoreContext {
  readonly engineBaseUrl: string
  readonly accountSubject: string
  readonly walletId: string
  readonly mintUrl: string
}

/** Handle native Score reads and explicitly approved Score purchases. */
async function dispatchParticipationScore(
  command: ParticipationScoreCommand,
  deps: DispatchDependencies,
): Promise<DaemonResponse> {
  const profile = await readProfile()
  if (!profile) return { ok: false, error: 'daemon profile is not initialized' }
  const secrets = await readSecrets()
  if (!secrets) return { ok: false, error: 'daemon secrets are not initialized' }
  const client = await createEngineClient(deps, {
    baseUrl: profile.engineBaseUrl,
    nostrSecretKeyHex: secrets.nostrSecretKeyHex,
  })
  if (command.method === 'score.show') {
    try {
      return { ok: true, result: await client.getParticipationScore() }
    } catch {
      return {
        ok: false,
        code: 'score-unavailable',
        error: 'Participation Score is unavailable',
      }
    }
  }

  const context = readParticipationScoreContext(
    profile.engineBaseUrl,
    profile.mintUrl,
    secrets.nostrPublicKeyHex,
    deps,
  )
  if (context === null) {
    return {
      ok: false,
      code: 'score-wallet-unavailable',
      error: 'Participation Score requires the configured wallet custody profile',
    }
  }

  if (command.method === 'score.quote') {
    const params = command.params as unknown
    if (
      !isRpcRecord(params) ||
      !isTransferId(params.deliveryId) ||
      !isPositiveSafeScore(params.scorePoints)
    ) {
      return {
        ok: false,
        code: 'invalid-score-purchase',
        error: 'Score purchase request is invalid',
      }
    }
    const amountMsat = scorePointsToMsat(params.scorePoints)
    if (amountMsat === null) {
      return {
        ok: false,
        code: 'invalid-score-purchase',
        error: 'Score purchase amount is invalid',
      }
    }
    try {
      const score = await client.getParticipationScore()
      if (!isParticipationScoreForAccount(score, context.accountSubject)) {
        return { ok: false, code: 'score-account-mismatch', error: 'Score account context changed' }
      }
      const cost = await (deps.participationScoreOps?.quote ?? quoteParticipationScoreCashu)({
        amountMsat,
        profile,
        secrets,
        deps,
      })
      if (!isScorePurchaseCost(cost, amountMsat)) {
        return {
          ok: false,
          code: 'score-quote-invalid',
          error: 'The wallet returned an invalid Score purchase quote',
        }
      }
      return {
        ok: true,
        result: {
          request: {
            deliveryId: params.deliveryId,
            scorePoints: params.scorePoints,
            amountMsat,
            purchasedTotalEpoch: score.purchasedTotal,
            ...context,
          },
          cost,
        },
      }
    } catch {
      return {
        ok: false,
        code: 'score-quote-unavailable',
        error: 'Participation Score purchase cost is unavailable',
      }
    }
  }

  const consent = decodeScorePurchaseConsent(command.params?.consent)
  if (consent === null) {
    return { ok: false, code: 'invalid-score-purchase', error: 'Score purchase consent is invalid' }
  }
  if (!scoreConsentMatchesContext(consent, context)) {
    return {
      ok: false,
      code: 'score-consent-context-mismatch',
      error: 'Score purchase consent belongs to a different engine, account, wallet, or mint',
    }
  }
  const { request, cost } = consent
  const recipientClient = {
    getDurableRecipientDeliveryStatus: (deliveryId: string) => {
      if (client.getDurableRecipientDeliveryStatus === undefined) {
        throw new Error('engine does not support durable recipient delivery status')
      }
      return client.getDurableRecipientDeliveryStatus(deliveryId)
    },
    submitDurableRecipientDelivery: (submission: DurableRecipientDeliverySubmission) => {
      if (client.submitDurableRecipientDelivery === undefined) {
        throw new Error('engine does not support durable recipient delivery submission')
      }
      return client.submitDurableRecipientDelivery(submission)
    },
  }

  let remoteStatus: DurableRecipientDeliveryStatus | null
  try {
    remoteStatus = await readParticipationScoreDeliveryStatus({
      deliveryId: request.deliveryId,
      accountSubject: context.accountSubject,
      amountMsat: request.amountMsat,
      mintUrl: context.mintUrl,
      client: recipientClient,
    })
  } catch {
    return {
      ok: false,
      code: 'score-status-unavailable',
      error: 'Participation Score delivery status is unavailable; no new payment was started',
    }
  }
  if (
    remoteStatus !== null &&
    (remoteStatus.state === 'credited' || command.method === 'score.status')
  ) {
    return {
      ok: true,
      result: scoreDeliveryStatusResult(consent, remoteStatus.state, remoteStatus.result),
    }
  }
  if (command.method === 'score.status') {
    return {
      ok: true,
      result: scoreDeliveryStatusResult(consent, 'not-found', null),
    }
  }

  if (remoteStatus === null) {
    let score: ParticipationScoreResponse
    try {
      score = await client.getParticipationScore()
    } catch {
      return {
        ok: false,
        code: 'score-unavailable',
        error: 'Current Participation Score is unavailable; no new payment was started',
      }
    }
    if (
      !isParticipationScoreForAccount(score, context.accountSubject) ||
      score.purchasedTotal !== request.purchasedTotalEpoch
    ) {
      return {
        ok: false,
        code: 'score-consent-stale',
        error: 'Participation Score changed after this quote; create a new quote before payment',
      }
    }
  }
  try {
    const delivery = await (deps.participationScoreOps?.deliver ?? deliverParticipationScoreCashu)({
      deliveryId: request.deliveryId,
      accountSubject: context.accountSubject,
      amountMsat: request.amountMsat,
      purchasedTotalEpoch: request.purchasedTotalEpoch,
      maxWalletDebitMsat: cost.totalWalletDebitMsat,
      requireExactRequest: true,
      retryOnly: remoteStatus !== null,
      profile,
      secrets,
      client: recipientClient,
      deps,
    })
    return {
      ok: true,
      result: {
        deliveryId: delivery.deliveryId,
        transferId: delivery.transferId,
        scorePoints: request.scorePoints,
        amountMsat: request.amountMsat,
        totalWalletDebitMsat: cost.totalWalletDebitMsat,
        state: delivery.state,
      },
    }
  } catch (error) {
    if (error instanceof ParticipationScoreRetryUnavailableError && remoteStatus !== null) {
      return {
        ok: true,
        result: scoreDeliveryStatusResult(consent, remoteStatus.state, remoteStatus.result),
      }
    }
    const message =
      error instanceof Error &&
      (error.message === 'outgoing wallet debit exceeds the approved maximum' ||
        error.message === 'Participation Score purchase conflicts with the active delivery')
        ? error.message
        : 'Participation Score purchase could not be confirmed; reuse the same quote to check status'
    return { ok: false, code: 'score-purchase-unconfirmed', error: message }
  } finally {
    deps.triggerCustodyRecovery?.()
  }
}

function readParticipationScoreContext(
  engineBaseUrl: string,
  mintUrl: string,
  accountSubject: string,
  deps: DispatchDependencies,
): ParticipationScoreContext | null {
  const fence = deps.getCustodyFence?.()
  const prefix = 'custody:wallet:'
  if (fence === undefined || !fence.scopeId.startsWith(prefix)) return null
  const walletId = fence.scopeId.slice(prefix.length)
  if (!/^[0-9a-f]{64}$/.test(walletId)) return null
  return { engineBaseUrl, accountSubject, walletId, mintUrl }
}

function decodeScorePurchaseConsent(value: unknown): ScorePurchaseConsent | null {
  if (!isRpcRecord(value) || !isRpcRecord(value.request) || !isRpcRecord(value.cost)) return null
  const request = value.request
  const cost = value.cost
  if (
    !isTransferId(request.deliveryId) ||
    !isPositiveSafeScore(request.scorePoints) ||
    !isPositiveSafeMsat(request.amountMsat) ||
    !Number.isSafeInteger(request.purchasedTotalEpoch) ||
    (request.purchasedTotalEpoch as number) < 0 ||
    typeof request.engineBaseUrl !== 'string' ||
    typeof request.accountSubject !== 'string' ||
    typeof request.walletId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(request.walletId) ||
    typeof request.mintUrl !== 'string' ||
    !isNonNegativeSafeInteger(cost.sendPreparationFeeMsat) ||
    !isPositiveSafeMsat(cost.totalWalletDebitMsat)
  ) {
    return null
  }
  const amountMsat = scorePointsToMsat(request.scorePoints)
  if (
    amountMsat === null ||
    amountMsat !== request.amountMsat ||
    cost.amountMsat !== request.amountMsat ||
    cost.totalWalletDebitMsat !== request.amountMsat + cost.sendPreparationFeeMsat
  ) {
    return null
  }
  return value as unknown as ScorePurchaseConsent
}

function scoreConsentMatchesContext(
  consent: ScorePurchaseConsent,
  context: ParticipationScoreContext,
): boolean {
  return (
    consent.request.engineBaseUrl === context.engineBaseUrl &&
    consent.request.accountSubject === context.accountSubject &&
    consent.request.walletId === context.walletId &&
    consent.request.mintUrl === context.mintUrl
  )
}

function isScorePurchaseCost(
  value: { amountMsat: number; sendPreparationFeeMsat: number; totalWalletDebitMsat: number },
  amountMsat: number,
): boolean {
  return (
    value.amountMsat === amountMsat &&
    isNonNegativeSafeInteger(value.sendPreparationFeeMsat) &&
    isPositiveSafeMsat(value.totalWalletDebitMsat) &&
    Number.isSafeInteger(amountMsat + value.sendPreparationFeeMsat) &&
    value.totalWalletDebitMsat === amountMsat + value.sendPreparationFeeMsat
  )
}

function isParticipationScoreForAccount(
  score: ParticipationScoreResponse,
  accountSubject: string,
): boolean {
  return (
    score.pubkey === accountSubject &&
    Number.isSafeInteger(score.purchasedTotal) &&
    score.purchasedTotal >= 0
  )
}

function isPositiveSafeScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function scorePointsToMsat(scorePoints: number): number | null {
  const amountMsat = scorePoints * 1_000
  return Number.isSafeInteger(amountMsat) ? amountMsat : null
}

function scoreDeliveryStatusResult(
  consent: ScorePurchaseConsent,
  state: DurableRecipientDeliveryStatus['state'] | 'not-found',
  recipientResult: DurableRecipientDeliveryStatus['result'] | null,
) {
  return {
    deliveryId: consent.request.deliveryId,
    transferId: consent.request.deliveryId,
    scorePoints: consent.request.scorePoints,
    amountMsat: consent.request.amountMsat,
    totalWalletDebitMsat: consent.cost.totalWalletDebitMsat,
    state,
    ...(recipientResult === null
      ? {}
      : {
          creditedAmountMsat: recipientResult.creditedAmount,
          receiveFeeMsat: recipientResult.receiveFee,
        }),
  }
}

type MarketFundingCommand = Extract<
  DaemonCommand,
  { method: 'market.funding.quote' | 'market.funding.head' | 'market.fund' }
>

/** Resolve product authority at the daemon boundary. The caller cannot choose the subject. */
async function dispatchMarketFunding(
  command: MarketFundingCommand,
  deps: DispatchDependencies,
): Promise<DaemonResponse> {
  const params = command.params as unknown
  if (!isRpcRecord(params) || !isCanonicalConditionId(params.conditionId)) {
    return { ok: false, code: 'invalid-market-funding', error: 'conditionId is invalid' }
  }
  const conditionId = params.conditionId
  if (command.method === 'market.funding.quote') {
    if (!isPositiveSafeMsat(params.requestedAmountMsat)) {
      return { ok: false, code: 'invalid-market-funding', error: 'requestedAmountMsat is invalid' }
    }
  }
  if (command.method === 'market.fund') {
    const attempt = params.attempt
    if (
      !isRpcRecord(attempt) ||
      (attempt.kind === 'begin'
        ? !isTransferId(attempt.newAttemptId) ||
          (attempt.expectedPreviousTransferId !== null &&
            !isTransferId(attempt.expectedPreviousTransferId)) ||
          typeof attempt.requestedAmount !== 'string' ||
          !/^[1-9][0-9]*$/.test(attempt.requestedAmount) ||
          !isPositiveSafeMsat(Number(attempt.requestedAmount))
        : attempt.kind !== 'resume' || !isTransferId(attempt.transferId))
    ) {
      return { ok: false, code: 'invalid-market-funding', error: 'funding attempt is invalid' }
    }
    if (params.maxWalletDebitMsat !== undefined && !isPositiveSafeMsat(params.maxWalletDebitMsat)) {
      return { ok: false, code: 'invalid-market-funding', error: 'maxWalletDebitMsat is invalid' }
    }
  }

  const profile = await readProfile()
  if (!profile) return { ok: false, error: 'daemon profile is not initialized' }
  if (!(await readSelectedDaemonSigner()).enabled)
    return { ok: false, code: 'signer-disconnected', error: 'Application signer is disconnected.' }
  const secrets = await readSecrets()
  if (!secrets) return { ok: false, error: 'daemon secrets are not initialized' }
  if (!deps.getCustodyFence) {
    return { ok: false, error: 'market funding requires custody authority' }
  }
  const client = await createEngineClient(deps, {
    baseUrl: profile.engineBaseUrl,
    nostrSecretKeyHex: secrets.nostrSecretKeyHex,
  })
  let market: unknown
  try {
    market = await loadMarket(client, conditionId)
  } catch {
    return {
      ok: false,
      code: 'market-funding-unavailable',
      error: 'market funding metadata is unavailable',
    }
  }
  if (market === null) {
    return { ok: false, code: 'market-not-found', error: 'market was not found' }
  }
  let divisibility: number
  let outcomeCount: number
  try {
    if (!isRpcRecord(market) || market.baseAsset !== 'sat') {
      throw new Error('unsupported market')
    }
    if (market.conditionId !== conditionId) {
      throw new Error('market condition mismatch')
    }
    if (parseMarketDivisibility(market.divisibility) === null) {
      throw new Error('market divisibility is invalid')
    }
    divisibility = normalizeMarketDivisibility(market.divisibility, 'sat')
    outcomeCount = parseMarketOutcomes(market).length
  } catch {
    return { ok: false, code: 'invalid-market', error: 'market funding metadata is invalid' }
  }
  const product = {
    accountSubject: secrets.nostrPublicKeyHex,
    conditionId,
    divisibility,
    outcomeCount,
    profile,
    deps,
  }
  if (command.method === 'market.funding.head') {
    try {
      const head = await (deps.marketFundingOps?.head ?? readMarketFundingHeadCashu)(product)
      return {
        ok: true,
        result: head === null ? null : { transferId: head.transferId, revision: head.revision },
      }
    } catch {
      return {
        ok: false,
        code: 'market-funding-unavailable',
        error: 'market funding head is unavailable',
      }
    }
  }
  if (command.method === 'market.funding.quote') {
    try {
      const quote = await (deps.marketFundingOps?.quote ?? quoteMarketFundingCashu)({
        requestedAmountMsat: params.requestedAmountMsat as number,
        outcomeCount,
        profile,
        secrets,
        deps,
      })
      return {
        ok: true,
        result: {
          grossFundingMsat: quote.grossFundingMsat,
          sendPreparationFeeMsat: quote.sendPreparationFeeMsat,
          estimatedRecipientReceiveFeeMsat: quote.estimatedRecipientReceiveFeeMsat,
          totalWalletDebitMsat: quote.totalWalletDebitMsat,
          netFundingMsat: quote.netFundingMsat,
        },
      }
    } catch (error) {
      const refusal = safeMarketFundingRefusal(error)
      if (refusal !== null) {
        return { ok: false, code: 'market-funding-refused', error: refusal }
      }
      return {
        ok: false,
        code: 'market-funding-unavailable',
        error: 'market funding quote is unavailable',
      }
    }
  }
  if (
    client.getDurableRecipientDeliveryStatus === undefined ||
    client.submitDurableRecipientDelivery === undefined
  ) {
    return {
      ok: false,
      code: 'market-funding-unavailable',
      error: 'engine does not support durable funding delivery',
    }
  }
  const attempt = command.params.attempt
  try {
    const delivery = await (deps.marketFundingOps?.deliver ?? deliverMarketFundingCashu)({
      ...product,
      attempt,
      maxWalletDebitMsat: command.params.maxWalletDebitMsat,
      secrets,
      client: {
        getDurableRecipientDeliveryStatus: (id) => client.getDurableRecipientDeliveryStatus!(id),
        submitDurableRecipientDelivery: (submission) =>
          client.submitDurableRecipientDelivery!(submission),
      },
    })
    return {
      ok: true,
      result: {
        deliveryId: delivery.deliveryId,
        transferId: delivery.transferId,
        state: delivery.state,
      },
    }
  } catch (error) {
    const attemptId = attempt.kind === 'begin' ? attempt.newAttemptId : attempt.transferId
    const refusal = safeMarketFundingRefusal(error)
    return {
      ok: false,
      code: refusal === null ? 'market-funding-unconfirmed' : 'market-funding-refused',
      error: refusal ?? 'Market funding could not be confirmed. Retry the same attempt.',
      result: { attemptId },
    }
  }
}

function isRpcRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCanonicalConditionId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function isTransferId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
}

function isPositiveSafeMsat(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function safeMarketFundingRefusal(error: unknown): string | null {
  if (error instanceof Error) {
    if (error.message === 'market funding predecessor is not credited') return error.message
    if (error.message === 'market funding wallet debit exceeds the approved maximum')
      return error.message
    if (error.message === 'market funding requires an approved maximum wallet debit')
      return error.message
    if (error.message === 'market funding amount is too small after the receive fee')
      return error.message
    if (error.message === 'market funding head changed') return error.message
  }
  return null
}

function rejectUnsupportedPublicOrder(command: DaemonCommand): DaemonResponse | null {
  if (command.method !== 'order.submit' && command.method !== 'order.fee-preview') return null
  const timeInForce =
    command.params !== null && typeof command.params === 'object'
      ? (command.params as { timeInForce?: unknown }).timeInForce
      : undefined
  if (timeInForce === 'FOK') return null
  return {
    ok: false,
    code: 'invalid-order-type',
    error: 'Order rejected: public orders require FOK',
  }
}

async function ensureDaemonParticipationScoreForNextMatch(input: {
  client: EngineClientLike
  profile: NonNullable<Awaited<ReturnType<typeof readProfile>>>
  secrets: NonNullable<Awaited<ReturnType<typeof readSecrets>>>
  deps: DispatchDependencies
  score: ParticipationScoreResponse
  plan: ParticipationScoreTopUpPlan
  requiredScore: number
}): Promise<DaemonParticipationScorePreflightResult> {
  const { score, plan, requiredScore } = input
  if (plan.kind === 'disabled') return { kind: 'disabled', score }
  if (plan.kind === 'sufficient') return { kind: 'sufficient', score }

  if (
    input.client.getDurableRecipientDeliveryStatus === undefined ||
    input.client.submitDurableRecipientDelivery === undefined
  ) {
    throw new Error('daemon engine client does not support durable Cashu deliveries')
  }
  const deliver = (deliveryId: string, amountMsat: number, purchasedTotalEpoch: number) =>
    deliverParticipationScoreCashu({
      deliveryId,
      accountSubject: input.secrets.nostrPublicKeyHex,
      amountMsat,
      purchasedTotalEpoch,
      profile: input.profile,
      secrets: input.secrets,
      client: {
        getDurableRecipientDeliveryStatus: (id) =>
          input.client.getDurableRecipientDeliveryStatus!(id),
        submitDurableRecipientDelivery: (submission) =>
          input.client.submitDurableRecipientDelivery!(submission),
      },
      deps: input.deps,
    })
  const waitForDeliveryRetry =
    input.deps.waitForParticipationScoreDeliveryRetry ??
    (() =>
      new Promise<void>((resolve) =>
        setTimeout(resolve, PARTICIPATION_SCORE_DELIVERY_POLL_INTERVAL_MS),
      ))
  const deliverUntilCredited = async (
    deliveryId: string,
    amountMsat: number,
    purchasedTotalEpoch: number,
  ) => {
    let lastState: 'pending' | 'received' = 'pending'
    for (let attempt = 0; attempt < PARTICIPATION_SCORE_DELIVERY_POLL_ATTEMPTS; attempt += 1) {
      if (attempt > 0)
        await waitForDeliveryRetry(attempt, PARTICIPATION_SCORE_DELIVERY_POLL_INTERVAL_MS)
      const delivery = await deliver(deliveryId, amountMsat, purchasedTotalEpoch)
      if (delivery.state === 'credited') return delivery
      lastState = delivery.state
    }
    throw new Error(`Participation Score delivery remains ${lastState}`)
  }
  const deliveryId = randomUUID()
  try {
    let delivery = await deliverUntilCredited(
      deliveryId,
      participationScoreToMsat(plan.deficitScore),
      score.purchasedTotal,
    )
    let refreshedScore = await input.client.getParticipationScore()
    if (refreshedScore.purchasedTotal <= score.purchasedTotal) {
      throw new Error('Participation Score credit is not available for this capability')
    }
    let refreshedPlan = planParticipationScoreTopUp(refreshedScore, requiredScore)
    if (refreshedPlan.kind === 'needs-top-up') {
      const purchasedBeforeSecondDelivery = refreshedScore.purchasedTotal
      delivery = await deliverUntilCredited(
        randomUUID(),
        participationScoreToMsat(refreshedPlan.deficitScore),
        purchasedBeforeSecondDelivery,
      )
      refreshedScore = await input.client.getParticipationScore()
      if (refreshedScore.purchasedTotal <= purchasedBeforeSecondDelivery) {
        throw new Error('Participation Score credit is not available for this capability')
      }
      refreshedPlan = planParticipationScoreTopUp(refreshedScore, requiredScore)
    }
    if (refreshedPlan.kind === 'needs-top-up') {
      throw new Error('Participation Score credit is not available for this capability')
    }
    return {
      kind: 'paid',
      score: refreshedScore,
      deliveryId: delivery.deliveryId,
      deliveryState: 'credited',
      operationId: delivery.transferId,
    }
  } finally {
    input.deps.triggerCustodyRecovery?.()
  }
}

async function consolidateMarket(input: {
  client: EngineClientLike
  marketId: string
  type: CtfConsolidationStrategy
  mintUrl: string
  secrets: Awaited<ReturnType<typeof readSecrets>>
  deps: DispatchDependencies
}): Promise<DaemonResponse> {
  if (!input.secrets) {
    return { ok: false, error: 'daemon secrets are not initialized' }
  }
  const conditionId = conditionIdFromMarketId(input.marketId)
  const market = await loadMarket(input.client, conditionId)
  if (!market) {
    return {
      ok: false,
      code: 'market-not-found',
      error: `market ${conditionId} was not found`,
    }
  }
  const marketStatus = extractMarketStatus(market)
  if (marketStatus !== 'pending') {
    return {
      ok: false,
      code: 'market-not-pending',
      error: `market ${conditionId} is not pending`,
    }
  }
  const outcomes = extractMarketOutcomes(market)
  if (outcomes.length < 2) {
    return {
      ok: false,
      code: 'invalid-market',
      error: `market ${conditionId} does not include at least two outcomes`,
    }
  }

  const proofsByCollection = await availableMarketProofs({
    mintUrl: input.mintUrl,
    conditionId,
  })
  const inputFeePpkByKeyset = await resolveCtfConsolidationInputFees(
    input.mintUrl,
    Object.values(proofsByCollection).flatMap((proofs) => proofs.map((proof) => proof.id)),
    input.deps,
  )
  const outputKeysetByCollection = await resolveCtfConsolidationOutputKeysets(
    input.mintUrl,
    conditionId,
    input.deps,
  )
  const outputKeysets = await resolveMintKeysByKeyset(
    input.mintUrl,
    Object.values(outputKeysetByCollection),
    input.deps,
  )
  const outputsByCollection: Record<string, OutputData[]> = {}
  const plan = planCtfConsolidation({
    conditionId,
    parentCollectionId: extractParentCollectionId(market),
    outcomes,
    marketStatus,
    strategy: input.type,
    proofsByCollection,
    inputFeePpkByKeyset,
    outputKeysetByCollection,
    makeOutputs: ({ collection, amountSubunits, keysetId }) => {
      const keyset = outputKeysets[keysetId]
      if (!keyset) throw new Error(`missing mint keys for output keyset ${keysetId}`)
      const outputs = OutputData.createRandomData(Amount.from(amountSubunits), keyset)
      outputsByCollection[collection] = [...(outputsByCollection[collection] ?? []), ...outputs]
      return outputs.map((output) => output.blindedMessage)
    },
  })

  if (plan.kind === 'noop') {
    if (plan.reason === 'net-collateral-nonpositive') {
      return {
        ok: false,
        code: 'ctf-consolidation-no-gain',
        error: `market ${conditionId} consolidation has no net collateral gain`,
      }
    }
    return {
      ok: true,
      result: {
        marketId: input.marketId,
        conditionId,
        type: input.type,
        status: 'skipped',
        reason: plan.reason,
        convertFeeMsat: plan.feeSubunits ?? 0,
        collateralReturnedMsat: 0,
        spentInputs: [],
        outputs: [],
      },
    }
  }

  return {
    ok: true,
    result: await executeCtfConsolidationPlan(
      {
        marketId: input.marketId,
        conditionId,
        type: input.type,
        mintUrl: input.mintUrl,
        plan,
        outputsByCollection,
        secrets: input.secrets,
      },
      input.deps,
    ),
  }
}

async function availableMarketProofs(input: {
  mintUrl: string
  conditionId: string
}): Promise<Record<string, Proof[]>> {
  const state = await ensureState()
  const groups: Record<string, Proof[]> = {}
  for (const record of state.wallet.proofs) {
    if (record.mintUrl !== input.mintUrl || record.state !== 'available') continue
    if (record.asset.unit !== 'msat') continue
    if (record.asset.kind === 'sats') {
      groups[COLLATERAL_COLLECTION] = [
        ...(groups[COLLATERAL_COLLECTION] ?? []),
        record.proof as Proof,
      ]
      continue
    }
    if (record.asset.kind === 'Outcome' && record.asset.conditionId === input.conditionId) {
      groups[record.asset.outcomeSetId] = [
        ...(groups[record.asset.outcomeSetId] ?? []),
        record.proof as Proof,
      ]
    }
  }
  return groups
}

async function loadMarket(client: EngineClientLike, conditionId: string): Promise<unknown | null> {
  if (client.getMarket) return client.getMarket(conditionId)
  return (
    (
      await client.queryMarkets({
        ids: [conditionId],
        state: 'All',
        limit: 1,
      })
    ).markets[0] ?? null
  )
}

function extractMarketOutcomes(market: unknown): string[] {
  return parseMarketOutcomes(market).map(({ label }) => label)
}

function extractMarketStatus(market: unknown): string | null {
  if (!market || typeof market !== 'object') return null
  const record = market as {
    status?: unknown
    state?: unknown
    attestation?: { status?: unknown }
  }
  for (const value of [record.status, record.state, record.attestation?.status]) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function extractParentCollectionId(market: unknown): string | undefined {
  if (!market || typeof market !== 'object') return undefined
  const record = market as {
    parentCollectionId?: unknown
    parent_collection_id?: unknown
  }
  for (const value of [record.parentCollectionId, record.parent_collection_id]) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

async function loadMarketUnit(
  client: EngineClientLike,
  conditionId: string,
): Promise<{ baseAsset: MarketBaseAsset; divisibility: number }> {
  if (!client.getMarket) throw new Error('engine client does not support market unit lookup')
  const market = await client.getMarket(conditionId)
  if (!market || typeof market !== 'object') throw new Error('market unit metadata is unavailable')
  const record = market as {
    baseAsset?: unknown
    base_asset?: unknown
    divisibility?: unknown
  }
  return {
    baseAsset: normalizeMarketBaseAsset(
      typeof record.baseAsset === 'string'
        ? record.baseAsset
        : typeof record.base_asset === 'string'
          ? record.base_asset
          : undefined,
    ),
    divisibility: normalizeMarketDivisibility(
      typeof record.divisibility === 'number' ? record.divisibility : undefined,
      'sat',
    ),
  }
}

function assertPreparedSettlementCapability(
  prepared: PreparedSettlementCapability,
  expected: { clientOrderId: string; marketId: string },
): void {
  if (
    prepared.operationId.length === 0 ||
    prepared.capability.clientOrderId !== expected.clientOrderId ||
    prepared.capability.marketId !== expected.marketId ||
    prepared.capability.orderId.length === 0 ||
    prepared.capability.reference.artifactId.length === 0 ||
    prepared.capability.reference.bindingDigest.length === 0 ||
    !Number.isSafeInteger(prepared.consolidation.feeSubunits) ||
    prepared.consolidation.feeSubunits < 0 ||
    prepared.consolidation.operationIds.some((operationId) => operationId.length === 0)
  ) {
    throw new Error('daemon settlement capability response is foreign')
  }
}

function participationScoreBackingError(input: {
  availableScoreMsat: number
  plan: ParticipationScoreTopUpPlan
}): string | null {
  if (input.plan.kind !== 'needs-top-up') return null
  if (!Number.isSafeInteger(input.availableScoreMsat) || input.availableScoreMsat < 0) {
    throw new Error('Participation Score backing exceeds safe range')
  }
  const requiredMsat = participationScoreToMsat(input.plan.deficitScore)
  if (input.availableScoreMsat >= requiredMsat) return null
  return `insufficient Participation Score backing: have ${input.availableScoreMsat} msat, need ${requiredMsat} msat`
}

function participationScoreToMsat(score: number): number {
  if (!Number.isSafeInteger(score) || score <= 0) {
    throw new Error('Participation Score amount is invalid')
  }
  const amountMsat = score * 1_000
  if (!Number.isSafeInteger(amountMsat)) {
    throw new Error('Participation Score amount exceeds safe range')
  }
  return amountMsat
}

async function trackOwnedOrderBestEffort(
  trackOwnedOrder: DispatchDependencies['trackOwnedOrder'],
  marketId: string,
  orderId: string,
): Promise<void> {
  if (!trackOwnedOrder) return
  try {
    await trackOwnedOrder(marketId, orderId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`order lifecycle subscription failed for ${orderId}: ${message}\n`)
  }
}

async function createEngineClient(
  deps: DispatchDependencies,
  options: { baseUrl: string; nostrSecretKeyHex: string },
): Promise<EngineClientLike> {
  if (!(await readSelectedDaemonSigner()).enabled)
    return new BitcasterEngineClient({ baseUrl: options.baseUrl })
  if (deps.createEngineClient) return deps.createEngineClient(options)
  return createAuthenticatedBitcasterEngineClient(options)
}

function requiresApplicationSigner(method: DaemonCommand['method']): boolean {
  switch (method) {
    case 'market.create':
    case 'market.create-native':
    case 'score.show':
    case 'score.quote':
    case 'score.buy':
    case 'score.status':
    case 'order.fee-preview':
    case 'order.submit':
    case 'order.status':
    case 'order.cancel':
      return true
    case 'health':
    case 'daemon.status':
    case 'market.creation-resume':
    // The funding dispatcher validates its request before checking the signer.
    case 'market.funding.quote':
    case 'market.funding.head':
    case 'market.fund':
    case 'market.creation-status':
    case 'market.creation-quote':
    case 'market.close':
    case 'market.attest':
    case 'market.attestation-retry':
    case 'market.resolution-status':
    case 'markets.query':
    case 'markets.show':
    case 'wallet.balance':
    case 'wallet.positions':
    case 'wallet.portfolio':
    case 'wallet.assets':
    case 'wallet.pay.quote':
    case 'wallet.pay.execute':
    case 'wallet.pay.status':
    case 'wallet.receive':
    case 'wallet.request.create':
    case 'wallet.request.status':
    case 'wallet.request.list':
    case 'wallet.request.recover':
    case 'wallet.send':
    case 'wallet.invoice.create':
    case 'wallet.invoice.show':
    case 'wallet.invoice.hide':
    case 'wallet.invoice.replace':
    case 'wallet.reclaim':
    case 'wallet.splitCompleteSet':
    case 'wallet.consolidateMarket':
    case 'wallet.consolidateProofs':
    case 'wallet.retireCondition':
    case 'wallet.claimPosition':
    case 'wallet.removePreview':
    case 'wallet.removePosition':
    case 'wallet.operations':
    case 'wallet.activity':
    case 'wallet.recover':
    case 'order.list':
    case 'order.book':
      return false
    default: {
      const unsupported: never = method
      throw new Error(`Unknown daemon command: ${unsupported}`)
    }
  }
}

function createMarketOutcomes(outcomes: string[]): CreateMarketOutcome[] {
  return outcomes.map((name) => ({ name }))
}

async function readBody(req: IncomingMessage, maxBytes?: number): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += body.byteLength
    if (maxBytes !== undefined && bytes > maxBytes)
      throw new Error('daemon request exceeds byte limit')
    chunks.push(body)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function writeJson(res: ServerResponse, status: number, body: DaemonResponse): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function isLocalCaller(address: string | undefined): boolean {
  if (!address) return true
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function isLoopbackBindHost(host: string): boolean {
  return (
    host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '::ffff:127.0.0.1'
  )
}

function defaultRpcSocketPath(): string | undefined {
  if (process.platform === 'win32') return undefined
  return rpcSocketPath()
}

async function unlinkStaleSocket(socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath)
    socket.once('connect', () => {
      socket.destroy()
      reject(new Error(`bitcaster-daemon RPC socket is already in use: ${socketPath}`))
    })
    socket.once('error', (err) => {
      const code = (err as { code?: unknown }).code
      if (code === 'ENOENT') {
        resolve()
        return
      }
      if (code === 'ECONNREFUSED') {
        unlink(socketPath).then(resolve, reject)
        return
      }
      reject(err)
    })
  })
}
