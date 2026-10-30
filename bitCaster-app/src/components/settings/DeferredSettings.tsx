import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Settings } from "./Settings";
import type { SettingsProps } from "@/types/settings";

export function DeferredSettings(props: SettingsProps) {
  const { t } = useTranslation();
  const [Content, setContent] = useState<typeof Settings | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    void import("./Settings").then(
      (module) => {
        if (current) setContent(() => module.Settings);
      },
      () => {
        if (current) setFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [attempt]);
  if (Content) return <Content {...props} />;
  if (failed)
    return (
      <div
        role="alert"
        className="rounded-lg border border-slate-200 p-4 text-sm dark:border-slate-700"
      >
        <p className="select-text">{t("settings.pageLoadFailed")}</p>
        <button
          type="button"
          className="mt-2 rounded-lg border px-3 py-2"
          onClick={() => {
            setFailed(false);
            setAttempt((value) => value + 1);
          }}
        >
          {t("settings.pageLoadRetry")}
        </button>
      </div>
    );
  return (
    <p role="status" className="text-sm text-slate-500 dark:text-slate-400">
      {t("settings.pageLoading")}
    </p>
  );
}
