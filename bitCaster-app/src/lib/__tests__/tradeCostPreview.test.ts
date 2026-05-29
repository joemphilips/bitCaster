import { describe, expect, it } from "vitest";
import { computeLimitOrderPreview } from "@/lib/tradeCostPreview";

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
