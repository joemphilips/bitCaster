import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { OrderSettlementFailureReason } from "@bitcaster/client-sdk/engineClient";
import { assertNever } from "@/lib/enumDiscipline";
import { readCtfRangeOrderFunds, walletDatabaseFor } from "@/lib/ctfRangeOrderFunds";
import type { BitcasterDB } from "@/stores/proof-db";

export const ORDER_FAILURE_NOTICES_STORAGE_KEY = "bitcaster-order-failures";

/**
 * Above this count, the oldest notices that are safe to drop are evicted. A
 * notice is safe to drop when its order settled, or when its funds are final
 * and the user dismissed it or it belongs to another wallet. A notice with an
 * active journal operation stays: the panel would record its failure again.
 * An undismissed failure of the current wallet stays until the user
 * dismisses it.
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
  /** The market title when the failure was recorded, or null when it was not known. */
  readonly marketTitle: string | null;
  /**
   * Where the reserved funds are: the refund is pending, it returned them,
   * the settlement completed after all, or the journal ended another way.
   * Each wallet has its own database, so only that wallet can settle this,
   * while it is current.
   */
  readonly funds: OrderFailureFunds;
}

/**
 * `settled` is a trade that completed after all. Its notice stays, so the
 * union with another tab cannot record the failure again, but nothing shows it.
 */
export type OrderFailureFunds = "pending" | "refunded" | "ended" | "settled";

export type NewOrderFailureNotice = Omit<
  OrderFailureNotice,
  "recordedAtMs" | "dismissed" | "funds"
>;

interface OrderFailureNoticeState {
  readonly notices: Readonly<Record<string, OrderFailureNotice>>;
  /**
   * Keep the first notice of an operation, so a later record cannot undo its
   * dismissal. A specific reason replaces the generic one.
   */
  record: (notice: NewOrderFailureNotice, nowMs?: number) => void;
  dismiss: (scopeId: string, operationId: string) => void;
  /** Settle the pending funds of these notices. A final state never changes. */
  settleFunds: (updates: Readonly<Record<string, FinalOrderFailureFunds>>) => void;
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
              [key]: { ...notice, recordedAtMs: nowMs, dismissed: false, funds: "pending" },
            },
          });
          return;
        }
        const reason =
          isSpecificReason(current.reason) || !isSpecificReason(notice.reason)
            ? current.reason
            : notice.reason;
        const marketTitle = current.marketTitle ?? notice.marketTitle;
        if (reason === current.reason && marketTitle === current.marketTitle) return;
        set({ notices: { ...notices, [key]: { ...current, reason, marketTitle } } });
      },
      dismiss: (scopeId, operationId) => {
        const { notices } = get();
        const key = orderFailureNoticeKey(scopeId, operationId);
        const notice = notices[key];
        if (notice === undefined || notice.dismissed) return;
        set({ notices: { ...notices, [key]: { ...notice, dismissed: true } } });
      },
      settleFunds: (updates) => {
        const { notices } = get();
        const settling = Object.entries(updates).filter(
          ([key]) => notices[key] !== undefined && !isFinalFunds(notices[key]!.funds),
        );
        if (settling.length === 0) return;
        const next = { ...notices };
        for (const [key, funds] of settling) next[key] = { ...next[key]!, funds };
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
  return (
    !showsOrderFailure(notice) ||
    (isFinalFunds(notice.funds) && (notice.dismissed || notice.scopeId !== currentScopeId))
  );
}

/** A notice shows a failure unless its settlement completed after all. */
export function showsOrderFailure(notice: OrderFailureNotice): boolean {
  switch (notice.funds) {
    case "pending":
    case "refunded":
    case "ended":
      return true;
    case "settled":
      return false;
    default:
      return assertNever(notice.funds);
  }
}

/** A final state of the funds never changes. */
export function isFinalFunds(funds: OrderFailureFunds): boolean {
  switch (funds) {
    case "pending":
      return false;
    case "refunded":
    case "ended":
    case "settled":
      return true;
    default:
      return assertNever(funds);
  }
}

export type FinalOrderFailureFunds = Exclude<OrderFailureFunds, "pending">;

