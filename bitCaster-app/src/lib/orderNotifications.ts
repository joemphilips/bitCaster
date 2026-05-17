import type { Notification } from '@/stores/notifications'

interface OrderSubmitNotificationInput {
  add: (notification: Notification) => void
  orderId: string
  marketId: string
  requestedAmountSats: number
  remainingAmountSats: number
  fillCount: number
  now?: number
}

export function addOrderSubmitNotifications({
  add,
  orderId,
  marketId,
  requestedAmountSats,
  remainingAmountSats,
  fillCount,
  now = Date.now(),
}: OrderSubmitNotificationInput): void {
  const filledAmountSats = Math.max(requestedAmountSats - remainingAmountSats, 0)
  add({
    id: `${orderId}-accepted`,
    kind: 'accepted',
    orderId,
    marketId,
    filledAmountSats,
    remainingAmountSats,
    occurredAt: now,
    read: false,
  })

  if (fillCount <= 0 || filledAmountSats <= 0) return

  const fullyFilled = remainingAmountSats <= 0
  add({
    id: fullyFilled ? `${orderId}-filled` : `${orderId}-partially_filled-${fillCount}`,
    kind: fullyFilled ? 'filled' : 'partially_filled',
    orderId,
    marketId,
    filledAmountSats,
    remainingAmountSats,
    occurredAt: now,
    read: false,
  })
}
