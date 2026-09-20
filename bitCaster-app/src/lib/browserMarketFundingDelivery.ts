import {
  assertDurableRecipientDeliveryStatusAuthority,
  deriveDurableRecipientDeliveryResultFingerprint,
  reconcileDurableRecipientDelivery,
  type DurableRecipientDeliverySubmission,
  type DurableRecipientDeliveryStatus,
} from "@bitcaster/client-sdk/durableRecipientDelivery";
import {
  createMarketFundingDeliverySubmission,
  createMarketFundingDeliveryMetadata,
  deriveMarketFundingProductBinding,
  marketFundingDeliveryIntent,
  requireMarketFundingActivationAmount,
  type MarketFundingDeliveryInput,
} from "@bitcaster/client-sdk/marketFundingDelivery";
import { deriveDurableRecipientTokenAllowance } from "@bitcaster/client-sdk/durableRecipientDelivery";
import {
  createEncryptedWalletBackupV2AssetIdentity,
  type EncryptedWalletBackupV2AssetIdentity,
} from "@bitcaster/client-sdk";
import type { DurableWalletProofDerivationLocator } from "@bitcaster/client-sdk/durableWalletProofDerivationLocator";
import {
  amountToNumber,
  computeInputFeeSubunitsFromPpk,
} from "@bitcaster/client-sdk/proofSelection";
import type { DurableOutgoingCashuTransfer } from "@bitcaster/client-sdk/durableOutgoingCashuTransfer";
import {
  acknowledgeBrowserDurableOutgoingCashuRecipient,
  executeBrowserDurableOutgoingCashuTransfer,
  readBrowserDurableOutgoingCashuTransfer,
  recoverBrowserDurableOutgoingCashuTransfer,
  type BrowserDurableOutgoingCashuContext,
} from "@/lib/browserDurableOutgoingCashuTransfer";
import {
  prepareBrowserDeterministicOutgoingCashuSend,
  restoreBrowserDeterministicOutgoingCashuOutputs,
} from "@/lib/browserDeterministicOutgoingCashu";
import { captureBrowserMintPersistenceContext, getWalletForUnit } from "@/lib/cashu";
import { recoverBrowserFundedAsset } from "@/lib/browserFundedAssetRecovery";
import {
  getBoundedCanonicalRegularProofs,
  decodeBrowserOutgoingCashuTransferRow,
  findBrowserOutgoingCashuTransferByPredecessor,
  readBrowserMarketFundingHead,
  type StoredProof,
} from "@/stores/proof-db";
import { getDurableCashuDeliveryStatus, submitDurableCashuDelivery } from "@/lib/markets";

export type MarketFundingDeliveryProgress = "pending" | "received" | "credited";

export interface BrowserMarketFundingDeliveryResult {
  readonly transfer: DurableOutgoingCashuTransfer;
  readonly progress: MarketFundingDeliveryProgress;
}

export type BrowserMarketFundingDeliveryAttempt =
  | {
      readonly kind: "begin";
      readonly expectedPreviousTransferId: string | null;
      readonly newAttemptId: string;
      readonly requestedAmount: string;
    }
  | {
      readonly kind: "resume";
      readonly transferId: string;
    };

export type BrowserMarketFundingDeliveryInput =
  Omit<MarketFundingDeliveryInput, "deliveryId" | "requestedAmount"> & {
    readonly outcomeCount?: number;
    /** Classifies only a final locked shortfall. It never bypasses recovery or selection. */
    readonly availableAmount?: number;
    readonly attempt: BrowserMarketFundingDeliveryAttempt;
  };

export class BrowserMarketFundingInsufficientBalanceError extends Error {
  constructor() {
    super("browser market funding balance is insufficient");
    this.name = "BrowserMarketFundingInsufficientBalanceError";
  }
}

export class BrowserMarketFundingConsolidationRequiredError extends Error {
  constructor() {
    super("browser market funding proofs require consolidation");
    this.name = "BrowserMarketFundingConsolidationRequiredError";
  }
}

