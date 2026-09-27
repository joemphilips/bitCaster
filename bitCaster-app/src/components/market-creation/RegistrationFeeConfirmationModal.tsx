import { Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { MarketBaseAsset } from "@/types/market-creation";
import { formatMarketSubunits } from "@bitcaster/client-sdk/marketUnits";
import { NativeDialog } from "@/components/shared/NativeDialog";

interface RegistrationFeeConfirmationModalProps {
  feeSubunits: number;
  balanceSubunits: number;
  baseAsset: MarketBaseAsset;
  onCancel: () => void;
  onConfirm: () => void;
}

export function RegistrationFeeConfirmationModal({
  feeSubunits,
  balanceSubunits,
  baseAsset,
  onCancel,
  onConfirm,
}: RegistrationFeeConfirmationModalProps) {
  const { t } = useTranslation();
  const feeAmount = formatMarketSubunits(feeSubunits, baseAsset);
  const balanceAmount = formatMarketSubunits(balanceSubunits, baseAsset);

  return (
    <NativeDialog ariaLabel={t("marketCreation.registrationFeeTitle")} onDismiss={onCancel}>
      {(dismiss) => (
        <div
          data-testid="registration-fee-dialog-backdrop"
          className="flex min-h-full items-center justify-center"
          onClick={(event) => {
            if (event.target === event.currentTarget) dismiss();
          }}
        >
          <div className="relative mx-4 max-w-sm rounded-2xl border border-slate-200 bg-white p-6 text-center dark:border-slate-700 dark:bg-slate-800">
            <div className="w-16 h-16 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mx-auto mb-4">
              <Zap className="w-8 h-8 text-[#f7931a]" />
            </div>

            <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-2">
              {t("marketCreation.registrationFeeTitle")}
            </h2>

            <p className="text-slate-500 dark:text-slate-400 text-sm mb-1">
              {t("marketCreation.registrationFeeDescription", {
                amount: feeAmount,
              })}
            </p>
            <p className="text-slate-500 dark:text-slate-400 text-sm mb-6">
              {t("marketCreation.registrationFeeBalancePrefix")}{" "}
              <span className="font-mono text-slate-700 dark:text-slate-200">{balanceAmount}</span>{" "}
              {t("marketCreation.registrationFeeBalanceSuffix")}
            </p>

            <div className="flex gap-3">
              <button
                data-testid="registration-fee-cancel"
                onClick={dismiss}
                className="flex-1 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 font-medium hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
              >
                {t("common.cancel")}
              </button>
              <button
                data-testid="registration-fee-confirm"
                onClick={onConfirm}
                className="flex-1 py-2.5 rounded-xl bg-[#f7931a] hover:bg-[#e8850f] text-white font-semibold transition-colors"
              >
                {t("marketCreation.registrationFeeConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </NativeDialog>
  );
}
