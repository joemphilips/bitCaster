import Dexie from "dexie";
import type { Proof } from "@cashu/cashu-ts";
import {
  reconcileDurableBearerSpendDelivery,
  type DurableBearerSpendDeliveryRecord,
  type DurableBearerSpendProofStateChecker,
} from "@bitcaster/client-sdk/durableBearerSpendDelivery";
import { useWalletStore } from "./wallet";
import {
  sameValue,
  decodeOperationRow,
  type DexieCustodyOperationRow,
} from "./durable-custody-dexie-model";
import {
  currentGuiWalletContext,
  guiWalletContextForWallet,
  withGuiCustodyProfileLockForWallet,
} from "./gui-custody-authority";
import {
  createGuiBearerSpendDeliveryRow,
  requireGuiBearerSpendDeliveryRow,
  requireGuiBearerSpendDeliveryRowWithinByteBound,
  type GuiBearerSpendDeliveryRow,
} from "./gui-bearer-spend-delivery";
import { requireGuiDexieWriteTransaction } from "./gui-dexie-transaction";
import {
  readGuiWalletSendDeliveryMetadata,
  requireGuiWalletSendDeliveryPayloadRow,
  type GuiWalletSendDeliveryPayloadRow,
} from "./gui-wallet-send-delivery";
import { requireGuiWalletSendBearerAuthority } from "./gui-wallet-proof-operation-custody";
import { tryWithGuiWalletBearerRecoveryLock } from "./gui-wallet-lock";
import {
  currentGuiWalletId,
  db,
  ensureDurableSwapStorage,
  proofOperationPrimaryKey,
  requireProofOperationRecord,
  type ProofOperationRecord,
} from "./proof-db";

export type GuiBearerSpendRecoveryStatus = "clear" | "pending" | "blocked";

const RECOVERY_PAGE_SIZE = 8;
const RECOVERY_CYCLE_PROOF_LIMIT = 256;
const RECOVERY_CYCLE_MINT_REQUEST_LIMIT = 2;
const RECOVERY_MINT_TIMEOUT_MS = 10_000;
const RECOVERY_RESPONSE_BYTES_LIMIT = 256 * 1_024;
const RECOVERY_CONTINUATION_DELAY_MS = 1_000;
const RECOVERY_LOCAL_FAILURE_RETRY_MS = 5_000;
const RECOVERY_TIMER_MAX_MS = 2_147_483_647;
const WALLET_SEND_PAYLOAD_HANDLE_PREFIX = "wallet-send:";

type BearerDueCursor = [
  walletId: string,
  active: 1,
  nextAttemptAtMs: number,
  deliveryId: string,
];

interface RawBearerSpendSnapshot {
  kind: "snapshot";
  lookup: BearerLookup;
  row: unknown;
  operation: unknown;
  payload: unknown;
  custody: unknown;
}

interface InvalidRawBearerSpendSnapshot {
  kind: "invalid";
  cursor: BearerDueCursor;
}

type RawBearerSpendCandidate =
  | RawBearerSpendSnapshot
  | InvalidRawBearerSpendSnapshot;

interface BearerLookup {
  walletId: string;
  deliveryId: string;
  operationId: string;
  parentOperationId: string;
  cursor: BearerDueCursor;
}

interface GuiBearerSpendSnapshot {
  raw: RawBearerSpendSnapshot;
  row: GuiBearerSpendDeliveryRow;
  operation: ProofOperationRecord;
  payload: GuiWalletSendDeliveryPayloadRow | undefined;
  custody: ReturnType<typeof decodeOperationRow>;
}

interface DueBearerPage {
  snapshots: GuiBearerSpendSnapshot[];
  blocked: boolean;
  continuation: boolean;
}

interface GuiBearerSpendRecoveryCycle {
  status: GuiBearerSpendRecoveryStatus;
  nextAttemptAtMs: number | null;
}

interface BearerMintBatchItem {
  snapshot: GuiBearerSpendSnapshot;
  proofs: Array<Pick<Proof, "id" | "secret">>;
}

