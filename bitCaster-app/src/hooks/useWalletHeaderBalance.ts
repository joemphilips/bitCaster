import { useWalletProfileExpected, useWalletRecoveryStatus } from "@/hooks/useWalletRecoveryStatus";
import { walletRecoveryDisplay, walletRecoveryHoldingsUnknown } from "@/lib/walletRecoveryDisplay";

/**
 * The header balance of the active wallet, or null while the wallet recovery
 * checks, waits or failed (issue #161). A visitor without a wallet keeps the
 * plain balance.
 */
export function useWalletHeaderBalance(balance: number): number | null {
  const display = walletRecoveryDisplay({
    status: useWalletRecoveryStatus(),
    profileExpected: useWalletProfileExpected(),
  });
  return walletRecoveryHoldingsUnknown(display) ? null : balance;
}
