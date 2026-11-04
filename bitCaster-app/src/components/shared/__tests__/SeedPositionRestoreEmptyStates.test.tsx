import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PositionsList } from "@/components/portfolio/PositionsList";
import { StatsRow } from "@/components/portfolio/StatsRow";
import { TradingPanel } from "@/components/market-detail/TradingPanel";
import type { SeedPositionRestoreStatus } from "@/hooks/useSeedPositionRestoreStatus";
import type { SellHoldingsState, YesNoMarketDetail } from "@/types/market-detail";
import type { PortfolioStats } from "@/types/portfolio";

// While the automatic seed restore runs or failed (ADR-039), a zero holding is
// not known to be zero. The restore notice replaces the empty states.

const restore = vi.hoisted(() => ({
  status: { kind: "idle" } as SeedPositionRestoreStatus,
}));

vi.mock("@/hooks/useSeedPositionRestoreStatus", () => ({
  useSeedPositionRestoreStatus: () => restore.status,
}));

const market: YesNoMarketDetail = {
  id: "sat-market",
  title: "Will it happen?",
  type: "yesno",
  categoryTags: [],
  volume: 0,
  liquidity: 0,
  liquiditySubunits: 0,
  ammBotBudgetSubunits: 0,
  volumeLifetimeSubunits: 0,
  closingDate: "2030-01-01T00:00:00Z",
  createdDate: "2026-01-01T00:00:00Z",
  activeSince: "2026-01-01T00:00:00Z",
  baseAsset: "sat",
  divisibility: 1_000,
  baseUnit: "sats",
  creator: { id: "creator", name: "Creator", totalMarketsCreated: 0, feePercent: 1 },
  resolution: {
    criteria: "Will it happen?",
    source: "oracle",
    resolutionDate: "2030-01-01T00:00:00Z",
    status: "open",
  },
  priceHistory: { data: [], timeframe: "7d" },
  orderBook: {
    bids: [{ price: 400, amount: 100, total: 100 }],
    asks: [{ price: 600, amount: 100, total: 100 }],
    spread: 200,
  },
  recentTrades: [],
  comments: [],
  relatedMarkets: [],
  currentOdds: { yes: 50, no: 50 },
  outcomes: [
    { id: "Yes", label: "Yes", odds: null },
    { id: "No", label: "No", odds: null },
  ],
};

const emptyHoldings: SellHoldingsState = { status: "ready", byOutcomeSetId: new Map() };

const stats = {
  totalValueSats: 0,
  totalValueKnown: true,
  positionsValueSats: 0,
  positionsValueKnown: true,
  predictionsCount: 0,
} as PortfolioStats;

function renderSell() {
  return render(
    <TradingPanel
      market={market}
      tradeSide="Sell"
      tradeSelection={{ side: "yes" }}
      tradeAmount={2}
      tradePreview={null}
      sellHoldings={emptyHoldings}
    />,
  );
}

describe("empty states during the seed restore", () => {
  beforeEach(() => {
    restore.status = { kind: "idle" };
  });

  it.each([
    { kind: "restoring", scopeId: "scope", text: "Restoring positions…" },
    { kind: "failed", scopeId: "scope", text: "Positions could not be restored from the mint." },
  ] as const)("shows the $kind notice instead of an empty position list", ({ text, ...status }) => {
    restore.status = status;

    render(<PositionsList positions={[]} positionsTab="active" />);

    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByText("No active positions")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Active" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Closed" })).toBeInTheDocument();
  });

  it("shows the empty list and its zero counts after the restore", () => {
    render(<PositionsList positions={[]} positionsTab="active" />);

    expect(screen.getByText("No active positions")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Active (0)" })).toBeInTheDocument();
  });

  it("does not show zero position totals while the restore runs", () => {
    const { rerender } = render(<StatsRow stats={stats} positionsRestoring />);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    expect(screen.getAllByText("—")).toHaveLength(3);

    rerender(<StatsRow stats={stats} />);
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("keeps an already restored total while the restore runs", () => {
    render(<StatsRow stats={{ ...stats, totalValueSats: 12_000 }} positionsRestoring />);

    // The msat balance is back; only the zero position totals are unknown.
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.getByText("Total Value").parentElement).not.toHaveTextContent("—");
  });

  it("does not report zero held shares in the Sell panel while the restore runs", () => {
    restore.status = { kind: "restoring", scopeId: "scope" };

    renderSell();

    expect(screen.queryByText("No selectable shares")).not.toBeInTheDocument();
    expect(screen.queryByText(/Held: 0 shares/)).not.toBeInTheDocument();
    expect(screen.getByTestId("trade-outcome-yes")).toBeDisabled();
    expect(screen.getByTestId("trade-confirm")).toHaveTextContent("Restoring positions…");
  });

  it("reports zero held shares in the Sell panel after the restore", () => {
    renderSell();

    expect(screen.getByTestId("sell-holding-status")).toHaveTextContent("No selectable shares");
  });
});
