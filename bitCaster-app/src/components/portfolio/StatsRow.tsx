import { useTranslation } from "react-i18next";
import type { PortfolioStats } from "@/types/portfolio";
import { InlineAmount } from "@/components/shared/InlineAmount";
import type { AmountByUnit } from "@/lib/formatAmount";
import type { ReactNode } from "react";
import { LoaderCircle } from "lucide-react";

interface StatsRowProps {
  stats: PortfolioStats;
  /** A seed restore runs or failed, so the total is not known. */
  positionsRestoring?: boolean;
  /**
   * A zero value or a zero count is not final: a seed restore runs or failed,
   * or it completed with limited coverage. The default is `positionsRestoring`.
   */
  zeroUnknown?: boolean;
}

function StatCard({
  label,
  value,
  loading,
}: {
  label: string;
  value: ReactNode;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex-1 text-center py-3">
      <div className="flex items-center justify-center gap-2 text-lg font-bold font-mono text-slate-900 dark:text-white">
        {value}
        {loading && (
          <LoaderCircle
            role="status"
            aria-label={`${label}: ${t("common.loading")}`}
            className="size-4 animate-spin motion-reduce:animate-none"
          />
        )}
      </div>
      <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{label}</div>
    </div>
  );
}

function formatTotals(
  totals: AmountByUnit[] | undefined,
  fallbackSats: number,
  known: boolean | undefined,
): ReactNode {
  if (known === false) return "—";
  const values = totals?.filter((entry) => entry.amount !== 0) ?? [];
  if (values.length === 0) return <InlineAmount amountSubunits={fallbackSats} baseAsset="sat" />;
  return (
    <>
      {values.map((entry, index) => (
        <span key={entry.unit}>
          {index > 0 && " / "}
          <InlineAmount amountSubunits={entry.amount} baseAsset={entry.unit} />
        </span>
      ))}
    </>
  );
}

function totalsAreZero(totals: AmountByUnit[] | undefined, fallbackSats: number): boolean {
  return fallbackSats === 0 && !(totals ?? []).some((entry) => entry.amount !== 0);
}

/**
 * Whether the total value is known. While a seed restore runs or failed, the
 * total also needs the positions, so a partial number would mislead. A zero
 * total that is not final is not known either.
 */
export function shownTotalValueKnown(
  stats: PortfolioStats,
  positionsRestoring: boolean,
  zeroUnknown: boolean,
): boolean | undefined {
  if (positionsRestoring) return false;
  if (zeroUnknown && totalsAreZero(stats.totalValueByUnit, stats.totalValueSats)) return false;
  return stats.totalValueKnown;
}

export function StatsRow({
  stats,
  positionsRestoring = false,
  zeroUnknown = positionsRestoring,
}: StatsRowProps) {
  const { t } = useTranslation();
  // Show a zero that is not final as unknown. A value above zero is already
  // restored, so it stays.
  const positionsValueKnown =
    zeroUnknown && totalsAreZero(stats.positionsValueByUnit, stats.positionsValueSats)
      ? false
      : stats.positionsValueKnown;
  return (
    <div className="flex items-stretch divide-x divide-slate-200 dark:divide-slate-700 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700">
      <StatCard
        label={t("portfolio.totalValue")}
        loading={stats.totalValueLoading}
        value={formatTotals(
          stats.totalValueByUnit,
          stats.totalValueSats,
          shownTotalValueKnown(stats, positionsRestoring, zeroUnknown),
        )}
      />
      <StatCard
        label={t("portfolio.positionsValue")}
        loading={stats.positionsValueLoading}
        value={formatTotals(
          stats.positionsValueByUnit,
          stats.positionsValueSats,
          positionsValueKnown,
        )}
      />
      <StatCard
        label={t("portfolio.predictions")}
        value={
          zeroUnknown && stats.predictionsCount === 0 ? "—" : stats.predictionsCount.toString()
        }
      />
    </div>
  );
}
