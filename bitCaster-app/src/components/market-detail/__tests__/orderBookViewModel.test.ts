import { describe, expect, it } from "vitest";
import {
  buildOrderBookDepthRows,
  deriveExecutableOrderBook,
  hasExecutableLiquidity,
} from "../orderBookViewModel";

describe("buildOrderBookDepthRows", () => {
  it("scales row depth by the largest displayed amount across both sides", () => {
    expect(
      buildOrderBookDepthRows(
        [
          { price: 52, amount: 100, total: 1_000 },
          { price: 51, amount: 200, total: 1_200 },
        ],
        "bid",
        [
          { price: 53, amount: 100, total: 2_400 },
          { price: 54, amount: 200, total: 2_000 },
        ],
      ),
    ).toEqual([
      { side: "bid", order: { price: 52, amount: 100, total: 1_000 }, depthPercent: 50 },
      { side: "bid", order: { price: 51, amount: 200, total: 1_200 }, depthPercent: 100 },
    ]);
  });
});

describe("deriveExecutableOrderBook", () => {
  it("can internally derive executable asks from a raw complement bid book", () => {
    const book = deriveExecutableOrderBook({
      completeness: "direct",
      divisibility: 10_000,
      book: {
        bids: [{ price: 4_000, amount: 100, total: 1 }],
        asks: [{ price: 6_500, amount: 200, total: 1 }],
        spread: 0,
      },
      complementBook: {
        bids: [{ price: 3_000, amount: 300, total: 1 }],
        asks: [{ price: 7_500, amount: 400, total: 1 }],
        spread: 0,
      },
    });

    expect(book).toEqual({
      bids: [{ price: 4_000, amount: 100, total: 100 }],
      asks: [
        { price: 6_500, amount: 200, total: 200 },
        { price: 7_000, amount: 300, total: 500 },
      ],
      spread: 2_500,
    });
  });

  it("counts direct asks and transformed complementary bids as BUY liquidity", () => {
    expect(
      hasExecutableLiquidity({
        side: "Buy",
        divisibility: 1_000_000,
        book: { bids: [], asks: [], spread: 0 },
        complementBook: {
          bids: [{ price: 301_000, amount: 100, total: 100 }],
          asks: [],
          spread: 0,
        },
      }),
    ).toBe(true);
    expect(
      hasExecutableLiquidity({
        side: "Buy",
        divisibility: 1_000_000,
        book: {
          bids: [],
          asks: [{ price: 700_000, amount: 100, total: 100 }],
          spread: 0,
        },
      }),
    ).toBe(true);
  });

  it("counts complementary BUY liquidity when the selected direct book is absent", () => {
    expect(
      hasExecutableLiquidity({
        side: "Buy",
        divisibility: 10_000,
        book: null,
        complementBook: {
          bids: [{ price: 3_000, amount: 100, total: 100 }],
          asks: [],
          spread: 0,
        },
      }),
    ).toBe(true);
  });

  it("counts only positive direct bids as SELL liquidity", () => {
    expect(
      hasExecutableLiquidity({
        side: "Sell",
        divisibility: 10_000,
        book: {
          bids: [{ price: 4_000, amount: 100, total: 100 }],
          asks: [],
          spread: 0,
        },
        complementBook: {
          bids: [{ price: 3_000, amount: 100, total: 100 }],
          asks: [],
          spread: 0,
        },
      }),
    ).toBe(true);
    expect(
      hasExecutableLiquidity({
        side: "Sell",
        divisibility: 10_000,
        book: { bids: [], asks: [], spread: 0 },
        complementBook: {
          bids: [{ price: 3_000, amount: 100, total: 100 }],
          asks: [],
          spread: 0,
        },
      }),
    ).toBe(false);
  });

  it("fails closed for invalid divisibility and does not transform with a fallback", () => {
    expect(
      hasExecutableLiquidity({
        side: "Buy",
        divisibility: 12_345,
        book: { bids: [], asks: [], spread: 0 },
        complementBook: {
          bids: [{ price: 3_000, amount: 100, total: 100 }],
          asks: [],
          spread: 0,
        },
      }),
    ).toBe(false);

    expect(
      deriveExecutableOrderBook({
        completeness: "direct",
        divisibility: 12_345,
        book: { bids: [], asks: [], spread: 0 },
        complementBook: {
          bids: [{ price: 3_000, amount: 100, total: 100 }],
          asks: [],
          spread: 0,
        },
      }).asks,
    ).toEqual([]);
  });

  it("fails closed for malformed direct and complementary levels", () => {
    const invalidPrices = [
      0,
      10_000,
      10_001,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ];
    for (const price of invalidPrices) {
      expect(
        hasExecutableLiquidity({
          side: "Buy",
          divisibility: 10_000,
          book: {
            bids: [],
            asks: [{ price, amount: 100, total: 100 }],
            spread: 0,
          },
        }),
      ).toBe(false);
      expect(
        hasExecutableLiquidity({
          side: "Buy",
          divisibility: 10_000,
          book: null,
          complementBook: {
            bids: [{ price, amount: 100, total: 100 }],
            asks: [],
            spread: 0,
          },
        }),
      ).toBe(false);
    }

    const invalidAmounts = [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ];
    for (const amount of invalidAmounts) {
      expect(
        hasExecutableLiquidity({
          side: "Buy",
          divisibility: 10_000,
          book: {
            bids: [],
            asks: [{ price: 5_000, amount, total: amount }],
            spread: 0,
          },
        }),
      ).toBe(false);
      expect(
        hasExecutableLiquidity({
          side: "Buy",
          divisibility: 10_000,
          book: null,
          complementBook: {
            bids: [{ price: 5_000, amount, total: amount }],
            asks: [],
            spread: 0,
          },
        }),
      ).toBe(false);
    }
  });

  it("uses the default D=10000 denominator for complement bids", () => {
    const book = deriveExecutableOrderBook({
      completeness: "direct",
      divisibility: 10_000,
      book: {
        bids: [{ price: 4_000, amount: 100, total: 1 }],
        asks: [],
        spread: 0,
      },
      complementBook: {
        bids: [{ price: 3_000, amount: 300, total: 1 }],
        asks: [],
        spread: 0,
      },
    });

    expect(book.asks).toEqual([{ price: 7_000, amount: 300, total: 300 }]);
  });

  it("does not duplicate complement levels when the incoming book is already executable", () => {
    const book = deriveExecutableOrderBook({
      completeness: "executable",
      divisibility: 10_000,
      book: {
        bids: [{ price: 4_000, amount: 100, total: 1 }],
        asks: [{ price: 7_000, amount: 300, total: 1 }],
        spread: 0,
      },
      complementBook: {
        bids: [{ price: 3_000, amount: 300, total: 1 }],
        asks: [],
        spread: 0,
      },
    });

    expect(book).toEqual({
      bids: [{ price: 4_000, amount: 100, total: 100 }],
      asks: [{ price: 7_000, amount: 300, total: 300 }],
      spread: 3_000,
    });
  });

  it("uses server depthLimit to merge then truncate stable top-N rows", () => {
    const book = deriveExecutableOrderBook({
      completeness: "direct",
      divisibility: 10_000,
      book: {
        depthLimit: 2,
        bids: [
          { price: 4_000, amount: 100, total: 1 },
          { price: 4_500, amount: 200, total: 1 },
          { price: 4_500, amount: 300, total: 1 },
          { price: 3_000, amount: 400, total: 1 },
        ],
        asks: [
          { price: 6_500, amount: 100, total: 1 },
          { price: 8_000, amount: 100, total: 1 },
        ],
        spread: 0,
      },
      complementBook: {
        bids: [
          { price: 3_500, amount: 250, total: 1 },
          { price: 1_000, amount: 500, total: 1 },
        ],
        asks: [],
        spread: 0,
      },
    });

    expect(book.depthLimit).toBe(2);
    expect(book.bids).toEqual([
      { price: 4_500, amount: 500, total: 500 },
      { price: 4_000, amount: 100, total: 600 },
    ]);
    expect(book.asks).toEqual([
      { price: 6_500, amount: 350, total: 350 },
      { price: 8_000, amount: 100, total: 450 },
    ]);
    expect(book.spread).toBe(2_000);
  });
});
