/**
 * P8 follow-up regression tests for `mintProofs` counter recovery.
 *
 * The bug we are guarding against:
 *
 * - CDK rejects re-used deterministic blinded outputs as a database
 *   duplicate. Older builds mislabeled that as `"Invoice already paid or
 *   pending"`; current builds expose `"Blinded message already signed or
 *   pending"` (`cdk-common/src/error.rs`, `Database(Duplicate)` →
 *   `ErrorCode::BlindedMessageAlreadySigned`).
 * - A stale deterministic counter can re-use outputs the mint already signed.
 *
 * The fix has two layers, both exercised here:
 *
 * 1. `mintProofs` catches the exact CDK error message, runs counter recovery
 *    against the active keyset, then retries `wallet.mintProofs` once.
 * 2. Non-recovery errors propagate unchanged so genuine LN payment failures
 *    are not swallowed by the recovery path.
 */

import { Amount, OutputData, getEncodedTokenV4 } from "@cashu/cashu-ts";
import {
  serializeDurableWalletMintOperation,
  toDurableCustodyProofOperationInput,
} from "@bitcaster/client-sdk/durableWalletOperation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toSeed } from "../bip39";

// Hoisted mocks — the cashu-ts wallet, the wallet store, and the proof DB
// are all swapped out per-test via these handles.
const mocks = vi.hoisted(() => {
  const keysetId = `01${"11".repeat(32)}`;
  const alternateKeysetId = `01${"22".repeat(32)}`;
  const wallet = {
    createMintQuote: vi.fn(),
    createMeltQuote: vi.fn(),
    prepareMint: vi.fn(),
    checkMintQuote: vi.fn(),
    completeMint: vi.fn(),
    send: vi.fn(),
    batchRestore: vi.fn(),
    prepareSwapToReceive: vi.fn(),
    completeSwap: vi.fn(),
    restore: vi.fn(),
    groupProofsByState: vi.fn(),
    mint: { getKeySets: vi.fn(), mintUrl: "https://mint.test" },
    getKeyset: vi.fn(),
  };
  const getWallet = vi.fn(async () => wallet);
  const store: {
    mnemonic: string;
    activeMintUrl: string;
    mints: { url: string; keysets?: { id: string; unit?: string }[] }[];
    getWallet: (url?: string) => Promise<unknown>;
    getWalletForUnit: (url?: string, unit?: string) => Promise<unknown>;
  } = {
    mnemonic: "seed words",
    activeMintUrl: "https://mint.test",
    mints: [{ url: "https://mint.test", keysets: [{ id: keysetId }] }],
    getWallet,
    getWalletForUnit: getWallet,
  };
  const setStateImpl = vi.fn((updater: unknown) => {
    if (typeof updater === "function") {
      const next = (updater as (s: typeof store) => Partial<typeof store>)(store);
      Object.assign(store, next);
    }
  });
  const addProofs = vi.fn(async (_p: unknown[]) => {});
  const restoredCounters: Record<string, number> = {};
  const restoreProofsAndAdvanceCounter = vi.fn(async (input: any) => {
    await addProofs(input.proofs);
    const current = restoredCounters[input.keysetId] ?? 0;
    const next = Math.max(current, input.restoredNext);
    restoredCounters[input.keysetId] = next;
    return { changed: next !== current, next };
  });
  const isWalletCounterRecoveryComplete = vi.fn(async () => false);
  const createBrowserWalletCounterSource = vi.fn(() => ({
    reserve: async (keysetId: string, count: number) => {
      const start = restoredCounters[keysetId] ?? 0;
      restoredCounters[keysetId] = start + count;
      return { start, count };
    },
  }));
  const createActiveBrowserWalletCounterSource = vi.fn(() => ({
    reserve: async (keysetId: string, count: number) => {
      const start = restoredCounters[keysetId] ?? 0;
      restoredCounters[keysetId] = start + count;
      return { start, count };
    },
  }));
  const proofOperations = new Map<string, any>();
  const prepareProofOperation = vi.fn(async (record: any) => {
    const prepared = { ...record, state: "prepared", metadata: record.metadata ?? {} };
    proofOperations.set(record.operationId, prepared);
    return prepared;
  });
  const markProofOperationCompleted = vi.fn(
    async (_operationId: string, _completion: { receive: { secret: string }[] }) => undefined,
  );
  const markProofOperationFailed = vi.fn(async () => undefined);
  const getProofOperations = vi.fn(async () => []);
  const admitBrowserReceivedProofs = vi.fn(async () => undefined);
  const requireNewWritePermission = vi.fn(async () => undefined);
  const verifyProofsForReceive = vi.fn();
  const profileLock = {
    held: false,
    events: [] as string[],
  };
  return {
    wallet,
    store,
    setStateImpl,
    addProofs,
    restoreProofsAndAdvanceCounter,
    isWalletCounterRecoveryComplete,
    restoredCounters,
    createBrowserWalletCounterSource,
    createActiveBrowserWalletCounterSource,
    getWallet,
    prepareProofOperation,
    proofOperations,
    markProofOperationCompleted,
    markProofOperationFailed,
    getProofOperations,
    admitBrowserReceivedProofs,
    requireNewWritePermission,
    verifyProofsForReceive,
    profileLock,
    keysetId,
    alternateKeysetId,
  };
});

vi.mock("@cashu/cashu-ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cashu/cashu-ts")>()),
  verifyProofsForReceive: mocks.verifyProofsForReceive,
}));

