import type { Proof } from "@cashu/cashu-ts";
import { parseMarketBaseAsset } from "@bitcaster/client-sdk/marketUnits";
import { requireDurableWalletProofTransition } from "@bitcaster/client-sdk/durableWalletProofTransition";
import {
  db,
  ensureDurableSwapStorage,
  locateStoredProofs,
  storedProofIds,
  type ProofOperationRecord,
  type StoredProofRow,
} from "@/stores/proof-db";
import type { GuiWalletLockContext } from "@/stores/gui-wallet-lock";
import { walletIdFromHeldGuiWalletLock } from "@/stores/gui-wallet-lock";
import { requireCompletedGuiWalletProofOperationAuthorityUnderLock } from "@/stores/gui-wallet-proof-operation-custody";
import {
  assertPendingEcashDepositTokenMatchesProofs,
  depositSplitOperationId,
  normalizePendingPaymentProofs,
  normalizePendingPaymentRow,
  normalizePendingEcashDepositSerializedToken,
  PendingEcashDepositAuthorityError,
  pendingPaymentError,
  requireDepositId,
  requirePendingPaymentRow,
  samePendingEcashDepositSerializedToken,
  samePaymentProofSet,
  samePaymentProofValue,
  type NewPreparedPendingEcashDeposit,
  type PendingEcashDepositRemoteState,
  type PendingEcashDepositRequest,
  type PendingEcashDepositSerializedToken,
  type PendingLocalWalletPaymentRecord,
  type PendingLocalWalletPaymentRow,
  type ReservedPendingEcashDeposit,
} from "@/stores/pending-local-wallet-payment-model";

export type {
  PendingEcashDepositRemoteState,
  PendingEcashDepositRequest,
  PendingLocalWalletPaymentRecord,
  PendingLocalWalletPaymentRow,
  PreparedPendingEcashDeposit,
  ReservedPendingEcashDeposit,
} from "@/stores/pending-local-wallet-payment-model";

export { depositSplitOperationId } from "@/stores/pending-local-wallet-payment-model";

export const PENDING_ECASH_DEPOSIT_RECOVERY_LIMIT = 16;
export const PENDING_ECASH_DEPOSIT_RETRY_BASE_MS = 1_000;
export const PENDING_ECASH_DEPOSIT_RETRY_MAX_MS = 60_000;
const PAYMENT_RECORD_LIMIT = 64;
const RETRY_EXPONENT_MAX = 16;

export interface PendingEcashDepositRecoveryCursor {
  eligibleBefore: number;
  nextAttemptAt: number;
  createdAt: number;
  depositId: string;
}

export interface PendingEcashDepositRecoveryPage {
  records: PendingLocalWalletPaymentRow[];
  hasMore: boolean;
  nextCursor: PendingEcashDepositRecoveryCursor | null;
}

export interface PendingEcashDepositRecoverySummary {
  nextAttemptAt: number | null;
  blocked: Array<{ depositId: string; error: string }>;
}

export async function createPendingEcashDepositUnderLock(
  lock: GuiWalletLockContext,
  input: NewPreparedPendingEcashDeposit,
): Promise<PendingLocalWalletPaymentRow> {
  const walletId = walletIdFromHeldGuiWalletLock(lock);
  await ensureDurableSwapStorage(walletId);
  const candidate = normalizePendingPaymentRow(
    {
      ...input,
      walletId,
      phase: "prepared",
      remoteState: null,
      retryCount: input.retryCount ?? 0,
      nextAttemptAt: input.nextAttemptAt ?? input.createdAt,
      lastError: input.lastError ?? null,
      recoveryState: input.recoveryState ?? "active",
    },
    walletId,
  );
  if (candidate.phase !== "prepared") {
    throw new Error("New ecash deposit must be a prepared pre-intent");
  }
  return db.transaction("rw", db.pendingLocalWalletPayments, async () => {
    const existing = requirePendingPaymentRow(
      await db.pendingLocalWalletPayments.get([walletId, candidate.depositId]),
      walletId,
      candidate.depositId,
    );
    await enforcePaymentCapacity(walletId, existing !== undefined);
    if (existing) {
      assertSamePendingBinding(existing, candidate);
      return existing;
    }
    await db.pendingLocalWalletPayments.put(candidate);
    return candidate;
  });
}

