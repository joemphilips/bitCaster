/**
 * Drives the bitCaster atomic-swap protocol from MATCHED to CONFIRMED.
 *
 * Mounted once at the application root alongside `usePendingTradesPoller`. The
 * poller surfaces direct fills with a `tradeId` to `activeSwaps`; for
 * complementary reservations the engine can also push `TradeCreated` directly
 * to the user's TradeHub connection before a fill exists. This hook handles
 * both entry points, joins the channel, and runs the seller or buyer branch of
 * `atomicSwap.ts` as the engine relays the counterparty's encrypted messages.
 *
 * Lifecycle per swap:
 *   1. `activeSwaps.promote()` — populated either by order-status polling when
 *      a direct fill with a tradeId is observed, or by matching a pushed
 *      complementary `TradeCreated` event to a pending order plus the
 *      match-time ephemeral key in `pendingPubkeySubmissions`.
 *   2. `joinTrade(tradeId)` — register interest with the engine.
 *   3. `TradeCreated` — decide the local role from sellerPubkey vs our
 *      match-time ephemeral pubkey, and remember locktimes.
 *   4. Drive the role-specific message exchange.
 *      - Seller: `sellerPrepareSwap`, send `adaptor-point` and
 *        `locked-proofs-seller`.
 *      - Buyer: wait for both seller messages, run `buyerPrepareSwap`,
 *        send `locked-proofs-buyer`.
 *   5. `TradeStateChanged → Settling` — both halves are in flight. Each
 *      side claims at the mint and emits `settlement-complete`.
 *      - Seller: `sellerClaimSwap` adapts buyer's pre-sigs and swaps.
 *      - Buyer: poll NUT-07 with `buyerExtractSecret` until the adaptor
 *        secret is recoverable, then `buyerClaimSwap`.
 *   6. `TradeStateChanged → Confirmed` — toast, drop ephemeral state.
 *
 * SECURITY: every received pre-sig is verified inside `atomicSwap.ts` before
 * `adapt()` is invoked. `cashu-ts.receive()` performs DLEQ verification
 * during the swap-and-mint step. We never write the locked-half proofs into
 * the wallet — only the fresh proofs returned by the mint.
 */

import { useEffect, useRef, useState } from "react";
import type { Proof, Wallet as CashuWallet } from "@cashu/cashu-ts";
import {
  useTradeHub,
  type TradeCreatedPayload,
  type SwapMessage,
} from "@/hooks/useTradeHub";
import {
  createActiveSwap,
  useActiveSwapsStore,
  type ActiveSwap,
  type SwapRole,
} from "@/stores/activeSwaps";
import {
  classifyDurableTradeRecoveryDisposition,
  type DurableTradeMintRecoveryState,
} from "@bitcaster/client-sdk/durableTradeRecovery";
import {
  clearGuiPendingTradeCache,
  getCurrentGuiPendingTrade,
  getCurrentGuiPendingTrades,
  isCurrentGuiPendingTrade,
  loadGuiPendingTrades,
  persistGuiPendingTrade,
  removeGuiPendingTrade,
  replaceGuiPendingTradeCache,
  usePendingTradesStore,
  type PendingTradeRecord,
} from "@/stores/pendingTrades";
import { usePendingPubkeySubmissionsStore } from "@/stores/pendingPubkeySubmissions";
import { emitTradeTerminal } from "@/lib/tradeTerminalEvents";
import { useWalletStore } from "@/stores/wallet";
import { Mint as CashuMint } from "@cashu/cashu-ts";
import {
  currentGuiWalletId,
  getUnitProofsUnderLock,
  getOutcomeProofsUnderLock,
  getProofOperationUnderLock,
  releaseProofReservationUnderLock,
  tryReserveProofsUnderLock,
  type StoredProof,
} from "@/stores/proof-db";
import {
  walletIdFromHeldGuiWalletLock,
  type GuiWalletLockContext,
} from "@/stores/gui-wallet-lock";
import {
  fetchOrderStatus,
  promoteFillsToActiveSwaps,
  splitMarketId,
} from "@/lib/orderStatus";
import { generateEphemeralKeyPair } from "@/lib/ephemeral-key";
import { submitEphemeralPubkey, submitOrder } from "@/lib/markets";
import { hexToBytes } from "@bitcaster/swap-protocol/ecdh";
import {
  buyerClaimSwap,
  buyerExtractSecret,
  buyerPrepareSwap,
  generateAdaptorPoint,
  inspectExactPreparedProofOperation,
  restoreExactPreparedProofOperation,
  resumeExactPreparedProofOperation,
  sellerClaimSwap,
  sellerLockOutcomeProofs,
  sellerPreparePersistedPrelockedSwap,
  type ProofOperationRecord as SwapProofOperationRecord,
} from "@bitcaster/swap-protocol/atomicSwap";
import {
  computeGrossCtfInputAmountSats,
  resolveRootDirectLockOutputAmountSats,
  selectCollateralForCtfSplit,
  splitRegularProofsWithOperation,
  splitRootCompleteSetForSwap,
} from "@/lib/ctfSplit";
import { useToastStore } from "@/stores/toast";
import { commitGuiPartialLockFailureUnderLock } from "@/stores/partial-lock-failure-db";
import {
  loadRecoverableGuiSwapSessions,
  loadRecoverableGuiTradeOperationPage,
  loadGuiSwapSessionStateUnderLock,
  persistGuiSwapSessionUnderLock,
  recordGuiRecoveredProofOperationOutputsUnderLock,
  recoverGuiDurableTradeSession,
  withGuiSwapSessionOwnership,
  type GuiDurableTradeRecoveryInput,
} from "@/stores/swap-session-db";
import {
  loadGuiPendingSwapIntents,
  getGuiPendingSwapIntent,
} from "@/stores/pending-swap-intent-db";
import { submitAdmittedGuiPendingSwapIntents } from "@/stores/gui-pretrade-storage";
import type { PartialLockHeldRecord } from "@bitcaster/client-sdk/swapFailure";
import {
  TRADE_MESSAGE_TYPES,
  type SwapCipherMessageType,
  type TradeMessageType,
} from "@/lib/tradeMessageTypes";
import {
  decideSwapMessage,
  decideTradeCreated,
  decideTradeStateChanged,
} from "@bitcaster/client-sdk/tradeFlow";
import {
  canRecoverFailedTakerFill,
  recoverFailedTakerFill,
  retryTransientTradeOperation,
} from "@bitcaster/client-sdk/tradeRecovery";
import {
  amountToNumber,
  takeProofsForLock,
} from "@bitcaster/client-sdk/proofSelection";
import {
  defaultCollateralUnit,
  normalizeMarketBaseAsset,
} from "@bitcaster/client-sdk/marketUnits";
import { parseOutcomeSetId } from "@bitcaster/client-sdk/outcomeSets";
import { storedConditionalProofsFromMintMetadata } from "@/lib/conditionalKeysetMetadata";
import { resolveGrossCtfInputPlanningKeyset } from "@/lib/ctfGrossInputPlanning";
import { normalizeUrl } from "@/lib/url";
import {
  ctfGuiProofOperationStore,
  externalClaimGuiProofOperationStore,
  localLockGuiProofOperationStore,
  regularSplitGuiProofOperationStore,
} from "@/stores/gui-trade-proof-operation-store";
import {
  guiTradeRefundDueAtMs,
  guiTradeRefundEvidenceUnderLock,
  isGuiTradeRefundLink,
  prepareGuiTradeRefund,
  salvageGuiTradeRefund,
} from "@/stores/gui-trade-refund-recovery";
import {
  releaseGuiCustodyAuthority,
  tryWithGuiCustodyProfileLock,
} from "@/stores/gui-custody-authority";

// ---------------------------------------------------------------------------
// Public hook
// ---------------------------------------------------------------------------

type ExactGuiRecoveryOperation = {
  entry: SwapProofOperationRecord;
  wallet: CashuWallet;
};

async function loadExactGuiRecoveryOperationUnlocked(
  input: OwnedGuiSwapRecovery,
  operation: {
    operationId: string;
    operationKey?: string;
    tradeId: string;
  },
): Promise<ExactGuiRecoveryOperation> {
  const { entry } = await withGuiSwapSessionOwnership(
    input.tradeId,
    async (lock) => {
      const exact = await loadExactGuiRecoveryOperationEntry(lock, operation);
      return { entry: exact };
    },
    input.expectedWalletId,
  );
  const unit = entry.metadata.unit;
  if (typeof unit !== "string" || !unit) {
    throw new Error(
      `Durable operation ${operation.operationId} has no exact Cashu unit`,
    );
  }
  const wallet = await useWalletStore
    .getState()
    .getWalletForUnit(entry.mintUrl, unit, {
      enableCtf: entry.kind === "conditional-keyset-swap",
      expectedWalletId: input.expectedWalletId,
    });
  return { entry, wallet };
}

async function loadExactGuiRecoveryOperationEntry(
  lock: GuiWalletLockContext,
  operation: {
    operationId: string;
    operationKey?: string;
    tradeId: string;
  },
): Promise<SwapProofOperationRecord> {
  if (!operation.operationKey) {
    throw new Error(
      `Durable operation ${operation.operationId} has no local key`,
    );
  }
  const entry = await getProofOperationUnderLock(lock, operation.operationKey);
  if (
    !entry ||
    entry.durableTradeRecovery?.operationId !== operation.operationId ||
    entry.durableTradeRecovery?.operationKey !== operation.operationKey ||
    entry.durableTradeRecovery?.tradeId !== operation.tradeId
  ) {
    throw new Error(
      `Durable operation ${operation.operationId} is not bound to its proof ledger row`,
    );
  }
  return entry as SwapProofOperationRecord;
}

async function applyExactGuiRecoveryOutputs(
  lock: GuiWalletLockContext,
  tradeId: string,
  operation: { operationId: string; operationKey?: string },
  resultProofs: Record<string, Proof[]>,
): Promise<void> {
  await recordGuiRecoveredProofOperationOutputsUnderLock(
    lock,
    tradeId,
    operation.operationId,
    resultProofs,
  );
}

function applyExactGuiRecoveryOutputsUnlocked(
  input: OwnedGuiSwapRecovery,
  operation: { operationId: string; operationKey?: string },
  resultProofs: Record<string, Proof[]>,
): Promise<void> {
  return withGuiSwapSessionOwnership(
    input.tradeId,
    (lock) =>
      applyExactGuiRecoveryOutputs(
        lock,
        input.tradeId,
        operation,
        resultProofs,
      ),
    input.expectedWalletId,
  );
}

async function recoverGuiSwapBeforeResume(
  tradeId: string,
  joinTrade: (tradeId: string) => Promise<void>,
  sendSwapMessage: SendSwapMessageFn,
  expectedWalletId: string,
  wakeRecovery: () => void,
): Promise<"continue" | "blocked" | "retained"> {
  const transport = createGuiRecoveryTransportPlan();
  const disposition = await recoverOwnedGuiSwap({
    tradeId,
    expectedWalletId,
    joinTrade,
    sendSwapMessage,
    wakeRecovery,
    transport,
  });
  try {
    return (await deliverGuiRecoveryTransportPlan(
      transport,
      expectedWalletId,
      joinTrade,
      sendSwapMessage,
    ))
      ? disposition
      : "blocked";
  } catch {
    return "blocked";
  }
}

interface GuiRecoveryTransportPlan {
  join: GuiTradeJoinDelivery | null;
  ciphers: GuiSwapCipherDelivery[];
}

function createGuiRecoveryTransportPlan(): GuiRecoveryTransportPlan {
  return { join: null, ciphers: [] };
}

interface OwnedGuiSwapRecovery {
  tradeId: string;
  expectedWalletId: string;
  joinTrade: (tradeId: string) => Promise<void>;
  sendSwapMessage: SendSwapMessageFn;
  wakeRecovery: () => void;
  transport: GuiRecoveryTransportPlan;
}

async function recoverOwnedGuiSwap(
  input: OwnedGuiSwapRecovery,
): Promise<"continue" | "blocked" | "retained"> {
  const first = await runGuiDurableRecovery(input);
  const firstDisposition = requireGuiRecoveryDisposition(first, input.tradeId);
  if (firstDisposition !== "ready") {
    return retainOrBlockGuiRecovery(input, firstDisposition);
  }
  const exact = await loadExactGuiSwapForRecovery(input);
  if (!exact) return "blocked";
  if (exact.step !== "awaiting-refund") {
    clearGuiTradeRecoveryWakeup(input.expectedWalletId, input.tradeId);
    replaceActiveSwap(exact);
    return "continue";
  }
  return recoverOwnedGuiRefund(input, exact);
}

async function recoverOwnedGuiRefund(
  input: OwnedGuiSwapRecovery,
  swap: ActiveSwap,
): Promise<"blocked" | "retained"> {
  const preparation = await prepareGuiTradeRefund(
    swap,
    Date.now(),
    input.expectedWalletId,
  );
  if (preparation.kind === "not-due") {
    scheduleGuiRefundWakeup(input, preparation.retryAtMs - Date.now());
    return "retained";
  }
  if (
    preparation.kind === "no-locked-value" ||
    preparation.kind === "completed"
  ) {
    await finishRecoveredGuiRefund(input, swap);
    return "retained";
  }
  const recovered = await runGuiDurableRecovery(input);
  const disposition = requireGuiRecoveryDisposition(recovered, input.tradeId);
  if (disposition === "ready") {
    const exact = await loadExactGuiSwapForRecovery(input);
    if (!exact) return "blocked";
    await finishRecoveredGuiRefund(input, exact);
    return "retained";
  }
  if (disposition === "retained") {
    scheduleGuiRefundWakeup(input, 1_000);
    return "retained";
  }
  return "blocked";
}

async function finishRecoveredGuiRefund(
  input: OwnedGuiSwapRecovery,
  swap: ActiveSwap,
): Promise<void> {
  await withGuiSwapSessionOwnership(
    input.tradeId,
    (lock) =>
      commitGuiSwapCandidate(lock, {
        ...swap,
        step: "Failed",
        inFlightSteps: {},
      }),
    input.expectedWalletId,
  );
  clearGuiTradeRecoveryWakeup(input.expectedWalletId, input.tradeId);
}

function scheduleGuiRefundWakeup(
  input: OwnedGuiSwapRecovery,
  delayMs: number,
): void {
  scheduleGuiTradeRecoveryWakeup(
    input.expectedWalletId,
    input.tradeId,
    delayMs,
    input.wakeRecovery,
  );
}

async function runGuiDurableRecovery(input: OwnedGuiSwapRecovery) {
  return recoverGuiDurableTradeSession(
    input.tradeId,
    createGuiRecoveryInput(input),
    input.expectedWalletId,
  );
}

type GuiRecoveryDisposition = "ready" | "retained" | "blocked";

function requireGuiRecoveryDisposition(
  recovery: Awaited<ReturnType<typeof runGuiDurableRecovery>>,
  tradeId: string,
): GuiRecoveryDisposition {
  const session = recovery?.sessions.find(
    (candidate) => candidate.tradeId === tradeId,
  );
  if (!session) return "blocked";
  if (session.kind === "failed-closed") {
    throw new Error(
      `Durable GUI swap recovery failed closed: ${session.reason}`,
    );
  }
  if (
    session.kind === "awaiting-refund-salvage" ||
    session.kind === "retry-scheduled"
  ) {
    return "retained";
  }
  return session.kind === "ready" || session.kind === "replayed"
    ? "ready"
    : "blocked";
}

async function retainOrBlockGuiRecovery(
  input: OwnedGuiSwapRecovery,
  disposition: GuiRecoveryDisposition,
): Promise<"blocked" | "retained"> {
  if (disposition === "retained") {
    const exact = await loadExactGuiSwapForRecovery(input);
    if (exact?.step === "awaiting-refund") {
      scheduleGuiRefundWakeup(
        input,
        Math.max(1_000, guiTradeRefundDueAtMs(exact) - Date.now()),
      );
    }
    return "retained";
  }
  return "blocked";
}

