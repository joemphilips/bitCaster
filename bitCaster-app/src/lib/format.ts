import i18n from "@/i18n";

/** Format sats with ₿ prefix. Abbreviates large values. */
export function formatBtc(sats: number): string {
  const abs = Math.abs(sats);
  if (abs >= 1_000_000) return `₿${(sats / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `₿${(sats / 1_000).toFixed(1)}K`;
  return `₿${sats.toLocaleString()}`;
}

export function formatBalance(sats?: number): string {
  if (sats === undefined || sats === 0) return "₿0";
  return formatBtc(sats);
}

/**
 * A clock time in the given language: the time alone on the same day, else the
 * date and the time.
 */
export function formatClockTime(atMs: number, nowMs: number, locale: string): string {
  const at = new Date(atMs);
  const now = new Date(nowMs);
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  return sameDay
    ? at.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })
    : at.toLocaleString(locale, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

/** Short relative-time label in the active language ("Just now", "5m ago",
 *  "2h ago"). Falls back to a "Mon DD" date after a week. Accepts an ISO
 *  string, unix ms, or Date — callers pick whichever form they already have.
 *  The caller re-renders on a language change through `useTranslation`. */
export function formatTimeAgo(timestamp: string | number | Date): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  const diff = Date.now() - date.getTime();
  if (!Number.isFinite(diff)) return i18n.t("relativeTime.unknown");

  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (minutes < 1) return i18n.t("relativeTime.justNow");
  if (minutes < 60) return i18n.t("relativeTime.minutesAgo", { minutes });
  if (hours < 24) return i18n.t("relativeTime.hoursAgo", { hours });
  if (days < 7) return i18n.t("relativeTime.daysAgo", { days });

  return date.toLocaleDateString(i18n.resolvedLanguage ?? "en", {
    month: "short",
    day: "numeric",
  });
}
