import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { MarketDetail } from "@/components/market-detail";
import { InsufficientBalanceModal } from "@/components/shared/InsufficientBalanceModal";
import { NostrAuthRequiredModal } from "@/components/shared/NostrAuthRequiredModal";
import { NostrAccountChooserModal } from "@/components/shared/NostrAccountChooserModal";
import {
  BackupSecretsReminderModal,
  FundedActionBackupPromptModal,
} from "@/components/shared/BackupSecretsReminderModal";
import { TopUpOverlay } from "@/components/market-detail/TopUpOverlay";
import { useShareMarket } from "@/components/market-detail/useShareMarket";
import {
  applyMarketComments,
  applyMarketPriceHistory,
  fetchMarketDetail,
  fetchMarketComments,
  fetchMarketPriceHistory,
  fetchOrderBook,
  generateNip98Header,
  getParticipationScore,
  mapSnapshotToOrderBook,
  signTradeComment,
  windowPriceHistory,
  type MarketPriceHistoryResponse,
  type MarketCommentsResponse,
} from "@/lib/markets";
import { buildTradeTicket, TradeTicketError } from "@/lib/tradeTicket";
import {
  computeTradeCost,
  computeMarketOrderQuotePreview,
  displaySharesToFaceSubunits,
} from "@/lib/tradeCostPreview";
import { assertNever } from "@/lib/enumDiscipline";
import { addOrderSubmitNotifications } from "@/lib/orderNotifications";
import { ensureParticipationScoreForNextMatch } from "@/lib/participationScorePayment";
import {
  outcomeLabels,
  outcomeSetIdsForMarketBooks,
  outcomeSetMarketId,
  resolveOutcomeSets,
} from "@/lib/outcomeSets";
import { useMarketStatusLive } from "@/hooks/useMarketStatusLive";
import { defaultLimitPriceForDivisibility, useMarketPrice } from "@/hooks/useMarketPrice";
import {
  applyConfirmedTradeDelta,
  joinMarket,
  leaveMarket,
  onConfirmedTradeRecorded,
  onMarketRejoined,
  onOrderCancelled,
  onOrderBookUpdated,
  type LatestConfirmedTrade,
  type MarketStatusChanged,
} from "@/lib/marketHub";
import { BitcasterEngineClient } from "@bitcaster/client-sdk/engineClient";
import { debounce } from "@/lib/debounce";
import { refreshOrderBook } from "@/lib/orderBookRefresh";
import { getBalance, useActiveMintInputFeePpk, useWalletStore } from "@/stores/wallet";
import { useSettingsStore } from "@/stores/settings";
import { usePendingTradesStore } from "@/stores/pendingTrades";
import { useNotificationsStore } from "@/stores/notifications";
import { createImplicitWalletAndNostrIdentity } from "@/lib/identityOps";
import { canBackOrder } from "@bitcaster/client-sdk/tradingClient";
import {
  formatMarketSubunits,
  normalizeMarketBaseAsset,
  normalizeMarketDivisibility,
} from "@bitcaster/client-sdk/marketUnits";
import { buildIndexedDbTokenHoldings } from "@/lib/walletHoldings";
import {
  previewBrowserCtfRangeOrderFees,
  submitBrowserCtfRangeOrder,
} from "@/lib/browserCtfRangeOrderSubmission";
import type {
  MarketDetail as MarketDetailType,
  ChartTimeframe,
  TradeSelection,
  TradePreview,
  TradeSide,
  OrderType,
  LimitOrderPreview,
  OrderBook,
  PriceHistory,
  PricePoint,
  Comment,
  RelatedMarket,
  Trade,
} from "@/types/market-detail";
import type { SecretBackupState } from "@/types/settings";

export { defaultLimitPriceForDivisibility };

export function shouldPromptForFundedActionBackup(walletBackupState: SecretBackupState): boolean {
  return walletBackupState === "needs_backup";
}

type TopUpStage = "closed" | "modal" | "overlay";
type TopUpReason =
  | { kind: "collateral"; required: number; baseAsset: string }
  | { kind: "score"; required: number };
