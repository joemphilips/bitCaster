import type { Proof } from "@cashu/cashu-ts";
import type { DexieDurableCustodyPlan } from "./durable-custody-transaction-plan";
import { sameValue } from "./durable-custody-dexie-model";
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

export async function commitGuiCustodyUnitOfWork<T>(input: {
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
}): Promise<T> {
  const { store } = input.authority;
  const database = input.database ?? db;
  const walletId = input.authority.scope.walletId;
  if (input.snapshot.walletId !== walletId) {
    throw new Error("GUI custody snapshot belongs to another wallet scope");
  }
  await requireSnapshotSessionIntegrity(input.snapshot, walletId);
  assertProofDeltaSelected(input);
  assertNativeWriteScope(input, walletId);
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
  return database.transaction(
    "rw",
    [
      ...store.transactionTables(),
      database.proofOperations,
      database.proofs,
      database.swapSessions,
      database.walletActivities,
    ],
    async () => {
      await assertNativeSnapshot(database, input.snapshot, walletId);
      await assertSessionCapacity(
        database,
        { ...input, nextSession },
        walletId,
      );
      await store.commitPreparedTransactionInCurrentTransaction(input.plan);
      if (input.nextOperation) {
        await database.proofOperations.put(
          requireProofOperationRecord(
            input.nextOperation,
            walletId,
            input.nextOperation.operationId,
          ),
        );
      }
      if (input.deleteProofs && input.deleteProofs.length > 0) {
        await database.proofs.bulkDelete(storedProofIds(input.deleteProofs));
      }
      if (nextProofs) {
        await database.proofs.bulkPut(nextProofs);
      }
      if (nextSession) {
        await database.swapSessions.put(nextSession);
      }
      if (input.nextActivity) {
        await database.walletActivities.put(
          requireWalletActivityRow(input.nextActivity, walletId),
        );
      }
      return input.plan.result;
    },
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

function assertProofDeltaSelected(input: {
  snapshot: GuiCustodyNativeSnapshot;
  deleteProofs?: StoredProof[];
  nextProofs?: StoredProof[];
}): void {
  const selected = new Set(input.snapshot.proofIds);
  const deleted = storedProofIds(input.deleteProofs ?? []);
  const written = storedProofIds(input.nextProofs ?? []);
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
