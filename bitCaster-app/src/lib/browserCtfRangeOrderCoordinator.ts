import {
  Mint as CashuMint,
  OutputData,
  type CounterSource,
  type Proof,
  type ProofState,
  type SerializedBlindedSignature,
  type SwapRequest,
  type SwapPreview,
} from "@cashu/cashu-ts";
import {
  prepareDurableCustodyExactArtifact,
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
  deriveDurableCtfRangeFeeBounds,
  deriveDurableCtfRangeRefundOperationId,
  deriveDurableCtfRangeRefundRequestFingerprint,
  matchDeterministicDurableCtfRangeRefundProofLocators,
  prepareDurableCtfRangeRecoveredResult,
  prepareDurableCtfRangeVerifiedResult,
  recoverDurableCtfRangeVerifiedResultArtifact,
  type DurableCtfRangeOperation,
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
  prepareCtfRangeSourceOperation,
  validateCtfRangeSourceCompletionOperation,
  type CtfRangeSourceResult,
  type CtfRangeSourceWallet,
} from "@bitcaster/client-sdk/ctfRangeSourceOperation";
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
  settlementCapabilityV1WorkFacts,
  validateAndProjectCtfRangeSettlementCapabilityResponse,
  type CtfRangeOrderRequest,
  type CtfRangeReviewedMintFacts,
  type PersistedCtfRangeOrderPreparation,
} from "@bitcaster/client-sdk/ctfRangeOrderProtocol";
import { calculateSettlementCapabilityV1Tariff } from "@bitcaster/client-sdk/participationScore";
import type {
  CreateSettlementCapabilityRequest,
  NostrKind1Event,
  OrderStatusResponse,
  SettlementCapabilityResultResponse,
  SettlementCapabilityAdmissionPolicyResponse,
  SettlementCapabilityResponse,
  SubmitOrderRequest,
  SubmitOrderResponse,
} from "@bitcaster/client-sdk/engineClient";
import { decodeSubmitOrderResponse } from "@bitcaster/client-sdk/engineClient";
import type { WalletId } from "@bitcaster/client-sdk/durableCustody";
import type { CtfRangeOrderPreparationPageCursor } from "@bitcaster/client-sdk/ctfRangeOrderJournal";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import { withWalletProfileLock } from "./walletProfileLock";
import { BrowserDurableCustodyAdapter } from "../stores/durable-custody-db";
import {
  browserCustodyOperationId,
  browserSourceCustodyOperationId,
  browserSourceCompletionProofRows,
  browserCustodySelection,
  browserOwnerAt,
  browserPersistedSourceResult,
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
import { createBrowserWalletCounterSource } from "../stores/wallet";
import {
  bindCtfRangePreparationCapability,
  appendCtfRangePreparationConsolidationInTransaction,
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
  submitOrder(marketId: string, request: SubmitOrderRequest): Promise<SubmitOrderResponse>;
  getOrderStatus(marketId: string, orderId: string): Promise<OrderStatusResponse | null>;
  getSettlementCapabilityResultByOperation(
    operationId: string,
  ): Promise<SettlementCapabilityResultResponse | null>;
  acknowledgeSettlementCapabilityResult(
    resultId: string,
    request: { expectedVersion: number },
  ): Promise<SettlementCapabilityResultResponse | null>;
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
  readonly createCounterSource?: (scopeId: string, mintUrl: string, unit: string) => CounterSource;
}

export interface BrowserCtfRangeRecoveryPage {
  readonly recoveredOperationIds: readonly string[];
  readonly pending: readonly {
    operationId: string;
    revision: number;
    code: BrowserCtfRangeOrderErrorCode;
  }[];
  readonly nextCursor: CtfRangeOrderPreparationPageCursor | null;
}

export const BROWSER_CTF_RANGE_ORDER_ERROR_CODES = [
  "invalid-order-type",
  "insufficient-funds",
  "asset-recovery-failed",
  "source-preparation-failed",
  "mint-source-uncertain",
  "custody-commit-failed",
  "capability-creation-failed",
  "capability-validation-failed",
  "order-submission-rejected",
  "order-submission-uncertain",
  "recovery-pending",
] as const;

export type BrowserCtfRangeOrderErrorCode = (typeof BROWSER_CTF_RANGE_ORDER_ERROR_CODES)[number];

interface AppliedSourceCommitInput {
  readonly scope: DurableCustodyScope;
  readonly authorization: DurableCustodyOwnerAuthorization;
  readonly source: DurableCustodyRecord;
  readonly sourceOperation: DurableCustodyProofOperationInput;
  readonly binding: Awaited<ReturnType<typeof createBrowserRangeBinding>>;
  readonly successors: ReturnType<typeof browserSourceProofRows>;
  readonly resultAuthority: ReturnType<typeof requireBrowserStagedResult>;
  readonly preparation: PersistedCtfRangeOrderPreparation;
  readonly result: CtfRangeSourceResult;
}

export class BrowserCtfRangeOrderError extends Error {
  readonly code: BrowserCtfRangeOrderErrorCode;

  constructor(code: BrowserCtfRangeOrderErrorCode, message: string) {
    super(message);
    this.name = "BrowserCtfRangeOrderError";
    this.code = code;
  }
}

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
  });
}

