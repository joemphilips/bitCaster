import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import userEvent from "@testing-library/user-event";
import i18n from "@/i18n";
import { DepositStep } from "../DepositStep";

const requestEcashDeposit = vi.fn();
const getDepositStatus = vi.fn();
const getWalletForUnit = vi.fn();
const encodeToken = vi.fn();
const addProofs = vi.fn();
const getUnitProofs = vi.fn();
const selectAndReserveUnitProofs = vi.fn();
const releaseProofReservation = vi.fn();
const replaceProofs = vi.fn();
const reserveProofs = vi.fn();
const ensureImplicitWallet = vi.fn();
let activeMintUrl = "https://mint.example";
let walletBalance = 200_000_000;

vi.mock("@/lib/markets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/markets")>()),
  requestEcashDeposit: (...args: unknown[]) => requestEcashDeposit(...args),
  getDepositStatus: (...args: unknown[]) => getDepositStatus(...args),
}));

vi.mock("@/lib/cashu", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cashu")>()),
  encodeToken: (...args: unknown[]) => encodeToken(...args),
  getWalletForUnit: (...args: unknown[]) => getWalletForUnit(...args),
}));

vi.mock("@/stores/proof-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/stores/proof-db")>()),
  addProofs: (...args: unknown[]) => addProofs(...args),
  getUnitProofs: (...args: unknown[]) => getUnitProofs(...args),
  selectAndReserveUnitProofs: (...args: unknown[]) => selectAndReserveUnitProofs(...args),
  releaseProofReservation: (...args: unknown[]) => releaseProofReservation(...args),
  replaceProofs: (...args: unknown[]) => replaceProofs(...args),
  reserveProofs: (...args: unknown[]) => reserveProofs(...args),
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

const DISCLOSURE =
  "This deposit is non-refundable. If the market resolves, the budget is expected to be spent paying traders who informed the price. Any residual at close becomes operator income.";

