import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { nip19 } from "nostr-tools";
import { generateSecretKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { createGeneratedNostrIdentity } from "@/lib/identityOps";
import * as bip39 from "@/lib/bip39";
import {
  activeBrowserWalletScopeId,
  browserWalletScopeIdFromMnemonic,
  setActiveBrowserWalletProfile,
} from "@/lib/browserWalletProfile";
import { SettingsPage } from "@/pages/SettingsPage";
import { activateBrowserWalletDatabase, db } from "@/stores/proof-db";
import { usePendingTradesStore } from "@/stores/pendingTrades";
import { useSettingsStore } from "@/stores/settings";
import { useWalletStore } from "@/stores/wallet";

const nostrNetwork = vi.hoisted(() => ({
  fetchAndStoreNostrProfile: vi.fn(async () => {}),
  loginWithExtension: vi.fn(async () => ({})),
  loginWithNsec: vi.fn(async () => ({})),
  loginWithNsecOrNcryptsec: vi.fn(async (nsec: string) => ({ nsec })),
  rehydrateNostrSigner: vi.fn(async () => {}),
}));
const originalNavigatorLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
const initialEnsureImplicitWallet = useWalletStore.getState().ensureImplicitWallet;
const initialAddMint = useWalletStore.getState()._addMint;
const initialRecoverFromMnemonic = useWalletStore.getState().recoverFromMnemonic;

vi.mock("@/lib/nostr", async () => {
  const actual = await vi.importActual<typeof import("@/lib/nostr")>("@/lib/nostr");
  return {
    ...actual,
    fetchAndStoreNostrProfile: nostrNetwork.fetchAndStoreNostrProfile,
    loginWithExtension: nostrNetwork.loginWithExtension,
    loginWithNsec: nostrNetwork.loginWithNsec,
    loginWithNsecOrNcryptsec: nostrNetwork.loginWithNsecOrNcryptsec,
    rehydrateNostrSigner: nostrNetwork.rehydrateNostrSigner,
  };
});

async function renderSettingsPage(category = "nostr") {
  const view = render(
    <MemoryRouter initialEntries={[`/settings?category=${category}`]}>
      <SettingsPage />
    </MemoryRouter>,
  );
  await screen.findByRole("heading", { name: "Settings", level: 1 });
  return view;
}

function makeNsec(): string {
  return nip19.nsecEncode(generateSecretKey());
}

function expectNoSecretText() {
  expect(Boolean(document.body.textContent?.includes("nsec1"))).toBe(false);
}

async function finishRevealAndDismiss(expectedNsec: string) {
  expect(await screen.findByRole("button", { name: /view nsec/i })).toBeInTheDocument();
  expect(screen.queryByTestId("generated-nsec-value")).not.toBeInTheDocument();
  expectNoSecretText();

  fireEvent.click(screen.getByRole("button", { name: /view nsec/i }));
  expect(screen.getByRole("heading", { name: "Security Warning" })).toBeInTheDocument();
  expect(screen.queryByTestId("generated-nsec-value")).not.toBeInTheDocument();
  expectNoSecretText();

  fireEvent.click(screen.getByRole("button", { name: /i understand, show nsec/i }));
  const revealedSecret = document.querySelector<HTMLElement>(
    "[data-testid='generated-nsec-value']",
  );
  expect(revealedSecret !== null).toBe(true);
  expect(revealedSecret?.textContent === expectedNsec).toBe(true);

  const doneButton = [...document.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Done",
  );
  expect(doneButton !== undefined).toBe(true);
  if (doneButton) fireEvent.click(doneButton);
  expect(document.querySelector("[data-testid='generated-nsec-value']") === null).toBe(true);
  expectNoSecretText();
  const viewButton = [...document.querySelectorAll("button")].find((button) =>
    /view nsec/i.test(button.textContent ?? ""),
  );
  expect(viewButton !== undefined).toBe(true);
  expect(useSettingsStore.getState().signerBackupState).toBe("confirmed");
}

async function rehydrateSettingsStore() {
  await act(async () => {
    await useSettingsStore.persist.rehydrate();
  });
}

async function rehydrateWalletStore() {
  await act(async () => {
    await useWalletStore.persist.rehydrate();
  });
}

async function clearMemoryAndRestorePersistedNsec(expectedNsec: string) {
  const persistedSettings = window.localStorage.getItem("bitcaster-settings");
  expect(persistedSettings !== null).toBe(true);

  useSettingsStore.setState({
    nostrSignerMode: "none",
    signerSource: "none",
    signerBackupState: "none",
    nostrProfile: null,
    nostrProfileFetchStatus: "idle",
    nsecSecret: null,
  });
  window.localStorage.setItem("bitcaster-settings", persistedSettings ?? "");

  await rehydrateSettingsStore();
  expect(useSettingsStore.getState().nsecSecret === expectedNsec).toBe(true);
  expect(useSettingsStore.getState().nostrSignerMode === "nsec").toBe(true);
}

describe("SettingsPage local Nostr-key backup", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setActiveBrowserWalletProfile("");
    useSettingsStore.setState({
      activeCategory: "general",
      nostrSignerMode: "none",
      signerSource: "none",
      signerBackupState: "none",
      nostrProfile: null,
      nostrProfileFetchStatus: "idle",
      nsecSecret: null,
    });
    useWalletStore.setState({
      mnemonic: "",
      walletBackupState: "none",
      walletSeedReminderAcknowledgedScopeId: null,
      mints: [],
      mintConnectionStatuses: {},
      recoverFromMnemonic: initialRecoverFromMnemonic,
    });
    usePendingTradesStore.setState({ byOrderId: {} });
    nostrNetwork.fetchAndStoreNostrProfile.mockClear();
    nostrNetwork.loginWithExtension.mockClear();
    nostrNetwork.loginWithNsec.mockClear();
    nostrNetwork.loginWithNsecOrNcryptsec.mockClear();
    nostrNetwork.rehydrateNostrSigner.mockClear();
  });

  afterEach(() => {
    act(() => {
      useSettingsStore.setState({
        nostrSignerMode: "none",
        signerSource: "none",
        signerBackupState: "none",
        nostrProfile: null,
        nostrProfileFetchStatus: "idle",
        nsecSecret: null,
      });
      useWalletStore.setState({
        mnemonic: "",
        walletBackupState: "none",
        walletSeedReminderAcknowledgedScopeId: null,
        recoverFromMnemonic: initialRecoverFromMnemonic,
      });
      usePendingTradesStore.setState({ byOrderId: {} });
    });
    if (originalNavigatorLocks === undefined) {
      delete (navigator as unknown as { locks?: LockManager }).locks;
    } else {
      Object.defineProperty(navigator, "locks", originalNavigatorLocks);
    }
    setActiveBrowserWalletProfile("");
    window.localStorage.clear();
    delete (window as Window & { nostr?: unknown }).nostr;
  });

  it("records the wallet-scoped seed reminder only after reveal and restores it after reload", async () => {
    const mnemonic = bip39.generate().join(" ");
    const scopeId = browserWalletScopeIdFromMnemonic(mnemonic);
    expect(scopeId).not.toBeNull();
    useWalletStore.setState({
      mnemonic,
      walletBackupState: "needs_backup",
      walletSeedReminderAcknowledgedScopeId: null,
    });
    setActiveBrowserWalletProfile(mnemonic);

    await renderSettingsPage("cashu");

    fireEvent.click(await screen.findByRole("button", { name: /view seed phrase/i }));
    expect(useWalletStore.getState().walletSeedReminderAcknowledgedScopeId).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useWalletStore.getState().walletSeedReminderAcknowledgedScopeId).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /view seed phrase/i }));
    fireEvent.click(screen.getByRole("button", { name: /i understand, show phrase/i }));

    expect(useWalletStore.getState().walletSeedReminderAcknowledgedScopeId).toBe(scopeId);
    expect(useWalletStore.getState().walletBackupState).toBe("needs_backup");
    const persistedWallet = window.localStorage.getItem("bitcaster-wallet");
    expect(persistedWallet).not.toBeNull();
    const persistedState = JSON.parse(persistedWallet ?? "{}") as {
      state?: { walletSeedReminderAcknowledgedScopeId?: string };
    };
    expect(persistedState.state?.walletSeedReminderAcknowledgedScopeId).toBe(scopeId);

    useWalletStore.setState({
      mnemonic: "",
      walletBackupState: "none",
      walletSeedReminderAcknowledgedScopeId: null,
    });
    window.localStorage.setItem("bitcaster-wallet", persistedWallet ?? "");
    await rehydrateWalletStore();

    expect(useWalletStore.getState().walletSeedReminderAcknowledgedScopeId).toBe(scopeId);
    expect(useWalletStore.getState().walletBackupState).toBe("needs_backup");
    expect(activeBrowserWalletScopeId()).toBe(scopeId);
  });

  it("does not record a seed reminder when no wallet seed exists", async () => {
    await renderSettingsPage("cashu");

    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /view seed phrase/i })).not.toBeInTheDocument();
    expect(useWalletStore.getState().walletSeedReminderAcknowledgedScopeId).toBeNull();
  });

  it("shows the backup controls only for a locally generated key", async () => {
    await act(async () => {
      const result = await createGeneratedNostrIdentity();
      expect(result.ok).toBe(true);
      useSettingsStore.getState().setProfile(null, "fetching");
    });
    expect(useSettingsStore.getState().signerSource).toBe("implicit-generated");
    const expectedNsec = useSettingsStore.getState().nsecSecret ?? "";

    await rehydrateSettingsStore();
    const view = await renderSettingsPage();
    await finishRevealAndDismiss(expectedNsec);
    view.unmount();

    await clearMemoryAndRestorePersistedNsec(expectedNsec);
    await renderSettingsPage();
    expect(await screen.findByRole("button", { name: /view nsec/i })).toBeInTheDocument();
    expect(screen.queryByTestId("generated-nsec-value")).not.toBeInTheDocument();
    expectNoSecretText();
    expect(useSettingsStore.getState().signerBackupState).toBe("confirmed");
  });

  it.each([
    { provenance: "imported", signerSource: "user-nsec" },
    { provenance: "unknown", signerSource: "none" },
  ] as const)("hides the backup controls for $provenance keys", async ({ signerSource }) => {
    useSettingsStore.setState({
      nostrSignerMode: "nsec",
      signerSource,
      signerBackupState: "needs_backup",
      nostrProfile: null,
      nostrProfileFetchStatus: "not-found",
      nsecSecret: makeNsec(),
    });
    await renderSettingsPage();

    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /view nsec/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId("generated-nsec-value")).not.toBeInTheDocument();
    expectNoSecretText();
  });

  it("does not offer local-key backup when no local key exists", async () => {
    useSettingsStore.setState({
      nostrSignerMode: "nsec",
      signerSource: "user-nsec",
      signerBackupState: "confirmed",
      nostrProfile: null,
      nostrProfileFetchStatus: "not-found",
      nsecSecret: null,
    });
    await renderSettingsPage();

    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /view nsec/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId("generated-nsec-value")).not.toBeInTheDocument();
    expectNoSecretText();
  });

  it("clears a stale local secret when connecting an external NIP-07 signer", async () => {
    const staleLocalSecret = makeNsec();
    useSettingsStore.getState().setNsecSecret(staleLocalSecret);
    Object.defineProperty(window, "nostr", {
      configurable: true,
      value: { getPublicKey: vi.fn(async () => "a".repeat(64)) },
    });

    await renderSettingsPage();
    fireEvent.click(await screen.findByRole("button", { name: /connect with nip-07 extension/i }));

    await waitFor(() => {
      expect(useSettingsStore.getState().nostrSignerMode).toBe("nip07");
      expect(useSettingsStore.getState().nsecSecret === null).toBe(true);
    });
    expect(nostrNetwork.loginWithExtension).toHaveBeenCalledOnce();
    expect(screen.getByText(/back up your nostr key in your external signer/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /view nsec/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId("generated-nsec-value")).not.toBeInTheDocument();
    expectNoSecretText();
  });
});

