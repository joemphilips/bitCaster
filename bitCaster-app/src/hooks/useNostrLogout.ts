import { useCallback, useState } from "react";
import { useNavigate } from "react-router";
import { useSettingsStore } from "@/stores/settings";
import { disconnectNostrIdentity, nostrLogoutNeedsBackupConfirmation } from "@/lib/identityOps";

/** The Settings section that connects, backs up, and removes the Nostr identity. */
export const NOSTR_SETTINGS_PATH = "/settings?category=nostr";

export interface NostrLogoutConfirmation {
  onBackUp: () => void;
  onLogout: () => void;
  onDismiss: () => void;
}

/**
 * Log out of the Nostr identity. The wallet does not change. A local key
 * without a backup asks for confirmation first, because logout deletes it.
 */
export function useNostrLogout(): {
  requestLogout: () => void;
  confirmation: NostrLogoutConfirmation | null;
} {
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);

  const requestLogout = useCallback(() => {
    // Read the stored identity at click time, not a value from a past render.
    if (nostrLogoutNeedsBackupConfirmation(useSettingsStore.getState())) {
      setConfirming(true);
      return;
    }
    disconnectNostrIdentity();
  }, []);

  const confirmation: NostrLogoutConfirmation | null = confirming
    ? {
        onBackUp: () => {
          setConfirming(false);
          navigate(NOSTR_SETTINGS_PATH);
        },
        onLogout: () => {
          setConfirming(false);
          disconnectNostrIdentity();
        },
        onDismiss: () => setConfirming(false),
      }
    : null;

  return { requestLogout, confirmation };
}
