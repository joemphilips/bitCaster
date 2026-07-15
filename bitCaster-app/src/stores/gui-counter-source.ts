import type { CounterRange, CounterSource } from "@cashu/cashu-ts";
import { guiWalletCounterLockName } from "./gui-wallet-lock";
import {
  currentGuiWalletId,
  db,
  ensureDurableSwapStorage,
  requireGuiWalletId,
  type GuiWalletCounterRow,
} from "./proof-db";

export type { GuiWalletCounterRow } from "./proof-db";

export class DexieCounterSource implements CounterSource {
  readonly #walletId: string;

  constructor(walletId: string) {
    this.#walletId = requireGuiWalletId(walletId);
  }

  async reserve(keysetId: string, count: number): Promise<CounterRange> {
    const key = requireKeysetId(keysetId);
    requireCounterValue(count, "counter reservation size");
    return this.#withRequiredLock(async () => {
      let result: CounterRange = { start: 0, count };
      await db.transaction("rw", db.walletCounters, async () => {
        const row = requireCounterRow(
          await db.walletCounters.get([this.#walletId, key]),
          this.#walletId,
          key,
        );
        const start = row?.nextCounter ?? 0;
        result = { start, count };
        if (count === 0) return;
        const nextCounter = start + count;
        if (!Number.isSafeInteger(nextCounter)) {
          throw new Error("GUI deterministic counter overflow");
        }
        await db.walletCounters.put({
          walletId: this.#walletId,
          keysetId: key,
          nextCounter,
          updatedAt: Date.now(),
        });
      });
      return result;
    });
  }

  async advanceToAtLeast(keysetId: string, minNext: number): Promise<void> {
    const key = requireKeysetId(keysetId);
    requireCounterValue(minNext, "counter advance target");
    await this.#withRequiredLock(async () => {
      await db.transaction("rw", db.walletCounters, async () => {
        const row = requireCounterRow(
          await db.walletCounters.get([this.#walletId, key]),
          this.#walletId,
          key,
        );
        if (row && minNext <= row.nextCounter) return;
        if (!row && minNext === 0) return;
        await db.walletCounters.put({
          walletId: this.#walletId,
          keysetId: key,
          nextCounter: minNext,
          updatedAt: Date.now(),
        });
      });
    });
  }

  async snapshot(): Promise<Record<string, number>> {
    return this.#withRequiredLock(async () => {
      const rows = await db.walletCounters
        .where("walletId")
        .equals(this.#walletId)
        .toArray();
      return Object.fromEntries(
        rows.map((candidate) => {
          const row = requireCounterRow(
            candidate,
            this.#walletId,
            candidate.keysetId,
          );
          if (!row) throw new Error("GUI persisted counter row is missing");
          return [row.keysetId, row.nextCounter];
        }),
      );
    });
  }

  async #withRequiredLock<T>(action: () => Promise<T>): Promise<T> {
    this.#assertActiveWallet();
    if (typeof navigator === "undefined" || !navigator.locks) {
      throw new Error("Browser Web Locks are required for funded wallet work");
    }
    await ensureDurableSwapStorage(this.#walletId);
    return navigator.locks.request(
      guiWalletCounterLockName(this.#walletId),
      { mode: "exclusive" },
      async () => {
        this.#assertActiveWallet();
        return action();
      },
    );
  }

  #assertActiveWallet(): void {
    if (currentGuiWalletId() !== this.#walletId) {
      throw new Error("GUI counter source active wallet seed changed");
    }
  }
}

function requireKeysetId(keysetId: unknown): string {
  if (
    typeof keysetId !== "string" ||
    keysetId.length === 0 ||
    keysetId.length > 256
  ) {
    throw new Error(
      "GUI deterministic counter requires a keyset id of 1 to 256 characters",
    );
  }
  return keysetId;
}

function requireCounterValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid GUI ${label}`);
  }
  return value;
}

function requireCounterRow(
  candidate: GuiWalletCounterRow | undefined,
  walletId: string,
  keysetId: string,
): GuiWalletCounterRow | undefined {
  if (candidate === undefined) return undefined;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    candidate.walletId !== walletId ||
    !/^[0-9a-f]{64}$/.test(candidate.walletId) ||
    candidate.keysetId !== keysetId ||
    candidate.keysetId.length === 0 ||
    candidate.keysetId.length > 256 ||
    !Number.isSafeInteger(candidate.nextCounter) ||
    candidate.nextCounter < 0 ||
    !Number.isSafeInteger(candidate.updatedAt) ||
    candidate.updatedAt < 0
  ) {
    throw new Error("GUI persisted counter row is invalid");
  }
  return candidate;
}
