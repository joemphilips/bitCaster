import { beforeEach, describe, expect, it, vi } from 'vitest'
import { secp256k1 } from '@noble/curves/secp256k1.js'

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
  migrateLegacyGuiPendingSwapIntents,
  parseLegacyPendingSwapIntents,
  markGuiPendingSwapIntentSubmitted,
  persistGuiPendingSwapIntent,
} from '../pending-swap-intent-db'

const intent = {
  tradeId: 'trade-001',
  orderId: 'order-001',
  marketId: 'condition-YES',
  pubkey: Array.from(secp256k1.getPublicKey(new Uint8Array(32).fill(1), true))
    .map((part) => part.toString(16).padStart(2, '0'))
    .join(''),
  privkey: '01'.repeat(32),
  deadline: '2099-01-01T00:00:00.000Z',
  submitted: false,
}

beforeEach(() => {
  rows.clear()
  storageError = null
  window.localStorage.clear()
})

describe('GUI pending swap intent repository', () => {
  it('accepts only valid legacy Zustand entries for durable migration', () => {
    const parsed = parseLegacyPendingSwapIntents(JSON.stringify({
      state: {
        byTradeId: {
          [intent.tradeId]: intent,
          malformed: { ...intent, tradeId: 'malformed', privkey: 'bad' },
        },
      },
    }))

    expect(parsed).toEqual([intent])
  })

  it('migrates valid legacy intent records before clearing the local-storage payload', async () => {
    window.localStorage.setItem('bitcaster-pending-pubkeys', JSON.stringify({
      state: { byTradeId: { [intent.tradeId]: intent } },
    }))

    await expect(migrateLegacyGuiPendingSwapIntents()).resolves.toEqual([intent])
    await expect(getGuiPendingSwapIntent(intent.tradeId)).resolves.toEqual(intent)
    expect(window.localStorage.getItem('bitcaster-pending-pubkeys')).toBeNull()
  })

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

  it('rejects a pre-session private key that does not derive its stored public key', async () => {
    await expect(persistGuiPendingSwapIntent({
      ...intent,
      pubkey: `02${'b'.repeat(64)}`,
    })).rejects.toThrow(/private key does not match/)
  })
})
