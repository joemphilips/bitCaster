import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileGuiOutgoingPayments } from "../guiOutgoingPaymentRecovery";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  next: vi.fn(),
  advance: vi.fn(),
  defer: vi.fn(),
  marketAdvance: vi.fn(),
  scoreAdvance: vi.fn(),
  ensureWallet: vi.fn(),
}));

vi.mock("@/stores/gui-outgoing-recipient-coordinator", () => ({
  listDueGuiOutgoingRecipientDeliveries: mocks.list,
  getNextGuiOutgoingRecipientAttemptAt: mocks.next,
  advanceGuiOutgoingRecipientDeliveryOnce: mocks.advance,
  deferGuiOutgoingRecipientDelivery: mocks.defer,
}));

vi.mock("../guiMarketFundingPayment", () => ({
  advanceGuiMarketFundingDelivery: mocks.marketAdvance,
}));

vi.mock("../participationScorePayment", () => ({
  advanceGuiParticipationScoreDelivery: mocks.scoreAdvance,
}));

vi.mock("@/stores/proof-db", () => ({
  currentGuiWalletId: () => "aa".repeat(32),
}));

vi.mock("@/stores/wallet", () => ({
  useWalletStore: {
    getState: () => ({ ensureImplicitWallet: mocks.ensureWallet }),
  },
}));

describe("GUI outgoing payment startup router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureWallet.mockResolvedValue(undefined);
    mocks.list.mockResolvedValue({
      records: [
        row("market-1", { kind: "market-funding" }),
        row("score-1", { kind: "participation-score" }),
      ],
      hasMore: true,
      nextCursor: [10, "score-1"],
    });
    mocks.next.mockResolvedValue(25);
    mocks.marketAdvance.mockResolvedValue({
      status: "completed",
      depositId: "market-1",
    });
    mocks.scoreAdvance.mockResolvedValue({
      kind: "received",
      row: row("score-1", { kind: "participation-score" }),
    });
  });

  it("routes market and Score rows from one bounded due-page cursor", async () => {
    const marketFundingRemote = {} as never;
    const result = await reconcileGuiOutgoingPayments({
      marketFundingRemote,
      cursor: [5, "prior"],
    });

    expect(mocks.list).toHaveBeenCalledWith({
      walletId: "aa".repeat(32),
      cursor: [5, "prior"],
    });
    expect(mocks.marketAdvance).toHaveBeenCalledWith(
      "aa".repeat(32),
      "market-1",
      marketFundingRemote,
    );
    expect(mocks.scoreAdvance).toHaveBeenCalledWith(
      "aa".repeat(32),
      "score-1",
    );
    expect(result).toMatchObject({
      hasMore: true,
      nextCursor: [10, "score-1"],
      nextAttemptAt: 25,
      blocked: [],
    });
    expect(result.remaining.map((entry) => entry.deliveryId)).toEqual([
      "score-1",
    ]);
  });

  it("persists deferral and reports a secret-free blocked result", async () => {
    mocks.marketAdvance.mockRejectedValueOnce(
      new Error("cashuB-secret-must-not-escape"),
    );
    mocks.scoreAdvance.mockResolvedValueOnce({
      kind: "credited",
      row: row("score-1", { kind: "participation-score" }),
    });

    const result = await reconcileGuiOutgoingPayments({
      marketFundingRemote: {} as never,
    });

    expect(mocks.defer).toHaveBeenCalledWith({
      walletId: "aa".repeat(32),
      deliveryId: "market-1",
    });
    expect(result.blocked).toEqual([
      {
        deliveryId: "market-1",
        error: "Outgoing payment recovery is temporarily blocked",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("cashuB-secret");
  });
});

function row(deliveryId: string, adapter: object) {
  return {
    walletId: "aa".repeat(32),
    deliveryId,
    operationId: `operation-${deliveryId}`,
    adapter,
    revision: 1,
    active: 1,
    nextAttemptAtMs: 0,
    attemptCount: 0,
    lastError: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    delivery: { kind: "prepared" },
  };
}
