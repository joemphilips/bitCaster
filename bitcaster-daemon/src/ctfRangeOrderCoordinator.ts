import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  Amount,
  Mint as CashuMint,
  OutputData,
  Wallet as CashuWallet,
  type ConditionalSwapPreview,
  type MintKeys,
  type Proof,
  type ProofState,
  type SerializedBlindedSignature,
  type SwapPreview,
  type SwapRequest,
} from '@cashu/cashu-ts'
import {
  resolveDurableCustodyProofOperationFacts,
  deriveDurableCustodyOperationId,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
  type DurableCustodyRecord,
  type DurableCustodyProofOperationInput,
  type DurableCustodyScope,
} from '@bitcaster-market/client-sdk'
import {
  completeCtfRangeOrderAuthorization,
  prepareCtfRangeOrderAuthorization,
  type ActiveCtfRangeMintKeyset,
  type CtfRangeOrderPreparation,
} from '@bitcaster-market/client-sdk/ctfRangeOrderPreparation'
import {
  classifyDurableCtfRangeVerifiedResultArtifact,
  createDurableCtfRangeCustodyBinding,
  deriveDurableCtfRangeSettledFaceAmount,
  createDurableCtfRangeRefundOperation,
  createDeterministicDurableCtfRangeRefundOutputs,
  deriveDurableCtfRangeFeeBounds,
  deriveDurableCtfRangeRefundOperationId,
  toDurableCtfRangeProofOperationInput,
  type DurableCtfRangeExpiryObservation,
  type DurableCtfRangeMintKeyset,
  type DurableCtfRangeKeysetResolver,
  type DurableCtfRangeOperation,
  type DurableCtfRangeProof,
  type DurableCtfRangeRecoveryDecision,
} from '@bitcaster-market/client-sdk/durableCtfRangeOperation'
import {
  CtfRangeMintRecoveryAdapter,
  checkCtfRangeInputProofStates,
  decodeCtfRangeEngineResult,
  type CtfRangeEngineResult,
  type CtfRangeMintClient,
} from '@bitcaster-market/client-sdk/ctfRangeRecoveryTransport'
import {
  buildPersistedCtfRangeOrderPreparation,
  createCtfRangeOrderPreparationKeysetResolver,
  createCtfRangeSettlementCapabilityRequest,
  ctfRangeOrderPreparationKeysetLookup,
  decodeCtfRangeOrderPreparationFromRecord as decodePreparationFromJournal,
  decodeSettlementCoordinatorPublicKey as requireCoordinatorKey,
  encodePersistedCtfRangeOrderPreparation as encodeCanonicalRangePreparation,
  exactCtfRangeOrderPreparationMintKeysets,
  validateAndProjectCtfRangeSettlementCapabilityResponse,
  type PersistedCtfRangeOrderPreparation,
} from '@bitcaster-market/client-sdk/ctfRangeOrderProtocol'
import {
  loadCtfRangeMintKeys as loadMintKeys,
  loadCtfRangeMintMetadata,
  type CtfRangeMintMetadata as LoadedMintMetadata,
  type CtfRangeMintMetadataClient,
} from '@bitcaster-market/client-sdk/ctfRangeMintMetadata'
import {
  amountToNumber,
  computeInputFeeSatsForProofs,
  sumProofs,
  takeProofsForLock,
} from '@bitcaster-market/client-sdk/proofSelection'
import {
  classifyCtfRangeSourceRecovery,
  type CtfRangeSourceRecoveryDecision,
} from '@bitcaster-market/client-sdk/ctfRangeSourceRecovery'
import {
  planBoundedProofConsolidation,
  type BoundedProofConsolidationPlan,
  type ProofConsolidationRound,
} from '@bitcaster-market/client-sdk/boundedProofConsolidation'
import {
  completeCtfRangeConsolidationOperation,
  prepareCtfRangeConsolidationOperation,
  validateCtfRangeConsolidationOperation,
  validateCtfRangeConsolidationProofs,
} from '@bitcaster-market/client-sdk/ctfRangeConsolidationOperation'
import type {
  CreateSettlementCapabilityRequest,
  OrderStatusResponse,
  SettlementCapabilityResultResponse,
  SettlementCapabilityResponse,
} from '@bitcaster-market/client-sdk/engineClient'
import { DaemonCtfRangeCoordinator } from './ctfRangeCoordinator.ts'
import type { CustodyScopeFence } from './profileFencing.ts'
import {
  CTF_RANGE_REFUND_PURPOSE,
  admitExactAvailableWalletProofsFromDatabase,
  getProofOperation,
  finalizeCompletedProofReservation,
  markProofOperationCompletedFenced,
  prepareProofOperationWithExactReservation,
  prepareCtfRangeRefundProofOperationFromDatabase,
  readAvailableWalletProofPage,
  recordDiscoveredOrder,
  recordOrderStatus,
  releasePreparedProofReservationFenced,
  type CashuProofRecord,
  type FencedStateMutation,
  type ProofOperationRecord,
  type StoredProofAsset,
} from './state.ts'
import {
  appendRangePreparationConsolidation,
  bindRangePreparationCapability,
  insertRangePreparation,
  linkRangePreparationSource,
  pageActiveRangePreparations,
  readActiveRangePreparationByClientOrderId,
  readRangePreparation,
  toSdkRangePreparationRecord,
  transitionRangePreparation,
  type RangePreparationCapability,
  type RangePreparationPageCursor,
  type RangePreparationRecord,
} from './ctfRangeOrderJournalSqlite.ts'
import {
  withDurableCustodyFencedRead,
  withDurableCustodyUnitOfWork,
} from './durableCustodyUnitOfWork.ts'
import { DurableCustodySqliteStore } from './durableCustodySqliteStore.ts'
import { createDaemonStateSqliteSession, type DaemonStateSqliteSession } from './stateSqlite.ts'
import {
  createDaemonCounterSource,
  deserializeOutputGroups,
  restoreOutputGroups,
  serializeOutputDataArray,
} from './walletOps.ts'
import type {
  EngineClientLike,
  PreparedSettlementCapability,
  PrepareSettlementCapabilityInput,
} from './server.ts'

const SOURCE_PURPOSE = 'ctf-range-authorization-source'
const CONSOLIDATION_PURPOSE = 'ctf-range-authorization-consolidation'
const ACTIVE_RANGE_SOURCE_LIMIT = 256
const MAX_CONSOLIDATION_ROUNDS = 256

interface CtfRangeMintLike extends CtfRangeMintMetadataClient {
  check(payload: { Ys: string[] }, signal?: AbortSignal): Promise<{ states: ProofState[] }>
}

interface CtfRangeWalletLike {
  loadMint(): Promise<void>
  prepareSwapToSend(
    amount: number,
    proofs: Proof[],
    config: { includeFees: false; keysetId: string },
    outputConfig: {
      send: { type: 'custom'; data: OutputData[] } | { type: 'random' }
      keep: { type: 'custom'; data: OutputData[] } | { type: 'random' }
    },
  ): Promise<SwapPreview>
  completeSwap(preview: SwapPreview): Promise<{ keep: Proof[]; send: Proof[] }>
  prepareConditionalSwap(options: {
    keysetId: string
    inputs: Proof[]
    outputs: Array<
      | { label: string; kind: 'custom'; data: OutputData[] }
      | { label: string; kind: 'random'; amount: number }
    >
  }): Promise<ConditionalSwapPreview>
  completeConditionalSwap(preview: ConditionalSwapPreview): Promise<Record<string, Proof[]>>
  checkProofsStates(proofs: Array<Pick<Proof, 'id' | 'secret'>>): Promise<ProofState[]>
}

export interface DaemonCtfRangeOrderCoordinatorDependencies {
  readonly allowInsecureLoopbackHttp?: boolean
  readonly createMint?: (mintUrl: string) => CtfRangeMintLike
  readonly createWallet?: (mintUrl: string, walletSeedHex: string) => CtfRangeWalletLike
  readonly now?: () => number
  readonly randomId?: () => string
  readonly restoreOutputs?: typeof restoreOutputGroups
  readonly executeRefundSwap?: (
    mintUrl: string,
    request: SwapRequest,
  ) => Promise<{ signatures: SerializedBlindedSignature[] }>
}

export interface DaemonCtfRangeRecoveryResult {
  readonly recovered: string[]
  readonly pending: Array<{ operationId: string; error: string; retryAtMs?: number }>
  readonly processedCount?: number
  readonly deferredCount?: number
  readonly nextCursor?: RangePreparationPageCursor | null
}

interface PreparedMintAuthority {
  readonly preparation: CtfRangeOrderPreparation
  readonly preparationInput: PersistedPreparationInput
  readonly lookup: ReturnType<typeof ctfRangeOrderPreparationKeysetLookup>
  readonly observation: DurableCtfRangeExpiryObservation
  readonly mintKeysets: ReadonlyMap<string, DurableCtfRangeMintKeyset>
  readonly offerAsset: StoredProofAsset
  readonly mint: CtfRangeMintLike
  readonly consolidateProofs: boolean
  readonly mutation: () => FencedStateMutation
}

type PersistedPreparationInput = PersistedCtfRangeOrderPreparation

function preparationFromJournal(
  record: RangePreparationRecord,
  expectedRequest?: Parameters<typeof decodePreparationFromJournal>[1],
): PersistedPreparationInput {
  return decodePreparationFromJournal(toSdkRangePreparationRecord(record), expectedRequest)
}

class RangeSourceReleasedError extends Error {
  constructor(operationId: string) {
    super(`Range source operation ${operationId} expired before mint commitment`)
    this.name = 'RangeSourceReleasedError'
  }
}

class ProofConsolidationRequiredError extends Error {
  constructor() {
    super('range-order proofs exceed the mint input limit; retry with proof consolidation enabled')
    this.name = 'ProofConsolidationRequiredError'
  }
}

class RangeRecoveryDeferredError extends Error {
  readonly retryAtMs: number

  constructor(message: string, retryAtMs: number) {
    super(message)
    this.name = 'RangeRecoveryDeferredError'
    this.retryAtMs = retryAtMs
  }
}

export class DaemonCtfRangeOrderCoordinator {
  readonly #directory: string
  readonly #getFence: () => CustodyScopeFence
  readonly #dependencies: DaemonCtfRangeOrderCoordinatorDependencies
  readonly #storage: DaemonStateSqliteSession
  #recoveryCursor: RangePreparationPageCursor | undefined

  constructor(
    directory: string,
    getFence: () => CustodyScopeFence,
    dependencies: DaemonCtfRangeOrderCoordinatorDependencies = {},
  ) {
    this.#directory = directory
    this.#getFence = getFence
    this.#dependencies = dependencies
    this.#storage = createDaemonStateSqliteSession(directory)
  }

