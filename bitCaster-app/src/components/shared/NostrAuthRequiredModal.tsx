import { KeyRound, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";

interface NostrAuthRequiredModalProps {
  onClose: () => void;
}

export function NostrAuthRequiredModal({
  onClose,
}: NostrAuthRequiredModalProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      <div className="relative mx-4 w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 text-center dark:border-slate-700 dark:bg-slate-800">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 rounded-full p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-700 dark:hover:text-white"
          aria-label={t("common.close")}
        >
          <X className="h-4 w-4" />
        </button>

        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/30">
          <KeyRound className="h-8 w-8 text-blue-600 dark:text-blue-400" />
        </div>

        <h2 className="mb-2 text-xl font-bold text-slate-900 dark:text-white">
          {t("auth.nostrRequiredTitle")}
        </h2>

        <p className="mb-6 text-sm text-slate-500 dark:text-slate-400">
          {t("auth.nostrRequiredDesc")}
        </p>

        <button
          type="button"
          onClick={() => {
            onClose();
            navigate("/settings?category=nostr", {
              state: { from: location.pathname + location.search },
            });
          }}
          className="w-full rounded-xl bg-blue-600 py-2.5 font-semibold text-white transition-colors hover:bg-blue-700"
        >
          {t("auth.configureNostr")}
        </button>
      </div>
    </div>
  );
}
