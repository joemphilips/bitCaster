import type { Proof, ProofState } from "@cashu/cashu-ts";
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
import type { DurableCustodyProofOperationInput } from "@bitcaster/client-sdk/durableCustodyProofOperation";
import { bindDurableCustodyProofOperation } from "@bitcaster/client-sdk/durableCustodyProofOperationRecord";
import type { DurableCtfRangeOperation } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import {
  completeValidatedCtfRangeSourceOperation,
  prepareCtfRangeSourceOperation,
  validateCtfRangeSourceCompletionOperation,
  type CtfRangeSourceResult,
  type CtfRangeSourceWallet,
} from "@bitcaster/client-sdk/ctfRangeSourceOperation";
import {
  classifyCtfRangeSourceRecovery,
  type CtfRangeSourceRecoveryDecision,
} from "@bitcaster/client-sdk/ctfRangeSourceRecovery";
import { restoreOutputGroups, type StoredOutputData } from "@bitcaster/client-sdk/ctfSplit";
import {
  buildPersistedCtfRangeOrderPreparation,
  createCtfRangeSettlementCapabilityRequest,
  decodeSettlementCoordinatorPublicKey,
  decodeCtfRangeOrderPreparationFromRecord,
  validateAndProjectCtfRangeSettlementCapabilityResponse,
  type CtfRangeOrderRequest,
  type CtfRangeReviewedMintFacts,
  type PersistedCtfRangeOrderPreparation,
} from "@bitcaster/client-sdk/ctfRangeOrderProtocol";
import type {
  CreateSettlementCapabilityRequest,
  NostrKind1Event,
  OrderStatusResponse,
  SettlementCapabilityAdmissionPolicyResponse,
  SettlementCapabilityResponse,
  SubmitOrderRequest,
  SubmitOrderResponse,
} from "@bitcaster/client-sdk/engineClient";
import { decodeSubmitOrderResponse } from "@bitcaster/client-sdk/engineClient";
import type { CtfRangeOrderPreparationPageCursor } from "@bitcaster/client-sdk/ctfRangeOrderJournal";
import { withWalletProfileLock } from "./walletProfileLock";
import { BrowserDurableCustodyAdapter } from "../stores/durable-custody-db";
import {
  browserCustodyOperationId,
  browserCustodySelection,
  browserOwnerAt,
  browserPersistedSourceResult,
  browserRangeJournalIdentity,
  browserSourceOperationFromSnapshot,
  browserSourceProofRows,
  browserSourceResultFromSnapshot,
  browserWalletScope,
  completeBrowserRangeOperation,
  createBrowserRangeBinding,
  createBrowserRangeSourceBinding,
  requireBrowserCustodyOperation,
  requireBrowserStagedResult,
} from "./browserCtfRangeOrderSource";
import {
  bindCtfRangePreparationCapability,
  insertCtfRangePreparation,
  pageActiveCtfRangePreparations,
  transitionCtfRangePreparation,
} from "../stores/ctf-range-order-db";
import { db, type BitcasterDB } from "../stores/proof-db";

const SCOPE_LEASE_MS = 10 * 60 * 1_000;
const RECOVERY_PAGE_LIMIT_DEFAULT = 64;

type WalletLockManager = Pick<LockManager, "request">;
type BrowserCtfRangeWallet = CtfRangeSourceWallet & {
  checkProofsStates(proofs: Array<Pick<Proof, "id" | "secret">>): Promise<ProofState[]>;
};

export interface BrowserCtfRangeEngine {
  createSettlementCapability(
    request: CreateSettlementCapabilityRequest,
  ): Promise<SettlementCapabilityResponse>;
  submitOrder(marketId: string, request: SubmitOrderRequest): Promise<SubmitOrderResponse>;
  getOrderStatus(marketId: string, orderId: string): Promise<OrderStatusResponse | null>;
}

export interface BrowserCtfRangeOrderCoordinatorDependencies {
  readonly wallet: BrowserCtfRangeWallet;
  readonly engine: BrowserCtfRangeEngine;
  readonly database?: BitcasterDB;
  readonly custody?: BrowserDurableCustodyAdapter;
  readonly lockManager?: WalletLockManager;
  readonly now?: () => number;
  readonly randomId?: () => string;
  readonly allowInsecureLoopbackHttp?: boolean;
  readonly isDefinitiveOrderRejection?: (error: unknown) => boolean;
  readonly restoreOutputs?: typeof restoreOutputGroups;
}