  async prepare(
    request: PrepareSettlementCapabilityInput,
    client: EngineClientLike,
  ): Promise<PreparedSettlementCapability> {
    const authority = await this.#prepareMintAuthority(request, client)
    const source = await this.#prepareWalletSource(authority, request.walletSeedHex)
    const operation = completeCtfRangeOrderAuthorization({
      preparation: authority.preparation,
      inputs: source.authorization,
      keysetLookup: authority.lookup,
      expiryObservation: authority.observation,
      allowInsecureLoopbackHttp: this.#dependencies.allowInsecureLoopbackHttp === true,
    })
    const capabilityRequest = createCtfRangeSettlementCapabilityRequest(
      authority.preparationInput,
      operation,
    )
    const binding = await createRangeBinding(
      request.walletSeedHex,
      operation,
      authority.mintKeysets,
      capabilityRequest,
    )
    const nowMs = this.#nowMs()
    await new DaemonCtfRangeCoordinator(this.#directory, this.#getFence()).bindPreparedSource({
      binding,
      proofStateClient: authority.mint,
      observedAtMs: nowMs,
    })
    await this.#markCapabilityRequested(operation.operationId)
    const exactCapabilityRequest = await this.#exactCapabilityRequest(
      request.walletSeedHex,
      operation.operationId,
      capabilityRequest,
    )
    const createCapability = client.createSettlementCapability
    if (createCapability === undefined) {
      throw new Error('engine client does not support settlement capability creation')
    }
    const capability = await createCapability.call(client, exactCapabilityRequest)
    const projectedCapability = validateAndProjectCtfRangeSettlementCapabilityResponse({
      capability,
      preparation: authority.preparationInput,
      operation,
      recovering: false,
    })
    await this.#bindCapability(operation.operationId, projectedCapability)
    return {
      operationId: operation.operationId,
      capability,
      markSubmitted: () => this.#markOrderSubmitted(operation.operationId),
      markRejected: () => this.#markOrderSubmissionRejected(operation.operationId),
      consolidation: await sourceConsolidationSummary(operation.sourceOperationId),
    }
  }

  async recover(
    walletSeedHex: string,
    client: EngineClientLike,
  ): Promise<DaemonCtfRangeRecoveryResult> {
    const startedAfterCursor = this.#recoveryCursor !== undefined
    const page = await this.#activeRangePreparations()
    const exposesPage =
      startedAfterCursor ||
      page.preparations.length === ACTIVE_RANGE_SOURCE_LIMIT ||
      page.deferredCount > 0
    const result: DaemonCtfRangeRecoveryResult = {
      recovered: [],
      pending: [],
      ...(exposesPage
        ? {
            processedCount: page.preparations.length,
            deferredCount: page.deferredCount,
            nextCursor: page.nextCursor,
          }
        : {}),
    }
    this.#recoveryCursor = page.nextCursor ?? undefined
    for (const preparation of page.preparations) {
      const preparationInput = preparationFromJournal(preparation)
      try {
        await this.#recoverPreparation(preparation, preparationInput, walletSeedHex, client)
        result.recovered.push(preparationInput.sourceOperationId)
      } catch (error) {
        result.pending.push({
          operationId: preparationInput.sourceOperationId,
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof RangeRecoveryDeferredError ? { retryAtMs: error.retryAtMs } : {}),
        })
      }
    }
    return result
  }

  async #recoverPreparation(
    preparationRecord: RangePreparationRecord,
    preparationInput: PersistedPreparationInput,
    walletSeedHex: string,
    client: EngineClientLike,
  ): Promise<void> {
    switch (preparationRecord.lifecycleState) {
      case 'order-submitted':
      case 'submission-rejected':
        await this.#recoverSubmittedOrder(
          preparationRecord,
          preparationInput,
          walletSeedHex,
          client,
        )
        return
      case 'capability-bound':
        await this.#recoverCapabilityBoundOrder(
          preparationRecord,
          preparationInput,
          walletSeedHex,
          client,
        )
        return
      case 'capability-requested':
      case 'prepared':
        break
      case 'terminal':
        return
      default:
        throw new Error('daemon CTF range preparation lifecycle is invalid')
    }
    const authority = persistedMintAuthority(
      preparationInput,
      walletSeedHex,
      this.#createMint(preparationInput.mintUrl),
      preparationRecord.consolidateProofs,
      this.#mutation.bind(this),
    )
    const wallet =
      this.#dependencies.createWallet?.(authority.preparation.mintUrl, walletSeedHex) ??
      (new CashuWallet(new CashuMint(authority.preparation.mintUrl), {
        unit: 'msat',
        bip39seed: walletSeed(walletSeedHex),
      }) as CtfRangeWalletLike)
    await wallet.loadMint()
    let sourceResult: SourceResult
    try {
      sourceResult = await this.#prepareWalletSource(authority, walletSeedHex, wallet)
    } catch (error) {
      if (error instanceof RangeSourceReleasedError) return
      throw error
    }
    const operation = completeCtfRangeOrderAuthorization({
      preparation: authority.preparation,
      inputs: sourceResult.authorization,
      keysetLookup: authority.lookup,
      expiryObservation: authority.observation,
      allowInsecureLoopbackHttp: this.#dependencies.allowInsecureLoopbackHttp === true,
    })
    const capabilityRequest = createCtfRangeSettlementCapabilityRequest(
      preparationInput,
      operation,
    )
    const binding = await createRangeBinding(
      walletSeedHex,
      operation,
      authority.mintKeysets,
      capabilityRequest,
    )
    const rangeCoordinator = new DaemonCtfRangeCoordinator(this.#directory, this.#getFence())
    const bindInput = {
      binding,
      proofStateClient: authority.mint,
      observedAtMs: this.#nowMs(),
    }
    await rangeCoordinator.bindPreparedSource(bindInput)
    if (preparationRecord.lifecycleState === 'capability-requested') {
      await this.#recoverRequestedCapability(
        preparationInput,
        operation,
        capabilityRequest,
        walletSeedHex,
        client,
      )
      return
    }
    await this.#recoverUnsubmittedAuthorization(preparationInput, walletSeedHex)
  }

  async #recoverRequestedCapability(
    input: PersistedPreparationInput,
    operation: DurableCtfRangeOperation,
    request: CreateSettlementCapabilityRequest,
    walletSeedHex: string,
    client: EngineClientLike,
  ): Promise<void> {
    const createCapability = client.createSettlementCapability
    if (createCapability === undefined) {
      throw new Error('engine client does not support settlement capability creation')
    }
    const exactRequest = await this.#exactCapabilityRequest(
      walletSeedHex,
      operation.operationId,
      request,
    )
    const response = await createCapability.call(client, exactRequest)
    const capability = validateAndProjectCtfRangeSettlementCapabilityResponse({
      capability: response,
      preparation: input,
      operation,
      recovering: true,
    })
    await this.#bindCapability(operation.operationId, capability)
  }

  async #recoverCapabilityBoundOrder(
    preparation: RangePreparationRecord,
    input: PersistedPreparationInput,
    walletSeedHex: string,
    client: EngineClientLike,
  ): Promise<void> {
    const capability = preparation.capability
    if (capability === null) throw new Error('bound range capability authority is missing')
    const status = await client.getOrderStatus(input.request.marketId, capability.orderId)
    if (status === null) {
      await this.#recoverUnsubmittedAuthorization(input, walletSeedHex)
      return
    }
    await recordDiscoveredOrder(
      input.request.marketId,
      input.request.clientOrderId,
      status,
      input.request.tokenSide,
      input.request.side,
      input.request.price,
      input.request.amountSubunits,
      input.request.baseAsset,
      input.request.divisibility,
    )
    await this.#markOrderSubmitted(input.operationId)
    await this.#recoverSubmittedOrder(
      { ...preparation, lifecycleState: 'order-submitted' },
      input,
      walletSeedHex,
      client,
    )
  }

  async #exactCapabilityRequest(
    walletSeedHex: string,
    rangeOperationId: string,
    expected: CreateSettlementCapabilityRequest,
  ): Promise<CreateSettlementCapabilityRequest> {
    const coordinator = new DaemonCtfRangeCoordinator(this.#directory, this.#getFence())
    const authority = await coordinator.load(
      rangeCustodyOperationId(walletSeedHex, rangeOperationId),
    )
    if (authority === null || !isDeepStrictEqual(authority.requestBody, expected)) {
      throw new Error('daemon CTF range exact capability request authority is missing or foreign')
    }
    return structuredClone(authority.requestBody) as CreateSettlementCapabilityRequest
  }

  async #recoverUnsubmittedAuthorization(
    input: PersistedPreparationInput,
    walletSeedHex: string,
  ): Promise<void> {
    const coordinator = new DaemonCtfRangeCoordinator(this.#directory, this.#getFence())
    const custodyOperationId = rangeCustodyOperationId(walletSeedHex, input.operationId)
    const loaded = await coordinator.load(custodyOperationId)
    if (loaded === null) throw new Error('daemon CTF range custody authority is missing')
    const mint = this.#createMint(input.mintUrl) as CtfRangeMintLike & CtfRangeMintClient
    const existingRefund = await getProofOperation(
      deriveDurableCtfRangeRefundOperationId(input.operationId),
    )
    if (existingRefund !== null) {
      await this.#resumeOrCreateRefund(
        coordinator,
        custodyOperationId,
        loaded.operation,
        walletSeedHex,
        mint,
        existingRefund,
      )
      await this.#markTerminal(input.operationId)
      return
    }
    const decision = await this.#classifyMintRecovery(
      coordinator,
      custodyOperationId,
      loaded.record,
      new CtfRangeMintRecoveryAdapter(loaded.operation, mint),
    )
    switch (decision.kind) {
      case 'confirmed':
        await this.#markTerminal(input.operationId)
        return
      case 'waiting':
        throw new RangeRecoveryDeferredError(
          'unsubmitted range authorization remains unspent before expiry',
          loaded.operation.expiry * 1_000 + 1_000,
        )
      case 'refundable':
        await this.#resumeOrCreateRefund(
          coordinator,
          custodyOperationId,
          loaded.operation,
          walletSeedHex,
          mint,
          null,
        )
        await this.#markTerminal(input.operationId)
        return
      case 'reconciling':
        throw new Error('unsubmitted range authorization remains reconciling')
      default:
        throw new Error('unsubmitted range recovery decision is invalid')
    }
  }

  async #prepareMintAuthority(
    request: PrepareSettlementCapabilityInput,
    client: EngineClientLike,
  ): Promise<PreparedMintAuthority> {
    const persisted = await this.#readActivePreparation(request)
    if (persisted !== null) {
      return persistedMintAuthority(
        persisted,
        request.walletSeedHex,
        this.#createMint(persisted.mintUrl),
        request.consolidateProofs,
        this.#mutation.bind(this),
      )
    }
    const getPolicy = client.getSettlementCapabilityAdmissionPolicy
    if (getPolicy === undefined) {
      throw new Error('engine client does not expose settlement admission policy')
    }
    const mint = this.#createMint(request.mintUrl)
    const [policy, metadata, market] = await Promise.all([
      getPolicy.call(client),
      loadMintMetadata(
        mint,
        request.mintUrl,
        request.conditionId,
        this.#nowSeconds(),
        this.#dependencies.allowInsecureLoopbackHttp === true,
      ),
      loadEngineMarket(client, request.conditionId),
    ])
    const preparationInput = buildPersistedCtfRangeOrderPreparation({
      request: persistedOrderRequest(request),
      coordinatorPublicKey: requireCoordinatorKey(policy),
      mintFacts: metadata,
      market,
      nowUnixSeconds: this.#nowSeconds(),
      randomId: this.#randomId.bind(this),
    })
    const durablePreparation = await this.#persistPreparation(
      preparationInput,
      request.consolidateProofs,
    )
    return preparedMintAuthority(
      durablePreparation,
      request.walletSeedHex,
      metadata,
      mint,
      request.consolidateProofs,
      this.#mutation.bind(this),
    )
  }

  async #readActivePreparation(
    request: PrepareSettlementCapabilityInput,
  ): Promise<PersistedPreparationInput | null> {
    const observedAtMs = this.#nowMs()
    return withDurableCustodyFencedRead(
      this.#storage,
      this.#getFence(),
      observedAtMs,
      (database) => {
        const record = readActiveRangePreparationByClientOrderId(
          database,
          this.#getFence().scopeId,
          request.clientOrderId,
        )
        if (record === null) return null
        if (record.consolidateProofs !== request.consolidateProofs) {
          throw new Error('daemon CTF range preparation policy conflicts with its journal')
        }
        return preparationFromJournal(record, persistedOrderRequest(request))
      },
    )
  }

  async #persistPreparation(
    input: PersistedPreparationInput,
    consolidateProofs: boolean,
  ): Promise<PersistedPreparationInput> {
    const mutation = this.#mutation()
    return withDurableCustodyUnitOfWork(
      this.#storage,
      mutation.fence,
      mutation.observedAtMs,
      (database) => {
        const existing = readActiveRangePreparationByClientOrderId(
          database,
          mutation.fence.scopeId,
          input.request.clientOrderId,
        )
        if (existing !== null) {
          if (existing.consolidateProofs !== consolidateProofs) {
            throw new Error('daemon CTF range preparation policy conflicts with its journal')
          }
          return preparationFromJournal(existing, input.request)
        }
        return preparationFromJournal(
          insertRangePreparation(database, {
            scopeId: mutation.fence.scopeId,
            rangeOperationId: input.operationId,
            sourceOperationId: input.sourceOperationId,
            authorizationId: input.authorizationId,
            clientOrderId: input.request.clientOrderId,
            orderRouteId: input.request.marketId,
            normalizedMint: input.mintUrl,
            conditionId: input.conditionId,
            unit: 'msat',
            tokenSide: input.request.tokenSide,
            side: input.side,
            priceSubunits: input.priceNumerator,
            amountSubunits: input.amountSubunits,
            minimumFillAmountSubunits: input.request.minimumFillAmountSubunits,
            consolidateProofs,
            divisibility: input.divisibility as 10_000 | 1_000_000,
            authorizationExpiresAtUnixSeconds: input.expiry,
            preparationBytes: encodeCanonicalRangePreparation(input),
            createdAtMs: mutation.observedAtMs,
          }),
          input.request,
        )
      },
    )
  }

  async #activeRangePreparations(): Promise<ReturnType<typeof pageActiveRangePreparations>> {
    const observedAtMs = this.#nowMs()
    return withDurableCustodyFencedRead(
      this.#storage,
      this.#getFence(),
      observedAtMs,
      (database) => {
        const page = pageActiveRangePreparations(database, {
          scopeId: this.#getFence().scopeId,
          limit: ACTIVE_RANGE_SOURCE_LIMIT,
          ...(this.#recoveryCursor === undefined ? {} : { after: this.#recoveryCursor }),
        })
        for (const record of page.preparations) preparationFromJournal(record)
        return page
      },
    )
  }

  async #bindCapability(
    rangeOperationId: string,
    capability: RangePreparationCapability,
  ): Promise<void> {
    const mutation = this.#mutation()
    await withDurableCustodyUnitOfWork(
      this.#storage,
      mutation.fence,
      mutation.observedAtMs,
      (database) => {
        const current = readRangePreparation(database, mutation.fence.scopeId, rangeOperationId)
        if (current === null) throw new Error('daemon CTF range preparation is missing')
        const expected = capability
        if (current.lifecycleState !== 'capability-requested') {
          if (current.capability === null || !isDeepStrictEqual(current.capability, expected)) {
            throw new Error('daemon CTF range capability conflicts with its journal')
          }
          return
        }
        bindRangePreparationCapability(database, {
          scopeId: mutation.fence.scopeId,
          rangeOperationId,
          expectedRevision: current.revision,
          capability: expected,
          updatedAtMs: mutation.observedAtMs,
        })
      },
    )
  }

  async #markCapabilityRequested(rangeOperationId: string): Promise<void> {
    const mutation = this.#mutation()
    await withDurableCustodyUnitOfWork(
      this.#storage,
      mutation.fence,
      mutation.observedAtMs,
      (database) => {
        const current = readRangePreparation(database, mutation.fence.scopeId, rangeOperationId)
        if (current === null) throw new Error('daemon CTF range preparation is missing')
        if (current.lifecycleState === 'capability-requested') return
        if (current.lifecycleState !== 'prepared') {
          throw new Error('daemon CTF range capability request conflicts with its journal')
        }
        transitionRangePreparation(database, {
          scopeId: mutation.fence.scopeId,
          rangeOperationId,
          expectedRevision: current.revision,
          from: 'prepared',
          to: 'capability-requested',
          updatedAtMs: mutation.observedAtMs,
        })
      },
    )
  }

  async #markOrderSubmitted(rangeOperationId: string): Promise<void> {
    const mutation = this.#mutation()
    await withDurableCustodyUnitOfWork(
      this.#storage,
      mutation.fence,
      mutation.observedAtMs,
      (database) => {
        const current = readRangePreparation(database, mutation.fence.scopeId, rangeOperationId)
        if (current === null) throw new Error('daemon CTF range preparation is missing')
        if (current.lifecycleState === 'order-submitted' || current.lifecycleState === 'terminal') {
          return
        }
        transitionRangePreparation(database, {
          scopeId: mutation.fence.scopeId,
          rangeOperationId,
          expectedRevision: current.revision,
          from: 'capability-bound',
          to: 'order-submitted',
          updatedAtMs: mutation.observedAtMs,
        })
      },
    )
  }

  async #markOrderSubmissionRejected(rangeOperationId: string): Promise<void> {
    const mutation = this.#mutation()
    await withDurableCustodyUnitOfWork(
      this.#storage,
      mutation.fence,
      mutation.observedAtMs,
      (database) => {
        const current = readRangePreparation(database, mutation.fence.scopeId, rangeOperationId)
        if (current === null) throw new Error('daemon CTF range preparation is missing')
        if (
          current.lifecycleState === 'submission-rejected' ||
          current.lifecycleState === 'terminal'
        ) {
          return
        }
        transitionRangePreparation(database, {
          scopeId: mutation.fence.scopeId,
          rangeOperationId,
          expectedRevision: current.revision,
          from: 'capability-bound',
          to: 'submission-rejected',
          updatedAtMs: mutation.observedAtMs,
        })
      },
    )
  }

  async #recoverSubmittedOrder(
    preparation: RangePreparationRecord,
    input: PersistedPreparationInput,
    walletSeedHex: string,
    client: EngineClientLike,
  ): Promise<void> {
    const capability = preparation.capability
    if (capability === null) throw new Error('submitted range capability authority is missing')
    const reference = {
      artifactId: capability.artifactId,
      bindingDigest: capability.bindingDigest,
    }
    const coordinator = new DaemonCtfRangeCoordinator(this.#directory, this.#getFence())
    const custodyOperationId = rangeCustodyOperationId(walletSeedHex, input.operationId)
    const loaded = await coordinator.load(custodyOperationId)
    if (loaded === null) throw new Error('daemon CTF range custody authority is missing')
    const preparationResolver = createCtfRangeOrderPreparationKeysetResolver(
      preparationFromJournal(preparation),
    )
    if (loaded.record.operation.result.state !== 'none') {
      if ((await this.#persistedResultSource(loaded.record)) === 'mint-recovery') {
        if (loaded.record.operation.result.state === 'verified-staged') {
          await coordinator.applyStaged({
            custodyOperationId,
            resolveKeyset: preparationResolver,
            observedAtMs: this.#nowMs(),
          })
        }
        const recovered = await coordinator.readAppliedResult({
          custodyOperationId,
          resolveKeyset: preparationResolver,
        })
        const status = await this.#loadPartialResultStatus(
          input,
          capability,
          client,
          loaded.operation,
          recovered,
        )
        await this.#completeSubmittedLifecycle(
          input,
          status,
        )
        return
      }
      const response = await this.#getEngineResult(client, input.operationId)
      if (response === null) {
        throw new RangeRecoveryDeferredError(
          'persisted engine range result acknowledgement is pending',
          this.#nowMs() + 1_000,
        )
      }
      let persistedEngineResult: CtfRangeEngineResult
      try {
        persistedEngineResult = decodeCtfRangeEngineResult(response, {
          operation: loaded.operation,
          reference,
        })
      } catch {
        throw new RangeRecoveryDeferredError(
          'persisted engine range result is unavailable',
          this.#nowMs() + 1_000,
        )
      }
      const decision = await this.#applyEngineResult(
        coordinator,
        custodyOperationId,
        loaded.operation,
        persistedEngineResult,
        reference,
        client,
        preparationResolver,
      )
      if (decision.kind !== 'confirmed') {
        throw new RangeRecoveryDeferredError(
          'persisted engine range result remains unverified',
          this.#nowMs() + 1_000,
        )
      }
      const persistedStatus = await this.#loadPartialResultStatus(
        input,
        capability,
        client,
        loaded.operation,
        decision.result,
      )
      await this.#completeSubmittedLifecycle(
        input,
        persistedStatus,
      )
      return
    }
    const response = await this.#getEngineResult(client, input.operationId)
    let engineResult: CtfRangeEngineResult | null = null
    if (response !== null) {
      try {
        engineResult = decodeCtfRangeEngineResult(response, {
          operation: loaded.operation,
          reference,
        })
      } catch {
        engineResult = null
      }
    }
    const mint = this.#createMint(input.mintUrl) as CtfRangeMintLike & CtfRangeMintClient
    const refundOperationId = deriveDurableCtfRangeRefundOperationId(input.operationId)
    const existingRefund = engineResult === null ? await getProofOperation(refundOperationId) : null
    if (existingRefund !== null) {
      const status = await this.#loadOrderStatus(input, capability, client)
      await this.#cancelRestingOrderBeforeRefund(input, capability, status, client)
      await this.#resumeOrCreateRefund(
        coordinator,
        custodyOperationId,
        loaded.operation,
        walletSeedHex,
        mint,
        existingRefund,
      )
      await this.#markTerminal(input.operationId)
      return
    }
    const recovery = new CtfRangeMintRecoveryAdapter(loaded.operation, mint)
    let decision =
      engineResult === null
        ? await this.#classifyMintRecovery(coordinator, custodyOperationId, loaded.record, recovery)
        : await this.#applyEngineResult(
            coordinator,
            custodyOperationId,
            loaded.operation,
            engineResult!,
            reference,
            client,
            preparationResolver,
          )
    if (decision.kind === 'reconciling' && engineResult !== null) {
      engineResult = null
      decision = await this.#classifyMintRecovery(
        coordinator,
        custodyOperationId,
        loaded.record,
        recovery,
      )
    }
    switch (decision.kind) {
      case 'confirmed': {
        const status = await this.#loadPartialResultStatus(
          input,
          capability,
          client,
          loaded.operation,
          decision.result,
        )
        await this.#completeSubmittedLifecycle(
          input,
          status,
        )
        return
      }
      case 'waiting':
        throw new RangeRecoveryDeferredError(
          'submitted range authorization remains unspent before expiry',
          loaded.operation.expiry * 1_000 + 1_000,
        )
      case 'refundable': {
        const refundableStatus = await this.#loadOrderStatus(input, capability, client)
        await this.#cancelRestingOrderBeforeRefund(input, capability, refundableStatus, client)
        await this.#resumeOrCreateRefund(
          coordinator,
          custodyOperationId,
          loaded.operation,
          walletSeedHex,
          mint,
          null,
        )
        await this.#markTerminal(input.operationId)
        return
      }
      case 'reconciling':
        throw new Error('submitted range result remains reconciling')
      default:
        throw new Error('submitted range recovery decision is invalid')
    }
  }

  async #classifyMintRecovery(
    coordinator: DaemonCtfRangeCoordinator,
    custodyOperationId: string,
    record: DurableCustodyRecord,
    recovery: CtfRangeMintRecoveryAdapter,
  ): Promise<DurableCtfRangeRecoveryDecision> {
    const recoveryObservation = await recovery.loadUncertainRecoveryObservation({
      record,
      selection: null,
      now: Math.floor(this.#nowMs() / 1_000),
    })
    const observation = recoveryObservation.observation
    const decision = await coordinator.classifyRecovery({
      custodyOperationId,
      observation,
      resolveKeyset: recoveryObservation.resolveKeyset,
    })
    if (decision.kind !== 'confirmed') return decision
    const staged = await coordinator.stageRecovered({
      custodyOperationId,
      observation,
      resolveKeyset: recoveryObservation.resolveKeyset,
      observedAtMs: this.#nowMs(),
    })
    if (staged.kind !== 'confirmed') return staged
    await coordinator.applyStaged({
      custodyOperationId,
      resolveKeyset: recoveryObservation.resolveKeyset,
      observedAtMs: this.#nowMs(),
    })
    return staged
  }

  async #getEngineResult(
    client: EngineClientLike,
    operationId: string,
  ): Promise<SettlementCapabilityResultResponse | null> {
    const getResult = client.getSettlementCapabilityResultByOperation
    if (getResult === undefined) return null
    try {
      return await getResult.call(client, operationId)
    } catch {
      return null
    }
  }

  async #loadOrderStatus(
    input: PersistedPreparationInput,
    capability: RangePreparationCapability,
    client: EngineClientLike,
  ): Promise<OrderStatusResponse | null> {
    const status = await client.getOrderStatus(input.request.marketId, capability.orderId)
    if (status !== null) {
      await recordOrderStatus(
        input.request.marketId,
        capability.orderId,
        status,
        input.request.baseAsset,
        input.request.divisibility,
      )
    }
    return status
  }

  async #loadPartialResultStatus(
    input: PersistedPreparationInput,
    capability: RangePreparationCapability,
    client: EngineClientLike,
    operation: DurableCtfRangeOperation,
    result: Extract<DurableCtfRangeRecoveryDecision, { kind: 'confirmed' }>['result'],
  ): Promise<OrderStatusResponse | null> {
    const settledAmount = deriveDurableCtfRangeSettledFaceAmount(operation, result)
    if (settledAmount > input.request.amountSubunits) {
      throw new Error('settled range amount exceeds the submitted order')
    }
    if (settledAmount === input.request.amountSubunits) return null
    return this.#loadOrderStatus(input, capability, client)
  }

  async #persistedResultSource(record: DurableCustodyRecord): Promise<'engine' | 'mint-recovery'> {
    const reference = record.operation.result.exactResult
    if (reference === null) throw new Error('persisted range result artifact is absent')
    const exactResult = await this.#storage.read((database) =>
      new DurableCustodySqliteStore(database).getArtifact({
        scopeId: record.scope.scopeId,
        operationId: record.operation.operationId,
        expectedOperationRevision: record.revision,
        reference,
      }),
    )
    if (exactResult === null) throw new Error('persisted range result artifact is absent')
    return classifyDurableCtfRangeVerifiedResultArtifact(exactResult.artifact)
  }

  async #resumeOrCreateRefund(
    coordinator: DaemonCtfRangeCoordinator,
    custodyOperationId: string,
    source: DurableCtfRangeOperation,
    walletSeedHex: string,
    mint: CtfRangeMintLike & CtfRangeMintClient,
    existing: ProofOperationRecord | null,
  ): Promise<void> {
    const refund =
      existing ??
      (await this.#prepareRefundOperation(custodyOperationId, source, walletSeedHex, mint))
    assertRangeRefundOperation(refund, custodyOperationId, source)
    const refundKeysetId = readSourceText(refund, 'refundKeysetId')
    const keyset = await loadExactMintKeyset(mint, refundKeysetId)
    if (refund.state === 'completed') {
      await coordinator.completeRefund({
        custodyOperationId,
        refundOperationId: refund.operationId,
        refundProofs: completedRangeRefundProofs(refund),
        refundAsset: rangeOfferStoredAsset(source),
        observedAtMs: this.#nowMs(),
      })
      return
    }
    if (refund.state === 'Failed') {
      throw new Error(
        `Range refund operation ${refund.operationId} failed: ${refund.lastError ?? 'unknown error'}`,
      )
    }
    const outputData = deserializeOutputGroups(refund.outputs).refund ?? []
    const states = await checkCtfRangeInputProofStates(mint, refund.inputs.map(toProof))
    let proofs: Proof[]
    if (states.every(({ state }) => state === 'UNSPENT')) {
      const response = await this.#executeRefundSwap(refund.mintUrl, {
        inputs: refund.inputs.map(toProof),
        outputs: outputData.map(({ blindedMessage }) => blindedMessage),
      })
      proofs = unblindRangeRefund(outputData, response.signatures, keyset)
    } else if (states.every(({ state }) => state === 'SPENT')) {
      const restored = await (this.#dependencies.restoreOutputs ?? restoreOutputGroups)(
        refund.mintUrl,
        refund.outputs,
      )
      proofs = restored.refund ?? []
      if (proofs.length !== outputData.length) {
        throw new Error('range refund restore is incomplete')
      }
    } else {
      throw new Error('range refund remains pending at the mint')
    }
    await coordinator.completeRefund({
      custodyOperationId,
      refundOperationId: refund.operationId,
      refundProofs: proofs,
      refundAsset: rangeOfferStoredAsset(source),
      observedAtMs: this.#nowMs(),
    })
  }

  async #prepareRefundOperation(
    custodyOperationId: string,
    source: DurableCtfRangeOperation,
    walletSeedHex: string,
    mint: CtfRangeMintLike,
  ): Promise<ProofOperationRecord> {
    const keyset = await selectRangeRefundKeyset(
      mint,
      source,
      this.#nowSeconds(),
      this.#dependencies.allowInsecureLoopbackHttp === true,
    )
    const refundAmount =
      source.inputs.reduce((total, proof) => total + Amount.from(proof.amount).toBigInt(), 0n) -
      deriveDurableCtfRangeFeeBounds(source).maximumFee
    if (refundAmount <= 0n) throw new Error('range refund amount is fee-dominated')
    const operationId = deriveDurableCtfRangeRefundOperationId(source.operationId)
    const outputs = createDeterministicDurableCtfRangeRefundOutputs({
      seed: walletSeed(walletSeedHex),
      source,
      refundOperationId: operationId,
      amount: refundAmount,
      keyset,
    })
    const prepared = createDurableCtfRangeRefundOperation({
      operationId,
      source,
      refundKeysetId: keyset.id,
      resolveKeysetAsset: (id) => (id === keyset.id ? source.offerAsset : undefined),
      outputs,
    })
    const persistedOutputs = outputs.map(OutputData.deserialize)
    const mutation = this.#mutation()
    return withDurableCustodyUnitOfWork(
      this.#storage,
      mutation.fence,
      mutation.observedAtMs,
      (database) => {
        assertRangeRefundSourceLocked(
          database,
          mutation.fence.scopeId,
          custodyOperationId,
          source.inputs.length,
        )
        return prepareCtfRangeRefundProofOperationFromDatabase(
          database,
          {
            operationId: prepared.operation.operationId,
            kind: 'swap-refund',
            mintUrl: prepared.operation.mintUrl,
            inputs: prepared.request.inputs,
            outputs: { refund: serializeOutputDataArray(persistedOutputs) },
            metadata: {
              ...prepared.operation.metadata,
              purpose: CTF_RANGE_REFUND_PURPOSE,
              rangeOperationId: source.operationId,
              custodyOperationId,
              refundKeysetId: keyset.id,
            },
          },
          mutation.observedAtMs,
        )
      },
    )
  }

  async #executeRefundSwap(
    mintUrl: string,
    request: SwapRequest,
  ): Promise<{ signatures: SerializedBlindedSignature[] }> {
    return (
      this.#dependencies.executeRefundSwap?.(mintUrl, request) ??
      new CashuMint(mintUrl).swap(request)
    )
  }

  async #applyEngineResult(
    coordinator: DaemonCtfRangeCoordinator,
    custodyOperationId: string,
    operation: DurableCtfRangeOperation,
    engineResult: CtfRangeEngineResult,
    reference: { readonly artifactId: string; readonly bindingDigest: string },
    client: EngineClientLike,
    resolveKeyset: DurableCtfRangeKeysetResolver,
  ): Promise<DurableCtfRangeRecoveryDecision> {
    const decision = await coordinator.stageVerified({
      custodyOperationId,
      operation,
      envelope: engineResult.envelope,
      resolveKeyset,
      observedAtMs: this.#nowMs(),
    })
    if (decision.kind !== 'confirmed') return decision
    await coordinator.applyStaged({
      custodyOperationId,
      resolveKeyset,
      observedAtMs: this.#nowMs(),
    })
    await this.#acknowledgeResult(client, operation, reference, engineResult)
    return decision
  }

  async #completeSubmittedLifecycle(
    input: PersistedPreparationInput,
    status: OrderStatusResponse | null,
  ): Promise<void> {
    if (status === null) {
      await this.#markTerminal(input.operationId)
      return
    }
    if (input.request.timeInForce === 'FAK' && status.status === 'partially_filled') {
      await this.#markTerminal(input.operationId)
      return
    }
    if (
      status.status === 'resting' ||
      status.status === 'matched' ||
      status.status === 'partially_filled'
    ) {
      throw new Error('range result and order lifecycle disagree')
    }
    await this.#markTerminal(input.operationId)
  }

  async #cancelRestingOrderBeforeRefund(
    input: PersistedPreparationInput,
    capability: RangePreparationCapability,
    status: OrderStatusResponse | null,
    client: EngineClientLike,
  ): Promise<void> {
    if (status?.status !== 'resting') return
    if (!(await client.cancelOrder(input.request.marketId, capability.orderId))) {
      throw new Error('expired resting range order cancellation was not acknowledged')
    }
    const cancelled = await client.getOrderStatus(input.request.marketId, capability.orderId)
    if (cancelled === null || cancelled.status === 'resting') {
      throw new Error('expired resting range order remains matchable')
    }
    await recordOrderStatus(
      input.request.marketId,
      capability.orderId,
      cancelled,
      input.request.baseAsset,
      input.request.divisibility,
    )
  }

  async #acknowledgeResult(
    client: EngineClientLike,
    operation: DurableCtfRangeOperation,
    reference: SettlementCapabilityResponse['reference'],
    result: CtfRangeEngineResult,
  ): Promise<void> {
    if (result.acknowledgedAt !== null) return
    const acknowledge = client.acknowledgeSettlementCapabilityResult
    if (acknowledge === undefined) {
      throw new Error('engine client does not support settlement result acknowledgement')
    }
    const response = await acknowledge.call(client, result.resultId, {
      expectedVersion: result.version,
    })
    if (response === null) throw new Error('engine settlement result acknowledgement is missing')
    const acknowledged = decodeCtfRangeEngineResult(response, {
      operation,
      reference,
      previouslyPersistedRequestDigest: result.requestDigest,
    })
    if (
      acknowledged.resultId !== result.resultId ||
      acknowledged.version !== result.version + 1 ||
      acknowledged.settlementGroupId !== result.settlementGroupId ||
      acknowledged.settlementGroupRevision !== result.settlementGroupRevision ||
      acknowledged.acknowledgedAt === null
    ) {
      throw new Error('engine settlement result acknowledgement is foreign')
    }
  }

  async #markTerminal(rangeOperationId: string): Promise<void> {
    const mutation = this.#mutation()
    await withDurableCustodyUnitOfWork(
      this.#storage,
      mutation.fence,
      mutation.observedAtMs,
      (database) => {
        const current = readRangePreparation(database, mutation.fence.scopeId, rangeOperationId)
        if (current === null) throw new Error('daemon CTF range preparation is missing')
        if (current.lifecycleState === 'terminal') return
        transitionRangePreparation(database, {
          scopeId: mutation.fence.scopeId,
          rangeOperationId,
          expectedRevision: current.revision,
          from: current.lifecycleState,
          to: 'terminal',
          updatedAtMs: mutation.observedAtMs,
        })
      },
    )
  }

  async #prepareWalletSource(
    authority: PreparedMintAuthority,
    walletSeedHex: string,
    wallet?: CtfRangeWalletLike,
  ): Promise<SourceResult> {
    try {
      return await prepareOrResumeSource(authority, walletSeedHex, this.#dependencies, wallet)
    } catch (error) {
      if (error instanceof ProofConsolidationRequiredError) {
        await this.#markTerminal(authority.preparationInput.operationId)
      }
      throw error
    }
  }

  #createMint(mintUrl: string): CtfRangeMintLike {
    return this.#dependencies.createMint?.(mintUrl) ?? (new CashuMint(mintUrl) as CtfRangeMintLike)
  }

  #nowMs(): number {
    return this.#dependencies.now?.() ?? Date.now()
  }

  #nowSeconds(): number {
    return Math.floor(this.#nowMs() / 1_000)
  }

  #randomId(): string {
    return this.#dependencies.randomId?.() ?? randomUUID()
  }

  #mutation(): FencedStateMutation {
    return {
      fence: this.#getFence(),
      observedAtMs: this.#nowMs(),
    }
  }
}

