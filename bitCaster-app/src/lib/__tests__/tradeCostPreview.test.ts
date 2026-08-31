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
      limitPrice: 400,
      feePercent: 0,
      mintInputFeePpk: 0,
      baseAsset: "sat",
      divisibility: 1_000,
    });
    expect(preview.amount).toBe(10);
    expect(preview.totalCost).toBe(4_000);
  });

  it("reacts to the limit price", () => {
    const cheap = computeLimitOrderPreview({
      displayShares: 10,
      limitPrice: 100,
      feePercent: 0,
      mintInputFeePpk: 0,
      baseAsset: "sat",
      divisibility: 1_000,
    });
    const pricey = computeLimitOrderPreview({
      displayShares: 10,
      limitPrice: 900,
      feePercent: 0,
      mintInputFeePpk: 0,
      baseAsset: "sat",
      divisibility: 1_000,
    });
    expect(cheap.totalCost).toBe(1_000);
    expect(pricey.totalCost).toBe(9_000);
    expect(pricey.totalCost).toBeGreaterThan(cheap.totalCost);
  });

  it("adds the creator fee on top of the quote", () => {
    // quote = 10 display shares * D face * 500 / D=1,000 = 5,000;
    // creator fee 2% of 5,000 = 100.
    const preview = computeLimitOrderPreview({
      displayShares: 10,
      limitPrice: 500,
      feePercent: 2,
      mintInputFeePpk: 0,
      baseAsset: "sat",
      divisibility: 1_000,
    });
    expect(preview.creatorFee).toBe(100);
    expect(preview.mintFee).toBe(0);
    expect(preview.totalCost).toBe(5_100);
  });

  it("exposes the pre-fee shares-times-price quote", () => {
    const preview = computeLimitOrderPreview({
      displayShares: 3,
      limitPrice: 500,
      feePercent: 0,
      mintInputFeePpk: 0,
      baseAsset: "sat",
      divisibility: 1_000,
    });
    expect(preview.quoteSubunits).toBe(1_500);
  });

  it("pins share-ticket math for 50 one-sat shares at price 300 with D=1000", () => {
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
      baseAsset: "sat",
      divisibility: 1_000,
    });
    expect(preview.mintFee).toBe(0);
  });

  it("includes a non-zero mint fee when the keyset advertises input_fee_ppk", () => {
    // quote = 10 * 1,000 * 500 / 1,000 = 5,000;
    // mint fee = ceil(5,000 * 100 / 1000) = 500.
    const preview = computeLimitOrderPreview({
      displayShares: 10,
      limitPrice: 500,
      feePercent: 0,
      mintInputFeePpk: 100,
      baseAsset: "sat",
      divisibility: 1_000,
    });
    expect(preview.mintFee).toBe(500);
    expect(preview.totalCost).toBe(5_500);
  });
});

describe("computeTradeCost", () => {
  it("derives the spend from display shares while protocol face stays separate", () => {
    const cost = computeTradeCost({
      displayShares: 10,
      price: 400,
      feePercent: 0,
      mintInputFeePpk: 0,
      baseAsset: "sat",
      divisibility: 1_000,
    });
    expect(cost.quoteSubunits).toBe(4_000);
    expect(cost.totalCost).toBe(4_000);
    expect(cost.totalCost).toBeLessThan(100_000);
  });

  it("computes the creator fee on the QUOTE, not the face amount", () => {
    // Use a price/fee combo where face-vs-quote bases diverge clearly:
    // price 500, fee 10% → quote 5,000, creatorFee 500 (quote basis)
    // vs 1,000 (face basis).
    const cost = computeTradeCost({
      displayShares: 10,
      price: 500,
      feePercent: 10,
      mintInputFeePpk: 0,
      baseAsset: "sat",
      divisibility: 1_000,
    });
    expect(cost.quoteSubunits).toBe(5_000);
    expect(cost.creatorFee).toBe(500); // 10% of quote, not of face
    expect(cost.creatorFee).not.toBe(1_000); // would be the face-basis bug
    expect(cost.totalCost).toBe(5_500);
  });

  it("matches the market worst-case (price 999) buy cost basis", () => {
    const cost = computeTradeCost({
      displayShares: 10,
      price: 999,
      feePercent: 0,
      mintInputFeePpk: 0,
      baseAsset: "sat",
      divisibility: 1_000,
    });
    expect(cost.quoteSubunits).toBe(9_990);
    expect(cost.totalCost).toBe(9_990);
  });

  it("lets the balance gate pass when wallet >= derived cost but < face (price < 100)", () => {
    // Regression for P22 C LOW: the pre-submit gate compares wallet balance
    // against `computeTradeCost(...).totalCost`, NOT the face amount. A wallet
    // holding 4,500 subunits can afford 10 shares @ 40% (cost 4,000).
    const face = displaySharesToFaceSubunits(10, "sat", 1_000);
    const walletBalance = 4_500;
    const requiredSats = computeTradeCost({
      displayShares: 10,
      price: 400,
      feePercent: 0,
      mintInputFeePpk: 0,
      baseAsset: "sat",
      divisibility: 1_000,
    }).totalCost;

    // The gate's actual comparison: `current < requiredSats` => blocked.
    expect(walletBalance < requiredSats).toBe(false); // passes the gate
    // The old face-based gate would have wrongly blocked this affordable trade.
    expect(walletBalance < face).toBe(true);
  });

  it("agrees with computeLimitOrderPreview for the same inputs", () => {
    const cost = computeTradeCost({
      displayShares: 20,
      price: 330,
      feePercent: 1,
      mintInputFeePpk: 0,
      baseAsset: "sat",
      divisibility: 1_000,
    });
    const preview = computeLimitOrderPreview({
      displayShares: 20,
      limitPrice: 330,
      feePercent: 1,
      mintInputFeePpk: 0,
      baseAsset: "sat",
      divisibility: 1_000,
    });
    expect(preview.totalCost).toBe(cost.totalCost);
    expect(preview.creatorFee).toBe(cost.creatorFee);
    expect(preview.mintFee).toBe(cost.mintFee);
  });
});

