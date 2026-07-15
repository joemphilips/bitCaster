import Dexie from "dexie";
import type { Proof } from "@cashu/cashu-ts";
import {
  classifyDurableCustodyWalletStorageBoundary,
  type DurableCustodyWalletStorageBoundary,
} from "@bitcaster/client-sdk/durableCustody";
import type { DurableStoragePlannedArtifact } from "@bitcaster/client-sdk/durableStorageAdmission";
import type { DexieDurableCustodyPlan } from "./durable-custody-transaction-plan";
import { sameValue, scopeRow } from "./durable-custody-dexie-model";
import type { GuiCustodyAuthority } from "./gui-custody-authority";
import {
  guiSwapSessionIntegrityError,
  guiSwapSessionValidationError,
} from "./gui-swap-session-record";
import {
  db,
  locateStoredProofs,
  prepareStoredProofForWrite,
  proofOperationPrimaryKey,
  requireProofOperationRecord,
  requireStoredProofRow,
  storedProofIds,
  type BitcasterDB,
  type ProofOperationRecord,
  type StoredProof,
  type StoredProofRow,
  type SwapSessionRecord,
} from "./proof-db";
import {
  requireWalletActivityRow,
  type WalletActivityRow,
} from "./wallet-activity-projection";
import {
  assertGuiDurableStoragePlannedArtifact,
  createGuiDurableStorageRowArtifact,
  guiDurableStorageArtifactId,
} from "./gui-durable-storage-artifacts";
import { requireGuiDexieWriteTransaction } from "./gui-dexie-transaction";

export interface GuiCustodyNativeSnapshot {
  walletId: string;
  operationId: string | null;
  operation: ProofOperationRecord | undefined;
  proofSecrets: string[];
  proofIds: string[];
  proofs: StoredProof[];
  tradeId: string | null;
  session: SwapSessionRecord | undefined;
}

export interface GuiCustodyUnitOfWorkInput<T> {
  authority: GuiCustodyAuthority;
  plan: DexieDurableCustodyPlan<T>;
  snapshot: GuiCustodyNativeSnapshot;
  nextOperation?: ProofOperationRecord;
  deleteProofs?: StoredProof[];
  nextProofs?: StoredProof[];
  nextSession?: SwapSessionRecord;
  nextActivity?: WalletActivityRow;
  activeSessionLimit?: number;
  database?: BitcasterDB;
}

declare const PREPARED_GUI_CUSTODY_RESULT: unique symbol;

export interface PreparedGuiCustodyUnitOfWork<T> {
  readonly walletId: string;
  readonly [PREPARED_GUI_CUSTODY_RESULT]: T;
}

export interface PreparedGuiCustodyArtifactWriteSet {
  readonly walletId: string;
  readonly tradeId: string;
  readonly previousSession: SwapSessionRecord | undefined;
  readonly nextSession: SwapSessionRecord | undefined;
  readonly retainedContextArtifacts: readonly DurableStoragePlannedArtifact[];
  readonly postImageArtifacts: readonly DurableStoragePlannedArtifact[];
  readonly deletedArtifactIds: readonly string[];
  readonly database: BitcasterDB;
}

export interface PreparedGuiCustodyHeadroomWriteSet {
  readonly walletId: string;
  readonly boundary: DurableCustodyWalletStorageBoundary;
  readonly database: BitcasterDB;
}

interface PreparedGuiCustodyState<T> {
  authority: GuiCustodyAuthority;
  plan: DexieDurableCustodyPlan<T>;
  snapshot: GuiCustodyNativeSnapshot;
  nextOperation?: ProofOperationRecord;
  deleteProofIds: string[];
  nextProofs?: StoredProofRow[];
  nextSession?: SwapSessionRecord;
  nextActivity?: WalletActivityRow;
  activeSessionLimit?: number;
  database: BitcasterDB;
}

const preparedGuiCustodyUnits = new WeakMap<
  object,
  PreparedGuiCustodyState<unknown>
>();
const preparedGuiCustodyArtifactWriteSets = new WeakSet<object>();
const preparedGuiCustodyHeadroomWriteSets = new WeakSet<object>();