function preparedMintAuthority(
  preparationInput: PersistedPreparationInput,
  walletSeedHex: string,
  metadata: LoadedMintMetadata,
  mint: CtfRangeMintLike,
  consolidateProofs: boolean,
  mutation: () => FencedStateMutation,
): PreparedMintAuthority {
  return {
    preparation: prepareCtfRangeOrderAuthorization({
      seed: walletSeed(walletSeedHex),
      ...withoutRequest(preparationInput),
    }),
    preparationInput,
    lookup: ctfRangeOrderPreparationKeysetLookup(preparationInput),
    observation: metadata.observation,
    mintKeysets: exactCtfRangeOrderPreparationMintKeysets(preparationInput),
    offerAsset: assetForKeyset(preparationInput.offerKeyset),
    mint,
    consolidateProofs,
    mutation,
  }
}

async function loadMintMetadata(
  mint: CtfRangeMintLike,
  mintUrl: string,
  conditionId: string,
  observedAt: number,
  allowInsecureLoopbackHttp: boolean,
): Promise<LoadedMintMetadata> {
  return loadCtfRangeMintMetadata({
    mint,
    mintUrl,
    conditionId,
    observedAt,
    allowInsecureLoopbackHttp,
  })
}

function persistedOrderRequest(
  input: PrepareSettlementCapabilityInput,
): PersistedPreparationInput['request'] {
  const {
    walletSeedHex: _,
    consolidateProofs: ___,
    ...request
  } = input
  return structuredClone(request) as PersistedPreparationInput['request']
}

