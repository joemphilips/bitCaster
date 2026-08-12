// @vitest-environment node
import "fake-indexeddb/auto";
import { OutputData } from "@cashu/cashu-ts";
import {
  createDurableBolt11MintQuote,
  type DurableBolt11MintQuote,
} from "@bitcaster/client-sdk/durableBolt11MintQuote";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BitcasterDB, getProofOperation, prepareProofOperation } from "@/stores/proof-db";

const mocks = vi.hoisted(() => {
  const wallet = {
    createMintQuote: vi.fn(),
    prepareMint: vi.fn(),
    checkMintQuote: vi.fn(),
    completeMint: vi.fn(),
  };
  let context: any;
  const restoreExactMintOutputs = vi.fn();
  const waitForMintQuotePaidForUnit = vi.fn();
  const browserDurableWalletMintStore = vi.fn((input: any) => ({
    loadOperation: async (operationId: string) => {
      const record = await input.context.database.proofOperations.get(operationId);
      if (!record) return null;
      const operation = record.metadata.durableWalletOperation;
      return {
        operation,
        state: record.state === "completed" ? "completed" : "prepared",
        result: record.resultProofs?.receive ? { receive: record.resultProofs.receive } : null,
      };
    },
    persistCompletedResult: async ({ operation, result }: any) => {
      await input.context.database.proofOperations.update(operation.operationId, {
        state: "completed",
        resultProofs: { receive: result.receive },
      });
      return "completed" as const;
    },
  }));
  return {
    wallet,
    context: () => context,
    setContext: (value: unknown) => {
      context = value;
    },
    restoreExactMintOutputs,
    waitForMintQuotePaidForUnit,
    browserDurableWalletMintStore,
  };
});

vi.mock("@/stores/wallet", () => ({
  getWalletForMnemonicUnit: vi.fn(async () => mocks.wallet),
}));

vi.mock("@/lib/cashu", () => ({
  captureBrowserMintPersistenceContext: () => mocks.context(),
  browserDurableWalletMintStore: mocks.browserDurableWalletMintStore,
  restoreExactMintOutputs: mocks.restoreExactMintOutputs,
  waitForMintQuotePaidForUnit: mocks.waitForMintQuotePaidForUnit,
}));

import {
  BROWSER_BOLT11_MINT_RECOVERY_LIMIT,
  createBrowserDurableBolt11MintQuote,
  hideBrowserDurableBolt11MintQuote,
  recoverBrowserDurableBolt11MintQuotes,
  recoverBrowserDurableBolt11MintQuotesInPass,
  subscribeActiveBrowserDurableBolt11MintQuote,
} from "../browserDurableBolt11MintQuote";

const SCOPE = "scope-browser-bolt11";
const MINT_URL = "https://mint.test";
const UNIT = "sat";
const KEYSET_ID = `01${"11".repeat(32)}`;
const FOREIGN_KEYSET_ID = `01${"22".repeat(32)}`;
const PROOFS = [{ id: KEYSET_ID, amount: 100, secret: "output-1", C: "proof-C" }] as never;
const databases: BitcasterDB[] = [];

beforeEach(() => {
  mocks.wallet.createMintQuote.mockReset();
  mocks.wallet.prepareMint.mockReset();
  mocks.wallet.checkMintQuote.mockReset();
  mocks.wallet.completeMint.mockReset();
  mocks.restoreExactMintOutputs.mockReset();
  mocks.waitForMintQuotePaidForUnit.mockReset();
  mocks.waitForMintQuotePaidForUnit.mockResolvedValue(() => undefined);
  mocks.browserDurableWalletMintStore.mockClear();
  mocks.wallet.createMintQuote.mockResolvedValue({
    quote: "quote-1",
    request: "lnbc1invoice",
    expiry: 50,
  });
  mocks.wallet.prepareMint.mockImplementation(async (_method, _amount, _quote, options) => {
    options?.onCountersReserved?.({ keysetId: KEYSET_ID, start: 7, count: 1 });
    return mintPreview("quote-1", "output-1");
  });
  mocks.wallet.checkMintQuote.mockResolvedValue({ state: "UNPAID" });
  mocks.wallet.completeMint.mockResolvedValue(PROOFS);
  mocks.restoreExactMintOutputs.mockResolvedValue(PROOFS);
  const database = new BitcasterDB(`browser-bolt11-${crypto.randomUUID()}`);
  databases.push(database);
  let activeScope = SCOPE;
  mocks.setContext({
    activeMintUrl: MINT_URL,
    database,
    mnemonic: "seed words",
    scopeId: SCOPE,
    seed: new Uint8Array(32),
    requireCapturedProfile: () => {
      if (activeScope !== SCOPE)
        throw new Error("The wallet profile changed during mint recovery.");
    },
    switchProfile: () => {
      activeScope = "scope-other";
    },
  });
});