export class BrowserCtfRangeOrderCoordinator {
  readonly #walletForMint: (mintUrl: string) => Promise<BrowserCtfRangeWallet>;
  readonly #engine: BrowserCtfRangeEngine;
  readonly #beforeCreateCapability: NonNullable<
    BrowserCtfRangeOrderCoordinatorDependencies["beforeCreateCapability"]
  >;
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
  readonly #createCounterSource: (scopeId: string, mintUrl: string, unit: string) => CounterSource;

  constructor(input: BrowserCtfRangeOrderCoordinatorDependencies) {
    const wallet = input.wallet;
    this.#walletForMint =
      typeof wallet === "function" ? async (mintUrl) => wallet(mintUrl) : async () => wallet;
    this.#engine = input.engine;
    this.#beforeCreateCapability = input.beforeCreateCapability ?? (async () => {});
    this.#database = input.database ?? db;
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
      input.executeRefundSwap ?? ((mintUrl, request) => new CashuMint(mintUrl).swap(request));
    this.#createCounterSource = input.createCounterSource ?? createBrowserWalletCounterSource;
  }

  async prepareAndSubmit(input: {
    readonly seed: Uint8Array;
    readonly preparation: PersistedCtfRangeOrderPreparation;
    readonly candidates: readonly Proof[];
    readonly comment?: NostrKind1Event | null;
  }): Promise<SubmitOrderResponse> {
    requireFokRequest(input.preparation.request);
    const scope = browserWalletScope(input.seed);
    const completed = await withWalletProfileLock(
      scope.scopeId,
      () =>
        this.#withScopeOwner(scope, async (owner) => {
          const source = await this.#prepareAndPersistSource(input, scope, owner);
          const completed = await this.#completeAndBindSource(
            input.preparation,
            input.seed,
            source.operation,
            source.custodyOperationId,
            scope,
            owner,
          );
          return completed;
        }),
      this.#lockManager,
    );
    await this.#beforeCreateCapability({
      mintUrl: input.preparation.mintUrl,
      requiredScore: calculateSettlementCapabilityV1Tariff(
        settlementCapabilityV1WorkFacts(completed.operation),
      ),
    });
    return withWalletProfileLock(
      scope.scopeId,
      () =>
        this.#withScopeOwner(scope, () =>
          this.#createCapabilityAndSubmit(
            scope,
            input.preparation,
            completed.operation,
            completed.capabilityRequest,
            input.comment ?? null,
          ),
        ),
      this.#lockManager,
    );
  }

  async consolidateRound(input: {
    readonly seed: Uint8Array;
    readonly preparation: PersistedCtfRangeOrderPreparation;
    readonly round: number;
    readonly inputs: readonly Proof[];
    readonly plannedRound: ProofConsolidationRound;
  }): Promise<void> {
    const scope = browserWalletScope(input.seed);
    await withWalletProfileLock(
      scope.scopeId,
      () =>
        this.#withScopeOwner(scope, async (owner) => {
          const binding = await this.#prepareAndPersistConsolidation(input, scope, owner);
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
  }): Promise<Pick<BrowserCtfRangeRecoveryPage, "recoveredOperationIds" | "pending">> {
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
          if (record === null) return { recoveredOperationIds: [], pending: [] };
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
  ): Promise<Pick<BrowserCtfRangeRecoveryPage, "recoveredOperationIds" | "pending">> {
    const recoveredOperationIds: string[] = [];
    const pending: Array<{
      operationId: string;
      revision: number;
      code: BrowserCtfRangeOrderErrorCode;
    }> = [];
    for (const record of records) {
      try {
        const recovered = await this.#recoverRecord(record, seed, scope, owner);
        if (recovered) recoveredOperationIds.push(record.rangeOperationId);
        else {
          const current = await this.#currentPreparation(record);
          pending.push({
            operationId: record.rangeOperationId,
            revision: current.revision,
            code: "recovery-pending",
          });
        }
      } catch (error) {
        if (!(error instanceof BrowserCtfRangeOrderError)) throw error;
        const current = await this.#currentPreparation(record);
        pending.push({
          operationId: record.rangeOperationId,
          revision: current.revision,
          code: error.code,
        });
      }
    }
    return { recoveredOperationIds, pending };
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
  ): Promise<boolean> {
    requireFokRequest(decodeCtfRangeOrderPreparationFromRecord(record).request);
    switch (record.lifecycleState) {
      case "prepared": {
        const sourceReleased = await this.#resumePreparedSource(record, seed, scope, owner);
        if (sourceReleased) return true;
        break;
      }
      case "capability-requested":
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
        return true;
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
  ): Promise<boolean> {
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
        scope,
        owner,
        snapshot.record,
        operation,
      );
      return true;
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
      return true;
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
          return true;
        default:
          return assertNever(decision);
      }
    }
    if (prepared === null || prepared.kind !== "confirmed") throw rangeError("recovery-pending");
    await this.#commitRecoveredOuterResult(
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
    return true;
  }

  async #resumePersistedOuterResult(
    journalRecord: NonNullable<Awaited<ReturnType<typeof readCtfRangePreparation>>>,
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
      await this.#applyRecoveredOuterResult(scope, owner, record, operation, result);
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
    },
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
  ): Promise<ReturnType<typeof createBrowserRangeConsolidationBinding>> {
    const operationId = `${input.preparation.sourceOperationId}:consolidation:${input.round}`;
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
        counterSource: this.#createCounterSource(
          scope.scopeId,
          input.preparation.mintUrl,
          input.preparation.offerKeyset.unit,
        ),
        wallet: await this.#walletForMint(input.preparation.mintUrl),
      });
    } catch (error) {
      throw rangeError("source-preparation-failed", error);
    }
    const binding = createBrowserRangeConsolidationBinding(scope, input.preparation, operation);
    await this.#persistPreparedConsolidation(scope, owner, input.preparation, input.round, binding);
    return binding;
  }

  async #persistPreparedConsolidation(
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
    preparation: PersistedCtfRangeOrderPreparation,
    round: number,
    binding: ReturnType<typeof createBrowserRangeConsolidationBinding>,
  ): Promise<void> {
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
      await this.#database.transaction("rw", this.#transactionTables(true), async (tx) => {
        await insertCtfRangePreparationInTransaction(
          tx,
          await this.#journalIdentity(scope, preparation),
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
      });
    } catch (error) {
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
      proofs = await completeCtfRangeConsolidationOperation(
        operation,
        await this.#walletForMint(preparation.mintUrl),
      );
    } catch (error) {
      throw rangeError("mint-source-uncertain", error);
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
    return Math.max(
      observedAtMs,
      ...rows.map((row) => row?.receivedAtMs ?? 0),
      ...authorities.map((authority) => authority?.updatedAtMs ?? 0),
    );
  }

  async #journalIdentity(
    scope: DurableCustodyScope,
    preparation: PersistedCtfRangeOrderPreparation,
  ) {
    const existing = await readCtfRangePreparation(
      scope.scopeId,
      preparation.operationId,
      this.#database,
    );
    return browserRangeJournalIdentity(scope, preparation, existing?.createdAtMs ?? this.#now());
  }

  async #prepareAndPersistSource(
    input: {
      readonly seed: Uint8Array;
      readonly preparation: PersistedCtfRangeOrderPreparation;
      readonly candidates: readonly Proof[];
    },
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
  ): Promise<{
    operation: DurableCustodyProofOperationInput;
    custodyOperationId: string;
  }> {
    let operation: DurableCustodyProofOperationInput | null;
    try {
      operation = await prepareCtfRangeSourceOperation({
        preparation: input.preparation,
        seed: input.seed,
        counterSource: this.#createCounterSource(
          scope.scopeId,
          input.preparation.mintUrl,
          input.preparation.offerKeyset.unit,
        ),
        wallet: await this.#walletForMint(input.preparation.mintUrl),
        candidates: input.candidates,
      });
    } catch (error) {
      throw rangeError("source-preparation-failed", error);
    }
    if (operation === null) throw rangeError("insufficient-funds");
    const binding = await createBrowserRangeSourceBinding(
      scope,
      input.preparation,
      input.seed,
      operation,
    );
    const custodyOperationId = binding.record.operation.operationId;
    const stagedPredecessors = operation.inputs.map(
      (proof) =>
        browserSourceProofRows(
          scope,
          input.preparation,
          { authorization: [proof as Proof], keep: [] },
          this.#now(),
        )[0]!,
    );
    const predecessors = stagedPredecessors.map(({ proof }) => proof);
    await this.#persistPreparedSource(
      scope,
      owner,
      input.preparation,
      binding,
      custodyOperationId,
      predecessors,
      stagedPredecessors,
      operation.inputs,
    );
    return { operation, custodyOperationId };
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
  ): Promise<void> {
    try {
      await this.#database.transaction("rw", this.#transactionTables(true), async (tx) => {
        await insertCtfRangePreparationInTransaction(
          tx,
          await this.#journalIdentity(scope, preparation),
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
      });
    } catch (error) {
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
    const validatedSource = validateCtfRangeSourceCompletionOperation(source, {
      seed,
      keyset: preparation.offerKeyset,
    });
    const attempted = await this.#markSourceAttempted(scope, owner, sourceCustodyOperationId);
    let result: CtfRangeSourceResult;
    try {
      result = await completeValidatedCtfRangeSourceOperation(
        validatedSource,
        await this.#walletForMint(preparation.mintUrl),
      );
    } catch (error) {
      throw rangeError("mint-source-uncertain", error);
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
    switch (snapshot.record.operation.result.state) {
      case "none":
        return this.#recoverUncertainSource({
          preparation,
          seed,
          source,
          sourceRecord: snapshot.record,
          journalRecord,
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
    const decision = await this.#classifyUncertainConsolidation(preparation, operation);
    let proofs: readonly Proof[];
    switch (decision.kind) {
      case "replay-exact-persisted-operation":
        try {
          await this.#markConsolidationAttempted(scope, owner, operationId);
          proofs = await completeCtfRangeConsolidationOperation(
            operation,
            await this.#walletForMint(preparation.mintUrl),
          );
        } catch (error) {
          throw rangeError("recovery-pending", error);
        }
        break;
      case "restore-exact-persisted-outputs": {
        let restored: Record<string, Proof[]>;
        try {
          restored = await this.#restoreOutputs(
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
          proofs = validateCtfRangeConsolidationProofs(operation, restored.consolidated);
        } catch (error) {
          throw rangeError("recovery-pending", error);
        }
        break;
      }
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
  ): Promise<CtfRangeSourceRecoveryDecision> {
    let states: ProofState[];
    try {
      states = await (
        await this.#walletForMint(preparation.mintUrl)
      ).checkProofsStates(
        operation.inputs.map(({ id, secret }) => ({ id: requireSourceKeysetId(id), secret })),
      );
    } catch {
      throw rangeError("recovery-pending");
    }
    return classifyCtfRangeSourceRecovery({
      journalKind: "consolidation",
      journalState: "prepared",
      inputStates: states.map(({ state }) => state),
      now: Math.floor(this.#now() / 1_000),
    });
  }

  async #recoverUncertainSource(input: {
    preparation: PersistedCtfRangeOrderPreparation;
    seed: Uint8Array;
    source: DurableCustodyProofOperationInput;
    sourceRecord: DurableCustodyRecord;
    journalRecord: Awaited<
      ReturnType<typeof pageActiveCtfRangePreparations>
    >["preparations"][number];
    sourceCustodyOperationId: string;
    scope: DurableCustodyScope;
    owner: DurableCustodyOwnerAuthorization;
  }): Promise<boolean> {
    const decision = await this.#classifyUncertainSource(input.preparation, input.source);
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
      case "release-exact-unspent-inputs":
        await this.#releaseExpiredSource(input);
        return true;
      case "remain-pending":
        throw rangeError("recovery-pending");
      case "reuse-completed":
      case "fail":
        throw new Error("range source recovery journal state is inconsistent");
      default:
        return assertNever(decision);
    }
  }

  async #releaseExpiredSource(input: {
    source: DurableCustodyProofOperationInput;
    sourceRecord: DurableCustodyRecord;
    journalRecord: Awaited<
      ReturnType<typeof pageActiveCtfRangePreparations>
    >["preparations"][number];
    scope: DurableCustodyScope;
    owner: DurableCustodyOwnerAuthorization;
  }): Promise<void> {
    const authorization = browserOwnerAt(input.owner, this.#now());
    await this.#database.transaction("rw", this.#transactionTables(true), async (tx) => {
      await this.#custody.transactInCurrentTransaction(
        tx,
        browserCustodySelection(
          input.scope,
          authorization,
          input.sourceRecord.operation.operationId,
          input.sourceRecord.revision,
        ),
        (transaction) =>
          transaction.transitionOperation({
            operationId: input.sourceRecord.operation.operationId,
            expectedRevision: input.sourceRecord.revision,
            transition: {
              kind: "release-unspent-reservation",
              authorization,
              expectedRevision: input.sourceRecord.revision,
            },
          }),
      );
      await this.#releaseLegacySourceProofs(input.source);
      await transitionCtfRangePreparationInTransaction(
        tx,
        {
          scopeId: input.journalRecord.scopeId,
          rangeOperationId: input.journalRecord.rangeOperationId,
          expectedRevision: input.journalRecord.revision,
          from: "prepared",
          to: "terminal",
          updatedAtMs: authorization.observedAtMs,
        },
        this.#database,
      );
    });
  }

  async #classifyUncertainSource(
    preparation: PersistedCtfRangeOrderPreparation,
    source: DurableCustodyProofOperationInput,
  ): Promise<CtfRangeSourceRecoveryDecision> {
    const proofIdentities = source.inputs.map(({ id, secret }) => ({
      id: requireSourceKeysetId(id),
      secret,
    }));
    let states: ProofState[];
    try {
      states = await (
        await this.#walletForMint(preparation.mintUrl)
      ).checkProofsStates(proofIdentities);
    } catch {
      throw rangeError("recovery-pending");
    }
    return classifyCtfRangeSourceRecovery({
      journalKind: "authorization-source",
      journalState: "prepared",
      inputStates: states.map(({ state }) => state),
      now: Math.floor(this.#now() / 1_000),
      authorizationExpiry: preparation.expiry,
    });
  }

  async #restoreExactSource(
    preparation: PersistedCtfRangeOrderPreparation,
    seed: Uint8Array,
    source: DurableCustodyProofOperationInput,
  ): Promise<CtfRangeSourceResult> {
    const validatedSource = validateCtfRangeSourceCompletionOperation(source, {
      seed,
      keyset: preparation.offerKeyset,
    });
    const outputs = structuredClone(validatedSource.operation.outputs) as Record<
      string,
      StoredOutputData[]
    >;
    let restored: Record<string, Proof[]>;
    try {
      restored = await this.#restoreOutputs(preparation.mintUrl, outputs);
    } catch {
      throw rangeError("recovery-pending");
    }
    if (Object.keys(restored).some((label) => label !== "authorization" && label !== "keep")) {
      throw new Error("range source restore returned a foreign proof group");
    }
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
    result: CtfRangeSourceResult,
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
    result: CtfRangeSourceResult,
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
    return this.#submitBoundCapability(scope, preparation, capability, bound, comment);
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
    let response: SettlementCapabilityResponse;
    try {
      response = await this.#engine.createSettlementCapability(request);
    } catch {
      throw rangeError("capability-creation-failed");
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
  ): Promise<SubmitOrderResponse> {
    let submitted: SubmitOrderResponse;
    try {
      submitted = await this.#engine.submitOrder(preparation.request.marketId, {
        settlementCapability: {
          artifactId: capability.artifactId,
          bindingDigest: capability.bindingDigest,
        },
        comment,
        walletId: scope.walletId as WalletId,
      });
    } catch (error) {
      if (!this.#isDefinitiveOrderRejection(error)) {
        throw rangeError("order-submission-uncertain");
      }
      try {
        await this.#markSubmissionRejected(bound);
      } catch {
        throw rangeError("order-submission-uncertain");
      }
      throw rangeError("order-submission-rejected");
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

  async #startOuterRefund(
    journalRecord: NonNullable<Awaited<ReturnType<typeof readCtfRangePreparation>>>,
    seed: Uint8Array,
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
    record: DurableCustodyRecord,
    operation: DurableCtfRangeOperation,
  ): Promise<void> {
    await this.#requireSubmittedFokRefundSafe(journalRecord);
    const preparation = decodeCtfRangeOrderPreparationFromRecord(journalRecord);
    const refundAmount =
      operation.inputs.reduce((total, proof) => total + BigInt(proof.amount), 0n) -
      deriveDurableCtfRangeFeeBounds(operation).maximumFee;
    if (refundAmount <= 0n) throw new Error("browser range refund is fee-dominated");
    const operationId = deriveDurableCtfRangeRefundOperationId(operation.operationId);
    const deterministicOutputs = createDeterministicDurableCtfRangeRefundOutputsWithLocators({
      seed,
      source: operation,
      refundOperationId: operationId,
      amount: refundAmount,
      keyset: { id: preparation.offerKeyset.id, keys: preparation.offerKeyset.keys },
    });
    const prepared = createDurableCtfRangeRefundOperation({
      operationId,
      source: operation,
      refundKeysetId: preparation.offerKeyset.id,
      resolveKeysetAsset: (keysetId) =>
        keysetId === preparation.offerKeyset.id ? operation.offerAsset : undefined,
      outputs: deterministicOutputs.map(({ output }) => output),
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
      },
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.#database.transaction("rw", this.#database.proofOperations, async () => {
      const existing = await this.#database.proofOperations.get(operationId);
      if (existing !== undefined) throw new Error("browser range refund identity already exists");
      await this.#database.proofOperations.add(refund);
    });
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

  async #resumeOuterRefund(
    journalRecord: NonNullable<Awaited<ReturnType<typeof readCtfRangePreparation>>>,
    seed: Uint8Array,
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
    record: DurableCustodyRecord,
    operation: DurableCtfRangeOperation,
    refund: ProofOperationRecord,
    orderStatusChecked = false,
  ): Promise<void> {
    if (!orderStatusChecked) await this.#requireSubmittedFokRefundSafe(journalRecord);
    assertExactRefundRecord(refund, operation);
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
        let response: { signatures: SerializedBlindedSignature[] };
        try {
          response = await this.#executeRefundSwap(refund.mintUrl, {
            inputs: refund.inputs,
            outputs: outputs.map(({ blindedMessage }) => blindedMessage),
          });
        } catch (error) {
          throw rangeError("recovery-pending", error);
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
        const refundOutputs = refund.outputs.refund;
        if (refundOutputs === undefined) {
          throw new Error("browser range refund output authority is missing");
        }
        const preparation = decodeCtfRangeOrderPreparationFromRecord(journalRecord);
        proofs = await this.#pendingOnRecoveryTransport(() =>
          this.#restoreRefundOutputs({
            mintUrl: refund.mintUrl,
            outputs: refundOutputs,
            record,
            operation,
            keyset: preparation.offerKeyset,
          }),
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
    const deterministicOutputs = createDeterministicDurableCtfRangeRefundOutputsWithLocators({
      seed,
      source: operation,
      refundOperationId: refund.operationId,
      amount:
        operation.inputs.reduce((total, proof) => total + BigInt(proof.amount), 0n) -
        deriveDurableCtfRangeFeeBounds(operation).maximumFee,
      keyset: { id: preparation.offerKeyset.id, keys: preparation.offerKeyset.keys },
    });
    const custodyProofs = browserRangeRefundProofRows(
      record,
      operation,
      proofs,
      matchDeterministicDurableCtfRangeRefundProofLocators({
        outputs: deterministicOutputs,
        proofs,
      }),
      authorization.observedAtMs,
    );
    await this.#database.transaction("rw", this.#transactionTables(true), async (tx) => {
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
    await this.#applyRecoveredOuterResult(scope, owner, current, operation, result);
  }

  async #applyRecoveredOuterResult(
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
    record: DurableCustodyRecord,
    operation: DurableCtfRangeOperation,
    result: DurableCtfRangeRecoveredResult,
  ): Promise<void> {
    const authorization = browserOwnerAt(owner, this.#now());
    const resultAuthority = requireAppliedResultAuthority(record);
    const successors = browserRangeSuccessorProofRows(
      record,
      operation,
      result,
      authorization.observedAtMs,
    );
    const legacySuccessors = browserRangeStoredProofs(
      operation,
      result,
      authorization.observedAtMs,
    );
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
    result: CtfRangeSourceResult,
    receivedAtMs: number,
  ): Promise<void> {
    const inputSecrets = source.inputs.map(({ secret }) => secret);
    const authorization = result.authorization.map((proof) =>
      legacySourceProof(preparation, proof, receivedAtMs, rangeCustodyOperationId),
    );
    const keep = result.keep.map((proof) => legacySourceProof(preparation, proof, receivedAtMs));
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

  async #releaseLegacySourceProofs(source: DurableCustodyProofOperationInput): Promise<void> {
    const rows = await this.#database.proofs.bulkGet(source.inputs.map(({ secret }) => secret));
    await this.#database.proofs.bulkPut(
      rows.flatMap((row) => {
        if (!row) return [];
        const { reservedBy: _reservedBy, ...released } = row;
        return [released];
      }),
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

function requireImmediateSubmitResponse(
  response: SubmitOrderResponse,
  preparation: PersistedCtfRangeOrderPreparation,
  expectedOrderId: string,
): SubmitOrderResponse {
  if (
    response.orderId !== expectedOrderId ||
    response.baseAsset !== preparation.request.baseAsset ||
    response.divisibility !== preparation.divisibility ||
    response.remainingAmountSubunits !== 0 ||
    response.status === "resting" ||
    response.status === "partially_filled"
  ) {
    throw new Error("engine returned an invalid immediate order response");
  }
  return response;
}

function rangeError(
  code: BrowserCtfRangeOrderErrorCode,
  cause?: unknown,
): BrowserCtfRangeOrderError {
  const error = new BrowserCtfRangeOrderError(code, browserCtfRangeOrderErrorMessage(code));
  if (cause !== undefined) Object.defineProperty(error, "cause", { value: cause });
  return error;
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
    "asset-recovery-failed": "The wallet could not recover the exact funds for this order.",
    "source-preparation-failed": "The wallet could not prepare the range authorization.",
    "mint-source-uncertain": "The mint result is uncertain. Funds recovery is pending.",
    "custody-commit-failed": "The wallet could not commit the durable range operation.",
    "capability-creation-failed": "The engine did not create a settlement capability.",
    "capability-validation-failed": "The engine returned an invalid settlement capability.",
    "order-submission-rejected": "The engine rejected the order. It will not retry.",
    "order-submission-uncertain": "The order acknowledgement is uncertain. It will not retry.",
    "recovery-pending": "The durable range operation still requires funds recovery.",
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
  if (proof.id !== preparation.offerKeyset.id || amountToNumber(proof.amount) <= 0) {
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
  const asset = browserRangeSourceAsset(preparation);
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
