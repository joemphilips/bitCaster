import {
  walletIdFromHeldGuiWalletLock,
  type GuiWalletLockContext,
} from "./gui-wallet-lock";

const ORIGIN_STORAGE_ADMISSION_LOCK_NAME = "bitcaster-origin-storage-admission";
const HELD_ORIGIN_STORAGE_ADMISSION_LOCK = Symbol(
  "held-origin-storage-admission-lock",
);
const requestedWalletContexts = new WeakSet<object>();
const originWalletContexts = new WeakMap<
  object,
  {
    walletLock: GuiWalletLockContext;
    currentWalletId: () => string;
  }
>();

export interface GuiOriginStorageAdmissionLockContext {
  readonly walletId: string;
  readonly [HELD_ORIGIN_STORAGE_ADMISSION_LOCK]: true;
}

export function guiOriginStorageAdmissionLockName(): string {
  return ORIGIN_STORAGE_ADMISSION_LOCK_NAME;
}

export async function withGuiOriginStorageAdmissionLock<T>(
  walletLock: GuiWalletLockContext,
  currentWalletId: () => string,
  action: (context: GuiOriginStorageAdmissionLockContext) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const walletId = walletIdFromHeldGuiWalletLock(walletLock);
  const lockManager =
    typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!lockManager) {
    throw new Error("Browser storage-admission locking is unavailable");
  }
  if (requestedWalletContexts.has(walletLock)) {
    throw new Error(
      "Origin storage-admission ownership is already requested for this wallet lock",
    );
  }

  requestedWalletContexts.add(walletLock);
  try {
    return await lockManager.request(
      guiOriginStorageAdmissionLockName(),
      { mode: "exclusive", signal },
      async (lock) => {
        if (lock === null) {
          throw new Error(
            "Origin storage-admission ownership was not acquired",
          );
        }
        requireSameActiveWalletLock(walletLock, currentWalletId, walletId);
        return runWithHeldOriginLock(
          walletLock,
          currentWalletId,
          walletId,
          action,
        );
      },
    );
  } finally {
    requestedWalletContexts.delete(walletLock);
  }
}

export function walletIdFromHeldGuiOriginStorageAdmissionLock(
  context: GuiOriginStorageAdmissionLockContext,
): string {
  if (typeof context !== "object" || context === null) {
    throw inactiveOriginLockError();
  }
  const owner = originWalletContexts.get(context);
  if (!owner || context[HELD_ORIGIN_STORAGE_ADMISSION_LOCK] !== true) {
    throw inactiveOriginLockError();
  }
  return requireSameActiveWalletLock(
    owner.walletLock,
    owner.currentWalletId,
    context.walletId,
  );
}

async function runWithHeldOriginLock<T>(
  walletLock: GuiWalletLockContext,
  currentWalletId: () => string,
  walletId: string,
  action: (context: GuiOriginStorageAdmissionLockContext) => Promise<T>,
): Promise<T> {
  const context = Object.freeze({
    walletId,
    [HELD_ORIGIN_STORAGE_ADMISSION_LOCK]: true as const,
  });
  originWalletContexts.set(context, { walletLock, currentWalletId });
  try {
    return await action(context);
  } finally {
    originWalletContexts.delete(context);
  }
}

function requireSameActiveWalletLock(
  walletLock: GuiWalletLockContext,
  currentWalletId: () => string,
  expectedWalletId: string,
): string {
  const walletId = walletIdFromHeldGuiWalletLock(walletLock);
  if (walletId !== expectedWalletId || currentWalletId() !== expectedWalletId) {
    throw new Error("Origin storage-admission wallet ownership changed");
  }
  return walletId;
}

function inactiveOriginLockError(): Error {
  return new Error(
    "GUI storage admission requires the active origin storage-admission lock",
  );
}
