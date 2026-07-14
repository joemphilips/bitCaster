import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { readFile, unlink } from 'node:fs/promises'
import { basename } from 'node:path'
import { Amount, OutputData, type Proof } from '@cashu/cashu-ts'
import {
  BitcasterEngineClient,
  EngineClientError,
  type OrderBookSnapshot,
  type OrderStatusResponse,
  type ParticipationScoreResponse,
  type PayParticipationScoreEcashResponse,
  type QueryMarketsParams,
  type QueryMarketsResponse,
  type SubmitOrderRequest,
  type SubmitOrderResponse,
} from '@bitcaster-market/client-sdk/engineClient'
import {
  createMarketViaEngine,
  isKind89NostrEvent,
  validateMarketCreateEngineUrl,
  submitOracleAttestationViaEngine,
  type CreateMarketOutcome,
  type MarketThumbnailBytes,
} from '@bitcaster-market/client-sdk'
import { planParticipationScoreTopUp } from '@bitcaster-market/client-sdk/participationScore'
import type { DurableOrderCollateralPin } from '@bitcaster-market/client-sdk/durableOrderCollateral'
import { complementOutcomeSetId } from '@bitcaster-market/client-sdk/outcomeSets'
import { validateOrderIntent } from '@bitcaster-market/client-sdk/orderValidation'
import { checkOrderSettlementSupport } from '@bitcaster-market/client-sdk/settlementSupport'
import {
  COLLATERAL_COLLECTION,
  planCtfConsolidation,
  type CtfConsolidationStrategy,
} from '@bitcaster-market/client-sdk/ctfConsolidation'
import {
  CashuMintCtfSplitTransport,
  resolveRootPreflightOutputAmountSats,
  splitCompleteSetWithOperation,
  splitRootCompleteSetForPreflightOrder,
  type CtfProofOperationRecord,
  type CtfProofOperationStore,
} from '@bitcaster-market/client-sdk/ctfSplit'
import { takeProofsForLock } from '@bitcaster-market/client-sdk/proofSelection'
import {
  DEFAULT_SAT_MARKET_DIVISIBILITY,
  defaultCollateralUnit,
  normalizeMarketBaseAsset,
  normalizeMarketDivisibility,
  parseCashuProofUnit,
  quotePaymentSubunits,
} from '@bitcaster-market/client-sdk/marketUnits'
import {
  canBackOrder,
  type TokenHoldings,
} from '@bitcaster-market/client-sdk/tradingClient'
import { type generateOrderEphemeralKeypair } from './ephemeralKey.ts'
import { signNip98 } from './nostrAuth.ts'
import type { DaemonCommand, DaemonHealth, DaemonResponse } from './protocol.ts'
import {
  ensureProfileDir,
  normalizeEndpointUrl,
  readProfile,
  updateProfile,
} from './profile.ts'
import {
  bearerToken,
  readRpcToken,
  rpcSocketPath,
  tokenMatches,
} from './rpcAuth.ts'
import {
  getOrCreateOrderEphemeralKeypair,
  readIdentitySecrets as readSecrets,
} from './secrets.ts'
import {
  daemonStateStorageIsEmpty,
  ensureState,
  getProofOperation,
  listProofOperations,
  listLocalOrders,
  listLocalSwaps,
  markProofOperationMintSubmitted,
  markProofOperationCompleted,
  prepareProofOperation,
  readDaemonStatusSnapshot,
  readStateScope,
  readWalletBalance,
  readWalletHoldingTotals,
  recordSubmittedOrder,
  applyOrderEngineProjection,
  orderEngineProjectionScope,
  recordOrderStatus,
  updateState,
  type CashuProofRecord,
  type StoredProofRecord,
} from './state.ts'
import type { TradeRuntime } from './tradeRuntime.ts'
import {
  recoverPreparedWalletSends,
  receiveWalletToken,
  sendWalletToken,
  executeCtfConsolidationPlan,
  resolveCtfConsolidationInputFees,
  resolveCtfConsolidationOutputKeysets,
  resolveMintKeysByKeyset,
  splitAvailableSatProofsForCtfCollateral,
  type WalletOpsDependencies,
  type WalletOpsSecrets,
} from './walletOps.ts'
import { buildDaemonTokenHoldingsFromTotals } from './walletHoldings.ts'
import type { DaemonDurableTradeRecoveryRunner } from './durableTradeRecovery.ts'
import {
  DAEMON_WALLET_PROOF_CANDIDATE_LIMIT_MAX,
  deriveDaemonWalletProofIdFromProof,
} from './stateSqlite.ts'
import {
  durableOrderCollateralPinId,
  requireDaemonOrderCollateralCoordinator,
} from './durableOrderCollateralCoordinator.ts'

export interface DaemonServerOptions {
  host?: string
  port?: number
  socketPath?: string
  tradeRuntime?: TradeRuntime
  swapExecutor?: SwapRecoveryExecutor
  durableTradeRecovery?: DaemonDurableTradeRecoveryRunner
}

export interface SwapRecoveryExecutor {
  resumeActiveSwaps(
    state: Awaited<ReturnType<typeof ensureState>>,
  ): Promise<{ activeSwaps: number }>
}

export interface EngineClientLike {
  submitOrder(
    marketId: string,
    request: SubmitOrderRequest,
  ): Promise<SubmitOrderResponse>
  submitEphemeralPubkey?(
    tradeId: string,
    pubkey: string,
    conditionId?: string,
  ): Promise<unknown>
  getOrderStatus(
    marketId: string,
    orderId: string,
  ): Promise<OrderStatusResponse | null>
  cancelOrder(marketId: string, orderId: string): Promise<boolean>
  getOrderBook(marketId: string): Promise<OrderBookSnapshot>
  queryMarkets(params: QueryMarketsParams): Promise<QueryMarketsResponse>
  getParticipationScore(): Promise<ParticipationScoreResponse>
  payParticipationScoreEcash(
    amountSats: number,
    proofsToken: string,
    paymentId?: string,
  ): Promise<PayParticipationScoreEcashResponse>
  getMarket?(conditionId: string): Promise<unknown | null>
}

interface PreparedPreflightSplit {
  reservationId: string
  conditionId: string
  keepOutcomeSetId: string
  lockOutcomeSetId: string
  amountSats: number
}

interface OrderPreflightPreparationInput {
  client: EngineClientLike
  mintUrl: string
  marketId: string
  outcomeId: string
  tokenSide: 'Outcome' | 'Complement'
  side: 'Buy' | 'Sell'
  price: number
  amountSats: number
  timeInForce: 'FAK' | 'FOK' | 'GTC'
  preflightSplit?: boolean
  clientOrderId: string
  preparePin(
    preflight: PreparedPreflightSplit,
    proofs: readonly CashuProofRecord[],
  ): Promise<DurableOrderCollateralPin>
}

interface OrderPreflightPreparationIntent {
  preflight: PreparedPreflightSplit
  baseAsset: string
  unit: NonNullable<ReturnType<typeof parseCashuProofUnit>>
}

type DaemonParticipationScorePreflightResult =
  | { kind: 'disabled' | 'sufficient'; score: ParticipationScoreResponse }
  | {
      kind: 'paid'
      score: ParticipationScoreResponse
      payment: PayParticipationScoreEcashResponse
      paymentId: string
      operationId: string
    }

const SCORE_PAYMENT_ATTEMPTS = 3

