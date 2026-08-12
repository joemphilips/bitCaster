import { render, screen } from "@testing-library/react";
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
});
