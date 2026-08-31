import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import userEvent from "@testing-library/user-event";
import i18n from "@/i18n";
import { DepositStep } from "../DepositStep";

const executeBrowserMarketFundingDelivery = vi.fn();
const CONDITION_ID = "a".repeat(64);

vi.mock("@/lib/browserMarketFundingDelivery", () => ({
  BrowserMarketFundingInsufficientBalanceError: class extends Error {},
  executeBrowserMarketFundingDelivery: (...args: unknown[]) =>
    executeBrowserMarketFundingDelivery(...args),
}));

vi.mock("@/lib/identityOps", () => ({ resolveCreatorPubkey: () => "subject-1" }));

vi.mock("@/stores/wallet", () => ({
  useBalance: () => 200_000_000,
  useWalletStore: Object.assign(
    (selector: (state: { activeMintUrl: string }) => unknown) =>
      selector({ activeMintUrl: "https://mint.example" }),
    { getState: () => ({ activeMintUrl: "https://mint.example" }) },
  ),
}));

function renderStep(options: {
  presentation?: "creation" | "detail";
  divisibility?: 1_000 | 1_000_000;
} = {}) {
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

describe("DepositStep", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
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
      screen.getByText(
        "Choose the bot quoting budget for this market, or continue without bot liquidity.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Market created!")).not.toBeInTheDocument();
    expect(timeoutSpy.mock.calls.some(([, delay]) => delay === 5_000)).toBe(false);
    timeoutSpy.mockRestore();
  });

  it("uses the durable market-funding adapter without a legacy deposit request", async () => {
    renderStep();
    const user = await openFunding();

    await user.click(screen.getByTestId("confirm-amm-funding"));

    await waitFor(() => {
      expect(executeBrowserMarketFundingDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          accountSubject: "subject-1",
          mintUrl: "https://mint.example",
          unit: "msat",
          divisibility: 1_000,
          requestedAmount: "100000000",
        }),
      );
    });
    expect(screen.getByText("Awaiting payment…")).toBeInTheDocument();
  });

  it("does not poll after recipient receipt and exposes a user retry action", async () => {
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    renderStep();
    const user = await openFunding();
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
      transfer: { requestedAmount: "100000000" },
    });
    renderStep({ presentation: "detail" });
    const user = userEvent.setup();

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
});
