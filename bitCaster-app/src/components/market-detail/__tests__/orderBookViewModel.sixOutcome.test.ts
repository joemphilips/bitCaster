import { describe, expect, it } from "vitest";
import { buildOrderBookDepthRows, deriveExecutableOrderBook } from "../orderBookViewModel";

describe("six-outcome review depth", () => {
  it("preserves captured asymmetric quantities, exact totals, and a common bar maximum", () => {
    // Captured A route after trading. This does not reconstruct historical q or custody.
    const bids = [79, 74, 77, 79, 81].map((amount, index) => ({
      price: 250 - index * 10,
      amount,
      total: 0,
    }));
    const asks = [63, 70, 67, 67, 65].map((amount, index) => ({
      price: 280 + index * 10,
      amount,
      total: 0,
    }));
    const book = deriveExecutableOrderBook({
      completeness: "direct",
      divisibility: 1_000,
      book: { bids, asks, spread: 30 },
    });
    expect(book.bids.map((level) => level.total)).toEqual([79, 153, 230, 309, 390]);
    expect(book.asks.map((level) => level.total)).toEqual([63, 133, 200, 267, 332]);
    const bidRows = buildOrderBookDepthRows(book.bids, "bid", book.asks);
    const askRows = buildOrderBookDepthRows(book.asks, "ask", book.bids);
    expect(bidRows.map((row) => row.depthPercent)).toEqual([98, 91, 95, 98, 100]);
    expect(askRows.map((row) => row.depthPercent)).toEqual([78, 86, 83, 83, 80]);
  });
});
