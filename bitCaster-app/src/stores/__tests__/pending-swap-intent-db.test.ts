import { secp256k1 } from "@noble/curves/secp256k1.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rows = new Map<string, Record<string, unknown>>();
let storageError: Error | null = null;
let activeWalletId = "aa".repeat(32);
const WALLET_A = "aa".repeat(32);
const WALLET_B = "bb".repeat(32);
const ORIGINAL_LOCKS = Object.getOwnPropertyDescriptor(navigator, "locks");

vi.mock("../proof-db", () => ({
  ensureDurableSwapStorage: async () => {
    if (storageError) throw storageError;
  },
  currentGuiWalletId: () => activeWalletId,
  db: {
    swapIntents: {
      get: async (tradeId: string) => rows.get(tradeId),
      where: (field: string) => ({
        equals: (value: string) => ({
          toArray: async () =>
            Array.from(rows.values()).filter((row) => row[field] === value),
        }),
      }),
    },
  },
}));

vi.mock("../gui-custody-authority", () => ({
  withGuiCustodyProfileLock: async <T>(
    action: (context: { walletId: string; scope: unknown }) => Promise<T>,
  ): Promise<T> => {
    if (!navigator.locks) {
      throw new Error("Browser custody locking is unavailable");
    }
    const walletId = activeWalletId;
    return navigator.locks.request(
      `bitcaster-custody:${walletId}`,
      { mode: "exclusive" },
      async () =>
        action({
          walletId,
          scope: { scopeKind: "wallet", walletId },
        }),
    );
  },
}));

import {
  createGuiPendingSwapIntentRecord,
  decodeGuiPendingSwapIntentRecord,
  getGuiPendingSwapIntent,
  loadGuiPendingSwapIntents,
} from "../pending-swap-intent-db";

const intent = {
  tradeId: "trade-001",
  orderId: "order-001",
  marketId: "condition-YES",
  pubkey: Array.from(secp256k1.getPublicKey(new Uint8Array(32).fill(1), true))
    .map((part) => part.toString(16).padStart(2, "0"))
    .join(""),
  privkey: "01".repeat(32),
  deadline: "2099-01-01T00:00:00.000Z",
  submitted: false,
};

beforeEach(() => {
  rows.clear();
  storageError = null;
  activeWalletId = WALLET_A;
  installWebLocks();
});

afterEach(restoreWebLocks);

describe("GUI pending swap intent projection", () => {
  it("creates, stores, and hydrates an exact validated binding", async () => {
    const record = createGuiPendingSwapIntentRecord(intent, WALLET_A, 1);
    rows.set(intent.tradeId, record as unknown as Record<string, unknown>);

    await expect(getGuiPendingSwapIntent(intent.tradeId)).resolves.toEqual(
      intent,
    );
    await expect(loadGuiPendingSwapIntents()).resolves.toEqual([intent]);
  });

  it("loads only the current wallet projection", async () => {
    const own = createGuiPendingSwapIntentRecord(intent, WALLET_A, 1);
    const foreign = createGuiPendingSwapIntentRecord(
      { ...intent, tradeId: "trade-foreign" },
      WALLET_B,
      1,
    );
    rows.set(intent.tradeId, own as unknown as Record<string, unknown>);
    rows.set("trade-foreign", foreign as unknown as Record<string, unknown>);

    await expect(loadGuiPendingSwapIntents()).resolves.toEqual([intent]);
  });

  it("fails closed when durable storage or custody locking is unavailable", async () => {
    storageError = new Error("IndexedDB unavailable");
    await expect(loadGuiPendingSwapIntents()).rejects.toThrow(
      /IndexedDB unavailable/,
    );

    storageError = null;
    delete (navigator as { locks?: LockManager }).locks;
    await expect(loadGuiPendingSwapIntents()).rejects.toThrow(/custody/);
  });

  it("rejects corrupt and cross-wallet authority records", async () => {
    rows.set(intent.tradeId, {
      ...storedIntentRecord(intent),
      walletId: WALLET_B,
    });
    await expect(getGuiPendingSwapIntent(intent.tradeId)).rejects.toThrow(
      /another wallet scope/,
    );

    rows.set(intent.tradeId, {
      ...storedIntentRecord(intent),
      unknownAuthority: "future-schema",
    });
    await expect(getGuiPendingSwapIntent(intent.tradeId)).rejects.toThrow(
      /record fields are invalid/,
    );
  });

  it("rejects mismatched physical ids and private-key bindings", () => {
    const wrongTrade = storedIntentRecord(intent);
    wrongTrade.intent = {
      ...(wrongTrade.intent as Record<string, unknown>),
      tradeId: "trade-other",
    };
    expect(() =>
      decodeGuiPendingSwapIntentRecord(wrongTrade, WALLET_A, intent.tradeId),
    ).toThrow(/trade id mismatch/);

    expect(() =>
      createGuiPendingSwapIntentRecord(
        { ...intent, pubkey: `02${"b".repeat(64)}` },
        WALLET_A,
        1,
      ),
    ).toThrow(/private key does not match/);
  });
});

function storedIntentRecord(input: typeof intent): Record<string, unknown> {
  return {
    walletId: WALLET_A,
    tradeId: input.tradeId,
    intent: {
      schemaVersion: 2,
      tradeId: input.tradeId,
      orderId: input.orderId,
      marketId: input.marketId,
      localProtocolPubkey: input.pubkey,
      deadline: input.deadline,
    },
    ephemeralPrivkeyHex: input.privkey,
    submitted: input.submitted,
    updatedAt: 1,
  };
}

function installWebLocks(): void {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async <T>(
        _name: string,
        _options: LockOptions,
        callback: () => Promise<T>,
      ): Promise<T> => callback(),
    },
  });
}

function restoreWebLocks(): void {
  if (ORIGINAL_LOCKS) {
    Object.defineProperty(navigator, "locks", ORIGINAL_LOCKS);
  } else {
    delete (navigator as { locks?: LockManager }).locks;
  }
}
