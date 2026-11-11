import { createElement, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands, page } from "vitest/browser";
import type {
  WalletRecoveryHoldingsRead,
  WalletRecoveryStatus,
} from "@bitcaster/client-sdk/walletRecoveryStatus";
import "@/index.css";
import i18n from "@/i18n";
import { AppShell } from "@/components/shell/AppShell";
import { Portfolio } from "@/components/portfolio/Portfolio";
import { TradingPanel } from "@/components/market-detail/TradingPanel";
import { ToastContainer } from "@/components/ui/Toast";
import { formatWalletRecoveryResumeTime } from "@/components/shared/WalletRecoveryStatusRow";
import { browserWalletScopeIdFromMnemonic } from "@/lib/browserWalletProfile";
import { listenForBrowserCtfRangeRecoveryWake } from "@/lib/browserCtfRangeOrderRecoveryWake";
import { initialSeedRestoreState, seedRestoreDatabase } from "@/stores/seed-restore-db";
import { useToastStore } from "@/stores/toast";
import { usedInAnotherBrowserToast } from "@/hooks/useBrowserCtfRangeOrderRecovery";
import type { YesNoMarketDetail } from "@/types/market-detail";
import type { Fund, PortfolioHoldingsReads, PortfolioProps } from "@/types/portfolio";

declare module "vitest/browser" {
  interface BrowserCommands {
    setReducedMotion: (preference: "reduce" | "no-preference") => Promise<void>;
  }
}

// UI review evidence for the shared wallet recovery status (issue #161): the
// Portfolio page on its Positions and Funds tabs and the Sell tab, in each
// state, in EN and JA, on desktop and mobile. The status comes from a
// controlled source. The status hook has its own tests.

// Notifications own unrelated external I/O.
vi.mock("@/components/shell/NotificationBell", () => ({ NotificationBell: () => null }));

const recovery = vi.hoisted(() => {
  let status: unknown = null;
  const listeners = new Set<() => void>();
  return {
    get: () => status,
    set(next: unknown) {
      status = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});

vi.mock("@/hooks/useWalletRecoveryStatus", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useWalletRecoveryStatus: () =>
      useSyncExternalStore(recovery.subscribe, recovery.get, recovery.get),
    useWalletProfileExpected: () => true,
  };
});

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const MINT_URL = "https://mint.example";
const scopeId = browserWalletScopeIdFromMnemonic(MNEMONIC)!;
const TAG = { activation: { scopeId, epoch: 1 }, mintSetTag: JSON.stringify([MINT_URL]) };
const language = i18n.language;
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const ARTIFACTS = ".vitest-attachments/wallet-recovery";
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let observer: MutationObserver | undefined;

const STATUSES = {
  checking: { kind: "checking", tag: TAG },
  restoring: { kind: "pending", tag: TAG, reason: "scan-continues", retryAtMs: null },
  "waiting-for-mint": { kind: "pending", tag: TAG, reason: "proof-pending", retryAtMs: null },
  "resumes-at": {
    kind: "pending",
    tag: TAG,
    reason: "start-limit",
    retryAtMs: new Date(2026, 10, 11, 14, 5).getTime(),
  },
  failed: { kind: "unavailable", tag: TAG, reason: "recovery-failed", retryable: true },
  "read-failed": { kind: "unavailable", tag: TAG, reason: "read-failed", retryable: true },
  "profile-unavailable": {
    kind: "unavailable",
    tag: null,
    reason: "profile-unavailable",
    retryable: false,
  },
  complete: { kind: "completed", tag: TAG, passSeq: 1, coverage: "full" },
} as const satisfies Record<string, WalletRecoveryStatus>;
type StateName = keyof typeof STATUSES;
const DATA_STATE: Record<StateName, string> = {
  checking: "checking",
  restoring: "pending",
  "waiting-for-mint": "pending",
  "resumes-at": "pending",
  failed: "unavailable",
  "read-failed": "unavailable",
  "profile-unavailable": "unavailable",
  complete: "complete",
};

function okRead<T>(value: readonly T[]): WalletRecoveryHoldingsRead<T> {
  return { kind: "ok", tag: TAG, afterPassSeq: 1, value };
}

const fund: Fund = {
  id: `${MINT_URL}:msat:sat`,
  unit: "sats",
  amount: 12_345,
  mintUrl: MINT_URL,
};
const emptyReads: PortfolioHoldingsReads = { funds: okRead([]), positions: okRead([]) };

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

