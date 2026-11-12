import { Info } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ResolutionDetails } from "@/types/market-detail";
import type { Outcome } from "@/types/market";
import { MarketMarkdown } from "@/components/shared/MarketMarkdown";
import { OutcomeLabel } from "@/components/shared/OutcomeLabel";
import { isMarketOutcomeKnown } from "@/lib/marketResolution";
import { effectiveRelayUrls } from "@/lib/relayDefaults";
import { useSettingsStore } from "@/stores/settings";

interface ResolutionInfoProps {
  resolution: ResolutionDetails;
  outcomes?: Outcome[];
}

export function ResolutionInfo({ resolution, outcomes }: ResolutionInfoProps) {
  const { t, i18n } = useTranslation();
  const [explanation, setExplanation] = useState<{
    conditionId: string;
    text: string | null;
    unavailable: boolean;
  } | null>(null);
  const relayKey = useSettingsStore((state) => JSON.stringify(effectiveRelayUrls(state.relays)));
  const resolved = isMarketOutcomeKnown(resolution.finalOutcome);
  useEffect(() => {
    const conditionId = resolution.conditionId;
    if (!conditionId || !resolved) return;
    let cancelled = false;
    const read = async () => {
      const { readBrowserResolutionExplanation } = await import("@/lib/oracleAttestation");
      return readBrowserResolutionExplanation(conditionId, JSON.parse(relayKey));
    };
    // Companion I/O never blocks the market detail loader or verified resolution.
    // A relay connection can stay silent until its deadline, so one more read
    // opens a new connection.
    void read()
      .catch((error: unknown) => {
        if (cancelled) throw error;
        return read();
      })
      .then((text) => {
        if (!cancelled) setExplanation({ conditionId, text, unavailable: false });
      })
      .catch(() => {
        if (!cancelled) setExplanation({ conditionId, text: null, unavailable: true });
      });
    return () => {
      cancelled = true;
    };
  }, [resolution.conditionId, resolved, relayKey]);
  const currentExplanation =
    explanation?.conditionId === resolution.conditionId ? explanation : null;

  function formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString(i18n.language, {
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  return (
    <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5">
      <div className="mb-4">
        <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
          {t("market.resolution")}
        </h3>
      </div>

      {resolved && currentExplanation?.text && (
        <section
          aria-label={t("creator.verifiedExplanation")}
          className="mb-4 rounded-xl border border-slate-200 p-4 dark:border-slate-700"
        >
          <h4 className="font-semibold">{t("creator.verifiedExplanation")}</h4>
          <p data-user-content className="mt-2 whitespace-pre-wrap break-words text-sm">
            {currentExplanation.text}
          </p>
        </section>
      )}
      {resolved && currentExplanation?.unavailable && (
        <p className="mb-4 text-sm text-slate-500">{t("creator.explanationUnavailable")}</p>
      )}

      {/* Final Outcome (if resolved) */}
      {resolved && resolution.finalOutcome && (
        <div className="mb-4 p-4 bg-emerald-50 dark:bg-emerald-500/10 rounded-xl border border-emerald-200 dark:border-emerald-500/30">
          <p className="text-xs text-emerald-600 dark:text-emerald-400 uppercase tracking-wider mb-1">
            {t("market.finalOutcome")}
          </p>
          {outcomes ? (
            <OutcomeLabel
              outcome={{
                label: resolution.finalOutcome,
                color: outcomes.find((outcome) => outcome.label === resolution.finalOutcome)?.color,
              }}
              className="text-lg font-bold"
              labelClassName="text-slate-900 dark:text-white"
              swatchClassName="h-3 w-3"
            />
          ) : (
            <p className="text-lg font-bold text-emerald-700 dark:text-emerald-300">
              {resolution.finalOutcome}
            </p>
          )}
        </div>
      )}

      {/* Resolution Criteria */}
      <div className="mb-4">
        <div className="flex items-center gap-2 mb-2">
          <Info className="w-4 h-4 text-slate-400" />
          <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
            {t("market.resolutionCriteria")}
          </span>
        </div>
        <div className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed pl-6">
          <MarketMarkdown source={resolution.criteria} />
        </div>
      </div>

      {resolution.resolutionDate !== null && (
        <div className="pt-4 border-t border-slate-200 dark:border-slate-700">
          <div>
            <p className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">
              {t("market.resolutionDate")}
            </p>
            <p className="text-sm font-medium text-slate-900 dark:text-white">
              {formatDate(resolution.resolutionDate)}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
