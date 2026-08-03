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
 * - The `cdk-buy-yes` codex investigation (2026-05-06) traced this back to
 *   `ZustandCounterSource` lacking a migration for wallets that pre-existed
 *   commit `8711c73` — `keysetCounters[keysetId]` is `undefined`/0 while the
 *   mint already signed outputs at counter 0..N.
 *
 * The fix has two layers, both exercised here:
 *
 * 1. `mintProofs` catches the exact CDK error message, runs counter recovery
 *    against the active keyset, then retries `wallet.mintProofs` once.
 * 2. Non-recovery errors propagate unchanged so genuine LN payment failures
 *    are not swallowed by the recovery path.
 */

import { OutputData } from "@cashu/cashu-ts";
import {
  serializeDurableWalletMintOperation,
  toDurableCustodyProofOperationInput,
} from "@bitcaster/client-sdk/durableWalletOperation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mocks — the cashu-ts wallet, the wallet store, and the proof DB
// are all swapped out per-test via these handles.
const mocks = vi.hoisted(() => {
  const wallet = {
    createMintQuote: vi.fn(),
    prepareMint: vi.fn(),
    completeMint: vi.fn(),
    send: vi.fn(),
    batchRestore: vi.fn(),
    prepareSwapToReceive: vi.fn(),
    completeSwap: vi.fn(),
    restore: vi.fn(),
    groupProofsByState: vi.fn(),
    mint: { getKeySets: vi.fn() },
    getKeyset: vi.fn(),
  };
  const getWallet = vi.fn(async () => wallet);
  const store: {
    mnemonic: string;
    activeMintUrl: string;
    mints: { url: string; keysets?: { id: string; unit?: string }[] }[];
    keysetCounters: Record<string, number>;
    keysetCountersRecovered: Record<string, boolean>;
    getWallet: (url?: string) => Promise<unknown>;
    getWalletForUnit: (url?: string, unit?: string) => Promise<unknown>;
  } = {
    mnemonic: "seed words",
    activeMintUrl: "https://mint.test",
    mints: [{ url: "https://mint.test", keysets: [{ id: "k1" }] }],
    keysetCounters: {},
    keysetCountersRecovered: {},
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
  const verifyProofsForReceive = vi.fn();
  return {
    wallet,
    store,
    setStateImpl,
    addProofs,
    getWallet,
    prepareProofOperation,
    proofOperations,
    markProofOperationCompleted,
    markProofOperationFailed,
    getProofOperations,
    admitBrowserReceivedProofs,
    verifyProofsForReceive,
  };
});

vi.mock("@cashu/cashu-ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cashu/cashu-ts")>()),
  verifyProofsForReceive: mocks.verifyProofsForReceive,
}));

vi.mock("@/lib/browserCustodyProofReceive", () => ({
  admitBrowserReceivedProofs: mocks.admitBrowserReceivedProofs,
}));

vi.mock("@/stores/wallet", () => ({
  useWalletStore: {
    getState: () => mocks.store,
    setState: mocks.setStateImpl,
  },
  getWalletForMnemonicUnit: mocks.getWallet,
}));

vi.mock("@/stores/proof-db", () => ({
  db: {},
  addProofs: mocks.addProofs,
  getProofOperations: mocks.getProofOperations,
  getProofOperation: vi.fn(
    async (operationId: string) => mocks.proofOperations.get(operationId) ?? null,
  ),
  prepareProofOperation: mocks.prepareProofOperation,
  markProofOperationCompleted: mocks.markProofOperationCompleted,
  markProofOperationFailed: mocks.markProofOperationFailed,
  removeProofs: vi.fn(),
  getUnitProofs: vi.fn(),
}));

// `getWallet` is also defined in cashu.ts, but the mintProofs helper uses
// the module's own getWallet (resolved at call site). We replace the entire
// module's `getWallet` via a vitest spy in beforeEach.

import * as cashu from "../cashu";
import { setActiveBrowserWalletProfile } from "../browserWalletProfile";

const VALID_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const MINT_PROOFS = [{ id: "k1", amount: 100, secret: "s1", C: "C1" }] as never;
const MODERN_KEYSET_ID = `01${"44".repeat(32)}`;

