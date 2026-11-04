import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { AppShell } from "../AppShell";

// Notifications own network-backed state. Keep the shell and both menus real.
vi.mock("../NotificationBell", () => ({ NotificationBell: () => null }));

const originalLanguage = i18n.language;

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage(originalLanguage);
});

const LABELS = {
  en: { login: "Log in", logout: "Log out", user: "User" },
  ja: { login: "ログイン", logout: "ログアウト", user: "ユーザー" },
} as const;

type Layout = "desktop" | "mobile";

function renderShell(isLoggedIn: boolean) {
  const onLogin = vi.fn();
  const onLogout = vi.fn();
  const onNavigate = vi.fn();
  render(
    <AppShell
      navigationItems={[]}
      user={{ name: "Alice", balance: 0 }}
      isLoggedIn={isLoggedIn}
      onLogin={onLogin}
      onLogout={onLogout}
      onNavigate={onNavigate}
    >
      <p>Market</p>
    </AppShell>,
  );
  return { onLogin, onLogout, onNavigate };
}

// Open one menu at a time, so each query reads only that menu. A string name matches exactly.
function openMenu(layout: Layout, language: keyof typeof LABELS) {
  if (layout === "desktop") fireEvent.click(screen.getByRole("button", { name: /^Alice/ }));
  else fireEvent.click(screen.getByRole("button", { name: LABELS[language].user }));
}

describe.each([
  ["desktop", "en"],
  ["mobile", "en"],
  ["desktop", "ja"],
  ["mobile", "ja"],
] as const)("%s account item (%s)", (layout, language) => {
  const labels = LABELS[language];

  it("shows log in without a Nostr identity and asks the app to log in", async () => {
    await i18n.changeLanguage(language);
    const { onLogin, onLogout, onNavigate } = renderShell(false);
    openMenu(layout, language);

    expect(screen.queryByRole("button", { name: labels.logout })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: labels.login }));

    expect(onLogin).toHaveBeenCalledOnce();
    expect(onLogout).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
    // The item closes its menu.
    expect(screen.queryByRole("button", { name: labels.login })).not.toBeInTheDocument();
  });

  it("shows log out with a Nostr identity and asks the app to log out", async () => {
    await i18n.changeLanguage(language);
    const { onLogin, onLogout, onNavigate } = renderShell(true);
    openMenu(layout, language);

    expect(screen.queryByRole("button", { name: labels.login })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: labels.logout }));

    expect(onLogout).toHaveBeenCalledOnce();
    expect(onLogin).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: labels.logout })).not.toBeInTheDocument();
  });
});
