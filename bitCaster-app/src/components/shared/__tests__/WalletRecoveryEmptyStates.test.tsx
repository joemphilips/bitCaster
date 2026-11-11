import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WalletRecoveryHoldingsRead,
  WalletRecoveryStatus,
} from "@bitcaster/client-sdk/walletRecoveryStatus";
import i18n from "@/i18n";
import { FundsList } from "@/components/portfolio/FundsList";
import { PositionsList } from "@/components/portfolio/PositionsList";
import { StatsRow } from "@/components/portfolio/StatsRow";
import { Portfolio } from "@/components/portfolio/Portfolio";
import { TradingPanel } from "@/components/market-detail/TradingPanel";
import type { SellHoldingsState, YesNoMarketDetail } from "@/types/market-detail";
import type {
  Fund,
  PortfolioHoldingsReads,
  PortfolioProps,
  PortfolioStats,
  Position,
} from "@/types/portfolio";

// While the wallet recovery checks, waits or failed (issue #161), an empty
// holding is not known to be empty. An empty state and a zero count show only
// after a completed recovery and a holdings read that began after it.

const TAG = { activation: { scopeId: "scope", epoch: 1 }, mintSetTag: "[]" };
const COMPLETED: WalletRecoveryStatus = {
  kind: "completed",
  tag: TAG,
  passSeq: 1,
  coverage: "full",
};
const CHECKING: WalletRecoveryStatus = { kind: "checking", tag: TAG };
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
const READ_FAILED: WalletRecoveryStatus = {
  kind: "unavailable",
  tag: TAG,
  reason: "read-failed",
  retryable: true,
};
const NO_PROFILE: WalletRecoveryStatus = {
  kind: "unavailable",
  tag: null,
  reason: "profile-unavailable",
  retryable: false,
};

function okRead<T>(value: readonly T[], afterPassSeq = 1): WalletRecoveryHoldingsRead<T> {
  return { kind: "ok", tag: TAG, afterPassSeq, value };
}

const restore = vi.hoisted(() => ({
  status: null as unknown as WalletRecoveryStatus,
  profileExpected: true,
  retry: vi.fn(async (_scopeId: string) => {}),
  wake: vi.fn((_wake: { scopeId: string }) => {}),
}));

