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
  selectCollateralForCtfSplit: vi.fn(),
  splitRegularProofsWithOperation: vi.fn(),
  splitRootCompleteSetForPreflightOrder: vi.fn(),
  getWallet: vi.fn(),
}));

vi.mock("@/lib/proofDiagnostics", () => ({
  diagnoseProofStates: mocks.diagnoseProofStates,
}));
vi.mock("@/lib/ctfSplit", () => ({
  selectCollateralForCtfSplit: mocks.selectCollateralForCtfSplit,
  splitRegularProofsWithOperation: mocks.splitRegularProofsWithOperation,
  splitRootCompleteSetForPreflightOrder:
    mocks.splitRootCompleteSetForPreflightOrder,
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

function proof(secret: string, amount = 100): Proof {
  return {
    id: "keyset",
    amount,
    secret,
    C: `02${secret}`.padEnd(66, "0"),
  } as unknown as Proof;
}

describe("preflight split preparation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProofOperation.mockResolvedValue(null);
    mocks.diagnoseProofStates.mockResolvedValue(undefined);
    mocks.replaceProofs.mockResolvedValue(undefined);
    mocks.reserveProofs.mockResolvedValue(undefined);
    mocks.releaseProofReservation.mockResolvedValue(undefined);
  });

  it("removes the original regular-split inputs from later lot selection", async () => {
    const originals = [proof("original-1", 250), proof("original-2", 250)];
    const wallet = {
      selectProofsToSend: vi.fn((available: Proof[]) => ({
        send: [available[0]],
        keep: [],
      })),
      getFeesForProofs: vi.fn(() => 0),
    };
    mocks.getBaseProofs.mockResolvedValue(originals);
    mocks.getWallet.mockResolvedValue(wallet);
    mocks.selectCollateralForCtfSplit.mockImplementation(
      async (_mintUrl: string, available: Proof[]) => {
        const child = available.find((p) =>
          p.secret.startsWith("regular-child-"),
        );
        if (!child) throw new Error("fragmented collateral");
        return {
          inputs: [child],
          keep: [],
          inputFeeSats: 0,
          grossInputSats: 100,
        };
      },
    );
    mocks.splitRegularProofsWithOperation.mockImplementation(
      async ({ proofs }: { proofs: Proof[] }) => {
        const spent = proofs[0];
        const lot = spent.secret.endsWith("-1") ? "1" : "2";
        return {
          send: [proof(`regular-child-${lot}`, 100)],
          keep: [proof(`regular-keep-${lot}`, 150)],
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
        lockProofs: [proof(`ctf-no-${collateralProofs[0].secret}`)],
        keepProofs: [proof(`ctf-yes-${collateralProofs[0].secret}`)],
        proofsByCollection: {
          YES: [proof(`ctf-yes-${collateralProofs[0].secret}`)],
          NO: [proof(`ctf-no-${collateralProofs[0].secret}`)],
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

    expect(mocks.splitRegularProofsWithOperation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ proofs: [originals[0]] }),
    );
    expect(mocks.splitRegularProofsWithOperation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ proofs: [originals[1]] }),
    );
    expect(mocks.replaceProofs).toHaveBeenCalledWith(
      ["regular-child-1"],
      expect.any(Array),
    );
    expect(mocks.replaceProofs).toHaveBeenCalledWith(
      ["regular-child-2"],
      expect.any(Array),
    );
  });

  it("does not reinsert regular split children when replaying after the original input is gone", async () => {
    const original = proof("original-1", 250);
    const child = proof("regular-child-1", 100);
    mocks.getProofOperation.mockResolvedValue({ operationId: "existing" });
    mocks.getWallet.mockResolvedValue({});
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
});
