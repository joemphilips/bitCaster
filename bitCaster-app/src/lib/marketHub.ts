/**
 * SignalR client helper for the matching engine's MarketHub at /hubs/market.
 *
 * Scope: live order-book updates per market group (`JoinMarket` /
 * `LeaveMarket`) and display-only portfolio valuation invalidations. The hub
 * does not send per-position values. Order-owner settlement lifecycle runs
 * on the authenticated order hub.
 *
 * Lifecycle: a single lazy HubConnection is shared across the whole app.
 * React components subscribe via `onOrderBookUpdated` and are returned an
 * unsubscribe function to call on unmount. The connection is only started
 * on the first subscribe (there is no explicit tear-down call today — we
 * rely on GC + visibility changes).
 */

import { HubConnectionBuilder, HubConnectionState, type HubConnection } from "@microsoft/signalr";
import type { components } from "@/generated/api";
import { debounce, type DebouncedFunction } from "@/lib/debounce";
import { resolveHubServerUrl } from "@/lib/hubUrl";
import type { MarketFundingObservation } from "@/lib/marketFunding";
import { refreshOrderBook } from "@/lib/orderBookRefresh";

export type OrderBookSnapshot = components["schemas"]["OrderBookSnapshot"];
export type MarketStatusChanged = components["schemas"]["MarketStatusChanged"];
export type LatestConfirmedTrade = components["schemas"]["LatestConfirmedTrade"];
export interface ConfirmedTradeRecordedMessage {
  conditionId: string;
  latestConfirmedTrade: LatestConfirmedTrade;
}
export interface MarketFundingUpdatedMessage extends Omit<
  MarketFundingObservation,
  "fundingRevision"
> {
  conditionId: string;
  fundingRevision: string;
}
export interface OrderCancelled {
  marketId: string;
  orderId: string;
}

function isLatestConfirmedTrade(value: unknown): value is LatestConfirmedTrade {
  if (typeof value !== "object" || value === null) return false;
  const raw = value as Record<string, unknown>;
  const divisibility = raw.divisibility;
  return (
    typeof raw.primitiveOutcomeId === "string" &&
    raw.primitiveOutcomeId.trim().length > 0 &&
    typeof raw.fillId === "string" &&
    raw.fillId.trim().length > 0 &&
    typeof raw.executedAt === "string" &&
    raw.executedAt.trim().length > 0 &&
    typeof raw.eventOrder === "string" &&
    raw.eventOrder.trim().length > 0 &&
    typeof raw.priceTick === "number" &&
    Number.isInteger(raw.priceTick) &&
    typeof divisibility === "number" &&
    (divisibility === 1_000 || divisibility === 1_000_000) &&
    raw.priceTick > 0 &&
    raw.priceTick < divisibility &&
    typeof raw.faceAmountSubunits === "number" &&
    Number.isInteger(raw.faceAmountSubunits) &&
    raw.faceAmountSubunits > 0
  );
}

export function parseConfirmedTradeRecorded(
  payload: unknown,
): ConfirmedTradeRecordedMessage | null {
  if (typeof payload !== "object" || payload === null) return null;
  const raw = payload as Record<string, unknown>;
  const conditionId =
    typeof raw.conditionId === "string"
      ? raw.conditionId
      : typeof raw.ConditionId === "string"
        ? raw.ConditionId
        : null;
  const latestConfirmedTrade = raw.latestConfirmedTrade ?? raw.LatestConfirmedTrade;
  if (!conditionId || !isLatestConfirmedTrade(latestConfirmedTrade)) return null;
  return { conditionId, latestConfirmedTrade };
}

