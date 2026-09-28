import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { RelatedMarkets } from "../RelatedMarkets";
import type { RelatedMarket } from "@/types/market-detail";

function makeRelatedMarket(overrides: Partial<RelatedMarket> = {}): RelatedMarket {
  return {
    id: "related-1",
    title: "Related market",
    currentOdds: { yes: null, no: null },
    latestConfirmedTrades: [],
    latestConfirmedTradesValid: true,
    volume: 0,
    baseAsset: "sat",
    closingDate: "2030-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("RelatedMarkets", () => {
  it("explains volume without navigating, while the market action still navigates", async () => {
    const user = userEvent.setup();
    const onMarketClick = vi.fn();
    render(<RelatedMarkets markets={[makeRelatedMarket()]} onMarketClick={onMarketClick} />);
    await user.click(screen.getByRole("button", { name: /Volume/ }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Total traded volume so far");
    expect(onMarketClick).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Related market/ }));
    expect(onMarketClick).toHaveBeenCalledWith("related-1");
  });

  it("labels null compact prices as no trades", () => {
    render(<RelatedMarkets markets={[makeRelatedMarket()]} />);

    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.getAllByLabelText("No trades yet")).toHaveLength(2);
  });

  it("labels null compact prices as unavailable when authority is missing", () => {
    render(
      <RelatedMarkets
        markets={[
          makeRelatedMarket({
            currentOdds: { yes: 2_500, no: 7_500 },
            latestConfirmedTradesValid: false,
          }),
        ]}
      />,
    );

    expect(screen.getAllByLabelText("market.priceUnavailable")).toHaveLength(2);
    expect(screen.queryAllByLabelText("No trades yet")).toHaveLength(0);
  });

  it("uses the exact one-million denominator and never defaults missing divisibility", () => {
    const { rerender } = render(
      <RelatedMarkets
        markets={[
          makeRelatedMarket({
            currentOdds: { yes: 250_000, no: 750_000 },
            divisibility: 1_000_000,
          }),
        ]}
      />,
    );

    expect(screen.getByText(/25\.0000%/)).toBeInTheDocument();
    expect(screen.getByText(/75\.0000%/)).toBeInTheDocument();
    expect(screen.queryByText("2500.0000%")).not.toBeInTheDocument();

    rerender(
      <RelatedMarkets markets={[makeRelatedMarket({ currentOdds: { yes: 2_500, no: 7_500 } })]} />,
    );
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.getAllByLabelText("market.priceUnavailable")).toHaveLength(2);
  });
});
