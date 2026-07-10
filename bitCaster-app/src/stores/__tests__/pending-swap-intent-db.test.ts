import { beforeEach, describe, expect, it, vi } from 'vitest'

const rows = new Map<string, Record<string, unknown>>()
let storageError: Error | null = null

vi.mock('../proof-db', () => ({
  ensureDurableSwapStorage: async () => {
    if (storageError) throw storageError
  },
  db: {
    transaction: async (...args: unknown[]) =>
      (args.at(-1) as () => Promise<unknown>)(),
    swapIntents: {
      get: async (tradeId: string) => rows.get(tradeId),
      put: async (row: { tradeId: string }) => { rows.set(row.tradeId, row as Record<string, unknown>) },
      toArray: async () => Array.from(rows.values()),
      delete: async (tradeId: string) => { rows.delete(tradeId) },
    },
  },
}))

import {
  getGuiPendingSwapIntent,
  loadGuiPendingSwapIntents,
  markGuiPendingSwapIntentSubmitted,
  persistGuiPendingSwapIntent,
} from '../pending-swap-intent-db'

const intent = {
  tradeId: 'trade-001',
  orderId: 'order-001',
  marketId: 'condition-YES',
  pubkey: `02${'a'.repeat(64)}`,
  privkey: '1'.repeat(64),
  deadline: '2099-01-01T00:00:00.000Z',
  submitted: false,
}

beforeEach(() => {
  rows.clear()
  storageError = null
})

describe('GUI pending swap intent repository', () => {
  it('persists and hydrates a pre-TradeCreated private key binding', async () => {
    await persistGuiPendingSwapIntent(intent)

    await expect(getGuiPendingSwapIntent(intent.tradeId)).resolves.toEqual(intent)
    await expect(loadGuiPendingSwapIntents()).resolves.toEqual([intent])
  })

  it('marks the durable intent submitted without changing its key binding', async () => {
    await persistGuiPendingSwapIntent(intent)
    await markGuiPendingSwapIntentSubmitted(intent.tradeId)

    await expect(getGuiPendingSwapIntent(intent.tradeId)).resolves.toEqual({ ...intent, submitted: true })
  })

  it('fails closed before storing a pre-session key when durable storage is unavailable', async () => {
    storageError = new Error('IndexedDB unavailable')

    await expect(persistGuiPendingSwapIntent(intent)).rejects.toThrow(/IndexedDB unavailable/)
    expect(rows).toHaveLength(0)
  })
})
