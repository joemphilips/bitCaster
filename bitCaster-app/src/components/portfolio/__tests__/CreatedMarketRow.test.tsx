import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { CreatedMarketRow } from "../CreatedMarketRow";
import type { CreatedMarket } from "@/types/portfolio";

function fixture(overrides: Partial<CreatedMarket> = {}): CreatedMarket {
  return {
    id: "m1",
    title: "Will BTC hit 100K?",
    imageUrl: "https://example.test/thumb.png",
    status: "active",
    volume: 0,
    creatorFeesEarned: 0,
    creatorFeePercent: 0,
    ...overrides,
  } as CreatedMarket;
}

describe("CreatedMarketRow", () => {
  it("hides the fee row when creatorFeePercent is 0 (P7 §/creator regression)", () => {
    render(<CreatedMarketRow market={fixture({ creatorFeePercent: 0 })} />);
    // The pre-fix UI rendered "0% fee" or "0.02% fee" — both must be absent.
    expect(screen.queryByText(/% fee/i)).toBeNull();
  });

  it("renders the fee row when creatorFeePercent > 0 (future engine fee model)", () => {
    render(<CreatedMarketRow market={fixture({ creatorFeePercent: 1.5 })} />);
    expect(screen.getByText(/1\.5% fee/i)).toBeInTheDocument();
  });

  it("shows a working close-market control inline before the view button", async () => {
    const onPublishOracleAttestation = vi.fn();
    render(
      <CreatedMarketRow
        market={fixture({
          oracle: {
            type: "self",
            eventId: "event-1",
            outcomes: ["YES", "NO"],
          },
        })}
        onPublishOracleAttestation={onPublishOracleAttestation}
        onView={vi.fn()}
      />,
    );

    const close = screen.getByRole("button", { name: /close market/i });
    const view = screen.getByRole("button", { name: /view/i });
    expect(
      close.compareDocumentPosition(view) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await userEvent.click(close);

    expect(onPublishOracleAttestation).toHaveBeenCalledWith("m1", "YES");
  });

  it("does not show a disabled close-market control when oracle metadata is missing", () => {
    render(
      <CreatedMarketRow
        market={fixture()}
        onPublishOracleAttestation={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: /close market/i })).toBeNull();
  });

  it("marks closed market thumbnails as Closed", () => {
    render(<CreatedMarketRow market={fixture({ status: "resolved" })} />);

    expect(screen.getByText("Closed")).toBeInTheDocument();
  });
});
