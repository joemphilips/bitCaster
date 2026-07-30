import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  Amount,
  Mint as CashuMint,
  OutputData,
  Wallet as CashuWallet,
  type ConditionalSwapPreview,
  type GetInfoResponse,
  type MintKeys,
  type MintKeyset,
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
  type DurableCustodyScope,
} from '@bitcaster-market/client-sdk'
import {
  completeCtfRangeOrderAuthorization,
  prepareCtfRangeOrderAuthorization,
  type ActiveCtfRangeMintKeyset,
  type CtfRangeOrderPreparation,
} from '@bitcaster-market/client-sdk/ctfRangeOrderPreparation'
import {
  createDurableCtfRangeCustodyBinding,
  createDurableCtfRangeRefundOperation,
  deriveDurableCtfRangeFeeBounds,
  deriveDurableCtfResidualDecision,
  toDurableCtfRangeProofOperationInput,
  type DurableCtfRangeExpiryObservation,
  type DurableCtfRangeKeysetResolver,
  type DurableCtfRangeMintKeyset,
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
  createPoolSettlementCapabilityArtifact,
  deriveSettlementCapabilityArtifactDigest,
  encodeSettlementCapabilityArtifact,
} from '@bitcaster-market/client-sdk/settlementCapabilityArtifact'
import {
  canonicalizeOutcomeSet,
  complementOutcomeSetId,
  parseMarketOutcomes,
} from '@bitcaster-market/client-sdk/outcomeSets'
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
  canonicalizeTokenImportMintUrl,
  type TokenImportKeysetLookup,
} from '@bitcaster-market/client-sdk/tokenImportValidation'
import type {
  CreateSettlementCapabilityRequest,
  OrderStatusResponse,
  SettlementCapabilityResultResponse,
  SettlementCapabilityAdmissionPolicyResponse,
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
  recordOrderStatus,
  recordSubmittedOrder,
  releasePreparedProofReservationFenced,
  type CashuProofRecord,
  type FencedStateMutation,
  type ProofOperationRecord,
  type StoredProofAsset,
} from './state.ts'
import {
  appendRangePreparationConsolidation,
  bindRangePreparationCapability,
  decodeCanonicalRangePreparation,
  encodeCanonicalRangePreparation,
  insertRangePreparation,
  linkRangePreparationSource,
  pageActiveRangePreparations,
  readActiveRangePreparationByClientOrderId,
  readRangePreparation,
  transitionRangePreparation,
  type RangePreparationCapability,
  type RangePreparationRecord,
} from './ctfRangeOrderJournalSqlite.ts'
import {
  withDurableCustodyFencedRead,
  withDurableCustodyUnitOfWork,
} from './durableCustodyUnitOfWork.ts'
import { createDaemonStateSqliteSession, type DaemonStateSqliteSession } from './stateSqlite.ts'
import {
  deserializeOutputGroups,
  restoreOutputGroups,
  serializeOutputDataArray,
} from './walletOps.ts'
import type {
  EngineClientLike,
  PreparedSettlementCapability,
  PrepareSettlementCapabilityInput,
} from './server.ts'

const MINT_KEYSET_CANDIDATE_LIMIT = 256
const SETTLEMENT_INPUT_LIMIT = 64
const SETTLEMENT_POOL_ENTRY_LIMIT = 128
const SOURCE_PURPOSE = 'ctf-range-authorization-source'
const CONSOLIDATION_PURPOSE = 'ctf-range-authorization-consolidation'
const ACTIVE_RANGE_SOURCE_LIMIT = 256
const MAX_CONSOLIDATION_ROUNDS = 256
const RANGE_REFUND_SAFETY_MARGIN_SECONDS = 300
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/

interface CtfRangeMintLike {
  getInfo(): Promise<GetInfoResponse>
  getKeySets(): Promise<{ keysets: MintKeyset[] }>
  getConditionalKeysets(query?: { since?: number; limit?: number; active?: boolean }): Promise<{
    keysets: Array<{
      id: string
      unit: string
      active: boolean
      input_fee_ppk?: number
      final_expiry?: number
      registered_at?: number
      condition_id: string
      outcome_collection: string
      outcome_collection_id: string
    }>
  }>
  getCtfCondition(conditionId: string): Promise<{
    condition_id: string
    keysets: Record<string, string>
  }>
  getKeys(keysetId?: string): Promise<{ keysets: MintKeys[] }>
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
      keep: { type: 'random' }
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
}

interface PreparedMintAuthority {
  readonly preparation: CtfRangeOrderPreparation
  readonly preparationInput: PersistedPreparationInput
  readonly lookup: TokenImportKeysetLookup
  readonly observation: DurableCtfRangeExpiryObservation
  readonly mintKeysets: ReadonlyMap<string, DurableCtfRangeMintKeyset>
  readonly offerAsset: StoredProofAsset
  readonly mint: CtfRangeMintLike
  readonly mutation: () => FencedStateMutation
}

interface PersistedPreparationInput {
  readonly version: 1
  readonly operationId: string
  readonly sourceOperationId: string
  readonly sourceKind: 'wallet-prepared' | 'residual-change'
  readonly predecessorRangeOperationId: string | null
  readonly authorizationId: string
  readonly mintUrl: string
  readonly conditionId: string
  readonly coordinatorPublicKey: string
  readonly side: 'Buy' | 'Sell'
  readonly priceNumerator: number
  readonly amountSubunits: number
  readonly divisibility: number
  readonly offerKeyset: ActiveCtfRangeMintKeyset
  readonly receiveKeyset: ActiveCtfRangeMintKeyset
  readonly expiryObservation: DurableCtfRangeExpiryObservation
  readonly expiry: number
  readonly maxPoolEntries: number
  readonly maxInputs: number
  readonly request: Omit<PrepareSettlementCapabilityInput, 'walletSeedHex'>
}