function portfolio(overrides: Partial<PortfolioProps> = {}): PortfolioProps {
  return {
    walletState: "ready",
    baseCurrency: "BTC",
    selectedTimeRange: "ALL",
    profile: { displayName: "Anonymous", avatarUrl: null, bio: "" },
    plChartData: { "1D": [], "1W": [], "1M": [], ALL: [] },
    stats: {
      positionsValueSats: 0,
      totalValueSats: 0,
      positionsValueKnown: true,
      totalValueKnown: true,
      predictionsCount: 0,
    },
    positions: [],
    activity: [],
    funds: [],
    holdings: emptyReads,
    createdMarkets: [],
    positionsTab: "active",
    ...overrides,
  };
}

beforeEach(async () => {
  recovery.set(STATUSES.checking);
  useToastStore.setState({ toasts: [] });
  const database = seedRestoreDatabase(scopeId);
  for (const table of database.tables) await table.clear();
  // The app shows the dark theme here. The page background fills the viewport.
  document.documentElement.classList.add("dark");
  document.documentElement.style.background = "rgb(2 6 23)";
  document.body.style.margin = "0";
});

afterEach(async () => {
  observer?.disconnect();
  observer = undefined;
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  useToastStore.setState({ toasts: [] });
  await commands.setReducedMotion("no-preference");
  await i18n.changeLanguage(language);
});

const layouts = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
] as const;

function shell(children: ReactNode): ReactNode[] {
  return [
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
  ];
}

function renderInShell(children: ReactNode): void {
  host ??= document.body.appendChild(document.createElement("div"));
  root ??= createRoot(host);
  const current = root;
  flushSync(() => current.render(shell(children)));
}

function sellPanel(): ReactNode {
  return createElement(
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
  );
}

/** Captures the full page: the frame grows to the page height first. */
async function capture(name: string, layout: (typeof layouts)[number]): Promise<void> {
  await document.fonts.ready;
  await frame();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
  const height = Math.min(2400, Math.max(layout.height, document.documentElement.scrollHeight));
  await page.viewport(layout.width, height);
  await frame();
  await page.screenshot({ path: `${ARTIFACTS}/${name}-${i18n.language}-${layout.name}.png` });
}

function statusRow(): HTMLElement {
  return host!.querySelector<HTMLElement>('[data-testid="wallet-recovery-status"]')!;
}

function tab(name: "positions" | "funds"): HTMLButtonElement {
  return [...host!.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (button) => button.textContent === i18n.t(`portfolio.${name}`),
  )!;
}

function rowText(state: StateName): string {
  switch (state) {
    case "checking":
      return i18n.t("wallet.recovery.checking");
    case "restoring":
      return i18n.t("wallet.recovery.restoring");
    case "waiting-for-mint":
      return i18n.t("wallet.recovery.waitingForMint");
    case "resumes-at":
      return i18n.t("wallet.recovery.resumesAt", {
        // The formatter has its own tests with a fixed clock.
        time: formatWalletRecoveryResumeTime(
          STATUSES["resumes-at"].retryAtMs,
          Date.now(),
          i18n.language,
        ),
      });
    case "failed":
      return i18n.t("wallet.recovery.failed");
    case "read-failed":
      return i18n.t("wallet.recovery.readFailed");
    case "profile-unavailable":
      return i18n.t("wallet.recovery.profileUnavailable");
    case "complete":
      return "";
  }
}

/** Starts to record every text that the page shows, so a brief empty state is seen too. */
function recordTexts(): string[] {
  const seen: string[] = [host!.textContent ?? ""];
  observer = new MutationObserver(() => seen.push(host!.textContent ?? ""));
  observer.observe(host!, { subtree: true, childList: true, characterData: true });
  return seen;
}