function mintPreview(keysetId = "k1") {
  const output = OutputData.createSingleData("100", keysetId, "s1", 3n);
  return {
    method: "bolt11",
    payload: { quote: "q1", outputs: [output.blindedMessage] },
    outputData: [output],
    keysetId,
    quote: { quote: "q1" },
  } as never;
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
  mocks.wallet.prepareMint.mockReset();
  mocks.wallet.completeMint.mockReset();
  mocks.wallet.send.mockReset();
  mocks.wallet.batchRestore.mockReset();
  mocks.wallet.prepareSwapToReceive.mockReset();
  mocks.wallet.completeSwap.mockReset();
  mocks.wallet.restore.mockReset();
  mocks.wallet.groupProofsByState.mockReset();
  mocks.wallet.getKeyset.mockReset();
  mocks.wallet.getKeyset.mockReturnValue({ id: "k1", unit: "msat", verify: () => true, keys: {} });
  mocks.wallet.prepareMint.mockImplementation(
    async (
      _method: string,
      _amount: number,
      _quote: unknown,
      config?: { onCountersReserved?: (value: unknown) => void },
    ) => {
      config?.onCountersReserved?.({ keysetId: "k1", start: 0, count: 1, next: 1 });
      return mintPreview();
    },
  );
  mocks.wallet.completeMint.mockResolvedValue(MINT_PROOFS);
  // Default: every recovered proof is treated as UNSPENT unless a test
  // overrides — keeps existing tests behaving the same as before the
  // spent-filter landed.
  mocks.wallet.groupProofsByState.mockImplementation(async (proofs: unknown[]) => ({
    unspent: proofs,
    pending: [],
    spent: [],
  }));
  mocks.wallet.mint.getKeySets.mockReset();
  mocks.wallet.mint.getKeySets.mockResolvedValue({ keysets: [{ id: "k1" }] });
  mocks.store.keysetCounters = {};
  mocks.store.keysetCountersRecovered = {};
  mocks.store.activeMintUrl = "https://mint.test";
  mocks.store.mints = [{ url: "https://mint.test", keysets: [{ id: "k1" }] }];
  mocks.store.mnemonic = VALID_MNEMONIC;
  setActiveBrowserWalletProfile(VALID_MNEMONIC);
  mocks.addProofs.mockReset();
  mocks.addProofs.mockResolvedValue(undefined);
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
  mocks.verifyProofsForReceive.mockReset();
  mocks.getWallet.mockClear();
  mocks.getWallet.mockResolvedValue(mocks.wallet);
  mocks.store.getWallet = mocks.getWallet;
  mocks.store.getWalletForUnit = mocks.getWallet;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("recoverable external-token receive journal", () => {
  it("persists mint-authenticated conditional metadata in the durable receive path", async () => {
    const mintUrl = "https://conditional-receive.mint";
    const successors = [
      {
        id: "conditional-keyset",
        amount: 7,
        secret: "conditional-output",
        C: "Cout",
      },
    ];
    mocks.wallet.prepareSwapToReceive.mockImplementationOnce(
      async (_token: string, config: { onCountersReserved?: (value: unknown) => void }) => {
        config.onCountersReserved?.({
          keysetId: "conditional-keyset",
          start: 3,
          count: 1,
          next: 4,
        });
        return {
          inputs: [{ id: "input", amount: 8, secret: "in", C: "Cin" }],
          keysetId: "conditional-keyset",
          keepOutputs: [],
        };
      },
    );
    mocks.wallet.completeSwap.mockResolvedValueOnce({ keep: successors, send: [] });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          keysets: [
            {
              id: "conditional-keyset",
              condition_id: "condition-1",
              outcome_collection: "B",
              outcome_collection_id: "B",
            },
          ],
        }),
      }),
    );

    await cashu.receiveAndStoreTokenRecoverably("cashuB-token", mintUrl, "sat", "sat");

    expect(mocks.admitBrowserReceivedProofs).toHaveBeenCalledWith(
      expect.objectContaining({
        mintUrl,
        sourceOperationId: expect.stringMatching(/^token-receive:/),
        unit: "sat",
        proofs: [expect.objectContaining({ secret: "conditional-output" })],
      }),
    );
    expect(mocks.addProofs).toHaveBeenCalledWith([
      expect.objectContaining({
        secret: "conditional-output",
        mintUrl,
        conditionId: "condition-1",
        outcomeCollection: "B",
        marketId: "condition-1-B",
      }),
    ]);
  });

  it.each([
    ["sat", "sat"],
    ["sat", "msat"],
  ] as const)(
    "restores exact %s/%s successors after post-swap proof persistence fails",
    async (baseAsset, unit) => {
      const inputs = [{ id: `input-${unit}`, amount: 8, secret: `in-${unit}`, C: "Cin" }];
      const successors = [
        { id: MODERN_KEYSET_ID, amount: 7, secret: `out-${unit}-0`, C: "Cout0" },
        { id: MODERN_KEYSET_ID, amount: 7, secret: `out-${unit}-1`, C: "Cout1" },
      ];
      mocks.wallet.prepareSwapToReceive.mockImplementationOnce(
        async (_token: string, config: { onCountersReserved?: (value: unknown) => void }) => {
          config.onCountersReserved?.({
            keysetId: MODERN_KEYSET_ID,
            start: 7,
            count: 2,
            next: 9,
          });
          return { inputs, keysetId: MODERN_KEYSET_ID, keepOutputs: [] };
        },
      );
      mocks.wallet.completeSwap.mockResolvedValueOnce({ keep: successors, send: [] });
      mocks.addProofs.mockRejectedValueOnce(new Error("IndexedDB quota exceeded"));

      await expect(
        cashu.receiveAndStoreTokenRecoverably("cashuB-token", "https://mint.test", baseAsset, unit),
      ).rejects.toThrow("IndexedDB quota exceeded");

      const prepared = mocks.prepareProofOperation.mock.calls[0][0] as {
        operationId: string;
        metadata: Record<string, unknown>;
      };
      expect(prepared.metadata).toMatchObject({
        baseAsset,
        unit,
        keysetId: MODERN_KEYSET_ID,
        counterStart: 7,
        counterCount: 2,
      });
      expect(mocks.prepareProofOperation.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.wallet.completeSwap.mock.invocationCallOrder[0],
      );
      expect(mocks.admitBrowserReceivedProofs.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.addProofs.mock.invocationCallOrder[0],
      );

      mocks.getProofOperations.mockResolvedValueOnce([
        {
          ...prepared,
          kind: "token-receive",
          state: "prepared",
          mintUrl: "https://mint.test",
          inputs,
          outputs: {},
          createdAt: 1,
          updatedAt: 1,
        },
      ] as never);
      mocks.wallet.restore.mockResolvedValueOnce({ proofs: successors });
      mocks.wallet.groupProofsByState.mockResolvedValueOnce({
        unspent: successors,
        pending: [],
        spent: [],
      });
      mocks.addProofs.mockResolvedValueOnce(undefined);

      await cashu.recoverPendingTokenReceives();

      expect(mocks.admitBrowserReceivedProofs).toHaveBeenCalledTimes(2);
      expect(mocks.wallet.restore).toHaveBeenCalledWith(7, 2, {
        keysetId: MODERN_KEYSET_ID,
      });
      expect(mocks.admitBrowserReceivedProofs).toHaveBeenLastCalledWith(
        expect.objectContaining({
          proofs: expect.arrayContaining([
            expect.objectContaining({ secret: `out-${unit}-0` }),
            expect.objectContaining({ secret: `out-${unit}-1` }),
          ]),
          derivationRangeProofs: successors,
          derivationAuthority: {
            keysetId: MODERN_KEYSET_ID,
            counterStart: 7,
            counterCount: 2,
          },
        }),
      );
      expect(mocks.addProofs).toHaveBeenLastCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            secret: `out-${unit}-0`,
            mintUrl: "https://mint.test",
            baseAsset,
            unit,
          }),
        ]),
      );
      expect(mocks.markProofOperationCompleted).toHaveBeenCalledWith(prepared.operationId, {
        receive: successors,
      });
    },
  );

  it("admits only unspent modern range proofs while retaining the exact restored range", async () => {
    const restored = [
      { id: MODERN_KEYSET_ID, amount: 7, secret: "spent", C: "Cspent" },
      { id: MODERN_KEYSET_ID, amount: 7, secret: "pending", C: "Cpending" },
      { id: MODERN_KEYSET_ID, amount: 7, secret: "unspent", C: "Cunspent" },
    ];
    const operation = {
      operationId: "token-receive:mixed-states",
      kind: "token-receive",
      state: "prepared",
      mintUrl: "https://mint.test",
      inputs: [],
      outputs: {},
      metadata: {
        baseAsset: "sat",
        unit: "sat",
        keysetId: MODERN_KEYSET_ID,
        counterStart: 41,
        counterCount: 3,
      },
      createdAt: 1,
      updatedAt: 1,
    };
    mocks.getProofOperations.mockResolvedValueOnce([operation] as never);
    mocks.wallet.restore.mockResolvedValueOnce({ proofs: restored });
    mocks.wallet.groupProofsByState.mockResolvedValueOnce({
      spent: [restored[0]],
      pending: [restored[1]],
      unspent: [restored[2]],
    });

    await expect(cashu.recoverPendingTokenReceives()).resolves.toEqual({ pending: 1 });

    expect(mocks.admitBrowserReceivedProofs).toHaveBeenCalledWith(
      expect.objectContaining({
        proofs: [expect.objectContaining({ secret: "unspent" })],
        derivationRangeProofs: restored,
        derivationAuthority: {
          keysetId: MODERN_KEYSET_ID,
          counterStart: 41,
          counterCount: 3,
        },
      }),
    );
    expect(mocks.addProofs).toHaveBeenCalledWith([expect.objectContaining({ secret: "unspent" })]);
    expect(mocks.markProofOperationCompleted).not.toHaveBeenCalled();
  });

  it("keeps an unsigned journal retryable instead of racing a late mint commit", async () => {
    const operation = {
      operationId: "token-receive:pending",
      kind: "token-receive",
      state: "prepared",
      mintUrl: "https://mint.test",
      inputs: [{ id: "input-msat", amount: 8, secret: "in", C: "Cin" }],
      outputs: {},
      metadata: {
        baseAsset: "sat",
        unit: "msat",
        keysetId: "keyset-msat",
        counterStart: 7,
        counterCount: 2,
      },
      createdAt: 1,
      updatedAt: 1,
    };
    mocks.getProofOperations.mockResolvedValueOnce([operation] as never);
    mocks.wallet.restore.mockResolvedValueOnce({ proofs: [] });
    mocks.wallet.groupProofsByState.mockResolvedValueOnce({
      unspent: operation.inputs,
      pending: [],
      spent: [],
    });

    await cashu.recoverPendingTokenReceives();

    expect(mocks.markProofOperationCompleted).not.toHaveBeenCalled();
    expect(mocks.markProofOperationFailed).not.toHaveBeenCalled();
  });
});