function createGuiRecoveryInput(
  input: OwnedGuiSwapRecovery,
): GuiDurableTradeRecoveryInput {
  return {
    mint: createGuiRecoveryMintPort(input),
    transport: createGuiRecoveryTransportPort(input),
    clock: { nowMs: () => Date.now() },
    scheduleRetry: async ({ delayMs }) =>
      scheduleGuiRefundWakeup(input, delayMs),
    hashCiphertext: hashGuiRecoveryCiphertext,
  };
}

function createGuiRecoveryMintPort(
  input: OwnedGuiSwapRecovery,
): GuiDurableTradeRecoveryInput["mint"] {
  return {
    inspect: (operation) => inspectGuiRecoveryOperation(input, operation),
    restoreExactPersistedOutputs: async (operation) => {
      const { entry } = await loadExactGuiRecoveryOperationUnlocked(
        input,
        operation,
      );
      const result = await restoreExactPreparedProofOperation(entry);
      await applyExactGuiRecoveryOutputsUnlocked(input, operation, result);
    },
    resumeExactPreparedOperation: async (operation) => {
      const { entry, wallet } = await loadExactGuiRecoveryOperationUnlocked(
        input,
        operation,
      );
      const result = await resumeExactPreparedProofOperation(wallet, entry);
      await applyExactGuiRecoveryOutputsUnlocked(input, operation, result);
    },
    salvageExpiredRefund: async (operation) => {
      const exact = await requireExactGuiSwapForRecovery(input);
      const result = await salvageGuiTradeRefund(
        exact,
        operation,
        input.expectedWalletId,
      );
      await applyExactGuiRecoveryOutputsUnlocked(input, operation, result);
    },
    getRefundSalvageEvidence: async (operation) => {
      return withGuiSwapSessionOwnership(
        input.tradeId,
        async (lock) => {
          const exact = await loadExactGuiSwapForEffect(lock, input.tradeId);
          return exact
            ? guiTradeRefundEvidenceUnderLock(lock, exact, operation)
            : null;
        },
        input.expectedWalletId,
      );
    },
  };
}

async function inspectGuiRecoveryOperation(
  input: OwnedGuiSwapRecovery,
  operation: Parameters<GuiDurableTradeRecoveryInput["mint"]["inspect"]>[0],
): Promise<{ kind: DurableTradeMintRecoveryState }> {
  const adapterState = await requireExactGuiSwapForRecovery(input);
  if (isGuiTradeRefundLink(operation)) {
    return {
      kind:
        Date.now() >= guiTradeRefundDueAtMs(adapterState)
          ? "expired-refund-salvage"
          : "engine-terminal",
    };
  }
  const { entry, wallet } = await loadExactGuiRecoveryOperationUnlocked(
    input,
    operation,
  );
  const state = await inspectExactPreparedProofOperation(wallet, entry);
  return {
    kind:
      state === "all-unspent"
        ? "prepared-unspent"
        : state === "all-spent"
          ? "prepared-spent-restorable"
          : "pending-or-mixed",
  };
}

function createGuiRecoveryTransportPort(
  input: OwnedGuiSwapRecovery,
): GuiDurableTradeRecoveryInput["transport"] {
  return {
    joinTrade: async (tradeId) => {
      const exact = await requireExactGuiSwapForRecovery(input, tradeId);
      queueGuiRecoveryJoin(
        input.transport,
        guiTradeJoinDelivery(input.expectedWalletId, exact),
      );
    },
    sendCipher: async (tradeId, messageType, ciphertext) => {
      const exact = await requireExactGuiSwapForRecovery(input, tradeId);
      const persisted = persistedGuiSwapCipher(exact, messageType);
      if (persisted !== ciphertext) {
        throw new Error(
          "Durable GUI recovery cipher authority was substituted",
        );
      }
      queueGuiRecoveryJoin(
        input.transport,
        guiTradeJoinDelivery(input.expectedWalletId, exact),
      );
      queueGuiRecoveryCipher(input.transport, {
        ...guiSwapTransportAuthority(input.expectedWalletId, exact),
        messageType,
        ciphertext,
      });
    },
  };
}

function queueGuiRecoveryJoin(
  plan: GuiRecoveryTransportPlan,
  join: GuiTradeJoinDelivery,
): void {
  if (plan.join && !sameGuiTradeJoinDelivery(plan.join, join)) {
    throw new Error("Durable GUI recovery mixed trade transport authority");
  }
  plan.join = join;
}

function queueGuiRecoveryCipher(
  plan: GuiRecoveryTransportPlan,
  delivery: GuiSwapCipherDelivery,
): void {
  if (plan.join && plan.join.tradeId !== delivery.tradeId) {
    throw new Error("Durable GUI recovery mixed trade transport authority");
  }
  const existing = plan.ciphers.find(
    (candidate) => candidate.messageType === delivery.messageType,
  );
  if (existing) {
    if (existing.ciphertext !== delivery.ciphertext) {
      throw new Error("Durable GUI recovery queued conflicting ciphertext");
    }
    return;
  }
  plan.ciphers.push(delivery);
}

async function requireExactGuiSwapForRecovery(
  input: OwnedGuiSwapRecovery,
  tradeId = input.tradeId,
): Promise<ActiveSwap> {
  const exact = await loadExactGuiSwapForRecovery(input, tradeId);
  if (!exact) throw new Error("GUI wallet changed before durable recovery");
  return exact;
}

function loadExactGuiSwapForRecovery(
  input: OwnedGuiSwapRecovery,
  tradeId = input.tradeId,
): Promise<ActiveSwap | null> {
  return withGuiSwapSessionOwnership(
    tradeId,
    (lock) => loadExactGuiSwapForEffect(lock, tradeId),
    input.expectedWalletId,
  );
}

async function hashGuiRecoveryCiphertext(ciphertext: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(ciphertext),
  );
  return Array.from(new Uint8Array(digest), (part) =>
    part.toString(16).padStart(2, "0"),
  ).join("");
}

function replaceActiveSwap(swap: ActiveSwap): void {
  useActiveSwapsStore.setState((state) => ({
    byTradeId: { ...state.byTradeId, [swap.tradeId]: swap },
  }));
}

async function loadExactGuiSwapForEffect(
  lock: GuiWalletLockContext,
  tradeId: string,
): Promise<ActiveSwap | null> {
  if (!heldGuiWalletIsCurrent(lock)) return null;
  const exact = await loadGuiSwapSessionStateUnderLock(lock, tradeId);
  if (!exact || !heldGuiWalletIsCurrent(lock)) return null;
  return exact;
}

async function commitGuiSwapCandidate(
  lock: GuiWalletLockContext,
  candidate: ActiveSwap,
): Promise<ActiveSwap> {
  const mintUrl = requireDurableGuiSwapMint(candidate);
  await persistGuiSwapSessionUnderLock(lock, candidate, mintUrl);
  if (heldGuiWalletIsCurrent(lock)) replaceActiveSwap(candidate);
  return candidate;
}

function requireDurableGuiSwapMint(swap: ActiveSwap): string {
  if (!swap.mintUrl) {
    throw new Error("Durable GUI swap is missing its exact mint authority");
  }
  return normalizeUrl(swap.mintUrl);
}

function requireDurableGuiSwapOrderId(swap: ActiveSwap): string {
  if (!swap.orderId) {
    throw new Error("Durable GUI swap is missing its exact order authority");
  }
  return swap.orderId;
}

async function prepareRegularCollateralForCtfSplit(input: {
  mintUrl: string;
  available: Proof[];
  faceAmountSats: number;
  baseAsset?: string | null;
  reservationId: string;
  operationId: string;
  walletId: string;
  swap: ActiveSwap;
}): Promise<Proof[]> {
  const baseAsset = normalizeMarketBaseAsset(input.baseAsset);
  const existingRegularSplit = await withGuiSwapSessionOwnership(
    input.swap.tradeId,
    (lock) => getProofOperationUnderLock(lock, input.operationId),
    input.walletId,
  );
  if (existingRegularSplit) {
    const unit = existingRegularSplit.metadata.unit;
    const amount = existingRegularSplit.metadata.amount;
    const persistedBaseAsset = normalizeMarketBaseAsset(
      typeof existingRegularSplit.metadata.baseAsset === "string"
        ? existingRegularSplit.metadata.baseAsset
        : null,
    );
    if (
      typeof unit !== "string" ||
      !Number.isSafeInteger(amount) ||
      (amount as number) <= 0 ||
      persistedBaseAsset !== baseAsset
    ) {
      throw new Error(
        `Durable regular split ${input.operationId} has invalid exact metadata`,
      );
    }
    const wallet =
      existingRegularSplit.state === "completed"
        ? undefined
        : await useWalletStore
            .getState()
            .getWalletForUnit(input.mintUrl, unit, {
              expectedWalletId: input.walletId,
            });
    const regularSplit = await splitRegularProofsWithOperation({
      mintUrl: input.mintUrl,
      baseAsset,
      unit,
      operationId: input.operationId,
      wallet,
      proofs: [],
      amountSubunits: amount as number,
      resumeInputAuthority: "persisted-operation",
      resultDispositions: regularSplitResultDispositions(input.reservationId),
      proofOperationStore: regularSplitGuiProofOperationStore(
        input.walletId,
        input.swap,
      ),
    });
    const exact = await selectCollateralForCtfSplit(
      input.mintUrl,
      regularSplit.send,
      input.faceAmountSats,
      baseAsset,
    );
    return exact.inputs;
  }

  try {
    return (
      await selectCollateralForCtfSplit(
        input.mintUrl,
        input.available,
        input.faceAmountSats,
        baseAsset,
      )
    ).inputs;
  } catch {
    // Fall through to a regular sat split that creates an exact CTF input.
  }

  const wallet = await useWalletStore
    .getState()
    .getWallet(input.mintUrl, baseAsset, {
      expectedWalletId: input.walletId,
    });
  if (!wallet.selectProofsToSend || !wallet.getFeesForProofs) {
    throw new Error(
      "Cashu wallet adapter does not support fee-aware proof selection.",
    );
  }
  const grossPlanningKeyset = await resolveGrossCtfInputPlanningKeyset(wallet);
  const grossCtfInputSats = computeGrossCtfInputAmountSats({
    faceAmountSats: input.faceAmountSats,
    keyset: grossPlanningKeyset,
  });
  const selected = wallet.selectProofsToSend(
    input.available,
    grossCtfInputSats,
    true,
    false,
  );
  if (selected.send.length === 0) {
    const availableSats = input.available.reduce(
      (sum, proof) => sum + amountToNumber(proof.amount),
      0,
    );
    if (availableSats > 0) {
      throw new Error(
        `Insufficient balance for CTF split: need ${grossCtfInputSats} sats face collateral, have ${availableSats}.`,
      );
    }
    throw new Error(
      "No regular collateral proofs are available for CTF split.",
    );
  }
  const regularSplit = await splitRegularProofsWithOperation({
    mintUrl: input.mintUrl,
    baseAsset,
    operationId: input.operationId,
    wallet,
    proofs: selected.send,
    amountSats: grossCtfInputSats,
    resultDispositions: regularSplitResultDispositions(input.reservationId),
    proofOperationStore: regularSplitGuiProofOperationStore(
      input.walletId,
      input.swap,
    ),
  });
  const exact = await selectCollateralForCtfSplit(
    input.mintUrl,
    regularSplit.send,
    input.faceAmountSats,
    baseAsset,
  );
  return exact.inputs;
}

function regularSplitResultDispositions(reservationId: string) {
  return {
    send: {
      kind: "wallet" as const,
      asset: "regular" as const,
      reservedBy: reservationId,
    },
    keep: {
      kind: "wallet" as const,
      asset: "regular" as const,
      reservedBy: null,
    },
  };
}

const tradeCreatedInFlight = new Set<string>();
const tradeCreatedFingerprints = new Map<string, string>();
const joinedTradeIds = new Set<string>();
const inboundReplayByWalletAndTrade = new Map<
  string,
  { attempt: number; timer: ReturnType<typeof setTimeout> }
>();
const recoveryWakeupByWalletAndTrade = new Map<
  string,
  ReturnType<typeof setTimeout>
>();
const deliveryRecoveryAttemptsByWalletAndTrade = new Map<string, number>();
const JOIN_ORDER_RETRY_MS = 1_000;
const JOIN_TRADE_RETRY_MS = 1_000;
const MAX_JOIN_TRADE_RETRIES = 45;
const MAX_JOIN_ORDER_STATUS_MISSES = 12;
// Bounded release-blocker recovery: TradeCreated is a one-shot SignalR push
// from the matching engine. If a maker tab misses it after already joining an
// own-order group, replay JoinOrder/order-status briefly so the tab can learn
// the trade id and join the durable trade group.
const ORDER_STATUS_RECOVERY_MS = 2_000;
const MAX_ORDER_STATUS_RECOVERY_ATTEMPTS = 45;
const MAX_INBOUND_REPLAY_ATTEMPTS = 5;
const INBOUND_REPLAY_DELAYS_MS = [50, 250, 1_000, 2_000, 5_000] as const;
const GUI_DELIVERY_RECOVERY_DELAYS_MS = [
  1_000, 2_000, 5_000, 10_000, 30_000,
] as const;

interface InboundReplayRequest {
  walletId: string;
  tradeId: string;
  joinTrade: (tradeId: string) => Promise<void>;
  joinOrder?: () => Promise<void>;
}

function scheduleInboundReplay(request: InboundReplayRequest): void {
  const key = `${request.walletId}:${request.tradeId}`;
  if (inboundReplayByWalletAndTrade.has(key)) return;
  scheduleInboundReplayAttempt(request, key, 0);
}

function scheduleInboundReplayAttempt(
  request: InboundReplayRequest,
  key: string,
  attempt: number,
): void {
  if (attempt >= MAX_INBOUND_REPLAY_ATTEMPTS) return;
  const timer = setTimeout(() => {
    inboundReplayByWalletAndTrade.delete(key);
    if (currentGuiWalletId() !== request.walletId) return;
    void replayInboundTrade(request).catch(() =>
      scheduleInboundReplayAttempt(request, key, attempt + 1),
    );
  }, INBOUND_REPLAY_DELAYS_MS[attempt]);
  inboundReplayByWalletAndTrade.set(key, { attempt, timer });
}

async function replayInboundTrade(
  request: InboundReplayRequest,
): Promise<void> {
  await request.joinOrder?.();
  await request.joinTrade(request.tradeId);
}

function clearInboundReplay(walletId: string, tradeId: string): void {
  const key = `${walletId}:${tradeId}`;
  const pending = inboundReplayByWalletAndTrade.get(key);
  if (!pending) return;
  clearTimeout(pending.timer);
  inboundReplayByWalletAndTrade.delete(key);
}

function scheduleGuiTradeRecoveryWakeup(
  walletId: string,
  tradeId: string,
  delayMs: number,
  wake: () => void,
): void {
  const key = `${walletId}:${tradeId}`;
  const prior = recoveryWakeupByWalletAndTrade.get(key);
  if (prior) clearTimeout(prior);
  const boundedDelay = Math.max(0, Math.min(delayMs, 2_147_000_000));
  const timer = setTimeout(() => {
    recoveryWakeupByWalletAndTrade.delete(key);
    if (currentGuiWalletId() !== walletId) return;
    joinedTradeIds.delete(tradeId);
    wake();
  }, boundedDelay);
  recoveryWakeupByWalletAndTrade.set(key, timer);
}

function clearGuiTradeRecoveryWakeup(walletId: string, tradeId: string): void {
  const key = `${walletId}:${tradeId}`;
  const timer = recoveryWakeupByWalletAndTrade.get(key);
  if (!timer) return;
  clearTimeout(timer);
  recoveryWakeupByWalletAndTrade.delete(key);
}

function handleDeferredGuiDelivery(
  walletId: string,
  tradeId: string,
  result: "busy" | "blocked",
  wakeRecovery: () => void,
): void {
  if (result === "blocked") {
    deferSwapRecovery(tradeId, "corrupt");
  }
  scheduleGuiDeliveryRecovery(walletId, tradeId, wakeRecovery);
}

