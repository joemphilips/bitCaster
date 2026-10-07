import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type {
  OrderLifecycleStatus,
  SettlementGroupStatus,
} from "@bitcaster/client-sdk/engineClient";
import { recoverBrowserCtfRangeOrder } from "@/lib/browserCtfRangeOrderSubmission";
import { browserWalletIdFromMnemonic, isActiveBrowserWalletId } from "@/lib/browserWalletProfile";
import { publishPortfolioInvalidation } from "@/lib/portfolioInvalidation";
import { publishSettlementProgressHint } from "@/lib/settlementProgressHints";
import {
  buildOrderLifecycleNotifications,
  buildOrderStatusNotifications,
  fetchOrderStatus,
  mapConfirmedTradeActivities,
  type OrderStatusResponse,
} from "@/lib/orderStatus";
import { useOrderHub } from "@/hooks/useOrderHub";
import { useActivityLogStore } from "@/stores/activity-log";
import { usePendingTradesStore, type PendingTrade } from "@/stores/pendingTrades";
import { useNotificationsStore } from "@/stores/notifications";
import { useToastStore } from "@/stores/toast";
import { useWalletStore } from "@/stores/wallet";

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
  const activeWalletId = useMemo(
    () =>
      recoveryInput.mnemonic === null ? null : browserWalletIdFromMnemonic(recoveryInput.mnemonic),
    [recoveryInput.mnemonic],
  );
  const pendingOrders = useMemo(
    () =>
      Object.values(pendingOrdersById).filter(
        (order) => activeWalletId !== null && order.walletId === activeWalletId,
      ),
    [activeWalletId, pendingOrdersById],
  );
  const unscopedPendingOrders = useMemo(
    () => Object.values(pendingOrdersById).filter((order) => order.walletId === undefined),
    [pendingOrdersById],
  );
  const recoveryInputRef = useRef(recoveryInput);
  const recoveringOrderIdsRef = useRef(new Set<string>());
  const recoveryRetryTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const invalidationQueuedRef = useRef(new Set<string>());
  const joinRetryTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const legacyReconciliationRunningRef = useRef(false);
  const legacyReadRevisionByTradeRef = useRef(new WeakMap<PendingTrade, number>());
  const orderStatusQueueRef = useRef(new Map<string, { walletId: string; trade: PendingTrade }>());
  const orderStatusQueueRunningRef = useRef(false);
  const orderStatusReadRevisionByTradeRef = useRef(new WeakMap<PendingTrade, number>());
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [legacyReconciliationRevision, setLegacyReconciliationRevision] = useState(0);
  recoveryInputRef.current = recoveryInput;

  const drainOrderStatusQueue = () => {
    if (orderStatusQueueRunningRef.current) return;
    orderStatusQueueRunningRef.current = true;
    void (async () => {
      while (true) {
        const next = orderStatusQueueRef.current.values().next().value;
        if (!next) return;
        const key = `${next.walletId}:${next.trade.orderId}`;
        orderStatusQueueRef.current.delete(key);
        const response = await reconcileOrderStatus(next.trade, next.walletId);
        if (response && hasCommittedFillForOrder(response, next.trade.orderId)) {
          recoverConfirmedOrder(
            next.trade.orderId,
            next.walletId,
            recoveryInputRef,
            recoveringOrderIdsRef,
            recoveryRetryTimersRef,
          );
        }
      }
    })()
      .catch(() => {})
      .finally(() => {
        orderStatusQueueRunningRef.current = false;
        if (orderStatusQueueRef.current.size > 0) drainOrderStatusQueue();
      });
  };

  const enqueueOrderStatusRead = (trade: PendingTrade, walletId: string): boolean => {
    if (
      !canAuthenticateOrderHub ||
      trade.walletId !== walletId ||
      currentActiveWalletId() !== walletId
    ) {
      return false;
    }
    const key = `${walletId}:${trade.orderId}`;
    orderStatusQueueRef.current.set(key, { walletId, trade });
    drainOrderStatusQueue();
    return true;
  };

  const enabled =
    canAuthenticateOrderHub && (pendingOrders.length > 0 || unscopedPendingOrders.length > 0);
  const { joinOrder } = useOrderHub(enabled, {
    onReconnected: () => {
      setConnectionRevision((revision) => revision + 1);
      publishSettlementProgressHint(null);
    },
    onOrderLifecycleChanged: (delta) => {
      const order = usePendingTradesStore.getState().byOrderId[delta.orderId];
      if (
        !order ||
        activeWalletId === null ||
        order.walletId !== activeWalletId ||
        currentActiveWalletId() !== activeWalletId
      ) {
        return;
      }
      enqueueOrderStatusRead(order, activeWalletId);
      publishSettlementProgressHint({ orderId: delta.orderId, marketId: delta.marketId });
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
    },
    onSettlementGroupStateChanged: (delta) => {
      const order = usePendingTradesStore.getState().byOrderId[delta.orderId];
      if (
        !order ||
        activeWalletId === null ||
        order.walletId !== activeWalletId ||
        currentActiveWalletId() !== activeWalletId
      ) {
        return;
      }
      publishSettlementProgressHint({ orderId: delta.orderId, marketId: delta.marketId });
      if (requiresStatusReconciliation(delta.settlementGroup.status)) {
        enqueueOrderStatusRead(order, activeWalletId);
      }
      if (isConfirmed(delta.settlementGroup.status)) {
        queuePortfolioInvalidation(activeWalletId, invalidationQueuedRef);
      }
    },
  });

  useEffect(() => {
    const joinedOrderKeys = new Set<string>();
    let cancelled = false;
    const join = (walletId: string, marketId: string, orderId: string) => {
      const key = `${walletId}:${marketId}:${orderId}`;
      if (
        cancelled ||
        currentActiveWalletId() !== walletId ||
        joinedOrderKeys.has(key) ||
        joinRetryTimersRef.current.has(key)
      ) {
        return;
      }
      joinedOrderKeys.add(key);
      void joinOrder(marketId, orderId).catch(() => {
        joinedOrderKeys.delete(key);
        if (cancelled || currentActiveWalletId() !== walletId) return;
        const timer = setTimeout(() => {
          joinRetryTimersRef.current.delete(key);
          if (currentActiveWalletId() === walletId) {
            join(walletId, marketId, orderId);
          }
        }, JOIN_RETRY_MS);
        joinRetryTimersRef.current.set(key, timer);
      });
    };

    for (const order of pendingOrders) {
      if (order.walletId) join(order.walletId, order.marketId, order.orderId);
    }

    return () => {
      cancelled = true;
      for (const timer of joinRetryTimersRef.current.values()) clearTimeout(timer);
      joinRetryTimersRef.current.clear();
    };
  }, [connectionRevision, joinOrder, pendingOrders]);

  useEffect(() => {
    orderStatusReadRevisionByTradeRef.current = new WeakMap<PendingTrade, number>();
  }, [activeWalletId]);

  useEffect(() => {
    if (!canAuthenticateOrderHub) return;
    for (const order of pendingOrders) {
      if (order.walletId === undefined) continue;
      if (orderStatusReadRevisionByTradeRef.current.get(order) === connectionRevision) continue;
      if (enqueueOrderStatusRead(order, order.walletId)) {
        orderStatusReadRevisionByTradeRef.current.set(order, connectionRevision);
      }
    }
  }, [activeWalletId, canAuthenticateOrderHub, connectionRevision, pendingOrders]);

  useEffect(() => {
    if (!canAuthenticateOrderHub || legacyReconciliationRunningRef.current) return;
    const candidates = unscopedPendingOrders.filter(
      (order) => legacyReadRevisionByTradeRef.current.get(order) !== connectionRevision,
    );
    if (candidates.length === 0) return;

    for (const order of candidates) {
      legacyReadRevisionByTradeRef.current.set(order, connectionRevision);
    }
    legacyReconciliationRunningRef.current = true;
    void (async () => {
      // Read one order at a time. Legacy stores have no owner key for safe batching.
      for (const order of candidates) await reconcileUnscopedPendingOrder(order);
    })().finally(() => {
      legacyReconciliationRunningRef.current = false;
      setLegacyReconciliationRevision((revision) => revision + 1);
    });
  }, [
    canAuthenticateOrderHub,
    connectionRevision,
    legacyReconciliationRevision,
    unscopedPendingOrders,
  ]);

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
    case "RejectedBeforeSubmission":
      return true;
    case "Prepared":
    case "SubmissionPending":
    case "Reconciling":
      return false;
    default:
      return assertNever(status);
  }
}

