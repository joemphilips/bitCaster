import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { nip19 } from "nostr-tools";
import { generateSecretKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGeneratedNostrIdentity } from "@/lib/identityOps";
import * as bip39 from "@/lib/bip39";
import {
  activeBrowserWalletScopeId,
  browserWalletScopeIdFromMnemonic,
  setActiveBrowserWalletProfile,
} from "@/lib/browserWalletProfile";
import { SettingsPage } from "@/pages/SettingsPage";
import { useSettingsStore } from "@/stores/settings";
import { useWalletStore } from "@/stores/wallet";

const nostrNetwork = vi.hoisted(() => ({
  fetchAndStoreNostrProfile: vi.fn(async () => {}),
  loginWithExtension: vi.fn(async () => ({})),
  loginWithNsec: vi.fn(async () => ({})),
  loginWithNsecOrNcryptsec: vi.fn(async (nsec: string) => ({ nsec })),
  rehydrateNostrSigner: vi.fn(async () => {}),
}));

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

function renderSettingsPage(category = "nostr") {
  return render(
    <MemoryRouter initialEntries={[`/settings?category=${category}`]}>
      <SettingsPage />
    </MemoryRouter>,
  );
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
    });
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
      });
    });
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

    renderSettingsPage("cashu");

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
    renderSettingsPage("cashu");

    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /view seed phrase/i })).not.toBeInTheDocument();
    expect(useWalletStore.getState().walletSeedReminderAcknowledgedScopeId).toBeNull();
  });

  it.each(["generated", "imported"] as const)(
    "%s local key stays hidden before reveal and after dismissal and store rehydration",
    async (keyOrigin) => {
      let expectedNsec: string;
      if (keyOrigin === "generated") {
        await act(async () => {
          const result = await createGeneratedNostrIdentity();
          expect(result.ok).toBe(true);
          useSettingsStore.getState().setProfile(null, "not-found");
        });
        expect(useSettingsStore.getState().signerSource).toBe("implicit-generated");
        expectedNsec = useSettingsStore.getState().nsecSecret ?? "";
      } else {
        expectedNsec = makeNsec();
        const view = renderSettingsPage();
        fireEvent.click(await screen.findByRole("button", { name: /connect with private key/i }));
        fireEvent.change(screen.getByPlaceholderText("nsec1... or ncryptsec1..."), {
          target: { value: expectedNsec },
        });
        fireEvent.click(screen.getByRole("button", { name: "Connect" }));
        await waitFor(() => {
          expect(useSettingsStore.getState().signerSource).toBe("user-nsec");
          expect(useSettingsStore.getState().nsecSecret !== null).toBe(true);
        });
        act(() => useSettingsStore.getState().setProfile(null, "not-found"));
        view.unmount();
      }

      await rehydrateSettingsStore();
      const view = renderSettingsPage();
      await finishRevealAndDismiss(expectedNsec);
      view.unmount();

      await clearMemoryAndRestorePersistedNsec(expectedNsec);
      renderSettingsPage();
      expect(await screen.findByRole("button", { name: /view nsec/i })).toBeInTheDocument();
      expect(screen.queryByTestId("generated-nsec-value")).not.toBeInTheDocument();
      expectNoSecretText();
      expect(useSettingsStore.getState().signerBackupState).toBe("confirmed");
    },
  );

  it("does not offer local-key backup when no local key exists", async () => {
    useSettingsStore.setState({
      nostrSignerMode: "nsec",
      signerSource: "user-nsec",
      signerBackupState: "confirmed",
      nostrProfile: null,
      nostrProfileFetchStatus: "not-found",
      nsecSecret: null,
    });
    renderSettingsPage();

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

    renderSettingsPage();
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
