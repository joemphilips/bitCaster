import type { Proof } from "@cashu/cashu-ts";
import Dexie from "dexie";
import type { CtfRedeemMintSubmissionBinding } from "@bitcaster/client-sdk/ctfSplit";
import {
  deriveDurableCustodyArtifactFingerprint,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyRecord,
  type DurableCustodyState,
  type DurableProofOperationFacts,
  type DurableCustodyTransaction,
} from "@bitcaster/client-sdk/durableCustody";
import {
  createDurableBearerSpendDeliveryRecord,
  isDurableBearerSpendTokenPresentable,
  planDurableBearerSpendCustodyHandoff,
  requireDurableBearerSpendOriginalProofLineage,
} from "@bitcaster/client-sdk/durableBearerSpendDelivery";
import { requireExactDurableWalletSendToken } from "@bitcaster/client-sdk/durableWalletSendDelivery";
import {
  resolveDurableCustodyProofOperationFacts,
  type DurableCustodyProofOperationInput,
} from "@bitcaster/client-sdk/durableCustodyProofOperation";
import {
  bindDurableCustodyProofOperation,
  createDurableCustodyProofOperation,
  deriveDurableCustodyProofOperationFingerprints,
  deriveDurableCustodyProofResultFingerprint,
} from "@bitcaster/client-sdk/durableCustodyProofOperationRecord";
import { normalizeUrl } from "../lib/url";
import {
  COLLATERAL_UNIT_REGISTRY,
  parseCashuProofUnit,
} from "@bitcaster/client-sdk/marketUnits";
import {
  assertDurableWalletProofResultMatchesPlan,
  durableWalletPassthroughProofs,
  requireDurableWalletProofTransition,
} from "@bitcaster/client-sdk/durableWalletProofTransition";
import type { DurableWalletOperationRecoveryDecision } from "@bitcaster/client-sdk/durableWalletOperation";
import { sameValue } from "./durable-custody-dexie-model";
import { decodeOperationRow } from "./durable-custody-dexie-model";
import {
  acquireGuiCustodyAuthority,
  guiWalletContextFromHeldLock,
  guiWalletContextForWallet,
  releaseGuiCustodyAuthority,
  resolveGuiCustodyMintKeys,
  withGuiCustodyProfileLockForWallet,
  type GuiWalletContext,
} from "./gui-custody-authority";
import type { GuiWalletLockContext } from "./gui-wallet-lock";
import { prepareGuiCustodyTransition } from "./gui-proof-operation-custody";
import {
  assertSameStoredProofAuthority,
  requireGuiNativeProofInputAuthority,
  requireGuiNativeInputProofs,
  reserveGuiNativeInputProofs,
} from "./gui-native-proof-custody";
import {
  prepareGuiCustodyUnitOfWork,
  readGuiCustodyOperationSnapshot,
  readGuiCustodyNativeSnapshot,
  type GuiCustodyNativeSnapshot,
  type GuiBearerSpendCustodyHandoff,
} from "./gui-custody-unit-of-work";
import { commitGuiHeadroomCustodyUnitOfWork } from "./gui-durable-storage-headroom-custody-unit-of-work";
import {
  currentGuiWalletId,
  db,
  ensureDurableSwapStorage,
  locateStoredProofs,
  normalizeStoredProofForStorage,
  proofOperationPrimaryKey,
  requireProofOperationRecord,
  requireStoredProofRow,
  storedProofIds,
  type PrepareProofOperationInput,
  type ProofOperationRecord,
  type StoredProof,
} from "./proof-db";
import {
  projectCompletedGuiDepositActivity,
  type WalletActivityRow,
} from "./wallet-activity-projection";
import {
  readGuiWalletSendDeliveryMetadata,
  createGuiWalletSendDeliveryReservationRow,
  createGuiWalletSendDeliveryPayloadRow,
  guiWalletSendTokenFingerprint,
  requireGuiWalletSendDeliveryPayloadRow,
  requireExactGuiWalletSendUserExportToken,
  type GuiWalletSendDeliveryPayloadRow,
  type GuiWalletSendDeliveryReservationRow,
} from "./gui-wallet-send-delivery";
import {
  createGuiBearerSpendDeliveryRow,
  requireGuiBearerSpendDeliveryRow,
  type GuiBearerSpendDeliveryRow,
} from "./gui-bearer-spend-delivery";

const ORACLE_NOT_ATTESTED_OUTCOME_CODE = 13015;
const REGISTRATION_FEE_REJECTION_CODES = new Set([13044, 13047]);
const EXPIRED_UNSUBMITTED_MINT_FAILURE_CODE = 408;
const EXPIRED_UNSUBMITTED_MINT_MESSAGE =
  "Lightning mint quote expired before transport";

interface NativeProofDelta {
  deleteProofs?: StoredProof[];
  nextProofs?: StoredProof[];
}

interface ResolvedWalletOperationPlan {
  walletId: string;
  input: PrepareProofOperationInput;
  operationInput: DurableCustodyProofOperationInput;
  facts: DurableProofOperationFacts;
  custodyFingerprint: string;
}

export interface GuiProofOperationMintSubmissionClaim {
  record: ProofOperationRecord;
  claimed: boolean;
}

export async function getPendingGuiWalletSendDeliveryForWallet(
  walletId: string,
): Promise<(ProofOperationRecord & { encodedUserExportToken: string }) | null> {
  return withRequiredGuiCustodyLockForWallet(walletId, async (context) => {
    await ensureDurableSwapStorage(walletId);
    const rawBearer = await db.bearerSpendDeliveries
      .where("[walletId+presentable+createdAtMs+deliveryId]")
      .between(
        [walletId, 1, 0, Dexie.minKey],
        [walletId, 1, Number.MAX_SAFE_INTEGER, Dexie.maxKey],
      )
      .first();
    if (!rawBearer) return null;
    const bearer = requireGuiBearerSpendDeliveryRow(rawBearer, walletId);
    const rawPayload = await db.walletSendDeliveryPayloads
      .where("[walletId+custodyOperationId]")
      .equals([walletId, bearer.parentOperationId])
      .first();
    if (!rawPayload) {
      throw new Error("GUI wallet send pending payload is missing");
    }
    const payload = requireGuiWalletSendDeliveryPayloadRow(
      rawPayload,
      walletId,
    );
    const [canonicalRow, operationRow] = await Promise.all([
      db.custodyOperations.get(payload.custodyOperationId),
      db.proofOperations.get(
        proofOperationPrimaryKey(walletId, payload.operationId),
      ),
    ]);
    if (!canonicalRow) {
      throw new Error("GUI wallet send canonical delivery is missing");
    }
    const custody = decodeOperationRow(canonicalRow, context.scope);
    const operation = requireProofOperationRecord(
      operationRow,
      walletId,
      payload.operationId,
    );
    const delivery = requireWalletSendPresentation(
      custody,
      operation,
      payload,
      bearer,
    );
    return {
      ...operation,
      encodedUserExportToken: delivery.encodedToken,
    };
  });
}

