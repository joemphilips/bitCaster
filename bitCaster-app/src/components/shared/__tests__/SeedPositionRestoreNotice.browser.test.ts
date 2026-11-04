import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import "@/index.css";
import i18n from "@/i18n";
import { PositionsList } from "@/components/portfolio/PositionsList";
import { TradingPanel } from "@/components/market-detail/TradingPanel";
import { browserWalletScopeIdFromMnemonic } from "@/lib/browserWalletProfile";
import { initialSeedRestoreState, seedRestoreDatabase } from "@/stores/seed-restore-db";
import { useWalletStore } from "@/stores/wallet";
import type { YesNoMarketDetail } from "@/types/market-detail";

// UI review evidence for the automatic seed restore (ADR-039, amendment
// 2026-11-04): Portfolio positions and the Sell tab, EN and JA, desktop and mobile.

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const MINT_URL = "https://mint.example";
const scopeId = browserWalletScopeIdFromMnemonic(MNEMONIC)!;
const language = i18n.language;
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

beforeEach(async () => {
  useWalletStore.setState({
    mnemonic: MNEMONIC,
    mints: [{ url: MINT_URL, keysets: [] }] as never,
  });
  await seedRestoreDatabase(scopeId).states.clear();
});

afterEach(async () => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  await i18n.changeLanguage(language);
});

const layouts = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
] as const;

for (const locale of ["en", "ja"] as const) {
  for (const layout of layouts) {
    for (const state of ["restoring", "failed"] as const) {
      it(`shows the ${state} seed restore in ${locale} on ${layout.name}`, async () => {
        await page.viewport(layout.width, layout.height);
        await i18n.changeLanguage(locale);
        await seedRestoreDatabase(scopeId).states.put({
          ...initialSeedRestoreState(scopeId, MINT_URL),
          ...(state === "failed"
            ? { failures: 3, firstPassEndedAtMs: 1, nextAttemptAtMs: Date.now() + 60_000 }
            : {}),
        });
        host = document.createElement("div");
        host.className = "mx-auto grid max-w-6xl gap-6 p-4 md:grid-cols-[2fr_1fr]";
        document.body.append(host);
        root = createRoot(host);
        root.render([
          createElement(
            "section",
            { key: "positions", className: "rounded-xl bg-white p-4 dark:bg-slate-900" },
            createElement(PositionsList, { positions: [], positionsTab: "active" }),
          ),
          createElement(
            "section",
            { key: "trade", className: "rounded-xl bg-white p-4 dark:bg-slate-900" },
            createElement(TradingPanel, {
              market,
              tradeSide: "Sell",
              tradeSelection: { side: "yes" },
              tradeAmount: 0,
              tradePreview: null,
              sellHoldings: { status: "ready", byOutcomeSetId: new Map() } as never,
            }),
          ),
        ]);
        const testId = state === "failed" ? "seed-restore-error" : "seed-restore-status";
        const text =
          state === "failed"
            ? i18n.t("portfolio.restorePositionsFailed")
            : i18n.t("portfolio.restoringPositions");
        await expect
          .poll(() => host!.querySelectorAll(`[data-testid="${testId}"]`).length)
          .toBe(2);
        for (const notice of host.querySelectorAll(`[data-testid="${testId}"]`)) {
          expect(notice.textContent).toContain(text);
          expect(notice.getBoundingClientRect().right).toBeLessThanOrEqual(innerWidth);
        }
        if (state === "failed") {
          expect(host.textContent).toContain(i18n.t("portfolio.restorePositionsRetry"));
        }
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
        await document.fonts.ready;
        await page.screenshot({
          path: `.vitest-attachments/seed-restore/${state}-${locale}-${layout.name}.png`,
        });
      });
    }
  }
}
