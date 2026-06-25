import { describe, expect, it } from "vitest";
import {
  computeLimitOrderPreview,
  computeMarketOrderQuotePreview,
  computeTradeCost,
  displaySharesToFaceSubunits,
  faceSubunitsToDisplayShares,
} from "@/lib/tradeCostPreview";

describe("computeLimitOrderPreview", () => {
  it("derives a reactive total cost from display shares × price", () => {
    const preview = computeLimitOrderPreview({
      displayShares: 10,
      limitPrice: 40,
      feePercent: 0,
      mintInputFeePpk: 0,
    });
    expect(preview.amount).toBe(10);
    expect(preview.totalCost).toBe(400);
  });

  it("reacts to the limit price", () => {
    const cheap = computeLimitOrderPreview({
      displayShares: 10,
      limitPrice: 10,
      feePercent: 0,
      mintInputFeePpk: 0,
    });
    const pricey = computeLimitOrderPreview({
      displayShares: 10,
      limitPrice: 90,
      feePercent: 0,
      mintInputFeePpk: 0,
    });
    expect(cheap.totalCost).toBe(100);
    expect(pricey.totalCost).toBe(900);
    expect(pricey.totalCost).toBeGreaterThan(cheap.totalCost);
  });

  it("adds the creator fee on top of the quote", () => {
    // quote = 10 display shares * D face * 50 / D=10,000 = 500;
    // creator fee 2% of 500 = 10.
    const preview = computeLimitOrderPreview({
      displayShares: 10,
      limitPrice: 50,
      feePercent: 2,
      mintInputFeePpk: 0,
    });
    expect(preview.creatorFee).toBe(10);
    expect(preview.mintFee).toBe(0);
    expect(preview.totalCost).toBe(510);
  });

  it("exposes the pre-fee shares-times-price quote", () => {
    const preview = computeLimitOrderPreview({
      displayShares: 3,
      limitPrice: 50,
      feePercent: 0,
      mintInputFeePpk: 0,
    });
    expect(preview.quoteSubunits).toBe(150);
  });

  it("pins share-ticket math for 50 sat shares at price 300 with D=1000", () => {
    const preview = computeLimitOrderPreview({
      displayShares: 50,
      limitPrice: 300,
      feePercent: 0,
      mintInputFeePpk: 0,
      baseAsset: "sat",
      divisibility: 1_000,
    });

    expect(preview.quoteSubunits).toBe(15_000);
    expect(preview.totalCost).toBe(15_000);
    expect(preview.potentialPayout).toBe(50_000);
  });

  it("collapses the mint fee to 0 for the first-release zero-fee mint", () => {
    const preview = computeLimitOrderPreview({
      displayShares: 50,
      limitPrice: 33,
      feePercent: 1,
      mintInputFeePpk: 0,
    });
    expect(preview.mintFee).toBe(0);
  });

  it("includes a non-zero mint fee when the keyset advertises input_fee_ppk", () => {
    // quote = 10 * 10,000 * 50 / 10,000 = 500;
    // mint fee = ceil(500 * 100 / 1000) = 50.
    const preview = computeLimitOrderPreview({
      displayShares: 10,
      limitPrice: 50,
      feePercent: 0,
      mintInputFeePpk: 100,
    });
    expect(preview.mintFee).toBe(50);
    expect(preview.totalCost).toBe(550);
  });
});

describe("computeTradeCost", () => {
  it("derives the spend from display shares while protocol face stays separate", () => {
    const cost = computeTradeCost({
      displayShares: 10,
      price: 40,
      feePercent: 0,
      mintInputFeePpk: 0,
    });
    expect(cost.quoteSubunits).toBe(400);
    expect(cost.totalCost).toBe(400);
    expect(cost.totalCost).toBeLessThan(1_000_000);
  });

  it("computes the creator fee on the QUOTE, not the face amount", () => {
    // Use a price/fee combo where face-vs-quote bases diverge clearly:
    // price 50, fee 10% → quote 500, creatorFee 50 (quote basis)
    // vs 10,000 (face basis).
    const cost = computeTradeCost({
      displayShares: 10,
      price: 50,
      feePercent: 10,
      mintInputFeePpk: 0,
    });
    expect(cost.quoteSubunits).toBe(500);
    expect(cost.creatorFee).toBe(50); // 10% of quote 500, not of face 100,000
    expect(cost.creatorFee).not.toBe(10_000); // would be the face-basis bug
    expect(cost.totalCost).toBe(550);
  });

  it("matches the market worst-case (price 99) buy cost basis", () => {
    // For a market buy the effective price used for the max-cost estimate is 99.
    const cost = computeTradeCost({
      displayShares: 10,
      price: 99,
      feePercent: 0,
      mintInputFeePpk: 0,
    });
    expect(cost.quoteSubunits).toBe(990);
    expect(cost.totalCost).toBe(990);
  });

  it("lets the balance gate pass when wallet >= derived cost but < face (price < 100)", () => {
    // Regression for P22 C LOW: the pre-submit gate compares wallet balance
    // against `computeTradeCost(...).totalCost`, NOT the face amount. A wallet
    // holding 450 sats can afford 10 shares (100,000 face) @ price 40 (cost 400).
    const face = displaySharesToFaceSubunits(10);
    const walletBalance = 450;
    const requiredSats = computeTradeCost({
      displayShares: 10,
      price: 40,
      feePercent: 0,
      mintInputFeePpk: 0,
    }).totalCost;

    // The gate's actual comparison: `current < requiredSats` => blocked.
    expect(walletBalance < requiredSats).toBe(false); // passes the gate
    // The old face-based gate would have wrongly blocked this affordable trade.
    expect(walletBalance < face).toBe(true);
  });

  it("agrees with computeLimitOrderPreview for the same inputs", () => {
    const cost = computeTradeCost({
      displayShares: 20,
      price: 33,
      feePercent: 1,
      mintInputFeePpk: 0,
    });
    const preview = computeLimitOrderPreview({
      displayShares: 20,
      limitPrice: 33,
      feePercent: 1,
      mintInputFeePpk: 0,
    });
    expect(preview.totalCost).toBe(cost.totalCost);
    expect(preview.creatorFee).toBe(cost.creatorFee);
    expect(preview.mintFee).toBe(cost.mintFee);
  });
});

