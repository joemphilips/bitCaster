import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { MarketCard } from "../MarketCard";
import type { YesNoMarket, CategoricalMarket } from "@/types/market";

const yesNoMarket: YesNoMarket = {
  id: "mkt-1",
  title: "Will BTC reach 100K?",
  type: "yesno",
  state: "open",
  imageUrl: "",
  categoryTags: ["crypto"],
  metaTags: ["trending"],
  currentOdds: { yes: 6_500, no: 3_500 },
  volume: 100000,
  liquidity: 50000,
  liquiditySubunits: 50_000,
  ammBotBudgetSubunits: 50_000,
  volumeLifetimeSubunits: 100_000,
  closingDate: "2026-12-31T00:00:00Z",
  createdDate: "2026-01-01T00:00:00Z",
  activeSince: "2026-01-01T00:00:00Z",
  creatorFeePercent: 2,
  baseMarket: "sats",
  baseAsset: "sat",
  divisibility: 10_000,
};

const categoricalMarket: CategoricalMarket = {
  id: "mkt-2",
  title: "Who wins the championship?",
  type: "categorical",
  state: "open",
  imageUrl: "",
  categoryTags: ["sports"],
  metaTags: [],
  outcomes: [
    { id: "a", label: "Team A", odds: 4_000 },
    { id: "b", label: "Team B", odds: 3_500 },
    { id: "c", label: "Team C", odds: 2_500 },
  ],
  volume: 50000,
  liquidity: 20000,
  liquiditySubunits: 20_000,
  ammBotBudgetSubunits: 20_000,
  volumeLifetimeSubunits: 50_000,
  closingDate: "2026-06-30T00:00:00Z",
  createdDate: "2026-01-01T00:00:00Z",
  activeSince: "2026-01-01T00:00:00Z",
  creatorFeePercent: 1.5,
  baseMarket: "sats",
  baseAsset: "sat",
  divisibility: 10_000,
};

describe("MarketCard", () => {
  it("renders yes/no market with odds and Buy buttons", () => {
    render(<MarketCard market={yesNoMarket} />);

    expect(screen.getByText("Will BTC reach 100K?")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Will BTC reach 100K?" })).toHaveAttribute(
      "href",
      "/markets/mkt-1",
    );
    expect(screen.getByText("65.00%")).toBeInTheDocument();
    expect(screen.getByText("Buy YES")).toBeInTheDocument();
    expect(screen.getByText("Buy NO")).toBeInTheDocument();
  });

  it("renders resolved YES for a closed binary market without Chance or trade buttons", () => {
    render(<MarketCard market={{ ...yesNoMarket, state: "closed", finalOutcome: "Yes" }} />);

    expect(screen.getByText("Will BTC reach 100K?")).toBeInTheDocument();
    expect(screen.getByText("YES")).toBeInTheDocument();
    expect(screen.queryByText("Chance")).not.toBeInTheDocument();
    expect(screen.queryByText("65.00%")).not.toBeInTheDocument();
    expect(screen.queryByText("Buy YES")).not.toBeInTheDocument();
    expect(screen.queryByText("Buy NO")).not.toBeInTheDocument();
  });

  it("renders resolved NO for a closed binary market in red", () => {
    render(<MarketCard market={{ ...yesNoMarket, state: "closed", finalOutcome: "No" }} />);

    const resolvedOutcome = screen.getByText("NO");
    expect(resolvedOutcome).toBeInTheDocument();
    expect(resolvedOutcome).toHaveClass("text-rose-600");
  });

  it("renders winning outcome name for a closed categorical market without outcome buttons", () => {
    render(
      <MarketCard market={{ ...categoricalMarket, state: "closed", finalOutcome: "Team B" }} />,
    );

    expect(screen.getByText("Team B")).toBeInTheDocument();
    expect(screen.queryByText("Chance")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Yes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "No" })).not.toBeInTheDocument();
  });

  it("formats sat-market volume and liquidity from msat subunits", () => {
    render(<MarketCard market={yesNoMarket} />);

    expect(screen.getByText("100 sats")).toBeInTheDocument();
    expect(screen.getByText("50 sats")).toBeInTheDocument();
  });

  it("shows zero bot budget for unfunded markets without inventing liquidity", () => {
    render(<MarketCard market={{ ...yesNoMarket, ammBotBudgetSubunits: 0 }} />);

    expect(screen.getByTestId("market-bot-budget")).toHaveTextContent("0 sats");
  });

  it("renders categorical market with outcome list", () => {
    render(<MarketCard market={categoricalMarket} />);

    expect(screen.getByText("Who wins the championship?")).toBeInTheDocument();
    expect(screen.getByText("Team A")).toBeInTheDocument();
    expect(screen.getByText("Team B")).toBeInTheDocument();
    expect(screen.getByText("Team C")).toBeInTheDocument();
  });

  it("calls onViewMarket when Buy YES is clicked", async () => {
    const user = userEvent.setup();
    const onViewMarket = vi.fn();

    render(<MarketCard market={yesNoMarket} onViewMarket={onViewMarket} />);

    await user.click(screen.getByText("Buy YES"));

    expect(onViewMarket).toHaveBeenCalledWith("mkt-1");
  });

  it("calls onViewMarket when Buy NO is clicked", async () => {
    const user = userEvent.setup();
    const onViewMarket = vi.fn();

    render(<MarketCard market={yesNoMarket} onViewMarket={onViewMarket} />);

    await user.click(screen.getByText("Buy NO"));

    expect(onViewMarket).toHaveBeenCalledWith("mkt-1");
  });

  it("does not open the legacy wallet wizard when a no-wallet user clicks Buy", async () => {
    const user = userEvent.setup();
    const onViewMarket = vi.fn();

    render(<MarketCard market={yesNoMarket} walletReady={false} onViewMarket={onViewMarket} />);

    await user.click(screen.getByText("Buy YES"));

    expect(screen.queryByTestId("wallet-required-modal")).not.toBeInTheDocument();
    expect(onViewMarket).toHaveBeenCalledWith("mkt-1");
  });

  it("calls onViewMarket when card body is clicked", async () => {
    const user = userEvent.setup();
    const onViewMarket = vi.fn();

    render(<MarketCard market={yesNoMarket} onViewMarket={onViewMarket} />);

    // Click on the title (non-button area)
    await user.click(screen.getByText("Will BTC reach 100K?"));

    expect(onViewMarket).toHaveBeenCalledWith("mkt-1");
  });
});
