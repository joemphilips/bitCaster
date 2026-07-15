import "fake-indexeddb/auto";
import { Amount } from "@cashu/cashu-ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guiWalletLockName } from "../gui-wallet-lock";
import {
  addProofs,
  configureGuiWalletIdProvider,
  db,
  deriveStoredProofId,
  removeProofs,
} from "../proof-db";
import {
  canonicalKeysetId,
  canonicalSecpPoint,
} from "../../test/cashu-proof-fixtures";

const WALLET_A = "aa".repeat(32);
const WALLET_B = "bb".repeat(32);

describe("GUI proof writer lock", () => {
  let activeWalletId = WALLET_A;
  let locks: SerializedWebLocks;

  beforeEach(async () => {
    activeWalletId = WALLET_A;
    configureGuiWalletIdProvider(() => activeWalletId);
    locks = new SerializedWebLocks();
    installWebLocks(locks);
    db.close();
    await db.delete();
    await db.open();
  });

  afterEach(async () => {
    delete (navigator as { locks?: LockManager }).locks;
    db.close();
    await db.delete();
  });

  it("serializes proof writers from two browser contexts", async () => {
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstAcquired!: () => void;
    const firstWasAcquired = new Promise<void>((resolve) => {
      firstAcquired = resolve;
    });
    locks.beforeCallback = async (_name, acquisitionIndex) => {
      if (acquisitionIndex !== 0) return;
      firstAcquired();
      await firstMayFinish;
    };

    const first = addProofs([proof("proof-a")]);
    await firstWasAcquired;
    const second = addProofs([proof("proof-b")]);
    await Promise.resolve();

    expect(locks.acquiredNames).toEqual([guiWalletLockName(WALLET_A)]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(locks.acquiredNames).toEqual([
      guiWalletLockName(WALLET_A),
      guiWalletLockName(WALLET_A),
    ]);
    expect(await db.proofs.count()).toBe(2);
  });

  it("fails before writing when the seed changes while awaiting the lock", async () => {
    let releaseHolder!: () => void;
    const holderMayFinish = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holderAcquired!: () => void;
    const holderWasAcquired = new Promise<void>((resolve) => {
      holderAcquired = resolve;
    });
    const holder = navigator.locks.request(
      guiWalletLockName(WALLET_A),
      { mode: "exclusive" },
      async () => {
        holderAcquired();
        await holderMayFinish;
      },
    );
    await holderWasAcquired;

    const pending = addProofs([proof("proof-a")]);
    activeWalletId = WALLET_B;
    releaseHolder();
    await holder;

    await expect(pending).rejects.toThrow(
      "GUI wallet changed while awaiting custody ownership",
    );
    expect(await db.proofs.count()).toBe(0);
  });

  it("fails closed without Web Locks and performs no write", async () => {
    delete (navigator as { locks?: LockManager }).locks;

    await expect(addProofs([proof("proof-a")])).rejects.toThrow(
      "Browser custody locking is unavailable",
    );
    expect(await db.proofs.count()).toBe(0);
  });

  it("never mutates a proof owned by another wallet", async () => {
    await addProofs([proof("proof-a")]);
    activeWalletId = WALLET_B;

    await expect(removeProofs([proof("proof-a")])).rejects.toThrow(
      "another wallet scope",
    );
    expect(
      await db.proofs.get(deriveStoredProofId(proof("proof-a"))),
    ).toMatchObject({
      walletId: WALLET_A,
    });
  });
});

function proof(secret: string) {
  return {
    id: canonicalKeysetId(1),
    amount: Amount.from(1),
    secret,
    C: canonicalSecpPoint(1),
    mintUrl: "https://mint.example",
    unit: "sat" as const,
  };
}

class SerializedWebLocks {
  readonly acquiredNames: string[] = [];
  beforeCallback?: (name: string, acquisitionIndex: number) => Promise<void>;
  readonly #tails = new Map<string, Promise<void>>();

  async request<T>(
    name: string,
    _options: LockOptions,
    callback: (lock: Lock) => Promise<T>,
  ): Promise<T> {
    const predecessor = this.#tails.get(name) ?? Promise.resolve();
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor.then(() => released);
    this.#tails.set(name, tail);
    await predecessor;
    const acquisitionIndex = this.acquiredNames.length;
    this.acquiredNames.push(name);
    try {
      await this.beforeCallback?.(name, acquisitionIndex);
      return await callback({ name, mode: "exclusive" } as Lock);
    } finally {
      release();
      if (this.#tails.get(name) === tail) this.#tails.delete(name);
    }
  }
}

function installWebLocks(locks: SerializedWebLocks): void {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: locks as unknown as LockManager,
  });
}