export async function recordPendingEcashDepositSplitUnderLock(
  lock: GuiWalletLockContext,
  depositId: string,
  sendProofsValue: readonly Proof[],
  serializedTokenValue: PendingEcashDepositSerializedToken,
): Promise<PendingLocalWalletPaymentRow & ReservedPendingEcashDeposit> {
  const walletId = walletIdFromHeldGuiWalletLock(lock);
  await ensureDurableSwapStorage(walletId);
  const id = requireDepositId(depositId);
  const sendProofs = normalizePendingPaymentProofs(
    sendProofsValue,
    "send proofs",
  );
  const serializedToken =
    normalizePendingEcashDepositSerializedToken(serializedTokenValue);
  const operation = await requireCanonicalCompletedSplit(
    lock,
    depositSplitOperationId(id),
  );
  return db.transaction(
    "rw",
    db.pendingLocalWalletPayments,
    db.proofs,
    async () => {
      const current = requireExistingPayment(
        await db.pendingLocalWalletPayments.get([walletId, id]),
        walletId,
        id,
      );
      assertPendingEcashDepositTokenMatchesProofs(
        serializedToken,
        current.request,
        sendProofs,
      );
      requireActiveRecovery(current);
      if (current.phase === "reserved") {
        if (
          !samePaymentProofSet(current.sendProofs, sendProofs) ||
          !samePendingEcashDepositSerializedToken(
            current.serializedToken,
            serializedToken,
          )
        ) {
          throw new Error("Pending ecash deposit split result conflicts");
        }
        await requireExactCompletedSplit(current, walletId, operation);
        return current;
      }
      const next = normalizePendingPaymentRow(
        {
          ...current,
          phase: "reserved",
          sendProofs,
          serializedToken,
          updatedAt: Date.now(),
          lastError: null,
        },
        walletId,
      );
      if (next.phase !== "reserved") {
        throw new Error("Pending ecash deposit split transition is invalid");
      }
      await requireExactCompletedSplit(next, walletId, operation);
      await db.pendingLocalWalletPayments.put(next);
      return next;
    },
  );
}

export async function recordPendingEcashDepositRemoteStateUnderLock(
  lock: GuiWalletLockContext,
  depositId: string,
  state: PendingEcashDepositRemoteState,
): Promise<void> {
  await updatePendingDeposit(lock, depositId, (row) => ({
    ...requireActiveRecovery(row),
    remoteState: state,
    updatedAt: Date.now(),
    lastError: null,
  }));
}

export async function recordPendingEcashDepositErrorUnderLock(
  lock: GuiWalletLockContext,
  depositId: string,
  error: unknown,
): Promise<void> {
  await updatePendingDeposit(lock, depositId, (row) => ({
    ...requireActiveRecovery(row),
    updatedAt: Date.now(),
    lastError: pendingPaymentError(error),
  }));
}

export async function deferPendingEcashDepositRetryUnderLock(
  lock: GuiWalletLockContext,
  depositId: string,
  outcome: {
    remoteState?: PendingEcashDepositRemoteState;
    error?: unknown;
  },
  attemptedAt = Date.now(),
): Promise<void> {
  const attemptTime = requireRecoveryCursorTimestamp(attemptedAt);
  await updatePendingDeposit(lock, depositId, (row) => {
    requireActiveRecovery(row);
    const effectiveAttemptTime = Math.max(attemptTime, row.updatedAt);
    const retryCount = Math.min(row.retryCount + 1, RETRY_EXPONENT_MAX);
    const delay = Math.min(
      PENDING_ECASH_DEPOSIT_RETRY_BASE_MS * 2 ** row.retryCount,
      PENDING_ECASH_DEPOSIT_RETRY_MAX_MS,
    );
    return {
      ...row,
      ...(outcome.remoteState === undefined
        ? {}
        : { remoteState: outcome.remoteState }),
      retryCount,
      nextAttemptAt: Math.min(
        Number.MAX_SAFE_INTEGER,
        effectiveAttemptTime + delay,
      ),
      updatedAt: effectiveAttemptTime,
      lastError:
        outcome.error === undefined ? null : pendingPaymentError(outcome.error),
    };
  });
}

