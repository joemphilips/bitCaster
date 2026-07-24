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
        baseAsset="usd"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByText(/This mint charges \$25\.00/)).toBeInTheDocument();
    expect(screen.getByText("$10.00")).toBeInTheDocument();
    expect(screen.queryByText(/This mint charges \$15\.00/)).not.toBeInTheDocument();
  });
});
