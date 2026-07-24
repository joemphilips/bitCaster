import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { OutcomeMetadata, PartialLockHeldRecord } from "@bitcaster/client-sdk/swapFailure";

interface PartialLockFailureState {
  byTradeId: Record<string, PartialLockHeldRecord>;
  upsert: (record: PartialLockHeldRecord) => void;
  remove: (tradeId: string) => void;
  list: () => PartialLockHeldRecord[];
}

export const usePartialLockFailuresStore = create<PartialLockFailureState>()(
  persist(
    (set, get) => ({
      byTradeId: {},
      upsert: (record) =>
        set((state) => ({
          byTradeId: { ...state.byTradeId, [record.tradeId]: record },
        })),
      remove: (tradeId) =>
        set((state) => {
          if (!(tradeId in state.byTradeId)) return state;
          const next = { ...state.byTradeId };
          delete next[tradeId];
          return { byTradeId: next };
        }),
      list: () => Object.values(get().byTradeId),
    }),
    {
      name: "bitcaster-partial-lock-failures",
      version: 2,
      migrate: migratePartialLockFailureState,
    },
  ),
);

interface LegacyPartialLockFailure {
  tradeId?: unknown;
  orderId?: unknown;
  mintUrl?: unknown;
  refundLocktime?: unknown;
  affectedKeysets?: unknown;
  detail?: unknown;
  createdAt?: unknown;
  conditionId?: unknown;
  outcomeCollection?: unknown;
  marketId?: unknown;
  lockedProofs?: unknown;
}

export function migratePartialLockFailureState(
  state: unknown,
  fromVersion: number,
): Partial<PartialLockFailureState> | unknown {
  if (fromVersion >= 2 || !state || typeof state !== "object") return state;
  const byTradeId = (state as { byTradeId?: unknown }).byTradeId;
  if (!byTradeId || typeof byTradeId !== "object") return state;

  const migrated: Record<string, PartialLockHeldRecord> = {};
  for (const [tradeId, raw] of Object.entries(byTradeId)) {
    if (!raw || typeof raw !== "object") continue;
    const legacy = raw as LegacyPartialLockFailure;
    const affectedKeysets = Array.isArray(legacy.affectedKeysets)
      ? legacy.affectedKeysets.filter((value): value is string => typeof value === "string")
      : [];
    const metadata: OutcomeMetadata = {
      conditionId: typeof legacy.conditionId === "string" ? legacy.conditionId : "",
      outcomeCollection:
        typeof legacy.outcomeCollection === "string" ? legacy.outcomeCollection : "",
      marketId: typeof legacy.marketId === "string" ? legacy.marketId : "",
    };
    const outcomeByKeyset = Object.fromEntries(
      affectedKeysets.map((keysetId) => [keysetId, metadata]),
    );
    const recordTradeId =
      typeof legacy.tradeId === "string" && legacy.tradeId.length > 0 ? legacy.tradeId : tradeId;
    migrated[recordTradeId] = {
      kind: "PartialLockHeld",
      tradeId: recordTradeId,
      ...(typeof legacy.orderId === "string" ? { orderId: legacy.orderId } : {}),
      ...(typeof legacy.mintUrl === "string" ? { mintUrl: legacy.mintUrl } : {}),
      refundLocktime: typeof legacy.refundLocktime === "number" ? legacy.refundLocktime : 0,
      affectedKeysets,
      detail: typeof legacy.detail === "string" ? legacy.detail : "Partial lock held",
      outcomeByKeyset,
      lockedProofs: Array.isArray(legacy.lockedProofs)
        ? (legacy.lockedProofs as PartialLockHeldRecord["lockedProofs"])
        : [],
      ...(typeof legacy.createdAt === "number" ? { createdAt: legacy.createdAt } : {}),
    };
  }
  return { ...(state as Partial<PartialLockFailureState>), byTradeId: migrated };
}