/**
 * Reads both physical representations of one native wallet operation under the
 * captured-wallet lock and proves that their exact completed result agrees.
 */
export async function requireCompletedGuiWalletProofOperationAuthorityUnderLock(
  lock: GuiWalletLockContext,
  operationId: string,
): Promise<ProofOperationRecord> {
  const context = guiWalletContextFromHeldLock(lock);
  await ensureDurableSwapStorage(context.walletId);
  return db.transaction(
    "r",
    db.proofOperations,
    db.custodyOperations,
    db.walletSendDeliveryPayloads,
    db.bearerSpendDeliveries,
    db.proofs,
    async () => {
      const operationRow = await db.proofOperations.get(
        proofOperationPrimaryKey(context.walletId, operationId),
      );
      if (!operationRow) {
        throw new Error("GUI wallet proof operation is missing");
      }
      const operation = requireProofOperationRecord(
        operationRow,
        context.walletId,
        operationId,
      );
      if (
        operation.state !== "completed" ||
        !operation.resultProofs ||
        !operation.custodyOperationId
      ) {
        throw new Error("GUI wallet proof operation is not exactly completed");
      }
      const canonicalRow = await db.custodyOperations.get(
        operation.custodyOperationId,
      );
      if (!canonicalRow) {
        throw new Error("GUI canonical custody operation is missing");
      }
      const canonical = decodeOperationRow(canonicalRow, context.scope);
      assertWalletOperationMatchesCustody(canonical, operation);
      const resultFingerprint = deriveDurableCustodyProofResultFingerprint(
        operation.resultProofs,
      );
      if (
        canonical.operation.state !== "reconciled" ||
        canonical.operation.result.state !== "applied" ||
        canonical.operation.result.resultFingerprint !== resultFingerprint ||
        canonical.operation.result.outputPlanFingerprint !==
          canonical.operation.outputPlan.outputPlanFingerprint
      ) {
        throw new Error(
          "GUI wallet completed result conflicts with canonical custody",
        );
      }
      if (
        operation.kind === "wallet-send" &&
        readGuiWalletSendDeliveryMetadata(operation)?.mode === "user-export"
      ) {
        const rawPayload = await db.walletSendDeliveryPayloads.get([
          context.walletId,
          operation.operationId,
        ]);
        const payload = rawPayload
          ? requireGuiWalletSendDeliveryPayloadRow(
              rawPayload,
              context.walletId,
              operation.operationId,
              canonical.operation.operationId,
            )
          : undefined;
        const rawBearer = await db.bearerSpendDeliveries
          .where("[walletId+parentOperationId]")
          .equals([context.walletId, canonical.operation.operationId])
          .first();
        const bearer = rawBearer
          ? requireGuiBearerSpendDeliveryRow(
              rawBearer,
              context.walletId,
              undefined,
              canonical.operation.operationId,
            )
          : undefined;
        requireWalletSendPayloadPolicy(canonical, operation, payload, bearer);
      }
      await requireCompletedResultProofsStored(operation);
      return operation;
    },
  );
}

async function requireCompletedResultProofsStored(
  operation: ProofOperationRecord,
): Promise<void> {
  if (!operation.resultProofs) {
    throw new Error("GUI wallet completed result is missing");
  }
  const expectedProofs = storedResultProofs(operation, operation.resultProofs);
  const rows = await db.proofs.bulkGet(storedProofIds(expectedProofs));
  rows.forEach((row, index) => {
    if (!row) {
      throw new Error("GUI wallet completed result proof is missing");
    }
    const stored = requireStoredProofRow(row, operation.walletId);
    const expected = expectedProofs[index]!;
    assertSameStoredProofAuthority(stored, expected);
  });
}

export async function requireCompletedGuiWalletProofOperationAuthorityForWallet(
  walletId: string,
  operationId: string,
): Promise<ProofOperationRecord> {
  return withRequiredGuiCustodyLockForWallet(walletId, (_context, lock) =>
    requireCompletedGuiWalletProofOperationAuthorityUnderLock(
      lock,
      operationId,
    ),
  );
}

export async function requirePendingGuiWalletSendTokenForWallet(
  walletId: string,
  operationId: string,
): Promise<string> {
  return withRequiredGuiCustodyLockForWallet(
    walletId,
    async (_context, lock) => {
      const operation =
        await requireCompletedGuiWalletProofOperationAuthorityUnderLock(
          lock,
          operationId,
        );
      const rawPayload = await db.walletSendDeliveryPayloads.get([
        walletId,
        operationId,
      ]);
      if (!rawPayload) {
        throw new Error("GUI wallet send pending payload is missing");
      }
      const payload = requireGuiWalletSendDeliveryPayloadRow(
        rawPayload,
        walletId,
        operationId,
        operation.custodyOperationId,
      );
      return requireExactGuiWalletSendUserExportToken(operation, payload);
    },
  );
}

export async function prepareProofOperation(
  input: PrepareProofOperationInput,
): Promise<ProofOperationRecord> {
  return prepareProofOperationForWallet(currentGuiWalletId(), input);
}

export async function prepareProofOperationForWallet(
  walletId: string,
  input: PrepareProofOperationInput,
): Promise<ProofOperationRecord> {
  const resolved = await resolveWalletOperationPlan(walletId, input);
  return withRequiredGuiCustodyLockForWallet(walletId, (context, lock) =>
    commitResolvedWalletOperation(resolved, context, lock),
  );
}

async function resolveWalletOperationPlan(
  walletId: string,
  input: PrepareProofOperationInput,
): Promise<ResolvedWalletOperationPlan> {
  const capturedInput = structuredClone(input);
  const operationInput = canonicalWalletOperationInput(capturedInput);
  const facts = structuredClone(
    await resolveDurableCustodyProofOperationFacts({
      operation: operationInput,
      session: null,
      resolveMintKeys: resolveGuiCustodyMintKeys,
      requireDleq: requiresPersistedDleqEvidence(operationInput),
    }),
  );
  const custodyRecord = createDurableCustodyProofOperation({
    scope: guiWalletContextForWallet(walletId).scope,
    operation: operationInput,
    facts,
    inventoryAccountId: null,
  });
  return {
    walletId,
    input: capturedInput,
    operationInput,
    facts,
    custodyFingerprint: deriveDurableCustodyArtifactFingerprint(custodyRecord),
  };
}

export async function markProofOperationMintSubmitted(
  operationId: string,
  redeemBinding?: CtfRedeemMintSubmissionBinding,
): Promise<ProofOperationRecord> {
  return markProofOperationMintSubmittedForWallet(
    currentGuiWalletId(),
    operationId,
    redeemBinding,
  );
}

export async function markProofOperationMintSubmittedForWallet(
  walletId: string,
  operationId: string,
  redeemBinding?: CtfRedeemMintSubmissionBinding,
): Promise<ProofOperationRecord> {
  return withRequiredGuiCustodyLockForWallet(walletId, (_context, lock) =>
    markProofOperationMintSubmittedUnderLock(lock, operationId, redeemBinding),
  );
}

