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
      limitPrice: 4_000,
      feePercent: 0,
      mintInputFeePpk: 0,
      baseAsset: "sat",
      divisibility: 10_000,
    });
    expect(preview.amount).toBe(10);
    expect(preview.totalCost).toBe(40_000);
  });

  it("reacts to the limit price", () => {
    const cheap = computeLimitOrderPreview({
      displayShares: 10,
      limitPrice: 1_000,
      feePercent: 0,
      mintInputFeePpk: 0,
      baseAsset: "sat",
      divisibility: 10_000,
    });
    const pricey = computeLimitOrderPreview({
      displayShares: 10,
      limitPrice: 9_000,
      feePercent: 0,
      mintInputFeePpk: 0,
      baseAsset: "sat",
      divisibility: 10_000,
    });
    expect(cheap.totalCost).toBe(10_000);
    expect(pricey.totalCost).toBe(90_000);
    expect(pricey.totalCost).toBeGreaterThan(cheap.totalCost);
  });

  it("adds the creator fee on top of the quote", () => {
    // quote = 10 display shares * D face * 5,000 / D=10,000 = 50,000;
    // creator fee 2% of 50,000 = 1,000.
    const preview = computeLimitOrderPreview({
      displayShares: 10,
      limitPrice: 5_000,
      feePercent: 2,
      mintInputFeePpk: 0,
      baseAsset: "sat",
      divisibility: 10_000,
    });
    expect(preview.creatorFee).toBe(1_000);
    expect(preview.mintFee).toBe(0);
    expect(preview.totalCost).toBe(51_000);
  });

  it("exposes the pre-fee shares-times-price quote", () => {
    const preview = computeLimitOrderPreview({
      displayShares: 3,
      limitPrice: 5_000,
      feePercent: 0,
      mintInputFeePpk: 0,
      baseAsset: "sat",
      divisibility: 10_000,
    });
    expect(preview.quoteSubunits).toBe(15_000);
  });

  it("pins share-ticket math for 50 sat shares at price 300 with D=10000", () => {
    const preview = computeLimitOrderPreview({
      displayShares: 50,
      limitPrice: 300,
      feePercent: 0,
      mintInputFeePpk: 0,
      baseAsset: "sat",
      divisibility: 10_000,
    });

    expect(preview.quoteSubunits).toBe(15_000);
    expect(preview.totalCost).toBe(15_000);
    expect(preview.potentialPayout).toBe(500_000);
  });

  it("collapses the mint fee to 0 for the first-release zero-fee mint", () => {
    const preview = computeLimitOrderPreview({
      displayShares: 50,
      limitPrice: 33,
      feePercent: 1,
      mintInputFeePpk: 0,
      baseAsset: "sat",
      divisibility: 10_000,
    });
    expect(preview.mintFee).toBe(0);
  });

  it("includes a non-zero mint fee when the keyset advertises input_fee_ppk", () => {
    // quote = 10 * 10,000 * 5,000 / 10,000 = 50,000;
    // mint fee = ceil(50,000 * 100 / 1000) = 5,000.
    const preview = computeLimitOrderPreview({
      displayShares: 10,
      limitPrice: 5_000,
      feePercent: 0,
      mintInputFeePpk: 100,
      baseAsset: "sat",
      divisibility: 10_000,
    });
    expect(preview.mintFee).toBe(5_000);
    expect(preview.totalCost).toBe(55_000);
  });
});

describe("computeTradeCost", () => {
  it("derives the spend from display shares while protocol face stays separate", () => {
    const cost = computeTradeCost({
      displayShares: 10,
      price: 4_000,
      feePercent: 0,
      mintInputFeePpk: 0,
      baseAsset: "sat",
      divisibility: 10_000,
    });
    expect(cost.quoteSubunits).toBe(40_000);
    expect(cost.totalCost).toBe(40_000);
    expect(cost.totalCost).toBeLessThan(1_000_000);
  });

  it("computes the creator fee on the QUOTE, not the face amount", () => {
    // Use a price/fee combo where face-vs-quote bases diverge clearly:
    // price 5,000, fee 10% → quote 50,000, creatorFee 5,000 (quote basis)
    // vs 10,000 (face basis).
    const cost = computeTradeCost({
      displayShares: 10,
      price: 5_000,
      feePercent: 10,
      mintInputFeePpk: 0,
      baseAsset: "sat",
      divisibility: 10_000,
    });
    expect(cost.quoteSubunits).toBe(50_000);
    expect(cost.creatorFee).toBe(5_000); // 10% of quote, not of face
    expect(cost.creatorFee).not.toBe(10_000); // would be the face-basis bug
    expect(cost.totalCost).toBe(55_000);
  });

  it("matches the market worst-case (price 9999) buy cost basis", () => {
    const cost = computeTradeCost({
      displayShares: 10,
      price: 9_999,
      feePercent: 0,
      mintInputFeePpk: 0,
      baseAsset: "sat",
      divisibility: 10_000,
    });
    expect(cost.quoteSubunits).toBe(99_990);
    expect(cost.totalCost).toBe(99_990);
  });

  it("lets the balance gate pass when wallet >= derived cost but < face (price < 100)", () => {
    // Regression for P22 C LOW: the pre-submit gate compares wallet balance
    // against `computeTradeCost(...).totalCost`, NOT the face amount. A wallet
    // holding 45,000 subunits can afford 10 shares @ 40% (cost 40,000).
    const face = displaySharesToFaceSubunits(10, "sat", 10_000);
    const walletBalance = 45_000;
    const requiredSats = computeTradeCost({
      displayShares: 10,
      price: 4_000,
      feePercent: 0,
      mintInputFeePpk: 0,
      baseAsset: "sat",
      divisibility: 10_000,
    }).totalCost;

    // The gate's actual comparison: `current < requiredSats` => blocked.
    expect(walletBalance < requiredSats).toBe(false); // passes the gate
    // The old face-based gate would have wrongly blocked this affordable trade.
    expect(walletBalance < face).toBe(true);
  });

  it("agrees with computeLimitOrderPreview for the same inputs", () => {
    const cost = computeTradeCost({
      displayShares: 20,
      price: 3_300,
      feePercent: 1,
      mintInputFeePpk: 0,
      baseAsset: "sat",
      divisibility: 10_000,
    });
    const preview = computeLimitOrderPreview({
      displayShares: 20,
      limitPrice: 3_300,
      feePercent: 1,
      mintInputFeePpk: 0,
      baseAsset: "sat",
      divisibility: 10_000,
    });
    expect(preview.totalCost).toBe(cost.totalCost);
    expect(preview.creatorFee).toBe(cost.creatorFee);
    expect(preview.mintFee).toBe(cost.mintFee);
  });
});

