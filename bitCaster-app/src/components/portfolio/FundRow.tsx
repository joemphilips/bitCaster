import type { Fund } from "@/types/portfolio";
import { Coins } from "lucide-react";
import { InlineAmount } from "@/components/shared/InlineAmount";

interface FundRowProps {
  fund: Fund;
}

export function FundRow({ fund }: FundRowProps) {
  const mintHostname = new URL(fund.mintUrl).hostname;

  return (
    <li className="flex items-center gap-3 rounded-lg p-3">
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

      {/* Amount */}
      <div className="text-right shrink-0">
        <div className="text-sm font-mono font-medium text-slate-900 dark:text-white">
          <InlineAmount amountSubunits={fund.amount} baseAsset="sat" />
        </div>
      </div>
    </li>
  );
}