export async function blockPendingEcashDepositUnderLock(
  lock: GuiWalletLockContext,
  depositId: string,
  error: unknown,
): Promise<void> {
  await updatePendingDeposit(lock, depositId, (row) => ({
    ...row,
    recoveryState: "blocked",
    retryCount: Math.min(row.retryCount + 1, RETRY_EXPONENT_MAX),
    nextAttemptAt: Number.MAX_SAFE_INTEGER,
    updatedAt: Math.max(Date.now(), row.updatedAt),
    lastError: pendingPaymentError(error),
  }));
}

/** Credited is the sole authority to remove the submitted bearer proofs. */
export async function completeCreditedEcashDepositUnderLock(
  lock: GuiWalletLockContext,
  depositId: string,
): Promise<void> {
  const walletId = walletIdFromHeldGuiWalletLock(lock);
  await ensureDurableSwapStorage(walletId);
  const id = requireDepositId(depositId);
  const operation = await requireCanonicalCompletedSplit(
    lock,
    depositSplitOperationId(id),
  );
  await db.transaction(
    "rw",
    db.pendingLocalWalletPayments,
    db.proofs,
    async () => {
      const row = requireExistingPayment(
        await db.pendingLocalWalletPayments.get([walletId, id]),
        walletId,
        id,
      );
      if (row.phase !== "reserved") {
        throw new Error(
          "Credited ecash deposit has no reserved proof authority",
        );
      }
      requireActiveRecovery(row);
      await requireExactCompletedSplit(row, walletId, operation);
      const proofs = await requireReservedSendProofs(row, walletId);
      await db.proofs.bulkDelete(proofs.map(({ proofId }) => proofId));
      await db.pendingLocalWalletPayments.delete([walletId, id]);
    },
  );
}

export async function listPendingEcashDepositsUnderLock(
  lock: GuiWalletLockContext,
  cursor: PendingEcashDepositRecoveryCursor | null = null,
  now = Date.now(),
): Promise<PendingEcashDepositRecoveryPage> {
  const walletId = walletIdFromHeldGuiWalletLock(lock);
  await ensureDurableSwapStorage(walletId);
  const eligibleBefore =
    cursor === null
      ? requireRecoveryCursorTimestamp(now)
      : requireRecoveryCursorTimestamp(cursor.eligibleBefore);
  if (cursor !== null && cursor.nextAttemptAt > eligibleBefore) {
    throw new Error("Pending ecash deposit recovery cursor is invalid");
  }
  const lowerBound =
    cursor === null
      ? [walletId, 0, 0, ""]
      : [
          walletId,
          requireRecoveryCursorTimestamp(cursor.nextAttemptAt),
          requireRecoveryCursorTimestamp(cursor.createdAt),
          requireDepositId(cursor.depositId),
        ];
  const rows = await db.pendingLocalWalletPayments
    .where("[walletId+nextAttemptAt+createdAt+depositId]")
    .between(
      lowerBound,
      [walletId, eligibleBefore, Number.MAX_SAFE_INTEGER, "\uffff"],
      cursor === null,
      true,
    )
    .limit(PENDING_ECASH_DEPOSIT_RECOVERY_LIMIT + 1)
    .toArray();
  const hasMore = rows.length > PENDING_ECASH_DEPOSIT_RECOVERY_LIMIT;
  const records = rows
    .slice(0, PENDING_ECASH_DEPOSIT_RECOVERY_LIMIT)
    .map((row) => normalizePendingPaymentRow(row, walletId));
  const last = records.at(-1);
  return {
    records,
    hasMore,
    nextCursor:
      hasMore && last
        ? {
            eligibleBefore,
            nextAttemptAt: last.nextAttemptAt,
            createdAt: last.createdAt,
            depositId: last.depositId,
          }
        : null,
  };
}

