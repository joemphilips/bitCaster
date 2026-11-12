import { readRangePreparationHistoryByClientOrderId } from './ctfRangeOrderJournalSqlite.ts'
import { reserveDaemonCtfPreparation } from './state.ts'
import { deriveDurableCustodyProofId } from '@bitcaster-market/client-sdk/durableCustody'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { startOrderPhase, measureOrderPhase, type OrderTimelineObserver } from './orderTimeline.ts'
import {
  Amount,
  HttpResponseError,
  Mint as CashuMint,
  NetworkError,
  OutputData,
  Wallet as CashuWallet,
  type MintKeys,
  type Proof,
  type ProofState,
  type SerializedBlindedSignature,
  type SwapPreview,
  type SwapRequest,
  type ConditionalSwapPreview,
  type CtfConvertRequest,
  type CtfConvertResponse,
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
  completeCtfRangeSourceOperation,
  ctfRangeSourceMode,
  prepareCtfRangeSourceOperation,
  validateCtfRangeSourceCompletionOperation,
} from '@bitcaster-market/client-sdk/ctfRangeSourceOperation'
import {
  planCtfRangeCapabilitySource,
  type CtfRangeCapabilitySourcePlan,
  type CtfRangeSourceShortfall,
} from '@bitcaster-market/client-sdk/ctfRangeCapabilitySourcePlan'
import {
  completeCtfRangeMixedSourceOperation,
  prepareCtfRangeMixedSourceOperation,
  validateCtfRangeMixedSourceOperation,
  type CtfRangeMixedSourceResult,
} from '@bitcaster-market/client-sdk/ctfRangeCollateralSourceOperation'
import type { DurableCustodyMintKeysetAuthority } from '@bitcaster-market/client-sdk/durableCustodyMintResult'
import {
  completeCtfRangeOrderAuthorization,
  type ActiveCtfRangeMintKeyset,
  type CtfRangeOrderPreparation,
} from '@bitcaster-market/client-sdk/ctfRangeOrderPreparation'
import {
  classifyDurableCtfRangeVerifiedResultArtifact,
  createDurableCtfRangeCustodyBinding,
  deriveDurableCtfRangeSettledFaceAmount,
  createDurableCtfRangeRefundOperation,
  createDeterministicDurableCtfRangeRefundOutputs,
  prepareDurableSeedDerivedCtfRangeRefund,
  assertDurableCtfRangeRefundRequestWitness,
  deriveDurableCtfRangeFeeBounds,
  deriveDurableCtfRangeRefundOperationId,
  toDurableCtfRangeProofOperationInput,
  type DurableCtfRangeExpiryObservation,
  type DurableCtfRangeAsset,
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
  readAppliedCtfRangeEngineResult,
  type AppliedCtfRangeEngineResultRead,
  type CtfRangeEngineResult,
  type CtfRangeMintClient,
} from '@bitcaster-market/client-sdk/ctfRangeRecoveryTransport'
import {
  createCtfRangePreparationIntent,
  selectCtfRangePreparationForIntent,
  reconstructCtfRangePreparation,
  type PersistedCtfRangeOrderPreparationV2,
  buildPersistedCtfRangeOrderPreparation,
  createCtfRangeOrderPreparationKeysetResolver,
  createCtfRangeSettlementCapabilityRequest,
  ctfRangeOrderPreparationKeysetLookup,
  planPersistedCtfRangeOrderAuthorization,
  settlementCapabilityWorkFacts,
  decodeCtfRangeOrderPreparationFromRecord as decodePreparationFromJournal,
  decodeSettlementCoordinatorPublicKey as requireCoordinatorKey,
  exactCtfRangeOrderPreparationMintKeysets,
  validateAndProjectCtfRangeSettlementCapabilityResponse,
  type CtfRangeConditionalMintKeyset,
  type PersistedCtfRangeOrderPreparation,
} from '@bitcaster-market/client-sdk/ctfRangeOrderProtocol'
import { decodeOrderQuotePaymentBounds } from '@bitcaster-market/client-sdk/tradeTicket'
import {
  decodeCtfRangeOrderFeeConsentArtifact,
  encodeCtfRangeOrderFeeConsentArtifact,
} from '@bitcaster-market/client-sdk/ctfRangeOrderJournal'
import {
  assertCtfRangeOrderFeeConsent,
  composeCtfRangeOrderFeeFacts,
  type CtfRangeOrderFeeFacts,
} from '@bitcaster-market/client-sdk/ctfRangeOrderFeeComposition'
import {
  CURRENT_SETTLEMENT_CAPABILITY_TARIFF_RULE_ID,
  calculateSettlementCapabilityTariff,
} from '@bitcaster-market/client-sdk/participationScore'
import {
  loadCtfRangeMintKeys as loadMintKeys,
  loadCtfRangeMintMetadata,
  type CtfRangeMintMetadata as LoadedMintMetadata,
  type CtfRangeMintMetadataClient,
} from '@bitcaster-market/client-sdk/ctfRangeMintMetadata'
import { amountToNumber } from '@bitcaster-market/client-sdk/proofSelection'
import {
  MINT_OUTPUT_REUSE_REFUSAL_CODES,
  classifyCashuMintFailure,
  decideCtfRangeRequestSettlement,
  settlingMintRefusal,
  type CashuMintRefusal,
} from '@bitcaster-market/client-sdk/mintRefusal'
import {
  countCtfRangeRecoveryRefusal,
  resumeCtfRangeRecoveryRefusalCount,
  type CtfRangeRecoveryRefusalCount,
  type CtfRangeRefusedRequest,
} from '@bitcaster-market/client-sdk/ctfRangeRecoveryRefusal'
import {
  CTF_RANGE_REFUND_REPLACED_OUTPUT_PLANS_MAX,
  CtfRangeRefundReplacedPlanSignedError,
  assertReplacedCtfRangeRefundOutputPlans,
  decodeReplacedCtfRangeRefundOutputPlans,
  restoreSpentCtfRangeRefund,
  savedReplacedCtfRangeRefundOutputPlans,
} from '@bitcaster-market/client-sdk/ctfRangeRefundReplacedPlans'
import {
  findLastSignedSeedCounter,
  SEED_COUNTER_SKIP_AFTER_LAST_SIGNED,
  type SeedCounterRestoreClient,
} from '@bitcaster-market/client-sdk/seedCounterGapScan'
import {
  CtfRangeOrderOutputCheckError,
  prepareCheckedCtfRangeSourceOperation,
  reserveCheckedCtfRangeOrderPreparation,
  type CtfRangeOrderCounterStarts,
} from '@bitcaster-market/client-sdk/ctfRangeOrderOutputCheck'
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
import {
  createSpeculativeCounterTranscript,
  type SpeculativeCounterTranscript,
} from '@bitcaster-market/client-sdk/speculativeCounterTranscript'
import type {
  CreateSettlementCapabilityRequest,
  OrderStatusResponse,
  SettlementCapabilityResultResponse,
  SettlementCapabilityResponse,
} from '@bitcaster-market/client-sdk/engineClient'
import { DaemonCtfRangeCoordinator } from './ctfRangeCoordinator.ts'
import {
  loadDaemonDurableCtfRangeAuthority,
  type DaemonDurableCtfRangeAuthority,
} from './durableCtfRangeSqlite.ts'
import {
  assertDurableSeedDerivedOutputPlanMatchesOutputs,
  reconstructDurableSeedDerivedOutputs,
} from '@bitcaster-market/client-sdk/durableSeedDerivedOutputs'
import {
  createDaemonRangeSourceBinding,
  bindDaemonRangeSourceInTransaction,
  stageDaemonRangeSourceResult,
  readDaemonRangeSourceResult,
  createDaemonRangeMixedSourceBinding,
  bindDaemonRangeMixedSourceInTransaction,
  stageDaemonRangeMixedSourceResult,
  readDaemonRangeMixedSourceResult,
  commitDaemonRangeConsolidation,
  releaseRefusedDaemonRangeSourceInTransaction,
  storedSourceOutputs,
} from './ctfRangeSourceState.ts'
import { profileDir } from './profile.ts'
import {
  CtfRangeOrderReleasedError,
  CtfRangeSellPreparationPendingError,
  rangeOrderReleasedMessage,
  rangeOrderRetryCommand,
  type DaemonCtfRangeRecoveryPending,
  type DaemonCtfRangeRecoveryStatus,
  type DaemonCtfRangeReleasedOperation,
} from './ctfRangeOrderRelease.ts'
import type { CustodyScopeFence } from './profileFencing.ts'
import type { DatabaseSync } from 'node:sqlite'
import {
  CTF_RANGE_REFUND_PURPOSE,
  advanceDaemonKeysetCounter,
  commitDaemonCounterTranscript,
  DaemonCounterSnapshotConflictError,
  getProofOperation,
  readDaemonCounterSnapshots,
  prepareCtfConsolidationProofOperationWithExactReservation,
  prepareProofOperationWithExactReservation,
  prepareCtfRangeRefundProofOperationFromDatabase,
  readAvailableCanonicalWalletProofPageFromDatabase,
  readDaemonProofOperationFromDatabase,
  recordDiscoveredOrder,
  recordOrderStatus,
  releaseRefusedCtfRangeProofReservationFromDatabase,
  replanCtfRangeRefundProofOperationFromDatabase,
  type CashuProofRecord,
  type FencedStateMutation,
  type ProofOperationRecord,
  type StoredOutputData,
  type StoredProofAsset,
} from './state.ts'
import {
  appendRangePreparationConsolidation,
  bindRangePreparationCapability,
  linkRangePreparationSource,
  pageActiveRangePreparations,
  readPreparedRangeSells,
  readRangePreparation,
  readRangePreparationOperationLinks,
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
import {
  createDaemonStateSqliteSession,
  type DaemonStateSqliteSession,
  type StateSqliteFaultPhase,
} from './stateSqlite.ts'
import {
  deserializeOutputGroups,
  restoreOutputGroups,
  serializeOutputDataArray,
} from './walletOps.ts'
import type {
  BeforeCreateSettlementCapability,
  EngineClientLike,
  PreparedSettlementCapability,
  PrepareSettlementCapabilityInput,
} from './server.ts'

const SOURCE_PURPOSE = 'ctf-range-authorization-source'
const MIXED_SOURCE_ENDPOINT = 'POST /v1/ctf/convert'
const CONSOLIDATION_PURPOSE = 'ctf-range-authorization-consolidation'
const ACTIVE_RANGE_SOURCE_LIMIT = 256
/** Recently released order attempts that the recovery status reports. */
const RELEASED_STATUS_LIMIT = 32
const MAX_CONSOLIDATION_ROUNDS = 256

interface CtfRangeMintLike extends CtfRangeMintMetadataClient, SeedCounterRestoreClient {
  check(payload: { Ys: string[] }, signal?: AbortSignal): Promise<{ states: ProofState[] }>
  ctfConvert(request: CtfConvertRequest): Promise<CtfConvertResponse>
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

/**
 * The browser default for an immediate (FOK) order authorization (ADR-037).
 * The mint's 24-hour maximum is only a ceiling. A cancelled FOK stays locked
 * until this expiry, because cancellation cannot revoke the authorization.
 */
export const DAEMON_IMMEDIATE_ORDER_AUTHORIZATION_LIFETIME_SECONDS = 300

export interface DaemonCtfRangeOrderCoordinatorDependencies {
  readonly observeOrderTimeline?: OrderTimelineObserver
  readonly allowInsecureLoopbackHttp?: boolean
  readonly authorizationLifetimeSeconds?: number
  readonly createMint?: (mintUrl: string) => CtfRangeMintLike
  readonly createWallet?: (mintUrl: string, walletSeedHex: string) => CtfRangeWalletLike
  readonly now?: () => number
  readonly randomId?: () => string
  readonly restoreOutputs?: typeof restoreOutputGroups
  readonly observeRefundPrepared?: (
    draft: Readonly<{
      operationId: string
      outputs: readonly import('@cashu/cashu-ts').SerializedOutputData[]
      plan: import('@bitcaster-market/client-sdk/durableSeedDerivedOutputs').DurableSeedDerivedOutputPlan
    }>,
  ) => Promise<void>
  readonly injectRefundPreparationFault?: (phase: 'counter-written' | 'journal-bound') => void
  readonly injectRefundUnitOfWorkFault?: (phase: StateSqliteFaultPhase) => void
  readonly injectRangeBindFault?: (phase: StateSqliteFaultPhase) => void
  readonly injectRangeUnitOfWorkFault?: (phase: StateSqliteFaultPhase) => void
  readonly injectRefusalReleaseFault?: (phase: StateSqliteFaultPhase) => void
  readonly executeRefundSwap?: (
    mintUrl: string,
    request: SwapRequest,
  ) => Promise<{ signatures: SerializedBlindedSignature[] }>
}

export interface DaemonCtfRangeRecoveryResult {
  readonly recovered: string[]
  readonly pending: DaemonCtfRangeRecoveryPending[]
  /** Order attempts that a mint refusal ended in this pass. */
  readonly released?: DaemonCtfRangeReleasedOperation[]
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
  /**
   * Limits from the metadata loaded for this preparation. They stay in memory:
   * preparation v2 does not persist the output bound, and a restarted fresh
   * selection must load current metadata instead of trusting an old bound.
   */
  readonly loadedSourceLimits: SourceSelectionLimits | null
  readonly consolidateProofs: boolean
  readonly storage: DaemonStateSqliteSession
  readonly mutation: () => FencedStateMutation
}

interface SourceSelectionLimits {
  readonly maxInputs: number
  readonly maxOutputs: number
}

type PersistedPreparationInput = PersistedCtfRangeOrderPreparation

function preparationFromJournal(
  record: RangePreparationRecord,
  expectedRequest?: Parameters<typeof decodePreparationFromJournal>[1],
): PersistedPreparationInput {
  return decodePreparationFromJournal(toSdkRangePreparationRecord(record), expectedRequest)
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
  #refundRepairCursor: { updatedAt: number; operationId: string } | undefined
  #refundRepairExhausted = false
  #refundRepairNeedsTurn = false
  // A load control, not funds authority: a restart allows an earlier retry.
  // A halt without a refusal comes from other evidence, such as a replaced refund plan.
  readonly #refusals = new Map<
    string,
    { refusal: CtfRangeRecoveryRefusalCount | null; halted: boolean }
  >()
  readonly #pendingStatus = new Map<string, DaemonCtfRangeRecoveryPending>()
  #releasedStatus: DaemonCtfRangeReleasedOperation[] = []

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
    beforeCreateCapability?: BeforeCreateSettlementCapability,
    consentedFeeFacts?: CtfRangeOrderFeeFacts,
  ): Promise<PreparedSettlementCapability> {
    requireFokOrder(request.timeInForce)
    decodeOrderQuotePaymentBounds(request.side, request)
    const finishPreparation = startOrderPhase(
      this.#dependencies.observeOrderTimeline,
      'preparation',
      {
        clientOrderId: request.clientOrderId,
      },
    )
    try {
      const observer = this.#dependencies.observeOrderTimeline
      const preparationIdentity = { clientOrderId: request.clientOrderId }
      const authority = await measureOrderPhase(
        observer,
        'preparation-mint-authority',
        preparationIdentity,
        () => this.#prepareMintAuthority(request, client, consentedFeeFacts),
      )
      const source = await measureOrderPhase(
        observer,
        'preparation-wallet-source',
        preparationIdentity,
        () => this.#prepareWalletSource(authority, request.walletSeedHex, consentedFeeFacts),
      )
      const { operation, capabilityRequest, binding } = await measureOrderPhase(
        observer,
        'preparation-authorization-binding',
        preparationIdentity,
        async () => {
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
          return { operation, capabilityRequest, binding }
        },
      )
      const nowMs = this.#nowMs()
      const boundAuthority = await measureOrderPhase(
        observer,
        'preparation-durable-bind',
        preparationIdentity,
        () =>
          new DaemonCtfRangeCoordinator(this.#directory, this.#getFence()).bindPreparedSource({
            binding,
            proofStateClient: authority.mint,
            observedAtMs: nowMs,
            ...(this.#dependencies.injectRangeBindFault === undefined
              ? {}
              : { injectFault: this.#dependencies.injectRangeBindFault }),
          }),
      )
      const exactCapabilityRequest = await measureOrderPhase(
        observer,
        'preparation-exact-request',
        preparationIdentity,
        () =>
          this.#exactCapabilityRequest(
            request.walletSeedHex,
            operation.operationId,
            capabilityRequest,
            boundAuthority,
          ),
      )
      if (this.#nowSeconds() >= operation.expiry) {
        await this.#recoverUnsubmittedAuthorization(
          authority.preparationInput,
          request.walletSeedHex,
        )
        throw new Error('range authorization expired before capability admission')
      }
      const createCapability = client.createSettlementCapability
      if (createCapability === undefined) {
        throw new Error('engine client does not support settlement capability creation')
      }
      const identity = {
        clientOrderId: request.clientOrderId,
        operationId: operation.operationId,
        orderId: undefined as string | undefined,
      }
      finishPreparation('success', identity)
      await measureOrderPhase(
        this.#dependencies.observeOrderTimeline,
        'score-admission',
        identity,
        async () =>
          beforeCreateCapability?.(
            calculateSettlementCapabilityTariff(
              CURRENT_SETTLEMENT_CAPABILITY_TARIFF_RULE_ID,
              settlementCapabilityWorkFacts(operation),
            ),
          ),
        beforeCreateCapability === undefined ? 'unverified' : 'success',
      )
      const capability = await measureOrderPhase(
        this.#dependencies.observeOrderTimeline,
        'capability-admission',
        identity,
        async () => {
          await this.#markCapabilityRequested(operation.operationId)
          if (this.#nowSeconds() >= operation.expiry) {
            await this.#recoverUnsubmittedAuthorization(
              authority.preparationInput,
              request.walletSeedHex,
            )
            throw new Error('range authorization expired before capability admission')
          }
          const capability = await createCapability.call(client, exactCapabilityRequest)
          const projectedCapability = validateAndProjectCtfRangeSettlementCapabilityResponse({
            capability,
            preparation: authority.preparationInput,
            operation,
            recovering: false,
          })
          await this.#bindCapability(operation.operationId, projectedCapability)
          identity.orderId = projectedCapability.orderId
          return capability
        },
      )
      return {
        operationId: operation.operationId,
        authorizationExpiresAtUnixSeconds: operation.expiry,
        capability,
        markSubmitted: () => this.#markOrderSubmitted(operation.operationId),
        markRejected: () => this.#markOrderSubmissionRejected(operation.operationId),
        consolidation: await sourceConsolidationSummary(operation.sourceOperationId),
      }
    } catch (error) {
      finishPreparation('failed')
      throw error
    }
  }

  /** Observe current wallet fee facts without binding an order or mint operation. */
  async previewFeeFacts(
    request: PrepareSettlementCapabilityInput,
    client: EngineClientLike,
  ): Promise<CtfRangeOrderFeeFacts> {
    requireFokOrder(request.timeInForce)
    const { preparationInput, metadata, mint } = await this.#buildNewMintAuthority(request, client)
    const authority = preparedMintAuthority(
      preparationInput,
      request.walletSeedHex,
      metadata,
      mint,
      request.consolidateProofs,
      this.#storage,
      this.#mutation.bind(this),
    )
    return (
      await planFreshSourceWithFees(
        authority,
        await freshSourceLimits(authority, this.#dependencies),
        0,
      )
    ).feeFacts
  }

  /** The latest recovery state of each pending operation and recent releases. */
  recoveryStatus(): DaemonCtfRangeRecoveryStatus {
    return {
      pending: structuredClone([...this.#pendingStatus.values()]),
      released: structuredClone(this.#releasedStatus),
    }
  }

  /**
   * Allow one manual retry of a halted operation. The same refusal halts it
   * again at once, so each manual retry sends one request.
   */
  retryHaltedRecovery(operationId: string): boolean {
    const entry = this.#refusals.get(operationId)
    if (entry === undefined || !entry.halted) return false
    this.#refusals.set(operationId, {
      refusal: entry.refusal === null ? null : resumeCtfRangeRecoveryRefusalCount(entry.refusal),
      halted: false,
    })
    return true
  }

  #haltedRecovery(operationId: string): DaemonCtfRangeRecoveryPending | null {
    const entry = this.#refusals.get(operationId)
    if (entry === undefined || !entry.halted) return null
    const command = rangeOrderRetryCommand(operationId)
    if (entry.refusal === null) {
      return {
        operationId,
        error: `The refund outputs match only an earlier output plan. Automatic retries stopped. The reserved funds stay reserved. To try again, run: ${command}`,
        halted: true,
        retryCommand: command,
      }
    }
    const { code, detail, count } = entry.refusal
    return {
      operationId,
      error: `The mint refused this order recovery ${count} times (mint code ${code}). Automatic retries stopped. The reserved funds stay reserved. To try again, run: ${command}`,
      mintError: { code, detail },
      halted: true,
      retryCommand: command,
    }
  }

  /**
   * Count one coded refusal that kept a request reserved. Refusals count for
   * each refused request and each code (SDK refusal count).
   */
  #recordRefusal(
    operationId: string,
    request: CtfRangeRefusedRequest,
    mintError: CashuMintRefusal,
  ): void {
    const previous = this.#refusals.get(operationId)
    const counted = countCtfRangeRecoveryRefusal(previous?.refusal ?? null, {
      request,
      ...mintError,
    })
    this.#setRefusal(operationId, counted)
  }

  /**
   * Halt at once: a refund whose spent inputs match only a replaced output
   * plan cannot complete, and automatic replay cannot change that (ADR-037).
   */
  #recordHalt(operationId: string): void {
    this.#setRefusal(operationId, { refusal: null, halted: true })
  }

  #setRefusal(
    operationId: string,
    entry: { refusal: CtfRangeRecoveryRefusalCount | null; halted: boolean },
  ): void {
    this.#refusals.delete(operationId)
    this.#refusals.set(operationId, entry)
    while (this.#refusals.size > ACTIVE_RANGE_SOURCE_LIMIT) {
      const oldest = this.#refusals.keys().next().value
      if (oldest === undefined) break
      this.#refusals.delete(oldest)
    }
  }

  #settledStatus(operationId: string): void {
    this.#refusals.delete(operationId)
    this.#pendingStatus.delete(operationId)
  }

  #pendingResult(operationId: string, error: unknown): DaemonCtfRangeRecoveryPending {
    if (error instanceof RangeMintRefusalPendingError) {
      this.#recordRefusal(operationId, error.request, error.mintError)
    }
    if (error instanceof CtfRangeRefundReplacedPlanSignedError) this.#recordHalt(operationId)
    const pending = this.#haltedRecovery(operationId) ?? {
      operationId,
      ...recoveryFailureStatus(error),
      ...(error instanceof RangeRecoveryDeferredError ? { retryAtMs: error.retryAtMs } : {}),
    }
    this.#pendingStatus.set(operationId, pending)
    return pending
  }

  /**
   * True when this pass moved the order journal. Then an earlier run of
   * identical refusals no longer counts, as in the browser.
   */
  async #journalAdvanced(record: RangePreparationRecord): Promise<boolean> {
    try {
      const current = await withDurableCustodyFencedRead(
        this.#storage,
        this.#getFence(),
        this.#nowMs(),
        (database) => readRangePreparation(database, record.scopeId, record.rangeOperationId),
      )
      return (
        current !== null &&
        (current.revision !== record.revision || current.lifecycleState !== record.lifecycleState)
      )
    } catch {
      // The count is a load control, not funds authority. A failed read keeps it.
      return false
    }
  }

  async recover(
    walletSeedHex: string,
    client: EngineClientLike,
  ): Promise<DaemonCtfRangeRecoveryResult> {
    const startedAfterCursor = this.#recoveryCursor !== undefined
    const page = await this.#activeRangePreparations(
      this.#refundRepairNeedsTurn ? ACTIVE_RANGE_SOURCE_LIMIT - 1 : ACTIVE_RANGE_SOURCE_LIMIT,
    )
    const exposesPage =
      startedAfterCursor ||
      page.preparations.length === ACTIVE_RANGE_SOURCE_LIMIT ||
      page.deferredCount > 0
    let result: DaemonCtfRangeRecoveryResult = {
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
    const released: DaemonCtfRangeReleasedOperation[] = []
    for (const preparation of page.preparations) {
      const preparationInput = preparationFromJournal(preparation)
      const operationId = preparationInput.sourceOperationId
      // A halted operation stays visible on every pass without a mint request.
      const halted = this.#haltedRecovery(operationId)
      if (halted !== null) {
        this.#pendingStatus.set(operationId, halted)
        result.pending.push(halted)
        continue
      }
      try {
        await this.#recoverPreparation(preparation, preparationInput, walletSeedHex, client)
        this.#settledStatus(operationId)
        result.recovered.push(operationId)
      } catch (error) {
        if (error instanceof CtfRangeOrderReleasedError) {
          this.#settledStatus(operationId)
          released.push({ operationId, mintError: error.mintError, message: error.message })
          continue
        }
        if (await this.#journalAdvanced(preparation)) this.#refusals.delete(operationId)
        result.pending.push(this.#pendingResult(operationId, error))
      }
    }
    if (!startedAfterCursor && page.nextCursor === null) {
      // This pass saw every active preparation, so older status is stale.
      const active = new Set(
        page.preparations.map((record) => preparationFromJournal(record).sourceOperationId),
      )
      for (const operationId of [...this.#pendingStatus.keys()]) {
        if (!active.has(operationId)) this.#pendingStatus.delete(operationId)
      }
      for (const operationId of [...this.#refusals.keys()]) {
        if (!active.has(operationId)) this.#refusals.delete(operationId)
      }
    }
    if (released.length > 0) {
      this.#releasedStatus = [...this.#releasedStatus, ...released].slice(-RELEASED_STATUS_LIMIT)
      result = { ...result, released }
    }
    if (!this.#refundRepairExhausted) {
      const budget = ACTIVE_RANGE_SOURCE_LIMIT - page.preparations.length
      if (budget === 0) {
        this.#refundRepairNeedsTurn = true
        return { ...result, deferredCount: (result.deferredCount ?? 0) + 1 }
      }
      this.#refundRepairNeedsTurn = false
      const repair = await this.#repairTerminalRefundPage(budget)
      result.recovered.push(...repair.recovered)
      result.pending.push(...repair.pending)
      for (const pending of repair.pending) this.#pendingStatus.set(pending.operationId, pending)
      if (repair.more) return { ...result, deferredCount: (result.deferredCount ?? 0) + 1 }
    }
    return result
  }

  async #repairTerminalRefundPage(limit: number): Promise<{
    recovered: string[]
    pending: DaemonCtfRangeRecoveryResult['pending']
    more: boolean
  }> {
    const fence = this.#getFence()
    const rows = await withDurableCustodyFencedRead(
      this.#storage,
      fence,
      this.#nowMs(),
      (database) => {
        const after = this.#refundRepairCursor
        return database
          .prepare(
            `SELECT operation_id AS operationId, updated_at_ms AS updatedAt
        FROM target_proof_operations WHERE scope_id = ? AND purpose = ? AND state = 'completed'
        ${after === undefined ? '' : 'AND (updated_at_ms > ? OR (updated_at_ms = ? AND operation_id > ?))'}
        ORDER BY updated_at_ms, operation_id LIMIT ?`,
          )
          .all(
            fence.scopeId,
            CTF_RANGE_REFUND_PURPOSE,
            ...(after === undefined ? [] : [after.updatedAt, after.updatedAt, after.operationId]),
            limit + 1,
          ) as Array<{ operationId: string; updatedAt: number }>
      },
    )
    const result = {
      recovered: [] as string[],
      pending: [] as DaemonCtfRangeRecoveryResult['pending'],
      more: rows.length > limit,
    }
    for (const row of rows.slice(0, limit)) {
      try {
        const candidate = await withDurableCustodyFencedRead(
          this.#storage,
          fence,
          this.#nowMs(),
          (database) => {
            const refund = readDaemonProofOperationFromDatabase(database, row.operationId)
            if (
              refund === null ||
              refund.state !== 'completed' ||
              refund.metadata.purpose !== CTF_RANGE_REFUND_PURPOSE
            )
              throw new Error('terminal refund repair journal changed')
            const sourceId = refund.metadata.rangeOperationId
            const custodyId = refund.metadata.custodyOperationId
            if (typeof sourceId !== 'string' || typeof custodyId !== 'string')
              throw new Error('terminal refund repair parent is absent')
            const preparation = readRangePreparation(database, fence.scopeId, sourceId)
            if (preparation?.lifecycleState !== 'terminal') return null
            const proofs = completedRangeRefundProofs(refund)
            const store = new DurableCustodySqliteStore(database)
            const missing = proofs.some(
              (proof) =>
                store.getProof(
                  fence.scopeId,
                  deriveDurableCustodyProofId({
                    scopeId: fence.scopeId,
                    normalizedMint: refund.mintUrl,
                    unit: 'msat',
                    keysetId: proof.id,
                    secret: proof.secret,
                  }),
                ) === null,
            )
            return missing ? { refund, custodyId, sourceId: preparation.sourceOperationId } : null
          },
        )
        if (candidate !== null) {
          const coordinator = new DaemonCtfRangeCoordinator(this.#directory, fence)
          const loaded = await coordinator.load(candidate.custodyId)
          if (
            loaded === null ||
            loaded.record.operation.state !== 'aborted' ||
            loaded.record.operation.result.state !== 'none'
          )
            throw new Error('terminal refund repair parent custody is not aborted')
          assertRangeRefundOperation(candidate.refund, candidate.custodyId, loaded.operation)
          const mint = this.#createMint(loaded.operation.mintUrl)
          const keyset = await loadExactMintKeyset(
            mint,
            readSourceText(candidate.refund, 'refundKeysetId'),
          )
          await coordinator.completeRefund({
            custodyOperationId: candidate.custodyId,
            refundOperationId: candidate.refund.operationId,
            refundProofs: completedRangeRefundProofs(candidate.refund),
            refundAsset: rangeOfferStoredAsset(loaded.operation),
            refundKeyset: keyset,
            observedAtMs: this.#nowMs(),
          })
          result.recovered.push(candidate.sourceId)
        }
        this.#refundRepairCursor = row
      } catch (error) {
        result.pending.push({ operationId: row.operationId, ...recoveryFailureStatus(error) })
        result.more = false
        return result
      }
    }
    if (!result.more) this.#refundRepairExhausted = true
    return result
  }

  async #recoverPreparation(
    preparationRecord: RangePreparationRecord,
    preparationInput: PersistedPreparationInput,
    walletSeedHex: string,
    client: EngineClientLike,
  ): Promise<void> {
    requireFokOrder(preparationInput.request.timeInForce)
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
      this.#storage,
      this.#mutation.bind(this),
    )
    const consentedFeeFacts =
      preparationRecord.feeConsentBytes === null
        ? undefined
        : decodeCtfRangeOrderFeeConsentArtifact(preparationRecord.feeConsentBytes)
    const sourceResult = await this.#prepareWalletSource(
      authority,
      walletSeedHex,
      consentedFeeFacts,
      consentedFeeFacts !== undefined,
    )
    const operation = completeCtfRangeOrderAuthorization({
      preparation: authority.preparation,
      inputs: sourceResult.authorization,
      keysetLookup: authority.lookup,
      expiryObservation: authority.observation,
      allowInsecureLoopbackHttp: this.#dependencies.allowInsecureLoopbackHttp === true,
    })
    const capabilityRequest = createCtfRangeSettlementCapabilityRequest(preparationInput, operation)
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
      ...(this.#dependencies.injectRangeBindFault === undefined
        ? {}
        : { injectFault: this.#dependencies.injectRangeBindFault }),
    }
    await rangeCoordinator.bindPreparedSource(bindInput)
    if (preparationRecord.lifecycleState === 'capability-requested') {
      if (this.#nowSeconds() >= operation.expiry) {
        await this.#recoverUnsubmittedAuthorization(preparationInput, walletSeedHex)
        return
      }
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
    const exactRequest = await this.#exactCapabilityRequest(
      walletSeedHex,
      operation.operationId,
      request,
    )
    if (this.#nowSeconds() >= operation.expiry) {
      await this.#recoverUnsubmittedAuthorization(input, walletSeedHex)
      return
    }
    const createCapability = client.createSettlementCapability
    if (createCapability === undefined) {
      throw new Error('engine client does not support settlement capability creation')
    }
    const response = await createCapability.call(client, exactRequest)
    const capability = validateAndProjectCtfRangeSettlementCapabilityResponse({
      capability: response,
      preparation: input,
      operation,
      recovering: true,
    })
    await this.#bindCapability(operation.operationId, capability)
    // Binding recovers admission, not custody. Continue through the bound journal so
    // an unsubmitted authorization still gets its expiry refund without an order event.
    throw new RangeRecoveryDeferredError(
      'recovered range capability requires custody reconciliation',
      this.#nowMs(),
    )
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
    boundAuthority?: DaemonDurableCtfRangeAuthority,
  ): Promise<CreateSettlementCapabilityRequest> {
    // Keep current owner checks. Reuse only immutable exact-operation material,
    // never the returned lifecycle state as permission for a later mutation.
    const fence = this.#getFence()
    const custodyOperationId = rangeCustodyOperationId(walletSeedHex, rangeOperationId)
    const authority =
      boundAuthority ??
      (await new DaemonCtfRangeCoordinator(this.#directory, fence).load(custodyOperationId))
    if (
      authority === null ||
      authority.record.scope.scopeId !== fence.scopeId ||
      authority.record.scope.scopeKind !== 'wallet' ||
      authority.record.operation.operationId !== custodyOperationId ||
      authority.operation.operationId !== rangeOperationId ||
      !isDeepStrictEqual(authority.requestBody, expected)
    ) {
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
      walletSeedHex,
      custodyOperationId,
      loaded.record,
      new CtfRangeMintRecoveryAdapter(loaded.operation, mint),
      { clientOrderId: input.request.clientOrderId, operationId: input.operationId },
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
    consentedFeeFacts?: CtfRangeOrderFeeFacts,
  ): Promise<PreparedMintAuthority> {
    const consentBytes =
      consentedFeeFacts === undefined
        ? null
        : encodeCtfRangeOrderFeeConsentArtifact(consentedFeeFacts)
    const persisted = await this.#readActivePreparation(request, consentBytes)
    if (persisted !== null) {
      return persistedMintAuthority(
        persisted,
        request.walletSeedHex,
        this.#createMint(persisted.mintUrl),
        request.consolidateProofs,
        this.#storage,
        this.#mutation.bind(this),
      )
    }
    const { preparationInput, metadata, mint } = await this.#buildNewMintAuthority(request, client)
    const durablePreparation = await this.#reserveCheckedPreparation(
      preparationInput,
      request.walletSeedHex,
      request.consolidateProofs,
      consentBytes,
      mint,
    )
    return preparedMintAuthority(
      durablePreparation,
      request.walletSeedHex,
      metadata,
      mint,
      request.consolidateProofs,
      this.#storage,
      this.#mutation.bind(this),
    )
  }

  async #buildNewMintAuthority(
    request: PrepareSettlementCapabilityInput,
    client: EngineClientLike,
  ): Promise<{
    readonly preparationInput: PersistedCtfRangeOrderPreparationV2
    readonly metadata: LoadedMintMetadata
    readonly mint: CtfRangeMintLike
  }> {
    const getPolicy = client.getSettlementCapabilityAdmissionPolicy
    if (getPolicy === undefined) {
      throw new Error('engine client does not expose settlement admission policy')
    }
    const mint = this.#createMint(request.mintUrl)
    const observer = this.#dependencies.observeOrderTimeline
    const identity = { clientOrderId: request.clientOrderId }
    const [policy, metadata, market] = await Promise.all([
      measureOrderPhase(observer, 'preparation-policy-read', identity, () =>
        getPolicy.call(client),
      ),
      measureOrderPhase(observer, 'preparation-mint-read', identity, () =>
        loadMintMetadata(
          mint,
          request.mintUrl,
          request.conditionId,
          this.#nowSeconds(),
          this.#dependencies.allowInsecureLoopbackHttp === true,
        ),
      ),
      measureOrderPhase(observer, 'preparation-market-read', identity, () =>
        loadEngineMarket(client, request.conditionId),
      ),
    ])
    return {
      preparationInput: buildPersistedCtfRangeOrderPreparation({
        request: persistedOrderRequest(request),
        coordinatorPublicKey: requireCoordinatorKey(policy),
        mintFacts: metadata,
        market,
        nowUnixSeconds: this.#nowSeconds(),
        randomId: this.#randomId.bind(this),
        authorizationLifetimeSeconds:
          this.#dependencies.authorizationLifetimeSeconds ??
          DAEMON_IMMEDIATE_ORDER_AUTHORIZATION_LIFETIME_SECONDS,
      }),
      metadata,
      mint,
    }
  }

  async #readActivePreparation(
    request: PrepareSettlementCapabilityInput,
    consentBytes: Uint8Array | null,
  ): Promise<PersistedPreparationInput | null> {
    const { intent } = createCtfRangePreparationIntent({
      scopeId: this.#getFence().scopeId,
      request: persistedOrderRequest(request),
      feeConsentBytes: consentBytes,
      consolidateProofs: request.consolidateProofs,
    })
    return withDurableCustodyFencedRead(
      this.#storage,
      this.#getFence(),
      this.#nowMs(),
      (database) => {
        const record = selectCtfRangePreparationForIntent(
          readRangePreparationHistoryByClientOrderId(
            database,
            intent.scopeId,
            intent.request.clientOrderId,
          ),
          intent,
        )
        if (record === null) return null
        if (record.lifecycleState === 'terminal')
          throw new Error('CTF preparation has already completed')
        return preparationFromJournal(record, intent.request)
      },
    )
  }

  /**
   * Check every output of the new order with the mint before the order
   * reserves its counters (ADR-037 reused-output amendment, decision 14). An
   * output that another client of this seed already signed moves its counter
   * past the signed outputs, and the SDK plans the order again. The skipped
   * outputs can hold funds of this seed; `wallet recover-seed` restores them.
   */
  async #reserveCheckedPreparation(
    input: PersistedCtfRangeOrderPreparationV2,
    walletSeedHex: string,
    consolidateProofs: boolean,
    consentBytes: Uint8Array | null,
    mint: SeedCounterRestoreClient,
  ): Promise<PersistedPreparationInput> {
    const { intent } = createCtfRangePreparationIntent({
      scopeId: this.#getFence().scopeId,
      request: input.request,
      feeConsentBytes: consentBytes,
      consolidateProofs,
    })
    const seed = walletSeed(walletSeedHex)
    const binding = { normalizedMint: input.mintUrl, unit: 'msat' as const }
    const record = await reserveCheckedCtfRangeOrderPreparation({
      mint,
      seed,
      preparation: input,
      intent,
      readCounterStarts: async (): Promise<CtfRangeOrderCounterStarts> => {
        const [offer, receive] = await readDaemonCounterSnapshots({
          storage: this.#storage,
          mutation: this.#mutation(),
          keysetIds: [input.offerKeyset.id, input.receiveKeyset.id],
          binding,
        })
        return { offer: offer?.nextCounter ?? 0, receive: receive?.nextCounter ?? 0 }
      },
      skipSignedCounters: (skip) =>
        advanceDaemonKeysetCounter(skip.keysetId, skip.nextCounter, this.#mutation(), binding),
      reserve: (counterStarts) =>
        reserveDaemonCtfPreparation({
          storage: this.#storage,
          mutation: this.#mutation(),
          intent,
          candidate: input,
          seed,
          counterStarts,
        }),
    })
    if (record.lifecycleState === 'terminal')
      throw new Error('CTF preparation has already completed')
    return preparationFromJournal(record, input.request)
  }

  async #activeRangePreparations(
    limit = ACTIVE_RANGE_SOURCE_LIMIT,
  ): Promise<ReturnType<typeof pageActiveRangePreparations>> {
    const observedAtMs = this.#nowMs()
    return withDurableCustodyFencedRead(
      this.#storage,
      this.#getFence(),
      observedAtMs,
      (database) => {
        const page = pageActiveRangePreparations(database, {
          scopeId: this.#getFence().scopeId,
          limit,
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
      const persistedIdentity = {
        clientOrderId: input.request.clientOrderId,
        operationId: input.operationId,
        orderId: capability.orderId,
      }
      if ((await this.#persistedResultSource(loaded.record)) === 'mint-recovery') {
        await this.#completePersistedResult(
          coordinator,
          custodyOperationId,
          loaded,
          input,
          walletSeedHex,
          preparationResolver,
          { ...persistedIdentity, applicationPath: 'persisted-mint-reuse' },
        )
        return
      }
      const read = await this.#readAppliedEngineResult(client, loaded.operation, reference, {
        ...persistedIdentity,
        applicationPath: 'persisted-engine-reuse',
      })
      if (read.kind === 'collected') {
        // The engine deletes a result only after its acknowledgement, so the persisted result is complete.
        await this.#completePersistedResult(
          coordinator,
          custodyOperationId,
          loaded,
          input,
          walletSeedHex,
          preparationResolver,
          { ...persistedIdentity, applicationPath: 'persisted-engine-reuse' },
        )
        return
      }
      const persistedEngineResult = read.result
      const decision = await this.#applyEngineResult(
        coordinator,
        walletSeedHex,
        custodyOperationId,
        loaded.operation,
        persistedEngineResult,
        reference,
        client,
        preparationResolver,
        input,
        capability.orderId,
        loaded.record.operation.result.state === 'applied',
        true,
      )
      if (decision.kind !== 'confirmed') {
        throw new RangeRecoveryDeferredError(
          'persisted engine range result remains unverified',
          this.#nowMs() + 1_000,
        )
      }
      await this.#markTerminal(input.operationId)
      const identity = {
        clientOrderId: input.request.clientOrderId,
        operationId: input.operationId,
        orderId: capability.orderId,
        groupId: persistedEngineResult.settlementGroupId,
        groupRevision: persistedEngineResult.settlementGroupRevision,
        applicationPath: 'persisted-engine-reuse' as const,
      }
      startOrderPhase(this.#dependencies.observeOrderTimeline, 'result-reuse', identity)('reused')
      startOrderPhase(
        this.#dependencies.observeOrderTimeline,
        'result-completion',
        identity,
      )('reused')
      return
    }
    const response = await this.#getEngineResult(client, input.operationId, {
      clientOrderId: input.request.clientOrderId,
      operationId: input.operationId,
      orderId: capability.orderId,
      applicationPath: 'engine',
    })
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
      this.#requireFokNotActiveBeforeRefund(status)
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
        ? await this.#classifyMintRecovery(
            coordinator,
            walletSeedHex,
            custodyOperationId,
            loaded.record,
            recovery,
            {
              clientOrderId: input.request.clientOrderId,
              operationId: input.operationId,
              orderId: capability.orderId,
            },
          )
        : await this.#applyEngineResult(
            coordinator,
            walletSeedHex,
            custodyOperationId,
            loaded.operation,
            engineResult!,
            reference,
            client,
            preparationResolver,
            input,
            capability.orderId,
            false,
          )
    if (decision.kind === 'reconciling' && engineResult !== null) {
      engineResult = null
      decision = await this.#classifyMintRecovery(
        coordinator,
        walletSeedHex,
        custodyOperationId,
        loaded.record,
        recovery,
        {
          clientOrderId: input.request.clientOrderId,
          operationId: input.operationId,
          orderId: capability.orderId,
        },
      )
    }
    switch (decision.kind) {
      case 'confirmed': {
        this.#requireExactFokSettlement(input, loaded.operation, decision.result)
        await this.#markTerminal(input.operationId)
        startOrderPhase(this.#dependencies.observeOrderTimeline, 'result-completion', {
          clientOrderId: input.request.clientOrderId,
          operationId: input.operationId,
          orderId: capability.orderId,
          applicationPath: engineResult === null ? 'mint-recovery' : 'engine',
          ...(engineResult === null
            ? {}
            : {
                groupId: engineResult.settlementGroupId,
                groupRevision: engineResult.settlementGroupRevision,
              }),
        })('success')
        return
      }
      case 'waiting':
        throw new RangeRecoveryDeferredError(
          'submitted range authorization remains unspent before expiry',
          loaded.operation.expiry * 1_000 + 1_000,
        )
      case 'refundable': {
        const refundableStatus = await this.#loadOrderStatus(input, capability, client)
        this.#requireFokNotActiveBeforeRefund(refundableStatus)
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
    walletSeedHex: string,
    custodyOperationId: string,
    record: DurableCustodyRecord,
    recovery: CtfRangeMintRecoveryAdapter,
    identity: import('./orderTimeline.ts').OrderTimelineIdentity = {},
  ): Promise<DurableCtfRangeRecoveryDecision> {
    identity = { ...identity, applicationPath: 'mint-recovery' }
    const recoveryObservation = await measureOrderPhase(
      this.#dependencies.observeOrderTimeline,
      'mint-observation',
      identity,
      () =>
        recovery.loadUncertainRecoveryObservation({
          record,
          selection: null,
          now: Math.floor(this.#nowMs() / 1_000),
        }),
    )
    const observation = recoveryObservation.observation
    const finishVerification = startOrderPhase(
      this.#dependencies.observeOrderTimeline,
      'recovery-verification-staging',
      identity,
    )
    let staged: DurableCtfRangeRecoveryDecision
    try {
      const decision = await coordinator.classifyRecovery({
        custodyOperationId,
        observation,
        resolveKeyset: recoveryObservation.resolveKeyset,
      })
      staged =
        decision.kind === 'confirmed'
          ? await coordinator.stageRecovered({
              custodyOperationId,
              observation,
              resolveKeyset: recoveryObservation.resolveKeyset,
              observedAtMs: this.#nowMs(),
            })
          : decision
      finishVerification(staged.kind === 'confirmed' ? 'success' : 'unverified')
    } catch (error) {
      finishVerification('failed')
      throw error
    }
    if (staged.kind !== 'confirmed') return staged
    await measureOrderPhase(
      this.#dependencies.observeOrderTimeline,
      'result-application',
      identity,
      () =>
        coordinator.applyStaged({
          seed: walletSeed(walletSeedHex),
          custodyOperationId,
          resolveKeyset: recoveryObservation.resolveKeyset,
          observedAtMs: this.#nowMs(),
        }),
    )
    return staged
  }

  /**
   * Applies a persisted result that is only staged, checks the FOK amount, and ends the order. The result is a
   * verified mint recovery, or an engine result that the engine has since deleted after its acknowledgement.
   */
  async #completePersistedResult(
    coordinator: DaemonCtfRangeCoordinator,
    custodyOperationId: string,
    loaded: NonNullable<Awaited<ReturnType<DaemonCtfRangeCoordinator['load']>>>,
    input: PersistedPreparationInput,
    walletSeedHex: string,
    resolveKeyset: ReturnType<typeof createCtfRangeOrderPreparationKeysetResolver>,
    identity: import('./orderTimeline.ts').OrderTimelineIdentity,
  ): Promise<void> {
    if (loaded.record.operation.result.state === 'verified-staged') {
      await measureOrderPhase(
        this.#dependencies.observeOrderTimeline,
        'result-application',
        identity,
        () =>
          coordinator.applyStaged({
            seed: walletSeed(walletSeedHex),
            custodyOperationId,
            resolveKeyset,
            observedAtMs: this.#nowMs(),
          }),
      )
    }
    const recovered = await coordinator.readAppliedResult({ custodyOperationId, resolveKeyset })
    this.#requireExactFokSettlement(input, loaded.operation, recovered)
    if (loaded.record.operation.result.state === 'applied') {
      startOrderPhase(
        this.#dependencies.observeOrderTimeline,
        'result-application',
        identity,
      )('reused')
    }
    await this.#markTerminal(input.operationId)
    startOrderPhase(this.#dependencies.observeOrderTimeline, 'result-reuse', identity)('reused')
    startOrderPhase(
      this.#dependencies.observeOrderTimeline,
      'result-completion',
      identity,
    )('reused')
  }

  /**
   * Reads the engine result of a persisted engine result. Unlike {@link #getEngineResult}, an unreachable
   * engine defers, so it is never taken for a deleted result.
   */
  async #readAppliedEngineResult(
    client: EngineClientLike,
    operation: DurableCtfRangeOperation,
    reference: SettlementCapabilityResponse['reference'],
    identity: import('./orderTimeline.ts').OrderTimelineIdentity,
  ): Promise<AppliedCtfRangeEngineResultRead> {
    const finish = startOrderPhase(
      this.#dependencies.observeOrderTimeline,
      'engine-result-observation',
      identity,
    )
    const getResult = client.getSettlementCapabilityResultByOperation
    try {
      if (getResult === undefined) throw new Error('engine client does not read settlement results')
      const read = await readAppliedCtfRangeEngineResult(
        { getSettlementCapabilityResultByOperation: (id) => getResult.call(client, id) },
        { operation, reference },
      )
      finish(read.kind === 'available' ? 'success' : 'unverified')
      return read
    } catch {
      finish('failed')
      throw new RangeRecoveryDeferredError(
        'persisted engine range result is unavailable',
        this.#nowMs() + 1_000,
      )
    }
  }

  async #getEngineResult(
    client: EngineClientLike,
    operationId: string,
    identity: import('./orderTimeline.ts').OrderTimelineIdentity,
  ): Promise<SettlementCapabilityResultResponse | null> {
    const finish = startOrderPhase(
      this.#dependencies.observeOrderTimeline,
      'engine-result-observation',
      identity,
    )
    const getResult = client.getSettlementCapabilityResultByOperation
    if (getResult === undefined) {
      finish('unverified')
      return null
    }
    try {
      const result = await getResult.call(client, operationId)
      finish(result === null ? 'unverified' : 'success')
      return result
    } catch {
      finish('failed')
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

  #requireExactFokSettlement(
    input: PersistedPreparationInput,
    operation: DurableCtfRangeOperation,
    result: Extract<DurableCtfRangeRecoveryDecision, { kind: 'confirmed' }>['result'],
  ): void {
    const settledAmount = deriveDurableCtfRangeSettledFaceAmount(operation, result)
    if (settledAmount !== input.request.amountSubunits) {
      throw new Error('settled range amount does not satisfy the submitted FOK order')
    }
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
    replanned = false,
  ): Promise<void> {
    const refund =
      existing ??
      (await this.#prepareRefundOperation(custodyOperationId, source, walletSeedHex, mint))
    assertRangeRefundOperation(refund, custodyOperationId, source)
    const refundKeysetId = readSourceText(refund, 'refundKeysetId')
    const keyset = await loadExactMintKeyset(mint, refundKeysetId)
    assertSavedRangeRefundDerivation(
      refund,
      custodyOperationId,
      source,
      walletSeed(walletSeedHex),
      keyset,
    )
    if (refund.state === 'completed') {
      await coordinator.completeRefund({
        custodyOperationId,
        refundOperationId: refund.operationId,
        refundProofs: completedRangeRefundProofs(refund),
        refundKeyset: keyset,
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
      let response: { signatures: SerializedBlindedSignature[] }
      try {
        response = await this.#executeRefundSwap(refund.mintUrl, {
          inputs: refund.inputs.map(toProof),
          outputs: outputData.map(({ blindedMessage }) => blindedMessage),
        })
      } catch (error) {
        const next = replanned
          ? null
          : await this.#replanRefundAfterOutputReuse(
              error,
              refund,
              custodyOperationId,
              source,
              walletSeedHex,
              mint,
              keyset,
            )
        if (next === null) throw refundRefusalError(refund, error)
        // Retry once now with the same inputs and the new outputs.
        return this.#resumeOrCreateRefund(
          coordinator,
          custodyOperationId,
          source,
          walletSeedHex,
          mint,
          next,
          true,
        )
      }
      proofs = unblindRangeRefund(outputData, response.signatures, keyset)
    } else if (states.every(({ state }) => state === 'SPENT')) {
      proofs = await this.#restoreSpentRefund(refund)
    } else {
      throw new Error('range refund remains pending at the mint')
    }
    await coordinator.completeRefund({
      custodyOperationId,
      refundOperationId: refund.operationId,
      refundProofs: proofs,
      refundKeyset: keyset,
      refundAsset: rangeOfferStoredAsset(source),
      observedAtMs: this.#nowMs(),
    })
  }

  /**
   * Restore the outputs of the refund that the mint committed, from the
   * current plan (ADR-037). A NUT-09 hit only on a replaced plan does not
   * prove that this refund committed with it: the SDK throws
   * `CtfRangeRefundReplacedPlanSignedError`, the refund halts at once, and
   * the daemon admits nothing. A restore that the mint did not answer proves
   * nothing, so the refund stays pending, as in the browser.
   */
  async #restoreSpentRefund(refund: ProofOperationRecord): Promise<Proof[]> {
    const restore = this.#dependencies.restoreOutputs ?? restoreOutputGroups
    return restoreSpentCtfRangeRefund({
      currentPlan: refund.outputs,
      replacedPlans: replacedRefundOutputGroups(refund),
      restore: async (outputs) => {
        const proofs = (await restore(refund.mintUrl, outputs)).refund ?? []
        if (proofs.length === 0 || proofs.length !== (outputs.refund?.length ?? 0)) {
          throw new Error('range refund restore is incomplete')
        }
        return proofs
      },
      isTransportFailure: (error) =>
        error instanceof HttpResponseError || error instanceof NetworkError,
    })
  }

  /**
   * After 11003 or 11008 on a refund swap, another client signed the planned
   * outputs. When every input is still unspent, advance the counter, plan new
   * outputs for the same inputs, and keep the replaced plan for restore.
   */
  async #replanRefundAfterOutputReuse(
    error: unknown,
    refund: ProofOperationRecord,
    custodyOperationId: string,
    source: DurableCtfRangeOperation,
    walletSeedHex: string,
    mint: CtfRangeMintLike & CtfRangeMintClient,
    keyset: MintKeys,
  ): Promise<ProofOperationRecord | null> {
    const failure = classifyCashuMintFailure(error)
    if (failure.kind !== 'refusal' || !MINT_OUTPUT_REUSE_REFUSAL_CODES.has(failure.code)) {
      return null
    }
    // Legacy refund outputs come from their own derivation, not NUT-13 counters.
    if (!Object.hasOwn(refund.metadata, 'refundOutputPlan')) return null
    const replaced = savedReplacedCtfRangeRefundOutputPlans(refund.metadata)
    if (replaced.length >= CTF_RANGE_REFUND_REPLACED_OUTPUT_PLANS_MAX) return null
    let states: ProofState[]
    try {
      states = await checkCtfRangeInputProofStates(mint, refund.inputs.map(toProof))
    } catch {
      return null
    }
    if (states.length !== refund.inputs.length || states.some(({ state }) => state !== 'UNSPENT')) {
      return null
    }
    try {
      await advanceCountersPastMint({
        storage: this.#storage,
        mutation: () => this.#mutation(),
        mint,
        mintUrl: refund.mintUrl,
        walletSeedHex,
        keysetIds: [keyset.id],
      })
    } catch {
      return null
    }
    return this.#persistRefundReplan(refund, custodyOperationId, source, walletSeedHex, keyset, [
      ...replaced,
      refund.metadata.refundOutputPlan,
    ])
  }

  async #persistRefundReplan(
    refund: ProofOperationRecord,
    custodyOperationId: string,
    source: DurableCtfRangeOperation,
    walletSeedHex: string,
    keyset: MintKeys,
    replacedRefundOutputPlans: readonly unknown[],
  ): Promise<ProofOperationRecord> {
    const refundAmount =
      source.inputs.reduce((total, proof) => total + Amount.from(proof.amount).toBigInt(), 0n) -
      deriveDurableCtfRangeFeeBounds(source).maximumFee
    for (let attempt = 0; attempt < 3; attempt++) {
      const mutation = this.#mutation()
      const transcript = createSpeculativeCounterTranscript(
        await readDaemonCounterSnapshots({
          storage: this.#storage,
          mutation,
          keysetIds: [keyset.id],
          binding: { normalizedMint: source.mintUrl, unit: 'msat' },
        }),
      )
      const prepared = await prepareDurableSeedDerivedCtfRangeRefund({
        seed: walletSeed(walletSeedHex),
        counterSource: transcript.counterSource,
        source,
        refundOperationId: refund.operationId,
        amount: refundAmount,
        keyset,
      })
      try {
        return await withDurableCustodyUnitOfWork(
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
            commitDaemonCounterTranscript(
              database,
              mutation.fence.scopeId,
              { normalizedMint: source.mintUrl, unit: 'msat' },
              transcript,
              mutation.observedAtMs,
            )
            return replanCtfRangeRefundProofOperationFromDatabase(database, {
              expected: refund,
              replacement: {
                operationId: refund.operationId,
                kind: 'swap-refund',
                mintUrl: prepared.operation.mintUrl,
                inputs: prepared.request.inputs,
                outputs: {
                  refund: serializeOutputDataArray(
                    prepared.plan.outputs.map(OutputData.deserialize),
                  ),
                },
                metadata: {
                  ...prepared.operation.metadata,
                  purpose: CTF_RANGE_REFUND_PURPOSE,
                  rangeOperationId: source.operationId,
                  custodyOperationId,
                  refundKeysetId: keyset.id,
                  refundOutputPlan: prepared.plan,
                  replacedRefundOutputPlans: structuredClone([...replacedRefundOutputPlans]),
                },
              },
              observedAtMs: mutation.observedAtMs,
            })
          },
        )
      } catch (error) {
        if (!(error instanceof DaemonCounterSnapshotConflictError) || attempt === 2) throw error
      }
    }
    throw new Error('range refund counter attempts exhausted')
  }

  async #prepareRefundOperation(
    custodyOperationId: string,
    source: DurableCtfRangeOperation,
    walletSeedHex: string,
    mint: CtfRangeMintLike,
  ): Promise<ProofOperationRecord> {
    const operationId = deriveDurableCtfRangeRefundOperationId(source.operationId)
    const readSaved = () => {
      const mutation = this.#mutation()
      return withDurableCustodyFencedRead(
        this.#storage,
        mutation.fence,
        mutation.observedAtMs,
        (database) => {
          const saved = readDaemonProofOperationFromDatabase(database, operationId)
          if (saved !== null) assertRangeRefundOperation(saved, custodyOperationId, source)
          return saved
        },
        { snapshot: true },
      )
    }
    const existing = await readSaved()
    if (existing !== null) return existing
    const refundAmount =
      source.inputs.reduce((total, proof) => total + Amount.from(proof.amount).toBigInt(), 0n) -
      deriveDurableCtfRangeFeeBounds(source).maximumFee
    if (refundAmount <= 0n) throw new Error('range refund amount is fee-dominated')
    const keyset = structuredClone(
      await selectRangeRefundKeyset(
        mint,
        source,
        this.#nowSeconds(),
        this.#dependencies.allowInsecureLoopbackHttp === true,
      ),
    )
    const observedSource = await this.#storage.read((database) => {
      const loaded = loadDaemonDurableCtfRangeAuthority(
        new DurableCustodySqliteStore(database),
        custodyOperationId,
      )
      if (loaded === null || !isDeepStrictEqual(loaded.operation, source))
        throw new Error('range refund source authority changed')
      return loaded.record.revision
    })
    for (let attempt = 0; attempt < 3; attempt++) {
      const mutation = this.#mutation()
      const transcript = createSpeculativeCounterTranscript(
        await readDaemonCounterSnapshots({
          storage: this.#storage,
          mutation,
          keysetIds: [keyset.id],
          binding: { normalizedMint: source.mintUrl, unit: 'msat' },
        }),
      )
      const prepared = await prepareDurableSeedDerivedCtfRangeRefund({
        seed: walletSeed(walletSeedHex),
        counterSource: transcript.counterSource,
        source,
        refundOperationId: operationId,
        amount: refundAmount,
        keyset,
      })
      await this.#dependencies.observeRefundPrepared?.(
        structuredClone({ operationId, outputs: prepared.plan.outputs, plan: prepared.plan }),
      )
      try {
        return await withDurableCustodyUnitOfWork(
          this.#storage,
          mutation.fence,
          mutation.observedAtMs,
          (database) => {
            const saved = readDaemonProofOperationFromDatabase(database, operationId)
            if (saved !== null) {
              assertRangeRefundOperation(saved, custodyOperationId, source)
              return saved
            }
            const loaded = loadDaemonDurableCtfRangeAuthority(
              new DurableCustodySqliteStore(database),
              custodyOperationId,
            )
            if (
              loaded === null ||
              loaded.record.revision !== observedSource ||
              !isDeepStrictEqual(loaded.operation, source)
            )
              throw new Error('range refund source authority changed')
            assertRangeRefundSourceLocked(
              database,
              mutation.fence.scopeId,
              custodyOperationId,
              source.inputs.length,
            )
            commitDaemonCounterTranscript(
              database,
              mutation.fence.scopeId,
              { normalizedMint: source.mintUrl, unit: 'msat' },
              transcript,
              mutation.observedAtMs,
            )
            this.#dependencies.injectRefundPreparationFault?.('counter-written')
            const record = prepareCtfRangeRefundProofOperationFromDatabase(
              database,
              {
                operationId,
                kind: 'swap-refund',
                mintUrl: prepared.operation.mintUrl,
                inputs: prepared.request.inputs,
                outputs: {
                  refund: serializeOutputDataArray(
                    prepared.plan.outputs.map(OutputData.deserialize),
                  ),
                },
                metadata: {
                  ...prepared.operation.metadata,
                  purpose: CTF_RANGE_REFUND_PURPOSE,
                  rangeOperationId: source.operationId,
                  custodyOperationId,
                  refundKeysetId: keyset.id,
                  refundOutputPlan: prepared.plan,
                },
              },
              mutation.observedAtMs,
            )
            this.#dependencies.injectRefundPreparationFault?.('journal-bound')
            return record
          },
          this.#dependencies.injectRefundUnitOfWorkFault === undefined
            ? {}
            : { injectFault: this.#dependencies.injectRefundUnitOfWorkFault },
        )
      } catch (error) {
        const saved = await readSaved()
        if (saved !== null) return saved
        if (!(error instanceof DaemonCounterSnapshotConflictError) || attempt === 2) throw error
      }
    }
    throw new Error('range refund counter attempts exhausted')
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
    walletSeedHex: string,
    custodyOperationId: string,
    operation: DurableCtfRangeOperation,
    engineResult: CtfRangeEngineResult,
    reference: { readonly artifactId: string; readonly bindingDigest: string },
    client: EngineClientLike,
    resolveKeyset: DurableCtfRangeKeysetResolver,
    input: PersistedPreparationInput,
    orderId: string,
    alreadyApplied: boolean,
    persisted = false,
  ): Promise<DurableCtfRangeRecoveryDecision> {
    const identity = {
      applicationPath: persisted ? ('persisted-engine-reuse' as const) : ('engine' as const),
      clientOrderId: input.request.clientOrderId,
      operationId: input.operationId,
      orderId,
      groupId: engineResult.settlementGroupId,
      groupRevision: engineResult.settlementGroupRevision,
    }
    const finishVerification = startOrderPhase(
      this.#dependencies.observeOrderTimeline,
      persisted ? 'result-verification-recheck' : 'result-verification',
      identity,
    )
    let decision: DurableCtfRangeRecoveryDecision
    try {
      decision = await coordinator.stageVerified({
        custodyOperationId,
        operation,
        envelope: engineResult.envelope,
        resolveKeyset,
        observedAtMs: this.#nowMs(),
      })
      finishVerification(decision.kind === 'confirmed' ? 'success' : 'unverified')
    } catch (error) {
      finishVerification('failed')
      throw error
    }
    if (decision.kind !== 'confirmed') return decision
    await measureOrderPhase(
      this.#dependencies.observeOrderTimeline,
      'result-application',
      identity,
      () =>
        coordinator.applyStaged({
          seed: walletSeed(walletSeedHex),
          custodyOperationId,
          resolveKeyset,
          observedAtMs: this.#nowMs(),
        }),
      alreadyApplied ? 'reused' : 'success',
    )
    this.#requireExactFokSettlement(input, operation, decision.result)
    await measureOrderPhase(
      this.#dependencies.observeOrderTimeline,
      'result-acknowledgement',
      identity,
      () => this.#acknowledgeResult(client, operation, reference, engineResult),
      engineResult.acknowledgedAt === null ? 'success' : 'reused',
    )
    return decision
  }

  #requireFokNotActiveBeforeRefund(status: OrderStatusResponse | null): void {
    switch (status?.status) {
      case 'resting':
      case 'matched':
      case 'partially_filled':
        throw new Error('public FOK order is unexpectedly active during refund recovery')
    }
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
    consentedFeeFacts?: CtfRangeOrderFeeFacts,
    allowFreshSource = true,
    wallet?: CtfRangeWalletLike,
  ): Promise<SourceResult> {
    try {
      return await prepareOrResumeSource(
        authority,
        walletSeedHex,
        this.#dependencies,
        consentedFeeFacts,
        allowFreshSource,
        wallet,
      )
    } catch (error) {
      if (error instanceof ProofConsolidationRequiredError) {
        await this.#markTerminal(authority.preparationInput.operationId)
      }
      if (error instanceof CtfRangeOrderOutputCheckError) {
        // The source request was not sent and holds no funds, so the attempt
        // ends here and leaves no recovery work.
        await this.#endUnfundedPreparation(authority.preparationInput.operationId)
      }
      if (error instanceof UnresolvedRangeSellError) {
        await this.#endUnfundedPreparation(authority.preparationInput.operationId)
        const blocking = error.blockingOperationId
        throw new CtfRangeSellPreparationPendingError(
          blocking !== null && this.#haltedRecovery(blocking) !== null
            ? rangeOrderRetryCommand(blocking)
            : null,
        )
      }
      throw error
    }
  }

  /** End a refused attempt's journal when it holds no funds, so it leaves no recovery work. */
  async #endUnfundedPreparation(rangeOperationId: string): Promise<void> {
    const mutation = this.#mutation()
    await withDurableCustodyUnitOfWork(
      this.#storage,
      mutation.fence,
      mutation.observedAtMs,
      (database) => {
        const scopeId = mutation.fence.scopeId
        const journal = readRangePreparation(database, scopeId, rangeOperationId)
        if (journal?.lifecycleState !== 'prepared') return
        if (rangePreparationHoldsReservedFunds(database, scopeId, rangeOperationId)) return
        transitionRangePreparation(database, {
          scopeId,
          rangeOperationId,
          expectedRevision: journal.revision,
          from: 'prepared',
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

function preparedMintAuthority(
  preparationInput: PersistedPreparationInput,
  walletSeedHex: string,
  metadata: LoadedMintMetadata,
  mint: CtfRangeMintLike,
  consolidateProofs: boolean,
  storage: DaemonStateSqliteSession,
  mutation: () => FencedStateMutation,
): PreparedMintAuthority {
  return {
    preparation: reconstructCtfRangePreparation(preparationInput, walletSeed(walletSeedHex)),
    preparationInput,
    lookup: ctfRangeOrderPreparationKeysetLookup(preparationInput),
    observation: metadata.observation,
    mintKeysets: exactCtfRangeOrderPreparationMintKeysets(preparationInput),
    offerAsset: assetForKeyset(preparationInput.offerKeyset),
    mint,
    loadedSourceLimits: {
      maxInputs: preparationInput.maxInputs,
      maxOutputs: metadata.maxOutputs,
    },
    consolidateProofs,
    storage,
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
  const { walletSeedHex: _, consolidateProofs: ___, ...request } = input
  return structuredClone(request) as PersistedPreparationInput['request']
}

function requireFokOrder(timeInForce: unknown): asserts timeInForce is 'FOK' {
  if (timeInForce !== 'FOK') {
    throw new Error('public range orders require FOK')
  }
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
  storage: DaemonStateSqliteSession,
  mutation: () => FencedStateMutation,
): PreparedMintAuthority {
  const preparation = reconstructCtfRangePreparation(input, walletSeed(walletSeedHex))
  return {
    preparation,
    preparationInput: input,
    lookup: ctfRangeOrderPreparationKeysetLookup(input),
    observation: input.expiryObservation,
    mintKeysets: exactCtfRangeOrderPreparationMintKeysets(input),
    offerAsset: assetForKeyset(input.offerKeyset),
    mint,
    loadedSourceLimits: null,
    consolidateProofs,
    storage,
    mutation,
  }
}

type SourceResult =
  | {
      readonly mode: 'same-keyset-swap'
      readonly authorization: Proof[]
      readonly keep: Proof[]
    }
  | ({ readonly mode: 'mixed-source-ctf-convert' } & CtfRangeMixedSourceResult)

type SourceMode = SourceResult['mode']

type PreparedSource =
  | {
      readonly mode: 'same-keyset-swap'
      readonly operation: DurableCustodyProofOperationInput
      readonly transcript: SpeculativeCounterTranscript
    }
  | {
      readonly mode: 'mixed-source-ctf-convert'
      readonly operation: DurableCustodyProofOperationInput
      readonly transcript: SpeculativeCounterTranscript
    }

type SourceWallet = () => Promise<CtfRangeWalletLike>

async function prepareOrResumeSource(
  authority: PreparedMintAuthority,
  walletSeedHex: string,
  dependencies: DaemonCtfRangeOrderCoordinatorDependencies,
  consentedFeeFacts?: CtfRangeOrderFeeFacts,
  allowFreshSource = true,
  providedWallet?: CtfRangeWalletLike,
): Promise<SourceResult> {
  const wallet = lazySourceWallet(authority, walletSeedHex, dependencies, providedWallet)
  const existing = await getProofOperation(authority.preparation.sourceOperationId)
  if (existing !== null) {
    return resumeExistingSource(existing, authority, walletSeedHex, wallet, dependencies)
  }
  // Exact persisted work finishes before fresh selection. Fresh selection then
  // needs current mint limits and fee facts, never a bound from an old process.
  let round = await resumeExistingConsolidations(authority, walletSeedHex, wallet, dependencies)
  if (!allowFreshSource) {
    throw new Error('fresh range source preparation requires explicit fee consent')
  }
  // Refuse before selection, so a sell that the earlier sell left short of
  // funds gets this refusal. Each reservation checks again in its transaction.
  const mutation = authority.mutation()
  await withDurableCustodyFencedRead(
    authority.storage,
    mutation.fence,
    mutation.observedAtMs,
    (database) => requireNoUnresolvedSell(database, authority, mutation.fence.scopeId),
  )
  for (;;) {
    const limits = await freshSourceLimits(authority, dependencies)
    const planned = await planFreshSourceWithFees(authority, limits, round)
    await assertSourceFeeConsent(authority, consentedFeeFacts, planned.feeFacts)
    if (planned.consolidation === null) {
      const selected = await completeSelectedSource(
        authority,
        walletSeedHex,
        wallet,
        planned.selection.plan,
        dependencies,
      )
      if (selected === null) throw new Error('daemon range source plan is not executable')
      return selected
    }
    if (round >= MAX_CONSOLIDATION_ROUNDS) {
      throw new Error('range authorization exceeded the bounded consolidation round limit')
    }
    const plannedRound = planned.consolidation.consolidationRounds[0]
    if (plannedRound === undefined) {
      throw new Error('range consolidation plan has no executable round')
    }
    const page = await availableSourceProofs(
      authority,
      'offered',
      authority.preparationInput.maxInputs,
    )
    await consolidateSourceProofs(
      authority,
      await wallet(),
      walletSeedHex,
      page.proofs,
      round,
      sourceConsolidationId(authority.preparation.sourceOperationId, round),
      plannedRound,
      dependencies,
    )
    round += 1
  }
}

async function resumeExistingSource(
  existing: ProofOperationRecord,
  authority: PreparedMintAuthority,
  walletSeedHex: string,
  wallet: SourceWallet,
  dependencies: DaemonCtfRangeOrderCoordinatorDependencies,
): Promise<SourceResult> {
  assertRangeSourceOperation(existing)
  const mode = persistedSourceMode(existing)
  if (mode === 'same-keyset-swap' && existing.state === 'completed') {
    return completedSourceResult(existing)
  }
  const mutation = authority.mutation()
  const staged = await withDurableCustodyFencedRead(
    createDaemonStateSqliteSession(profileDir()),
    mutation.fence,
    mutation.observedAtMs,
    (database) => readStagedSourceResult(database, existing, mode, mutation.fence.scopeId),
  )
  if (staged !== null) return staged
  return resumeSourceOperation(existing, mode, authority, walletSeedHex, wallet, dependencies)
}

function lazySourceWallet(
  authority: PreparedMintAuthority,
  walletSeedHex: string,
  dependencies: DaemonCtfRangeOrderCoordinatorDependencies,
  providedWallet: CtfRangeWalletLike | undefined,
): SourceWallet {
  // Loading a swap wallet is mint I/O. The mixed source and exact staged
  // recovery do not need it, so load it only for same-keyset work.
  let loaded: Promise<CtfRangeWalletLike> | undefined =
    providedWallet === undefined ? undefined : Promise.resolve(providedWallet)
  return () => {
    loaded ??= loadSourceWallet(authority, walletSeedHex, dependencies)
    return loaded
  }
}

async function loadSourceWallet(
  authority: PreparedMintAuthority,
  walletSeedHex: string,
  dependencies: DaemonCtfRangeOrderCoordinatorDependencies,
): Promise<CtfRangeWalletLike> {
  const wallet =
    dependencies.createWallet?.(authority.preparation.mintUrl, walletSeedHex) ??
    (new CashuWallet(new CashuMint(authority.preparation.mintUrl), {
      unit: 'msat',
      bip39seed: walletSeed(walletSeedHex),
    }) as CtfRangeWalletLike)
  await wallet.loadMint()
  return wallet
}

async function freshSourceLimits(
  authority: PreparedMintAuthority,
  dependencies: DaemonCtfRangeOrderCoordinatorDependencies,
): Promise<SourceSelectionLimits> {
  if (authority.loadedSourceLimits !== null) return authority.loadedSourceLimits
  const preparation = authority.preparationInput
  const metadata = await loadMintMetadata(
    authority.mint,
    preparation.mintUrl,
    preparation.conditionId,
    Math.floor(authority.mutation().observedAtMs / 1_000),
    dependencies.allowInsecureLoopbackHttp === true,
  )
  assertCurrentSourceKeysets(preparation, metadata)
  return {
    maxInputs: Math.min(preparation.maxInputs, metadata.maxInputs),
    maxOutputs: metadata.maxOutputs,
  }
}

function assertCurrentSourceKeysets(
  preparation: PersistedPreparationInput,
  metadata: LoadedMintMetadata,
): void {
  if (metadata.observation.canonicalMintUrl !== preparation.mintUrl) {
    throw new Error('current mint metadata is for a foreign mint')
  }
  const current = new Map<string, ActiveCtfRangeMintKeyset>(
    [...metadata.regular, ...metadata.conditional].map((keyset) => [keyset.id, keyset]),
  )
  for (const expected of [preparation.offerKeyset, preparation.receiveKeyset]) {
    const actual = current.get(expected.id)
    if (
      actual === undefined ||
      !isDeepStrictEqual(custodyKeysetAuthority(actual), custodyKeysetAuthority(expected))
    ) {
      throw new Error('current mint source keyset differs from the range preparation')
    }
  }
}

async function selectFreshSource(
  authority: PreparedMintAuthority,
  limits: SourceSelectionLimits,
): Promise<{ readonly plan: CtfRangeCapabilitySourcePlan; readonly offeredHasMore: boolean }> {
  const preparation = authority.preparationInput
  const offered = await availableSourceProofs(authority, 'offered', limits.maxInputs)
  // A Sell can pay its preparation fee from regular cash. A Buy already offers
  // regular cash, so it has no separate collateral group.
  const collateral =
    preparation.side === 'Sell'
      ? await availableSourceProofs(authority, 'collateral', limits.maxInputs)
      : { proofs: [], hasMore: false }
  const plan = planCtfRangeCapabilitySource({
    side: preparation.side,
    authorizationAmounts: authority.preparation.authorizationOutputs.map((output) =>
      output.blindedMessage.amount.toString(),
    ),
    offeredKeyset: preparation.offerKeyset,
    collateralKeyset:
      preparation.side === 'Sell' ? preparation.receiveKeyset : preparation.offerKeyset,
    complementKeyset: preparation.complementKeyset,
    offeredCandidates: offered.proofs,
    collateralCandidates: collateral.proofs,
    maxInputs: limits.maxInputs,
    maxOutputs: limits.maxOutputs,
  })
  return { plan, offeredHasMore: offered.hasMore }
}

type ExecutableSourcePlan = Extract<
  CtfRangeCapabilitySourcePlan,
  { readonly kind: 'same-keyset-swap' | 'mixed-source-ctf-convert' }
>

async function planFreshSourceWithFees(
  authority: PreparedMintAuthority,
  limits: SourceSelectionLimits,
  completedConsolidationRounds: number,
): Promise<{
  readonly selection: Awaited<ReturnType<typeof selectFreshSource>>
  readonly consolidation: Extract<BoundedProofConsolidationPlan, { readonly kind: 'ready' }> | null
  readonly feeFacts: CtfRangeOrderFeeFacts
}> {
  const selection = await selectFreshSource(authority, limits)
  if (
    selection.plan.kind === 'same-keyset-swap' ||
    selection.plan.kind === 'mixed-source-ctf-convert'
  ) {
    return {
      selection,
      consolidation: null,
      feeFacts: directSourceFeeFacts(authority.preparationInput, selection.plan),
    }
  }
  assertConsolidationCanHelp(selection.plan, selection.offeredHasMore)
  if (!selection.offeredHasMore) throw new Error('daemon has insufficient exact range-order funds')
  if (!authority.consolidateProofs) throw new ProofConsolidationRequiredError()

  // The bounded plan includes both the new consolidation fees and the later
  // source fee. An offered-asset shortfall refuses before either mint effect.
  const consolidation = await planSourceConsolidation(
    authority,
    MAX_CONSOLIDATION_ROUNDS - completedConsolidationRounds,
  )
  if (consolidation.kind !== 'ready') throw consolidationPlanError(consolidation.kind)
  return {
    selection,
    consolidation,
    feeFacts: boundedConsolidationFeeFacts(authority.preparationInput, consolidation),
  }
}

function directSourceFeeFacts(
  preparation: PersistedPreparationInput,
  plan: ExecutableSourcePlan,
): CtfRangeOrderFeeFacts {
  const sourceMode =
    plan.kind === 'mixed-source-ctf-convert'
      ? 'mixed-source-ctf-convert'
      : preparation.side === 'Buy'
        ? 'wallet-send'
        : 'conditional-keyset-swap'
  const offeredAsset = offeredFeeAsset(preparation)
  return composeCtfRangeOrderFeeFacts({
    authorizationPlan: planPersistedCtfRangeOrderAuthorization(preparation),
    sourcePlan: plan,
    sourceMode,
    consolidationFeeSubunits: '0',
    settlementAsset: { kind: 'regular', unit: 'msat' },
    sourcePreparationAsset:
      sourceMode === 'conditional-keyset-swap' ? offeredAsset : { kind: 'regular', unit: 'msat' },
    consolidationAsset: offeredAsset,
  })
}

function boundedConsolidationFeeFacts(
  preparation: PersistedPreparationInput,
  plan: Extract<BoundedProofConsolidationPlan, { readonly kind: 'ready' }>,
): CtfRangeOrderFeeFacts {
  const offeredAsset = offeredFeeAsset(preparation)
  return {
    settlementInputFeeSubunits:
      planPersistedCtfRangeOrderAuthorization(preparation).participantFeeAllocationUpperBound,
    sourcePreparationFeeSubunits: plan.sourceFee,
    consolidationFeeSubunits: plan.consolidationFee,
    settlementAsset: { kind: 'regular', unit: 'msat' },
    sourcePreparationAsset: offeredAsset,
    consolidationAsset: offeredAsset,
    sourceMode: preparation.side === 'Buy' ? 'wallet-send' : 'conditional-keyset-swap',
  }
}

function offeredFeeAsset(preparation: PersistedPreparationInput): DurableCtfRangeAsset {
  const asset = assetForKeyset(preparation.offerKeyset)
  switch (asset.kind) {
    case 'sats':
      return { kind: 'regular', unit: 'msat' }
    case 'Outcome':
      return {
        kind: 'conditional',
        unit: 'msat',
        conditionId: asset.conditionId,
        outcomeCollection: asset.outcomeSetId,
      }
    default:
      return assertNeverStoredAsset(asset)
  }
}

function assertNeverStoredAsset(value: never): never {
  throw new Error(`unhandled range source asset: ${String(value)}`)
}

async function assertSourceFeeConsent(
  authority: PreparedMintAuthority,
  consented: CtfRangeOrderFeeFacts | undefined,
  current: CtfRangeOrderFeeFacts,
): Promise<void> {
  if (consented === undefined) return
  const paid = await sourceConsolidationSummary(authority.preparation.sourceOperationId)
  assertCtfRangeOrderFeeConsent({
    consented,
    current,
    paidConsolidationFeeSubunits: String(paid.feeSubunits),
  })
}

async function completeSelectedSource(
  authority: PreparedMintAuthority,
  walletSeedHex: string,
  wallet: SourceWallet,
  plan: CtfRangeCapabilitySourcePlan,
  dependencies: DaemonCtfRangeOrderCoordinatorDependencies,
): Promise<SourceResult | null> {
  switch (plan.kind) {
    case 'mixed-source-ctf-convert': {
      return completeNewSource(
        authority,
        async () => {
          const transcript = await sourceCounterTranscript(authority, [
            authority.preparationInput.offerKeyset.id,
            authority.preparationInput.receiveKeyset.id,
          ])
          const operation = await prepareCtfRangeMixedSourceOperation({
            preparation: authority.preparationInput,
            seed: walletSeed(walletSeedHex),
            counterSource: transcript.counterSource,
            plan,
          })
          return { mode: 'mixed-source-ctf-convert', operation, transcript }
        },
        walletSeedHex,
        wallet,
        dependencies,
      )
    }
    case 'same-keyset-swap': {
      return completeNewSource(
        authority,
        async () => {
          const transcript = await sourceCounterTranscript(authority, [
            authority.preparationInput.offerKeyset.id,
          ])
          const source = await prepareSourceOperation(
            authority,
            walletSeedHex,
            await wallet(),
            [...plan.inputs],
            transcript,
          )
          if (source === null) throw new Error('daemon has insufficient exact range-order funds')
          return { ...source, transcript }
        },
        walletSeedHex,
        wallet,
        dependencies,
      )
    }
    // Collateral-only conversion cannot stand in for held shares, so a Sell
    // with too few shares is refused rather than split from cash.
    case 'collateral-ctf-convert':
    case 'consolidation-required':
    case 'source-unavailable':
      return null
    default:
      return assertNeverSourcePlan(plan)
  }
}

/**
 * Refuse before consolidation when it cannot fix the shortfall. Consolidating
 * shares cannot supply missing fee cash, so that refusal is immediate. A mint
 * input bound can yield to consolidation only when more offered proofs exist
 * beyond the bounded page; the bounded consolidation plan still refuses
 * without spending when it cannot fund the source, including its fee.
 */
function assertConsolidationCanHelp(
  plan: CtfRangeCapabilitySourcePlan,
  offeredHasMore: boolean,
): void {
  switch (plan.kind) {
    case 'source-unavailable':
      assertShortfallConsolidationCanHelp(plan.shortfall, offeredHasMore)
      return
    case 'collateral-ctf-convert':
    case 'consolidation-required':
    case 'mixed-source-ctf-convert':
    case 'same-keyset-swap':
      return
    default:
      return assertNeverSourcePlan(plan)
  }
}

function assertShortfallConsolidationCanHelp(
  shortfall: CtfRangeSourceShortfall,
  offeredHasMore: boolean,
): void {
  switch (shortfall) {
    case 'offered':
      return
    case 'collateral':
      throw new Error('daemon wallet needs ordinary sats to pay the range source preparation fee')
    case 'mint-limits':
      if (offeredHasMore) return
      throw new Error(
        'daemon range source needs more proofs than the mint accepts in one request; try a smaller amount',
      )
    default:
      return assertNeverSourcePlan(shortfall)
  }
}

function assertNeverSourcePlan(value: never): never {
  throw new Error(`unhandled range source plan: ${String(value)}`)
}

async function resumeExistingConsolidations(
  authority: PreparedMintAuthority,
  walletSeedHex: string,
  wallet: SourceWallet,
  dependencies: DaemonCtfRangeOrderCoordinatorDependencies,
): Promise<number> {
  for (let round = 0; round < MAX_CONSOLIDATION_ROUNDS; round += 1) {
    const operation = await getProofOperation(
      sourceConsolidationId(authority.preparation.sourceOperationId, round),
    )
    if (operation === null) return round
    await resumeConsolidationOperation(
      operation,
      authority,
      walletSeedHex,
      await wallet(),
      dependencies,
    )
  }
  return MAX_CONSOLIDATION_ROUNDS
}

async function completeNewSource(
  authority: PreparedMintAuthority,
  prepare: () => Promise<PreparedSource>,
  walletSeedHex: string,
  wallet: SourceWallet,
  dependencies: DaemonCtfRangeOrderCoordinatorDependencies,
): Promise<SourceResult> {
  let source: PreparedSource | undefined
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await getProofOperation(authority.preparation.sourceOperationId)
    if (existing !== null) {
      return resumeExistingSource(existing, authority, walletSeedHex, wallet, dependencies)
    }
    source = await prepareCheckedSource(authority, walletSeedHex, prepare)
    let wasAlreadyCommitted: boolean
    try {
      wasAlreadyCommitted = await persistPreparedSource(authority, source, dependencies)
    } catch (error) {
      const committed = await getProofOperation(authority.preparation.sourceOperationId)
      if (committed !== null) {
        return resumeExistingSource(committed, authority, walletSeedHex, wallet, dependencies)
      }
      if (!(error instanceof DaemonCounterSnapshotConflictError)) throw error
      if (attempt === 2) {
        throw new Error('daemon CTF source preparation contention; retry the exact request')
      }
      continue
    }
    if (wasAlreadyCommitted) {
      const committed = await getProofOperation(authority.preparation.sourceOperationId)
      if (committed === null) throw new Error('range source operation is missing')
      return resumeExistingSource(committed, authority, walletSeedHex, wallet, dependencies)
    }
    break
  }
  if (source === undefined) throw new Error('daemon CTF source preparation was not constructed')
  let result: SourceResult
  try {
    result = await completePreparedSource(source, authority, walletSeedHex, wallet)
  } catch (error) {
    const entry = await getProofOperation(authority.preparation.sourceOperationId)
    if (entry === null) throw error
    // Returns only when every input is spent; recovery then restores the
    // exact outputs from a new reading.
    await settleRangeRequestRefusal(
      error,
      sourceRefusalRequest(entry, authority, walletSeedHex, wallet, dependencies),
      (mintError) => freshRequestPendingError('source', entry.operationId, mintError, error),
    )
    throw error
  }
  await stageSourceResult(authority, result)
  return result
}

/**
 * Check the seed-derived outputs of the new source request with the mint
 * before it is persisted and sent (ADR-037 reused-output amendment, decision
 * 14). An output that another client of this seed already signed moves the
 * durable counter past the signed outputs, and `prepare` builds the request
 * again from a fresh counter snapshot.
 */
function prepareCheckedSource(
  authority: PreparedMintAuthority,
  walletSeedHex: string,
  prepare: () => Promise<PreparedSource>,
): Promise<PreparedSource> {
  const binding = { normalizedMint: authority.preparation.mintUrl, unit: 'msat' as const }
  return prepareCheckedCtfRangeSourceOperation({
    mint: authority.mint,
    seed: walletSeed(walletSeedHex),
    prepare,
    skipSignedCounters: (skip) =>
      advanceDaemonKeysetCounter(skip.keysetId, skip.nextCounter, authority.mutation(), binding),
  })
}

async function stageSourceResult(
  authority: PreparedMintAuthority,
  result: SourceResult,
): Promise<void> {
  const source = await getProofOperation(authority.preparation.sourceOperationId)
  if (source == null) throw new Error('range source operation is missing')
  const custodyId = requireText(source.metadata.custodySourceOperationId, 'source custody identity')
  const mutation = authority.mutation()
  await withDurableCustodyUnitOfWork(
    profileDir(),
    mutation.fence,
    mutation.observedAtMs,
    (database) => {
      switch (result.mode) {
        case 'same-keyset-swap':
          stageDaemonRangeSourceResult(
            database,
            custodyId,
            { authorization: result.authorization, keep: result.keep },
            mutation.fence,
            mutation.observedAtMs,
          )
          return
        case 'mixed-source-ctf-convert':
          stageDaemonRangeMixedSourceResult(
            database,
            custodyId,
            result,
            mutation.fence,
            mutation.observedAtMs,
          )
          return
        default:
          return assertNeverSourceMode(result)
      }
    },
  )
}

async function prepareSourceOperation(
  authority: PreparedMintAuthority,
  walletSeedHex: string,
  wallet: CtfRangeWalletLike,
  candidates: Proof[],
  transcript: SpeculativeCounterTranscript,
): Promise<PreparedSource | null> {
  const operation = await prepareCtfRangeSourceOperation({
    preparation: authority.preparationInput,
    seed: walletSeed(walletSeedHex),
    counterSource: transcript.counterSource,
    wallet,
    candidates,
  })
  return operation === null ? null : { mode: 'same-keyset-swap', operation, transcript }
}

async function sourceCounterTranscript(
  authority: PreparedMintAuthority,
  keysetIds: readonly string[],
): Promise<SpeculativeCounterTranscript> {
  const mutation = authority.mutation()
  const snapshots = await readDaemonCounterSnapshots({
    storage: createDaemonStateSqliteSession(profileDir()),
    mutation,
    keysetIds,
    binding: { normalizedMint: authority.preparation.mintUrl, unit: 'msat' },
  })
  return createSpeculativeCounterTranscript(snapshots)
}

async function availableSourceProofs(
  authority: PreparedMintAuthority,
  group: 'offered' | 'collateral',
  limit: number,
): Promise<{ readonly proofs: Proof[]; readonly hasMore: boolean }> {
  const preparation = authority.preparationInput
  const keyset = group === 'offered' ? preparation.offerKeyset : preparation.receiveKeyset
  const page = await readCanonicalAvailableWalletProofPage(authority, {
    mintUrl: authority.preparation.mintUrl,
    keysetId: keyset.id,
    asset: assetForKeyset(keyset),
    limit,
  })
  return {
    proofs: page.proofs.map(({ proof }) => toProof(proof)),
    hasMore: page.nextCursor !== null,
  }
}

async function readCanonicalAvailableWalletProofPage(
  authority: PreparedMintAuthority,
  input: Parameters<typeof readAvailableCanonicalWalletProofPageFromDatabase>[1],
) {
  const mutation = authority.mutation()
  return withDurableCustodyFencedRead(
    authority.storage,
    mutation.fence,
    mutation.observedAtMs,
    (database) => readAvailableCanonicalWalletProofPageFromDatabase(database, input),
  )
}

async function planSourceConsolidation(
  authority: PreparedMintAuthority,
  maxRounds: number,
): Promise<BoundedProofConsolidationPlan> {
  const counts = new Map<number, number>()
  let after: Parameters<typeof readAvailableCanonicalWalletProofPageFromDatabase>[1]['after']
  do {
    const page = await readCanonicalAvailableWalletProofPage(authority, {
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
  dependencies: DaemonCtfRangeOrderCoordinatorDependencies,
): Promise<void> {
  if (inputs.length < 2) {
    throw new Error('mint range input cap cannot support proof consolidation')
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await getProofOperation(operationId)
    if (existing !== null) {
      await resumeConsolidationOperation(existing, authority, walletSeedHex, wallet, dependencies)
      return
    }
    const transcript = await sourceCounterTranscript(authority, [
      authority.preparationInput.offerKeyset.id,
    ])
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
      counterSource: transcript.counterSource,
      wallet,
    })
    let persisted: Awaited<ReturnType<typeof persistPreparedConsolidation>>
    try {
      persisted = await persistPreparedConsolidation(
        authority,
        round,
        operation,
        transcript,
        dependencies,
      )
    } catch (error) {
      const committed = await getProofOperation(operationId)
      if (committed !== null) {
        await resumeConsolidationOperation(
          committed,
          authority,
          walletSeedHex,
          wallet,
          dependencies,
        )
        return
      }
      if (!(error instanceof DaemonCounterSnapshotConflictError)) throw error
      if (attempt === 2) {
        throw new Error('daemon CTF source preparation contention; retry the exact request')
      }
      continue
    }
    if (persisted.wasAlreadyCommitted) {
      const committed = await getProofOperation(operationId)
      if (committed === null) throw new Error('range consolidation operation is missing')
      await resumeConsolidationOperation(committed, authority, walletSeedHex, wallet, dependencies)
      return
    }
    let result: readonly Proof[]
    try {
      result = await completeCtfRangeConsolidationOperation(persisted.validated, wallet)
    } catch (error) {
      const entry = await getProofOperation(operationId)
      if (entry === null) throw error
      // Returns only when every input is spent; recovery then restores the
      // exact outputs from a new reading.
      await settleRangeRequestRefusal(
        error,
        consolidationRefusalRequest(entry, authority, walletSeedHex, wallet, dependencies),
        (mintError) =>
          freshRequestPendingError('consolidation', entry.operationId, mintError, error),
      )
      throw error
    }
    await finalizeRangeConsolidation(authority, operationId, [...result])
    return
  }
}

async function persistPreparedConsolidation(
  authority: PreparedMintAuthority,
  round: number,
  operation: ReturnType<typeof validateCtfRangeConsolidationOperation>['operation'],
  transcript: SpeculativeCounterTranscript,
  dependencies: DaemonCtfRangeOrderCoordinatorDependencies,
): Promise<{
  readonly validated: ReturnType<typeof validateCtfRangeConsolidationOperation>
  readonly wasAlreadyCommitted: boolean
}> {
  const validated = validateCtfRangeConsolidationOperation(operation)
  const operationId = operation.operationId
  const reservationId = sourceConsolidationReservationId(operationId)
  const mutation = authority.mutation()
  const binding = rangePreparationBinding(authority, operation, reservationId, mutation)
  let existingOperation = false
  await prepareCtfConsolidationProofOperationWithExactReservation(
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
        custodySourceOperationId: binding.record.operation.operationId,
      },
      reservationId,
      inputAssets: operation.inputs.map(() => authority.offerAsset),
    },
    mutation,
    (database) => {
      if (existingOperation) return
      commitDaemonCounterTranscript(
        database,
        mutation.fence.scopeId,
        { normalizedMint: authority.preparation.mintUrl, unit: 'msat' },
        transcript,
        mutation.observedAtMs,
      )
      bindDaemonRangeSourceInTransaction(
        database,
        binding,
        operation.inputs.map(toProof),
        authority.offerAsset,
        mutation.fence,
        mutation.observedAtMs,
      )
      appendRangePreparationConsolidation(database, {
        scopeId: mutation.fence.scopeId,
        rangeOperationId: authority.preparation.operationId,
        round,
        operationId,
        reservationId,
      })
    },
    dependencies.injectRangeUnitOfWorkFault,
    (database) => {
      existingOperation = readDaemonProofOperationFromDatabase(database, operationId) !== null
      if (!existingOperation) requireNoUnresolvedSell(database, authority, mutation.fence.scopeId)
    },
  )
  return { validated, wasAlreadyCommitted: existingOperation }
}

async function finalizeRangeConsolidation(
  authority: PreparedMintAuthority,
  operationId: string,
  result: Proof[],
): Promise<void> {
  const entry = await getProofOperation(operationId)
  if (entry === null) throw new Error('range consolidation operation is missing')
  const mutation = authority.mutation()
  await withDurableCustodyUnitOfWork(
    profileDir(),
    mutation.fence,
    mutation.observedAtMs,
    (database) => {
      const custodyId = readSourceText(entry, 'custodySourceOperationId')
      const record = new DurableCustodySqliteStore(database).getOperation(custodyId)
      if (record === null) throw new Error('range consolidation custody operation is missing')
      if (record.operation.result.state === 'none') {
        stageDaemonRangeSourceResult(
          database,
          custodyId,
          { consolidated: result },
          mutation.fence,
          mutation.observedAtMs,
        )
      }
      commitDaemonRangeConsolidation(
        database,
        entry,
        authority.offerAsset,
        mutation.fence,
        mutation.observedAtMs,
      )
    },
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
  walletSeedHex: string,
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
    const restore = async () => {
      const restored = await (dependencies.restoreOutputs ?? restoreOutputGroups)(
        entry.mintUrl,
        entry.outputs,
      )
      return [...validateCtfRangeConsolidationProofs(operation, restored.consolidated)]
    }
    switch (replayKind(decision, states)) {
      case 'restore-exact-persisted-outputs':
        result = await restore()
        break
      case 'replay-exact-persisted-operation':
        try {
          result = [...(await completeCtfRangeConsolidationOperation(operation, wallet))]
        } catch (error) {
          await settleRangeRequestRefusal(
            error,
            consolidationRefusalRequest(entry, authority, walletSeedHex, wallet, dependencies),
            (mintError) => replayPendingError(entry, 'consolidation', mintError),
          )
          // Every input is spent: an earlier copy can have committed.
          result = await restore()
        }
        break
      case 'remain-pending':
        throw new Error(
          `Range consolidation ${entry.operationId} remains pending at the mint (${
            decision.kind === 'remain-pending' ? decision.reason : 'unknown-input-state'
          })`,
        )
      default:
        throw new Error(`Range consolidation ${entry.operationId} has invalid recovery state`)
    }
  }
  await finalizeRangeConsolidation(authority, entry.operationId, result)
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

function rangePreparationBinding(
  authority: PreparedMintAuthority,
  operation: DurableCustodyProofOperationInput,
  reservationId: string,
  mutation: FencedStateMutation,
) {
  return createDaemonRangeSourceBinding({
    scope: rangeSourceScope(mutation),
    operation,
    keysets: [custodyKeysetAuthority(authority.preparationInput.offerKeyset)],
    reservationId,
  })
}

function rangeSourceScope(mutation: FencedStateMutation): DurableCustodyScope {
  return {
    scopeKind: 'wallet',
    scopeId: mutation.fence.scopeId,
    walletId: mutation.fence.scopeId.slice('custody:wallet:'.length),
  }
}

function custodyKeysetAuthority(
  keyset: ActiveCtfRangeMintKeyset | CtfRangeConditionalMintKeyset,
): DurableCustodyMintKeysetAuthority {
  return {
    canonicalMintUrl: keyset.canonicalMintUrl,
    id: keyset.id,
    unit: keyset.unit,
    keys: keyset.keys,
    inputFeePpk: keyset.inputFeePpk,
    finalExpiry: keyset.finalExpiry,
    identity:
      'conditionId' in keyset
        ? {
            kind: 'conditional',
            conditionId: requireText(keyset.conditionId, 'source condition'),
            outcomeCollection: requireText(keyset.outcomeCollection, 'source outcome collection'),
            outcomeCollectionId: requireText(keyset.outcomeCollectionId, 'source collection'),
          }
        : { kind: 'regular' },
  }
}

async function persistPreparedSource(
  authority: PreparedMintAuthority,
  source: PreparedSource,
  dependencies: DaemonCtfRangeOrderCoordinatorDependencies,
): Promise<boolean> {
  switch (source.mode) {
    case 'same-keyset-swap':
      return persistPreparedSameKeysetSource(authority, source, dependencies)
    case 'mixed-source-ctf-convert':
      return persistPreparedMixedSource(authority, source, dependencies)
    default:
      return assertNeverSourceMode(source)
  }
}

async function persistPreparedSameKeysetSource(
  authority: PreparedMintAuthority,
  source: Extract<PreparedSource, { readonly mode: 'same-keyset-swap' }>,
  dependencies: DaemonCtfRangeOrderCoordinatorDependencies,
): Promise<boolean> {
  const operation = source.operation
  const reservationId = sourceReservationId(authority.preparation.operationId)
  const mutation = authority.mutation()
  const asset = authority.offerAsset
  const binding = rangePreparationBinding(authority, operation, reservationId, mutation)
  let existingOperation = false
  await prepareProofOperationWithExactReservation(
    {
      operationId: authority.preparation.sourceOperationId,
      kind:
        operation.kind === 'ctf-range-regular-source' ? 'wallet-send' : 'conditional-keyset-swap',
      mintUrl: authority.preparation.mintUrl,
      inputs: operation.inputs.map(toProof),
      outputs: storedSourceOutputs(operation),
      metadata: {
        ...operation.metadata,
        reservationId,
        exactSourceOperation: operation,
        sourceKeysets: [...authority.mintKeysets.values()],
        custodySourceOperationId: binding.record.operation.operationId,
      },
      reservationId,
      asset,
    },
    mutation,
    (database) => {
      if (existingOperation) return
      commitDaemonCounterTranscript(
        database,
        mutation.fence.scopeId,
        { normalizedMint: authority.preparation.mintUrl, unit: 'msat' },
        source.transcript,
        mutation.observedAtMs,
      )
      bindDaemonRangeSourceInTransaction(
        database,
        binding,
        operation.inputs.map(toProof),
        asset,
        mutation.fence,
        mutation.observedAtMs,
      )
      linkRangePreparationSource(database, {
        scopeId: mutation.fence.scopeId,
        rangeOperationId: authority.preparation.operationId,
        sourceOperationId: authority.preparation.sourceOperationId,
        reservationId,
      })
    },
    (database) => {
      existingOperation =
        readDaemonProofOperationFromDatabase(database, authority.preparation.sourceOperationId) !==
        null
      if (!existingOperation) requireNoUnresolvedSell(database, authority, mutation.fence.scopeId)
    },
    dependencies.injectRangeUnitOfWorkFault,
  )
  return existingOperation
}

/**
 * Reserve both asset groups and bind canonical custody in one transaction
 * before mint I/O. The legacy target keeps the typed group order of the exact
 * operation; the validated offered-input count marks where cash starts.
 */
async function persistPreparedMixedSource(
  authority: PreparedMintAuthority,
  source: Extract<PreparedSource, { readonly mode: 'mixed-source-ctf-convert' }>,
  dependencies: DaemonCtfRangeOrderCoordinatorDependencies,
): Promise<boolean> {
  const operation = source.operation
  const preparation = authority.preparationInput
  const reservationId = sourceReservationId(authority.preparation.operationId)
  const mutation = authority.mutation()
  const binding = createDaemonRangeMixedSourceBinding({
    scope: rangeSourceScope(mutation),
    operation,
    preparation,
    keysets: [preparation.offerKeyset, preparation.receiveKeyset].map(custodyKeysetAuthority),
    reservationId,
  })
  const offeredInputCount = binding.operation.metadata?.offeredInputCount
  if (!Number.isSafeInteger(offeredInputCount)) {
    throw new Error('mixed range source offered input count is invalid')
  }
  const collateralAsset = assetForKeyset(preparation.receiveKeyset)
  let existingOperation = false
  await prepareCtfConsolidationProofOperationWithExactReservation(
    {
      operationId: authority.preparation.sourceOperationId,
      kind: 'conditional-keyset-swap',
      mintUrl: authority.preparation.mintUrl,
      inputs: binding.operation.inputs.map(toProof),
      outputs: storedSourceOutputs(binding.operation),
      metadata: {
        purpose: SOURCE_PURPOSE,
        sourceMode: 'mixed-source-ctf-convert',
        endpoint: MIXED_SOURCE_ENDPOINT,
        rangeOperationId: authority.preparation.operationId,
        unit: 'msat',
        reservationId,
        custodySourceOperationId: binding.record.operation.operationId,
        exactSourceOperation: binding.operation,
      },
      reservationId,
      inputAssets: binding.operation.inputs.map((_, index) =>
        index < (offeredInputCount as number) ? authority.offerAsset : collateralAsset,
      ),
    },
    mutation,
    (database) => {
      if (existingOperation) return
      commitDaemonCounterTranscript(
        database,
        mutation.fence.scopeId,
        { normalizedMint: authority.preparation.mintUrl, unit: 'msat' },
        source.transcript,
        mutation.observedAtMs,
      )
      bindDaemonRangeMixedSourceInTransaction(
        database,
        binding,
        mutation.fence,
        mutation.observedAtMs,
      )
      linkRangePreparationSource(database, {
        scopeId: mutation.fence.scopeId,
        rangeOperationId: authority.preparation.operationId,
        sourceOperationId: authority.preparation.sourceOperationId,
        reservationId,
      })
    },
    dependencies.injectRangeUnitOfWorkFault,
    (database) => {
      existingOperation =
        readDaemonProofOperationFromDatabase(database, authority.preparation.sourceOperationId) !==
        null
      if (!existingOperation) requireNoUnresolvedSell(database, authority, mutation.fence.scopeId)
    },
  )
  return existingOperation
}

async function completePreparedSource(
  source: PreparedSource,
  authority: PreparedMintAuthority,
  walletSeedHex: string,
  wallet: SourceWallet,
): Promise<SourceResult> {
  switch (source.mode) {
    case 'same-keyset-swap': {
      const result = await completeCtfRangeSourceOperation(source.operation, await wallet())
      return sameKeysetSourceResult(result)
    }
    case 'mixed-source-ctf-convert':
      return completeMixedSource(source.operation, authority, walletSeedHex)
    default:
      return assertNeverSourceMode(source)
  }
}

async function completeMixedSource(
  operation: DurableCustodyProofOperationInput,
  authority: PreparedMintAuthority,
  walletSeedHex: string,
): Promise<SourceResult> {
  const result = await completeCtfRangeMixedSourceOperation({
    operation,
    preparation: authority.preparationInput,
    seed: walletSeed(walletSeedHex),
    transport: { postConvert: (request) => authority.mint.ctfConvert(request) },
  })
  return {
    mode: 'mixed-source-ctf-convert',
    authorization: [...result.authorization],
    offeredChange: [...result.offeredChange],
    collateralChange: [...result.collateralChange],
  }
}

async function resumeSourceOperation(
  entry: ProofOperationRecord,
  mode: SourceMode,
  authority: PreparedMintAuthority,
  walletSeedHex: string,
  wallet: SourceWallet,
  dependencies: DaemonCtfRangeOrderCoordinatorDependencies,
): Promise<SourceResult> {
  if (entry.state === 'completed') {
    // A committed mixed target keeps only change; its authorization lives in
    // canonical custody, which the caller already read.
    throw new Error(`Range source operation ${entry.operationId} canonical result is unavailable`)
  }
  if (entry.state === 'Failed') {
    throw new Error(
      `Range source operation ${entry.operationId} failed: ${entry.lastError ?? 'unknown error'}`,
    )
  }
  const inputs = entry.inputs.map(({ id, secret }) => ({
    id: requireText(id, 'source keyset'),
    secret,
  }))
  const states = await sourceInputStates(mode, authority, wallet, inputs)
  const decision = classifyPreparedSourceRecovery({
    journalKind: 'authorization-source',
    states,
    nowUnixSeconds: Math.floor(authority.mutation().observedAtMs / 1_000),
    authorizationExpiry: authority.preparation.expiry,
  })
  const restore = async () =>
    sourceResultFromGroups(
      mode,
      await (dependencies.restoreOutputs ?? restoreOutputGroups)(entry.mintUrl, entry.outputs),
    )
  let result: SourceResult
  switch (replayKind(decision, states)) {
    case 'restore-exact-persisted-outputs':
      result = await restore()
      break
    case 'replay-exact-persisted-operation':
      try {
        result = await completePersistedSource(entry, mode, authority, walletSeedHex, wallet)
      } catch (error) {
        await settleRangeRequestRefusal(
          error,
          sourceRefusalRequest(entry, authority, walletSeedHex, wallet, dependencies),
          (mintError) => replayPendingError(entry, 'source', mintError),
        )
        // Every input is spent: an earlier copy can have committed.
        result = await restore()
      }
      break
    case 'remain-pending':
      throw new Error(
        `Range source operation ${entry.operationId} remains pending at the mint (${
          decision.kind === 'remain-pending' ? decision.reason : 'unknown-input-state'
        })`,
      )
    default:
      throw new Error(`Range source operation ${entry.operationId} has invalid recovery state`)
  }
  await stageSourceResult(authority, result)
  return result
}

async function sourceInputStates(
  mode: SourceMode,
  authority: PreparedMintAuthority,
  wallet: SourceWallet,
  inputs: Array<Pick<Proof, 'id' | 'secret'>>,
): Promise<ProofState[]> {
  switch (mode) {
    case 'same-keyset-swap':
      return (await wallet()).checkProofsStates(inputs)
    case 'mixed-source-ctf-convert':
      // Both asset groups belong to one request. Check them in one exact NUT-07
      // observation through the mint client, without loading a swap wallet.
      return checkCtfRangeInputProofStates(authority.mint, inputs)
    default:
      return assertNeverSourceMode(mode)
  }
}

/**
 * A mixed spent-and-unspent reading replays once per pass so that the mint
 * answers with a code (ADR-037 mint refusal settlement).
 */
function replayKind(
  decision: CtfRangeSourceRecoveryDecision,
  states: readonly ProofState[],
): CtfRangeSourceRecoveryDecision['kind'] {
  if (decision.kind !== 'remain-pending') return decision.kind
  return decideCtfRangeRequestSettlement({
    refusal: null,
    inputStates: states.map(({ state }) => state),
  }).kind === 'replay'
    ? 'replay-exact-persisted-operation'
    : decision.kind
}

function replayPendingError(
  entry: ProofOperationRecord,
  request: 'source' | 'consolidation',
  mintError: CashuMintRefusal | null,
): Error {
  return mintError === null
    ? new Error(`range ${request} replay result is uncertain (${entry.operationId})`)
    : new RangeMintRefusalPendingError(
        `range ${request} replay rejection remains pending (${entry.operationId})`,
        mintError,
        request,
      )
}

/**
 * A fresh source or consolidation request that the mint refused with a code
 * stays reserved. Its error counts toward the halt and keeps only the bounded
 * mint detail. Any other failure keeps its own error.
 */
function freshRequestPendingError(
  request: 'source' | 'consolidation',
  operationId: string,
  mintError: CashuMintRefusal | null,
  error: unknown,
): Error {
  return mintError === null
    ? asError(error)
    : new RangeMintRefusalPendingError(
        `range ${request} rejection remains pending (${operationId})`,
        mintError,
        request,
      )
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * The recovery status of one failed pass, for the RPC reply and the daemon
 * log. A mint HTTP answer can quote long text, such as a blinded message or a
 * proof Y point. It gets a fixed message, and a coded refusal also keeps the
 * SDK's bounded detail (ADR-037 mint refusal settlement).
 */
function recoveryFailureStatus(error: unknown): {
  readonly error: string
  readonly mintError?: CashuMintRefusal
} {
  if (error instanceof RangeMintRefusalPendingError) {
    return { error: error.message, mintError: error.mintError }
  }
  if (!(error instanceof HttpResponseError)) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  const failure = classifyCashuMintFailure(error)
  return failure.kind === 'refusal'
    ? {
        error: `range recovery mint request was refused (mint code ${failure.code})`,
        mintError: { code: failure.code, detail: failure.detail },
      }
    : { error: `range recovery mint request failed (HTTP ${error.status})` }
}

/** A coded mint refusal kept a range request reserved. Recovery retries it. */
class RangeMintRefusalPendingError extends Error {
  readonly mintError: CashuMintRefusal
  /** The refused request. The halt counts refusals for each request. */
  readonly request: CtfRangeRefusedRequest

  constructor(message: string, mintError: CashuMintRefusal, request: CtfRangeRefusedRequest) {
    super(message)
    this.name = 'RangeMintRefusalPendingError'
    this.mintError = mintError
    this.request = request
  }
}

/** An earlier sell of the same market holds reserved funds. */
class UnresolvedRangeSellError extends Error {
  /** The recovery id of the earlier sell, or null when the bounded scan overflowed. */
  readonly blockingOperationId: string | null

  constructor(blockingOperationId: string | null) {
    super('an earlier sell of this market still holds reserved funds')
    this.name = 'UnresolvedRangeSellError'
    this.blockingOperationId = blockingOperationId
  }
}

/**
 * Refuse a sell that would lock more of a position while an earlier sell of
 * the same market still holds reserved funds, as the browser does. A
 * reservation runs this check in its own transaction, so the check and the
 * new reservation cannot interleave with another submit.
 */
function requireNoUnresolvedSell(
  database: DatabaseSync,
  authority: PreparedMintAuthority,
  scopeId: string,
): void {
  const preparation = authority.preparationInput
  if (preparation.side !== 'Sell') return
  const prepared = readPreparedRangeSells(database, scopeId, preparation.conditionId)
  const blocking = prepared.records.find(
    (record) =>
      record.rangeOperationId !== preparation.operationId &&
      rangePreparationHoldsReservedFunds(database, scopeId, record.rangeOperationId),
  )
  if (blocking === undefined && !prepared.overflow) return
  throw new UnresolvedRangeSellError(blocking?.sourceOperationId ?? null)
}

/** True while a range preparation's source or consolidation keeps funds reserved. */
function rangePreparationHoldsReservedFunds(
  database: DatabaseSync,
  scopeId: string,
  rangeOperationId: string,
): boolean {
  const links = readRangePreparationOperationLinks(database, scopeId, rangeOperationId)
  const store = new DurableCustodySqliteStore(database)
  const custodyState = (operationId: string) => {
    const custodyId = readDaemonProofOperationFromDatabase(database, operationId)?.metadata
      .custodySourceOperationId
    return typeof custodyId === 'string'
      ? store.getOperation(custodyId)?.operation.state
      : undefined
  }
  const source = links.source === null ? undefined : custodyState(links.source.sourceOperationId)
  // An applied source passes its funds to the order authorization.
  if (source !== undefined) return source !== 'aborted'
  for (const link of links.consolidations) {
    const state = custodyState(link.operationId)
    switch (state) {
      case 'dispatch-intent':
      case 'transport-attempted':
        return true
      case 'reconciled':
      case 'aborted':
      case undefined:
        break
      default:
        return assertNeverCustodyState(state)
    }
  }
  return false
}

function assertNeverCustodyState(value: never): never {
  throw new Error(`unhandled custody operation state: ${String(value)}`)
}

/** One persisted range request that the mint refused. */
interface RangeRequestRefusal {
  readonly authority: PreparedMintAuthority
  readonly walletSeedHex: string
  readonly entry: ProofOperationRecord
  readonly inputAssets: readonly StoredProofAsset[]
  readonly readInputStates: () => Promise<readonly ProofState[]>
  readonly dependencies: DaemonCtfRangeOrderCoordinatorDependencies
}

function sourceRefusalRequest(
  entry: ProofOperationRecord,
  authority: PreparedMintAuthority,
  walletSeedHex: string,
  wallet: SourceWallet,
  dependencies: DaemonCtfRangeOrderCoordinatorDependencies,
): RangeRequestRefusal {
  const mode = persistedSourceMode(entry)
  return {
    authority,
    walletSeedHex,
    entry,
    inputAssets: sourceInputAssets(entry, mode, authority),
    readInputStates: () =>
      sourceInputStates(
        mode,
        authority,
        wallet,
        entry.inputs.map(({ id, secret }) => ({ id: requireText(id, 'source keyset'), secret })),
      ),
    dependencies,
  }
}

function consolidationRefusalRequest(
  entry: ProofOperationRecord,
  authority: PreparedMintAuthority,
  walletSeedHex: string,
  wallet: CtfRangeWalletLike,
  dependencies: DaemonCtfRangeOrderCoordinatorDependencies,
): RangeRequestRefusal {
  return {
    authority,
    walletSeedHex,
    entry,
    inputAssets: entry.inputs.map(() => authority.offerAsset),
    readInputStates: () =>
      wallet.checkProofsStates(
        entry.inputs.map(({ id, secret }) => ({
          id: requireText(id, 'consolidation keyset'),
          secret,
        })),
      ),
    dependencies,
  }
}

/** The legacy mirror asset of each input, in the exact operation order. */
function sourceInputAssets(
  entry: ProofOperationRecord,
  mode: SourceMode,
  authority: PreparedMintAuthority,
): StoredProofAsset[] {
  switch (mode) {
    case 'same-keyset-swap':
      return entry.inputs.map(() => authority.offerAsset)
    case 'mixed-source-ctf-convert': {
      const offeredInputCount = validateCtfRangeMixedSourceOperation(
        entry.metadata.exactSourceOperation,
        authority.preparationInput,
      ).metadata?.offeredInputCount
      if (!Number.isSafeInteger(offeredInputCount)) {
        throw new Error('mixed range source offered input count is invalid')
      }
      const collateralAsset = assetForKeyset(authority.preparationInput.receiveKeyset)
      return entry.inputs.map((_, index) =>
        index < (offeredInputCount as number) ? authority.offerAsset : collateralAsset,
      )
    }
    default:
      return assertNeverSourceMode(mode)
  }
}

/**
 * Settle one refused range source or consolidation request (ADR-037 mint
 * refusal settlement). Check every input again with NUT-07 first. Return only
 * when every input is spent: the caller then restores the exact outputs. A
 * release throws CtfRangeOrderReleasedError. Any other outcome throws the
 * caller's uncertain error, and the request stays reserved.
 */
async function settleRangeRequestRefusal(
  error: unknown,
  request: RangeRequestRefusal,
  uncertain: (mintError: CashuMintRefusal | null) => Error,
): Promise<void> {
  const failure = classifyCashuMintFailure(error)
  const refusal = settlingMintRefusal(failure)
  if (refusal === null || failure.kind !== 'refusal') throw uncertain(null)
  const mintError = { code: failure.code, detail: failure.detail }
  let states: readonly ProofState[]
  try {
    states = await request.readInputStates()
  } catch {
    throw uncertain(mintError)
  }
  if (states.length !== request.entry.inputs.length) throw uncertain(mintError)
  const settlement = decideCtfRangeRequestSettlement({
    refusal,
    inputStates: states.map(({ state }) => state),
  })
  switch (settlement.kind) {
    case 'restore':
      return
    case 'wait':
    case 'replay':
      throw uncertain(mintError)
    case 'release':
      break
    default:
      return assertNeverSettlement(settlement)
  }
  if (refusal === 'outputs-signed') {
    // Another client with this seed signed outputs from these counters.
    // Advance the cursors before the attempt ends, so the next attempt uses
    // new outputs.
    try {
      await advanceCountersPastMint({
        storage: request.authority.storage,
        mutation: request.authority.mutation,
        mint: request.authority.mint,
        mintUrl: request.authority.preparation.mintUrl,
        walletSeedHex: request.walletSeedHex,
        keysetIds: rangeRequestOutputKeysetIds(request.entry, request.authority),
      })
    } catch {
      throw uncertain(mintError)
    }
  }
  await releaseRefusedRangeRequest(request, settlement.spentInputIndexes, mintError)
  throw new CtfRangeOrderReleasedError(mintError)
}

/**
 * Release one refused request and end its order attempt in one unit of work:
 * canonical custody, the legacy mirror, the failed target operation, and the
 * journal. The operation record and its exact output plan stay.
 */
async function releaseRefusedRangeRequest(
  request: RangeRequestRefusal,
  spentInputIndexes: readonly number[],
  mintError: CashuMintRefusal,
): Promise<void> {
  const { authority, entry } = request
  const spent = new Set(spentInputIndexes)
  const mutation = authority.mutation()
  const reason = rangeOrderReleasedMessage(mintError.code)
  const injectFault = request.dependencies.injectRefusalReleaseFault
  await withDurableCustodyUnitOfWork(
    authority.storage,
    mutation.fence,
    mutation.observedAtMs,
    (database) => {
      // A concurrent pass that got the same refusal can have released the
      // request already. Then this attempt only reports the release.
      const current = readDaemonProofOperationFromDatabase(database, entry.operationId)
      const ended = readRangePreparation(
        database,
        mutation.fence.scopeId,
        authority.preparation.operationId,
      )
      if (
        current?.state === 'Failed' &&
        current.lastError === reason &&
        ended?.lifecycleState === 'terminal'
      ) {
        return
      }
      releaseRefusedDaemonRangeSourceInTransaction(database, {
        custodyOperationId: readSourceText(entry, 'custodySourceOperationId'),
        spentInputs: entry.inputs
          .filter((_, index) => spent.has(index))
          .map(({ id, secret }) => ({ id: requireText(id, 'refused input keyset'), secret })),
        fence: mutation.fence,
        nowMs: mutation.observedAtMs,
      })
      releaseRefusedCtfRangeProofReservationFromDatabase(database, {
        operationId: entry.operationId,
        reservationId: readSourceText(entry, 'reservationId'),
        inputAssets: request.inputAssets,
        spentInputIndexes,
        reason,
        observedAtMs: mutation.observedAtMs,
      })
      const journal = readRangePreparation(
        database,
        mutation.fence.scopeId,
        authority.preparation.operationId,
      )
      if (journal?.lifecycleState !== 'prepared') {
        throw new Error('refused range preparation journal is not prepared')
      }
      transitionRangePreparation(database, {
        scopeId: mutation.fence.scopeId,
        rangeOperationId: journal.rangeOperationId,
        expectedRevision: journal.revision,
        from: 'prepared',
        to: 'terminal',
        updatedAtMs: mutation.observedAtMs,
      })
    },
    injectFault === undefined ? {} : { injectFault },
  )
}

/** The keysets of a request's outputs. Each must belong to the preparation. */
function rangeRequestOutputKeysetIds(
  entry: ProofOperationRecord,
  authority: PreparedMintAuthority,
): string[] {
  const known = new Set([
    authority.preparationInput.offerKeyset.id,
    authority.preparationInput.receiveKeyset.id,
  ])
  const ids = new Set(
    Object.values(entry.outputs).flatMap((outputs) =>
      outputs.map(({ blindedMessage }) => blindedMessage.id),
    ),
  )
  for (const id of ids) {
    if (!known.has(id)) throw new Error('range request output keyset is foreign')
  }
  return [...ids].sort()
}

/**
 * Advance each counter past the outputs that the mint already signed for this
 * seed, with a NUT-09 gap scan that admits no proof (ADR-037 mint refusal
 * settlement). The ADR-051 cursor rule then leaves the next 150 counters
 * unused. Another client with the same seed can hold funds in the skipped
 * outputs; `wallet recover-seed` restores them.
 */
async function advanceCountersPastMint(input: {
  readonly storage: DaemonStateSqliteSession
  readonly mutation: () => FencedStateMutation
  readonly mint: SeedCounterRestoreClient
  readonly mintUrl: string
  readonly walletSeedHex: string
  readonly keysetIds: readonly string[]
}): Promise<void> {
  const binding = { normalizedMint: input.mintUrl, unit: 'msat' as const }
  for (const keysetId of input.keysetIds) {
    const [snapshot] = await readDaemonCounterSnapshots({
      storage: input.storage,
      mutation: input.mutation(),
      keysetIds: [keysetId],
      binding,
    })
    const last = await findLastSignedSeedCounter({
      mint: input.mint,
      seed: walletSeed(input.walletSeedHex),
      keysetId,
      startCounter: snapshot?.nextCounter ?? 0,
    })
    if (last !== null) {
      await advanceDaemonKeysetCounter(
        keysetId,
        last + 1 + SEED_COUNTER_SKIP_AFTER_LAST_SIGNED,
        input.mutation(),
        binding,
      )
    }
  }
}

/** A refused refund swap counts toward the halt; any other failure keeps its error. */
function refundRefusalError(refund: ProofOperationRecord, error: unknown): Error {
  const failure = classifyCashuMintFailure(error)
  return failure.kind === 'refusal'
    ? new RangeMintRefusalPendingError(
        `range refund rejection remains pending (${refund.operationId})`,
        { code: failure.code, detail: failure.detail },
        'refund',
      )
    : asError(error)
}

/** The stored outputs of each replaced refund plan, oldest first. */
function replacedRefundOutputGroups(
  refund: ProofOperationRecord,
): Array<Record<string, StoredOutputData[]>> {
  return decodeReplacedCtfRangeRefundOutputPlans(refund.metadata).map((plan) => ({
    refund: serializeOutputDataArray(plan.outputs.map(OutputData.deserialize)),
  }))
}

function assertNeverSettlement(value: never): never {
  throw new Error(`unhandled range request settlement: ${String(value)}`)
}

async function completePersistedSource(
  entry: ProofOperationRecord,
  mode: SourceMode,
  authority: PreparedMintAuthority,
  walletSeedHex: string,
  wallet: SourceWallet,
): Promise<SourceResult> {
  switch (mode) {
    case 'same-keyset-swap': {
      const source = validateCtfRangeSourceCompletionOperation(
        entry.metadata.exactSourceOperation as DurableCustodyProofOperationInput,
      ).operation
      assertPersistedSourceIdentity(entry, source)
      return sameKeysetSourceResult(await completeCtfRangeSourceOperation(source, await wallet()))
    }
    case 'mixed-source-ctf-convert': {
      const source = validateCtfRangeMixedSourceOperation(
        entry.metadata.exactSourceOperation,
        authority.preparationInput,
      )
      assertPersistedSourceIdentity(entry, source)
      return completeMixedSource(source, authority, walletSeedHex)
    }
    default:
      return assertNeverSourceMode(mode)
  }
}

function assertPersistedSourceIdentity(
  entry: ProofOperationRecord,
  source: DurableCustodyProofOperationInput,
): void {
  if (source.operationId !== entry.operationId || source.mintUrl !== entry.mintUrl) {
    throw new Error('persisted range source operation is foreign')
  }
}

function completedSourceResult(entry: ProofOperationRecord): SourceResult {
  const groups = entry.resultProofs
  if (groups === undefined || Object.keys(groups).sort().join('\0') !== 'authorization\0keep') {
    throw new Error(`Range source operation ${entry.operationId} result is incomplete`)
  }
  return {
    mode: 'same-keyset-swap',
    authorization: (groups.authorization ?? []).map(toProof),
    keep: (groups.keep ?? []).map(toProof),
  }
}

function sameKeysetSourceResult(result: {
  readonly authorization: readonly Proof[]
  readonly keep: readonly Proof[]
}): SourceResult {
  return {
    mode: 'same-keyset-swap',
    authorization: [...result.authorization],
    keep: [...result.keep],
  }
}

function sourceResultFromGroups(
  mode: SourceMode,
  groups: Readonly<Record<string, Proof[]>>,
): SourceResult {
  switch (mode) {
    case 'same-keyset-swap':
      return sameKeysetSourceResult({
        authorization: groups.authorization ?? [],
        keep: groups.keep ?? [],
      })
    case 'mixed-source-ctf-convert':
      return {
        mode,
        authorization: groups.authorization ?? [],
        offeredChange: groups['offered-change'] ?? [],
        collateralChange: groups['collateral-change'] ?? [],
      }
    default:
      return assertNeverSourceMode(mode)
  }
}

function readStagedSourceResult(
  database: Parameters<typeof readDaemonRangeSourceResult>[0],
  entry: ProofOperationRecord,
  mode: SourceMode,
  scopeId: string,
): SourceResult | null {
  const custodyId = readSourceText(entry, 'custodySourceOperationId')
  switch (mode) {
    case 'same-keyset-swap': {
      const result = readDaemonRangeSourceResult(database, custodyId, scopeId)
      return result === null ? null : sameKeysetSourceResult(result)
    }
    case 'mixed-source-ctf-convert': {
      const result = readDaemonRangeMixedSourceResult(database, custodyId, scopeId)
      return result === null ? null : { mode, ...result }
    }
    default:
      return assertNeverSourceMode(mode)
  }
}

/** Map the closed SDK source mode of the exact operation to its daemon path. */
function persistedSourceMode(entry: ProofOperationRecord): SourceMode {
  const exact = entry.metadata.exactSourceOperation
  if (typeof exact !== 'object' || exact === null) {
    throw new Error(`Range source operation ${entry.operationId} exact operation is missing`)
  }
  const mode = ctfRangeSourceMode(exact as DurableCustodyProofOperationInput)
  if (entry.metadata.sourceMode !== mode) {
    throw new Error(`Range source operation ${entry.operationId} source mode is inconsistent`)
  }
  switch (mode) {
    case 'wallet-send':
    case 'conditional-keyset-swap':
      return 'same-keyset-swap'
    case 'mixed-source-ctf-convert':
      return mode
    case 'ctf-range-collateral-convert':
      throw new Error(`Range source operation ${entry.operationId} source mode is unsupported`)
    default:
      return assertNeverSourceMode(mode)
  }
}

function assertNeverSourceMode(value: never): never {
  throw new Error(`unhandled range source mode: ${String(value)}`)
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

function assertSavedRangeRefundDerivation(
  refund: ProofOperationRecord,
  custodyOperationId: string,
  source: DurableCtfRangeOperation,
  seed: Uint8Array,
  keyset: MintKeys,
): void {
  const outputs = deserializeOutputGroups(refund.outputs).refund ?? []
  const prepared = createDurableCtfRangeRefundOperation({
    operationId: refund.operationId,
    source,
    refundKeysetId: keyset.id,
    resolveKeysetAsset: (id) => (id === keyset.id ? source.offerAsset : undefined),
    outputs: outputs.map(OutputData.serialize),
  })
  assertDurableCtfRangeRefundRequestWitness({
    source,
    request: {
      inputs: refund.inputs.map(toProof),
      outputs: outputs.map((output) => output.blindedMessage),
    },
  })
  const expectedMetadata = {
    ...prepared.operation.metadata,
    purpose: CTF_RANGE_REFUND_PURPOSE,
    rangeOperationId: source.operationId,
    custodyOperationId,
    refundKeysetId: keyset.id,
  }
  if (Object.hasOwn(refund.metadata, 'refundOutputPlan')) {
    const plan = assertDurableSeedDerivedOutputPlanMatchesOutputs({
      plan: refund.metadata.refundOutputPlan,
      keysetId: keyset.id,
      outputs,
    })
    const amounts = outputs.map((output) => amountToNumber(output.blindedMessage.amount))
    reconstructDurableSeedDerivedOutputs({ seed, keyset, amounts, plan })
    // Each replaced plan must be seed derived on the refund keyset for the
    // same amount.
    const replaced = savedReplacedCtfRangeRefundOutputPlans(refund.metadata)
    assertReplacedCtfRangeRefundOutputPlans({
      metadata: refund.metadata,
      seed,
      keyset,
      total: amounts.reduce((sum, amount) => sum + amount, 0),
    })
    if (
      !isDeepStrictEqual(refund.metadata, {
        ...expectedMetadata,
        refundOutputPlan: refund.metadata.refundOutputPlan,
        ...(replaced.length === 0
          ? {}
          : { replacedRefundOutputPlans: refund.metadata.replacedRefundOutputPlans }),
      })
    )
      throw new Error('range refund output plan metadata differs')
  } else {
    if (!isDeepStrictEqual(refund.metadata, expectedMetadata))
      throw new Error('range refund legacy metadata differs')
    const legacy = createDeterministicDurableCtfRangeRefundOutputs({
      seed,
      source,
      refundOperationId: refund.operationId,
      amount:
        source.inputs.reduce((sum, proof) => sum + BigInt(proof.amount), 0n) -
        deriveDurableCtfRangeFeeBounds(source).maximumFee,
      keyset,
    })
    if (!isDeepStrictEqual(legacy, outputs.map(OutputData.serialize)))
      throw new Error('range refund legacy outputs differ from saved authority')
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