async function reconcileOrderStatus(
  trade: PendingTrade,
  walletId: string,
): Promise<OrderStatusResponse | null> {
  if (
    trade.walletId !== walletId ||
    !CANONICAL_WALLET_ID.test(walletId) ||
    currentActiveWalletId() !== walletId
  ) {
    return null;
  }
  try {
    const status = await fetchOrderStatus(trade.marketId, trade.orderId);
    if (!status || status.orderId !== trade.orderId || status.marketId !== trade.marketId) {
      return null;
    }

    // Persist authenticated committed fills under the captured wallet before
    // checking whether that wallet is still active for presentation.
    const activities = mapConfirmedTradeActivities(status, {
      walletId,
      orderId: trade.orderId,
      marketId: trade.marketId,
    });
    for (const activity of activities) {
      useActivityLogStore.getState().upsertConfirmedTrade(activity);
    }

    const latest = usePendingTradesStore.getState().byOrderId[trade.orderId];
    if (
      !latest ||
      latest.walletId !== walletId ||
      latest.marketId !== trade.marketId ||
      currentActiveWalletId() !== walletId
    ) {
      return status;
    }

    for (const notification of buildOrderStatusNotifications(status, latest)) {
      useNotificationsStore.getState().add(notification);
    }
    if (
      isDiscardableTerminalStatus(status.status) &&
      !hasCommittedFillForOrder(status, trade.orderId)
    ) {
      usePendingTradesStore.getState().remove(trade.orderId, walletId);
    }
    return status;
  } catch {
    // The next authoritative callback or application reload retries the read.
    return null;
  }
}

