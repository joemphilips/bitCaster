import {
  readDurableCustodyRecoveryPage,
  type DurableCustodyRecord,
  type DurableCustodyRetryReason,
} from "@bitcaster/client-sdk/durableCustody";
import { durableCustodyProofOperationSemanticKind } from "@bitcaster/client-sdk/durableCustodyProofOperation";
import {
  deriveDurableCustodyProofOperationFingerprints,
  deriveDurableCustodyProofResultFingerprint,
} from "@bitcaster/client-sdk/durableCustodyProofOperationRecord";
import type { CtfProofOperationRecord } from "@bitcaster/client-sdk/ctfSplit";
import { recoverGuiCtfRedeemOperation } from "@/lib/cashu";
import { recoverGuiConditionRegistrationOperation } from "@/lib/marketRegistrationFee";
import { assertNever } from "@/lib/enumDiscipline";
import {
  recoverGuiOrdinaryWalletOperation,
  type GuiOrdinaryWalletRecoveryOutcome,
} from "./gui-ordinary-wallet-operation";
import {
  isAbortedExpiredGuiWalletMint,
  requireCompletedGuiWalletProofOperationAuthorityForWallet,
} from "./gui-wallet-proof-operation-custody";
import { normalizeUrl } from "@/lib/url";
import { decodeOperationRow, sameValue } from "./durable-custody-dexie-model";
import { DexieDurableCustodyStore } from "./durable-custody-dexie";
import {
  acquireGuiCustodyAuthority,
  currentGuiWalletContext,
  guiWalletContextFromHeldLock,
  releaseGuiCustodyAuthority,
  tryWithGuiCustodyProfileLock,
  withGuiCustodyProfileLockForWallet,
} from "./gui-custody-authority";
import type { GuiWalletLockContext } from "./gui-wallet-lock";
import {
  guiWalletSendTokenFingerprint,
  readGuiWalletSendDeliveryMetadata,
  requireGuiWalletSendDeliveryPayloadRow,
  requireExactGuiWalletSendUserExportToken,
  type GuiWalletSendDeliveryPayloadRow,
} from "./gui-wallet-send-delivery";
import {
  db,
  ensureDurableSwapStorage,
  proofOperationPrimaryKey,
  requireProofOperationRecord,
  type ProofOperationRecord,
} from "./proof-db";

export type GuiNativeProofRecoveryStatus = "clear" | "pending" | "blocked";

export const GUI_NATIVE_PROOF_RECOVERY_PAGE_SIZE = 16;
const NATIVE_RECOVERY_RETRY_BASE_MS = 1_000;
const NATIVE_RECOVERY_RETRY_MAX_MS = 60_000;
const NATIVE_RECOVERY_TIMER_MAX_MS = 2_147_483_647;
const activeRecoveryByWallet = new Map<
  string,
  Promise<GuiNativeProofRecoveryStatus>
>();
let scheduledRecovery: ScheduledNativeRecovery | null = null;
let nativeRecoveryPageSize = GUI_NATIVE_PROOF_RECOVERY_PAGE_SIZE;
let nativeRecoveryTimer: NativeRecoveryTimer = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

interface ScheduledNativeRecovery {
  timer: unknown;
}

interface NativeRecoveryTimer {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(timer: unknown): void;
}

interface NativeRecoveryCycle {
  status: GuiNativeProofRecoveryStatus;
  nextAttemptAtMs: number | null;
}

/** Coalesces React, online, and visibility triggers for one wallet profile. */
export function requestGuiNativeProofOperationRecovery(): Promise<GuiNativeProofRecoveryStatus> {
  const walletId = currentGuiWalletContext().walletId;
  const existing = activeRecoveryByWallet.get(walletId);
  if (existing) return existing;
  const recovery = recoverGuiNativeProofOperationsForWallet(walletId)
    .then((cycle) => {
      scheduleNativeRecoveryWake(walletId, cycle.nextAttemptAtMs);
      return cycle.status;
    })
    .finally(() => {
      if (activeRecoveryByWallet.get(walletId) === recovery) {
        activeRecoveryByWallet.delete(walletId);
      }
    });
  activeRecoveryByWallet.set(walletId, recovery);
  return recovery;
}