/** Read the exact persisted funding head for the captured wallet and scope. */
export async function readBrowserMarketFundingHeadId(
  input: Omit<MarketFundingDeliveryInput, "deliveryId" | "requestedAmount">,
): Promise<string | null> {
  const context = captureBrowserMintPersistenceContext();
  context.requireCapturedProfile();
  if (input.mintUrl !== context.activeMintUrl) {
    throw new Error("market funding mint conflicts with the captured wallet");
  }
  const productBindingSha256 = deriveMarketFundingProductBinding({
    accountSubject: input.accountSubject,
    conditionId: input.conditionId,
    divisibility: input.divisibility,
  });
  const head = await readBrowserMarketFundingHead(
    context.scopeId,
    productBindingSha256,
    context.database,
  );
  context.requireCapturedProfile();
  if (head === null) return null;
  if (
    head.scopeId !== context.scopeId ||
    head.recipientBinding !== productBindingSha256 ||
    head.accountSubject !== input.accountSubject ||
    head.conditionId !== input.conditionId ||
    head.divisibility !== input.divisibility ||
    head.mintUrl !== input.mintUrl ||
    head.unit !== input.unit
  ) {
    throw new Error("market funding head scope conflicts with the captured wallet");
  }
  return head.transferId;
}

/** Prepare or resume one durable outgoing transfer, then submit its stored token. */
export async function executeBrowserMarketFundingDelivery(
  input: BrowserMarketFundingDeliveryInput,
): Promise<BrowserMarketFundingDeliveryResult> {
  const context = captureBrowserMintPersistenceContext();
  context.requireCapturedProfile();
  if (input.mintUrl !== context.activeMintUrl) {
    throw new Error("market funding mint conflicts with the captured wallet");
  }
  if (input.attempt.kind === "resume") {
    const persisted = await readBrowserDurableOutgoingCashuTransfer({
      transferId: input.attempt.transferId,
      context,
    });
    if (persisted === null) throw new Error("market funding transfer is not persisted");
    return reconcileOrRecoverPersistedMarketFunding({
      transfer: persisted,
      input,
      context,
    });
  }
  const begin = input.attempt;
  const beginInput = { ...input, attempt: begin };
  const indexedSuccessor = await findPersistedMarketFundingSuccessor({
    input: beginInput,
    context,
  });
  if (indexedSuccessor !== null && indexedSuccessor.token !== null) {
    return reconcileBrowserMarketFundingDelivery({
      transfer: indexedSuccessor,
      metadata: persistedMarketFundingMetadata(input, indexedSuccessor),
      readStatus: getDurableCashuDeliveryStatus,
      submit: submitDurableCashuDelivery,
      context,
    });
  }

  const metadata: MarketFundingDeliveryInput = {
    ...input,
    deliveryId: begin.newAttemptId,
    requestedAmount: begin.requestedAmount,
  };
  const durableMetadata = createMarketFundingDeliveryMetadata(metadata);
  const wallet = await getWalletForUnit(durableMetadata.mintUrl, durableMetadata.unit);
  context.requireCapturedProfile();
  const keepLocators: Array<DurableWalletProofDerivationLocator | null> = [];
  const asset = ordinaryFundingAsset(durableMetadata.mintUrl, durableMetadata.unit);
  const transfer = await executeBrowserDurableOutgoingCashuTransfer({
    marketFundingAttempt: {
      expectedPreviousTransferId: begin.expectedPreviousTransferId,
      conditionId: durableMetadata.destinationId,
      divisibility: input.divisibility,
      requireCredited: (predecessor) => requireCreditedMarketFundingPredecessor({
        transfer: predecessor,
        input,
      }),
    },
    transfer: {
      transferId: begin.newAttemptId,
      mintUrl: durableMetadata.mintUrl,
      unit: durableMetadata.unit,
      requestedAmount: durableMetadata.requestedAmount,
      recipientSequence: {
        predecessorTransferId: begin.expectedPreviousTransferId,
      },
      deliveryIntent: marketFundingDeliveryIntent({
        accountSubject: durableMetadata.accountSubject,
        productBindingSha256: durableMetadata.productBindingSha256,
        tokenBytesLimit: deriveDurableRecipientTokenAllowance(durableMetadata),
      }),
    },
    preflightFundedAsset: () =>
      preflightMarketFundingAsset({
        context,
        asset,
        requiredAmount: durableMetadata.requestedAmount,
        mintUrl: durableMetadata.mintUrl,
        unit: durableMetadata.unit,
      }),
    prepareWalletSendOperation: async () => {
      context.requireCapturedProfile();
      const proofs = await readMarketFundingCandidates({
        mintUrl: durableMetadata.mintUrl,
        unit: durableMetadata.unit,
        scopeId: context.scopeId,
      });
      context.requireCapturedProfile();
      if (sumProofs(proofs) < Number(durableMetadata.requestedAmount)) {
        if (
          input.availableAmount !== undefined &&
          input.availableAmount >= Number(begin.requestedAmount)
        ) {
          throw new BrowserMarketFundingConsolidationRequiredError();
        }
        throw new BrowserMarketFundingInsufficientBalanceError();
      }
      const operation = await prepareBrowserDeterministicOutgoingCashuSend({
        operationId: `market-funding:${begin.newAttemptId}`,
        wallet,
        proofs,
        amount: Number(begin.requestedAmount),
        mintUrl: durableMetadata.mintUrl,
        unit: durableMetadata.unit,
        seed: context.seed,
        keepProofDerivationLocators: keepLocators,
        diagnosticLabel: "Market funding",
      });
      const keyset = wallet.getKeyset(operation.preview.keysetId);
      if (
        keyset.id !== operation.preview.keysetId ||
        keyset.unit !== "msat" ||
        keyset.conditional ||
        !keyset.verify() ||
        operation.preview.sendOutputs.some((output) => output.blindedMessage.id !== keyset.id)
      ) {
        throw new Error("Market funding receive-fee keyset is invalid");
      }
      requireMarketFundingActivationAmount({
        grossMsat: Number(operation.preview.amount),
        receiveFeeMsat: computeInputFeeSubunitsFromPpk(
          operation.preview.sendOutputs.length * keyset.fee,
        ),
        outcomeCount: input.outcomeCount ?? 8,
      });
      return operation;
    },
    keepProofDerivationLocators: keepLocators,
    wallet,
    restoreExactOutputs: (restore) =>
      restoreBrowserDeterministicOutgoingCashuOutputs({
        wallet,
        restore,
        diagnosticLabel: "Market funding",
      }),
    context,
  });
  return reconcileBrowserMarketFundingDelivery({
    transfer,
    metadata: persistedMarketFundingMetadata(input, transfer),
    readStatus: getDurableCashuDeliveryStatus,
    submit: submitDurableCashuDelivery,
    context,
  });
}