export interface PendingTopUpOrderIntent {
  marketId: string;
  selectionKey: string;
  tradeAmount: number;
  tradeSide: TradeSide;
  orderType: OrderType;
  limitPrice: number;
  comment?: string;
  baseAsset: "sat";
  required: number;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, Extract<keyof T, K>>
  : never;
type DerivedMarketDetailFields =
  | "priceHistory"
  | "orderBook"
  | "outcomeOrderBooks"
  | "outcomePriceHistories"
  | "comments"
  | "recentTrades"
  | "relatedMarkets";
type MarketDetailCore = DistributiveOmit<MarketDetailType, DerivedMarketDetailFields>;
type CanonicalSliceSource = "snapshot" | "rest" | "live";
type MarketOrderBooksLoad = {
  orderBook: OrderBook;
  outcomeOrderBooks: Record<string, OrderBook>;
  fetchedOutcomeSetIds: string[];
};

const ORDER_BOOK_REFRESH_DEBOUNCE_MS = 500;

function isEngineMarketClosed(state: MarketDetailType["state"]): boolean {
  if (state == null) return false;

  switch (state) {
    case "open":
      return false;
    case "closed":
      return true;
    default:
      return assertNever(state);
  }
}

function isClosedForTrading(market: MarketDetailType): boolean {
  return isEngineMarketClosed(market.state);
}

export function assertMarketAcceptsOrders(market: MarketDetailType): void {
  if (!isClosedForTrading(market)) return;
  throw new Error("This market is closed and no longer accepts orders.");
}

export function decideTradeCollateralGate(input: {
  balance: number;
  tradeFaceAmountSubunits: number;
}):
  | { kind: "top-up"; balance: number; required: number }
  | { kind: "proceed"; balance: number; required: number } {
  const required = input.tradeFaceAmountSubunits;
  if (input.balance < required) {
    return { kind: "top-up", balance: input.balance, required };
  }
  return { kind: "proceed", balance: input.balance, required };
}

export function tradeSelectionIntentKey(selection: TradeSelection): string {
  return `${selection.side}:${selection.outcomeId ?? ""}`;
}

export function buildPendingTopUpOrderIntent(input: {
  market: MarketDetailType | null;
  tradeSelection: TradeSelection | null;
  tradeAmount: number;
  tradeSide: TradeSide;
  orderType: OrderType;
  limitPrice: number;
  comment?: string;
  baseAsset: string | null | undefined;
  required: number;
}): PendingTopUpOrderIntent | null {
  if (!input.market || !input.tradeSelection || input.tradeAmount <= 0) return null;
  if (!Number.isFinite(input.required) || input.required <= 0) return null;
  return {
    marketId: input.market.id,
    selectionKey: tradeSelectionIntentKey(input.tradeSelection),
    tradeAmount: input.tradeAmount,
    tradeSide: input.tradeSide,
    orderType: input.orderType,
    limitPrice: input.limitPrice,
    comment: input.comment?.trim() || undefined,
    baseAsset: normalizeMarketBaseAsset(input.baseAsset),
    required: Math.ceil(input.required),
  };
}

export function pendingTopUpOrderIntentMatches(
  intent: PendingTopUpOrderIntent,
  current: {
    market: MarketDetailType | null;
    tradeSelection: TradeSelection | null;
    tradeAmount: number;
    tradeSide: TradeSide;
    orderType: OrderType;
    limitPrice: number;
  },
): boolean {
  return (
    current.market?.id === intent.marketId &&
    current.tradeSelection != null &&
    tradeSelectionIntentKey(current.tradeSelection) === intent.selectionKey &&
    current.tradeAmount === intent.tradeAmount &&
    current.tradeSide === intent.tradeSide &&
    current.orderType === intent.orderType &&
    current.limitPrice === intent.limitPrice
  );
}

export function resolveTradeOrderBooks(
  market: MarketDetailType,
  tradeSelection: TradeSelection,
): {
  outcomeSets: NonNullable<ReturnType<typeof resolveOutcomeSets>>;
  selectedBook: MarketDetailType["orderBook"] | null;
  complementBook: MarketDetailType["orderBook"] | null;
} | null {
  const outcomeSets = resolveOutcomeSets(market, tradeSelection);
  if (!outcomeSets) return null;

  const bookFor = (outcomeSetId: string) =>
    market.outcomeOrderBooks?.[outcomeSetId] ??
    (outcomeSetId === outcomeSets.publicOutcomeSetId ? market.orderBook : null);

  return {
    outcomeSets,
    selectedBook: bookFor(outcomeSets.selectedOutcomeSetId),
    complementBook: bookFor(outcomeSets.complementOutcomeSetId),
  };
}

function needsEngineDetailRefresh(market: MarketDetailType): boolean {
  return market.closingDate == null || market.state == null;
}

function categoryTagIds(market: MarketDetailType): string[] {
  return market.categoryTags.map((tag) => tag.id).sort();
}

function sortedOutcomeLabels(market: MarketDetailType): string[] {
  return [...outcomeLabels(market)].sort();
}

function marketShapeMatches(current: MarketDetailType, latest: MarketDetailType): boolean {
  return (
    current.title === latest.title &&
    current.type === latest.type &&
    JSON.stringify(sortedOutcomeLabels(current)) === JSON.stringify(sortedOutcomeLabels(latest)) &&
    JSON.stringify(categoryTagIds(current)) === JSON.stringify(categoryTagIds(latest))
  );
}

export async function fetchMarketDetailWithBooks(conditionId: string): Promise<MarketDetailType> {
  let detail = await fetchMarketDetail(conditionId);
  const books = await fetchMarketOrderBooks(conditionId, detail);
  detail = {
    ...detail,
    orderBook: books.orderBook,
    outcomeOrderBooks: books.outcomeOrderBooks,
  };
  return detail;
}

async function fetchMarketOrderBooks(
  conditionId: string,
  detail: MarketDetailType,
): Promise<MarketOrderBooksLoad> {
  const outcomeSetIds = outcomeSetIdsForMarketBooks(detail);
  if (outcomeSetIds.length === 0) {
    return {
      orderBook: detail.orderBook,
      outcomeOrderBooks: detail.outcomeOrderBooks ?? {},
      fetchedOutcomeSetIds: [],
    };
  }

  const entries = (
    await Promise.all(
      outcomeSetIds.map(async (outcomeSetId) => {
        try {
          return [
            outcomeSetId,
            await fetchOrderBook(outcomeSetMarketId(conditionId, outcomeSetId)),
          ] as const;
        } catch {
          return null;
        }
      }),
    )
  ).filter((entry): entry is readonly [string, OrderBook] => entry != null);

  if (entries.length > 0) {
    const fetchedOutcomeSetIds = entries.map(([outcomeSetId]) => outcomeSetId);
    const outcomeOrderBooks = {
      ...(detail.outcomeOrderBooks ?? {}),
      ...Object.fromEntries(entries),
    };
    const defaultOrderBook = outcomeOrderBooks[outcomeSetIds[0]] ?? detail.orderBook;
    return {
      orderBook: defaultOrderBook,
      outcomeOrderBooks,
      fetchedOutcomeSetIds,
    };
  }

  return {
    orderBook: detail.orderBook,
    outcomeOrderBooks: detail.outcomeOrderBooks ?? {},
    fetchedOutcomeSetIds: [],
  };
}

export type MarketDetailDataState = {
  marketId: string | null;
  core: MarketDetailCore | null;
  confirmedTradesByConditionId: Record<string, LatestConfirmedTrade[]>;
  registeredPrimitiveOutcomeIdsByConditionId: Record<string, string[]>;
  booksByMarketId: Record<string, Record<string, OrderBook>>;
  bookSourcesByMarketId: Record<string, Record<string, CanonicalSliceSource>>;
  historiesByMarketId: Record<
    string,
    Partial<Record<ChartTimeframe, Record<string, PriceHistory>>>
  >;
  historySourcesByMarketId: Record<
    string,
    Partial<Record<ChartTimeframe, Record<string, CanonicalSliceSource>>>
  >;
  enrichmentByMarketId: Record<
    string,
    {
      comments: Comment[];
      recentTrades: Trade[];
      relatedMarkets: RelatedMarket[];
    }
  >;
};

export type MarketDetailDataAction =
  | { type: "marketSnapshotLoaded"; detail: MarketDetailType }
  | {
      type: "marketSubmitRefreshLoaded";
      detail: MarketDetailType;
      booksByOutcomeSetId: Record<string, OrderBook>;
      replaceOutcomeSetIds: string[];
    }
  | {
      type: "booksLoaded";
      marketId: string;
      booksByOutcomeSetId: Record<string, OrderBook>;
      replaceOutcomeSetIds: string[];
    }
  | {
      type: "orderBookUpdated";
      marketId: string;
      outcomeSetId: string;
      orderBook: OrderBook;
    }
  | {
      type: "historyLoaded";
      marketId: string;
      timeframe: ChartTimeframe;
      historiesByOutcomeSetId: Record<string, PriceHistory>;
    }
  | { type: "marketStatusChanged"; status: MarketStatusChanged }
  | {
      type: "confirmedTradeRecorded";
      conditionId: string;
      trade: LatestConfirmedTrade;
    }
  | { type: "commentsLoaded"; marketId: string; comments: Comment[] };

const emptyMarketDetailDataState: MarketDetailDataState = {
  marketId: null,
  core: null,
  confirmedTradesByConditionId: {},
  registeredPrimitiveOutcomeIdsByConditionId: {},
  booksByMarketId: {},
  bookSourcesByMarketId: {},
  historiesByMarketId: {},
  historySourcesByMarketId: {},
  enrichmentByMarketId: {},
};

function emptyPriceHistory(timeframe: ChartTimeframe): PriceHistory {
  return { timeframe, data: [] };
}

function emptyOrderBook(): OrderBook {
  return { bids: [], asks: [], spread: 0 };
}

function primaryOutcomeSetId(
  market: Parameters<typeof outcomeSetIdsForMarketBooks>[0],
): string | null {
  return outcomeSetIdsForMarketBooks(market)[0] ?? null;
}

function marketCoreFromDetail(detail: MarketDetailType): MarketDetailCore {
  const core = { ...detail } as Record<string, unknown>;
  delete core.priceHistory;
  delete core.orderBook;
  delete core.outcomeOrderBooks;
  delete core.outcomePriceHistories;
  delete core.comments;
  delete core.recentTrades;
  delete core.relatedMarkets;
  return core as MarketDetailCore;
}

export function booksByOutcomeSetFromDetail(
  detail: MarketDetailType,
  onlyOutcomeSetIds?: readonly string[],
): Record<string, OrderBook> {
  const result: Record<string, OrderBook> = {};
  const outcomeSetIds = onlyOutcomeSetIds ?? outcomeSetIdsForMarketBooks(detail);
  for (const [index, outcomeSetId] of outcomeSetIds.entries()) {
    const book =
      detail.outcomeOrderBooks?.[outcomeSetId] ??
      (!onlyOutcomeSetIds && index === 0 ? detail.orderBook : undefined);
    if (book) result[outcomeSetId] = book;
  }
  return result;
}

function historiesByOutcomeSetFromDetail(
  detail: MarketDetailType,
  timeframe: ChartTimeframe,
): Record<string, PriceHistory> {
  const result: Record<string, PriceHistory> = {};
  const outcomeSetIds = outcomeSetIdsForMarketBooks(detail);
  if (detail.type === "categorical") {
    for (const outcomeSetId of outcomeSetIds) {
      const history = detail.outcomePriceHistories[outcomeSetId];
      if (history?.timeframe === timeframe) result[outcomeSetId] = history;
    }
  }

  const primary = primaryOutcomeSetId(detail);
  if (primary && detail.priceHistory.timeframe === timeframe) {
    result[primary] = result[primary] ?? detail.priceHistory;
  }
  return result;
}

function historiesByOutcomeSetFromResponse(
  market: MarketDetailType,
  response: MarketPriceHistoryResponse,
): {
  timeframe: ChartTimeframe;
  historiesByOutcomeSetId: Record<string, PriceHistory>;
} {
  const withHistory = applyMarketPriceHistory(market, response);
  const timeframe = response.timeframe as ChartTimeframe;
  return {
    timeframe,
    historiesByOutcomeSetId: historiesByOutcomeSetFromDetail(withHistory, timeframe),
  };
}

function latestHistoryPrice(history: PriceHistory | undefined): number | null {
  const latest = history?.data.at(-1)?.price;
  return typeof latest === "number" && Number.isFinite(latest)
    ? Math.max(0, Math.min(100, latest))
    : null;
}

function applyLatestHistoryOdds(
  market: MarketDetailCore,
  historiesByOutcomeSetId: Record<string, PriceHistory>,
): MarketDetailCore {
  if (market.type === "yesno") {
    const primary = primaryOutcomeSetId(market);
    const yes = latestHistoryPrice(primary ? historiesByOutcomeSetId[primary] : undefined);
    if (yes == null) return market;
    return {
      ...market,
      currentOdds: {
        yes,
        no: Math.max(0, Math.min(100, 100 - yes)),
      },
    };
  }

  if (market.type === "categorical") {
    return {
      ...market,
      outcomes: market.outcomes.map((outcome) => ({
        ...outcome,
        odds:
          latestHistoryPrice(
            historiesByOutcomeSetId[outcome.label] ?? historiesByOutcomeSetId[outcome.id],
          ) ?? outcome.odds,
      })),
    };
  }

  return market;
}

function sourceMapFor<T>(
  slices: Record<string, T>,
  source: CanonicalSliceSource,
): Record<string, CanonicalSliceSource> {
  return Object.fromEntries(Object.keys(slices).map((key) => [key, source] as const));
}

function mergeBookUpdates(
  currentBooks: Record<string, OrderBook>,
  currentSources: Record<string, CanonicalSliceSource>,
  incomingBooks: Record<string, OrderBook>,
  replaceOutcomeSetIds: string[],
  source: CanonicalSliceSource,
): {
  books: Record<string, OrderBook>;
  sources: Record<string, CanonicalSliceSource>;
} {
  const books = { ...currentBooks };
  const sources = { ...currentSources };
  for (const outcomeSetId of replaceOutcomeSetIds) {
    const book = incomingBooks[outcomeSetId];
    if (!book) continue;
    if (source === "rest" && sources[outcomeSetId] === "live") continue;
    books[outcomeSetId] = book;
    sources[outcomeSetId] = source;
  }
  return { books, sources };
}

function mergePriceHistory(
  current: PriceHistory | undefined,
  incoming: PriceHistory,
  currentSource: CanonicalSliceSource | undefined,
): PriceHistory {
  if (!current) return windowPriceHistory(incoming);
  const byTimestamp = new Map<string, PricePoint>();
  const first = currentSource === "live" ? incoming.data : current.data;
  const second = currentSource === "live" ? current.data : incoming.data;
  for (const point of first) byTimestamp.set(point.timestamp, point);
  for (const point of second) byTimestamp.set(point.timestamp, point);
  return windowPriceHistory({
    timeframe: incoming.timeframe,
    data: [...byTimestamp.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
  });
}

function mergeHistoryUpdates(
  currentHistories: Record<string, PriceHistory>,
  currentSources: Record<string, CanonicalSliceSource>,
  incomingHistories: Record<string, PriceHistory>,
  source: CanonicalSliceSource,
): {
  histories: Record<string, PriceHistory>;
  sources: Record<string, CanonicalSliceSource>;
} {
  const histories = { ...currentHistories };
  const sources = { ...currentSources };
  for (const [outcomeSetId, history] of Object.entries(incomingHistories)) {
    const previousSource = sources[outcomeSetId];
    histories[outcomeSetId] = mergePriceHistory(histories[outcomeSetId], history, previousSource);
    sources[outcomeSetId] = previousSource === "live" && source === "rest" ? "live" : source;
  }
  return { histories, sources };
}

function commentsFromResponse(
  market: MarketDetailType,
  response: MarketCommentsResponse,
): Comment[] {
  return applyMarketComments(market, response).comments;
}

export function createMarketDetailDataState(detail: MarketDetailType): MarketDetailDataState {
  const booksByOutcomeSetId = booksByOutcomeSetFromDetail(detail);
  const historiesByOutcomeSetId = historiesByOutcomeSetFromDetail(
    detail,
    detail.priceHistory.timeframe,
  );
  return {
    marketId: detail.id,
    core: marketCoreFromDetail(detail),
    confirmedTradesByConditionId: {},
    registeredPrimitiveOutcomeIdsByConditionId: {
      [detail.id]: detail.registeredPrimitiveOutcomeIds ?? [],
    },
    booksByMarketId: {
      [detail.id]: booksByOutcomeSetId,
    },
    bookSourcesByMarketId: {
      [detail.id]: sourceMapFor(booksByOutcomeSetId, "snapshot"),
    },
    historiesByMarketId: {
      [detail.id]: {
        [detail.priceHistory.timeframe]: historiesByOutcomeSetId,
      },
    },
    historySourcesByMarketId: {
      [detail.id]: {
        [detail.priceHistory.timeframe]: sourceMapFor(historiesByOutcomeSetId, "snapshot"),
      },
    },
    enrichmentByMarketId: {
      [detail.id]: {
        comments: detail.comments,
        recentTrades: detail.recentTrades,
        relatedMarkets: detail.relatedMarkets,
      },
    },
  };
}

function withSnapshotLoaded(
  state: MarketDetailDataState,
  detail: MarketDetailType,
): MarketDetailDataState {
  if (!state.core || state.marketId !== detail.id) {
    return createMarketDetailDataState(detail);
  }

  const confirmedTradesByConditionId = { ...state.confirmedTradesByConditionId };
  delete confirmedTradesByConditionId[detail.id];
  const registeredPrimitiveOutcomeIdsByConditionId = {
    ...state.registeredPrimitiveOutcomeIdsByConditionId,
    [detail.id]: detail.registeredPrimitiveOutcomeIds ?? [],
  };

  return {
    ...state,
    core: marketCoreFromDetail(detail),
    confirmedTradesByConditionId,
    registeredPrimitiveOutcomeIdsByConditionId,
  };
}

export function marketDetailDataReducer(
  state: MarketDetailDataState,
  action: MarketDetailDataAction,
): MarketDetailDataState {
  switch (action.type) {
    case "marketSnapshotLoaded":
      return withSnapshotLoaded(state, action.detail);
    case "marketSubmitRefreshLoaded": {
      const next = withSnapshotLoaded(state, action.detail);
      if (next.marketId !== action.detail.id) return next;
      const currentBooks = next.booksByMarketId[action.detail.id] ?? {};
      const currentSources = next.bookSourcesByMarketId[action.detail.id] ?? {};
      const merged = mergeBookUpdates(
        currentBooks,
        currentSources,
        action.booksByOutcomeSetId,
        action.replaceOutcomeSetIds,
        "rest",
      );
      const timeframe = action.detail.priceHistory.timeframe;
      const historiesForMarket = next.historiesByMarketId[action.detail.id] ?? {};
      const historiesForTimeframe = historiesForMarket[timeframe] ?? {};
      const sourcesForMarket = next.historySourcesByMarketId[action.detail.id] ?? {};
      const sourcesForTimeframe = sourcesForMarket[timeframe] ?? {};
      const historyMerged = mergeHistoryUpdates(
        historiesForTimeframe,
        sourcesForTimeframe,
        historiesByOutcomeSetFromDetail(action.detail, timeframe),
        "rest",
      );
      return {
        ...next,
        booksByMarketId: {
          ...next.booksByMarketId,
          [action.detail.id]: merged.books,
        },
        bookSourcesByMarketId: {
          ...next.bookSourcesByMarketId,
          [action.detail.id]: merged.sources,
        },
        historiesByMarketId: {
          ...next.historiesByMarketId,
          [action.detail.id]: {
            ...historiesForMarket,
            [timeframe]: historyMerged.histories,
          },
        },
        historySourcesByMarketId: {
          ...next.historySourcesByMarketId,
          [action.detail.id]: {
            ...sourcesForMarket,
            [timeframe]: historyMerged.sources,
          },
        },
      };
    }
    case "booksLoaded": {
      if (state.marketId !== action.marketId) return state;
      const merged = mergeBookUpdates(
        state.booksByMarketId[action.marketId] ?? {},
        state.bookSourcesByMarketId[action.marketId] ?? {},
        action.booksByOutcomeSetId,
        action.replaceOutcomeSetIds,
        "rest",
      );
      return {
        ...state,
        booksByMarketId: {
          ...state.booksByMarketId,
          [action.marketId]: merged.books,
        },
        bookSourcesByMarketId: {
          ...state.bookSourcesByMarketId,
          [action.marketId]: merged.sources,
        },
      };
    }
    case "orderBookUpdated":
      if (state.marketId !== action.marketId) return state;
      return {
        ...state,
        booksByMarketId: {
          ...state.booksByMarketId,
          [action.marketId]: {
            ...(state.booksByMarketId[action.marketId] ?? {}),
            [action.outcomeSetId]: action.orderBook,
          },
        },
        bookSourcesByMarketId: {
          ...state.bookSourcesByMarketId,
          [action.marketId]: {
            ...(state.bookSourcesByMarketId[action.marketId] ?? {}),
            [action.outcomeSetId]: "live",
          },
        },
      };
    case "historyLoaded": {
      if (state.marketId !== action.marketId) return state;
      const historiesForMarket = state.historiesByMarketId[action.marketId] ?? {};
      const historiesForTimeframe = historiesForMarket[action.timeframe] ?? {};
      const sourcesForMarket = state.historySourcesByMarketId[action.marketId] ?? {};
      const sourcesForTimeframe = sourcesForMarket[action.timeframe] ?? {};
      const merged = mergeHistoryUpdates(
        historiesForTimeframe,
        sourcesForTimeframe,
        action.historiesByOutcomeSetId,
        "rest",
      );
      return {
        ...state,
        historiesByMarketId: {
          ...state.historiesByMarketId,
          [action.marketId]: {
            ...historiesForMarket,
            [action.timeframe]: merged.histories,
          },
        },
        historySourcesByMarketId: {
          ...state.historySourcesByMarketId,
          [action.marketId]: {
            ...sourcesForMarket,
            [action.timeframe]: merged.sources,
          },
        },
      };
    }
    case "marketStatusChanged": {
      const core = state.core;
      if (!core || core.id !== action.status.conditionId) return state;
      return {
        ...state,
        core: {
          ...core,
          state: action.status.state,
          resolution: {
            ...core.resolution,
            ...(action.status.finalOutcome ? { finalOutcome: action.status.finalOutcome } : {}),
          },
        } as MarketDetailCore,
      };
    }
    case "confirmedTradeRecorded": {
      if (state.marketId !== action.conditionId) return state;
      const current = state.confirmedTradesByConditionId[action.conditionId] ?? [];
      const allowedPrimitiveOutcomeIds =
        state.registeredPrimitiveOutcomeIdsByConditionId[action.conditionId] ?? [];
      const next = applyConfirmedTradeDelta(
        action.conditionId,
        allowedPrimitiveOutcomeIds,
        current,
        {
          conditionId: action.conditionId,
          latestConfirmedTrade: action.trade,
        },
      );
      return {
        ...state,
        confirmedTradesByConditionId: {
          ...state.confirmedTradesByConditionId,
          [action.conditionId]: next,
        },
      };
    }
    case "commentsLoaded":
      if (state.marketId !== action.marketId) return state;
      {
        const current = state.enrichmentByMarketId[action.marketId] ?? {
          comments: [],
          recentTrades: [],
          relatedMarkets: [],
        };
        return {
          ...state,
          enrichmentByMarketId: {
            ...state.enrichmentByMarketId,
            [action.marketId]: {
              ...current,
              comments: action.comments,
            },
          },
        };
      }
    default:
      return assertNever(action);
  }
}

export function composeMarketDetail(
  state: MarketDetailDataState,
  timeframe: ChartTimeframe,
): MarketDetailType | null {
  const core = state.core;
  if (!core) return null;

  const primary = primaryOutcomeSetId(core);
  const historiesForTimeframe = state.historiesByMarketId[core.id]?.[timeframe] ?? {};
  const fallbackHistory = emptyPriceHistory(timeframe);
  const priceHistory = (primary ? historiesForTimeframe[primary] : undefined) ?? fallbackHistory;
  const booksByOutcomeSetId = state.booksByMarketId[core.id] ?? {};
  const oddsAlignedCore = applyLatestHistoryOdds(core, historiesForTimeframe);
  const enrichment = state.enrichmentByMarketId[core.id] ?? {
    comments: [],
    recentTrades: [],
    relatedMarkets: [],
  };
  const orderBook = (primary ? booksByOutcomeSetId[primary] : undefined) ?? emptyOrderBook();
  const base = {
    ...oddsAlignedCore,
    priceHistory,
    orderBook,
    outcomeOrderBooks: booksByOutcomeSetId,
    comments: enrichment.comments,
    recentTrades: enrichment.recentTrades,
    relatedMarkets: enrichment.relatedMarkets,
  };

  if (core.type === "categorical") {
    const categoricalCore = oddsAlignedCore as Extract<MarketDetailType, { type: "categorical" }>;
    return {
      ...base,
      type: "categorical",
      outcomes: categoricalCore.outcomes,
      outcomePriceHistories: historiesForTimeframe,
      outcomeOrderBooks: base.outcomeOrderBooks,
    };
  }

  return base as MarketDetailType;
}

export function MarketDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const setupComplete = useWalletStore((s) => s.setupComplete);
  const walletBackupState = useWalletStore((s) => s.walletBackupState);
  const activeMintUrl = useWalletStore((s) => s.activeMintUrl);
  const addPendingTrade = usePendingTradesStore((s) => s.add);
  const nostrSignerMode = useSettingsStore((s) => s.nostrSignerMode);
  const signerBackupState = useSettingsStore((s) => s.signerBackupState);
  // Display-only mint fee for the trade cost preview. Read from the
  // `input_fee_ppk` the active mint already advertises on its cached keysets
  // (no extra mint round-trip). 0 for the first-release bitCaster mint config,
  // so the panel shows a static "Mint fee: 0 sats".
  const activeMintInputFeePpk = useActiveMintInputFeePpk(activeMintUrl);

  // Data state
  const [marketData, dispatchMarketData] = useReducer(
    marketDetailDataReducer,
    emptyMarketDetailDataState,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // UI state
  const [chartTimeframe, setChartTimeframe] = useState<ChartTimeframe>("7d");
  const market = useMemo(
    () => composeMarketDetail(marketData, chartTimeframe),
    [marketData, chartTimeframe],
  );
  const marketBaseAsset = market ? normalizeMarketBaseAsset(market.baseAsset) : "sat";
  const [tradeSelection, setTradeSelection] = useState<TradeSelection | null>(null);
  const [tradeAmount, setTradeAmount] = useState(0);
  const [tradeSide, setTradeSide] = useState<TradeSide>("Buy");
  const [orderType, setOrderType] = useState<OrderType>("market");
  const [limitPrice, setLimitPrice] = useState(() =>
    defaultLimitPriceForDivisibility(10_000, "sat"),
  );
  const [priceManuallyEdited, setPriceManuallyEdited] = useState(false);
  const [tradeSubmitStatus, setTradeSubmitStatus] = useState<{
    kind: "info" | "success" | "error";
    message: string;
  } | null>(null);
  const [tradeFeasibility, setTradeFeasibility] = useState<{
    canBack: boolean;
    reason?: "funds" | "outcome-tokens";
    message?: string;
  } | null>(null);
  const [isTradeSubmitting, setIsTradeSubmitting] = useState(false);
  const [rangeFeePreview, setRangeFeePreview] = useState<{
    key: string;
    consolidationFeeSubunits: number;
  } | null>(null);
  const tradeSubmitInFlightRef = useRef(false);

  // Top-up flow state — surfaced only when the user tries to confirm a trade
  // they can't afford. `balanceAtCheck` is the snapshot taken when the gate
  // tripped, so the modal / overlay keep showing the user's real deficit even
  // if the wallet balance changes live while they decide.
  const [topUpStage, setTopUpStage] = useState<TopUpStage>("closed");
  const [topUpReason, setTopUpReason] = useState<TopUpReason | null>(null);
  const [balanceAtCheck, setBalanceAtCheck] = useState(0);
  const [showNostrAuthModal, setShowNostrAuthModal] = useState(false);
  const [showNostrChooser, setShowNostrChooser] = useState(false);
  const [lazySetupError, setLazySetupError] = useState<string | null>(null);
  const [lazySetupCreating, setLazySetupCreating] = useState(false);
  const [showBackupReminder, setShowBackupReminder] = useState(false);
  const [showFundedActionBackupPrompt, setShowFundedActionBackupPrompt] = useState(false);
  const [engineScoreFeeSats, setEngineScoreFeeSats] = useState<number | null>(null);
  const [pendingTopUpComment, setPendingTopUpComment] = useState<string | undefined>();
  const [pendingTopUpIntent, setPendingTopUpIntent] = useState<PendingTopUpOrderIntent | null>(
    null,
  );
  const [lazySetupComment, setLazySetupComment] = useState<string | undefined>();
  const walletReady = setupComplete && nostrSignerMode !== "none";

  // Load market data
  const loadMarket = useCallback(
    (options: { showLoading?: boolean } = {}) => {
      if (!id) return;
      const showLoading = options.showLoading ?? true;
      if (showLoading) setLoading(true);
      setError(null);

      fetchMarketDetail(id)
        .then((detail) => {
          dispatchMarketData({ type: "marketSnapshotLoaded", detail });
          void fetchMarketOrderBooks(id, detail).then((books) => {
            const detailWithBooks = {
              ...detail,
              orderBook: books.orderBook,
              outcomeOrderBooks: books.outcomeOrderBooks,
            };
            dispatchMarketData({
              type: "booksLoaded",
              marketId: id,
              booksByOutcomeSetId: booksByOutcomeSetFromDetail(
                detailWithBooks,
                books.fetchedOutcomeSetIds,
              ),
              replaceOutcomeSetIds: books.fetchedOutcomeSetIds,
            });
          });
        })
        .catch(() => {
          setError("Failed to load market. Please check that the mint is running.");
        })
        .finally(() => {
          if (showLoading) setLoading(false);
        });
    },
    [id],
  );

  // Secondary live close-detection: subscribe to MarketStatusChanged pushes
  // while this detail page is mounted and joined to at least one per-outcome
  // market hub group. This is best-effort detail-page UX only: apply the pushed
  // state immediately, then reconcile via the catalogue as the correctness
  // fallback. Do not add list-page joins or polling for lifecycle changes.
  const handleLiveStatus = useCallback(
    (status: MarketStatusChanged) => {
      dispatchMarketData({ type: "marketStatusChanged", status });
      loadMarket({ showLoading: false });
    },
    [loadMarket],
  );
  useMarketStatusLive(market?.id ?? null, handleLiveStatus);

  useEffect(() => {
    if (!id || !market) return;
    const outcomeSetIds = outcomeSetIdsForMarketBooks(market).slice(0, 8);
    if (outcomeSetIds.length === 0) return;

    let cancelled = false;
    const cleanups: Array<() => void> = [];

    const reconcileOwnOrders = debounce(() => {
      void new BitcasterEngineClient({
        baseUrl: window.location.origin,
        authorization: ({ url, method }) => generateNip98Header(url, method),
      })
        .listMyOrders(id)
        .catch((err) => {
          console.warn("[MarketDetailPage] own-order reconciliation failed:", err);
        });
    }, 200);
    reconcileOwnOrders();
    cleanups.push(reconcileOwnOrders.cancel);

    // SignalR is a best-effort delta channel. Reconnect repair must go
    // through the existing condition-authoritative REST read, once for the
    // page, before the live order-book refreshes are applied.
    const refreshAuthoritativeMarket = debounce(() => {
      loadMarket({ showLoading: false });
    }, 200);
    cleanups.push(refreshAuthoritativeMarket.cancel);

    cleanups.push(
      onConfirmedTradeRecorded(id, (message) => {
        if (cancelled || message.conditionId !== id) return;
        dispatchMarketData({
          type: "confirmedTradeRecorded",
          conditionId: id,
          trade: message.latestConfirmedTrade,
        });
      }),
    );

    for (const outcomeSetId of outcomeSetIds) {
      const liveMarketId = outcomeSetMarketId(id, outcomeSetId);
      const refreshLiveOrderBook = debounce(() => {
        void refreshOrderBook(liveMarketId)
          .then((orderBook) => {
            if (cancelled) return;
            dispatchMarketData({
              type: "orderBookUpdated",
              marketId: id,
              outcomeSetId,
              orderBook,
            });
          })
          .catch((err) => {
            console.warn("[MarketDetailPage] order-book refresh failed:", err);
          });
      }, ORDER_BOOK_REFRESH_DEBOUNCE_MS);
      cleanups.push(refreshLiveOrderBook.cancel);
      cleanups.push(
        onOrderBookUpdated(liveMarketId, (snapshot) => {
          if (cancelled) return;
          refreshLiveOrderBook.cancel();
          const liveBook = mapSnapshotToOrderBook(snapshot);
          dispatchMarketData({
            type: "orderBookUpdated",
            marketId: id,
            outcomeSetId,
            orderBook: liveBook,
          });
        }),
      );
      cleanups.push(
        onOrderCancelled(liveMarketId, () => {
          if (cancelled) return;
          refreshLiveOrderBook();
          reconcileOwnOrders();
        }),
      );
      cleanups.push(
        onMarketRejoined(liveMarketId, () => {
          refreshAuthoritativeMarket();
          refreshLiveOrderBook();
          reconcileOwnOrders();
        }),
      );
      void joinMarket(liveMarketId).catch((err) => {
        console.warn("[MarketDetailPage] joinMarket failed:", err);
      });
    }

    return () => {
      cancelled = true;
      for (const cleanup of cleanups) cleanup();
      for (const outcomeSetId of outcomeSetIds) {
        void leaveMarket(outcomeSetMarketId(id, outcomeSetId));
      }
    };
  }, [id, loadMarket, market?.id]);

  useEffect(() => {
    loadMarket();
  }, [loadMarket]);

  useEffect(() => {
    if (!id || !market || !needsEngineDetailRefresh(market)) return;

    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 10;
    let timeoutId: number | null = null;

    const refresh = async () => {
      attempts += 1;
      try {
        const latestDetail = await fetchMarketDetail(id);
        const books = await fetchMarketOrderBooks(id, latestDetail);
        const latest = {
          ...latestDetail,
          orderBook: books.orderBook,
          outcomeOrderBooks: books.outcomeOrderBooks,
        };
        if (cancelled) return;
        if (!marketShapeMatches(market, latest)) return;
        const unchangedPartialSnapshot =
          market.closingDate === latest.closingDate &&
          market.state === latest.state &&
          needsEngineDetailRefresh(latest);
        if (!unchangedPartialSnapshot) {
          dispatchMarketData({
            type: "marketSubmitRefreshLoaded",
            detail: latest,
            booksByOutcomeSetId: booksByOutcomeSetFromDetail(latest, books.fetchedOutcomeSetIds),
            replaceOutcomeSetIds: books.fetchedOutcomeSetIds,
          });
        }
        if (!needsEngineDetailRefresh(latest) || attempts >= maxAttempts) {
          return;
        }
      } catch {
        if (attempts >= maxAttempts) return;
      }

      if (!cancelled) {
        timeoutId = window.setTimeout(refresh, 2_000);
      }
    };

    timeoutId = window.setTimeout(refresh, 2_000);
    return () => {
      cancelled = true;
      if (timeoutId != null) window.clearTimeout(timeoutId);
    };
  }, [id, market?.id, market?.closingDate, market?.state]);

  useEffect(() => {
    if (!market?.id) return;
    let cancelled = false;
    const loadHistory = async () => {
      try {
        const history = await fetchMarketPriceHistory(market.id, chartTimeframe);
        if (!cancelled) {
          const { timeframe, historiesByOutcomeSetId } = historiesByOutcomeSetFromResponse(
            market,
            history,
          );
          dispatchMarketData({
            type: "historyLoaded",
            marketId: market.id,
            timeframe,
            historiesByOutcomeSetId,
          });
        }
      } catch {
        // Chart history is non-critical; keep the primary market UI visible.
      }
    };
    loadHistory();
    return () => {
      cancelled = true;
    };
  }, [market?.id, chartTimeframe]);

  useEffect(() => {
    if (!market?.id) return;
    let cancelled = false;
    const loadComments = async () => {
      try {
        const comments = await fetchMarketComments(market.id);
        if (!cancelled) {
          dispatchMarketData({
            type: "commentsLoaded",
            marketId: market.id,
            comments: commentsFromResponse(market, comments),
          });
        }
      } catch {
        // Comments are non-blocking for the trading surface.
      }
    };
    loadComments();
    return () => {
      cancelled = true;
    };
  }, [market?.id]);

  useEffect(() => {
    if (!walletReady) {
      setEngineScoreFeeSats(null);
      return;
    }

    let cancelled = false;
    getParticipationScore()
      .then((score) => {
        if (!cancelled) {
          setEngineScoreFeeSats(score.enabled ? score.matchDebitScore : 0);
        }
      })
      .catch(() => {
        if (!cancelled) setEngineScoreFeeSats(null);
      });

    return () => {
      cancelled = true;
    };
  }, [walletReady]);

  const marketDivisibility = market
    ? normalizeMarketDivisibility(market.divisibility, marketBaseAsset)
    : 10_000;
  const priceOutcomeSetId = useMemo(() => {
    if (!market) return null;
    if (tradeSelection) {
      return (
        resolveOutcomeSets(market, tradeSelection)?.selectedOutcomeSetId ??
        primaryOutcomeSetId(market)
      );
    }
    return primaryOutcomeSetId(market);
  }, [market, tradeSelection]);
  const priceOrderBook = useMemo(() => {
    if (!market || !priceOutcomeSetId) return null;
    const primary = primaryOutcomeSetId(market);
    return (
      market.outcomeOrderBooks?.[priceOutcomeSetId] ??
      (priceOutcomeSetId === primary ? market.orderBook : null)
    );
  }, [market, priceOutcomeSetId]);
  const marketPrice = useMarketPrice({
    market,
    marketId: market && priceOutcomeSetId ? outcomeSetMarketId(market.id, priceOutcomeSetId) : null,
    outcomeSetId: priceOutcomeSetId,
    orderBook: priceOrderBook,
  });

  useEffect(() => {
    setPriceManuallyEdited(false);
  }, [market?.id, priceOutcomeSetId]);

  useEffect(() => {
    if (priceManuallyEdited) return;
    setLimitPrice(marketPrice.defaultOrderPrice);
  }, [marketPrice.defaultOrderPrice, priceManuallyEdited]);

  const handleLimitPriceChange = useCallback((price: number) => {
    setPriceManuallyEdited(true);
    setLimitPrice(price);
  }, []);

  const tradeFaceAmountSubunits = displaySharesToFaceSubunits(
    tradeAmount,
    marketBaseAsset,
    marketDivisibility,
  );

  const currentTradeTicket = useMemo(() => {
    if (!market || !tradeSelection || tradeAmount <= 0) return null;
    try {
      const tradeBooks = resolveTradeOrderBooks(market, tradeSelection);
      if (!tradeBooks) return null;
      return buildTradeTicket({
        market,
        selection: tradeSelection,
        amountSubunits: tradeFaceAmountSubunits,
        side: tradeSide,
        orderType,
        limitPrice,
        orderBook: tradeBooks.selectedBook,
        complementaryOrderBook: tradeBooks.complementBook,
      });
    } catch {
      return null;
    }
  }, [
    market,
    tradeSelection,
    tradeAmount,
    tradeFaceAmountSubunits,
    tradeSide,
    orderType,
    limitPrice,
  ]);
  const rangeFeePreviewKey = useMemo(
    () =>
      currentTradeTicket && activeMintUrl
        ? JSON.stringify({
            conditionId: market?.id,
            mintUrl: activeMintUrl,
            ticket: currentTradeTicket,
          })
        : null,
    [activeMintUrl, currentTradeTicket, market?.id],
  );
  const displayedConsolidationFee =
    rangeFeePreviewKey !== null && rangeFeePreview?.key === rangeFeePreviewKey
      ? rangeFeePreview.consolidationFeeSubunits
      : 0;

  // Computed trade preview (market orders). `tradeAmount` is the user-entered
  // whole-share count; the wire face amount is derived only at protocol
  // boundaries.
  const tradePreview = useMemo<TradePreview | null>(() => {
    if (!tradeSelection || !tradeAmount || tradeAmount <= 0 || !market) return null;
    if (orderType === "limit") return null;

    const tradeBooks = resolveTradeOrderBooks(market, tradeSelection);
    const selectedBook = tradeBooks?.selectedBook ?? null;
    const quotePreview = computeMarketOrderQuotePreview({
      displayShares: tradeAmount,
      tradeSide,
      orderBook: selectedBook,
      complementaryOrderBook: tradeBooks?.complementBook ?? null,
      baseAsset: marketBaseAsset,
      divisibility: marketDivisibility,
    });
    if (!quotePreview) {
      return {
        amount: tradeAmount,
        predictedOdds: 0,
        priceImpact: 0,
        averageExecutionPrice: undefined,
        executableShares: 0,
        hasExecutableLiquidity: false,
        quoteSubunits: 0,
        mintFee: 0,
        potentialPayout: 0,
        creatorFee: 0,
        engineScoreFeeSats,
        totalCost: 0,
      };
    }

    const cost = computeTradeCost({
      displayShares: quotePreview.executableDisplayShares,
      price: quotePreview.averageExecutionPrice,
      feePercent: market.creator.feePercent,
      mintInputFeePpk: activeMintInputFeePpk,
      baseAsset: marketBaseAsset,
      divisibility: marketDivisibility,
    });
    const predictedOdds = Math.max(
      0,
      Math.min(100, (quotePreview.averageExecutionPrice / marketDivisibility) * 100),
    );
    return {
      amount: tradeAmount,
      predictedOdds,
      priceImpact: 0,
      averageExecutionPrice: quotePreview.averageExecutionPrice,
      executableShares: quotePreview.executableDisplayShares,
      hasExecutableLiquidity: true,
      quoteSubunits: cost.quoteSubunits,
      mintFee: cost.mintFee + displayedConsolidationFee,
      potentialPayout: quotePreview.filledFaceSubunits,
      creatorFee: cost.creatorFee,
      engineScoreFeeSats,
      totalCost: cost.totalCost + displayedConsolidationFee,
    };
  }, [
    tradeSelection,
    tradeAmount,
    tradeSide,
    market,
    orderType,
    activeMintInputFeePpk,
    marketBaseAsset,
    marketDivisibility,
    tradeFaceAmountSubunits,
    engineScoreFeeSats,
    displayedConsolidationFee,
  ]);

  // Computed limit order preview.
  //
  // The displayed quote is whole shares × limit price.
  const limitOrderPreview = useMemo<LimitOrderPreview | null>(() => {
    if (!tradeSelection || !tradeAmount || tradeAmount <= 0 || !market) return null;
    if (orderType !== "limit") return null;

    const cost = computeTradeCost({
      displayShares: tradeAmount,
      price: limitPrice,
      feePercent: market.creator.feePercent,
      mintInputFeePpk: activeMintInputFeePpk,
      baseAsset: marketBaseAsset,
      divisibility: marketDivisibility,
    });
    return {
      limitPrice,
      amount: tradeAmount,
      sharesIfFilled: tradeAmount,
      quoteSubunits: cost.quoteSubunits,
      creatorFee: cost.creatorFee,
      mintFee: cost.mintFee + displayedConsolidationFee,
      engineScoreFeeSats,
      potentialPayout: tradeFaceAmountSubunits,
      totalCost: cost.totalCost + displayedConsolidationFee,
    };
  }, [
    tradeSelection,
    tradeAmount,
    market,
    orderType,
    limitPrice,
    activeMintInputFeePpk,
    marketBaseAsset,
    marketDivisibility,
    tradeFaceAmountSubunits,
    engineScoreFeeSats,
    displayedConsolidationFee,
  ]);

  useEffect(() => {
    if (
      !walletReady ||
      !activeMintUrl ||
      !market ||
      !tradeSelection ||
      tradeAmount <= 0 ||
      !currentTradeTicket ||
      !rangeFeePreviewKey
    ) {
      setTradeFeasibility(null);
      return;
    }

    let cancelled = false;
    const evaluate = async () => {
      try {
        const holdings = await buildIndexedDbTokenHoldings({
          mintUrl: activeMintUrl ?? undefined,
          conditionId: market.id,
          baseAsset: market.baseAsset,
        });
        if (cancelled) return;
        const canBack = canBackOrder(
          {
            side: tradeSide === "Buy" ? "bid" : "ask",
            sizeSubunits: currentTradeTicket.request.amountSubunits,
            shareFaceSubunits: marketDivisibility,
          },
          holdings,
          {},
          marketDivisibility,
        ).canBack;
        if (canBack) {
          const feePreview = await previewBrowserCtfRangeOrderFees({
            market,
            ticket: currentTradeTicket,
            mintUrl: activeMintUrl,
          });
          if (cancelled) return;
          setRangeFeePreview({
            key: rangeFeePreviewKey,
            consolidationFeeSubunits: feePreview.consolidationFeeSubunits,
          });
          setTradeFeasibility({ canBack: true });
          return;
        }
        setTradeFeasibility({
          canBack: false,
          reason: tradeSide === "Sell" ? "outcome-tokens" : "funds",
          message: tradeSide === "Sell" ? "Insufficient outcome tokens" : "Insufficient funds",
        });
      } catch {
        if (!cancelled) setTradeFeasibility(null);
      }
    };
    void evaluate();
    return () => {
      cancelled = true;
    };
  }, [
    walletReady,
    activeMintUrl,
    market,
    tradeSelection,
    tradeAmount,
    marketDivisibility,
    currentTradeTicket,
    rangeFeePreviewKey,
  ]);

  // Submit the order. Assumes wallet is set up and balance has been checked —
  // callers that can't promise that must route through `handleTradeConfirm`.
  const placeOrder = useCallback(
    async (comment?: string) => {
      if (!market || !tradeSelection || !tradeAmount) return;
      try {
        assertMarketAcceptsOrders(market);
      } catch (error) {
        setTradeSubmitStatus({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "This market is closed and no longer accepts orders.",
        });
        return;
      }
      if (tradeSubmitInFlightRef.current) return;
      tradeSubmitInFlightRef.current = true;
      setIsTradeSubmitting(true);
      setTradeSubmitStatus(null);

      let latestMarket: MarketDetailType;
      try {
        const latestDetail = await fetchMarketDetail(market.id);
        const books = await fetchMarketOrderBooks(market.id, latestDetail);
        latestMarket = {
          ...latestDetail,
          orderBook: books.orderBook,
          outcomeOrderBooks: books.outcomeOrderBooks,
        };
        dispatchMarketData({
          type: "marketSubmitRefreshLoaded",
          detail: latestMarket,
          booksByOutcomeSetId: booksByOutcomeSetFromDetail(
            latestMarket,
            books.fetchedOutcomeSetIds,
          ),
          replaceOutcomeSetIds: books.fetchedOutcomeSetIds,
        });
      } catch {
        setTradeSubmitStatus({
          kind: "error",
          message: "Could not refresh market status before submitting the order.",
        });
        tradeSubmitInFlightRef.current = false;
        setIsTradeSubmitting(false);
        return;
      }
      if (isClosedForTrading(latestMarket)) {
        setTradeSubmitStatus({
          kind: "error",
          message: "This market is closed and no longer accepts orders.",
        });
        tradeSubmitInFlightRef.current = false;
        setIsTradeSubmitting(false);
        return;
      }
      if (!marketShapeMatches(market, latestMarket)) {
        setTradeSubmitStatus({
          kind: "error",
          message: "Market metadata changed before submission. Review the market and try again.",
        });
        tradeSubmitInFlightRef.current = false;
        setIsTradeSubmitting(false);
        return;
      }

      let ticket: ReturnType<typeof buildTradeTicket>;
      try {
        const tradeBooks = resolveTradeOrderBooks(latestMarket, tradeSelection);
        if (!tradeBooks) {
          throw new TradeTicketError(
            "missing-selection",
            "Choose an outcome before placing an order.",
          );
        }
        ticket = buildTradeTicket({
          market: latestMarket,
          selection: tradeSelection,
          amountSubunits: displaySharesToFaceSubunits(
            tradeAmount,
            latestMarket.baseAsset,
            normalizeMarketDivisibility(latestMarket.divisibility, latestMarket.baseAsset),
          ),
          side: tradeSide,
          orderType,
          limitPrice,
          orderBook: tradeBooks.selectedBook,
          complementaryOrderBook: tradeBooks.complementBook,
        });
      } catch (e) {
        const message =
          e instanceof TradeTicketError ? e.message : "This order cannot be submitted yet.";
        setTradeSubmitStatus({ kind: "info", message });
        tradeSubmitInFlightRef.current = false;
        setIsTradeSubmitting(false);
        return;
      }

      const clientOrderId = crypto.randomUUID();
      try {
        const signedComment = comment?.trim()
          ? await signTradeComment(latestMarket.id, comment.trim())
          : undefined;
        const walletState = useWalletStore.getState();
        if (!activeMintUrl) throw new Error("The active mint is unavailable.");
        const exactFeePreviewKey = JSON.stringify({
          conditionId: latestMarket.id,
          mintUrl: activeMintUrl,
          ticket,
        });
        let expectedConsolidationFeeSubunits =
          rangeFeePreview?.key === exactFeePreviewKey
            ? rangeFeePreview.consolidationFeeSubunits
            : null;
        if (expectedConsolidationFeeSubunits === null) {
          const feePreview = await previewBrowserCtfRangeOrderFees({
            market: latestMarket,
            ticket,
            mintUrl: activeMintUrl,
          });
          expectedConsolidationFeeSubunits = feePreview.consolidationFeeSubunits;
          setRangeFeePreview({
            key: exactFeePreviewKey,
            consolidationFeeSubunits: expectedConsolidationFeeSubunits,
          });
          if (expectedConsolidationFeeSubunits > 0) {
            throw new Error("Wallet proof fees changed. Review the updated trade cost and retry.");
          }
        }
        const response = await submitBrowserCtfRangeOrder({
          market: latestMarket,
          ticket,
          clientOrderId,
          mintUrl: activeMintUrl,
          mnemonic: walletState.mnemonic,
          comment: signedComment ?? null,
          expectedConsolidationFeeSubunits,
        });
        const acceptedBaseAsset = normalizeMarketBaseAsset(response.baseAsset);
        const acceptedDivisibility = normalizeMarketDivisibility(
          response.divisibility,
          acceptedBaseAsset,
        );
        // Only persist the privkey once the engine has accepted the order.
        // Otherwise we accumulate orphaned keys on every failed submission.
        addPendingTrade({
          orderId: response.orderId,
          marketId: ticket.marketId,
          clientOrderId,
          baseAsset: acceptedBaseAsset,
          divisibility: acceptedDivisibility,
          side: ticket.request.side,
          tokenSide: ticket.request.tokenSide,
          priceSubunits: ticket.request.price,
          amountSubunits: ticket.request.amountSubunits,
          submittedAt: Date.now(),
        });
        addOrderSubmitNotifications({
          add: useNotificationsStore.getState().add,
          orderId: response.orderId,
          marketId: ticket.marketId,
          requestedAmountSubunits: ticket.request.amountSubunits,
          remainingAmountSubunits: response.remainingAmountSubunits,
          fillCount: response.fills?.length ?? 0,
          status: response.status,
        });
        setTradeSelection(null);
        setTradeAmount(0);
        setTradeSubmitStatus({
          kind: "success",
          message:
            response.status === "resting"
              ? "Order posted to the book."
              : `Order ${response.status.replace("_", " ")}.`,
        });
        if (
          useWalletStore.getState().walletBackupState === "needs_backup" ||
          useSettingsStore.getState().signerBackupState === "needs_backup"
        ) {
          setShowBackupReminder(true);
        }
        loadMarket({ showLoading: false });
      } catch (e) {
        if (e instanceof Error && e.message.includes("No Nostr signer configured")) {
          setShowNostrAuthModal(true);
          return;
        }
        setTradeSubmitStatus({
          kind: "error",
          message: e instanceof Error ? e.message : "Failed to submit order.",
        });
      } finally {
        tradeSubmitInFlightRef.current = false;
        setIsTradeSubmitting(false);
      }
    },
    [
      market,
      tradeSelection,
      tradeAmount,
      tradeSide,
      orderType,
      limitPrice,
      activeMintUrl,
      loadMarket,
      addPendingTrade,
      rangeFeePreview,
    ],
  );

  // Gate the order submission on sufficient balance. Reads the balance at
  // click-time (not via `useBalance`) so we don't race a stale live-query
  // subscription after a top-up.
  const handleTradeConfirm = useCallback(
    async (comment?: string) => {
      if (!market || !tradeSelection || !tradeAmount) return;
      if (shouldPromptForFundedActionBackup(useWalletStore.getState().walletBackupState)) {
        setShowFundedActionBackupPrompt(true);
        return;
      }
      try {
        assertMarketAcceptsOrders(market);
      } catch (error) {
        setTradeSubmitStatus({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "This market is closed and no longer accepts orders.",
        });
        return;
      }
      if (tradeSubmitInFlightRef.current) return;
      tradeSubmitInFlightRef.current = true;
      setIsTradeSubmitting(true);
      try {
        const tradeBooks = resolveTradeOrderBooks(market, tradeSelection);
        if (!tradeBooks) {
          throw new TradeTicketError(
            "missing-selection",
            "Choose an outcome before placing an order.",
          );
        }
        const ticket = buildTradeTicket({
          market,
          selection: tradeSelection,
          amountSubunits: tradeFaceAmountSubunits,
          side: tradeSide,
          orderType,
          limitPrice,
          orderBook: tradeBooks.selectedBook,
          complementaryOrderBook: tradeBooks.complementBook,
        });
        const holdings = await buildIndexedDbTokenHoldings({
          mintUrl: activeMintUrl ?? undefined,
          conditionId: market.id,
          baseAsset: market.baseAsset,
        });
        const backing = canBackOrder(
          {
            side: tradeSide === "Buy" ? "bid" : "ask",
            sizeSubunits: ticket.request.amountSubunits,
            shareFaceSubunits: marketDivisibility,
          },
          holdings,
          {},
          marketDivisibility,
        );
        const current =
          tradeSide === "Sell"
            ? backing.maxShares * marketDivisibility
            : await getBalance(activeMintUrl, { baseAsset: marketBaseAsset });
        const collateralGate = decideTradeCollateralGate({
          balance: backing.canBack ? tradeFaceAmountSubunits : current,
          tradeFaceAmountSubunits,
        });
        if (collateralGate.kind === "top-up") {
          setBalanceAtCheck(collateralGate.balance);
          setPendingTopUpComment(comment?.trim() || undefined);
          setPendingTopUpIntent(
            buildPendingTopUpOrderIntent({
              market,
              tradeSelection,
              tradeAmount,
              tradeSide,
              orderType,
              limitPrice,
              comment,
              baseAsset: marketBaseAsset,
              required: collateralGate.required,
            }),
          );
          setTopUpReason({
            kind: "collateral",
            required: collateralGate.required,
            baseAsset: marketBaseAsset,
          });
          setTopUpStage("modal");
          return;
        }
        const score = await ensureParticipationScoreForNextMatch({
          mintUrl: activeMintUrl,
        });
        if (score.kind === "needs-regular-top-up") {
          setBalanceAtCheck(score.balanceSats);
          setPendingTopUpComment(comment?.trim() || undefined);
          setPendingTopUpIntent(
            buildPendingTopUpOrderIntent({
              market,
              tradeSelection,
              tradeAmount,
              tradeSide,
              orderType,
              limitPrice,
              comment,
              baseAsset: "sat",
              required: score.requiredSats,
            }),
          );
          setTopUpReason({
            kind: "score",
            required: score.requiredSats,
          });
          setTopUpStage("modal");
          return;
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("No Nostr signer configured")) {
          setShowNostrAuthModal(true);
          return;
        }
        setTradeSubmitStatus({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not check wallet balance before submitting the order.",
        });
        return;
      } finally {
        tradeSubmitInFlightRef.current = false;
        setIsTradeSubmitting(false);
      }
      await placeOrder(comment);
    },
    [
      market,
      marketBaseAsset,
      tradeSelection,
      tradeAmount,
      tradeFaceAmountSubunits,
      tradeSide,
      activeMintUrl,
      marketDivisibility,
      orderType,
      limitPrice,
      placeOrder,
    ],
  );

  const handleWalletRequired = useCallback(
    async (comment?: string) => {
      if (market) {
        try {
          assertMarketAcceptsOrders(market);
        } catch (error) {
          setTradeSubmitStatus({
            kind: "error",
            message:
              error instanceof Error
                ? error.message
                : "This market is closed and no longer accepts orders.",
          });
          return;
        }
      }
      setLazySetupError(null);
      if (nostrSignerMode === "none") {
        setLazySetupComment(comment?.trim() || undefined);
        setShowNostrChooser(true);
        return;
      }
      setLazySetupCreating(true);
      const result = await createImplicitWalletAndNostrIdentity();
      setLazySetupCreating(false);
      if (!result.ok) {
        setLazySetupError(result.error ?? "Could not create wallet");
        setShowNostrChooser(true);
        return;
      }
      await handleTradeConfirm(comment);
    },
    [handleTradeConfirm, market, nostrSignerMode],
  );

  const handleCreateImplicitAccount = useCallback(async () => {
    setLazySetupCreating(true);
    setLazySetupError(null);
    const result = await createImplicitWalletAndNostrIdentity();
    setLazySetupCreating(false);
    if (!result.ok) {
      setLazySetupError(result.error ?? "Could not create wallet");
      return;
    }
    setShowNostrChooser(false);
    const comment = lazySetupComment;
    setLazySetupComment(undefined);
    await handleTradeConfirm(comment);
  }, [handleTradeConfirm, lazySetupComment]);

  // After a successful top-up, close the overlay and place the order once, but
  // only if the wallet proof store now confirms the exact unit/amount captured
  // when the user first clicked Buy. If the market/selection/amount changed
  // while the interstitial was open, require a fresh confirmation instead of
  // auto-executing a stale intent.
  const handleTopUpSuccess = useCallback(async () => {
    const intent = pendingTopUpIntent;
    setTopUpStage("closed");
    setTopUpReason(null);
    setPendingTopUpIntent(null);
    setPendingTopUpComment(undefined);
    if (!intent) return;
    if (
      !pendingTopUpOrderIntentMatches(intent, {
        market,
        tradeSelection,
        tradeAmount,
        tradeSide,
        orderType,
        limitPrice,
      })
    ) {
      setTradeSubmitStatus({
        kind: "info",
        message: t("trade.topUpIntentChanged"),
      });
      return;
    }
    if (!activeMintUrl) {
      setTradeSubmitStatus({
        kind: "error",
        message: t("trade.selectActiveMintBeforeSubmit"),
      });
      return;
    }
    const balance = await getBalance(activeMintUrl, { baseAsset: intent.baseAsset });
    if (balance < intent.required) {
      setTradeSubmitStatus({
        kind: "error",
        message: t("trade.topUpStillInsufficient"),
      });
      return;
    }
    await handleTradeConfirm(intent.comment ?? pendingTopUpComment);
  }, [
    activeMintUrl,
    handleTradeConfirm,
    limitPrice,
    market,
    orderType,
    pendingTopUpComment,
    pendingTopUpIntent,
    t,
    tradeAmount,
    tradeSelection,
    tradeSide,
  ]);

  const handleStartTopUp = useCallback(() => {
    setTopUpStage("overlay");
  }, []);

  const handleTradingPanelTopUp = useCallback(
    (comment?: string) => {
      if (!market || !tradeSelection || tradeAmount <= 0) return;
      setBalanceAtCheck(0);
      const required = tradeFaceAmountSubunits;
      const baseAsset = marketBaseAsset;
      setPendingTopUpComment(comment?.trim() || undefined);
      setPendingTopUpIntent(
        buildPendingTopUpOrderIntent({
          market,
          tradeSelection,
          tradeAmount,
          tradeSide,
          orderType,
          limitPrice,
          comment,
          baseAsset,
          required: Math.max(required, 1),
        }),
      );
      setTopUpReason({
        kind: "collateral",
        required: Math.max(required, 1),
        baseAsset,
      });
      setTopUpStage("overlay");
    },
    [
      limitPrice,
      market,
      marketBaseAsset,
      orderType,
      tradeAmount,
      tradeFaceAmountSubunits,
      tradeSelection,
      tradeSide,
    ],
  );

  const handleRelatedMarketClick = useCallback(
    (marketId: string) => {
      navigate(`/markets/${marketId}`);
    },
    [navigate],
  );

  const handleTimeframeChange = useCallback((timeframe: ChartTimeframe) => {
    setChartTimeframe(timeframe);
  }, []);

  // Share button (P7 §/markets/{id}). The hook handles the native share-sheet
  // / clipboard-fallback split internally; the page just hands it the
  // current title + the implicit window.location.href.
  const handleShare = useShareMarket({ title: market?.title ?? "" });

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="text-slate-400 animate-pulse">Loading market...</div>
      </div>
    );
  }

