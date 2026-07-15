import { create } from "zustand";
import { parseMarketBaseAsset } from "@bitcaster/client-sdk/marketUnits";
import { sameValue } from "./durable-custody-dexie-model";
import { currentGuiWalletId, db, ensureDurableSwapStorage } from "./proof-db";
import { withGuiWalletLock } from "./gui-wallet-lock";

export interface PendingTrade {
  orderId: string;
  marketId: string;
  clientOrderId: string;
  submittedAt: number;
  baseAsset: string;
  divisibility: number;
  side: "Buy" | "Sell";
  tokenSide: "Outcome" | "Complement";
  priceSubunits: number;
  amountSubunits: number;
  timeInForce: "FAK" | "FOK" | "GTC";
  recoveryAttempt?: number;
}

export type PendingTradeRecord = Omit<PendingTrade, "recoveryAttempt"> & {
  walletId: string;
  recoveryAttempt: number;
};

interface PendingTradeState {
  walletId: string | null;
  byOrderId: Record<string, PendingTradeRecord>;
}

export const usePendingTradesStore = create<PendingTradeState>()(() => ({
  walletId: null,
  byOrderId: {},
}));

export function clearGuiPendingTradeCache(): void {
  usePendingTradesStore.setState({ walletId: null, byOrderId: {} });
}

export function replaceGuiPendingTradeCache(
  walletId: string,
  records: readonly PendingTradeRecord[],
): void {
  if (currentGuiWalletId() !== walletId) {
    throw new Error("Pending trade cache belongs to another wallet scope");
  }
  const byOrderId = Object.fromEntries(
    records.map((record) => {
      const current = requirePendingTradeRecord(record, walletId);
      return [current.orderId, current];
    }),
  );
  usePendingTradesStore.setState({ walletId, byOrderId });
}

export function getCurrentGuiPendingTrade(
  orderId: string,
): PendingTradeRecord | undefined {
  const walletId = currentGuiWalletId();
  const state = usePendingTradesStore.getState();
  if (state.walletId !== walletId) return undefined;
  const record = state.byOrderId[orderId];
  return record ? requirePendingTradeRecord(record, walletId) : undefined;
}

export function getCurrentGuiPendingTrades(): PendingTradeRecord[] {
  const walletId = currentGuiWalletId();
  const state = usePendingTradesStore.getState();
  if (state.walletId !== walletId) return [];
  return Object.values(state.byOrderId).map((record) =>
    requirePendingTradeRecord(record, walletId),
  );
}

export function isCurrentGuiPendingTrade(record: PendingTradeRecord): boolean {
  try {
    return sameValue(getCurrentGuiPendingTrade(record.orderId), record);
  } catch {
    return false;
  }
}

export async function loadGuiPendingTrades(
  walletId = currentGuiWalletId(),
): Promise<PendingTradeRecord[]> {
  await ensureDurableSwapStorage(walletId);
  return (
    await db.pendingTrades.where("walletId").equals(walletId).toArray()
  ).map((record) => requirePendingTradeRecord(record, walletId));
}

export async function persistGuiPendingTrade(
  trade: PendingTrade,
): Promise<PendingTradeRecord> {
  const walletId = currentGuiWalletId();
  return withGuiWalletLock(walletId, currentGuiWalletId, async () => {
    await ensureDurableSwapStorage(walletId);
    const candidate = requirePendingTradeRecord(
      { ...trade, walletId, recoveryAttempt: trade.recoveryAttempt ?? 0 },
      walletId,
    );
    const key: [string, string] = [walletId, candidate.orderId];
    const committed = await db.transaction("rw", db.pendingTrades, async () => {
      const existing = await db.pendingTrades.get(key);
      if (!existing) {
        await db.pendingTrades.put(candidate);
        return candidate;
      }
      const current = requirePendingTradeRecord(existing, walletId);
      if (!sameValue(current, candidate)) {
        throw new Error("Pending trade conflicts with existing authority");
      }
      return current;
    });
    publishPendingTradeIfCurrent(committed);
    return committed;
  });
}