export interface BrowserCtfRangeRecoveryPage {
  readonly recoveredOperationIds: readonly string[];
  readonly pending: readonly { operationId: string; code: BrowserCtfRangeOrderErrorCode }[];
  readonly nextCursor: CtfRangeOrderPreparationPageCursor | null;
}

export type BrowserCtfRangeOrderErrorCode =
  | "invalid-order-type"
  | "insufficient-funds"
  | "source-preparation-failed"
  | "mint-source-uncertain"
  | "custody-commit-failed"
  | "capability-creation-failed"
  | "capability-validation-failed"
  | "order-submission-rejected"
  | "order-submission-uncertain"
  | "recovery-pending";

interface AppliedSourceCommitInput {
  readonly scope: DurableCustodyScope;
  readonly authorization: DurableCustodyOwnerAuthorization;
  readonly source: DurableCustodyRecord;
  readonly binding: Awaited<ReturnType<typeof createBrowserRangeBinding>>;
  readonly successors: ReturnType<typeof browserSourceProofRows>;
  readonly resultAuthority: ReturnType<typeof requireBrowserStagedResult>;
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
  readonly #wallet: BrowserCtfRangeWallet;
  readonly #engine: BrowserCtfRangeEngine;
  readonly #database: BitcasterDB;
  readonly #custody: BrowserDurableCustodyAdapter;
  readonly #lockManager: WalletLockManager | undefined;
  readonly #now: () => number;
  readonly #randomId: () => string;
  readonly #allowInsecureLoopbackHttp: boolean;
  readonly #isDefinitiveOrderRejection: (error: unknown) => boolean;
  readonly #restoreOutputs: typeof restoreOutputGroups;

  constructor(input: BrowserCtfRangeOrderCoordinatorDependencies) {
    this.#wallet = input.wallet;
    this.#engine = input.engine;
    this.#database = input.database ?? db;
    this.#custody = input.custody ?? new BrowserDurableCustodyAdapter(this.#database);
    this.#lockManager = input.lockManager;
    this.#now = input.now ?? Date.now;
    this.#randomId = input.randomId ?? crypto.randomUUID;
    this.#allowInsecureLoopbackHttp = input.allowInsecureLoopbackHttp === true;
    this.#isDefinitiveOrderRejection = input.isDefinitiveOrderRejection ?? (() => false);
    this.#restoreOutputs = input.restoreOutputs ?? restoreOutputGroups;
  }

