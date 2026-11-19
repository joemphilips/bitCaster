import { formatMarketSubunits } from "@bitcaster/client-sdk/marketUnits";
import { assertNever } from "@/lib/enumDiscipline";
import { formatClockTime } from "@/lib/format";
import type { CtfRangeOrderLock } from "@/lib/ctfRangeOrderFunds";
import {
  orderFailureReasonTextKey,
  type OrderFailureFunds,
  type OrderFailureReason,
} from "@/stores/orderFailureNotices";

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The journal facts that let a pending funds sentence name the amount and the time. */
export interface FundsLockText {
  readonly lock: CtfRangeOrderLock | null;
  /** The active language, for the clock time when the lock ends. */
  readonly locale: string;
}

const NO_LOCK: FundsLockText = { lock: null, locale: "en" };

/**
 * The funds sentence carries the fee clause (ADR-040, section 7). A pending
 * refund names the locked amount and the clock time when the lock ends, when
 * the journal gives them. A journal that ended without a refund gets no funds
 * claim. Nothing shows a settled order as a failure.
 */
export function fundsSentence(
  t: Translate,
  funds: OrderFailureFunds,
  { lock, locale }: FundsLockText = NO_LOCK,
): string | null {
  switch (funds) {
    case "pending":
      return lock === null
        ? t("settlementProgress.fundsPending")
        : lockedFundsSentence(t, lock, locale);
    case "refunded":
      return t("settlementProgress.fundsReturned");
    case "ended":
    case "settled":
      return null;
    default:
      return assertNever(funds);
  }
}

/** A reason and its funds sentence as one paragraph, in the active language. */
export function withFundsSentence(
  t: Translate,
  reason: string,
  funds: OrderFailureFunds,
  lock: FundsLockText = NO_LOCK,
): string {
  const sentence = fundsSentence(t, funds, lock);
  return sentence === null
    ? reason
    : t("settlementProgress.withFunds", { reason, funds: sentence });
}

/** The reason line of a failure notice, or null when the cause is not known. */
export function orderFailureReasonText(t: Translate, reason: OrderFailureReason): string | null {
  const key = orderFailureReasonTextKey(reason);
  return key === null ? null : t(key);
}

const MINUTE_MS = 60_000;

/**
 * Sats for a Buy, shares for a Sell: the asset that the authorization offered.
 * The clock time shows no seconds, so it rounds the lock end up to the next
 * minute. A time that is too early would promise the funds before the refund.
 */
function lockedFundsSentence(t: Translate, lock: CtfRangeOrderLock, locale: string): string {
  const endsAtMs = Math.ceil(lock.unlockAtMs / MINUTE_MS) * MINUTE_MS;
  const time = formatClockTime(endsAtMs, Date.now(), locale);
  switch (lock.side) {
    case "Buy":
      return t("settlementProgress.fundsLockedSats", {
        amount: formatMarketSubunits(lock.lockedSubunits, "sat"),
        time,
      });
    case "Sell": {
      const shares = lock.lockedSubunits / lock.divisibility;
      return t("settlementProgress.fundsLockedShares", {
        count: shares,
        amount: t("trade.shareCount", {
          count: shares,
          formattedCount: shares.toLocaleString(locale, { maximumFractionDigits: 6 }),
        }),
        time,
      });
    }
    default:
      return assertNever(lock.side);
  }
}