export function parseMarketFundingUpdated(payload: unknown): MarketFundingUpdatedMessage | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const raw = payload as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (
    keys.length !== 3 ||
    keys.some(
      (key) => key !== "conditionId" && key !== "ammBotBudgetSubunits" && key !== "fundingRevision",
    )
  ) {
    return null;
  }

  const conditionId = raw.conditionId;
  const ammBotBudgetSubunits = raw.ammBotBudgetSubunits;
  const fundingRevision = raw.fundingRevision;
  if (
    typeof conditionId !== "string" ||
    conditionId.length === 0 ||
    conditionId.trim() !== conditionId ||
    typeof ammBotBudgetSubunits !== "number" ||
    !Number.isSafeInteger(ammBotBudgetSubunits) ||
    ammBotBudgetSubunits <= 0 ||
    typeof fundingRevision !== "string" ||
    fundingRevision.length === 0 ||
    fundingRevision.trim() !== fundingRevision
  ) {
    return null;
  }

  return { conditionId, ammBotBudgetSubunits, fundingRevision };
}

function compareEventOrder(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareConfirmedTrades(left: LatestConfirmedTrade, right: LatestConfirmedTrade): number {
  const byEventOrder = compareEventOrder(left.eventOrder, right.eventOrder);
  if (byEventOrder !== 0) return byEventOrder;
  if (left.primitiveOutcomeId === right.primitiveOutcomeId) return 0;
  return left.primitiveOutcomeId < right.primitiveOutcomeId ? -1 : 1;
}

function isRegisteredPrimitiveOutcomeAllowlist(value: readonly string[]): boolean {
  if (!Array.isArray(value) || value.length < 2 || value.length > 8) return false;
  const unique = new Set(value);
  return (
    unique.size === value.length &&
    value.every(
      (outcomeId) =>
        typeof outcomeId === "string" && outcomeId.length > 0 && outcomeId === outcomeId.trim(),
    )
  );
}

/**
 * Apply one committed trade delta to the page's bounded in-memory view.
 *
 * REST remains the authority. This helper only provides the live SignalR
 * merge seam: it accepts only registered primitive outcomes, rejects another
 * condition, deduplicates by fill ID, and refuses to move an existing fill
 * backwards in wrapper event order.
 */
export function applyConfirmedTradeDelta(
  conditionId: string,
  allowedPrimitiveOutcomeIds: readonly string[],
  current: readonly LatestConfirmedTrade[],
  message: ConfirmedTradeRecordedMessage,
): LatestConfirmedTrade[] {
  if (!isRegisteredPrimitiveOutcomeAllowlist(allowedPrimitiveOutcomeIds)) {
    return [];
  }
  const allowed = new Set(allowedPrimitiveOutcomeIds);

  // The REST projection exposes one latest record per primitive outcome. Keep
  // the live overlay bounded to the registered outcome universe while using
  // fillId to reject duplicate deliveries and eventOrder to reject stale
  // replacements.
  const nextByOutcome = new Map<string, LatestConfirmedTrade>();
  const nextByFillId = new Map<string, LatestConfirmedTrade>();
  const boundedOverlay = (): LatestConfirmedTrade[] => {
    const result = [...nextByOutcome.values()].sort(compareConfirmedTrades);
    return result.length <= allowed.size ? result : [];
  };

  const remove = (trade: LatestConfirmedTrade): void => {
    if (nextByOutcome.get(trade.primitiveOutcomeId)?.fillId === trade.fillId) {
      nextByOutcome.delete(trade.primitiveOutcomeId);
    }
    if (nextByFillId.get(trade.fillId)?.primitiveOutcomeId === trade.primitiveOutcomeId) {
      nextByFillId.delete(trade.fillId);
    }
  };

  for (const trade of current) {
    if (!allowed.has(trade.primitiveOutcomeId)) continue;
    if (nextByFillId.has(trade.fillId)) continue;
    const previousForOutcome = nextByOutcome.get(trade.primitiveOutcomeId);
    if (
      previousForOutcome &&
      compareEventOrder(previousForOutcome.eventOrder, trade.eventOrder) >= 0
    ) {
      continue;
    }
    if (previousForOutcome) remove(previousForOutcome);
    nextByOutcome.set(trade.primitiveOutcomeId, trade);
    nextByFillId.set(trade.fillId, trade);
  }

  if (
    message.conditionId !== conditionId ||
    !allowed.has(message.latestConfirmedTrade.primitiveOutcomeId)
  ) {
    return boundedOverlay();
  }

  const incoming = message.latestConfirmedTrade;
  // A fill ID is immutable identity. A duplicate delivery is ignored even if
  // an invalid sender attaches a later wrapper order or changed payload.
  if (nextByFillId.has(incoming.fillId)) {
    return boundedOverlay();
  }
  const previousForOutcome = nextByOutcome.get(incoming.primitiveOutcomeId);
  if (
    previousForOutcome &&
    compareEventOrder(incoming.eventOrder, previousForOutcome.eventOrder) <= 0
  ) {
    return boundedOverlay();
  }
  if (previousForOutcome) remove(previousForOutcome);
  nextByOutcome.set(incoming.primitiveOutcomeId, incoming);
  nextByFillId.set(incoming.fillId, incoming);
  return boundedOverlay();
}

export function parseOrderCancelled(payload: unknown): OrderCancelled | null {
  const raw = payload as Record<string, unknown>;
  const marketId =
    typeof raw.marketId === "string"
      ? raw.marketId
      : typeof raw.MarketId === "string"
        ? raw.MarketId
        : null;
  const orderId =
    typeof raw.orderId === "string"
      ? raw.orderId
      : typeof raw.OrderId === "string"
        ? raw.OrderId
        : null;
  return marketId && orderId ? { marketId, orderId } : null;
}

type OrderBookHandler = (snapshot: OrderBookSnapshot) => void;
type MarketStatusHandler = (status: MarketStatusChanged) => void;
type ConfirmedTradeRecordedHandler = (message: ConfirmedTradeRecordedMessage) => void;
type MarketFundingUpdatedHandler = (message: MarketFundingUpdatedMessage) => void;
type OrderCancelledHandler = (cancelled: OrderCancelled) => void;
type MarketRejoinedHandler = () => void;
type PortfolioValuationObserverState = {
  onRefresh: () => void;
  conditionHandlers: Map<string, () => void>;
  disposed: boolean;
};
type DesiredPortfolioValuationSet = {
  observer: PortfolioValuationObserverState | null;
  conditionIds: readonly string[] | null;
  revision: number;
  notifyOnSuccess: boolean;
};
type AppliedPortfolioValuationSet = {
  connection: HubConnection;
  conditionIds: readonly string[];
};
type MarketSnapshotRefresh = {
  promise: Promise<void>;
  dirty: boolean;
};

const PORTFOLIO_VALUATION_CONDITION_IDS_MAX = 200;
const PORTFOLIO_CONDITION_ID_PATTERN = /^[0-9a-fA-F]{1,128}$/;

const SERVER_URL = resolveHubServerUrl();
const HUB_URL = `${SERVER_URL}/hubs/market`;

function marketHubDisabledForE2E(): boolean {
  if (typeof window === "undefined") return false;
  if (!import.meta.env.DEV) return false;
  if (
    Boolean(
      (window as unknown as { __BITCASTER_E2E_DISABLE_MARKET_HUB?: boolean })
        .__BITCASTER_E2E_DISABLE_MARKET_HUB,
    )
  ) {
    return true;
  }
  try {
    return window.localStorage.getItem("bitcaster-e2e-disable-market-hub") === "true";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Singleton connection state
// ---------------------------------------------------------------------------

let _connection: HubConnection | null = null;
let _startPromise: Promise<void> | null = null;

// Per-market handlers. We keep a Set so two components watching the same
// market don't stomp on each other's subscriptions, and so the last unsubscribe
// can cleanly leave the server group.
const _orderBookHandlers = new Map<string, Set<OrderBookHandler>>();
const _orderCancelledHandlers = new Map<string, Set<OrderCancelledHandler>>();
const _confirmedTradeRecordedHandlers = new Map<string, Set<ConfirmedTradeRecordedHandler>>();
const _marketFundingUpdatedHandlers = new Map<string, Set<MarketFundingUpdatedHandler>>();
const _marketJoinCounts = new Map<string, number>();
const _desiredMarketJoins = new Set<string>();
const _marketSnapshotRequests = new Map<string, MarketSnapshotRefresh>();
const _marketRejoinedHandlers = new Map<string, Set<MarketRejoinedHandler>>();
const _rejoinRefreshers = new Map<string, DebouncedFunction<[]>>();
let _portfolioValuationObserver: PortfolioValuationObserverState | null = null;
let _portfolioValuationSetRevision = 0;
let _desiredPortfolioValuationSet: DesiredPortfolioValuationSet = {
  observer: null,
  conditionIds: null,
  revision: 0,
  notifyOnSuccess: false,
};
let _appliedPortfolioValuationSet: AppliedPortfolioValuationSet | null = null;
let _portfolioValuationMembershipGeneration = 0;
let _portfolioValuationReplacementTail: Promise<void> = Promise.resolve();

// Per-condition lifecycle handlers. The server fans MarketStatusChanged out to
// every per-outcome group of the condition, so a client joined to any one
// outcome group receives it; we key handlers by conditionId.
const _marketStatusHandlers = new Map<string, Set<MarketStatusHandler>>();

function buildConnection(): HubConnection {
  // Order-book updates are public — no NIP-98 needed on this hub.
  const conn = new HubConnectionBuilder()
    .withUrl(HUB_URL)
    .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
    .build();

  conn.on("OrderBookUpdated", (snapshot: OrderBookSnapshot) => {
    const handlers = _orderBookHandlers.get(snapshot.marketId);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(snapshot);
      } catch (err) {
        console.warn("[marketHub] OrderBookUpdated handler threw:", err);
      }
    }
  });

  conn.on("OrderCancelled", (payload: unknown) => {
    const parsed = parseOrderCancelled(payload);
    if (!parsed) return;
    const handlers = _orderCancelledHandlers.get(parsed.marketId);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(parsed);
      } catch (err) {
        console.warn("[marketHub] OrderCancelled handler threw:", err);
      }
    }
  });

  conn.on("MarketStatusChanged", (status: MarketStatusChanged) => {
    const handlers = _marketStatusHandlers.get(status.conditionId);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(status);
      } catch (err) {
        console.warn("[marketHub] MarketStatusChanged handler threw:", err);
      }
    }
  });

  conn.on("ConfirmedTradeRecorded", (payload: unknown) => {
    const message = parseConfirmedTradeRecorded(payload);
    if (!message) return;
    const handlers = _confirmedTradeRecordedHandlers.get(message.conditionId);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(message);
      } catch (err) {
        console.warn("[marketHub] ConfirmedTradeRecorded handler threw:", err);
      }
    }
  });

  conn.on("MarketFundingUpdated", (payload: unknown) => {
    const message = parseMarketFundingUpdated(payload);
    if (!message) return;
    const handlers = _marketFundingUpdatedHandlers.get(message.conditionId);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(message);
      } catch (err) {
        console.warn("[marketHub] MarketFundingUpdated handler threw:", err);
      }
    }
  });

  conn.onreconnected(() => {
    void rejoinMarketsAfterReconnect(conn);
    if (_connection !== conn) return;
    _portfolioValuationMembershipGeneration += 1;
    _appliedPortfolioValuationSet = null;
    const desired = _desiredPortfolioValuationSet;
    if (
      desired.conditionIds !== null &&
      desired.observer !== null &&
      desired.observer === _portfolioValuationObserver
    ) {
      _desiredPortfolioValuationSet = {
        ...desired,
        revision: ++_portfolioValuationSetRevision,
        notifyOnSuccess: true,
      };
      void enqueuePortfolioValuationReplacement().catch((err) => {
        console.warn("[marketHub] portfolio valuation subscription after reconnect failed:", err);
      });
    }
  });

  return conn;
}

