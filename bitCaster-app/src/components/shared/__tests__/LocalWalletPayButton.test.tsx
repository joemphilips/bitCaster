import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "@/i18n";
import { LocalWalletPayButton } from "../LocalWalletPayButton";

const executeGuiLocalWalletPayment = vi.fn();
const retryGuiEcashDeposit = vi.fn();
let walletBalance = 200;

vi.mock("@/lib/guiMarketFundingPayment", () => ({
  executeGuiLocalWalletPayment: (...args: unknown[]) =>
    executeGuiLocalWalletPayment(...args),
  retryGuiEcashDeposit: (...args: unknown[]) => retryGuiEcashDeposit(...args),
}));

vi.mock("@/stores/wallet", () => ({
  useBalance: () => walletBalance,
  useWalletStore: (selector: (state: { activeMintUrl: string }) => unknown) =>
    selector({ activeMintUrl: "https://mint.example" }),
}));

describe("LocalWalletPayButton", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    walletBalance = 200;
    executeGuiLocalWalletPayment.mockReset();
    retryGuiEcashDeposit.mockReset();
    executeGuiLocalWalletPayment.mockResolvedValue({ status: "completed" });
    retryGuiEcashDeposit.mockResolvedValue({
      status: "completed",
      depositId: "00000000-0000-4000-8000-000000000001",
    });
  });

  it("delegates the payment to the durable GUI coordinator", async () => {
    const user = userEvent.setup();
    const onTokenPayment = vi.fn().mockResolvedValue("credited");
    renderButton(onTokenPayment);

    await user.click(screen.getByTestId("pay"));

    await waitFor(() =>
      expect(executeGuiLocalWalletPayment).toHaveBeenCalledWith({
        mintUrl: "https://mint.example",
        amountSubunits: 100,
        baseAsset: "sat",
        unit: "sat",
        request: {
          conditionId: "condition-a",
          divisibility: 10_000,
          fundAmm: true,
          fundingIdentity: "funder-a",
          creatorPubkey: "funder-a",
        },
        remote: expect.objectContaining({ submit: onTokenPayment }),
      }),
    );
  });

  it("surfaces local persistence failures from the coordinator", async () => {
    const user = userEvent.setup();
    const onPaymentResult = vi.fn();
    executeGuiLocalWalletPayment.mockRejectedValueOnce(
      new DOMException("quota exhausted", "QuotaExceededError"),
    );
    renderButton(vi.fn(), { onPaymentResult });

    await user.click(screen.getByTestId("pay"));

    expect(await screen.findByText("quota exhausted")).toBeInTheDocument();
    expect(onPaymentResult).not.toHaveBeenCalled();
  });

  it("shows the transport error while the coordinator keeps authority pending", async () => {
    const user = userEvent.setup();
    executeGuiLocalWalletPayment.mockResolvedValueOnce({
      status: "transport-ambiguous",
      depositId: "00000000-0000-4000-8000-000000000001",
      error: "response lost",
    });
    const onPaymentResult = vi.fn();
    renderButton(vi.fn(), { onPaymentResult });

    await user.click(screen.getByTestId("pay"));

    expect(await screen.findByText("response lost")).toBeInTheDocument();
    expect(onPaymentResult).toHaveBeenCalledWith({
      status: "transport-ambiguous",
      depositId: "00000000-0000-4000-8000-000000000001",
      error: "response lost",
    });
  });

  it("retries a pinned deposit through its exact durable coordinator", async () => {
    const user = userEvent.setup();
    const onPaymentResult = vi.fn();
    walletBalance = 0;
    renderButton(vi.fn(), {
      retryDepositId: "00000000-0000-4000-8000-000000000001",
      onPaymentResult,
    });

    await user.click(screen.getByTestId("pay"));

    expect(executeGuiLocalWalletPayment).not.toHaveBeenCalled();
    expect(retryGuiEcashDeposit).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
      expect.objectContaining({
        currentFundingIdentity: expect.any(Function),
        getStatus: expect.any(Function),
        submit: expect.any(Function),
      }),
    );
    expect(onPaymentResult).toHaveBeenCalledWith({
      status: "completed",
      depositId: "00000000-0000-4000-8000-000000000001",
    });
  });
});

function renderButton(
  onTokenPayment: (...args: never[]) => Promise<unknown>,
  options: {
    retryDepositId?: string;
    onPaymentResult?: (result: unknown) => void;
  } = {},
): void {
  render(
    <LocalWalletPayButton
      amountSubunits={100}
      baseAsset="sat"
      unit="sat"
      testId="pay"
      conditionId="condition-a"
      divisibility={10_000}
      fundAmm
      resolveFundingIdentity={() => ({
        fundingIdentity: "funder-a",
        creatorPubkey: "funder-a",
      })}
      getTokenPaymentStatus={vi.fn().mockResolvedValue(null)}
      retryDepositId={options.retryDepositId}
      onPaymentResult={options.onPaymentResult ?? vi.fn()}
      onTokenPayment={onTokenPayment as never}
    />,
  );
}
