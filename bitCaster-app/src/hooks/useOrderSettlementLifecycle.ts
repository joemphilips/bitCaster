import { createDisplayResyncRepair } from "@bitcaster/client-sdk/displayResync";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
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
import i18n from "@/i18n";
import { formatNotificationText } from "@/lib/notificationText";
import { useOrderHub } from "@/hooks/useOrderHub";
import { useActivityLogStore } from "@/stores/activity-log";
import { usePendingTradesStore, type PendingTrade } from "@/stores/pendingTrades";
import { useNotificationsStore } from "@/stores/notifications";
import { useToastStore } from "@/stores/toast";
import { useWalletStore } from "@/stores/wallet";
import { getNostrSignerRevision, subscribeToNostrSignerRevision } from "@/lib/nostr";
import { useOrderSettlementObservations } from "@/stores/orderSettlementObservations";

const JOIN_RETRY_MS = 1_000;
/** A settlement result that is not ready is read again after these delays. */
const SETTLEMENT_RESULT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
/** Later reads use this interval until the result is applied or work ends. */
const RECOVERY_RETRY_MS = 15_000;

export interface OrderSettlementRecoveryInput {
  readonly mnemonic: string | null;
  readonly mintUrls: readonly string[];
}

interface RecoverySession {
  cancelled: boolean;
}

interface ConfirmedOrderRecovery {
  readonly input: RefObject<OrderSettlementRecoveryInput>;
  readonly recovering: RefObject<Set<string>>;
  readonly retryTimers: RefObject<Map<string, ReturnType<typeof setTimeout>>>;
  readonly retryAttempts: RefObject<Map<string, number>>;
  readonly rerun: RefObject<Set<string>>;
  readonly session: RefObject<RecoverySession>;
}

interface QueuedOrderStatusRead {
  readonly walletId: string;
  readonly trade: PendingTrade;
  /** False when a Confirmed notice already started the settlement apply. */
  readonly recoverCommittedFill: boolean;
}

function isConfirmed(status: SettlementGroupStatus): boolean {
  return status === "Confirmed";
}

