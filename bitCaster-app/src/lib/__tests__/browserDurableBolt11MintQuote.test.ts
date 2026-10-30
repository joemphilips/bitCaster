// @vitest-environment node
import "fake-indexeddb/auto";
import {
  createEncryptedWalletBackupOwnerCurrentHead,
  collectEncryptedWalletBackupOwnerDescriptorPages,
  enumerateEncryptedWalletBackupOwnerDescriptorPages,
} from "@bitcaster/client-sdk/encryptedWalletBackupOwnerHead";
import { EncryptedWalletBackupOwnerDexieAuthorityStore } from "@/stores/encrypted-wallet-backup-owner-db";

import Dexie from "dexie";
import {
  OutputData,
  Keyset,
  deriveKeysetId,
  Wallet as CashuWallet,
  Mint as CashuMint,
  type CounterSource,
} from "@cashu/cashu-ts";
import {
  createDurableBolt11MintQuote,
  type DurableBolt11MintQuote,
} from "@bitcaster/client-sdk/durableBolt11MintQuote";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BitcasterDB, getProofOperation, prepareProofOperation } from "@/stores/proof-db";
import { BrowserWalletCounterDexieStore } from "@/stores/browser-wallet-counter-db";
import { browserWalletDatabaseName } from "../browserWalletProfile";
import { browserWalletScope } from "../browserCtfRangeOrderSource";

const requireNewWritePermission = vi.hoisted(() =>
  vi.fn(async (_input: { database: BitcasterDB; scopeId: string }): Promise<void> => undefined),
);

vi.mock("../browserWalletNewWritePermission", () => ({
  requireBrowserWalletNewWritePermission: requireNewWritePermission,
}));

