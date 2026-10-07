import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { NostrProfileEditor, NostrProfileEditorProps } from "./NostrProfileEditor";

/** The Settings shell can render before profile editing code is available. */
export function DeferredNostrProfileEditor(props: NostrProfileEditorProps) {
  const { t } = useTranslation();
  const [Editor, setEditor] = useState<typeof NostrProfileEditor | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    void import("./NostrProfileEditor").then(
      (module) => {
        if (current) setEditor(() => module.NostrProfileEditor);
      },
      () => {
        if (current) setFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [attempt]);
  if (Editor) return <Editor {...props} />;
  if (failed)
    return (
      <div
        role="alert"
        className="mt-5 rounded-lg border border-slate-200 p-4 text-sm dark:border-slate-700"
      >
        <p className="select-text">{t("settings.profileEditLoadFailed")}</p>
        <button
          type="button"
          className="mt-2 rounded-lg border px-3 py-2"
          onClick={() => {
            setFailed(false);
            setAttempt((value) => value + 1);
          }}
        >
          {t("settings.profileEditLoadRetry")}
        </button>
      </div>
    );
  return (
    <p role="status" className="mt-5 text-sm text-slate-500 dark:text-slate-400">
      {t("settings.profileEditLoading")}
    </p>
  );
}
