import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MarketDetail } from "../MarketDetail";
import type {
  MarketDetail as MarketDetailType,
  TradePreview,
} from "@/types/market-detail";

vi.mock("../MarketHeader", () => ({ MarketHeader: () => <div /> }));
vi.mock("../TradingPanel", () => ({ TradingPanel: () => <div /> }));
vi.mock("../PriceChart", () => ({ PriceChart: () => <div /> }));
const { orderBookSectionMock } = vi.hoisted(() => ({
  orderBookSectionMock: vi.fn(({ title }: { title?: string }) => (
    <div data-testid="order-book-panel">{title ?? "Order Book"}</div>
  )),
}));
vi.mock("../OrderBookSection", () => ({
  OrderBookSection: orderBookSectionMock,
}));
vi.mock("../ResolutionInfo", () => ({ ResolutionInfo: () => <div /> }));
vi.mock("../RelatedMarkets", () => ({ RelatedMarkets: () => <div /> }));
vi.mock("../CommentSection", () => ({ CommentSection: () => <div /> }));

function makeMarket(
  overrides: Partial<MarketDetailType> = {},
): MarketDetailType {
  return {
    id: "condition-1",
    title: "Will it happen?",
    type: "yesno",
    imageUrl: "",
    categoryTags: [],
    volume: 0,
    liquidity: 0,
    liquiditySubunits: 0,
    ammBotBudgetSubunits: 0,
    volumeLifetimeSubunits: 0,
    closingDate: "2030-01-01T00:00:00Z",
    createdDate: "2026-01-01T00:00:00Z",
    activeSince: "2026-01-01T00:00:00Z",
    state: "open",
    baseAsset: "sat",
    divisibility: 1_000,
    baseUnit: "sats",
    creator: {
      id: "creator",
      name: "Creator",
      totalMarketsCreated: 0,
      feePercent: 0,
    },
    resolution: {
      criteria: "Will it happen?",
      source: "oracle",
      resolutionDate: "2030-01-01T00:00:00Z",
      status: "open",
    },
    priceHistory: { data: [], timeframe: "7d" },
    orderBook: { bids: [], asks: [], spread: 0 },
    recentTrades: [],
    comments: [],
    relatedMarkets: [],
    currentOdds: { yes: 50, no: 50 },
    outcomes: [
      { id: "Yes", label: "Yes", odds: 50 },
      { id: "No", label: "No", odds: 50 },
    ],
    outcomeOrderBooks: {
      Yes: {
        bids: [{ price: 48, amount: 500, total: 500 }],
        asks: [{ price: 52, amount: 500, total: 500 }],
        spread: 4,
      },
      No: {
        bids: [{ price: 48, amount: 999, total: 999 }],
        asks: [{ price: 52, amount: 999, total: 999 }],
        spread: 4,
      },
    },
    ...overrides,
  } as MarketDetailType;
}

