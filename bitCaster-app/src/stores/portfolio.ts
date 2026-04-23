/**
 * Zustand store for the authenticated user's on-engine portfolio.
 *
 * Source of truth is the matching engine — `GET /api/v1/users/{pubkey}/positions`.
 * The store is ephemeral (no `persist` middleware): positions are derived state
 * that can be re-fetched at any time, and we'd rather show a momentary
 * loading state than a stale number after a fill.
 *
 * Two write paths:
 *   1. `refresh()` — hard fetch via NIP-98-authed GET. Fired after the order
 *      poller sees a terminal `filled` status (see lib/orderStatus.ts).
 *   2. `applyDelta()` — optimistic merge from the MarketHub
 *      `PositionUpdated(userPubkey, marketId, outcome, deltaTokens)` push.
 *      Keeps the UI responsive between a fill and the next `refresh()`.
 *
 * SECURITY: every `refresh()` call signs a fresh NIP-98 event — the backend
 * compares the path pubkey against the authenticated claim (P03). We don't
 * cache the auth header because NIP-98 tokens are ±60 s bound.
 */

import { create } from 'zustand'
import type { components } from '@/generated/api'
import { generateNip98Header } from '@/lib/markets'

export type PositionDto = components['schemas']['PositionDto']

interface PortfolioState {
  /** Pubkey the current `positions` list belongs to. Empty when never fetched. */
  pubkey: string
  positions: PositionDto[]
  loading: boolean
  /** Null when no error; populated on failed fetch so the UI can surface it. */
  error: string | null
  /** Millisecond timestamp of the last successful fetch; 0 when never fetched. */
  lastFetchedAt: number

  /** Pull the latest portfolio for `pubkey` from the engine. */
  refresh: (pubkey: string) => Promise<void>
  /**
   * Optimistically merge a `PositionUpdated` delta into the store. Called
   * from the MarketHub SignalR handler wired up in App.tsx. If the
   * incoming `userPubkey` doesn't match the currently-loaded `pubkey` the
   * delta is dropped — this guards against the (unlikely) case where a
   * stale hub event arrives after a user switch.
   */
  applyDelta: (
    userPubkey: string,
    marketId: string,
    outcome: string,
    deltaTokens: number,
  ) => void
  clear: () => void
}

export const usePortfolioStore = create<PortfolioState>()((set, get) => ({
  pubkey: '',
  positions: [],
  loading: false,
  error: null,
  lastFetchedAt: 0,

  refresh: async (pubkey: string) => {
    if (!pubkey) return
    set({ loading: true, error: null })
    try {
      const url = `${window.location.origin}/api/v1/users/${pubkey}/positions`
      const authHeader = await generateNip98Header(url, 'GET')
      const response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: authHeader },
      })
      if (!response.ok) {
        throw new Error(`Portfolio fetch failed: ${response.status}`)
      }
      const body = (await response.json()) as {
        userPubkey: string
        positions: PositionDto[]
      }
      set({
        pubkey,
        positions: body.positions ?? [],
        loading: false,
        error: null,
        lastFetchedAt: Date.now(),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set({ loading: false, error: message })
    }
  },

  applyDelta: (userPubkey, marketId, outcome, deltaTokens) => {
    const current = get()
    // Drop deltas for a different user — e.g. after a logout/login without
    // a refresh landing yet. The next `refresh()` will reconcile.
    if (current.pubkey && current.pubkey !== userPubkey) return
    const now = new Date().toISOString()
    const existingIdx = current.positions.findIndex(
      (p) => p.marketId === marketId && p.outcome === outcome,
    )
    if (existingIdx === -1) {
      // New position — we don't know the cost basis from a delta push
      // alone, so leave totalCostSats at 0 until the next refresh.
      set({
        positions: [
          ...current.positions,
          {
            marketId,
            outcome,
            tokenAmount: deltaTokens,
            totalCostSats: 0,
            lastUpdated: now,
          },
        ],
      })
      return
    }
    const next = [...current.positions]
    const prev = next[existingIdx]
    next[existingIdx] = {
      ...prev,
      tokenAmount: prev.tokenAmount + deltaTokens,
      lastUpdated: now,
    }
    set({ positions: next })
  },

  clear: () => set({ pubkey: '', positions: [], error: null, lastFetchedAt: 0 }),
}))
