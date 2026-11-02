import { useEffect } from "react";
import {
  activeBrowserWalletScopeId,
  browserWalletScopeIdFromMnemonic,
} from "@/lib/browserWalletProfile";
import { assertNever } from "@/lib/enumDiscipline";
import { createHeldPositionCloseReconciler } from "@/lib/heldPositionCloseNotifications";
import { onAnyMarketStatusChanged } from "@/lib/marketHub";
import { readCanonicalPortfolioCustody } from "@/stores/portfolio-custody";
import { useWalletStore } from "@/stores/wallet";

/**
 * Mount once at the app root. Adds the in-app won or lost entry for each held
 * position whose market closed with a verified outcome.
 *
 * It reconciles every held condition at start and when the tab becomes
 * visible. A live close reconciles only its condition. A live close arrives
 * only for a condition that a market page or the Portfolio already observes;
 * this hook joins no group and does not poll.
 */
export function useHeldPositionCloseNotifications(): void {
  const walletMnemonic = useWalletStore((state) => state.mnemonic);

  useEffect(() => {
    const scopeId = browserWalletScopeIdFromMnemonic(walletMnemonic);
    if (scopeId === null) return;
    const reconciler = createHeldPositionCloseReconciler({
      scopeId,
      isCurrent: () => activeBrowserWalletScopeId() === scopeId,
      readCustody: () => readCanonicalPortfolioCustody(scopeId),
    });

    void reconciler.request();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void reconciler.request();
    };
    document.addEventListener("visibilitychange", onVisibility);
    const removeStatusListener = onAnyMarketStatusChanged((status) => {
      switch (status.state) {
        case "open":
          return;
        case "closed":
          void reconciler.request(status);
          return;
        default:
          return assertNever(status.state);
      }
    });

    return () => {
      reconciler.dispose();
      document.removeEventListener("visibilitychange", onVisibility);
      removeStatusListener();
    };
  }, [walletMnemonic]);
}
