import Dexie from "dexie";
import {
  advanceDurablePreTradePubkeyAttempt,
  applyDurablePreTradeStorageAdmissionBatch,
  createDurableStorageAccountingState,
  reduceDurableStorageAccountingState,
  type DurableStorageAccountingState,
  type DurablePreTradeStorageAdmissionBatchPlan,
} from "@bitcaster/client-sdk/durableStorageAdmission";
import {
  assertGuiPreTradeStorageCapacityProfile,
  decodeDurableStorageAccountingRow,
  decodeDurableStorageHeadroomRow,
  durableStorageAccountingRow,
  createDurableStorageHeadroomRow,
  GUI_DURABLE_STORAGE_ACCOUNTING_LIMIT_BYTES,
  GUI_DURABLE_STORAGE_HEADROOM_RECORD_ID,
} from "./gui-durable-storage-admission-model";
import { createGuiDurableStorageRowArtifact } from "./gui-durable-storage-artifacts";
import { guiWalletContextForWallet } from "./gui-custody-authority";
import {
  walletIdFromHeldGuiOriginStorageAdmissionLock,
  type GuiOriginStorageAdmissionLockContext,
} from "./gui-origin-storage-admission-lock";
import { db, type BitcasterDB } from "./proof-db";
import type { SwapIntentRecord } from "./proof-db";
import {
  decodeGuiPendingTradeRecord,
  type PendingTradeRecord,
} from "./pendingTrades";
import { decodeGuiPendingSwapIntentRecord } from "./pending-swap-intent-db";

export async function initializeGuiDurableStorageAdmission(
  originLock: GuiOriginStorageAdmissionLockContext,
  database: BitcasterDB = db,
): Promise<DurableStorageAccountingState> {
  walletIdFromHeldGuiOriginStorageAdmissionLock(originLock);
  return database.transaction(
    "rw",
    [
      database.durableStorageAccounting,
      database.durableStorageHeadroom,
      database.proofOperations,
      database.custodyOperations,
      database.custodySessionLinks,
      database.custodyProofReservations,
      database.swapSessions,
      database.swapIntents,
    ],
    async () => initializeInCurrentTransaction(database),
  );
}

export async function commitGuiPreTradeStorageAdmissionInCurrentTransaction(input: {
  originLock: GuiOriginStorageAdmissionLockContext;
  batch: DurablePreTradeStorageAdmissionBatchPlan;
  pendingTradeKey: readonly [string, string];
  expectedPendingTrade: PendingTradeRecord;
  intents: readonly SwapIntentRecord[];
  database?: BitcasterDB;
}): Promise<DurableStorageAccountingState> {
  const walletId = walletIdFromHeldGuiOriginStorageAdmissionLock(
    input.originLock,
  );
  if (
    input.batch.scopeId !== guiWalletContextForWallet(walletId).scope.scopeId
  ) {
    throw new Error("GUI durable storage admission scope is foreign");
  }
  const database = input.database ?? db;
  requireCurrentWriteTransaction(database);
  const state = await readReadyAccounting(database);
  requireCurrentWriteTransaction(database);
  if (
    walletIdFromHeldGuiOriginStorageAdmissionLock(input.originLock) !== walletId
  ) {
    throw new Error("GUI durable storage admission wallet ownership changed");
  }
  const pendingTrade = await readExactPendingTrade(
    database,
    walletId,
    input.pendingTradeKey,
    input.expectedPendingTrade,
  );
  requireCurrentWriteTransaction(database);
  const intents = decodePreTradeIntents(
    input.intents,
    walletId,
    pendingTrade,
    input.batch,
  );
  walletIdFromHeldGuiOriginStorageAdmissionLock(input.originLock);
  const artifacts = [
    ...intents.map((row) =>
      createGuiDurableStorageRowArtifact({
        table: "swapIntents",
        key: row.tradeId,
        artifactRole: "trade-intent",
        row,
      }),
    ),
    createGuiDurableStorageRowArtifact({
      table: "pendingTrades",
      key: input.pendingTradeKey,
      artifactRole: "transaction-only-retained",
      row: pendingTrade,
    }),
  ];
  const next = applyDurablePreTradeStorageAdmissionBatch({
    state,
    batch: input.batch,
    artifacts,
  });
  const exactReplay = next.revision === state.revision;
  walletIdFromHeldGuiOriginStorageAdmissionLock(input.originLock);
  for (const intent of intents) {
    const current = await database.swapIntents.get(intent.tradeId);
    requireCurrentWriteTransaction(database);
    if (current === undefined) {
      if (exactReplay) {
        throw new Error("GUI pre-trade admission replay is physically partial");
      }
      continue;
    }
    const decoded = decodeGuiPendingSwapIntentRecord(
      current,
      walletId,
      intent.tradeId,
    );
    if (!sameArtifactRow("swapIntents", intent.tradeId, decoded, intent)) {
      throw new Error("GUI pre-trade intent conflicts with existing authority");
    }
    if (!exactReplay) {
      throw new Error("GUI pre-trade intent has no accounting authority");
    }
  }
  requireCurrentWriteTransaction(database);
  walletIdFromHeldGuiOriginStorageAdmissionLock(input.originLock);
  if (exactReplay) return state;
  await database.swapIntents.bulkPut(intents);
  requireCurrentWriteTransaction(database);
  await database.durableStorageAccounting.put(
    durableStorageAccountingRow(next),
  );
  requireCurrentWriteTransaction(database);
  walletIdFromHeldGuiOriginStorageAdmissionLock(input.originLock);
  return next;
}

