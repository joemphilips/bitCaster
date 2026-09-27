import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { RegistrationFeeConfirmationModal } from "../RegistrationFeeConfirmationModal";

describe("RegistrationFeeConfirmationModal", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("shows the actual registration fee instead of the balance deficit", () => {
    render(
      <RegistrationFeeConfirmationModal
        feeSubunits={2_500}
        balanceSubunits={1_000}
        baseAsset="sat"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByText(/This mint charges 2\.5 sats/)).toBeInTheDocument();
    expect(screen.getByText("1 sats")).toBeInTheDocument();
    expect(screen.queryByText(/This mint charges 1\.5 sats/)).not.toBeInTheDocument();
  });

  it("routes native cancel to the owner without confirming the fee", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <RegistrationFeeConfirmationModal
        feeSubunits={2_500}
        balanceSubunits={1_000}
        baseAsset="sat"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    fireEvent(
      screen.getByRole("dialog", { name: "Pay market creation fee" }),
      new Event("cancel", { cancelable: true }),
    );

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("dismisses only when its layout backdrop is clicked", () => {
    const onCancel = vi.fn();
    render(
      <RegistrationFeeConfirmationModal
        feeSubunits={2_500}
        balanceSubunits={1_000}
        baseAsset="sat"
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("heading", { name: "Pay market creation fee" }));

    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("registration-fee-dialog-backdrop"));

    expect(onCancel).toHaveBeenCalledOnce();
  });
});
