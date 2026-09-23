import { expect, it, vi } from "vitest";
import { buildIndexedDbTokenHoldings } from "../walletHoldings";

const mocks = vi.hoisted(() => ({
  getCanonicalSelectableProofs: vi.fn(),
}));

vi.mock("@/stores/proof-db", () => ({
  getCanonicalSelectableProofs: mocks.getCanonicalSelectableProofs,
  isCtfProof: (proof: { conditionId?: string }) => proof.conditionId !== undefined,
}));

vi.mock("@/lib/browserWalletProfile", () => ({
  activeBrowserWalletScopeId: () => "wallet-a",
  requireActiveBrowserWalletScopeId: () => "wallet-a",
}));

it("builds trade holdings from canonical proofs for only the requested mint and condition", async () => {
  mocks.getCanonicalSelectableProofs.mockResolvedValueOnce([
    { mintUrl: "https://mint.example", baseAsset: "sat", unit: "msat", amount: 11 },
    {
      mintUrl: "https://mint.example",
      baseAsset: "sat",
      unit: "msat",
      amount: 5,
      conditionId: "condition-a",
      outcomeCollection: "Alpha",
    },
    { mintUrl: "https://other.example", baseAsset: "sat", unit: "msat", amount: 100 },
  ]);

  await expect(
    buildIndexedDbTokenHoldings({
      mintUrl: "https://mint.example/",
      conditionId: "condition-a",
      baseAsset: "sat",
    }),
  ).resolves.toEqual({
    primitiveProofsByAtom: { Alpha: 5 },
    complementProofsByAtom: {},
    baseUnitProofs: 11,
  });
  expect(mocks.getCanonicalSelectableProofs).toHaveBeenCalledWith("wallet-a");
});