export function useOrderSettlementLifecycle(
  canAuthenticateOrderHub: boolean,
  recoveryInput: OrderSettlementRecoveryInput,
): void {
  const displaySignerRevision = useSyncExternalStore(
    subscribeToNostrSignerRevision,
    getNostrSignerRevision,
  );
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
  const recoveryRerunOrderIdsRef = useRef(new Set<string>());
  const recoverySessionRef = useRef<RecoverySession>({ cancelled: false });
  const recoveryRetryTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const recoveryRetryAttemptsRef = useRef(new Map<string, number>());
  const invalidationQueuedRef = useRef(new Set<string>());
  const joinRetryTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const legacyReconciliationRunningRef = useRef(false);
  const legacyReadRevisionByTradeRef = useRef(new WeakMap<PendingTrade, number>());
  const orderStatusQueueRef = useRef(new Map<string, QueuedOrderStatusRead>());
  const orderStatusQueueRunningRef = useRef(false);
  const orderStatusReadRevisionByTradeRef = useRef(new WeakMap<PendingTrade, number>());
  const displayRepairRef = useRef<ReturnType<typeof createDisplayResyncRepair> | null>(null);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [legacyReconciliationRevision, setLegacyReconciliationRevision] = useState(0);
  recoveryInputRef.current = recoveryInput;
  const confirmedRecovery: ConfirmedOrderRecovery = {
    input: recoveryInputRef,
    recovering: recoveringOrderIdsRef,
    retryTimers: recoveryRetryTimersRef,
    retryAttempts: recoveryRetryAttemptsRef,
    rerun: recoveryRerunOrderIdsRef,
    session: recoverySessionRef,
  };

  useEffect(() => {
    useOrderSettlementObservations.getState().retain(activeWalletId, pendingOrdersById);
  }, [activeWalletId, pendingOrdersById]);

  const drainOrderStatusQueue = () => {
    if (orderStatusQueueRunningRef.current) return;
    orderStatusQueueRunningRef.current = true;
    const session = recoverySessionRef.current;
    void (async () => {
      while (!session.cancelled) {
        const next = orderStatusQueueRef.current.values().next().value;
        if (!next) return;
        const key = `${next.walletId}:${next.trade.orderId}`;
        orderStatusQueueRef.current.delete(key);
        const response = await reconcileOrderStatus(next.trade, next.walletId, session);
        if (
          !session.cancelled &&
          next.recoverCommittedFill &&
          response &&
          hasCommittedFillForOrder(response, next.trade.orderId)
        ) {
          recoverConfirmedOrder(next.trade.orderId, next.walletId, confirmedRecovery, false);
        }
      }
    })()
      .catch(() => {})
      .finally(() => {
        orderStatusQueueRunningRef.current = false;
        if (orderStatusQueueRef.current.size > 0) drainOrderStatusQueue();
      });
  };

  const enqueueOrderStatusRead = (
    trade: PendingTrade,
    walletId: string,
    recoverCommittedFill = true,
  ): boolean => {
    if (
      recoverySessionRef.current.cancelled ||
      !canAuthenticateOrderHub ||
      trade.walletId !== walletId ||
      currentActiveWalletId() !== walletId
    ) {
      return false;
    }
    const key = `${walletId}:${trade.orderId}`;
    const queued = orderStatusQueueRef.current.get(key);
    orderStatusQueueRef.current.set(key, {
      walletId,
      trade,
      recoverCommittedFill: recoverCommittedFill || queued?.recoverCommittedFill === true,
    });
    drainOrderStatusQueue();
    return true;
  };

  const enabled =
    canAuthenticateOrderHub && (pendingOrders.length > 0 || unscopedPendingOrders.length > 0);
  useEffect(() => {
    if (!enabled || activeWalletId === null) return;
    const signerRevision = getNostrSignerRevision();
    const repair = createDisplayResyncRepair({
      initialJitterMs: 250,
      repair: async (signal) => {
        const session = {
          get cancelled() {
            return (
              signal.aborted ||
              currentActiveWalletId() !== activeWalletId ||
              getNostrSignerRevision() !== signerRevision
            );
          },
        };
        for (const trade of Object.values(usePendingTradesStore.getState().byOrderId)) {
          signal.throwIfAborted();
          if (session.cancelled) throw new Error("Order display scope changed.");
          if (trade.walletId !== activeWalletId) continue;
          const status = await reconcileOrderStatus(trade, activeWalletId, session, true, signal);
          if (session.cancelled || !status) throw new Error("Order display repair is unavailable.");
          if (hasCommittedFillForOrder(status, trade.orderId)) {
            recoverConfirmedOrder(trade.orderId, activeWalletId, confirmedRecovery, false);
          }
        }
      },
    });
    displayRepairRef.current = repair;
    return () => {
      if (displayRepairRef.current === repair) displayRepairRef.current = null;
      void repair.dispose();
    };
  }, [enabled, activeWalletId, canAuthenticateOrderHub, displaySignerRevision]);
  const { joinOrder } = useOrderHub(
    enabled,
    {
      onResyncRequired: (token) => displayRepairRef.current?.request(token),
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
            message: formatNotificationText(notifications[0], i18n.t.bind(i18n)),
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
        const confirmed = isConfirmed(delta.settlementGroup.status);
        if (confirmed) {
          // A Confirmed group proves this order's committed fill. Apply the
          // settlement result now. The status read below records the activity.
          recoverConfirmedOrder(delta.orderId, activeWalletId, confirmedRecovery, true);
        }
        if (requiresStatusReconciliation(delta.settlementGroup.status)) {
          enqueueOrderStatusRead(order, activeWalletId, !confirmed);
        }
        if (confirmed) {
          queuePortfolioInvalidation(activeWalletId, invalidationQueuedRef);
        }
      },
    },
    `${activeWalletId ?? ""}:${displaySignerRevision}`,
  );

  useEffect(() => {
    const session: RecoverySession = { cancelled: false };
    recoverySessionRef.current = session;
    return () => {
      session.cancelled = true;
      recoveryRerunOrderIdsRef.current.clear();
      orderStatusQueueRef.current.clear();
      for (const timer of recoveryRetryTimersRef.current.values()) clearTimeout(timer);
      recoveryRetryTimersRef.current.clear();
      recoveryRetryAttemptsRef.current.clear();
    };
  }, [activeWalletId]);

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
  session: RecoverySession,
  discardOldScope = false,
  signal?: AbortSignal,
): Promise<OrderStatusResponse | null> {
  if (
    trade.walletId !== walletId ||
    !CANONICAL_WALLET_ID.test(walletId) ||
    currentActiveWalletId() !== walletId
  ) {
    return null;
  }
  try {
    const signerRevision = getNostrSignerRevision();
    const status = await (signal
      ? fetchOrderStatus(trade.marketId, trade.orderId, signal)
      : fetchOrderStatus(trade.marketId, trade.orderId));
    if (!status || status.orderId !== trade.orderId || status.marketId !== trade.marketId) {
      return null;
    }

    if (
      discardOldScope &&
      (session.cancelled ||
        currentActiveWalletId() !== walletId ||
        getNostrSignerRevision() !== signerRevision)
    )
      return null;

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

    if (!session.cancelled && getNostrSignerRevision() === signerRevision) {
      useOrderSettlementObservations.getState().publish(latest, signerRevision, status);
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

function recoverConfirmedOrder(
  orderId: string,
  walletId: string,
  refs: ConfirmedOrderRecovery,
  newNotice: boolean,
): void {
  const order = usePendingTradesStore.getState().byOrderId[orderId];
  const recoveryInput = refs.input.current;
  const session = refs.session.current;
  if (
    session.cancelled ||
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
  // A new notice is new evidence. It restarts the short retry delays.
  if (newNotice) refs.retryAttempts.current.delete(recoveryKey);
  const priorRetry = refs.retryTimers.current.get(recoveryKey);
  if (priorRetry !== undefined) {
    clearTimeout(priorRetry);
    refs.retryTimers.current.delete(recoveryKey);
  }

  if (refs.recovering.current.has(recoveryKey)) {
    refs.rerun.current.add(recoveryKey);
    return;
  }

  refs.recovering.current.add(recoveryKey);
  let retryRequired = false;
  void recoverBrowserCtfRangeOrder({
    mnemonic: recoveryInput.mnemonic,
    mintUrls: recoveryInput.mintUrls,
    clientOrderId: order.clientOrderId,
  })
    .then((result) => {
      const latest = usePendingTradesStore.getState().byOrderId[orderId];
      if (
        !session.cancelled &&
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
      refs.recovering.current.delete(recoveryKey);
      const latest = usePendingTradesStore.getState().byOrderId[orderId];
      const rerunRequested = refs.rerun.current.delete(recoveryKey);
      if (!retryRequired) refs.retryAttempts.current.delete(recoveryKey);
      if (
        !retryRequired ||
        refs.session.current.cancelled ||
        latest?.walletId !== walletId ||
        currentWalletId(refs.input.current) !== walletId ||
        currentActiveWalletId() !== walletId
      ) {
        return;
      }
      const retry = () => recoverConfirmedOrder(orderId, walletId, refs, false);
      if (rerunRequested) {
        retry();
        return;
      }
      if (session.cancelled) return;
      const attempt = refs.retryAttempts.current.get(recoveryKey) ?? 0;
      refs.retryAttempts.current.set(recoveryKey, attempt + 1);
      const timer = setTimeout(() => {
        refs.retryTimers.current.delete(recoveryKey);
        retry();
      }, SETTLEMENT_RESULT_RETRY_DELAYS_MS[attempt] ?? RECOVERY_RETRY_MS);
      refs.retryTimers.current.set(recoveryKey, timer);
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
