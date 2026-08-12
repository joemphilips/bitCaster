import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type {
  OrderLifecycleStatus,
  SettlementGroupStatus,
} from "@bitcaster/client-sdk/engineClient";
import { recoverBrowserCtfRangeOrder } from "@/lib/browserCtfRangeOrderSubmission";
import { browserWalletIdFromMnemonic } from "@/lib/browserWalletProfile";
import { publishPortfolioInvalidation } from "@/lib/portfolioInvalidation";
import {
  buildOrderLifecycleNotifications,
  buildOrderStatusNotifications,
  fetchOrderStatus,
} from "@/lib/orderStatus";
import { useOrderHub } from "@/hooks/useOrderHub";
import { usePendingTradesStore } from "@/stores/pendingTrades";
import { useNotificationsStore } from "@/stores/notifications";
import { useToastStore } from "@/stores/toast";

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
    onOrderLifecycleChanged: (delta) => {
      const order = usePendingTradesStore.getState().byOrderId[delta.orderId];
      if (!order) return;
      const notifications = buildOrderLifecycleNotifications(
        delta.status,
        delta.remainingAmountSubunits,
        order,
      );
      for (const notification of notifications) {
        useNotificationsStore.getState().add(notification);
      }
      if (delta.status === "filled" && notifications.length > 0) {
        useToastStore.getState().addToast({
          type: "success",
          message: `All your amount for order ${shortOrderId(delta.orderId)} has been filled.`,
        });
      }
      if (isDiscardableTerminalStatus(delta.status)) {
        usePendingTradesStore.getState().remove(delta.orderId);
      }
    },
    onSettlementGroupStateChanged: (delta) => {
      if (requiresStatusReconciliation(delta.settlementGroup.status)) {
        void reconcileOrderStatus(delta.orderId);
      }
      if (isConfirmed(delta.settlementGroup.status)) {
        recoverConfirmedOrder(
          delta.orderId,
          recoveryInputRef,
          recoveringOrderIdsRef,
          recoveryRetryTimersRef,
        );
        queuePortfolioInvalidation(recoveryInputRef, invalidationQueuedRef);
      }
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

function isDiscardableTerminalStatus(status: OrderLifecycleStatus): boolean {
  switch (status) {
    case "cancelled":
    case "expired":
    case "evicted_capacity":
    case "rejected_capacity":
    case "failed":
      return true;
    case "resting":
    case "matched":
    case "partially_filled":
    case "awaiting_authorization":
    case "filled":
      return false;
    default:
      return assertNever(status);
  }
}

function requiresStatusReconciliation(status: SettlementGroupStatus): boolean {
  switch (status) {
    case "Confirmed":
    case "DefinitivelyRejected":
    case "Refundable":
    case "ExpiredBeforeSubmission":
      return true;
    case "Prepared":
    case "SubmissionPending":
    case "Reconciling":
      return false;
    default:
      return assertNever(status);
  }
}

async function reconcileOrderStatus(orderId: string): Promise<void> {
  const trade = usePendingTradesStore.getState().byOrderId[orderId];
  if (!trade) return;
  try {
    const status = await fetchOrderStatus(trade.marketId, orderId);
    if (!status) return;
    for (const notification of buildOrderStatusNotifications(status, trade)) {
      useNotificationsStore.getState().add(notification);
    }
    if (isDiscardableTerminalStatus(status.status)) {
      usePendingTradesStore.getState().remove(orderId);
    }
  } catch {
    // The next authoritative callback or application reload retries the read.
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled order lifecycle status: ${value}`);
}

function shortOrderId(orderId: string): string {
  return orderId.length > 12 ? `${orderId.slice(0, 8)}...` : orderId;
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
