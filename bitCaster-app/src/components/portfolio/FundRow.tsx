import type { Fund } from "@/types/portfolio";
import { Coins } from "lucide-react";
import { InlineAmount } from "@/components/shared/InlineAmount";

interface FundRowProps {
  fund: Fund;
  /** The amount is the display-only projection while the wallet recovery checks. */
  provisional?: boolean;
}

export function FundRow({ fund, provisional = false }: FundRowProps) {
  const mintHostname = new URL(fund.mintUrl).hostname;

  return (
    <li className="flex items-center gap-3 rounded-lg p-3" data-amount-subunits={fund.amount}>
      {/* Icon */}
      <div className="w-10 h-10 rounded-lg bg-slate-100 dark:bg-slate-700 flex items-center justify-center shrink-0">
        <Coins className="w-5 h-5 text-amber-500" />
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-slate-900 dark:text-white">Sats</p>
        <p className="text-xs font-mono text-slate-400 dark:text-slate-500 truncate">
          {mintHostname}
        </p>
      </div>

      {/* Amount: muted while provisional, then a short fade to the normal style. */}
      <div className="text-right shrink-0">
        <div
          data-testid="fund-amount"
          aria-busy={provisional ? true : undefined}
          className={`text-sm font-mono font-medium transition-colors duration-300 motion-reduce:transition-none ${
            provisional ? "text-slate-400 dark:text-slate-500" : "text-slate-900 dark:text-white"
          }`}
        >
          <InlineAmount amountSubunits={fund.amount} baseAsset="sat" />
        </div>
      </div>
    </li>
  );
}
