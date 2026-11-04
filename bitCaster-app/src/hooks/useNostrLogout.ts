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
 * Log out of the Nostr identity. The wallet does not change. A local key
 * without a backup asks for confirmation first, because logout deletes it.
 * While orders are in progress, that key cannot log out: the orders need
 * it to finish. A backed-up key or an extension signer logs out at once,
 * and a later login resumes its orders.
 */
export function useNostrLogout(): {
  /** Focus returns to `returnFocusTo`, or to the focused control, after a dialog. */
  requestLogout: (returnFocusTo?: HTMLElement | null) => void;
  confirmation: NostrLogoutConfirmation | null;
} {
  const openNostrSettings = useOpenNostrSettings();
  const [dialog, setDialog] = useState<{ ordersInProgress: boolean } | null>(null);
  // Only the latest local read can open or change the dialog.
  const readGeneration = useRef(0);
  const returnFocus = useRef<HTMLElement | null>(null);
  const dialogWasOpen = useRef(false);
  useEffect(
    () => () => {
      readGeneration.current += 1;
    },
    [],
  );

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
  const logOutOrConfirm = useCallback(async (confirmed: boolean) => {
    const generation = ++readGeneration.current;
    if (!nostrLogoutNeedsBackupConfirmation(useSettingsStore.getState())) {
      // This also cancels a pending connection attempt.
      setDialog(null);
      disconnectNostrIdentity();
      return;
    }
    const ordersInProgress = await hasLocalOrdersInProgress();
    if (generation !== readGeneration.current) return;
    if (confirmed && !ordersInProgress) {
      setDialog(null);
      disconnectNostrIdentity();
      return;
    }
    setDialog({ ordersInProgress });
  }, []);

  const requestLogout = useCallback(
    (returnFocusTo?: HTMLElement | null) => {
      returnFocus.current = returnFocusTo ?? focusedElement();
      void logOutOrConfirm(false);
    },
    [logOutOrConfirm],
  );

  const confirmation: NostrLogoutConfirmation | null = dialog
    ? {
        ordersInProgress: dialog.ordersInProgress,
        onBackUp: () => {
          readGeneration.current += 1;
          setDialog(null);
          openNostrSettings();
        },
        onLogout: () => void logOutOrConfirm(true),
        onDismiss: () => {
          readGeneration.current += 1;
          setDialog(null);
        },
      }
    : null;

  return { requestLogout, confirmation };
}
