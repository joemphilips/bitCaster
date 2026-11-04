import {
  createSpeculativeCounterTranscript,
  type SpeculativeCounterTranscript,
} from "@bitcaster/client-sdk/speculativeCounterTranscript";
import {
  assertDurableSeedDerivedOutputPlanMatchesOutputs,
  decodeDurableSeedDerivedOutputPlan,
  reconstructDurableSeedDerivedOutputs,
  matchDurableSeedDerivedProofsToPlan,
  type DurableSeedDerivedOutputPlan,
} from "@bitcaster/client-sdk/durableSeedDerivedOutputs";
import {
  BrowserWalletCounterDexieStore,
  BrowserWalletCounterSnapshotConflictError,
} from "../stores/browser-wallet-counter-db";
import { activeBrowserWalletScopeId } from "./browserWalletProfile";
import {
  HttpResponseError,
  Mint as CashuMint,
  OutputData,
  type CtfConvertRequest,
  type CtfConvertResponse,
  type Proof,
  type ProofState,
  type SerializedBlindedSignature,
  type SwapRequest,
  type SwapPreview,
} from "@cashu/cashu-ts";
import {
  prepareDurableCustodyExactArtifact,
  deriveDurableCustodyOperationId,
  deriveDurableCustodyProofId,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyRecord,
  type DurableCustodyScope,
} from "@bitcaster/client-sdk/durableCustody";
/*
 * The coordinator owns lifecycle sequencing. Protocol material and storage
 * mapping stay in browserCtfRangeOrderSource.
 */
import {
  deserializeDurableCustodyOutput,
  serializeDurableCustodyOutput,
  type DurableCustodyProofOperationInput,
} from "@bitcaster/client-sdk/durableCustodyProofOperation";
import { bindDurableCustodyProofOperation } from "@bitcaster/client-sdk/durableCustodyProofOperationRecord";
import {
  prepareDurableCustodyVerifiedMintResult,
  readDurableCustodyVerifiedMintResult,
  stageDurableCustodyPreparedMintResult,
  type DurableCustodyVerifiedMintResult,
} from "@bitcaster/client-sdk/durableCustodyMintResult";
import {
  classifyDurableCtfRangeRecovery,
  createDeterministicDurableCtfRangeRefundOutputsWithLocators,
  deriveDurableCtfRangeSettledFaceAmount,
  createDurableCtfRangeRefundOperation,
  prepareDurableSeedDerivedCtfRangeRefund,
  assertDurableCtfRangeRefundRequestWitness,
  deriveDurableCtfRangeFeeBounds,
  deriveDurableCtfRangeRefundOperationId,
  deriveDurableCtfRangeRefundRequestFingerprint,
  matchDeterministicDurableCtfRangeRefundProofLocators,
  prepareDurableCtfRangeRecoveredResult,
  prepareDurableCtfRangeVerifiedResult,
  recoverDurableCtfRangeVerifiedResultArtifact,
  type DurableCtfRangeOperation,
  type DurableCtfRangeAsset,
  type DurableCtfRangeKeysetResolver,
  type DurableCtfRangeRecoveredResult,
  type DurableCtfRangeVerifiedResultPreparation,
} from "@bitcaster/client-sdk/durableCtfRangeOperation";
import {
  acknowledgeCtfRangeEngineResult,
  assertCtfRangeEngineResultMatchesPersistedArtifact,
  CtfRangeRecoveryTransportError,
  CtfRangeMintRecoveryAdapter,
  decodeCtfRangeEngineResult,
  restoreDurableCtfRangeRefundOutputs,
  verifyDurableCtfRangeRefundSignatures,
} from "@bitcaster/client-sdk/ctfRangeRecoveryTransport";
import {
  completeValidatedCtfRangeSourceOperation,
  ctfRangeSourceMode,
  prepareCtfRangeSourceOperation,
  validateCtfRangeSourceCompletionOperation,
  type CtfRangeSourceWallet,
} from "@bitcaster/client-sdk/ctfRangeSourceOperation";
import {
  planCtfRangeCapabilitySource,
  type CtfRangeSourceShortfall,
} from "@bitcaster/client-sdk/ctfRangeCapabilitySourcePlan";
import {
  prepareCtfRangeMixedSourceOperation,
  completeCtfRangeMixedSourceOperation,
  validateCtfRangeMixedSourceOperation,
} from "@bitcaster/client-sdk/ctfRangeCollateralSourceOperation";
import {
  assertCtfRangeOrderFeeConsent,
  type CtfRangeOrderFeeFacts,
} from "@bitcaster/client-sdk/ctfRangeOrderFeeComposition";
import {
  completeCtfRangeConsolidationOperation,
  prepareCtfRangeConsolidationOperation,
  validateCtfRangeConsolidationOperation,
  validateCtfRangeConsolidationProofs,
  type CtfRangeConsolidationWallet,
} from "@bitcaster/client-sdk/ctfRangeConsolidationOperation";
import type { ProofConsolidationRound } from "@bitcaster/client-sdk/boundedProofConsolidation";
import {
  classifyCtfRangeSourceRecovery,
  type CtfRangeSourceRecoveryDecision,
} from "@bitcaster/client-sdk/ctfRangeSourceRecovery";
import {
  MINT_OUTPUT_REUSE_REFUSAL_CODES,
  classifyCashuMintFailure,
  decideCtfRangeRequestSettlement,
  settlingMintRefusal,
  type CashuMintRefusal,
} from "@bitcaster/client-sdk/mintRefusal";
import {
  restoreOutputGroups,
  serializeOutputDataArray,
  type StoredOutputData,
} from "@bitcaster/client-sdk/ctfSplit";
import {
  buildPersistedCtfRangeOrderPreparation,
  createCtfRangeSettlementCapabilityRequest,
  createCtfRangeOrderPreparationKeysetResolver,
  decodeSettlementCoordinatorPublicKey,
  decodeCtfRangeOrderPreparationFromRecord,
  planPersistedCtfRangeOrderAuthorization,
  settlementCapabilityWorkFacts,
  validateAndProjectCtfRangeSettlementCapabilityResponse,
  type CtfRangeOrderRequest,
  type CtfRangeReviewedMintFacts,
  type PersistedCtfRangeOrderPreparation,
} from "@bitcaster/client-sdk/ctfRangeOrderProtocol";
import { encodeCtfRangeOrderFeeConsentArtifact } from "@bitcaster/client-sdk/ctfRangeOrderJournal";
import {
  CURRENT_SETTLEMENT_CAPABILITY_TARIFF_RULE_ID,
  calculateSettlementCapabilityTariff,
} from "@bitcaster/client-sdk/participationScore";
import {
  EngineClientError,
  type CreateSettlementCapabilityRequest,
  type NostrKind1Event,
  type OrderStatusResponse,
  type SettlementCapabilityResultResponse,
  type SettlementCapabilityAdmissionPolicyResponse,
  type SettlementCapabilityResponse,
  type SubmitOrderRequest,
  type SubmitOrderResponse,
  type SubmitOrderOptions,
  type OrderQuotesRefreshingProgress,
} from "@bitcaster/client-sdk/engineClient";
import { decodeSubmitOrderResponse } from "@bitcaster/client-sdk/engineClient";
import type { WalletId } from "@bitcaster/client-sdk/durableCustody";
import {
  sameCtfRangeOrderPreparationIdentity,
  type CtfRangeOrderPreparationPageCursor,
} from "@bitcaster/client-sdk/ctfRangeOrderJournal";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import { requireBrowserWalletNewWritePermission } from "./browserWalletNewWritePermission";
import { withWalletProfileLock } from "./walletProfileLock";
import type { BrowserCtfRangeRecoverySchedule } from "./browserCtfRangeRecoverySchedule";
import { BrowserDurableCustodyAdapter } from "../stores/durable-custody-db";
import { decodeBrowserProofBackupAuthorityTableRow } from "../stores/browser-proof-backup-authority";
import {
  browserCustodyOperationId,
  browserSourceCustodyOperationId,
  browserSourceCompletionProofRows,
  browserCustodySelection,
  browserOwnerAt,
  browserPersistedSourceResult,
  browserMixedSourcePredecessorProofRows,
  type BrowserRangeSourceResult,
  browserRangeJournalIdentity,
  browserRangeCapabilityRequestFromSnapshot,
  browserRangeConsolidationOperationFromSnapshot,
  browserRangeConsolidationSuccessorProofRows,
  browserRangeOperationFromSnapshot,
  browserRangeRefundProofRows,
  browserRangeRefundStoredProofs,
  browserRangeSourceAsset,
  browserRangeStoredProofs,
  browserRangeSuccessorProofRows,
  browserSourceOperationFromSnapshot,
  browserSourceProofRows,
  browserSourceResultFromSnapshot,
  browserWalletScope,
  completeBrowserRangeOperation,
  createBrowserRangeConsolidationBinding,
  createBrowserRangeBinding,
  createBrowserRangeSourceBinding,
  requireBrowserCustodyOperation,
  requireBrowserStagedResult,
} from "./browserCtfRangeOrderSource";
import {
  bindCtfRangePreparationCapability,
  appendCtfRangePreparationConsolidationInTransaction,
  readPreparedCtfRangeSells,
  insertCtfRangePreparationInTransaction,
  pageActiveCtfRangePreparations,
  readActiveCtfRangePreparationByClientOrderId,
  readCtfRangePreparation,
  readCtfRangePreparationConsolidations,
  transitionCtfRangePreparation,
  transitionCtfRangePreparationInTransaction,
} from "../stores/ctf-range-order-db";
import {
  db,
  normalizeAndValidateStoredProof,
  storedProofFromRow,
  storedProofRow,
  type BitcasterDB,
  type ProofOperationRecord,
  type StoredProof,
  type StoredProofRow,
} from "../stores/proof-db";

const SCOPE_LEASE_MS = 10 * 60 * 1_000;
const RECOVERY_PAGE_LIMIT_DEFAULT = 64;

type WalletLockManager = Pick<LockManager, "request">;
type BrowserCtfRangeWallet = Omit<CtfRangeSourceWallet, "prepareSwapToSend"> & {
  prepareSwapToSend(
    amount: number,
    proofs: Proof[],
    config: { includeFees: false; keysetId: string },
    outputConfig:
      | Parameters<CtfRangeSourceWallet["prepareSwapToSend"]>[3]
      | Parameters<CtfRangeConsolidationWallet["prepareSwapToSend"]>[3],
  ): Promise<SwapPreview>;
  checkProofsStates(proofs: Array<Pick<Proof, "id" | "secret">>): Promise<ProofState[]>;
};
type BrowserCtfRangeMintRecovery = Pick<
  CtfRangeMintRecoveryAdapter,
  "loadUncertainRecoveryObservation"
>;

export interface BrowserCtfRangeEngine {
  createSettlementCapability(
    request: CreateSettlementCapabilityRequest,
  ): Promise<SettlementCapabilityResponse>;
  submitOrder(
    marketId: string,
    request: SubmitOrderRequest,
    options?: SubmitOrderOptions,
  ): Promise<SubmitOrderResponse>;
  getOrderStatus(marketId: string, orderId: string): Promise<OrderStatusResponse | null>;
  getSettlementCapabilityResultByOperation(
    operationId: string,
  ): Promise<SettlementCapabilityResultResponse | null>;
  acknowledgeSettlementCapabilityResult(
    resultId: string,
    request: { expectedVersion: number },
  ): Promise<SettlementCapabilityResultResponse | null>;
}

export interface BrowserCtfRangeOrderSubmitControl {
  readonly signal?: AbortSignal;
  readonly onQuotesRefreshing?: (progress: OrderQuotesRefreshingProgress) => void;
}

interface BrowserCtfRangeSourceInputs {
  readonly candidates: readonly Proof[];
  readonly collateralCandidates: readonly Proof[];
  readonly maxOutputs: number;
  readonly paidConsolidationFeeSubunits: string;
  readonly currentFeeFacts: CtfRangeOrderFeeFacts;
}

export interface BrowserCtfRangeOrderCoordinatorDependencies {
  readonly wallet:
    | BrowserCtfRangeWallet
    | ((mintUrl: string) => BrowserCtfRangeWallet | Promise<BrowserCtfRangeWallet>);
  readonly engine: BrowserCtfRangeEngine;
  readonly beforeCreateCapability?: (input: {
    mintUrl: string;
    requiredScore: number;
  }) => Promise<void>;
  readonly database?: BitcasterDB;
  readonly lockManager?: WalletLockManager;
  readonly now?: () => number;
  readonly randomId?: () => string;
  readonly allowInsecureLoopbackHttp?: boolean;
  readonly isDefinitiveOrderRejection?: (error: unknown) => boolean;
  readonly restoreOutputs?: typeof restoreOutputGroups;
  readonly restoreRefundOutputs?: typeof restoreDurableCtfRangeRefundOutputs;
  readonly createMintRecovery?: (
    operation: DurableCtfRangeOperation,
  ) => BrowserCtfRangeMintRecovery;
  readonly executeRefundSwap?: (
    mintUrl: string,
    request: SwapRequest,
  ) => Promise<{ signatures: SerializedBlindedSignature[] }>;
  readonly executeSourceConvert?: (
    mintUrl: string,
    request: CtfConvertRequest,
  ) => Promise<CtfConvertResponse>;
  /**
   * Recover the NUT-13 counters of each output keyset from the mint. The
   * coordinator calls it under the wallet profile lock after an output reuse
   * refusal, before it releases the refused request.
   */
  readonly recoverOutputCounters?: (input: {
    readonly mintUrl: string;
    readonly keysets: readonly PersistedCtfRangeOrderPreparation["offerKeyset"][];
  }) => Promise<void>;
  /** Spaces recovery mint requests per operation. Absent, every pass retries. */
  readonly recoverySchedule?: BrowserCtfRangeRecoverySchedule;
  readonly isCurrentRefundProfile?: (scopeId: string) => boolean;
  readonly observeRefundPrepared?: (
    draft: Readonly<{
      operationId: string;
      plan: import("@bitcaster/client-sdk/durableSeedDerivedOutputs").DurableSeedDerivedOutputPlan;
    }>,
  ) => Promise<void>;
  readonly injectRefundPreparationFault?: (
    phase: "counter-written" | "journal-bound" | "after-commit",
  ) => void;
  readonly observeSourcePrepared?: (
    draft: Readonly<{
      family: "source" | "consolidation";
      operation: DurableCustodyProofOperationInput;
      changes: ReturnType<SpeculativeCounterTranscript["changes"]>;
    }>,
  ) => Promise<void>;
  readonly injectSourcePreparationFault?: (
    phase: "counter-written" | "journal-bound" | "after-commit",
  ) => void;
}

/**
 * `awaiting-authorization-expiry` is retry work, not an error. The mint shows
 * every authorization input unspent and the refund path opens at expiry.
 * `awaiting-mint-retry` is an operation whose recovery backoff has not ended.
 */
export type BrowserCtfRangeRecoveryPendingCode =
  | BrowserCtfRangeOrderErrorCode
  | "awaiting-authorization-expiry"
  | "awaiting-mint-retry";

/** A bounded mint error code and detail. It never holds proofs or blinded messages. */
export type BrowserCtfRangeMintError = CashuMintRefusal;

export interface BrowserCtfRangeRecoveryPage {
  readonly recoveredOperationIds: readonly string[];
  readonly pending: readonly {
    operationId: string;
    revision: number;
    code: BrowserCtfRangeRecoveryPendingCode;
    mintError?: BrowserCtfRangeMintError;
  }[];
  /** Operations whose automatic replay stopped after repeated identical refusals. */
  readonly attention: readonly {
    operationId: string;
    revision: number;
    mintError: BrowserCtfRangeMintError;
  }[];
  /** Operations that a final mint refusal or a mixed input state released. */
  readonly refused: readonly {
    operationId: string;
    revision: number;
    mintError: BrowserCtfRangeMintError | null;
  }[];
  readonly nextCursor: CtfRangeOrderPreparationPageCursor | null;
}

type BrowserCtfRangeRecordRecoveryOutcome = "recovered" | "awaiting-authorization-expiry";

export const BROWSER_CTF_RANGE_ORDER_ERROR_CODES = [
  "invalid-order-type",
  "insufficient-funds",
  "score-top-up-required",
  "score-top-up-cancelled",
  "asset-recovery-failed",
  "source-preparation-failed",
  "mint-source-uncertain",
  "custody-commit-failed",
  "capability-creation-failed",
  "capability-validation-failed",
  "order-attempt-ended",
  "settlement-capability-invalid-request",
  "settlement-capability-invalid-artifact",
  "settlement-capability-policy-rejected",
  "settlement-capability-score-required",
  "settlement-capability-not-found",
  "settlement-capability-conflict",
  "settlement-capability-market-unavailable",
  "settlement-capability-request-too-large",
  "settlement-capability-admission-limited",
  "settlement-capability-capacity-exhausted",
  "settlement-capability-admission-unavailable",
  "order-invalid-request",
  "order-invalid-comment",
  "order-market-not-found",
  "order-capability-not-found",
  "order-capability-route-mismatch",
  "order-capability-not-current",
  "order-processing-conflict",
  "order-market-closed",
  "order-submission-rejected",
  "order-submission-uncertain",
  "recovery-pending",
  "source-preparation-pending",
] as const;

export type BrowserCtfRangeOrderErrorCode = (typeof BROWSER_CTF_RANGE_ORDER_ERROR_CODES)[number];

const SETTLEMENT_CAPABILITY_ERROR_CODES = new Set<string>([
  "settlement-capability-invalid-request",
  "settlement-capability-invalid-artifact",
  "settlement-capability-policy-rejected",
  "settlement-capability-score-required",
  "settlement-capability-not-found",
  "settlement-capability-conflict",
  "settlement-capability-market-unavailable",
  "settlement-capability-request-too-large",
  "settlement-capability-admission-limited",
  "settlement-capability-capacity-exhausted",
  "settlement-capability-admission-unavailable",
]);

const DEFINITIVE_ORDER_SUBMISSION_ERROR_CODES = new Set<string>([
  "order-invalid-request",
  "order-invalid-comment",
  "order-market-not-found",
  "order-capability-not-found",
  "order-capability-route-mismatch",
  "order-capability-not-current",
  "order-processing-conflict",
  "order-market-closed",
]);

function isSettlementCapabilityErrorCode(
  value: string,
): value is Extract<BrowserCtfRangeOrderErrorCode, `settlement-capability-${string}`> {
  return SETTLEMENT_CAPABILITY_ERROR_CODES.has(value);
}

function isDefinitiveOrderSubmissionErrorCode(
  value: string,
): value is Extract<BrowserCtfRangeOrderErrorCode, `order-${string}`> {
  return DEFINITIVE_ORDER_SUBMISSION_ERROR_CODES.has(value);
}

interface AppliedSourceCommitInput {
  readonly scope: DurableCustodyScope;
  readonly authorization: DurableCustodyOwnerAuthorization;
  readonly source: DurableCustodyRecord;
  readonly sourceOperation: DurableCustodyProofOperationInput;
  readonly binding: Awaited<ReturnType<typeof createBrowserRangeBinding>>;
  readonly successors: ReturnType<typeof browserSourceProofRows>;
  readonly resultAuthority: ReturnType<typeof requireBrowserStagedResult>;
  readonly preparation: PersistedCtfRangeOrderPreparation;
  readonly result: BrowserRangeSourceResult;
}