function scheduleGuiDeliveryRecovery(
  walletId: string,
  tradeId: string,
  wakeRecovery: () => void,
): void {
  const key = `${walletId}:${tradeId}`;
  const attempt = deliveryRecoveryAttemptsByWalletAndTrade.get(key) ?? 0;
  if (attempt >= GUI_DELIVERY_RECOVERY_DELAYS_MS.length) {
    deferSwapRecovery(tradeId);
    return;
  }
  deliveryRecoveryAttemptsByWalletAndTrade.set(key, attempt + 1);
  scheduleGuiTradeRecoveryWakeup(
    walletId,
    tradeId,
    GUI_DELIVERY_RECOVERY_DELAYS_MS[attempt],
    wakeRecovery,
  );
}

function clearGuiDeliveryRecovery(walletId: string, tradeId: string): void {
  deliveryRecoveryAttemptsByWalletAndTrade.delete(`${walletId}:${tradeId}`);
  clearGuiTradeRecoveryWakeup(walletId, tradeId);
}

interface GuiTradeRecoveryWorkPage {
  walletId: string;
  tradeIds: string[];
  nextCursor: string | null;
}

async function loadNextGuiTradeRecoveryWorkPage(
  walletId: string,
  cursor: string | null,
): Promise<GuiTradeRecoveryWorkPage | null> {
  let nextCursor = cursor;
  do {
    const page = await loadRecoverableGuiTradeOperationPage(
      walletId,
      nextCursor,
    );
    if (page.tradeIds.length > 0) return { walletId, ...page };
    nextCursor = page.nextCursor;
  } while (nextCursor !== null);
  return null;
}

/**
 * Mount once near the app root. The hook owns no DOM and renders nothing.
 *
 * @param canAuthenticateTradeHub - True once the app has a configured Nostr
 *   signer. TradeHub authentication uses the same NIP-98 signer path as REST
 *   order submission; swap ECDH still uses the per-order ephemeral key stored
 *   with each pending trade.
 */
