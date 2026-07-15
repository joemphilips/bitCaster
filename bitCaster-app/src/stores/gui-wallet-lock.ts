const GUI_WALLET_ID = /^[0-9a-f]{64}$/;
const HELD_GUI_WALLET_LOCK = Symbol("held-gui-wallet-lock");
const liveContexts = new WeakSet<object>();

export interface GuiWalletLockContext {
  readonly walletId: string;
  readonly [HELD_GUI_WALLET_LOCK]: true;
}

export type GuiWalletLockAttempt<T> =
  | { acquired: true; value: T }
  | { acquired: false };

export function guiWalletLockName(walletId: unknown): string {
  return `bitcaster-custody:${requireWalletId(walletId)}`;
}

export function guiWalletCounterLockName(walletId: unknown): string {
  return `bitcaster-custody-counter:${requireWalletId(walletId)}`;
}

export async function withGuiWalletLock<T>(
  walletId: string,
  currentWalletId: () => string,
  action: (context: GuiWalletLockContext) => Promise<T>,
): Promise<T> {
  const capturedWalletId = requireWalletId(walletId);
  const lockManager =
    typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!lockManager) {
    throw new Error("Browser custody locking is unavailable");
  }

  return lockManager.request(
    guiWalletLockName(capturedWalletId),
    { mode: "exclusive" },
    async () => runWithHeldGuiWalletLock(capturedWalletId, currentWalletId, action),
  );
}

/** Background custody work never waits behind a foreground external effect. */
export async function tryWithGuiWalletLock<T>(
  walletId: string,
  currentWalletId: () => string,
  action: (context: GuiWalletLockContext) => Promise<T>,
): Promise<GuiWalletLockAttempt<T>> {
  const capturedWalletId = requireWalletId(walletId);
  const lockManager =
    typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!lockManager) {
    throw new Error("Browser custody locking is unavailable");
  }
  return lockManager.request(
    guiWalletLockName(capturedWalletId),
    { mode: "exclusive", ifAvailable: true },
    async (lock) => {
      if (lock === null) return { acquired: false };
      return {
        acquired: true,
        value: await runWithHeldGuiWalletLock(
          capturedWalletId,
          currentWalletId,
          action,
        ),
      };
    },
  );
}

async function runWithHeldGuiWalletLock<T>(
  capturedWalletId: string,
  currentWalletId: () => string,
  action: (context: GuiWalletLockContext) => Promise<T>,
): Promise<T> {
  if (requireWalletId(currentWalletId()) !== capturedWalletId) {
    throw new Error("GUI wallet changed while awaiting custody ownership");
  }
  const context = Object.freeze({
    walletId: capturedWalletId,
    [HELD_GUI_WALLET_LOCK]: true as const,
  });
  liveContexts.add(context);
  try {
    return await action(context);
  } finally {
    liveContexts.delete(context);
  }
}

export function walletIdFromHeldGuiWalletLock(
  context: GuiWalletLockContext,
): string {
  if (
    typeof context !== "object" ||
    context === null ||
    !liveContexts.has(context) ||
    context[HELD_GUI_WALLET_LOCK] !== true
  ) {
    throw new Error("GUI custody mutation requires the active wallet lock");
  }
  return requireWalletId(context.walletId);
}

function requireWalletId(walletId: unknown): string {
  if (typeof walletId !== "string" || !GUI_WALLET_ID.test(walletId)) {
    throw new Error("GUI custody requires a valid seed-derived wallet id");
  }
  return walletId;
}
