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
    baseAsset: "sat",
    divisibility: 1_000,
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

  it("formats created-market volume and fees with the market unit", () => {
    render(
      <CreatedMarketRow
        market={fixture({
          baseAsset: "sat",
          volume: 2_500,
          creatorFeesEarned: 125,
          status: "resolved",
        })}
      />,
    );

    expect(screen.getByText("Vol: 2.5 sats")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "0.125 sats" })).toBeInTheDocument();
  });

  it.each([
    { outcomes: ["YES", "NO"], selected: "NO" },
    { outcomes: ["Alpha", "Beta", "Gamma"], selected: "Beta" },
  ])(
    "keeps market information and working oracle actions together for $outcomes",
    async ({ outcomes, selected }) => {
      const onPublishOracleAttestation = vi.fn();
      render(
        <CreatedMarketRow
          market={fixture({
            volume: 10_000,
            oracle: {
              type: "self",
              eventId: "event-1",
              outcomes,
            },
          })}
          onPublishOracleAttestation={onPublishOracleAttestation}
          onView={vi.fn()}
        />,
      );

      const close = screen.getByRole("button", { name: /close market/i });
      const view = screen.getByRole("button", { name: /view/i });
      expect(screen.getByText("Will BTC hit 100K?", { exact: true })).toBeVisible();
      expect(screen.getByText("Active", { exact: true })).toBeVisible();
      expect(screen.getByText("Vol: 10 sats", { exact: true })).toBeVisible();
      expect(close.compareDocumentPosition(view) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      await userEvent.selectOptions(screen.getByRole("combobox"), selected);
      await userEvent.click(close);

      expect(onPublishOracleAttestation).toHaveBeenCalledWith("m1", selected);
    },
  );

  it("does not show a disabled close-market control when oracle metadata is missing", () => {
    render(<CreatedMarketRow market={fixture()} onPublishOracleAttestation={vi.fn()} />);

    expect(screen.queryByRole("button", { name: /close market/i })).toBeNull();
  });

  it("retains a deadline-closed unresolved market's resolution action", async () => {
    const publish = vi.fn();
    render(
      <CreatedMarketRow
        market={fixture({
          status: "resolved",
          oracle: { type: "self", eventId: "event", outcomes: ["YES", "NO"] },
        })}
        onPublishOracleAttestation={publish}
      />,
    );
    await userEvent.selectOptions(screen.getByRole("combobox"), "NO");
    await userEvent.click(screen.getByRole("button", { name: /close market/i }));
    expect(publish).toHaveBeenCalledWith("m1", "NO");
    expect(screen.getByText("Closed")).toBeVisible();
  });

  it("locks the persisted choice and offers only exact delivery retry", async () => {
    const publish = vi.fn();
    render(
      <CreatedMarketRow
        market={fixture({
          status: "resolved",
          oracle: {
            type: "self",
            eventId: "event",
            outcomes: ["YES", "NO"],
            chosenOutcome: "NO",
            attestationEventJson: "saved exact event",
            relayPublished: true,
          },
        })}
        onPublishOracleAttestation={publish}
      />,
    );
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(screen.getByRole("combobox")).toHaveValue("NO");
    expect(screen.getByText(/Engine unconfirmed/)).toBeVisible();
    expect(screen.getByText(/Relay confirmed/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry saved resolution" }));
    expect(publish).toHaveBeenCalledWith("m1", "NO");
  });

  it("marks closed market thumbnails as Closed", () => {
    render(<CreatedMarketRow market={fixture({ status: "resolved" })} />);

    expect(screen.getByText("Closed")).toBeInTheDocument();
  });

  it("shows unavailable engine state without claiming Active, Closed, or resolution", () => {
    render(
      <CreatedMarketRow
        market={fixture({
          status: "unknown",
          engineDataStatus: "unavailable",
          oracle: { type: "self", eventId: "oracle", outcomes: ["YES", "NO"] },
        })}
        onPublishOracleAttestation={vi.fn()}
      />,
    );
    expect(screen.getByText("Engine state unknown")).toBeInTheDocument();
    expect(screen.getByText("Engine state and volume unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Active")).toBeNull();
    expect(screen.queryByText("Closed")).toBeNull();
    expect(screen.queryByRole("button", { name: /close market/i })).toBeNull();
  });

  it("labels retained closed state and volume as last known", () => {
    render(
      <CreatedMarketRow
        market={fixture({ status: "resolved", engineDataStatus: "stale", volume: 75_000 })}
      />,
    );
    expect(screen.getByText("Closed")).toBeInTheDocument();
    expect(screen.getByText("Vol: 75 sats")).toBeInTheDocument();
    expect(screen.getByText("Last known engine state and volume")).toBeInTheDocument();
  });
});
