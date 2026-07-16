import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import userEvent from "@testing-library/user-event";
import i18n from "@/i18n";
import { useSettingsStore } from "@/stores/settings";
import { DepositStep } from "../DepositStep";

const requestEcashDeposit = vi.fn();
const getDepositStatus = vi.fn();
const executeGuiLocalWalletPayment = vi.fn();
const observeGuiEcashDeposit = vi.fn();
const retryGuiEcashDeposit = vi.fn();
let activeMintUrl = "https://mint.example";
let walletBalance = 200_000_000;
const DEPOSIT_ID = "00000000-0000-4000-8000-000000000001";

vi.mock("@/lib/markets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/markets")>()),
  requestEcashDeposit: (...args: unknown[]) => requestEcashDeposit(...args),
  getDepositStatus: (...args: unknown[]) => getDepositStatus(...args),
}));

vi.mock("@/lib/guiMarketFundingPayment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/guiMarketFundingPayment")>()),
  executeGuiLocalWalletPayment: (...args: unknown[]) =>
    executeGuiLocalWalletPayment(...args),
  observeGuiEcashDeposit: (...args: unknown[]) =>
    observeGuiEcashDeposit(...args),
  retryGuiEcashDeposit: (...args: unknown[]) => retryGuiEcashDeposit(...args),
}));

