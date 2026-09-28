import { useTranslation } from "react-i18next";
import type { PortfolioStats } from "@/types/portfolio";
import { InlineAmount } from "@/components/shared/InlineAmount";
import type { AmountByUnit } from "@/lib/formatAmount";
import type { ReactNode } from "react";
import { LoaderCircle } from "lucide-react";

interface StatsRowProps {
  stats: PortfolioStats;
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

export function StatsRow({ stats }: StatsRowProps) {
  const { t } = useTranslation();
  return (
    <div className="flex items-stretch divide-x divide-slate-200 dark:divide-slate-700 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700">
      <StatCard
        label={t("portfolio.totalValue")}
        loading={stats.totalValueLoading}
        value={formatTotals(stats.totalValueByUnit, stats.totalValueSats, stats.totalValueKnown)}
      />
      <StatCard
        label={t("portfolio.positionsValue")}
        loading={stats.positionsValueLoading}
        value={formatTotals(
          stats.positionsValueByUnit,
          stats.positionsValueSats,
          stats.positionsValueKnown,
        )}
      />
      <StatCard label={t("portfolio.predictions")} value={stats.predictionsCount.toString()} />
    </div>
  );
}
