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
const getBoundedCanonicalRegularProofs = vi.fn();
const getDurableCashuDeliveryStatus = vi.fn();
const submitDurableCashuDelivery = vi.fn();
const prepareBrowserDeterministicOutgoingCashuSend = vi.fn();
const recoverBrowserFundedAsset = vi.fn();

vi.mock("@/lib/browserDeterministicOutgoingCashu", () => ({
  prepareBrowserDeterministicOutgoingCashuSend: (...args: unknown[]) =>
    prepareBrowserDeterministicOutgoingCashuSend(...args),
  restoreBrowserDeterministicOutgoingCashuOutputs: (...args: unknown[]) =>
    restoreExactMintOutputs(...args),
}));

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
  getBoundedCanonicalRegularProofs: (...args: unknown[]) =>
    getBoundedCanonicalRegularProofs(...args),
}));

vi.mock("../browserFundedAssetRecovery", () => ({
  recoverBrowserFundedAsset: (...args: unknown[]) => recoverBrowserFundedAsset(...args),
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
            { id: ACTIVE_KEYSET_ID, unit: "msat" },
            { id: OLD_KEYSET_ID, unit: "msat" },
            { id: "00legacy", unit: "msat" },
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
  requestedAmount: "21000",
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
    getBoundedCanonicalRegularProofs.mockReset();
    getDurableCashuDeliveryStatus.mockReset();
    submitDurableCashuDelivery.mockReset();
    prepareBrowserDeterministicOutgoingCashuSend.mockReset();
    recoverBrowserFundedAsset.mockReset();
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
        readStatus: vi.fn().mockResolvedValue(status("credited", "22000")),
        submit: vi.fn(),
        context: context(),
      }),
    ).rejects.toThrow(/conflicts/);
  });

  it("persists an exact msat plan through the shared durable outgoing coordinator", async () => {
    captureBrowserMintPersistenceContext.mockReturnValue({
      activeMintUrl: input.mintUrl,
      scopeId: "test-scope",
      seed: new Uint8Array(64),
      requireCapturedProfile: vi.fn(),
    });
    readBrowserDurableOutgoingCashuTransfer.mockResolvedValue(null);
    getWalletForUnit.mockResolvedValue({ getKeyset: () => ({ id: ACTIVE_KEYSET_ID }) });
    getBoundedCanonicalRegularProofs.mockResolvedValue([{ amount: input.requestedAmount }]);
    recoverBrowserFundedAsset.mockImplementation(async (recoveryInput) => {
      await expect(recoveryInput.loadPlan()).resolves.toEqual({ kind: "ready" });
      return { kind: "ready", plan: { kind: "ready" } };
    });
    executeBrowserDurableOutgoingCashuTransfer.mockResolvedValue(transfer());
    getDurableCashuDeliveryStatus.mockResolvedValue(status("credited"));

    const result = await executeBrowserParticipationScoreDelivery(input);

    expect(result.progress).toBe("credited");
    expect(getWalletForUnit).toHaveBeenCalledWith(input.mintUrl, "msat");
    await executeBrowserDurableOutgoingCashuTransfer.mock.calls[0][0].prepareWalletSendOperation();
    expect(getBoundedCanonicalRegularProofs).toHaveBeenCalledWith(input.mintUrl, {
      scopeId: "test-scope",
      unit: "msat",
    });
    expect(prepareBrowserDeterministicOutgoingCashuSend).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 21_000, unit: "msat" }),
    );
    expect(executeBrowserDurableOutgoingCashuTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        preflightFundedAsset: expect.any(Function),
        transfer: expect.objectContaining({
          transferId: input.deliveryId,
          unit: "msat",
          requestedAmount: input.requestedAmount,
        }),
      }),
    );
    await executeBrowserDurableOutgoingCashuTransfer.mock.calls[0][0].preflightFundedAsset();
    expect(recoverBrowserFundedAsset).toHaveBeenCalledOnce();
    expect(recoverBrowserDurableOutgoingCashuTransfer).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "exact ordinary-msat absence",
      recovery: { kind: "unavailable" as const },
      proofs: [] as Array<{ amount: string }>,
      loadPlan: true,
      expectedErrorName: "BrowserParticipationScoreInsufficientBalanceError",
      expectedStatus: "insufficient",
      expectedBalanceMsat: 0,
    },
    {
      name: "persistent recovery with unknown balance",
      recovery: { kind: "persistent-error" as const },
      loadPlan: false,
      expectedErrorName: "BrowserParticipationScoreAssetUnavailableError",
      expectedStatus: "unavailable",
      expectedBalanceMsat: null,
    },
    {
      name: "persistent recovery after a successful local balance read",
      recovery: { kind: "persistent-error" as const },
      proofs: [{ amount: "500" }],
      loadPlan: true,
      expectedErrorName: "BrowserParticipationScoreAssetUnavailableError",
      expectedStatus: "unavailable",
      expectedBalanceMsat: 500,
    },
  ])("maps $name before any Score send or recipient POST", async (scenario) => {
    configureScoreRecoveryFixture(scenario);

    await expect(executeBrowserParticipationScoreDelivery(input)).rejects.toMatchObject({
      name: scenario.expectedErrorName,
      recoveryStatus: scenario.expectedStatus,
      balanceMsat: scenario.expectedBalanceMsat,
    });
    expect(prepareBrowserDeterministicOutgoingCashuSend).not.toHaveBeenCalled();
    expect(submitDurableCashuDelivery).not.toHaveBeenCalled();
  });

  it("revalidates the captured profile before presenting unavailable recovery", async () => {
    const requireCapturedProfile = vi.fn();
    requireCapturedProfile
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("browser funded recovery profile is stale");
      });
    configureScoreRecoveryFixture({
      recovery: { kind: "persistent-error" },
      loadPlan: false,
      requireCapturedProfile,
    });

    await expect(executeBrowserParticipationScoreDelivery(input)).rejects.toThrow(
      "browser funded recovery profile is stale",
    );
    expect(prepareBrowserDeterministicOutgoingCashuSend).not.toHaveBeenCalled();
    expect(submitDurableCashuDelivery).not.toHaveBeenCalled();
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
    expect(getBoundedCanonicalRegularProofs).not.toHaveBeenCalled();
  });
});

