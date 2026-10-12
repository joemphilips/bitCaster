import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface SeedWordGridProps {
  words: string[];
  onChange: (words: string[]) => void;
  disabled?: boolean;
  error?: string | null;
}

/** Presentation only. The caller validates the complete phrase before import. */
export function SeedWordGrid({ words, onChange, disabled, error }: SeedWordGridProps) {
  const { t } = useTranslation();
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const [pasteError, setPasteError] = useState(false);
  const message = pasteError ? t("wallet.seedphraseWordCountError") : error;
  const enter = (index: number, value: string) => {
    const parts = value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    setPasteError(false);
    if (parts.length === 12 || parts.length === 24) {
      onChange(parts);
      return;
    }
    if (parts.length > words.length - index) {
      setPasteError(true);
      // Do not leave a previous valid phrase available after a rejected paste.
      onChange(Array(words.length).fill(""));
      return;
    }
    const next = [...words];
    next.splice(index, Math.max(1, parts.length), ...(parts.length ? parts : [""]));
    onChange(next);
  };
  return (
    <fieldset disabled={disabled} className="space-y-2">
      <legend className="text-sm font-medium text-slate-700 dark:text-slate-200">
        {t("wallet.enterSeedPhrase")}
      </legend>
      <label className="flex items-center gap-2 text-sm">
        {t("wallet.seedWordCount")}
        <select
          value={words.length}
          onChange={(event) => {
            setPasteError(false);
            const count = Number(event.target.value);
            onChange(Array.from({ length: count }, (_, index) => words[index] ?? ""));
          }}
          className="rounded border bg-white p-1 dark:bg-slate-800"
        >
          <option value={12}>12</option>
          <option value={24}>24</option>
        </select>
      </label>
      <div className="grid grid-cols-3 gap-2">
        {words.map((word, index) => (
          <label key={index} className="min-w-0 text-xs text-slate-500">
            {index + 1}
            <input
              ref={(node) => {
                inputs.current[index] = node;
              }}
              id={index === 0 ? "wallet-seed-phrase" : `wallet-seed-word-${index + 1}`}
              aria-label={t("wallet.seedWordNumber", { number: index + 1 })}
              aria-invalid={Boolean(message)}
              aria-describedby={message ? "wallet-seed-phrase-error" : undefined}
              value={word}
              onChange={(event) => enter(index, event.target.value)}
              onPaste={(event) => {
                event.preventDefault();
                enter(index, event.clipboardData.getData("text"));
              }}
              onKeyDown={(event) => {
                const position = event.currentTarget.selectionStart;
                if ((event.key === " " || event.key === "ArrowRight") && position === word.length) {
                  event.preventDefault();
                  inputs.current[index + 1]?.focus();
                } else if (event.key === "ArrowLeft" && position === 0) {
                  event.preventDefault();
                  inputs.current[index - 1]?.focus();
                }
              }}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className={`w-full min-w-0 rounded-lg border bg-white px-2 py-2 text-sm text-slate-900 dark:bg-slate-800 dark:text-white ${message ? "border-rose-500" : "border-slate-300 dark:border-slate-700"}`}
            />
          </label>
        ))}
      </div>
      {message && (
        <p
          id="wallet-seed-phrase-error"
          role="alert"
          className="text-sm text-rose-600 dark:text-rose-300"
        >
          {message}
        </p>
      )}
    </fieldset>
  );
}
