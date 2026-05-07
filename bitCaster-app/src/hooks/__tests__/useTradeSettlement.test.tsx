import { renderHook, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useActiveSwapsStore } from '@/stores/activeSwaps'

const { mockUseTradeHub, mockJoinTrade, mockSendSwapMessage } = vi.hoisted(
  () => ({
    mockUseTradeHub: vi.fn(),
    mockJoinTrade: vi.fn(),
    mockSendSwapMessage: vi.fn(),
  }),
)

vi.mock('@/hooks/useTradeHub', () => ({
  useTradeHub: mockUseTradeHub,
}))

vi.mock('@/stores/wallet', () => ({
  useWalletStore: (selector: (state: { activeMintUrl: string }) => unknown) =>
    selector({ activeMintUrl: 'https://mint.example' }),
}))

const { useTradeSettlement } = await import('../useTradeSettlement')

const privkey = new Uint8Array(32).fill(7)

beforeEach(() => {
  vi.clearAllMocks()
  useActiveSwapsStore.setState({ byTradeId: {} })
  mockJoinTrade.mockResolvedValue(undefined)
  mockSendSwapMessage.mockResolvedValue(undefined)
  mockUseTradeHub.mockReturnValue({
    joinTrade: mockJoinTrade,
    sendSwapMessage: mockSendSwapMessage,
    connectionState: vi.fn(),
  })
})

describe('useTradeSettlement', () => {
  it('does not start the private TradeHub when no swap is active', () => {
    renderHook(() => useTradeSettlement(privkey))

    expect(mockUseTradeHub).toHaveBeenCalledWith(null, expect.any(Object))
    expect(mockJoinTrade).not.toHaveBeenCalled()
  })

  it('connects and joins only after an active swap is promoted', async () => {
    renderHook(() => useTradeSettlement(privkey))

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
      privkey,
      expect.any(Object),
    )
    expect(mockJoinTrade).toHaveBeenCalledWith('trade-1')
  })
})
