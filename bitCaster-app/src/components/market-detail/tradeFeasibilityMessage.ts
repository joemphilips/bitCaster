import { assertNever } from "@/lib/enumDiscipline";
import type { TradeFeasibilityReason } from "@/types/market-detail";

/** Returns the translation key that explains why the wallet cannot back a trade. */
export function tradeFeasibilityMessageKey(reason: TradeFeasibilityReason): string {
  switch (reason) {
    case "funds":
      return "trade.insufficientFunds";
    case "outcome-tokens":
      return "trade.insufficientOutcomeTokens";
    case "preparation-fee-cash":
      return "trade.insufficientPreparationFeeCash";
    case "mint-limits":
      return "trade.orderExceedsMintLimits";
    case "unavailable":
      return "trade.feePreviewUnavailable";
    default:
      return assertNever(reason);
  }
}
