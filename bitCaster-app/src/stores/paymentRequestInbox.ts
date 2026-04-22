import { create } from 'zustand'

/**
 * A received payment keyed by the originating PaymentRequest id.
 * Populated by the continuous NIP-17 listener; consumed by the
 * "Receive via request" view so the "Waiting…" → "Received" transition
 * survives reloads, navigation, and payments that arrive before the
 * view is mounted.
 */
export interface InboxEntry {
  id: string
  amountSats: number
  receivedAt: number
}

interface InboxState {
  entries: Record<string, InboxEntry>
  markReceived: (id: string, amountSats: number) => void
  clear: (id: string) => void
}

export const usePaymentRequestInbox = create<InboxState>((set) => ({
  entries: {},
  markReceived: (id, amountSats) =>
    set((s) => ({
      entries: {
        ...s.entries,
        [id]: { id, amountSats, receivedAt: Date.now() },
      },
    })),
  clear: (id) =>
    set((s) => {
      if (!(id in s.entries)) return s
      const next = { ...s.entries }
      delete next[id]
      return { entries: next }
    }),
}))