const mocks = vi.hoisted(() => {
  const wallet = {
    mint: { mintUrl: "https://mint.test" },
    createMintQuote: vi.fn(),
    prepareMint: vi.fn(),
    checkMintQuote: vi.fn(),
    completeMint: vi.fn(),
    getKeyset: vi.fn(),
  };
  let context: any;
  let source: CounterSource;
  const privateFactory = vi.fn(async (input: { counterSource: CounterSource }) => {
    source = input.counterSource;
    return wallet;
  });
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
    privateFactory,
    source: () => source,
    attachSource: (value: CounterSource) => {
      source = value;
    },
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
  createUncachedWalletForMnemonicUnit: mocks.privateFactory,
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

const SCOPE = browserWalletScope(new Uint8Array(64)).scopeId;
const MINT_URL = "https://mint.test";
const UNIT = "sat";
const KEYS = {
  "1": "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  "4": "02c6047f9441ed7d6d3045406e95c07cd85aebdb516f55814a08a6e08c46b3e47d4",
  "32": "02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9",
  "64": "02e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13",
};
const KEYSET_ID = deriveKeysetId(KEYS, { unit: "sat", versionByte: 1 });
const FOREIGN_KEYSET_ID = `01${"22".repeat(32)}`;
const PROOFS = [{ id: KEYSET_ID, amount: 100, secret: "output-1", C: "proof-C" }] as never;
const databases: BitcasterDB[] = [];

beforeEach(async () => {
  requireNewWritePermission.mockReset();
  requireNewWritePermission.mockResolvedValue(undefined);
  mocks.privateFactory.mockClear();
  mocks.privateFactory.mockImplementation(async (input) => {
    mocks.attachSource(input.counterSource);
    return mocks.wallet;
  });
  const keyset = new Keyset(KEYSET_ID, UNIT, true, 0);
  keyset.keys = KEYS;
  mocks.wallet.getKeyset.mockReturnValue(keyset);
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
    const range = await mocks.source().reserve(KEYSET_ID, 1);
    options?.onCountersReserved?.({
      keysetId: KEYSET_ID,
      ...range,
      next: range.start + range.count,
    });
    return mintPreview("quote-1", "output-1");
  });
  mocks.wallet.checkMintQuote.mockResolvedValue({ state: "UNPAID" });
  mocks.wallet.completeMint.mockResolvedValue(PROOFS);
  mocks.restoreExactMintOutputs.mockResolvedValue(PROOFS);
  const database = new BitcasterDB(browserWalletDatabaseName(SCOPE));
  const counters = new BrowserWalletCounterDexieStore({ database, scopeId: SCOPE });
  await counters.restoreInContext(
    { mintUrl: MINT_URL, unit: UNIT },
    KEYSET_ID,
    7,
    false,
    () => undefined,
  );
  databases.push(database);
  let activeScope = SCOPE;
  mocks.setContext({
    activeMintUrl: MINT_URL,
    database,
    mnemonic: "seed words",
    scopeId: SCOPE,
    seed: new Uint8Array(32),
    lockManager: {
      request: async (_name: string, _options: LockOptions, action: () => Promise<unknown>) =>
        action(),
    },
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
  vi.unstubAllEnvs();
  await Promise.all(
    databases.splice(0).map(async (database) => {
      database.close();
      await database.delete();
    }),
  );
});

describe("browser durable BOLT11 mint quote coordinator", () => {
  it("refuses a new quote before invoice or output preparation", async () => {
    requireNewWritePermission.mockRejectedValueOnce(
      new Error(
        "Another browser changed this wallet. Reload to start recovery before making a new wallet change.",
      ),
    );

    await expect(
      createBrowserDurableBolt11MintQuote({ amount: 100, mintUrl: MINT_URL, unit: UNIT }),
    ).rejects.toThrow("Another browser changed this wallet");

    expect(mocks.wallet.createMintQuote).not.toHaveBeenCalled();
    expect(mocks.wallet.prepareMint).not.toHaveBeenCalled();
    expect(await mocks.context().database.mintQuotes.count()).toBe(0);
  });

  it("checks actual owner-enabled permission inside the joint readwrite transaction", async () => {
    const permission = await vi.importActual<typeof import("../browserWalletNewWritePermission")>(
      "../browserWalletNewWritePermission",
    );
    vi.stubEnv("VITE_ENCRYPTED_BACKUP_REALM", "backup.example");
    vi.stubEnv("VITE_ENCRYPTED_BACKUP_SIGNED_ORIGIN", "https://backup.example");
    vi.stubEnv("VITE_ENCRYPTED_BACKUP_RECEIPT_KEY_ID", "55".repeat(16));
    vi.stubEnv(
      "VITE_ENCRYPTED_BACKUP_RECEIPT_PUBLIC_KEY",
      "531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337",
    );
    const context = mocks.context();
    const session = permission.beginBrowserWalletBackupAuthenticationSession({
      database: context.database,
      scopeId: SCOPE,
      realm: "backup.example",
    });
    expect(session.markOwnerAuthenticated("aa".repeat(32), 1, "bb".repeat(32))).toBe(true);
    await acceptEmptyOwnerHead();
    requireNewWritePermission.mockImplementation(permission.requireBrowserWalletNewWritePermission);
    const table = context.database.encryptedWalletBackupOwnerAcceptedHeads;
    const original = table.get.bind(table);
    const modes: string[] = [];
    const spy = vi.spyOn(table, "get").mockImplementation((...args: unknown[]) => {
      modes.push(Dexie.currentTransaction!.idbtrans.mode);
      return original(...(args as [never]));
    });
    try {
      await createBrowserDurableBolt11MintQuote({ amount: 100, mintUrl: MINT_URL, unit: UNIT });
      expect(modes).toContain("readwrite");
    } finally {
      spy.mockRestore();
      session.stop();
    }
  });

  it.each(["draft", "quote-add"])(
    "refuses an owner authentication session switch during %s",
    async (stage) => {
      const permission = await vi.importActual<typeof import("../browserWalletNewWritePermission")>(
        "../browserWalletNewWritePermission",
      );
      vi.stubEnv("VITE_ENCRYPTED_BACKUP_REALM", "backup.example");
      vi.stubEnv("VITE_ENCRYPTED_BACKUP_SIGNED_ORIGIN", "https://backup.example");
      vi.stubEnv("VITE_ENCRYPTED_BACKUP_RECEIPT_KEY_ID", "55".repeat(16));
      vi.stubEnv(
        "VITE_ENCRYPTED_BACKUP_RECEIPT_PUBLIC_KEY",
        "531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337",
      );
      const context = mocks.context();
      const session = permission.beginBrowserWalletBackupAuthenticationSession({
        database: context.database,
        scopeId: SCOPE,
        realm: "backup.example",
      });
      session.markOwnerAuthenticated("aa".repeat(32), 1, "bb".repeat(32));
      await acceptEmptyOwnerHead();
      requireNewWritePermission.mockImplementation(
        permission.requireBrowserWalletNewWritePermission,
      );
      const before = await quoteFacts();
      const prepare = mocks.wallet.prepareMint.getMockImplementation()!;
      const suspend = () => {
        session.markPending();
      };
      if (stage === "draft")
        mocks.wallet.prepareMint.mockImplementationOnce(async (...args) => {
          const preview = await prepare(...args);
          suspend();
          return preview;
        });
      else context.database.mintQuotes.hook("creating", suspend);
      try {
        await expect(
          createBrowserDurableBolt11MintQuote({ amount: 100, mintUrl: MINT_URL, unit: UNIT }),
        ).rejects.toThrow("authenticating");
        expect(await quoteFacts()).toEqual(before);
      } finally {
        context.database.mintQuotes.hook("creating").unsubscribe(suspend);
        session.stop();
      }
    },
  );

  it("constructs real default NUT13 outputs at zero and nonzero without touching durable counters before commit", async () => {
    const database = mocks.context().database as BitcasterDB;
    await database.walletCounterCursors.clear();
    const drafts = useRealPrivateWallet();
    let next = 0;
    mocks.wallet.createMintQuote.mockImplementation(async () => ({
      quote: `actual-${++next}`,
      request: `invoice-${next}`,
      unit: UNIT,
      amount: 100,
      state: "UNPAID",
      expiry: 50,
    }));
    for (const expected of [3, 6]) {
      const result = await createBrowserDurableBolt11MintQuote({
        amount: 100,
        mintUrl: MINT_URL,
        unit: UNIT,
      });
      const record = await getProofOperation(result.quote.walletMintOperationId, database);
      expect(record!.metadata.counterStart).toBe(expected - 3);
      expect(record!.metadata.counterCount).toBe(3);
      expect((await database.walletCounterCursors.get([SCOPE, KEYSET_ID]))!.next).toBe(expected);
    }
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).not.toEqual(drafts[1]);
  });

  it.each(["counter-written", "journal-bound"])(
    "rolls back complete quote/counter/desired authority after %s failure",
    async (phase) => {
      useRealPrivateWallet();
      const before = await quoteFacts();
      mocks.context().injectPreparationFault = (point: string) => {
        if (point === phase) throw new Error("atomic quote failure");
      };
      await expect(
        createBrowserDurableBolt11MintQuote({ amount: 100, mintUrl: MINT_URL, unit: UNIT }),
      ).rejects.toThrow("atomic quote failure");
      expect(await quoteFacts()).toEqual(before);
    },
  );

  it("aborts the final quote write when the captured profile changes during add", async () => {
    useRealPrivateWallet();
    const context = mocks.context();
    const before = await quoteFacts();
    const changeProfile = () => {
      context.switchProfile();
    };
    context.database.mintQuotes.hook("creating", changeProfile);
    try {
      await expect(
        createBrowserDurableBolt11MintQuote({ amount: 100, mintUrl: MINT_URL, unit: UNIT }),
      ).rejects.toThrow("profile changed");
      expect(await quoteFacts()).toEqual(before);
    } finally {
      context.database.mintQuotes.hook("creating").unsubscribe(changeProfile);
    }
  });

  it("refuses a missing recovery association without creating one or reserving outputs", async () => {
    const context = mocks.context();
    await context.database.walletCounterAssociations.clear();
    const before = await quoteFacts();
    await expect(
      createBrowserDurableBolt11MintQuote({ amount: 100, mintUrl: MINT_URL, unit: UNIT }),
    ).rejects.toMatchObject({ code: "recovery_incomplete" });
    expect(await quoteFacts()).toEqual(before);
    expect(mocks.privateFactory).not.toHaveBeenCalled();
  });

  it.each(["quote", "journal"])(
    "refuses a partial %s pair during uncertain commit readback",
    async (missing) => {
      useRealPrivateWallet();
      const context = mocks.context();
      const database = context.database as BitcasterDB;
      let uncertain = false;
      context.injectPreparationFault = (point: string) => {
        if (point === "after-commit") {
          uncertain = true;
          throw new Error("uncertain partial pair");
        }
      };
      const original = database.transaction.bind(database);
      const intercepted = ((...args: unknown[]) => {
        if (uncertain && args[0] === "r") {
          uncertain = false;
          return Dexie.Promise.resolve().then(async () => {
            if (missing === "quote") await database.mintQuotes.clear();
            else await database.proofOperations.clear();
            return original(...(args as Parameters<typeof database.transaction>));
          });
        }
        return original(...(args as Parameters<typeof database.transaction>));
      }) as typeof database.transaction;
      database.transaction = intercepted;
      try {
        await expect(
          createBrowserDurableBolt11MintQuote({ amount: 100, mintUrl: MINT_URL, unit: UNIT }),
        ).rejects.toThrow(
          missing === "quote" ? "binding is incomplete" : "wallet operation is absent",
        );
        expect(mocks.wallet.createMintQuote).toHaveBeenCalledOnce();
        expect((await database.walletCounterCursors.get([SCOPE, KEYSET_ID]))!.next).toBe(10);
      } finally {
        database.transaction = original;
      }
    },
  );

  it("returns exact saved quote after lost COMMIT reply without a second range", async () => {
    useRealPrivateWallet();
    mocks.context().injectPreparationFault = (point: string) => {
      if (point === "after-commit") throw new Error("lost COMMIT reply");
    };
    const result = await createBrowserDurableBolt11MintQuote({
      amount: 100,
      mintUrl: MINT_URL,
      unit: UNIT,
    });
    expect((await mocks.context().database.walletCounterCursors.get([SCOPE, KEYSET_ID])).next).toBe(
      10,
    );
    expect(mocks.wallet.createMintQuote).toHaveBeenCalledOnce();
    expect(
      await getProofOperation(result.quote.walletMintOperationId, mocks.context().database),
    ).toBeDefined();
  });

  it("keeps one remote quote across exactly three real counter conflicts", async () => {
    useRealPrivateWallet();
    let attempts = 0;
    const counters = new BrowserWalletCounterDexieStore({
      database: mocks.context().database,
      scopeId: SCOPE,
    });
    mocks.context().observePrepared = async () => {
      attempts++;
      await counters.reserveInContext({ mintUrl: MINT_URL, unit: UNIT }, KEYSET_ID, 1, true);
    };
    await expect(
      createBrowserDurableBolt11MintQuote({ amount: 100, mintUrl: MINT_URL, unit: UNIT }),
    ).rejects.toBeInstanceOf(Error);
    expect(attempts).toBe(3);
    expect(mocks.wallet.createMintQuote).toHaveBeenCalledOnce();
    expect(await mocks.context().database.mintQuotes.count()).toBe(0);
    expect(await mocks.context().database.proofOperations.count()).toBe(0);
    expect((await mocks.context().database.walletCounterCursors.get([SCOPE, KEYSET_ID])).next).toBe(
      10,
    );
  });

  it("selects a differing committed quote winner before comparing the losing snapshot", async () => {
    const drafts = useRealPrivateWallet();
    const context = mocks.context();
    const counters = new BrowserWalletCounterDexieStore({
      database: context.database,
      scopeId: SCOPE,
    });
    let winner: Awaited<ReturnType<typeof createBrowserDurableBolt11MintQuote>> | undefined;
    context.observePrepared = async () => {
      context.observePrepared = undefined;
      await counters.reserveInContext({ mintUrl: MINT_URL, unit: UNIT }, KEYSET_ID, 1, true);
      winner = await createBrowserDurableBolt11MintQuote({
        amount: 100,
        mintUrl: MINT_URL,
        unit: UNIT,
      });
    };
    const result = await createBrowserDurableBolt11MintQuote({
      amount: 100,
      mintUrl: MINT_URL,
      unit: UNIT,
    });
    expect(result).toEqual(winner);
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).not.toEqual(drafts[1]);
    const record = await getProofOperation(result.quote.walletMintOperationId, context.database);
    expect(
      (record!.metadata.durableWalletOperation as any).preview.outputData.map(
        (output: any) => output.blindedMessage.B_,
      ),
    ).toEqual(drafts[1]);
    expect((await context.database.walletCounterCursors.get([SCOPE, KEYSET_ID])).next).toBe(11);
  });

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
    ).rejects.toThrow("binding is incomplete");
    expect(await mocks.context().database.mintQuotes.count()).toBe(0);
  });

  it("selects a repeated quote saved output authority over a different private draft", async () => {
    const first = await createBrowserDurableBolt11MintQuote({
      amount: 100,
      mintUrl: MINT_URL,
      unit: UNIT,
    });
    mocks.wallet.prepareMint.mockImplementationOnce(async (_method, _amount, _quote, options) => {
      const range = await mocks.source().reserve(KEYSET_ID, 1);
      options?.onCountersReserved?.({
        keysetId: KEYSET_ID,
        ...range,
        next: range.start + range.count,
      });
      return mintPreview("quote-1", "output-conflict");
    });

    await expect(
      createBrowserDurableBolt11MintQuote({ amount: 100, mintUrl: MINT_URL, unit: UNIT }),
    ).resolves.toEqual({ quote: first.quote, invoiceRequest: first.invoiceRequest });
  });

  it("recovers PAID quotes through their exact stored output plan", async () => {
    const created = await createBrowserDurableBolt11MintQuote({
      amount: 100,
      mintUrl: MINT_URL,
      unit: UNIT,
    });
    mocks.wallet.checkMintQuote.mockResolvedValueOnce({ state: "PAID" });
    requireNewWritePermission.mockClear();
    requireNewWritePermission.mockRejectedValue(
      new Error(
        "Another browser changed this wallet. Reload to start recovery before making a new wallet change.",
      ),
    );

    expect(await recoverBrowserDurableBolt11MintQuotes()).toEqual({ pending: 0, hasMore: false });
    expect(requireNewWritePermission).not.toHaveBeenCalled();
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
    mocks.wallet.checkMintQuote
      .mockResolvedValueOnce({ quote: "quote-1", state: "ISSUED" })
      .mockResolvedValueOnce({ quote: "quote-1", state: "ISSUED" });
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

async function quoteFacts() {
  const database = mocks.context().database as BitcasterDB;
  const tables = [
    database.mintQuotes,
    database.proofOperations,
    database.walletCounterAssociations,
    database.walletCounterCursors,
    database.encryptedWalletBackupV2DesiredAssets,
  ];
  return database.transaction("r", tables, async () =>
    Object.fromEntries(
      await Promise.all(
        tables.map(async (table) => [
          table.name,
          (await table.toArray()).map((row) => JSON.stringify(row)).sort(),
        ]),
      ),
    ),
  );
}

async function acceptEmptyOwnerHead() {
  const context = {
    ownerScopeId: "aa".repeat(32),
    realm: "backup.example",
    walletId: SCOPE.slice("custody:wallet:".length),
    enrollmentEpoch: 1,
  };
  const head = createEncryptedWalletBackupOwnerCurrentHead({
    ...context,
    headVersion: 0,
    bundles: [],
  });
  const evidence = collectEncryptedWalletBackupOwnerDescriptorPages(
    enumerateEncryptedWalletBackupOwnerDescriptorPages({ head, bundles: [] }),
    context,
  );
  const store = new EncryptedWalletBackupOwnerDexieAuthorityStore({
    database: mocks.context().database,
    scopeId: SCOPE,
    ...context,
    requestAuthPublicKey: "bb".repeat(32),
    isCurrent: () => true,
  });
  expect(await store.acceptCurrentHead({ expectedHeadVersion: null, evidence })).toBe("accepted");
}

function useRealPrivateWallet() {
  const drafts: string[][] = [];
  mocks.privateFactory.mockImplementation(async (input) => {
    const mint = new CashuMint(MINT_URL);
    mint.getInfo = async () => ({
      name: "test",
      pubkey: KEYS["1"],
      version: "test",
      contact: [],
      nuts: {
        "4": {
          methods: [{ method: "bolt11", unit: UNIT, min_amount: 1, max_amount: 1000000 }],
          disabled: false,
        },
        "5": { methods: [], disabled: false },
      },
    });
    mint.getKeySets = async () => ({
      keysets: [{ id: KEYSET_ID, unit: UNIT, active: true, input_fee_ppk: 0 }],
    });
    mint.getKeys = async () => ({ keysets: [{ id: KEYSET_ID, unit: UNIT, keys: KEYS }] });
    const wallet = new CashuWallet(mint, {
      unit: UNIT,
      bip39seed: mocks.context().seed,
      counterSource: input.counterSource,
    });
    await wallet.loadMint();
    const prepare = wallet.prepareMint.bind(wallet);
    wallet.prepareMint = async (...args) => {
      const result = await prepare(...args);
      drafts.push(result.outputData.map((output) => output.blindedMessage.B_));
      return result;
    };
    return wallet as unknown as typeof mocks.wallet;
  });
  return drafts;
}
