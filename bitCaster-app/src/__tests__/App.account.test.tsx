import "fake-indexeddb/auto";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { nip19 } from "nostr-tools";
import { generateSecretKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useSettingsStore, type NostrIdentityState } from "@/stores/settings";
import { useWalletStore } from "@/stores/wallet";
import { ShellRoutes } from "../App";

vi.mock("@/components/shell", async () => {
  const actual = await vi.importActual<typeof import("@/components/shell")>("@/components/shell");
  return { ...actual, DurableWalletErrors: () => null };
});
vi.mock("@/components/shell/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("@/components/shell/SettlementProgress", () => ({ SettlementProgress: () => null }));
vi.mock("@/pages/MarketsPage", () => ({ MarketsPage: () => <div>Markets page</div> }));
vi.mock("@/pages/MarketDetailPage", () => ({ MarketDetailPage: () => null }));
vi.mock("@/pages/PortfolioPage", () => ({ PortfolioPage: () => null }));
vi.mock("@/pages/CreatorPage", () => ({ CreatorPage: () => null }));
vi.mock("@/pages/MintDetailPage", () => ({ MintDetailPage: () => null }));
vi.mock("@/pages/UserPage", () => ({ UserPage: () => null }));
vi.mock("@/pages/SettingsPage", () => ({
  SettingsPage: () => {
    const location = useLocation();
    return <div data-testid="settings-route">{location.pathname + location.search}</div>;
  },
}));
vi.mock("@/stores/wallet", async () => {
  const actual = await vi.importActual<typeof import("@/stores/wallet")>("@/stores/wallet");
  // The balance reads browser proof storage. Logout must not touch the wallet store.
  return { ...actual, useBalance: () => 0 };
});

const WALLET_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const LOGGED_OUT: NostrIdentityState = {
  nostrSignerMode: "none",
  signerSource: "none",
  signerBackupState: "none",
  nsecSecret: null,
};

type Layout = "desktop" | "mobile";

function setIdentity(identity: NostrIdentityState) {
  useSettingsStore.setState({
    ...identity,
    signerConnectionStatus: identity.nostrSignerMode === "none" ? "disconnected" : "connected",
    nostrProfile: null,
    nostrProfileFetchStatus: "idle",
  });
}

// Compare the key by identity, so a failure message does not print it.
function expectIdentity(expected: NostrIdentityState) {
  const state = useSettingsStore.getState();
  expect({
    nostrSignerMode: state.nostrSignerMode,
    signerSource: state.signerSource,
    signerBackupState: state.signerBackupState,
  }).toEqual({
    nostrSignerMode: expected.nostrSignerMode,
    signerSource: expected.signerSource,
    signerBackupState: expected.signerBackupState,
  });
  expect(state.nsecSecret === expected.nsecSecret).toBe(true);
}

function renderShell() {
  return render(
    <MemoryRouter initialEntries={["/markets"]}>
      <ShellRoutes canReadOrderStatus={false} />
    </MemoryRouter>,
  );
}

function openMenu(layout: Layout) {
  if (layout === "desktop") fireEvent.click(screen.getByRole("button", { name: /^Anon/ }));
  else fireEvent.click(screen.getByRole("button", { name: "User" }));
}

function clickAccountItem(layout: Layout, name: "Log in" | "Log out") {
  openMenu(layout);
  fireEvent.click(screen.getByRole("button", { name }));
}

const unbackedLocalKey = (): NostrIdentityState => ({
  nostrSignerMode: "nsec",
  signerSource: "implicit-generated",
  signerBackupState: "needs_backup",
  nsecSecret: nip19.nsecEncode(generateSecretKey()),
});

beforeEach(async () => {
  window.localStorage.clear();
  await i18n.changeLanguage("en");
  setIdentity(LOGGED_OUT);
  useWalletStore.setState({ mnemonic: WALLET_MNEMONIC, walletBackupState: "confirmed" });
});

afterEach(() => {
  cleanup();
  act(() => {
    setIdentity(LOGGED_OUT);
    useWalletStore.setState({ mnemonic: "", walletBackupState: "none" });
  });
  window.localStorage.clear();
});

describe.each(["desktop", "mobile"] as const)("ShellRoutes %s account item", (layout) => {
  it("opens the Nostr settings section when no Nostr identity is set", () => {
    renderShell();

    clickAccountItem(layout, "Log in");

    expect(screen.getByTestId("settings-route")).toHaveTextContent(/^\/settings\?category=nostr$/);
    expectIdentity(LOGGED_OUT);
  });

  it.each<[string, NostrIdentityState]>([
    [
      "an extension signer",
      {
        nostrSignerMode: "nip07",
        signerSource: "nip07",
        signerBackupState: "confirmed",
        nsecSecret: null,
      },
    ],
    [
      "an imported private key",
      {
        nostrSignerMode: "nsec",
        signerSource: "user-nsec",
        signerBackupState: "confirmed",
        nsecSecret: nip19.nsecEncode(generateSecretKey()),
      },
    ],
    [
      "a backed-up local key",
      {
        nostrSignerMode: "nsec",
        signerSource: "implicit-generated",
        signerBackupState: "confirmed",
        nsecSecret: nip19.nsecEncode(generateSecretKey()),
      },
    ],
  ])("logs out of %s at once and keeps the wallet", (_name, identity) => {
    setIdentity(identity);
    renderShell();

    clickAccountItem(layout, "Log out");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expectIdentity(LOGGED_OUT);
    expect(useWalletStore.getState().mnemonic).toBe(WALLET_MNEMONIC);
    // The menu now offers log in.
    openMenu(layout);
    expect(screen.getByRole("button", { name: "Log in" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Log out" })).not.toBeInTheDocument();
  });

  it("asks before it deletes a local key that has no backup", () => {
    const identity = unbackedLocalKey();
    setIdentity(identity);
    renderShell();

    clickAccountItem(layout, "Log out");
    const dialog = screen.getByRole("dialog", { name: "Your Nostr key is not backed up" });
    expectIdentity(identity);

    // Close keeps the key.
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expectIdentity(identity);

    // Back up opens the Nostr settings section and keeps the key.
    clickAccountItem(layout, "Log out");
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Your Nostr key is not backed up" })).getByRole(
        "button",
        { name: "Back up key" },
      ),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("settings-route")).toHaveTextContent(/^\/settings\?category=nostr$/);
    expectIdentity(identity);

    // Log out in the dialog deletes the key and keeps the wallet.
    clickAccountItem(layout, "Log out");
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Your Nostr key is not backed up" })).getByRole(
        "button",
        { name: "Log out" },
      ),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expectIdentity(LOGGED_OUT);
    expect(useWalletStore.getState().mnemonic).toBe(WALLET_MNEMONIC);
  });
});

describe("ShellRoutes logout persistence", () => {
  it("keeps the logout after the settings store reloads from storage", async () => {
    setIdentity({
      nostrSignerMode: "nsec",
      signerSource: "user-nsec",
      signerBackupState: "confirmed",
      nsecSecret: nip19.nsecEncode(generateSecretKey()),
    });
    renderShell();

    clickAccountItem("desktop", "Log out");
    const persisted = window.localStorage.getItem("bitcaster-settings");
    expect(persisted).not.toBeNull();

    // Model a reload: replace the memory state, then read the stored state.
    act(() => setIdentity(unbackedLocalKey()));
    window.localStorage.setItem("bitcaster-settings", persisted ?? "");
    await act(async () => {
      await useSettingsStore.persist.rehydrate();
    });

    expectIdentity(LOGGED_OUT);
    openMenu("desktop");
    expect(screen.getByRole("button", { name: "Log in" })).toBeInTheDocument();
  });
});

describe("ShellRoutes account item in Japanese", () => {
  it("names the confirmation and its actions in Japanese", async () => {
    await i18n.changeLanguage("ja");
    setIdentity(unbackedLocalKey());
    renderShell();

    fireEvent.click(screen.getByRole("button", { name: "ユーザー" }));
    fireEvent.click(screen.getByRole("button", { name: "ログアウト" }));

    const dialog = screen.getByRole("dialog", { name: "Nostr鍵のバックアップがありません" });
    expect(within(dialog).getByRole("button", { name: "鍵をバックアップ" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "ログアウト" })).toBeInTheDocument();
  });
});
