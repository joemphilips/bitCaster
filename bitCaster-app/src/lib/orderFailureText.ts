import { assertNever } from "@/lib/enumDiscipline";
import {
  orderFailureReasonTextKey,
  type OrderFailureFunds,
  type OrderFailureNotice,
} from "@/stores/orderFailureNotices";

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * The funds sentence carries the fee clause (ADR-040, section 7). A journal
 * that ended without a refund gets no funds claim. Nothing shows a settled
 * order as a failure.
 */
function fundsSentenceKey(funds: OrderFailureFunds): string | null {
  switch (funds) {
    case "pending":
      return "settlementProgress.fundsPending";
    case "refunded":
      return "settlementProgress.fundsReturned";
    case "ended":
    case "settled":
      return null;
    default:
      return assertNever(funds);
  }
}

/** A reason and its funds sentence as one paragraph, in the active language. */
export function withFundsSentence(t: Translate, reason: string, funds: OrderFailureFunds): string {
  const key = fundsSentenceKey(funds);
  return key === null ? reason : t("settlementProgress.withFunds", { reason, funds: t(key) });
}

/** The text of one failure notice, as the panel and the bell show it. */
export function orderFailureText(t: Translate, notice: OrderFailureNotice): string {
  return withFundsSentence(t, t(orderFailureReasonTextKey(notice.reason)), notice.funds);
}
