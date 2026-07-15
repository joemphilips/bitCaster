import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  guiOriginStorageAdmissionLockName,
  walletIdFromHeldGuiOriginStorageAdmissionLock,
  withGuiOriginStorageAdmissionLock,
  type GuiOriginStorageAdmissionLockContext,
} from "../gui-origin-storage-admission-lock";
import {
  guiWalletLockName,
  withGuiWalletLock,
  type GuiWalletLockContext,
} from "../gui-wallet-lock";

const WALLET_A = "aa".repeat(32);
const WALLET_B = "bb".repeat(32);

describe("GUI origin storage-admission lock", () => {
  let locks: SerializedWebLocks;

  beforeEach(() => {
    locks = new SerializedWebLocks();
    installWebLocks(locks);
  });

  afterEach(() => {
    delete (navigator as { locks?: LockManager }).locks;
  });

  it("acquires the origin lock only after the wallet lock", async () => {
    await withGuiWalletLock(
      WALLET_A,
      () => WALLET_A,
      (walletLock) =>
        withGuiOriginStorageAdmissionLock(
          walletLock,
          () => WALLET_A,
          async (originLock) => {
            expect(
              walletIdFromHeldGuiOriginStorageAdmissionLock(originLock),
            ).toBe(WALLET_A);
          },
        ),
    );

    expect(locks.acquiredNames).toEqual([
      guiWalletLockName(WALLET_A),
      guiOriginStorageAdmissionLockName(),
    ]);
  });

  it("serializes origin mutations across different wallets", async () => {
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const firstDidEnter = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let secondWalletEntered!: () => void;
    const secondWalletDidEnter = new Promise<void>((resolve) => {
      secondWalletEntered = resolve;
    });
    let secondEntered = false;

    const first = runUnderOriginLock(WALLET_A, async () => {
      firstEntered();
      await firstMayFinish;
    });
    await firstDidEnter;
    const second = runUnderWalletLock(WALLET_B, async (walletLock) => {
      secondWalletEntered();
      await withGuiOriginStorageAdmissionLock(
        walletLock,
        () => WALLET_B,
        async () => {
          secondEntered = true;
        },
      );
    });
    await secondWalletDidEnter;

    expect(secondEntered).toBe(false);
    expect(
      locks.requestedNames.filter(
        (name) => name === guiOriginStorageAdmissionLockName(),
      ),
    ).toHaveLength(2);
    releaseFirst();
    await Promise.all([first, second]);
    expect(secondEntered).toBe(true);
  });

  it("rejects a wallet switch while waiting for origin ownership", async () => {
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const firstDidEnter = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const first = runUnderOriginLock(WALLET_A, async () => {
      firstEntered();
      await firstMayFinish;
    });
    await firstDidEnter;

    let currentWalletId = WALLET_B;
    const second = withGuiWalletLock(
      WALLET_B,
      () => currentWalletId,
      (walletLock) =>
        withGuiOriginStorageAdmissionLock(
          walletLock,
          () => currentWalletId,
          async () => undefined,
        ),
    );
    await waitUntilOriginRequests(locks, 2);
    currentWalletId = WALLET_A;
    releaseFirst();

    await expect(second).rejects.toThrow("wallet ownership changed");
    await first;
  });

  it("never enters an origin callback after its queued admission signal aborts", async () => {
    const first = deferred<void>();
    const entered = deferred<void>();
    const holder = runUnderOriginLock(WALLET_A, async () => {
      entered.resolve();
      await first.promise;
    });
    await entered.promise;

    const controller = new AbortController();
    let callbackEntered = false;
    const queued = withGuiWalletLock(
      WALLET_B,
      () => WALLET_B,
      (walletLock) =>
        withGuiOriginStorageAdmissionLock(
          walletLock,
          () => WALLET_B,
          async () => {
            callbackEntered = true;
          },
          controller.signal,
        ),
      controller.signal,
    );
    await waitUntilOriginRequests(locks, 2);
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    first.resolve();
    await holder;
    await Promise.resolve();
    expect(callbackEntered).toBe(false);
  });

  it("never enters a wallet callback after its queued admission signal aborts", async () => {
    const release = deferred<void>();
    const entered = deferred<void>();
    const holder = runUnderWalletLock(WALLET_A, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;

    const controller = new AbortController();
    let callbackEntered = false;
    const queued = withGuiWalletLock(
      WALLET_A,
      () => WALLET_A,
      async () => {
        callbackEntered = true;
      },
      controller.signal,
    );
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    release.resolve();
    await holder;
    await Promise.resolve();
    expect(callbackEntered).toBe(false);
  });

  it("rejects fabricated and expired wallet-lock contexts before requesting", async () => {
    await expect(
      withGuiOriginStorageAdmissionLock(
        {} as GuiWalletLockContext,
        () => WALLET_A,
        async () => undefined,
      ),
    ).rejects.toThrow("active wallet lock");
    expect(locks.acquiredNames).toEqual([]);

    let expired!: GuiWalletLockContext;
    await withGuiWalletLock(
      WALLET_A,
      () => WALLET_A,
      async (walletLock) => {
        expired = walletLock;
      },
    );
    await expect(
      withGuiOriginStorageAdmissionLock(
        expired,
        () => WALLET_A,
        async () => undefined,
      ),
    ).rejects.toThrow("active wallet lock");
    expect(locks.acquiredNames).toEqual([guiWalletLockName(WALLET_A)]);
  });

  it("expires the origin capability when its callback settles", async () => {
    let expired!: GuiOriginStorageAdmissionLockContext;
    await runUnderOriginLock(WALLET_A, async (originLock) => {
      expired = originLock;
      expect(walletIdFromHeldGuiOriginStorageAdmissionLock(originLock)).toBe(
        WALLET_A,
      );
    });

    expect(() =>
      walletIdFromHeldGuiOriginStorageAdmissionLock(expired),
    ).toThrow("active origin storage-admission lock");
    expect(() =>
      walletIdFromHeldGuiOriginStorageAdmissionLock(
        {} as GuiOriginStorageAdmissionLockContext,
      ),
    ).toThrow("active origin storage-admission lock");
  });

  it("fails closed when Web Locks disappear while wallet ownership is held", async () => {
    await withGuiWalletLock(
      WALLET_A,
      () => WALLET_A,
      async (walletLock) => {
        delete (navigator as { locks?: LockManager }).locks;
        await expect(
          withGuiOriginStorageAdmissionLock(
            walletLock,
            () => WALLET_A,
            async () => undefined,
          ),
        ).rejects.toThrow("storage-admission locking is unavailable");
      },
    );
  });

  it("rejects a nested origin acquisition instead of deadlocking", async () => {
    await runUnderWalletLock(WALLET_A, async (walletLock) => {
      await withGuiOriginStorageAdmissionLock(
        walletLock,
        () => WALLET_A,
        async () => {
          await expect(
            withGuiOriginStorageAdmissionLock(
              walletLock,
              () => WALLET_A,
              async () => undefined,
            ),
          ).rejects.toThrow("already requested");
        },
      );
    });
  });
});

function runUnderWalletLock<T>(
  walletId: string,
  action: (context: GuiWalletLockContext) => Promise<T>,
): Promise<T> {
  return withGuiWalletLock(walletId, () => walletId, action);
}

function runUnderOriginLock<T>(
  walletId: string,
  action: (context: GuiOriginStorageAdmissionLockContext) => Promise<T>,
): Promise<T> {
  return runUnderWalletLock(walletId, (walletLock) =>
    withGuiOriginStorageAdmissionLock(walletLock, () => walletId, action),
  );
}

class SerializedWebLocks {
  readonly requestedNames: string[] = [];
  readonly acquiredNames: string[] = [];
  readonly #tails = new Map<string, Promise<void>>();

  async request<T>(
    name: string,
    options: LockOptions,
    callback: (lock: Lock) => Promise<T>,
  ): Promise<T> {
    this.requestedNames.push(name);
    const predecessor = this.#tails.get(name) ?? Promise.resolve();
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor.then(() => released);
    this.#tails.set(name, tail);
    try {
      await waitForLockPredecessor(predecessor, options.signal);
    } catch (error) {
      release();
      if (this.#tails.get(name) === tail) this.#tails.delete(name);
      throw error;
    }
    this.acquiredNames.push(name);
    try {
      return await callback({ name, mode: "exclusive" } as Lock);
    } finally {
      release();
      if (this.#tails.get(name) === tail) this.#tails.delete(name);
    }
  }
}

function waitForLockPredecessor(
  predecessor: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) return predecessor;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const aborted = () => reject(abortError(signal));
    signal.addEventListener("abort", aborted, { once: true });
    predecessor.then(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, reject);
  });
}

function abortError(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException("The operation was aborted", "AbortError")
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function installWebLocks(locks: SerializedWebLocks): void {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: locks as unknown as LockManager,
  });
}

async function waitUntilOriginRequests(
  locks: SerializedWebLocks,
  expected: number,
): Promise<void> {
  for (let attempts = 0; attempts < 20; attempts += 1) {
    if (
      locks.requestedNames.filter(
        (name) => name === guiOriginStorageAdmissionLockName(),
      ).length >= expected
    ) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("origin lock request was not observed");
}