vi.mock("@/hooks/useWalletRecoveryStatus", () => ({
  useWalletRecoveryStatus: () => restore.status,
  useWalletProfileExpected: () => restore.profileExpected,
}));
vi.mock("@/lib/browserSeedPositionRestore", () => ({
  retryBrowserSeedPositionRestore: restore.retry,
}));
vi.mock("@/lib/browserCtfRangeOrderRecoveryWake", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/browserCtfRangeOrderRecoveryWake")>()),
  publishBrowserCtfRangeRecoveryWake: restore.wake,
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

const fund: Fund = {
  id: "https://mint.example:msat:sat",
  unit: "sats",
  amount: 12_345,
  mintUrl: "https://mint.example",
};

const activePosition: Position = {
  id: "active",
  marketId: "condition-YES",
  marketTitle: "Will it rain?",
  marketImageUrl: "",
  side: "yes",
  baseAsset: "sat",
  divisibility: 1_000,
  shares: 2,
  currentValueSats: 0,
  status: "active",
  isWinner: false,
  isLoser: false,
  isPending: false,
  acquiredDate: "2026-01-01T00:00:00Z",
  mintUrl: "https://mint.example",
};

const emptyReads: PortfolioHoldingsReads = { funds: okRead([]), positions: okRead([]) };

function portfolioProps(overrides: Partial<PortfolioProps> = {}): PortfolioProps {
  return {
    walletState: "ready",
    baseCurrency: "BTC",
    selectedTimeRange: "ALL",
    profile: { displayName: "Anonymous", avatarUrl: null, bio: "" },
    plChartData: { "1D": [], "1W": [], "1M": [], ALL: [] },
    stats,
    positions: [],
    activity: [],
    funds: [],
    holdings: emptyReads,
    createdMarkets: [],
    positionsTab: "active",
    ...overrides,
  };
}

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

function statusRow(): HTMLElement {
  return screen.getByTestId("wallet-recovery-status");
}

beforeEach(() => {
  restore.status = COMPLETED;
  restore.profileExpected = true;
  restore.retry.mockClear();
  restore.wake.mockClear();
});

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("empty states during the wallet recovery", () => {
  it.each([
    { name: "checking", status: CHECKING },
    { name: "pending", status: PENDING },
    { name: "failed", status: FAILED },
    { name: "read-failed", status: READ_FAILED },
    { name: "profile-unavailable", status: NO_PROFILE },
  ] as const)("hides the empty position list and zero counts while $name", ({ status }) => {
    restore.status = status;

    render(
      <PositionsList
        positions={[]}
        positionsTab="active"
        recoveryStatus={status}
        read={okRead([])}
      />,
    );

    expect(screen.queryByText("No active positions")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Active" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Closed" })).toBeInTheDocument();
  });

  it.each([
    ["unhydrated", { kind: "unhydrated" } as const],
    ["failed", { kind: "failed" } as const],
    ["read before the completed pass", okRead<Position>([], 0)],
    [
      "read of another activation",
      { ...okRead<Position>([]), tag: { ...TAG, activation: { scopeId: "scope", epoch: 0 } } },
    ],
  ] as const)("hides the empty list after the recovery for a %s read", (_name, read) => {
    render(
      <PositionsList positions={[]} positionsTab="active" recoveryStatus={COMPLETED} read={read} />,
    );

    expect(screen.queryByText("No active positions")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Active" })).toBeInTheDocument();
  });

  it("shows the empty list and its zero counts after the recovery and a current read", () => {
    render(
      <PositionsList
        positions={[]}
        positionsTab="active"
        recoveryStatus={COMPLETED}
        read={okRead([])}
      />,
    );

    expect(screen.getByText("No active positions")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Active (0)" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Closed (0)" })).toBeInTheDocument();
  });

  it("shows an empty closed tab beside an active position after the recovery", () => {
    render(
      <PositionsList
        positions={[activePosition]}
        positionsTab="closed"
        recoveryStatus={COMPLETED}
        read={okRead([activePosition])}
      />,
    );

    expect(screen.getByText("No closed positions")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Active (1)" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Closed (0)" })).toBeInTheDocument();
  });

  it("keeps a known position and its count while the recovery checks", () => {
    render(
      <PositionsList
        positions={[activePosition]}
        positionsTab="active"
        recoveryStatus={CHECKING}
        read={okRead([activePosition])}
      />,
    );

    expect(screen.getByText("Will it rain?")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Active (1)" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Closed" })).toBeInTheDocument();
  });

  it.each([
    ["checking", CHECKING, okRead<Fund>([])],
    ["pending", PENDING, okRead<Fund>([])],
    ["failed", FAILED, okRead<Fund>([])],
    ["completed with an unhydrated read", COMPLETED, { kind: "unhydrated" } as const],
    ["completed with a failed read", COMPLETED, { kind: "failed" } as const],
    ["completed with a read before the pass", COMPLETED, okRead<Fund>([], 0)],
  ] as const)("hides No funds while %s", (_name, status, read) => {
    render(<FundsList funds={[]} read={read} recoveryStatus={status} />);

    expect(screen.queryByText("No funds")).not.toBeInTheDocument();
  });

  it("shows No funds after the recovery and a current empty read", () => {
    render(<FundsList funds={[]} read={okRead([])} recoveryStatus={COMPLETED} />);

    expect(screen.getByText("No funds")).toBeInTheDocument();
  });

  it("keeps a known balance visible while the recovery checks", () => {
    render(<FundsList funds={[fund]} read={okRead([fund])} recoveryStatus={CHECKING} />);

    const amount = screen.getByTestId("fund-amount");
    expect(amount).toHaveTextContent("12.345 sats");
    expect(amount).not.toHaveAttribute("aria-busy");
    expect(screen.getByRole("listitem")).toHaveAttribute("data-amount-subunits", "12345");
  });

  it("mutes a projected balance while the recovery checks, and never shows it as final", () => {
    const { rerender } = render(
      <FundsList funds={[fund]} read={{ kind: "unhydrated" }} recoveryStatus={CHECKING} />,
    );

    const projected = screen.getByTestId("fund-amount");
    expect(projected).toHaveAttribute("aria-busy", "true");
    expect(projected).toHaveClass("text-slate-400");
    expect(projected).not.toHaveClass("text-slate-900");

    rerender(<FundsList funds={[fund]} read={okRead([fund])} recoveryStatus={CHECKING} />);

    // The same element takes the normal style, so its color can fade.
    const real = screen.getByTestId("fund-amount");
    expect(real).toBe(projected);
    expect(real).not.toHaveAttribute("aria-busy");
    expect(real).toHaveClass("text-slate-900");
  });

  it("shows a projected balance in the normal style after the recovery", () => {
    render(<FundsList funds={[fund]} read={{ kind: "failed" }} recoveryStatus={COMPLETED} />);

    expect(screen.getByTestId("fund-amount")).not.toHaveAttribute("aria-busy");
    expect(screen.getByTestId("fund-amount")).toHaveClass("text-slate-900");
  });

  it("does not show zero position totals while the recovery runs", () => {
    const { rerender } = render(<StatsRow stats={stats} positionsRestoring />);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    expect(screen.getAllByText("—")).toHaveLength(3);

    rerender(<StatsRow stats={stats} />);
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("does not show a partial total while the recovery runs", () => {
    render(<StatsRow stats={{ ...stats, totalValueSats: 12_000 }} positionsRestoring />);

    // The msat balance is back, but the total also needs the positions.
    expect(screen.getByText("Total Value").parentElement).toHaveTextContent("—");
    expect(screen.getByText("Total Value").parentElement).not.toHaveTextContent("12");
  });

  it.each([
    ["pending", PENDING, emptyReads],
    [
      "completed with an unhydrated funds read",
      COMPLETED,
      { ...emptyReads, funds: { kind: "unhydrated" } },
    ],
  ] as const)(
    "does not show a partial total on the Portfolio page while %s",
    (_name, status, holdings) => {
      restore.status = status;

      render(
        <Portfolio
          {...portfolioProps({ stats: { ...stats, totalValueSats: 12_000 }, holdings })}
        />,
      );

      // Neither the chart header nor the statistics row shows the partial total.
      expect(screen.queryByText(/12[,.]?000|12 sats/)).not.toBeInTheDocument();
    },
  );

  it("shows the totals and the empty states after the recovery and current reads", async () => {
    render(<Portfolio {...portfolioProps()} />);

    expect(screen.getByText("No active positions")).toBeInTheDocument();
    expect(screen.getByText("Predictions").parentElement).toHaveTextContent("0");
    await userEvent.click(screen.getByRole("tab", { name: "Funds" }));
    expect(screen.getByText("No funds")).toBeInTheDocument();
    expect(statusRow()).toHaveAttribute("data-state", "complete");
    expect(statusRow()).toBeEmptyDOMElement();
  });

  it("does not report zero held shares in the Sell panel while the recovery runs", () => {
    restore.status = PENDING;

    renderSell();

    expect(screen.queryByText("No selectable shares")).not.toBeInTheDocument();
    expect(screen.queryByText(/Held: 0 shares/)).not.toBeInTheDocument();
    expect(screen.getByTestId("trade-outcome-yes")).toBeDisabled();
    expect(screen.getByTestId("trade-confirm")).toHaveTextContent("Restoring wallet…");
    expect(statusRow()).toHaveAttribute("data-state", "pending");
  });

  it("names the check in the Sell panel while the recovery checks", () => {
    restore.status = CHECKING;

    renderSell();

    expect(screen.getByTestId("trade-confirm")).toHaveTextContent("Checking wallet…");
    expect(statusRow()).toHaveAttribute("data-state", "checking");
  });

  it("names unavailable holdings in the Sell panel after the recovery failed", () => {
    restore.status = FAILED;

    renderSell();

    expect(screen.queryByText("No selectable shares")).not.toBeInTheDocument();
    expect(screen.getByTestId("trade-confirm")).toHaveTextContent(
      "Wallet holdings are unavailable",
    );
    expect(statusRow()).toHaveAttribute("data-state", "unavailable");
    expect(within(statusRow()).getByRole("alert")).toHaveTextContent("Wallet recovery failed.");
  });

  it("reports zero held shares in the Sell panel after the recovery", () => {
    renderSell();

    expect(screen.getByTestId("sell-holding-status")).toHaveTextContent("No selectable shares");
    expect(statusRow()).toHaveAttribute("data-state", "complete");
  });

  it("shows nothing in the Sell panel for a visitor without a wallet", () => {
    restore.status = NO_PROFILE;
    restore.profileExpected = false;

    renderSell();

    expect(statusRow()).toHaveAttribute("data-state", "unavailable");
    expect(statusRow()).toBeEmptyDOMElement();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("the wallet recovery status row", () => {
  it("shows one row above the Portfolio tabs, and no restore notice inside the list", () => {
    restore.status = CHECKING;

    render(<Portfolio {...portfolioProps()} />);

    const rows = screen.getAllByTestId("wallet-recovery-status");
    expect(rows).toHaveLength(1);
    const tabs = screen.getByRole("tab", { name: "Positions" }).closest("div.rounded-xl")!;
    expect(rows[0]!.nextElementSibling).toBe(tabs);
    expect(rows[0]).toHaveAttribute("data-state", "checking");
    expect(within(rows[0]!).getByRole("status")).toHaveTextContent("Checking wallet…");
    expect(screen.getAllByText("Checking wallet…")).toHaveLength(1);
  });

  it.each([
    [{ ...PENDING, reason: "proof-pending" } as const, "Waiting for the mint…"],
    [PENDING, "Restoring wallet…"],
  ])("shows a neutral pending row", (status, text) => {
    restore.status = status;

    render(<Portfolio {...portfolioProps()} />);

    expect(statusRow()).toHaveAttribute("data-state", "pending");
    expect(within(statusRow()).getByRole("status")).toHaveTextContent(text);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    ["en", new Date(2026, 10, 11, 14, 5), "Recovery resumes at 02:05 PM"],
    ["en", new Date(2026, 10, 12, 14, 5), "Recovery resumes at Nov 12, 02:05 PM"],
    ["ja", new Date(2026, 10, 11, 14, 5), "14:05に復元を再開します"],
  ] as const)(
    "names the resume time of a start-limit wait in %s at %s",
    async (locale, at, text) => {
      // The resume time names its day only when it is not today.
      vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 10, 11, 10, 0) });
      try {
        await act(() => i18n.changeLanguage(locale));
        restore.status = { ...PENDING, reason: "start-limit", retryAtMs: at.getTime() };

        render(<Portfolio {...portfolioProps()} />);

        expect(within(statusRow()).getByRole("status")).toHaveTextContent(text);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("retries a failed recovery: it resets the backoff and wakes the coordinator", async () => {
    restore.status = FAILED;

    render(<Portfolio {...portfolioProps()} />);
    await userEvent.click(within(statusRow()).getByRole("button", { name: "Retry" }));

    expect(restore.retry).toHaveBeenCalledWith("scope");
    expect(restore.wake).toHaveBeenCalledWith({ scopeId: "scope" });
    expect(restore.retry.mock.invocationCallOrder[0]).toBeLessThan(
      restore.wake.mock.invocationCallOrder[0]!,
    );
  });

  it.each([
    ["a failed status read", READ_FAILED, emptyReads],
    ["a failed custody read", COMPLETED, { ...emptyReads, funds: { kind: "failed" } as const }],
  ])("asks for a reload after %s", (_name, status, holdings) => {
    restore.status = status;

    render(<Portfolio {...portfolioProps({ holdings })} />);

    const alert = within(statusRow()).getByRole("alert");
    expect(alert).toHaveTextContent("Wallet data could not be read.");
    expect(within(alert).getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(within(alert).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("offers Reload and the seed restore in Settings without an active wallet profile", () => {
    restore.status = NO_PROFILE;

    render(<Portfolio {...portfolioProps()} />);

    const alert = within(statusRow()).getByRole("alert");
    expect(alert).toHaveTextContent("The wallet is not open.");
    expect(within(alert).getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(within(alert).getByRole("link", { name: "Restore from seed" })).toHaveAttribute(
      "href",
      "/settings?category=cashu",
    );
  });

  it("does not repeat a local read failure in the monitoring notice", () => {
    restore.status = COMPLETED;

    render(
      <Portfolio
        {...portfolioProps({
          holdings: { ...emptyReads, positions: { kind: "failed" } },
          monitoring: {
            stale: false,
            incomplete: false,
            building: false,
            unvaluedAssetCount: 0,
            hasPendingOutgoing: false,
            pendingOutgoingValueMsat: null,
            error: null,
            assetPageError: null,
            hasMoreAssets: false,
            loadingMoreAssets: false,
            liveUpdateCoverageLimited: false,
          },
        })}
      />,
    );

    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByText(/Portfolio monitoring is unavailable/)).not.toBeInTheDocument();
  });

  it("shows the Japanese row text", async () => {
    await act(() => i18n.changeLanguage("ja"));
    restore.status = FAILED;

    render(<Portfolio {...portfolioProps()} />);

    expect(within(statusRow()).getByRole("alert")).toHaveTextContent(
      i18n.t("wallet.recovery.failed"),
    );
    expect(i18n.t("wallet.recovery.failed")).not.toBe("wallet.recovery.failed");
  });
});