export class BrowserCtfRangeOrderError extends Error {
  readonly code: BrowserCtfRangeOrderErrorCode;
  /**
   * Why the shared source plan could not fund the order. A refusal label
   * reads this typed fact; it must not guess the asset from the side.
   */
  readonly shortfall: CtfRangeSourceShortfall | null;
  /** The mint refusal behind this error, if the mint answered with a code. */
  readonly mintError: BrowserCtfRangeMintError | null;
  /** The mint's Retry-After delay for a transient failure. */
  readonly retryAfterMs: number | null;
  /** True when the wallet released the inputs and ended the order attempt. */
  readonly released: boolean;
  /** A halted earlier operation that the user can retry from this refusal. */
  readonly retry: { readonly scopeId: string; readonly operationId: string } | null;

  constructor(
    code: BrowserCtfRangeOrderErrorCode,
    message: string,
    shortfall: CtfRangeSourceShortfall | null = null,
    details: {
      readonly mintError?: BrowserCtfRangeMintError | null;
      readonly retryAfterMs?: number | null;
      readonly released?: boolean;
      readonly retry?: { readonly scopeId: string; readonly operationId: string } | null;
    } = {},
  ) {
    super(message);
    this.name = "BrowserCtfRangeOrderError";
    this.code = code;
    this.shortfall = shortfall;
    this.mintError = details.mintError ?? null;
    this.retryAfterMs = details.retryAfterMs ?? null;
    this.released = details.released === true;
    this.retry = details.retry ?? null;
  }
}

/** Refund output plans that one refund can replace after output reuse refusals. */
const REPLACED_REFUND_OUTPUT_PLANS_MAX = 8;

const REFUSED_SOURCE_RELEASED_MESSAGE =
  "The mint refused this order. No order was submitted. The reserved funds are available again.";

/**
 * ADR-037 gives GUI immediate-order authorizations a short default lifetime.
 * The mint's 24-hour maximum is only a ceiling. Cancellation cannot revoke an
 * issued authorization, and a cancelled FOK stays locked until this expiry.
 */
const BROWSER_IMMEDIATE_ORDER_AUTHORIZATION_LIFETIME_SECONDS = 300;

export function buildBrowserCtfRangeOrderPreparation(input: {
  readonly request: CtfRangeOrderRequest;
  readonly policy: SettlementCapabilityAdmissionPolicyResponse;
  readonly mintFacts: CtfRangeReviewedMintFacts;
  readonly market: unknown;
  readonly nowUnixSeconds: number;
  readonly randomId: () => string;
}): PersistedCtfRangeOrderPreparation {
  requireFokRequest(input.request);
  return buildPersistedCtfRangeOrderPreparation({
    request: input.request,
    coordinatorPublicKey: decodeSettlementCoordinatorPublicKey(input.policy),
    mintFacts: input.mintFacts,
    market: input.market,
    nowUnixSeconds: input.nowUnixSeconds,
    randomId: input.randomId,
    authorizationLifetimeSeconds: BROWSER_IMMEDIATE_ORDER_AUTHORIZATION_LIFETIME_SECONDS,
  });
}

