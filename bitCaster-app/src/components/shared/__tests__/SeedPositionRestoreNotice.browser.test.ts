import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import "@/index.css";
import i18n from "@/i18n";
import { AppShell } from "@/components/shell/AppShell";
import { Portfolio } from "@/components/portfolio/Portfolio";
import { TradingPanel } from "@/components/market-detail/TradingPanel";
import { ToastContainer } from "@/components/ui/Toast";
import { browserWalletScopeIdFromMnemonic } from "@/lib/browserWalletProfile";
import { initialSeedRestoreState, seedRestoreDatabase } from "@/stores/seed-restore-db";
import { useToastStore } from "@/stores/toast";
import { usedInAnotherBrowserToast } from "@/hooks/useBrowserCtfRangeOrderRecovery";
import { useWalletStore } from "@/stores/wallet";
import type { YesNoMarketDetail } from "@/types/market-detail";
import type { PortfolioProps } from "@/types/portfolio";

// UI review evidence for the automatic seed restore (ADR-039, amendment
// 2026-11-04): the Portfolio page and the Sell tab in the app shell, the
// "used in another browser" toast, and the state after Retry. EN and JA,
// desktop and mobile.

// Notifications own unrelated external I/O.
vi.mock("@/components/shell/NotificationBell", () => ({ NotificationBell: () => null }));

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const MINT_URL = "https://mint.example";
const scopeId = browserWalletScopeIdFromMnemonic(MNEMONIC)!;
const language = i18n.language;
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
let root: Root | undefined;
let host: HTMLDivElement | undefined;

const market: YesNoMarketDetail = {
  id: "ab".repeat(32),
  title: "Will Ethereum reach a new all-time high in 2026?",
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

const portfolio: PortfolioProps = {
  walletState: "ready",
  baseCurrency: "BTC",
  selectedTimeRange: "ALL",
  profile: { displayName: "Anonymous", avatarUrl: null, bio: "" },
  plChartData: { "1D": [], "1W": [], "1M": [], ALL: [] },
  // The msat balance is back. The positions are not back yet.
  stats: {
    positionsValueSats: 0,
    totalValueSats: 12_000,
    positionsValueKnown: true,
    totalValueKnown: true,
    predictionsCount: 0,
  },
  positions: [],
  activity: [],
  funds: [],
  createdMarkets: [],
  positionsTab: "active",
};

beforeEach(async () => {
  useWalletStore.setState({
    mnemonic: MNEMONIC,
    mints: [{ url: MINT_URL, keysets: [] }] as never,
  });
  useToastStore.setState({ toasts: [] });
  const database = seedRestoreDatabase(scopeId);
  for (const table of database.tables) await table.clear();
  // The app shows the dark theme here. The page background fills the viewport.
  document.documentElement.classList.add("dark");
  document.documentElement.style.background = "rgb(2 6 23)";
  document.body.style.margin = "0";
});

afterEach(async () => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  useToastStore.setState({ toasts: [] });
  await i18n.changeLanguage(language);
});

const layouts = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
] as const;

async function restoreState(state: "restoring" | "failed" | "idle"): Promise<void> {
  await seedRestoreDatabase(scopeId).states.put({
    ...initialSeedRestoreState(scopeId, MINT_URL),
    ...(state === "failed" ? { failures: 3, nextAttemptAtMs: Date.now() + 60_000 } : {}),
    ...(state === "idle" ? { initialCompletedAtMs: 1 } : {}),
  });
}

function renderInShell(children: ReactNode): void {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  root.render([
    createElement(AppShell, {
      key: "shell",
      navigationItems: [
        { label: i18n.t("nav.markets"), href: "/markets", isActive: false },
        { label: i18n.t("nav.portfolio"), href: "/portfolio", isActive: true },
      ],
      user: { name: "Anonymous", balance: 12 },
      isLoggedIn: true,
      onNavigate: () => undefined,
      children,
    }),
    createElement(ToastContainer, { key: "toasts" }),
  ]);
}

/** Captures the full page: the frame grows to the page height first. */
async function capture(
  name: string,
  locale: string,
  layout: (typeof layouts)[number],
): Promise<void> {
  await document.fonts.ready;
  await frame();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
  const height = Math.min(2400, Math.max(layout.height, document.documentElement.scrollHeight));
  await page.viewport(layout.width, height);
  await frame();
  await page.screenshot({
    path: `.vitest-attachments/seed-restore/${name}-${locale}-${layout.name}.png`,
  });
}

// The live query reads IndexedDB. A loaded parallel run needs more than the default poll bound.
const POLL = { timeout: 10_000 };

