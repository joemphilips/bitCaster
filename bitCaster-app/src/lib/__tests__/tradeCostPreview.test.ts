import { describe, expect, it } from "vitest";
import {
  computeLimitOrderPreview,
  computeTradeCost,
  displaySharesToFaceSats,
  faceSatsToDisplayShares,
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
    // quote = 10 display shares * 50 = 500; creator fee 2% of 500 = 10.
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
    expect(preview.quoteSats).toBe(150);
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
    // quote = 10 * 50 = 500; mint fee = ceil(500 * 100 / 1000) = 50.
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
    expect(cost.quoteSats).toBe(400);
    expect(cost.totalCost).toBe(400);
    expect(cost.totalCost).toBeLessThan(1000);
  });

  it("computes the creator fee on the QUOTE, not the face amount", () => {
    // Use a price/fee combo where face-vs-quote bases diverge clearly:
    // price 50, fee 10% → quote 500, creatorFee 50 (quote basis) vs 100 (face basis).
    const cost = computeTradeCost({
      displayShares: 10,
      price: 50,
      feePercent: 10,
      mintInputFeePpk: 0,
    });
    expect(cost.quoteSats).toBe(500);
    expect(cost.creatorFee).toBe(50); // 10% of quote 500, not of face 1000
    expect(cost.creatorFee).not.toBe(100); // would be the face-basis bug
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
    expect(cost.quoteSats).toBe(990);
    expect(cost.totalCost).toBe(990);
  });

  it("lets the balance gate pass when wallet >= derived cost but < face (price < 100)", () => {
    // Regression for P22 C LOW: the pre-submit gate compares wallet balance
    // against `computeTradeCost(...).totalCost`, NOT the face amount. A wallet
    // holding 450 sats can afford 10 shares (1000 face) @ price 40 (cost 400).
    const face = displaySharesToFaceSats(10);
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
  it("maps one display share to one 100-sat protocol face lot", () => {
    expect(displaySharesToFaceSats(3)).toBe(300);
    expect(faceSatsToDisplayShares(300)).toBe(3);
  });
});
