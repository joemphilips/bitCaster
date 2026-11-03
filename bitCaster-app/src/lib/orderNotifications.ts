import type { Notification } from "@/stores/notifications";
import type { components } from "@/generated/api";
import type { ProductMarketDivisibility } from "@/types/market";
import { orderTransitionNotificationId } from "@/lib/orderStatus";

interface OrderSubmitNotificationInput {
  add: (notification: Notification) => void;
  orderId: string;
  marketId: string;
  marketTitle: string;
  divisibility: ProductMarketDivisibility;
  requestedAmountSubunits: number;
  remainingAmountSubunits: number;
  fillCount: number;
  status?: components["schemas"]["OrderLifecycleStatus"];
  now?: number;
}

export function addOrderSubmitNotifications({
  add,
  orderId,
  marketId,
  marketTitle,
  divisibility,
  requestedAmountSubunits,
  remainingAmountSubunits,
  fillCount,
  status,
  now = Date.now(),
}: OrderSubmitNotificationInput): void {
  const filledAmountSubunits = Math.max(requestedAmountSubunits - remainingAmountSubunits, 0);
  const order = {
    orderId,
    marketId,
    marketTitle,
    filledAmountSubunits,
    remainingAmountSubunits,
    unit: "sat",
    divisibility,
    occurredAt: now,
    read: false,
  } as const;
  add({ ...order, id: `${orderId}-accepted`, kind: "accepted" });

  if (fillCount <= 0 || filledAmountSubunits <= 0) return;

  const fullyFilled = remainingAmountSubunits <= 0;
  if (status === "matched") {
    add({
      ...order,
      id: orderTransitionNotificationId(orderId, "matched", remainingAmountSubunits),
      kind: "Matched",
    });
    return;
  }

  add({
    ...order,
    id: orderTransitionNotificationId(
      orderId,
      fullyFilled ? "filled" : "partially_filled",
      remainingAmountSubunits,
    ),
    kind: fullyFilled ? "Filled" : "partially_filled",
  });
}
