import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  ActivityItem,
  ActivityStatus,
  ActivityType,
  TradeActivityDetails,
} from "@/types/portfolio";

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

const ACTIVITY_TYPES = new Set<ActivityType>([
  "deposit",
  "withdrawal",
  "Buy",
  "Sell",
  "payout_claimed",
  "creator_fee_claimed",
]);
const ACTIVITY_STATUSES = new Set<ActivityStatus>(["pending", "completed", "Failed"]);
const CANONICAL_WALLET_ID = /^[0-9a-f]{64}$/;

function decodeTradeDetails(value: unknown): TradeActivityDetails | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const details = value as Record<string, unknown>;
  if (
    typeof details.fillId !== "string" ||
    details.fillId.length === 0 ||
    typeof details.outcomeId !== "string" ||
    details.outcomeId.length === 0 ||
    (details.tokenSide !== "Outcome" && details.tokenSide !== "Complement") ||
    typeof details.faceAmountSubunits !== "number" ||
    !Number.isSafeInteger(details.faceAmountSubunits) ||
    details.faceAmountSubunits <= 0 ||
    (details.divisibility !== 1_000 && details.divisibility !== 1_000_000)
  ) {
    return null;
  }
  return {
    fillId: details.fillId,
    outcomeId: details.outcomeId,
    tokenSide: details.tokenSide,
    faceAmountSubunits: details.faceAmountSubunits,
    divisibility: details.divisibility,
  };
}

/** Decode current and legacy persisted items without assigning an unknown wallet. */
export function decodeActivityItem(value: unknown): ActivityItem | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Record<string, unknown>;
  const amountValue = Object.hasOwn(item, "amountSubunits") ? item.amountSubunits : item.amountSats;
  const hasWalletId = Object.hasOwn(item, "walletId");
  const hasTradeDetails = Object.hasOwn(item, "tradeDetails");
  const tradeDetails = hasTradeDetails ? decodeTradeDetails(item.tradeDetails) : undefined;
  if (
    typeof item.id !== "string" ||
    typeof item.type !== "string" ||
    !ACTIVITY_TYPES.has(item.type as ActivityType) ||
    typeof amountValue !== "number" ||
    !Number.isSafeInteger(amountValue) ||
    item.baseAsset !== "sat" ||
    typeof item.date !== "string" ||
    typeof item.status !== "string" ||
    !ACTIVITY_STATUSES.has(item.status as ActivityStatus) ||
    (item.txId !== null && typeof item.txId !== "string") ||
    (item.lightningInvoice !== null && typeof item.lightningInvoice !== "string") ||
    (item.failureReason !== undefined && typeof item.failureReason !== "string") ||
    (item.marketId !== undefined && typeof item.marketId !== "string") ||
    (item.marketTitle !== undefined && typeof item.marketTitle !== "string") ||
    (item.positionId !== undefined && typeof item.positionId !== "string") ||
    (hasWalletId &&
      (typeof item.walletId !== "string" || !CANONICAL_WALLET_ID.test(item.walletId))) ||
    (hasTradeDetails &&
      (tradeDetails === undefined ||
        tradeDetails === null ||
        (item.type !== "Buy" && item.type !== "Sell") ||
        item.status !== "completed" ||
        !hasWalletId ||
        typeof item.walletId !== "string" ||
        typeof item.marketId !== "string" ||
        item.id !== `trade:${item.walletId}:${tradeDetails.fillId}`))
  ) {
    return null;
  }

  return {
    id: item.id,
    ...(hasWalletId ? { walletId: item.walletId as string } : {}),
    type: item.type as ActivityType,
    amountSubunits: amountValue,
    baseAsset: "sat",
    date: item.date,
    status: item.status as ActivityStatus,
    txId: item.txId as string | null,
    lightningInvoice: item.lightningInvoice as string | null,
    ...(typeof item.failureReason === "string" ? { failureReason: item.failureReason } : {}),
    ...(typeof item.marketId === "string" ? { marketId: item.marketId } : {}),
    ...(typeof item.marketTitle === "string" ? { marketTitle: item.marketTitle } : {}),
    ...(typeof item.positionId === "string" ? { positionId: item.positionId } : {}),
    ...(tradeDetails ? { tradeDetails } : {}),
  };
}

function decodeActivityItems(value: unknown): ActivityItem[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const decoded = decodeActivityItem(item);
        return decoded === null ? [] : [decoded];
      })
    : [];
}

export function activityItemIdentityKey(item: ActivityItem): string {
  return JSON.stringify([item.walletId ?? null, item.id]);
}

function activityItemEqual(a: ActivityItem, b: ActivityItem): boolean {
  return (
    a.id === b.id &&
    a.walletId === b.walletId &&
    a.type === b.type &&
    a.amountSubunits === b.amountSubunits &&
    a.baseAsset === b.baseAsset &&
    a.date === b.date &&
    a.status === b.status &&
    a.txId === b.txId &&
    a.lightningInvoice === b.lightningInvoice &&
    a.failureReason === b.failureReason &&
    a.marketId === b.marketId &&
    a.marketTitle === b.marketTitle &&
    a.positionId === b.positionId &&
    (a.tradeDetails === undefined
      ? b.tradeDetails === undefined
      : b.tradeDetails !== undefined &&
        a.tradeDetails.fillId === b.tradeDetails.fillId &&
        a.tradeDetails.outcomeId === b.tradeDetails.outcomeId &&
        a.tradeDetails.tokenSide === b.tradeDetails.tokenSide &&
        a.tradeDetails.faceAmountSubunits === b.tradeDetails.faceAmountSubunits &&
        a.tradeDetails.divisibility === b.tradeDetails.divisibility)
  );
}

export function activityLogsEqual(a: readonly ActivityItem[], b: readonly ActivityItem[]): boolean {
  if (a.length !== b.length) return false;
  const byId = new Map(a.map((item) => [activityItemIdentityKey(item), item] as const));
  for (const item of b) {
    const other = byId.get(activityItemIdentityKey(item));
    if (!other || !activityItemEqual(other, item)) return false;
  }
  return true;
}

function activityLogsEqualInOrder(a: readonly ActivityItem[], b: readonly ActivityItem[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => activityItemEqual(item, b[index]));
}

export const useActivityLogStore = create<ActivityLogState>()(
  persist(
    (set, get) => ({
      items: [],
      addActivity: (entry) => {
        if (!CANONICAL_WALLET_ID.test(entry.walletId)) {
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
