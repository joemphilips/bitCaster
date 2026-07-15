import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  createDurablePreTradeStorageAdmissionBatchPlan,
  createDurablePreTradeStorageReservationPlan,
} from "@bitcaster/client-sdk/durableStorageAdmission";
import {
  guiWalletContextForWallet,
  withGuiCustodyProfileLockForWallet,
} from "./gui-custody-authority";
import {
  commitGuiPreTradeStorageAdmissionInCurrentTransaction,
  guiDurableStorageAdmissionTables,
  initializeGuiDurableStorageAdmission,
  markGuiPreTradePubkeyAttemptInCurrentTransaction,
} from "./gui-durable-storage-admission-dexie";
import { createGuiPreTradeStorageCapacityProfile } from "./gui-durable-storage-admission-model";
import { createGuiDurableStorageRowArtifact } from "./gui-durable-storage-artifacts";
import { withGuiOriginStorageAdmissionLock } from "./gui-origin-storage-admission-lock";
import {
  createGuiPendingSwapIntentRecord,
  decodeGuiPendingSwapIntent,
  decodeGuiPendingSwapIntentRecord,
  type GuiPendingSwapIntent,
} from "./pending-swap-intent-db";
import {
  decodeGuiPendingTradeRecord,
  type PendingTradeRecord,
} from "./pendingTrades";
import {
  currentGuiWalletId,
  db,
  ensureDurableSwapStorage,
  type SwapIntentRecord,
} from "./proof-db";

export interface GuiPreTradeIntentRequest {
  tradeId: string;
  orderId: string;
  marketId: string;
  deadline: string;
  create: () => GuiPendingSwapIntent;
}

export async function getOrCreateAdmittedGuiPendingSwapIntents(
  requests: readonly GuiPreTradeIntentRequest[],
): Promise<GuiPendingSwapIntent[]> {
  const walletId = currentGuiWalletId();
  return withGuiCustodyProfileLockForWallet(
    walletId,
    async (_context, walletLock) => {
      await ensureDurableSwapStorage(walletId);
      return withGuiOriginStorageAdmissionLock(
        walletLock,
        currentGuiWalletId,
        async (originLock) => {
          await initializeGuiDurableStorageAdmission(originLock);
          const prepared = await prepareAdmission(requests, walletId);
          await commitPreparedAdmission(originLock, prepared);
          return prepared.records.map((record) =>
            decodeGuiPendingSwapIntent(record, walletId, record.tradeId),
          );
        },
      );
    },
  );
}

export async function submitAdmittedGuiPendingSwapIntents(
  requests: readonly GuiPreTradeIntentRequest[],
  submit: (intent: GuiPendingSwapIntent) => Promise<void>,
): Promise<GuiPendingSwapIntent[]> {
  const admitted = await getOrCreateAdmittedGuiPendingSwapIntents(requests);
  const submitted: GuiPendingSwapIntent[] = [];
  for (const intent of admitted) {
    if (!intent.submitted) {
      await submit(intent);
      submitted.push(
        await markAdmittedGuiPendingSwapIntentSubmitted(intent.tradeId),
      );
    } else {
      submitted.push(intent);
    }
  }
  return submitted;
}

export async function markAdmittedGuiPendingSwapIntentSubmitted(
  tradeId: string,
): Promise<GuiPendingSwapIntent> {
  const walletId = currentGuiWalletId();
  return withGuiCustodyProfileLockForWallet(
    walletId,
    async (_context, walletLock) => {
      await ensureDurableSwapStorage(walletId);
      return withGuiOriginStorageAdmissionLock(
        walletLock,
        currentGuiWalletId,
        async (originLock) => {
          await initializeGuiDurableStorageAdmission(originLock);
          return db.transaction(
            "rw",
            [...guiDurableStorageAdmissionTables(db), db.swapIntents],
            async () => {
              const current = decodeGuiPendingSwapIntentRecord(
                await db.swapIntents.get(tradeId),
                walletId,
                tradeId,
              );
              const next = current.submitted
                ? current
                : decodeGuiPendingSwapIntentRecord(
                    { ...current, submitted: true, updatedAt: Date.now() },
                    walletId,
                    tradeId,
                  );
              await markGuiPreTradePubkeyAttemptInCurrentTransaction({
                originLock,
                tradeId,
                expectedIntent: current,
                nextIntent: next,
              });
              return decodeGuiPendingSwapIntent(next, walletId, tradeId);
            },
          );
        },
      );
    },
  );
}

interface PreparedAdmission {
  walletId: string;
  pendingTrade: PendingTradeRecord;
  records: SwapIntentRecord[];
  existing: SwapIntentRecord[];
  missing: SwapIntentRecord[];
}

