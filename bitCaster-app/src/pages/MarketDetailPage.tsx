import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  activeBrowserWalletScopeId,
  browserWalletIdFromMnemonic,
  browserWalletScopeIdFromMnemonic,
} from "@/lib/browserWalletProfile";
import {
  canonicalSellHoldingsIdentityKey as buildCanonicalSellHoldingsIdentityKey,
  readCanonicalMarketSellHoldings,
  sellHoldingsForCurrentIdentity,
  type CanonicalSellHoldingsIdentity,
} from "@/lib/canonicalSellHoldings";
import { getNostrSignerRevision, subscribeToNostrSignerRevision } from "@/lib/nostr";
import { useParams, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { normalizeUrl } from "@/lib/url";
import { MarketDetail } from "@/components/market-detail";
import { InsufficientBalanceModal } from "@/components/shared/InsufficientBalanceModal";
import { NostrAuthRequiredModal } from "@/components/shared/NostrAuthRequiredModal";
import { NostrAccountChooserModal } from "@/components/shared/NostrAccountChooserModal";
import { BackupSecretsReminderModal } from "@/components/shared/BackupSecretsReminderModal";
import { TopUpOverlay } from "@/components/market-detail/TopUpOverlay";
import { db } from "@/stores/proof-db";
import { useShareMarket } from "@/components/market-detail/useShareMarket";
import {
  applyMarketComments,
  applyMarketPriceHistory,
  fetchMarketDetail,
  MarketDetailUnavailableError,
  fetchOrderBook,
  createAuthenticatedBrowserEngineClient,
  generateNip98Header,
  mapSnapshotToOrderBook,
  deriveCategoricalOdds,
  deriveYesNoOdds,
  signTradeComment,
  validateLatestConfirmedTrades,
  type MarketPriceHistoryResponse,
  type MarketCommentsResponse,
} from "@/lib/markets";
import { buildTradeTicket } from "@/lib/tradeTicket";
import { hasExecutableLiquidity } from "@/components/market-detail/orderBookViewModel";
import { buildProtectedTradeTicket, type TradeTicket } from "@bitcaster/client-sdk/tradeTicket";
import { displaySharesToFaceSubunits } from "@/lib/tradeCostPreview";
import { assertNever } from "@/lib/enumDiscipline";
import { addOrderSubmitNotifications } from "@/lib/orderNotifications";
import {
  outcomeLabels,
  outcomeSetIdsForMarketBooks,
  outcomeSetMarketId,
  resolveOutcomeSets,
} from "@/lib/outcomeSets";
import { useMarketStatusLive } from "@/hooks/useMarketStatusLive";
import { useMarketTradeRecovery } from "@/hooks/useMarketTradeRecovery";
import { useMarketDetailSnapshots } from "@/hooks/useMarketDetailSnapshots";
import { mergeMarketFundingObservation } from "@/lib/marketFunding";
import {
  applyConfirmedTradeDelta,
  joinMarket,
  leaveMarket,
  onMarketFundingUpdated,
  onConfirmedTradeRecorded,
  onMarketRejoined,
  onOrderCancelled,
  onOrderBookUpdated,
  refreshMarketSnapshot,
  type LatestConfirmedTrade,
  type MarketStatusChanged,
  type MarketFundingUpdatedMessage,
} from "@/lib/marketHub";
import { BitcasterEngineClient } from "@bitcaster/client-sdk/engineClient";
import type {
  PreviewFokOrderCapacityRequest,
  PreviewFokOrderRequest,
} from "@bitcaster/client-sdk/fokOrderPreview";
import { debounce } from "@/lib/debounce";
import { refreshOrderBook } from "@/lib/orderBookRefresh";
import { getExactUnitBalance, useWalletStore } from "@/stores/wallet";
import { useSettingsStore } from "@/stores/settings";
import { usePendingTradesStore } from "@/stores/pendingTrades";
import { useNotificationsStore } from "@/stores/notifications";
import { createImplicitWalletAndNostrIdentity } from "@/lib/identityOps";
import {
  cashuAmountToMarketSubunits,
  formatMarketSubunits,
  normalizeMarketBaseAsset,
  normalizeMarketDivisibility,
} from "@bitcaster/client-sdk/marketUnits";
import {
  BrowserCtfRangeScoreTopUpCancelledError,
  BrowserCtfRangeScoreTopUpRequiredError,
  previewBrowserCtfRangeOrderFees,
  submitBrowserCtfRangeOrder,
} from "@/lib/browserCtfRangeOrderSubmission";
import { BrowserCtfRangeOrderError } from "@/lib/browserCtfRangeOrderCoordinator";
import type { BrowserCtfRangeOrderFeePreview } from "@/lib/browserCtfRangeOrderSubmission";
import type {
  MarketDetail as MarketDetailType,
  ChartTimeframe,
  TradeSelection,
  TradeSide,
  OrderBook,
  PriceHistory,
  Comment,
  RelatedMarket,
  Trade,
  SellHoldingsState,
  TradeFeasibilityReason,
} from "@/types/market-detail";
import { useFokOrderPreview } from "@/hooks/useFokOrderPreview";
import { useFokOrderCapacityPreview } from "@/hooks/useFokOrderCapacityPreview";

type TopUpStage = "closed" | "modal" | "overlay";
type TopUpReason =
  | { kind: "collateral"; required: number; baseAsset: string }
  | {
      kind: "score";
      required: number;
      recoveryStatus: "insufficient" | "unavailable";
    };

interface ActiveScoreTopUpContinuation {
  readonly intent: PendingTopUpOrderIntent;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

export interface PendingTopUpOrderIntent {
  marketId: string;
  selectionKey: string;
  tradeAmount: number;
  tradeSide: TradeSide;
  comment?: string;
  baseAsset: "sat";
  required: number;
  protectedTicket: TradeTicket | null;
  previewIdentityKey: string | null;
  inputGeneration?: number;
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
const MARKET_DETAIL_RECONCILIATION_INTERVAL_MS = 2_000;
const MARKET_DETAIL_RECOVERY_MAX_ATTEMPTS = 5;
const MARKET_DETAIL_UNAVAILABLE_RECOVERY_MAX_ATTEMPTS = 45;
const MARKET_DETAIL_UNAVAILABLE_RECOVERY_WINDOW_MS = 90_000;
type MarketDetailLoadResult = "success" | "unavailable" | "other" | "stale";
type MarketDetailRequest = {
  routeId: string;
  generation: number;
  request: Promise<MarketDetailLoadResult>;
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

/**
 * Labels a fee-preview refusal from the typed source shortfall. Only the
 * offered asset differs by side: outcome tokens for Sell, sats for Buy.
 */
function rangeFeePreviewRefusalReason(
  error: unknown,
  tradeSide: TradeSide,
): TradeFeasibilityReason {
  if (!(error instanceof BrowserCtfRangeOrderError)) return "unavailable";
  if (error.code === "insufficient-funds") {
    switch (error.shortfall) {
      case "offered":
        switch (tradeSide) {
          case "Buy":
            return "funds";
          case "Sell":
            return "outcome-tokens";
          default:
            return assertNever(tradeSide);
        }
      case "collateral":
        return "preparation-fee-cash";
      case "mint-limits":
        return "mint-limits";
      case null:
        // An untyped shortfall cannot name the missing asset.
        return "unavailable";
      default:
        return assertNever(error.shortfall);
    }
  }
  return "unavailable";
}

function isClosedForTrading(market: MarketDetailType): boolean {
  return isEngineMarketClosed(market.state);
}

export function assertMarketAcceptsOrders(market: MarketDetailType): void {
  if (!isClosedForTrading(market)) return;
  throw new Error("This market is closed and no longer accepts orders.");
}

export function tradeSelectionIntentKey(selection: TradeSelection): string {
  return `${selection.side}:${selection.outcomeId ?? ""}`;
}

export function buildPendingTopUpOrderIntent(input: {
  market: MarketDetailType | null;
  tradeSelection: TradeSelection | null;
  tradeAmount: number;
  tradeSide: TradeSide;
  comment?: string;
  baseAsset: string | null | undefined;
  required: number;
  protectedTicket?: TradeTicket | null;
  previewIdentityKey?: string | null;
  inputGeneration?: number;
}): PendingTopUpOrderIntent | null {
  if (!input.market || !input.tradeSelection || input.tradeAmount <= 0) return null;
  if (!Number.isFinite(input.required) || input.required < 0) return null;
  return {
    marketId: input.market.id,
    selectionKey: tradeSelectionIntentKey(input.tradeSelection),
    tradeAmount: input.tradeAmount,
    tradeSide: input.tradeSide,
    comment: input.comment?.trim() || undefined,
    baseAsset: normalizeMarketBaseAsset(input.baseAsset),
    required: Math.ceil(input.required),
    protectedTicket: input.protectedTicket ?? null,
    previewIdentityKey: input.previewIdentityKey ?? null,
    inputGeneration: input.inputGeneration,
  };
}

export function pendingTopUpOrderIntentMatches(
  intent: PendingTopUpOrderIntent,
  current: {
    market: MarketDetailType | null;
    tradeSelection: TradeSelection | null;
    tradeAmount: number;
    tradeSide: TradeSide;
    protectedTicket?: TradeTicket | null;
    previewIdentityKey?: string | null;
  },
): boolean {
  return (
    current.market?.id === intent.marketId &&
    current.tradeSelection != null &&
    tradeSelectionIntentKey(current.tradeSelection) === intent.selectionKey &&
    current.tradeAmount === intent.tradeAmount &&
    current.tradeSide === intent.tradeSide &&
    (intent.previewIdentityKey === null || current.previewIdentityKey === intent.previewIdentityKey)
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

function discoveryLimitPrice(side: TradeSide, divisibility: number): number {
  switch (side) {
    case "Buy":
      return divisibility - 1;
    case "Sell":
      return 1;
    default:
      return assertNever(side);
  }
}

function acceptedQuotePaymentFits(ticket: TradeTicket, payment: number | null): boolean {
  if (payment === null) return false;
  switch (ticket.request.side) {
    case "Buy":
      return (
        ticket.request.maxQuotePaymentSubunits != null &&
        payment <= ticket.request.maxQuotePaymentSubunits
      );
    case "Sell":
      return (
        ticket.request.minQuotePaymentSubunits != null &&
        payment >= ticket.request.minQuotePaymentSubunits
      );
    default:
      return assertNever(ticket.request.side);
  }
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
  /** Route condition currently allowed to write into this state. */
  activeRouteId: string | null;
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
  | {
      type: "marketFundingUpdated";
      observation: MarketFundingUpdatedMessage;
    }
  | {
      type: "routeChanged";
      routeId: string | null;
    }
  | {
      type: "marketSnapshotLoaded";
      detail: MarketDetailType;
      expectedRouteId?: string;
    }
  | {
      type: "marketSubmitRefreshLoaded";
      detail: MarketDetailType;
      booksByOutcomeSetId: Record<string, OrderBook>;
      replaceOutcomeSetIds: string[];
      expectedRouteId?: string;
    }
  | {
      type: "booksLoaded";
      marketId: string;
      booksByOutcomeSetId: Record<string, OrderBook>;
      replaceOutcomeSetIds: string[];
      expectedRouteId?: string;
    }
  | {
      type: "orderBookUpdated";
      marketId: string;
      outcomeSetId: string;
      orderBook: OrderBook;
      expectedRouteId?: string;
    }
  | {
      type: "historyLoaded";
      marketId: string;
      timeframe: ChartTimeframe;
      historiesByOutcomeSetId: Record<string, PriceHistory>;
      expectedRouteId?: string;
    }
  | {
      type: "historyInvalidated";
      marketId: string;
      timeframe: ChartTimeframe;
    }
  | {
      type: "marketStatusChanged";
      status: MarketStatusChanged;
      expectedRouteId?: string;
    }
  | {
      type: "confirmedTradeRecorded";
      conditionId: string;
      trade: LatestConfirmedTrade;
      expectedRouteId?: string;
    }
  | {
      type: "commentsLoaded";
      marketId: string;
      comments: Comment[];
      expectedRouteId?: string;
    };

const emptyMarketDetailDataState: MarketDetailDataState = {
  activeRouteId: null,
  marketId: null,
  core: null,
  confirmedTradesByConditionId: {},
  registeredPrimitiveOutcomeIdsByConditionId: {},
  booksByMarketId: {},
  bookSourcesByMarketId: {},
  historiesByMarketId: {},
  enrichmentByMarketId: {},
};

function emptyPriceHistory(timeframe: ChartTimeframe): PriceHistory {
  return { timeframe, data: [] };
}

function emptyOrderBook(): OrderBook {
  return { bids: [], asks: [], spread: 0 };
}

function currentTradePreviewIdentityKey(routeId: string): string {
  const settings = useSettingsStore.getState();
  return [
    routeId,
    settings.nostrSignerMode,
    settings.nostrProfile?.pubkey ?? "anonymous",
    getNostrSignerRevision(),
    activeBrowserWalletScopeId() ?? "no-wallet",
  ].join("\u0000");
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
    return result;
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
    historiesByOutcomeSetId:
      market.type === "categorical"
        ? Object.fromEntries(
            outcomeSetIdsForMarketBooks(market).map((outcomeSetId) => [
              outcomeSetId,
              withHistory.type === "categorical"
                ? (withHistory.outcomePriceHistories[outcomeSetId] ?? {
                    ...withHistory.priceHistory,
                    data: [],
                  })
                : { ...withHistory.priceHistory, data: [] },
            ]),
          )
        : historiesByOutcomeSetFromDetail(withHistory, timeframe),
  };
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

function commentsFromResponse(
  market: MarketDetailType,
  response: MarketCommentsResponse,
): Comment[] {
  return applyMarketComments(market, response).comments;
}

function compareConfirmedTradeOrder(
  left: LatestConfirmedTrade,
  right: LatestConfirmedTrade,
): number {
  if (left.eventOrder === right.eventOrder) return 0;
  return left.eventOrder < right.eventOrder ? -1 : 1;
}

function confirmedTradeFactsEqual(
  left: LatestConfirmedTrade,
  right: LatestConfirmedTrade,
): boolean {
  return (
    left.primitiveOutcomeId === right.primitiveOutcomeId &&
    left.fillId === right.fillId &&
    left.executedAt === right.executedAt &&
    left.eventOrder === right.eventOrder &&
    left.priceTick === right.priceTick &&
    left.divisibility === right.divisibility &&
    left.faceAmountSubunits === right.faceAmountSubunits
  );
}

/** Merge a REST snapshot with the session overlay without allowing stale REST
 * completion to move a newer committed live fill backward. */
function mergeConfirmedTradeRecords(
  current: readonly LatestConfirmedTrade[],
  incoming: readonly LatestConfirmedTrade[],
): LatestConfirmedTrade[] {
  const byOutcome = new Map<string, LatestConfirmedTrade>();
  const byFill = new Map<string, LatestConfirmedTrade>();
  const add = (trade: LatestConfirmedTrade) => {
    const duplicateFill = byFill.get(trade.fillId);
    if (duplicateFill) {
      // A fill ID is an immutable authority identity. Only a byte-for-byte
      // duplicate is idempotent; a changed payload is invalid regardless of
      // its event order and must never replace the accepted live fill.
      if (!confirmedTradeFactsEqual(duplicateFill, trade)) return;
      return;
    }
    const previous = byOutcome.get(trade.primitiveOutcomeId);
    if (previous && compareConfirmedTradeOrder(previous, trade) >= 0) return;
    if (previous) byFill.delete(previous.fillId);
    byOutcome.set(trade.primitiveOutcomeId, trade);
    byFill.set(trade.fillId, trade);
  };
  for (const trade of current) add(trade);
  for (const trade of incoming) add(trade);
  return [...byOutcome.values()].sort((left, right) => {
    if (left.primitiveOutcomeId === right.primitiveOutcomeId) {
      return compareConfirmedTradeOrder(left, right);
    }
    return left.primitiveOutcomeId < right.primitiveOutcomeId ? -1 : 1;
  });
}

function applyConfirmedTradePrices(
  market: MarketDetailCore,
  confirmedTrades: readonly LatestConfirmedTrade[],
): MarketDetailCore {
  // Keep the composed market's bounded trade representation in lockstep with
  // the reducer overlay. Trade-book consumers must see the same
  // monotonic state that the detail projections render.
  const withConfirmedTrades = {
    ...market,
    latestConfirmedTrades: [...confirmedTrades],
  } as MarketDetailCore;
  if (market.latestConfirmedTradesValid === false) {
    if (market.type === "yesno") {
      return { ...withConfirmedTrades, currentOdds: { yes: null, no: null } } as MarketDetailCore;
    }
    if (market.type === "categorical") {
      return {
        ...withConfirmedTrades,
        outcomes: market.outcomes.map((outcome) => ({ ...outcome, odds: null })),
      } as MarketDetailCore;
    }
    return { ...withConfirmedTrades, currentPrice: null } as MarketDetailCore;
  }
  if (market.type === "yesno") {
    return {
      ...withConfirmedTrades,
      currentOdds: deriveYesNoOdds(confirmedTrades, market.registeredPrimitiveOutcomeIds ?? []),
    } as MarketDetailCore;
  }

  if (market.type === "categorical") {
    const odds = deriveCategoricalOdds(
      confirmedTrades,
      market.registeredPrimitiveOutcomeIds ?? market.outcomes.map((outcome) => outcome.id),
    );
    return {
      ...withConfirmedTrades,
      outcomes: market.outcomes.map((outcome) => ({
        ...outcome,
        odds: odds[outcome.id] ?? null,
      })),
    } as MarketDetailCore;
  }

  // Numeric markets have no public authoritative trade representation yet.
  // HI/LO probability ticks must not be interpolated into a native numeric
  // value, so keep the current value unavailable until that representation
  // exists in the contract.
  return { ...withConfirmedTrades, currentPrice: null } as MarketDetailCore;
}

export function createMarketDetailDataState(detail: MarketDetailType): MarketDetailDataState {
  const booksByOutcomeSetId = booksByOutcomeSetFromDetail(detail);
  const historiesByOutcomeSetId = historiesByOutcomeSetFromDetail(
    detail,
    detail.priceHistory.timeframe,
  );
  return {
    activeRouteId: detail.id,
    marketId: detail.id,
    core: marketCoreFromDetail(detail),
    confirmedTradesByConditionId: {
      [detail.id]: detail.latestConfirmedTrades ?? [],
    },
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
    enrichmentByMarketId: {
      [detail.id]: {
        comments: detail.comments,
        recentTrades: detail.recentTrades,
        relatedMarkets: detail.relatedMarkets,
      },
    },
  };
}

function emptyMarketDetailDataStateForRoute(routeId: string | null): MarketDetailDataState {
  return {
    ...emptyMarketDetailDataState,
    activeRouteId: routeId,
  };
}

function withSnapshotLoaded(
  state: MarketDetailDataState,
  detail: MarketDetailType,
): MarketDetailDataState {
  if (!state.core || state.marketId !== detail.id) {
    return createMarketDetailDataState(detail);
  }

  const currentConfirmedTrades = state.confirmedTradesByConditionId[detail.id] ?? [];
  const incomingConfirmedTrades = validateLatestConfirmedTrades(
    detail.latestConfirmedTrades,
    detail.registeredPrimitiveOutcomeIds ?? [],
    detail.divisibility,
  );
  const confirmedTradesByConditionId = {
    ...state.confirmedTradesByConditionId,
    [detail.id]: mergeConfirmedTradeRecords(currentConfirmedTrades, incomingConfirmedTrades),
  };
  const registeredPrimitiveOutcomeIdsByConditionId = {
    ...state.registeredPrimitiveOutcomeIdsByConditionId,
    [detail.id]: detail.registeredPrimitiveOutcomeIds ?? [],
  };

  return {
    ...state,
    core: {
      ...marketCoreFromDetail(detail),
      ...mergeMarketFundingObservation(state.core, {
        ammBotBudgetSubunits: detail.ammBotBudgetSubunits,
        fundingRevision: detail.fundingRevision ?? null,
      }),
    },
    confirmedTradesByConditionId,
    registeredPrimitiveOutcomeIdsByConditionId,
  };
}

export function marketDetailDataReducer(
  state: MarketDetailDataState,
  action: MarketDetailDataAction,
): MarketDetailDataState {
  switch (action.type) {
    case "marketFundingUpdated": {
      const { observation } = action;
      const core = state.core;
      if (
        !core ||
        state.activeRouteId !== observation.conditionId ||
        state.marketId !== observation.conditionId
      )
        return state;
      const funding = mergeMarketFundingObservation(core, observation);
      if (
        funding.ammBotBudgetSubunits === core.ammBotBudgetSubunits &&
        funding.fundingRevision === (core.fundingRevision ?? null)
      )
        return state;
      return { ...state, core: { ...core, ...funding } };
    }
    case "routeChanged":
      return emptyMarketDetailDataStateForRoute(action.routeId);
    case "marketSnapshotLoaded": {
      const expectedRouteId = action.expectedRouteId ?? action.detail.id;
      if (state.activeRouteId !== expectedRouteId || action.detail.id !== expectedRouteId) {
        return state;
      }
      return withSnapshotLoaded(state, action.detail);
    }
    case "marketSubmitRefreshLoaded": {
      const expectedRouteId = action.expectedRouteId ?? action.detail.id;
      if (state.activeRouteId !== expectedRouteId || action.detail.id !== expectedRouteId) {
        return state;
      }
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
      const expectedRouteId = action.expectedRouteId ?? action.marketId;
      if (state.activeRouteId !== expectedRouteId) return state;
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
    case "orderBookUpdated": {
      const expectedRouteId = action.expectedRouteId ?? action.marketId;
      if (state.activeRouteId !== expectedRouteId) return state;
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
    }
    case "historyLoaded": {
      const expectedRouteId = action.expectedRouteId ?? action.marketId;
      if (state.activeRouteId !== expectedRouteId) return state;
      if (state.marketId !== action.marketId) return state;
      const historiesForMarket = state.historiesByMarketId[action.marketId] ?? {};
      return {
        ...state,
        historiesByMarketId: {
          ...state.historiesByMarketId,
          [action.marketId]: {
            ...historiesForMarket,
            [action.timeframe]: action.historiesByOutcomeSetId,
          },
        },
      };
    }
    case "historyInvalidated": {
      if (state.activeRouteId !== action.marketId) return state;
      const current = state.historiesByMarketId[action.marketId] ?? {};
      return {
        ...state,
        historiesByMarketId: {
          ...state.historiesByMarketId,
          [action.marketId]: { [action.timeframe]: current[action.timeframe] },
        },
      };
    }
    case "marketStatusChanged": {
      const expectedRouteId = action.expectedRouteId ?? action.status.conditionId;
      if (state.activeRouteId !== expectedRouteId) return state;
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
      const expectedRouteId = action.expectedRouteId ?? action.conditionId;
      if (state.activeRouteId !== expectedRouteId) return state;
      if (state.marketId !== action.conditionId) return state;
      const current = state.confirmedTradesByConditionId[action.conditionId] ?? [];
      const allowedPrimitiveOutcomeIds =
        state.registeredPrimitiveOutcomeIdsByConditionId[action.conditionId] ?? [];
      // SignalR is a best-effort overlay, but it still crosses the same
      // authority boundary as REST. Reject malformed wire facts before the
      // merge can turn a validator failure into an empty no-trade snapshot.
      const incomingValidated = validateLatestConfirmedTrades(
        [action.trade],
        allowedPrimitiveOutcomeIds,
        state.core?.divisibility ?? 0,
      );
      if (incomingValidated.length !== 1 || incomingValidated[0] !== action.trade) return state;
      const acceptedDuplicate = current.find((trade) =>
        confirmedTradeFactsEqual(trade, action.trade),
      );
      if (acceptedDuplicate) return state;
      const next = applyConfirmedTradeDelta(
        action.conditionId,
        allowedPrimitiveOutcomeIds,
        current,
        {
          conditionId: action.conditionId,
          latestConfirmedTrade: action.trade,
        },
      );
      const canonicalNext = [...next].sort((left, right) => {
        if (left.primitiveOutcomeId === right.primitiveOutcomeId) {
          return compareConfirmedTradeOrder(left, right);
        }
        return left.primitiveOutcomeId < right.primitiveOutcomeId ? -1 : 1;
      });
      const validated = validateLatestConfirmedTrades(
        canonicalNext,
        allowedPrimitiveOutcomeIds,
        state.core?.divisibility ?? 0,
      );
      if (validated.length !== canonicalNext.length) return state;
      // Keep the headline overlay independent of chart snapshots.
      if (!validated.includes(action.trade)) return state;
      return {
        ...state,
        confirmedTradesByConditionId: {
          ...state.confirmedTradesByConditionId,
          [action.conditionId]: validated,
        },
      };
    }
    case "commentsLoaded": {
      const expectedRouteId = action.expectedRouteId ?? action.marketId;
      if (state.activeRouteId !== expectedRouteId) return state;
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
  if (!core || state.activeRouteId !== core.id) return null;

  const primary = primaryOutcomeSetId(core);
  const historiesForTimeframe = state.historiesByMarketId[core.id]?.[timeframe] ?? {};
  const fallbackHistory = emptyPriceHistory(timeframe);
  const priceHistory = (primary ? historiesForTimeframe[primary] : undefined) ?? fallbackHistory;
  const booksByOutcomeSetId = state.booksByMarketId[core.id] ?? {};
  const confirmedTrades = state.confirmedTradesByConditionId[core.id] ?? [];
  const oddsAlignedCore = applyConfirmedTradePrices(core, confirmedTrades);
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

function tradeFeeConsentKey(input: {
  conditionId: string | undefined;
  mintUrl: string;
  ticket: TradeTicket;
  previewIdentityKey: string;
  selectedSellHoldingVersion: string;
  recoveryInvalidationKey: string;
}): string {
  return JSON.stringify(input);
}

export function MarketDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const currentRouteId = id ?? null;
  const activeRouteIdRef = useRef<string | null>(currentRouteId);
  const routeGenerationRef = useRef(0);
  const marketLoadRequestTokenRef = useRef(0);
  const marketDetailRequestRef = useRef<MarketDetailRequest | null>(null);
  const [previewMarketRevision, setPreviewMarketRevision] = useState(0);
  // Update this during render so a promise that resolves between route render
  // and the route effect cannot write the previous condition into state.
  activeRouteIdRef.current = currentRouteId;
  const isCurrentRoute = useCallback(
    (routeId: string, generation: number) =>
      activeRouteIdRef.current === routeId && routeGenerationRef.current === generation,
    [],
  );
  const invalidatePreviewForMarket = useCallback(() => {
    setPreviewMarketRevision((revision) => revision + 1);
  }, []);
  const setupComplete = useWalletStore((s) => s.setupComplete);
  const activeMintUrl = useWalletStore((s) => s.activeMintUrl);
  const walletMnemonic = useWalletStore((s) => s.mnemonic);
  const signerRevision = useSyncExternalStore(
    subscribeToNostrSignerRevision,
    getNostrSignerRevision,
    getNostrSignerRevision,
  );
  const tradeRecovery = useMarketTradeRecovery({
    mnemonic: walletMnemonic,
    conditionId: currentRouteId,
    signerRevision,
  });
  const recoveryInvalidationKeyRef = useRef(tradeRecovery.invalidationKey);
  recoveryInvalidationKeyRef.current = tradeRecovery.invalidationKey;
  const addPendingTrade = usePendingTradesStore((s) => s.add);
  const nostrSignerMode = useSettingsStore((s) => s.nostrSignerMode);
  const nostrProfilePubkey = useSettingsStore((s) => s.nostrProfile?.pubkey ?? null);
  // Data state
  const [marketData, dispatchMarketData] = useReducer(
    marketDetailDataReducer,
    emptyMarketDetailDataState,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detailUnavailable, setDetailUnavailable] = useState(false);

  // UI state
  const [chartTimeframe, setChartTimeframe] = useState<ChartTimeframe>("7d");
  const market = useMemo(
    () =>
      marketData.activeRouteId === currentRouteId
        ? composeMarketDetail(marketData, chartTimeframe)
        : null,
    [currentRouteId, marketData, chartTimeframe],
  );
  // The route effect runs after the first render. Derive this transition state
  // from the reducer-owned route key so a new route cannot briefly render the
  // previous request's error or a false "not found" state.
  const routeTransitioning = marketData.activeRouteId !== currentRouteId;
  const isFullyEmptyBook = (() => {
    if (market === null) return false;
    const routes = outcomeSetIdsForMarketBooks(market);
    const sources = marketData.bookSourcesByMarketId[market.id] ?? {};
    const books = marketData.booksByMarketId[market.id] ?? {};
    return (
      routes.length > 0 &&
      routes.every((route) => {
        const book = books[route];
        return (
          (sources[route] === "rest" || sources[route] === "live") &&
          book !== undefined &&
          !hasExecutableLiquidity({ book, divisibility: market.divisibility, side: "Buy" }) &&
          !hasExecutableLiquidity({ book, divisibility: market.divisibility, side: "Sell" })
        );
      })
    );
  })();
  const visibleError = routeTransitioning ? null : error;
  const marketBaseAsset = market ? normalizeMarketBaseAsset(market.baseAsset) : "sat";
  const [tradeSelection, setTradeSelection] = useState<TradeSelection | null>(null);
  const [tradeAmount, setTradeAmount] = useState(0);
  const [tradeComment, setTradeComment] = useState("");
  const tradeInputGenerationRef = useRef(0);
  const [tradeSide, setTradeSide] = useState<TradeSide>("Buy");
  const [tradeSubmitStatus, setTradeSubmitStatus] = useState<{
    kind: "info" | "success" | "error";
    message: string;
  } | null>(null);
  const clearCompletedTradeNotice = useCallback(() => {
    setTradeSubmitStatus((status) => {
      if (status === null) return null;
      switch (status.kind) {
        case "success":
          return null;
        case "info":
        case "error":
          return status;
        default:
          return assertNever(status.kind);
      }
    });
  }, []);
  const [tradeFeasibilityResult, setTradeFeasibility] = useState<{
    key: string;
    canBack: boolean;
    reason?: TradeFeasibilityReason;
    message?: string;
  } | null>(null);
  const [isTradeSubmitting, setIsTradeSubmitting] = useState(false);
  const [rangeFeePreview, setRangeFeePreview] = useState<{
    key: string;
    feeFacts: BrowserCtfRangeOrderFeePreview;
  } | null>(null);
  const [feeFactsRefreshGeneration, setFeeFactsRefreshGeneration] = useState(0);
  const tradeSubmitInFlightRef = useRef(false);

  // Top-up flow state — surfaced only when the user tries to confirm a trade
  // they can't afford. `balanceAtCheck` is the snapshot taken when the gate
  // tripped, so the modal / overlay keep showing the user's real deficit even
  // if the wallet balance changes live while they decide.
  const [topUpStage, setTopUpStage] = useState<TopUpStage>("closed");
  const [topUpReason, setTopUpReason] = useState<TopUpReason | null>(null);
  const [balanceAtCheck, setBalanceAtCheck] = useState<number | null>(0);
  const [showNostrAuthModal, setShowNostrAuthModal] = useState(false);
  const [showNostrChooser, setShowNostrChooser] = useState(false);
  const [lazySetupError, setLazySetupError] = useState<string | null>(null);
  const [lazySetupCreating, setLazySetupCreating] = useState(false);
  const [showBackupReminder, setShowBackupReminder] = useState(false);
  const [pendingTopUpComment, setPendingTopUpComment] = useState<string | undefined>();
  const [pendingTopUpIntent, setPendingTopUpIntent] = useState<PendingTopUpOrderIntent | null>(
    null,
  );
  const walletReady = setupComplete && nostrSignerMode !== "none";

  const activeScopeId = activeBrowserWalletScopeId();
  const mnemonicScopeId = browserWalletScopeIdFromMnemonic(walletMnemonic);
  const canonicalSellHoldingsIdentity: CanonicalSellHoldingsIdentity | null =
    currentRouteId !== null &&
    market !== null &&
    activeMintUrl !== null &&
    mnemonicScopeId !== null &&
    mnemonicScopeId === activeScopeId
      ? {
          routeId: currentRouteId,
          conditionId: market.id,
          scopeId: mnemonicScopeId,
          mintUrl: activeMintUrl,
        }
      : null;
  const canonicalSellHoldingsIdentityKey = canonicalSellHoldingsIdentity
    ? buildCanonicalSellHoldingsIdentityKey(canonicalSellHoldingsIdentity)
    : null;
  const canonicalSellHoldingsResult = useLiveQuery(
    async () => {
      if (!canonicalSellHoldingsIdentity || canonicalSellHoldingsIdentityKey === null) return null;
      try {
        return await readCanonicalMarketSellHoldings(canonicalSellHoldingsIdentity);
      } catch {
        return {
          identityKey: canonicalSellHoldingsIdentityKey,
          status: "unavailable" as const,
        };
      }
    },
    [canonicalSellHoldingsIdentityKey, walletMnemonic, activeScopeId, activeMintUrl],
    null,
  );
  const sellHoldings: SellHoldingsState =
    canonicalSellHoldingsIdentityKey === null
      ? { status: "unavailable" }
      : sellHoldingsForCurrentIdentity(
          canonicalSellHoldingsResult,
          canonicalSellHoldingsIdentityKey,
        );
  const selectableInventoryWakeIdentity =
    activeScopeId !== null && mnemonicScopeId === activeScopeId && activeMintUrl !== null
      ? { scopeId: activeScopeId, normalizedMint: normalizeUrl(activeMintUrl) }
      : null;
  const selectableInventoryWakeIdentityKey = selectableInventoryWakeIdentity
    ? JSON.stringify([
        selectableInventoryWakeIdentity.scopeId,
        selectableInventoryWakeIdentity.normalizedMint,
      ])
    : null;
  const selectableInventoryWakeResult = useLiveQuery(
    async () => {
      if (selectableInventoryWakeIdentity === null || selectableInventoryWakeIdentityKey === null) {
        return null;
      }
      try {
        await db.custodyProofs
          .where("[scopeId+normalizedMint+unit+selectability]")
          .equals([
            selectableInventoryWakeIdentity.scopeId,
            selectableInventoryWakeIdentity.normalizedMint,
            "msat",
            "selectable",
          ])
          .count();
        return { identityKey: selectableInventoryWakeIdentityKey, wake: {} };
      } catch {
        return null;
      }
    },
    [selectableInventoryWakeIdentityKey],
    null,
  );
  const selectableInventoryWake =
    selectableInventoryWakeIdentityKey !== null &&
    selectableInventoryWakeResult?.identityKey === selectableInventoryWakeIdentityKey
      ? selectableInventoryWakeResult.wake
      : null;

  const invalidateProtectedTradeAttempt = useCallback(() => {
    invalidatePreviewForMarket();
    setRangeFeePreview(null);
    setTradeFeasibility(null);
    setFeeFactsRefreshGeneration((current) => current + 1);
  }, [invalidatePreviewForMarket]);

  const activeScoreTopUpRef = useRef<ActiveScoreTopUpContinuation | null>(null);
  const cancelActiveScoreTopUp = useCallback(() => {
    const active = activeScoreTopUpRef.current;
    if (active === null) return;
    activeScoreTopUpRef.current = null;
    active.reject(new BrowserCtfRangeScoreTopUpCancelledError());
  }, []);

  useEffect(() => cancelActiveScoreTopUp, [cancelActiveScoreTopUp]);

  // Load market data
  const loadMarket = useCallback(
    (
      options: { showLoading?: boolean; singleFlight?: boolean } = {},
    ): Promise<MarketDetailLoadResult> => {
      const routeId = id;
      if (!routeId) return Promise.resolve("stale");
      const generation = routeGenerationRef.current;
      if (options.singleFlight) {
        const inFlight = marketDetailRequestRef.current;
        if (inFlight?.routeId === routeId && inFlight.generation === generation)
          return inFlight.request;
      }
      const requestToken = ++marketLoadRequestTokenRef.current;
      const isCurrentLoad = () =>
        isCurrentRoute(routeId, generation) && marketLoadRequestTokenRef.current === requestToken;
      const showLoading = options.showLoading ?? true;
      if (showLoading) setLoading(true);
      if (showLoading) {
        setError(null);
        setDetailUnavailable(false);
      }

      let succeeded = false;
      const request = fetchMarketDetail(routeId)
        .then((detail): MarketDetailLoadResult => {
          if (!isCurrentLoad() || detail.id !== routeId) return "stale";
          succeeded = true;
          setError(null);
          setDetailUnavailable(false);
          dispatchMarketData({
            type: "marketSnapshotLoaded",
            detail,
            expectedRouteId: routeId,
          });
          void fetchMarketOrderBooks(routeId, detail).then((books) => {
            if (!isCurrentLoad()) return;
            const detailWithBooks = {
              ...detail,
              orderBook: books.orderBook,
              outcomeOrderBooks: books.outcomeOrderBooks,
            };
            invalidatePreviewForMarket();
            dispatchMarketData({
              type: "booksLoaded",
              marketId: routeId,
              expectedRouteId: routeId,
              booksByOutcomeSetId: booksByOutcomeSetFromDetail(
                detailWithBooks,
                books.fetchedOutcomeSetIds,
              ),
              replaceOutcomeSetIds: books.fetchedOutcomeSetIds,
            });
          });
          return "success";
        })
        .catch((error: unknown): MarketDetailLoadResult => {
          if (!isCurrentLoad()) return "stale";
          const unavailable = error instanceof MarketDetailUnavailableError;
          // Optional reconciliation must never replace a valid page with a
          // fatal error. Its failure is intentionally best-effort.
          if (showLoading) {
            setError(
              unavailable
                ? t("market.detailsUnavailable")
                : "Failed to load market. Please check that the mint is running.",
            );
            setDetailUnavailable(unavailable);
          }
          return unavailable ? "unavailable" : "other";
        })
        .finally(() => {
          if (isCurrentLoad() && (showLoading || succeeded)) setLoading(false);
          if (marketDetailRequestRef.current?.request === request)
            marketDetailRequestRef.current = null;
        });
      if (options.singleFlight) marketDetailRequestRef.current = { routeId, generation, request };
      return request;
    },
    [id, invalidatePreviewForMarket, isCurrentRoute, t],
  );

  useEffect(() => {
    const generation = ++routeGenerationRef.current;
    dispatchMarketData({ type: "routeChanged", routeId: currentRouteId });

    cancelActiveScoreTopUp();
    invalidatePreviewForMarket();

    // Route-owned order and interstitial state must not survive navigation.
    // In particular, a top-up completion for A must never prepare a ticket
    // after the user has moved to B.
    setTradeSelection(null);
    setTradeAmount(0);
    setTradeComment("");
    tradeInputGenerationRef.current += 1;
    setTradeSubmitStatus(null);
    setTradeFeasibility(null);
    setIsTradeSubmitting(false);
    setRangeFeePreview(null);
    setTopUpStage("closed");
    setTopUpReason(null);
    setBalanceAtCheck(0);
    setPendingTopUpComment(undefined);
    setPendingTopUpIntent(null);
    setShowNostrAuthModal(false);
    setShowNostrChooser(false);
    tradeSubmitInFlightRef.current = false;

    if (!currentRouteId) {
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    setDetailUnavailable(false);
    // loadMarket reads the generation set above. Keep this local read to make
    // the intended route token explicit and prevent future refactors from
    // accidentally loading a previous route.
    if (routeGenerationRef.current === generation) loadMarket();
    return () => {
      if (routeGenerationRef.current === generation) routeGenerationRef.current += 1;
    };
  }, [cancelActiveScoreTopUp, currentRouteId, invalidatePreviewForMarket, loadMarket]);

  // Navigation after market creation can outrun the catalogue projection.
  // Retry only after the error has rendered. First paint still blocks on one
  // request.
  useEffect(() => {
    if (!id || !error || market || routeTransitioning) return;
    const generation = routeGenerationRef.current;
    if (!isCurrentRoute(id, generation)) return;

    let cancelled = false;
    let attempts = 0;
    let timeoutId: number | null = null;
    const maxAttempts = detailUnavailable
      ? MARKET_DETAIL_UNAVAILABLE_RECOVERY_MAX_ATTEMPTS
      : MARKET_DETAIL_RECOVERY_MAX_ATTEMPTS;
    const deadline = Date.now() + MARKET_DETAIL_UNAVAILABLE_RECOVERY_WINDOW_MS;

    const retry = async () => {
      if (cancelled || !isCurrentRoute(id, generation)) return;
      if (detailUnavailable && Date.now() >= deadline) return;
      attempts += 1;
      const result = await loadMarket({ showLoading: false, singleFlight: true });
      if (
        cancelled ||
        !isCurrentRoute(id, generation) ||
        result === "success" ||
        result === "stale"
      )
        return;
      if (detailUnavailable && result !== "unavailable") return;
      if (attempts >= maxAttempts) return;
      if (detailUnavailable && Date.now() + MARKET_DETAIL_RECONCILIATION_INTERVAL_MS > deadline)
        return;
      timeoutId = window.setTimeout(retry, MARKET_DETAIL_RECONCILIATION_INTERVAL_MS);
    };

    timeoutId = window.setTimeout(retry, MARKET_DETAIL_RECONCILIATION_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timeoutId != null) window.clearTimeout(timeoutId);
    };
  }, [detailUnavailable, error, id, isCurrentRoute, loadMarket, market, routeTransitioning]);

  // Secondary live close-detection: subscribe to MarketStatusChanged pushes
  // while this detail page is mounted and joined to at least one per-outcome
  // market hub group. This is best-effort detail-page UX only: apply the pushed
  // state immediately, then reconcile via the catalogue as the correctness
  // fallback. Do not add list-page joins or polling for lifecycle changes.
  const handleLiveStatus = useCallback(
    (status: MarketStatusChanged) => {
      const routeId = market?.id;
      const generation = routeGenerationRef.current;
      if (!routeId || status.conditionId !== routeId || !isCurrentRoute(routeId, generation))
        return;
      dispatchMarketData({
        type: "marketStatusChanged",
        status,
        expectedRouteId: routeId,
      });
      loadMarket({ showLoading: false });
    },
    [isCurrentRoute, loadMarket, market?.id],
  );
  useMarketStatusLive(market?.id ?? null, handleLiveStatus);

  const handleFundingCredited = useCallback(() => {
    const conditionId = market?.id;
    const generation = routeGenerationRef.current;
    if (!conditionId || !isCurrentRoute(conditionId, generation) || !market) return;

    const outcomeSetIds = outcomeSetIdsForMarketBooks(market).slice(0, 8);
    void Promise.all(
      outcomeSetIds.map(async (outcomeSetId) => {
        try {
          await refreshMarketSnapshot(outcomeSetMarketId(conditionId, outcomeSetId));
        } catch (err) {
          console.warn("[MarketDetailPage] funding snapshot refresh failed:", err);
        }
      }),
    );
  }, [isCurrentRoute, market]);

  useEffect(() => {
    if (!id || !market) return;
    const generation = routeGenerationRef.current;
    if (!isCurrentRoute(id, generation)) return;
    const outcomeSetIds = outcomeSetIdsForMarketBooks(market).slice(0, 8);
    if (outcomeSetIds.length === 0) return;

    let cancelled = false;
    const cleanups: Array<() => void> = [];

    cleanups.push(
      onMarketFundingUpdated(id, (message) => {
        if (cancelled || !isCurrentRoute(id, generation) || message.conditionId !== id) return;
        dispatchMarketData({ type: "marketFundingUpdated", observation: message });
      }),
    );

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
        if (cancelled || !isCurrentRoute(id, generation) || message.conditionId !== id) return;
        dispatchMarketData({
          type: "confirmedTradeRecorded",
          conditionId: id,
          trade: message.latestConfirmedTrade,
          expectedRouteId: id,
        });
        refreshAuthoritativeMarket();
      }),
    );

    for (const outcomeSetId of outcomeSetIds) {
      const liveMarketId = outcomeSetMarketId(id, outcomeSetId);
      const refreshLiveOrderBook = debounce(() => {
        void refreshOrderBook(liveMarketId)
          .then((orderBook) => {
            if (cancelled || !isCurrentRoute(id, generation)) return;
            invalidatePreviewForMarket();
            dispatchMarketData({
              type: "orderBookUpdated",
              marketId: id,
              outcomeSetId,
              orderBook,
              expectedRouteId: id,
            });
          })
          .catch((err) => {
            console.warn("[MarketDetailPage] order-book refresh failed:", err);
          });
      }, ORDER_BOOK_REFRESH_DEBOUNCE_MS);
      cleanups.push(refreshLiveOrderBook.cancel);
      cleanups.push(
        onOrderBookUpdated(liveMarketId, (snapshot) => {
          if (cancelled || !isCurrentRoute(id, generation)) return;
          refreshLiveOrderBook.cancel();
          const liveBook = mapSnapshotToOrderBook(snapshot);
          invalidatePreviewForMarket();
          dispatchMarketData({
            type: "orderBookUpdated",
            marketId: id,
            outcomeSetId,
            orderBook: liveBook,
            expectedRouteId: id,
          });
        }),
      );
      cleanups.push(
        onOrderCancelled(liveMarketId, () => {
          if (cancelled || !isCurrentRoute(id, generation)) return;
          refreshLiveOrderBook();
          reconcileOwnOrders();
        }),
      );
      cleanups.push(
        onMarketRejoined(liveMarketId, () => {
          if (cancelled || !isCurrentRoute(id, generation)) return;
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
  }, [id, invalidatePreviewForMarket, isCurrentRoute, loadMarket, market?.id]);

  useMarketDetailSnapshots({
    market: market?.id === currentRouteId ? market : null,
    timeframe: chartTimeframe,
    onHistory: (response) => {
      if (!market || response.timeframe !== chartTimeframe) return;
      const { timeframe, historiesByOutcomeSetId } = historiesByOutcomeSetFromResponse(
        market,
        response,
      );
      dispatchMarketData({
        type: "historyLoaded",
        marketId: market.id,
        timeframe,
        historiesByOutcomeSetId,
        expectedRouteId: market.id,
      });
    },
    onComments: (response) => {
      if (!market) return;
      dispatchMarketData({
        type: "commentsLoaded",
        marketId: market.id,
        comments: commentsFromResponse(market, response),
        expectedRouteId: market.id,
      });
    },
    onInvalidateHistory: () => {
      if (market)
        dispatchMarketData({
          type: "historyInvalidated",
          marketId: market.id,
          timeframe: chartTimeframe,
        });
    },
  });

  const marketDivisibility = market
    ? normalizeMarketDivisibility(market.divisibility, marketBaseAsset)
    : 1_000;
  const discoveryPrice = discoveryLimitPrice(tradeSide, marketDivisibility);

  const tradeFaceAmountSubunits = displaySharesToFaceSubunits(
    tradeAmount,
    marketBaseAsset,
    marketDivisibility,
  );

  const previewClient = useMemo(
    () =>
      nostrSignerMode === "none"
        ? new BitcasterEngineClient({ baseUrl: window.location.origin })
        : createAuthenticatedBrowserEngineClient(),
    [nostrSignerMode],
  );
  const previewIdentityKey = useMemo(
    () => currentTradePreviewIdentityKey(currentRouteId ?? ""),
    [currentRouteId, nostrProfilePubkey, nostrSignerMode, signerRevision, walletMnemonic],
  );
  const capacityRequest = useMemo<PreviewFokOrderCapacityRequest | null>(() => {
    if (!market || !tradeSelection) return null;
    const resolved = resolveOutcomeSets(market, tradeSelection);
    if (!resolved) return null;
    const request: PreviewFokOrderCapacityRequest = {
      marketId: outcomeSetMarketId(market.id, resolved.publicOutcomeSetId),
      side: tradeSide,
      tokenSide: resolved.tokenSide,
      price: discoveryPrice,
    };
    return request;
  }, [market, tradeSelection, tradeSide, discoveryPrice]);
  const capacityInvalidationKey = useMemo(
    () => [previewIdentityKey, previewMarketRevision, tradeRecovery.invalidationKey].join("\u0000"),
    [previewIdentityKey, previewMarketRevision, tradeRecovery.invalidationKey],
  );
  const capacityPreview = useFokOrderCapacityPreview({
    client: previewClient,
    request: isTradeSubmitting ? null : capacityRequest,
    invalidationKey: capacityInvalidationKey,
    debounceMs: 200,
  });
  const currentTradeTicket = useMemo(() => {
    if (!market || !tradeSelection || tradeAmount <= 0 || marketDivisibility <= 1) {
      return null;
    }
    try {
      const tradeBooks = resolveTradeOrderBooks(market, tradeSelection);
      return buildTradeTicket({
        market,
        selection: tradeSelection,
        amountSubunits: tradeFaceAmountSubunits,
        side: tradeSide,
        orderType: "limit",
        limitPrice: discoveryPrice,
        orderBook: tradeBooks?.selectedBook,
        complementaryOrderBook: tradeBooks?.complementBook,
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
    marketDivisibility,
    discoveryPrice,
  ]);
  const previewRequest = useMemo<PreviewFokOrderRequest | null>(() => {
    if (currentTradeTicket === null) return null;
    return {
      marketId: currentTradeTicket.marketId,
      side: currentTradeTicket.request.side,
      tokenSide: currentTradeTicket.request.tokenSide,
      price: currentTradeTicket.request.price,
      faceAmountSubunits: currentTradeTicket.request.amountSubunits,
    };
  }, [currentTradeTicket]);
  const selectedSellOutcomeSetId = useMemo(
    () =>
      market && tradeSelection
        ? (resolveOutcomeSets(market, tradeSelection)?.selectedOutcomeSetId ?? null)
        : null,
    [market, tradeSelection],
  );
  const selectedSellHolding =
    tradeSide === "Sell" && sellHoldings.status === "ready" && selectedSellOutcomeSetId !== null
      ? (sellHoldings.byOutcomeSetId.get(selectedSellOutcomeSetId) ?? {
          selectableSubunits: 0,
          reservedSubunits: 0,
        })
      : null;
  const selectedSellAvailableShares =
    selectedSellHolding === null
      ? null
      : Math.floor(selectedSellHolding.selectableSubunits / marketDivisibility);
  const selectedSellHoldingVersion = JSON.stringify([
    sellHoldings.status,
    selectedSellOutcomeSetId,
    selectedSellHolding?.selectableSubunits ?? null,
    selectedSellHolding?.reservedSubunits ?? null,
  ]);
  const previewInvalidationKey = useMemo(() => {
    const confirmedTradeFacts = JSON.stringify(market?.latestConfirmedTrades ?? []);
    return [
      previewIdentityKey,
      previewMarketRevision,
      tradeRecovery.invalidationKey,
      selectedSellHoldingVersion,
      market?.latestConfirmedTradesValid === true ? "valid" : "invalid",
      confirmedTradeFacts,
    ].join("\u0000");
  }, [
    market?.latestConfirmedTrades,
    market?.latestConfirmedTradesValid,
    previewIdentityKey,
    previewMarketRevision,
    tradeRecovery.invalidationKey,
    selectedSellHoldingVersion,
  ]);
  const previewIdentityRef = useRef<string | null>(null);
  const previewIdentityIsCurrent = previewIdentityRef.current === previewIdentityKey;
  useEffect(() => {
    previewIdentityRef.current = previewIdentityKey;
  }, [previewIdentityKey]);
  const fokPreview = useFokOrderPreview({
    client: previewClient,
    request: isTradeSubmitting ? null : previewRequest,
    invalidationKey: previewInvalidationKey,
    debounceMs: 200,
  });
  const tradePreview = fokPreview;
  const protectedTradeTicket = useMemo(() => {
    if (
      currentTradeTicket === null ||
      previewRequest === null ||
      !previewIdentityIsCurrent ||
      fokPreview.status !== "ready" ||
      fokPreview.response === null
    ) {
      return null;
    }
    try {
      return buildProtectedTradeTicket({
        ticket: currentTradeTicket,
        previewRequest,
        previewResponse: fokPreview.response,
      });
    } catch {
      return null;
    }
  }, [
    currentTradeTicket,
    fokPreview.response,
    fokPreview.status,
    previewIdentityIsCurrent,
    previewRequest,
  ]);
  const rangeFeePreviewKey = useMemo(
    () =>
      protectedTradeTicket && activeMintUrl
        ? tradeFeeConsentKey({
            conditionId: market?.id,
            mintUrl: activeMintUrl,
            ticket: protectedTradeTicket,
            previewIdentityKey,
            selectedSellHoldingVersion,
            recoveryInvalidationKey: tradeRecovery.invalidationKey,
          })
        : null,
    [
      activeMintUrl,
      market?.id,
      protectedTradeTicket,
      previewIdentityKey,
      selectedSellHoldingVersion,
      tradeRecovery.invalidationKey,
    ],
  );
  const displayedTradeFeeFacts =
    rangeFeePreviewKey !== null && rangeFeePreview?.key === rangeFeePreviewKey
      ? rangeFeePreview.feeFacts
      : null;
  const tradeFeasibility =
    rangeFeePreviewKey !== null && tradeFeasibilityResult?.key === rangeFeePreviewKey
      ? tradeFeasibilityResult
      : null;
  const feeConsentCurrent = displayedTradeFeeFacts !== null;

  useEffect(() => {
    if (
      !walletReady ||
      !activeMintUrl ||
      !market ||
      !tradeSelection ||
      tradeAmount <= 0 ||
      !protectedTradeTicket ||
      !rangeFeePreviewKey
    ) {
      setTradeFeasibility(null);
      return;
    }

    const routeId = market.id;
    const generation = routeGenerationRef.current;
    if (!isCurrentRoute(routeId, generation)) {
      setTradeFeasibility(null);
      return;
    }
    if (tradeSide === "Sell") {
      if (
        sellHoldings.status !== "ready" ||
        selectedSellAvailableShares === null ||
        tradeAmount > selectedSellAvailableShares
      ) {
        setTradeFeasibility({
          key: rangeFeePreviewKey,
          canBack: false,
          reason: "outcome-tokens",
          message: "Insufficient selectable outcome tokens",
        });
        return;
      }
    }
    let cancelled = false;
    setTradeFeasibility(null);
    setRangeFeePreview(null);
    const evaluate = async () => {
      try {
        const feePreview = await previewBrowserCtfRangeOrderFees({
          market,
          ticket: protectedTradeTicket,
          mintUrl: activeMintUrl,
        });
        if (cancelled || !isCurrentRoute(routeId, generation)) return;
        setRangeFeePreview({ key: rangeFeePreviewKey, feeFacts: feePreview });
        setTradeFeasibility({ key: rangeFeePreviewKey, canBack: true });
      } catch (error) {
        if (cancelled || !isCurrentRoute(routeId, generation)) return;
        setTradeFeasibility({
          key: rangeFeePreviewKey,
          canBack: false,
          reason: rangeFeePreviewRefusalReason(error, tradeSide),
        });
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
    tradeSide,
    marketDivisibility,
    sellHoldings.status,
    selectedSellAvailableShares,
    protectedTradeTicket,
    feeFactsRefreshGeneration,
    isCurrentRoute,
    rangeFeePreviewKey,
    selectableInventoryWake,
  ]);

  // Reuse consent only for the same ticket and wallet. A new fee calculation
  // needs confirmation; it must not silently authorize a changed cost.
  const placeOrder = useCallback(
    async (comment?: string, capturedTicket?: TradeTicket, capturedInputGeneration?: number) => {
      if (!market || !tradeSelection || !tradeAmount) return;
      const ticket = capturedTicket ?? protectedTradeTicket;
      if (ticket === null || ticket === undefined) {
        setTradeSubmitStatus({
          kind: "info",
          message: "Review the current fillable price preview before submitting the order.",
        });
        return;
      }
      const routeId = market.id;
      const generation = routeGenerationRef.current;
      const routeStillActive = () => isCurrentRoute(routeId, generation);
      const capturedPreviewIdentityKey = previewIdentityKey;
      const capturedRecoveryInvalidationKey = tradeRecovery.invalidationKey;
      const inputGeneration = capturedInputGeneration ?? tradeInputGenerationRef.current;
      const abortIfAttemptStale = () => {
        if (!routeStillActive()) return true;
        const previewIdentityIsCurrent =
          currentTradePreviewIdentityKey(routeId) === capturedPreviewIdentityKey;
        const recoveryIdentityIsCurrent =
          recoveryInvalidationKeyRef.current === capturedRecoveryInvalidationKey;
        if (previewIdentityIsCurrent && recoveryIdentityIsCurrent) return false;
        if (previewIdentityIsCurrent) {
          setTradeSubmitStatus({ kind: "info", message: t("trade.recoveryConsentChanged") });
        }
        tradeSubmitInFlightRef.current = false;
        setIsTradeSubmitting(false);
        return true;
      };
      if (abortIfAttemptStale()) return;
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
        const latestDetail = await fetchMarketDetail(routeId);
        if (abortIfAttemptStale() || latestDetail.id !== routeId) return;
        const books = await fetchMarketOrderBooks(routeId, latestDetail);
        if (abortIfAttemptStale()) return;
        latestMarket = {
          ...latestDetail,
          orderBook: books.orderBook,
          outcomeOrderBooks: books.outcomeOrderBooks,
        };
        invalidatePreviewForMarket();
        dispatchMarketData({
          type: "marketSubmitRefreshLoaded",
          expectedRouteId: routeId,
          detail: latestMarket,
          booksByOutcomeSetId: booksByOutcomeSetFromDetail(
            latestMarket,
            books.fetchedOutcomeSetIds,
          ),
          replaceOutcomeSetIds: books.fetchedOutcomeSetIds,
        });
      } catch {
        if (abortIfAttemptStale()) return;
        setTradeSubmitStatus({
          kind: "error",
          message: "Could not refresh market status before submitting the order.",
        });
        tradeSubmitInFlightRef.current = false;
        setIsTradeSubmitting(false);
        return;
      }
      if (abortIfAttemptStale()) return;
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

      try {
        if (abortIfAttemptStale()) return;
        const finalPreview = await previewClient.previewFokOrder({
          marketId: ticket.marketId,
          side: ticket.request.side,
          tokenSide: ticket.request.tokenSide,
          price: ticket.request.price,
          faceAmountSubunits: ticket.request.amountSubunits,
        });
        if (abortIfAttemptStale()) return;
        if (
          !finalPreview.fullFillAvailable ||
          !acceptedQuotePaymentFits(ticket, finalPreview.quotePaymentSubunits)
        ) {
          throw new Error(
            "The order is no longer fillable at the confirmed terms. Refresh the preview and confirm again.",
          );
        }
      } catch (error) {
        if (abortIfAttemptStale()) return;
        setTradeSubmitStatus({
          kind: "error",
          message:
            error instanceof Error &&
            error.message ===
              "The order is no longer fillable at the confirmed terms. Refresh the preview and confirm again."
              ? error.message
              : "The order preview is temporarily unavailable. Review the terms and try again.",
        });
        tradeSubmitInFlightRef.current = false;
        setIsTradeSubmitting(false);
        return;
      }

      const clientOrderId = crypto.randomUUID();
      try {
        if (abortIfAttemptStale()) return;
        const signedComment = comment?.trim()
          ? await signTradeComment(latestMarket.id, comment.trim())
          : undefined;
        if (abortIfAttemptStale()) return;
        const walletState = useWalletStore.getState();
        const submittedWalletId = browserWalletIdFromMnemonic(walletState.mnemonic);
        if (submittedWalletId === null) throw new Error("The active wallet is unavailable.");
        if (!activeMintUrl) throw new Error("The active mint is unavailable.");
        const exactFeePreviewKey = tradeFeeConsentKey({
          conditionId: latestMarket.id,
          mintUrl: activeMintUrl,
          ticket,
          previewIdentityKey: capturedPreviewIdentityKey,
          selectedSellHoldingVersion,
          recoveryInvalidationKey: capturedRecoveryInvalidationKey,
        });
        let consentedFeeFacts =
          rangeFeePreview?.key === exactFeePreviewKey ? rangeFeePreview.feeFacts : null;
        if (consentedFeeFacts === null) {
          const feePreview = await previewBrowserCtfRangeOrderFees({
            market: latestMarket,
            ticket,
            mintUrl: activeMintUrl,
          });
          consentedFeeFacts = feePreview;
          if (abortIfAttemptStale()) return;
          setRangeFeePreview({
            key: exactFeePreviewKey,
            feeFacts: consentedFeeFacts,
          });
          throw new Error("Wallet fee facts changed. Review the updated trade cost and retry.");
        }
        if (abortIfAttemptStale()) return;
        const response = await submitBrowserCtfRangeOrder({
          market: latestMarket,
          ticket,
          clientOrderId,
          mintUrl: activeMintUrl,
          mnemonic: walletState.mnemonic,
          comment: signedComment ?? null,
          consentedFeeFacts,
          onScoreTopUpRequired: async (input) => {
            const {
              requiredSats,
              balanceSats,
              recoveryStatus = balanceSats === null ? "unavailable" : "insufficient",
            } = input;
            if (
              !routeStillActive() ||
              currentTradePreviewIdentityKey(routeId) !== capturedPreviewIdentityKey
            ) {
              throw new BrowserCtfRangeScoreTopUpCancelledError();
            }
            const intent = buildPendingTopUpOrderIntent({
              market: latestMarket,
              tradeSelection,
              tradeAmount,
              tradeSide,
              comment,
              baseAsset: "sat",
              required: requiredSats,
              protectedTicket: ticket,
              previewIdentityKey,
              inputGeneration,
            });
            if (intent === null) {
              throw new BrowserCtfRangeScoreTopUpCancelledError();
            }
            cancelActiveScoreTopUp();
            const continuation = new Promise<void>((resolve, reject) => {
              activeScoreTopUpRef.current = { intent, resolve, reject };
            });
            setBalanceAtCheck(balanceSats);
            setPendingTopUpComment(comment?.trim() || undefined);
            setPendingTopUpIntent(intent);
            setTopUpReason({ kind: "score", required: requiredSats, recoveryStatus });
            setTopUpStage("modal");
            await continuation;
            if (
              !routeStillActive() ||
              currentTradePreviewIdentityKey(routeId) !== capturedPreviewIdentityKey
            ) {
              throw new BrowserCtfRangeScoreTopUpCancelledError();
            }
          },
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
          walletId: submittedWalletId,
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
        if (
          !routeStillActive() ||
          currentTradePreviewIdentityKey(routeId) !== capturedPreviewIdentityKey ||
          browserWalletIdFromMnemonic(useWalletStore.getState().mnemonic) !== submittedWalletId
        ) {
          return;
        }
        addOrderSubmitNotifications({
          add: useNotificationsStore.getState().add,
          orderId: response.orderId,
          marketId: ticket.marketId,
          requestedAmountSubunits: ticket.request.amountSubunits,
          remainingAmountSubunits: response.remainingAmountSubunits,
          fillCount: response.fills?.length ?? 0,
          status: response.status,
        });
        // Acceptance consumes only the draft that supplied this ticket. The
        // selected outcome remains available for the next order.
        if (tradeInputGenerationRef.current === inputGeneration) {
          setTradeAmount(0);
          setTradeComment("");
        }
        setTradeSubmitStatus({
          kind: "success",
          message:
            response.status === "resting"
              ? "Order posted to the book."
              : `Order ${response.status.replace("_", " ")}.`,
        });
        if (useSettingsStore.getState().signerBackupState === "needs_backup") {
          setShowBackupReminder(true);
        }
        loadMarket({ showLoading: false });
      } catch (e) {
        if (
          !routeStillActive() ||
          currentTradePreviewIdentityKey(routeId) !== capturedPreviewIdentityKey
        )
          return;
        if (e instanceof BrowserCtfRangeScoreTopUpCancelledError) {
          setTradeSubmitStatus({
            kind: "info",
            message: t("trade.scoreTopUpCancelled"),
          });
          return;
        }
        if (e instanceof BrowserCtfRangeScoreTopUpRequiredError) {
          setTradeSubmitStatus({ kind: "error", message: e.message });
          return;
        }
        if (e instanceof BrowserCtfRangeOrderError && e.code === "source-preparation-failed") {
          setRangeFeePreview(null);
          setFeeFactsRefreshGeneration((current) => current + 1);
          setTradeSubmitStatus({ kind: "error", message: e.message });
          return;
        }
        if (e instanceof Error && e.message.includes("No Nostr signer configured")) {
          setShowNostrAuthModal(true);
          return;
        }
        setTradeSubmitStatus({
          kind: "error",
          message: e instanceof Error ? e.message : "Failed to submit order.",
        });
      } finally {
        if (routeStillActive()) {
          tradeSubmitInFlightRef.current = false;
          setIsTradeSubmitting(false);
        }
      }
    },
    [
      market,
      tradeSelection,
      tradeAmount,
      tradeSide,
      protectedTradeTicket,
      previewIdentityKey,
      tradeRecovery.invalidationKey,
      activeMintUrl,
      loadMarket,
      addPendingTrade,
      cancelActiveScoreTopUp,
      isCurrentRoute,
      rangeFeePreview,
      selectedSellHoldingVersion,
      previewClient,
      invalidatePreviewForMarket,
      t,
    ],
  );

  // Do not gate Buy on share payout or Sell on pooled collections. The source
  // planner rechecks the selected asset and its fees when submission starts.
  const handleTradeConfirm = useCallback(
    async (comment?: string, capturedTicket?: TradeTicket, capturedInputGeneration?: number) => {
      if (!market || !tradeSelection || !tradeAmount) return;
      const ticket = capturedTicket ?? protectedTradeTicket;
      if (ticket === null || ticket === undefined) {
        setTradeSubmitStatus({
          kind: "info",
          message: "Review the current fillable price preview before submitting the order.",
        });
        return;
      }
      const routeId = market.id;
      const generation = routeGenerationRef.current;
      const routeStillActive = () => isCurrentRoute(routeId, generation);
      const capturedPreviewIdentityKey = previewIdentityKey;
      const abortIfAttemptStale = () => {
        if (!routeStillActive()) return true;
        if (currentTradePreviewIdentityKey(routeId) === capturedPreviewIdentityKey) return false;
        tradeSubmitInFlightRef.current = false;
        setIsTradeSubmitting(false);
        return true;
      };
      if (abortIfAttemptStale()) return;
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
      if (abortIfAttemptStale()) return;
      await placeOrder(
        capturedTicket ? comment : (comment ?? (tradeComment.trim() || undefined)),
        ticket,
        capturedInputGeneration,
      );
    },
    [
      market,
      marketBaseAsset,
      tradeSelection,
      tradeAmount,
      tradeComment,
      tradeFaceAmountSubunits,
      tradeSide,
      activeMintUrl,
      marketDivisibility,
      isCurrentRoute,
      placeOrder,
      protectedTradeTicket,
      previewIdentityKey,
    ],
  );

  const handleWalletRequired = useCallback(async () => {
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
    invalidateProtectedTradeAttempt();
    setTradeSubmitStatus({
      kind: "info",
      message: "Trading identity changed. Review the new price preview and confirm again.",
    });
  }, [invalidateProtectedTradeAttempt, market, nostrSignerMode]);

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
    invalidateProtectedTradeAttempt();
    setTradeSubmitStatus({
      kind: "info",
      message: "Trading identity changed. Review the new price preview and confirm again.",
    });
  }, [invalidateProtectedTradeAttempt]);

  // After a successful top-up, close the overlay and place the order once, but
  // only if the wallet proof store now confirms the exact unit/amount captured
  // when the user first clicked Buy. If the market/selection/amount changed
  // while the interstitial was open, require a fresh confirmation instead of
  // auto-executing a stale intent.
  const handleTopUpSuccess = useCallback(async () => {
    const activeScoreTopUp = activeScoreTopUpRef.current;
    const intent = pendingTopUpIntent;

    if (activeScoreTopUp !== null) {
      const routeIsCurrent =
        intent !== null && isCurrentRoute(intent.marketId, routeGenerationRef.current);
      const intentIsCurrent =
        intent !== null &&
        intent === activeScoreTopUp.intent &&
        pendingTopUpOrderIntentMatches(intent, {
          market,
          tradeSelection,
          tradeAmount,
          tradeSide,
          previewIdentityKey,
        });
      if (!routeIsCurrent || !intentIsCurrent) {
        cancelActiveScoreTopUp();
        setTopUpStage("closed");
        setTopUpReason(null);
        setPendingTopUpIntent(null);
        setPendingTopUpComment(undefined);
        if (routeIsCurrent) {
          setTradeSubmitStatus({
            kind: "info",
            message: t("trade.topUpIntentChanged"),
          });
        }
        return;
      }

      if (!activeMintUrl) {
        cancelActiveScoreTopUp();
        setTopUpStage("closed");
        setTopUpReason(null);
        setPendingTopUpIntent(null);
        setPendingTopUpComment(undefined);
        setTradeSubmitStatus({
          kind: "error",
          message: t("trade.selectActiveMintBeforeSubmit"),
        });
        return;
      }

      let balance: number;
      try {
        balance = await getExactUnitBalance(activeMintUrl, "msat");
      } catch {
        if (!isCurrentRoute(intent.marketId, routeGenerationRef.current)) {
          cancelActiveScoreTopUp();
          return;
        }
        setBalanceAtCheck(null);
        setTopUpReason({
          kind: "score",
          required: intent.required,
          recoveryStatus: "unavailable",
        });
        setTradeSubmitStatus({
          kind: "error",
          message: t("insufficientBalance.localBalanceUnavailable"),
        });
        setTopUpStage("modal");
        return;
      }
      if (!isCurrentRoute(intent.marketId, routeGenerationRef.current)) {
        cancelActiveScoreTopUp();
        return;
      }
      const requiredMsat = cashuAmountToMarketSubunits(intent.required, "sat");
      if (balance < requiredMsat) {
        setBalanceAtCheck(balance / 1_000);
        setTopUpReason({
          kind: "score",
          required: intent.required,
          recoveryStatus: "insufficient",
        });
        setTradeSubmitStatus({
          kind: "error",
          message: t("trade.topUpStillInsufficient"),
        });
        setTopUpStage("modal");
        return;
      }

      activeScoreTopUpRef.current = null;
      setTopUpStage("closed");
      setTopUpReason(null);
      setPendingTopUpIntent(null);
      setPendingTopUpComment(undefined);
      activeScoreTopUp.resolve();
      return;
    }

    setTopUpStage("closed");
    setTopUpReason(null);
    setPendingTopUpIntent(null);
    setPendingTopUpComment(undefined);
    if (!intent) return;
    if (!isCurrentRoute(intent.marketId, routeGenerationRef.current)) return;
    if (
      !pendingTopUpOrderIntentMatches(intent, {
        market,
        tradeSelection,
        tradeAmount,
        tradeSide,
        previewIdentityKey,
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
    if (!market || !intent.protectedTicket) {
      setTradeSubmitStatus({
        kind: "info",
        message: t("trade.topUpIntentChanged"),
      });
      return;
    }
    // A balance total cannot prove that this asset's exact source plan is
    // affordable. Reuse normal preparation and its fee-consent check.
    await handleTradeConfirm(
      intent.comment ?? pendingTopUpComment,
      intent.protectedTicket ?? undefined,
      intent.inputGeneration,
    );
  }, [
    activeMintUrl,
    cancelActiveScoreTopUp,
    handleTradeConfirm,
    market,
    pendingTopUpComment,
    pendingTopUpIntent,
    previewIdentityKey,
    isCurrentRoute,
    t,
    tradeAmount,
    tradeSelection,
    tradeSide,
  ]);

  const handleTopUpCancel = useCallback(() => {
    cancelActiveScoreTopUp();
    setTopUpStage("closed");
    setTopUpReason(null);
    setPendingTopUpIntent(null);
    setPendingTopUpComment(undefined);
  }, [cancelActiveScoreTopUp]);

  const handleScoreTopUpRetry = useCallback(() => {
    const activeScoreTopUp = activeScoreTopUpRef.current;
    const intent = pendingTopUpIntent;
    if (activeScoreTopUp === null || intent === null) return;

    const routeIsCurrent = isCurrentRoute(intent.marketId, routeGenerationRef.current);
    const intentIsCurrent =
      intent === activeScoreTopUp.intent &&
      pendingTopUpOrderIntentMatches(intent, {
        market,
        tradeSelection,
        tradeAmount,
        tradeSide,
        previewIdentityKey,
      });
    if (!routeIsCurrent || !intentIsCurrent) {
      cancelActiveScoreTopUp();
      setTopUpStage("closed");
      setTopUpReason(null);
      setPendingTopUpIntent(null);
      setPendingTopUpComment(undefined);
      if (routeIsCurrent) {
        setTradeSubmitStatus({
          kind: "info",
          message: t("trade.topUpIntentChanged"),
        });
      }
      return;
    }

    activeScoreTopUpRef.current = null;
    setTopUpStage("closed");
    setTopUpReason(null);
    setPendingTopUpIntent(null);
    setPendingTopUpComment(undefined);
    activeScoreTopUp.resolve();
  }, [
    cancelActiveScoreTopUp,
    market,
    pendingTopUpIntent,
    previewIdentityKey,
    isCurrentRoute,
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
      const capturedComment = comment ?? (tradeComment.trim() || undefined);
      setBalanceAtCheck(0);
      // New proofs change input fees. Do not invent an exact shortfall from
      // the share payout; normal preparation checks the received funds.
      const required = 0;
      const baseAsset = marketBaseAsset;
      setPendingTopUpComment(capturedComment);
      setPendingTopUpIntent(
        buildPendingTopUpOrderIntent({
          market,
          tradeSelection,
          tradeAmount,
          tradeSide,
          comment: capturedComment,
          baseAsset,
          required,
          protectedTicket: protectedTradeTicket,
          previewIdentityKey,
          inputGeneration: tradeInputGenerationRef.current,
        }),
      );
      setTopUpReason({
        kind: "collateral",
        required,
        baseAsset,
      });
      setTopUpStage("overlay");
    },
    [
      market,
      marketBaseAsset,
      previewIdentityKey,
      protectedTradeTicket,
      tradeAmount,
      tradeComment,
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

  if (routeTransitioning || loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="text-slate-400 animate-pulse">Loading market...</div>
      </div>
    );
  }

  if (visibleError || !market) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
        <div className="text-red-400">{visibleError ?? "Market not found"}</div>
        <button
          onClick={() => void loadMarket({ singleFlight: true })}
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
        tradeComment={tradeComment}
        onTradeCommentChange={(comment) => {
          tradeInputGenerationRef.current += 1;
          clearCompletedTradeNotice();
          setTradeComment(comment);
        }}
        sellHoldings={sellHoldings}
        tradePreview={tradePreview}
        tradeFeeFacts={displayedTradeFeeFacts}
        feeConsentCurrent={feeConsentCurrent}
        tradeSide={tradeSide}
        tradeCapacityPreview={capacityPreview}
        isFullyEmptyBook={isFullyEmptyBook}
        tradeRecovery={tradeRecovery}
        suppressFundingHint={
          isTradeSubmitting ||
          tradeRecovery.suppressFundingHint ||
          (capacityRequest !== null && capacityPreview.status !== "ready")
        }
        onTimeframeChange={handleTimeframeChange}
        onTradeSelect={(selection) => {
          tradeInputGenerationRef.current += 1;
          clearCompletedTradeNotice();
          setTradeSelection(selection);
        }}
        onTradeClear={() => {
          tradeInputGenerationRef.current += 1;
          clearCompletedTradeNotice();
          setTradeSelection(null);
          setTradeAmount(0);
        }}
        onAmountChange={(amount) => {
          tradeInputGenerationRef.current += 1;
          clearCompletedTradeNotice();
          setTradeAmount(amount);
        }}
        onTradeConfirm={handleTradeConfirm}
        tradeSubmitStatus={tradeSubmitStatus}
        onTradeSubmitStatusDismiss={() => setTradeSubmitStatus(null)}
        tradeFeasibility={tradeFeasibility}
        onTradeFeasibilityRetry={() => setFeeFactsRefreshGeneration((current) => current + 1)}
        isTradeSubmitting={isTradeSubmitting}
        onShare={handleShare}
        onTradeSideChange={(side) => {
          tradeInputGenerationRef.current += 1;
          clearCompletedTradeNotice();
          setTradeSide(side);
        }}
        onRelatedMarketClick={handleRelatedMarketClick}
        walletReady={walletReady}
        onWalletRequired={handleWalletRequired}
        onTopUpRequired={handleTradingPanelTopUp}
        onFundingCredited={handleFundingCredited}
        onTradeMarketRefresh={() => loadMarket({ showLoading: false })}
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
              ? formatMarketSubunits(Math.round(amount * 1_000), "sat")
              : formatMarketSubunits(amount, marketBaseAsset)
          }
          recoveryUnavailable={
            topUpReason?.kind === "score" && topUpReason.recoveryStatus === "unavailable"
          }
          onRetry={
            topUpReason?.kind === "score" && topUpReason.recoveryStatus === "unavailable"
              ? handleScoreTopUpRetry
              : undefined
          }
          onCancel={handleTopUpCancel}
          onTopUp={handleStartTopUp}
        />
      )}
      {topUpStage === "overlay" && (
        <TopUpOverlay
          deficit={
            topUpReason?.kind === "score"
              ? Math.round(Math.max(topUpReason.required - (balanceAtCheck ?? 0), 0) * 1_000)
              : Math.max((topUpReason?.required ?? tradeAmount) - (balanceAtCheck ?? 0), 0)
          }
          baseAsset={topUpReason?.kind === "score" ? "sat" : marketBaseAsset}
          proofUnit={topUpReason?.kind === "score" ? "msat" : undefined}
          minimumDescription={
            topUpReason?.kind === "score"
              ? t("topUp.scoreMinimumDesc", {
                  sats: formatMarketSubunits(
                    Math.round(Math.max(topUpReason.required - (balanceAtCheck ?? 0), 0) * 1_000),
                    "sat",
                  ),
                })
              : undefined
          }
          onSuccess={handleTopUpSuccess}
          onCancel={handleTopUpCancel}
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
          onDismiss={() => setShowBackupReminder(false)}
          onOpenSettings={() => navigate("/settings?category=nostr")}
        />
      )}
    </>
  );
}