class RangeSourceReleasedError extends Error {
  constructor(operationId: string) {
    super(`Range source operation ${operationId} expired before mint commitment`)
    this.name = 'RangeSourceReleasedError'
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
    const source = await prepareOrResumeSource(authority, request.walletSeedHex, this.#dependencies)
    const operation = completeCtfRangeOrderAuthorization({
      preparation: authority.preparation,
      inputs: source.authorization,
      keysetLookup: authority.lookup,
      expiryObservation: authority.observation,
      allowInsecureLoopbackHttp: this.#dependencies.allowInsecureLoopbackHttp === true,
    })
    const capabilityRequest = createCapabilityRequest(request, operation)
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
    const createCapability = client.createSettlementCapability
    if (createCapability === undefined) {
      throw new Error('engine client does not support settlement capability creation')
    }
    const capability = await createCapability.call(client, capabilityRequest)
    assertCapabilityResponse(capability, request, operation, false)
    await this.#bindCapability(operation.operationId, capability)
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
    const preparations = await this.#activeRangePreparations()
    const result: DaemonCtfRangeRecoveryResult = { recovered: [], pending: [] }
    for (const preparation of preparations) {
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
    if (
      preparationRecord.lifecycleState === 'order-submitted' ||
      preparationRecord.lifecycleState === 'submission-rejected'
    ) {
      await this.#recoverSubmittedOrder(preparationRecord, preparationInput, walletSeedHex, client)
      return
    }
    const authority = persistedMintAuthority(
      preparationInput,
      walletSeedHex,
      this.#createMint(preparationInput.mintUrl),
      this.#mutation.bind(this),
    )
    let sourceResult: SourceResult
    let residualSpentInputs: readonly Proof[] | null = null
    if (preparationInput.sourceKind === 'residual-change') {
      const candidates = await this.#loadResidualSource(preparationInput, walletSeedHex)
      const wallet =
        this.#dependencies.createWallet?.(authority.preparation.mintUrl, walletSeedHex) ??
        (new CashuWallet(new CashuMint(authority.preparation.mintUrl), {
          unit: 'msat',
          bip39seed: walletSeed(walletSeedHex),
        }) as CtfRangeWalletLike)
      await wallet.loadMint()
      const residual = await prepareOrResumeResidualSource(
        authority,
        wallet,
        candidates.authorization,
        this.#dependencies,
      )
      sourceResult = residual
      residualSpentInputs = residual.spentInputs
    } else {
      const wallet =
        this.#dependencies.createWallet?.(authority.preparation.mintUrl, walletSeedHex) ??
        (new CashuWallet(new CashuMint(authority.preparation.mintUrl), {
          unit: 'msat',
          bip39seed: walletSeed(walletSeedHex),
        }) as CtfRangeWalletLike)
      await wallet.loadMint()
      try {
        sourceResult = await prepareOrResumeSource(
          authority,
          walletSeedHex,
          this.#dependencies,
          wallet,
        )
      } catch (error) {
        if (error instanceof RangeSourceReleasedError) return
        throw error
      }
    }
    const operation = completeCtfRangeOrderAuthorization({
      preparation: authority.preparation,
      inputs: sourceResult.authorization,
      keysetLookup: authority.lookup,
      expiryObservation: authority.observation,
      allowInsecureLoopbackHttp: this.#dependencies.allowInsecureLoopbackHttp === true,
    })
    const capabilityRequest = createCapabilityRequest(preparationInput.request, operation)
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
    if (preparationInput.sourceKind === 'residual-change') {
      if (residualSpentInputs === null) {
        throw new Error('residual range source inputs are missing')
      }
      await rangeCoordinator.bindResidualPreparedSource({
        ...bindInput,
        spentSourceProofs: residualSpentInputs,
      })
    } else {
      await rangeCoordinator.bindPreparedSource(bindInput)
    }
    const createCapability = client.createSettlementCapability
    if (createCapability === undefined) {
      throw new Error('engine client does not support settlement capability creation')
    }
    const capability = await createCapability.call(client, capabilityRequest)
    assertCapabilityResponse(capability, preparationInput.request, operation, true)
    await this.#bindCapability(operation.operationId, capability)
    await submitRecoveredOrder(client, preparationInput.request, capability)
    await this.#markOrderSubmitted(operation.operationId)
    throw new RangeRecoveryDeferredError(
      'recovered range order was submitted and remains pending settlement',
      this.#nowMs() + 30_000,
    )
  }

  async #loadResidualSource(
    input: PersistedPreparationInput,
    walletSeedHex: string,
  ): Promise<SourceResult> {
    const predecessorOperationId = input.predecessorRangeOperationId
    if (predecessorOperationId === null) {
      throw new Error('residual range predecessor authority is missing')
    }
    const predecessor = await withDurableCustodyFencedRead(
      this.#storage,
      this.#getFence(),
      this.#nowMs(),
      (database) => {
        const record = readRangePreparation(
          database,
          this.#getFence().scopeId,
          predecessorOperationId,
        )
        if (record === null) throw new Error('residual range predecessor is missing')
        return preparationFromJournal(record)
      },
    )
    if (
      predecessor.operationId !== predecessorOperationId ||
      predecessor.request.clientOrderId !== input.request.clientOrderId ||
      predecessor.request.marketId !== input.request.marketId
    ) {
      throw new Error('residual range predecessor identity is foreign')
    }
    const rangeCoordinator = new DaemonCtfRangeCoordinator(this.#directory, this.#getFence())
    const custodyOperationId = rangeCustodyOperationId(walletSeedHex, predecessorOperationId)
    const loaded = await rangeCoordinator.load(custodyOperationId)
    if (loaded === null) throw new Error('residual range custody authority is missing')
    const result = await rangeCoordinator.readAppliedResult({
      custodyOperationId,
      resolveKeyset: persistedRangeKeysetResolver(predecessor),
    })
    const residual = deriveDurableCtfResidualDecision({
      source: loaded.operation,
      result,
      remainingOrderAmount: input.amountSubunits,
      restingOrder: true,
    })
    if (
      residual.kind !== 'awaiting-authorization' ||
      residual.predecessorOperationId !== predecessorOperationId
    ) {
      throw new Error('residual range predecessor has no returned change authority')
    }
    return { authorization: residual.sourceProofs, keep: [] }
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
    const preparationInput = buildPreparationInput({
      request,
      coordinatorPublicKey: requireCoordinatorKey(policy),
      metadata,
      market,
      now: this.#nowSeconds(),
      randomId: this.#randomId.bind(this),
    })
    const durablePreparation = await this.#persistPreparation(preparationInput)
    return preparedMintAuthority(
      durablePreparation,
      request.walletSeedHex,
      metadata,
      mint,
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
        return record === null
          ? null
          : preparationFromJournal(record, persistedOrderRequest(request))
      },
    )
  }

  async #persistPreparation(input: PersistedPreparationInput): Promise<PersistedPreparationInput> {
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
        if (existing !== null) return preparationFromJournal(existing, input.request)
        return preparationFromJournal(
          insertRangePreparation(database, {
            scopeId: mutation.fence.scopeId,
            rangeOperationId: input.operationId,
            sourceOperationId: input.sourceOperationId,
            sourceKind: input.sourceKind,
            predecessorRangeOperationId: input.predecessorRangeOperationId,
            authorizationId: input.authorizationId,
            clientOrderId: input.request.clientOrderId,
            marketId: input.request.marketId,
            normalizedMint: input.mintUrl,
            conditionId: input.conditionId,
            unit: 'msat',
            tokenSide: input.request.tokenSide,
            side: input.side,
            priceSubunits: input.priceNumerator,
            amountSubunits: input.amountSubunits,
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

  async #activeRangePreparations(): Promise<RangePreparationRecord[]> {
    const observedAtMs = this.#nowMs()
    return withDurableCustodyFencedRead(
      this.#storage,
      this.#getFence(),
      observedAtMs,
      (database) => {
        const result: RangePreparationRecord[] = []
        let after: Parameters<typeof pageActiveRangePreparations>[1]['after']
        do {
          const page = pageActiveRangePreparations(database, {
            scopeId: this.#getFence().scopeId,
            limit: 64,
            ...(after === undefined ? {} : { after }),
          })
          for (const record of page.preparations) {
            preparationFromJournal(record)
            result.push(record)
            if (result.length > ACTIVE_RANGE_SOURCE_LIMIT) {
              throw new Error('active daemon CTF range recovery set exceeds its bound')
            }
          }
          after = page.nextCursor ?? undefined
        } while (after !== undefined)
        return result
      },
    )
  }

  async #bindCapability(
    rangeOperationId: string,
    capability: SettlementCapabilityResponse,
  ): Promise<void> {
    const mutation = this.#mutation()
    await withDurableCustodyUnitOfWork(
      this.#storage,
      mutation.fence,
      mutation.observedAtMs,
      (database) => {
        const current = readRangePreparation(database, mutation.fence.scopeId, rangeOperationId)
        if (current === null) throw new Error('daemon CTF range preparation is missing')
        const expected = rangePreparationCapability(capability)
        if (current.lifecycleState !== 'prepared') {
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
    const getResult = client.getSettlementCapabilityResultByOperation
    if (getResult === undefined) {
      throw new Error('engine client does not support settlement result recovery')
    }
    const reference = {
      artifactId: capability.artifactId,
      bindingDigest: capability.bindingDigest,
    }
    const response = await getResult.call(client, input.operationId)
    const coordinator = new DaemonCtfRangeCoordinator(this.#directory, this.#getFence())
    const custodyOperationId = rangeCustodyOperationId(walletSeedHex, input.operationId)
    const loaded = await coordinator.load(custodyOperationId)
    if (loaded === null) throw new Error('daemon CTF range custody authority is missing')
    const mint = this.#createMint(input.mintUrl) as CtfRangeMintLike & CtfRangeMintClient
    const status = await client.getOrderStatus(input.request.marketId, capability.orderId)
    if (status === null && preparation.lifecycleState !== 'submission-rejected') {
      throw new Error('submitted range order status is unavailable')
    }
    if (status !== null) {
      await recordOrderStatus(
        input.request.marketId,
        capability.orderId,
        status,
        input.request.baseAsset,
        input.request.divisibility,
      )
    }
    const refundOperationId = rangeRefundOperationId(input.operationId)
    const existingRefund = response === null ? await getProofOperation(refundOperationId) : null
    if (existingRefund !== null) {
      await this.#cancelRestingOrderBeforeRefund(input, capability, status, client)
      await this.#resumeOrCreateRefund(
        coordinator,
        custodyOperationId,
        loaded.operation,
        mint,
        existingRefund,
      )
      await this.#markTerminal(input.operationId)
      return
    }
    const recovery = new CtfRangeMintRecoveryAdapter(loaded.operation, mint)
    const verification = await recovery.loadExactVerificationContext(loaded.record)
    const decision =
      response === null
        ? await this.#classifyMintRecovery(
            coordinator,
            custodyOperationId,
            loaded.operation,
            verification,
            mint,
          )
        : await this.#applyEngineResult(
            coordinator,
            custodyOperationId,
            loaded.operation,
            verification,
            response,
            reference,
            client,
          )
    switch (decision.kind) {
      case 'confirmed':
        await this.#completeSubmittedLifecycle(
          preparation,
          input,
          walletSeedHex,
          client,
          loaded.operation,
          decision.result,
          status,
        )
        return
      case 'waiting':
        throw new RangeRecoveryDeferredError(
          'submitted range authorization remains unspent before expiry',
          loaded.operation.expiry * 1_000 + 1_000,
        )
      case 'refundable':
        await this.#cancelRestingOrderBeforeRefund(input, capability, status, client)
        await this.#resumeOrCreateRefund(
          coordinator,
          custodyOperationId,
          loaded.operation,
          mint,
          null,
        )
        await this.#markTerminal(input.operationId)
        return
      case 'reconciling':
        throw new Error('submitted range result remains reconciling')
      default:
        throw new Error('submitted range recovery decision is invalid')
    }
  }

  async #classifyMintRecovery(
    coordinator: DaemonCtfRangeCoordinator,
    custodyOperationId: string,
    operation: DurableCtfRangeOperation,
    verification: Awaited<ReturnType<CtfRangeMintRecoveryAdapter['loadExactVerificationContext']>>,
    mint: CtfRangeMintLike & CtfRangeMintClient,
  ): Promise<DurableCtfRangeRecoveryDecision> {
    const observation = {
      selection: null,
      inputStates: await checkCtfRangeInputProofStates(mint, operation.inputs),
      ...verification.allManifestRecovery,
      now: Math.floor(this.#nowMs() / 1_000),
    }
    const decision = await coordinator.classifyRecovery({
      custodyOperationId,
      observation,
      resolveKeyset: verification.resolveKeyset,
    })
    if (decision.kind !== 'confirmed') return decision
    const staged = await coordinator.stageRecovered({
      custodyOperationId,
      observation,
      resolveKeyset: verification.resolveKeyset,
      observedAtMs: this.#nowMs(),
    })
    if (staged.kind !== 'confirmed') return staged
    await coordinator.applyStaged({
      custodyOperationId,
      resolveKeyset: verification.resolveKeyset,
      observedAtMs: this.#nowMs(),
    })
    return staged
  }

  async #resumeOrCreateRefund(
    coordinator: DaemonCtfRangeCoordinator,
    custodyOperationId: string,
    source: DurableCtfRangeOperation,
    mint: CtfRangeMintLike & CtfRangeMintClient,
    existing: ProofOperationRecord | null,
  ): Promise<void> {
    const refund =
      existing ?? (await this.#prepareRefundOperation(custodyOperationId, source, mint))
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
    const outputs = OutputData.createRandomData(Amount.from(refundAmount), keyset)
    const prepared = createDurableCtfRangeRefundOperation({
      operationId: rangeRefundOperationId(source.operationId),
      source,
      refundKeysetId: keyset.id,
      resolveKeysetAsset: (id) => (id === keyset.id ? source.offerAsset : undefined),
      outputs: outputs.map(OutputData.serialize),
    })
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
            outputs: { refund: serializeOutputDataArray(outputs) },
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
    verification: Awaited<ReturnType<CtfRangeMintRecoveryAdapter['loadExactVerificationContext']>>,
    response: SettlementCapabilityResultResponse,
    reference: { readonly artifactId: string; readonly bindingDigest: string },
    client: EngineClientLike,
  ): Promise<DurableCtfRangeRecoveryDecision> {
    const engineResult = decodeCtfRangeEngineResult(response, { operation, reference })
    const decision = await coordinator.stageVerified({
      custodyOperationId,
      operation,
      envelope: engineResult.envelope,
      allManifestRecovery: verification.allManifestRecovery,
      resolveKeyset: verification.resolveKeyset,
      observedAtMs: this.#nowMs(),
    })
    if (decision.kind !== 'confirmed') return decision
    await coordinator.applyStaged({
      custodyOperationId,
      resolveKeyset: verification.resolveKeyset,
      observedAtMs: this.#nowMs(),
    })
    await this.#acknowledgeResult(client, operation, reference, engineResult)
    return decision
  }

  async #completeSubmittedLifecycle(
    preparation: RangePreparationRecord,
    input: PersistedPreparationInput,
    walletSeedHex: string,
    client: EngineClientLike,
    operation: DurableCtfRangeOperation,
    result: Extract<DurableCtfRangeRecoveryDecision, { kind: 'confirmed' }>['result'],
    status: OrderStatusResponse | null,
  ): Promise<void> {
    if (status === null) {
      await this.#markTerminal(input.operationId)
      return
    }
    const residual = deriveDurableCtfResidualDecision({
      source: operation,
      result,
      remainingOrderAmount: status.remainingAmountSubunits,
      restingOrder: status.status === 'awaiting_authorization',
    })
    if (residual.kind === 'awaiting-authorization') {
      await this.#reauthorizeResidual(
        preparation,
        input,
        walletSeedHex,
        client,
        Number(residual.remainingOrderAmount),
      )
      return
    }
    if (
      input.request.timeInForce === 'FAK' &&
      status.status === 'partially_filled' &&
      residual.kind === 'none'
    ) {
      await this.#markTerminal(input.operationId)
      return
    }
    if (
      status.status === 'resting' ||
      status.status === 'matched' ||
      status.status === 'partially_filled' ||
      status.status === 'awaiting_authorization'
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

  async #reauthorizeResidual(
    predecessor: RangePreparationRecord,
    predecessorInput: PersistedPreparationInput,
    walletSeedHex: string,
    client: EngineClientLike,
    remainingAmountSubunits: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(remainingAmountSubunits) || remainingAmountSubunits <= 0) {
      throw new Error('residual range amount is invalid')
    }
    const getPolicy = client.getSettlementCapabilityAdmissionPolicy
    if (getPolicy === undefined) {
      throw new Error('engine client does not expose settlement admission policy')
    }
    const mint = this.#createMint(predecessorInput.mintUrl)
    const [policy, metadata, market] = await Promise.all([
      getPolicy.call(client),
      loadMintMetadata(
        mint,
        predecessorInput.mintUrl,
        predecessorInput.conditionId,
        this.#nowSeconds(),
        this.#dependencies.allowInsecureLoopbackHttp === true,
      ),
      loadEngineMarket(client, predecessorInput.conditionId),
    ])
    const proposed = buildPreparationInput({
      request: { ...predecessorInput.request, walletSeedHex },
      coordinatorPublicKey: requireCoordinatorKey(policy),
      metadata,
      market,
      now: this.#nowSeconds(),
      randomId: this.#randomId.bind(this),
      authorizationAmountSubunits: remainingAmountSubunits,
      sourceKind: 'residual-change',
      predecessorRangeOperationId: predecessorInput.operationId,
    })
    const successor = await this.#persistResidualPreparation(predecessor, proposed)
    await this.#recoverPreparation(successor.record, successor.input, walletSeedHex, client)
  }

  async #persistResidualPreparation(
    predecessor: RangePreparationRecord,
    proposed: PersistedPreparationInput,
  ): Promise<{ record: RangePreparationRecord; input: PersistedPreparationInput }> {
    const mutation = this.#mutation()
    return withDurableCustodyUnitOfWork(
      this.#storage,
      mutation.fence,
      mutation.observedAtMs,
      (database) => {
        const active = readActiveRangePreparationByClientOrderId(
          database,
          mutation.fence.scopeId,
          predecessor.clientOrderId,
        )
        if (active !== null && active.rangeOperationId !== predecessor.rangeOperationId) {
          const input = preparationFromJournal(active, proposed.request)
          if (
            input.sourceKind !== 'residual-change' ||
            input.predecessorRangeOperationId !== predecessor.rangeOperationId
          ) {
            throw new Error('daemon residual range successor conflicts with active authority')
          }
          return { record: active, input }
        }
        const current = readRangePreparation(
          database,
          mutation.fence.scopeId,
          predecessor.rangeOperationId,
        )
        if (current === null) throw new Error('daemon residual range predecessor is missing')
        if (current.lifecycleState !== 'terminal') {
          transitionRangePreparation(database, {
            scopeId: mutation.fence.scopeId,
            rangeOperationId: current.rangeOperationId,
            expectedRevision: current.revision,
            from: current.lifecycleState,
            to: 'terminal',
            updatedAtMs: mutation.observedAtMs,
          })
        }
        const record = insertRangePreparation(database, {
          scopeId: mutation.fence.scopeId,
          rangeOperationId: proposed.operationId,
          sourceOperationId: proposed.sourceOperationId,
          sourceKind: proposed.sourceKind,
          predecessorRangeOperationId: proposed.predecessorRangeOperationId,
          authorizationId: proposed.authorizationId,
          clientOrderId: proposed.request.clientOrderId,
          marketId: proposed.request.marketId,
          normalizedMint: proposed.mintUrl,
          conditionId: proposed.conditionId,
          unit: 'msat',
          tokenSide: proposed.request.tokenSide,
          side: proposed.side,
          priceSubunits: proposed.priceNumerator,
          amountSubunits: proposed.amountSubunits,
          divisibility: proposed.divisibility as 10_000 | 1_000_000,
          authorizationExpiresAtUnixSeconds: proposed.expiry,
          preparationBytes: encodeCanonicalRangePreparation(proposed),
          createdAtMs: mutation.observedAtMs,
        })
        return { record, input: preparationFromJournal(record, proposed.request) }
      },
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

async function submitRecoveredOrder(
  client: EngineClientLike,
  request: PersistedPreparationInput['request'],
  capability: SettlementCapabilityResponse,
): Promise<void> {
  const submitted = await client.submitOrder(request.marketId, {
    settlementCapability: capability.reference,
    comment: null,
  })
  if (submitted.orderId !== capability.orderId) {
    throw new Error('recovered engine order differs from its settlement capability')
  }
  await recordSubmittedOrder(
    request.marketId,
    request.clientOrderId,
    submitted,
    null,
    request.tokenSide,
    request.side,
    request.price,
    request.amountSubunits,
    request.baseAsset,
    request.divisibility,
  )
}

function preparedMintAuthority(
  preparationInput: PersistedPreparationInput,
  walletSeedHex: string,
  metadata: LoadedMintMetadata,
  mint: CtfRangeMintLike,
  mutation: () => FencedStateMutation,
): PreparedMintAuthority {
  return {
    preparation: prepareCtfRangeOrderAuthorization({
      seed: walletSeed(walletSeedHex),
      ...withoutRequest(preparationInput),
    }),
    preparationInput,
    lookup: keysetLookupFromPreparation(preparationInput),
    observation: metadata.observation,
    mintKeysets: exactPreparationMintKeysets(preparationInput),
    offerAsset: assetForKeyset(preparationInput.offerKeyset),
    mint,
    mutation,
  }
}

interface LoadedMintMetadata {
  readonly regular: ActiveCtfRangeMintKeyset[]
  readonly conditional: Array<
    ActiveCtfRangeMintKeyset & {
      readonly conditionId: string
      readonly outcomeCollection: string
      readonly outcomeCollectionId: string
    }
  >
  readonly conditionKeysetIds: string[]
  readonly maxInputs: number
  readonly maxPoolEntries: number
  readonly maxExpirySeconds: number
  readonly observation: DurableCtfRangeExpiryObservation
}

async function loadMintMetadata(
  mint: CtfRangeMintLike,
  mintUrl: string,
  conditionId: string,
  observedAt: number,
  allowInsecureLoopbackHttp: boolean,
): Promise<LoadedMintMetadata> {
  const [info, regularResponse, condition] = await Promise.all([
    mint.getInfo(),
    mint.getKeySets(),
    mint.getCtfCondition(conditionId),
  ])
  if (condition.condition_id !== conditionId) {
    throw new Error('mint returned a foreign CTF condition')
  }
  const conditionKeysetIds = [...new Set(Object.values(condition.keysets))].sort()
  if (conditionKeysetIds.length === 0 || conditionKeysetIds.length > MINT_KEYSET_CANDIDATE_LIMIT) {
    throw new Error('mint CTF condition keyset count is unsupported')
  }
  const conditionEntries = await loadConditionKeysets(mint, conditionKeysetIds)
  const keyIds = [
    ...new Set([
      ...regularResponse.keysets
        .filter((keyset) => keyset.active && keyset.unit === 'msat')
        .map(({ id }) => id),
      ...conditionKeysetIds,
    ]),
  ]
  if (keyIds.length === 0 || keyIds.length > MINT_KEYSET_CANDIDATE_LIMIT) {
    throw new Error('mint keyset authority count is unsupported')
  }
  const keys = await loadMintKeys(mint, keyIds)
  const limits = settlementLimits(info)
  const canonicalMintUrl = canonicalizeTokenImportMintUrl(mintUrl, allowInsecureLoopbackHttp)
  return buildLoadedMintMetadata({
    canonicalMintUrl,
    regularResponse: regularResponse.keysets,
    conditionEntries,
    conditionKeysetIds,
    keys,
    limits,
    observedAt,
  })
}

type ConditionalKeysetEntry = Awaited<
  ReturnType<CtfRangeMintLike['getConditionalKeysets']>
>['keysets'][number]

async function loadConditionKeysets(
  mint: CtfRangeMintLike,
  conditionKeysetIds: readonly string[],
): Promise<ConditionalKeysetEntry[]> {
  const targets = new Set(conditionKeysetIds)
  const found = new Map<string, ConditionalKeysetEntry>()
  let since: number | undefined
  let priorPage = ''
  for (let pageNumber = 0; pageNumber < 16; pageNumber += 1) {
    const response = await mint.getConditionalKeysets({
      limit: MINT_KEYSET_CANDIDATE_LIMIT,
      ...(since === undefined ? {} : { since }),
    })
    if (response.keysets.length > MINT_KEYSET_CANDIDATE_LIMIT) {
      throw new Error('mint exceeded the conditional keyset page limit')
    }
    for (const keyset of response.keysets) {
      if (targets.has(keyset.id)) found.set(keyset.id, keyset)
    }
    if (found.size === targets.size) {
      return [...found.values()].sort((left, right) => left.id.localeCompare(right.id))
    }
    if (response.keysets.length < MINT_KEYSET_CANDIDATE_LIMIT) break
    const page = response.keysets.map(({ id }) => id).join('\0')
    const registeredAt = response.keysets.at(-1)?.registered_at
    if (
      page === priorPage ||
      !Number.isSafeInteger(registeredAt) ||
      (since !== undefined && (registeredAt as number) < since)
    ) {
      throw new Error('mint conditional keyset pagination did not advance')
    }
    priorPage = page
    since = registeredAt as number
  }
  throw new Error('mint CTF condition keyset authority is incomplete')
}

async function loadMintKeys(
  mint: CtfRangeMintLike,
  keysetIds: readonly string[],
): Promise<ReadonlyMap<string, MintKeys>> {
  const keys = new Map<string, MintKeys>()
  for (let offset = 0; offset < keysetIds.length; offset += 8) {
    const page = keysetIds.slice(offset, offset + 8)
    const responses = await Promise.all(page.map((keysetId) => mint.getKeys(keysetId)))
    responses.forEach((response, index) => {
      const expectedId = page[index]!
      const keyset = response.keysets.find(({ id }) => id === expectedId)
      if (keyset === undefined) throw new Error(`mint omitted keys for keyset ${expectedId}`)
      keys.set(expectedId, keyset)
    })
  }
  return keys
}

function buildLoadedMintMetadata(input: {
  canonicalMintUrl: string
  regularResponse: MintKeyset[]
  conditionEntries: Array<{
    id: string
    unit: string
    active: boolean
    input_fee_ppk?: number
    final_expiry?: number
    condition_id: string
    outcome_collection: string
    outcome_collection_id: string
  }>
  conditionKeysetIds: string[]
  keys: ReadonlyMap<string, MintKeys>
  limits: ReturnType<typeof settlementLimits>
  observedAt: number
}): LoadedMintMetadata {
  const regular = input.regularResponse
    .filter((keyset) => keyset.active && keyset.unit === 'msat')
    .map((keyset) => activeKeyset(input.canonicalMintUrl, keyset, input.keys))
  const allConditional = input.conditionEntries.map((keyset) => ({
    ...resolvedKeyset(input.canonicalMintUrl, keyset, input.keys),
    active: keyset.active,
    conditionId: keyset.condition_id,
    outcomeCollection: keyset.outcome_collection,
    outcomeCollectionId: keyset.outcome_collection_id,
  }))
  const conditional = allConditional
    .filter((keyset) => keyset.active)
    .map((keyset) => ({ ...keyset, active: true as const }))
  if (regular.length === 0 || conditional.length === 0) {
    throw new Error('mint has no active msat range-order keyset authority')
  }
  return {
    regular,
    conditional,
    conditionKeysetIds: input.conditionKeysetIds,
    ...input.limits,
    observation: loadedExpiryObservation(input, allConditional),
  }
}

function loadedExpiryObservation(
  input: Parameters<typeof buildLoadedMintMetadata>[0],
  conditional: Array<
    DurableCtfRangeMintKeyset & {
      conditionId: string
      outcomeCollection: string
      outcomeCollectionId: string
    }
  >,
): DurableCtfRangeExpiryObservation {
  return {
    canonicalMintUrl: input.canonicalMintUrl,
    freshness: 'fresh',
    observedAt: input.observedAt,
    maxExpirySeconds: input.limits.maxExpirySeconds,
    conditionKeysetIds: input.conditionKeysetIds,
    conditionalKeysets: conditional.map((keyset) => ({
      keysetId: keyset.id,
      conditionId: keyset.conditionId,
      unit: keyset.unit,
      inputFeePpk: keyset.inputFeePpk,
      ...(keyset.finalExpiry === null ? {} : { finalExpiry: keyset.finalExpiry }),
      outcomeCollectionId: keyset.outcomeCollectionId,
      keys: keyset.keys,
    })),
  }
}

function activeKeyset(
  canonicalMintUrl: string,
  metadata: {
    id: string
    unit: string
    active: boolean
    input_fee_ppk?: number
    final_expiry?: number
  },
  keys: ReadonlyMap<string, MintKeys>,
): ActiveCtfRangeMintKeyset {
  if (!metadata.active) throw new Error(`mint keyset ${metadata.id} is inactive`)
  return { ...resolvedKeyset(canonicalMintUrl, metadata, keys), active: true }
}

function resolvedKeyset(
  canonicalMintUrl: string,
  metadata: {
    id: string
    unit: string
    input_fee_ppk?: number
    final_expiry?: number
  },
  keys: ReadonlyMap<string, MintKeys>,
): DurableCtfRangeMintKeyset {
  const resolved = keys.get(metadata.id)
  if (
    resolved === undefined ||
    resolved.id !== metadata.id ||
    resolved.unit !== 'msat' ||
    metadata.unit !== 'msat'
  ) {
    throw new Error(`mint keyset ${metadata.id} is foreign`)
  }
  return {
    canonicalMintUrl,
    id: metadata.id,
    unit: 'msat',
    keys: Object.fromEntries(
      Object.entries(resolved.keys).map(([amount, publicKey]) => [amount, publicKey]),
    ),
    inputFeePpk: positiveInteger(metadata.input_fee_ppk, 'mint input fee'),
    finalExpiry:
      metadata.final_expiry === undefined
        ? null
        : positiveInteger(metadata.final_expiry, 'mint keyset final expiry'),
  }
}

function durableMintKeyset(keyset: ActiveCtfRangeMintKeyset): DurableCtfRangeMintKeyset {
  const { active: _, ...durable } = keyset
  return durable
}

function settlementLimits(info: GetInfoResponse): {
  readonly maxInputs: number
  readonly maxPoolEntries: number
  readonly maxExpirySeconds: number
} {
  const nuts = info.nuts as unknown as Record<string, unknown>
  const setting = requireRecord(nuts['CTF-split-merge'], 'mint CTF settlement setting')
  if (setting.supported !== true || setting.partial_fill !== true) {
    throw new Error('mint does not support CTF range settlement')
  }
  return {
    maxInputs: Math.min(
      positiveInteger(setting.max_inputs, 'mint settlement input limit'),
      SETTLEMENT_INPUT_LIMIT,
    ),
    maxPoolEntries: Math.min(
      positiveInteger(setting.max_pool_entries, 'mint settlement pool limit'),
      SETTLEMENT_POOL_ENTRY_LIMIT,
    ),
    maxExpirySeconds: positiveInteger(setting.max_expiry_seconds, 'mint settlement expiry limit'),
  }
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function buildPreparationInput(input: {
  request: PrepareSettlementCapabilityInput
  coordinatorPublicKey: string
  metadata: LoadedMintMetadata
  market: unknown
  now: number
  randomId: () => string
  authorizationAmountSubunits?: number
  sourceKind?: PersistedPreparationInput['sourceKind']
  predecessorRangeOperationId?: string | null
}): PersistedPreparationInput {
  const selectedCollection = selectedOutcomeCollection(
    input.market,
    input.request.outcomeId,
    input.request.tokenSide,
  )
  const { regular, conditional } = selectPreparationKeysets(
    input.metadata,
    input.request.conditionId,
    selectedCollection,
  )
  const ceiling = effectiveExpiryCeiling(input.metadata.observation)
  const expiry = ceiling - RANGE_REFUND_SAFETY_MARGIN_SECONDS
  if (expiry <= input.now) {
    throw new Error('mint CTF range authorization horizon is exhausted')
  }
  const operationId = input.randomId()
  const sourceKind = input.sourceKind ?? 'wallet-prepared'
  return {
    version: 1,
    operationId,
    sourceOperationId: `${operationId}:source`,
    sourceKind,
    predecessorRangeOperationId: input.predecessorRangeOperationId ?? null,
    authorizationId: input.randomId(),
    mintUrl: input.metadata.observation.canonicalMintUrl,
    conditionId: input.request.conditionId,
    coordinatorPublicKey: input.coordinatorPublicKey,
    side: input.request.side,
    priceNumerator: input.request.price,
    amountSubunits: input.authorizationAmountSubunits ?? input.request.amountSubunits,
    divisibility: input.request.divisibility,
    offerKeyset: input.request.side === 'Buy' ? regular : conditional,
    receiveKeyset: input.request.side === 'Buy' ? conditional : regular,
    expiryObservation: input.metadata.observation,
    expiry,
    maxPoolEntries: input.metadata.maxPoolEntries,
    maxInputs: input.metadata.maxInputs,
    request: persistedOrderRequest(input.request),
  }
}

function selectPreparationKeysets(
  metadata: LoadedMintMetadata,
  conditionId: string,
  selectedCollection: string,
): {
  regular: ActiveCtfRangeMintKeyset
  conditional: LoadedMintMetadata['conditional'][number]
} {
  const regular = [...metadata.regular].sort(
    (left, right) =>
      left.inputFeePpk - right.inputFeePpk ||
      (right.finalExpiry ?? Number.MAX_SAFE_INTEGER) -
        (left.finalExpiry ?? Number.MAX_SAFE_INTEGER) ||
      left.id.localeCompare(right.id),
  )[0]
  const conditional = metadata.conditional.find(
    (keyset) =>
      keyset.conditionId === conditionId &&
      keyset.outcomeCollection === selectedCollection &&
      keyset.active,
  )
  if (regular === undefined || conditional === undefined) {
    throw new Error('mint does not expose the selected active range keysets')
  }
  return { regular, conditional }
}

function persistedOrderRequest(
  input: PrepareSettlementCapabilityInput,
): Omit<PrepareSettlementCapabilityInput, 'walletSeedHex'> {
  const { walletSeedHex: _, ...request } = input
  return structuredClone(request)
}

function withoutRequest(
  input: PersistedPreparationInput,
): Omit<PersistedPreparationInput, 'request' | 'version'> {
  const { request: _, version: __, ...preparation } = input
  return preparation
}

function effectiveExpiryCeiling(observation: DurableCtfRangeExpiryObservation): number {
  const fallback = observation.observedAt + observation.maxExpirySeconds
  if (!Number.isSafeInteger(fallback)) {
    throw new Error('mint settlement expiry ceiling exceeds the safe integer range')
  }
  return observation.conditionalKeysets.reduce((ceiling, keyset) => {
    const finalExpiry = keyset.finalExpiry
    return finalExpiry === undefined
      ? ceiling
      : Math.min(ceiling, positiveInteger(finalExpiry, 'condition keyset final expiry'))
  }, fallback)
}

function selectedOutcomeCollection(
  market: unknown,
  outcomeId: string,
  tokenSide: 'Outcome' | 'Complement',
): string {
  const outcomes = extractMarketOutcomes(market)
  if (outcomes.length < 2) throw new Error('engine market outcome authority is incomplete')
  const selected = outcomes.find(
    (outcome) => outcome.id === outcomeId || outcome.label === outcomeId,
  )
  if (selected === undefined) throw new Error('selected outcome is absent from the engine market')
  const primitive = canonicalizeOutcomeSet([selected.label])
  const collection =
    tokenSide === 'Outcome'
      ? primitive
      : complementOutcomeSetId(
          outcomes.map(({ label }) => label),
          primitive,
        )
  return requireText(collection, 'selected outcome collection')
}

function extractMarketOutcomes(market: unknown): Array<{ id: string; label: string }> {
  return parseMarketOutcomes(market)
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

function requireCoordinatorKey(policy: SettlementCapabilityAdmissionPolicyResponse): string {
  const key = requireText(policy.coordinatorPubkey, 'coordinator public key')
  if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error('coordinator public key is invalid')
  return key.toLowerCase()
}

function preparationFromJournal(
  record: RangePreparationRecord,
  expectedRequest?: PersistedPreparationInput['request'],
): PersistedPreparationInput {
  const value = requireRecord(
    decodeCanonicalRangePreparation(record.preparationBytes),
    'range preparation input',
  )
  const request = requireRecord(value.request, 'range preparation request')
  const input = structuredClone(value) as unknown as PersistedPreparationInput
  assertPersistedPreparationShape(input, request)
  if (
    input.operationId !== record.rangeOperationId ||
    input.sourceOperationId !== record.sourceOperationId ||
    input.sourceKind !== record.sourceKind ||
    input.predecessorRangeOperationId !== record.predecessorRangeOperationId ||
    input.authorizationId !== record.authorizationId ||
    input.request.clientOrderId !== record.clientOrderId ||
    input.request.marketId !== record.marketId ||
    input.mintUrl !== record.normalizedMint ||
    input.request.mintUrl !== record.normalizedMint ||
    input.conditionId !== record.conditionId ||
    input.request.conditionId !== input.conditionId ||
    input.request.tokenSide !== record.tokenSide ||
    input.side !== record.side ||
    input.request.side !== record.side ||
    input.priceNumerator !== record.priceSubunits ||
    input.request.price !== record.priceSubunits ||
    input.amountSubunits !== record.amountSubunits ||
    (input.sourceKind === 'wallet-prepared' &&
      input.request.amountSubunits !== record.amountSubunits) ||
    (input.sourceKind === 'residual-change' &&
      input.request.amountSubunits < record.amountSubunits) ||
    input.divisibility !== record.divisibility ||
    input.request.divisibility !== record.divisibility ||
    input.expiry !== record.authorizationExpiresAtUnixSeconds ||
    input.request.baseAsset !== 'sat' ||
    input.request.collateralUnit !== 'msat' ||
    'walletSeedHex' in request ||
    (expectedRequest !== undefined && !isDeepStrictEqual(input.request, expectedRequest))
  ) {
    throw new Error(`Range operation ${record.rangeOperationId} preparation is foreign`)
  }
  return input
}

function assertPersistedPreparationShape(
  input: PersistedPreparationInput,
  request: Record<string, unknown>,
): void {
  if (input.version !== 1) throw new Error('range preparation version is unsupported')
  for (const [label, value] of [
    ['operation id', input.operationId],
    ['source operation id', input.sourceOperationId],
    ['authorization id', input.authorizationId],
    ['mint URL', input.mintUrl],
    ['condition id', input.conditionId],
    ['coordinator key', input.coordinatorPublicKey],
  ] as const) {
    requireText(value, `range preparation ${label}`)
  }
  if (!/^[0-9a-f]{64}$/.test(input.coordinatorPublicKey)) {
    throw new Error('range preparation coordinator key is invalid')
  }
  if (input.side !== 'Buy' && input.side !== 'Sell') {
    throw new Error('range preparation side is invalid')
  }
  if (
    (input.sourceKind === 'wallet-prepared' && input.predecessorRangeOperationId !== null) ||
    (input.sourceKind === 'residual-change' &&
      (typeof input.predecessorRangeOperationId !== 'string' ||
        input.predecessorRangeOperationId.length === 0 ||
        input.predecessorRangeOperationId === input.operationId))
  ) {
    throw new Error('range preparation predecessor authority is invalid')
  }
  for (const [label, value] of [
    ['price', input.priceNumerator],
    ['amount', input.amountSubunits],
    ['divisibility', input.divisibility],
    ['expiry', input.expiry],
    ['pool limit', input.maxPoolEntries],
    ['input limit', input.maxInputs],
  ] as const) {
    positiveInteger(value, `range preparation ${label}`)
  }
  assertPersistedKeyset(input.offerKeyset)
  assertPersistedKeyset(input.receiveKeyset)
  assertPersistedExpiryObservation(input.expiryObservation)
  assertPersistedOrderRequest(request)
}

function assertPersistedKeyset(value: ActiveCtfRangeMintKeyset): void {
  if (
    value.active !== true ||
    value.unit !== 'msat' ||
    typeof value.canonicalMintUrl !== 'string' ||
    typeof value.id !== 'string' ||
    !Number.isSafeInteger(value.inputFeePpk) ||
    value.inputFeePpk <= 0 ||
    (value.finalExpiry !== null &&
      (!Number.isSafeInteger(value.finalExpiry) || value.finalExpiry <= 0))
  ) {
    throw new Error('range preparation keyset is invalid')
  }
  const keys = requireRecord(value.keys, 'range preparation keyset keys')
  if (
    Object.keys(keys).length === 0 ||
    Object.entries(keys).some(
      ([amount, publicKey]) => !/^[1-9][0-9]*$/.test(amount) || typeof publicKey !== 'string',
    )
  ) {
    throw new Error('range preparation keyset keys are invalid')
  }
}

function assertPersistedExpiryObservation(value: DurableCtfRangeExpiryObservation): void {
  if (
    value.freshness !== 'fresh' ||
    typeof value.canonicalMintUrl !== 'string' ||
    !Number.isSafeInteger(value.observedAt) ||
    value.observedAt < 0 ||
    !Number.isSafeInteger(value.maxExpirySeconds) ||
    value.maxExpirySeconds <= 0 ||
    !Array.isArray(value.conditionKeysetIds) ||
    value.conditionKeysetIds.length === 0 ||
    value.conditionKeysetIds.some((id) => typeof id !== 'string' || id.length === 0) ||
    !Array.isArray(value.conditionalKeysets) ||
    value.conditionalKeysets.length === 0
  ) {
    throw new Error('range preparation expiry observation is invalid')
  }
}

function assertPersistedOrderRequest(request: Record<string, unknown>): void {
  for (const field of ['clientOrderId', 'marketId', 'conditionId', 'outcomeId', 'mintUrl']) {
    requireText(request[field], `range preparation request ${field}`)
  }
  if (
    (request.tokenSide !== 'Outcome' && request.tokenSide !== 'Complement') ||
    (request.side !== 'Buy' && request.side !== 'Sell') ||
    request.baseAsset !== 'sat' ||
    request.collateralUnit !== 'msat' ||
    (request.timeInForce !== 'FAK' &&
      request.timeInForce !== 'FOK' &&
      request.timeInForce !== 'GTC') ||
    request.expiresAt !== null
  ) {
    throw new Error('range preparation request enum is invalid')
  }
  for (const field of ['price', 'amountSubunits', 'divisibility']) {
    positiveInteger(request[field], `range preparation request ${field}`)
  }
}

function keysetLookupFromPreparation(input: PersistedPreparationInput): TokenImportKeysetLookup {
  const keysets = [input.offerKeyset, input.receiveKeyset]
  const regularKeysets = keysets
    .filter((keyset) => !hasConditionalMetadata(keyset))
    .map((keyset) => preparationKeysetMetadata(keyset))
  const conditionalKeysets = keysets.filter(hasConditionalMetadata).map((keyset) => ({
    ...preparationKeysetMetadata(keyset),
    conditionId: keyset.conditionId,
    outcomeCollection: keyset.outcomeCollection,
    outcomeCollectionId: keyset.outcomeCollectionId,
  }))
  if (regularKeysets.length !== 1 || conditionalKeysets.length !== 1) {
    throw new Error('range preparation keyset source authority is incomplete')
  }
  return {
    canonicalMintUrl: input.mintUrl,
    freshness: 'fresh',
    regularKeysets,
    conditionalKeysets,
  }
}

function exactPreparationMintKeysets(
  input: PersistedPreparationInput,
): ReadonlyMap<string, DurableCtfRangeMintKeyset> {
  return new Map(
    [input.offerKeyset, input.receiveKeyset].map((keyset) => [
      keyset.id,
      durableMintKeyset(keyset),
    ]),
  )
}

function persistedRangeKeysetResolver(
  input: PersistedPreparationInput,
): DurableCtfRangeKeysetResolver {
  const keysets = exactPreparationMintKeysets(input)
  return (mintUrl, keysetId) => (mintUrl === input.mintUrl ? keysets.get(keysetId) : undefined)
}

function persistedMintAuthority(
  input: PersistedPreparationInput,
  walletSeedHex: string,
  mint: CtfRangeMintLike,
  mutation: () => FencedStateMutation,
): PreparedMintAuthority {
  const preparation = prepareCtfRangeOrderAuthorization({
    seed: walletSeed(walletSeedHex),
    ...withoutRequest(input),
  })
  return {
    preparation,
    preparationInput: input,
    lookup: keysetLookupFromPreparation(input),
    observation: input.expiryObservation,
    mintKeysets: exactPreparationMintKeysets(input),
    offerAsset: assetForKeyset(input.offerKeyset),
    mint,
    mutation,
  }
}

function preparationKeysetMetadata(keyset: ActiveCtfRangeMintKeyset) {
  return {
    keysetId: keyset.id,
    unit: keyset.unit,
    active: keyset.active,
    inputFeePpk: keyset.inputFeePpk,
    ...(keyset.finalExpiry === null ? {} : { finalExpiry: keyset.finalExpiry }),
  }
}

function hasConditionalMetadata(
  keyset: ActiveCtfRangeMintKeyset,
): keyset is ActiveCtfRangeMintKeyset & {
  conditionId: string
  outcomeCollection: string
  outcomeCollectionId: string
} {
  const value = keyset as ActiveCtfRangeMintKeyset & {
    conditionId?: unknown
    outcomeCollection?: unknown
    outcomeCollectionId?: unknown
  }
  return (
    typeof value.conditionId === 'string' &&
    typeof value.outcomeCollection === 'string' &&
    typeof value.outcomeCollectionId === 'string'
  )
}

interface SourceResult {
  readonly authorization: Proof[]
  readonly keep: Proof[]
}

interface ResidualSourceResult extends SourceResult {
  readonly spentInputs: Proof[]
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

  const plan = await planSourceConsolidation(authority, MAX_CONSOLIDATION_ROUNDS - round)
  if (plan.kind !== 'ready') throw consolidationPlanError(plan.kind)
  for (const plannedRound of plan.consolidationRounds) {
    if (round >= MAX_CONSOLIDATION_ROUNDS) {
      throw new Error('range authorization exceeded the bounded consolidation round limit')
    }
    const page = await availableSourceProofs(authority)
    assertPlannedConsolidationInputs(page.proofs, plannedRound.inputs)
    await consolidateSourceProofs(
      authority,
      wallet,
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

async function prepareOrResumeResidualSource(
  authority: PreparedMintAuthority,
  wallet: CtfRangeWalletLike,
  candidates: readonly Proof[],
  dependencies: DaemonCtfRangeOrderCoordinatorDependencies,
): Promise<ResidualSourceResult> {
  const existing = await getProofOperation(authority.preparation.sourceOperationId)
  if (existing !== null) {
    const result = await resumeSourceOperation(existing, authority, wallet, dependencies)
    return { ...result, spentInputs: existing.inputs.map(toProof) }
  }
  const source = await prepareSourceOperation(authority, wallet, [...candidates])
  if (source === null) {
    throw new Error('returned residual change cannot fund its replacement authorization')
  }
  await persistPreparedSource(authority, source, candidates)
  const result = await completePreparedSource(source, wallet)
  await markProofOperationCompletedFenced(
    authority.preparation.sourceOperationId,
    sourceResultRecord(result),
    authority.mutation(),
  )
  return { ...result, spentInputs: source.inputs }
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

function assertPlannedConsolidationInputs(
  proofs: readonly Proof[],
  expectedAmounts: readonly string[],
): void {
  const actual = proofs.map(({ amount }) => String(amountToNumber(amount)))
  if (!isDeepStrictEqual(actual, expectedAmounts)) {
    throw new Error('range proof inventory changed after consolidation planning')
  }
}

async function consolidateSourceProofs(
  authority: PreparedMintAuthority,
  wallet: CtfRangeWalletLike,
  inputs: Proof[],
  round: number,
  operationId: string,
  planned: ProofConsolidationRound,
): Promise<void> {
  if (inputs.length < 2) {
    throw new Error('mint range input cap cannot support proof consolidation')
  }
  const fees = computeInputFeeSatsForProofs(inputs, {
    [authority.preparation.offerKeysetId]: authority.preparationInput.offerKeyset.inputFeePpk,
  })
  const outputAmount = sumProofs(inputs) - fees
  if (outputAmount <= 0) {
    throw new Error('range proof consolidation fee consumes its complete input')
  }
  if (String(fees) !== planned.fee) {
    throw new Error('range proof consolidation fee differs from its preflight plan')
  }
  const prepared = await prepareConsolidation(authority, wallet, inputs, outputAmount, fees)
  if (prepared.outputs.length >= prepared.inputs.length) {
    throw new Error('range proof consolidation would not reduce the proof count')
  }
  assertPlannedConsolidationOutputs(prepared.outputs, planned.outputs)
  await persistAndCompleteConsolidation(
    authority,
    wallet,
    round,
    operationId,
    outputAmount,
    fees,
    prepared,
  )
}

async function persistAndCompleteConsolidation(
  authority: PreparedMintAuthority,
  wallet: CtfRangeWalletLike,
  round: number,
  operationId: string,
  outputAmount: number,
  fees: number,
  prepared: PreparedConsolidation,
): Promise<void> {
  const reservationId = sourceConsolidationReservationId(operationId)
  const mutation = authority.mutation()
  await prepareProofOperationWithExactReservation(
    {
      operationId,
      kind: prepared.kind,
      mintUrl: authority.preparation.mintUrl,
      inputs: prepared.inputs,
      outputs: { consolidated: serializeOutputDataArray(prepared.outputs) },
      metadata: {
        purpose: CONSOLIDATION_PURPOSE,
        rangeOperationId: authority.preparation.operationId,
        sourceOperationId: authority.preparation.sourceOperationId,
        reservationId,
        unit: 'msat',
        amount: outputAmount,
        fees,
        keysetId: prepared.keysetId,
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
  const result =
    prepared.kind === 'wallet-send'
      ? await completeRegularConsolidation(prepared.preview, wallet)
      : ((await wallet.completeConditionalSwap(prepared.preview)).consolidated ?? [])
  await markProofOperationCompletedFenced(
    operationId,
    { consolidated: result },
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

function prepareConsolidation(
  authority: PreparedMintAuthority,
  wallet: CtfRangeWalletLike,
  inputs: Proof[],
  outputAmount: number,
  fees: number,
): Promise<PreparedConsolidation> {
  return authority.preparationInput.side === 'Buy'
    ? prepareRegularConsolidation(authority, wallet, inputs, outputAmount)
    : prepareConditionalConsolidation(authority, wallet, inputs, outputAmount, fees)
}

function assertPlannedConsolidationOutputs(
  outputs: readonly OutputData[],
  expectedAmounts: readonly string[],
): void {
  const actual = outputs
    .map(({ blindedMessage }) => String(amountToNumber(blindedMessage.amount)))
    .sort(compareDecimalStringsDescending)
  const expected = [...expectedAmounts].sort(compareDecimalStringsDescending)
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error('cashu wallet changed the planned consolidation denominations')
  }
}

function compareDecimalStringsDescending(left: string, right: string): number {
  const leftValue = BigInt(left)
  const rightValue = BigInt(right)
  return leftValue > rightValue ? -1 : leftValue < rightValue ? 1 : 0
}

type PreparedConsolidation =
  | {
      readonly kind: 'wallet-send'
      readonly preview: SwapPreview
      readonly inputs: Proof[]
      readonly outputs: OutputData[]
      readonly keysetId: string
    }
  | {
      readonly kind: 'conditional-keyset-swap'
      readonly preview: ConditionalSwapPreview
      readonly inputs: Proof[]
      readonly outputs: OutputData[]
      readonly keysetId: string
    }

async function prepareRegularConsolidation(
  authority: PreparedMintAuthority,
  wallet: CtfRangeWalletLike,
  inputs: Proof[],
  outputAmount: number,
): Promise<PreparedConsolidation> {
  const preview = await wallet.prepareSwapToSend(
    outputAmount,
    inputs,
    { includeFees: false, keysetId: authority.preparation.offerKeysetId },
    { send: { type: 'random' }, keep: { type: 'random' } },
  )
  assertExactInputProofs(preview.inputs, inputs)
  if ((preview.unselectedProofs ?? []).length > 0 || (preview.keepOutputs ?? []).length > 0) {
    throw new Error('regular proof consolidation did not consume its exact input page')
  }
  return {
    kind: 'wallet-send',
    preview,
    inputs: preview.inputs,
    outputs: preview.sendOutputs ?? [],
    keysetId: preview.keysetId,
  }
}

async function prepareConditionalConsolidation(
  authority: PreparedMintAuthority,
  wallet: CtfRangeWalletLike,
  inputs: Proof[],
  outputAmount: number,
  fees: number,
): Promise<PreparedConsolidation> {
  const preview = await wallet.prepareConditionalSwap({
    keysetId: authority.preparation.offerKeysetId,
    inputs,
    outputs: [{ label: 'consolidated', kind: 'random', amount: outputAmount }],
  })
  assertExactInputProofs(preview.inputs, inputs)
  if (
    sumProofs(preview.inputs) - fees !==
    amountToNumber(OutputData.sumOutputAmounts(preview.outputDataByLabel.consolidated ?? []))
  ) {
    throw new Error('conditional proof consolidation changed its exact net amount')
  }
  return {
    kind: 'conditional-keyset-swap',
    preview,
    inputs: preview.inputs,
    outputs: preview.outputDataByLabel.consolidated ?? [],
    keysetId: preview.keysetId,
  }
}

async function completeRegularConsolidation(
  preview: SwapPreview,
  wallet: CtfRangeWalletLike,
): Promise<Proof[]> {
  const result = await wallet.completeSwap(preview)
  if (result.keep.length > 0) {
    throw new Error('regular proof consolidation returned unexpected keep proofs')
  }
  return result.send
}

async function resumeConsolidationOperation(
  entry: ProofOperationRecord,
  authority: PreparedMintAuthority,
  wallet: CtfRangeWalletLike,
  dependencies: DaemonCtfRangeOrderCoordinatorDependencies,
): Promise<void> {
  assertConsolidationOperation(entry)
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
        result = restored.consolidated ?? []
        break
      }
      case 'replay-exact-persisted-operation':
        result = await completePersistedConsolidation(entry, wallet)
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

async function completePersistedConsolidation(
  entry: ProofOperationRecord,
  wallet: CtfRangeWalletLike,
): Promise<Proof[]> {
  const outputs = deserializeOutputGroups(entry.outputs)
  if (entry.kind === 'conditional-keyset-swap') {
    const result = await wallet.completeConditionalSwap({
      keysetId: readSourceText(entry, 'keysetId'),
      inputs: entry.inputs.map(toProof),
      outputDataByLabel: outputs,
    })
    return result.consolidated ?? []
  }
  return completeRegularConsolidation(
    {
      amount: Amount.from(readSourceNumber(entry, 'amount')),
      fees: Amount.from(readSourceNumber(entry, 'fees')),
      keysetId: readSourceText(entry, 'keysetId'),
      inputs: entry.inputs.map(toProof),
      sendOutputs: outputs.consolidated ?? [],
      keepOutputs: [],
      unselectedProofs: [],
    },
    wallet,
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
    (entry.kind !== 'wallet-send' && entry.kind !== 'conditional-keyset-swap')
  ) {
    throw new Error(`Proof operation ${entry.operationId} is not a range consolidation`)
  }
  requireText(entry.metadata.rangeOperationId, 'range operation id')
  requireText(entry.metadata.sourceOperationId, 'range source operation id')
  requireText(entry.metadata.reservationId, 'consolidation reservation')
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

function createCapabilityRequest(
  request: Omit<PrepareSettlementCapabilityInput, 'walletSeedHex'>,
  operation: DurableCtfRangeOperation,
): CreateSettlementCapabilityRequest {
  const artifact = createPoolSettlementCapabilityArtifact(operation)
  return {
    stageIdempotencyKey: operation.authorizationId,
    clientOrderId: request.clientOrderId,
    marketId: request.marketId,
    orderIntent: {
      outcomeId: request.outcomeId,
      tokenSide: request.tokenSide,
      side: request.side,
      price: request.price,
      amountSubunits: request.amountSubunits,
      baseAsset: request.baseAsset,
      collateralUnit: request.collateralUnit,
      timeInForce: request.timeInForce,
      expiresAt: request.expiresAt,
    },
    artifact: Buffer.from(encodeSettlementCapabilityArtifact(artifact)).toString('base64'),
  }
}

function assertCapabilityResponse(
  capability: SettlementCapabilityResponse,
  request: Omit<PrepareSettlementCapabilityInput, 'walletSeedHex'>,
  operation: DurableCtfRangeOperation,
  recovering: boolean,
): void {
  const expectedDigest = deriveSettlementCapabilityArtifactDigest(
    createPoolSettlementCapabilityArtifact(operation),
  )
  const validState =
    capability.state === 'bound' ||
    (recovering &&
      (capability.state === 'selected' ||
        capability.state === 'uncertain' ||
        capability.state === 'terminal'))
  if (
    capability.clientOrderId !== request.clientOrderId ||
    capability.marketId !== request.marketId ||
    capability.artifactDigest !== expectedDigest ||
    !validState ||
    !UUID_PATTERN.test(capability.orderId) ||
    !UUID_PATTERN.test(capability.reference?.artifactId ?? '') ||
    !SHA256_PATTERN.test(capability.reference?.bindingDigest ?? '') ||
    !Number.isSafeInteger(capability.version) ||
    capability.version < 1 ||
    !isIsoDateTime(capability.authorizationExpiresAt) ||
    !isIsoDateTime(capability.stageExpiresAt)
  ) {
    throw new Error('engine returned a foreign settlement capability')
  }
}

function rangePreparationCapability(
  capability: SettlementCapabilityResponse,
): NonNullable<RangePreparationRecord['capability']> {
  return {
    artifactId: capability.reference.artifactId,
    bindingDigest: capability.reference.bindingDigest,
    artifactDigest: capability.artifactDigest,
    orderId: capability.orderId,
  }
}

function isIsoDateTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
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
    refund.operationId !== rangeRefundOperationId(source.operationId) ||
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

function rangeRefundOperationId(rangeOperationId: string): string {
  return `ctf-range-refund:${createHash('sha256')
    .update('bitcaster/ctf-range-refund/v1\0')
    .update(rangeOperationId)
    .digest('hex')}`
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

function assertExactInputProofs(actual: readonly Proof[], expected: readonly Proof[]): void {
  const identity = ({ id, amount, secret, C }: Proof) => ({
    id,
    amount: amountToNumber(amount),
    secret,
    C,
  })
  if (!isDeepStrictEqual(actual.map(identity), expected.map(identity))) {
    throw new Error('cashu wallet substituted exact consolidation inputs')
  }
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
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error('wallet seed must be 32-byte hex')
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

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is invalid`)
  return value
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