/**
 * Atomically gives one ordinary-wallet dispatcher ownership of the external
 * mint call. A replay of the exact submitted pair observes `claimed: false`.
 */
export async function claimPreparedProofOperationMintSubmissionForWallet(
  walletId: string,
  operationId: string,
): Promise<GuiProofOperationMintSubmissionClaim> {
  return withRequiredGuiCustodyLockForWallet(walletId, (_context, lock) =>
    claimPreparedProofOperationMintSubmissionUnderLock(lock, operationId),
  );
}

/** Atomically retires an exact inputless mint plan that never crossed transport. */
export async function abortPreparedGuiWalletMintForWallet(
  walletId: string,
  operationId: string,
  decision: Extract<
    DurableWalletOperationRecoveryDecision,
    { kind: "abort-no-transport" }
  >,
): Promise<ProofOperationRecord> {
  if (
    decision.classification !== "all-inputs-unspent" ||
    decision.reason !== "mint-quote-expired"
  ) {
    throw new Error("GUI wallet mint abort authority is invalid");
  }
  return withRequiredGuiCustodyLockForWallet(walletId, (_context, lock) =>
    advanceWalletOperationOwned(
      operationId,
      guiWalletContextFromHeldLock(lock),
      lock,
      (record, transaction, operation) => {
        requirePreparedInputlessWalletMint(record, operation);
        transaction.transitionOperation({
          operationId: record.operation.operationId,
          transition: {
            kind: "abort-no-transport",
            classification: decision.classification,
            exactRequestDisposition: "deterministically-rejected",
          },
        });
      },
      (operation) => {
        requirePreparedInputlessWalletMintState(operation);
        return {
          ...operation,
          state: "Failed",
          resultProofs: undefined,
          lastError: EXPIRED_UNSUBMITTED_MINT_MESSAGE,
          failureCode: EXPIRED_UNSUBMITTED_MINT_FAILURE_CODE,
          updatedAt: Date.now(),
        };
      },
    ),
  );
}

export function isAbortedExpiredGuiWalletMint(
  record: DurableCustodyRecord,
  operation: ProofOperationRecord,
): boolean {
  return (
    record.operation.state === "aborted" &&
    record.operation.result.state === "none" &&
    operation.kind === "wallet-mint" &&
    operation.state === "Failed" &&
    operation.inputs.length === 0 &&
    operation.resultProofs === undefined &&
    operation.lastError === EXPIRED_UNSUBMITTED_MINT_MESSAGE &&
    operation.failureCode === EXPIRED_UNSUBMITTED_MINT_FAILURE_CODE
  );
}

function requirePreparedInputlessWalletMint(
  record: DurableCustodyRecord,
  operation: ProofOperationRecord,
): void {
  requirePreparedInputlessWalletMintState(operation);
  if (
    record.operation.state !== "dispatch-intent" ||
    record.operation.result.state !== "none" ||
    record.operation.binding.kind !== "wallet" ||
    record.operation.semanticKind !== "generic-receive" ||
    record.operation.reservation.inputs.length !== 0
  ) {
    throw new Error("GUI wallet mint is not safe to abort before transport");
  }
}

function requirePreparedInputlessWalletMintState(
  operation: ProofOperationRecord,
): void {
  if (
    operation.kind !== "wallet-mint" ||
    operation.state !== "prepared" ||
    operation.inputs.length !== 0
  ) {
    throw new Error("GUI wallet mint is not prepared without transport");
  }
}

async function claimPreparedProofOperationMintSubmissionUnderLock(
  lock: GuiWalletLockContext,
  operationId: string,
): Promise<GuiProofOperationMintSubmissionClaim> {
  let claimed: boolean | undefined;
  const record = await advanceWalletOperationOwned(
    operationId,
    guiWalletContextFromHeldLock(lock),
    lock,
    (custody, transaction, operation) =>
      (claimed = claimCanonicalMintSubmission(custody, transaction, operation)),
    (operation) => {
      if (claimed === true) return submittedOperation(operation, undefined);
      if (claimed === false) return operation;
      throw new Error("GUI wallet submission claim was not resolved");
    },
  );
  if (claimed === undefined) {
    throw new Error("GUI wallet submission claim was not resolved");
  }
  return { record, claimed };
}

function claimCanonicalMintSubmission(
  custody: DurableCustodyRecord,
  transaction: DurableCustodyTransaction,
  operation: ProofOperationRecord,
): boolean {
  requireOrdinaryWalletOperation(operation);
  if (
    operation.state === "prepared" &&
    custody.operation.state === "dispatch-intent"
  ) {
    transaction.transitionOperation({
      operationId: custody.operation.operationId,
      transition: { kind: "transport-attempted" },
    });
    return true;
  }
  if (
    operation.state === "mint-submitted" &&
    custody.operation.state === "transport-attempted"
  ) {
    return false;
  }
  if (operation.state === "completed" || operation.state === "Failed") {
    throw new Error(
      `Cannot claim terminal proof operation ${operation.operationId}`,
    );
  }
  throw new Error(
    "GUI wallet proof operation has inconsistent submission authority",
  );
}

async function markProofOperationMintSubmittedUnderLock(
  lock: GuiWalletLockContext,
  operationId: string,
  redeemBinding?: CtfRedeemMintSubmissionBinding,
): Promise<ProofOperationRecord> {
  return advanceWalletOperationOwned(
    operationId,
    guiWalletContextFromHeldLock(lock),
    lock,
    (record, transaction) => {
      if (record.operation.state === "dispatch-intent") {
        transaction.transitionOperation({
          operationId: record.operation.operationId,
          transition: { kind: "transport-attempted" },
        });
      } else if (record.operation.state !== "transport-attempted") {
        throw new Error(
          "GUI wallet custody cannot submit from its current state",
        );
      }
    },
    (operation) => submittedOperation(operation, redeemBinding),
  );
}

export async function markProofOperationCompleted(
  operationId: string,
  resultProofs: Record<string, Proof[]>,
  encodedUserExportToken?: string,
): Promise<ProofOperationRecord> {
  return markProofOperationCompletedForWallet(
    currentGuiWalletId(),
    operationId,
    resultProofs,
    encodedUserExportToken,
  );
}

export async function markProofOperationCompletedForWallet(
  walletId: string,
  operationId: string,
  resultProofs: Record<string, Proof[]>,
  encodedUserExportToken?: string,
): Promise<ProofOperationRecord> {
  return withRequiredGuiCustodyLockForWallet(walletId, (_context, lock) =>
    markProofOperationCompletedUnderLock(
      lock,
      operationId,
      resultProofs,
      encodedUserExportToken,
    ),
  );
}

