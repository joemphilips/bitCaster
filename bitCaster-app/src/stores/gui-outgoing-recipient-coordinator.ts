import Dexie from "dexie";
import {
  advanceDurableOutgoingRecipientDeliveryOnce,
  type DurableOutgoingRecipientDeliveryTransport,
} from "@bitcaster/client-sdk/durableOutgoingRecipientDelivery";
import { sameValue } from "./durable-custody-dexie-model";
import { loadGuiDurableRecipientExactPayload } from "./gui-ordinary-wallet-operation";
import { finalizeGuiOutgoingRecipientCustodyHandoff } from "./gui-wallet-proof-operation-custody";
import {
  requireGuiOutgoingRecipientDeliveryRow,
  updateGuiOutgoingRecipientDeliveryRow,
  type GuiOutgoingRecipientDeliveryRow,
} from "./gui-outgoing-recipient-delivery";
import {
  currentGuiWalletId,
  db,
  ensureDurableSwapStorage,
} from "./proof-db";

const OUTGOING_RECIPIENT_PAGE_SIZE = 32;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

export type GuiOutgoingRecipientAdvanceResult =
  | { kind: "preparing"; row: GuiOutgoingRecipientDeliveryRow }
  | {
      kind: "pending" | "received" | "credited";
      row: GuiOutgoingRecipientDeliveryRow;
    };

export interface GuiOutgoingRecipientRecoveryPage {
  records: GuiOutgoingRecipientDeliveryRow[];
  hasMore: boolean;
  nextCursor: [nextAttemptAtMs: number, deliveryId: string] | null;
}

export async function advanceGuiOutgoingRecipientDeliveryOnce(input: {
  walletId: string;
  deliveryId: string;
  transport: DurableOutgoingRecipientDeliveryTransport;
  nowMs?: number;
}): Promise<GuiOutgoingRecipientAdvanceResult> {
  assertActiveWallet(input.walletId);
  await ensureDurableSwapStorage(input.walletId);
  const current = await requireStoredRow(input.walletId, input.deliveryId);
  if (current.delivery.kind === "prepared") {
    return { kind: "preparing", row: current };
  }
  if (current.delivery.record.delivery.state.kind === "credited") {
    await finalizeGuiOutgoingRecipientCustodyHandoff(
      input.walletId,
      input.deliveryId,
    );
    return { kind: "credited", row: current };
  }
  const nowMs = requireNow(input.nowMs ?? Date.now());
  let advanced: Awaited<
    ReturnType<typeof advanceDurableOutgoingRecipientDeliveryOnce>
  >;
  try {
    advanced = await advanceDurableOutgoingRecipientDeliveryOnce({
      record: current.delivery.record,
      exactPayloadStore: {
        loadExactPayload: async () =>
          loadGuiDurableRecipientExactPayload(
            input.walletId,
            current.operationId,
          ),
      },
      transport: input.transport,
    });
  } catch (error) {
    assertActiveWallet(input.walletId);
    await compareAndSwapRow(
      current,
      updateGuiOutgoingRecipientDeliveryRow({
        current,
        record: current.delivery.record,
        nowMs,
        nextAttemptAtMs: nowMs + retryDelayMs(current.attemptCount + 1),
        attemptCount: current.attemptCount + 1,
        lastError: "Recipient delivery is temporarily unavailable",
      }),
    );
    throw error;
  }
  assertActiveWallet(input.walletId);
  const next = updateGuiOutgoingRecipientDeliveryRow({
    current,
    record: advanced.record,
    nowMs,
    nextAttemptAtMs:
      nowMs + retryDelayMs(advanced.kind === "pending" ? current.attemptCount + 1 : 0),
    attemptCount:
      advanced.kind === "pending" ? current.attemptCount + 1 : 0,
    lastError: null,
  });
  const committed = await compareAndSwapRow(current, next);
  if (committed.delivery.kind !== "active") {
    throw new Error("GUI outgoing recipient regressed to preparation");
  }
  if (committed.delivery.record.delivery.state.kind === "credited") {
    await finalizeGuiOutgoingRecipientCustodyHandoff(
      input.walletId,
      input.deliveryId,
    );
  }
  return {
    kind: committed.delivery.record.delivery.state.kind,
    row: committed,
  };
}

export async function getGuiOutgoingRecipientDelivery(
  walletId: string,
  deliveryId: string,
): Promise<GuiOutgoingRecipientDeliveryRow | null> {
  assertActiveWallet(walletId);
  await ensureDurableSwapStorage(walletId);
  const row = await db.outgoingRecipientDeliveries.get([
    walletId,
    deliveryId,
  ]);
  return row
    ? requireGuiOutgoingRecipientDeliveryRow(
        row,
        walletId,
        deliveryId,
      )
    : null;
}

