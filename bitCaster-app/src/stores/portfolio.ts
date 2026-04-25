/**
 * Zustand store for the authenticated user's on-engine portfolio.
 *
 * Source of truth is the matching engine — `GET /api/v1/users/{pubkey}/positions`.
 * The store is ephemeral (no `persist` middleware): positions are derived state
 * that can be re-fetched at any time, and we'd rather show a momentary
 * loading state than a stale number after a fill.
 *
 * Write path: `refresh()` — hard fetch via NIP-98-authed GET. Fired after
 * the order poller sees a terminal `filled` status (see lib/orderStatus.ts).
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
  clear: () => void
}

export const usePortfolioStore = create<PortfolioState>()((set) => ({
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

  clear: () => set({ pubkey: '', positions: [], error: null, lastFetchedAt: 0 }),
}))
