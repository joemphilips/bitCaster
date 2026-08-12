import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OrderBookSection } from "../OrderBookSection";

describe("OrderBookSection", () => {
  it("formats amounts as shares and price numerators with the market divisibility", () => {
    render(
      <OrderBookSection
        baseAsset="sat"
        divisibility={10_000}
        orderBook={{
          bids: [{ price: 500, amount: 1_000, total: 1_000 }],
          asks: [{ price: 600, amount: 2_000, total: 2_000 }],
          spread: 100,
        }}
      />,
    );

    expect(screen.getByText("1.00%")).toBeInTheDocument();
    expect(screen.getByText("5.00%")).toBeInTheDocument();
    expect(screen.getByText("6.00%")).toBeInTheDocument();
    expect(screen.getByText("0.1 shares")).toBeInTheDocument();
    expect(screen.getByText("0.2 shares")).toBeInTheDocument();
    expect(screen.queryByText(/sats/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  });

  it("renders the fixed five-row display depth while preserving stable bounded sides", () => {
    render(
      <OrderBookSection
        baseAsset="sat"
        divisibility={10_000}
        orderBook={{
          depthLimit: 3,
          bids: [
            { price: 9_000, amount: 100, total: 100 },
            { price: 8_000, amount: 100, total: 200 },
            { price: 7_000, amount: 100, total: 300 },
            { price: 6_000, amount: 100, total: 400 },
          ],
          asks: [
            { price: 9_100, amount: 100, total: 100 },
            { price: 9_200, amount: 100, total: 200 },
            { price: 9_300, amount: 100, total: 300 },
            { price: 9_400, amount: 100, total: 400 },
          ],
          spread: 100,
        }}
      />,
    );

    expect(screen.getAllByTestId("order-book-bid-row")).toHaveLength(4);
    expect(screen.getAllByTestId("order-book-ask-row")).toHaveLength(4);
    expect(screen.getByText("90.00%")).toBeInTheDocument();
    expect(screen.getByText("93.00%")).toBeInTheDocument();
    expect(screen.getByText("60.00%")).toBeInTheDocument();
    expect(screen.getByText("94.00%")).toBeInTheDocument();
    expect(screen.queryAllByTestId("order-book-bid-placeholder")).toHaveLength(1);
    expect(screen.queryAllByTestId("order-book-ask-placeholder")).toHaveLength(1);
  });

  it("renders asks and bids in descending price order with closest prices around the spread", () => {
    render(
      <OrderBookSection
        baseAsset="sat"
        divisibility={10_000}
        orderBook={{
          bids: [
            { price: 7_000, amount: 100, total: 100 },
            { price: 9_000, amount: 100, total: 200 },
            { price: 8_000, amount: 100, total: 300 },
          ],
          asks: [
            { price: 9_500, amount: 100, total: 100 },
            { price: 9_100, amount: 100, total: 200 },
            { price: 9_300, amount: 100, total: 300 },
          ],
          spread: 100,
        }}
      />,
    );

    const bidRows = screen.getAllByTestId("order-book-bid-row");
    expect(bidRows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("90.00%"),
      expect.stringContaining("80.00%"),
      expect.stringContaining("70.00%"),
    ]);

    const askRows = screen.getAllByTestId("order-book-ask-row");
    expect(askRows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("95.00%"),
      expect.stringContaining("93.00%"),
      expect.stringContaining("91.00%"),
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
        divisibility={10_000}
        orderBook={{
          bids: [{ price: 4_500, amount: 100, total: 100 }],
          asks: [{ price: 5_500, amount: 100, total: 100 }],
          spread: 1_000,
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
        divisibility={10_000}
        orderBook={{
          depthLimit: 2,
          bids: [
            { price: 5_200, amount: 10_000, total: 10_000 },
            { price: 5_100, amount: 20_000, total: 30_000 },
          ],
          asks: [
            { price: 5_300, amount: 3_000, total: 3_000 },
            { price: 5_400, amount: 6_000, total: 9_000 },
          ],
          spread: 100,
        }}
      />,
    );

    const bidRows = screen.getAllByTestId("order-book-bid-row");
    const askRows = screen.getAllByTestId("order-book-ask-row");

    expect(bidRows[0]).toHaveAttribute("data-depth-percent", "50");
    expect(bidRows[0]).toHaveAttribute("data-depth-side", "bid");
    expect(bidRows[0]).toHaveTextContent("52.00%");
    expect(bidRows[0]).toHaveTextContent("1 share");
    expect(screen.getAllByTestId("order-book-bid-depth-fill")[0]).toHaveStyle({ width: "50%" });
    expect(screen.getAllByTestId("order-book-bid-depth-fill")[0]).toHaveClass("left-0");
    expect(screen.getAllByTestId("order-book-bid-depth-fill")[0]).not.toHaveClass("right-0");

    expect(askRows[0]).toHaveAttribute("data-depth-percent", "30");
    expect(askRows[0]).toHaveAttribute("data-depth-side", "ask");
    expect(askRows[0]).toHaveTextContent("54.00%");
    expect(askRows[0]).toHaveTextContent("0.6 shares");
    expect(screen.getAllByTestId("order-book-ask-depth-fill")[0]).toHaveStyle({ width: "30%" });
    expect(screen.getAllByTestId("order-book-ask-depth-fill")[0]).toHaveClass("left-0");
  });
});