export class BrowserCtfRangeOrderCoordinator {
  readonly #walletForMint: (mintUrl: string) => Promise<BrowserCtfRangeWallet>;
  readonly #engine: BrowserCtfRangeEngine;
  readonly #beforeCreateCapability: NonNullable<
    BrowserCtfRangeOrderCoordinatorDependencies["beforeCreateCapability"]
  >;
  readonly #isCurrentRefundProfile: ((scopeId: string) => boolean) | undefined;
  readonly #observeRefundPrepared: BrowserCtfRangeOrderCoordinatorDependencies["observeRefundPrepared"];
  readonly #injectRefundPreparationFault: BrowserCtfRangeOrderCoordinatorDependencies["injectRefundPreparationFault"];
  readonly #database: BitcasterDB;
  readonly #custody: BrowserDurableCustodyAdapter;
  readonly #lockManager: WalletLockManager | undefined;
  readonly #now: () => number;
  readonly #randomId: () => string;
  readonly #allowInsecureLoopbackHttp: boolean;
  readonly #isDefinitiveOrderRejection: (error: unknown) => boolean;
  readonly #restoreOutputs: typeof restoreOutputGroups;
  readonly #restoreRefundOutputs: typeof restoreDurableCtfRangeRefundOutputs;
  readonly #createMintRecovery: (
    operation: DurableCtfRangeOperation,
  ) => BrowserCtfRangeMintRecovery;
  readonly #executeRefundSwap: (
    mintUrl: string,
    request: SwapRequest,
  ) => Promise<{ signatures: SerializedBlindedSignature[] }>;
  readonly #observeSourcePrepared: BrowserCtfRangeOrderCoordinatorDependencies["observeSourcePrepared"];
  readonly #injectSourcePreparationFault: BrowserCtfRangeOrderCoordinatorDependencies["injectSourcePreparationFault"];
  readonly #executeSourceConvert: NonNullable<
    BrowserCtfRangeOrderCoordinatorDependencies["executeSourceConvert"]
  >;
  readonly #recoverOutputCounters: BrowserCtfRangeOrderCoordinatorDependencies["recoverOutputCounters"];
  readonly #recoverySchedule: BrowserCtfRangeRecoverySchedule | undefined;

  constructor(input: BrowserCtfRangeOrderCoordinatorDependencies) {
    const wallet = input.wallet;
    this.#walletForMint =
      typeof wallet === "function" ? async (mintUrl) => wallet(mintUrl) : async () => wallet;
    this.#engine = input.engine;
    this.#executeSourceConvert =
      input.executeSourceConvert ??
      (async (mintUrl, request) => {
        const mint = new CashuMint(mintUrl);
        try {
          return await mint.ctfConvert(request);
        } catch (error) {
          throw withRetryAfter(error, mint.lastResponseMetadata?.retryAfterMs);
        }
      });
    this.#recoverOutputCounters = input.recoverOutputCounters;
    this.#recoverySchedule = input.recoverySchedule;
    this.#beforeCreateCapability = input.beforeCreateCapability ?? (async () => {});
    this.#database = input.database ?? db;
    this.#isCurrentRefundProfile =
      input.isCurrentRefundProfile ??
      (input.database === undefined
        ? (scopeId) => activeBrowserWalletScopeId() === scopeId
        : undefined);
    this.#observeRefundPrepared = input.observeRefundPrepared;
    this.#injectRefundPreparationFault = input.injectRefundPreparationFault;
    this.#custody = new BrowserDurableCustodyAdapter(this.#database);
    this.#lockManager = input.lockManager;
    this.#now = input.now ?? Date.now;
    this.#randomId = input.randomId ?? (() => crypto.randomUUID());
    this.#allowInsecureLoopbackHttp = input.allowInsecureLoopbackHttp === true;
    this.#isDefinitiveOrderRejection = input.isDefinitiveOrderRejection ?? (() => false);
    const restoreOutputs = input.restoreOutputs;
    this.#restoreOutputs = restoreOutputs ?? restoreOutputGroups;
    this.#restoreRefundOutputs = input.restoreRefundOutputs ?? restoreDurableCtfRangeRefundOutputs;
    this.#createMintRecovery =
      input.createMintRecovery ?? ((operation) => new CtfRangeMintRecoveryAdapter(operation));
    this.#executeRefundSwap =
      input.executeRefundSwap ??
      (async (mintUrl, request) => {
        const mint = new CashuMint(mintUrl);
        try {
          return await mint.swap(request);
        } catch (error) {
          throw withRetryAfter(error, mint.lastResponseMetadata?.retryAfterMs);
        }
      });
    this.#observeSourcePrepared = input.observeSourcePrepared;
    this.#injectSourcePreparationFault = input.injectSourcePreparationFault;
  }

  async prepareAndSubmit(
    input: BrowserCtfRangeOrderSubmitControl & {
      readonly seed: Uint8Array;
      readonly preparation: PersistedCtfRangeOrderPreparation;
      readonly candidates?: readonly Proof[];
      readonly collateralCandidates?: readonly Proof[];
      readonly maxOutputs?: number;
      readonly loadSourceInputs?: () => Promise<BrowserCtfRangeSourceInputs>;
      readonly comment?: NostrKind1Event | null;
      readonly consentedFeeFacts: CtfRangeOrderFeeFacts;
      readonly paidConsolidationFeeSubunits?: string;
      readonly currentFeeFacts?: CtfRangeOrderFeeFacts;
    },
  ): Promise<SubmitOrderResponse> {
    requireFokRequest(input.preparation.request);
    const scope = browserWalletScope(input.seed);
    let completed = await withWalletProfileLock(
      scope.scopeId,
      () =>
        this.#withScopeOwner(scope, async (owner) => {
          await requireBrowserWalletNewWritePermission({
            database: this.#database,
            scopeId: scope.scopeId,
          });
          const resumed = await this.#resumePreparedSourceForSubmit(
            input.preparation,
            input.seed,
            scope,
            owner,
          );
          return resumed;
        }),
      this.#lockManager,
    );
    if (completed === null) {
      // Source planning may recover or consolidate proofs. Those paths take
      // the same profile lock, so load them outside the lock and recheck the
      // durable source operation before admitting any result.
      const sourceInputs = input.loadSourceInputs
        ? await input.loadSourceInputs()
        : requireDirectSourceInputs(input);
      completed = await withWalletProfileLock(
        scope.scopeId,
        () =>
          this.#withScopeOwner(scope, async (owner) => {
            await requireBrowserWalletNewWritePermission({
              database: this.#database,
              scopeId: scope.scopeId,
            });
            const resumed = await this.#resumePreparedSourceForSubmit(
              input.preparation,
              input.seed,
              scope,
              owner,
            );
            if (resumed !== null) return resumed;
            await this.#requireNoUnresolvedSell(scope, input.preparation);
            const source = await this.#prepareAndPersistSource(
              { ...input, ...sourceInputs },
              scope,
              owner,
            );
            if (source.saved) {
              const resumed = await this.#resumePreparedSourceForSubmit(
                input.preparation,
                input.seed,
                scope,
                owner,
              );
              if (resumed === null) throw rangeError("recovery-pending");
              return resumed;
            }
            return this.#completeAndBindSource(
              input.preparation,
              input.seed,
              source.operation,
              source.custodyOperationId,
              scope,
              owner,
            );
          }),
        this.#lockManager,
      );
    }
    if (Math.floor(this.#now() / 1_000) >= input.preparation.expiry) {
      throw rangeError("order-attempt-ended");
    }
    await this.#beforeCreateCapability({
      mintUrl: input.preparation.mintUrl,
      requiredScore: calculateSettlementCapabilityTariff(
        CURRENT_SETTLEMENT_CAPABILITY_TARIFF_RULE_ID,
        settlementCapabilityWorkFacts(completed.operation),
      ),
    });
    return withWalletProfileLock(
      scope.scopeId,
      () =>
        this.#withScopeOwner(scope, async () => {
          await requireBrowserWalletNewWritePermission({
            database: this.#database,
            scopeId: scope.scopeId,
          });
          return this.#createCapabilityAndSubmit(
            scope,
            input.preparation,
            completed.operation,
            completed.capabilityRequest,
            input.comment ?? null,
            input,
          );
        }),
      this.#lockManager,
    );
  }

  async consolidateRound(input: {
    readonly seed: Uint8Array;
    readonly preparation: PersistedCtfRangeOrderPreparation;
    readonly round: number;
    readonly inputs: readonly Proof[];
    readonly plannedRound: ProofConsolidationRound;
    readonly consentedFeeFacts: CtfRangeOrderFeeFacts;
  }): Promise<void> {
    const scope = browserWalletScope(input.seed);
    await withWalletProfileLock(
      scope.scopeId,
      () =>
        this.#withScopeOwner(scope, async (owner) => {
          await requireBrowserWalletNewWritePermission({
            database: this.#database,
            scopeId: scope.scopeId,
          });
          await this.#requireNoUnresolvedSell(scope, input.preparation);
          const selected = await this.#prepareAndPersistConsolidation(input, scope, owner);
          const binding = selected.binding;
          if (selected.saved) {
            await this.#resumeConsolidation(
              input.preparation,
              input.seed,
              scope,
              owner,
              binding.record.operation.operationId,
            );
            return;
          }
          await this.#completeAndCommitConsolidation(
            scope,
            owner,
            input.preparation,
            binding,
            input.seed,
          );
        }),
      this.#lockManager,
    );
  }

  async recoverPage(input: {
    readonly seed: Uint8Array;
    readonly after?: CtfRangeOrderPreparationPageCursor;
    readonly limit?: number;
  }): Promise<BrowserCtfRangeRecoveryPage> {
    const scope = browserWalletScope(input.seed);
    return withWalletProfileLock(
      scope.scopeId,
      () =>
        this.#withScopeOwner(scope, async (owner) => {
          const page = await pageActiveCtfRangePreparations(
            {
              scopeId: scope.scopeId,
              limit: input.limit ?? RECOVERY_PAGE_LIMIT_DEFAULT,
              ...(input.after === undefined ? {} : { after: input.after }),
            },
            this.#database,
          );
          return {
            ...(await this.#recoverRecords(page.preparations, input.seed, scope, owner)),
            nextCursor: page.nextCursor,
          };
        }),
      this.#lockManager,
    );
  }

  async recoverClientOrder(input: {
    readonly seed: Uint8Array;
    readonly clientOrderId: string;
  }): Promise<Omit<BrowserCtfRangeRecoveryPage, "nextCursor">> {
    const scope = browserWalletScope(input.seed);
    return withWalletProfileLock(
      scope.scopeId,
      () =>
        this.#withScopeOwner(scope, async (owner) => {
          const record = await readActiveCtfRangePreparationByClientOrderId(
            scope.scopeId,
            input.clientOrderId,
            this.#database,
          );
          if (record === null) {
            return { recoveredOperationIds: [], pending: [], attention: [], refused: [] };
          }
          return this.#recoverRecords([record], input.seed, scope, owner);
        }),
      this.#lockManager,
    );
  }

  async #recoverRecords(
    records: readonly Awaited<
      ReturnType<typeof pageActiveCtfRangePreparations>
    >["preparations"][number][],
    seed: Uint8Array,
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
  ): Promise<Omit<BrowserCtfRangeRecoveryPage, "nextCursor">> {
    const recoveredOperationIds: string[] = [];
    const pending: Array<BrowserCtfRangeRecoveryPage["pending"][number]> = [];
    const attention: Array<BrowserCtfRangeRecoveryPage["attention"][number]> = [];
    const refused: Array<BrowserCtfRangeRecoveryPage["refused"][number]> = [];
    const schedule = this.#recoverySchedule;
    for (const record of records) {
      const operationId = record.rangeOperationId;
      if (schedule !== undefined) {
        // Check the schedule before any mint request of this operation.
        const state = schedule.state(scope.scopeId, operationId, this.#now());
        switch (state.kind) {
          case "due":
            break;
          case "waiting":
            pending.push({ operationId, revision: record.revision, code: "awaiting-mint-retry" });
            continue;
          case "halted":
            // Only a manual retry resumes it. Report it on every pass, so its
            // alert returns even after the user dismissed it.
            attention.push({ operationId, revision: record.revision, mintError: state.mintError });
            continue;
          default:
            return assertNever(state);
        }
      }
      try {
        const outcome = await this.#recoverRecord(record, seed, scope, owner);
        switch (outcome) {
          case "recovered":
            schedule?.recordProgress(scope.scopeId, operationId);
            recoveredOperationIds.push(operationId);
            break;
          case "awaiting-authorization-expiry": {
            const current = await this.#currentPreparation(record);
            schedule?.recordFailure(scope.scopeId, operationId, this.#now(), {
              mintError: null,
              retryAfterMs: null,
              notAfterMs: decodeCtfRangeOrderPreparationFromRecord(current).expiry * 1_000,
            });
            pending.push({ operationId, revision: current.revision, code: outcome });
            break;
          }
          default:
            return assertNever(outcome);
        }
      } catch (error) {
        if (!(error instanceof BrowserCtfRangeOrderError)) {
          schedule?.recordFailure(scope.scopeId, operationId, this.#now(), {
            mintError: null,
            retryAfterMs: null,
          });
          throw error;
        }
        const current = await this.#currentPreparation(record);
        if (error.released) {
          schedule?.recordProgress(scope.scopeId, operationId);
          recoveredOperationIds.push(operationId);
          refused.push({ operationId, revision: current.revision, mintError: error.mintError });
          continue;
        }
        if (
          current.revision !== record.revision ||
          current.lifecycleState !== record.lifecycleState
        ) {
          schedule?.recordProgress(scope.scopeId, operationId);
        }
        const halted =
          schedule?.recordFailure(scope.scopeId, operationId, this.#now(), {
            mintError: error.mintError,
            retryAfterMs: error.retryAfterMs,
          }).halted === true;
        if (halted && error.mintError !== null) {
          attention.push({ operationId, revision: current.revision, mintError: error.mintError });
          continue;
        }
        pending.push({
          operationId,
          revision: current.revision,
          code: error.code,
          ...(error.mintError === null ? {} : { mintError: error.mintError }),
        });
      }
    }
    return { recoveredOperationIds, pending, attention, refused };
  }

  async #currentPreparation(
    record: Awaited<ReturnType<typeof pageActiveCtfRangePreparations>>["preparations"][number],
  ) {
    const current = await readCtfRangePreparation(
      record.scopeId,
      record.rangeOperationId,
      this.#database,
    );
    if (current === null) throw new Error("browser range journal disappeared during recovery");
    return current;
  }

  async #recoverRecord(
    record: Awaited<ReturnType<typeof pageActiveCtfRangePreparations>>["preparations"][number],
    seed: Uint8Array,
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
  ): Promise<BrowserCtfRangeRecordRecoveryOutcome> {
    requireFokRequest(decodeCtfRangeOrderPreparationFromRecord(record).request);
    switch (record.lifecycleState) {
      case "prepared": {
        const sourceReleased = await this.#resumePreparedSource(record, seed, scope, owner);
        if (sourceReleased) return "recovered";
        break;
      }
      case "capability-requested":
        if (
          Math.floor(this.#now() / 1_000) >= decodeCtfRangeOrderPreparationFromRecord(record).expiry
        ) {
          break;
        }
        try {
          await this.#recoverRequestedCapability(record, scope);
        } catch (error) {
          const preparation = decodeCtfRangeOrderPreparationFromRecord(record);
          if (
            !(error instanceof BrowserCtfRangeOrderError) ||
            Math.floor(this.#now() / 1_000) < preparation.expiry
          ) {
            throw error;
          }
        }
        break;
      case "capability-bound":
        await this.#discoverBoundOrder(record);
        break;
      case "order-submitted":
      case "submission-rejected":
        break;
      case "terminal":
        return "recovered";
      default:
        return assertNever(record.lifecycleState);
    }
    const current = await readCtfRangePreparation(
      record.scopeId,
      record.rangeOperationId,
      this.#database,
    );
    if (current === null) throw new Error("browser range journal disappeared during recovery");
    return this.#recoverOuterRange(current, seed, scope, owner);
  }

  async #recoverOuterRange(
    journalRecord: NonNullable<Awaited<ReturnType<typeof readCtfRangePreparation>>>,
    seed: Uint8Array,
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
  ): Promise<BrowserCtfRangeRecordRecoveryOutcome> {
    const snapshot = await this.#custody.readOperationSnapshot(
      scope,
      browserCustodyOperationId(scope, journalRecord.rangeOperationId),
    );
    if (snapshot === null) throw rangeError("recovery-pending");
    const operation = browserRangeOperationFromSnapshot(snapshot.record, snapshot.artifacts);
    if (
      snapshot.record.operation.result.state === "verified-staged" ||
      snapshot.record.operation.result.state === "applied"
    ) {
      await this.#resumePersistedOuterResult(
        journalRecord,
        seed,
        scope,
        owner,
        snapshot.record,
        operation,
      );
      return "recovered";
    }
    const existingRefund = await this.#database.proofOperations.get(
      deriveDurableCtfRangeRefundOperationId(operation.operationId),
    );
    if (existingRefund !== undefined) {
      await this.#resumeOuterRefund(
        journalRecord,
        seed,
        scope,
        owner,
        snapshot.record,
        operation,
        existingRefund,
      );
      return "recovered";
    }
    const recovery = this.#createMintRecovery(operation);
    const capability = journalRecord.capability;
    let response: SettlementCapabilityResultResponse | null;
    try {
      response =
        capability === null
          ? null
          : await this.#engine.getSettlementCapabilityResultByOperation(operation.operationId);
    } catch {
      response = null;
    }
    let prepared: DurableCtfRangeVerifiedResultPreparation | null = null;
    let resolveKeyset: DurableCtfRangeKeysetResolver = createCtfRangeOrderPreparationKeysetResolver(
      decodeCtfRangeOrderPreparationFromRecord(journalRecord),
    );
    let engineResult: ReturnType<typeof decodeCtfRangeEngineResult> | null = null;
    if (response !== null) {
      try {
        engineResult = decodeCtfRangeEngineResult(response, {
          operation,
          reference: requireCapabilityReference(journalRecord),
        });
        prepared = prepareDurableCtfRangeVerifiedResult({
          record: snapshot.record,
          operation,
          envelope: engineResult.envelope,
          resolveKeyset,
        });
        if (prepared.kind !== "confirmed") engineResult = null;
      } catch {
        engineResult = null;
      }
    }
    if (engineResult === null) {
      const observed = await this.#pendingOnRecoveryTransport(() =>
        recovery.loadUncertainRecoveryObservation({
          record: snapshot.record,
          selection: null,
          now: Math.floor(this.#now() / 1_000),
        }),
      );
      prepared = prepareDurableCtfRangeRecoveredResult({
        record: snapshot.record,
        operation,
        observation: observed.observation,
        resolveKeyset: observed.resolveKeyset,
      });
      resolveKeyset = observed.resolveKeyset;
      const decision = classifyDurableCtfRangeRecovery({
        record: snapshot.record,
        operation,
        observation: observed.observation,
        resolveKeyset: observed.resolveKeyset,
      });
      switch (decision.kind) {
        case "confirmed":
          break;
        case "waiting":
          return "awaiting-authorization-expiry";
        case "reconciling":
          throw rangeError("recovery-pending");
        case "refundable":
          await this.#startOuterRefund(
            journalRecord,
            seed,
            scope,
            owner,
            snapshot.record,
            operation,
          );
          return "recovered";
        default:
          return assertNever(decision);
      }
    }
    if (prepared === null || prepared.kind !== "confirmed") throw rangeError("recovery-pending");
    await this.#commitRecoveredOuterResult(
      seed,
      scope,
      owner,
      snapshot.record,
      operation,
      prepared,
      resolveKeyset,
    );
    this.#requireExactFokSettlement(journalRecord, operation, prepared.result);
    if (engineResult !== null) {
      await this.#acknowledgeEngineResult(operation, journalRecord, engineResult);
    }
    await this.#terminalizeRecoveredJournal(journalRecord);
    return "recovered";
  }

  async #resumePersistedOuterResult(
    journalRecord: NonNullable<Awaited<ReturnType<typeof readCtfRangePreparation>>>,
    seed: Uint8Array,
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
    record: DurableCustodyRecord,
    operation: DurableCtfRangeOperation,
  ): Promise<void> {
    const exactResult = await this.#readExactResultArtifact(scope, record);
    const preparation = decodeCtfRangeOrderPreparationFromRecord(journalRecord);
    const resolveKeyset = createCtfRangeOrderPreparationKeysetResolver(preparation);
    const result = recoverDurableCtfRangeVerifiedResultArtifact({
      record,
      operation,
      exactResult,
      resolveKeyset,
    });
    if (record.operation.result.state === "verified-staged") {
      await this.#applyRecoveredOuterResult(seed, scope, owner, record, operation, result);
    }
    this.#requireExactFokSettlement(journalRecord, operation, result);
    if (isMintRecoveredRangeResult(exactResult.artifact)) {
      await this.#terminalizeRecoveredJournal(journalRecord);
      return;
    }
    let response: SettlementCapabilityResultResponse | null;
    try {
      response = await this.#engine.getSettlementCapabilityResultByOperation(operation.operationId);
    } catch (error) {
      throw rangeError("recovery-pending", error);
    }
    if (response === null) throw rangeError("recovery-pending");
    const engineResult = decodeCtfRangeEngineResult(response, {
      operation,
      reference: requireCapabilityReference(journalRecord),
    });
    await this.#assertPersistedEngineResult(scope, record, engineResult);
    await this.#acknowledgeEngineResult(operation, journalRecord, engineResult);
    await this.#terminalizeRecoveredJournal(journalRecord);
  }

  async #acknowledgeEngineResult(
    operation: DurableCtfRangeOperation,
    journalRecord: NonNullable<Awaited<ReturnType<typeof readCtfRangePreparation>>>,
    result: ReturnType<typeof decodeCtfRangeEngineResult>,
  ): Promise<void> {
    try {
      await acknowledgeCtfRangeEngineResult(
        this.#engine,
        {
          operation,
          reference: requireCapabilityReference(journalRecord),
          previouslyPersistedRequestDigest: result.requestDigest,
        },
        result,
      );
    } catch (error) {
      if (error instanceof CtfRangeRecoveryTransportError) {
        throw rangeError("recovery-pending", error);
      }
      throw error;
    }
  }

  async #assertPersistedEngineResult(
    scope: DurableCustodyScope,
    record: DurableCustodyRecord,
    result: ReturnType<typeof decodeCtfRangeEngineResult>,
  ): Promise<void> {
    const reference = record.operation.result.exactResult;
    if (reference === null) throw new Error("browser range result artifact is missing");
    assertCtfRangeEngineResultMatchesPersistedArtifact(result, {
      reference,
      exactResult: await this.#readExactResultArtifact(scope, record),
    });
  }

  async #pendingOnRecoveryTransport<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof CtfRangeRecoveryTransportError) {
        throw rangeError("recovery-pending", error);
      }
      throw error;
    }
  }

  async #prepareAndPersistConsolidation(
    input: {
      readonly seed: Uint8Array;
      readonly preparation: PersistedCtfRangeOrderPreparation;
      readonly round: number;
      readonly inputs: readonly Proof[];
      readonly plannedRound: ProofConsolidationRound;
      readonly consentedFeeFacts: CtfRangeOrderFeeFacts;
    },
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
  ): Promise<{
    binding: ReturnType<typeof createBrowserRangeConsolidationBinding>;
    saved: boolean;
  }> {
    const operationId = `${input.preparation.sourceOperationId}:consolidation:${input.round}`;
    const counters = this.#sourceCounters(scope);
    const context = {
      mintUrl: input.preparation.mintUrl,
      unit: input.preparation.offerKeyset.unit,
    };
    const readSaved = async () => {
      const snapshot = await this.#custody.readOperationSnapshot(
        scope,
        deriveDurableCustodyOperationId(scope.scopeId, {
          retainedOperationKey: operationId,
          binding: { kind: "wallet", activityId: operationId, stage: "proof-consolidation" },
        }),
      );
      if (snapshot === null) return null;
      await this.#requireSavedPreparation(scope, input.preparation, input.consentedFeeFacts);
      const operation = browserRangeConsolidationOperationFromSnapshot(
        snapshot.record,
        snapshot.artifacts,
      );
      validateCtfRangeConsolidationOperation(operation);
      const binding = createBrowserRangeConsolidationBinding(scope, input.preparation, operation);
      return { binding, saved: true };
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const saved = await readSaved();
      if (saved !== null) return saved;
      const transcript = createSpeculativeCounterTranscript([
        await counters.readSnapshotInContext(context, input.preparation.offerKeyset.id),
      ]);
      try {
        let operation: DurableCustodyProofOperationInput;
        try {
          operation = await prepareCtfRangeConsolidationOperation({
            operationId,
            rangeOperationId: input.preparation.operationId,
            mintUrl: input.preparation.mintUrl,
            keysetId: input.preparation.offerKeyset.id,
            outputKeyset: input.preparation.offerKeyset,
            inputs: input.inputs,
            conditional: input.preparation.side === "Sell",
            inputFeePpk: input.preparation.offerKeyset.inputFeePpk,
            plannedRound: input.plannedRound,
            seed: input.seed,
            counterSource: transcript.counterSource,
            wallet: await this.#walletForMint(input.preparation.mintUrl),
          });
        } catch (error) {
          throw rangeError("source-preparation-failed", error);
        }
        const binding = createBrowserRangeConsolidationBinding(scope, input.preparation, operation);
        await this.#observeSourcePrepared?.({
          family: "consolidation",
          operation: structuredClone(operation),
          changes: transcript.changes(),
        });
        const committed = await this.#persistPreparedConsolidation(
          scope,
          owner,
          input.preparation,
          input.round,
          binding,
          input.consentedFeeFacts,
          counters,
          transcript,
        );
        if (!committed) {
          const winner = await readSaved();
          if (winner === null) throw rangeError("recovery-pending");
          return winner;
        }
        this.#injectSourcePreparationFault?.("after-commit");
        return { binding, saved: false };
      } catch (error) {
        const saved = await readSaved();
        if (saved !== null) return saved;
        if (!(error instanceof BrowserWalletCounterSnapshotConflictError) || attempt === 2)
          throw error;
      }
    }
    throw rangeError("custody-commit-failed");
  }

  async #persistPreparedConsolidation(
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
    preparation: PersistedCtfRangeOrderPreparation,
    round: number,
    binding: ReturnType<typeof createBrowserRangeConsolidationBinding>,
    consentedFeeFacts: CtfRangeOrderFeeFacts,
    counters: BrowserWalletCounterDexieStore,
    transcript: SpeculativeCounterTranscript,
  ): Promise<boolean> {
    const operation = binding.authority.authority.operation;
    validateCtfRangeConsolidationOperation(operation);
    const reservationId = binding.record.operation.operationId;
    const stagedPredecessors = operation.inputs.map(
      (proof) =>
        browserSourceProofRows(
          scope,
          preparation,
          { authorization: [proof as Proof], keep: [] },
          this.#now(),
        )[0]!,
    );
    const predecessors = stagedPredecessors.map(({ proof }) => proof);
    try {
      return await this.#database.transaction(
        "rw",
        [
          ...this.#transactionTables(true),
          this.#database.walletCounterAssociations,
          this.#database.walletCounterCursors,
        ],
        async (tx) => {
          const saved = await this.#custody.readOperationSnapshot(scope, reservationId);
          await this.#custody.transactInCurrentTransaction(
            tx,
            browserCustodySelection(
              scope,
              browserOwnerAt(owner, this.#now()),
              reservationId,
              saved?.record.revision ?? null,
            ),
            () => undefined,
          );
          if (saved !== null) return false;
          for (const change of transcript.changes()) {
            await counters.compareAndAdvanceInCurrentTransaction(
              tx,
              { mintUrl: preparation.mintUrl, unit: preparation.offerKeyset.unit },
              change,
            );
            this.#injectSourcePreparationFault?.("counter-written");
          }
          await insertCtfRangePreparationInTransaction(
            tx,
            await this.#journalIdentity(scope, preparation, consentedFeeFacts),
            this.#database,
          );
          await appendCtfRangePreparationConsolidationInTransaction(
            tx,
            {
              scopeId: scope.scopeId,
              rangeOperationId: preparation.operationId,
              round,
              operationId: reservationId,
              reservationId,
            },
            this.#database,
          );
          await this.#custody.transactInCurrentTransaction(
            tx,
            browserCustodySelection(scope, browserOwnerAt(owner, this.#now()), reservationId, null),
            (transaction) =>
              bindDurableCustodyProofOperation(transaction, binding.record, binding.artifacts),
            {
              predecessorProofs: { [reservationId]: predecessors },
              conditionalKeysets: Object.fromEntries(
                stagedPredecessors.flatMap((staged) =>
                  staged.conditionalKeyset === undefined
                    ? []
                    : [[staged.proof.proofId, staged.conditionalKeyset]],
                ),
              ),
            },
          );
          await this.#reserveLegacyConsolidationProofs(
            scope,
            preparation,
            reservationId,
            operation.inputs,
            predecessors,
          );
          this.#injectSourcePreparationFault?.("journal-bound");
          return true;
        },
      );
    } catch (error) {
      if (error instanceof BrowserWalletCounterSnapshotConflictError) throw error;
      throw rangeError("custody-commit-failed", error);
    }
  }

  async #completeAndCommitConsolidation(
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
    preparation: PersistedCtfRangeOrderPreparation,
    binding: ReturnType<typeof createBrowserRangeConsolidationBinding>,
    seed: Uint8Array,
  ): Promise<void> {
    const operation = binding.authority.authority.operation;
    const attempted = await this.#markConsolidationAttempted(
      scope,
      owner,
      binding.record.operation.operationId,
    );
    let proofs: readonly Proof[];
    try {
      proofs = await this.#withWalletRetryAfter(preparation.mintUrl, (wallet) =>
        completeCtfRangeConsolidationOperation(operation, wallet),
      );
    } catch (error) {
      await this.#settleMintRefusal({
        refusal: error,
        uncertainCode: "mint-source-uncertain",
        preparation,
        scope,
        owner,
        custodyOperationId: binding.record.operation.operationId,
        operation,
      });
      proofs = await this.#restoreConsolidationProofs(
        preparation,
        operation,
        "mint-source-uncertain",
      );
    }
    const prepared = prepareDurableCustodyVerifiedMintResult({
      record: attempted,
      exactAuthority: binding.authority.exactAuthority,
      result: { consolidated: proofs },
    });
    const staged = await this.#stageConsolidationResult(scope, owner, attempted, prepared);
    await this.#commitConsolidationResult(
      scope,
      owner,
      preparation,
      staged,
      operation,
      prepared,
      seed,
    );
  }

  async #commitConsolidationResult(
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
    preparation: PersistedCtfRangeOrderPreparation,
    record: DurableCustodyRecord,
    operation: DurableCustodyProofOperationInput,
    prepared: DurableCustodyVerifiedMintResult,
    seed: Uint8Array,
  ): Promise<void> {
    const authorization = browserOwnerAt(
      owner,
      await this.#consolidationObservedAt(scope, record, this.#now()),
    );
    const successors = browserRangeConsolidationSuccessorProofRows({
      record,
      preparation,
      operation,
      prepared,
      seed,
      receivedAtMs: authorization.observedAtMs,
    });
    const legacySuccessors = prepared.proofs.map(({ proof }) =>
      legacySourceProof(preparation, proof, authorization.observedAtMs),
    );
    const resultAuthority = requireBrowserStagedResult(record);
    try {
      await this.#database.transaction("rw", this.#transactionTables(false), async (tx) => {
        await this.#custody.transactInCurrentTransaction(
          tx,
          browserCustodySelection(
            scope,
            authorization,
            record.operation.operationId,
            record.revision,
          ),
          (transaction) =>
            transaction.applyVerifiedResult({
              operationId: record.operation.operationId,
              expectedRevision: record.revision,
              authorization,
              outputPlanFingerprint: record.operation.outputPlan.outputPlanFingerprint,
              resultHandle: resultAuthority.resultHandle,
              resultFingerprint: resultAuthority.resultFingerprint,
              successorAdmission: {
                scopeId: scope.scopeId,
                operationId: record.operation.operationId,
                admissionId: `range-consolidation:${resultAuthority.resultFingerprint}`,
                proofRows: successors.map(({ proof, expectedRevision }) => ({
                  proofId: proof.proofId,
                  expectedRevision,
                  admittedRevision: proof.revision,
                })),
              },
            }),
          { successorProofs: { [record.operation.operationId]: successors } },
        );
        await this.#replaceLegacyReservedProofs(
          operation.inputs.map(({ secret }) => secret),
          legacySuccessors,
        );
      });
    } catch (error) {
      throw rangeError("custody-commit-failed", error);
    }
  }

  async #markConsolidationAttempted(
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
    operationId: string,
  ): Promise<DurableCustodyRecord> {
    const current = await requireBrowserCustodyOperation(this.#custody, scope, operationId);
    if (current.operation.state === "transport-attempted") return current;
    if (current.operation.state !== "dispatch-intent") throw rangeError("recovery-pending");
    const authorization = browserOwnerAt(owner, this.#now());
    await this.#custody.transact(
      browserCustodySelection(scope, authorization, operationId, current.revision),
      (transaction) =>
        transaction.transitionOperation({
          operationId,
          expectedRevision: current.revision,
          transition: {
            kind: "mark-transport-attempted",
            authorization,
            expectedRevision: current.revision,
          },
        }),
    );
    return requireBrowserCustodyOperation(this.#custody, scope, operationId);
  }

  async #stageConsolidationResult(
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
    record: DurableCustodyRecord,
    prepared: DurableCustodyVerifiedMintResult,
  ): Promise<DurableCustodyRecord> {
    const authorization = browserOwnerAt(owner, this.#now());
    await this.#custody.transact(
      browserCustodySelection(scope, authorization, record.operation.operationId, record.revision),
      (transaction) =>
        stageDurableCustodyPreparedMintResult({
          transaction,
          record,
          prepared,
          authorization,
        }),
    );
    return requireBrowserCustodyOperation(this.#custody, scope, record.operation.operationId);
  }

  async #consolidationObservedAt(
    scope: DurableCustodyScope,
    record: DurableCustodyRecord,
    observedAtMs: number,
  ): Promise<number> {
    const keys = record.operation.reservation.inputs.map(
      ({ proofId }) => [scope.scopeId, proofId] as [string, string],
    );
    const [rows, authorities] = await Promise.all([
      this.#database.custodyProofs.bulkGet(keys),
      this.#database.custodyProofBackupAuthorities.bulkGet(keys),
    ]);
    const decodedAuthorities = authorities.map((authority) =>
      authority === undefined ? undefined : decodeBrowserProofBackupAuthorityTableRow(authority),
    );
    return Math.max(
      observedAtMs,
      ...rows.map((row) => row?.receivedAtMs ?? 0),
      ...decodedAuthorities.map((authority) => {
        if (authority === undefined) return 0;
        if (!("updatedAtMs" in authority)) {
          throw new Error("browser CTF consolidation encountered a completed-removal marker");
        }
        return authority.updatedAtMs;
      }),
    );
  }

  async #journalIdentity(
    scope: DurableCustodyScope,
    preparation: PersistedCtfRangeOrderPreparation,
    consentedFeeFacts: CtfRangeOrderFeeFacts,
  ) {
    const existing = await readCtfRangePreparation(
      scope.scopeId,
      preparation.operationId,
      this.#database,
    );
    return {
      ...browserRangeJournalIdentity(scope, preparation, existing?.createdAtMs ?? this.#now()),
      feeConsentBytes: encodeCtfRangeOrderFeeConsentArtifact(consentedFeeFacts),
    };
  }

  async #prepareAndPersistSource(
    input: {
      readonly seed: Uint8Array;
      readonly preparation: PersistedCtfRangeOrderPreparation;
      readonly candidates: readonly Proof[];
      readonly collateralCandidates: readonly Proof[];
      readonly maxOutputs: number;
      readonly consentedFeeFacts: CtfRangeOrderFeeFacts;
      readonly paidConsolidationFeeSubunits: string;
      readonly currentFeeFacts: CtfRangeOrderFeeFacts;
    },
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
  ): Promise<{
    operation: DurableCustodyProofOperationInput;
    custodyOperationId: string;
    saved: boolean;
  }> {
    const counters = this.#sourceCounters(scope);
    const context = {
      mintUrl: input.preparation.mintUrl,
      unit: input.preparation.offerKeyset.unit,
    };
    const readSaved = async () => {
      const custodyOperationId = browserSourceCustodyOperationId(
        scope,
        input.preparation.sourceOperationId,
      );
      const snapshot = await this.#custody.readOperationSnapshot(scope, custodyOperationId);
      if (snapshot === null) return null;
      await this.#requireSavedPreparation(scope, input.preparation, input.consentedFeeFacts);
      const operation = browserSourceOperationFromSnapshot(snapshot.record, snapshot.artifacts);
      await createBrowserRangeSourceBinding(scope, input.preparation, input.seed, operation);
      return { operation, custodyOperationId, saved: true };
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const saved = await readSaved();
      if (saved !== null) return saved;
      let transcript: SpeculativeCounterTranscript;
      try {
        let operation: DurableCustodyProofOperationInput | null;
        try {
          const authorization = planPersistedCtfRangeOrderAuthorization(input.preparation);
          const plan = planCtfRangeCapabilitySource({
            side: input.preparation.side,
            authorizationAmounts: authorization.authorizationAmounts,
            offeredKeyset: input.preparation.offerKeyset,
            collateralKeyset:
              input.preparation.side === "Sell"
                ? input.preparation.receiveKeyset
                : input.preparation.offerKeyset,
            complementKeyset: input.preparation.complementKeyset,
            offeredCandidates: input.candidates,
            collateralCandidates: input.collateralCandidates,
            maxInputs: input.preparation.maxInputs,
            maxOutputs: input.maxOutputs,
          });
          const keysetIds = [
            ...new Set(
              plan.kind === "mixed-source-ctf-convert"
                ? [input.preparation.offerKeyset.id, input.preparation.receiveKeyset.id]
                : [input.preparation.offerKeyset.id],
            ),
          ];
          transcript = createSpeculativeCounterTranscript(
            await Promise.all(keysetIds.map((id) => counters.readSnapshotInContext(context, id))),
          );
          const counterSource = transcript.counterSource;
          switch (plan.kind) {
            case "mixed-source-ctf-convert":
              operation = await prepareCtfRangeMixedSourceOperation({
                preparation: input.preparation,
                seed: input.seed,
                counterSource,
                plan,
              });
              break;
            case "same-keyset-swap":
              operation = await prepareCtfRangeSourceOperation({
                preparation: input.preparation,
                seed: input.seed,
                counterSource,
                wallet: await this.#walletForMint(input.preparation.mintUrl),
                candidates: plan.inputs,
              });
              break;
            case "collateral-ctf-convert":
            case "consolidation-required":
            case "source-unavailable":
              throw rangeError("insufficient-funds");
            default:
              return assertNever(plan);
          }
        } catch (error) {
          throw rangeError("source-preparation-failed", error);
        }
        if (operation === null) throw rangeError("insufficient-funds");
        try {
          const currentFeeFacts = normalizeCurrentFeeFacts(
            input.preparation,
            input.currentFeeFacts,
            operation,
          );
          assertCtfRangeOrderFeeConsent({
            consented: input.currentFeeFacts,
            current: currentFeeFacts,
            paidConsolidationFeeSubunits: "0",
          });
          assertCtfRangeOrderFeeConsent({
            consented: input.consentedFeeFacts,
            current: currentFeeFacts,
            paidConsolidationFeeSubunits: input.paidConsolidationFeeSubunits,
          });
        } catch (error) {
          throw rangeError("source-preparation-failed", error);
        }
        const binding = await createBrowserRangeSourceBinding(
          scope,
          input.preparation,
          input.seed,
          operation,
        );
        const custodyOperationId = binding.record.operation.operationId;
        const mixedPredecessors =
          ctfRangeSourceMode(operation) === "mixed-source-ctf-convert"
            ? browserMixedSourcePredecessorProofRows(
                scope,
                input.preparation,
                operation,
                this.#now(),
              )
            : null;
        const stagedPredecessors =
          mixedPredecessors === null
            ? operation.inputs.map(
                (proof) =>
                  browserSourceProofRows(
                    scope,
                    input.preparation,
                    { authorization: [proof as Proof], keep: [] },
                    this.#now(),
                  )[0]!,
              )
            : [...mixedPredecessors.offeredInputs, ...mixedPredecessors.collateralInputs];
        const predecessors = stagedPredecessors.map(({ proof }) => proof);
        await this.#observeSourcePrepared?.({
          family: "source",
          operation: structuredClone(operation),
          changes: transcript.changes(),
        });
        const committed = await this.#persistPreparedSource(
          scope,
          owner,
          input.preparation,
          binding,
          custodyOperationId,
          predecessors,
          stagedPredecessors,
          operation.inputs,
          input.consentedFeeFacts,
          counters,
          transcript,
        );
        if (!committed) {
          const winner = await readSaved();
          if (winner === null) throw rangeError("recovery-pending");
          return winner;
        }
        this.#injectSourcePreparationFault?.("after-commit");
        return { operation, custodyOperationId, saved: false };
      } catch (error) {
        const saved = await readSaved();
        if (saved !== null) return saved;
        if (!(error instanceof BrowserWalletCounterSnapshotConflictError) || attempt === 2)
          throw error;
      }
    }
    throw rangeError("custody-commit-failed");
  }

  async #persistPreparedSource(
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
    preparation: PersistedCtfRangeOrderPreparation,
    binding: Awaited<ReturnType<typeof createBrowserRangeSourceBinding>>,
    custodyOperationId: string,
    predecessors: ReturnType<typeof browserSourceProofRows>[number]["proof"][],
    stagedPredecessors: readonly ReturnType<typeof browserSourceProofRows>[number][],
    sourceProofs: DurableCustodyProofOperationInput["inputs"],
    consentedFeeFacts: CtfRangeOrderFeeFacts,
    counters: BrowserWalletCounterDexieStore,
    transcript: SpeculativeCounterTranscript,
  ): Promise<boolean> {
    try {
      return await this.#database.transaction(
        "rw",
        [
          ...this.#transactionTables(true),
          this.#database.walletCounterAssociations,
          this.#database.walletCounterCursors,
        ],
        async (tx) => {
          const saved = await this.#custody.readOperationSnapshot(scope, custodyOperationId);
          await this.#custody.transactInCurrentTransaction(
            tx,
            browserCustodySelection(
              scope,
              browserOwnerAt(owner, this.#now()),
              custodyOperationId,
              saved?.record.revision ?? null,
            ),
            () => undefined,
          );
          if (saved !== null) return false;
          for (const change of transcript.changes()) {
            await counters.compareAndAdvanceInCurrentTransaction(
              tx,
              { mintUrl: preparation.mintUrl, unit: preparation.offerKeyset.unit },
              change,
            );
            this.#injectSourcePreparationFault?.("counter-written");
          }
          await insertCtfRangePreparationInTransaction(
            tx,
            await this.#journalIdentity(scope, preparation, consentedFeeFacts),
            this.#database,
          );
          await this.#custody.transactInCurrentTransaction(
            tx,
            browserCustodySelection(
              scope,
              browserOwnerAt(owner, this.#now()),
              custodyOperationId,
              null,
            ),
            (transaction) =>
              bindDurableCustodyProofOperation(transaction, binding.record, binding.artifacts),
            {
              predecessorProofs: { [custodyOperationId]: predecessors },
              conditionalKeysets: Object.fromEntries(
                stagedPredecessors.flatMap((staged) =>
                  staged.conditionalKeyset === undefined
                    ? []
                    : [[staged.proof.proofId, staged.conditionalKeyset]],
                ),
              ),
            },
          );
          await this.#reserveLegacySourceProofs(preparation, custodyOperationId, sourceProofs);
          this.#injectSourcePreparationFault?.("journal-bound");
          return true;
        },
      );
    } catch (error) {
      if (error instanceof BrowserWalletCounterSnapshotConflictError) throw error;
      throw rangeError("custody-commit-failed", error);
    }
  }

  async #completeAndBindSource(
    preparation: PersistedCtfRangeOrderPreparation,
    seed: Uint8Array,
    source: DurableCustodyProofOperationInput,
    sourceCustodyOperationId: string,
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
  ): Promise<{
    operation: DurableCtfRangeOperation;
    capabilityRequest: CreateSettlementCapabilityRequest;
  }> {
    const mixed = ctfRangeSourceMode(source) === "mixed-source-ctf-convert";
    const validatedSource = mixed
      ? null
      : validateCtfRangeSourceCompletionOperation(source, {
          seed,
          keyset: preparation.offerKeyset,
        });
    if (mixed) validateCtfRangeMixedSourceOperation(source, preparation);
    const attempted = await this.#markSourceAttempted(scope, owner, sourceCustodyOperationId);
    let result: BrowserRangeSourceResult;
    try {
      result =
        validatedSource === null
          ? await completeCtfRangeMixedSourceOperation({
              operation: source,
              preparation,
              seed,
              transport: {
                postConvert: (request) => this.#executeSourceConvert(preparation.mintUrl, request),
              },
            })
          : await this.#withWalletRetryAfter(preparation.mintUrl, (wallet) =>
              completeValidatedCtfRangeSourceOperation(validatedSource, wallet),
            );
    } catch (error) {
      // Returns only when every input is spent: an earlier copy can have committed.
      await this.#settleMintRefusal({
        refusal: error,
        uncertainCode: "mint-source-uncertain",
        preparation,
        scope,
        owner,
        custodyOperationId: sourceCustodyOperationId,
        operation: source,
      });
      result = await this.#restoreExactSource(preparation, seed, source);
    }
    const staged = await this.#stageSourceResult(
      scope,
      owner,
      preparation,
      source,
      attempted,
      result,
    );
    return this.#applySourceAndBindRange(scope, owner, preparation, seed, source, staged, result);
  }

  async #resumePreparedSource(
    journalRecord: Awaited<
      ReturnType<typeof pageActiveCtfRangePreparations>
    >["preparations"][number],
    seed: Uint8Array,
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
  ): Promise<boolean> {
    const preparation = decodeCtfRangeOrderPreparationFromRecord(journalRecord);
    const sourceCustodyOperationId = browserSourceCustodyOperationId(
      scope,
      preparation.sourceOperationId,
    );
    const snapshot = await this.#custody.readOperationSnapshot(scope, sourceCustodyOperationId);
    if (snapshot === null) {
      return this.#recoverConsolidationOnlyPreparation(
        journalRecord,
        preparation,
        seed,
        scope,
        owner,
      );
    }
    const source = browserSourceOperationFromSnapshot(snapshot.record, snapshot.artifacts);
    if (snapshot.record.operation.state === "aborted") {
      await this.#endReleasedPreparation(scope, preparation);
    }
    switch (snapshot.record.operation.result.state) {
      case "none":
        return this.#recoverUncertainSource({
          preparation,
          seed,
          source,
          sourceRecord: snapshot.record,
          sourceCustodyOperationId,
          scope,
          owner,
        });
      case "verified-staged": {
        const result = browserSourceResultFromSnapshot(snapshot.record, snapshot.artifacts);
        await this.#applySourceAndBindRange(
          scope,
          owner,
          preparation,
          seed,
          source,
          snapshot.record,
          result,
        );
        return false;
      }
      case "applied":
        await this.#requireAppliedOuter(scope, preparation.operationId);
        return false;
      default:
        throw rangeError("recovery-pending");
    }
  }

  /** Resume the exact persisted source before the caller loads current mint limits or proofs. */
  async #resumePreparedSourceForSubmit(
    preparation: PersistedCtfRangeOrderPreparation,
    seed: Uint8Array,
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
  ): Promise<{
    operation: DurableCtfRangeOperation;
    capabilityRequest: CreateSettlementCapabilityRequest;
  } | null> {
    const journal = await readCtfRangePreparation(
      scope.scopeId,
      preparation.operationId,
      this.#database,
    );
    if (journal?.lifecycleState === "terminal") throw rangeError("order-attempt-ended");
    const sourceCustodyOperationId = browserSourceCustodyOperationId(
      scope,
      preparation.sourceOperationId,
    );
    const snapshot = await this.#custody.readOperationSnapshot(scope, sourceCustodyOperationId);
    if (snapshot === null) {
      if (journal !== null && journal.lifecycleState !== "prepared") {
        throw rangeError("recovery-pending");
      }
      return null;
    }
    const source = browserSourceOperationFromSnapshot(snapshot.record, snapshot.artifacts);
    if (snapshot.record.operation.state === "aborted") {
      await this.#endReleasedPreparation(scope, preparation);
    }
    switch (snapshot.record.operation.result.state) {
      case "none": {
        const { decision, states } = await this.#classifyUncertainSource(preparation, source);
        switch (decision.kind) {
          case "replay-exact-persisted-operation":
            return this.#completeAndBindSource(
              preparation,
              seed,
              source,
              sourceCustodyOperationId,
              scope,
              owner,
            );
          case "restore-exact-persisted-outputs": {
            const result = await this.#restoreExactSource(preparation, seed, source);
            const staged = await this.#stageSourceResult(
              scope,
              owner,
              preparation,
              source,
              snapshot.record,
              result,
            );
            return this.#applySourceAndBindRange(
              scope,
              owner,
              preparation,
              seed,
              source,
              staged,
              result,
            );
          }
          case "remain-pending":
            // A mixed reading replays, so that the mint answers with a code.
            // Any coded answer settles the request.
            if (replaysMixedReading(states)) {
              return this.#completeAndBindSource(
                preparation,
                seed,
                source,
                sourceCustodyOperationId,
                scope,
                owner,
              );
            }
            throw rangeError("recovery-pending");
          case "reuse-completed":
          case "fail":
            throw new Error("range source recovery journal state is inconsistent");
          default:
            return assertNever(decision);
        }
      }
      case "verified-staged": {
        const result = browserSourceResultFromSnapshot(snapshot.record, snapshot.artifacts);
        return this.#applySourceAndBindRange(
          scope,
          owner,
          preparation,
          seed,
          source,
          snapshot.record,
          result,
        );
      }
      case "applied": {
        await this.#requireAppliedOuter(scope, preparation.operationId);
        const outer = await this.#custody.readOperationSnapshot(
          scope,
          browserCustodyOperationId(scope, preparation.operationId),
        );
        if (outer === null) throw rangeError("recovery-pending");
        const operation = browserRangeOperationFromSnapshot(outer.record, outer.artifacts);
        return {
          operation,
          capabilityRequest: createCtfRangeSettlementCapabilityRequest(preparation, operation),
        };
      }
      default:
        throw rangeError("recovery-pending");
    }
  }

  async #recoverConsolidationOnlyPreparation(
    journalRecord: Awaited<
      ReturnType<typeof pageActiveCtfRangePreparations>
    >["preparations"][number],
    preparation: PersistedCtfRangeOrderPreparation,
    seed: Uint8Array,
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
  ): Promise<boolean> {
    const links = await readCtfRangePreparationConsolidations(
      journalRecord.scopeId,
      journalRecord.rangeOperationId,
      this.#database,
    );
    if (links.length === 0) throw rangeError("recovery-pending");
    for (const link of links) {
      await this.#resumeConsolidation(preparation, seed, scope, owner, link.operationId);
    }
    const current = await this.#currentPreparation(journalRecord);
    if (current.lifecycleState !== "prepared") throw rangeError("recovery-pending");
    await transitionCtfRangePreparation(
      {
        scopeId: current.scopeId,
        rangeOperationId: current.rangeOperationId,
        expectedRevision: current.revision,
        from: "prepared",
        to: "terminal",
        updatedAtMs: Math.max(this.#now(), current.updatedAtMs),
      },
      this.#database,
    );
    return true;
  }

  async #resumeConsolidation(
    preparation: PersistedCtfRangeOrderPreparation,
    seed: Uint8Array,
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
    operationId: string,
  ): Promise<void> {
    const snapshot = await this.#custody.readOperationSnapshot(scope, operationId);
    if (snapshot === null) throw rangeError("recovery-pending");
    const operation = browserRangeConsolidationOperationFromSnapshot(
      snapshot.record,
      snapshot.artifacts,
    );
    if (snapshot.record.operation.result.state === "applied") return;
    if (snapshot.record.operation.state === "aborted") {
      await this.#endReleasedPreparation(scope, preparation);
    }
    const privateArtifact = snapshot.artifacts.find(
      ({ reference }) =>
        reference.artifactId ===
        snapshot.record.operation.privateMaterial.exactPrivateMaterial.artifactId,
    );
    if (privateArtifact === undefined) throw rangeError("recovery-pending");
    const authority = prepareDurableCustodyExactArtifact(privateArtifact.artifact.artifact);
    if (snapshot.record.operation.result.state === "verified-staged") {
      const prepared = readDurableCustodyVerifiedMintResult({
        record: snapshot.record,
        exactAuthority: authority,
        exactResult: await this.#readExactResultArtifact(scope, snapshot.record),
      });
      await this.#commitConsolidationResult(
        scope,
        owner,
        preparation,
        snapshot.record,
        operation,
        prepared,
        seed,
      );
      return;
    }
    if (snapshot.record.operation.result.state !== "none") throw rangeError("recovery-pending");
    const { decision, states } = await this.#classifyUncertainConsolidation(preparation, operation);
    let proofs: readonly Proof[];
    // A mixed reading replays, so that the mint answers with a code. Any
    // coded answer settles the request.
    const kind =
      decision.kind === "remain-pending" && replaysMixedReading(states)
        ? "replay-exact-persisted-operation"
        : decision.kind;
    switch (kind) {
      case "replay-exact-persisted-operation":
        await this.#markConsolidationAttemptedForRecovery(scope, owner, operationId);
        try {
          proofs = await this.#withWalletRetryAfter(preparation.mintUrl, (wallet) =>
            completeCtfRangeConsolidationOperation(operation, wallet),
          );
        } catch (error) {
          await this.#settleMintRefusal({
            refusal: error,
            uncertainCode: "recovery-pending",
            preparation,
            scope,
            owner,
            custodyOperationId: operationId,
            operation,
          });
          proofs = await this.#restoreConsolidationProofs(
            preparation,
            operation,
            "recovery-pending",
          );
        }
        break;
      case "restore-exact-persisted-outputs":
        proofs = await this.#restoreConsolidationProofs(preparation, operation, "recovery-pending");
        break;
      case "remain-pending":
        throw rangeError("recovery-pending");
      default:
        throw new Error("Range consolidation recovery state is invalid");
    }
    const current = await requireBrowserCustodyOperation(this.#custody, scope, operationId);
    const prepared = prepareDurableCustodyVerifiedMintResult({
      record: current,
      exactAuthority: authority,
      result: { consolidated: proofs },
    });
    const staged = await this.#stageConsolidationResult(scope, owner, current, prepared);
    await this.#commitConsolidationResult(
      scope,
      owner,
      preparation,
      staged,
      operation,
      prepared,
      seed,
    );
  }

  async #classifyUncertainConsolidation(
    preparation: PersistedCtfRangeOrderPreparation,
    operation: DurableCustodyProofOperationInput,
  ): Promise<{ decision: CtfRangeSourceRecoveryDecision; states: readonly unknown[] }> {
    let states: readonly unknown[];
    try {
      states = await this.#observeInputStates(preparation, operation);
    } catch {
      throw rangeError("recovery-pending");
    }
    return {
      decision: classifyCtfRangeSourceRecovery({
        journalKind: "consolidation",
        journalState: "prepared",
        inputStates: states,
        now: Math.floor(this.#now() / 1_000),
      }),
      states,
    };
  }

  async #markConsolidationAttemptedForRecovery(
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
    operationId: string,
  ): Promise<void> {
    try {
      await this.#markConsolidationAttempted(scope, owner, operationId);
    } catch (error) {
      throw rangeError("recovery-pending", error);
    }
  }

  /** NUT-09 restore of the exact persisted consolidation outputs. */
  async #restoreConsolidationProofs(
    preparation: PersistedCtfRangeOrderPreparation,
    operation: DurableCustodyProofOperationInput,
    uncertainCode: "mint-source-uncertain" | "recovery-pending",
  ): Promise<readonly Proof[]> {
    try {
      const restored = await this.#restoreOutputs(
        preparation.mintUrl,
        Object.fromEntries(
          Object.entries(operation.outputs).map(([label, outputs]) => [
            label,
            serializeOutputDataArray(outputs.map(deserializeDurableCustodyOutput)),
          ]),
        ),
      );
      if (Object.keys(restored).some((label) => label !== "consolidated")) {
        throw new Error("Range consolidation restore returned a foreign proof group");
      }
      return validateCtfRangeConsolidationProofs(operation, restored.consolidated);
    } catch (error) {
      throw rangeError(uncertainCode, error);
    }
  }

  async #recoverUncertainSource(input: {
    preparation: PersistedCtfRangeOrderPreparation;
    seed: Uint8Array;
    source: DurableCustodyProofOperationInput;
    sourceRecord: DurableCustodyRecord;
    sourceCustodyOperationId: string;
    scope: DurableCustodyScope;
    owner: DurableCustodyOwnerAuthorization;
  }): Promise<boolean> {
    const { decision, states } = await this.#classifyUncertainSource(
      input.preparation,
      input.source,
    );
    switch (decision.kind) {
      case "replay-exact-persisted-operation":
        await this.#completeAndBindSource(
          input.preparation,
          input.seed,
          input.source,
          input.sourceCustodyOperationId,
          input.scope,
          input.owner,
        );
        return false;
      case "restore-exact-persisted-outputs": {
        const result = await this.#restoreExactSource(input.preparation, input.seed, input.source);
        const staged = await this.#stageSourceResult(
          input.scope,
          input.owner,
          input.preparation,
          input.source,
          input.sourceRecord,
          result,
        );
        await this.#applySourceAndBindRange(
          input.scope,
          input.owner,
          input.preparation,
          input.seed,
          input.source,
          staged,
          result,
        );
        return false;
      }
      case "remain-pending":
        // A mixed reading replays, so that the mint answers with a code.
        // Any coded answer settles the request.
        if (replaysMixedReading(states)) {
          await this.#completeAndBindSource(
            input.preparation,
            input.seed,
            input.source,
            input.sourceCustodyOperationId,
            input.scope,
            input.owner,
          );
          return false;
        }
        throw rangeError("recovery-pending");
      case "reuse-completed":
      case "fail":
        throw new Error("range source recovery journal state is inconsistent");
      default:
        return assertNever(decision);
    }
  }

  async #classifyUncertainSource(
    preparation: PersistedCtfRangeOrderPreparation,
    source: DurableCustodyProofOperationInput,
  ): Promise<{ decision: CtfRangeSourceRecoveryDecision; states: readonly unknown[] }> {
    let states: readonly unknown[];
    try {
      states = await this.#observeInputStates(preparation, source);
    } catch {
      throw rangeError("recovery-pending");
    }
    return {
      decision: classifyCtfRangeSourceRecovery({
        journalKind: "authorization-source",
        journalState: "prepared",
        inputStates: states,
        now: Math.floor(this.#now() / 1_000),
        authorizationExpiry: preparation.expiry,
      }),
      states,
    };
  }

  /** NUT-07 states in the exact input order of the persisted operation. */
  async #observeInputStates(
    preparation: PersistedCtfRangeOrderPreparation,
    operation: DurableCustodyProofOperationInput,
  ): Promise<readonly unknown[]> {
    const states: ProofState[] = await (
      await this.#walletForMint(preparation.mintUrl)
    ).checkProofsStates(
      operation.inputs.map(({ id, secret }) => ({ id: requireSourceKeysetId(id), secret })),
    );
    if (states.length !== operation.inputs.length) {
      throw new Error("range source proof-state response is incomplete");
    }
    return states.map(({ state }) => state);
  }

  /**
   * Settle a coded mint refusal under the wallet profile lock, as an ordinary
   * Cashu wallet does. A failure without a code stays uncertain. The inputs
   * are checked again first. A pending or unknown input waits. All spent
   * inputs return to the caller for the exact NUT-09 restore. "Outputs already
   * signed" (11003, 11008) and "condition attested" (13042) release the
   * request. Any other code releases it only after a mixed reading, which
   * proves that the request can never commit. A release throws a released
   * error.
   */
  async #settleMintRefusal(input: {
    readonly refusal: unknown;
    readonly uncertainCode: "mint-source-uncertain" | "recovery-pending";
    readonly preparation: PersistedCtfRangeOrderPreparation;
    readonly scope: DurableCustodyScope;
    readonly owner: DurableCustodyOwnerAuthorization;
    readonly custodyOperationId: string;
    readonly operation: DurableCustodyProofOperationInput;
  }): Promise<void> {
    const refusal = settlingMintRefusal(classifyCashuMintFailure(input.refusal));
    if (refusal === null) throw rangeError(input.uncertainCode, input.refusal);
    let states: readonly unknown[];
    try {
      states = await this.#observeInputStates(input.preparation, input.operation);
    } catch {
      throw rangeError(input.uncertainCode, input.refusal);
    }
    const settlement = decideCtfRangeRequestSettlement({ refusal, inputStates: states });
    switch (settlement.kind) {
      case "restore":
        return;
      case "wait":
      case "replay":
        throw rangeError(input.uncertainCode, input.refusal);
      case "release":
        break;
      default:
        return assertNever(settlement);
    }
    if (refusal === "outputs-signed") {
      // Another client signed outputs from these counters. Advance the local
      // cursors before the attempt ends, so the next attempt uses fresh outputs.
      try {
        await this.#recoverOutputCounters?.({
          mintUrl: input.preparation.mintUrl,
          keysets: outputKeysets(input.preparation, input.operation),
        });
      } catch {
        throw rangeError(input.uncertainCode, input.refusal);
      }
    }
    await this.#releaseReservation({ ...input, states });
    throw rangeError("order-attempt-ended", input.refusal, {
      released: true,
      message: REFUSED_SOURCE_RELEASED_MESSAGE,
    });
  }

  /**
   * Release one refused source or consolidation and end its order attempt in
   * one transaction. The operation record and its exact output plan stay.
   */
  async #releaseReservation(input: {
    readonly preparation: PersistedCtfRangeOrderPreparation;
    readonly scope: DurableCustodyScope;
    readonly owner: DurableCustodyOwnerAuthorization;
    readonly custodyOperationId: string;
    readonly operation: DurableCustodyProofOperationInput;
    readonly states: readonly unknown[];
  }): Promise<void> {
    const { scope, preparation, custodyOperationId } = input;
    const spentSecrets = new Set(
      input.operation.inputs
        .filter((_, index) => input.states[index] === "SPENT")
        .map(({ secret }) => secret),
    );
    const spentProofIds = input.operation.inputs
      .filter(({ secret }) => spentSecrets.has(secret))
      .map(({ id, secret }) =>
        deriveDurableCustodyProofId({
          scopeId: scope.scopeId,
          normalizedMint: preparation.mintUrl,
          unit: "msat",
          keysetId: requireSourceKeysetId(id),
          secret,
        }),
      );
    const authorization = browserOwnerAt(input.owner, this.#now());
    try {
      await this.#database.transaction("rw", this.#transactionTables(true), async (tx) => {
        const current = await requireBrowserCustodyOperation(
          this.#custody,
          scope,
          custodyOperationId,
        );
        if (
          current.operation.result.state !== "none" ||
          (current.operation.state !== "dispatch-intent" &&
            current.operation.state !== "transport-attempted")
        ) {
          throw rangeError("recovery-pending");
        }
        await this.#custody.transactInCurrentTransaction(
          tx,
          browserCustodySelection(scope, authorization, custodyOperationId, current.revision),
          (transaction) =>
            transaction.transitionOperation({
              operationId: custodyOperationId,
              expectedRevision: current.revision,
              transition: {
                kind: "release-unspent-reservation",
                authorization,
                expectedRevision: current.revision,
              },
            }),
        );
        await this.#custody.retireReleasedMintSpentInputsInCurrentTransaction(tx, {
          scopeId: scope.scopeId,
          operationId: custodyOperationId,
          proofIds: spentProofIds,
          observedAtMs: authorization.observedAtMs,
        });
        for (const { secret } of input.operation.inputs) {
          const row = await this.#database.proofs.get(secret);
          if (row === undefined) continue;
          if (spentSecrets.has(secret)) {
            await this.#database.proofs.delete(secret);
          } else if (row.reservedBy === custodyOperationId) {
            const { reservedBy: _released, ...unreserved } = row;
            await this.#database.proofs.put(unreserved);
          }
        }
        const journal = await readCtfRangePreparation(
          scope.scopeId,
          preparation.operationId,
          this.#database,
        );
        if (journal === null) throw new Error("browser range journal disappeared during release");
        if (journal.lifecycleState !== "prepared") throw rangeError("recovery-pending");
        await transitionCtfRangePreparationInTransaction(
          tx,
          {
            scopeId: journal.scopeId,
            rangeOperationId: journal.rangeOperationId,
            expectedRevision: journal.revision,
            from: "prepared",
            to: "terminal",
            updatedAtMs: Math.max(authorization.observedAtMs, journal.updatedAtMs),
          },
          this.#database,
        );
      });
    } catch (error) {
      if (error instanceof BrowserCtfRangeOrderError) throw error;
      throw rangeError("custody-commit-failed", error);
    }
  }

  /** A released operation whose journal is still active ends its order attempt now. */
  async #endReleasedPreparation(
    scope: DurableCustodyScope,
    preparation: PersistedCtfRangeOrderPreparation,
  ): Promise<never> {
    const journal = await readCtfRangePreparation(
      scope.scopeId,
      preparation.operationId,
      this.#database,
    );
    if (journal !== null && journal.lifecycleState === "prepared") {
      await transitionCtfRangePreparation(
        {
          scopeId: journal.scopeId,
          rangeOperationId: journal.rangeOperationId,
          expectedRevision: journal.revision,
          from: "prepared",
          to: "terminal",
          updatedAtMs: Math.max(this.#now(), journal.updatedAtMs),
        },
        this.#database,
      );
    }
    throw rangeError("order-attempt-ended", undefined, {
      released: true,
      message: REFUSED_SOURCE_RELEASED_MESSAGE,
    });
  }

  async #restoreExactSource(
    preparation: PersistedCtfRangeOrderPreparation,
    seed: Uint8Array,
    source: DurableCustodyProofOperationInput,
  ): Promise<BrowserRangeSourceResult> {
    const mixed = ctfRangeSourceMode(source) === "mixed-source-ctf-convert";
    const operation = mixed
      ? validateCtfRangeMixedSourceOperation(source, preparation)
      : validateCtfRangeSourceCompletionOperation(source, {
          seed,
          keyset: preparation.offerKeyset,
        }).operation;
    const outputs = structuredClone(operation.outputs) as Record<string, StoredOutputData[]>;
    let restored: Record<string, Proof[]>;
    try {
      restored = await this.#restoreOutputs(preparation.mintUrl, outputs);
    } catch {
      throw rangeError("recovery-pending");
    }
    const labels = mixed
      ? ["authorization", "offered-change", "collateral-change"]
      : ["authorization", "keep"];
    if (Object.keys(restored).some((label) => !labels.includes(label))) {
      throw new Error("range source restore returned a foreign proof group");
    }
    if (mixed)
      return {
        authorization: restored.authorization ?? [],
        offeredChange: restored["offered-change"] ?? [],
        collateralChange: restored["collateral-change"] ?? [],
      };
    return {
      authorization: restored.authorization ?? [],
      keep: restored.keep ?? [],
    };
  }

  async #requireAppliedOuter(scope: DurableCustodyScope, operationId: string): Promise<void> {
    const custodyOperation = browserCustodyOperationId(scope, operationId);
    if ((await this.#custody.readOperation(scope, custodyOperation)) === null) {
      throw rangeError("recovery-pending");
    }
  }

  async #markSourceAttempted(
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
    operationId: string,
  ): Promise<DurableCustodyRecord> {
    const current = await requireBrowserCustodyOperation(this.#custody, scope, operationId);
    if (current.operation.state === "transport-attempted") return current;
    if (current.operation.state !== "dispatch-intent") throw rangeError("recovery-pending");
    const authorization = browserOwnerAt(owner, this.#now());
    await this.#custody.transact(
      browserCustodySelection(scope, authorization, operationId, current.revision),
      (transaction) =>
        transaction.transitionOperation({
          operationId,
          expectedRevision: current.revision,
          transition: {
            kind: "mark-transport-attempted",
            authorization,
            expectedRevision: current.revision,
          },
        }),
    );
    return requireBrowserCustodyOperation(this.#custody, scope, operationId);
  }

  async #stageSourceResult(
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
    preparation: PersistedCtfRangeOrderPreparation,
    sourceOperation: DurableCustodyProofOperationInput,
    current: DurableCustodyRecord,
    result: BrowserRangeSourceResult,
  ): Promise<DurableCustodyRecord> {
    const exactResult = prepareDurableCustodyExactArtifact(browserPersistedSourceResult(result));
    const successors = browserSourceCompletionProofRows(
      scope,
      preparation,
      sourceOperation,
      result,
      this.#now(),
    );
    const authorization = browserOwnerAt(owner, this.#now());
    await this.#custody.transact(
      browserCustodySelection(
        scope,
        authorization,
        current.operation.operationId,
        current.revision,
      ),
      (transaction) =>
        transaction.stageVerifiedResult({
          operationId: current.operation.operationId,
          expectedRevision: current.revision,
          authorization,
          outputPlanFingerprint: current.operation.outputPlan.outputPlanFingerprint,
          resultHandle: `range-source-result:${exactResult.fingerprint}`,
          resultFingerprint: exactResult.fingerprint,
          exactResult,
          selectedSuccessorProofIds: successors.map(({ proof }) => proof.proofId),
        }),
    );
    return requireBrowserCustodyOperation(this.#custody, scope, current.operation.operationId);
  }

  async #applySourceAndBindRange(
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
    preparation: PersistedCtfRangeOrderPreparation,
    seed: Uint8Array,
    sourceOperation: DurableCustodyProofOperationInput,
    source: DurableCustodyRecord,
    result: BrowserRangeSourceResult,
  ): Promise<{
    operation: DurableCtfRangeOperation;
    capabilityRequest: CreateSettlementCapabilityRequest;
  }> {
    if (source.operation.result.state !== "verified-staged") {
      throw rangeError("custody-commit-failed");
    }
    const operation = completeBrowserRangeOperation({
      preparation,
      seed,
      proofs: result.authorization,
      allowInsecureLoopbackHttp: this.#allowInsecureLoopbackHttp,
    });
    const capabilityRequest = createCtfRangeSettlementCapabilityRequest(preparation, operation);
    const binding = await createBrowserRangeBinding(
      scope,
      preparation,
      operation,
      capabilityRequest,
    );
    const successors = browserSourceCompletionProofRows(
      scope,
      preparation,
      sourceOperation,
      result,
      this.#now(),
    );
    const authorization = browserOwnerAt(owner, this.#now());
    const resultAuthority = requireBrowserStagedResult(source);
    await this.#commitAppliedSource({
      scope,
      authorization,
      source,
      sourceOperation,
      binding,
      successors,
      resultAuthority,
      preparation,
      result,
    });
    return { operation, capabilityRequest };
  }

  async #commitAppliedSource(input: AppliedSourceCommitInput): Promise<void> {
    const outerOperationId = input.binding.record.operation.operationId;
    try {
      await this.#database.transaction("rw", this.#transactionTables(false), async (tx) => {
        await this.#custody.transactInCurrentTransaction(
          tx,
          {
            scope: input.scope,
            owner: input.authorization,
            operationRows: [
              {
                operationId: input.source.operation.operationId,
                expectedRevision: input.source.revision,
              },
              { operationId: outerOperationId, expectedRevision: null },
            ],
          },
          (transaction) => {
            transaction.applyVerifiedResult({
              operationId: input.source.operation.operationId,
              expectedRevision: input.source.revision,
              authorization: input.authorization,
              outputPlanFingerprint: input.source.operation.outputPlan.outputPlanFingerprint,
              resultHandle: input.resultAuthority.resultHandle,
              resultFingerprint: input.resultAuthority.resultFingerprint,
              successorAdmission: {
                scopeId: input.scope.scopeId,
                operationId: input.source.operation.operationId,
                admissionId: `range-source-admission:${input.resultAuthority.resultFingerprint}`,
                proofRows: input.successors.map(({ proof, expectedRevision }) => ({
                  proofId: proof.proofId,
                  expectedRevision,
                  admittedRevision: proof.revision,
                })),
              },
            });
            bindDurableCustodyProofOperation(
              transaction,
              input.binding.record,
              input.binding.artifacts,
            );
          },
          {
            successorProofs: {
              [input.source.operation.operationId]: input.successors,
            },
          },
        );
        await this.#replaceLegacySourceProofs(
          input.preparation,
          input.sourceOperation,
          outerOperationId,
          input.result,
          input.authorization.observedAtMs,
        );
      });
    } catch (error) {
      console.error("Browser range-order custody commit failed.", error);
      throw rangeError("custody-commit-failed", error);
    }
  }

  async #createCapabilityAndSubmit(
    scope: Extract<DurableCustodyScope, { scopeKind: "wallet" }>,
    preparation: PersistedCtfRangeOrderPreparation,
    operation: DurableCtfRangeOperation,
    request: CreateSettlementCapabilityRequest,
    comment: NostrKind1Event | null,
    control: BrowserCtfRangeOrderSubmitControl,
  ): Promise<SubmitOrderResponse> {
    let requested: Awaited<ReturnType<typeof transitionCtfRangePreparation>>;
    try {
      requested = await transitionCtfRangePreparation(
        {
          scopeId: scope.scopeId,
          rangeOperationId: preparation.operationId,
          expectedRevision: 0,
          from: "prepared",
          to: "capability-requested",
          updatedAtMs: this.#now(),
        },
        this.#database,
      );
    } catch {
      try {
        const current = await readCtfRangePreparation(
          scope.scopeId,
          preparation.operationId,
          this.#database,
        );
        if (current?.lifecycleState === "terminal") {
          throw rangeError("order-attempt-ended");
        }
      } catch (error) {
        if (error instanceof BrowserCtfRangeOrderError) throw error;
      }
      throw rangeError("capability-creation-failed");
    }
    const capability = await this.#createVerifiedCapability(preparation, operation, request);
    const bound = await bindCtfRangePreparationCapability(
      {
        scopeId: scope.scopeId,
        rangeOperationId: preparation.operationId,
        expectedRevision: requested.revision,
        capability,
        updatedAtMs: this.#now(),
      },
      this.#database,
    );
    return this.#submitBoundCapability(scope, preparation, capability, bound, comment, control);
  }

  async #recoverRequestedCapability(
    record: Awaited<ReturnType<typeof pageActiveCtfRangePreparations>>["preparations"][number],
    scope: DurableCustodyScope,
  ): Promise<void> {
    const preparation = decodeCtfRangeOrderPreparationFromRecord(record);
    const snapshot = await this.#custody.readOperationSnapshot(
      scope,
      browserCustodyOperationId(scope, preparation.operationId),
    );
    if (snapshot === null) throw rangeError("recovery-pending");
    const operation = browserRangeOperationFromSnapshot(snapshot.record, snapshot.artifacts);
    const expectedRequest = createCtfRangeSettlementCapabilityRequest(preparation, operation);
    const request = browserRangeCapabilityRequestFromSnapshot(
      snapshot.record,
      snapshot.artifacts,
      expectedRequest,
    );
    let capability: ReturnType<typeof validateAndProjectCtfRangeSettlementCapabilityResponse>;
    try {
      capability = await this.#createVerifiedCapability(preparation, operation, request, true);
    } catch (error) {
      if (
        error instanceof BrowserCtfRangeOrderError &&
        error.code === "capability-creation-failed"
      ) {
        throw rangeError("recovery-pending", error);
      }
      throw error;
    }
    try {
      await bindCtfRangePreparationCapability(
        {
          scopeId: record.scopeId,
          rangeOperationId: record.rangeOperationId,
          expectedRevision: record.revision,
          capability,
          updatedAtMs: this.#now(),
        },
        this.#database,
      );
    } catch (error) {
      throw rangeError("recovery-pending", error);
    }
  }

  async #createVerifiedCapability(
    preparation: PersistedCtfRangeOrderPreparation,
    operation: DurableCtfRangeOperation,
    request: CreateSettlementCapabilityRequest,
    recovering = false,
  ): Promise<ReturnType<typeof validateAndProjectCtfRangeSettlementCapabilityResponse>> {
    if (Math.floor(this.#now() / 1_000) >= preparation.expiry) {
      throw rangeError("order-attempt-ended");
    }
    let response: SettlementCapabilityResponse;
    try {
      response = await this.#engine.createSettlementCapability(request);
    } catch (error) {
      const code =
        error instanceof EngineClientError && error.code !== undefined ? error.code : undefined;
      throw rangeError(
        code !== undefined && isSettlementCapabilityErrorCode(code)
          ? code
          : "capability-creation-failed",
      );
    }
    let capability: ReturnType<typeof validateAndProjectCtfRangeSettlementCapabilityResponse>;
    try {
      capability = validateAndProjectCtfRangeSettlementCapabilityResponse({
        capability: response,
        preparation,
        operation,
        recovering,
      });
    } catch {
      throw rangeError("capability-validation-failed");
    }
    return capability;
  }

  async #submitBoundCapability(
    scope: Extract<DurableCustodyScope, { scopeKind: "wallet" }>,
    preparation: PersistedCtfRangeOrderPreparation,
    capability: ReturnType<typeof validateAndProjectCtfRangeSettlementCapabilityResponse>,
    bound: Awaited<ReturnType<typeof bindCtfRangePreparationCapability>>,
    comment: NostrKind1Event | null,
    control: BrowserCtfRangeOrderSubmitControl,
  ): Promise<SubmitOrderResponse> {
    let submitted: SubmitOrderResponse;
    try {
      submitted = await this.#engine.submitOrder(
        preparation.request.marketId,
        {
          settlementCapability: {
            artifactId: capability.artifactId,
            bindingDigest: capability.bindingDigest,
          },
          comment,
          walletId: scope.walletId as WalletId,
        },
        {
          signal: control.signal,
          quoteRefreshRetry: {
            authorizationExpiresAtUnixSeconds: preparation.expiry,
            onWaiting: control.onQuotesRefreshing,
          },
        },
      );
    } catch (error) {
      if (!this.#isDefinitiveOrderRejection(error)) {
        throw rangeError("order-submission-uncertain");
      }
      try {
        await this.#markSubmissionRejected(bound);
      } catch {
        throw rangeError("order-submission-uncertain");
      }
      const code =
        error instanceof EngineClientError && error.code !== undefined ? error.code : undefined;
      throw rangeError(
        code !== undefined && isDefinitiveOrderSubmissionErrorCode(code)
          ? code
          : "order-submission-rejected",
      );
    }
    try {
      submitted = requireImmediateSubmitResponse(
        decodeSubmitOrderResponse(submitted),
        preparation,
        capability.orderId,
      );
    } catch {
      throw rangeError("order-submission-uncertain");
    }
    try {
      await transitionCtfRangePreparation(
        {
          scopeId: bound.scopeId,
          rangeOperationId: bound.rangeOperationId,
          expectedRevision: bound.revision,
          from: "capability-bound",
          to: "order-submitted",
          updatedAtMs: this.#now(),
        },
        this.#database,
      );
    } catch {
      throw rangeError("order-submission-uncertain");
    }
    return submitted;
  }

  async #discoverBoundOrder(
    record: Awaited<ReturnType<typeof pageActiveCtfRangePreparations>>["preparations"][number],
  ): Promise<void> {
    if (record.capability === null) throw new Error("bound range capability is missing");
    let status: OrderStatusResponse | null;
    try {
      status = await this.#engine.getOrderStatus(record.orderRouteId, record.capability.orderId);
    } catch {
      throw rangeError("recovery-pending");
    }
    if (status === null) return;
    if (status.orderId !== record.capability.orderId || status.marketId !== record.orderRouteId) {
      throw new Error("engine returned a foreign range order status");
    }
    await transitionCtfRangePreparation(
      {
        scopeId: record.scopeId,
        rangeOperationId: record.rangeOperationId,
        expectedRevision: record.revision,
        from: "capability-bound",
        to: "order-submitted",
        updatedAtMs: this.#now(),
      },
      this.#database,
    );
  }

  async #markSubmissionRejected(
    bound: Awaited<ReturnType<typeof bindCtfRangePreparationCapability>>,
  ): Promise<void> {
    await transitionCtfRangePreparation(
      {
        scopeId: bound.scopeId,
        rangeOperationId: bound.rangeOperationId,
        expectedRevision: bound.revision,
        from: "capability-bound",
        to: "submission-rejected",
        updatedAtMs: this.#now(),
      },
      this.#database,
    );
  }

  async #requireRefundOwner(
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
    record: DurableCustodyRecord,
  ): Promise<void> {
    await this.#database.transaction("rw", this.#transactionTables(true), async (tx) => {
      if (this.#isCurrentRefundProfile && !this.#isCurrentRefundProfile(scope.scopeId))
        throw new Error("browser refund profile changed");
      await this.#custody.transactInCurrentTransaction(
        tx,
        browserCustodySelection(
          scope,
          browserOwnerAt(owner, this.#now()),
          record.operation.operationId,
          record.revision,
        ),
        () => undefined,
      );
      if (this.#isCurrentRefundProfile && !this.#isCurrentRefundProfile(scope.scopeId))
        throw new Error("browser refund profile changed");
    });
  }

  async #startOuterRefund(
    journalRecord: NonNullable<Awaited<ReturnType<typeof readCtfRangePreparation>>>,
    seed: Uint8Array,
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
    record: DurableCustodyRecord,
    operation: DurableCtfRangeOperation,
  ): Promise<void> {
    await this.#requireSubmittedFokRefundSafe(journalRecord);
    const operationId = deriveDurableCtfRangeRefundOperationId(operation.operationId);
    const existing = await this.#database.proofOperations.get(operationId);
    const refund =
      existing ??
      (await this.#persistRefundPlan(journalRecord, seed, scope, owner, record, operation, null));
    await this.#resumeOuterRefund(
      journalRecord,
      seed,
      scope,
      owner,
      record,
      operation,
      refund,
      true,
    );
  }

  /**
   * Plan seed-derived refund outputs and save them with their counters. With
   * `replaced`, swap a refused plan for new outputs; the refund inputs stay.
   * The record keeps every replaced plan, so that an exact NUT-09 restore can
   * still find the outputs of a delayed earlier copy.
   */
  async #persistRefundPlan(
    journalRecord: NonNullable<Awaited<ReturnType<typeof readCtfRangePreparation>>>,
    seed: Uint8Array,
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
    record: DurableCustodyRecord,
    operation: DurableCtfRangeOperation,
    replaced: ProofOperationRecord | null,
  ): Promise<ProofOperationRecord> {
    const preparation = decodeCtfRangeOrderPreparationFromRecord(journalRecord);
    const refundAmount =
      operation.inputs.reduce((total, proof) => total + BigInt(proof.amount), 0n) -
      deriveDurableCtfRangeFeeBounds(operation).maximumFee;
    if (refundAmount <= 0n) throw new Error("browser range refund is fee-dominated");
    const replacedRefundOutputPlans =
      replaced === null
        ? []
        : [...savedReplacedRefundOutputPlans(replaced), replaced.metadata.refundOutputPlan];
    if (replacedRefundOutputPlans.length > REPLACED_REFUND_OUTPUT_PLANS_MAX)
      throw rangeError("recovery-pending");
    const operationId = deriveDurableCtfRangeRefundOperationId(operation.operationId);
    const preparationContext = { mintUrl: operation.mintUrl, unit: "msat" };
    const counters = new BrowserWalletCounterDexieStore({
      database: this.#database,
      scopeId: scope.scopeId,
      ...(this.#isCurrentRefundProfile === undefined
        ? {}
        : { isCurrentProfile: () => this.#isCurrentRefundProfile!(scope.scopeId) }),
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      const transcript = createSpeculativeCounterTranscript([
        await counters.readSnapshotInContext(preparationContext, preparation.offerKeyset.id),
      ]);
      const prepared = await prepareDurableSeedDerivedCtfRangeRefund({
        seed,
        counterSource: transcript.counterSource,
        source: operation,
        refundOperationId: operationId,
        amount: refundAmount,
        keyset: preparation.offerKeyset,
      });
      const now = this.#now();
      const refund: ProofOperationRecord = {
        operationId,
        kind: "ctf-range-refund",
        state: "prepared",
        mintUrl: operation.mintUrl,
        inputs: prepared.request.inputs,
        outputs: storedRefundOutputGroups(prepared.operation.outputs),
        metadata: {
          ...prepared.operation.metadata,
          unit: "msat",
          rangeOperationId: operation.operationId,
          refundRequestFingerprint: deriveDurableCtfRangeRefundRequestFingerprint(prepared.request),
          refundOutputPlan: prepared.plan,
          ...(replacedRefundOutputPlans.length === 0 ? {} : { replacedRefundOutputPlans }),
        },
        lastError: null,
        createdAt: replaced?.createdAt ?? now,
        updatedAt: Math.max(now, replaced?.updatedAt ?? now),
      };
      await this.#observeRefundPrepared?.(structuredClone({ operationId, plan: prepared.plan }));
      try {
        const selected = await this.#database.transaction(
          "rw",
          [
            ...this.#transactionTables(true),
            this.#database.walletCounterAssociations,
            this.#database.walletCounterCursors,
          ],
          async (tx) => {
            await this.#custody.transactInCurrentTransaction(
              tx,
              browserCustodySelection(
                scope,
                browserOwnerAt(owner, this.#now()),
                record.operation.operationId,
                record.revision,
              ),
              () => undefined,
            );
            const saved = await this.#database.proofOperations.get(operationId);
            if (replaced === null) {
              if (saved !== undefined) return saved;
            } else if (
              saved === undefined ||
              saved.state !== "prepared" ||
              refundAuthorityFingerprint(saved) !== refundAuthorityFingerprint(replaced)
            ) {
              throw new Error("browser refund saved authority changed before a new plan");
            }
            const current = await readCtfRangePreparation(
              scope.scopeId,
              journalRecord.rangeOperationId,
              this.#database,
            );
            if (
              current === null ||
              current.revision !== journalRecord.revision ||
              current.lifecycleState !== journalRecord.lifecycleState
            )
              throw new Error("browser refund source journal changed");
            const changes = transcript.changes();
            if (changes.length !== 1 || changes[0]!.keysetId !== preparation.offerKeyset.id)
              throw new Error("browser refund counter transcript is invalid");
            await counters.compareAndAdvanceInCurrentTransaction(
              tx,
              preparationContext,
              changes[0]!,
            );
            this.#injectRefundPreparationFault?.("counter-written");
            await this.#database.proofOperations.put(refund);
            this.#injectRefundPreparationFault?.("journal-bound");
            return refund;
          },
        );
        this.#injectRefundPreparationFault?.("after-commit");
        return selected;
      } catch (error) {
        const saved = await this.#database.proofOperations.get(operationId);
        if (saved !== undefined && (replaced === null || saved.updatedAt !== replaced.updatedAt)) {
          return saved;
        }
        if (!(error instanceof BrowserWalletCounterSnapshotConflictError) || attempt === 2)
          throw error;
      }
    }
    throw new Error("browser refund counter attempts exhausted");
  }

  /**
   * After 11003 or 11008 on a refund swap, the planned refund outputs are
   * already signed elsewhere. Check the inputs again; when every input is
   * unspent, advance the counters, plan new outputs, and return the new plan.
   */
  async #replanRefundAfterOutputReuse(
    error: unknown,
    journalRecord: NonNullable<Awaited<ReturnType<typeof readCtfRangePreparation>>>,
    seed: Uint8Array,
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
    record: DurableCustodyRecord,
    operation: DurableCtfRangeOperation,
    refund: ProofOperationRecord,
  ): Promise<ProofOperationRecord | null> {
    const failure = classifyCashuMintFailure(error);
    if (failure.kind !== "refusal" || !MINT_OUTPUT_REUSE_REFUSAL_CODES.has(failure.code)) {
      return null;
    }
    // Legacy refund outputs come from their own derivation, not NUT-13 counters.
    if (!Object.hasOwn(refund.metadata, "refundOutputPlan")) return null;
    if (savedReplacedRefundOutputPlans(refund).length >= REPLACED_REFUND_OUTPUT_PLANS_MAX) {
      return null;
    }
    let states: ProofState[];
    try {
      states = await (await this.#walletForMint(refund.mintUrl)).checkProofsStates(refund.inputs);
    } catch {
      return null;
    }
    if (states.length !== refund.inputs.length || states.some(({ state }) => state !== "UNSPENT")) {
      return null;
    }
    try {
      await this.#recoverOutputCounters?.({
        mintUrl: operation.mintUrl,
        keysets: [decodeCtfRangeOrderPreparationFromRecord(journalRecord).offerKeyset],
      });
    } catch {
      return null;
    }
    return this.#persistRefundPlan(journalRecord, seed, scope, owner, record, operation, refund);
  }

  async #resumeOuterRefund(
    journalRecord: NonNullable<Awaited<ReturnType<typeof readCtfRangePreparation>>>,
    seed: Uint8Array,
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
    record: DurableCustodyRecord,
    operation: DurableCtfRangeOperation,
    refund: ProofOperationRecord,
    orderStatusChecked = false,
    replanned = false,
  ): Promise<void> {
    await this.#requireRefundOwner(scope, owner, record);
    if (!orderStatusChecked) await this.#requireSubmittedFokRefundSafe(journalRecord);
    assertExactRefundRecord(refund, operation);
    validateSavedBrowserRefundDerivation(
      refund,
      operation,
      seed,
      decodeCtfRangeOrderPreparationFromRecord(journalRecord).offerKeyset,
    );
    if (refund.state === "Failed") throw new Error("browser range refund failed");
    let proofs = refund.resultProofs?.refund;
    if (refund.state !== "completed") {
      let states: ProofState[];
      try {
        states = await (await this.#walletForMint(refund.mintUrl)).checkProofsStates(refund.inputs);
      } catch (error) {
        throw rangeError("recovery-pending", error);
      }
      if (states.every(({ state }) => state === "UNSPENT")) {
        const outputs = refund.outputs.refund?.map(deserializeDurableCustodyOutput) ?? [];
        await this.#requireRefundOwner(scope, owner, record);
        let response: { signatures: SerializedBlindedSignature[] };
        try {
          response = await this.#executeRefundSwap(refund.mintUrl, {
            inputs: refund.inputs,
            outputs: outputs.map(({ blindedMessage }) => blindedMessage),
          });
        } catch (error) {
          const next = replanned
            ? null
            : await this.#replanRefundAfterOutputReuse(
                error,
                journalRecord,
                seed,
                scope,
                owner,
                record,
                operation,
                refund,
              );
          if (next === null) throw rangeError("recovery-pending", error);
          // Retry once now with the same inputs and the new outputs.
          return this.#resumeOuterRefund(
            journalRecord,
            seed,
            scope,
            owner,
            record,
            operation,
            next,
            true,
            true,
          );
        }
        const preparation = decodeCtfRangeOrderPreparationFromRecord(journalRecord);
        proofs = verifyDurableCtfRangeRefundSignatures({
          record,
          operation,
          keyset: preparation.offerKeyset,
          outputs: refund.outputs.refund ?? [],
          signatures: response.signatures,
        });
      } else if (states.every(({ state }) => state === "SPENT")) {
        const preparation = decodeCtfRangeOrderPreparationFromRecord(journalRecord);
        await this.#requireRefundOwner(scope, owner, record);
        proofs = await this.#pendingOnRecoveryTransport(() =>
          this.#restoreSpentRefund(refund, record, operation, preparation.offerKeyset),
        );
      } else {
        throw rangeError("recovery-pending");
      }
    }
    if (proofs === undefined || proofs.length === 0) {
      throw new Error("browser range refund proofs are incomplete");
    }
    await this.#commitOuterRefund(
      journalRecord,
      seed,
      scope,
      owner,
      record,
      operation,
      refund,
      proofs,
    );
  }

  /**
   * Restore the outputs of the refund copy that the mint committed. A delayed
   * copy can carry a replaced plan, so the wallet tries the current outputs
   * first and then each replaced plan, newest first.
   */
  async #restoreSpentRefund(
    refund: ProofOperationRecord,
    record: DurableCustodyRecord,
    operation: DurableCtfRangeOperation,
    keyset: PersistedCtfRangeOrderPreparation["offerKeyset"],
  ): Promise<Proof[]> {
    const current = refund.outputs.refund;
    if (current === undefined) {
      throw new Error("browser range refund output authority is missing");
    }
    let firstError: unknown = null;
    for (const outputs of [current, ...replacedRefundOutputs(refund).reverse()]) {
      try {
        return await this.#restoreRefundOutputs({
          mintUrl: refund.mintUrl,
          outputs,
          record,
          operation,
          keyset,
        });
      } catch (error) {
        if (error instanceof CtfRangeRecoveryTransportError) throw error;
        firstError ??= error;
      }
    }
    throw firstError;
  }

  async #requireSubmittedFokRefundSafe(
    journalRecord: NonNullable<Awaited<ReturnType<typeof readCtfRangePreparation>>>,
  ): Promise<void> {
    if (journalRecord.lifecycleState !== "order-submitted") return;
    const capability = journalRecord.capability;
    if (capability === null) throw rangeError("recovery-pending");
    let status: OrderStatusResponse | null;
    try {
      status = await this.#engine.getOrderStatus(journalRecord.orderRouteId, capability.orderId);
    } catch (error) {
      throw rangeError("recovery-pending", error);
    }
    if (status === null) return;
    const request = decodeCtfRangeOrderPreparationFromRecord(journalRecord).request;
    if (
      status.orderId !== capability.orderId ||
      status.marketId !== journalRecord.orderRouteId ||
      status.timeInForce !== "FOK" ||
      status.amountSubunits !== request.amountSubunits ||
      status.side !== request.side ||
      status.price !== request.price ||
      status.maxQuotePaymentSubunits !== request.maxQuotePaymentSubunits ||
      status.minQuotePaymentSubunits !== request.minQuotePaymentSubunits ||
      status.tokenSide !== request.tokenSide ||
      status.baseAsset !== request.baseAsset ||
      status.divisibility !== request.divisibility
    ) {
      throw rangeError("recovery-pending");
    }
    switch (status.status) {
      case "resting":
      case "matched":
      case "partially_filled":
        throw rangeError("recovery-pending");
    }
  }

  async #commitOuterRefund(
    journalRecord: NonNullable<Awaited<ReturnType<typeof readCtfRangePreparation>>>,
    seed: Uint8Array,
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
    record: DurableCustodyRecord,
    operation: DurableCtfRangeOperation,
    refund: ProofOperationRecord,
    proofs: readonly Proof[],
  ): Promise<void> {
    const authorization = browserOwnerAt(owner, this.#now());
    const legacyProofs = browserRangeRefundStoredProofs(
      operation,
      proofs,
      authorization.observedAtMs,
    );
    const preparation = decodeCtfRangeOrderPreparationFromRecord(journalRecord);
    let locators: Extract<
      import("@bitcaster/client-sdk/durableWalletProofDerivationLocator").DurableWalletProofDerivationLocator,
      { kind: "nut13" | "ctf-range-refund" }
    >[];
    if (Object.hasOwn(refund.metadata, "refundOutputPlan")) {
      const { plan, ordered } = refundPlanOfProofs(refund, preparation.offerKeyset.id, proofs);
      const bySecret = new Map(
        ordered.map((proof, index) => [
          proof.secret,
          {
            schemaVersion: 1 as const,
            kind: "nut13" as const,
            keysetId: plan.keysetId,
            counter: plan.counterStart + index,
          },
        ]),
      );
      locators = proofs.map((proof) => bySecret.get(proof.secret)!);
    } else {
      const legacy = createDeterministicDurableCtfRangeRefundOutputsWithLocators({
        seed,
        source: operation,
        refundOperationId: refund.operationId,
        amount:
          operation.inputs.reduce((total, proof) => total + BigInt(proof.amount), 0n) -
          deriveDurableCtfRangeFeeBounds(operation).maximumFee,
        keyset: preparation.offerKeyset,
      });
      locators = [
        ...matchDeterministicDurableCtfRangeRefundProofLocators({ outputs: legacy, proofs }),
      ];
    }
    const custodyProofs = browserRangeRefundProofRows(
      record,
      operation,
      proofs,
      locators,
      authorization.observedAtMs,
    );
    await this.#database.transaction("rw", this.#transactionTables(true), async (tx) => {
      const currentRefund = await this.#database.proofOperations.get(refund.operationId);
      if (
        currentRefund === undefined ||
        refundAuthorityFingerprint(currentRefund) !== refundAuthorityFingerprint(refund)
      )
        throw new Error("browser refund saved authority changed before completion");
      await this.#database.proofOperations.put({
        ...refund,
        state: "completed",
        resultProofs: { refund: [...proofs] },
        lastError: null,
        updatedAt: authorization.observedAtMs,
      });
      await this.#custody.transactInCurrentTransaction(
        tx,
        browserCustodySelection(
          scope,
          authorization,
          record.operation.operationId,
          record.revision,
        ),
        (transaction) =>
          transaction.transitionOperation({
            operationId: record.operation.operationId,
            expectedRevision: record.revision,
            transition: {
              kind: "abort",
              authorization,
              expectedRevision: record.revision,
            },
          }),
      );
      await this.#custody.retireAbortedInputsAndAdmitRefundsInCurrentTransaction(tx, {
        scopeId: scope.scopeId,
        operationId: record.operation.operationId,
        refundProofs: custodyProofs,
        observedAtMs: authorization.observedAtMs,
      });
      await this.#replaceLegacyReservedProofs(
        operation.inputs.map(({ secret }) => secret),
        legacyProofs,
      );
      await transitionCtfRangePreparationInTransaction(
        tx,
        {
          scopeId: journalRecord.scopeId,
          rangeOperationId: journalRecord.rangeOperationId,
          expectedRevision: journalRecord.revision,
          from: journalRecord.lifecycleState,
          to: "terminal",
          updatedAtMs: authorization.observedAtMs,
        },
        this.#database,
      );
    });
  }

  async #commitRecoveredOuterResult(
    seed: Uint8Array,
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
    record: DurableCustodyRecord,
    operation: DurableCtfRangeOperation,
    prepared: Extract<DurableCtfRangeVerifiedResultPreparation, { kind: "confirmed" }>,
    resolveKeyset: DurableCtfRangeKeysetResolver,
  ): Promise<void> {
    const operationId = record.operation.operationId;
    let current = record;
    if (current.operation.result.state === "none") {
      const authorization = browserOwnerAt(owner, this.#now());
      await this.#custody.transact(
        browserCustodySelection(scope, authorization, operationId, current.revision),
        (transaction) =>
          transaction.stageVerifiedResult({
            operationId,
            expectedRevision: current.revision,
            authorization,
            outputPlanFingerprint: current.operation.outputPlan.outputPlanFingerprint,
            resultHandle: prepared.resultHandle,
            resultFingerprint: prepared.resultFingerprint,
            exactResult: prepared.exactResult,
            selectedSuccessorProofIds: prepared.selectedSuccessorProofIds,
          }),
      );
      current = await requireBrowserCustodyOperation(this.#custody, scope, operationId);
    }
    if (current.operation.result.state === "applied") {
      return;
    }
    if (current.operation.result.state !== "verified-staged") {
      throw rangeError("recovery-pending");
    }
    const exactResult = await this.#readExactResultArtifact(scope, current);
    const result = recoverDurableCtfRangeVerifiedResultArtifact({
      record: current,
      operation,
      exactResult,
      resolveKeyset,
    });
    await this.#applyRecoveredOuterResult(seed, scope, owner, current, operation, result);
  }

  async #applyRecoveredOuterResult(
    seed: Uint8Array,
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
    record: DurableCustodyRecord,
    operation: DurableCtfRangeOperation,
    result: DurableCtfRangeRecoveredResult,
  ): Promise<void> {
    const authorization = browserOwnerAt(owner, this.#now());
    const resultAuthority = requireAppliedResultAuthority(record);
    const journal = await readCtfRangePreparation(
      scope.scopeId,
      operation.operationId,
      this.#database,
    );
    if (journal === null) throw new Error("range successor preparation is missing");
    const preparation = decodeCtfRangeOrderPreparationFromRecord(journal);
    const successors = browserRangeSuccessorProofRows(
      record,
      operation,
      result,
      authorization.observedAtMs,
      preparation,
      seed,
    );
    const legacySuccessors = browserRangeStoredProofs(
      operation,
      result,
      authorization.observedAtMs,
    );
    await this.#database.transaction("rw", this.#transactionTables(true), async (tx) => {
      const currentJournal = await readCtfRangePreparation(
        scope.scopeId,
        operation.operationId,
        this.#database,
      );
      if (
        currentJournal === null ||
        prepareDurableCustodyExactArtifact(decodeCtfRangeOrderPreparationFromRecord(currentJournal))
          .fingerprint !== prepareDurableCustodyExactArtifact(preparation).fingerprint
      )
        throw new Error("range successor preparation changed before completion");
      await this.#custody.transactInCurrentTransaction(
        tx,
        browserCustodySelection(
          scope,
          authorization,
          record.operation.operationId,
          record.revision,
        ),
        (transaction) =>
          transaction.applyVerifiedResult({
            operationId: record.operation.operationId,
            expectedRevision: record.revision,
            authorization,
            outputPlanFingerprint: record.operation.outputPlan.outputPlanFingerprint,
            resultHandle: resultAuthority.resultHandle,
            resultFingerprint: resultAuthority.resultFingerprint,
            successorAdmission: {
              scopeId: scope.scopeId,
              operationId: record.operation.operationId,
              admissionId: `ctf-range-admission:${resultAuthority.resultFingerprint}`,
              proofRows: successors.map(({ proof, expectedRevision }) => ({
                proofId: proof.proofId,
                expectedRevision,
                admittedRevision: proof.revision,
              })),
            },
          }),
        { successorProofs: { [record.operation.operationId]: successors } },
      );
      await this.#replaceLegacyReservedProofs(
        operation.inputs.map(({ secret }) => secret),
        legacySuccessors,
      );
    });
  }

  async #readExactResultArtifact(scope: DurableCustodyScope, record: DurableCustodyRecord) {
    const snapshot = await this.#custody.readOperationSnapshot(scope, record.operation.operationId);
    const reference = record.operation.result.exactResult;
    if (snapshot === null || reference === null) {
      throw new Error("browser range result artifact is missing");
    }
    const row = snapshot.artifacts.find(
      ({ reference: candidate }) => candidate.artifactId === reference.artifactId,
    );
    if (row === undefined) throw new Error("browser range result artifact is missing");
    return row.artifact;
  }

  async #terminalizeRecoveredJournal(
    journalRecord: NonNullable<Awaited<ReturnType<typeof readCtfRangePreparation>>>,
  ): Promise<void> {
    if (journalRecord.lifecycleState === "terminal") return;
    await transitionCtfRangePreparation(
      {
        scopeId: journalRecord.scopeId,
        rangeOperationId: journalRecord.rangeOperationId,
        expectedRevision: journalRecord.revision,
        from: journalRecord.lifecycleState,
        to: "terminal",
        updatedAtMs: this.#now(),
      },
      this.#database,
    );
  }

  #requireExactFokSettlement(
    journalRecord: NonNullable<Awaited<ReturnType<typeof readCtfRangePreparation>>>,
    operation: DurableCtfRangeOperation,
    result: DurableCtfRangeRecoveredResult,
  ): void {
    const request = decodeCtfRangeOrderPreparationFromRecord(journalRecord).request;
    requireFokRequest(request);
    if (deriveDurableCtfRangeSettledFaceAmount(operation, result) !== request.amountSubunits) {
      throw rangeError("recovery-pending");
    }
  }

  async #reserveLegacySourceProofs(
    preparation: PersistedCtfRangeOrderPreparation,
    reservationOperationId: string,
    sourceProofs: DurableCustodyProofOperationInput["inputs"],
  ): Promise<void> {
    await this.#database.proofs.bulkPut(
      sourceProofs.map((proof) =>
        storedProofRow(
          legacySourceProof(preparation, proof as Proof, this.#now(), reservationOperationId),
        ),
      ),
    );
  }

  async #reserveLegacyConsolidationProofs(
    scope: DurableCustodyScope,
    preparation: PersistedCtfRangeOrderPreparation,
    reservationOperationId: string,
    sourceProofs: DurableCustodyProofOperationInput["inputs"],
    expectedProofs: ReturnType<typeof browserSourceProofRows>[number]["proof"][],
  ): Promise<void> {
    const rows = await this.#database.proofs.bulkGet(sourceProofs.map(({ secret }) => secret));
    if (rows.length !== sourceProofs.length || rows.length !== expectedProofs.length) return;
    const reserved: StoredProofRow[] = [];
    for (const [index, sourceProof] of sourceProofs.entries()) {
      const row = rows[index];
      const expected = expectedProofs[index];
      if (!row || !expected || row.reservedBy !== undefined) return;
      const observed = browserSourceProofRows(
        scope,
        preparation,
        { authorization: [storedProofFromRow(row)], keep: [] },
        this.#now(),
      )[0]?.proof;
      if (
        observed === undefined ||
        row.secret !== sourceProof.secret ||
        row.id !== sourceProof.id ||
        observed.proofId !== expected.proofId ||
        observed.proofFingerprint !== expected.proofFingerprint
      ) {
        return;
      }
      reserved.push({ ...row, reservedBy: reservationOperationId });
    }
    await this.#database.proofs.bulkPut(reserved);
  }

  async #replaceLegacySourceProofs(
    preparation: PersistedCtfRangeOrderPreparation,
    source: DurableCustodyProofOperationInput,
    rangeCustodyOperationId: string,
    result: BrowserRangeSourceResult,
    receivedAtMs: number,
  ): Promise<void> {
    const inputSecrets = source.inputs.map(({ secret }) => secret);
    const authorization = result.authorization.map((proof) =>
      legacySourceProof(preparation, proof, receivedAtMs, rangeCustodyOperationId),
    );
    const keep = (
      "keep" in result ? result.keep : [...result.offeredChange, ...result.collateralChange]
    ).map((proof) => legacySourceProof(preparation, proof, receivedAtMs));
    await this.#replaceLegacyReservedProofs(inputSecrets, [...authorization, ...keep]);
  }

  async #replaceLegacyReservedProofs(
    inputSecrets: readonly string[],
    successors: readonly StoredProof[],
  ): Promise<void> {
    await this.#database.proofs.bulkDelete([...inputSecrets]);
    if (successors.length > 0) {
      await this.#database.proofs.bulkPut(successors.map(storedProofRow));
    }
  }

  /** Attach the mint's Retry-After of a failed wallet swap, such as a 503. */
  async #withWalletRetryAfter<T>(
    mintUrl: string,
    action: (wallet: BrowserCtfRangeWallet) => Promise<T>,
  ): Promise<T> {
    const wallet = await this.#walletForMint(mintUrl);
    try {
      return await action(wallet);
    } catch (error) {
      const metadata = (wallet as { mint?: { lastResponseMetadata?: { retryAfterMs?: number } } })
        .mint?.lastResponseMetadata;
      throw withRetryAfter(error, metadata?.retryAfterMs);
    }
  }

  /**
   * Refuse a sell that would lock more of a position while an earlier sell of
   * the same market still holds reserved source funds. Callers hold the wallet
   * profile lock, so the check and the new source commit cannot interleave.
   */
  async #requireNoUnresolvedSell(
    scope: DurableCustodyScope,
    preparation: PersistedCtfRangeOrderPreparation,
  ): Promise<void> {
    if (preparation.side !== "Sell") return;
    const prepared = await readPreparedCtfRangeSells(
      scope.scopeId,
      preparation.conditionId,
      this.#database,
    );
    let blocking: string | null = null;
    for (const record of prepared.records) {
      if (record.rangeOperationId === preparation.operationId) continue;
      if (await this.#holdsReservedFunds(scope, record)) {
        blocking = record.rangeOperationId;
        break;
      }
    }
    if (blocking === null && !prepared.overflow) return;
    await this.#endUnfundedPreparation(scope, preparation);
    const halted =
      blocking !== null &&
      this.#recoverySchedule?.state(scope.scopeId, blocking, this.#now()).kind === "halted";
    throw new BrowserCtfRangeOrderError(
      "source-preparation-pending",
      browserCtfRangeOrderErrorMessage("source-preparation-pending"),
      null,
      { retry: halted ? { scopeId: scope.scopeId, operationId: blocking! } : null },
    );
  }

  async #holdsReservedFunds(
    scope: DurableCustodyScope,
    record: NonNullable<Awaited<ReturnType<typeof readCtfRangePreparation>>>,
  ): Promise<boolean> {
    const preparation = decodeCtfRangeOrderPreparationFromRecord(record);
    const source = await this.#custody.readOperation(
      scope,
      browserSourceCustodyOperationId(scope, preparation.sourceOperationId),
    );
    // An applied source passes its funds to the order authorization.
    if (source !== null) return source.operation.state !== "aborted";
    for (const link of await readCtfRangePreparationConsolidations(
      scope.scopeId,
      record.rangeOperationId,
      this.#database,
    )) {
      const state = (await this.#custody.readOperation(scope, link.operationId))?.operation.state;
      switch (state) {
        case "dispatch-intent":
        case "transport-attempted":
          return true;
        case "reconciled":
        case "aborted":
        case undefined:
          break;
        default:
          return assertNever(state);
      }
    }
    return false;
  }

  /** End this attempt's journal when it holds no funds, so it leaves no recovery work. */
  async #endUnfundedPreparation(
    scope: DurableCustodyScope,
    preparation: PersistedCtfRangeOrderPreparation,
  ): Promise<void> {
    const journal = await readCtfRangePreparation(
      scope.scopeId,
      preparation.operationId,
      this.#database,
    );
    if (journal === null || journal.lifecycleState !== "prepared") return;
    if (await this.#holdsReservedFunds(scope, journal)) return;
    await transitionCtfRangePreparation(
      {
        scopeId: journal.scopeId,
        rangeOperationId: journal.rangeOperationId,
        expectedRevision: journal.revision,
        from: "prepared",
        to: "terminal",
        updatedAtMs: Math.max(this.#now(), journal.updatedAtMs),
      },
      this.#database,
    );
  }

  async #withScopeOwner<T>(
    scope: DurableCustodyScope,
    action: (owner: DurableCustodyOwnerAuthorization) => Promise<T>,
  ): Promise<T> {
    const observedAtMs = this.#now();
    const owner = await this.#custody.claimScope(scope, {
      incarnationId: `browser-range:${this.#randomId()}`,
      observedAtMs,
      leaseExpiresAtMs: observedAtMs + SCOPE_LEASE_MS,
    });
    try {
      return await action(owner);
    } finally {
      await this.#custody.releaseScope(scope, browserOwnerAt(owner, this.#now()));
    }
  }

  async #requireSavedPreparation(
    scope: DurableCustodyScope,
    preparation: PersistedCtfRangeOrderPreparation,
    fees: CtfRangeOrderFeeFacts,
  ): Promise<void> {
    const journal = await readCtfRangePreparation(
      scope.scopeId,
      preparation.operationId,
      this.#database,
    );
    if (
      journal === null ||
      !sameCtfRangeOrderPreparationIdentity(
        journal,
        await this.#journalIdentity(scope, preparation, fees),
      )
    ) {
      throw rangeError("recovery-pending");
    }
  }

  #sourceCounters(scope: DurableCustodyScope): BrowserWalletCounterDexieStore {
    return new BrowserWalletCounterDexieStore({
      database: this.#database,
      scopeId: scope.scopeId,
      ...(this.#isCurrentRefundProfile === undefined
        ? {}
        : { isCurrentProfile: () => this.#isCurrentRefundProfile!(scope.scopeId) }),
    });
  }

  #transactionTables(includeJournal: boolean) {
    return [
      ...(includeJournal ? [this.#database.ctfRangePreparations] : []),
      this.#database.ctfRangePreparationConsolidations,
      this.#database.proofs,
      this.#database.proofOperations,
      this.#database.custodyScopes,
      this.#database.custodyOperations,
      this.#database.custodyArtifacts,
      this.#database.custodyProofs,
      this.#database.custodyProofBackupAuthorities,
      this.#database.custodyConditionalKeysets,
      this.#database.encryptedWalletBackupV2DesiredAssets,
      this.#database.custodyReservations,
      this.#database.custodyActiveWork,
    ] as const;
  }
}

function requireFokRequest(
  request: CtfRangeOrderRequest,
): asserts request is CtfRangeOrderRequest & { readonly timeInForce: "FOK" } {
  if (request.timeInForce !== "FOK") throw rangeError("invalid-order-type");
}

function sourcePreparationFeeSubunits(operation: DurableCustodyProofOperationInput): string {
  const fees = operation.metadata?.fees;
  if (typeof fees !== "number" || !Number.isSafeInteger(fees) || fees < 0) {
    throw new Error("range source fee metadata is invalid");
  }
  return String(fees);
}

function normalizeCurrentFeeFacts(
  preparation: PersistedCtfRangeOrderPreparation,
  current: CtfRangeOrderFeeFacts,
  operation: DurableCustodyProofOperationInput,
): CtfRangeOrderFeeFacts {
  const sourceMode = ctfRangeSourceMode(operation);
  const offeredAsset = preparationAsset(preparation);
  let sourcePreparationAsset: DurableCtfRangeAsset;
  switch (sourceMode) {
    case "wallet-send":
    case "mixed-source-ctf-convert":
      sourcePreparationAsset = { kind: "regular", unit: "msat" };
      break;
    case "conditional-keyset-swap":
      sourcePreparationAsset = offeredAsset;
      break;
    case "ctf-range-collateral-convert":
      throw new Error("Collateral-only preparation cannot replace held Sell inputs");
    default:
      return assertNever(sourceMode);
  }
  return {
    settlementInputFeeSubunits:
      planPersistedCtfRangeOrderAuthorization(preparation).participantFeeAllocationUpperBound,
    sourcePreparationFeeSubunits: sourcePreparationFeeSubunits(operation),
    consolidationFeeSubunits: current.consolidationFeeSubunits,
    settlementAsset: { kind: "regular", unit: "msat" },
    sourcePreparationAsset,
    consolidationAsset: offeredAsset,
    sourceMode,
  };
}

function preparationAsset(preparation: PersistedCtfRangeOrderPreparation): DurableCtfRangeAsset {
  const asset = browserRangeSourceAsset(preparation);
  return asset.kind === "regular"
    ? { kind: "regular", unit: "msat" }
    : {
        kind: "conditional",
        unit: "msat",
        conditionId: asset.conditionId,
        outcomeCollection: asset.outcomeCollection,
      };
}

function requireImmediateSubmitResponse(
  response: SubmitOrderResponse,
  preparation: PersistedCtfRangeOrderPreparation,
  expectedOrderId: string,
): SubmitOrderResponse {
  if (
    response.orderId !== expectedOrderId ||
    response.baseAsset !== preparation.request.baseAsset ||
    response.divisibility !== preparation.divisibility ||
    response.remainingAmountSubunits !==
      immediateFokRemainingAmount(response.status, preparation.request.amountSubunits)
  ) {
    throw new Error("engine returned an invalid immediate order response");
  }
  return response;
}

function immediateFokRemainingAmount(
  status: SubmitOrderResponse["status"],
  requestedAmountSubunits: number,
): number | null {
  switch (status) {
    // FOK is all-or-nothing, so a refused FOK retains its complete request.
    // The engine reports failed when it cannot process the order.
    case "cancelled":
    case "failed":
      return requestedAmountSubunits;
    case "matched":
    case "filled":
    case "expired":
    case "evicted_capacity":
    case "rejected_capacity":
      return 0;
    // A FOK never rests or partially fills.
    case "resting":
    case "partially_filled":
      return null;
    default:
      return assertNever(status);
  }
}

function rangeError(
  code: BrowserCtfRangeOrderErrorCode,
  cause?: unknown,
  options: { readonly released?: boolean; readonly message?: string } = {},
): BrowserCtfRangeOrderError {
  const failure = cause === undefined ? null : classifyCashuMintFailure(cause);
  const error = new BrowserCtfRangeOrderError(
    code,
    options.message ?? browserCtfRangeOrderErrorMessage(code),
    null,
    {
      mintError:
        failure === null || failure.kind === "transient"
          ? null
          : { code: failure.code, detail: failure.detail },
      retryAfterMs: failure?.kind === "transient" ? failure.retryAfterMs : null,
      released: options.released === true,
    },
  );
  if (cause !== undefined) Object.defineProperty(error, "cause", { value: cause });
  return error;
}

/** Attach the response's Retry-After to an HTTP failure, such as a 503. */
function withRetryAfter(error: unknown, retryAfterMs: number | undefined): unknown {
  if (
    error instanceof HttpResponseError &&
    retryAfterMs !== undefined &&
    !Object.hasOwn(error, "retryAfterMs")
  ) {
    Object.defineProperty(error, "retryAfterMs", { value: retryAfterMs });
  }
  return error;
}

/** A mixed spent-and-unspent reading replays to obtain the mint's answer. */
function replaysMixedReading(states: readonly unknown[]): boolean {
  return decideCtfRangeRequestSettlement({ refusal: null, inputStates: states }).kind === "replay";
}

function refundAuthorityFingerprint(row: ProofOperationRecord): string {
  return prepareDurableCustodyExactArtifact({
    operationId: row.operationId,
    kind: row.kind,
    mintUrl: row.mintUrl,
    inputs: row.inputs.map((proof) => ({
      id: proof.id,
      amount: amountToNumber(proof.amount),
      secret: proof.secret,
      C: proof.C,
      dleq: proof.dleq ?? null,
      p2pkE: proof.p2pk_e ?? null,
      witness: proof.witness ?? null,
    })),
    outputs: row.outputs,
    metadata: row.metadata,
  }).fingerprint;
}

/** The refund output plans that a re-plan replaced, oldest first. */
function savedReplacedRefundOutputPlans(refund: ProofOperationRecord): readonly unknown[] {
  if (!Object.hasOwn(refund.metadata, "replacedRefundOutputPlans")) return [];
  const plans: unknown = refund.metadata.replacedRefundOutputPlans;
  if (
    !Array.isArray(plans) ||
    plans.length === 0 ||
    plans.length > REPLACED_REFUND_OUTPUT_PLANS_MAX
  ) {
    throw new Error("browser refund replaced output plans are invalid");
  }
  return plans;
}

/** The stored outputs of each replaced refund plan, oldest first. */
function replacedRefundOutputs(refund: ProofOperationRecord): StoredOutputData[][] {
  return savedReplacedRefundOutputPlans(refund).map((value) =>
    decodeDurableSeedDerivedOutputPlan(value).outputs.map((serialized) => {
      const output = serializeDurableCustodyOutput(OutputData.deserialize(serialized));
      return {
        blindedMessage: {
          amount: amountToNumber(output.blindedMessage.amount),
          id: output.blindedMessage.id,
          B_: output.blindedMessage.B_,
        },
        blindingFactor: output.blindingFactor,
        secret: output.secret,
      };
    }),
  );
}

/** The saved refund plan, current or replaced, whose outputs produced these proofs. */
function refundPlanOfProofs(
  refund: ProofOperationRecord,
  keysetId: string,
  proofs: readonly Proof[],
): { plan: DurableSeedDerivedOutputPlan; ordered: readonly Proof[] } {
  const current = assertDurableSeedDerivedOutputPlanMatchesOutputs({
    plan: refund.metadata.refundOutputPlan,
    keysetId,
    outputs: (refund.outputs.refund ?? []).map(deserializeDurableCustodyOutput),
  });
  const replaced = savedReplacedRefundOutputPlans(refund).map(decodeDurableSeedDerivedOutputPlan);
  for (const plan of [current, ...replaced.reverse()]) {
    if (plan.keysetId !== keysetId) continue;
    try {
      return { plan, ordered: matchDurableSeedDerivedProofsToPlan({ plan, proofs }) };
    } catch {
      // These proofs come from another saved plan.
    }
  }
  throw new Error("browser refund proofs match no saved output plan");
}

/** Every keyset that one persisted operation asks the mint to sign. */
function outputKeysets(
  preparation: PersistedCtfRangeOrderPreparation,
  operation: DurableCustodyProofOperationInput,
): PersistedCtfRangeOrderPreparation["offerKeyset"][] {
  const known = [preparation.offerKeyset, preparation.receiveKeyset];
  const ids = new Set(
    Object.values(operation.outputs).flatMap((outputs) =>
      outputs.map(({ blindedMessage }) => blindedMessage.id),
    ),
  );
  return [...ids].map((id) => {
    const keyset = known.find((candidate) => candidate.id === id);
    if (keyset === undefined) throw new Error("range operation output keyset is foreign");
    return keyset;
  });
}

function requireDirectSourceInputs(input: {
  readonly candidates?: readonly Proof[];
  readonly collateralCandidates?: readonly Proof[];
  readonly maxOutputs?: number;
  readonly paidConsolidationFeeSubunits?: string;
  readonly currentFeeFacts?: CtfRangeOrderFeeFacts;
  readonly consentedFeeFacts: CtfRangeOrderFeeFacts;
}): BrowserCtfRangeSourceInputs {
  if (
    input.candidates === undefined ||
    input.collateralCandidates === undefined ||
    input.maxOutputs === undefined ||
    input.paidConsolidationFeeSubunits === undefined ||
    input.currentFeeFacts === undefined
  ) {
    throw rangeError("source-preparation-failed");
  }
  return {
    candidates: input.candidates,
    collateralCandidates: input.collateralCandidates,
    maxOutputs: input.maxOutputs,
    paidConsolidationFeeSubunits: input.paidConsolidationFeeSubunits,
    currentFeeFacts: input.currentFeeFacts,
  };
}

function isMintRecoveredRangeResult(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).schemaVersion === 2 &&
    (value as Record<string, unknown>).source === "mint-recovery"
  );
}

