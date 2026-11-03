import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import { InsufficientBalanceModal } from "../InsufficientBalanceModal";
import { ParticipationScoreHelp } from "../ParticipationScoreHelp";

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

  it("puts the title help beside the heading without changing the heading name", async () => {
    const user = userEvent.setup();
    const handlers = renderModal({
      title: i18n.t("insufficientBalance.scoreTitle"),
      requiredDescription: i18n.t("insufficientBalance.scoreNeeds"),
      titleHelp: <ParticipationScoreHelp />,
    });

    expect(
      screen.getByRole("heading", { name: "Top Up Participation Score", level: 2 }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Participation Score needs/)).toBeInTheDocument();
    const help = screen.getByRole("button", { name: "About Participation Score" });
    await user.click(help);

    expect(screen.getByRole("tooltip")).toHaveTextContent("An anti-spam fee.");
    expect(handlers.onCancel).not.toHaveBeenCalled();
    expect(handlers.onTopUp).not.toHaveBeenCalled();
  });

  it("shows no title help by default", () => {
    renderModal();

    expect(screen.queryByRole("button", { name: "About Participation Score" })).toBeNull();
  });

  it("does not present an unknown local balance as zero", () => {
    renderModal({ balance: null, recoveryUnavailable: true });

    expect(screen.getByText("The balance in this browser is unavailable.")).toBeInTheDocument();
    expect(screen.getByText("Wallet recovery is currently unavailable.")).toBeInTheDocument();
    expect(screen.queryByText(/^0 sats$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/you have/i)).not.toBeInTheDocument();
  });

  it("routes native cancel to the owner without starting top-up", () => {
    const handlers = renderModal();

    fireEvent(
      screen.getByRole("dialog", { name: "Insufficient Balance" }),
      new Event("cancel", { cancelable: true }),
    );

    expect(handlers.onCancel).toHaveBeenCalledOnce();
    expect(handlers.onTopUp).not.toHaveBeenCalled();
  });

  it("dismisses only when its layout backdrop is clicked", () => {
    const handlers = renderModal();

    fireEvent.click(screen.getByRole("heading", { name: "Insufficient Balance" }));

    expect(handlers.onCancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("insufficient-balance-dialog-backdrop"));

    expect(handlers.onCancel).toHaveBeenCalledOnce();
  });
});
