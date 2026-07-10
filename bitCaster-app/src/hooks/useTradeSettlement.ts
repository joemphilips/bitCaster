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
import type { Proof } from "@cashu/cashu-ts";
import {
  useTradeHub,
  type TradeCreatedPayload,
  type SwapMessage,
} from "@/hooks/useTradeHub";
import {
  useActiveSwapsStore,
  type ActiveSwap,
  type SwapRole,
  type SwapWorkKey,
} from "@/stores/activeSwaps";
import {
  usePendingTradesStore,
  type PendingTrade,
} from "@/stores/pendingTrades";
import { usePendingPubkeySubmissionsStore } from "@/stores/pendingPubkeySubmissions";
import { emitTradeTerminal } from "@/lib/tradeTerminalEvents";
import { useWalletStore } from "@/stores/wallet";
import { Mint as CashuMint } from "@cashu/cashu-ts";
import {
  addProofs,
  getUnitProofs,
  getOutcomeProofs,
  getProofOperation,
  markProofOperationCompleted,
  prepareProofOperation,
  removeProofs,
  replaceProofs,
  type StoredProof,
} from "@/stores/proof-db";
import {
  fetchOrderStatus,
  promoteFillsToActiveSwaps,
  splitMarketId,
} from "@/lib/orderStatus";
import { generateEphemeralKeyPair } from "@/lib/ephemeral-key";
import { submitEphemeralPubkey } from "@/lib/markets";
import { hexToBytes } from "@bitcaster/swap-protocol/ecdh";
import {
  buyerClaimSwap,
  buyerExtractSecret,
  buyerPrepareSwap,
  sellerClaimSwap,
  sellerLockOutcomeProofs,
  sellerPreparePrelockedSwap,
  sellerPrepareSwap,
  type ProofOperationRecord as SwapProofOperationRecord,
  type ProofOperationStore,
} from "@bitcaster/swap-protocol/atomicSwap";
import {
  computeGrossCtfInputAmountSats,
  resolveRootDirectLockOutputAmountSats,
  selectCollateralForCtfSplit,
  splitRegularProofsWithOperation,
  splitRootCompleteSetForSwap,
  type CtfProofOperationRecord,
  type CtfProofOperationStore,
} from "@/lib/ctfSplit";
import { useToastStore } from "@/stores/toast";
import { usePartialLockFailuresStore } from "@/stores/partialLockFailures";
import type {
  OutcomeMetadata,
  PartialLockHeldRecord,
} from "@bitcaster/client-sdk/swapFailure";
import {
  TRADE_MESSAGE_TYPES,
  type TradeMessageType,
} from "@/lib/tradeMessageTypes";
import {
  decideSwapMessage,
  decideTradeCreated,
  decideTradeStateChanged,
} from "@bitcaster/client-sdk/tradeFlow";
import {
  amountToNumber,
  takeProofsForLock,
} from "@bitcaster/client-sdk/proofSelection";
import {
  defaultCollateralUnit,
  normalizeMarketBaseAsset,
  normalizeMarketDivisibility,
} from "@bitcaster/client-sdk/marketUnits";
import { parseOutcomeSetId } from "@bitcaster/client-sdk/outcomeSets";
import {
  resolveConditionalProofMetadata,
  storedConditionalProofsFromMintMetadata,
} from "@/lib/conditionalKeysetMetadata";
import { resolveGrossCtfInputPlanningKeyset } from "@/lib/ctfGrossInputPlanning";

// ---------------------------------------------------------------------------
// Public hook
// ---------------------------------------------------------------------------

const proofOperationStore: ProofOperationStore = {
  getProofOperation: async (operationId) =>
    (await getProofOperation(operationId)) as SwapProofOperationRecord | null,
  prepareProofOperation: async (input) =>
    (await prepareProofOperation(input)) as SwapProofOperationRecord,
  markProofOperationCompleted: async (operationId, resultProofs) =>
    (await markProofOperationCompleted(
      operationId,
      resultProofs,
    )) as SwapProofOperationRecord,
};

const ctfProofOperationStore: CtfProofOperationStore = {
  getProofOperation: async (operationId) =>
    (await getProofOperation(operationId)) as CtfProofOperationRecord | null,
  prepareProofOperation: async (input) =>
    (await prepareProofOperation(input)) as CtfProofOperationRecord,
  markProofOperationCompleted: async (operationId, resultProofs) =>
    (await markProofOperationCompleted(
      operationId,
      resultProofs,
    )) as CtfProofOperationRecord,
};