describe("trade display-unit conversion", () => {
  it("maps display shares to the market divisibility share face", () => {
    expect(displaySharesToFaceSubunits(3, "sat", 1_000)).toBe(3_000);
    expect(faceSubunitsToDisplayShares(3_000, "sat", 1_000)).toBe(3);
  });

  it("uses D=1000 as both price precision and share face", () => {
    const preview = computeLimitOrderPreview({
      displayShares: 2,
      limitPrice: 500,
      feePercent: 0,
      mintInputFeePpk: 0,
      divisibility: 1_000,
      baseAsset: "sat",
    });

    expect(preview.quoteSubunits).toBe(1_000);
    expect(preview.potentialPayout).toBe(2_000);
  });

  it("refuses a price outside the registered divisibility at the preview boundary", () => {
    expect(() =>
      computeLimitOrderPreview({
        displayShares: 1,
        limitPrice: 1_000,
        feePercent: 0,
        mintInputFeePpk: 0,
        baseAsset: "sat",
        divisibility: 1_000,
      }),
    ).toThrow(/priceNumerator must be between 1 and divisibility - 1/);
  });
});

describe("computeMarketOrderQuotePreview", () => {
  it("walks ask depth and returns average execution price for buys", () => {
    const quote = computeMarketOrderQuotePreview({
      displayShares: 3,
      tradeSide: "Buy",
      divisibility: 1_000,
      orderBook: {
        bids: [],
        asks: [
          { price: 400, amount: 1_000, total: 1_000 },
          { price: 500, amount: 2_000, total: 3_000 },
        ],
        spread: 100,
      },
    });

    expect(quote?.executableDisplayShares).toBe(3);
    expect(quote?.quoteSubunits).toBe(1_400);
    expect(quote?.averageExecutionPrice).toBeCloseTo(466.67, 2);
  });

  it("walks bid depth for sells", () => {
    const quote = computeMarketOrderQuotePreview({
      displayShares: 2,
      tradeSide: "Sell",
      divisibility: 1_000,
      orderBook: {
        bids: [{ price: 450, amount: 2_000, total: 2_000 }],
        asks: [],
        spread: 100,
      },
    });

    expect(quote?.executableDisplayShares).toBe(2);
    expect(quote?.quoteSubunits).toBe(900);
    expect(quote?.averageExecutionPrice).toBe(450);
  });

  it("quotes complementary bids for market buys when the direct ask book is empty", () => {
    const quote = computeMarketOrderQuotePreview({
      displayShares: 2,
      tradeSide: "Buy",
      divisibility: 1_000,
      orderBook: { bids: [], asks: [], spread: 0 },
      complementaryOrderBook: {
        bids: [{ price: 420, amount: 2_000, total: 2_000 }],
        asks: [],
        spread: 0,
      },
    });

    expect(quote?.executableDisplayShares).toBe(2);
    expect(quote?.averageExecutionPrice).toBe(580);
    expect(quote?.quoteSubunits).toBe(1_160);
  });

  it("does not treat complementary-book asks as executable market-buy liquidity", () => {
    expect(
      computeMarketOrderQuotePreview({
        displayShares: 1,
        tradeSide: "Buy",
        divisibility: 1_000,
        orderBook: null,
        complementaryOrderBook: {
          bids: [],
          asks: [{ price: 350, amount: 1_000, total: 1_000 }],
          spread: 0,
        },
      }),
    ).toBeNull();
  });

  it("uses complementary bids rather than complementary asks for market buys", () => {
    const quote = computeMarketOrderQuotePreview({
      displayShares: 1,
      tradeSide: "Buy",
      divisibility: 1_000,
      orderBook: null,
      complementaryOrderBook: {
        bids: [{ price: 600, amount: 1_000, total: 1_000 }],
        asks: [{ price: 350, amount: 1_000, total: 1_000 }],
        spread: 250,
      },
    });

    expect(quote?.averageExecutionPrice).toBe(400);
    expect(quote?.quoteSubunits).toBe(400);
  });

  it("uses direct asks before complementary bids for partial market buys", () => {
    const quote = computeMarketOrderQuotePreview({
      displayShares: 3,
      tradeSide: "Buy",
      divisibility: 1_000,
      orderBook: {
        bids: [],
        asks: [{ price: 350, amount: 1_000, total: 1_000 }],
        spread: 0,
      },
      complementaryOrderBook: {
        bids: [{ price: 420, amount: 2_000, total: 2_000 }],
        asks: [],
        spread: 0,
      },
    });

    expect(quote?.executableDisplayShares).toBe(3);
    expect(quote?.quoteSubunits).toBe(1_510);
    expect(quote?.averageExecutionPrice).toBeCloseTo(503.33, 2);
  });

  it("returns null when no executable depth is available", () => {
    expect(
      computeMarketOrderQuotePreview({
        displayShares: 1,
        tradeSide: "Buy",
        divisibility: 1_000,
        orderBook: { bids: [], asks: [], spread: 0 },
      }),
    ).toBeNull();
  });
});