interface BearerMintBatch {
  mintUrl: string;
  unit: string;
  items: BearerMintBatchItem[];
  proofCount: number;
}

type MintBatchEvidence =
  | { kind: "states"; states: unknown[] }
  | { kind: "invalid" }
  | { kind: "unavailable" };

interface BearerRecoveryTimer {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(timer: unknown): void;
}

interface ScheduledBearerRecovery {
  walletId: string;
  timer: unknown;
}

class GuiBearerSpendAuthorityChanged extends Error {}

const activeRecoveryByWallet = new Map<
  string,
  Promise<GuiBearerSpendRecoveryStatus>
>();
const dueCursorByWallet = new Map<string, BearerDueCursor>();
let scheduledRecovery: ScheduledBearerRecovery | null = null;
let recoveryTimer: BearerRecoveryTimer = defaultRecoveryTimer();
let mintTimeoutTimer: BearerRecoveryTimer = defaultRecoveryTimer();

/** Coalesces startup, visibility, online, and wallet-activity triggers. */
export function requestGuiBearerSpendRecovery(): Promise<GuiBearerSpendRecoveryStatus> {
  const walletId = currentGuiWalletContext().walletId;
  const active = activeRecoveryByWallet.get(walletId);
  if (active) return active;
  const recovery = recoverGuiBearerSpendsForWallet(walletId)
    .catch(() => blockedCycle(Date.now() + RECOVERY_LOCAL_FAILURE_RETRY_MS))
    .then((cycle) => {
      scheduleRecoveryWake(walletId, cycle.nextAttemptAtMs);
      return cycle.status;
    })
    .finally(() => {
      if (activeRecoveryByWallet.get(walletId) === recovery) {
        activeRecoveryByWallet.delete(walletId);
      }
    });
  activeRecoveryByWallet.set(walletId, recovery);
  return recovery;
}

export function __resetGuiBearerSpendRecoveryForTests(): void {
  clearRecoveryWake();
  activeRecoveryByWallet.clear();
  dueCursorByWallet.clear();
  recoveryTimer = defaultRecoveryTimer();
  mintTimeoutTimer = defaultRecoveryTimer();
}

export function __setGuiBearerSpendRecoveryTimerForTests(
  timer: BearerRecoveryTimer,
): void {
  clearRecoveryWake();
  recoveryTimer = timer;
}

export function __setGuiBearerSpendRecoveryMintTimeoutForTests(
  timer: BearerRecoveryTimer,
): void {
  mintTimeoutTimer = timer;
}

export function __scheduleGuiBearerSpendRecoveryWakeForTests(
  walletId: string,
  nextAttemptAtMs: number | null,
): void {
  scheduleRecoveryWake(walletId, nextAttemptAtMs);
}

async function recoverGuiBearerSpendsForWallet(
  walletId: string,
): Promise<GuiBearerSpendRecoveryCycle> {
  await ensureDurableSwapStorage(walletId);
  const attempt = await tryWithGuiWalletBearerRecoveryLock(
    walletId,
    currentGuiWalletId,
    () => recoverOwnedBearerSpends(walletId),
  );
  return attempt.acquired
    ? attempt.value
    : pendingCycle(Date.now() + RECOVERY_CONTINUATION_DELAY_MS);
}

async function recoverOwnedBearerSpends(
  walletId: string,
): Promise<GuiBearerSpendRecoveryCycle> {
  const page = await readDueBearerPage(walletId, Date.now());
  const reconciled = await reconcileBearerSnapshots(walletId, page.snapshots);
  let blocked = page.blocked;
  for (const item of reconciled) {
    try {
      await commitBearerReconciliation(item.snapshot, item.next);
    } catch (error) {
      if (!(error instanceof GuiBearerSpendAuthorityChanged)) blocked = true;
    }
  }
  const nextAttemptAtMs = await readNextBearerAttempt(
    walletId,
    page.continuation,
    blocked,
  );
  if (blocked) {
    return blockedCycle(
      nextAttemptAtMs ?? Date.now() + RECOVERY_LOCAL_FAILURE_RETRY_MS,
    );
  }
  return nextAttemptAtMs === null
    ? clearCycle()
    : pendingCycle(nextAttemptAtMs);
}

