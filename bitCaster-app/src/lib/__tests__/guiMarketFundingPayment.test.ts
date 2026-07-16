import { Amount } from "@cashu/cashu-ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { marketFundingRecipientProductBinding } from "@bitcaster/client-sdk/durableRecipientProductBinding";
import {
  createGuiMarketFundingTransport,
  executeGuiLocalWalletPayment,
  type GuiEcashDepositProductRequest,
  type GuiEcashDepositRemote,
} from "../guiMarketFundingPayment";
import {
  assertGuiOutgoingRecipientAdapterMatchesDelivery,
} from "@/stores/gui-outgoing-recipient-adapter";

const mocks = vi.hoisted(() => ({
  advance: vi.fn(),
  getDelivery: vi.fn(),
  selectProofs: vi.fn(),
  send: vi.fn(),
  ensureWallet: vi.fn(),
}));

vi.mock("@bitcaster/client-sdk/durableRecipientSubmission", () => ({
  readDurableRecipientSubmissionAuthority: (value: unknown) => value,
}));

vi.mock("@/stores/gui-custody-authority", () => ({
  withGuiCustodyProfileLockForWallet: async (
    _walletId: string,
    callback: (context: unknown, lock: unknown) => unknown,
  ) => callback({}, {}),
}));

vi.mock("@/stores/gui-outgoing-recipient-coordinator", () => ({
  advanceGuiOutgoingRecipientDeliveryOnce: mocks.advance,
  getGuiOutgoingRecipientDelivery: mocks.getDelivery,
  getNextGuiOutgoingRecipientAttemptAt: vi.fn(),
  listDueGuiOutgoingRecipientDeliveries: vi.fn(),
}));

vi.mock("@/stores/gui-ordinary-wallet-operation", () => ({
  sendGuiCashuToDurableRecipient: mocks.send,
}));

vi.mock("@/stores/proof-db", () => ({
  currentGuiWalletId: () => "aa".repeat(32),
  getBoundedUnitProofsForAmountUnderLock: mocks.selectProofs,
}));

vi.mock("@/stores/wallet", () => ({
  useWalletStore: {
    getState: () => ({ ensureImplicitWallet: mocks.ensureWallet }),
  },
}));

const DEPOSIT_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const PRODUCT: GuiEcashDepositProductRequest = {
  conditionId: "deadbeef",
  mintUrl: "https://mint.example",
  amountSubunits: 10_000,
  unit: "msat",
  divisibility: 10_000,
  fundAmm: true,
  creatorPubkey: "ab".repeat(32),
  fundingIdentity: "account-primary",
};

describe("GUI market funding durable payment adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureWallet.mockResolvedValue(undefined);
    mocks.selectProofs.mockResolvedValue([
      {
        id: "0011223344556677",
        amount: Amount.from(10_000),
        secret: "11".repeat(32),
        C: `02${"22".repeat(32)}`,
      },
    ]);
    mocks.send.mockResolvedValue({ operationId: "wallet-send-market" });
    mocks.getDelivery.mockResolvedValue(deliveryRow());
    mocks.advance.mockResolvedValue({
      kind: "credited",
      row: deliveryRow(),
    });
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(DEPOSIT_ID);
  });

  it("persists the exact product adapter beside the generic recipient tuple", async () => {
    await expect(
      executeGuiLocalWalletPayment({
        mintUrl: PRODUCT.mintUrl,
        amountSubunits: PRODUCT.amountSubunits,
        baseAsset: "Bitcoin",
        unit: PRODUCT.unit,
        request: {
          conditionId: PRODUCT.conditionId,
          divisibility: PRODUCT.divisibility,
          fundAmm: PRODUCT.fundAmm,
          creatorPubkey: PRODUCT.creatorPubkey,
          fundingIdentity: PRODUCT.fundingIdentity,
        },
        remote: remote(),
      }),
    ).resolves.toEqual({ status: "completed", depositId: DEPOSIT_ID });

    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedWalletId: "aa".repeat(32),
        amount: 10_000,
        mintUrl: PRODUCT.mintUrl,
        unit: "msat",
        recipient: {
          deliveryId: DEPOSIT_ID,
          accountSubject: PRODUCT.fundingIdentity,
          recipientKind: "matching-engine",
          purpose: "market-funding",
          destinationId: PRODUCT.conditionId,
          productBinding: marketFundingRecipientProductBinding(PRODUCT),
          mintUrl: PRODUCT.mintUrl,
          unit: "msat",
          requestedAmount: "10000",
          creditPolicy: { kind: "net-of-receive-fee" },
        },
        adapter: {
          kind: "market-funding",
          divisibility: 10_000,
          fundAmm: true,
          creatorPubkey: PRODUCT.creatorPubkey,
        },
      }),
    );
  });

  it("submits only the exact persisted token and product request", async () => {
    const target = remote();
    const transport = createGuiMarketFundingTransport(target, PRODUCT);
    const outcome = await transport.submitExact({
      request: deliveryRequest(),
      encodedToken: "cashuB-exact-token",
    } as never);

    expect(target.submit).toHaveBeenCalledWith({
      depositId: DEPOSIT_ID,
      token: "cashuB-exact-token",
      request: PRODUCT,
    });
    expect(outcome.kind).toBe("evidence");
  });

  it("fails closed when product metadata conflicts with the generic tuple", async () => {
    const transport = createGuiMarketFundingTransport(remote(), PRODUCT);
    await expect(
      transport.readStatus({
        ...deliveryRequest(),
        destinationId: "feedface",
      }),
    ).rejects.toThrow("product binding conflicts");
  });

  it("rejects adapter mutation even when every generic route field is valid", () => {
    expect(() =>
      assertGuiOutgoingRecipientAdapterMatchesDelivery(
        {
          kind: "market-funding",
          divisibility: PRODUCT.divisibility,
          fundAmm: false,
          creatorPubkey: null,
        },
        deliveryRequest(),
      ),
    ).toThrow("adapter conflicts with delivery");
  });
});