export function useTradeSettlement(canAuthenticateTradeHub: boolean): void {
  const swapsByTradeId = useActiveSwapsStore((s) => s.byTradeId);
  const pendingTradeState = usePendingTradesStore((s) => s);
  const joinedOrderKeysRef = useRef<Set<string>>(new Set());
  const orderJoinRetryTimersRef = useRef<
    Map<string, ReturnType<typeof setTimeout>>
  >(new Map());
  const orderJoinMissCountsRef = useRef<Map<string, number>>(new Map());
  const orderStatusRecoveryTimersRef = useRef<
    Map<string, ReturnType<typeof setTimeout>>
  >(new Map());
  const orderStatusRecoveryAttemptsRef = useRef<Map<string, number>>(new Map());
  const tradeJoinRetryTimersRef = useRef<
    Map<string, ReturnType<typeof setTimeout>>
  >(new Map());
  const tradeJoinAttemptsRef = useRef<Map<string, number>>(new Map());
  const recoveryMnemonicRef = useRef<string | null>(null);
  const [recoveryEpoch, setRecoveryEpoch] = useState(0);
  const [hydratedMnemonic, setHydratedMnemonic] = useState<string | null>(null);
  const [tradeRecoveryWork, setTradeRecoveryWork] =
    useState<GuiTradeRecoveryWorkPage | null>(null);
  const activeMintUrl = useWalletStore((s) => s.activeMintUrl);
  const mnemonic = useWalletStore((s) => s.mnemonic);
  const walletId = mnemonic.length > 0 ? currentGuiWalletId() : null;
  const pendingTradesByOrderId =
    pendingTradeState.walletId === walletId ? pendingTradeState.byOrderId : {};
  const durableSessionsHydrated =
    mnemonic.length > 0 && hydratedMnemonic === mnemonic;
  const hasActiveSwapWork = Object.values(swapsByTradeId).some(
    (swap) => swap.step !== "completed" && swap.step !== "Failed",
  );
  const pendingTrades = Object.values(pendingTradesByOrderId);
  const tradeHubEnabled =
    durableSessionsHydrated &&
    canAuthenticateTradeHub &&
    (hasActiveSwapWork ||
      pendingTrades.length > 0 ||
      tradeRecoveryWork?.walletId === walletId);

  const requestRecovery = () => {
    joinedTradeIds.clear();
    joinedOrderKeysRef.current.clear();
    setRecoveryEpoch((current) => current + 1);
  };

  const { joinOrder, joinTrade, sendSwapMessage } = useTradeHub(
    tradeHubEnabled,
    {
      onTradeCreated: (payload) => {
        const walletId = currentGuiWalletId();
        void handleTradeCreated(
          payload,
          joinTrade,
          sendSwapMessage,
          activeMintUrl,
          walletId,
          requestRecovery,
        ).catch(() => {
          deferSwapRecovery(payload.tradeId);
          const pending = getPendingPubkeyForTrade(payload.tradeId);
          scheduleInboundReplay({
            walletId,
            tradeId: payload.tradeId,
            joinTrade,
            joinOrder: pending
              ? () => joinOrder(pending.marketId, pending.orderId)
              : undefined,
          });
        });
      },
      onSwapMessageReceived: (msg) => {
        const walletId = currentGuiWalletId();
        void handleSwapMessage(
          msg,
          sendSwapMessage,
          walletId,
          requestRecovery,
        ).catch(() => {
          deferSwapRecovery(msg.tradeId);
          scheduleInboundReplay({ walletId, tradeId: msg.tradeId, joinTrade });
        });
      },
      onTradeStateChanged: (tradeId, newState, failureReason) =>
        void handleTradeStateChanged(
          tradeId,
          newState,
          sendSwapMessage,
          failureReason,
          requestRecovery,
        ).catch(() => deferSwapRecovery(tradeId)),
      onReconnected: requestRecovery,
    },
  );

  useEffect(() => {
    let cancelled = false;
    const previousMnemonic = recoveryMnemonicRef.current;
    const seedChanged =
      previousMnemonic !== null && previousMnemonic !== mnemonic;
    recoveryMnemonicRef.current = mnemonic || null;
    setHydratedMnemonic(null);
    setTradeRecoveryWork(null);
    clearGuiPendingTradeCache();
    if (seedChanged) {
      useActiveSwapsStore.setState({ byTradeId: {} });
      usePendingPubkeySubmissionsStore.setState({ byTradeId: {} });
    }
    if (!mnemonic) return () => undefined;
    const recoveryWalletId = currentGuiWalletId();
    void Promise.all([
      loadRecoverableGuiSwapSessions(),
      loadGuiPendingSwapIntents(),
      loadGuiPendingTrades(recoveryWalletId),
      loadNextGuiTradeRecoveryWorkPage(recoveryWalletId, null),
    ] as const)
      .then(([swaps, intents, pendingTradeRecords, recoveryWork]) => {
        if (cancelled) return;
        replaceGuiPendingTradeCache(recoveryWalletId, pendingTradeRecords);
        if (seedChanged) {
          useActiveSwapsStore.setState({
            byTradeId: Object.fromEntries(
              swaps.map((swap) => [swap.tradeId, swap]),
            ),
          });
          usePendingPubkeySubmissionsStore.setState({
            byTradeId: Object.fromEntries(
              intents.map((intent) => [intent.tradeId, intent]),
            ),
          });
        } else {
          useActiveSwapsStore.getState().hydrate(swaps);
          usePendingPubkeySubmissionsStore
            .getState()
            .hydratePendingPubkeys(intents);
        }
        setTradeRecoveryWork(recoveryWork);
        setHydratedMnemonic(mnemonic);
      })
      .catch((error) => {
        console.warn("Could not restore durable swap sessions", error);
      });
    return () => {
      cancelled = true;
    };
  }, [mnemonic]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") requestRecovery();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    if (!durableSessionsHydrated || !tradeHubEnabled || !walletId) return;
    const scheduleTradeJoinRetry = (tradeId: string) => {
      if (tradeJoinRetryTimersRef.current.has(tradeId)) return;
      const timer = setTimeout(() => {
        tradeJoinRetryTimersRef.current.delete(tradeId);
        joinedTradeIds.delete(tradeId);
        const latest = useActiveSwapsStore.getState().byTradeId[tradeId];
        if (!isRecoverableGuiSwap(latest)) {
          tradeJoinAttemptsRef.current.delete(tradeId);
          return;
        }
        attemptJoinActiveSwap(latest);
      }, JOIN_TRADE_RETRY_MS);
      tradeJoinRetryTimersRef.current.set(tradeId, timer);
    };

    const attemptJoinActiveSwap = (swap: ActiveSwap) => {
      if (joinedTradeIds.has(swap.tradeId)) return;
      if (tradeJoinRetryTimersRef.current.has(swap.tradeId)) return;
      joinedTradeIds.add(swap.tradeId);
      void (async () => {
        const recovery = await recoverGuiSwapBeforeResume(
          swap.tradeId,
          joinTrade,
          sendSwapMessage,
          walletId,
          requestRecovery,
        );
        if (recovery === "retained") {
          tradeJoinAttemptsRef.current.delete(swap.tradeId);
          joinedTradeIds.add(swap.tradeId);
          return false;
        }
        if (recovery === "blocked") {
          throw new Error(
            "Durable GUI swap recovery is unavailable or pending",
          );
        }
        return true;
      })()
        .then((shouldResume) => {
          if (!shouldResume) return;
          tradeJoinAttemptsRef.current.delete(swap.tradeId);
          void resumeHydratedGuiSwap(
            swap.tradeId,
            sendSwapMessage,
            requestRecovery,
          );
        })
        .catch(() => {
          joinedTradeIds.delete(swap.tradeId);
          const latest = useActiveSwapsStore.getState().byTradeId[swap.tradeId];
          if (!isRecoverableGuiSwap(latest)) {
            tradeJoinAttemptsRef.current.delete(swap.tradeId);
            return;
          }

          const attempts =
            (tradeJoinAttemptsRef.current.get(swap.tradeId) ?? 0) + 1;
          tradeJoinAttemptsRef.current.set(swap.tradeId, attempts);
          if (attempts >= MAX_JOIN_TRADE_RETRIES) {
            tradeJoinAttemptsRef.current.delete(swap.tradeId);
            joinedTradeIds.add(swap.tradeId);
            deferSwapRecovery(swap.tradeId);
            return;
          }
          scheduleTradeJoinRetry(swap.tradeId);
        });
    };

    for (const swap of Object.values(swapsByTradeId)) {
      if (!isRecoverableGuiSwap(swap)) continue;
      attemptJoinActiveSwap(swap);
    }
  }, [
    swapsByTradeId,
    durableSessionsHydrated,
    tradeHubEnabled,
    joinTrade,
    sendSwapMessage,
    recoveryEpoch,
  ]);

  useEffect(() => {
    if (!durableSessionsHydrated || !tradeHubEnabled || !tradeRecoveryWork)
      return;
    if (tradeRecoveryWork.walletId !== walletId) return;
    let cancelled = false;
    void (async () => {
      for (const tradeId of tradeRecoveryWork.tradeIds) {
        if (swapsByTradeId[tradeId]) continue;
        const recovery = await recoverGuiSwapBeforeResume(
          tradeId,
          joinTrade,
          sendSwapMessage,
          tradeRecoveryWork.walletId,
          requestRecovery,
        );
        if (recovery === "continue") {
          await resumeHydratedGuiSwap(
            tradeId,
            sendSwapMessage,
            requestRecovery,
          );
        } else if (recovery === "blocked") {
          deferSwapRecovery(tradeId, "corrupt");
        }
      }
      const next =
        tradeRecoveryWork.nextCursor === null
          ? null
          : await loadNextGuiTradeRecoveryWorkPage(
              tradeRecoveryWork.walletId,
              tradeRecoveryWork.nextCursor,
            );
      if (!cancelled && currentGuiWalletId() === tradeRecoveryWork.walletId) {
        setTradeRecoveryWork(next);
      }
    })().catch(() => {
      if (!cancelled) {
        console.warn("Could not recover orphaned GUI trade operations");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    durableSessionsHydrated,
    tradeHubEnabled,
    tradeRecoveryWork,
    walletId,
    swapsByTradeId,
    joinTrade,
    sendSwapMessage,
    recoveryEpoch,
  ]);

  useEffect(() => {
    if (!tradeHubEnabled) return;

    const liveKeys = new Set(pendingTrades.map(pendingTradeRecoveryKey));
    for (const key of joinedOrderKeysRef.current) {
      if (!liveKeys.has(key)) joinedOrderKeysRef.current.delete(key);
    }
    for (const [key, timer] of orderJoinRetryTimersRef.current) {
      if (!liveKeys.has(key)) {
        clearTimeout(timer);
        orderJoinRetryTimersRef.current.delete(key);
        orderJoinMissCountsRef.current.delete(key);
      }
    }
    for (const [key, timer] of orderStatusRecoveryTimersRef.current) {
      if (!liveKeys.has(key)) {
        clearTimeout(timer);
        orderStatusRecoveryTimersRef.current.delete(key);
        orderStatusRecoveryAttemptsRef.current.delete(key);
      }
    }

    const scheduleOrderStatusRecovery = (trade: PendingTradeRecord) => {
      const key = pendingTradeRecoveryKey(trade);
      if (orderStatusRecoveryTimersRef.current.has(key)) return;

      const timer = setTimeout(() => {
        orderStatusRecoveryTimersRef.current.delete(key);
        const latest = getCurrentGuiPendingTrade(trade.orderId);
        if (!latest || !isCurrentGuiPendingTrade(trade)) {
          orderStatusRecoveryAttemptsRef.current.delete(key);
          return;
        }

        const attempts =
          (orderStatusRecoveryAttemptsRef.current.get(key) ?? 0) + 1;
        orderStatusRecoveryAttemptsRef.current.set(key, attempts);

        void (async () => {
          if (!isCurrentGuiPendingTrade(latest)) return null;
          try {
            await joinOrder(latest.marketId, latest.orderId);
          } catch {
            // Transient hub or projection lag. The REST status fallback below
            // may still expose the trade id; otherwise the next recovery tick
            // retries the hub replay path.
          }

          if (!isCurrentGuiPendingTrade(latest)) return null;
          return fetchOrderStatus(latest.marketId, latest.orderId);
        })()
          .then(async (status) => {
            if (!status || !isCurrentGuiPendingTrade(latest)) return;
            const pendingTradeId =
              typeof status.tradeId === "string" ? status.tradeId : null;
            const pendingDeadline =
              typeof status.deadline === "string" ? status.deadline : null;
            if (pendingTradeId && pendingDeadline) {
              await submitPendingPubkeyFromRecovery(
                latest,
                pendingTradeId,
                pendingDeadline,
              );
            }
            if (!isCurrentGuiPendingTrade(latest)) return;
            const tradeIds = status.fills
              .map((fill) => fill.tradeId)
              .filter((tradeId): tradeId is string => Boolean(tradeId));
            if (tradeIds.length > 0) {
              promoteFillsToActiveSwaps(status.fills, latest, 0);
              if (!isCurrentGuiPendingTrade(latest)) return;
              try {
                await Promise.all(
                  tradeIds.map((tradeId) => joinTrade(tradeId)),
                );
                orderStatusRecoveryAttemptsRef.current.delete(key);
                return;
              } catch {
                if (
                  attempts < MAX_ORDER_STATUS_RECOVERY_ATTEMPTS &&
                  isCurrentGuiPendingTrade(latest)
                ) {
                  scheduleOrderStatusRecovery(latest);
                }
                return;
              }
            }
            if (
              attempts < MAX_ORDER_STATUS_RECOVERY_ATTEMPTS &&
              isCurrentGuiPendingTrade(latest)
            ) {
              scheduleOrderStatusRecovery(latest);
            }
          })
          .catch(() => {
            if (
              attempts < MAX_ORDER_STATUS_RECOVERY_ATTEMPTS &&
              isCurrentGuiPendingTrade(latest)
            ) {
              scheduleOrderStatusRecovery(latest);
            }
          });
      }, ORDER_STATUS_RECOVERY_MS);

      orderStatusRecoveryTimersRef.current.set(key, timer);
    };

    const scheduleOrderJoinRetry = (
      key: string,
      expected: PendingTradeRecord,
      attemptJoinOrder: (trade: PendingTradeRecord) => void,
    ) => {
      const retry = setTimeout(() => {
        orderJoinRetryTimersRef.current.delete(key);
        if (!isCurrentGuiPendingTrade(expected)) return;
        attemptJoinOrder(expected);
      }, JOIN_ORDER_RETRY_MS);
      orderJoinRetryTimersRef.current.set(key, retry);
    };

    const attemptJoinOrder = (trade: PendingTradeRecord) => {
      if (!isCurrentGuiPendingTrade(trade)) return;
      const key = pendingTradeRecoveryKey(trade);
      if (joinedOrderKeysRef.current.has(key)) return;
      if (orderJoinRetryTimersRef.current.has(key)) return;

      joinedOrderKeysRef.current.add(key);
      void fetchOrderStatus(trade.marketId, trade.orderId)
        .then(async (status) => {
          if (!isCurrentGuiPendingTrade(trade)) return;
          if (!status) {
            try {
              await joinOrder(trade.marketId, trade.orderId);
              orderJoinMissCountsRef.current.delete(key);
              scheduleOrderStatusRecovery(trade);
              return;
            } catch {
              const misses = (orderJoinMissCountsRef.current.get(key) ?? 0) + 1;
              orderJoinMissCountsRef.current.set(key, misses);
              joinedOrderKeysRef.current.delete(key);
              if (misses >= MAX_JOIN_ORDER_STATUS_MISSES) {
                await removeGuiPendingTrade(trade);
                return;
              }
              scheduleOrderJoinRetry(key, trade, attemptJoinOrder);
              return;
            }
          }

          orderJoinMissCountsRef.current.delete(key);
          scheduleOrderStatusRecovery(trade);
          return joinOrder(trade.marketId, trade.orderId);
        })
        .catch(() => {
          joinedOrderKeysRef.current.delete(key);
          if (!isCurrentGuiPendingTrade(trade)) return;
          scheduleOrderJoinRetry(key, trade, attemptJoinOrder);
        });
    };

    for (const trade of pendingTrades) {
      attemptJoinOrder(trade);
    }
  }, [pendingTrades, tradeHubEnabled, joinOrder, joinTrade, recoveryEpoch]);

  useEffect(() => {
    if (tradeHubEnabled) return;
    for (const timer of orderJoinRetryTimersRef.current.values()) {
      clearTimeout(timer);
    }
    orderJoinRetryTimersRef.current.clear();
    joinedOrderKeysRef.current.clear();
    orderJoinMissCountsRef.current.clear();
    for (const timer of orderStatusRecoveryTimersRef.current.values()) {
      clearTimeout(timer);
    }
    orderStatusRecoveryTimersRef.current.clear();
    orderStatusRecoveryAttemptsRef.current.clear();
    for (const timer of tradeJoinRetryTimersRef.current.values()) {
      clearTimeout(timer);
    }
    tradeJoinRetryTimersRef.current.clear();
    tradeJoinAttemptsRef.current.clear();
  }, [tradeHubEnabled]);
}

function pendingTradeRecoveryKey(trade: PendingTradeRecord): string {
  return `${trade.walletId}:${trade.marketId}:${trade.orderId}`;
}

// ---------------------------------------------------------------------------
// TradeCreated → assign role + drive seller's first messages
// ---------------------------------------------------------------------------

async function handleTradeCreated(
  payload: TradeCreatedPayload,
  joinTrade: (tradeId: string) => Promise<void>,
  sendSwapMessage: SendSwapMessageFn,
  mintUrl: string,
  expectedWalletId: string,
  wakeRecovery: () => void,
): Promise<void> {
  const fingerprint = tradeCreatedFingerprint(payload);
  const existingFingerprint = tradeCreatedFingerprints.get(payload.tradeId);
  if (existingFingerprint && existingFingerprint !== fingerprint) {
    deferSwapRecovery(payload.tradeId, "corrupt");
    return;
  }
  if (tradeCreatedInFlight.has(payload.tradeId)) return;
  tradeCreatedInFlight.add(payload.tradeId);
  try {
    const committed = await handleTradeCreatedOnce(
      payload,
      joinTrade,
      sendSwapMessage,
      mintUrl,
      expectedWalletId,
      wakeRecovery,
    );
    if (committed) tradeCreatedFingerprints.set(payload.tradeId, fingerprint);
  } finally {
    tradeCreatedInFlight.delete(payload.tradeId);
  }
}

async function handleTradeCreatedOnce(
  payload: TradeCreatedPayload,
  joinTrade: (tradeId: string) => Promise<void>,
  sendSwapMessage: SendSwapMessageFn,
  mintUrl: string,
  expectedWalletId: string,
  wakeRecovery: () => void,
): Promise<boolean> {
  let swap: ActiveSwap | null =
    useActiveSwapsStore.getState().byTradeId[payload.tradeId] ?? null;
  if (swap?.role) return true;
  const promotedFromPending = !swap;
  const pendingPubkey = await loadPendingPubkeyForTrade(payload.tradeId);
  if (!swap) {
    swap = pendingPubkey
      ? pendingTradeCandidateFromTradeCreated(payload, pendingPubkey)
      : null;
  }
  if (!swap) return false;
  const ownEphemeralPubkey = swap.ephemeralPubkeyHex || pendingPubkey?.pubkey;
  if (!ownEphemeralPubkey) {
    deferSwapRecovery(payload.tradeId);
    return false;
  }

  const decision = decideTradeCreated({
    ownEphemeralPubkey,
    sellerPubkey: payload.sellerPubkey,
    buyerPubkey: payload.buyerPubkey,
    sellerLocktime: payload.sellerLocktime,
    buyerLocktime: payload.buyerLocktime,
    settlementKind: payload.settlementKind,
    sellerKeepOutcomeSetId: payload.sellerKeepOutcomeSetId,
    sellerLockOutcomeSetId: payload.sellerLockOutcomeSetId,
    baseAsset: payload.baseAsset,
    divisibility: payload.divisibility,
    expectedBaseAsset: swap.baseAsset,
    expectedDivisibility: swap.divisibility,
    expectedOrder:
      swap.side && swap.priceSubunits != null && swap.amountSubunits != null
        ? {
            side: swap.side,
            tokenSide: swap.tokenSide,
            priceSubunits: swap.priceSubunits,
            amountSubunits: swap.amountSubunits,
          }
        : null,
    requireExpectedOrder: true,
    outcomeFaceAmountSubunits: payload.outcomeFaceAmountSubunits,
    quotePaymentSubunits: payload.quotePaymentSubunits,
  });
  if (!decision.accepted) {
    deferSwapRecovery(
      payload.tradeId,
      decision.reason === "foreign" ? "foreign" : "corrupt",
    );
    return false;
  }

  const committed = await withGuiSwapSessionOwnership(
    payload.tradeId,
    async (lock) => {
      const exact = await loadGuiSwapSessionStateUnderLock(
        lock,
        payload.tradeId,
      );
      if (exact?.role) {
        if (!heldGuiWalletIsCurrent(lock)) return null;
        replaceActiveSwap(exact);
        return exact;
      }
      const candidate = bindAcceptedTradeCreated(swap!, payload, decision);
      const exactMintUrl = swapMintUrl(candidate, mintUrl);
      const pinned = { ...candidate, mintUrl: exactMintUrl };
      return commitGuiSwapCandidate(lock, pinned);
    },
    expectedWalletId,
  );
  if (!committed) return false;
  if (currentGuiWalletId() !== expectedWalletId) return true;
  tradeCreatedFingerprints.set(
    payload.tradeId,
    tradeCreatedFingerprint(payload),
  );
  clearInboundReplay(expectedWalletId, payload.tradeId);

  if (pendingPubkey) {
    usePendingPubkeySubmissionsStore
      .getState()
      .removePendingPubkey(payload.tradeId);
  }

  if (currentGuiWalletId() !== expectedWalletId) return true;

  if (promotedFromPending) {
    if (joinedTradeIds.has(payload.tradeId)) return true;
    joinedTradeIds.add(payload.tradeId);
    try {
      await joinTrade(payload.tradeId);
    } catch {
      joinedTradeIds.delete(payload.tradeId);
      return true;
    }
  }

  if (decision.role === "seller") {
    void runSellerSendOpening(payload.tradeId, sendSwapMessage, wakeRecovery);
  }
  return true;
}

function bindAcceptedTradeCreated(
  swap: ActiveSwap,
  payload: TradeCreatedPayload,
  decision: Extract<ReturnType<typeof decideTradeCreated>, { accepted: true }>,
): ActiveSwap {
  return {
    ...swap,
    role: decision.role,
    counterpartyPubkey: decision.counterpartyPubkey,
    sellerLocktime: decision.sellerLocktime,
    buyerLocktime: decision.buyerLocktime,
    outcomeFaceAmountSubunits:
      payload.outcomeFaceAmountSubunits ?? swap.outcomeFaceAmountSubunits,
    baseAsset: swap.baseAsset,
    divisibility: swap.divisibility,
    quotePaymentSubunits:
      payload.quotePaymentSubunits ?? swap.quotePaymentSubunits,
    settlementKind: payload.settlementKind ?? swap.settlementKind,
    sellerKeepOutcomeSetId:
      payload.sellerKeepOutcomeSetId ?? swap.sellerKeepOutcomeSetId,
    sellerLockOutcomeSetId:
      payload.sellerLockOutcomeSetId ?? swap.sellerLockOutcomeSetId,
    step:
      swap.step === "awaiting-trade-created"
        ? "awaiting-counterparty"
        : swap.step,
  };
}

function heldGuiWalletIsCurrent(lock: GuiWalletLockContext): boolean {
  try {
    return walletIdFromHeldGuiWalletLock(lock) === currentGuiWalletId();
  } catch {
    return false;
  }
}

function tradeCreatedFingerprint(payload: TradeCreatedPayload): string {
  return JSON.stringify({
    tradeId: payload.tradeId,
    marketId: payload.marketId ?? null,
    sellerPubkey: payload.sellerPubkey,
    buyerPubkey: payload.buyerPubkey,
    sellerLocktime: payload.sellerLocktime,
    buyerLocktime: payload.buyerLocktime,
    settlementKind: payload.settlementKind ?? null,
    sellerKeepOutcomeSetId: payload.sellerKeepOutcomeSetId ?? null,
    sellerLockOutcomeSetId: payload.sellerLockOutcomeSetId ?? null,
    outcomeFaceAmountSubunits: payload.outcomeFaceAmountSubunits ?? null,
    quotePaymentSubunits: payload.quotePaymentSubunits ?? null,
    baseAsset: payload.baseAsset ?? null,
    divisibility: payload.divisibility ?? null,
    tokenSide: payload.tokenSide ?? null,
  });
}

function pendingTradeCandidateFromTradeCreated(
  payload: TradeCreatedPayload,
  pendingPubkey: NonNullable<ReturnType<typeof getPendingPubkeyForTrade>>,
): ActiveSwap | null {
  const match = findPendingTradeForTradeCreated(payload, pendingPubkey);
  if (!match) return null;
  const { pendingTrade } = match;
  return createActiveSwap({
    tradeId: payload.tradeId,
    orderId: pendingTrade.orderId,
    clientOrderId: pendingTrade.clientOrderId,
    marketId: pendingTrade.marketId,
    ephemeralPrivkeyHex: pendingPubkey.privkey,
    ephemeralPubkeyHex: pendingPubkey.pubkey,
    baseAsset: pendingTrade.baseAsset,
    divisibility: pendingTrade.divisibility,
    side: pendingTrade.side,
    tokenSide: pendingTrade.tokenSide,
    priceSubunits: pendingTrade.priceSubunits,
    amountSubunits: pendingTrade.amountSubunits,
    timeInForce: pendingTrade.timeInForce,
    recoveryAttempt: pendingTrade.recoveryAttempt,
  });
}

function findPendingTradeForTradeCreated(
  payload: TradeCreatedPayload,
  pendingPubkey: NonNullable<ReturnType<typeof getPendingPubkeyForTrade>>,
): { pendingTrade: PendingTradeRecord; role: SwapRole } | null {
  for (const pendingTrade of getCurrentGuiPendingTrades()) {
    const role =
      pendingPubkey.pubkey.toLowerCase() === payload.sellerPubkey.toLowerCase()
        ? "seller"
        : pendingPubkey.pubkey.toLowerCase() ===
            payload.buyerPubkey.toLowerCase()
          ? "buyer"
          : null;
    if (
      role &&
      tradeCreatedMatchesPendingOrderPath(pendingTrade, payload, role)
    ) {
      return { pendingTrade, role };
    }
  }
  return null;
}

function getPendingPubkeyForTrade(tradeId: string) {
  return usePendingPubkeySubmissionsStore.getState().byTradeId[tradeId];
}

async function loadPendingPubkeyForTrade(
  tradeId: string,
): Promise<ReturnType<typeof getPendingPubkeyForTrade>> {
  return (
    getPendingPubkeyForTrade(tradeId) ??
    (await getGuiPendingSwapIntent(tradeId)) ??
    undefined
  );
}

async function submitPendingPubkeyFromRecovery(
  pendingTrade: PendingTradeRecord,
  tradeId: string,
  deadline: string,
): Promise<void> {
  if (!isCurrentGuiPendingTrade(pendingTrade)) {
    throw new Error("Pending order belongs to another wallet scope");
  }
  const store = usePendingPubkeySubmissionsStore.getState();
  const [entry] = await submitAdmittedGuiPendingSwapIntents(
    [
      {
        tradeId,
        orderId: pendingTrade.orderId,
        marketId: pendingTrade.marketId,
        deadline,
        create: () => {
          const key = generateEphemeralKeyPair();
          return {
            tradeId,
            orderId: pendingTrade.orderId,
            marketId: pendingTrade.marketId,
            pubkey: key.pubkey,
            privkey: key.privkey,
            deadline,
            submitted: false,
          };
        },
      },
    ],
    async (intent) => {
      if (!isCurrentGuiPendingTrade(pendingTrade)) {
        throw new Error("Pending order belongs to another wallet scope");
      }
      await submitEphemeralPubkey(
        tradeId,
        intent.pubkey,
        conditionIdFromMarketId(pendingTrade.marketId),
      );
    },
  );
  if (!entry) throw new Error("GUI pre-trade admission returned no intent");
  store.addPendingPubkey(entry);
}

function conditionIdFromMarketId(marketId: string): string {
  const index = marketId.lastIndexOf("-");
  return index > 0 ? marketId.substring(0, index) : marketId;
}

function tradeCreatedMatchesPendingOrderPath(
  pendingTrade: PendingTradeRecord,
  payload: TradeCreatedPayload,
  role: SwapRole,
): boolean {
  const settlementKind = payload.settlementKind ?? "DirectSwap";
  if (settlementKind === "DirectSwap") {
    return !payload.marketId || pendingTrade.marketId === payload.marketId;
  }

  if (settlementKind !== "Mint") {
    return true;
  }

  if (!payload.sellerKeepOutcomeSetId || !payload.sellerLockOutcomeSetId) {
    return true;
  }

  if (payload.marketId && pendingTrade.marketId === payload.marketId) {
    return true;
  }

  const market = payload.marketId ? splitMarketId(payload.marketId) : null;
  if (!market) return true;

  const expectedOutcomeSetId =
    role === "seller"
      ? payload.sellerKeepOutcomeSetId
      : payload.sellerLockOutcomeSetId;
  return (
    pendingTrade.marketId === `${market.conditionId}-${expectedOutcomeSetId}`
  );
}

// ---------------------------------------------------------------------------
// Seller — Step 4 + 5
// ---------------------------------------------------------------------------

async function runSellerSendOpening(
  tradeId: string,
  sendSwapMessage: SendSwapMessageFn,
  wakeRecovery: () => void,
): Promise<void> {
  const walletId = currentGuiWalletId();
  const shouldDeliver = await prepareAndJournalSellerOpening(tradeId, walletId);
  if (!shouldDeliver) return;
  try {
    const adaptorDelivery = await deliverPersistedGuiSwapCipher(
      walletId,
      tradeId,
      sendSwapMessage,
      TRADE_MESSAGE_TYPES.adaptorPoint,
    );
    if (adaptorDelivery === "terminal") return;
    if (adaptorDelivery !== "sent") {
      handleDeferredGuiDelivery(
        walletId,
        tradeId,
        adaptorDelivery,
        wakeRecovery,
      );
      return;
    }
    const lockedProofsDelivery = await deliverPersistedGuiSwapCipher(
      walletId,
      tradeId,
      sendSwapMessage,
      TRADE_MESSAGE_TYPES.lockedProofsSeller,
    );
    if (
      lockedProofsDelivery !== "sent" &&
      lockedProofsDelivery !== "terminal"
    ) {
      handleDeferredGuiDelivery(
        walletId,
        tradeId,
        lockedProofsDelivery,
        wakeRecovery,
      );
    }
  } catch {
    deferSwapRecovery(tradeId);
    scheduleGuiDeliveryRecovery(walletId, tradeId, wakeRecovery);
  }
}

async function prepareAndJournalSellerOpening(
  tradeId: string,
  walletId: string,
): Promise<boolean> {
  try {
    const authority = await withGuiSwapSessionOwnership(
      tradeId,
      (lock) => prepareSellerOpeningAuthorityUnderLock(lock, tradeId),
      walletId,
    );
    if (!authority) return false;
    const prepared = await prepareSellerOpening(authority, walletId);
    return withGuiSwapSessionOwnership(
      tradeId,
      (lock) => journalSellerOpening(lock, tradeId, prepared),
      walletId,
    );
  } catch (err) {
    failSwap(tradeId, err);
    return false;
  }
}

async function prepareSellerOpeningAuthorityUnderLock(
  lock: GuiWalletLockContext,
  tradeId: string,
): Promise<ActiveSwap | null> {
  const swap = await loadExactGuiSwapForEffect(lock, tradeId);
  if (!swap || swap.role !== "seller") return null;
  if (
    swap.step === "awaiting-refund" ||
    swap.step === "completed" ||
    swap.step === "Failed"
  ) {
    return null;
  }
  const driving =
    swap.step === "driving"
      ? swap
      : await commitGuiSwapCandidate(lock, { ...swap, step: "driving" });
  const preparedSwap = await ensureDurableSellerAdaptor(lock, driving);
  return preparedSwap;
}

async function prepareSellerOpening(
  preparedSwap: ActiveSwap,
  walletId: string,
): Promise<{ opening: SellerOpening; mintUrl: string }> {
  const exactMintUrl = requireDurableGuiSwapMint(preparedSwap);
  const ctx = buildSwapContext(preparedSwap, exactMintUrl);
  const adaptorPoint = preparedSwap.sellerState?.adaptorPoint;
  if (!ctx || !adaptorPoint) {
    throw new Error("Durable seller preparation is unavailable");
  }
  const split = mintSellerSplit(preparedSwap, ctx);
  const opening = split
    ? await prepareMintSellerOpening(
        preparedSwap,
        ctx,
        exactMintUrl,
        split,
        adaptorPoint,
        walletId,
      )
    : await prepareDirectSellerOpening(
        preparedSwap,
        ctx,
        exactMintUrl,
        adaptorPoint,
        walletId,
      );
  return { opening, mintUrl: exactMintUrl };
}

async function journalSellerOpening(
  lock: GuiWalletLockContext,
  tradeId: string,
  prepared: { opening: SellerOpening; mintUrl: string },
): Promise<boolean> {
  const { opening } = prepared;
  const exact = await loadExactGuiSwapForEffect(lock, tradeId);
  if (
    !exact?.sellerState ||
    exact.step === "awaiting-refund" ||
    exact.step === "completed" ||
    exact.step === "Failed"
  ) {
    return false;
  }
  await commitGuiSwapCandidate(lock, {
    ...exact,
    sellerState: {
      ...exact.sellerState,
      adaptorPoint: opening.adaptorPoint,
      adaptorPointCipher: opening.adaptorPointCipher,
      lockedProofsCipher: opening.lockedProofsCipher,
    },
  });
  return true;
}

async function ensureDurableSellerAdaptor(
  lock: GuiWalletLockContext,
  swap: ActiveSwap,
): Promise<ActiveSwap> {
  if (swap.role !== "seller") {
    throw new Error("Seller swap state is unavailable");
  }
  if (!swap.sellerState) {
    return commitGuiSwapCandidate(lock, {
      ...swap,
      sellerState: {
        adaptorPoint: generateAdaptorPoint(),
      },
    });
  }
  return swap;
}

type SellerOpening = Awaited<
  ReturnType<typeof sellerPreparePersistedPrelockedSwap>
>;

interface MintSellerSplit {
  conditionId: string;
  keepOutcomeSetId: string;
  lockOutcomeSetId: string;
}

interface SelectedOutcomeProofGroup {
  outcomeSetId: string;
  proofs: StoredProof[];
}

async function prepareDirectSellerOpening(
  swap: ActiveSwap,
  ctx: SwapCtx,
  mintUrl: string,
  adaptorPoint: NonNullable<ActiveSwap["sellerState"]>["adaptorPoint"],
  walletId: string,
): Promise<SellerOpening> {
  const operationId = proofOperationId(
    swap.tradeId,
    "seller-complementary-lock",
  );
  const existingOperation = await withGuiSwapSessionOwnership(
    swap.tradeId,
    (lock) => getProofOperationUnderLock(lock, operationId),
    walletId,
  );
  const proofs =
    existingOperation?.kind === "conditional-keyset-swap"
      ? existingOperation.inputs
      : await loadProofsForLock(
          mintUrl,
          swap.outcomeFaceAmountSubunits ??
            swap.outcomeFaceAmountSats ??
            undefined,
          swap.marketId,
          swap.baseAsset,
          operationId,
          walletId,
        );
  const amountSats =
    swap.outcomeFaceAmountSubunits ??
    swap.outcomeFaceAmountSats ??
    proofs.reduce((sum, proof) => sum + amountToNumber(proof.amount), 0);
  const locked = await sellerLockOutcomeProofs(ctx, proofs, amountSats, {
    operationId,
    proofOperationStore: localLockGuiProofOperationStore(walletId, swap),
  });
  return sellerPreparePersistedPrelockedSwap(
    ctx,
    locked.lockedProofs,
    adaptorPoint,
  );
}

async function prepareMintSellerOpening(
  swap: ActiveSwap,
  ctx: SwapCtx,
  mintUrl: string,
  split: MintSellerSplit,
  adaptorPoint: NonNullable<ActiveSwap["sellerState"]>["adaptorPoint"],
  walletId: string,
): Promise<SellerOpening> {
  const amountSats =
    swap.outcomeFaceAmountSubunits ?? swap.outcomeFaceAmountSats;
  if (
    amountSats === null ||
    !Number.isSafeInteger(amountSats) ||
    amountSats <= 0
  ) {
    throw new Error("Mint swap is missing a positive outcome face amount");
  }

  const operationId = proofOperationId(swap.tradeId, "seller-mint-ctf-split");
  const selectedOutcomeGroups = await selectOutcomeProofGroups(
    walletId,
    swap.tradeId,
    mintUrl,
    split.conditionId,
    split.lockOutcomeSetId,
    amountSats,
    swap.baseAsset,
  );
  if (selectedOutcomeGroups) {
    const locked = await lockSelectedOutcomeProofGroups({
      swap,
      ctx,
      mintUrl,
      conditionId: split.conditionId,
      groups: selectedOutcomeGroups,
      amountSats,
      operationStep: "seller-inventory-lock",
      walletId,
    });
    return sellerPreparePersistedPrelockedSwap(
      ctx,
      locked.lockedProofs,
      adaptorPoint,
    );
  }

  const splitOutputAmountSats = await resolveRootDirectLockOutputAmountSats({
    mintUrl,
    baseAsset: swap.baseAsset,
    conditionId: split.conditionId,
    amountSats,
    lockOutcomeSetId: split.lockOutcomeSetId,
    keepOutcomeSetId: split.keepOutcomeSetId,
  });
  const existingOperation = await withGuiSwapSessionOwnership(
    swap.tradeId,
    (lock) => getProofOperationUnderLock(lock, operationId),
    walletId,
  );
  const collateralProofs = existingOperation
    ? existingOperation.inputs
    : await prepareRegularCollateralForCtfSplit({
        mintUrl,
        available: await withGuiSwapSessionOwnership(
          swap.tradeId,
          (lock) =>
            getUnitProofsUnderLock(lock, mintUrl, {
              unit: defaultCollateralUnit(swap.baseAsset),
            }),
          walletId,
        ),
        faceAmountSats: splitOutputAmountSats,
        baseAsset: swap.baseAsset,
        reservationId: swap.tradeId,
        operationId: proofOperationId(swap.tradeId, "seller-regular-ctf-input"),
        walletId,
        swap,
      });

  const splitResult = await splitRootCompleteSetForSwap({
    mintUrl,
    baseAsset: swap.baseAsset,
    conditionId: split.conditionId,
    collateralProofs,
    amountSats: splitOutputAmountSats,
    lockOutcomeSetId: split.lockOutcomeSetId,
    keepOutcomeSetId: split.keepOutcomeSetId,
    p2pk: {
      pubkey: [ctx.ephemeralKey.publicKey, ctx.counterpartyPubkey],
      requiredSignatures: 2,
      locktime: ctx.sellerLocktime,
      refundKeys: [ctx.ephemeralKey.publicKey],
      sigFlag: "SIG_INPUTS",
    },
    operationId,
    proofOperationStore: ctfGuiProofOperationStore(walletId, swap),
  });

  return sellerPreparePersistedPrelockedSwap(
    ctx,
    splitResult.lockedProofs,
    adaptorPoint,
  );
}

async function selectOutcomeProofs(
  walletId: string,
  tradeId: string,
  mintUrl: string,
  conditionId: string,
  outcomeSetId: string,
  amountSats: number,
  baseAsset?: string | null,
): Promise<StoredProof[] | null> {
  const available = await withGuiSwapSessionOwnership(
    tradeId,
    (lock) =>
      getOutcomeProofsUnderLock(lock, mintUrl, conditionId, outcomeSetId, {
        baseAsset,
      }),
    walletId,
  );
  return takeProofsForLock(
    available,
    amountSats,
    await inputFeePpkByKeysetForProofs(mintUrl, available),
  );
}

async function selectOutcomeProofGroups(
  walletId: string,
  tradeId: string,
  mintUrl: string,
  conditionId: string,
  outcomeSetId: string,
  amountSats: number,
  baseAsset?: string | null,
): Promise<SelectedOutcomeProofGroup[] | null> {
  const exact = await selectOutcomeProofs(
    walletId,
    tradeId,
    mintUrl,
    conditionId,
    outcomeSetId,
    amountSats,
    baseAsset,
  );
  if (exact) return [{ outcomeSetId, proofs: exact }];

  const primitiveOutcomeSetIds = parseOutcomeSetId(outcomeSetId);
  if (primitiveOutcomeSetIds.length <= 1) return null;

  const groups: SelectedOutcomeProofGroup[] = [];
  for (const primitiveOutcomeSetId of primitiveOutcomeSetIds) {
    const proofs = await selectOutcomeProofs(
      walletId,
      tradeId,
      mintUrl,
      conditionId,
      primitiveOutcomeSetId,
      amountSats,
      baseAsset,
    );
    if (!proofs) return null;
    groups.push({ outcomeSetId: primitiveOutcomeSetId, proofs });
  }
  return groups;
}

async function lockSelectedOutcomeProofGroups(input: {
  swap: ActiveSwap;
  ctx: SwapCtx;
  mintUrl: string;
  conditionId: string;
  groups: SelectedOutcomeProofGroup[];
  amountSats: number;
  operationStep: string;
  walletId: string;
}): Promise<{
  spentProofs: Proof[];
  lockedProofs: Proof[];
  changeProofs: Proof[];
}> {
  const collectionByKeyset = collectionByKeysetForOutcomeGroups(input.groups);
  const spentProofs: Proof[] = [];
  const lockedProofs: Proof[] = [];
  const changeProofs: Proof[] = [];

  for (const group of input.groups) {
    try {
      const locked = await sellerLockOutcomeProofs(
        input.ctx,
        group.proofs,
        input.amountSats,
        {
          operationId: proofOperationId(
            input.swap.tradeId,
            input.groups.length === 1
              ? input.operationStep
              : `${input.operationStep}/${encodeURIComponent(group.outcomeSetId)}`,
          ),
          proofOperationStore: localLockGuiProofOperationStore(
            input.walletId,
            input.swap,
          ),
        },
      );
      spentProofs.push(...group.proofs);
      lockedProofs.push(...locked.lockedProofs);
      changeProofs.push(...locked.changeProofs);
    } catch (err) {
      const partial = partialLockFromError(err);
      const combinedSpentProofs = [
        ...spentProofs,
        ...(partial?.spentProofs ?? []),
      ];
      const combinedLockedProofs = [
        ...lockedProofs,
        ...(partial?.lockedProofs ?? []),
      ];
      const combinedChangeProofs = [
        ...changeProofs,
        ...(partial?.changeProofs ?? []),
      ];
      if (combinedLockedProofs.length > 0) {
        await persistPartialLockParts({
          walletId: input.walletId,
          swap: input.swap,
          mintUrl: input.mintUrl,
          conditionId: input.conditionId,
          collectionByKeyset,
          spentProofs: combinedSpentProofs,
          lockedProofs: combinedLockedProofs,
          changeProofs: combinedChangeProofs,
          refundLocktime:
            partial?.failure.refundLocktime ?? input.ctx.sellerLocktime,
          detail: partial?.failure.detail ?? errorMessage(err),
        });
      }
      throw err;
    }
  }

  return { spentProofs, lockedProofs, changeProofs };
}

function collectionByKeysetForOutcomeGroups(
  groups: SelectedOutcomeProofGroup[],
): Map<string, string> {
  const collectionByKeyset = new Map<string, string>();
  for (const group of groups) {
    for (const proof of group.proofs) {
      if (!proof.id) throw new Error("Outcome proof is missing keyset id");
      collectionByKeyset.set(proof.id, group.outcomeSetId);
    }
  }
  return collectionByKeyset;
}

function uniqueProofKeysets(proofs: Proof[]): string[] {
  return [
    ...new Set(
      proofs
        .map((proof) => proof.id)
        .filter((value): value is string => typeof value === "string"),
    ),
  ];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function inputFeePpkByKeysetForProofs(
  mintUrl: string,
  proofs: Array<Pick<Proof, "id">>,
): Promise<Record<string, number>> {
  const mint = new CashuMint(mintUrl);
  const inputFeePpkByKeyset: Record<string, number> = {};
  for (const proof of proofs) {
    if (!proof.id) throw new Error("Proof is missing keyset id");
    if (inputFeePpkByKeyset[proof.id] !== undefined) continue;
    const response = await mint.getKeys(proof.id);
    const keyset = response.keysets.find(
      (candidate) => candidate.id === proof.id,
    );
    if (!keyset) {
      throw new Error(`Mint did not return keys for keyset ${proof.id}`);
    }
    inputFeePpkByKeyset[proof.id] = keyset.input_fee_ppk ?? 0;
  }
  return inputFeePpkByKeyset;
}

function mintSellerSplit(
  swap: ActiveSwap,
  ctx: SwapCtx,
): MintSellerSplit | null {
  if (ctx.role !== "seller") return null;
  if (swap.settlementKind !== "Mint") return null;
  if (!swap.sellerKeepOutcomeSetId || !swap.sellerLockOutcomeSetId) {
    throw new Error("Mint split trade is missing seller outcome metadata");
  }
  const market = splitMarketId(swap.marketId);
  if (!market) {
    throw new Error(`Invalid mint split market id ${swap.marketId}`);
  }
  return {
    conditionId: market.conditionId,
    keepOutcomeSetId: swap.sellerKeepOutcomeSetId,
    lockOutcomeSetId: swap.sellerLockOutcomeSetId,
  };
}

// ---------------------------------------------------------------------------
// SwapMessageReceived dispatch
// ---------------------------------------------------------------------------

async function handleSwapMessage(
  msg: SwapMessage,
  sendSwapMessage: SendSwapMessageFn,
  expectedWalletId: string,
  wakeRecovery: () => void,
): Promise<void> {
  const committed = await withGuiSwapSessionOwnership(
    msg.tradeId,
    async (lock) => {
      const swap = await loadExactGuiSwapForEffect(lock, msg.tradeId);
      if (!swap || swap.step === "awaiting-refund") return null;
      const decision = decideSwapMessage({
        role: swap.role,
        messages: swap.messages,
        messageType: msg.messageType,
        ciphertext: msg.ciphertext,
      });
      if (!decision.messageKey) return null;
      if (swap.messages[decision.messageKey] === msg.ciphertext) return null;
      const exactMintUrl = requireDurableGuiSwapMint(swap);
      const candidate: ActiveSwap = {
        ...swap,
        mintUrl: exactMintUrl,
        messages: decision.messages,
      };
      await commitGuiSwapCandidate(lock, candidate);
      return { decision, candidate };
    },
    expectedWalletId,
  );
  if (!committed) return;
  if (currentGuiWalletId() !== expectedWalletId) return;
  clearInboundReplay(expectedWalletId, msg.tradeId);
  const { decision } = committed;

  if (decision.action === "settlement-claim") {
    void runSettlementClaim(msg.tradeId, sendSwapMessage, wakeRecovery);
  }
  const latest = committed.candidate;
  const shouldDriveBuyerResponse =
    decision.action === "buyer-respond" ||
    (latest?.role === "buyer" &&
      Boolean(latest.messages.adaptorPoint) &&
      Boolean(latest.messages.lockedProofsSeller) &&
      !latest.messages.lockedProofsBuyer);
  if (shouldDriveBuyerResponse) {
    void runBuyerRespond(msg.tradeId, sendSwapMessage, wakeRecovery);
  }
}

function isRecoverableGuiSwap(
  swap: ActiveSwap | undefined,
): swap is ActiveSwap {
  return Boolean(swap && swap.step !== "completed" && swap.step !== "Failed");
}

async function resumeHydratedGuiSwap(
  tradeId: string,
  sendSwapMessage: SendSwapMessageFn,
  wakeRecovery: () => void,
): Promise<void> {
  const swap = useActiveSwapsStore.getState().byTradeId[tradeId];
  if (!isRecoverableGuiSwap(swap) || !swap.role) return;
  if (swap.step === "awaiting-refund") return;
  if (
    swap.step === "awaiting-confirmation" &&
    swap.settlementCompleteDelivery === "pending"
  ) {
    await resumeSettlementCompleteDelivery(
      tradeId,
      sendSwapMessage,
      wakeRecovery,
    );
    return;
  }

  if (swap.role === "seller") {
    if (
      swap.sellerState?.adaptorPointCipher &&
      swap.sellerState.lockedProofsCipher
    ) {
      return;
    }
    await runSellerSendOpening(tradeId, sendSwapMessage, wakeRecovery);
    return;
  }

  if (swap.buyerState?.lockedProofsCipher) {
    return;
  }
  if (swap.messages.adaptorPoint && swap.messages.lockedProofsSeller) {
    await runBuyerRespond(tradeId, sendSwapMessage, wakeRecovery);
  }
}

// ---------------------------------------------------------------------------
// Buyer — Step 6
// ---------------------------------------------------------------------------

async function runBuyerRespond(
  tradeId: string,
  sendSwapMessage: SendSwapMessageFn,
  wakeRecovery: () => void,
): Promise<void> {
  const walletId = currentGuiWalletId();
  const shouldDeliver = await prepareAndJournalBuyerResponse(tradeId, walletId);
  if (!shouldDeliver) return;
  try {
    const result = await deliverPersistedGuiSwapCipher(
      walletId,
      tradeId,
      sendSwapMessage,
      TRADE_MESSAGE_TYPES.lockedProofsBuyer,
    );
    if (result !== "sent" && result !== "terminal") {
      handleDeferredGuiDelivery(walletId, tradeId, result, wakeRecovery);
    }
  } catch {
    deferSwapRecovery(tradeId);
    scheduleGuiDeliveryRecovery(walletId, tradeId, wakeRecovery);
  }
}

async function prepareAndJournalBuyerResponse(
  tradeId: string,
  walletId: string,
): Promise<boolean> {
  let buyerLockOperationId: string | null = null;
  try {
    const swap = await withGuiSwapSessionOwnership(
      tradeId,
      async (lock) => {
        const exact = await loadExactGuiSwapForEffect(lock, tradeId);
        if (!exact || exact.role !== "buyer") return null;
        if (
          exact.step === "awaiting-confirmation" ||
          exact.step === "awaiting-refund" ||
          exact.step === "completed" ||
          exact.step === "Failed"
        ) {
          return null;
        }
        if (
          !exact.messages.adaptorPoint ||
          !exact.messages.lockedProofsSeller
        ) {
          return null;
        }
        const replayCipher =
          exact.messages.lockedProofsBuyer ??
          exact.buyerState?.lockedProofsCipher;
        if (replayCipher && exact.buyerState) return exact;
        if (exact.buyerState) {
          throw new Error(
            "Buyer response already prepared but ciphertext is missing",
          );
        }
        const driving =
          exact.step === "driving"
            ? exact
            : await commitGuiSwapCandidate(lock, {
                ...exact,
                step: "driving",
              });
        return ensureDurableBuyerPreparation(lock, driving);
      },
      walletId,
    );
    if (!swap || swap.role !== "buyer") return false;
    const replayCipher =
      swap.messages.lockedProofsBuyer ?? swap.buyerState?.lockedProofsCipher;
    if (replayCipher && swap.buyerState) {
      return true;
    }
    if (swap.buyerState) {
      throw new Error(
        "Buyer response already prepared but ciphertext is missing",
      );
    }
    const operationId = proofOperationId(tradeId, "buyer-lock");
    buyerLockOperationId = operationId;
    const prepared = await prepareBuyerResponse(swap, operationId, walletId);
    if (!prepared) return false;
    return withGuiSwapSessionOwnership(
      tradeId,
      async (lock) => {
        const current = await loadExactGuiSwapForEffect(lock, tradeId);
        if (
          !current ||
          current.step === "awaiting-refund" ||
          current.step === "completed" ||
          current.step === "Failed"
        ) {
          return false;
        }
        await journalBuyerResponse(lock, tradeId, prepared);
        return true;
      },
      walletId,
    );
  } catch (err) {
    if (buyerLockOperationId) {
      await withGuiSwapSessionOwnership(
        tradeId,
        (lock) =>
          releaseBuyerReservationBeforeMint(buyerLockOperationId!, lock),
        walletId,
      );
    }
    failSwap(tradeId, err);
    return false;
  }
}

type BuyerResponse = Awaited<ReturnType<typeof buyerPrepareSwap>>;

async function prepareBuyerResponse(
  swap: ActiveSwap,
  operationId: string,
  walletId: string,
): Promise<{ response: BuyerResponse; mintUrl: string } | null> {
  const amountSats = positiveBuyerAmount(swap);
  const exactMintUrl = requireDurableGuiSwapMint(swap);
  const ctx = buildSwapContext(swap, exactMintUrl);
  if (!ctx) throw new Error("Durable buyer context is unavailable");
  const existing = await withGuiSwapSessionOwnership(
    swap.tradeId,
    (lock) => getProofOperationUnderLock(lock, operationId),
    walletId,
  );
  const proofs =
    existing?.kind === "swap-lock"
      ? existing.inputs
      : await loadProofsForLock(
          exactMintUrl,
          amountSats,
          undefined,
          swap.baseAsset,
          operationId,
          walletId,
          swap.tradeId,
        );
  const response = await buyerPrepareSwap(
    ctx,
    swap.messages.adaptorPoint!,
    swap.messages.lockedProofsSeller!,
    proofs,
    amountSats,
    {
      operationId,
      proofOperationStore: localLockGuiProofOperationStore(walletId, swap),
      lockedProofsCipherIv: swap.buyerPreparation!.lockedProofsCipherIv,
    },
  );
  return { response, mintUrl: exactMintUrl };
}

function positiveBuyerAmount(swap: ActiveSwap): number {
  const amount = swap.quotePaymentSubunits ?? swap.quotePaymentSats;
  if (
    typeof amount !== "number" ||
    !Number.isSafeInteger(amount) ||
    amount <= 0
  ) {
    throw new Error("Swap is missing a positive quote payment amount");
  }
  return amount;
}

async function journalBuyerResponse(
  lock: GuiWalletLockContext,
  tradeId: string,
  prepared: { response: BuyerResponse; mintUrl: string },
): Promise<void> {
  const { response } = prepared;
  const exact = await loadExactGuiSwapForEffect(lock, tradeId);
  if (!exact) return;
  await commitGuiSwapCandidate(lock, {
    ...exact,
    messages: {
      ...exact.messages,
      lockedProofsBuyer: response.lockedProofsCipher,
    },
    buyerState: {
      ownPreSigsHex: response.preSigsHex,
      lockedSatProofs: response.lockedProofs,
      lockedProofsCipher: response.lockedProofsCipher,
      sellerPreSigsHex: response.sellerPreSigsHex,
    },
  });
}

async function ensureDurableBuyerPreparation(
  lock: GuiWalletLockContext,
  swap: ActiveSwap,
): Promise<ActiveSwap> {
  if (swap.role !== "buyer") {
    throw new Error("Buyer swap state is unavailable");
  }
  if (!swap.buyerPreparation) {
    return commitGuiSwapCandidate(lock, {
      ...swap,
      buyerPreparation: {
        lockedProofsCipherIv: crypto.getRandomValues(new Uint8Array(12)),
      },
    });
  }
  return swap;
}

/**
 * A reservation is disposable only before the proof operation exists. Once it
 * is prepared, its inputs may have reached the mint and recovery must retain
 * the reservation until the operation resolves deterministically.
 */
async function releaseBuyerReservationBeforeMint(
  operationId: string,
  lock: GuiWalletLockContext,
): Promise<void> {
  try {
    if (await getProofOperationUnderLock(lock, operationId)) return;
    await releaseProofReservationUnderLock(lock, operationId);
  } catch {
    // Failing closed retains the reservation rather than making a possibly
    // submitted mint operation spendable by another swap.
    console.warn("[swap.buyer-reservation]", { code: "release-deferred" });
  }
}

// ---------------------------------------------------------------------------
// TradeStateChanged → claim + settlement-complete
// ---------------------------------------------------------------------------

async function handleTradeStateChanged(
  tradeId: string,
  newState: string,
  sendSwapMessage: SendSwapMessageFn,
  failureReason?: string,
  wakeRecovery: () => void = () => undefined,
): Promise<void> {
  const action = decideTradeStateChanged(newState);
  if (action === "finish-confirmed") {
    await finishSwap(tradeId);
    return;
  }
  if (action === "finish-failed" || action === "finish-refunded") {
    const swap = useActiveSwapsStore.getState().byTradeId[tradeId];
    if (swap?.step === "completed") return;
    const expectedWalletId = currentGuiWalletId();
    const retained = await retainEngineTerminalSwap(
      tradeId,
      "Settlement ended before both parties confirmed.",
      expectedWalletId,
    );
    if (retained && currentGuiWalletId() === expectedWalletId) {
      void resubmitMakerCausedTakerFailure(retained, failureReason);
    }
    return;
  }
  if (action === "settlement-claim") {
    void runSettlementClaim(tradeId, sendSwapMessage, wakeRecovery);
  }
}

async function retainEngineTerminalSwap(
  tradeId: string,
  failureMessage: string,
  expectedWalletId: string,
): Promise<ActiveSwap | null> {
  const disposition =
    classifyDurableTradeRecoveryDisposition("engine-terminal");
  if (disposition.action !== "await-refund-salvage") {
    throw new Error("SDK engine-terminal recovery disposition changed");
  }
  return withGuiSwapSessionOwnership(
    tradeId,
    async (lock) => {
      const swap = await loadExactGuiSwapForEffect(lock, tradeId);
      if (!swap || swap.step === "completed") return null;
      if (swap.step === "awaiting-refund") return swap;
      const retained: ActiveSwap = {
        ...swap,
        step: "awaiting-refund",
        error: failureMessage,
        inFlightSteps: {},
      };
      return commitGuiSwapCandidate(lock, retained);
    },
    expectedWalletId,
  );
}

async function resubmitMakerCausedTakerFailure(
  swap: ActiveSwap,
  failureReason: string | undefined,
): Promise<void> {
  const sourceOrder = sourceOrderForRecovery(swap);
  const failedFillAmountSubunits = swap.matchedAmountSubunits;
  if (
    !sourceOrder ||
    swap.buyerLocktime === null ||
    typeof swap.baseAsset !== "string" ||
    swap.baseAsset.length === 0 ||
    typeof swap.divisibility !== "number" ||
    !Number.isSafeInteger(swap.divisibility) ||
    swap.divisibility <= 0 ||
    typeof failedFillAmountSubunits !== "number" ||
    !Number.isSafeInteger(failedFillAmountSubunits) ||
    failedFillAmountSubunits <= 0
  ) {
    return;
  }
  if (
    !canRecoverFailedTakerFill({
      failureReason,
      isTaker: swap.isTaker === true,
      failedFillAmountSubunits,
    })
  ) {
    return;
  }
  const clientOrderId = useActiveSwapsStore
    .getState()
    .beginTakerRecovery(swap.tradeId, crypto.randomUUID());
  if (!clientOrderId) return;

  try {
    const result = await recoverFailedTakerFill({
      failureReason,
      isTaker: swap.isTaker === true,
      deadlineMs: swap.buyerLocktime * 1_000,
      sourceOrder,
      failedFillAmountSubunits,
      resubmitAttempt: swap.recoveryAttempt ?? 0,
      submitOrder,
      newClientOrderId: () => clientOrderId,
    });
    if (result.kind !== "resubmitted") return;

    useActiveSwapsStore
      .getState()
      .markTakerRecoverySubmitted(swap.tradeId, result.orderId);

    await persistGuiPendingTrade({
      orderId: result.orderId,
      marketId: sourceOrder.marketId,
      clientOrderId: result.clientOrderId,
      submittedAt: Date.now(),
      baseAsset: swap.baseAsset,
      divisibility: swap.divisibility,
      side: sourceOrder.side,
      tokenSide: sourceOrder.tokenSide,
      priceSubunits: sourceOrder.price,
      amountSubunits: failedFillAmountSubunits,
      timeInForce: sourceOrder.timeInForce,
      recoveryAttempt: (swap.recoveryAttempt ?? 0) + 1,
    });
    useToastStore.getState().addToast({
      type: "info",
      message: "Maker collateral failed. Re-submitting the unfilled amount.",
    });
  } catch (error) {
    console.warn("Failed to re-submit maker-caused taker fill", error);
  }
}

function sourceOrderForRecovery(swap: ActiveSwap): {
  marketId: string;
  outcomeId: string;
  tokenSide: "Outcome" | "Complement";
  side: "Buy" | "Sell";
  price: number;
  timeInForce: "FAK" | "FOK" | "GTC";
} | null {
  const separator = swap.marketId.lastIndexOf("-");
  if (
    separator <= 0 ||
    separator === swap.marketId.length - 1 ||
    !swap.side ||
    !swap.tokenSide ||
    typeof swap.priceSubunits !== "number" ||
    !Number.isSafeInteger(swap.priceSubunits) ||
    !swap.timeInForce
  ) {
    return null;
  }
  return {
    marketId: swap.marketId,
    outcomeId: swap.marketId.slice(separator + 1),
    tokenSide: swap.tokenSide,
    side: swap.side,
    price: swap.priceSubunits,
    timeInForce: swap.timeInForce,
  };
}

async function sendSwapMessageWithRetry(
  sendSwapMessage: SendSwapMessageFn,
  tradeId: string,
  messageType: TradeMessageType,
  ciphertext: string,
  deadlineSeconds: number,
  authorize: () => Promise<GuiDeliveryAuthorization>,
): Promise<GuiDeliveryAttempt> {
  if (
    typeof deadlineSeconds !== "number" ||
    !Number.isSafeInteger(deadlineSeconds)
  ) {
    throw new Error("Swap message is missing a valid buyer locktime deadline");
  }
  const result = await retryTransientTradeOperation({
    deadlineMs: deadlineSeconds * 1_000,
    operation: async () => {
      const authorization = await authorize();
      if (authorization !== "replay") return authorization;
      await sendSwapMessage(tradeId, messageType, ciphertext);
      return "sent" as const;
    },
  });
  if (result.kind === "deadline-expired") {
    throw new Error("Swap message retry deadline expired before delivery");
  }
  return result.value;
}

interface GuiSwapTransportAuthority {
  walletId: string;
  tradeId: string;
  orderId: string;
  marketId: string;
  role: SwapRole;
  localProtocolPubkey: string;
  counterpartyProtocolPubkey: string;
  mintUrl: string;
  sellerLocktimeSeconds: number;
  deadlineSeconds: number;
}

interface GuiTradeJoinDelivery {
  walletId: string;
  tradeId: string;
  orderId: string;
  marketId: string;
  localProtocolPubkey: string;
}

interface GuiSwapCipherDelivery extends GuiSwapTransportAuthority {
  messageType: SwapCipherMessageType;
  ciphertext: string;
}

type GuiSettlementCompleteDelivery = GuiSwapTransportAuthority;

type GuiDeliveryAuthorization = "replay" | "terminal" | "busy";
type GuiDeliveryAttempt = "sent" | "terminal" | "busy";

type GuiExactSwapRead<T> =
  | { kind: "ready"; value: T }
  | { kind: "missing" }
  | { kind: "busy" };

async function deliverGuiRecoveryTransportPlan(
  plan: GuiRecoveryTransportPlan,
  walletId: string,
  joinTrade: (tradeId: string) => Promise<void>,
  sendSwapMessage: SendSwapMessageFn,
): Promise<boolean> {
  if (!plan.join) return plan.ciphers.length === 0;
  if (
    plan.ciphers.some((candidate) => candidate.tradeId !== plan.join!.tradeId)
  ) {
    throw new Error("Durable GUI recovery mixed trade transport authority");
  }
  if (plan.join.walletId !== walletId) {
    throw new Error("Durable GUI recovery mixed wallet transport authority");
  }
  await requireExactGuiTradeJoinDelivery(plan.join);
  await joinTrade(plan.join.tradeId);
  await requireExactGuiTradeJoinDelivery(plan.join);
  for (const delivery of plan.ciphers) {
    const result = await deliverPersistedGuiSwapCipher(
      walletId,
      delivery.tradeId,
      sendSwapMessage,
      delivery.messageType,
      delivery.ciphertext,
    );
    if (result === "terminal") return true;
    if (result !== "sent") return false;
  }
  return true;
}

async function deliverPersistedGuiSwapCipher(
  walletId: string,
  tradeId: string,
  sendSwapMessage: SendSwapMessageFn,
  messageType: SwapCipherMessageType,
  expectedCiphertext?: string,
): Promise<GuiDeliveryAttempt | "blocked"> {
  const read = await tryReadGuiSwapCipherDelivery(
    walletId,
    tradeId,
    messageType,
  );
  if (read.kind === "busy") return "busy";
  if (read.kind === "missing") return "blocked";
  const delivery = read.value;
  if (
    expectedCiphertext !== undefined &&
    delivery.ciphertext !== expectedCiphertext
  ) {
    throw new Error("Durable GUI swap cipher authority was substituted");
  }
  const attempt = await sendSwapMessageWithRetry(
    sendSwapMessage,
    tradeId,
    messageType,
    delivery.ciphertext,
    delivery.deadlineSeconds,
    () =>
      authorizeGuiSwapDelivery(delivery, () =>
        requireExactGuiSwapCipherDelivery(delivery),
      ),
  );
  if (attempt === "terminal") {
    clearGuiDeliveryRecovery(walletId, tradeId);
    return attempt;
  }
  if (attempt === "busy") return attempt;
  const exact = await requireExactGuiSwapCipherDelivery(delivery);
  if (exact === "busy") return "busy";
  clearGuiDeliveryRecovery(walletId, tradeId);
  return "sent";
}

async function tryReadGuiSwapCipherDelivery(
  walletId: string,
  tradeId: string,
  messageType: SwapCipherMessageType,
): Promise<GuiExactSwapRead<GuiSwapCipherDelivery>> {
  return tryReadExactGuiSwap(walletId, tradeId, (swap) => {
    const ciphertext = persistedGuiSwapCipher(swap, messageType);
    if (!ciphertext) throw new Error("Durable GUI swap cipher is missing");
    return {
      ...guiSwapTransportAuthority(walletId, swap),
      messageType,
      ciphertext,
    };
  });
}

async function requireExactGuiSwapCipherDelivery(
  expected: GuiSwapCipherDelivery,
): Promise<"exact" | "busy"> {
  const read = await tryReadGuiSwapCipherDelivery(
    expected.walletId,
    expected.tradeId,
    expected.messageType,
  );
  if (read.kind === "busy") return "busy";
  if (read.kind === "missing") {
    throw new Error("GUI swap message authority is missing");
  }
  const current = read.value;
  if (
    !sameGuiSwapTransportAuthority(expected, current) ||
    current.ciphertext !== expected.ciphertext
  ) {
    throw new Error("GUI wallet changed before swap message replay");
  }
  return "exact";
}

function guiTradeJoinDelivery(
  walletId: string,
  swap: ActiveSwap,
): GuiTradeJoinDelivery {
  if (!swap.orderId || !swap.marketId || !swap.ephemeralPubkeyHex) {
    throw new Error("Durable GUI trade join authority is incomplete");
  }
  return {
    walletId,
    tradeId: swap.tradeId,
    orderId: swap.orderId,
    marketId: swap.marketId,
    localProtocolPubkey: swap.ephemeralPubkeyHex,
  };
}

function sameGuiTradeJoinDelivery(
  expected: GuiTradeJoinDelivery,
  current: GuiTradeJoinDelivery,
): boolean {
  return (
    current.walletId === expected.walletId &&
    current.tradeId === expected.tradeId &&
    current.orderId === expected.orderId &&
    current.marketId === expected.marketId &&
    current.localProtocolPubkey === expected.localProtocolPubkey
  );
}

async function requireExactGuiTradeJoinDelivery(
  expected: GuiTradeJoinDelivery,
): Promise<void> {
  const read = await tryReadExactGuiSwap(
    expected.walletId,
    expected.tradeId,
    (swap) => guiTradeJoinDelivery(expected.walletId, swap),
  );
  if (
    read.kind !== "ready" ||
    !sameGuiTradeJoinDelivery(expected, read.value)
  ) {
    throw new Error("GUI wallet changed before trade join replay");
  }
}

async function tryReadExactGuiSwap<T>(
  walletId: string,
  tradeId: string,
  select: (swap: ActiveSwap) => T,
): Promise<GuiExactSwapRead<T>> {
  const attempt = await tryWithGuiCustodyProfileLock(async (context, lock) => {
    try {
      const exact = await loadExactGuiSwapForEffect(lock, tradeId);
      return exact ? select(exact) : null;
    } finally {
      await releaseGuiCustodyAuthority(lock, context.scope);
    }
  }, walletId);
  if (!attempt.acquired) return { kind: "busy" };
  if (attempt.value === null) return { kind: "missing" };
  return { kind: "ready", value: attempt.value };
}

function guiSwapTransportAuthority(
  walletId: string,
  swap: ActiveSwap,
): GuiSwapTransportAuthority {
  if (!swap.role || !swap.counterpartyPubkey || swap.sellerLocktime === null) {
    throw new Error("Durable GUI swap transport authority is incomplete");
  }
  return {
    walletId,
    tradeId: swap.tradeId,
    orderId: requireDurableGuiSwapOrderId(swap),
    marketId: swap.marketId,
    role: swap.role,
    localProtocolPubkey: swap.ephemeralPubkeyHex,
    counterpartyProtocolPubkey: swap.counterpartyPubkey,
    mintUrl: requireDurableGuiSwapMint(swap),
    sellerLocktimeSeconds: swap.sellerLocktime,
    deadlineSeconds: requireGuiSwapSendDeadline(swap),
  };
}

function sameGuiSwapTransportAuthority(
  expected: GuiSwapTransportAuthority,
  current: GuiSwapTransportAuthority,
): boolean {
  return (
    current.walletId === expected.walletId &&
    current.tradeId === expected.tradeId &&
    current.orderId === expected.orderId &&
    current.marketId === expected.marketId &&
    current.role === expected.role &&
    current.localProtocolPubkey === expected.localProtocolPubkey &&
    current.counterpartyProtocolPubkey ===
      expected.counterpartyProtocolPubkey &&
    current.mintUrl === expected.mintUrl &&
    current.sellerLocktimeSeconds === expected.sellerLocktimeSeconds &&
    current.deadlineSeconds === expected.deadlineSeconds
  );
}

async function authorizeGuiSwapDelivery(
  expected: GuiSwapTransportAuthority,
  requireExactDelivery: () => Promise<"exact" | "busy">,
): Promise<GuiDeliveryAuthorization> {
  const status = await fetchOrderStatus(expected.marketId, expected.orderId);
  if (!status) {
    throw new Error("Authorized order status is unavailable for swap replay");
  }
  if (
    status.marketId !== expected.marketId ||
    status.orderId !== expected.orderId
  ) {
    throw new Error("Authorized order status does not match swap authority");
  }
  const exactFills = status.fills.filter(
    (fill) => fill.tradeId === expected.tradeId,
  );
  if (exactFills.length !== 1) {
    throw new Error("Authorized order status has no unique exact swap fill");
  }
  const fill = exactFills[0];
  if (
    fill.makerOrderId !== expected.orderId &&
    fill.takerOrderId !== expected.orderId
  ) {
    throw new Error("Authorized swap fill is not owned by the exact order");
  }

  switch (fill.status) {
    case "Matched":
      return (await requireExactDelivery()) === "exact" ? "replay" : "busy";
    case "Filled":
      return reconcileFilledGuiSwapDelivery(expected);
    case "Failed":
      return reconcileFailedGuiSwapDelivery(expected);
    default:
      return assertNeverValue(fill.status);
  }
}

async function reconcileFilledGuiSwapDelivery(
  expected: GuiSwapTransportAuthority,
): Promise<"terminal" | "busy"> {
  const attempt = await tryWithGuiCustodyProfileLock(async (context, lock) => {
    try {
      const current = await loadExactGuiSwapForEffect(lock, expected.tradeId);
      if (
        !current ||
        !sameGuiSwapTransportAuthority(
          expected,
          guiSwapTransportAuthority(expected.walletId, current),
        )
      ) {
        throw new Error(
          "GUI swap authority changed before fill reconciliation",
        );
      }
      if (current.step === "completed") {
        return { terminal: current, changed: false };
      }
      const terminal = await commitGuiSwapCandidate(lock, {
        ...current,
        step: "completed",
        settlementCompleteDelivery: "delivered",
        inFlightSteps: {},
      });
      return { terminal, changed: true };
    } finally {
      await releaseGuiCustodyAuthority(lock, context.scope);
    }
  }, expected.walletId);
  if (!attempt.acquired) return "busy";
  if (attempt.value.changed) {
    publishGuiSwapCompletion(expected.walletId, attempt.value.terminal);
  }
  return "terminal";
}

async function reconcileFailedGuiSwapDelivery(
  expected: GuiSwapTransportAuthority,
): Promise<"terminal" | "busy"> {
  const disposition =
    classifyDurableTradeRecoveryDisposition("engine-terminal");
  if (disposition.action !== "await-refund-salvage") {
    throw new Error("SDK engine-terminal recovery disposition changed");
  }
  const attempt = await tryWithGuiCustodyProfileLock(async (context, lock) => {
    try {
      const current = await loadExactGuiSwapForEffect(lock, expected.tradeId);
      if (
        !current ||
        !sameGuiSwapTransportAuthority(
          expected,
          guiSwapTransportAuthority(expected.walletId, current),
        )
      ) {
        throw new Error(
          "GUI swap authority changed before failure reconciliation",
        );
      }
      if (current.step === "completed" || current.step === "awaiting-refund") {
        return;
      }
      await commitGuiSwapCandidate(lock, {
        ...current,
        step: "awaiting-refund",
        error: "Settlement ended before both parties confirmed.",
        inFlightSteps: {},
      });
    } finally {
      await releaseGuiCustodyAuthority(lock, context.scope);
    }
  }, expected.walletId);
  return attempt.acquired ? "terminal" : "busy";
}

function assertNeverValue(value: never): never {
  throw new Error(`Unhandled closed value: ${JSON.stringify(value)}`);
}

function requireGuiSwapSendDeadline(swap: ActiveSwap): number {
  if (swap.buyerLocktime === null) {
    throw new Error("Durable GUI swap deadline is missing");
  }
  return swap.buyerLocktime;
}

function persistedGuiSwapCipher(
  swap: ActiveSwap,
  messageType: SwapCipherMessageType,
): string | undefined {
  switch (messageType) {
    case TRADE_MESSAGE_TYPES.adaptorPoint:
      return swap.sellerState?.adaptorPointCipher;
    case TRADE_MESSAGE_TYPES.lockedProofsSeller:
      return swap.sellerState?.lockedProofsCipher;
    case TRADE_MESSAGE_TYPES.lockedProofsBuyer: {
      const stateCipher = swap.buyerState?.lockedProofsCipher;
      const messageCipher = swap.messages.lockedProofsBuyer;
      if (stateCipher && messageCipher && stateCipher !== messageCipher) {
        throw new Error("Durable GUI buyer cipher authority conflicts");
      }
      return stateCipher ?? messageCipher;
    }
  }
}

async function tryReadSettlementCompleteDelivery(
  walletId: string,
  tradeId: string,
): Promise<GuiExactSwapRead<GuiSettlementCompleteDelivery>> {
  const read = await tryReadExactGuiSwap(walletId, tradeId, (swap) => {
    if (
      swap.step !== "awaiting-confirmation" ||
      swap.settlementCompleteDelivery !== "pending"
    ) {
      return null;
    }
    return guiSwapTransportAuthority(walletId, swap);
  });
  if (read.kind !== "ready") return read;
  return read.value === null
    ? { kind: "missing" }
    : { kind: "ready", value: read.value };
}

async function requireExactSettlementCompleteDelivery(
  expected: GuiSettlementCompleteDelivery,
): Promise<"exact" | "busy"> {
  const read = await tryReadSettlementCompleteDelivery(
    expected.walletId,
    expected.tradeId,
  );
  if (read.kind === "busy") return "busy";
  if (
    read.kind === "missing" ||
    !sameGuiSwapTransportAuthority(expected, read.value)
  ) {
    throw new Error("GUI wallet changed before settlement delivery");
  }
  return "exact";
}

async function commitDeliveredSettlementComplete(
  expected: GuiSettlementCompleteDelivery,
): Promise<"committed" | "busy" | "stale"> {
  const attempt = await tryWithGuiCustodyProfileLock(async (context, lock) => {
    try {
      const current = await loadExactGuiSwapForEffect(lock, expected.tradeId);
      if (
        !current ||
        current.step !== "awaiting-confirmation" ||
        current.settlementCompleteDelivery !== "pending" ||
        !sameGuiSwapTransportAuthority(
          expected,
          guiSwapTransportAuthority(expected.walletId, current),
        )
      ) {
        return false;
      }
      await commitGuiSwapCandidate(lock, {
        ...current,
        settlementCompleteDelivery: "delivered",
      });
      return true;
    } finally {
      await releaseGuiCustodyAuthority(lock, context.scope);
    }
  }, expected.walletId);
  if (!attempt.acquired) return "busy";
  return attempt.value ? "committed" : "stale";
}

async function runSettlementClaim(
  tradeId: string,
  sendSwapMessage: SendSwapMessageFn,
  wakeRecovery: () => void,
): Promise<void> {
  const walletId = currentGuiWalletId();
  const deliveryPending = await runSettlementClaimWithShortLocks(
    tradeId,
    walletId,
  );
  if (!deliveryPending) return;
  try {
    const result = await deliverSettlementComplete(
      walletId,
      tradeId,
      sendSwapMessage,
    );
    if (result !== "sent" && result !== "terminal") {
      handleDeferredGuiDelivery(walletId, tradeId, result, wakeRecovery);
    }
  } catch {
    // The pending delivery intent remains durable and will replay on recovery.
    scheduleGuiDeliveryRecovery(walletId, tradeId, wakeRecovery);
  }
}

async function runSettlementClaimWithShortLocks(
  tradeId: string,
  walletId: string,
): Promise<boolean> {
  let deliveryPending = false;
  try {
    const swap = await withGuiSwapSessionOwnership(
      tradeId,
      (lock) => loadExactGuiSwapForEffect(lock, tradeId),
      walletId,
    );
    if (!swap || !swap.role) return false;
    if (
      swap.step === "awaiting-confirmation" ||
      swap.step === "awaiting-refund" ||
      swap.step === "completed" ||
      swap.step === "Failed"
    )
      return false;
    if (swap.role === "seller" && !swap.messages.lockedProofsBuyer)
      return false;
    const mintUrl = requireDurableGuiSwapMint(swap);
    const ctx = buildSwapContext(swap, mintUrl);
    if (!ctx) return false;
    if (swap.role === "seller") await runSellerClaim(swap, ctx, walletId);
    else await runBuyerClaim(swap, ctx, walletId);
    return withGuiSwapSessionOwnership(
      tradeId,
      async (lock) => {
        const exact = await loadGuiSwapSessionStateUnderLock(lock, tradeId);
        if (
          !exact ||
          exact.step === "awaiting-refund" ||
          exact.step === "completed" ||
          exact.step === "Failed"
        ) {
          return false;
        }
        await commitGuiSwapCandidate(lock, {
          ...exact,
          step: "awaiting-confirmation",
          settlementCompleteDelivery: "pending",
        });
        deliveryPending = true;
        return true;
      },
      walletId,
    );
  } catch (err) {
    if (!deliveryPending) failSwap(tradeId, err);
    return deliveryPending;
  }
}

async function resumeSettlementCompleteDelivery(
  tradeId: string,
  sendSwapMessage: SendSwapMessageFn,
  wakeRecovery: () => void,
): Promise<void> {
  const walletId = currentGuiWalletId();
  try {
    const result = await deliverSettlementComplete(
      walletId,
      tradeId,
      sendSwapMessage,
    );
    if (result !== "sent" && result !== "terminal") {
      handleDeferredGuiDelivery(walletId, tradeId, result, wakeRecovery);
    }
  } catch {
    // Keep the durable pending intent for an exact later replay.
    scheduleGuiDeliveryRecovery(walletId, tradeId, wakeRecovery);
  }
}

async function deliverSettlementComplete(
  walletId: string,
  tradeId: string,
  sendSwapMessage: SendSwapMessageFn,
): Promise<GuiDeliveryAttempt | "blocked"> {
  const read = await tryReadSettlementCompleteDelivery(walletId, tradeId);
  if (read.kind === "busy") return "busy";
  if (read.kind === "missing") return "blocked";
  const snapshot = read.value;
  const attempt = await sendSwapMessageWithRetry(
    sendSwapMessage,
    tradeId,
    TRADE_MESSAGE_TYPES.settlementComplete,
    "",
    snapshot.deadlineSeconds,
    () =>
      authorizeGuiSwapDelivery(snapshot, () =>
        requireExactSettlementCompleteDelivery(snapshot),
      ),
  );
  if (attempt === "terminal") {
    clearGuiDeliveryRecovery(walletId, tradeId);
    return attempt;
  }
  if (attempt === "busy") return attempt;
  const committed = await commitDeliveredSettlementComplete(snapshot);
  switch (committed) {
    case "committed":
      clearGuiDeliveryRecovery(walletId, tradeId);
      return "sent";
    case "busy":
      return "busy";
    case "stale":
      return "blocked";
    default:
      return assertNeverValue(committed);
  }
}

async function runSellerClaim(
  swap: ActiveSwap,
  ctx: SwapCtx,
  walletId: string,
): Promise<Proof[]> {
  if (!swap.sellerState) throw new Error("Missing seller adaptor state");
  if (!swap.messages.lockedProofsBuyer)
    throw new Error("Missing locked-proofs-buyer cipher");
  return sellerClaimSwap(
    ctx,
    swap.sellerState.adaptorPoint,
    swap.messages.lockedProofsBuyer,
    {
      operationId: proofOperationId(swap.tradeId, "seller-claim"),
      proofOperationStore: externalClaimGuiProofOperationStore(walletId, swap),
    },
  );
}

async function runBuyerClaim(
  swap: ActiveSwap,
  ctx: SwapCtx,
  walletId: string,
): Promise<Proof[]> {
  if (!swap.buyerState) throw new Error("Missing buyer pre-sig state");
  if (!swap.messages.lockedProofsSeller)
    throw new Error("Missing locked-proofs-seller cipher");
  const adaptorSecret = await pollForAdaptorSecret(
    ctx.mintUrl,
    swap.buyerState.lockedSatProofs,
    swap.buyerState.ownPreSigsHex,
  );
  return buyerClaimSwap(
    ctx,
    adaptorSecret,
    swap.messages.lockedProofsSeller,
    swap.buyerState.sellerPreSigsHex,
    {
      operationId: proofOperationId(swap.tradeId, "buyer-claim"),
      proofOperationStore: externalClaimGuiProofOperationStore(walletId, swap),
    },
  );
}

async function pollForAdaptorSecret(
  mintUrl: string,
  spentProofs: Proof[],
  preSigsHex: string[],
): Promise<Uint8Array> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const t = await buyerExtractSecret(mintUrl, spentProofs, preSigsHex);
    if (t) return t;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error("Timed out waiting for seller to spend at mint");
}

async function loadProofsForLock(
  mintUrl: string,
  targetSats: number | undefined,
  sellerMarketId: string | undefined,
  baseAsset: string | null | undefined,
  reservationId: string | undefined,
  walletId: string,
  tradeId: string = reservationId ?? "",
): Promise<Proof[]> {
  const outcome = sellerMarketId
    ? outcomeMetadataForMarket(sellerMarketId)
    : null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const proofs = await withGuiSwapSessionOwnership(
      tradeId,
      (lock) =>
        outcome
          ? getOutcomeProofsUnderLock(
              lock,
              mintUrl,
              outcome.conditionId,
              outcome.outcomeCollection,
              { baseAsset },
            )
          : getUnitProofsUnderLock(lock, mintUrl, {
              unit: defaultCollateralUnit(baseAsset),
            }),
      walletId,
    );
    if (proofs.length === 0) {
      throw new Error(
        outcome
          ? `No ${outcome.outcomeCollection} outcome proofs available for atomic swap`
          : "No proofs available for atomic swap — wallet is empty",
      );
    }
    const selected =
      targetSats === undefined ||
      !Number.isFinite(targetSats) ||
      targetSats <= 0
        ? proofs
        : takeProofsForLock(
            proofs,
            targetSats,
            await inputFeePpkByKeysetForProofs(mintUrl, proofs),
          );
    if (!selected) {
      throw new Error(
        `Insufficient proofs for atomic swap — need ${targetSats} sats`,
      );
    }
    if (
      !reservationId ||
      (await withGuiSwapSessionOwnership(
        tradeId,
        (lock) => tryReserveProofsUnderLock(lock, selected, reservationId),
        walletId,
      ))
    ) {
      return selected;
    }
  }

  throw new Error("Proofs were reserved by a concurrent atomic swap");
}

async function persistPartialLockParts(input: {
  walletId: string;
  swap: ActiveSwap;
  mintUrl: string;
  conditionId: string;
  collectionByKeyset: Map<string, string>;
  spentProofs: Proof[];
  lockedProofs: Proof[];
  changeProofs: Proof[];
  refundLocktime: number;
  detail: string;
}): Promise<void> {
  const affectedKeysets = uniqueProofKeysets(input.lockedProofs);
  const replacementProofs = [
    ...(await storedConditionalProofsFromMintMetadata({
      mintUrl: input.mintUrl,
      proofs: input.lockedProofs,
      expectedConditionId: input.conditionId,
      reservedBy: input.swap.tradeId,
      baseAsset: input.swap.baseAsset,
    })),
    ...(await storedConditionalProofsFromMintMetadata({
      mintUrl: input.mintUrl,
      proofs: input.changeProofs,
      expectedConditionId: input.conditionId,
      baseAsset: input.swap.baseAsset,
    })),
  ];

  const outcomeByKeyset: PartialLockHeldRecord["outcomeByKeyset"] = {};
  for (const keysetId of affectedKeysets) {
    const outcomeCollection = input.collectionByKeyset.get(keysetId);
    if (!outcomeCollection) {
      throw new Error(`No outcome collection metadata for keyset ${keysetId}`);
    }
    outcomeByKeyset[keysetId] = {
      conditionId: input.conditionId,
      outcomeCollection,
      marketId: `${input.conditionId}-${outcomeCollection}`,
    };
  }

  await withGuiSwapSessionOwnership(
    input.swap.tradeId,
    (lock) =>
      commitGuiPartialLockFailureUnderLock(lock, {
        spentProofs: input.spentProofs,
        replacementProofs,
        record: {
          kind: "PartialLockHeld",
          tradeId: input.swap.tradeId,
          orderId: input.swap.orderId,
          mintUrl: input.mintUrl,
          refundLocktime: input.refundLocktime,
          affectedKeysets,
          detail: input.detail,
          outcomeByKeyset,
          lockedProofs: input.lockedProofs,
          createdAt: Date.now(),
        },
      }),
    input.walletId,
  );
}

function partialLockFromError(err: unknown): {
  failure: {
    refundLocktime: number;
    affectedKeysets: string[];
    detail: string;
  };
  spentProofs: Proof[];
  lockedProofs: Proof[];
  changeProofs: Proof[];
} | null {
  if (!err || typeof err !== "object") return null;
  const maybe = err as { partialLock?: unknown };
  if (!maybe.partialLock || typeof maybe.partialLock !== "object") return null;
  const partial = maybe.partialLock as {
    failure?: {
      refundLocktime?: unknown;
      affectedKeysets?: unknown;
      detail?: unknown;
    };
    spentProofs?: unknown;
    lockedProofs?: unknown;
    changeProofs?: unknown;
  };
  if (
    typeof partial.failure?.refundLocktime !== "number" ||
    !Array.isArray(partial.spentProofs) ||
    !Array.isArray(partial.lockedProofs)
  ) {
    return null;
  }
  return {
    failure: {
      refundLocktime: partial.failure.refundLocktime,
      affectedKeysets: Array.isArray(partial.failure.affectedKeysets)
        ? partial.failure.affectedKeysets.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
      detail:
        typeof partial.failure.detail === "string"
          ? partial.failure.detail
          : "Partial lock held",
    },
    spentProofs: partial.spentProofs.filter(isProofLike),
    lockedProofs: partial.lockedProofs.filter(isProofLike),
    changeProofs: Array.isArray(partial.changeProofs)
      ? partial.changeProofs.filter(isProofLike)
      : [],
  };
}

function isProofLike(value: unknown): value is Proof {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { secret?: unknown }).secret === "string" &&
    typeof (value as { C?: unknown }).C === "string"
  );
}