async function findPersistedMarketFundingSuccessor(input: {
  readonly input: BrowserMarketFundingDeliveryInput & {
    readonly attempt: Extract<BrowserMarketFundingDeliveryAttempt, { kind: "begin" }>;
  };
  readonly context: ReturnType<typeof captureBrowserMintPersistenceContext>;
}): Promise<DurableOutgoingCashuTransfer | null> {
  const productBindingSha256 = deriveMarketFundingProductBinding({
    accountSubject: input.input.accountSubject,
    conditionId: input.input.conditionId,
    divisibility: input.input.divisibility,
  });
  const row = await findBrowserOutgoingCashuTransferByPredecessor({
    scopeId: input.context.scopeId,
    recipientBinding: productBindingSha256,
    predecessorTransferId: input.input.attempt.expectedPreviousTransferId,
    database: input.context.database,
  });
  input.context.requireCapturedProfile();
  if (row === null) return null;
  const transfer = decodeBrowserOutgoingCashuTransferRow(input.context.scopeId, row);
  if (
    transfer.deliveryIntent.policy !== "durable-recipient-ack" ||
    transfer.recipientSequence === null ||
    transfer.recipientSequence.predecessorTransferId !==
      input.input.attempt.expectedPreviousTransferId
  ) {
    throw new Error("market funding successor sequence conflicts");
  }
  marketFundingMetadata(transfer, persistedMarketFundingMetadata(input.input, transfer));
  return transfer;
}

