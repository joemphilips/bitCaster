import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGenerateNip98Header } = vi.hoisted(() => ({
  mockGenerateNip98Header: vi.fn(),
}))

vi.mock('../markets', () => ({
  generateNip98Header: mockGenerateNip98Header,
}))

import {
  buildOrderStatusNotifications,
  fetchOrderStatus,
  promoteNewFillsToActiveSwaps,
  splitMarketId,
  type OrderStatusResponse,
} from '../orderStatus'
import { useActiveSwapsStore } from '@/stores/activeSwaps'

describe('fetchOrderStatus', () => {
  beforeEach(() => {
    mockGenerateNip98Header.mockReset()
    mockGenerateNip98Header.mockResolvedValue('Nostr token')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('signs the private order-status poll with NIP-98', async () => {
    const body = orderStatusWithTradeFills('trade-a')
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchOrderStatus('deadbeef-YES', body.orderId)
    const url = `${window.location.origin}/api/v1/deadbeef-YES/orders/${body.orderId}`

    expect(result).toEqual(body)
    expect(mockGenerateNip98Header).toHaveBeenCalledWith(url, 'GET')
    expect(fetchMock).toHaveBeenCalledWith(url, {
      headers: { Authorization: 'Nostr token' },
    })
  })
})

describe('splitMarketId', () => {
  it('splits on the last hyphen so condition ids with hyphens survive', () => {
    expect(splitMarketId('deadbeef-Alice')).toEqual({
      conditionId: 'deadbeef',
      outcomeName: 'Alice',
    })
    expect(splitMarketId('cond-123-Alice')).toEqual({
      conditionId: 'cond-123',
      outcomeName: 'Alice',
    })
  })

  it('returns null for inputs without a usable separator', () => {
    expect(splitMarketId('no-separator-at-start'.replace(/-/g, ''))).toBeNull()
    expect(splitMarketId('-leadingDash')).toBeNull()
    expect(splitMarketId('trailingDash-')).toBeNull()
    expect(splitMarketId('')).toBeNull()
  })
})

describe('promoteNewFillsToActiveSwaps', () => {
  beforeEach(() => {
    useActiveSwapsStore.setState({ byTradeId: {} })
  })

  it('skips an unchanged fill snapshot', () => {
    const status = orderStatusWithTradeFills('trade-a', 'trade-b')
    const promoted = promoteNewFillsToActiveSwaps(status, pendingTrade(), 2)

    expect(promoted).toBe(0)
    expect(useActiveSwapsStore.getState().byTradeId).toEqual({})
  })

  it('promotes only fills that appeared after the last observed count', () => {
    const status = orderStatusWithTradeFills('trade-a', 'trade-b', 'trade-c')
    const promoted = promoteNewFillsToActiveSwaps(status, pendingTrade(), 1)

    expect(promoted).toBe(2)
    expect(Object.keys(useActiveSwapsStore.getState().byTradeId)).toEqual([
      'trade-b',
      'trade-c',
    ])
  })
})

describe('buildOrderStatusNotifications', () => {
  it('notifies on a mint match-shaped settlement handle', () => {
    const status = {
      ...orderStatusWithTradeFills('trade-a'),
      status: 'matched',
      remainingAmountSats: 100,
      filledAmountSats: 100,
    } as OrderStatusResponse

    const notifications = buildOrderStatusNotifications(
      status,
      pendingTrade(),
      0,
      123,
    )

    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({
      id: 'order-1-matched-1',
      kind: 'matched',
      filledAmountSats: 100,
      remainingAmountSats: 100,
      occurredAt: 123,
    })
  })

  it('does not notify again for the same fill snapshot', () => {
    const status = {
      ...orderStatusWithTradeFills('trade-a'),
      filledAmountSats: 100,
    } as OrderStatusResponse

    const notifications = buildOrderStatusNotifications(
      status,
      pendingTrade(),
      1,
      123,
    )

    expect(notifications).toEqual([])
  })

  it('notifies when an order is cancelled by market close', () => {
    const status = {
      ...orderStatusWithTradeFills(),
      status: 'cancelled',
      remainingAmountSats: 100,
      filledAmountSats: 0,
    } as OrderStatusResponse

    const notifications = buildOrderStatusNotifications(
      status,
      pendingTrade(),
      0,
      123,
    )

    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({
      id: 'order-1-cancelled',
      kind: 'cancelled',
      remainingAmountSats: 100,
      occurredAt: 123,
    })
  })

  it('notifies when an order settlement fails terminally', () => {
    const status = {
      ...orderStatusWithTradeFills('trade-a'),
      status: 'failed',
      remainingAmountSats: 0,
      filledAmountSats: 0,
    } as OrderStatusResponse

    const notifications = buildOrderStatusNotifications(
      status,
      pendingTrade(),
      1,
      123,
    )

    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({
      id: 'order-1-failed',
      kind: 'failed',
      filledAmountSats: 0,
      remainingAmountSats: 0,
      occurredAt: 123,
    })
  })

  it('carries the trade baseAsset onto the notification unit', () => {
    const status = {
      ...orderStatusWithTradeFills('trade-a'),
      status: 'filled',
      filledAmountSats: 50,
      remainingAmountSats: 0,
    } as OrderStatusResponse

    const notifications = buildOrderStatusNotifications(
      status,
      { ...pendingTrade(), baseAsset: 'usd' },
      0,
      123,
    )

    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({
      kind: 'filled',
      unit: 'usd',
    })
  })

  it('defaults unit to sat when trade baseAsset is absent', () => {
    const status = {
      ...orderStatusWithTradeFills('trade-a'),
      status: 'filled',
      filledAmountSats: 1000,
      remainingAmountSats: 0,
    } as OrderStatusResponse

    const notifications = buildOrderStatusNotifications(
      status,
      pendingTrade(),
      0,
      123,
    )

    expect(notifications[0]).toMatchObject({ unit: 'sat' })
  })
})

function pendingTrade() {
  return {
    orderId: 'order-1',
    marketId: 'market-1',
    ephemeralPubkey: '02'.padEnd(66, '0'),
    ephemeralPrivkey: '01'.padEnd(64, '0'),
  }
}

function orderStatusWithTradeFills(
  ...tradeIds: string[]
): OrderStatusResponse {
  return {
    orderId: 'order-1',
    marketId: 'market-1',
    status: 'partially_filled',
    remainingAmountSats: 100,
    filledAmountSats: tradeIds.length * 10,
    fills: tradeIds.map((tradeId) => ({ tradeId })),
  } as unknown as OrderStatusResponse
}
