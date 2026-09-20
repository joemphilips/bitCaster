import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import userEvent from "@testing-library/user-event";
import i18n from "@/i18n";
import { DepositStep } from "../DepositStep";

const executeBrowserMarketFundingDelivery = vi.fn();
const readBrowserMarketFundingHeadId = vi.fn();
const CONDITION_ID = "a".repeat(64);
const mockWalletState = { activeMintUrl: "https://mint.example", mnemonic: "test mnemonic" };

vi.mock("@/lib/browserMarketFundingDelivery", () => ({
  BrowserMarketFundingInsufficientBalanceError: class extends Error {},
  executeBrowserMarketFundingDelivery: (...args: unknown[]) =>
    executeBrowserMarketFundingDelivery(...args),
  readBrowserMarketFundingHeadId: (...args: unknown[]) => readBrowserMarketFundingHeadId(...args),
}));

vi.mock("@/lib/identityOps", () => ({ resolveCreatorPubkey: () => "subject-1" }));

vi.mock("@/stores/wallet", () => ({
  useBalance: () => 200_000_000,
  useWalletStore: Object.assign(
    (selector: (state: typeof mockWalletState) => unknown) => selector(mockWalletState),
    { getState: () => mockWalletState },
  ),
}));

function renderStep(
  options: {
    presentation?: "creation" | "detail";
    divisibility?: 1_000 | 1_000_000;
    onRequireWallet?: () => void;
  } = {},
) {
  return render(
    <MemoryRouter initialEntries={["/creator/new"]}>
      <Routes>
        <Route
          path="/creator/new"
          element={
            <DepositStep
              conditionId={CONDITION_ID}
              defaultAmountSats={1000}
              outcomeCount={2}
              baseAsset="sat"
              divisibility={1_000}
              {...options}
            />
          }
        />
        <Route path="/markets/:id" element={<div data-testid="market-detail-page" />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function openFunding() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Attract Traders" }));
  return user;
}

async function enterFundingAmount(user: ReturnType<typeof userEvent.setup>, amount = "100") {
  const input = screen.getByTestId("amm-funding-custom-budget");
  await waitFor(() => expect(input).toBeEnabled());
  await user.type(input, amount);
}

describe("DepositStep", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    mockWalletState.mnemonic = "test mnemonic";
    executeBrowserMarketFundingDelivery.mockReset();
    readBrowserMarketFundingHeadId.mockReset();
    readBrowserMarketFundingHeadId.mockResolvedValue(null);
    executeBrowserMarketFundingDelivery.mockResolvedValue({
      progress: "received",
      transfer: { transferId: "payment-1", requestedAmount: "100000000" },
    });
  });

  it("keeps the creation handoff in the created stage before its five-second transition", () => {
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    const view = renderStep();

    expect(screen.getByText("Market created!")).toBeInTheDocument();
    expect(
      screen.getByText("You can optionally fund the market maker after creation."),
    ).toBeInTheDocument();
    const transition = timeoutSpy.mock.calls.find(([, delay]) => delay === 5_000);
    expect(transition).toBeDefined();

    act(() => (transition?.[0] as () => void)());
    expect(screen.getByText("Fund the market maker")).toBeInTheDocument();

    view.unmount();
    timeoutSpy.mockRestore();
  });

  it.each(["received", "credited"] as const)(
    "reload resumes %s; only credited permits an explicit next payment",
    async (progress) => {
      readBrowserMarketFundingHeadId.mockResolvedValue("payment-1");
      executeBrowserMarketFundingDelivery.mockResolvedValue({
        progress,
        transfer: { transferId: "payment-1", requestedAmount: "100000" },
      });
      renderStep({ presentation: "detail" });
      await waitFor(() => expect(screen.getByTestId("confirm-amm-funding")).toBeEnabled());
      expect(executeBrowserMarketFundingDelivery).toHaveBeenCalledTimes(1);
      expect(executeBrowserMarketFundingDelivery.mock.calls[0]![0].attempt).toEqual({
        kind: "resume",
        transferId: "payment-1",
      });
      expect(screen.getByTestId("amm-funding-custom-budget")).toHaveValue("100");

      await userEvent.setup().click(screen.getByTestId("confirm-amm-funding"));
      await waitFor(() => expect(executeBrowserMarketFundingDelivery).toHaveBeenCalledTimes(2));
      expect(executeBrowserMarketFundingDelivery.mock.calls[1]![0].attempt).toEqual(
        progress === "credited"
          ? {
              kind: "begin",
              expectedPreviousTransferId: "payment-1",
              newAttemptId: expect.any(String),
              requestedAmount: "100000",
            }
          : { kind: "resume", transferId: "payment-1" },
      );
    },
  );

  it("retries a failed head read without creating a payment", async () => {
    readBrowserMarketFundingHeadId.mockRejectedValueOnce(new Error("wallet read unavailable"));
    renderStep({ presentation: "detail" });
    await screen.findByRole("alert");
    expect(screen.getByTestId("confirm-amm-funding")).toBeDisabled();
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry wallet payment" }));
    await waitFor(() => expect(readBrowserMarketFundingHeadId).toHaveBeenCalledTimes(2));
    expect(executeBrowserMarketFundingDelivery).not.toHaveBeenCalled();
  });

  it("ignores a late funding head from the previous condition", async () => {
    let resolvePrevious!: (value: string) => void;
    readBrowserMarketFundingHeadId.mockReturnValueOnce(
      new Promise<string>((resolve) => { resolvePrevious = resolve; }),
    );
    const step = (conditionId: string) => (
      <MemoryRouter>
        <DepositStep
          conditionId={conditionId}
          presentation="detail"
          defaultAmountSats={1000}
          outcomeCount={2}
          baseAsset="sat"
          divisibility={1_000}
        />
      </MemoryRouter>
    );
    const view = render(step(CONDITION_ID));
    expect(screen.getByTestId("amm-funding-custom-budget")).toBeDisabled();
    view.rerender(step("b".repeat(64)));
    await waitFor(() => expect(screen.getByTestId("amm-funding-custom-budget")).toBeEnabled());

    await act(async () => resolvePrevious("previous-condition-payment"));

    expect(executeBrowserMarketFundingDelivery).not.toHaveBeenCalled();
    expect(screen.getByTestId("amm-funding-custom-budget")).toHaveValue("");
  });

  it("starts directly in funding presentation for market detail", () => {
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    renderStep({ presentation: "detail" });

    expect(screen.getByText("Fund the market maker")).toBeInTheDocument();
    expect(
      screen.getByText("Enter the exact amount of sats to give the market maker, or skip for now."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("skip-amm-funding")).not.toBeInTheDocument();
    expect(screen.queryByText("Market created!")).not.toBeInTheDocument();
    expect(timeoutSpy.mock.calls.some(([, delay]) => delay === 5_000)).toBe(false);
    timeoutSpy.mockRestore();
  });

  it.each([
    ["pending", "Awaiting payment…"],
    ["received", "Payment received — waiting for market credit…"],
    ["credited", "Payment credited — market funding complete."],
  ] as const)("renders %s funding progress honestly", async (progress, message) => {
    executeBrowserMarketFundingDelivery.mockResolvedValueOnce({
      progress,
      transfer: { transferId: "payment-1", requestedAmount: "100000" },
    });
    renderStep({ presentation: "detail" });
    const user = userEvent.setup();
    await enterFundingAmount(user);

    await user.click(screen.getByTestId("confirm-amm-funding"));

    await screen.findByText(message);
  });

  it("uses the durable market-funding adapter without a legacy deposit request", async () => {
    renderStep();
    const user = await openFunding();
    await enterFundingAmount(user);

    await user.click(screen.getByTestId("confirm-amm-funding"));

    await waitFor(() => {
      expect(executeBrowserMarketFundingDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          accountSubject: "subject-1",
          mintUrl: "https://mint.example",
          unit: "msat",
          divisibility: 1_000,
          attempt: expect.objectContaining({
            kind: "begin",
            expectedPreviousTransferId: null,
            requestedAmount: "100000",
          }),
        }),
      );
    });
    expect(screen.getByText("Payment received — waiting for market credit…")).toBeInTheDocument();
  });

  it("does not poll after recipient receipt and exposes a user retry action", async () => {
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    renderStep();
    const user = await openFunding();
    await enterFundingAmount(user);
    timeoutSpy.mockClear();

    await user.click(screen.getByTestId("confirm-amm-funding"));

    await screen.findByText("Payment received — waiting for market credit…");
    expect(timeoutSpy.mock.calls.some(([, delay]) => delay === 2_000)).toBe(false);
    expect(screen.getByRole("button", { name: "Retry wallet payment" })).toBeEnabled();
    timeoutSpy.mockRestore();
  });

  it("navigates only after credited status", async () => {
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    executeBrowserMarketFundingDelivery.mockResolvedValueOnce({
      progress: "credited",
      transfer: { transferId: "payment-1", requestedAmount: "100000000" },
    });
    renderStep();
    const user = await openFunding();
    await enterFundingAmount(user);
    timeoutSpy.mockClear();

    await user.click(screen.getByTestId("confirm-amm-funding"));
    await screen.findByText("Payment credited — market funding complete.");
    const call = timeoutSpy.mock.calls.find(([, delay]) => delay === 5_000);
    expect(call).toBeDefined();
    act(() => (call?.[0] as () => void)());
    expect(screen.getByTestId("market-detail-page")).toBeInTheDocument();
    timeoutSpy.mockRestore();
  });

  it("does not schedule timers or navigate after credited in detail presentation", async () => {
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    executeBrowserMarketFundingDelivery.mockResolvedValueOnce({
      progress: "credited",
      transfer: { transferId: "payment-1", requestedAmount: "100000" },
    });
    renderStep({ presentation: "detail" });
    const user = userEvent.setup();
    await enterFundingAmount(user);

    expect(timeoutSpy.mock.calls.some(([, delay]) => delay === 5_000)).toBe(false);
    await user.click(screen.getByTestId("confirm-amm-funding"));
    await screen.findByText("Payment credited — market funding complete.");
    expect(timeoutSpy.mock.calls.some(([, delay]) => delay === 5_000)).toBe(false);
    expect(screen.queryByTestId("market-detail-page")).not.toBeInTheDocument();
    timeoutSpy.mockRestore();
  });

  it("forwards the supplied market divisibility to the funding adapter", async () => {
    renderStep({ presentation: "detail", divisibility: 1_000_000 });
    const user = userEvent.setup();
    await enterFundingAmount(user, "100000");

    await user.click(screen.getByTestId("confirm-amm-funding"));

    await waitFor(() => {
      expect(executeBrowserMarketFundingDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          divisibility: 1_000_000,
          attempt: expect.objectContaining({ requestedAmount: "100000000" }),
        }),
      );
    });
  });

  it("rejects an inexact custom amount before invoking the funding adapter", async () => {
    renderStep({ presentation: "detail", divisibility: 1_000_000 });
    const user = userEvent.setup();

    await enterFundingAmount(user, "1");
    await user.click(screen.getByTestId("confirm-amm-funding"));

    expect(executeBrowserMarketFundingDelivery).not.toHaveBeenCalled();
    expect(
      screen.getByText("Enter an amount divisible by 1000000 market subunits."),
    ).toBeInTheDocument();
  });

  it("converts the exact sats field through the SDK parser", async () => {
    renderStep({ presentation: "detail" });
    const user = userEvent.setup();

    await enterFundingAmount(user, "1.000");
    await user.click(screen.getByTestId("confirm-amm-funding"));

    await waitFor(() => {
      expect(executeBrowserMarketFundingDelivery).toHaveBeenCalledWith(
        expect.objectContaining({ attempt: expect.objectContaining({ requestedAmount: "1000" }) }),
      );
    });
  });

  it("reflects the immutable resumed transfer amount in the exact sats field", async () => {
    executeBrowserMarketFundingDelivery.mockResolvedValueOnce({
      progress: "received",
      transfer: { transferId: "payment-1", requestedAmount: "200000" },
    });
    renderStep({ presentation: "detail" });
    const user = userEvent.setup();

    await enterFundingAmount(user, "100");
    await user.click(screen.getByTestId("confirm-amm-funding"));

    await screen.findByText("Payment received — waiting for market credit…");
    expect(screen.getByTestId("amm-funding-custom-budget")).toHaveValue("200");
  });

  it("skips funding without invoking the wallet delivery adapter", async () => {
    renderStep();
    const user = await openFunding();

    await user.click(screen.getByTestId("skip-amm-funding"));

    expect(screen.getByTestId("market-detail-page")).toBeInTheDocument();
    expect(executeBrowserMarketFundingDelivery).not.toHaveBeenCalled();
  });

  it("invokes the caller wallet chooser before detail funding when no wallet exists", async () => {
    mockWalletState.mnemonic = "";
    const onRequireWallet = vi.fn();
    renderStep({ presentation: "detail", onRequireWallet });
    const user = userEvent.setup();

    await enterFundingAmount(user);
    await user.click(screen.getByTestId("confirm-amm-funding"));

    expect(onRequireWallet).toHaveBeenCalledOnce();
    expect(executeBrowserMarketFundingDelivery).not.toHaveBeenCalled();
  });

  it("surfaces wallet absence when detail funding has no chooser caller", async () => {
    mockWalletState.mnemonic = "";
    renderStep({ presentation: "detail" });
    const user = userEvent.setup();

    await enterFundingAmount(user);
    await user.click(screen.getByTestId("confirm-amm-funding"));

    expect(
      screen.getByText("Set up a wallet before funding the market maker."),
    ).toBeInTheDocument();
    expect(executeBrowserMarketFundingDelivery).not.toHaveBeenCalled();
  });
});
