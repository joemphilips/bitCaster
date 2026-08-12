import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { TopUpOverlay } from "../TopUpOverlay";

const createBrowserDurableBolt11MintQuote = vi.fn();
const subscribeActiveBrowserDurableBolt11MintQuote = vi.fn();
const hideBrowserDurableBolt11MintQuote = vi.fn();
const decodeWalletIngressToken = vi.fn();
const ingressReceiveCashuToken = vi.fn();
const ensureImplicitWallet = vi.fn();
const navigate = vi.fn();
let walletBackupState: "none" | "needs_backup" | "confirmed" = "none";

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
        walletBackupState: typeof walletBackupState;
      }) => unknown,
    ) =>
      selector({ activeMintUrl: "https://mint.example", ensureImplicitWallet, walletBackupState }),
    {
      getState: () => ({
        activeMintUrl: "https://mint.example",
        ensureImplicitWallet,
        walletBackupState,
      }),
    },
  ),
}));

describe("TopUpOverlay", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
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
    walletBackupState = "none";
  });

  it("shows a dismissible backup warning while still allowing top-up deposits", async () => {
    walletBackupState = "needs_backup";

    render(
      <TopUpOverlay deficit={10_000} baseAsset="sat" onCancel={vi.fn()} onSuccess={vi.fn()} />,
    );

    expect(
      screen.getByText("You must back up your wallet to protect your funds"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("top-up-continue")).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "Backup now" }));
    expect(navigate).toHaveBeenCalledWith("/settings?category=cashu");

    await userEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(
      screen.queryByText("You must back up your wallet to protect your funds"),
    ).not.toBeInTheDocument();
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

  it("can mint regular sat proofs for Engine Score top-ups", async () => {
    const user = userEvent.setup();

    render(
      <TopUpOverlay
        deficit={500}
        baseAsset="sat"
        proofUnit="sat"
        minimumDescription="Top up at least 500 sats to cover Engine Score before placing the order."
        onCancel={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    expect(screen.getByText(/Top up at least 500 sats/)).toBeInTheDocument();
    expect(screen.getByTestId("top-up-amount-input")).toHaveValue(600);

    await user.click(screen.getByTestId("top-up-continue"));

    await waitFor(() => {
      expect(createBrowserDurableBolt11MintQuote).toHaveBeenCalledWith({
        amount: 600,
        mintUrl: "https://mint.example",
        unit: "sat",
      });
    });
  });

  it("accepts a same-mint same-unit ecash token and closes after storing received proofs", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();

    render(
      <TopUpOverlay deficit={10_000} baseAsset="sat" onCancel={vi.fn()} onSuccess={onSuccess} />,
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
