import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import {
  browserWalletScopeIdFromMnemonic,
  setActiveBrowserWalletProfile,
} from "@/lib/browserWalletProfile";
import { TopUpOverlay } from "../TopUpOverlay";
import { WalletBackupPresentationProvider } from "@/hooks/WalletBackupPresentation";
import { BrowserWalletRecoveryRequiredError } from "@/lib/browserWalletNewWritePermission";

const createBrowserDurableBolt11MintQuote = vi.fn();
const subscribeActiveBrowserDurableBolt11MintQuote = vi.fn();
const hideBrowserDurableBolt11MintQuote = vi.fn();
const decodeWalletIngressToken = vi.fn();
const ingressReceiveCashuToken = vi.fn();
const ensureImplicitWallet = vi.fn();
const navigate = vi.fn();
let walletMnemonic =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
let walletSeedReminderAcknowledgedScopeId: string | null = null;

vi.mock("react-router", () => ({
  useNavigate: () => navigate,
}));

vi.mock("@/lib/browserDurableBolt11MintQuote", () => ({
  createBrowserDurableBolt11MintQuote: (...args: unknown[]) =>
    createBrowserDurableBolt11MintQuote(...args),
  subscribeActiveBrowserDurableBolt11MintQuote: (...args: unknown[]) =>
    subscribeActiveBrowserDurableBolt11MintQuote(...args),
  hideBrowserDurableBolt11MintQuote: (...args: unknown[]) =>
    hideBrowserDurableBolt11MintQuote(...args),
}));

vi.mock("@/lib/walletOps", () => ({
  decodeWalletIngressToken: (...args: unknown[]) => decodeWalletIngressToken(...args),
  ingressReceiveCashuToken: (...args: unknown[]) => ingressReceiveCashuToken(...args),
}));

vi.mock("@/stores/wallet", () => ({
  useWalletStore: Object.assign(
    (
      selector: (state: {
        activeMintUrl: string;
        ensureImplicitWallet: typeof ensureImplicitWallet;
        mnemonic: string;
        walletSeedReminderAcknowledgedScopeId: string | null;
      }) => unknown,
    ) =>
      selector({
        activeMintUrl: "https://mint.example",
        ensureImplicitWallet,
        mnemonic: walletMnemonic,
        walletSeedReminderAcknowledgedScopeId,
      }),
    {
      getState: () => ({
        activeMintUrl: "https://mint.example",
        ensureImplicitWallet,
        mnemonic: walletMnemonic,
        walletSeedReminderAcknowledgedScopeId,
      }),
    },
  ),
}));