export async function readGuiCustodyNativeSnapshot(
  operationId: string | null,
  tradeId: string | null,
  walletId: string,
  database: BitcasterDB = db,
  proofs: readonly StoredProof[] = [],
): Promise<GuiCustodyNativeSnapshot> {
  const proofIds = storedProofIds(proofs);
  const proofSecrets = proofs.map(({ secret }) => secret);
  if (new Set(proofSecrets).size !== proofSecrets.length) {
    throw new Error("GUI custody proof snapshot contains a duplicate secret");
  }
  const snapshot = await database.transaction(
    "r",
    database.proofOperations,
    database.proofs,
    database.swapSessions,
    async () => ({
      walletId,
      operationId,
      operation:
        operationId === null
          ? undefined
          : requireScopedOperation(
              await database.proofOperations.get(
                proofOperationPrimaryKey(walletId, operationId),
              ),
              walletId,
              operationId,
            ),
      proofSecrets: [...proofSecrets],
      proofIds,
      proofs: requireScopedProofs(
        await database.proofs.bulkGet(proofIds),
        walletId,
      ),
      tradeId,
      session:
        tradeId === null
          ? undefined
          : requireScopedSession(
              await database.swapSessions.get(tradeId),
              walletId,
            ),
    }),
  );
  await requireSnapshotSessionIntegrity(snapshot, walletId);
  return snapshot;
}

export async function readGuiCustodyOperationSnapshot(
  operationId: string,
  walletId: string,
  additionalProofs: readonly Proof[] = [],
  tradeId: string | null = null,
  database: BitcasterDB = db,
): Promise<GuiCustodyNativeSnapshot> {
  const snapshot = await database.transaction(
    "r",
    database.proofOperations,
    database.proofs,
    database.swapSessions,
    async () => {
      const operation = requireScopedOperation(
        await database.proofOperations.get(
          proofOperationPrimaryKey(walletId, operationId),
        ),
        walletId,
        operationId,
      );
      const locatedProofs = operation
        ? locateOperationProofs(operation, additionalProofs)
        : [];
      const proofSecrets = locatedProofs.map(({ secret }) => secret);
      const proofIds = storedProofIds(locatedProofs);
      if (new Set(proofSecrets).size !== proofSecrets.length) {
        throw new Error(
          "GUI custody proof snapshot contains a duplicate secret",
        );
      }
      return {
        walletId,
        operationId,
        operation,
        proofSecrets,
        proofIds,
        proofs: requireScopedProofs(
          await database.proofs.bulkGet(proofIds),
          walletId,
        ),
        tradeId,
        session:
          tradeId === null
            ? undefined
            : requireScopedSession(
                await database.swapSessions.get(tradeId),
                walletId,
              ),
      };
    },
  );
  await requireSnapshotSessionIntegrity(snapshot, walletId);
  return snapshot;
}

export async function prepareGuiCustodyUnitOfWork<T>(
  input: GuiCustodyUnitOfWorkInput<T>,
): Promise<PreparedGuiCustodyUnitOfWork<T>> {
  const database = input.database ?? db;
  const walletId = input.authority.scope.walletId;
  if (input.snapshot.walletId !== walletId) {
    throw new Error("GUI custody snapshot belongs to another wallet scope");
  }
  const snapshot = structuredClone(input.snapshot);
  await requireSnapshotSessionIntegrity(snapshot, walletId);
  const now = Date.now();
  const nextSession = input.nextSession
    ? structuredClone(input.nextSession)
    : undefined;
  if (
    nextSession &&
    (await guiSwapSessionIntegrityError(nextSession, walletId)) !== null
  ) {
    throw new Error("GUI custody next session is invalid");
  }
  const nextProofs = input.nextProofs?.map((proof) =>
    prepareStoredProofForWrite(proof, now, walletId),
  );
  const nextOperation = input.nextOperation
    ? requireProofOperationRecord(
        structuredClone(input.nextOperation),
        walletId,
        input.nextOperation.operationId,
      )
    : undefined;
  const nextActivity = input.nextActivity
    ? requireWalletActivityRow(structuredClone(input.nextActivity), walletId)
    : undefined;
  const deleteProofIds = storedProofIds(input.deleteProofs ?? []);
  assertProofDeltaSelected(
    snapshot,
    deleteProofIds,
    storedProofIds(nextProofs ?? []),
  );
  assertNativeWriteScope(
    { nextOperation, nextSession, nextActivity },
    walletId,
  );
  const prepared = Object.freeze({
    walletId,
  }) as PreparedGuiCustodyUnitOfWork<T>;
  preparedGuiCustodyUnits.set(prepared, {
    authority: input.authority,
    plan: input.plan,
    snapshot,
    nextOperation,
    deleteProofIds,
    nextProofs,
    nextSession,
    nextActivity,
    activeSessionLimit: input.activeSessionLimit,
    database,
  });
  return prepared;
}

