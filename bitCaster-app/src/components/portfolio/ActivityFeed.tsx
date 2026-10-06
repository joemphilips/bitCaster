import { useTranslation } from "react-i18next";
import type { ActivityItem, ActivityType } from "@/types/portfolio";
import { normalizeMarketBaseAsset } from "@bitcaster/client-sdk/marketUnits";
import { InlineAmount } from "@/components/shared/InlineAmount";
import { ArrowDownLeft, ArrowUpRight, ShoppingCart, Tag, Trophy, Coins } from "lucide-react";
import { assertNever } from "@/lib/enumDiscipline";

const TYPE_META: Record<
  ActivityType,
  { icon: typeof ArrowDownLeft; labelKey: string; colorClass: string }
> = {
  deposit: {
    icon: ArrowDownLeft,
    labelKey: "activityType.deposit",
    colorClass: "text-emerald-500 bg-emerald-100 dark:bg-emerald-900/30",
  },
  withdrawal: {
    icon: ArrowUpRight,
    labelKey: "activityType.withdrawal",
    colorClass: "text-rose-500 bg-rose-100 dark:bg-rose-900/30",
  },
  Buy: {
    icon: ShoppingCart,
    labelKey: "activityType.buy",
    colorClass: "text-blue-500 bg-blue-100 dark:bg-blue-900/30",
  },
  Sell: {
    icon: Tag,
    labelKey: "activityType.sell",
    colorClass: "text-amber-500 bg-amber-100 dark:bg-amber-900/30",
  },
  payout_claimed: {
    icon: Trophy,
    labelKey: "activityType.payout_claimed",
    colorClass: "text-emerald-500 bg-emerald-100 dark:bg-emerald-900/30",
  },
  creator_fee_claimed: {
    icon: Coins,
    labelKey: "activityType.creator_fee_claimed",
    colorClass: "text-amber-500 bg-amber-100 dark:bg-amber-900/30",
  },
};

const STATUS_BADGES: Record<string, string> = {
  completed: "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400",
  pending: "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400",
  failed: "bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-400",
};

interface ActivityFeedProps {
  activity: ActivityItem[];
}

/** Display only. Never replace or merge the durable fill records. */
function groupRecordedFills(activity: ActivityItem[]): ActivityItem[][] {
  const groups = new Map<string, ActivityItem[]>();
  const membership = new Map<ActivityItem, string>();
  for (const item of activity) {
    const orderId = item.tradeDetails?.orderId;
    if (
      item.status !== "completed" ||
      (item.type !== "Buy" && item.type !== "Sell") ||
      !item.walletId ||
      !/^[0-9a-f]{64}$/.test(item.walletId) ||
      !item.marketId ||
      !orderId ||
      orderId.trim() !== orderId
    )
      continue;
    const key = JSON.stringify([item.walletId, orderId]);
    membership.set(item, key);
    const members = groups.get(key);
    if (members) members.push(item);
    else groups.set(key, [item]);
  }
  const emitted = new Set<string>();
  return activity.flatMap((item) => {
    const key = membership.get(item);
    if (key && emitted.has(key)) return [];
    const members = key ? groups.get(key)! : [item];
    const first = members[0];
    const compatible =
      members.every(
        (member) =>
          member.type === first.type &&
          member.marketId === first.marketId &&
          member.baseAsset === first.baseAsset &&
          member.tradeDetails?.outcomeId === first.tradeDetails?.outcomeId &&
          member.tradeDetails?.tokenSide === first.tradeDetails?.tokenSide &&
          member.tradeDetails?.divisibility === first.tradeDetails?.divisibility &&
          Number.isSafeInteger(member.amountSubunits) &&
          member.amountSubunits >= 0 &&
          Number.isSafeInteger(member.tradeDetails?.faceAmountSubunits) &&
          (member.tradeDetails?.faceAmountSubunits ?? 0) > 0,
      ) &&
      new Set(members.map((member) => member.tradeDetails?.fillId)).size === members.length &&
      Number.isSafeInteger(members.reduce((sum, member) => sum + member.amountSubunits, 0)) &&
      Number.isSafeInteger(
        members.reduce((sum, member) => sum + (member.tradeDetails?.faceAmountSubunits ?? 0), 0),
      );
    if (!key || !compatible || members.length < 2) return [[item]];
    emitted.add(key);
    return [members];
  });
}