export async function removeGuiPendingTrade(
  expected: PendingTradeRecord,
): Promise<void> {
  const walletId = expected.walletId;
  await withGuiWalletLock(walletId, currentGuiWalletId, async () => {
    await ensureDurableSwapStorage(walletId);
    const key: [string, string] = [walletId, expected.orderId];
    await db.transaction("rw", db.pendingTrades, async () => {
      const existing = await db.pendingTrades.get(key);
      if (!existing) return;
      const current = requirePendingTradeRecord(existing, walletId);
      if (!sameValue(current, expected)) {
        throw new Error("Pending trade conflicts with existing authority");
      }
      await db.pendingTrades.delete(key);
    });
    const state = usePendingTradesStore.getState();
    if (state.walletId !== walletId) return;
    const byOrderId = { ...state.byOrderId };
    delete byOrderId[expected.orderId];
    usePendingTradesStore.setState({ walletId, byOrderId });
  });
}

function publishPendingTradeIfCurrent(record: PendingTradeRecord): void {
  if (currentGuiWalletId() !== record.walletId) return;
  const state = usePendingTradesStore.getState();
  const byOrderId = state.walletId === record.walletId ? state.byOrderId : {};
  usePendingTradesStore.setState({
    walletId: record.walletId,
    byOrderId: { ...byOrderId, [record.orderId]: record },
  });
}

function requirePendingTradeRecord(
  value: unknown,
  walletId: string,
): PendingTradeRecord {
  if (!isRecord(value) || !hasOnlyPendingTradeFields(value)) {
    throw new Error("Pending trade authority is invalid");
  }
  const record = value as Partial<PendingTradeRecord>;
  if (
    record.walletId !== walletId ||
    !/^[0-9a-f]{64}$/.test(walletId) ||
    !isNonEmptyString(record.orderId) ||
    !isNonEmptyString(record.marketId) ||
    !isNonEmptyString(record.clientOrderId) ||
    !isNonNegativeSafeInteger(record.submittedAt) ||
    parseMarketBaseAsset(record.baseAsset) !== record.baseAsset ||
    !isPositiveSafeInteger(record.divisibility) ||
    !isClosedValue(record.side, ["Buy", "Sell"]) ||
    !isClosedValue(record.tokenSide, ["Outcome", "Complement"]) ||
    !isPositiveSafeInteger(record.priceSubunits) ||
    !isPositiveSafeInteger(record.amountSubunits) ||
    !isClosedValue(record.timeInForce, ["FAK", "FOK", "GTC"]) ||
    !isNonNegativeSafeInteger(record.recoveryAttempt)
  ) {
    throw new Error("Pending trade authority is invalid");
  }
  return structuredClone(record as PendingTradeRecord);
}

export function decodeGuiPendingTradeRecord(
  value: unknown,
  walletId: string,
): PendingTradeRecord {
  return requirePendingTradeRecord(value, walletId);
}

const PENDING_TRADE_FIELDS = [
  "walletId",
  "orderId",
  "marketId",
  "clientOrderId",
  "submittedAt",
  "baseAsset",
  "divisibility",
  "side",
  "tokenSide",
  "priceSubunits",
  "amountSubunits",
  "timeInForce",
  "recoveryAttempt",
] as const;

function hasOnlyPendingTradeFields(value: Record<string, unknown>): boolean {
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const keys = Object.keys(value);
  if (
    keys.length !== PENDING_TRADE_FIELDS.length ||
    Object.getOwnPropertyNames(value).length !== keys.length
  ) {
    return false;
  }
  return PENDING_TRADE_FIELDS.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      descriptor !== undefined && descriptor.enumerable && "value" in descriptor
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isClosedValue<T extends string>(
  value: unknown,
  values: readonly T[],
): value is T {
  return values.includes(value as T);
}
