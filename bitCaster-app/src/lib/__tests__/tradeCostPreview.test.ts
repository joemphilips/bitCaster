import { describe, expect, it } from "vitest";
import {
  computeLimitOrderPreview,
  computeTradeCost,
} from "@/lib/tradeCostPreview";

describe("computeLimitOrderPreview", () => {
  it("derives a reactive total cost from shares × price (not a static face echo)", () => {
    // 1000 shares (face) @ price 40, no creator fee, no mint fee.
    // quote = 1000 * 40 / 100 = 400 sats.
    const preview = computeLimitOrderPreview({
      shares: 1000,
      limitPrice: 40,
      feePercent: 0,
      mintInputFeePpk: 0,
    });
    expect(preview.amount).toBe(1000); // face/share count preserved
    expect(preview.totalCost).toBe(400);
    // The total cost must NOT equal the face amount — that was the static bug.
    expect(preview.totalCost).not.toBe(preview.amount);
  });

  it("reacts to the limit price", () => {
    const cheap = computeLimitOrderPreview({
      shares: 1000,
      limitPrice: 10,
      feePercent: 0,
      mintInputFeePpk: 0,
    });
    const pricey = computeLimitOrderPreview({
      shares: 1000,
      limitPrice: 90,
      feePercent: 0,
      mintInputFeePpk: 0,
    });
    expect(cheap.totalCost).toBe(100);
    expect(pricey.totalCost).toBe(900);
    expect(pricey.totalCost).toBeGreaterThan(cheap.totalCost);
  });

  it("adds the creator fee on top of the quote", () => {
    // quote = 1000 * 50 / 100 = 500; creator fee 2% of 500 = 10.
    const preview = computeLimitOrderPreview({
      shares: 1000,
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
      shares: 300,
      limitPrice: 50,
      feePercent: 0,
      mintInputFeePpk: 0,
    });
    expect(preview.quoteSats).toBe(150);
  });

  it("collapses the mint fee to 0 for the first-release zero-fee mint", () => {
    const preview = computeLimitOrderPreview({
      shares: 5000,
      limitPrice: 33,
      feePercent: 1,
      mintInputFeePpk: 0,
    });
    expect(preview.mintFee).toBe(0);
  });

  it("includes a non-zero mint fee when the keyset advertises input_fee_ppk", () => {
    // quote = 1000 * 50 / 100 = 500; mint fee = ceil(500 * 100 / 1000) = 50.
    const preview = computeLimitOrderPreview({
      shares: 1000,
      limitPrice: 50,
      feePercent: 0,
      mintInputFeePpk: 100,
    });
    expect(preview.mintFee).toBe(50);
    expect(preview.totalCost).toBe(550);
  });
});

describe("computeTradeCost", () => {
  it("derives the spend (and balance-gate basis) strictly below face for price < 100", () => {
    // The P22 C LOW regression: gating on face (tradeAmount) over-requires.
    // 1000 face @ price 40 → quote 400; total cost 400 < 1000 face.
    const cost = computeTradeCost({
      shares: 1000,
      price: 40,
      feePercent: 0,
      mintInputFeePpk: 0,
    });
    expect(cost.quoteSats).toBe(400);
    expect(cost.totalCost).toBe(400);
    expect(cost.totalCost).toBeLessThan(1000);
  });

  it("computes the creator fee on the QUOTE, not the face amount", () => {
    // Market buy worst-case price 99 → quote = 1000 * 99 / 100 = 990.
    // Creator fee 2% must be 2% of 990 (=20, rounded), NOT 2% of 1000 face (=20).
    // Use a price/fee combo where face-vs-quote bases diverge clearly:
    // price 50, fee 10% → quote 500, creatorFee 50 (quote basis) vs 100 (face basis).
    const cost = computeTradeCost({
      shares: 1000,
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
      shares: 1000,
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
    // holding 450 sats can afford 1000 face @ price 40 (cost 400) even though
    // the balance is below the 1000 face count.
    const face = 1000;
    const walletBalance = 450;
    const requiredSats = computeTradeCost({
      shares: face,
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
      shares: 2000,
      price: 33,
      feePercent: 1,
      mintInputFeePpk: 0,
    });
    const preview = computeLimitOrderPreview({
      shares: 2000,
      limitPrice: 33,
      feePercent: 1,
      mintInputFeePpk: 0,
    });
    expect(preview.totalCost).toBe(cost.totalCost);
    expect(preview.creatorFee).toBe(cost.creatorFee);
    expect(preview.mintFee).toBe(cost.mintFee);
  });
});
