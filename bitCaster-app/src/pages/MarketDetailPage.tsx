import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useParams, useNavigate } from "react-router";
import { MarketDetail } from "@/components/market-detail";
import { InsufficientBalanceModal } from "@/components/shared/InsufficientBalanceModal";
import { NostrAuthRequiredModal } from "@/components/shared/NostrAuthRequiredModal";
import { TopUpOverlay } from "@/components/market-detail/TopUpOverlay";
import { useShareMarket } from "@/components/market-detail/useShareMarket";
import { fetchMarketDetail, fetchOrderBook, submitOrder } from "@/lib/markets";
import { promoteFillsToActiveSwaps } from "@/lib/orderStatus";
import { buildTradeTicket, TradeTicketError } from "@/lib/tradeTicket";
import { assertNever } from "@/lib/enumDiscipline";
import { generateEphemeralKeyPair } from "@/lib/ephemeral-key";
import { addOrderSubmitNotifications } from "@/lib/orderNotifications";
import {
  outcomeLabels,
  outcomeSetIdsForMarketBooks,
  outcomeSetMarketId,
  resolveOutcomeSets,
} from "@/lib/outcomeSets";
import { getBalance, useBalance, useWalletStore } from "@/stores/wallet";
import { usePendingTradesStore } from "@/stores/pendingTrades";
import { useNotificationsStore } from "@/stores/notifications";
import type {
  MarketDetail as MarketDetailType,
  ChartTimeframe,
  ChartType,
  TradeSelection,
  TradePreview,
  TradeSide,
  OrderType,
  LimitOrderPreview,
} from "@/types/market-detail";

type TopUpStage = "closed" | "modal" | "overlay";

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

function needsEngineDetailRefresh(market: MarketDetailType): boolean {
  return market.closingDate == null || market.state == null;
}

function categoryTagIds(market: MarketDetailType): string[] {
  return market.categoryTags.map((tag) => tag.id).sort();
}

function marketShapeMatches(
  current: MarketDetailType,
  latest: MarketDetailType,
): boolean {
  return (
    current.title === latest.title &&
    current.type === latest.type &&
    JSON.stringify(outcomeLabels(current)) ===
      JSON.stringify(outcomeLabels(latest)) &&
    JSON.stringify(categoryTagIds(current)) ===
      JSON.stringify(categoryTagIds(latest))
  );
}

export async function fetchMarketDetailWithBooks(
  conditionId: string,
): Promise<MarketDetailType> {
  let detail = await fetchMarketDetail(conditionId);
  const outcomeSetIds = outcomeSetIdsForMarketBooks(detail);
  if (outcomeSetIds.length === 0) return detail;

  try {
    const entries = await Promise.all(
      outcomeSetIds.map(async (outcomeSetId) => [
        outcomeSetId,
        await fetchOrderBook(outcomeSetMarketId(conditionId, outcomeSetId)),
      ] as const),
    );
    const outcomeOrderBooks = Object.fromEntries(entries);
    const defaultOrderBook =
      outcomeOrderBooks[outcomeSetIds[0]] ?? detail.orderBook;
    detail = {
      ...detail,
      orderBook: defaultOrderBook,
      outcomeOrderBooks,
    };
  } catch {
    // Order book fetch is best-effort; limit orders can still rest.
  }

  return detail;
}