export function browserCtfRangeOrderErrorMessage(code: BrowserCtfRangeOrderErrorCode): string {
  const messages: Record<BrowserCtfRangeOrderErrorCode, string> = {
    "invalid-order-type": "The browser supports only FOK range orders.",
    "insufficient-funds": "The wallet has insufficient selectable funds for this order.",
    "score-top-up-required":
      "Participation Score top-up is required before this order can be submitted.",
    "score-top-up-cancelled":
      "Participation Score top-up was cancelled. The order was not submitted.",
    "asset-recovery-failed": "The wallet could not recover the exact funds for this order.",
    "source-preparation-failed": "The wallet could not prepare the range authorization.",
    "mint-source-uncertain": "The mint result is uncertain. Funds recovery is pending.",
    "custody-commit-failed": "The wallet could not commit the durable range operation.",
    "capability-creation-failed":
      "The settlement capability result is uncertain. The order was not submitted.",
    "capability-validation-failed": "The engine returned an invalid settlement capability.",
    "order-attempt-ended":
      "The prepared order attempt ended before capability creation. No order was submitted.",
    "settlement-capability-invalid-request":
      "The engine rejected the capability request because its fields are invalid.",
    "settlement-capability-invalid-artifact": "The engine rejected the capability artifact.",
    "settlement-capability-policy-rejected":
      "The engine rejected the capability because it does not meet admission policy.",
    "settlement-capability-score-required":
      "The engine requires more Participation Score for this capability.",
    "settlement-capability-not-found": "The engine could not find the capability request.",
    "settlement-capability-conflict":
      "The capability request conflicts with an existing operation.",
    "settlement-capability-market-unavailable": "The market is not available for this capability.",
    "settlement-capability-request-too-large":
      "The capability request exceeds a supported size or count limit.",
    "settlement-capability-admission-limited":
      "Capability admission is busy. The capability result may be uncertain.",
    "settlement-capability-capacity-exhausted":
      "Capability admission capacity is exhausted. The capability result may be uncertain.",
    "settlement-capability-admission-unavailable":
      "Capability admission is temporarily unavailable. The capability result may be uncertain.",
    "order-invalid-request":
      "The engine rejected the order request because its fields are invalid.",
    "order-invalid-comment": "The engine rejected the order comment.",
    "order-market-not-found": "The engine could not find the market.",
    "order-capability-not-found": "The engine could not find the settlement capability.",
    "order-capability-route-mismatch": "The settlement capability does not match the order route.",
    "order-capability-not-current": "The settlement capability is not current for this order.",
    "order-processing-conflict": "The engine rejected the order because processing conflicted.",
    "order-market-closed": "The engine rejected the order because the market closed.",
    "order-submission-rejected": "The engine rejected the order. It will not retry.",
    "order-submission-uncertain": "The order acknowledgement is uncertain. It will not retry.",
    "recovery-pending": "The durable range operation still requires funds recovery.",
    "source-preparation-pending":
      "An earlier sell in this market is still preparing its funds. Wait until it finishes.",
  };
  return messages[code];
}