const CANONICAL_WALLET_ID = /^[0-9a-f]{64}$/;

function hasCommittedFillForOrder(status: OrderStatusResponse, orderId: string): boolean {
  return status.fills.some(
    (fill) =>
      fill.status === "Filled" && (fill.takerOrderId === orderId || fill.makerOrderId === orderId),
  );
}

async function reconcileUnscopedPendingOrder(order: PendingTrade): Promise<void> {
  try {
    const status = await fetchOrderStatus(order.marketId, order.orderId);
    if (!isSafelyResolvedUnscopedOrder(order, status)) return;
    if (usePendingTradesStore.getState().byOrderId[order.orderId] !== order) return;
    usePendingTradesStore.getState().removeReconciledUnscoped(order);
  } catch {
    // Keep the legacy order as a switch blocker until an authenticated read succeeds.
  }
}

function isSafelyResolvedUnscopedOrder(
  order: PendingTrade,
  status: OrderStatusResponse | null,
): status is OrderStatusResponse {
  return (
    status !== null &&
    status.orderId === order.orderId &&
    status.marketId === order.marketId &&
    isDiscardableTerminalStatus(status.status) &&
    status.filledAmountSubunits === 0 &&
    status.fills.length === 0 &&
    status.activeSettlementGroup === null
  );
}

function assertNever(value: never): never {
  throw new Error(`Unhandled order lifecycle status: ${value}`);
}

function shortOrderId(orderId: string): string {
  return orderId.length > 12 ? `${orderId.slice(0, 8)}...` : orderId;
}

function recoverConfirmedOrder(
  orderId: string,
  walletId: string,
  recoveryInputRef: RefObject<OrderSettlementRecoveryInput>,
  recoveringOrderIdsRef: RefObject<Set<string>>,
  recoveryRetryTimersRef: RefObject<Map<string, ReturnType<typeof setTimeout>>>,
): void {
  const order = usePendingTradesStore.getState().byOrderId[orderId];
  const recoveryInput = recoveryInputRef.current;
  if (
    !order?.clientOrderId ||
    order.walletId !== walletId ||
    currentWalletId(recoveryInput) !== walletId ||
    currentActiveWalletId() !== walletId ||
    !recoveryInput.mnemonic ||
    recoveryInput.mintUrls.length === 0
  ) {
    return;
  }
  const recoveryKey = `${walletId}:${orderId}`;
  if (recoveringOrderIdsRef.current.has(recoveryKey)) return;

  const priorRetry = recoveryRetryTimersRef.current.get(recoveryKey);
  if (priorRetry !== undefined) {
    clearTimeout(priorRetry);
    recoveryRetryTimersRef.current.delete(recoveryKey);
  }

  recoveringOrderIdsRef.current.add(recoveryKey);
  let retryRequired = false;
  void recoverBrowserCtfRangeOrder({
    mnemonic: recoveryInput.mnemonic,
    mintUrls: recoveryInput.mintUrls,
    clientOrderId: order.clientOrderId,
  })
    .then((result) => {
      const latest = usePendingTradesStore.getState().byOrderId[orderId];
      if (
        latest?.walletId === walletId &&
        currentActiveWalletId() === walletId &&
        result.pending.length === 0
      ) {
        usePendingTradesStore.getState().remove(orderId, walletId);
      } else {
        retryRequired = true;
      }
    })
    .catch(() => {
      retryRequired = true;
    })
    .finally(() => {
      recoveringOrderIdsRef.current.delete(recoveryKey);
      const latest = usePendingTradesStore.getState().byOrderId[orderId];
      if (!retryRequired || latest?.walletId !== walletId || currentActiveWalletId() !== walletId) {
        return;
      }
      const timer = setTimeout(() => {
        recoveryRetryTimersRef.current.delete(recoveryKey);
        recoverConfirmedOrder(
          orderId,
          walletId,
          recoveryInputRef,
          recoveringOrderIdsRef,
          recoveryRetryTimersRef,
        );
      }, RECOVERY_RETRY_MS);
      recoveryRetryTimersRef.current.set(recoveryKey, timer);
    });
}

function queuePortfolioInvalidation(
  walletId: string,
  invalidationQueuedRef: RefObject<Set<string>>,
): void {
  if (invalidationQueuedRef.current.has(walletId)) return;

  invalidationQueuedRef.current.add(walletId);
  queueMicrotask(() => {
    invalidationQueuedRef.current.delete(walletId);
    if (currentActiveWalletId() === walletId) {
      publishPortfolioInvalidation({ walletId });
    }
  });
}

function currentWalletId(input: OrderSettlementRecoveryInput): string | null {
  return input.mnemonic === null ? null : browserWalletIdFromMnemonic(input.mnemonic);
}

function currentActiveWalletId(): string | null {
  const mnemonic = useWalletStore.getState().mnemonic;
  const walletId = browserWalletIdFromMnemonic(mnemonic);
  return walletId !== null && isActiveBrowserWalletId(walletId, mnemonic) ? walletId : null;
}
