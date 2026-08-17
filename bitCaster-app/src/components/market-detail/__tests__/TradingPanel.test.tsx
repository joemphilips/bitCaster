import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TradingPanel } from "../TradingPanel";
import type {
  CategoricalMarketDetail,
  LimitOrderPreview,
  NumericMarketDetail,
  TradePreview,
  YesNoMarketDetail,
} from "@/types/market-detail";
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
    divisibility: 10_000,
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
      bids: [{ price: 4_000, amount: 100, total: 100 }],
      asks: [{ price: 6_000, amount: 100, total: 100 }],
      spread: 2_000,
    },
    recentTrades: [],
    comments: [],
    relatedMarkets: [],
    currentOdds: { yes: 50, no: 50 },
    ...overrides,
  };
}

describe("TradingPanel", () => {
  const emptyBook = {
    bids: [],
    asks: [],
    spread: 0,
  };

  function makeEmptyBookMarket(divisibility: 10_000 | 1_000_000 = 10_000): YesNoMarketDetail {
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
    expect(screen.getByTestId("detail-deposit-step")).toHaveTextContent("sat-market:10000");
  });

  it("renders no BUY or SELL controls for an empty book and opens LIQUIDITY", async () => {
    const user = userEvent.setup();
    const onTradeConfirm = vi.fn();
    render(
      <TradingPanel
        market={makeEmptyBookMarket()}
        tradeSelection={{ side: "yes" }}
        tradeAmount={2}
        tradePreview={null}
        tradeSide="Buy"
        orderType="limit"
        onTradeConfirm={onTradeConfirm}
      />,
    );

    expect(screen.getByTestId("empty-trade-liquidity")).toBeInTheDocument();
    expect(screen.queryByTestId("trade-amount-input")).not.toBeInTheDocument();
    expect(screen.queryByTestId("trade-confirm")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("trade-tab-sell"));
    expect(screen.getByTestId("empty-trade-liquidity")).toBeInTheDocument();
    expect(screen.queryByTestId("trade-confirm")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("open-liquidity-tab"));
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

  it("keeps the BUY body empty when every route is empty before selection", () => {
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

    expect(screen.getByTestId("empty-trade-liquidity")).toBeInTheDocument();
    expect(screen.queryByTestId("trade-amount-input")).not.toBeInTheDocument();
    expect(screen.queryByTestId("trade-confirm")).not.toBeInTheDocument();
  });

  it("counts complementary bids as BUY liquidity and direct bids as SELL liquidity", () => {
    const market = makeEmptyBookMarket();
    const withComplementBid = {
      ...market,
      outcomeOrderBooks: {
        Yes: emptyBook,
        No: { ...emptyBook, bids: [{ price: 3_000, amount: 100, total: 100 }] },
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
            Yes: { ...emptyBook, bids: [{ price: 4_000, amount: 100, total: 100 }] },
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
        { id: "outcome-0", label: "Alice", odds: null },
        { id: "outcome-1", label: "Bob", odds: null },
        { id: "outcome-2", label: "Carol", odds: null },
      ],
      outcomePriceHistories: {},
      orderBook: emptyBook,
      outcomeOrderBooks: {
        Alice: { ...emptyBook, bids: [{ price: 3_000, amount: 100, total: 100 }] },
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

    expect(screen.getAllByText("No trades yet")).toHaveLength(2);
    expect(screen.queryAllByText("market.priceUnavailable")).toHaveLength(0);
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

    expect(screen.getAllByText("market.priceUnavailable")).toHaveLength(2);
    expect(screen.queryAllByText("No trades yet")).toHaveLength(0);
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
            priceTick: 2_500,
            divisibility: 10_000,
            faceAmountSubunits: 100,
          },
        ],
        latestConfirmedTradesValid: true,
      }),
      type: "categorical" as const,
      outcomes: [
        { id: "Alice", label: "Alice", odds: 2_500 },
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

    expect(screen.getByText("25.00%")).toBeInTheDocument();
    expect(screen.getByText("No trades yet")).toBeInTheDocument();
    expect(screen.queryByText("market.priceUnavailable")).not.toBeInTheDocument();
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

  it("uses a share input and shows market quote payment plus estimated settlement fee", () => {
    const tradePreview: TradePreview = {
      amount: 50,
      predictedOdds: 50,
      priceImpact: 0,
      averageExecutionPrice: 3_000,
      executableShares: 25,
      hasExecutableLiquidity: true,
      quoteSubunits: 150_000,
      mintFee: 0,
      potentialPayout: 500_000,
      creatorFee: 1,
      engineScoreFeeSats: 0,
      totalCost: 150_000,
    };

    render(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: "yes" }}
        tradeAmount={50}
        tradePreview={tradePreview}
        tradeSide="Buy"
        orderType="market"
        onTradeConfirm={vi.fn()}
      />,
    );

    expect(screen.getByText("Shares")).toBeInTheDocument();
    expect(screen.getByText("1 share = 10 sats")).toBeInTheDocument();
    expect(screen.getByText("Price per share")).toBeInTheDocument();
    expect(screen.getByText("Quote payment")).toBeInTheDocument();
    expect(screen.getByText("Est. settlement fee")).toBeInTheDocument();
    expect(screen.getByTestId("trade-total-cost")).toHaveTextContent("150 sats");
    expect(screen.getByTestId("trade-settlement-fee")).toHaveTextContent("10 sats");
    expect(screen.getByTestId("trade-grand-total")).toHaveTextContent("160 sats");
    expect(screen.getByRole("button", { name: "Buy YES for 50 shares" })).toBeInTheDocument();
    expect(screen.queryByText("Executable shares")).not.toBeInTheDocument();
    expect(screen.queryByText("Market Creator fee (1%)")).not.toBeInTheDocument();
    expect(screen.queryByText("Mint fee")).not.toBeInTheDocument();
    expect(screen.queryByText("Engine Score fee")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Gross settlement payout per filled share if this outcome wins"),
    ).not.toBeInTheDocument();
  });

  it("turns buy submit into a top-up button when local funds are insufficient", () => {
    const onTopUpRequired = vi.fn();
    render(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: "yes" }}
        tradeAmount={2}
        tradePreview={null}
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

  it("keeps submit enabled when local backing is sufficient", () => {
    const onTradeConfirm = vi.fn();
    render(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: "yes" }}
        tradeAmount={2}
        tradePreview={null}
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

  it("shows a non-zero mint fee separately from the market quote payment", () => {
    const tradePreview: TradePreview = {
      amount: 50,
      predictedOdds: 50,
      priceImpact: 0,
      averageExecutionPrice: 30,
      executableShares: 25,
      hasExecutableLiquidity: true,
      quoteSubunits: 150,
      mintFee: 100,
      potentialPayout: 500,
      creatorFee: 1,
      engineScoreFeeSats: 0,
      totalCost: 250,
    };

    render(
      <TradingPanel
        market={makeMarket()}
        tradeSelection={{ side: "yes" }}
        tradeAmount={50}
        tradePreview={tradePreview}
        tradeSide="Buy"
        orderType="market"
        onTradeConfirm={vi.fn()}
      />,
    );

    expect(screen.getByTestId("trade-total-cost")).toHaveTextContent("0.15 sats");
    expect(screen.getByTestId("trade-mint-fee")).toHaveTextContent("0.1 sats");
    expect(screen.getByTestId("trade-grand-total")).toHaveTextContent("10.25 sats");
  });

  it("formats sat-denominated limit preview as price plus quote payment and estimated settlement fee", () => {
    const preview: LimitOrderPreview = {
      limitPrice: 3_000,
      amount: 50,
      sharesIfFilled: 50,
      quoteSubunits: 150_000,
      creatorFee: 0,
      mintFee: 0,
      engineScoreFeeSats: 0,
      potentialPayout: 500_000,
      totalCost: 150_000,
    };

    render(
      <TradingPanel
        market={makeMarket({ baseAsset: "sat", baseUnit: "sats", divisibility: 10_000 })}
        tradeSelection={{ side: "yes" }}
        tradeAmount={50}
        tradePreview={null}
        tradeSide="Buy"
        orderType="limit"
        limitPrice={3_000}
        limitOrderPreview={preview}
        onTradeConfirm={vi.fn()}
      />,
    );

    expect(screen.getByText("Price per share")).toBeInTheDocument();
    expect(screen.getByText("3.00 sats (30.00%)")).toBeInTheDocument();
    expect(screen.getByText("Quote payment")).toBeInTheDocument();
    expect(screen.getByText("Est. settlement fee")).toBeInTheDocument();
    expect(screen.getByTestId("limit-total-cost")).toHaveTextContent("150 sats");
    expect(screen.getByTestId("limit-settlement-fee")).toHaveTextContent("10 sats");
    expect(screen.getByTestId("limit-grand-total")).toHaveTextContent("160 sats");
    expect(screen.queryByText("Shares you receive if order fills")).not.toBeInTheDocument();
    expect(screen.queryByText("Market Creator fee (1%)")).not.toBeInTheDocument();
    expect(screen.queryByText("Mint fee")).not.toBeInTheDocument();
    expect(screen.queryByText("Engine Score fee")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Gross settlement payout per filled share if this outcome wins"),
    ).not.toBeInTheDocument();
  });

  it("formats P40 sat-market subunit totals as display sats", () => {
    const preview: LimitOrderPreview = {
      limitPrice: 100,
      amount: 1,
      sharesIfFilled: 1,
      quoteSubunits: 100,
      creatorFee: 0,
      mintFee: 1,
      engineScoreFeeSats: 0,
      potentialPayout: 10_000,
      totalCost: 101,
    };

    render(
      <TradingPanel
        market={makeMarket({ baseAsset: "sat", baseUnit: "sats", divisibility: 10_000 })}
        tradeSelection={{ side: "yes" }}
        tradeAmount={1}
        tradePreview={null}
        tradeSide="Buy"
        orderType="limit"
        limitPrice={100}
        limitOrderPreview={preview}
        onTradeConfirm={vi.fn()}
      />,
    );

    expect(screen.getByText("1 share = 10 sats")).toBeInTheDocument();
    expect(screen.getByText("0.10 sats (1.00%)")).toBeInTheDocument();
    expect(screen.getByTestId("limit-total-cost")).toHaveTextContent(/^0\.1 sats$/);
    expect(screen.getByTestId("limit-mint-fee")).toHaveTextContent(/^0\.001 sats$/);
  });

  it("displays sat-market limit prices as sats, not raw msat subunits", () => {
    const preview: LimitOrderPreview = {
      limitPrice: 8_500,
      amount: 1,
      sharesIfFilled: 1,
      quoteSubunits: 8_500,
      creatorFee: 0,
      mintFee: 0,
      engineScoreFeeSats: 0,
      potentialPayout: 10_000,
      totalCost: 8_500,
    };

    render(
      <TradingPanel
        market={makeMarket({ baseAsset: "sat", baseUnit: "sats", divisibility: 10_000 })}
        tradeSelection={{ side: "yes" }}
        tradeAmount={1}
        tradePreview={null}
        tradeSide="Buy"
        orderType="limit"
        limitPrice={8_500}
        limitOrderPreview={preview}
        onTradeConfirm={vi.fn()}
      />,
    );

    expect(screen.getByTestId("limit-price-input")).toHaveValue(8.5);
    expect(screen.getByText("8.50 sats (85.00%)")).toBeInTheDocument();
    expect(screen.queryByText("8500 sats")).not.toBeInTheDocument();
  });

  it("uses market divisibility when displaying one-share face value", () => {
    const preview: LimitOrderPreview = {
      limitPrice: 30,
      amount: 1,
      sharesIfFilled: 1,
      quoteSubunits: 30,
      creatorFee: 0,
      mintFee: 0,
      engineScoreFeeSats: 0,
      potentialPayout: 100,
      totalCost: 30,
    };

    render(
      <TradingPanel
        market={makeMarket({ baseAsset: "sat", baseUnit: "sats", divisibility: 10_000 })}
        tradeSelection={{ side: "yes" }}
        tradeAmount={1}
        tradePreview={null}
        tradeSide="Buy"
        orderType="limit"
        limitPrice={30}
        limitOrderPreview={preview}
        onTradeConfirm={vi.fn()}
      />,
    );

    expect(screen.getByText("1 share = 10 sats")).toBeInTheDocument();
  });

  it("shows only the non-zero mint fee in the simplified limit preview", () => {
    const preview: LimitOrderPreview = {
      limitPrice: 30,
      amount: 50,
      sharesIfFilled: 50,
      quoteSubunits: 1_500,
      creatorFee: 15,
      mintFee: 2,
      engineScoreFeeSats: 0,
      potentialPayout: 500,
      totalCost: 1_517,
    };

    render(
      <TradingPanel
        market={makeMarket({ baseAsset: "sat", baseUnit: "sats", divisibility: 10_000 })}
        tradeSelection={{ side: "yes" }}
        tradeAmount={50}
        tradePreview={null}
        tradeSide="Buy"
        orderType="limit"
        limitPrice={30}
        limitOrderPreview={preview}
        onTradeConfirm={vi.fn()}
      />,
    );

    expect(
      screen.queryByTitle("Paid to the market creator as a reward for creating this market"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTitle("Charged by the Cashu mint for processing the transaction"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTitle("Charged by the matching engine for order execution"),
    ).not.toBeInTheDocument();
  });

  it("shows a non-zero mint fee separately from the limit quote payment", () => {
    const preview: LimitOrderPreview = {
      limitPrice: 30,
      amount: 50,
      sharesIfFilled: 50,
      quoteSubunits: 1_500,
      creatorFee: 500,
      mintFee: 250,
      engineScoreFeeSats: 0,
      potentialPayout: 500,
      totalCost: 2_250,
    };

    render(
      <TradingPanel
        market={makeMarket({ baseAsset: "sat", baseUnit: "sats", divisibility: 10_000 })}
        tradeSelection={{ side: "yes" }}
        tradeAmount={50}
        tradePreview={null}
        tradeSide="Buy"
        orderType="limit"
        limitPrice={30}
        limitOrderPreview={preview}
        onTradeConfirm={vi.fn()}
      />,
    );

    expect(screen.getByTestId("limit-total-cost")).toHaveTextContent("2 sats");
    expect(screen.getByTestId("limit-mint-fee")).toHaveTextContent("0.25 sats");
    expect(screen.getByTestId("limit-grand-total")).toHaveTextContent("12.25 sats");
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

    expect(onLimitPriceChange).toHaveBeenCalledWith(9_999);
    expect(priceInput).toHaveValue(9.999);
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

  it("respects price ticks for D=10000 and D=1000000", () => {
    const preview: LimitOrderPreview = {
      limitPrice: 3_000,
      amount: 1,
      sharesIfFilled: 1,
      quoteSubunits: 3_000,
      creatorFee: 0,
      mintFee: 0,
      engineScoreFeeSats: 0,
      potentialPayout: 10_000,
      totalCost: 3_000,
    };

    const { rerender } = render(
      <TradingPanel
        market={makeMarket({ divisibility: 10_000 })}
        tradeSelection={{ side: "yes" }}
        tradeAmount={1}
        tradePreview={null}
        tradeSide="Buy"
        orderType="limit"
        limitPrice={3_000}
        limitOrderPreview={preview}
      />,
    );

    expect(screen.getByText("3.00 sats (30.00%)")).toBeInTheDocument();

    rerender(
      <TradingPanel
        market={makeMarket({ divisibility: 1_000_000 })}
        tradeSelection={{ side: "yes" }}
        tradeAmount={1}
        tradePreview={null}
        tradeSide="Buy"
        orderType="limit"
        limitPrice={301_000}
        limitOrderPreview={{
          ...preview,
          limitPrice: 301_000,
          quoteSubunits: 301_000,
          potentialPayout: 1_000_000,
          totalCost: 301_000,
        }}
      />,
    );

    expect(screen.getByText("301.00 sats (30.10%)")).toBeInTheDocument();
  });
});
