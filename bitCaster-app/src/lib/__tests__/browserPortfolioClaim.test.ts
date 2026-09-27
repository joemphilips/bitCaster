import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activeScope: "scope",
  wallet: {},
  keyset: { id: "regular", unit: "msat", keys: { "1": "02-key" }, input_fee_ppk: 2 },
  owner: { incarnationId: "owner", fencingEpoch: 1, observedAtMs: 1 },
  getWallet: vi.fn(),
  keysetLookup: vi.fn(),
  attestation: vi.fn(),
  counterReady: vi.fn(),
  claimScope: vi.fn(),
  releaseScope: vi.fn(),
  claim: vi.fn(),
  lock: vi.fn(),
  CounterReadinessError: class CounterReadinessError extends Error {},
}));
vi.mock("@bitcaster/client-sdk/ctfRedeem", () => ({ getActiveRegularKeyset: mocks.keysetLookup }));
vi.mock("@bitcaster/client-sdk/ctfSplit", () => ({ restoreOutputGroups: vi.fn() }));
vi.mock("../../stores/proof-db", () => ({ db: {} }));
vi.mock("../../stores/durable-custody-db", () => ({
  BrowserDurableCustodyAdapter: class {
    claimScope = mocks.claimScope;
    releaseScope = mocks.releaseScope;
  },
}));
vi.mock("../../stores/browser-wallet-counter-db", () => ({
  createActiveBrowserWalletCounterSource: () => ({}),
}));
vi.mock("../../stores/wallet", () => ({
  useWalletStore: { getState: () => ({ mnemonic: "captured wallet" }) },
  getWalletForMnemonicUnit: mocks.getWallet,
}));
vi.mock("../browserWalletProfile", () => ({ activeBrowserWalletScopeId: () => mocks.activeScope }));
vi.mock("../browserCtfRangeOrderSource", () => ({
  browserWalletScope: () => ({ scopeId: "scope" }),
}));
vi.mock("../browserCtfPositionClaim", () => ({ claimBrowserCanonicalCtfPosition: mocks.claim }));
vi.mock("../cashu", () => ({
  fetchConditionAttestation: mocks.attestation,
  ensureWalletKeysetCounterReady: mocks.counterReady,
  WalletKeysetCounterReadinessError: mocks.CounterReadinessError,
}));
vi.mock("../bip39", () => ({ toSeed: () => new Uint8Array(64) }));
vi.mock("../walletProfileLock", () => ({ withWalletProfileLock: mocks.lock }));

import { claimPortfolioPosition } from "../browserPortfolioClaim";

const position = {
  mintUrl: "https://mint.example",
  conditionId: "a".repeat(64),
  outcomeCollection: "Alpha",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.activeScope = "scope";
  mocks.getWallet.mockResolvedValue(mocks.wallet);
  mocks.keysetLookup.mockResolvedValue(mocks.keyset);
  mocks.attestation.mockResolvedValue({ witnessJson: "witness" });
  mocks.counterReady.mockResolvedValue(undefined);
  mocks.claimScope.mockResolvedValue(mocks.owner);
  mocks.releaseScope.mockResolvedValue(undefined);
  mocks.lock.mockImplementation(async (_scope, action) => action());
  mocks.claim.mockResolvedValue({ kind: "completed", committedPayoutAmount: 100 });
});