export function ActivityFeed({ activity }: ActivityFeedProps) {
  const { t, i18n } = useTranslation();
  const marketLabel = (item: ActivityItem) => {
    const shortId = item.marketId?.match(/^([0-9a-f]{12})[0-9a-f]{52}(?:-|$)/)?.[1];
    return (
      item.marketTitle?.trim() ||
      (shortId ? t("activityTrade.marketReference", { id: shortId }) : item.marketId)
    );
  };
  if (activity.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-slate-400 dark:text-slate-500">
        {t("portfolio.noActivity")}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {groupRecordedFills(activity).map((members) => {
        const item = members[0];
        if (members.length > 1) {
          return (
            <details key={JSON.stringify([item.walletId, item.tradeDetails!.orderId])}>
              <summary className="p-3 rounded-lg cursor-pointer text-sm text-slate-900 dark:text-white">
                {t(TYPE_META[item.type].labelKey)} · {marketLabel(item)} ·{" "}
                {t("activityTrade.recordedFills", { count: members.length })}
                <div className="font-mono">
                  {activityAmountPrefix(item.type)}
                  <InlineAmount
                    amountSubunits={members.reduce((sum, member) => sum + member.amountSubunits, 0)}
                    baseAsset={normalizeMarketBaseAsset(item.baseAsset)}
                  />
                </div>
                <p className="text-xs text-slate-500">{t("activityTrade.tradeValueBeforeFees")}</p>
              </summary>
              {members.map((member) => (
                <ActivityFeed
                  key={JSON.stringify([member.walletId, member.id])}
                  activity={[member]}
                />
              ))}
            </details>
          );
        }
        const config = TYPE_META[item.type];
        const Icon = config.icon;
        const label = marketLabel(item);
        const tradeToken = item.tradeDetails
          ? t(tradeTokenLabelKey(item.tradeDetails.tokenSide), {
              outcomeId: item.tradeDetails.outcomeId,
            })
          : null;
        const tradeShares = item.tradeDetails
          ? new Intl.NumberFormat(i18n.language, {
              maximumFractionDigits: shareFractionDigits(item.tradeDetails.divisibility),
            }).format(item.tradeDetails.faceAmountSubunits / item.tradeDetails.divisibility)
          : null;
        const date = new Date(item.date).toLocaleDateString(i18n.language, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });

        return (
          <article
            key={JSON.stringify([item.walletId ?? null, item.id])}
            className="w-full grid grid-cols-[2rem_minmax(0,1fr)] items-start gap-x-3 gap-y-2 p-3 rounded-lg text-left sm:flex sm:items-center sm:gap-3"
          >
            {/* Type Icon */}
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${config.colorClass}`}
            >
              <Icon className="w-4 h-4" />
            </div>

            {/* Description */}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-slate-900 dark:text-white">
                {t(item.claimRecovery ? "activityClaimRecovery.label" : config.labelKey)}
              </p>
              {item.claimRecovery && (
                <p className="text-xs text-slate-500 dark:text-slate-400 break-words">
                  {t("activityClaimRecovery.originalFailed", {
                    code: item.claimRecovery.originalFailureCode,
                  })}
                </p>
              )}
              {label && (
                <p
                  className="text-xs text-slate-500 dark:text-slate-400 break-words sm:truncate"
                  title={item.marketTitle ? undefined : item.marketId}
                >
                  {label}
                </p>
              )}
              {tradeToken && tradeShares && (
                <p className="text-xs text-slate-500 dark:text-slate-400 break-words">
                  {tradeToken} · {t("activityTrade.shares", { amount: tradeShares })}
                </p>
              )}
              {item.txId && (
                <p className="text-xs text-slate-400 dark:text-slate-500 font-mono truncate">
                  TX: {item.txId.slice(0, 8)}...
                </p>
              )}
              {item.lightningInvoice && !item.txId && (
                <p className="text-xs text-slate-400 dark:text-slate-500 font-mono truncate">
                  LN: {item.lightningInvoice.slice(0, 16)}...
                </p>
              )}
              {item.failureReason && (
                <p className="text-xs text-rose-500 truncate">{item.failureReason}</p>
              )}
            </div>

            {/* Amount & Status */}
            <div className="col-start-2 min-w-0 text-left sm:text-right sm:shrink-0">
              <div className="text-sm font-mono font-medium text-slate-900 dark:text-white">
                {activityAmountPrefix(item.type)}
                <InlineAmount
                  amountSubunits={item.amountSubunits}
                  baseAsset={normalizeMarketBaseAsset(item.baseAsset)}
                />
              </div>
              {item.tradeDetails && (
                <p className="text-[10px] text-slate-400 dark:text-slate-500">
                  {t("activityTrade.tradeValueBeforeFees")}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-1 mt-0.5 sm:justify-end">
                <span className="text-xs text-slate-400 dark:text-slate-500">{date}</span>
                <span
                  className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${STATUS_BADGES[item.status] ?? ""}`}
                >
                  {item.status}
                </span>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function tradeTokenLabelKey(
  tokenSide: NonNullable<ActivityItem["tradeDetails"]>["tokenSide"],
): "activityTrade.outcomeToken" | "activityTrade.complementToken" {
  switch (tokenSide) {
    case "Outcome":
      return "activityTrade.outcomeToken";
    case "Complement":
      return "activityTrade.complementToken";
    default:
      return assertNever(tokenSide);
  }
}

function shareFractionDigits(divisibility: 1_000 | 1_000_000): number {
  switch (divisibility) {
    case 1_000:
      return 3;
    case 1_000_000:
      return 6;
    default:
      return assertNever(divisibility);
  }
}

function activityAmountPrefix(type: ActivityType): "+" | "-" {
  switch (type) {
    case "deposit":
    case "Sell":
    case "payout_claimed":
    case "creator_fee_claimed":
      return "+";
    case "withdrawal":
    case "Buy":
      return "-";
    default:
      return assertNever(type);
  }
}