function configureScoreRecoveryFixture(fixture: {
  readonly recovery: { readonly kind: "unavailable" | "persistent-error" };
  readonly proofs?: ReadonlyArray<{ readonly amount: string }>;
  readonly loadPlan: boolean;
  readonly requireCapturedProfile?: ReturnType<typeof vi.fn>;
}): void {
  captureBrowserMintPersistenceContext.mockReturnValue({
    activeMintUrl: input.mintUrl,
    database: {},
    scopeId: "test-scope",
    seed: new Uint8Array(64),
    mnemonic: "test mnemonic",
    requireCapturedProfile: fixture.requireCapturedProfile ?? vi.fn(),
  });
  readBrowserDurableOutgoingCashuTransfer.mockResolvedValue(null);
  getWalletForUnit.mockResolvedValue({ getKeyset: () => ({ id: ACTIVE_KEYSET_ID }) });
  if (fixture.proofs !== undefined) {
    getBoundedCanonicalRegularProofs.mockResolvedValue(fixture.proofs);
  }
  recoverBrowserFundedAsset.mockImplementation(async (recoveryInput) => {
    expect(recoveryInput.asset).toMatchObject({ mintUrl: input.mintUrl, unit: "msat" });
    expect(recoveryInput.asset.assetIdentity).toBe("cashu:ordinary");
    expect(recoveryInput.requiredAmount).toBe(21_000n);
    if (fixture.loadPlan) {
      await expect(recoveryInput.loadPlan()).resolves.toEqual({ kind: "insufficient" });
    }
    return fixture.recovery;
  });
  executeBrowserDurableOutgoingCashuTransfer.mockImplementation(async (transferInput) => {
    await transferInput.preflightFundedAsset();
    await transferInput.prepareWalletSendOperation();
    return transfer();
  });
}

function transfer() {
  const metadata = createParticipationScoreDeliveryMetadata(input);
  return {
    transferId: input.deliveryId,
    mintUrl: input.mintUrl,
    unit: "msat",
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
