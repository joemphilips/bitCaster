import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, it, expect, vi } from "vitest";
import { InvoiceDisplay } from "../InvoiceDisplay";
import { TokenDisplay } from "../TokenDisplay";
import { MeltConfirmation } from "../MeltConfirmation";
import { SuccessView } from "../SuccessView";

afterEach(() => {
  vi.useRealTimers();
});

describe("InvoiceDisplay", () => {
  const bolt11 = "lnbc10u1pjexampleinvoice";

  it('shows "Waiting for payment..." when status is pending', () => {
    render(<InvoiceDisplay bolt11={bolt11} amountSats={1000} status="pending" />);
    expect(screen.getByText("Waiting for payment...")).toBeInTheDocument();
  });

  it('shows "Payment received!" when status is paid', () => {
    render(<InvoiceDisplay bolt11={bolt11} amountSats={1000} status="paid" />);
    expect(screen.getByText("Payment received!")).toBeInTheDocument();
  });

  it('shows "Invoice expired" when status is expired', () => {
    render(<InvoiceDisplay bolt11={bolt11} amountSats={1000} status="expired" />);
    expect(screen.getByText(/invoice expired/i)).toBeInTheDocument();
  });

  it("shows the live countdown when expiresAtSec is in the future", () => {
    const expiresAtSec = Math.floor(Date.now() / 1000) + 5 * 60 + 32;
    render(
      <InvoiceDisplay
        bolt11={bolt11}
        amountSats={1000}
        status="pending"
        expiresAtSec={expiresAtSec}
      />,
    );
    // "Awaiting payment (expires in 5m XXs)" — XXs may be 31 or 32 depending on
    // the millisecond round-down inside formatRemaining; both are correct.
    expect(screen.getByText(/Awaiting payment \(expires in 5m \d+s\)/)).toBeInTheDocument();
  });

  it("renders an onRegenerate button when status is expired", async () => {
    const onRegenerate = vi.fn();
    render(
      <InvoiceDisplay
        bolt11={bolt11}
        amountSats={1000}
        status="expired"
        onRegenerate={onRegenerate}
      />,
    );
    const regen = screen.getByRole("button", { name: /re-quote/i });
    await userEvent.click(regen);
    expect(onRegenerate).toHaveBeenCalledOnce();
  });

  it("surfaces errorMessage under the status when expired", () => {
    render(
      <InvoiceDisplay
        bolt11={bolt11}
        amountSats={1000}
        status="expired"
        errorMessage="The Lightning invoice expired before payment arrived."
      />,
    );
    expect(
      screen.getByText("The Lightning invoice expired before payment arrived."),
    ).toBeInTheDocument();
  });

  it("displays the amount", () => {
    render(<InvoiceDisplay bolt11={bolt11} amountSats={42000} status="pending" />);
    expect(screen.getByText(/42,000/)).toBeInTheDocument();
  });

  it("shows the bolt11 string (truncated)", () => {
    render(<InvoiceDisplay bolt11={bolt11} amountSats={1000} status="pending" />);
    expect(screen.getByText(bolt11)).toBeInTheDocument();
  });

  it("calls onClose when X is clicked", async () => {
    const onClose = vi.fn();
    render(<InvoiceDisplay bolt11={bolt11} amountSats={1000} status="pending" onClose={onClose} />);
    const buttons = screen.getAllByRole("button");
    await userEvent.click(buttons[0]); // X button
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("copies bolt11 to clipboard when copy button is clicked", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<InvoiceDisplay bolt11={bolt11} amountSats={1000} status="pending" />);
    // Find the copy button (last button, not the X)
    const buttons = screen.getAllByRole("button");
    const copyButton = buttons[buttons.length - 1];
    await userEvent.click(copyButton);
    expect(writeText).toHaveBeenCalledWith(bolt11);
  });
});

