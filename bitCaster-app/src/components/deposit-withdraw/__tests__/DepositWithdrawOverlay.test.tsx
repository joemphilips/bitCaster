import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.fn();
let walletBackupState: "none" | "needs_backup" | "confirmed" = "none";
let currentView = "chooser";
let successAmountMsat = 0;
let successBaseAsset: "sat" = "sat";

vi.mock("react-router", () => ({
  useNavigate: () => navigate,
}));

vi.mock("@/stores/wallet", () => ({
  useWalletStore: (selector: (state: { walletBackupState: typeof walletBackupState }) => unknown) =>
    selector({ walletBackupState }),
}));

vi.mock("@/pages/useDepositWithdrawState", () => ({
  useDepositWithdrawState: (mode: "deposit" | "withdraw", onClose: () => void) => ({
    mode,
    onClose,
    currentView,
    meltQuote: { amount: 1_000, fee_reserve: 10 },
    meltIsPaying: false,
    successAmountMsat,
    successBaseAsset,
    onConfirmMelt: vi.fn(),
    error: null,
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
  DepositWithdraw: () => <div>deposit chooser</div>,
}));

import { DepositWithdrawOverlay } from "../DepositWithdrawOverlay";

describe("DepositWithdrawOverlay backup warning", () => {
  beforeEach(() => {
    navigate.mockReset();
    walletBackupState = "none";
    currentView = "chooser";
    successAmountMsat = 0;
    successBaseAsset = "sat";
    window.localStorage.clear();
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

  it("shows a dismissible backup warning for deposit without blocking the flow", async () => {
    walletBackupState = "needs_backup";

    render(<DepositWithdrawOverlay mode="deposit" onClose={vi.fn()} />);

    expect(screen.getByText("deposit chooser")).toBeInTheDocument();
    expect(
      screen.getByText("You must back up your wallet to protect your funds"),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Backup now" }));
    expect(navigate).toHaveBeenCalledWith("/settings?category=cashu");

    await userEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(
      screen.queryByText("You must back up your wallet to protect your funds"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("deposit chooser")).toBeInTheDocument();
    expect(window.localStorage.getItem("bitcaster.depositBackupWarningDismissed")).toBe("true");
  });

  it("shows the deposit backup warning again when a later deposit starts", async () => {
    walletBackupState = "needs_backup";

    const { unmount } = render(<DepositWithdrawOverlay mode="deposit" onClose={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(
      screen.queryByText("You must back up your wallet to protect your funds"),
    ).not.toBeInTheDocument();

    unmount();
    render(<DepositWithdrawOverlay mode="deposit" onClose={vi.fn()} />);

    expect(
      screen.getByText("You must back up your wallet to protect your funds"),
    ).toBeInTheDocument();
    expect(window.localStorage.getItem("bitcaster.depositBackupWarningDismissed")).toBe("false");
  });
});