function remote(): GuiEcashDepositRemote & {
  submit: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
} {
  return {
    currentFundingIdentity: () => PRODUCT.fundingIdentity,
    submit: vi.fn().mockResolvedValue({
      depositId: DEPOSIT_ID,
      state: "credited",
    }),
    getStatus: vi.fn().mockResolvedValue(statusFixture()),
  };
}

function deliveryRequest() {
  return {
    schemaVersion: 1 as const,
    deliveryId: DEPOSIT_ID,
    accountSubject: PRODUCT.fundingIdentity,
    recipientKind: "matching-engine",
    purpose: "market-funding",
    destinationId: PRODUCT.conditionId,
    productBinding: marketFundingRecipientProductBinding(PRODUCT),
    mintUrl: PRODUCT.mintUrl,
    unit: PRODUCT.unit,
    requestedAmount: String(PRODUCT.amountSubunits),
    creditPolicy: { kind: "net-of-receive-fee" as const },
    tokenDigest: "cd".repeat(32),
    encodedTokenBytes: 123,
  };
}

function deliveryRow() {
  return {
    walletId: "aa".repeat(32),
    deliveryId: DEPOSIT_ID,
    operationId: "wallet-send-market",
    adapter: {
      kind: "market-funding" as const,
      divisibility: PRODUCT.divisibility,
      fundAmm: PRODUCT.fundAmm,
      creatorPubkey: PRODUCT.creatorPubkey,
    },
    revision: 1,
    active: 1 as const,
    nextAttemptAtMs: 0,
    attemptCount: 0,
    lastError: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    delivery: {
      kind: "active" as const,
      record: {
        schemaVersion: 1 as const,
        delivery: {
          schemaVersion: 1 as const,
          request: deliveryRequest(),
          state: { kind: "pending" as const },
        },
        exactPayload: {
          schemaVersion: 1 as const,
          preparation: {
            schemaVersion: 1 as const,
            walletOperationId: "wallet-send-market",
            policy: {
              kind: "durable-recipient-ack" as const,
              recipient: {
                deliveryId: DEPOSIT_ID,
                accountSubject: PRODUCT.fundingIdentity,
                recipientKind: "matching-engine",
                purpose: "market-funding",
                destinationId: PRODUCT.conditionId,
                productBinding: marketFundingRecipientProductBinding(PRODUCT),
                mintUrl: PRODUCT.mintUrl,
                unit: PRODUCT.unit,
                requestedAmount: String(PRODUCT.amountSubunits),
                creditPolicy: { kind: "net-of-receive-fee" as const },
              },
            },
          },
          walletOperationId: "wallet-send-market",
          mintUrl: PRODUCT.mintUrl,
          unit: PRODUCT.unit,
          amount: String(PRODUCT.amountSubunits),
          tokenDigest: "cd".repeat(32),
          encodedTokenBytes: 123,
          payloadHandle: "wallet-send:wallet-send-market",
        },
      },
    },
  };
}

function statusFixture() {
  return {
    schemaVersion: 1 as const,
    depositId: DEPOSIT_ID,
    conditionId: PRODUCT.conditionId,
    accountSubject: PRODUCT.fundingIdentity,
    recipientKind: "matching-engine" as const,
    purpose: "market-funding" as const,
    destinationId: PRODUCT.conditionId,
    productBinding: marketFundingRecipientProductBinding(PRODUCT),
    mintUrl: PRODUCT.mintUrl,
    unit: PRODUCT.unit,
    creditPolicy: "net-of-receive-fee" as const,
    tokenDigest: "cd".repeat(32),
    encodedTokenBytes: 123,
    receiptOperationId: `${PRODUCT.conditionId}/${DEPOSIT_ID}/ecash-receive`,
    receivedAt: "2026-07-16T00:00:00Z",
    state: "credited" as const,
    method: "ecash" as const,
    amountSubunits: PRODUCT.amountSubunits,
    creditedAmountSubunits: 9_998,
    receiveFeeAmountSubunits: 2,
    businessEventId:
      `market-deposit-credit/${PRODUCT.conditionId}/${DEPOSIT_ID}`,
    creditedAt: "2026-07-16T00:00:01Z",
    requestedAt: "2026-07-16T00:00:00Z",
    updatedAt: "2026-07-16T00:00:01Z",
    failureReason: null,
  };
}