async function readDueBearerPage(
  walletId: string,
  nowMs: number,
): Promise<DueBearerPage> {
  const cursor = dueCursorByWallet.get(walletId) ?? null;
  const rawPage = await readRawDueBearerPage(walletId, nowMs, cursor);
  const selected = selectValidatedBearerBudget(rawPage, walletId);
  updateDueCursor(
    walletId,
    selected.deferred || rawPage.length === RECOVERY_PAGE_SIZE,
    selected.processedCursor,
  );
  return {
    snapshots: selected.snapshots,
    blocked: selected.blocked,
    continuation:
      selected.deferred ||
      rawPage.length === RECOVERY_PAGE_SIZE ||
      cursor !== null,
  };
}

async function readRawDueBearerPage(
  walletId: string,
  nowMs: number,
  cursor: BearerDueCursor | null,
): Promise<RawBearerSpendCandidate[]> {
  return withGuiCustodyProfileLockForWallet(walletId, async () =>
    db.transaction(
      "r",
      db.bearerSpendDeliveries,
      db.walletSendDeliveryPayloads,
      db.proofOperations,
      db.custodyOperations,
      async () => {
        const lower = cursor ?? ([walletId, 1, 0, Dexie.minKey] as const);
        const rows = await db.bearerSpendDeliveries
          .where("[walletId+active+nextAttemptAtMs+deliveryId]")
          .between(lower, [walletId, 1, nowMs, Dexie.maxKey], cursor !== null)
          .limit(RECOVERY_PAGE_SIZE)
          .toArray();
        const snapshots: RawBearerSpendCandidate[] = [];
        for (const row of rows) {
          snapshots.push(await readRawBearerSnapshot(row, walletId, nowMs));
        }
        return snapshots;
      },
    ),
  );
}

async function readRawBearerSnapshot(
  row: unknown,
  walletId: string,
  nowMs: number,
): Promise<RawBearerSpendCandidate> {
  const cursor = requireBearerDueCursor(row, walletId, nowMs);
  let lookup: BearerLookup;
  try {
    lookup = requireBearerLookup(row, walletId, nowMs);
  } catch {
    return { kind: "invalid", cursor };
  }
  const [operation, custody, payload] = await Promise.all([
    db.proofOperations.get(
      proofOperationPrimaryKey(walletId, lookup.operationId),
    ),
    db.custodyOperations.get(lookup.parentOperationId),
    db.walletSendDeliveryPayloads.get([walletId, lookup.operationId]),
  ]);
  return structuredClone({
    kind: "snapshot",
    lookup,
    row,
    operation,
    custody,
    payload,
  });
}

function selectValidatedBearerBudget(
  rawPage: RawBearerSpendCandidate[],
  walletId: string,
): {
  snapshots: GuiBearerSpendSnapshot[];
  blocked: boolean;
  deferred: boolean;
  processedCursor: BearerDueCursor | null;
} {
  const snapshots: GuiBearerSpendSnapshot[] = [];
  const mintKeys = new Set<string>();
  let proofCount = 0;
  let blocked = false;
  let processedCursor: BearerDueCursor | null = null;
  for (const raw of rawPage) {
    if (raw.kind === "invalid") {
      blocked = true;
      processedCursor = raw.cursor;
      continue;
    }
    let snapshot: GuiBearerSpendSnapshot;
    let activeProofCount: number;
    try {
      snapshot = validateRawBearerSnapshot(raw, walletId);
      activeProofCount = activeProofReferences(snapshot.row.record).length;
    } catch {
      blocked = true;
      processedCursor = raw.lookup.cursor;
      continue;
    }
    const mintKey = `${snapshot.row.record.mintUrl}\u0000${snapshot.row.record.unit}`;
    const addsMint = !mintKeys.has(mintKey);
    if (
      proofCount + activeProofCount > RECOVERY_CYCLE_PROOF_LIMIT ||
      (addsMint && mintKeys.size >= RECOVERY_CYCLE_MINT_REQUEST_LIMIT)
    ) {
      return { snapshots, blocked, deferred: true, processedCursor };
    }
    proofCount += activeProofCount;
    mintKeys.add(mintKey);
    snapshots.push(snapshot);
    processedCursor = raw.lookup.cursor;
  }
  return { snapshots, blocked, deferred: false, processedCursor };
}

