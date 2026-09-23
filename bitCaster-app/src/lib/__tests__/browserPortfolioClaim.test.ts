import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activeScope: "scope",
  wallet: {},
  keyset: { id: "regular", unit: "msat" },
  owner: { incarnationId: "owner", fencingEpoch: 1, observedAtMs: 1 },
  getWallet: vi.fn(),
  keysetLookup: vi.fn(),
  attestation: vi.fn(),
  claimScope: vi.fn(),
  releaseScope: vi.fn(),
  claim: vi.fn(),
  lock: vi.fn(),
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
vi.mock("../cashu", () => ({ fetchConditionAttestation: mocks.attestation }));
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

  it("does not let a profile change during lazy preparation cross into the claim", async () => {
    mocks.attestation.mockImplementation(async () => {
      mocks.activeScope = "other-scope";
      return { witnessJson: "witness" };
    });
    mocks.claim.mockImplementation(async ({ context }) => {
      await context.prepareNewLegAuthority();
    });

    await expect(claimPortfolioPosition(position)).rejects.toThrow("wallet profile changed");
    expect(mocks.claimScope).toHaveBeenCalledOnce();
    expect(mocks.claim).toHaveBeenCalledOnce();
    expect(mocks.releaseScope).toHaveBeenCalledOnce();
  });

  it("releases custody ownership after a failed claim without reporting success", async () => {
    mocks.claim.mockRejectedValue(new Error("recovery incomplete"));

    await expect(claimPortfolioPosition(position)).rejects.toThrow("recovery incomplete");
    expect(mocks.releaseScope).toHaveBeenCalledOnce();
  });
});