export async function markGuiPreTradePubkeyAttemptInCurrentTransaction(input: {
  originLock: GuiOriginStorageAdmissionLockContext;
  tradeId: string;
  expectedIntent: SwapIntentRecord;
  nextIntent: SwapIntentRecord;
  database?: BitcasterDB;
}): Promise<DurableStorageAccountingState> {
  const walletId = walletIdFromHeldGuiOriginStorageAdmissionLock(
    input.originLock,
  );
  const scopeId = guiWalletContextForWallet(walletId).scope.scopeId;
  const database = input.database ?? db;
  requireCurrentWriteTransaction(database);
  const state = await readReadyAccounting(database);
  requireCurrentWriteTransaction(database);
  const currentValue = await database.swapIntents.get(input.tradeId);
  requireCurrentWriteTransaction(database);
  if (currentValue === undefined) {
    throw new Error("GUI pre-trade intent is missing");
  }
  const current = decodeGuiPendingSwapIntentRecord(
    currentValue,
    walletId,
    input.tradeId,
  );
  const expected = decodeGuiPendingSwapIntentRecord(
    input.expectedIntent,
    walletId,
    input.tradeId,
  );
  const nextIntent = decodeGuiPendingSwapIntentRecord(
    input.nextIntent,
    walletId,
    input.tradeId,
  );
  if (!sameArtifactRow("swapIntents", input.tradeId, current, expected)) {
    throw new Error("GUI pre-trade intent changed before pubkey attempt");
  }
  requirePubkeyAttemptTransition(current, nextIntent);
  const reservation = state.preTradeReservations.find(
    (item) => item.scopeId === scopeId && item.swapId === input.tradeId,
  );
  if (!reservation) {
    throw new Error("GUI pre-trade storage reservation is missing");
  }
  walletIdFromHeldGuiOriginStorageAdmissionLock(input.originLock);
  requireCurrentWriteTransaction(database);
  const next = advanceDurablePreTradePubkeyAttempt({
    state,
    scopeId,
    reservationId: reservation.reservationId,
    previousIntent: createIntentArtifact(current),
    nextIntent: createIntentArtifact(nextIntent),
  });
  walletIdFromHeldGuiOriginStorageAdmissionLock(input.originLock);
  requireCurrentWriteTransaction(database);
  await database.swapIntents.put(nextIntent);
  requireCurrentWriteTransaction(database);
  if (next.revision !== state.revision) {
    await database.durableStorageAccounting.put(
      durableStorageAccountingRow(next),
    );
    requireCurrentWriteTransaction(database);
  }
  walletIdFromHeldGuiOriginStorageAdmissionLock(input.originLock);
  return next;
}

function readExactPendingTrade(
  database: BitcasterDB,
  walletId: string,
  key: readonly [string, string],
  expectedValue: unknown,
): Promise<PendingTradeRecord> {
  if (key[0] !== walletId) {
    throw new Error("GUI pending trade key belongs to another wallet");
  }
  const expected = decodeGuiPendingTradeRecord(expectedValue, walletId);
  if (key[1] !== expected.orderId) {
    throw new Error("GUI pending trade key is invalid");
  }
  return database.pendingTrades.get([key[0], key[1]]).then((storedValue) => {
    if (storedValue === undefined) {
      throw new Error(
        "GUI pre-trade admission requires an existing pending trade",
      );
    }
    const stored = decodeGuiPendingTradeRecord(storedValue, walletId);
    if (!sameArtifactRow("pendingTrades", key, expected, stored)) {
      throw new Error("GUI pending trade changed before pre-trade admission");
    }
    return stored;
  });
}

