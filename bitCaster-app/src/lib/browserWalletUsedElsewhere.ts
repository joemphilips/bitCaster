import i18n from "@/i18n";
import { useToastStore, type Toast } from "@/stores/toast";
import { activeBrowserWalletScopeId } from "./browserWalletProfile";

/** The notice after the browser met an output of another client. Its action needs a third line. */
export function usedInAnotherBrowserToast(): Omit<Toast, "id"> {
  return { type: "info", message: i18n.t("wallet.usedInAnotherBrowser"), lines: 3 };
}

/**
 * Show that another client of this seed signed an output (ADR-051 "Restore",
 * ADR-033): a hit of the order output check, a mint refusal 11003 or 11008,
 * or a hit of the keyset re-sync. The toast store replaces a visible copy of
 * the same message, so several keysets of one order show one notice.
 */
export function reportBrowserWalletUsedElsewhere(scopeId: string): void {
  if (activeBrowserWalletScopeId() !== scopeId) return;
  useToastStore.getState().addToast(usedInAnotherBrowserToast());
}