async function rejoinMarketsAfterReconnect(conn: HubConnection): Promise<void> {
  const markets = Array.from(_desiredMarketJoins);
  await Promise.all(
    markets.map(async (marketId) => {
      try {
        await conn.invoke("JoinMarket", marketId);
        requestRecoveryRefresh(marketId);
      } catch (err) {
        console.warn("[marketHub] JoinMarket after reconnect failed:", err);
      }
    }),
  );
}

function requestRecoveryRefresh(marketId: string): void {
  let refresh = _rejoinRefreshers.get(marketId);
  if (!refresh) {
    refresh = debounce(() => {
      const handlers = _marketRejoinedHandlers.get(marketId);
      if (handlers && handlers.size > 0) {
        for (const handler of handlers) {
          try {
            handler();
          } catch (err) {
            console.warn("[marketHub] reconnect refresh handler threw:", err);
          }
        }
        return;
      }

      void refreshOrderBook(marketId).catch((err) => {
        console.warn("[marketHub] reconnect order-book refresh failed:", err);
      });
    }, 200);
    _rejoinRefreshers.set(marketId, refresh);
  }
  refresh();
}

function ensureConnection(): HubConnection {
  if (!_connection) _connection = buildConnection();
  return _connection;
}

async function ensureStarted(): Promise<HubConnection> {
  const conn = ensureConnection();
  if (conn.state === HubConnectionState.Connected) return conn;
  if (!_startPromise) {
    _startPromise = conn.start().catch((err) => {
      // Reset so a later caller can retry (e.g. after user logs in).
      _startPromise = null;
      throw err;
    });
  }
  await _startPromise;
  return conn;
}

