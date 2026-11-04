import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useSettingsStore } from "@/stores/settings";
import { disconnectNostrIdentity, nostrLogoutNeedsBackupConfirmation } from "@/lib/identityOps";
import { hasLocalOrdersInProgress } from "@/lib/nostrLogoutGuard";

/** The Settings section that connects, backs up, and removes the Nostr identity. */
export const NOSTR_SETTINGS_PATH = "/settings?category=nostr";

/**
 * Open the Nostr card of Settings. The deep link opens the card only when
 * the URL changes, so open it in the store first.
 */
export function useOpenNostrSettings(): () => void {
  const navigate = useNavigate();
  return useCallback(() => {
    useSettingsStore.getState().openCategory("nostr");
    navigate(NOSTR_SETTINGS_PATH);
  }, [navigate]);
}

export interface NostrLogoutConfirmation {
  /** Orders need this key to finish, so the dialog offers no logout. */
  ordersInProgress: boolean;
  onBackUp: () => void;
  onLogout: () => void;
  onDismiss: () => void;
}

function focusedElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

/**
 * Log out of the Nostr identity, or replace it with another one. The wallet
 * does not change. Both remove the stored key, so both use one guard. A
 * local key without a backup asks for confirmation first, because removal
 * deletes it. While orders are in progress, that key cannot be removed: the
 * orders need it to finish. A backed-up key or an extension signer is
 * removed at once, and a later login resumes its orders.
 */
export function useNostrLogout(): {
  /** Focus returns to `returnFocusTo`, or to the focused control, after a dialog. */
  requestLogout: (returnFocusTo?: HTMLElement | null) => void;
  /**
   * Resolve true when another identity can replace the stored one. The
   * caller connects the new identity, which replaces the key only on success.
   */
  confirmIdentityReplacement: () => Promise<boolean>;
  confirmation: NostrLogoutConfirmation | null;
} {
  const openNostrSettings = useOpenNostrSettings();
  const [dialog, setDialog] = useState<{ ordersInProgress: boolean } | null>(null);
  // Only the latest local read can open or change the dialog.
  const readGeneration = useRef(0);
  // Runs the removal when the guard passes, or reports that it did not.
  const settleRequest = useRef<((proceed: boolean) => void) | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const dialogWasOpen = useRef(false);

  const finish = useCallback((proceed: boolean) => {
    readGeneration.current += 1;
    setDialog(null);
    const settle = settleRequest.current;
    settleRequest.current = null;
    settle?.(proceed);
  }, []);

  useEffect(() => () => finish(false), [finish]);

  // The menu item that opened the dialog is gone. Run after the dialog closes,
  // so the browser does not move focus again.
  useEffect(() => {
    if (dialog) {
      dialogWasOpen.current = true;
      return;
    }
    if (!dialogWasOpen.current) return;
    dialogWasOpen.current = false;
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target?.isConnected) target.focus();
  }, [dialog]);

  // Read the stored identity and the local orders at the time of each action.
  const evaluate = useCallback(
    async (confirmed: boolean) => {
      const generation = ++readGeneration.current;
      if (!nostrLogoutNeedsBackupConfirmation(useSettingsStore.getState())) {
        finish(true);
        return;
      }
      const ordersInProgress = await hasLocalOrdersInProgress();
      if (generation !== readGeneration.current) return;
      if (confirmed && !ordersInProgress) {
        finish(true);
        return;
      }
      setDialog({ ordersInProgress });
    },
    [finish],
  );

  const start = useCallback(
    (settle: (proceed: boolean) => void, returnFocusTo?: HTMLElement | null) => {
      // A new request replaces an earlier one that did not finish.
      finish(false);
      settleRequest.current = settle;
      returnFocus.current = returnFocusTo ?? focusedElement();
      void evaluate(false);
    },
    [evaluate, finish],
  );

  const requestLogout = useCallback(
    (returnFocusTo?: HTMLElement | null) =>
      start((proceed) => {
        // This also cancels a pending connection attempt.
        if (proceed) disconnectNostrIdentity();
      }, returnFocusTo),
    [start],
  );

  const confirmIdentityReplacement = useCallback(
    () => new Promise<boolean>((resolve) => start(resolve)),
    [start],
  );

  const confirmation: NostrLogoutConfirmation | null = dialog
    ? {
        ordersInProgress: dialog.ordersInProgress,
        onBackUp: () => {
          finish(false);
          openNostrSettings();
        },
        onLogout: () => void evaluate(true),
        onDismiss: () => finish(false),
      }
    : null;

  return { requestLogout, confirmIdentityReplacement, confirmation };
}
