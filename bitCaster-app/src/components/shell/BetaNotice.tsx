import { useTranslation } from "react-i18next";

/** A production build states that the service is a beta with real funds. */
export function BetaNotice() {
  const { t } = useTranslation();
  if (import.meta.env.VITE_BETA_NOTICE !== "true") return null;

  return (
    <div
      role="note"
      className="bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200 text-center text-xs px-4 py-1"
    >
      {t("betaNotice")}
    </div>
  );
}