function decodePreTradeIntents(
  values: readonly SwapIntentRecord[],
  walletId: string,
  pendingTrade: PendingTradeRecord,
  batch: DurablePreTradeStorageAdmissionBatchPlan,
): SwapIntentRecord[] {
  if (values.length === 0 || values.length !== batch.reservations.length) {
    throw new Error("GUI pre-trade admission intent count is invalid");
  }
  const seen = new Set<string>();
  return values.map((value) => {
    const row = decodeGuiPendingSwapIntentRecord(
      value,
      walletId,
      value.tradeId,
    );
    if (seen.has(row.tradeId)) {
      throw new Error("GUI pre-trade admission has a duplicate intent");
    }
    seen.add(row.tradeId);
    if (
      row.intent.orderId !== pendingTrade.orderId ||
      row.intent.marketId !== pendingTrade.marketId
    ) {
      throw new Error("GUI pre-trade intent belongs to another order");
    }
    const reservation = batch.reservations.find(
      (item) => item.swapId === row.tradeId,
    );
    const deadlineMs = Date.parse(row.intent.deadline);
    if (
      !reservation ||
      reservation.scopeId !== batch.scopeId ||
      reservation.orderId !== row.intent.orderId ||
      reservation.marketId !== row.intent.marketId ||
      !Number.isSafeInteger(deadlineMs) ||
      reservation.deadlineMs !== deadlineMs
    ) {
      throw new Error("GUI pre-trade reservation identity is invalid");
    }
    assertGuiPreTradeStorageCapacityProfile(reservation.capacityProfile);
    return row;
  });
}

function sameArtifactRow(
  table: "swapIntents" | "pendingTrades",
  key: string | readonly [string, string],
  left: unknown,
  right: unknown,
): boolean {
  const artifactRole =
    table === "swapIntents" ? "trade-intent" : "transaction-only-retained";
  return (
    createGuiDurableStorageRowArtifact({
      table,
      key,
      artifactRole,
      row: left,
    }).encodedJson ===
    createGuiDurableStorageRowArtifact({
      table,
      key,
      artifactRole,
      row: right,
    }).encodedJson
  );
}

function createIntentArtifact(row: SwapIntentRecord) {
  return createGuiDurableStorageRowArtifact({
    table: "swapIntents",
    key: row.tradeId,
    artifactRole: "trade-intent",
    row,
  });
}

function requirePubkeyAttemptTransition(
  current: SwapIntentRecord,
  next: SwapIntentRecord,
): void {
  if (current.submitted) {
    if (!sameArtifactRow("swapIntents", current.tradeId, current, next)) {
      throw new Error("GUI attempted pubkey intent cannot change");
    }
    return;
  }
  const normalized = {
    ...next,
    submitted: current.submitted,
    updatedAt: current.updatedAt,
  };
  if (
    !next.submitted ||
    next.updatedAt < current.updatedAt ||
    !sameArtifactRow("swapIntents", current.tradeId, current, normalized)
  ) {
    throw new Error("GUI pubkey attempt transition is invalid");
  }
}

export async function releaseGuiDurableStorageHeadroomInCurrentTransaction(
  originLock: GuiOriginStorageAdmissionLockContext,
  database: BitcasterDB = db,
): Promise<DurableStorageAccountingState> {
  walletIdFromHeldGuiOriginStorageAdmissionLock(originLock);
  requireCurrentWriteTransaction(database);
  const state = await readStoredAccounting(database);
  requireCurrentWriteTransaction(database);
  if (state.emergencyHeadroom.state !== "ready") {
    throw new Error(
      "GUI durable storage emergency headroom is already released",
    );
  }
  const next = reduceDurableStorageAccountingState(state, {
    kind: "release-emergency-headroom",
    expectedRevision: state.revision,
    reason: "quota-recovery",
  });
  walletIdFromHeldGuiOriginStorageAdmissionLock(originLock);
  await database.durableStorageHeadroom.delete(
    GUI_DURABLE_STORAGE_HEADROOM_RECORD_ID,
  );
  requireCurrentWriteTransaction(database);
  walletIdFromHeldGuiOriginStorageAdmissionLock(originLock);
  await database.durableStorageAccounting.put(
    durableStorageAccountingRow(next),
  );
  requireCurrentWriteTransaction(database);
  walletIdFromHeldGuiOriginStorageAdmissionLock(originLock);
  return next;
}

