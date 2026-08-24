import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getParticipationScore: vi.fn(),
  executeBrowserParticipationScoreDelivery: vi.fn(),
  reconcileBrowserParticipationScoreDeliveryIfPresent: vi.fn(),
  readBrowserParticipationScoreDeliveryPointer: vi.fn(),
  claimBrowserParticipationScoreDeliveryPointer: vi.fn(),
  clearBrowserParticipationScoreDeliveryPointer: vi.fn(),
  captureBrowserMintPersistenceContext: vi.fn(),
  resolveCreatorPubkey: vi.fn(),
  settings: {
    nostrSignerMode: "nip07",
    nsecSecret: null,
    nostrProfile: { pubkey: "a".repeat(64) },
  },
}));

vi.mock("@/lib/markets", () => ({ getParticipationScore: mocks.getParticipationScore }));
vi.mock("@/lib/browserParticipationScoreDelivery", () => ({
  BrowserParticipationScoreInsufficientBalanceError: class extends Error {
    constructor(readonly balanceSats: number) {
      super("browser Participation Score balance is insufficient");
    }
  },
  executeBrowserParticipationScoreDelivery: (...args: unknown[]) =>
    mocks.executeBrowserParticipationScoreDelivery(...args),
  reconcileBrowserParticipationScoreDeliveryIfPresent: (...args: unknown[]) =>
    mocks.reconcileBrowserParticipationScoreDeliveryIfPresent(...args),
}));
vi.mock("@/lib/identityOps", () => ({
  resolveCreatorPubkey: (...args: unknown[]) => mocks.resolveCreatorPubkey(...args),
}));
vi.mock("@/lib/browserParticipationScoreDeliveryPointer", () => ({
  readBrowserParticipationScoreDeliveryPointer: (...args: unknown[]) =>
    mocks.readBrowserParticipationScoreDeliveryPointer(...args),
  claimBrowserParticipationScoreDeliveryPointer: (...args: unknown[]) =>
    mocks.claimBrowserParticipationScoreDeliveryPointer(...args),
  clearBrowserParticipationScoreDeliveryPointer: (...args: unknown[]) =>
    mocks.clearBrowserParticipationScoreDeliveryPointer(...args),
}));
vi.mock("@/lib/cashu", () => ({
  captureBrowserMintPersistenceContext: (...args: unknown[]) =>
    mocks.captureBrowserMintPersistenceContext(...args),
}));
vi.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => mocks.settings },
}));

const { ensureParticipationScoreForNextMatch } = await import("../participationScorePayment");

const baseScore = {
  pubkey: "a".repeat(64),
  balance: 0,
  purchasedTotal: 0,
  consumedTotal: 0,
  enabled: true,
};

describe("ensureParticipationScoreForNextMatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getParticipationScore.mockResolvedValue(baseScore);
    mocks.reconcileBrowserParticipationScoreDeliveryIfPresent.mockResolvedValue(null);
    mocks.readBrowserParticipationScoreDeliveryPointer.mockResolvedValue(null);
    mocks.claimBrowserParticipationScoreDeliveryPointer.mockImplementation(async (input) => ({
      deliveryId: input.deliveryId,
      purchaseEpoch: input.purchaseEpoch,
      revision: 0,
    }));
    mocks.clearBrowserParticipationScoreDeliveryPointer.mockResolvedValue(undefined);
    mocks.captureBrowserMintPersistenceContext.mockReturnValue({
      seed: new Uint8Array(64),
      requireCapturedProfile: vi.fn(),
    });
    mocks.resolveCreatorPubkey.mockReturnValue("subject-1");
    mocks.executeBrowserParticipationScoreDelivery.mockImplementation(async (input) => ({
      progress: "credited",
      transfer: {
        transferId: input.deliveryId,
        requestedAmount: input.requestedAmount,
      },
      delivery: {
        result: {
          creditedAmount: input.requestedAmount,
          businessEventAt: "2026-08-11T00:00:00.000Z",
        },
      },
    }));
  });

  it("does not select funds when Score is disabled or sufficient", async () => {
    mocks.getParticipationScore.mockResolvedValue({ ...baseScore, enabled: false });
    await expect(
      ensureParticipationScoreForNextMatch({ mintUrl: "https://mint.example", requiredScore: 1 }),
    ).resolves.toMatchObject({ kind: "disabled" });

    mocks.getParticipationScore.mockResolvedValue({
      ...baseScore,
      balance: 1,
      purchasedTotal: 1,
    });
    await expect(
      ensureParticipationScoreForNextMatch({ mintUrl: "https://mint.example", requiredScore: 1 }),
    ).resolves.toMatchObject({ kind: "sufficient" });

    expect(mocks.executeBrowserParticipationScoreDelivery).not.toHaveBeenCalled();
  });

  it("uses the durable coordinator for the exact sat deficit and caller-selected id", async () => {
    mocks.getParticipationScore.mockResolvedValue({
      ...baseScore,
      balance: -1,
    });

    const result = await ensureParticipationScoreForNextMatch({
      mintUrl: "https://mint.example",
      paymentId: "3ab0f6ef-00f6-4ca3-bd69-1140528a0e83",
      requiredScore: 4,
    });

    expect(result).toMatchObject({
      kind: "paid",
      paymentId: "3ab0f6ef-00f6-4ca3-bd69-1140528a0e83",
    });
    expect(mocks.executeBrowserParticipationScoreDelivery).toHaveBeenCalledWith({
      deliveryId: "3ab0f6ef-00f6-4ca3-bd69-1140528a0e83",
      accountSubject: "subject-1",
      mintUrl: "https://mint.example",
      requestedAmount: "5",
    });
  });

  it("claims a random canonical delivery id before the first payment", async () => {
    const result = await ensureParticipationScoreForNextMatch({
      mintUrl: "https://mint.example",
      requiredScore: 1,
    });

    const claimedId = mocks.claimBrowserParticipationScoreDeliveryPointer.mock.calls[0]?.[0]
      .deliveryId as string;
    expect(claimedId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(mocks.executeBrowserParticipationScoreDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: claimedId }),
    );
    expect(result).toMatchObject({ kind: "paid", paymentId: claimedId });
    expect(mocks.clearBrowserParticipationScoreDeliveryPointer).not.toHaveBeenCalled();
  });

  it("does not create a second payment when a debit leaves the existing delivery received", async () => {
    mocks.readBrowserParticipationScoreDeliveryPointer.mockResolvedValue({
      deliveryId: "3ab0f6ef-00f6-4ca3-bd69-1140528a0e83",
      purchaseEpoch: 0,
      revision: 0,
    });
    mocks.getParticipationScore.mockResolvedValue({ ...baseScore, consumedTotal: 1, balance: -1 });
    mocks.reconcileBrowserParticipationScoreDeliveryIfPresent.mockResolvedValue({
      progress: "received",
    });

    await expect(
      ensureParticipationScoreForNextMatch({ mintUrl: "https://mint.example", requiredScore: 1 }),
    ).rejects.toThrow(/pending authoritative credit/);

    expect(mocks.executeBrowserParticipationScoreDelivery).not.toHaveBeenCalled();
  });

  it("reconciles an existing payment before a sufficient Score return", async () => {
    mocks.readBrowserParticipationScoreDeliveryPointer.mockResolvedValue({
      deliveryId: "3ab0f6ef-00f6-4ca3-bd69-1140528a0e83",
      purchaseEpoch: 0,
      revision: 0,
    });
    mocks.getParticipationScore.mockResolvedValue({
      ...baseScore,
      balance: 1,
      purchasedTotal: 1,
    });
    mocks.reconcileBrowserParticipationScoreDeliveryIfPresent.mockResolvedValue({
      progress: "credited",
    });

    await expect(
      ensureParticipationScoreForNextMatch({ mintUrl: "https://mint.example", requiredScore: 1 }),
    ).resolves.toMatchObject({ kind: "sufficient" });

    expect(mocks.reconcileBrowserParticipationScoreDeliveryIfPresent).toHaveBeenCalledOnce();
    expect(mocks.executeBrowserParticipationScoreDelivery).not.toHaveBeenCalled();
  });

  it("reconciles the prior pointer after purchasedTotal advances before returning sufficient", async () => {
    mocks.readBrowserParticipationScoreDeliveryPointer.mockResolvedValue({
      deliveryId: "3ab0f6ef-00f6-4ca3-bd69-1140528a0e83",
      purchaseEpoch: 0,
      revision: 0,
    });
    mocks.reconcileBrowserParticipationScoreDeliveryIfPresent.mockResolvedValue({
      progress: "credited",
    });
    mocks.getParticipationScore.mockResolvedValue({
      ...baseScore,
      purchasedTotal: 1,
      balance: 1,
    });

    await expect(
      ensureParticipationScoreForNextMatch({ mintUrl: "https://mint.example", requiredScore: 1 }),
    ).resolves.toMatchObject({ kind: "sufficient" });

    expect(mocks.reconcileBrowserParticipationScoreDeliveryIfPresent).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: "3ab0f6ef-00f6-4ca3-bd69-1140528a0e83" }),
    );
    expect(mocks.clearBrowserParticipationScoreDeliveryPointer).toHaveBeenCalledOnce();
    expect(mocks.executeBrowserParticipationScoreDelivery).not.toHaveBeenCalled();
  });

  it("retries credited reconciliation after a crash before pointer clear", async () => {
    mocks.readBrowserParticipationScoreDeliveryPointer.mockResolvedValue({
      deliveryId: "3ab0f6ef-00f6-4ca3-bd69-1140528a0e83",
      purchaseEpoch: 0,
      revision: 0,
    });
    mocks.reconcileBrowserParticipationScoreDeliveryIfPresent.mockResolvedValue({
      progress: "credited",
    });
    mocks.getParticipationScore.mockResolvedValue({ ...baseScore, purchasedTotal: 1, balance: 1 });
    mocks.clearBrowserParticipationScoreDeliveryPointer
      .mockRejectedValueOnce(new Error("crash before clear"))
      .mockResolvedValueOnce(undefined);

    await expect(
      ensureParticipationScoreForNextMatch({ mintUrl: "https://mint.example", requiredScore: 1 }),
    ).rejects.toThrow(/crash before clear/);
    await expect(
      ensureParticipationScoreForNextMatch({ mintUrl: "https://mint.example", requiredScore: 1 }),
    ).resolves.toMatchObject({ kind: "sufficient" });

    expect(mocks.reconcileBrowserParticipationScoreDeliveryIfPresent).toHaveBeenCalledTimes(2);
    expect(mocks.clearBrowserParticipationScoreDeliveryPointer).toHaveBeenCalledTimes(2);
  });

  it("allows a later payment after authoritative purchase completion clears the prior pointer", async () => {
    const priorId = "3ab0f6ef-00f6-4ca3-bd69-1140528a0e83";
    mocks.readBrowserParticipationScoreDeliveryPointer.mockResolvedValue({
      deliveryId: priorId,
      purchaseEpoch: 0,
      revision: 0,
    });
    mocks.getParticipationScore.mockResolvedValue({ ...baseScore, purchasedTotal: 1, balance: 0 });
    mocks.reconcileBrowserParticipationScoreDeliveryIfPresent.mockResolvedValue({
      progress: "credited",
    });

    await ensureParticipationScoreForNextMatch({
      mintUrl: "https://mint.example",
      requiredScore: 1,
    });

    expect(mocks.executeBrowserParticipationScoreDelivery).toHaveBeenCalledOnce();
    expect(mocks.reconcileBrowserParticipationScoreDeliveryIfPresent).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: priorId }),
    );
    const nextId = mocks.executeBrowserParticipationScoreDelivery.mock.calls[0]?.[0].deliveryId;
    expect(nextId).not.toBe(priorId);
    expect(mocks.clearBrowserParticipationScoreDeliveryPointer).toHaveBeenCalledOnce();
  });

  it("does not contain a direct payParticipationScoreEcash path", async () => {
    expect(mocks.executeBrowserParticipationScoreDelivery).toBeDefined();
    expect("payParticipationScoreEcash" in mocks).toBe(false);
  });
});