async function prepareAdmission(
  requests: readonly GuiPreTradeIntentRequest[],
  walletId: string,
): Promise<PreparedAdmission> {
  requireRequestBatch(requests);
  const first = requests[0]!;
  const pendingTrade = decodeGuiPendingTradeRecord(
    await db.pendingTrades.get([walletId, first.orderId]),
    walletId,
  );
  if (
    pendingTrade.orderId !== first.orderId ||
    pendingTrade.marketId !== first.marketId
  ) {
    throw new Error("GUI pre-trade request has no exact pending order");
  }
  const stored = await db.swapIntents.bulkGet(
    requests.map(({ tradeId }) => tradeId),
  );
  const records = requests.map((request, index) =>
    stored[index] === undefined
      ? createRequestedIntentRecord(request, walletId)
      : requireExistingIntent(request, stored[index], walletId),
  );
  return {
    walletId,
    pendingTrade,
    records,
    existing: records.filter((_, index) => stored[index] !== undefined),
    missing: records.filter((_, index) => stored[index] === undefined),
  };
}

async function commitPreparedAdmission(
  originLock: Parameters<
    typeof commitGuiPreTradeStorageAdmissionInCurrentTransaction
  >[0]["originLock"],
  prepared: PreparedAdmission,
): Promise<void> {
  const groups = [prepared.existing, prepared.missing].filter(
    (records) => records.length > 0,
  );
  await db.transaction(
    "rw",
    [...guiDurableStorageAdmissionTables(db), db.pendingTrades, db.swapIntents],
    async () => {
      for (const records of groups) {
        await commitGuiPreTradeStorageAdmissionInCurrentTransaction({
          originLock,
          batch: createAdmissionBatch(prepared, records),
          pendingTradeKey: [prepared.walletId, prepared.pendingTrade.orderId],
          expectedPendingTrade: prepared.pendingTrade,
          intents: records,
        });
      }
    },
  );
}

function createAdmissionBatch(
  prepared: PreparedAdmission,
  records: SwapIntentRecord[],
) {
  const scopeId = guiWalletContextForWallet(prepared.walletId).scope.scopeId;
  const profile = createGuiPreTradeStorageCapacityProfile();
  const reservations = records.map((record) =>
    createDurablePreTradeStorageReservationPlan({
      scopeId,
      reservationId: record.tradeId,
      swapId: record.tradeId,
      orderId: record.intent.orderId,
      marketId: record.intent.marketId,
      deadlineMs: requireDeadline(record.intent.deadline),
      intent: intentArtifact(record),
      capacityProfile: profile,
    }),
  );
  return createDurablePreTradeStorageAdmissionBatchPlan({
    batchId: admissionBatchId(prepared.pendingTrade.orderId, records),
    reservations,
    transactionOnlyArtifacts: [pendingTradeArtifact(prepared)],
  });
}

function pendingTradeArtifact(prepared: PreparedAdmission) {
  return createGuiDurableStorageRowArtifact({
    table: "pendingTrades",
    key: [prepared.walletId, prepared.pendingTrade.orderId],
    artifactRole: "transaction-only-retained",
    row: prepared.pendingTrade,
  });
}

function requireRequestBatch(
  requests: readonly GuiPreTradeIntentRequest[],
): void {
  if (requests.length === 0) {
    throw new Error("GUI pre-trade request batch size is invalid");
  }
  const first = requests[0]!;
  const tradeIds = new Set<string>();
  for (const request of requests) {
    if (
      request.orderId !== first.orderId ||
      request.marketId !== first.marketId ||
      tradeIds.has(request.tradeId)
    ) {
      throw new Error("GUI pre-trade request batch identity is invalid");
    }
    tradeIds.add(request.tradeId);
  }
}

function createRequestedIntentRecord(
  request: GuiPreTradeIntentRequest,
  walletId: string,
): SwapIntentRecord {
  const created = request.create();
  if (
    created.tradeId !== request.tradeId ||
    created.orderId !== request.orderId ||
    created.marketId !== request.marketId ||
    created.deadline !== request.deadline ||
    created.submitted
  ) {
    throw new Error("GUI pre-trade intent creation returned a foreign binding");
  }
  return createGuiPendingSwapIntentRecord(created, walletId, Date.now());
}

function requireExistingIntent(
  request: GuiPreTradeIntentRequest,
  value: unknown,
  walletId: string,
): SwapIntentRecord {
  const record = decodeGuiPendingSwapIntentRecord(
    value,
    walletId,
    request.tradeId,
  );
  if (
    record.intent.orderId !== request.orderId ||
    record.intent.marketId !== request.marketId ||
    record.intent.deadline !== request.deadline
  ) {
    throw new Error("GUI pre-trade intent conflicts with the requested match");
  }
  return record;
}

function intentArtifact(record: SwapIntentRecord) {
  return createGuiDurableStorageRowArtifact({
    table: "swapIntents",
    key: record.tradeId,
    artifactRole: "trade-intent",
    row: record,
  });
}

function requireDeadline(value: string): number {
  const deadline = Date.parse(value);
  if (!Number.isSafeInteger(deadline) || deadline <= 0) {
    throw new Error("GUI pre-trade deadline is invalid");
  }
  return deadline;
}

function admissionBatchId(
  orderId: string,
  records: readonly SwapIntentRecord[],
): string {
  const identity = `${orderId}:${records
    .map(({ tradeId }) => tradeId)
    .sort()
    .join(":")}`;
  return `gui-pretrade-${bytesToHex(sha256(new TextEncoder().encode(identity)))}`;
}
