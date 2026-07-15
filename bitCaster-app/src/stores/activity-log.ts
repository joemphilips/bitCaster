import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  ActivityItem,
  ActivityStatus,
  ActivityType,
} from "@/types/portfolio";
import { decodePersistedActivityState } from "@/lib/activityLogCodec";

interface NewActivity {
  type: ActivityType;
  amountSats: number;
  baseAsset?: ActivityItem["baseAsset"];
  status: ActivityStatus;
  txId?: string | null;
  lightningInvoice?: string | null;
  marketId?: string;
  marketTitle?: string;
}

interface ActivityLogState {
  activeWalletId: string | null;
  items: ActivityItem[];
  itemsByWalletId: Record<string, ActivityItem[]>;
  activateWallet: (walletId: string | null) => void;
  addActivityForWallet: (walletId: string, entry: NewActivity) => void;
  replaceForWallet: (walletId: string, items: ActivityItem[]) => void;
  clear: () => void;
}

function activityItemEqual(a: ActivityItem, b: ActivityItem): boolean {
  return (
    a.id === b.id &&
    a.type === b.type &&
    a.amountSats === b.amountSats &&
    a.baseAsset === b.baseAsset &&
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
  return (
    a.length === b.length &&
    a.every((item, index) => activityItemEqual(item, b[index]!))
  );
}

function orderedActivities(items: readonly ActivityItem[]): ActivityItem[] {
  return [...items]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, 500);
}

function requireWalletId(walletId: string): string {
  if (!/^[0-9a-f]{64}$/.test(walletId)) {
    throw new Error("Activity requires a seed-derived wallet id");
  }
  return walletId;
}

function newActivity(entry: NewActivity): ActivityItem {
  return {
    id: crypto.randomUUID(),
    type: entry.type,
    amountSats: entry.amountSats,
    baseAsset: entry.baseAsset,
    date: new Date().toISOString(),
    status: entry.status,
    txId: entry.txId ?? null,
    lightningInvoice: entry.lightningInvoice ?? null,
    marketId: entry.marketId,
    marketTitle: entry.marketTitle,
  };
}

export const useActivityLogStore = create<ActivityLogState>()(
  persist(
    (set, get) => {
      const replaceForWallet = (walletId: string, items: ActivityItem[]) => {
        const scopedWalletId = requireWalletId(walletId);
        const next = orderedActivities(items);
        const current = get().itemsByWalletId[scopedWalletId] ?? [];
        if (activityLogsEqualInOrder(current, next)) {
          if (get().activeWalletId === scopedWalletId) set({ items: next });
          return;
        }
        set((state) => ({
          itemsByWalletId: {
            ...state.itemsByWalletId,
            [scopedWalletId]: next,
          },
          ...(state.activeWalletId === scopedWalletId ? { items: next } : {}),
        }));
      };
      const addActivityForWallet = (walletId: string, entry: NewActivity) => {
        const scopedWalletId = requireWalletId(walletId);
        replaceForWallet(scopedWalletId, [
          newActivity(entry),
          ...(get().itemsByWalletId[scopedWalletId] ?? []),
        ]);
      };
      return {
        activeWalletId: null,
        items: [],
        itemsByWalletId: {},
        activateWallet: (walletId) => {
          if (walletId === null) {
            set({ activeWalletId: null, items: [] });
            return;
          }
          const scopedWalletId = requireWalletId(walletId);
          set({
            activeWalletId: scopedWalletId,
            items: get().itemsByWalletId[scopedWalletId] ?? [],
          });
        },
        addActivityForWallet,
        replaceForWallet,
        clear: () => {
          const walletId = get().activeWalletId;
          if (!walletId) {
            set({ items: [] });
            return;
          }
          replaceForWallet(walletId, []);
        },
      };
    },
    {
      name: "bitcaster-activity-log",
      version: 2,
      migrate: () => ({ itemsByWalletId: {} }),
      partialize: (state) => ({ itemsByWalletId: state.itemsByWalletId }),
      merge: (persisted, current) => {
        const { itemsByWalletId } = decodePersistedActivityState(persisted);
        return {
          ...current,
          itemsByWalletId,
          items:
            current.activeWalletId === null
              ? []
              : (itemsByWalletId[current.activeWalletId] ?? []),
        };
      },
    },
  ),
);