function normalizePortfolioValuationConditionIds(conditionIds: readonly string[]): string[] {
  if (!Array.isArray(conditionIds)) {
    throw new Error("portfolio valuation condition IDs must be an array");
  }
  if (conditionIds.length > PORTFOLIO_VALUATION_CONDITION_IDS_MAX) {
    throw new Error("at most 200 portfolio valuation condition IDs are allowed");
  }

  const unique = new Set<string>();
  for (const conditionId of conditionIds) {
    if (typeof conditionId !== "string" || !PORTFOLIO_CONDITION_ID_PATTERN.test(conditionId)) {
      throw new Error(
        "portfolio valuation condition IDs must contain 1 to 128 hexadecimal characters",
      );
    }
    unique.add(conditionId);
  }
  return [...unique].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function haveSamePortfolioConditionIds(
  left: readonly string[] | null,
  right: readonly string[] | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.length === right.length &&
    left.every((conditionId, index) => conditionId === right[index])
  );
}

function notifyPortfolioValuationObserver(observer: PortfolioValuationObserverState): void {
  try {
    observer.onRefresh();
  } catch (err) {
    console.warn("[marketHub] portfolio valuation refresh handler threw:", err);
  }
}

function completePortfolioValuationReplacement(desired: DesiredPortfolioValuationSet): void {
  if (!desired.notifyOnSuccess || _desiredPortfolioValuationSet.revision !== desired.revision) {
    return;
  }

  _desiredPortfolioValuationSet = { ...desired, notifyOnSuccess: false };
  if (
    desired.observer !== null &&
    desired.observer === _portfolioValuationObserver &&
    !desired.observer.disposed
  ) {
    notifyPortfolioValuationObserver(desired.observer);
  }
}

