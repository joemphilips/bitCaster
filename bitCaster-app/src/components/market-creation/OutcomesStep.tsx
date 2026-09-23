import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { WizardOutcome, OutcomeType } from "@/types/market-creation";
import { MAX_MARKET_OUTCOMES } from "@/hooks/useMarketCreationState";

interface OutcomesStepProps {
  outcomeType: OutcomeType;
  outcomes: WizardOutcome[] | null;
  loBound?: number;
  hiBound?: number;
  precision?: number;
  unit?: string;
  onAddOutcome?: () => void;
  onRemoveOutcome?: (outcomeId: string) => void;
  onOutcomeLabelChange?: (outcomeId: string, label: string) => void;
  onLoBoundChange?: (value: number) => void;
  onHiBoundChange?: (value: number) => void;
  onPrecisionChange?: (value: number) => void;
  onUnitChange?: (value: string) => void;
  onNext?: () => void;
}

export function OutcomesStep({
  outcomeType,
  outcomes,
  loBound,
  hiBound,
  precision,
  unit,
  onAddOutcome,
  onRemoveOutcome,
  onOutcomeLabelChange,
  onLoBoundChange,
  onHiBoundChange,
  onPrecisionChange,
  onUnitChange,
  onNext,
}: OutcomesStepProps) {
  const { t } = useTranslation();
  const previousOutcomeCount = useRef(outcomes?.length ?? 0);

  useEffect(() => {
    const currentCount = outcomes?.length ?? 0;
    const previousCount = previousOutcomeCount.current;
    previousOutcomeCount.current = currentCount;
    if (outcomeType !== "categorical" || !outcomes || currentCount <= previousCount) return;
    const newest = outcomes[currentCount - 1];
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLInputElement>(`[data-outcome-label-input="${newest.id}"]`)
        ?.focus();
    });
  }, [outcomeType, outcomes]);

  // Numeric market
  if (outcomeType === "numeric") {
    const canProceed = loBound !== undefined && hiBound !== undefined && hiBound > loBound;

    return (
      <div className="w-full max-w-xl">
        <h2 className="text-xl sm:text-2xl font-bold text-white mb-2">
          {t("marketCreation.numericRange")}
        </h2>
        <p className="text-sm text-slate-400 mb-8">{t("marketCreation.numericRangeDesc")}</p>

        <div className="space-y-5 mb-8">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                {t("marketCreation.lowBound")}
              </label>
              <input
                type="number"
                value={loBound ?? ""}
                onChange={(e) => onLoBoundChange?.(Number(e.target.value))}
                placeholder="0"
                className="w-full px-4 py-3 rounded-lg bg-slate-900 border border-slate-700 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                {t("marketCreation.highBound")}
              </label>
              <input
                type="number"
                value={hiBound ?? ""}
                onChange={(e) => onHiBoundChange?.(Number(e.target.value))}
                placeholder="100"
                className="w-full px-4 py-3 rounded-lg bg-slate-900 border border-slate-700 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              {t("marketCreation.unit")}
            </label>
            <input
              type="text"
              value={unit ?? ""}
              onChange={(e) => onUnitChange?.(e.target.value)}
              placeholder={t("marketCreation.unitPlaceholder")}
              className="w-full px-4 py-3 rounded-lg bg-slate-900 border border-slate-700 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              {t("marketCreation.precision")}
            </label>
            <input
              type="number"
              min={0}
              max={8}
              value={precision ?? ""}
              onChange={(e) => onPrecisionChange?.(Number(e.target.value))}
              placeholder="0"
              className="w-full px-4 py-3 rounded-lg bg-slate-900 border border-slate-700 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
            />
            <p className="text-xs text-slate-500 mt-1.5">{t("marketCreation.precisionHint")}</p>
          </div>
        </div>

        <button
          onClick={() => onNext?.()}
          disabled={!canProceed}
          className={`w-full py-3 rounded-full font-semibold text-sm transition-colors ${
            canProceed
              ? "bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-600/25"
              : "bg-slate-800 text-slate-500 cursor-not-allowed"
          }`}
        >
          {t("common.next")}
        </button>
      </div>
    );
  }

  // Yes/No market
  if (outcomeType === "yesno" && outcomes) {
    const canProceedYesNo = outcomes.every((outcome) => outcome.label.trim().length > 0);

    return (
      <div className="w-full max-w-xl">
        <h2 className="text-xl sm:text-2xl font-bold text-white mb-2">
          {t("marketCreation.marketOutcomes")}
        </h2>
        <p className="text-sm text-slate-400 mb-8">{t("marketCreation.marketOutcomesDesc")}</p>

        <div className="space-y-3 mb-4">
          {outcomes.map((outcome) => (
            <div key={outcome.id} className="p-4 rounded-lg bg-slate-900 border border-slate-700">
              <div className="flex items-center gap-3">
                <div
                  className={`w-10 h-10 rounded-lg ${outcome.id === "yes" ? "bg-green-500/15" : "bg-red-500/15"} flex items-center justify-center`}
                >
                  <span
                    className={`${outcome.id === "yes" ? "text-green-400" : "text-red-400"} font-bold text-sm`}
                  >
                    {outcome.id === "yes"
                      ? t("marketCreation.outcomeYesLetter")
                      : t("marketCreation.outcomeNoLetter")}
                  </span>
                </div>
                <div>
                  <p className="font-medium text-white text-sm">{outcome.label}</p>
                </div>
              </div>
            </div>
          ))}
        </div>

        <button
          onClick={() => onNext?.()}
          disabled={!canProceedYesNo}
          className={`w-full py-3 rounded-full font-semibold text-sm transition-colors ${
            canProceedYesNo
              ? "bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-600/25"
              : "bg-slate-800 text-slate-500 cursor-not-allowed"
          }`}
        >
          {t("common.next")}
        </button>
      </div>
    );
  }

  // Categorical outcomes
  const labelsAvoidOutcomeSetSeparator = outcomes
    ? outcomes.every((o) => !o.label.includes("|"))
    : false;
  const canAddOutcome = (outcomes?.length ?? 0) < MAX_MARKET_OUTCOMES;
  const canProceed =
    outcomes &&
    outcomes.length >= 2 &&
    outcomes.length <= MAX_MARKET_OUTCOMES &&
    outcomes.every((o) => o.label.trim().length > 0) &&
    labelsAvoidOutcomeSetSeparator;

  return (
    <div className="w-full max-w-xl">
      <h2 className="text-xl sm:text-2xl font-bold text-white mb-2">
        {t("marketCreation.defineOutcomes")}
      </h2>
      <p className="text-sm text-slate-400 mb-8">{t("marketCreation.defineOutcomesDesc")}</p>

      <div className="space-y-3 mb-4">
        {outcomes?.map((outcome) => (
          <div key={outcome.id} className="p-4 rounded-lg bg-slate-900 border border-slate-700">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <input
                  data-outcome-label-input={outcome.id}
                  type="text"
                  value={outcome.label}
                  onChange={(e) => onOutcomeLabelChange?.(outcome.id, e.target.value)}
                  placeholder={t("marketCreation.outcomeLabelPlaceholder")}
                  className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
                />
              </div>

              <button
                onClick={() => onRemoveOutcome?.(outcome.id)}
                className="p-2 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-400/10 transition-colors"
              >
                <Trash2 className="w-4 h-4" strokeWidth={1.5} />
              </button>
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={() => onAddOutcome?.()}
        disabled={!canAddOutcome}
        className={`mb-4 inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
          canAddOutcome
            ? "bg-blue-600 text-white shadow-lg shadow-blue-600/20 hover:bg-blue-500"
            : "bg-slate-800 text-slate-500 cursor-not-allowed"
        }`}
      >
        <Plus className="w-4 h-4" strokeWidth={1.5} />
        {t("marketCreation.addOutcome")}
      </button>

      {outcomes && outcomes.length > 0 && !labelsAvoidOutcomeSetSeparator && (
        <div className="mb-8">
          <p className="text-xs text-red-400 mt-2">
            {t("marketCreation.outcomeLabelSeparatorError")}
          </p>
        </div>
      )}

      <button
        onClick={() => onNext?.()}
        disabled={!canProceed}
        className={`w-full py-3 rounded-full font-semibold text-sm transition-colors ${
          canProceed
            ? "bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-600/25"
            : "bg-slate-800 text-slate-500 cursor-not-allowed"
        }`}
      >
        {t("common.next")}
      </button>
    </div>
  );
}
