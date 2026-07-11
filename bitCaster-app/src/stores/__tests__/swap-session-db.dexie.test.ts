import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { BitcasterDB, db } from "../proof-db";
import {
  prepareGuiProofOperationWithSession,
  recoverGuiDurableTradeSession,
} from "../swap-session-db";
import type { ActiveSwap } from "../activeSwaps";

function swap(): ActiveSwap {
  const ephemeralPrivkeyHex = "01".repeat(32);
  const ephemeralPubkeyHex = Array.from(
    secp256k1.getPublicKey(new Uint8Array(32).fill(1), true),
  )
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
  return {
    tradeId: "trade-dexie",
    orderId: "order-dexie",
    marketId: "condition-YES",
    ephemeralPrivkeyHex,
    ephemeralPubkeyHex,
    role: "seller",
    counterpartyPubkey: `03${"b".repeat(64)}`,
    sellerLocktime: 120,
    buyerLocktime: 100,
    outcomeFaceAmountSats: null,
    outcomeFaceAmountSubunits: null,
    quotePaymentSats: null,
    quotePaymentSubunits: null,
    baseAsset: "sat",
    divisibility: 10_000,
    settlementKind: "DirectSwap",
    sellerKeepOutcomeSetId: null,
    sellerLockOutcomeSetId: null,
    step: "awaiting-counterparty",
    messages: {},
    sellerState: null,
    buyerState: null,
    inFlightSteps: {},
    error: null,
    startedAt: 1,
  };
}

async function withWebLocks<T>(action: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (
        _name: string,
        _options: LockOptions,
        callback: () => Promise<T>,
      ) => callback(),
    },
  });
  try {
    return await action();
  } finally {
    if (original) Object.defineProperty(navigator, "locks", original);
    else
      Object.defineProperty(navigator, "locks", {
        configurable: true,
        value: undefined,
      });
  }
}

async function withSerializedWebLocks<T>(action: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(navigator, "locks");
  const tails = new Map<string, Promise<void>>();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (
        name: string,
        _options: LockOptions,
        callback: () => Promise<T>,
      ) => {
        const previous = tails.get(name) ?? Promise.resolve();
        let release: () => void = () => undefined;
        const next = new Promise<void>((resolve) => {
          release = resolve;
        });
        tails.set(
          name,
          previous.then(() => next),
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
  try {
    return await action();
  } finally {
    if (original) Object.defineProperty(navigator, "locks", original);
    else
      Object.defineProperty(navigator, "locks", {
        configurable: true,
        value: undefined,
      });
  }
}

describe("GUI durable recovery Dexie transaction", () => {
  beforeEach(async () => {
    db.close();
    await db.delete();
    await db.open();
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  it("rolls back both rows when the session half of reconciliation fails", async () => {
    const nativeOperationId = "trade-dexie/browser/seller-lock";
    await prepareGuiProofOperationWithSession(
      {
        operationId: nativeOperationId,
        kind: "swap-lock",
        mintUrl: "https://mint.example",
        inputs: [],
        outputs: {},
      },
      swap(),
    );
    const sessionPut = vi
      .spyOn(db.swapSessions, "put")
      .mockImplementation((() => {
        throw new Error("injected session write failure");
      }) as never);
    try {
      const result = await withWebLocks(() =>
        recoverGuiDurableTradeSession("trade-dexie", {
          mint: {
            inspect: async () => ({ kind: "prepared-spent-restorable" }),
            restoreExactPersistedOutputs: async () => undefined,
            resumeExactPreparedOperation: async () => undefined,
          },
          transport: {
            joinTrade: async () => undefined,
            sendCipher: async () => undefined,
          },
          clock: { nowMs: () => 1 },
          hashCiphertext: async () => "0".repeat(64),
        }),
      );
      expect(result?.sessions).toEqual([
        expect.objectContaining({ kind: "failed-closed" }),
      ]);
    } finally {
      sessionPut.mockRestore();
    }

    expect((await db.proofOperations.get(nativeOperationId))?.state).toBe(
      "prepared",
    );
    expect(
      (await db.swapSessions.get("trade-dexie"))?.session.proofOperations[0]
        ?.state,
    ).toBe("prepared");
  });

  it("serializes two reopened-tab recoveries and reconciles the exact retained operation once", async () => {
    const nativeOperationId = "trade-dexie/browser/seller-lock";
    await prepareGuiProofOperationWithSession(
      {
        operationId: nativeOperationId,
        kind: "swap-lock",
        mintUrl: "https://mint.example",
        inputs: [],
        outputs: {},
      },
      swap(),
    );

    // Simulate the persisted view a new browser context sees after a reload.
    db.close();
    await db.open();

    let releaseRestore: (() => void) | undefined;
    const restoreReleased = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    let observeRestore: (() => void) | undefined;
    const restoreStarted = new Promise<void>((resolve) => {
      observeRestore = resolve;
    });
    const durableOperationId = (await db.proofOperations.get(nativeOperationId))
      ?.durableOperationId;
    expect(durableOperationId).toBeDefined();
    const inspectedOperationIds: string[] = [];
    const restoredOperationIds: string[] = [];
    const restoreExactPersistedOutputs = vi.fn(
      async (operation: { operationId: string }) => {
        restoredOperationIds.push(operation.operationId);
        observeRestore?.();
        await restoreReleased;
      },
    );
    const ports = {
      mint: {
        inspect: async (operation: { operationId: string }) => {
          inspectedOperationIds.push(operation.operationId);
          return { kind: "prepared-spent-restorable" as const };
        },
        restoreExactPersistedOutputs,
        resumeExactPreparedOperation: async () => {
          throw new Error("spent operation must restore, not resume");
        },
      },
      transport: {
        joinTrade: async () => undefined,
        sendCipher: async () => undefined,
      },
      clock: { nowMs: () => 1 },
      hashCiphertext: async () => "0".repeat(64),
    };

    await withSerializedWebLocks(async () => {
      const secondTabDb = new BitcasterDB();
      await secondTabDb.open();
      const firstTab = recoverGuiDurableTradeSession("trade-dexie", ports);
      await restoreStarted;
      const secondTab = recoverGuiDurableTradeSession(
        "trade-dexie",
        ports,
        secondTabDb,
      );
      try {
        releaseRestore?.();
        await Promise.all([firstTab, secondTab]);
      } finally {
        secondTabDb.close();
      }
    });

    expect(restoreExactPersistedOutputs).toHaveBeenCalledTimes(1);
    expect(inspectedOperationIds).toEqual([durableOperationId]);
    expect(restoredOperationIds).toEqual([durableOperationId]);
    expect((await db.proofOperations.get(nativeOperationId))?.state).toBe(
      "completed",
    );
    expect(
      (await db.swapSessions.get("trade-dexie"))?.session.proofOperations[0]
        ?.state,
    ).toBe("reconciled");
  });
});