export function MarketDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const setupComplete = useWalletStore((s) => s.setupComplete);
  const activeMintUrl = useWalletStore((s) => s.activeMintUrl);
  const addPendingTrade = usePendingTradesStore((s) => s.add);
  // Live balance for the active mint so the trading panel can show
  // "You have N sats" before the user tries to confirm (matches the
  // pattern cashu.me uses to surface available funds).
  const activeMintBalance = useBalance(activeMintUrl);

  // Data state
  const [market, setMarket] = useState<MarketDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // UI state
  const [chartTimeframe, setChartTimeframe] = useState<ChartTimeframe>("7d");
  const [chartType, setChartType] = useState<ChartType>("price");
  const [tradeSelection, setTradeSelection] = useState<TradeSelection | null>(
    null,
  );
  const [tradeAmount, setTradeAmount] = useState(0);
  const [tradeSide, setTradeSide] = useState<TradeSide>("buy");
  const [orderType, setOrderType] = useState<OrderType>("market");
  const [limitPrice, setLimitPrice] = useState(50);
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
  const [balanceAtCheck, setBalanceAtCheck] = useState(0);
  const [showNostrAuthModal, setShowNostrAuthModal] = useState(false);

  // Load market data
  const loadMarket = useCallback(() => {
    if (!id) return;
    setLoading(true);
    setError(null);

    fetchMarketDetailWithBooks(id)
      .then(setMarket)
      .catch(() => {
        setError(
          "Failed to load market. Please check that the mint is running.",
        );
      })
      .finally(() => {
        setLoading(false);
      });
  }, [id]);

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
        const latest = await fetchMarketDetailWithBooks(id);
        if (cancelled) return;
        setMarket((current) => {
          if (!current || !marketShapeMatches(current, latest)) return current;
          if (
            current.closingDate === latest.closingDate &&
            current.state === latest.state &&
            needsEngineDetailRefresh(latest)
          ) {
            return current;
          }
          return latest;
        });
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

  // Computed trade preview
  const tradePreview = useMemo<TradePreview | null>(() => {
    if (!tradeSelection || !tradeAmount || tradeAmount <= 0 || !market)
      return null;
    if (orderType === "limit") return null;

    const feePercent = market.creator.feePercent;
    const creatorFee = Math.round((tradeAmount * feePercent) / 100);
    return {
      amount: tradeAmount,
      predictedOdds: 50, // Placeholder — real computation needs order book depth
      priceImpact: 0,
      potentialPayout: Math.round((tradeAmount * 100) / 50),
      creatorFee,
      platformFee: 0,
      totalCost: tradeAmount,
    };
  }, [tradeSelection, tradeAmount, market, orderType]);

  // Computed limit order preview
  const limitOrderPreview = useMemo<LimitOrderPreview | null>(() => {
    if (!tradeSelection || !tradeAmount || tradeAmount <= 0 || !market)
      return null;
    if (orderType !== "limit") return null;

    const feePercent = market.creator.feePercent;
    const creatorFee = Math.round((tradeAmount * feePercent) / 100);
    return {
      limitPrice,
      amount: tradeAmount,
      sharesIfFilled:
        limitPrice > 0 ? Math.round((tradeAmount * 10000) / limitPrice) : 0,
      creatorFee,
      platformFee: 0,
      totalCost: tradeAmount,
    };
  }, [tradeSelection, tradeAmount, market, orderType, limitPrice]);

  // Submit the order. Assumes wallet is set up and balance has been checked —
  // callers that can't promise that must route through `handleTradeConfirm`.
  const placeOrder = useCallback(async () => {
    if (!market || !tradeSelection || !tradeAmount) return;
    if (tradeSubmitInFlightRef.current) return;
    tradeSubmitInFlightRef.current = true;
    setIsTradeSubmitting(true);
    setTradeSubmitStatus(null);
    let latestMarket: MarketDetailType;
    try {
      latestMarket = await fetchMarketDetailWithBooks(market.id);
      setMarket(latestMarket);
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
        message:
          "Market metadata changed before submission. Review the market and try again.",
      });
      tradeSubmitInFlightRef.current = false;
      setIsTradeSubmitting(false);
      return;
    }

    let ticket: ReturnType<typeof buildTradeTicket>;
    try {
      const outcomeSets = resolveOutcomeSets(latestMarket, tradeSelection);
      if (!outcomeSets) {
        throw new TradeTicketError(
          "missing-selection",
          "Choose an outcome before placing an order.",
        );
      }
      ticket = buildTradeTicket({
        market: latestMarket,
        selection: tradeSelection,
        amountSats: tradeAmount,
        side: tradeSide,
        orderType,
        limitPrice,
        orderBook:
          latestMarket.outcomeOrderBooks?.[
            outcomeSets.selectedOutcomeSetId
          ] ?? null,
        complementaryOrderBook:
          latestMarket.outcomeOrderBooks?.[
            outcomeSets.complementOutcomeSetId
          ] ?? null,
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
    try {
      const response = await submitOrder(ticket.marketId, {
        ...ticket.request,
        ephemeralPubkey: ephemeral.pubkey,
      });
      // Only persist the privkey once the engine has accepted the order.
      // Otherwise we accumulate orphaned keys on every failed submission.
      addPendingTrade({
        orderId: response.orderId,
        marketId: ticket.marketId,
        ephemeralPubkey: ephemeral.pubkey,
        ephemeralPrivkey: ephemeral.privkey,
        submittedAt: Date.now(),
      });
      promoteFillsToActiveSwaps(response.fills ?? [], {
        orderId: response.orderId,
        marketId: ticket.marketId,
        ephemeralPubkey: ephemeral.pubkey,
        ephemeralPrivkey: ephemeral.privkey,
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
      loadMarket();
    } catch (e) {
      if (
        e instanceof Error &&
        e.message.includes("No Nostr signer configured")
      ) {
        setShowNostrAuthModal(true);
        tradeSubmitInFlightRef.current = false;
        setIsTradeSubmitting(false);
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
  }, [
    market,
    tradeSelection,
    tradeAmount,
    tradeSide,
    orderType,
    limitPrice,
    loadMarket,
    addPendingTrade,
  ]);

  // Gate the order submission on sufficient balance. Reads the balance at
  // click-time (not via `useBalance`) so we don't race a stale live-query
  // subscription after a top-up.
  const handleTradeConfirm = useCallback(async () => {
    if (!market || !tradeSelection || !tradeAmount) return;
    if (tradeSubmitInFlightRef.current) return;
    tradeSubmitInFlightRef.current = true;
    const requiredSats = tradeAmount; // totalCost for FAK today; PR2+ refines
    setIsTradeSubmitting(true);
    try {
      const current = await getBalance(activeMintUrl);
      if (current < requiredSats) {
        setBalanceAtCheck(current);
        setTopUpStage("modal");
        return;
      }
    } catch (error) {
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
    await placeOrder();
  }, [market, tradeSelection, tradeAmount, activeMintUrl, placeOrder]);

  // After a successful top-up, close the overlay and place the order.
  // TopUpOverlay only invokes onSuccess once proofs have been written to the
  // store, so the balance is guaranteed to cover `tradeAmount` by the time we
  // get here — no re-read needed.
  const handleTopUpSuccess = useCallback(async () => {
    setTopUpStage("closed");
    await placeOrder();
  }, [placeOrder]);

  const handleRelatedMarketClick = useCallback(
    (marketId: string) => {
      navigate(`/markets/${marketId}`);
    },
    [navigate],
  );

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
          onClick={loadMarket}
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
        chartType={chartType}
        tradeSelection={tradeSelection}
        tradeAmount={tradeAmount}
        tradePreview={tradePreview}
        tradeSide={tradeSide}
        orderType={orderType}
        limitOrderPreview={limitOrderPreview}
        limitPrice={limitPrice}
        onTimeframeChange={setChartTimeframe}
        onChartTypeChange={setChartType}
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
        onLimitPriceChange={setLimitPrice}
        onRelatedMarketClick={handleRelatedMarketClick}
        walletReady={setupComplete}
        walletBalanceSats={activeMintBalance}
      />
      {topUpStage === "modal" && (
        <InsufficientBalanceModal
          balance={balanceAtCheck}
          required={tradeAmount}
          onCancel={() => setTopUpStage("closed")}
          onTopUp={() => setTopUpStage("overlay")}
        />
      )}
      {topUpStage === "overlay" && (
        <TopUpOverlay
          deficit={Math.max(tradeAmount - balanceAtCheck, 0)}
          onSuccess={handleTopUpSuccess}
          onCancel={() => setTopUpStage("closed")}
        />
      )}
      {showNostrAuthModal && (
        <NostrAuthRequiredModal onClose={() => setShowNostrAuthModal(false)} />
      )}
    </>
  );
}
