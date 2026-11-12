import { useId, useRef, useState } from "react";
import { Upload, X, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { WizardStepBasicInfo } from "@/types/market-creation";
import { DateTimePicker } from "@/components/shared/DateTimePicker";
import { MAX_MARKET_CREATION_MATURITY_EPOCH } from "@bitcaster/client-sdk/marketCreationInput";
import {
  inspectNewMarketCreationText,
  MAX_MARKET_TITLE_CHARACTERS,
  MAX_MARKET_TITLE_UTF8_BYTES,
} from "@bitcaster/client-sdk/marketCreationLimits";
import { marketCreationTextError, marketCreationTagsError } from "@/lib/marketCreationValidation";

interface BasicInfoProps {
  data: WizardStepBasicInfo;
  categoryTags: string[];
  onTitleChange?: (title: string) => void;
  onCategoryTagsChange?: (tags: string[]) => void;
  onClosingDateChange?: (date: string) => void;
  onThumbnailUpload?: (file: File) => void;
  onThumbnailRemove?: () => void;
  thumbnailPending?: boolean;
  thumbnailError?: string | null;
  /** A rejected file is not the selection. Its neutral notice neither blocks Next nor offers Remove. */
  thumbnailRejectionNotice?: string | null;
  thumbnailLocked?: boolean;
  onNext?: () => void;
}

export function BasicInfo({
  data,
  categoryTags,
  onTitleChange,
  onCategoryTagsChange,
  onClosingDateChange,
  onThumbnailUpload,
  onThumbnailRemove,
  thumbnailPending = false,
  thumbnailError = null,
  thumbnailRejectionNotice = null,
  thumbnailLocked = false,
  onNext,
}: BasicInfoProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const thumbnailErrorId = useId();
  const titleId = useId();
  const titleCountId = useId();
  const titleErrorId = useId();
  const tagsErrorId = useId();
  const categoriesId = useId();
  const dateErrorId = useId();
  const [titleBlurred, setTitleBlurred] = useState(false);
  const text = inspectNewMarketCreationText({ ...data, description: "" });
  const titleError = marketCreationTextError(
    t,
    "title",
    text.title.issue === "required" && !titleBlurred ? null : text.title.issue,
  );
  const tagsError = text.mintTagsIssue ? marketCreationTagsError(t, text.mintTagsIssue) : null;
  const maxMaturity = new Date(MAX_MARKET_CREATION_MATURITY_EPOCH * 1000);
  const maturity = new Date(data.closingDate).getTime() / 1000;
  const dateError =
    maturity > MAX_MARKET_CREATION_MATURITY_EPOCH
      ? t("marketCreation.endTimeTooLate", { maxDate: maxMaturity.toLocaleString() })
      : null;
  // A selection error blocks Next. A rejected file leaves a valid draft, so it is a notice.
  const thumbnailMessage = thumbnailError ?? thumbnailRejectionNotice;
  const canProceed =
    !thumbnailPending &&
    !thumbnailError &&
    !text.title.issue &&
    !tagsError &&
    !dateError &&
    data.closingDate.length > 0 &&
    new Date(data.closingDate) > new Date();

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onThumbnailUpload?.(file);
    // Permit retrying the same file after a failed retention attempt.
    e.target.value = "";
  };

  return (
    <div className="w-full max-w-xl">
      <h2 className="text-xl sm:text-2xl font-bold text-white mb-8">
        {t("marketCreation.basicInfo")}
      </h2>

      <div className="space-y-6">
        {/* Thumbnail */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">
            {t("marketCreation.thumbnail")}
          </label>
          <div
            className="flex items-center gap-4"
            data-testid="market-thumbnail-drop"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (!thumbnailLocked && !thumbnailPending && event.dataTransfer.files.length === 1) {
                onThumbnailUpload?.(event.dataTransfer.files[0]!);
              }
            }}
          >
            <div className="w-28 h-28 rounded-lg border-2 border-dashed border-slate-700 bg-slate-900 flex flex-col items-center justify-center text-slate-500 overflow-hidden">
              {data.imageFile ? (
                <img
                  src={data.imageFile}
                  alt={t("marketCreation.thumbnail")}
                  className="w-full h-full object-cover"
                />
              ) : (
                <>
                  <Plus className="w-6 h-6 mb-1" strokeWidth={1.5} />
                  <span className="text-xs">{t("marketCreation.noImage")}</span>
                </>
              )}
            </div>
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={thumbnailLocked}
                onChange={handleFileChange}
                className="hidden"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={thumbnailLocked}
                aria-describedby={thumbnailMessage ? thumbnailErrorId : undefined}
                className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors"
              >
                <Upload className="w-4 h-4 inline-block mr-1.5" strokeWidth={1.5} />
                {t("marketCreation.uploadImage")}
              </button>
              {(data.imageFile || thumbnailPending || thumbnailError) && (
                <button
                  type="button"
                  onClick={onThumbnailRemove}
                  disabled={thumbnailLocked}
                  className="ml-2 rounded-lg px-3 py-2 text-sm text-slate-300 disabled:opacity-50"
                >
                  {t("common.remove")}
                </button>
              )}
              {thumbnailPending && (
                <p role="status" className="mt-2 text-sm text-slate-400">
                  {t("common.loading")}
                </p>
              )}
              {thumbnailError ? (
                <p id={thumbnailErrorId} role="alert" className="mt-2 text-sm text-red-400">
                  {thumbnailError}
                </p>
              ) : (
                thumbnailRejectionNotice && (
                  <p id={thumbnailErrorId} role="status" className="mt-2 text-sm text-slate-400">
                    {thumbnailRejectionNotice}
                  </p>
                )
              )}
            </div>
          </div>
        </div>

        {/* Title */}
        <div>
          <label htmlFor={titleId} className="block text-sm font-medium text-slate-300 mb-2">
            {t("marketCreation.titleLabel")}
          </label>
          <input
            id={titleId}
            type="text"
            value={data.title}
            onBlur={() => setTitleBlurred(true)}
            aria-invalid={!!titleError}
            aria-describedby={[titleCountId, titleError ? titleErrorId : null]
              .filter(Boolean)
              .join(" ")}
            onChange={(e) => onTitleChange?.(e.target.value)}
            placeholder={t("marketCreation.titlePlaceholder")}
            className="w-full px-4 py-3 rounded-lg bg-slate-900 border border-slate-700 text-white text-sm placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
          />
          <p id={titleCountId} className="mt-2 text-xs text-slate-400">
            {t("marketCreation.textCount", {
              characters: text.title.characters,
              maxCharacters: MAX_MARKET_TITLE_CHARACTERS,
              bytes: text.title.utf8Bytes,
              maxBytes: MAX_MARKET_TITLE_UTF8_BYTES,
            })}
          </p>
          {titleError && (
            <p id={titleErrorId} role="alert" className="mt-2 text-sm text-red-400">
              {titleError}
            </p>
          )}
        </div>

        {/* Categories */}
        <div>
          <label htmlFor={categoriesId} className="block text-sm font-medium text-slate-300 mb-2">
            {t("marketCreation.categories")}
          </label>
          <div className="flex flex-wrap gap-2 mb-2">
            {data.categoryTags.map((tag) => (
              <span
                key={tag}
                className="flex items-center gap-1 px-3 py-1.5 rounded-full bg-blue-500/15 text-blue-400 text-xs font-medium"
              >
                {tag}
                <button
                  aria-label={t("marketCreation.removeCategory", { category: tag })}
                  onClick={() => onCategoryTagsChange?.(data.categoryTags.filter((t) => t !== tag))}
                  className="hover:text-blue-200 transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
          <select
            id={categoriesId}
            aria-invalid={!!tagsError}
            aria-describedby={tagsError ? tagsErrorId : undefined}
            onChange={(e) => {
              if (e.target.value && !data.categoryTags.includes(e.target.value)) {
                onCategoryTagsChange?.([...data.categoryTags, e.target.value]);
              }
              e.target.value = "";
            }}
            defaultValue=""
            className="w-full px-4 py-3 rounded-lg bg-slate-900 border border-slate-700 text-sm text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-colors"
          >
            <option value="" disabled>
              {t("marketCreation.categoriesSelectPlaceholder")}
            </option>
            {categoryTags
              .filter((tag) => !data.categoryTags.includes(tag))
              .map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
          </select>
          {tagsError && (
            <p id={tagsErrorId} role="alert" className="mt-2 text-sm text-red-400">
              {tagsError}
            </p>
          )}
        </div>

        {/* Closing Date */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">
            {t("marketCreation.endTime")}
          </label>
          <DateTimePicker
            value={data.closingDate}
            onChange={(v) => onClosingDateChange?.(v)}
            min={new Date()}
            placeholder={t("marketCreation.endTimePlaceholder")}
            aria-label={t("marketCreation.endTime")}
            aria-invalid={!!dateError}
            aria-describedby={dateError ? dateErrorId : undefined}
          />
          {dateError && (
            <p id={dateErrorId} role="alert" className="mt-2 text-sm text-red-400">
              {dateError}
            </p>
          )}
        </div>
      </div>

      <button
        onClick={() => onNext?.()}
        disabled={!canProceed}
        className={`w-full py-3 rounded-full font-semibold text-sm transition-colors mt-8 ${
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