export async function getPendingEcashDepositRecoverySummaryUnderLock(
  lock: GuiWalletLockContext,
): Promise<PendingEcashDepositRecoverySummary> {
  const walletId = walletIdFromHeldGuiWalletLock(lock);
  await ensureDurableSwapStorage(walletId);
  const raw = await db.pendingLocalWalletPayments
    .where("walletId")
    .equals(walletId)
    .limit(PAYMENT_RECORD_LIMIT + 1)
    .toArray();
  if (raw.length > PAYMENT_RECORD_LIMIT) {
    throw new Error("Pending ecash deposit capacity invariant is violated");
  }
  const rows = raw.map((row) => normalizePendingPaymentRow(row, walletId));
  const activeAttempts = rows
    .filter(({ recoveryState }) => recoveryState === "active")
    .map(({ nextAttemptAt }) => nextAttemptAt);
  return {
    nextAttemptAt:
      activeAttempts.length === 0 ? null : Math.min(...activeAttempts),
    blocked: rows
      .filter(({ recoveryState }) => recoveryState === "blocked")
      .map(({ depositId, lastError }) => ({
        depositId,
        error: lastError ?? "Pending ecash deposit authority is blocked",
      })),
  };
}

export async function getPendingEcashDepositUnderLock(
  lock: GuiWalletLockContext,
  depositId: string,
): Promise<PendingLocalWalletPaymentRow | null> {
  const walletId = walletIdFromHeldGuiWalletLock(lock);
  await ensureDurableSwapStorage(walletId);
  const id = requireDepositId(depositId);
  return (
    requirePendingPaymentRow(
      await db.pendingLocalWalletPayments.get([walletId, id]),
      walletId,
      id,
    ) ?? null
  );
}

export async function findPendingEcashDepositBySplitOperationUnderLock(
  lock: GuiWalletLockContext,
  splitOperationId: string,
): Promise<PendingLocalWalletPaymentRow | null> {
  const walletId = walletIdFromHeldGuiWalletLock(lock);
  await ensureDurableSwapStorage(walletId);
  const matches = await db.pendingLocalWalletPayments
    .where("[walletId+splitOperationId]")
    .equals([walletId, splitOperationId])
    .limit(2)
    .toArray();
  if (matches.length > 1) {
    throw new Error("Regular split is bound to multiple ecash deposits");
  }
  return matches[0] ? normalizePendingPaymentRow(matches[0], walletId) : null;
}

export async function requirePendingEcashDepositRemoteAuthorityUnderLock(
  lock: GuiWalletLockContext,
  expected: PendingLocalWalletPaymentRow & ReservedPendingEcashDeposit,
): Promise<PendingLocalWalletPaymentRow & ReservedPendingEcashDeposit> {
  const walletId = walletIdFromHeldGuiWalletLock(lock);
  await ensureDurableSwapStorage(walletId);
  try {
    const operation =
      await requireCompletedGuiWalletProofOperationAuthorityUnderLock(
        lock,
        expected.splitOperationId,
      );
    return await db.transaction(
      "r",
      db.pendingLocalWalletPayments,
      db.proofs,
      async () => {
        const current = requireExistingPayment(
          await db.pendingLocalWalletPayments.get([
            walletId,
            expected.depositId,
          ]),
          walletId,
          expected.depositId,
        );
        if (
          current.phase !== "reserved" ||
          !samePaymentProofSet(current.sendProofs, expected.sendProofs) ||
          !samePendingEcashDepositSerializedToken(
            current.serializedToken,
            expected.serializedToken,
          )
        ) {
          throw new Error("Pending ecash deposit reserved authority changed");
        }
        assertSamePendingBinding(expected, current);
        requireActiveRecovery(current);
        await requireExactCompletedSplit(current, walletId, operation);
        assertPendingEcashDepositTokenMatchesProofs(
          current.serializedToken,
          current.request,
          current.sendProofs,
        );
        return current;
      },
    );
  } catch (error) {
    throw pendingAuthorityError(error);
  }
}