function validateRawBearerSnapshot(
  raw: RawBearerSpendSnapshot,
  walletId: string,
): GuiBearerSpendSnapshot {
  const row = requireGuiBearerSpendDeliveryRow(
    raw.row,
    walletId,
    raw.lookup.deliveryId,
  );
  const operation = requireProofOperationRecord(
    raw.operation,
    walletId,
    raw.lookup.operationId,
  );
  const custody = decodeOperationRow(
    requireCustodyOperationRow(raw.custody),
    guiWalletContextForWallet(walletId).scope,
  );
  const payload = raw.payload
    ? requireGuiWalletSendDeliveryPayloadRow(
        raw.payload,
        walletId,
        raw.lookup.operationId,
        raw.lookup.parentOperationId,
      )
    : undefined;
  requireGuiWalletSendBearerAuthority(custody, operation, payload, row);
  return { raw, row, operation, payload, custody };
}

function updateDueCursor(
  walletId: string,
  retainCursor: boolean,
  processedCursor: BearerDueCursor | null,
): void {
  if (processedCursor !== null && retainCursor) {
    dueCursorByWallet.set(walletId, processedCursor);
    return;
  }
  dueCursorByWallet.delete(walletId);
}

async function reconcileBearerSnapshots(
  walletId: string,
  snapshots: GuiBearerSpendSnapshot[],
): Promise<
  Array<{
    snapshot: GuiBearerSpendSnapshot;
    next: DurableBearerSpendDeliveryRecord;
  }>
> {
  const result: Array<{
    snapshot: GuiBearerSpendSnapshot;
    next: DurableBearerSpendDeliveryRecord;
  }> = [];
  for (const batch of createMintBatches(snapshots)) {
    const evidence = await readMintBatchEvidence(walletId, batch);
    let offset = 0;
    for (const item of batch.items) {
      const checker = checkerForEvidence(evidence, item.proofs, offset);
      result.push({
        snapshot: item.snapshot,
        next: await reconcileDurableBearerSpendDelivery({
          record: item.snapshot.row.record,
          checker,
          observedAtMs: monotonicObservationTime(item.snapshot.row.record),
        }),
      });
      offset += item.proofs.length;
    }
  }
  return result;
}

function createMintBatches(
  snapshots: GuiBearerSpendSnapshot[],
): BearerMintBatch[] {
  const batches: BearerMintBatch[] = [];
  for (const snapshot of snapshots) {
    const proofs = activeProofReferences(snapshot.row.record);
    const batch = batches.find(
      (candidate) =>
        candidate.mintUrl === snapshot.row.record.mintUrl &&
        candidate.unit === snapshot.row.record.unit,
    );
    const selected =
      batch ??
      createMintBatch(snapshot.row.record.mintUrl, snapshot.row.record.unit);
    selected.items.push({ snapshot, proofs });
    selected.proofCount += proofs.length;
    if (selected.proofCount > RECOVERY_CYCLE_PROOF_LIMIT) {
      throw new Error("GUI bearer recovery mint batch exceeds its bound");
    }
    if (!batch) batches.push(selected);
  }
  return batches;
}

function createMintBatch(mintUrl: string, unit: string): BearerMintBatch {
  return { mintUrl, unit, items: [], proofCount: 0 };
}

