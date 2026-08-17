import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RelatedMarkets } from "../RelatedMarkets";
import type { RelatedMarket } from "@/types/market-detail";

function makeRelatedMarket(overrides: Partial<RelatedMarket> = {}): RelatedMarket {
  return {
    id: "related-1",
    title: "Related market",
    currentOdds: { yes: null, no: null },
    volume: 0,
    baseAsset: "sat",
    closingDate: "2030-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("RelatedMarkets", () => {
  it("labels null compact prices as no trades", () => {
    render(<RelatedMarkets markets={[makeRelatedMarket()]} />);

    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.getAllByLabelText("market.noTrades")).toHaveLength(2);
  });

  it("uses the exact one-million denominator and never defaults missing divisibility", () => {
    const { rerender } = render(
      <RelatedMarkets
        markets={[makeRelatedMarket({ currentOdds: { yes: 250_000, no: 750_000 }, divisibility: 1_000_000 })]}
      />,
    );

    expect(screen.getByText(/25\.00%/)).toBeInTheDocument();
    expect(screen.getByText(/75\.00%/)).toBeInTheDocument();
    expect(screen.queryByText("2500.00%")).not.toBeInTheDocument();

    rerender(
      <RelatedMarkets
        markets={[makeRelatedMarket({ currentOdds: { yes: 2_500, no: 7_500 } })]}
      />,
    );
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.getAllByLabelText("market.priceUnavailable")).toHaveLength(2);
  });
});
