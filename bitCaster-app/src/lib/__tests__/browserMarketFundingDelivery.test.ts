import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  decodeDurableRecipientDeliveryStatus,
  deriveDurableRecipientTupleFingerprint,
} from "@bitcaster/client-sdk/durableRecipientDelivery";
import { createMarketFundingDeliveryMetadata } from "@bitcaster/client-sdk/marketFundingDelivery";
import {
  BrowserMarketFundingInsufficientBalanceError,
  executeBrowserMarketFundingDelivery,
  reconcileBrowserMarketFundingDelivery,
} from "../browserMarketFundingDelivery";

const acknowledgeBrowserDurableOutgoingCashuRecipient = vi.fn();
const executeBrowserDurableOutgoingCashuTransfer = vi.fn();
const findBrowserDurableOutgoingCashuTransferByRecipientBinding = vi.fn();
const recoverBrowserDurableOutgoingCashuTransfer = vi.fn();
const captureBrowserMintPersistenceContext = vi.fn();
const getWalletForUnit = vi.fn();
const restoreExactMintOutputs = vi.fn();
const getBoundedMarketFundingProofs = vi.fn();
const getDurableCashuDeliveryStatus = vi.fn();
const submitDurableCashuDelivery = vi.fn();

vi.mock("@/lib/browserDurableOutgoingCashuTransfer", () => ({
  acknowledgeBrowserDurableOutgoingCashuRecipient: (...args: unknown[]) =>
    acknowledgeBrowserDurableOutgoingCashuRecipient(...args),
  executeBrowserDurableOutgoingCashuTransfer: (...args: unknown[]) =>
    executeBrowserDurableOutgoingCashuTransfer(...args),
  findBrowserDurableOutgoingCashuTransferByRecipientBinding: (...args: unknown[]) =>
    findBrowserDurableOutgoingCashuTransferByRecipientBinding(...args),
  recoverBrowserDurableOutgoingCashuTransfer: (...args: unknown[]) =>
    recoverBrowserDurableOutgoingCashuTransfer(...args),
}));

vi.mock("@/lib/cashu", () => ({
  captureBrowserMintPersistenceContext: (...args: unknown[]) =>
    captureBrowserMintPersistenceContext(...args),
  getWalletForUnit: (...args: unknown[]) => getWalletForUnit(...args),
  restoreExactMintOutputs: (...args: unknown[]) => restoreExactMintOutputs(...args),
}));

vi.mock("@/stores/proof-db", () => ({
  getBoundedMarketFundingProofs: (...args: unknown[]) => getBoundedMarketFundingProofs(...args),
}));

vi.mock("@/lib/markets", () => ({
  getDurableCashuDeliveryStatus: (...args: unknown[]) => getDurableCashuDeliveryStatus(...args),
  submitDurableCashuDelivery: (...args: unknown[]) => submitDurableCashuDelivery(...args),
}));

const input = {
  deliveryId: "3ab0f6ef-00f6-4ca3-bd69-1140528a0e83",
  accountSubject: "subject-1",
  conditionId: "a".repeat(64),
  mintUrl: "https://mint.example",
  unit: "msat" as const,
  requestedAmount: "10000",
  divisibility: 10_000,
};
const TOKEN = "cashuBabc123";
const TOKEN_SHA256 = bytesToHex(sha256(new TextEncoder().encode(TOKEN)));

