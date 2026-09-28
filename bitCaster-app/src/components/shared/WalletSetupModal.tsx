import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, X } from "lucide-react";
import { NativeDialog } from "./NativeDialog";

import { validate, validateWord } from "@/lib/bip39";

interface WalletSetupModalProps {
  mode?: "setup" | "replace";
  isCreating?: boolean;
  error?: string | null;
  onClose: () => void;
  onCreateNew: () => void;
  onImportSeed: (words: string[]) => void | Promise<void>;
}

export function WalletSetupModal({
  mode = "setup",
  isCreating = false,
  error,
  onClose,
  onCreateNew,
  onImportSeed,
}: WalletSetupModalProps) {
  const { t } = useTranslation();
  const [showImport, setShowImport] = useState(mode === "replace");
  const [seedPhrase, setSeedPhrase] = useState("");

  const words = seedPhrase
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  const hasSeedPhraseInput = words.length > 0;
  const wordCountIsValid = words.length === 12;
  const invalidWord = wordCountIsValid ? words.find((word) => !validateWord(word)) : undefined;
  const seedPhraseError =
    hasSeedPhraseInput && !wordCountIsValid
      ? t("wallet.seedphraseWordCountError")
      : invalidWord
        ? t("wallet.invalidSeedphraseWord", { word: invalidWord })
        : wordCountIsValid && !validate(words)
          ? t("wallet.seedphraseChecksumError")
          : null;
  const seedPhraseIsValid = hasSeedPhraseInput && !seedPhraseError;
  const canDismiss = mode !== "replace" || !isCreating;

  return (
    <NativeDialog
      ariaLabel={t(mode === "replace" ? "wallet.replaceWalletTitle" : "wallet.setupTitle")}
      canDismiss={canDismiss}
      onDismiss={onClose}
    >
      {(dismiss) => (
        <div
          data-testid="wallet-setup-dialog-backdrop"
          className="flex min-h-full items-center justify-center p-4"
          onClick={(event) => {
            if (canDismiss && event.target === event.currentTarget) dismiss();
          }}
        >
          <div className="relative w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-800">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
                  {t(mode === "replace" ? "wallet.replaceWalletTitle" : "wallet.setupTitle")}
                </h2>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  {t(mode === "replace" ? "wallet.replaceWalletDesc" : "wallet.setupDesc")}
                </p>
              </div>
              <button
                onClick={dismiss}
                disabled={!canDismiss}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-700 dark:hover:text-white"
                aria-label={t("common.close")}
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {error && (
              <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-300">
                {error}
              </div>
            )}

            {mode === "replace" && (
              <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                {t("wallet.replaceWalletWarning")}
              </p>
            )}

            <div className="space-y-3">
              {mode === "setup" && (
                <>
                  <button
                    onClick={onCreateNew}
                    disabled={isCreating}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isCreating && !showImport && <Loader2 className="h-4 w-4 animate-spin" />}
                    {t("wallet.createNewWallet")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowImport(true)}
                    className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-900 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-white dark:hover:bg-slate-700"
                  >
                    {t("wallet.importExistingWallet")}
                  </button>
                </>
              )}

              {showImport && (
                <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-left dark:border-slate-700 dark:bg-slate-900/60">
                  <label
                    htmlFor="wallet-seed-phrase"
                    className="block text-sm font-medium text-slate-700 dark:text-slate-200"
                  >
                    {t("wallet.enterSeedPhrase")}
                  </label>
                  <textarea
                    id="wallet-seed-phrase"
                    value={seedPhrase}
                    onChange={(event) => setSeedPhrase(event.target.value)}
                    rows={4}
                    aria-invalid={seedPhraseError ? "true" : "false"}
                    aria-describedby={seedPhraseError ? "wallet-seed-phrase-error" : undefined}
                    className={`w-full resize-y rounded-lg border bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 dark:bg-slate-800 dark:text-white ${
                      seedPhraseError
                        ? "border-rose-500 focus:border-rose-500 focus:ring-rose-500/20 dark:border-rose-500"
                        : "border-slate-300 focus:border-blue-500 focus:ring-blue-500/20 dark:border-slate-700"
                    }`}
                    placeholder={t("wallet.enterSeedPhrase")}
                  />
                  {seedPhraseError && (
                    <p
                      id="wallet-seed-phrase-error"
                      className="text-sm text-rose-600 dark:text-rose-300"
                    >
                      {seedPhraseError}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => void onImportSeed(words)}
                    disabled={isCreating || !seedPhraseIsValid}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isCreating && showImport && <Loader2 className="h-4 w-4 animate-spin" />}
                    {t(mode === "replace" ? "wallet.replaceWallet" : "wallet.restoreWallet")}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </NativeDialog>
  );
}
