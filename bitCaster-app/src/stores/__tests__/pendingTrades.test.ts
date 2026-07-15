import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearGuiPendingTradeCache,
  getCurrentGuiPendingTrade,
  isCurrentGuiPendingTrade,
  loadGuiPendingTrades,
  persistGuiPendingTrade,
  removeGuiPendingTrade,
  replaceGuiPendingTradeCache,
  type PendingTrade,
  type PendingTradeRecord,
  usePendingTradesStore,
} from "../pendingTrades";
import { configureGuiWalletIdProvider, db } from "../proof-db";

const WALLET_A = "aa".repeat(32);
const WALLET_B = "bb".repeat(32);

function makeTrade(
  orderId: string,
  overrides: Partial<PendingTrade> = {},
): PendingTrade {
  return {
    orderId,
    marketId: "cond-Alice",
    clientOrderId: `client-${orderId}`,
    submittedAt: 1_700_000_000_000,
    baseAsset: "sat",
    divisibility: 1_000,
    side: "Buy",
    tokenSide: "Outcome",
    priceSubunits: 500,
    amountSubunits: 1_000,
    timeInForce: "GTC",
    recoveryAttempt: 0,
    ...overrides,
  };
}

describe("wallet-scoped pending trade authority", () => {
  let activeWalletId = WALLET_A;

  beforeEach(async () => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: async <T>(
          _name: string,
          _options: LockOptions,
          callback: () => Promise<T>,
        ) => callback(),
      },
    });
    activeWalletId = WALLET_A;
    configureGuiWalletIdProvider(() => activeWalletId);
    clearGuiPendingTradeCache();
    db.close();
    await db.delete();
    await db.open();
  });

  afterEach(async () => {
    delete (navigator as { locks?: LockManager }).locks;
    clearGuiPendingTradeCache();
    db.close();
    await db.delete();
  });

  it("hides A while B is active and restores A after seed re-entry and reload", async () => {
    const tradeA = await persistGuiPendingTrade(makeTrade("shared-order"));
    expect(getCurrentGuiPendingTrade(tradeA.orderId)).toEqual(tradeA);

    activeWalletId = WALLET_B;
    clearGuiPendingTradeCache();
    replaceGuiPendingTradeCache(WALLET_B, await loadGuiPendingTrades(WALLET_B));
    expect(getCurrentGuiPendingTrade(tradeA.orderId)).toBeUndefined();
    expect(isCurrentGuiPendingTrade(tradeA)).toBe(false);

    const tradeB = await persistGuiPendingTrade(
      makeTrade("shared-order", { marketId: "cond-Bob" }),
    );
    expect(getCurrentGuiPendingTrade(tradeB.orderId)).toEqual(tradeB);

    // A stale callback cannot delete or expose either wallet's current row.
    await expect(removeGuiPendingTrade(tradeA)).rejects.toThrow(
      "GUI wallet changed while awaiting custody ownership",
    );
    expect(await db.pendingTrades.get([WALLET_A, tradeA.orderId])).toEqual(
      tradeA,
    );
    expect(await db.pendingTrades.get([WALLET_B, tradeB.orderId])).toEqual(
      tradeB,
    );

    activeWalletId = WALLET_A;
    usePendingTradesStore.setState({ walletId: null, byOrderId: {} });
    db.close();
    await db.open();
    replaceGuiPendingTradeCache(WALLET_A, await loadGuiPendingTrades(WALLET_A));

    expect(getCurrentGuiPendingTrade(tradeA.orderId)).toEqual(tradeA);
    expect(getCurrentGuiPendingTrade(tradeB.orderId)).toEqual(tradeA);
    expect(isCurrentGuiPendingTrade(tradeB)).toBe(false);
  });

  it("rejects a conflicting duplicate and malformed physical authority", async () => {
    const current = await persistGuiPendingTrade(makeTrade("order-1"));
    await expect(
      persistGuiPendingTrade(makeTrade("order-1", { marketId: "cond-Bob" })),
    ).rejects.toThrow("conflicts with existing authority");

    const malformed = { ...current, submittedAt: -1 } as PendingTradeRecord;
    await db.pendingTrades.put(malformed);
    await expect(loadGuiPendingTrades(WALLET_A)).rejects.toThrow(
      "Pending trade authority is invalid",
    );
  });

  it("requires a complete row and a unique wallet-scoped client order id", async () => {
    const current = await persistGuiPendingTrade(makeTrade("order-1"));
    await expect(
      persistGuiPendingTrade(
        makeTrade("order-2", { clientOrderId: current.clientOrderId }),
      ),
    ).rejects.toBeDefined();

    const { baseAsset: _baseAsset, ...incomplete } = makeTrade("incomplete");
    await db.pendingTrades.put({
      ...incomplete,
      walletId: WALLET_A,
      recoveryAttempt: 0,
    } as PendingTradeRecord);
    await expect(loadGuiPendingTrades(WALLET_A)).rejects.toThrow(
      "Pending trade authority is invalid",
    );
  });

  it.each([" SAT ", "btc"])(
    "rejects noncanonical or unknown pending-trade base asset %s",
    async (baseAsset) => {
      await expect(
        persistGuiPendingTrade(makeTrade("invalid-base-asset", { baseAsset })),
      ).rejects.toThrow("Pending trade authority is invalid");
    },
  );

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid pending-trade divisibility %s",
    async (divisibility) => {
      await expect(
        persistGuiPendingTrade(
          makeTrade("invalid-divisibility", { divisibility }),
        ),
      ).rejects.toThrow("Pending trade authority is invalid");
    },
  );

  it("never admits stale A recovery effects after switching to B", async () => {
    const tradeA = await persistGuiPendingTrade(makeTrade("order-a"));
    const effects = {
      pubkey: vi.fn(),
      mint: vi.fn(),
      proof: vi.fn(),
      cipher: vi.fn(),
    };

    activeWalletId = WALLET_B;
    clearGuiPendingTradeCache();
    replaceGuiPendingTradeCache(WALLET_B, await loadGuiPendingTrades(WALLET_B));
    if (isCurrentGuiPendingTrade(tradeA)) {
      effects.pubkey();
      effects.mint();
      effects.proof();
      effects.cipher();
    }

    expect(effects.pubkey).not.toHaveBeenCalled();
    expect(effects.mint).not.toHaveBeenCalled();
    expect(effects.proof).not.toHaveBeenCalled();
    expect(effects.cipher).not.toHaveBeenCalled();
  });
});
