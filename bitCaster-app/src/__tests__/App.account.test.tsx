import "fake-indexeddb/auto";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { nip19 } from "nostr-tools";
import { generateSecretKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { browserWalletIdFromMnemonic } from "@/lib/browserWalletProfile";
import { usePendingTradesStore } from "@/stores/pendingTrades";
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

const DIALOG = "Your Nostr key is not backed up";
const ORDERS_IN_PROGRESS = /orders are in progress/i;
const UNBACKED_KEY_TEXT =
  "Only this browser has this key. If you log out, you delete the key and lose this Nostr identity.";
const ORDERS_IN_PROGRESS_TEXT =
  "Orders are in progress. They need this key to finish. Back up the key before you log out.";

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

function shell(nostrIdentityRestored: boolean, initialEntry = "/markets") {
  return (
    <MemoryRouter initialEntries={[initialEntry]}>
      <ShellRoutes canReadOrderStatus={false} nostrIdentityRestored={nostrIdentityRestored} />
    </MemoryRouter>
  );
}

function renderShell(initialEntry = "/markets") {
  return render(shell(true, initialEntry));
}

// The control that opens the account menu in each layout.
function menuControl(layout: Layout): HTMLElement {
  return layout === "desktop"
    ? screen.getByRole("button", { name: /^Anon/ })
    : screen.getByRole("button", { name: "User" });
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

const BACKED_UP_IDENTITIES: [string, () => NostrIdentityState][] = [
  [
    "an extension signer",
    () => ({
      nostrSignerMode: "nip07",
      signerSource: "nip07",
      signerBackupState: "confirmed",
      nsecSecret: null,
    }),
  ],
  [
    "an imported private key",
    () => ({
      nostrSignerMode: "nsec",
      signerSource: "user-nsec",
      signerBackupState: "confirmed",
      nsecSecret: nip19.nsecEncode(generateSecretKey()),
    }),
  ],
  [
    "a backed-up local key",
    () => ({
      nostrSignerMode: "nsec",
      signerSource: "implicit-generated",
      signerBackupState: "confirmed",
      nsecSecret: nip19.nsecEncode(generateSecretKey()),
    }),
  ],
];

// The settlement lifecycle keeps a submitted order here until it is terminal.
function addPendingOrder() {
  act(() =>
    usePendingTradesStore.getState().add({
      orderId: "order-1",
      walletId: browserWalletIdFromMnemonic(WALLET_MNEMONIC)!,
      marketId: "condition-a-YES",
      submittedAt: 1,
      baseAsset: "sat",
      divisibility: 1_000,
    }),
  );
}

function finishPendingOrders() {
  act(() => usePendingTradesStore.setState({ byOrderId: {} }));
}

beforeEach(async () => {
  window.localStorage.clear();
  await i18n.changeLanguage("en");
  setIdentity(LOGGED_OUT);
  useWalletStore.setState({ mnemonic: WALLET_MNEMONIC, walletBackupState: "confirmed" });
  usePendingTradesStore.setState({ byOrderId: {} });
});

afterEach(() => {
  cleanup();
  act(() => {
    setIdentity(LOGGED_OUT);
    useWalletStore.setState({ mnemonic: "", walletBackupState: "none" });
    usePendingTradesStore.setState({ byOrderId: {} });
    useSettingsStore.setState({ activeCategory: "general" });
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

  it.each(BACKED_UP_IDENTITIES)("logs out of %s at once and keeps the wallet", (_name, make) => {
    setIdentity(make());
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

  it("asks before it deletes a local key that has no backup", async () => {
    const identity = unbackedLocalKey();
    setIdentity(identity);
    renderShell();

    clickAccountItem(layout, "Log out");
    const dialog = await screen.findByRole("dialog", { name: DIALOG });
    expect(within(dialog).queryByText(ORDERS_IN_PROGRESS)).not.toBeInTheDocument();
    expectIdentity(identity);

    // Close keeps the key.
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expectIdentity(identity);

    // Back up opens the Nostr settings section and keeps the key.
    clickAccountItem(layout, "Log out");
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: DIALOG })).getByRole("button", {
        name: "Back up key",
      }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("settings-route")).toHaveTextContent(/^\/settings\?category=nostr$/);
    expectIdentity(identity);

    // Log out in the dialog deletes the key and keeps the wallet.
    clickAccountItem(layout, "Log out");
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: DIALOG })).getByRole("button", {
        name: "Log out",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expectIdentity(LOGGED_OUT);
    expect(useWalletStore.getState().mnemonic).toBe(WALLET_MNEMONIC);
  });

  it("keeps a local key without a backup while an order is in progress", async () => {
    const identity = unbackedLocalKey();
    setIdentity(identity);
    addPendingOrder();
    renderShell();

    clickAccountItem(layout, "Log out");
    const dialog = await screen.findByRole("dialog", { name: DIALOG });

    expect(within(dialog).getByText(ORDERS_IN_PROGRESS)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Log out" })).not.toBeInTheDocument();
    expectIdentity(identity);
    fireEvent.click(within(dialog).getByRole("button", { name: "Back up key" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("settings-route")).toHaveTextContent(/^\/settings\?category=nostr$/);
    expectIdentity(identity);
  });

  it.each(BACKED_UP_IDENTITIES)(
    "logs out of %s at once while an order is in progress",
    (_name, make) => {
      setIdentity(make());
      addPendingOrder();
      renderShell();

      clickAccountItem(layout, "Log out");

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expectIdentity(LOGGED_OUT);
      expect(Object.keys(usePendingTradesStore.getState().byOrderId)).toEqual(["order-1"]);
    },
  );

  it("checks orders again when the user confirms the logout", async () => {
    const identity = unbackedLocalKey();
    setIdentity(identity);
    renderShell();

    clickAccountItem(layout, "Log out");
    const dialog = await screen.findByRole("dialog", { name: DIALOG });
    // An order starts while the dialog is open.
    addPendingOrder();
    fireEvent.click(within(dialog).getByRole("button", { name: "Log out" }));

    expect(await screen.findByText(ORDERS_IN_PROGRESS)).toBeInTheDocument();
    expect(
      within(screen.getByRole("dialog", { name: DIALOG })).queryByRole("button", {
        name: "Log out",
      }),
    ).not.toBeInTheDocument();
    expectIdentity(identity);

    // After the order is terminal, the usual confirmation applies.
    fireEvent.click(
      within(screen.getByRole("dialog", { name: DIALOG })).getByRole("button", { name: "Close" }),
    );
    finishPendingOrders();
    clickAccountItem(layout, "Log out");
    const nextDialog = await screen.findByRole("dialog", { name: DIALOG });
    expect(within(nextDialog).queryByText(ORDERS_IN_PROGRESS)).not.toBeInTheDocument();
    fireEvent.click(within(nextDialog).getByRole("button", { name: "Log out" }));
    await waitFor(() => expectIdentity(LOGGED_OUT));
  });
});

describe.each(["desktop", "mobile"] as const)("ShellRoutes %s account state", (layout) => {
  const extensionSigner: NostrIdentityState = {
    nostrSignerMode: "nip07",
    signerSource: "nip07",
    signerBackupState: "confirmed",
    nsecSecret: null,
  };

  it.each([
    ["disconnected", "Log in", "Log out"],
    ["connecting", "Log out", "Log in"],
    ["connected", "Log out", "Log in"],
  ] as const)("follows a %s signer, as Settings does", (status, shown, hidden) => {
    setIdentity(extensionSigner);
    useSettingsStore.setState({ signerConnectionStatus: status });
    renderShell();

    openMenu(layout);

    expect(screen.getByRole("button", { name: shown })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: hidden })).not.toBeInTheDocument();
  });

  it("opens Nostr settings for a stored identity that did not reconnect", () => {
    // An extension that is missing after a reload leaves its stored identity disconnected.
    setIdentity(extensionSigner);
    useSettingsStore.setState({ signerConnectionStatus: "disconnected" });
    renderShell();

    clickAccountItem(layout, "Log in");

    expect(screen.getByTestId("settings-route")).toHaveTextContent(/^\/settings\?category=nostr$/);
    expectIdentity(extensionSigner);
  });

  it("opens the Nostr card when the URL already names it", async () => {
    useSettingsStore.setState({ activeCategory: null });
    renderShell("/settings?category=nostr");

    clickAccountItem(layout, "Log in");
    expect(useSettingsStore.getState().activeCategory).toBe("nostr");

    act(() => {
      setIdentity(unbackedLocalKey());
      useSettingsStore.setState({ activeCategory: null });
    });
    clickAccountItem(layout, "Log out");
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: DIALOG })).getByRole("button", {
        name: "Back up key",
      }),
    );
    expect(useSettingsStore.getState().activeCategory).toBe("nostr");
  });

  it("returns focus to the menu control after the dialog closes", async () => {
    setIdentity(unbackedLocalKey());
    renderShell();
    const control = menuControl(layout);

    for (const action of ["Close", "Back up key"] as const) {
      control.blur();
      clickAccountItem(layout, "Log out");
      fireEvent.click(
        within(await screen.findByRole("dialog", { name: DIALOG })).getByRole("button", {
          name: action,
        }),
      );
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(document.activeElement).toBe(control);
    }

    control.blur();
    clickAccountItem(layout, "Log out");
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: DIALOG })).getByRole("button", {
        name: "Log out",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(control);
  });

  it("announces the text of each dialog variant", async () => {
    setIdentity(unbackedLocalKey());
    renderShell();

    clickAccountItem(layout, "Log out");
    const dialog = await screen.findByRole("dialog", {
      name: DIALOG,
      description: UNBACKED_KEY_TEXT,
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

    addPendingOrder();
    clickAccountItem(layout, "Log out");
    expect(
      await screen.findByRole("dialog", { name: DIALOG, description: ORDERS_IN_PROGRESS_TEXT }),
    ).toBeInTheDocument();
  });
});