function withoutRequest(
  input: PersistedPreparationInput,
): Omit<PersistedPreparationInput, 'request' | 'version'> {
  const { request: _, version: __, ...preparation } = input
  return preparation
}

async function loadEngineMarket(client: EngineClientLike, conditionId: string): Promise<unknown> {
  const market =
    client.getMarket === undefined
      ? (
          await client.queryMarkets({
            ids: [conditionId],
            state: 'All',
            limit: 1,
          })
        ).markets[0]
      : await client.getMarket(conditionId)
  if (market === undefined || market === null) throw new Error('engine market is unavailable')
  return market
}

function persistedMintAuthority(
  input: PersistedPreparationInput,
  walletSeedHex: string,
  mint: CtfRangeMintLike,
  consolidateProofs: boolean,
  mutation: () => FencedStateMutation,
): PreparedMintAuthority {
  const preparation = prepareCtfRangeOrderAuthorization({
    seed: walletSeed(walletSeedHex),
    ...withoutRequest(input),
  })
  return {
    preparation,
    preparationInput: input,
    lookup: ctfRangeOrderPreparationKeysetLookup(input),
    observation: input.expiryObservation,
    mintKeysets: exactCtfRangeOrderPreparationMintKeysets(input),
    offerAsset: assetForKeyset(input.offerKeyset),
    mint,
    consolidateProofs,
    mutation,
  }
}