async function reconcileOrRecoverPersistedMarketFunding(input: {
  readonly transfer: DurableOutgoingCashuTransfer;
  readonly input: BrowserMarketFundingDeliveryInput;
  readonly context: BrowserDurableOutgoingCashuContext;
}): Promise<BrowserMarketFundingDeliveryResult> {
  const metadata = persistedMarketFundingMetadata(input.input, input.transfer);
  marketFundingMetadata(input.transfer, metadata);
  if (input.transfer.token !== null) {
    return reconcileBrowserMarketFundingDelivery({
      transfer: input.transfer,
      metadata,
      readStatus: getDurableCashuDeliveryStatus,
      submit: submitDurableCashuDelivery,
      context: input.context,
    });
  }
  const wallet = await getWalletForUnit(input.transfer.mintUrl, input.transfer.unit);
  const recovered = await recoverBrowserDurableOutgoingCashuTransfer({
    transferId: input.transfer.transferId,
    wallet,
    restoreExactOutputs: (restore) =>
      restoreBrowserDeterministicOutgoingCashuOutputs({
        wallet,
        restore,
        diagnosticLabel: "Market funding",
      }),
    context: input.context,
  });
  if (recovered === null) throw new Error("market funding transfer disappeared during recovery");
  return reconcileBrowserMarketFundingDelivery({
    transfer: recovered,
    metadata: persistedMarketFundingMetadata(input.input, recovered),
    readStatus: getDurableCashuDeliveryStatus,
    submit: submitDurableCashuDelivery,
    context: input.context,
  });
}

async function requireCreditedMarketFundingPredecessor(input: {
  readonly transfer: DurableOutgoingCashuTransfer;
  readonly input: BrowserMarketFundingDeliveryInput;
}): Promise<void> {
  if (input.transfer.token === null) {
    throw new Error("market funding predecessor has no stored token");
  }
  const metadata = persistedMarketFundingMetadata(input.input, input.transfer);
  const submission = createMarketFundingDeliverySubmission({
    metadata: marketFundingMetadata(input.transfer, metadata),
    token: input.transfer.token.encodedToken,
  });
  const status = await getDurableCashuDeliveryStatus(input.transfer.transferId);
  if (status === null) throw new Error("market funding predecessor status is unavailable");
  assertDurableRecipientDeliveryStatusAuthority({ expected: submission, status });
  if (status.state !== "credited") {
    throw new Error("market funding predecessor is not credited");
  }
}

function ordinaryFundingAsset(
  mintUrl: string,
  unit: "sat" | "msat",
): EncryptedWalletBackupV2AssetIdentity {
  return createEncryptedWalletBackupV2AssetIdentity({ mintUrl, unit, asset: { kind: "ordinary" } });
}

async function preflightMarketFundingAsset(input: {
  readonly context: ReturnType<typeof captureBrowserMintPersistenceContext>;
  readonly asset: EncryptedWalletBackupV2AssetIdentity;
  readonly requiredAmount: string;
  readonly mintUrl: string;
  readonly unit: "sat" | "msat";
}): Promise<void> {
  const recovery = await recoverBrowserFundedAsset({
    database: input.context.database,
    scopeId: input.context.scopeId,
    seed: input.context.seed,
    mnemonic: input.context.mnemonic,
    asset: input.asset,
    requiredAmount: BigInt(input.requiredAmount),
    loadPlan: async () =>
      sumProofs(await readMarketFundingCandidates({ ...input, scopeId: input.context.scopeId })) >=
      Number(input.requiredAmount)
        ? { kind: "ready" as const }
        : { kind: "insufficient" as const },
    isCurrentProfile: () => {
      input.context.requireCapturedProfile();
      return true;
    },
  });
  switch (recovery.kind) {
    case "ready":
    case "recovered":
      return;
    case "unavailable":
      throw new BrowserMarketFundingInsufficientBalanceError();
    case "persistent-error":
      throw new Error("Market funding asset recovery is unavailable");
    case "not-recoverable":
      throw new BrowserMarketFundingConsolidationRequiredError();
    default:
      throw new Error("market funding recovery outcome is invalid");
  }
}

async function readMarketFundingCandidates(input: {
  readonly mintUrl: string;
  readonly unit: "sat" | "msat";
  readonly scopeId: string;
}): Promise<StoredProof[]> {
  return getBoundedCanonicalRegularProofs(input.mintUrl, {
    unit: input.unit,
    scopeId: input.scopeId,
  });
}

function sumProofs(proofs: readonly StoredProof[]): number {
  return proofs.reduce((sum, proof) => sum + amountToNumber(proof.amount), 0);
}