export function guiCustodyUnitOfWorkTables(
  authority: GuiCustodyAuthority,
  database: BitcasterDB = db,
) {
  return [
    ...authority.store.transactionTables(),
    database.proofOperations,
    database.proofs,
    database.swapSessions,
    database.walletActivities,
  ] as const;
}

export function preparedGuiCustodyUnitOfWorkTables<T>(
  prepared: PreparedGuiCustodyUnitOfWork<T>,
) {
  const state = requirePreparedGuiCustodyState(prepared);
  return guiCustodyUnitOfWorkTables(state.authority, state.database);
}

export function describePreparedGuiCustodyArtifactWriteSet<T>(
  prepared: PreparedGuiCustodyUnitOfWork<T>,
): PreparedGuiCustodyArtifactWriteSet {
  const state = requirePreparedGuiCustodyState(prepared);
  if (state.snapshot.tradeId === null) {
    throw new Error("GUI storage custody unit of work requires a trade");
  }
  if (state.nextActivity) {
    throw new Error("GUI trade storage accounting cannot adopt activity rows");
  }
  const writeSet = Object.freeze({
    walletId: prepared.walletId,
    tradeId: state.snapshot.tradeId,
    previousSession: cloneOptionalSession(state.snapshot.session),
    nextSession: cloneOptionalSession(state.nextSession),
    retainedContextArtifacts: freezeArtifacts([
      createGuiDurableStorageRowArtifact({
        table: "custodyScopes",
        key: state.plan.snapshot.scope.scopeId,
        artifactRole: "transaction-only-retained",
        row: scopeRow(state.plan.snapshot.scope),
      }),
    ]),
    postImageArtifacts: freezeArtifacts(preparedPostImageArtifacts(state)),
    deletedArtifactIds: freezeIds(preparedDeletedArtifactIds(state)),
    database: state.database,
  });
  preparedGuiCustodyArtifactWriteSets.add(writeSet);
  return writeSet;
}

export function requirePreparedGuiCustodyArtifactWriteSet(
  value: PreparedGuiCustodyArtifactWriteSet,
): PreparedGuiCustodyArtifactWriteSet {
  if (!preparedGuiCustodyArtifactWriteSets.has(value)) {
    throw new Error("GUI custody artifact write set was not prepared");
  }
  return value;
}

export function describePreparedGuiCustodyHeadroomWriteSet<T>(
  prepared: PreparedGuiCustodyUnitOfWork<T>,
): PreparedGuiCustodyHeadroomWriteSet {
  const state = requirePreparedGuiCustodyState(prepared);
  if (state.snapshot.tradeId !== null) {
    throw new Error("GUI wallet headroom write cannot adopt a trade");
  }
  const { previous, next } = walletStorageBoundaryRecords(state);
  const writeSet = Object.freeze({
    walletId: prepared.walletId,
    boundary: classifyDurableCustodyWalletStorageBoundary({
      previous,
      next,
    }),
    database: state.database,
  });
  preparedGuiCustodyHeadroomWriteSets.add(writeSet);
  return writeSet;
}