interface SourceResult {
  readonly authorization: Proof[]
  readonly keep: Proof[]
}

function sourceResultRecord(result: SourceResult): Record<string, CashuProofRecord[]> {
  return {
    authorization: result.authorization.map((proof) => ({ ...proof, amount: proof.amount })),
    keep: result.keep.map((proof) => ({ ...proof, amount: proof.amount })),
  }
}

async function prepareOrResumeSource(
  authority: PreparedMintAuthority,
  walletSeedHex: string,
  dependencies: DaemonCtfRangeOrderCoordinatorDependencies,
  providedWallet?: CtfRangeWalletLike,
): Promise<SourceResult> {
  const wallet =
    providedWallet ??
    dependencies.createWallet?.(authority.preparation.mintUrl, walletSeedHex) ??
    (new CashuWallet(new CashuMint(authority.preparation.mintUrl), {
      unit: 'msat',
      bip39seed: walletSeed(walletSeedHex),
    }) as CtfRangeWalletLike)
  if (providedWallet === undefined) await wallet.loadMint()
  const existing = await getProofOperation(authority.preparation.sourceOperationId)
  if (existing !== null) {
    return resumeSourceOperation(existing, authority, wallet, dependencies)
  }
  let round = await resumeExistingConsolidations(authority, wallet, dependencies)
  const candidates = await availableSourceProofs(authority)
  const prepared = await prepareSourceOperation(authority, wallet, candidates.proofs)
  if (prepared !== null) return completeNewSource(authority, prepared, wallet)
  if (!candidates.hasMore) throw new Error('daemon has insufficient exact range-order funds')
  if (!authority.consolidateProofs) {
    throw new ProofConsolidationRequiredError()
  }

  const plan = await planSourceConsolidation(authority, MAX_CONSOLIDATION_ROUNDS - round)
  if (plan.kind !== 'ready') throw consolidationPlanError(plan.kind)
  for (const plannedRound of plan.consolidationRounds) {
    if (round >= MAX_CONSOLIDATION_ROUNDS) {
      throw new Error('range authorization exceeded the bounded consolidation round limit')
    }
    const page = await availableSourceProofs(authority)
    await consolidateSourceProofs(
      authority,
      wallet,
      walletSeedHex,
      page.proofs,
      round,
      sourceConsolidationId(authority.preparation.sourceOperationId, round),
      plannedRound,
    )
    round += 1
  }
  const consolidated = await availableSourceProofs(authority)
  const source = await prepareSourceOperation(authority, wallet, consolidated.proofs)
  if (source === null) throw new Error('range consolidation plan did not make the source fundable')
  return completeNewSource(authority, source, wallet)
}

async function resumeExistingConsolidations(
  authority: PreparedMintAuthority,
  wallet: CtfRangeWalletLike,
  dependencies: DaemonCtfRangeOrderCoordinatorDependencies,
): Promise<number> {
  for (let round = 0; round < MAX_CONSOLIDATION_ROUNDS; round += 1) {
    const operation = await getProofOperation(
      sourceConsolidationId(authority.preparation.sourceOperationId, round),
    )
    if (operation === null) return round
    await resumeConsolidationOperation(operation, authority, wallet, dependencies)
  }
  return MAX_CONSOLIDATION_ROUNDS
}

