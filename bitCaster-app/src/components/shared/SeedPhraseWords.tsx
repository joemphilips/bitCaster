interface SeedPhraseWordsProps {
  words: readonly string[];
}

/** Numbered recovery phrase words, for a user who writes them down. Presentation only. */
export function SeedPhraseWords({ words }: SeedPhraseWordsProps) {
  return (
    <div className="mb-4 grid grid-cols-3 gap-2">
      {words.map((word, i) => (
        <div
          key={i}
          className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-600 dark:bg-slate-700/50"
        >
          <span className="w-4 text-right text-xs text-slate-400 dark:text-slate-500">{i + 1}</span>
          <span
            data-testid="seed-word"
            className="font-mono text-sm text-slate-900 dark:text-white"
          >
            {word}
          </span>
        </div>
      ))}
    </div>
  );
}
