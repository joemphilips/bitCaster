import { renderHook, act, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useActiveSwapsStore } from '@/stores/activeSwaps'
import { usePendingTradesStore } from '@/stores/pendingTrades'

const { mockUseTradeHub, mockJoinOrder, mockJoinTrade, mockSendSwapMessage } =
  vi.hoisted(() => ({
    mockUseTradeHub: vi.fn(),
    mockJoinOrder: vi.fn(),
    mockJoinTrade: vi.fn(),
    mockSendSwapMessage: vi.fn(),
  }))

vi.mock('@/hooks/useTradeHub', () => ({
  useTradeHub: mockUseTradeHub,
}))

vi.mock('@/stores/wallet', () => ({
  useWalletStore: (selector: (state: { activeMintUrl: string }) => unknown) =>
    selector({ activeMintUrl: 'https://mint.example' }),
}))

const { useTradeSettlement } = await import('../useTradeSettlement')

beforeEach(() => {
  vi.clearAllMocks()
  useActiveSwapsStore.setState({ byTradeId: {} })
  usePendingTradesStore.setState({ byOrderId: {} })
  mockJoinOrder.mockResolvedValue(undefined)
  mockJoinTrade.mockResolvedValue(undefined)
  mockSendSwapMessage.mockResolvedValue(undefined)
  mockUseTradeHub.mockReturnValue({
    joinOrder: mockJoinOrder,
    joinTrade: mockJoinTrade,
    sendSwapMessage: mockSendSwapMessage,
    connectionState: vi.fn(),
  })
})

