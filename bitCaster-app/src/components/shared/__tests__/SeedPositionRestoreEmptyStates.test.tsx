import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PositionsList } from "@/components/portfolio/PositionsList";
import { StatsRow } from "@/components/portfolio/StatsRow";
import { Portfolio } from "@/components/portfolio/Portfolio";
import { TradingPanel } from "@/components/market-detail/TradingPanel";
import type { WalletRecoveryStatus } from "@bitcaster/client-sdk/walletRecoveryStatus";
import type { SellHoldingsState, YesNoMarketDetail } from "@/types/market-detail";
import type { PortfolioStats } from "@/types/portfolio";

// While the wallet recovery checks, waits or failed (issue #161), a zero
// holding is not known to be zero. The restore notice replaces the empty states.

const TAG = { activation: { scopeId: "scope", epoch: 1 }, mintSetTag: "[]" };
const COMPLETED: WalletRecoveryStatus = {
  kind: "completed",
  tag: TAG,
  passSeq: 1,
  coverage: "full",
};
const PENDING: WalletRecoveryStatus = {
  kind: "pending",
  tag: TAG,
  reason: "scan-continues",
  retryAtMs: null,
};
const FAILED: WalletRecoveryStatus = {
  kind: "unavailable",
  tag: TAG,
  reason: "recovery-failed",
  retryable: true,
};

const restore = vi.hoisted(() => ({
  status: null as unknown as WalletRecoveryStatus,
}));

vi.mock("@/hooks/useWalletRecoveryStatus", () => ({
  useWalletRecoveryStatus: () => restore.status,
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
    restore.status = COMPLETED;
  });

  it.each([
    { name: "checking", status: { kind: "checking", tag: TAG }, text: "Restoring positions…" },
    { name: "pending", status: PENDING, text: "Restoring positions…" },
    { name: "failed", status: FAILED, text: "Positions could not be restored from the mint." },
    {
      name: "read-failed",
      status: { kind: "unavailable", tag: TAG, reason: "read-failed", retryable: true },
      text: "Positions could not be restored from the mint.",
    },
  ] as const)("shows the $name notice instead of an empty position list", ({ status, text }) => {
    restore.status = status;

    render(<PositionsList positions={[]} positionsTab="active" />);

    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByText("No active positions")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Active" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Closed" })).toBeInTheDocument();
  });

  it.each([
    { name: "after the restore", status: COMPLETED },
    {
      name: "without an active wallet profile",
      status: {
        kind: "unavailable",
        tag: null,
        reason: "profile-unavailable",
        retryable: false,
      } as const,
    },
  ])("shows the empty list and its zero counts $name", ({ status }) => {
    restore.status = status;

    render(<PositionsList positions={[]} positionsTab="active" />);

    expect(screen.getByText("No active positions")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Active (0)" })).toBeInTheDocument();
    expect(screen.queryByTestId("seed-restore-status")).not.toBeInTheDocument();
    expect(screen.queryByTestId("seed-restore-error")).not.toBeInTheDocument();
  });

  it("does not show zero position totals while the restore runs", () => {
    const { rerender } = render(<StatsRow stats={stats} positionsRestoring />);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    expect(screen.getAllByText("—")).toHaveLength(3);

    rerender(<StatsRow stats={stats} />);
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("does not show a partial total while the restore runs", () => {
    render(<StatsRow stats={{ ...stats, totalValueSats: 12_000 }} positionsRestoring />);

    // The msat balance is back, but the total also needs the positions.
    expect(screen.getByText("Total Value").parentElement).toHaveTextContent("—");
    expect(screen.getByText("Total Value").parentElement).not.toHaveTextContent("12");
  });

  it("does not report zero held shares in the Sell panel while the restore runs", () => {
    restore.status = PENDING;

    renderSell();

    expect(screen.queryByText("No selectable shares")).not.toBeInTheDocument();
    expect(screen.queryByText(/Held: 0 shares/)).not.toBeInTheDocument();
    expect(screen.getByTestId("trade-outcome-yes")).toBeDisabled();
    expect(screen.getByTestId("trade-confirm")).toHaveTextContent("Restoring positions…");
  });

  it("does not show a partial total on the Portfolio page while the restore runs", () => {
    restore.status = PENDING;

    render(
      <Portfolio
        walletState="ready"
        baseCurrency="BTC"
        selectedTimeRange="ALL"
        profile={{ displayName: "Anonymous", avatarUrl: null, bio: "" }}
        plChartData={{ "1D": [], "1W": [], "1M": [], ALL: [] }}
        stats={{ ...stats, totalValueSats: 12_000 }}
        positions={[]}
        activity={[]}
        funds={[]}
        createdMarkets={[]}
        positionsTab="active"
      />,
    );

    // Neither the chart header nor the statistics row shows the partial total.
    expect(screen.queryByText(/12[,.]?000|12 sats/)).not.toBeInTheDocument();
  });

  it("names unavailable holdings in the Sell panel after the restore failed", () => {
    restore.status = FAILED;

    renderSell();

    expect(screen.queryByText("No selectable shares")).not.toBeInTheDocument();
    expect(screen.getByTestId("trade-confirm")).toHaveTextContent(
      "Wallet holdings are unavailable",
    );
    expect(screen.getByTestId("trade-confirm")).not.toHaveTextContent("Restoring positions");
  });

  it("reports zero held shares in the Sell panel after the restore", () => {
    renderSell();

    expect(screen.getByTestId("sell-holding-status")).toHaveTextContent("No selectable shares");
  });
});