function proofOperationId(tradeId: string, step: string): string {
  return `${tradeId}/browser/${step}`;
}

interface OutcomeProofMetadata {
  conditionId: string;
  outcomeCollection: string;
  marketId: string;
}

function outcomeMetadataForMarket(
  marketId: string,
): OutcomeProofMetadata | null {
  const parts = splitMarketId(marketId);
  if (!parts) return null;
  return outcomeMetadataForCondition(parts.conditionId, parts.outcomeName);
}

function outcomeMetadataForCondition(
  conditionId: string,
  outcomeCollection: string,
): OutcomeProofMetadata {
  return {
    conditionId,
    outcomeCollection,
    marketId: `${conditionId}-${outcomeCollection}`,
  };
}

// ---------------------------------------------------------------------------
// Cleanup helpers
// ---------------------------------------------------------------------------

async function finishSwap(tradeId: string): Promise<void> {
  const walletId = currentGuiWalletId();
  const committed = await withGuiSwapSessionOwnership(
    tradeId,
    async (lock) => {
      const durable = await loadExactGuiSwapForEffect(lock, tradeId);
      const swap =
        durable ?? useActiveSwapsStore.getState().byTradeId[tradeId] ?? null;
      if (!heldGuiWalletIsCurrent(lock)) return null;
      if (!swap || swap.step === "completed") return null;
      const terminal: ActiveSwap = {
        ...swap,
        step: "completed",
      };
      if (canPersistGuiSwapSession(terminal)) {
        await commitGuiSwapCandidate(lock, terminal);
      } else {
        replaceActiveSwap(terminal);
      }
      return terminal;
    },
    walletId,
  );
  if (!committed) return;
  publishGuiSwapCompletion(walletId, committed);
}