export async function recoverGuiNativeProofOperations(): Promise<GuiNativeProofRecoveryStatus> {
  return requestGuiNativeProofOperationRecovery();
}

export function __resetGuiNativeProofOperationRecoverySchedulerForTests(): void {
  clearScheduledNativeRecovery();
  activeRecoveryByWallet.clear();
  nativeRecoveryPageSize = GUI_NATIVE_PROOF_RECOVERY_PAGE_SIZE;
  nativeRecoveryTimer = {
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    cancel: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  };
}

export function __setGuiNativeProofOperationRecoveryPageSizeForTests(
  pageSize: number,
): void {
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > GUI_NATIVE_PROOF_RECOVERY_PAGE_SIZE
  ) {
    throw new Error("GUI native recovery test page size is invalid");
  }
  nativeRecoveryPageSize = pageSize;
}

export function __setGuiNativeProofOperationRecoveryTimerForTests(
  timer: NativeRecoveryTimer,
): void {
  clearScheduledNativeRecovery();
  nativeRecoveryTimer = timer;
}

async function recoverGuiNativeProofOperationsForWallet(
  walletId: string,
): Promise<NativeRecoveryCycle> {
  await ensureDurableSwapStorage(walletId);
  const context = currentGuiWalletContext();
  if (context.walletId !== walletId) return blockedCycle();
  const store = new DexieDurableCustodyStore(db);
  try {
    if ((await store.readScope(context.scope)) === null) return clearCycle();
  } catch {
    return blockedCycle();
  }
  let cursor: string | null = null;
  let status: GuiNativeProofRecoveryStatus = "clear";
  let nextAttemptAtMs: number | null = null;
  do {
    let page;
    try {
      page = await readDurableCustodyRecoveryPage(store, {
        scope: context.scope,
        cursor,
        limit: nativeRecoveryPageSize,
      });
    } catch {
      return blockedCycle();
    }
    for (const record of page.records) {
      if (record.operation.binding.kind === "trade") continue;
      const persistedWake = record.operation.retry.nextAttemptAtMs;
      if (persistedWake !== null && persistedWake > Date.now()) {
        status = mergeStatus(status, "pending");
        nextAttemptAtMs = earliestWake(nextAttemptAtMs, persistedWake);
        continue;
      }
      const attempt = await attemptNativeRecovery(
        walletId,
        record.operation.operationId,
      );
      status = mergeStatus(status, attempt.status);
      nextAttemptAtMs = earliestWake(nextAttemptAtMs, attempt.nextAttemptAtMs);
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  return { status, nextAttemptAtMs };
}

async function attemptNativeRecovery(
  walletId: string,
  custodyOperationId: string,
): Promise<NativeRecoveryCycle> {
  try {
    const beforeAttempt = await tryReadExactNativeOperation(
      walletId,
      custodyOperationId,
    );
    if (!beforeAttempt.acquired) return shortPendingCycle();
    const before = beforeAttempt.value;
    if (before === null) return blockedCycle();
    if (before.canonical.operation.binding.kind === "trade") {
      return clearCycle();
    }
    const validation = await validateNativePairAuthority(
      before,
      walletId,
      custodyOperationId,
    );
    if (validation !== "active") return statusCycle(validation);
    if (!isSupportedNativeOperation(before.native)) return blockedCycle();
    let outcome: NativeDispatchOutcome;
    try {
      outcome = await dispatchNativeRecovery(structuredClone(before.native));
    } catch {
      // The exact post-dispatch rows decide whether an apparent error committed.
      outcome = isOrdinaryWalletOperation(before.native)
        ? { kind: "blocked" }
        : { kind: "unresolved" };
    }
    const inspection = await inspectNativeRecoveryResult(
      walletId,
      custodyOperationId,
      before,
    );
    switch (inspection.status) {
      case "clear":
        return clearCycle();
      case "blocked":
        return blockedCycle();
      case "pending":
        break;
      default:
        return assertNever(inspection.status);
    }
    if (inspection.after === null) return shortPendingCycle();
    if (outcome.kind === "blocked") return blockedCycle();
    if (outcome.kind !== "retry-later") return pendingCycle(null);
    if (!sameValue(before, inspection.after)) {
      return blockedCycle();
    }
    const nextAttemptAtMs = await persistExactNativeRetry(
      walletId,
      custodyOperationId,
      inspection.after,
      outcome.reason,
    );
    return pendingCycle(nextAttemptAtMs);
  } catch {
    return blockedCycle();
  }
}

async function inspectNativeRecoveryResult(
  walletId: string,
  custodyOperationId: string,
  before: ExactNativeOperation,
): Promise<NativeRecoveryInspection> {
  const afterAttempt = await tryReadExactNativeOperation(
    walletId,
    custodyOperationId,
  );
  if (!afterAttempt.acquired) {
    return { status: "pending", after: null };
  }
  const after = afterAttempt.value;
  if (after === null || after.canonical.operation.binding.kind === "trade") {
    return { status: "blocked", after: null };
  }
  const afterValidation = await validateNativePairAuthority(
    after,
    walletId,
    custodyOperationId,
  );
  if (!sameNativeRecoveryAuthority(before, after)) {
    return { status: "blocked", after };
  }
  return {
    status: afterValidation === "active" ? "pending" : afterValidation,
    after,
  };
}

interface NativeRecoveryInspection {
  status: GuiNativeProofRecoveryStatus;
  after: ExactNativeOperation | null;
}

async function persistExactNativeRetry(
  walletId: string,
  custodyOperationId: string,
  expected: ExactNativeOperation,
  reason: DurableCustodyRetryReason,
): Promise<number> {
  return withGuiCustodyProfileLockForWallet(
    walletId,
    async (_context, lock) => {
      let authority: Awaited<
        ReturnType<typeof acquireGuiCustodyAuthority>
      > | null = null;
      try {
        const current = await readExactNativeOperation(
          lock,
          custodyOperationId,
        );
        if (
          current === null ||
          validateNativePair(current, walletId, custodyOperationId) !==
            "active" ||
          !sameValue(current, expected)
        ) {
          throw new Error("GUI native retry authority changed");
        }
        const acquired = await acquireGuiCustodyAuthority(lock);
        authority = acquired;
        return await acquired.store.transact(
          {
            scope: acquired.scope,
            owner: acquired.owner,
            operationIds: [custodyOperationId],
          },
          (transaction) => {
            const operation = transaction.getOperation(custodyOperationId);
            if (!operation || !sameValue(operation, current.canonical)) {
              throw new Error("GUI canonical retry authority changed");
            }
            const effectiveNowMs = Math.max(
              transaction.getScopeState().effectiveClock.highWaterMarkMs,
              acquired.owner.observedAtMs,
            );
            const nextAttemptAtMs =
              effectiveNowMs + retryDelayMs(operation.operation.retry.attempt);
            if (!Number.isSafeInteger(nextAttemptAtMs)) {
              throw new Error("GUI native retry deadline overflowed");
            }
            transaction.transitionOperation({
              operationId: custodyOperationId,
              transition: {
                kind: "retry-scheduled",
                reason,
                nextAttemptAtMs,
              },
            });
            transaction.rebuildActiveWorkIndex();
            return nextAttemptAtMs;
          },
        );
      } finally {
        if (authority !== null) {
          await releaseGuiCustodyAuthority(lock, authority);
        }
      }
    },
  );
}

function retryDelayMs(previousAttempt: number): number {
  const exponent = Math.min(previousAttempt, 16);
  return Math.min(
    NATIVE_RECOVERY_RETRY_BASE_MS * 2 ** exponent,
    NATIVE_RECOVERY_RETRY_MAX_MS,
  );
}

async function validateNativePairAuthority(
  pair: ExactNativeOperation,
  walletId: string,
  custodyOperationId: string,
): Promise<GuiNativeProofRecoveryStatus | "active"> {
  const validation = validateNativePair(pair, walletId, custodyOperationId);
  if (validation === "clear" && pair.native.state === "completed") {
    await requireCompletedGuiWalletProofOperationAuthorityForWallet(
      walletId,
      pair.native.operationId,
    );
  }
  return validation;
}

interface ExactNativeOperation {
  canonical: DurableCustodyRecord;
  active: 0 | 1;
  native: ProofOperationRecord;
  walletSendDeliveryPayload: GuiWalletSendDeliveryPayloadRow | null;
}

async function tryReadExactNativeOperation(
  walletId: string,
  custodyOperationId: string,
) {
  return tryWithGuiCustodyProfileLock(async (context, lock) => {
    try {
      return await readExactNativeOperation(lock, custodyOperationId);
    } finally {
      await releaseGuiCustodyAuthority(lock, context.scope);
    }
  }, walletId);
}

async function readExactNativeOperation(
  lock: GuiWalletLockContext,
  custodyOperationId: string,
): Promise<ExactNativeOperation | null> {
  const context = guiWalletContextFromHeldLock(lock);
  await ensureDurableSwapStorage(context.walletId);
  return db.transaction(
    "r",
    db.custodyOperations,
    db.proofOperations,
    db.walletSendDeliveryPayloads,
    async () => {
      const row = await db.custodyOperations.get(custodyOperationId);
      if (!row) return null;
      const canonical = decodeOperationRow(row, context.scope);
      const retainedOperationKey = canonical.operation.retainedOperationKey;
      const nativeRow = await db.proofOperations.get(
        proofOperationPrimaryKey(context.walletId, retainedOperationKey),
      );
      if (!nativeRow) return null;
      const native = requireProofOperationRecord(
        nativeRow,
        context.walletId,
        retainedOperationKey,
      );
      const rawPayload = await db.walletSendDeliveryPayloads.get([
        context.walletId,
        retainedOperationKey,
      ]);
      const walletSendDeliveryPayload = rawPayload
        ? requireGuiWalletSendDeliveryPayloadRow(
            rawPayload,
            context.walletId,
            retainedOperationKey,
            canonical.operation.operationId,
          )
        : null;
      return {
        canonical: structuredClone(canonical),
        active: row.active,
        native: structuredClone(native),
        walletSendDeliveryPayload,
      };
    },
  );
}

function validateNativePair(
  pair: ExactNativeOperation,
  expectedWalletId: string,
  expectedCustodyOperationId: string,
): GuiNativeProofRecoveryStatus | "active" {
  const { canonical, native } = pair;
  const binding = canonical.operation.binding;
  if (
    binding.kind !== "wallet" ||
    canonical.scope.scopeKind !== "wallet" ||
    canonical.scope.walletId !== expectedWalletId ||
    canonical.operation.operationId !== expectedCustodyOperationId ||
    native.walletId !== canonical.scope.walletId ||
    native.operationId !== canonical.operation.retainedOperationKey ||
    native.custodyOperationId !== canonical.operation.operationId ||
    native.durableTradeRecovery !== undefined ||
    native.durableTradeId !== undefined ||
    binding.activityId !== native.operationId ||
    normalizeUrl(native.mintUrl) !==
      canonical.operation.custodyContext.normalizedMint ||
    durableCustodyProofOperationSemanticKind(native.kind) !==
      canonical.operation.semanticKind ||
    !nativeRequestMatchesCanonical(native, canonical)
  ) {
    return "blocked";
  }
  if (pair.active === 0) {
    return inactiveNativePairHasExactResult(canonical, native)
      ? "clear"
      : "blocked";
  }
  if (isPendingUserExportDeliveryPair(pair)) return "clear";
  const exactActiveState =
    (canonical.operation.state === "dispatch-intent" &&
      native.state === "prepared") ||
    (canonical.operation.state === "transport-attempted" &&
      native.state === "mint-submitted");
  return exactActiveState ? "active" : "blocked";
}

function isPendingUserExportDeliveryPair(pair: ExactNativeOperation): boolean {
  const { canonical, native, walletSendDeliveryPayload } = pair;
  if (!walletSendDeliveryPayload) return false;
  const delivery = canonical.operation.delivery;
  let tokenFingerprint: string;
  try {
    tokenFingerprint = guiWalletSendTokenFingerprint(
      requireExactGuiWalletSendUserExportToken(
        native,
        walletSendDeliveryPayload,
      ),
    );
  } catch {
    return false;
  }
  return (
    native.kind === "wallet-send" &&
    native.state === "completed" &&
    readGuiWalletSendDeliveryMetadata(native)?.mode === "user-export" &&
    inactiveNativePairHasExactResult(canonical, native) &&
    delivery.deliveryKind === "outbox" &&
    delivery.deliveryId ===
      `delivery:${canonical.operation.operationId}:wallet-send` &&
    delivery.payloadHandle === `wallet-send:${native.operationId}` &&
    delivery.payloadFingerprint === tokenFingerprint &&
    delivery.expiresAtMs === null &&
    delivery.state === "pending"
  );
}

function inactiveNativePairHasExactResult(
  canonical: DurableCustodyRecord,
  native: ProofOperationRecord,
): boolean {
  if (isAbortedExpiredGuiWalletMint(canonical, native)) return true;
  if (
    canonical.operation.state !== "reconciled" ||
    canonical.operation.result.state !== "applied" ||
    canonical.operation.result.outputPlanFingerprint !==
      canonical.operation.outputPlan.outputPlanFingerprint
  ) {
    return false;
  }
  if (native.state === "Failed") return true;
  if (native.state !== "completed" || !native.resultProofs) return false;
  try {
    return (
      deriveDurableCustodyProofResultFingerprint(native.resultProofs) ===
      canonical.operation.result.resultFingerprint
    );
  } catch {
    return false;
  }
}

function nativeRequestMatchesCanonical(
  native: ProofOperationRecord,
  canonical: DurableCustodyRecord,
): boolean {
  const metadata = immutableNativeMetadata(native);
  if (metadata === null) return false;
  const fingerprints = deriveDurableCustodyProofOperationFingerprints({
    ...native,
    metadata,
  });
  return (
    fingerprints.requestFingerprint ===
      canonical.operation.exactRequest.requestFingerprint &&
    fingerprints.outputPlanFingerprint ===
      canonical.operation.outputPlan.outputPlanFingerprint
  );
}

function sameNativeRecoveryAuthority(
  before: ExactNativeOperation,
  after: ExactNativeOperation,
): boolean {
  return (
    sameValue(
      immutableCanonicalAuthority(before.canonical),
      immutableCanonicalAuthority(after.canonical),
    ) &&
    sameValue(
      immutableNativeAuthority(before.native),
      immutableNativeAuthority(after.native),
    ) &&
    sameValue(
      compactWalletSendDeliveryPayload(before.walletSendDeliveryPayload),
      compactWalletSendDeliveryPayload(after.walletSendDeliveryPayload),
    )
  );
}

function compactWalletSendDeliveryPayload(
  payload: GuiWalletSendDeliveryPayloadRow | null,
) {
  return payload === null
    ? null
    : {
        walletId: payload.walletId,
        operationId: payload.operationId,
        custodyOperationId: payload.custodyOperationId,
        tokenDigest: payload.tokenDigest,
        tokenByteLength: payload.tokenByteLength,
        createdAt: payload.createdAt,
      };
}

function immutableCanonicalAuthority(record: DurableCustodyRecord) {
  const operation = record.operation;
  return {
    scope: record.scope,
    operationId: operation.operationId,
    retainedOperationKey: operation.retainedOperationKey,
    binding: operation.binding,
    semanticKind: operation.semanticKind,
    terminalReplayEvidenceRequired: operation.terminalReplayEvidenceRequired,
    custodyContext: operation.custodyContext,
    reservation: operation.reservation,
    exactRequest: operation.exactRequest,
    outputPlan: operation.outputPlan,
    privateMaterial: operation.privateMaterial,
    verification: operation.verification,
    horizon: operation.horizon,
  };
}

function immutableNativeAuthority(operation: ProofOperationRecord) {
  return {
    walletId: operation.walletId,
    operationId: operation.operationId,
    kind: operation.kind,
    mintUrl: operation.mintUrl,
    inputs: operation.inputs,
    outputs: operation.outputs,
    metadata: immutableNativeMetadata(operation),
    custodyOperationId: operation.custodyOperationId,
    durableOperationId: operation.durableOperationId,
    durableTradeId: operation.durableTradeId,
    durableTradeRecovery: operation.durableTradeRecovery,
  };
}

function immutableNativeMetadata(
  operation: ProofOperationRecord,
): Record<string, unknown> | null {
  const metadata = structuredClone(operation.metadata);
  const version = metadata.redeemMintSubmissionVersion;
  const digest = metadata.redeemMintSubmissionRequestDigest;
  if (version === undefined && digest === undefined) return metadata;
  if (
    operation.kind !== "ctf-redeem" ||
    version !== 1 ||
    typeof digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(digest)
  ) {
    return null;
  }
  delete metadata.redeemMintSubmissionVersion;
  delete metadata.redeemMintSubmissionRequestDigest;
  return metadata;
}

type SupportedNativeOperation =
  | (ProofOperationRecord &
      CtfProofOperationRecord & {
        kind: "ctf-redeem" | "ctf-condition-registration";
      })
  | (ProofOperationRecord & {
      kind: "wallet-mint" | "wallet-receive" | "wallet-send";
    });

function isSupportedNativeOperation(
  operation: ProofOperationRecord,
): operation is SupportedNativeOperation {
  return (
    operation.kind === "ctf-redeem" ||
    operation.kind === "ctf-condition-registration" ||
    operation.kind === "wallet-mint" ||
    operation.kind === "wallet-receive" ||
    operation.kind === "wallet-send"
  );
}

function isOrdinaryWalletOperation(
  operation: ProofOperationRecord,
): operation is ProofOperationRecord & {
  kind: "wallet-mint" | "wallet-receive" | "wallet-send";
} {
  return (
    operation.kind === "wallet-mint" ||
    operation.kind === "wallet-receive" ||
    operation.kind === "wallet-send"
  );
}

type NativeDispatchOutcome =
  | GuiOrdinaryWalletRecoveryOutcome
  | { kind: "unresolved" };

async function dispatchNativeRecovery(
  operation: SupportedNativeOperation,
): Promise<NativeDispatchOutcome> {
  switch (operation.kind) {
    case "ctf-redeem":
      await recoverGuiCtfRedeemOperation(operation);
      return { kind: "settled" };
    case "ctf-condition-registration":
      await recoverGuiConditionRegistrationOperation(operation);
      return { kind: "settled" };
    case "wallet-mint":
    case "wallet-receive":
    case "wallet-send":
      return recoverGuiOrdinaryWalletOperation(operation);
    default:
      throw new Error("Unsupported native proof operation");
  }
}

function mergeStatus(
  left: GuiNativeProofRecoveryStatus,
  right: GuiNativeProofRecoveryStatus,
): GuiNativeProofRecoveryStatus {
  if (left === "blocked" || right === "blocked") return "blocked";
  if (left === "pending" || right === "pending") return "pending";
  return "clear";
}

function clearCycle(): NativeRecoveryCycle {
  return { status: "clear", nextAttemptAtMs: null };
}

function blockedCycle(): NativeRecoveryCycle {
  return { status: "blocked", nextAttemptAtMs: null };
}

function statusCycle(
  status: GuiNativeProofRecoveryStatus,
): NativeRecoveryCycle {
  return { status, nextAttemptAtMs: null };
}

function pendingCycle(nextAttemptAtMs: number | null): NativeRecoveryCycle {
  return { status: "pending", nextAttemptAtMs };
}

function shortPendingCycle(): NativeRecoveryCycle {
  return pendingCycle(Date.now() + NATIVE_RECOVERY_RETRY_BASE_MS);
}

function earliestWake(
  current: number | null,
  candidate: number | null,
): number | null {
  if (candidate === null) return current;
  return current === null ? candidate : Math.min(current, candidate);
}

function scheduleNativeRecoveryWake(
  walletId: string,
  nextAttemptAtMs: number | null,
): void {
  try {
    if (currentGuiWalletContext().walletId !== walletId) return;
  } catch {
    return;
  }
  clearScheduledNativeRecovery();
  if (nextAttemptAtMs === null) return;
  const delay = Math.min(
    Math.max(1, nextAttemptAtMs - Date.now()),
    NATIVE_RECOVERY_TIMER_MAX_MS,
  );
  const timer = nativeRecoveryTimer.schedule(() => {
    if (scheduledRecovery?.timer !== timer) return;
    scheduledRecovery = null;
    try {
      if (currentGuiWalletContext().walletId !== walletId) return;
      void requestGuiNativeProofOperationRecovery().catch(() => undefined);
    } catch {
      // A missing or changed seed makes this stale wallet wake ineligible.
    }
  }, delay);
  scheduledRecovery = { timer };
}

function clearScheduledNativeRecovery(): void {
  if (scheduledRecovery === null) return;
  nativeRecoveryTimer.cancel(scheduledRecovery.timer);
  scheduledRecovery = null;
}