describe("Portfolio claim entry point", () => {
  it("prepares the current keyset and attestation only when a new leg is needed", async () => {
    mocks.claim.mockImplementation(async ({ context }) => {
      expect(mocks.keysetLookup).not.toHaveBeenCalled();
      expect(mocks.attestation).not.toHaveBeenCalled();
      expect(mocks.counterReady).not.toHaveBeenCalled();
      expect(context.regularKeyset).toBeUndefined();
      expect(context.oracleWitness).toBeUndefined();

      const prepared = await context.prepareNewLegAuthority();
      expect(prepared).toEqual({ regularKeyset: mocks.keyset, oracleWitness: "witness" });
      return { kind: "completed", committedPayoutAmount: 100 };
    });

    await expect(claimPortfolioPosition(position)).resolves.toMatchObject({
      committedPayoutAmount: 100,
    });

    expect(mocks.getWallet).toHaveBeenCalledWith(position.mintUrl, "msat", "captured wallet");
    expect(mocks.keysetLookup).toHaveBeenCalledWith(mocks.wallet, "msat");
    expect(mocks.attestation).toHaveBeenCalledWith(position.conditionId);
    expect(mocks.counterReady).toHaveBeenCalledWith({
      scopeId: "scope",
      mintUrl: position.mintUrl,
      unit: "msat",
      keyset: {
        id: "regular",
        canonicalMintUrl: position.mintUrl,
        unit: "msat",
        active: true,
        keys: mocks.keyset.keys,
        inputFeePpk: 2,
        finalExpiry: null,
      },
      profileLockHeld: true,
    });
    expect(mocks.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        position: { conditionId: position.conditionId, outcomeCollection: "Alpha" },
        walletProfileLockHeld: true,
        context: expect.objectContaining({
          owner: mocks.owner,
          prepareNewLegAuthority: expect.any(Function),
        }),
      }),
    );
    expect(mocks.lock.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.claimScope.mock.invocationCallOrder[0]!,
    );
    expect(mocks.claim.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.releaseScope.mock.invocationCallOrder[0]!,
    );
  });

  it.each(["attestation", "counterReady"] as const)(
    "refuses a profile change during %s before returning new claim authority",
    async (step) => {
      mocks[step].mockImplementation(async () => {
        mocks.activeScope = "other-scope";
        return step === "attestation" ? { witnessJson: "witness" } : undefined;
      });
      mocks.claim.mockImplementation(async ({ context }) => {
        await context.prepareNewLegAuthority();
      });

      await expect(claimPortfolioPosition(position)).resolves.toMatchObject({
        kind: "error",
        error: {
          code: "claim-failed",
          category: "profile-ownership",
          attemptRef: expect.any(String),
        },
      });
      expect(mocks.claimScope).toHaveBeenCalledOnce();
      expect(mocks.claim).toHaveBeenCalledOnce();
      expect(mocks.releaseScope).toHaveBeenCalledOnce();
    },
  );

  it("releases custody ownership after a failed claim without reporting success", async () => {
    mocks.claim.mockRejectedValue(new Error("recovery incomplete"));

    await expect(claimPortfolioPosition(position)).resolves.toMatchObject({
      kind: "error",
      error: {
        code: "claim-failed",
        category: "persisted-recovery",
        message: "A saved claim operation needs recovery before it can continue.",
        attemptRef: expect.any(String),
      },
    });
    expect(mocks.releaseScope).toHaveBeenCalledOnce();
  });

  it("does not prepare a new claim leg while its payout counter is unavailable", async () => {
    mocks.counterReady.mockRejectedValue(new mocks.CounterReadinessError());
    mocks.claim.mockImplementation(async ({ context }) => context.prepareNewLegAuthority());

    const result = await claimPortfolioPosition(position);
    expect(result).toMatchObject({
      kind: "error",
      error: {
        code: "claim-failed",
        category: "counter-readiness",
        message: "Wallet counter recovery is incomplete for the selected keyset.",
        attemptRef: expect.any(String),
      },
    });
    if (result.kind !== "error") throw new Error("Claim should report a safe error.");
    expect(result.error).not.toHaveProperty("operationRef");
    expect(mocks.releaseScope).toHaveBeenCalledOnce();
  });

  it.each([
    ["keysetLookup", "keyset-authority", "The selected keyset could not be verified."],
    ["attestation", "attestation-lookup", "The condition attestation could not be loaded."],
  ] as const)(
    "returns a safe %s failure without exposing upstream text",
    async (step, category, message) => {
      mocks[step].mockRejectedValue(new Error("private upstream response material"));
      mocks.claim.mockImplementation(async ({ context }) => context.prepareNewLegAuthority());

      const result = await claimPortfolioPosition(position);

      expect(result).toMatchObject({
        kind: "error",
        error: {
          code: "claim-failed",
          category,
          message,
          attemptRef: expect.any(String),
        },
      });
      expect(JSON.stringify(result)).not.toContain("private upstream response material");
      expect(mocks.releaseScope).toHaveBeenCalledOnce();
    },
  );

  it("does not recover counters when the saved claim needs no new leg", async () => {
    await expect(claimPortfolioPosition(position)).resolves.toMatchObject({
      kind: "completed",
      committedPayoutAmount: 100,
    });
    expect(mocks.counterReady).not.toHaveBeenCalled();
    expect(mocks.keysetLookup).not.toHaveBeenCalled();
    expect(mocks.attestation).not.toHaveBeenCalled();
  });
});