function activeProofReferences(
  record: DurableBearerSpendDeliveryRecord,
): Array<Pick<Proof, "id" | "secret">> {
  const proofs = record.proofEntries.flatMap((entry) =>
    entry.kind === "active"
      ? [{ id: entry.proof.id, secret: entry.proof.secret }]
      : [],
  );
  if (proofs.length < 1 || proofs.length > RECOVERY_CYCLE_PROOF_LIMIT) {
    throw new Error("GUI bearer recovery proof batch is invalid");
  }
  return proofs;
}

async function readMintBatchEvidence(
  walletId: string,
  batch: BearerMintBatch,
): Promise<MintBatchEvidence> {
  const proofs = batch.items.flatMap((item) => item.proofs);
  const controller = new AbortController();
  const timeout = mintTimeoutTimer.schedule(
    () => controller.abort(),
    RECOVERY_MINT_TIMEOUT_MS,
  );
  try {
    const requestOptions = {
      requestTimeout: RECOVERY_MINT_TIMEOUT_MS,
      responseBodyBytesLimit: RECOVERY_RESPONSE_BYTES_LIMIT,
      signal: controller.signal,
    };
    const wallet = await abortableMintCheck(
      useWalletStore.getState().getWalletForUnit(batch.mintUrl, batch.unit, {
        expectedWalletId: walletId,
        ...requestOptions,
      }),
      controller.signal,
    );
    const states: unknown = await abortableMintCheck(
      wallet.checkProofsStates(proofs, requestOptions),
      controller.signal,
    );
    return Array.isArray(states) && states.length === proofs.length
      ? { kind: "states", states }
      : { kind: "invalid" };
  } catch {
    return { kind: "unavailable" };
  } finally {
    mintTimeoutTimer.cancel(timeout);
  }
}