function renderStep(
  props?: Partial<{
    conditionId: string;
    defaultAmountSats: number;
    outcomeCount: number;
    baseAsset: "sat";
  }>,
) {
  const conditionId = props?.conditionId ?? "cond-test-abc123";
  const defaultAmountSats = props?.defaultAmountSats ?? 1000;
  const outcomeCount = props?.outcomeCount ?? 2;
  return render(
    <MemoryRouter initialEntries={["/creator/new"]}>
      <Routes>
        <Route
          path="/creator/new"
          element={
            <DepositStep
              conditionId={conditionId}
              defaultAmountSats={defaultAmountSats}
              outcomeCount={outcomeCount}
              baseAsset={props?.baseAsset ?? "sat"}
            />
          }
        />
        <Route
          path="/markets/:id"
          element={<div data-testid="market-detail-page">market-detail</div>}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("DepositStep", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    requestEcashDeposit.mockReset();
    getDepositStatus.mockReset();
    getWalletForUnit.mockReset();
    encodeToken.mockReset();
    addProofs.mockReset();
    getUnitProofs.mockReset();
    selectAndReserveUnitProofs.mockReset();
    releaseProofReservation.mockReset();
    replaceProofs.mockReset();
    reserveProofs.mockReset();
    ensureImplicitWallet.mockReset();
    activeMintUrl = "https://mint.example";
    walletBalance = 200_000_000;
    requestEcashDeposit.mockResolvedValue({
      depositId: "deposit-1",
      state: "paid",
    });
    getDepositStatus.mockResolvedValue({
      depositId: "deposit-1",
      state: "paid",
      method: "ecash",
    });
    getUnitProofs.mockResolvedValue([
      { id: "keyset-msat", amount: 100_000_000, secret: "proof-a", C: "C-a" },
      { id: "keyset-msat", amount: 100_000_000, secret: "proof-b", C: "C-b" },
    ]);
    selectAndReserveUnitProofs.mockResolvedValue([
      { id: "keyset-msat", amount: 100_000_000, secret: "proof-a", C: "C-a" },
      { id: "keyset-msat", amount: 100_000_000, secret: "proof-b", C: "C-b" },
    ]);
    getWalletForUnit.mockResolvedValue({
      send: vi.fn().mockResolvedValue({
        keep: [{ id: "keyset-msat", amount: 100_000_000, secret: "change-a", C: "C-change" }],
        send: [{ id: "keyset-msat", amount: 100_000_000, secret: "send-a", C: "C-send" }],
      }),
    });
    encodeToken.mockReturnValue("cashuBlocally-generated");
    addProofs.mockResolvedValue(undefined);
    ensureImplicitWallet.mockResolvedValue(undefined);
    releaseProofReservation.mockResolvedValue(undefined);
    replaceProofs.mockResolvedValue(undefined);
    reserveProofs.mockResolvedValue(undefined);
  });

  async function openFunding(user = userEvent.setup()) {
    await user.click(screen.getByRole("button", { name: "Attract Traders" }));
    expect(screen.getByRole("heading", { name: "Fund the market maker" })).toBeInTheDocument();
    return user;
  }

  it("shows the created page first, then opens funding", async () => {
    const user = userEvent.setup();
    renderStep();

    expect(screen.getByRole("heading", { name: "Market created!" })).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Fund the market maker" }),
    ).not.toBeInTheDocument();

    await openFunding(user);
    expect(screen.queryByTestId("condition-id")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /skip/i })).not.toBeInTheDocument();
  });

  it("keeps no-liquidity as a funding tier path to the market", async () => {
    const user = userEvent.setup();
    renderStep();

    await openFunding(user);
    await user.click(screen.getByTestId("amm-funding-tier-none"));
    await user.click(screen.getByRole("button", { name: "Continue to your market" }));

    await waitFor(() => {
      expect(screen.getByTestId("market-detail-page")).toBeInTheDocument();
    });
  });

  it("shows the binding disclosure before funding confirmation", async () => {
    const user = userEvent.setup();
    renderStep();

    await openFunding(user);
    expect(screen.getByText(DISCLOSURE)).toBeInTheDocument();
  });

  it("shows the thin-depth warning only for minimal funding", async () => {
    const user = userEvent.setup();
    renderStep();

    await openFunding(user);
    await user.click(screen.getByTestId("amm-funding-tier-minimal"));
    expect(screen.getByText("Minimal funding produces thin 1-share levels.")).toBeInTheDocument();

    await user.clear(screen.getByRole("spinbutton"));
    await user.type(screen.getByRole("spinbutton"), "9999");
    expect(
      screen.queryByText("Minimal funding produces thin 1-share levels."),
    ).not.toBeInTheDocument();

    await user.click(screen.getByTestId("amm-funding-tier-none"));
    expect(
      screen.queryByText("Minimal funding produces thin 1-share levels."),
    ).not.toBeInTheDocument();
  });

  it("submits AMM funding by paying from the local wallet", async () => {
    const user = userEvent.setup();
    renderStep();

    await openFunding(user);
    expect(screen.queryByTestId("request-ln-invoice")).not.toBeInTheDocument();
    expect(screen.queryByTestId("amm-funding-ecash-token")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("confirm-amm-funding"));

    await waitFor(() => {
      expect(requestEcashDeposit).toHaveBeenCalledWith(
        "cond-test-abc123",
        100_000_000,
        "cashuBlocally-generated",
        expect.objectContaining({ fundAmm: true, unit: "msat", divisibility: 10_000 }),
      );
    });
    expect(selectAndReserveUnitProofs).toHaveBeenCalledWith(
      "https://mint.example",
      { unit: "msat", minimumAmount: 100_000_000 },
      expect.stringMatching(/^market-funding:/),
    );
    expect(reserveProofs).not.toHaveBeenCalled();
    expect(replaceProofs).toHaveBeenCalledWith(
      ["proof-a", "proof-b"],
      [
        expect.objectContaining({
          secret: "change-a",
          mintUrl: "https://mint.example",
          baseAsset: "sat",
          unit: "msat",
        }),
      ],
    );
    expect(
      await screen.findByText("Payment received — crediting your market…"),
    ).toBeInTheDocument();
  });

  it("guards local-wallet funding against rapid double-clicks", async () => {
    const user = userEvent.setup();
    let resolveDeposit!: (value: { depositId: string; state: "paid" }) => void;
    requestEcashDeposit.mockReturnValue(
      new Promise((resolve) => {
        resolveDeposit = resolve;
      }),
    );
    renderStep();

    await openFunding(user);
    const payButton = screen.getByTestId("confirm-amm-funding");
    await Promise.all([user.click(payButton), user.click(payButton)]);

    await waitFor(() => expect(requestEcashDeposit).toHaveBeenCalledTimes(1));
    await act(async () => resolveDeposit({ depositId: "deposit-1", state: "paid" }));
    expect(
      await screen.findByText("Payment received — crediting your market…"),
    ).toBeInTheDocument();
  });

  it("opens the wallet top-up modal when local funding balance is insufficient", async () => {
    const user = userEvent.setup();
    walletBalance = 1_000;
    renderStep();

    await openFunding(user);
    await user.click(screen.getByTestId("confirm-amm-funding"));

    expect(screen.getByRole("heading", { name: "Insufficient balance" })).toBeInTheDocument();
    expect(screen.getByTestId("insufficient-balance-top-up")).toBeInTheDocument();
    expect(requestEcashDeposit).not.toHaveBeenCalled();
  });

  it("renders SAT funding tiers as hardcoded round whole-sat amounts", async () => {
    const user = userEvent.setup();
    renderStep({ baseAsset: "sat", outcomeCount: 4 });

    await openFunding(user);

    expect(screen.getByTestId("amm-funding-tier-minimal")).toHaveTextContent("10,000 sats");
    expect(screen.getByTestId("amm-funding-tier-standard")).toHaveTextContent("100,000 sats");
    expect(screen.getByTestId("amm-funding-tier-deep")).toHaveTextContent("500,000 sats");
    expect(screen.getByText(/At this budget, the bot posts ~/)).toBeInTheDocument();
    expect(
      screen.getByText("Depth before mint fees — actual quoted depth may be lower."),
    ).toBeInTheDocument();

    await user.click(screen.getByTestId("confirm-amm-funding"));

    await waitFor(() => {
      expect(requestEcashDeposit).toHaveBeenCalledWith(
        "cond-test-abc123",
        100_000_000,
        "cashuBlocally-generated",
        expect.objectContaining({ fundAmm: true, unit: "msat", divisibility: 10_000 }),
      );
    });
  });

  it("auto-navigates five seconds after ecash funding is accepted", async () => {
    const user = userEvent.setup();
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    renderStep();

    await openFunding(user);
    timeoutSpy.mockClear();
    await user.click(screen.getByTestId("confirm-amm-funding"));
    expect(
      await screen.findByText("Payment received — crediting your market…"),
    ).toBeInTheDocument();

    expect(screen.queryByTestId("market-detail-page")).not.toBeInTheDocument();
    const navigationCall = timeoutSpy.mock.calls.find(([, delay]) => delay === 5_000);
    expect(navigationCall).toBeDefined();
    act(() => {
      (navigationCall?.[0] as () => void)();
    });
    expect(screen.getByTestId("market-detail-page")).toBeInTheDocument();
    timeoutSpy.mockRestore();
  });

  it("polls requested ecash deposits until they are credited before navigating", async () => {
    const user = userEvent.setup();
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    requestEcashDeposit.mockResolvedValueOnce({
      depositId: "deposit-requested",
      state: "requested",
    });
    getDepositStatus.mockResolvedValueOnce({
      depositId: "deposit-requested",
      state: "requested",
      method: "ecash",
    });
    getDepositStatus.mockResolvedValueOnce({
      depositId: "deposit-requested",
      state: "credited",
      method: "ecash",
    });
    renderStep();

    await openFunding(user);
    timeoutSpy.mockClear();
    await user.click(screen.getByTestId("confirm-amm-funding"));

    expect(await screen.findByText("Awaiting payment…")).toBeInTheDocument();
    const pollingCall = timeoutSpy.mock.calls.find(([, delay]) => delay === 2_000);
    expect(pollingCall).toBeDefined();

    await act(async () => {
      (pollingCall?.[0] as () => void)();
    });

    await waitFor(() => {
      expect(getDepositStatus).toHaveBeenCalledWith("cond-test-abc123", "deposit-requested");
    });
    expect(screen.getByText("Awaiting payment…")).toBeInTheDocument();
    const secondPollingCall = timeoutSpy.mock.calls.filter(([, delay]) => delay === 2_000)[1];
    expect(secondPollingCall).toBeDefined();

    await act(async () => {
      (secondPollingCall?.[0] as () => void)();
    });

    await waitFor(() => {
      expect(getDepositStatus).toHaveBeenCalledTimes(2);
    });
    expect(
      await screen.findByText("Payment received — crediting your market…"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("market-detail-page")).not.toBeInTheDocument();
    const navigationCall = timeoutSpy.mock.calls.find(([, delay]) => delay === 5_000);
    expect(navigationCall).toBeDefined();
    act(() => {
      (navigationCall?.[0] as () => void)();
    });
    expect(screen.getByTestId("market-detail-page")).toBeInTheDocument();
    timeoutSpy.mockRestore();
  });

  it("renders failed ecash deposit state with an error and retry action", async () => {
    const user = userEvent.setup();
    requestEcashDeposit.mockResolvedValueOnce({
      depositId: "deposit-failed",
      state: "failed",
    });
    renderStep();

    await openFunding(user);
    await user.click(screen.getByTestId("confirm-amm-funding"));

    expect(await screen.findByText("Deposit failed")).toBeInTheDocument();
    expect(
      screen.getByText("Proof verification or crediting failed. Check the token and retry."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry wallet payment" })).toBeEnabled();
    expect(replaceProofs).toHaveBeenCalledWith(
      ["proof-a", "proof-b"],
      [
        expect.objectContaining({ secret: "change-a" }),
        expect.objectContaining({ secret: "send-a" }),
      ],
    );
  });

  it("does not roll back submitted proofs when local persistence fails after accepted deposit", async () => {
    const user = userEvent.setup();
    replaceProofs.mockRejectedValueOnce(new Error("indexeddb write failed"));
    renderStep();

    await openFunding(user);
    await user.click(screen.getByTestId("confirm-amm-funding"));

    await waitFor(() => expect(requestEcashDeposit).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(replaceProofs).toHaveBeenCalledTimes(1));
    expect(replaceProofs).toHaveBeenCalledWith(
      ["proof-a", "proof-b"],
      [expect.objectContaining({ secret: "change-a" })],
    );
    expect(
      screen.getByText(
        "Payment was sent but local wallet state may be inconsistent. Please restart the app to reconcile.",
      ),
    ).toBeInTheDocument();
  });

  it("disables local-wallet funding after payment is accepted while auto-navigation is pending", async () => {
    const user = userEvent.setup();
    renderStep();

    await openFunding(user);
    await user.click(screen.getByTestId("confirm-amm-funding"));

    expect(
      await screen.findByText("Payment received — crediting your market…"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("confirm-amm-funding")).toBeDisabled();
  });
});