afterEach(async () => {
  await Promise.all(
    databases.splice(0).map(async (database) => {
      database.close();
      await database.delete();
    }),
  );
});

describe("browser durable BOLT11 mint quote coordinator", () => {
  it("commits the quote and its exact wallet operation before returning the invoice", async () => {
    const result = await createBrowserDurableBolt11MintQuote({
      amount: 100,
      mintUrl: MINT_URL,
      unit: UNIT,
    });
    const database = mocks.context().database as BitcasterDB;
    const row = await database.mintQuotes.get([SCOPE, "bolt11", result.quote.quoteRecordId]);
    const operation = await getProofOperation(result.quote.walletMintOperationId, database);

    expect(result.invoiceRequest).toBe("lnbc1invoice");
    expect(row?.quote.walletMintOperationAuthority).not.toBeNull();
    expect(row?.recoveryState).toBe("pending");
    expect(operation?.state).toBe("prepared");
    expect(operation?.metadata).toMatchObject({
      keysetId: KEYSET_ID,
      counterStart: 7,
      counterCount: 1,
    });
  });

  it("rolls back the quote when its exact operation conflicts", async () => {
    const quote = quoteRecord("quote-1");
    await prepareProofOperation(
      {
        operationId: quote.walletMintOperationId,
        kind: "wallet-mint",
        mintUrl: MINT_URL,
        inputs: [{ id: FOREIGN_KEYSET_ID }] as never,
        outputs: {},
      },
      mocks.context().database,
    );

    await expect(
      createBrowserDurableBolt11MintQuote({ amount: 100, mintUrl: MINT_URL, unit: UNIT }),
    ).rejects.toThrow("already exists with different inputs");
    expect(await mocks.context().database.mintQuotes.count()).toBe(0);
  });

  it("rejects a repeated quote with a conflicting deterministic output plan", async () => {
    await createBrowserDurableBolt11MintQuote({ amount: 100, mintUrl: MINT_URL, unit: UNIT });
    mocks.wallet.prepareMint.mockImplementationOnce(async (_method, _amount, _quote, options) => {
      options?.onCountersReserved?.({ keysetId: KEYSET_ID, start: 8, count: 1 });
      return mintPreview("quote-1", "output-conflict");
    });

    await expect(
      createBrowserDurableBolt11MintQuote({ amount: 100, mintUrl: MINT_URL, unit: UNIT }),
    ).rejects.toThrow("authority conflicts");
  });

  it("recovers PAID quotes through their exact stored output plan", async () => {
    const created = await createBrowserDurableBolt11MintQuote({
      amount: 100,
      mintUrl: MINT_URL,
      unit: UNIT,
    });
    mocks.wallet.checkMintQuote.mockResolvedValueOnce({ state: "PAID" });

    expect(await recoverBrowserDurableBolt11MintQuotes()).toEqual({ pending: 0, hasMore: false });
    expect(mocks.wallet.completeMint).toHaveBeenCalledOnce();
    const replayed = mocks.wallet.completeMint.mock.calls[0]?.[0];
    const persisted = await getProofOperation(
      created.quote.walletMintOperationId,
      mocks.context().database,
    );
    expect(replayed.payload.quote).toBe("quote-1");
    expect(replayed.payload.outputs[0].B_).toBe(
      (persisted?.metadata.durableWalletOperation as any).preview.payload.outputs[0].B_,
    );
    expect(
      (
        await mocks
          .context()
          .database.mintQuotes.get([SCOPE, "bolt11", created.quote.quoteRecordId])
      )?.recoveryState,
    ).toBe("completed");
  });

  it("uses restore only for an ISSUED quote with the exact bound operation", async () => {
    const created = await createBrowserDurableBolt11MintQuote({
      amount: 100,
      mintUrl: MINT_URL,
      unit: UNIT,
    });
    mocks.wallet.checkMintQuote.mockResolvedValueOnce({ state: "ISSUED" });
    mocks.wallet.completeMint.mockRejectedValueOnce(duplicateOutputError());

    expect(await recoverBrowserDurableBolt11MintQuotes()).toEqual({ pending: 0, hasMore: false });
    expect(mocks.restoreExactMintOutputs).toHaveBeenCalledOnce();
    const persisted = await getProofOperation(
      created.quote.walletMintOperationId,
      mocks.context().database,
    );
    expect(mocks.restoreExactMintOutputs.mock.calls[0]?.[1]?.outputs[0]?.blindedMessage.B_).toBe(
      (persisted?.metadata.durableWalletOperation as any).preview.payload.outputs[0].B_,
    );
    expect(
      (await getProofOperation(created.quote.walletMintOperationId, mocks.context().database))
        ?.state,
    ).toBe("completed");
  });

  it("uses PAID waiter evidence to admit the bound operation without another NUT-04 check", async () => {
    const created = await createBrowserDurableBolt11MintQuote({
      amount: 100,
      mintUrl: MINT_URL,
      unit: UNIT,
    });
    const onResult = vi.fn();
    await subscribeActiveBrowserDurableBolt11MintQuote({ quote: created.quote, onResult });
    const paid = mocks.waitForMintQuotePaidForUnit.mock.calls[0]?.[1];

    await paid({ status: "PAID", quote: { state: "PAID" } });

    const row = await mocks
      .context()
      .database.mintQuotes.get([SCOPE, "bolt11", created.quote.quoteRecordId]);
    expect(mocks.wallet.checkMintQuote).not.toHaveBeenCalled();
    expect(row?.quote.observedState).toBe("PAID");
    expect(row?.recoveryState).toBe("completed");
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ status: "PAID" }));
  });

  it("retains UNPAID quotes after recording the current recovery pass", async () => {
    const created = await createBrowserDurableBolt11MintQuote({
      amount: 100,
      mintUrl: MINT_URL,
      unit: UNIT,
    });

    expect(await recoverBrowserDurableBolt11MintQuotes()).toEqual({ pending: 1, hasMore: false });
    const row = await mocks
      .context()
      .database.mintQuotes.get([SCOPE, "bolt11", created.quote.quoteRecordId]);
    expect(row?.quote.observedState).toBe("UNPAID");
    expect(row?.recoveryState).toBe("pending");
    expect(row?.lastRecoveryAttemptAtMs).toBeGreaterThan(0);
    expect(mocks.wallet.completeMint).not.toHaveBeenCalled();
  });

  it("checks each pending quote once per pass and checks it again in a later pass", async () => {
    const created = await createBrowserDurableBolt11MintQuote({
      amount: 100,
      mintUrl: MINT_URL,
      unit: UNIT,
    });

    expect(await recoverBrowserDurableBolt11MintQuotesInPass({ passCutoffMs: 10 })).toEqual({
      pending: 1,
      hasMore: false,
    });
    expect(await recoverBrowserDurableBolt11MintQuotesInPass({ passCutoffMs: 10 })).toEqual({
      pending: 0,
      hasMore: false,
    });
    expect(mocks.wallet.checkMintQuote).toHaveBeenCalledTimes(1);
    expect(
      (
        await mocks
          .context()
          .database.mintQuotes.get([SCOPE, "bolt11", created.quote.quoteRecordId])
      )?.lastRecoveryAttemptAtMs,
    ).toBe(10);

    expect(await recoverBrowserDurableBolt11MintQuotesInPass({ passCutoffMs: 11 })).toEqual({
      pending: 1,
      hasMore: false,
    });
    expect(mocks.wallet.checkMintQuote).toHaveBeenCalledTimes(2);
  });

  it("drains a paid quote after more than one page of earlier unpaid quotes", async () => {
    const created = await createBrowserDurableBolt11MintQuote({
      amount: 100,
      mintUrl: MINT_URL,
      unit: UNIT,
    });
    const before = pendingRowsBefore(created.quote.quoteRecordId, 65);
    await mocks.context().database.mintQuotes.bulkAdd(before);
    mocks.wallet.checkMintQuote.mockImplementation(async (quoteId) => ({
      state: quoteId === "quote-1" ? "PAID" : "UNPAID",
    }));

    expect(await recoverBrowserDurableBolt11MintQuotesInPass({ passCutoffMs: 20 })).toEqual({
      pending: BROWSER_BOLT11_MINT_RECOVERY_LIMIT,
      hasMore: true,
    });
    await recoverBrowserDurableBolt11MintQuotesInPass({ passCutoffMs: 20 });
    expect(
      (await getProofOperation(created.quote.walletMintOperationId, mocks.context().database))
        ?.state,
    ).toBe("completed");
  });

  it("completes quote recovery when the exact result was already admitted", async () => {
    const created = await createBrowserDurableBolt11MintQuote({
      amount: 100,
      mintUrl: MINT_URL,
      unit: UNIT,
    });
    await mocks.context().database.proofOperations.update(created.quote.walletMintOperationId, {
      state: "completed",
      resultProofs: { receive: PROOFS },
    });
    mocks.wallet.checkMintQuote.mockResolvedValueOnce({ state: "PAID" });

    expect(await recoverBrowserDurableBolt11MintQuotesInPass({ passCutoffMs: 30 })).toEqual({
      pending: 0,
      hasMore: false,
    });
    expect(mocks.wallet.completeMint).not.toHaveBeenCalled();
    expect(
      (
        await mocks
          .context()
          .database.mintQuotes.get([SCOPE, "bolt11", created.quote.quoteRecordId])
      )?.recoveryState,
    ).toBe("completed");
  });

  it("recovers a hidden paid quote without any UI continuation", async () => {
    const created = await createBrowserDurableBolt11MintQuote({
      amount: 100,
      mintUrl: MINT_URL,
      unit: UNIT,
    });
    await hideBrowserDurableBolt11MintQuote(created.quote.quoteRecordId);
    mocks.wallet.checkMintQuote.mockResolvedValueOnce({ state: "PAID" });

    await recoverBrowserDurableBolt11MintQuotes();
    const row = await mocks
      .context()
      .database.mintQuotes.get([SCOPE, "bolt11", created.quote.quoteRecordId]);
    expect(row?.quote.presentationState).toBe("hidden");
    expect(row?.recoveryState).toBe("completed");
    expect(mocks.wallet.completeMint).toHaveBeenCalledOnce();
  });

  it("does not persist a quote after a profile switch across quote creation", async () => {
    mocks.wallet.createMintQuote.mockImplementationOnce(async () => {
      mocks.context().switchProfile();
      return { quote: "quote-1", request: "lnbc1invoice" };
    });

    await expect(
      createBrowserDurableBolt11MintQuote({ amount: 100, mintUrl: MINT_URL, unit: UNIT }),
    ).rejects.toThrow("wallet profile changed");
    expect(await mocks.context().database.mintQuotes.count()).toBe(0);
    expect(await mocks.context().database.proofOperations.count()).toBe(0);
  });

  it("does not mutate an old profile quote after a recovery-time profile switch", async () => {
    const created = await createBrowserDurableBolt11MintQuote({
      amount: 100,
      mintUrl: MINT_URL,
      unit: UNIT,
    });
    mocks.wallet.checkMintQuote.mockImplementationOnce(async () => {
      mocks.context().switchProfile();
      return { state: "PAID" };
    });

    expect(await recoverBrowserDurableBolt11MintQuotes()).toEqual({ pending: 1, hasMore: false });
    const row = await mocks
      .context()
      .database.mintQuotes.get([SCOPE, "bolt11", created.quote.quoteRecordId]);
    expect(row?.quote.observedState).toBe("UNPAID");
    expect(row?.lastRecoveryAttemptAtMs).toBe(0);
    expect(mocks.wallet.completeMint).not.toHaveBeenCalled();
  });

  it("enumerates only one fair bounded page of pending current-scope rows", async () => {
    const database = mocks.context().database as BitcasterDB;
    await database.mintQuotes.bulkAdd(
      Array.from({ length: BROWSER_BOLT11_MINT_RECOVERY_LIMIT + 1 }, (_, index) =>
        pendingRow(index),
      ),
    );

    const result = await recoverBrowserDurableBolt11MintQuotes();

    expect(result).toEqual({ pending: BROWSER_BOLT11_MINT_RECOVERY_LIMIT, hasMore: true });
    expect(mocks.wallet.checkMintQuote).toHaveBeenCalledTimes(BROWSER_BOLT11_MINT_RECOVERY_LIMIT);
  });
});

