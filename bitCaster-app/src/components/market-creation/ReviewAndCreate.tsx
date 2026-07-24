import { FileText, Tag, Calendar, BarChart3, Loader2 } from "lucide-react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import type { WizardStepBasicInfo, WizardStepOutcomes } from "@/types/market-creation";

interface ReviewAndCreateProps {
  description: string;
  basicInfo: WizardStepBasicInfo | null;
  outcomes: WizardStepOutcomes | null;
  isSubmitting: boolean;
  submitError: string | null;
  onDescriptionChange?: (description: string) => void;
  onCreateMarket?: () => void;
}

export function ReviewAndCreate({
  description,
  basicInfo,
  outcomes,
  isSubmitting,
  submitError,
  onDescriptionChange,
  onCreateMarket,
}: ReviewAndCreateProps) {
  const { t } = useTranslation();
  const canCreate = description.trim().length > 0 && !isSubmitting;

  return (
    <div className="w-full max-w-xl">
      <h2 className="text-xl sm:text-2xl font-bold text-white mb-2">
        {t("marketCreation.reviewAndCreate")}
      </h2>
      <p className="text-sm text-slate-400 mb-8">{t("marketCreation.reviewAndCreateDesc")}</p>

      {/* Description */}
      <div className="mb-8">
        <label className="block text-sm font-medium text-slate-300 mb-2">
          {t("marketCreation.description")}
        </label>
        <textarea
          value={description}
          onChange={(e) => onDescriptionChange?.(e.target.value)}
          placeholder={t("marketCreation.descriptionPlaceholder")}
          rows={6}
          className="w-full px-4 py-3 rounded-lg bg-slate-900 border border-slate-700 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors resize-none"
        />
        <p className="text-xs text-slate-500 mt-1.5">{t("marketCreation.descriptionHint")}</p>
      </div>

      {/* Market summary card */}
      <div className="p-5 rounded-xl bg-slate-900 border border-slate-700 mb-8">
        <h3 className="text-sm font-semibold text-white mb-4">
          {t("marketCreation.marketSummary")}
        </h3>

        <div className="space-y-4">
          {basicInfo && (
            <div className="flex items-start gap-3">
              <FileText className="w-4 h-4 text-slate-500 mt-0.5 shrink-0" strokeWidth={1.5} />
              <div>
                <p className="text-xs text-slate-400">{t("marketCreation.titleSummaryLabel")}</p>
                <p className="text-sm text-white">{basicInfo.title || t("common.untitled")}</p>
              </div>
            </div>
          )}

          {basicInfo && basicInfo.categoryTags.length > 0 && (
            <div className="flex items-start gap-3">
              <Tag className="w-4 h-4 text-slate-500 mt-0.5 shrink-0" strokeWidth={1.5} />
              <div>
                <p className="text-xs text-slate-400">
                  {t("marketCreation.categoriesSummaryLabel")}
                </p>
                <div className="flex flex-wrap gap-1 mt-0.5">
                  {basicInfo.categoryTags.map((tag) => (
                    <span
                      key={tag}
                      className="px-2 py-0.5 rounded-full bg-slate-800 text-xs text-slate-300"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}

          {basicInfo && basicInfo.closingDate && (
            <div className="flex items-start gap-3">
              <Calendar className="w-4 h-4 text-slate-500 mt-0.5 shrink-0" strokeWidth={1.5} />
              <div>
                <p className="text-xs text-slate-400">{t("marketCreation.closingDateLabel")}</p>
                <p className="text-sm text-white">
                  {new Date(basicInfo.closingDate).toLocaleString()}
                </p>
              </div>
            </div>
          )}

          {outcomes && (
            <div className="flex items-start gap-3">
              <BarChart3 className="w-4 h-4 text-slate-500 mt-0.5 shrink-0" strokeWidth={1.5} />
              <div>
                <p className="text-xs text-slate-400">{t("marketCreation.outcomesLabel")}</p>
                {outcomes.outcomeType === "numeric" ? (
                  <p className="text-sm text-white">
                    {outcomes.precision !== undefined
                      ? t("marketCreation.numericSummaryWithPrecision", {
                          lo: outcomes.loBound ?? "?",
                          hi: outcomes.hiBound ?? "?",
                          unit: outcomes.unit ?? "",
                          precision: outcomes.precision,
                        })
                      : t("marketCreation.numericSummary", {
                          lo: outcomes.loBound ?? "?",
                          hi: outcomes.hiBound ?? "?",
                          unit: outcomes.unit ?? "",
                        })}
                  </p>
                ) : (
                  <>
                    <p className="text-sm text-white capitalize">
                      {outcomes.outcomeType === "yesno"
                        ? t("marketCreation.yesNoSummaryLabel")
                        : t("marketCreation.outcomesCountSummary", {
                            count: outcomes.outcomes?.length ?? 0,
                          })}
                    </p>
                    {outcomes.outcomes && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {outcomes.outcomes.map((o) => (
                          <span
                            key={o.id}
                            className="px-2 py-0.5 rounded-full bg-slate-800 text-xs text-slate-300"
                          >
                            {o.probability !== undefined
                              ? t("marketCreation.outcomeWithProbability", {
                                  label: o.label || t("common.unnamed"),
                                  probability: o.probability,
                                })
                              : o.label || t("common.unnamed")}
                          </span>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Create button */}
      <button
        onClick={() => onCreateMarket?.()}
        disabled={!canCreate}
        className={`w-full py-3.5 rounded-full font-semibold text-sm transition-colors flex items-center justify-center gap-2 ${
          canCreate
            ? "bg-green-600 hover:bg-green-700 text-white shadow-lg shadow-green-600/25"
            : "bg-slate-800 text-slate-500 cursor-not-allowed"
        }`}
      >
        {isSubmitting ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            {t("marketCreation.creatingMarket")}
          </>
        ) : (
          t("marketCreation.createMarket")
        )}
      </button>

      {/* Error banner — placed under the button so it is adjacent to the
          action that triggered it. Prior placement at the top of the page
          left users staring at the button with no feedback in view. */}
      {submitError && (
        <div role="alert" className="mt-4 p-4 rounded-xl bg-red-500/10 border border-red-500/20">
          <p className="text-sm text-red-400">{submitError}</p>
          {submitError.includes("Settings") && (
            <Link
              to="/settings?category=nostr"
              className="mt-2 inline-block text-sm font-medium text-red-300 underline hover:text-red-200"
            >
              {t("marketCreation.openSettings")}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