vi.mock("@/stores/wallet", () => ({
  useBalance: () => walletBalance,
  useWalletStore: Object.assign(
    (selector: (state: { activeMintUrl: string }) => unknown) =>
      selector({ activeMintUrl }),
    {
      getState: () => ({ activeMintUrl }),
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
    baseAsset: "sat" | "usd" | "jpy";
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
    executeGuiLocalWalletPayment.mockReset();
    observeGuiEcashDeposit.mockReset();
    retryGuiEcashDeposit.mockReset();
    activeMintUrl = "https://mint.example";
    walletBalance = 200_000_000;
    useSettingsStore.setState({
      nostrSignerMode: "nip07",
      nostrProfile: {
        pubkey: "aa".repeat(32),
        displayName: "",
        avatar: "",
        nip05: "",
        nip05verified: false,
        bio: "",
      },
    });
    requestEcashDeposit.mockResolvedValue({
      depositId: DEPOSIT_ID,
      state: "credited",
    });
    getDepositStatus.mockResolvedValue({
      depositId: DEPOSIT_ID,
      state: "credited",
      method: "ecash",
    });
    executeGuiLocalWalletPayment.mockImplementation(async (input) => {
      const response = await input.remote.submit({
        depositId: DEPOSIT_ID,
        token: "cashuBlocally-generated",
        request: {
          ...input.request,
          mintUrl: input.mintUrl,
          amountSubunits: input.amountSubunits,
          baseAsset: input.baseAsset,
          unit: input.unit,
        },
      });
      return response.state === "credited"
        ? { status: "completed", depositId: DEPOSIT_ID }
        : {
            status: "pending",
            depositId: DEPOSIT_ID,
            remoteState: response.state,
          };
    });
    observeGuiEcashDeposit.mockImplementation(async (depositId, remote) => {
      const status = await remote.getStatus({
        depositId,
        request: { conditionId: "cond-test-abc123" },
      });
      if (status == null) return null;
      return status.state === "credited"
        ? { status: "completed", depositId }
        : { status: "pending", depositId, remoteState: status.state };
    });
    retryGuiEcashDeposit.mockResolvedValue({
      status: "completed",
      depositId: DEPOSIT_ID,
    });
  });

  async function openFunding(user = userEvent.setup()) {
    await user.click(screen.getByRole("button", { name: "Attract Traders" }));
    expect(
      screen.getByRole("heading", { name: "Fund the market maker" }),
    ).toBeInTheDocument();
    return user;
  }

  it("shows the created page first, then opens funding", async () => {
    const user = userEvent.setup();
    renderStep();

    expect(
      screen.getByRole("heading", { name: "Market created!" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Fund the market maker" }),
    ).not.toBeInTheDocument();

    await openFunding(user);
    expect(screen.queryByTestId("condition-id")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /skip/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps no-liquidity as a funding tier path to the market", async () => {
    const user = userEvent.setup();
    renderStep();

    await openFunding(user);
    await user.click(screen.getByTestId("amm-funding-tier-none"));
    await user.click(
      screen.getByRole("button", { name: "Continue to your market" }),
    );

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
    expect(
      screen.getByText("Minimal funding produces thin 1-share levels."),
    ).toBeInTheDocument();

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

  it("previews USD custom funding as entered dollars", async () => {
    const user = userEvent.setup();
    renderStep({ baseAsset: "usd" });

    await openFunding(user);
    await user.clear(screen.getByRole("spinbutton"));
    await user.type(screen.getByRole("spinbutton"), "15");

    expect(screen.getByText("Funding amount: $15.00")).toBeInTheDocument();
  });

  it("converts USD custom funding dollars to cent subunits at the request boundary", async () => {
    const user = userEvent.setup();
    renderStep({ baseAsset: "usd" });

    await openFunding(user);
    await user.clear(screen.getByRole("spinbutton"));
    await user.type(screen.getByRole("spinbutton"), "15");
    await user.click(screen.getByTestId("confirm-amm-funding"));

    await waitFor(() => {
      expect(requestEcashDeposit).toHaveBeenCalledWith(
        "cond-test-abc123",
        DEPOSIT_ID,
        1_500,
        "cashuBlocally-generated",
        expect.objectContaining({
          fundAmm: true,
          unit: "usd",
          divisibility: 1_000,
        }),
      );
    });
  });

  it("renders USD funding tiers in dollars instead of cent subunits", async () => {
    const user = userEvent.setup();
    renderStep({ baseAsset: "usd", outcomeCount: 4 });

    await openFunding(user);

    expect(screen.getByTestId("amm-funding-tier-minimal")).toHaveTextContent(
      "$100",
    );
    expect(screen.getByTestId("amm-funding-tier-standard")).toHaveTextContent(
      "$1,000",
    );
    expect(screen.getByTestId("amm-funding-tier-deep")).toHaveTextContent(
      "$5,000",
    );
    expect(screen.queryByText("1500")).not.toBeInTheDocument();
    expect(screen.queryByText("15000")).not.toBeInTheDocument();
  });

  it("submits AMM funding by paying from the local wallet", async () => {
    const user = userEvent.setup();
    renderStep();

    await openFunding(user);
    expect(screen.queryByTestId("request-ln-invoice")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("amm-funding-ecash-token"),
    ).not.toBeInTheDocument();
    await user.click(screen.getByTestId("confirm-amm-funding"));

    await waitFor(() => {
      expect(requestEcashDeposit).toHaveBeenCalledWith(
        "cond-test-abc123",
        DEPOSIT_ID,
        100_000_000,
        "cashuBlocally-generated",
        expect.objectContaining({
          fundAmm: true,
          unit: "msat",
          divisibility: 10_000,
        }),
      );
    });
    expect(
      await screen.findByText("Payment received — crediting your market…"),
    ).toBeInTheDocument();
  });

  it("guards local-wallet funding against rapid double-clicks", async () => {
    const user = userEvent.setup();
    let resolveDeposit!: (value: {
      depositId: string;
      state: "credited";
    }) => void;
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
    await act(async () =>
      resolveDeposit({ depositId: DEPOSIT_ID, state: "credited" }),
    );
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

    expect(
      screen.getByRole("heading", { name: "Insufficient balance" }),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("insufficient-balance-top-up"),
    ).toBeInTheDocument();
    expect(requestEcashDeposit).not.toHaveBeenCalled();
  });

  it("renders SAT funding tiers as hardcoded round whole-sat amounts", async () => {
    const user = userEvent.setup();
    renderStep({ baseAsset: "sat", outcomeCount: 4 });

    await openFunding(user);

    expect(screen.getByTestId("amm-funding-tier-minimal")).toHaveTextContent(
      "10,000 sats",
    );
    expect(screen.getByTestId("amm-funding-tier-standard")).toHaveTextContent(
      "100,000 sats",
    );
    expect(screen.getByTestId("amm-funding-tier-deep")).toHaveTextContent(
      "500,000 sats",
    );
    expect(
      screen.getByText(/At this budget, the bot posts ~/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Depth before mint fees — actual quoted depth may be lower.",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByTestId("confirm-amm-funding"));

    await waitFor(() => {
      expect(requestEcashDeposit).toHaveBeenCalledWith(
        "cond-test-abc123",
        DEPOSIT_ID,
        100_000_000,
        "cashuBlocally-generated",
        expect.objectContaining({
          fundAmm: true,
          unit: "msat",
          divisibility: 10_000,
        }),
      );
    });
  });

  it("fails fast for unsupported AMM funding base assets", () => {
    expect(() => renderStep({ baseAsset: "jpy" })).toThrow(
      /unsupported base asset: jpy/,
    );
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
    const navigationCall = timeoutSpy.mock.calls.find(
      ([, delay]) => delay === 5_000,
    );
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
      depositId: DEPOSIT_ID,
      state: "requested",
    });
    getDepositStatus.mockResolvedValueOnce({
      depositId: DEPOSIT_ID,
      state: "requested",
      method: "ecash",
    });
    getDepositStatus.mockResolvedValueOnce({
      depositId: DEPOSIT_ID,
      state: "credited",
      method: "ecash",
    });
    renderStep();

    await openFunding(user);
    timeoutSpy.mockClear();
    await user.click(screen.getByTestId("confirm-amm-funding"));

    expect(await screen.findByText("Awaiting payment…")).toBeInTheDocument();
    const pollingCall = timeoutSpy.mock.calls.find(
      ([, delay]) => delay === 2_000,
    );
    expect(pollingCall).toBeDefined();

    await act(async () => {
      (pollingCall?.[0] as () => void)();
    });

    await waitFor(() => {
      expect(getDepositStatus).toHaveBeenCalledWith(
        "cond-test-abc123",
        DEPOSIT_ID,
      );
    });
    expect(screen.getByText("Awaiting payment…")).toBeInTheDocument();
    const secondPollingCall = timeoutSpy.mock.calls.filter(
      ([, delay]) => delay === 2_000,
    )[1];
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
    const navigationCall = timeoutSpy.mock.calls.find(
      ([, delay]) => delay === 5_000,
    );
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
      depositId: DEPOSIT_ID,
      state: "failed",
    });
    renderStep();

    await openFunding(user);
    await user.click(screen.getByTestId("confirm-amm-funding"));

    expect(await screen.findByText("Deposit failed")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Proof verification or crediting failed. Check the token and retry.",
      ),
    ).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Retry wallet payment" });
    expect(retry).toBeEnabled();
    await user.click(retry);
    expect(retryGuiEcashDeposit).toHaveBeenCalledWith(
      DEPOSIT_ID,
      expect.objectContaining({
        currentFundingIdentity: expect.any(Function),
        getStatus: expect.any(Function),
        submit: expect.any(Function),
      }),
    );
  });

  it("does not navigate when credited cleanup persistence fails", async () => {
    const user = userEvent.setup();
    executeGuiLocalWalletPayment.mockRejectedValueOnce(
      new DOMException("quota exhausted", "QuotaExceededError"),
    );
    renderStep();

    await openFunding(user);
    await user.click(screen.getByTestId("confirm-amm-funding"));

    expect(await screen.findByText("quota exhausted")).toBeInTheDocument();
    expect(screen.queryByTestId("market-detail-page")).not.toBeInTheDocument();
  });

  it("pins an ambiguous deposit and retries its exact durable row", async () => {
    const user = userEvent.setup();
    executeGuiLocalWalletPayment.mockResolvedValueOnce({
      status: "transport-ambiguous",
      depositId: DEPOSIT_ID,
      error: "response lost",
    });
    renderStep();

    await openFunding(user);
    await user.click(screen.getByTestId("confirm-amm-funding"));
    expect(await screen.findByText("response lost")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Retry wallet payment" }),
    );

    expect(executeGuiLocalWalletPayment).toHaveBeenCalledTimes(1);
    expect(retryGuiEcashDeposit).toHaveBeenCalledWith(
      DEPOSIT_ID,
      expect.objectContaining({ submit: expect.any(Function) }),
    );
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

  it("renders USD funding tiers as hardcoded round whole-dollar amounts and requests base subunits", async () => {
    const user = userEvent.setup();
    renderStep({ baseAsset: "usd", outcomeCount: 4 });

    await openFunding(user);
    expect(screen.getByTestId("amm-funding-tier-minimal")).toHaveTextContent(
      "$100",
    );
    expect(screen.getByTestId("amm-funding-tier-standard")).toHaveTextContent(
      "$1,000",
    );
    expect(screen.getByTestId("amm-funding-tier-deep")).toHaveTextContent(
      "$5,000",
    );
    expect(screen.queryByText("$15.00")).not.toBeInTheDocument();
    expect(screen.queryByText("cents")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("confirm-amm-funding"));

    await waitFor(() => {
      expect(requestEcashDeposit).toHaveBeenCalledWith(
        "cond-test-abc123",
        DEPOSIT_ID,
        100_000,
        "cashuBlocally-generated",
        expect.objectContaining({
          fundAmm: true,
          unit: "usd",
          divisibility: 1_000,
        }),
      );
    });
  });
});
