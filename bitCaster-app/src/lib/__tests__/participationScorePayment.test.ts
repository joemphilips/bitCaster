import { beforeEach, describe, expect, it, vi } from "vitest";
import { participationScoreRecipientProductBinding } from "@bitcaster/client-sdk/durableRecipientProductBinding";

const PAYMENT_ID = "00000000-0000-4000-8000-000000000001";
const WALLET_ID = "aa".repeat(32);

const mocks = vi.hoisted(() => ({
  getParticipationScore: vi.fn(),
  getParticipationScorePayment: vi.fn(),
  payParticipationScoreEcash: vi.fn(),
  ensureImplicitWallet: vi.fn(),
  getProofs: vi.fn(),
  sendToRecipient: vi.fn(),
  advance: vi.fn(),
  getDelivery: vi.fn(),
}));

vi.mock("@/lib/markets", () => ({
  getParticipationScore: mocks.getParticipationScore,
  getParticipationScorePayment: mocks.getParticipationScorePayment,
  payParticipationScoreEcash: mocks.payParticipationScoreEcash,
}));

vi.mock("@/stores/wallet", () => ({
  useWalletStore: {
    getState: () => ({ ensureImplicitWallet: mocks.ensureImplicitWallet }),
  },
}));

vi.mock("@/stores/proof-db", () => ({
  currentGuiWalletId: () => WALLET_ID,
  getBoundedUnitProofsForAmountUnderLock: (...args: unknown[]) =>
    mocks.getProofs(...args),
}));

vi.mock("@/stores/gui-custody-authority", () => ({
  withGuiCustodyProfileLockForWallet: async (
    _walletId: string,
    action: (...args: unknown[]) => unknown,
  ) => action({}, { kind: "wallet-lock" }),
}));

vi.mock("@/stores/gui-ordinary-wallet-operation", () => ({
  sendGuiCashuToDurableRecipient: (...args: unknown[]) =>
    mocks.sendToRecipient(...args),
}));

vi.mock("@/stores/gui-outgoing-recipient-coordinator", () => ({
  advanceGuiOutgoingRecipientDeliveryOnce: (...args: unknown[]) =>
    mocks.advance(...args),
  getGuiOutgoingRecipientDelivery: (...args: unknown[]) =>
    mocks.getDelivery(...args),
}));

vi.mock("@bitcaster/client-sdk/durableRecipientSubmission", () => ({
  readDurableRecipientSubmissionAuthority: (value: unknown) => value,
}));

const {
  createGuiParticipationScorePaymentTransport,
  ensureParticipationScoreForNextMatch,
} = await import(
  "../participationScorePayment"
);