  async prepareAndSubmit(input: {
    readonly seed: Uint8Array;
    readonly preparation: PersistedCtfRangeOrderPreparation;
    readonly candidates: readonly Proof[];
    readonly comment?: NostrKind1Event | null;
  }): Promise<SubmitOrderResponse> {
    requireImmediateOrder(input.preparation);
    const scope = browserWalletScope(input.seed);
    return withWalletProfileLock(
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
          return this.#createCapabilityAndSubmit(
            scope.scopeId,
            input.preparation,
            completed.operation,
            completed.capabilityRequest,
            input.comment ?? null,
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
          const recoveredOperationIds: string[] = [];
          const pending: Array<{
            operationId: string;
            code: BrowserCtfRangeOrderErrorCode;
          }> = [];
          for (const record of page.preparations) {
            try {
              const recovered = await this.#recoverRecord(record, input.seed, scope, owner);
              if (recovered) recoveredOperationIds.push(record.rangeOperationId);
              else pending.push({ operationId: record.rangeOperationId, code: "recovery-pending" });
            } catch (error) {
              if (!isPendingRecoveryError(error)) throw error;
              pending.push({ operationId: record.rangeOperationId, code: error.code });
            }
          }
          return { recoveredOperationIds, pending, nextCursor: page.nextCursor };
        }),
      this.#lockManager,
    );
  }

  async #recoverRecord(
    record: Awaited<ReturnType<typeof pageActiveCtfRangePreparations>>["preparations"][number],
    seed: Uint8Array,
    scope: DurableCustodyScope,
    owner: DurableCustodyOwnerAuthorization,
  ): Promise<boolean> {
    switch (record.lifecycleState) {
      case "prepared":
        return this.#resumePreparedSource(record, seed, scope, owner);
      case "capability-bound":
        await this.#discoverBoundOrder(record);
        return false;
      case "order-submitted":
      case "submission-rejected":
        return false;
      case "terminal":
        return true;
      default:
        return assertNever(record.lifecycleState);
    }
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
        wallet: this.#wallet,
        candidates: input.candidates,
      });
    } catch {
      throw rangeError("source-preparation-failed");
    }
    if (operation === null) throw rangeError("insufficient-funds");
    const binding = await createBrowserRangeSourceBinding(scope, input.preparation, operation);
    const custodyOperationId = binding.record.operation.operationId;
    const predecessors = operation.inputs.map(
      (proof) =>
        browserSourceProofRows(
          scope,
          input.preparation,
          { authorization: [proof as Proof], keep: [] },
          this.#now(),
        )[0]!.proof,
    );
    await this.#persistPreparedSource(
      scope,
      owner,
      input.preparation,
      binding,
      custodyOperationId,
      predecessors,
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
  ): Promise<void> {
    try {
      await this.#database.transaction("rw", this.#transactionTables(true), async () => {
        await insertCtfRangePreparation(
          browserRangeJournalIdentity(scope, preparation, this.#now()),
          this.#database,
        );
        await this.#custody.transact(
          browserCustodySelection(
            scope,
            browserOwnerAt(owner, this.#now()),
            custodyOperationId,
            null,
          ),
          (transaction) =>
            bindDurableCustodyProofOperation(transaction, binding.record, binding.artifacts),
          { predecessorProofs: { [custodyOperationId]: predecessors } },
        );
      });
    } catch {
      throw rangeError("custody-commit-failed");
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
    const validatedSource = validateCtfRangeSourceCompletionOperation(source);
    const attempted = await this.#markSourceAttempted(scope, owner, sourceCustodyOperationId);
    let result: CtfRangeSourceResult;
    try {
      result = await completeValidatedCtfRangeSourceOperation(validatedSource, this.#wallet);
    } catch {
      throw rangeError("mint-source-uncertain");
    }
    const staged = await this.#stageSourceResult(scope, owner, preparation, attempted, result);
    return this.#applySourceAndBindRange(scope, owner, preparation, seed, staged, result);
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
    const sourceCustodyOperationId = browserCustodyOperationId(
      scope,
      preparation.sourceOperationId,
    );
    const snapshot = await this.#custody.readOperationSnapshot(scope, sourceCustodyOperationId);
    if (snapshot === null) throw rangeError("recovery-pending");
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
        const result = await this.#restoreExactSource(input.preparation, input.source);
        const staged = await this.#stageSourceResult(
          input.scope,
          input.owner,
          input.preparation,
          input.sourceRecord,
          result,
        );
        await this.#applySourceAndBindRange(
          input.scope,
          input.owner,
          input.preparation,
          input.seed,
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
    sourceRecord: DurableCustodyRecord;
    journalRecord: Awaited<
      ReturnType<typeof pageActiveCtfRangePreparations>
    >["preparations"][number];
    scope: DurableCustodyScope;
    owner: DurableCustodyOwnerAuthorization;
  }): Promise<void> {
    const authorization = browserOwnerAt(input.owner, this.#now());
    await this.#database.transaction("rw", this.#transactionTables(true), async () => {
      await this.#custody.transact(
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
      await transitionCtfRangePreparation(
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
      states = await this.#wallet.checkProofsStates(proofIdentities);
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
    source: DurableCustodyProofOperationInput,
  ): Promise<CtfRangeSourceResult> {
    const validatedSource = validateCtfRangeSourceCompletionOperation(source);
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
    current: DurableCustodyRecord,
    result: CtfRangeSourceResult,
  ): Promise<DurableCustodyRecord> {
    const exactResult = prepareDurableCustodyExactArtifact(browserPersistedSourceResult(result));
    const successors = browserSourceProofRows(scope, preparation, result, this.#now());
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
    const successors = browserSourceProofRows(scope, preparation, result, this.#now());
    const authorization = browserOwnerAt(owner, this.#now());
    const resultAuthority = requireBrowserStagedResult(source);
    await this.#commitAppliedSource({
      scope,
      authorization,
      source,
      binding,
      successors,
      resultAuthority,
    });
    return { operation, capabilityRequest };
  }

  async #commitAppliedSource(input: AppliedSourceCommitInput): Promise<void> {
    const outerOperationId = input.binding.record.operation.operationId;
    try {
      await this.#custody.transact(
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
    } catch {
      throw rangeError("custody-commit-failed");
    }
  }

  async #createCapabilityAndSubmit(
    scopeId: string,
    preparation: PersistedCtfRangeOrderPreparation,
    operation: DurableCtfRangeOperation,
    request: CreateSettlementCapabilityRequest,
    comment: NostrKind1Event | null,
  ): Promise<SubmitOrderResponse> {
    const capability = await this.#createVerifiedCapability(preparation, operation, request);
    const bound = await bindCtfRangePreparationCapability(
      {
        scopeId,
        rangeOperationId: preparation.operationId,
        expectedRevision: 0,
        capability,
        updatedAtMs: this.#now(),
      },
      this.#database,
    );
    return this.#submitBoundCapability(preparation, capability, bound, comment);
  }

  async #createVerifiedCapability(
    preparation: PersistedCtfRangeOrderPreparation,
    operation: DurableCtfRangeOperation,
    request: CreateSettlementCapabilityRequest,
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
        recovering: false,
      });
    } catch {
      throw rangeError("capability-validation-failed");
    }
    return capability;
  }

  async #submitBoundCapability(
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
      this.#database.custodyScopes,
      this.#database.custodyOperations,
      this.#database.custodyArtifacts,
      this.#database.custodyProofs,
      this.#database.custodyReservations,
      this.#database.custodyActiveWork,
    ] as const;
  }
}

