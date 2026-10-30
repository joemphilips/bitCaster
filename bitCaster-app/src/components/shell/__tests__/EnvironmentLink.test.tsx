import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { AppShell } from "../AppShell";

// Notifications own network-backed state. Keep the shell and both menus real.
vi.mock("../NotificationBell", () => ({ NotificationBell: () => null }));

const originalLanguage = i18n.language;
const originalUrl = window.location.href;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  window.history.replaceState(
    {},
    "",
    "/markets/private-route?environment=testnet&token=secret#backup",
  );
});

afterEach(async () => {
  cleanup();
  vi.unstubAllEnvs();
  window.history.replaceState({}, "", originalUrl);
  await i18n.changeLanguage(originalLanguage);
});

function openMenus() {
  const onNavigate = vi.fn();
  const onLogout = vi.fn();
  const { container } = render(
    <AppShell
      navigationItems={[]}
      user={{ name: "Alice", balance: 0 }}
      onNavigate={onNavigate}
      onLogout={onLogout}
    >
      <p>Market</p>
    </AppShell>,
  );
  // Prevent jsdom navigation without changing the anchor or its menu handler.
  container.addEventListener("click", (event) => event.preventDefault(), { capture: true });
  fireEvent.click(screen.getByRole("button", { name: /^Alice/ }));
  fireEvent.click(screen.getByRole("button", { name: i18n.t("nav.user") }));
  return { onNavigate, onLogout };
}

describe("environment links in desktop and mobile menus", () => {
  it.each([
    ["en", "mainnet", "https://testnet.example", "Go to testnet"],
    ["en", "testnet", "https://mainnet.example", "Go to mainnet"],
    ["ja", "mainnet", "https://testnet.example", "テストネットへ"],
    ["ja", "testnet", "https://mainnet.example", "メインネットへ"],
  ])("uses explicit %s/%s settings in both menus", async (language, environment, origin, label) => {
    await i18n.changeLanguage(language);
    vi.stubEnv("VITE_BITCASTER_ENVIRONMENT", environment);
    vi.stubEnv("VITE_ALTERNATE_ORIGIN", origin);
    const { onNavigate, onLogout } = openMenus();
    const links = screen.getAllByRole("link", { name: label });
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link).toHaveAttribute("href", `${origin}/`);
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
    // Each anchor closes only its menu. Neither uses the app router or logout.
    fireEvent.click(links[0]!);
    expect(screen.getAllByRole("link", { name: label })).toHaveLength(1);
    fireEvent.click(links[1]!);
    expect(screen.queryByRole("link", { name: label })).not.toBeInTheDocument();
    expect(onNavigate).not.toHaveBeenCalled();
    expect(onLogout).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/markets/private-route");
  });

  it.each([
    ["", ""],
    ["", "https://testnet.example"],
    ["mainnet", ""],
    ["unknown", "https://testnet.example"],
    ["mainnet", "https://testnet.example/?token=secret"],
  ])("hides the link in both menus for invalid config (%s, %s)", (environment, origin) => {
    vi.stubEnv("VITE_BITCASTER_ENVIRONMENT", environment);
    vi.stubEnv("VITE_ALTERNATE_ORIGIN", origin);
    openMenus();
    expect(screen.queryByRole("link", { name: /Go to (mainnet|testnet)/ })).not.toBeInTheDocument();
  });

  it("gives both header buttons one brand name without a beta suffix", () => {
    vi.stubEnv("VITE_BITCASTER_ENVIRONMENT", "");
    vi.stubEnv("VITE_ALTERNATE_ORIGIN", "");
    openMenus();
    expect(screen.getAllByRole("button", { name: "bitCaster" })).toHaveLength(2);
    expect(screen.queryByRole("img", { name: /beta|β/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/beta|β/i)).not.toBeInTheDocument();
  });
});
