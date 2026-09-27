import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { TradingPanel } from "../TradingPanel";
import type {
  CategoricalMarketDetail,
  FokOrderPreviewState,
  NumericMarketDetail,
  SellHoldingsState,
  TradeFeeFacts,
  YesNoMarketDetail,
} from "@/types/market-detail";
import type { UseFokOrderCapacityPreviewResult } from "@/hooks/useFokOrderCapacityPreview";
import { useState } from "react";

const { depositFundingAction } = vi.hoisted(() => ({
  depositFundingAction: vi.fn(),
}));

vi.mock("@/components/market-creation/DepositStep", () => ({
  DepositStep: ({ conditionId, divisibility }: { conditionId: string; divisibility: number }) => (
    <div data-testid="detail-deposit-step">
      {conditionId}:{divisibility}
      <button type="button" data-testid="detail-deposit-action" onClick={depositFundingAction}>
        Fund
      </button>
    </div>
  ),
}));

function makeMarket(overrides: Partial<YesNoMarketDetail> = {}): YesNoMarketDetail {
  return {
    id: "sat-market",
    title: "Will it happen?",
    type: "yesno",
    categoryTags: [],
    volume: 0,
    liquidity: 0,
    liquiditySubunits: 0,
    ammBotBudgetSubunits: 0,
    volumeLifetimeSubunits: 0,
    closingDate: "2030-01-01T00:00:00Z",
    createdDate: "2026-01-01T00:00:00Z",
    activeSince: "2026-01-01T00:00:00Z",
    baseAsset: "sat",
    divisibility: 1_000,
    baseUnit: "sats",
    creator: {
      id: "creator",
      name: "Creator",
      totalMarketsCreated: 0,
      feePercent: 1,
    },
    resolution: {
      criteria: "Will it happen?",
      source: "oracle",
      resolutionDate: "2030-01-01T00:00:00Z",
      status: "open",
    },
    priceHistory: { data: [], timeframe: "7d" },
    orderBook: {
      bids: [{ price: 400, amount: 100, total: 100 }],
      asks: [{ price: 600, amount: 100, total: 100 }],
      spread: 200,
    },
    recentTrades: [],
    comments: [],
    relatedMarkets: [],
    currentOdds: { yes: 50, no: 50 },
    ...overrides,
  };
}

type PreviewResponse = NonNullable<FokOrderPreviewState["response"]>;

function readyPreview(response: Partial<PreviewResponse> = {}): FokOrderPreviewState {
  return {
    status: "ready",
    requestKey: "preview-request",
    response: {
      fullFillAvailable: true,
      reason: "fillable",
      previewRevision: "preview-revision",
      quotePaymentSubunits: 15_000,
      averagePrice: 300,
      worstPrice: 320,
      currentLatestTradePrice: 280,
      projectedFinalPrice: 310,
      priceDenominator: 1_000,
      subsidyMayHelp: false,
      ...response,
    },
    error: null,
    retryAfterSeconds: null,
    refresh: vi.fn(),
  };
}

function loadingPreview(): FokOrderPreviewState {
  return {
    status: "loading",
    requestKey: "preview-request",
    response: null,
    error: null,
    retryAfterSeconds: null,
    refresh: vi.fn(),
  };
}

function errorPreview(retryAfterSeconds: number | null = null): FokOrderPreviewState {
  return {
    status: "error",
    requestKey: "preview-request",
    response: null,
    error: "Preview is temporarily rate limited.",
    retryAfterSeconds,
    refresh: vi.fn(),
  };
}

function readyCapacityPreview(
  overrides: Partial<NonNullable<UseFokOrderCapacityPreviewResult["response"]>> = {},
): UseFokOrderCapacityPreviewResult {
  return {
    status: "ready",
    requestKey: "capacity-request",
    response: {
      status: "ready",
      referencePrice: 400,
      effectiveLimitPrice: 600,
      maxFaceAmountSubunits: 2_000,
      quotePaymentSubunits: 800,
      worstPrice: 400,
      priceDenominator: 1_000,
      previewRevision: "capacity-revision",
      ...overrides,
    },
    error: null,
    retryAfterSeconds: null,
    refresh: vi.fn(),
  };
}

function nonfillablePreview(
  reason: PreviewResponse["reason"] = "insufficient_liquidity",
  subsidyMayHelp = reason === "insufficient_liquidity",
): FokOrderPreviewState {
  return readyPreview({
    fullFillAvailable: false,
    reason,
    quotePaymentSubunits: null,
    averagePrice: null,
    worstPrice: null,
    currentLatestTradePrice: null,
    projectedFinalPrice: null,
    subsidyMayHelp,
  });
}

const regularAsset = { kind: "regular", unit: "msat" } as const;
const conditionalAsset = {
  kind: "conditional",
  unit: "msat",
  conditionId: "condition-1",
  outcomeCollection: "YES",
} as const;

function feeFacts(overrides: Partial<TradeFeeFacts> = {}): TradeFeeFacts {
  return {
    settlementInputFeeSubunits: "10000",
    sourcePreparationFeeSubunits: "2000",
    consolidationFeeSubunits: "3000",
    settlementAsset: regularAsset,
    sourcePreparationAsset: regularAsset,
    consolidationAsset: regularAsset,
    sourceMode: "wallet-send",
    ...overrides,
  };
}

function sellHoldings(
  entries: Record<string, { selectableSubunits: number; reservedSubunits?: number }>,
): SellHoldingsState {
  return {
    status: "ready",
    byOutcomeSetId: new Map(
      Object.entries(entries).map(([outcomeSetId, holding]) => [
        outcomeSetId,
        {
          selectableSubunits: holding.selectableSubunits,
          reservedSubunits: holding.reservedSubunits ?? 0,
        },
      ]),
    ),
  };
}