async function markProofOperationCompletedUnderLock(
  lock: GuiWalletLockContext,
  operationId: string,
  resultProofs: Record<string, Proof[]>,
  encodedUserExportToken?: string,
): Promise<ProofOperationRecord> {
  const resultFingerprint =
    deriveDurableCustodyProofResultFingerprint(resultProofs);
  const resultProofSet = Object.values(resultProofs).flat();
  let consumeWalletSendReservation = false;
  return advanceWalletOperationOwned(
    operationId,
    guiWalletContextFromHeldLock(lock),
    lock,
    (record, transaction, operation, bearer, existingPayload) => {
      applyCanonicalResult(record, transaction, resultFingerprint);
      if (
        operation.kind === "wallet-send" &&
        readGuiWalletSendDeliveryMetadata(operation)?.mode === "user-export"
      ) {
        if (operation.state === "completed") {
          requireWalletSendPayloadPolicy(
            record,
            operation,
            existingPayload,
            bearer,
          );
          if (encodedUserExportToken !== undefined) {
            requireWalletSendReplayToken(
              operation,
              bearer,
              encodedUserExportToken,
            );
          }
        } else {
          if (!encodedUserExportToken) {
            throw new Error("GUI wallet send exact token is required");
          }
          putWalletSendDelivery(
            transaction,
            record.operation.operationId,
            operation.operationId,
            guiWalletSendTokenFingerprint(encodedUserExportToken),
          );
        }
        consumeWalletSendReservation = operation.state !== "completed";
      }
    },
    (operation) => {
      if (operation.state === "Failed") {
        throw new Error(
          `Cannot complete failed proof operation ${operationId}`,
        );
      }
      if (
        operation.resultProofs &&
        !sameValue(operation.resultProofs, resultProofs)
      ) {
        throw new Error(
          `Proof operation ${operationId} has conflicting results`,
        );
      }
      if (operation.state === "completed") return operation;
      const next = {
        ...operation,
        state: "completed",
        resultProofs: structuredClone(resultProofs),
        lastError: null,
        failureCode: undefined,
        updatedAt: Date.now(),
      } satisfies ProofOperationRecord;
      const delivery = readGuiWalletSendDeliveryMetadata(next);
      if (delivery?.mode === "user-export") {
        if (!encodedUserExportToken) {
          throw new Error("GUI wallet send exact token is required");
        }
      } else if (encodedUserExportToken !== undefined) {
        throw new Error("GUI wallet send token has no user-export delivery");
      }
      return next;
    },
    {
      additionalProofs: resultProofSet,
      nativeProofDelta: (operation, proofs) =>
        completedNativeProofDelta(operation, resultProofs, proofs),
      nextActivity: projectCompletedGuiDepositActivity,
      nextWalletSendDeliveryPayload: (previous, next) =>
        previous.state === "completed" || encodedUserExportToken === undefined
          ? undefined
          : createGuiWalletSendDeliveryPayloadRow(next, encodedUserExportToken),
      nextWalletSendDeliveryReservation: () =>
        consumeWalletSendReservation ? null : undefined,
      bearerSpendHandoff: (previous, next, custodyState, authorization) =>
        previous.state === "completed" ||
        readGuiWalletSendDeliveryMetadata(next)?.mode !== "user-export"
          ? undefined
          : createWalletSendBearerHandoff(
              next,
              encodedUserExportToken,
              custodyState,
              authorization,
            ),
    },
  );
}

export async function markProofOperationFailed(
  operationId: string,
  error: unknown,
): Promise<ProofOperationRecord> {
  return markProofOperationFailedForWallet(
    currentGuiWalletId(),
    operationId,
    error,
  );
}

export async function markProofOperationFailedForWallet(
  walletId: string,
  operationId: string,
  error: unknown,
): Promise<ProofOperationRecord> {
  return withRequiredGuiCustodyLockForWallet(walletId, (_context, lock) =>
    markProofOperationFailedUnderLock(lock, operationId, error),
  );
}

async function markProofOperationFailedUnderLock(
  lock: GuiWalletLockContext,
  operationId: string,
  error: unknown,
): Promise<ProofOperationRecord> {
  let terminalFailure: TerminalProofOperationFailure | undefined;
  const requireFailure = (operation: ProofOperationRecord) =>
    (terminalFailure ??= terminalProofOperationFailure(operation, error));
  return advanceWalletOperationOwned(
    operationId,
    guiWalletContextFromHeldLock(lock),
    lock,
    (record, transaction, operation) => {
      const failure = requireFailure(operation);
      applyCanonicalResult(record, transaction, failure.fingerprint);
    },
    (operation) => {
      const failure = requireFailure(operation);
      return {
        ...operation,
        state: "Failed",
        lastError: failure.message,
        failureCode: failure.code,
        updatedAt: Date.now(),
      };
    },
    {
      nativeProofDelta: (operation, proofs) =>
        failedNativeProofDelta(operation, requireFailure(operation), proofs),
    },
  );
}

async function commitResolvedWalletOperation(
  resolved: ResolvedWalletOperationPlan,
  context: GuiWalletContext,
  lock: GuiWalletLockContext,
): Promise<ProofOperationRecord> {
  assertResolvedWalletOperation(resolved, context);
  const input = resolved.input;
  const snapshot = await readResolvedWalletOperationSnapshot(
    input,
    context.walletId,
  );
  const custodyRecord = revalidatedCustodyRecord(resolved, context.scope);
  const authority = await acquireGuiCustodyAuthority(lock);
  const plan = await authority.store.prepareTransaction(
    {
      scope: authority.scope,
      owner: authority.owner,
      operationIds: [custodyRecord.operation.operationId],
    },
    (transaction) =>
      bindDurableCustodyProofOperation(transaction, custodyRecord),
  );
  const nextOperation = walletOperationRecord(
    input,
    custodyRecord.operation.operationId,
    snapshot.operation,
    context.walletId,
  );
  const nextProofs = reserveNativeInputProofs(nextOperation, snapshot.proofs);
  const nextWalletSendDeliveryReservation = reservationForPreparedWalletSend(
    nextOperation,
    snapshot,
  );
  const prepared = await prepareGuiCustodyUnitOfWork({
    authority,
    plan,
    snapshot,
    nextOperation,
    nextWalletSendDeliveryReservation,
    nextProofs,
  });
  await commitGuiHeadroomCustodyUnitOfWork({ walletLock: lock, prepared });
  return nextOperation;
}

function reservationForPreparedWalletSend(
  nextOperation: ProofOperationRecord,
  snapshot: GuiCustodyNativeSnapshot,
): GuiWalletSendDeliveryReservationRow | undefined {
  if (!readGuiWalletSendDeliveryMetadata(nextOperation)) return undefined;
  const previous = snapshot.operation;
  if (!previous) {
    return createGuiWalletSendDeliveryReservationRow(nextOperation);
  }
  if (previous.state === "prepared") {
    return snapshot.walletSendDeliveryReservation
      ? undefined
      : createGuiWalletSendDeliveryReservationRow(nextOperation);
  }
  if (
    previous.state === "mint-submitted" &&
    !snapshot.walletSendDeliveryReservation
  ) {
    throw new Error("GUI wallet-send physical reservation is missing");
  }
  return undefined;
}