for (const locale of ["en", "ja"] as const) {
  for (const layout of layouts) {
    for (const state of Object.keys(STATUSES) as StateName[]) {
      for (const mainTab of ["positions", "funds"] as const) {
        it(`shows the ${state} row on the ${mainTab} tab in ${locale} on ${layout.name}`, async () => {
          await page.viewport(layout.width, layout.height);
          await i18n.changeLanguage(locale);
          recovery.set(STATUSES[state]);

          renderInShell(createElement(Portfolio, portfolio()));
          if (mainTab === "funds") flushSync(() => tab("funds").click());

          const row = statusRow();
          expect(row.dataset.state).toBe(DATA_STATE[state]);
          expect(row.textContent).toContain(rowText(state));
          const empty = i18n.t(
            mainTab === "funds" ? "portfolio.noFunds" : "portfolio.noActivePositions",
          );
          if (state === "complete") {
            expect(row.hidden).toBe(true);
            expect(host!.textContent).toContain(empty);
          } else {
            expect(row.hidden).toBe(false);
            // No empty-list text and no zero counts until the recovery completes.
            expect(host!.textContent).not.toContain(empty);
            expect(host!.textContent).not.toContain("(0)");
          }
          await capture(`portfolio-${mainTab}-${state}`, layout);
        });
      }
    }

    for (const state of ["checking", "restoring", "failed", "complete"] as const) {
      it(`shows the ${state} row on the Sell tab in ${locale} on ${layout.name}`, async () => {
        await page.viewport(layout.width, layout.height);
        await i18n.changeLanguage(locale);
        recovery.set(STATUSES[state]);

        renderInShell(sellPanel());

        expect(statusRow().dataset.state).toBe(DATA_STATE[state]);
        expect(statusRow().textContent).toContain(rowText(state));
        if (state === "complete") {
          expect(host!.textContent).toContain(i18n.t("trade.sellHoldingsZero"));
        } else {
          expect(host!.textContent).not.toContain(i18n.t("trade.sellHoldingsZero"));
        }
        await capture(`sell-${state}`, layout);
      });
    }

    it(`retries a failed recovery in ${locale} on ${layout.name}`, async () => {
      await page.viewport(layout.width, layout.height);
      await i18n.changeLanguage(locale);
      await seedRestoreDatabase(scopeId).states.put({
        ...initialSeedRestoreState(scopeId, MINT_URL),
        failures: 3,
        nextAttemptAtMs: Date.now() + 60_000,
      });
      recovery.set(STATUSES.failed);
      let woken!: () => void;
      const wake = new Promise<void>((resolve) => (woken = resolve));
      const stopListening = listenForBrowserCtfRangeRecoveryWake(scopeId, () => woken());
      try {
        renderInShell(createElement(Portfolio, portfolio()));
        await capture("portfolio-before-retry", layout);

        const retry = [...statusRow().querySelectorAll("button")].find(
          (button) => button.textContent === i18n.t("common.retry"),
        )!;
        retry.click();

        // Retry resets the backoff, then wakes the coordinator.
        await wake;
        const state = await seedRestoreDatabase(scopeId).states.get([scopeId, MINT_URL]);
        expect(state).toMatchObject({ failures: 0, nextAttemptAtMs: 0 });
      } finally {
        stopListening();
      }
    });

    it(`goes from an empty read to a balance without "No funds" in ${locale} on ${layout.name}`, async () => {
      await page.viewport(layout.width, layout.height);
      await i18n.changeLanguage(locale);
      renderInShell(
        createElement(
          Portfolio,
          portfolio({ holdings: { ...emptyReads, funds: { kind: "unhydrated" } } }),
        ),
      );
      flushSync(() => tab("funds").click());
      const seen = recordTexts();

      // An empty read arrives while the recovery checks, then the restored balance.
      renderInShell(createElement(Portfolio, portfolio()));
      await frame();
      recovery.set(STATUSES.complete);
      renderInShell(
        createElement(
          Portfolio,
          portfolio({ funds: [fund], holdings: { ...emptyReads, funds: okRead([fund]) } }),
        ),
      );
      await frame();

      expect(host!.querySelector('[data-amount-subunits="12345"]')).not.toBeNull();
      expect(seen.some((text) => text.includes(i18n.t("portfolio.noFunds")))).toBe(false);
      await capture("funds-balance-after-recovery", layout);
    });

    it(`goes from pending to settled in ${locale} on ${layout.name}`, async () => {
      await page.viewport(layout.width, layout.height);
      await i18n.changeLanguage(locale);
      recovery.set(STATUSES.restoring);
      renderInShell(createElement(Portfolio, portfolio()));
      expect(statusRow().dataset.state).toBe("pending");
      expect(host!.textContent).not.toContain(i18n.t("portfolio.noActivePositions"));

      recovery.set(STATUSES.complete);
      await frame();

      expect(statusRow().dataset.state).toBe("complete");
      expect(statusRow().hidden).toBe(true);
      expect(host!.textContent).toContain(i18n.t("portfolio.noActivePositions"));
      expect(tab("positions").textContent).toBe(i18n.t("portfolio.positions"));
    });

    it(`keeps a known balance visible while checking in ${locale} on ${layout.name}`, async () => {
      await page.viewport(layout.width, layout.height);
      await i18n.changeLanguage(locale);
      recovery.set(STATUSES.checking);
      renderInShell(
        createElement(
          Portfolio,
          portfolio({ funds: [fund], holdings: { ...emptyReads, funds: okRead([fund]) } }),
        ),
      );
      flushSync(() => tab("funds").click());

      const amount = host!.querySelector<HTMLElement>('[data-testid="fund-amount"]')!;
      expect(amount.textContent).toContain("12.345");
      expect(amount.getAttribute("aria-busy")).toBeNull();
      await capture("funds-known-while-checking", layout);
    });

    it(`mutes projected amounts while checking, then fades in ${locale} on ${layout.name}`, async () => {
      await page.viewport(layout.width, layout.height);
      await i18n.changeLanguage(locale);
      recovery.set(STATUSES.checking);
      const projected = () =>
        createElement(
          Portfolio,
          portfolio({ funds: [fund], holdings: { ...emptyReads, funds: { kind: "unhydrated" } } }),
        );
      renderInShell(projected());
      flushSync(() => tab("funds").click());

      const amount = host!.querySelector<HTMLElement>('[data-testid="fund-amount"]')!;
      const mutedColor = getComputedStyle(amount).color;
      expect(amount.getAttribute("aria-busy")).toBe("true");
      expect(getComputedStyle(amount).animationName).toBe("none");
      await capture("funds-projected-while-checking", layout);

      renderInShell(
        createElement(
          Portfolio,
          portfolio({ funds: [fund], holdings: { ...emptyReads, funds: okRead([fund]) } }),
        ),
      );
      const real = host!.querySelector<HTMLElement>('[data-testid="fund-amount"]')!;
      expect(real).toBe(amount);
      expect(real.getAttribute("aria-busy")).toBeNull();
      const style = getComputedStyle(real);
      expect(style.transitionProperty).toContain("color");
      expect(Number.parseFloat(style.transitionDuration)).toBeGreaterThan(0);
      await new Promise<void>((resolve) => {
        real.addEventListener("transitionend", () => resolve(), { once: true });
      });
      expect(getComputedStyle(real).color).not.toBe(mutedColor);
    });

    it(`does not animate projected amounts with reduced motion in ${locale} on ${layout.name}`, async () => {
      await commands.setReducedMotion("reduce");
      await page.viewport(layout.width, layout.height);
      await i18n.changeLanguage(locale);
      recovery.set(STATUSES.checking);
      renderInShell(
        createElement(
          Portfolio,
          portfolio({ funds: [fund], holdings: { ...emptyReads, funds: { kind: "unhydrated" } } }),
        ),
      );
      flushSync(() => tab("funds").click());
      const amount = host!.querySelector<HTMLElement>('[data-testid="fund-amount"]')!;
      const mutedColor = getComputedStyle(amount).color;

      renderInShell(
        createElement(
          Portfolio,
          portfolio({ funds: [fund], holdings: { ...emptyReads, funds: okRead([fund]) } }),
        ),
      );

      const style = getComputedStyle(amount);
      expect(
        Number.parseFloat(style.transitionDuration) === 0 || style.transitionProperty === "none",
      ).toBe(true);
      // The normal style applies at once.
      expect(style.color).not.toBe(mutedColor);
    });

    it(`shows the used-in-another-browser toast in ${locale} on ${layout.name}`, async () => {
      await page.viewport(layout.width, layout.height);
      await i18n.changeLanguage(locale);
      recovery.set(STATUSES.complete);

      renderInShell(createElement(Portfolio, portfolio()));
      useToastStore.getState().addToast(usedInAnotherBrowserToast());

      await expect
        .poll(() => document.body.textContent?.includes(i18n.t("wallet.usedInAnotherBrowser")))
        .toBe(true);
      // The toast shows its whole text, including the action.
      const message = [...document.querySelectorAll("p")].find(
        (element) => element.textContent === i18n.t("wallet.usedInAnotherBrowser"),
      )!;
      expect(message.scrollHeight).toBeLessThanOrEqual(message.clientHeight + 1);
      await capture("used-in-another-browser", layout);
    });
  }
}
