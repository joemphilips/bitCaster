/**
 * Client-side Web Notification helpers for the liked-market close feature
 * (P22 Link G3).
 *
 * Scope is deliberately minimal: we use the in-browser `Notification` API to
 * surface a desktop/OS toast when a bookmarked market closes. There is NO
 * server-stored push subscription and NO VAPID key — a server-held push
 * subscription would (a) require the matching engine to hold authoritative
 * per-user state it cannot ground-truth and (b) leak the user's private
 * bookmark set to the server (P08 violation). True Web Push is deferred (see
 * docs/TODO.md). This module only fires notifications while a tab/service
 * worker for this origin is alive — best-effort, client-only.
 */

export type NotificationPermissionState = "default" | "granted" | "denied" | "unsupported";

/** Whether the browser exposes the Notification API at all. */
export function isWebNotificationSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "Notification" in window &&
    typeof window.Notification !== "undefined"
  );
}

/** Current permission state, normalised with an `unsupported` sentinel. */
export function getNotificationPermission(): NotificationPermissionState {
  if (!isWebNotificationSupported()) return "unsupported";
  return Notification.permission;
}

/**
 * Request OS notification permission. Returns the resulting permission state.
 * Safe to call when unsupported (returns `'unsupported'`) or already decided
 * (returns the existing state without re-prompting in browsers that honour
 * that). Wrapped in try/catch because some browsers throw on the legacy
 * callback form.
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (!isWebNotificationSupported()) return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/**
 * Fire a one-shot Web Notification. No-ops (returns `false`) when the API is
 * unsupported or permission has not been granted, so callers don't need to
 * branch. Construction failures are swallowed — a missing notification must
 * never break the close-reconcile path.
 */
export function showWebNotification(title: string, options?: NotificationOptions): boolean {
  if (!isWebNotificationSupported()) return false;
  if (Notification.permission !== "granted") return false;
  try {
    // eslint-disable-next-line no-new
    new Notification(title, options);
    return true;
  } catch {
    return false;
  }
}