function walletStorageBoundaryRecords(
  state: PreparedGuiCustodyState<unknown>,
) {
  const rows = state.plan.transaction.operationRows();
  if (rows.length === 1) {
    const next = rows[0]!;
    return {
      previous:
        state.plan.snapshot.operationRows.get(next.operationId)?.record ?? null,
      next: next.record,
    };
  }
  const snapshots = [...state.plan.snapshot.operationRows.values()].filter(
    (row) => row !== undefined,
  );
  if (rows.length !== 0 || snapshots.length !== 1) {
    throw new Error("GUI wallet headroom write requires one exact operation");
  }
  return { previous: snapshots[0]!.record, next: snapshots[0]!.record };
}

export function requirePreparedGuiCustodyHeadroomWriteSet(
  value: PreparedGuiCustodyHeadroomWriteSet,
): PreparedGuiCustodyHeadroomWriteSet {
  if (!preparedGuiCustodyHeadroomWriteSets.has(value)) {
    throw new Error("GUI custody headroom write set was not prepared");
  }
  return value;
}

export function commitPreparedGuiCustodyUnitOfWorkInCurrentTransaction<T>(
  prepared: PreparedGuiCustodyUnitOfWork<T>,
): Promise<T> {
  try {
    return commitPreparedState(prepared);
  } catch (error) {
    return Dexie.Promise.reject(error);
  }
}

function commitPreparedState<T>(
  prepared: PreparedGuiCustodyUnitOfWork<T>,
): Promise<T> {
  const state = requirePreparedGuiCustodyState(prepared);
  const { database } = state;
  requireCurrentWriteTransaction(database);
  return Dexie.Promise.resolve(
    assertNativeSnapshot(database, state.snapshot, prepared.walletId),
  )
    .then(() => {
      requireCurrentWriteTransaction(database);
      return assertSessionCapacity(database, state, prepared.walletId);
    })
    .then(() => {
      requireCurrentWriteTransaction(database);
      return state.authority.store.commitPreparedTransactionInCurrentTransaction(
        state.plan,
      );
    })
    .then(() => {
      requireCurrentWriteTransaction(database);
      return writePreparedNativeRows(state);
    })
    .then(() => {
      requireCurrentWriteTransaction(database);
      return state.plan.result;
    });
}

function requirePreparedGuiCustodyState<T>(
  prepared: PreparedGuiCustodyUnitOfWork<T>,
): PreparedGuiCustodyState<T> {
  const state = preparedGuiCustodyUnits.get(prepared) as
    | PreparedGuiCustodyState<T>
    | undefined;
  if (!state || state.authority.scope.walletId !== prepared.walletId) {
    throw new Error("GUI custody unit of work was not prepared");
  }
  return state;
}

function preparedPostImageArtifacts(
  state: PreparedGuiCustodyState<unknown>,
): DurableStoragePlannedArtifact[] {
  return [
    ...preparedCustodyPostImageArtifacts(state),
    ...preparedNativePostImageArtifacts(state),
  ];
}

function preparedCustodyPostImageArtifacts(
  state: PreparedGuiCustodyState<unknown>,
): DurableStoragePlannedArtifact[] {
  const transaction = state.plan.transaction;
  const scopeId = state.plan.snapshot.scope.scopeId;
  return [
    createGuiDurableStorageRowArtifact({
      table: "custodyScopeStates",
      key: scopeId,
      artifactRole: "transaction-only-retained",
      row: { scopeId, state: transaction.scopeState() },
    }),
    ...transaction.operationRows().map((row) =>
      createGuiDurableStorageRowArtifact({
        table: "custodyOperations",
        key: row.operationId,
        artifactRole: "operation-overhead",
        row,
      }),
    ),
    ...transaction.linkRows().map((row) =>
      createGuiDurableStorageRowArtifact({
        table: "custodySessionLinks",
        key: row.operationId,
        artifactRole: "operation-overhead",
        row,
      }),
    ),
    ...transaction.reservationRows().map((row) =>
      createGuiDurableStorageRowArtifact({
        table: "custodyProofReservations",
        key: row.proofId,
        artifactRole: "operation-overhead",
        row,
      }),
    ),
  ];
}

