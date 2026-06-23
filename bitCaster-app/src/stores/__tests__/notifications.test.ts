import { beforeEach, describe, expect, it } from 'vitest'
import {
  type Notification,
  selectUnreadCount,
  useNotificationsStore,
} from '../notifications'

function makeNotification(
  id: string,
  overrides: Partial<Notification> = {},
): Notification {
  return {
    id,
    kind: 'filled',
    orderId: 'order-1',
    marketId: 'cond-Alice',
    filledAmountSubunits: 100,
    remainingAmountSubunits: 0,
    occurredAt: 1_700_000_000_000,
    read: false,
    ...overrides,
  }
}

beforeEach(() => {
  useNotificationsStore.setState({ items: [] })
})

describe('useNotificationsStore', () => {
  it('prepends new notifications so latest comes first', () => {
    useNotificationsStore.getState().add(makeNotification('a', { occurredAt: 1 }))
    useNotificationsStore.getState().add(makeNotification('b', { occurredAt: 2 }))

    const items = useNotificationsStore.getState().items
    expect(items.map((i) => i.id)).toEqual(['b', 'a'])
  })

  it('dedups by id — re-adding the same notification is a no-op', () => {
    useNotificationsStore.getState().add(makeNotification('a'))
    useNotificationsStore.getState().add(makeNotification('a'))

    expect(useNotificationsStore.getState().items).toHaveLength(1)
  })

  it('caps the list at 100 entries, dropping the oldest', () => {
    for (let i = 0; i < 105; i++) {
      useNotificationsStore.getState().add(makeNotification(`n-${i}`))
    }
    const items = useNotificationsStore.getState().items
    expect(items).toHaveLength(100)
    // Newest at front, oldest that survived is n-5 (0..4 were evicted).
    expect(items[0].id).toBe('n-104')
    expect(items[items.length - 1].id).toBe('n-5')
  })

  it('selectUnreadCount returns only unread', () => {
    useNotificationsStore.getState().add(makeNotification('a'))
    useNotificationsStore.getState().add(makeNotification('b', { read: true }))
    useNotificationsStore.getState().add(makeNotification('c'))

    expect(selectUnreadCount(useNotificationsStore.getState())).toBe(2)
  })

  it('markAllRead flips every unread entry and is a no-op when already read', () => {
    useNotificationsStore.getState().add(makeNotification('a'))
    useNotificationsStore.getState().add(makeNotification('b'))

    const before = useNotificationsStore.getState().items
    useNotificationsStore.getState().markAllRead()
    const after = useNotificationsStore.getState().items

    expect(after.every((n) => n.read)).toBe(true)
    // Reference equality shouldn't change when nothing needed updating.
    useNotificationsStore.getState().markAllRead()
    expect(useNotificationsStore.getState().items).toBe(after)
    // Sanity: before/after are distinct references.
    expect(before).not.toBe(after)
  })

  it('clear empties the list', () => {
    useNotificationsStore.getState().add(makeNotification('a'))
    useNotificationsStore.getState().clear()
    expect(useNotificationsStore.getState().items).toEqual([])
  })
})