function requireWalletSendReservationBeforeTransport(
  operation: ProofOperationRecord,
  snapshot: GuiCustodyNativeSnapshot,
): void {
  const metadata = readGuiWalletSendDeliveryMetadata(operation);
  if (
    metadata?.mode !== "user-export" ||
    (operation.state !== "prepared" && operation.state !== "mint-submitted")
  ) {
    return;
  }
  const reservation = snapshot.walletSendDeliveryReservation;
  if (
    !reservation ||
    reservation.walletId !== operation.walletId ||
    reservation.operationId !== operation.operationId ||
    reservation.custodyOperationId !== operation.custodyOperationId ||
    reservation.admissionFingerprint !==
      deriveDurableCustodyArtifactFingerprint(metadata.admission) ||
    reservation.reservedBytes !== metadata.admission.durableStorageBytesRequired
  ) {
    throw new Error("GUI wallet-send physical reservation is missing or stale");
  }
}

async function readExistingWalletSendPayload(
  operation: ProofOperationRecord,
  snapshot: GuiCustodyNativeSnapshot,
): Promise<GuiWalletSendDeliveryPayloadRow | undefined> {
  if (
    operation.state !== "completed" ||
    readGuiWalletSendDeliveryMetadata(operation)?.mode !== "user-export" ||
    snapshot.walletSendDeliveryPayload === undefined
  ) {
    return undefined;
  }
  const row = await db.walletSendDeliveryPayloads.get([
    operation.walletId,
    operation.operationId,
  ]);
  return row
    ? requireGuiWalletSendDeliveryPayloadRow(
        row,
        operation.walletId,
        operation.operationId,
        operation.custodyOperationId,
      )
    : undefined;
}

async function readResolvedWalletOperationSnapshot(
  input: PrepareProofOperationInput,
  walletId: string,
) {
  await ensureDurableSwapStorage(walletId);
  const policy = requireDurableWalletProofTransition(
    input.metadata ?? {},
    Object.keys(input.outputs),
  );
  return readGuiCustodyNativeSnapshot(
    input.operationId,
    null,
    walletId,
    undefined,
    locateStoredProofs(
      [...input.inputs, ...durableWalletPassthroughProofs(policy)],
      input.mintUrl,
      input.metadata?.unit as string | undefined,
    ),
  );
}

function revalidatedCustodyRecord(
  resolved: ResolvedWalletOperationPlan,
  scope: GuiWalletContext["scope"],
): DurableCustodyRecord {
  const record = createDurableCustodyProofOperation({
    scope,
    operation: resolved.operationInput,
    facts: resolved.facts,
    inventoryAccountId: null,
  });
  if (
    deriveDurableCustodyArtifactFingerprint(record) !==
    resolved.custodyFingerprint
  ) {
    throw new Error(
      "GUI wallet resolved operation facts changed before commit",
    );
  }
  return record;
}

function assertResolvedWalletOperation(
  resolved: ResolvedWalletOperationPlan,
  context: GuiWalletContext,
): void {
  if (resolved.walletId !== context.walletId) {
    throw new Error("GUI wallet resolved operation belongs to another wallet");
  }
  if (
    !sameValue(
      canonicalWalletOperationInput(resolved.input),
      resolved.operationInput,
    )
  ) {
    throw new Error("GUI wallet resolved operation changed before commit");
  }
}

function reserveNativeInputProofs(
  operation: ProofOperationRecord,
  storedProofs: StoredProof[],
): StoredProof[] {
  const policy = walletProofTransition(operation);
  const authority = requireGuiNativeProofInputAuthority(
    operation,
    storedProofs,
    policy,
    "available",
  );
  if (policy.inputSource === "external") return [];
  return reserveGuiNativeInputProofs(
    operation.operationId,
    operation.mintUrl,
    authority,
    authority,
    operation.walletId,
  );
}

function completedNativeProofDelta(
  operation: ProofOperationRecord,
  resultProofs: Record<string, Proof[]>,
  storedProofs: StoredProof[],
): NativeProofDelta {
  if (operation.state === "completed") return {};
  const policy = walletProofTransition(operation);
  const inputs = requireGuiNativeProofInputAuthority(
    operation,
    storedProofs,
    policy,
    "owned",
  );
  const nextProofs = storedResultProofs(operation, resultProofs);
  const spentInputSecrets = new Set(
    operation.inputs.map(({ secret }) => secret),
  );
  const spentInputs = inputs.filter(({ secret }) =>
    spentInputSecrets.has(secret),
  );
  const replacedAuthoritySecrets = new Set(inputs.map(({ secret }) => secret));
  const unrelatedStoredSecrets = new Set(
    storedProofs
      .filter(({ secret }) => !replacedAuthoritySecrets.has(secret))
      .map(({ secret }) => secret),
  );
  if (
    nextProofs.some(({ secret }) => spentInputSecrets.has(secret)) ||
    nextProofs.some(({ secret }) => unrelatedStoredSecrets.has(secret))
  ) {
    throw new Error("GUI wallet result proof conflicts with local proof state");
  }
  return {
    deleteProofs: policy.inputSource === "wallet" ? spentInputs : [],
    nextProofs,
  };
}

function failedNativeProofDelta(
  operation: ProofOperationRecord,
  failure: TerminalProofOperationFailure,
  storedProofs: StoredProof[],
): NativeProofDelta {
  const policy = walletProofTransition(operation);
  if (policy.inputSource === "external") return {};
  const inputs = requireGuiNativeInputProofs(
    operation.operationId,
    operation.mintUrl,
    operation.inputs,
    storedProofs,
    "owned",
    operation.walletId,
  );
  if (!failure.releaseNativeReservation) return {};
  return {
    nextProofs: inputs.map(({ reservedBy: _reservedBy, ...proof }) => proof),
  };
}

function walletProofTransition(
  operation: Pick<ProofOperationRecord, "metadata" | "outputs">,
) {
  return requireDurableWalletProofTransition(
    operation.metadata,
    Object.keys(operation.outputs),
  );
}

function requireOrdinaryWalletOperation(operation: ProofOperationRecord): void {
  if (
    operation.kind !== "wallet-mint" &&
    operation.kind !== "wallet-receive" &&
    operation.kind !== "wallet-send"
  ) {
    throw new Error(
      "GUI submission claim requires an ordinary wallet operation",
    );
  }
}

function requiresPersistedDleqEvidence(
  operation: DurableCustodyProofOperationInput,
): boolean {
  return (
    operation.kind !== "wallet-mint" && operation.kind !== "wallet-receive"
  );
}