describe("trade display-unit conversion", () => {
  it("maps display shares to the market divisibility share face", () => {
    expect(displaySharesToFaceSubunits(3, "sat")).toBe(30_000);
    expect(faceSubunitsToDisplayShares(30_000, "sat")).toBe(3);
    expect(displaySharesToFaceSubunits(3, "usd")).toBe(3_000);
    expect(faceSubunitsToDisplayShares(3_000, "usd")).toBe(3);
  });

  it("uses D=10000 as both price precision and share face", () => {
    const preview = computeLimitOrderPreview({
      displayShares: 2,
      limitPrice: 5_000,
      feePercent: 0,
      mintInputFeePpk: 0,
      divisibility: 10_000,
      baseAsset: "sat",
    });

    expect(preview.quoteSubunits).toBe(10_000);
    expect(preview.potentialPayout).toBe(20_000);
  });
});

describe("computeMarketOrderQuotePreview", () => {
  it("walks ask depth and returns average execution price for buys", () => {
    const quote = computeMarketOrderQuotePreview({
      displayShares: 3,
      tradeSide: "buy",
      divisibility: 100,
      orderBook: {
        bids: [],
        asks: [
      { price: 40, amount: 100, total: 100 },
      { price: 50, amount: 200, total: 300 },
        ],
        spread: 10,
      },
    });

    expect(quote?.executableDisplayShares).toBe(3);
    expect(quote?.quoteSubunits).toBe(140);
    expect(quote?.averageExecutionPrice).toBeCloseTo(46.67, 2);
  });

  it("walks bid depth for sells", () => {
    const quote = computeMarketOrderQuotePreview({
      displayShares: 2,
      tradeSide: "sell",
      divisibility: 100,
      orderBook: {
        bids: [{ price: 45, amount: 200, total: 200 }],
        asks: [],
        spread: 10,
      },
    });

    expect(quote?.executableDisplayShares).toBe(2);
    expect(quote?.quoteSubunits).toBe(90);
    expect(quote?.averageExecutionPrice).toBe(45);
  });

  it("quotes complementary bids for market buys when the direct ask book is empty", () => {
    const quote = computeMarketOrderQuotePreview({
      displayShares: 2,
      tradeSide: "buy",
      divisibility: 100,
      orderBook: { bids: [], asks: [], spread: 0 },
      complementaryOrderBook: {
        bids: [{ price: 42, amount: 200, total: 200 }],
        asks: [],
        spread: 0,
      },
    });

    expect(quote?.executableDisplayShares).toBe(2);
    expect(quote?.averageExecutionPrice).toBe(58);
    expect(quote?.quoteSubunits).toBe(116);
  });

  it("does not treat complementary-book asks as executable market-buy liquidity", () => {
    expect(
      computeMarketOrderQuotePreview({
        displayShares: 1,
        tradeSide: "buy",
        divisibility: 100,
        orderBook: null,
        complementaryOrderBook: {
          bids: [],
          asks: [{ price: 35, amount: 100, total: 100 }],
          spread: 0,
        },
      }),
    ).toBeNull();
  });

  it("uses complementary bids rather than complementary asks for market buys", () => {
    const quote = computeMarketOrderQuotePreview({
      displayShares: 1,
      tradeSide: "buy",
      divisibility: 100,
      orderBook: null,
      complementaryOrderBook: {
        bids: [{ price: 60, amount: 100, total: 100 }],
        asks: [{ price: 35, amount: 100, total: 100 }],
        spread: 25,
      },
    });

    expect(quote?.averageExecutionPrice).toBe(40);
    expect(quote?.quoteSubunits).toBe(40);
  });

  it("uses direct asks before complementary bids for partial market buys", () => {
    const quote = computeMarketOrderQuotePreview({
      displayShares: 3,
      tradeSide: "buy",
      divisibility: 100,
      orderBook: {
        bids: [],
        asks: [{ price: 35, amount: 100, total: 100 }],
        spread: 0,
      },
      complementaryOrderBook: {
        bids: [{ price: 42, amount: 200, total: 200 }],
        asks: [],
        spread: 0,
      },
    });

    expect(quote?.executableDisplayShares).toBe(3);
    expect(quote?.quoteSubunits).toBe(151);
    expect(quote?.averageExecutionPrice).toBeCloseTo(50.33, 2);
  });

  it("returns null when no executable depth is available", () => {
    expect(
      computeMarketOrderQuotePreview({
        displayShares: 1,
        tradeSide: "buy",
        divisibility: 100,
        orderBook: { bids: [], asks: [], spread: 0 },
      }),
    ).toBeNull();
  });
});