vi.mock("@/lib/browserCustodyProofReceive", () => ({
  admitBrowserReceivedProofs: mocks.admitBrowserReceivedProofs,
  admitBrowserReceivedProofsWithHeldProfileLock: mocks.admitBrowserReceivedProofs,
}));

vi.mock("@/lib/walletProfileLock", () => ({
  withWalletProfileLock: async (_scopeId: string, action: () => Promise<unknown>) => {
    if (mocks.profileLock.held) throw new Error("wallet profile lock is not reentrant");
    mocks.profileLock.held = true;
    mocks.profileLock.events.push("lock-enter");
    try {
      return await action();
    } finally {
      mocks.profileLock.events.push("lock-exit");
      mocks.profileLock.held = false;
    }
  },
}));

vi.mock("@/lib/browserWalletNewWritePermission", () => ({
  requireBrowserWalletNewWritePermission: mocks.requireNewWritePermission,
}));

vi.mock("@/stores/wallet", () => ({
  useWalletStore: {
    getState: () => mocks.store,
    setState: mocks.setStateImpl,
  },
  createBrowserWalletCounterSource: mocks.createBrowserWalletCounterSource,
  getWalletForMnemonicUnit: mocks.getWallet,
}));

vi.mock("@/stores/browser-wallet-counter-db", () => ({
  createActiveBrowserWalletCounterSource: mocks.createActiveBrowserWalletCounterSource,
}));

vi.mock("@/stores/proof-db", () => ({
  db: {
    tables: [],
    custodyProofs: { bulkGet: vi.fn(async () => []) },
    custodyProofBackupAuthorities: { bulkGet: vi.fn(async () => []) },
    transaction: async (_mode: string, _tables: unknown, action: () => Promise<unknown>) =>
      action(),
  },
  DURABLE_BOLT11_MINT_QUOTE_OPERATION_METADATA_KEY: "durableBolt11MintQuoteRecordId",
  addProofs: mocks.addProofs,
  addProofsIfMissing: mocks.addProofs,
  restoreProofsAndAdvanceCounter: mocks.restoreProofsAndAdvanceCounter,
  isWalletCounterRecoveryComplete: mocks.isWalletCounterRecoveryComplete,
  getProofOperations: mocks.getProofOperations,
  getProofOperation: vi.fn(
    async (operationId: string) => mocks.proofOperations.get(operationId) ?? null,
  ),
  prepareProofOperation: mocks.prepareProofOperation,
  markProofOperationCompleted: mocks.markProofOperationCompleted,
  markProofOperationFailed: mocks.markProofOperationFailed,
  removeProofs: vi.fn(),
}));

// `getWallet` is also defined in cashu.ts, but the mintProofs helper uses
// the module's own getWallet (resolved at call site). We replace the entire
// module's `getWallet` via a vitest spy in beforeEach.

import * as cashu from "../cashu";
import { setActiveBrowserWalletProfile } from "../browserWalletProfile";

const KEYSET_ID = mocks.keysetId;
const ALT_KEYSET_ID = mocks.alternateKeysetId;
const VALID_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const MINT_PROOFS = [{ id: KEYSET_ID, amount: 100, secret: "s1", C: "C1" }] as never;
const MODERN_KEYSET_ID = `01${"44".repeat(32)}`;

function mintPreview(keysetId = KEYSET_ID) {
  const output = OutputData.createSingleData("100", keysetId, "s1", 3n);
  return {
    method: "bolt11",
    payload: { quote: "q1", outputs: [output.blindedMessage] },
    outputData: [output],
    keysetId,
    quote: { quote: "q1" },
  } as never;
}

function recoveryProof(counter: number, amount = 50, keysetId = KEYSET_ID) {
  return {
    id: keysetId,
    amount,
    secret: new TextDecoder().decode(
      OutputData.createSingleDeterministicData(
        1,
        toSeed(VALID_MNEMONIC.split(/\s+/)),
        counter,
        keysetId,
      ).secret,
    ),
    C: `C${counter}`,
  };
}

// `MintOperationError`-shape helper: real cashu-ts errors carry `.name`,
// `.code` and `.status`. The structural sanity check in
// `isCdkDuplicateOutputsError` requires at least one to match, so the
// tests build their thrown errors via this helper rather than bare `Error`.
function cdkDuplicateError(message = "Blinded message already signed or pending"): Error {
  const e = new Error(message) as Error & {
    name: string;
    code: number;
    status: number;
  };
  e.name = "MintOperationError";
  e.code = message.includes("Blinded message") ? 11003 : 20006;
  e.status = 400;
  return e;
}