function publishGuiSwapCompletion(
  walletId: string,
  terminal: ActiveSwap,
): void {
  if (currentGuiWalletId() !== walletId) return;
  emitTradeTerminal({
    tradeId: terminal.tradeId,
    marketId: terminal.marketId,
    state: "Confirmed",
  });
  const toast = useToastStore.getState().addToast;
  toast({
    type: "success",
    message: `Trade complete: ${terminal.marketId}`,
  });
  // The terminal commit already retired the durable active-session index.
  // This timer removes only the transient UI projection; custody remains
  // charged until authenticated replay-cutoff evidence permits SDK release.
  setTimeout(() => {
    if (currentGuiWalletId() !== walletId) return;
    useActiveSwapsStore.getState().remove(terminal.tradeId);
  }, 5_000);
}

function failSwap(tradeId: string, _err: unknown): void {
  deferSwapRecovery(tradeId);
}

function deferSwapRecovery(
  tradeId: string,
  state: DurableTradeMintRecoveryState = "mint-response-unknown",
): void {
  const disposition = classifyDurableTradeRecoveryDisposition(state);
  console.warn("[swap.recovery-retained]", {
    tradeId,
    action: disposition.action,
  });
}

// ---------------------------------------------------------------------------
// Swap-context construction
// ---------------------------------------------------------------------------

