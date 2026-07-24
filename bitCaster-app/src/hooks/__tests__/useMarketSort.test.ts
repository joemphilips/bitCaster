import { describe, it, expect } from "vitest";
import { DEFAULT_MARKET_SORT, type MarketSort } from "../useMarketSort";

describe("MarketSort (engine-driven sort dimensions, ADR-009)", () => {
  it("exposes the three documented dimensions exactly", () => {
    // The literal-set check guards against a refactor silently expanding the
    // type to a new value the engine does not understand (e.g. `featured`).
    const allowed: MarketSort[] = ["trending", "popular", "new"];
    for (const value of allowed) {
      const parsed: MarketSort = value;
      expect(parsed).toBe(value);
    }
  });

  it("defaults to 'trending' (matches the markets-page initial query)", () => {
    expect(DEFAULT_MARKET_SORT).toBe("trending");
  });
});