describe("TokenDisplay", () => {
  const token = "cashuAeyJ0b2tlbiI6W3sicH...";

  it("displays the amount", () => {
    render(<TokenDisplay token={token} amountSats={500} proofCount={1} />);
    expect(screen.getByText(/500/)).toBeInTheDocument();
  });

  it("shows the token string", () => {
    render(<TokenDisplay token={token} amountSats={500} proofCount={1} />);
    expect(screen.getByText(token)).toBeInTheDocument();
  });

  it("shows the sharing instruction", () => {
    render(<TokenDisplay token={token} amountSats={500} proofCount={1} />);
    expect(screen.getByText(/share this token/i)).toBeInTheDocument();
  });

  it("calls onClose when X is clicked", async () => {
    const onClose = vi.fn();
    render(<TokenDisplay token={token} amountSats={500} proofCount={1} onClose={onClose} />);
    const buttons = screen.getAllByRole("button");
    await userEvent.click(buttons[0]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("copies token to clipboard when copy button is clicked", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<TokenDisplay token={token} amountSats={500} proofCount={1} />);
    const buttons = screen.getAllByRole("button");
    const copyButton = buttons[buttons.length - 1];
    await userEvent.click(copyButton);
    expect(writeText).toHaveBeenCalledWith(token);
  });
});

describe("MeltConfirmation", () => {
  const invoice = "lnbc10u1pjexample...";

  it("shows the amount breakdown", () => {
    render(<MeltConfirmation amountSats={1000} feeSats={10} invoice={invoice} isPaying={false} />);
    expect(screen.getByText("Invoice amount")).toBeInTheDocument();
    expect(screen.getByText("Network fee (estimate)")).toBeInTheDocument();
    expect(screen.getByText("Total")).toBeInTheDocument();
  });

  it("shows correct total (amount + fees)", () => {
    render(<MeltConfirmation amountSats={1000} feeSats={10} invoice={invoice} isPaying={false} />);
    expect(screen.getByText(/1,010/)).toBeInTheDocument();
  });

  it("shows PAY button when not paying", () => {
    render(<MeltConfirmation amountSats={1000} feeSats={10} invoice={invoice} isPaying={false} />);
    expect(screen.getByRole("button", { name: /pay/i })).not.toBeDisabled();
  });

  it("shows Paying... when isPaying is true", () => {
    render(<MeltConfirmation amountSats={1000} feeSats={10} invoice={invoice} isPaying={true} />);
    expect(screen.getByText(/paying/i)).toBeInTheDocument();
  });

  it("disables PAY and close buttons when isPaying", () => {
    render(<MeltConfirmation amountSats={1000} feeSats={10} invoice={invoice} isPaying={true} />);
    const buttons = screen.getAllByRole("button");
    // Close button (first) should be disabled
    expect(buttons[0]).toBeDisabled();
    // Pay button (last) should be disabled
    expect(buttons[buttons.length - 1]).toBeDisabled();
  });

  it("calls onConfirm when PAY is clicked", async () => {
    const onConfirm = vi.fn();
    render(
      <MeltConfirmation
        amountSats={1000}
        feeSats={10}
        invoice={invoice}
        isPaying={false}
        onConfirm={onConfirm}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /pay/i }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("calls onClose when X is clicked", async () => {
    const onClose = vi.fn();
    render(
      <MeltConfirmation
        amountSats={1000}
        feeSats={10}
        invoice={invoice}
        isPaying={false}
        onClose={onClose}
      />,
    );
    const buttons = screen.getAllByRole("button");
    await userEvent.click(buttons[0]);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("SuccessView", () => {
  it("auto-advances after a fixed 3 seconds and renders the countdown bar", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();

    render(<SuccessView amountSats={1000} onClose={onClose} />);

    expect(screen.getByRole("progressbar", { name: "Auto-advance countdown" })).toBeInTheDocument();
    expect(screen.getByTestId("auto-advance-progress")).toHaveStyle({ width: "100%" });

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1499);
    });
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
