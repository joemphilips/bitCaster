import { createContext, useContext, type ReactNode } from "react";
import type { EncryptedWalletBackupDriverState } from "./useEncryptedWalletBackupDriver";
import { BrowserWalletRecoveryRequiredError } from "@/lib/browserWalletNewWritePermission";
import { assertNever } from "@/lib/enumDiscipline";

const WalletBackupPresentation = createContext<EncryptedWalletBackupDriverState | null>(null);

/** Shares the app-owned driver's presentation. It never grants wallet write permission. */
export function WalletBackupPresentationProvider({
  value,
  children,
}: {
  value: EncryptedWalletBackupDriverState;
  children: ReactNode;
}) {
  return (
    <WalletBackupPresentation.Provider value={value}>{children}</WalletBackupPresentation.Provider>
  );
}

export function useWalletBackupPresentation() {
  return useContext(WalletBackupPresentation);
}

export function walletBackupPausesNewChanges(
  state: EncryptedWalletBackupDriverState | null,
): boolean {
  if (state === null) return false;
  switch (state.recoveryStatus.kind) {
    case "ready":
      return false;
    case "preparing":
    case "failed":
    case "recovering":
      return true;
    default:
      return assertNever(state.recoveryStatus);
  }
}

export function walletBackupWriteErrorMessage(
  error: unknown,
  translate: (key: string) => string,
): string {
  if (error instanceof BrowserWalletRecoveryRequiredError) {
    switch (error.reason) {
      case "startup-authentication-pending":
        return translate("walletBackupRecovery.topUpNotReady");
      case "genuine-conflict":
        return translate("walletBackupRecovery.topUpRecoveryRequired");
      default:
        return assertNever(error.reason);
    }
  }
  return error instanceof Error ? error.message : translate("walletBackupRecovery.topUpFailed");
}
