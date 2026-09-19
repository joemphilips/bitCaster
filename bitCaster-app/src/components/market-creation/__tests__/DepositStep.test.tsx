import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import userEvent from "@testing-library/user-event";
import i18n from "@/i18n";
import { DepositStep } from "../DepositStep";

const executeBrowserMarketFundingDelivery = vi.fn();
const CONDITION_ID = "a".repeat(64);
const mockWalletState = { activeMintUrl: "https://mint.example", mnemonic: "test mnemonic" };

vi.mock("@/lib/browserMarketFundingDelivery", () => ({
  BrowserMarketFundingInsufficientBalanceError: class extends Error {},
  executeBrowserMarketFundingDelivery: (...args: unknown[]) =>
    executeBrowserMarketFundingDelivery(...args),
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
  await user.type(input, amount);
}

describe("DepositStep", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    mockWalletState.mnemonic = "test mnemonic";
    executeBrowserMarketFundingDelivery.mockReset();
    executeBrowserMarketFundingDelivery.mockResolvedValue({
      progress: "received",
      transfer: { requestedAmount: "100000000" },
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
          requestedAmount: "100000",
        }),
      );
    });
    expect(screen.getByText("Awaiting payment…")).toBeInTheDocument();
  });

  it("does not poll after recipient receipt and exposes a user retry action", async () => {
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    renderStep();
    const user = await openFunding();
    await enterFundingAmount(user);
    timeoutSpy.mockClear();

    await user.click(screen.getByTestId("confirm-amm-funding"));

    await screen.findByText("Awaiting payment…");
    expect(timeoutSpy.mock.calls.some(([, delay]) => delay === 2_000)).toBe(false);
    expect(screen.getByRole("button", { name: "Retry wallet payment" })).toBeEnabled();
    timeoutSpy.mockRestore();
  });

  it("navigates only after credited status", async () => {
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    executeBrowserMarketFundingDelivery.mockResolvedValueOnce({
      progress: "credited",
      transfer: { requestedAmount: "100000000" },
    });
    renderStep();
    const user = await openFunding();
    await enterFundingAmount(user);
    timeoutSpy.mockClear();

    await user.click(screen.getByTestId("confirm-amm-funding"));
    await screen.findByText("Payment received — crediting your market…");
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
      transfer: { requestedAmount: "100000" },
    });
    renderStep({ presentation: "detail" });
    const user = userEvent.setup();
    await enterFundingAmount(user);

    expect(timeoutSpy.mock.calls.some(([, delay]) => delay === 5_000)).toBe(false);
    await user.click(screen.getByTestId("confirm-amm-funding"));
    await screen.findByText("Payment received — crediting your market…");
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
          requestedAmount: "100000000",
        }),
      );
    });
  });

  it("rejects an inexact custom amount before invoking the funding adapter", async () => {
    renderStep({ presentation: "detail", divisibility: 1_000_000 });
    const user = userEvent.setup();

    const customBudget = screen.getByTestId("amm-funding-custom-budget");
    await user.clear(customBudget);
    await user.type(customBudget, "1");
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
        expect.objectContaining({ requestedAmount: "1000" }),
      );
    });
  });

  it("reflects the immutable resumed transfer amount in the exact sats field", async () => {
    executeBrowserMarketFundingDelivery.mockResolvedValueOnce({
      progress: "received",
      transfer: { requestedAmount: "200000" },
    });
    renderStep({ presentation: "detail" });
    const user = userEvent.setup();

    await enterFundingAmount(user, "100");
    await user.click(screen.getByTestId("confirm-amm-funding"));

    await screen.findByText("Awaiting payment…");
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
