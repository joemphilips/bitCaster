import { useWalletProfileExpected, useWalletRecoveryStatus } from "@/hooks/useWalletRecoveryStatus";
import { walletRecoveryDisplay, walletRecoveryZeroUnknown } from "@/lib/walletRecoveryDisplay";

/**
 * The header balance of the active wallet, or null while the wallet recovery
 * checks, waits or failed (issue #161). After a recovery with limited
 * coverage, a zero balance is not final, so it is null too. A balance above
 * zero stays. A visitor without a wallet keeps the plain balance.
 */
export function useWalletHeaderBalance(balance: number): number | null {
  const status = useWalletRecoveryStatus();
  const display = walletRecoveryDisplay({ status, profileExpected: useWalletProfileExpected() });
  if (balance > 0 && display.state === "complete") return balance;
  return walletRecoveryZeroUnknown(status, display) ? null : balance;
}