beforeEach(() => {
  mocks.wallet.createMintQuote.mockReset();
  mocks.wallet.createMeltQuote.mockReset();
  mocks.wallet.prepareMint.mockReset();
  mocks.wallet.checkMintQuote.mockReset();
  mocks.wallet.completeMint.mockReset();
  mocks.wallet.send.mockReset();
  mocks.wallet.batchRestore.mockReset();
  mocks.wallet.prepareSwapToReceive.mockReset();
  mocks.wallet.completeSwap.mockReset();
  mocks.wallet.restore.mockReset();
  mocks.wallet.groupProofsByState.mockReset();
  mocks.wallet.getKeyset.mockReset();
  mocks.wallet.getKeyset.mockImplementation((id?: string) => ({
    id: id ?? KEYSET_ID,
    unit: "msat",
    verify: () => true,
    keys: {},
  }));
  mocks.wallet.prepareMint.mockImplementation(
    async (
      _method: string,
      _amount: number,
      _quote: unknown,
      config?: { onCountersReserved?: (value: unknown) => void },
    ) => {
      config?.onCountersReserved?.({ keysetId: KEYSET_ID, start: 0, count: 1, next: 1 });
      return mintPreview();
    },
  );
  mocks.wallet.completeMint.mockResolvedValue(MINT_PROOFS);
  mocks.wallet.checkMintQuote.mockResolvedValue({ quote: "q1", state: "ISSUED" });
  // Default: every recovered proof is treated as UNSPENT unless a test
  // overrides — keeps existing tests behaving the same as before the
  // spent-filter landed.
  mocks.wallet.groupProofsByState.mockImplementation(async (proofs: unknown[]) => ({
    unspent: proofs,
    pending: [],
    spent: [],
  }));
  mocks.wallet.mint.getKeySets.mockReset();
  mocks.wallet.mint.getKeySets.mockResolvedValue({ keysets: [{ id: KEYSET_ID }] });
  for (const keysetId of Object.keys(mocks.restoredCounters))
    delete mocks.restoredCounters[keysetId];
  mocks.store.activeMintUrl = "https://mint.test";
  mocks.store.mints = [{ url: "https://mint.test", keysets: [{ id: KEYSET_ID }] }];
  mocks.store.mnemonic = VALID_MNEMONIC;
  setActiveBrowserWalletProfile(VALID_MNEMONIC);
  mocks.addProofs.mockReset();
  mocks.addProofs.mockResolvedValue(undefined);
  mocks.restoreProofsAndAdvanceCounter.mockClear();
  mocks.isWalletCounterRecoveryComplete.mockReset();
  mocks.isWalletCounterRecoveryComplete.mockResolvedValue(false);
  mocks.prepareProofOperation.mockReset();
  mocks.proofOperations.clear();
  mocks.prepareProofOperation.mockImplementation(async (record: any) => {
    const prepared = { ...record, state: "prepared", metadata: record.metadata ?? {} };
    mocks.proofOperations.set(record.operationId, prepared);
    return prepared;
  });
  mocks.markProofOperationCompleted.mockReset();
  mocks.markProofOperationFailed.mockReset();
  mocks.getProofOperations.mockReset();
  mocks.getProofOperations.mockResolvedValue([]);
  mocks.admitBrowserReceivedProofs.mockReset();
  mocks.admitBrowserReceivedProofs.mockResolvedValue(undefined);
  mocks.requireNewWritePermission.mockReset();
  mocks.requireNewWritePermission.mockResolvedValue(undefined);
  mocks.profileLock.held = false;
  mocks.profileLock.events.length = 0;
  mocks.verifyProofsForReceive.mockReset();
  mocks.getWallet.mockClear();
  mocks.getWallet.mockResolvedValue(mocks.wallet);
  mocks.store.getWallet = mocks.getWallet;
  mocks.store.getWalletForUnit = mocks.getWallet;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("conditional bearer-token import", () => {
  it("admits the exact unspent proofs directly with a deterministic operation id", async () => {
    const proof = {
      id: MODERN_KEYSET_ID,
      amount: Amount.from(21),
      secret: "conditional-secret",
      C: `02${"11".repeat(32)}`,
    };
    const token = getEncodedTokenV4({
      mint: "https://mint.test",
      unit: "msat",
      proofs: [proof],
    });
    mocks.store.mints = [
      { url: "https://mint.test", keysets: [{ id: MODERN_KEYSET_ID, unit: "msat" }] },
    ];
    mocks.wallet.getKeyset.mockReturnValue({
      id: MODERN_KEYSET_ID,
      unit: "msat",
      verify: () => true,
      keys: {},
      conditional: {
        conditionId: "aa".repeat(32),
        outcomeCollection: "B",
        outcomeCollectionId: "collection-B",
        registeredAt: 1,
      },
    });

    const first = await cashu.receiveAndStoreTokenRecoverably(
      token,
      "https://mint.test",
      "sat",
      "msat",
      "ctf-position-msat",
    );
    const second = await cashu.receiveAndStoreTokenRecoverably(
      token,
      "https://mint.test",
      "sat",
      "msat",
      "ctf-position-msat",
    );

    expect(first).toEqual([
      expect.objectContaining({
        secret: "conditional-secret",
        conditionId: "aa".repeat(32),
        outcomeCollection: "B",
      }),
    ]);
    expect(second).toEqual(first);
    expect(mocks.wallet.prepareSwapToReceive).not.toHaveBeenCalled();
    expect(mocks.wallet.completeSwap).not.toHaveBeenCalled();
    expect(mocks.verifyProofsForReceive).toHaveBeenCalledTimes(2);
    expect(mocks.verifyProofsForReceive).toHaveBeenNthCalledWith(
      1,
      [expect.objectContaining({ secret: "conditional-secret" })],
      expect.any(Function),
      { requireDleq: true },
    );
    expect(mocks.wallet.groupProofsByState).toHaveBeenCalledTimes(2);
    expect(mocks.admitBrowserReceivedProofs).toHaveBeenCalledTimes(2);
    const calls = mocks.admitBrowserReceivedProofs.mock.calls as unknown as Array<
      [{ sourceOperationId: string }]
    >;
    const firstOperationId = calls[0]?.[0].sourceOperationId;
    const secondOperationId = calls[1]?.[0].sourceOperationId;
    expect(firstOperationId).toMatch(/^conditional-token-import:[0-9a-f]{64}$/);
    expect(secondOperationId).toBe(firstOperationId);
  });

  it("rejects a V3 conditional proof before canonical admission", async () => {
    const proof = {
      id: `02${"11".repeat(32)}`,
      amount: Amount.from(21),
      secret: "v3-conditional-secret",
      C: "11".repeat(48),
    };
    const token = getEncodedTokenV4({
      mint: "https://mint.test",
      unit: "msat",
      proofs: [proof],
    });
    mocks.store.mints = [{ url: "https://mint.test", keysets: [{ id: proof.id, unit: "msat" }] }];
    mocks.wallet.getKeyset.mockReturnValue({
      id: proof.id,
      unit: "msat",
      verify: () => true,
      keys: {},
      conditional: {
        conditionId: "aa".repeat(32),
        outcomeCollection: "B",
        outcomeCollectionId: "collection-B",
        registeredAt: 1,
      },
    });

    await expect(
      cashu.receiveAndStoreTokenRecoverably(
        token,
        "https://mint.test",
        "sat",
        "msat",
        "ctf-position-msat",
      ),
    ).rejects.toThrow("canonical NUT-02 V2 keyset id");

    expect(mocks.verifyProofsForReceive).not.toHaveBeenCalled();
    expect(mocks.wallet.groupProofsByState).not.toHaveBeenCalled();
    expect(mocks.admitBrowserReceivedProofs).not.toHaveBeenCalled();
    expect(mocks.addProofs).not.toHaveBeenCalled();
  });

  it("refuses a new direct conditional receive before custody admission", async () => {
    const proof = {
      id: MODERN_KEYSET_ID,
      amount: Amount.from(21),
      secret: "conditional-secret",
      C: `02${"11".repeat(32)}`,
    };
    const token = getEncodedTokenV4({
      mint: "https://mint.test",
      unit: "msat",
      proofs: [proof],
    });
    mocks.store.mints = [
      { url: "https://mint.test", keysets: [{ id: MODERN_KEYSET_ID, unit: "msat" }] },
    ];
    mocks.wallet.getKeyset.mockReturnValue({
      id: MODERN_KEYSET_ID,
      unit: "msat",
      verify: () => true,
      keys: {},
      conditional: {
        conditionId: "aa".repeat(32),
        outcomeCollection: "B",
        outcomeCollectionId: "collection-B",
        registeredAt: 1,
      },
    });
    mocks.requireNewWritePermission.mockRejectedValueOnce(new Error("recovery required"));

    await expect(
      cashu.receiveAndStoreTokenRecoverably(
        token,
        "https://mint.test",
        "sat",
        "msat",
        "ctf-position-msat",
      ),
    ).rejects.toThrow("recovery required");

    expect(mocks.verifyProofsForReceive).toHaveBeenCalledOnce();
    expect(mocks.wallet.groupProofsByState).toHaveBeenCalledOnce();
    expect(mocks.admitBrowserReceivedProofs).not.toHaveBeenCalled();
    expect(mocks.addProofs).not.toHaveBeenCalled();
  });
});

describe("mintProofs — CDK duplicate-output recovery", () => {
  const QUOTE = { quote: "q1", request: "lnbc1..." } as never;

  it("scales sat-market mint quote requests into msat collateral subunits", async () => {
    const quote = { quote: "q-msat", request: "lnbc1...", unit: "msat" };
    mocks.wallet.createMintQuote.mockResolvedValueOnce(quote);

    const satAmount = 13;
    const result = await cashu.createMintQuote(satAmount, "https://mint.test", "sat");

    expect(result).toBe(quote);
    // Physical invariant: 1 sat = 1000 msat. The mint quote amount must be
    // in collateral subunits (msat), not base sats.
    expect(mocks.wallet.createMintQuote).toHaveBeenCalledWith(satAmount * 1_000);
  });

  it("scales sat-market mintProofs requests into msat collateral subunits", async () => {
    const satAmount = 13;
    await cashu.mintProofs(satAmount, QUOTE, "https://mint.test", "sat");

    // Physical invariant: 1 sat = 1000 msat.
    expect(mocks.wallet.prepareMint).toHaveBeenCalledWith(
      "bolt11",
      satAmount * 1_000,
      QUOTE,
      expect.any(Object),
    );
  });

  it("releases the profile lock before completed mint proof admission", async () => {
    mocks.admitBrowserReceivedProofs.mockImplementationOnce(async () => {
      mocks.profileLock.events.push("proof-admission");
      expect(mocks.profileLock.held).toBe(false);
    });

    await cashu.mintProofs(13, QUOTE, "https://mint.test", "sat");

    expect(mocks.admitBrowserReceivedProofs).toHaveBeenCalledOnce();
    expect(mocks.profileLock.events).toEqual(["lock-enter", "lock-exit", "proof-admission"]);
  });

  it("refuses a new mint before deterministic outputs are prepared", async () => {
    mocks.requireNewWritePermission.mockRejectedValueOnce(new Error("recovery required"));

    await expect(cashu.mintProofs(13, QUOTE, "https://mint.test", "sat")).rejects.toThrow(
      "recovery required",
    );

    expect(mocks.wallet.prepareMint).not.toHaveBeenCalled();
    expect(mocks.prepareProofOperation).not.toHaveBeenCalled();
    expect(mocks.wallet.completeMint).not.toHaveBeenCalled();
  });

  it("refuses a melt quote before the mint creates external work", async () => {
    mocks.requireNewWritePermission.mockRejectedValueOnce(new Error("recovery required"));

    await expect(cashu.createMeltQuote("lnbc1invoice", "https://mint.test")).rejects.toThrow(
      "recovery required",
    );

    expect(mocks.wallet.createMeltQuote).not.toHaveBeenCalled();
  });

  it("sends regular sat proofs through the explicit sat wallet", async () => {
    const proofs = [{ id: KEYSET_ID, amount: 20_000, secret: "s1", C: "C1" }] as never;
    const split = { keep: [], send: proofs };
    mocks.wallet.send.mockResolvedValueOnce(split);

    const result = await cashu.sendProofs(13, proofs, {
      mintUrl: "https://mint.test",
      unit: "sat",
    });

    expect(result).toBe(split);
    expect(mocks.wallet.send).toHaveBeenCalledWith(13, proofs);
  });

  it.each(["Invoice already paid or pending", "Blinded message already signed or pending"])(
    "retains the prepared operation after an unresolved duplicate (%s)",
    async (message) => {
      mocks.wallet.completeMint.mockRejectedValueOnce(cdkDuplicateError(message));

      await expect(cashu.mintProofs(100, QUOTE, "https://mint.test", "sat")).rejects.toThrow(
        message,
      );

      expect(mocks.wallet.prepareMint).toHaveBeenCalledOnce();
      expect(mocks.wallet.completeMint).toHaveBeenCalledOnce();
      expect(mocks.wallet.batchRestore).not.toHaveBeenCalled();
      expect(mocks.createActiveBrowserWalletCounterSource).not.toHaveBeenCalled();
      expect(mocks.markProofOperationFailed).not.toHaveBeenCalled();
      expect([...mocks.proofOperations.values()]).toEqual([
        expect.objectContaining({ state: "prepared" }),
      ]);
    },
  );

  it("does NOT swallow non-CDK-duplicate errors (real LN payment failures must propagate)", async () => {
    mocks.wallet.completeMint.mockRejectedValueOnce(new Error("Lightning payment timeout"));

    await expect(
      cashu.mintProofs(
        100,
        { quote: "q1", request: "lnbc1..." } as never,
        "https://mint.test",
        "sat",
      ),
    ).rejects.toThrow("Lightning payment timeout");
    expect(mocks.wallet.batchRestore).not.toHaveBeenCalled();
    expect(mocks.wallet.completeMint).toHaveBeenCalledTimes(1);
  });
});

describe("recoverPendingWalletMints — exact restart recovery", () => {
  it("replays the persisted mint preview after a crash without preparing fresh outputs", async () => {
    const preview = mintPreview(MODERN_KEYSET_ID);
    const operation = serializeDurableWalletMintOperation({
      operationId: "wallet-mint:restart",
      mintUrl: "https://mint.test",
      unit: "msat",
      preview,
    });
    const custody = toDurableCustodyProofOperationInput(operation);
    const record = {
      operationId: operation.operationId,
      kind: "wallet-mint",
      state: "prepared",
      mintUrl: operation.mintUrl,
      inputs: [],
      outputs: custody.outputs,
      metadata: {
        ...custody.metadata,
        baseAsset: "sat",
        keysetId: MODERN_KEYSET_ID,
        counterStart: 0,
        counterCount: 1,
      },
      createdAt: 1,
      updatedAt: 1,
    };
    mocks.proofOperations.set(operation.operationId, record);
    mocks.getProofOperations.mockResolvedValueOnce([record] as never);
    mocks.wallet.completeMint.mockResolvedValueOnce([
      { id: MODERN_KEYSET_ID, amount: 100, secret: "s1", C: "C1" },
    ]);

    const result = await cashu.recoverPendingWalletMints();

    expect(result).toEqual({ pending: 0 });
    expect(mocks.wallet.prepareMint).not.toHaveBeenCalled();
    expect(mocks.wallet.completeMint).toHaveBeenCalledTimes(1);
    const replayed = mocks.wallet.completeMint.mock.calls[0]?.[0];
    expect(new TextDecoder().decode(replayed.outputData[0].secret)).toBe(
      operation.preview.outputData[0].secret,
    );
    expect(replayed.payload.outputs[0].B_).toBe(operation.preview.payload.outputs[0].B_);
    expect(replayed.payload.outputs[0].amount.toString()).toBe(
      operation.preview.payload.outputs[0].amount,
    );
    expect(mocks.admitBrowserReceivedProofs).toHaveBeenCalledBefore(mocks.addProofs);
    expect(mocks.admitBrowserReceivedProofs).toHaveBeenCalledWith(
      expect.objectContaining({
        derivationAuthority: {
          keysetId: MODERN_KEYSET_ID,
          counterStart: 0,
          counterCount: 1,
        },
      }),
    );
    expect(mocks.addProofs).toHaveBeenCalledBefore(mocks.markProofOperationCompleted);
    const completed = mocks.markProofOperationCompleted.mock.calls[0];
    expect(completed?.[0]).toBe(operation.operationId);
    expect(completed?.[1]?.receive[0]?.secret).toBe("s1");
  });

  it("reports an unresolved duplicate as pending without regenerating mint outputs", async () => {
    const record = preparedMintRecord("wallet-mint:unresolved-duplicate");
    mocks.proofOperations.set(record.operationId, record);
    mocks.getProofOperations.mockResolvedValueOnce([record] as never);
    mocks.wallet.completeMint.mockRejectedValueOnce(cdkDuplicateError());
    mocks.wallet.checkMintQuote.mockResolvedValueOnce({ quote: "q1", state: "PAID" });

    const result = await cashu.recoverPendingWalletMints();

    expect(result).toEqual({ pending: 1 });
    expect(mocks.wallet.prepareMint).not.toHaveBeenCalled();
    expect(mocks.wallet.completeMint).toHaveBeenCalledOnce();
    expect(mocks.wallet.batchRestore).not.toHaveBeenCalled();
    expect(mocks.wallet.restore).not.toHaveBeenCalled();
    expect(mocks.markProofOperationCompleted).not.toHaveBeenCalled();
    expect(mocks.proofOperations.get(record.operationId)?.state).toBe("prepared");
  });

  it("keeps a mint prepared when shared DLEQ verification rejects its result", async () => {
    mocks.verifyProofsForReceive.mockImplementationOnce(() => {
      throw new Error("Token contains proofs with invalid or missing DLEQ");
    });

    await expect(
      cashu.mintProofs(
        100,
        { quote: "q1", request: "lnbc1..." } as never,
        "https://mint.test",
        "sat",
      ),
    ).rejects.toThrow("invalid or missing DLEQ");

    expect(mocks.verifyProofsForReceive).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Function),
      { requireDleq: true },
    );
    expect(mocks.admitBrowserReceivedProofs).not.toHaveBeenCalled();
    expect(mocks.addProofs).not.toHaveBeenCalled();
    expect(mocks.markProofOperationCompleted).not.toHaveBeenCalled();
    expect(mocks.prepareProofOperation).toHaveBeenCalledOnce();
  });

  it("does not write a switched profile after canonical custody admission", async () => {
    const record = preparedMintRecord("wallet-mint:profile-switch");
    mocks.proofOperations.set(record.operationId, record);
    mocks.getProofOperations.mockResolvedValueOnce([record] as never);
    mocks.wallet.completeMint.mockResolvedValueOnce([
      { id: MODERN_KEYSET_ID, amount: 100, secret: "s1", C: "C1" },
    ]);
    const switchProfile = vi.fn(() => {
      mocks.store.mnemonic =
        "legal winner thank year wave sausage worth useful legal winner thank yellow";
      setActiveBrowserWalletProfile(mocks.store.mnemonic);
    });
    mocks.admitBrowserReceivedProofs.mockImplementationOnce(async () => {
      switchProfile();
    });

    const result = await cashu.recoverPendingWalletMints();

    expect(result).toEqual({ pending: 1 });
    expect(mocks.admitBrowserReceivedProofs).toHaveBeenCalledOnce();
    expect(switchProfile).toHaveBeenCalledOnce();
    expect(mocks.admitBrowserReceivedProofs).toHaveBeenCalledBefore(switchProfile);
    expect(mocks.addProofs).not.toHaveBeenCalled();
    expect(mocks.markProofOperationCompleted).not.toHaveBeenCalled();
  });

  it("fails an unknown journal state without mint or persistence effects", async () => {
    const record = { ...preparedMintRecord("wallet-mint:unknown"), state: "unknown" };
    mocks.proofOperations.set(record.operationId, record);
    mocks.getProofOperations.mockResolvedValueOnce([record] as never);

    const result = await cashu.recoverPendingWalletMints();

    expect(result).toEqual({ pending: 1 });
    expect(mocks.wallet.completeMint).not.toHaveBeenCalled();
    expect(mocks.admitBrowserReceivedProofs).not.toHaveBeenCalled();
    expect(mocks.addProofs).not.toHaveBeenCalled();
    expect(mocks.markProofOperationCompleted).not.toHaveBeenCalled();
  });

  it("leaves a valid quote-owned mint operation for quote recovery only", async () => {
    const record = preparedMintRecord("wallet-mint:quote-owned");
    Object.assign(record.metadata, { durableBolt11MintQuoteRecordId: "a".repeat(64) });
    mocks.proofOperations.set(record.operationId, record);
    mocks.getProofOperations.mockResolvedValueOnce([record] as never);

    expect(await cashu.recoverPendingWalletMints()).toEqual({ pending: 0 });
    expect(mocks.wallet.completeMint).not.toHaveBeenCalled();
    expect(mocks.admitBrowserReceivedProofs).not.toHaveBeenCalled();
  });
});

