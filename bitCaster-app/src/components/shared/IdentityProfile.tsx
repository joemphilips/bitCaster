import { useEffect, useState, type ReactNode } from "react";
import { Loader2, UserCircle, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { NostrProfileFetchStatus } from "@/types/settings";

export interface IdentityProfileData {
  displayName: string;
  avatarUrl: string | null;
  bio?: string;
}

/** The same public identity presentation is used in Settings and Portfolio. */
export function IdentityProfile({
  profile,
  action,
  status,
}: {
  profile: IdentityProfileData;
  action?: ReactNode;
  status?: NostrProfileFetchStatus;
}) {
  const { t } = useTranslation();
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  const name = profile.displayName.trim() || t("settings.profileAnonymous");
  const [dismissedReadError, setDismissedReadError] = useState(false);
  useEffect(() => {
    if (status !== "unavailable") setDismissedReadError(false);
  }, [status]);
  const loading = status === "fetching" || (status === "idle" && !profile.displayName);
  const unavailable = status === "unavailable" && !dismissedReadError;
  const absent = status === "not-found";
  return (
    <div
      data-testid="identity-profile"
      className="flex min-w-0 items-start gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-900/30"
    >
      <div className="h-16 w-16 shrink-0 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
        {profile.avatarUrl && profile.avatarUrl !== failedAvatar ? (
          <img
            src={profile.avatarUrl}
            alt={name}
            className="h-full w-full object-cover"
            onError={() => setFailedAvatar(profile.avatarUrl)}
          />
        ) : (
          <UserCircle
            aria-hidden="true"
            className="h-full w-full text-slate-400 dark:text-slate-500"
          />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h3 className="min-w-0 break-words text-lg font-semibold text-slate-900 dark:text-white [overflow-wrap:anywhere]">
            {name}
          </h3>
          {action}
        </div>
        {profile.bio && (
          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-600 dark:text-slate-300 [overflow-wrap:anywhere]">
            {profile.bio}
          </p>
        )}
        {(loading || unavailable || absent) && (
          <div
            role={unavailable ? "alert" : "status"}
            className="mt-2 flex items-start gap-2 text-sm text-slate-500 dark:text-slate-400"
          >
            {loading && (
              <Loader2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
            )}
            <p className="min-w-0 flex-1 select-text">
              {t(
                loading
                  ? "settings.profileFetching"
                  : unavailable
                    ? "settings.profileReadUnavailable"
                    : "settings.profileAbsent",
              )}
            </p>
            {unavailable && (
              <button
                type="button"
                aria-label={t("settings.profileEditDismiss")}
                onClick={() => setDismissedReadError(true)}
                className="shrink-0 rounded p-1"
              >
                <X aria-hidden="true" className="h-4 w-4" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