function requireSourceKeysetId(value: string | undefined): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("range source proof keyset is invalid");
  }
  return value;
}

function legacySourceProof(
  preparation: PersistedCtfRangeOrderPreparation,
  proof: Proof,
  receivedAt: number,
  reservedBy?: string,
): StoredProof {
  const isCollateral = preparation.side === "Sell" && proof.id === preparation.receiveKeyset.id;
  if (
    (!isCollateral && proof.id !== preparation.offerKeyset.id) ||
    amountToNumber(proof.amount) <= 0
  ) {
    throw new Error("browser source successor differs from the offer keyset authority");
  }
  const common: StoredProof = {
    ...proof,
    mintUrl: preparation.mintUrl,
    baseAsset: "sat",
    unit: "msat" as const,
    receivedAt,
    ...(reservedBy === undefined ? {} : { reservedBy }),
  };
  const asset = isCollateral ? { kind: "regular" as const } : browserRangeSourceAsset(preparation);
  switch (asset.kind) {
    case "regular":
      return normalizeAndValidateStoredProof(common);
    case "conditional":
      return normalizeAndValidateStoredProof({
        ...common,
        conditionId: asset.conditionId,
        outcomeCollection: asset.outcomeCollection,
        marketId: `${asset.conditionId}-${asset.outcomeCollection}`,
      });
    default:
      return assertNever(asset);
  }
}

