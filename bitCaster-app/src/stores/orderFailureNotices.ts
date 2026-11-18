import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { OrderSettlementFailureReason } from "@bitcaster/client-sdk/engineClient";
import { assertNever } from "@/lib/enumDiscipline";
import { isTerminalCtfRangePreparation } from "@/lib/ctfRangeOrderLifecycle";
import { readCtfRangePreparation } from "@/stores/ctf-range-order-db";

export const ORDER_FAILURE_NOTICES_STORAGE_KEY = "bitcaster-order-failures";

/**
 * Above this count, the oldest notices that are safe to drop are evicted. A
 * notice is safe to drop when its journal operation ended, and the user
 * dismissed it or it belongs to another wallet. A notice with an active
 * journal operation stays: the panel would record its failure again. An
 * undismissed notice of the current wallet stays until the user dismisses it.
 */
export const ORDER_FAILURE_NOTICES_MAX = 100;

/**
 * Why an order failed. `Unspecified` is a final failure with no specific
 * reason, for example a settlement that the engine rejected without a
 * recorded reason.
 */
export type OrderFailureReason = OrderSettlementFailureReason | "Unspecified";

/**
 * The final failure of one order attempt of this wallet. It is display state
 * only: it grants no funds authority, and wallet recovery does not read it.
 */
export interface OrderFailureNotice {
  readonly scopeId: string;
  /** The journal operation of the order attempt. */
  readonly operationId: string;
  /** The engine order. */
  readonly orderId: string;
  readonly marketId: string;
  readonly reason: OrderFailureReason;
  readonly recordedAtMs: number;
  readonly dismissed: boolean;
  /**
   * The wallet saw the journal operation end. Each wallet has its own
   * database, so only that wallet can set this, while it is current.
   */
  readonly ended: boolean;
}

export type NewOrderFailureNotice = Omit<
  OrderFailureNotice,
  "recordedAtMs" | "dismissed" | "ended"
>;

interface OrderFailureNoticeState {
  readonly notices: Readonly<Record<string, OrderFailureNotice>>;
  /**
   * Keep the first notice of an operation, so a later record cannot undo its
   * dismissal. A specific reason replaces the generic one.
   */
  record: (notice: NewOrderFailureNotice, nowMs?: number) => void;
  dismiss: (scopeId: string, operationId: string) => void;
  /** Mark these notices as notices of ended journal operations. */
  markEnded: (keys: readonly string[]) => void;
  /** Keep the count within the limit; see ORDER_FAILURE_NOTICES_MAX. */
  evictBeyondLimit: (currentScopeId: string) => void;
}

/** Two wallets can hold the same operation identifier, so the key holds both. */
export function orderFailureNoticeKey(scopeId: string, operationId: string): string {
  return JSON.stringify([scopeId, operationId]);
}

/**
 * Every storage access can fail, for example in a private window or when the
 * quota is full. Then the page keeps its state in memory only, and after a
 * reload a dismissed reason shows again.
 */
const failSafeLocalStorage: StateStorage = {
  getItem: (name) => {
    try {
      return window.localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      window.localStorage.setItem(name, value);
    } catch {
      // The dismissal stays in memory; a reload shows the reason again.
    }
  },
  removeItem: (name) => {
    try {
      window.localStorage.removeItem(name);
    } catch {
      // As for setItem.
    }
  },
};