describe("browser market funding delivery", () => {
  beforeEach(() => {
    acknowledgeBrowserDurableOutgoingCashuRecipient.mockReset();
    acknowledgeBrowserDurableOutgoingCashuRecipient.mockImplementation(
      async ({ transfer }) => transfer,
    );
    executeBrowserDurableOutgoingCashuTransfer.mockReset();
    findBrowserDurableOutgoingCashuTransferByRecipientBinding.mockReset();
    recoverBrowserDurableOutgoingCashuTransfer.mockReset();
    captureBrowserMintPersistenceContext.mockReset();
    getWalletForUnit.mockReset();
    restoreExactMintOutputs.mockReset();
    getBoundedMarketFundingProofs.mockReset();
    getDurableCashuDeliveryStatus.mockReset();
    submitDurableCashuDelivery.mockReset();
  });

  it("recovers a lost POST response from status without a new token plan", async () => {
    const received = status("received");
    const readStatus = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(received);
    const submit = vi.fn().mockRejectedValue(new Error("network interrupted"));

    const result = await reconcileBrowserMarketFundingDelivery({
      transfer: transfer(),
      metadata: input,
      readStatus,
      submit,
      context: context(),
    });

    expect(result.progress).toBe("received");
    expect(readStatus).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]?.[0].token).toBe(TOKEN);
    expect(acknowledgeBrowserDurableOutgoingCashuRecipient).toHaveBeenCalledOnce();
  });

  it("resubmits the exact stored token when the durable engine row is still pending", async () => {
    const pending = status("pending");
    const received = status("received");
    const readStatus = vi.fn().mockResolvedValue(pending);
    const submit = vi.fn().mockResolvedValue(received);

    const result = await reconcileBrowserMarketFundingDelivery({
      transfer: transfer(),
      metadata: input,
      readStatus,
      submit,
      context: context(),
    });

    expect(result.progress).toBe("received");
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ token: TOKEN }));
    expect(acknowledgeBrowserDurableOutgoingCashuRecipient).toHaveBeenCalledOnce();
  });

  it("keeps received distinct from credited and refuses a conflicting status", async () => {
    const receivedResult = await reconcileBrowserMarketFundingDelivery({
      transfer: transfer(),
      metadata: input,
      readStatus: vi.fn().mockResolvedValue(status("received")),
      submit: vi.fn(),
      context: context(),
    });
    expect(receivedResult.progress).toBe("received");

    await expect(
      reconcileBrowserMarketFundingDelivery({
        transfer: transfer(),
        metadata: input,
        readStatus: vi.fn().mockResolvedValue(status("credited", "b".repeat(64))),
        submit: vi.fn(),
        context: context(),
      }),
    ).rejects.toThrow(/conflicts/);
  });

  it("reloads a prepared transfer through exact recovery before it reads delivery status", async () => {
    const prepared = { ...(transfer() as object), token: null } as never;
    captureBrowserMintPersistenceContext.mockReturnValue({
      activeMintUrl: input.mintUrl,
      seed: new Uint8Array(64),
      requireCapturedProfile: vi.fn(),
    });
    findBrowserDurableOutgoingCashuTransferByRecipientBinding.mockResolvedValue(prepared);
    getWalletForUnit.mockResolvedValue({});
    recoverBrowserDurableOutgoingCashuTransfer.mockResolvedValue(transfer());
    getDurableCashuDeliveryStatus.mockResolvedValue(status("received"));

    const result = await executeBrowserMarketFundingDelivery({
      accountSubject: input.accountSubject,
      conditionId: input.conditionId,
      mintUrl: input.mintUrl,
      unit: input.unit,
      requestedAmount: input.requestedAmount,
      divisibility: input.divisibility,
      availableAmount: 0,
    });

    expect(result.progress).toBe("received");
    expect(recoverBrowserDurableOutgoingCashuTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ transferId: input.deliveryId }),
    );
    expect(executeBrowserDurableOutgoingCashuTransfer).not.toHaveBeenCalled();
    expect(getBoundedMarketFundingProofs).not.toHaveBeenCalled();
  });

  it("rejects insufficient balance only when no persisted transfer can resume", async () => {
    captureBrowserMintPersistenceContext.mockReturnValue({
      activeMintUrl: input.mintUrl,
      seed: new Uint8Array(64),
      requireCapturedProfile: vi.fn(),
    });
    findBrowserDurableOutgoingCashuTransferByRecipientBinding.mockResolvedValue(null);

    await expect(
      executeBrowserMarketFundingDelivery({
        accountSubject: input.accountSubject,
        conditionId: input.conditionId,
        mintUrl: input.mintUrl,
        unit: input.unit,
        requestedAmount: input.requestedAmount,
        divisibility: input.divisibility,
        availableAmount: 0,
      }),
    ).rejects.toBeInstanceOf(BrowserMarketFundingInsufficientBalanceError);

    expect(getWalletForUnit).not.toHaveBeenCalled();
    expect(getBoundedMarketFundingProofs).not.toHaveBeenCalled();
  });

  it("reconciles an under-lock reused transfer with its persisted delivery id", async () => {
    captureBrowserMintPersistenceContext.mockReturnValue({
      activeMintUrl: input.mintUrl,
      seed: new Uint8Array(64),
      requireCapturedProfile: vi.fn(),
    });
    findBrowserDurableOutgoingCashuTransferByRecipientBinding.mockResolvedValue(null);
    getWalletForUnit.mockResolvedValue({ getKeyset: () => ({ id: "keyset-1" }) });
    getBoundedMarketFundingProofs.mockResolvedValue([{ amount: input.requestedAmount }]);
    executeBrowserDurableOutgoingCashuTransfer.mockResolvedValue(transfer());
    getDurableCashuDeliveryStatus.mockResolvedValue(status("received"));

    const result = await executeBrowserMarketFundingDelivery({
      accountSubject: input.accountSubject,
      conditionId: input.conditionId,
      mintUrl: input.mintUrl,
      unit: input.unit,
      requestedAmount: input.requestedAmount,
      divisibility: input.divisibility,
      availableAmount: Number(input.requestedAmount),
    });

    expect(result.progress).toBe("received");
    expect(getDurableCashuDeliveryStatus).toHaveBeenCalledWith(input.deliveryId);
    expect(executeBrowserDurableOutgoingCashuTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ reuseRecipientBinding: true }),
    );
  });
});

function transfer() {
  const metadata = createMarketFundingDeliveryMetadata(input);
  return {
    transferId: input.deliveryId,
    mintUrl: input.mintUrl,
    unit: input.unit,
    requestedAmount: input.requestedAmount,
    deliveryIntent: {
      policy: "durable-recipient-ack",
      expectedSubject: input.accountSubject,
      opaqueProductBinding: metadata.productBindingSha256,
      tokenBytesLimit: 61_440,
      tokenProofLimit: 512,
    },
    token: {
      encodedToken: TOKEN,
      sha256: TOKEN_SHA256,
      encodedLength: TOKEN.length,
    },
  } as never;
}

function status(state: "pending" | "received" | "credited", productBindingSha256?: string) {
  const metadata = createMarketFundingDeliveryMetadata({
    ...input,
    ...(productBindingSha256 === undefined ? {} : { conditionId: productBindingSha256 }),
  });
  const delivery = {
    ...metadata,
    tokenSha256: TOKEN_SHA256,
    tokenEncodedLength: TOKEN.length,
  };
  return decodeDurableRecipientDeliveryStatus({
    delivery,
    tupleFingerprint: deriveDurableRecipientTupleFingerprint(delivery),
    state,
    ...(state === "pending"
      ? { result: null }
      : {
          result: {
            creditedAmount: input.requestedAmount,
            receiveFee: "0",
            creditVerification: "net-of-receive-fee",
            receiveOperationId: "receive-1",
            receivedAt: "2026-08-11T00:00:00.000Z",
            ...(state === "credited"
              ? { businessEventId: "event-1", businessEventAt: "2026-08-11T00:01:00.000Z" }
              : {}),
          },
        }),
  });
}

function context() {
  return {
    seed: new Uint8Array(64),
    requireCapturedProfile: vi.fn(),
  };
}