export async function restoreGuiDurableStorageHeadroomInCurrentTransaction(
  originLock: GuiOriginStorageAdmissionLockContext,
  database: BitcasterDB = db,
): Promise<DurableStorageAccountingState> {
  walletIdFromHeldGuiOriginStorageAdmissionLock(originLock);
  requireCurrentWriteTransaction(database);
  const state = await readStoredAccounting(database);
  requireCurrentWriteTransaction(database);
  if (state.emergencyHeadroom.state !== "released-for-maintenance") {
    throw new Error("GUI durable storage emergency headroom is already ready");
  }
  const next = reduceDurableStorageAccountingState(state, {
    kind: "restore-emergency-headroom",
    expectedRevision: state.revision,
  });
  walletIdFromHeldGuiOriginStorageAdmissionLock(originLock);
  await database.durableStorageHeadroom.add(createDurableStorageHeadroomRow());
  requireCurrentWriteTransaction(database);
  walletIdFromHeldGuiOriginStorageAdmissionLock(originLock);
  await database.durableStorageAccounting.put(
    durableStorageAccountingRow(next),
  );
  requireCurrentWriteTransaction(database);
  walletIdFromHeldGuiOriginStorageAdmissionLock(originLock);
  return next;
}

export function guiDurableStorageAdmissionTables(database: BitcasterDB) {
  return [
    database.durableStorageAccounting,
    database.durableStorageHeadroom,
  ] as const;
}

async function initializeInCurrentTransaction(
  database: BitcasterDB,
): Promise<DurableStorageAccountingState> {
  const accountingRows = await database.durableStorageAccounting
    .limit(2)
    .toArray();
  requireCurrentWriteTransaction(database);
  const headroomRows = await database.durableStorageHeadroom.limit(2).toArray();
  requireCurrentWriteTransaction(database);
  if (accountingRows.length > 1 || headroomRows.length > 1) {
    throw new Error("GUI durable storage singleton rows are corrupt");
  }
  if (accountingRows.length === 1) {
    return validateStoredAdmissionRows(accountingRows[0], headroomRows[0]);
  }
  if (headroomRows.length !== 0) {
    throw new Error("GUI durable storage headroom has no accounting authority");
  }
  await assertNoUnaccountedCustody(database);
  requireCurrentWriteTransaction(database);
  const state = createDurableStorageAccountingState({
    accountingLimitBytes: GUI_DURABLE_STORAGE_ACCOUNTING_LIMIT_BYTES,
  });
  await database.durableStorageAccounting.add(
    durableStorageAccountingRow(state),
  );
  requireCurrentWriteTransaction(database);
  await database.durableStorageHeadroom.add(createDurableStorageHeadroomRow());
  requireCurrentWriteTransaction(database);
  return state;
}

function readReadyAccounting(
  database: BitcasterDB,
): Promise<DurableStorageAccountingState> {
  return readStoredAccounting(database).then((state) => {
    if (state.emergencyHeadroom.state !== "ready") {
      throw new Error("GUI durable storage emergency headroom is unavailable");
    }
    return state;
  });
}

function readStoredAccounting(
  database: BitcasterDB,
): Promise<DurableStorageAccountingState> {
  return Dexie.Promise.all([
    database.durableStorageAccounting.limit(2).toArray(),
    database.durableStorageHeadroom.limit(2).toArray(),
  ]).then(([accountingRows, headroomRows]) => {
    if (accountingRows.length !== 1 || headroomRows.length > 1) {
      throw new Error("GUI durable storage singleton rows are corrupt");
    }
    return validateStoredAdmissionRows(accountingRows[0], headroomRows[0]);
  });
}

function validateStoredAdmissionRows(
  accountingValue: unknown,
  headroomValue: unknown,
): DurableStorageAccountingState {
  if (accountingValue === undefined) {
    throw new Error("GUI durable storage accounting row is missing");
  }
  const accounting = decodeDurableStorageAccountingRow(accountingValue);
  if (accounting.state.emergencyHeadroom.state === "ready") {
    if (headroomValue === undefined) {
      throw new Error("GUI durable storage emergency headroom is missing");
    }
    decodeDurableStorageHeadroomRow(headroomValue);
  } else if (headroomValue !== undefined) {
    throw new Error("GUI durable storage released headroom still exists");
  }
  return accounting.state;
}

function assertNoUnaccountedCustody(database: BitcasterDB): Promise<void> {
  return Dexie.Promise.all([
    database.proofOperations.limit(1).count(),
    database.custodyOperations.limit(1).count(),
    database.custodySessionLinks.limit(1).count(),
    database.custodyProofReservations.limit(1).count(),
    database.swapSessions.limit(1).count(),
    database.swapIntents.limit(1).count(),
  ]).then((counts) => {
    if (counts.some((count) => count !== 0)) {
      throw new Error(
        "GUI durable storage accounting cannot adopt existing custody",
      );
    }
  });
}

function requireCurrentWriteTransaction(database: BitcasterDB): void {
  const transaction = Dexie.currentTransaction;
  if (
    !transaction ||
    transaction.db !== database ||
    transaction.mode !== "readwrite"
  ) {
    throw new Error(
      "GUI durable storage admission requires the active Dexie write transaction",
    );
  }
}