function requireCapabilityReference(
  journal: NonNullable<Awaited<ReturnType<typeof readCtfRangePreparation>>>,
) {
  if (journal.capability === null) {
    throw new Error("browser range capability authority is missing");
  }
  return {
    artifactId: journal.capability.artifactId,
    bindingDigest: journal.capability.bindingDigest,
  };
}

function requireAppliedResultAuthority(record: DurableCustodyRecord): {
  resultHandle: string;
  resultFingerprint: string;
} {
  const result = record.operation.result;
  if (
    result.state !== "verified-staged" ||
    result.resultHandle === null ||
    result.resultFingerprint === null
  ) {
    throw new Error("browser range staged result authority is incomplete");
  }
  return { resultHandle: result.resultHandle, resultFingerprint: result.resultFingerprint };
}

function validateSavedBrowserRefundDerivation(
  refund: ProofOperationRecord,
  operation: DurableCtfRangeOperation,
  seed: Uint8Array,
  keyset: import("@cashu/cashu-ts").HasKeysetKeys,
): void {
  const outputs = (refund.outputs.refund ?? []).map(deserializeDurableCustodyOutput);
  const replacedPlans = savedReplacedRefundOutputPlans(refund);
  assertDurableCtfRangeRefundRequestWitness({
    source: operation,
    request: { inputs: refund.inputs, outputs: outputs.map((output) => output.blindedMessage) },
  });
  const rebuilt = createDurableCtfRangeRefundOperation({
    operationId: refund.operationId,
    source: operation,
    refundKeysetId: keyset.id,
    resolveKeysetAsset: (id) => (id === keyset.id ? operation.offerAsset : undefined),
    outputs: outputs.map(OutputData.serialize),
  });
  const expectedMetadata = {
    ...rebuilt.operation.metadata,
    unit: "msat",
    rangeOperationId: operation.operationId,
    refundRequestFingerprint: deriveDurableCtfRangeRefundRequestFingerprint({
      inputs: refund.inputs,
      outputs: outputs.map((output) => output.blindedMessage),
    }),
    ...(Object.hasOwn(refund.metadata, "refundOutputPlan")
      ? { refundOutputPlan: refund.metadata.refundOutputPlan }
      : {}),
    ...(replacedPlans.length === 0 ? {} : { replacedRefundOutputPlans: replacedPlans }),
  };
  if (
    prepareDurableCustodyExactArtifact(expectedMetadata).fingerprint !==
    prepareDurableCustodyExactArtifact(refund.metadata).fingerprint
  )
    throw new Error("browser refund exact metadata differs");
  if (Object.hasOwn(refund.metadata, "refundOutputPlan")) {
    const plan = assertDurableSeedDerivedOutputPlanMatchesOutputs({
      plan: refund.metadata.refundOutputPlan,
      keysetId: keyset.id,
      outputs,
    });
    reconstructDurableSeedDerivedOutputs({
      seed,
      keyset,
      amounts: outputs.map((output) => amountToNumber(output.blindedMessage.amount)),
      plan,
    });
    // Each replaced plan is seed-derived on the refund keyset for the same amount.
    const total = outputs.reduce(
      (sum, output) => sum + amountToNumber(output.blindedMessage.amount),
      0,
    );
    for (const value of replacedPlans) {
      const replaced = decodeDurableSeedDerivedOutputPlan(value);
      const amounts = replaced.outputs.map((output) =>
        amountToNumber(output.blindedMessage.amount),
      );
      if (amounts.reduce((sum, amount) => sum + amount, 0) !== total)
        throw new Error("browser refund replaced plan amount differs");
      reconstructDurableSeedDerivedOutputs({ seed, keyset, amounts, plan: replaced });
    }
  } else {
    if (replacedPlans.length !== 0)
      throw new Error("browser refund legacy outputs cannot replace a plan");
    const expected = createDeterministicDurableCtfRangeRefundOutputsWithLocators({
      seed,
      source: operation,
      refundOperationId: refund.operationId,
      amount:
        operation.inputs.reduce((sum, proof) => sum + BigInt(proof.amount), 0n) -
        deriveDurableCtfRangeFeeBounds(operation).maximumFee,
      keyset,
    });
    if (
      JSON.stringify(expected.map((value) => value.output)) !==
      JSON.stringify(outputs.map(OutputData.serialize))
    )
      throw new Error("browser refund legacy outputs differ from saved authority");
  }
}

