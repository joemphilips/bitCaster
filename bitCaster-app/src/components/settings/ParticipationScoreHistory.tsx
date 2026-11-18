import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ParticipationScoreHistoryKind,
  ParticipationScoreHistoryResponse,
} from "@bitcaster/client-sdk/engineClient";
import { ParticipationScoreHelp } from "@/components/shared/ParticipationScoreHelp";
import i18n from "@/i18n";
import { formatTimeAgo } from "@/lib/format";

type HistoryState =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly history: ParticipationScoreHistoryResponse };

/** The authenticated account's Score balance and its most recent changes, newest first. */
export function ParticipationScoreHistory({
  load,
}: {
  load: (signal: AbortSignal) => Promise<ParticipationScoreHistoryResponse>;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<HistoryState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    load(controller.signal).then(
      (history) => {
        if (!controller.signal.aborted) setState({ kind: "ready", history });
      },
      () => {
        if (!controller.signal.aborted) setState({ kind: "unavailable" });
      },
    );
    return () => controller.abort();
  }, [load, attempt]);

  return (
    <section>
      <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {t("participationScore.name")}
        <ParticipationScoreHelp testId="settings-participation-score-help" />
        {state.kind === "ready" && (
          <span
            data-testid="participation-score-balance"
            className="ml-auto normal-case tracking-normal text-slate-900 dark:text-white"
          >
            {formatScore(state.history.balance, false)}
          </span>
        )}
      </h3>
      {state.kind === "loading" && <p className="text-sm text-slate-500">{t("common.loading")}</p>}
      {state.kind === "unavailable" && (
        <div className="flex items-center gap-3 text-sm">
          <p className="text-slate-600 dark:text-slate-400">
            {t("participationScore.historyUnavailable")}
          </p>
          <button
            type="button"
            className="text-blue-600 underline dark:text-blue-400"
            onClick={() => setAttempt((value) => value + 1)}
          >
            {t("common.retry")}
          </button>
        </div>
      )}
      {state.kind === "ready" && state.history.entries.length === 0 && (
        <p className="text-sm text-slate-500">{t("participationScore.historyEmpty")}</p>
      )}
      {state.kind === "ready" && state.history.entries.length > 0 && (
        <ul aria-label={t("participationScore.history")} className="space-y-2">
          {state.history.entries.map((entry, index) => (
            <li
              key={`${entry.occurredAt}:${index}`}
              data-kind={entry.kind}
              className="flex items-baseline gap-3 text-sm"
            >
              <span className="text-slate-700 dark:text-slate-300">
                {t(kindLabelKey(entry.kind))}
              </span>
              <span className="ml-auto shrink-0 whitespace-nowrap text-xs text-slate-500">
                {formatTimeAgo(entry.occurredAt)}
              </span>
              {/* A fixed column keeps the times and the amounts aligned. */}
              <span
                className={`min-w-20 shrink-0 text-right font-medium tabular-nums ${
                  entry.amountScore < 0
                    ? "text-red-600 dark:text-red-400"
                    : "text-emerald-700 dark:text-emerald-300"
                }`}
              >
                {formatScore(entry.amountScore, true)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatScore(value: number, signed: boolean): string {
  const text = Math.abs(value).toLocaleString(i18n.resolvedLanguage ?? "en");
  if (value < 0) return `-${text}`;
  return signed && value > 0 ? `+${text}` : text;
}

function kindLabelKey(kind: ParticipationScoreHistoryKind): string {
  switch (kind) {
    case "purchase":
      return "participationScore.kinds.purchase";
    case "capability-binding":
      return "participationScore.kinds.capability-binding";
    case "invalid-capability-validation":
      return "participationScore.kinds.invalid-capability-validation";
    case "reused-output-penalty":
      return "participationScore.kinds.reused-output-penalty";
    default:
      return assertNever(kind);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Participation Score history kind: ${value}`);
}