describe("mintProofs — CDK duplicate-output recovery", () => {
  const QUOTE = { quote: "q1", request: "lnbc1..." } as never;
  const PROOFS = MINT_PROOFS;

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

  it("sends regular sat proofs through the explicit sat wallet", async () => {
    const proofs = [{ id: "k1", amount: 20_000, secret: "s1", C: "C1" }] as never;
    const split = { keep: [], send: proofs };
    mocks.wallet.send.mockResolvedValueOnce(split);

    const result = await cashu.sendProofs(13, proofs, {
      mintUrl: "https://mint.test",
      unit: "sat",
    });

    expect(result).toBe(split);
    expect(mocks.wallet.send).toHaveBeenCalledWith(13, proofs);
  });

  it("advances persisted counters after a successful deterministic mint even when the wallet adapter did not persist the reservation", async () => {
    const result = await cashu.mintProofs(100, QUOTE, "https://mint.test", "sat");

    expect(result.map((proof) => proof.secret)).toEqual(["s1"]);
    expect(mocks.store.keysetCounters.k1).toBe(1);
  });

  it("does not double-advance counters when cashu-ts already reserved the minted output range", async () => {
    mocks.store.keysetCounters = { k1: 7 };
    mocks.wallet.completeMint.mockImplementationOnce(async () => {
      mocks.store.keysetCounters = { k1: 8 };
      return PROOFS;
    });

    await cashu.mintProofs(100, QUOTE, "https://mint.test", "sat");

    expect(mocks.store.keysetCounters.k1).toBe(8);
  });

  it("retries mintProofs once after running counter recovery on CDK duplicate error", async () => {
    mocks.wallet.completeMint
      .mockRejectedValueOnce(cdkDuplicateError("Invoice already paid or pending"))
      .mockResolvedValueOnce(PROOFS);
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: [],
      lastCounterWithSignature: 7,
    });

    const result = await cashu.mintProofs(100, QUOTE, "https://mint.test", "sat");

    expect(result.map((proof) => proof.secret)).toEqual(["s1"]);
    // Counter advanced past the highest known signature and the retry mint.
    expect(mocks.store.keysetCounters.k1).toBe(9);
    // Recovery flag set so the next mintProofs call doesn't re-run batchRestore.
    expect(mocks.store.keysetCountersRecovered.k1).toBe(true);
    expect(mocks.wallet.completeMint).toHaveBeenCalledTimes(2);
    expect(mocks.wallet.batchRestore).toHaveBeenCalledTimes(1);
    expect(mocks.prepareProofOperation).toHaveBeenCalledTimes(2);
    expect(mocks.markProofOperationFailed).toHaveBeenCalledTimes(1);
  });

  it("also retries the current CDK blinded-message duplicate detail", async () => {
    mocks.wallet.completeMint
      .mockRejectedValueOnce(cdkDuplicateError("Blinded message already signed or pending"))
      .mockResolvedValueOnce(PROOFS);
    mocks.wallet.mint.getKeySets.mockResolvedValueOnce({
      keysets: [{ id: "k1", unit: "msat" }],
    });
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: [],
      lastCounterWithSignature: 11,
    });

    const result = await cashu.mintProofs(100, QUOTE, "https://mint.test", "sat");

    expect(result.map((proof) => proof.secret)).toEqual(["s1"]);
    expect(mocks.store.keysetCounters.k1).toBe(13);
    expect(mocks.wallet.completeMint).toHaveBeenCalledTimes(2);
  });

  it("falls back to a bounded active-keyset counter bump when duplicate recovery cannot scan the unit", async () => {
    mocks.wallet.completeMint
      .mockRejectedValueOnce(cdkDuplicateError("Blinded message already signed or pending"))
      .mockResolvedValueOnce(PROOFS);
    mocks.wallet.getKeyset.mockReturnValue({ id: "usd-keyset" });
    mocks.wallet.mint.getKeySets.mockResolvedValueOnce({
      keysets: [{ id: "usd-keyset", unit: "msat" }],
    });
    mocks.wallet.batchRestore.mockRejectedValueOnce(new Error("restore unavailable"));

    const result = await cashu.mintProofs(100, QUOTE, "https://mint.test", "sat");

    expect(result.map((proof) => proof.secret)).toEqual(["s1"]);
    expect(mocks.wallet.batchRestore).toHaveBeenCalledOnce();
    expect(mocks.store.keysetCounters["usd-keyset"]).toBe(100);
    expect(mocks.wallet.completeMint).toHaveBeenCalledTimes(2);
  });

  it("persists any proofs that batchRestore recovers (so the user does not lose ecash)", async () => {
    mocks.wallet.completeMint
      .mockRejectedValueOnce(cdkDuplicateError())
      .mockResolvedValueOnce(PROOFS);
    const recoveredProofs = [{ id: "k1", amount: 50, secret: "rs1", C: "rC1" }] as never;
    mocks.wallet.mint.getKeySets.mockResolvedValueOnce({
      keysets: [{ id: "k1", unit: "msat" }],
    });
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: recoveredProofs,
      lastCounterWithSignature: 3,
    });

    await cashu.mintProofs(100, QUOTE, "https://mint.test", "sat");

    expect(mocks.addProofs).toHaveBeenCalledTimes(2);
    expect(mocks.addProofs).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          secret: "rs1",
          mintUrl: "https://mint.test",
          baseAsset: "sat",
        }),
      ]),
    );
  });

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

  it("does not retry indefinitely — second CDK duplicate propagates", async () => {
    // After recovery, the retry STILL fails — could happen if cashu-ts has a
    // stale internal counter that the next reserve() pulls before
    // ZustandCounterSource sees the update. Bail with the original error
    // rather than spinning.
    mocks.wallet.completeMint.mockRejectedValue(cdkDuplicateError());
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: [],
      lastCounterWithSignature: 5,
    });

    await expect(cashu.mintProofs(100, QUOTE, "https://mint.test", "sat")).rejects.toThrow(
      "Blinded message already signed or pending",
    );
    expect(mocks.wallet.completeMint).toHaveBeenCalledTimes(2); // one retry, no more
  });

  // Note on the anonymous-wallet (no-mnemonic) corner case: the
  // deterministic-counter recovery only makes sense for mnemonic-derived
  // wallets — without a seed, cashu-ts mints with random secrets and CDK
  // cannot have a stale signature collision for those outputs. The
  // `recoverKeysetCountersForMint` early-return handles this. We do not
  // unit-test it here because the no-mnemonic path in `cashu.ts:getWallet`
  // bypasses the mocked store's `getWallet` and constructs a fresh wallet
  // that calls `loadMint()` over HTTP — out of scope for a vitest mock.
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
  it("skips keysets already marked recovered", async () => {
    mocks.store.keysetCountersRecovered = { k1: true };

    await cashu.recoverKeysetCountersForMint("https://mint.test");

    expect(mocks.wallet.batchRestore).not.toHaveBeenCalled();
  });

  it("walks every keyset of the mint and marks each recovered", async () => {
    mocks.wallet.mint.getKeySets.mockResolvedValueOnce({
      keysets: [{ id: "k1" }, { id: "k2" }],
    });
    mocks.wallet.batchRestore
      .mockResolvedValueOnce({ proofs: [], lastCounterWithSignature: 4 })
      .mockResolvedValueOnce({ proofs: [], lastCounterWithSignature: 9 });

    const r = await cashu.recoverKeysetCountersForMint("https://mint.test");

    expect(mocks.store.keysetCounters).toEqual({ k1: 5, k2: 10 });
    expect(mocks.store.keysetCountersRecovered).toEqual({ k1: true, k2: true });
    expect(r.scannedKeysets).toEqual(["k1", "k2"]);
  });

  it("walks every supported advertised keyset unit when no baseAsset filter is provided", async () => {
    mocks.wallet.mint.getKeySets.mockResolvedValueOnce({
      keysets: [
        { id: "sat-keyset", unit: "sat" },
        { id: "msat-keyset", unit: "msat" },
      ],
    });
    mocks.wallet.batchRestore
      .mockResolvedValueOnce({ proofs: [], lastCounterWithSignature: 2 })
      .mockResolvedValueOnce({ proofs: [], lastCounterWithSignature: 8 });

    const r = await cashu.recoverKeysetCountersForMint("https://mint.test");

    expect(mocks.getWallet).toHaveBeenCalledWith("https://mint.test", "sat");
    expect(mocks.getWallet).toHaveBeenCalledWith("https://mint.test", "msat");
    expect(mocks.store.keysetCounters).toEqual({ "sat-keyset": 3, "msat-keyset": 9 });
    expect(r.scannedKeysets).toEqual(["sat-keyset", "msat-keyset"]);
  });

  it("preserves exact sat and msat units while recovering sat-market keysets", async () => {
    mocks.wallet.mint.getKeySets.mockResolvedValueOnce({
      keysets: [
        { id: "sat-keyset", unit: "sat" },
        { id: "msat-keyset", unit: "msat" },
      ],
    });
    mocks.wallet.batchRestore
      .mockResolvedValueOnce({
        proofs: [{ id: "sat-keyset", amount: 2, secret: "sat-proof", C: "Csat" }],
        lastCounterWithSignature: 2,
      })
      .mockResolvedValueOnce({
        proofs: [{ id: "msat-keyset", amount: 2_000, secret: "msat-proof", C: "Cmsat" }],
        lastCounterWithSignature: 8,
      });

    await cashu.recoverKeysetCountersForMint("https://mint.test", {
      baseAsset: "sat",
    });

    expect(mocks.getWallet).toHaveBeenCalledWith("https://mint.test", "sat");
    expect(mocks.getWallet).toHaveBeenCalledWith("https://mint.test", "msat");
    expect(mocks.addProofs).toHaveBeenCalledWith([
      expect.objectContaining({
        secret: "sat-proof",
        baseAsset: "sat",
        unit: "sat",
      }),
    ]);
    expect(mocks.addProofs).toHaveBeenCalledWith([
      expect.objectContaining({
        secret: "msat-proof",
        baseAsset: "sat",
        unit: "msat",
      }),
    ]);
  });

  it("does not mark a keyset recovered when NUT-07 classification fails", async () => {
    mocks.wallet.mint.getKeySets.mockResolvedValueOnce({
      keysets: [{ id: "msat-keyset", unit: "msat" }],
    });
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: [{ id: "msat-keyset", amount: 2_000, secret: "proof", C: "C" }],
      lastCounterWithSignature: 2,
    });
    mocks.wallet.groupProofsByState.mockRejectedValueOnce(new Error("NUT-07 unavailable"));

    const result = await cashu.recoverKeysetCountersForMint("https://mint.test", {
      baseAsset: "sat",
    });

    expect(mocks.store.keysetCountersRecovered["msat-keyset"]).toBeUndefined();
    expect(mocks.addProofs).not.toHaveBeenCalled();
    expect(result.scannedKeysets).toEqual([]);
  });

  it("uses fresh keysets from mint.getKeySets, not stale store keysets (codex review #3)", async () => {
    // Store has only k1; the mint has rotated to k2.
    mocks.store.mints = [{ url: "https://mint.test", keysets: [{ id: "k1" }] }];
    mocks.wallet.mint.getKeySets.mockResolvedValueOnce({ keysets: [{ id: "k2" }] });
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: [],
      lastCounterWithSignature: 2,
    });

    const r = await cashu.recoverKeysetCountersForMint("https://mint.test");

    expect(mocks.wallet.batchRestore).toHaveBeenCalledWith(300, 100, 0, "k2");
    expect(mocks.store.keysetCounters.k2).toBe(3);
    expect(r.scannedKeysets).toEqual(["k2"]);
  });

  it("falls back to stored keysets if mint.getKeySets fails (network down)", async () => {
    mocks.wallet.mint.getKeySets.mockRejectedValueOnce(new Error("network"));
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: [],
      lastCounterWithSignature: 1,
    });

    const r = await cashu.recoverKeysetCountersForMint("https://mint.test");

    expect(mocks.wallet.batchRestore).toHaveBeenCalledWith(300, 100, 0, "k1");
    expect(r.scannedKeysets).toEqual(["k1"]);
  });

  it("honours { force: true } and rescans even when keysetCountersRecovered is true (codex review #2)", async () => {
    mocks.store.keysetCountersRecovered = { k1: true };
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: [],
      lastCounterWithSignature: 12,
    });

    const r = await cashu.recoverKeysetCountersForMint("https://mint.test", { force: true });

    // Counter was advanced despite the flag — proves the safety-net path
    // can re-scan even after the startup migration already ran.
    expect(mocks.store.keysetCounters.k1).toBe(13);
    expect(r.scannedKeysets).toEqual(["k1"]);
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
      { id: "k1", amount: 50, secret: "unspent1", C: "C1" },
      { id: "k1", amount: 100, secret: "spent1", C: "C2" },
      { id: "k1", amount: 25, secret: "pending1", C: "C3" },
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
    expect(persisted.map((p) => p.secret)).toEqual(["unspent1"]);
    // Spent proofs MUST NOT land in IndexedDB.
    expect(persisted.find((p) => p.secret === "spent1")).toBeUndefined();
    // Pending proofs are also excluded — they may resolve to SPENT shortly.
    expect(persisted.find((p) => p.secret === "pending1")).toBeUndefined();
  });

  it("handles batchRestore returning no signatures (fresh wallet) by setting counter to 0", async () => {
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: [],
      lastCounterWithSignature: undefined,
    });

    await cashu.recoverKeysetCountersForMint("https://mint.test");

    expect(mocks.store.keysetCounters.k1).toBe(0);
    expect(mocks.store.keysetCountersRecovered.k1).toBe(true);
  });

  it("does NOT lower an existing higher counter (max(current, recovered+1))", async () => {
    mocks.store.keysetCounters = { k1: 100 };
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: [],
      lastCounterWithSignature: 5,
    });

    await cashu.recoverKeysetCountersForMint("https://mint.test");

    expect(mocks.store.keysetCounters.k1).toBe(100);
  });
});