async function abortableMintCheck<T>(
  request: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw new Error("GUI bearer mint check timed out");
  return new Promise<T>((resolve, reject) => {
    const settle = (action: () => void) => {
      signal.removeEventListener("abort", abort);
      action();
    };
    const abort = () =>
      settle(() => reject(new Error("GUI bearer mint check timed out")));
    signal.addEventListener("abort", abort, { once: true });
    request.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

function checkerForEvidence(
  evidence: MintBatchEvidence,
  expectedProofs: Array<Pick<Proof, "id" | "secret">>,
  offset: number,
): DurableBearerSpendProofStateChecker {
  return {
    checkProofsStates: async (proofs) => {
      if (!sameValue(proofs, expectedProofs)) {
        throw new Error("GUI bearer recovery proof request changed");
      }
      if (evidence.kind === "unavailable") {
        throw new Error("GUI bearer recovery evidence is unavailable");
      }
      if (evidence.kind === "invalid") return [];
      return evidence.states.slice(offset, offset + expectedProofs.length);
    },
  };
}

async function commitBearerReconciliation(
  expected: GuiBearerSpendSnapshot,
  nextRecord: DurableBearerSpendDeliveryRecord,
): Promise<void> {
  const write = prepareBearerReconciliationWrite(expected, nextRecord);
  await withGuiCustodyProfileLockForWallet(expected.row.walletId, async () =>
    db.transaction(
      "rw",
      db.bearerSpendDeliveries,
      db.walletSendDeliveryPayloads,
      db.proofOperations,
      db.custodyOperations,
      async () => {
        const current = await readRawBearerSnapshotByLookup(
          expected.raw.lookup,
        );
        if (!sameRawBearerSnapshot(current, expected.raw)) {
          throw new GuiBearerSpendAuthorityChanged();
        }
        await db.bearerSpendDeliveries.put(write.nextRow);
        requireGuiDexieWriteTransaction(
          db,
          "GUI bearer reconciliation requires a write transaction",
        );
        if (write.deletePayload) {
          await db.walletSendDeliveryPayloads.delete([
            expected.row.walletId,
            expected.operation.operationId,
          ]);
          requireGuiDexieWriteTransaction(
            db,
            "GUI bearer payload deletion requires a write transaction",
          );
        }
      },
    ),
  );
}

function prepareBearerReconciliationWrite(
  current: GuiBearerSpendSnapshot,
  nextRecord: DurableBearerSpendDeliveryRecord,
): { nextRow: GuiBearerSpendDeliveryRow; deletePayload: boolean } {
  const nextRow = createGuiBearerSpendDeliveryRow(nextRecord);
  const metadata = readGuiWalletSendDeliveryMetadata(current.operation);
  if (!metadata) throw new Error("GUI bearer recovery admission is missing");
  requireGuiBearerSpendDeliveryRowWithinByteBound(
    nextRow,
    metadata.admission.bearerPolicyRowBytesUpperBound,
  );
  const nextPayload = nextRow.presentable === 1 ? current.payload : undefined;
  requireGuiWalletSendBearerAuthority(
    current.custody,
    current.operation,
    nextPayload,
    nextRow,
  );
  return {
    nextRow,
    deletePayload: nextPayload === undefined && current.payload !== undefined,
  };
}

async function readRawBearerSnapshotByLookup(
  lookup: BearerLookup,
): Promise<RawBearerSpendSnapshot> {
  const [row, operation, custody, payload] = await Promise.all([
    db.bearerSpendDeliveries.get([lookup.walletId, lookup.deliveryId]),
    db.proofOperations.get(
      proofOperationPrimaryKey(lookup.walletId, lookup.operationId),
    ),
    db.custodyOperations.get(lookup.parentOperationId),
    db.walletSendDeliveryPayloads.get([lookup.walletId, lookup.operationId]),
  ]);
  return structuredClone({
    kind: "snapshot",
    lookup,
    row,
    operation,
    custody,
    payload,
  });
}

function sameRawBearerSnapshot(
  left: RawBearerSpendSnapshot,
  right: RawBearerSpendSnapshot,
): boolean {
  return (
    sameValue(left.row, right.row) &&
    sameValue(left.operation, right.operation) &&
    sameValue(left.custody, right.custody) &&
    sameValue(left.payload, right.payload)
  );
}

async function readNextBearerAttempt(
  walletId: string,
  continuation: boolean,
  blocked: boolean,
): Promise<number | null> {
  const raw = await withGuiCustodyProfileLockForWallet(walletId, async () =>
    db.bearerSpendDeliveries
      .where("[walletId+active+nextAttemptAtMs+deliveryId]")
      .between(
        [walletId, 1, 0, Dexie.minKey],
        [walletId, 1, Number.MAX_SAFE_INTEGER, Dexie.maxKey],
      )
      .first(),
  );
  if (!raw)
    return blocked ? Date.now() + RECOVERY_LOCAL_FAILURE_RETRY_MS : null;
  const nextAttemptAtMs = requireIndexedNextAttempt(raw, walletId);
  const minimumDelay = blocked
    ? RECOVERY_LOCAL_FAILURE_RETRY_MS
    : continuation || nextAttemptAtMs <= Date.now()
      ? RECOVERY_CONTINUATION_DELAY_MS
      : 1;
  return Math.max(Date.now() + minimumDelay, nextAttemptAtMs);
}

function requireBearerLookup(
  value: unknown,
  walletId: string,
  nowMs: number,
): BearerLookup {
  const row = requireRecord(value, "GUI bearer indexed row");
  const nextAttemptAtMs = requireIndexedNextAttempt(row, walletId);
  if (nextAttemptAtMs > nowMs) {
    throw new Error("GUI bearer indexed row is not due");
  }
  const deliveryId = requireIndexedText(row.deliveryId, "delivery id");
  const parentOperationId = requireIndexedText(
    row.parentOperationId,
    "parent operation id",
  );
  const operationId = operationIdFromPayloadHandle(
    requireIndexedText(row.payloadHandle, "payload handle"),
  );
  return {
    walletId,
    deliveryId,
    operationId,
    parentOperationId,
    cursor: [walletId, 1, nextAttemptAtMs, deliveryId],
  };
}

function requireBearerDueCursor(
  value: unknown,
  walletId: string,
  nowMs: number,
): BearerDueCursor {
  const row = requireRecord(value, "GUI bearer indexed row");
  if (
    row.walletId !== walletId ||
    row.active !== 1 ||
    typeof row.nextAttemptAtMs !== "number" ||
    !Number.isFinite(row.nextAttemptAtMs) ||
    row.nextAttemptAtMs < 0 ||
    row.nextAttemptAtMs > nowMs
  ) {
    throw new Error("GUI bearer indexed cursor is invalid");
  }
  return [walletId, 1, row.nextAttemptAtMs, row.deliveryId as string];
}

function requireIndexedNextAttempt(value: unknown, walletId: string): number {
  const row = requireRecord(value, "GUI bearer indexed row");
  if (
    row.walletId !== walletId ||
    row.active !== 1 ||
    !Number.isSafeInteger(row.nextAttemptAtMs) ||
    (row.nextAttemptAtMs as number) < 0
  ) {
    throw new Error("GUI bearer indexed row is invalid");
  }
  return row.nextAttemptAtMs as number;
}

function requireIndexedText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) {
    throw new Error(`GUI bearer indexed ${label} is invalid`);
  }
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function requireCustodyOperationRow(value: unknown): DexieCustodyOperationRow {
  const row = requireRecord(value, "GUI bearer custody row");
  if (
    Object.keys(row).length !== 5 ||
    typeof row.operationId !== "string" ||
    typeof row.scopeId !== "string" ||
    (row.active !== 0 && row.active !== 1) ||
    row.bindingKind !== "wallet" ||
    typeof row.record !== "object" ||
    row.record === null
  ) {
    throw new Error("GUI bearer custody row is invalid");
  }
  return row as unknown as DexieCustodyOperationRow;
}

function operationIdFromPayloadHandle(payloadHandle: string): string {
  if (!payloadHandle.startsWith(WALLET_SEND_PAYLOAD_HANDLE_PREFIX)) {
    throw new Error("GUI bearer recovery payload handle is invalid");
  }
  return requireIndexedText(
    payloadHandle.slice(WALLET_SEND_PAYLOAD_HANDLE_PREFIX.length),
    "operation id",
  );
}

function monotonicObservationTime(
  record: DurableBearerSpendDeliveryRecord,
): number {
  const lastObservedAtMs =
    record.state.kind === "pending" ? record.state.lastObservedAtMs : null;
  return Math.max(Date.now(), record.createdAtMs, lastObservedAtMs ?? 0);
}

function scheduleRecoveryWake(
  walletId: string,
  nextAttemptAtMs: number | null,
): void {
  try {
    if (currentGuiWalletContext().walletId !== walletId) return;
  } catch {
    return;
  }
  clearRecoveryWake();
  if (nextAttemptAtMs === null) return;
  const delayMs = Math.min(
    Math.max(1, nextAttemptAtMs - Date.now()),
    RECOVERY_TIMER_MAX_MS,
  );
  const timer = recoveryTimer.schedule(() => {
    if (
      scheduledRecovery?.walletId !== walletId ||
      scheduledRecovery.timer !== timer
    ) {
      return;
    }
    scheduledRecovery = null;
    try {
      if (currentGuiWalletContext().walletId !== walletId) return;
      void requestGuiBearerSpendRecovery().catch(() => undefined);
    } catch {
      // A changed or absent seed makes the stale wake ineligible.
    }
  }, delayMs);
  scheduledRecovery = { walletId, timer };
}

function clearRecoveryWake(): void {
  if (scheduledRecovery === null) return;
  recoveryTimer.cancel(scheduledRecovery.timer);
  scheduledRecovery = null;
}

function defaultRecoveryTimer(): BearerRecoveryTimer {
  return {
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    cancel: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  };
}

function clearCycle(): GuiBearerSpendRecoveryCycle {
  return { status: "clear", nextAttemptAtMs: null };
}

function pendingCycle(nextAttemptAtMs: number): GuiBearerSpendRecoveryCycle {
  return { status: "pending", nextAttemptAtMs };
}

function blockedCycle(nextAttemptAtMs: number): GuiBearerSpendRecoveryCycle {
  return { status: "blocked", nextAttemptAtMs };
}
