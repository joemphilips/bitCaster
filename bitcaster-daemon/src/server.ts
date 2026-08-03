import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { chmod, readFile, unlink } from 'node:fs/promises'
import { basename } from 'node:path'
import { Amount, OutputData, type Proof } from '@cashu/cashu-ts'
import {
  BitcasterEngineClient,
  EngineClientError,
  isDefinitiveOrderSubmissionError,
  type OrderBookSnapshot,
  type OrderStatusResponse,
  type ParticipationScoreResponse,
  type PayParticipationScoreEcashResponse,
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
import {
  createMarketViaEngine,
  conditionIdFromMarketId,
  isKind89NostrEvent,
  parseMarketOutcomes,
  validateMarketCreateEngineUrl,
  submitOracleAttestationViaEngine,
  type CreateMarketOutcome,
  type MarketThumbnailBytes,
} from '@bitcaster-market/client-sdk'
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
  COLLATERAL_COLLECTION,
  planCtfConsolidation,
  type CtfConsolidationStrategy,
} from '@bitcaster-market/client-sdk/ctfConsolidation'
import {
  CashuMintCtfSplitTransport,
  splitCompleteSetWithOperation,
  type CtfProofOperationRecord,
  type CtfProofOperationStore,
} from '@bitcaster-market/client-sdk/ctfSplit'
import {
  normalizeMarketBaseAsset,
  normalizeMarketDivisibility,
  quotePaymentSubunits,
  type MarketBaseAsset,
} from '@bitcaster-market/client-sdk/marketUnits'
import { canBackOrder, type TokenHoldings } from '@bitcaster-market/client-sdk/tradingClient'
import { signNip98 } from './nostrAuth.ts'
import type { DaemonCommand, DaemonHealth, DaemonResponse } from './protocol.ts'
import { profileDir, readProfile } from './profile.ts'
import { bearerToken, readRpcToken, rpcSocketPath, tokenMatches } from './rpcAuth.ts'
import { readSecrets } from './secrets.ts'
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
import { readDaemonTokenHoldings } from './walletHoldings.ts'
import { readDaemonWalletBalance } from './walletBalance.ts'
import type { WalletSeedRecoveryParams, WalletSeedRecoveryResult } from './protocol.ts'
import type { CustodyScopeFence } from './profileFencing.ts'
import {
  consolidateWalletProofs,
  recoverWalletProofConsolidations,
} from './walletProofConsolidation.ts'
import {
  resumeDaemonConditionRetirements,
  retireDaemonConditionInventory,
} from './managedConditionRetirement.ts'

export interface DaemonServerOptions {
  host?: string
  port?: number
  socketPath?: string
  tradeRuntime?: TradeRuntime
  swapExecutor?: SwapRecoveryExecutor
  recoverWalletFromSeed?: (input: WalletSeedRecoveryParams) => Promise<WalletSeedRecoveryResult>
  prepareSettlementCapability?: PrepareSettlementCapability
  triggerSettlementRecovery?: () => void
  getCustodyFence?: () => CustodyScopeFence
  isCustodyReady?: () => boolean
  markCustodyReady?: () => void
  onOutcomeProofsReceived?: (conditionId: string, outcomeSetId: string) => Promise<void>
  startTradeRuntime?: boolean
}

export interface SwapRecoveryExecutor {
  resumeActiveSwaps(
    state: Awaited<ReturnType<typeof ensureState>>,
  ): Promise<{ activeSwaps: number }>
}

export interface EngineClientLike {
  submitOrder(marketId: string, request: SubmitOrderRequest): Promise<SubmitOrderResponse>
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
  declineOrderContinuation?(
    marketId: string,
    orderId: string,
    expectedContinuationRevision: number,
  ): Promise<void>
}