function storedResultProofs(
  operation: ProofOperationRecord,
  resultProofs: Record<string, Proof[]>,
): StoredProof[] {
  const policy = requireDurableWalletProofTransition(
    operation.metadata,
    Object.keys(operation.outputs),
  );
  assertDurableWalletProofResultMatchesPlan(
    policy,
    operation.outputs,
    resultProofs,
  );
  const unit = parseCashuProofUnit(operation.metadata.unit);
  if (!unit) {
    throw new Error("GUI wallet operation result has no supported Cashu unit");
  }
  const now = Date.now();
  const baseAsset = COLLATERAL_UNIT_REGISTRY[unit].baseAsset;
  const proofs = Object.entries(resultProofs).flatMap(([label, proofs]) => {
    const disposition = policy.resultGroups[label];
    return disposition?.kind === "wallet"
      ? proofs.map((proof) => ({ proof, disposition }))
      : [];
  });
  if (new Set(proofs.map(({ proof }) => proof.secret)).size !== proofs.length) {
    throw new Error("GUI wallet operation result contains duplicate proofs");
  }
  return proofs.map(({ proof, disposition }) =>
    normalizeStoredProofForStorage(
      {
        ...proof,
        mintUrl: operation.mintUrl,
        unit,
        baseAsset,
        receivedAt: now,
        ...(disposition.reservedBy === null
          ? {}
          : { reservedBy: disposition.reservedBy }),
      },
      operation.walletId,
    ),
  );
}

async function advanceWalletOperationOwned(
  operationId: string,
  context: GuiWalletContext,
  lock: GuiWalletLockContext,
  advanceCanonical: (
    record: DurableCustodyRecord,
    transaction: DurableCustodyTransaction,
    operation: ProofOperationRecord,
    bearer: GuiBearerSpendDeliveryRow | undefined,
    existingPayload: GuiWalletSendDeliveryPayloadRow | undefined,
  ) => void,
  advanceNative: (operation: ProofOperationRecord) => ProofOperationRecord,
  options: {
    additionalProofs?: readonly Proof[];
    nativeProofDelta?: (
      operation: ProofOperationRecord,
      proofs: StoredProof[],
    ) => NativeProofDelta;
    nextActivity?: (
      operation: ProofOperationRecord,
    ) => WalletActivityRow | null;
    nextWalletSendDeliveryPayload?: (
      previous: ProofOperationRecord,
      next: ProofOperationRecord,
    ) => GuiWalletSendDeliveryPayloadRow | null | undefined;
    nextWalletSendDeliveryReservation?: (
      previous: ProofOperationRecord,
      next: ProofOperationRecord,
    ) => GuiWalletSendDeliveryReservationRow | null | undefined;
    bearerSpendHandoff?: (
      previous: ProofOperationRecord,
      next: ProofOperationRecord,
      custodyState: DurableCustodyState,
      authorization: DurableCustodyOwnerAuthorization,
    ) => GuiBearerSpendCustodyHandoff | undefined;
  } = {},
): Promise<ProofOperationRecord> {
  await ensureDurableSwapStorage(context.walletId);
  const snapshot = await readGuiCustodyOperationSnapshot(
    operationId,
    context.walletId,
    options.additionalProofs,
  );
  const operation = snapshot.operation;
  if (!operation) throw new Error(`Missing proof operation ${operationId}`);
  if (operation.durableTradeRecovery) {
    throw new Error(
      "Trade-bound proof operation requires its swap coordinator",
    );
  }
  requireWalletSendReservationBeforeTransport(operation, snapshot);
  const existingWalletSendPayload = await readExistingWalletSendPayload(
    operation,
    snapshot,
  );
  const authority = await acquireGuiCustodyAuthority(lock);
  const plan = await prepareGuiCustodyTransition(
    authority,
    operation,
    (record, transaction) => {
      assertWalletOperationMatchesCustody(record, operation);
      advanceCanonical(
        record,
        transaction,
        operation,
        snapshot.bearerSpendDelivery,
        existingWalletSendPayload,
      );
    },
  );
  const nextOperation = advanceNative(operation);
  const bearerSpendHandoff =
    options.bearerSpendHandoff &&
    operation.state !== "completed" &&
    readGuiWalletSendDeliveryMetadata(nextOperation)?.mode === "user-export"
      ? options.bearerSpendHandoff(
          operation,
          nextOperation,
          singleCustodyState(plan, operation.custodyOperationId),
          authority.owner,
        )
      : undefined;
  if (bearerSpendHandoff) {
    plan.transaction.adoptBearerSpendCustodyHandoff(bearerSpendHandoff.plan);
  }
  const proofDelta =
    options.nativeProofDelta?.(operation, snapshot.proofs) ?? {};
  const nextActivity = options.nextActivity?.(nextOperation) ?? undefined;
  const nextWalletSendDeliveryPayload = options.nextWalletSendDeliveryPayload?.(
    operation,
    nextOperation,
  );
  const nextWalletSendDeliveryReservation =
    options.nextWalletSendDeliveryReservation?.(operation, nextOperation);
  const prepared = await prepareGuiCustodyUnitOfWork({
    authority,
    plan,
    snapshot,
    nextOperation,
    nextActivity,
    nextWalletSendDeliveryPayload,
    nextWalletSendDeliveryReservation,
    bearerSpendHandoff,
    ...proofDelta,
  });
  await commitGuiHeadroomCustodyUnitOfWork({ walletLock: lock, prepared });
  return nextOperation;
}

function assertWalletOperationMatchesCustody(
  record: DurableCustodyRecord,
  operation: ProofOperationRecord,
): void {
  const fingerprints = walletOperationAuthorityFingerprints(operation);
  const binding = record.operation.binding;
  if (
    record.scope.scopeKind !== "wallet" ||
    record.scope.walletId !== operation.walletId ||
    record.operation.retainedOperationKey !== operation.operationId ||
    binding.kind !== "wallet" ||
    binding.activityId !== operation.operationId ||
    record.operation.custodyContext.normalizedMint !== operation.mintUrl ||
    !fingerprints.some(
      (candidate) =>
        record.operation.exactRequest.requestFingerprint ===
          candidate.requestFingerprint &&
        record.operation.outputPlan.outputPlanFingerprint ===
          candidate.outputPlanFingerprint,
    )
  ) {
    throw new Error("GUI wallet operation has foreign exact custody authority");
  }
}

function walletOperationAuthorityFingerprints(operation: ProofOperationRecord) {
  const direct = deriveDurableCustodyProofOperationFingerprints(
    canonicalWalletOperationInput(operation),
  );
  if (!hasBoundRedeemSubmission(operation)) return [direct];
  const metadata = { ...operation.metadata };
  delete metadata.redeemMintSubmissionVersion;
  delete metadata.redeemMintSubmissionRequestDigest;
  return [
    direct,
    deriveDurableCustodyProofOperationFingerprints(
      canonicalWalletOperationInput({ ...operation, metadata }),
    ),
  ];
}

function hasBoundRedeemSubmission(operation: ProofOperationRecord): boolean {
  if (
    operation.kind !== "ctf-redeem" ||
    operation.metadata.redeemMintSubmissionVersion !== 1 ||
    typeof operation.metadata.redeemMintSubmissionRequestDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(operation.metadata.redeemMintSubmissionRequestDigest)
  ) {
    return false;
  }
  switch (operation.state) {
    case "prepared":
      return false;
    case "mint-submitted":
    case "completed":
    case "Failed":
      return true;
  }
}

