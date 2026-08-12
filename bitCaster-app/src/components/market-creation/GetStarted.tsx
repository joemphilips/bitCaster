import { ToggleLeft, LayoutGrid, SlidersHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { OutcomeType } from "@/types/market-creation";

interface GetStartedProps {
  outcomeType: OutcomeType | null;
  onOutcomeTypeSelect?: (type: OutcomeType) => void;
  onNext?: () => void;
}

interface OutcomeOption {
  type: OutcomeType;
  icon: typeof ToggleLeft;
  labelKey: string;
  descriptionKey: string;
}

const options: OutcomeOption[] = [
  {
    type: "yesno",
    icon: ToggleLeft,
    labelKey: "marketCreation.yesNo",
    descriptionKey: "marketCreation.yesNoDesc",
  },
  {
    type: "categorical",
    icon: LayoutGrid,
    labelKey: "marketCreation.categorical",
    descriptionKey: "marketCreation.categoricalDesc",
  },
  {
    type: "numeric",
    icon: SlidersHorizontal,
    labelKey: "marketCreation.numeric",
    descriptionKey: "marketCreation.numericDesc",
  },
];

export function GetStarted({ outcomeType, onOutcomeTypeSelect, onNext }: GetStartedProps) {
  const { t } = useTranslation();
  return (
    <div className="w-full max-w-xl">
      <h2 className="text-xl sm:text-2xl font-bold text-white mb-2">
        {t("marketCreation.getStarted")}
      </h2>
      <p className="text-sm text-slate-400 mb-8">{t("marketCreation.getStartedDesc")}</p>

      <div className="space-y-4 mb-8">
        {options.map(({ type, icon: Icon, labelKey, descriptionKey }) => (
          <button
            key={type}
            onClick={() => {
              if (type !== "numeric") onOutcomeTypeSelect?.(type);
            }}
            disabled={type === "numeric"}
            className={`w-full p-5 rounded-xl border-2 transition-all text-left ${
              outcomeType === type
                ? "border-blue-500 bg-blue-500/10"
                : "border-slate-700 bg-slate-900 hover:border-slate-600"
            } ${type === "numeric" ? "opacity-50 cursor-not-allowed hover:border-slate-700" : ""}`}
          >
            <div className="flex items-start gap-4">
              <div
                className={`p-2.5 rounded-lg ${outcomeType === type ? "bg-blue-500/20" : "bg-slate-800"}`}
              >
                <Icon
                  className={`w-6 h-6 ${outcomeType === type ? "text-blue-400" : "text-slate-500"}`}
                  strokeWidth={1.5}
                />
              </div>
              <div>
                <p className="font-semibold text-white mb-1">{t(labelKey)}</p>
                <p className="text-sm text-slate-400">{t(descriptionKey)}</p>
              </div>
            </div>
          </button>
        ))}
      </div>

      <button
        onClick={() => onNext?.()}
        disabled={!outcomeType}
        className={`w-full py-3 rounded-full font-semibold text-sm transition-colors ${
          outcomeType
            ? "bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-600/25"
            : "bg-slate-800 text-slate-500 cursor-not-allowed"
        }`}
      >
        {t("common.next")}
      </button>
    </div>
  );
}