  if (error || !market) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
        <div className="text-red-400">{error ?? "Market not found"}</div>
        <button
          onClick={() => loadMarket()}
          className="px-4 py-2 bg-[#f7931a] text-black rounded-lg hover:bg-[#e8850f] transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <>
      <MarketDetail
        market={market}
        chartTimeframe={chartTimeframe}
        tradeSelection={tradeSelection}
        tradeAmount={tradeAmount}
        tradePreview={tradePreview}
        tradeSide={tradeSide}
        orderType={orderType}
        limitOrderPreview={limitOrderPreview}
        limitPrice={limitPrice}
        onTimeframeChange={handleTimeframeChange}
        onTradeSelect={(selection) => {
          setTradeSelection(selection);
        }}
        onTradeClear={() => {
          setTradeSelection(null);
          setTradeAmount(0);
        }}
        onAmountChange={(amount) => {
          setTradeAmount(amount);
        }}
        onTradeConfirm={handleTradeConfirm}
        tradeSubmitStatus={tradeSubmitStatus}
        onTradeSubmitStatusDismiss={() => setTradeSubmitStatus(null)}
        tradeFeasibility={tradeFeasibility}
        isTradeSubmitting={isTradeSubmitting}
        onShare={handleShare}
        onTradeSideChange={setTradeSide}
        onOrderTypeChange={setOrderType}
        onLimitPriceChange={handleLimitPriceChange}
        onRelatedMarketClick={handleRelatedMarketClick}
        walletReady={walletReady}
        onWalletRequired={handleWalletRequired}
        onTopUpRequired={handleTradingPanelTopUp}
      />
      {topUpStage === "modal" && (
        <InsufficientBalanceModal
          balance={balanceAtCheck}
          required={topUpReason?.required ?? tradeAmount}
          title={topUpReason?.kind === "score" ? t("insufficientBalance.scoreTitle") : undefined}
          requiredDescription={
            topUpReason?.kind === "score" ? t("insufficientBalance.scoreNeeds") : undefined
          }
          formatAmount={(amount) =>
            topUpReason?.kind === "score"
              ? t("insufficientBalance.sats", { count: amount })
              : formatMarketSubunits(amount, marketBaseAsset)
          }
          onCancel={() => {
            setTopUpStage("closed");
            setTopUpReason(null);
            setPendingTopUpIntent(null);
            setPendingTopUpComment(undefined);
          }}
          onTopUp={handleStartTopUp}
        />
      )}
      {topUpStage === "overlay" && (
        <TopUpOverlay
          deficit={Math.max((topUpReason?.required ?? tradeAmount) - balanceAtCheck, 0)}
          baseAsset={topUpReason?.kind === "score" ? "sat" : marketBaseAsset}
          proofUnit={topUpReason?.kind === "score" ? "sat" : undefined}
          minimumDescription={
            topUpReason?.kind === "score"
              ? t("topUp.scoreMinimumDesc", {
                  sats: t("insufficientBalance.sats", {
                    count: Math.max(topUpReason.required - balanceAtCheck, 0),
                  }),
                })
              : undefined
          }
          onSuccess={handleTopUpSuccess}
          onCancel={() => {
            setTopUpStage("closed");
            setTopUpReason(null);
            setPendingTopUpIntent(null);
            setPendingTopUpComment(undefined);
          }}
        />
      )}
      {showNostrAuthModal && (
        <NostrAuthRequiredModal onClose={() => setShowNostrAuthModal(false)} />
      )}
      {showNostrChooser && (
        <NostrAccountChooserModal
          isCreating={lazySetupCreating}
          error={lazySetupError}
          onClose={() => setShowNostrChooser(false)}
          onUseExisting={() => navigate("/settings?category=nostr")}
          onCreateImplicit={handleCreateImplicitAccount}
        />
      )}
      {showBackupReminder && (
        <BackupSecretsReminderModal
          includeWallet={walletBackupState === "needs_backup"}
          includeNostr={signerBackupState === "needs_backup"}
          onDismiss={() => setShowBackupReminder(false)}
          onOpenSettings={() => navigate("/settings?category=nostr")}
        />
      )}
      {showFundedActionBackupPrompt && (
        <FundedActionBackupPromptModal
          onCancel={() => setShowFundedActionBackupPrompt(false)}
          onGoToBackup={() => navigate("/settings?category=cashu")}
        />
      )}
    </>
  );
}
