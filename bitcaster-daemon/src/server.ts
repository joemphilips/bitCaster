import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { createConnection } from 'node:net'
import { unlink } from 'node:fs/promises'
import { Amount, OutputData } from '@cashu/cashu-ts'
import {
  BitcasterEngineClient,
  EngineClientError,
  type OrderBookSnapshot,
  type OrderStatusResponse,
  type QueryMarketsParams,
  type QueryMarketsResponse,
  type SubmitOrderRequest,
  type SubmitOrderResponse,
} from '@bitcaster-market/client-sdk/engineClient'
import {
  complementOutcomeSetId,
  outcomeSetMarketId,
} from '@bitcaster-market/client-sdk/outcomeSets'
import { validateOrderIntent } from '@bitcaster-market/client-sdk/orderValidation'
import { checkOrderSettlementSupport } from '@bitcaster-market/client-sdk/settlementSupport'
import {
  CashuMintCtfSplitTransport,
  splitCompleteSetWithOperation,
  splitRootCompleteSetForPreflightOrder,
  type CtfProofOperationRecord,
  type CtfProofOperationStore,
} from '@bitcaster-market/client-sdk/ctfSplit'
import { generateOrderEphemeralKeypair } from './ephemeralKey.ts'
import { signNip98 } from './nostrAuth.ts'
import type { DaemonCommand, DaemonHealth, DaemonResponse } from './protocol.ts'
import { ensureProfileDir, normalizeEndpointUrl, readProfile, updateProfile } from './profile.ts'
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
  splitAvailableSatProofsForCtfCollateral,
  type CashuWalletLike,
} from './walletOps.ts'

export interface DaemonServerOptions {
  host?: string
  port?: number
  socketPath?: string
  tradeRuntime?: TradeRuntime
  swapExecutor?: SwapRecoveryExecutor
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
  getOrderStatus(
    marketId: string,
    orderId: string,
  ): Promise<OrderStatusResponse | null>
  cancelOrder(marketId: string, orderId: string): Promise<boolean>
  getOrderBook(marketId: string): Promise<OrderBookSnapshot>
  queryMarkets(params: QueryMarketsParams): Promise<QueryMarketsResponse>
  getMarket?(conditionId: string): Promise<unknown | null>
}

interface PreparedPreflightSplit {
  reservationId: string
  conditionId: string
  keepOutcomeSetId: string
  lockOutcomeSetId: string
  amountSats: number
}

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
    amountSats: input.amountSats,
    proofOperationStore: ctfProofOperationStore,
    makeOutputs: ({ amountSats, keyset }) =>
      OutputData.createRandomData(Amount.from(amountSats), keyset),
  })
  await updateState((state, now) => {
    removeProofsBySecretFromState(state, input.mintUrl, [
      ...collateral.spent,
      ...collateral.inputs,
    ])
    addProofsToState(state, input.mintUrl, collateral.keep, 'available', { kind: 'sats' }, now)
    for (const [outcomeSetId, proofs] of Object.entries(proofsByCollection)) {
      addProofsToState(
        state,
        input.mintUrl,
        proofs,
        'available',
        { kind: 'outcome', conditionId: input.conditionId, outcomeSetId },
        now,
      )
    }
  })
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

export interface DispatchDependencies {
  createEngineClient?: (options: {
    baseUrl: string
    nostrSecretKeyHex: string
  }) => EngineClientLike
  generateEphemeralKeypair?: typeof generateOrderEphemeralKeypair
  createCashuWallet?: (mintUrl: string) => CashuWalletLike
  tradeRuntime?: TradeRuntime
  swapExecutor?: SwapRecoveryExecutor
}

const ctfProofOperationStore: CtfProofOperationStore = {
  getProofOperation: async (operationId) =>
    (await getProofOperation(operationId)) as CtfProofOperationRecord | null,
  prepareProofOperation: async (input) =>
    (await prepareProofOperation(input)) as CtfProofOperationRecord,
  markProofOperationCompleted: async (operationId, resultProofs) =>
    (await markProofOperationCompleted(
      operationId,
      resultProofs,
    )) as CtfProofOperationRecord,
}