async function splitWalletCompleteSet(input: {
  mintUrl: string
  conditionId: string
  amountSats: number
  operationId: string
  secrets: Awaited<ReturnType<typeof readSecrets>>
}): Promise<{
  operationId: string
  conditionId: string
  amountSats: number
  outcomeProofCounts: Record<string, number>
}> {
  if (!input.secrets) throw new Error('daemon secrets are not initialized')
  const collateral = await splitAvailableSatProofsForCtfCollateral({
    amountSats: input.amountSats,
    mintUrl: input.mintUrl,
    operationId: `${input.operationId}:regular-split`,
    secrets: input.secrets,
  })
  const transport = new CashuMintCtfSplitTransport(input.mintUrl)
  const outcomeCollectionKeysets = await transport.getRootPartitionKeysets(
    input.conditionId,
  )
  const proofsByCollection = await splitCompleteSetWithOperation({
    mintUrl: input.mintUrl,
    operationId: `${input.operationId}:ctf-split`,
    transport,
    conditionId: input.conditionId,
    collateralProofs: collateral.inputs,
    outcomeCollectionKeysets,
    amountSubunits: input.amountSats,
    proofOperationStore: ctfProofOperationStore,
    makeOutputs: ({ amountSubunits, keyset }) =>
      OutputData.createRandomData(Amount.from(amountSubunits), keyset),
  })
  await updateState(
    {
      walletProofs: walletProofMutationScope(input.mintUrl, [
        ...collateral.spent,
        ...collateral.inputs,
        ...collateral.keep,
        ...Object.values(proofsByCollection).flat(),
      ]),
    },
    (state, now) => {
    removeProofsBySecretFromState(state, input.mintUrl, [
      ...collateral.spent,
      ...collateral.inputs,
    ])
      addProofsToState(
        state,
        input.mintUrl,
        collateral.keep,
        'available',
        { kind: 'sats', baseAsset: 'sat' },
        now,
      )
    for (const [outcomeSetId, proofs] of Object.entries(proofsByCollection)) {
      addProofsToState(
        state,
        input.mintUrl,
        proofs,
        'available',
        {
          kind: 'Outcome',
          conditionId: input.conditionId,
          outcomeSetId,
          baseAsset: 'sat',
        },
        now,
      )
    }
    },
  )
  return {
    operationId: input.operationId,
    conditionId: input.conditionId,
    amountSats: input.amountSats,
    outcomeProofCounts: Object.fromEntries(
      Object.entries(proofsByCollection).map(([outcome, proofs]) => [
        outcome,
        proofs.length,
      ]),
    ),
  }
}

export interface DispatchDependencies extends WalletOpsDependencies {
  createEngineClient?: (options: {
    baseUrl: string
    nostrSecretKeyHex: string
  }) => EngineClientLike
  generateEphemeralKeypair?: typeof generateOrderEphemeralKeypair
  tradeRuntime?: TradeRuntime
  swapExecutor?: SwapRecoveryExecutor
  durableTradeRecovery?: DaemonDurableTradeRecoveryRunner
}

const ctfProofOperationStore: CtfProofOperationStore = {
  getProofOperation: async (operationId) =>
    (await getProofOperation(operationId)) as CtfProofOperationRecord | null,
  prepareProofOperation: async (input) =>
    (await prepareProofOperation(input)) as CtfProofOperationRecord,
  markProofOperationMintSubmitted: async (operationId, redeemBinding) =>
    (await markProofOperationMintSubmitted(
      operationId,
      redeemBinding,
    )) as CtfProofOperationRecord,
  markProofOperationCompleted: async (operationId, resultProofs) =>
    (await markProofOperationCompleted(
      operationId,
      resultProofs,
    )) as CtfProofOperationRecord,
}

function createOrderPreflightProofOperationStore(
  pinId: string,
  unit: ReturnType<typeof defaultCollateralUnit>,
): CtfProofOperationStore {
  return {
    getProofOperation: ctfProofOperationStore.getProofOperation,
    prepareProofOperation: async (input) =>
      (await prepareProofOperation({
        ...input,
        metadata: {
          ...input.metadata,
          reservationId: input.operationId,
          unit,
        },
        walletProofReservation: {
          reservationId: input.operationId,
          unit,
          parentOrderCollateralPinId: pinId,
        },
      })) as CtfProofOperationRecord,
    markProofOperationMintSubmitted:
      ctfProofOperationStore.markProofOperationMintSubmitted,
    markProofOperationCompleted: ctfProofOperationStore.markProofOperationCompleted,
  }
}

export async function startDaemonServer(
  options: DaemonServerOptions = {},
): Promise<Server> {
  const startRuntimeAfterListen = Boolean(
    options.tradeRuntime && (await readProfile()),
  )
  const server = createServer((req, res) => {
    void handleRequest(req, res, {
      tradeRuntime: options.tradeRuntime,
      swapExecutor: options.swapExecutor,
      durableTradeRecovery: options.durableTradeRecovery,
    })
  })
  const socketPath =
    options.socketPath ??
    (options.host || options.port ? undefined : defaultRpcSocketPath())
  if (socketPath) {
    await ensureProfileDir()
    await unlinkStaleSocket(socketPath)
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    server.once('close', () => {
      void unlink(socketPath).catch(() => undefined)
    })
    process.stdout.write(`bitcaster-daemon listening on unix://${socketPath}\n`)
    if (startRuntimeAfterListen)
      void startTradeRuntimeBestEffort(options.tradeRuntime)
    return server
  }

  const host = options.host ?? '127.0.0.1'
  if (!isLoopbackBindHost(host)) {
    throw new Error(
      `bitcaster-daemon refuses to bind non-loopback host ${host}`,
    )
  }
  const port =
    options.port ?? Number(process.env.BITCASTER_DAEMON_PORT || 42871)
  await new Promise<void>((resolve) => server.listen(port, host, resolve))
  const address = server.address()
  const boundPort = typeof address === 'object' && address ? address.port : port
  process.stdout.write(
    `bitcaster-daemon listening on http://${host}:${boundPort}\n`,
  )
  // A dead engine must not delay local health/status or make the daemon look
  // unavailable. Trade-runtime failure is already best-effort and bootstrap
  // recovery remains armed before this listener is exposed.
  if (startRuntimeAfterListen)
    void startTradeRuntimeBestEffort(options.tradeRuntime)
  return server
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DispatchDependencies = {},
): Promise<void> {
  if (!isLocalCaller(req.socket.remoteAddress)) {
    return writeJson(res, 403, { ok: false, error: 'forbidden' })
  }

  if (req.method !== 'POST' || req.url !== '/rpc') {
    return writeJson(res, 404, { ok: false, error: 'not found' })
  }

  let command: DaemonCommand
  try {
    command = JSON.parse(await readBody(req)) as DaemonCommand
  } catch {
    return writeJson(res, 400, { ok: false, error: 'invalid JSON command' })
  }

  const expectedToken = await readRpcToken()
  if (
    expectedToken &&
    !tokenMatches(bearerToken(req.headers.authorization), expectedToken)
  ) {
    return writeJson(res, 401, { ok: false, error: 'unauthorized' })
  }
  if (!expectedToken && command.method !== 'health') {
    return writeJson(res, 401, {
      ok: false,
      error: 'daemon RPC token is not initialized',
    })
  }

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

  const status =
    'status' in err && typeof err.status === 'number' ? err.status : undefined
  const cause =
    'cause' in err && err.cause instanceof Error ? err.cause.message : undefined
  const detail = [err.message, status ? `status=${status}` : null, cause]
    .filter(Boolean)
    .join('; ')
  return { ok: false, error: detail || err.message }
}

