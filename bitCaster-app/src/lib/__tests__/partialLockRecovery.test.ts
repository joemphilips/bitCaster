import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const partialState = {
    byTradeId: {} as Record<string, unknown>,
    list: vi.fn(),
    remove: vi.fn(),
  }
  const pendingState = {
    get: vi.fn(),
  }
  const walletState = {
    getWallet: vi.fn(),
  }
  return {
    partialState,
    pendingState,
    walletState,
    addProofs: vi.fn(),
    getReservedProofs: vi.fn(),
    markProofOperationCompleted: vi.fn(),
    prepareProofOperation: vi.fn(),
    removeProofs: vi.fn(),
    createP2PKWitness: vi.fn(() => 'witness'),
    hexToBytes: vi.fn(() => new Uint8Array(32)),
  }
})

vi.mock('@cashu/cashu-ts', () => ({
  getEncodedToken: vi.fn(() => 'encoded-token'),
}))

vi.mock('@bitcaster/swap-protocol/p2pk', () => ({
  createP2PKWitness: mocks.createP2PKWitness,
}))

vi.mock('@bitcaster/swap-protocol/ecdh', () => ({
  hexToBytes: mocks.hexToBytes,
}))

vi.mock('@/stores/proof-db', () => ({
  addProofs: mocks.addProofs,
  getReservedProofs: mocks.getReservedProofs,
  markProofOperationCompleted: mocks.markProofOperationCompleted,
  prepareProofOperation: mocks.prepareProofOperation,
  removeProofs: mocks.removeProofs,
}))

vi.mock('@/stores/partialLockFailures', () => ({
  usePartialLockFailuresStore: {
    getState: () => mocks.partialState,
  },
}))

vi.mock('@/stores/pendingTrades', () => ({
  usePendingTradesStore: {
    getState: () => mocks.pendingState,
  },
}))

vi.mock('@/stores/wallet', () => ({
  useWalletStore: {
    getState: () => mocks.walletState,
  },
}))

describe('partial-lock recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-27T00:00:00Z'))
    mocks.partialState.byTradeId = {
      'trade-1': {
        kind: 'PartialLockHeld',
        tradeId: 'trade-1',
        orderId: 'order-1',
        mintUrl: 'https://mint.example',
        refundLocktime: Math.floor(Date.now() / 1000) - 61,
        affectedKeysets: ['keyset-B', 'keyset-C'],
        detail: 'partial lock',
        lockedProofs: [],
        outcomeByKeyset: {
          'keyset-B': {
            conditionId: 'condition-1',
            outcomeCollection: 'B',
            marketId: 'condition-1-B',
          },
          'keyset-C': {
            conditionId: 'condition-1',
            outcomeCollection: 'C',
            marketId: 'condition-1-C',
          },
        },
      },
    }
    mocks.partialState.list.mockReturnValue(Object.values(mocks.partialState.byTradeId))
    mocks.pendingState.get.mockReturnValue({ ephemeralPrivkey: '11'.repeat(32) })
    mocks.getReservedProofs.mockResolvedValue([
      {
        id: 'keyset-B',
        amount: 100,
        secret: 'locked-B',
        C: '02'.padEnd(66, '0'),
        mintUrl: 'https://mint.example',
        reservedBy: 'trade-1',
      },
      {
        id: 'keyset-C',
        amount: 100,
        secret: 'locked-C',
        C: '03'.padEnd(66, '0'),
        mintUrl: 'https://mint.example',
        reservedBy: 'trade-1',
      },
    ])
    mocks.walletState.getWallet.mockResolvedValue({
      receive: vi.fn().mockResolvedValue([
        { id: 'keyset-B', amount: 100, secret: 'fresh-B', C: '02'.padEnd(66, '1') },
        { id: 'keyset-C', amount: 100, secret: 'fresh-C', C: '03'.padEnd(66, '1') },
      ]),
    })
    mocks.addProofs.mockResolvedValue(undefined)
    mocks.removeProofs.mockResolvedValue(undefined)
    mocks.prepareProofOperation.mockResolvedValue({})
    mocks.markProofOperationCompleted.mockResolvedValue({})
  })

  it('PartialLockRefund_IndexedDBFailureMidTransaction_DoesNotOrphan', async () => {
    mocks.removeProofs.mockRejectedValueOnce(new Error('delete failed'))
    const { sweepElapsedPartialLockFailures } = await import('../partialLockRecovery')

    await sweepElapsedPartialLockFailures()

    expect(mocks.addProofs.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.removeProofs.mock.invocationCallOrder[0],
    )
    expect(mocks.addProofs.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        id: 'keyset-B',
        conditionId: 'condition-1',
        outcomeCollection: 'B',
        marketId: 'condition-1-B',
      }),
      expect.objectContaining({
        id: 'keyset-C',
        conditionId: 'condition-1',
        outcomeCollection: 'C',
        marketId: 'condition-1-C',
      }),
    ])
    expect(mocks.partialState.remove).not.toHaveBeenCalled()
  })
})