describe("SettingsPage wallet replacement", () => {
  it("replaces the wallet through the seed handoff and leaves the Nostr signer unchanged", async () => {
    const oldMnemonic = bip39.generate().join(" ");
    const oldScopeId = browserWalletScopeIdFromMnemonic(oldMnemonic);
    expect(oldScopeId).not.toBeNull();
    useWalletStore.setState({ mnemonic: oldMnemonic, walletBackupState: "confirmed" });
    setActiveBrowserWalletProfile(oldMnemonic);
    activateBrowserWalletDatabase(oldScopeId!);
    const oldDatabaseName = db.name;

    const nostrBefore = {
      nostrSignerMode: "nsec" as const,
      signerSource: "user-nsec" as const,
      signerBackupState: "confirmed" as const,
      nsecSecret: makeNsec(),
    };
    useSettingsStore.setState(nostrBefore);

    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        async request<T>(_name: string, _options: LockOptions, callback: LockGrantedCallback<T>) {
          return callback(null);
        },
      },
    });

    await renderSettingsPage("cashu");
    fireEvent.click(await screen.findByRole("button", { name: /replace wallet/i }));
    const newWords = bip39.generate();
    fireEvent.change(screen.getByLabelText(/enter your seedphrase/i), {
      target: { value: newWords.join(" ") },
    });
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Replace This Wallet" })).getByRole("button", {
        name: "Replace Wallet",
      }),
    );

    const expectedMnemonic = newWords.join(" ");
    await waitFor(
      () => expect(useWalletStore.getState().mnemonic === expectedMnemonic).toBe(true),
      {
        onTimeout: () => {
          const safeError = screen
            .getByRole("dialog", { name: "Replace This Wallet" })
            .querySelector(".border-rose-200")?.textContent;
          return new Error(safeError ?? "Wallet replacement did not complete");
        },
      },
    );
    const newScopeId = browserWalletScopeIdFromMnemonic(expectedMnemonic);
    expect(db.name).not.toBe(oldDatabaseName);
    expect(activeBrowserWalletScopeId()).toBe(newScopeId);
    expect(useSettingsStore.getState()).toMatchObject(nostrBefore);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Replace This Wallet" })).not.toBeInTheDocument(),
    );

    const persistedWallet = window.localStorage.getItem("bitcaster-wallet");
    expect(persistedWallet).not.toBeNull();
    useWalletStore.setState({
      mnemonic: "",
      walletBackupState: "none",
      walletSeedReminderAcknowledgedScopeId: null,
    });
    window.localStorage.setItem("bitcaster-wallet", persistedWallet ?? "");
    await rehydrateWalletStore();
    expect(useWalletStore.getState().mnemonic === expectedMnemonic).toBe(true);
    expect(activeBrowserWalletScopeId()).toBe(newScopeId);
  });

  it("does not start replacement when the user cancels", async () => {
    const mnemonic = bip39.generate().join(" ");
    useWalletStore.setState({ mnemonic, walletBackupState: "confirmed" });
    setActiveBrowserWalletProfile(mnemonic);
    const recover = vi.fn(initialRecoverFromMnemonic);
    useWalletStore.setState({ recoverFromMnemonic: recover });

    await renderSettingsPage("cashu");
    fireEvent.click(await screen.findByRole("button", { name: /replace wallet/i }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(recover).not.toHaveBeenCalled();
    expect(useWalletStore.getState().mnemonic === mnemonic).toBe(true);
    expect(screen.queryByRole("dialog", { name: "Replace This Wallet" })).not.toBeInTheDocument();
  });

  it("keeps the replacement modal open while the handoff is pending", async () => {
    const mnemonic = bip39.generate().join(" ");
    useWalletStore.setState({ mnemonic, walletBackupState: "confirmed" });
    setActiveBrowserWalletProfile(mnemonic);
    let finishReplacement!: (result: { valid: boolean }) => void;
    const recover = vi.fn(
      (_words: string[]) =>
        new Promise<{ valid: boolean }>((resolve) => {
          finishReplacement = resolve;
        }),
    );
    useWalletStore.setState({ recoverFromMnemonic: recover });

    await renderSettingsPage("cashu");
    fireEvent.click(await screen.findByRole("button", { name: /replace wallet/i }));
    fireEvent.change(screen.getByLabelText(/enter your seedphrase/i), {
      target: { value: bip39.generate().join(" ") },
    });
    const dialog = screen.getByRole("dialog", { name: "Replace This Wallet" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Replace Wallet" }));
    await waitFor(() => expect(recover).toHaveBeenCalledOnce());

    expect(within(dialog).getByRole("button", { name: "Close" })).toBeDisabled();
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    fireEvent.click(screen.getByTestId("wallet-setup-dialog-backdrop"));
    expect(screen.getByRole("dialog", { name: "Replace This Wallet" })).toBeInTheDocument();

    await act(async () => finishReplacement({ valid: true }));
    expect(screen.queryByRole("dialog", { name: "Replace This Wallet" })).not.toBeInTheDocument();
  });
});

describe("SettingsPage explicit wallet setup", () => {
  beforeEach(() => {
    localStorage.clear();
    setActiveBrowserWalletProfile("");
    useSettingsStore.setState({
      activeCategory: "cashu",
      nostrSignerMode: "none",
      signerSource: "none",
      signerBackupState: "none",
      nsecSecret: null,
      nostrProfile: null,
      nostrProfileFetchStatus: "idle",
    });
    useWalletStore.setState({
      mnemonic: "",
      walletBackupState: "none",
      walletSeedReminderAcknowledgedScopeId: null,
      mints: [],
      mintConnectionStatuses: {},
      setupComplete: false,
      recoverFromMnemonic: initialRecoverFromMnemonic,
      ensureImplicitWallet: initialEnsureImplicitWallet,
      _addMint: vi.fn(async () => {}),
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    useWalletStore.setState({
      mnemonic: "",
      walletBackupState: "none",
      recoverFromMnemonic: initialRecoverFromMnemonic,
      ensureImplicitWallet: initialEnsureImplicitWallet,
      _addMint: initialAddMint,
    });
    useSettingsStore.setState({
      nostrSignerMode: "none",
      signerSource: "none",
      signerBackupState: "none",
      nsecSecret: null,
    });
    setActiveBrowserWalletProfile("");
    localStorage.clear();
  });
  function readSetup<T>(read: () => T): T {
    try {
      return read();
    } catch {
      throw new Error("Settings wallet setup query failed.");
    }
  }
  function setupElement(read: () => HTMLElement | null): HTMLElement {
    const element = readSetup(read);
    if (!element) throw new Error("Settings wallet setup element is unavailable.");
    return element;
  }
  function setupButton(name: string): HTMLElement {
    return setupElement(() => screen.queryByRole("button", { name }));
  }
  function setupDialog(): HTMLElement {
    return setupElement(() => screen.queryByRole("dialog"));
  }
  function waitForSetup(check: () => void): Promise<void> {
    return waitFor(check, {
      onTimeout: () => new Error("Settings wallet setup state did not reach the expected value."),
    });
  }
  function expectSetupClosed(): void {
    expect(readSetup(() => screen.queryByRole("dialog") === null)).toBe(true);
  }
  function openImport(words: string[]) {
    fireEvent.click(setupButton("Create Wallet"));
    fireEvent.click(setupButton("Import Existing Wallet"));
    fireEvent.change(
      setupElement(() => screen.queryByLabelText("Enter your seedphrase")),
      {
        target: { value: words.join(" ") },
      },
    );
  }
  it("creates a local wallet without creating a signer", async () => {
    await renderSettingsPage("cashu");
    fireEvent.click(setupButton("Create Wallet"));
    fireEvent.click(setupButton("Create New Wallet"));
    await waitForSetup(() => expect(Boolean(useWalletStore.getState().mnemonic)).toBe(true));
    await waitForSetup(expectSetupClosed);
    expect(bip39.validate(useWalletStore.getState().mnemonic.split(" "))).toBe(true);
    expect(useSettingsStore.getState().nostrSignerMode).toBe("none");
    expect(useSettingsStore.getState().nsecSecret === null).toBe(true);
    expect(readSetup(() => screen.queryByTestId("settings-create-wallet") === null)).toBe(true);
  });
  it("imports a valid wallet and preserves the existing signer", async () => {
    const words = bip39.generate();
    const secret = makeNsec();
    useSettingsStore.setState({
      nostrSignerMode: "nsec",
      signerSource: "user-nsec",
      signerBackupState: "confirmed",
      nsecSecret: secret,
    });
    await renderSettingsPage("cashu");
    openImport(words);
    fireEvent.click(setupButton("Restore Wallet"));
    await waitForSetup(expectSetupClosed);
    expect(useWalletStore.getState().mnemonic === words.join(" ")).toBe(true);
    expect(useWalletStore.getState().walletBackupState).toBe("confirmed");
    expect(useSettingsStore.getState().nsecSecret === secret).toBe(true);
    expect(useSettingsStore.getState().nostrSignerMode).toBe("nsec");
  });
  it("keeps setup available after a failed import and retries without ensuring the rejected import", async () => {
    const words = bip39.generate();
    const ensure = vi.fn(initialEnsureImplicitWallet);
    useWalletStore.setState({ ensureImplicitWallet: ensure });
    await renderSettingsPage("cashu");
    openImport(words);
    const originalSetItem = Storage.prototype.setItem;
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === "bitcaster-wallet") throw new Error("storage unavailable");
      return originalSetItem.call(this, key, value);
    });
    try {
      fireEvent.click(setupButton("Restore Wallet"));
      await waitForSetup(() =>
        expect(
          readSetup(
            () => screen.queryByText("Could not set up wallet. Please try again.") !== null,
          ),
        ).toBe(true),
      );
      expect(ensure).not.toHaveBeenCalled();
      expect(useWalletStore.getState().mnemonic === "").toBe(true);
      expect(readSetup(() => screen.queryByTestId("settings-create-wallet") !== null)).toBe(true);
    } finally {
      write.mockRestore();
    }
    fireEvent.click(setupButton("Restore Wallet"));
    await waitForSetup(expectSetupClosed);
    expect(ensure).toHaveBeenCalledOnce();
    expect(useWalletStore.getState().mnemonic === words.join(" ")).toBe(true);
    expect(useSettingsStore.getState().nsecSecret === null).toBe(true);
  });
  it("cancels before an action and refuses invalid recovery phrases", async () => {
    const ensure = vi.fn(async () => {});
    const recover = vi.fn(initialRecoverFromMnemonic);
    useWalletStore.setState({ ensureImplicitWallet: ensure, recoverFromMnemonic: recover });
    await renderSettingsPage("cashu");
    fireEvent.click(setupButton("Create Wallet"));
    fireEvent.click(
      setupElement(() => within(setupDialog()).queryByRole("button", { name: "Close" })),
    );
    openImport(["invalid"]);
    expect(readSetup(() => (setupButton("Restore Wallet") as HTMLButtonElement).disabled)).toBe(
      true,
    );
    expect(ensure).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    expect(useWalletStore.getState().mnemonic === "").toBe(true);
  });
  it("keeps an already saved seed when pending creation is dismissed", async () => {
    let resolve!: () => void;
    const words = bip39.generate();
    useWalletStore.setState({
      ensureImplicitWallet: () => {
        useWalletStore.setState({ mnemonic: words.join(" "), walletBackupState: "needs_backup" });
        return new Promise<void>((done) => {
          resolve = done;
        });
      },
    });
    await renderSettingsPage("cashu");
    fireEvent.click(setupButton("Create Wallet"));
    fireEvent.click(setupButton("Create New Wallet"));
    fireEvent.click(
      setupElement(() => within(setupDialog()).queryByRole("button", { name: "Close" })),
    );
    await act(async () => {
      resolve();
    });
    expect(useWalletStore.getState().mnemonic === words.join(" ")).toBe(true);
    expectSetupClosed();
    expect(readSetup(() => screen.queryByTestId("settings-create-wallet") === null)).toBe(true);
  });

  it("rechecks the mnemonic before acting and never replaces a newly available wallet", async () => {
    const ensure = vi.fn(async () => {});
    useWalletStore.setState({ ensureImplicitWallet: ensure });
    await renderSettingsPage("cashu");
    fireEvent.click(setupButton("Create Wallet"));
    act(() => useWalletStore.setState({ mnemonic: bip39.generate().join(" ") }));
    fireEvent.click(setupButton("Create New Wallet"));
    expect(ensure).not.toHaveBeenCalled();
    expectSetupClosed();
  });
  it.each(["dismiss", "unmount"])("ignores a late import after %s", async (boundary) => {
    let resolve!: (value: { valid: boolean }) => void;
    const recover = vi.fn(
      () =>
        new Promise<{ valid: boolean }>((done) => {
          resolve = done;
        }),
    );
    const ensure = vi.fn(async () => {});
    useWalletStore.setState({ recoverFromMnemonic: recover, ensureImplicitWallet: ensure });
    const view = await renderSettingsPage("cashu");
    openImport(bip39.generate());
    fireEvent.click(setupButton("Restore Wallet"));
    if (boundary === "unmount") view.unmount();
    else {
      fireEvent.click(
        setupElement(() => within(setupDialog()).queryByRole("button", { name: "Close" })),
      );
      fireEvent.click(setupButton("Create Wallet"));
    }
    await act(async () => {
      resolve({ valid: true });
    });
    expect(ensure).not.toHaveBeenCalled();
    if (boundary === "dismiss")
      expect(readSetup(() => screen.queryByRole("dialog") !== null)).toBe(true);
  });
});