async function completeNewSource(
  authority: PreparedMintAuthority,
  source: PreparedSource,
  wallet: CtfRangeWalletLike,
): Promise<SourceResult> {
  await persistPreparedSource(authority, source)
  const result = await completePreparedSource(source, wallet)
  await markProofOperationCompletedFenced(
    authority.preparation.sourceOperationId,
    sourceResultRecord(result),
    authority.mutation(),
  )
  return result
}

type PreparedSource =
  | {
      readonly kind: 'wallet-send'
      readonly preview: SwapPreview
      readonly inputs: Proof[]
      readonly authorizationOutputs: OutputData[]
      readonly keepOutputs: OutputData[]
      readonly amount: number
      readonly fees: number
      readonly keysetId: string
    }
  | {
      readonly kind: 'conditional-keyset-swap'
      readonly preview: ConditionalSwapPreview
      readonly inputs: Proof[]
      readonly authorizationOutputs: OutputData[]
      readonly keepOutputs: OutputData[]
      readonly amount: number
      readonly fees: number
      readonly keysetId: string
    }

async function prepareSourceOperation(
  authority: PreparedMintAuthority,
  wallet: CtfRangeWalletLike,
  candidates: Proof[],
): Promise<PreparedSource | null> {
  const target = amountToNumber(
    OutputData.sumOutputAmounts(authority.preparation.authorizationOutputs),
  )
  const selected = takeProofsForLock(candidates, target, {
    [authority.preparation.offerKeysetId]: authority.preparationInput.offerKeyset.inputFeePpk,
  })
  if (selected === null) return null
  return authority.preparationInput.side === 'Buy'
    ? prepareRegularSource(authority, wallet, selected, target)
    : prepareConditionalSource(authority, wallet, selected, target)
}

async function prepareRegularSource(
  authority: PreparedMintAuthority,
  wallet: CtfRangeWalletLike,
  candidates: Proof[],
  target: number,
): Promise<PreparedSource> {
  const preview = await wallet.prepareSwapToSend(
    target,
    candidates,
    { includeFees: false, keysetId: authority.preparation.offerKeysetId },
    {
      send: { type: 'custom', data: authority.preparation.authorizationOutputs },
      keep: { type: 'random' },
    },
  )
  const authorizationOutputs = preview.sendOutputs ?? []
  assertExactOutputs(authorizationOutputs, authority.preparation.authorizationOutputs)
  if (preview.inputs.length > authority.preparationInput.maxInputs) {
    throw new Error('range authorization exceeds the mint input limit')
  }
  return {
    kind: 'wallet-send',
    preview,
    inputs: preview.inputs,
    authorizationOutputs,
    keepOutputs: preview.keepOutputs ?? [],
    amount: amountToNumber(preview.amount),
    fees: amountToNumber(preview.fees),
    keysetId: preview.keysetId,
  }
}

async function prepareConditionalSource(
  authority: PreparedMintAuthority,
  wallet: CtfRangeWalletLike,
  inputs: Proof[],
  target: number,
): Promise<PreparedSource> {
  const fees = computeInputFeeSatsForProofs(inputs, {
    [authority.preparation.offerKeysetId]: authority.preparationInput.offerKeyset.inputFeePpk,
  })
  const change = sumProofs(inputs) - fees - target
  if (change < 0) throw new Error('conditional range authorization is underfunded')
  const outputGroups: Parameters<CtfRangeWalletLike['prepareConditionalSwap']>[0]['outputs'] = [
    {
      label: 'authorization',
      kind: 'custom',
      data: authority.preparation.authorizationOutputs,
    },
  ]
  if (change > 0) outputGroups.push({ label: 'keep', kind: 'random', amount: change })
  const preview = await wallet.prepareConditionalSwap({
    keysetId: authority.preparation.offerKeysetId,
    inputs,
    outputs: outputGroups,
  })
  const authorizationOutputs = preview.outputDataByLabel.authorization ?? []
  assertExactOutputs(authorizationOutputs, authority.preparation.authorizationOutputs)
  return {
    kind: 'conditional-keyset-swap',
    preview,
    inputs: preview.inputs,
    authorizationOutputs,
    keepOutputs: preview.outputDataByLabel.keep ?? [],
    amount: target,
    fees,
    keysetId: preview.keysetId,
  }
}

async function availableSourceProofs(
  authority: PreparedMintAuthority,
): Promise<{ readonly proofs: Proof[]; readonly hasMore: boolean }> {
  const page = await readAvailableWalletProofPage({
    mintUrl: authority.preparation.mintUrl,
    keysetId: authority.preparation.offerKeysetId,
    asset: authority.offerAsset,
    limit: authority.preparationInput.maxInputs,
  })
  return {
    proofs: page.proofs.map(({ proof }) => toProof(proof)),
    hasMore: page.nextCursor !== null,
  }
}

async function planSourceConsolidation(
  authority: PreparedMintAuthority,
  maxRounds: number,
): Promise<BoundedProofConsolidationPlan> {
  const counts = new Map<number, number>()
  let after: Parameters<typeof readAvailableWalletProofPage>[0]['after']
  do {
    const page = await readAvailableWalletProofPage({
      mintUrl: authority.preparation.mintUrl,
      keysetId: authority.preparation.offerKeysetId,
      asset: authority.offerAsset,
      limit: 256,
      ...(after === undefined ? {} : { after }),
    })
    for (const { proof } of page.proofs) {
      const amount = amountToNumber(proof.amount)
      counts.set(amount, (counts.get(amount) ?? 0) + 1)
    }
    after = page.nextCursor ?? undefined
  } while (after !== undefined)
  return planBoundedProofConsolidation({
    inventory: [...counts].map(([amount, count]) => ({ amount: String(amount), count })),
    target: String(
      amountToNumber(OutputData.sumOutputAmounts(authority.preparation.authorizationOutputs)),
    ),
    inputFeePpk: authority.preparationInput.offerKeyset.inputFeePpk,
    maxInputs: authority.preparationInput.maxInputs,
    maxRounds,
    keysetKeys: authority.preparationInput.offerKeyset.keys,
  })
}

function consolidationPlanError(
  kind: Exclude<BoundedProofConsolidationPlan['kind'], 'ready'>,
): Error {
  switch (kind) {
    case 'insufficient':
      return new Error('daemon has insufficient exact range-order funds')
    case 'not-reducible':
      return new Error('range proof consolidation would not reduce the proof count')
    case 'round-limit':
      return new Error('range authorization exceeded the bounded consolidation round limit')
  }
}

async function consolidateSourceProofs(
  authority: PreparedMintAuthority,
  wallet: CtfRangeWalletLike,
  walletSeedHex: string,
  inputs: Proof[],
  round: number,
  operationId: string,
  planned: ProofConsolidationRound,
): Promise<void> {
  if (inputs.length < 2) {
    throw new Error('mint range input cap cannot support proof consolidation')
  }
  const operation = await prepareCtfRangeConsolidationOperation({
    operationId,
    rangeOperationId: authority.preparation.operationId,
    mintUrl: authority.preparation.mintUrl,
    keysetId: authority.preparation.offerKeysetId,
    outputKeyset: authority.preparationInput.offerKeyset,
    inputs,
    conditional: authority.preparationInput.side === 'Sell',
    inputFeePpk: authority.preparationInput.offerKeyset.inputFeePpk,
    plannedRound: planned,
    seed: walletSeed(walletSeedHex),
    counterSource: createDaemonCounterSource(authority.mutation, {
      normalizedMint: authority.preparation.mintUrl,
      unit: 'msat',
    }),
    wallet,
  })
  await persistAndCompleteConsolidation(authority, wallet, round, operation)
}

async function persistAndCompleteConsolidation(
  authority: PreparedMintAuthority,
  wallet: CtfRangeWalletLike,
  round: number,
  operation: ReturnType<typeof validateCtfRangeConsolidationOperation>['operation'],
): Promise<void> {
  const validated = validateCtfRangeConsolidationOperation(operation)
  const operationId = operation.operationId
  const reservationId = sourceConsolidationReservationId(operationId)
  const mutation = authority.mutation()
  await prepareProofOperationWithExactReservation(
    {
      operationId,
      kind: rangeConsolidationKind(operation.kind),
      mintUrl: authority.preparation.mintUrl,
      inputs: operation.inputs.map(toProof),
      outputs: { consolidated: serializeOutputDataArray(validated.outputs) },
      metadata: {
        purpose: CONSOLIDATION_PURPOSE,
        rangeOperationId: authority.preparation.operationId,
        sourceOperationId: authority.preparation.sourceOperationId,
        reservationId,
        unit: 'msat',
        amount: consolidationMetadataNumber(operation, 'amount'),
        fees: consolidationMetadataNumber(operation, 'fees'),
        keysetId: consolidationMetadataText(operation, 'keysetId'),
        exactOperation: structuredClone(operation),
      },
      reservationId,
      asset: authority.offerAsset,
    },
    mutation,
    (database) =>
      appendRangePreparationConsolidation(database, {
        scopeId: mutation.fence.scopeId,
        rangeOperationId: authority.preparation.operationId,
        round,
        operationId,
        reservationId,
      }),
  )
  const result = await completeCtfRangeConsolidationOperation(validated, wallet)
  await markProofOperationCompletedFenced(
    operationId,
    { consolidated: [...result] },
    authority.mutation(),
  )
  await finalizeCompletedProofReservation(
    {
      operationId,
      reservationId,
      resultGroup: 'consolidated',
      asset: authority.offerAsset,
    },
    authority.mutation(),
  )
}

function rangeConsolidationKind(value: unknown): 'proof-consolidation' {
  if (value === 'proof-consolidation') return value
  throw new Error('range consolidation operation kind is invalid')
}

function consolidationMetadataText(
  operation: ReturnType<typeof validateCtfRangeConsolidationOperation>['operation'],
  field: string,
): string {
  const value = operation.metadata?.[field]
  if (typeof value !== 'string' || value.length < 1) {
    throw new Error(`range consolidation ${field} is invalid`)
  }
  return value
}

function consolidationMetadataNumber(
  operation: ReturnType<typeof validateCtfRangeConsolidationOperation>['operation'],
  field: string,
): number {
  const value = operation.metadata?.[field]
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`range consolidation ${field} is invalid`)
  }
  return value as number
}

