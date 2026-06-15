import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useParams, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { MarketDetail } from "@/components/market-detail";
import { InsufficientBalanceModal } from "@/components/shared/InsufficientBalanceModal";
import { NostrAuthRequiredModal } from "@/components/shared/NostrAuthRequiredModal";
import { NostrAccountChooserModal } from "@/components/shared/NostrAccountChooserModal";
import { BackupSecretsReminderModal } from "@/components/shared/BackupSecretsReminderModal";
import { TopUpOverlay } from "@/components/market-detail/TopUpOverlay";
import { useShareMarket } from "@/components/market-detail/useShareMarket";
import {
  applyMarketComments,
  applyMarketPriceHistory,
  appendLivePricePoint,
  fetchMarketDetail,
  fetchMarketComments,
  fetchMarketPriceHistory,
  fetchOrderBook,
  getParticipationScore,
  mapSnapshotToOrderBook,
  priceNumeratorToPercent,
  signTradeComment,
  submitOrder,
  type MarketPriceHistoryResponse,
  type MarketCommentsResponse,
} from "@/lib/markets";
import { promoteFillsToActiveSwaps } from "@/lib/orderStatus";
import { buildTradeTicket, TradeTicketError } from "@/lib/tradeTicket";
import {
  computeTradeCost,
  computeMarketOrderQuotePreview,
  displaySharesToFaceSats,
} from "@/lib/tradeCostPreview";
import { assertNever } from "@/lib/enumDiscipline";
import { generateEphemeralKeyPair } from "@/lib/ephemeral-key";
import { addOrderSubmitNotifications } from "@/lib/orderNotifications";
import {
  reconcileCompletedPreflightProofOperations,
  runPreflightMintSingleFlight,
} from "@/lib/preflightProofRecovery";
import {
  preparePreflightSplitForLimitBuy,
  type PreparedPreflightSplit,
} from "@/lib/preflightSplitPreparation";
import { resolveRootPreflightOutputAmountSats } from "@/lib/ctfSplit";
import { ensureParticipationScoreForNextMatch } from "@/lib/participationScorePayment";
import {
  outcomeLabels,
  outcomeSetIdsForMarketBooks,
  outcomeSetMarketId,
  resolveOutcomeSets,
} from "@/lib/outcomeSets";
import { useMarketStatusLive } from "@/hooks/useMarketStatusLive";
import {
  joinMarket,
  leaveMarket,
  onOrderBookUpdated,
  onTradeExecuted,
} from "@/lib/marketHub";
import { getOutcomeProofs, releaseProofReservation } from "@/stores/proof-db";
import {
  getBalance,
  useActiveMintInputFeePpk,
  useWalletStore,
} from "@/stores/wallet";
import { useSettingsStore } from "@/stores/settings";
import { usePendingTradesStore } from "@/stores/pendingTrades";
import { useNotificationsStore } from "@/stores/notifications";
import { createImplicitWalletAndNostrIdentity } from "@/lib/identityOps";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import {
  formatMarketSubunits,
  normalizeMarketBaseAsset,
  normalizeMarketDivisibility,
} from "@bitcaster/client-sdk/marketUnits";
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

type TopUpStage = "closed" | "modal" | "overlay";
type TopUpReason =
  | { kind: "collateral"; required: number; baseAsset: string }
  | { kind: "score"; required: number };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, Extract<keyof T, K>>
  : never;
type DerivedMarketDetailFields =
  | "priceHistory"
  | "orderBook"
  | "outcomeOrderBooks"
  | "outcomePriceHistories"
  | "cellPriceHistories"
  | "cellOrderBooks"
  | "comments"
  | "recentTrades"
  | "relatedMarkets";
type MarketDetailCore = DistributiveOmit<
  MarketDetailType,
  DerivedMarketDetailFields
