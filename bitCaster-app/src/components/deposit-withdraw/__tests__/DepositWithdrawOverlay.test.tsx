import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserWalletScopeIdFromMnemonic,
  setActiveBrowserWalletProfile,
} from "@/lib/browserWalletProfile";

const navigate = vi.fn();
let walletMnemonic =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
let walletSeedReminderAcknowledgedScopeId: string | null = null;
let currentView = "chooser";
let successAmountMsat = 0;
let successBaseAsset: "sat" = "sat";
let meltIsPaying = false;
let error: string | null = null;

vi.mock("react-router", () => ({
  useNavigate: () => navigate,
}));

vi.mock("@/stores/wallet", () => ({
  useWalletStore: (
    selector: (state: {
      mnemonic: string;
      walletSeedReminderAcknowledgedScopeId: string | null;
    }) => unknown,
  ) => selector({ mnemonic: walletMnemonic, walletSeedReminderAcknowledgedScopeId }),
}));

vi.mock("@/pages/useDepositWithdrawState", () => ({
  useDepositWithdrawState: (mode: "deposit" | "withdraw", onClose: () => void) => ({
    mode,
    onClose,
    currentView,
    meltQuote: { amount: 1_000, fee_reserve: 10 },
    meltIsPaying,
    successAmountMsat,
    successBaseAsset,
    onConfirmMelt: vi.fn(),
    error,
    mints: [],
    selectedMintId: "",
    amountSats: 0,
    amountLabel: "0 sats",
    selectedUnit: "sat",
    unitOptions: ["sat"],
    amountFiat: "$0.00",
    fiatSymbol: "$",
    showFiatPrimary: false,
    lightningInput: "",
  }),
}));

vi.mock("../DepositWithdraw", () => ({
  DepositWithdraw: ({
    depositReminder,
    statusMessage,
  }: {
    depositReminder?: ReactNode;
    statusMessage?: ReactNode;
  }) => (
    <div data-testid="deposit-entry-flow">
      {statusMessage}
      {depositReminder}
      <div>deposit chooser</div>
    </div>
  ),
}));

import { DepositWithdrawOverlay } from "../DepositWithdrawOverlay";

describe("DepositWithdrawOverlay seed reminder", () => {
  beforeEach(() => {
    navigate.mockReset();
    walletMnemonic =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    walletSeedReminderAcknowledgedScopeId = null;
    setActiveBrowserWalletProfile(walletMnemonic);
    currentView = "chooser";
    successAmountMsat = 0;
    successBaseAsset = "sat";
    meltIsPaying = false;
    error = null;
  });

  it("shows an msat melt quote and fee as sats", () => {
    currentView = "melt-confirm";

    render(<DepositWithdrawOverlay mode="withdraw" onClose={vi.fn()} />);

    expect(screen.getByText("₿1")).toBeInTheDocument();
    expect(screen.getByText("₿0.01")).toBeInTheDocument();
    expect(screen.getByText("₿1.01")).toBeInTheDocument();
  });

  it("renders a 1000 msat success amount as 1 sat", () => {
    currentView = "success";
    successAmountMsat = 1_000;

    render(<DepositWithdrawOverlay mode="withdraw" onClose={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Success!" })).toBeInTheDocument();
    expect(screen.getByText("1 sats")).toBeInTheDocument();
  });

  it("keeps the same msat-to-sats display for deposit success", () => {
    currentView = "success";
    successAmountMsat = 1_000;

    render(<DepositWithdrawOverlay mode="deposit" onClose={vi.fn()} />);

    expect(screen.getByText("1 sats")).toBeInTheDocument();
  });

  it("shows a dismissible seed reminder for deposit without blocking the flow", async () => {
    render(<DepositWithdrawOverlay mode="deposit" onClose={vi.fn()} />);

    expect(screen.getByText("deposit chooser")).toBeInTheDocument();
    expect(
      screen.getByText(
        "View your wallet seed phrase in Settings before adding funds. Viewing it does not confirm an external backup.",
      ),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "View seed phrase" }));
    expect(navigate).toHaveBeenCalledWith("/settings?category=cashu");

    await userEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(
      screen.queryByText(
        "View your wallet seed phrase in Settings before adding funds. Viewing it does not confirm an external backup.",
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByText("deposit chooser")).toBeInTheDocument();
  });

  it("passes deposit entry errors into the normal-flow message slot", () => {
    error = "The mint could not prepare a quote.";

    render(<DepositWithdrawOverlay mode="deposit" onClose={vi.fn()} />);

    const statusMessage = screen.getByTestId("deposit-status-message");
    expect(screen.getByTestId("deposit-entry-flow")).toContainElement(statusMessage);
    expect(statusMessage).not.toHaveClass("fixed");
  });

  it("shows the seed reminder again when a later deposit starts", async () => {
    const { unmount } = render(<DepositWithdrawOverlay mode="deposit" onClose={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(
      screen.queryByText(
        "View your wallet seed phrase in Settings before adding funds. Viewing it does not confirm an external backup.",
      ),
    ).not.toBeInTheDocument();

    unmount();
    render(<DepositWithdrawOverlay mode="deposit" onClose={vi.fn()} />);

    expect(
      screen.getByText(
        "View your wallet seed phrase in Settings before adding funds. Viewing it does not confirm an external backup.",
      ),
    ).toBeInTheDocument();
  });

  it("hides the reminder after this wallet's seed has been revealed", () => {
    walletSeedReminderAcknowledgedScopeId = browserWalletScopeIdFromMnemonic(walletMnemonic);

    render(<DepositWithdrawOverlay mode="deposit" onClose={vi.fn()} />);

    expect(
      screen.queryByText(
        "View your wallet seed phrase in Settings before adding funds. Viewing it does not confirm an external backup.",
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByText("deposit chooser")).toBeInTheDocument();
  });

  it("shows the reminder again when the active wallet changes after Later", async () => {
    const { rerender } = render(<DepositWithdrawOverlay mode="deposit" onClose={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(
      screen.queryByText(
        "View your wallet seed phrase in Settings before adding funds. Viewing it does not confirm an external backup.",
      ),
    ).not.toBeInTheDocument();

    walletMnemonic = "legal winner thank year wave sausage worth useful legal winner thank yellow";
    setActiveBrowserWalletProfile(walletMnemonic);
    rerender(<DepositWithdrawOverlay mode="deposit" onClose={vi.fn()} />);

    expect(
      screen.getByText(
        "View your wallet seed phrase in Settings before adding funds. Viewing it does not confirm an external backup.",
      ),
    ).toBeInTheDocument();
  });

  it("routes native cancel through the deposit owner", () => {
    const onClose = vi.fn();
    render(<DepositWithdrawOverlay mode="deposit" onClose={onClose} />);

    fireEvent(
      screen.getByRole("dialog", { name: "Deposit" }),
      new Event("cancel", { cancelable: true }),
    );

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("blocks native cancel while a melt payment is active", () => {
    currentView = "melt-confirm";
    meltIsPaying = true;
    const onClose = vi.fn();
    render(<DepositWithdrawOverlay mode="withdraw" onClose={onClose} />);

    fireEvent(
      screen.getByRole("dialog", { name: "Withdrawal" }),
      new Event("cancel", { cancelable: true }),
    );

    expect(onClose).not.toHaveBeenCalled();
  });
});
