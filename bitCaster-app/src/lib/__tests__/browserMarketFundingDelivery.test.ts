import { beforeEach, describe, expect, it, vi } from "vitest";
import * as deterministicSend from "../browserDeterministicOutgoingCashu";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  decodeDurableRecipientDeliveryStatus,
  deriveDurableRecipientTupleFingerprint,
} from "@bitcaster/client-sdk/durableRecipientDelivery";
import {
  createMarketFundingDeliveryMetadata,
  deriveMarketFundingProductBinding,
} from "@bitcaster/client-sdk/marketFundingDelivery";
import {
  BrowserMarketFundingConsolidationRequiredError,
  BrowserMarketFundingInsufficientBalanceError,
  executeBrowserMarketFundingDelivery,
  readBrowserMarketFundingHeadId,
  reconcileBrowserMarketFundingDelivery,
} from "../browserMarketFundingDelivery";

const acknowledgeBrowserDurableOutgoingCashuRecipient = vi.fn();
const executeBrowserDurableOutgoingCashuTransfer = vi.fn();
const readBrowserDurableOutgoingCashuTransfer = vi.fn();
const recoverBrowserDurableOutgoingCashuTransfer = vi.fn();
const captureBrowserMintPersistenceContext = vi.fn();
const getWalletForUnit = vi.fn();
const restoreExactMintOutputs = vi.fn();
const getBoundedCanonicalRegularProofs = vi.fn();
const findBrowserOutgoingCashuTransferByPredecessor = vi.fn();
const decodeBrowserOutgoingCashuTransferRow = vi.fn();
const getDurableCashuDeliveryStatus = vi.fn();
const submitDurableCashuDelivery = vi.fn();
const recoverBrowserFundedAsset = vi.fn();
const readBrowserMarketFundingHead = vi.fn();

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
  findBrowserOutgoingCashuTransferByPredecessor: (...args: unknown[]) =>
    findBrowserOutgoingCashuTransferByPredecessor(...args),
  decodeBrowserOutgoingCashuTransferRow: (...args: unknown[]) =>
    decodeBrowserOutgoingCashuTransferRow(...args),
  readBrowserMarketFundingHead: (...args: unknown[]) => readBrowserMarketFundingHead(...args),
}));

vi.mock("@/lib/markets", () => ({
  getDurableCashuDeliveryStatus: (...args: unknown[]) => getDurableCashuDeliveryStatus(...args),
  submitDurableCashuDelivery: (...args: unknown[]) => submitDurableCashuDelivery(...args),
}));

vi.mock("@/lib/browserFundedAssetRecovery", () => ({
  recoverBrowserFundedAsset: (...args: unknown[]) => recoverBrowserFundedAsset(...args),
}));

const input = {
  deliveryId: "3ab0f6ef-00f6-4ca3-bd69-1140528a0e83",
  accountSubject: "subject-1",
  conditionId: "a".repeat(64),
  mintUrl: "https://mint.example",
  unit: "msat" as const,
  requestedAmount: "10000",
  divisibility: 1_000,
};
const common = {
  accountSubject: input.accountSubject,
  conditionId: input.conditionId,
  mintUrl: input.mintUrl,
  unit: input.unit,
  divisibility: input.divisibility,
};
const TOKEN = "cashuBabc123";
const TOKEN_SHA256 = bytesToHex(sha256(new TextEncoder().encode(TOKEN)));

function begin(overrides: Partial<{
  expectedPreviousTransferId: string | null;
  newAttemptId: string;
  requestedAmount: string;
}> = {}) {
  return {
    kind: "begin" as const,
    expectedPreviousTransferId: null,
    newAttemptId: input.deliveryId,
    requestedAmount: input.requestedAmount,
    ...overrides,
  };
}

function resume(transferId = input.deliveryId) {
  return { kind: "resume" as const, transferId };
}

