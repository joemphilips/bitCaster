import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getParticipationScore: vi.fn(),
  payParticipationScoreEcash: vi.fn(),
  spendRegularSatsAsToken: vi.fn(),
  getBalance: vi.fn(),
}));

vi.mock("@/lib/markets", () => ({
  getParticipationScore: mocks.getParticipationScore,
  payParticipationScoreEcash: mocks.payParticipationScoreEcash,
}));

vi.mock("@/lib/cashu", () => ({
  spendRegularSatsAsToken: mocks.spendRegularSatsAsToken,
}));

vi.mock("@/stores/wallet", () => ({
  getBalance: mocks.getBalance,
}));

const { ensureParticipationScoreForNextMatch } = await import(
  "../participationScorePayment"
);

const baseScore = {
  pubkey: "a".repeat(64),
  balance: 0,
  purchasedTotal: 0,
  consumedTotal: 0,
  penaltyTotal: 0,
  matchDebitScore: 1,
  enabled: true,
};

describe("ensureParticipationScoreForNextMatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getParticipationScore.mockResolvedValue(baseScore);
    mocks.getBalance.mockResolvedValue(10);
    mocks.spendRegularSatsAsToken.mockResolvedValue("cashuB-token");
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
    expect(mocks.getBalance).not.toHaveBeenCalled();
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
    expect(mocks.getBalance).not.toHaveBeenCalled();
    expect(mocks.payParticipationScoreEcash).not.toHaveBeenCalled();
  });

  it("returns the regular sat top-up deficit when wallet funds cannot cover Score", async () => {
    mocks.getParticipationScore.mockResolvedValue({
      ...baseScore,
      balance: -2,
      matchDebitScore: 1,
    });
    mocks.getBalance.mockResolvedValue(1);

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

  it("spends exact regular sats and pays Score with a caller supplied id", async () => {
    mocks.getParticipationScore.mockResolvedValue({
      ...baseScore,
      balance: -1,
      matchDebitScore: 1,
    });

    const result = await ensureParticipationScoreForNextMatch({
      mintUrl: "https://mint.example",
      paymentId: "client-payment-id",
    });

    expect(result.kind).toBe("paid");
    expect(mocks.spendRegularSatsAsToken).toHaveBeenCalledWith(
      2,
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
    expect(mocks.spendRegularSatsAsToken).toHaveBeenCalledTimes(1);
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