>;
type CanonicalSliceSource = "snapshot" | "rest" | "live";
type MarketOrderBooksLoad = {
  orderBook: OrderBook;
  outcomeOrderBooks: Record<string, OrderBook>;
  fetchedOutcomeSetIds: string[];
};

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

export async function resolvePreflightSplitBuyCollateralRequirement(input: {
  activeMintUrl?: string | null;
  preflightSplit: boolean;
  market: MarketDetailType;
  tradeSelection: TradeSelection;
  tradeAmount: number;
  tradeSide: TradeSide;
  orderType: OrderType;
  limitPrice: number;
}): Promise<number | null> {
  if (
    !input.preflightSplit ||
    input.tradeSide !== "buy" ||
    input.orderType !== "limit" ||
    input.tradeAmount <= 0
  ) {
    return null;
  }

  const tradeBooks = resolveTradeOrderBooks(input.market, input.tradeSelection);
  if (!tradeBooks) return null;

  const divisibility = normalizeMarketDivisibility(input.market.divisibility);
  const { outcomeSets, selectedBook, complementBook } = tradeBooks;
  const directCross =
    selectedBook?.asks[0] != null &&
    selectedBook.asks[0].price <= input.limitPrice;
  const complementaryCross =
    complementBook?.bids[0] != null &&
    complementBook.bids[0].price + input.limitPrice >= divisibility;
  if (directCross || complementaryCross) return null;

  if (!input.activeMintUrl) {
    throw new Error("Select an active mint before using pre-flight split.");
  }

  return resolveRootPreflightOutputAmountSats({
    mintUrl: input.activeMintUrl,
    baseAsset: normalizeMarketBaseAsset(input.market.baseAsset),
    conditionId: input.market.id,
    amountSats: displaySharesToFaceSats(input.tradeAmount, divisibility),
    keepOutcomeSetId: outcomeSets.selectedOutcomeSetId,
    lockOutcomeSetId: outcomeSets.complementOutcomeSetId,
  });
}

export function decideTradeCollateralGate(input: {
  balance: number;
  tradeSide: TradeSide;
  tradeFaceAmount: number;
  requiredBuyCost: number;
  preflightSplitRequirement?: number | null;
}):
  | { kind: "top-up"; balance: number; required: number }
  | { kind: "proceed"; balance: number; required: number } {
  const required =
    input.tradeSide === "sell"
      ? input.tradeFaceAmount
      : (input.preflightSplitRequirement ?? input.requiredBuyCost);
  if (input.balance < required) {
    return { kind: "top-up", balance: input.balance, required };
  }
  return { kind: "proceed", balance: input.balance, required };
}

