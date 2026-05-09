import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  ActivityItem,
  ActivityType,
  ActivityStatus,
} from "@/types/portfolio";

interface ActivityLogState {
  items: ActivityItem[];
  addActivity: (entry: {
    type: ActivityType;
    amountSats: number;
    status: ActivityStatus;
    txId?: string | null;
    lightningInvoice?: string | null;
    marketId?: string;
    marketTitle?: string;
  }) => void;
  replace: (items: ActivityItem[]) => void;
  clear: () => void;
}

function activityItemEqual(a: ActivityItem, b: ActivityItem): boolean {
  return (
    a.id === b.id &&
    a.type === b.type &&
    a.amountSats === b.amountSats &&
    a.date === b.date &&
    a.status === b.status &&
    a.txId === b.txId &&
    a.lightningInvoice === b.lightningInvoice &&
    a.failureReason === b.failureReason &&
    a.marketId === b.marketId &&
    a.marketTitle === b.marketTitle &&
    a.positionId === b.positionId
  );
}

export function activityLogsEqual(
  a: readonly ActivityItem[],
  b: readonly ActivityItem[],
): boolean {
  if (a.length !== b.length) return false;
  const byId = new Map(a.map((item) => [item.id, item] as const));
  for (const item of b) {
    const other = byId.get(item.id);
    if (!other || !activityItemEqual(other, item)) return false;
  }
  return true;
}

function activityLogsEqualInOrder(
  a: readonly ActivityItem[],
  b: readonly ActivityItem[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => activityItemEqual(item, b[index]));
}

export const useActivityLogStore = create<ActivityLogState>()(
  persist(
    (set, get) => ({
      items: [],
      addActivity: (entry) => {
        const item: ActivityItem = {
          id: crypto.randomUUID(),
          type: entry.type,
          amountSats: entry.amountSats,
          date: new Date().toISOString(),
          status: entry.status,
          txId: entry.txId ?? null,
          lightningInvoice: entry.lightningInvoice ?? null,
          marketId: entry.marketId,
          marketTitle: entry.marketTitle,
        };
        set((s) => ({ items: [item, ...s.items].slice(0, 500) }));
      },
      replace: (items) => {
        const next = [...items]
          .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
          .slice(0, 500);
        if (activityLogsEqualInOrder(get().items, next)) return;
        set({ items: next });
      },
      clear: () => set({ items: [] }),
    }),
    {
      name: "bitcaster-activity-log",
      partialize: (s) => ({ items: s.items }),
    },
  ),
);