function assertExactRefundRecord(
  refund: ProofOperationRecord,
  operation: DurableCtfRangeOperation,
): void {
  const outputs = refund.outputs.refund;
  if (outputs === undefined) {
    throw new Error("browser range refund output authority is missing");
  }
  const rebuilt = createDurableCtfRangeRefundOperation({
    operationId: deriveDurableCtfRangeRefundOperationId(operation.operationId),
    source: operation,
    refundKeysetId: operation.offerKeysetId,
    resolveKeysetAsset: (keysetId) =>
      keysetId === operation.offerKeysetId ? operation.offerAsset : undefined,
    outputs: outputs.map((output) => OutputData.serialize(deserializeDurableCustodyOutput(output))),
  });
  const persistedRequest: SwapRequest = {
    inputs: refund.inputs,
    outputs: outputs.map((output) => deserializeDurableCustodyOutput(output).blindedMessage),
  };
  if (
    refund.operationId !== rebuilt.operation.operationId ||
    refund.kind !== "ctf-range-refund" ||
    refund.mintUrl !== operation.mintUrl ||
    refund.metadata.rangeOperationId !== operation.operationId ||
    refund.metadata.unit !== "msat" ||
    refund.metadata.refundRequestFingerprint !==
      deriveDurableCtfRangeRefundRequestFingerprint(persistedRequest) ||
    Object.keys(refund.outputs).join("\0") !== "refund" ||
    refund.inputs.length !== rebuilt.request.inputs.length ||
    refund.inputs.some((proof, index) => {
      const expected = rebuilt.request.inputs[index];
      return expected === undefined || !sameRefundProof(proof, expected);
    })
  ) {
    throw new Error("browser range refund differs from persisted authority");
  }
}

