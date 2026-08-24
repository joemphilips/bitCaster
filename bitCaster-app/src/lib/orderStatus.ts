import type { Notification, NotificationKind } from "@/stores/notifications";
import type { OrderLifecycleStatus } from "@bitcaster/client-sdk/engineClient";
import type { components } from "@/generated/api";
import { generateNip98Header } from "@/lib/markets";
import { resolveApiSigningUrl } from "@/lib/hubUrl";
import { BitcasterEngineClient } from "@bitcaster/client-sdk/engineClient";
import { normalizeMarketBaseAsset } from "@bitcaster/client-sdk/marketUnits";
import type { ProductMarketDivisibility } from "@/types/market";

export type OrderStatusResponse = components["schemas"]["OrderStatusResponse"];
export type OrderStatus = components["schemas"]["OrderLifecycleStatus"];

function notificationKindForTerminalStatus(status: OrderLifecycleStatus): NotificationKind {
  switch (status) {
    case "filled":
      return "Filled";
    case "failed":
      return "Failed";
    case "cancelled":
      return "cancelled";
    case "expired":
      return "expired";
    case "evicted_capacity":
      return "evicted_capacity";
    case "rejected_capacity":
      return "rejected_capacity";
    case "resting":
    case "matched":
    case "partially_filled":
      throw new Error(`OrderStatus is not terminal: ${status}`);
    default:
      return assertNever(status);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled order lifecycle status: ${value}`);
}

type PendingTradeForPromotion = {
  orderId: string;
  clientOrderId?: string;
  marketId: string;
  baseAsset: "sat";
  divisibility: ProductMarketDivisibility;
  side?: "Buy" | "Sell";
  tokenSide?: "Outcome" | "Complement";
  priceSubunits?: number | null;
  amountSubunits?: number | null;
};

type OrderNotificationState = {
  status: OrderLifecycleStatus;
  filledAmountSubunits: number;
  remainingAmountSubunits: number;
};

export function buildOrderLifecycleNotifications(
  status: OrderLifecycleStatus,
  remainingAmountSubunits: number,
  trade: PendingTradeForPromotion,
  now = Date.now(),
): Notification[] {
  return buildOrderNotifications(
    {
      status,
      remainingAmountSubunits,
      filledAmountSubunits: Math.max(
        0,
        (trade.amountSubunits ?? remainingAmountSubunits) - remainingAmountSubunits,
      ),
    },
    trade,
    now,
  );
}

export async function fetchOrderStatus(
  marketId: string,
  orderId: string,
): Promise<OrderStatusResponse | null> {
  return (await new BitcasterEngineClient({
    baseUrl: window.location.origin,
    authorization: ({ url, method }) => generateNip98Header(resolveApiSigningUrl(url), method),
  }).getOrderStatus(marketId, orderId)) as OrderStatusResponse | null;
}

export function buildOrderStatusNotifications(
  status: OrderStatusResponse,
  trade: PendingTradeForPromotion,
  now = Date.now(),
): Notification[] {
  return buildOrderNotifications(status, trade, now);
}

function buildOrderNotifications(
  state: OrderNotificationState,
  trade: PendingTradeForPromotion,
  now: number,
): Notification[] {
  const unit = normalizeMarketBaseAsset(trade.baseAsset);
  const current = state.status;
  switch (current) {
    case "matched":
    case "partially_filled":
      return [
        {
          id: `${trade.orderId}-${current}-${state.remainingAmountSubunits}`,
          kind: current === "matched" ? "Matched" : "partially_filled",
          orderId: trade.orderId,
          marketId: trade.marketId,
          filledAmountSubunits: state.filledAmountSubunits,
          remainingAmountSubunits: state.remainingAmountSubunits,
          unit,
          occurredAt: now,
          read: false,
        },
      ];
    case "filled":
    case "failed":
    case "cancelled":
    case "expired":
    case "evicted_capacity":
    case "rejected_capacity":
      return [
        {
          id: `${trade.orderId}-${current}`,
          kind: notificationKindForTerminalStatus(current),
          orderId: trade.orderId,
          marketId: trade.marketId,
          filledAmountSubunits: state.filledAmountSubunits,
          remainingAmountSubunits: state.remainingAmountSubunits,
          unit,
          occurredAt: now,
          read: false,
        },
      ];
    case "resting":
      return [];
    default:
      return assertNever(current);
  }
}

/**
 * Split a marketId of the form `{conditionId}-{outcomeName}` back into its
 * parts. Public market ids use primitive outcome names, while condition ids
 * may come from external systems with their own separator conventions.
 * Returns `null` for malformed IDs so callers can fall back to the raw string.
 */
export function splitMarketId(
  marketId: string,
): { conditionId: string; outcomeName: string } | null {
  const idx = marketId.lastIndexOf("-");
  if (idx <= 0 || idx >= marketId.length - 1) return null;
  return {
    conditionId: marketId.slice(0, idx),
    outcomeName: marketId.slice(idx + 1),
  };
}