function canonicalWalletOperationInput(
  input: PrepareProofOperationInput,
): DurableCustodyProofOperationInput {
  return {
    ...input,
    mintUrl: normalizeUrl(input.mintUrl),
    metadata: structuredClone(input.metadata ?? {}),
  };
}

function walletOperationRecord(
  input: PrepareProofOperationInput,
  custodyOperationId: string,
  existing: ProofOperationRecord | undefined,
  walletId: string,
): ProofOperationRecord {
  const exact = exactNativeOperation(input);
  if (existing) {
    if (
      !sameValue(exact, exactNativeOperation(existing)) ||
      existing.durableTradeRecovery !== undefined ||
      (existing.custodyOperationId !== undefined &&
        existing.custodyOperationId !== custodyOperationId) ||
      (existing.custodyOperationId === undefined &&
        existing.state !== "prepared")
    ) {
      throw new Error(
        `Proof operation ${input.operationId} already exists with foreign authority`,
      );
    }
  }
  const now = Date.now();
  return {
    walletId,
    operationId: input.operationId,
    kind: input.kind,
    state: existing?.state ?? "prepared",
    mintUrl: exact.mintUrl,
    inputs: structuredClone(input.inputs),
    outputs: structuredClone(input.outputs),
    metadata: structuredClone(input.metadata ?? {}),
    resultProofs: structuredClone(existing?.resultProofs),
    lastError: existing?.lastError ?? null,
    failureCode: existing?.failureCode,
    custodyOperationId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: existing?.updatedAt ?? now,
  };
}

function exactNativeOperation(
  input: Pick<
    PrepareProofOperationInput,
    "kind" | "mintUrl" | "inputs" | "outputs" | "metadata"
  >,
) {
  return {
    kind: input.kind,
    mintUrl: normalizeUrl(input.mintUrl),
    inputs: input.inputs,
    outputs: input.outputs,
    metadata: input.metadata ?? {},
  };
}

function submittedOperation(
  operation: ProofOperationRecord,
  redeemBinding: CtfRedeemMintSubmissionBinding | undefined,
): ProofOperationRecord {
  if (operation.state === "completed" || operation.state === "Failed") {
    throw new Error(
      `Cannot submit terminal proof operation ${operation.operationId}`,
    );
  }
  const metadata = bindRedeemSubmission(operation, redeemBinding);
  return {
    ...operation,
    state: "mint-submitted",
    metadata,
    lastError: null,
    failureCode: undefined,
    updatedAt: Date.now(),
  };
}

function bindRedeemSubmission(
  operation: ProofOperationRecord,
  binding: CtfRedeemMintSubmissionBinding | undefined,
): ProofOperationRecord["metadata"] {
  if (!binding) return operation.metadata;
  const currentVersion = operation.metadata.redeemMintSubmissionVersion;
  const currentDigest = operation.metadata.redeemMintSubmissionRequestDigest;
  if (
    (currentVersion !== undefined &&
      currentVersion !== binding.schemaVersion) ||
    (currentDigest !== undefined && currentDigest !== binding.requestDigest)
  ) {
    throw new Error("CTF redeem mint submission binding conflicts");
  }
  return {
    ...operation.metadata,
    redeemMintSubmissionVersion: binding.schemaVersion,
    redeemMintSubmissionRequestDigest: binding.requestDigest,
  };
}

function applyCanonicalResult(
  record: DurableCustodyRecord,
  transaction: DurableCustodyTransaction,
  resultFingerprint: string,
): void {
  if (record.operation.result.state === "applied") {
    if (record.operation.result.resultFingerprint !== resultFingerprint) {
      throw new Error("GUI wallet result conflicts with canonical custody");
    }
    return;
  }
  const outputPlanFingerprint =
    record.operation.outputPlan.outputPlanFingerprint;
  const resultHandle = `result:${resultFingerprint}`;
  transaction.stageVerifiedResult({
    operationId: record.operation.operationId,
    outputPlanFingerprint,
    resultHandle,
    resultFingerprint,
  });
  transaction.applyVerifiedResult({
    operationId: record.operation.operationId,
    outputPlanFingerprint,
    resultHandle,
    resultFingerprint,
  });
}

function putWalletSendDelivery(
  transaction: DurableCustodyTransaction,
  custodyOperationId: string,
  retainedOperationKey: string,
  resultFingerprint: string,
): void {
  const current = transaction.getOperation(custodyOperationId);
  if (!current) throw new Error("GUI wallet send custody is missing");
  const delivery = current.operation.delivery;
  const payloadHandle = `wallet-send:${retainedOperationKey}`;
  if (
    delivery.deliveryKind === "outbox" &&
    delivery.deliveryId === `delivery:${custodyOperationId}:wallet-send` &&
    delivery.payloadHandle === payloadHandle &&
    delivery.payloadFingerprint === resultFingerprint &&
    delivery.expiresAtMs === null &&
    delivery.state === "pending"
  ) {
    return;
  }
  transaction.putDelivery({
    operationId: custodyOperationId,
    deliveryKind: "wallet-send",
    payloadHandle,
    payloadFingerprint: resultFingerprint,
    expiresAtMs: null,
    state: "pending",
  });
}

function createWalletSendBearerHandoff(
  operation: ProofOperationRecord,
  encodedToken: string | undefined,
  custodyState: DurableCustodyState,
  authorization: DurableCustodyOwnerAuthorization,
): GuiBearerSpendCustodyHandoff {
  const sendProofs = operation.resultProofs?.send;
  const delivery = custodyState.operation.operation.delivery;
  const unit = parseCashuProofUnit(operation.metadata.unit);
  if (
    operation.kind !== "wallet-send" ||
    operation.state !== "completed" ||
    encodedToken === undefined ||
    !sendProofs ||
    !unit ||
    delivery.deliveryKind !== "outbox" ||
    delivery.state !== "pending" ||
    delivery.deliveryId === null ||
    delivery.payloadHandle === null
  ) {
    throw new Error("GUI wallet send bearer handoff is incomplete");
  }
  const bearerRecord = createDurableBearerSpendDeliveryRecord({
    deliveryId: delivery.deliveryId,
    walletId: operation.walletId,
    parentOperationId: operation.custodyOperationId,
    payloadHandle: delivery.payloadHandle,
    mintUrl: operation.mintUrl,
    unit,
    encodedToken,
    proofs: sendProofs,
    origin: "local",
    createdAtMs: operation.updatedAt,
  });
  const plan = planDurableBearerSpendCustodyHandoff({
    bearerRecord,
    custodyState,
    authorization,
  });
  return {
    previousCustodyState: custodyState,
    plan,
    row: createGuiBearerSpendDeliveryRow(plan.bearerRecord),
  };
}

function singleCustodyState(
  plan: Awaited<ReturnType<typeof prepareGuiCustodyTransition>>,
  operationId: string,
): DurableCustodyState {
  const rows = plan.transaction.operationRows();
  if (rows.length !== 1 || rows[0]?.operationId !== operationId) {
    throw new Error("GUI wallet custody transition is not exact");
  }
  return {
    scopeState: plan.transaction.scopeState(),
    operation: rows[0].record,
  };
}

