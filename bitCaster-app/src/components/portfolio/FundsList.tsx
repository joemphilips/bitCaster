import { useTranslation } from "react-i18next";
import type { Fund } from "@/types/portfolio";
import { FundRow } from "./FundRow";

interface FundsListProps {
  funds: Fund[];
}

export function FundsList({ funds }: FundsListProps) {
  const { t } = useTranslation();
  if (funds.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-slate-400 dark:text-slate-500">
        {t("portfolio.noFunds")}
      </div>
    );
  }

  return (
    <ul className="space-y-1" aria-label={t("portfolio.funds")}>
      {funds.map((fund) => (
        <FundRow key={fund.id} fund={fund} />
      ))}
    </ul>
  );
}
