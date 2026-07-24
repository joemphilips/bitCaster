import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.fn();
let walletBackupState: "none" | "needs_backup" | "confirmed" = "none";

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
    currentView: "chooser",
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
    window.localStorage.clear();
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
