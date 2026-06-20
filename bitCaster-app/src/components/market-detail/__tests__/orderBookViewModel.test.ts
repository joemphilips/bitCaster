import { describe, expect, it } from "vitest";
import { deriveExecutableOrderBook } from "../orderBookViewModel";

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
});
