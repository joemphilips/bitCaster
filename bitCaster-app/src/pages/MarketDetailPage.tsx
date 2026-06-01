import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useParams, useNavigate } from "react-router";
import { MarketDetail } from "@/components/market-detail";
import { InsufficientBalanceModal } from "@/components/shared/InsufficientBalanceModal";
import { NostrAuthRequiredModal } from "@/components/shared/NostrAuthRequiredModal";
import { NostrAccountChooserModal } from "@/components/shared/NostrAccountChooserModal";
import { BackupSecretsReminderModal } from "@/components/shared/BackupSecretsReminderModal";
import { TopUpOverlay } from "@/components/market-detail/TopUpOverlay";
import { useShareMarket } from "@/components/market-detail/useShareMarket";
import {
  applyMarketPriceHistory,
  fetchMarketDetail,
  fetchMarketPriceHistory,
  fetchOrderBook,
  signTradeComment,
  submitOrder,
} from "@/lib/markets";
import { promoteFillsToActiveSwaps } from "@/lib/orderStatus";
import { buildTradeTicket, TradeTicketError } from "@/lib/tradeTicket";
import {
  computeLimitOrderPreview,
  computeTradeCost,
  displaySharesToFaceSats,
} from "@/lib/tradeCostPreview";
import { assertNever } from "@/lib/enumDiscipline";
import { generateEphemeralKeyPair } from "@/lib/ephemeral-key";
import { addOrderSubmitNotifications } from "@/lib/orderNotifications";
import { diagnoseProofStates } from "@/lib/proofDiagnostics";
import {
  reconcileCompletedPreflightProofOperations,
  runPreflightMintSingleFlight,
} from "@/lib/preflightProofRecovery";
import {
  outcomeLabels,
  outcomeSetIdsForMarketBooks,
  outcomeSetMarketId,
  resolveOutcomeSets,
} from "@/lib/outcomeSets";
import {
  addProofs,
  getBaseProofs,
  getOutcomeProofs,
  getProofOperation,
  markProofOperationCompleted,
  prepareProofOperation,
  releaseProofReservation,
  replaceProofs,
  reserveProofs,
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
import {
  selectCollateralForCtfSplit,
  splitRegularProofsWithOperation,
  splitRootCompleteSetForPreflightOrder,
  type CtfProofOperationRecord,
  type CtfProofOperationStore,
} from "@/lib/ctfSplit";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import type { Proof } from "@cashu/cashu-ts";
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
  );
  return proofs.reduce((sum, proof) => sum + amountToNumber(proof.amount), 0);
}

interface PreparedPreflightSplit {
  reservationId: string;
  conditionId: string;
  keepOutcomeSetId: string;
  lockOutcomeSetId: string;
  amountSats: number;
}

interface PreparedCollateralLot {
  inputs: Proof[];
  spentSecrets: string[];
  keepProofs: Proof[];
}