describe("TradingPanel", () => {
  it.each(["funds", "outcome-tokens", "unavailable"] as const)(
    "ends the fee loading message after a %s refusal",
    (reason) => {
      const props = {
        market: makeMarket(),
        tradeSelection: { side: "yes" as const },
        tradeAmount: 1,
        tradeSide: "Buy" as const,
        orderType: "market" as const,
        tradePreview: readyPreview(),
        tradeFeeFacts: null,
        walletReady: true,
      };
      const { rerender } = render(<TradingPanel {...props} />);
      expect(screen.getByTestId("trade-fees-loading")).toBeInTheDocument();

      rerender(<TradingPanel {...props} tradeFeasibility={{ canBack: false, reason }} />);

      expect(screen.queryByTestId("trade-fees-loading")).not.toBeInTheDocument();
      expect(screen.getByTestId("trade-confirm")).toBeDisabled();
    },
  );

  const emptyBook = {
    bids: [],
    asks: [],
    spread: 0,
  };

  function makeEmptyBookMarket(divisibility: 1_000 | 1_000_000 = 1_000): YesNoMarketDetail {
    return makeMarket({
      divisibility,
      orderBook: emptyBook,
      outcomes: [
        { id: "Yes", label: "Yes", odds: null },
        { id: "No", label: "No", odds: null },
      ],
      outcomeOrderBooks: {
        Yes: emptyBook,
        No: emptyBook,
      },
    });
  }

  function renderSellPanel(overrides: Partial<ComponentProps<typeof TradingPanel>> = {}) {
    return render(
      <TradingPanel
        market={makeEmptyBookMarket()}
        tradeSelection={null}
        tradeAmount={0}
        tradePreview={null}
        tradeSide="Sell"
        orderType="market"
        {...overrides}
      />,
    );
  }

  it("renders selectable BUY, SELL, and LIQUIDITY tabs", async () => {
    const user = userEvent.setup();
    render(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={null}
        tradeAmount={0}
        tradePreview={null}
        tradeSide="Buy"
        orderType="market"
      />,
    );

    expect(screen.getAllByRole("tab")).toHaveLength(3);
    await user.click(screen.getByTestId("trade-tab-liquidity"));
    expect(screen.getByTestId("detail-deposit-step")).toHaveTextContent("sat-market:1000");
  });

  it("shows the Auto bound and lets the user change or restore it", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [orderType, setOrderType] = useState<"market" | "limit">("market");
      return (
        <TradingPanel
          market={makeMarket()}
          tradeSelection={{ side: "yes" }}
          tradeAmount={1}
          tradePreview={readyPreview({ worstPrice: 320 })}
          limitOrderPreview={readyPreview({ worstPrice: 320 })}
          tradeCapacityPreview={readyCapacityPreview()}
          automaticLimitPrice={600}
          tradeSide="Buy"
          orderType={orderType}
          limitPrice={450}
          onOrderTypeChange={setOrderType}
        />
      );
    }

    render(<Harness />);

    expect(screen.queryByText("Market")).not.toBeInTheDocument();
    expect(screen.queryByText("Limit")).not.toBeInTheDocument();
    expect(screen.getByTestId("trade-price-protection-toggle")).toHaveTextContent("Change");
    expect(screen.getByTestId("trade-protected-price")).toHaveAttribute(
      "data-price-numerator",
      "600",
    );
    expect(screen.getByTestId("trade-capacity-available")).toHaveTextContent(
      "Available at this limit: 2 shares",
    );
    expect(screen.getByText(/20 percentage points/)).toBeInTheDocument();
    expect(screen.getByText(/not reserved/)).toBeInTheDocument();

    await user.click(screen.getByTestId("trade-price-protection-toggle"));

    expect(screen.getByTestId("trade-protected-price")).toHaveAttribute(
      "data-price-numerator",
      "450",
    );
    expect(screen.getByTestId("limit-price-input")).toHaveValue(0.45);
    expect(screen.getByTestId("trade-use-auto")).toBeInTheDocument();
    await user.click(screen.getByTestId("trade-use-auto"));
    expect(screen.getByTestId("trade-protected-price")).toHaveAttribute(
      "data-price-numerator",
      "600",
    );
  });

  it("keeps a Custom price editable when a ready snapshot has zero capacity", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [orderType, setOrderType] = useState<"market" | "limit">("market");
      return (
        <TradingPanel
          market={makeMarket()}
          tradeSelection={{ side: "yes" }}
          tradeAmount={1}
          tradePreview={readyPreview()}
          limitOrderPreview={readyPreview()}
          tradeCapacityPreview={readyCapacityPreview({
            maxFaceAmountSubunits: 0,
            quotePaymentSubunits: 0,
            worstPrice: null,
          })}
          automaticLimitPrice={600}
          tradeSide="Buy"
          orderType={orderType}
          limitPrice={600}
          onOrderTypeChange={setOrderType}
        />
      );
    }

    render(<Harness />);
    expect(screen.getByTestId("trade-capacity-available")).toHaveTextContent(
      "Available at this limit: 0 shares",
    );
    await user.click(screen.getByTestId("trade-price-protection-toggle"));
    expect(screen.getByTestId("limit-price-input")).toBeEnabled();
  });

  it("distinguishes no eligible reference from an unavailable market", () => {
    const noReference = readyCapacityPreview({
      referencePrice: null,
      effectiveLimitPrice: null,
      maxFaceAmountSubunits: 0,
      quotePaymentSubunits: 0,
      worstPrice: null,
    });
    const view = renderSellPanel({
      tradeSelection: { side: "yes" },
      tradeCapacityPreview: noReference,
    });
    expect(screen.getByTestId("trade-capacity-status")).toHaveTextContent(
      "No eligible reference price.",
    );

    view.rerender(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: "yes" }}
        tradeAmount={0}
        tradePreview={null}
        tradeSide="Sell"
        orderType="market"
        tradeCapacityPreview={{
          ...noReference,
          response: {
            status: "market_unavailable",
            referencePrice: null,
            effectiveLimitPrice: null,
            maxFaceAmountSubunits: null,
            quotePaymentSubunits: null,
            worstPrice: null,
            priceDenominator: null,
            previewRevision: null,
          },
        }}
      />,
    );
    expect(screen.getByTestId("trade-capacity-status")).toHaveTextContent(
      "Market is unavailable; available shares cannot be checked.",
    );
  });

  it("allows retry when a capacity snapshot is temporarily unavailable", async () => {
    const user = userEvent.setup();
    const onTradeCapacityRetry = vi.fn();
    const capacityPreview = readyCapacityPreview();
    render(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: "yes" }}
        tradeAmount={0}
        tradePreview={null}
        tradeSide="Buy"
        orderType="market"
        tradeCapacityPreview={{
          ...capacityPreview,
          response: {
            status: "temporarily_unavailable",
            referencePrice: null,
            effectiveLimitPrice: null,
            maxFaceAmountSubunits: null,
            quotePaymentSubunits: null,
            worstPrice: null,
            priceDenominator: null,
            previewRevision: null,
          },
        }}
        onTradeCapacityRetry={onTradeCapacityRetry}
      />,
    );

    expect(screen.getByTestId("trade-capacity-status")).toHaveTextContent(
      "Available shares could not be checked.",
    );
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onTradeCapacityRetry).toHaveBeenCalledOnce();
  });

  it("does not block trading controls when the local book is empty", async () => {
    const user = userEvent.setup();
    const onTradeConfirm = vi.fn();
    render(
      <TradingPanel
        market={makeEmptyBookMarket()}
        tradeSelection={{ side: "yes" }}
        tradeAmount={2}
        tradePreview={null}
        limitOrderPreview={loadingPreview()}
        tradeSide="Buy"
        orderType="limit"
        onTradeConfirm={onTradeConfirm}
      />,
    );

    expect(screen.queryByTestId("empty-trade-liquidity")).not.toBeInTheDocument();
    expect(screen.getByTestId("trade-amount-input")).toBeInTheDocument();
    expect(screen.getByTestId("fok-preview-loading")).toBeInTheDocument();
    expect(screen.getByTestId("trade-confirm")).toBeDisabled();
    await user.click(screen.getByTestId("trade-tab-sell"));
    expect(screen.queryByTestId("empty-trade-liquidity")).not.toBeInTheDocument();
    expect(screen.getByTestId("trade-confirm")).toBeDisabled();
    await user.click(screen.getByTestId("trade-tab-liquidity"));
    expect(screen.getByTestId("detail-deposit-step")).toBeInTheDocument();
    expect(onTradeConfirm).not.toHaveBeenCalled();
  });

  it("removes durable funding when an active LIQUIDITY tab becomes disabled", async () => {
    const user = userEvent.setup();
    depositFundingAction.mockClear();
    const view = render(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={null}
        tradeAmount={0}
        tradePreview={null}
        tradeSide="Buy"
        orderType="market"
      />,
    );

    await user.click(screen.getByTestId("trade-tab-liquidity"));
    expect(screen.getByTestId("detail-deposit-step")).toBeInTheDocument();
    await user.click(screen.getByTestId("detail-deposit-action"));
    expect(depositFundingAction).toHaveBeenCalledTimes(1);

    view.rerender(
      <TradingPanel
        market={makeMarket({ state: "closed" })}
        tradeSelection={null}
        tradeAmount={0}
        tradePreview={null}
        tradeSide="Buy"
        orderType="market"
        disabled
      />,
    );

    expect(screen.getByTestId("closed-trade-liquidity")).toBeInTheDocument();
    expect(screen.queryByTestId("detail-deposit-step")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-deposit-action")).not.toBeInTheDocument();
  });

  it("shows only the closed-market message when a disabled empty book is rendered", () => {
    render(
      <TradingPanel
        market={{ ...makeEmptyBookMarket(), state: "closed" }}
        tradeSelection={{ side: "yes" }}
        tradeAmount={2}
        tradePreview={null}
        tradeSide="Buy"
        orderType="market"
        disabled
      />,
    );

    expect(screen.getByTestId("closed-trade-liquidity")).toHaveTextContent(
      "This market is no longer accepting orders.",
    );
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByTestId("trade-tab-liquidity")).not.toBeInTheDocument();
    expect(screen.queryByTestId("open-liquidity-tab")).not.toBeInTheDocument();
    expect(screen.queryByTestId("empty-trade-liquidity")).not.toBeInTheDocument();
    expect(screen.queryByTestId("trade-amount-input")).not.toBeInTheDocument();
    expect(screen.queryByTestId("trade-confirm")).not.toBeInTheDocument();
  });

  it("keeps outcome selection available when every route is empty before selection", () => {
    render(
      <TradingPanel
        market={makeEmptyBookMarket()}
        tradeSelection={null}
        tradeAmount={0}
        tradePreview={null}
        tradeSide="Buy"
        orderType="market"
      />,
    );

    expect(screen.queryByTestId("empty-trade-liquidity")).not.toBeInTheDocument();
    expect(screen.getByTestId("trade-outcome-yes")).toBeInTheDocument();
    expect(screen.getByTestId("trade-outcome-no")).toBeInTheDocument();
    expect(screen.queryByTestId("trade-amount-input")).not.toBeInTheDocument();
    expect(screen.queryByTestId("trade-confirm")).not.toBeInTheDocument();
  });

  it("counts complementary bids as BUY liquidity and direct bids as SELL liquidity", () => {
    const market = makeEmptyBookMarket();
    const withComplementBid = {
      ...market,
      outcomeOrderBooks: {
        Yes: emptyBook,
        No: { ...emptyBook, bids: [{ price: 300, amount: 100, total: 100 }] },
      },
    } satisfies YesNoMarketDetail;
    const { unmount } = render(
      <TradingPanel
        market={withComplementBid}
        tradeSelection={{ side: "yes" }}
        tradeAmount={0}
        tradePreview={null}
        tradeSide="Buy"
        orderType="market"
      />,
    );
    expect(screen.queryByTestId("empty-trade-liquidity")).not.toBeInTheDocument();
    expect(screen.getByTestId("trade-outcome-yes")).toBeInTheDocument();

    unmount();
    render(
      <TradingPanel
        market={{
          ...market,
          outcomeOrderBooks: {
            Yes: { ...emptyBook, bids: [{ price: 400, amount: 100, total: 100 }] },
            No: emptyBook,
          },
        }}
        tradeSelection={{ side: "yes" }}
        tradeAmount={0}
        tradePreview={null}
        tradeSide="Sell"
        orderType="market"
      />,
    );
    expect(screen.queryByTestId("empty-trade-liquidity")).not.toBeInTheDocument();
    expect(screen.getByTestId("trade-outcome-yes")).toBeInTheDocument();
  });

  it("shows categorical NO trading from a singleton complement book", () => {
    const categoricalMarket = {
      ...makeMarket(),
      type: "categorical" as const,
      outcomes: [
        { id: "outcome-0", label: "Alice", odds: null, color: "#445566" },
        { id: "outcome-1", label: "Bob", odds: null },
        { id: "outcome-2", label: "Carol", odds: null },
      ],
      outcomePriceHistories: {},
      orderBook: emptyBook,
      outcomeOrderBooks: {
        Alice: { ...emptyBook, bids: [{ price: 300, amount: 100, total: 100 }] },
      },
    } as unknown as CategoricalMarketDetail;

    const { unmount } = render(
      <TradingPanel
        market={categoricalMarket}
        tradeSelection={{ side: "no", outcomeId: "outcome-0" }}
        tradeAmount={0}
        tradePreview={null}
        tradeSide="Buy"
        orderType="market"
      />,
    );

    expect(screen.queryByTestId("empty-trade-liquidity")).not.toBeInTheDocument();
    expect(screen.getByTestId("buy-no-Alice")).toBeInTheDocument();
    expect(screen.getAllByTestId("outcome-color-swatch")[0]).toHaveStyle({
      backgroundColor: "#445566",
    });

    unmount();
    render(
      <TradingPanel
        market={categoricalMarket}
        tradeSelection={null}
        tradeAmount={0}
        tradePreview={null}
        tradeSide="Buy"
        orderType="market"
      />,
    );

    expect(screen.queryByTestId("empty-trade-liquidity")).not.toBeInTheDocument();
    expect(screen.getByTestId("buy-no-Alice")).toBeInTheDocument();
  });

  it("transforms complementary BUY liquidity with the actual one-million divisibility", () => {
    const market = makeEmptyBookMarket(1_000_000);
    render(
      <TradingPanel
        market={{
          ...market,
          outcomeOrderBooks: {
            Yes: emptyBook,
            No: { ...emptyBook, bids: [{ price: 301_000, amount: 100, total: 100 }] },
          },
        }}
        tradeSelection={{ side: "yes" }}
        tradeAmount={0}
        tradePreview={null}
        tradeSide="Buy"
        orderType="market"
      />,
    );

    expect(screen.queryByTestId("empty-trade-liquidity")).not.toBeInTheDocument();
    expect(screen.getByTestId("trade-outcome-yes")).toBeInTheDocument();
  });

  it("fails closed for numeric markets without trading or funding controls", () => {
    const onTradeSelect = vi.fn();
    const onTradeConfirm = vi.fn();
    const numericMarket = {
      ...makeMarket(),
      type: "numeric" as const,
      currentPrice: 15,
      loBound: 10,
      hiBound: 20,
      precision: 3,
      unit: "USD",
      attestedValue: 15.125,
      registeredPrimitiveOutcomeIds: ["HI", "LO"],
    } as unknown as NumericMarketDetail;

    render(
      <TradingPanel
        market={numericMarket}
        tradeSelection={{ side: "hi" }}
        tradeAmount={2}
        tradePreview={null}
        tradeSide="Buy"
        orderType="market"
        onTradeSelect={onTradeSelect}
        onTradeConfirm={onTradeConfirm}
      />,
    );

    expect(screen.getByTestId("numeric-trading-unavailable")).toHaveTextContent(
      "Numeric trading is unavailable until a canonical numeric trade representation is supported.",
    );
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByTestId("detail-deposit-step")).not.toBeInTheDocument();
    expect(screen.queryByTestId("numeric-range-fill")).not.toBeInTheDocument();
    expect(screen.queryByTestId("numeric-range-marker")).not.toBeInTheDocument();
    expect(screen.queryByTestId("trade-amount-input")).not.toBeInTheDocument();
    expect(screen.queryByTestId("trade-confirm")).not.toBeInTheDocument();
    expect(onTradeSelect).not.toHaveBeenCalled();
    expect(onTradeConfirm).not.toHaveBeenCalled();
  });

  it("labels an authoritative empty trade snapshot as no trades", () => {
    const market = makeMarket({
      currentOdds: { yes: null, no: null },
      latestConfirmedTrades: [],
      latestConfirmedTradesValid: true,
    });

    render(
      <TradingPanel
        market={market}
        tradeSelection={null}
        tradeAmount={0}
        tradePreview={null}
        tradeSide="Buy"
        orderType="market"
      />,
    );

    expect(screen.getAllByLabelText("No trades yet")).toHaveLength(2);
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.queryAllByLabelText("market.priceUnavailable")).toHaveLength(0);
    expect(screen.getByTestId("trade-outcome-yes")).toHaveAccessibleName("Yes");
  });

  it("labels malformed or missing price authority as unavailable", () => {
    const market = makeMarket({
      currentOdds: { yes: 2_500, no: 7_500 },
      latestConfirmedTrades: [],
      latestConfirmedTradesValid: false,
    });

    render(
      <TradingPanel
        market={market}
        tradeSelection={null}
        tradeAmount={0}
        tradePreview={null}
        tradeSide="Buy"
        orderType="market"
      />,
    );

    expect(screen.getAllByLabelText("market.priceUnavailable")).toHaveLength(2);
    expect(screen.queryAllByLabelText("No trades yet")).toHaveLength(0);
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.getByTestId("trade-outcome-yes")).toHaveAccessibleName("Yes");
  });

  it("keeps a valid partial categorical snapshot as no trades only for null outcomes", () => {
    const categoricalMarket = {
      ...makeMarket({
        latestConfirmedTrades: [
          {
            primitiveOutcomeId: "Alice",
            fillId: "00000000-0000-0000-0000-000000000001",
            executedAt: "2030-01-01T00:00:00Z",
            eventOrder: "0001",
            priceTick: 250,
            divisibility: 1_000,
            faceAmountSubunits: 100,
          },
        ],
        latestConfirmedTradesValid: true,
      }),
      type: "categorical" as const,
      outcomes: [
        { id: "Alice", label: "Alice", odds: 250 },
        { id: "Bob", label: "Bob", odds: null },
      ],
    } as unknown as CategoricalMarketDetail;

    render(
      <TradingPanel
        market={categoricalMarket}
        tradeSelection={null}
        tradeAmount={0}
        tradePreview={null}
        tradeSide="Buy"
        orderType="market"
      />,
    );

    expect(screen.getByText("25.0%")).toBeInTheDocument();
    expect(screen.getByLabelText("No trades yet")).toHaveTextContent("—");
    expect(screen.queryByLabelText("market.priceUnavailable")).not.toBeInTheDocument();
  });

  function StatefulLimitTradingPanel({
    initialLimitPrice = 40,
    initialTradeAmount = 2,
    onLimitPriceChange,
    onAmountChange,
  }: {
    initialLimitPrice?: number;
    initialTradeAmount?: number;
    onLimitPriceChange?: (price: number) => void;
    onAmountChange?: (amount: number) => void;
  }) {
    const [limitPrice, setLimitPrice] = useState(initialLimitPrice);
    const [tradeAmount, setTradeAmount] = useState(initialTradeAmount);

    return (
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: "yes" }}
        tradeAmount={tradeAmount}
        tradePreview={null}
        limitOrderPreview={readyPreview()}
        tradeFeeFacts={feeFacts()}
        feeConsentCurrent
        tradeSide="Buy"
        orderType="limit"
        limitPrice={limitPrice}
        onLimitPriceChange={(price) => {
          setLimitPrice(price);
          onLimitPriceChange?.(price);
        }}
        onAmountChange={(amount) => {
          setTradeAmount(amount);
          onAmountChange?.(amount);
        }}
      />
    );
  }

  it("uses a share input and shows the authoritative Buy quote and exact fees", () => {
    render(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: "yes" }}
        tradeAmount={50}
        tradePreview={readyPreview({ priceDenominator: 1_000_000 })}
        tradeFeeFacts={feeFacts()}
        feeConsentCurrent
        tradeSide="Buy"
        orderType="market"
        onTradeConfirm={vi.fn()}
      />,
    );

    expect(screen.getByText("Shares")).toBeInTheDocument();
    expect(screen.getByText("1 share = 1 sats")).toBeInTheDocument();
    expect(screen.getByTestId("trade-average-execution-price")).toHaveTextContent(
      "0.30 sats (0.0300%)",
    );
    expect(screen.getByTestId("trade-worst-price")).toHaveTextContent("0.32 sats (0.0320%)");
    expect(screen.getByTestId("trade-current-latest-price")).toHaveTextContent("0.0280%");
    expect(screen.getByTestId("trade-projected-final-price")).toHaveTextContent("0.0310%");
    expect(screen.getByText("Quote payment")).toBeInTheDocument();
    expect(screen.getByTestId("trade-quote-payment")).toHaveTextContent("15.000 sats");
    expect(screen.getByTestId("trade-settlement-input-fee")).toHaveTextContent(/^10\.000 sats$/);
    expect(screen.getByTestId("trade-source-preparation-fee")).toHaveTextContent(/^2\.000 sats$/);
    expect(screen.getByTestId("trade-consolidation-fee")).toHaveTextContent(/^3\.000 sats$/);
    expect(screen.getByTestId("trade-grand-total")).toHaveTextContent("30.000 sats");
    expect(screen.getByRole("button", { name: "Buy YES for 50 shares" })).toBeInTheDocument();
    expect(screen.queryByText("Market Creator fee (1%)")).not.toBeInTheDocument();
    expect(screen.queryByText("Mint fee")).not.toBeInTheDocument();
    expect(screen.queryByText("Engine Score fee")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Gross settlement payout per filled share if this outcome wins"),
    ).not.toBeInTheDocument();
  });

  it.each([
    [1, "Buy YES for 1 share"],
    [2, "Buy YES for 2 shares"],
  ] as const)("localizes the confirmation share count for %s", (tradeAmount, buttonName) => {
    render(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: "yes" }}
        tradeAmount={tradeAmount}
        tradePreview={readyPreview()}
        feeConsentCurrent
        tradeSide="Buy"
        orderType="market"
        onTradeConfirm={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: buttonName })).toBeInTheDocument();
  });

  it("turns buy submit into a top-up button when local funds are insufficient", () => {
    const onTopUpRequired = vi.fn();
    render(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: "yes" }}
        tradeAmount={2}
        tradePreview={null}
        limitOrderPreview={readyPreview()}
        tradeFeeFacts={feeFacts()}
        feeConsentCurrent
        tradeSide="Buy"
        orderType="limit"
        limitPrice={500}
        onTradeConfirm={vi.fn()}
        onTopUpRequired={onTopUpRequired}
        tradeFeasibility={{
          canBack: false,
          reason: "funds",
        }}
      />,
    );

    const button = screen.getByTestId("trade-confirm");
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent("Top up sats wallet");
    expect(button).not.toHaveAttribute("title");
    expect(screen.getByTestId("trade-feasibility-status")).toHaveTextContent("Insufficient funds");
    expect(screen.queryByRole("button", { name: "Top up sats wallet" })).toBe(button);
    expect(screen.queryByText(/VCS/i)).not.toBeInTheDocument();

    fireEvent.click(button);
    expect(onTopUpRequired).toHaveBeenCalledTimes(1);
  });

  it("disables sell submit and shows outcome-token wording when local tokens are insufficient", () => {
    render(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: "yes" }}
        tradeAmount={2}
        tradePreview={null}
        limitOrderPreview={readyPreview()}
        tradeFeeFacts={feeFacts({
          sourcePreparationAsset: conditionalAsset,
          consolidationAsset: conditionalAsset,
          sourceMode: "conditional-keyset-swap",
        })}
        feeConsentCurrent
        tradeSide="Sell"
        orderType="limit"
        limitPrice={500}
        onTradeConfirm={vi.fn()}
        tradeFeasibility={{
          canBack: false,
          reason: "outcome-tokens",
        }}
      />,
    );

    const button = screen.getByTestId("trade-confirm");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Insufficient outcome tokens");
    expect(screen.getByTestId("trade-feasibility-status")).toHaveTextContent(
      "Insufficient outcome tokens",
    );
    expect(screen.queryByRole("button", { name: "Top up wallet" })).not.toBeInTheDocument();
    expect(screen.queryByText(/VCS/i)).not.toBeInTheDocument();
  });

  it("keeps Sell selectable while enabling only outcomes with canonical selectable shares", async () => {
    const user = userEvent.setup();
    renderSellPanel({
      tradeSide: "Buy",
      tradeSelection: { side: "no" },
      sellHoldings: sellHoldings({
        Yes: { selectableSubunits: 0 },
        No: { selectableSubunits: 2_000 },
      }),
    });

    await user.click(screen.getByTestId("trade-tab-sell"));

    expect(screen.getByTestId("trade-tab-sell")).toBeEnabled();
    expect(screen.getByTestId("trade-outcome-yes")).toBeDisabled();
    expect(screen.getByTestId("trade-outcome-yes-availability")).toHaveTextContent(
      "No selectable shares",
    );
    expect(screen.getByTestId("trade-outcome-no")).toBeEnabled();
    expect(screen.getByTestId("trade-outcome-no-availability")).toHaveTextContent(
      "2 shares available",
    );
    expect(screen.getByTestId("trade-outcome-no")).toHaveAttribute(
      "aria-describedby",
      "trade-outcome-no-availability",
    );
    expect(screen.getByText("Balance: 2 shares")).toBeInTheDocument();
  });

  it("keeps all Sell choices disabled when the canonical holdings are zero", async () => {
    const user = userEvent.setup();
    renderSellPanel({
      tradeSide: "Buy",
      sellHoldings: sellHoldings({ Yes: { selectableSubunits: 0 }, No: { selectableSubunits: 0 } }),
    });

    await user.click(screen.getByTestId("trade-tab-sell"));

    expect(screen.getByTestId("trade-outcome-yes")).toBeDisabled();
    expect(screen.getByTestId("trade-outcome-no")).toBeDisabled();
    expect(screen.getByTestId("trade-tab-sell")).toBeEnabled();
  });

  it("excludes reserved shares from Sell availability", () => {
    renderSellPanel({
      sellHoldings: sellHoldings({ Yes: { selectableSubunits: 0, reservedSubunits: 3_000 } }),
    });

    expect(screen.getByTestId("trade-outcome-yes")).toBeDisabled();
    expect(screen.getByTestId("trade-outcome-yes-availability")).toHaveTextContent(
      "Available shares are reserved",
    );
    expect(screen.getByTestId("trade-outcome-no")).toBeDisabled();
  });

  it.each([
    [{ status: "loading" as const }, "Checking selectable shares..."],
    [{ status: "unavailable" as const }, "Wallet holdings are unavailable"],
  ])("keeps Sell choices disabled while holdings are %s", (state, expectedMessage) => {
    renderSellPanel({
      tradeSelection: { side: "yes" },
      tradeAmount: 1,
      tradePreview: readyPreview(),
      sellHoldings: state,
    });

    expect(screen.getByTestId("trade-outcome-yes")).toBeDisabled();
    expect(screen.getByTestId("trade-outcome-yes-availability")).toHaveTextContent(expectedMessage);
    expect(screen.getByTestId("sell-holding-status")).toHaveTextContent(expectedMessage);
    expect(screen.getByTestId("trade-confirm")).toBeDisabled();
  });

  it.each([
    [25, 1],
    [50, 3],
    [75, 5],
    [100, 7],
  ])("floors the Sell %s%% shortcut against selected whole shares", (percentage, expected) => {
    const onAmountChange = vi.fn();
    renderSellPanel({
      tradeSelection: { side: "yes" },
      sellHoldings: sellHoldings({
        Yes: { selectableSubunits: 7_999 },
        No: { selectableSubunits: 90_000 },
      }),
      onAmountChange,
    });

    fireEvent.click(screen.getByTestId(`trade-sell-percentage-${percentage}`));

    expect(onAmountChange).toHaveBeenCalledWith(expected);
  });

  it("disables a Sell percentage shortcut when flooring would select zero shares", () => {
    const onAmountChange = vi.fn();
    renderSellPanel({
      tradeSelection: { side: "yes" },
      sellHoldings: sellHoldings({ Yes: { selectableSubunits: 3_000 } }),
      onAmountChange,
    });

    expect(screen.getByTestId("trade-sell-percentage-25")).toBeDisabled();
    expect(screen.getByTestId("trade-sell-percentage-50")).toBeEnabled();
    fireEvent.click(screen.getByTestId("trade-sell-percentage-50"));
    expect(onAmountChange).toHaveBeenCalledWith(1);
  });

  it("uses the exact categorical complement collection for Sell No", () => {
    const categoricalMarket = {
      ...makeMarket(),
      type: "categorical" as const,
      outcomes: [
        { id: "outcome-0", label: "Alice", odds: null },
        { id: "outcome-1", label: "Bob", odds: null },
        { id: "outcome-2", label: "Carol", odds: null },
      ],
      outcomePriceHistories: {},
      outcomeOrderBooks: {},
    } as unknown as CategoricalMarketDetail;

    renderSellPanel({
      market: categoricalMarket,
      tradeSelection: { side: "no", outcomeId: "outcome-0" },
      tradeAmount: 2,
      tradePreview: readyPreview(),
      feeConsentCurrent: true,
      sellHoldings: sellHoldings({
        Alice: { selectableSubunits: 1_000 },
        "Bob|Carol": { selectableSubunits: 2_000 },
      }),
    });

    expect(screen.getByTestId("sell-holding-no-outcome-0")).toHaveTextContent("2 shares available");
    expect(screen.getByText("Balance: 2 shares")).toBeInTheDocument();
    expect(screen.getByTestId("buy-no-Alice")).toHaveAttribute(
      "aria-describedby",
      "sell-holding-no-0",
    );
  });

  it("disables Sell confirmation when holdings are depleted after selection", () => {
    const props = {
      market: makeEmptyBookMarket(),
      tradeSelection: { side: "yes" as const },
      tradeAmount: 2,
      tradePreview: readyPreview(),
      feeConsentCurrent: true,
      tradeSide: "Sell" as const,
      orderType: "market" as const,
      onTradeConfirm: vi.fn(),
    };
    const { rerender } = renderSellPanel({
      ...props,
      sellHoldings: sellHoldings({ Yes: { selectableSubunits: 2_000 } }),
    });
    expect(screen.getByTestId("trade-confirm")).toBeEnabled();

    rerender(
      <TradingPanel {...props} sellHoldings={sellHoldings({ Yes: { selectableSubunits: 0 } })} />,
    );

    expect(screen.getByTestId("sell-holding-status")).toHaveTextContent("No selectable shares");
    expect(screen.getByTestId("trade-confirm")).toBeDisabled();
  });

  it("keeps submit enabled when local backing is sufficient", () => {
    const onTradeConfirm = vi.fn();
    render(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: "yes" }}
        tradeAmount={2}
        tradePreview={null}
        limitOrderPreview={readyPreview()}
        tradeFeeFacts={feeFacts()}
        feeConsentCurrent
        tradeSide="Buy"
        orderType="limit"
        limitPrice={500}
        onTradeConfirm={onTradeConfirm}
        tradeFeasibility={{ canBack: true }}
      />,
    );

    const button = screen.getByTestId("trade-confirm");
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onTradeConfirm).toHaveBeenCalledTimes(1);
  });

  it("blocks confirmation when displayed wallet fee facts are not current", () => {
    render(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: "yes" }}
        tradeAmount={50}
        tradePreview={readyPreview({ quotePaymentSubunits: 150 })}
        tradeFeeFacts={feeFacts({
          settlementInputFeeSubunits: "100",
          sourcePreparationFeeSubunits: "200",
          consolidationFeeSubunits: "300",
        })}
        feeConsentCurrent={false}
        tradeSide="Buy"
        orderType="market"
        onTradeConfirm={vi.fn()}
      />,
    );

    expect(screen.getByTestId("trade-quote-payment")).toHaveTextContent("0.150 sats");
    expect(screen.getByTestId("trade-settlement-input-fee")).toHaveTextContent(/^0\.100 sats$/);
    expect(screen.getByTestId("trade-source-preparation-fee")).toHaveTextContent(/^0\.200 sats$/);
    expect(screen.getByTestId("trade-consolidation-fee")).toHaveTextContent(/^0\.300 sats$/);
    expect(screen.getByTestId("trade-fee-consent-required")).toBeInTheDocument();
    expect(screen.getByTestId("trade-confirm")).toBeDisabled();
  });

  it("formats a sat-denominated limit preview with authoritative quote and fees", () => {
    render(
      <TradingPanel
        market={makeMarket({ baseAsset: "sat", baseUnit: "sats", divisibility: 1_000 })}
        tradeSelection={{ side: "yes" }}
        tradeAmount={50}
        tradePreview={null}
        tradeFeeFacts={feeFacts()}
        feeConsentCurrent
        tradeSide="Buy"
        orderType="limit"
        limitPrice={300}
        limitOrderPreview={readyPreview()}
        onTradeConfirm={vi.fn()}
      />,
    );

    expect(screen.getByText(/Price per share: 0\.30 sats \(30\.0%\)/)).toBeInTheDocument();
    expect(screen.getByText("Quote payment")).toBeInTheDocument();
    expect(screen.getByTestId("trade-quote-payment")).toHaveTextContent("15.000 sats");
    expect(screen.getByTestId("trade-settlement-input-fee")).toHaveTextContent(/^10\.000 sats$/);
    expect(screen.getByTestId("trade-grand-total")).toHaveTextContent("30.000 sats");
    expect(screen.queryByText("Shares you receive if order fills")).not.toBeInTheDocument();
    expect(screen.queryByText("Market Creator fee (1%)")).not.toBeInTheDocument();
    expect(screen.queryByText("Mint fee")).not.toBeInTheDocument();
    expect(screen.queryByText("Engine Score fee")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Gross settlement payout per filled share if this outcome wins"),
    ).not.toBeInTheDocument();
  });

  it("formats exact msat quote and fee facts as display sats", () => {
    render(
      <TradingPanel
        market={makeMarket({ baseAsset: "sat", baseUnit: "sats", divisibility: 1_000 })}
        tradeSelection={{ side: "yes" }}
        tradeAmount={1}
        tradePreview={null}
        tradeFeeFacts={feeFacts({
          settlementInputFeeSubunits: "1",
          sourcePreparationFeeSubunits: "2",
          consolidationFeeSubunits: "3",
        })}
        feeConsentCurrent
        tradeSide="Buy"
        orderType="limit"
        limitPrice={100}
        limitOrderPreview={readyPreview({
          quotePaymentSubunits: 100,
          averagePrice: 100,
          worstPrice: 100,
          currentLatestTradePrice: 100,
          projectedFinalPrice: 100,
        })}
        onTradeConfirm={vi.fn()}
      />,
    );

    expect(screen.getByText("1 share = 1 sats")).toBeInTheDocument();
    expect(screen.getByTestId("trade-quote-payment")).toHaveTextContent("0.100 sats");
    expect(screen.getByTestId("trade-settlement-input-fee")).toHaveTextContent(/^0\.001 sats$/);
    expect(screen.getByTestId("trade-source-preparation-fee")).toHaveTextContent(/^0\.002 sats$/);
    expect(screen.getByTestId("trade-consolidation-fee")).toHaveTextContent(/^0\.003 sats$/);
    expect(screen.getByTestId("trade-grand-total")).toHaveTextContent("0.106 sats");
  });

  it("displays sat-market limit prices as sats, not raw msat subunits", () => {
    render(
      <TradingPanel
        market={makeMarket({ baseAsset: "sat", baseUnit: "sats", divisibility: 1_000 })}
        tradeSelection={{ side: "yes" }}
        tradeAmount={1}
        tradePreview={null}
        tradeSide="Buy"
        orderType="limit"
        limitPrice={850}
        onTradeConfirm={vi.fn()}
      />,
    );

    expect(screen.getByTestId("limit-price-input")).toHaveValue(0.85);
    expect(screen.getByText(/Price per share: 0\.85 sats \(85\.0%\)/)).toBeInTheDocument();
    expect(screen.queryByText("8500 sats")).not.toBeInTheDocument();
  });

  it("uses market divisibility when displaying one-share face value", () => {
    render(
      <TradingPanel
        market={makeMarket({ baseAsset: "sat", baseUnit: "sats", divisibility: 1_000 })}
        tradeSelection={{ side: "yes" }}
        tradeAmount={1}
        tradePreview={null}
        tradeSide="Buy"
        orderType="limit"
        limitPrice={30}
        onTradeConfirm={vi.fn()}
      />,
    );

    expect(screen.getByText("1 share = 1 sats")).toBeInTheDocument();
  });

  it("shows loading state while the authoritative preview is pending", () => {
    render(
      <TradingPanel
        market={makeMarket({ baseAsset: "sat", baseUnit: "sats", divisibility: 1_000 })}
        tradeSelection={{ side: "yes" }}
        tradeAmount={50}
        tradePreview={null}
        limitOrderPreview={loadingPreview()}
        tradeSide="Buy"
        orderType="limit"
        limitPrice={30}
        onTradeConfirm={vi.fn()}
      />,
    );

    expect(screen.getByTestId("fok-preview-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("trade-quote-payment")).not.toBeInTheDocument();
    expect(screen.getByTestId("trade-confirm")).toBeDisabled();
  });

  it("offers a manual preview retry and gates confirmation until the refreshed preview is ready", () => {
    const refresh = vi.fn();
    const failedPreview = errorPreview(17);
    failedPreview.refresh = refresh;
    const { rerender } = render(
      <TradingPanel
        market={makeMarket({ baseAsset: "sat", baseUnit: "sats", divisibility: 1_000 })}
        tradeSelection={{ side: "yes" }}
        tradeAmount={50}
        tradePreview={null}
        limitOrderPreview={failedPreview}
        tradeSide="Buy"
        orderType="limit"
        limitPrice={30}
        onTradeConfirm={vi.fn()}
      />,
    );

    expect(screen.getByTestId("fok-preview-error")).toHaveTextContent(
      "Preview is temporarily rate limited.",
    );
    expect(screen.getByTestId("fok-preview-error")).toHaveTextContent("Try again in 17 seconds.");
    expect(screen.getByTestId("trade-confirm")).toBeDisabled();

    fireEvent.click(screen.getByTestId("fok-preview-retry"));
    expect(refresh).toHaveBeenCalledTimes(1);

    rerender(
      <TradingPanel
        market={makeMarket({ baseAsset: "sat", baseUnit: "sats", divisibility: 1_000 })}
        tradeSelection={{ side: "yes" }}
        tradeAmount={50}
        tradePreview={null}
        limitOrderPreview={loadingPreview()}
        tradeSide="Buy"
        orderType="limit"
        limitPrice={30}
        onTradeConfirm={vi.fn()}
      />,
    );
    expect(screen.getByTestId("fok-preview-loading")).toBeInTheDocument();
    expect(screen.getByTestId("trade-confirm")).toBeDisabled();

    rerender(
      <TradingPanel
        market={makeMarket({ baseAsset: "sat", baseUnit: "sats", divisibility: 1_000 })}
        tradeSelection={{ side: "yes" }}
        tradeAmount={50}
        tradePreview={null}
        limitOrderPreview={readyPreview()}
        tradeFeeFacts={feeFacts()}
        feeConsentCurrent
        tradeSide="Buy"
        orderType="limit"
        limitPrice={30}
        onTradeConfirm={vi.fn()}
      />,
    );
    expect(screen.getByTestId("fok-preview-ready")).toBeInTheDocument();
    expect(screen.getByTestId("trade-confirm")).toBeEnabled();
  });

  it("shows a nonfillable preview without zero-valued execution estimates", () => {
    const { rerender } = render(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: "yes" }}
        tradeAmount={50}
        tradePreview={nonfillablePreview()}
        tradeFeeFacts={feeFacts()}
        feeConsentCurrent
        tradeSide="Buy"
        orderType="market"
        onTradeConfirm={vi.fn()}
      />,
    );

    expect(screen.getByTestId("fok-preview-nonfillable")).toBeInTheDocument();
    expect(screen.getByTestId("fok-preview-subsidy")).toHaveTextContent(
      "Additional condition funding may help.",
    );
    expect(screen.queryByTestId("fok-preview-ready")).not.toBeInTheDocument();
    expect(screen.queryByTestId("trade-quote-payment")).not.toBeInTheDocument();
    expect(screen.queryByText(/0\.000 sats/)).not.toBeInTheDocument();
    expect(screen.getByTestId("trade-confirm")).toBeDisabled();

    rerender(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: "yes" }}
        tradeAmount={50}
        tradePreview={nonfillablePreview("insufficient_liquidity", false)}
        tradeFeeFacts={feeFacts()}
        feeConsentCurrent
        tradeSide="Buy"
        orderType="market"
        onTradeConfirm={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("fok-preview-subsidy")).not.toBeInTheDocument();
  });

  it.each([
    ["matching snapshot", "preview-revision", true],
    ["different snapshot", "older-revision", false],
  ] as const)(
    "explains a price-limit refusal and displays only matching book facts (%s)",
    (_case, capacityRevision, showFacts) => {
      render(
        <TradingPanel
          market={makeMarket()}
          tradeSelection={{ side: "yes" }}
          tradeAmount={5}
          tradePreview={nonfillablePreview("price_limit", true)}
          tradeCapacityPreview={readyCapacityPreview({
            referencePrice: 500,
            effectiveLimitPrice: 700,
            previewRevision: capacityRevision,
          })}
          tradeFeeFacts={feeFacts()}
          feeConsentCurrent
          tradeSide="Buy"
          orderType="market"
          onTradeConfirm={vi.fn()}
        />,
      );

      expect(screen.getByTestId("fok-preview-nonfillable")).toHaveTextContent(
        "Reduce the share amount or deliberately change the price limit.",
      );
      expect(screen.queryByTestId("fok-preview-subsidy")).not.toBeInTheDocument();

      const details = screen.queryByTestId("fok-preview-price-limit-details");
      if (!showFacts) {
        expect(details).not.toBeInTheDocument();
        return;
      }

      expect(details).toHaveTextContent("Current best executable price: 50.0%");
      expect(details).toHaveTextContent("Maximum buy price: 70.0%");
    },
  );

  it("renders a missing confirmed price as no trades rather than zero", () => {
    render(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: "yes" }}
        tradeAmount={50}
        tradePreview={readyPreview({ currentLatestTradePrice: null })}
        tradeFeeFacts={feeFacts()}
        feeConsentCurrent
        tradeSide="Buy"
        orderType="market"
        onTradeConfirm={vi.fn()}
      />,
    );

    expect(screen.getByTestId("trade-current-latest-price")).toHaveTextContent("No trades yet");
    expect(screen.getByTestId("trade-current-latest-price")).not.toHaveTextContent("0");
  });

  it.each([
    {
      name: "conditional preparation",
      sourceAsset: conditionalAsset,
      consolidationAsset: conditionalAsset,
      sourceMode: "conditional-keyset-swap" as const,
      expectedNet: "-0.050 sats",
      sourceLabel: "5.000 sats (conditional tokens)",
      consolidationLabel: "1.000 sats (conditional tokens)",
    },
    {
      name: "cash preparation and conditional consolidation",
      sourceAsset: regularAsset,
      consolidationAsset: conditionalAsset,
      sourceMode: "mixed-source-ctf-convert" as const,
      expectedNet: "-5.050 sats",
      sourceLabel: "5.000 sats",
      consolidationLabel: "1.000 sats (conditional tokens)",
    },
    {
      name: "cash preparation and consolidation",
      sourceAsset: regularAsset,
      consolidationAsset: regularAsset,
      sourceMode: "mixed-source-ctf-convert" as const,
      expectedNet: "-6.050 sats",
      sourceLabel: "5.000 sats",
      consolidationLabel: "1.000 sats",
    },
  ])("shows Sell net cash after $name without treating conditional fees as cash", (scenario) => {
    render(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: "yes" }}
        tradeAmount={50}
        tradePreview={readyPreview({ quotePaymentSubunits: 50 })}
        tradeFeeFacts={feeFacts({
          settlementInputFeeSubunits: "100",
          sourcePreparationFeeSubunits: "5000",
          consolidationFeeSubunits: "1000",
          sourcePreparationAsset: scenario.sourceAsset,
          consolidationAsset: scenario.consolidationAsset,
          sourceMode: scenario.sourceMode,
        })}
        feeConsentCurrent
        tradeSide="Sell"
        orderType="market"
        onTradeConfirm={vi.fn()}
      />,
    );

    expect(screen.getByText("Quote proceeds")).toBeInTheDocument();
    expect(screen.getByTestId("trade-quote-payment")).toHaveTextContent("0.050 sats");
    expect(screen.getByTestId("trade-net-proceeds")).toHaveTextContent(scenario.expectedNet);
    expect(screen.getByTestId("trade-settlement-input-fee")).toHaveTextContent(/^0\.100 sats$/);
    expect(screen.getByTestId("trade-source-preparation-fee")).toHaveTextContent(
      scenario.sourceLabel,
    );
    expect(screen.getByTestId("trade-consolidation-fee")).toHaveTextContent(
      scenario.consolidationLabel,
    );
  });

  it("keeps the share input as an integer of at least one on blur", async () => {
    const onAmountChange = vi.fn();
    const user = userEvent.setup();

    render(<StatefulLimitTradingPanel initialTradeAmount={1} onAmountChange={onAmountChange} />);

    const amountInput = screen.getByTestId("trade-amount-input") as HTMLInputElement;
    await user.clear(amountInput);
    await user.type(amountInput, "50.8");

    expect(amountInput).toHaveValue(50.8);

    fireEvent.blur(amountInput);

    expect(onAmountChange).toHaveBeenCalledWith(51);
    expect(amountInput).toHaveValue(51);
  });

  it("enables confirmation as soon as a valid share amount is typed", async () => {
    const user = userEvent.setup();

    render(<StatefulLimitTradingPanel initialTradeAmount={0} />);

    const confirm = screen.getByTestId("trade-confirm");
    expect(confirm).toBeDisabled();

    await user.type(screen.getByTestId("trade-amount-input"), "1");

    expect(confirm).toBeEnabled();
  });

  it("allows the limit price to be cleared and replaced before committing on blur", async () => {
    const onLimitPriceChange = vi.fn();
    const user = userEvent.setup();

    render(
      <StatefulLimitTradingPanel initialLimitPrice={40} onLimitPriceChange={onLimitPriceChange} />,
    );

    const priceInput = screen.getByTestId("limit-price-input") as HTMLInputElement;
    await user.clear(priceInput);

    expect(priceInput).toHaveValue(null);
    expect(onLimitPriceChange).not.toHaveBeenCalled();

    await user.type(priceInput, "0.75");
    expect(priceInput).toHaveValue(0.75);
    expect(onLimitPriceChange).not.toHaveBeenCalled();

    fireEvent.blur(priceInput);

    expect(onLimitPriceChange).toHaveBeenCalledWith(750);
    expect(priceInput).toHaveValue(0.75);
  });

  it("clamps the limit price to the market tick range on blur", async () => {
    const onLimitPriceChange = vi.fn();
    const user = userEvent.setup();

    render(
      <StatefulLimitTradingPanel initialLimitPrice={40} onLimitPriceChange={onLimitPriceChange} />,
    );

    const priceInput = screen.getByTestId("limit-price-input") as HTMLInputElement;
    await user.clear(priceInput);
    await user.type(priceInput, "5000");
    fireEvent.blur(priceInput);

    expect(onLimitPriceChange).toHaveBeenCalledWith(999);
    expect(priceInput).toHaveValue(0.999);
  });

  it("restores the previous valid limit price when the field is empty on blur", async () => {
    const onLimitPriceChange = vi.fn();
    const user = userEvent.setup();

    render(
      <StatefulLimitTradingPanel initialLimitPrice={40} onLimitPriceChange={onLimitPriceChange} />,
    );

    const priceInput = screen.getByTestId("limit-price-input") as HTMLInputElement;
    await user.clear(priceInput);

    expect(priceInput).toHaveValue(null);

    fireEvent.blur(priceInput);

    expect(onLimitPriceChange).not.toHaveBeenCalled();
    expect(priceInput).toHaveValue(0.04);
  });

  it("does not overwrite an in-progress limit price edit when live props refresh", async () => {
    const user = userEvent.setup();

    const { rerender } = render(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: "yes" }}
        tradeAmount={1}
        tradePreview={null}
        tradeSide="Buy"
        orderType="limit"
        limitPrice={40}
      />,
    );

    const priceInput = screen.getByTestId("limit-price-input") as HTMLInputElement;
    await user.click(priceInput);
    await user.clear(priceInput);
    await user.type(priceInput, "0.75");

    rerender(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: "yes" }}
        tradeAmount={1}
        tradePreview={null}
        tradeSide="Buy"
        orderType="limit"
        limitPrice={60}
      />,
    );

    expect(priceInput).toHaveValue(0.75);
  });

  it("does not overwrite an in-progress share amount edit when live props refresh", async () => {
    const user = userEvent.setup();

    const { rerender } = render(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: "yes" }}
        tradeAmount={2}
        tradePreview={null}
        tradeSide="Buy"
        orderType="limit"
        limitPrice={40}
      />,
    );

    const amountInput = screen.getByTestId("trade-amount-input") as HTMLInputElement;
    await user.click(amountInput);
    await user.clear(amountInput);
    await user.type(amountInput, "123");

    rerender(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: "yes" }}
        tradeAmount={9}
        tradePreview={null}
        tradeSide="Buy"
        orderType="limit"
        limitPrice={40}
      />,
    );

    expect(amountInput).toHaveValue(123);
  });

  it("allows the share amount to be cleared and restores zero on empty blur", async () => {
    const onAmountChange = vi.fn();
    const user = userEvent.setup();

    render(<StatefulLimitTradingPanel initialTradeAmount={2} onAmountChange={onAmountChange} />);

    const amountInput = screen.getByTestId("trade-amount-input") as HTMLInputElement;
    await user.clear(amountInput);

    expect(amountInput).toHaveValue(null);
    expect(onAmountChange).toHaveBeenCalledWith(0);

    fireEvent.blur(amountInput);

    expect(onAmountChange).toHaveBeenCalledWith(0);
    expect(amountInput).toHaveValue(null);
  });

  it("keeps an order error visible across input changes until explicit dismissal", async () => {
    const dismiss = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: "yes" }}
        tradeAmount={2}
        tradePreview={null}
        tradeSide="Buy"
        orderType="limit"
        limitPrice={40}
        tradeSubmitStatus={{ kind: "error", message: "Mint is unavailable." }}
        onTradeSubmitStatusDismiss={dismiss}
      />,
    );

    rerender(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: "yes" }}
        tradeAmount={3}
        tradePreview={null}
        tradeSide="Buy"
        orderType="limit"
        limitPrice={40}
        tradeSubmitStatus={{ kind: "error", message: "Mint is unavailable." }}
        onTradeSubmitStatusDismiss={dismiss}
      />,
    );

    expect(screen.getByTestId("trade-submit-status")).toHaveTextContent("Mint is unavailable.");
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("respects price ticks for D=1000 and D=1000000", () => {
    const { rerender } = render(
      <TradingPanel
        market={makeMarket({ divisibility: 1_000 })}
        tradeSelection={{ side: "yes" }}
        tradeAmount={1}
        tradePreview={null}
        tradeSide="Buy"
        orderType="limit"
        limitPrice={300}
      />,
    );

    expect(screen.getByText(/Price per share: 0\.30 sats \(30\.0%\)/)).toBeInTheDocument();

    rerender(
      <TradingPanel
        market={makeMarket({ divisibility: 1_000_000 })}
        tradeSelection={{ side: "yes" }}
        tradeAmount={1}
        tradePreview={null}
        tradeSide="Buy"
        orderType="limit"
        limitPrice={301_000}
      />,
    );

    expect(screen.getByText(/Price per share: 301\.00 sats \(30\.1000%\)/)).toBeInTheDocument();
  });
});
