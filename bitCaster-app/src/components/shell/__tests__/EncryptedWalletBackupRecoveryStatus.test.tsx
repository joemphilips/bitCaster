// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { EncryptedWalletBackupRecoveryStatus } from "../EncryptedWalletBackupRecoveryStatus";

vi.mock("react-i18next", async () => {
  const { default: en } = await import("@/i18n/locales/en.json");
  const copy = en.walletBackupRecovery;
  const translations: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(copy)
        .filter(([, value]) => typeof value === "string")
        .map(([key, value]) => [`walletBackupRecovery.${key}`, value]),
    ),
    "walletBackupRecovery.title": copy.title,
    "walletBackupRecovery.description": copy.description,
    "walletBackupRecovery.retry": copy.retry,
    ...Object.fromEntries(
      Object.entries(copy.reasons).map(([key, value]) => [
        `walletBackupRecovery.reasons.${key}`,
        value,
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(copy.preparingReasons).map(([key, value]) => [
        `walletBackupRecovery.preparingReasons.${key}`,
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

it("shows authentication preparation without calling it a wallet conflict or offering an inert recovery retry", () => {
  render(
    <EncryptedWalletBackupRecoveryStatus
      recoveryStatus={{ kind: "preparing", reason: "authentication" }}
      retryRecovery={vi.fn()}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Preparing wallet backup");
  expect(screen.getByRole("status")).toHaveTextContent("Checking this wallet's backup");
  expect(screen.getByRole("status")).not.toHaveTextContent("Another browser");
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

it("shows persistent terminal failure with an actionable startup retry and no private diagnostics", () => {
  const retry = vi.fn();
  render(
    <EncryptedWalletBackupRecoveryStatus
      recoveryStatus={{ kind: "failed" }}
      retryRecovery={retry}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Wallet backup stopped");
  expect(screen.getByRole("status")).toHaveTextContent("keeps your funds");
  fireEvent.click(screen.getByRole("button", { name: "Retry wallet backup" }));
  expect(retry).toHaveBeenCalledOnce();
  expect(screen.getByRole("status")).toBeInTheDocument();
});

it.each(["leadership-wait", "retry", "driver-unavailable"] as const)(
  "explains preparing stage %s without claiming a conflict",
  (reason) => {
    render(
      <EncryptedWalletBackupRecoveryStatus
        recoveryStatus={{ kind: "preparing", reason }}
        retryRecovery={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Preparing wallet backup");
    expect(screen.getByRole("status")).not.toHaveTextContent("Another browser changed");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  },
);

it("keeps startup and failure copy complete in English and Japanese", async () => {
  const { default: en } = await import("@/i18n/locales/en.json");
  const { default: ja } = await import("@/i18n/locales/ja.json");
  expect(Object.keys(ja.walletBackupRecovery).sort()).toEqual(
    Object.keys(en.walletBackupRecovery).sort(),
  );
  expect(Object.keys(ja.walletBackupRecovery.preparingReasons).sort()).toEqual(
    Object.keys(en.walletBackupRecovery.preparingReasons).sort(),
  );
  expect(ja.walletBackupRecovery.failedTitle).toBe("ウォレットバックアップが停止しました");
  expect(ja.walletBackupRecovery.retryStartup).toBe("バックアップを再試行");
});
