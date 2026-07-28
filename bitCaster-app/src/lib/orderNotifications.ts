import type { Notification } from "@/stores/notifications";

interface OrderSubmitNotificationInput {
  add: (notification: Notification) => void;
  orderId: string;
  marketId: string;
  requestedAmountSubunits: number;
  remainingAmountSubunits: number;
  fillCount: number;
  status?: string;
  now?: number;
}

export function addOrderSubmitNotifications({
  add,
  orderId,
  marketId,
  requestedAmountSubunits,
  remainingAmountSubunits,
  fillCount,
  status,
  now = Date.now(),
}: OrderSubmitNotificationInput): void {
  const filledAmountSubunits = Math.max(requestedAmountSubunits - remainingAmountSubunits, 0);
  add({
    id: `${orderId}-accepted`,
    kind: "accepted",
    orderId,
    marketId,
    filledAmountSubunits,
    remainingAmountSubunits,
    unit: "sat",
    occurredAt: now,
    read: false,
  });

  if (fillCount <= 0 || filledAmountSubunits <= 0) return;

  const fullyFilled = remainingAmountSubunits <= 0;
  if (status === "Matched") {
    add({
      id: `${orderId}-matched-${fillCount}`,
      kind: "Matched",
      orderId,
      marketId,
      filledAmountSubunits,
      remainingAmountSubunits,
      unit: "sat",
      occurredAt: now,
      read: false,
    });
    return;
  }

  add({
    id: fullyFilled ? `${orderId}-filled` : `${orderId}-partially_filled-${fillCount}`,
    kind: fullyFilled ? "Filled" : "partially_filled",
    orderId,
    marketId,
    filledAmountSubunits,
    remainingAmountSubunits,
    unit: "sat",
    occurredAt: now,
    read: false,
  });
}