function sameRefundProof(observed: Proof, expected: Proof): boolean {
  return (
    observed.id === expected.id &&
    amountToNumber(observed.amount) === amountToNumber(expected.amount) &&
    observed.secret === expected.secret &&
    observed.C === expected.C &&
    (observed.p2pk_e ?? null) === (expected.p2pk_e ?? null) &&
    JSON.stringify(observed.dleq ?? null) === JSON.stringify(expected.dleq ?? null) &&
    observed.witness !== undefined
  );
}

function storedRefundOutputGroups(
  outputs: DurableCustodyProofOperationInput["outputs"],
): Record<string, StoredOutputData[]> {
  return Object.fromEntries(
    Object.entries(outputs).map(([label, values]) => [
      label,
      values.map((output) => {
        if (output.ephemeralE !== undefined) {
          throw new Error("browser range refund output has unexpected conditional material");
        }
        return {
          blindedMessage: {
            amount: amountToNumber(output.blindedMessage.amount),
            id: output.blindedMessage.id,
            B_: output.blindedMessage.B_,
          },
          blindingFactor: output.blindingFactor,
          secret: output.secret,
        };
      }),
    ]),
  );
}

function assertNever(value: never): never {
  throw new Error(`unhandled browser range variant: ${String(value)}`);
}
