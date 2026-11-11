import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletRecoveryStatus } from "@bitcaster/client-sdk/walletRecoveryStatus";
import { ShellRoutes } from "../App";

// The header balance is not known while the wallet recovery checks, waits or
// failed (issue #161). It shows the unknown marker of the Portfolio totals.

const TAG = { activation: { scopeId: "scope", epoch: 1 }, mintSetTag: "[]" };

const recovery = vi.hoisted(() => ({
  status: null as unknown as WalletRecoveryStatus,
  profileExpected: true,
}));

vi.mock("@/hooks/useWalletRecoveryStatus", () => ({
  useWalletRecoveryStatus: () => recovery.status,
  useWalletProfileExpected: () => recovery.profileExpected,
}));
vi.mock("@/components/shell", async () => {
  const actual = await vi.importActual<typeof import("@/components/shell")>("@/components/shell");
  return { ...actual, DurableWalletErrors: () => null };
});
vi.mock("@/components/shell/SettlementProgress", () => ({ SettlementProgress: () => null }));
vi.mock("@/pages/MarketsPage", () => ({ MarketsPage: () => <div>Markets page</div> }));
vi.mock("@/pages/MarketDetailPage", () => ({ MarketDetailPage: () => <div>Market detail</div> }));
vi.mock("@/pages/PortfolioPage", () => ({ PortfolioPage: () => <div>Portfolio page</div> }));
vi.mock("@/pages/CreatorPage", () => ({ CreatorPage: () => <div>Creator page</div> }));
vi.mock("@/pages/SettingsPage", () => ({ SettingsPage: () => <div>Settings page</div> }));
vi.mock("@/pages/MintDetailPage", () => ({ MintDetailPage: () => <div>Mint page</div> }));
vi.mock("@/pages/UserPage", () => ({ UserPage: () => <div>User page</div> }));
vi.mock("@/stores/settings", () => {
  const state = { nostrProfile: null };
  return {
    useSettingsStore: Object.assign(
      (selector: (value: typeof state) => unknown) => selector(state),
      { getState: () => state, subscribe: () => () => {} },
    ),
  };
});
vi.mock("@/stores/wallet", () => ({
  DEFAULT_MINT_URL: "https://mint.example",
  useBalance: () => 12_345,
  useWalletStore: (selector: (state: { mnemonic: string; mints: [] }) => unknown) =>
    selector({ mnemonic: "", mints: [] }),
}));

function headerBalance(): string {
  return screen.getByTestId("user-menu-name").nextElementSibling?.textContent ?? "";
}

function mobileMenuBalance(): string {
  fireEvent.click(screen.getByRole("button", { name: "User" }));
  const name = screen.getByTestId("mobile-user-menu-name");
  return name.parentElement!.querySelector("div.font-mono")!.textContent ?? "";
}

function renderShell() {
  return render(
    <MemoryRouter initialEntries={["/markets"]}>
      <ShellRoutes canReadOrderStatus={false} nostrIdentityRestored />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  recovery.status = { kind: "completed", tag: TAG, passSeq: 1, coverage: "full" };
  recovery.profileExpected = true;
});

describe("ShellRoutes header balance", () => {
  it.each([
    ["checking", { kind: "checking", tag: TAG }],
    ["pending", { kind: "pending", tag: TAG, reason: "scan-continues", retryAtMs: null }],
    ["failed", { kind: "unavailable", tag: TAG, reason: "recovery-failed", retryable: true }],
  ] as const)("shows the unknown marker, not 0 or a partial sum, while %s", (_name, status) => {
    recovery.status = status;

    renderShell();

    expect(headerBalance()).toBe("—");
    expect(mobileMenuBalance()).toBe("—");
  });

  it("shows the balance after the recovery completed", () => {
    renderShell();

    expect(headerBalance()).toMatch(/^12\.345\s*sats$/);
    expect(mobileMenuBalance()).toMatch(/^12\.345\s*sats$/);
  });

  it("keeps the balance of a visitor without a wallet", () => {
    recovery.status = {
      kind: "unavailable",
      tag: null,
      reason: "profile-unavailable",
      retryable: false,
    };
    recovery.profileExpected = false;

    renderShell();

    expect(headerBalance()).toMatch(/^12\.345\s*sats$/);
  });
});
