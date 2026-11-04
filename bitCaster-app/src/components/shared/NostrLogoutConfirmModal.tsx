import { useId } from "react";
import { Shield, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NativeDialog } from "./NativeDialog";

interface NostrLogoutConfirmModalProps {
  /** Orders need this key to finish. Offer only the backup. */
  ordersInProgress: boolean;
  onBackUp: () => void;
  onLogout: () => void;
  onDismiss: () => void;
}

/** Confirm a logout that deletes the only copy of a local Nostr key. */
export function NostrLogoutConfirmModal({
  ordersInProgress,
  onBackUp,
  onLogout,
  onDismiss,
}: NostrLogoutConfirmModalProps) {
  const { t } = useTranslation();
  const descriptionId = useId();

  return (
    <NativeDialog
      ariaLabel={t("auth.unbackedKeyLogoutTitle")}
      describedBy={descriptionId}
      onDismiss={onDismiss}
    >
      {(dismiss) => (
        <div
          data-testid="nostr-logout-confirm-dialog-backdrop"
          className="flex min-h-full items-center justify-center p-4"
          onClick={(event) => {
            if (event.target === event.currentTarget) dismiss();
          }}
        >
          <div className="relative w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-800">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="rounded-full bg-amber-100 p-2 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                  <Shield className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
                    {t("auth.unbackedKeyLogoutTitle")}
                  </h2>
                  <p id={descriptionId} className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    {t(
                      ordersInProgress
                        ? "auth.unbackedKeyOrdersInProgressDesc"
                        : "auth.unbackedKeyLogoutDesc",
                    )}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={dismiss}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-700 dark:hover:text-white"
                aria-label={t("common.close")}
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex gap-3">
              {!ordersInProgress && (
                <button
                  type="button"
                  onClick={onLogout}
                  className="flex-1 rounded-xl border border-red-200 px-4 py-2.5 text-sm font-semibold text-red-600 transition-colors hover:bg-red-50 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-900/20"
                >
                  {t("nav.logout")}
                </button>
              )}
              <button
                type="button"
                onClick={onBackUp}
                className="flex-1 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
              >
                {t("auth.backUpKey")}
              </button>
            </div>
          </div>
        </div>
      )}
    </NativeDialog>
  );
}
