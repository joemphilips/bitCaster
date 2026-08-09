import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { SettlementGroupStatus } from "@bitcaster/client-sdk/engineClient";
import { recoverBrowserCtfRangeOrder } from "@/lib/browserCtfRangeOrderSubmission";
import { browserWalletIdFromMnemonic } from "@/lib/browserWalletProfile";
import { publishPortfolioInvalidation } from "@/lib/portfolioInvalidation";
import { useOrderHub } from "@/hooks/useOrderHub";
import { usePendingTradesStore } from "@/stores/pendingTrades";

const JOIN_RETRY_MS = 1_000;
const RECOVERY_RETRY_MS = 15_000;

export interface OrderSettlementRecoveryInput {
  readonly mnemonic: string | null;
  readonly mintUrls: readonly string[];
}

function isConfirmed(status: SettlementGroupStatus): boolean {
  return status === "Confirmed";
}

export function useOrderSettlementLifecycle(
  canAuthenticateOrderHub: boolean,
  recoveryInput: OrderSettlementRecoveryInput,
): void {
  const pendingOrdersById = usePendingTradesStore((state) => state.byOrderId);
  const pendingOrders = useMemo(() => Object.values(pendingOrdersById), [pendingOrdersById]);
  const recoveryInputRef = useRef(recoveryInput);
  const recoveringOrderIdsRef = useRef(new Set<string>());
  const recoveryRetryTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const invalidationQueuedRef = useRef(false);
  const joinRetryTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [connectionRevision, setConnectionRevision] = useState(0);
  recoveryInputRef.current = recoveryInput;

  const enabled = canAuthenticateOrderHub && pendingOrders.length > 0;
  const { joinOrder } = useOrderHub(enabled, {
    onReconnected: () => setConnectionRevision((revision) => revision + 1),
    onSettlementGroupStateChanged: (delta) => {
      if (!isConfirmed(delta.settlementGroup.status)) return;
      recoverConfirmedOrder(
        delta.orderId,
        recoveryInputRef,
        recoveringOrderIdsRef,
        recoveryRetryTimersRef,
      );
      queuePortfolioInvalidation(recoveryInputRef, invalidationQueuedRef);
    },
  });

  useEffect(() => {
    const joinedOrderKeys = new Set<string>();
    let cancelled = false;
    const join = (marketId: string, orderId: string) => {
      const key = `${marketId}:${orderId}`;
      if (cancelled || joinedOrderKeys.has(key) || joinRetryTimersRef.current.has(key)) return;
      joinedOrderKeys.add(key);
      void joinOrder(marketId, orderId).catch(() => {
        joinedOrderKeys.delete(key);
        if (cancelled) return;
        const timer = setTimeout(() => {
          joinRetryTimersRef.current.delete(key);
          join(marketId, orderId);
        }, JOIN_RETRY_MS);
        joinRetryTimersRef.current.set(key, timer);
      });
    };

    for (const order of pendingOrders) join(order.marketId, order.orderId);

    return () => {
      cancelled = true;
      for (const timer of joinRetryTimersRef.current.values()) clearTimeout(timer);
      joinRetryTimersRef.current.clear();
    };
  }, [connectionRevision, joinOrder, pendingOrders]);

  useEffect(
    () => () => {
      for (const timer of recoveryRetryTimersRef.current.values()) clearTimeout(timer);
      recoveryRetryTimersRef.current.clear();
    },
    [],
  );
}

function recoverConfirmedOrder(
  orderId: string,
  recoveryInputRef: RefObject<OrderSettlementRecoveryInput>,
  recoveringOrderIdsRef: RefObject<Set<string>>,
  recoveryRetryTimersRef: RefObject<Map<string, ReturnType<typeof setTimeout>>>,
): void {
  const order = usePendingTradesStore.getState().byOrderId[orderId];
  const recoveryInput = recoveryInputRef.current;
  if (!order?.clientOrderId || !recoveryInput.mnemonic || recoveryInput.mintUrls.length === 0)
    return;
  if (recoveringOrderIdsRef.current.has(orderId)) return;

  const priorRetry = recoveryRetryTimersRef.current.get(orderId);
  if (priorRetry !== undefined) {
    clearTimeout(priorRetry);
    recoveryRetryTimersRef.current.delete(orderId);
  }

  recoveringOrderIdsRef.current.add(orderId);
  let retryRequired = false;
  void recoverBrowserCtfRangeOrder({
    mnemonic: recoveryInput.mnemonic,
    mintUrls: recoveryInput.mintUrls,
    clientOrderId: order.clientOrderId,
  })
    .then((result) => {
      if (result.pending.length === 0) usePendingTradesStore.getState().remove(orderId);
      else retryRequired = true;
    })
    .catch(() => {
      retryRequired = true;
    })
    .finally(() => {
      recoveringOrderIdsRef.current.delete(orderId);
      if (!retryRequired || !usePendingTradesStore.getState().byOrderId[orderId]) return;
      const timer = setTimeout(() => {
        recoveryRetryTimersRef.current.delete(orderId);
        recoverConfirmedOrder(
          orderId,
          recoveryInputRef,
          recoveringOrderIdsRef,
          recoveryRetryTimersRef,
        );
      }, RECOVERY_RETRY_MS);
      recoveryRetryTimersRef.current.set(orderId, timer);
    });
}

function queuePortfolioInvalidation(
  recoveryInputRef: RefObject<OrderSettlementRecoveryInput>,
  invalidationQueuedRef: RefObject<boolean>,
): void {
  if (invalidationQueuedRef.current) return;
  const mnemonic = recoveryInputRef.current.mnemonic;
  const walletId = mnemonic ? browserWalletIdFromMnemonic(mnemonic) : null;
  if (walletId === null) return;

  invalidationQueuedRef.current = true;
  queueMicrotask(() => {
    invalidationQueuedRef.current = false;
    publishPortfolioInvalidation({ walletId });
  });
}