export interface PrepareSettlementCapabilityInput {
  clientOrderId: string
  marketId: string
  conditionId: string
  outcomeId: string
  tokenSide: 'Outcome' | 'Complement'
  side: 'Buy' | 'Sell'
  price: number
  amountSubunits: number
  minimumFillAmountSubunits: number
  continueAfterPartialFill: boolean
  consolidateProofs: boolean
  baseAsset: 'sat'
  collateralUnit: 'msat'
  divisibility: number
  timeInForce: 'FAK' | 'FOK' | 'GTC' | 'GTD'
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

export type PrepareSettlementCapability = (
  input: PrepareSettlementCapabilityInput,
  client: EngineClientLike,
) => Promise<PreparedSettlementCapability>

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
  deps: WalletOpsDependencies
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
    input.deps,
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
  prepareSettlementCapability?: PrepareSettlementCapability
  tradeRuntime?: TradeRuntime
  swapExecutor?: SwapRecoveryExecutor
  recoverWalletFromSeed?: (input: WalletSeedRecoveryParams) => Promise<WalletSeedRecoveryResult>
  triggerSettlementRecovery?: () => void
  getCustodyFence?: () => CustodyScopeFence
  isCustodyReady?: () => boolean
  markCustodyReady?: () => void
  onOutcomeProofsReceived?: (conditionId: string, outcomeSetId: string) => Promise<void>
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
  if (options.startTradeRuntime !== false && options.tradeRuntime && (await readProfile())) {
    await startTradeRuntimeBestEffort(options.tradeRuntime)
  }
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
      tradeRuntime: options.tradeRuntime,
      swapExecutor: options.swapExecutor,
      recoverWalletFromSeed: options.recoverWalletFromSeed,
      prepareSettlementCapability: options.prepareSettlementCapability,
      triggerSettlementRecovery: options.triggerSettlementRecovery,
      getCustodyFence: options.getCustodyFence,
      isCustodyReady: options.isCustodyReady,
      markCustodyReady: options.markCustodyReady,
      onOutcomeProofsReceived: options.onOutcomeProofsReceived,
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

async function handleRequest(
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

  let command: DaemonCommand
  try {
    command = JSON.parse(await readBody(req)) as DaemonCommand
  } catch {
    return writeJson(res, 400, { ok: false, error: 'invalid JSON command' })
  }

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
  if (deps.isCustodyReady?.() === false && requiresReadyCustody(command.method)) {
    return {
      ok: false,
      code: 'custody-recovery-pending',
      error: 'wallet recovery must complete before this command can use funds',
    }
  }
  switch (command.method) {
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
            swaps: Object.keys(state.swaps).length,
          },
          wallet: await readDaemonWalletBalance(profileDir()),
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
    case 'wallet.retireCondition': {
      const profile = await readProfile()
      if (!profile) return { ok: false, error: 'daemon profile is not initialized' }
      const secrets = await readSecrets()
      if (!secrets) return { ok: false, error: 'daemon secrets are not initialized' }
      if (!deps.getCustodyFence) {
        return { ok: false, error: 'condition retirement requires custody authority' }
      }
      const client = createEngineClient(deps, {
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
      const consolidation = await recoverWalletProofConsolidations({
        secrets,
        mutation: () => ({ fence: getCustodyFence(), observedAtMs: Date.now() }),
        dependencies: deps,
      })
      const retirements = await resumeDaemonConditionRetirements({
        profile,
        secrets,
        fence: getCustodyFence(),
        walletDependencies: deps,
      })
      const result = {
        recovered: [
          ...wallet.recovered,
          ...consolidation.recovered,
          ...retirements.filter((entry) => entry.error === null).map((entry) => entry.conditionId),
        ],
        pending: [
          ...wallet.pending,
          ...consolidation.pending,
          ...retirements
            .filter((entry) => entry.error !== null)
            .map((entry) => ({
              operationId: `condition-retirement:${entry.conditionId}`,
              error: entry.error!,
            })),
        ],
      }
      if (result.pending.length === 0) deps.markCustodyReady?.()
      return {
        ok: true,
        result,
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
      const minimumFillAmountSubunits =
        orderParams.minimumFillAmountSubunits === undefined
          ? marketUnit.divisibility
          : orderParams.minimumFillAmountSubunits
      const requestValidation = validateOrderIntent({
        ...orderIntent,
        baseAsset: marketUnit.baseAsset,
        divisibility: marketUnit.divisibility,
      })
      if (!requestValidation.valid) {
        return { ok: false, error: requestValidation.message }
      }
      if (
        !Number.isSafeInteger(minimumFillAmountSubunits) ||
        minimumFillAmountSubunits <= 0 ||
        minimumFillAmountSubunits > amountSubunits ||
        minimumFillAmountSubunits % marketUnit.divisibility !== 0
      ) {
        return {
          ok: false,
          error: `Order rejected: minimum fill must be a positive multiple of ${marketUnit.divisibility} and no larger than the order amount`,
        }
      }
      if (
        orderParams.continueAfterPartialFill !== undefined &&
        typeof orderParams.continueAfterPartialFill !== 'boolean'
      ) {
        return { ok: false, error: 'Order rejected: continuation policy must be boolean' }
      }
      if (
        orderParams.consolidateProofs !== undefined &&
        typeof orderParams.consolidateProofs !== 'boolean'
      ) {
        return { ok: false, error: 'Order rejected: proof consolidation policy must be boolean' }
      }
      if (
        orderParams.continueAfterPartialFill === true &&
        orderParams.timeInForce !== 'GTC' &&
        orderParams.timeInForce !== 'GTD'
      ) {
        return { ok: false, error: 'Order rejected: continuation requires a resting order' }
      }
      const expiresAt = orderParams.expiresAt ?? null
      if (
        (orderParams.timeInForce === 'GTD' &&
          (typeof expiresAt !== 'string' ||
            !Number.isFinite(Date.parse(expiresAt)) ||
            new Date(expiresAt).toISOString() !== expiresAt)) ||
        (orderParams.timeInForce !== 'GTD' && expiresAt !== null)
      ) {
        return { ok: false, error: 'Order rejected: GTD requires one canonical UTC expiry' }
      }
      const settlementSupport = checkOrderSettlementSupport({
        request: { side: orderParams.side },
      })
      if (!settlementSupport.supported) {
        return { ok: false, error: settlementSupport.message }
      }
      const holdings = await readDaemonTokenHoldings(profileDir(), {
        mintUrl: context.profile.mintUrl,
        conditionId,
        baseAsset: marketUnit.baseAsset,
      })
      const participationScoreSnapshot = await context.client.getParticipationScore()
      const participationScorePlan = planParticipationScoreTopUp(participationScoreSnapshot)
      const backingError =
        orderBackingError({
          side: orderParams.side,
          price: orderParams.price,
          amountSubunits,
          divisibility: marketUnit.divisibility,
          holdings,
        }) ??
        participationScoreBackingError({
          side: orderParams.side,
          price: orderParams.price,
          amountSubunits,
          divisibility: marketUnit.divisibility,
          holdings,
          plan: participationScorePlan,
        })
      if (backingError) {
        return { ok: false, error: backingError }
      }
      const clientOrderId = randomUUID()
      let participationScore: DaemonParticipationScorePreflightResult
      try {
        participationScore = await ensureDaemonParticipationScoreForNextMatch({
          client: context.client,
          profile: context.profile,
          secrets: context.secrets,
          deps,
          score: participationScoreSnapshot,
          plan: participationScorePlan,
        })
      } catch (err) {
        throw err
      }
      if (!deps.prepareSettlementCapability) {
        return { ok: false, error: 'daemon settlement capability coordinator is unavailable' }
      }
      let prepared: PreparedSettlementCapability
      try {
        prepared = await deps.prepareSettlementCapability(
          {
            clientOrderId,
            marketId: orderParams.marketId,
            conditionId,
            outcomeId: orderParams.outcomeId,
            tokenSide: orderParams.tokenSide,
            side: orderParams.side,
            price: orderParams.price,
            amountSubunits,
            minimumFillAmountSubunits,
            continueAfterPartialFill: orderParams.continueAfterPartialFill === true,
            consolidateProofs: orderParams.consolidateProofs === true,
            baseAsset: marketUnit.baseAsset,
            collateralUnit: 'msat',
            divisibility: marketUnit.divisibility,
            timeInForce: orderParams.timeInForce,
            expiresAt,
            mintUrl: context.profile.mintUrl,
            walletSeedHex: context.secrets.walletSeedHex,
          },
          context.client,
        )
        assertPreparedSettlementCapability(prepared, {
          clientOrderId,
          marketId: orderParams.marketId,
        })
      } catch (err) {
        if (err instanceof EngineClientError) {
          return {
            ok: false,
            error: err.problemDetail ?? err.message,
            code: err.code,
          }
        }
        throw err
      }
      let submitted: SubmitOrderResponse
      try {
        submitted = await context.client.submitOrder(orderParams.marketId, {
          settlementCapability: prepared.capability.reference,
          comment: null,
        })
      } catch (err) {
        if (err instanceof EngineClientError) {
          if (isDefinitiveOrderSubmissionError(err)) {
            await prepared.markRejected()
          } else {
            deps.triggerSettlementRecovery?.()
          }
          return {
            ok: false,
            error: err.problemDetail ?? err.message,
            code: err.code,
          }
        }
        deps.triggerSettlementRecovery?.()
        throw err
      }
      if (submitted.orderId !== prepared.capability.orderId) {
        deps.triggerSettlementRecovery?.()
        throw new Error('engine order response does not match its settlement capability')
      }
      const local = await recordSubmittedOrder(
        orderParams.marketId,
        clientOrderId,
        submitted,
        null,
        orderParams.tokenSide,
        orderParams.side,
        orderParams.price,
        amountSubunits,
        marketUnit.baseAsset,
        marketUnit.divisibility,
      )
      await prepared.markSubmitted()
      await startTradeRuntimeBestEffort(deps.tradeRuntime)
      return {
        ok: true,
        result: {
          engine: submitted,
          local,
          participationScore,
          settlementCapability: prepared.capability,
          operationId: prepared.operationId,
          consolidation: prepared.consolidation,
        },
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
      if (local && deps.isCustodyReady?.() !== false) {
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

function requiresReadyCustody(method: DaemonCommand['method']): boolean {
  return (
    method === 'market.create' ||
    method === 'wallet.receive' ||
    method === 'wallet.send' ||
    method === 'wallet.splitCompleteSet' ||
    method === 'wallet.consolidateMarket' ||
    method === 'wallet.consolidateProofs' ||
    method === 'wallet.retireCondition' ||
    method === 'wallet.seedRecovery' ||
    method === 'order.submit' ||
    method === 'trade.recover'
  )
}

async function ensureDaemonParticipationScoreForNextMatch(input: {
  client: EngineClientLike
  profile: NonNullable<Awaited<ReturnType<typeof readProfile>>>
  secrets: NonNullable<Awaited<ReturnType<typeof readSecrets>>>
  deps: DispatchDependencies
  score: ParticipationScoreResponse
  plan: ParticipationScoreTopUpPlan
}): Promise<DaemonParticipationScorePreflightResult> {
  const { score, plan } = input
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

export function orderBackingError(input: {
  side: 'Buy' | 'Sell'
  price: number
  amountSubunits: number
  divisibility: number
  holdings: TokenHoldings
}): string | null {
  if (input.side === 'Buy') {
    const requiredCollateral = requiredBuyCollateral(input)
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

function participationScoreBackingError(input: {
  side: 'Buy' | 'Sell'
  price: number
  amountSubunits: number
  divisibility: number
  holdings: TokenHoldings
  plan: ParticipationScoreTopUpPlan
}): string | null {
  if (input.plan.kind !== 'needs-top-up') return null
  const scoreSubunits = input.plan.deficitScore * 1_000
  const orderSubunits = input.side === 'Buy' ? requiredBuyCollateral(input) : 0
  const required = scoreSubunits + orderSubunits
  if (!Number.isSafeInteger(required)) {
    throw new Error('combined order and Participation Score backing exceeds safe range')
  }
  if (input.holdings.baseUnitProofs >= required) return null
  return `insufficient combined backing: have ${input.holdings.baseUnitProofs} base subunits, need ${required} for the order and Participation Score`
}

function requiredBuyCollateral(input: {
  price: number
  amountSubunits: number
  divisibility: number
}): number {
  return input.amountSubunits % input.divisibility === 0
    ? quotePaymentSubunits({
        faceAmountSubunits: input.amountSubunits,
        priceNumerator: input.price,
        divisibility: input.divisibility,
      })
    : // TODO: move arbitrary-size quote-payment rounding into the SDK helper.
      Math.ceil((input.amountSubunits * input.price) / input.divisibility)
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