// Each action returns before `set` when nothing changes, because the
// persistence middleware writes the whole state on every `set`.
export const useOrderFailureNotices = create<OrderFailureNoticeState>()(
  persist(
    (set, get) => ({
      notices: {},
      record: (notice, nowMs = Date.now()) => {
        const { notices } = get();
        const key = orderFailureNoticeKey(notice.scopeId, notice.operationId);
        const current = notices[key];
        if (current === undefined) {
          set({
            notices: {
              ...notices,
              [key]: { ...notice, recordedAtMs: nowMs, dismissed: false, ended: false },
            },
          });
          return;
        }
        if (isSpecificReason(current.reason) || !isSpecificReason(notice.reason)) return;
        set({ notices: { ...notices, [key]: { ...current, reason: notice.reason } } });
      },
      dismiss: (scopeId, operationId) => {
        const { notices } = get();
        const key = orderFailureNoticeKey(scopeId, operationId);
        const notice = notices[key];
        if (notice === undefined || notice.dismissed) return;
        set({ notices: { ...notices, [key]: { ...notice, dismissed: true } } });
      },
      markEnded: (keys) => {
        const { notices } = get();
        const ending = keys.filter((key) => notices[key]?.ended === false);
        if (ending.length === 0) return;
        const next = { ...notices };
        for (const key of ending) next[key] = { ...next[key]!, ended: true };
        set({ notices: next });
      },
      evictBeyondLimit: (currentScopeId) => {
        const { notices } = get();
        let excess = Object.keys(notices).length - ORDER_FAILURE_NOTICES_MAX;
        if (excess <= 0) return;
        const evictable = Object.entries(notices)
          .filter(([, notice]) => isEvictable(notice, currentScopeId))
          .sort(([, left], [, right]) => left.recordedAtMs - right.recordedAtMs);
        if (evictable.length === 0) return;
        const next = { ...notices };
        for (const [key] of evictable) {
          if (excess <= 0) break;
          delete next[key];
          excess -= 1;
        }
        set({ notices: next });
      },
    }),
    {
      name: ORDER_FAILURE_NOTICES_STORAGE_KEY,
      storage: createJSONStorage(() => failSafeLocalStorage),
      partialize: (state) => ({ notices: state.notices }),
      // Another tab can write a different state. Keep the notices of both,
      // so that neither tab loses a notice or a dismissal of the other.
      merge: (persisted, current) =>
        persisted === undefined
          ? current
          : { ...current, notices: mergeNotices(current.notices, decodeStoredNotices(persisted)) },
    },
  ),
);

/** The locale key of the reason text. The panel and the bell show the same text. */
export function orderFailureReasonTextKey(reason: OrderFailureReason): string {
  switch (reason) {
    case "OwnOutputReused":
      return "settlementProgress.OwnOutputReused";
    case "GroupOutputReused":
      return "settlementProgress.GroupOutputReused";
    case "Unspecified":
      return "settlementProgress.failed";
    default:
      return assertNever(reason);
  }
}

/** A specific reason is final. Only the generic reason can still change. */
export function isSpecificReason(reason: OrderFailureReason): boolean {
  switch (reason) {
    case "OwnOutputReused":
    case "GroupOutputReused":
      return true;
    case "Unspecified":
      return false;
    default:
      return assertNever(reason);
  }
}

function isEvictable(notice: OrderFailureNotice, currentScopeId: string): boolean {
  return notice.ended && (notice.dismissed || notice.scopeId !== currentScopeId);
}

type IsActiveOperation = (scopeId: string, operationId: string) => Promise<boolean>;

async function isActiveOperation(scopeId: string, operationId: string): Promise<boolean> {
  const record = await readCtfRangePreparation(scopeId, operationId);
  return record !== null && !isTerminalCtfRangePreparation(record.lifecycleState);
}

/**
 * Record a failure of the current wallet, then keep the notices within the
 * limit. Only this tab's own record or dismissal runs the bound. A bound after
 * another tab's write would evict that tab's notices, the merge would bring
 * them back, and the two tabs would write to each other without end.
 */
export function recordOrderFailureNotice(
  notice: NewOrderFailureNotice,
  nowMs?: number,
): Promise<void> {
  useOrderFailureNotices.getState().record(notice, nowMs);
  return boundOrderFailureNotices(notice.scopeId);
}

/** Dismiss a failure of the current wallet, then keep the notices within the limit. */
export function dismissOrderFailureNotice(scopeId: string, operationId: string): Promise<void> {
  useOrderFailureNotices.getState().dismiss(scopeId, operationId);
  return boundOrderFailureNotices(scopeId);
}

