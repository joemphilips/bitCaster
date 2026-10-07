import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ActivityItem, PortfolioProps } from "@/types/portfolio";

const controlled = vi.hoisted(() => ({ activity: [] as ActivityItem[] }));

vi.mock("../usePortfolioState", () => ({
  usePortfolioState: () =>
    ({
      walletState: "ready",
      baseCurrency: "BTC",
      selectedTimeRange: "ALL",
      profile: {
        userId: "activity-wallet",
        displayName: "Activity wallet",
        avatarUrl: null,
        registeredDate: "2026-09-27T12:00:00.000Z",
      },
      plChartData: { "1D": [], "1W": [], "1M": [], ALL: [] },
      stats: { positionsValueSats: 0, totalValueSats: 0, predictionsCount: 0 },
      positions: [],
      funds: [],
      activity: controlled.activity,
      createdMarkets: [],
      positionsTab: "active",
    }) satisfies PortfolioProps,
}));
vi.mock("@/hooks/useLikedMarkets", () => ({
  useLikedMarkets: () => ({ markets: [], loading: false, error: null }),
}));
vi.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({ nostrSignerMode: "none", nostrProfile: null }),
}));
vi.mock("@/stores/activity-log", () => ({
  useActivityLogStore: (selector: (state: unknown) => unknown) =>
    selector({ addActivity: vi.fn() }),
}));
vi.mock("@/stores/wallet", () => ({
  useWalletStore: { getState: () => ({ mnemonic: null }) },
}));
vi.mock("@/lib/browserWalletProfile", () => ({
  activeBrowserWalletScopeId: () => "activity-wallet",
  browserWalletIdFromMnemonic: vi.fn(),
  isActiveBrowserWalletId: vi.fn(),
}));
vi.mock("@/lib/browserPortfolioClaim", () => ({ claimPortfolioPosition: vi.fn() }));
vi.mock("@/lib/browserPortfolioRemove", () => ({ removePortfolioPosition: vi.fn() }));
vi.mock("@/components/deposit-withdraw/DepositWithdrawOverlay", () => ({
  DepositWithdrawOverlay: () => null,
}));
vi.mock("@/components/shared/WalletSetupModal", () => ({ WalletSetupModal: () => null }));

import { PortfolioPage } from "../PortfolioPage";

function fill(fillId: string, amountSubunits: number, faceAmountSubunits: number): ActivityItem {
  return {
    id: `trade:${fillId}`,
    walletId: "a".repeat(64),
    type: "Sell",
    amountSubunits,
    baseAsset: "sat",
    date: "2026-09-27T12:00:00.000Z",
    status: "completed",
    txId: null,
    lightningInvoice: null,
    marketId: "condition-YES",
    marketTitle: "Recorded market",
    tradeDetails: {
      orderId: "submitted-order",
      fillId,
      outcomeId: "YES",
      tokenSide: "Outcome",
      faceAmountSubunits,
      divisibility: 1_000,
    },
  };
}

describe("Portfolio route Activity records", () => {
  it.each([
    ["en", "Activity", "2 recorded fills", "Trade value before fees", "Outcome YES", "shares"],
    ["ja", "アクティビティ", "記録された約定 2 件", "手数料適用前の取引額", "YES のトークン", "口"],
  ] as const)(
    "expands the real route's exact fill facts in %s",
    async (language, tab, header, qualifier, token, shareUnit) => {
      await i18n.changeLanguage(language);
      controlled.activity = [fill("fill-one", 1_003, 2_500), fill("fill-two", 1_250, 3_000)];
      render(
        <MemoryRouter initialEntries={["/portfolio"]}>
          <Routes>
            <Route path="/portfolio" element={<PortfolioPage />} />
          </Routes>
        </MemoryRouter>,
      );
      await userEvent.click(screen.getByRole("tab", { name: tab }));
      const panel = screen.getByRole("tabpanel");
      const groups = panel.querySelectorAll("details");
      expect(groups).toHaveLength(1);
      expect(groups[0].open).toBe(false);
      await userEvent.click(within(panel).getByText(new RegExp(header)));
      expect(groups[0].open).toBe(true);
      const records = within(panel).getAllByRole("article");
      expect(records).toHaveLength(2);
      for (const [index, [amount, shares]] of [
        ["1.003 sats", "2.5"],
        ["1.25 sats", "3"],
      ].entries()) {
        const record = within(records[index]);
        expect(record.getByText("Recorded market")).toBeVisible();
        expect(record.getByText(`${token} · ${shares} ${shareUnit}`)).toBeVisible();
        expect(record.getByRole("group", { name: amount })).toBeVisible();
        expect(record.getByText(qualifier)).toBeVisible();
        expect(records[index].textContent).toContain("+");
        expect(records[index]).not.toHaveAttribute("tabindex");
      }
      expect(within(panel).queryByRole("button")).not.toBeInTheDocument();
      expect(within(panel).queryByRole("link")).not.toBeInTheDocument();
    },
  );
});