async function requireExactCompletedSplit(
  row: ReservedPendingEcashDeposit,
  walletId: string,
  operation: ProofOperationRecord,
): Promise<ProofOperationRecord> {
  const persistedBaseAsset = operation.metadata.baseAsset;
  const baseAsset =
    typeof persistedBaseAsset === "string"
      ? parseMarketBaseAsset(persistedBaseAsset)
      : null;
  if (
    operation.walletId !== walletId ||
    operation.operationId !== row.splitOperationId ||
    operation.kind !== "regular-split" ||
    operation.state !== "completed" ||
    operation.mintUrl !== row.request.mintUrl ||
    persistedBaseAsset !== baseAsset ||
    baseAsset !== row.request.baseAsset ||
    operation.metadata.unit !== row.request.unit ||
    operation.metadata.amount !== row.request.amountSubunits ||
    !hasExactGroups(operation.outputs, ["send", "keep"])
  ) {
    throw new Error("Pending ecash deposit has no exact completed split");
  }
  const result = exactSplitResult(operation);
  if (!samePaymentProofSet(result.send, row.sendProofs)) {
    throw new Error("Pending ecash deposit send proofs conflict with split");
  }
  assertExactResultDisposition(operation, row.depositId);
  await assertSplitOutputsStored(result, row, walletId);
  return operation;
}

async function requireCanonicalCompletedSplit(
  lock: GuiWalletLockContext,
  operationId: string,
): Promise<ProofOperationRecord> {
  try {
    return await requireCompletedGuiWalletProofOperationAuthorityUnderLock(
      lock,
      operationId,
    );
  } catch (error) {
    throw pendingAuthorityError(error);
  }
}

function pendingAuthorityError(
  error: unknown,
): PendingEcashDepositAuthorityError {
  if (error instanceof PendingEcashDepositAuthorityError) return error;
  return new PendingEcashDepositAuthorityError(
    `Pending ecash deposit authority is corrupt: ${pendingPaymentError(error)}`,
    { cause: error },
  );
}

function assertExactResultDisposition(
  operation: ProofOperationRecord,
  depositId: string,
): void {
  const policy = requireDurableWalletProofTransition(
    operation.metadata,
    Object.keys(operation.outputs),
  );
  const send = policy.resultGroups.send;
  const keep = policy.resultGroups.keep;
  if (
    send?.kind !== "wallet" ||
    send.asset !== "regular" ||
    send.reservedBy !== depositId ||
    keep?.kind !== "wallet" ||
    keep.asset !== "regular" ||
    keep.reservedBy !== null
  ) {
    throw new Error("Pending ecash deposit split reservation plan is invalid");
  }
}

function exactSplitResult(operation: ProofOperationRecord): {
  send: Proof[];
  keep: Proof[];
} {
  if (
    !operation.resultProofs ||
    !hasExactGroups(operation.resultProofs, ["send", "keep"])
  ) {
    throw new Error("Pending ecash deposit completed split result is invalid");
  }
  const send = normalizePendingPaymentProofs(
    operation.resultProofs.send,
    "split send proofs",
  );
  const keep = normalizePendingPaymentProofs(
    operation.resultProofs.keep,
    "split keep proofs",
  );
  const all = [...send, ...keep];
  if (
    all.length === 0 ||
    new Set(all.map(({ secret }) => secret)).size !== all.length
  ) {
    throw new Error("Pending ecash deposit completed split result is invalid");
  }
  return { send, keep };
}

async function assertSplitOutputsStored(
  result: { send: Proof[]; keep: Proof[] },
  row: ReservedPendingEcashDeposit,
  walletId: string,
): Promise<void> {
  const all = [...result.send, ...result.keep];
  const located = locateStoredProofs(
    all,
    row.request.mintUrl,
    row.request.unit,
  );
  const stored = await db.proofs.bulkGet(storedProofIds(located));
  stored.forEach((proof, index) => {
    const expected = all[index]!;
    const isSend = index < result.send.length;
    if (
      !proof ||
      proof.walletId !== walletId ||
      !samePaymentProofValue(proof, expected) ||
      proof.mintUrl !== row.request.mintUrl ||
      proof.baseAsset !== row.request.baseAsset ||
      proof.unit !== row.request.unit ||
      (isSend
        ? proof.reservedBy !== row.depositId
        : proof.reservedBy !== undefined)
    ) {
      throw new Error(
        "Pending ecash deposit split outputs are not durably present",
      );
    }
  });
}