function requireImmediateOrder(preparation: PersistedCtfRangeOrderPreparation): void {
  switch (preparation.request.timeInForce) {
    case "FAK":
    case "FOK":
      return;
    case "GTC":
      throw rangeError("invalid-order-type");
    default:
      return assertNever(preparation.request.timeInForce);
  }
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
    response.status === "awaiting_authorization" ||
    (preparation.request.timeInForce === "FOK" && response.status === "partially_filled")
  ) {
    throw new Error("engine returned an invalid immediate order response");
  }
  return response;
}

function rangeError(code: BrowserCtfRangeOrderErrorCode): BrowserCtfRangeOrderError {
  const messages: Record<BrowserCtfRangeOrderErrorCode, string> = {
    "invalid-order-type": "The browser supports only immediate FAK or FOK range orders.",
    "insufficient-funds": "The wallet has insufficient selectable funds for this order.",
    "source-preparation-failed": "The wallet could not prepare the range authorization.",
    "mint-source-uncertain": "The mint result is uncertain. Funds recovery is pending.",
    "custody-commit-failed": "The wallet could not commit the durable range operation.",
    "capability-creation-failed": "The engine did not create a settlement capability.",
    "capability-validation-failed": "The engine returned an invalid settlement capability.",
    "order-submission-rejected": "The engine rejected the order. It will not retry.",
    "order-submission-uncertain": "The order acknowledgement is uncertain. It will not retry.",
    "recovery-pending": "The durable range operation still requires funds recovery.",
  };
  return new BrowserCtfRangeOrderError(code, messages[code]);
}

function isPendingRecoveryError(error: unknown): error is BrowserCtfRangeOrderError & {
  code: "mint-source-uncertain" | "recovery-pending";
} {
  return (
    error instanceof BrowserCtfRangeOrderError &&
    (error.code === "mint-source-uncertain" || error.code === "recovery-pending")
  );
}

function requireSourceKeysetId(value: string | undefined): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("range source proof keyset is invalid");
  }
  return value;
}

function assertNever(value: never): never {
  throw new Error(`unhandled browser range variant: ${String(value)}`);
}