interface SwapCtx {
  tradeId: string;
  role: SwapRole;
  ephemeralKey: { privateKey: Uint8Array; publicKey: string };
  counterpartyPubkey: string;
  sellerLocktime: number;
  buyerLocktime: number;
  mintUrl: string;
}

function buildSwapContext(swap: ActiveSwap, _mintUrl?: string): SwapCtx | null {
  if (
    !swap.role ||
    !swap.counterpartyPubkey ||
    swap.sellerLocktime === null ||
    swap.buyerLocktime === null
  ) {
    return null;
  }
  return {
    tradeId: swap.tradeId,
    role: swap.role,
    ephemeralKey: {
      privateKey: hexToBytes(swap.ephemeralPrivkeyHex),
      publicKey: swap.ephemeralPubkeyHex,
    },
    counterpartyPubkey: swap.counterpartyPubkey,
    sellerLocktime: swap.sellerLocktime,
    buyerLocktime: swap.buyerLocktime,
    mintUrl: requireDurableGuiSwapMint(swap),
  };
}

function swapMintUrl(swap: ActiveSwap, fallback: string): string {
  return normalizeUrl(swap.mintUrl ?? fallback);
}

function canPersistGuiSwapSession(swap: ActiveSwap): boolean {
  return Boolean(
    swap.role &&
    swap.counterpartyPubkey &&
    swap.sellerLocktime !== null &&
    swap.buyerLocktime !== null,
  );
}

type SendSwapMessageFn = (
  tradeId: string,
  type: TradeMessageType,
  ciphertext: string,
) => Promise<void>;
