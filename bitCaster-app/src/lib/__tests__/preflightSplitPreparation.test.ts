import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Proof } from "@cashu/cashu-ts";
import type { MarketDetail } from "@/types/market-detail";

const mocks = vi.hoisted(() => ({
  diagnoseProofStates: vi.fn(),
  getBaseProofs: vi.fn(),
  getProofOperation: vi.fn(),
  markProofOperationCompleted: vi.fn(),
  prepareProofOperation: vi.fn(),
  releaseProofReservation: vi.fn(),
  replaceProofs: vi.fn(),
  reserveProofs: vi.fn(),
  computeGrossCtfInputAmountSats: vi.fn(),
  selectCollateralForCtfSplit: vi.fn(),
  splitRegularProofsWithOperation: vi.fn(),
  splitRootCompleteSetForPreflightOrder: vi.fn(),
  resolveRootPreflightOutputAmountSats: vi.fn(),
  getWallet: vi.fn(),
}));

vi.mock("@/lib/proofDiagnostics", () => ({
  diagnoseProofStates: mocks.diagnoseProofStates,
}));
vi.mock("@/lib/ctfSplit", () => ({
  computeGrossCtfInputAmountSats: mocks.computeGrossCtfInputAmountSats,
  selectCollateralForCtfSplit: mocks.selectCollateralForCtfSplit,
  splitRegularProofsWithOperation: mocks.splitRegularProofsWithOperation,
  splitRootCompleteSetForPreflightOrder:
    mocks.splitRootCompleteSetForPreflightOrder,
  resolveRootPreflightOutputAmountSats:
    mocks.resolveRootPreflightOutputAmountSats,
}));
vi.mock("@/stores/proof-db", () => ({
  getBaseProofs: mocks.getBaseProofs,
  getProofOperation: mocks.getProofOperation,
  markProofOperationCompleted: mocks.markProofOperationCompleted,
  prepareProofOperation: mocks.prepareProofOperation,
  releaseProofReservation: mocks.releaseProofReservation,
  replaceProofs: mocks.replaceProofs,
  reserveProofs: mocks.reserveProofs,
}));
vi.mock("@/stores/wallet", () => ({
  useWalletStore: {
    getState: () => ({
      getWallet: mocks.getWallet,
    }),
  },
}));

import {
  prepareCollateralLotForCtfSplit,
  preparePreflightSplitForLimitBuy,
} from "../preflightSplitPreparation";

function proof(secret: string, amount = 100, id = "keyset"): Proof {
  return {
    id,
    amount,
    secret,
    C: `02${secret}`.padEnd(66, "0"),
  } as unknown as Proof;
}