function clearPortfolioValuationConditionHandlers(observer: PortfolioValuationObserverState): void {
  for (const removeHandlers of observer.conditionHandlers.values()) removeHandlers();
  observer.conditionHandlers.clear();
}

function replacePortfolioValuationConditionHandlers(
  observer: PortfolioValuationObserverState,
  conditionIds: readonly string[],
): void {
  const nextIds = new Set(conditionIds);
  for (const [conditionId, removeHandlers] of observer.conditionHandlers) {
    if (nextIds.has(conditionId)) continue;
    removeHandlers();
    observer.conditionHandlers.delete(conditionId);
  }

  for (const conditionId of conditionIds) {
    if (observer.conditionHandlers.has(conditionId)) continue;
    const onChange = () => notifyPortfolioValuationObserver(observer);
    const removeTradeHandler = onConfirmedTradeRecorded(conditionId, onChange);
    const removeStatusHandler = onMarketStatusChanged(conditionId, onChange);
    observer.conditionHandlers.set(conditionId, () => {
      removeTradeHandler();
      removeStatusHandler();
    });
  }
}

function enqueuePortfolioValuationReplacement(): Promise<void> {
  if (marketHubDisabledForE2E()) return Promise.resolve();

  const replacement = _portfolioValuationReplacementTail
    .catch(() => undefined)
    .then(async () => {
      while (true) {
        const desired = _desiredPortfolioValuationSet;
        if (desired.conditionIds === null) return;

        const connection = await ensureStarted();
        if (desired.revision !== _desiredPortfolioValuationSet.revision) continue;
        const conditionIds = desired.conditionIds;
        const applied = _appliedPortfolioValuationSet;
        if (
          applied?.connection === connection &&
          haveSamePortfolioConditionIds(applied.conditionIds, conditionIds)
        ) {
          completePortfolioValuationReplacement(desired);
          return;
        }

        const membershipGeneration = _portfolioValuationMembershipGeneration;
        try {
          await connection.invoke("SetPortfolioValuationSubscriptions", [...conditionIds]);
        } catch (err) {
          if (
            desired.revision !== _desiredPortfolioValuationSet.revision ||
            membershipGeneration !== _portfolioValuationMembershipGeneration ||
            _connection !== connection
          ) {
            continue;
          }
          throw err;
        }

        if (
          membershipGeneration !== _portfolioValuationMembershipGeneration ||
          _connection !== connection
        ) {
          continue;
        }
        _appliedPortfolioValuationSet = { connection, conditionIds };
        if (desired.revision !== _desiredPortfolioValuationSet.revision) continue;
        completePortfolioValuationReplacement(desired);
        return;
      }
    });
  _portfolioValuationReplacementTail = replacement;
  return replacement;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function joinMarket(marketId: string): Promise<void> {
  _desiredMarketJoins.add(marketId);
  if (marketHubDisabledForE2E()) return;
  const currentCount = _marketJoinCounts.get(marketId) ?? 0;
  if (currentCount > 0) {
    _marketJoinCounts.set(marketId, currentCount + 1);
    return;
  }
  _marketJoinCounts.set(marketId, 1);
  const conn = await ensureStarted();
  await conn.invoke("JoinMarket", marketId);
}

export interface PortfolioValuationObserver {
  /** Replace this observer's condition set after a fresh Portfolio response. */
  replaceConditionIds(conditionIds: readonly string[]): Promise<void>;
  /** Remove this observer. Only the current observer clears server membership. */
  dispose(): void;
}

/**
 * Observe display invalidations for the current Portfolio page. Condition
 * sets use a separate hub method and never join order-book groups.
 */
export function observePortfolioValuations(onRefresh: () => void): PortfolioValuationObserver {
  const previousObserver = _portfolioValuationObserver;
  if (previousObserver) {
    previousObserver.disposed = true;
    clearPortfolioValuationConditionHandlers(previousObserver);
  }

  const observer: PortfolioValuationObserverState = {
    onRefresh,
    conditionHandlers: new Map(),
    disposed: false,
  };
  _portfolioValuationObserver = observer;
  _desiredPortfolioValuationSet = {
    observer,
    conditionIds: null,
    revision: ++_portfolioValuationSetRevision,
    notifyOnSuccess: false,
  };

  return {
    replaceConditionIds(conditionIds) {
      if (observer.disposed || _portfolioValuationObserver !== observer) {
        return Promise.resolve();
      }
      const normalizedConditionIds = normalizePortfolioValuationConditionIds(conditionIds);

      replacePortfolioValuationConditionHandlers(observer, normalizedConditionIds);
      const desired = _desiredPortfolioValuationSet;
      if (
        desired.observer !== observer ||
        !haveSamePortfolioConditionIds(desired.conditionIds, normalizedConditionIds)
      ) {
        _desiredPortfolioValuationSet = {
          observer,
          conditionIds: normalizedConditionIds,
          revision: ++_portfolioValuationSetRevision,
          notifyOnSuccess: true,
        };
      }
      return enqueuePortfolioValuationReplacement();
    },
    dispose() {
      if (observer.disposed) return;
      observer.disposed = true;
      clearPortfolioValuationConditionHandlers(observer);
      if (_portfolioValuationObserver !== observer) return;

      _portfolioValuationObserver = null;
      _desiredPortfolioValuationSet = {
        observer: null,
        conditionIds: [],
        revision: ++_portfolioValuationSetRevision,
        notifyOnSuccess: false,
      };
      const connection = _connection;
      if (
        connection?.state === HubConnectionState.Connected ||
        (connection !== null && _startPromise !== null)
      ) {
        void enqueuePortfolioValuationReplacement().catch((err) => {
          console.warn("[marketHub] portfolio valuation unsubscribe failed:", err);
        });
      } else {
        _appliedPortfolioValuationSet = null;
      }
    },
  };
}

/**
 * Ask the server for a fresh snapshot of a group this client already joined.
 * JoinMarket is idempotent on the hub; calling it here must not change the
 * client-side subscription reference count.
 */
export function refreshMarketSnapshot(marketId: string): Promise<void> {
  if (marketHubDisabledForE2E() || !_desiredMarketJoins.has(marketId)) {
    return Promise.resolve();
  }
  const inFlight = _marketSnapshotRequests.get(marketId);
  if (inFlight) {
    inFlight.dirty = true;
    return inFlight.promise;
  }

  const refreshState: MarketSnapshotRefresh = {
    promise: Promise.resolve(),
    dirty: false,
  };
  refreshState.promise = (async () => {
    const conn = await ensureStarted();
    do {
      if (!_desiredMarketJoins.has(marketId)) return;
      refreshState.dirty = false;
      await conn.invoke("JoinMarket", marketId);
    } while (refreshState.dirty && _desiredMarketJoins.has(marketId));
  })();
  _marketSnapshotRequests.set(marketId, refreshState);
  const clearRequest = () => {
    if (_marketSnapshotRequests.get(marketId) === refreshState) {
      _marketSnapshotRequests.delete(marketId);
    }
  };
  void refreshState.promise.then(clearRequest, clearRequest);
  return refreshState.promise;
}

export async function leaveMarket(marketId: string): Promise<void> {
  if (marketHubDisabledForE2E()) {
    _marketJoinCounts.delete(marketId);
    _desiredMarketJoins.delete(marketId);
    return;
  }
  const currentCount = _marketJoinCounts.get(marketId) ?? 0;
  if (currentCount > 1) {
    _marketJoinCounts.set(marketId, currentCount - 1);
    return;
  }
  _marketJoinCounts.delete(marketId);
  _desiredMarketJoins.delete(marketId);
  const conn = ensureConnection();
  if (conn.state !== HubConnectionState.Connected) return;
  try {
    await conn.invoke("LeaveMarket", marketId);
  } catch (err) {
    // Best-effort — a disconnected hub will throw but we don't want React
    // cleanup to crash.
    console.warn("[marketHub] LeaveMarket failed:", err);
  }
}

/**
 * Register a handler for order-book updates on a specific market. Returns
 * an unsubscribe function — call on component unmount.
 */
export function onOrderBookUpdated(marketId: string, handler: OrderBookHandler): () => void {
  let set = _orderBookHandlers.get(marketId);
  if (!set) {
    set = new Set();
    _orderBookHandlers.set(marketId, set);
  }
  set.add(handler);
  return () => {
    const s = _orderBookHandlers.get(marketId);
    if (!s) return;
    s.delete(handler);
    if (s.size === 0) _orderBookHandlers.delete(marketId);
  };
}

/**
 * Register a handler for lifecycle changes (e.g. open -> closed) on a
 * condition. The server broadcasts to every per-outcome group of the
 * condition, so the caller must be joined to at least one of the condition's
 * outcome markets (via {@link joinMarket}) to receive these. Returns an
 * unsubscribe function — call on component unmount.
 */
export function onMarketStatusChanged(
  conditionId: string,
  handler: MarketStatusHandler,
): () => void {
  let set = _marketStatusHandlers.get(conditionId);
  if (!set) {
    set = new Set();
    _marketStatusHandlers.set(conditionId, set);
  }
  set.add(handler);
  return () => {
    const s = _marketStatusHandlers.get(conditionId);
    if (!s) return;
    s.delete(handler);
    if (s.size === 0) _marketStatusHandlers.delete(conditionId);
  };
}

export function onOrderCancelled(marketId: string, handler: OrderCancelledHandler): () => void {
  let set = _orderCancelledHandlers.get(marketId);
  if (!set) {
    set = new Set();
    _orderCancelledHandlers.set(marketId, set);
  }
  set.add(handler);
  return () => {
    const s = _orderCancelledHandlers.get(marketId);
    if (!s) return;
    s.delete(handler);
    if (s.size === 0) _orderCancelledHandlers.delete(marketId);
  };
}

/**
 * Register for committed fill deltas for one condition. The callback is
 * best-effort and must merge through {@link applyConfirmedTradeDelta}; REST
 * latest-trade reads remain authoritative after reconnect and refresh.
 */
export function onConfirmedTradeRecorded(
  conditionId: string,
  handler: ConfirmedTradeRecordedHandler,
): () => void {
  let set = _confirmedTradeRecordedHandlers.get(conditionId);
  if (!set) {
    set = new Set();
    _confirmedTradeRecordedHandlers.set(conditionId, set);
  }
  set.add(handler);
  return () => {
    const s = _confirmedTradeRecordedHandlers.get(conditionId);
    if (!s) return;
    s.delete(handler);
    if (s.size === 0) _confirmedTradeRecordedHandlers.delete(conditionId);
  };
}

/** Register for committed funding observations for one condition. */
export function onMarketFundingUpdated(
  conditionId: string,
  handler: MarketFundingUpdatedHandler,
): () => void {
  let set = _marketFundingUpdatedHandlers.get(conditionId);
  if (!set) {
    set = new Set();
    _marketFundingUpdatedHandlers.set(conditionId, set);
  }
  set.add(handler);
  return () => {
    const handlers = _marketFundingUpdatedHandlers.get(conditionId);
    if (!handlers) return;
    handlers.delete(handler);
    if (handlers.size === 0) _marketFundingUpdatedHandlers.delete(conditionId);
  };
}

export function onMarketRejoined(marketId: string, handler: MarketRejoinedHandler): () => void {
  let set = _marketRejoinedHandlers.get(marketId);
  if (!set) {
    set = new Set();
    _marketRejoinedHandlers.set(marketId, set);
  }
  set.add(handler);
  return () => {
    const s = _marketRejoinedHandlers.get(marketId);
    if (!s) return;
    s.delete(handler);
    if (s.size === 0) _marketRejoinedHandlers.delete(marketId);
  };
}

/**
 * Tear down the singleton connection. Mostly for tests and hot-reload
 * scenarios; normal app runs never call this.
 */
export async function disconnect(): Promise<void> {
  const conn = _connection;
  _connection = null;
  _startPromise = null;
  _portfolioValuationMembershipGeneration += 1;
  if (_portfolioValuationObserver) {
    _portfolioValuationObserver.disposed = true;
    clearPortfolioValuationConditionHandlers(_portfolioValuationObserver);
  }
  _portfolioValuationObserver = null;
  _portfolioValuationSetRevision += 1;
  _desiredPortfolioValuationSet = {
    observer: null,
    conditionIds: null,
    revision: _portfolioValuationSetRevision,
    notifyOnSuccess: false,
  };
  _appliedPortfolioValuationSet = null;
  _orderBookHandlers.clear();
  _confirmedTradeRecordedHandlers.clear();
  _marketFundingUpdatedHandlers.clear();
  _marketStatusHandlers.clear();
  _marketRejoinedHandlers.clear();
  _marketSnapshotRequests.clear();
  for (const refresh of _rejoinRefreshers.values()) refresh.cancel();
  _rejoinRefreshers.clear();
  _marketJoinCounts.clear();
  _desiredMarketJoins.clear();
  if (conn) {
    try {
      await conn.stop();
    } catch {
      /* ignore */
    }
  }
}
