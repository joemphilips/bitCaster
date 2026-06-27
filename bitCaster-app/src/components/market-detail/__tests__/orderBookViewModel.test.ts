import { describe, expect, it } from "vitest";
import { buildOrderBookDepthRows, deriveExecutableOrderBook } from "../orderBookViewModel";

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
      divisibility: 100,
      book: {
        bids: [{ price: 40, amount: 100, total: 1 }],
        asks: [{ price: 65, amount: 200, total: 1 }],
        spread: 0,
      },
      complementBook: {
        bids: [{ price: 30, amount: 300, total: 1 }],
        asks: [{ price: 75, amount: 400, total: 1 }],
        spread: 0,
      },
    });

    expect(book).toEqual({
      bids: [{ price: 40, amount: 100, total: 100 }],
      asks: [
        { price: 65, amount: 200, total: 200 },
        { price: 70, amount: 300, total: 500 },
      ],
      spread: 25,
    });
  });

  it("uses the default D=10000 denominator for complement bids", () => {
    const book = deriveExecutableOrderBook({
      completeness: "direct",
      book: {
        bids: [{ price: 400, amount: 100, total: 1 }],
        asks: [],
        spread: 0,
      },
      complementBook: {
        bids: [{ price: 300, amount: 300, total: 1 }],
        asks: [],
        spread: 0,
      },
    });

    expect(book.asks).toEqual([{ price: 9700, amount: 300, total: 300 }]);
  });

  it("does not duplicate complement levels when the incoming book is already executable", () => {
    const book = deriveExecutableOrderBook({
      completeness: "executable",
      divisibility: 100,
      book: {
        bids: [{ price: 40, amount: 100, total: 1 }],
        asks: [{ price: 70, amount: 300, total: 1 }],
        spread: 0,
      },
      complementBook: {
        bids: [{ price: 30, amount: 300, total: 1 }],
        asks: [],
        spread: 0,
      },
    });

    expect(book).toEqual({
      bids: [{ price: 40, amount: 100, total: 100 }],
      asks: [{ price: 70, amount: 300, total: 300 }],
      spread: 30,
    });
  });

  it("uses server depthLimit to merge then truncate stable top-N rows", () => {
    const book = deriveExecutableOrderBook({
      completeness: "direct",
      divisibility: 100,
      book: {
        depthLimit: 2,
        bids: [
          { price: 40, amount: 100, total: 1 },
          { price: 45, amount: 200, total: 1 },
          { price: 45, amount: 300, total: 1 },
          { price: 30, amount: 400, total: 1 },
        ],
        asks: [
          { price: 65, amount: 100, total: 1 },
          { price: 80, amount: 100, total: 1 },
        ],
        spread: 0,
      },
      complementBook: {
        bids: [
          { price: 35, amount: 250, total: 1 },
          { price: 10, amount: 500, total: 1 },
        ],
        asks: [],
        spread: 0,
      },
    });

    expect(book.depthLimit).toBe(2);
    expect(book.bids).toEqual([
      { price: 45, amount: 500, total: 500 },
      { price: 40, amount: 100, total: 600 },
    ]);
    expect(book.asks).toEqual([
      { price: 65, amount: 350, total: 350 },
      { price: 80, amount: 100, total: 450 },
    ]);
    expect(book.spread).toBe(20);
  });
});
