import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalSecpPoint } from "../../test/cashu-proof-fixtures";
import {
  getOrCreateAdmittedGuiPendingSwapIntents,
  submitAdmittedGuiPendingSwapIntents,
  type GuiPreTradeIntentRequest,
} from "../gui-pretrade-storage";
import { persistGuiPendingTrade } from "../pendingTrades";
import { db } from "../proof-db";
import { useWalletStore } from "../wallet";

const MNEMONIC = `${"abandon ".repeat(11)}about`;
const ORDER_ID = "order-pretrade";
const MARKET_ID = "condition-YES";
const DEADLINE = new Date(2_000_000_000_000).toISOString();

describe("GUI pre-trade storage coordinator", () => {
  beforeEach(async () => {
    installImmediateWebLocks();
    useWalletStore.setState({ mnemonic: MNEMONIC });
    db.close();
    await db.delete();
    await db.open();
    await persistPendingTrade();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete (navigator as { locks?: LockManager }).locks;
    db.close();
    await db.delete();
  });

  it("admits every reported fill before returning any pubkey intent", async () => {
    const intents = await getOrCreateAdmittedGuiPendingSwapIntents(requests());

    expect(intents.map(({ tradeId }) => tradeId)).toEqual([
      "trade-pretrade-1",
      "trade-pretrade-2",
    ]);
    expect(await db.swapIntents.count()).toBe(2);
    const accounting = await db.durableStorageAccounting.toCollection().first();
    expect(accounting?.state.revision).toBe(1);
    expect(accounting?.state.preTradeReservations).toHaveLength(2);
  });

  it("lets storage accounting decide admission for more than eight fills", async () => {
    const requested = requests(9);

    await expect(
      getOrCreateAdmittedGuiPendingSwapIntents(requested),
    ).resolves.toHaveLength(9);

    const accounting = await db.durableStorageAccounting.toCollection().first();
    expect(accounting?.state.preTradeReservations).toHaveLength(9);
  });

  it("submits no pubkey when the all-fill admission transaction fails", async () => {
    vi.spyOn(db.durableStorageAccounting, "put").mockRejectedValue(
      new DOMException("injected quota failure", "QuotaExceededError"),
    );
    const submit = vi.fn(async () => undefined);

    await expect(
      submitAdmittedGuiPendingSwapIntents(requests(), submit),
    ).rejects.toMatchObject({ name: "QuotaExceededError" });

    expect(submit).not.toHaveBeenCalled();
    expect(await db.swapIntents.count()).toBe(0);
    const accounting = await db.durableStorageAccounting.toCollection().first();
    expect(accounting?.state.revision).toBe(0);
    expect(accounting?.state.preTradeReservations).toHaveLength(0);
  });

  it("retains every intent when a later pubkey submission fails", async () => {
    const submit = vi
      .fn<(intent: { tradeId: string }) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("injected second submission failure"));

    await expect(
      submitAdmittedGuiPendingSwapIntents(requests(), submit),
    ).rejects.toThrow("injected second submission failure");

    expect(submit.mock.calls.map(([entry]) => entry.tradeId)).toEqual([
      "trade-pretrade-1",
      "trade-pretrade-2",
    ]);
    expect(await db.swapIntents.get("trade-pretrade-1")).toMatchObject({
      submitted: true,
    });
    expect(await db.swapIntents.get("trade-pretrade-2")).toMatchObject({
      submitted: false,
    });
    const accounting = await db.durableStorageAccounting.toCollection().first();
    expect(accounting?.state.preTradeReservations).toHaveLength(2);
  });

  it("fails closed when a replay loses one physical intent", async () => {
    const requested = requests();
    await getOrCreateAdmittedGuiPendingSwapIntents(requested);
    await db.swapIntents.delete(requested[0]!.tradeId);

    await expect(
      getOrCreateAdmittedGuiPendingSwapIntents(requested),
    ).rejects.toThrow("replay");

    expect(await db.swapIntents.count()).toBe(1);
  });
});

function requests(count = 2): GuiPreTradeIntentRequest[] {
  return Array.from({ length: count }, (_, index) => index + 1).map((index) => {
    const tradeId = `trade-pretrade-${index}`;
    return {
      tradeId,
      orderId: ORDER_ID,
      marketId: MARKET_ID,
      deadline: DEADLINE,
      create: () => ({
        tradeId,
        orderId: ORDER_ID,
        marketId: MARKET_ID,
        pubkey: canonicalSecpPoint(index),
        privkey: index.toString(16).padStart(64, "0"),
        deadline: DEADLINE,
        submitted: false,
      }),
    };
  });
}

async function persistPendingTrade(): Promise<void> {
  await persistGuiPendingTrade({
    orderId: ORDER_ID,
    marketId: MARKET_ID,
    clientOrderId: "client-pretrade",
    submittedAt: 1,
    baseAsset: "sat",
    divisibility: 10_000,
    side: "Sell",
    tokenSide: "Outcome",
    priceSubunits: 5_000,
    amountSubunits: 10_000,
    timeInForce: "GTC",
  });
}

function installImmediateWebLocks(): void {
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
}
