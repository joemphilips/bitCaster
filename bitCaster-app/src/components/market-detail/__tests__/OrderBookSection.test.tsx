import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OrderBookSection } from "../OrderBookSection";

describe("OrderBookSection", () => {
  it("formats amounts as shares and price numerators with the market divisibility", () => {
    render(
      <OrderBookSection
        baseAsset="sat"
        divisibility={1_000}
        title="Alpha"
        outcome={{ label: "Alpha", color: "#334455" }}
        orderBook={{
          bids: [{ price: 50, amount: 1_000, total: 1_000 }],
          asks: [{ price: 60, amount: 2_000, total: 2_000 }],
          spread: 10,
        }}
      />,
    );

    expect(screen.getByText("1%")).toBeInTheDocument();
    expect(screen.getByText("5.0%")).toBeInTheDocument();
    expect(screen.getByText("6.0%")).toBeInTheDocument();
    expect(screen.getByText("1 share")).toBeInTheDocument();
    expect(screen.getByText("2 shares")).toBeInTheDocument();
    expect(screen.queryByText(/sats/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Alpha" })).toBeInTheDocument();
    expect(screen.getByTestId("outcome-color-swatch")).toHaveStyle({
      backgroundColor: "#334455",
    });
  });

  it("renders only available levels without placeholder rows", () => {
    render(
      <OrderBookSection
        baseAsset="sat"
        divisibility={1_000}
        orderBook={{
          depthLimit: 3,
          bids: [
            { price: 900, amount: 1_000, total: 1_000 },
            { price: 800, amount: 1_000, total: 2_000 },
            { price: 700, amount: 1_000, total: 3_000 },
            { price: 600, amount: 1_000, total: 4_000 },
          ],
          asks: [
            { price: 910, amount: 1_000, total: 1_000 },
            { price: 920, amount: 1_000, total: 2_000 },
            { price: 930, amount: 1_000, total: 3_000 },
            { price: 940, amount: 1_000, total: 4_000 },
          ],
          spread: 10,
        }}
      />,
    );

    expect(screen.getAllByTestId("order-book-bid-row")).toHaveLength(4);
    expect(screen.getAllByTestId("order-book-ask-row")).toHaveLength(4);
    expect(screen.getByText("90.0%")).toBeInTheDocument();
    expect(screen.getByText("93.0%")).toBeInTheDocument();
    expect(screen.getByText("60.0%")).toBeInTheDocument();
    expect(screen.getByText("94.0%")).toBeInTheDocument();
    expect(screen.queryAllByTestId("order-book-bid-placeholder")).toHaveLength(0);
    expect(screen.queryAllByTestId("order-book-ask-placeholder")).toHaveLength(0);
  });

  it("renders asks and bids in descending price order with closest prices around the spread", () => {
    render(
      <OrderBookSection
        baseAsset="sat"
        divisibility={1_000}
        orderBook={{
          bids: [
            { price: 700, amount: 1_000, total: 1_000 },
            { price: 900, amount: 1_000, total: 2_000 },
            { price: 800, amount: 1_000, total: 3_000 },
          ],
          asks: [
            { price: 950, amount: 1_000, total: 1_000 },
            { price: 910, amount: 1_000, total: 2_000 },
            { price: 930, amount: 1_000, total: 3_000 },
          ],
          spread: 10,
        }}
      />,
    );

    const bidRows = screen.getAllByTestId("order-book-bid-row");
    expect(bidRows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("90.0%"),
      expect.stringContaining("80.0%"),
      expect.stringContaining("70.0%"),
    ]);

    const askRows = screen.getAllByTestId("order-book-ask-row");
    expect(askRows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("95.0%"),
      expect.stringContaining("93.0%"),
      expect.stringContaining("91.0%"),
    ]);

    const spreadRow = screen.getByTestId("order-book-spread-row");
    expect(
      askRows[2].compareDocumentPosition(spreadRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      spreadRow.compareDocumentPosition(bidRows[0]) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders ask rows above the spread and bid rows below it in DOM order", () => {
    render(
      <OrderBookSection
        baseAsset="sat"
        divisibility={1_000}
        orderBook={{
          bids: [{ price: 450, amount: 1_000, total: 1_000 }],
          asks: [{ price: 550, amount: 1_000, total: 1_000 }],
          spread: 100,
        }}
      />,
    );

    const askRow = screen.getByTestId("order-book-ask-row");
    const spreadRow = screen.getByTestId("order-book-spread-row");
    const bidRow = screen.getByTestId("order-book-bid-row");

    expect(
      askRow.compareDocumentPosition(spreadRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      spreadRow.compareDocumentPosition(bidRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("combines price, share amount, and amount-proportional depth into each compact row", () => {
    render(
      <OrderBookSection
        baseAsset="sat"
        divisibility={1_000}
        orderBook={{
          depthLimit: 2,
          bids: [
            { price: 520, amount: 1_000, total: 1_000 },
            { price: 510, amount: 1_000, total: 2_000 },
          ],
          asks: [
            { price: 530, amount: 1_000, total: 1_000 },
            { price: 540, amount: 2_000, total: 3_000 },
          ],
          spread: 100,
        }}
      />,
    );

    const bidRows = screen.getAllByTestId("order-book-bid-row");
    const askRows = screen.getAllByTestId("order-book-ask-row");

    expect(bidRows[0]).toHaveAttribute("data-depth-percent", "50");
    expect(bidRows[0]).toHaveAttribute("data-depth-side", "bid");
    expect(bidRows[0]).toHaveTextContent("52.0%");
    expect(bidRows[0]).toHaveTextContent("1 share");
    expect(screen.getAllByTestId("order-book-bid-depth-fill")[0]).toHaveStyle({ width: "50%" });
    expect(screen.getAllByTestId("order-book-bid-depth-fill")[0]).toHaveClass("left-0");
    expect(screen.getAllByTestId("order-book-bid-depth-fill")[0]).not.toHaveClass("right-0");

    expect(askRows[0]).toHaveAttribute("data-depth-percent", "100");
    expect(askRows[0]).toHaveAttribute("data-depth-side", "ask");
    expect(askRows[0]).toHaveTextContent("54.0%");
    expect(askRows[0]).toHaveTextContent("2 shares");
    expect(
      screen.getAllByTestId("order-book-total-shares").map((cell) => cell.textContent),
    ).toEqual(["3", "1", "1", "2"]);
    expect(screen.getAllByTestId("order-book-ask-depth-fill")[0]).toHaveStyle({ width: "100%" });
    expect(screen.getAllByTestId("order-book-ask-depth-fill")[0]).toHaveClass("left-0");
  });

  it.each([
    [
      "two-sided executable",
      {
        bids: [{ price: 50, amount: 1_000, total: 1_000 }],
        asks: [{ price: 60, amount: 1_000, total: 1_000 }],
        spread: 10,
      },
      "1%",
    ],
    [
      "one-tick spread",
      {
        bids: [{ price: 50, amount: 1_000, total: 1_000 }],
        asks: [{ price: 51, amount: 1_000, total: 1_000 }],
        spread: 1,
      },
      "0.1%",
    ],
    [
      "one-sided",
      {
        bids: [{ price: 50, amount: 1_000, total: 1_000 }],
        asks: [],
        spread: 0,
      },
      null,
    ],
    ["empty", { bids: [], asks: [], spread: 0 }, null],
    [
      "invalid price",
      {
        bids: [{ price: 1_000, amount: 1_000, total: 1_000 }],
        asks: [{ price: 600, amount: 1_000, total: 1_000 }],
        spread: 0,
      },
      null,
    ],
    [
      "crossed",
      {
        bids: [{ price: 600, amount: 1_000, total: 1_000 }],
        asks: [{ price: 500, amount: 1_000, total: 1_000 }],
        spread: 0,
      },
      null,
    ],
  ] as const)("shows an honest spread for a %s book", (_case, book, expected) => {
    render(
      <OrderBookSection
        baseAsset="sat"
        divisibility={1_000}
        orderBook={{
          ...book,
          bids: book.bids.map((order) => ({ ...order })),
          asks: book.asks.map((order) => ({ ...order })),
        }}
      />,
    );

    expect(screen.queryByTestId("order-book-midpoint")).not.toBeInTheDocument();
    expect(screen.getByTestId("order-book-spread-row")).toHaveTextContent(
      expected ?? "Unavailable",
    );
  });

  it("uses the selected categorical route book for its spread", () => {
    render(
      <OrderBookSection
        baseAsset="sat"
        divisibility={1_000}
        orderBook={{ bids: [], asks: [], spread: 0 }}
        selectedOutcomeId="Alpha"
        outcomeOrderBooks={{
          Alpha: {
            bids: [{ price: 200, amount: 1_000, total: 1_000 }],
            asks: [{ price: 400, amount: 1_000, total: 1_000 }],
            spread: 200,
          },
          Beta: {
            bids: [{ price: 700, amount: 1_000, total: 1_000 }],
            asks: [{ price: 900, amount: 1_000, total: 1_000 }],
            spread: 200,
          },
        }}
      />,
    );

    expect(screen.getByTestId("order-book-spread-row")).toHaveTextContent("20%");
  });

  it("does not show another route's depth or spread for a missing categorical route", () => {
    render(
      <OrderBookSection
        baseAsset="sat"
        divisibility={1_000}
        orderBook={{
          bids: [{ price: 200, amount: 1_000, total: 1_000 }],
          asks: [{ price: 400, amount: 1_000, total: 1_000 }],
          spread: 200,
        }}
        selectedOutcomeId="Missing"
        outcomeOrderBooks={{}}
      />,
    );

    expect(screen.getByTestId("order-book-spread-row")).toHaveTextContent("Unavailable");
    expect(screen.queryAllByTestId("order-book-bid-row")).toHaveLength(0);
    expect(screen.queryAllByTestId("order-book-ask-row")).toHaveLength(0);
  });

  it("uses both sides of the selected binary book for spread", () => {
    render(
      <OrderBookSection
        baseAsset="sat"
        divisibility={1_000}
        orderBook={{ bids: [], asks: [], spread: 0 }}
        selectedOutcomeId="Yes"
        outcomeOrderBooks={{
          Yes: {
            bids: [{ price: 400, amount: 1_000, total: 1_000 }],
            asks: [{ price: 700, amount: 1_000, total: 1_000 }],
            spread: 300,
          },
          No: {
            bids: [{ price: 300, amount: 1_000, total: 1_000 }],
            asks: [],
            spread: 0,
          },
        }}
      />,
    );

    expect(screen.getByTestId("order-book-spread-row")).toHaveTextContent("30%");
  });

  it("bounds each side to ten nearest levels and reflects updated depth", () => {
    const book = {
      bids: Array.from({ length: 12 }, (_, i) => ({
        price: 490 - i * 10,
        amount: 1_000,
        total: (i + 1) * 1_000,
      })),
      asks: Array.from({ length: 12 }, (_, i) => ({
        price: 510 + i * 10,
        amount: 1_000,
        total: (i + 1) * 1_000,
      })),
      spread: 20,
    };
    const { rerender } = render(
      <OrderBookSection baseAsset="sat" divisibility={1_000} orderBook={book} />,
    );
    expect(screen.getAllByTestId("order-book-bid-row")).toHaveLength(10);
    expect(screen.getAllByTestId("order-book-ask-row")).toHaveLength(10);
    expect(screen.getAllByTestId("order-book-bid-row").at(-1)).toHaveTextContent("40.0%");
    expect(screen.getAllByTestId("order-book-ask-row")[0]).toHaveTextContent("60.0%");
    expect(screen.queryByText("39.0%")).not.toBeInTheDocument();
    expect(screen.queryByText("61.0%")).not.toBeInTheDocument();
    rerender(
      <OrderBookSection
        baseAsset="sat"
        divisibility={1_000}
        orderBook={{ ...book, bids: [], asks: [] }}
      />,
    );
    expect(screen.queryAllByTestId("order-book-bid-row")).toHaveLength(0);
    expect(screen.queryAllByTestId("order-book-ask-row")).toHaveLength(0);
    expect(screen.getByTestId("order-book-spread-row")).toHaveTextContent("Unavailable");
  });
});