function persistedMarketFundingMetadata(
  input: Omit<MarketFundingDeliveryInput, "deliveryId" | "requestedAmount">,
  transfer: DurableOutgoingCashuTransfer,
): MarketFundingDeliveryInput {
  return {
    ...input,
    deliveryId: transfer.transferId,
    requestedAmount: transfer.requestedAmount,
  };
}

/**
 * Reconcile one persisted delivery before a retry POST. This function does
 * not select proofs or mint a token. It submits only the stored token.
 */
export async function reconcileBrowserMarketFundingDelivery(input: {
  readonly transfer: DurableOutgoingCashuTransfer;
  readonly metadata: MarketFundingDeliveryInput;
  readonly readStatus: (deliveryId: string) => Promise<DurableRecipientDeliveryStatus | null>;
  readonly submit: (
    submission: DurableRecipientDeliverySubmission,
  ) => Promise<DurableRecipientDeliveryStatus>;
  readonly context: BrowserDurableOutgoingCashuContext;
}): Promise<BrowserMarketFundingDeliveryResult> {
  if (input.transfer.token === null) {
    throw new Error("market funding transfer has no stored token");
  }
  const submission = createMarketFundingDeliverySubmission({
    metadata: marketFundingMetadata(input.transfer, input.metadata),
    token: input.transfer.token.encodedToken,
  });

  const status = await reconcileDurableRecipientDelivery({
    client: {
      getDurableRecipientDeliveryStatus: input.readStatus,
      submitDurableRecipientDelivery: input.submit,
    },
    submission,
  });
  if (status === null) return { transfer: input.transfer, progress: "pending" };
  return persistRecipientStatus(input, submission, status);
}

async function persistRecipientStatus(
  input: Parameters<typeof reconcileBrowserMarketFundingDelivery>[0],
  submission: DurableRecipientDeliverySubmission,
  status: DurableRecipientDeliveryStatus,
): Promise<BrowserMarketFundingDeliveryResult> {
  assertDurableRecipientDeliveryStatusAuthority({ expected: submission, status });
  if (status.state === "pending") return { transfer: input.transfer, progress: "pending" };
  if (
    input.transfer.deliveryIntent.policy !== "durable-recipient-ack" ||
    input.transfer.token === null
  ) {
    throw new Error("market funding transfer is missing recipient delivery authority");
  }

  const result = status.result;
  const transfer = await acknowledgeBrowserDurableOutgoingCashuRecipient({
    transfer: input.transfer,
    receipt: {
      transferId: input.transfer.transferId,
      expectedSubject: input.transfer.deliveryIntent.expectedSubject,
      opaqueProductBinding: input.transfer.deliveryIntent.opaqueProductBinding,
      mintUrl: input.transfer.mintUrl,
      unit: input.transfer.unit,
      requestedAmount: input.transfer.requestedAmount,
      tokenSha256: input.transfer.token.sha256,
      tokenLength: input.transfer.token.encodedLength,
      receiveOperationId: result.receiveOperationId,
      durableResultFingerprint: deriveDurableRecipientDeliveryResultFingerprint(status),
    },
    context: input.context,
  });
  return { transfer, progress: status.state };
}

function marketFundingMetadata(
  transfer: DurableOutgoingCashuTransfer,
  metadata: MarketFundingDeliveryInput,
) {
  if (transfer.deliveryIntent.policy !== "durable-recipient-ack") {
    throw new Error("market funding transfer is missing recipient delivery authority");
  }
  if (metadata.deliveryId !== transfer.transferId) {
    throw new Error("market funding delivery id conflicts with the stored transfer");
  }
  if (
    metadata.accountSubject !== transfer.deliveryIntent.expectedSubject ||
    metadata.mintUrl !== transfer.mintUrl ||
    metadata.unit !== transfer.unit ||
    metadata.requestedAmount !== transfer.requestedAmount
  ) {
    throw new Error("market funding delivery metadata conflicts with the stored transfer");
  }
  const durableMetadata = createMarketFundingDeliveryMetadata(metadata);
  if (durableMetadata.productBindingSha256 !== transfer.deliveryIntent.opaqueProductBinding) {
    throw new Error("market funding product binding conflicts with the stored transfer");
  }
  return durableMetadata;
}
