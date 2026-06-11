import { useEffect, useState, useCallback, useMemo, useRef } from "react";
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
  fetchMarketDetail,
  fetchMarketComments,
  fetchMarketPriceHistory,
  fetchOrderBook,
  getParticipationScore,
  signTradeComment,
  submitOrder,
} from "@/lib/markets";
import { promoteFillsToActiveSwaps } from "@/lib/orderStatus";
import { buildTradeTicket, TradeTicketError } from "@/lib/tradeTicket";
import {
  computeTradeCost,
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
import { ensureParticipationScoreForNextMatch } from "@/lib/participationScorePayment";
import {
  outcomeLabels,
  outcomeSetIdsForMarketBooks,
  outcomeSetMarketId,
  resolveOutcomeSets,
} from "@/lib/outcomeSets";
import { useMarketStatusLive } from "@/hooks/useMarketStatusLive";
import {
  getOutcomeProofs,
  releaseProofReservation,
} from "@/stores/proof-db";
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
} from "@/types/market-detail";

type TopUpStage = "closed" | "modal" | "overlay";
type TopUpReason =
  | { kind: "collateral"; required: number; baseAsset: string }
  | { kind: "score"; required: number };

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

function mergeMarketRefresh(
  current: MarketDetailType | null,
  detail: MarketDetailType,
): MarketDetailType {
  if (!current || current.id !== detail.id) return detail;
  return {
    ...current,
    ...detail,
    priceHistory: current.priceHistory,
    comments: current.comments,
    relatedMarkets: current.relatedMarkets,
    recentTrades: current.recentTrades,
  };
}

export async function fetchMarketDetailWithBooks(
  conditionId: string,
): Promise<MarketDetailType> {
  let detail = await fetchMarketDetail(conditionId);
  const books = await fetchMarketOrderBooks(conditionId, detail);
  detail = { ...detail, ...books };
  return detail;
}