function requireWalletSendPresentation(
  custody: DurableCustodyRecord,
  operation: ProofOperationRecord,
  payload: GuiWalletSendDeliveryPayloadRow | undefined,
  bearer: GuiBearerSpendDeliveryRow | undefined,
): {
  state: "pending";
  encodedToken: string;
} {
  const encodedToken = requireWalletSendPayloadPolicy(
    custody,
    operation,
    payload,
    bearer,
  );
  if (encodedToken === null) {
    throw new Error("GUI wallet send bearer is not presentable");
  }
  return { state: "pending", encodedToken };
}

function requireWalletSendPayloadPolicy(
  custody: DurableCustodyRecord,
  operation: ProofOperationRecord,
  payload: GuiWalletSendDeliveryPayloadRow | undefined,
  bearer: GuiBearerSpendDeliveryRow | undefined,
): string | null {
  const authority = requireWalletSendBearerAuthority(
    custody,
    operation,
    bearer,
  );
  if (!authority.presentable) {
    if (payload !== undefined) {
      throw new Error("GUI non-presentable bearer payload must be absent");
    }
    return null;
  }
  if (payload === undefined) {
    throw new Error("GUI wallet send pending payload is missing");
  }
  const encodedToken = requireExactGuiWalletSendUserExportToken(
    operation,
    payload,
  );
  if (
    payload.tokenDigest !== authority.record.tokenDigest ||
    payload.tokenByteLength !== authority.record.tokenByteLength
  ) {
    throw new Error("GUI wallet send payload conflicts with bearer authority");
  }
  return encodedToken;
}

function requireWalletSendBearerAuthority(
  custody: DurableCustodyRecord,
  operation: ProofOperationRecord,
  bearer: GuiBearerSpendDeliveryRow | undefined,
) {
  const sendProofs = operation.resultProofs?.send;
  if (
    operation.kind !== "wallet-send" ||
    operation.state !== "completed" ||
    !sendProofs ||
    readGuiWalletSendDeliveryMetadata(operation)?.mode !== "user-export" ||
    bearer === undefined
  ) {
    throw new Error("GUI wallet send delivery has no completed authority");
  }
  assertWalletOperationMatchesCustody(custody, operation);
  const record = requireDurableBearerSpendOriginalProofLineage(
    bearer.record,
    sendProofs,
  );
  requireWalletSendImmutableBinding(custody, operation, bearer, record);
  return {
    record,
    presentable: isDurableBearerSpendTokenPresentable(record),
  };
}

function requireWalletSendReplayToken(
  operation: ProofOperationRecord,
  bearer: GuiBearerSpendDeliveryRow | undefined,
  encodedToken: string,
): void {
  const sendProofs = operation.resultProofs?.send;
  const unit = parseCashuProofUnit(operation.metadata.unit);
  if (!bearer || !sendProofs || !unit) {
    throw new Error("GUI wallet send replay token has no bearer authority");
  }
  const descriptor = requireExactDurableWalletSendToken({
    encodedToken,
    mintUrl: operation.mintUrl,
    unit,
    sendProofs,
  });
  if (
    descriptor.tokenDigest !== bearer.record.tokenDigest ||
    descriptor.byteLength !== bearer.record.tokenByteLength
  ) {
    throw new Error("GUI wallet send replay token is foreign");
  }
}

function requireWalletSendImmutableBinding(
  custody: DurableCustodyRecord,
  operation: ProofOperationRecord,
  bearer: GuiBearerSpendDeliveryRow,
  record: GuiBearerSpendDeliveryRow["record"],
): void {
  const delivery = custody.operation.delivery;
  if (!operation.resultProofs) {
    throw new Error("GUI wallet send delivery has no completed authority");
  }
  const resultFingerprint = deriveDurableCustodyProofResultFingerprint(
    operation.resultProofs,
  );
  if (
    custody.operation.result.state !== "applied" ||
    custody.operation.result.resultFingerprint !== resultFingerprint ||
    delivery.deliveryKind !== "outbox" ||
    delivery.deliveryId !==
      `delivery:${custody.operation.operationId}:wallet-send` ||
    delivery.payloadHandle !== `wallet-send:${operation.operationId}` ||
    delivery.payloadFingerprint !== record.tokenDigest ||
    delivery.expiresAtMs !== null ||
    delivery.state !== "acknowledged" ||
    bearer.walletId !== operation.walletId ||
    bearer.parentOperationId !== custody.operation.operationId ||
    bearer.deliveryId !== delivery.deliveryId ||
    bearer.payloadHandle !== delivery.payloadHandle ||
    record.walletId !== operation.walletId ||
    record.parentOperationId !== custody.operation.operationId ||
    record.deliveryId !== delivery.deliveryId ||
    record.payloadHandle !== delivery.payloadHandle ||
    record.mintUrl !== operation.mintUrl ||
    record.unit !== operation.metadata.unit
  ) {
    throw new Error("GUI wallet send delivery authority is inconsistent");
  }
}

interface TerminalProofOperationFailure {
  code: number;
  message: string;
  fingerprint: string;
  releaseNativeReservation: boolean;
}

function terminalProofOperationFailure(
  operation: ProofOperationRecord,
  error: unknown,
): TerminalProofOperationFailure {
  const code = mintErrorCode(error);
  const message = errorMessage(error);
  if (operation.state !== "mint-submitted") {
    throw new Error("Terminal mint failure has no exact submitted request");
  }
  if (operation.kind === "ctf-redeem") {
    if (
      code !== ORACLE_NOT_ATTESTED_OUTCOME_CODE ||
      operation.metadata.redeemMintSubmissionVersion !== 1 ||
      typeof operation.metadata.redeemMintSubmissionRequestDigest !== "string"
    ) {
      throw new Error("Only the exact mint CTF losing rejection is terminal");
    }
    return terminalFailure(
      "ctf-redeem-terminal-rejection",
      code,
      message,
      false,
    );
  }
  if (
    operation.kind === "ctf-condition-registration" &&
    code !== undefined &&
    REGISTRATION_FEE_REJECTION_CODES.has(code)
  ) {
    return terminalFailure(
      "ctf-condition-registration-terminal-rejection",
      code,
      message,
      true,
    );
  }
  throw new Error("Mint failure is not an approved terminal rejection");
}

function terminalFailure(
  kind: string,
  code: number,
  message: string,
  releaseNativeReservation: boolean,
): TerminalProofOperationFailure {
  return {
    code,
    message,
    fingerprint: deriveDurableCustodyArtifactFingerprint({ kind, code }),
    releaseNativeReservation,
  };
}

function mintErrorCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withRequiredGuiCustodyLockForWallet<T>(
  walletId: string,
  action: (context: GuiWalletContext, lock: GuiWalletLockContext) => Promise<T>,
): Promise<T> {
  return withGuiCustodyProfileLockForWallet(walletId, async (context, lock) => {
    try {
      return await action(context, lock);
    } finally {
      await releaseGuiCustodyAuthority(lock, context.scope);
    }
  });
}