describe("TopUpOverlay", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    walletMnemonic =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    createBrowserDurableBolt11MintQuote.mockReset();
    createBrowserDurableBolt11MintQuote.mockResolvedValue(durableQuote());
    subscribeActiveBrowserDurableBolt11MintQuote.mockReset();
    subscribeActiveBrowserDurableBolt11MintQuote.mockResolvedValue(() => undefined);
    hideBrowserDurableBolt11MintQuote.mockReset();
    hideBrowserDurableBolt11MintQuote.mockResolvedValue(undefined);
    decodeWalletIngressToken.mockReset();
    decodeWalletIngressToken.mockResolvedValue({
      mint: "https://mint.example",
      unit: "msat",
      proofs: [{ id: "keyset-msat", amount: 15_000, secret: "incoming", C: "incoming-c" }],
    });
    ingressReceiveCashuToken.mockReset();
    ingressReceiveCashuToken.mockResolvedValue({
      added: false,
      mintUrl: "https://mint.example",
      source: "paste",
      unit: "msat",
      amountSubunits: 15_000,
      baseAsset: "sat",
      proofs: [{ id: "keyset-msat", amount: 15_000, secret: "received", C: "received-c" }],
    });
    ensureImplicitWallet.mockReset();
    ensureImplicitWallet.mockResolvedValue(undefined);
    navigate.mockReset();
    walletSeedReminderAcknowledgedScopeId = null;
    setActiveBrowserWalletProfile(walletMnemonic);
  });

  it.each(["authentication", "leadership-wait", "retry", "driver-unavailable"] as const)(
    "shows %s inside the top-up dialog and prevents repeated quote clicks",
    async (reason) => {
      render(
        <WalletBackupPresentationProvider
          value={{ recoveryStatus: { kind: "preparing", reason }, retryRecovery: vi.fn() }}
        >
          <TopUpOverlay deficit={10_000} baseAsset="sat" onCancel={vi.fn()} onSuccess={vi.fn()} />
        </WalletBackupPresentationProvider>,
      );
      const dialog = screen.getByRole("dialog");
      expect(
        within(dialog).getByRole("status", { name: "Preparing wallet backup" }),
      ).toBeInTheDocument();
      expect(screen.getByTestId("top-up-continue")).toBeDisabled();
      await userEvent.click(screen.getByTestId("top-up-continue"));
      await userEvent.click(screen.getByTestId("top-up-method-ecash"));
      fireEvent.change(screen.getByTestId("top-up-ecash-input"), {
        target: { value: "cashuAtoken" },
      });
      expect(screen.getByTestId("top-up-ecash-submit")).toBeDisabled();
      expect(createBrowserDurableBolt11MintQuote).not.toHaveBeenCalled();
      expect(ingressReceiveCashuToken).not.toHaveBeenCalled();
      expect(ensureImplicitWallet).not.toHaveBeenCalled();
    },
  );

  it("retries only app-owned backup, keeps the entered amount, and needs a new click after ready", async () => {
    const retryRecovery = vi.fn();
    const overlay = (
      <TopUpOverlay deficit={10_000} baseAsset="sat" onCancel={vi.fn()} onSuccess={vi.fn()} />
    );
    const { rerender } = render(
      <WalletBackupPresentationProvider
        value={{ recoveryStatus: { kind: "failed" }, retryRecovery }}
      >
        {overlay}
      </WalletBackupPresentationProvider>,
    );
    fireEvent.change(screen.getByTestId("top-up-amount-input"), { target: { value: "23" } });
    expect(
      within(screen.getByRole("dialog")).getByRole("status", { name: "Wallet backup stopped" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("top-up-continue")).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Retry wallet backup" }));
    expect(retryRecovery).toHaveBeenCalledOnce();
    rerender(
      <WalletBackupPresentationProvider
        value={{ recoveryStatus: { kind: "preparing", reason: "authentication" }, retryRecovery }}
      >
        {overlay}
      </WalletBackupPresentationProvider>,
    );
    expect(screen.getByTestId("top-up-amount-input")).toHaveValue(23);
    expect(screen.getByTestId("top-up-continue")).toBeDisabled();
    rerender(
      <WalletBackupPresentationProvider
        value={{ recoveryStatus: { kind: "ready" }, retryRecovery }}
      >
        {overlay}
      </WalletBackupPresentationProvider>,
    );
    expect(screen.getByTestId("top-up-amount-input")).toHaveValue(23);
    expect(createBrowserDurableBolt11MintQuote).not.toHaveBeenCalled();
    expect(screen.getByTestId("top-up-continue")).toBeEnabled();
    await userEvent.click(screen.getByTestId("top-up-continue"));
    expect(createBrowserDurableBolt11MintQuote).toHaveBeenCalledWith({
      amount: 23_000,
      mintUrl: "https://mint.example",
      unit: "msat",
    });
  });

  it.each(["en", "ja"])(
    "does not authorize from ready presentation and explains an authoritative startup refusal in %s",
    async (language) => {
      await i18n.changeLanguage(language);
      createBrowserDurableBolt11MintQuote.mockRejectedValue(
        new BrowserWalletRecoveryRequiredError("startup-authentication-pending"),
      );
      render(
        <WalletBackupPresentationProvider
          value={{ recoveryStatus: { kind: "ready" }, retryRecovery: vi.fn() }}
        >
          <TopUpOverlay deficit={10_000} baseAsset="sat" onCancel={vi.fn()} onSuccess={vi.fn()} />
        </WalletBackupPresentationProvider>,
      );
      await userEvent.click(screen.getByTestId("top-up-continue"));
      expect(
        await screen.findByText(
          language === "en"
            ? "Wallet backup is not ready. Wait for it to finish, or use Retry wallet backup if it has stopped."
            : "ウォレットバックアップの準備が完了していません。完了を待つか、停止している場合は「バックアップを再試行」を選んでください。",
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(/authenticating this wallet/)).not.toBeInTheDocument();
      expect(subscribeActiveBrowserDurableBolt11MintQuote).not.toHaveBeenCalled();
    },
  );

  it("shows a dismissible per-open seed reminder while allowing top-up deposits", async () => {
    const { unmount } = render(
      <TopUpOverlay deficit={10_000} baseAsset="sat" onCancel={vi.fn()} onSuccess={vi.fn()} />,
    );

    expect(
      screen.getByText(
        "View your wallet seed phrase in Settings before adding funds. Viewing it does not confirm an external backup.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId("top-up-continue")).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "View seed phrase" }));
    expect(navigate).toHaveBeenCalledWith("/settings?category=cashu");

    await userEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(
      screen.queryByText(
        "View your wallet seed phrase in Settings before adding funds. Viewing it does not confirm an external backup.",
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("top-up-continue")).toBeEnabled();

    unmount();
    render(
      <TopUpOverlay deficit={10_000} baseAsset="sat" onCancel={vi.fn()} onSuccess={vi.fn()} />,
    );
    expect(
      screen.getByText(
        "View your wallet seed phrase in Settings before adding funds. Viewing it does not confirm an external backup.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps the seed reminder in the top-up panel flow", () => {
    render(
      <TopUpOverlay deficit={10_000} baseAsset="sat" onCancel={vi.fn()} onSuccess={vi.fn()} />,
    );

    const reminder = screen.getByTestId("top-up-seed-reminder");
    expect(screen.getByTestId("top-up-dialog-panel")).toContainElement(reminder);
    expect(reminder).not.toHaveClass("fixed");
    expect(screen.getByTestId("top-up-continue")).toBeEnabled();
  });

  it("hides the reminder after this wallet's seed has been revealed", () => {
    walletSeedReminderAcknowledgedScopeId = browserWalletScopeIdFromMnemonic(walletMnemonic);

    render(
      <TopUpOverlay deficit={10_000} baseAsset="sat" onCancel={vi.fn()} onSuccess={vi.fn()} />,
    );

    expect(
      screen.queryByText(
        "View your wallet seed phrase in Settings before adding funds. Viewing it does not confirm an external backup.",
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("top-up-continue")).toBeEnabled();
  });

  it("shows the reminder again when the active wallet changes after Later", async () => {
    const { rerender } = render(
      <TopUpOverlay deficit={10_000} baseAsset="sat" onCancel={vi.fn()} onSuccess={vi.fn()} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(
      screen.queryByText(
        "View your wallet seed phrase in Settings before adding funds. Viewing it does not confirm an external backup.",
      ),
    ).not.toBeInTheDocument();

    walletMnemonic = "legal winner thank year wave sausage worth useful legal winner thank yellow";
    walletSeedReminderAcknowledgedScopeId = null;
    setActiveBrowserWalletProfile(walletMnemonic);
    rerender(
      <TopUpOverlay deficit={10_000} baseAsset="sat" onCancel={vi.fn()} onSuccess={vi.fn()} />,
    );

    await waitFor(() =>
      expect(
        screen.getByText(
          "View your wallet seed phrase in Settings before adding funds. Viewing it does not confirm an external backup.",
        ),
      ).toBeInTheDocument(),
    );
  });

  it("asks for an amount when the trade shortfall is unknown", async () => {
    render(<TopUpOverlay deficit={0} baseAsset="sat" onCancel={vi.fn()} onSuccess={vi.fn()} />);
    expect(screen.getByText(/Choose an amount to add/)).toBeInTheDocument();
    expect(screen.getByTestId("top-up-amount-input")).toHaveValue(null);
    expect(screen.getByTestId("top-up-continue")).toBeDisabled();
    await userEvent.type(screen.getByTestId("top-up-amount-input"), "0.5");
    expect(screen.getByTestId("top-up-continue")).toBeEnabled();
  });

  it("shows the full registration fee separately from the top-up deficit", () => {
    render(
      <TopUpOverlay
        deficit={1_500}
        balanceSubunits={1_000}
        feeSubunits={2_500}
        baseAsset="sat"
        onCancel={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    expect(screen.getByText("Registration fee")).toBeInTheDocument();
    expect(screen.getByText("2.5 sats")).toBeInTheDocument();
    expect(screen.getByText("Your balance")).toBeInTheDocument();
    expect(screen.getByText("1 sats")).toBeInTheDocument();
    expect(screen.getByText("Top-up needed")).toBeInTheDocument();
    expect(screen.getByText("1.5 sats")).toBeInTheDocument();
  });

  it("adds the unit-aware top-up buffer and converts sat-market subunits to sats for the invoice", async () => {
    const user = userEvent.setup();

    render(
      <TopUpOverlay deficit={10_000} baseAsset="sat" onCancel={vi.fn()} onSuccess={vi.fn()} />,
    );

    expect(screen.getByText(/Minimum 10 sats to cover the trade/)).toBeInTheDocument();
    expect(screen.getByTestId("top-up-amount-input")).toHaveValue(20);

    await user.click(screen.getByTestId("top-up-continue"));

    await waitFor(() => {
      expect(createBrowserDurableBolt11MintQuote).toHaveBeenCalledWith({
        amount: 20_000,
        mintUrl: "https://mint.example",
        unit: "msat",
      });
    });
  });

  it("shows the invoice only after durable creation resolves and suppresses rapid double-fire", async () => {
    let resolveQuote: (value: ReturnType<typeof durableQuote>) => void;
    createBrowserDurableBolt11MintQuote.mockImplementationOnce(
      () => new Promise((resolve) => (resolveQuote = resolve)),
    );
    render(
      <TopUpOverlay deficit={10_000} baseAsset="sat" onCancel={vi.fn()} onSuccess={vi.fn()} />,
    );

    await userEvent.click(screen.getByTestId("top-up-continue"));
    await userEvent.click(screen.getByTestId("top-up-continue"));
    await waitFor(() => expect(createBrowserDurableBolt11MintQuote).toHaveBeenCalledOnce());
    expect(screen.queryByTestId("bolt11-display")).not.toBeInTheDocument();

    await act(async () => resolveQuote!(durableQuote()));
    expect(await screen.findByTestId("bolt11-display")).toHaveTextContent("lnbc1example");
  });

  it("shows Score amounts in sats and mints the exact msat quote", async () => {
    const user = userEvent.setup();

    render(
      <TopUpOverlay
        deficit={5_000}
        baseAsset="sat"
        proofUnit="msat"
        minimumDescription="Top up at least 5 sats to cover Engine Score before placing the order."
        onCancel={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    expect(screen.getByText(/Top up at least 5 sats/)).toBeInTheDocument();
    expect(screen.getByTestId("top-up-amount-input")).toHaveValue(15);
    await user.clear(screen.getByTestId("top-up-amount-input"));
    await user.type(screen.getByTestId("top-up-amount-input"), "5");

    await user.click(screen.getByTestId("top-up-continue"));

    await waitFor(() => {
      expect(createBrowserDurableBolt11MintQuote).toHaveBeenCalledWith({
        amount: 5_000,
        mintUrl: "https://mint.example",
        unit: "msat",
      });
    });
    expect(await screen.findByTestId("bolt11-display")).toHaveTextContent("lnbc1example");
    expect(screen.getByText("5 sats")).toBeInTheDocument();
  });

  it.each([0, 5_000])(
    "accepts valid ecash with a known minimum of %i subunits",
    async (deficit) => {
      const user = userEvent.setup();
      const onSuccess = vi.fn();

      render(
        <TopUpOverlay
          deficit={deficit}
          baseAsset="sat"
          proofUnit="msat"
          onCancel={vi.fn()}
          onSuccess={onSuccess}
        />,
      );

      await user.click(screen.getByTestId("top-up-method-ecash"));
      await user.type(screen.getByTestId("top-up-ecash-input"), "cashuB-token");
      await user.click(screen.getByTestId("top-up-ecash-submit"));

      await waitFor(() => {
        expect(decodeWalletIngressToken).toHaveBeenCalledWith("cashuB-token");
      });
      expect(ingressReceiveCashuToken).toHaveBeenCalledWith("cashuB-token", "paste", {
        mintUrl: "https://mint.example",
      });
      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledTimes(1);
      });
    },
  );

  it("rejects empty ecash even when the trade shortfall is unknown", async () => {
    decodeWalletIngressToken.mockResolvedValue({
      mint: "https://mint.example",
      unit: "msat",
      proofs: [],
    });
    const onSuccess = vi.fn();
    render(<TopUpOverlay deficit={0} baseAsset="sat" onCancel={vi.fn()} onSuccess={onSuccess} />);
    await userEvent.click(screen.getByTestId("top-up-method-ecash"));
    await userEvent.type(screen.getByTestId("top-up-ecash-input"), "cashuB-empty");
    await userEvent.click(screen.getByTestId("top-up-ecash-submit"));
    await waitFor(() => expect(screen.getByTestId("top-up-ecash-submit")).toBeEnabled());
    expect(decodeWalletIngressToken).toHaveBeenCalledWith("cashuB-empty");
    expect(ingressReceiveCashuToken).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("hides a cancelled quote and ignores its later UI callback", async () => {
    const onSuccess = vi.fn();
    const onCancel = vi.fn();
    render(
      <TopUpOverlay deficit={10_000} baseAsset="sat" onCancel={onCancel} onSuccess={onSuccess} />,
    );
    await userEvent.click(screen.getByTestId("top-up-continue"));
    await screen.findByTestId("bolt11-display");
    const onResult = subscribeActiveBrowserDurableBolt11MintQuote.mock.calls[0][0].onResult;

    await userEvent.click(screen.getAllByRole("button")[0]!);
    await waitFor(() =>
      expect(hideBrowserDurableBolt11MintQuote).toHaveBeenCalledWith("a".repeat(64)),
    );
    onResult({ status: "PAID" });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("routes native cancel through quote cleanup before the owner callback", async () => {
    const onCancel = vi.fn();
    render(
      <TopUpOverlay deficit={10_000} baseAsset="sat" onCancel={onCancel} onSuccess={vi.fn()} />,
    );
    await userEvent.click(screen.getByTestId("top-up-continue"));
    await screen.findByTestId("bolt11-display");

    fireEvent(
      screen.getByRole("dialog", { name: "Top Up Wallet" }),
      new Event("cancel", { cancelable: true }),
    );

    await waitFor(() =>
      expect(hideBrowserDurableBolt11MintQuote).toHaveBeenCalledWith("a".repeat(64)),
    );
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("keeps the dialog mounted through a slow quote cleanup and ignores repeat cancel", async () => {
    let resolveHide: () => void;
    hideBrowserDurableBolt11MintQuote.mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveHide = resolve)),
    );
    const onCancel = vi.fn();
    render(
      <TopUpOverlay deficit={10_000} baseAsset="sat" onCancel={onCancel} onSuccess={vi.fn()} />,
    );
    await userEvent.click(screen.getByTestId("top-up-continue"));
    await screen.findByTestId("bolt11-display");
    const dialog = screen.getByRole("dialog", { name: "Top Up Wallet" }) as HTMLDialogElement;

    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    fireEvent(dialog, new Event("cancel", { cancelable: true }));

    expect(hideBrowserDurableBolt11MintQuote).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
    expect(dialog.open).toBe(true);

    await act(async () => resolveHide!());
    await waitFor(() => expect(onCancel).toHaveBeenCalledOnce());
  });

  it("waits for a regenerating quote cleanup before native cancellation", async () => {
    let resolveHide: () => void;
    hideBrowserDurableBolt11MintQuote.mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveHide = resolve)),
    );
    const onCancel = vi.fn();
    render(
      <TopUpOverlay deficit={10_000} baseAsset="sat" onCancel={onCancel} onSuccess={vi.fn()} />,
    );
    await userEvent.click(screen.getByTestId("top-up-continue"));
    await screen.findByTestId("bolt11-display");
    const onResult = subscribeActiveBrowserDurableBolt11MintQuote.mock.calls[0][0].onResult;
    act(() => onResult({ status: "ERROR" }));

    await userEvent.click(screen.getByRole("button", { name: "Re-quote" }));
    expect(hideBrowserDurableBolt11MintQuote).toHaveBeenCalledOnce();

    const dialog = screen.getByRole("dialog", { name: "Top Up Wallet" }) as HTMLDialogElement;
    fireEvent(dialog, new Event("cancel", { cancelable: true }));

    expect(onCancel).not.toHaveBeenCalled();
    expect(dialog.open).toBe(true);

    await act(async () => resolveHide!());
    await waitFor(() => expect(onCancel).toHaveBeenCalledOnce());
  });

  it("routes an amount-view outside click through the owner cancellation", async () => {
    const onCancel = vi.fn();
    render(
      <TopUpOverlay deficit={10_000} baseAsset="sat" onCancel={onCancel} onSuccess={vi.fn()} />,
    );

    fireEvent.click(screen.getByTestId("top-up-dialog-backdrop"));

    await waitFor(() => expect(onCancel).toHaveBeenCalledOnce());
  });

  it("hides a durable quote that resolves after cancellation before invoice presentation", async () => {
    let resolveQuote: (value: ReturnType<typeof durableQuote>) => void;
    createBrowserDurableBolt11MintQuote.mockImplementationOnce(
      () => new Promise((resolve) => (resolveQuote = resolve)),
    );
    render(
      <TopUpOverlay deficit={10_000} baseAsset="sat" onCancel={vi.fn()} onSuccess={vi.fn()} />,
    );

    await userEvent.click(screen.getByTestId("top-up-continue"));
    await waitFor(() => expect(createBrowserDurableBolt11MintQuote).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByTestId("top-up-close"));
    await act(async () => resolveQuote!(durableQuote()));

    await waitFor(() =>
      expect(hideBrowserDurableBolt11MintQuote).toHaveBeenCalledWith("a".repeat(64)),
    );
    expect(subscribeActiveBrowserDurableBolt11MintQuote).not.toHaveBeenCalled();
    expect(screen.queryByTestId("bolt11-display")).not.toBeInTheDocument();
  });

  it("hides an active durable quote when its parent unmounts the overlay", async () => {
    const { unmount } = render(
      <TopUpOverlay deficit={10_000} baseAsset="sat" onCancel={vi.fn()} onSuccess={vi.fn()} />,
    );

    await userEvent.click(screen.getByTestId("top-up-continue"));
    await screen.findByTestId("bolt11-display");
    unmount();

    await waitFor(() =>
      expect(hideBrowserDurableBolt11MintQuote).toHaveBeenCalledWith("a".repeat(64)),
    );
  });
});

function durableQuote() {
  return {
    invoiceRequest: "lnbc1example",
    quote: {
      quoteRecordId: "a".repeat(64),
      expiryUnixSeconds: 123,
    },
  };
}