export async function startDaemonServer(
  options: DaemonServerOptions = {},
): Promise<Server> {
  if (options.tradeRuntime && (await readProfile())) {
    await startTradeRuntimeBestEffort(options.tradeRuntime)
  }
  const server = createServer((req, res) => {
    void handleRequest(req, res, {
      tradeRuntime: options.tradeRuntime,
      swapExecutor: options.swapExecutor,
    })
  })
  const socketPath =
    options.socketPath ?? (options.host || options.port ? undefined : defaultRpcSocketPath())
  if (socketPath) {
    await ensureProfileDir()
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
  const boundPort =
    typeof address === 'object' && address ? address.port : port
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
  if (
    expectedToken &&
    !tokenMatches(bearerToken(req.headers.authorization), expectedToken)
  ) {
    return writeJson(res, 401, { ok: false, error: 'unauthorized' })
  }
  if (!expectedToken && command.method !== 'health') {
    return writeJson(res, 401, { ok: false, error: 'daemon RPC token is not initialized' })
  }

  try {
    return writeJson(res, 200, await dispatch(command, deps))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return writeJson(res, 500, { ok: false, error: message })
  }
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
        ...(command.params.engineUrl !== undefined
          ? { engineBaseUrl: nextEngineBaseUrl }
          : {}),
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
          : (
              await client.queryMarkets({
                ids: [command.params.conditionId],
                state: 'All',
                limit: 1,
              })
            ).markets[0] ?? null
      return {
        ok: true,
        result: market,
      }
    }
    case 'order.submit': {
      const requestValidation = validateOrderIntent(command.params)
      if (!requestValidation.valid) {
        return { ok: false, error: requestValidation.message }
      }
      const profile = await readProfile()
      if (!profile) {
        return { ok: false, error: 'daemon profile is not initialized' }
      }
      const secrets = await readSecrets()
      if (!secrets) {
        return { ok: false, error: 'daemon secrets are not initialized' }
      }
      const settlementSupport = checkOrderSettlementSupport({
        request: { side: command.params.side },
      })
      if (!settlementSupport.supported) {
        return { ok: false, error: settlementSupport.message }
      }
      const ephemeral =
        deps.generateEphemeralKeypair?.() ?? generateOrderEphemeralKeypair()
      const client = createEngineClient(deps, {
        baseUrl: profile.engineBaseUrl,
        nostrSecretKeyHex: secrets.nostrSecretKeyHex,
      })
      const preparedPreflight = await maybePreparePreflightSplitForOrder({
        client,
        mintUrl: profile.mintUrl,
        marketId: command.params.marketId,
        outcomeId: command.params.outcomeId,
        side: command.params.side,
        price: command.params.price,
        amountSats: command.params.amountSats,
        timeInForce: command.params.timeInForce,
        preflightSplit: command.params.preflightSplit,
        ephemeralPubkey: ephemeral.publicKeyHex,
      })
      let submitted: SubmitOrderResponse
      try {
        submitted = await client.submitOrder(command.params.marketId, {
          outcomeId: command.params.outcomeId,
          side: command.params.side,
          price: command.params.price,
          amountSats: command.params.amountSats,
          timeInForce: command.params.timeInForce,
          ephemeralPubkey: ephemeral.publicKeyHex,
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
        command.params.marketId,
        ephemeral.publicKeyHex,
        submitted,
        preparedPreflight,
      )
      await updateSecrets((current, now) => {
        current.orderEphemeralKeys[submitted.orderId] = {
          orderId: submitted.orderId,
          marketId: command.params.marketId,
          privateKeyHex: ephemeral.privateKeyHex,
          publicKeyHex: ephemeral.publicKeyHex,
          createdAt: now,
        }
      })
      await startTradeRuntimeBestEffort(deps.tradeRuntime)
      return {
        ok: true,
        result: { engine: submitted, local },
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

async function maybePreparePreflightSplitForOrder(input: {
  client: EngineClientLike
  mintUrl: string
  marketId: string
  outcomeId: string
  side: 'Buy' | 'Sell'
  price: number
  amountSats: number
  timeInForce: 'FAK' | 'FOK' | 'GTC'
  preflightSplit?: boolean
  ephemeralPubkey: string
}): Promise<PreparedPreflightSplit | null> {
  if (input.preflightSplit !== true) return null
  if (input.side !== 'Buy' || input.timeInForce !== 'GTC') return null

  const market = splitMarketId(input.marketId)
  if (!market) {
    throw new Error(`cannot pre-flight split invalid market id ${input.marketId}`)
  }
  if (input.outcomeId !== market.outcomeSetId) {
    throw new Error(
      'pre-flight split requires outcomeId to match the submitted outcome-set market id',
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
    throw new Error('pre-flight split could not resolve a complementary outcome set')
  }
  if (await wouldOrderCross(input.client, input.marketId, complement, input.price)) {
    return null
  }

  const reservationId = `order-preflight:${input.ephemeralPubkey}`
  let resolvedKeepOutcomeSetId = market.outcomeSetId
  let resolvedLockOutcomeSetId = complement
  try {
    for (let offset = 0; offset < input.amountSats; offset += 100) {
      const secrets = await readSecrets()
      if (!secrets) throw new Error('daemon secrets are not initialized')
      const collateral = await splitAvailableSatProofsForCtfCollateral(
        100,
        input.mintUrl,
        `${reservationId}:regular-split:${offset / 100}`,
        secrets,
      )
      if (collateral.spent.length > 0) {
        await replaceAvailableSatProofsWithPreparedCollateral({
          mintUrl: input.mintUrl,
          spentSecrets: collateral.spent.map((proof) => proof.secret),
          keepProofs: collateral.keep,
          inputProofs: collateral.inputs,
          reservationId,
        })
      } else {
        await reserveSelectedSatProofs(
          input.mintUrl,
          collateral.inputs,
          reservationId,
        )
      }
      const split = await splitRootCompleteSetForPreflightOrder({
        mintUrl: input.mintUrl,
        conditionId: market.conditionId,
        collateralProofs: collateral.inputs,
        amountSats: 100,
        keepOutcomeSetId: market.outcomeSetId,
        lockOutcomeSetId: complement,
        operationId: `${reservationId}:ctf-split:${offset / 100}`,
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
      })
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
    amountSats: input.amountSats,
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
        partitions?: unknown
      }>
    }
    const condition = body.conditions?.find(
      (candidate) => candidate.condition_id === conditionId,
    )
    const partitions = Array.isArray(condition?.partitions)
      ? condition.partitions
      : []
    for (const partition of partitions) {
      if (!partition || typeof partition !== 'object') continue
      const rawLabels = (partition as { partition?: unknown }).partition
      if (!Array.isArray(rawLabels)) continue
      const labels = rawLabels.filter(
        (label): label is string => typeof label === 'string' && !!label.trim(),
      )
      if (labels.length >= 2) return labels
    }
  } catch {
    return []
  }
  return []
}

async function wouldOrderCross(
  client: EngineClientLike,
  marketId: string,
  complementOutcomeSetId: string,
  price: number,
): Promise<boolean> {
  const market = splitMarketId(marketId)
  if (!market) return false
  const selectedBook = await client.getOrderBook(marketId)
  if ((selectedBook.asks[0]?.price ?? Number.POSITIVE_INFINITY) <= price) {
    return true
  }
  const complementBook = await client.getOrderBook(
    outcomeSetMarketId(market.conditionId, complementOutcomeSetId),
  )
  return (complementBook.bids[0]?.price ?? Number.NEGATIVE_INFINITY) + price >= 100
}

async function reserveSelectedSatProofs(
  mintUrl: string,
  proofs: CashuProofRecord[],
  reservedBy: string,
): Promise<void> {
  const secrets = new Set(proofs.map((proof) => proof.secret))
  await updateState((state, now) => {
    let reserved = 0
    for (const record of state.wallet.proofs) {
      if (
        record.mintUrl !== mintUrl ||
        record.state !== 'available' ||
        record.asset.kind !== 'sats' ||
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
}): Promise<void> {
  const spent = new Set(input.spentSecrets)
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
        asset: { kind: 'sats' },
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
        asset: { kind: 'sats' },
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
}): Promise<void> {
  const spent = new Set(input.spentSecrets)
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
            kind: 'outcome',
            conditionId: input.conditionId,
            outcomeSetId,
          },
          createdAt: now,
          updatedAt: now,
        })
      }
    }
  })
}

function splitMarketId(
  marketId: string,
): { conditionId: string; outcomeSetId: string } | null {
  const dash = marketId.indexOf('-')
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

async function startTradeRuntimeBestEffort(
  tradeRuntime: TradeRuntime | undefined,
): Promise<void> {
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
    authorization: ({ url, method, bodyText }) =>
      signNip98(
        { privateKeyHex: options.nostrSecretKeyHex },
        url,
        method,
        bodyText,
      ),
  })
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