function mintPreview(quote: string, output: string) {
  const data = OutputData.createSingleData("100", KEYSET_ID, output, 3n);
  return {
    method: "bolt11",
    payload: { quote, outputs: [data.blindedMessage] },
    outputData: [data],
    keysetId: KEYSET_ID,
    quote: { quote, expiry: 50 },
  } as never;
}

function quoteRecord(quoteId: string): DurableBolt11MintQuote {
  return createDurableBolt11MintQuote({
    mintUrl: MINT_URL,
    unit: UNIT,
    requestedAmount: "100",
    quoteId,
    invoiceRequest: `lnbc1${quoteId}`,
  });
}

function pendingRow(index: number) {
  const quote = quoteRecord(`pending-${index}`);
  return {
    scopeId: SCOPE,
    paymentMethod: "bolt11" as const,
    quoteRecordId: quote.quoteRecordId,
    observedState: "UNPAID" as const,
    recoveryState: "pending" as const,
    lastRecoveryAttemptAtMs: 0,
    quote,
  };
}

function pendingRowsBefore(targetQuoteRecordId: string, count: number) {
  const rows = [];
  for (let index = 0; rows.length < count; index += 1) {
    const row = pendingRow(index);
    if (row.quoteRecordId < targetQuoteRecordId) rows.push(row);
  }
  return rows;
}

function duplicateOutputError(): Error {
  return Object.assign(new Error("Blinded message already signed or pending"), {
    name: "MintOperationError",
    code: 11003,
    status: 400,
  });
}
