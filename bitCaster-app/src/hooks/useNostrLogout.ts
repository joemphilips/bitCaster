import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useSettingsStore } from "@/stores/settings";
import { disconnectNostrIdentity, nostrLogoutNeedsBackupConfirmation } from "@/lib/identityOps";
import { hasLocalOrdersInProgress } from "@/lib/nostrLogoutGuard";

/** The Settings section that connects, backs up, and removes the Nostr identity. */
export const NOSTR_SETTINGS_PATH = "/settings?category=nostr";

export interface NostrLogoutConfirmation {
  /** Orders need this key to finish, so the dialog offers no logout. */
  ordersInProgress: boolean;
  onBackUp: () => void;
  onLogout: () => void;
  onDismiss: () => void;
}

/**
 * Log out of the Nostr identity. The wallet does not change. A local key
 * without a backup asks for confirmation first, because logout deletes it.
 * While orders are in progress, that key cannot log out: the orders need
 * it to finish. A backed-up key or an extension signer logs out at once,
 * and a later login resumes its orders.
 */
export function useNostrLogout(): {
  requestLogout: () => void;
  confirmation: NostrLogoutConfirmation | null;
} {
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<{ ordersInProgress: boolean } | null>(null);
  // Only the latest local read can open or change the dialog.
  const readGeneration = useRef(0);
  useEffect(
    () => () => {
      readGeneration.current += 1;
    },
    [],
  );

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

  const requestLogout = useCallback(() => void logOutOrConfirm(false), [logOutOrConfirm]);

  const confirmation: NostrLogoutConfirmation | null = dialog
    ? {
        ordersInProgress: dialog.ordersInProgress,
        onBackUp: () => {
          readGeneration.current += 1;
          setDialog(null);
          navigate(NOSTR_SETTINGS_PATH);
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
