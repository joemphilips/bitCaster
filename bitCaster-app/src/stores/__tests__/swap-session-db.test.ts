import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActiveSwap } from '../activeSwaps'

const rows = new Map<string, Record<string, unknown>>()

vi.mock('../proof-db', () => ({
  db: {
    swapSessions: {
      put: async (row: { tradeId: string }) => {
        rows.set(row.tradeId, row as Record<string, unknown>)
      },
      toArray: async () => Array.from(rows.values()),
      delete: async (tradeId: string) => {
        rows.delete(tradeId)
      },
    },
  },
}))

import {
  MAX_ACTIVE_GUI_SWAP_SESSIONS,
  loadRecoverableGuiSwapSessions,
  persistGuiSwapSession,
  removeGuiSwapSession,
} from '../swap-session-db'

function swap(overrides: Partial<ActiveSwap> = {}): ActiveSwap {
  return {
    tradeId: 'trade-001',
    orderId: 'order-001',
    marketId: 'condition-YES',
    ephemeralPrivkeyHex: '1'.repeat(64),
    ephemeralPubkeyHex: `02${'a'.repeat(64)}`,
    role: 'seller',
    counterpartyPubkey: `03${'b'.repeat(64)}`,
    sellerLocktime: 120,
    buyerLocktime: 100,
    outcomeFaceAmountSats: null,
    outcomeFaceAmountSubunits: null,
    quotePaymentSats: null,
    baseAsset: 'sat',
    divisibility: 10_000,
    quotePaymentSubunits: null,
    settlementKind: 'DirectSwap',
    sellerKeepOutcomeSetId: null,
    sellerLockOutcomeSetId: null,
    step: 'awaiting-counterparty',
    messages: {},
    sellerState: null,
    buyerState: null,
    inFlightSteps: {},
    error: null,
    startedAt: 1,
    ...overrides,
  }
}

beforeEach(() => rows.clear())

describe('GUI durable swap session repository', () => {
  it('persists and hydrates a protocol-bound GUI session', async () => {
    const active = swap()
    await persistGuiSwapSession(active, 'https://mint.example')

    await expect(loadRecoverableGuiSwapSessions()).resolves.toEqual([active])
  })

  it('refuses a row whose GUI payload no longer matches its persisted protocol binding', async () => {
    await persistGuiSwapSession(swap(), 'https://mint.example')
    const row = rows.get('trade-001') as {
      adapterState: ActiveSwap
    }
    row.adapterState = {
      ...row.adapterState,
      counterpartyPubkey: `02${'c'.repeat(64)}`,
    }

    await expect(loadRecoverableGuiSwapSessions()).resolves.toEqual([])
  })

  it('removes only a successful terminal session after proof reconciliation', async () => {
    await persistGuiSwapSession(swap({ step: 'completed' }), 'https://mint.example')
    await expect(loadRecoverableGuiSwapSessions()).resolves.toEqual([])
    await removeGuiSwapSession('trade-001')
    expect(rows.has('trade-001')).toBe(false)
  })

  it('fails closed instead of evicting a live durable session at capacity', async () => {
    for (let i = 0; i < MAX_ACTIVE_GUI_SWAP_SESSIONS; i += 1) {
      const tradeId = `trade-${i}`
      rows.set(tradeId, {
        tradeId,
        session: {},
        adapterState: swap({ tradeId }),
        updatedAt: i,
      })
    }

    await expect(
      persistGuiSwapSession(swap({ tradeId: 'trade-overflow' }), 'https://mint.example'),
    ).rejects.toThrow(/capacity is exhausted/)
    expect(rows).toHaveLength(MAX_ACTIVE_GUI_SWAP_SESSIONS)
  })
})