function preparedMintRecord(operationId: string) {
  const preview = mintPreview(MODERN_KEYSET_ID);
  const operation = serializeDurableWalletMintOperation({
    operationId,
    mintUrl: "https://mint.test",
    unit: "msat",
    preview,
  });
  const custody = toDurableCustodyProofOperationInput(operation);
  return {
    operationId: operation.operationId,
    kind: "wallet-mint",
    state: "prepared",
    mintUrl: operation.mintUrl,
    inputs: [],
    outputs: custody.outputs,
    metadata: {
      ...custody.metadata,
      baseAsset: "sat",
      keysetId: MODERN_KEYSET_ID,
      counterStart: 0,
      counterCount: 1,
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("recoverKeysetCountersForMint — idempotency", () => {
  it("limits forced duplicate repair to the collided keyset", async () => {
    mocks.wallet.mint.getKeySets.mockResolvedValueOnce({
      keysets: [
        { id: KEYSET_ID, unit: "msat" },
        { id: ALT_KEYSET_ID, unit: "msat" },
      ],
    });
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: [],
      lastCounterWithSignature: 2,
    });

    const result = await cashu.recoverKeysetCountersForMint("https://mint.test", {
      force: true,
      unit: "msat",
      keysetId: KEYSET_ID,
    });

    expect(mocks.wallet.batchRestore).toHaveBeenCalledOnce();
    expect(mocks.wallet.batchRestore).toHaveBeenCalledWith(300, 100, 0, KEYSET_ID);
    expect(result.scannedKeysets).toEqual([KEYSET_ID]);
  });

  it("skips an exact recovery-complete mint and unit association", async () => {
    mocks.isWalletCounterRecoveryComplete.mockResolvedValueOnce(true);

    await cashu.recoverKeysetCountersForMint("https://mint.test");

    expect(mocks.wallet.batchRestore).not.toHaveBeenCalled();
  });

  it("walks every keyset and advances the canonical authority", async () => {
    mocks.wallet.mint.getKeySets.mockResolvedValueOnce({
      keysets: [{ id: KEYSET_ID }, { id: ALT_KEYSET_ID }],
    });
    mocks.wallet.batchRestore
      .mockResolvedValueOnce({ proofs: [], lastCounterWithSignature: 4 })
      .mockResolvedValueOnce({ proofs: [], lastCounterWithSignature: 9 });

    const r = await cashu.recoverKeysetCountersForMint("https://mint.test");

    expect(mocks.restoreProofsAndAdvanceCounter).toHaveBeenCalledTimes(2);
    expect(r.scannedKeysets).toEqual([KEYSET_ID, ALT_KEYSET_ID]);
  });

  it("walks every supported advertised msat keyset when no baseAsset filter is provided", async () => {
    mocks.wallet.mint.getKeySets.mockResolvedValueOnce({
      keysets: [
        { id: KEYSET_ID, unit: "msat" },
        { id: ALT_KEYSET_ID, unit: "msat" },
      ],
    });
    mocks.wallet.batchRestore
      .mockResolvedValueOnce({ proofs: [], lastCounterWithSignature: 2 })
      .mockResolvedValueOnce({ proofs: [], lastCounterWithSignature: 8 });

    const r = await cashu.recoverKeysetCountersForMint("https://mint.test");

    expect(mocks.getWallet).toHaveBeenCalledWith("https://mint.test", "msat");
    expect(mocks.restoreProofsAndAdvanceCounter).toHaveBeenCalledTimes(2);
    expect(r.scannedKeysets).toEqual([KEYSET_ID, ALT_KEYSET_ID]);
  });

  it("preserves the msat unit while recovering a sat-market keyset", async () => {
    mocks.wallet.mint.getKeySets.mockResolvedValueOnce({
      keysets: [{ id: KEYSET_ID, unit: "msat" }],
    });
    const proof = recoveryProof(0, 2_000);
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: [proof],
      lastCounterWithSignature: 0,
    });

    await cashu.recoverKeysetCountersForMint("https://mint.test", {
      baseAsset: "sat",
    });

    expect(mocks.getWallet).toHaveBeenCalledWith("https://mint.test", "msat");
    expect(mocks.addProofs).toHaveBeenCalledWith([
      expect.objectContaining({
        secret: proof.secret,
        baseAsset: "sat",
        unit: "msat",
      }),
    ]);
  });

  it("does not advance a keyset when NUT-07 classification fails", async () => {
    mocks.wallet.mint.getKeySets.mockResolvedValueOnce({
      keysets: [{ id: KEYSET_ID, unit: "msat" }],
    });
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: [recoveryProof(0, 2_000)],
      lastCounterWithSignature: 2,
    });
    mocks.wallet.groupProofsByState.mockRejectedValueOnce(new Error("NUT-07 unavailable"));

    const result = await cashu.recoverKeysetCountersForMint("https://mint.test", {
      baseAsset: "sat",
    });

    expect(mocks.restoreProofsAndAdvanceCounter).not.toHaveBeenCalled();
    expect(mocks.addProofs).not.toHaveBeenCalled();
    expect(result.scannedKeysets).toEqual([]);
  });

  it("uses fresh keysets from mint.getKeySets, not stale store keysets (codex review #3)", async () => {
    // Store has only k1; the mint has rotated to k2.
    mocks.store.mints = [{ url: "https://mint.test", keysets: [{ id: KEYSET_ID }] }];
    mocks.wallet.mint.getKeySets.mockResolvedValueOnce({ keysets: [{ id: ALT_KEYSET_ID }] });
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: [],
      lastCounterWithSignature: 2,
    });

    const r = await cashu.recoverKeysetCountersForMint("https://mint.test");

    expect(mocks.wallet.batchRestore).toHaveBeenCalledWith(300, 100, 0, ALT_KEYSET_ID);
    expect(mocks.restoreProofsAndAdvanceCounter).toHaveBeenCalledWith(
      expect.objectContaining({ keysetId: ALT_KEYSET_ID, restoredNext: 3 }),
    );
    expect(r.scannedKeysets).toEqual([ALT_KEYSET_ID]);
  });

  it("falls back to stored keysets if mint.getKeySets fails (network down)", async () => {
    mocks.wallet.mint.getKeySets.mockRejectedValueOnce(new Error("network"));
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: [],
      lastCounterWithSignature: 1,
    });

    const r = await cashu.recoverKeysetCountersForMint("https://mint.test");

    expect(mocks.wallet.batchRestore).toHaveBeenCalledWith(300, 100, 0, KEYSET_ID);
    expect(r.scannedKeysets).toEqual([KEYSET_ID]);
  });

  it("rescans every keyset without a separate recovered-state flag", async () => {
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: [],
      lastCounterWithSignature: 12,
    });

    const r = await cashu.recoverKeysetCountersForMint("https://mint.test");

    expect(mocks.restoreProofsAndAdvanceCounter).toHaveBeenCalledWith(
      expect.objectContaining({ keysetId: KEYSET_ID, restoredNext: 13 }),
    );
    expect(r.scannedKeysets).toEqual([KEYSET_ID]);
  });

  it("returns empty scannedKeysets when no mnemonic (anonymous wallet)", async () => {
    mocks.store.mnemonic = "";
    const r = await cashu.recoverKeysetCountersForMint("https://mint.test");
    expect(r.scannedKeysets).toEqual([]);
    expect(mocks.wallet.batchRestore).not.toHaveBeenCalled();
  });

  it("filters SPENT proofs out via groupProofsByState (codex review #1 BLOCKER)", async () => {
    // batchRestore returns ALL signed outputs — including spent ones.
    // Persisting spent proofs would inflate the displayed balance and
    // cause spent-token errors on the next spend. The fix uses
    // groupProofsByState to keep only UNSPENT.
    const recoveredProofs = [
      recoveryProof(0, 50),
      recoveryProof(1, 100),
      recoveryProof(2, 25),
    ] as never;
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: recoveredProofs,
      lastCounterWithSignature: 5,
    });
    mocks.wallet.groupProofsByState.mockResolvedValueOnce({
      unspent: [recoveredProofs[0]],
      spent: [recoveredProofs[1]],
      pending: [recoveredProofs[2]],
    });

    await cashu.recoverKeysetCountersForMint("https://mint.test");

    expect(mocks.addProofs).toHaveBeenCalledOnce();
    const persisted = mocks.addProofs.mock.calls[0][0] as { secret: string }[];
    expect(persisted.map((p) => p.secret)).toEqual([recoveryProof(0).secret]);
    // Spent proofs MUST NOT land in IndexedDB.
    expect(persisted.find((p) => p.secret === recoveryProof(1).secret)).toBeUndefined();
    // Pending proofs are also excluded — they may resolve to SPENT shortly.
    expect(persisted.find((p) => p.secret === recoveryProof(2).secret)).toBeUndefined();
  });

  it("admits recovered proofs in bounded deterministic batches", async () => {
    const recoveredProofs = Array.from({ length: 33 }, (_, counter) => recoveryProof(counter));
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: recoveredProofs,
      lastCounterWithSignature: 32,
    });

    const first = await cashu.recoverKeysetCountersForMint("https://mint.test");
    const firstCalls = (mocks.admitBrowserReceivedProofs.mock.calls as unknown as [unknown][]).map(
      ([input]) => input as { proofs: { secret: string }[]; sourceOperationId: string },
    );

    expect(first).toEqual({ scannedKeysets: [KEYSET_ID], complete: true });
    expect(firstCalls.map(({ proofs }) => proofs.length)).toEqual([32, 1]);
    expect(firstCalls[0]?.sourceOperationId).not.toBe(firstCalls[1]?.sourceOperationId);
    expect(mocks.restoreProofsAndAdvanceCounter).toHaveBeenCalledOnce();

    mocks.admitBrowserReceivedProofs.mockClear();
    mocks.restoreProofsAndAdvanceCounter.mockClear();
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: recoveredProofs,
      lastCounterWithSignature: 32,
    });
    await cashu.recoverKeysetCountersForMint("https://mint.test");
    const retryCalls = (mocks.admitBrowserReceivedProofs.mock.calls as unknown as [unknown][]).map(
      ([input]) => input as { sourceOperationId: string },
    );
    expect(retryCalls.map(({ sourceOperationId }) => sourceOperationId)).toEqual(
      firstCalls.map(({ sourceOperationId }) => sourceOperationId),
    );
  });

  it("does not advance the counter when a later bounded admission batch fails", async () => {
    const recoveredProofs = Array.from({ length: 33 }, (_, counter) => recoveryProof(counter));
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: recoveredProofs,
      lastCounterWithSignature: 32,
    });
    mocks.admitBrowserReceivedProofs
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("bounded admission failed"));

    const result = await cashu.recoverKeysetCountersForMint("https://mint.test");

    expect(result).toEqual({ scannedKeysets: [], complete: false });
    expect(mocks.admitBrowserReceivedProofs).toHaveBeenCalledTimes(2);
    expect(mocks.restoreProofsAndAdvanceCounter).not.toHaveBeenCalled();
  });

  it("handles batchRestore returning no signatures (fresh wallet) by setting counter to 0", async () => {
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: [],
      lastCounterWithSignature: undefined,
    });

    await cashu.recoverKeysetCountersForMint("https://mint.test");

    expect(mocks.restoreProofsAndAdvanceCounter).toHaveBeenCalledWith(
      expect.objectContaining({ keysetId: KEYSET_ID, restoredNext: 0 }),
    );
  });

  it("advances a high-water mark beyond the targeted recovery candidate policy", async () => {
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: [],
      lastCounterWithSignature: 4_097,
    });

    const result = await cashu.recoverKeysetCountersForMint("https://mint.test");

    expect(result).toEqual({ scannedKeysets: [KEYSET_ID], complete: true });
    expect(mocks.restoreProofsAndAdvanceCounter).toHaveBeenCalledWith(
      expect.objectContaining({ keysetId: KEYSET_ID, restoredNext: 4_098 }),
    );
  });

  it("delegates monotonic recovery to the canonical authority", async () => {
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: [],
      lastCounterWithSignature: 5,
    });

    await cashu.recoverKeysetCountersForMint("https://mint.test");

    expect(mocks.restoreProofsAndAdvanceCounter).toHaveBeenCalledWith(
      expect.objectContaining({ keysetId: KEYSET_ID, restoredNext: 6 }),
    );
  });
});
