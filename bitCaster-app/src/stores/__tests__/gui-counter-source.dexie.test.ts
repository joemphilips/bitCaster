import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DexieCounterSource,
  type GuiWalletCounterRow,
} from "../gui-counter-source";
import { configureGuiWalletIdProvider, db } from "../proof-db";
import {
  guiWalletCounterLockName,
  guiWalletLockName,
  withGuiWalletLock,
} from "../gui-wallet-lock";

const WALLET_A = "aa".repeat(32);
const WALLET_B = "bb".repeat(32);
const KEYSET_ID = "00aabbccddeeff00";
const requestedLockNames: string[] = [];

describe("GUI deterministic counter Dexie authority", () => {
  let activeWalletId = WALLET_A;
  let originalLocks: PropertyDescriptor | undefined;

  beforeEach(async () => {
    activeWalletId = WALLET_A;
    requestedLockNames.length = 0;
    configureGuiWalletIdProvider(() => activeWalletId);
    originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
    installSerializedWebLocks();
    db.close();
    await db.delete();
    await db.open();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    db.close();
    await db.delete();
    restoreWebLocks(originalLocks);
  });

  it("atomically reserves disjoint ranges and does not persist a zero-count peek", async () => {
    const source = new DexieCounterSource(WALLET_A);

    await expect(source.reserve(KEYSET_ID, 0)).resolves.toEqual({
      start: 0,
      count: 0,
    });
    expect(await db.walletCounters.count()).toBe(0);

    const reservations = await Promise.all(
      Array.from({ length: 20 }, () => source.reserve(KEYSET_ID, 1)),
    );

    expect(
      reservations.map(({ start }) => start).sort((a, b) => a - b),
    ).toEqual(Array.from({ length: 20 }, (_, index) => index));
    await expect(source.snapshot()).resolves.toEqual({ [KEYSET_ID]: 20 });
  });

  it("reserves counters under a distinct lock while custody ownership is held", async () => {
    const result = await withGuiWalletLock(
      WALLET_A,
      () => activeWalletId,
      () => new DexieCounterSource(WALLET_A).reserve(KEYSET_ID, 1),
    );

    expect(result).toEqual({ start: 0, count: 1 });
    expect(requestedLockNames).toEqual([
      guiWalletLockName(WALLET_A),
      guiWalletCounterLockName(WALLET_A),
    ]);
  });

  it("continues from the committed cursor after the database is reopened", async () => {
    await new DexieCounterSource(WALLET_A).reserve(KEYSET_ID, 3);

    db.close();
    await db.open();

    await expect(
      new DexieCounterSource(WALLET_A).reserve(KEYSET_ID, 2),
    ).resolves.toEqual({ start: 3, count: 2 });
  });

  it("isolates seed wallets and resumes the earlier wallet when its seed returns", async () => {
    const sourceA = new DexieCounterSource(WALLET_A);
    await sourceA.reserve(KEYSET_ID, 4);

    activeWalletId = WALLET_B;
    await expect(sourceA.reserve(KEYSET_ID, 1)).rejects.toThrow(
      "active wallet seed changed",
    );
    const sourceB = new DexieCounterSource(WALLET_B);
    await expect(sourceB.reserve(KEYSET_ID, 2)).resolves.toEqual({
      start: 0,
      count: 2,
    });

    activeWalletId = WALLET_A;
    await expect(
      new DexieCounterSource(WALLET_A).reserve(KEYSET_ID, 1),
    ).resolves.toEqual({ start: 4, count: 1 });
  });

  it("advances monotonically and never lowers a committed cursor", async () => {
    const source = new DexieCounterSource(WALLET_A);
    await source.reserve(KEYSET_ID, 3);
    await source.advanceToAtLeast(KEYSET_ID, 2);
    await source.advanceToAtLeast(KEYSET_ID, 8);
    await source.advanceToAtLeast(KEYSET_ID, 5);

    await expect(source.reserve(KEYSET_ID, 1)).resolves.toEqual({
      start: 8,
      count: 1,
    });
  });

  it("rejects invalid values and overflow without mutating authority", async () => {
    const source = new DexieCounterSource(WALLET_A);
    await expect(source.reserve("", 1)).rejects.toThrow("keyset id");
    await expect(source.reserve("x".repeat(257), 1)).rejects.toThrow(
      "keyset id",
    );
    await expect(source.reserve(KEYSET_ID, -1)).rejects.toThrow(
      "reservation size",
    );
    await expect(source.reserve(KEYSET_ID, 1.5)).rejects.toThrow(
      "reservation size",
    );
    await expect(source.advanceToAtLeast(KEYSET_ID, -1)).rejects.toThrow(
      "advance target",
    );
    expect(await db.walletCounters.count()).toBe(0);

    await db.walletCounters.put({
      walletId: WALLET_A,
      keysetId: KEYSET_ID,
      nextCounter: Number.MAX_SAFE_INTEGER,
      updatedAt: 1,
    });
    await expect(source.reserve(KEYSET_ID, 1)).rejects.toThrow("overflow");
    expect(
      (await db.walletCounters.get([WALLET_A, KEYSET_ID]))?.nextCounter,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("fails closed on corrupt persisted counter rows", async () => {
    await db.walletCounters.put({
      walletId: WALLET_A,
      keysetId: KEYSET_ID,
      nextCounter: -1,
      updatedAt: 1,
    } as GuiWalletCounterRow);

    await expect(
      new DexieCounterSource(WALLET_A).reserve(KEYSET_ID, 1),
    ).rejects.toThrow("persisted counter");
  });

  it("rolls back when the counter write fails", async () => {
    const source = new DexieCounterSource(WALLET_A);
    await source.reserve(KEYSET_ID, 2);
    const put = vi
      .spyOn(db.walletCounters, "put")
      .mockRejectedValueOnce(new Error("injected counter write failure"));

    await expect(source.reserve(KEYSET_ID, 1)).rejects.toThrow(
      "injected counter write failure",
    );
    put.mockRestore();
    expect(
      (await db.walletCounters.get([WALLET_A, KEYSET_ID]))?.nextCounter,
    ).toBe(2);
  });

  it("fails closed without Web Locks and leaves the database unchanged", async () => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: undefined,
    });

    await expect(
      new DexieCounterSource(WALLET_A).reserve(KEYSET_ID, 1),
    ).rejects.toThrow("Web Locks");
    expect(await db.walletCounters.count()).toBe(0);
  });
});

function installSerializedWebLocks(): void {
  const tails = new Map<string, Promise<void>>();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async <T>(
        name: string,
        _options: LockOptions,
        callback: () => Promise<T>,
      ): Promise<T> => {
        requestedLockNames.push(name);
        const previous = tails.get(name) ?? Promise.resolve();
        let release: () => void = () => undefined;
        const current = new Promise<void>((resolve) => {
          release = resolve;
        });
        tails.set(
          name,
          previous.then(() => current),
        );
        await previous;
        try {
          return await callback();
        } finally {
          release();
        }
      },
    },
  });
}

function restoreWebLocks(original: PropertyDescriptor | undefined): void {
  if (original) {
    Object.defineProperty(navigator, "locks", original);
    return;
  }
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: undefined,
  });
}