describe("browser market funding delivery", () => {
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
    findBrowserOutgoingCashuTransferByPredecessor.mockReset();
    decodeBrowserOutgoingCashuTransferRow.mockReset();
    findBrowserOutgoingCashuTransferByPredecessor.mockResolvedValue(null);
    getDurableCashuDeliveryStatus.mockReset();
    submitDurableCashuDelivery.mockReset();
    recoverBrowserFundedAsset.mockReset();
    readBrowserMarketFundingHead.mockReset();
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

  it("reads the exact captured funding head scope", async () => {
    captureBrowserMintPersistenceContext.mockReturnValue({
      activeMintUrl: input.mintUrl,
      scopeId: "scope-1",
      seed: new Uint8Array(64),
      requireCapturedProfile: vi.fn(),
    });
    readBrowserMarketFundingHead.mockResolvedValue({
      scopeId: "scope-1",
      recipientBinding: deriveMarketFundingProductBinding(common),
      transferId: input.deliveryId,
      revision: 1,
      mintUrl: input.mintUrl,
      unit: input.unit,
      accountSubject: input.accountSubject,
      conditionId: input.conditionId,
      divisibility: input.divisibility,
    });

    await expect(readBrowserMarketFundingHeadId(common)).resolves.toBe(input.deliveryId);
    expect(readBrowserMarketFundingHead).toHaveBeenCalledWith(
      "scope-1",
      expect.any(String),
      undefined,
    );
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
    readBrowserDurableOutgoingCashuTransfer.mockResolvedValue(prepared);
    getWalletForUnit.mockResolvedValue({});
    recoverBrowserDurableOutgoingCashuTransfer.mockResolvedValue(transfer());
    getDurableCashuDeliveryStatus.mockResolvedValue(status("received"));

    const result = await executeBrowserMarketFundingDelivery({
      ...common,
      attempt: resume(),
    });

    expect(result.progress).toBe("received");
    expect(recoverBrowserDurableOutgoingCashuTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ transferId: input.deliveryId }),
    );
    expect(executeBrowserDurableOutgoingCashuTransfer).not.toHaveBeenCalled();
    expect(getBoundedCanonicalRegularProofs).not.toHaveBeenCalled();
  });

  it("reconciles a persisted token without re-entering pre-mint recovery", async () => {
    captureBrowserMintPersistenceContext.mockReturnValue({
      activeMintUrl: input.mintUrl,
      seed: new Uint8Array(64),
      requireCapturedProfile: vi.fn(),
    });
    readBrowserDurableOutgoingCashuTransfer.mockResolvedValue(transfer());
    getDurableCashuDeliveryStatus.mockResolvedValue(status("credited"));

    const result = await executeBrowserMarketFundingDelivery({
      ...common,
      attempt: resume(),
    });

    expect(result.progress).toBe("credited");
    expect(getDurableCashuDeliveryStatus).toHaveBeenCalledWith(input.deliveryId);
    expect(getWalletForUnit).not.toHaveBeenCalled();
    expect(recoverBrowserDurableOutgoingCashuTransfer).not.toHaveBeenCalled();
    expect(executeBrowserDurableOutgoingCashuTransfer).not.toHaveBeenCalled();
  });

  it("resumes the stored amount when a begin proposal has a different amount", async () => {
    const stored = transfer({ requestedAmount: "12000" });
    captureBrowserMintPersistenceContext.mockReturnValue({
      activeMintUrl: input.mintUrl,
      seed: new Uint8Array(64),
      requireCapturedProfile: vi.fn(),
    });
    getWalletForUnit.mockResolvedValue({});
    executeBrowserDurableOutgoingCashuTransfer.mockResolvedValue(stored);
    getDurableCashuDeliveryStatus.mockResolvedValue(
      status("credited", undefined, { ...input, requestedAmount: "12000" }),
    );

    const result = await executeBrowserMarketFundingDelivery({
      ...common,
      attempt: begin({
        newAttemptId: "99999999-9999-4999-8999-999999999999",
        requestedAmount: "13000",
      }),
    });

    expect(result.progress).toBe("credited");
    expect(executeBrowserDurableOutgoingCashuTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        transfer: expect.objectContaining({
          transferId: "99999999-9999-4999-8999-999999999999",
          requestedAmount: "13000",
        }),
      }),
    );
    expect(getDurableCashuDeliveryStatus).toHaveBeenCalledWith(input.deliveryId);
  });

  it("refuses a persisted transfer from a foreign product scope", async () => {
    captureBrowserMintPersistenceContext.mockReturnValue({
      activeMintUrl: input.mintUrl,
      seed: new Uint8Array(64),
      requireCapturedProfile: vi.fn(),
    });
    readBrowserDurableOutgoingCashuTransfer.mockResolvedValue(transfer());

    await expect(
      executeBrowserMarketFundingDelivery({
        ...common,
        accountSubject: "foreign-subject",
        attempt: resume(),
      }),
    ).rejects.toThrow(/conflicts/);
    expect(getDurableCashuDeliveryStatus).not.toHaveBeenCalled();
    expect(executeBrowserDurableOutgoingCashuTransfer).not.toHaveBeenCalled();
  });

  it("does not authorize a successor from a received predecessor", async () => {
    captureBrowserMintPersistenceContext.mockReturnValue({
      activeMintUrl: input.mintUrl,
      seed: new Uint8Array(64),
      requireCapturedProfile: vi.fn(),
    });
    getWalletForUnit.mockResolvedValue({ getKeyset: () => ({ id: "keyset-1" }) });
    getDurableCashuDeliveryStatus.mockResolvedValue(
      status("received", undefined, {
        ...input,
        deliveryId: "11111111-1111-4111-8111-111111111111",
      }),
    );
    executeBrowserDurableOutgoingCashuTransfer.mockImplementation(async (request) => {
      await request.marketFundingAttempt.requireCredited(
        transfer({ transferId: "11111111-1111-4111-8111-111111111111" }),
      );
      return transfer({ transferId: "22222222-2222-4222-8222-222222222222" });
    });

    await expect(
      executeBrowserMarketFundingDelivery({
        ...common,
        attempt: begin({
          expectedPreviousTransferId: "11111111-1111-4111-8111-111111111111",
          newAttemptId: "22222222-2222-4222-8222-222222222222",
        }),
      }),
    ).rejects.toThrow(/not credited/);
    expect(acknowledgeBrowserDurableOutgoingCashuRecipient).not.toHaveBeenCalled();
  });

  it("reconciles an indexed successor before loading the mint wallet", async () => {
    const successor = transfer();
    captureBrowserMintPersistenceContext.mockReturnValue({
      activeMintUrl: input.mintUrl,
      scopeId: "scope-1",
      seed: new Uint8Array(64),
      requireCapturedProfile: vi.fn(),
    });
    findBrowserOutgoingCashuTransferByPredecessor.mockResolvedValue({} as never);
    decodeBrowserOutgoingCashuTransferRow.mockReturnValue(successor);
    getWalletForUnit.mockRejectedValue(new Error("mint is unavailable"));
    getDurableCashuDeliveryStatus.mockResolvedValue(status("credited"));

    const result = await executeBrowserMarketFundingDelivery({
      ...common,
      attempt: begin(),
    });

    expect(result.progress).toBe("credited");
    expect(getWalletForUnit).not.toHaveBeenCalled();
    expect(executeBrowserDurableOutgoingCashuTransfer).not.toHaveBeenCalled();
    expect(findBrowserOutgoingCashuTransferByPredecessor).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeId: "scope-1",
        predecessorTransferId: null,
      }),
    );
  });

  it("does not reject from cached available balance when no persisted transfer can resume", async () => {
    captureBrowserMintPersistenceContext.mockReturnValue({
      activeMintUrl: input.mintUrl,
      seed: new Uint8Array(64),
      requireCapturedProfile: vi.fn(),
    });
    getWalletForUnit.mockResolvedValue({ getKeyset: () => ({ id: `01${"11".repeat(32)}` }) });
    executeBrowserDurableOutgoingCashuTransfer.mockResolvedValue(transfer());
    getDurableCashuDeliveryStatus.mockResolvedValue(status("received"));

    await expect(
      executeBrowserMarketFundingDelivery({
        ...common,
        availableAmount: 0,
        attempt: begin(),
      }),
    ).resolves.toMatchObject({ progress: "received" });

    expect(executeBrowserDurableOutgoingCashuTransfer).toHaveBeenCalledOnce();
  });

  it("reconciles an under-lock reused transfer with its persisted delivery id", async () => {
    captureBrowserMintPersistenceContext.mockReturnValue({
      activeMintUrl: input.mintUrl,
      seed: new Uint8Array(64),
      requireCapturedProfile: vi.fn(),
    });
    getWalletForUnit.mockResolvedValue({ getKeyset: () => ({ id: "keyset-1" }) });
    getBoundedCanonicalRegularProofs.mockResolvedValue([{ amount: input.requestedAmount }]);
    executeBrowserDurableOutgoingCashuTransfer.mockResolvedValue(transfer());
    getDurableCashuDeliveryStatus.mockResolvedValue(status("received"));

    const result = await executeBrowserMarketFundingDelivery({
      ...common,
      attempt: begin(),
    });

    expect(result.progress).toBe("received");
    expect(getDurableCashuDeliveryStatus).toHaveBeenCalledWith(input.deliveryId);
    expect(executeBrowserDurableOutgoingCashuTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        marketFundingAttempt: expect.objectContaining({
          expectedPreviousTransferId: null,
        }),
        preflightFundedAsset: expect.any(Function),
      }),
    );
  });

  it("passes the exact ordinary asset through the shared funded preflight", async () => {
    const wallet = { getKeyset: () => ({ id: `01${"11".repeat(32)}` }) };
    captureBrowserMintPersistenceContext.mockReturnValue({
      activeMintUrl: input.mintUrl,
      database: {} as never,
      scopeId: "scope",
      mnemonic: "test mnemonic",
      seed: new Uint8Array(64),
      requireCapturedProfile: vi.fn(),
    });
    getWalletForUnit.mockResolvedValue(wallet);
    getBoundedCanonicalRegularProofs.mockResolvedValue([{ amount: input.requestedAmount }]);
    executeBrowserDurableOutgoingCashuTransfer.mockResolvedValue(transfer());
    getDurableCashuDeliveryStatus.mockResolvedValue(status("received"));
    recoverBrowserFundedAsset.mockResolvedValue({ kind: "ready", plan: { kind: "ready" } });

    await executeBrowserMarketFundingDelivery({ ...common, attempt: begin() });
    const outgoingInput = executeBrowserDurableOutgoingCashuTransfer.mock.calls[0]?.[0] as {
      preflightFundedAsset: () => Promise<void>;
    };
    await outgoingInput.preflightFundedAsset();

    expect(recoverBrowserFundedAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        asset: expect.objectContaining({ mintUrl: input.mintUrl, unit: input.unit }),
        requiredAmount: BigInt(input.requestedAmount),
      }),
    );
  });

  it("maps a final locked candidate shortfall to insufficient balance", async () => {
    const wallet = { getKeyset: () => ({ id: `01${"11".repeat(32)}` }) };
    captureBrowserMintPersistenceContext.mockReturnValue({
      activeMintUrl: input.mintUrl,
      seed: new Uint8Array(64),
      requireCapturedProfile: vi.fn(),
    });
    getWalletForUnit.mockResolvedValue(wallet);
    executeBrowserDurableOutgoingCashuTransfer.mockResolvedValue(transfer());
    getDurableCashuDeliveryStatus.mockResolvedValue(status("received"));
    getBoundedCanonicalRegularProofs.mockResolvedValue([{ amount: "1" }]);

    await executeBrowserMarketFundingDelivery({ ...common, attempt: begin() });
    const outgoingInput = executeBrowserDurableOutgoingCashuTransfer.mock.calls[0]?.[0] as {
      prepareWalletSendOperation: () => Promise<unknown>;
    };
    await expect(outgoingInput.prepareWalletSendOperation()).rejects.toBeInstanceOf(
      BrowserMarketFundingInsufficientBalanceError,
    );
  });

  it("uses cached balance only to classify a final locked candidate shortfall", async () => {
    const wallet = { getKeyset: () => ({ id: `01${"11".repeat(32)}` }) };
    captureBrowserMintPersistenceContext.mockReturnValue({
      activeMintUrl: input.mintUrl,
      seed: new Uint8Array(64),
      requireCapturedProfile: vi.fn(),
    });
    getWalletForUnit.mockResolvedValue(wallet);
    executeBrowserDurableOutgoingCashuTransfer.mockResolvedValue(transfer());
    getDurableCashuDeliveryStatus.mockResolvedValue(status("received"));
    getBoundedCanonicalRegularProofs.mockResolvedValue([{ amount: "1" }]);

    await executeBrowserMarketFundingDelivery({
      ...common,
      availableAmount: Number(input.requestedAmount),
      attempt: begin(),
    });
    const outgoingInput = executeBrowserDurableOutgoingCashuTransfer.mock.calls[0]?.[0] as {
      prepareWalletSendOperation: () => Promise<unknown>;
    };
    await expect(outgoingInput.prepareWalletSendOperation()).rejects.toBeInstanceOf(
      BrowserMarketFundingConsolidationRequiredError,
    );
  });

  it.each([
    { fee: 9_998_000, validKeyset: true, accepted: false },
    { fee: 9_997_000, validKeyset: true, accepted: true },
    { fee: 0, validKeyset: false, accepted: false },
  ])(
    "checks the exact eight-outcome funding preview: %j",
    async ({ fee, validKeyset, accepted }) => {
      const keysetId = `01${"11".repeat(32)}`;
      const operation = {
        preview: {
          amount: input.requestedAmount,
          keysetId,
          sendOutputs: [{ blindedMessage: { id: keysetId } }],
        },
      };
      const preview = vi
        .spyOn(deterministicSend, "prepareBrowserDeterministicOutgoingCashuSend")
        .mockResolvedValue(operation as never);
      try {
        captureBrowserMintPersistenceContext.mockReturnValue({
          ...context(),
          activeMintUrl: input.mintUrl,
        });
        getWalletForUnit.mockResolvedValue({
          getKeyset: () => ({
            id: keysetId,
            unit: "msat",
            fee,
            verify: () => validKeyset,
          }),
        });
        getBoundedCanonicalRegularProofs.mockResolvedValue([{ amount: input.requestedAmount }]);
        executeBrowserDurableOutgoingCashuTransfer.mockResolvedValue(transfer());
        getDurableCashuDeliveryStatus.mockResolvedValue(status("received"));
        await executeBrowserMarketFundingDelivery({
          ...common,
          outcomeCount: 8,
          attempt: begin(),
        });
        const outgoing = executeBrowserDurableOutgoingCashuTransfer.mock.calls[0]![0];
        const preparation = outgoing.prepareWalletSendOperation();
        if (accepted) await expect(preparation).resolves.toBe(operation);
        else
          await expect(preparation).rejects.toThrow(
            validKeyset ? /too small/ : /keyset is invalid/,
          );
      } finally {
        preview.mockRestore();
      }
    },
  );

  it("preserves a final preparation error without relabeling it", async () => {
    const preparationError = new Error("counter reservation failed");
    const wallet = {
      getKeyset: () => ({ id: `01${"11".repeat(32)}` }),
      prepareSwapToSend: vi.fn().mockRejectedValue(preparationError),
    };
    captureBrowserMintPersistenceContext.mockReturnValue({
      activeMintUrl: input.mintUrl,
      seed: new Uint8Array(64),
      requireCapturedProfile: vi.fn(),
    });
    getWalletForUnit.mockResolvedValue(wallet);
    executeBrowserDurableOutgoingCashuTransfer.mockResolvedValue(transfer());
    getDurableCashuDeliveryStatus.mockResolvedValue(status("received"));
    getBoundedCanonicalRegularProofs.mockResolvedValue([{ amount: input.requestedAmount }]);

    await executeBrowserMarketFundingDelivery({ ...common, attempt: begin() });
    const outgoingInput = executeBrowserDurableOutgoingCashuTransfer.mock.calls[0]?.[0] as {
      prepareWalletSendOperation: () => Promise<unknown>;
    };
    await expect(outgoingInput.prepareWalletSendOperation()).rejects.toBe(preparationError);
  });
});

function transfer(overrides: Partial<typeof input> & { transferId?: string } = {}) {
  const persisted = { ...input, ...overrides };
  const metadata = createMarketFundingDeliveryMetadata(persisted);
  return {
    transferId: overrides.transferId ?? persisted.deliveryId,
    mintUrl: persisted.mintUrl,
    unit: persisted.unit,
    requestedAmount: persisted.requestedAmount,
    deliveryIntent: {
      policy: "durable-recipient-ack",
      expectedSubject: persisted.accountSubject,
      opaqueProductBinding: metadata.productBindingSha256,
      tokenBytesLimit: 61_440,
      tokenProofLimit: 512,
    },
    recipientSequence: { predecessorTransferId: null },
    token: {
      encodedToken: TOKEN,
      sha256: TOKEN_SHA256,
      encodedLength: TOKEN.length,
    },
  } as never;
}

function status(
  state: "pending" | "received" | "credited",
  productBindingSha256?: string,
  statusInput = input,
) {
  const metadata = createMarketFundingDeliveryMetadata({
    ...statusInput,
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
            creditedAmount: statusInput.requestedAmount,
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