async function prepareCollateralLotForCtfSplit(input: {
  mintUrl: string;
  available: Proof[];
  faceAmountSats: number;
  reservationId: string;
  lotIndex: number;
}): Promise<PreparedCollateralLot> {
  const operationId = `${input.reservationId}:regular-split:${input.lotIndex}`;
  const existingRegularSplit = await getProofOperation(operationId);
  if (existingRegularSplit) {
    const wallet = await useWalletStore.getState().getWallet(input.mintUrl);
    const regularSplit = await splitRegularProofsWithOperation({
      mintUrl: input.mintUrl,
      operationId,
      wallet,
      proofs: [],
      amountSats: input.faceAmountSats,
      proofOperationStore: ctfProofOperationStore,
    });
    const exact = await selectCollateralForCtfSplit(
      input.mintUrl,
      regularSplit.send,
      input.faceAmountSats,
    );
    await replaceProofs(
      regularSplit.spent.map((proof) => proof.secret),
      [
        ...regularSplit.keep.map((proof) => ({
          ...proof,
          mintUrl: input.mintUrl,
        })),
        ...exact.inputs.map((proof) => ({
          ...proof,
          mintUrl: input.mintUrl,
          reservedBy: input.reservationId,
        })),
      ],
    );
    return {
      inputs: exact.inputs,
      spentSecrets: exact.inputs.map((proof) => proof.secret),
      keepProofs: regularSplit.keep,
    };
  }

  try {
    const exact = await selectCollateralForCtfSplit(
      input.mintUrl,
      input.available,
      input.faceAmountSats,
    );
    await diagnoseProofStates({
      label: "preflight:exact-collateral",
      mintUrl: input.mintUrl,
      proofs: exact.inputs,
      extra: {
        lotIndex: input.lotIndex,
        faceAmountSats: input.faceAmountSats,
      },
    });
    await reserveProofs(
      exact.inputs.map((proof) => proof.secret),
      input.reservationId,
    );
    return {
      inputs: exact.inputs,
      spentSecrets: exact.inputs.map((proof) => proof.secret),
      keepProofs: [],
    };
  } catch {
    // No exact net input is available. Split larger/fragmented regular sats
    // into a gross input that will net to the requested CTF face amount.
  }

  const wallet = await useWalletStore.getState().getWallet(input.mintUrl);
  if (!wallet.selectProofsToSend || !wallet.getFeesForProofs) {
    throw new Error(
      "Cashu wallet adapter does not support fee-aware proof selection.",
    );
  }
  const selected = wallet.selectProofsToSend(
    input.available,
    input.faceAmountSats,
    true,
    false,
  );
  if (selected.send.length === 0) {
    throw new Error(
      "No regular collateral proofs are available for CTF split.",
    );
  }
  await diagnoseProofStates({
    label: "preflight:regular-split-inputs",
    mintUrl: input.mintUrl,
    proofs: selected.send,
    wallet,
    extra: {
      lotIndex: input.lotIndex,
      faceAmountSats: input.faceAmountSats,
    },
  });
  const grossCtfInputSats =
    input.faceAmountSats +
    amountToNumber(wallet.getFeesForProofs([selected.send[0]]));
  const regularSplit = await splitRegularProofsWithOperation({
    mintUrl: input.mintUrl,
    operationId,
    wallet,
    proofs: selected.send,
    amountSats: grossCtfInputSats,
    proofOperationStore: ctfProofOperationStore,
  });
  const exact = await selectCollateralForCtfSplit(
    input.mintUrl,
    regularSplit.send,
    input.faceAmountSats,
  );
  await replaceProofs(
    regularSplit.spent.map((proof) => proof.secret),
    [
      ...regularSplit.keep.map((proof) => ({
        ...proof,
        mintUrl: input.mintUrl,
      })),
      ...exact.inputs.map((proof) => ({
        ...proof,
        mintUrl: input.mintUrl,
        reservedBy: input.reservationId,
      })),
    ],
  );
  return {
    inputs: exact.inputs,
    spentSecrets: exact.inputs.map((proof) => proof.secret),
    keepProofs: regularSplit.keep,
  };
}

const ctfProofOperationStore: CtfProofOperationStore = {
  getProofOperation: async (operationId) =>
    (await getProofOperation(operationId)) as CtfProofOperationRecord | null,
  prepareProofOperation: async (input) =>
    (await prepareProofOperation(input)) as CtfProofOperationRecord,
  markProofOperationCompleted: async (operationId, resultProofs) =>
    (await markProofOperationCompleted(
      operationId,
      resultProofs,
    )) as CtfProofOperationRecord,
};

async function preparePreflightSplitForLimitBuy(input: {
  mintUrl: string;
  market: MarketDetailType;
  selectedOutcomeSetId: string;
  complementOutcomeSetId: string;
  amountSats: number;
  reservationId: string;
}): Promise<PreparedPreflightSplit> {
  if (input.amountSats % 100 !== 0) {
    throw new Error("Pre-flight split requires 100 sat order increments.");
  }

  let available: Proof[] = await getBaseProofs(input.mintUrl);
  const spentSecrets = new Set<string>();
  const proofsToStore: Parameters<typeof addProofs>[0] = [];
  let resolvedKeepOutcomeSetId = input.selectedOutcomeSetId;
  let resolvedLockOutcomeSetId = input.complementOutcomeSetId;

  try {
    for (let offset = 0; offset < input.amountSats; offset += 100) {
      const lotIndex = offset / 100;
      const collateral = await prepareCollateralLotForCtfSplit({
        mintUrl: input.mintUrl,
        available,
        faceAmountSats: 100,
        reservationId: input.reservationId,
        lotIndex,
      });
      const operationId = `${input.reservationId}:ctf-split:${lotIndex}`;
      await diagnoseProofStates({
        label: "preflight:ctf-split-inputs-before",
        mintUrl: input.mintUrl,
        proofs: collateral.inputs,
        extra: {
          lotIndex,
          conditionId: input.market.id,
          operationId,
        },
      });
      const split = await splitRootCompleteSetForPreflightOrder({
        mintUrl: input.mintUrl,
        conditionId: input.market.id,
        collateralProofs: collateral.inputs,
        amountSats: 100,
        keepOutcomeSetId: input.selectedOutcomeSetId,
        lockOutcomeSetId: input.complementOutcomeSetId,
        operationId,
        proofOperationStore: ctfProofOperationStore,
      });

      resolvedKeepOutcomeSetId = split.resolvedKeepOutcomeSetId;
      resolvedLockOutcomeSetId = split.resolvedLockOutcomeSetId;
      for (const proof of split.spentSatProofs) spentSecrets.add(proof.secret);
      for (const [outcomeCollection, proofs] of Object.entries(
        split.proofsByCollection,
      )) {
        proofsToStore.push(
          ...proofs.map((proof) => ({
            ...proof,
            mintUrl: input.mintUrl,
            conditionId: input.market.id,
            outcomeCollection,
            marketId: `${input.market.id}-${outcomeCollection}`,
            reservedBy: input.reservationId,
          })),
        );
      }
      available = available
        .filter((proof) => !collateral.spentSecrets.includes(proof.secret))
        .concat(collateral.keepProofs);
    }
  } catch (err) {
    await releaseProofReservation(input.reservationId);
    throw err;
  }

  await replaceProofs([...spentSecrets], proofsToStore);

  return {
    reservationId: input.reservationId,
    conditionId: input.market.id,
    keepOutcomeSetId: resolvedKeepOutcomeSetId,
    lockOutcomeSetId: resolvedLockOutcomeSetId,
    amountSats: input.amountSats,
  };
}