async function prepareRegularCollateralForCtfSplit(input: {
  mintUrl: string;
  available: Proof[];
  faceAmountSats: number;
  baseAsset?: string | null;
  reservationId: string;
  operationId: string;
}): Promise<Proof[]> {
  const baseAsset = normalizeMarketBaseAsset(input.baseAsset);
  const unit = defaultCollateralUnit(baseAsset);
  const existingRegularSplit = await getProofOperation(input.operationId);
  if (existingRegularSplit) {
    const wallet = await useWalletStore
      .getState()
      .getWallet(input.mintUrl, baseAsset);
    const grossPlanningKeyset = await resolveGrossCtfInputPlanningKeyset(wallet);
    const grossCtfInputSats = computeGrossCtfInputAmountSats({
      faceAmountSats: input.faceAmountSats,
      keyset: grossPlanningKeyset,
    });
    const regularSplit = await splitRegularProofsWithOperation({
      mintUrl: input.mintUrl,
      baseAsset,
      operationId: input.operationId,
      wallet,
      proofs: [],
      amountSats: grossCtfInputSats,
      proofOperationStore: ctfProofOperationStore,
    });
    const exact = await selectCollateralForCtfSplit(
      input.mintUrl,
      regularSplit.send,
      input.faceAmountSats,
      baseAsset,
    );
    await removeProofs(regularSplit.spent.map((proof) => proof.secret));
    await addProofs([
      ...regularSplit.keep.map((proof) => ({
        ...proof,
        mintUrl: input.mintUrl,
        baseAsset,
        unit,
      })),
      ...exact.inputs.map((proof) => ({
        ...proof,
        mintUrl: input.mintUrl,
        baseAsset,
        unit,
        reservedBy: input.reservationId,
      })),
    ]);
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
    .getWallet(input.mintUrl, baseAsset);
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
    throw new Error("No regular collateral proofs are available for CTF split.");
  }
  const regularSplit = await splitRegularProofsWithOperation({
    mintUrl: input.mintUrl,
    baseAsset,
    operationId: input.operationId,
    wallet,
    proofs: selected.send,
    amountSats: grossCtfInputSats,
    proofOperationStore: ctfProofOperationStore,
  });
  const exact = await selectCollateralForCtfSplit(
    input.mintUrl,
    regularSplit.send,
    input.faceAmountSats,
    baseAsset,
  );
  await removeProofs(regularSplit.spent.map((proof) => proof.secret));
  await addProofs([
    ...regularSplit.keep.map((proof) => ({
      ...proof,
      mintUrl: input.mintUrl,
      baseAsset,
      unit,
    })),
    ...exact.inputs.map((proof) => ({
      ...proof,
      mintUrl: input.mintUrl,
      baseAsset,
      unit,
      reservedBy: input.reservationId,
    })),
  ]);
  return exact.inputs;
}

