import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getParticipationScore: vi.fn(),
  payParticipationScoreEcash: vi.fn(),
  spendRegularSatsAsToken: vi.fn(),
  getWalletForUnit: vi.fn(),
  getUnitProofs: vi.fn(),
  addProofs: vi.fn(),
  removeProofs: vi.fn(),
  encodeToken: vi.fn(),
  walletState: {
    mints: [
      {
        url: "https://mint.example",
        keysets: [
          { id: "sat-keyset", unit: "sat" },
          { id: "msat-keyset", unit: "msat" },
        ],
      },
    ],
  },
}));

vi.mock("@/lib/markets", () => ({
  getParticipationScore: mocks.getParticipationScore,
  payParticipationScoreEcash: mocks.payParticipationScoreEcash,
}));

vi.mock("@/lib/cashu", () => ({
  spendRegularSatsAsToken: mocks.spendRegularSatsAsToken,
  getWalletForUnit: mocks.getWalletForUnit,
  encodeToken: mocks.encodeToken,
}));

vi.mock("@/stores/proof-db", () => ({
  getUnitProofs: mocks.getUnitProofs,
  addProofs: mocks.addProofs,
  removeProofs: mocks.removeProofs,
}));

vi.mock("@/stores/wallet", () => ({
  useWalletStore: {
    getState: () => mocks.walletState,
  },
}));

const { ensureParticipationScoreForNextMatch } = await import("../participationScorePayment");

const baseScore = {
  pubkey: "a".repeat(64),
  balance: 0,
  purchasedTotal: 0,
  consumedTotal: 0,
  matchDebitScore: 1,
  enabled: true,
};

describe("ensureParticipationScoreForNextMatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getParticipationScore.mockResolvedValue(baseScore);
    mocks.spendRegularSatsAsToken.mockResolvedValue("cashuB-token");
    mocks.getWalletForUnit.mockResolvedValue({
      send: vi.fn().mockResolvedValue({ keep: [], send: [{ secret: "sat-send" }] }),
    });
    mocks.getUnitProofs.mockResolvedValue([
      { id: "sat-keyset", amount: 10, secret: "sat-proof", C: "sat-C" },
    ]);
    mocks.walletState.mints = [
      {
        url: "https://mint.example",
        keysets: [
          { id: "sat-keyset", unit: "sat" },
          { id: "msat-keyset", unit: "msat" },
        ],
      },
    ];
    mocks.addProofs.mockResolvedValue(undefined);
    mocks.removeProofs.mockResolvedValue(undefined);
    mocks.encodeToken.mockReturnValue("cashuB-token");
    mocks.payParticipationScoreEcash.mockResolvedValue({
      paymentId: "payment-id",
      status: "credited",
      amountSats: 1,
      creditedScore: 1,
      creditedAt: "2026-06-09T00:00:00Z",
    });
  });

  it("does nothing when Score is disabled", async () => {
    mocks.getParticipationScore.mockResolvedValue({
      ...baseScore,
      enabled: false,
    });

    const result = await ensureParticipationScoreForNextMatch({
      mintUrl: "https://mint.example",
    });

    expect(result.kind).toBe("disabled");
    expect(mocks.getUnitProofs).not.toHaveBeenCalled();
    expect(mocks.payParticipationScoreEcash).not.toHaveBeenCalled();
  });

  it("does not spend ecash when balance already covers the next match debit", async () => {
    mocks.getParticipationScore.mockResolvedValue({
      ...baseScore,
      balance: 3,
      matchDebitScore: 3,
    });

    const result = await ensureParticipationScoreForNextMatch({
      mintUrl: "https://mint.example",
    });

    expect(result.kind).toBe("sufficient");
    expect(mocks.getUnitProofs).not.toHaveBeenCalled();
    expect(mocks.payParticipationScoreEcash).not.toHaveBeenCalled();
  });

  it("returns the regular sat top-up deficit when wallet funds cannot cover Score", async () => {
    mocks.getParticipationScore.mockResolvedValue({
      ...baseScore,
      balance: -2,
      matchDebitScore: 1,
    });
    mocks.getUnitProofs.mockResolvedValue([
      { id: "sat-keyset", amount: 1, secret: "sat-proof", C: "sat-C" },
      { id: "msat-keyset", amount: 10_000, secret: "msat-proof", C: "msat-C" },
    ]);

    const result = await ensureParticipationScoreForNextMatch({
      mintUrl: "https://mint.example",
    });

    expect(result).toMatchObject({
      kind: "needs-regular-top-up",
      requiredSats: 3,
      balanceSats: 1,
      deficitSats: 2,
    });
    expect(mocks.payParticipationScoreEcash).not.toHaveBeenCalled();
  });

  it("spends exact sat-keyset proofs unchanged and pays Score with a caller supplied id", async () => {
    const satProofs = [{ id: "sat-keyset", amount: 10, secret: "sat-proof", C: "sat-C" }];
    const msatProof = {
      id: "msat-keyset",
      amount: 10_000,
      secret: "msat-proof",
      C: "msat-C",
    };
    const wallet = {
      send: vi.fn().mockResolvedValue({
        keep: [],
        send: [{ id: "sat-keyset", amount: 2, secret: "sat-send", C: "sat-send-C" }],
      }),
    };
    mocks.getParticipationScore.mockResolvedValue({
      ...baseScore,
      balance: -1,
      matchDebitScore: 1,
    });
    mocks.getWalletForUnit.mockResolvedValue(wallet);
    mocks.getUnitProofs.mockResolvedValue([...satProofs, msatProof]);

    const result = await ensureParticipationScoreForNextMatch({
      mintUrl: "https://mint.example",
      paymentId: "client-payment-id",
    });

    expect(result.kind).toBe("paid");
    expect(mocks.getUnitProofs).toHaveBeenCalledWith("https://mint.example", {
      unit: "sat",
    });
    expect(mocks.getWalletForUnit).toHaveBeenCalledWith("https://mint.example", "sat");
    expect(wallet.send).toHaveBeenCalledWith(2, satProofs);
    expect(wallet.send).not.toHaveBeenCalledWith(2_000, satProofs);
    expect(mocks.spendRegularSatsAsToken).not.toHaveBeenCalled();
    expect(mocks.encodeToken).toHaveBeenCalledWith(
      [{ id: "sat-keyset", amount: 2, secret: "sat-send", C: "sat-send-C" }],
      "https://mint.example",
    );
    expect(mocks.payParticipationScoreEcash).toHaveBeenCalledWith(
      2,
      "cashuB-token",
      "client-payment-id",
    );
  });

  it("retries Score payment with the same token and payment id", async () => {
    mocks.payParticipationScoreEcash
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce({
        paymentId: "client-payment-id",
        status: "credited",
        amountSats: 1,
        creditedScore: 1,
        creditedAt: "2026-06-09T00:00:00Z",
      });

    const result = await ensureParticipationScoreForNextMatch({
      mintUrl: "https://mint.example",
      paymentId: "client-payment-id",
    });

    expect(result.kind).toBe("paid");
    expect(mocks.spendRegularSatsAsToken).not.toHaveBeenCalled();
    expect(mocks.payParticipationScoreEcash).toHaveBeenNthCalledWith(
      1,
      1,
      "cashuB-token",
      "client-payment-id",
    );
    expect(mocks.payParticipationScoreEcash).toHaveBeenNthCalledWith(
      2,
      1,
      "cashuB-token",
      "client-payment-id",
    );
  });
});