async function resumeConsolidationOperation(
  entry: ProofOperationRecord,
  authority: PreparedMintAuthority,
  wallet: CtfRangeWalletLike,
  dependencies: DaemonCtfRangeOrderCoordinatorDependencies,
): Promise<void> {
  assertConsolidationOperation(entry)
  const operation = persistedRangeConsolidationOperation(entry)
  let result = completedConsolidationResult(entry)
  if (entry.state === 'prepared') {
    const states = await wallet.checkProofsStates(
      entry.inputs.map(({ id, secret }) => ({
        id: requireText(id, 'consolidation keyset'),
        secret,
      })),
    )
    const decision = classifyPreparedSourceRecovery({
      journalKind: 'consolidation',
      states,
      nowUnixSeconds: Math.floor(authority.mutation().observedAtMs / 1_000),
    })
    switch (decision.kind) {
      case 'restore-exact-persisted-outputs': {
        const restored = await (dependencies.restoreOutputs ?? restoreOutputGroups)(
          entry.mintUrl,
          entry.outputs,
        )
        result = [...validateCtfRangeConsolidationProofs(operation, restored.consolidated)]
        break
      }
      case 'replay-exact-persisted-operation':
        result = [...(await completeCtfRangeConsolidationOperation(operation, wallet))]
        break
      case 'remain-pending':
        throw new Error(
          `Range consolidation ${entry.operationId} remains pending at the mint (${decision.reason})`,
        )
      default:
        throw new Error(`Range consolidation ${entry.operationId} has invalid recovery state`)
    }
    await markProofOperationCompletedFenced(
      entry.operationId,
      { consolidated: result },
      authority.mutation(),
    )
  }
  await finalizeCompletedProofReservation(
    {
      operationId: entry.operationId,
      reservationId: readSourceText(entry, 'reservationId'),
      resultGroup: 'consolidated',
      asset: authority.offerAsset,
    },
    authority.mutation(),
  )
}

function completedConsolidationResult(entry: ProofOperationRecord): Proof[] {
  if (entry.state === 'Failed') {
    throw new Error(
      `Range consolidation ${entry.operationId} failed: ${entry.lastError ?? 'unknown error'}`,
    )
  }
  if (entry.state !== 'completed') return []
  const groups = entry.resultProofs
  if (groups === undefined || Object.keys(groups).join('\0') !== 'consolidated') {
    throw new Error(`Range consolidation ${entry.operationId} result is incomplete`)
  }
  return (groups.consolidated ?? []).map(toProof)
}

async function persistPreparedSource(
  authority: PreparedMintAuthority,
  source: PreparedSource,
  residualInputs: readonly Proof[] | null = null,
): Promise<void> {
  const reservationId = sourceReservationId(authority.preparation.operationId)
  const mutation = authority.mutation()
  await prepareProofOperationWithExactReservation(
    {
      operationId: authority.preparation.sourceOperationId,
      kind: source.kind,
      mintUrl: authority.preparation.mintUrl,
      inputs: source.inputs,
      outputs: {
        authorization: serializeOutputDataArray(source.authorizationOutputs),
        keep: serializeOutputDataArray(source.keepOutputs),
      },
      metadata: {
        purpose: SOURCE_PURPOSE,
        rangeOperationId: authority.preparation.operationId,
        reservationId,
        unit: 'msat',
        sourceMode: source.kind,
        amount: source.amount,
        fees: source.fees,
        keysetId: source.keysetId,
      },
      reservationId,
      asset: authority.offerAsset,
    },
    mutation,
    (database) =>
      linkRangePreparationSource(database, {
        scopeId: mutation.fence.scopeId,
        rangeOperationId: authority.preparation.operationId,
        sourceOperationId: authority.preparation.sourceOperationId,
        reservationId,
      }),
    residualInputs === null
      ? undefined
      : (database) =>
          admitExactAvailableWalletProofsFromDatabase(database, {
            mintUrl: authority.preparation.mintUrl,
            proofs: residualInputs,
            asset: authority.offerAsset,
            nowMs: mutation.observedAtMs,
          }),
  )
}

async function completePreparedSource(
  source: PreparedSource,
  wallet: CtfRangeWalletLike,
): Promise<SourceResult> {
  if (source.kind === 'conditional-keyset-swap') {
    const result = await wallet.completeConditionalSwap(source.preview)
    return {
      authorization: result.authorization ?? [],
      keep: result.keep ?? [],
    }
  }
  const result = await wallet.completeSwap(source.preview)
  const unselected = new Set((source.preview.unselectedProofs ?? []).map(({ secret }) => secret))
  return {
    authorization: result.send,
    keep: result.keep.filter(({ secret }) => !unselected.has(secret)),
  }
}

async function resumeSourceOperation(
  entry: ProofOperationRecord,
  authority: PreparedMintAuthority,
  wallet: CtfRangeWalletLike,
  dependencies: DaemonCtfRangeOrderCoordinatorDependencies,
): Promise<SourceResult> {
  assertRangeSourceOperation(entry)
  if (entry.state === 'completed') return completedSourceResult(entry)
  if (entry.state === 'Failed') {
    throw new Error(
      `Range source operation ${entry.operationId} failed: ${entry.lastError ?? 'unknown error'}`,
    )
  }
  const states = await wallet.checkProofsStates(
    entry.inputs.map(({ id, secret }) => ({ id: requireText(id, 'source keyset'), secret })),
  )
  const decision = classifyPreparedSourceRecovery({
    journalKind: 'authorization-source',
    states,
    nowUnixSeconds: Math.floor(authority.mutation().observedAtMs / 1_000),
    authorizationExpiry: authority.preparation.expiry,
  })
  let result: SourceResult
  switch (decision.kind) {
    case 'restore-exact-persisted-outputs': {
      const restored = await (dependencies.restoreOutputs ?? restoreOutputGroups)(
        entry.mintUrl,
        entry.outputs,
      )
      result = {
        authorization: restored.authorization ?? [],
        keep: restored.keep ?? [],
      }
      break
    }
    case 'replay-exact-persisted-operation':
      result = await completePersistedSource(entry, wallet)
      break
    case 'release-exact-unspent-inputs': {
      const mutation = authority.mutation()
      await releasePreparedProofReservationFenced(
        {
          operationId: entry.operationId,
          reservationId: readSourceText(entry, 'reservationId'),
          reason: 'range-authorization-expired-unspent',
        },
        mutation,
        (database) => {
          const preparation = readRangePreparation(
            database,
            mutation.fence.scopeId,
            authority.preparation.operationId,
          )
          if (preparation === null) throw new Error('daemon CTF range preparation is missing')
          transitionRangePreparation(database, {
            scopeId: mutation.fence.scopeId,
            rangeOperationId: authority.preparation.operationId,
            expectedRevision: preparation.revision,
            from: preparation.lifecycleState,
            to: 'terminal',
            updatedAtMs: mutation.observedAtMs,
          })
        },
      )
      throw new RangeSourceReleasedError(entry.operationId)
    }
    case 'remain-pending':
      throw new Error(
        `Range source operation ${entry.operationId} remains pending at the mint (${decision.reason})`,
      )
    default:
      throw new Error(`Range source operation ${entry.operationId} has invalid recovery state`)
  }
  await markProofOperationCompletedFenced(
    entry.operationId,
    sourceResultRecord(result),
    authority.mutation(),
  )
  return result
}

async function completePersistedSource(
  entry: ProofOperationRecord,
  wallet: CtfRangeWalletLike,
): Promise<SourceResult> {
  const outputs = deserializeOutputGroups(entry.outputs)
  if (entry.kind === 'conditional-keyset-swap') {
    const result = await wallet.completeConditionalSwap({
      keysetId: readSourceText(entry, 'keysetId'),
      inputs: entry.inputs.map(toProof),
      outputDataByLabel: outputs,
    })
    return { authorization: result.authorization ?? [], keep: result.keep ?? [] }
  }
  const result = await wallet.completeSwap({
    amount: Amount.from(readSourceNumber(entry, 'amount')),
    fees: Amount.from(readSourceNumber(entry, 'fees')),
    keysetId: readSourceText(entry, 'keysetId'),
    inputs: entry.inputs.map(toProof),
    sendOutputs: outputs.authorization ?? [],
    keepOutputs: outputs.keep ?? [],
    unselectedProofs: [],
  })
  return { authorization: result.send, keep: result.keep }
}

function completedSourceResult(entry: ProofOperationRecord): SourceResult {
  const groups = entry.resultProofs
  if (groups === undefined || Object.keys(groups).sort().join('\0') !== 'authorization\0keep') {
    throw new Error(`Range source operation ${entry.operationId} result is incomplete`)
  }
  return {
    authorization: (groups.authorization ?? []).map(toProof),
    keep: (groups.keep ?? []).map(toProof),
  }
}

function assertRangeSourceOperation(entry: ProofOperationRecord): void {
  if (
    entry.metadata.purpose !== SOURCE_PURPOSE ||
    entry.metadata.unit !== 'msat' ||
    (entry.kind !== 'wallet-send' && entry.kind !== 'conditional-keyset-swap')
  ) {
    throw new Error(`Proof operation ${entry.operationId} is not a range source`)
  }
  requireText(entry.metadata.rangeOperationId, 'range operation id')
  requireText(entry.metadata.reservationId, 'source reservation')
}

function assertConsolidationOperation(entry: ProofOperationRecord): void {
  if (
    entry.metadata.purpose !== CONSOLIDATION_PURPOSE ||
    entry.metadata.unit !== 'msat' ||
    entry.kind !== 'proof-consolidation'
  ) {
    throw new Error(`Proof operation ${entry.operationId} is not a range consolidation`)
  }
  requireText(entry.metadata.rangeOperationId, 'range operation id')
  requireText(entry.metadata.sourceOperationId, 'range source operation id')
  requireText(entry.metadata.reservationId, 'consolidation reservation')
}

function persistedRangeConsolidationOperation(
  entry: ProofOperationRecord,
): DurableCustodyProofOperationInput {
  const validated = validateCtfRangeConsolidationOperation(
    entry.metadata.exactOperation as DurableCustodyProofOperationInput,
  )
  const operation = validated.operation
  if (
    operation.operationId !== entry.operationId ||
    operation.kind !== rangeConsolidationKind(entry.kind) ||
    operation.mintUrl !== entry.mintUrl ||
    !isDeepStrictEqual(operation.inputs, entry.inputs) ||
    !isDeepStrictEqual({ consolidated: serializeOutputDataArray(validated.outputs) }, entry.outputs)
  ) {
    throw new Error('daemon range consolidation journal differs from its exact operation')
  }
  return operation
}

async function createRangeBinding(
  walletSeedHex: string,
  operation: DurableCtfRangeOperation,
  mintKeysets: ReadonlyMap<string, DurableCtfRangeMintKeyset>,
  request: CreateSettlementCapabilityRequest,
) {
  const proofOperation = toDurableCtfRangeProofOperationInput(operation)
  const facts = await resolveDurableCustodyProofOperationFacts({
    operation: proofOperation,
    resolveMintKeys: async () =>
      new Map(
        [...mintKeysets].map(([id, keyset]) => [
          id,
          {
            id,
            unit: keyset.unit,
            keys: keyset.keys,
            ...(keyset.finalExpiry === null ? {} : { final_expiry: keyset.finalExpiry }),
          },
        ]),
      ),
    requireDleq: true,
  })
  return createDurableCtfRangeCustodyBinding({
    scope: walletScope(walletSeedHex),
    operation,
    facts,
    mintKeysets,
    inventoryAccountId: null,
    boundary: {
      method: 'POST',
      path: '/api/v1/settlement-capabilities',
      idempotencyKey: request.stageIdempotencyKey,
      requestBody: request,
    },
  })
}