type ReadOrderFailureFunds = (scopeId: string, operationId: string) => Promise<OrderFailureFunds>;

/**
 * A reader of this wallet's journal, or null when the active database
 * belongs to another wallet. The reader holds that database for every read,
 * so a wallet switch during a check cannot read the new wallet's database
 * with this wallet's scope; a read of the closed database fails instead.
 */
export function orderFailureFundsReader(scopeId: string): ReadOrderFailureFunds | null {
  const database = walletDatabaseFor(scopeId);
  return database === null
    ? null
    : (readScopeId, operationId) => readOrderFailureFunds(readScopeId, operationId, database);
}

async function readOrderFailureFunds(
  scopeId: string,
  operationId: string,
  database: BitcasterDB,
): Promise<OrderFailureFunds> {
  const funds = await readCtfRangeOrderFunds(scopeId, operationId, database);
  switch (funds.kind) {
    case "active":
      return "pending";
    case "refunded":
      return "refunded";
    case "settled":
      return "settled";
    case "ended":
      return "ended";
    default:
      return assertNever(funds);
  }
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

async function boundOrderFailureNotices(scopeId: string): Promise<void> {
  const read = orderFailureFundsReader(scopeId);
  if (read !== null) await observeOrderFailureFunds(scopeId, read);
  useOrderFailureNotices.getState().evictBeyondLimit(scopeId);
}

/** Settle the pending funds of the notices of the current wallet. */
export async function observeOrderFailureFunds(
  scopeId: string,
  read: ReadOrderFailureFunds,
): Promise<void> {
  const pending = Object.values(useOrderFailureNotices.getState().notices)
    .filter((notice) => notice.scopeId === scopeId && !isFinalFunds(notice.funds))
    .map((notice) => notice.operationId);
  useOrderFailureNotices
    .getState()
    .settleFunds(await readOrderFailureFundsObservations(scopeId, pending, read));
}

/**
 * The final funds observations of these operations of one wallet, by notice
 * key. A journal that cannot be read keeps its notice pending.
 */
export async function readOrderFailureFundsObservations(
  scopeId: string,
  operationIds: readonly string[],
  read: ReadOrderFailureFunds,
): Promise<Record<string, FinalOrderFailureFunds>> {
  const observations: Record<string, FinalOrderFailureFunds> = {};
  for (const operationId of operationIds) {
    try {
      const funds = await read(scopeId, operationId);
      switch (funds) {
        case "pending":
          break;
        case "refunded":
        case "ended":
        case "settled":
          observations[orderFailureNoticeKey(scopeId, operationId)] = funds;
          break;
        default:
          assertNever(funds);
      }
    } catch {
      // The next observation reads the journal again.
    }
  }
  return observations;
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
            funds: isFinalFunds(notice.funds) ? notice.funds : other.funds,
            marketTitle: notice.marketTitle ?? other.marketTitle,
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
  "marketTitle",
  "recordedAtMs",
  "dismissed",
  "funds",
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
  const {
    scopeId,
    operationId,
    orderId,
    marketId,
    marketTitle,
    reason,
    recordedAtMs,
    dismissed,
    funds,
  } = value;
  if (
    !isText(scopeId) ||
    !isText(operationId) ||
    !isText(orderId) ||
    !isText(marketId) ||
    !Number.isSafeInteger(recordedAtMs) ||
    typeof dismissed !== "boolean" ||
    (marketTitle !== null && !isText(marketTitle))
  )
    return null;
  const knownReason = decodeStoredReason(reason);
  const knownFunds = decodeStoredFunds(funds);
  if (knownReason === null || knownFunds === null) return null;
  return {
    scopeId,
    operationId,
    orderId,
    marketId,
    reason: knownReason,
    recordedAtMs: recordedAtMs as number,
    marketTitle,
    dismissed,
    funds: knownFunds,
  };
}

function decodeStoredFunds(value: unknown): OrderFailureFunds | null {
  switch (value) {
    case "pending":
    case "refunded":
    case "ended":
    case "settled":
      return value;
    default:
      return null;
  }
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
