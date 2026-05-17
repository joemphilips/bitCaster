import { describe, expect, it, vi } from 'vitest'
import type { Notification } from '@/stores/notifications'
import { addOrderSubmitNotifications } from '../orderNotifications'

describe('addOrderSubmitNotifications', () => {
  it('adds accepted plus filled notification for an immediately matched order', () => {
    const add = vi.fn<(notification: Notification) => void>()

    addOrderSubmitNotifications({
      add,
      orderId: 'order-1',
      marketId: 'cond-YES',
      requestedAmountSats: 100,
      remainingAmountSats: 0,
      fillCount: 1,
      now: 123,
    })

    expect(add.mock.calls.map(([notification]) => notification.kind)).toEqual([
      'accepted',
      'filled',
    ])
    expect(add.mock.calls[1][0]).toMatchObject({
      id: 'order-1-filled',
      filledAmountSats: 100,
      remainingAmountSats: 0,
    })
  })

  it('adds accepted plus partial-fill notification when the order keeps resting', () => {
    const add = vi.fn<(notification: Notification) => void>()

    addOrderSubmitNotifications({
      add,
      orderId: 'order-1',
      marketId: 'cond-YES',
      requestedAmountSats: 200,
      remainingAmountSats: 100,
      fillCount: 1,
      now: 123,
    })

    expect(add.mock.calls.map(([notification]) => notification.kind)).toEqual([
      'accepted',
      'partially_filled',
    ])
    expect(add.mock.calls[1][0]).toMatchObject({
      id: 'order-1-partially_filled-1',
      filledAmountSats: 100,
      remainingAmountSats: 100,
    })
  })

  it('does not invent a fill notification for a resting order', () => {
    const add = vi.fn<(notification: Notification) => void>()

    addOrderSubmitNotifications({
      add,
      orderId: 'order-1',
      marketId: 'cond-YES',
      requestedAmountSats: 200,
      remainingAmountSats: 200,
      fillCount: 0,
      now: 123,
    })

    expect(add).toHaveBeenCalledOnce()
    expect(add.mock.calls[0][0].kind).toBe('accepted')
  })
})
