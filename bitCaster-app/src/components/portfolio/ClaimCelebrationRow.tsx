import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { normalizeMarketBaseAsset } from "@bitcaster/client-sdk/marketUnits";
import { InlineAmount } from "@/components/shared/InlineAmount";
import type { ClaimCelebration } from "@/types/portfolio";

const DISPLAY_MS = 3000;

export function ClaimCelebrationRow({ celebration }: { celebration: ClaimCelebration }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 50);
    return () => window.clearInterval(interval);
  }, []);
  const remaining = Math.max(
    0,
    Math.min(100, ((celebration.expiresAtMs - now) / DISPLAY_MS) * 100),
  );

  return (
    <div
      data-testid="claim-celebration"
      data-claim-id={celebration.id}
      data-position-id={celebration.position.id}
      className="relative mb-2 overflow-hidden rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/40"
    >
      <div
        data-testid="claim-confetti"
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 motion-reduce:hidden"
      >
        {Array.from({ length: 8 }, (_, index) => (
          <span
            key={index}
            className={`absolute top-2 h-1.5 w-1 rounded-sm opacity-0 animate-[claim-confetti_900ms_ease-out_both] ${index % 2 === 0 ? "bg-amber-400" : "bg-blue-400"}`}
            style={{ left: `${9 + index * 12}%`, animationDelay: `${index * 45}ms` }}
          />
        ))}
      </div>
      <div className="relative flex items-start gap-3 p-3">
        <Check
          aria-hidden="true"
          className="mt-0.5 h-5 w-5 shrink-0 text-blue-600 dark:text-blue-400"
        />
        <div className="min-w-0">
          <p className="text-xs text-slate-600 dark:text-slate-400 break-words">
            {celebration.position.marketTitle}
          </p>
          <p role="status" className="mt-1 text-sm font-medium text-blue-900 dark:text-blue-100">
            <Trans
              i18nKey="portfolio.claimCongratulations"
              components={{
                amount: (
                  <InlineAmount
                    amountSubunits={celebration.creditedAmountSubunits}
                    baseAsset={normalizeMarketBaseAsset(celebration.position.baseAsset)}
                    className="font-mono font-semibold"
                  />
                ),
              }}
            />
          </p>
        </div>
      </div>
      <div
        role="progressbar"
        aria-label={t("portfolio.claimFeedbackCountdown")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(remaining)}
        className="h-1 bg-blue-100 dark:bg-blue-900"
      >
        <div
          className="h-full bg-blue-500 motion-safe:transition-[width] motion-safe:duration-75 motion-safe:ease-linear"
          style={{ width: `${remaining}%` }}
        />
      </div>
    </div>
  );
}
