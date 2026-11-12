import { FileText, Tag, Calendar, BarChart3, Loader2, Image as ImageIcon } from "lucide-react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import type { WizardStepBasicInfo, WizardStepOutcomes } from "@/types/market-creation";
import { categoricalOutcomeColors, normalizeOutcomeColor } from "@/components/shared/OutcomeLabel";
import { useId, useRef, useState } from "react";
import {
  inspectNewMarketCreationText,
  MAX_MARKET_DESCRIPTION_CHARACTERS,
  MAX_MARKET_DESCRIPTION_UTF8_BYTES,
} from "@bitcaster/client-sdk/marketCreationLimits";
import { marketCreationTextError, marketCreationTagsError } from "@/lib/marketCreationValidation";

import { MarketMarkdown } from "@/components/shared/MarketMarkdown";

type DescriptionTab = "write" | "preview";
const DESCRIPTION_TABS: readonly DescriptionTab[] = ["write", "preview"];

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
  const [descriptionTab, setDescriptionTab] = useState<DescriptionTab>("write");
  const tabIdPrefix = useId();
  const tabRefs = useRef<Partial<Record<DescriptionTab, HTMLButtonElement>>>({});
  const descriptionId = useId();
  const descriptionCountId = useId();
  const descriptionErrorId = useId();
  const metadataErrorId = useId();
  const [descriptionBlurred, setDescriptionBlurred] = useState(false);
  const text = inspectNewMarketCreationText({
    title: basicInfo?.title ?? "",
    description,
    categoryTags: basicInfo?.categoryTags ?? [],
  });
  const descriptionError = marketCreationTextError(
    t,
    "description",
    text.description.issue === "required" && !descriptionBlurred ? null : text.description.issue,
  );
  const metadataError =
    marketCreationTextError(t, "title", text.title.issue) ??
    (text.mintTagsIssue ? marketCreationTagsError(t, text.mintTagsIssue) : null);
  const canCreate = !text.description.issue && !metadataError && !isSubmitting;
  const colors =
    outcomes?.outcomeType === "categorical"
      ? categoricalOutcomeColors(outcomes.outcomes ?? [])
      : null;

  return (
    <div className="w-full max-w-xl">
      <h2 className="text-xl sm:text-2xl font-bold text-white mb-8">
        {t("marketCreation.reviewAndCreate")}
      </h2>

      {/* Description */}
      <div className="mb-8">
        <div className="mb-2 flex items-end justify-between gap-3">
          <label htmlFor={descriptionId} className="block text-sm font-medium text-slate-300">
            {t("marketCreation.description")}
          </label>
          <div role="tablist" aria-label={t("marketCreation.description")} className="flex gap-1">
            {DESCRIPTION_TABS.map((tab, index) => (
              <button
                key={tab}
                ref={(node) => {
                  tabRefs.current[tab] = node ?? undefined;
                }}
                type="button"
                role="tab"
                id={`${tabIdPrefix}-${tab}-tab`}
                aria-selected={descriptionTab === tab}
                aria-controls={`${tabIdPrefix}-${tab}-panel`}
                tabIndex={descriptionTab === tab ? 0 : -1}
                onClick={() => setDescriptionTab(tab)}
                onKeyDown={(event) => {
                  let next: DescriptionTab;
                  switch (event.key) {
                    case "ArrowRight":
                      next = DESCRIPTION_TABS[(index + 1) % DESCRIPTION_TABS.length]!;
                      break;
                    case "ArrowLeft":
                      next =
                        DESCRIPTION_TABS[
                          (index + DESCRIPTION_TABS.length - 1) % DESCRIPTION_TABS.length
                        ]!;
                      break;
                    case "Home":
                      next = DESCRIPTION_TABS[0]!;
                      break;
                    case "End":
                      next = DESCRIPTION_TABS[DESCRIPTION_TABS.length - 1]!;
                      break;
                    default:
                      return;
                  }
                  event.preventDefault();
                  setDescriptionTab(next);
                  tabRefs.current[next]?.focus();
                }}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${descriptionTab === tab ? "bg-slate-800 text-white" : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"}`}
              >
                {t(`marketCreation.${tab}`)}
              </button>
            ))}
          </div>
        </div>
        {/* Keep the textarea mounted to retain edit history; measure its raw source in both modes. */}
        <div
          id={`${tabIdPrefix}-write-panel`}
          role="tabpanel"
          aria-labelledby={`${tabIdPrefix}-write-tab`}
          hidden={descriptionTab !== "write"}
        >
          <textarea
            id={descriptionId}
            value={description}
            onBlur={() => setDescriptionBlurred(true)}
            aria-invalid={!!descriptionError}
            aria-describedby={[descriptionCountId, descriptionError ? descriptionErrorId : null]
              .filter(Boolean)
              .join(" ")}
            onChange={(e) => onDescriptionChange?.(e.target.value)}
            placeholder={t("marketCreation.descriptionPlaceholder")}
            rows={6}
            className="w-full px-4 py-3 rounded-lg bg-slate-900 border border-slate-700 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors resize-none"
          />
        </div>
        <div
          id={`${tabIdPrefix}-preview-panel`}
          role="tabpanel"
          aria-labelledby={`${tabIdPrefix}-preview-tab`}
          hidden={descriptionTab !== "preview"}
          tabIndex={0}
          aria-describedby={[descriptionCountId, descriptionError ? descriptionErrorId : null]
            .filter(Boolean)
            .join(" ")}
          className="min-h-[9.5rem] w-full rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-sm leading-relaxed text-slate-300"
        >
          {descriptionTab === "preview" && <MarketMarkdown source={description} />}
        </div>
        <p id={descriptionCountId} className="mt-2 text-xs text-slate-400">
          {t("marketCreation.textCount", {
            characters: text.description.characters,
            maxCharacters: MAX_MARKET_DESCRIPTION_CHARACTERS,
            bytes: text.description.utf8Bytes,
            maxBytes: MAX_MARKET_DESCRIPTION_UTF8_BYTES,
          })}
        </p>
        {descriptionError && (
          <p id={descriptionErrorId} role="alert" className="mt-2 text-sm text-red-400">
            {descriptionError}
          </p>
        )}
      </div>

      {metadataError && (
        <p id={metadataErrorId} role="alert" className="mb-4 text-sm text-red-400">
          {metadataError}
        </p>
      )}

      {/* Market summary card */}
      <div className="p-5 rounded-xl bg-slate-900 border border-slate-700 mb-8">
        <h3 className="text-sm font-semibold text-white mb-4">
          {t("marketCreation.marketSummary")}
        </h3>

        <div className="space-y-4">
          {basicInfo && (
            <div className="flex items-start gap-3">
              <FileText className="w-4 h-4 text-slate-500 mt-0.5 shrink-0" strokeWidth={1.5} />
              <div className="min-w-0">
                <p className="text-xs text-slate-400">{t("marketCreation.titleSummaryLabel")}</p>
                <p className="text-sm text-white [overflow-wrap:anywhere]">
                  {basicInfo.title || t("common.untitled")}
                </p>
              </div>
            </div>
          )}

          {basicInfo && (
            <div className="flex items-start gap-3">
              <ImageIcon className="w-4 h-4 text-slate-500 mt-0.5 shrink-0" strokeWidth={1.5} />
              <div>
                <p className="text-xs text-slate-400">{t("marketCreation.thumbnail")}</p>
                {basicInfo.imageFile ? (
                  <img
                    src={basicInfo.imageFile}
                    alt={t("marketCreation.thumbnail")}
                    className="mt-1 h-12 w-12 rounded object-cover"
                  />
                ) : (
                  <p className="text-sm text-white">{t("marketCreation.noImage")}</p>
                )}
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
                        {outcomes.outcomes.map((o, index) => {
                          const color = colors
                            ? normalizeOutcomeColor(colors[index])
                            : o.color
                              ? normalizeOutcomeColor(o.color)
                              : null;
                          return (
                            <span
                              key={o.id}
                              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-slate-800 text-xs text-slate-300"
                            >
                              {outcomes.outcomeType === "categorical" && color && (
                                <span
                                  aria-hidden="true"
                                  className="h-2.5 w-2.5 rounded-full border border-white/20"
                                  style={{ backgroundColor: color }}
                                />
                              )}
                              <span>{o.label || t("common.unnamed")}</span>
                              {outcomes.outcomeType === "categorical" && (
                                <span className="text-slate-500">
                                  {color ?? t("marketCreation.outcomeColorAutomatic")}
                                </span>
                              )}
                            </span>
                          );
                        })}
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
        aria-describedby={metadataError ? metadataErrorId : undefined}
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