function walletScope(walletSeedHex: string): DurableCustodyScope {
  const walletId = deriveDurableCustodyWalletId(walletSeed(walletSeedHex))
  return {
    scopeKind: 'wallet',
    walletId,
    scopeId: deriveDurableCustodyScopeId({ scopeKind: 'wallet', walletId }),
  }
}

function rangeCustodyOperationId(walletSeedHex: string, rangeOperationId: string): string {
  const scope = walletScope(walletSeedHex)
  return deriveDurableCustodyOperationId(scope.scopeId, {
    retainedOperationKey: rangeOperationId,
    binding: {
      kind: 'wallet',
      activityId: rangeOperationId,
      stage: 'send',
    },
  })
}

function assetForKeyset(
  keyset: ActiveCtfRangeMintKeyset & {
    conditionId?: string
    outcomeCollection?: string
  },
): StoredProofAsset {
  return keyset.conditionId === undefined || keyset.outcomeCollection === undefined
    ? { kind: 'sats', baseAsset: 'sat', unit: 'msat' }
    : {
        kind: 'Outcome',
        conditionId: keyset.conditionId,
        outcomeSetId: keyset.outcomeCollection,
        baseAsset: 'sat',
        unit: 'msat',
      }
}

function rangeOfferStoredAsset(operation: DurableCtfRangeOperation): StoredProofAsset {
  switch (operation.offerAsset.kind) {
    case 'regular':
      return { kind: 'sats', baseAsset: 'sat', unit: 'msat' }
    case 'conditional':
      return {
        kind: 'Outcome',
        conditionId: operation.offerAsset.conditionId,
        outcomeSetId: operation.offerAsset.outcomeCollection,
        baseAsset: 'sat',
        unit: 'msat',
      }
    default:
      throw new Error('range refund offered asset is invalid')
  }
}

async function selectRangeRefundKeyset(
  mint: CtfRangeMintLike,
  source: DurableCtfRangeOperation,
  observedAt: number,
  allowInsecureLoopbackHttp: boolean,
): Promise<ActiveCtfRangeMintKeyset> {
  const metadata = await loadMintMetadata(
    mint,
    source.mintUrl,
    source.conditionId,
    observedAt,
    allowInsecureLoopbackHttp,
  )
  let candidates: ActiveCtfRangeMintKeyset[]
  switch (source.offerAsset.kind) {
    case 'regular':
      candidates = metadata.regular
      break
    case 'conditional':
      const offeredAsset = source.offerAsset
      candidates = metadata.conditional.filter(
        ({ conditionId, outcomeCollection }) =>
          conditionId === offeredAsset.conditionId &&
          outcomeCollection === offeredAsset.outcomeCollection,
      )
      break
    default:
      throw new Error('range refund offered asset is invalid')
  }
  const selected = [...candidates].sort((left, right) => left.id.localeCompare(right.id))[0]
  if (selected === undefined) throw new Error('mint has no active same-class refund keyset')
  return selected
}

async function loadExactMintKeyset(mint: CtfRangeMintLike, keysetId: string): Promise<MintKeys> {
  const keyset = (await loadMintKeys(mint, [keysetId])).get(keysetId)
  if (keyset === undefined || keyset.unit !== 'msat') {
    throw new Error('range refund keyset authority is unavailable')
  }
  return keyset
}

function assertRangeRefundOperation(
  refund: ProofOperationRecord,
  custodyOperationId: string,
  source: DurableCtfRangeOperation,
): void {
  if (
    refund.operationId !== deriveDurableCtfRangeRefundOperationId(source.operationId) ||
    refund.kind !== 'swap-refund' ||
    refund.mintUrl !== source.mintUrl ||
    refund.metadata.purpose !== CTF_RANGE_REFUND_PURPOSE ||
    refund.metadata.rangeOperationId !== source.operationId ||
    refund.metadata.custodyOperationId !== custodyOperationId ||
    refund.metadata.unit !== 'msat' ||
    typeof refund.metadata.refundKeysetId !== 'string' ||
    refund.metadata.refundKeysetId.length === 0 ||
    Object.keys(refund.outputs).join('\0') !== 'refund' ||
    refund.inputs.length !== source.inputs.length ||
    refund.inputs.some(
      (proof, index) =>
        !sameProofWithoutWitness(proof, source.inputs[index]!) || proof.witness === undefined,
    )
  ) {
    throw new Error('range refund operation differs from its source authority')
  }
}

function sameProofWithoutWitness(left: CashuProofRecord, right: DurableCtfRangeProof): boolean {
  return (
    left.id === right.id &&
    String(amountToNumber(left.amount)) === right.amount &&
    left.secret === right.secret &&
    left.C === right.C &&
    isDeepStrictEqual(left.dleq ?? null, right.dleq ?? null) &&
    (left.p2pk_e ?? null) === right.p2pkE
  )
}

function completedRangeRefundProofs(refund: ProofOperationRecord): Proof[] {
  if (
    refund.state !== 'completed' ||
    refund.resultProofs === undefined ||
    Object.keys(refund.resultProofs).join('\0') !== 'refund' ||
    refund.resultProofs.refund === undefined ||
    refund.resultProofs.refund.length === 0
  ) {
    throw new Error('range refund result authority is incomplete')
  }
  return refund.resultProofs.refund.map(toProof)
}

function unblindRangeRefund(
  outputs: readonly OutputData[],
  signatures: readonly SerializedBlindedSignature[],
  keyset: MintKeys,
): Proof[] {
  if (outputs.length === 0 || signatures.length !== outputs.length) {
    throw new Error('range refund mint response is incomplete')
  }
  return outputs.map((output, index) => output.toProof(signatures[index]!, keyset))
}

function assertRangeRefundSourceLocked(
  database: Parameters<typeof prepareCtfRangeRefundProofOperationFromDatabase>[0],
  scopeId: string,
  custodyOperationId: string,
  inputCount: number,
): void {
  const operation = database
    .prepare(
      `SELECT operation_state AS operationState, result_state AS resultState
       FROM custody_operations
       WHERE scope_id = ? AND operation_id = ?`,
    )
    .get(scopeId, custodyOperationId) as { operationState: string; resultState: string } | undefined
  const locked = database
    .prepare(
      `SELECT count(*) AS count
       FROM custody_operation_inputs AS inputs
       JOIN custody_proof_reservations AS reservations
         ON reservations.scope_id = inputs.scope_id
        AND reservations.proof_id = inputs.proof_id
        AND reservations.operation_id = inputs.operation_id
       JOIN custody_proofs AS proofs
         ON proofs.scope_id = inputs.scope_id
        AND proofs.proof_id = inputs.proof_id
       WHERE inputs.scope_id = ? AND inputs.operation_id = ?
         AND proofs.nut07_state = 'UNSPENT'
         AND proofs.selectability = 'locked'
         AND proofs.reservation_operation_id = inputs.operation_id`,
    )
    .get(scopeId, custodyOperationId) as { count: number }
  if (
    operation?.operationState !== 'dispatch-intent' ||
    operation.resultState !== 'none' ||
    locked.count !== inputCount
  ) {
    throw new Error('range refund source custody authority is not locked')
  }
}

function assertExactOutputs(actual: readonly OutputData[], expected: readonly OutputData[]): void {
  const serialize = (outputs: readonly OutputData[]) =>
    outputs.map((output) => OutputData.serialize(output))
  if (JSON.stringify(serialize(actual)) !== JSON.stringify(serialize(expected))) {
    throw new Error('cashu wallet substituted exact range authorization outputs')
  }
}

function sourceReservationId(operationId: string): string {
  return `ctf-range-source:${operationId}`
}

function sourceConsolidationId(sourceOperationId: string, round: number): string {
  return `${sourceOperationId}:consolidation:${round}`
}

function sourceConsolidationReservationId(operationId: string): string {
  return `ctf-range-consolidation:${operationId}`
}

async function sourceConsolidationSummary(sourceOperationId: string): Promise<{
  operationIds: string[]
  feeSubunits: number
}> {
  const operationIds: string[] = []
  let feeSubunits = 0
  for (let round = 0; round < MAX_CONSOLIDATION_ROUNDS; round += 1) {
    const operationId = sourceConsolidationId(sourceOperationId, round)
    const operation = await getProofOperation(operationId)
    if (operation === null) break
    assertConsolidationOperation(operation)
    operationIds.push(operationId)
    feeSubunits += readSourceNumber(operation, 'fees')
    if (!Number.isSafeInteger(feeSubunits)) {
      throw new Error('range consolidation fee total exceeds the safe integer bound')
    }
  }
  return { operationIds, feeSubunits }
}

function toProof(value: CashuProofRecord): Proof {
  return {
    id: requireText(value.id, 'proof keyset'),
    amount: Amount.from(amountToNumber(value.amount)),
    secret: requireText(value.secret, 'proof secret'),
    C: requireText(value.C, 'proof signature'),
    ...(value.dleq === undefined ? {} : { dleq: structuredClone(value.dleq) as never }),
    ...(value.p2pk_e === undefined ? {} : { p2pk_e: value.p2pk_e }),
    ...(value.witness === undefined ? {} : { witness: structuredClone(value.witness) as never }),
  }
}

function walletSeed(value: string): Uint8Array {
  if (!/^[0-9a-f]{128}$/.test(value)) throw new Error('wallet seed must be 64-byte lowercase hex')
  return Buffer.from(value, 'hex')
}

function classifyPreparedSourceRecovery(input: {
  readonly journalKind: 'authorization-source' | 'consolidation'
  readonly states: readonly ProofState[]
  readonly nowUnixSeconds: number
  readonly authorizationExpiry?: number
}): CtfRangeSourceRecoveryDecision {
  return classifyCtfRangeSourceRecovery({
    journalKind: input.journalKind,
    journalState: 'prepared',
    inputStates: input.states.map(({ state }) => state),
    now: input.nowUnixSeconds,
    ...(input.authorizationExpiry === undefined
      ? {}
      : { authorizationExpiry: input.authorizationExpiry }),
  })
}

function readSourceText(entry: ProofOperationRecord, key: string): string {
  return requireText(entry.metadata[key], `source ${key}`)
}

function readSourceNumber(entry: ProofOperationRecord, key: string): number {
  const value = entry.metadata[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Range source operation ${entry.operationId} has invalid ${key}`)
  }
  return value
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error(`${label} is invalid`)
  }
  return value
}
