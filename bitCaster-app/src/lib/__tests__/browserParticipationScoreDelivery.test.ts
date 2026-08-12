import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  decodeDurableRecipientDeliveryStatus,
  deriveDurableRecipientTupleFingerprint,
} from "@bitcaster/client-sdk/durableRecipientDelivery";
import { createParticipationScoreDeliveryMetadata } from "@bitcaster/client-sdk/participationScoreDelivery";
import {
  executeBrowserParticipationScoreDelivery,
  reconcileBrowserParticipationScoreDelivery,
} from "../browserParticipationScoreDelivery";

const acknowledgeBrowserDurableOutgoingCashuRecipient = vi.fn();
const executeBrowserDurableOutgoingCashuTransfer = vi.fn();
const readBrowserDurableOutgoingCashuTransfer = vi.fn();
const recoverBrowserDurableOutgoingCashuTransfer = vi.fn();
const captureBrowserMintPersistenceContext = vi.fn();
const getWalletForUnit = vi.fn();
const restoreExactMintOutputs = vi.fn();
const getBoundedCanonicalSatProofs = vi.fn();
const getDurableCashuDeliveryStatus = vi.fn();
const submitDurableCashuDelivery = vi.fn();

vi.mock("@/lib/browserDurableOutgoingCashuTransfer", () => ({
  acknowledgeBrowserDurableOutgoingCashuRecipient: (...args: unknown[]) =>
    acknowledgeBrowserDurableOutgoingCashuRecipient(...args),
  executeBrowserDurableOutgoingCashuTransfer: (...args: unknown[]) =>
    executeBrowserDurableOutgoingCashuTransfer(...args),
  readBrowserDurableOutgoingCashuTransfer: (...args: unknown[]) =>
    readBrowserDurableOutgoingCashuTransfer(...args),
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
  getBoundedCanonicalSatProofs: (...args: unknown[]) => getBoundedCanonicalSatProofs(...args),
}));

const ACTIVE_KEYSET_ID = `01${"11".repeat(32)}`;
const OLD_KEYSET_ID = `01${"22".repeat(32)}`;

vi.mock("@/stores/wallet", () => ({
  useWalletStore: {
    getState: () => ({
      mints: [
        {
          url: "https://mint.example",
          keysets: [
            { id: ACTIVE_KEYSET_ID, unit: "sat" },
            { id: OLD_KEYSET_ID, unit: "sat" },
            { id: "00legacy", unit: "sat" },
          ],
        },
      ],
    }),
  },
}));

vi.mock("@/lib/markets", () => ({
  getDurableCashuDeliveryStatus: (...args: unknown[]) => getDurableCashuDeliveryStatus(...args),
  submitDurableCashuDelivery: (...args: unknown[]) => submitDurableCashuDelivery(...args),
}));

const input = {
  deliveryId: "3ab0f6ef-00f6-4ca3-bd69-1140528a0e83",
  accountSubject: "subject-1",
  mintUrl: "https://mint.example",
  requestedAmount: "21",
};
const TOKEN = "cashuBabc123";
const TOKEN_SHA256 = bytesToHex(sha256(new TextEncoder().encode(TOKEN)));

