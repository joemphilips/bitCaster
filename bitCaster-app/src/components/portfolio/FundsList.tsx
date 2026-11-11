import { useTranslation } from "react-i18next";
import type {
  WalletRecoveryHoldingsRead,
  WalletRecoveryStatus,
} from "@bitcaster/client-sdk/walletRecoveryStatus";
import type { Fund } from "@/types/portfolio";
import { normalizeUrl } from "@/lib/url";
import { walletRecoveryRowsEmptyIsTerminal } from "@/lib/walletRecoveryDisplay";
import { FundRow } from "./FundRow";

interface FundsListProps {
  /** The rows to show: the read value, or the display-only projection while the read is not `ok`. */
  funds: Fund[];
  read: WalletRecoveryHoldingsRead<Fund>;
  recoveryStatus: WalletRecoveryStatus;
}

export function FundsList({ funds, read, recoveryStatus }: FundsListProps) {
  const { t } = useTranslation();
  if (funds.length === 0) {
    // Until the recovery completes and a later read is empty, nothing is known to be empty.
    if (!walletRecoveryRowsEmptyIsTerminal(recoveryStatus, read, funds)) return null;
    return (
      <div className="py-8 text-center text-sm text-slate-400 dark:text-slate-500">
        {t("portfolio.noFunds")}
      </div>
    );
  }

  // Projection rows show while the read is not ok. Before the recovery
  // completes, their amounts are provisional.
  const provisional = read.kind !== "ok" && recoveryStatus.kind !== "completed";
  // A row keeps its key when the real read replaces the projection, so its
  // amount can fade to the normal style.
  const seen = new Map<string, number>();
  return (
    <ul className="space-y-1" aria-label={t("portfolio.funds")}>
      {funds.map((fund) => {
        const mint = normalizeUrl(fund.mintUrl);
        const index = seen.get(mint) ?? 0;
        seen.set(mint, index + 1);
        return <FundRow key={`${mint}\u0000${index}`} fund={fund} provisional={provisional} />;
      })}
    </ul>
  );
}
