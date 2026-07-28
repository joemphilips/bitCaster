import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
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
import { complementOutcomeSetId } from '@bitcaster-market/client-sdk/outcomeSets'
import {
  validateOrderIntent,
  validateOrderRoutingIdentity,
} from '@bitcaster-market/client-sdk/orderValidation'
import { checkOrderSettlementSupport } from '@bitcaster-market/client-sdk/settlementSupport'
import {
  COLLATERAL_COLLECTION,
  planCtfConsolidation,
  type CtfConsolidationStrategy,
} from '@bitcaster-market/client-sdk/ctfConsolidation'
import {
  CashuMintCtfSplitTransport,
  resolveRootPreflightOutputAmountSubunits,
  splitCompleteSetWithOperation,
  splitRootCompleteSetForPreflightOrder,
  type CtfProofOperationRecord,
  type CtfProofOperationStore,
} from '@bitcaster-market/client-sdk/ctfSplit'
import { prepareSwapInputsForTrade } from '@bitcaster-market/client-sdk/tradePreparation'
import {
  normalizeMarketBaseAsset,
  normalizeMarketDivisibility,
  quotePaymentSubunits,
  type MarketBaseAsset,
} from '@bitcaster-market/client-sdk/marketUnits'
import { canBackOrder, type TokenHoldings } from '@bitcaster-market/client-sdk/tradingClient'
import { generateOrderEphemeralKeypair } from './ephemeralKey.ts'
import { signNip98 } from './nostrAuth.ts'
import type { DaemonCommand, DaemonHealth, DaemonResponse } from './protocol.ts'
import { normalizeEndpointUrl, readProfile, updateProfile } from './profile.ts'
import { bearerToken, readRpcToken, rpcSocketPath, tokenMatches } from './rpcAuth.ts'
import { readSecrets, updateSecrets } from './secrets.ts'
import {
  ensureState,
  getProofOperation,
  listProofOperations,
  listLocalOrders,
  listLocalSwaps,
  markProofOperationCompleted,
  prepareProofOperation,
  readState,
  recordSubmittedOrder,
  recordOrderStatus,
  releaseProofReservation,
  summarizeWalletBalance,
  updateState,
  type CashuProofRecord,
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
} from './walletOps.ts'
import { buildDaemonTokenHoldings } from './walletHoldings.ts'
import type { WalletSeedRecoveryParams, WalletSeedRecoveryResult } from './protocol.ts'

export interface DaemonServerOptions {
  host?: string
  port?: number
  socketPath?: string
  tradeRuntime?: TradeRuntime
  swapExecutor?: SwapRecoveryExecutor
  recoverWalletFromSeed?: (input: WalletSeedRecoveryParams) => Promise<WalletSeedRecoveryResult>
}

export interface SwapRecoveryExecutor {
  resumeActiveSwaps(
    state: Awaited<ReturnType<typeof ensureState>>,
  ): Promise<{ activeSwaps: number }>
}