describe('useTradeSettlement', () => {
  it('does not start the private TradeHub when no swap is active', () => {
    renderHook(() => useTradeSettlement(true))

    expect(mockUseTradeHub).toHaveBeenCalledWith(false, expect.any(Object))
    expect(mockJoinOrder).not.toHaveBeenCalled()
    expect(mockJoinTrade).not.toHaveBeenCalled()
  })

  it('connects and joins only after an active swap is promoted', async () => {
    renderHook(() => useTradeSettlement(true))

    await act(async () => {
      useActiveSwapsStore.getState().promote({
        tradeId: 'trade-1',
        orderId: 'order-1',
        marketId: 'market-1',
        ephemeralPrivkeyHex: '11'.repeat(32),
        ephemeralPubkeyHex: '22'.repeat(32),
      })
    })

    expect(mockUseTradeHub).toHaveBeenLastCalledWith(
      true,
      expect.any(Object),
    )
    expect(mockJoinTrade).toHaveBeenCalledWith('trade-1')
  })

  it('joins pending order groups so resting makers can receive TradeCreated', async () => {
    usePendingTradesStore.getState().add({
      orderId: 'order-pending',
      marketId: 'cond-YES',
      ephemeralPrivkey: '11'.repeat(32),
      ephemeralPubkey: '02' + '22'.repeat(32),
      submittedAt: Date.now(),
    })

    renderHook(() => useTradeSettlement(true))

    await waitFor(() =>
      expect(mockJoinOrder).toHaveBeenCalledWith('cond-YES', 'order-pending'),
    )
  })

  it('promotes an unsolicited TradeCreated event for a pending complementary order', async () => {
    usePendingTradesStore.getState().add({
      orderId: 'order-pending',
      marketId: 'cond-YES',
      ephemeralPrivkey: '11'.repeat(32),
      ephemeralPubkey: '02' + '22'.repeat(32),
      submittedAt: Date.now(),
    })

    renderHook(() => useTradeSettlement(true))

    expect(mockUseTradeHub).toHaveBeenLastCalledWith(
      true,
      expect.any(Object),
    )
    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onTradeCreated: (payload: {
        tradeId: string
        sellerPubkey: string
        buyerPubkey: string
        sellerLocktime: string
        buyerLocktime: string
        marketId?: string
        outcomeFaceAmountSats?: number
        quotePaymentSats?: number
      }) => void
    }

    await act(async () => {
      callbacks.onTradeCreated({
        tradeId: 'trade-pending',
        sellerPubkey: '02' + '33'.repeat(32),
        buyerPubkey: '02' + '22'.repeat(32),
        sellerLocktime: '2026-05-07T12:01:00Z',
        buyerLocktime: '2026-05-07T12:00:00Z',
        marketId: 'cond-NO',
        outcomeFaceAmountSats: 100,
        quotePaymentSats: 50,
      })
    })

    await waitFor(() =>
      expect(mockJoinTrade).toHaveBeenCalledWith('trade-pending'),
    )
    const swap = useActiveSwapsStore.getState().byTradeId['trade-pending']
    expect(swap.orderId).toBe('order-pending')
    expect(swap.marketId).toBe('cond-NO')
    expect(swap.role).toBe('buyer')
    expect(swap.outcomeFaceAmountSats).toBe(100)
    expect(swap.quotePaymentSats).toBe(50)
  })

  it('ignores duplicate TradeCreated events after role assignment', async () => {
    usePendingTradesStore.getState().add({
      orderId: 'order-pending',
      marketId: 'cond-YES',
      ephemeralPrivkey: '11'.repeat(32),
      ephemeralPubkey: '02' + '22'.repeat(32),
      submittedAt: Date.now(),
    })

    renderHook(() => useTradeSettlement(true))

    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onTradeCreated: (payload: {
        tradeId: string
        sellerPubkey: string
        buyerPubkey: string
        sellerLocktime: string
        buyerLocktime: string
        marketId?: string
      }) => void
    }
    const payload = {
      tradeId: 'trade-duplicate',
      sellerPubkey: '02' + '33'.repeat(32),
      buyerPubkey: '02' + '22'.repeat(32),
      sellerLocktime: '2026-05-07T12:01:00Z',
      buyerLocktime: '2026-05-07T12:00:00Z',
      marketId: 'cond-NO',
    }

    await act(async () => callbacks.onTradeCreated(payload))
    await act(async () => callbacks.onTradeCreated(payload))

    expect(mockJoinTrade).toHaveBeenCalledTimes(1)
  })

  it('fails the swap before role assignment when TradeCreated locktimes are inverted', async () => {
    renderHook(() => useTradeSettlement(true))

    await act(async () => {
      useActiveSwapsStore.getState().promote({
        tradeId: 'trade-2',
        orderId: 'order-2',
        marketId: 'market-1',
        ephemeralPrivkeyHex: '11'.repeat(32),
        ephemeralPubkeyHex: '22'.repeat(32),
      })
    })

    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onTradeCreated: (payload: {
        tradeId: string
        sellerPubkey: string
        buyerPubkey: string
        sellerLocktime: string
        buyerLocktime: string
      }) => void
    }

    await act(async () => {
      callbacks.onTradeCreated({
        tradeId: 'trade-2',
        sellerPubkey: '22'.repeat(32),
        buyerPubkey: '33'.repeat(32),
        sellerLocktime: '2026-05-07T12:00:00Z',
        buyerLocktime: '2026-05-07T12:01:00Z',
      })
    })

    const swap = useActiveSwapsStore.getState().byTradeId['trade-2']
    expect(swap.step).toBe('failed')
    expect(swap.role).toBeNull()
    expect(swap.error).toMatch(/locktime ordering violates protocol invariant/i)
    expect(mockSendSwapMessage).not.toHaveBeenCalled()
  })

  it('keeps completed swaps terminal when a late failed state arrives', async () => {
    renderHook(() => useTradeSettlement(true))

    await act(async () => {
      useActiveSwapsStore.getState().promote({
        tradeId: 'trade-3',
        orderId: 'order-3',
        marketId: 'market-1',
        ephemeralPrivkeyHex: '11'.repeat(32),
        ephemeralPubkeyHex: '22'.repeat(32),
      })
    })

    const callbacks = mockUseTradeHub.mock.calls.at(-1)?.[1] as {
      onTradeStateChanged: (tradeId: string, newState: string) => void
    }

    await act(async () => {
      callbacks.onTradeStateChanged('trade-3', 'Confirmed')
    })
    expect(useActiveSwapsStore.getState().byTradeId['trade-3'].step).toBe(
      'completed',
    )

    await act(async () => {
      callbacks.onTradeStateChanged('trade-3', 'Failed')
    })

    const swap = useActiveSwapsStore.getState().byTradeId['trade-3']
    expect(swap.step).toBe('completed')
    expect(swap.error).toBeNull()
  })
})