describe("preflight split preparation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          keysets: [
            keyset("keyset-YES", "condition", "YES"),
            keyset("keyset-NO", "condition", "NO"),
          ],
        }),
      }),
    );
    mocks.getProofOperation.mockResolvedValue(null);
    mocks.computeGrossCtfInputAmountSats.mockImplementation(
      ({ faceAmountSats }: { faceAmountSats: number }) => faceAmountSats + 1,
    );
    mocks.resolveRootPreflightOutputAmountSats.mockImplementation(
      ({ amountSats }: { amountSats: number }) => amountSats,
    );
    mocks.diagnoseProofStates.mockResolvedValue(undefined);
    mocks.replaceProofs.mockResolvedValue(undefined);
    mocks.reserveProofs.mockResolvedValue(undefined);
    mocks.releaseProofReservation.mockResolvedValue(undefined);
  });

  it("prepares one fee-aware composite split for the full order amount", async () => {
    const originals = [proof("original-1", 250)];
    const wallet = {
      ...planningWallet("regular-keyset"),
      selectProofsToSend: vi.fn((available: Proof[]) => ({
        send: [available[0]],
        keep: [],
      })),
      getFeesForProofs: vi.fn(() => 1),
    };
    mocks.getBaseProofs.mockResolvedValue(originals);
    mocks.getWallet.mockResolvedValue(wallet);
    mocks.selectCollateralForCtfSplit.mockImplementation(
      async (_mintUrl: string, available: Proof[], faceAmountSats: number) => {
        const child = available.find((p) =>
          p.secret === "regular-child",
        );
        if (!child) throw new Error("fragmented collateral");
        return {
          inputs: [child],
          keep: [],
          inputFeeSats: 0,
          grossInputSats: faceAmountSats + 1,
        };
      },
    );
    mocks.splitRegularProofsWithOperation.mockImplementation(
      async ({
        amountSats,
        proofs,
      }: {
        amountSats: number;
        proofs: Proof[];
      }) => {
        const spent = proofs[0];
        return {
          send: [proof("regular-child", amountSats)],
          keep: [proof("regular-keep", 49)],
          spent: [spent],
        };
      },
    );
    mocks.splitRootCompleteSetForPreflightOrder.mockImplementation(
      async ({ collateralProofs }: { collateralProofs: Proof[] }) => ({
        resolvedKeepOutcomeSetId: "YES",
        resolvedLockOutcomeSetId: "NO",
        lockCollections: ["NO"],
        keepCollections: ["YES"],
        lockProofs: [
          proof(`ctf-no-${collateralProofs[0].secret}`, 200, "keyset-NO"),
        ],
        keepProofs: [
          proof(`ctf-yes-${collateralProofs[0].secret}`, 200, "keyset-YES"),
        ],
        proofsByCollection: {
          YES: [
            proof(`ctf-yes-${collateralProofs[0].secret}`, 200, "keyset-YES"),
          ],
          NO: [proof(`ctf-no-${collateralProofs[0].secret}`, 200, "keyset-NO")],
        },
        spentSatProofs: collateralProofs,
      }),
    );

    await preparePreflightSplitForLimitBuy({
      mintUrl: "https://mint.example",
      market: { id: "condition" } as MarketDetail,
      selectedOutcomeSetId: "YES",
      complementOutcomeSetId: "NO",
      amountSats: 200,
      reservationId: "order-preflight:test",
    });

    expect(mocks.splitRegularProofsWithOperation).toHaveBeenCalledTimes(1);
    expect(mocks.splitRegularProofsWithOperation).toHaveBeenCalledWith(
      expect.objectContaining({ amountSats: 201, proofs: [originals[0]] }),
    );
    expect(mocks.computeGrossCtfInputAmountSats).toHaveBeenCalledWith({
      faceAmountSats: 200,
      keyset: {
        id: "regular-keyset",
        keys: { 1: "02".padEnd(66, "1") },
        input_fee_ppk: 1,
      },
    });
    expect(mocks.splitRootCompleteSetForPreflightOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        amountSats: 200,
        collateralProofs: [expect.objectContaining({ amount: 201 })],
        keepOutcomeSetId: "YES",
        lockOutcomeSetId: "NO",
      }),
    );
    expect(mocks.replaceProofs).toHaveBeenCalledWith(
      ["regular-child"],
      expect.any(Array),
    );
  });

  it("does not reinsert regular split children when replaying after the original input is gone", async () => {
    const original = proof("original-1", 250);
    const child = proof("regular-child-1", 100);
    mocks.getProofOperation.mockResolvedValue({ operationId: "existing" });
    mocks.getWallet.mockResolvedValue(planningWallet("regular-keyset"));
    mocks.splitRegularProofsWithOperation.mockResolvedValue({
      send: [child],
      keep: [proof("regular-keep-1", 150)],
      spent: [original],
    });
    mocks.selectCollateralForCtfSplit.mockResolvedValue({
      inputs: [child],
      keep: [],
      inputFeeSats: 0,
      grossInputSats: 100,
    });

    const result = await prepareCollateralLotForCtfSplit({
      mintUrl: "https://mint.example",
      available: [proof("other", 100)],
      faceAmountSats: 100,
      reservationId: "order-preflight:test",
      lotIndex: 0,
    });

    expect(result.inputs).toEqual([child]);
    expect(mocks.replaceProofs).not.toHaveBeenCalled();
    expect(mocks.reserveProofs).toHaveBeenCalledWith(
      ["regular-child-1"],
      "order-preflight:test",
    );
  });

  it("reports insufficient balance when proof selection cannot cover the gross split amount", async () => {
    mocks.getWallet.mockResolvedValue({
      ...planningWallet("regular-keyset"),
      selectProofsToSend: vi.fn(() => ({ send: [], keep: [] })),
      getFeesForProofs: vi.fn(() => 1),
    });
    mocks.selectCollateralForCtfSplit.mockRejectedValue(
      new Error("fragmented collateral"),
    );

    await expect(
      prepareCollateralLotForCtfSplit({
        mintUrl: "https://mint.example",
        available: [proof("regular-1", 50)],
        faceAmountSats: 100,
        reservationId: "order-preflight:test",
        lotIndex: 0,
      }),
    ).rejects.toThrow(
      "Insufficient balance for CTF split: need 101 sats face collateral, have 50.",
    );
  });

  it("reports empty collateral separately from an underfunded proof set", async () => {
    mocks.getWallet.mockResolvedValue({
      ...planningWallet("regular-keyset"),
      selectProofsToSend: vi.fn(() => ({ send: [], keep: [] })),
      getFeesForProofs: vi.fn(() => 1),
    });
    mocks.selectCollateralForCtfSplit.mockRejectedValue(
      new Error("fragmented collateral"),
    );

    await expect(
      prepareCollateralLotForCtfSplit({
        mintUrl: "https://mint.example",
        available: [],
        faceAmountSats: 100,
        reservationId: "order-preflight:test",
        lotIndex: 0,
      }),
    ).rejects.toThrow(
      "No regular collateral proofs are available for CTF split.",
    );
  });
});

function keyset(id: string, conditionId: string, outcomeCollection: string) {
  return {
    id,
    condition_id: conditionId,
    outcome_collection: outcomeCollection,
    outcome_collection_id: outcomeCollection,
  };
}

function planningWallet(keysetId: string) {
  return {
    keysetId,
    mint: {
      getKeys: vi.fn(async () => ({
        keysets: [
          {
            id: keysetId,
            keys: { 1: "02".padEnd(66, "1") },
            input_fee_ppk: 1,
          },
        ],
      })),
    },
  };
}
