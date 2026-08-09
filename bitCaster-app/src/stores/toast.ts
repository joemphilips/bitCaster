import { create } from "zustand";

export type ToastType = "success" | "error" | "info";

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  /** Auto-dismiss delay in ms. Defaults to 4000 for success and info. Errors ignore this value. */
  duration?: number;
}

interface ToastState {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, "id">) => void;
  removeToast: (id: string) => void;
}

const MAX_TOASTS = 10;
let nextId = 0;

function isTransient(toast: Toast): boolean {
  return toast.type !== "error";
}

function removeOverflowingTransientToasts(toasts: Toast[], addedType: ToastType): Toast[] {
  const maxExistingTransients = addedType === "error" ? MAX_TOASTS : MAX_TOASTS - 1;
  const excessCount = toasts.filter(isTransient).length - maxExistingTransients;
  if (excessCount <= 0) return toasts;

  const removedIds = new Set(
    toasts
      .filter(isTransient)
      .slice(0, excessCount)
      .map((toast) => toast.id),
  );
  return toasts.filter((toast) => !removedIds.has(toast.id));
}

export const useToastStore = create<ToastState>()((set) => ({
  toasts: [],
  addToast: (toast) => {
    const id = `toast-${Date.now()}-${nextId++}`;
    set((s) => ({
      toasts: [...removeOverflowingTransientToasts(s.toasts, toast.type), { ...toast, id }],
    }));
  },
  removeToast: (id) => {
    set((s) => {
      const next = s.toasts.filter((t) => t.id !== id);
      if (next.length === s.toasts.length) return s;
      return { toasts: next };
    });
  },
}));