export async function dispatch(
  command: DaemonCommand,
  deps: DispatchDependencies = {},
): Promise<DaemonResponse> {
  switch (command.method) {
    case 'health':
      return {
        ok: true,
        result: {
          status: 'ok',
          service: 'bitcaster-daemon',
          sdk: '@bitcaster-market/client-sdk',
          state: (await readProfile()) ? 'ready' : 'missing-profile',
        } satisfies DaemonHealth,
      }
    case 'daemon.status': {
      const profile = await readProfile()
      if (!profile) {
        return { ok: false, error: 'daemon profile is not initialized' }
      }
      const state = await readDaemonStatusSnapshot()
      return {
        ok: true,
        result: {
          profile,
          counts: state.counts,
          wallet: state.wallet,
        },
      }
    }
    case 'daemon.config': {
      if (!command.params.engineUrl && !command.params.mintUrl) {
        return {
          ok: false,
          error: 'at least one of engineUrl or mintUrl is required',
        }
      }
      const currentProfile = await readProfile()
      if (!currentProfile) {
        return { ok: false, error: 'daemon profile is not initialized' }
      }
      const nextEngineBaseUrl = command.params.engineUrl
        ? normalizeEndpointUrl(command.params.engineUrl, 'engine URL')
        : currentProfile.engineBaseUrl
      const nextMintUrl = command.params.mintUrl
        ? normalizeEndpointUrl(command.params.mintUrl, 'mint URL')
        : currentProfile.mintUrl
      if (
        !(await daemonStateStorageIsEmpty()) &&
        (nextEngineBaseUrl !== currentProfile.engineBaseUrl ||
          nextMintUrl !== currentProfile.mintUrl)
      ) {
        return {
          ok: false,
          error:
            'daemon profile endpoints cannot be changed after wallet, proof-operation, order, or swap state exists',
        }
      }
      const profile = await updateProfile({
        ...(command.params.engineUrl !== undefined
          ? { engineBaseUrl: nextEngineBaseUrl }
          : {}),
        ...(command.params.mintUrl !== undefined
          ? { mintUrl: nextMintUrl }
          : {}),
      })
      return {
        ok: true,
        result: {
          profile,
          restartRequired: true,
          reason:
            'restart bitcaster-daemon to reconnect long-lived TradeHub runtime with updated endpoints',
        },
      }
    }
    case 'market.create': {
      const profile = await readProfile()
      if (!profile) {
        return { ok: false, error: 'daemon profile is not initialized' }
      }
      const secrets = await readSecrets()
      if (!secrets) {
        return { ok: false, error: 'daemon secrets are not initialized' }
      }
      const engineUrlValidation = validateMarketCreateEngineUrl(
        profile.engineBaseUrl,
        process.env.BITCASTER_ALLOW_INSECURE_ENGINE === '1',
      )
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
          title: command.params.title,
          description: command.params.description,
          outcomes: createMarketOutcomes(command.params.outcomes),
          ...(command.params.liquiditySats !== undefined
            ? { liquiditySats: command.params.liquiditySats }
            : {}),
          ...(command.params.tags !== undefined
            ? { categoryTags: command.params.tags }
            : {}),
        },
        thumbnailBytes,
      )
      return { ok: true, result: response }
    }
    case 'market.close': {
      const profile = await readProfile()
      if (!profile) {
        return { ok: false, error: 'daemon profile is not initialized' }
      }
      const engineUrlValidation = validateMarketCreateEngineUrl(
        profile.engineBaseUrl,
        process.env.BITCASTER_ALLOW_INSECURE_ENGINE === '1',
      )
      if (!engineUrlValidation.ok) {
        return {
          ok: false,
          error: engineUrlValidation.error,
          code: engineUrlValidation.code,
        }
      }
      if (!isKind89NostrEvent(command.params.attestationEvent)) {
        return {
          ok: false,
          error: 'attestationEvent must be a kind-89 Nostr event',
      }
      }
      const client = new BitcasterEngineClient({
        baseUrl: profile.engineBaseUrl,
      })
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
      return {
        ok: true,
        result: await readWalletBalance(),
      }
    case 'wallet.receive': {
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
        result: await receiveWalletToken(
          command.params.token,
          profile,
          secrets,
          deps,
          command.params,
        ),
      }
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
      return {
        ok: true,
        result: await sendWalletToken(
          command.params.amountSats,
          profile,
          secrets,
          deps,
          command.params.mintUrl,
          command.params.operationId,
        ),
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
          amountSats: command.params.amountSats,
          operationId:
            command.params.operationId ??
            `wallet-split-complete-set:${command.params.conditionId}:${Date.now()}`,
          secrets,
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
      const client = createEngineClient(deps, {
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
    case 'wallet.recover': {
      if (!(await readProfile())) {
        return { ok: false, error: 'daemon profile is not initialized' }
      }
      const secrets = await readSecrets()
      if (!secrets) {
        return { ok: false, error: 'daemon secrets are not initialized' }
      }
      return {
        ok: true,
        result: await recoverPreparedWalletSends(secrets, deps),
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
    case 'markets.query': {
      const profile = await readProfile()
      if (!profile) {
        return { ok: false, error: 'daemon profile is not initialized' }
      }
      const secrets = await readSecrets()
      if (!secrets) {
        return { ok: false, error: 'daemon secrets are not initialized' }
      }
      const client = createEngineClient(deps, {
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
      const client = createEngineClient(deps, {
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
    case 'order.submit': {
      const orderParams = {
        tokenSide: 'Outcome' as const,
        ...command.params,
      }
      const amountSubunits =
        orderParams.amountSubunits ?? orderParams.amountSats
      const orderIntent = {
        ...orderParams,
        amountSubunits,
        ...(orderParams.amountSubunits === undefined &&
        orderParams.amountSats !== undefined
          ? { divisibility: 100 }
          : {}),
      }
      let profile: Awaited<ReturnType<typeof readProfile>> | null = null
      let secrets: Awaited<ReturnType<typeof readSecrets>> | null = null
      let client: EngineClientLike | null = null
      const ensureOrderContext = async (): Promise<
        | {
            ok: true
            profile: NonNullable<typeof profile>
            secrets: NonNullable<typeof secrets>
            client: EngineClientLike
          }
        | { ok: false; error: string }
      > => {
        profile ??= await readProfile()
        if (!profile) {
          return { ok: false, error: 'daemon profile is not initialized' }
        }
        secrets ??= await readSecrets()
        if (!secrets) {
          return { ok: false, error: 'daemon secrets are not initialized' }
        }
        client ??= createEngineClient(deps, {
          baseUrl: profile.engineBaseUrl,
          nostrSecretKeyHex: secrets.nostrSecretKeyHex,
        })
        return { ok: true, profile, secrets, client }
      }

      let requestValidation = validateOrderIntent(orderIntent)
      if (
        !requestValidation.valid &&
        shouldRetryOrderValidationWithMarketUnit(
          orderIntent,
          requestValidation.message,
        )
      ) {
        const context = await ensureOrderContext()
        if (!context.ok) return context
        const marketUnit = await loadMarketUnit(
          context.client,
          conditionIdFromMarketId(orderParams.marketId),
        )
        requestValidation = validateOrderIntent({
          ...orderIntent,
          divisibility: marketUnit.divisibility,
        })
      }
      if (!requestValidation.valid) {
        return { ok: false, error: requestValidation.message }
      }
      if (typeof amountSubunits !== 'number') {
        return {
          ok: false,
          error:
            'Order rejected: amountSubunits must be a positive integer in 100 sub-unit increments.',
        }
      }
      const context = await ensureOrderContext()
      if (!context.ok) return context
      const settlementSupport = checkOrderSettlementSupport({
        request: { side: orderParams.side },
      })
      if (!settlementSupport.supported) {
        return { ok: false, error: settlementSupport.message }
      }
      const conditionId = conditionIdFromMarketId(orderParams.marketId)
      const marketUnit = await loadMarketUnit(context.client, conditionId)
      const participationScore = await ensureDaemonParticipationScoreForNextMatch({
        client: context.client,
        profile: context.profile,
        secrets: context.secrets,
        deps,
      })
      const holdings = buildDaemonTokenHoldingsFromTotals(
        await readWalletHoldingTotals({
        mintUrl: context.profile.mintUrl,
        conditionId,
        baseAsset: marketUnit.baseAsset,
        }),
      )
      const backingError = orderBackingError({
        side: orderParams.side,
        price: orderParams.price,
        amountSubunits,
        divisibility: marketUnit.divisibility,
        holdings,
      })
      if (backingError) {
        return { ok: false, error: backingError }
      }
      const clientOrderId = randomUUID()
      const submissionRequest: SubmitOrderRequest = {
        outcomeId: orderParams.outcomeId,
        tokenSide: orderParams.tokenSide,
        side: orderParams.side,
        price: orderParams.price,
        amountSubunits,
        timeInForce: orderParams.timeInForce,
        clientOrderId,
      }
      const preflightResult = await maybePreparePreflightSplitForOrder({
        client: context.client,
        mintUrl: context.profile.mintUrl,
        marketId: orderParams.marketId,
        outcomeId: orderParams.outcomeId,
        side: orderParams.side,
        tokenSide: orderParams.tokenSide,
        price: orderParams.price,
        amountSats: amountSubunits,
        timeInForce: orderParams.timeInForce,
        preflightSplit: orderParams.preflightSplit,
        clientOrderId,
        preparePin: (preflight, proofs) => prepareOrderCollateralPin({
          marketId: orderParams.marketId,
          mintUrl: context.profile.mintUrl,
          unit: defaultCollateralUnit(marketUnit.baseAsset),
          conditionId,
          submissionRequest,
          divisibility: marketUnit.divisibility,
          baseAsset: marketUnit.baseAsset,
          preparedPreflight: preflight,
          exactProofs: proofs,
          preparing: true,
          resolveInputFeePpkByKeyset: deps.resolveInputFeePpkByKeyset,
        }),
      })
      const preparedPreflight = preflightResult?.preflight ?? null
      const collateralPin = orderParams.timeInForce === 'GTC'
        ? preflightResult?.pin ?? await prepareOrderCollateralPin({
            marketId: orderParams.marketId,
            mintUrl: context.profile.mintUrl,
            unit: defaultCollateralUnit(marketUnit.baseAsset),
            conditionId,
            submissionRequest,
            divisibility: marketUnit.divisibility,
            baseAsset: marketUnit.baseAsset,
            preparedPreflight,
            resolveInputFeePpkByKeyset: deps.resolveInputFeePpkByKeyset,
          })
        : null
      let submitted: SubmitOrderResponse
      try {
        submitted = await context.client.submitOrder(
          orderParams.marketId,
          submissionRequest,
        )
      } catch (err) {
        if (err instanceof EngineClientError && collateralPin) {
          await releaseOrderCollateralBeforeSubmit(collateralPin.pinId)
        }
        if (err instanceof EngineClientError) {
          return {
            ok: false,
            error: err.problemDetail ?? err.message,
            code: err.code,
          }
        }
        throw err
      }
      const local = collateralPin
        ? await commitAcceptedOrderSubmission(collateralPin, submitted)
        : await recordSubmittedOrder(
            orderParams.marketId,
            clientOrderId,
            submitted,
            preparedPreflight,
            orderParams.tokenSide,
            orderParams.side,
            orderParams.price,
            amountSubunits,
            orderParams.timeInForce,
          )
    await submitPendingEphemeralPubkeys({
      client: context.client,
      marketId: orderParams.marketId,
      conditionId: splitMarketId(orderParams.marketId)?.conditionId,
      orderId: submitted.orderId,
        pendingPubkeySubmissions: submitted.pendingPubkeySubmissions,
        generateEphemeralKeypair: deps.generateEphemeralKeypair,
      })
      await startTradeRuntimeBestEffort(deps.tradeRuntime)
      return {
        ok: true,
        result: { engine: submitted, local, participationScore },
      }
    }
    case 'trade.watch': {
      const profile = await readProfile()
      if (!profile) {
        return { ok: false, error: 'daemon profile is not initialized' }
      }
      const state = await readStateScope({ swapIds: [command.params.tradeId] })
      return {
        ok: true,
        result: state?.swaps[command.params.tradeId] ?? null,
      }
    }
    case 'trade.list': {
      const profile = await readProfile()
      if (!profile) {
        return { ok: false, error: 'daemon profile is not initialized' }
      }
      return {
        ok: true,
        result: await listLocalSwaps(command.params ?? {}),
      }
    }
    case 'trade.recover': {
      const profile = await readProfile()
      if (!profile) {
        return { ok: false, error: 'daemon profile is not initialized' }
      }
      if (!deps.durableTradeRecovery) {
        return {
          ok: false,
          error: 'daemon durable recovery coordinator is not available',
        }
      }
      await startTradeRuntimeBestEffort(deps.tradeRuntime)
      const recovery = await deps.durableTradeRecovery.recover()
      return {
        ok: true,
        result: { activeSwaps: recovery.activeSwaps },
      }
    }
    case 'order.status': {
      const profile = await readProfile()
      if (!profile) {
        return { ok: false, error: 'daemon profile is not initialized' }
      }
      const secrets = await readSecrets()
      if (!secrets) {
        return { ok: false, error: 'daemon secrets are not initialized' }
      }
      const client = createEngineClient(deps, {
        baseUrl: profile.engineBaseUrl,
        nostrSecretKeyHex: secrets.nostrSecretKeyHex,
      })
      const status = await client.getOrderStatus(
        command.params.marketId,
        command.params.orderId,
      )
      const local = status
        ? await recordOrderStatus(
            command.params.marketId,
            command.params.orderId,
            status,
          )
        : null
      if (status && local?.clientOrderId && local.timeInForce === 'GTC') {
        await observeOrderCollateral({
          clientOrderId: local.clientOrderId,
          orderId: status.orderId,
          status: status.status,
          remainingAmount: status.remainingAmountSubunits,
          tradeIds: local.tradeIds,
        })
      }
      if (local) {
        await startTradeRuntimeBestEffort(deps.tradeRuntime)
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
      const client = createEngineClient(deps, {
        baseUrl: profile.engineBaseUrl,
        nostrSecretKeyHex: secrets.nostrSecretKeyHex,
      })
      const cancelled = await client.cancelOrder(
        command.params.marketId,
        command.params.orderId,
      )
      const local = cancelled
        ? await recordOrderStatus(
            command.params.marketId,
            command.params.orderId,
            {
              orderId: command.params.orderId,
              marketId: command.params.marketId,
              status: 'cancelled',
            },
          )
        : null
      if (cancelled && local?.clientOrderId && local.timeInForce === 'GTC') {
        await observeOrderCollateral({
          clientOrderId: local.clientOrderId,
          orderId: command.params.orderId,
          status: 'cancelled',
          remainingAmount: 0,
          tradeIds: local.tradeIds,
        })
      }
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
      const client = createEngineClient(deps, {
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

async function ensureDaemonParticipationScoreForNextMatch(input: {
  client: EngineClientLike
  profile: NonNullable<Awaited<ReturnType<typeof readProfile>>>
  secrets: NonNullable<Awaited<ReturnType<typeof readSecrets>>>
  deps: DispatchDependencies
}): Promise<DaemonParticipationScorePreflightResult> {
  const score = await input.client.getParticipationScore()
  const plan = planParticipationScoreTopUp(score)
  if (plan.kind === 'disabled') return { kind: 'disabled', score }
  if (plan.kind === 'sufficient') return { kind: 'sufficient', score }

  const paymentId = randomUUID()
  const operationId = `engine-score:${paymentId}`
  const token = await sendWalletToken(
    plan.deficitScore,
    input.profile,
    input.secrets,
    input.deps,
    input.profile.mintUrl,
    operationId,
  )
  const payment = await payParticipationScoreEcashWithRetry(
    input.client,
    plan.deficitScore,
    token.token,
    paymentId,
  )
  return { kind: 'paid', score, payment, paymentId, operationId }
}

async function payParticipationScoreEcashWithRetry(
  client: EngineClientLike,
  amountSats: number,
  token: string,
  paymentId: string,
): Promise<PayParticipationScoreEcashResponse> {
  let lastError: unknown
  for (let attempt = 0; attempt < SCORE_PAYMENT_ATTEMPTS; attempt += 1) {
    try {
      return await client.payParticipationScoreEcash(
        amountSats,
        token,
        paymentId,
      )
    } catch (err) {
      lastError = err
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Failed to pay Engine Score.')
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
  const marketUnit = await loadMarketUnit(input.client, conditionId)

  const proofsByCollection = await availableMarketProofs({
    mintUrl: input.mintUrl,
    conditionId,
    baseAsset: marketUnit.baseAsset,
  })
  const inputFeePpkByKeyset = await resolveCtfConsolidationInputFees(
    input.mintUrl,
    Object.values(proofsByCollection).flatMap((proofs) =>
      proofs.map((proof) => proof.id),
    ),
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
      if (!keyset)
        throw new Error(`missing mint keys for output keyset ${keysetId}`)
      const outputs = OutputData.createRandomData(
        Amount.from(amountSubunits),
        keyset,
      )
      outputsByCollection[collection] = [
        ...(outputsByCollection[collection] ?? []),
        ...outputs,
      ]
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
        convertFeeSats: plan.feeSats ?? 0,
        collateralReturnedSats: 0,
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
        baseAsset: marketUnit.baseAsset,
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
  baseAsset: string
}): Promise<Record<string, Proof[]>> {
  const unit = defaultCollateralUnit(input.baseAsset)
  const state = await readStateScope({
    walletProofs: [
      {
        mintUrl: input.mintUrl,
        unit,
        state: 'available',
        assetKind: 'sats',
        baseAsset: input.baseAsset,
      },
      {
        mintUrl: input.mintUrl,
        unit,
        state: 'available',
        assetKind: 'Outcome',
        conditionId: input.conditionId,
        baseAsset: input.baseAsset,
      },
    ],
  })
  if (!state) return {}
  const groups: Record<string, Proof[]> = {}
  for (const record of state.wallet.proofs) {
    if (
      record.mintUrl !== input.mintUrl ||
      record.unit !== unit ||
      record.state !== 'available'
    )
      continue
    if (normalizeMarketBaseAsset(record.asset.baseAsset) !== input.baseAsset) {
      continue
    }
    if (record.asset.kind === 'sats') {
      groups[COLLATERAL_COLLECTION] = [
        ...(groups[COLLATERAL_COLLECTION] ?? []),
        record.proof as Proof,
      ]
      continue
    }
    if (
      record.asset.kind === 'Outcome' &&
      record.asset.conditionId === input.conditionId
    ) {
      groups[record.asset.outcomeSetId] = [
        ...(groups[record.asset.outcomeSetId] ?? []),
        record.proof as Proof,
      ]
    }
  }
  return groups
}

async function loadMarket(
  client: EngineClientLike,
  conditionId: string,
): Promise<unknown | null> {
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
  if (!market || typeof market !== 'object') return []
  const outcomes = (market as { outcomes?: unknown }).outcomes
  if (!Array.isArray(outcomes)) return []
  return outcomes
    .map((outcome) => {
      if (typeof outcome === 'string') return outcome
      if (outcome && typeof outcome === 'object') {
        const objectOutcome = outcome as {
          label?: unknown
          name?: unknown
          id?: unknown
        }
        for (const key of ['label', 'name', 'id'] as const) {
          const value = objectOutcome[key]
          if (typeof value === 'string' && value.trim()) return value
        }
      }
      return null
    })
    .filter((outcome): outcome is string => !!outcome)
}

function extractMarketStatus(market: unknown): string | null {
  if (!market || typeof market !== 'object') return null
  const record = market as {
    status?: unknown
    state?: unknown
    attestation?: { status?: unknown }
  }
  for (const value of [
    record.status,
    record.state,
    record.attestation?.status,
  ]) {
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
  for (const value of [
    record.parentCollectionId,
    record.parent_collection_id,
  ]) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function conditionIdFromMarketId(marketId: string): string {
  const parsed = splitMarketId(marketId)
  return parsed?.conditionId ?? marketId
}

function shouldRetryOrderValidationWithMarketUnit(
  request: unknown,
  validationMessage: string,
): boolean {
  if (
    !validationMessage.includes('price must be an integer') &&
    !validationMessage.includes('amountSubunits must be a positive integer')
  ) {
    return false
  }
  if (
    typeof request !== 'object' ||
    request === null ||
    Array.isArray(request)
  ) {
    return false
  }

  const intent = request as {
    price?: unknown
    amountSubunits?: unknown
    amountSats?: unknown
  }
  const price = intent.price
  const amountSubunits = intent.amountSubunits ?? intent.amountSats
  if (typeof price !== 'number' || typeof amountSubunits !== 'number') {
    return false
  }
  if (!Number.isInteger(price) || !Number.isInteger(amountSubunits)) {
    return false
  }
  if (price <= 0 || amountSubunits <= 0) {
    return false
  }
  if (
    intent.amountSubunits !== undefined &&
    intent.amountSats === undefined &&
    validationMessage.includes('amountSubunits must be a positive integer')
  ) {
    return true
  }

  return (
    price >= DEFAULT_SAT_MARKET_DIVISIBILITY ||
    amountSubunits >= DEFAULT_SAT_MARKET_DIVISIBILITY
  )
}

export async function submitPendingEphemeralPubkeys(input: {
  client: EngineClientLike
  marketId: string
  conditionId?: string
  orderId: string
  pendingPubkeySubmissions?: SubmitOrderResponse['pendingPubkeySubmissions']
  generateEphemeralKeypair?: typeof generateOrderEphemeralKeypair
}): Promise<void> {
  for (const submission of input.pendingPubkeySubmissions ?? []) {
    if (!input.client.submitEphemeralPubkey) {
      throw new Error(
        'engine client does not support ephemeral pubkey submission',
      )
    }
    const ephemeral = await getOrCreateOrderEphemeralKeypair({
      tradeId: submission.tradeId,
      orderId: input.orderId,
      marketId: input.marketId,
      generateEphemeralKeypair: input.generateEphemeralKeypair,
    })
    await input.client.submitEphemeralPubkey(
      submission.tradeId,
      ephemeral.publicKeyHex,
      input.conditionId,
    )
  }
}

export async function commitAcceptedOrderSubmission(
  pin: DurableOrderCollateralPin,
  engineResponse: SubmitOrderResponse,
) {
  if (engineResponse.orderId.length === 0) {
    throw new Error('engine submit response did not include orderId')
  }
  const request = pin.submissionRequest
  const projection = {
    marketId: pin.marketId,
    orderId: engineResponse.orderId,
    engineStatus: engineResponse,
    clientOrderId: pin.clientOrderId,
    preflightSplit: pin.preflightSplit,
    tokenSide: request.tokenSide,
    side: request.side,
    priceSubunits: request.price,
    amountSubunits: request.amountSubunits,
    timeInForce: request.timeInForce,
  } as const
  const committed = await requireDaemonOrderCollateralCoordinator()
    .commitAcceptedSubmission({
      pinId: pin.pinId,
      orderId: engineResponse.orderId,
      status: engineResponse.status,
      remainingAmount: engineResponse.remainingAmountSubunits,
      stateScope: orderEngineProjectionScope(projection),
      applyState: (state, now) =>
        applyOrderEngineProjection(state, now, projection),
    })
  return committed.result
}

export interface OrderCollateralPreparationRecoveryDependencies {
  walletOps?: WalletOpsDependencies
  resolveOutputAmount?: typeof resolveRootPreflightOutputAmountSats
  splitCollateral?: typeof splitAvailableSatProofsForCtfCollateral
  splitPreflight?: typeof splitRootCompleteSetForPreflightOrder
}

export async function recoverPreparingOrderCollateralPins(
  secrets: WalletOpsSecrets,
  deps: OrderCollateralPreparationRecoveryDependencies = {},
): Promise<{ recoveredCount: number }> {
  const coordinator = requireDaemonOrderCollateralCoordinator()
  let cursor: string | null = null
  let recoveredCount = 0
  do {
    const page = await coordinator.readPreparingPage({ cursor, limit: 64 })
    for (const pin of page.pins) {
      await resumeOrderCollateralPreparation(pin, secrets, deps)
      recoveredCount += 1
    }
    cursor = page.nextCursor
  } while (cursor !== null)
  return { recoveredCount }
}

async function resumeOrderCollateralPreparation(
  pin: DurableOrderCollateralPin,
  secrets: WalletOpsSecrets,
  deps: OrderCollateralPreparationRecoveryDependencies,
): Promise<void> {
  const preflight = pin.preflightSplit
  if (preflight === null) {
    throw new Error('preparing order collateral has no preflight authority')
  }
  const rows = await readPinnedOrderCollateralRows(pin.pinId)
  const firstRow = rows[0]
  if (firstRow === undefined) {
    throw new Error('preparing order collateral has no pinned proofs')
  }
  if (rows.every((row) => row.asset.kind === 'Outcome')) {
    await requireDaemonOrderCollateralCoordinator().finishPreparation(pin.pinId)
    return
  }
  if (rows.some((row) => row.asset.kind !== 'sats')) {
    throw new Error('preparing order collateral mixes asset classes')
  }
  const baseAsset = normalizeMarketBaseAsset(firstRow.asset.baseAsset)
  const resolveOutputAmount =
    deps.resolveOutputAmount ?? resolveRootPreflightOutputAmountSats
  const outputAmount = await resolveOutputAmount({
    mintUrl: pin.mintUrl,
    baseAsset,
    conditionId: preflight.conditionId,
    amountSats: preflight.amountSats,
    keepOutcomeSetId: preflight.keepOutcomeSetId,
    lockOutcomeSetId: preflight.lockOutcomeSetId,
  })
  const unit = parseCashuProofUnit(pin.unit)
  if (unit === null) throw new Error('preparing order collateral unit is invalid')
  const store = createOrderPreflightProofOperationStore(pin.pinId, unit)
  const regularOperationId = `${pin.pinId}:regular-split:0`
  const splitCollateral =
    deps.splitCollateral ?? splitAvailableSatProofsForCtfCollateral
  const collateral = await splitCollateral({
    amountSats: outputAmount,
    mintUrl: pin.mintUrl,
    operationId: regularOperationId,
    secrets,
    deps: deps.walletOps,
    baseAsset,
    proofOperationStore: store,
    candidateProofs: rows.map(({ proof }) => proof as Proof),
  })
  await commitAndFinishOrderCollateralPreparation({
    pin,
    preflight,
    collateral,
    outputAmount,
    baseAsset,
    store,
    deps,
  })
}

async function readPinnedOrderCollateralRows(
  pinId: string,
): Promise<StoredProofRecord[]> {
  const coordinator = requireDaemonOrderCollateralCoordinator()
  const proofIds = await coordinator.readProofIds(pinId)
  const state = await readStateScope({ walletProofs: [{ proofIds }] })
  const rows = state?.wallet.proofs ?? []
  if (rows.length !== proofIds.length) {
    throw new Error('pinned order collateral proof projection is incomplete')
  }
  await coordinator.assertOwnsProofs(pinId, rows)
  return rows
}

async function finishOrderPreflightCtfSplit(
  pin: DurableOrderCollateralPin,
  preflight: PreparedPreflightSplit,
  rows: StoredProofRecord[],
  outputAmount: number,
  baseAsset: string,
  store: CtfProofOperationStore,
  deps: OrderCollateralPreparationRecoveryDependencies = {},
): Promise<void> {
  const operationId = `${pin.pinId}:ctf-split:0`
  const splitPreflight =
    deps.splitPreflight ?? splitRootCompleteSetForPreflightOrder
  const split = await splitPreflight({
    mintUrl: pin.mintUrl,
    baseAsset,
    conditionId: preflight.conditionId,
    collateralProofs: rows.map(({ proof }) => proof as Proof),
    amountSats: outputAmount,
    keepOutcomeSetId: preflight.keepOutcomeSetId,
    lockOutcomeSetId: preflight.lockOutcomeSetId,
    operationId,
    proofOperationStore: store,
  })
  if (
    split.resolvedKeepOutcomeSetId !== preflight.keepOutcomeSetId
    || split.resolvedLockOutcomeSetId !== preflight.lockOutcomeSetId
  ) {
    throw new Error('pre-flight split resolved foreign outcome authority')
  }
  await commitOrderPreflightOutcomeTransform({
    pinId: pin.pinId,
    operationId,
    mintUrl: pin.mintUrl,
    baseAsset,
    conditionId: preflight.conditionId,
    spent: split.spentSatProofs,
    proofsByCollection: split.proofsByCollection,
  })
  await requireDaemonOrderCollateralCoordinator().finishPreparation(pin.pinId)
}

async function commitAndFinishOrderCollateralPreparation(input: {
  pin: DurableOrderCollateralPin
  preflight: PreparedPreflightSplit
  collateral: Awaited<ReturnType<typeof splitAvailableSatProofsForCtfCollateral>>
  outputAmount: number
  baseAsset: string
  store: CtfProofOperationStore
  deps: OrderCollateralPreparationRecoveryDependencies
}): Promise<void> {
  if (input.collateral.spent.length > 0) {
    await commitOrderPreflightRegularTransform({
      pin: input.pin,
      operationId: `${input.pin.pinId}:regular-split:0`,
      mintUrl: input.pin.mintUrl,
      baseAsset: input.baseAsset,
      spent: input.collateral.spent,
      keep: input.collateral.keep,
      inputs: input.collateral.inputs,
    })
  }
  const rows = await readPinnedOrderCollateralRows(input.pin.pinId)
  await finishOrderPreflightCtfSplit(
    input.pin,
    input.preflight,
    rows,
    input.outputAmount,
    input.baseAsset,
    input.store,
    input.deps,
  )
}

async function maybePreparePreflightSplitForOrder(
  input: OrderPreflightPreparationInput,
): Promise<{
  preflight: PreparedPreflightSplit
  pin: DurableOrderCollateralPin
} | null> {
  if (input.preflightSplit !== true) return null
  if (input.side !== 'Buy' || input.timeInForce !== 'GTC') return null

  const intent = await resolveOrderPreflightPreparationIntent(input)
  if (intent === null) return null
  const pin = await prepareFreshOrderPreflight(input, intent)
  return { preflight: intent.preflight, pin }
}

async function resolveOrderPreflightPreparationIntent(
  input: OrderPreflightPreparationInput,
): Promise<OrderPreflightPreparationIntent | null> {
  const market = splitMarketId(input.marketId)
  if (!market) {
    throw new Error(
      `cannot pre-flight split invalid market id ${input.marketId}`,
    )
  }
  if (input.outcomeId !== market.outcomeSetId) {
    throw new Error(
      'pre-flight split requires outcomeId to match the submitted primitive market id',
    )
  }
  const outcomeLabels = await loadOutcomeLabels(
    input.client,
    input.mintUrl,
    market.conditionId,
  )
  if (outcomeLabels.length < 2) {
    throw new Error('pre-flight split requires market outcome labels')
  }
  const complement = complementOutcomeSetId(outcomeLabels, market.outcomeSetId)
  if (!complement) {
    throw new Error(
      'pre-flight split could not resolve a complementary outcome set',
    )
  }
  if (await wouldOrderCross(input.client, input.marketId, input.price)) {
    return null
  }
  const marketUnit = await loadMarketUnit(input.client, market.conditionId)
  const reservationId = durableOrderCollateralPinId(input.clientOrderId)
  const keepOutcomeSetId =
    input.tokenSide === 'Complement' ? complement : market.outcomeSetId
  const lockOutcomeSetId =
    input.tokenSide === 'Complement' ? market.outcomeSetId : complement
  return {
    preflight: {
      reservationId,
      conditionId: market.conditionId,
      keepOutcomeSetId,
      lockOutcomeSetId,
      amountSats: input.amountSats,
    },
    baseAsset: marketUnit.baseAsset,
    unit: defaultCollateralUnit(marketUnit.baseAsset),
  }
}

async function prepareFreshOrderPreflight(
  input: OrderPreflightPreparationInput,
  intent: OrderPreflightPreparationIntent,
): Promise<DurableOrderCollateralPin> {
  const { preflight, baseAsset, unit } = intent
  let pin: DurableOrderCollateralPin | undefined
  const ensurePin = async (proofs: readonly CashuProofRecord[]) => {
    pin ??= await input.preparePin(preflight, proofs)
    return pin
  }
  const operationStore = createOrderPreflightProofOperationStore(
    preflight.reservationId,
    unit,
  )
  const outputAmount = await resolveRootPreflightOutputAmountSats({
    mintUrl: input.mintUrl,
    baseAsset,
    conditionId: preflight.conditionId,
    amountSats: input.amountSats,
    keepOutcomeSetId: preflight.keepOutcomeSetId,
    lockOutcomeSetId: preflight.lockOutcomeSetId,
  })
  const secrets = await readSecrets()
  if (!secrets) throw new Error('daemon secrets are not initialized')
  const collateral = await splitAvailableSatProofsForCtfCollateral({
    amountSats: outputAmount,
    mintUrl: input.mintUrl,
    operationId: `${preflight.reservationId}:regular-split:0`,
    secrets,
    baseAsset,
    proofOperationStore: operationStore,
    beforeCollateralUse: async (proofs) => { await ensurePin(proofs) },
  })
  if (pin === undefined) throw new Error('pre-flight collateral pin is missing')
  await commitAndFinishOrderCollateralPreparation({
    pin,
    preflight,
    collateral,
    outputAmount,
    baseAsset,
    store: operationStore,
    deps: {},
  })
  return pin
}

async function prepareOrderCollateralPin(input: {
  marketId: string
  mintUrl: string
  unit: string
  conditionId: string
  submissionRequest: SubmitOrderRequest
  divisibility: number
  baseAsset: string
  preparedPreflight: PreparedPreflightSplit | null
  exactProofs?: readonly CashuProofRecord[]
  preparing?: boolean
  resolveInputFeePpkByKeyset?: WalletOpsDependencies['resolveInputFeePpkByKeyset']
}) {
  const request = requireGtcSubmissionRequest(input.submissionRequest)
  const requiredAmount = requiredOrderCollateralAmount({
    side: request.side,
    price: request.price,
    amountSubunits: request.amountSubunits,
    divisibility: input.divisibility,
  })
  const proofs = input.exactProofs
    ? await readExactAvailableOrderCollateralRows({
        mintUrl: input.mintUrl,
        unit: input.unit,
        baseAsset: input.baseAsset,
        proofs: input.exactProofs,
      })
    : await selectOrderCollateralRows({
        ...input,
        outcomeId: request.outcomeId,
        side: request.side,
      }, requiredAmount)
  return requireDaemonOrderCollateralCoordinator().prepare({
    clientOrderId: request.clientOrderId,
    marketId: input.marketId,
    mintUrl: input.mintUrl,
    unit: input.unit,
    orderAmount: request.amountSubunits,
    requiredAmount,
    submissionRequest: request,
    preflightSplit: input.preparedPreflight,
    preparing: input.preparing,
    proofs,
  })
}

function requireGtcSubmissionRequest(
  request: SubmitOrderRequest,
): Omit<SubmitOrderRequest, 'timeInForce' | 'comment'> & { timeInForce: 'GTC' } {
  if (request.timeInForce !== 'GTC' || request.comment !== undefined) {
    throw new Error('order collateral requires an unsigned exact GTC request')
  }
  const { comment: _comment, ...exact } = request
  return { ...exact, timeInForce: 'GTC' }
}

function requiredOrderCollateralAmount(input: {
  side: 'Buy' | 'Sell'
  price: number
  amountSubunits: number
  divisibility: number
}): number {
  if (input.side === 'Sell') return input.amountSubunits
  return input.amountSubunits % input.divisibility === 0
    ? quotePaymentSubunits({
        faceAmountSubunits: input.amountSubunits,
        priceNumerator: input.price,
        divisibility: input.divisibility,
      })
    : Math.ceil((input.amountSubunits * input.price) / input.divisibility)
}

async function readExactAvailableOrderCollateralRows(input: {
  mintUrl: string
  unit: string
  baseAsset: string
  proofs: readonly CashuProofRecord[]
}): Promise<StoredProofRecord[]> {
  const proofIds = input.proofs.map((proof) =>
    deriveDaemonWalletProofIdFromProof(input.mintUrl, input.unit, proof))
  const state = await readStateScope({ walletProofs: [{ proofIds }] })
  const rows = state?.wallet.proofs ?? []
  if (rows.length !== proofIds.length
    || rows.some((row) => row.state !== 'available'
      || row.mintUrl !== input.mintUrl
      || row.unit !== input.unit
      || row.asset.kind !== 'sats'
      || normalizeMarketBaseAsset(row.asset.baseAsset) !== input.baseAsset)) {
    throw new Error('exact pre-flight order collateral is unavailable')
  }
  return rows
}

async function selectOrderCollateralRows(
  input: {
    mintUrl: string
    unit: string
    conditionId: string
    outcomeId: string
    side: 'Buy' | 'Sell'
    baseAsset: string
    resolveInputFeePpkByKeyset?: WalletOpsDependencies['resolveInputFeePpkByKeyset']
  },
  amount: number,
): Promise<StoredProofRecord[]> {
  const selector = input.side === 'Buy'
    ? {
        mintUrl: input.mintUrl,
        unit: input.unit,
        state: 'available' as const,
        assetKind: 'sats' as const,
        baseAsset: input.baseAsset,
        candidateLimit: true,
      }
    : {
        mintUrl: input.mintUrl,
        unit: input.unit,
        state: 'available' as const,
        assetKind: 'Outcome' as const,
        conditionId: input.conditionId,
        outcomeSetId: input.outcomeId,
        baseAsset: input.baseAsset,
        candidateLimit: true,
      }
  const candidates = (await readStateScope({ walletProofs: [selector] }))
    ?.wallet.proofs ?? []
  return takeExactOrderCollateral(
    candidates,
    input.mintUrl,
    amount,
    input.resolveInputFeePpkByKeyset,
  )
}

async function takeExactOrderCollateral(
  candidates: StoredProofRecord[],
  mintUrl: string,
  amount: number,
  resolveInputFeePpkByKeyset?: WalletOpsDependencies['resolveInputFeePpkByKeyset'],
): Promise<StoredProofRecord[]> {
  const keysetIds = candidates.flatMap((proof) =>
    proof.proof.id ? [proof.proof.id] : [],
  )
  const fees = resolveInputFeePpkByKeyset
    ? await resolveInputFeePpkByKeyset(mintUrl, keysetIds)
    : await resolveCtfConsolidationInputFees(mintUrl, keysetIds)
  const selected = takeProofsForLock(
    candidates.map((proof) => proof.proof),
    amount,
    fees,
  )
  if (selected === null) {
    throw new Error(`insufficient exact proofs for order collateral (${amount})`)
  }
  const selectedIds = new Set(selected.map((proof) =>
    deriveDaemonWalletProofIdFromProof(mintUrl, candidates[0]?.unit, proof),
  ))
  const rows = candidates.filter((proof) => selectedIds.has(
    deriveDaemonWalletProofIdFromProof(mintUrl, proof.unit, proof.proof),
  ))
  if (rows.length > DAEMON_WALLET_PROOF_CANDIDATE_LIMIT_MAX) {
    throw new Error('order collateral proof selection exceeds the durable limit')
  }
  return rows
}

function releaseOrderCollateralBeforeSubmit(pinId: string) {
  return requireDaemonOrderCollateralCoordinator().releaseBeforeSubmit(pinId)
}

function observeOrderCollateral(input: {
  clientOrderId: string
  orderId: string
  status: string
  remainingAmount: number
  tradeIds: readonly string[]
}) {
  const coordinator = requireDaemonOrderCollateralCoordinator()
  if (input.status === 'cancelled'
    || input.status === 'failed'
    || input.status === 'expired') {
    return coordinator.releaseTerminal({
      pinId: durableOrderCollateralPinId(input.clientOrderId),
      orderId: input.orderId,
      status: input.status,
      tradeIds: input.tradeIds,
    })
  }
  return coordinator.bindOrObserve({
    pinId: durableOrderCollateralPinId(input.clientOrderId),
    orderId: input.orderId,
    status: input.status,
    remainingAmount: input.remainingAmount,
  })
}

async function loadMarketOutcomeLabels(
  client: EngineClientLike,
  conditionId: string,
): Promise<string[]> {
  if (!client.getMarket) return []
  for (let attempt = 0; attempt < 20; attempt++) {
    const market = await client.getMarket(conditionId)
    if (market && typeof market === 'object') {
      const outcomes = (market as { outcomes?: unknown }).outcomes
      if (Array.isArray(outcomes)) {
        const labels = outcomes
          .map((outcome) => {
            if (typeof outcome === 'string') return outcome
            if (outcome && typeof outcome === 'object') {
              const objectOutcome = outcome as {
                id?: unknown
                label?: unknown
                name?: unknown
              }
              for (const key of ['label', 'name', 'id'] as const) {
                const value = objectOutcome[key]
                if (typeof value === 'string' && value.trim()) return value
              }
            }
            return null
          })
          .filter((outcome): outcome is string => !!outcome)
        if (labels.length >= 2) return labels
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return []
}

async function loadMarketUnit(
  client: EngineClientLike,
  conditionId: string,
): Promise<{ baseAsset: string; divisibility: number }> {
  if (!client.getMarket) {
    return {
      baseAsset: normalizeMarketBaseAsset(undefined),
      divisibility: DEFAULT_SAT_MARKET_DIVISIBILITY,
    }
  }
  const market = await client.getMarket(conditionId)
  if (!market || typeof market !== 'object') {
    return {
      baseAsset: normalizeMarketBaseAsset(undefined),
      divisibility: DEFAULT_SAT_MARKET_DIVISIBILITY,
    }
  }
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
    ),
  }
}

async function loadOutcomeLabels(
  client: EngineClientLike,
  mintUrl: string,
  conditionId: string,
): Promise<string[]> {
  const marketLabels = await loadMarketOutcomeLabels(client, conditionId)
  if (marketLabels.length >= 2) return marketLabels
  return loadMintOutcomeLabels(mintUrl, conditionId)
}

async function loadMintOutcomeLabels(
  mintUrl: string,
  conditionId: string,
): Promise<string[]> {
  try {
    const response = await fetch(`${mintUrl.replace(/\/+$/, '')}/v1/conditions`)
    if (!response.ok) return []
    const body = (await response.json()) as {
      conditions?: Array<{
        condition_id?: unknown
        keysets?: unknown
      }>
    }
    const condition = body.conditions?.find(
      (candidate) => candidate.condition_id === conditionId,
    )
    if (!condition?.keysets || typeof condition.keysets !== 'object') return []
    const labels = new Set<string>()
    for (const collection of Object.keys(
      condition.keysets as Record<string, unknown>,
    )) {
      for (const label of collection.split('|')) {
        const trimmed = label.trim()
        if (trimmed) labels.add(trimmed)
      }
    }
    if (labels.size >= 2) return [...labels]
  } catch {
    return []
  }
  return []
}

async function wouldOrderCross(
  client: EngineClientLike,
  marketId: string,
  price: number,
): Promise<boolean> {
  const selectedBook = await client.getOrderBook(marketId)
  if ((selectedBook.asks[0]?.price ?? Number.POSITIVE_INFINITY) <= price) {
    return true
  }
  return false
}

async function commitOrderPreflightRegularTransform(input: {
  pin: DurableOrderCollateralPin
  operationId: string
  mintUrl: string
  baseAsset: string
  spent: CashuProofRecord[]
  keep: CashuProofRecord[]
  inputs: CashuProofRecord[]
}): Promise<void> {
  const asset = { kind: 'sats' as const, baseAsset: input.baseAsset }
  const unit = defaultCollateralUnit(input.baseAsset)
  await requireDaemonOrderCollateralCoordinator().commitTransform({
    pinId: input.pin.pinId,
    transformId: input.operationId,
    operationKeys: [input.operationId],
    replacementProofs: input.inputs.map((proof) => ({
      proof, mintUrl: input.mintUrl, unit, asset,
    })),
    stateScope: {
      walletProofs: walletProofMutationScope(
        input.mintUrl,
        [...input.spent, ...input.keep, ...input.inputs],
        input.baseAsset,
      ),
    },
    applyState: (state, now) => {
      removeProofsBySecretFromState(state, input.mintUrl, input.spent)
      addProofsToState(state, input.mintUrl, input.keep, 'available', asset, now)
      addProofsToState(
        state,
        input.mintUrl,
        input.inputs,
        'reserved',
        asset,
        now,
        input.pin.pinId,
      )
    },
  })
}

async function commitOrderPreflightOutcomeTransform(input: {
  pinId: string
  operationId: string
  mintUrl: string
  baseAsset: string
  conditionId: string
  spent: CashuProofRecord[]
  proofsByCollection: Record<string, CashuProofRecord[]>
}): Promise<void> {
  const unit = defaultCollateralUnit(input.baseAsset)
  const replacements = Object.entries(input.proofsByCollection).flatMap(
    ([outcomeSetId, proofs]) => proofs.map((proof) => ({
      proof,
      mintUrl: input.mintUrl,
      unit,
      asset: {
        kind: 'Outcome' as const,
        conditionId: input.conditionId,
        outcomeSetId,
        baseAsset: input.baseAsset,
      },
    })),
  )
  await requireDaemonOrderCollateralCoordinator().commitTransform({
    pinId: input.pinId,
    transformId: input.operationId,
    operationKeys: [input.operationId],
    replacementProofs: replacements,
    stateScope: {
      walletProofs: walletProofMutationScope(
        input.mintUrl,
        [...input.spent, ...replacements.map(({ proof }) => proof)],
        input.baseAsset,
      ),
    },
    applyState: (state, now) => {
      removeProofsBySecretFromState(state, input.mintUrl, input.spent)
      for (const replacement of replacements) {
        addProofsToState(
          state,
          input.mintUrl,
          [replacement.proof],
          'reserved',
          replacement.asset,
          now,
          input.pinId,
        )
      }
    },
  })
}

function addProofsToState(
  state: Awaited<ReturnType<typeof ensureState>>,
  mintUrl: string,
  proofs: CashuProofRecord[],
  proofState: 'available' | 'reserved' | 'locked',
  asset: Awaited<
    ReturnType<typeof ensureState>
  >['wallet']['proofs'][number]['asset'],
  now: string,
  reservedBy?: string,
): void {
  const unit = defaultCollateralUnit(asset.baseAsset)
  const existingSecrets = new Set(
    state.wallet.proofs
      .filter((record) => record.mintUrl === mintUrl)
      .map((record) => record.proof.secret),
  )
  for (const proof of proofs) {
    if (existingSecrets.has(proof.secret)) continue
    existingSecrets.add(proof.secret)
    state.wallet.proofs.push({
      proof: structuredClone(proof),
      mintUrl,
      unit,
      state: proofState,
      reservedBy,
      asset,
      createdAt: now,
      updatedAt: now,
    })
  }
}

function removeProofsBySecretFromState(
  state: Awaited<ReturnType<typeof ensureState>>,
  mintUrl: string,
  proofs: CashuProofRecord[],
): void {
  const secrets = new Set(proofs.map((proof) => proof.secret))
  if (secrets.size === 0) return
  state.wallet.proofs = state.wallet.proofs.filter(
    (record) => record.mintUrl !== mintUrl || !secrets.has(record.proof.secret),
  )
}

function walletProofMutationScope(
  mintUrl: string,
  proofs: readonly CashuProofRecord[],
  baseAssetInput?: string | null,
): Array<{ proofIds: string[] }> {
  const unit = defaultCollateralUnit(baseAssetInput)
  const proofIds = [
    ...new Set(
      proofs.map((proof) =>
        deriveDaemonWalletProofIdFromProof(mintUrl, unit, proof),
      ),
    ),
  ]
  return proofIds.length === 0 ? [] : [{ proofIds }]
}

export function orderBackingError(input: {
  side: 'Buy' | 'Sell'
  price: number
  amountSubunits: number
  divisibility: number
  holdings: TokenHoldings
}): string | null {
  if (input.side === 'Buy') {
    const requiredCollateral =
      input.amountSubunits % input.divisibility === 0
      ? quotePaymentSubunits({
        faceAmountSubunits: input.amountSubunits,
        priceNumerator: input.price,
        divisibility: input.divisibility,
      })
        : // TODO: move arbitrary-size quote-payment rounding into the SDK helper.
          Math.ceil((input.amountSubunits * input.price) / input.divisibility)
    if (input.holdings.baseUnitProofs >= requiredCollateral) return null
    return `insufficient backing: have ${input.holdings.baseUnitProofs} base subunits, need ${requiredCollateral}`
  }

  const backing = canBackOrder(
    {
      side: 'ask',
      sizeSubunits: input.amountSubunits,
      shareFaceSubunits: input.divisibility,
    },
    input.holdings,
    {},
    input.divisibility,
  )
  if (backing.canBack) return null
  const requiredShares = Math.ceil(input.amountSubunits / input.divisibility)
  return `insufficient backing: have ${backing.maxShares} outcome token shares, need ${requiredShares} shares`
}

function splitMarketId(
  marketId: string,
): { conditionId: string; outcomeSetId: string } | null {
  const dash = marketId.lastIndexOf('-')
  if (dash <= 0 || dash >= marketId.length - 1) return null
  return {
    conditionId: marketId.slice(0, dash),
    outcomeSetId: marketId.slice(dash + 1),
  }
}

async function startTradeRuntimeBestEffort(
  tradeRuntime: TradeRuntime | undefined,
): Promise<void> {
  if (!tradeRuntime) return
  try {
    const state = await readStateScope({ orderIds: 'all', swapIds: 'all' })
    if (!state) throw new Error('daemon SQLite state row is missing')
    await tradeRuntime.start(state)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(
      `bitcaster-daemon trade runtime start failed; RPC will remain available: ${message}\n`,
    )
  }
}

function createEngineClient(
  deps: DispatchDependencies,
  options: { baseUrl: string; nostrSecretKeyHex: string },
): EngineClientLike {
  if (deps.createEngineClient) return deps.createEngineClient(options)
  return new BitcasterEngineClient({
    baseUrl: options.baseUrl,
    authorization: ({ url, method, bodyText, payloadHash }) =>
      signNip98(
        { privateKeyHex: options.nostrSecretKeyHex },
        url,
        method,
        bodyText,
        payloadHash,
      ),
  })
}

export function createAuthenticatedBitcasterEngineClient(options: {
  baseUrl: string
  nostrSecretKeyHex: string
}): BitcasterEngineClient {
  return new BitcasterEngineClient({
    baseUrl: options.baseUrl,
    authorization: ({ url, method, bodyText, payloadHash }) =>
      signNip98(
        { privateKeyHex: options.nostrSecretKeyHex },
        url,
        method,
        bodyText,
        payloadHash,
      ),
  })
}

function createMarketOutcomes(outcomes: string[]): CreateMarketOutcome[] {
  const probability = outcomes.length > 0 ? 1 / outcomes.length : 0
  return outcomes.map((name) => ({ name, probability }))
}

async function readMarketThumbnail(
  path: string,
): Promise<MarketThumbnailBytes> {
  const bytes = await readFile(path)
  return {
    data: bytes,
    filename: basename(path),
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: DaemonResponse,
): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function isLocalCaller(address: string | undefined): boolean {
  if (!address) return true
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  )
}

function isLoopbackBindHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '::ffff:127.0.0.1'
  )
}

function defaultRpcSocketPath(): string | undefined {
  if (process.platform === 'win32') return undefined
  if (process.env.BITCASTER_DAEMON_PORT) return undefined
  return rpcSocketPath()
}

async function unlinkStaleSocket(socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath)
    socket.once('connect', () => {
      socket.destroy()
      reject(
        new Error(
          `bitcaster-daemon RPC socket is already in use: ${socketPath}`,
        ),
      )
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
