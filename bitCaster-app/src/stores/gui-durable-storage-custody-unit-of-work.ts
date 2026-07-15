import Dexie from "dexie";
import { currentGuiWalletId, type BitcasterDB } from "./proof-db";
import type { GuiWalletLockContext } from "./gui-wallet-lock";
import {
  commitPreparedGuiCustodyUnitOfWorkInCurrentTransaction,
  describePreparedGuiCustodyArtifactWriteSet,
  preparedGuiCustodyUnitOfWorkTables,
  type PreparedGuiCustodyArtifactWriteSet,
  type PreparedGuiCustodyUnitOfWork,
} from "./gui-custody-unit-of-work";
import { requireGuiDexieWriteTransaction } from "./gui-dexie-transaction";
import {
  commitGuiPreTradeSessionTransitionInCurrentTransaction,
  commitGuiDurableStorageArtifactTransitionInCurrentTransaction,
  guiDurableStorageAdmissionTables,
  withGuiDurableStorageArtifactTransitionInCurrentTransaction,
  type PreparedGuiDurableStorageArtifactTransition,
} from "./gui-durable-storage-admission-dexie";
import { readGuiDurableStorageReservationArtifactsInCurrentTransaction } from "./gui-durable-storage-reservation-dexie";
import {
  walletIdFromHeldGuiOriginStorageAdmissionLock,
  withGuiOriginStorageAdmissionLock,
  type GuiOriginStorageAdmissionLockContext,
} from "./gui-origin-storage-admission-lock";

export interface GuiDurableStorageCustodyUnitOfWorkInput<T> {
  walletLock: GuiWalletLockContext;
  tradeId: string;
  prepared: PreparedGuiCustodyUnitOfWork<T>;
}

export function commitGuiDurableStorageCustodyUnitOfWork<T>(
  input: GuiDurableStorageCustodyUnitOfWorkInput<T>,
): Promise<T> {
  const writeSet = describePreparedGuiCustodyArtifactWriteSet(input.prepared);
  if (writeSet.tradeId !== input.tradeId) {
    throw new Error(
      "GUI storage custody unit of work belongs to another trade",
    );
  }
  return withGuiOriginStorageAdmissionLock(
    input.walletLock,
    currentGuiWalletId,
    (originLock) =>
      commitUnderOriginStorageLock(input.prepared, writeSet, originLock),
  );
}

function commitUnderOriginStorageLock<T>(
  prepared: PreparedGuiCustodyUnitOfWork<T>,
  writeSet: PreparedGuiCustodyArtifactWriteSet,
  originLock: GuiOriginStorageAdmissionLockContext,
): Promise<T> {
  const walletId = walletIdFromHeldGuiOriginStorageAdmissionLock(originLock);
  if (walletId !== writeSet.walletId) {
    throw new Error("GUI storage custody wallet ownership changed");
  }
  const { database } = writeSet;
  return database.transaction(
    "rw",
    [
      ...preparedGuiCustodyUnitOfWorkTables(prepared),
      ...guiDurableStorageAdmissionTables(database),
      database.swapIntents,
    ],
    () =>
      commitPreparedStorageCustodyUnitOfWork(
        prepared,
        writeSet,
        originLock,
        database,
      ),
  );
}

function commitPreparedStorageCustodyUnitOfWork<T>(
  prepared: PreparedGuiCustodyUnitOfWork<T>,
  writeSet: PreparedGuiCustodyArtifactWriteSet,
  originLock: GuiOriginStorageAdmissionLockContext,
  database: BitcasterDB,
): Promise<T> {
  return withGuiDurableStorageArtifactTransitionInCurrentTransaction({
    originLock,
    tradeId: writeSet.tradeId,
    database,
    action: (artifactTransition) =>
      commitCustodyThenStorageTransition(
        prepared,
        writeSet,
        artifactTransition,
        originLock,
        database,
      ),
  });
}

function commitCustodyThenStorageTransition<T>(
  prepared: PreparedGuiCustodyUnitOfWork<T>,
  writeSet: PreparedGuiCustodyArtifactWriteSet,
  artifactTransition: PreparedGuiDurableStorageArtifactTransition,
  originLock: GuiOriginStorageAdmissionLockContext,
  database: BitcasterDB,
): Promise<T> {
  requireGuiDexieWriteTransaction(
    database,
    "GUI storage wrapper requires its write transaction",
  );
  return Dexie.Promise.resolve(
    commitPreparedGuiCustodyUnitOfWorkInCurrentTransaction(prepared),
  ).then((result) =>
    commitStoragePostImage(
      writeSet,
      artifactTransition,
      originLock,
      database,
    ).then(() => result),
  );
}

function commitStoragePostImage(
  writeSet: PreparedGuiCustodyArtifactWriteSet,
  artifactTransition: PreparedGuiDurableStorageArtifactTransition,
  originLock: GuiOriginStorageAdmissionLockContext,
  database: BitcasterDB,
): Promise<unknown> {
  if (
    artifactTransition.kind === "bind-first" &&
    !hasPreparedOperationPostImage(writeSet)
  ) {
    if (!writeSet.nextSession) {
      return Dexie.Promise.reject(
        new Error("GUI pre-trade session commit requires its post-image"),
      );
    }
    return commitGuiPreTradeSessionTransitionInCurrentTransaction({
      originLock,
      tradeId: writeSet.tradeId,
      previousSession: writeSet.previousSession,
      nextSession: writeSet.nextSession,
      database,
    });
  }
  return Dexie.Promise.resolve(
    readGuiDurableStorageReservationArtifactsInCurrentTransaction({
      originLock,
      tradeId: writeSet.tradeId,
      database,
    }),
  ).then((next) =>
    commitGuiDurableStorageArtifactTransitionInCurrentTransaction({
      prepared: artifactTransition,
      writeSet,
      next,
    }),
  );
}

function hasPreparedOperationPostImage(
  writeSet: PreparedGuiCustodyArtifactWriteSet,
): boolean {
  return writeSet.postImageArtifacts.some(
    ({ artifactRole }) => artifactRole === "exact-operation",
  );
}