const tradeCreatedInFlight = new Set<string>();
const tradeCreatedFingerprints = new Map<string, string>();
const joinedTradeIds = new Set<string>();
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
  const pendingTradesByOrderId = usePendingTradesStore((s) => s.byOrderId);
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
  const [recoveryEpoch, setRecoveryEpoch] = useState(0);
  const activeMintUrl = useWalletStore((s) => s.activeMintUrl);
  const hasActiveSwapWork = Object.values(swapsByTradeId).some(
    (swap) => swap.step !== "completed" && swap.step !== "Failed",
  );
  const pendingTrades = Object.values(pendingTradesByOrderId);
  const tradeHubEnabled =
    canAuthenticateTradeHub && (hasActiveSwapWork || pendingTrades.length > 0);

  const requestRecovery = () => {
    joinedTradeIds.clear();
    joinedOrderKeysRef.current.clear();
    setRecoveryEpoch((current) => current + 1);
  };

  const { joinOrder, joinTrade, sendSwapMessage } = useTradeHub(
    tradeHubEnabled,
    {
      onTradeCreated: (payload) =>
        void handleTradeCreated(
          payload,
          joinTrade,
          sendSwapMessage,
          activeMintUrl,
        ),
      onSwapMessageReceived: (msg) =>
        handleSwapMessage(msg, sendSwapMessage, activeMintUrl),
      onTradeStateChanged: (tradeId, newState) =>
        handleTradeStateChanged(tradeId, newState, sendSwapMessage),
      onReconnected: requestRecovery,
    },
  );

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") requestRecovery();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    if (!tradeHubEnabled) return;
    const scheduleTradeJoinRetry = (tradeId: string) => {
      if (tradeJoinRetryTimersRef.current.has(tradeId)) return;
      const timer = setTimeout(() => {
        tradeJoinRetryTimersRef.current.delete(tradeId);
        joinedTradeIds.delete(tradeId);
        const latest = useActiveSwapsStore.getState().byTradeId[tradeId];
        if (!latest || latest.step !== "awaiting-trade-created") {
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
      joinTrade(swap.tradeId)
        .then(() => {
          tradeJoinAttemptsRef.current.delete(swap.tradeId);
        })
        .catch((err) => {
          joinedTradeIds.delete(swap.tradeId);
          const latest = useActiveSwapsStore.getState().byTradeId[swap.tradeId];
          if (!latest || latest.step !== "awaiting-trade-created") {
            tradeJoinAttemptsRef.current.delete(swap.tradeId);
            return;
          }

          const attempts =
            (tradeJoinAttemptsRef.current.get(swap.tradeId) ?? 0) + 1;
          tradeJoinAttemptsRef.current.set(swap.tradeId, attempts);
          if (attempts >= MAX_JOIN_TRADE_RETRIES) {
            const message = err instanceof Error ? err.message : String(err);
            useActiveSwapsStore
              .getState()
              .setStep(swap.tradeId, "Failed", message);
            tradeJoinAttemptsRef.current.delete(swap.tradeId);
            return;
          }
          scheduleTradeJoinRetry(swap.tradeId);
        });
    };

    for (const swap of Object.values(swapsByTradeId)) {
      if (swap.step !== "awaiting-trade-created") continue;
      attemptJoinActiveSwap(swap);
    }
  }, [swapsByTradeId, tradeHubEnabled, joinTrade, sendSwapMessage, recoveryEpoch]);

  useEffect(() => {
    if (!tradeHubEnabled) return;

    const liveKeys = new Set(
      pendingTrades.map((trade) => `${trade.marketId}:${trade.orderId}`),
    );
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

    const scheduleOrderStatusRecovery = (trade: PendingTrade) => {
      const key = `${trade.marketId}:${trade.orderId}`;
      if (orderStatusRecoveryTimersRef.current.has(key)) return;

      const timer = setTimeout(() => {
        orderStatusRecoveryTimersRef.current.delete(key);
        const latest =
          usePendingTradesStore.getState().byOrderId[trade.orderId];
        if (!latest) {
          orderStatusRecoveryAttemptsRef.current.delete(key);
          return;
        }

        const attempts =
          (orderStatusRecoveryAttemptsRef.current.get(key) ?? 0) + 1;
        orderStatusRecoveryAttemptsRef.current.set(key, attempts);

        void (async () => {
          try {
            await joinOrder(latest.marketId, latest.orderId);
          } catch {
            // Transient hub or projection lag. The REST status fallback below
            // may still expose the trade id; otherwise the next recovery tick
            // retries the hub replay path.
          }

          return fetchOrderStatus(latest.marketId, latest.orderId);
        })()
          .then(async (status) => {
            if (!status) return;
            const pendingTradeId = typeof status.tradeId === "string" ? status.tradeId : null;
            const pendingDeadline = typeof status.deadline === "string" ? status.deadline : null;
            if (pendingTradeId && pendingDeadline) {
              await submitPendingPubkeyFromRecovery(latest, pendingTradeId, pendingDeadline);
            }
            const tradeIds = status.fills
              .map((fill) => fill.tradeId)
              .filter((tradeId): tradeId is string => Boolean(tradeId));
            if (tradeIds.length > 0) {
              promoteFillsToActiveSwaps(status.fills, latest, 0);
              try {
                await Promise.all(
                  tradeIds.map((tradeId) => joinTrade(tradeId)),
                );
                orderStatusRecoveryAttemptsRef.current.delete(key);
                return;
              } catch {
                if (attempts < MAX_ORDER_STATUS_RECOVERY_ATTEMPTS) {
                  scheduleOrderStatusRecovery(latest);
                }
                return;
              }
            }
            if (attempts < MAX_ORDER_STATUS_RECOVERY_ATTEMPTS) {
              scheduleOrderStatusRecovery(latest);
            }
          })
          .catch(() => {
            if (attempts < MAX_ORDER_STATUS_RECOVERY_ATTEMPTS) {
              scheduleOrderStatusRecovery(latest);
            }
          });
      }, ORDER_STATUS_RECOVERY_MS);

      orderStatusRecoveryTimersRef.current.set(key, timer);
    };

    const scheduleOrderJoinRetry = (
      key: string,
      orderId: string,
      attemptJoinOrder: (trade: PendingTrade) => void,
    ) => {
      const retry = setTimeout(() => {
        orderJoinRetryTimersRef.current.delete(key);
        const latest = usePendingTradesStore.getState().byOrderId[orderId];
        if (!latest) return;
        attemptJoinOrder(latest);
      }, JOIN_ORDER_RETRY_MS);
      orderJoinRetryTimersRef.current.set(key, retry);
    };

    const attemptJoinOrder = (trade: PendingTrade) => {
      const key = `${trade.marketId}:${trade.orderId}`;
      if (joinedOrderKeysRef.current.has(key)) return;
      if (orderJoinRetryTimersRef.current.has(key)) return;

      joinedOrderKeysRef.current.add(key);
      void fetchOrderStatus(trade.marketId, trade.orderId)
        .then(async (status) => {
          if (!status) {
            try {
              await joinOrder(trade.marketId, trade.orderId);
              orderJoinMissCountsRef.current.delete(key);
              scheduleOrderStatusRecovery(trade);
              return;
            } catch {
              const misses =
                (orderJoinMissCountsRef.current.get(key) ?? 0) + 1;
              orderJoinMissCountsRef.current.set(key, misses);
              joinedOrderKeysRef.current.delete(key);
              if (misses >= MAX_JOIN_ORDER_STATUS_MISSES) {
                usePendingTradesStore.getState().remove(trade.orderId);
                return;
              }
              scheduleOrderJoinRetry(key, trade.orderId, attemptJoinOrder);
              return;
            }
          }

          orderJoinMissCountsRef.current.delete(key);
          scheduleOrderStatusRecovery(trade);
          return joinOrder(trade.marketId, trade.orderId);
        })
        .catch(() => {
          joinedOrderKeysRef.current.delete(key);
          if (!usePendingTradesStore.getState().byOrderId[trade.orderId])
            return;
          scheduleOrderJoinRetry(key, trade.orderId, attemptJoinOrder);
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

// ---------------------------------------------------------------------------
// TradeCreated → assign role + drive seller's first messages
// ---------------------------------------------------------------------------

async function handleTradeCreated(
  payload: TradeCreatedPayload,
  joinTrade: (tradeId: string) => Promise<void>,
  sendSwapMessage: SendSwapMessageFn,
  mintUrl: string,
): Promise<void> {
  const fingerprint = tradeCreatedFingerprint(payload);
  const existingFingerprint = tradeCreatedFingerprints.get(payload.tradeId);
  if (existingFingerprint && existingFingerprint !== fingerprint) {
    useActiveSwapsStore
      .getState()
      .setStep(
        payload.tradeId,
        "Failed",
        "TradeCreated payload changed for an existing trade.",
      );
    return;
  }
  tradeCreatedFingerprints.set(payload.tradeId, fingerprint);
  if (tradeCreatedInFlight.has(payload.tradeId)) return;
  tradeCreatedInFlight.add(payload.tradeId);
  try {
    await handleTradeCreatedOnce(payload, joinTrade, sendSwapMessage, mintUrl);
  } finally {
    tradeCreatedInFlight.delete(payload.tradeId);
  }
}

async function handleTradeCreatedOnce(
  payload: TradeCreatedPayload,
  joinTrade: (tradeId: string) => Promise<void>,
  sendSwapMessage: SendSwapMessageFn,
  mintUrl: string,
): Promise<void> {
  let swap: ActiveSwap | null =
    useActiveSwapsStore.getState().byTradeId[payload.tradeId] ?? null;
  if (swap?.role) return;
  const promotedFromPending = !swap;
  if (!swap) {
    swap = promotePendingTradeFromTradeCreated(payload);
  }
  if (!swap) return;
  const ownEphemeralPubkey = getPendingPubkeyForTrade(payload.tradeId)?.pubkey;
  if (!ownEphemeralPubkey) {
    useActiveSwapsStore
      .getState()
      .setStep(payload.tradeId, "Failed", "Missing match-time ephemeral pubkey.");
    return;
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
    useActiveSwapsStore
      .getState()
      .setStep(payload.tradeId, "Failed", decision.error);
    return;
  }

  if (promotedFromPending) {
    if (joinedTradeIds.has(payload.tradeId)) return;
    joinedTradeIds.add(payload.tradeId);
    try {
      await joinTrade(payload.tradeId);
    } catch (err) {
      joinedTradeIds.delete(payload.tradeId);
      return;
    }
  }

  const latest = useActiveSwapsStore.getState().byTradeId[payload.tradeId];
  if (!latest || latest.role || latest.step === "Failed") return;
  swap = latest;

  useActiveSwapsStore.getState().setRoleAndCounterparty(
    payload.tradeId,
    decision.role,
    decision.counterpartyPubkey,
    {
      sellerLocktime: decision.sellerLocktime,
      buyerLocktime: decision.buyerLocktime,
    },
    {
      outcomeFaceAmountSats: undefined,
      outcomeFaceAmountSubunits: payload.outcomeFaceAmountSubunits ?? undefined,
      quotePaymentSats: undefined,
      baseAsset: payload.baseAsset,
      divisibility: payload.divisibility,
      quotePaymentSubunits: payload.quotePaymentSubunits,
      settlementKind: payload.settlementKind,
      sellerKeepOutcomeSetId: payload.sellerKeepOutcomeSetId,
      sellerLockOutcomeSetId: payload.sellerLockOutcomeSetId,
    },
  );

  if (decision.role === "seller") {
    void runSellerSendOpening(payload.tradeId, sendSwapMessage, mintUrl);
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
    baseAsset: normalizeMarketBaseAsset(payload.baseAsset),
    divisibility: normalizeMarketDivisibility(payload.divisibility),
    tokenSide: payload.tokenSide ?? null,
  });
}

function promotePendingTradeFromTradeCreated(
  payload: TradeCreatedPayload,
): ActiveSwap | null {
  const match = findPendingTradeForTradeCreated(payload);
  if (!match) return null;
  const { pendingTrade } = match;
  const pendingPubkey = getPendingPubkeyForTrade(payload.tradeId);
  if (!pendingPubkey) return null;

  useActiveSwapsStore.getState().promote({
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
  });

  return useActiveSwapsStore.getState().byTradeId[payload.tradeId] ?? null;
}

function findPendingTradeForTradeCreated(
  payload: TradeCreatedPayload,
): { pendingTrade: PendingTrade; role: SwapRole } | null {
  for (const pendingTrade of Object.values(
    usePendingTradesStore.getState().byOrderId,
  )) {
    const pendingPubkey = getPendingPubkeyForTrade(payload.tradeId);
    const role = pendingPubkey?.pubkey.toLowerCase() === payload.sellerPubkey.toLowerCase()
      ? "seller"
      : pendingPubkey?.pubkey.toLowerCase() === payload.buyerPubkey.toLowerCase()
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

async function submitPendingPubkeyFromRecovery(
  pendingTrade: PendingTrade,
  tradeId: string,
  deadline: string,
): Promise<void> {
  const store = usePendingPubkeySubmissionsStore.getState();
  let entry = store.byTradeId[tradeId];
  if (!entry) {
    const key = generateEphemeralKeyPair();
    entry = {
      tradeId,
      orderId: pendingTrade.orderId,
      marketId: pendingTrade.marketId,
      pubkey: key.pubkey,
      privkey: key.privkey,
      deadline,
      submitted: false,
    };
    store.addPendingPubkey(entry);
  }
  if (entry.submitted) return;

  await submitEphemeralPubkey(
    tradeId,
    entry.pubkey,
    conditionIdFromMarketId(pendingTrade.marketId),
  );
  usePendingPubkeySubmissionsStore.getState().markSubmitted(tradeId);
}

function conditionIdFromMarketId(marketId: string): string {
  const index = marketId.lastIndexOf("-");
  return index > 0 ? marketId.substring(0, index) : marketId;
}

function tradeCreatedMatchesPendingOrderPath(
  pendingTrade: PendingTrade,
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

  if (
    payload.marketId &&
    pendingTrade.marketId === payload.marketId
  ) {
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
  mintUrl: string,
): Promise<void> {
  if (!claimStep(tradeId, "seller-open")) return;
  try {
    const swap = useActiveSwapsStore.getState().byTradeId[tradeId];
    if (!swap || swap.role !== "seller") return;
    useActiveSwapsStore.getState().setStep(tradeId, "driving");
    const ctx = buildSwapContext(swap, mintUrl);
    if (!ctx) return;
    const mintSplit = mintSellerSplit(swap, ctx);
    const out = mintSplit
      ? await prepareMintSellerOpening(swap, ctx, mintUrl, mintSplit)
      : await prepareDirectSellerOpening(swap, ctx, mintUrl);
    useActiveSwapsStore
      .getState()
      .setSellerState(tradeId, { adaptorPoint: out.adaptorPoint });
    await sendSwapMessage(
      tradeId,
      TRADE_MESSAGE_TYPES.adaptorPoint,
      out.adaptorPointCipher,
    );
    await sendSwapMessage(
      tradeId,
      TRADE_MESSAGE_TYPES.lockedProofsSeller,
      out.lockedProofsCipher,
    );
  } catch (err) {
    failSwap(tradeId, err);
  } finally {
    releaseStep(tradeId, "seller-open");
  }
}

type SellerOpening = Awaited<ReturnType<typeof sellerPrepareSwap>>;

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
): Promise<SellerOpening> {
  const operationId = proofOperationId(
    swap.tradeId,
    "seller-complementary-lock",
  );
  const existingOperation = await getProofOperation(operationId);
  const proofs =
    existingOperation?.kind === "conditional-keyset-swap"
      ? existingOperation.inputs
      : await loadProofsForLock(
          mintUrl,
          swap.outcomeFaceAmountSubunits ?? swap.outcomeFaceAmountSats ?? undefined,
          swap.marketId,
          swap.baseAsset,
        );
  const amountSats =
    swap.outcomeFaceAmountSubunits ??
    swap.outcomeFaceAmountSats ??
    proofs.reduce((sum, proof) => sum + amountToNumber(proof.amount), 0);
  const outcome = outcomeMetadataForMarket(swap.marketId);
  if (!outcome) throw new Error(`Invalid market id ${swap.marketId}`);
  const locked = await sellerLockOutcomeProofs(ctx, proofs, amountSats, {
    operationId,
    proofOperationStore,
  });
  await persistConditionalLockChange({
    spentProofs: proofs,
    changeProofs: locked.changeProofs,
    mintUrl,
    conditionId: outcome.conditionId,
    baseAsset: swap.baseAsset,
  });
  return sellerPreparePrelockedSwap(ctx, locked.lockedProofs);
}

async function prepareMintSellerOpening(
  swap: ActiveSwap,
  ctx: SwapCtx,
  mintUrl: string,
  split: MintSellerSplit,
): Promise<SellerOpening> {
  const amountSats = swap.outcomeFaceAmountSubunits ?? swap.outcomeFaceAmountSats;
  if (
    amountSats === null ||
    !Number.isSafeInteger(amountSats) ||
    amountSats <= 0
  ) {
    throw new Error("Mint swap is missing a positive outcome face amount");
  }

  const operationId = proofOperationId(swap.tradeId, "seller-mint-ctf-split");
  const selectedOutcomeGroups = await selectOutcomeProofGroups(
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
    });
    await persistConditionalLockChange({
      spentProofs: locked.spentProofs,
      changeProofs: locked.changeProofs,
      mintUrl,
      conditionId: split.conditionId,
      baseAsset: swap.baseAsset,
    });
    return sellerPreparePrelockedSwap(ctx, locked.lockedProofs);
  }

  const splitOutputAmountSats = await resolveRootDirectLockOutputAmountSats({
    mintUrl,
    baseAsset: swap.baseAsset,
    conditionId: split.conditionId,
    amountSats,
    lockOutcomeSetId: split.lockOutcomeSetId,
    keepOutcomeSetId: split.keepOutcomeSetId,
  });
  const existingOperation = await getProofOperation(operationId);
  const collateralProofs = existingOperation
    ? existingOperation.inputs
    : await prepareRegularCollateralForCtfSplit({
        mintUrl,
        available: await getUnitProofs(mintUrl, { unit: defaultCollateralUnit(swap.baseAsset) }),
        faceAmountSats: splitOutputAmountSats,
        baseAsset: swap.baseAsset,
        reservationId: `trade-collateral:${swap.tradeId}`,
        operationId: proofOperationId(swap.tradeId, "seller-regular-ctf-input"),
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
    proofOperationStore: ctfProofOperationStore,
  });

  await replaceProofs(
    splitResult.spentSatProofs.map((proof) => proof.secret),
    await storedConditionalProofsFromMintMetadata({
      mintUrl,
      proofs: splitResult.keepCollections.flatMap(
        (collection) => splitResult.proofsByCollection[collection] ?? [],
      ),
      expectedConditionId: split.conditionId,
      baseAsset: swap.baseAsset,
    }),
  );

  return sellerPreparePrelockedSwap(ctx, splitResult.lockedProofs);
}

async function selectOutcomeProofs(
  mintUrl: string,
  conditionId: string,
  outcomeSetId: string,
  amountSats: number,
  baseAsset?: string | null,
): Promise<StoredProof[] | null> {
  const available = await getOutcomeProofs(mintUrl, conditionId, outcomeSetId, {
    baseAsset,
  });
  return takeProofsForLock(
    available,
    amountSats,
    await inputFeePpkByKeysetForProofs(mintUrl, available),
  );
}

async function selectOutcomeProofGroups(
  mintUrl: string,
  conditionId: string,
  outcomeSetId: string,
  amountSats: number,
  baseAsset?: string | null,
): Promise<SelectedOutcomeProofGroup[] | null> {
  const exact = await selectOutcomeProofs(
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
          proofOperationStore,
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
          swap: input.swap,
          mintUrl: input.mintUrl,
          conditionId: input.conditionId,
          collectionByKeyset,
          spentProofs: combinedSpentProofs,
          lockedProofs: combinedLockedProofs,
          changeProofs: combinedChangeProofs,
          refundLocktime:
            partial?.failure.refundLocktime ?? input.ctx.sellerLocktime,
          affectedKeysets:
            partial?.failure.affectedKeysets.length
              ? partial.failure.affectedKeysets
              : uniqueProofKeysets(combinedLockedProofs),
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

function handleSwapMessage(
  msg: SwapMessage,
  sendSwapMessage: SendSwapMessageFn,
  mintUrl: string,
): void {
  const swap = useActiveSwapsStore.getState().byTradeId[msg.tradeId];
  if (!swap) return;
  const decision = decideSwapMessage({
    role: swap.role,
    messages: swap.messages,
    messageType: msg.messageType,
    ciphertext: msg.ciphertext,
  });
  if (!decision.messageKey) return;
  useActiveSwapsStore
    .getState()
    .recordMessage(msg.tradeId, decision.messageKey, msg.ciphertext);

  if (decision.action === "settlement-claim") {
    void runSettlementClaim(msg.tradeId, sendSwapMessage);
  }
  const latest = useActiveSwapsStore.getState().byTradeId[msg.tradeId];
  const shouldDriveBuyerResponse =
    decision.action === "buyer-respond" ||
    (latest?.role === "buyer" &&
      Boolean(latest.messages.adaptorPoint) &&
      Boolean(latest.messages.lockedProofsSeller) &&
      !latest.messages.lockedProofsBuyer);
  if (shouldDriveBuyerResponse) {
    void runBuyerRespond(msg.tradeId, sendSwapMessage, mintUrl);
  }
}

// ---------------------------------------------------------------------------
// Buyer — Step 6
// ---------------------------------------------------------------------------

async function runBuyerRespond(
  tradeId: string,
  sendSwapMessage: SendSwapMessageFn,
  mintUrl: string,
): Promise<void> {
  if (!claimStep(tradeId, "buyer-respond")) return;
  try {
    const swap = useActiveSwapsStore.getState().byTradeId[tradeId];
    if (!swap || swap.role !== "buyer") return;
    if (
      swap.step === "awaiting-confirmation" ||
      swap.step === "completed" ||
      swap.step === "Failed"
    ) {
      return;
    }
    if (!swap.messages.adaptorPoint || !swap.messages.lockedProofsSeller)
      return;
    const replayCipher =
      swap.messages.lockedProofsBuyer ?? swap.buyerState?.lockedProofsCipher;
    if (replayCipher && swap.buyerState) {
      await sendSwapMessage(
        tradeId,
        TRADE_MESSAGE_TYPES.lockedProofsBuyer,
        replayCipher,
      );
      return;
    }
    if (swap.buyerState) {
      throw new Error("Buyer response already prepared but ciphertext is missing");
    }
    const amountSats = swap.quotePaymentSubunits ?? swap.quotePaymentSats;
    if (
      typeof amountSats !== "number" ||
      !Number.isSafeInteger(amountSats) ||
      amountSats <= 0
    ) {
      throw new Error("Swap is missing a positive quote payment amount");
    }
    useActiveSwapsStore.getState().setStep(tradeId, "driving");
    const ctx = buildSwapContext(swap, mintUrl);
    if (!ctx) return;
    const operationId = proofOperationId(tradeId, "buyer-lock");
    const existingOperation = await getProofOperation(operationId);
    const proofs = existingOperation?.kind === "swap-lock"
      ? existingOperation.inputs
      : await loadProofsForLock(mintUrl, amountSats, undefined, swap.baseAsset);
    const out = await buyerPrepareSwap(
      ctx,
      swap.messages.adaptorPoint,
      swap.messages.lockedProofsSeller,
      proofs,
      amountSats,
      {
        operationId,
        proofOperationStore,
      },
    );
    await persistLockChange(proofs, out.changeProofs, mintUrl);
    useActiveSwapsStore
      .getState()
      .recordMessage(tradeId, "lockedProofsBuyer", out.lockedProofsCipher);
    useActiveSwapsStore.getState().setBuyerState(tradeId, {
      ownPreSigsHex: out.preSigsHex,
      lockedSatProofs: out.lockedProofs,
      lockedProofsCipher: out.lockedProofsCipher,
      sellerPreSigsHex: out.sellerPreSigsHex,
    });
    await sendSwapMessage(
      tradeId,
      TRADE_MESSAGE_TYPES.lockedProofsBuyer,
      out.lockedProofsCipher,
    );
  } catch (err) {
    failSwap(tradeId, err);
  } finally {
    releaseStep(tradeId, "buyer-respond");
  }
}

// ---------------------------------------------------------------------------
// TradeStateChanged → claim + settlement-complete
// ---------------------------------------------------------------------------

function handleTradeStateChanged(
  tradeId: string,
  newState: string,
  sendSwapMessage: SendSwapMessageFn,
): void {
  const action = decideTradeStateChanged(newState);
  if (action === "finish-confirmed") return finishSwap(tradeId, "success");
  if (action === "finish-failed" || action === "finish-refunded") {
    const swap = useActiveSwapsStore.getState().byTradeId[tradeId];
    if (swap?.step === "completed") return finishSwap(tradeId, "Failed");
    if (swap && !swap.error) {
      useActiveSwapsStore
        .getState()
        .setStep(
          tradeId,
          "Failed",
          "settlement timed out before both parties confirmed",
        );
    }
    return finishSwap(tradeId, "Failed");
  }
  if (action === "settlement-claim") {
    void runSettlementClaim(tradeId, sendSwapMessage);
  }
}

async function runSettlementClaim(
  tradeId: string,
  sendSwapMessage: SendSwapMessageFn,
): Promise<void> {
  if (!claimStep(tradeId, "settle")) return;
  try {
    const swap = useActiveSwapsStore.getState().byTradeId[tradeId];
    if (!swap || !swap.role) return;
    if (
      swap.step === "awaiting-confirmation" ||
      swap.step === "completed" ||
      swap.step === "Failed"
    )
      return;
    if (swap.role === "seller" && !swap.messages.lockedProofsBuyer) return;
    const mintUrl = useWalletStore.getState().activeMintUrl;
    const ctx = buildSwapContext(swap, mintUrl);
    if (!ctx) return;
    const fresh =
      swap.role === "seller"
        ? await runSellerClaim(swap, ctx)
        : await runBuyerClaim(swap, ctx);
    if (swap.role === "buyer") {
      const market = splitMarketId(swap.marketId);
      if (!market) throw new Error(`Invalid market id ${swap.marketId}`);
      await persistFreshConditionalProofs(
        fresh,
        mintUrl,
        market.conditionId,
        swap.baseAsset,
      );
    } else {
      await persistFreshProofs(fresh, mintUrl, null, swap.baseAsset);
    }
    useActiveSwapsStore.getState().setStep(tradeId, "awaiting-confirmation");
    await sendSwapMessage(tradeId, TRADE_MESSAGE_TYPES.settlementComplete, "");
  } catch (err) {
    failSwap(tradeId, err);
  } finally {
    releaseStep(tradeId, "settle");
  }
}

async function runSellerClaim(
  swap: ActiveSwap,
  ctx: SwapCtx,
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
      proofOperationStore,
    },
  );
}

async function runBuyerClaim(swap: ActiveSwap, ctx: SwapCtx): Promise<Proof[]> {
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
      proofOperationStore,
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
  targetSats?: number,
  sellerMarketId?: string,
  baseAsset?: string | null,
): Promise<Proof[]> {
  const outcome = sellerMarketId
    ? outcomeMetadataForMarket(sellerMarketId)
    : null;
  const proofs = outcome
    ? await getOutcomeProofs(
        mintUrl,
        outcome.conditionId,
        outcome.outcomeCollection,
        { baseAsset },
      )
    : await getUnitProofs(mintUrl, { unit: defaultCollateralUnit(baseAsset) });
  if (proofs.length === 0) {
    throw new Error(
      outcome
        ? `No ${outcome.outcomeCollection} outcome proofs available for atomic swap`
        : "No proofs available for atomic swap — wallet is empty",
    );
  }
  if (
    targetSats === undefined ||
    !Number.isFinite(targetSats) ||
    targetSats <= 0
  ) {
    return proofs;
  }
  const selected = takeProofsForLock(
    proofs,
    targetSats,
    await inputFeePpkByKeysetForProofs(mintUrl, proofs),
  );
  if (!selected) {
    throw new Error(
      `Insufficient proofs for atomic swap — need ${targetSats} sats`,
    );
  }
  return selected;
}

async function persistLockChange(
  spentProofs: Proof[],
  changeProofs: Proof[],
  mintUrl: string,
  metadata?: OutcomeProofMetadata | null,
): Promise<void> {
  await replaceProofs(
    spentProofs.map((proof) => proof.secret),
    changeProofs.map((proof) => ({
      ...proof,
      ...(metadata ?? {}),
      mintUrl,
    })),
  );
}

async function persistFreshProofs(
  proofs: Proof[],
  mintUrl: string,
  metadata?: OutcomeProofMetadata | null,
  baseAsset?: string | null,
): Promise<void> {
  if (proofs.length === 0) return;
  const normalizedBaseAsset = normalizeMarketBaseAsset(baseAsset);
  const fresh: StoredProof[] = proofs.map((p) => ({
    ...p,
    ...(metadata ?? {}),
    mintUrl,
    baseAsset: normalizedBaseAsset,
    unit: defaultCollateralUnit(normalizedBaseAsset),
  }));
  await addProofs(fresh);
}

async function persistConditionalLockChange(input: {
  spentProofs: Proof[];
  changeProofs: Proof[];
  mintUrl: string;
  conditionId: string;
  reservedBy?: string;
  baseAsset?: string | null;
}): Promise<void> {
  await replaceProofs(
    input.spentProofs.map((proof) => proof.secret),
    await storedConditionalProofsFromMintMetadata({
      mintUrl: input.mintUrl,
      proofs: input.changeProofs,
      expectedConditionId: input.conditionId,
      reservedBy: input.reservedBy,
      baseAsset: input.baseAsset,
    }),
  );
}

async function persistFreshConditionalProofs(
  proofs: Proof[],
  mintUrl: string,
  conditionId: string,
  baseAsset?: string | null,
): Promise<void> {
  if (proofs.length === 0) return;
  await addProofs(
    await storedConditionalProofsFromMintMetadata({
      mintUrl,
      proofs,
      expectedConditionId: conditionId,
      baseAsset,
      unit: defaultCollateralUnit(baseAsset),
    }),
  );
}

export async function persistPartialLockFromError(input: {
  err: unknown;
  swap: ActiveSwap;
  mintUrl: string;
  conditionId: string;
  collectionByKeyset: Map<string, string>;
}): Promise<void> {
  const partial = partialLockFromError(input.err);
  if (!partial) return;
  await replaceProofs(
    partial.spentProofs.map((proof) => proof.secret),
    [
      ...(await storedConditionalProofsFromMintMetadata({
        mintUrl: input.mintUrl,
        proofs: partial.lockedProofs,
        expectedConditionId: input.conditionId,
        reservedBy: input.swap.tradeId,
        baseAsset: input.swap.baseAsset,
      })),
      ...(await storedConditionalProofsFromMintMetadata({
        mintUrl: input.mintUrl,
        proofs: partial.changeProofs,
        expectedConditionId: input.conditionId,
        baseAsset: input.swap.baseAsset,
      })),
    ],
  );
  usePartialLockFailuresStore.getState().upsert({
    kind: "PartialLockHeld",
    tradeId: input.swap.tradeId,
    orderId: input.swap.orderId,
    mintUrl: input.mintUrl,
    refundLocktime: partial.failure.refundLocktime,
    affectedKeysets: partial.failure.affectedKeysets,
    detail: partial.failure.detail,
    outcomeByKeyset: await outcomeMetadataByKeyset(
      input.mintUrl,
      input.conditionId,
      partial.failure.affectedKeysets,
      [...partial.lockedProofs, ...partial.changeProofs],
    ),
    lockedProofs: partial.lockedProofs,
    createdAt: Date.now(),
  });
}

async function persistPartialLockParts(input: {
  swap: ActiveSwap;
  mintUrl: string;
  conditionId: string;
  collectionByKeyset: Map<string, string>;
  spentProofs: Proof[];
  lockedProofs: Proof[];
  changeProofs: Proof[];
  refundLocktime: number;
  affectedKeysets: string[];
  detail: string;
}): Promise<void> {
  const affectedKeysets =
    input.affectedKeysets.length > 0
      ? input.affectedKeysets
      : uniqueProofKeysets(input.lockedProofs);
  await replaceProofs(
    input.spentProofs.map((proof) => proof.secret),
    [
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
    ],
  );

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

  usePartialLockFailuresStore.getState().upsert({
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
  });
}

async function outcomeMetadataByKeyset(
  mintUrl: string,
  conditionId: string,
  affectedKeysets: string[],
  proofs: Proof[],
): Promise<PartialLockHeldRecord["outcomeByKeyset"]> {
  const byKeyset: Record<string, OutcomeMetadata> = {};
  const proofByKeyset = new Map(
    proofs
      .filter((proof) => typeof proof.id === "string")
      .map((proof) => [proof.id as string, proof]),
  );
  for (const keysetId of affectedKeysets) {
    const proof = proofByKeyset.get(keysetId);
    if (!proof) throw new Error(`No locked proof for keyset ${keysetId}`);
    byKeyset[keysetId] = await resolveOutcomeMetadataForProof(
      mintUrl,
      conditionId,
      proof,
    );
  }
  return byKeyset;
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

async function resolveOutcomeMetadataForProof(
  mintUrl: string,
  conditionId: string,
  proof: Proof,
): Promise<OutcomeMetadata> {
  const metadata = await resolveConditionalProofMetadata(
    mintUrl,
    proof,
    conditionId,
  );
  return {
    conditionId: metadata.conditionId,
    outcomeCollection: metadata.outcomeCollection,
    marketId: metadata.marketId,
  };
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

function finishSwap(tradeId: string, outcome: "success" | "Failed"): void {
  const swap = useActiveSwapsStore.getState().byTradeId[tradeId];
  if (!swap) return;
  if (outcome === "Failed" && swap.step === "completed") return;
  const shouldNotify =
    outcome === "success" || isLocalTradeParticipant(swap, tradeId);
  emitTradeTerminal({
    tradeId,
    marketId: swap.marketId,
    state: outcome === "success" ? "Confirmed" : "Failed",
  });
  useActiveSwapsStore
    .getState()
    .setStep(tradeId, outcome === "success" ? "completed" : "Failed");
  useActiveSwapsStore.getState().clearProtocolState(tradeId);
  if (shouldNotify) {
    const toast = useToastStore.getState().addToast;
    toast({
      type: outcome === "success" ? "success" : "error",
      message:
        outcome === "success"
          ? `Trade complete: ${swap.marketId}`
          : `Trade failed: ${swap.error ?? "unknown error"}`,
    });
  }
  // Keep the entry around briefly so any UI subscriber gets a final
  // snapshot before the row vanishes.
  setTimeout(() => useActiveSwapsStore.getState().remove(tradeId), 5_000);
}

function isLocalTradeParticipant(swap: ActiveSwap, tradeId: string): boolean {
  if (swap.tradeId !== tradeId) return false;
  if (!swap.role || !swap.counterpartyPubkey) return false;
  return Boolean(swap.ephemeralPubkeyHex);
}

function failSwap(tradeId: string, err: unknown): void {
  const swap = useActiveSwapsStore.getState().byTradeId[tradeId];
  if (!swap || swap.step === "completed") return;
  const message = err instanceof Error ? err.message : String(err);
  useActiveSwapsStore.getState().setStep(tradeId, "Failed", message);
  finishSwap(tradeId, "Failed");
}

function claimStep(tradeId: string, key: SwapWorkKey): boolean {
  return useActiveSwapsStore.getState().claimStep(tradeId, key);
}

function releaseStep(tradeId: string, key: SwapWorkKey): void {
  useActiveSwapsStore.getState().releaseStep(tradeId, key);
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

function buildSwapContext(swap: ActiveSwap, mintUrl: string): SwapCtx | null {
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
    mintUrl,
  };
}

type SendSwapMessageFn = (
  tradeId: string,
  type: TradeMessageType,
  ciphertext: string,
) => Promise<void>;