const baseScore = {
  accountSubject: "account_primary",
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
    mocks.ensureImplicitWallet.mockResolvedValue(undefined);
    mocks.getParticipationScore.mockResolvedValue(baseScore);
    mocks.getProofs.mockResolvedValue([
      { id: "sat-keyset", amount: 10, secret: "sat-proof", C: "sat-C" },
    ]);
    mocks.sendToRecipient.mockResolvedValue({
      operationId: "wallet-send-score",
      keep: [],
      send: [],
    });
    mocks.advance.mockResolvedValue(creditedAdvanceResult());
    mocks.getDelivery
      .mockResolvedValueOnce(null)
      .mockImplementation((_walletId: string, paymentId: string) =>
        scoreDeliveryRow(1, paymentId),
      );
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
    expect(mocks.getProofs).not.toHaveBeenCalled();
    expect(mocks.sendToRecipient).not.toHaveBeenCalled();
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
    expect(mocks.getProofs).not.toHaveBeenCalled();
  });

  it("returns the regular sat deficit without preparing a wallet send", async () => {
    mocks.getParticipationScore.mockResolvedValue({
      ...baseScore,
      balance: -2,
      matchDebitScore: 1,
    });
    mocks.getProofs.mockResolvedValue([
      { id: "sat-keyset", amount: 1, secret: "sat-proof", C: "sat-C" },
    ]);

    await expect(
      ensureParticipationScoreForNextMatch({
        mintUrl: "https://mint.example",
      }),
    ).resolves.toMatchObject({
      kind: "needs-regular-top-up",
      requiredSats: 3,
      balanceSats: 1,
      deficitSats: 2,
    });
    expect(mocks.sendToRecipient).not.toHaveBeenCalled();
  });

  it("uses the shared durable recipient path with the exact Score tuple", async () => {
    mocks.getParticipationScore.mockResolvedValue({
      ...baseScore,
      balance: -1,
      matchDebitScore: 1,
    });
    mocks.getDelivery
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockImplementation((_walletId: string, paymentId: string) =>
        scoreDeliveryRow(2, paymentId),
      );

    const result = await ensureParticipationScoreForNextMatch({
      mintUrl: "https://mint.example/",
      paymentId: PAYMENT_ID,
    });

    expect(result).toMatchObject({
      kind: "paid",
      paymentId: PAYMENT_ID,
      payment: {
        paymentId: PAYMENT_ID,
        status: "credited",
        amountSats: 2,
        creditedScore: 2,
      },
    });
    expect(mocks.sendToRecipient).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedWalletId: WALLET_ID,
        amount: 2,
        mintUrl: "https://mint.example",
        unit: "sat",
        recipient: {
          deliveryId: PAYMENT_ID,
          accountSubject: "account_primary",
          recipientKind: "matching-engine",
          purpose: "participation-score",
          destinationId: "participation-score",
          productBinding: participationScoreRecipientProductBinding(),
          mintUrl: "https://mint.example",
          unit: "sat",
          requestedAmount: "2",
          creditPolicy: { kind: "exact-amount" },
        },
        adapter: { kind: "participation-score" },
      }),
    );
    expect(mocks.advance).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: WALLET_ID,
        deliveryId: PAYMENT_ID,
        transport: expect.objectContaining({
          readStatus: expect.any(Function),
          submitExact: expect.any(Function),
        }),
      }),
    );
  });

  it("keeps an uncredited durable payment pending for automatic recovery", async () => {
    mocks.advance.mockResolvedValue({
      kind: "pending",
      row: { delivery: { kind: "active" } },
    });

    await expect(
      ensureParticipationScoreForNextMatch({
        mintUrl: "https://mint.example",
        paymentId: PAYMENT_ID,
      }),
    ).rejects.toThrow("pending and will retry automatically");
    expect(mocks.advance).toHaveBeenCalledTimes(3);
    expect(mocks.sendToRecipient).toHaveBeenCalledTimes(1);
  });

  it("resumes one deterministic pending payment instead of creating another send", async () => {
    mocks.advance.mockResolvedValue({
      kind: "pending",
      row: { delivery: { kind: "active" } },
    });

    await expect(
      ensureParticipationScoreForNextMatch({
        mintUrl: "https://mint.example",
      }),
    ).rejects.toThrow("pending and will retry automatically");
    const firstPaymentId = mocks.sendToRecipient.mock.calls[0]?.[0].recipient
      .deliveryId as string;

    mocks.getDelivery.mockResolvedValue(scoreDeliveryRow(1, firstPaymentId));
    await expect(
      ensureParticipationScoreForNextMatch({
        mintUrl: "https://mint.example",
      }),
    ).rejects.toThrow("pending and will retry automatically");

    expect(mocks.sendToRecipient).toHaveBeenCalledTimes(1);
    expect(mocks.advance).toHaveBeenCalledTimes(6);
    expect(
      mocks.advance.mock.calls.every(
        ([input]) => input.deliveryId === firstPaymentId,
      ),
    ).toBe(true);
  });

  it("does not submit a persisted bearer token after the authenticated account changes", async () => {
    const transport = createGuiParticipationScorePaymentTransport({
      accountSubject: baseScore.accountSubject,
      mintUrl: "https://mint.example",
      amountSats: 2,
      productBinding: participationScoreRecipientProductBinding(),
    });
    mocks.getParticipationScore.mockResolvedValue({
      ...baseScore,
      accountSubject: "account_other",
    });

    await expect(
      transport.submitExact({
        request: {
          schemaVersion: 1,
          deliveryId: PAYMENT_ID,
          accountSubject: baseScore.accountSubject,
          recipientKind: "matching-engine",
          purpose: "participation-score",
          destinationId: "participation-score",
          productBinding: participationScoreRecipientProductBinding(),
          mintUrl: "https://mint.example",
          unit: "sat",
          requestedAmount: "2",
          creditPolicy: { kind: "exact-amount" },
          tokenDigest: "ab".repeat(32),
          encodedTokenBytes: 20,
        },
        encodedToken: "cashuB-secret-token",
      } as never),
    ).rejects.toThrow("account changed during recovery");
    expect(mocks.payParticipationScoreEcash).not.toHaveBeenCalled();
    expect(mocks.getParticipationScorePayment).not.toHaveBeenCalled();
  });
});

function creditedAdvanceResult() {
  return {
    kind: "credited",
    row: {
      delivery: {
        kind: "active",
        record: {
          delivery: {
            state: {
              kind: "credited",
              creditedAmount: "2",
              creditedAtMs: Date.parse("2026-06-09T00:00:00Z"),
            },
          },
        },
      },
    },
  };
}

function scoreDeliveryRow(
  amountSats: number,
  paymentId = PAYMENT_ID,
) {
  return {
    walletId: WALLET_ID,
    deliveryId: paymentId,
    operationId: `wallet-send/${paymentId}`,
    adapter: { kind: "participation-score" as const },
    revision: 0,
    active: 1 as const,
    nextAttemptAtMs: 0,
    attemptCount: 0,
    lastError: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    delivery: {
      kind: "prepared" as const,
      recipient: {
        deliveryId: paymentId,
        accountSubject: baseScore.accountSubject,
        recipientKind: "matching-engine",
        purpose: "participation-score",
        destinationId: "participation-score",
        productBinding: participationScoreRecipientProductBinding(),
        mintUrl: "https://mint.example",
        unit: "sat",
        requestedAmount: String(amountSats),
        creditPolicy: { kind: "exact-amount" as const },
      },
    },
  };
}
