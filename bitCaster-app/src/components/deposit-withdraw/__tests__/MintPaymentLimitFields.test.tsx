import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { DepositLightning } from "../DepositLightning";
import { PayLightning } from "../PayLightning";

const LIMIT_ERROR = "This mint accepts 1 to 200,000 sats for each deposit. Deposit in parts.";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

describe("DepositLightning mint limits", () => {
  it("shows no limit text while the amount is inside the limits", () => {
    render(<DepositLightning mints={[]} selectedMintId="" amountSats={23} amountError={null} />);
    expect(screen.queryByTestId("deposit-amount-error")).not.toBeInTheDocument();
    expect(screen.queryByText(/sats for each deposit/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Invoice" })).toBeEnabled();
  });

  it("shows the limit next to the amount and disables invoice creation outside the limits", () => {
    const onCreateInvoice = vi.fn();
    render(
      <DepositLightning
        mints={[]}
        selectedMintId=""
        amountSats={300_000}
        amountError={LIMIT_ERROR}
        onCreateInvoice={onCreateInvoice}
      />,
    );
    expect(screen.getByTestId("deposit-amount-error")).toHaveTextContent(LIMIT_ERROR);
    expect(screen.getByRole("alert")).toHaveTextContent(LIMIT_ERROR);
    const button = screen.getByRole("button", { name: "Create Invoice" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onCreateInvoice).not.toHaveBeenCalled();
  });
});

describe("PayLightning mint limits", () => {
  it("shows the withdrawal limit next to the invoice field only when one is given", () => {
    const message = "This mint accepts 1 to 150,000 sats for each withdrawal. Withdraw in parts.";
    const { rerender } = render(
      <PayLightning mints={[]} selectedMintId="" lightningInput="lnbc2m1pfake" />,
    );
    expect(screen.queryByTestId("withdrawal-invoice-error")).not.toBeInTheDocument();
    rerender(
      <PayLightning
        mints={[]}
        selectedMintId=""
        lightningInput="lnbc2m1pfake"
        invoiceError={message}
      />,
    );
    expect(screen.getByTestId("withdrawal-invoice-error")).toHaveTextContent(message);
  });
});
