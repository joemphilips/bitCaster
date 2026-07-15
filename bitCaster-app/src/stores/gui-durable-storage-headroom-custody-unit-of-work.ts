import { currentGuiWalletId, db } from "./proof-db";
import type { GuiWalletLockContext } from "./gui-wallet-lock";
import {
  commitPreparedGuiCustodyUnitOfWorkInCurrentTransaction,
  describePreparedGuiCustodyHeadroomWriteSet,
  preparedGuiCustodyUnitOfWorkTables,
  requirePreparedGuiCustodyHeadroomWriteSet,
  type PreparedGuiCustodyHeadroomWriteSet,
  type PreparedGuiCustodyUnitOfWork,
} from "./gui-custody-unit-of-work";
import {
  ensureGuiDurableStorageHeadroomInCurrentTransaction,
  ensureGuiDurableStorageAdmissionInitialized,
  guiDurableStorageAdmissionTables,
} from "./gui-durable-storage-admission-dexie";
import {
  walletIdFromHeldGuiOriginStorageAdmissionLock,
  withGuiOriginStorageAdmissionLock,
  type GuiOriginStorageAdmissionLockContext,
} from "./gui-origin-storage-admission-lock";
import { withGuiWalletLock } from "./gui-wallet-lock";

export interface GuiHeadroomCustodyUnitOfWorkInput<T> {
  walletLock: GuiWalletLockContext;
  prepared: PreparedGuiCustodyUnitOfWork<T>;
}

export class GuiDurableStorageHeadroomUnavailable extends Error {}

/**
 * Commits one SDK-classified, wallet-bound custody transition under the shared
 * profile-then-origin lock order. Ordinary operations do not consume swap
 * reservation accounting; they still require the physical emergency headroom
 * before any new effect can be authorized.
 */
export function commitGuiHeadroomCustodyUnitOfWork<T>(
  input: GuiHeadroomCustodyUnitOfWorkInput<T>,
): Promise<T> {
  const writeSet = requirePreparedGuiCustodyHeadroomWriteSet(
    describePreparedGuiCustodyHeadroomWriteSet(input.prepared),
  );
  return withGuiOriginStorageAdmissionLock(
    input.walletLock,
    currentGuiWalletId,
    (originLock) => {
      if (
        walletIdFromHeldGuiOriginStorageAdmissionLock(originLock) !==
        writeSet.walletId
      ) {
        throw new Error("GUI headroom custody wallet ownership changed");
      }
      return ensureGuiDurableStorageAdmissionInitialized(
        originLock,
        writeSet.database,
      ).then(() =>
        commitUnderReadyHeadroom(input.prepared, writeSet, originLock),
      );
    },
  );
}

/**
 * Fails before an exact recovery reissue can contact a mint when the browser
 * no longer has its durable emergency write margin.
 */
export function requireGuiNewEffectHeadroomForWallet(
  walletId: string,
): Promise<void> {
  return requireReadyHeadroomUnderLocks(walletId).catch((error: unknown) => {
    if (
      error instanceof Error &&
      error.message === "GUI durable storage emergency headroom is unavailable"
    ) {
      throw new GuiDurableStorageHeadroomUnavailable(error.message, {
        cause: error,
      });
    }
    throw error;
  });
}

async function requireReadyHeadroomUnderLocks(
  walletId: string,
): Promise<void> {
  await withGuiWalletLock(walletId, currentGuiWalletId, (walletLock) =>
    withGuiOriginStorageAdmissionLock(
      walletLock,
      currentGuiWalletId,
      async (originLock) => {
        await ensureGuiDurableStorageAdmissionInitialized(originLock, db);
        await db.transaction(
          "rw",
          guiDurableStorageAdmissionTables(db),
          () =>
            ensureGuiDurableStorageHeadroomInCurrentTransaction({
              originLock,
              boundary: "new-effect",
              database: db,
            }),
        );
      },
    ),
  );
}

function commitUnderReadyHeadroom<T>(
  prepared: PreparedGuiCustodyUnitOfWork<T>,
  writeSet: PreparedGuiCustodyHeadroomWriteSet,
  originLock: GuiOriginStorageAdmissionLockContext,
): Promise<T> {
  const tables = [
    ...preparedGuiCustodyUnitOfWorkTables(prepared),
    ...guiDurableStorageAdmissionTables(writeSet.database),
  ];
  return writeSet.database.transaction("rw", [...new Set(tables)], async () => {
    await ensureGuiDurableStorageHeadroomInCurrentTransaction({
      originLock,
      boundary: writeSet.boundary,
      database: writeSet.database,
    });
    return commitPreparedGuiCustodyUnitOfWorkInCurrentTransaction(prepared);
  });
}
