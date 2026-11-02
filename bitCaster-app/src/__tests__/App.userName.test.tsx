import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { ShellRoutes } from "../App";

const settingsState = vi.hoisted(() => ({
  nostrProfile: null as null | { displayName: string; avatar: string },
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
vi.mock("@/stores/settings", () => ({
  useSettingsStore: Object.assign(
    (selector: (value: typeof settingsState) => unknown) => selector(settingsState),
    { getState: () => settingsState, subscribe: () => () => {} },
  ),
}));
vi.mock("@/stores/wallet", () => ({
  DEFAULT_MINT_URL: "https://mint.example",
  useBalance: () => 0,
  useWalletStore: (selector: (state: { mnemonic: string; mints: [] }) => unknown) =>
    selector({ mnemonic: "", mints: [] }),
}));

// U+202E reverses the following text when a browser displays it.
const RLO = "\u202E";
const LONG_NAME = `Release Three Oracle ${RLO}ruoivaheB evil ${"x".repeat(90)}`;

function renderShell() {
  return render(
    <MemoryRouter initialEntries={["/markets"]}>
      <ShellRoutes canReadOrderStatus={false} />
    </MemoryRouter>,
  );
}

afterEach(() => {
  settingsState.nostrProfile = null;
});

describe("ShellRoutes own profile name", () => {
  it("shows the own kind 0 name without bidi controls, bounded, and truncated in the header", () => {
    settingsState.nostrProfile = { displayName: LONG_NAME, avatar: "" };
    renderShell();

    const name = screen.getByTestId("user-menu-name");
    expect(name.textContent).not.toContain(RLO);
    expect(name.textContent).toMatch(/^Release Three Oracle ruoivaheB evil x+…$/);
    expect(Array.from(name.textContent ?? "")).toHaveLength(101);
    expect(name).toHaveClass("truncate");
    expect(name.className).toMatch(/\bmax-w-/);

    fireEvent.click(screen.getByRole("button", { name: "User" }));
    const overlayName = screen.getByTestId("mobile-user-menu-name");
    expect(overlayName).toHaveTextContent(name.textContent ?? "");
    expect(overlayName).toHaveClass("truncate");
  });

  it("falls back to Anon when the name has no visible character", () => {
    settingsState.nostrProfile = { displayName: `${RLO}\u200B `, avatar: "" };
    renderShell();

    expect(screen.getByTestId("user-menu-name")).toHaveTextContent(/^Anon$/);
  });

  it("names the anonymous fallback in Japanese", async () => {
    await i18n.changeLanguage("ja");
    try {
      renderShell();
      expect(screen.getByTestId("user-menu-name")).toHaveTextContent(/^匿名$/);
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it.each([
    ["javascript:alert(1)", false],
    ["http://img.example/me.png", false],
    ["https://img.example/me.png", true],
  ])("loads the own avatar %s only from a public https host", (avatar, loaded) => {
    settingsState.nostrProfile = { displayName: "Me", avatar };
    const { container } = renderShell();

    const images = Array.from(container.querySelectorAll("img")).map((image) =>
      image.getAttribute("src"),
    );
    if (loaded) expect(images).toContain("https://img.example/me.png");
    else expect(images).not.toContain(avatar);
  });
});
