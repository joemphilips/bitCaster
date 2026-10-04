import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { WalletBackupPresentationProvider } from "@/hooks/WalletBackupPresentation";
import { DepositLightning } from "../DepositLightning";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

it("puts backup Retry on the full-screen deposit interaction and leaves the amount and submission unchanged", () => {
  const retryRecovery = vi.fn();
  const onCreateInvoice = vi.fn();
  const view = (
    <DepositLightning
      mints={[]}
      selectedMintId=""
      amountSats={23}
      onCreateInvoice={onCreateInvoice}
    />
  );
  const { rerender } = render(
    <WalletBackupPresentationProvider value={{ recoveryStatus: { kind: "failed" }, retryRecovery }}>
      {view}
    </WalletBackupPresentationProvider>,
  );
  const content = screen.getByTestId("deposit-lightning-content");
  expect(
    within(content).getByRole("status", { name: "Wallet backup stopped" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create Invoice" })).toBeDisabled();
  fireEvent.click(within(content).getByRole("button", { name: "Retry wallet backup" }));
  expect(retryRecovery).toHaveBeenCalledOnce();
  expect(onCreateInvoice).not.toHaveBeenCalled();
  rerender(
    <WalletBackupPresentationProvider
      value={{ recoveryStatus: { kind: "preparing", reason: "authentication" }, retryRecovery }}
    >
      {view}
    </WalletBackupPresentationProvider>,
  );
  expect(screen.getByRole("button", { name: "Create Invoice" })).toBeDisabled();
  rerender(
    <WalletBackupPresentationProvider value={{ recoveryStatus: { kind: "ready" }, retryRecovery }}>
      {view}
    </WalletBackupPresentationProvider>,
  );
  expect(screen.getByRole("button", { name: "Create Invoice" })).toBeEnabled();
  expect(onCreateInvoice).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Create Invoice" }));
  expect(onCreateInvoice).toHaveBeenCalledOnce();
});
