import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { Position } from "@/types/portfolio";

const COND = "d".repeat(64);
const controlled = vi.hoisted(() => ({ positions: [] as Position[] }));

vi.mock("../usePortfolioState", async () => {
  const { useState } = await import("react");
  return {
    usePortfolioState: () => {
      const [positionsTab, setPositionsTab] = useState<"active" | "closed">("active");
      return {
        walletState: "ready",
        baseCurrency: "BTC",
        selectedTimeRange: "ALL",
        profile: { displayName: "Deep link wallet", avatarUrl: null, bio: "" },
        plChartData: { "1D": [], "1W": [], "1M": [], ALL: [] },
        stats: { positionsValueSats: 0, totalValueSats: 0, predictionsCount: 0 },
        positions: controlled.positions,
        funds: [],
        activity: [],
        createdMarkets: [],
        positionsTab,
        setPositionsTab,
      };
    },
  };
});
vi.mock("@/hooks/useLikedMarkets", () => ({
  useLikedMarkets: () => ({ markets: [], loading: false, error: null }),
}));
vi.mock("@/stores/settings", () => {
  const state = {
    nostrSignerMode: "none",
    nsecSecret: null,
    nostrProfile: null,
    signerConnectionStatus: "disconnected",
    nostrProfileFetchStatus: "idle",
    relays: [],
  };
  return {
    useSettingsStore: Object.assign((selector: (state: unknown) => unknown) => selector(state), {
      getState: () => state,
      subscribe: () => () => {},
    }),
  };
});
vi.mock("@/stores/activity-log", () => ({
  useActivityLogStore: (selector: (state: unknown) => unknown) =>
    selector({ addActivity: vi.fn() }),
}));
vi.mock("@/stores/wallet", () => ({
  useWalletStore: {
    subscribe: () => () => {},
    getState: () => ({ mnemonic: null }),
  },
}));
vi.mock("@/lib/browserWalletProfile", () => ({
  activeBrowserWalletScopeId: () => "deep-link-wallet",
  browserWalletIdFromMnemonic: vi.fn(),
  isActiveBrowserWalletId: vi.fn(),
}));
vi.mock("@/lib/identityOps", () => ({ createImplicitWalletAndNostrIdentity: vi.fn() }));
vi.mock("@/lib/browserPortfolioClaim", () => ({ claimPortfolioPosition: vi.fn() }));
vi.mock("@/lib/browserPortfolioRemove", () => ({ removePortfolioPosition: vi.fn() }));
vi.mock("@/components/deposit-withdraw/DepositWithdrawOverlay", () => ({
  DepositWithdrawOverlay: () => null,
}));
vi.mock("@/components/shared/WalletSetupModal", () => ({ WalletSetupModal: () => null }));

import { PortfolioPage } from "../PortfolioPage";

function position(outcome: string, status: Position["status"], title: string): Position {
  return {
    id: JSON.stringify(["https://mint.example", COND, outcome, "sat"]),
    marketId: `${COND}-${outcome}`,
    marketTitle: title,
    marketImageUrl: "",
    side: "Outcome",
    outcomeId: outcome,
    outcomeLabel: outcome,
    baseAsset: "sat",
    currentValueSats: 0,
    valueKnown: status === "closed",
    status,
    isWinner: status === "closed" && outcome === "YES",
    isLoser: status === "closed" && outcome !== "YES",
    isPending: false,
    acquiredDate: "2026-10-01T00:00:00.000Z",
    mintUrl: "https://mint.example",
  };
}

const deepLink = `/portfolio?tab=closed&position=${encodeURIComponent(`${COND}-YES`)}`;

function NavigateButton() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(deepLink)}>
      Open won position
    </button>
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/portfolio"
          element={
            <>
              <NavigateButton />
              <PortfolioPage />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

const scrollIntoView = vi.fn();

beforeEach(async () => {
  await i18n.changeLanguage("en");
  scrollIntoView.mockClear();
  Element.prototype.scrollIntoView = scrollIntoView;
  controlled.positions = [
    position("NO", "active", "Open market"),
    position("Other", "closed", "Other closed market"),
    position("YES", "closed", "Won market"),
  ];
});

afterEach(() => {
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

function wonRow(): HTMLElement {
  return screen.getByText("Won market").closest<HTMLElement>("[role='button']")!;
}

describe("Portfolio position deep link", () => {
  it("opens the closed tab, scrolls to the position, and focuses it", () => {
    renderAt(deepLink);

    expect(screen.getByRole("tab", { name: /Closed/ })).toHaveAttribute("aria-selected", "true");
    expect(wonRow().id).toBe(`position-${encodeURIComponent(`${COND}-YES`)}`);
    expect(wonRow()).toHaveFocus();
    expect(scrollIntoView.mock.contexts).toEqual([wonRow()]);
  });

  it("focuses the position when it loads after the first render", () => {
    controlled.positions = [];
    const view = renderAt(deepLink);
    expect(scrollIntoView).not.toHaveBeenCalled();

    controlled.positions = [position("YES", "closed", "Won market")];
    view.rerender(
      <MemoryRouter initialEntries={[deepLink]}>
        <Routes>
          <Route
            path="/portfolio"
            element={
              <>
                <NavigateButton />
                <PortfolioPage />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(wonRow()).toHaveFocus();
    expect(scrollIntoView).toHaveBeenCalledOnce();
  });

  it("returns to the positions tab when the link opens on another Portfolio tab", async () => {
    const user = userEvent.setup();
    renderAt("/portfolio");
    await user.click(screen.getByRole("tab", { name: "Funds" }));
    expect(screen.queryByText("Won market")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open won position" }));

    expect(screen.getByRole("tab", { name: "Positions" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /Closed/ })).toHaveAttribute("aria-selected", "true");
    expect(wonRow()).toHaveFocus();
  });

  it("does not scroll to the position again after a main-tab switch", async () => {
    const user = userEvent.setup();
    renderAt(deepLink);
    expect(wonRow()).toHaveFocus();
    expect(scrollIntoView).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("tab", { name: "Funds" }));
    await user.click(screen.getByRole("tab", { name: "Positions" }));

    expect(screen.getByText("Won market")).toBeInTheDocument();
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(wonRow()).not.toHaveFocus();

    // A new navigation to the same link is a new request.
    await user.click(screen.getByRole("button", { name: "Open won position" }));
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(wonRow()).toHaveFocus();
  });

  it("keeps the active tab and does not scroll without a query", () => {
    renderAt("/portfolio");

    expect(screen.getByRole("tab", { name: /Active/ })).toHaveAttribute("aria-selected", "true");
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
