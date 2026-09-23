import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatAmount } from "@/lib/formatAmount";
import type { MarketBaseAsset } from "@bitcaster/client-sdk/marketUnits";

const AUTO_ADVANCE_MS = 3000;
const PROGRESS_TICK_MS = 50;

interface SuccessViewProps {
  amountMsat: number;
  baseAsset: MarketBaseAsset;
  amountLabel?: string;
  onClose: () => void;
}

export function SuccessView({ amountMsat, baseAsset, amountLabel, onClose }: SuccessViewProps) {
  const { t } = useTranslation();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [remainingMs, setRemainingMs] = useState(AUTO_ADVANCE_MS);

  useEffect(() => {
    const startedAt = Date.now();
    const updateRemaining = () => {
      const elapsed = Date.now() - startedAt;
      setRemainingMs(Math.max(0, AUTO_ADVANCE_MS - elapsed));
    };
    const progressInterval = window.setInterval(updateRemaining, PROGRESS_TICK_MS);
    const closeTimer = window.setTimeout(() => onCloseRef.current(), AUTO_ADVANCE_MS);
    updateRemaining();
    return () => {
      window.clearInterval(progressInterval);
      window.clearTimeout(closeTimer);
    };
  }, []);

  const progressPercent = Math.max(0, Math.min(100, (remainingMs / AUTO_ADVANCE_MS) * 100));

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/95 flex flex-col items-center justify-center">
      <div className="w-20 h-20 rounded-full bg-emerald-500/20 flex items-center justify-center mb-6">
        <Check className="w-10 h-10 text-emerald-400" />
      </div>
      <h2 className="text-2xl font-bold text-white mb-2">{t("common.success")}</h2>
      {amountMsat > 0 && (
        <p className="text-lg font-mono text-emerald-400">
          {amountLabel ?? formatAmount(amountMsat, baseAsset)}
        </p>
      )}
      <p className="text-sm text-slate-400 mt-4">{t("deposit.autoClose")}</p>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progressPercent)}
        aria-label={t("deposit.autoCloseProgress")}
        className="mt-4 h-1.5 w-48 overflow-hidden rounded-full bg-slate-800"
      >
        <div
          data-testid="auto-advance-progress"
          className="h-full rounded-full bg-emerald-400 transition-[width] duration-75 ease-linear"
          style={{ width: `${progressPercent}%` }}
        />
      </div>
    </div>
  );
}
