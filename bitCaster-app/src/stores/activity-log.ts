import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ActivityItem, ActivityStatus, ActivityType } from "@/types/portfolio";

interface ActivityLogState {
  items: ActivityItem[];
  addActivity: (entry: {
    walletId: string;
    type: ActivityType;
    amountSubunits: number;
    baseAsset: ActivityItem["baseAsset"];
    status: ActivityStatus;
    txId?: string | null;
    lightningInvoice?: string | null;
    marketId?: string;
    marketTitle?: string;
  }) => void;
  upsertConfirmedTrade: (item: ActivityItem) => void;
  replace: (items: ActivityItem[]) => void;
  clear: () => void;
}

import {
  activityItemIdentityKey,
  activityLogsEqualInOrder,
  decodeActivityItem,
  decodeActivityItems,
  isCanonicalActivityWalletId,
} from "@bitcaster/client-sdk/activityLog";
export {
  activityItemIdentityKey,
  activityLogsEqual,
  decodeActivityItem,
} from "@bitcaster/client-sdk/activityLog";

export const useActivityLogStore = create<ActivityLogState>()(
  persist(
    (set, get) => ({
      items: [],
      addActivity: (entry) => {
        if (!isCanonicalActivityWalletId(entry.walletId)) {
          throw new Error("Activity wallet id is invalid.");
        }
        const item: ActivityItem = {
          id: crypto.randomUUID(),
          walletId: entry.walletId,
          type: entry.type,
          amountSubunits: entry.amountSubunits,
          baseAsset: entry.baseAsset,
          date: new Date().toISOString(),
          status: entry.status,
          txId: entry.txId ?? null,
          lightningInvoice: entry.lightningInvoice ?? null,
          marketId: entry.marketId,
          marketTitle: entry.marketTitle,
        };
        set((s) => ({ items: [item, ...s.items].slice(0, 500) }));
      },
      upsertConfirmedTrade: (item) => {
        const decoded = decodeActivityItem(item);
        if (
          decoded === null ||
          decoded.walletId === undefined ||
          decoded.marketId === undefined ||
          decoded.tradeDetails === undefined ||
          (decoded.type !== "Buy" && decoded.type !== "Sell") ||
          decoded.status !== "completed"
        ) {
          throw new Error("Confirmed trade activity is invalid.");
        }
        const identity = activityItemIdentityKey(decoded);
        set((s) => {
          const next = [
            decoded,
            ...s.items.filter((current) => activityItemIdentityKey(current) !== identity),
          ]
            .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
            .slice(0, 500);
          if (activityLogsEqualInOrder(s.items, next)) return s;
          return { items: next };
        });
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
      merge: (persistedState, currentState) => {
        const stored = persistedState as { items?: unknown } | undefined;
        return {
          ...currentState,
          items:
            stored?.items === undefined ? currentState.items : decodeActivityItems(stored.items),
        };
      },
    },
  ),
);