export function MarketDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
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
  const [balanceAtCheck, setBalanceAtCheck] = useState(0);
  // Required spend snapshot taken when the gate tripped, so the modal/overlay
  // show the same derived cost the gate compared against (P22 C LOW).
  const [requiredAtCheck, setRequiredAtCheck] = useState(0);
  const [showNostrAuthModal, setShowNostrAuthModal] = useState(false);
  const [showNostrChooser, setShowNostrChooser] = useState(false);
  const [lazySetupError, setLazySetupError] = useState<string | null>(null);
  const [lazySetupCreating, setLazySetupCreating] = useState(false);
  const [showBackupReminder, setShowBackupReminder] = useState(false);
  const [pendingTopUpComment, setPendingTopUpComment] = useState<
    string | undefined
  >();
  const [lazySetupComment, setLazySetupComment] = useState<
    string | undefined
  >();

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

  // Worst-case effective price for a MARKET order, mirroring the wire price
  // `buildTradeTicket`/`marketPriceFor` resolves (buy crosses up to 99, sell
  // down to 1). The market preview's cost basis derives from this price so the
  // creator fee + Total cost are computed on the QUOTE, not the face amount.
  const marketEffectivePrice = tradeSide === "sell" ? 1 : 99;

  // Computed trade preview (market orders). `tradeAmount` is user-facing
  // display shares; boundary calls convert it to protocol face sats via
  // `displaySharesToFaceSats`.
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
      potentialPayout: displaySharesToFaceSats(tradeAmount),
      creatorFee: cost.creatorFee,
      platformFee: 0,
      totalCost: cost.totalCost,
    };
  }, [
    tradeSelection,
    tradeAmount,
    market,
    orderType,
    marketEffectivePrice,
    activeMintInputFeePpk,
  ]);

  // Computed limit order preview.
  //
  // `tradeAmount` is user-facing display shares. One display share maps to 100
  // protocol face sats, so the displayed quote is simply shares × limit price.
  const limitOrderPreview = useMemo<LimitOrderPreview | null>(() => {
    if (!tradeSelection || !tradeAmount || tradeAmount <= 0 || !market)
      return null;
    if (orderType !== "limit") return null;

    return computeLimitOrderPreview({
      displayShares: tradeAmount,
      limitPrice,
      feePercent: market.creator.feePercent,
      mintInputFeePpk: activeMintInputFeePpk,
    });
  }, [
    tradeSelection,
    tradeAmount,
    market,
    orderType,
    limitPrice,
    activeMintInputFeePpk,
  ]);

  // Derived spend a BUY must cover, used by the pre-submit balance gate and the
  // top-up modal/overlay. Sells are gated on the protocol face sats represented
  // by the display share count.
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
  ]);

  // Submit the order. Assumes wallet is set up and balance has been checked —
  // callers that can't promise that must route through `handleTradeConfirm`.
  const placeOrder = useCallback(async (comment?: string) => {
    if (!market || !tradeSelection || !tradeAmount) return;
    const faceAmountSats = displaySharesToFaceSats(tradeAmount);
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
    let outcomeSets: NonNullable<ReturnType<typeof resolveOutcomeSets>>;
    try {
      const resolvedOutcomeSets = resolveOutcomeSets(latestMarket, tradeSelection);
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
        amountSats: faceAmountSats,
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
    let preparedPreflightSplit: PreparedPreflightSplit | undefined;
    let submitAttempted = false;
    try {
      const selectedBook =
        latestMarket.outcomeOrderBooks?.[outcomeSets.selectedOutcomeSetId] ??
        null;
      const complementBook =
        latestMarket.outcomeOrderBooks?.[outcomeSets.complementOutcomeSetId] ??
        null;
      const directCross =
        selectedBook?.asks[0] != null &&
        selectedBook.asks[0].price <= ticket.request.price;
      const complementaryCross =
        complementBook?.bids[0] != null &&
        complementBook.bids[0].price + ticket.request.price >= 100;
      const shouldPreflightSplit =
        preflightSplit &&
        tradeSide === "buy" &&
        orderType === "limit" &&
        !directCross &&
        !complementaryCross;
      if (shouldPreflightSplit) {
        if (!activeMintUrl) {
          throw new Error("Select an active mint before using pre-flight split.");
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
              amountSats: faceAmountSats,
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
      // Only persist the privkey once the engine has accepted the order.
      // Otherwise we accumulate orphaned keys on every failed submission.
      addPendingTrade({
        orderId: response.orderId,
        marketId: ticket.marketId,
        ephemeralPubkey: ephemeral.pubkey,
        ephemeralPrivkey: ephemeral.privkey,
        submittedAt: Date.now(),
        preflightSplit: preparedPreflightSplit,
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
      if (
        useWalletStore.getState().walletBackupState === "needs_backup" ||
        useSettingsStore.getState().signerBackupState === "needs_backup"
      ) {
        setShowBackupReminder(true);
      }
      loadMarket();
    } catch (e) {
      if (preparedPreflightSplit && !submitAttempted) {
        await releaseProofReservation(preparedPreflightSplit.reservationId);
      }
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
  const handleTradeConfirm = useCallback(async (comment?: string) => {
    if (!market || !tradeSelection || !tradeAmount) return;
    if (tradeSubmitInFlightRef.current) return;
    tradeSubmitInFlightRef.current = true;
    const faceAmountSats = displaySharesToFaceSats(tradeAmount);
    const requiredSats = tradeSide === "sell" ? faceAmountSats : requiredBuyCost;
    setIsTradeSubmitting(true);
    try {
      const current =
        tradeSide === "sell"
          ? await getSellSideBalance(activeMintUrl, market, tradeSelection)
          : await getBalance(activeMintUrl);
      if (current < requiredSats) {
        setRequiredAtCheck(requiredSats);
        setBalanceAtCheck(current);
        setPendingTopUpComment(comment?.trim() || undefined);
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
    await placeOrder(comment);
  }, [
    market,
    tradeSelection,
    tradeAmount,
    tradeSide,
    requiredBuyCost,
    activeMintUrl,
    placeOrder,
  ]);

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
    const comment = pendingTopUpComment;
    setPendingTopUpComment(undefined);
    await placeOrder(comment);
  }, [pendingTopUpComment, placeOrder]);

  const handleRelatedMarketClick = useCallback(
    (marketId: string) => {
      navigate(`/markets/${marketId}`);
    },
    [navigate],
  );

  const handleTimeframeChange = useCallback(
    async (timeframe: ChartTimeframe) => {
      setChartTimeframe(timeframe);
      if (!market) return;
      try {
        const history = await fetchMarketPriceHistory(market.id, timeframe);
        setMarket((current) =>
          current && current.id === market.id
            ? applyMarketPriceHistory(current, history)
            : current,
        );
      } catch {
        // Chart history is non-critical; keep the current series visible.
      }
    },
    [market],
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
        walletReady={setupComplete && nostrSignerMode !== "none"}
        onWalletRequired={handleWalletRequired}
      />
      {topUpStage === "modal" && (
        <InsufficientBalanceModal
          balance={balanceAtCheck}
          required={requiredAtCheck}
          onCancel={() => setTopUpStage("closed")}
          onTopUp={() => setTopUpStage("overlay")}
        />
      )}
      {topUpStage === "overlay" && (
        <TopUpOverlay
          deficit={Math.max(requiredAtCheck - balanceAtCheck, 0)}
          onSuccess={handleTopUpSuccess}
          onCancel={() => setTopUpStage("closed")}
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