describe("MarketDetail", () => {
  it("renders one order book for a yes/no market", () => {
    orderBookSectionMock.mockClear();
    render(
      <MarketDetail
        market={makeMarket()}
        chartTimeframe="7d"
        tradeSelection={null}
        tradeAmount={0}
        tradePreview={null}
        tradeSide="Buy"
        orderType="market"
        limitOrderPreview={null}
        limitPrice={50}
      />,
    );

    expect(screen.getAllByTestId("order-book-panel")).toHaveLength(1);
    expect(orderBookSectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBook: expect.objectContaining({
          bids: [{ price: 48, amount: 500, total: 500 }],
          asks: [{ price: 52, amount: 500, total: 500 }],
          spread: 4,
        }),
      }),
      undefined,
    );
  });

  it("does not synthesize yes/no complement depth on non-default divisibility", () => {
    orderBookSectionMock.mockClear();
    render(
      <MarketDetail
        market={makeMarket({
          divisibility: 1000,
          outcomeOrderBooks: {
            Yes: {
              bids: [],
              asks: [{ price: 982, amount: 1000, total: 1000 }],
              spread: 0,
            },
            No: {
              bids: [{ price: 18, amount: 1000, total: 1000 }],
              asks: [{ price: 22, amount: 1000, total: 1000 }],
              spread: 4,
            },
          },
        })}
        chartTimeframe="7d"
        tradeSelection={null}
        tradeAmount={0}
        tradePreview={null}
        tradeSide="Buy"
        orderType="market"
        limitOrderPreview={null}
        limitPrice={500}
      />,
    );

    expect(screen.getAllByTestId("order-book-panel")).toHaveLength(1);
    expect(orderBookSectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBook: expect.objectContaining({
          bids: [],
          asks: [{ price: 982, amount: 1000, total: 1000 }],
          spread: 0,
        }),
      }),
      undefined,
    );
  });

  it("recomputes cumulative totals for the selected public book only", () => {
    orderBookSectionMock.mockClear();
    render(
      <MarketDetail
        market={makeMarket({
          outcomeOrderBooks: {
            Yes: {
              bids: [
                { price: 60, amount: 100, total: 1 },
                { price: 50, amount: 200, total: 1 },
              ],
              asks: [{ price: 70, amount: 300, total: 1 }],
              spread: 0,
            },
            No: {
              bids: [
                { price: 30, amount: 700, total: 1 },
                { price: 20, amount: 600, total: 1 },
              ],
              asks: [
                { price: 35, amount: 500, total: 1 },
                { price: 45, amount: 400, total: 1 },
              ],
              spread: 0,
            },
          },
        })}
        chartTimeframe="7d"
        tradeSelection={null}
        tradeAmount={0}
        tradePreview={null}
        tradeSide="Buy"
        orderType="market"
        limitOrderPreview={null}
        limitPrice={50}
      />,
    );

    expect(orderBookSectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBook: expect.objectContaining({
          bids: [
            { price: 60, amount: 100, total: 100 },
            { price: 50, amount: 200, total: 300 },
          ],
          asks: [{ price: 70, amount: 300, total: 300 }],
          spread: 10,
        }),
      }),
      undefined,
    );
  });

  it("renders public books for a two-outcome categorical market", () => {
    orderBookSectionMock.mockClear();
    render(
      <MarketDetail
        market={makeMarket({
          type: "categorical",
          outcomes: [
            { id: "outcome-0", label: "Alpha", odds: 70 },
            { id: "outcome-1", label: "Beta", odds: 30 },
          ],
          outcomePriceHistories: {
            Alpha: { data: [], timeframe: "7d" },
            Beta: { data: [], timeframe: "7d" },
          },
          outcomeOrderBooks: {
            Alpha: {
              bids: [{ price: 68, amount: 400, total: 400 }],
              asks: [{ price: 72, amount: 400, total: 400 }],
              spread: 4,
            },
            Beta: {
              bids: [{ price: 28, amount: 400, total: 400 }],
              asks: [{ price: 32, amount: 400, total: 400 }],
              spread: 4,
            },
          },
        })}
        chartTimeframe="7d"
        tradeSelection={null}
        tradeAmount={0}
        tradePreview={null}
        tradeSide="Buy"
        orderType="market"
        limitOrderPreview={null}
        limitPrice={50}
      />,
    );

    expect(screen.getAllByTestId("order-book-panel")).toHaveLength(2);
    expect(orderBookSectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Alpha",
        orderBook: expect.objectContaining({
          bids: [{ price: 68, amount: 400, total: 400 }],
          asks: [{ price: 72, amount: 400, total: 400 }],
          spread: 4,
        }),
      }),
      undefined,
    );
    expect(orderBookSectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Beta",
        orderBook: expect.objectContaining({
          bids: [{ price: 28, amount: 400, total: 400 }],
          asks: [{ price: 32, amount: 400, total: 400 }],
          spread: 4,
        }),
      }),
      undefined,
    );
  });

  it("renders direct books for three-outcome categorical markets", () => {
    orderBookSectionMock.mockClear();
    render(
      <MarketDetail
        market={makeMarket({
          type: "categorical",
          outcomes: [
            { id: "outcome-0", label: "Alpha", odds: 34 },
            { id: "outcome-1", label: "Beta", odds: 33 },
            { id: "outcome-2", label: "Gamma", odds: 33 },
          ],
          outcomePriceHistories: {
            Alpha: { data: [], timeframe: "7d" },
            Beta: { data: [], timeframe: "7d" },
            Gamma: { data: [], timeframe: "7d" },
          },
          outcomeOrderBooks: {
            Alpha: {
              bids: [
                { price: 31, amount: 100, total: 1 },
                { price: 30, amount: 50, total: 1 },
              ],
              asks: [],
              spread: 0,
            },
            Beta: {
              bids: [{ price: 32, amount: 200, total: 1 }],
              asks: [],
              spread: 0,
            },
            Gamma: {
              bids: [{ price: 33, amount: 300, total: 1 }],
              asks: [],
              spread: 0,
            },
          },
        })}
        chartTimeframe="7d"
        tradeSelection={null}
        tradeAmount={0}
        tradePreview={null}
        tradeSide="Buy"
        orderType="market"
        limitOrderPreview={null}
        limitPrice={50}
      />,
    );

    expect(screen.getAllByTestId("order-book-panel")).toHaveLength(3);
    expect(orderBookSectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Alpha",
        orderBook: expect.objectContaining({
          bids: [
            { price: 31, amount: 100, total: 100 },
            { price: 30, amount: 50, total: 150 },
          ],
        }),
      }),
      undefined,
    );
    expect(orderBookSectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Gamma",
        orderBook: expect.objectContaining({
          bids: [{ price: 33, amount: 300, total: 300 }],
        }),
      }),
      undefined,
    );
  });

  it("disables the mobile sticky confirm for market orders without executable liquidity", () => {
    const noLiquidityPreview: TradePreview = {
      amount: 1,
      predictedOdds: 0,
      priceImpact: 0,
      executableShares: 0,
      hasExecutableLiquidity: false,
      quoteSubunits: 0,
      mintFee: 0,
      potentialPayout: 0,
      creatorFee: 0,
      engineScoreFeeSats: 0,
      totalCost: 0,
    };

    render(
      <MarketDetail
        market={makeMarket()}
        chartTimeframe="7d"
        tradeSelection={{ side: "yes" }}
        tradeAmount={1}
        tradePreview={noLiquidityPreview}
        tradeSide="Buy"
        orderType="market"
        limitOrderPreview={null}
        limitPrice={50}
      />,
    );

    expect(screen.getByText("No liquidity")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  });
});
