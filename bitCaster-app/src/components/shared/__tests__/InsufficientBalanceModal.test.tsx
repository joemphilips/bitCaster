import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import { InsufficientBalanceModal } from "../InsufficientBalanceModal";

function renderModal(overrides: Partial<ComponentProps<typeof InsufficientBalanceModal>> = {}) {
  const onCancel = vi.fn();
  const onTopUp = vi.fn();
  const onRetry = vi.fn();

  render(
    <InsufficientBalanceModal
      balance={100}
      required={200}
      onCancel={onCancel}
      onTopUp={onTopUp}
      onRetry={onRetry}
      {...overrides}
    />,
  );

  return { onCancel, onTopUp, onRetry };
}

describe("InsufficientBalanceModal", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("keeps the default Cancel and Top Up controls when recovery is available", () => {
    renderModal();

    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Top Up" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(
      screen.queryByText(/funds available in this browser are insufficient/i),
    ).not.toBeInTheDocument();
  });

  it("shows unavailable recovery and only invokes callbacks after explicit button clicks", async () => {
    const user = userEvent.setup();
    const handlers = renderModal({ recoveryUnavailable: true });

    expect(
      screen.getByText(
        "Funds available in this browser are insufficient. Wallet recovery is currently unavailable.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(handlers.onCancel).not.toHaveBeenCalled();
    expect(handlers.onTopUp).not.toHaveBeenCalled();
    expect(handlers.onRetry).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await user.click(screen.getByRole("button", { name: "Top Up" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(handlers.onRetry).toHaveBeenCalledOnce();
    expect(handlers.onTopUp).toHaveBeenCalledOnce();
    expect(handlers.onCancel).toHaveBeenCalledOnce();
  });

  it("does not present an unknown local balance as zero", () => {
    renderModal({ balance: null, recoveryUnavailable: true });

    expect(screen.getByText("The balance in this browser is unavailable.")).toBeInTheDocument();
    expect(screen.getByText("Wallet recovery is currently unavailable.")).toBeInTheDocument();
    expect(screen.queryByText(/^0 sats$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/you have/i)).not.toBeInTheDocument();
  });
});
