import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let nextCounter = 0;
  const counters = {
    peekNext: vi.fn(async () => nextCounter),
    advanceToAtLeast: vi.fn(async (_keysetId: string, next: number) => {
      nextCounter = Math.max(nextCounter, next);
    }),
  };
  const wallet = {
    createMintQuote: vi.fn(),
    mintProofs: vi.fn(),
    batchRestore: vi.fn(),
    getKeyset: vi.fn(() => ({ id: "k1" })),
    counters,
  };
  const getWallet = vi.fn(async () => wallet);
  const store = {
    mnemonic: "seed words",
    activeMintUrl: "https://mint.test",
    getWallet,
  };
  return {
    counters,
    getWallet,
    setNextCounter: (next: number) => {
      nextCounter = next;
    },
    store,
    wallet,
  };
});

vi.mock("@/stores/wallet", () => ({
  useWalletStore: {
    getState: () => mocks.store,
  },
}));

vi.mock("@/stores/proof-db", () => ({
  addProofs: vi.fn(),
  getProofOperation: vi.fn(),
  getUnitProofs: vi.fn(),
  removeProofs: vi.fn(),
}));

import * as cashu from "../cashu";

function cdkDuplicateError(
  message = "Blinded message already signed or pending",
): Error {
  const error = new Error(message) as Error & {
    code: number;
    status: number;
  };
  error.name = "MintOperationError";
  error.code = message.includes("Blinded message") ? 11003 : 20006;
  error.status = 400;
  return error;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setNextCounter(0);
  mocks.store.mnemonic = "seed words";
  mocks.store.activeMintUrl = "https://mint.test";
  mocks.wallet.getKeyset.mockReturnValue({ id: "k1" });
  mocks.getWallet.mockResolvedValue(mocks.wallet);
});

describe("mintProofs deterministic counter handling", () => {
  const QUOTE = { quote: "q1", request: "lnbc1..." } as never;
  const PROOFS = [
    { id: "k1", amount: 100, secret: "s1", C: "C1" },
  ] as never;

  it("scales sat-market mint quote requests into msat collateral subunits", async () => {
    const quote = { quote: "q-msat", request: "lnbc1...", unit: "msat" };
    mocks.wallet.createMintQuote.mockResolvedValueOnce(quote);

    const result = await cashu.createMintQuote(
      13,
      "https://mint.test",
      "sat",
    );

    expect(result).toBe(quote);
    expect(mocks.wallet.createMintQuote).toHaveBeenCalledWith(13_000);
  });

  it("scales sat-market mint requests into msat collateral subunits", async () => {
    mocks.wallet.mintProofs.mockResolvedValueOnce(PROOFS);

    await cashu.mintProofs(13, QUOTE, "https://mint.test", "sat");

    expect(mocks.wallet.mintProofs).toHaveBeenCalledWith(13_000, "q1");
    expect(mocks.counters.advanceToAtLeast).not.toHaveBeenCalled();
  });

  it.each([
    "Invoice already paid or pending",
    "Blinded message already signed or pending",
  ])(
    "advances exactly one bounded window and retries once for %s",
    async (message) => {
      mocks.setNextCounter(7);
      mocks.wallet.mintProofs
        .mockRejectedValueOnce(cdkDuplicateError(message))
        .mockResolvedValueOnce(PROOFS);

      await expect(
        cashu.mintProofs(100, QUOTE, "https://mint.test", "usd"),
      ).resolves.toEqual(PROOFS);

      expect(mocks.counters.peekNext).toHaveBeenCalledOnce();
      expect(mocks.counters.advanceToAtLeast).toHaveBeenCalledOnce();
      expect(mocks.counters.advanceToAtLeast).toHaveBeenCalledWith("k1", 107);
      expect(mocks.wallet.mintProofs).toHaveBeenCalledTimes(2);
      expect(mocks.wallet.batchRestore).not.toHaveBeenCalled();
    },
  );

  it("propagates a second duplicate without another advance or retry", async () => {
    mocks.wallet.mintProofs.mockRejectedValue(cdkDuplicateError());

    await expect(
      cashu.mintProofs(100, QUOTE, "https://mint.test"),
    ).rejects.toThrow("Blinded message already signed or pending");

    expect(mocks.counters.advanceToAtLeast).toHaveBeenCalledOnce();
    expect(mocks.wallet.mintProofs).toHaveBeenCalledTimes(2);
    expect(mocks.wallet.batchRestore).not.toHaveBeenCalled();
  });

  it("propagates the original duplicate when the bounded advance fails", async () => {
    mocks.wallet.mintProofs.mockRejectedValueOnce(cdkDuplicateError());
    mocks.counters.peekNext.mockRejectedValueOnce(
      new Error("counter storage unavailable"),
    );

    await expect(
      cashu.mintProofs(100, QUOTE, "https://mint.test"),
    ).rejects.toThrow("Blinded message already signed or pending");

    expect(mocks.wallet.mintProofs).toHaveBeenCalledOnce();
    expect(mocks.counters.advanceToAtLeast).not.toHaveBeenCalled();
  });

  it("does not treat an unstructured lookalike error as a mint duplicate", async () => {
    mocks.wallet.mintProofs.mockRejectedValueOnce(
      new Error("Blinded message already signed or pending"),
    );

    await expect(
      cashu.mintProofs(100, QUOTE, "https://mint.test"),
    ).rejects.toThrow("Blinded message already signed or pending");

    expect(mocks.wallet.mintProofs).toHaveBeenCalledOnce();
    expect(mocks.counters.advanceToAtLeast).not.toHaveBeenCalled();
  });

  it("does not swallow unrelated mint failures", async () => {
    mocks.wallet.mintProofs.mockRejectedValueOnce(
      new Error("Lightning payment timeout"),
    );

    await expect(
      cashu.mintProofs(100, QUOTE, "https://mint.test"),
    ).rejects.toThrow("Lightning payment timeout");
    expect(mocks.counters.advanceToAtLeast).not.toHaveBeenCalled();
  });
});