async function fetchMarketOrderBooks(
  conditionId: string,
  detail: MarketDetailType,
): Promise<Pick<MarketDetailType, "orderBook" | "outcomeOrderBooks">> {
  const outcomeSetIds = outcomeSetIdsForMarketBooks(detail);
  if (outcomeSetIds.length === 0) {
    return {
      orderBook: detail.orderBook,
      outcomeOrderBooks: detail.outcomeOrderBooks,
    };
  }

  try {
    const entries = await Promise.all(
      outcomeSetIds.map(
        async (outcomeSetId) =>
          [
            outcomeSetId,
            await fetchOrderBook(outcomeSetMarketId(conditionId, outcomeSetId)),
          ] as const,
      ),
    );
    const outcomeOrderBooks = Object.fromEntries(entries);
    const defaultOrderBook =
      outcomeOrderBooks[outcomeSetIds[0]] ?? detail.orderBook;
    return { orderBook: defaultOrderBook, outcomeOrderBooks };
  } catch {
    // Order book fetch is best-effort; limit orders can still rest.
  }

  return {
    orderBook: detail.orderBook,
    outcomeOrderBooks: detail.outcomeOrderBooks,
  };
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
  const [market, setMarket] = useState<MarketDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const marketBaseAsset = normalizeMarketBaseAsset(market?.baseAsset);

  // UI state
  const [chartTimeframe, setChartTimeframe] = useState<ChartTimeframe>("7d");
  const [tradeSelection, setTradeSelection] = useState<TradeSelection | null>(
    null,
  );
  const [tradeAmount, setTradeAmount] = useState(0);
  const [tradeSide, setTradeSide] = useState<TradeSide>("buy");
  const [orderType, setOrderType] = useState<OrderType>("market");
  const [preflightSplit, setPreflightSplit] = useState(true);
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
  const loadMarket = useCallback((options: { showLoading?: boolean } = {}) => {
    if (!id) return;
    const showLoading = options.showLoading ?? true;
    if (showLoading) setLoading(true);
    setError(null);

    fetchMarketDetail(id)
      .then((detail) => {
        setMarket((current) => mergeMarketRefresh(current, detail));
        void fetchMarketOrderBooks(id, detail).then((books) => {
          setMarket((current) =>
            current?.id === id ? { ...current, ...books } : current,
          );
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
  }, [id]);

  // Secondary live close-detection: subscribe to MarketStatusChanged pushes
  // while this detail page is mounted. Best-effort — fires only when the client
  // is joined to the market hub (via OrderBookSection). Feeds the same
  // notification + reconcile-state path as the primary boot reconcile.
  const handleLiveStatus = useCallback(
    () => loadMarket({ showLoading: false }),
    [loadMarket],
  );
  useMarketStatusLive(market?.id ?? null, handleLiveStatus);

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
          setMarket((current) =>
            current?.id === market.id
              ? applyMarketPriceHistory(current, history)
              : current,
          );
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
          setMarket((current) =>
            current?.id === market.id
              ? applyMarketComments(current, comments)
              : current,
          );
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

  // Worst-case effective price for a MARKET order, mirroring the wire price
  // `buildTradeTicket`/`marketPriceFor` resolves (buy crosses up to
  // divisibility - 1, sell down to 1). The market preview's cost basis derives
  // from this price so creator fee + total cost are computed on the quote, not
  // the face amount.
  const marketDivisibility = normalizeMarketDivisibility(market?.divisibility);
  const marketEffectivePrice =
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

    const cost = computeTradeCost({
      displayShares: tradeAmount,
      price: marketEffectivePrice,
      feePercent: market.creator.feePercent,
      mintInputFeePpk: activeMintInputFeePpk,
    });
    return {
      amount: tradeAmount,
      predictedOdds: 50, // Placeholder — real computation needs order book depth
      priceImpact: 0,
      quoteSats: cost.quoteSats,
      mintFee: cost.mintFee,
      potentialPayout: tradeFaceAmount,
      creatorFee: cost.creatorFee,
      engineScoreFeeSats,
      totalCost: cost.totalCost,
    };
  }, [
    tradeSelection,
    tradeAmount,
    market,
    orderType,
    marketEffectivePrice,
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
    const price = orderType === "limit" ? limitPrice : marketEffectivePrice;
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
    marketEffectivePrice,
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
        latestMarket = await fetchMarketDetailWithBooks(market.id);
        setMarket(latestMarket);
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
        const resolvedOutcomeSets = resolveOutcomeSets(
          latestMarket,
          tradeSelection,
        );
        if (!resolvedOutcomeSets) {
          throw new TradeTicketError(
            "missing-selection",
            "Choose an outcome before placing an order.",
          );
        }
        outcomeSets = resolvedOutcomeSets;
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
          orderBook:
            latestMarket.outcomeOrderBooks?.[
              outcomeSets.publicOutcomeSetId
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
      let preparedPreflightSplit: PreparedPreflightSplit | undefined;
      let submitAttempted = false;
      try {
        const selectedBook =
          latestMarket.outcomeOrderBooks?.[outcomeSets.publicOutcomeSetId] ??
          null;
        const complementBook =
          latestMarket.outcomeOrderBooks?.[
            outcomeSets.complementOutcomeSetId
          ] ?? null;
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
      const requiredSubunits =
        tradeSide === "sell" ? tradeFaceAmount : requiredBuyCost;
      setIsTradeSubmitting(true);
      try {
        const current =
          tradeSide === "sell"
            ? await getSellSideBalance(activeMintUrl, market, tradeSelection)
            : await getBalance(activeMintUrl, { baseAsset: marketBaseAsset });
        if (current < requiredSubunits) {
          setBalanceAtCheck(current);
          setPendingTopUpComment(comment?.trim() || undefined);
          setTopUpReason({
            kind: "collateral",
            required: requiredSubunits,
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
      placeOrder,
    ],
  );

  const handleWalletRequired = useCallback(async (comment?: string) => {
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
  }, [handleTradeConfirm, nostrSignerMode]);

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
