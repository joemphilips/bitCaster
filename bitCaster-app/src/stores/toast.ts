import { create } from 'zustand'

export type ToastType = 'success' | 'error' | 'info'

export interface Toast {
  id: string
  message: string
  type: ToastType
  /** Auto-dismiss delay in ms. Defaults to 4000 for success/info, 6000 for error. */
  duration?: number
}

interface ToastState {
  toasts: Toast[]
  addToast: (toast: Omit<Toast, 'id'>) => void
  removeToast: (id: string) => void
}

const MAX_TOASTS = 10
let nextId = 0

export const useToastStore = create<ToastState>()((set) => ({
  toasts: [],
  addToast: (toast) => {
    const id = `toast-${Date.now()}-${nextId++}`
    set((s) => ({
      toasts: [...s.toasts, { ...toast, id }].slice(-MAX_TOASTS),
    }))
  },
  removeToast: (id) => {
    set((s) => {
      const next = s.toasts.filter((t) => t.id !== id)
      if (next.length === s.toasts.length) return s
      return { toasts: next }
    })
  },
}))
