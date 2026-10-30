import type { Comment } from "@/types/market-detail";

/** Format the linked fill's exact share ratio, without rounding unsafe decimal totals. */
export function exactCommentShares(
  amount: number,
  denominator: number,
  locale: string,
): string | null {
  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    !Number.isSafeInteger(denominator) ||
    denominator <= 0
  )
    return null;
  const numerator = BigInt(amount),
    divisor = BigInt(denominator);
  let rest = divisor,
    twos = 0,
    fives = 0;
  while (rest % 2n === 0n) {
    rest /= 2n;
    twos++;
  }
  while (rest % 5n === 0n) {
    rest /= 5n;
    fives++;
  }
  if (rest !== 1n) return `${numerator}/${divisor}`;
  const places = Math.max(twos, fives);
  const scale = 10n ** BigInt(places);
  const exact = (numerator * scale) / divisor;
  const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(exact / scale);
  const fraction = (exact % scale).toString().padStart(places, "0").replace(/0+$/, "");
  const separator =
    new Intl.NumberFormat(locale).formatToParts(1.1).find((part) => part.type === "decimal")
      ?.value ?? ".";
  return fraction ? `${whole}${separator}${fraction}` : whole;
}

export function commentTradePresentation(
  comment: Comment,
  labels: readonly { id: string; label: string }[],
  categorical: boolean,
  locale: string,
) {
  const trade = comment.trade,
    author = trade?.authorTrade;
  if (!trade || !author || !Number.isFinite(Date.parse(trade.executedAt))) return null;
  if (
    (author.side !== "Buy" && author.side !== "Sell") ||
    (author.tokenSide !== "Outcome" && author.tokenSide !== "Complement")
  )
    return null;
  const shares = exactCommentShares(trade.faceAmountSubunits ?? 0, trade.priceDenominator, locale);
  if (shares === null) return null;
  let outcome: string;
  let complement = author.tokenSide === "Complement";
  if (categorical) {
    const found = labels.find((item) => item.id === author.outcomeId);
    if (!found) return null;
    outcome = found.label;
  } else {
    const primitive = author.outcomeId.toLowerCase();
    if (primitive !== "yes" && primitive !== "no") return null;
    outcome = (primitive === "yes") !== complement ? "YES" : "NO";
    complement = false;
  }
  return { side: author.side, shares, outcome, complement, executedAt: trade.executedAt };
}