describe.each(["desktop", "mobile"] as const)("ShellRoutes %s startup restore", (layout) => {
  const storedKey: NostrIdentityState = {
    nostrSignerMode: "nsec",
    signerSource: "user-nsec",
    signerBackupState: "confirmed",
    nsecSecret: nip19.nsecEncode(generateSecretKey()),
  };

  function expectAccountItem(name: "Log in" | "Log out") {
    openMenu(layout);
    expect(screen.getByRole("button", { name })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: name === "Log in" ? "Log out" : "Log in" }),
    ).not.toBeInTheDocument();
    // Close the menu again without an account action.
    if (layout === "desktop") fireEvent.click(menuControl(layout));
    else fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  }

  function setStatus(status: "disconnected" | "connecting" | "connected") {
    act(() => useSettingsStore.setState({ signerConnectionStatus: status }));
  }

  // A reload starts with a disconnected status until the restore runs.
  function startRestore(identity: NostrIdentityState) {
    setIdentity(identity);
    useSettingsStore.setState({ signerConnectionStatus: "disconnected" });
    return render(shell(false));
  }

  it("shows log in during the restore when no identity is stored", () => {
    startRestore(LOGGED_OUT);

    expectAccountItem("Log in");
  });

  it("keeps log out until a failed restore completes, then shows log in", () => {
    const view = startRestore(storedKey);
    expectAccountItem("Log out");
    setStatus("connecting");
    expectAccountItem("Log out");
    // The status settles first. The restore is not complete yet.
    setStatus("disconnected");
    expectAccountItem("Log out");

    view.rerender(shell(true));
    expectAccountItem("Log in");
  });

  it("follows the status after the completion signal comes first", () => {
    const view = startRestore(storedKey);
    setStatus("connecting");

    view.rerender(shell(true));
    expectAccountItem("Log out");
    setStatus("connected");
    expectAccountItem("Log out");
    setStatus("disconnected");
    expectAccountItem("Log in");
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
    // The connection status is runtime state, and a reload starts disconnected.
    act(() => {
      setIdentity(unbackedLocalKey());
      useSettingsStore.setState({ signerConnectionStatus: "disconnected" });
    });
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

    const dialog = await screen.findByRole("dialog", { name: "Nostr鍵のバックアップがありません" });
    expect(within(dialog).getByRole("button", { name: "鍵をバックアップ" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "ログアウト" })).toBeInTheDocument();
  });

  it("states the orders in progress in Japanese", async () => {
    await i18n.changeLanguage("ja");
    setIdentity(unbackedLocalKey());
    addPendingOrder();
    renderShell();

    fireEvent.click(screen.getByRole("button", { name: "ユーザー" }));
    fireEvent.click(screen.getByRole("button", { name: "ログアウト" }));

    const dialog = await screen.findByRole("dialog", { name: "Nostr鍵のバックアップがありません" });
    expect(within(dialog).getByText(/進行中の注文があります/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "鍵をバックアップ" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "ログアウト" })).not.toBeInTheDocument();
  });
});
