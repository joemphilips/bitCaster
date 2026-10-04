import { useTranslation } from "react-i18next";
import type { OrderBook } from "@/types/market-detail";
import type { Outcome, ProductMarketDivisibility } from "@/types/market";
import { OutcomeLabel } from "@/components/shared/OutcomeLabel";
import { formatPricePercent, normalizeMarketDivisibility } from "@bitcaster/client-sdk/marketUnits";
import { buildOrderBookDepthRows, computeExecutableBookSpread } from "./orderBookViewModel";

interface OrderBookSectionProps {
  orderBook: OrderBook;
  selectedOutcomeId?: string;
  outcomeOrderBooks?: Record<string, OrderBook>;
  onOutcomeChange?: (outcomeId: string) => void;
  outcomes?: Array<{ id: string; label: string }>;
  outcome?: Pick<Outcome, "label" | "color">;
  baseAsset: "sat";
  divisibility: ProductMarketDivisibility;
  title?: string;
  outcomeId?: string;
}

export function OrderBookSection({
  orderBook,
  selectedOutcomeId,
  outcomeOrderBooks,
  onOutcomeChange,
  outcomes,
  outcome,
  baseAsset,
  divisibility: divisibilityInput,
  title,
  outcomeId,
}: OrderBookSectionProps) {
  const { t } = useTranslation();
  const divisibility = normalizeMarketDivisibility(divisibilityInput, baseAsset);

  const activeOrderBook =
    selectedOutcomeId && outcomeOrderBooks
      ? (outcomeOrderBooks[selectedOutcomeId] ?? { bids: [], asks: [], spread: 0 })
      : orderBook;
  const hasSelectedOutcomeBook =
    selectedOutcomeId === undefined || outcomeOrderBooks?.[selectedOutcomeId] !== undefined;
  const spread = hasSelectedOutcomeBook
    ? computeExecutableBookSpread(activeOrderBook, divisibility)
    : null;
  const depthLimit = 10;
  const visibleBids = [...activeOrderBook.bids]
    .sort((a, b) => b.price - a.price)
    .slice(0, depthLimit);
  const visibleAsks = [...activeOrderBook.asks]
    .sort((a, b) => a.price - b.price)
    .slice(0, depthLimit)
    .reverse();
  const bidRows = buildOrderBookDepthRows(visibleBids, "bid", visibleAsks);
  const askRows = buildOrderBookDepthRows(visibleAsks, "ask", visibleBids);

  return (
    <div
      data-testid="order-book-panel"
      data-outcome-id={outcomeId}
      className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5"
    >
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
          {outcome ? (
            <OutcomeLabel
              outcome={outcome}
              className="text-lg font-semibold"
              labelClassName="text-slate-900 dark:text-white"
            />
          ) : (
            (title ?? t("orderBook.title"))
          )}
        </h3>

        {/* Outcome Selector for Categorical Markets */}
        {outcomes && outcomes.length > 0 && (
          <select
            value={selectedOutcomeId || outcomes[0]?.id}
            onChange={(e) => onOutcomeChange?.(e.target.value)}
            className="text-sm bg-slate-100 dark:bg-slate-700 border-0 rounded-lg px-3 py-1.5 text-slate-700 dark:text-slate-300 focus:ring-2 focus:ring-blue-500"
          >
            {outcomes.map((outcome) => (
              <option key={outcome.id} value={outcome.id}>
                {outcome.label}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="rounded-xl border border-slate-100 dark:border-slate-700/70 bg-slate-50/70 dark:bg-slate-900/40 p-2">
        <div className="grid grid-cols-3 gap-2 px-3 pb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
          <span>{t("orderBook.price")}</span>
          <span className="text-right">{t("orderBook.amount")}</span>
          <span className="text-right">{t("orderBook.totalShares")}</span>
        </div>

        <div className="h-[400px] grid grid-rows-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-1">
          <div
            className="min-h-0 overflow-y-auto flex flex-col-reverse"
            tabIndex={0}
            role="region"
            aria-label={t("orderBook.asks")}
          >
            <div>
              <div className="flex items-center gap-1 px-3 pt-1">
                <div className="w-2 h-2 rounded-full bg-red-500" />
                <span className="text-[10px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  {t("orderBook.asks")}
                </span>
              </div>
              {activeOrderBook.asks.length === 0 && (
                <p className="text-xs text-slate-400 dark:text-slate-500 px-3 py-2">
                  {t("orderBook.noAsks")}
                </p>
              )}
              {askRows.map((row, i) => (
                <div
                  key={`ask-row-${i}`}
                  data-testid="order-book-ask-row"
                  data-outcome-id={outcomeId}
                  data-depth-percent={row.depthPercent}
                  data-depth-side={row.side}
                  className="relative overflow-hidden rounded px-3 py-0.5 text-xs"
                >
                  <div
                    data-testid="order-book-ask-depth-fill"
                    aria-hidden="true"
                    className="absolute inset-y-0 left-0 bg-red-500/10 dark:bg-red-500/20 transition-all"
                    style={{ width: `${row.depthPercent}%` }}
                  />
                  <div className="relative grid grid-cols-3 items-center gap-2">
                    <span className="font-mono font-medium text-red-600 dark:text-red-400">
                      {formatPricePercent(row.order.price, divisibility)}
                    </span>
                    <span className="text-right text-slate-600 dark:text-slate-300 font-mono">
                      {formatOrderBookShares(row.order.amount, divisibility)}
                    </span>
                    <span
                      className="text-right text-slate-500 dark:text-slate-400 font-mono"
                      data-testid="order-book-total-shares"
                    >
                      {(row.order.total / divisibility).toLocaleString(undefined, {
                        maximumFractionDigits: 4,
                      })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div
            data-testid="order-book-spread-row"
            className="flex items-center justify-center gap-2 rounded bg-white/80 dark:bg-slate-800/70 px-3 py-1"
          >
            <span className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
              {t("orderBook.spread")}
            </span>
            <span className="text-xs font-mono font-medium text-slate-700 dark:text-slate-300">
              {spread === null
                ? t("orderBook.spreadUnavailable")
                : t("orderBook.spreadPercentage", {
                    value: ((spread / divisibility) * 100).toLocaleString(undefined, {
                      maximumFractionDigits: 3,
                    }),
                  })}
            </span>
          </div>

          <div
            className="min-h-0 overflow-y-auto"
            tabIndex={0}
            role="region"
            aria-label={t("orderBook.bids")}
          >
            <div className="flex items-center gap-1 px-3 pt-1">
              <div className="w-2 h-2 rounded-full bg-emerald-500" />
              <span className="text-[10px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                {t("orderBook.bids")}
              </span>
            </div>
            {activeOrderBook.bids.length === 0 && (
              <p className="text-xs text-slate-400 dark:text-slate-500 px-3 py-2">
                {t("orderBook.noBids")}
              </p>
            )}
            {bidRows.map((row, i) => (
              <div
                key={`bid-row-${i}`}
                data-testid="order-book-bid-row"
                data-outcome-id={outcomeId}
                data-depth-percent={row.depthPercent}
                data-depth-side={row.side}
                className="relative overflow-hidden rounded px-3 py-0.5 text-xs"
              >
                <div
                  data-testid="order-book-bid-depth-fill"
                  aria-hidden="true"
                  className="absolute inset-y-0 left-0 bg-emerald-500/10 dark:bg-emerald-500/20 transition-all"
                  style={{ width: `${row.depthPercent}%` }}
                />
                <div className="relative grid grid-cols-3 items-center gap-2">
                  <span className="font-mono font-medium text-emerald-600 dark:text-emerald-400">
                    {formatPricePercent(row.order.price, divisibility)}
                  </span>
                  <span className="text-right text-slate-600 dark:text-slate-300 font-mono">
                    {formatOrderBookShares(row.order.amount, divisibility)}
                  </span>
                  <span
                    className="text-right text-slate-500 dark:text-slate-400 font-mono"
                    data-testid="order-book-total-shares"
                  >
                    {(row.order.total / divisibility).toLocaleString(undefined, {
                      maximumFractionDigits: 4,
                    })}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatOrderBookShares(amountSubunits: number, divisibility: number): string {
  const denominator = Number.isFinite(divisibility) && divisibility > 0 ? divisibility : 1;
  const shares = Number.isFinite(amountSubunits) ? amountSubunits / denominator : 0;
  const formatted = shares.toLocaleString(undefined, {
    maximumFractionDigits: 4,
  });
  return `${formatted} ${shares === 1 ? "share" : "shares"}`;
}