export function defaultLimitPriceForDivisibility(divisibility = 100): number {
  return Math.max(1, Math.floor(normalizeMarketDivisibility(divisibility) / 2));
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

function marketShapeMatches(
  current: MarketDetailType,
  latest: MarketDetailType,
): boolean {
  return (
    current.title === latest.title &&
    current.type === latest.type &&
    JSON.stringify(sortedOutcomeLabels(current)) ===
      JSON.stringify(sortedOutcomeLabels(latest)) &&
    JSON.stringify(categoryTagIds(current)) ===
      JSON.stringify(categoryTagIds(latest))
  );
}

export async function fetchMarketDetailWithBooks(
  conditionId: string,
): Promise<MarketDetailType> {
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
    const defaultOrderBook =
      outcomeOrderBooks[outcomeSetIds[0]] ?? detail.orderBook;
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
  | {
      type: "tradeExecuted";
      marketId: string;
      outcomeSetId: string;
      timeframe: ChartTimeframe;
      point: PricePoint;
    }
  | { type: "commentsLoaded"; marketId: string; comments: Comment[] };

const emptyMarketDetailDataState: MarketDetailDataState = {
  marketId: null,
  core: null,
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
  delete core.cellPriceHistories;
  delete core.cellOrderBooks;
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
  const outcomeSetIds =
    onlyOutcomeSetIds ?? outcomeSetIdsForMarketBooks(detail);
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
    historiesByOutcomeSetId: historiesByOutcomeSetFromDetail(
      withHistory,
      timeframe,
    ),
  };
}

export function liveTradeChartUpdate(
  market: MarketDetailType,
  outcomeSetId: string,
  trade: { timestamp: string; executionPrice: number; amountSats: number },
): { outcomeSetId: string; point: PricePoint } {
  const divisibility = normalizeMarketDivisibility(market.divisibility);
  const pricePercent = priceNumeratorToPercent(
    trade.executionPrice,
    divisibility,
  );
  const primary = primaryOutcomeSetId(market);
  const chartOutcomeSetId =
    market.type === "yesno" && primary ? primary : outcomeSetId;
  const chartPrice =
    market.type === "yesno" && primary && outcomeSetId !== primary
      ? Math.max(0, Math.min(100, 100 - pricePercent))
      : pricePercent;
  return {
    outcomeSetId: chartOutcomeSetId,
    point: {
      timestamp: trade.timestamp,
      price: chartPrice,
      volume: trade.amountSats,
    },
  };
}

function sourceMapFor<T>(
  slices: Record<string, T>,
  source: CanonicalSliceSource,
): Record<string, CanonicalSliceSource> {
  return Object.fromEntries(
    Object.keys(slices).map((key) => [key, source] as const),
  );
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
  if (!current || currentSource !== "live") return incoming;
  const byTimestamp = new Map<string, PricePoint>();
  for (const point of incoming.data) byTimestamp.set(point.timestamp, point);
  for (const point of current.data) byTimestamp.set(point.timestamp, point);
  return {
    timeframe: incoming.timeframe,
    data: [...byTimestamp.values()].sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp),
    ),
  };
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
    histories[outcomeSetId] = mergePriceHistory(
      histories[outcomeSetId],
      history,
      previousSource,
    );
    sources[outcomeSetId] =
      previousSource === "live" && source === "rest" ? "live" : source;
  }
  return { histories, sources };
}

function commentsFromResponse(
  market: MarketDetailType,
  response: MarketCommentsResponse,
): Comment[] {
  return applyMarketComments(market, response).comments;
}