describe("browser Participation Score delivery", () => {
  beforeEach(() => {
    acknowledgeBrowserDurableOutgoingCashuRecipient.mockReset();
    acknowledgeBrowserDurableOutgoingCashuRecipient.mockImplementation(
      async ({ transfer }) => transfer,
    );
    executeBrowserDurableOutgoingCashuTransfer.mockReset();
    readBrowserDurableOutgoingCashuTransfer.mockReset();
    recoverBrowserDurableOutgoingCashuTransfer.mockReset();
    captureBrowserMintPersistenceContext.mockReset();
    getWalletForUnit.mockReset();
    restoreExactMintOutputs.mockReset();
    getBoundedCanonicalSatProofs.mockReset();
    getDurableCashuDeliveryStatus.mockReset();
    submitDurableCashuDelivery.mockReset();
  });

  it("recovers a lost POST response from status with the byte-identical stored token", async () => {
    const received = status("received");
    const readStatus = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(received);
    const submit = vi.fn().mockRejectedValue(new Error("network interrupted"));

    const result = await reconcileBrowserParticipationScoreDelivery({
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

  it("reads authoritative status before resubmitting an existing transfer", async () => {
    const received = status("received");
    const submit = vi.fn();
    const result = await reconcileBrowserParticipationScoreDelivery({
      transfer: transfer(),
      metadata: input,
      readStatus: vi.fn().mockResolvedValue(received),
      submit,
      context: context(),
    });

    expect(result.progress).toBe("received");
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses conflicting same-id status authority", async () => {
    await expect(
      reconcileBrowserParticipationScoreDelivery({
        transfer: transfer(),
        metadata: input,
        readStatus: vi.fn().mockResolvedValue(status("credited", "22")),
        submit: vi.fn(),
        context: context(),
      }),
    ).rejects.toThrow(/conflicts/);
  });

  it("persists an exact sat plan through the shared durable outgoing coordinator", async () => {
    captureBrowserMintPersistenceContext.mockReturnValue({
      activeMintUrl: input.mintUrl,
      seed: new Uint8Array(64),
      requireCapturedProfile: vi.fn(),
    });
    readBrowserDurableOutgoingCashuTransfer.mockResolvedValue(null);
    getWalletForUnit.mockResolvedValue({ getKeyset: () => ({ id: ACTIVE_KEYSET_ID }) });
    getBoundedCanonicalSatProofs.mockResolvedValue([{ amount: input.requestedAmount }]);
    executeBrowserDurableOutgoingCashuTransfer.mockResolvedValue(transfer());
    getDurableCashuDeliveryStatus.mockResolvedValue(status("credited"));

    const result = await executeBrowserParticipationScoreDelivery(input);

    expect(result.progress).toBe("credited");
    expect(executeBrowserDurableOutgoingCashuTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        preflightFundedAsset: expect.any(Function),
        transfer: expect.objectContaining({
          transferId: input.deliveryId,
          unit: "sat",
          requestedAmount: input.requestedAmount,
        }),
      }),
    );
    expect(recoverBrowserDurableOutgoingCashuTransfer).not.toHaveBeenCalled();
  });

  it("reloads an acknowledged received transfer to credited without mint recovery", async () => {
    captureBrowserMintPersistenceContext.mockReturnValue({
      activeMintUrl: input.mintUrl,
      seed: new Uint8Array(64),
      requireCapturedProfile: vi.fn(),
    });
    readBrowserDurableOutgoingCashuTransfer.mockResolvedValue(receivedTransfer());
    getDurableCashuDeliveryStatus
      .mockResolvedValueOnce(status("received"))
      .mockResolvedValueOnce(status("credited"));

    const received = await executeBrowserParticipationScoreDelivery(input);
    const credited = await executeBrowserParticipationScoreDelivery(input);

    expect(received.progress).toBe("received");
    expect(credited.progress).toBe("credited");
    expect(getWalletForUnit).not.toHaveBeenCalled();
    expect(recoverBrowserDurableOutgoingCashuTransfer).not.toHaveBeenCalled();
    expect(getBoundedCanonicalSatProofs).not.toHaveBeenCalled();
  });
});

function transfer() {
  const metadata = createParticipationScoreDeliveryMetadata(input);
  return {
    transferId: input.deliveryId,
    mintUrl: input.mintUrl,
    unit: "sat",
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

function receivedTransfer() {
  return {
    ...(transfer() as object),
    deliveryState: "recipient-acknowledged",
    recipientReceipt: {},
  } as never;
}

function status(
  state: "pending" | "received" | "credited",
  requestedAmount = input.requestedAmount,
) {
  const metadata = createParticipationScoreDeliveryMetadata({ ...input, requestedAmount });
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
            creditedAmount: requestedAmount,
            receiveFee: "1",
            creditVerification: "exact-amount",
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
