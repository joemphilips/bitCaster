// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { EncryptedWalletBackupRecoveryStatus } from "../EncryptedWalletBackupRecoveryStatus";

vi.mock("react-i18next", async () => {
  const { default: en } = await import("@/i18n/locales/en.json");
  const copy = en.walletBackupRecovery;
  const translations: Record<string, string> = {
    "walletBackupRecovery.title": copy.title,
    "walletBackupRecovery.description": copy.description,
    "walletBackupRecovery.retry": copy.retry,
    ...Object.fromEntries(
      Object.entries(copy.reasons).map(([key, value]) => [
        `walletBackupRecovery.reasons.${key}`,
        value,
      ]),
    ),
  };
  return { useTranslation: () => ({ t: (key: string) => translations[key] ?? key }) };
});

it("shows the bounded reason and retries without a dismiss action", () => {
  const retry = vi.fn();
  render(
    <EncryptedWalletBackupRecoveryStatus
      recoveryStatus={{ kind: "recovering", reason: "remote-unavailable" }}
      retryRecovery={retry}
    />,
  );

  expect(screen.getByRole("status")).toHaveTextContent("Wallet actions are paused");
  expect(screen.getByText("The backup service or mint is unavailable.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry recovery" }));
  expect(retry).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: /dismiss/i })).not.toBeInTheDocument();
});

it("explains that an unpaid invoice can keep recovery blocked", () => {
  render(
    <EncryptedWalletBackupRecoveryStatus
      recoveryStatus={{ kind: "recovering", reason: "submitted-work-unresolved" }}
      retryRecovery={vi.fn()}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "An unpaid invoice can also block recovery.",
  );
  expect(screen.getByRole("status")).toHaveTextContent("Retrying may not clear it.");
});

it("hides after authoritative ready status", () => {
  const { rerender } = render(
    <EncryptedWalletBackupRecoveryStatus
      recoveryStatus={{ kind: "recovering", reason: null }}
      retryRecovery={vi.fn()}
    />,
  );
  expect(screen.getByRole("status")).toBeInTheDocument();
  rerender(
    <EncryptedWalletBackupRecoveryStatus
      recoveryStatus={{ kind: "ready" }}
      retryRecovery={vi.fn()}
    />,
  );
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