function preparedNativePostImageArtifacts(
  state: PreparedGuiCustodyState<unknown>,
): DurableStoragePlannedArtifact[] {
  return [
    ...(state.nextOperation
      ? [
          createGuiDurableStorageRowArtifact({
            table: "proofOperations",
            key: [
              state.nextOperation.walletId,
              state.nextOperation.operationId,
            ],
            artifactRole: "exact-operation",
            row: state.nextOperation,
          }),
        ]
      : []),
    ...(state.nextProofs ?? []).map((row) =>
      createGuiDurableStorageRowArtifact({
        table: "proofs",
        key: row.proofId,
        artifactRole: "proof-post-image",
        row,
      }),
    ),
    ...(state.nextSession
      ? [
          createGuiDurableStorageRowArtifact({
            table: "swapSessions",
            key: state.nextSession.tradeId,
            artifactRole: "trade-session",
            row: state.nextSession,
          }),
        ]
      : []),
  ];
}

function preparedDeletedArtifactIds(
  state: PreparedGuiCustodyState<unknown>,
): string[] {
  const transaction = state.plan.transaction;
  const nextReservations = new Set(
    transaction.reservationRows().map(({ proofId }) => proofId),
  );
  const deletedReservations = transaction
    .reservationOperationIds()
    .flatMap(
      (operationId) =>
        state.plan.snapshot.reservationsByOperation.get(operationId) ?? [],
    )
    .filter(({ proofId }) => !nextReservations.has(proofId))
    .map(({ proofId }) =>
      guiDurableStorageArtifactId("custodyProofReservations", proofId),
    );
  return [
    ...deletedReservations,
    ...state.deleteProofIds.map((proofId) =>
      guiDurableStorageArtifactId("proofs", proofId),
    ),
  ];
}