export function createMarketDetailDataState(
  detail: MarketDetailType,
): MarketDetailDataState {
  const booksByOutcomeSetId = booksByOutcomeSetFromDetail(detail);
  const historiesByOutcomeSetId = historiesByOutcomeSetFromDetail(
    detail,
    detail.priceHistory.timeframe,
  );
  return {
    marketId: detail.id,
    core: marketCoreFromDetail(detail),
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
        [detail.priceHistory.timeframe]: sourceMapFor(
          historiesByOutcomeSetId,
          "snapshot",
        ),
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

  return {
    ...state,
    core: marketCoreFromDetail(detail),
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
      const historiesForMarket =
        state.historiesByMarketId[action.marketId] ?? {};
      const historiesForTimeframe = historiesForMarket[action.timeframe] ?? {};
      const sourcesForMarket =
        state.historySourcesByMarketId[action.marketId] ?? {};
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
    case "tradeExecuted": {
      if (state.marketId !== action.marketId) return state;
      const historiesForMarket =
        state.historiesByMarketId[action.marketId] ?? {};
      const historiesForTimeframe = historiesForMarket[action.timeframe] ?? {};
      const sourcesForMarket =
        state.historySourcesByMarketId[action.marketId] ?? {};
      const sourcesForTimeframe = sourcesForMarket[action.timeframe] ?? {};
      const currentHistory =
        historiesForTimeframe[action.outcomeSetId] ??
        emptyPriceHistory(action.timeframe);
      return {
        ...state,
        historiesByMarketId: {
          ...state.historiesByMarketId,
          [action.marketId]: {
            ...historiesForMarket,
            [action.timeframe]: {
              ...historiesForTimeframe,
              [action.outcomeSetId]: appendLivePricePoint(
                currentHistory,
                action.point,
              ),
            },
          },
        },
        historySourcesByMarketId: {
          ...state.historySourcesByMarketId,
          [action.marketId]: {
            ...sourcesForMarket,
            [action.timeframe]: {
              ...sourcesForTimeframe,
              [action.outcomeSetId]: "live",
            },
          },
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
  const historiesForTimeframe =
    state.historiesByMarketId[core.id]?.[timeframe] ?? {};
  const fallbackHistory = emptyPriceHistory(timeframe);
  const priceHistory =
    (primary ? historiesForTimeframe[primary] : undefined) ?? fallbackHistory;
  const booksByOutcomeSetId = state.booksByMarketId[core.id] ?? {};
  const enrichment = state.enrichmentByMarketId[core.id] ?? {
    comments: [],
    recentTrades: [],
    relatedMarkets: [],
  };
  const orderBook =
    (primary ? booksByOutcomeSetId[primary] : undefined) ?? emptyOrderBook();
  const base = {
    ...core,
    priceHistory,
    orderBook,
    outcomeOrderBooks: booksByOutcomeSetId,
    comments: enrichment.comments,
    recentTrades: enrichment.recentTrades,
    relatedMarkets: enrichment.relatedMarkets,
  };

  if (core.type === "categorical") {
    return {
      ...base,
      type: "categorical",
      outcomes: core.outcomes,
      outcomePriceHistories: historiesForTimeframe,
      outcomeOrderBooks: base.outcomeOrderBooks,
    };
  }

  if (core.type === "twodimensional") {
    return {
      ...base,
      type: "twodimensional",
      cellPriceHistories: {},
      cellOrderBooks: {},
    } as MarketDetailType;
  }

  return base as MarketDetailType;
}

async function getSellSideBalance(
  activeMintUrl: string,
  market: MarketDetailType,
  tradeSelection: TradeSelection,
): Promise<number> {
  const outcomeSets = resolveOutcomeSets(market, tradeSelection);
  if (!outcomeSets) return 0;
  const proofs = await getOutcomeProofs(
    activeMintUrl,
    market.id,
    outcomeSets.selectedOutcomeSetId,
    { baseAsset: market.baseAsset },
  );
  return proofs.reduce((sum, proof) => sum + amountToNumber(proof.amount), 0);
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
  const marketBaseAsset = normalizeMarketBaseAsset(market?.baseAsset);
  const [tradeSelection, setTradeSelection] = useState<TradeSelection | null>(
    null,
  );
  const [tradeAmount, setTradeAmount] = useState(0);
  const [tradeSide, setTradeSide] = useState<TradeSide>("buy");
  const [orderType, setOrderType] = useState<OrderType>("market");
  const [preflightSplit, setPreflightSplit] = useState(true);
  const [limitPrice, setLimitPrice] = useState(
    defaultLimitPriceForDivisibility,
  );
  const [tradeSubmitStatus, setTradeSubmitStatus] = useState<{
    kind: "info" | "success" | "error";
    message: string;
  } | null>(null);
  const [isTradeSubmitting, setIsTradeSubmitting] = useState(false);
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
  const [engineScoreFeeSats, setEngineScoreFeeSats] = useState<number | null>(
    null,
  );
  const [pendingTopUpComment, setPendingTopUpComment] = useState<
    string | undefined
  >();
  const [lazySetupComment, setLazySetupComment] = useState<
    string | undefined
  >();
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
          setError(
            "Failed to load market. Please check that the mint is running.",
          );
        })
        .finally(() => {
          if (showLoading) setLoading(false);
        });
    },
    [id],
  );

  // Secondary live close-detection: subscribe to MarketStatusChanged pushes
  // while this detail page is mounted. Best-effort — fires only when this page
  // is joined to at least one singleton market hub group. Feeds the same
  // notification + reconcile-state path as the primary boot reconcile.
  const handleLiveStatus = useCallback(
    () => loadMarket({ showLoading: false }),
    [loadMarket],
  );
  useMarketStatusLive(market?.id ?? null, handleLiveStatus);

  useEffect(() => {
    if (!id || !market) return;
    const outcomeSetIds = outcomeSetIdsForMarketBooks(market).slice(0, 8);
    if (outcomeSetIds.length === 0) return;

    let cancelled = false;
    const cleanups: Array<() => void> = [];

    for (const outcomeSetId of outcomeSetIds) {
      const liveMarketId = outcomeSetMarketId(id, outcomeSetId);
      cleanups.push(
        onOrderBookUpdated(liveMarketId, (snapshot) => {
          if (cancelled) return;
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
        onTradeExecuted(liveMarketId, (trade) => {
          if (cancelled) return;
          const chartUpdate = liveTradeChartUpdate(market, outcomeSetId, trade);
          dispatchMarketData({
            type: "tradeExecuted",
            marketId: id,
            outcomeSetId: chartUpdate.outcomeSetId,
            timeframe: chartTimeframe,
            point: chartUpdate.point,
          });
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
  }, [id, market?.id, chartTimeframe]);

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
            booksByOutcomeSetId: booksByOutcomeSetFromDetail(
              latest,
              books.fetchedOutcomeSetIds,
            ),
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
        const history = await fetchMarketPriceHistory(
          market.id,
          chartTimeframe,
        );
        if (!cancelled) {
          const { timeframe, historiesByOutcomeSetId } =
            historiesByOutcomeSetFromResponse(market, history);
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

  const marketDivisibility = normalizeMarketDivisibility(market?.divisibility);
  useEffect(() => {
    setLimitPrice(defaultLimitPriceForDivisibility(marketDivisibility));
  }, [market?.id, marketDivisibility]);

  const marketBalanceGatePrice =
    tradeSide === "sell" ? 1 : marketDivisibility - 1;

  const tradeFaceAmount = displaySharesToFaceSats(
    tradeAmount,
    marketDivisibility,
  );

  // Computed trade preview (market orders). `tradeAmount` is the user-entered
  // whole-share count; the wire face amount is derived only at protocol
  // boundaries.
  const tradePreview = useMemo<TradePreview | null>(() => {
    if (!tradeSelection || !tradeAmount || tradeAmount <= 0 || !market)
      return null;
    if (orderType === "limit") return null;

    const tradeBooks = resolveTradeOrderBooks(market, tradeSelection);
    const selectedBook = tradeBooks?.selectedBook ?? null;
    const quotePreview = computeMarketOrderQuotePreview({
      displayShares: tradeAmount,
      tradeSide,
      orderBook: selectedBook,
      complementaryOrderBook: tradeBooks?.complementBook ?? null,
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
        quoteSats: 0,
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
    });
    const predictedOdds = Math.max(
      0,
      Math.min(
        100,
        (quotePreview.averageExecutionPrice / marketDivisibility) * 100,
      ),
    );
    return {
      amount: tradeAmount,
      predictedOdds,
      priceImpact: 0,
      averageExecutionPrice: quotePreview.averageExecutionPrice,
      executableShares: quotePreview.executableDisplayShares,
      hasExecutableLiquidity: true,
      quoteSats: cost.quoteSats,
      mintFee: cost.mintFee,
      potentialPayout: quotePreview.filledFaceSats,
      creatorFee: cost.creatorFee,
      engineScoreFeeSats,
      totalCost: cost.totalCost,
    };
  }, [
    tradeSelection,
    tradeAmount,
    tradeSide,
    market,
    orderType,
    activeMintInputFeePpk,
    marketDivisibility,
    tradeFaceAmount,
    engineScoreFeeSats,
  ]);

  // Computed limit order preview.
  //
  // The displayed quote is whole shares × limit price.
  const limitOrderPreview = useMemo<LimitOrderPreview | null>(() => {
    if (!tradeSelection || !tradeAmount || tradeAmount <= 0 || !market)
      return null;
    if (orderType !== "limit") return null;

    const cost = computeTradeCost({
      displayShares: tradeAmount,
      price: limitPrice,
      feePercent: market.creator.feePercent,
      mintInputFeePpk: activeMintInputFeePpk,
    });
    return {
      limitPrice,
      amount: tradeAmount,
      sharesIfFilled: tradeAmount,
      quoteSats: cost.quoteSats,
      creatorFee: cost.creatorFee,
      mintFee: cost.mintFee,
      engineScoreFeeSats,
      potentialPayout: tradeFaceAmount,
      totalCost: cost.totalCost,
    };
  }, [
    tradeSelection,
    tradeAmount,
    market,
    orderType,
    limitPrice,
    activeMintInputFeePpk,
    marketDivisibility,
    tradeFaceAmount,
    engineScoreFeeSats,
  ]);

  // Derived spend a BUY must cover, used by the pre-submit balance gate and the
  // top-up modal/overlay. Sells are gated on the position face amount.
  const requiredBuyCost = useMemo(() => {
    if (!market || !tradeAmount || tradeAmount <= 0) return 0;
    const price = orderType === "limit" ? limitPrice : marketBalanceGatePrice;
    return computeTradeCost({
      displayShares: tradeAmount,
      price,
      feePercent: market.creator.feePercent,
      mintInputFeePpk: activeMintInputFeePpk,
    }).totalCost;
  }, [
    market,
    tradeAmount,
    orderType,
    limitPrice,
    marketBalanceGatePrice,
    activeMintInputFeePpk,
    marketDivisibility,
  ]);

  // Submit the order. Assumes wallet is set up and balance has been checked —
  // callers that can't promise that must route through `handleTradeConfirm`.
  const placeOrder = useCallback(
    async (comment?: string) => {
      if (!market || !tradeSelection || !tradeAmount) return;
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
          message:
            "Could not refresh market status before submitting the order.",
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
          message:
            "Market metadata changed before submission. Review the market and try again.",
        });
        tradeSubmitInFlightRef.current = false;
        setIsTradeSubmitting(false);
        return;
      }

      let ticket: ReturnType<typeof buildTradeTicket>;
      let outcomeSets: NonNullable<ReturnType<typeof resolveOutcomeSets>>;
      try {
        const tradeBooks = resolveTradeOrderBooks(latestMarket, tradeSelection);
        if (!tradeBooks) {
          throw new TradeTicketError(
            "missing-selection",
            "Choose an outcome before placing an order.",
          );
        }
        outcomeSets = tradeBooks.outcomeSets;
        ticket = buildTradeTicket({
          market: latestMarket,
          selection: tradeSelection,
          amountSats: displaySharesToFaceSats(
            tradeAmount,
            normalizeMarketDivisibility(latestMarket.divisibility),
          ),
          side: tradeSide,
          orderType,
          limitPrice,
          orderBook: tradeBooks.selectedBook,
          complementaryOrderBook: tradeBooks.complementBook,
        });
      } catch (e) {
        const message =
          e instanceof TradeTicketError
            ? e.message
            : "This order cannot be submitted yet.";
        setTradeSubmitStatus({ kind: "info", message });
        tradeSubmitInFlightRef.current = false;
        setIsTradeSubmitting(false);
        return;
      }

      const ephemeral = generateEphemeralKeyPair();
      let preparedPreflightSplit: PreparedPreflightSplit | undefined;
      let submitAttempted = false;
      try {
        const tradeBooks = resolveTradeOrderBooks(latestMarket, tradeSelection);
        const selectedBook = tradeBooks?.selectedBook ?? null;
        const complementBook = tradeBooks?.complementBook ?? null;
        const directCross =
          selectedBook?.asks[0] != null &&
          selectedBook.asks[0].price <= ticket.request.price;
        const complementaryCross =
          complementBook?.bids[0] != null &&
          complementBook.bids[0].price + ticket.request.price >=
            normalizeMarketDivisibility(latestMarket.divisibility);
        const shouldPreflightSplit =
          preflightSplit &&
          tradeSide === "buy" &&
          orderType === "limit" &&
          !directCross &&
          !complementaryCross;
        if (shouldPreflightSplit) {
          if (!activeMintUrl) {
            throw new Error(
              "Select an active mint before using pre-flight split.",
            );
          }
          preparedPreflightSplit = await runPreflightMintSingleFlight(
            activeMintUrl,
            async () => {
              await reconcileCompletedPreflightProofOperations({
                mintUrl: activeMintUrl,
                activeReservationIds: Object.values(
                  usePendingTradesStore.getState().byOrderId,
                )
                  .map((trade) => trade.preflightSplit?.reservationId)
                  .filter((reservationId): reservationId is string =>
                    Boolean(reservationId),
                  ),
              });
              return preparePreflightSplitForLimitBuy({
                mintUrl: activeMintUrl,
                market: latestMarket,
                selectedOutcomeSetId: outcomeSets.selectedOutcomeSetId,
                complementOutcomeSetId: outcomeSets.complementOutcomeSetId,
                amountSats: ticket.request.amountSats,
                reservationId: `order-preflight:${ephemeral.pubkey}`,
              });
            },
          );
        }
        const signedComment = comment?.trim()
          ? await signTradeComment(latestMarket.id, comment.trim())
          : undefined;
        submitAttempted = true;
        const response = await submitOrder(ticket.marketId, {
          ...ticket.request,
          ephemeralPubkey: ephemeral.pubkey,
          ...(signedComment ? { comment: signedComment } : {}),
        });
        const acceptedBaseAsset = normalizeMarketBaseAsset(
          response.baseAsset ?? latestMarket.baseAsset,
        );
        const acceptedDivisibility = normalizeMarketDivisibility(
          response.divisibility ?? latestMarket.divisibility,
        );
        // Only persist the privkey once the engine has accepted the order.
        // Otherwise we accumulate orphaned keys on every failed submission.
        addPendingTrade({
          orderId: response.orderId,
          marketId: ticket.marketId,
          ephemeralPubkey: ephemeral.pubkey,
          ephemeralPrivkey: ephemeral.privkey,
          baseAsset: acceptedBaseAsset,
          divisibility: acceptedDivisibility,
          submittedAt: Date.now(),
          preflightSplit: preparedPreflightSplit,
        });
        promoteFillsToActiveSwaps(response.fills ?? [], {
          orderId: response.orderId,
          marketId: ticket.marketId,
          ephemeralPubkey: ephemeral.pubkey,
          ephemeralPrivkey: ephemeral.privkey,
          baseAsset: acceptedBaseAsset,
          divisibility: acceptedDivisibility,
        });
        addOrderSubmitNotifications({
          add: useNotificationsStore.getState().add,
          orderId: response.orderId,
          marketId: ticket.marketId,
          requestedAmountSats: ticket.request.amountSats,
          remainingAmountSats: response.remainingAmountSats,
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
        if (preparedPreflightSplit && !submitAttempted) {
          await releaseProofReservation(preparedPreflightSplit.reservationId);
        }
        if (
          e instanceof Error &&
          e.message.includes("No Nostr signer configured")
        ) {
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
      preflightSplit,
      limitPrice,
      activeMintUrl,
      loadMarket,
      addPendingTrade,
    ],
  );

  // Gate the order submission on sufficient balance. Reads the balance at
  // click-time (not via `useBalance`) so we don't race a stale live-query
  // subscription after a top-up.
  const handleTradeConfirm = useCallback(
    async (comment?: string) => {
      if (!market || !tradeSelection || !tradeAmount) return;
      if (tradeSubmitInFlightRef.current) return;
      tradeSubmitInFlightRef.current = true;
      setIsTradeSubmitting(true);
      try {
        const preflightSplitRequirement =
          tradeSide === "buy"
            ? await resolvePreflightSplitBuyCollateralRequirement({
                activeMintUrl,
                preflightSplit,
                market,
                tradeSelection,
                tradeAmount,
                tradeSide,
                orderType,
                limitPrice,
              })
            : null;
        const current =
          tradeSide === "sell"
            ? await getSellSideBalance(activeMintUrl, market, tradeSelection)
            : await getBalance(activeMintUrl, { baseAsset: marketBaseAsset });
        const collateralGate = decideTradeCollateralGate({
          balance: current,
          tradeSide,
          tradeFaceAmount,
          requiredBuyCost,
          preflightSplitRequirement,
        });
        if (collateralGate.kind === "top-up") {
          setBalanceAtCheck(collateralGate.balance);
          setPendingTopUpComment(comment?.trim() || undefined);
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
          setTopUpReason({
            kind: "score",
            required: score.requiredSats,
          });
          setTopUpStage("modal");
          return;
        }
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("No Nostr signer configured")
        ) {
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
      tradeFaceAmount,
      tradeSide,
      requiredBuyCost,
      activeMintUrl,
      preflightSplit,
      orderType,
      limitPrice,
      placeOrder,
    ],
  );

  const handleWalletRequired = useCallback(
    async (comment?: string) => {
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
    [handleTradeConfirm, nostrSignerMode],
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

  // After a successful top-up, close the overlay and place the order.
  // TopUpOverlay only invokes onSuccess once proofs have been written to the
  // store, so the balance is guaranteed to cover `tradeAmount` by the time we
  // get here — no re-read needed.
  const handleTopUpSuccess = useCallback(async () => {
    setTopUpStage("closed");
    setTopUpReason(null);
    const comment = pendingTopUpComment;
    setPendingTopUpComment(undefined);
    await handleTradeConfirm(comment);
  }, [handleTradeConfirm, pendingTopUpComment]);

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
          setTradeSubmitStatus(null);
        }}
        onTradeClear={() => {
          setTradeSelection(null);
          setTradeAmount(0);
          setTradeSubmitStatus(null);
        }}
        onAmountChange={(amount) => {
          setTradeAmount(amount);
          setTradeSubmitStatus(null);
        }}
        onTradeConfirm={handleTradeConfirm}
        tradeSubmitStatus={tradeSubmitStatus}
        isTradeSubmitting={isTradeSubmitting}
        onShare={handleShare}
        onTradeSideChange={setTradeSide}
        onOrderTypeChange={setOrderType}
        preflightSplit={preflightSplit}
        onPreflightSplitChange={setPreflightSplit}
        onLimitPriceChange={setLimitPrice}
        onRelatedMarketClick={handleRelatedMarketClick}
        walletReady={walletReady}
        onWalletRequired={handleWalletRequired}
      />
      {topUpStage === "modal" && (
        <InsufficientBalanceModal
          balance={balanceAtCheck}
          required={topUpReason?.required ?? tradeAmount}
          title={
            topUpReason?.kind === "score"
              ? t("insufficientBalance.scoreTitle")
              : undefined
          }
          requiredDescription={
            topUpReason?.kind === "score"
              ? t("insufficientBalance.scoreNeeds")
              : undefined
          }
          formatAmount={(amount) =>
            topUpReason?.kind === "score"
              ? t("insufficientBalance.sats", { count: amount })
              : formatMarketSubunits(amount, marketBaseAsset)
          }
          onCancel={() => {
            setTopUpStage("closed");
            setTopUpReason(null);
          }}
          onTopUp={() => setTopUpStage("overlay")}
        />
      )}
      {topUpStage === "overlay" && (
        <TopUpOverlay
          deficit={Math.max(
            (topUpReason?.required ?? tradeAmount) - balanceAtCheck,
            0,
          )}
          baseAsset={topUpReason?.kind === "score" ? "sat" : marketBaseAsset}
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
    </>
  );
}