export interface EngineClientLike {
  submitOrder(marketId: string, request: SubmitOrderRequest): Promise<SubmitOrderResponse>
  submitEphemeralPubkey?(tradeId: string, pubkey: string, conditionId?: string): Promise<unknown>
  getOrderStatus(marketId: string, orderId: string): Promise<OrderStatusResponse | null>
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
  amountSubunits: number
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
  const collateral = await splitAvailableSatProofsForCtfCollateral(
    input.amountSats,
    input.mintUrl,
    `${input.operationId}:regular-split`,
    input.secrets,
  )
  const transport = new CashuMintCtfSplitTransport(input.mintUrl)
  const outcomeCollectionKeysets = await transport.getRootPartitionKeysets(input.conditionId)
  const proofsByCollection = await splitCompleteSetWithOperation({
    mintUrl: input.mintUrl,
    baseAsset: 'sat',
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
  await updateState((state, now) => {
    removeProofsBySecretFromState(state, input.mintUrl, [...collateral.spent, ...collateral.inputs])
    addProofsToState(
      state,
      input.mintUrl,
      collateral.keep,
      'available',
      { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
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
          unit: 'msat',
        },
        now,
      )
    }
  })
  return {
    operationId: input.operationId,
    conditionId: input.conditionId,
    amountSats: input.amountSats,
    outcomeProofCounts: Object.fromEntries(
      Object.entries(proofsByCollection).map(([outcome, proofs]) => [outcome, proofs.length]),
    ),
  }
}

export interface DispatchDependencies extends WalletOpsDependencies {
  createEngineClient?: (options: { baseUrl: string; nostrSecretKeyHex: string }) => EngineClientLike
  generateEphemeralKeypair?: typeof generateOrderEphemeralKeypair
  tradeRuntime?: TradeRuntime
  swapExecutor?: SwapRecoveryExecutor
  recoverWalletFromSeed?: (input: WalletSeedRecoveryParams) => Promise<WalletSeedRecoveryResult>
}

const ctfProofOperationStore: CtfProofOperationStore = {
  getProofOperation: async (operationId) =>
    (await getProofOperation(operationId)) as CtfProofOperationRecord | null,
  prepareProofOperation: async (input) =>
    (await prepareProofOperation(input)) as CtfProofOperationRecord,
  markProofOperationCompleted: async (operationId, completion) =>
    (await markProofOperationCompleted(operationId, completion)) as CtfProofOperationRecord,
}

export async function startDaemonServer(options: DaemonServerOptions = {}): Promise<Server> {
  if (options.tradeRuntime && (await readProfile())) {
    await startTradeRuntimeBestEffort(options.tradeRuntime)
  }
  const server = createServer((req, res) => {
    void handleRequest(req, res, {
      tradeRuntime: options.tradeRuntime,
      swapExecutor: options.swapExecutor,
      recoverWalletFromSeed: options.recoverWalletFromSeed,
    })
  })
  const socketPath =
    options.socketPath ?? (options.host || options.port ? undefined : defaultRpcSocketPath())
  if (socketPath) {
    await unlinkStaleSocket(socketPath)
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    server.once('close', () => {
      void unlink(socketPath).catch(() => undefined)
    })
    process.stdout.write(`bitcaster-daemon listening on unix://${socketPath}\n`)
    return server
  }

  const host = options.host ?? '127.0.0.1'
  if (!isLoopbackBindHost(host)) {
    throw new Error(`bitcaster-daemon refuses to bind non-loopback host ${host}`)
  }
  const port = options.port ?? Number(process.env.BITCASTER_DAEMON_PORT || 42871)
  await new Promise<void>((resolve) => server.listen(port, host, resolve))
  const address = server.address()
  const boundPort = typeof address === 'object' && address ? address.port : port
  process.stdout.write(`bitcaster-daemon listening on http://${host}:${boundPort}\n`)
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
  if (expectedToken && !tokenMatches(bearerToken(req.headers.authorization), expectedToken)) {
    return writeJson(res, 401, { ok: false, error: 'unauthorized' })
  }
  if (!expectedToken && command.method !== 'health') {
    return writeJson(res, 401, { ok: false, error: 'daemon RPC token is not initialized' })
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

  const status = 'status' in err && typeof err.status === 'number' ? err.status : undefined
  const cause = 'cause' in err && err.cause instanceof Error ? err.cause.message : undefined
  const detail = [err.message, status ? `status=${status}` : null, cause].filter(Boolean).join('; ')
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
      const state = await ensureState()
      return {
        ok: true,
        result: {
          profile,
          counts: {
            proofs: state.wallet.proofs.length,
            proofOperations: Object.keys(state.proofOperations).length,
            orders: Object.keys(state.orders).length,
            swaps: Object.keys(state.swaps).length,
          },
          wallet: summarizeWalletBalance(state),
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
      const state = await ensureState()
      if (
        !daemonStateIsEmpty(state) &&
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
        ...(command.params.engineUrl !== undefined ? { engineBaseUrl: nextEngineBaseUrl } : {}),
        ...(command.params.mintUrl !== undefined ? { mintUrl: nextMintUrl } : {}),
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
          baseAsset: 'sat',
          title: command.params.title,
          description: command.params.description,
          outcomes: createMarketOutcomes(command.params.outcomes),
          ...(command.params.liquiditySats !== undefined
            ? { liquiditySats: command.params.liquiditySats }
            : {}),
          ...(command.params.tags !== undefined ? { categoryTags: command.params.tags } : {}),
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
      return {
        ok: true,
        result: summarizeWalletBalance(await ensureState()),
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
    case 'wallet.seedRecovery': {
      const profile = await readProfile()
      if (!profile) {
        return { ok: false, error: 'daemon profile is not initialized' }
      }
      if (command.params.disclosureAcknowledged !== true) {
        return {
          ok: false,
          error: 'seed recovery requires explicit disclosure acknowledgement',
        }
      }
      if (command.params.mintUrl !== profile.mintUrl) {
        return { ok: false, error: 'seed recovery mint does not match the profile' }
      }
      if (!deps.recoverWalletFromSeed) {
        return { ok: false, error: 'seed recovery is unavailable in this daemon runtime' }
      }
      return {
        ok: true,
        result: await deps.recoverWalletFromSeed(command.params),
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
      const amountSubunits = orderParams.amountSubunits
      const orderIntent = {
        ...orderParams,
        amountSubunits,
      }
      const shapeValidation = validateOrderRoutingIdentity(orderIntent)
      if (!shapeValidation.valid) {
        return { ok: false, error: shapeValidation.message }
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

      const context = await ensureOrderContext()
      if (!context.ok) return context
      const conditionId = conditionIdFromMarketId(orderParams.marketId)
      const marketUnit = await loadMarketUnit(context.client, conditionId)
      const requestValidation = validateOrderIntent({
        ...orderIntent,
        baseAsset: marketUnit.baseAsset,
        divisibility: marketUnit.divisibility,
      })
      if (!requestValidation.valid) {
        return { ok: false, error: requestValidation.message }
      }
      const settlementSupport = checkOrderSettlementSupport({
        request: { side: orderParams.side },
      })
      if (!settlementSupport.supported) {
        return { ok: false, error: settlementSupport.message }
      }
      const currentState = await ensureState()
      const holdings = buildDaemonTokenHoldings(currentState, {
        mintUrl: context.profile.mintUrl,
        conditionId,
        baseAsset: marketUnit.baseAsset,
      })
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
      const preparedPreflight = await maybePreparePreflightSplitForOrder({
        client: context.client,
        mintUrl: context.profile.mintUrl,
        marketId: orderParams.marketId,
        outcomeId: orderParams.outcomeId,
        side: orderParams.side,
        tokenSide: orderParams.tokenSide,
        price: orderParams.price,
        amountSubunits,
        timeInForce: orderParams.timeInForce,
        preflightSplit: orderParams.preflightSplit,
        clientOrderId,
      })
      let participationScore: DaemonParticipationScorePreflightResult
      try {
        participationScore = await ensureDaemonParticipationScoreForNextMatch({
          client: context.client,
          profile: context.profile,
          secrets: context.secrets,
          deps,
        })
      } catch (err) {
        if (preparedPreflight) {
          await releaseProofReservation(preparedPreflight.reservationId)
        }
        throw err
      }
      let submitted: SubmitOrderResponse
      try {
        submitted = await context.client.submitOrder(orderParams.marketId, {
          outcomeId: orderParams.outcomeId,
          tokenSide: orderParams.tokenSide,
          side: orderParams.side,
          price: orderParams.price,
          amountSubunits,
          timeInForce: orderParams.timeInForce,
          clientOrderId,
        })
      } catch (err) {
        if (preparedPreflight) {
          await releaseProofReservation(preparedPreflight.reservationId)
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
      const local = await recordSubmittedOrder(
        orderParams.marketId,
        clientOrderId,
        submitted,
        preparedPreflight,
        orderParams.tokenSide,
        orderParams.side,
        orderParams.price,
        amountSubunits,
        marketUnit.baseAsset,
        marketUnit.divisibility,
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
      const state = await readState()
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
      if (!deps.swapExecutor) {
        return { ok: false, error: 'daemon swap executor is not available' }
      }
      await startTradeRuntimeBestEffort(deps.tradeRuntime)
      return {
        ok: true,
        result: await deps.swapExecutor.resumeActiveSwaps(await ensureState()),
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
      return await client.payParticipationScoreEcash(amountSats, token, paymentId)
    } catch (err) {
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Failed to pay Engine Score.')
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

function conditionIdFromMarketId(marketId: string): string {
  const parsed = splitMarketId(marketId)
  return parsed?.conditionId ?? marketId
}

async function submitPendingEphemeralPubkeys(input: {
  client: EngineClientLike
  marketId: string
  conditionId?: string
  orderId: string
  pendingPubkeySubmissions?: SubmitOrderResponse['pendingPubkeySubmissions']
  generateEphemeralKeypair?: typeof generateOrderEphemeralKeypair
}): Promise<void> {
  for (const submission of input.pendingPubkeySubmissions ?? []) {
    if (!input.client.submitEphemeralPubkey) {
      throw new Error('engine client does not support ephemeral pubkey submission')
    }
    const existing = (await readSecrets())?.orderEphemeralKeys[submission.tradeId]
    const ephemeral = existing
      ? {
          privateKeyHex: existing.privateKeyHex,
          publicKeyHex: existing.publicKeyHex,
        }
      : (input.generateEphemeralKeypair?.() ?? generateOrderEphemeralKeypair())
    if (!existing) {
      await updateSecrets((current, now) => {
        current.orderEphemeralKeys[submission.tradeId] = {
          orderId: input.orderId,
          tradeId: submission.tradeId,
          marketId: input.marketId,
          privateKeyHex: ephemeral.privateKeyHex,
          publicKeyHex: ephemeral.publicKeyHex,
          createdAt: now,
        }
      })
    }
    await input.client.submitEphemeralPubkey(
      submission.tradeId,
      ephemeral.publicKeyHex,
      input.conditionId,
    )
  }
}

async function maybePreparePreflightSplitForOrder(input: {
  client: EngineClientLike
  mintUrl: string
  marketId: string
  outcomeId: string
  side: 'Buy' | 'Sell'
  tokenSide: 'Outcome' | 'Complement'
  price: number
  amountSubunits: number
  timeInForce: 'FAK' | 'FOK' | 'GTC'
  preflightSplit?: boolean
  clientOrderId: string
}): Promise<PreparedPreflightSplit | null> {
  if (input.preflightSplit !== true) return null
  if (input.side !== 'Buy' || input.timeInForce !== 'GTC') return null

  const market = splitMarketId(input.marketId)
  if (!market) {
    throw new Error(`cannot pre-flight split invalid market id ${input.marketId}`)
  }
  if (input.outcomeId !== market.outcomeSetId) {
    throw new Error(
      'pre-flight split requires outcomeId to match the submitted primitive market id',
    )
  }
  const outcomeLabels = await loadOutcomeLabels(input.client, input.mintUrl, market.conditionId)
  if (outcomeLabels.length < 2) {
    throw new Error('pre-flight split requires market outcome labels')
  }
  const complement = complementOutcomeSetId(outcomeLabels, market.outcomeSetId)
  if (!complement) {
    throw new Error('pre-flight split could not resolve a complementary outcome set')
  }
  if (await wouldOrderCross(input.client, input.marketId, input.price)) {
    return null
  }
  const marketUnit = await loadMarketUnit(input.client, market.conditionId)

  const reservationId = `order-preflight:${input.clientOrderId}`
  const keepOutcomeSetId = input.tokenSide === 'Complement' ? complement : market.outcomeSetId
  const lockOutcomeSetId = input.tokenSide === 'Complement' ? market.outcomeSetId : complement
  let resolvedKeepOutcomeSetId = keepOutcomeSetId
  let resolvedLockOutcomeSetId = lockOutcomeSetId
  try {
    const prepared = await prepareSwapInputsForTrade({
      role: 'seller',
      lockOutcomeSetId,
      amountSats: input.amountSubunits,
      outcomeProofsByCollection: {},
      regularProofs: [],
      splitRegularToOutcome: async () => {
        const preflightOutputAmountSubunits = await resolveRootPreflightOutputAmountSubunits({
          mintUrl: input.mintUrl,
          baseAsset: marketUnit.baseAsset,
          conditionId: market.conditionId,
          amountSubunits: input.amountSubunits,
          keepOutcomeSetId,
          lockOutcomeSetId,
        })
        const secrets = await readSecrets()
        if (!secrets) throw new Error('daemon secrets are not initialized')
        const collateral = await splitAvailableSatProofsForCtfCollateral(
          preflightOutputAmountSubunits,
          input.mintUrl,
          `${reservationId}:regular-split:0`,
          secrets,
          {},
          marketUnit.baseAsset,
        )
        if (collateral.spent.length > 0) {
          await replaceAvailableSatProofsWithPreparedCollateral({
            mintUrl: input.mintUrl,
            spentSecrets: collateral.spent.map((proof) => proof.secret),
            keepProofs: collateral.keep,
            inputProofs: collateral.inputs,
            reservationId,
            baseAsset: marketUnit.baseAsset,
          })
        } else {
          await reserveSelectedSatProofs(
            input.mintUrl,
            collateral.inputs,
            reservationId,
            marketUnit.baseAsset,
          )
        }
        const split = await splitRootCompleteSetForPreflightOrder({
          mintUrl: input.mintUrl,
          baseAsset: marketUnit.baseAsset,
          conditionId: market.conditionId,
          collateralProofs: collateral.inputs,
          amountSubunits: preflightOutputAmountSubunits,
          keepOutcomeSetId,
          lockOutcomeSetId,
          operationId: `${reservationId}:ctf-split:0`,
          proofOperationStore: ctfProofOperationStore,
        })
        resolvedKeepOutcomeSetId = split.resolvedKeepOutcomeSetId
        resolvedLockOutcomeSetId = split.resolvedLockOutcomeSetId
        await replaceReservedSatProofsWithReservedOutcomes({
          mintUrl: input.mintUrl,
          reservationId,
          spentSecrets: split.spentSatProofs.map((proof) => proof.secret),
          conditionId: market.conditionId,
          proofsByCollection: split.proofsByCollection,
          baseAsset: marketUnit.baseAsset,
        })
        return {
          proofsByCollection: split.proofsByCollection,
          spentRegularProofs: [],
          regularChangeProofs: [],
        }
      },
    })
    if (prepared.status !== 'prepared') {
      throw new Error(`pre-flight split unavailable: ${prepared.reason}`)
    }
  } catch (err) {
    await releaseProofReservation(reservationId)
    throw err
  }

  return {
    reservationId,
    conditionId: market.conditionId,
    keepOutcomeSetId: resolvedKeepOutcomeSetId,
    lockOutcomeSetId: resolvedLockOutcomeSetId,
    amountSubunits: input.amountSubunits,
  }
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

async function loadOutcomeLabels(
  client: EngineClientLike,
  mintUrl: string,
  conditionId: string,
): Promise<string[]> {
  const marketLabels = await loadMarketOutcomeLabels(client, conditionId)
  if (marketLabels.length >= 2) return marketLabels
  return loadMintOutcomeLabels(mintUrl, conditionId)
}

async function loadMintOutcomeLabels(mintUrl: string, conditionId: string): Promise<string[]> {
  try {
    const response = await fetch(`${mintUrl.replace(/\/+$/, '')}/v1/conditions`)
    if (!response.ok) return []
    const body = (await response.json()) as {
      conditions?: Array<{
        condition_id?: unknown
        keysets?: unknown
      }>
    }
    const condition = body.conditions?.find((candidate) => candidate.condition_id === conditionId)
    if (!condition?.keysets || typeof condition.keysets !== 'object') return []
    const labels = new Set<string>()
    for (const collection of Object.keys(condition.keysets as Record<string, unknown>)) {
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

async function reserveSelectedSatProofs(
  mintUrl: string,
  proofs: CashuProofRecord[],
  reservedBy: string,
  baseAssetInput?: string | null,
): Promise<void> {
  const baseAsset = normalizeMarketBaseAsset(baseAssetInput)
  const secrets = new Set(proofs.map((proof) => proof.secret))
  await updateState((state, now) => {
    let reserved = 0
    for (const record of state.wallet.proofs) {
      if (
        record.mintUrl !== mintUrl ||
        record.state !== 'available' ||
        record.asset.kind !== 'sats' ||
        normalizeMarketBaseAsset(record.asset.baseAsset) !== baseAsset ||
        !secrets.has(record.proof.secret)
      ) {
        continue
      }
      record.state = 'reserved'
      record.reservedBy = reservedBy
      record.updatedAt = now
      reserved += 1
    }
    if (reserved !== secrets.size) {
      throw new Error('pre-flight split collateral was no longer available')
    }
  })
}

function addProofsToState(
  state: Awaited<ReturnType<typeof ensureState>>,
  mintUrl: string,
  proofs: CashuProofRecord[],
  proofState: 'available' | 'reserved' | 'locked',
  asset: Awaited<ReturnType<typeof ensureState>>['wallet']['proofs'][number]['asset'],
  now: string,
  reservedBy?: string,
): void {
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

async function replaceAvailableSatProofsWithPreparedCollateral(input: {
  mintUrl: string
  spentSecrets: string[]
  keepProofs: CashuProofRecord[]
  inputProofs: CashuProofRecord[]
  reservationId: string
  baseAsset: MarketBaseAsset
}): Promise<void> {
  const spent = new Set(input.spentSecrets)
  const baseAsset = normalizeMarketBaseAsset(input.baseAsset)
  await updateState((state, now) => {
    state.wallet.proofs = state.wallet.proofs.filter(
      (record) => record.mintUrl !== input.mintUrl || !spent.has(record.proof.secret),
    )
    const existingSecrets = new Set(
      state.wallet.proofs
        .filter((record) => record.mintUrl === input.mintUrl)
        .map((record) => record.proof.secret),
    )
    for (const proof of input.keepProofs) {
      if (existingSecrets.has(proof.secret)) continue
      existingSecrets.add(proof.secret)
      state.wallet.proofs.push({
        proof: structuredClone(proof),
        mintUrl: input.mintUrl,
        state: 'available',
        asset: { kind: 'sats', baseAsset, unit: 'msat' },
        createdAt: now,
        updatedAt: now,
      })
    }
    for (const proof of input.inputProofs) {
      if (existingSecrets.has(proof.secret)) continue
      existingSecrets.add(proof.secret)
      state.wallet.proofs.push({
        proof: structuredClone(proof),
        mintUrl: input.mintUrl,
        state: 'reserved',
        reservedBy: input.reservationId,
        asset: { kind: 'sats', baseAsset, unit: 'msat' },
        createdAt: now,
        updatedAt: now,
      })
    }
  })
}

async function replaceReservedSatProofsWithReservedOutcomes(input: {
  mintUrl: string
  reservationId: string
  spentSecrets: string[]
  conditionId: string
  proofsByCollection: Record<string, CashuProofRecord[]>
  baseAsset: MarketBaseAsset
}): Promise<void> {
  const spent = new Set(input.spentSecrets)
  const baseAsset = normalizeMarketBaseAsset(input.baseAsset)
  await updateState((state, now) => {
    state.wallet.proofs = state.wallet.proofs.filter(
      (record) =>
        record.mintUrl !== input.mintUrl ||
        record.reservedBy !== input.reservationId ||
        !spent.has(record.proof.secret),
    )
    const existingSecrets = new Set(
      state.wallet.proofs
        .filter((record) => record.mintUrl === input.mintUrl)
        .map((record) => record.proof.secret),
    )
    for (const [outcomeSetId, proofs] of Object.entries(input.proofsByCollection)) {
      for (const proof of proofs) {
        if (existingSecrets.has(proof.secret)) continue
        existingSecrets.add(proof.secret)
        state.wallet.proofs.push({
          proof: structuredClone(proof),
          mintUrl: input.mintUrl,
          state: 'reserved',
          reservedBy: input.reservationId,
          asset: {
            kind: 'Outcome',
            conditionId: input.conditionId,
            outcomeSetId,
            baseAsset,
            unit: 'msat',
          },
          createdAt: now,
          updatedAt: now,
        })
      }
    }
  })
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

function splitMarketId(marketId: string): { conditionId: string; outcomeSetId: string } | null {
  const dash = marketId.lastIndexOf('-')
  if (dash <= 0 || dash >= marketId.length - 1) return null
  return {
    conditionId: marketId.slice(0, dash),
    outcomeSetId: marketId.slice(dash + 1),
  }
}

function daemonStateIsEmpty(state: Awaited<ReturnType<typeof ensureState>>): boolean {
  return (
    state.wallet.proofs.length === 0 &&
    Object.keys(state.wallet.keysetCounters).length === 0 &&
    Object.keys(state.proofOperations).length === 0 &&
    Object.keys(state.orders).length === 0 &&
    Object.keys(state.swaps).length === 0
  )
}

async function startTradeRuntimeBestEffort(tradeRuntime: TradeRuntime | undefined): Promise<void> {
  if (!tradeRuntime) return
  try {
    await tradeRuntime.start(await ensureState())
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
      signNip98({ privateKeyHex: options.nostrSecretKeyHex }, url, method, bodyText, payloadHash),
  })
}

function createAuthenticatedBitcasterEngineClient(options: {
  baseUrl: string
  nostrSecretKeyHex: string
}): BitcasterEngineClient {
  return new BitcasterEngineClient({
    baseUrl: options.baseUrl,
    authorization: ({ url, method, bodyText, payloadHash }) =>
      signNip98({ privateKeyHex: options.nostrSecretKeyHex }, url, method, bodyText, payloadHash),
  })
}

function createMarketOutcomes(outcomes: string[]): CreateMarketOutcome[] {
  const probability = outcomes.length > 0 ? 1 / outcomes.length : 0
  return outcomes.map((name) => ({ name, probability }))
}

async function readMarketThumbnail(path: string): Promise<MarketThumbnailBytes> {
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
  if (process.env.BITCASTER_DAEMON_PORT) return undefined
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