async function requireReservedSendProofs(
  row: ReservedPendingEcashDeposit,
  walletId: string,
): Promise<StoredProofRow[]> {
  const stored = await db.proofs.bulkGet(
    storedProofIds(
      locateStoredProofs(row.sendProofs, row.request.mintUrl, row.request.unit),
    ),
  );
  if (
    stored.some(
      (proof, index) =>
        !proof ||
        proof.walletId !== walletId ||
        proof.reservedBy !== row.depositId ||
        !samePaymentProofValue(proof, row.sendProofs[index]!),
    )
  ) {
    throw new Error("Pending ecash deposit proof reservation is ambiguous");
  }
  return stored as StoredProofRow[];
}

async function updatePendingDeposit(
  lock: GuiWalletLockContext,
  depositId: string,
  update: (row: PendingLocalWalletPaymentRow) => PendingLocalWalletPaymentRow,
): Promise<void> {
  const walletId = walletIdFromHeldGuiWalletLock(lock);
  await ensureDurableSwapStorage(walletId);
  const id = requireDepositId(depositId);
  await db.transaction("rw", db.pendingLocalWalletPayments, async () => {
    const current = requireExistingPayment(
      await db.pendingLocalWalletPayments.get([walletId, id]),
      walletId,
      id,
    );
    const next = normalizePendingPaymentRow(update(current), walletId);
    assertSamePendingBinding(current, next);
    if (current.phase === "reserved" && next.phase !== "reserved") {
      throw new Error("Pending ecash deposit phase cannot regress");
    }
    await db.pendingLocalWalletPayments.put(next);
  });
}

function requireExistingPayment(
  row: PendingLocalWalletPaymentRow | undefined,
  walletId: string,
  depositId: string,
): PendingLocalWalletPaymentRow {
  const existing = requirePendingPaymentRow(row, walletId, depositId);
  if (!existing) throw new Error("Pending ecash deposit is missing");
  return existing;
}

function assertSamePendingBinding(
  left: PendingLocalWalletPaymentRow | PendingLocalWalletPaymentRecord,
  right: PendingLocalWalletPaymentRow | PendingLocalWalletPaymentRecord,
): void {
  if (
    left.depositId !== right.depositId ||
    left.splitOperationId !== right.splitOperationId ||
    !samePendingRequest(left.request, right.request)
  ) {
    throw new Error("Pending ecash deposit conflicts with existing authority");
  }
}

function requireActiveRecovery<T extends PendingLocalWalletPaymentRow>(
  row: T,
): T {
  if (row.recoveryState !== "active") {
    throw new PendingEcashDepositAuthorityError(
      "Pending ecash deposit authority is blocked",
    );
  }
  return row;
}

function samePendingRequest(
  left: PendingEcashDepositRequest,
  right: PendingEcashDepositRequest,
): boolean {
  return (
    left.conditionId === right.conditionId &&
    left.mintUrl === right.mintUrl &&
    left.amountSubunits === right.amountSubunits &&
    left.baseAsset === right.baseAsset &&
    left.unit === right.unit &&
    left.divisibility === right.divisibility &&
    left.fundAmm === right.fundAmm &&
    left.creatorPubkey === right.creatorPubkey &&
    left.fundingIdentity === right.fundingIdentity
  );
}

async function enforcePaymentCapacity(
  walletId: string,
  existing: boolean,
): Promise<void> {
  if (existing) return;
  const count = await db.pendingLocalWalletPayments
    .where("walletId")
    .equals(walletId)
    .count();
  if (count >= PAYMENT_RECORD_LIMIT) {
    throw new Error("Pending ecash deposit capacity is exhausted");
  }
}

function hasExactGroups(
  groups: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(groups).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((value, index) => value === sortedExpected[index])
  );
}

function requireRecoveryCursorTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("Pending ecash deposit recovery cursor is invalid");
  }
  return value as number;
}
