import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "@/i18n";
import { LocalWalletPayButton } from "../LocalWalletPayButton";

const getWalletForUnit = vi.fn();
const encodeToken = vi.fn();
const selectAndReserveUnitProofs = vi.fn();
const releaseProofReservation = vi.fn();
const replaceProofs = vi.fn();
const ensureImplicitWallet = vi.fn();
const upsertPendingLocalWalletPayment = vi.fn();
const markPendingLocalWalletPaymentAccepted = vi.fn();
const completePendingLocalWalletPayment = vi.fn();
const markPendingLocalWalletPaymentAcceptedButNotCompleted = vi.fn();
let walletBalance = 200;
let activeMintUrl = "https://mint.example";

vi.mock("@/lib/cashu", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cashu")>()),
  encodeToken: (...args: unknown[]) => encodeToken(...args),
  getWalletForUnit: (...args: unknown[]) => getWalletForUnit(...args),
}));

vi.mock("@/stores/proof-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/stores/proof-db")>()),
  selectAndReserveUnitProofs: (...args: unknown[]) => selectAndReserveUnitProofs(...args),
  releaseProofReservation: (...args: unknown[]) => releaseProofReservation(...args),
  replaceProofs: (...args: unknown[]) => replaceProofs(...args),
}));

vi.mock("@/stores/wallet", () => ({
  useBalance: () => walletBalance,
  useWalletStore: Object.assign(
    (
      selector: (state: {
        activeMintUrl: string;
        ensureImplicitWallet: typeof ensureImplicitWallet;
      }) => unknown,
    ) => selector({ activeMintUrl, ensureImplicitWallet }),
    {
      getState: () => ({ activeMintUrl, ensureImplicitWallet }),
    },
  ),
}));

vi.mock("@/lib/pendingLocalWalletPayments", () => ({
  upsertPendingLocalWalletPayment: (...args: unknown[]) => upsertPendingLocalWalletPayment(...args),
  markPendingLocalWalletPaymentAccepted: (...args: unknown[]) =>
    markPendingLocalWalletPaymentAccepted(...args),
  completePendingLocalWalletPayment: (...args: unknown[]) =>
    completePendingLocalWalletPayment(...args),
  markPendingLocalWalletPaymentAcceptedButNotCompleted: (...args: unknown[]) =>
    markPendingLocalWalletPaymentAcceptedButNotCompleted(...args),
}));

describe("LocalWalletPayButton", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    walletBalance = 200;
    activeMintUrl = "https://mint.example";
    getWalletForUnit.mockReset();
    encodeToken.mockReset();
    selectAndReserveUnitProofs.mockReset();
    releaseProofReservation.mockReset();
    replaceProofs.mockReset();
    ensureImplicitWallet.mockReset();
    upsertPendingLocalWalletPayment.mockReset();
    markPendingLocalWalletPaymentAccepted.mockReset();
    completePendingLocalWalletPayment.mockReset();
    markPendingLocalWalletPaymentAcceptedButNotCompleted.mockReset();
    ensureImplicitWallet.mockResolvedValue(undefined);
    selectAndReserveUnitProofs.mockResolvedValue([
      {
        id: "keyset-sat",
        amount: 150,
        secret: "proof-a",
        C: "C-a",
        mintUrl: activeMintUrl,
        baseAsset: "sat",
        unit: "sat",
      },
    ]);
    getWalletForUnit.mockResolvedValue({
      send: vi.fn().mockResolvedValue({
        keep: [{ id: "keyset-sat", amount: 50, secret: "change-a", C: "C-change" }],
        send: [{ id: "keyset-sat", amount: 100, secret: "send-a", C: "C-send" }],
      }),
    });
    encodeToken.mockReturnValue("cashuBtoken");
    replaceProofs.mockResolvedValue(undefined);
    upsertPendingLocalWalletPayment.mockResolvedValue(undefined);
    markPendingLocalWalletPaymentAccepted.mockResolvedValue(undefined);
    completePendingLocalWalletPayment.mockResolvedValue(undefined);
    markPendingLocalWalletPaymentAcceptedButNotCompleted.mockResolvedValue(undefined);
  });

  it("keeps an accepted pending-payment record and warns when local replaceProofs fails after remote acceptance", async () => {
    const user = userEvent.setup();
    const onTokenPayment = vi.fn().mockResolvedValue({ accepted: true });
    replaceProofs.mockRejectedValueOnce(new Error("indexeddb write failed"));
    render(
      <LocalWalletPayButton
        amountSubunits={100}
        baseAsset="sat"
        unit="sat"
        testId="pay"
        reservationPurpose="market-deposit:cond-1"
        onTokenPayment={onTokenPayment}
      />,
    );

    await user.click(screen.getByTestId("pay"));

    await waitFor(() => expect(onTokenPayment).toHaveBeenCalledWith("cashuBtoken"));
    expect(upsertPendingLocalWalletPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pending",
        sendProofs: [expect.objectContaining({ secret: "send-a" })],
        keepProofs: [expect.objectContaining({ secret: "change-a" })],
        spentSecrets: ["proof-a"],
        target: expect.objectContaining({ amountSubunits: 100, baseAsset: "sat", unit: "sat" }),
      }),
    );
    expect(markPendingLocalWalletPaymentAccepted).toHaveBeenCalledOnce();
    expect(replaceProofs).toHaveBeenCalledWith(
      ["proof-a"],
      [expect.objectContaining({ secret: "change-a" })],
    );
    expect(completePendingLocalWalletPayment).not.toHaveBeenCalled();
    expect(markPendingLocalWalletPaymentAcceptedButNotCompleted).toHaveBeenCalledOnce();
    expect(releaseProofReservation).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Payment was sent but local wallet state may be inconsistent. Please restart the app to reconcile.",
      ),
    ).toBeInTheDocument();
  });

  it("encodes the local-wallet payment token with the selected collateral unit", async () => {
    const user = userEvent.setup();
    const onTokenPayment = vi.fn().mockResolvedValue({ accepted: true });
    walletBalance = 150_000;
    selectAndReserveUnitProofs.mockResolvedValueOnce([
      {
        id: "keyset-msat",
        amount: 150_000,
        secret: "proof-msat",
        C: "C-msat",
        mintUrl: activeMintUrl,
        baseAsset: "sat",
        unit: "msat",
      },
    ]);
    getWalletForUnit.mockResolvedValueOnce({
      send: vi.fn().mockResolvedValue({
        keep: [{ id: "keyset-msat", amount: 50_000, secret: "change-msat", C: "C-change-msat" }],
        send: [{ id: "keyset-msat", amount: 100_000, secret: "send-msat", C: "C-send-msat" }],
      }),
    });

    render(
      <LocalWalletPayButton
        amountSubunits={100_000}
        baseAsset="sat"
        unit="msat"
        testId="pay"
        reservationPurpose="market-funding"
        onTokenPayment={onTokenPayment}
      />,
    );

    await user.click(screen.getByTestId("pay"));

    await waitFor(() => expect(onTokenPayment).toHaveBeenCalledWith("cashuBtoken"));
    expect(encodeToken).toHaveBeenCalledWith(
      [expect.objectContaining({ secret: "send-msat" })],
      activeMintUrl,
      "msat",
    );
  });
});