async function noticeText(testId: string): Promise<string> {
  await expect
    .poll(() => host!.querySelector(`[data-testid="${testId}"]`) !== null, POLL)
    .toBe(true);
  return host!.querySelector(`[data-testid="${testId}"]`)!.textContent ?? "";
}

for (const locale of ["en", "ja"] as const) {
  for (const layout of layouts) {
    for (const state of ["restoring", "failed"] as const) {
      it(`shows the ${state} Portfolio page in ${locale} on ${layout.name}`, async () => {
        await page.viewport(layout.width, layout.height);
        await i18n.changeLanguage(locale);
        await restoreState(state);

        renderInShell(createElement(Portfolio, portfolio));

        const testId = state === "failed" ? "seed-restore-error" : "seed-restore-status";
        expect(await noticeText(testId)).toContain(
          i18n.t(
            state === "failed"
              ? "portfolio.restorePositionsFailed"
              : "portfolio.restoringPositions",
          ),
        );
        // No empty-list text and no zero counts while the restore runs or failed.
        expect(host!.textContent).not.toContain(i18n.t("portfolio.noActivePositions"));
        expect(host!.textContent).not.toContain("(0)");
        await capture(`portfolio-${state}`, locale, layout);
      });
    }

    it(`shows the Sell tab during the restore in ${locale} on ${layout.name}`, async () => {
      await page.viewport(layout.width, layout.height);
      await i18n.changeLanguage(locale);
      await restoreState("restoring");

      renderInShell(
        createElement(
          "div",
          { className: "mx-auto max-w-md p-4" },
          createElement(TradingPanel, {
            market,
            tradeSide: "Sell",
            tradeSelection: { side: "yes" },
            tradeAmount: 0,
            tradePreview: null,
            sellHoldings: { status: "ready", byOutcomeSetId: new Map() },
          }),
        ),
      );

      expect(await noticeText("seed-restore-status")).toContain(
        i18n.t("portfolio.restoringPositions"),
      );
      expect(host!.textContent).not.toContain(i18n.t("trade.sellHoldingsZero"));
      expect(host!.textContent).not.toContain(i18n.t("trade.balanceShares", { count: "0" }));
      await capture("sell-restoring", locale, layout);
    });

    it(`shows the Sell tab after a failed restore in ${locale} on ${layout.name}`, async () => {
      await page.viewport(layout.width, layout.height);
      await i18n.changeLanguage(locale);
      await restoreState("failed");

      renderInShell(
        createElement(
          "div",
          { className: "mx-auto max-w-md p-4" },
          createElement(TradingPanel, {
            market,
            tradeSide: "Sell",
            tradeSelection: { side: "yes" },
            tradeAmount: 2,
            tradePreview: null,
            sellHoldings: { status: "ready", byOutcomeSetId: new Map() },
          }),
        ),
      );

      expect(await noticeText("seed-restore-error")).toContain(
        i18n.t("portfolio.restorePositionsFailed"),
      );
      const confirm = host!.querySelector('[data-testid="trade-confirm"]')!;
      expect(confirm.textContent).toBe(i18n.t("trade.sellHoldingsUnavailable"));
      await capture("sell-failed", locale, layout);
    });

    it(`shows the used-in-another-browser toast in ${locale} on ${layout.name}`, async () => {
      await page.viewport(layout.width, layout.height);
      await i18n.changeLanguage(locale);
      await restoreState("idle");

      renderInShell(createElement(Portfolio, portfolio));
      useToastStore.getState().addToast(usedInAnotherBrowserToast());

      await expect
        .poll(
          () => document.body.textContent?.includes(i18n.t("wallet.usedInAnotherBrowser")),
          POLL,
        )
        .toBe(true);
      // The toast shows its whole text, including the action.
      const message = [...document.querySelectorAll("p")].find(
        (element) => element.textContent === i18n.t("wallet.usedInAnotherBrowser"),
      )!;
      expect(message.scrollHeight).toBeLessThanOrEqual(message.clientHeight + 1);
      await capture("used-in-another-browser", locale, layout);
    });

    it(`returns to the restoring state after Retry in ${locale} on ${layout.name}`, async () => {
      await page.viewport(layout.width, layout.height);
      await i18n.changeLanguage(locale);
      await restoreState("failed");
      renderInShell(createElement(Portfolio, portfolio));
      await noticeText("seed-restore-error");

      const retry = [...host!.querySelectorAll("button")].find(
        (button) => button.textContent === i18n.t("portfolio.restorePositionsRetry"),
      )!;
      retry.click();

      expect(await noticeText("seed-restore-status")).toContain(
        i18n.t("portfolio.restoringPositions"),
      );
      expect(host!.querySelector('[data-testid="seed-restore-error"]')).toBeNull();
      await capture("portfolio-after-retry", locale, layout);
    });
  }
}
