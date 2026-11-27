import { useEffect, useMemo, useRef, useState } from "react";
import { SeedPhraseWords } from "@/components/shared/SeedPhraseWords";
import { readPersistedWalletSecrets } from "@/lib/persistedWalletSecrets";
import { initialStoppedPageLanguage, STOPPED_PAGE_TEXT, type StoppedPageLanguage } from "./text";

// The copied secret leaves the clipboard after this time, as in Settings.
const CLIPBOARD_CLEAR_MS = 60_000;
// A shown secret hides again after this time, so that it does not stay on an unattended screen.
const SECRET_DISPLAY_MS = 5 * 60_000;

/** The page owns this timer, so hiding the phrase does not cancel clipboard cleanup. */
function useClipboardClear() {
  const clearTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (clearTimer.current !== null) window.clearTimeout(clearTimer.current);
    },
    [],
  );
  return (value: string) => {
    if (clearTimer.current !== null) window.clearTimeout(clearTimer.current);
    clearTimer.current = window.setTimeout(() => {
      // Keep text that the user copied later.
      void navigator.clipboard
        .readText()
        .then((current) => (current === value ? navigator.clipboard.writeText("") : undefined))
        .catch(() => undefined);
    }, CLIPBOARD_CLEAR_MS);
  };
}

function CopyButton({
  value,
  text,
  onCopied,
}: {
  value: string;
  text: { copy: string; copied: string; copyFailed: string };
  onCopied: (value: string) => void;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = () => {
    if (!navigator.clipboard) {
      setState("failed");
      return;
    }
    navigator.clipboard.writeText(value).then(
      () => {
        setState("copied");
        onCopied(value);
      },
      () => setState("failed"),
    );
  };
  return (
    <>
      <button
        type="button"
        onClick={copy}
        className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-medium text-slate-100 hover:bg-slate-600"
      >
        {state === "copied" ? text.copied : text.copy}
      </button>
      {state === "failed" && (
        <p role="status" className="text-sm text-amber-400">
          {text.copyFailed}
        </p>
      )}
    </>
  );
}

/** Shows a secret on request, and hides it again after SECRET_DISPLAY_MS. */
function useShownSecret(): [boolean, () => void] {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!shown) return;
    const timer = window.setTimeout(() => setShown(false), SECRET_DISPLAY_MS);
    return () => window.clearTimeout(timer);
  }, [shown]);
  return [shown, () => setShown(!shown)];
}

/**
 * The only page of a stopped host. It reads the recovery phrase of this origin from the
 * browser storage and shows it on request. It makes no network call, has no link, and
 * does not write the storage.
 */
export function StoppedPage() {
  const secrets = useMemo(() => readPersistedWalletSecrets(window.localStorage), []);
  const [language, setLanguage] = useState<StoppedPageLanguage>(() =>
    initialStoppedPageLanguage(window.localStorage, navigator.language),
  );
  const [showPhrase, toggleShowPhrase] = useShownSecret();
  const scheduleClipboardClear = useClipboardClear();
  const text = STOPPED_PAGE_TEXT[language];

  useEffect(() => {
    document.documentElement.lang = language;
    document.title = text.title;
  }, [language, text.title]);

  const otherLanguage: StoppedPageLanguage = language === "en" ? "ja" : "en";
  const button =
    "rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700";

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6 text-slate-200">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setLanguage(otherLanguage)}
          className="text-sm text-slate-400 underline hover:text-slate-200"
        >
          {STOPPED_PAGE_TEXT[otherLanguage].languageName}
        </button>
      </div>
      <h1 className="text-2xl font-semibold text-white">{text.title}</h1>
      <p>{text.unavailable}</p>
      {secrets.seedWords === null ? (
        <p>{text.noWallet}</p>
      ) : (
        <section className="flex flex-col gap-3">
          <p>{text.recovery}</p>
          <p className="text-sm text-amber-400">{text.privacy}</p>
          <div className="flex gap-3">
            <button type="button" className={button} onClick={toggleShowPhrase}>
              {showPhrase ? text.hidePhrase : text.showPhrase}
            </button>
            {showPhrase && (
              <CopyButton
                value={secrets.seedWords.join(" ")}
                text={text}
                onCopied={scheduleClipboardClear}
              />
            )}
          </div>
          {showPhrase && <SeedPhraseWords words={secrets.seedWords} />}
        </section>
      )}
      <div className="flex flex-col gap-4">
        {text.contact.map((paragraph) => (
          <p key={paragraph} className="break-all">
            {paragraph}
          </p>
        ))}
      </div>
    </main>
  );
}