describe("trade display-unit conversion", () => {
  it("maps display shares to the market divisibility share face", () => {
    expect(displaySharesToFaceSubunits(3, "sat", 10_000)).toBe(30_000);
    expect(faceSubunitsToDisplayShares(30_000, "sat", 10_000)).toBe(3);
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
      tradeSide: "Buy",
      divisibility: 10_000,
      orderBook: {
        bids: [],
        asks: [
          { price: 4_000, amount: 10_000, total: 10_000 },
          { price: 5_000, amount: 20_000, total: 30_000 },
        ],
        spread: 1_000,
      },
    });

    expect(quote?.executableDisplayShares).toBe(3);
    expect(quote?.quoteSubunits).toBe(14_000);
    expect(quote?.averageExecutionPrice).toBeCloseTo(4_666.67, 2);
  });

  it("walks bid depth for sells", () => {
    const quote = computeMarketOrderQuotePreview({
      displayShares: 2,
      tradeSide: "Sell",
      divisibility: 10_000,
      orderBook: {
        bids: [{ price: 4_500, amount: 20_000, total: 20_000 }],
        asks: [],
        spread: 1_000,
      },
    });

    expect(quote?.executableDisplayShares).toBe(2);
    expect(quote?.quoteSubunits).toBe(9_000);
    expect(quote?.averageExecutionPrice).toBe(4_500);
  });

  it("quotes complementary bids for market buys when the direct ask book is empty", () => {
    const quote = computeMarketOrderQuotePreview({
      displayShares: 2,
      tradeSide: "Buy",
      divisibility: 10_000,
      orderBook: { bids: [], asks: [], spread: 0 },
      complementaryOrderBook: {
        bids: [{ price: 4_200, amount: 20_000, total: 20_000 }],
        asks: [],
        spread: 0,
      },
    });

    expect(quote?.executableDisplayShares).toBe(2);
    expect(quote?.averageExecutionPrice).toBe(5_800);
    expect(quote?.quoteSubunits).toBe(11_600);
  });

  it("does not treat complementary-book asks as executable market-buy liquidity", () => {
    expect(
      computeMarketOrderQuotePreview({
        displayShares: 1,
        tradeSide: "Buy",
        divisibility: 10_000,
        orderBook: null,
        complementaryOrderBook: {
          bids: [],
          asks: [{ price: 3_500, amount: 10_000, total: 10_000 }],
          spread: 0,
        },
      }),
    ).toBeNull();
  });

  it("uses complementary bids rather than complementary asks for market buys", () => {
    const quote = computeMarketOrderQuotePreview({
      displayShares: 1,
      tradeSide: "Buy",
      divisibility: 10_000,
      orderBook: null,
      complementaryOrderBook: {
        bids: [{ price: 6_000, amount: 10_000, total: 10_000 }],
        asks: [{ price: 3_500, amount: 10_000, total: 10_000 }],
        spread: 2_500,
      },
    });

    expect(quote?.averageExecutionPrice).toBe(4_000);
    expect(quote?.quoteSubunits).toBe(4_000);
  });

  it("uses direct asks before complementary bids for partial market buys", () => {
    const quote = computeMarketOrderQuotePreview({
      displayShares: 3,
      tradeSide: "Buy",
      divisibility: 10_000,
      orderBook: {
        bids: [],
        asks: [{ price: 3_500, amount: 10_000, total: 10_000 }],
        spread: 0,
      },
      complementaryOrderBook: {
        bids: [{ price: 4_200, amount: 20_000, total: 20_000 }],
        asks: [],
        spread: 0,
      },
    });

    expect(quote?.executableDisplayShares).toBe(3);
    expect(quote?.quoteSubunits).toBe(15_100);
    expect(quote?.averageExecutionPrice).toBeCloseTo(5_033.33, 2);
  });

  it("returns null when no executable depth is available", () => {
    expect(
      computeMarketOrderQuotePreview({
        displayShares: 1,
        tradeSide: "Buy",
        divisibility: 10_000,
        orderBook: { bids: [], asks: [], spread: 0 },
      }),
    ).toBeNull();
  });
});