function freezeIds(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

function freezeArtifacts(
  values: readonly DurableStoragePlannedArtifact[],
): readonly DurableStoragePlannedArtifact[] {
  const ids = values.map(({ artifactId }) => artifactId);
  if (new Set(ids).size !== ids.length) {
    throw new Error("GUI custody artifact write set contains duplicates");
  }
  return Object.freeze(
    values
      .map((artifact) => {
        assertGuiDurableStoragePlannedArtifact(artifact);
        return Object.freeze({ ...artifact });
      })
      .sort((left, right) => left.artifactId.localeCompare(right.artifactId)),
  );
}

function cloneOptionalSession(
  value: SwapSessionRecord | undefined,
): SwapSessionRecord | undefined {
  return value ? structuredClone(value) : undefined;
}

export async function commitGuiCustodyUnitOfWork<T>(
  input: GuiCustodyUnitOfWorkInput<T>,
): Promise<T> {
  const prepared = await prepareGuiCustodyUnitOfWork(input);
  const database = input.database ?? db;
  return database.transaction(
    "rw",
    guiCustodyUnitOfWorkTables(input.authority, database),
    async () =>
      commitPreparedGuiCustodyUnitOfWorkInCurrentTransaction(prepared),
  );
}

async function writePreparedNativeRows<T>(
  state: PreparedGuiCustodyState<T>,
): Promise<void> {
  const { database } = state;
  if (state.nextOperation) {
    await database.proofOperations.put(state.nextOperation);
    requireCurrentWriteTransaction(database);
  }
  if (state.deleteProofIds.length > 0) {
    await database.proofs.bulkDelete(state.deleteProofIds);
    requireCurrentWriteTransaction(database);
  }
  if (state.nextProofs) {
    await database.proofs.bulkPut(state.nextProofs);
    requireCurrentWriteTransaction(database);
  }
  if (state.nextSession) {
    await database.swapSessions.put(state.nextSession);
    requireCurrentWriteTransaction(database);
  }
  if (state.nextActivity) {
    await database.walletActivities.put(state.nextActivity);
    requireCurrentWriteTransaction(database);
  }
}

function requireCurrentWriteTransaction(database: BitcasterDB): void {
  requireGuiDexieWriteTransaction(
    database,
    "GUI custody commit requires an active write transaction",
  );
}

async function requireSnapshotSessionIntegrity(
  snapshot: GuiCustodyNativeSnapshot,
  walletId: string,
): Promise<void> {
  if (
    snapshot.session &&
    (await guiSwapSessionIntegrityError(snapshot.session, walletId)) !== null
  ) {
    throw new Error("GUI custody session is invalid");
  }
}

function assertProofDeltaSelected(
  snapshot: GuiCustodyNativeSnapshot,
  deleted: string[],
  written: string[],
): void {
  const selected = new Set(snapshot.proofIds);
  if (
    new Set(deleted).size !== deleted.length ||
    new Set(written).size !== written.length ||
    deleted.some((proofId) => !selected.has(proofId)) ||
    written.some((proofId) => !selected.has(proofId)) ||
    written.some((proofId) => deleted.includes(proofId))
  ) {
    throw new Error("GUI custody proof delta is outside its exact snapshot");
  }
}

async function assertSessionCapacity(
  database: BitcasterDB,
  input: {
    snapshot: GuiCustodyNativeSnapshot;
    nextSession?: SwapSessionRecord;
    activeSessionLimit?: number;
  },
  walletId: string,
): Promise<void> {
  const limit = input.activeSessionLimit;
  if (
    limit === undefined ||
    input.nextSession === undefined ||
    input.snapshot.session !== undefined ||
    input.nextSession.active === 0
  ) {
    return;
  }
  const activeCount = await database.swapSessions
    .where("[walletId+active]")
    .equals([walletId, 1])
    .limit(limit)
    .count();
  if (activeCount >= limit) {
    throw new Error("Durable swap session capacity is exhausted");
  }
}

async function assertNativeSnapshot(
  database: BitcasterDB,
  snapshot: GuiCustodyNativeSnapshot,
  walletId: string,
): Promise<void> {
  const operation =
    snapshot.operationId === null
      ? undefined
      : requireScopedOperation(
          await database.proofOperations.get(
            proofOperationPrimaryKey(walletId, snapshot.operationId),
          ),
          walletId,
          snapshot.operationId,
        );
  const proofs = requireScopedProofs(
    await database.proofs.bulkGet(snapshot.proofIds),
    walletId,
  );
  const session =
    snapshot.tradeId === null
      ? undefined
      : requireScopedSession(
          await database.swapSessions.get(snapshot.tradeId),
          walletId,
        );
  if (
    !sameValue(operation, snapshot.operation) ||
    !sameValue(proofs, snapshot.proofs) ||
    !sameValue(session, snapshot.session)
  ) {
    throw new Error("GUI custody native snapshot changed before commit");
  }
}

function assertNativeWriteScope(
  input: {
    nextOperation?: ProofOperationRecord;
    nextSession?: SwapSessionRecord;
    nextActivity?: WalletActivityRow;
  },
  walletId: string,
): void {
  if (
    (input.nextOperation && input.nextOperation.walletId !== walletId) ||
    (input.nextSession && input.nextSession.walletId !== walletId) ||
    (input.nextActivity && input.nextActivity.walletId !== walletId)
  ) {
    throw new Error("GUI custody write belongs to another wallet scope");
  }
}

function requireScopedOperation(
  row: ProofOperationRecord | undefined,
  walletId: string,
  operationId: string,
): ProofOperationRecord | undefined {
  return row
    ? requireProofOperationRecord(row, walletId, operationId)
    : undefined;
}

function requireScopedSession(
  row: SwapSessionRecord | undefined,
  walletId: string,
): SwapSessionRecord | undefined {
  if (row && guiSwapSessionValidationError(row, walletId) !== null) {
    throw new Error("GUI custody session is invalid");
  }
  return row;
}

function requireScopedProofs(
  rows: readonly (StoredProof | undefined)[],
  walletId: string,
): StoredProof[] {
  if (rows.some((row) => row && row.walletId !== walletId)) {
    throw new Error("GUI custody proof belongs to another wallet scope");
  }
  return rows.flatMap((row) =>
    row ? [requireStoredProofRow(row as StoredProofRow, walletId)] : [],
  );
}

function locateOperationProofs(
  operation: ProofOperationRecord,
  additionalProofs: readonly Proof[],
): StoredProof[] {
  const unit = operation.metadata.unit;
  if (!unit) throw new Error("GUI custody operation has no exact proof unit");
  return locateStoredProofs(
    [...operation.inputs, ...additionalProofs],
    operation.mintUrl,
    unit,
  );
}