export async function listDueGuiOutgoingRecipientDeliveries(input: {
  walletId: string;
  nowMs?: number;
  cursor?: [nextAttemptAtMs: number, deliveryId: string] | null;
}): Promise<GuiOutgoingRecipientRecoveryPage> {
  assertActiveWallet(input.walletId);
  await ensureDurableSwapStorage(input.walletId);
  const nowMs = requireNow(input.nowMs ?? Date.now());
  const lower = input.cursor
    ? [input.walletId, 1, input.cursor[0], input.cursor[1]]
    : [input.walletId, 1, 0, Dexie.minKey];
  const rows = await db.outgoingRecipientDeliveries
    .where("[walletId+active+nextAttemptAtMs+deliveryId]")
    .between(
      lower,
      [input.walletId, 1, nowMs, Dexie.maxKey],
      input.cursor !== null && input.cursor !== undefined,
      true,
    )
    .limit(OUTGOING_RECIPIENT_PAGE_SIZE + 1)
    .toArray();
  const page = rows
    .slice(0, OUTGOING_RECIPIENT_PAGE_SIZE)
    .map((row) =>
      requireGuiOutgoingRecipientDeliveryRow(row, input.walletId),
    );
  const last = page.at(-1);
  return {
    records: page,
    hasMore: rows.length > OUTGOING_RECIPIENT_PAGE_SIZE,
    nextCursor: last ? [last.nextAttemptAtMs, last.deliveryId] : null,
  };
}

export async function getNextGuiOutgoingRecipientAttemptAt(
  walletId: string,
): Promise<number | null> {
  assertActiveWallet(walletId);
  await ensureDurableSwapStorage(walletId);
  const row = await db.outgoingRecipientDeliveries
    .where("[walletId+active+nextAttemptAtMs+deliveryId]")
    .between(
      [walletId, 1, 0, Dexie.minKey],
      [walletId, 1, Dexie.maxKey, Dexie.maxKey],
      true,
      true,
    )
    .first();
  return row
    ? requireGuiOutgoingRecipientDeliveryRow(row, walletId).nextAttemptAtMs
    : null;
}

export async function deferGuiOutgoingRecipientDelivery(input: {
  walletId: string;
  deliveryId: string;
  nowMs?: number;
}): Promise<GuiOutgoingRecipientDeliveryRow> {
  assertActiveWallet(input.walletId);
  const current = await requireStoredRow(input.walletId, input.deliveryId);
  if (current.active !== 1) return current;
  const nowMs = requireNow(input.nowMs ?? Date.now());
  return compareAndSwapRow(
    current,
    requireGuiOutgoingRecipientDeliveryRow({
      ...current,
      revision: current.revision + 1,
      nextAttemptAtMs:
        nowMs + retryDelayMs(current.attemptCount + 1),
      attemptCount: current.attemptCount + 1,
      lastError: "Recipient delivery is waiting for local recovery",
      updatedAtMs: Math.max(nowMs, current.updatedAtMs),
    }),
  );
}

async function requireStoredRow(
  walletId: string,
  deliveryId: string,
): Promise<GuiOutgoingRecipientDeliveryRow> {
  const row = await getGuiOutgoingRecipientDelivery(walletId, deliveryId);
  if (!row) throw new Error("GUI outgoing recipient delivery is missing");
  return row;
}

async function compareAndSwapRow(
  expected: GuiOutgoingRecipientDeliveryRow,
  next: GuiOutgoingRecipientDeliveryRow,
): Promise<GuiOutgoingRecipientDeliveryRow> {
  return db.transaction("rw", db.outgoingRecipientDeliveries, async () => {
    const raw = await db.outgoingRecipientDeliveries.get([
      expected.walletId,
      expected.deliveryId,
    ]);
    const current = requireGuiOutgoingRecipientDeliveryRow(
      raw,
      expected.walletId,
      expected.deliveryId,
      expected.operationId,
    );
    if (!sameValue(current, expected)) return current;
    if (
      next.revision !== expected.revision + 1 ||
      next.walletId !== expected.walletId ||
      next.deliveryId !== expected.deliveryId ||
      next.operationId !== expected.operationId
    ) {
      throw new Error("GUI outgoing recipient compare-and-swap is invalid");
    }
    await db.outgoingRecipientDeliveries.put(next);
    return next;
  });
}

function retryDelayMs(attemptCount: number): number {
  const exponent = Math.min(Math.max(attemptCount - 1, 0), 6);
  return Math.min(RETRY_BASE_MS * 2 ** exponent, RETRY_MAX_MS);
}

function requireNow(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("GUI outgoing recipient time is invalid");
  }
  return value;
}

function assertActiveWallet(walletId: string): void {
  if (currentGuiWalletId() !== walletId) {
    throw new Error("Active wallet seed changed during recipient delivery");
  }
}
