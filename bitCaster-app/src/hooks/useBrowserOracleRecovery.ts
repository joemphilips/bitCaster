import { useEffect } from "react";
import { startBrowserOracleRecovery } from "@/lib/browserOracleRecovery";

/** Identity rehydration owns signer readiness. Mount recovery once at the application root. */
export function useBrowserOracleRecovery(nostrSignerReady: boolean): void {
  useEffect(() => {
    if (!nostrSignerReady) return;
    return startBrowserOracleRecovery();
  }, [nostrSignerReady]);
}