async function boundOrderFailureNotices(
  scopeId: string,
  isActive: IsActiveOperation = isActiveOperation,
): Promise<void> {
  await markEndedOrderFailureNotices(scopeId, isActive);
  useOrderFailureNotices.getState().evictBeyondLimit(scopeId);
}

/**
 * Mark the notices of the current wallet whose journal operation ended. A
 * journal that cannot be read keeps its notice unmarked.
 */
export async function markEndedOrderFailureNotices(
  scopeId: string,
  isActive: IsActiveOperation,
): Promise<void> {
  const unchecked = Object.entries(useOrderFailureNotices.getState().notices).filter(
    ([, notice]) => notice.scopeId === scopeId && !notice.ended,
  );
  const ended: string[] = [];
  for (const [key, notice] of unchecked) {
    try {
      if (!(await isActive(notice.scopeId, notice.operationId))) ended.push(key);
    } catch {
      // The next check reads the journal again.
    }
  }
  useOrderFailureNotices.getState().markEnded(ended);
}

/** The union by key. A dismissal, an end mark and a specific reason win. */
function mergeNotices(
  current: Readonly<Record<string, OrderFailureNotice>>,
  stored: Readonly<Record<string, OrderFailureNotice>>,
): Record<string, OrderFailureNotice> {
  const merged: Record<string, OrderFailureNotice> = { ...stored };
  for (const [key, notice] of Object.entries(current)) {
    const other = merged[key];
    merged[key] =
      other === undefined
        ? notice
        : {
            ...notice,
            reason: isSpecificReason(notice.reason) ? notice.reason : other.reason,
            recordedAtMs: Math.min(notice.recordedAtMs, other.recordedAtMs),
            dismissed: notice.dismissed || other.dismissed,
            ended: notice.ended || other.ended,
          };
  }
  return merged;
}

// Another tab writes the same key. Read it again so that this tab does not
// write back an older state over that tab's notices or dismissals.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== ORDER_FAILURE_NOTICES_STORAGE_KEY && event.key !== null) return;
    void useOrderFailureNotices.persist.rehydrate();
  });
}

const NOTICE_KEYS = [
  "scopeId",
  "operationId",
  "orderId",
  "marketId",
  "reason",
  "recordedAtMs",
  "dismissed",
  "ended",
] as const;

/** Keep each stored notice with the exact known shape. Drop any other value. */
function decodeStoredNotices(persisted: unknown): Record<string, OrderFailureNotice> {
  const stored = isRecord(persisted) ? persisted.notices : undefined;
  if (!isRecord(stored)) return {};
  const notices: Record<string, OrderFailureNotice> = {};
  for (const [key, value] of Object.entries(stored)) {
    const notice = decodeStoredNotice(value);
    if (notice !== null && orderFailureNoticeKey(notice.scopeId, notice.operationId) === key)
      notices[key] = notice;
  }
  return notices;
}

function decodeStoredNotice(value: unknown): OrderFailureNotice | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== NOTICE_KEYS.length || !NOTICE_KEYS.every((key) => keys.includes(key)))
    return null;
  const { scopeId, operationId, orderId, marketId, reason, recordedAtMs, dismissed, ended } = value;
  if (
    !isText(scopeId) ||
    !isText(operationId) ||
    !isText(orderId) ||
    !isText(marketId) ||
    !Number.isSafeInteger(recordedAtMs) ||
    typeof dismissed !== "boolean" ||
    typeof ended !== "boolean"
  )
    return null;
  const knownReason = decodeStoredReason(reason);
  if (knownReason === null) return null;
  return {
    scopeId,
    operationId,
    orderId,
    marketId,
    reason: knownReason,
    recordedAtMs: recordedAtMs as number,
    dismissed,
    ended,
  };
}

function decodeStoredReason(value: unknown): OrderFailureReason | null {
  switch (value) {
    case "OwnOutputReused":
    case "GroupOutputReused":
    case "Unspecified":
      return value;
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
